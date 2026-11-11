/**
 * PHASE 6 — Shorts clip selection, verification and portrait reframing.
 *
 * Existing, already-rendered scene clips are REUSED. Nothing is generated here: no Flow call, no
 * browser, no paid submission. The module only:
 *
 *   1. resolves the canonical clip for a scene (`outputs/scene-####.mp4` first, then the Flow
 *      download under `inputs/flow-clips/scene-####.mp4`);
 *   2. verifies the source hash, container, duration and resolution;
 *   3. decides how the clip is adapted to 1080×1920 and records that decision as DATA, so QA and a
 *      human reviewer can inspect exactly which pixels were kept.
 *
 * Reframing rules (deterministic, never silently destroys the frame):
 *   · `cover`     — portrait/square-ish source; the 9:16 frame is filled by cropping height only.
 *   · `crop`      — landscape/square source; a centred 9:16 window is cut out. Retaining ≥ 30% of
 *                   the source width (a standard 16:9 → 9:16 reframe) is SAFE; 18–30% (very wide
 *                   frames) is flagged REVIEW; below 18% we refuse to crop at all.
 *   · `blur_fill` — wide/establishing source; the FULL frame is letterboxed over a blurred,
 *                   cropped copy of itself. Nothing is cut out, but the look needs a human to
 *                   confirm, so it is flagged REVIEW (never a hard failure).
 *
 * A clip that is missing, unreadable, too small or hash-mismatched becomes `REPLACE_OR_REVIEW`:
 * the Short cannot quietly ship a stale or unusable scene.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  SHORTS_WIDTH,
  SHORTS_HEIGHT,
  type ClipOrientation,
  type ReframeCrop,
  type ReframePlan,
  type ShortClipSelection,
} from './shortsTypes.js';
import { validateVideoClip, type VideoClipResult } from './videoClip.js';

/** Minimum source width for a portrait composition (below this the crop is unusable). */
export const MIN_SOURCE_WIDTH = 640;
export const MIN_SOURCE_HEIGHT = 360;
/** Source aspect below/above 1 ± this is treated as square. */
const SQUARE_TOLERANCE = 0.05;
/** Crop retention thresholds (fraction of source width kept by a centred 9:16 crop). */
export const CROP_SAFE_RETENTION = 0.3;
export const CROP_MIN_RETENTION = 0.18;

export function orientationOf(width: number, height: number): ClipOrientation {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 'square';
  const aspect = width / height;
  if (Math.abs(aspect - 1) <= SQUARE_TOLERANCE) return 'square';
  return aspect > 1 ? 'landscape' : 'portrait';
}

const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);

export interface ReframeOptions {
  /** Horizontal subject anchor, 0 = far left, 1 = far right. Defaults to centred (0.5). */
  anchorX?: number;
}

/**
 * Decide how one source frame becomes a 1080×1920 frame. PURE and deterministic.
 */
export function computeReframe(width: number, height: number, options: ReframeOptions = {}): ReframePlan {
  const targetAspect = SHORTS_WIDTH / SHORTS_HEIGHT;
  const orientation = orientationOf(width, height);
  const anchor = Math.min(0.9, Math.max(0.1, Number.isFinite(options.anchorX) ? Number(options.anchorX) : 0.5));

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return {
      mode: 'cover', crop: null, source_width: width, source_height: height, source_orientation: orientation,
      retained_fraction: 0, framing: 'REVIEW', reason: 'source dimensions are unknown; framing needs a human check',
    };
  }

  const aspect = width / height;
  if (aspect <= targetAspect + 0.001) {
    // Portrait (or exactly 9:16, or taller): filling the frame only crops vertically.
    return {
      mode: 'cover', crop: null, source_width: width, source_height: height, source_orientation: orientation,
      retained_fraction: 1, framing: 'SAFE',
      reason: aspect <= targetAspect - 0.001
        ? `${orientation} source (${width}×${height}) fills 9:16 by cropping height only; full width retained`
        : `source is already 9:16 (${width}×${height}); scaled without cropping the frame width`,
    };
  }

  const cropWidth = Math.min(even(width), even(height * targetAspect));
  const retained = cropWidth / width;
  const x = Math.min(Math.max(0, even((width - cropWidth) * anchor)), even(width - cropWidth));
  const crop: ReframeCrop = { width: cropWidth, height: even(height), x, y: 0 };

  if (retained < CROP_MIN_RETENTION) {
    return {
      mode: 'blur_fill', crop: null, source_width: width, source_height: height, source_orientation: orientation,
      retained_fraction: 1, framing: 'REVIEW',
      reason: `a 9:16 crop would keep only ${(retained * 100).toFixed(0)}% of a ${width}×${height} ${orientation} frame; keeping the full frame over a blurred backdrop instead`,
    };
  }

  return {
    mode: 'crop', crop, source_width: width, source_height: height, source_orientation: orientation,
    retained_fraction: Number(retained.toFixed(4)),
    framing: retained >= CROP_SAFE_RETENTION ? 'SAFE' : 'REVIEW',
    reason: retained >= CROP_SAFE_RETENTION
      ? `centred 9:16 crop keeps ${(retained * 100).toFixed(0)}% of a ${width}×${height} ${orientation} frame`
      : `9:16 crop keeps only ${(retained * 100).toFixed(0)}% of a ${width}×${height} ${orientation} frame; confirm the subject is still in frame`,
  };
}

/** Structural validation of a reframe decision (used by QA and by the planner's self-check). */
export function validateReframe(plan: ReframePlan): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const targetAspect = SHORTS_WIDTH / SHORTS_HEIGHT;
  if (!['cover', 'crop', 'blur_fill'].includes(plan.mode)) problems.push(`unknown mode ${String(plan.mode)}`);
  if (!['SAFE', 'REVIEW'].includes(plan.framing)) problems.push(`unknown framing ${String(plan.framing)}`);
  if (!(plan.retained_fraction > 0) || plan.retained_fraction > 1.0001) problems.push(`retained_fraction ${plan.retained_fraction} is outside (0, 1]`);
  if (plan.mode === 'crop') {
    if (!plan.crop) {
      problems.push('crop mode requires a crop rectangle');
    } else {
      const { width, height, x, y } = plan.crop;
      if (!(width > 0) || !(height > 0)) problems.push('crop rectangle has a non-positive size');
      if (width > plan.source_width || height > plan.source_height) problems.push('crop rectangle is larger than the source');
      if (x < 0 || y < 0) problems.push('crop rectangle has a negative offset');
      if (x + width > plan.source_width + 1) problems.push('crop rectangle overflows the source width');
      if (y + height > plan.source_height + 1) problems.push('crop rectangle overflows the source height');
      const aspect = width / height;
      if (Math.abs(aspect - targetAspect) > 0.01) problems.push(`crop aspect ${aspect.toFixed(4)} is not 9:16 (${targetAspect.toFixed(4)})`);
      const retained = width / plan.source_width;
      if (Math.abs(retained - plan.retained_fraction) > 0.01) problems.push(`retained_fraction ${plan.retained_fraction} does not match the crop rectangle (${retained.toFixed(4)})`);
    }
  }
  if (plan.mode !== 'crop' && plan.crop !== null) problems.push(`${plan.mode} mode must not carry a crop rectangle`);
  return { ok: problems.length === 0, problems };
}

export interface ResolveClipOptions {
  sceneNumber: number;
  /** Absolute `production/outputs/<projectId>`. */
  outputsDir: string;
  /** Absolute `production/inputs/<projectId>`. */
  inputRoot: string;
  /** Expected SHA-256 of the source clip (from a previous checkpoint). */
  expectedSha256?: string | null;
  ffprobePath?: string;
  reframe?: ReframeOptions;
}

export interface ResolvedShortClip extends ShortClipSelection {
  /** Absolute path — used by the renderer only; never written to a report. */
  absolutePath: string | null;
  has_audio: boolean;
}

const sceneName = (sceneNumber: number): string => `scene-${String(sceneNumber).padStart(4, '0')}.mp4`;

/** Candidate clip locations in preference order (already-rendered output first). */
export function clipCandidates(sceneNumber: number, outputsDir: string, inputRoot: string): Array<{ absolute: string; relative: string }> {
  const name = sceneName(sceneNumber);
  return [
    { absolute: path.join(outputsDir, name), relative: `outputs/${name}` },
    { absolute: path.join(inputRoot, 'flow-clips', name), relative: `inputs/flow-clips/${name}` },
    { absolute: path.join(inputRoot, name), relative: `inputs/${name}` },
  ];
}

function resultFor(sceneNumber: number, relative: string, absolute: string | null, clip: VideoClipResult | null, reframe: ReframePlan | null, status: ShortClipSelection['status'], reason: string, hasAudio: boolean): ResolvedShortClip {
  return {
    scene_number: sceneNumber,
    source: relative,
    sha256: clip?.sha256 ?? null,
    duration_seconds: clip?.durationSeconds ?? null,
    width: clip?.video?.width ?? null,
    height: clip?.video?.height ?? null,
    reframe,
    status,
    reason,
    absolutePath: absolute,
    has_audio: hasAudio,
  };
}

/**
 * Resolve and verify the clip for one scene. Read-only: it never downloads, transcodes or writes.
 */
export async function resolveShortClip(options: ResolveClipOptions): Promise<ResolvedShortClip> {
  const sceneNumber = Number(options.sceneNumber);
  const candidates = clipCandidates(sceneNumber, options.outputsDir, options.inputRoot);

  let firstExisting: { absolute: string; relative: string } | null = null;
  for (const candidate of candidates) {
    try {
      const stat = await fsp.stat(candidate.absolute);
      if (stat.isFile() && stat.size > 0) { firstExisting = candidate; break; }
    } catch { /* try the next location */ }
  }
  if (!firstExisting) {
    return resultFor(sceneNumber, candidates[0].relative, null, null, null, 'REPLACE_OR_REVIEW',
      `no scene clip found for scene ${sceneNumber} (looked in ${candidates.map((c) => c.relative).join(', ')})`, false);
  }

  const clip = await validateVideoClip(firstExisting.absolute, { ffprobePath: options.ffprobePath });
  if (clip.state !== 'VALID') {
    return resultFor(sceneNumber, firstExisting.relative, firstExisting.absolute, clip, null, 'REPLACE_OR_REVIEW',
      `scene ${sceneNumber} clip is ${clip.state}: ${clip.reason ?? 'not a usable video clip'}`, false);
  }

  const expected = String(options.expectedSha256 ?? '').trim().toLowerCase();
  if (expected && clip.sha256 && clip.sha256.toLowerCase() !== expected) {
    return resultFor(sceneNumber, firstExisting.relative, firstExisting.absolute, clip, null, 'REPLACE_OR_REVIEW',
      `scene ${sceneNumber} clip hash changed (expected ${expected.slice(0, 12)}…, found ${clip.sha256.slice(0, 12)}…); refusing to reuse it silently`, Boolean(clip.audio));
  }

  const width = Number(clip.video?.width ?? 0);
  const height = Number(clip.video?.height ?? 0);
  if (width < MIN_SOURCE_WIDTH || height < MIN_SOURCE_HEIGHT) {
    return resultFor(sceneNumber, firstExisting.relative, firstExisting.absolute, clip, null, 'REPLACE_OR_REVIEW',
      `scene ${sceneNumber} clip is ${width}×${height}; the minimum for a portrait composition is ${MIN_SOURCE_WIDTH}×${MIN_SOURCE_HEIGHT}`, Boolean(clip.audio));
  }

  const reframe = computeReframe(width, height, options.reframe);
  const validation = validateReframe(reframe);
  if (!validation.ok) {
    return resultFor(sceneNumber, firstExisting.relative, firstExisting.absolute, clip, reframe, 'REPLACE_OR_REVIEW',
      `scene ${sceneNumber} reframe decision is inconsistent: ${validation.problems.join('; ')}`, Boolean(clip.audio));
  }

  const audioNote = clip.audio ? '' : ' (no audio stream; the Short uses narration or silence for this scene)';
  return resultFor(sceneNumber, firstExisting.relative, firstExisting.absolute, clip, reframe, 'OK',
    `${reframe.reason}${audioNote}`, Boolean(clip.audio));
}

/** Resolve every scene reference of a Short, in plan order. */
export async function resolveShortClips(options: {
  sceneRefs: number[];
  outputsDir: string;
  inputRoot: string;
  expectedHashes?: Record<number, string> | null;
  ffprobePath?: string;
}): Promise<ResolvedShortClip[]> {
  const clips: ResolvedShortClip[] = [];
  for (const sceneNumber of options.sceneRefs) {
    clips.push(await resolveShortClip({
      sceneNumber,
      outputsDir: options.outputsDir,
      inputRoot: options.inputRoot,
      expectedSha256: options.expectedHashes?.[sceneNumber] ?? null,
      ffprobePath: options.ffprobePath,
    }));
  }
  return clips;
}
