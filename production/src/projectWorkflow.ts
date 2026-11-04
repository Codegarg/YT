/**
 * Top-level single-command project workflow (STEP-8GL).
 *
 * This is the ONE orchestration authority that coordinates the EXISTING components
 * without duplicating any of them:
 *
 *   STORY        scripting/pipeline/one_minute.py  → pipeline.json   (external provider)
 *   PRODUCTION   projectOrchestrator.runProject()  → readiness + EDIT/MIX/BED/TITLE
 *   FLOW         production cli (`npm run flow`)   → Flow runner      (credit boundary)
 *   EXTERNAL     inputValidator / manifestWorkflow → narration/BGM/branding/clips
 *   APPROVAL     reviewState / human gate
 *
 * Design rules:
 *   · CREATE only ever creates a NEW project; it never touches an existing one.
 *   · RESUME only ever resumes an EXISTING project; it NEVER regenerates the story.
 *   · STATUS is strictly read-only.
 *   · Flow generation is a SEPARATE, injectable boundary and is NEVER executed here.
 *   · Nothing is approved or published here.
 *
 * The persisted lifecycle remains authoritative in `projectState` (state.json). This module
 * only reports a friendlier workflow PHASE; it does not introduce a second state machine.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  allocateProjectId,
  runProject,
  resolveProjectPaths,
  loadPipeline,
  type ProjectPaths,
  type RunProjectResult,
  type RunBlocker,
} from './projectOrchestrator.js';
import { draftManifest } from './manifestWorkflow.js';
import { executeStage, type StageExecutorConfig } from './stageExecutor.js';
import { createRealSceneExecutor } from './sceneExecutorAdapter.js';
import { classifyFlowNeeds } from './flowRunnerAdapter.js';
import { evaluateApproval, loadApproval, approvalRecordPath, type ApprovalRecord } from './approval.js';
import type { DownstreamStage, StageExecutor, StageExecutionResult } from './downstreamStages.js';
import type { SceneLocalAuthorization } from './sceneGenerationPolicy.js';

// ---------------------------------------------------------------------------------------
// Workflow phases (reporting only — state.json stays authoritative)
// ---------------------------------------------------------------------------------------

export type WorkflowPhase =
  | 'NOT_FOUND'
  | 'CREATED'
  | 'PIPELINE_READY'
  | 'INPUTS_REQUIRED'
  | 'FLOW_REQUIRED'
  | 'PRODUCTION_READY'
  | 'PRODUCTION_RUNNING'
  | 'AWAITING_APPROVAL'
  | 'SCENE_SCOPE_COMPLETED'
  | 'SCENE_SCOPE_INCOMPLETE'
  | 'FLOW_WORK_COMPLETED_WITH_BLOCKERS'
  | 'COMPLETED'
  | 'FAILED';

export interface WorkflowResult {
  projectId: string;
  projectPath: string;
  projectRoot: string;
  status: RunProjectResult['status'] | 'NOT_FOUND' | 'CREATED' | 'FAILED';  phase: WorkflowPhase;
  blockers: RunBlocker[];
  completed: string[];
  nextAction: string;
  resumable: boolean;
  /** Derived external-input handoff (from the real pipeline; never hardcoded). */
  requiredInputs?: RequiredInputsHandoff;
  /** Underlying runProject result when production was inspected/executed. */
  production?: RunProjectResult;
  /** Structured Flow-phase result when the Flow boundary was evaluated/invoked. */
  flow?: { status?: string; ok?: boolean; reason?: string; completed?: number[]; blockers?: string[] };
  /** Scoped scene execution metadata (STEP-8GQ). Present only for `--only` runs. */
  scope?: { scenes: number[]; executed: number[]; failed: number[] };
  /** Durable approval verdict (STEP-8GV). Never causes an automatic approval. */
  approval?: { status: 'APPROVED' | 'NOT_APPROVED' | 'STALE_APPROVAL'; record?: ApprovalRecord; finalOutputHash?: string; reason?: string };
  /** Reason for a hard failure (malformed pipeline, generator failure, collision). */
  reason?: string;
}

export interface RequiredInputsHandoff {
  narration: Array<{ scene: number; path: string }>;
  characters: Array<{ tag: string; path: string }>;
  backgrounds: Array<{ tag: string; path: string }>;
  flowClips: Array<{ scene: number; path: string; required: boolean }>;
  music: string[];
  branding: string[];
}

export interface WorkflowOptions {
  projectsRoot: string;
  inputsRoot: string;
  outputsRoot: string;
  ffprobePath?: string;
  host?: string;
  /** Bounded run-log controls (forwarded to runProject). */
  logRetention?: number;
  logMaxBytes?: number;
  /**
   * STORY boundary. CREATES a fresh pipeline for the given project directory.
   * MUST be injected by the caller; the module never invents story generation.
   */
  pipelineGenerator?: PipelineGenerator;
  /**
   * FLOW boundary. Exposed for a later stage; NEVER invoked by this module.
   * Kept here only so the orchestration shell owns exactly one Flow boundary.
   */
  flowRunner?: FlowRunner;
  /**
   * Explicit Flow enablement (STEP-8GM). Default FALSE: `resume` is zero-credit and reports
   * `FLOW_REQUIRED` when Flow work exists. Set true (CLI `--run-flow`) to invoke `flowRunner`.
   */
  runFlow?: boolean;
  /** Output dir for Flow work (defaults to the project outputs dir). */
  flowOutputDir?: string;
  /**
   * OPT-IN, programmatic exact-target authorization for one existing scene EXTEND/REGENERATE.
   * Forwarded verbatim to the scene executor; NEVER inferred from `runFlow` or scene state.
   */
  sceneLocalAuthorization?: SceneLocalAuthorization | null;
  /** Passed to the Flow boundary when invoked (e.g. input root override in tests). */
  flowInputRoot?: string;
  /**
   * PRODUCTION executor boundary. Defaults to the REAL stage producers (`executeStage`).
   * Tests inject a synthetic in-process producer. When omitted, `resume` runs production
   * through the existing `runProject` boundary using the real downstream producers.
   */
  stageExecutorFactory?: StageExecutorFactory;
  /**
   * SCENE boundary. Produces a local scene output (+ checkpoint) for scenes that are not yet
   * CURRENT before downstream stages can run. This is the SAME Flow/local boundary as
   * `flowRunner`; the shell does not implement scene rendering itself, it only wires it.
   * Tests inject a synthetic copy-based executor.
   */
  sceneExecutor?: SceneExecutor;
  /**
   * SCENE executor factory (STEP-8GN). Builds the production SceneExecutor bound to one project
   * (thin adapter over the existing `processSingleFlowScene`). Tests may inject a synthetic
   * executor via `sceneExecutor` directly; when both are present `sceneExecutor` wins.
   */
  sceneExecutorFactory?: SceneExecutorFactory;
  /**
   * The Flow client (or a compatible stub) made available to the real scene executor. Owned by
   * the Flow/Chrome session layer — this workflow NEVER creates a browser itself.
   */
  sceneFlowClient?: any;
  /**
   * Flow session boundary (STEP-8GO). When Flow is enabled AND this is provided, the workflow
   * runs production INSIDE `withFlowSession`, injecting `session.client` as the scene Flow
   * client. This is the ONLY interactive browser-lifecycle path, and it holds the single 8GK
   * Flow session lock. When omitted, Flow-enabled resume uses `flowRunner` (the CLI subprocess
   * boundary) instead — never both, so the lock is never acquired twice.
   */
  flowSessionRunner?: FlowSessionRunner;
  /** Profile/URL options for the real session when `flowSessionRunner` is not injected. */
  flowProfileDir?: string;
  flowUrl?: string;
  /** TITLE requirements: channel intro/logo (real branding inputs) for the TITLE stage. */
  titleAssets?: { intro: string; logo: string; title?: string };
  /** Explicit BGM path for the BED stage. */
  bgmPath?: string;
  /**
   * Downstream stage-key input hashes (STEP-8GU). Supplying consistent hashes makes BED/TITLE
   * invalidation key-driven (BGM/intro/logo/title metadata). When omitted, keys use null and
   * only output-hash chaining drives invalidation.
   */
  stageInputs?: { bgmHash?: string | null; introHash?: string | null; logoHash?: string | null; titleMetadata?: unknown };
  /**
   * Repo production dir (where `src/edit.ts` … stage scripts live). The real stage executor
   * resolved `process.cwd()` by default; the workflow carries it explicitly so it is never
   * inferred from an unrelated path. Defaults to the current working directory.
   */
  productionDir?: string;
  /** Injectable read-only project inspection seam (tests). Defaults to productionOrchestrator.inspectProject. */
  inspectProject?: (args: any) => Promise<any>;
  /**
   * Scoped scene execution (STEP-8GQ). When set, ONLY these scene numbers are eligible for
   * scene work. Unrelated scenes' missing inputs do NOT block the scoped run, and the run never
   * marks the whole project complete. Absent ⇒ full-project behavior (unchanged).
   */
  only?: number[];
}

/**
 * Story-generation boundary. Returns the absolute pipeline path on success, or throws.
 * A production adapter shells out to `scripting/pipeline/one_minute.py`; tests inject a fake.
 */
export type PipelineGenerator = (input: {
  projectId: string;
  projectDir: string;
  pipelineFile: string;
  title: string;
  concept?: string;
  durationMinutes?: number;
  scenes?: number;
  model?: string;
}) => Promise<{ pipelineFile: string }>;

/** Flow boundary (only invoked when explicitly enabled in a later step). */
export type FlowRunner = (input: {
  projectId: string;
  pipelineFile: string;
  outputDir: string;
  /** Absolute project input root. Derived by the boundary when omitted. */
  inputRoot?: string;
  /** Absolute outputs root. Derived by the boundary when omitted. */
  outputsRoot?: string;
  /** Generation authorization. The workflow only invokes the boundary when runFlow is true. */
  allowGeneration?: boolean;
  ffprobePath?: string;
}) => Promise<{
  ok: boolean;
  reason?: string;
  status?: 'COMPLETED' | 'WAITING_FOR_INPUTS' | 'FLOW_REQUIRED' | 'FLOW_MEDIA_RECOVERY_REQUIRED' | 'RECOVERABLE_FAILURE' | 'FAILED';
  completed?: number[];
  blockers?: string[];
}>;

/** Input to the production executor factory (resolved project paths + explicit stage options). */
export interface StageExecutorFactoryInput {
  projectId: string;
  outputsDir: string;
  inputsDir: string;
  /** Repo production dir (where the stage scripts live). */
  productionDir: string;
  titleAssets?: { intro: string; logo: string; title?: string };
  bgmPath?: string;
  ffprobePath?: string;
}

/**
 * Builds a `runProject` stage executor for a project. The default implementation
 * (`createRealStageExecutor`) runs the REAL downstream producers via `executeStage`;
 * tests inject a synthetic executor instead.
 *
 * The returned executor is the EXISTING concrete `StageExecutor` type — no parallel type.
 */
export type StageExecutorFactory = (input: StageExecutorFactoryInput) => StageExecutor;

/**
 * Scene rendering boundary: produces a local scene output for one scene that is not yet CURRENT.
 * The real implementation is the Flow/local scene boundary (injected by a later step); tests
 * inject a synthetic executor. The shell never renders scenes itself.
 */
export type SceneExecutor = (scene: any, outputPath: string, context?: { projectId?: string; outputsDir?: string; inputRoot?: string }) => Promise<{ ok: boolean; reason?: string }>;

/** Builds a `SceneExecutor` bound to one project (real adapter or a test fake). */
export type SceneExecutorFactory = (input: {
  projectId: string;
  inputRoot: string;
  outputsDir: string;
  outputsRoot: string;
  pipeline: any;
  allowGeneration: boolean;
  ffprobePath?: string;
  flow?: any;
  /** OPT-IN exact scene-local authorization; forwarded verbatim to the real adapter. */
  sceneLocalAuthorization?: SceneLocalAuthorization | null;
}) => SceneExecutor;

/**
 * Runs `fn` inside the single Flow session (creates the browser/client, closes it on all paths).
 * Returns a structured result so callers never see a raw browser exception. Typically backed by
 * `withFlowSession` from flowSession.ts; injectable for tests.
 */
export type FlowSessionRunner = <T>(fn: (session: { client: any; close(): Promise<void> }) => Promise<T>) => Promise<{ ok: boolean; value?: T; reason?: string; error?: string }>;

/**
 * Default factory: adapt the REAL `executeStage` producers to the `StageExecutor` contract.
 *
 * `executeStage` OWNS the canonical stage output path, stage key, and output hash; the
 * `outputPath`/`keys` passed by `runProject` are informational and are intentionally NOT
 * re-derived here (no second source of truth). APPROVAL is never delegated to a producer.
 */
export function createRealStageExecutor(input: StageExecutorFactoryInput): StageExecutor {
  const cfg: StageExecutorConfig = {
    outputsDir: input.outputsDir,
    inputsDir: input.inputsDir,
    productionDir: input.productionDir,
    titleAssets: input.titleAssets,
    bgmPath: input.bgmPath,
  };
  return async (stage: DownstreamStage, _outputPath: string, _keys: { stageKey: string; dependencyHash: string }): Promise<StageExecutionResult> => {
    if (stage === 'APPROVAL') return { ok: false, reason: 'APPROVAL is a human gate, never executed.' };
    const r = await executeStage(stage, cfg, { ffprobePath: input.ffprobePath });
    return r.ok ? { ok: true, outputPath: r.outputPath, outputHash: r.outputHash } : { ok: false, reason: r.reason };
  };
}

// ---------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------

const REQUIRED_PHASES: WorkflowPhase[] = ['CREATED', 'PIPELINE_READY', 'INPUTS_REQUIRED', 'FLOW_REQUIRED', 'PRODUCTION_READY', 'PRODUCTION_RUNNING', 'AWAITING_APPROVAL', 'FAILED'];

/** Build the external-input handoff from `draftManifest` (never hardcoded). */
export function buildRequiredInputsHandoff(pipeline: any, pipelineRaw: string): RequiredInputsHandoff {
  const draft = draftManifest(pipeline, pipelineRaw);
  const a = draft.assets;
  return {
    narration: a.narration.map((x) => ({ scene: Number(x.scene_number), path: x.relative_path })),
    characters: a.characters.map((x) => ({ tag: x.id, path: x.relative_path })),
    backgrounds: a.backgrounds.map((x) => ({ tag: x.id, path: x.relative_path })),
    flowClips: a.flow_clips.map((x) => ({ scene: Number(x.scene_number), path: x.relative_path, required: x.requirement === 'REQUIRED' })),
    music: a.music.map((x) => x.relative_path),
    branding: a.branding.map((x) => x.relative_path),
  };
}

/** Map a runProject result + readiness to a workflow phase (pure). */
export function classifyWorkflowPhase(input: {
  runStatus?: RunProjectResult['status'];
  exists?: boolean;
  pipelineValid?: boolean;
  blockers?: RunBlocker[];
  /** Downstream stages that actually FAILED (vs merely not-yet-run). */
  failedStages?: string[];
}): WorkflowPhase {
  if (input.exists === false) return 'NOT_FOUND';
  if (input.pipelineValid === false) return 'FAILED';
  // STEP-8HD: an explicit Flow-work run that finished with outstanding production blockers is
  // reported as its own phase, not as a generic "inputs required".
  if (input.runStatus === 'FLOW_WORK_COMPLETED_WITH_BLOCKERS') return 'FLOW_WORK_COMPLETED_WITH_BLOCKERS';
  if ((input.blockers ?? []).length > 0) {
    const cats = new Set((input.blockers ?? []).map((b) => b.category));
    if (cats.size === 1 && cats.has('flow-clips')) return 'FLOW_REQUIRED';
    return 'INPUTS_REQUIRED';
  }
  if (input.runStatus === 'COMPLETED_TO_APPROVAL') return 'AWAITING_APPROVAL';
  if (input.runStatus === 'SCENE_SCOPE_COMPLETED') return 'SCENE_SCOPE_COMPLETED';
  if (input.runStatus === 'SCENE_SCOPE_INCOMPLETE') return 'SCENE_SCOPE_INCOMPLETE';
  if ((input.failedStages ?? []).length > 0) return 'FAILED';
  if (input.runStatus === 'PERMANENT_FAILURE') return 'FAILED';
  // No blockers: either fully produced (AWAITING_APPROVAL, above) or ready to produce.
  // A merely "not yet run" chain is PRODUCTION_READY, not a failure.
  return 'PRODUCTION_READY';
}

/**
 * Validate a scoped scene selection (STEP-8GQ). Fail closed on empty/invalid/duplicate/unknown
 * scene numbers. Returns a deterministic ascending, de-duplicated-verified list.
 */
export function validateSceneSelection(only: unknown, pipeline: any): { ok: true; scenes: number[] } | { ok: false; reason: string } {
  if (!Array.isArray(only) || only.length === 0) return { ok: false, reason: 'Scene selection is empty.' };
  const valid = new Set<number>((pipeline?.scenes ?? []).map((s: any) => Number(s?.scene_number)).filter((n: number) => Number.isInteger(n)));
  const seen = new Set<number>();
  for (const raw of only) {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) return { ok: false, reason: `Scene selection contains an invalid number: ${JSON.stringify(raw)}.` };
    if (!valid.has(raw)) return { ok: false, reason: `Scene ${raw} does not exist in the pipeline.` };
    if (seen.has(raw)) return { ok: false, reason: `Scene selection contains a duplicate: ${raw}.` };
    seen.add(raw);
  }
  return { ok: true, scenes: [...seen].sort((a, b) => a - b) };
}

/** Never claim success on an unreadable/empty pipeline. */
export function validatePipelineShape(pipeline: any): { ok: boolean; reason?: string } {  if (!pipeline || typeof pipeline !== 'object') return { ok: false, reason: 'pipeline is not an object' };
  if (!Array.isArray(pipeline.scenes) || pipeline.scenes.length === 0) return { ok: false, reason: 'pipeline has no scenes' };
  for (const s of pipeline.scenes) {
    if (typeof s?.scene_number !== 'number') return { ok: false, reason: 'scene missing scene_number' };
    if (!String(s?.background_tag ?? '').trim()) return { ok: false, reason: `scene ${s.scene_number} missing background_tag` };
  }
  return { ok: true };
}

async function readPipelineRaw(pipelineFile: string): Promise<string | null> {
  return fsp.readFile(pipelineFile, 'utf8').catch(() => null);
}

/** Extract the actual failed downstream stages from a runProject result (never inferred). */
function failedStagesOf(production: RunProjectResult): string[] {
  return (production.orchestration?.downstream?.failedStages ?? []) as string[];
}

/** Compute the current approval verdict (read-only; never approves). */
async function approvalFor(opts: WorkflowOptions & { projectId: string }, paths: ProjectPaths): Promise<{ status: 'APPROVED' | 'NOT_APPROVED' | 'STALE_APPROVAL'; record?: ApprovalRecord; finalOutputHash?: string; reason?: string }> {
  const pipeline = await loadPipeline(paths);
  if (!pipeline) return { status: 'NOT_APPROVED', reason: 'no pipeline' };
  const verdict = await evaluateApproval({
    projectId: paths.projectId, outputsRoot: paths.outputsRoot, outputsDir: paths.outputsDir, inputRoot: paths.inputRoot, pipeline, ffprobePath: opts.ffprobePath,
    stageInputs: opts.stageInputs,
    inspectProject: opts.inspectProject,
  });
  if (verdict.status === 'APPROVED') return { status: 'APPROVED', record: verdict.record, finalOutputHash: verdict.finalOutputHash };
  if (verdict.status === 'STALE_APPROVAL') return { status: 'STALE_APPROVAL', record: verdict.record, reason: verdict.reason };
  return { status: 'NOT_APPROVED', reason: verdict.reason };
}

/** Report whether a project's durable evidence exists (never creates anything). */
export async function projectExists(paths: ProjectPaths): Promise<boolean> {
  return fsp.stat(paths.pipelineFile).then((s) => s.isFile()).catch(() => false);
}

/**
 * Invoke the Flow boundary. Only called from `resume` when Flow is explicitly enabled
 * (`runFlow`) — status and default resume never reach here, guaranteeing zero credit.
 */
async function invokeFlow(
  opts: WorkflowOptions & { projectId: string },
  paths: ProjectPaths,
): Promise<{ flow?: { status?: string; ok?: boolean; reason?: string; completed?: number[]; blockers?: string[] }; phase?: WorkflowPhase }> {
  if (!opts.flowRunner) return {};
  const outputDir = opts.flowOutputDir ?? paths.outputsDir;
  try {
    const r = await opts.flowRunner({
      projectId: paths.projectId,
      pipelineFile: paths.pipelineFile,
      outputDir,
      inputRoot: opts.flowInputRoot ?? paths.inputRoot,
      outputsRoot: paths.outputsRoot,
      allowGeneration: opts.runFlow === true,
      ffprobePath: opts.ffprobePath,
    });
    const phase: WorkflowPhase | undefined =
      r.status === 'FLOW_REQUIRED' ? 'FLOW_REQUIRED'
      : r.status === 'FLOW_MEDIA_RECOVERY_REQUIRED' ? 'INPUTS_REQUIRED'
      : r.status === 'COMPLETED' ? undefined
      : r.ok === false ? 'FAILED'
      : undefined;
    return { flow: { status: r.status, ok: r.ok, reason: r.reason, completed: r.completed, blockers: r.blockers }, phase };
  } catch (e: any) {
    return { flow: { status: 'RECOVERABLE_FAILURE', ok: false, reason: String(e?.message ?? e).slice(0, 200) } };
  }
}

// ---------------------------------------------------------------------------------------
// Workflow API
// ---------------------------------------------------------------------------------------

/**
 * Read-only workflow status. NEVER creates, NEVER executes, NEVER calls Flow.
 */
export async function projectWorkflowStatus(opts: WorkflowOptions & { projectId: string }): Promise<WorkflowResult> {
  const paths = resolveProjectPaths({ projectId: opts.projectId, projectsRoot: opts.projectsRoot, inputsRoot: opts.inputsRoot, outputsRoot: opts.outputsRoot });
  const projectRoot = path.dirname(paths.pipelineFile);
  const exists = await projectExists(paths);
  if (!exists) {
    return { projectId: paths.projectId, projectPath: paths.pipelineFile, projectRoot, status: 'NOT_FOUND', phase: 'NOT_FOUND', blockers: [], completed: [], nextAction: 'No project found; use "create" to start a new one.', resumable: false };
  }
  const pipeline = await loadPipeline(paths);
  const shaped = validatePipelineShape(pipeline);
  if (!shaped.ok) {
    return { projectId: paths.projectId, projectPath: paths.pipelineFile, projectRoot, status: 'PERMANENT_FAILURE', phase: 'FAILED', blockers: [{ category: 'other', detail: shaped.reason ?? 'invalid pipeline' }], completed: [], nextAction: 'Regenerate the pipeline (story boundary).', resumable: false, reason: shaped.reason };
  }
  const raw = (await readPipelineRaw(paths.pipelineFile)) ?? '';
  const handoff = buildRequiredInputsHandoff(pipeline, raw);
  // Readiness is derived by runProject's read-only path (dryRun, no lock, no writes).
  const production = await runProject({ projectId: paths.projectId, projectsRoot: opts.projectsRoot, inputsRoot: opts.inputsRoot, outputsRoot: opts.outputsRoot, ffprobePath: opts.ffprobePath, dryRun: true });
  const approval = await approvalFor(opts, paths);
  // When the project is render-ready, derive downstream states READ-ONLY so the approval gate is
  // reported accurately (AWAITING_APPROVAL / COMPLETED). Pure inspection; no writes, no Flow.
  let runStatus = production.status;
  let failedStages: string[] = failedStagesOf(production);
  if (production.blockers.length === 0) {
    try {
      const inspect = opts.inspectProject ?? (async (args: any) => (await import('./productionOrchestrator.js')).inspectProject(args));
      const report = await inspect({ pipeline, projectId: paths.projectId, inputRoot: paths.inputRoot, outputsDir: paths.outputsDir, outputsRoot: paths.outputsRoot, ffprobePath: opts.ffprobePath, stageInputs: opts.stageInputs, readOnly: true });
      const ds = report?.downstream?.states ?? {};
      if (['EDIT', 'MIX', 'BED', 'TITLE'].every((s) => ds[s] === 'CURRENT')) runStatus = 'COMPLETED_TO_APPROVAL';
      else if ((report?.downstream?.failedStages ?? []).length > 0) { runStatus = 'RECOVERABLE_FAILURE'; failedStages = report?.downstream?.failedStages ?? []; }
    } catch { /* inspection is best-effort; keep the dryRun status */ }
  }
  let phase = classifyWorkflowPhase({ runStatus, exists: true, pipelineValid: true, blockers: production.blockers, failedStages });
  // Approval only reshapes AWAITING_APPROVAL; it never causes the run to approve anything.
  if (phase === 'AWAITING_APPROVAL' && approval.status === 'APPROVED') phase = 'COMPLETED';
  return {
    projectId: paths.projectId,
    projectPath: paths.pipelineFile,
    projectRoot,
    status: runStatus,
    phase,
    blockers: production.blockers,
    completed: production.completed,
    nextAction: production.nextAction,
    resumable: true,
    requiredInputs: handoff,
    production,
    approval,
  };
}

/**
 * CREATE a NEW project workflow. Fails safely on any collision; NEVER resumes an existing
 * project. The story/pipeline itself is produced ONLY through the injected generator
 * boundary (an external provider dependency).
 */
export async function createProjectWorkflow(opts: WorkflowOptions & {
  title: string;
  concept?: string;
  durationMinutes?: number;
  scenes?: number;
  model?: string;
  /** Optional explicit id (tests). When absent, one is allocated (collision-free). */
  projectId?: string;
}): Promise<WorkflowResult> {
  const title = String(opts.title ?? '').trim();
  if (!title) throw new Error('createProjectWorkflow requires a non-empty title.');

  // 1. Allocate a collision-free, path-safe project id (existing hardened logic).
  let projectId: string;
  let paths: ProjectPaths;
  if (opts.projectId) {
    paths = resolveProjectPaths({ projectId: opts.projectId, projectsRoot: opts.projectsRoot, inputsRoot: opts.inputsRoot, outputsRoot: opts.outputsRoot });
    projectId = paths.projectId;
  } else {
    const alloc = await allocateProjectId({ title, projectsRoot: opts.projectsRoot, inputsRoot: opts.inputsRoot, outputsRoot: opts.outputsRoot });
    if (!alloc.ok || !alloc.paths) return { projectId: '', projectPath: '', projectRoot: '', status: 'FAILED', phase: 'FAILED', blockers: [{ category: 'other', detail: alloc.reason ?? 'project id allocation failed' }], completed: [], nextAction: 'Retry with a different title.', resumable: false, reason: alloc.reason };
    projectId = alloc.projectId; paths = alloc.paths;
  }
  const projectRoot = path.dirname(paths.pipelineFile);

  // 2. COLLISION is a hard, safe failure — CREATE must never overwrite an existing project.
  if (await projectExists(paths)) {
    return { projectId, projectPath: paths.pipelineFile, projectRoot, status: 'FAILED', phase: 'FAILED', blockers: [{ category: 'other', detail: `project "${projectId}" already exists; refusing to regenerate.` }], completed: [], nextAction: 'Use resume for an existing project, or choose another title.', resumable: false, reason: 'collision' };
  }

  // 3. Story boundary is REQUIRED and pluggable. Never fake it.
  if (!opts.pipelineGenerator) {
    return { projectId, projectPath: paths.pipelineFile, projectRoot, status: 'FAILED', phase: 'FAILED', blockers: [{ category: 'other', detail: 'no pipeline generator configured (external story provider boundary).' }], completed: [], nextAction: 'Configure the story/pipeline generator (e.g. OPENAI_API_KEY/GROQ_API_KEY).', resumable: false, reason: 'no-generator' };
  }

  await fsp.mkdir(projectRoot, { recursive: true });
  await fsp.mkdir(paths.inputRoot, { recursive: true });
  await fsp.mkdir(paths.outputsDir, { recursive: true });

  // 4. Invoke the story boundary and verify a real pipeline was produced.
  let generatedFile: string;
  try {
    const r = await opts.pipelineGenerator({ projectId, projectDir: projectRoot, pipelineFile: paths.pipelineFile, title, concept: opts.concept, durationMinutes: opts.durationMinutes, scenes: opts.scenes, model: opts.model });
    generatedFile = r?.pipelineFile ?? paths.pipelineFile;
  } catch (e: any) {
    return { projectId, projectPath: paths.pipelineFile, projectRoot, status: 'RECOVERABLE_FAILURE', phase: 'FAILED', blockers: [{ category: 'other', detail: `story generation failed: ${String(e?.message ?? e).slice(0, 200)}` }], completed: [], nextAction: 'Retry story generation (provider/transient).', resumable: true, reason: 'generator-failed' };
  }

  const pipeline = await loadPipeline(paths);
  const shaped = validatePipelineShape(pipeline);
  if (!shaped.ok) {
    return { projectId, projectPath: paths.pipelineFile, projectRoot, status: 'PERMANENT_FAILURE', phase: 'FAILED', blockers: [{ category: 'other', detail: `generated pipeline is invalid: ${shaped.reason}` }], completed: [], nextAction: 'Fix the story generator output.', resumable: false, reason: shaped.reason };
  }

  // 5. Report the required external inputs via the read-only readiness path.
  const status = await projectWorkflowStatus({ ...opts, projectId });
  return { ...status, status: status.status, completed: ['pipeline created', ...status.completed], nextAction: status.nextAction };
}

/**
 * RESUME an EXISTING project. NEVER regenerates the story/pipeline. Runs production
 * only through the existing `runProject` boundary. Never calls Flow.
 */
export async function resumeProjectWorkflow(opts: WorkflowOptions & { projectId: string }): Promise<WorkflowResult> {
  const paths = resolveProjectPaths({ projectId: opts.projectId, projectsRoot: opts.projectsRoot, inputsRoot: opts.inputsRoot, outputsRoot: opts.outputsRoot });
  const projectRoot = path.dirname(paths.pipelineFile);
  const exists = await projectExists(paths);
  if (!exists) {
    return { projectId: paths.projectId, projectPath: paths.pipelineFile, projectRoot, status: 'NOT_FOUND', phase: 'NOT_FOUND', blockers: [], completed: [], nextAction: 'No project found; use "create" first.', resumable: false, reason: 'not-found' };
  }
  const pipeline = await loadPipeline(paths);
  const shaped = validatePipelineShape(pipeline);
  if (!shaped.ok) {
    return { projectId: paths.projectId, projectPath: paths.pipelineFile, projectRoot, status: 'PERMANENT_FAILURE', phase: 'FAILED', blockers: [{ category: 'other', detail: `pipeline invalid: ${shaped.reason}` }], completed: [], nextAction: 'Regenerate the pipeline (story boundary).', resumable: false, reason: shaped.reason };
  }
  const raw = (await readPipelineRaw(paths.pipelineFile)) ?? '';
  const handoff = buildRequiredInputsHandoff(pipeline, raw);
  // Approval verdict (read-only; never approves). Drives the APPROVAL stage and the reported
  // terminal phase, and is surfaced on the result for the publish boundary.
  const approval = await approvalFor(opts, paths);
  const approvedNow = approval.status === 'APPROVED';

  // STEP-8GQ: scoped scene execution. Validate the selection against THIS pipeline (project
  // isolation), fail closed, and normalize to a deterministic ascending list.
  let scopedScenes: number[] | undefined;
  if (opts.only !== undefined) {
    const sel = validateSceneSelection(opts.only, pipeline);
    if (!sel.ok) {
      return { projectId: paths.projectId, projectPath: paths.pipelineFile, projectRoot, status: 'PERMANENT_FAILURE', phase: 'FAILED', blockers: [{ category: 'other', detail: `invalid scene selection: ${sel.reason}` }], completed: [], nextAction: 'Provide a valid, non-duplicate, existing scene selection.', resumable: false, reason: sel.reason };
    }
    scopedScenes = sel.scenes;
  }

  // CREDIT SAFETY (STEP-8GQ): before the broad FlowRunner or any session, determine whether the
  // SELECTED scenes actually need Flow work. A locally-valid scene must never open a browser.
  let scopedFlow: Awaited<ReturnType<typeof invokeFlow>> = {};
  let scopedNeedsFlowWork = false;
  if (scopedScenes) {
    const needs = await classifyFlowNeeds({ pipeline, inputRoot: paths.inputRoot, ffprobePath: opts.ffprobePath });
    const pick = (arr: number[]) => arr.filter((n) => scopedScenes!.includes(n));
    const scopedNeeds = { needsGeneration: pick(needs.needsGeneration), needsDownload: pick(needs.needsDownload), needsRecovery: pick(needs.needsRecovery) };
    scopedNeedsFlowWork = scopedNeeds.needsGeneration.length > 0 || scopedNeeds.needsDownload.length > 0 || scopedNeeds.needsRecovery.length > 0;
    if (scopedNeeds.needsRecovery.length > 0) {
      scopedFlow = { flow: { status: 'FLOW_MEDIA_RECOVERY_REQUIRED', ok: false, reason: `scene(s) ${scopedNeeds.needsRecovery.join(', ')} are committed in Flow but have no locally available clip; supply the local media.`, blockers: [`flow-media-recovery: ${scopedNeeds.needsRecovery.join(', ')}`] }, phase: 'INPUTS_REQUIRED' };
    } else if (scopedNeedsFlowWork && opts.runFlow === true) {
      scopedFlow = { flow: { status: 'FLOW_REQUIRED', ok: false, reason: `scoped scene(s) ${[...scopedNeeds.needsGeneration, ...scopedNeeds.needsDownload].join(', ')} still require Flow work.`, blockers: [`flow-required: ${[...scopedNeeds.needsGeneration, ...scopedNeeds.needsDownload].join(', ')}`] } };
    }
  }

  // Flow strategy selection (STEP-8GO). Exactly ONE strategy runs, so the single Flow session
  // lock is never acquired twice:
  //   · interactive session path (flowSessionRunner): the Flow session owns the browser and the
  //     SceneExecutor receives session.client. The CLI FlowRunner is NOT invoked.
  //   · CLI path (flowRunner): the 8GM FlowRunner owns the lock and runs the resumable CLI.
  // SCOPED runs NEVER use the broad FlowRunner (it would process the whole project), and a
  // session is only opened when the selected scenes genuinely need Flow work.
  const useSession = opts.runFlow === true && !!opts.flowSessionRunner && (!scopedScenes || scopedNeedsFlowWork);
  let flowResult: Awaited<ReturnType<typeof invokeFlow>> = scopedFlow;
  if (opts.runFlow === true && !useSession && !scopedScenes) {
    flowResult = await invokeFlow(opts, paths);
  }

  // Production handoff: build the stage executor (injected factory wins; else the REAL one).
      // STEP-8GQ: Flow execution is enabled whenever an interactive Flow session was ACTUALLY
      // opened — including a SCOPED one (`--only N --run-flow --flow-session`). A scoped Flow
      // generation used to be unreachable: `flowExecutionEnabled` was forced false whenever a
      // scene scope was present, so `flowEligibleSet` stayed empty, `canExecute` could never be
      // satisfied for a scene that BY DEFINITION has a missing Flow clip, and the SceneExecutor
      // was never called. `determineWorkSet` still AND-gates on `onlyScenes`, so exactly the
      // selected scenes run; without a session (the zero-credit default) this stays false.
  const stageFactoryImpl = opts.stageExecutorFactory ?? createRealStageExecutor;
  const stageExecutor = stageFactoryImpl({
    projectId: paths.projectId,
    outputsDir: paths.outputsDir,
    inputsDir: paths.inputRoot,
    productionDir: opts.productionDir ?? process.cwd(),
    titleAssets: opts.titleAssets,
    bgmPath: opts.bgmPath,
    ffprobePath: opts.ffprobePath,
  });

  // Build the scene executor for a given Flow client (may be undefined for local-only runs).
  // An explicitly injected `sceneExecutor` always wins (tests / future providers).
  const sceneFactory = opts.sceneExecutorFactory ?? createRealSceneExecutor;
  const runProduction = async (sceneFlowClient: any) => {
    const sceneExecutor: SceneExecutor | undefined = opts.sceneExecutor ?? ((opts.sceneExecutorFactory || sceneFlowClient)
      ? sceneFactory({
          projectId: paths.projectId,
          inputRoot: paths.inputRoot,
          outputsDir: paths.outputsDir,
          outputsRoot: paths.outputsRoot,
          pipeline,
          allowGeneration: opts.runFlow === true,
          ffprobePath: opts.ffprobePath,
          flow: sceneFlowClient,
          sceneLocalAuthorization: opts.sceneLocalAuthorization ?? null,
        })
      : undefined);
    return runProject({ projectId: paths.projectId, projectsRoot: opts.projectsRoot, inputsRoot: opts.inputsRoot, outputsRoot: opts.outputsRoot, ffprobePath: opts.ffprobePath, host: opts.host, logRetention: opts.logRetention, logMaxBytes: opts.logMaxBytes, stageExecutor, sceneExecutor, onlyScenes: scopedScenes, stageInputs: opts.stageInputs, approved: approvedNow, flowExecutionEnabled: useSession === true });
  };

  // Execute production — inside the Flow session when that strategy is selected.
  let production: RunProjectResult;
  let sessionReason: string | undefined;
  if (useSession) {
    const session = await opts.flowSessionRunner!((s) => runProduction(s.client));
    if (!session.ok || !session.value) {
      // Session/lock/creation failure: fail closed. No production is attempted, no Flow work is
      // recorded, and no checkpoint/clip is fabricated.
      return {
        projectId: paths.projectId,
        projectPath: paths.pipelineFile,
        projectRoot,
        status: 'RECOVERABLE_FAILURE',
        phase: 'FAILED',
        blockers: [{ category: 'other', detail: session.reason ?? 'Flow session failed.' }],
        completed: [],
        nextAction: 'Flow session could not start; retry once the Flow profile is available.',
        resumable: true,
        reason: session.reason,
        flow: { status: 'RECOVERABLE_FAILURE', ok: false, reason: session.reason },
        requiredInputs: handoff,
      };
    }
    production = session.value;
    sessionReason = session.reason;
  } else {
    production = await runProduction(opts.sceneFlowClient);
  }

  let phase = classifyWorkflowPhase({ runStatus: production.status, exists: true, pipelineValid: true, blockers: production.blockers, failedStages: failedStagesOf(production) });
  // A non-COMPLETED Flow phase is authoritative for reporting when Flow was evaluated.
  if (flowResult.phase) phase = flowResult.phase;
  // Approval only reshapes the terminal phase; it never auto-approves or publishes.
  if (phase === 'AWAITING_APPROVAL' && approval.status === 'APPROVED') phase = 'COMPLETED';
  return {
    projectId: paths.projectId,
    projectPath: paths.pipelineFile,
    projectRoot,
    status: production.status,
    phase,
    blockers: production.blockers,
    completed: production.completed,
    nextAction: sessionReason ?? flowResult.flow?.reason ?? production.nextAction,
    resumable: production.resumable,
    requiredInputs: handoff,
    production,
    flow: flowResult.flow,
    approval,
    ...(scopedScenes ? { scope: { scenes: scopedScenes, executed: (production.orchestration?.executedScenes ?? []) as number[], failed: (production.orchestration?.failedScenes ?? []) as number[] } } : {}),
  };
}

/** Human-facing one-screen summary of a workflow result. */
export function renderWorkflowReport(r: WorkflowResult): string {
  const lines: string[] = [];
  lines.push(`project:  ${r.projectId || '(none)'}`);
  lines.push(`status:   ${r.status}`);
  lines.push(`phase:    ${r.phase}`);
  if (r.scope) lines.push(`scope:    scene(s) ${r.scope.scenes.join(', ')} (executed ${r.scope.executed.join(', ') || '-'}; failed ${r.scope.failed.join(', ') || '-'})`);
  if (r.approval) lines.push(`approval: ${r.approval.status}${r.approval.reason ? ` (${r.approval.reason})` : ''}`);
  lines.push(`path:     ${r.projectPath || '(none)'}`);
  lines.push(`next:     ${r.nextAction}`);
  if (r.completed.length) lines.push(`done:     ${r.completed.join('; ')}`);
  for (const b of r.blockers) lines.push(`  blocker [${b.category}]: ${b.detail}`);
  if (r.phase === 'INPUTS_REQUIRED' || r.phase === 'FLOW_REQUIRED') {
    const h = r.requiredInputs;
    if (h) {
      lines.push('  required external inputs:');
      if (h.narration.length) lines.push(`    narration:   scene ${h.narration.map((n) => n.scene).join(', ')}`);
      if (h.characters.length) lines.push(`    characters:  ${h.characters.map((c) => c.tag).join(', ')}`);
      if (h.backgrounds.length) lines.push(`    backgrounds: ${h.backgrounds.map((b) => b.tag).join(', ')}`);
      const clips = h.flowClips.filter((c) => c.required);
      if (clips.length) lines.push(`    flow clips:  scene ${clips.map((c) => c.scene).join(', ')}`);
      if (h.music.length) lines.push(`    music:       ${h.music.join(', ')}`);
      if (h.branding.length) lines.push(`    branding:    ${h.branding.join(', ')}`);
    }
  }
  return lines.join('\n');
}

export { REQUIRED_PHASES };
