import fs from 'node:fs/promises';
import path from 'node:path';

export type ReviewStatus = 'awaiting_approval' | 'approved' | 'rejected' | 'posted' | 'failed';

/**
 * Publication lifecycle. `review.status` remains `approved` until publication is confirmed;
 * a Zernio 2xx response only advances `review.publish.status` to ACCEPTED.
 */
export type PublicationStatus = 'IDLE' | 'SUBMITTING' | 'ACCEPTED' | 'CONFIRMED' | 'AMBIGUOUS' | 'FAILED';

export interface PublicationState {
  status: PublicationStatus;
  /** Local tracking ID. Zernio has no documented idempotency field, so this is not sent. */
  submission_id?: string;
  submitted_at?: string;
  accepted_at?: string;
  confirmed_at?: string;
  http_status?: number | null;
  zernio_post_id?: string;
  youtube_url?: string;
  youtube_video_id?: string;
  artifact_path?: string;
  artifact_sha256?: string;
  artifact_kind?: 'candidate' | 'canonical';
  account_id?: string;
  visibility?: string;
  last_error?: string;
  note?: string;
}

export interface ReviewState {
  status: ReviewStatus;
  video_path: string;
  title?: string;
  requested_at?: string;
  decided_at?: string;
  posted_at?: string;
  error?: string;
  zernio_post_id?: string;
  youtube_url?: string;
  /** Optional for backwards compatibility with reviews written before the publication lifecycle. */
  publish?: PublicationState;
}

const PUBLICATION_STATUSES: readonly PublicationStatus[] = [
  'IDLE',
  'SUBMITTING',
  'ACCEPTED',
  'CONFIRMED',
  'AMBIGUOUS',
  'FAILED',
];

/**
 * Read the publication state. Legacy compatibility is limited to a genuinely ABSENT
 * `review.publish` property; that alone means "this project never entered the lifecycle" and
 * resolves to IDLE so a legacy `approved` review remains retryable.
 *
 * Anything else fails CLOSED: a present-but-null, non-object, unknown-status, or otherwise
 * malformed `review.publish` resolves to AMBIGUOUS, which blocks publishing until a human
 * reconciles the project. Silently downgrading corrupted state to IDLE would let a second
 * submission run while a prior one may already have been sent to the provider.
 */
export function getPublicationStatus(review: ReviewState | undefined): PublicationStatus {
  if (!review || typeof review !== 'object') return 'IDLE';
  if (!Object.prototype.hasOwnProperty.call(review, 'publish')) return 'IDLE';

  const publication: unknown = review.publish;
  if (publication === undefined) return 'IDLE';
  if (publication === null || typeof publication !== 'object' || Array.isArray(publication)) return 'AMBIGUOUS';

  const raw = (publication as { status?: unknown }).status;
  if (typeof raw !== 'string') return 'AMBIGUOUS';
  const normalized = raw.trim().toUpperCase();
  return (PUBLICATION_STATUSES as readonly string[]).includes(normalized)
    ? (normalized as PublicationStatus)
    : 'AMBIGUOUS';
}

export interface ReviewProject {
  project_id?: string;
  review?: ReviewState;
  [key: string]: unknown;
}

export async function loadProject(projectFile: string): Promise<ReviewProject> {
  return JSON.parse(await fs.readFile(projectFile, 'utf8')) as ReviewProject;
}

export async function saveProject(projectFile: string, project: ReviewProject): Promise<void> {
  const temporary = `${projectFile}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, projectFile);
}

export async function markReviewPending(projectFile: string, videoFile: string, title?: string): Promise<ReviewState> {
  const project = await loadProject(projectFile);
  const review: ReviewState = {
    status: 'awaiting_approval',
    video_path: path.resolve(videoFile),
    title,
    requested_at: new Date().toISOString(),
  };
  project.review = review;
  await saveProject(projectFile, project);
  return review;
}
