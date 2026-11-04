import { getPublicationStatus, loadProject, saveProject, type PublicationState, type PublicationStatus, type ReviewProject, type ReviewState } from './reviewState.js';
import { evaluateApproval, sameArtifactPath, type ApprovalArtifactKind } from './approval.js';
import { acquirePublishLock, inspectPublishLock, type PublishLockInfo } from './publishLock.js';
import { createR2MediaService, redactSensitiveText, type UploadedR2Media } from './r2Media.js';
import { loadYouTubeAccountAllowlist, resolveApprovedYouTubeAccount, type ApprovedYouTubeAccount } from './youtubeAccountAllowlist.js';
import { runYouTubePreflight, toYouTubePreflightOutput } from './youtubePreflight.js';
import { prepareMedia, toPrepareMediaOutput } from './prepareMedia.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HEX64 = /^[0-9a-f]{64}$/i;
const PUBLISH_REQUEST_TIMEOUT_MS = 120_000;
const BLOCKING_PUBLICATION_STATUSES = new Set<PublicationStatus>(['SUBMITTING', 'ACCEPTED', 'CONFIRMED', 'AMBIGUOUS']);
/**
 * Conservative definitive-failure whitelist. Only these statuses prove the provider rejected the
 * request without creating a post, so only these may leave the project retryable (FAILED).
 * Everything else — 3xx, 408, 409, 425, and any status nobody has reasoned about yet — is
 * AMBIGUOUS and must be reconciled manually before another attempt.
 */
const DEFINITIVE_PUBLISH_FAILURE_STATUSES = new Set<number>([400, 401, 403, 404, 413, 422, 429]);

const API_BASE = 'https://zernio.com/api/v1';
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

async function loadLocalEnvironment(): Promise<void> {
  const dotenvFile = path.resolve(moduleDirectory, '../../scripting/.env');
  try {
    const contents = await fs.readFile(dotenvFile, 'utf8');
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator < 1) continue;
      const name = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
      if (name && value && !process.env[name]) process.env[name] = value;
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function requireApiKey(key: string | undefined): string {
  const value = key?.trim();
  if (!value) throw new Error('Set ZERNIO_API_KEY in your local environment or scripting/.env. Never commit it.');
  return value;
}

function apiKey(): string {
  return requireApiKey(process.env.ZERNIO_API_KEY);
}

/**
 * Parse a successful Zernio response without echoing the raw body. A bare JSON.parse error can
 * include a snippet of the response, and publish responses may reflect private media URLs.
 */
export function parseZernioJsonResponse(body: string): unknown {
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Zernio returned an invalid JSON response.');
  }
}

async function request(endpoint: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${endpoint}`, { ...init, headers: { Authorization: `Bearer ${apiKey()}`, ...(init.headers ?? {}) } });
  } catch (error) {
    throw new Error(`Zernio request failed: ${redactSensitiveText(error)}`);
  }
  if (!response.ok) {
    // Never echo a response body here. Zernio errors can contain request details, and a publish
    // request may carry a private presigned media URL. Status/request-id are safe diagnostics.
    const requestId = response.headers.get('x-request-id')?.trim();
    throw new Error(`Zernio ${response.status}: request failed${requestId ? ` (request id ${requestId})` : ''}.`);
  }
  return parseZernioJsonResponse(await response.text());
}

export interface ZernioAccountSummary {
  platform: string;
  accountId: string;
  displayName: string | null;
  /** True only when Zernio reports the account as active/connected. Null means unknown. */
  isActive: boolean | null;
}

export interface InspectZernioAccountsInput {
  /** Test-only override. Production reads ZERNIO_API_KEY. */
  apiKey?: string;
  /** Optional platform filter sent to GET /accounts. */
  platform?: string;
  /** Test-only fetch override. Defaults to the global fetch. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

const UNEXPECTED_ACCOUNTS_RESPONSE = 'Zernio account listing returned an unexpected response shape.';

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

/** Normalize only the connection state; never expose raw status strings or account metadata. */
function parseActiveState(record: Record<string, unknown>): boolean | null {
  const raw = record.isActive ?? record.active ?? record.connected;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (['true', 'active', 'connected', 'healthy'].includes(normalized)) return true;
    if (['false', 'inactive', 'disconnected', 'disabled', 'revoked'].includes(normalized)) return false;
  }
  const status = firstNonEmptyString(record.status, record.connectionStatus)?.toLowerCase();
  if (status === 'active' || status === 'connected') return true;
  if (['inactive', 'disconnected', 'disabled', 'revoked'].includes(status ?? '')) return false;
  return null;
}

/**
 * Map Zernio's documented GET /v1/accounts response to display-safe fields only.
 * Never returns raw account objects, profile data, URLs, tokens, or response bodies.
 */
export function parseZernioAccountsResponse(response: unknown): ZernioAccountSummary[] {
  const rawAccounts = Array.isArray(response)
    ? response
    : (response && typeof response === 'object' ? (response as { accounts?: unknown }).accounts : undefined);
  if (!Array.isArray(rawAccounts)) throw new Error(UNEXPECTED_ACCOUNTS_RESPONSE);

  const accounts: ZernioAccountSummary[] = [];
  for (const entry of rawAccounts) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const platform = firstNonEmptyString(record.platform, record.type)?.toLowerCase() ?? null;
    const accountId = firstNonEmptyString(record._id, record.id, record.accountId);
    if (!platform || !accountId) continue;
    const displayName = firstNonEmptyString(record.displayName, record.name, record.username);
    accounts.push({ platform, accountId, displayName, isActive: parseActiveState(record) });
  }
  return accounts;
}

/**
 * Read-only account inspection. The only request made is GET /accounts.
 * Error messages deliberately omit response bodies, headers, and credentials.
 */
export async function inspectZernioAccounts(input: InspectZernioAccountsInput = {}): Promise<ZernioAccountSummary[]> {
  const key = input.apiKey === undefined ? apiKey() : requireApiKey(input.apiKey);
  const platform = input.platform?.trim().toLowerCase() ?? '';
  const endpoint = platform ? `/accounts?platform=${encodeURIComponent(platform)}` : '/accounts';

  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`${API_BASE}${endpoint}`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
    });
  } catch {
    throw new Error('Zernio account listing failed: network error.');
  }

  if (!response.ok) throw new Error(`Zernio account listing failed with HTTP ${response.status}.`);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('Zernio account listing returned an invalid JSON response.');
  }
  return parseZernioAccountsResponse(body);
}

// ---------------------------------------------------------------------------------------
// AUTHORITATIVE PUBLISH GATE (STEP-8HH)
//
// A publish is allowed only when ALL are true:
//   1. the legacy human-review record says approved (existing behavior), AND
//   2. that review points at the SAME artifact the integrity approval authorizes, AND
//   3. the integrity-bound approval.json is APPROVED for the exact recorded artifact
//      (evaluateApproval — the single authoritative source of path/hash/stage-key/media validity).
//
// Candidate approvals additionally require a caller-supplied media hash that matches the
// approved artifact, so a candidate approval cannot be used to publish a different upload.
// This module DELEGATES all hash/key/media validation to `evaluateApproval`; it never
// re-implements it. It is fully offline and read-only.
// ---------------------------------------------------------------------------------------

export interface PublishGateInput {
  projectFile: string;
  /** Absolute outputs root (production/outputs). */
  outputsRoot: string;
  /** Absolute project outputs dir (production/outputs/<id>). */
  outputsDir: string;
  /** Absolute project input root (production/inputs/<id>). */
  inputRoot: string;
  pipeline: any;
  projectId?: string;
  ffprobePath?: string;
  /** Exact SHA-256 of the media that will be published. Required for candidate approvals. */
  mediaSha256?: string;
}

export interface PublishGateVerdict {
  ok: boolean;
  reason?: string;
  approvedOutputPath?: string;
  approvedOutputHash?: string;
  approvedArtifactKind?: ApprovalArtifactKind;
}

/** Read the integrated publish gate verdict. Never publishes, never touches the network. */
export async function evaluatePublishGate(input: PublishGateInput): Promise<PublishGateVerdict> {
  const project = await loadProject(input.projectFile).catch(() => null);
  if (!project || project.review?.status !== 'approved') return { ok: false, reason: 'legacy review is not approved' };
  if (typeof project.review.video_path !== 'string' || !project.review.video_path.trim()) {
    return { ok: false, reason: 'legacy review has no artifact path' };
  }
  const projectId = String(input.projectId ?? input.pipeline?.project_id ?? path.basename(path.dirname(input.projectFile)));
  const verdict = await evaluateApproval({ projectId, outputsRoot: input.outputsRoot, outputsDir: input.outputsDir, inputRoot: input.inputRoot, pipeline: input.pipeline, ffprobePath: input.ffprobePath });
  if (verdict.status !== 'APPROVED') {
    return { ok: false, reason: `integrity-bound approval is not valid (${verdict.status})${'reason' in verdict && verdict.reason ? `: ${verdict.reason}` : ''}` };
  }

  const reviewPath = path.resolve(input.outputsDir, project.review.video_path);
  if (!sameArtifactPath(reviewPath, verdict.finalOutputPath)) {
    return { ok: false, reason: 'legacy review points at a different artifact than the integrity approval' };
  }

  const mediaSha256 = String(input.mediaSha256 ?? '').trim().toLowerCase();
  if (mediaSha256 && (!HEX64.test(mediaSha256) || mediaSha256 !== verdict.finalOutputHash.toLowerCase())) {
    return { ok: false, reason: 'publish media hash does not match the approved artifact hash' };
  }
  const kind: ApprovalArtifactKind = verdict.record.approved_artifact_kind === 'candidate' ? 'candidate' : 'canonical';
  if (kind === 'candidate' && (!HEX64.test(mediaSha256) || mediaSha256 !== verdict.finalOutputHash.toLowerCase())) {
    return { ok: false, reason: 'candidate publishing requires mediaSha256 equal to the approved artifact hash' };
  }

  return {
    ok: true,
    approvedOutputPath: verdict.finalOutputPath,
    approvedOutputHash: verdict.finalOutputHash,
    approvedArtifactKind: kind,
  };
}

export interface PublishRequest {
  projectFile: string;
  accountId: string;
  /**
   * A publicly reachable media URL for canonical approvals. Candidate approvals must use
   * mediaFile so the exact candidate path/hash and private-R2 read-back cannot be bypassed.
   */
  mediaUrl?: string;
  /** Approved local media file. Uploaded/presigned in-process; never passed on the command line. */
  mediaFile?: string;
  /** Optional local thumbnail file. Only supported with mediaFile. */
  thumbnailFile?: string;
  title: string;
  description?: string;
  tags?: string;
  visibility?: string;
  /** Must equal 'YES' (the explicit human confirmation). */
  confirmPublish?: string;
  /** Exact SHA-256 of the published media. Required for candidate approvals. */
  mediaSha256?: string;
  outputsRoot?: string;
  inputsRoot?: string;
  ffprobePath?: string;
}

export interface PublishMediaHost {
  uploadVideo(input: { filePath: string; projectId: string; expectedSha256: string }): Promise<UploadedR2Media>;
  uploadThumbnail(input: { filePath: string; projectId: string }): Promise<UploadedR2Media>;
  presign(media: Pick<UploadedR2Media, 'bucket' | 'key'>, ttlSeconds?: number): Promise<string>;
}

export interface ZernioTransportResponse {
  /** HTTP status returned by POST /posts. */
  status: number;
  /** Raw response body text. Parsed locally so malformed JSON is distinguishable from a timeout. */
  bodyText: string;
}

export type ZernioPublishTransport = (payload: any) => Promise<ZernioTransportResponse>;

/** A definitive non-2xx HTTP response. Only the whitelisted statuses are safe to retry. */
export class ZernioPublishHttpError extends Error {
  readonly status: number;
  constructor(status: number, requestId?: string) {
    const label = status > 0 ? `HTTP ${status}` : 'an unreadable/redirected response';
    super(`Zernio publish request failed with ${label}${requestId ? ` (request id ${requestId})` : ''}.`);
    this.name = 'ZernioPublishHttpError';
    this.status = status;
  }
}

/**
 * Real POST /posts transport. A timeout or network failure is reported as an exception; because
 * the request may already have reached Zernio, the caller records AMBIGUOUS and never retries
 * automatically. Provider response bodies are never included in errors.
 *
 * Redirects are never followed: `redirect: 'manual'` keeps the POST from being replayed at a
 * different URL (or silently downgraded to a GET), and any 3xx/opaque redirect is surfaced so the
 * caller can classify the outcome as ambiguous.
 */
async function defaultPublishTransport(payload: any): Promise<ZernioTransportResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLISH_REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}/posts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: 'manual',
      });
    } catch (error) {
      throw new Error(`Zernio publish request failed before a response: ${redactSensitiveText(error)}`);
    }

    // `redirect: 'manual'` yields an opaque-redirect response (status 0) in some runtimes and the
    // raw 3xx in others. Neither is a usable answer, and neither may be treated as success.
    if (response.type === 'opaqueredirect' || response.status === 0 || (response.status >= 300 && response.status < 400)) {
      throw new ZernioPublishHttpError(response.status);
    }

    // Keep the same timeout active while reading the body. A stall here is ambiguous: the request
    // may already have created a post, so an empty body is recorded as AMBIGUOUS rather than
    // retried.
    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch {
      bodyText = '';
    }
    if (!response.ok) {
      const requestId = response.headers.get('x-request-id')?.trim();
      throw new ZernioPublishHttpError(response.status, requestId);
    }
    return { status: response.status, bodyText };
  } finally {
    clearTimeout(timer);
  }
}

/** Only the whitelisted statuses prove no post was created; everything else is ambiguous. */
function classifyPublishFailure(httpStatus: number | null): PublicationStatus {
  return httpStatus !== null && DEFINITIVE_PUBLISH_FAILURE_STATUSES.has(httpStatus) ? 'FAILED' : 'AMBIGUOUS';
}


export interface PublishDeps {
  /** Injected external publisher. Implies HTTP 200 with an already-parsed body (legacy tests). */
  publisher?: (payload: any) => Promise<any>;
  /** Injected HTTP transport used by lifecycle tests (status + raw body text). */
  publishTransport?: ZernioPublishTransport;
  /** Injected integrity evaluator (tests may override); defaults to the real evaluateApproval. */
  evaluateGate?: (input: PublishGateInput) => Promise<PublishGateVerdict>;
  /** Injected R2 host. Defaults to the real private-R2 service only when mediaFile is used. */
  mediaHost?: PublishMediaHost;
  /**
   * Test-only override for the read-only account lookup. Production defaults to
   * inspectZernioAccounts() and therefore GET /accounts?platform=youtube. This cannot override
   * the project allowlist; it only supplies the observed account list.
   */
  accountInspector?: (input: InspectZernioAccountsInput) => Promise<ZernioAccountSummary[]>;
  /** Test-only atomic save override used to exercise local-state failure paths. */
  saveProject?: (projectFile: string, project: ReviewProject) => Promise<void>;
}

type AccountVerification =
  | { ok: true; account: ApprovedYouTubeAccount }
  | { ok: false; reason: string };

/**
 * Enforce the project allowlist and verify the destination account read-only before any R2
 * upload or publisher request. The requested account ID is never used to create an allowlist
 * entry; it must already match the project's configured account.
 */
async function verifyApprovedYouTubeAccount(
  projectId: string,
  requestedAccountId: string,
  deps: PublishDeps,
): Promise<AccountVerification> {
  let allowlist;
  try {
    allowlist = await loadYouTubeAccountAllowlist();
  } catch {
    return { ok: false, reason: 'approved YouTube account allowlist is unavailable or invalid' };
  }

  const approved = resolveApprovedYouTubeAccount(allowlist, projectId);
  if (!approved) return { ok: false, reason: 'project has no approved YouTube account in the allowlist' };
  if (String(requestedAccountId ?? '') !== approved.accountId) {
    return { ok: false, reason: 'requested account does not match the project-approved YouTube account' };
  }

  let accounts: ZernioAccountSummary[];
  try {
    accounts = await (deps.accountInspector ?? inspectZernioAccounts)({ platform: 'youtube' });
  } catch {
    return { ok: false, reason: 'YouTube account verification failed; no publish was attempted' };
  }
  if (!Array.isArray(accounts)) {
    return { ok: false, reason: 'YouTube account verification returned an unexpected response; no publish was attempted' };
  }

  const match = accounts.find((account) => account.platform === 'youtube' && account.accountId === approved.accountId);
  if (!match) return { ok: false, reason: 'approved YouTube account is missing from Zernio or is not a YouTube account' };
  if (match.isActive !== true) return { ok: false, reason: 'approved YouTube account is disconnected or not active' };
  return { ok: true, account: approved };
}

export interface ZernioPayloadInput {
  accountId: string;
  mediaUrl: string;
  thumbnailUrl?: string;
  title: string;
  description?: string;
  tags?: string;
  visibility?: string;
}

/**
 * Pure Request Builder. Does not upload, presign, fetch, or write state.
 * The thumbnail is attached to the video media item exactly as Zernio's YouTube API expects.
 */
export function buildZernioPayload(input: ZernioPayloadInput): any {
  const visibility = input.visibility ?? 'private';
  if (!['public', 'private', 'unlisted'].includes(visibility)) throw new Error('Visibility must be public, private, or unlisted.');
  const description = input.description ?? '';
  const tags = (input.tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
  const mediaItem: any = { type: 'video', url: input.mediaUrl };
  if (input.thumbnailUrl) mediaItem.thumbnail = input.thumbnailUrl;
  return {
    content: description,
    tags,
    mediaItems: [mediaItem],
    platforms: [{
      platform: 'youtube',
      accountId: input.accountId,
      platformSpecificData: {
        title: input.title.slice(0, 100),
        visibility,
        madeForKids: false,
        containsSyntheticMedia: true,
      },
    }],
    publishNow: true,
  };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_VIDEO_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const YOUTUBE_VIDEO_PATH_KINDS = new Set(['shorts', 'embed', 'live']);

export interface YouTubeVideoUrl {
  videoId: string;
  /** Canonical watch form. Used for reporting only; the supplied URL is what gets recorded. */
  canonicalUrl: string;
}

/**
 * Strict parser for a real YouTube *video* URL. Confirmation and provider-response acceptance both
 * need an actual video, not merely a YouTube-controlled host, so channel and playlist links, the
 * bare homepage, plain HTTP, embedded credentials, extra path segments, and unrelated hosts are
 * all rejected. Supported forms: /watch?v=ID, /shorts/ID, /embed/ID, /live/ID, and youtu.be/ID.
 */
export function parseYouTubeVideoUrl(value: string): YouTubeVideoUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(String(value ?? '').trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;

  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').filter(Boolean);
  let videoId: string | null = null;

  if (host === 'youtu.be') {
    if (segments.length !== 1) return null;
    videoId = segments[0];
  } else if (YOUTUBE_VIDEO_HOSTS.has(host)) {
    if (segments.length === 1 && segments[0] === 'watch') {
      videoId = parsed.searchParams.get('v');
    } else if (segments.length === 2 && YOUTUBE_VIDEO_PATH_KINDS.has(segments[0])) {
      videoId = segments[1];
    }
  }

  if (!videoId || !YOUTUBE_VIDEO_ID.test(videoId)) return null;
  return { videoId, canonicalUrl: `https://www.youtube.com/watch?v=${videoId}` };
}

/** True only for a real HTTPS YouTube video URL carrying an 11-character video ID. */
export function isYouTubeUrl(value: string): boolean {
  return parseYouTubeVideoUrl(value) !== null;
}

function extractYouTubeVideoId(value: string): string | null {
  return parseYouTubeVideoUrl(value)?.videoId ?? null;
}


export interface ValidatedZernioPublishResponse {
  postId: string | null;
  youtubeUrl: string | null;
  /** Populated when the post ID exists but the YouTube platform result is missing/invalid. */
  platformError?: string;
}

/**
 * Validate POST /posts response data before anything is accepted. A non-empty post ID is
 * mandatory. A YouTube URL is accepted only from a `platform: "youtube"` result whose URL is
 * actually on a YouTube host; otherwise the URL is discarded (the post ID is still useful for
 * manual reconciliation). Never echo the raw body.
 */
export function validateZernioPublishResponse(body: unknown): ValidatedZernioPublishResponse {
  const root = recordOf(body);
  const post = root ? recordOf(root.post) : null;
  const postId = post ? firstNonEmptyString(post.id, post._id) : null;
  if (!postId) return { postId: null, youtubeUrl: null };

  const platforms = post && Array.isArray(post.platforms) ? post.platforms : [];
  if (platforms.length === 0) {
    return { postId, youtubeUrl: null, platformError: 'provider response has no platform results' };
  }
  const youtube = platforms.find((entry) => {
    const record = recordOf(entry);
    return record ? firstNonEmptyString(record.platform, record.platformName)?.toLowerCase() === 'youtube' : false;
  });
  if (!youtube) {
    return { postId, youtubeUrl: null, platformError: 'provider response has no YouTube platform result' };
  }
  const record = recordOf(youtube);
  const rawUrl = record ? firstNonEmptyString(record.platformPostUrl, record.postUrl, record.url) : null;
  if (!rawUrl) {
    return { postId, youtubeUrl: null, platformError: 'YouTube platform result has no URL' };
  }
  if (!isYouTubeUrl(rawUrl)) {
    return { postId, youtubeUrl: null, platformError: 'YouTube platform result URL is not a YouTube URL' };
  }
  return { postId, youtubeUrl: rawUrl };
}

export type PublishRefusal = 'confirm' | 'review' | 'integrity' | 'account' | 'duplicate' | 'state' | 'provider' | 'ambiguous';

export type PublishOutcome =
  | {
      ok: true;
      /** Zernio accepted the request. This is NOT confirmation of a YouTube video. */
      accepted: true;
      confirmed: false;
      publication: PublicationState;
      result: any;
      post_id?: string;
      youtube_url?: string;
    }
  | {
      ok: false;
      refused: PublishRefusal;
      reason: string;
      publication?: PublicationState;
    };

function safeErrorMessage(error: unknown): string {
  return redactSensitiveText(error).slice(0, 300);
}

function reviewWithPublication(review: ReviewState, publication: PublicationState): ReviewState {
  return { ...review, publish: publication };
}

type SaveProjectFn = (projectFile: string, project: ReviewProject) => Promise<void>;

/**
 * Write the project only while the file still contains the exact bytes the decision was based on.
 * This is what stops the SUBMITTING marker from resurrecting a stale `approved` review after a
 * concurrent `review reject` / `approve` landed during the approval re-check. Returns false (and
 * writes nothing) when the file changed.
 */
async function writeProjectIfUnchanged(
  projectFile: string,
  expectedSnapshot: string,
  next: ReviewProject,
  save: SaveProjectFn,
): Promise<boolean> {
  let current: string;
  try {
    current = await fs.readFile(projectFile, 'utf8');
  } catch {
    return false;
  }
  if (current !== expectedSnapshot) return false;
  await save(projectFile, next);
  return true;
}

/**
 * Read the SUBMITTING marker back after writing it and confirm it survived. A review that was
 * rejected, re-approved, or reconciled between the conditional write and this read must abort the
 * submission instead of being overwritten by it.
 */
async function verifySubmissionMarker(
  projectFile: string,
  submissionId: string,
): Promise<{ ok: true; project: ReviewProject; review: ReviewState } | { ok: false; reason: string }> {
  let project: ReviewProject | null = null;
  try {
    project = JSON.parse(await fs.readFile(projectFile, 'utf8')) as ReviewProject;
  } catch {
    project = null;
  }
  const review = project?.review;
  if (!project || !review) {
    return { ok: false, reason: 'the project could not be re-read after the SUBMITTING marker was written; no request was sent' };
  }
  if (review.status !== 'approved') {
    return { ok: false, reason: `the review became ${review.status} while the submission was being prepared; no request was sent` };
  }
  const publish = review.publish;
  if (!publish || publish.status !== 'SUBMITTING' || publish.submission_id !== submissionId) {
    return { ok: false, reason: 'a concurrent state change replaced the SUBMITTING marker; no request was sent' };
  }
  return { ok: true, project, review };
}

/**
 * Persist a publication state update onto the CURRENT on-disk project rather than the snapshot
 * loaded before the upload, so unrelated concurrent edits are preserved and a review decision
 * that changed mid-flight is never quietly reverted.
 */
async function persistPublicationState(
  projectFile: string,
  publication: PublicationState,
  save: SaveProjectFn,
  fallback: { project: ReviewProject; review: ReviewState },
): Promise<void> {
  let base = fallback;
  try {
    const current = await loadProject(projectFile);
    if (current?.review) base = { project: current, review: current.review };
  } catch {
    // Keep the verified fallback; the write below still fails closed if it cannot land.
  }
  await save(projectFile, { ...base.project, review: reviewWithPublication(base.review, publication) });
}

export interface FinalPreSubmitInput {
  projectFile: string;
  outputsRoot: string;
  inputsRoot: string;
  projectId: string;
  ffprobePath?: string;
  mediaSha256?: string;
  /** Approved artifact path/hash that were actually uploaded/presigned for this submission. */
  submittedArtifactPath?: string;
  submittedArtifactHash?: string;
  evaluateGate: (input: PublishGateInput) => Promise<PublishGateVerdict>;
}

export interface FinalPreSubmitVerdict {
  ok: true;
  project: ReviewProject;
  review: ReviewState;
  gate: PublishGateVerdict;
  /** Raw project bytes the verdict was computed from; the SUBMITTING write must not clobber a newer file. */
  snapshot: string;
}

/**
 * Re-run the authoritative integrity/approval gate inside the publish lock, immediately before the
 * SUBMITTING marker is written.
 *
 * The gate evaluated before the lock is only a pre-flight: `approval.json`, the TITLE stage key,
 * the approved artifact, and the human review decision can all change while a multi-minute R2
 * upload runs. None of those changes may be ignored, so this re-reads the project from disk,
 * re-evaluates the approval against the current artifacts, and requires the artifact that was
 * actually uploaded to be the one the CURRENT approval covers.
 */
async function validateImmediatelyBeforeSubmission(
  input: FinalPreSubmitInput,
): Promise<{ ok: true; verdict: FinalPreSubmitVerdict } | { ok: false; refused: PublishRefusal; reason: string }> {
  let snapshot: string;
  try {
    snapshot = await fs.readFile(input.projectFile, 'utf8');
  } catch {
    return { ok: false, refused: 'state', reason: 'cannot re-read the project immediately before submission; no request was sent' };
  }

  let pipeline: any;
  try {
    pipeline = JSON.parse(snapshot);
  } catch {
    return { ok: false, refused: 'state', reason: 'the project is not valid JSON immediately before submission; no request was sent' };
  }

  const project = pipeline as ReviewProject;
  const review = project?.review;
  if (!project || !review || review.status !== 'approved') {
    return { ok: false, refused: 'review', reason: 'the review is no longer approved; the submission was cancelled before any request was sent' };
  }

  const status = getPublicationStatus(review);
  if (BLOCKING_PUBLICATION_STATUSES.has(status)) {
    return {
      ok: false,
      refused: 'duplicate',
      reason: `publication is already ${status}; refusing to submit again without manual reconciliation`,
    };
  }

  let gate: PublishGateVerdict;
  try {
    gate = await input.evaluateGate({
      projectFile: input.projectFile,
      outputsRoot: input.outputsRoot,
      outputsDir: path.join(input.outputsRoot, input.projectId),
      inputRoot: path.join(input.inputsRoot, input.projectId),
      pipeline,
      projectId: input.projectId,
      ffprobePath: input.ffprobePath,
      mediaSha256: input.mediaSha256,
    });
  } catch (error) {
    return { ok: false, refused: 'integrity', reason: `the integrity approval could not be re-validated (${safeErrorMessage(error)})` };
  }
  if (!gate.ok) {
    return { ok: false, refused: 'integrity', reason: `integrity-bound approval changed or is no longer valid: ${gate.reason ?? 'unknown reason'}` };
  }

  // The artifact that was actually uploaded/presigned must still be the one the CURRENT approval
  // authorizes. Otherwise a re-approval of a different candidate silently republishes the old one.
  const submittedHash = String(input.submittedArtifactHash ?? '').trim().toLowerCase();
  const approvedHash = String(gate.approvedOutputHash ?? '').trim().toLowerCase();
  if (!submittedHash || !approvedHash || submittedHash !== approvedHash) {
    return { ok: false, refused: 'integrity', reason: 'the approved artifact hash changed during submission; no request was sent' };
  }
  const approvedPath = gate.approvedOutputPath;
  if (!approvedPath || (input.submittedArtifactPath && !sameArtifactPath(input.submittedArtifactPath, approvedPath))) {
    return { ok: false, refused: 'integrity', reason: 'the approved artifact path changed during submission; no request was sent' };
  }

  if (gate.approvedArtifactKind === 'candidate') {
    const requestedHash = String(input.mediaSha256 ?? '').trim().toLowerCase();
    if (!HEX64.test(requestedHash) || requestedHash !== approvedHash) {
      return { ok: false, refused: 'integrity', reason: 'candidate publishing requires mediaSha256 equal to the currently approved artifact hash' };
    }
  }

  return { ok: true, verdict: { ok: true, project, review, gate, snapshot } };
}


/** Keep Zernio's response shape but never echo signed URLs/tokens if it reflects the request. */
function redactPublishResult(value: any, depth = 0): any {
  if (depth > 5) return '[redacted-depth]';
  if (typeof value === 'string') {
    return /X-Amz-|Authorization\s*:|Bearer\s+|https?:\/\/[^\s]*(?:token=|signature=|sig=|access_token=)/i.test(value)
      ? redactSensitiveText(value)
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactPublishResult(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactPublishResult(item, depth + 1)]));
  }
  return value;
}

/**
 * Never print a raw connect/provider response. Values may contain OAuth state, bearer material,
 * or signed URLs; only the safe shape is reported to the terminal.
 */
export function summarizeConnectResponse(response: unknown): Record<string, unknown> {
  if (Array.isArray(response)) {
    return { write_operation: false, response_received: true, response_type: 'array', response_count: response.length };
  }
  if (response && typeof response === 'object') {
    return {
      write_operation: false,
      response_received: true,
      response_type: 'object',
      response_keys: Object.keys(response as Record<string, unknown>).sort(),
    };
  }
  return { write_operation: false, response_received: true, response_type: 'scalar' };
}

/**
 * Perform a gated publish.
 *
 * A successful Zernio response only advances `review.publish.status` to ACCEPTED. The legacy
 * `review.status` stays `approved` and `posted_at`, `zernio_post_id`, and `youtube_url` are not
 * written until `confirmZernioPublication` is called after independent YouTube verification.
 *
 * Duplicate protection has three layers:
 *   1. an exclusive `.publish.lock` beside pipeline.json, so concurrent invocations cannot both
 *      submit;
 *   2. a persisted SUBMITTING/ACCEPTED/AMBIGUOUS/CONFIRMED publication state, so a later
 *      invocation is refused even after the lock is released; and
 *   3. a conditional SUBMITTING write, so a review decision that changes during the upload is
 *      never overwritten by this process.
 *
 * The pre-lock gate verdict is only a pre-flight. Immediately before the SUBMITTING marker is
 * written — and therefore before any provider request — the project is re-read from disk and the
 * integrity/approval gate is re-evaluated against the CURRENT approval artifacts. A revoked
 * approval, a re-approval of a different artifact, or a `review reject` aborts the submission.
 *
 * A timeout or network failure after SUBMITTING is recorded as AMBIGUOUS and the error is
 * re-thrown. Nothing retries automatically.
 */
export async function publishToZernio(req: PublishRequest, deps: PublishDeps = {}): Promise<PublishOutcome> {
  if (req.confirmPublish !== 'YES') return { ok: false, refused: 'confirm', reason: 'Publishing is external. Pass --confirm-publish YES only after explicit approval.' };

  const projectFile = path.resolve(req.projectFile);
  const initialProject = await loadProject(projectFile).catch(() => null);
  if (!initialProject || initialProject.review?.status !== 'approved') return { ok: false, refused: 'review', reason: 'legacy review is not approved' };

  const outputsRoot = req.outputsRoot ?? process.env.OUTPUTS_ROOT ?? path.resolve('outputs');
  const inputsRoot = req.inputsRoot ?? process.env.INPUTS_ROOT ?? path.resolve('inputs');
  const projectId = path.basename(path.dirname(projectFile));
  const pipeline = await fs.readFile(projectFile, 'utf8').then((t) => JSON.parse(t)).catch(() => null);
  if (!pipeline) return { ok: false, refused: 'integrity', reason: 'cannot read pipeline for approval evaluation' };

  const evaluateGate = deps.evaluateGate ?? evaluatePublishGate;
  const gate = await evaluateGate({ projectFile, outputsRoot, outputsDir: path.join(outputsRoot, projectId), inputRoot: path.join(inputsRoot, projectId), pipeline, projectId, ffprobePath: req.ffprobePath ?? process.env.FFPROBE_PATH, mediaSha256: req.mediaSha256 });
  if (!gate.ok) return { ok: false, refused: 'integrity', reason: `integrity-bound approval is not valid: ${gate.reason}` };

  // Defense in depth: the gate already enforces this, but the publisher must never accept a
  // candidate without the exact approved SHA-256 even if a future gate implementation regresses.
  if (gate.approvedArtifactKind === 'candidate') {
    const requestedHash = String(req.mediaSha256 ?? '').trim().toLowerCase();
    const approvedHash = String(gate.approvedOutputHash ?? '').trim().toLowerCase();
    if (!HEX64.test(requestedHash) || !HEX64.test(approvedHash) || requestedHash !== approvedHash) {
      return { ok: false, refused: 'integrity', reason: 'candidate publishing requires mediaSha256 equal to the approved artifact hash' };
    }
  }

  const visibility = req.visibility ?? 'private';
  if (!['public', 'private', 'unlisted'].includes(visibility)) throw new Error('Visibility must be public, private, or unlisted.');
  if (gate.approvedArtifactKind === 'candidate' && visibility !== 'private') {
    return { ok: false, refused: 'integrity', reason: 'candidate publishing requires private visibility' };
  }

  const mediaUrl = String(req.mediaUrl ?? '').trim();
  const mediaFile = String(req.mediaFile ?? '').trim();
  const thumbnailFile = String(req.thumbnailFile ?? '').trim();
  if (Boolean(mediaUrl) === Boolean(mediaFile)) {
    return { ok: false, refused: 'integrity', reason: 'provide exactly one of mediaUrl or mediaFile' };
  }
  if (thumbnailFile && !mediaFile) {
    return { ok: false, refused: 'integrity', reason: 'thumbnailFile requires the local mediaFile workflow' };
  }
  if (mediaUrl && gate.approvedArtifactKind === 'candidate') {
    return {
      ok: false,
      refused: 'integrity',
      reason: 'candidate approvals require the verified private-R2 mediaFile workflow; mediaUrl is rejected to prevent bypassing the approved candidate path, hash, R2 read-back, and presigned URL generation',
    };
  }

  const submissionId = randomUUID();
  const lock = await acquirePublishLock(projectFile, submissionId);
  if (!lock) {
    // A review action takes the same lock, so explain that case instead of blaming a second
    // publisher. Either way nothing is submitted and no state is changed.
    const active = await inspectPublishLock(projectFile).catch((): PublishLockInfo => ({ present: false }));
    if (active.present && active.ownerId?.startsWith('review:')) {
      return {
        ok: false,
        refused: 'state',
        reason: 'a review approval/rejection is currently being applied to this project; no request was sent, retry after the review command finishes',
      };
    }
    return { ok: false, refused: 'duplicate', reason: 'another publisher invocation holds the publish lock; no request was sent' };
  }
  let lockHeld = true;
  const releaseLock = async () => {
    if (!lockHeld) return;
    lockHeld = false;
    await lock.release();
  };

  const save = deps.saveProject ?? saveProject;

  try {
    // Re-read inside the lock. This is what turns a persisted SUBMITTING/ACCEPTED/AMBIGUOUS
    // state into a duplicate refusal for sequential as well as concurrent invocations.
    const project = await loadProject(projectFile).catch(() => null);
    if (!project || project.review?.status !== 'approved') {
      return { ok: false, refused: 'review', reason: 'legacy review is not approved' };
    }
    const currentStatus = getPublicationStatus(project.review);
    if (BLOCKING_PUBLICATION_STATUSES.has(currentStatus)) {
      return {
        ok: false,
        refused: 'duplicate',
        reason: `publication is already ${currentStatus}; refusing to submit again without manual reconciliation`,
        ...(project.review?.publish ? { publication: project.review.publish } : {}),
      };
    }

    // Verify the destination account before creating an R2 service, uploading, or contacting the
    // publisher. The allowlist is authoritative; --account-id can only match it.
    const accountCheck = await verifyApprovedYouTubeAccount(projectId, req.accountId, deps);
    if (!accountCheck.ok) return { ok: false, refused: 'account', reason: accountCheck.reason };

    if (mediaFile && (!gate.approvedOutputPath || !gate.approvedOutputHash)) {
      return { ok: false, refused: 'integrity', reason: 'approved artifact path/hash is unavailable for local media upload' };
    }
    if (mediaFile && !sameArtifactPath(mediaFile, gate.approvedOutputPath!)) {
      return { ok: false, refused: 'integrity', reason: 'local media file does not match the approved artifact path' };
    }

    let resolvedMediaUrl = mediaUrl;
    let thumbnailUrl: string | undefined;
    if (mediaFile) {
      const host = deps.mediaHost ?? createR2MediaService();
      try {
        const uploaded = await host.uploadVideo({
          filePath: mediaFile,
          projectId,
          expectedSha256: gate.approvedOutputHash!,
        });
        resolvedMediaUrl = await host.presign(uploaded);
        if (thumbnailFile) {
          const thumbnail = await host.uploadThumbnail({ filePath: thumbnailFile, projectId });
          thumbnailUrl = await host.presign(thumbnail);
        }
      } catch (error) {
        throw new Error(`R2 media preparation failed: ${redactSensitiveText(error)}`);
      }
    }
    if (!resolvedMediaUrl) return { ok: false, refused: 'integrity', reason: 'no media source was resolved' };

    const payload = buildZernioPayload({
      accountId: accountCheck.account.accountId,
      mediaUrl: resolvedMediaUrl,
      thumbnailUrl,
      title: req.title,
      description: req.description,
      tags: req.tags,
      visibility,
    });

    // Re-run the authoritative gate inside the lock, immediately before the marker is written.
    // The pre-lock verdict above is only a pre-flight: approval.json, the TITLE stage key, the
    // reviewed artifact, and the human decision can all change during the R2 upload.
    const submissionCheck = await validateImmediatelyBeforeSubmission({
      projectFile,
      outputsRoot,
      inputsRoot,
      projectId,
      ffprobePath: req.ffprobePath ?? process.env.FFPROBE_PATH,
      mediaSha256: req.mediaSha256,
      submittedArtifactPath: gate.approvedOutputPath,
      submittedArtifactHash: gate.approvedOutputHash,
      evaluateGate,
    });
    if (!submissionCheck.ok) {
      return { ok: false, refused: submissionCheck.refused, reason: submissionCheck.reason };
    }
    const verified = submissionCheck.verdict;

    const publication: PublicationState = {
      status: 'SUBMITTING',
      submission_id: submissionId,
      submitted_at: new Date().toISOString(),
      http_status: null,
      artifact_path: verified.gate.approvedOutputPath,
      artifact_sha256: String(verified.gate.approvedOutputHash ?? '').toLowerCase() || undefined,
      artifact_kind: verified.gate.approvedArtifactKind,
      account_id: accountCheck.account.accountId,
      visibility,
    };

    // Persist SUBMITTING before the request, but only while the project still contains the exact
    // bytes the under-lock gate re-validated. A concurrent `review reject`/`approve` therefore wins
    // the race and is never overwritten here. If this write fails, no request is sent, so a retry
    // is safe; if a later write fails, the on-disk SUBMITTING marker keeps duplicates blocked.
    try {
      const written = await writeProjectIfUnchanged(
        projectFile,
        verified.snapshot,
        { ...verified.project, review: reviewWithPublication(verified.review, publication) },
        save,
      );
      if (!written) {
        return { ok: false, refused: 'state', reason: 'the review changed while the submission was being prepared; no request was sent' };
      }
    } catch (error) {
      return {
        ok: false,
        refused: 'state',
        reason: `could not persist the SUBMITTING marker; no request was sent (${safeErrorMessage(error)})`,
        publication,
      };
    }

    // Confirm the marker survived before any provider request leaves this machine.
    const marker = await verifySubmissionMarker(projectFile, submissionId);
    if (!marker.ok) return { ok: false, refused: 'state', reason: marker.reason };
    const markerState = { project: marker.project, review: marker.review };

    const transport: ZernioPublishTransport = deps.publishTransport
      ?? (deps.publisher
        ? async (body: any) => ({ status: 200, bodyText: JSON.stringify(await deps.publisher!(body) ?? null) })
        : defaultPublishTransport);

    let response: ZernioTransportResponse;
    try {
      response = await transport(payload);
      // A transport that returns a non-2xx (for example a redirect) instead of throwing is still a
      // failure, never an acceptance.
      if (!(Number.isInteger(response?.status) && response.status >= 200 && response.status < 300)) {
        throw new ZernioPublishHttpError(Number(response?.status) || 0);
      }
    } catch (error) {
      const rawStatus = error instanceof ZernioPublishHttpError ? error.status : null;
      const httpStatus = rawStatus !== null && rawStatus >= 100 ? rawStatus : null;
      // Only the whitelisted statuses prove no post was created and the request can be fixed.
      // 3xx, 408, 409, 425, 5xx, timeouts, and network failures are ambiguous: the provider may
      // have accepted the post even though this process did not receive a usable response.
      const failedStatus = classifyPublishFailure(httpStatus);
      const lastError = failedStatus === 'FAILED'
        ? `provider rejected the request with HTTP ${httpStatus}; safe to retry after fixing the request`
        : `request outcome is ambiguous; do not retry until the provider dashboard is checked (${safeErrorMessage(error)})`;
      const failed: PublicationState = { ...publication, status: failedStatus, http_status: httpStatus, last_error: lastError };
      await persistPublicationState(projectFile, failed, save, markerState).catch(() => {});
      if (failedStatus === 'FAILED') {
        return { ok: false, refused: 'provider', reason: `Zernio publish failed: ${lastError}`, publication: failed };
      }
      throw new Error(`Zernio publish failed: ${lastError}`);
    }

    let body: unknown = null;
    let parseFailed = false;
    try {
      body = response.bodyText ? JSON.parse(response.bodyText) : {};
    } catch {
      parseFailed = true;
    }
    const validated = parseFailed ? { postId: null, youtubeUrl: null } : validateZernioPublishResponse(body);

    if (!validated.postId) {
      const lastError = parseFailed
        ? 'provider returned a success status with a malformed JSON body; do not retry until the provider dashboard is checked'
        : 'provider returned a success status without a non-empty post ID; do not retry until the provider dashboard is checked';
      const ambiguous: PublicationState = { ...publication, status: 'AMBIGUOUS', http_status: response.status, last_error: lastError };
      try {
        await persistPublicationState(projectFile, ambiguous, save, markerState);
      } catch (error) {
        return {
          ok: false,
          refused: 'state',
          reason: `provider outcome is ambiguous and local state could not be saved; do not retry (${safeErrorMessage(error)})`,
          publication: ambiguous,
        };
      }
      return { ok: false, refused: 'ambiguous', reason: lastError, publication: ambiguous };
    }

    const accepted: PublicationState = {
      ...publication,
      status: 'ACCEPTED',
      http_status: response.status,
      accepted_at: new Date().toISOString(),
      zernio_post_id: validated.postId,
      ...(validated.youtubeUrl ? { youtube_url: validated.youtubeUrl } : {}),
      ...(validated.youtubeUrl && extractYouTubeVideoId(validated.youtubeUrl) ? { youtube_video_id: extractYouTubeVideoId(validated.youtubeUrl)! } : {}),
      ...(validated.platformError ? { note: validated.platformError } : {}),
    };

    try {
      await persistPublicationState(projectFile, accepted, save, markerState);
    } catch (error) {
      return {
        ok: false,
        refused: 'state',
        reason: `provider accepted the request but local state could not be saved; do not retry (${safeErrorMessage(error)})`,
        publication: accepted,
      };
    }

    return {
      ok: true,
      accepted: true,
      confirmed: false,
      publication: accepted,
      result: redactPublishResult(body),
      post_id: accepted.zernio_post_id,
      youtube_url: accepted.youtube_url,
    };
  } finally {
    await releaseLock();
  }
}

export interface ConfirmPublicationRequest {
  projectFile: string;
  /** Must equal 'YES'. Confirmation is a separate, explicit step after YouTube Studio review. */
  confirmPublish?: string;
  /** Required when the accepted publication recorded a post ID; must match it exactly. */
  postId?: string;
  /** YouTube URL observed in YouTube Studio/Zernio. Required when the accepted response had none. */
  youtubeUrl?: string;
  note?: string;
}

export type ConfirmPublicationOutcome =
  | { ok: true; publication: PublicationState; review: ReviewState }
  | { ok: false; refused: 'confirm' | 'state' | 'validation' | 'save'; reason: string };

/**
 * The only code path that may mark a review `posted`. Zernio exposes no documented status
 * endpoint in this repository, so confirmation must be an explicit human step after the video
 * is verified independently. This function never contacts Zernio or YouTube.
 *
 * Confirmation is refused when the review is not `approved` (a rejection or a re-opened review
 * wins), when the publication is anything other than `ACCEPTED`, when the operator does not name
 * the exact recorded post ID, and when the supplied URL is not a real HTTPS YouTube video URL.
 */
export async function confirmZernioPublication(
  req: ConfirmPublicationRequest,
  deps: Pick<PublishDeps, 'saveProject'> = {},
): Promise<ConfirmPublicationOutcome> {
  if (req.confirmPublish !== 'YES') {
    return { ok: false, refused: 'confirm', reason: 'Confirming publication is a separate step. Pass --confirm-publish YES only after verifying the video in YouTube Studio.' };
  }

  const projectFile = path.resolve(req.projectFile);
  const project = await loadProject(projectFile).catch(() => null);
  const review = project?.review;
  if (!project || !review) return { ok: false, refused: 'state', reason: 'cannot read the project review state' };

  const status = getPublicationStatus(review);
  const publication = review.publish;
  if (!publication || status !== 'ACCEPTED') {
    return { ok: false, refused: 'state', reason: `publication is not ACCEPTED (found ${status}); only an accepted submission can be confirmed` };
  }
  if (review.status !== 'approved') {
    return {
      ok: false,
      refused: 'state',
      reason: `the review is ${review.status}; an accepted publication cannot be confirmed after the review was rejected or re-opened`,
    };
  }

  const recordedPostId = String(publication.zernio_post_id ?? '').trim();
  if (!recordedPostId) return { ok: false, refused: 'state', reason: 'accepted publication has no recorded post ID' };
  const requestedPostId = String(req.postId ?? '').trim();
  if (!requestedPostId) {
    return {
      ok: false,
      refused: 'validation',
      reason: `the accepted publication recorded post ID ${recordedPostId}; pass --post-id with exactly that value to confirm this specific submission`,
    };
  }
  if (requestedPostId !== recordedPostId) {
    return { ok: false, refused: 'validation', reason: 'the supplied post ID does not match the accepted submission' };
  }

  const youtubeUrl = String(req.youtubeUrl ?? publication.youtube_url ?? '').trim();
  if (!youtubeUrl) return { ok: false, refused: 'validation', reason: 'a YouTube video URL is required to confirm publication' };
  const parsedUrl = parseYouTubeVideoUrl(youtubeUrl);
  if (!parsedUrl) {
    return {
      ok: false,
      refused: 'validation',
      reason: 'the supplied URL is not a valid HTTPS YouTube video URL; expected a watch, shorts, embed, live, or youtu.be link with an 11-character video ID',
    };
  }
  const videoId = parsedUrl.videoId;

  // Preserve provider reconciliation notes instead of replacing them with the operator note.
  const existingNote = String(publication.note ?? '').trim();
  const requestedNote = String(req.note ?? '').trim();
  const mergedNote = requestedNote
    ? (existingNote ? `${existingNote} | ${requestedNote}` : requestedNote)
    : existingNote;

  const now = new Date().toISOString();
  const confirmed: PublicationState = {
    ...publication,
    status: 'CONFIRMED',
    confirmed_at: now,
    youtube_url: youtubeUrl,
    youtube_video_id: videoId,
    ...(mergedNote ? { note: mergedNote } : {}),
  };
  const nextReview: ReviewState = {
    ...review,
    status: 'posted',
    posted_at: now,
    zernio_post_id: recordedPostId,
    youtube_url: youtubeUrl,
    publish: confirmed,
  };

  try {
    await (deps.saveProject ?? saveProject)(projectFile, { ...project, review: nextReview });
  } catch (error) {
    return { ok: false, refused: 'save', reason: `could not persist confirmation; the accepted submission was not changed (${safeErrorMessage(error)})` };
  }

  return { ok: true, publication: confirmed, review: nextReview };
}

async function main(): Promise<void> {
  await loadLocalEnvironment();
  const command = process.argv[2] ?? 'test';
  if (command === 'test') {
    const response = await request('/accounts');
    const accounts = Array.isArray(response) ? response : (response as { accounts?: unknown[] }).accounts ?? [];
    const youtubeAccounts = accounts.filter((account: any) => String(account.platform ?? account.type ?? '').toLowerCase() === 'youtube');
    console.log(JSON.stringify({ configured: true, accounts: accounts.length, youtube_accounts: youtubeAccounts.length, write_operation: false }, null, 2));
  } else if (command === 'accounts') {
    const accounts = await inspectZernioAccounts({ platform: arg('--platform') });
    console.log(JSON.stringify({ accounts }, null, 2));
  } else if (command === 'preflight') {
    const projectId = arg('--project-id');
    if (!projectId) throw new Error('Pass --project-id <project id>.');
    const result = await runYouTubePreflight({
      projectId,
      platform: arg('--platform') ?? 'youtube',
      inspectAccounts: inspectZernioAccounts,
    });
    console.log(JSON.stringify(toYouTubePreflightOutput(result), null, 2));
    if (result.preflight !== 'PASS') process.exitCode = 1;
  } else if (command === 'prepare-media') {
    const result = await prepareMedia({
      projectId: arg('--project-id') ?? '',
      mediaFile: arg('--media-file') ?? '',
      mediaSha256: arg('--media-sha256') ?? '',
      confirmR2Upload: arg('--confirm-r2-upload'),
      outputsRoot: arg('--outputs-root') ?? process.env.OUTPUTS_ROOT,
      probePresignedGet: process.argv.includes('--probe-presigned-get'),
    });
    console.log(JSON.stringify(toPrepareMediaOutput(result), null, 2));
    if (!result.ok) {
      console.error(`prepare-media failed: ${result.reason ?? 'UNKNOWN'}`);
      process.exitCode = 1;
    }
  } else if (command === 'connect-youtube') {
    const profileId = arg('--profile-id');
    if (!profileId) throw new Error('Pass --profile-id <Zernio profile id>.');
    const response = await request(`/connect/youtube?profileId=${encodeURIComponent(profileId)}`);
    console.log(JSON.stringify(summarizeConnectResponse(response), null, 2));
  } else if (command === 'publish') {
    const projectFile = arg('--project'); const accountId = arg('--account-id'); const title = arg('--title');
    const mediaUrl = arg('--media-url'); const mediaFile = arg('--media-file'); const thumbnailFile = arg('--thumbnail-file');
    if (!projectFile || !accountId || !title || (!mediaUrl && !mediaFile)) {
      throw new Error('Pass --project, --account-id, --title, and exactly one of --media-url or --media-file. Candidate approvals require --media-file.');
    }
    if (mediaUrl && mediaFile) throw new Error('Pass either --media-url or --media-file, not both.');
    if (thumbnailFile && !mediaFile) throw new Error('--thumbnail-file requires --media-file so the thumbnail can be uploaded privately in-process.');
    const outcome = await publishToZernio({
      projectFile, accountId, mediaUrl, mediaFile, thumbnailFile, title,
      description: arg('--description'), tags: arg('--tags'), visibility: arg('--visibility'),
      mediaSha256: arg('--media-sha256'),
      confirmPublish: arg('--confirm-publish'),
    });
    if (!outcome.ok) throw new Error(`Publish refused (${outcome.refused}): ${outcome.reason}`);
    console.log(JSON.stringify({
      accepted: true,
      confirmed: false,
      publication_status: outcome.publication.status,
      post_id: outcome.post_id ?? null,
      youtube_url: outcome.youtube_url ?? null,
      next_step: 'Verify the video in YouTube Studio, then run confirm-publish with --confirm-publish YES.',
    }, null, 2));
  } else if (command === 'confirm-publish') {
    const projectFile = arg('--project');
    if (!projectFile) throw new Error('Pass --project <pipeline.json>.');
    const outcome = await confirmZernioPublication({
      projectFile,
      confirmPublish: arg('--confirm-publish'),
      postId: arg('--post-id'),
      youtubeUrl: arg('--youtube-url'),
      note: arg('--note'),
    });
    if (!outcome.ok) throw new Error(`Confirmation refused (${outcome.refused}): ${outcome.reason}`);
    console.log(JSON.stringify({
      confirmed: true,
      publication_status: outcome.publication.status,
      post_id: outcome.publication.zernio_post_id ?? null,
      youtube_url: outcome.publication.youtube_url ?? null,
      posted_at: outcome.review.posted_at ?? null,
    }, null, 2));
  } else if (command === 'publication-status') {
    const projectFile = arg('--project');
    if (!projectFile) throw new Error('Pass --project <pipeline.json>.');
    const project = await loadProject(path.resolve(projectFile));
    console.log(JSON.stringify({
      project_id: project.project_id ?? null,
      review_status: project.review?.status ?? null,
      publication_status: getPublicationStatus(project.review),
      publication: project.review?.publish ?? null,
    }, null, 2));
  } else throw new Error('Use one of: test, accounts, preflight, prepare-media, connect-youtube, publish, confirm-publish, publication-status.');
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => { console.error(String(e?.message ?? e)); process.exitCode = 1; });
}
