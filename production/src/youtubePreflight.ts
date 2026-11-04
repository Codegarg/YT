/**
 * Read-only YouTube publishing preflight.
 *
 * This module deliberately depends only on the local project allowlist and an injected
 * read-only account inspector. It has no R2, media, publisher, OAuth, or scheduling imports.
 * The production CLI injects `inspectZernioAccounts`, which performs exactly one
 * `GET /accounts?platform=youtube` request.
 *
 * Failure results contain only controlled reason codes. Raw API errors, response bodies,
 * credentials, URLs, and unapproved account metadata are never returned or printed.
 */
import { loadYouTubeAccountAllowlist, resolveApprovedYouTubeAccount } from './youtubeAccountAllowlist.js';

export type YouTubePreflightReason =
  | 'UNSUPPORTED_PLATFORM'
  | 'MALFORMED_ALLOWLIST'
  | 'MISSING_PROJECT_ENTRY'
  | 'ACCOUNT_API_FAILURE'
  | 'ACCOUNT_MISSING'
  | 'ACCOUNT_ID_MISMATCH'
  | 'AMBIGUOUS_ACCOUNT'
  | 'WRONG_PLATFORM'
  | 'DISPLAY_NAME_MISMATCH'
  | 'ACCOUNT_INACTIVE'
  | 'UNKNOWN_ACCOUNT_STATE';

export interface YouTubePreflightResult {
  projectId: string;
  platform: 'youtube';
  accountId: string | null;
  displayName: string | null;
  active: boolean | null;
  preflight: 'PASS' | 'FAIL';
  /** Controlled, sanitized failure code. Omitted on PASS. */
  reason?: YouTubePreflightReason;
}

/** The safe subset returned by the existing Zernio account inspector. */
export interface YouTubePreflightLiveAccount {
  platform: string;
  accountId: string;
  displayName: string | null;
  isActive: boolean | null;
}

export type YouTubePreflightInspector = (
  input: { platform: 'youtube' },
) => Promise<YouTubePreflightLiveAccount[]>;

export interface YouTubePreflightInput {
  projectId: string;
  /** Requested platform; only `youtube` is supported. Defaults to `youtube`. */
  platform?: string;
  /** Test-only override; production uses the default project allowlist. */
  allowlistPath?: string;
  /** Production: `inspectZernioAccounts`; tests: deterministic fake. */
  inspectAccounts: YouTubePreflightInspector;
}

/** The exact six sanitized fields printed by the CLI. */
export interface YouTubePreflightOutput {
  projectId: string;
  platform: 'youtube';
  accountId: string | null;
  displayName: string | null;
  active: boolean | null;
  preflight: string;
}

/**
 * Reduce the internal result to the approved CLI surface. Failure detail is encoded as a
 * controlled `FAIL_<CODE>` value so no extra fields or raw errors are printed.
 */
export function toYouTubePreflightOutput(result: YouTubePreflightResult): YouTubePreflightOutput {
  return {
    projectId: result.projectId,
    platform: result.platform,
    accountId: result.accountId,
    displayName: result.displayName,
    active: result.active,
    preflight: result.preflight === 'PASS' ? 'PASS' : `FAIL_${result.reason ?? 'UNKNOWN'}`,
  };
}

function baseResult(projectId: string): YouTubePreflightResult {
  return {
    projectId,
    platform: 'youtube',
    accountId: null,
    displayName: null,
    active: null,
    preflight: 'FAIL',
  };
}

function failed(
  base: YouTubePreflightResult,
  reason: YouTubePreflightReason,
  account?: { accountId: string; displayName: string },
  active: boolean | null = null,
): YouTubePreflightResult {
  return {
    ...base,
    ...(account ? { accountId: account.accountId, displayName: account.displayName } : {}),
    active,
    preflight: 'FAIL',
    reason,
  };
}

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Check the local allowlist entry and the live read-only account list.
 * Every ambiguity or unexpected shape fails closed.
 */
export async function runYouTubePreflight(input: YouTubePreflightInput): Promise<YouTubePreflightResult> {
  const projectId = normalized(input.projectId);
  const requestedPlatform = normalized(input.platform ?? 'youtube').toLowerCase();
  const base = baseResult(projectId);

  if (requestedPlatform !== 'youtube') {
    return failed(base, 'UNSUPPORTED_PLATFORM');
  }

  let allowlist;
  try {
    allowlist = await loadYouTubeAccountAllowlist(input.allowlistPath);
  } catch {
    return failed(base, 'MALFORMED_ALLOWLIST');
  }

  const approved = resolveApprovedYouTubeAccount(allowlist, projectId);
  if (!approved) return failed(base, 'MISSING_PROJECT_ENTRY');

  const expected = { ...base, accountId: approved.accountId, displayName: approved.displayName };

  let accounts: YouTubePreflightLiveAccount[];
  try {
    accounts = await input.inspectAccounts({ platform: 'youtube' });
  } catch {
    return failed(expected, 'ACCOUNT_API_FAILURE', approved);
  }
  if (!Array.isArray(accounts)) {
    return failed(expected, 'ACCOUNT_API_FAILURE', approved);
  }

  const sameId = accounts.filter((account) =>
    account && typeof account === 'object' && normalized(account.accountId) === approved.accountId,
  );
  if (sameId.length === 0) {
    const hasYouTubeAccount = accounts.some((account) =>
      account && typeof account === 'object' && normalized(account.platform).toLowerCase() === 'youtube',
    );
    return failed(expected, hasYouTubeAccount ? 'ACCOUNT_ID_MISMATCH' : 'ACCOUNT_MISSING', approved);
  }
  if (sameId.length > 1) {
    return failed(expected, 'AMBIGUOUS_ACCOUNT', approved);
  }

  const live = sameId[0];
  if (normalized(live.platform).toLowerCase() !== 'youtube') {
    return failed(expected, 'WRONG_PLATFORM', approved);
  }
  if (normalized(live.displayName) !== approved.displayName) {
    return failed(expected, 'DISPLAY_NAME_MISMATCH', approved);
  }
  if (live.isActive === false) {
    return failed(expected, 'ACCOUNT_INACTIVE', approved, false);
  }
  if (live.isActive !== true) {
    return failed(expected, 'UNKNOWN_ACCOUNT_STATE', approved);
  }

  return {
    ...expected,
    active: true,
    preflight: 'PASS',
  };
}
