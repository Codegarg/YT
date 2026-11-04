/**
 * Guarded real stage executor (STEP-8DK).
 *
 * Binds the ALREADY-PROVEN downstream stage plan (8DH `downstreamStages.ts`) to the existing
 * real producers (`edit.ts`, `mixNarration.ts`, `addMusicBed.ts`, `addTitle.ts`) behind an
 * explicit opt-in.
 *
 * Design:
 *   · The stage PLAN is authoritative — this module never re-decides staleness.
 *   · Nothing runs unless the caller explicitly authorizes it (CLI `--execute-stages`).
 *   · Execution is fail-closed: the project must be render-ready with all scene outputs
 *     CURRENT before the first stage is invoked.
 *   · Each stage runs into a TEMPORARY sibling artifact, is VALIDATED, then atomically
 *     promoted; a failure removes the temp artifact and never overwrites a valid output.
 *   · Metadata is persisted only after a successful, validated stage.
 *   · A prior canonical stage artifact is PRESERVED before it is replaced (see
 *     `preserveStageArtifact` below), so a rerun can never destroy the previous good output.
 *
 * The real stage modules are top-level CLI scripts, so they are invoked as subprocesses with
 * the documented `--input-dir/--output/...` arguments. Their implementations are NOT modified.
 */
import fsp from 'node:fs/promises';
import { constants as fsConstants, createReadStream } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateVideoClip } from './videoClip.js';
import {
  safeStageOutputPath, stageKey, type DownstreamStage, type StageInputs, type StageKeyInputs,
} from './downstreamStages.js';

const exec = promisify(execFile);

/** Existing producers, invoked as subprocesses. */
export const STAGE_SCRIPTS: Record<Exclude<DownstreamStage, 'APPROVAL'>, string> = {
  EDIT: 'src/edit.ts',
  MIX: 'src/mixNarration.ts',
  BED: 'src/addMusicBed.ts',
  TITLE: 'src/addTitle.ts',
};

export type StageExecutionOutcome =
  | { ok: true; stage: DownstreamStage; outputPath: string; outputHash: string; preservation?: StagePreservation }
  | { ok: false; stage: DownstreamStage; code: 'EXECUTION_BLOCKED_INPUTS' | 'STAGE_FAILED' | 'OUTPUT_INVALID' | 'DEPENDENCY_NOT_CURRENT' | 'PRESERVATION_FAILED'; reason: string };

export interface StageExecutorConfig {
  /** Absolute outputs dir for the project (contains scene-####.mp4 and narration/). */
  outputsDir: string;
  /** Absolute inputs dir for the project (production/inputs/<id>) — may not exist. */
  inputsDir: string;
  /** Repo production dir (where the stage scripts live). */
  productionDir: string;
  /** Extra args per stage (e.g. --title, --intro, --logo, --bgm). */
  stageArgs?: Partial<Record<Exclude<DownstreamStage, 'APPROVAL'>, string[]>>;
  /**
   * TITLE branding overrides. When omitted, branding resolves from the SINGLE canonical
   * location `<inputsDir>/branding/{channel-intro.mp4,channel-logo.png}` — the same files
   * validateBrandingInputs()/projectHealth validate. Never falls back to production/assets/.
   */
  titleAssets?: { intro: string; logo: string; title?: string };
  /** Explicit BGM file for the BED stage (defaults to <inputsDir>/music/background-music.mp3). */
  bgmPath?: string;
  /** Optional runner override (tests inject an in-process synthetic producer). */
  runScript?: (scriptRel: string, args: string[]) => Promise<void>;
}

/** Absolute schema-shared argument builder for each stage. */
export function stageArgsFor(stage: Exclude<DownstreamStage, 'APPROVAL'>, cfg: StageExecutorConfig, tmpOutput: string): string[] {
  const inputDir = cfg.outputsDir;
  switch (stage) {
    case 'EDIT':
      return ['--input-dir', inputDir, '--output', tmpOutput];
    case 'MIX':
      // MIX reads the scene clips from the OUTPUTS dir, but its narration comes from the CANONICAL
      // input location `<inputsDir>/narration` — the same directory `narration.ts` writes to via
      // `inputCategoryDir(project_id,'narration')`, and the same one `validateProjectInputs()`,
      // `sceneState` and `projectHealth` read. It previously pointed at `<outputsDir>/narration`,
      // which NO production step ever creates, so MIX failed closed with ENOENT on `readdir`.
      // Exactly ONE `--narration-dir` is emitted so the producer's first-match `arg()` in
      // mixNarration.ts can never be shadowed by a later duplicate.
      return ['--input-dir', inputDir, '--narration-dir', path.join(cfg.inputsDir, 'narration'), '--output', tmpOutput];
    case 'BED':
      return ['--input', safeStageOutputPath(inputDir, 'MIX'), '--bgm', cfg.bgmPath ?? path.join(cfg.inputsDir, 'music', 'background-music.mp3'), '--output', tmpOutput];
    case 'TITLE': {
      const args = ['--input', safeStageOutputPath(inputDir, 'BED'), '--output', tmpOutput];
      // Branding has exactly ONE canonical source: <inputsDir>/branding/ — the same
      // project input root that validateBrandingInputs() and projectHealth read. Mirrors the
      // BED stage's own default so TITLE can never fall back to a second, competing
      // production/assets/ directory (addTitle.ts would otherwise use its own
      // `assets/channel-intro.mp4` / `assets/channel-logo.png` defaults when --intro/--logo
      // are omitted). An explicit titleAssets still wins; addTitle.ts fs.access()es both
      // files, so absent branding FAILS CLOSED rather than silently sourcing another path.
      const branding = cfg.titleAssets ?? {
        intro: path.join(cfg.inputsDir, 'branding', 'channel-intro.mp4'),
        logo: path.join(cfg.inputsDir, 'branding', 'channel-logo.png'),
      };
      args.push('--intro', branding.intro, '--logo', branding.logo);
      if (branding.title !== undefined) args.push('--title', branding.title);
      return args;
    }
  }
}

/** Default runner: execute the stage script through tsx. */
async function defaultRunScript(scriptRel: string, args: string[], productionDir: string): Promise<void> {
  await exec(process.execPath, [`--import`, `tsx`, path.join(productionDir, scriptRel), ...args], { cwd: productionDir, maxBuffer: 1024 * 1024 * 16 });
}

/** Validate a produced stage artifact against the existing media contract. */
export async function validateStageOutput(stage: DownstreamStage, file: string, ffprobePath?: string): Promise<{ ok: true; hash: string } | { ok: false; reason: string }> {
  const clip = await validateVideoClip(file, { ffprobePath });
  if (clip.state !== 'VALID') return { ok: false, reason: `${stage} output invalid: ${clip.reason ?? clip.state}` };
  return { ok: true, hash: clip.sha256 ?? '' };
}

// ---------------------------------------------------------------------------------------
// STAGE ARTIFACT PRESERVATION — keep the previous good output before replacing it
// ---------------------------------------------------------------------------------------

/**
 * Directory name (relative to ONE project's outputs dir) that holds preserved copies of stage
 * artifacts that were about to be replaced.
 *
 * LAYOUT: `<outputsDir>/.stage-backups/<STAGE>/<original name>.<stamp>-<sha8>.bak`
 *   e.g. `production/outputs/<project-id>/.stage-backups/EDIT/final-with-fades.mp4.20261011T112233456Z-1a2b3c4d.bak`
 *
 * It is scoped to a single project (it lives inside that project's own outputs dir) and to a
 * single stage (one subdirectory per stage), so backups belonging to different projects or
 * different stages never interleave.
 *
 * These names deliberately match NONE of the temporary-file patterns in
 * `projectOrchestrator.ts` (`TEMP_PATTERNS`), so the project temp-GC can never delete a backup.
 *
 * Backups are append-only: this module never overwrites an existing backup and never deletes
 * one. The single exception is a backup that failed its OWN verification inside the same call
 * that created it — that partial/mismatched file is removed so it can never be mistaken for a
 * trustworthy copy.
 */
export const STAGE_BACKUP_DIRNAME = '.stage-backups';

/** How many distinct candidate backup names to try before giving up. */
const BACKUP_NAME_ATTEMPTS = 8;

/** SHA-256 of a file, streamed (stage videos are far too large to buffer in memory). */
function sha256Stream(file: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Build a unique, collision-safe backup file name.
 * The name embeds the original file name, a millisecond ISO-8601 stamp, and the first 8 hex
 * chars of the ORIGINAL content hash, so two different originals can never propose the same
 * name. `attempt` disambiguates two backups of the SAME bytes taken within one millisecond.
 */
function backupFileName(baseName: string, sha: string, attempt: number): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const tag = `${sha.slice(0, 8)}${attempt > 1 ? `-${attempt}` : ''}`;
  return `${baseName}.${stamp}-${tag}.bak`;
}

export type StagePreservation =
  | { ok: true; preserved: false; reason: string }
  | { ok: true; preserved: true; artifactBackup: string; sidecarBackup: string | null; sha256: string; bytes: number }
  | { ok: false; reason: string };

/**
 * Copy one file into the backup directory and PROVE the copy matches the original (size AND
 * SHA-256) before the caller is allowed to continue.
 *
 * Fail-closed at every step:
 *   · destination exists            → try the next candidate name (never overwrite)
 *   · copy throws                   → remove any partial copy, report failure
 *   · size or SHA-256 mismatch      → remove the bad copy, report failure
 * Only a verified copy is ever reported as `ok`.
 */
async function copyVerified(
  src: string, dir: string, baseName: string, sha: string, size: number, label: string,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  for (let attempt = 1; attempt <= BACKUP_NAME_ATTEMPTS; attempt++) {
    const dest = path.join(dir, backupFileName(baseName, sha, attempt));
    try {
      // COPYFILE_EXCL: refuse to write over an existing backup, ever.
      await fsp.copyFile(src, dest, fsConstants.COPYFILE_EXCL);
    } catch (e: any) {
      if (String(e?.code) === 'EEXIST') continue; // name already taken -> next candidate, nothing overwritten
      // A copy that throws may have left a partial file behind; it must never survive.
      await fsp.rm(dest, { force: true }).catch(() => {});
      return { ok: false, reason: `Preservation failed: could not copy the ${label} to ${dest}: ${String(e?.message ?? e)}` };
    }
    const copied = await fsp.stat(dest).catch(() => null);
    const copiedSha = copied?.isFile() ? await sha256Stream(dest).catch(() => null) : null;
    if (copied?.isFile() && copied.size === size && copiedSha === sha) return { ok: true, path: dest };
    // Verification failed. Discard the bad copy rather than leaving misleading provenance behind.
    await fsp.rm(dest, { force: true }).catch(() => {});
    return {
      ok: false,
      reason: `Preservation failed: the ${label} backup did not verify against the original `
        + `(expected ${size} bytes / sha256 ${sha}, got ${copied?.size ?? 'missing'} bytes / sha256 ${copiedSha ?? 'unreadable'}).`,
    };
  }
  return { ok: false, reason: `Preservation failed: no free backup name for the ${label} after ${BACKUP_NAME_ATTEMPTS} attempts.` };
}

/**
 * Preserve an EXISTING canonical stage artifact — and its matching `<output>.stage` provenance
 * sidecar when one is present — before it is replaced.
 *
 * Contract:
 *   · No prior artifact          → `{ ok:true, preserved:false }` and NOTHING is created
 *                                  (not even the backup directory). First-time output creation
 *                                  keeps exactly its previous behaviour.
 *   · Prior artifact present     → copied byte-for-byte into `.stage-backups/<STAGE>/` and
 *                                  verified by size + SHA-256 against the original.
 *   · Anything goes wrong        → `{ ok:false }`. The caller MUST abort the replacement and
 *                                  leave the existing canonical output exactly as it was.
 *
 * This function never modifies, moves or removes the artifact or the sidecar; it only reads
 * them and writes new backup files.
 */
export async function preserveStageArtifact(finalPath: string, stage: DownstreamStage): Promise<StagePreservation> {
  const existing = await fsp.stat(finalPath).catch(() => null);
  if (!existing?.isFile()) return { ok: true, preserved: false, reason: `No prior ${stage} output to preserve.` };

  let sha: string;
  try { sha = await sha256Stream(finalPath); }
  catch (e: any) { return { ok: false, reason: `Preservation required for ${stage}, but the existing output could not be read: ${String(e?.message ?? e)}` }; }

  const dir = path.join(path.dirname(finalPath), STAGE_BACKUP_DIRNAME, stage);
  try { await fsp.mkdir(dir, { recursive: true }); }
  catch (e: any) { return { ok: false, reason: `Preservation required for ${stage}, but the backup directory could not be created: ${String(e?.message ?? e)}` }; }

  const artifact = await copyVerified(finalPath, dir, path.basename(finalPath), sha, existing.size, `${stage} output`);
  if (!artifact.ok) return artifact;

  // The provenance sidecar describes the artifact we just preserved, so it is preserved with it.
  // An ABSENT sidecar is normal (the stage may never have completed) and is not a failure.
  const sidecar = `${finalPath}.stage`;
  const sidecarStat = await fsp.stat(sidecar).catch(() => null);
  let sidecarBackup: string | null = null;
  if (sidecarStat?.isFile()) {
    let sidecarSha: string;
    try { sidecarSha = await sha256Stream(sidecar); }
    catch (e: any) {
      return { ok: false, reason: `Preservation required for ${stage}: the provenance sidecar exists but could not be read: ${String(e?.message ?? e)}` };
    }
    const sc = await copyVerified(sidecar, dir, path.basename(sidecar), sidecarSha, sidecarStat.size, `${stage} provenance sidecar`);
    if (!sc.ok) return sc;
    sidecarBackup = sc.path;
  }

  return { ok: true, preserved: true, artifactBackup: artifact.path, sidecarBackup, sha256: sha, bytes: existing.size };
}

/**
 * Execute ONE stage with temp-artifact + atomic promotion.
 * Never mutates a previously-valid output unless the new artifact validated successfully,
 * and never mutates it at all unless it was first PRESERVED and VERIFIED.
 */
export async function executeStage(
  stage: Exclude<DownstreamStage, 'APPROVAL'>,
  cfg: StageExecutorConfig,
  opts: { ffprobePath?: string } = {},
): Promise<StageExecutionOutcome> {
  const finalPath = safeStageOutputPath(cfg.outputsDir, stage);
  // The temporary artifact MUST keep the final extension: the real producers pass the output
  // path straight to ffmpeg, which cannot infer a muxer from a bare `.tmp-<pid>-<ts>` suffix.
  const parsed = path.parse(finalPath);
  const tmpOutput = path.join(parsed.dir, `${parsed.name}.tmp-${process.pid}-${Date.now()}${parsed.ext}`);
  const args = [...stageArgsFor(stage, cfg, tmpOutput), ...(cfg.stageArgs?.[stage] ?? [])];

  try {
    if (cfg.runScript) await cfg.runScript(STAGE_SCRIPTS[stage], args);
    else await defaultRunScript(STAGE_SCRIPTS[stage], args, cfg.productionDir);
  } catch (e: any) {
    await fsp.rm(tmpOutput, { force: true }).catch(() => {});
    return { ok: false, stage, code: 'STAGE_FAILED', reason: `${stage} producer failed: ${String(e?.message ?? e)}` };
  }

  // Validate the TEMP artifact before promoting it.
  const valid = await validateStageOutput(stage, tmpOutput, opts.ffprobePath);
  if (!valid.ok) {
    await fsp.rm(tmpOutput, { force: true }).catch(() => {});
    return { ok: false, stage, code: 'OUTPUT_INVALID', reason: valid.reason };
  }

  // Preserve the EXISTING canonical artifact (and its sidecar) BEFORE it can be replaced.
  // A failed preservation is fatal to this run: the promotion is abandoned and the existing
  // output is left byte-for-byte intact rather than being destroyed unarchived.
  const preservation = await preserveStageArtifact(finalPath, stage);
  if (!preservation.ok) {
    await fsp.rm(tmpOutput, { force: true }).catch(() => {});
    return { ok: false, stage, code: 'PRESERVATION_FAILED', reason: `${preservation.reason} Replacement aborted; the existing ${stage} output was left intact.` };
  }

  // Atomic promotion: only now may we replace the final artifact.
  try { await fsp.rename(tmpOutput, finalPath); }
  catch (e: any) { await fsp.rm(tmpOutput, { force: true }).catch(() => {}); return { ok: false, stage, code: 'STAGE_FAILED', reason: `Atomic promotion failed: ${String(e?.message ?? e)}` }; }

  return { ok: true, stage, outputPath: finalPath, outputHash: valid.hash, preservation };
}

export interface StageRunPlanInput {
  workSet: DownstreamStage[];
  sceneOutputsCurrent: boolean;
}

/**
 * Guarded run of the whole downstream chain.
 *
 * Fail-closed gates (in order):
 *   1. caller must explicitly authorize (the CLI only calls this with `--execute-stages`)
 *   2. every scene output must be CURRENT
 *   3. a stage may only run when its declared upstream is CURRENT
 *
 * Returns the executed stages and the first blocking outcome.
 */
export async function executeDownstreamChain(
  plan: StageRunPlanInput,
  cfg: StageExecutorConfig,
  ctx: {
    approved?: boolean;
    /** Resolve a stage's current recorded state (from the orchestrator's derivation). */
    stageState: (s: DownstreamStage) => string;
    /** Persist a successful stage's metadata atomically (including the effective key inputs). */
    persistStage: (s: DownstreamStage, rec: { key: string; output_hash: string; output_path: string; key_inputs?: StageKeyInputs }) => Promise<void>;
    /** Resolve the CURRENT key (and the effective key inputs) for a stage, reflecting any upstream output produced this run. */
    resolveKey: (s: DownstreamStage) => Promise<{ key: string; keyInputs: StageKeyInputs }>;
    ffprobePath?: string;
  },
): Promise<{ executed: DownstreamStage[]; blocked?: StageExecutionOutcome }> {
  const executed: DownstreamStage[] = [];
  if (!plan.sceneOutputsCurrent) {
    return { executed, blocked: { ok: false, stage: 'EDIT', code: 'EXECUTION_BLOCKED_INPUTS', reason: 'Scene outputs are not all CURRENT.' } };
  }
  for (const stage of plan.workSet) {
    if (stage === 'APPROVAL') continue;
    const upstream: Record<string, DownstreamStage | null> = { EDIT: null, MIX: 'EDIT', BED: 'MIX', TITLE: 'BED' };
    const dep = upstream[stage];
    if (dep && ctx.stageState(dep) !== 'CURRENT') {
      return { executed, blocked: { ok: false, stage: stage as any, code: 'DEPENDENCY_NOT_CURRENT', reason: `${dep} is not CURRENT; refusing to run ${stage}.` } };
    }
    const res = await executeStage(stage as any, cfg, { ffprobePath: ctx.ffprobePath });
    if (!res.ok) return { executed, blocked: res };
    // Resolve the key AFTER the stage produced its output (upstream hashes are now real).
    const { key, keyInputs } = await ctx.resolveKey(stage);
    await ctx.persistStage(stage, { key, output_hash: res.outputHash, output_path: path.basename(res.outputPath), key_inputs: keyInputs });
    executed.push(stage);
  }
  return { executed };
}
