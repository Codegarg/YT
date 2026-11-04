/**
 * Production orchestrator (STEP-8DG).
 *
 * The offline orchestration layer that ties the 8DE validation core to the 8DF checkpoint
 * machine. It:
 *   1. inspects inputs            (8DE inputManifest / sceneState)
 *   2. derives scene readiness     (8DE sceneState)
 *   3. determines the render mode  (8DE sceneState + 8DF renderer modes)
 *   4. classifies existing outputs (8DF projectState)
 *   5. determines the work set
 *   6. (optionally) executes scenes through a CALLER-SUPPLIED executor
 *   7. persists the project checkpoint atomically
 *   8. returns a structured report
 *
 * This module NEVER launches a browser, contacts Flow, or writes to `pipeline.json`. Actual
 * rendering is injected as a `SceneExecutor`, so tests can run a synthetic executor while
 * production wires the real `renderScene()` later.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  deriveProjectState, classifySceneOutput, toProjectStateRecord, saveProjectState, loadProjectState,
  recordedKeysFrom, readSceneSidecar, writeSceneSidecar, safeOutputPath, PROJECT_STATE_SCHEMA_VERSION,
  sanitizeFailureReason, FAILURES_MAX, SECRET_REDACTION_RE,
  type ProjectStateRecord, type OutputState, type ProjectState, type FinalStageState, type FailureRecord,
} from './projectState.js';
import type { SceneInputInspection, RenderMode } from './sceneState.js';
import { validateVideoClip } from './videoClip.js';
import {
  planDownstream, buildStageGraph, safeStageOutputPath, sha256OfFileOrNull, stageKey,
  validateRecordedStageOutputs, recordedKeyInputs,
  type DownstreamStage, type StageState, type StageInputs, type StageExecutor, type RecordedStage,
} from './downstreamStages.js';
import crypto from 'node:crypto';

export interface SceneWorkItem {
  sceneNumber: number;
  readiness: string;
  renderMode: RenderMode;
  durationSeconds: number | null;
  renderKey: string;
  outputPath: string;
  outputState: OutputState;
  /** True when this scene must be (re)produced this run. */
  needsWork: boolean;
}

export interface ExecutionResult {
  ok: boolean;
  reason?: string;
}

/**
 * Caller-supplied scene producer. Receives the resolved scene, the deterministic output path
 * and a context. Must write a valid scene clip at `outputPath` when it succeeds.
 */
export type SceneExecutor = (
  scene: SceneInputInspection,
  outputPath: string,
  context: { projectId: string; outputsDir: string; inputRoot: string; width: number; height: number },
) => Promise<ExecutionResult>;

export interface OrchestrationOptions {
  pipeline: any;
  projectId?: string;
  /** Absolute project input root (production/inputs/<id>). */
  inputRoot: string;
  /** Directory for real scene outputs. */
  outputsDir: string;
  /** Base directory of the project outputs (state.json lives here). Defaults to dirname(outputsDir). */
  outputsRoot?: string;
  ffprobePath?: string;
  width?: number;
  height?: number;
  /** When omitted, orchestration is inspection-only (no execution). */
  executor?: SceneExecutor;
  /** Human approval â€” never inferred. */
  approved?: boolean;
  /** Downstream stage completion signals (never inferred from file existence). */
  stages?: { edit?: boolean; mix?: boolean; bed?: boolean; title?: boolean };
  final?: FinalStageState;
  /** Synthetic downstream stage inputs (BGM/intro/logo/title metadata hashes). */
  stageInputs?: Partial<StageInputs>;
  /**
   * STEP-8FQ: when true, a recorded downstream stage output must ALSO pass `validateVideoClip`
   * (the existing media contract) to count as CURRENT. Default false: integrity is enforced via
   * the authoritative recorded SHA-256 vs the file on disk (existence + exact hash match), which
   * is sufficient to defeat corruption and does not require ffprobe on every planning pass.
   */
  validateStageMedia?: boolean;
  /** Downstream stage executor. When omitted, downstream stages are only PLANNED. */
  stageExecutor?: StageExecutor;
  /** Explicit human approval/rejection action for the approval gate. */
  approvalAction?: 'approve' | 'reject';
  /**
   * READ-ONLY mode (8DI diagnostics): never creates directories, never writes state.json,
   * never writes stage metadata or sidecars. Used by `production:check`.
   */
  readOnly?: boolean;
  /**
   * Scoped execution (STEP-8GQ): when set, ONLY these scene numbers are eligible for scene
   * execution. The work set and executor loop are restricted to this set; unrelated scenes and
   * downstream stages are never touched. Readiness of unrelated scenes is NOT required.
   */
  onlyScenes?: number[];
  /**
   * Explicit Flow-execution scope (STEP-8HD). Scenes listed here may be executed via the caller's
   * Flow SceneExecutor even when their FINAL production readiness is not `READY` (e.g. a dialogue
   * scene awaiting its Flow clip). Callers MUST only list scenes already classified Flow-eligible
   * (non-Flow prerequisites valid). Absent ⇒ behavior unchanged.
   */
  flowEligibleScenes?: number[];
}

export interface OrchestrationReport {
  projectId: string;
  state: ProjectState;
  sceneCount: number;
  workSet: number[];
  executedScenes: number[];
  failedScenes: number[];
  scenes: SceneWorkItem[];
  /** Per-scene output classification BEFORE this run's execution (where invalidation shows). */
  priorOutputStates: Record<string, OutputState>;
  /** Downstream stage planning/execution (8DH). */
  downstream: {
    states: Record<DownstreamStage, StageState>;
    workSet: DownstreamStage[];
    executedStages: DownstreamStage[];
    failedStages: DownstreamStage[];
    keys: Record<DownstreamStage, string>;
  };
  /** Stage-key input material (for guarded execution's live key recomputation). */
  sceneOutputHashes: Record<string, string>;
  narrationInputs: StageInputs['narration'];
  stageInputHashes: { bgmHash: string | null; introHash: string | null; logoHash: string | null; titleMetadata: unknown };
  sceneSetHash: string;
  counts: { ready: number; waitingBackground: number; waitingCharacter: number; waitingNarration: number; waitingVideo: number; invalid: number };
  stateFile: string;
}

const EMPTY_FINAL: FinalStageState = {
  edit_state: 'NOT_STARTED', mix_state: 'NOT_STARTED', bed_state: 'NOT_STARTED', title_state: 'NOT_STARTED',
  output_path: null, output_hash: null,
};

const sceneOutputPath = (outputsDir: string, n: number) => safeOutputPath(outputsDir, `scene-${String(n).padStart(4, '0')}.mp4`);

/**
 * Determine which scenes need work from a derivation (pure w.r.t. side effects).
 * A scene needs work unless its output is CURRENT. When `onlyScenes` is supplied, only those
 * scene numbers are eligible (STEP-8GQ scoped execution).
 */
/** Per-stage diagnostic capture budget: bounded so a runaway stderr can never fill a disk. */
const STAGE_DIAGNOSTIC_MAX_BYTES = 64 * 1024;

/**
 * Persist the FULL producer error for a failed stage to `<outputsDir>/.stage-diagnostics/<STAGE>.log`.
 *
 * Diagnostic only. The recorded `failures[].reason` is left exactly as before (first line, capped),
 * because that value is part of the persisted project-state contract. This writes a separate,
 * project-scoped, bounded artefact so the child's stderr is recoverable.
 *
 * Secrets are redacted with the SAME shared pattern `sanitizeFailureReason` uses
 * (`SECRET_REDACTION_RE` from projectState), so the two can never drift apart. Environment variables
 * are never enumerated and no unrelated data is collected: only the producer's own error text.
 *
 * Exported purely as a test seam (unit-tested directly); production behaviour is unchanged.
 */
export async function writeStageDiagnostic(outputsDir: string, stage: string, raw: unknown): Promise<void> {
  if (typeof raw !== 'string' || !raw.trim()) return;
  const redacted = raw
    .replace(SECRET_REDACTION_RE, '[redacted]');
  const body = Buffer.from(redacted, 'utf8').subarray(0, STAGE_DIAGNOSTIC_MAX_BYTES).toString('utf8');
  const header = `# ${stage} producer diagnostic (full error, secret-redacted, capped ${STAGE_DIAGNOSTIC_MAX_BYTES} bytes)\n# captured ${new Date().toISOString()}\n\n`;
  const dir = path.join(outputsDir, '.stage-diagnostics');
  const file = path.join(dir, `${stage}.log`);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(file, header + body, 'utf8');
}

export function determineWorkSet(scenes: { sceneNumber: number; outputState: OutputState; inspection: SceneInputInspection }[], onlyScenes?: number[], flowEligibleScenes?: number[]): number[] {
  const allow = onlyScenes && onlyScenes.length ? new Set(onlyScenes.map(Number)) : null;
  const flowAllow = flowEligibleScenes && flowEligibleScenes.length ? new Set(flowEligibleScenes.map(Number)) : null;
  return scenes
    .filter((s) => (allow ? allow.has(s.sceneNumber) : true))
    .filter((s) => (s.inspection.readiness === 'READY' || (flowAllow ? flowAllow.has(s.sceneNumber) : false)) && s.outputState !== 'CURRENT')
    .map((s) => s.sceneNumber)
    .sort((a, b) => a - b);
}

/** Build the per-scene work items (inspection only). */
function toWorkItems(scenes: { sceneNumber: number; outputState: OutputState; inspection: SceneInputInspection; outputPath: string | null }[], outputsDir: string, onlyScenes?: number[], flowEligibleScenes?: number[]): SceneWorkItem[] {
  const workSet = new Set(determineWorkSet(scenes as any, onlyScenes, flowEligibleScenes));
  return scenes.map((s) => ({
    sceneNumber: s.sceneNumber,
    readiness: s.inspection.readiness,
    renderMode: s.inspection.renderMode,
    durationSeconds: s.inspection.durationSeconds,
    renderKey: s.inspection.renderKey,
    outputPath: s.outputPath ?? sceneOutputPath(outputsDir, s.sceneNumber),
    outputState: s.outputState,
    needsWork: workSet.has(s.sceneNumber),
  }));
}

/**
 * Run one orchestration pass.
 *
 * When `executor` is supplied, scenes needing work are executed; on success a render sidecar
 * is written (binding render key + output hash) so the next run can classify them CURRENT.
 * A failed execution never writes a sidecar, so the scene cannot be falsely CURRENT.
 */
export async function orchestrate(options: OrchestrationOptions): Promise<OrchestrationReport> {
  const projectId = String(options.projectId ?? options.pipeline?.project_id ?? '').trim();
  if (!projectId) throw new Error('orchestrate requires a project id.');
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  const outputsRoot = options.outputsRoot ?? path.dirname(path.resolve(options.outputsDir));
  if (!options.readOnly) await fsp.mkdir(options.outputsDir, { recursive: true });

  // ---- 1-4. load previous checkpoint + derive ----
  const previous = await loadProjectState(projectId, outputsRoot);
  const recorded = recordedKeysFrom(previous);

  // Sidecars are the per-scene authority. A PRESENT sidecar wins (even if it is corrupt â€”
  // corruption must force revalidation, never be rescued by stale state). State keys are a
  // fallback only for scenes with NO sidecar at all.
  const derivation0 = await deriveProjectState({
    pipeline: options.pipeline, inputRoot: options.inputRoot, outputsDir: options.outputsDir,
    ffprobePath: options.ffprobePath, recorded, approved: options.approved, stages: options.stages,
  });
  const merged = new Map<number, { render_key?: string; output_hash?: string }>();
  for (const s of derivation0.scenes) {
    const sidecarFile = safeOutputPath(options.outputsDir, `scene-${String(s.sceneNumber).padStart(4, '0')}.json`);
    const present = await fsp.stat(sidecarFile).then((st) => st.isFile()).catch(() => false);
    if (present) {
      // A sidecar exists on disk: trust ONLY it. A malformed one contributes no key,
      // forcing STALE_UNKNOWN instead of being rescued by stale state.
      const sc = await readSceneSidecar(options.outputsDir, s.sceneNumber);
      if (sc && sc.render_key) merged.set(s.sceneNumber, { render_key: sc.render_key, output_hash: sc.output_hash });
    } else if (recorded.has(s.sceneNumber)) {
      merged.set(s.sceneNumber, recorded.get(s.sceneNumber)!);
    }
  }
  const derivation2 = await deriveProjectState({
    pipeline: options.pipeline, inputRoot: options.inputRoot, outputsDir: options.outputsDir,
    ffprobePath: options.ffprobePath, recorded: merged, approved: options.approved, stages: options.stages,
  });

  const workSet = determineWorkSet(derivation2.scenes as any, options.onlyScenes, options.flowEligibleScenes);
  const executedScenes: number[] = [];
  const failedScenes: number[] = [];
  // Failure provenance for the persisted record. Kept separate from `failedScenes` so the existing
  // arrays (and every existing assertion on them) are untouched.
  const failures: FailureRecord[] = [];

  // ---- 5-6. execute the work set (if an executor was supplied) ----
  if (options.executor) {
    for (const item of derivation2.scenes) {
      if (!workSet.includes(item.sceneNumber)) continue;
      const outPath = item.outputPath ?? sceneOutputPath(options.outputsDir, item.sceneNumber);
      let result: ExecutionResult;
      try {
        result = await options.executor(item.inspection, outPath, { projectId, outputsDir: options.outputsDir, inputRoot: options.inputRoot, width, height });
      } catch (e: any) {
        result = { ok: false, reason: String(e?.message ?? e) };
      }
      if (!result.ok) {
        failedScenes.push(item.sceneNumber);
        failures.push({ category: 'scene', target: String(item.sceneNumber), reason: sanitizeFailureReason(result.reason) });
        // Never write a sidecar for a failure; remove any partial output so it can't look valid.
        await fsp.rm(outPath, { force: true }).catch(() => {});
        continue;
      }
      // Validate the produced output before recording it.
      const clip = await validateVideoClip(outPath, { ffprobePath: options.ffprobePath });
      if (clip.state !== 'VALID') {
        failedScenes.push(item.sceneNumber);
        failures.push({ category: 'scene', target: String(item.sceneNumber), reason: sanitizeFailureReason(clip.reason ?? `output ${clip.state}`) });
        await fsp.rm(outPath, { force: true }).catch(() => {});
        continue;
      }
      await writeSceneSidecar(options.outputsDir, item.sceneNumber, {
        scene_number: item.sceneNumber,
        render_key: item.inspection.renderKey,
        output_hash: clip.sha256 ?? '',
        output_path: path.basename(outPath),
        renderer_contract_version: (await import('./sceneState.js')).RENDERER_CONTRACT_VERSION,
      });
      executedScenes.push(item.sceneNumber);
    }
  }

  // ---- re-derive after execution for an accurate final state ----
  const finalRecorded = new Map<number, { render_key?: string; output_hash?: string }>(merged);
  for (const n of executedScenes) {
    const sc = await readSceneSidecar(options.outputsDir, n);
    if (sc && sc.render_key) finalRecorded.set(n, { render_key: sc.render_key, output_hash: sc.output_hash });
  }

  let finalDerivation = await deriveProjectState({
    pipeline: options.pipeline, inputRoot: options.inputRoot, outputsDir: options.outputsDir,
    ffprobePath: options.ffprobePath, recorded: finalRecorded, approved: options.approved, stages: options.stages,
  });

  // A failed execution must surface as FAILED (resumable), never a false success state.
  //
  // Mirrors the stage-failure rule below exactly, and the test proves the same inconsistency
  // existed here: a scene executor that was genuinely invoked and failed left the persisted state
  // at WAITING_FOR_INPUTS whenever some OTHER scene was waiting on an input, understating a real
  // failure. A project that is only waiting (no attempted failure) is unaffected — `failedScenes`
  // is empty, so no escalation happens. INPUTS_INVALID stays exempt for the same reason as stages.
  let state: ProjectState = finalDerivation.state;
  if (failedScenes.length > 0 && state !== 'INPUTS_INVALID') state = 'FAILED';

  // ---- 8DH: downstream stage graph (EDIT â†’ MIX â†’ BED â†’ TITLE â†’ APPROVAL) ----
  const stageStatesFile = path.join(outputsRoot, projectId, 'stages.json');
  const priorStages: Record<string, RecordedStage | undefined> = await fsp.readFile(stageStatesFile, 'utf8')
    .then((t) => JSON.parse(t) as Record<string, RecordedStage>).catch(() => ({}));
  // The per-stage `.stage` sidecars are the authoritative record (written on every successful
  // stage, by both the orchestrator and the guarded CLI executor). Prefer them over stages.json.
  for (const st of ['EDIT', 'MIX', 'BED', 'TITLE'] as DownstreamStage[]) {
    const sc = await fsp.readFile(`${safeStageOutputPath(options.outputsDir, st)}.stage`, 'utf8')
      .then((t) => JSON.parse(t) as RecordedStage).catch(() => undefined);
    if (sc && sc.key) priorStages[st] = sc;
  }

  // Build stage inputs from ACTUAL current evidence.
  const sceneOutputHashes: Record<string, string> = {};
  for (const s of finalDerivation.scenes) if (s.outputHash) sceneOutputHashes[String(s.sceneNumber)] = s.outputHash;

  const narrationInputs: StageInputs['narration'] = {};
  for (const s of finalDerivation.scenes) {
    const n = s.inspection.narrationAsset;
    if (n.state === 'VALID' && n.sha256) narrationInputs[String(s.sceneNumber)] = { hash: n.sha256, durationSeconds: n.durationSeconds ?? null };
  }

  const stageInputs: StageInputs = {
    sceneOutputHashes,
    narration: narrationInputs,
    editOutputHash: await sha256OfFileOrNull(safeStageOutputPath(options.outputsDir, 'EDIT')),
    mixOutputHash: await sha256OfFileOrNull(safeStageOutputPath(options.outputsDir, 'MIX')),
    bedOutputHash: await sha256OfFileOrNull(safeStageOutputPath(options.outputsDir, 'BED')),
    titleOutputHash: await sha256OfFileOrNull(safeStageOutputPath(options.outputsDir, 'TITLE')),
    bgmHash: options.stageInputs?.bgmHash ?? null,
    introHash: options.stageInputs?.introHash ?? null,
    logoHash: options.stageInputs?.logoHash ?? null,
    titleMetadata: options.stageInputs?.titleMetadata ?? null,
  };

  const allScenesCurrent = finalDerivation.scenes.length > 0 && finalDerivation.scenes.every((s) => s.outputState === 'CURRENT');
  const recordedStages: Record<DownstreamStage, RecordedStage | undefined> = {
    EDIT: priorStages.EDIT, MIX: priorStages.MIX, BED: priorStages.BED, TITLE: priorStages.TITLE, APPROVAL: priorStages.APPROVAL,
  } as any;

  // STEP-8FQ: verify each recorded stage OUTPUT against the file on disk. A matching key is not
  // sufficient â€” a corrupt/deleted/missing-hash output must never count as CURRENT.
  const stageIntegrity = await validateRecordedStageOutputs(options.outputsDir, recordedStages, { validateMedia: options.validateStageMedia === true, ffprobePath: options.ffprobePath });

  // Scenes must be CURRENT before any downstream stage is meaningful. We still COMPUTE the
  // stage states (they will be gated to STALE by the upstream check) so diagnostics are honest.
  const plan = planDownstream(stageInputs, recordedStages, { approved: options.approved === true, integrity: stageIntegrity });

  const executedStages: DownstreamStage[] = [];
  const failedStages: DownstreamStage[] = [];

  if (options.stageExecutor && allScenesCurrent) {
    // Recompute stage inputs incrementally: each stage's key must reflect the UPSTREAM OUTPUT
    // THAT ACTUALLY EXISTS at the moment it runs (never a stale pre-execution hash).
    const liveInputs: StageInputs = { ...stageInputs };
    for (const stage of plan.workSet) {
      if (stage === 'APPROVAL') continue; // APPROVAL is a human gate, never executed
      const outPath = safeStageOutputPath(options.outputsDir, stage);
      const liveKey = stageKey(stage, liveInputs);
      const depHash = crypto.createHash('sha256').update(liveKey).digest('hex');
      let result: any;
      try { result = await options.stageExecutor(stage, outPath, { stageKey: liveKey, dependencyHash: depHash }); }
      catch (e: any) { result = { ok: false, reason: String(e?.message ?? e) }; }
      if (!result?.ok) {
        failedStages.push(stage);
        failures.push({ category: 'stage', target: String(stage), reason: sanitizeFailureReason(result?.reason) });
        // DIAGNOSTIC ONLY. `sanitizeFailureReason` keeps the FIRST LINE of the producer error, which
        // for a `Command failed:` error is just the command line -- the child's stderr, which carries
        // the actual ffmpeg/producer cause, lives on the FOLLOWING lines and was therefore
        // unrecoverable from state.json. Persist the full, secret-redacted text to a bounded,
        // project-local file next to the outputs. This never alters control flow, stage selection,
        // retry behaviour, readiness, approval logic, error classification, or the recorded reason.
        await writeStageDiagnostic(options.outputsDir, stage, result?.reason).catch(() => {});
        await fsp.rm(outPath, { force: true }).catch(() => {});
        await fsp.rm(`${outPath}.stage`, { force: true }).catch(() => {});
        break; // downstream cannot proceed past a failure
      }
      // Record the stage binding atomically (sidecar) â€” never on failure.
      const sidecar = `${outPath}.stage`;
      const tmp = `${sidecar}.${process.pid}.tmp`;
      const outputHash = result.outputHash ?? (await sha256OfFileOrNull(outPath)) ?? '';
      await fsp.writeFile(tmp, `${JSON.stringify({ stage, key: liveKey, output_hash: outputHash, output_path: path.basename(outPath), key_inputs: recordedKeyInputs(liveInputs) }, null, 2)}\n`, 'utf8');
      await fsp.rename(tmp, sidecar);
      executedStages.push(stage);
      // Feed this stage's real output hash into the next upstream lookup.
      if (stage === 'EDIT') liveInputs.editOutputHash = outputHash;
      if (stage === 'MIX') liveInputs.mixOutputHash = outputHash;
      if (stage === 'BED') liveInputs.bedOutputHash = outputHash;
      if (stage === 'TITLE') liveInputs.titleOutputHash = outputHash;
    }
  }

  // Re-derive the stage plan after execution for an accurate final picture, using the ACTUAL
  // on-disk stage outputs (not the pre-execution snapshot).
  const recordedAfter: Record<DownstreamStage, RecordedStage | undefined> = { EDIT: undefined, MIX: undefined, BED: undefined, TITLE: undefined, APPROVAL: undefined };
  for (const st of ['EDIT', 'MIX', 'BED', 'TITLE'] as DownstreamStage[]) {
    const sc = await fsp.readFile(`${safeStageOutputPath(options.outputsDir, st)}.stage`, 'utf8').then((t) => JSON.parse(t) as RecordedStage).catch(() => undefined);
    recordedAfter[st] = sc;
  }
  const finalInputs: StageInputs = {
    ...stageInputs,
    editOutputHash: await sha256OfFileOrNull(safeStageOutputPath(options.outputsDir, 'EDIT')),
    mixOutputHash: await sha256OfFileOrNull(safeStageOutputPath(options.outputsDir, 'MIX')),
    bedOutputHash: await sha256OfFileOrNull(safeStageOutputPath(options.outputsDir, 'BED')),
    titleOutputHash: await sha256OfFileOrNull(safeStageOutputPath(options.outputsDir, 'TITLE')),
  };
  const finalIntegrity = await validateRecordedStageOutputs(options.outputsDir, recordedAfter, { validateMedia: options.validateStageMedia === true, ffprobePath: options.ffprobePath });
  const finalPlan = planDownstream(finalInputs, recordedAfter, { approved: options.approved === true, integrity: finalIntegrity });
  const finalKeys = Object.fromEntries(buildStageGraph(finalInputs).map((n) => [n.stage, n.key])) as Record<DownstreamStage, string>;

  // Persist stage metadata atomically â€” skipped in read-only mode, and skipped when there is
  // nothing to record (no stage has produced a trustworthy output yet). This keeps the write
  // set to exactly state.json for an inputs-missing project.
  if (!options.readOnly) {
  try {
    const persist: Record<string, RecordedStage> = {};
    for (const st of ['EDIT', 'MIX', 'BED', 'TITLE'] as DownstreamStage[]) if (recordedAfter[st]) persist[st] = recordedAfter[st]!;
    if (Object.keys(persist).length > 0) {
      await fsp.mkdir(path.dirname(stageStatesFile), { recursive: true });
      const tmp = `${stageStatesFile}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, `${JSON.stringify(persist, null, 2)}\n`, 'utf8');
      await fsp.rename(tmp, stageStatesFile);
    }
  } catch { /* stage metadata is best-effort; the per-stage sidecars are authoritative */ }
  }

  // A failed stage surfaces as FAILED (resumable).
  //
  // A missing input must NOT downgrade a stage failure that actually happened. The previous
  // condition also excluded WAITING_FOR_INPUTS, so whenever a project was waiting on an input AND
  // a downstream stage was genuinely attempted and failed, the persisted state.json recorded
  // "just waiting for inputs" — while the public status result correctly reported the failure.
  // The two disagreed, and the file that survives a restart understated a real failure.
  //
  // INPUTS_INVALID stays exempt: malformed/unusable inputs are a configuration problem rather
  // than an execution failure, and that existing behaviour is preserved deliberately.
  if (failedStages.length > 0 && state !== 'INPUTS_INVALID') state = 'FAILED';
  // A fully CURRENT downstream chain with an approved title is the only route to COMPLETED.
  else if (allScenesCurrent && finalPlan.states.TITLE === 'CURRENT') {
    if (options.approvalAction === 'reject') state = 'EDITING';
    else state = options.approved === true ? 'COMPLETED' : 'AWAITING_APPROVAL';
  }

  const record = toProjectStateRecord(projectId, finalDerivation, options.final ?? EMPTY_FINAL);
  record.state = state;
  // Attach failure provenance ONLY when THIS run actually attempted and failed work. Omitting the
  // field on a clean run is what clears stale provenance, and derivation alone never sets it, so a
  // read-only inspection (which does not save at all) cannot disturb a recorded failure.
  if (failures.length > 0) {
    record.failures = {
      at: new Date().toISOString(),
      failures: failures.slice(0, FAILURES_MAX),
    };
  }
  const stateFile = options.readOnly ? path.join(outputsRoot, projectId, 'state.json') : await saveProjectState(projectId, record, outputsRoot);

  return {
    projectId, state, sceneCount: finalDerivation.scenes.length, workSet,
    executedScenes, failedScenes,
    scenes: toWorkItems(finalDerivation.scenes as any, options.outputsDir, options.onlyScenes, options.flowEligibleScenes),
    priorOutputStates: Object.fromEntries(derivation2.scenes.map((s) => [String(s.sceneNumber), s.outputState])),
    downstream: { states: finalPlan.states as any, workSet: plan.workSet, executedStages, failedStages, keys: finalKeys },
    sceneOutputHashes,
    narrationInputs,
    stageInputHashes: { bgmHash: stageInputs.bgmHash ?? null, introHash: stageInputs.introHash ?? null, logoHash: stageInputs.logoHash ?? null, titleMetadata: stageInputs.titleMetadata ?? null },
    sceneSetHash: finalDerivation.sceneSetHash,
    counts: finalDerivation.counts,
    stateFile,
  };
}

/** Inspection-only pass (no executor): readiness + work set + persisted checkpoint. */
export async function inspectProject(options: Omit<OrchestrationOptions, 'executor'>): Promise<OrchestrationReport> {
  return orchestrate(options);
}
