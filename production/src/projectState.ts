/**
 * Project-level checkpoint state machine (STEP-8DF).
 *
 * The project state is DERIVED from validated scene/input state (8DE `sceneState.ts`) and from
 * already-existing scene outputs. It is NOT a second source of truth for pipeline item status —
 * `pipeline.json` remains authoritative for that, and this file never writes to it.
 *
 * Persistence is atomic (temp sibling + rename), matching `runner.ts`/`reviewState.ts`.
 * A missing/malformed/wrong-schema/wrong-project state file is IGNORED and the state is
 * re-derived — corruption can never make an output appear current.
 *
 * No rendering, no Flow, no Chrome. Pure derivation + safe persistence.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { inspectProjectScenes, RENDERER_CONTRACT_VERSION, type SceneInputInspection, type RenderMode } from './sceneState.js';
import { validateVideoClip } from './videoClip.js';
import { computeFileSha256 } from './inputManifest.js';
import { assertSafeProjectId } from './inputManifest.js';

export const PROJECT_STATE_SCHEMA_VERSION = 1;

/** Project-level states (8DD machine). */
export const PROJECT_STATES = [
  'WAITING_FOR_INPUTS', 'INPUTS_INVALID', 'READY_FOR_RENDER', 'RENDERING',
  'RENDERED', 'EDITING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED',
] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

/** Active processing states from which FAILED is legal. */
const ACTIVE_STATES: ProjectState[] = ['READY_FOR_RENDER', 'RENDERING', 'RENDERED', 'EDITING'];

/**
 * Legal forward transitions. COMPLETED is reachable ONLY from APPROVED approval.
 *
 * WAITING_FOR_INPUTS -> FAILED is legal: a downstream stage can be genuinely ATTEMPTED and fail
 * while the project is also waiting on a missing input (the orchestrator gates stage execution on
 * `allScenesCurrent`, which is independent of readiness). Recording that run as FAILED is the
 * honest outcome; recording it as merely WAITING_FOR_INPUTS would hide a real failure. A project
 * that is ONLY waiting — with no attempted failure — still resolves to WAITING_FOR_INPUTS and
 * never takes this edge.
 */
export const LEGAL_TRANSITIONS: Record<ProjectState, ProjectState[]> = {
  WAITING_FOR_INPUTS: ['INPUTS_INVALID', 'READY_FOR_RENDER', 'FAILED'],
  INPUTS_INVALID: ['WAITING_FOR_INPUTS', 'READY_FOR_RENDER'],
  READY_FOR_RENDER: ['RENDERING', 'WAITING_FOR_INPUTS', 'INPUTS_INVALID', 'FAILED'],
  RENDERING: ['RENDERED', 'READY_FOR_RENDER', 'INPUTS_INVALID', 'FAILED'],
  RENDERED: ['EDITING', 'READY_FOR_RENDER', 'FAILED'],
  EDITING: ['AWAITING_APPROVAL', 'READY_FOR_RENDER', 'RENDERED', 'FAILED'],
  AWAITING_APPROVAL: ['COMPLETED', 'EDITING', 'READY_FOR_RENDER'],
  COMPLETED: [],
  FAILED: ['WAITING_FOR_INPUTS', 'INPUTS_INVALID', 'READY_FOR_RENDER', 'RENDERING', 'RENDERED', 'EDITING'],
};

export type OutputState = 'CURRENT' | 'STALE' | 'STALE_UNKNOWN' | 'MISSING_OUTPUT' | 'INVALID_OUTPUT';

export interface SceneStateRecord {
  readiness: string;
  render_mode: RenderMode;
  duration_seconds: number | null;
  duration_source: string;
  render_key: string;
  output_path: string | null;
  output_hash: string | null;
  output_state: OutputState;
}

export interface FinalStageState {
  edit_state: OutputState | 'NOT_STARTED';
  mix_state: OutputState | 'NOT_STARTED';
  bed_state: OutputState | 'NOT_STARTED';
  title_state: OutputState | 'NOT_STARTED';
  output_path: string | null;
  output_hash: string | null;
}

/** Max characters retained from a producer-supplied failure reason (bounds the persisted file). */
export const FAILURE_REASON_MAX = 300;
/** Max failure entries retained in one persisted record (bounds the persisted file). */
export const FAILURES_MAX = 50;

/**
 * ONE failure from the most recent run that actually attempted work.
 *
 * `target` is the stage name (e.g. `MIX`) for a stage failure, or the scene number as a string
 * for a scene failure. `reason` is OPTIONAL: a producer that fails without a message still yields
 * a complete record (category + identifier).
 *
 * There is deliberately NO "recoverable" flag: the execution result model (`ExecutionResult`)
 * exposes only `ok` and `reason`, and recoverability is a RUN-level classification
 * (`RECOVERABLE_FAILURE` lives in projectOrchestrator/flowRunnerAdapter, not on a per-result
 * basis). Inventing a per-failure flag here would duplicate a state machine that does not exist.
 */
export interface FailureRecord {
  category: 'stage' | 'scene';
  target: string;
  reason?: string;
}

/** Failure provenance for the latest attempted run that failed. Absent when nothing failed. */
export interface FailureProvenance {
  /** ISO-8601 timestamp of the run that produced these failures. */
  at: string;
  failures: FailureRecord[];
}

/**
 * Secret redaction pattern. Exported and SHARED so the persisted state reason and the bounded
 * stage-diagnostic writer cannot drift apart.
 *
 * The leading `authorization` alternative is deliberate. The generic value pattern `\S+` stops at
 * the first space, so for `Authorization: Bearer <credential>` it matched only the SCHEME and left
 * the credential in cleartext. Here the optional scheme word is consumed together with the value,
 * so the whole credential is removed. Forms without a scheme (`Authorization: <credential>`) are
 * still covered by the optional group being absent.
 *
 * Everything after the alternation is UNCHANGED from the previous pattern, so `api_key`,
 * `token`, `access_token`, `refresh_token`, `auth_token`, `secret`, `password`, `passwd`, `cookie`
 * and a bare `bearer=` behave exactly as before. Order matters: the specific `authorization`
 * alternative is tried first.
 */
export const SECRET_REDACTION_RE = /authorization\s*[:=]\s*(?:[A-Za-z][A-Za-z0-9_-]*\s+)?\S+|(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|secret|password|passwd|cookie|authorization|bearer)\s*[:=]\s*\S+/gi;

/**
 * Make a producer-supplied error safe and small enough to persist:
 *   · non-string / empty            -> undefined (the record keeps category + target)
 *   · first line only               -> stack traces are never stored verbatim
 *   · secret-looking values         -> replaced with `[redacted]`
 *   · collapsed whitespace, capped  -> bounded persisted size
 */
export function sanitizeFailureReason(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const firstLine = raw.split(/\r?\n/)[0] ?? '';
  const redacted = firstLine
    .replace(SECRET_REDACTION_RE, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!redacted) return undefined;
  return redacted.length > FAILURE_REASON_MAX ? `${redacted.slice(0, FAILURE_REASON_MAX - 1)}…` : redacted;
}

export interface ProjectStateRecord {
  schema_version: number;
  project_id: string;
  state: ProjectState;
  generated_at: string;
  renderer_contract_version: string;
  scenes: Record<string, SceneStateRecord>;
  final: FinalStageState;
  /** Upstream dependency hash covering scene outputs (drives downstream stages). */
  scene_set_hash: string;
  /**
   * OPTIONAL failure provenance for the most recent run that actually attempted and failed work.
   *
   * BACKWARD COMPATIBLE: files written by older builds simply have no `failures` key and load
   * normally (`loadProjectState` validates only schema_version/project_id/state/scenes).
   *
   * LIFECYCLE: it describes ONLY the latest run that failed. A run that attempts no failure omits
   * the field entirely, which is what clears stale provenance. It is never populated by ordinary
   * state derivation, and a read-only status inspection never writes at all, so a recorded failure
   * survives any number of `status` calls byte-for-byte.
   */
  failures?: FailureProvenance;
}

/** Pure: is a transition legal? */
export function isLegalTransition(from: ProjectState, to: ProjectState): boolean {
  if (from === to) return true;
  return (LEGAL_TRANSITIONS[from] ?? []).includes(to);
}

/** Pure: assert a transition; throws on an illegal jump. */
export function assertLegalTransition(from: ProjectState, to: ProjectState): void {
  if (!PROJECT_STATES.includes(to)) throw new Error(`Unknown project state "${String(to)}".`);
  if (!isLegalTransition(from, to)) throw new Error(`Illegal project state transition ${from} -> ${to}.`);
}

// ---------------------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------------------

export interface DeriveOptions {
  pipeline: any;
  /** Absolute project input root. */
  inputRoot: string;
  /** Directory containing existing scene outputs (production/outputs/<id>). */
  outputsDir: string;
  ffprobePath?: string;
  /** Recorded sidecars by scene number (may be empty/absent → conservative). */
  recorded?: Map<number, { render_key?: string; output_hash?: string }>;
  /** Human approval flag. COMPLETED is never derived without it. */
  approved?: boolean;
  /** Downstream stage completion flags (NOT inferred from file existence). */
  stages?: { edit?: boolean; mix?: boolean; bed?: boolean; title?: boolean };
}

export interface SceneDerivation {
  sceneNumber: number;
  inspection: SceneInputInspection;
  outputState: OutputState;
  outputPath: string | null;
  outputHash: string | null;
}

export interface Derivation {
  scenes: SceneDerivation[];
  state: ProjectState;
  sceneSetHash: string;
  counts: { ready: number; waitingBackground: number; waitingCharacter: number; waitingNarration: number; waitingVideo: number; invalid: number };
}

const sceneOutputName = (n: number) => `scene-${String(n).padStart(4, '0')}.mp4`;
const sceneSidecarName = (n: number) => `scene-${String(n).padStart(4, '0')}.json`;

/** Reject any path that would escape the outputs root. */
export function safeOutputPath(outputsDir: string, filename: string): string {
  const root = path.resolve(outputsDir);
  const resolved = path.resolve(root, filename);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Refusing an output path outside ${root}: ${resolved}.`);
  return resolved;
}

/** Read a recorded sidecar (best-effort, never trusted for validation truth). */
export async function readSceneSidecar(outputsDir: string, sceneNumber: number): Promise<{ render_key?: string; output_hash?: string; renderer_contract_version?: string } | null> {
  let file: string;
  try { file = safeOutputPath(outputsDir, sceneSidecarName(sceneNumber)); } catch { return null; }
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch { return null; }
}

/** Atomic sidecar write (temp sibling + rename). */
export async function writeSceneSidecar(outputsDir: string, sceneNumber: number, record: { scene_number: number; render_key: string; output_hash: string; output_path: string; renderer_contract_version: string }): Promise<void> {
  const file = safeOutputPath(outputsDir, sceneSidecarName(sceneNumber));
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
}

/**
 * Classify a scene's output against its current render key. Never infers CURRENT from
 * filename or mtime alone.
 */
export async function classifySceneOutput(d: {
  sceneNumber: number; outputsDir: string; currentRenderKey: string; recorded?: { render_key?: string; output_hash?: string };
  ffprobePath?: string;
}): Promise<{ outputState: OutputState; outputPath: string | null; outputHash: string | null }> {
  let file: string;
  try { file = safeOutputPath(d.outputsDir, sceneOutputName(d.sceneNumber)); } catch { return { outputState: 'INVALID_OUTPUT', outputPath: null, outputHash: null }; }
  const exists = await fsp.stat(file).then((s) => s.isFile()).catch(() => false);
  if (!exists) return { outputState: 'MISSING_OUTPUT', outputPath: file, outputHash: null };

  const clip = await validateVideoClip(file, { ffprobePath: d.ffprobePath });
  if (clip.state !== 'VALID') return { outputState: 'INVALID_OUTPUT', outputPath: file, outputHash: null };

  const outputHash = clip.sha256 ?? null;
  const rec = d.recorded;
  if (!rec || !rec.render_key) return { outputState: 'STALE_UNKNOWN', outputPath: file, outputHash };
  if (rec.render_key !== d.currentRenderKey) return { outputState: 'STALE', outputPath: file, outputHash };
  if (rec.output_hash && outputHash && rec.output_hash !== outputHash) return { outputState: 'INVALID_OUTPUT', outputPath: file, outputHash };
  return { outputState: 'CURRENT', outputPath: file, outputHash };
}

/**
 * Derive the whole project state. Read-only w.r.t. the pipeline and outputs.
 */
export async function deriveProjectState(options: DeriveOptions): Promise<Derivation> {
  const inspections = await inspectProjectScenes(options.pipeline, { inputRoot: options.inputRoot, ffprobePath: options.ffprobePath });
  const scenes: SceneDerivation[] = [];
  for (const s of inspections) {
    const recorded = options.recorded?.get(s.sceneNumber);
    const cls = await classifySceneOutput({
      sceneNumber: s.sceneNumber, outputsDir: options.outputsDir, currentRenderKey: s.renderKey, recorded, ffprobePath: options.ffprobePath,
    });
    scenes.push({ sceneNumber: s.sceneNumber, inspection: s, outputState: cls.outputState, outputPath: cls.outputPath, outputHash: cls.outputHash });
  }

  const counts = {
    ready: inspections.filter((s) => s.readiness === 'READY').length,
    waitingBackground: inspections.filter((s) => s.readiness === 'WAITING_FOR_BACKGROUND').length,
    waitingCharacter: inspections.filter((s) => s.readiness === 'WAITING_FOR_CHARACTER_ASSET').length,
    waitingNarration: inspections.filter((s) => s.readiness === 'WAITING_FOR_NARRATION').length,
    waitingVideo: inspections.filter((s) => s.readiness === 'WAITING_FOR_VIDEO_CLIP').length,
    invalid: inspections.filter((s) => s.readiness === 'INVALID').length,
  };

  const sceneSetHash = (await import('node:crypto')).createHash('sha256')
    .update(scenes.map((s) => `${s.sceneNumber}:${s.inspection.renderKey}:${s.outputHash ?? 'none'}`).join('|'))
    .digest('hex');

  // ---- derive the state ----
  let state: ProjectState;
  const anyInvalid = counts.invalid > 0;
  const anyWaiting = counts.waitingBackground + counts.waitingCharacter + counts.waitingNarration + counts.waitingVideo > 0;
  const allReady = counts.ready === scenes.length && scenes.length > 0;
  const allCurrent = scenes.length > 0 && scenes.every((s) => s.outputState === 'CURRENT');

  if (anyInvalid) state = 'INPUTS_INVALID';
  else if (anyWaiting) state = 'WAITING_FOR_INPUTS';
  else if (allReady && !allCurrent) state = 'READY_FOR_RENDER';
  else if (allCurrent) {
    const stages = options.stages ?? {};
    if (stages.title) state = options.approved ? 'COMPLETED' : 'AWAITING_APPROVAL';
    else if (stages.bed) state = 'EDITING';
    else if (stages.mix) state = 'EDITING';
    else if (stages.edit) state = 'EDITING';
    else state = 'RENDERED';
  } else state = 'READY_FOR_RENDER';

  return { scenes, state, sceneSetHash, counts };
}

/** Build a persistable record from a derivation. */
export function toProjectStateRecord(projectId: string, d: Derivation, final: FinalStageState): ProjectStateRecord {
  const scenes: Record<string, SceneStateRecord> = {};
  for (const s of d.scenes) {
    scenes[String(s.sceneNumber)] = {
      readiness: s.inspection.readiness,
      render_mode: s.inspection.renderMode,
      duration_seconds: s.inspection.durationSeconds,
      duration_source: s.inspection.durationProvenance,
      render_key: s.inspection.renderKey,
      output_path: s.outputPath ? path.basename(s.outputPath) : null,
      output_hash: s.outputHash,
      output_state: s.outputState,
    };
  }
  return {
    schema_version: PROJECT_STATE_SCHEMA_VERSION,
    project_id: projectId,
    state: d.state,
    generated_at: new Date().toISOString(),
    renderer_contract_version: RENDERER_CONTRACT_VERSION,
    scenes,
    final,
    scene_set_hash: d.sceneSetHash,
  };
}

// ---------------------------------------------------------------------------------------
// Persistence (atomic)
// ---------------------------------------------------------------------------------------

/** Path of the project state file inside the outputs root (never escapes it). */
export function projectStatePath(projectId: string, outputsRoot = 'outputs'): string {
  const id = assertSafeProjectId(projectId);
  return path.join(path.resolve(outputsRoot), id, 'state.json');
}

/**
 * Atomically write the state. A valid previous state is never deleted before replacement.
 *
 * Idempotency (8DJ): if the derived state is SEMANTICALLY IDENTICAL to the existing valid
 * state (everything except `generated_at`), the prior file is left untouched and its
 * `generated_at` is preserved — so repeated runs produce no needless churn. `generated_at`
 * never participates in scene/stage validity.
 */
export async function saveProjectState(projectId: string, record: ProjectStateRecord, outputsRoot = 'outputs'): Promise<string> {
  const file = projectStatePath(projectId, outputsRoot);
  const existing = await loadProjectState(projectId, outputsRoot);

  const stripTs = (r: ProjectStateRecord | null): string => {
    if (!r) return '';
    const { generated_at, ...rest } = r as any;
    void generated_at;
    return JSON.stringify(rest);
  };

  const incoming = { ...record };
  if (existing && stripTs(existing) === stripTs(incoming)) {
    // No semantic change: keep the existing file (and its timestamp) exactly as-is.
    incoming.generated_at = existing.generated_at;
    return file;
  }

  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, `${JSON.stringify(incoming, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
  return file;
}

/**
 * Load a persisted state. A missing/malformed/wrong-schema/wrong-project file is IGNORED and
 * returns null so the caller re-derives. Never throws for corruption.
 */
export async function loadProjectState(projectId: string, outputsRoot = 'outputs'): Promise<ProjectStateRecord | null> {
  const file = projectStatePath(projectId, outputsRoot);
  let raw: string;
  try { raw = await fsp.readFile(file, 'utf8'); } catch { return null; }
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.schema_version !== PROJECT_STATE_SCHEMA_VERSION) return null;
  if (String(parsed.project_id) !== String(projectId)) return null;
  if (!PROJECT_STATES.includes(parsed.state)) return null;
  if (!parsed.scenes || typeof parsed.scenes !== 'object') return null;
  return parsed as ProjectStateRecord;
}

/** Recorded render keys from a persisted state (conservative: corrupt → empty). */
export function recordedKeysFrom(state: ProjectStateRecord | null): Map<number, { render_key?: string; output_hash?: string }> {
  const out = new Map<number, { render_key?: string; output_hash?: string }>();
  if (!state || state.renderer_contract_version !== RENDERER_CONTRACT_VERSION) return out; // contract changed → conservative revalidation
  for (const [k, v] of Object.entries(state.scenes ?? {})) {
    const n = Number(k);
    if (Number.isInteger(n) && v && typeof v === 'object') out.set(n, { render_key: (v as any).render_key, output_hash: (v as any).output_hash });
  }
  return out;
}
