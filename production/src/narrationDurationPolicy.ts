/**
 * NARRATION-PRESERVATION DURATION POLICY (pure, deterministic, fail-closed).
 *
 * WHY THIS EXISTS
 * A supplied Flow clip is authoritative and is never re-generated, re-encoded, trimmed or
 * stretched at the source. `AGENTS.md` also forbids cutting narration ("preserve full character
 * dialogue… never leave a silent gap"). Those two requirements collide whenever a scene's
 * narration is LONGER than its supplied clip: the picture cannot cover the voice without either
 * (a) cutting words, or (b) slowing the picture.
 *
 * Historically that collision was resolved by failing the scene closed with `DURATION_CONFLICT`.
 * That is safe but total: it makes such a scene permanently unproducible even when the required
 * slowdown is visually acceptable.
 *
 * THE POLICY
 * When narration exceeds the supplied clip, the picture may be SLOWED (never the audio, never the
 * source file) so the full narration fits, but only while the required stretch stays within
 * `MAX_NARRATION_VIDEO_STRETCH`. Beyond that bound the scene fails closed exactly as before.
 * This narrows the failure surface; it never removes `DURATION_CONFLICT`.
 *
 * HOW THE SLOWDOWN HAPPENS
 * Downstream, `mixNarration` emits the already-existing `setpts=(output/clip)*PTS` filter, which
 * scales every presentation timestamp uniformly. Audio is `atrim`-ed to the same duration and
 * plays at its NATURAL speed. No `tpad`, no looping, no frame freezing, no duplicated clips and
 * no additional Flow generation is involved.
 *
 * This module is PURE: no I/O, no ffprobe, no browser, no Flow. It is the SINGLE source of the
 * duration arithmetic shared by `sceneState.ts` (which decides readiness) and `mixNarration.ts`
 * (which builds the timeline), so the two can never disagree about whether a scene is extendable.
 * It is not bound to any scene number and applies to any narration-bearing scene.
 */
import { validateSceneDuration } from './sceneRender.js';

/**
 * Visual tail kept after the last spoken word, so a shot ends on the completed thought rather
 * than clipping the final syllable. Narration alone is never padded out with silence; a short
 * narration still yields `clipDuration`, because the required output is a `max`, never a sum.
 */
export const NARRATION_TAIL_SECONDS = 0.25;

/**
 * Hard upper bound on picture slowdown. At or below this the scene may remain READY; above it
 * the picture would crawl and the scene fails closed with `DURATION_CONFLICT`.
 */
export const MAX_NARRATION_VIDEO_STRETCH = 2.0;

/**
 * Scenes that deliberately bypass `MAX_NARRATION_VIDEO_STRETCH`.
 *
 * Today this is Scene 2 only: it predates the policy and needs a ~2.42x slowdown so the full
 * establishing narration plays before the driver speaks. The exemption is implemented downstream in
 * `mixNarration.ts` (`if (scene === 2) return Math.max(clipDuration, narrationDuration + tail)`),
 * which is a MIX-stage timing branch, NOT a property of this pure policy module.
 *
 * It is declared here so the upstream readiness gate can EXCLUDE the same scene rather than
 * blocking a scene the mixer will happily render. Without it, extending the gate to
 * `NARRATOR_ONLY` scenes would mark Scene 2 DURATION_CONFLICT/INVALID — regressing a documented,
 * deliberately accepted exception.
 *
 * SCOPE: an exemption from the bound only. It never relaxes the other readiness rules, and it does
 * not alter the mixer's legacy branch, which is preserved verbatim.
 */
export const NARRATION_LEGACY_EXEMPT_SCENES: ReadonlySet<number> = new Set<number>([2]);

/** Tolerance, in seconds, for treating a narration/clip difference as "no conflict at all". */
export const DURATION_CONFLICT_TOLERANCE_SECONDS = 0.05;

/** A decided narration-preservation outcome. */
export type NarrationPreservationDecision =
  | {
      /** Durations are usable and narration fits: the picture keeps its own length. */
      ok: true;
      /** Which rule produced the decision. */
      reason: 'NARRATION_FITS_CLIP';
      sourceVideoDuration: number;
      narrationDuration: number;
      tailSeconds: number;
      /** Picture length to use downstream. */
      requiredOutputDuration: number;
      /** requiredOutputDuration / sourceVideoDuration. */
      stretchFactor: number;
      /** True only when the picture must be slowed to cover the narration. */
      needsPictureExtension: boolean;
      /** Always true here; an extendable scene may stay READY. */
      withinLimit: true;
    }
  | {
      /** Usable durations, narration fits, but only after an acceptable slowdown. */
      ok: true;
      reason: 'NARRATION_EXCEEDS_CLIP_WITHIN_LIMIT';
      sourceVideoDuration: number;
      narrationDuration: number;
      tailSeconds: number;
      requiredOutputDuration: number;
      stretchFactor: number;
      needsPictureExtension: true;
      withinLimit: true;
    }
  | {
      /** Slowing the picture would exceed the bound: the caller MUST fail closed. */
      ok: false;
      reason: 'NARRATION_EXCEEDS_CLIP_LIMIT_EXCEEDED' | 'INVALID_DURATIONS';
      sourceVideoDuration: number | null;
      narrationDuration: number | null;
      tailSeconds: number;
      requiredOutputDuration: number | null;
      stretchFactor: number | null;
      needsPictureExtension: false;
      withinLimit: false;
      detail: string;
    };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * PURE: decide whether a scene's supplied video must be slowed to preserve its full narration.
 *
 * `narrationDuration` may be null/undefined for a scene with no narration, in which case the
 * picture is simply left alone.
 */
export function decideNarrationPreservation(input: {
  sourceVideoDuration: unknown;
  narrationDuration?: unknown;
  tailSeconds?: unknown;
  maxStretch?: unknown;
} | undefined | null): NarrationPreservationDecision {
  const tail = input?.tailSeconds === undefined ? NARRATION_TAIL_SECONDS : Number(input.tailSeconds);
  const maxStretch = input?.maxStretch === undefined ? MAX_NARRATION_VIDEO_STRETCH : Number(input.maxStretch);

  if (!finite(tail) || tail < 0) {
    return { ok: false, reason: 'INVALID_DURATIONS', sourceVideoDuration: null, narrationDuration: null, tailSeconds: NARRATION_TAIL_SECONDS, requiredOutputDuration: null, stretchFactor: null, needsPictureExtension: false, withinLimit: false, detail: `tailSeconds must be a finite non-negative number (got ${String(input?.tailSeconds)}).` };
  }
  if (!finite(maxStretch) || maxStretch < 1) {
    return { ok: false, reason: 'INVALID_DURATIONS', sourceVideoDuration: null, narrationDuration: null, tailSeconds: tail, requiredOutputDuration: null, stretchFactor: null, needsPictureExtension: false, withinLimit: false, detail: `maxStretch must be a finite number >= 1 (got ${String(input?.maxStretch)}).` };
  }

  // The supplied video duration is authoritative. Reuse the existing validator so this module adds
  // no second definition of "a usable duration".
  const source = validateSceneDuration(input?.sourceVideoDuration);
  if (!source.ok) {
    return { ok: false, reason: 'INVALID_DURATIONS', sourceVideoDuration: null, narrationDuration: null, tailSeconds: tail, requiredOutputDuration: null, stretchFactor: null, needsPictureExtension: false, withinLimit: false, detail: `source video duration is unusable: ${source.reason}` };
  }
  const sourceVideoDuration = source.effective;

  const narrationRaw = input?.narrationDuration;
  if (narrationRaw === undefined || narrationRaw === null) {
    // No narration: the picture is never touched.
    return { ok: true, reason: 'NARRATION_FITS_CLIP', sourceVideoDuration, narrationDuration: sourceVideoDuration, tailSeconds: tail, requiredOutputDuration: sourceVideoDuration, stretchFactor: 1, needsPictureExtension: false, withinLimit: true };
  }
  const narration = validateSceneDuration(narrationRaw);
  if (!narration.ok) {
    return { ok: false, reason: 'INVALID_DURATIONS', sourceVideoDuration, narrationDuration: null, tailSeconds: tail, requiredOutputDuration: null, stretchFactor: null, needsPictureExtension: false, withinLimit: false, detail: `narration duration is unusable: ${narration.reason}` };
  }
  const narrationDuration = narration.effective;

  // Narration (plus its tail) is the FLOOR. A short narration never extends the picture.
  const requiredOutputDuration = Math.max(sourceVideoDuration, narrationDuration + tail);
  const stretchFactor = requiredOutputDuration / sourceVideoDuration;

  if (!finite(requiredOutputDuration) || !finite(stretchFactor) || stretchFactor <= 0) {
    return { ok: false, reason: 'INVALID_DURATIONS', sourceVideoDuration, narrationDuration, tailSeconds: tail, requiredOutputDuration: null, stretchFactor: null, needsPictureExtension: false, withinLimit: false, detail: 'computed output duration is not a finite positive number.' };
  }

  if (stretchFactor <= 1 + Number.EPSILON) {
    return { ok: true, reason: 'NARRATION_FITS_CLIP', sourceVideoDuration, narrationDuration, tailSeconds: tail, requiredOutputDuration, stretchFactor: 1, needsPictureExtension: false, withinLimit: true };
  }
  if (stretchFactor <= maxStretch) {
    return { ok: true, reason: 'NARRATION_EXCEEDS_CLIP_WITHIN_LIMIT', sourceVideoDuration, narrationDuration, tailSeconds: tail, requiredOutputDuration, stretchFactor, needsPictureExtension: true, withinLimit: true };
  }
  return {
    ok: false, reason: 'NARRATION_EXCEEDS_CLIP_LIMIT_EXCEEDED',
    sourceVideoDuration, narrationDuration, tailSeconds: tail,
    requiredOutputDuration, stretchFactor, needsPictureExtension: false, withinLimit: false,
    detail: `preserving the full narration needs a ${stretchFactor.toFixed(6)}x picture slowdown, above the ${maxStretch}x maximum.`,
  };
}

/**
 * PURE: the picture length a downstream timeline should use for one scene.
 *
 * Returns the supplied clip's own duration when narration is absent, already fits, or would need
 * an unacceptable slowdown (the caller is expected to have failed such a scene closed already, so
 * this returns the untouched source length rather than stretching anything).
 */
export function narrationPreservingOutputDuration(input: {
  sourceVideoDuration: unknown;
  narrationDuration?: unknown;
  tailSeconds?: unknown;
  maxStretch?: unknown;
} | undefined | null): number {
  const d = decideNarrationPreservation(input);
  // Fail closed: never silently stretch.
  return d.ok ? d.requiredOutputDuration : (Number.isFinite(d.sourceVideoDuration as number) ? (d.sourceVideoDuration as number) : 0);
}

/**
 * PURE: does this narration/clip pair represent a real duration conflict under the existing
 * tolerance? Retained so callers keep one definition of "conflict" rather than two.
 */
export function narrationExceedsClip(sourceVideoDuration: unknown, narrationDuration: unknown, toleranceSeconds: number = DURATION_CONFLICT_TOLERANCE_SECONDS): boolean {
  const s = validateSceneDuration(sourceVideoDuration);
  const n = validateSceneDuration(narrationDuration);
  if (!s.ok || !n.ok) return false;
  return n.effective > s.effective + Math.max(0, Number(toleranceSeconds) || 0);
}