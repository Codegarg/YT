/**
 * READ-ONLY media QA probe (STEP-QA-1).
 *
 * Purpose: answer the questions the pipeline could not answer before rendering was finished —
 * are there black frames, frozen frames, mono/aspect violations, audio clipping or loudness drift?
 *
 * CONTRACT (deliberately narrow):
 *   · It NEVER renders, transcodes, renames, deletes or otherwise writes media. Every ffmpeg
 *     invocation uses `-f null -`, i.e. decode + analyse only.
 *   · It NEVER contacts Flow, the network, OpenAI/Groq, YouTube or Zernio.
 *   · It NEVER approves, publishes or changes project state. Findings are advisory; the caller
 *     decides. Only genuine hard failures (unreadable container, clipped audio, wrong aspect,
 *     duration out of tolerance) produce `severity: 'FAIL'`.
 *   · Branding/logo detection is intentionally OUT of scope (it needs vision/OCR); the report
 *     lists it under `skipped` so the gap is visible instead of silently assumed clean.
 *
 * The parsers below are PURE functions over ffmpeg stderr text so they can be regression-tested
 * without executing ffmpeg, and so a future ffmpeg output tweak fails in ONE tested place.
 */
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { probeMedia } from './videoClip.js';

const exec = promisify(execFile);

export type QaSeverity = 'FAIL' | 'WARN' | 'INFO';

/** PHASE 4 structured check status. `SKIPPED` is explicit, never silently clean. */
export type QaCheckStatus = 'PASS' | 'WARNING' | 'FAIL' | 'SKIPPED';

/**
 * One structured check. The historical `findings` list is kept for backward compatibility;
 * `checks` is the Phase 4 contract (id + expected + actual + remedy) used by the project report
 * and the approval evidence.
 */
export interface QaCheck {
  id: string;
  asset: string;
  status: QaCheckStatus;
  severity: 'BLOCKER' | 'WARNING' | 'INFO' | 'SKIPPED';
  expected?: unknown;
  actual?: unknown;
  explanation: string;
  remedy?: string;
  detail?: Record<string, unknown>;
}

export type QaCode =
  | 'CONTAINER_INVALID'
  | 'MISSING_FILE'
  | 'FILE_EMPTY'
  | 'FILE_TOO_SMALL'
  | 'NO_VIDEO_STREAM'
  | 'NO_AUDIO_STREAM'
  | 'VIDEO_CODEC_MISSING'
  | 'AUDIO_CODEC_MISSING'
  | 'METADATA_INVALID'
  | 'ASPECT_NOT_16_9'
  | 'RESOLUTION_BELOW_MINIMUM'
  | 'BELOW_1080P_TARGET'
  | 'UNEXPECTED_DIMENSIONS'
  | 'UNEXPECTED_FPS'
  | 'DURATION_OUT_OF_TOLERANCE'
  | 'AV_DURATION_MISMATCH'
  | 'BLACK_FRAMES_DETECTED'
  | 'FREEZE_FRAMES_DETECTED'
  | 'AUDIO_CLIPPING'
  | 'TRUE_PEAK_CLIPPING'
  | 'LOUDNESS_OFF_TARGET'
  | 'AUDIO_TOO_QUIET'
  | 'AUDIO_SILENT'
  | 'AUDIO_ENDS_IN_SILENCE'
  | 'AUDIO_MOSTLY_SILENT'
  | 'LOUDNESS_UNMEASURED'
  | 'ANALYSIS_FAILED';

export interface QaFinding {
  code: QaCode;
  severity: QaSeverity;
  message: string;
  detail?: Record<string, unknown>;
}

export interface BlackSegment {
  start: number;
  end: number;
  duration: number;
}

export interface FreezeSegment {
  start: number;
  duration: number;
  end: number;
}

export interface SilenceSegment {
  start: number;
  end: number;
  duration: number;
}

export interface LoudnessReading {
  integratedLufs: number | null;
  rangeLu: number | null;
  truePeakDb: number | null;
}

export interface PeakReading {
  maxVolumeDb: number | null;
  meanVolumeDb: number | null;
  clippedSamples: number | null;
}

export interface MediaQaReport {
  /** True when the probe ran and NO finding has severity FAIL. Warnings do not fail the probe. */
  ok: boolean;
  readOnly: true;
  /** Structured overall status. FAIL if any check failed, WARNING if any warned, else PASS. */
  status: QaCheckStatus;
  input: string;
  /** SHA-256 of the exact bytes that were evaluated (null when unreadable). */
  sha256: string | null;
  bytes: number | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  aspectRatio: number | null;
  fps: number | null;
  audioDurationSeconds: number | null;
  black: { segments: BlackSegment[]; totalSeconds: number } | null;
  freeze: { segments: FreezeSegment[]; totalSeconds: number } | null;
  silence: { segments: SilenceSegment[]; totalSeconds: number } | null;
  loudness: LoudnessReading | null;
  peak: PeakReading | null;
  findings: QaFinding[];
  /** Phase 4 structured checks (every PASS/WARNING/FAIL/SKIPPED is explicit). */
  checks: QaCheck[];
  /** Analyses deliberately not performed by this probe (documented gaps, never silent). */
  skipped: string[];
}

export interface MediaQaOptions {
  input: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  /** Asset kind. `audio` skips picture analyses and does not require a video stream. */
  kind?: 'video' | 'audio';
  /** Integrated-loudness target for spoken content. Default -14 LUFS (matches the narrator chain). */
  targetLufs?: number;
  /** Allowed deviation from `targetLufs`. Default 3 LU. */
  loudnessToleranceLu?: number;
  /** Hard minimum picture height. Default 720. */
  minHeight?: number;
  /** Preferred height; anything below it (but above `minHeight`) is a warning. Default 1080. */
  targetHeight?: number;
  /** Explicit expected width/height. Mismatch is a technical FAIL. */
  expectWidth?: number;
  expectHeight?: number;
  /** Explicit expected frame rate. Mismatch is a technical FAIL (concatenation contract). */
  expectFps?: number;
  /** Absolute frame-rate tolerance. Default 0.05 fps (absorbs 23.976/24 rounding). */
  fpsTolerance?: number;
  /** When supplied, the container duration must be within `±durationToleranceSeconds`. */
  expectDurationSeconds?: number;
  durationToleranceSeconds?: number;
  /** Video assets must carry an audio stream (default true). */
  requireAudio?: boolean;
  /** Video assets must carry a video stream (default true; audio kind defaults false). */
  requireVideo?: boolean;
  /** Optional "unexpectedly small output" floor. Omitted ⇒ the check is SKIPPED. */
  minBytes?: number;
  /** Explicit expected audio stream duration; mismatch is a technical FAIL. */
  expectAudioDurationSeconds?: number;
  /** Maximum tolerated |video − audio| stream duration. Default 0.5 s. */
  avSyncToleranceSeconds?: number;
  /** silencedetect noise floor in dB. Default -50. */
  silenceNoiseDb?: number;
  blackMinSeconds?: number;
  freezeMinSeconds?: number;
  skipBlack?: boolean;
  skipFreeze?: boolean;
  skipAudio?: boolean;
  /** Silence analysis is skipped (e.g. a deliberately silent ambient asset). */
  skipSilence?: boolean;
  /** Accept an entirely silent track as intentional (avoids a false FAIL). Default false. */
  allowAudioSilence?: boolean;
}

export const QA_DEFAULTS = {
  targetLufs: -14,
  loudnessToleranceLu: 3,
  minHeight: 720,
  targetHeight: 1080,
  durationToleranceSeconds: 2,
  blackMinSeconds: 0.5,
  freezeMinSeconds: 3,
  fpsTolerance: 0.05,
  avSyncToleranceSeconds: 0.5,
  silenceNoiseDb: -50,
} as const;

function num(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** PURE: parse `blackdetect` log lines into ordered, non-overlapping segments. */
export function parseBlackDetect(stderr: string): BlackSegment[] {
  const out: BlackSegment[] = [];
  const re = /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)\s+black_duration:\s*([\d.]+)/g;
  for (const match of String(stderr).matchAll(re)) {
    const start = num(match[1]);
    const end = num(match[2]);
    const duration = num(match[3]);
    if (start === null || end === null || duration === null) continue;
    if (duration <= 0) continue;
    out.push({ start, end, duration });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * PURE: parse `freezedetect` log lines.
 *
 * ffmpeg emits `freeze_start` only once a freeze exceeds the configured duration, then
 * `freeze_duration`/`freeze_end` when it ends. A freeze that lasts until EOF may report only
 * `freeze_start`, so an unterminated final segment is closed at `endOfStreamSeconds` (the probed
 * media duration) when supplied — a still shot that runs to the end of the clip IS a freeze.
 */
export function parseFreezeDetect(stderr: string, endOfStreamSeconds?: number | null): FreezeSegment[] {
  const events: Array<{ kind: 'start' | 'duration' | 'end'; at: number; value: number }> = [];
  const text = String(stderr);
  for (const m of text.matchAll(/freeze_start:\s*([\d.]+)/g)) { const v = num(m[1]); if (v !== null) events.push({ kind: 'start', at: m.index ?? 0, value: v }); }
  for (const m of text.matchAll(/freeze_duration:\s*([\d.]+)/g)) { const v = num(m[1]); if (v !== null) events.push({ kind: 'duration', at: m.index ?? 0, value: v }); }
  for (const m of text.matchAll(/freeze_end:\s*([\d.]+)/g)) { const v = num(m[1]); if (v !== null) events.push({ kind: 'end', at: m.index ?? 0, value: v }); }
  events.sort((a, b) => a.at - b.at);

  const out: FreezeSegment[] = [];
  let start: number | null = null;
  let duration: number | null = null;
  const close = (endOverride?: number, useEndOfStream = false) => {
    if (start === null) { duration = null; return; }
    const eos = typeof endOfStreamSeconds === 'number' && Number.isFinite(endOfStreamSeconds) ? endOfStreamSeconds : null;
    const end = endOverride ?? (duration !== null ? start + duration : (useEndOfStream && eos !== null && eos > start ? eos : null));
    if (end !== null) {
      const visible = Math.max(0, end - start);
      if (visible > 0) out.push({ start, duration: visible, end });
    }
    start = null;
    duration = null;
  };
  for (const event of events) {
    if (event.kind === 'start') { close(); start = event.value; duration = null; }
    else if (event.kind === 'duration') { duration = event.value; }
    else { close(event.value); }
  }
  close(undefined, true);
  return out.sort((a, b) => a.start - b.start);
}

/** PURE: parse the `ebur128` summary block (integrated loudness / LRA / true peak). */
export function parseEbur128(stderr: string): LoudnessReading {
  const text = String(stderr);
  const lastOf = (re: RegExp): number | null => {
    let value: number | null = null;
    for (const m of text.matchAll(re)) { const n = num(m[1]); if (n !== null) value = n; }
    return value;
  };
  return {
    integratedLufs: lastOf(/^\s*I:\s*(-?[\d.]+)\s*LUFS/gm),
    rangeLu: lastOf(/^\s*LRA:\s*(-?[\d.]+)\s*LU\b/gm),
    truePeakDb: lastOf(/^\s*Peak:\s*(-?[\d.]+)\s*dBFS/gm),
  };
}

/** PURE: parse `volumedetect` output (peak/mean level and the 0 dB histogram bucket). */
export function parseVolumedetect(stderr: string): PeakReading {
  const text = String(stderr);
  const lastOf = (re: RegExp): number | null => {
    let value: number | null = null;
    for (const m of text.matchAll(re)) { const n = num(m[1]); if (n !== null) value = n; }
    return value;
  };
  return {
    maxVolumeDb: lastOf(/max_volume:\s*(-?[\d.]+)\s*dB/g),
    meanVolumeDb: lastOf(/mean_volume:\s*(-?[\d.]+)\s*dB/g),
    clippedSamples: lastOf(/histogram_0db:\s*(\d+)/g),
  };
}

/** PURE: parse `silencedetect` output into start/end/duration segments. */
export function parseSilenceDetect(stderr: string): SilenceSegment[] {
  const text = String(stderr);
  const segments: SilenceSegment[] = [];
  let openStart: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (startMatch) {
      const value = num(startMatch[1]);
      if (value !== null) openStart = Math.max(0, value);
      continue;
    }
    const endMatch = line.match(/silence_end:\s*(-?[\d.]+)(?:\s*\|\s*silence_duration:\s*(-?[\d.]+))?/);
    if (endMatch) {
      const end = num(endMatch[1]);
      const duration = num(endMatch[2] ?? '');
      if (end !== null) {
        const begin = openStart ?? Math.max(0, end - (duration ?? 0));
        const span = duration ?? Math.max(0, end - begin);
        segments.push({ start: Number(begin.toFixed(3)), end: Number(end.toFixed(3)), duration: Number(span.toFixed(3)) });
      }
      openStart = null;
    }
  }
  return segments;
}

export interface EvaluatedClip {
  state: string;
  reason?: string;
  bytes?: number;
  sha256?: string | null;
  durationSeconds?: number;
  /** Explicit `null` means "the stream is absent"; `undefined` means "not inspected". */
  video?: { width?: number; height?: number; codec?: string | null; fps?: number | null; durationSeconds?: number | null } | null;
  audio?: { codec?: string | null; durationSeconds?: number | null; channels?: number | null } | null;
  problems?: string[];
}

export interface EvaluateMediaQaInput {
  input: string;
  clip: EvaluatedClip;
  black?: BlackSegment[] | null;
  freeze?: FreezeSegment[] | null;
  silence?: SilenceSegment[] | null;
  loudness?: LoudnessReading | null;
  peak?: PeakReading | null;
  analysisErrors?: string[];
  options?: Partial<Omit<MediaQaOptions, 'input'>>;
}

/** Map a finding code onto the stable Phase 4 check id. */
const CHECK_ID: Record<QaCode, string> = {
  CONTAINER_INVALID: 'container.readable',
  MISSING_FILE: 'file.exists',
  FILE_EMPTY: 'file.nonempty',
  FILE_TOO_SMALL: 'file.size',
  NO_VIDEO_STREAM: 'video.stream',
  NO_AUDIO_STREAM: 'audio.stream',
  VIDEO_CODEC_MISSING: 'video.codec',
  AUDIO_CODEC_MISSING: 'audio.codec',
  METADATA_INVALID: 'metadata.timestamps',
  ASPECT_NOT_16_9: 'video.aspect',
  RESOLUTION_BELOW_MINIMUM: 'video.dimensions',
  BELOW_1080P_TARGET: 'video.target_height',
  UNEXPECTED_DIMENSIONS: 'video.dimensions',
  UNEXPECTED_FPS: 'video.fps',
  DURATION_OUT_OF_TOLERANCE: 'duration.expected',
  AV_DURATION_MISMATCH: 'av.duration_match',
  BLACK_FRAMES_DETECTED: 'visual.black',
  FREEZE_FRAMES_DETECTED: 'visual.freeze',
  AUDIO_CLIPPING: 'audio.clipping',
  TRUE_PEAK_CLIPPING: 'audio.true_peak',
  LOUDNESS_OFF_TARGET: 'audio.loudness',
  AUDIO_TOO_QUIET: 'audio.loudness',
  AUDIO_SILENT: 'audio.silence',
  AUDIO_ENDS_IN_SILENCE: 'audio.silence',
  AUDIO_MOSTLY_SILENT: 'audio.silence',
  LOUDNESS_UNMEASURED: 'audio.loudness',
  ANALYSIS_FAILED: 'analysis.errors',
};

const REMEDY: Partial<Record<QaCode, string>> = {
  CONTAINER_INVALID: 'Re-export or re-download the asset; verify the file is a complete, supported media container.',
  MISSING_FILE: 'Regenerate or supply the missing asset; a missing file can never be approved.',
  FILE_EMPTY: 'Re-render the asset; a zero-byte file is a failed write.',
  FILE_TOO_SMALL: 'Inspect the render; a suspiciously small file usually means a truncated encode.',
  NO_VIDEO_STREAM: 'Re-export with a video stream, or mark the asset as audio-only if that is intentional.',
  NO_AUDIO_STREAM: 'Re-export with the required audio stream; silent video is not a finished programme.',
  VIDEO_CODEC_MISSING: 'Re-encode with a supported video codec (h264/h265).',
  AUDIO_CODEC_MISSING: 'Re-encode with a supported audio codec (aac/pcm).',
  METADATA_INVALID: 'Remux/re-encode so the container exposes a valid duration and timestamps.',
  ASPECT_NOT_16_9: 'Render at 16:9 (1280x720 or 1920x1080); do not crop a square source.',
  RESOLUTION_BELOW_MINIMUM: 'Render at a higher resolution (minimum 720p for the channel).',
  BELOW_1080P_TARGET: 'Render at 1080p when the source permits it.',
  UNEXPECTED_DIMENSIONS: 'Re-render at the expected dimensions, or update the configured contract deliberately.',
  UNEXPECTED_FPS: 'Re-render at the expected frame rate so concatenation timing stays correct.',
  DURATION_OUT_OF_TOLERANCE: 'Re-render to the expected programme length, or confirm the configured duration.',
  AV_DURATION_MISMATCH: 'Re-mux/re-render so picture and sound cover the same span (check for a cut-off audio stream).',
  BLACK_FRAMES_DETECTED: 'Confirm each black stretch is an intentional fade; otherwise fix the render.',
  FREEZE_FRAMES_DETECTED: 'Confirm each still is intentional; otherwise re-render the stalled stretch.',
  AUDIO_CLIPPING: 'Lower the limiter ceiling / re-mix so no samples sit at 0 dBFS.',
  TRUE_PEAK_CLIPPING: 'Lower the limiter ceiling to about -1 dBTP and re-render the master.',
  LOUDNESS_OFF_TARGET: 'Re-normalise to the spoken-content loudness target (-14 LUFS).',
  AUDIO_TOO_QUIET: 'Raise the narration level or re-run the compressor/limiter chain.',
  AUDIO_SILENT: 'Supply or re-render the audio; a completely silent track is a failed asset.',
  AUDIO_ENDS_IN_SILENCE: 'Confirm the trailing silence is intentional; otherwise fix the audio cut.',
  AUDIO_MOSTLY_SILENT: 'Check the mix; most of the programme has no audible content.',
  LOUDNESS_UNMEASURED: 'Inspect the audio stream; loudness could not be measured.',
  ANALYSIS_FAILED: 'Inspect the ffmpeg log; the analysis step did not complete.',
};

/** PURE: turn measurements into findings + structured checks. No I/O. */
export function evaluateMediaQa(input: EvaluateMediaQaInput): MediaQaReport {
  const opts: Partial<Omit<MediaQaOptions, 'input'>> = input.options ?? {};
  const kind = opts.kind ?? 'video';
  const requireVideo = opts.requireVideo ?? (kind === 'video');
  const requireAudio = opts.requireAudio ?? true;
  const targetLufs = opts.targetLufs ?? QA_DEFAULTS.targetLufs;
  const tolerance = opts.loudnessToleranceLu ?? QA_DEFAULTS.loudnessToleranceLu;
  const minHeight = opts.minHeight ?? QA_DEFAULTS.minHeight;
  const targetHeight = opts.targetHeight ?? QA_DEFAULTS.targetHeight;
  const fpsTolerance = opts.fpsTolerance ?? QA_DEFAULTS.fpsTolerance;
  const avTolerance = opts.avSyncToleranceSeconds ?? QA_DEFAULTS.avSyncToleranceSeconds;
  const findings: QaFinding[] = [];
  const skipped: string[] = ['branding_detection (needs vision/OCR; review the frame manually)'];

  const has = (key: keyof EvaluatedClip) => Object.prototype.hasOwnProperty.call(input.clip, key);
  const width = input.clip.video?.width ?? null;
  const height = input.clip.video?.height ?? null;
  const fps = input.clip.video?.fps ?? null;
  const durationSeconds = typeof input.clip.durationSeconds === 'number' ? input.clip.durationSeconds : null;
  const aspectRatio = width && height ? Number((width / height).toFixed(4)) : null;
  const audioDurationSeconds = typeof input.clip.audio?.durationSeconds === 'number' ? input.clip.audio.durationSeconds : null;

  if (input.clip.state !== 'VALID') {
    findings.push({ code: 'CONTAINER_INVALID', severity: 'FAIL', message: `Clip is not a usable media container (${input.clip.state}): ${String(input.clip.reason ?? '').slice(0, 180)}` });
    // Specific reasons are additive so consumers can act on them (the generic code stays first
    // for backward compatibility with older reports/tests).
    for (const problem of input.clip.problems ?? []) {
      if (problem === 'missing_file') findings.push({ code: 'MISSING_FILE', severity: 'FAIL', message: 'The media file does not exist or is not a regular file.' });
      else if (problem === 'empty_file') findings.push({ code: 'FILE_EMPTY', severity: 'FAIL', message: 'The media file is empty (0 bytes).' });
      else if (problem === 'no_video_stream' && requireVideo) findings.push({ code: 'NO_VIDEO_STREAM', severity: 'FAIL', message: 'The container has no video stream.' });
      else if (problem === 'no_audio_stream' && requireAudio) findings.push({ code: 'NO_AUDIO_STREAM', severity: 'FAIL', message: 'The container has no audio stream.' });
      else if (problem === 'missing_video_codec') findings.push({ code: 'VIDEO_CODEC_MISSING', severity: 'FAIL', message: 'The video stream has no codec name.' });
      else if (problem === 'missing_audio_codec') findings.push({ code: 'AUDIO_CODEC_MISSING', severity: 'FAIL', message: 'The audio stream has no codec name.' });
      else if (problem === 'invalid_duration') findings.push({ code: 'METADATA_INVALID', severity: 'WARN', message: 'The container does not expose a positive duration.' });
    }
    if (typeof input.clip.bytes === 'number' && input.clip.bytes === 0 && !findings.some((f) => f.code === 'FILE_EMPTY')) {
      findings.push({ code: 'FILE_EMPTY', severity: 'FAIL', message: 'The media file is empty (0 bytes).' });
    }
    return buildReport(input, { findings, skipped, width, height, fps, durationSeconds, audioDurationSeconds, aspectRatio, kind, requireVideo, requireAudio });
  }

  // ---- container metadata (valid container, suspect metadata) ----
  if ((input.clip.problems ?? []).includes('invalid_duration')) {
    findings.push({ code: 'METADATA_INVALID', severity: 'WARN', message: 'The container does not expose a positive duration; timestamps may be malformed.' });
  }

  // ---- file size ----
  if (typeof opts.minBytes === 'number' && typeof input.clip.bytes === 'number' && input.clip.bytes < opts.minBytes) {
    findings.push({ code: 'FILE_TOO_SMALL', severity: 'FAIL', message: `File is ${input.clip.bytes} bytes, below the configured ${opts.minBytes}-byte floor.`, detail: { bytes: input.clip.bytes, minBytes: opts.minBytes } });
  }

  // ---- picture ----
  if (has('video') && input.clip.video === null && requireVideo) {
    findings.push({ code: 'NO_VIDEO_STREAM', severity: 'FAIL', message: 'The container has no video stream.' });
  }
  if (kind === 'video' && has('video') && input.clip.video) {
    if (typeof opts.expectWidth === 'number' || typeof opts.expectHeight === 'number') {
      const expW = opts.expectWidth;
      const expH = opts.expectHeight;
      const mismatch = (typeof expW === 'number' && width !== expW) || (typeof expH === 'number' && height !== expH);
      if (mismatch) {
        findings.push({ code: 'UNEXPECTED_DIMENSIONS', severity: 'FAIL', message: `Picture is ${width ?? '?'}x${height ?? '?'}, expected ${expW ?? '?'}x${expH ?? '?'}.`, detail: { width, height, expectedWidth: expW ?? null, expectedHeight: expH ?? null } });
      }
    } else {
      if (aspectRatio !== null && Math.abs(aspectRatio - 16 / 9) > 0.02) {
        findings.push({ code: 'ASPECT_NOT_16_9', severity: 'FAIL', message: `Aspect ratio is ${aspectRatio} (${width}x${height}); the channel contract is 16:9.`, detail: { width, height, aspectRatio } });
      }
      if (height !== null && height < minHeight) {
        findings.push({ code: 'RESOLUTION_BELOW_MINIMUM', severity: 'FAIL', message: `Picture height ${height}px is below the ${minHeight}px minimum.`, detail: { height, minHeight } });
      } else if (height !== null && height < targetHeight) {
        findings.push({ code: 'BELOW_1080P_TARGET', severity: 'WARN', message: `Picture height ${height}px is below the ${targetHeight}p target (source quality may not permit it).`, detail: { height, targetHeight } });
      }
    }
    if (typeof opts.expectFps === 'number') {
      const expected = opts.expectFps;
      if (fps === null) {
        findings.push({ code: 'UNEXPECTED_FPS', severity: 'FAIL', message: `Frame rate could not be measured; expected ${expected} fps.`, detail: { expected } });
      } else if (Math.abs(fps - expected) > fpsTolerance) {
        findings.push({ code: 'UNEXPECTED_FPS', severity: 'FAIL', message: `Frame rate is ${fps} fps, expected ${expected} fps ± ${fpsTolerance}.`, detail: { fps, expected, tolerance: fpsTolerance } });
      }
    }
  }

  // ---- audio stream presence ----
  if (has('audio') && input.clip.audio === null && requireAudio) {
    findings.push({ code: 'NO_AUDIO_STREAM', severity: 'FAIL', message: 'The container has no audio stream (one is required for this asset).' });
  }

  // ---- duration contract ----
  const expect = opts.expectDurationSeconds;
  if (typeof expect === 'number') {
    const tol = opts.durationToleranceSeconds ?? QA_DEFAULTS.durationToleranceSeconds;
    if (durationSeconds === null || Math.abs(durationSeconds - expect) > tol) {
      findings.push({ code: 'DURATION_OUT_OF_TOLERANCE', severity: 'FAIL', message: `Duration ${durationSeconds ?? 'unknown'}s is outside ${expect}s ± ${tol}s.`, detail: { durationSeconds, expected: expect, tolerance: tol } });
    }
  }

  // ---- audio/video alignment ----
  const videoDuration = typeof input.clip.video?.durationSeconds === 'number' ? input.clip.video.durationSeconds : null;
  const audioDuration = audioDurationSeconds;
  if (typeof opts.expectAudioDurationSeconds === 'number') {
    const tol = opts.durationToleranceSeconds ?? QA_DEFAULTS.durationToleranceSeconds;
    if (audioDuration === null || Math.abs(audioDuration - opts.expectAudioDurationSeconds) > tol) {
      findings.push({ code: 'AV_DURATION_MISMATCH', severity: 'FAIL', message: `Audio duration ${audioDuration ?? 'unknown'}s does not match the expected ${opts.expectAudioDurationSeconds}s ± ${tol}s.`, detail: { audioDurationSeconds: audioDuration, expectedAudioDurationSeconds: opts.expectAudioDurationSeconds } });
    }
  } else if (videoDuration !== null && audioDuration !== null && Math.abs(videoDuration - audioDuration) > avTolerance) {
    findings.push({ code: 'AV_DURATION_MISMATCH', severity: 'FAIL', message: `Video stream is ${videoDuration}s but audio stream is ${audioDuration}s; the streams do not cover the same span.`, detail: { videoDurationSeconds: videoDuration, audioDurationSeconds: audioDuration, tolerance: avTolerance } });
  }

  // ---- visual pauses (never a hard failure: horror deliberately uses dark/still frames) ----
  if (input.black && input.black.length > 0) {
    const totalSeconds = Number(input.black.reduce((sum, s) => sum + s.duration, 0).toFixed(3));
    findings.push({
      code: 'BLACK_FRAMES_DETECTED', severity: 'WARN',
      message: `${input.black.length} black segment(s) totalling ${totalSeconds}s detected; confirm they are intentional fades.`,
      detail: { totalSeconds, segments: input.black.slice(0, 20) },
    });
  }
  if (input.freeze && input.freeze.length > 0) {
    const totalSeconds = Number(input.freeze.reduce((sum, s) => sum + s.duration, 0).toFixed(3));
    findings.push({
      code: 'FREEZE_FRAMES_DETECTED', severity: 'WARN',
      message: `${input.freeze.length} frozen segment(s) totalling ${totalSeconds}s detected; confirm no stalled/corrupt stretch shipped.`,
      detail: { totalSeconds, segments: input.freeze.slice(0, 20) },
    });
  }

  // ---- loudness / clipping ----
  const loudness = input.loudness ?? null;
  if (loudness) {
    if (loudness.integratedLufs === null) {
      findings.push({ code: 'LOUDNESS_UNMEASURED', severity: 'WARN', message: 'Integrated loudness could not be measured from the ebur128 summary.' });
    } else {
      if (Math.abs(loudness.integratedLufs - targetLufs) > tolerance) {
        findings.push({ code: 'LOUDNESS_OFF_TARGET', severity: 'WARN', message: `Integrated loudness ${loudness.integratedLufs} LUFS is outside ${targetLufs} ± ${tolerance} LUFS.`, detail: { integratedLufs: loudness.integratedLufs, targetLufs, tolerance } });
      }
      if (loudness.integratedLufs < -24) {
        findings.push({ code: 'AUDIO_TOO_QUIET', severity: 'WARN', message: `Integrated loudness ${loudness.integratedLufs} LUFS is very quiet for spoken content.`, detail: { integratedLufs: loudness.integratedLufs } });
      }
    }
    if (loudness.truePeakDb !== null && loudness.truePeakDb >= -0.1) {
      findings.push({ code: 'TRUE_PEAK_CLIPPING', severity: 'FAIL', message: `True peak ${loudness.truePeakDb} dBFS reaches full scale; lower the limiter ceiling.`, detail: { truePeakDb: loudness.truePeakDb } });
    }
  }

  const peak = input.peak ?? null;
  if (peak) {
    if ((peak.clippedSamples ?? 0) > 0) {
      findings.push({ code: 'AUDIO_CLIPPING', severity: 'FAIL', message: `${peak.clippedSamples} sample(s) sit at 0 dBFS (histogram_0db); the mix is clipping.`, detail: { clippedSamples: peak.clippedSamples, maxVolumeDb: peak.maxVolumeDb } });
    } else if (peak.maxVolumeDb !== null && peak.maxVolumeDb >= -0.1) {
      findings.push({ code: 'AUDIO_CLIPPING', severity: 'FAIL', message: `Sample peak ${peak.maxVolumeDb} dBFS reaches full scale; the mix is clipping.`, detail: { maxVolumeDb: peak.maxVolumeDb } });
    }
  }

  // ---- intentional-silence-aware analysis ----
  if (input.silence && !opts.skipSilence) {
    const segments = input.silence;
    const totalSeconds = Number(segments.reduce((sum, s) => sum + s.duration, 0).toFixed(3));
    const span = durationSeconds ?? audioDurationSeconds;
    const last = segments.length ? segments[segments.length - 1] : null;
    const wholeTrackSilent = segments.length === 1 && segments[0].start <= 0.15 && span !== null && segments[0].end >= span - 0.25;
    if (wholeTrackSilent && !opts.allowAudioSilence) {
      findings.push({ code: 'AUDIO_SILENT', severity: 'FAIL', message: 'The audio track is silent for its whole duration.', detail: { totalSeconds } });
    } else if (last && span !== null && last.end >= span - 0.25 && last.duration >= 2) {
      findings.push({ code: 'AUDIO_ENDS_IN_SILENCE', severity: 'WARN', message: `The audio ends with ${last.duration}s of silence; confirm the ending is intentional.`, detail: { trailingSeconds: last.duration } });
    } else if (span !== null && span > 5 && totalSeconds / span > 0.6 && !opts.allowAudioSilence) {
      findings.push({ code: 'AUDIO_MOSTLY_SILENT', severity: 'WARN', message: `${Math.round((totalSeconds / span) * 100)}% of the audio is silent; check the mix.`, detail: { totalSeconds, span } });
    }
  }

  for (const error of input.analysisErrors ?? []) {
    findings.push({ code: 'ANALYSIS_FAILED', severity: 'WARN', message: `A media analysis step could not complete: ${String(error).slice(0, 200)}` });
  }

  return buildReport(input, { findings, skipped, width, height, fps, durationSeconds, audioDurationSeconds, aspectRatio, kind, requireVideo, requireAudio });
}

/** PURE: expose the expected/actual pair of a finding as structured check fields. */
function expectedActualOf(code: QaCode, detail: Record<string, unknown> | undefined): { expected?: unknown; actual?: unknown } {
  if (!detail) return {};
  const d = detail as Record<string, any>;
  switch (code) {
    case 'UNEXPECTED_DIMENSIONS':
      return { expected: `${d.expectedWidth ?? '?'}x${d.expectedHeight ?? '?'}`, actual: `${d.width ?? '?'}x${d.height ?? '?'}` };
    case 'UNEXPECTED_FPS':
      return { expected: d.expected, actual: d.fps ?? 'unmeasured' };
    case 'DURATION_OUT_OF_TOLERANCE':
      return { expected: `${d.expected}s ± ${d.tolerance}s`, actual: d.durationSeconds ?? 'unknown' };
    case 'AV_DURATION_MISMATCH':
      return d.expectedAudioDurationSeconds !== undefined
        ? { expected: d.expectedAudioDurationSeconds, actual: d.audioDurationSeconds ?? 'unknown' }
        : { expected: `video/audio within ${d.tolerance}s`, actual: { video: d.videoDurationSeconds, audio: d.audioDurationSeconds } };
    case 'ASPECT_NOT_16_9':
      return { expected: '16:9', actual: d.aspectRatio };
    case 'RESOLUTION_BELOW_MINIMUM':
      return { expected: `>= ${d.minHeight}px height`, actual: `${d.height}px` };
    case 'BELOW_1080P_TARGET':
      return { expected: `>= ${d.targetHeight}px height`, actual: `${d.height}px` };
    case 'FILE_TOO_SMALL':
      return { expected: `>= ${d.minBytes} bytes`, actual: d.bytes };
    case 'AUDIO_CLIPPING':
      return { expected: '0 clipped samples', actual: d.clippedSamples ?? d.maxVolumeDb };
    case 'TRUE_PEAK_CLIPPING':
      return { expected: '< -0.1 dBFS true peak', actual: d.truePeakDb };
    case 'LOUDNESS_OFF_TARGET':
      return { expected: `${d.targetLufs} LUFS ± ${d.tolerance}`, actual: d.integratedLufs };
    case 'AUDIO_TOO_QUIET':
      return { expected: '>= -24 LUFS', actual: d.integratedLufs };
    case 'BLACK_FRAMES_DETECTED':
      return { expected: 'no black segment', actual: { segments: d.segments?.length ?? 0, totalSeconds: d.totalSeconds } };
    case 'FREEZE_FRAMES_DETECTED':
      return { expected: 'no frozen segment', actual: { segments: d.segments?.length ?? 0, totalSeconds: d.totalSeconds } };
    case 'AUDIO_SILENT':
      return { expected: 'audible audio', actual: 'silent' };
    case 'AUDIO_ENDS_IN_SILENCE':
      return { expected: 'intentional ending', actual: `${d.trailingSeconds}s trailing silence` };
    case 'AUDIO_MOSTLY_SILENT':
      return { expected: 'mostly audible', actual: `${d.totalSeconds}s of ${d.span}s silent` };
    default:
      return {};
  }
}

/** Shape the report + derive the structured checks from the findings. PURE. */
function buildReport(
  input: EvaluateMediaQaInput,
  state: {
    findings: QaFinding[]; skipped: string[]; width: number | null; height: number | null;
    fps: number | null; durationSeconds: number | null; audioDurationSeconds: number | null;
    aspectRatio: number | null; kind: 'video' | 'audio'; requireVideo: boolean; requireAudio: boolean;
  },
): MediaQaReport {
  const opts = input.options ?? {};
  const checks: QaCheck[] = [];
  const seenIds = new Map<string, number>();
  for (const finding of state.findings) {
    const base = CHECK_ID[finding.code] ?? finding.code.toLowerCase();
    const count = (seenIds.get(base) ?? 0) + 1;
    seenIds.set(base, count);
    checks.push({
      id: count > 1 ? `${base}#${count}` : base,
      asset: input.input,
      status: finding.severity === 'FAIL' ? 'FAIL' : 'WARNING',
      severity: finding.severity === 'FAIL' ? 'BLOCKER' : 'WARNING',
      explanation: finding.message,
      ...expectedActualOf(finding.code, finding.detail),
      ...(finding.detail ? { detail: finding.detail } : {}),
      ...(REMEDY[finding.code] ? { remedy: REMEDY[finding.code] } : {}),
    });
  }

  // Explicit PASS/SKIPPED rows make the report auditable (nothing silently absent).
  const pass = (id: string, explanation: string, extra: Partial<QaCheck> = {}) => {
    if (checks.some((c) => c.id === id || c.id.startsWith(`${id}#`))) return;
    checks.push({ id, asset: input.input, status: 'PASS', severity: 'INFO', explanation, ...extra });
  };
  const skip = (id: string, explanation: string) => {
    if (checks.some((c) => c.id === id || c.id.startsWith(`${id}#`))) return;
    checks.push({ id, asset: input.input, status: 'SKIPPED', severity: 'SKIPPED', explanation });
  };

  pass('container.readable', `Container is readable (${input.clip.state}).`);
  if (typeof opts.minBytes === 'number') {
    pass('file.size', `File is ${input.clip.bytes ?? '?'} bytes (floor ${opts.minBytes}).`, { expected: `>= ${opts.minBytes} bytes`, actual: input.clip.bytes ?? null });
  } else {
    skip('file.size', 'No size floor configured; empty files are still rejected.');
  }
  if (state.kind === 'video') {
    pass('video.stream', 'A video stream is present.', { expected: 'present', actual: 'present' });
    pass('video.dimensions', `Picture is ${state.width ?? '?'}x${state.height ?? '?'}.`, { actual: `${state.width ?? '?'}x${state.height ?? '?'}` });
    pass('video.aspect', `Aspect ratio is ${state.aspectRatio ?? '?'}.`, { expected: 16 / 9, actual: state.aspectRatio });
    if (state.fps !== null) pass('video.fps', `Frame rate is ${state.fps} fps.`, { actual: state.fps });
    else skip('video.fps', 'Frame rate was not exposed by the container.');
    if (input.black && input.black.length === 0) pass('visual.black', 'No black segment at or above the detection threshold.');
    else if (input.black === undefined || input.black === null) skip('visual.black', 'blackdetect was not run for this asset.');
    if (input.freeze && input.freeze.length === 0) pass('visual.freeze', 'No frozen segment at or above the detection threshold.');
    else if (input.freeze === undefined || input.freeze === null) skip('visual.freeze', 'freezedetect was not run for this asset.');
  } else {
    skip('video.stream', 'Audio-only asset: no video stream is required.');
    skip('video.dimensions', 'Audio-only asset.');
    skip('video.aspect', 'Audio-only asset.');
    skip('video.fps', 'Audio-only asset.');
    skip('visual.black', 'Audio-only asset.');
    skip('visual.freeze', 'Audio-only asset.');
  }
  if (state.requireAudio) pass('audio.stream', 'An audio stream is present.', { expected: 'present', actual: 'present' });
  else skip('audio.stream', 'Audio is optional for this asset.');
  if (input.loudness) pass('audio.loudness', `Integrated loudness ${input.loudness.integratedLufs ?? '?'} LUFS.`, { actual: input.loudness.integratedLufs });
  else skip('audio.loudness', 'Audio analysis was skipped for this asset.');
  if (input.peak) pass('audio.clipping', `Sample peak ${input.peak.maxVolumeDb ?? '?'} dB, ${input.peak.clippedSamples ?? '?'} clipped sample(s).`, { actual: input.peak.maxVolumeDb });
  else skip('audio.clipping', 'Audio analysis was skipped for this asset.');
  if (input.silence && input.silence.length === 0) pass('audio.silence', 'No silent segment at or above the detection threshold.');
  else if (!input.silence) skip('audio.silence', 'silencedetect was not run for this asset.');

  const status: QaCheckStatus = checks.some((c) => c.status === 'FAIL')
    ? 'FAIL'
    : checks.some((c) => c.status === 'WARNING') ? 'WARNING' : 'PASS';

  const black = input.black ? { segments: input.black, totalSeconds: Number(input.black.reduce((s, x) => s + x.duration, 0).toFixed(3)) } : null;
  const freeze = input.freeze ? { segments: input.freeze, totalSeconds: Number(input.freeze.reduce((s, x) => s + x.duration, 0).toFixed(3)) } : null;
  const silence = input.silence ? { segments: input.silence, totalSeconds: Number(input.silence.reduce((s, x) => s + x.duration, 0).toFixed(3)) } : null;

  return {
    ok: !state.findings.some((f) => f.severity === 'FAIL'),
    readOnly: true,
    status,
    input: input.input,
    sha256: input.clip.sha256 ?? null,
    bytes: input.clip.bytes ?? null,
    durationSeconds: state.durationSeconds, width: state.width, height: state.height,
    aspectRatio: state.aspectRatio, fps: state.fps, audioDurationSeconds: state.audioDurationSeconds,
    black, freeze, silence,
    loudness: input.loudness ?? null, peak: input.peak ?? null,
    findings: state.findings, checks, skipped: state.skipped,
  };
}

function ffmpegBinary(explicit?: string): string {
  return String(explicit || process.env.FFMPEG_PATH || 'ffmpeg').trim();
}

/** Run one read-only analysis pass. Never writes: output is always `-f null -`. */
async function analyse(bin: string, args: string[]): Promise<{ stderr: string; error?: string }> {
  try {
    const { stderr } = await exec(bin, args, { maxBuffer: 1024 * 1024 * 32 });
    return { stderr: String(stderr ?? '') };
  } catch (e: any) {
    // ffmpeg exits non-zero on some benign filter runs; keep whatever it logged and report the rest.
    const stderr = String(e?.stderr ?? '');
    return { stderr, error: String(e?.message ?? e) };
  }
}

/** SHA-256 of the exact bytes evaluated, so approval can bind QA to one artifact. Read-only. */
async function sha256OfFile(filePath: string): Promise<string | null> {
  try {
    const buf = await fsp.readFile(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Probe one media file. READ-ONLY by construction. Never throws for media content problems —
 * an unreadable file becomes a FAIL finding so the caller always gets a report.
 */
export async function runMediaQa(options: MediaQaOptions): Promise<MediaQaReport> {
  const opts: MediaQaOptions = { ...options };
  const input = String(opts.input ?? '').trim();
  const probe = await probeMedia(input, { ffprobePath: opts.ffprobePath });

  if (!probe.readable) {
    // Keep the historical first finding (`CONTAINER_INVALID`) and add the specific reason.
    const missing = probe.problems.includes('missing_file');
    return evaluateMediaQa({
      input,
      clip: {
        state: missing ? 'MISSING' : 'INVALID',
        reason: probe.reason,
        bytes: probe.bytes ?? undefined,
        problems: probe.problems,
      },
      options: opts,
    });
  }

  const clip: EvaluatedClip = {
    state: 'VALID',
    bytes: probe.bytes ?? undefined,
    sha256: await sha256OfFile(input),
    durationSeconds: probe.formatDurationSeconds ?? undefined,
    video: probe.video
      ? {
        width: probe.video.width ?? undefined,
        height: probe.video.height ?? undefined,
        codec: probe.video.codec,
        fps: probe.video.fps,
        durationSeconds: probe.video.durationSeconds,
      }
      : null,
    audio: probe.audio
      ? { codec: probe.audio.codec, durationSeconds: probe.audio.durationSeconds, channels: probe.audio.channels }
      : null,
    problems: probe.problems,
  };

  const bin = ffmpegBinary(opts.ffmpegPath);
  const analysisErrors: string[] = [];
  let black: BlackSegment[] | null = null;
  let freeze: FreezeSegment[] | null = null;
  let silence: SilenceSegment[] | null = null;
  let loudness: LoudnessReading | null = null;
  let peak: PeakReading | null = null;

  const base = ['-hide_banner', '-nostats', '-v', 'info', '-i', input];
  const hasVideo = clip.video !== null;
  const hasAudio = clip.audio !== null;
  const kind = opts.kind ?? 'video';

  if (kind === 'video' && hasVideo && !opts.skipBlack) {
    const blackMin = opts.blackMinSeconds ?? QA_DEFAULTS.blackMinSeconds;
    const res = await analyse(bin, [...base, '-map', '0:v:0', '-an', '-vf', `blackdetect=d=${blackMin}:pix_th=0.10`, '-f', 'null', '-']);
    black = parseBlackDetect(res.stderr);
    if (res.error) analysisErrors.push(`blackdetect: ${res.error}`);
  }

  if (kind === 'video' && hasVideo && !opts.skipFreeze) {
    const freezeMin = opts.freezeMinSeconds ?? QA_DEFAULTS.freezeMinSeconds;
    const res = await analyse(bin, [...base, '-map', '0:v:0', '-an', '-vf', `freezedetect=n=-60dB:d=${freezeMin}`, '-f', 'null', '-']);
    freeze = parseFreezeDetect(res.stderr, probe.formatDurationSeconds);
    if (res.error) analysisErrors.push(`freezedetect: ${res.error}`);
  }

  if (hasAudio && !opts.skipAudio) {
    const loud = await analyse(bin, [...base, '-map', '0:a:0', '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
    loudness = parseEbur128(loud.stderr);
    if (loud.error) analysisErrors.push(`ebur128: ${loud.error}`);

    const vol = await analyse(bin, [...base, '-map', '0:a:0', '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
    peak = parseVolumedetect(vol.stderr);
    if (vol.error) analysisErrors.push(`volumedetect: ${vol.error}`);

    if (!opts.skipSilence) {
      const noise = opts.silenceNoiseDb ?? QA_DEFAULTS.silenceNoiseDb;
      const sil = await analyse(bin, [...base, '-map', '0:a:0', '-vn', '-af', `silencedetect=noise=${noise}dB:d=1.0`, '-f', 'null', '-']);
      silence = parseSilenceDetect(sil.stderr);
      if (sil.error) analysisErrors.push(`silencedetect: ${sil.error}`);
    }
  }

  return evaluateMediaQa({ input, clip, black, freeze, silence, loudness, peak, analysisErrors, options: opts });
}

/** Human-readable, single-screen summary. Pure. */
export function renderMediaQaReport(report: MediaQaReport): string {
  const lines: string[] = [];
  const blockers = report.checks.filter((c) => c.status === 'FAIL').length;
  const warnings = report.checks.filter((c) => c.status === 'WARNING').length;
  lines.push(`media QA:      ${report.status} (${blockers} blocker(s), ${warnings} warning(s))`);
  lines.push(`input:         ${report.input}`);
  lines.push(`sha256:        ${report.sha256 ?? 'not computed'}`);
  lines.push(`picture:       ${report.width ?? '?'}x${report.height ?? '?'}  aspect ${report.aspectRatio ?? '?'}  ${report.fps ?? '?'} fps  ${report.durationSeconds ?? '?'}s  ${report.bytes ?? '?'} bytes`);
  if (report.audioDurationSeconds !== null) lines.push(`audio:         ${report.audioDurationSeconds}s stream duration`);
  if (report.black) lines.push(`black frames:  ${report.black.segments.length} segment(s), ${report.black.totalSeconds}s total`);
  if (report.freeze) lines.push(`freeze frames: ${report.freeze.segments.length} segment(s), ${report.freeze.totalSeconds}s total`);
  if (report.silence) lines.push(`silence:       ${report.silence.segments.length} segment(s), ${report.silence.totalSeconds}s total`);
  if (report.loudness) lines.push(`loudness:      I ${report.loudness.integratedLufs ?? '?'} LUFS  LRA ${report.loudness.rangeLu ?? '?'} LU  true peak ${report.loudness.truePeakDb ?? '?'} dBFS`);
  if (report.peak) lines.push(`sample peak:   max ${report.peak.maxVolumeDb ?? '?'} dB  mean ${report.peak.meanVolumeDb ?? '?'} dB  clipped samples ${report.peak.clippedSamples ?? '?'}`);
  if (report.checks.length) {
    lines.push('');
    lines.push('checks:');
    for (const c of report.checks) {
      const expected = c.expected === undefined ? '' : `  expected ${JSON.stringify(c.expected)}`;
      const actual = c.actual === undefined ? '' : `  actual ${JSON.stringify(c.actual)}`;
      lines.push(`  [${c.status}] ${c.id}: ${c.explanation}${expected}${actual}`);
      if (c.status === 'FAIL' || c.status === 'WARNING') {
        if (c.remedy) lines.push(`           fix: ${c.remedy}`);
      }
    }
  }
  lines.push('');
  lines.push(`not checked:   ${report.skipped.join('; ')}`);
  lines.push('note:          this probe is read-only. Nothing was rendered, uploaded or published.');
  return lines.join('\n');
}
