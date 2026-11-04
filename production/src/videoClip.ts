/**
 * Supplied video-clip validation (STEP-8DE).
 *
 * Validates an externally supplied scene clip (`flow-clips/scene-####.mp4`) against the
 * contract that `edit.ts` requires: a usable VIDEO stream, a usable AUDIO stream, usable
 * dimensions and a positive finite duration. ffprobe execution is isolated from the pure
 * result shaping so the logic is testable without an executable.
 *
 * This module never writes, downloads, transcodes, or contacts Flow.
 */
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Containers we accept for a supplied scene clip (edit.ts consumes mp4). */
export const SUPPORTED_CLIP_EXTENSIONS = ['.mp4', '.m4v'] as const;

/** Minimum usable video dimensions for a scene clip. */
export const MIN_CLIP_WIDTH = 640;
export const MIN_CLIP_HEIGHT = 360;

export type VideoClipState = 'VALID' | 'MISSING' | 'INVALID' | 'UNSUPPORTED' | 'AMBIGUOUS';

export interface ClipStream {
  codec: string;
  width?: number;
  height?: number;
  sampleRate?: string;
  channels?: number;
  durationSeconds?: number;
}

export interface VideoClipResult {
  state: VideoClipState;
  path: string;
  sha256?: string;
  durationSeconds?: number;
  bytes?: number;
  video?: ClipStream;
  audio?: ClipStream;
  reason?: string;
}

/** Resolve the ffprobe binary using the repo's existing convention. */
export function ffprobeBinary(explicit?: string): string {
  return String(explicit || process.env.FFPROBE_PATH || 'ffprobe').trim();
}

/** Pure validation of a raw ffprobe JSON document. No execution. */
export function validateClipProbe(probe: unknown): { ok: true; durationSeconds: number; video: ClipStream; audio: ClipStream } | { ok: false; reason: string } {
  const p = probe as any;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'ffprobe returned no usable document.' };
  const streams: any[] = Array.isArray(p.streams) ? p.streams : [];
  const videos = streams.filter((s) => s?.codec_type === 'video');
  const audios = streams.filter((s) => s?.codec_type === 'audio');
  if (videos.length === 0) return { ok: false, reason: 'Clip has no video stream.' };
  if (audios.length === 0) return { ok: false, reason: 'Clip has no audio stream (edit.ts requires one).' };
  const v = videos[0];
  const a = audios[0];
  const width = Number(v.width), height = Number(v.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { ok: false, reason: `Clip has unusable video dimensions (${v.width}x${v.height}).` };
  if (width < MIN_CLIP_WIDTH || height < MIN_CLIP_HEIGHT) return { ok: false, reason: `Clip resolution ${width}x${height} is below the usable minimum ${MIN_CLIP_WIDTH}x${MIN_CLIP_HEIGHT}.` };
  if (!v.codec_name) return { ok: false, reason: 'Clip video stream has no codec name.' };
  if (!a.codec_name) return { ok: false, reason: 'Clip audio stream has no codec name.' };
  const channels = Number(a.channels);
  if (Number.isFinite(channels) && channels <= 0) return { ok: false, reason: 'Clip audio stream has no channels.' };
  const durationSeconds = Number(p?.format?.duration ?? v.duration ?? a.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return { ok: false, reason: `Clip exposes an invalid duration (${String(p?.format?.duration)}).` };
  return {
    ok: true, durationSeconds: Number(durationSeconds.toFixed(3)),
    video: { codec: String(v.codec_name), width, height },
    audio: { codec: String(a.codec_name), sampleRate: a.sample_rate ? String(a.sample_rate) : undefined, channels: Number.isFinite(channels) ? channels : undefined },
  };
}

/** SHA-256 of a local file (streamed; never loads the whole clip into memory). */
export async function computeFileSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const handle = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let pos = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
      if (bytesRead <= 0) break;
      hash.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
  } finally { await handle.close(); }
  return hash.digest('hex');
}

/**
 * Validate one supplied clip. Fail-closed; never reports VALID on an unusable file.
 * Returns MISSING when the file does not exist, UNSUPPORTED for a bad extension.
 */
export async function validateVideoClip(filePath: string, options: { ffprobePath?: string } = {}): Promise<VideoClipResult> {
  const p = String(filePath ?? '').trim();
  if (!p) return { state: 'INVALID', path: p, reason: 'Clip path was empty.' };
  const ext = p.slice(p.lastIndexOf('.')).toLowerCase();
  if (!SUPPORTED_CLIP_EXTENSIONS.includes(ext as any)) return { state: 'UNSUPPORTED', path: p, reason: `Unsupported clip extension "${ext}" (expected ${SUPPORTED_CLIP_EXTENSIONS.join(', ')}).` };

  let stat;
  try { stat = await fsp.stat(p); } catch { return { state: 'MISSING', path: p, reason: 'Supplied clip does not exist.' }; }
  if (!stat.isFile()) return { state: 'MISSING', path: p, reason: 'Supplied clip path is not a regular file.' };
  if (stat.size <= 0) return { state: 'INVALID', path: p, reason: 'Supplied clip is empty (0 bytes).' };

  let probe: any;
  try {
    const { stdout } = await exec(ffprobeBinary(options.ffprobePath), ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,channels,sample_rate,duration:format=duration', '-of', 'json', p]);
    probe = JSON.parse(String(stdout));
  } catch (e: any) {
    return { state: 'INVALID', path: p, bytes: stat.size, reason: `ffprobe could not read the clip: ${String(e?.message ?? e)}` };
  }

  const valid = validateClipProbe(probe);
  if (!valid.ok) return { state: 'INVALID', path: p, bytes: stat.size, reason: valid.reason };

  let sha256: string | undefined;
  try { sha256 = await computeFileSha256(p); } catch { /* hash is best-effort metadata, validation already succeeded */ }

  return { state: 'VALID', path: p, sha256, durationSeconds: valid.durationSeconds, bytes: stat.size, video: valid.video, audio: valid.audio };
}
