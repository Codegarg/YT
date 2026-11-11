/**
 * PHASE 5 — resource preflight for long-form production.
 *
 * Offline, read-mostly checks that run BEFORE any rendering/assembly stage:
 *
 *   · media dependencies (ffmpeg / ffprobe) actually execute
 *   · the project outputs directory exists (or can be created) and is writable
 *   · the volume has enough free space for the conservative estimate
 *
 * Design rules:
 *   · NEVER delete user data, reusable media, approved artifacts or partial renders.
 *   · The only write is a short-lived probe file with a unique preflight name, removed by the same
 *     call. It is never placed over an existing file (`wx`), and it never matches the project temp
 *     patterns, so no existing cleanup routine can confuse it with a partial render.
 *   · Unknown disk capacity is reported as UNKNOWN with a warning, never as a hard failure: a
 *     missing `statfs` implementation must not make production unrunnable.
 *   · Every blocker names the stage/failure category so the operator knows what to fix.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const PREFLIGHT_SCHEMA_VERSION = 1;

/** Failure categories shared by the preflight report and the workflow result. */
export const PREFLIGHT_CATEGORIES = [
  'DEPENDENCY_MISSING',
  'OUTPUT_DIR_INVALID',
  'INSUFFICIENT_DISK',
  'DISK_UNKNOWN',
] as const;
export type PreflightCategory = (typeof PREFLIGHT_CATEGORIES)[number];

export type PreflightStatus = 'OK' | 'DEPENDENCY_MISSING' | 'OUTPUT_DIR_INVALID' | 'INSUFFICIENT_DISK' | 'UNKNOWN';

export interface PreflightCheck {
  id: string;
  status: 'PASS' | 'WARNING' | 'FAIL' | 'UNKNOWN';
  category: PreflightCategory | null;
  detail: string;
  expected?: string | number | null;
  actual?: string | number | null;
}

export interface DependencyVerdict {
  name: 'ffmpeg' | 'ffprobe';
  path: string | null;
  ok: boolean;
  version: string | null;
  error_category: 'DEPENDENCY_MISSING' | null;
  detail: string;
}

export interface PreflightReport {
  schema_version: number;
  project_id: string;
  checked_at: string;
  read_only: true;
  status: PreflightStatus;
  ok: boolean;
  required_bytes: number;
  available_bytes: number | null;
  checks: PreflightCheck[];
  dependencies: DependencyVerdict[];
  /** Blockers use the same shape as `RunBlocker` so the orchestrator can surface them verbatim. */
  blockers: Array<{ stage: string; category: PreflightCategory; detail: string }>;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

// ---------------------------------------------------------------------------------------
// Conservative footprint estimate
// ---------------------------------------------------------------------------------------

/** Default average bytes per finished scene clip (720p, ~6–10s). Deliberately conservative. */
export const DEFAULT_SCENE_BYTES = 12 * 1024 * 1024;
/** Downstream final renders (EDIT/MIX/BED + TITLE) plus a temp render of the same size. */
export const DEFAULT_RENDER_COPIES = 4;
/** Extraction/audio intermediates and narration audio. */
export const DEFAULT_AUDIO_OVERHEAD_BYTES = 64 * 1024 * 1024;
/** Extra headroom so a run cannot start with exactly the minimum. */
export const DEFAULT_HEADROOM_FACTOR = 1.25;

/**
 * Estimate the bytes a full long-form production needs.
 *
 * `sceneCount` scene clips + `renderCopies` full-length renders (each roughly `sceneCount` scene
 * clips, since the final render is their concatenation) + audio overhead, multiplied by headroom.
 * Callers that already measured the real scene sizes should pass `averageSceneBytes`.
 */
export function estimateProjectBytes(input: {
  sceneCount: number;
  averageSceneBytes?: number;
  renderCopies?: number;
  audioOverheadBytes?: number;
  headroomFactor?: number;
}): number {
  const count = Math.max(0, Math.trunc(Number(input.sceneCount) || 0));
  const perScene = Math.max(0, Number(input.averageSceneBytes ?? DEFAULT_SCENE_BYTES) || 0);
  const copies = Math.max(1, Math.trunc(Number(input.renderCopies ?? DEFAULT_RENDER_COPIES) || DEFAULT_RENDER_COPIES));
  const audio = Math.max(0, Number(input.audioOverheadBytes ?? DEFAULT_AUDIO_OVERHEAD_BYTES) || 0);
  const headroom = Math.max(1, Number(input.headroomFactor ?? DEFAULT_HEADROOM_FACTOR) || DEFAULT_HEADROOM_FACTOR);
  return Math.ceil((count * perScene * (1 + copies) + audio) * headroom);
}

// ---------------------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------------------

async function defaultRunner(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const r = await exec(bin, args, { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 });
  return { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
}

const firstLine = (text: unknown): string => String(text ?? '').split(/\r?\n/)[0]?.slice(0, 200) ?? '';

/** Verify ONE media binary by executing it (never by trusting its path alone). */
export async function checkDependency(
  name: 'ffmpeg' | 'ffprobe',
  bin: string | undefined | null,
  opts: { runner?: (bin: string, args: string[]) => Promise<{ stdout: string; stderr: string }> } = {},
): Promise<DependencyVerdict> {
  const resolved = typeof bin === 'string' && bin.trim() ? bin.trim() : name;
  const run = opts.runner ?? defaultRunner;
  try {
    const result = await run(resolved, ['-version']);
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const version = firstLine(output) || null;
    return {
      name, path: resolved, ok: true, version, error_category: null,
      detail: `${name} is executable${version ? ` (${version})` : ''}`,
    };
  } catch (error: any) {
    const code = String(error?.code ?? '');
    const missing = code === 'ENOENT' || /not found|no such file/i.test(String(error?.message ?? ''));
    return {
      name,
      path: resolved,
      ok: false,
      version: null,
      error_category: 'DEPENDENCY_MISSING',
      detail: missing
        ? `${name} was not found or is not executable`
        : `${name} failed its version probe: ${firstLine(error?.message ?? error)}`,
    };
  }
}

export async function checkMediaDependencies(opts: {
  ffmpegPath?: string;
  ffprobePath?: string;
  runner?: (bin: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
} = {}): Promise<DependencyVerdict[]> {
  return Promise.all([
    checkDependency('ffmpeg', opts.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg', { runner: opts.runner }),
    checkDependency('ffprobe', opts.ffprobePath ?? process.env.FFPROBE_PATH ?? 'ffprobe', { runner: opts.runner }),
  ]);
}

// ---------------------------------------------------------------------------------------
// Output directory
// ---------------------------------------------------------------------------------------

export interface OutputDirVerdict {
  ok: boolean;
  created: boolean;
  exists: boolean;
  writable: boolean;
  detail: string;
  error_category: 'OUTPUT_DIR_INVALID' | null;
}

/**
 * Prove the outputs directory is usable.
 *
 * `create: false` (the default) never creates anything — it checks the nearest existing ancestor.
 * A write probe is only attempted when the directory already exists (or was created) and
 * `probeWrite !== false`.
 */
export async function checkOutputDirectory(
  outputsDir: string,
  opts: { create?: boolean; probeWrite?: boolean } = {},
): Promise<OutputDirVerdict> {
  const dir = path.resolve(String(outputsDir ?? ''));
  if (!String(outputsDir ?? '').trim()) {
    return { ok: false, created: false, exists: false, writable: false, error_category: 'OUTPUT_DIR_INVALID', detail: 'no outputs directory was configured' };
  }

  let exists = await fsp.stat(dir).then((s) => s.isDirectory()).catch(() => false);
  let created = false;
  if (!exists && opts.create === true) {
    try { await fsp.mkdir(dir, { recursive: true }); exists = true; created = true; }
    catch (error: any) {
      return { ok: false, created: false, exists: false, writable: false, error_category: 'OUTPUT_DIR_INVALID', detail: `the outputs directory could not be created: ${firstLine(error?.message ?? error)}` };
    }
  }
  if (exists) {
    if (opts.probeWrite === false) return { ok: true, created, exists, writable: true, error_category: null, detail: 'the outputs directory exists' };
    const probe = path.join(dir, `.preflight-${process.pid}-${Date.now()}.probe`);
    try {
      const handle = await fsp.open(probe, 'wx');
      await handle.writeFile('preflight\n', 'utf8');
      await handle.close();
      await fsp.rm(probe, { force: true });
      return { ok: true, created, exists, writable: true, error_category: null, detail: 'the outputs directory exists and is writable' };
    } catch (error: any) {
      await fsp.rm(probe, { force: true }).catch(() => {});
      return { ok: false, created, exists, writable: false, error_category: 'OUTPUT_DIR_INVALID', detail: `the outputs directory is not writable: ${firstLine(error?.message ?? error)}` };
    }
  }

  // Not present: check that the nearest existing ancestor is a writable directory.
  let ancestor = path.dirname(dir);
  for (let depth = 0; depth < 64; depth += 1) {
    const stat = await fsp.stat(ancestor).catch(() => null);
    if (stat) break;
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const ancestorStat = await fsp.stat(ancestor).catch(() => null);
  if (!ancestorStat?.isDirectory()) {
    return { ok: false, created: false, exists: false, writable: false, error_category: 'OUTPUT_DIR_INVALID', detail: 'no existing parent directory can hold the outputs directory' };
  }
  return {
    ok: true, created, exists: false, writable: true, error_category: null,
    detail: `the outputs directory does not exist yet; it will be created under ${path.basename(ancestor)}`,
  };
}

// ---------------------------------------------------------------------------------------
// Disk capacity
// ---------------------------------------------------------------------------------------

export interface DiskVerdict {
  status: 'OK' | 'INSUFFICIENT_DISK' | 'UNKNOWN';
  available_bytes: number | null;
  required_bytes: number;
  detail: string;
}

/** Find the nearest existing directory so `statfs` works before the outputs dir exists. */
async function nearestExisting(dir: string): Promise<string | null> {
  let current = path.resolve(dir);
  for (let depth = 0; depth < 64; depth += 1) {
    const stat = await fsp.stat(current).catch(() => null);
    if (stat?.isDirectory()) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export async function checkDiskSpace(
  targetDir: string,
  requiredBytes: number,
  opts: { statfs?: (dir: string) => Promise<any> } = {},
): Promise<DiskVerdict> {
  const required = Math.max(0, Number(requiredBytes) || 0);
  const statfsImpl = opts.statfs ?? (typeof (fsp as any).statfs === 'function' ? (dir: string) => (fsp as any).statfs(dir) : null);
  if (!statfsImpl) {
    return { status: 'UNKNOWN', available_bytes: null, required_bytes: required, detail: 'this runtime cannot report free disk space; the run is allowed but unverified' };
  }
  const probeDir = await nearestExisting(targetDir);
  if (!probeDir) {
    return { status: 'UNKNOWN', available_bytes: null, required_bytes: required, detail: 'no existing directory could be stat-ed for free space' };
  }
  try {
    const stat = await statfsImpl(probeDir);
    const blockSize = Number(stat?.bsize ?? stat?.frsize ?? 0);
    const availableBlocks = Number(stat?.bavail ?? stat?.bfree ?? 0);
    const available = blockSize > 0 && availableBlocks >= 0 ? blockSize * availableBlocks : null;
    if (available === null) {
      return { status: 'UNKNOWN', available_bytes: null, required_bytes: required, detail: 'free disk space could not be derived from statfs output' };
    }
    if (available < required) {
      return {
        status: 'INSUFFICIENT_DISK',
        available_bytes: available,
        required_bytes: required,
        detail: `${formatBytes(available)} free, ${formatBytes(required)} required (${formatBytes(required - available)} short)`,
      };
    }
    return { status: 'OK', available_bytes: available, required_bytes: required, detail: `${formatBytes(available)} free, ${formatBytes(required)} required` };
  } catch (error: any) {
    return { status: 'UNKNOWN', available_bytes: null, required_bytes: required, detail: `free disk space could not be read: ${firstLine(error?.message ?? error)}` };
  }
}

// ---------------------------------------------------------------------------------------
// Project preflight
// ---------------------------------------------------------------------------------------

export interface PreflightOptions {
  projectId: string;
  outputsDir: string;
  sceneCount: number;
  requiredBytes?: number;
  averageSceneBytes?: number;
  ffmpegPath?: string;
  ffprobePath?: string;
  /** Create the outputs dir when missing (execution path only). Default false. */
  createOutputsDir?: boolean;
  /** Explicit free-space requirement (skips the estimate). */
  minimumFreeBytes?: number;
  runner?: (bin: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  statfs?: (dir: string) => Promise<any>;
  now?: string;
}

/**
 * Run the full preflight. `ok` is false only for a REAL blocker (missing dependency, unusable
 * output directory, provably insufficient disk). Unknown disk capacity yields a WARNING.
 */
export async function preflightProject(opts: PreflightOptions): Promise<PreflightReport> {
  const projectId = String(opts.projectId ?? '').trim();
  if (!projectId) throw new Error('preflightProject requires a project id.');

  const required = Math.max(0, Number(opts.requiredBytes ?? opts.minimumFreeBytes ?? estimateProjectBytes({ sceneCount: opts.sceneCount, averageSceneBytes: opts.averageSceneBytes })) || 0);
  const checks: PreflightCheck[] = [];
  const blockers: PreflightReport['blockers'] = [];

  const dependencies = await checkMediaDependencies({ ffmpegPath: opts.ffmpegPath, ffprobePath: opts.ffprobePath, runner: opts.runner });
  for (const dep of dependencies) {
    checks.push({
      id: `dependency.${dep.name}`,
      status: dep.ok ? 'PASS' : 'FAIL',
      category: dep.ok ? null : 'DEPENDENCY_MISSING',
      detail: dep.detail,
      expected: 'executable',
      actual: dep.ok ? (dep.version ?? 'executable') : 'missing',
    });
    if (!dep.ok) blockers.push({ stage: 'PREFLIGHT', category: 'DEPENDENCY_MISSING', detail: `${dep.name}: ${dep.detail}` });
  }

  const outputDir = await checkOutputDirectory(opts.outputsDir, { create: opts.createOutputsDir === true });
  checks.push({
    id: 'output.dir',
    status: outputDir.ok ? 'PASS' : 'FAIL',
    category: outputDir.error_category,
    detail: outputDir.detail,
    expected: 'writable directory',
    actual: outputDir.writable ? 'writable' : 'unusable',
  });
  if (!outputDir.ok) blockers.push({ stage: 'PREFLIGHT', category: 'OUTPUT_DIR_INVALID', detail: outputDir.detail });

  const disk = await checkDiskSpace(opts.outputsDir, required, { statfs: opts.statfs });
  checks.push({
    id: 'disk.free_space',
    status: disk.status === 'OK' ? 'PASS' : disk.status === 'UNKNOWN' ? 'UNKNOWN' : 'FAIL',
    category: disk.status === 'INSUFFICIENT_DISK' ? 'INSUFFICIENT_DISK' : disk.status === 'UNKNOWN' ? 'DISK_UNKNOWN' : null,
    detail: disk.detail,
    expected: formatBytes(required),
    actual: formatBytes(disk.available_bytes),
  });
  if (disk.status === 'INSUFFICIENT_DISK') blockers.push({ stage: 'PREFLIGHT', category: 'INSUFFICIENT_DISK', detail: disk.detail });

  let status: PreflightStatus = 'OK';
  if (blockers.some((b) => b.category === 'DEPENDENCY_MISSING')) status = 'DEPENDENCY_MISSING';
  else if (blockers.some((b) => b.category === 'OUTPUT_DIR_INVALID')) status = 'OUTPUT_DIR_INVALID';
  else if (blockers.some((b) => b.category === 'INSUFFICIENT_DISK')) status = 'INSUFFICIENT_DISK';
  else if (disk.status === 'UNKNOWN') status = 'UNKNOWN';

  return {
    schema_version: PREFLIGHT_SCHEMA_VERSION,
    project_id: projectId,
    checked_at: opts.now ?? new Date().toISOString(),
    read_only: true,
    status,
    ok: blockers.length === 0,
    required_bytes: required,
    available_bytes: disk.available_bytes,
    checks,
    dependencies,
    blockers,
  };
}

export function renderPreflightReport(report: PreflightReport): string {
  const lines: string[] = [];
  lines.push(`preflight: ${report.status}${report.ok ? ' (ok)' : ' (blocked)'}  ${report.project_id}`);
  lines.push(`space:     ${formatBytes(report.available_bytes)} free / ${formatBytes(report.required_bytes)} required`);
  for (const check of report.checks) {
    lines.push(`  ${check.status.padEnd(7)} ${check.id.padEnd(20)} ${check.detail}`);
  }
  for (const blocker of report.blockers) lines.push(`  blocker [${blocker.category}] ${blocker.detail}`);
  return lines.join('\n');
}
