/**
 * PHASE 6 — YouTube Shorts production: shared contracts.
 *
 * These types are the single vocabulary shared by planning, clip verification, vertical
 * composition, captioning, metadata, QA and the shorts workflow. They are intentionally
 * separate from the long-form `ReliabilityStage`/`ApprovalRecord` union types: a Short is a
 * CHILD artifact with its own stable id, its own output hash, its own QA evidence and its own
 * approval. The long-form project remains the parent and is never modified.
 */

export const SHORTS_SCHEMA_VERSION = 1;

/** Vertical delivery target. */
export const SHORTS_WIDTH = 1080;
export const SHORTS_HEIGHT = 1920;
export const SHORTS_FPS = 24;
/** 9:16 as a floating ratio, used for tolerance comparisons only. */
export const SHORTS_ASPECT = 9 / 16;

/** Hard duration bounds for a Short (YouTube accepts up to 3 minutes; we target 8–75 s). */
export const SHORTS_MIN_SECONDS = 8;
export const SHORTS_MAX_SECONDS = 75;
/** Anything above this is reported as a WARNING (still allowed for a slow-burn cut). */
export const SHORTS_WARN_SECONDS = 60;

/** Per-short state vocabulary (derived read-only; mirrors Phase 5 stage semantics). */
export const SHORT_STATES = [
  'planned',
  'rendered',
  'qa_failed',
  'awaiting_approval',
  'approved',
  'stale',
  'failed',
] as const;
export type ShortState = (typeof SHORT_STATES)[number];

export type ShortStage =
  | 'PLAN'
  | 'CLIP_SELECTION'
  | 'NARRATION'
  | 'CAPTIONS'
  | 'RENDER'
  | 'QA'
  | 'APPROVAL'
  | 'PUBLISH_HANDOFF';

/** Composition strategy for one source clip. */
export type ReframeMode = 'cover' | 'crop' | 'blur_fill';

export type ClipOrientation = 'portrait' | 'landscape' | 'square';

export interface ReframeCrop {
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface ReframePlan {
  mode: ReframeMode;
  /** Source pixel rectangle actually used by `crop` (null for `blur_fill`/`cover`). */
  crop: ReframeCrop | null;
  source_width: number;
  source_height: number;
  source_orientation: ClipOrientation;
  /** Fraction of the source image width retained by the crop (1 for cover/blur_fill). */
  retained_fraction: number;
  /** `SAFE` = deterministic framing; `REVIEW` = a human must confirm framing. */
  framing: 'SAFE' | 'REVIEW';
  reason: string;
}

export interface ShortClipSelection {
  scene_number: number;
  /** Relative path inside the project (never an absolute machine path in a report). */
  source: string;
  sha256: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  reframe: ReframePlan | null;
  /** `OK` = reusable as-is; `REPLACE_OR_REVIEW` = cannot be adapted safely. */
  status: 'OK' | 'REPLACE_OR_REVIEW';
  reason: string;
}

export interface NarrationSegment {
  scene_number: number;
  kind: 'narration' | 'dialogue';
  text: string;
  /** Resolved narration audio file (project-relative), when one exists. */
  audio: string | null;
  duration_seconds: number | null;
  /** Absolute start inside the Short timeline (filled by the renderer/QA timing pass). */
  start_seconds: number;
  end_seconds: number;
}

export interface CaptionSegment {
  index: number;
  scene_number: number;
  text: string;
  lines: string[];
  start_seconds: number;
  end_seconds: number;
}

export interface CaptionValidationIssue {
  code: string;
  detail: string;
  severity: 'FAIL' | 'WARNING';
  segment_index?: number;
}

export interface CaptionValidation {
  status: 'PASS' | 'WARNING' | 'FAIL';
  issues: CaptionValidationIssue[];
  checks: number;
}

export interface ShortCompositionRequirement {
  target_width: number;
  target_height: number;
  fps: number;
  /** Ordered plan-level strategies actually used by the selected clips. */
  strategies: ReframeMode[];
  safe_area: { top: number; bottom: number; left: number; right: number };
  caption_band_top: number;
  caption_band_bottom: number;
}

export interface ShortCoherenceCheck {
  id: string;
  status: 'PASS' | 'WARNING' | 'FAIL';
  detail: string;
}

export interface ShortCoherence {
  status: 'PASS' | 'WARNING' | 'FAIL';
  checks: ShortCoherenceCheck[];
}

export interface ShortMetadata {
  title: string;
  description: string;
  hashtags: string[];
  tags: string[];
  language: 'hi';
  category: string;
  parent_story: { project_id: string; title: string | null };
  thumbnail: { frame_seconds: number; reason: string };
  /** SHA-256 of the canonical metadata object (excluding this field). */
  metadata_hash: string;
}

export interface ShortPlan {
  schema_version: number;
  project_id: string;
  short_id: string;
  index: number;
  title: string;
  parent_title: string | null;
  scene_refs: number[];
  hook: { scene_number: number; text: string };
  escalation: Array<{ scene_number: number; beat: string }>;
  payoff: { scene_number: number; text: string; kind: 'reveal' | 'cliffhanger' };
  narration_segments: NarrationSegment[];
  caption_segments: CaptionSegment[];
  estimated_duration_seconds: number;
  composition: ShortCompositionRequirement;
  sound_design: string[];
  clips: ShortClipSelection[];
  coherence: ShortCoherence;
  metadata: ShortMetadata;
  /** SHA-256 over the narrative/composition inputs (not the rendered media). */
  plan_hash: string;
}

export interface ShortsPlanFile {
  schema_version: number;
  project_id: string;
  parent_title: string | null;
  requested_count: number;
  count: number;
  created_at: string;
  /** Deterministic fingerprint of the planning inputs. */
  input_hash: string;
  shorts: ShortPlan[];
  warnings: string[];
}

export interface ShortQaCheck {
  id: string;
  asset: string;
  status: 'PASS' | 'WARNING' | 'FAIL' | 'SKIPPED';
  severity: 'BLOCKER' | 'WARNING' | 'INFO' | 'SKIPPED';
  expected: unknown;
  actual: unknown;
  explanation: string;
}

export interface ShortQaReport {
  schema_version: number;
  project_id: string;
  short_id: string;
  generated_at: string;
  read_only: true;
  status: 'PASS' | 'WARNING' | 'FAIL' | 'SKIPPED';
  ok: boolean;
  /** SHA-256 of the exact rendered artifact evaluated. */
  artifactHash: string | null;
  /** SHA-256 of this report (excluding this field). */
  reportHash: string;
  artifact: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  checks: ShortQaCheck[];
  counts: { pass: number; warning: number; fail: number; skipped: number };
  caption: CaptionValidation;
  framing: { status: 'SAFE' | 'REVIEW'; review_scenes: number[] };
  media_qa: {
    status: 'PASS' | 'WARNING' | 'FAIL' | 'SKIPPED';
    artifact_hash: string | null;
    report_hash: string | null;
    loudness_lufs: number | null;
  };
  /** Always false: a Short is never publishable from this layer. */
  publishable: false;
  /** Publishing always requires an explicit human approval of THIS artifact. */
  approval_required: true;
}

export interface ShortApprovalRecord {
  schema_version: number;
  project_id: string;
  short_id: string;
  artifact_kind: 'short';
  status: 'approved';
  approved_at: string;
  approved_by: string | null;
  approved_output_path: string;
  approved_output_hash: string;
  /** The shorts plan/render key the approval was granted against. */
  approved_short_key: string;
  media_qa: {
    status: 'PASS' | 'WARNING' | 'FAIL' | 'SKIPPED';
    artifact_hash: string;
    report_hash: string;
    generated_at: string;
  };
}

export type ShortApprovalVerdict =
  | { status: 'APPROVED'; record: ShortApprovalRecord; outputHash: string }
  | { status: 'NOT_APPROVED'; reason: string }
  | { status: 'STALE_APPROVAL'; reason: string; record: ShortApprovalRecord | null };

export interface ShortCheckpoint {
  schema_version: number;
  project_id: string;
  short_id: string;
  /** Deterministic key over plan + clip hashes + narration + captions + renderer version. */
  short_key: string;
  plan_hash: string;
  output_path: string;
  output_hash: string;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  scene_refs: number[];
  clip_hashes: Record<string, string>;
  /**
   * PHASE 7: narration hashes the Short was actually rendered from (scene → SHA-256).
   * Additive and optional: older checkpoints simply omit it. It lets the narration ledger prove which
   * Shorts depend on which line, so re-recording ONE line invalidates only the Shorts that used it.
   */
  narration_hashes?: Record<string, string>;
  caption_hash: string;
  metadata_hash: string;
  renderer_version: string;
  rendered_at: string;
}

export interface ShortStatus {
  short_id: string;
  title: string;
  state: ShortState;
  checkpoint: ShortCheckpoint | null;
  artifact_hash: string | null;
  qa: { status: ShortQaReport['status']; report_hash: string | null; artifact_hash: string | null } | null;
  approval: ShortApprovalVerdict;
  /** Reason the short would be re-rendered (null when it can be reused). */
  rerender_reason: string | null;
  publishable: false;
}

export interface ShortsStatusReport {
  schema_version: number;
  project_id: string;
  generated_at: string;
  read_only: true;
  plan_present: boolean;
  plan_hash: string | null;
  count: number;
  shorts: ShortStatus[];
  /** Long-form artifacts are read-only inputs; this is always false. */
  long_form_modified: false;
  publishable: false;
}
