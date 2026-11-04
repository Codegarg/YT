/**
 * Narration ingestion + REAL duration resolution (STEP-8CS).
 *
 * The narration audio is produced OUTSIDE this repository (Google AI Studio) and consumed
 * here. This module maps scene numbers to the existing `narration-####.<ext>` convention,
 * validates the files, and measures their REAL duration with the already-installed
 * `ffprobe` executable.
 *
 * HARD RULE: duration is ALWAYS measured. It is NEVER derived from narration text,
 * character/word counts, the `timestamp` string, or `clip_length_seconds` defaults.
 *
 * Pure validation/mapping helpers and the ffprobe wrapper are intentionally separated so
 * the pure logic is unit-testable without any executable or real audio.
 */
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Extensions the existing architecture consumes (mirrors mixNarration.ts). */
export const SUPPORTED_AUDIO_EXTENSIONS = ['.wav', '.mp3', '.m4a', '.aac', '.ogg'] as const;

/** Conservative safety ceiling for a single scene's narration (a 5-minute film's scene). */
export const MAX_SCENE_AUDIO_SECONDS = 600;

/** `narration-####.<ext>` filename for a scene number (existing repository convention). */
export function narrationFilename(sceneNumber: unknown, extension = '.wav'): string {
  const n = typeof sceneNumber === 'number' && Number.isInteger(sceneNumber) && sceneNumber > 0 ? sceneNumber : NaN;
  if (!Number.isInteger(n)) throw new Error(`narrationFilename requires a positive integer scene number (got ${String(sceneNumber)}).`);
  const ext = String(extension ?? '').trim().toLowerCase();
  if (!SUPPORTED_AUDIO_EXTENSIONS.includes(ext as any)) throw new Error(`Unsupported narration extension "${extension}".`);
  return `narration-${String(n).padStart(4, '0')}${ext}`;
}

/** True when a filename matches `narration-####.<supported-ext>` (case-insensitive). */
export function isNarrationFilename(name: unknown): boolean {
  const s = String(name ?? '');
  const m = /^narration-(\d{4})\.(\w+)$/i.exec(s);
  if (!m) return false;
  return SUPPORTED_AUDIO_EXTENSIONS.includes(`.${m[2].toLowerCase()}` as any);
}

/** Scene number encoded by a `narration-####.<ext>` filename, or null. */
export function sceneNumberFromNarrationFilename(name: unknown): number | null {
  const s = String(name ?? '');
  const m = /^narration-(\d{4})\.(\w+)$/i.exec(s);
  if (!m || !SUPPORTED_AUDIO_EXTENSIONS.includes(`.${m[2].toLowerCase()}` as any)) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Map the file names present in a narration directory to scene numbers.
 * Fail-closed: when MULTIPLE files target the SAME scene the mapping records an
 * ambiguity rather than silently picking one.
 */
export function mapNarrationFiles(fileNames: unknown): { byScene: Map<number, string>; ambiguous: Map<number, string[]>; ignored: string[] } {
  const byScene = new Map<number, string>();
  const ambiguous = new Map<number, string[]>();
  const ignored: string[] = [];
  for (const raw of Array.isArray(fileNames) ? fileNames : []) {
    const name = String(raw ?? '');
    const scene = sceneNumberFromNarrationFilename(name);
    if (scene === null) { ignored.push(name); continue; }
    const existing = byScene.get(scene);
    if (existing === undefined) { byScene.set(scene, name); continue; }
    const list = ambiguous.get(scene) ?? [existing];
    list.push(name);
    ambiguous.set(scene, list);
    byScene.delete(scene);
  }
  return { byScene, ambiguous, ignored };
}

/** Pure duration validation for a measured value (no execution). */
export function validateMeasuredDuration(seconds: unknown, max = MAX_SCENE_AUDIO_SECONDS): { ok: true; durationSeconds: number } | { ok: false; reason: string } {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return { ok: false, reason: `Measured duration is not a finite number (${String(seconds)}).` };
  if (seconds <= 0) return { ok: false, reason: `Measured duration must be positive (got ${seconds}).` };
  if (seconds > max) return { ok: false, reason: `Measured duration ${seconds}s exceeds the safety limit of ${max}s.` };
  return { ok: true, durationSeconds: Number(seconds.toFixed(3)) };
}

export type AudioFileCheck = { ok: true } | { ok: false; reason: string };

/** Validate an audio path: exists, regular file, supported extension. */
export async function validateAudioFile(audioPath: unknown): Promise<AudioFileCheck> {
  const p = typeof audioPath === 'string' ? audioPath.trim() : '';
  if (!p) return { ok: false, reason: 'Audio path was empty.' };
  const ext = p.slice(p.lastIndexOf('.')).toLowerCase();
  if (!SUPPORTED_AUDIO_EXTENSIONS.includes(ext as any)) return { ok: false, reason: `Unsupported audio extension "${ext}" (expected one of ${SUPPORTED_AUDIO_EXTENSIONS.join(', ')}).` };
  let stat;
  try { stat = await fsp.stat(p); } catch { return { ok: false, reason: `Audio file does not exist: ${p}.` }; }
  if (!stat.isFile()) return { ok: false, reason: `Audio path is not a regular file: ${p}.` };
  return { ok: true };
}

export type ResolvedSceneDuration =
  | { sceneNumber: number; ok: true; audioPath: string; durationSeconds: number; source: 'ffprobe' }
  | { sceneNumber: number; ok: false; reason: 'MISSING_AUDIO' | 'INVALID_AUDIO' | 'AMBIGUOUS_MAPPING' | 'FFPROBE_FAILURE' | 'INVALID_DURATION'; detail?: string };

/**
 * Measure REAL duration with ffprobe. Isolated from the pure logic; uses the same
 * `execFile('ffprobe', …)` convention as edit.ts/mixNarration.ts. The executable is
 * resolved from PATH unless `env.FFPROBE_PATH` overrides it.
 */
export async function measureAudioDuration(audioPath: string): Promise<{ ok: true; durationSeconds: number } | { ok: false; reason: string }> {
  const bin = process.env.FFPROBE_PATH?.trim() || 'ffprobe';
  let stdout = '';
  try {
    ({ stdout } = await exec(bin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath]));
  } catch (e: any) {
    return { ok: false, reason: `ffprobe failed for ${audioPath}: ${String(e?.message ?? e)}` };
  }
  const seconds = Number(String(stdout).trim());
  const valid = validateMeasuredDuration(seconds);
  if (!valid.ok) return { ok: false, reason: valid.reason };
  return { ok: true, durationSeconds: valid.durationSeconds };
}

/**
 * Resolve the REAL duration for one scene from a narration directory.
 * Returns measured provenance (`source: 'ffprobe'`) or an explicit failure classification.
 * Never invents a duration.
 */
export async function resolveSceneNarrationDuration(sceneNumber: number, narrationDir: string): Promise<ResolvedSceneDuration> {
  const n = Number(sceneNumber);
  if (!Number.isInteger(n) || n <= 0) return { sceneNumber: n, ok: false, reason: 'MISSING_AUDIO', detail: `Invalid scene number ${String(sceneNumber)}.` };
  let entries: string[];
  try { entries = await fsp.readdir(narrationDir); } catch (e: any) { return { sceneNumber: n, ok: false, reason: 'MISSING_AUDIO', detail: `Narration directory unavailable: ${String(e?.message ?? e)}` }; }
  const { byScene, ambiguous } = mapNarrationFiles(entries);
  if (ambiguous.has(n)) return { sceneNumber: n, ok: false, reason: 'AMBIGUOUS_MAPPING', detail: `Multiple narration files target scene ${n}: ${JSON.stringify(ambiguous.get(n))}.` };
  const name = byScene.get(n);
  if (!name) return { sceneNumber: n, ok: false, reason: 'MISSING_AUDIO', detail: `No narration-#### audio file for scene ${n}.` };
  const audioPath = `${narrationDir.replace(/[\\/]+$/, '')}/${name}`;
  const check = await validateAudioFile(audioPath);
  if (!check.ok) return { sceneNumber: n, ok: false, reason: 'INVALID_AUDIO', detail: check.reason };
  const measured = await measureAudioDuration(audioPath);
  if (!measured.ok) return { sceneNumber: n, ok: false, reason: /^ffprobe failed/.test(measured.reason) ? 'FFPROBE_FAILURE' : 'INVALID_DURATION', detail: measured.reason };
  return { sceneNumber: n, ok: true, audioPath, durationSeconds: measured.durationSeconds, source: 'ffprobe' };
}

/**
 * Resolve narration durations for many scenes. IMPORTANT: this only READS audio and
 * returns values — it never mutates pipeline.json and never forces the runner to require
 * narration. Callers decide what to do with the results.
 */
export async function resolveNarrationDurations(sceneNumbers: number[], narrationDir: string): Promise<ResolvedSceneDuration[]> {
  const out: ResolvedSceneDuration[] = [];
  for (const n of sceneNumbers) out.push(await resolveSceneNarrationDuration(n, narrationDir));
  return out;
}
