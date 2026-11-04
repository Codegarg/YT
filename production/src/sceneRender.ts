/**
 * Local background-only scene renderer — PURE decision helpers (STEP-8CR).
 *
 * Live 8CO proved a Flow background image can be extracted at intrinsic 1376x768 with the
 * 8CP extractor (same-origin `/asb` image — canvas is NOT tainted). Live 8CQ proved the
 * CHARACTER image CANNOT be extracted (tainted canvas: served from flow-content.google).
 * This module therefore models a BACKGROUND-ONLY renderer: no character imagery, no
 * network, no Flow persistence.
 *
 * These helpers are browser-free and deterministic: they map existing scene text
 * (`camera` / `visual_action` / `effects`) to a small motion set and validate render
 * inputs. Actual FFmpeg rendering is intentionally NOT implemented here.
 */

export type SceneMotion =
  | 'STATIC'
  | 'ZOOM_IN'
  | 'ZOOM_OUT'
  | 'PAN_LEFT'
  | 'PAN_RIGHT'
  | 'PAN_UP'
  | 'PAN_DOWN'
  | 'ZOOM_IN_PAN_LEFT'
  | 'ZOOM_IN_PAN_RIGHT'
  | 'ZOOM_OUT_PAN_LEFT'
  | 'ZOOM_OUT_PAN_RIGHT';

/**
 * Deterministically choose a motion from existing scene text. Priority:
 *   zoom cues → pan cues → (default) gentle ZOOM_IN (a neutral "cinematic" default that
 * never produces a static freeze). Case-insensitive, first-match-wins on a fixed order so
 * the same scene always yields the same motion.
 */
export function motionFromSceneText(text: unknown): SceneMotion {
  const t = String(text ?? '').toLowerCase();
  const zoomIn = /\b(zoom in|push in|dolly in|closer|close-?up|tighten)\b/.test(t);
  const zoomOut = /\b(zoom out|pull out|pull back|wider|widen|establishing)\b/.test(t);
  const panLeft = /\b(pan(?:ning)? (?:to the )?left|left|moves? left)\b/.test(t);
  const panRight = /\b(pan(?:ning)? (?:to the )?right|right|moves? right)\b/.test(t);
  const panUp = /\b(pan(?:ning)? up|tilts? up|looks? up|lifts?|up)\b/.test(t);
  const panDown = /\b(pan(?:ning)? down|tilts? down|looks? down|down)\b/.test(t);
  if (zoomIn && panLeft) return 'ZOOM_IN_PAN_LEFT';
  if (zoomIn && panRight) return 'ZOOM_IN_PAN_RIGHT';
  if (zoomOut && panLeft) return 'ZOOM_OUT_PAN_LEFT';
  if (zoomOut && panRight) return 'ZOOM_OUT_PAN_RIGHT';
  if (zoomIn) return 'ZOOM_IN';
  if (zoomOut) return 'ZOOM_OUT';
  if (panLeft) return 'PAN_LEFT';
  if (panRight) return 'PAN_RIGHT';
  if (panUp) return 'PAN_UP';
  if (panDown) return 'PAN_DOWN';
  return 'ZOOM_IN';
}

export interface SceneRenderInput {
  sceneNumber: number;
  backgroundImagePath: string;
  durationSeconds: number;
  motion: SceneMotion;
  width: number;
  height: number;
}

/** Validate a scene render input. Fail-closed with a precise reason. */
export function validateSceneRenderInput(input: Partial<SceneRenderInput> | undefined | null): { ok: true } | { ok: false; reason: string } {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'Render input was missing.' };
  const n = input.sceneNumber;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return { ok: false, reason: `Invalid scene number: ${String(n)}.` };
  if (typeof input.backgroundImagePath !== 'string' || !input.backgroundImagePath.trim()) return { ok: false, reason: `Scene ${n} has no background image path.` };
  if (typeof input.durationSeconds !== 'number' || !Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) return { ok: false, reason: `Scene ${n} has an invalid duration (${String(input.durationSeconds)}); a real positive duration is required.` };
  if (typeof input.width !== 'number' || !Number.isInteger(input.width) || input.width <= 0) return { ok: false, reason: `Scene ${n} has an invalid output width (${String(input.width)}).` };
  if (typeof input.height !== 'number' || !Number.isInteger(input.height) || input.height <= 0) return { ok: false, reason: `Scene ${n} has an invalid output height (${String(input.height)}).` };
  if (input.width % 2 !== 0 || input.height % 2 !== 0) return { ok: false, reason: `Scene ${n} output dimensions must be even for H.264 (${input.width}x${input.height}).` };
  return { ok: true };
}

/** True when the dimensions are exactly 16:9 (tolerance 0). */
export function isSixteenByNine(width: unknown, height: unknown): boolean {
  if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) return false;
  return Math.abs(width / height - 16 / 9) < 1e-9;
}

/**
 * Validate a scene duration. Duration MUST come from a real audio file (narration /
 * dialogue) as measured by ffprobe — text must never be used to infer duration. A small
 * visual tail may be added, but the base value must be a measured, positive number.
 */
export function validateSceneDuration(durationSeconds: unknown, tailSeconds = 0): { ok: true; effective: number } | { ok: false; reason: string } {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return { ok: false, reason: `Duration must be a measured positive number (got ${String(durationSeconds)}); narration/dialogue audio is required.` };
  }
  const tail = typeof tailSeconds === 'number' && Number.isFinite(tailSeconds) && tailSeconds >= 0 ? tailSeconds : 0;
  const effective = Number((durationSeconds + tail).toFixed(3));
  if (effective <= 0) return { ok: false, reason: 'Effective duration must be greater than zero.' };
  return { ok: true, effective };
}

/** The `scene-####.mp4` filename required by edit.ts. */
export function sceneClipFilename(sceneNumber: unknown): string {
  const n = typeof sceneNumber === 'number' && Number.isInteger(sceneNumber) && sceneNumber > 0 ? sceneNumber : NaN;
  if (!Number.isInteger(n)) throw new Error(`sceneClipFilename requires a positive integer scene number (got ${String(sceneNumber)}).`);
  return `scene-${String(n).padStart(4, '0')}.mp4`;
}
