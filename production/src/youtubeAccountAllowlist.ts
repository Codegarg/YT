/**
 * Project-specific YouTube account allowlist.
 *
 * This is deliberately separate from the approved-artifact record: an artifact approval
 * authorizes the video, while this file authorizes the destination account for that project.
 * The publisher must require BOTH to pass, and the caller-supplied --account-id is only a
 * request to use an account that is already listed here. It cannot add or override an entry.
 *
 * The file contains only public identifiers/display names. Never put API keys or tokens here.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ApprovedYouTubeAccount {
  accountId: string;
  displayName: string;
}

export interface YouTubeAccountAllowlist {
  schema_version: 1;
  projects: Record<string, ApprovedYouTubeAccount>;
}

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

/** Default allowlist used by the production publisher. */
export const DEFAULT_YOUTUBE_ACCOUNT_ALLOWLIST_PATH = path.resolve(moduleDirectory, '../config/youtube-accounts.json');

const INVALID_ALLOWLIST = 'YouTube account allowlist is invalid.';

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${INVALID_ALLOWLIST} ${field} must be a non-empty string.`);
  return value.trim();
}

/**
 * Validate the allowlist shape without echoing any values. A malformed or missing allowlist
 * fails closed; it is never treated as "no restriction".
 */
export function validateYouTubeAccountAllowlist(value: unknown): YouTubeAccountAllowlist {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(INVALID_ALLOWLIST);
  const record = value as Record<string, unknown>;
  if (record.schema_version !== 1) throw new Error(`${INVALID_ALLOWLIST} schema_version must be 1.`);
  if (!record.projects || typeof record.projects !== 'object' || Array.isArray(record.projects)) {
    throw new Error(`${INVALID_ALLOWLIST} projects must be an object.`);
  }

  const projects: Record<string, ApprovedYouTubeAccount> = Object.create(null);
  for (const [projectId, entry] of Object.entries(record.projects as Record<string, unknown>)) {
    const id = requireNonEmptyString(projectId, 'project id');
    if (/\s/.test(id)) throw new Error(`${INVALID_ALLOWLIST} project id must not contain whitespace.`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${INVALID_ALLOWLIST} project entry is invalid.`);
    }
    const item = entry as Record<string, unknown>;
    const accountId = requireNonEmptyString(item.accountId, 'accountId');
    if (/\s/.test(accountId)) throw new Error(`${INVALID_ALLOWLIST} accountId must not contain whitespace.`);
    const displayName = requireNonEmptyString(item.displayName, 'displayName');
    projects[id] = { accountId, displayName };
  }

  return { schema_version: 1, projects };
}

/** Read and validate the local allowlist. Missing/unreadable/malformed files fail closed. */
export async function loadYouTubeAccountAllowlist(
  filePath: string = DEFAULT_YOUTUBE_ACCOUNT_ALLOWLIST_PATH,
): Promise<YouTubeAccountAllowlist> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch {
    throw new Error('YouTube account allowlist is missing or unreadable.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('YouTube account allowlist is not valid JSON.');
  }
  return validateYouTubeAccountAllowlist(parsed);
}

/** Exact project lookup. There is no wildcard, fallback, or caller-supplied override. */
export function resolveApprovedYouTubeAccount(
  allowlist: YouTubeAccountAllowlist,
  projectId: string,
): ApprovedYouTubeAccount | null {
  if (!Object.prototype.hasOwnProperty.call(allowlist.projects, projectId)) return null;
  const account = allowlist.projects[projectId];
  return account ? { ...account } : null;
}
