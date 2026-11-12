/**
 * PHASE 7 — deterministic thumbnail design (pure).
 *
 * No IO, no ffmpeg, no fonts are loaded: this module turns a validated story into a PURE design
 * document (concept + geometry + provenance) whose hash is stable for identical inputs.
 *
 * TEXT MEASUREMENT HONESTY: a browser/Canvas font measurement is not available offline, so line
 * wrapping uses a documented, CONSERVATIVE per-character advance model. The estimate is not treated
 * as truth: the QA layer additionally measures the real rendered ink bounding box from the produced
 * PNG and fails if any text pixel lands outside the design band (see `thumbnailQa.ts`).
 *
 * STORY FIDELITY: every word in a design comes from the story itself (its title, its hook, its own
 * scene narration). Nothing is invented, and a `designed_card` background carries no fake scene.
 */

import crypto from 'node:crypto';
import { stableStringify } from './projectMediaQa.js';
import {
  LONG_FORM_DIMENSIONS,
  LONG_FORM_SAFE_AREA,
  SHORTS_COVER_DIMENSIONS,
  SHORTS_SAFE_AREA,
  THUMBNAIL_PALETTE,
  THUMBNAIL_RENDERER_VERSION,
  THUMBNAIL_SCHEMA_VERSION,
  brandPlacement,
  type ThumbnailConcept,
  type ThumbnailDesign,
  type ThumbnailDimensions,
  type ThumbnailKind,
  type ThumbnailSafeArea,
  type ThumbnailSourceRef,
  type ThumbnailTextBlock,
  type ThumbnailTextLine,
} from './thumbnailTypes.js';

export const THUMBNAIL_FONT_FAMILY = 'Noto Sans Devanagari';
export const BRAND_WORDMARK = 'RAAT KA KHAUF';
export const BRAND_KICKER = `${BRAND_WORDMARK} • हिंदी लोक हॉरर`;

/** Conservative width model: 1 em is the font size; the factor below is a deliberate safety margin. */
export const TEXT_WIDTH_SAFETY_FACTOR = 1.08;

export interface ThumbnailLayoutSpec {
  dimensions: ThumbnailDimensions;
  safeArea: ThumbnailSafeArea;
  band: { x: number; y: number; width: number; height: number };
  kicker: { font: number; line: number; gapAfter: number };
  headline: { font: number; line: number; maxLines: number };
  subhead: { font: number; line: number; maxLines: number; gapBefore: number };
  minHeadlineFont: number;
  minSubheadFont: number;
}

export const THUMBNAIL_LAYOUTS: Record<ThumbnailKind, ThumbnailLayoutSpec> = {
  long_form: {
    dimensions: LONG_FORM_DIMENSIONS,
    safeArea: LONG_FORM_SAFE_AREA,
    band: { x: 72, y: 196, width: 1108, height: 372 },
    kicker: { font: 30, line: 40, gapAfter: 18 },
    headline: { font: 96, line: 108, maxLines: 2 },
    subhead: { font: 36, line: 46, maxLines: 1, gapBefore: 22 },
    minHeadlineFont: 64,
    minSubheadFont: 30,
  },
  short_cover: {
    dimensions: SHORTS_COVER_DIMENSIONS,
    safeArea: SHORTS_SAFE_AREA,
    band: { x: 96, y: 240, width: 888, height: 1240 },
    kicker: { font: 42, line: 56, gapAfter: 26 },
    headline: { font: 120, line: 134, maxLines: 3 },
    subhead: { font: 52, line: 66, maxLines: 2, gapBefore: 30 },
    minHeadlineFont: 72,
    minSubheadFont: 40,
  },
};

export function thumbnailLayoutFor(kind: ThumbnailKind): ThumbnailLayoutSpec {
  return THUMBNAIL_LAYOUTS[kind === 'short_cover' ? 'short_cover' : 'long_form'];
}

/** Width of one code point, in em. Devanagari matras/conjunct marks are narrow and often zero-width. */
export function charAdvance(codePoint: number, char: string): number {
  if (codePoint >= 0x0300 && codePoint <= 0x036f) return 0.0;
  if (codePoint >= 0x0900 && codePoint <= 0x0903) return 0.42;
  if (codePoint >= 0x093a && codePoint <= 0x094f) return 0.26;
  if (codePoint >= 0x0951 && codePoint <= 0x0957) return 0.2;
  if (codePoint === 0x094d) return 0.0;
  if (codePoint >= 0x0964 && codePoint <= 0x0965) return 0.4;
  if (codePoint >= 0x0900 && codePoint <= 0x097f) return 0.56;
  if (char === ' ') return 0.3;
  if (codePoint >= 0x30 && codePoint <= 0x39) return 0.56;
  if (codePoint >= 0x41 && codePoint <= 0x5a) return 0.68;
  if (codePoint >= 0x61 && codePoint <= 0x7a) return 0.55;
  if (codePoint >= 0x2018 && codePoint <= 0x201d) return 0.3;
  if ('.,!?;:|/()[]{}-–—…•·'.includes(char)) return 0.34;
  return 0.62;
}

/** Conservative rendered width estimate, in px, for one line of text. */
export function estimateTextWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const char of String(text ?? '')) {
    em += charAdvance(char.codePointAt(0) ?? 0, char);
  }
  return Math.round(em * fontSize * TEXT_WIDTH_SAFETY_FACTOR);
}

export interface WrappedText {
  lines: ThumbnailTextLine[];
  overflow: boolean;
}

/**
 * Greedy word wrap inside `maxWidth`.
 *
 * A single word wider than the box is kept whole (a word is never split mid-grapheme) and the block
 * is marked `overflow`, so QA refuses it instead of the renderer silently spilling pixels.
 */
export function wrapText(text: string, options: { maxWidth: number; fontSize: number; maxLines: number }): WrappedText {
  const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length === 0) return { lines: [], overflow: false };

  const lines: string[] = [];
  let current = '';
  let overflow = false;

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (estimateTextWidth(candidate, options.fontSize) <= options.maxWidth) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = word;
      if (estimateTextWidth(word, options.fontSize) > options.maxWidth) {
        // One unbreakable token wider than the box: keep it whole, flag the block.
        overflow = true;
      }
      continue;
    }
    // The very first word does not fit on its own.
    lines.push(word);
    current = '';
    overflow = true;
  }
  if (current) lines.push(current);

  if (lines.length > options.maxLines) {
    overflow = true;
    const kept = lines.slice(0, options.maxLines);
    // Never silently drop the rest: the last kept line is explicitly marked as truncated.
    const last = kept[kept.length - 1];
    kept[kept.length - 1] = last.endsWith('…') ? last : `${last}…`;
    return {
      lines: kept.map((line) => ({ text: line, estimated_width: estimateTextWidth(line, options.fontSize) })),
      overflow: true,
    };
  }

  return {
    lines: lines.map((line) => ({ text: line, estimated_width: estimateTextWidth(line, options.fontSize) })),
    overflow,
  };
}

/** First story sentence (Devanagari danda-aware) — used for the supporting line. */
export function firstSentence(text: unknown, maxChars = 96): string {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const match = raw.match(/^(.+?[।?!.])(?:\s|$)/);
  const sentence = match ? match[1] : raw;
  const trimmed = sentence.replace(/[।?!.]+$/, '').trim();
  if (trimmed.length <= maxChars) return trimmed;
  const cut = trimmed.slice(0, maxChars);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > maxChars * 0.6 ? cut.slice(0, boundary) : cut).trim()}…`;
}

export interface ConceptOverrides {
  headline?: string | null;
  kicker?: string | null;
  subhead?: string | null;
  sceneNumber?: number | null;
  rationale?: string | null;
}

export interface ShortStoryContext {
  short_id: string;
  title: string;
  hook: { scene_number: number; text: string };
  scene_refs: number[];
}

function storyTitle(pipeline: any): string {
  const candidates = [
    pipeline?.publishing?.data?.title,
    pipeline?.idea?.selected?.title,
    pipeline?.script?.title,
    pipeline?.scenes?.[0]?.title,
    pipeline?.project_id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return 'RAAT KA KHAUF';
}

function storyHook(pipeline: any): string {
  const candidates = [pipeline?.idea?.selected?.hook, pipeline?.idea?.items?.[0]?.hook];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

/**
 * Deterministic "most narratable scene" — the narrator scene with the longest Hindi narration text,
 * lowest scene number breaking ties. No character-speaking scene is chosen, so the still cannot
 * contradict the audio.
 */
export function representativeScene(pipeline: any): number | null {
  const scenes = Array.isArray(pipeline?.scenes) ? pipeline.scenes : [];
  const candidates = scenes
    .filter((scene: any) => Number.isInteger(Number(scene?.scene_number)))
    .map((scene: any) => ({
      scene_number: Number(scene.scene_number),
      speaker: String(scene?.speaker ?? '').toUpperCase(),
      length: String(scene?.narration_text ?? '').trim().length,
    }))
    .filter((scene: any) => scene.speaker === 'NARRATOR' && scene.length > 0)
    .sort((a: any, b: any) => b.length - a.length || a.scene_number - b.scene_number);
  return candidates.length > 0 ? candidates[0].scene_number : null;
}

/** Derive the story-specific concept. Every string comes from the story or an explicit override. */
export function deriveThumbnailConcept(input: {
  kind: ThumbnailKind;
  pipeline: any;
  short?: ShortStoryContext | null;
  overrides?: ConceptOverrides;
}): ThumbnailConcept {
  const overrides = input.overrides ?? {};
  const isCover = input.kind === 'short_cover';
  const short = input.short ?? null;

  const headline = (overrides.headline ?? '').trim()
    || (isCover && short ? String(short.title ?? '').trim() : '')
    || storyTitle(input.pipeline);

  const subheadSource = (overrides.subhead ?? '').trim()
    || (isCover && short ? String(short.hook?.text ?? '') : storyHook(input.pipeline));
  const subhead = subheadSource ? firstSentence(subheadSource, isCover ? 84 : 120) : null;

  const sourceScene = overrides.sceneNumber !== undefined && overrides.sceneNumber !== null
    ? Number(overrides.sceneNumber)
    : isCover && short
      ? Number(short.hook?.scene_number ?? short.scene_refs?.[0] ?? 0) || null
      : representativeScene(input.pipeline);

  const rationale = (overrides.rationale ?? '').trim() || (isCover && short
    ? `Vertical cover for ${short.short_id}: its own hook (scene ${short.hook?.scene_number ?? '?'}) and its own title, so it is never a crop of the long-form thumbnail.`
    : `Long-form 16:9 thumbnail: the story's own title plus a still from scene ${sourceScene ?? 'n/a'} (a narrator scene, so the image cannot contradict spoken dialogue).`);

  return {
    headline,
    kicker: (overrides.kicker ?? '').trim() || BRAND_KICKER,
    subhead,
    rationale,
    source_scene: Number.isInteger(sourceScene) && Number(sourceScene) > 0 ? Number(sourceScene) : null,
  };
}

function buildBlock(input: {
  id: ThumbnailTextBlock['id'];
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  lineHeight: number;
  maxLines: number;
  bold: boolean;
  color: string;
  outline: number;
}): { block: ThumbnailTextBlock; overflow: boolean; height: number } {
  const wrapped = wrapText(input.text, { maxWidth: input.width, fontSize: input.fontSize, maxLines: input.maxLines });
  const height = Math.max(input.lineHeight, wrapped.lines.length * input.lineHeight);
  return {
    block: {
      id: input.id,
      text: input.text,
      lines: wrapped.lines,
      x: input.x,
      y: input.y,
      width: input.width,
      height,
      font_size: input.fontSize,
      line_height: input.lineHeight,
      bold: input.bold,
      color: input.color,
      outline: input.outline,
      overflow: wrapped.overflow,
    },
    overflow: wrapped.overflow,
    height,
  };
}

export interface ThumbnailLayoutResult {
  blocks: ThumbnailTextBlock[];
  band: { x: number; y: number; width: number; height: number };
  overflow: boolean;
  warnings: string[];
}

/** Lay the concept out inside the design band. Pure and deterministic. */
export function layoutThumbnailText(kind: ThumbnailKind, concept: ThumbnailConcept): ThumbnailLayoutResult {
  const spec = thumbnailLayoutFor(kind);
  const band = { ...spec.band };
  const blocks: ThumbnailTextBlock[] = [];
  const warnings: string[] = [];
  let overflow = false;
  let cursor = band.y;

  // kicker
  {
    const built = buildBlock({
      id: 'kicker', text: concept.kicker, x: band.x, y: cursor, width: band.width,
      fontSize: spec.kicker.font, lineHeight: spec.kicker.line, maxLines: 1,
      bold: false, color: THUMBNAIL_PALETTE.accent, outline: 1.6,
    });
    blocks.push(built.block);
    overflow = overflow || built.overflow;
    cursor += spec.kicker.line + spec.kicker.gapAfter;
  }

  // headline
  {
    const built = buildBlock({
      id: 'headline', text: concept.headline, x: band.x, y: cursor, width: band.width,
      fontSize: spec.headline.font, lineHeight: spec.headline.line, maxLines: spec.headline.maxLines,
      bold: true, color: THUMBNAIL_PALETTE.text, outline: 3.2,
    });
    blocks.push(built.block);
    overflow = overflow || built.overflow;
    cursor += built.height;
  }

  // subhead
  if (concept.subhead) {
    cursor += spec.subhead.gapBefore;
    const built = buildBlock({
      id: 'subhead', text: concept.subhead, x: band.x, y: cursor, width: band.width,
      fontSize: spec.subhead.font, lineHeight: spec.subhead.line, maxLines: spec.subhead.maxLines,
      bold: false, color: THUMBNAIL_PALETTE.muted, outline: 2.2,
    });
    blocks.push(built.block);
    overflow = overflow || built.overflow;
    cursor += built.height;
  }

  if (cursor > band.y + band.height) {
    overflow = true;
    warnings.push(`the text stack ends at y=${cursor}px, past the design band (${band.y + band.height}px)`);
  }

  return { blocks, band, overflow, warnings };
}

/** SHA-256 over the design's meaningful content (timestamps and the hash itself excluded). */
export function thumbnailDesignHash(design: ThumbnailDesign): string {
  const { created_at: _created, design_hash: _hash, ...rest } = design;
  return crypto.createHash('sha256').update(stableStringify(rest)).digest('hex');
}

export interface BuildThumbnailDesignInput {
  projectId: string;
  kind: ThumbnailKind;
  pipeline: any;
  short?: ShortStoryContext | null;
  sources: ThumbnailSourceRef[];
  overrides?: ConceptOverrides;
  backgroundMode?: 'scene_frame' | 'designed_card';
  createdAt: string;
}

export function buildThumbnailDesign(input: BuildThumbnailDesignInput): ThumbnailDesign {
  const spec = thumbnailLayoutFor(input.kind);
  const concept = deriveThumbnailConcept({
    kind: input.kind,
    pipeline: input.pipeline,
    short: input.short ?? null,
    overrides: input.overrides,
  });
  const layout = layoutThumbnailText(input.kind, concept);
  const placement = brandPlacement(spec.dimensions.width, spec.dimensions.height);
  const baseSource = input.sources.find((source) => source.role === 'base') ?? null;
  const logoSource = input.sources.find((source) => source.role === 'logo') ?? null;

  const backgroundMode = input.backgroundMode
    ?? (baseSource ? 'scene_frame' : 'designed_card');

  const design: ThumbnailDesign = {
    schema_version: THUMBNAIL_SCHEMA_VERSION,
    project_id: input.projectId,
    kind: input.kind,
    owner_id: input.kind === 'short_cover' ? String(input.short?.short_id ?? 'short') : 'long-form',
    width: spec.dimensions.width,
    height: spec.dimensions.height,
    aspect: Number(spec.dimensions.aspect.toFixed(6)),
    safe_area: { ...spec.safeArea },
    concept,
    background_mode: backgroundMode,
    text: {
      font_family: THUMBNAIL_FONT_FAMILY,
      blocks: layout.blocks,
      band: layout.band,
    },
    branding: {
      logo_relative_path: logoSource?.relative_path ?? null,
      placement,
      wordmark: {
        text: BRAND_WORDMARK,
        font_size: input.kind === 'short_cover' ? 44 : 28,
        color: THUMBNAIL_PALETTE.accent,
        x: spec.safeArea.left,
        y: spec.dimensions.height - spec.safeArea.bottom - (input.kind === 'short_cover' ? 64 : 40),
        visible: true,
      },
    },
    palette: THUMBNAIL_PALETTE,
    sources: input.sources.map((source) => ({
      role: source.role,
      relative_path: source.relative_path,
      sha256: source.sha256,
      ...(source.scene_number !== undefined ? { scene_number: source.scene_number } : {}),
      ...(source.frame_seconds !== undefined ? { frame_seconds: source.frame_seconds } : {}),
    })),
    render: {
      renderer_version: THUMBNAIL_RENDERER_VERSION,
      frame_seconds: baseSource?.frame_seconds ?? null,
      background_color: THUMBNAIL_PALETTE.background,
      vignette: true,
    },
    created_at: input.createdAt,
    design_hash: '',
  };
  design.design_hash = thumbnailDesignHash(design);
  return design;
}

/** Deterministic render key: design + every source's bytes + the renderer version. */
export function thumbnailRenderKey(design: ThumbnailDesign): string {
  return crypto.createHash('sha256').update(stableStringify({
    renderer: design.render.renderer_version,
    // Recomputed, never the stored field: a hand-edited design.json must not be able to keep an old key.
    design_hash: thumbnailDesignHash(design),
    kind: design.kind,
    width: design.width,
    height: design.height,
    font: design.text.font_family,
    frame_seconds: design.render.frame_seconds,
    background_mode: design.background_mode,
    sources: design.sources.map((source) => [source.role, source.relative_path, source.sha256]),
  })).digest('hex');
}

function channelToLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number | null {
  const match = String(hex ?? '').trim().match(/^#?([0-9a-f]{6})$/i);
  if (!match) return null;
  const int = parseInt(match[1], 16);
  const r = (int >> 16) & 0xff;
  const g = (int >> 8) & 0xff;
  const b = int & 0xff;
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

/** WCAG contrast ratio between two hex colours (null when a colour is unparseable). */
export function contrastRatio(foreground: string, background: string): number | null {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  if (a === null || b === null) return null;
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}

export interface DesignIssue {
  code: string;
  severity: 'FAIL' | 'WARNING';
  detail: string;
}

export interface DesignValidation {
  ok: boolean;
  issues: DesignIssue[];
}

/**
 * PURE design validation: geometry, safe area, minimum type size, contrast, brand presence and the
 * separation between concept and rendered artifact. QA adds the pixel-measured checks on top.
 */
export function validateThumbnailDesign(design: ThumbnailDesign): DesignValidation {
  const issues: DesignIssue[] = [];
  const spec = thumbnailLayoutFor(design.kind);
  const add = (code: string, severity: DesignIssue['severity'], detail: string) => issues.push({ code, severity, detail });

  if (design.schema_version !== THUMBNAIL_SCHEMA_VERSION) add('design.schema', 'FAIL', `unsupported design schema ${design.schema_version}`);
  if (design.design_hash !== thumbnailDesignHash(design)) {
    add('design.hash', 'FAIL', 'the recorded design hash does not match the design content (the file was edited by hand)');
  }
  if (design.width !== spec.dimensions.width || design.height !== spec.dimensions.height) {
    add('design.dimensions', 'FAIL', `${design.width}x${design.height} does not match the ${design.kind} contract ${spec.dimensions.width}x${spec.dimensions.height}`);
  }
  const aspect = design.height > 0 ? design.width / design.height : 0;
  if (Math.abs(aspect - spec.dimensions.aspect) > 0.01) add('design.aspect', 'FAIL', `aspect ${aspect.toFixed(3)} is not ${spec.dimensions.aspect.toFixed(3)}`);

  // ---- safe area ----
  const safe = design.safe_area;
  const right = design.width - safe.right;
  const bottom = design.height - safe.bottom;
  for (const block of design.text.blocks) {
    if (block.x < safe.left) add('design.safe_area', 'FAIL', `${block.id} starts at x=${block.x}px, left of the ${safe.left}px safe inset`);
    if (block.x + block.width > right) add('design.safe_area', 'FAIL', `${block.id} ends at x=${block.x + block.width}px, right of the ${right}px safe edge`);
    if (block.y < safe.top) add('design.safe_area', 'FAIL', `${block.id} starts at y=${block.y}px, above the ${safe.top}px safe inset`);
    if (block.y + block.height > bottom) add('design.safe_area', 'FAIL', `${block.id} ends at y=${block.y + block.height}px, below the ${bottom}px safe edge`);
  }
  if (design.branding.placement.y < safe.top || design.branding.placement.y > design.height) {
    add('design.branding.placement', 'FAIL', 'the brand box is outside the canvas');
  }

  // ---- text overflow (estimate) ----
  for (const block of design.text.blocks) {
    if (block.overflow) add('design.overflow', 'FAIL', `${block.id} does not fit inside the layout band; shorten the copy`);
    for (const line of block.lines) {
      if (line.estimated_width > block.width) {
        add('design.overflow', 'FAIL', `${block.id} line "${line.text.slice(0, 32)}…" is estimated at ${line.estimated_width}px > ${block.width}px`);
      }
    }
    if (block.lines.length === 0) add('design.text.empty', 'FAIL', `${block.id} has no renderable text`);
  }

  // ---- readability ----
  const headline = design.text.blocks.find((block) => block.id === 'headline');
  const subhead = design.text.blocks.find((block) => block.id === 'subhead');
  if (!headline) add('design.headline', 'FAIL', 'the design has no headline');
  else {
    if (headline.font_size < spec.minHeadlineFont) {
      add('design.font_size', 'FAIL', `headline font ${headline.font_size}px is below the ${spec.minHeadlineFont}px small-size floor`);
    }
    if (!/[\u0900-\u097F]/.test(headline.text)) {
      add('design.headline.hindi', 'WARNING', 'the headline contains no Devanagari; confirm the Hindi title is intended');
    }
  }
  if (subhead && subhead.font_size < spec.minSubheadFont) {
    add('design.font_size', 'WARNING', `subhead font ${subhead.font_size}px is below the ${spec.minSubheadFont}px floor`);
  }
  const background = design.background_mode === 'designed_card' ? design.palette.background : design.palette.overlay;
  for (const block of design.text.blocks) {
    const ratio = contrastRatio(block.color, background);
    if (ratio !== null && ratio < 3) {
      add('design.contrast', 'FAIL', `${block.id} contrast ${ratio}:1 against the ${background} scrim is below 3:1`);
    }
  }

  // ---- branding presence ----
  if (!design.branding.wordmark.visible || design.branding.wordmark.text.trim() !== BRAND_WORDMARK) {
    add('design.branding.wordmark', 'FAIL', `the permanent brand text must be "${BRAND_WORDMARK}"`);
  }
  if (!design.concept.rationale.trim()) add('design.concept.rationale', 'FAIL', 'the design records no rationale for its concept');
  if (design.background_mode === 'scene_frame' && !design.sources.some((source) => source.role === 'base')) {
    add('design.sources', 'FAIL', 'a scene_frame design has no base source');
  }
  if (design.background_mode === 'designed_card' && design.sources.some((source) => source.role === 'base')) {
    add('design.sources', 'WARNING', 'a designed_card design carries an unused base source');
  }
  for (const source of design.sources) {
    if (!source.sha256) add('design.sources.hash', 'FAIL', `source ${source.relative_path} has no recorded hash`);
  }

  return { ok: !issues.some((issue) => issue.severity === 'FAIL'), issues };
}
