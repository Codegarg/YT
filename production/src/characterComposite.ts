/**
 * Character composition model + deterministic FFmpeg overlay graph (STEP-8CZ).
 *
 * Extends the existing scene renderer with STATIC transparent character compositing. This
 * module is pure/browser-independent: it validates placement instructions and builds the
 * overlay graph. All character assets MUST already be resolved via `characterAsset.ts`
 * (`CHARACTER_ASSET_HIT`) before they reach here.
 *
 * Character MOTION is intentionally NOT implemented (static compositing only).
 * Colours are never hard-coded: assets carry their own pixels.
 */
import { getCharacterAsset, type CharacterAssetResult } from './characterAsset.js';

/** One deterministic character placement (top-left origin, integer pixels). */
export interface CharacterPlacement {
  characterTag: string;
  /** Resolved absolute path to a validated transparent asset (from getCharacterAsset). */
  assetPath: string;
  /** Left edge in output pixels. */
  x: number;
  /** Top edge in output pixels. */
  y: number;
  /** Rendered width in output pixels. */
  width: number;
  /** Rendered height in output pixels. */
  height: number;
  /** 0..1; defaults to 1. */
  opacity?: number;
  /** Higher draws later (on top). Ties broken by ascending array index. */
  zIndex?: number;
}

export type CharacterCompositionErrorCode = 'CHARACTER_COMPOSITING_ASSET_UNAVAILABLE' | 'CHARACTER_PLACEMENT_INVALID';

export type CharacterAssetState = CharacterAssetResult['state'];

/**
 * Resolve + validate every placement, fail-closed.
 * Returns resolved placements ordered deterministically by (zIndex, original index).
 */
export async function resolveCharacterPlacements(
  placements: readonly CharacterPlacement[] | undefined,
  options: { charactersDir: string },
): Promise<{ ok: true; placements: CharacterPlacement[] } | { ok: false; code: CharacterCompositionErrorCode; reason: string; characterTag?: string; assetState?: CharacterAssetState }> {
  const list = Array.isArray(placements) ? placements : [];
  if (list.length === 0) return { ok: true, placements: [] };

  const resolved: CharacterPlacement[] = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const tag = String(p?.characterTag ?? '');
    if (!tag.trim()) return { ok: false, code: 'CHARACTER_PLACEMENT_INVALID', reason: `Placement ${i} has no characterTag.` };

    // Fail closed on invalid geometry before touching assets.
    const geo = validatePlacementGeometry(p);
    if (!geo.ok) return { ok: false, code: 'CHARACTER_PLACEMENT_INVALID', reason: `Placement ${i} (${tag}): ${geo.reason}`, characterTag: tag };

    // Resolve through the EXISTING contract; accept ONLY a HIT.
    const asset = await getCharacterAsset(tag, { charactersDir: options.charactersDir });
    if (asset.state !== 'CHARACTER_ASSET_HIT') {
      return {
        ok: false, code: 'CHARACTER_COMPOSITING_ASSET_UNAVAILABLE',
        reason: `Character "${tag}" cannot be composited: ${asset.state} — ${asset.reason}`,
        characterTag: tag, assetState: asset.state,
      };
    }

    resolved.push({
      characterTag: tag, assetPath: asset.filePath, x: Math.round(p.x), y: Math.round(p.y),
      width: Math.round(p.width), height: Math.round(p.height),
      opacity: p.opacity === undefined ? 1 : p.opacity, zIndex: p.zIndex === undefined ? 0 : p.zIndex,
    });
  }

  // Deterministic z-order: higher zIndex on top; ties keep declared order.
  const ordered = resolved
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.zIndex! - b.p.zIndex!) || (a.i - b.i))
    .map(({ p }) => p);
  return { ok: true, placements: ordered };
}

/** Pure geometry/opacity validation for one placement. */
export function validatePlacementGeometry(p: Partial<CharacterPlacement> | undefined | null): { ok: true } | { ok: false; reason: string } {
  if (!p || typeof p !== 'object') return { ok: false, reason: 'Placement was missing.' };
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const v = (p as any)[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, reason: `${key} must be a finite number (got ${String(v)}).` };
  }
  if ((p.width as number) <= 0 || (p.height as number) <= 0) return { ok: false, reason: `width/height must be positive (got ${p.width}x${p.height}).` };
  if ((p.x as number) < 0 || (p.y as number) < 0) return { ok: false, reason: `x/y must not be negative (got ${p.x},${p.y}).` };
  if (p.opacity !== undefined) {
    if (typeof p.opacity !== 'number' || !Number.isFinite(p.opacity) || p.opacity < 0 || p.opacity > 1) {
      return { ok: false, reason: `opacity must be within 0..1 (got ${String(p.opacity)}).` };
    }
  }
  if (p.zIndex !== undefined && (typeof p.zIndex !== 'number' || !Number.isFinite(p.zIndex))) {
    return { ok: false, reason: `zIndex must be a finite number (got ${String(p.zIndex)}).` };
  }
  return { ok: true };
}

/**
 * Build the deterministic character-overlay portion of an FFmpeg filter_complex.
 *
 * `baseLabel` is the already-processed background label (e.g. `bg`). Character inputs are
 * expected at filter-input indices `charStartIndex`, `charStartIndex+1`, … in the SAME order
 * as `placements`. Returns the final label and the graph segment.
 *
 * Alpha is preserved: each character is scaled with `format=rgba` (no flattening) and
 * overlaid with `overlay`, whose default blending honours the source alpha.
 */
export function buildCharacterOverlayGraph(
  placements: readonly CharacterPlacement[],
  baseLabel: string,
  charStartIndex: number,
  width: number,
  height: number,
): { ok: true; label: string; graph: string; inputs: number } | { ok: false; reason: string } {
  if (!Array.isArray(placements)) return { ok: false, reason: 'placements must be an array.' };
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return { ok: false, reason: `Invalid output size ${width}x${height}.` };

  const segments: string[] = [];
  let label = baseLabel;
  placements.forEach((p, i) => {
    const src = `${charStartIndex + i}:v`;
    const scaled = `c${i}`;
    // Scale preserving alpha; do NOT flatten onto a background.
    segments.push(`[${src}]scale=${p.width}:${p.height}:flags=lanczos,format=rgba[${scaled}]`);
    // Optional opacity via alpha multiplication.
    let overlaySrc = scaled;
    if (typeof p.opacity === 'number' && p.opacity < 1) {
      const alpha = `a${i}`;
      segments.push(`[${scaled}]format=rgba,colorchannelmixer=aa=${p.opacity.toFixed(4)}[${alpha}]`);
      overlaySrc = alpha;
    }
    const next = `o${i}`;
    segments.push(`[${label}][${overlaySrc}]overlay=x=${p.x}:y=${p.y}:format=auto[${next}]`);
    label = next;
  });

  return { ok: true, label, graph: segments.join(';'), inputs: placements.length };
}
