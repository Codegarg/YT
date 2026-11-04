/**
 * Local character asset contract (STEP-8CY).
 *
 * 8CX conclusively proved the existing Flow character visual is NOT obtainable as a clean
 * local compositing asset under legitimate browser-only access (cross-origin tainted canvas,
 * model-sheet screenshot only, no download control). This module therefore defines a
 * SOURCE-AGNOSTIC, browser-independent local contract for character cutouts so a future
 * compositor can consume them — and so the renderer can FAIL CLOSED when a scene needs a
 * character that is not locally available.
 *
 * This module deliberately does NOT:
 *   · extract characters from Flow (8CX: blocked)
 *   · write, generate, or synthesise any asset
 *   · remove backgrounds / run segmentation / invent alpha
 *   · touch pipeline.json
 *
 * Pure helpers (tag → filename → path, PNG/WebP parsing) are isolated from filesystem I/O
 * so path safety, format validation and alpha detection are unit-testable offline.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { safeTagStem } from './assetCache.js';

/** Minimum usable character resolution (a cutout must survive 1920x1080 compositing). */
export const MIN_CHARACTER_WIDTH = 1024;
export const MIN_CHARACTER_HEIGHT = 1024;

/** Aspect tolerance around square; rejects clearly non-cutout shapes (e.g. banners). */
export const CHARACTER_ASPECT_RATIO = 1;
export const CHARACTER_ASPECT_TOLERANCE = 0.6;

/** Supported local character formats. JPEG is intentionally NOT supported (no alpha). */
export const SUPPORTED_CHARACTER_EXTENSIONS = ['.png', '.webp'] as const;
export type CharacterFormat = 'png' | 'webp';

/** Where a local character asset came from. `future-flow-export` is declared but NOT implemented. */
export const CHARACTER_ASSET_SOURCES = ['human-supplied', 'future-flow-export'] as const;
export type CharacterAssetSource = (typeof CHARACTER_ASSET_SOURCES)[number];

const PNG_SIGNATURE = '89504e470d0a1a0a';

/** Explicit character asset states. Never silently substitute a character or a background. */
export type CharacterAssetState =
  | 'CHARACTER_ASSET_HIT'
  | 'CHARACTER_ASSET_MISSING'
  | 'CHARACTER_ASSET_INVALID'
  | 'CHARACTER_ASSET_NO_ALPHA'
  | 'CHARACTER_ASSET_UNSUPPORTED';

export interface CharacterAssetRecord {
  characterTag: string;
  filePath: string;
  format: CharacterFormat;
  width: number;
  height: number;
  hasAlpha: boolean;
  source: CharacterAssetSource;
  validated: true;
}

export type CharacterAssetResult =
  | { state: 'CHARACTER_ASSET_HIT'; ok: true; characterTag: string; filePath: string; record: CharacterAssetRecord }
  | { state: Exclude<CharacterAssetState, 'CHARACTER_ASSET_HIT'>; ok: false; characterTag: string; filePath: string; reason: string };

export interface CharacterAssetOptions {
  /** Directory holding local character cutouts (e.g. production/assets/characters). */
  charactersDir: string;
  /** Provenance to record on a hit. Defaults to 'human-supplied'. */
  source?: CharacterAssetSource;
}

// ---------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------

/** Deterministic filename for a character tag, e.g. `CHAR-01-ARJUN.png`. */
export function characterFilename(tag: unknown, extension: '.png' | '.webp' = '.png'): string | null {
  const stem = safeTagStem(tag);
  if (!stem) return null;
  if (extension !== '.png' && extension !== '.webp') return null;
  return `${stem}${extension}`;
}

/**
 * Extensions a caller may write on a character TAG itself (e.g. `@CHAR-01-ARJUN.webp`).
 * Anything else is an explicitly unsupported request, not a silent `.png` fallback.
 */
export const TAG_EXTENSION_PATTERN = /\.([A-Za-z0-9]+)$/;

/** Extension requested on the tag itself, or null when the tag carries none. */
export function requestedTagExtension(tag: unknown): string | null {
  const m = TAG_EXTENSION_PATTERN.exec(String(tag ?? '').trim());
  return m ? `.${m[1].toLowerCase()}` : null;
}

/**
 * Deterministic ABSOLUTE path for a character tag inside a caller-provided root.
 * The tag is never used as directory structure; the resolved path must be a direct child.
 * Throws only for configuration errors (missing dir / unsafe tag).
 */
export function characterAssetPath(tag: unknown, charactersDir: string): string {
  const dir = String(charactersDir ?? '').trim();
  if (!dir) throw new Error('characterAssetPath requires a characters directory.');
  const filename = characterFilename(tag);
  if (!filename) throw new Error(`Unsafe/empty character tag: ${JSON.stringify(tag)}.`);
  const root = path.resolve(dir);
  const resolved = path.resolve(root, filename);
  if (path.dirname(resolved) !== root) throw new Error(`Refusing to resolve a character path outside ${root}: ${resolved}.`);
  return resolved;
}

/** File extension (lowercased) of a path, or ''. */
export function extensionOf(p: unknown): string {
  const s = String(p ?? '');
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i).toLowerCase() : '';
}

/**
 * Decode PNG IDAT pixel data (Node built-ins only) and determine whether the image has at
 * least one genuinely transparent pixel. Handles the five PNG scanline filters.
 *
 * Returns:
 *   { ok: true, transparent: boolean }  — decoded successfully
 *   { ok: false, reason }               — the pixel payload could not be decoded
 *
 * Colour types: 0=grey, 2=RGB, 3=palette, 4=grey+alpha, 6=RGBA.
 * A DEFLATE ('zlib') stream is expected; `zlib.inflateSync` is used.
 */
function pngHasTransparentPixel(buf: Buffer, width: number, height: number, colourType: number, bitDepth: number): { ok: true; transparent: boolean } | { ok: false; reason: string } {
  // Only 8-bit depth is inspected at pixel level; anything else cannot be judged safely.
  if (bitDepth !== 8) return { ok: false, reason: `Unsupported PNG bit depth ${bitDepth} for pixel-level alpha inspection.` };
  const channels = colourType === 4 ? 2 : colourType === 6 ? 4 : colourType === 0 ? 1 : colourType === 2 ? 3 : 0;
  if (channels === 0) return { ok: false, reason: `PNG colour type ${colourType} cannot be decoded for alpha inspection.` };
  const alphaIndex = colourType === 4 ? 1 : colourType === 6 ? 3 : -1; // palette has alpha in PLTE/tRNS (not handled here)

  // Concatenate IDAT chunks.
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    if (dataStart + len > buf.length) break;
    if (type === 'IDAT') idat.push(buf.subarray(dataStart, dataStart + len));
    if (type === 'IEND') break;
    offset = dataStart + len + 4; // skip CRC
  }
  if (idat.length === 0) return { ok: false, reason: 'The PNG has no IDAT pixel data.' };

  let raw: Buffer;
  try { raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: 256 * 1024 * 1024 }); }
  catch (e: any) { return { ok: false, reason: `The PNG pixel data could not be inflated: ${String(e?.message ?? e)}` }; }

  const bpp = channels;                 // bytes per pixel (8-bit)
  const stride = width * bpp;           // bytes per scanline (no filter byte)
  const expected = height * (stride + 1);
  if (raw.length < expected) return { ok: false, reason: `The PNG pixel data is truncated (${raw.length} < ${expected}).` };

  // Unfilter scanlines in place; track whether any alpha byte < 255.
  let transparent = false;
  let prev = Buffer.alloc(stride);
  let cur = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const lineStart = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const rawByte = raw[lineStart + i];
      const a = i >= bpp ? cur[i - bpp] : 0;       // left
      const b = prev[i];                            // up
      const c = i >= bpp ? prev[i - bpp] : 0;       // up-left
      let val: number;
      switch (filter) {
        case 0: val = rawByte; break;
        case 1: val = rawByte + a; break;
        case 2: val = rawByte + b; break;
        case 3: val = rawByte + ((a + b) >> 1); break;
        case 4: { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); val = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: return { ok: false, reason: `The PNG uses an unknown scanline filter (${filter}) on row ${y}.` };
      }
      cur[i] = val & 0xff;
    }
    if (alphaIndex >= 0 && !transparent) {
      for (let x = 0; x < width; x++) { if (cur[x * bpp + alphaIndex] < 255) { transparent = true; break; } }
    }
    const swap = prev; prev = cur; cur = swap;
  }
  return { ok: true, transparent };
}

/**
 * Parse a PNG: signature, IHDR dimensions, AND real pixel-level alpha.
 *
 * `hasAlpha` is true ONLY when at least one decoded pixel has alpha < 255. A colour type that
 * merely *supports* alpha (4 or 6) is NOT sufficient — an entirely opaque RGBA image has no
 * usable alpha channel for a cutout. If the alpha channel exists but the pixel payload cannot
 * be decoded, this fails closed.
 */
export function parsePng(buffer: unknown): { ok: true; width: number; height: number; hasAlpha: boolean } | { ok: false; reason: string } {
  const buf = Buffer.isBuffer(buffer) ? buffer : null;
  if (!buf || buf.length === 0) return { ok: false, reason: 'The PNG file is empty.' };
  if (buf.length < 26) return { ok: false, reason: 'The PNG is too small to be valid.' };
  if (buf.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) return { ok: false, reason: 'The file is not a PNG (bad signature).' };
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return { ok: false, reason: 'The PNG is malformed (missing IHDR).' };
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    return { ok: false, reason: `The PNG exposes invalid dimensions (${width}x${height}).` };
  }
  // IHDR colour type: 4 = grey+alpha, 6 = truecolour+alpha. 0/2/3 carry no direct alpha.
  const colourType = buf[25];
  const bitDepth = buf[24];
  const declaresAlpha = colourType === 4 || colourType === 6;

  if (!declaresAlpha) {
    // No alpha channel is even declared — the image cannot be a cutout.
    return { ok: true, width, height, hasAlpha: false };
  }

  // The alpha channel exists; VERIFY pixels rather than trusting the container.
  const probe = pngHasTransparentPixel(buf, width, height, colourType, bitDepth);
  if (!probe.ok) return { ok: false, reason: probe.reason };
  return { ok: true, width, height, hasAlpha: probe.transparent };
}

/**
 * Parse a WebP: RIFF/WEBP container plus VP8X / VP8L / VP8 dimensions where reliably parseable.
 * Alpha is reported only when the container states it (VP8X ALPHA flag, or VP8L alpha bit).
 */
export function parseWebp(buffer: unknown): { ok: true; width: number; height: number; hasAlpha: boolean } | { ok: false; reason: string } {
  const buf = Buffer.isBuffer(buffer) ? buffer : null;
  if (!buf || buf.length < 30) return { ok: false, reason: 'The WebP file is too small to be valid.' };
  if (buf.subarray(0, 4).toString('ascii') !== 'RIFF') return { ok: false, reason: 'The file is not a WebP (missing RIFF).' };
  if (buf.subarray(8, 12).toString('ascii') !== 'WEBP') return { ok: false, reason: 'The file is not a WebP (missing WEBP).' };
  const fourcc = buf.subarray(12, 16).toString('ascii');
  if (fourcc === 'VP8X') {
    const flags = buf[20];
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    if (width <= 0 || height <= 0) return { ok: false, reason: `The WebP exposes invalid dimensions (${width}x${height}).` };
    const flagsAlpha = (flags & 0x10) !== 0;
    // VP8X's ALPHA flag is a CONTAINER hint: it can be set while every pixel is still opaque
    // (the same class of defect as an opaque RGBA PNG). We have no WebP pixel decoder and must
    // not add a dependency or invent alpha, so an extended-format WebP fails CLOSED: the
    // presence of the flag is NOT accepted as proof of a transparent cutout.
    if (flagsAlpha) return { ok: false, reason: 'The WebP (VP8X) declares an alpha flag, but pixel-level alpha cannot be verified without a WebP decoder; refusing to treat it as a verified cutout.' };
    return { ok: true, width, height, hasAlpha: false };
  }
  if (fourcc === 'VP8L') {
    if (buf.length < 25) return { ok: false, reason: 'The WebP (VP8L) is truncated.' };
    const bits = buf.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    // VP8L's alpha bit is a genuine per-image encoder signal (lossless images without alpha use
    // a different encoding), so it is trustworthy in a way the VP8X container flag is not.
    const hasAlpha = ((bits >> 28) & 1) === 1;
    if (width <= 0 || height <= 0) return { ok: false, reason: `The WebP exposes invalid dimensions (${width}x${height}).` };
    return { ok: true, width, height, hasAlpha };
  }
  if (fourcc === 'VP8 ') {
    if (buf.length < 30) return { ok: false, reason: 'The WebP (VP8) is truncated.' };
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    if (width <= 0 || height <= 0) return { ok: false, reason: `The WebP exposes invalid dimensions (${width}x${height}).` };
    // Lossy VP8 has no alpha channel by definition.
    return { ok: true, width, height, hasAlpha: false };
  }
  return { ok: false, reason: `Unsupported WebP variant "${fourcc}".` };
}

/** True when width/height are within the character aspect tolerance (square-ish). */
export function isCharacterAspectAcceptable(width: unknown, height: unknown): boolean {
  const w = Number(width), h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false;
  return Math.abs(w / h - CHARACTER_ASPECT_RATIO) <= CHARACTER_ASPECT_TOLERANCE;
}

/** True when the resolution is at least the character minimum. */
export function meetsCharacterMinimum(width: unknown, height: unknown): boolean {
  const w = Number(width), h = Number(height);
  return Number.isFinite(w) && Number.isFinite(h) && w >= MIN_CHARACTER_WIDTH && h >= MIN_CHARACTER_HEIGHT;
}

// ---------------------------------------------------------------------------------------
// Resolution API
// ---------------------------------------------------------------------------------------

/**
 * Resolve a local character asset. Never throws for ordinary missing/invalid assets —
 * it returns an explicit, stable failure state. Throws only for configuration errors.
 */
export async function getCharacterAsset(characterTag: unknown, options: CharacterAssetOptions): Promise<CharacterAssetResult> {
  const tag = String(characterTag ?? '');
  const dir = String(options?.charactersDir ?? '').trim();
  if (!dir) throw new Error('getCharacterAsset requires options.charactersDir.');
  const source: CharacterAssetSource = options?.source ?? 'human-supplied';

  let filePath: string;
  try { filePath = characterAssetPath(characterTag, dir); }
  catch (e: any) { return { state: 'CHARACTER_ASSET_INVALID', ok: false, characterTag: tag, filePath: '', reason: String(e?.message ?? e) }; }

  // Honour an explicit supported extension on the tag; reject any other explicitly.
  const tagExt = requestedTagExtension(tag);
  if (tagExt && !SUPPORTED_CHARACTER_EXTENSIONS.includes(tagExt as any)) {
    return { state: 'CHARACTER_ASSET_UNSUPPORTED', ok: false, characterTag: tag, filePath, reason: `Unsupported character asset extension "${tagExt}" (expected ${SUPPORTED_CHARACTER_EXTENSIONS.join(', ')}).` };
  }
  if (tagExt === '.webp') filePath = filePath.replace(/\.png$/i, '.webp');

  const ext = extensionOf(filePath);
  if (!SUPPORTED_CHARACTER_EXTENSIONS.includes(ext as any)) {
    return { state: 'CHARACTER_ASSET_UNSUPPORTED', ok: false, characterTag: tag, filePath, reason: `Unsupported character asset extension "${ext}" (expected ${SUPPORTED_CHARACTER_EXTENSIONS.join(', ')}).` };
  }

  let stat;
  try { stat = await fsp.stat(filePath); } catch { return { state: 'CHARACTER_ASSET_MISSING', ok: false, characterTag: tag, filePath, reason: 'No local character asset exists for this tag.' }; }
  if (!stat.isFile()) return { state: 'CHARACTER_ASSET_MISSING', ok: false, characterTag: tag, filePath, reason: 'Character asset path is not a regular file.' };
  if (stat.size <= 0) return { state: 'CHARACTER_ASSET_INVALID', ok: false, characterTag: tag, filePath, reason: 'Character asset is empty (0 bytes).' };

  let buffer: Buffer;
  try { buffer = await fsp.readFile(filePath); } catch (e: any) { return { state: 'CHARACTER_ASSET_INVALID', ok: false, characterTag: tag, filePath, reason: `Character asset could not be read: ${String(e?.message ?? e)}` }; }

  const parsed = ext === '.png' ? parsePng(buffer) : parseWebp(buffer);
  if (!parsed.ok) return { state: 'CHARACTER_ASSET_INVALID', ok: false, characterTag: tag, filePath, reason: parsed.reason };
  if (!meetsCharacterMinimum(parsed.width, parsed.height)) {
    return { state: 'CHARACTER_ASSET_INVALID', ok: false, characterTag: tag, filePath, reason: `Character resolution ${parsed.width}x${parsed.height} is below the required minimum ${MIN_CHARACTER_WIDTH}x${MIN_CHARACTER_HEIGHT}.` };
  }
  if (!isCharacterAspectAcceptable(parsed.width, parsed.height)) {
    return { state: 'CHARACTER_ASSET_INVALID', ok: false, characterTag: tag, filePath, reason: `Character aspect ${parsed.width}x${parsed.height} is not usable for a cutout.` };
  }
  if (!parsed.hasAlpha) {
    // Opaque images are NOT accepted as cutouts. No background removal is attempted.
    return { state: 'CHARACTER_ASSET_NO_ALPHA', ok: false, characterTag: tag, filePath, reason: `Character asset ${parsed.width}x${parsed.height} has no usable alpha channel; an opaque image is not a transparent cutout.` };
  }

  return {
    state: 'CHARACTER_ASSET_HIT', ok: true, characterTag: tag, filePath,
    record: {
      characterTag: tag, filePath, format: ext === '.png' ? 'png' : 'webp',
      width: parsed.width, height: parsed.height, hasAlpha: true, source, validated: true,
    },
  };
}

/** Resolve several character tags. Never throws for ordinary missing/invalid assets. */
export async function getCharacterAssets(tags: readonly unknown[], options: CharacterAssetOptions): Promise<CharacterAssetResult[]> {
  const out: CharacterAssetResult[] = [];
  for (const t of tags) out.push(await getCharacterAsset(t, options));
  return out;
}
