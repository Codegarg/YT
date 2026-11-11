/**
 * PHASE 6 — vertical (1080×1920) Shorts rendering.
 *
 * The render is built from the Shorts plan + verified clips. It never touches long-form outputs:
 * the renderer writes exactly one file inside `outputs/<projectId>/shorts/<shortId>/` and refuses
 * any destination outside that directory.
 *
 * Composition contract
 *   · every scene is normalised to 1080×1920 @ 24 fps, SAR 1:1, yuv420p;
 *   · `cover` / `crop` / `blur_fill` follow the reframe decision recorded by `shortsClips.ts`, so
 *     the pixels match the metadata a reviewer was shown;
 *   · a scene timeline window is `max(clip, narration + tail)` — full narration is always
 *     preserved, video is extended with a cloned last frame when narration runs long, and audio
 *     is padded/trimmed to the same window, so A/V cannot drift;
 *   · segments are joined with short per-scene audio+video fades (no overlapping speech), then the
 *     narration bus is normalised to −14 LUFS (the long-form narrator target);
 *   · Devanagari captions are burned in from the ASS file, then the channel logo is overlaid
 *     top-right (the bottom-right is occupied by the Shorts action rail).
 *
 * `buildShortRenderPlan` is a PURE function (no IO) so the exact graph is testable offline; the
 * executor only runs it.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  SHORTS_WIDTH,
  SHORTS_HEIGHT,
  SHORTS_FPS,
  type CaptionSegment,
  type NarrationSegment,
  type ReframePlan,
  type ShortPlan,
} from './shortsTypes.js';
import { buildCaptionSegments } from './shortsCaptions.js';
import type { ResolvedShortClip } from './shortsClips.js';

const exec = promisify(execFile);

/** Bump when the graph/encoder contract changes: it is part of every Short render key. */
export const SHORTS_RENDERER_VERSION = 'shorts-1';

/** Fade length at each scene boundary (seconds). Kept short so dialogue is not swallowed. */
export const SCENE_FADE_SECONDS = 0.15;
/** Extra tail after narration inside a scene window. */
export const NARRATION_TAIL_SECONDS = 0.25;
/** Loudness target for the Short bus (same −14 LUFS narrator convention as long-form). */
export const SHORTS_TARGET_LUFS = -14;

export const SHORT_CAPTION_FILE = 'captions.ass';

/**
 * Brand placement for portrait delivery.
 *
 * The long-form rule is a lower-right logo at 10.56% of frame height. On YouTube Shorts the
 * bottom-right corner is covered by the action rail (like/comment/share), so the SAME logo at the
 * SAME proportional size is placed top-right instead, below the top safe area.
 */
export function brandPlacement(width = SHORTS_WIDTH, height = SHORTS_HEIGHT) {
  return {
    height: Math.round(height * 0.1056),
    right: Math.round(width * 0.05625),
    top: Math.round(height * 0.11667),
  };
}

export interface TimelineAudio {
  kind: 'narration' | 'clip' | 'silence';
  /** Absolute narration path when `kind === 'narration'`. */
  path: string | null;
  seconds: number | null;
}

export interface TimelineScene {
  scene_number: number;
  clip_path: string;
  clip_relative: string;
  clip_seconds: number;
  /** SHA-256 of the source clip: part of the render key, so replacing the bytes re-renders. */
  clip_sha256: string | null;
  window_seconds: number;
  reframe: ReframePlan;
  audio: TimelineAudio;
  /** SHA-256 of the narration audio used for this scene (null when the clip's own audio is used). */
  narration_sha256: string | null;
}

export interface ShortTimeline {
  scenes: TimelineScene[];
  total_seconds: number;
  narration_segments: NarrationSegment[];
  warnings: string[];
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const num = (value: number): string => String(round3(value));

/**
 * Convert the plan + verified clips + measured narration into the exact playback timeline.
 * PURE apart from the values handed in: same inputs ⇒ same timeline ⇒ same captions ⇒ same hash.
 */
export function buildShortTimeline(input: {
  plan: ShortPlan;
  clips: ResolvedShortClip[];
  narrationFiles?: Record<number, string> | null;
  narrationDurations?: Record<number, number> | null;
  /** SHA-256 of each narration file (scene number → hash); keeps the render key content-bound. */
  narrationHashes?: Record<number, string> | null;
}): ShortTimeline {
  const warnings: string[] = [];
  const scenes: TimelineScene[] = [];
  const narrationSegments: NarrationSegment[] = [];

  if (input.clips.length !== input.plan.scene_refs.length) {
    warnings.push(`plan lists ${input.plan.scene_refs.length} scenes but ${input.clips.length} clip(s) were resolved`);
  }

  let cursor = 0;
  for (let index = 0; index < input.clips.length; index += 1) {
    const clip = input.clips[index];
    const sceneNumber = clip.scene_number;
    if (clip.status !== 'OK' || !clip.reframe || !clip.absolutePath) {
      warnings.push(`scene ${sceneNumber} cannot be composed: ${clip.reason}`);
      continue;
    }
    const clipSeconds = Number(clip.duration_seconds ?? 0);
    if (!(clipSeconds > 0)) {
      warnings.push(`scene ${sceneNumber} has no measurable duration`);
      continue;
    }

    const narrationPath = input.narrationFiles?.[sceneNumber] ?? null;
    const narrationSeconds = Number(input.narrationDurations?.[sceneNumber] ?? NaN);
    const planned = input.plan.narration_segments.find((segment) => segment.scene_number === sceneNumber) ?? null;
    const hasNarration = Boolean(narrationPath) && Number.isFinite(narrationSeconds) && narrationSeconds > 0;

    const audio: TimelineAudio = hasNarration
      ? { kind: 'narration', path: narrationPath, seconds: round3(narrationSeconds) }
      : clip.has_audio
        ? { kind: 'clip', path: null, seconds: round3(clipSeconds) }
        : { kind: 'silence', path: null, seconds: null };

    // A narration window always fits the whole spoken line plus a breathing tail.
    const spoken = hasNarration ? narrationSeconds + NARRATION_TAIL_SECONDS : 0;
    const windowSeconds = round3(Math.max(clipSeconds, spoken));

    const kind: NarrationSegment['kind'] = hasNarration
      ? (planned?.kind ?? 'narration')
      : (planned?.kind ?? 'narration');
    const text = planned?.text ?? '';
    const segmentStart = round3(cursor + 0.1);
    const segmentEnd = round3(hasNarration ? Math.min(cursor + windowSeconds - 0.05, segmentStart + narrationSeconds) : cursor + windowSeconds - 0.05);
    narrationSegments.push({
      scene_number: sceneNumber,
      kind,
      text,
      audio: narrationPath,
      duration_seconds: hasNarration ? round3(narrationSeconds) : round3(Math.max(0.2, segmentEnd - segmentStart)),
      start_seconds: segmentStart,
      end_seconds: Math.max(segmentStart + 0.2, segmentEnd),
    });

    scenes.push({
      scene_number: sceneNumber,
      clip_path: clip.absolutePath,
      clip_relative: clip.source,
      clip_seconds: round3(clipSeconds),
      clip_sha256: clip.sha256 ?? null,
      window_seconds: windowSeconds,
      reframe: clip.reframe,
      audio,
      narration_sha256: hasNarration ? (input.narrationHashes?.[sceneNumber] ?? null) : null,
    });
    cursor = round3(cursor + windowSeconds);
  }

  if (scenes.length > 0 && scenes.length < input.plan.scene_refs.length) {
    warnings.push('one or more scenes were dropped from the timeline; the Short is incomplete');
  }

  return { scenes, total_seconds: round3(cursor), narration_segments: narrationSegments, warnings };
}

export interface ShortRenderPlan {
  /** Absolute input paths in `-i` order. */
  inputs: string[];
  filterComplex: string;
  mapVideo: string;
  mapAudio: string;
  expectedSeconds: number;
  placement: { height: number; right: number; top: number } | null;
  /** Captions are expected as `captions.ass` in the ffmpeg working directory. */
  captionsFile: string | null;
}

export interface ShortRenderPlanInput {
  timeline: ShortTimeline;
  /** Absolute logo path (optional; the overlay is skipped when absent). */
  logoPath?: string | null;
  /** When false the ASS burn-in is skipped (QA still validates the caption track). */
  burnCaptions?: boolean;
  captionsFile?: string;
}

/** PURE: build the ffmpeg filter graph for one Short. */
export function buildShortRenderPlan(input: ShortRenderPlanInput): ShortRenderPlan {
  const timeline = input.timeline;
  if (timeline.scenes.length === 0) throw new Error('cannot render a Short with no scenes');

  const inputs: string[] = [];
  const parts: string[] = [];
  const narrationInputs = new Map<string, number>();

  // Video clips occupy the first N input slots, so `[i:v]` stays aligned with scene order.
  for (const scene of timeline.scenes) inputs.push(scene.clip_path);
  const clipIndex = (i: number): number => i;

  const narrationIndex = (absolute: string): number => {
    const existing = narrationInputs.get(absolute);
    if (existing !== undefined) return existing;
    const index = inputs.length;
    inputs.push(absolute);
    narrationInputs.set(absolute, index);
    return index;
  };

  let logoIndex = -1;
  if (input.logoPath) { logoIndex = inputs.length; inputs.push(input.logoPath); }

  const vLabels: string[] = [];
  const aLabels: string[] = [];

  timeline.scenes.forEach((scene, i) => {
    const vIn = `[${clipIndex(i)}:v]`;
    const reframe = scene.reframe;
    let chain: string;

    if (reframe.mode === 'crop' && reframe.crop) {
      const { width, height, x, y } = reframe.crop;
      chain = `${vIn}crop=${width}:${height}:${x}:${y},scale=${SHORTS_WIDTH}:${SHORTS_HEIGHT}`;
    } else if (reframe.mode === 'blur_fill') {
      const bg = `bg${i}`;
      const fg = `fg${i}`;
      const bgs = `bgs${i}`;
      const fgs = `fgs${i}`;
      const src = `src${i}`;
      parts.push(`${vIn}split=2[${bg}][${fg}]`);
      parts.push(`[${bg}]scale=${SHORTS_WIDTH}:${SHORTS_HEIGHT}:force_original_aspect_ratio=increase,crop=${SHORTS_WIDTH}:${SHORTS_HEIGHT},gblur=sigma=40[${bgs}]`);
      parts.push(`[${fg}]scale=${SHORTS_WIDTH}:-2[${fgs}]`);
      parts.push(`[${bgs}][${fgs}]overlay=(W-w)/2:(H-h)/2[${src}]`);
      chain = `[${src}]null`;
    } else {
      chain = `${vIn}scale=${SHORTS_WIDTH}:${SHORTS_HEIGHT}:force_original_aspect_ratio=increase,crop=${SHORTS_WIDTH}:${SHORTS_HEIGHT}`;
    }

    const extra = Math.max(0, scene.window_seconds - scene.clip_seconds);
    const pad = extra > 0.01 ? `,tpad=stop_mode=clone:stop_duration=${num(extra)}` : '';
    const fadeOutStart = Math.max(0, scene.window_seconds - SCENE_FADE_SECONDS);
    const vOut = `v${i}`;
    parts.push(
      `${chain},fps=${SHORTS_FPS},setsar=1,format=yuv420p${pad},trim=duration=${num(scene.window_seconds)},setpts=PTS-STARTPTS,` +
      `fade=t=in:st=0:d=${num(SCENE_FADE_SECONDS)},fade=t=out:st=${num(fadeOutStart)}:d=${num(SCENE_FADE_SECONDS)}[${vOut}]`,
    );
    vLabels.push(vOut);

    const aOut = `a${i}`;
    const audioIn = scene.audio.kind === 'narration' && scene.audio.path
      ? `[${narrationIndex(scene.audio.path)}:a]aresample=48000`
      : scene.audio.kind === 'clip'
        ? `[${clipIndex(i)}:a]aresample=48000`
        : `anullsrc=r=48000:cl=stereo`;
    parts.push(
      `${audioIn},aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${num(scene.window_seconds)},` +
      `asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.08,afade=t=out:st=${num(Math.max(0, scene.window_seconds - 0.08))}:d=0.08[${aOut}]`,
    );
    aLabels.push(aOut);
  });

  const concatIn = timeline.scenes.map((_, i) => `[v${i}][a${i}]`).join('');
  parts.push(`${concatIn}concat=n=${timeline.scenes.length}:v=1:a=1[vcat][acat]`);
  parts.push(`[acat]loudnorm=I=${SHORTS_TARGET_LUFS}:TP=-1.5:LRA=11[anorm]`);

  let videoLabel = 'vcat';
  if (input.burnCaptions !== false) {
    parts.push(`[${videoLabel}]ass=filename=${input.captionsFile ?? SHORT_CAPTION_FILE}[vsub]`);
    videoLabel = 'vsub';
  }

  let placement: ShortRenderPlan['placement'] = null;
  if (logoIndex >= 0) {
    const brand = brandPlacement();
    placement = brand;
    parts.push(`[${logoIndex}:v]scale=-2:${brand.height}[lg]`);
    parts.push(`[${videoLabel}][lg]overlay=W-w-${brand.right}:${brand.top}:format=auto[vout]`);
    videoLabel = 'vout';
  }

  return {
    inputs,
    filterComplex: parts.join(';'),
    mapVideo: `[${videoLabel}]`,
    mapAudio: '[anorm]',
    expectedSeconds: timeline.total_seconds,
    placement,
    captionsFile: input.burnCaptions === false ? null : (input.captionsFile ?? SHORT_CAPTION_FILE),
  };
}

/** Encoder arguments (deterministic given identical inputs + the same ffmpeg build). */
export function shortEncoderArgs(outputPath: string, plan: ShortRenderPlan): string[] {
  return [
    '-filter_complex', plan.filterComplex,
    '-map', plan.mapVideo,
    '-map', plan.mapAudio,
    '-r', String(SHORTS_FPS),
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-map_metadata', '-1',
    '-movflags', '+faststart',
    outputPath,
  ];
}

export type ShortFfmpegRunner = (args: string[], options: { cwd: string }) => Promise<void>;

const defaultRunner: ShortFfmpegRunner = async (args, options) => {
  const bin = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
  await exec(bin, ['-hide_banner', '-nostdin', '-y', ...args], { cwd: options.cwd, maxBuffer: 1024 * 1024 * 32 });
};

export interface RenderShortInput {
  timeline: ShortTimeline;
  /** Absolute directory that owns the Short (`outputs/<projectId>/shorts/<shortId>`). */
  shortDir: string;
  /** Absolute destination (`<shortDir>/<shortId>.mp4`). */
  outputPath: string;
  logoPath?: string | null;
  burnCaptions?: boolean;
  runner?: ShortFfmpegRunner;
}

export type RenderShortResult =
  | { ok: true; outputPath: string; expectedSeconds: number; bytes: number }
  | { ok: false; reason: string; outputPath: string };

/**
 * Render one Short. Writes ONLY inside `shortDir`: a temp file, then an atomic rename onto
 * `outputPath`. An existing valid output is never partially overwritten.
 */
export async function renderShort(input: RenderShortInput): Promise<RenderShortResult> {
  const shortDir = path.resolve(input.shortDir);
  const outputPath = path.resolve(input.outputPath);
  const relative = path.relative(shortDir, outputPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, reason: `refusing to write outside the Short directory: ${outputPath}`, outputPath };
  }
  if (input.timeline.scenes.length === 0) {
    return { ok: false, reason: 'the timeline has no scenes to render', outputPath };
  }

  let plan: ShortRenderPlan;
  try {
    plan = buildShortRenderPlan({
      timeline: input.timeline,
      logoPath: input.logoPath ?? null,
      burnCaptions: input.burnCaptions,
    });
  } catch (error: any) {
    return { ok: false, reason: `cannot build the render graph: ${String(error?.message ?? error)}`, outputPath };
  }

  await fsp.mkdir(shortDir, { recursive: true });
  const tempPath = path.join(shortDir, `.${path.basename(outputPath)}.tmp.mp4`);
  await fsp.rm(tempPath, { force: true });

  const args = [...plan.inputs.flatMap((file) => ['-i', path.resolve(file)]), ...shortEncoderArgs(tempPath, plan)];
  try {
    await (input.runner ?? defaultRunner)(args, { cwd: shortDir });
  } catch (error: any) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    return { ok: false, reason: `ffmpeg failed: ${String(error?.message ?? error).split('\n').slice(-3).join(' ').slice(0, 400)}`, outputPath };
  }

  let bytes = 0;
  try {
    bytes = (await fsp.stat(tempPath)).size;
  } catch {
    return { ok: false, reason: 'ffmpeg reported success but produced no file', outputPath };
  }
  if (bytes <= 0) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    return { ok: false, reason: 'ffmpeg produced an empty file', outputPath };
  }

  await fsp.rename(tempPath, outputPath);
  return { ok: true, outputPath, expectedSeconds: plan.expectedSeconds, bytes };
}

/** Caption track for a rendered Short (built from the SAME timeline that produced the media). */
export function captionsForTimeline(timeline: ShortTimeline): CaptionSegment[] {
  return buildCaptionSegments(timeline.narration_segments);
}

/**
 * Deterministic Short render key.
 *
 * It includes the plan hash, clip hashes and reframe decisions, measured scene windows, narration
 * audio + durations, the caption hash, the metadata hash, the logo hash and the renderer version.
 * Any change to one Short changes only that Short's key.
 */
export function shortRenderKey(input: {
  planHash: string;
  timeline: ShortTimeline;
  captionHash: string;
  metadataHash: string;
  logoHash?: string | null;
  rendererVersion?: string;
}): string {
  const canonical = {
    plan_hash: input.planHash,
    renderer: input.rendererVersion ?? SHORTS_RENDERER_VERSION,
    logo: input.logoHash ?? null,
    captions: input.captionHash,
    metadata: input.metadataHash,
    scenes: input.timeline.scenes.map((scene) => ({
      scene: scene.scene_number,
      clip: scene.clip_relative,
      clip_sha256: scene.clip_sha256,
      window: scene.window_seconds,
      reframe: scene.reframe.mode,
      crop: scene.reframe.crop,
      audio: scene.audio.kind,
      audio_seconds: scene.audio.seconds,
      narration: scene.audio.path ? path.basename(scene.audio.path) : null,
      narration_sha256: scene.narration_sha256,
    })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
