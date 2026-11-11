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

// ---------------------------------------------------------------------------------------
// PHASE 4: richer, READ-ONLY media inspection used by the expanded QA engine.
// `validateClipProbe` above stays the Flow-eligibility contract; this layer only DESCRIBES
// what ffprobe currently reports (frame rate, per-stream durations, start times) so QA can
// explain the difference between expected and actual without duplicating validation rules.
// ---------------------------------------------------------------------------------------

export interface ProbingStream {
  codecType: 'video' | 'audio' | 'other';
  codec: string | null;
  width: number | null;
  height: number | null;
  /** Frames per second from avg_frame_rate (falling back to r_frame_rate); null if unusable. */
  fps: number | null;
  sampleRate: number | null;
  channels: number | null;
  durationSeconds: number | null;
  startTime: number | null;
}

export interface MediaProbe {
  /** ffprobe produced a usable JSON document and at least one stream. */
  readable: boolean;
  reason?: string;
  formatName: string | null;
  formatDurationSeconds: number | null;
  bytes: number | null;
  streams: ProbingStream[];
  video: ProbingStream | null;
  audio: ProbingStream | null;
  /**
   * Machine-readable problems. Known values:
   * `missing_file`, `empty_file`, `no_streams`, `no_video_stream`, `no_audio_stream`,
   * `missing_video_codec`, `missing_audio_codec`, `invalid_duration`.
   */
  problems: string[];
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** PURE: parse a rational frame-rate string ("30000/1001", "25", "0/0"). */
export function parseFrameRate(value: unknown): number | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (match) {
    const numerator = Number(match[1]);
    const denominator = Number(match[2]);
    if (!Number.isFinite(numerator) || denominator === 0) return null;
    const rate = numerator / denominator;
    return Number.isFinite(rate) && rate > 0 ? Number(rate.toFixed(3)) : null;
  }
  const plain = Number(raw);
  return Number.isFinite(plain) && plain > 0 ? Number(plain.toFixed(3)) : null;
}

/** PURE: describe a raw ffprobe JSON document. Never throws. */
export function inspectClipProbe(probe: unknown): MediaProbe {
  const p = probe as any;
  const empty: MediaProbe = {
    readable: false, formatName: null, formatDurationSeconds: null, bytes: null,
    streams: [], video: null, audio: null, problems: [],
  };
  if (!p || typeof p !== 'object') return { ...empty, reason: 'ffprobe returned no usable document.', problems: ['no_streams'] };
  const rawStreams: any[] = Array.isArray(p.streams) ? p.streams : [];
  if (rawStreams.length === 0) return { ...empty, reason: 'Container has no streams.', problems: ['no_streams'] };
  const streams: ProbingStream[] = rawStreams.map((s: any) => {
    const kind = s?.codec_type === 'video' ? 'video' : s?.codec_type === 'audio' ? 'audio' : 'other';
    const fps = kind === 'video'
      ? parseFrameRate(s?.avg_frame_rate) ?? parseFrameRate(s?.r_frame_rate)
      : null;
    return {
      codecType: kind,
      codec: typeof s?.codec_name === 'string' && s.codec_name ? s.codec_name : null,
      width: kind === 'video' ? numberOrNull(s?.width) : null,
      height: kind === 'video' ? numberOrNull(s?.height) : null,
      fps,
      sampleRate: kind === 'audio' ? numberOrNull(s?.sample_rate) : null,
      channels: kind === 'audio' ? numberOrNull(s?.channels) : null,
      durationSeconds: numberOrNull(s?.duration),
      startTime: numberOrNull(s?.start_time),
    };
  });
  const video = streams.find((s) => s.codecType === 'video') ?? null;
  const audio = streams.find((s) => s.codecType === 'audio') ?? null;
  const problems: string[] = [];
  if (!video) problems.push('no_video_stream');
  if (!audio) problems.push('no_audio_stream');
  if (video && !video.codec) problems.push('missing_video_codec');
  if (audio && !audio.codec) problems.push('missing_audio_codec');
  const formatDurationSeconds = numberOrNull(p?.format?.duration);
  let durationSeconds = formatDurationSeconds;
  if (durationSeconds === null) {
    const candidates = streams.map((s) => s.durationSeconds).filter((v): v is number => v !== null && v > 0);
    durationSeconds = candidates.length ? Math.max(...candidates) : null;
  }
  if (durationSeconds === null || durationSeconds <= 0) problems.push('invalid_duration');
  return {
    readable: true,
    formatName: typeof p?.format?.format_name === 'string' ? p.format.format_name : null,
    formatDurationSeconds: durationSeconds,
    bytes: numberOrNull(p?.format?.size),
    streams, video, audio, problems,
  };
}

/**
 * Probe one media file READ-ONLY. Never throws: file problems are returned as `problems`, so
 * the QA engine can always classify them. Uses the same `ffprobe` convention as the rest of
 * the pipeline; no network, no write, no thumbnail.
 */
export async function probeMedia(filePath: string, options: { ffprobePath?: string } = {}): Promise<MediaProbe> {
  const file = String(filePath ?? '').trim();
  const base: MediaProbe = {
    readable: false, formatName: null, formatDurationSeconds: null, bytes: null,
    streams: [], video: null, audio: null, problems: [],
  };
  if (!file) return { ...base, reason: 'Media path was empty.', problems: ['missing_file'] };
  let stat;
  try { stat = await fsp.stat(file); } catch { return { ...base, reason: `File does not exist: ${file}`, problems: ['missing_file'] }; }
  if (!stat.isFile()) return { ...base, bytes: stat.size, reason: 'Path is not a regular file.', problems: ['missing_file'] };
  if (stat.size <= 0) return { ...base, bytes: stat.size, reason: 'File is empty (0 bytes).', problems: ['empty_file'] };

  let probe: any;
  try {
    const { stdout } = await exec(ffprobeBinary(options.ffprobePath), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
    probe = JSON.parse(String(stdout));
  } catch (e: any) {
    return { ...base, bytes: stat.size, reason: `ffprobe could not read the media: ${String(e?.message ?? e)}`, problems: ['no_streams'] };
  }
  const inspected = inspectClipProbe(probe);
  return { ...inspected, bytes: inspected.bytes ?? stat.size };
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
