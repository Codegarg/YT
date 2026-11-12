/**
 * PHASE 7 — thumbnail contracts (long-form 16:9 + per-Short vertical covers).
 *
 * A thumbnail has three separate concerns and this module keeps them separate on purpose:
 *
 *   1. CONCEPT  — the story-specific idea: headline, kicker, subhead, palette, rationale.
 *   2. DESIGN   — the geometry: font sizes, wrapped lines, safe area, brand placement. Pure data.
 *   3. ARTIFACT — the rendered PNG: bytes, hash, render key. Never the same thing as the design.
 *
 * That separation is what makes resume and invalidation honest: editing a design re-renders the
 * image, while a changed video clip only invalidates the thumbnails that used that clip as a source.
 */

export const THUMBNAIL_SCHEMA_VERSION = 1;

/** Bumped whenever the FFmpeg graph or the ASS authoring changes. Part of every render key. */
export const THUMBNAIL_RENDERER_VERSION = 'thumbnail-renderer-2';

export type ThumbnailKind = 'long_form' | 'short_cover';

export interface ThumbnailDimensions {
  width: number;
  height: number;
  /** Target aspect as width / height (16:9 long-form, 9:16 cover). */
  aspect: number;
}

export const LONG_FORM_DIMENSIONS: ThumbnailDimensions = { width: 1280, height: 720, aspect: 16 / 9 };
export const SHORTS_COVER_DIMENSIONS: ThumbnailDimensions = { width: 1080, height: 1920, aspect: 9 / 16 };

/** Aspect tolerance for validation (a 1280×722 export is still "16:9" to the platform). */
export const ASPECT_TOLERANCE = 0.01;

/** YouTube's hard thumbnail limit. Covers are not uploaded by this repo, so they only warn. */
export const LONG_FORM_MAX_BYTES = 2 * 1024 * 1024;

export interface ThumbnailSafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Nothing important may sit outside these insets.
 * Long-form: mirrors the channel's 1280×720 export where the logo sits at 76px, inset 72/75.
 * Cover: keeps type away from the platform's rounded corners and the bottom UI strip.
 */
export const LONG_FORM_SAFE_AREA: ThumbnailSafeArea = { top: 48, right: 64, bottom: 48, left: 64 };
export const SHORTS_SAFE_AREA: ThumbnailSafeArea = { top: 96, right: 86, bottom: 260, left: 86 };

/**
 * The permanent lower-right brand placement, expressed as the same ratios the TITLE stage uses at
 * 1280×720 (76px high, 72px from the right, 75px from the bottom).
 *
 * The box is `height × height` square and is anchored by its RIGHT/BOTTOM edges at those insets, so at
 * 1280×720 it is x=1132..1208, y=569..645. A square box makes the placement independent of the logo's
 * aspect ratio: the logo is contained (never stretched or cropped) inside it.
 */
export const BRAND_PLACEMENT_RATIOS = { height: 0.1056, right: 0.05625, bottom: 0.10417 } as const;

export interface BrandPlacement {
  height: number;
  right: number;
  bottom: number;
  x: number;
  y: number;
}

/** Deterministic brand box for a canvas (identical ratios at every resolution). */
export function brandPlacement(width: number, height: number): BrandPlacement {
  const logoHeight = Math.round(height * BRAND_PLACEMENT_RATIOS.height);
  const right = Math.round(width * BRAND_PLACEMENT_RATIOS.right);
  const bottom = Math.round(height * BRAND_PLACEMENT_RATIOS.bottom);
  return { height: logoHeight, right, bottom, x: width - logoHeight - right, y: height - logoHeight - bottom };
}

export const THUMBNAIL_PALETTE = {
  background: '#0B0B12',
  overlay: '#05050A',
  text: '#F8F1E5',
  accent: '#9ED5D7',
  outline: '#05050A',
  muted: '#C9C2B6',
} as const;

export interface ThumbnailTextLine {
  text: string;
  /** Estimated rendered width in px (conservative; see thumbnailDesign.estimateTextWidth). */
  estimated_width: number;
}

export interface ThumbnailTextBlock {
  id: 'kicker' | 'headline' | 'subhead';
  text: string;
  lines: ThumbnailTextLine[];
  /** Alignment 7 (top-left) in ASS terms; the box is placed with `\pos`. */
  x: number;
  y: number;
  width: number;
  height: number;
  font_size: number;
  line_height: number;
  bold: boolean;
  color: string;
  outline: number;
  /** True when the block could not be wrapped inside its box. */
  overflow: boolean;
}

export interface ThumbnailConcept {
  /** Hindi headline (Devanagari) — the story's own title, never an invented claim. */
  headline: string;
  /** Brand kicker, e.g. "RAAT KA KHAUF". */
  kicker: string;
  /** Hindi supporting line from the story (hook / logline). */
  subhead: string | null;
  /** Why this frame + these words belong to THIS story. */
  rationale: string;
  /** Scene the visual came from (null for a designed card). */
  source_scene: number | null;
}

export interface ThumbnailDesign {
  schema_version: number;
  project_id: string;
  kind: ThumbnailKind;
  /** `long-form` or the Short id this cover belongs to. */
  owner_id: string;
  width: number;
  height: number;
  aspect: number;
  safe_area: ThumbnailSafeArea;
  concept: ThumbnailConcept;
  /** How the base image is produced. `designed_card` = deterministic gradient card, no invented art. */
  background_mode: 'scene_frame' | 'designed_card';
  text: {
    font_family: string;
    blocks: ThumbnailTextBlock[];
    /** Rectangle every text block must stay inside. */
    band: { x: number; y: number; width: number; height: number };
  };
  branding: {
    /** Relative path (project inputs root) of the channel logo, when one is available. */
    logo_relative_path: string | null;
    placement: BrandPlacement;
    /** Always-visible brand text (never the only branding: the logo box is separate). */
    wordmark: { text: string; font_size: number; color: string; x: number; y: number; visible: boolean };
  };
  palette: typeof THUMBNAIL_PALETTE;
  /** Every non-synthetic input the render consumes. */
  sources: ThumbnailSourceRef[];
  render: {
    renderer_version: string;
    frame_seconds: number | null;
    background_color: string;
    vignette: boolean;
  };
  created_at: string;
  /** SHA-256 over everything except `created_at`/`design_hash`. */
  design_hash: string;
}

export interface ThumbnailSourceRef {
  role: 'base' | 'logo';
  /** Path relative to the project's input root or outputs dir, always project-relative. */
  relative_path: string;
  sha256: string | null;
  scene_number?: number | null;
  /** Seek position used when the base is a video clip. */
  frame_seconds?: number | null;
}

export interface ThumbnailCheckpoint {
  schema_version: number;
  project_id: string;
  kind: ThumbnailKind;
  owner_id: string;
  /** Deterministic key over design + sources + logo + renderer version. */
  render_key: string;
  design_hash: string;
  artifact_path: string;
  artifact_hash: string;
  bytes: number;
  width: number;
  height: number;
  format: string | null;
  sources: ThumbnailSourceRef[];
  branding_applied: boolean;
  renderer_version: string;
  rendered_at: string;
}

export interface ThumbnailQaCheck {
  id: string;
  asset: string;
  status: 'PASS' | 'WARNING' | 'FAIL' | 'SKIPPED';
  severity: 'BLOCKER' | 'WARNING' | 'INFO' | 'SKIPPED';
  expected: unknown;
  actual: unknown;
  explanation: string;
}

export interface ThumbnailQaReport {
  version: number;
  project_id: string;
  kind: ThumbnailKind;
  owner_id: string;
  generated_at: string;
  read_only: true;
  status: 'PASS' | 'WARNING' | 'FAIL' | 'SKIPPED';
  ok: boolean;
  artifact_hash: string | null;
  /** SHA-256 of this report (excluding this field). */
  report_hash: string;
  design_hash: string;
  render_key: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
  format: string | null;
  checks: ThumbnailQaCheck[];
  counts: { pass: number; warning: number; fail: number; skipped: number; blockers: number };
  /** Pixel-measured text bounding box (from the renderer, not from an estimate). */
  text_ink: { x1: number; y1: number; x2: number; y2: number; pixels: number } | null;
  /** Pixel-measured branding ink box. */
  brand_ink: { x1: number; y1: number; x2: number; y2: number; pixels: number } | null;
  publishable: false;
  approval_required: true;
}

export interface ThumbnailApprovalRecord {
  schema_version: number;
  project_id: string;
  kind: ThumbnailKind;
  owner_id: string;
  status: 'approved';
  approved_at: string;
  approved_by: string | null;
  approved_artifact_path: string;
  approved_artifact_hash: string;
  approved_render_key: string;
  media_qa: {
    status: ThumbnailQaReport['status'];
    artifact_hash: string;
    report_hash: string;
    generated_at: string;
  };
}

export type ThumbnailApprovalVerdict =
  | { status: 'APPROVED'; record: ThumbnailApprovalRecord; artifactHash: string }
  | { status: 'NOT_APPROVED'; reason: string }
  | { status: 'STALE_APPROVAL'; reason: string; record: ThumbnailApprovalRecord | null };

export type ThumbnailState = 'planned' | 'rendered' | 'qa_failed' | 'awaiting_approval' | 'approved' | 'stale';

export interface ThumbnailStatus {
  kind: ThumbnailKind;
  owner_id: string;
  state: ThumbnailState;
  artifact_path: string;
  artifact_hash: string | null;
  design_hash: string | null;
  render_key: string | null;
  /** Why the artifact would be re-rendered (null when it can be reused). */
  stale_reason: string | null;
  qa: { status: ThumbnailQaReport['status']; report_hash: string; artifact_hash: string | null } | null;
  approval: ThumbnailApprovalVerdict;
  publishable: false;
}

export interface ThumbnailStatusReport {
  schema_version: number;
  project_id: string;
  generated_at: string;
  read_only: true;
  long_form: ThumbnailStatus | null;
  covers: ThumbnailStatus[];
  /** Long-form and Shorts artifacts are independent; this layer never edits them. */
  long_form_media_modified: false;
  publishable: false;
}
