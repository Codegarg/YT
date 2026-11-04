/**
 * Read-only PROJECT HEALTH / RELEASE READINESS report (STEP-8GX).
 *
 * Composes EXISTING authoritative layers — it does NOT reimplement any validation:
 *   · prodCheck.readPipeline          → pipeline parse/validate
 *   · inputValidator.validateProjectInputs + deriveRequiredInputs → INPUTS
 *   · productionOrchestrator.inspectProject (readOnly) → SCENES + DOWNSTREAM
 *   · checkInputs                      → per-scene Flow/local media state
 *   · approval.evaluateApproval        → integrity-bound approval verdict
 *   · approvalReview.reconcileApprovalReview → review reconciliation + publishability
 *
 * STRICTLY READ-ONLY: never creates directories, never writes state/sidecars/approval/review,
 * never acquires locks, never invokes Flow/FFmpeg/the publisher, never mutates the pipeline.
 */
import path from 'node:path';
import { readPipeline } from './prodCheck.js';
import { validateProjectInputs, deriveRequiredInputs } from './inputValidator.js';
import { checkInputs } from './checkInputs.js';
import { evaluateApproval } from './approval.js';
import { reconcileApprovalReview, type Reconciliation } from './approvalReview.js';
import { computeFileSha256 } from './inputManifest.js';
import { safeStageOutputPath, sha256OfFileOrNull } from './downstreamStages.js';

export type NextActionKind =
  | 'FIX_PIPELINE'
  | 'SUPPLY_BACKGROUNDS'
  | 'SUPPLY_CHARACTERS'
  | 'SUPPLY_NARRATION'
  | 'SUPPLY_LOCAL_BGM'
  | 'SUPPLY_BRANDING'
  | 'FLOW_SCENE_GENERATION'
  | 'LOCAL_SCENE_RECONCILIATION'
  | 'RUN_PRODUCTION'
  | 'REPAIR_STAGE_OUTPUT'
  | 'EXPLICIT_APPROVAL'
  | 'EXTERNAL_PUBLISHER'
  | 'READY_FOR_EXTERNAL_PUBLISH'
  | 'ALREADY_POSTED';

export type NextActionClass = 'LOCAL_ONLY' | 'FLOW_REQUIRED' | 'HUMAN_REQUIRED' | 'EXTERNAL_PUBLISHER_REQUIRED';

export interface NextAction {
  action: NextActionKind;
  class: NextActionClass;
  credit_consuming: boolean;
  human_required: boolean;
  external_publisher_required: boolean;
  detail: string;
}

export interface ProjectHealthReport {
  projectId: string;
  pipelinePath: string;
  pipelineSha: string;
  projectState: string;
  workflowPhase: string;
  inputs: {
    backgrounds: { valid: number; total: number };
    characters: { valid: number; total: number };
    narration: { valid: number; total: number };
    flowClips: { valid: number; total: number };
    music: { valid: number; total: number };
    branding: { valid: number; total: number };
    issues: Array<{ category: string; id: string; state: string; reason: string }>;
  };
  scenes: {
    total: number;
    ready: number;
    waitingForCharacterAsset: number;
    waitingForNarration: number;
    waitingForBackground: number;
    waitingForVideoClip: number;
    invalid: number;
    outputCurrent: number;
    outputStale: number;
    outputMissing: number;
    outputInvalid: number;
  };
  flow: {
    needsGeneration: number[];
    needsDownload: number[];
    committedLocalAvailable: number[];
    committedLocalMissing: number[];
    notCommitted: number[];
    localMedia: number[];
    sessionRequiredForNextAction: boolean;
    nextActionConsumesCredits: boolean;
  };
  downstream: {
    states: { EDIT: string; MIX: string; BED: string; TITLE: string; APPROVAL: string };
    staleOrBlockedDependency: string | null;
  };
  approval: {
    integrity: string;
    approvalStatus: string | null;
    approvedFinalOutputHash: string | null;
    currentTitleHash: string | null;
    hashMatch: boolean;
    stageKeyMatch: boolean;
    review: string;
    reconciliationMismatch: boolean;
    /** Where the TITLE stage-key inputs came from (STEP-8GY): recorded sidecar > config > standard. */
    titleInputProvenance: TitleInputProvenance;
  };
  release: {
    publishable: boolean;
    releaseState: 'BLOCKED_INPUTS' | 'BLOCKED_PRODUCTION' | 'BLOCKED_APPROVAL' | 'BLOCKED_EXTERNAL_PUBLISHER' | 'PUBLISHABLE' | 'POSTED';
    blockingReasons: string[];
    nextAction: NextAction;
  };
  generatedAt: string;
}

export type TitleInputProvenance = 'RECORDED_STAGE_METADATA' | 'WORKFLOW_CONFIGURATION' | 'STANDARD_FALLBACK' | 'UNRESOLVED';

export interface HealthOptions {
  /** Explicit stage-key inputs already known for the project (WORKFLOW_CONFIGURATION). */
  stageInputs?: { bgmHash?: string | null; introHash?: string | null; logoHash?: string | null; titleMetadata?: unknown };
  /** Absolute pipeline.json path. */
  projectFile: string;
  /** Absolute inputs root. */
  inputsRoot: string;
  /** Absolute outputs root. */
  outputsRoot: string;
  ffprobePath?: string;
  /** Test seams. */
  inspectProject?: (args: any) => Promise<any>;
}

function stageStatesFrom(report: any): { EDIT: string; MIX: string; BED: string; TITLE: string; APPROVAL: string } {
  const s = report?.downstream?.states ?? {};
  return { EDIT: String(s.EDIT ?? 'NOT_STARTED'), MIX: String(s.MIX ?? 'NOT_STARTED'), BED: String(s.BED ?? 'NOT_STARTED'), TITLE: String(s.TITLE ?? 'NOT_STARTED'), APPROVAL: String(s.APPROVAL ?? 'NOT_STARTED') };
}

/** Pure next-action derivation from existing statuses (no new state machine). */
export function deriveNextAction(input: {
  pipelineValid: boolean;
  anyInvalidInput: boolean;
  waitingBackground: number; waitingCharacter: number; waitingNarration: number;
  musicMissing: boolean; brandingMissing: boolean;
  needsGeneration: number[]; needsDownloadOrRecovery: number[];
  readyNotCurrent: number;
  downstream: { EDIT: string; MIX: string; BED: string; TITLE: string; APPROVAL: string };
  approvalIntegrity: string;
  review: string;
  publishable: boolean;
  titleCurrent: boolean;
}): NextAction {
  const none = { credit_consuming: false, human_required: false, external_publisher_required: false };

  if (!input.pipelineValid) return { action: 'FIX_PIPELINE', class: 'LOCAL_ONLY', ...none, detail: 'pipeline.json is invalid' };
  if (input.anyInvalidInput) return { action: 'RUN_PRODUCTION', class: 'LOCAL_ONLY', ...none, detail: 'one or more required inputs are invalid' };
  if (input.needsGeneration.length > 0) return { action: 'FLOW_SCENE_GENERATION', class: 'FLOW_REQUIRED', credit_consuming: true, human_required: false, external_publisher_required: false, detail: `scene(s) ${input.needsGeneration.join(', ')} require Flow generation` };
  if (input.needsDownloadOrRecovery.length > 0) return { action: 'LOCAL_SCENE_RECONCILIATION', class: 'LOCAL_ONLY', ...none, detail: `scene(s) ${input.needsDownloadOrRecovery.join(', ')} need local media reconciliation` };
  if (input.waitingBackground > 0) return { action: 'SUPPLY_BACKGROUNDS', class: 'LOCAL_ONLY', ...none, detail: `${input.waitingBackground} scene(s) need background assets` };
  if (input.waitingCharacter > 0) return { action: 'SUPPLY_CHARACTERS', class: 'LOCAL_ONLY', ...none, detail: `${input.waitingCharacter} scene(s) need character assets` };
  if (input.waitingNarration > 0) return { action: 'SUPPLY_NARRATION', class: 'LOCAL_ONLY', ...none, detail: `${input.waitingNarration} scene(s) need narration` };
  if (input.musicMissing) return { action: 'SUPPLY_LOCAL_BGM', class: 'LOCAL_ONLY', ...none, detail: 'required BGM (+license) missing' };
  if (input.brandingMissing) return { action: 'SUPPLY_BRANDING', class: 'LOCAL_ONLY', ...none, detail: 'required branding (intro/logo) missing' };
  if (input.readyNotCurrent > 0) return { action: 'RUN_PRODUCTION', class: 'LOCAL_ONLY', ...none, detail: `${input.readyNotCurrent} ready scene(s) need local rendering` };

  const ds = input.downstream;
  if (input.approvalIntegrity === 'APPROVAL_STALE') return { action: 'REPAIR_STAGE_OUTPUT', class: 'LOCAL_ONLY', ...none, detail: 'TITLE/approval is stale; repair the final artifact and re-approve' };
  if (input.review === 'REVIEW_POSTED') return { action: 'ALREADY_POSTED', class: 'EXTERNAL_PUBLISHER_REQUIRED', credit_consuming: false, human_required: false, external_publisher_required: true, detail: 'artifact was already posted' };
  // A VALID integrity approval means approval is satisfied regardless of the derived APPROVAL
  // stage flag (which is only CURRENT when `approved` is passed to the planner).
  if (input.approvalIntegrity === 'APPROVAL_VALID') {
    if (input.publishable) return { action: 'READY_FOR_EXTERNAL_PUBLISH', class: 'EXTERNAL_PUBLISHER_REQUIRED', credit_consuming: false, human_required: false, external_publisher_required: true, detail: 'publishable; external publisher must be invoked explicitly by a human' };
    return { action: 'EXTERNAL_PUBLISHER', class: 'EXTERNAL_PUBLISHER_REQUIRED', credit_consuming: false, human_required: false, external_publisher_required: true, detail: 'approval valid; an external publisher is still required (never invoked automatically)' };
  }
  if (ds.APPROVAL !== 'CURRENT' || input.approvalIntegrity !== 'APPROVAL_VALID') {
    if (ds.TITLE === 'CURRENT' || input.titleCurrent) return { action: 'EXPLICIT_APPROVAL', class: 'HUMAN_REQUIRED', credit_consuming: false, human_required: true, external_publisher_required: false, detail: 'TITLE is current; explicit human approval is required' };
    return { action: 'RUN_PRODUCTION', class: 'LOCAL_ONLY', ...none, detail: `run downstream stages (EDIT=${ds.EDIT}, MIX=${ds.MIX}, BED=${ds.BED}, TITLE=${ds.TITLE})` };
  }
  if (ds.TITLE !== 'CURRENT') return { action: 'RUN_PRODUCTION', class: 'LOCAL_ONLY', ...none, detail: `TITLE is ${ds.TITLE}; run downstream stages` };
  return { action: 'EXPLICIT_APPROVAL', class: 'HUMAN_REQUIRED', credit_consuming: false, human_required: true, external_publisher_required: false, detail: 'explicit approval required' };
}

/**
 * Build the read-only health report. Never writes, never locks, never calls Flow/FFmpeg.
 */
export async function getProjectHealth(opts: HealthOptions): Promise<ProjectHealthReport> {
  const read = await readPipeline(opts.projectFile);

  const pipelineSha = await computeFileSha256(opts.projectFile).catch(() => '');

  if (!read.ok) {
    return {
      projectId: '', pipelinePath: opts.projectFile, pipelineSha, projectState: 'UNKNOWN', workflowPhase: 'FAILED',
      inputs: { backgrounds: { valid: 0, total: 0 }, characters: { valid: 0, total: 0 }, narration: { valid: 0, total: 0 }, flowClips: { valid: 0, total: 0 }, music: { valid: 0, total: 0 }, branding: { valid: 0, total: 0 }, issues: [] },
      scenes: { total: 0, ready: 0, waitingForCharacterAsset: 0, waitingForNarration: 0, waitingForBackground: 0, waitingForVideoClip: 0, invalid: 0, outputCurrent: 0, outputStale: 0, outputMissing: 0, outputInvalid: 0 },
      flow: { needsGeneration: [], needsDownload: [], committedLocalAvailable: [], committedLocalMissing: [], notCommitted: [], localMedia: [], sessionRequiredForNextAction: false, nextActionConsumesCredits: false },
      downstream: { states: { EDIT: 'NOT_STARTED', MIX: 'NOT_STARTED', BED: 'NOT_STARTED', TITLE: 'NOT_STARTED', APPROVAL: 'NOT_STARTED' }, staleOrBlockedDependency: read.error },
      approval: { integrity: 'APPROVAL_MISSING', approvalStatus: null, approvedFinalOutputHash: null, currentTitleHash: null, hashMatch: false, stageKeyMatch: false, review: 'REVIEW_MISSING', reconciliationMismatch: false, titleInputProvenance: 'UNRESOLVED' },
      release: { publishable: false, releaseState: 'BLOCKED_PRODUCTION', blockingReasons: [read.error], nextAction: { action: 'FIX_PIPELINE', class: 'LOCAL_ONLY', credit_consuming: false, human_required: false, external_publisher_required: false, detail: read.error } },
      generatedAt: new Date().toISOString(),
    };
  }

  const pipeline = read.pipeline;
  const projectId = String(pipeline.project_id);
  const inputRoot = path.join(opts.inputsRoot, projectId);
  const outputsDir = path.join(opts.outputsRoot, projectId);

  const req = deriveRequiredInputs(pipeline);
  const inputReport = await validateProjectInputs({
    projectId, inputRoot,
    requiredBackgrounds: req.backgrounds, requiredCharacters: req.characters,
    narrationScenes: req.narrationScenes, sceneNumbers: req.sceneNumbers, requiredClips: req.requiredClips,
    ffprobePath: opts.ffprobePath,
  });

  // Read-only scene + downstream derivation (no writes, no stage execution).
  // STEP-8GY: resolve the EFFECTIVE stage-key inputs by precedence so a legitimately produced
  // TITLE never becomes falsely stale: recorded sidecar key_inputs > explicit config > standard
  // locations > UNRESOLVED. Provenance is reported; nothing is fabricated.
  const { applyRecordedKeyInputs } = await import('./downstreamStages.js');
  const titleSidecar = await (async () => {
    try { return JSON.parse(await (await import('node:fs/promises')).readFile(`${path.join(outputsDir, 'final-title.mp4')}.stage`, 'utf8')); }
    catch { return null; }
  })();
  let titleInputProvenance: TitleInputProvenance = 'UNRESOLVED';
  const standardStageInputs = await (async () => {
    const { sha256OfFileOrNull } = await import('./downstreamStages.js');
    const fsp = await import('node:fs/promises');
    const bgm = path.join(inputRoot, 'music', 'background-music.mp3');
    const intro = path.join(inputRoot, 'branding', 'channel-intro.mp4');
    const logo = path.join(inputRoot, 'branding', 'channel-logo.png');
    const exists = async (p: string) => fsp.stat(p).then((s) => s.isFile()).catch(() => false);
    return {
      bgmHash: (await exists(bgm)) ? await sha256OfFileOrNull(bgm) : null,
      introHash: (await exists(intro)) ? await sha256OfFileOrNull(intro) : null,
      logoHash: (await exists(logo)) ? await sha256OfFileOrNull(logo) : null,
      titleMetadata: { title: pipeline?.flow_project_name ?? null },
    };
  })();
  let stageInputs: any;
  if (titleSidecar && titleSidecar.key_inputs && typeof titleSidecar.key_inputs === 'object') {
    stageInputs = applyRecordedKeyInputs({ sceneOutputHashes: {}, narration: {}, ...standardStageInputs }, titleSidecar.key_inputs);
    titleInputProvenance = 'RECORDED_STAGE_METADATA';
  } else if (opts.stageInputs) {
    stageInputs = { ...standardStageInputs, ...opts.stageInputs };
    titleInputProvenance = 'WORKFLOW_CONFIGURATION';
  } else {
    stageInputs = standardStageInputs;
    titleInputProvenance = (standardStageInputs.introHash || standardStageInputs.logoHash || standardStageInputs.bgmHash) ? 'STANDARD_FALLBACK' : 'UNRESOLVED';
  }
  const inspect = opts.inspectProject ?? (async (args: any) => (await import('./productionOrchestrator.js')).inspectProject(args));
  const report = await inspect({ pipeline, projectId, inputRoot, outputsDir, outputsRoot: opts.outputsRoot, ffprobePath: opts.ffprobePath, stageInputs, readOnly: true });

  const diag = await checkInputs({ pipeline, inputsRoot: opts.inputsRoot, projectId, outputsDir, ffprobePath: opts.ffprobePath } as any);

  // Scene aggregates.
  const counts = report?.counts ?? {};
  const sceneOutputs = (report?.scenes ?? []).reduce((acc: any, s: any) => { acc[s.outputState] = (acc[s.outputState] ?? 0) + 1; return acc; }, {});
  const scenes = {
    total: Number(report?.sceneCount ?? (pipeline.scenes?.length ?? 0)),
    ready: Number(counts.ready ?? 0),
    waitingForCharacterAsset: Number(counts.waitingCharacter ?? 0),
    waitingForNarration: Number(counts.waitingNarration ?? 0),
    waitingForBackground: Number(counts.waitingBackground ?? 0),
    waitingForVideoClip: Number(counts.waitingVideo ?? 0),
    invalid: Number(counts.invalid ?? 0),
    outputCurrent: Number(sceneOutputs.CURRENT ?? 0),
    outputStale: Number(sceneOutputs.STALE ?? 0) + Number(sceneOutputs.STALE_UNKNOWN ?? 0),
    outputMissing: Number(sceneOutputs.MISSING_OUTPUT ?? 0),
    outputInvalid: Number(sceneOutputs.INVALID_OUTPUT ?? 0),
  };

  // Flow/local media aggregates (reuse checkInputs' explicit flow-local decision).
  const flow = { needsGeneration: [] as number[], needsDownload: [] as number[], committedLocalAvailable: diag.flowCommittedLocalAvailable.slice(), committedLocalMissing: diag.flowCommittedLocalMissing.slice(), notCommitted: [] as number[], localMedia: diag.localAvailableFlowUnknown.slice() };
  for (const s of diag.scenes as any[]) {
    const st = s.flowLocal?.state;
    if (st === 'FLOW_COMMITTED_LOCAL_AVAILABLE') flow.committedLocalAvailable.push(s.sceneNumber);
    else if (st === 'FLOW_COMMITTED_LOCAL_MISSING') flow.committedLocalMissing.push(s.sceneNumber);
    else if (st === 'LOCAL_AVAILABLE_FLOW_UNKNOWN') flow.localMedia.push(s.sceneNumber);
    else if (st === 'FLOW_UNKNOWN' || s.suppliedClip?.state === 'INVALID') flow.needsDownload.push(s.sceneNumber);
    else if (st === 'FLOW_NOT_COMMITTED' && s.readiness === 'WAITING_FOR_VIDEO_CLIP') flow.needsGeneration.push(s.sceneNumber);
    else if (st === 'FLOW_NOT_COMMITTED') flow.notCommitted.push(s.sceneNumber);
  }
  const uniq = (a: number[]) => [...new Set(a)].sort((x, y) => x - y);
  flow.needsGeneration = uniq(flow.needsGeneration);
  flow.needsDownload = uniq(flow.needsDownload);
  flow.committedLocalAvailable = uniq(flow.committedLocalAvailable);
  flow.committedLocalMissing = uniq(flow.committedLocalMissing);
  flow.notCommitted = uniq(flow.notCommitted);
  flow.localMedia = uniq(flow.localMedia);

  // Approval + review reconciliation.
  const approvalVerdict = await evaluateApproval({ projectId, outputsRoot: opts.outputsRoot, outputsDir, inputRoot, pipeline, ffprobePath: opts.ffprobePath, stageInputs });
  const reconciliation: Reconciliation = await reconcileApprovalReview({ projectId, outputsRoot: opts.outputsRoot, outputsDir, inputRoot, pipeline, projectFile: opts.projectFile, ffprobePath: opts.ffprobePath, stageInputs });

  const titleCurrent = stageStatesFrom(report).TITLE === 'CURRENT';
  const currentTitleHash = approvalVerdict.status === 'APPROVED' ? approvalVerdict.finalOutputHash : (await sha256OfFileOrNull(safeStageOutputPath(outputsDir, 'TITLE')).catch(() => null));
  const approvalStatus = approvalVerdict.status === 'APPROVED' ? approvalVerdict.record.status : (approvalVerdict.status === 'STALE_APPROVAL' ? 'stale' : null);
  const approvedHash = approvalVerdict.status === 'APPROVED' ? approvalVerdict.record.approved_final_output_hash : (approvalVerdict.status === 'STALE_APPROVAL' ? approvalVerdict.record.approved_final_output_hash : null);
  const approvedKey = approvalVerdict.status === 'APPROVED' || approvalVerdict.status === 'STALE_APPROVAL' ? approvalVerdict.record.approved_final_stage_key : null;
  const currentTitleKey = String(report?.downstream?.keys?.TITLE ?? '');
  const hashMatch = !!approvedHash && !!currentTitleHash && approvedHash.toLowerCase() === currentTitleHash.toLowerCase();
  const stageKeyMatch = !!approvedKey && !!currentTitleKey && approvedKey === currentTitleKey;

  const dsStates = stageStatesFrom(report);
  const statuses = report?.downstream?.states ?? {};
  const staleOrBlocked = (['EDIT', 'MIX', 'BED', 'TITLE', 'APPROVAL'] as const).find((s) => statuses[s] !== 'CURRENT') ?? null;

  const musicMissing = inputReport.counts.music.valid === 0 && inputReport.counts.music.total > 0;
  const brandingMissing = inputReport.counts.branding.valid < inputReport.counts.branding.total;
  const readyNotCurrent = (report?.scenes ?? []).filter((s: any) => s.readiness === 'READY' && s.outputState !== 'CURRENT').length;

  const nextAction = deriveNextAction({
    pipelineValid: true,
    anyInvalidInput: inputReport.issues.some((i) => i.state === 'INVALID' || i.state === 'UNSUPPORTED'),
    waitingBackground: scenes.waitingForBackground,
    waitingCharacter: scenes.waitingForCharacterAsset,
    waitingNarration: scenes.waitingForNarration,
    musicMissing, brandingMissing,
    needsGeneration: flow.needsGeneration,
    needsDownloadOrRecovery: uniq([...flow.needsDownload, ...flow.committedLocalMissing]),
    readyNotCurrent,
    downstream: dsStates,
    approvalIntegrity: reconciliation.integrity,
    review: reconciliation.review,
    publishable: reconciliation.publishable,
    titleCurrent,
  });

  // Release state.
  const blockingReasons: string[] = [];
  if (scenes.waitingForBackground || scenes.waitingForCharacterAsset || scenes.waitingForNarration || scenes.waitingForVideoClip || scenes.invalid) blockingReasons.push('scene inputs incomplete');
  if (flow.needsGeneration.length) blockingReasons.push(`Flow generation required for scene(s) ${flow.needsGeneration.join(', ')}`);
  if (flow.committedLocalMissing.length) blockingReasons.push(`Flow-committed but locally missing scene(s) ${flow.committedLocalMissing.join(', ')}`);
  if (scenes.outputCurrent < scenes.total) blockingReasons.push(`${scenes.total - scenes.outputCurrent} scene output(s) not CURRENT`);
  if (!['EDIT', 'MIX', 'BED', 'TITLE'].every((s) => dsStates[s as keyof typeof dsStates] === 'CURRENT')) blockingReasons.push('downstream stages not all CURRENT');
  if (reconciliation.integrity !== 'APPROVAL_VALID') blockingReasons.push(reconciliation.reason);
  if (reconciliation.review === 'REVIEW_POSTED') blockingReasons.push('artifact already posted');

  const releaseState: ProjectHealthReport['release']['releaseState'] =
    reconciliation.review === 'REVIEW_POSTED' ? 'POSTED'
    : blockingReasons.some((r) => /scene inputs|Flow generation|locally missing|scene output/.test(r)) ? 'BLOCKED_INPUTS'
    : blockingReasons.some((r) => /downstream stages/.test(r)) ? 'BLOCKED_PRODUCTION'
    : reconciliation.integrity !== 'APPROVAL_VALID' ? 'BLOCKED_APPROVAL'
    : !reconciliation.publishable ? 'BLOCKED_EXTERNAL_PUBLISHER'
    : 'PUBLISHABLE';

  return {
    projectId,
    pipelinePath: opts.projectFile,
    pipelineSha,
    projectState: String(report?.state ?? 'UNKNOWN'),
    workflowPhase: releaseState === 'PUBLISHABLE' ? 'PUBLISHABLE' : releaseState === 'POSTED' ? 'POSTED' : report?.state ?? 'UNKNOWN',
    inputs: {
      backgrounds: inputReport.counts.backgrounds, characters: inputReport.counts.characters, narration: inputReport.counts.narration,
      flowClips: inputReport.counts.flowClips, music: inputReport.counts.music, branding: inputReport.counts.branding,
      issues: inputReport.issues.map((i) => ({ category: String(i.category), id: i.id, state: String(i.state), reason: i.reason })),
    },
    scenes,
    flow: { ...flow, sessionRequiredForNextAction: nextAction.class === 'FLOW_REQUIRED', nextActionConsumesCredits: nextAction.credit_consuming },
    downstream: { states: dsStates, staleOrBlockedDependency: staleOrBlocked },
    approval: {
      integrity: reconciliation.integrity,
      approvalStatus,
      approvedFinalOutputHash: approvedHash,
      currentTitleHash: currentTitleHash ?? null,
      hashMatch,
      stageKeyMatch,
      review: reconciliation.review,
      reconciliationMismatch: reconciliation.mismatch,
      titleInputProvenance,
    },
    release: { publishable: reconciliation.publishable, releaseState, blockingReasons, nextAction },
    generatedAt: new Date().toISOString(),
  };
}

/** Concise human-readable rendering. */
export function renderHealthReport(r: ProjectHealthReport): string {
  const L: string[] = [];
  L.push(`PROJECT:   ${r.projectId || '(none)'}  state=${r.projectState}`);
  L.push(`pipeline:  ${r.pipelinePath}  sha=${r.pipelineSha.slice(0, 12)}`);
  L.push(`INPUTS:    bg ${r.inputs.backgrounds.valid}/${r.inputs.backgrounds.total}  chars ${r.inputs.characters.valid}/${r.inputs.characters.total}  narr ${r.inputs.narration.valid}/${r.inputs.narration.total}  clips ${r.inputs.flowClips.valid}/${r.inputs.flowClips.total}  music ${r.inputs.music.valid}/${r.inputs.music.total}  branding ${r.inputs.branding.valid}/${r.inputs.branding.total}`);
  L.push(`SCENES:    total ${r.scenes.total}  ready ${r.scenes.ready}  wChars ${r.scenes.waitingForCharacterAsset}  wNarr ${r.scenes.waitingForNarration}  wBG ${r.scenes.waitingForBackground}  wClip ${r.scenes.waitingForVideoClip}  invalid ${r.scenes.invalid}`);
  L.push(`OUTPUTS:   current ${r.scenes.outputCurrent}  stale ${r.scenes.outputStale}  missing ${r.scenes.outputMissing}  invalid ${r.scenes.outputInvalid}`);
  L.push(`FLOW:      needsGen [${r.flow.needsGeneration.join(',')}]  committedLocalAvail ${r.flow.committedLocalAvailable.length}  committedLocalMissing [${r.flow.committedLocalMissing.join(',')}]  localMedia [${r.flow.localMedia.join(',')}]`);
  L.push(`DOWNSTREAM:EDIT=${r.downstream.states.EDIT} MIX=${r.downstream.states.MIX} BED=${r.downstream.states.BED} TITLE=${r.downstream.states.TITLE} APPROVAL=${r.downstream.states.APPROVAL}`);
  L.push(`APPROVAL:  integrity=${r.approval.integrity}  review=${r.approval.review}  hashMatch=${r.approval.hashMatch}  stageKeyMatch=${r.approval.stageKeyMatch}`);
  L.push(`TITLE_INPUT_PROVENANCE: ${r.approval.titleInputProvenance}`);
  L.push(`RELEASE:   ${r.release.releaseState}  publishable=${r.release.publishable}`);
  if (r.release.blockingReasons.length) L.push(`BLOCKERS:  ${r.release.blockingReasons.join('; ')}`);
  L.push(`NEXT:      ${r.release.nextAction.action} [${r.release.nextAction.class}] credits=${r.release.nextAction.credit_consuming} human=${r.release.nextAction.human_required} publisher=${r.release.nextAction.external_publisher_required}`);
  L.push(`           ${r.release.nextAction.detail}`);
  return L.join('\n');
}
