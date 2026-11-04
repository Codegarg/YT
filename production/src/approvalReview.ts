/**
 * Approval ↔ human-review reconciliation (STEP-8GW). LOCAL-ONLY; never publishes, never
 * touches the network, never invokes zernio.ts.
 *
 * Two records exist and are NOT the same concept:
 *   · `approval.json` (approval.ts)      — AUTHORITATIVE for the exact artifact integrity:
 *                                          binds artifact path/hash + stage key (and candidate
 *                                          provenance when the artifact is a candidate).
 *   · legacy review state (reviewState.ts) — the human-facing review record
 *                                          (awaiting_approval | approved | rejected | posted).
 *
 * The invariant enforced here:
 *   publishable === true  ONLY when the integrity-bound approval is VALID for the exact
 *   approved artifact AND any legacy review points at that same artifact. A legacy
 *   `review.status === 'approved'` alone is NEVER publishable.
 *
 * Reconciliation is read-only by default. `syncReviewFromApproval` is an explicit, opt-in,
 * idempotent bridge that may only move a review from `awaiting_approval` -> `approved` when a
 * valid integrity approval exists; it never overwrites `posted`/`rejected` history.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { evaluateApproval, sameArtifactPath, type ApproveInput, type ApprovalRecord } from './approval.js';
import { loadProject, saveProject, type ReviewState, type ReviewStatus } from './reviewState.js';

/** Integrity-approval verdict (terminology matches approval.ts). */
export type IntegrityState = 'APPROVAL_VALID' | 'APPROVAL_MISSING' | 'APPROVAL_STALE';
/** Human-review verdict, derived from the legacy review record. */
export type ReviewVerdict = 'REVIEW_APPROVED' | 'REVIEW_AWAITING' | 'REVIEW_REJECTED' | 'REVIEW_POSTED' | 'REVIEW_MISSING';

export interface Reconciliation {
  projectId: string;
  integrity: IntegrityState;
  review: ReviewVerdict;
  /** The exact artifact hash the approval authorizes (only when APPROVAL_VALID). */
  approvedFinalOutputHash: string | null;
  /** The exact artifact path the approval authorizes (only when APPROVAL_VALID). */
  approvedFinalOutputPath: string | null;
  /** The absolute review artifact path, when the review record supplies one. */
  reviewVideoPath: string | null;
  /** Whether the review artifact is the same file as the approved artifact (null if no review). */
  reviewArtifactMatchesApproval: boolean | null;
  /** TRUE only when the approval and review authorize the SAME artifact. Never from review alone. */
  publishable: boolean;
  /** True when review/intrinsic approval disagree about the artifact. */
  mismatch: boolean;
  reason: string;
}

export interface ReconcileInput extends ApproveInput {
  /** Absolute pipeline.json for the legacy review record (optional). */
  projectFile?: string;
}

function reviewVerdictOf(review: ReviewState | undefined | null): ReviewVerdict {
  const s: ReviewStatus | undefined = review?.status;
  if (!s) return 'REVIEW_MISSING';
  if (s === 'approved') return 'REVIEW_APPROVED';
  if (s === 'posted') return 'REVIEW_POSTED';
  if (s === 'rejected') return 'REVIEW_REJECTED';
  if (s === 'failed') return 'REVIEW_REJECTED';
  return 'REVIEW_AWAITING';
}

async function readReview(projectFile: string | undefined): Promise<ReviewState | null> {
  if (!projectFile) return null;
  try {
    const project = await loadProject(projectFile);
    return (project.review as ReviewState) ?? null;
  } catch { return null; }
}

/**
 * Deterministically reconcile the two records. READ-ONLY: never writes approval or review.
 */
export async function reconcileApprovalReview(input: ReconcileInput): Promise<Reconciliation> {
  const verdict = await evaluateApproval(input);
  const integrity: IntegrityState = verdict.status === 'APPROVED' ? 'APPROVAL_VALID' : verdict.status === 'STALE_APPROVAL' ? 'APPROVAL_STALE' : 'APPROVAL_MISSING';
  const reviewState = await readReview(input.projectFile);
  const review = reviewVerdictOf(reviewState);
  const approvedFinalOutputHash = verdict.status === 'APPROVED' ? verdict.finalOutputHash : null;
  const approvedFinalOutputPath = verdict.status === 'APPROVED' ? verdict.finalOutputPath : null;
  const reviewVideoPath = typeof reviewState?.video_path === 'string' && reviewState.video_path.trim()
    ? path.resolve(input.outputsDir, reviewState.video_path)
    : null;
  const reviewArtifactMatchesApproval = review === 'REVIEW_MISSING'
    ? null
    : (reviewVideoPath && approvedFinalOutputPath ? sameArtifactPath(reviewVideoPath, approvedFinalOutputPath) : false);
  const verdictReason = verdict.status === 'APPROVED' ? '' : verdict.reason;

  const reviewClaimsApproved = review === 'REVIEW_APPROVED' || review === 'REVIEW_POSTED';
  const integrityMismatch = reviewClaimsApproved && integrity !== 'APPROVAL_VALID';
  const artifactMismatch = integrity === 'APPROVAL_VALID' && review !== 'REVIEW_MISSING' && reviewArtifactMatchesApproval !== true;
  const mismatch = integrityMismatch || artifactMismatch;
  const publishable = integrity === 'APPROVAL_VALID'
    && review !== 'REVIEW_POSTED'
    && (review === 'REVIEW_MISSING' || reviewArtifactMatchesApproval === true);

  const reason = publishable
    ? 'Integrity-bound approval is valid for the exact approved artifact.'
    : integrity === 'APPROVAL_STALE' ? `Integrity approval is stale (${verdictReason}).`
    : integrity === 'APPROVAL_MISSING' ? `No valid integrity-bound approval (${verdictReason}). Review state cannot authorize publishing.`
    : review === 'REVIEW_POSTED' ? 'Artifact approval is valid but it was already posted.'
    : reviewArtifactMatchesApproval === false ? 'Legacy review points at a different artifact than the integrity approval.'
    : 'Not publishable.';

  return {
    projectId: input.projectId,
    integrity,
    review,
    approvedFinalOutputHash,
    approvedFinalOutputPath,
    reviewVideoPath,
    reviewArtifactMatchesApproval,
    publishable,
    mismatch,
    reason,
  };
}

export type SyncOutcome =
  | { ok: true; changed: boolean; review: ReviewState }
  | { ok: false; code: 'SYNC_REFUSED'; reason: string };

/**
 * OPT-IN idempotent bridge: when a VALID integrity approval exists, move a review from
 * `awaiting_approval` to `approved`. Never overwrites `posted`/`rejected`; never creates a
 * review that does not already exist (no duplicate/phantom review requests); never fabricates
 * an approval. Approval remains authoritative for artifact validity regardless of review.
 */
export async function syncReviewFromApproval(input: ReconcileInput & { now?: string }): Promise<SyncOutcome> {
  if (!input.projectFile) return { ok: false, code: 'SYNC_REFUSED', reason: 'no project file supplied for the legacy review record' };
  const verdict = await evaluateApproval(input);
  if (verdict.status !== 'APPROVED') return { ok: false, code: 'SYNC_REFUSED', reason: `integrity approval is not valid (${verdict.status})` };

  let project: any;
  try { project = await loadProject(input.projectFile); }
  catch (e: any) { return { ok: false, code: 'SYNC_REFUSED', reason: `cannot read project file: ${String(e?.message ?? e).slice(0, 120)}` }; }

  const review: ReviewState | undefined = project.review;
  if (!review) return { ok: false, code: 'SYNC_REFUSED', reason: 'no existing review record to synchronize (refusing to create one)' };
  // Preserve historical terminal states.
  if (review.status === 'posted' || review.status === 'rejected') return { ok: true, changed: false, review };
  const reviewPathMatches = typeof review.video_path === 'string'
    && review.video_path.trim() !== ''
    && sameArtifactPath(path.resolve(input.outputsDir, review.video_path), verdict.finalOutputPath);
  if (review.status === 'approved' && reviewPathMatches) return { ok: true, changed: false, review };

  // The review is explicitly synchronized TO the approved artifact, including its path. This is
  // what prevents a candidate approval from being paired with a stale canonical review path.
  const updated: ReviewState = {
    ...review,
    status: 'approved',
    video_path: verdict.finalOutputPath,
    decided_at: review.status === 'approved' ? (review.decided_at ?? input.now ?? new Date().toISOString()) : (input.now ?? new Date().toISOString()),
  };
  delete updated.error;
  project.review = updated;
  await saveProject(input.projectFile, project);
  return { ok: true, changed: true, review: updated };
}

/** Publish-readiness result that explicitly distinguishes the approval/review combinations. */
export type PublishReadinessDetailed =
  | { readiness: 'PUBLISHABLE_PENDING_EXTERNAL_PUBLISHER'; publishable: true; reconciliation: Reconciliation; approval: ApprovalRecord; finalOutputHash: string; finalOutputPath: string }
  | { readiness: 'PUBLISH_BLOCKED_STALE_APPROVAL'; publishable: false; reconciliation: Reconciliation; reason: string }
  | { readiness: 'PUBLISH_BLOCKED_NOT_APPROVED'; publishable: false; reconciliation: Reconciliation; reason: string };

/**
 * Read-only publish readiness. `publishable` is TRUE only when the integrity approval is valid.
 * The result also carries the reconciliation so callers can diagnose review/approval mismatch.
 * NEVER invokes the publisher.
 */
export async function publishReadinessDetailed(input: ReconcileInput): Promise<PublishReadinessDetailed> {
  const rec = await reconcileApprovalReview(input);
  if (rec.integrity === 'APPROVAL_VALID' && rec.publishable) {
    const verdict = await evaluateApproval(input);
    if (verdict.status === 'APPROVED') return { readiness: 'PUBLISHABLE_PENDING_EXTERNAL_PUBLISHER', publishable: true, reconciliation: rec, approval: verdict.record, finalOutputHash: verdict.finalOutputHash, finalOutputPath: verdict.finalOutputPath };
  }
  const blocked = rec.integrity === 'APPROVAL_STALE' ? 'PUBLISH_BLOCKED_STALE_APPROVAL' : 'PUBLISH_BLOCKED_NOT_APPROVED';
  return { readiness: blocked, publishable: false, reconciliation: rec, reason: rec.reason };
}
export { reviewVerdictOf };
