/**
 * Pixabay BGM provenance contract (manual ingestion).
 *
 * A human downloads a track from Pixabay in a browser, places the file at the canonical
 * `music/background-music.mp3` path, and records provenance in the canonical
 * `music/background-music.license.json` sidecar. This module validates that contract.
 *
 * DESIGN CONSTRAINTS (deliberate):
 *   · PURE / BROWSER-FREE. No network, no scraping, no unofficial Pixabay API. Nothing here ever
 *     contacts Pixabay; `source_url` is provenance the human supplies, not something we verify
 *     against a remote service.
 *   · FAIL CLOSED. Every malformed, missing, mismatched or unverifiable field is rejected with a
 *     structured failure code. Nothing is inferred, defaulted or repaired.
 *   · WE NEVER CLAIM CONTENT-ID SAFETY. Pixabay's licence permits use but says nothing about
 *     YouTube Content ID. `content_id_registered` is recorded by the human as explicit boolean
 *     metadata; `true` does NOT invalidate the asset but is surfaced as a state/warning so the
 *     human can decide. Absence of the field is a failure — it must be explicit, never inferred.
 *   · PROVIDER PINNED. Only `provider: "pixabay"` is accepted here. An arbitrary or misspelled
 *     provider never reaches this contract.
 *
 * The existing CC0/CC-BY licence policy (`bgm.ts`) and every other input category are untouched.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { measureAudioDuration } from './narrationDuration.js';

// ---------------------------------------------------------------------------------------
// Canonical names + pinned constants
// ---------------------------------------------------------------------------------------

/** Canonical audio filename. The extension is fixed; Pixabay downloads are MP3. */
export const PIXABAY_MUSIC_FILENAME = 'background-music.mp3';
/** Canonical provenance sidecar filename (matches what validateMusicInputs reads). */
export const PIXABAY_LICENSECAR_FILENAME = 'background-music.license.json';

export const PIXABAY_PROVIDER = 'pixabay';
export const PIXABAY_LICENSE = 'Pixabay Content License';
export const PIXABAY_LICENSE_URL = 'https://pixabay.com/service/license-summary/';

/** Hosts a Pixabay `source_url` may legitimately live on. */
export const PIXABAY_ALLOWED_HOSTS: readonly string[] = ['pixabay.com', 'www.pixabay.com', 'pixabay.net', 'www.pixabay.net'];

/** Tolerance when comparing the declared duration against the ffprobe-measured duration. */
export const PIXABAY_DURATION_TOLERANCE_SECONDS = 1.0;

/**
 * Structured failure codes. Every rejection maps to exactly one of these so a caller can react
 * programmatically instead of string-matching prose.
 */
export type PixabayFailureCode =
  | 'SIDECAR_MISSING'
  | 'SIDECAR_UNREADABLE'
  | 'SIDECAR_MALFORMED'
  | 'SIDECAR_FILENAME_NONCANONICAL'
  | 'AUDIO_FILENAME_NONCANONICAL'
  | 'PROVIDER_MISSING'
  | 'PROVIDER_NOT_PIXABAY'
  | 'LICENSE_MISMATCH'
  | 'LICENSE_URL_MISMATCH'
  | 'SOURCE_URL_INVALID'
  | 'TITLE_INVALID'
  | 'AUTHOR_INVALID'
  | 'TIMESTAMP_INVALID'
  | 'DURATION_INVALID'
  | 'DURATION_MISMATCH'
  | 'SHA256_MISSING'
  | 'SHA256_MALFORMED'
  | 'SHA256_MISMATCH'
  | 'AUDIO_MISSING'
  | 'AUDIO_INVALID'
  | 'ATTRIBUTION_REQUIRED_NOT_FALSE'
  | 'ATTRIBUTION_TEXT_INVALID'
  | 'CONTENT_ID_FLAG_MISSING'
  | 'CONTENT_ID_FLAG_INVALID';

export interface PixabayWarning {
  code: 'CONTENT_ID_REGISTERED';
  message: string;
}

export interface PixabayMetadata {
  provider: typeof PIXABAY_PROVIDER;
  title: string;
  author: string;
  source_url: string;
  license: typeof PIXABAY_LICENSE;
  license_url: typeof PIXABAY_LICENSE_URL;
  attribution_required: false;
  attribution_text: string | null;
  content_id_registered: boolean;
  downloaded_at: string;
  sha256: string;
  duration_seconds: number;
}

export type PixabayValidation =
  | {
      ok: true;
      metadata: PixabayMetadata;
      /** True when the human declared the track Content-ID-registered. Surfaced, never rejected. */
      contentIdRegistered: boolean;
      warnings: PixabayWarning[];
    }
  | { ok: false; code: PixabayFailureCode; reason: string };

/** Everything the pure validator needs that requires the filesystem. */
export interface PixabayValidationContext {
  /** Declared `duration_seconds` tolerance source: the ffprobe-measured audio duration. */
  measuredDurationSeconds: number | null;
  /** SHA-256 of the actual local audio file. */
  actualSha256: string | null;
  /** Basenames actually present on disk, used for canonical-name enforcement. */
  audioBasename?: string | null;
  sidecarBasename?: string | null;
}

// ---------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parse a JSON string into an object, or report `SIDECAR_MALFORMED`. Pure. */
export function parsePixabaySidecar(raw: string): { ok: true; value: unknown } | { ok: false; code: PixabayFailureCode; reason: string } {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, code: 'SIDECAR_MALFORMED', reason: 'Licence sidecar is empty.' };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e: any) {
    return { ok: false, code: 'SIDECAR_MALFORMED', reason: `Licence sidecar is not valid JSON: ${String(e?.message ?? e)}` };
  }
}

/**
 * True ONLY when the sidecar declares the Pixabay provider. Used to route metadata to this
 * contract without weakening the existing CC0/CC-BY path for every other provider.
 */
export function isPixabaySidecar(value: unknown): boolean {
  return isPlainObject(value) && value.provider === PIXABAY_PROVIDER;
}

/** True when `value` is an https URL on an allowed Pixabay host. Pure. */
export function isPixabaySourceUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  let u: URL;
  try { u = new URL(value.trim()); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  return PIXABAY_ALLOWED_HOSTS.includes(u.hostname.toLowerCase());
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isSha256Hex = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v.trim());
const isIsoTimestamp = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && !Number.isNaN(Date.parse(v));

/**
 * PURE, deterministic Pixabay metadata validation. Performs no I/O and no network access.
 *
 * Field order is deliberate and fixed so the first reported failure is stable: identity
 * (provider/license) → provenance (URL/title/author/timestamp) → integrity (duration/SHA) →
 * policy booleans.
 */
export function validatePixabayMetadata(value: unknown, ctx: PixabayValidationContext): PixabayValidation {
  // --- canonical filename enforcement -------------------------------------------------
  if (ctx.audioBasename && ctx.audioBasename !== PIXABAY_MUSIC_FILENAME) {
    return { ok: false, code: 'AUDIO_FILENAME_NONCANONICAL', reason: `Audio file must be named "${PIXABAY_MUSIC_FILENAME}" (found "${ctx.audioBasename}").` };
  }
  if (ctx.sidecarBasename && ctx.sidecarBasename !== PIXABAY_LICENSECAR_FILENAME) {
    return { ok: false, code: 'SIDECAR_FILENAME_NONCANONICAL', reason: `Licence sidecar must be named "${PIXABAY_LICENSECAR_FILENAME}" (found "${ctx.sidecarBasename}").` };
  }

  if (!isPlainObject(value)) {
    return { ok: false, code: 'SIDECAR_MALFORMED', reason: 'Licence sidecar must be a JSON object.' };
  }

  // --- 1/2/15. provider is pinned ------------------------------------------------------
  if (!('provider' in value)) {
    return { ok: false, code: 'PROVIDER_MISSING', reason: 'Licence sidecar must declare an explicit "provider".' };
  }
  if (value.provider !== PIXABAY_PROVIDER) {
    return { ok: false, code: 'PROVIDER_NOT_PIXABAY', reason: `Pixabay ingestion requires provider "${PIXABAY_PROVIDER}" (found ${JSON.stringify(value.provider)}).` };
  }

  // --- 2/3. licence identity is pinned -------------------------------------------------
  if (value.license !== PIXABAY_LICENSE) {
    return { ok: false, code: 'LICENSE_MISMATCH', reason: `Licence must be exactly "${PIXABAY_LICENSE}" (found ${JSON.stringify(value.license)}).` };
  }
  if (value.license_url !== PIXABAY_LICENSE_URL) {
    return { ok: false, code: 'LICENSE_URL_MISMATCH', reason: `license_url must be exactly "${PIXABAY_LICENSE_URL}" (found ${JSON.stringify(value.license_url)}).` };
  }

  // --- 4. source_url must be an https Pixabay URL --------------------------------------
  const sourceUrl = value.source_url;
  if (!isPixabaySourceUrl(sourceUrl)) {
    return { ok: false, code: 'SOURCE_URL_INVALID', reason: `source_url must be an https URL on a Pixabay host (${PIXABAY_ALLOWED_HOSTS.join(', ')}); found ${JSON.stringify(sourceUrl)}.` };
  }

  // --- 5. title / author must be non-empty ---------------------------------------------
  if (!isNonEmptyString(value.title)) {
    return { ok: false, code: 'TITLE_INVALID', reason: 'title must be a non-empty string.' };
  }
  if (!isNonEmptyString(value.author)) {
    return { ok: false, code: 'AUTHOR_INVALID', reason: 'author must be a non-empty string.' };
  }

  // --- 9. downloaded_at must be a real timestamp ---------------------------------------
  if (!isIsoTimestamp(value.downloaded_at)) {
    return { ok: false, code: 'TIMESTAMP_INVALID', reason: `downloaded_at must be a valid ISO-8601 timestamp (found ${JSON.stringify(value.downloaded_at)}).` };
  }

  // --- 7/8. duration and SHA must match the ACTUAL local file ---------------------------
  if (typeof value.duration_seconds !== 'number' || !Number.isFinite(value.duration_seconds) || value.duration_seconds <= 0) {
    return { ok: false, code: 'DURATION_INVALID', reason: `duration_seconds must be a number greater than 0 (found ${JSON.stringify(value.duration_seconds)}).` };
  }
  if (ctx.measuredDurationSeconds !== null) {
    const drift = Math.abs(ctx.measuredDurationSeconds - value.duration_seconds);
    if (drift > PIXABAY_DURATION_TOLERANCE_SECONDS) {
      return { ok: false, code: 'DURATION_MISMATCH', reason: `duration_seconds ${value.duration_seconds}s does not match the measured audio duration ${ctx.measuredDurationSeconds}s (tolerance ${PIXABAY_DURATION_TOLERANCE_SECONDS}s).` };
    }
  }
  if (!('sha256' in value)) {
    return { ok: false, code: 'SHA256_MISSING', reason: 'Licence sidecar must declare the audio file "sha256".' };
  }
  if (!isSha256Hex(value.sha256)) {
    return { ok: false, code: 'SHA256_MALFORMED', reason: 'sha256 must be a 64-character hexadecimal digest.' };
  }
  if (ctx.actualSha256 === null) {
    return { ok: false, code: 'AUDIO_MISSING', reason: 'The local audio file could not be read, so the declared sha256 cannot be verified.' };
  }
  if (value.sha256.trim().toLowerCase() !== ctx.actualSha256.toLowerCase()) {
    return { ok: false, code: 'SHA256_MISMATCH', reason: `Declared sha256 ${value.sha256} does not match the actual file digest ${ctx.actualSha256}.` };
  }

  // --- 10. Pixabay requires no attribution ---------------------------------------------
  if (value.attribution_required !== false) {
    return { ok: false, code: 'ATTRIBUTION_REQUIRED_NOT_FALSE', reason: 'Pixabay does not require attribution, so attribution_required must be exactly false.' };
  }
  if (!('attribution_text' in value)) {
    return { ok: false, code: 'ATTRIBUTION_TEXT_INVALID', reason: 'attribution_text must be present (use null when there is no credit line).' };
  }
  if (value.attribution_text !== null && !isNonEmptyString(value.attribution_text)) {
    return { ok: false, code: 'ATTRIBUTION_TEXT_INVALID', reason: 'attribution_text must be a non-empty string or null.' };
  }

  // --- 11/12. content_id_registered is explicit metadata, surfaced but never inferred ----
  if (!('content_id_registered' in value)) {
    return { ok: false, code: 'CONTENT_ID_FLAG_MISSING', reason: 'content_id_registered must be declared explicitly as a boolean; it is never inferred.' };
  }
  if (typeof value.content_id_registered !== 'boolean') {
    return { ok: false, code: 'CONTENT_ID_FLAG_INVALID', reason: `content_id_registered must be a boolean (found ${JSON.stringify(value.content_id_registered)}).` };
  }
  const contentIdRegistered = value.content_id_registered;

  const metadata: PixabayMetadata = {
    provider: PIXABAY_PROVIDER,
    title: value.title.trim(),
    author: value.author.trim(),
    source_url: (sourceUrl as string).trim(),
    license: PIXABAY_LICENSE,
    license_url: PIXABAY_LICENSE_URL,
    attribution_required: false,
    attribution_text: (value.attribution_text as string | null)?.trim() ? (value.attribution_text as string).trim() : null,
    content_id_registered: contentIdRegistered,
    downloaded_at: value.downloaded_at,
    sha256: value.sha256.trim().toLowerCase(),
    duration_seconds: value.duration_seconds,
  };

  // 12/13. Surfaced, NOT rejected — and never phrased as a Content-ID-free guarantee.
  const warnings: PixabayWarning[] = contentIdRegistered
    ? [{ code: 'CONTENT_ID_REGISTERED', message: 'This track is declared Content-ID-registered. It is not rejected, but you may prefer a different track. Pixabay licensing does not clear Content ID.' }]
    : [];

  return { ok: true, metadata, contentIdRegistered, warnings };
}

/** SHA-256 of a file's bytes, or null when unreadable. Pure I/O helper (no network). */
export async function sha256File(file: string): Promise<string | null> {
  try {
    const buf = await fsp.readFile(file);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch { return null; }
}

/**
 * Read + validate the canonical Pixabay BGM pair from a project's input root.
 * Filesystem + ffprobe only; never touches the network.
 */
export async function validatePixabayBgm(inputRoot: string, opts: { ffprobePath?: string } = {}): Promise<PixabayValidation & { musicPath?: string; sidecarPath?: string }> {
  const musicDir = path.join(path.resolve(inputRoot), 'music');
  const musicPath = path.join(musicDir, PIXABAY_MUSIC_FILENAME);
  const sidecarPath = path.join(musicDir, PIXABAY_LICENSECAR_FILENAME);
  const suffix = { musicPath, sidecarPath };

  let raw: string;
  try {
    raw = await fsp.readFile(sidecarPath, 'utf8');
  } catch (e: any) {
    const code: PixabayFailureCode = e?.code === 'ENOENT' ? 'SIDECAR_MISSING' : 'SIDECAR_UNREADABLE';
    return { ok: false, code, reason: `Licence sidecar "${PIXABAY_LICENSECAR_FILENAME}" could not be read (${String(e?.message ?? e)}).`, ...suffix };
  }

  const parsed = parsePixabaySidecar(raw);
  if (!parsed.ok) return { ...parsed, ...suffix };

  const stat = await fsp.stat(musicPath).catch(() => null);
  if (!stat || !stat.isFile() || stat.size <= 0) {
    return { ok: false, code: 'AUDIO_MISSING', reason: `Audio file "${PIXABAY_MUSIC_FILENAME}" is missing, empty or not a regular file.`, ...suffix };
  }

  const measured = await measureAudioDuration(musicPath);
  if (!measured.ok) {
    return { ok: false, code: 'AUDIO_INVALID', reason: `Audio file "${PIXABAY_MUSIC_FILENAME}" is not valid decodable audio: ${measured.reason}`, ...suffix };
  }

  const actualSha256 = await sha256File(musicPath);
  const result = validatePixabayMetadata(parsed.value, {
    measuredDurationSeconds: measured.durationSeconds,
    actualSha256,
    audioBasename: path.basename(musicPath),
    sidecarBasename: path.basename(sidecarPath),
  });
  return { ...result, ...suffix };
}