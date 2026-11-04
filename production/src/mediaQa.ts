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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateVideoClip } from './videoClip.js';

const exec = promisify(execFile);

export type QaSeverity = 'FAIL' | 'WARN' | 'INFO';

export type QaCode =
  | 'CONTAINER_INVALID'
  | 'ASPECT_NOT_16_9'
  | 'RESOLUTION_BELOW_MINIMUM'
  | 'BELOW_1080P_TARGET'
  | 'DURATION_OUT_OF_TOLERANCE'
  | 'BLACK_FRAMES_DETECTED'
  | 'FREEZE_FRAMES_DETECTED'
  | 'AUDIO_CLIPPING'
  | 'TRUE_PEAK_CLIPPING'
  | 'LOUDNESS_OFF_TARGET'
  | 'AUDIO_TOO_QUIET'
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
  input: string;
  bytes: number | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  aspectRatio: number | null;
  black: { segments: BlackSegment[]; totalSeconds: number } | null;
  freeze: { segments: FreezeSegment[]; totalSeconds: number } | null;
  loudness: LoudnessReading | null;
  peak: PeakReading | null;
  findings: QaFinding[];
  /** Analyses deliberately not performed by this probe (documented gaps, never silent). */
  skipped: string[];
}

export interface MediaQaOptions {
  input: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  /** Integrated-loudness target for spoken content. Default -14 LUFS (matches the narrator chain). */
  targetLufs?: number;
  /** Allowed deviation from `targetLufs`. Default 3 LU. */
  loudnessToleranceLu?: number;
  /** Hard minimum picture height. Default 720. */
  minHeight?: number;
  /** Preferred height; anything below it (but above `minHeight`) is a warning. Default 1080. */
  targetHeight?: number;
  /** When supplied, the container duration must be within `±durationToleranceSeconds`. */
  expectDurationSeconds?: number;
  durationToleranceSeconds?: number;
  blackMinSeconds?: number;
  freezeMinSeconds?: number;
  skipBlack?: boolean;
  skipFreeze?: boolean;
  skipAudio?: boolean;
}

export const QA_DEFAULTS = {
  targetLufs: -14,
  loudnessToleranceLu: 3,
  minHeight: 720,
  targetHeight: 1080,
  durationToleranceSeconds: 2,
  blackMinSeconds: 0.5,
  freezeMinSeconds: 3,
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
 * ffmpeg emits `freeze_start` when the freeze begins, then `freeze_duration` (and `freeze_end`
 * on newer builds) when it ends. A freeze that lasts until EOF may only report start+duration,
 * so an open segment is completed from the duration when available.
 */
export function parseFreezeDetect(stderr: string): FreezeSegment[] {
  const events: Array<{ kind: 'start' | 'duration' | 'end'; at: number; value: number }> = [];
  const text = String(stderr);
  for (const m of text.matchAll(/freeze_start:\s*([\d.]+)/g)) { const v = num(m[1]); if (v !== null) events.push({ kind: 'start', at: m.index ?? 0, value: v }); }
  for (const m of text.matchAll(/freeze_duration:\s*([\d.]+)/g)) { const v = num(m[1]); if (v !== null) events.push({ kind: 'duration', at: m.index ?? 0, value: v }); }
  for (const m of text.matchAll(/freeze_end:\s*([\d.]+)/g)) { const v = num(m[1]); if (v !== null) events.push({ kind: 'end', at: m.index ?? 0, value: v }); }
  events.sort((a, b) => a.at - b.at);

  const out: FreezeSegment[] = [];
  let start: number | null = null;
  let duration: number | null = null;
  const close = (endOverride?: number) => {
    if (start === null) { duration = null; return; }
    const end = endOverride ?? (duration !== null ? start + duration : null);
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
  close();
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

export interface EvaluateMediaQaInput {
  input: string;
  clip: { state: string; reason?: string; bytes?: number; durationSeconds?: number; video?: { width?: number; height?: number } };
  black?: BlackSegment[] | null;
  freeze?: FreezeSegment[] | null;
  loudness?: LoudnessReading | null;
  peak?: PeakReading | null;
  analysisErrors?: string[];
  options?: Partial<Omit<MediaQaOptions, 'input'>>;
}

/** PURE: turn measurements into findings. No I/O. Severity policy lives here and nowhere else. */
export function evaluateMediaQa(input: EvaluateMediaQaInput): MediaQaReport {
  const opts: Partial<Omit<MediaQaOptions, 'input'>> = input.options ?? {};
  const targetLufs = opts.targetLufs ?? QA_DEFAULTS.targetLufs;
  const tolerance = opts.loudnessToleranceLu ?? QA_DEFAULTS.loudnessToleranceLu;
  const minHeight = opts.minHeight ?? QA_DEFAULTS.minHeight;
  const targetHeight = opts.targetHeight ?? QA_DEFAULTS.targetHeight;
  const findings: QaFinding[] = [];
  const skipped: string[] = ['branding_detection (needs vision/OCR; review the frame manually)'];

  const width = input.clip.video?.width ?? null;
  const height = input.clip.video?.height ?? null;
  const durationSeconds = typeof input.clip.durationSeconds === 'number' ? input.clip.durationSeconds : null;
  const aspectRatio = width && height ? Number((width / height).toFixed(4)) : null;

  if (input.clip.state !== 'VALID') {
    findings.push({ code: 'CONTAINER_INVALID', severity: 'FAIL', message: `Clip is not a usable media container (${input.clip.state}): ${String(input.clip.reason ?? '').slice(0, 180)}` });
    return { ok: false, readOnly: true, input: input.input, bytes: input.clip.bytes ?? null, durationSeconds, width, height, aspectRatio, black: null, freeze: null, loudness: null, peak: null, findings, skipped };
  }

  if (aspectRatio !== null && Math.abs(aspectRatio - 16 / 9) > 0.02) {
    findings.push({ code: 'ASPECT_NOT_16_9', severity: 'FAIL', message: `Aspect ratio is ${aspectRatio} (${width}x${height}); the channel contract is 16:9.`, detail: { width, height, aspectRatio } });
  }
  if (height !== null && height < minHeight) {
    findings.push({ code: 'RESOLUTION_BELOW_MINIMUM', severity: 'FAIL', message: `Picture height ${height}px is below the ${minHeight}px minimum.`, detail: { height, minHeight } });
  } else if (height !== null && height < targetHeight) {
    findings.push({ code: 'BELOW_1080P_TARGET', severity: 'WARN', message: `Picture height ${height}px is below the ${targetHeight}p target (source quality may not permit it).`, detail: { height, targetHeight } });
  }

  const expect = opts.expectDurationSeconds;
  if (typeof expect === 'number') {
    const tol = opts.durationToleranceSeconds ?? QA_DEFAULTS.durationToleranceSeconds;
    if (durationSeconds === null || Math.abs(durationSeconds - expect) > tol) {
      findings.push({ code: 'DURATION_OUT_OF_TOLERANCE', severity: 'FAIL', message: `Duration ${durationSeconds ?? 'unknown'}s is outside ${expect}s ± ${tol}s.`, detail: { durationSeconds, expected: expect, tolerance: tol } });
    }
  }

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

  for (const error of input.analysisErrors ?? []) {
    findings.push({ code: 'ANALYSIS_FAILED', severity: 'WARN', message: `A media analysis step could not complete: ${String(error).slice(0, 200)}` });
  }

  const black = input.black ? { segments: input.black, totalSeconds: Number(input.black.reduce((s, x) => s + x.duration, 0).toFixed(3)) } : null;
  const freeze = input.freeze ? { segments: input.freeze, totalSeconds: Number(input.freeze.reduce((s, x) => s + x.duration, 0).toFixed(3)) } : null;

  return {
    ok: !findings.some((f) => f.severity === 'FAIL'),
    readOnly: true,
    input: input.input,
    bytes: input.clip.bytes ?? null,
    durationSeconds, width, height, aspectRatio,
    black, freeze, loudness, peak, findings, skipped,
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

/**
 * Probe one media file. READ-ONLY by construction. Never throws for media content problems —
 * an unreadable file becomes a FAIL finding so the caller always gets a report.
 */
export async function runMediaQa(options: MediaQaOptions): Promise<MediaQaReport> {
  const opts: MediaQaOptions = { ...options };
  const input = String(opts.input ?? '').trim();
  const clip = await validateVideoClip(input, { ffprobePath: opts.ffprobePath });
  if (clip.state !== 'VALID') return evaluateMediaQa({ input, clip: { state: clip.state, reason: clip.reason, bytes: clip.bytes }, options: opts });

  const bin = ffmpegBinary(opts.ffmpegPath);
  const analysisErrors: string[] = [];
  let black: BlackSegment[] | null = null;
  let freeze: FreezeSegment[] | null = null;
  let loudness: LoudnessReading | null = null;
  let peak: PeakReading | null = null;

  const base = ['-hide_banner', '-nostats', '-v', 'info', '-i', input];

  if (!opts.skipBlack) {
    const blackMin = opts.blackMinSeconds ?? QA_DEFAULTS.blackMinSeconds;
    const res = await analyse(bin, [...base, '-map', '0:v:0', '-an', '-vf', `blackdetect=d=${blackMin}:pix_th=0.10`, '-f', 'null', '-']);
    black = parseBlackDetect(res.stderr);
    if (res.error) analysisErrors.push(`blackdetect: ${res.error}`);
  }

  if (!opts.skipFreeze) {
    const freezeMin = opts.freezeMinSeconds ?? QA_DEFAULTS.freezeMinSeconds;
    const res = await analyse(bin, [...base, '-map', '0:v:0', '-an', '-vf', `freezedetect=n=-60dB:d=${freezeMin}`, '-f', 'null', '-']);
    freeze = parseFreezeDetect(res.stderr);
    if (res.error) analysisErrors.push(`freezedetect: ${res.error}`);
  }

  if (!opts.skipAudio) {
    const loud = await analyse(bin, [...base, '-map', '0:a:0', '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
    loudness = parseEbur128(loud.stderr);
    if (loud.error) analysisErrors.push(`ebur128: ${loud.error}`);

    const vol = await analyse(bin, [...base, '-map', '0:a:0', '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
    peak = parseVolumedetect(vol.stderr);
    if (vol.error) analysisErrors.push(`volumedetect: ${vol.error}`);
  }

  return evaluateMediaQa({
    input, clip: { state: clip.state, reason: clip.reason, bytes: clip.bytes, durationSeconds: clip.durationSeconds, video: clip.video },
    black, freeze, loudness, peak, analysisErrors, options: opts,
  });
}

/** Human-readable, single-screen summary. Pure. */
export function renderMediaQaReport(report: MediaQaReport): string {
  const lines: string[] = [];
  lines.push(`media QA:      ${report.ok ? 'PASS (no failures)' : 'FAIL'}`);
  lines.push(`input:         ${report.input}`);
  lines.push(`picture:       ${report.width ?? '?'}x${report.height ?? '?'}  aspect ${report.aspectRatio ?? '?'}  ${report.durationSeconds ?? '?'}s  ${report.bytes ?? '?'} bytes`);
  if (report.black) lines.push(`black frames:  ${report.black.segments.length} segment(s), ${report.black.totalSeconds}s total`);
  if (report.freeze) lines.push(`freeze frames: ${report.freeze.segments.length} segment(s), ${report.freeze.totalSeconds}s total`);
  if (report.loudness) lines.push(`loudness:      I ${report.loudness.integratedLufs ?? '?'} LUFS  LRA ${report.loudness.rangeLu ?? '?'} LU  true peak ${report.loudness.truePeakDb ?? '?'} dBFS`);
  if (report.peak) lines.push(`sample peak:   max ${report.peak.maxVolumeDb ?? '?'} dB  mean ${report.peak.meanVolumeDb ?? '?'} dB  clipped samples ${report.peak.clippedSamples ?? '?'}`);
  if (report.findings.length) {
    lines.push('');
    for (const f of report.findings) lines.push(`  [${f.severity}] ${f.code}: ${f.message}`);
  }
  lines.push('');
  lines.push(`not checked:   ${report.skipped.join('; ')}`);
  lines.push('note:          this probe is read-only. Nothing was rendered, uploaded or published.');
  return lines.join('\n');
}
