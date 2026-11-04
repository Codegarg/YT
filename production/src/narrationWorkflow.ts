/**
 * Narration generation workflow helpers (pure planning + safe install).
 *
 * Planning is browser/network-free. Installation is the shared ingest layer: temp write →
 * ffprobe validate → normalize to WAV if needed → ffprobe validate again → atomic rename. It
 * reuses the existing narration filename/extension contract and NEVER overwrites a valid file.
 */
import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SUPPORTED_AUDIO_EXTENSIONS, narrationFilename, sceneNumberFromNarrationFilename, resolveSceneNarrationDuration } from './narrationDuration.js';
import { classifyNarration, requiresNarrationAudio } from './sceneCompositionPlanner.js';

const exec = promisify(execFile);

function isNarrationSceneByClassifiers(s: any): boolean {
  return requiresNarrationAudio(s, classifyNarration(s));
}

/** True when a scene requires narration (NARRATOR_ONLY or MIXED). */
export function isNarrationScene(pipeline: any, sceneNumber: number): boolean {
  const s = (pipeline?.scenes ?? []).find((x: any) => Number(x.scene_number) === Number(sceneNumber));
  return s ? isNarrationSceneByClassifiers(s) : false;
}

export function narrationSceneNumbers(pipeline: any): number[] {
  return (pipeline?.scenes ?? [])
    .filter((s: any) => isNarrationSceneByClassifiers(s))
    .map((s: any) => Number(s.scene_number))
    .sort((a: number, b: number) => a - b);
}

export type SceneNarrationAction = 'REUSE' | 'GENERATE' | 'FAIL_INVALID' | 'SKIP';

export interface SceneNarrationPlan {
  sceneNumber: number;
  file: string;
  text: string;
  textLength: number;
  voiceDirectionRequired: true;
  action: SceneNarrationAction;
  reason?: string;
}

export interface NarratePlanOptions {
  scene?: number;
  missing?: boolean;
  narrationDir: string;
}

/**
 * Build the deterministic plan. Reads the pipeline + the narration directory listing.
 * `narration-####.<ext>` maps deterministically to its scene; duplicates are invalid (fail closed).
 * Existing VALID files → REUSE (never regenerated); existing INVALID → FAIL_INVALID (replaced only
 * with --overwrite); missing → GENERATE. With `missing`, only non-REUSE scenes are returned.
 */
export function narrateScenesPlan(pipeline: any, options: NarratePlanOptions): SceneNarrationPlan[] {
  const scenes: number[] = options.scene !== undefined ? [Number(options.scene)] : narrationSceneNumbers(pipeline);
  const byScene = (pipeline?.scenes ?? []).reduce((m: Map<number, any>, s: any) => { m.set(Number(s.scene_number), s); return m; }, new Map<number, any>());
  const names: string[] = existsSync(options.narrationDir) ? readdirSync(options.narrationDir) : [];
  const present = new Set(names.filter((n: string) => isAudioName(n)).map((n: string) => sceneNumberFromNarrationFilename(n)).filter((x: number | null): x is number => x !== null));
  const plan: SceneNarrationPlan[] = [];
  for (const n of scenes) {
    const scene = byScene.get(n);
    if (!scene || !isNarrationSceneByClassifiers(scene)) { plan.push({ sceneNumber: n, file: narrationFilename(n, '.wav'), text: '', textLength: 0, voiceDirectionRequired: true, action: 'SKIP', reason: 'scene does not require narration' }); continue; }
    const text = String(scene.narration_text ?? '').trim();
    const file = narrationFilename(n, '.wav');
    let action: SceneNarrationAction = 'GENERATE';
    let reason: string | undefined;
    if (present.has(n)) {
      // An existing file for this scene: REUSE if valid, else FAIL_INVALID (fail closed).
      const existingName = names.find((x: string) => sceneNumberFromNarrationFilename(x) === n) as string;
      const looksValid = existingName && SUPPORTED_AUDIO_EXTENSIONS.includes(path.extname(existingName).toLowerCase() as any);
      action = looksValid ? 'REUSE' : 'FAIL_INVALID';
      reason = looksValid ? 'existing narration present (reused; never regenerated)' : 'existing narration file is invalid; pass --overwrite to replace it';
    }
    plan.push({ sceneNumber: n, file, text, textLength: text.length, voiceDirectionRequired: true, action, reason });
  }
  return options.missing ? plan.filter((p) => p.action !== 'REUSE') : plan;
}

const AUDIO_NAME_RE = /^narration-\d{4}\.\w+$/i;
function isAudioName(name: string): boolean { return AUDIO_NAME_RE.test(name) && SUPPORTED_AUDIO_EXTENSIONS.includes(path.extname(name).toLowerCase() as any); }

/** True when a filename maps deterministically to the scene. */
export function narrationFileMatchesScene(name: string, sceneNumber: number): boolean {
  return sceneNumberFromNarrationFilename(name) === sceneNumber;
}

export interface InstallResult {
  status: 'INSTALLED' | 'REUSED' | 'FAILED' | 'INVALID';
  file: string;
  durationSeconds?: number;
  bytes?: number;
  reason?: string;
}

async function ffprobeDuration(file: string, ffprobePath?: string): Promise<{ ok: true; duration: number } | { ok: false; reason: string }> {
  const bin = String(ffprobePath || process.env.FFPROBE_PATH || 'ffprobe').trim();
  try {
    const { stdout } = await exec(bin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
    const d = Number(String(stdout).trim());
    if (!Number.isFinite(d) || d <= 0) return { ok: false, reason: `ffprobe returned a non-positive duration (${String(stdout).trim()}).` };
    if (d > 600) return { ok: false, reason: `duration ${d}s exceeds the 600s safety ceiling.` };
    return { ok: true, duration: d };
  } catch (e: any) {
    return { ok: false, reason: `ffprobe failed: ${String(e?.message ?? e).slice(0, 160)}` };
  }
}

/**
 * Install provider bytes deterministically:
 *   temp write → ffprobe validate → (normalize to WAV via ffmpeg if the native format is not a
 *   readable WAV) → ffprobe validate → atomic rename. Never overwrites a valid final file; an
 *   invalid existing file may be replaced ONLY when `overwriteInvalid` is true.
 */
export async function installNarratedAudio(opts: {
  sceneNumber: number; dir: string; file: string; bytes: Buffer; mimeType?: string;
  ffprobePath?: string; ffmpegPath?: string; overwriteInvalid?: boolean;
}): Promise<InstallResult> {
  const dir = path.resolve(opts.dir);
  await fs.mkdir(dir, { recursive: true });
  const finalPath = path.join(dir, path.basename(opts.file));
  const ext = path.extname(finalPath).toLowerCase();
  if (!SUPPORTED_AUDIO_EXTENSIONS.includes(ext as any)) return { status: 'FAILED', file: opts.file, reason: `unsupported narration extension "${ext}".` };
  if (!Buffer.isBuffer(opts.bytes) || opts.bytes.length === 0) return { status: 'FAILED', file: opts.file, reason: 'provider returned no bytes.' };

  // Preserve a VALID existing file; never regenerate or overwrite it.
  const existing = await resolveSceneNarrationDuration(opts.sceneNumber, dir);
  if (existing.ok) return { status: 'REUSED', file: opts.file, durationSeconds: existing.durationSeconds };
  const existingInvalid = await fs.stat(finalPath).then(() => true).catch(() => false);
  if (existingInvalid && !opts.overwriteInvalid) return { status: 'INVALID', file: opts.file, reason: 'an invalid file already exists; pass --overwrite to replace it.' };

  const tmp = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, opts.bytes);
    // If not already a valid WAV, normalize to WAV with ffmpeg (deterministic, no network).
    let probe = await ffprobeDuration(tmp, opts.ffprobePath);
    const ffmpeg = String(opts.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg').trim();
    if (!probe.ok) {
      const norm = `${tmp}.norm.wav`;
      try { await exec(ffmpeg, ['-v', 'error', '-y', '-i', tmp, '-ac', '1', '-ar', '24000', norm]); } catch (e: any) { await fs.rm(tmp, { force: true }); await fs.rm(norm, { force: true }); return { status: 'FAILED', file: opts.file, reason: `ffmpeg normalization failed: ${String(e?.message ?? e).slice(0, 160)}` }; }
      await fs.rm(tmp, { force: true });
      await fs.rename(norm, tmp);
      probe = await ffprobeDuration(tmp, opts.ffprobePath);
    }
    if (!probe.ok) { await fs.rm(tmp, { force: true }); return { status: 'INVALID', file: opts.file, reason: probe.reason }; }
    const size = (await fs.stat(tmp)).size;
    await fs.rename(tmp, finalPath); // atomic promote
    return { status: 'INSTALLED', file: opts.file, durationSeconds: Number(probe.duration.toFixed(3)), bytes: size };
  } catch (e: any) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    return { status: 'FAILED', file: opts.file, reason: `install failed: ${String(e?.message ?? e).slice(0, 160)}` };
  }
}
