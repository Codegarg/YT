/**
 * Top-level project orchestrator (STEP-8GJ).
 *
 * The missing architectural boundary identified in the 8GI audit: ONE entrypoint that
 * coordinates the EXISTING pieces (pipeline → Flow assets/scenes → local clips →
 * input validation → EDIT/MIX/BED/TITLE → approval) with a resumable, fail-closed,
 * credit-safe lifecycle.
 *
 * This module COORDINATES existing APIs; it does not duplicate their logic:
 *   · checkInputs / prodCheck            → readiness + explicit Flow/local state
 *   · sceneFlowWorkflow.processSingleFlowScene → per-scene clip + checkpoint (idempotent)
 *   · productionOrchestrator.orchestrate + stageExecutor → downstream stages
 *   · projectState / downstreamStages    → state + invalidation (reused as-is)
 *   · reviewState                        → human approval gate
 *
 * It NEVER generates Flow content itself, NEVER calls OpenAI/network, NEVER approves,
 * and NEVER publishes. Flow generation/download remain the separate (already-proven)
 * Flow boundary; narration/BGM/branding remain explicit external inputs.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------------------
// Pure helpers (deterministic, testable) — project id, slug, lock decisions, classification
// ---------------------------------------------------------------------------------------

/** Bound on the title slug inside a project id. */
export const PROJECT_SLUG_MAX = 40;

/**
 * Deterministic, filesystem-safe slug for a title. Lowercases, keeps [a-z0-9],
 * collapses everything else to single dashes, trims dashes, and bounds length.
 * Same title → same slug (deterministic).
 */
export function projectSlug(title: unknown, max = PROJECT_SLUG_MAX): string {
  const s = String(title ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, Math.max(1, max))
    .replace(/-+$/g, '');
  return s || 'untitled';
}

/**
 * Build a collision-resistant, traversal-free project id:
 *   youtube-automation-<slug>-<YYYYMMDD-HHmmss>-<suffix>
 * `stamp`/`suffix` are injected for determinism in tests; production passes a real
 * timestamp and a monotonically-increasing suffix (never `Math.random`).
 */
export function buildProjectId(input: { title?: unknown; stamp?: string; suffix?: string } = {}): string {
  const slug = projectSlug(input.title);
  const stamp = String(input.stamp ?? '').trim() || new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const suffix = String(input.suffix ?? '').trim() || String(process.pid);
  const id = `youtube-automation-${slug}-${stamp}-${suffix}`.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  // Defensive: never allow path separators or traversal.
  return id.replace(/\.+/g, '').replace(/-+/g, '-');
}

/** A pid/suffix is unique enough within one host; a per-second stamp disambiguates across runs. */
export function nextUniqueSuffix(existingIds: string[], base: string): string {
  const set = new Set(existingIds.map((x) => String(x)));
  let n = 0;
  while (n < 100000) {
    const candidate = n === 0 ? base : `${base}-${n}`;
    if (!set.has(candidate)) return candidate;
    n += 1;
  }
  throw new Error('nextUniqueSuffix exhausted candidates.');
}

// ---- project lock decisions (pure) ----

export interface ProjectLockRecord { pid?: number; host?: string; acquiredAt?: string; projectId?: string; }
export interface ProjectLockInfo { pid: number; host: string; acquiredAt: string; projectId: string; }

/** Decide whether an existing lock may be STOLEN (stale). Same host + dead pid ⇒ stale. */
export function isLockStale(lock: ProjectLockRecord | undefined | null, opts: { host: string; pidAlive: boolean; nowMs: number; staleAfterMs: number }): boolean {
  if (!lock || typeof lock !== 'object' || !lock.pid) return true;                 // empty/malformed ⇒ treat as free
  if (String(lock.host ?? '') !== opts.host) return false;                          // different host ⇒ never steal blindly
  if (opts.pidAlive) return false;                                                  // owner alive ⇒ never steal
  const acquired = Date.parse(String(lock.acquiredAt ?? ''));
  if (!Number.isFinite(acquired)) return true;                                      // no timestamp ⇒ stale by definition of dead pid
  return opts.nowMs - acquired >= opts.staleAfterMs || true;                        // dead pid on our host ⇒ stale
}

/** Classify lock acquisition outcome. */
export function classifyLockAttempt(existing: ProjectLockRecord | undefined | null, stale: boolean): 'ACQUIRE' | 'OCCUPIED' {
  if (!existing || !(existing as any).pid) return 'ACQUIRE';
  return stale ? 'ACQUIRE' : 'OCCUPIED';
}

// ---- lifecycle + error classification (pure) ----

export type RunStatus =
  | 'WAITING_FOR_INPUTS'      // a legitimate external input is missing (not a failure)
  | 'RECOVERABLE_FAILURE'     // provider/transient or rebuildable stage failure
  | 'PERMANENT_FAILURE'       // malformed pipeline / invalid config (software failure)
  | 'SCENE_SCOPE_COMPLETED'   // scoped scene execution succeeded (STEP-8GQ; NOT whole-project complete)
  | 'SCENE_SCOPE_INCOMPLETE'  // scoped selection did not fully execute (STEP-8GS; explicit incompleteness)
  | 'FLOW_WORK_COMPLETED_WITH_BLOCKERS' // explicit Flow work ran; final production still blocked (STEP-8HD)
  | 'COMPLETED_TO_APPROVAL';  // all stages CURRENT → AWAITING_APPROVAL

export interface RunBlocker { category: 'narration' | 'characters' | 'backgrounds' | 'flow-clips' | 'music' | 'branding' | 'other'; detail: string; }

/** Build precise blockers from a checkInputs-style report (pure). */
export function collectBlockers(diag: {
  flowCommittedLocalMissing?: number[];
  missingNarrationScenes?: number[];
  missingCharacterTags?: string[];
  missingBackgroundTags?: string[];
  missingFlowClipScenes?: number[];
  musicMissing?: boolean;
  brandingMissing?: string[];
} | undefined | null): RunBlocker[] {
  const d = diag ?? {};
  const blockers: RunBlocker[] = [];
  if ((d.missingFlowClipScenes ?? []).length) blockers.push({ category: 'flow-clips', detail: `missing local clip(s) for scene(s) ${d.missingFlowClipScenes!.join(', ')}` });
  if ((d.flowCommittedLocalMissing ?? []).length) blockers.push({ category: 'flow-clips', detail: `committed in Flow but no local media for scene(s) ${d.flowCommittedLocalMissing!.join(', ')}` });
  if ((d.missingNarrationScenes ?? []).length) blockers.push({ category: 'narration', detail: `missing narration for scene(s) ${d.missingNarrationScenes!.join(', ')}` });
  if ((d.missingCharacterTags ?? []).length) blockers.push({ category: 'characters', detail: `missing character asset(s) ${d.missingCharacterTags!.join(', ')}` });
  if ((d.missingBackgroundTags ?? []).length) blockers.push({ category: 'backgrounds', detail: `missing background asset(s) ${d.missingBackgroundTags!.join(', ')}` });
  if (d.musicMissing === true) blockers.push({ category: 'music', detail: 'missing background-music (+ license)' });
  if ((d.brandingMissing ?? []).length) blockers.push({ category: 'branding', detail: `missing branding (${d.brandingMissing!.join(', ')})` });
  return blockers;
}

/**
 * Pure status decision from blockers + downstream state.
 *
 * SAFETY: a stage that actually RAN and failed is a real failure and outranks missing inputs.
 * Before this rule existed the function had no notion of stage failure at all, so any run that
 * also had a missing input reported `WAITING_FOR_INPUTS` and the genuine stage failure was
 * invisible — the operator was told to "supply inputs" about a pipeline that had already broken.
 * `classifyWorkflowPhase` already escalated `failedStages` to FAILED unconditionally, so the two
 * signals disagreed about the same run. Blockers alone still mean WAITING_FOR_INPUTS, which is
 * unchanged behaviour.
 */
export function classifyRunStatus(input: { blockers?: RunBlocker[]; downstreamAllCurrent?: boolean; titleCurrent?: boolean; approved?: boolean; failedStages?: readonly string[] } | undefined | null): RunStatus {
  const d = input ?? {};
  if ((d.failedStages ?? []).length > 0) return 'RECOVERABLE_FAILURE';
  if ((d.blockers ?? []).length > 0) return 'WAITING_FOR_INPUTS';
  if (d.downstreamAllCurrent === true && d.titleCurrent === true) return 'COMPLETED_TO_APPROVAL';
  return 'RECOVERABLE_FAILURE';
}

// ---------------------------------------------------------------------------------------
// Project lock (filesystem, atomic via O_EXCL)
// ---------------------------------------------------------------------------------------

export function projectLockPath(outputsRoot: string, projectId: string): string {
  return path.join(path.resolve(outputsRoot), projectId, '.runproject.lock');
}

async function pidAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return String(e?.code) === 'EPERM'; }
}

export interface LockHandle { path: string; info: ProjectLockInfo; release(): Promise<void>; }
export interface AcquireLockOptions { outputsRoot: string; projectId: string; host?: string; now?: number; staleAfterMs?: number; pidAlive?: (pid: number) => Promise<boolean>; }

/**
 * Acquire the per-project advisory lock. Atomic (O_EXCL). Stale (same-host dead pid)
 * locks are reclaimed; live or cross-host locks fail closed. Never affects other project ids.
 */
export async function acquireProjectLock(opts: AcquireLockOptions): Promise<{ ok: true; handle: LockHandle } | { ok: false; reason: string }> {
  const host = String(opts.host ?? (await (async () => { const os = await import('node:os'); return os.hostname(); })())).trim();
  const now = Number(opts.now ?? Date.now());
  const staleAfterMs = Number(opts.staleAfterMs ?? 6 * 60 * 60 * 1000);
  const checkAlive = opts.pidAlive ?? pidAlive;
  const file = projectLockPath(opts.outputsRoot, opts.projectId);
  await fsp.mkdir(path.dirname(file), { recursive: true });

  const readLock = async (): Promise<ProjectLockRecord | null> => fsp.readFile(file, 'utf8').then((t) => JSON.parse(t)).catch(() => null);
  const tryExclusive = async (): Promise<boolean> => {
    const info: ProjectLockInfo = { pid: process.pid, host, acquiredAt: new Date(now).toISOString(), projectId: opts.projectId };
    try { const h = await fsp.open(file, 'wx'); await h.writeFile(JSON.stringify(info)); await h.close(); return true; } catch (e: any) { if (String(e?.code) === 'EEXIST') return false; throw e; }
  };
  const makeHandle = (info: ProjectLockInfo): LockHandle => ({
    path: file, info,
    release: async () => { const cur = await readLock().catch(() => null); if (cur && cur.pid === process.pid && String(cur.host) === host) await fsp.rm(file, { force: true }).catch(() => {}); },
  });

  // First attempt: atomic create.
  const me: ProjectLockInfo = { pid: process.pid, host, acquiredAt: new Date(now).toISOString(), projectId: opts.projectId };
  if (await tryExclusive()) return { ok: true, handle: makeHandle(me) };

  // Occupied: examine.
  const existing = await readLock();
  const alive = existing?.pid ? await checkAlive(Number(existing.pid)) : false;
  const stale = isLockStale(existing, { host, pidAlive: alive, nowMs: now, staleAfterMs });
  if (classifyLockAttempt(existing, stale) === 'OCCUPIED') {
    return { ok: false, reason: `Project ${opts.projectId} is locked by pid ${existing?.pid} on ${existing?.host} (acquired ${existing?.acquiredAt}).` };
  }
  // Stale: remove then re-acquire atomically.
  await fsp.rm(file, { force: true }).catch(() => {});
  if (await tryExclusive()) return { ok: true, handle: makeHandle(me) };
  return { ok: false, reason: `Project ${opts.projectId} lock is contended; refusing to proceed.` };
}

/** Read lock metadata without acquiring (diagnostics). */
export async function readProjectLock(outputsRoot: string, projectId: string): Promise<ProjectLockRecord | null> {
  return fsp.readFile(projectLockPath(outputsRoot, projectId), 'utf8').then((t) => JSON.parse(t)).catch(() => null);
}

// ---------------------------------------------------------------------------------------
// Async orchestration (create / run / status) — coordinates the EXISTING APIs
// ---------------------------------------------------------------------------------------
import { checkInputs } from './checkInputs.js';
import { classifyFlowEligibility } from './sceneState.js';
import { deriveFlowLocalState } from './flowMediaState.js';
import { assertSafeProjectId } from './inputManifest.js';
import { validateMusicInputs, validateBrandingInputs } from './inputValidator.js';

export interface ProjectPaths { projectId: string; pipelineFile: string; inputsRoot: string; inputRoot: string; outputsRoot: string; outputsDir: string; }

/** Resolve all project paths from {projectsRoot, inputsRoot, outputsRoot}. */
export function resolveProjectPaths(input: { projectId: string; projectsRoot: string; inputsRoot: string; outputsRoot: string }): ProjectPaths {
  const projectId = assertSafeProjectId(input.projectId);
  return {
    projectId,
    pipelineFile: path.join(path.resolve(input.projectsRoot), projectId, 'pipeline.json'),
    inputsRoot: path.resolve(input.inputsRoot),
    inputRoot: path.join(path.resolve(input.inputsRoot), projectId),
    outputsRoot: path.resolve(input.outputsRoot),
    outputsDir: path.join(path.resolve(input.outputsRoot), projectId),
  };
}

/** List existing project ids under the scripting projects root (for uniqueness). */
export async function listProjectIds(projectsRoot: string): Promise<string[]> {
  return fsp.readdir(path.resolve(projectsRoot)).catch(() => [] as string[]);
}

export interface CreateProjectResult { ok: boolean; projectId: string; paths?: ProjectPaths; reason?: string; }

/**
 * Allocate a NEW, collision-free project id (deterministic slug + timestamp + unique suffix).
 * Does NOT create the pipeline (that is the scripting story boundary) and writes nothing.
 */
export async function allocateProjectId(input: { title?: unknown; projectsRoot: string; inputsRoot: string; outputsRoot: string; stamp?: string; suffix?: string }): Promise<CreateProjectResult> {
  let slugBase = buildProjectId({ title: input.title, stamp: input.stamp, suffix: input.suffix });
  // Ensure uniqueness against BOTH projects/ and inputs/ + outputs/ so we never collide.
  const existing = new Set<string>([
    ...(await listProjectIds(input.projectsRoot)),
    ...(await listProjectIds(input.inputsRoot)),
    ...(await listProjectIds(input.outputsRoot)),
  ]);
  // If the fully-built id is taken, append a numeric counter deterministically.
  let candidate = slugBase; let n = 1;
  while (existing.has(candidate)) { candidate = `${slugBase}-${n}`; n += 1; if (n > 100000) return { ok: false, projectId: '', reason: 'project id space exhausted' }; }
  try { assertSafeProjectId(candidate); } catch (e: any) { return { ok: false, projectId: '', reason: String(e?.message ?? e) }; }
  return { ok: true, projectId: candidate, paths: resolveProjectPaths({ projectId: candidate, ...input }) };
}

/** Read the pipeline file if present (never creates it). */
export async function loadPipeline(paths: ProjectPaths): Promise<any | null> {
  return fsp.readFile(paths.pipelineFile, 'utf8').then((t) => JSON.parse(t)).catch(() => null);
}

export interface RunProjectConfig {
  projectId: string;
  projectsRoot: string;
  inputsRoot: string;
  outputsRoot: string;
  ffprobePath?: string;
  /** When true, only derive status; never write state and never execute stages. */
  dryRun?: boolean;
  /** Injected downstream executor (tests). Omit in production → no execution. */
  stageExecutor?: (stage: any, outputPath: string, keys: any) => Promise<any>;
  /** Injected scene executor (tests). Omit in production → no scene rendering. */
  sceneExecutor?: (scene: any, outputPath: string) => Promise<any>;
  stageInputs?: any;
  host?: string;
  /** Bounded run-log retention (STEP-8GK). Defaults to DEFAULT_LOG_RETENTION. */
  logRetention?: number;
  /** Max bytes before the current run log rotates (STEP-8GK). */
  logMaxBytes?: number;
  /**
   * Scoped scene execution (STEP-8GQ). When set, ONLY these validated scene numbers are eligible
   * for scene work; project-wide blockers from unrelated scenes are NOT considered, and
   * downstream stages are never planned/executed for a scoped run.
   */
  onlyScenes?: number[];
  /** Explicit human approval (STEP-8GV). APPROVAL is CURRENT only when this is true. */
  approved?: boolean;
  /**
   * Explicit modern Flow execution (STEP-8HD). When true (and not scoped), scenes that are
   * Flow-eligible (non-Flow prerequisites valid + Flow work required) may be executed via the
   * supplied Flow SceneExecutor even while final production readiness is not yet READY. Only the
   * Flow-media blockers of those scenes are suppressed; all other blockers remain. Absent ⇒
   * behavior unchanged.
   */
  flowExecutionEnabled?: boolean;
}

export interface RunProjectResult {
  projectId: string;
  status: 'WAITING_FOR_INPUTS' | 'RECOVERABLE_FAILURE' | 'PERMANENT_FAILURE' | 'SCENE_SCOPE_COMPLETED' | 'SCENE_SCOPE_INCOMPLETE' | 'FLOW_WORK_COMPLETED_WITH_BLOCKERS' | 'COMPLETED_TO_APPROVAL';
  blockers: RunBlocker[];
  completed: string[];
  nextAction: string;
  resumable: boolean;
  lockAcquired: boolean;
  orchestration?: any;
}

/**
 * Run (or resume) ONE project end-to-end using the existing APIs. Fail-closed, resumable
 * and credit-safe: it NEVER generates Flow content, NEVER approves, NEVER publishes, and
 * NEVER writes state in dryRun mode.
 */
export async function runProject(cfg: RunProjectConfig): Promise<RunProjectResult> {
  const paths = resolveProjectPaths(cfg);

  // 1. Pipeline must exist (story boundary owns creation). A missing pipeline is a FAILURE.
  const pipeline = await loadPipeline(paths);
  if (!pipeline) {
    return { projectId: paths.projectId, status: 'PERMANENT_FAILURE', blockers: [{ category: 'other', detail: `pipeline.json not found at ${paths.pipelineFile}` }], completed: [], nextAction: 'Create the pipeline (story boundary) first.', resumable: true, lockAcquired: false };
  }

  // 2. Acquire the per-project lock (unless dryRun).
  let lock: { release(): Promise<void> } | null = null;
  if (!cfg.dryRun) {
    const acq = await acquireProjectLock({ outputsRoot: paths.outputsRoot, projectId: paths.projectId, host: cfg.host });
    if (!acq.ok) {
      return { projectId: paths.projectId, status: 'RECOVERABLE_FAILURE', blockers: [{ category: 'other', detail: acq.reason }], completed: [], nextAction: 'Another run holds this project lock; retry later.', resumable: true, lockAcquired: false };
    }
    lock = acq.handle;
  }

  try {
    // 3. Readiness via the EXISTING validator (read-only).
    const diag = await checkInputs({ pipeline, inputsRoot: paths.inputsRoot, projectId: paths.projectId, outputsDir: paths.outputsDir, ffprobePath: cfg.ffprobePath } as any);

    // STEP-8GQ: scoped run — restrict readiness/blockers to the selected scenes ONLY. Unrelated
    // scenes' missing narration/characters are NOT blockers for a scoped scene execution. A
    // selected scene that is already READY (e.g. a valid supplied clip) is safely executable and
    // contributes no blocker, even when an unneeded narration asset is absent.
    const scoped = Array.isArray(cfg.onlyScenes) && cfg.onlyScenes.length > 0;
    const selected = scoped ? new Set(cfg.onlyScenes!.map((n) => Number(n))) : null;
    const sceneDiag = selected
      ? diag.scenes.filter((s: any) => selected.has(Number(s.sceneNumber)) && s.readiness !== 'READY')
      : diag.scenes;

    // STEP-8HD: Flow-execution eligibility (modern Flow path). This is SEPARATE
    // from final production readiness: it independently validates non-Flow prerequisites and
    // requires genuine Flow work. Only these scenes may bypass the Flow-media blockers.
    // It is NOT restricted to unscoped runs: an explicitly-authorised SCOPED Flow run
    // (`--only N --run-flow --flow-session`) needs it too, otherwise `flowEligibleSet` stays
    // empty and `canExecute` can never be satisfied for a scene that BY DEFINITION has a
    // missing Flow clip — making scoped generation unreachable. Scope safety is preserved
    // downstream: `determineWorkSet` AND-gates on `onlyScenes` first, so flow eligibility can
    // never pull in an out-of-scope scene, and `flowExecutionEnabled` is only true when an
    // interactive Flow session was actually opened.
    const flowEligibleScenes: number[] = [];
    if (cfg.flowExecutionEnabled === true) {
      for (const s of diag.scenes as any[]) {
        const v = classifyFlowEligibility(s);
        if (v.eligible) flowEligibleScenes.push(Number(s.sceneNumber));
      }
    }
    const flowEligibleSet = new Set(flowEligibleScenes);

    // 4. Precise blockers from actual evidence (incl. explicit Flow/local state).
    const missingNarrationScenes = sceneDiag.filter((s: any) => s.narrationAsset.state === 'MISSING').map((s: any) => s.sceneNumber);
    const missingCharacterTags = [...new Set(sceneDiag.flatMap((s: any) => (s.characters ?? []).filter((c: any) => c.state === 'MISSING').map((c: any) => c.tag)))];
    const missingBackgroundTags = [...new Set(sceneDiag.flatMap((s: any) => (s.background.state === 'MISSING' ? [s.backgroundTag] : [])))];
    const missingFlowClipScenes = sceneDiag
      .filter((s: any) => s.suppliedClip?.state === 'MISSING' && s.readiness === 'WAITING_FOR_VIDEO_CLIP' && !flowEligibleSet.has(Number(s.sceneNumber)))
      .map((s: any) => s.sceneNumber);
    const flowCommittedLocalMissing = (selected
      ? ((diag as any).flowCommittedLocalMissing ?? []).filter((n: number) => selected.has(Number(n)))
      : ((diag as any).flowCommittedLocalMissing ?? []))
      .filter((n: number) => !flowEligibleSet.has(Number(n)));
    // Missing BGM / branding are genuine project-level blockers and were never propagated here,
    // so a project missing either reported no blocker at all even though `collectBlockers` (and
    // projectHealth, which already computes the same two values) treats them as required.
    //
    // Both are REQUIRED by current code, not optional: inputValidator documents branding as
    // "required by addTitle.ts", the manifest marks music/channel-intro/channel-logo REQUIRED,
    // stageExecutor's BED/TITLE stages read exactly these canonical input paths and fail closed,
    // and RunProjectConfig exposes no bgmPath/titleAssets override. The derivations below mirror
    // projectHealth.ts exactly so `status` and `health` never disagree.
    //
    // They are PROJECT-level, so a SCOPED scene run is deliberately exempt: a scoped run renders
    // scenes only and never plans or executes the BED/TITLE stages that consume these assets.
    const [musicIssues, brandingIssues]: any[][] = scoped
      ? [[], []]
      : await Promise.all([
        validateMusicInputs({ inputRoot: paths.inputRoot, ffprobePath: cfg.ffprobePath } as any),
        validateBrandingInputs({ inputRoot: paths.inputRoot, ffprobePath: cfg.ffprobePath } as any),
      ]);
    const musicMissing = musicIssues.length > 0 && musicIssues.every((m: any) => m.state !== 'VALID');
    const brandingMissing = brandingIssues.filter((b: any) => b.state !== 'VALID').map((b: any) => String(b.id));
    const blockers = collectBlockers({
      missingNarrationScenes, missingCharacterTags, missingBackgroundTags, missingFlowClipScenes,
      flowCommittedLocalMissing, musicMissing, brandingMissing,
    });

    // 5. Downstream execution (only when inputs are ready AND an executor was supplied).
    let orchestration: any = null;
    let downstreamAllCurrent = false;
    let titleCurrent = false;
    const canExecute = !cfg.dryRun && !!cfg.sceneExecutor && (blockers.length === 0 || flowEligibleSet.size > 0);
    if (canExecute) {
      // Scene execution. Scoped runs pass `onlyScenes` and NO stage executor: the requested
      // scenes are produced, but downstream stages are never planned/executed (a scoped success
      // never marks the whole project complete).
      const ORCH = await import('./productionOrchestrator.js');
      orchestration = await ORCH.orchestrate({
        pipeline, projectId: paths.projectId, inputRoot: paths.inputRoot, outputsDir: paths.outputsDir, outputsRoot: paths.outputsRoot,
        ffprobePath: cfg.ffprobePath, executor: cfg.sceneExecutor,
        stageExecutor: scoped ? undefined : cfg.stageExecutor,
        stageInputs: cfg.stageInputs, width: 1280, height: 720,
        onlyScenes: scoped ? cfg.onlyScenes : (flowEligibleSet.size > 0 ? flowEligibleScenes : undefined),
        flowEligibleScenes: flowEligibleSet.size > 0 ? flowEligibleScenes : undefined,
        approved: cfg.approved === true,
      } as any);
      if (!scoped) {
        downstreamAllCurrent = ['EDIT', 'MIX', 'BED', 'TITLE'].every((s) => orchestration?.downstream?.states?.[s] === 'CURRENT');
        titleCurrent = orchestration?.downstream?.states?.TITLE === 'CURRENT';
      }
    } else if (!scoped) {
      // Readiness-only pass: derive downstream states WITHOUT executing anything.
      //
      // This runs even when blockers exist. Previously it was gated on `blockers.length === 0`,
      // which meant that ANY missing input left `orchestration` null and `status` reported NO
      // per-scene and NO per-stage state whatsoever — an operator could not tell which scenes
      // were already produced, which stage was CURRENT, or where production had stalled. The
      // blocker list was the only signal, and it said nothing about actual progress.
      // `inspectProject` is read-only (no executor, `readOnly` set), so running it under blockers
      // cannot execute a stage, mutate a scene output, or write state.
      const ORCH = await import('./productionOrchestrator.js');
      orchestration = await ORCH.inspectProject({ pipeline, projectId: paths.projectId, inputRoot: paths.inputRoot, outputsDir: paths.outputsDir, outputsRoot: paths.outputsRoot, ffprobePath: cfg.ffprobePath, readOnly: true } as any);
      downstreamAllCurrent = ['EDIT', 'MIX', 'BED', 'TITLE'].every((s) => orchestration?.downstream?.states?.[s] === 'CURRENT');
      titleCurrent = orchestration?.downstream?.states?.TITLE === 'CURRENT';
    }

    // Scoped completion integrity (STEP-8GS/8GT): SCENE_SCOPE_COMPLETED is valid when EVERY
    // requested scene was either EXECUTED this run OR was ALREADY CURRENT at entry (a valid
    // output + matching sidecar). This makes a completed scoped re-run an idempotent success
    // (true no-op) instead of a false SCENE_SCOPE_INCOMPLETE. Missing/blocked/failed requested
    // scenes still yield SCENE_SCOPE_INCOMPLETE.
    const executedScoped = new Set<number>((orchestration?.executedScenes ?? []) as number[]);
    const priorStates: Record<string, string> = (orchestration?.priorOutputStates ?? {}) as any;
    const satisfiedScoped = (n: number) => executedScoped.has(Number(n)) || priorStates[String(n)] === 'CURRENT';
    const scopedAllSatisfied = scoped && cfg.onlyScenes!.every((n) => satisfiedScoped(Number(n)));
    const scopedExecutedThisRun = scoped ? cfg.onlyScenes!.filter((n) => executedScoped.has(Number(n))).length : 0;
    // STEP-8HD: explicit Flow work was actually attempted for an eligible scene this run.
    const flowWorked = flowEligibleSet.size > 0 && (orchestration?.executedScenes ?? []).some((n: number) => flowEligibleSet.has(Number(n)));
    const failedStageList = (orchestration?.downstream?.failedStages ?? []) as string[];
    const baseStatus = classifyRunStatus({ blockers, downstreamAllCurrent, titleCurrent, failedStages: failedStageList });
    const status = scoped
      // A scoped run never claims the whole project is complete-to-approval. A real stage failure
      // is checked FIRST so missing inputs can never mask it (the old ordering tested `blockers`
      // first, which made the RECOVERABLE_FAILURE branch below unreachable whenever any input was
      // missing).
      ? ((failedStageList.length > 0) ? 'RECOVERABLE_FAILURE' as const
        : blockers.length > 0 ? 'WAITING_FOR_INPUTS' as const
        : scopedAllSatisfied ? 'SCENE_SCOPE_COMPLETED' as const
        : 'SCENE_SCOPE_INCOMPLETE' as const)
      // Explicit Flow work ran but the project still has outstanding final-production
      // prerequisites: NEVER report COMPLETED, report the explicit partial status.
      : (flowWorked && !downstreamAllCurrent) ? 'FLOW_WORK_COMPLETED_WITH_BLOCKERS' as const
      : baseStatus;
    const completed: string[] = [];
    if (scoped && status === 'SCENE_SCOPE_COMPLETED') completed.push(scopedExecutedThisRun > 0 ? `scoped: executed scene(s) ${cfg.onlyScenes!.filter((n) => executedScoped.has(Number(n))).join(', ')}` : `scoped: scene(s) ${cfg.onlyScenes!.join(', ')} already CURRENT (no-op)`);
    if (flowCommittedLocalMissing.length === 0 && (diag as any).flowCommittedLocalAvailable?.length && !scoped) completed.push(`flow-clips: ${(diag as any).flowCommittedLocalAvailable.length} local`);
    if (downstreamAllCurrent) completed.push('downstream: EDIT/MIX/BED/TITLE CURRENT');
    // A real stage failure outranks the "supply inputs" advice: telling the operator to supply
    // inputs about a pipeline that has already broken hides the actual problem.
    const failureNote = failedStageList.length > 0
      ? `Stage(s) ${failedStageList.join(', ')} failed; investigate the failure and resume.`
      : null;
    const nextAction = failureNote
      ? failureNote
      : scoped
        ? (blockers.length ? `Supply: ${blockers.map((b) => b.category).join(', ')}.`
          : scopedAllSatisfied ? `Scoped scene execution complete for scene(s) ${cfg.onlyScenes!.join(', ')}.`
          : `Scoped execution incomplete: scene(s) ${cfg.onlyScenes!.filter((n) => !satisfiedScoped(Number(n))).join(', ')} did not execute and are not CURRENT.`)
        : blockers.length
          ? `Supply: ${blockers.map((b) => b.category).join(', ')}.`
          : status === 'COMPLETED_TO_APPROVAL' ? 'Human approval required.' : 'Run downstream stages.';

    // STEP-8GK: bounded run log (never state; never written in dryRun). Best-effort and
    // fail-safe: a logging error can never alter the run result.
    if (!cfg.dryRun) {
      try {
        const logPath = path.join(paths.outputsRoot, paths.projectId, 'run.log.jsonl');
        await fsp.mkdir(path.dirname(logPath), { recursive: true });
        await appendBoundedRunLog(logPath, {
          ts: new Date().toISOString(), projectId: paths.projectId, status, blockers: blockers.length,
          stages: orchestration?.downstream?.executedStages ?? [], lockAcquired: lock !== null,
        }, { maxBytes: cfg.logMaxBytes, retention: cfg.logRetention });
      } catch { /* run log is best-effort */ }
    }

    return { projectId: paths.projectId, status, blockers, completed, nextAction, resumable: true, lockAcquired: lock !== null, orchestration };
  } catch (e: any) {
    return { projectId: paths.projectId, status: 'RECOVERABLE_FAILURE', blockers: [{ category: 'other', detail: String(e?.message ?? e).slice(0, 200) }], completed: [], nextAction: 'Investigate the error and resume.', resumable: true, lockAcquired: lock !== null };
  } finally {
    if (lock) await lock.release().catch(() => {});
  }
}

/** Read-only project status (no lock, no writes). */
export async function projectStatus(cfg: { projectId: string; projectsRoot: string; inputsRoot: string; outputsRoot: string; ffprobePath?: string; stageInputs?: any }): Promise<RunProjectResult> {
  return runProject({ ...cfg, dryRun: true });
}

// ---------------------------------------------------------------------------------------
// PART 2 — BOUNDED RUN LOG (STEP-8GK)
// ---------------------------------------------------------------------------------------

/** Default finite retention: current + N rotated history files. */
export const DEFAULT_LOG_RETENTION = 5;

/** Is this a project run log basename (canonical current or rotated)? */
export function isRunLogName(name: unknown): boolean {
  const n = String(name ?? '');
  return n === 'run.log' || n === 'run.log.jsonl' || /^run\.log(\.jsonl)?\.\d+$/.test(n);
}

/**
 * Rotate a run log atomically: shift run.log -> run.log.1 -> run.log.2 … and cap history.
 * Never touches state.json/pipeline.json/stage sidecars. Safe when the file is absent.
 * Returns the list of files removed by retention.
 */
export async function rotateRunLog(logPath: string, retention: number = DEFAULT_LOG_RETENTION): Promise<{ rotated: boolean; removed: string[] }> {
  const max = Math.max(1, Math.trunc(retention));
  const removed: string[] = [];
  const exists = await fsp.stat(logPath).then((s) => s.isFile()).catch(() => false);
  if (!exists) return { rotated: false, removed };
  // Drop the oldest if it exceeds retention.
  const oldest = `${logPath}.${max}`;
  if (await fsp.stat(oldest).then((s) => s.isFile()).catch(() => false)) { await fsp.rm(oldest, { force: true }).catch(() => {}); removed.push(oldest); }
  // Shift .N -> .N+1 (highest first) then move the live log to .1.
  for (let i = max - 1; i >= 1; i--) {
    const src = `${logPath}.${i}`; const dst = `${logPath}.${i + 1}`;
    if (await fsp.stat(src).then((s) => s.isFile()).catch(() => false)) await fsp.rename(src, dst).catch(() => {});
  }
  await fsp.rename(logPath, `${logPath}.1`).catch(() => {});
  return { rotated: true, removed };
}

/** Append ONE bounded run-log line, rotating first if the current log exceeds `maxBytes`. */
export async function appendBoundedRunLog(logPath: string, line: unknown, opts: { maxBytes?: number; retention?: number } = {}): Promise<{ rotated: boolean }> {
  const maxBytes = Number(opts.maxBytes ?? 5_000_000);
  const st = await fsp.stat(logPath).catch(() => null);
  let rotated = false;
  if (st && st.size >= maxBytes) { const r = await rotateRunLog(logPath, opts.retention ?? DEFAULT_LOG_RETENTION); rotated = r.rotated; }
  await fsp.appendFile(logPath, `${JSON.stringify(line)}\n`).catch(() => {});
  return { rotated };
}

// ---------------------------------------------------------------------------------------
// PART 3 — PROJECT-SCOPED TEMP GARBAGE COLLECTION (STEP-8GK)
// ---------------------------------------------------------------------------------------

/** Conservative safety threshold: never delete anything newer than this. */
export const TEMP_MIN_AGE_MS = 60 * 60 * 1000; // 1 hour

/** Known temporary-file naming patterns used across the production pipeline. */
export const TEMP_PATTERNS: RegExp[] = [
  /\.tmp-\d+-\d+$/,                 // atomic-write siblings: <name>.tmp-<pid>-<ts>
  /\.flow-download\.tmp-\d+-\d+$/,  // clip download temp
  /\.\d+\.tmp$/,                    // <name>.<pid>.tmp
  /\.stage\.\d+\.tmp$/,             // stage sidecar temp
  /^\.last-bus-title\.ass$/,        // title ASS temp
  /\.tmp\.\d+$/,                    // generic temp remnant
  /\.renamed\.tmp$/,                // character rename temp
];

export function isTempName(name: unknown): boolean {
  const n = String(name ?? '');
  if (!n) return false;
  return TEMP_PATTERNS.some((re) => re.test(n));
}

export interface TempGcResult { scanned: number; candidates: string[]; deleted: string[]; skipped: string[]; errors: string[]; }

/**
 * Delete ONLY known temporary files under `projectRoot`, never newer than `minAgeMs`,
 * never outside the root. Dry-run mode reports candidates without deleting. Fail closed
 * on any path that resolves outside the root.
 */
export async function collectProjectTemps(input: { projectRoot: string; dryRun?: boolean; minAgeMs?: number; now?: number }): Promise<TempGcResult> {
  const root = path.resolve(input.projectRoot);
  const dryRun = input.dryRun === true;
  const minAgeMs = Number(input.minAgeMs ?? TEMP_MIN_AGE_MS);
  const now = Number(input.now ?? Date.now());
  const res: TempGcResult = { scanned: 0, candidates: [], deleted: [], skipped: [], errors: [] };

  const walk = async (dir: string): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [] as any[]);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      // Fail closed: never escape the root.
      const rel = path.relative(root, full);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { res.errors.push(`out-of-root: ${full}`); continue; }
      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.isFile()) continue;
      res.scanned += 1;
      if (!isTempName(e.name)) continue;
      const st = await fsp.stat(full).catch(() => null);
      if (!st) { res.errors.push(`stat-failed: ${full}`); continue; }
      if (now - st.mtimeMs < minAgeMs) { res.skipped.push(rel); continue; }
      res.candidates.push(rel);
      if (!dryRun) {
        try { await fsp.rm(full, { force: true }); res.deleted.push(rel); } catch (err: any) { res.errors.push(`delete-failed: ${rel}: ${String(err?.message ?? err).slice(0, 80)}`); }
      }
    }
  };
  await walk(root);
  return res;
}

// ---------------------------------------------------------------------------------------
// PART 7 — FLOW SESSION SERIALIZATION CONTRACT (STEP-8GK)
// ---------------------------------------------------------------------------------------
// Flow uses ONE shared Chrome profile, so Flow operations MUST be serialized process-wide.
// This is a SEPARATE lock from the per-project lock: it must NOT be held for purely local
// production, and a project lock must never block another project's local work.

export function flowSessionLockPath(lockRoot: string): string { return path.join(path.resolve(lockRoot), '.flow-session.lock'); }

/** Acquire the process-wide Flow session lock (atomic O_EXCL; stale if same-host dead pid). */
export async function acquireFlowSessionLock(opts: { lockRoot: string; host?: string; now?: number; staleAfterMs?: number; pidAlive?: (pid: number) => Promise<boolean> }): Promise<{ ok: true; release(): Promise<void> } | { ok: false; reason: string }> {
  const host = String(opts.host ?? 'local');
  const now = Number(opts.now ?? Date.now());
  const staleAfterMs = Number(opts.staleAfterMs ?? 60 * 60 * 1000);
  const checkAlive = opts.pidAlive ?? pidAlive;
  const file = flowSessionLockPath(opts.lockRoot);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const info = { pid: process.pid, host, acquiredAt: new Date(now).toISOString(), kind: 'flow-session' };
  const tryEx = async (): Promise<boolean> => { try { const h = await fsp.open(file, 'wx'); await h.writeFile(JSON.stringify(info)); await h.close(); return true; } catch (e: any) { if (String(e?.code) === 'EEXIST') return false; throw e; } };
  if (await tryEx()) return { ok: true, release: async () => { const cur = await fsp.readFile(file, 'utf8').then((t) => JSON.parse(t)).catch(() => null); if (cur && cur.pid === process.pid && String(cur.host) === host) await fsp.rm(file, { force: true }).catch(() => {}); } };
  const existing = await fsp.readFile(file, 'utf8').then((t) => JSON.parse(t)).catch(() => null);
  const alive = existing?.pid ? await checkAlive(Number(existing.pid)) : false;
  if (!isLockStale(existing, { host, pidAlive: alive, nowMs: now, staleAfterMs })) return { ok: false, reason: `Flow session lock held by pid ${existing?.pid} on ${existing?.host}.` };
  await fsp.rm(file, { force: true }).catch(() => {});
  if (await tryEx()) return { ok: true, release: async () => { await fsp.rm(file, { force: true }).catch(() => {}); } };
  return { ok: false, reason: 'Flow session lock contended.' };
}

/** Run `fn` while holding the Flow session lock (for the future single-command Flow boundary). */
export async function withFlowSessionLock<T>(opts: { lockRoot: string }, fn: () => Promise<T>): Promise<T> {
  const acq = await acquireFlowSessionLock(opts);
  if (!acq.ok) throw new Error(`withFlowSessionLock refused: ${acq.reason}`);
  try { return await fn(); } finally { await acq.release().catch(() => {}); }
}

// ---------------------------------------------------------------------------------------
// PART 8 — PATH SAFETY (STEP-8GK)
// ---------------------------------------------------------------------------------------

/** Assert `child` resolves strictly inside `root` (fail closed). */
export function assertInsideRoot(root: string, child: string): string {
  const r = path.resolve(root); const c = path.resolve(child);
  const rel = path.relative(r, c);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Refusing a path outside ${r}: ${c}`);
  return c;
}
