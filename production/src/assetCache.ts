/**
 * Local asset staging / cache layer (STEP-8CU).
 *
 * Purpose: a deterministic, resumable LOCAL boundary between Flow's intrinsic image
 * extraction and the local scene renderer. If a background has already been extracted and
 * validated, future runs REUSE it — they never reopen Flow or spend credits.
 *
 * Scope of this step: BACKGROUND assets only. Characters are intentionally NOT cached yet
 * (live 8CQ proved character imagery is cross-origin and unobtainable).
 *
 * The cache is durable across Flow project / browser-session changes: it stores only
 * intrinsic image bytes + derived metadata. It NEVER stores CDN URLs, browser session URLs,
 * credentials, Flow project secrets, or volatile Flow IDs.
 *
 * Pure helpers (tag → filename → path, record/PNG validation) are isolated from filesystem
 * I/O so path safety and validation are unit-testable offline.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Renderer-relevant target resolution (from 8CO: Flow intrinsic background). */
export const INTRINSIC_BACKGROUND_WIDTH = 1376;
export const INTRINSIC_BACKGROUND_HEIGHT = 768;

/**
 * Minimum acceptable cacheable background resolution.
 *
 * The proven Flow intrinsic background is 1376x768 (STEP-8CO) and is explicitly valid: the
 * scene renderer upscales it to 1920x1080 via a 16:9 fill (scale=...:force_original_aspect_
 * ratio=increase,crop). The cache floor is therefore one HD step BELOW the render target
 * (720p / 1280x720), not the render output size — otherwise the real background could never
 * be cached.
 */
export const MIN_BACKGROUND_WIDTH = 1280;
export const MIN_BACKGROUND_HEIGHT = 720;

/** Accepted 16:9 aspect tolerance (1376x768 = 1.792:1 is accepted per 8CO). */
export const ASPECT_TOLERANCE = 0.09;

const PNG_SIGNATURE = '89504e470d0a1a0a';

/** Public cache result states. A HIT means the file exists AND passed validation. */
export type AssetCacheState = 'CACHE_HIT' | 'CACHE_MISS' | 'CACHE_INVALID' | 'CACHE_CREATED' | 'CACHE_WRITE_FAILED';

export type AssetCacheSource = 'flow-intrinsic';

/** Metadata stored alongside a cached background (no secrets, no volatile Flow IDs). */
export interface BackgroundCacheRecord {
  tag: string;
  path: string;
  width: number;
  height: number;
  bytes: number;
  format: 'png';
  source: AssetCacheSource;
  validated: true;
  createdAt: string;
}

export type BackgroundCacheResult =
  | { state: 'CACHE_HIT'; ok: true; tag: string; path: string; width: number; height: number; bytes: number; source: AssetCacheSource; record?: BackgroundCacheRecord }
  | { state: 'CACHE_CREATED'; ok: true; tag: string; path: string; width: number; height: number; bytes: number; source: AssetCacheSource; record: BackgroundCacheRecord }
  | { state: 'CACHE_MISS'; ok: false; tag: string; path: string; reason: string }
  | { state: 'CACHE_INVALID'; ok: false; tag: string; path: string; reason: string }
  | { state: 'CACHE_WRITE_FAILED'; ok: false; tag: string; path: string; reason: string };

// ---------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------

/** Maximum safe length for a tag-derived filename stem. */
export const MAX_TAG_STEM_LENGTH = 120;

/**
 * Convert a background tag into a SAFE deterministic filename stem.
 * Only `[A-Za-z0-9-]` survive; `@`/`#` prefixes are stripped; all path separators and
 * dots are removed so traversal is impossible. Returns null when nothing usable remains.
 */
export function safeTagStem(tag: unknown): string | null {
  const raw = typeof tag === 'string' ? tag.trim() : '';
  if (!raw) return null;
  // Strip a single leading marker character (@ or #) used by the tag convention.
  const trimmed = raw.replace(/^[@#]\s*/, '');
  // Drop a trailing file extension (e.g. `...ARJUN.webp`) so an explicit extension is a
  // request, not part of the name stem. Everything after the last dot is discarded here.
  const withoutExt = trimmed.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  const scrubbed = withoutExt
    .replace(/[/\\]/g, '-')       // separators become hyphens, never directory jumps
    .replace(/[:*?"<>|]/g, '')    // Windows-reserved characters removed
    .replace(/\.+/g, '-')         // dots removed (blocks ".." and extensions)
    .replace(/[^A-Za-z0-9_-]/g, '-') // anything else collapsed
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!scrubbed) return null;
  const stem = scrubbed.slice(0, MAX_TAG_STEM_LENGTH).replace(/^-+|-+$/g, '');
  if (!stem) return null;
  if (stem === '.' || stem === '..') return null;
  return stem;
}

/** Deterministic filename for a background tag, e.g. `BGD-01-VILLAGE-STREET-WIDE.png`. */
export function backgroundFilename(tag: unknown): string | null {
  const stem = safeTagStem(tag);
  return stem ? `${stem}.png` : null;
}

/**
 * Deterministic ABSOLUTE path for a background inside a caller-provided root.
 * Never uses the caller's tag as directory structure. Throws when the tag is unsafe.
 */
export function backgroundAssetPath(tag: unknown, backgroundsDir: string): string {
  const dir = String(backgroundsDir ?? '').trim();
  if (!dir) throw new Error('backgroundAssetPath requires a backgrounds directory.');
  const filename = backgroundFilename(tag);
  if (!filename) throw new Error(`Unsafe/empty background tag: ${JSON.stringify(tag)}.`);
  const root = path.resolve(dir);
  const resolved = path.resolve(root, filename);
  // Defence in depth: the resolved path must remain a direct child of the root.
  if (path.dirname(resolved) !== root) throw new Error(`Refusing to resolve a background path outside ${root}: ${resolved}.`);
  return resolved;
}

/** Decode a PNG buffer's IHDR dimensions. Pure; no filesystem or network access. */
export function readPngDimensions(buffer: unknown): { ok: true; width: number; height: number } | { ok: false; reason: string } {
  const buf = Buffer.isBuffer(buffer) ? buffer : null;
  if (!buf || buf.length === 0) return { ok: false, reason: 'The PNG file is empty.' };
  if (buf.length < 24) return { ok: false, reason: 'The PNG is too small to be valid.' };
  if (buf.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) return { ok: false, reason: 'The file is not a PNG (bad signature).' };
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    return { ok: false, reason: `The PNG exposes invalid dimensions (${width}x${height}).` };
  }
  return { ok: true, width, height };
}

/** True when width/height are within tolerance of 16:9 (accepts 1376x768). */
export function isAspectCompatible(width: unknown, height: unknown, tolerance = ASPECT_TOLERANCE): boolean {
  const w = Number(width), h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false;
  return Math.abs(w / h - 16 / 9) <= tolerance;
}

/** True when the resolution is at least the renderer's minimum. */
export function meetsMinimumResolution(width: unknown, height: unknown): boolean {
  const w = Number(width), h = Number(height);
  return Number.isFinite(w) && Number.isFinite(h) && w >= MIN_BACKGROUND_WIDTH && h >= MIN_BACKGROUND_HEIGHT;
}

/** Validate a cache record's shape/values. Pure. */
export function validateCacheRecord(record: unknown): { ok: true } | { ok: false; reason: string } {
  if (!record || typeof record !== 'object') return { ok: false, reason: 'Cache record is missing or not an object.' };
  const r = record as Partial<BackgroundCacheRecord>;
  if (typeof r.tag !== 'string' || !r.tag.trim()) return { ok: false, reason: 'Cache record is missing a tag.' };
  if (typeof r.path !== 'string' || !r.path.trim()) return { ok: false, reason: 'Cache record is missing a path.' };
  if (!Number.isInteger(r.width) || (r.width as number) <= 0) return { ok: false, reason: 'Cache record has an invalid width.' };
  if (!Number.isInteger(r.height) || (r.height as number) <= 0) return { ok: false, reason: 'Cache record has an invalid height.' };
  if (!Number.isFinite(r.bytes) || (r.bytes as number) <= 0) return { ok: false, reason: 'Cache record has an invalid byte size.' };
  if (r.format !== 'png') return { ok: false, reason: 'Cache record format must be "png".' };
  if (r.source !== 'flow-intrinsic') return { ok: false, reason: 'Cache record source must be "flow-intrinsic".' };
  if (r.validated !== true) return { ok: false, reason: 'Cache record is not marked validated.' };
  if (typeof r.createdAt !== 'string' || !r.createdAt.trim()) return { ok: false, reason: 'Cache record is missing createdAt.' };
  // Never persist secrets/volatile URLs, even accidentally.
  if (/https?:\/\/|flow-content\.google|\/asb\//i.test(r.path)) return { ok: false, reason: 'Cache record path must be a local path (no URLs/CDN).' };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------
// Filesystem-backed cache (validation + atomic write)
// ---------------------------------------------------------------------------------------

export interface AssetCacheOptions {
  /** Directory holding cached background PNGs (e.g. production/assets/backgrounds). */
  backgroundsDir: string;
}

function metaPathFor(pngPath: string): string {
  return pngPath.replace(/\.png$/i, '.json');
}

/** Validate an on-disk PNG as a reusable background. Never mutates the file. */
async function validateCachedFile(filePath: string): Promise<{ ok: true; width: number; height: number; bytes: number } | { ok: false; reason: string }> {
  let stat;
  try { stat = await fsp.stat(filePath); } catch { return { ok: false, reason: `Background asset does not exist: ${filePath}.` }; }
  if (!stat.isFile()) return { ok: false, reason: `Background asset is not a regular file: ${filePath}.` };
  if (stat.size <= 0) return { ok: false, reason: `Background asset is empty (0 bytes): ${filePath}.` };
  let buffer: Buffer;
  try { buffer = await fsp.readFile(filePath); } catch (e: any) { return { ok: false, reason: `Background asset could not be read: ${String(e?.message ?? e)}` }; }
  const dims = readPngDimensions(buffer);
  if (!dims.ok) return { ok: false, reason: dims.reason };
  if (!meetsMinimumResolution(dims.width, dims.height)) {
    return { ok: false, reason: `Background resolution ${dims.width}x${dims.height} is below the required minimum ${MIN_BACKGROUND_WIDTH}x${MIN_BACKGROUND_HEIGHT}.` };
  }
  if (!isAspectCompatible(dims.width, dims.height)) {
    return { ok: false, reason: `Background aspect ${dims.width}x${dims.height} is not 16:9-compatible.` };
  }
  return { ok: true, width: dims.width, height: dims.height, bytes: buffer.length };
}

async function readRecord(metaPath: string): Promise<BackgroundCacheRecord | undefined> {
  try {
    const raw = await fsp.readFile(metaPath, 'utf8');
    const parsed = JSON.parse(raw);
    return validateCacheRecord(parsed).ok ? (parsed as BackgroundCacheRecord) : undefined;
  } catch { return undefined; }
}

/**
 * Look up a cached background by tag.
 * A CACHE_HIT requires the file to EXIST **and** pass full validation. A corrupt/oversized-
 * beyond-minimum/short file reports CACHE_INVALID and is NOT overwritten here.
 */
export async function getCachedBackground(tag: unknown, options: AssetCacheOptions): Promise<BackgroundCacheResult> {
  const dir = String(options?.backgroundsDir ?? '').trim();
  let filePath: string;
  try { filePath = backgroundAssetPath(tag, dir); }
  catch (e: any) { return { state: 'CACHE_INVALID', ok: false, tag: String(tag ?? ''), path: '', reason: String(e?.message ?? e) }; }
  let stat;
  try { stat = await fsp.stat(filePath); } catch { return { state: 'CACHE_MISS', ok: false, tag: String(tag ?? ''), path: filePath, reason: 'No cached background exists for this tag.' }; }
  if (!stat.isFile()) return { state: 'CACHE_MISS', ok: false, tag: String(tag ?? ''), path: filePath, reason: 'Cached path is not a regular file.' };
  const valid = await validateCachedFile(filePath);
  if (!valid.ok) return { state: 'CACHE_INVALID', ok: false, tag: String(tag ?? ''), path: filePath, reason: valid.reason };
  const record = await readRecord(metaPathFor(filePath));
  return { state: 'CACHE_HIT', ok: true, tag: String(tag ?? ''), path: filePath, width: valid.width, height: valid.height, bytes: valid.bytes, source: 'flow-intrinsic', record };
}

/**
 * Atomically store a background PNG.
 *
 * Writes to a temporary sibling file, validates the temporary file, then renames it into
 * place. A valid existing cache is NEVER replaced by a partial file: if validation fails the
 * temporary file is removed and the previous asset is left untouched.
 *
 * `overwriteExisting === false` returns an early CACHE_HIT when a valid asset already exists.
 */
export async function putCachedBackground(
  tag: unknown,
  png: Buffer | Uint8Array | string,
  options: AssetCacheOptions & { overwriteExisting?: boolean } = { backgroundsDir: '' },
): Promise<BackgroundCacheResult> {
  const dir = String(options?.backgroundsDir ?? '').trim();
  let filePath: string;
  try { filePath = backgroundAssetPath(tag, dir); }
  catch (e: any) { return { state: 'CACHE_WRITE_FAILED', ok: false, tag: String(tag ?? ''), path: '', reason: String(e?.message ?? e) }; }
  const tagStr = String(tag ?? '');

  // Existing valid cache is preserved unless the caller explicitly overwrites.
  const existing = await getCachedBackground(tag, { backgroundsDir: dir });
  if (existing.state === 'CACHE_HIT' && options.overwriteExisting !== true) return existing;

  const buffer = Buffer.isBuffer(png) ? png : png instanceof Uint8Array ? Buffer.from(png) : typeof png === 'string' ? Buffer.from(png, 'base64') : Buffer.alloc(0);
  const dims = readPngDimensions(buffer);
  if (!dims.ok) return { state: 'CACHE_WRITE_FAILED', ok: false, tag: tagStr, path: filePath, reason: `Refusing to cache an invalid PNG: ${dims.reason}` };

  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(tmpPath, buffer);
    const valid = await validateCachedFile(tmpPath);
    if (!valid.ok) {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      return { state: 'CACHE_WRITE_FAILED', ok: false, tag: tagStr, path: filePath, reason: `Temporary cache file failed validation: ${valid.reason}` };
    }
    await fsp.rename(tmpPath, filePath);
    const record: BackgroundCacheRecord = {
      tag: tagStr, path: filePath, width: valid.width, height: valid.height, bytes: valid.bytes,
      format: 'png', source: 'flow-intrinsic', validated: true, createdAt: new Date().toISOString(),
    };
    try { await fsp.writeFile(metaPathFor(filePath), JSON.stringify(record, null, 2)); } catch { /* metadata is best-effort; asset itself is valid */ }
    return { state: 'CACHE_CREATED', ok: true, tag: tagStr, path: filePath, width: valid.width, height: valid.height, bytes: valid.bytes, source: 'flow-intrinsic', record };
  } catch (e: any) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    return { state: 'CACHE_WRITE_FAILED', ok: false, tag: tagStr, path: filePath, reason: `Atomic cache write failed: ${String(e?.message ?? e)}` };
  }
}
