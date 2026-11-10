/**
 * Production FlowRunner adapter (STEP-8GM).
 *
 * Adapts the EXISTING Flow runner to the 8GL workflow boundary. It does NOT reimplement any
 * Flow logic: it decides (credit-safely) whether generation is required, then delegates to the
 * existing resumable CLI (`src/cli.ts` via `npm run flow`) as a thin subprocess, and finally
 * re-derives the true status from durable evidence.
 *
 * Credit safety (the whole point of this module):
 *   · FLOW_COMMITTED_LOCAL_AVAILABLE / LOCAL_AVAILABLE_FLOW_UNKNOWN → NO generation.
 *   · FLOW_COMMITTED_LOCAL_MISSING → report recovery-required; NEVER regenerate.
 *   · A scene already `status === 'done'` or with a VALID local clip → NO regeneration.
 *   · Generation only when `allowGeneration === true` (explicit --run-flow) AND the decision
 *     core (`decideSceneAction`) authorises it.
 *
 * Serialization: the shared Chrome/Flow session is guarded by the 8GK `withFlowSessionLock`.
 * The lock is acquired ONLY when Flow work is actually about to run — never for status, and
 * never when nothing remains to do. It is DISTINCT from the per-project lock.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { deriveFlowLocalState } from './flowMediaState.js';
import { validateVideoClip } from './videoClip.js';
import { sceneClipDestination } from './sceneFlowWorkflow.js';
import { withFlowSessionLock } from './projectOrchestrator.js';
import { flowSubprocessEnv } from './flowCliLock.js';
import { decideStoryGate, type StoryValidator } from './storyValidation.js';
import type { FlowRunner } from './projectWorkflow.js';

export type FlowRunStatus = 'COMPLETED' | 'WAITING_FOR_INPUTS' | 'FLOW_REQUIRED' | 'FLOW_MEDIA_RECOVERY_REQUIRED' | 'RECOVERABLE_FAILURE' | 'FAILED';

/** Structured, backward-compatible return contract (ok/reason retained). */
export interface FlowRunResult {
  ok: boolean;
  reason?: string;
  status?: FlowRunStatus;
  completed?: number[];
  blockers?: string[];
}

export interface FlowRunnerInput {
  projectId: string;
  pipelineFile: string;
  outputDir: string;
  /** Absolute project input root (production/inputs/<id>). Derived when omitted. */
  inputRoot?: string;
  /** Absolute outputs root (production/outputs). Derived when omitted. */
  outputsRoot?: string;
  /** Enable Flow generation. Default FALSE — resume is zero-credit unless explicitly asked. */
  allowGeneration?: boolean;
  ffprobePath?: string;
  /** Flow session lock root (shared Chrome/Flow). Defaults to <productionRoot>. */
  flowLockRoot?: string;
  /** Optional subprocess override (tests inject a fake runner). */
  runFlowSubprocess?: (args: { projectId: string; pipelineFile: string; outputDir: string }) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** Flow runner program/args overrides (tests / non-npm environments). */
  flowProgram?: string;
  flowArgs?: string[];
  productionDir?: string;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

/** Per-scene classification used to decide whether Flow work exists at all. */
export type SceneFlowNeed = 'HAVE_LOCAL' | 'CAN_DOWNLOAD' | 'NEEDS_GENERATION' | 'NEEDS_RECOVERY' | 'SKIP';

export interface FlowNeedReport {
  needsGeneration: number[];
  needsDownload: number[];
  needsRecovery: number[];
  haveLocal: number[];
  done: number[];
}

/**
 * Pure-ish classification of a pipeline against durable evidence. NO browser, NO generation.
 * Reuses `deriveFlowLocalState` (never re-derives Flow/local semantics here) and the existing
 * local-clip validator.
 */
export async function classifyFlowNeeds(input: {
  pipeline: any;
  inputRoot: string;
  ffprobePath?: string;
}): Promise<FlowNeedReport> {
  const scenes = Array.isArray(input.pipeline?.scenes) ? input.pipeline.scenes : [];
  const report: FlowNeedReport = { needsGeneration: [], needsDownload: [], needsRecovery: [], haveLocal: [], done: [] };
  for (const scene of scenes) {
    const n = Number(scene?.scene_number);
    if (!Number.isInteger(n) || n <= 0) continue;
    if (scene?.status === 'done') { report.done.push(n); continue; }
    const dest = sceneClipDestination(input.inputRoot, n);
    const localClipExists = dest ? await fsp.stat(dest).then((s) => s.isFile()).catch(() => false) : false;
    const localClipValid = dest ? (await validateVideoClip(dest, { ffprobePath: input.ffprobePath })).state === 'VALID' : false;
    const decision = deriveFlowLocalState({
      flowSceneId: scene?.flow_scene_id ?? null,
      flowSceneUrl: scene?.flow_scene_url ?? null,
      localClipExists,
      localClipValid,
    });
    switch (decision.state) {
      case 'FLOW_COMMITTED_LOCAL_AVAILABLE':
      case 'LOCAL_AVAILABLE_FLOW_UNKNOWN':
        report.haveLocal.push(n);
        break;
      case 'FLOW_COMMITTED_LOCAL_MISSING':
        // Committed remotely but not locally usable — recovery, NEVER regeneration.
        report.needsRecovery.push(n);
        break;
      case 'FLOW_UNKNOWN':
        // A local clip exists but fails validation — treat as needing (re)download, not generation.
        report.needsDownload.push(n);
        break;
      case 'FLOW_NOT_COMMITTED':
      default:
        report.needsGeneration.push(n);
        break;
    }
  }
  return report;
}

/**
 * Decide the Flow phase from a need report. NEVER treats a committed-but-locally-missing scene
 * as a generation failure.
 */
export function decideFlowPhase(report: FlowNeedReport): FlowRunStatus {
  if (report.needsRecovery.length > 0) return 'FLOW_MEDIA_RECOVERY_REQUIRED';
  if (report.needsGeneration.length > 0) return 'FLOW_REQUIRED';
  if (report.needsDownload.length > 0) return 'FLOW_REQUIRED';
  return 'COMPLETED';
}

// ---------------------------------------------------------------------------------------
// Subprocess adapter (thin; does NOT duplicate the runner)
// ---------------------------------------------------------------------------------------

/** Default runner: `npm run flow -- --project <pipeline> --output-dir <out>`. */
export function defaultFlowSubprocess(productionDir: string) {
  return async ({ projectId, pipelineFile, outputDir }: { projectId: string; pipelineFile: string; outputDir: string }) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const args = ['run', 'flow', '--', '--project', pipelineFile, '--output-dir', outputDir];
    // This process holds the shared Flow session lock around the whole child run (see below).
    // Tell the child so it does not try to re-acquire a non-reentrant lock and abort.
    return spawnCapture(npm, args, { cwd: productionDir, env: flowSubprocessEnv() });
  };
}

export interface SpawnResult { code: number | null; stdout: string; stderr: string; }

export function spawnCapture(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true, shell: process.platform === 'win32' });
    let stdout = ''; let stderr = '';
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => resolve({ code: null, stdout, stderr: stderr + String(e?.message ?? e) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------------------
// Real FlowRunner
// ---------------------------------------------------------------------------------------

export interface CreateRealFlowRunnerOptions {
  productionDir: string;
  /** Absolute inputs root (production/inputs). */
  inputsRoot: string;
  /** Absolute outputs root (production/outputs). */
  outputsRoot: string;
  ffprobePath?: string;
  /** Flow session lock root (shared Chrome/Flow). Defaults to productionDir. */
  flowLockRoot?: string;
  /** Subprocess override (tests). */
  runFlowSubprocess?: FlowRunnerInput['runFlowSubprocess'];
  /**
   * PHASE 3 read-only story/scene validator. When provided, a PAID run is gated BEFORE the
   * Flow session lock is acquired and before any child process can submit anything.
   */
  storyValidator?: StoryValidator;
  /** PHASE 3 policy: WARNINGs also block paid generation (explicit strict review). */
  blockOnStoryWarnings?: boolean;
}

/**
 * Build the production FlowRunner. It reads truth from durable evidence and only ever invokes
 * the existing Flow CLI when generation is explicitly authorised AND actually required.
 */
export function createRealFlowRunner(opts: CreateRealFlowRunnerOptions): FlowRunner {
  const runSub = opts.runFlowSubprocess ?? defaultFlowSubprocess(opts.productionDir);
  const lockRoot = opts.flowLockRoot ?? opts.productionDir;

  return async (input) => {
    const projectId = String(input.projectId ?? '').trim();
    if (!projectId) return { ok: false, status: 'FAILED', reason: 'FlowRunner requires a projectId.' };
    const pipelineFile = input.pipelineFile;
    const outputDir = input.outputDir;
    const inputRoot = input.inputRoot ?? path.join(opts.inputsRoot, projectId);
    const ffprobePath = opts.ffprobePath;

    // 1. Read the target project's pipeline ONLY (project isolation).
    let pipeline: any;
    try { pipeline = JSON.parse(await fsp.readFile(pipelineFile, 'utf8')); }
    catch (e: any) { return { ok: false, status: 'FAILED', reason: `Cannot read pipeline for "${projectId}": ${String(e?.message ?? e).slice(0, 120)}` }; }
    if (String(pipeline?.project_id ?? '') && String(pipeline.project_id) !== projectId) {
      return { ok: false, status: 'FAILED', reason: `Pipeline project_id "${pipeline.project_id}" does not match "${projectId}".` };
    }

    // 2. Classify needs from durable evidence (no browser).
    const needs = await classifyFlowNeeds({ pipeline, inputRoot, ffprobePath });
    const phase = decideFlowPhase(needs);

    // 3. No work → return success WITHOUT acquiring the Flow session lock.
    if (phase === 'COMPLETED') {
      return { ok: true, status: 'COMPLETED', completed: [...needs.haveLocal, ...needs.done].sort((a, b) => a - b) };
    }

    // 4. Committed remotely but locally missing → ALWAYS report recovery; NEVER regenerate.
    if (needs.needsRecovery.length > 0) {
      return {
        ok: false,
        status: 'FLOW_MEDIA_RECOVERY_REQUIRED',
        reason: `scene(s) ${needs.needsRecovery.join(', ')} are committed in Flow but have no locally available clip; supply the local media.`,
        blockers: [`flow-media-recovery: ${needs.needsRecovery.join(', ')}`],
      };
    }

    // 5. Generation required → only when EXPLICITLY enabled. Flow disabled ⇒ zero-credit stop.
    const allowGeneration = input.allowGeneration === true;
    if (!allowGeneration) {
      return {
        ok: false,
        status: 'FLOW_REQUIRED',
        reason: `Flow generation required for scene(s) ${needs.needsGeneration.join(', ')}; re-run with Flow enabled (--run-flow) to proceed.`,
        blockers: [`flow-required: ${needs.needsGeneration.join(', ')}`],
      };
    }

    // 5b. PHASE 3 gate: a READ-ONLY story/scene audit must pass BEFORE the Flow session lock is
    // acquired and before any child process exists. A validator that cannot run fails CLOSED for
    // a paid run (no report ⇒ no proof the story is sound ⇒ no submission).
    if (opts.storyValidator) {
      let validation: Awaited<ReturnType<StoryValidator>>;
      try {
        validation = await opts.storyValidator({ projectFile: pipelineFile, strict: opts.blockOnStoryWarnings === true });
      } catch (e: any) {
        validation = {
          ok: false, available: false, status: 'UNAVAILABLE', projectId, projectFile: pipelineFile,
          exitCode: null, blockers: [], warnings: [], infos: [],
          reason: `validator failed: ${String(e?.message ?? e).slice(0, 300)}`, stdout: '', stderr: '',
        };
      }
      const gate = decideStoryGate(validation, { blockOnWarnings: opts.blockOnStoryWarnings === true, allowUnavailable: false });
      if (!gate.allowed) {
        return {
          ok: false,
          status: 'FAILED',
          reason: `Story validation blocked paid generation (${gate.code}): ${gate.reason ?? 'see the validation report.'}`,
          blockers: [`story-validation: ${gate.code}: ${gate.reason ?? 'blocked'}`],
        };
      }
    }

    // 6. Enter Flow work under the shared session lock (never the project lock).
    try {
      return await withFlowSessionLock({ lockRoot }, async () => {
        const res = await runSub({ projectId, pipelineFile, outputDir });
        const tail = (res.stderr || res.stdout || '').trim().split('\n').slice(-6).join('\n');
        if (res.code !== 0) {
          return { ok: false, status: 'RECOVERABLE_FAILURE' as FlowRunStatus, reason: `Flow runner exited ${res.code ?? 'null'}. ${tail}`.slice(0, 600) };
        }
        // 7. Zero exit is NOT success on its own — re-derive from durable evidence.
        const after = await classifyFlowNeeds({ pipeline: JSON.parse(await fsp.readFile(pipelineFile, 'utf8')), inputRoot, ffprobePath });
        if (after.needsGeneration.length === 0 && after.needsDownload.length === 0 && after.needsRecovery.length === 0) {
          return { ok: true, status: 'COMPLETED', completed: [...after.haveLocal, ...after.done].sort((a, b) => a - b) };
        }
        if (after.needsRecovery.length > 0) {
          return { ok: false, status: 'FLOW_MEDIA_RECOVERY_REQUIRED', reason: `Flow committed scene(s) ${after.needsRecovery.join(', ')} but local media is missing; supply the local clips.`, blockers: [`flow-media-recovery: ${after.needsRecovery.join(', ')}`] };
        }
        return { ok: false, status: 'RECOVERABLE_FAILURE', reason: `Flow runner completed but scene(s) ${after.needsGeneration.join(', ') || after.needsDownload.join(', ')} are still not locally available.`, blockers: [`flow-incomplete: ${[...after.needsGeneration, ...after.needsDownload].join(', ')}`] };
      });
    } catch (e: any) {
      return { ok: false, status: 'RECOVERABLE_FAILURE', reason: `Flow session lock/execution failed: ${String(e?.message ?? e).slice(0, 200)}` };
    }
  };
}
