/**
 * Intrinsic image-element extraction helpers (STEP-8CP).
 *
 * Live STEP-8CO proved an ALREADY-LOADED Flow `<img>` can be rendered at its intrinsic
 * resolution with an in-page canvas (`drawImage` + `toDataURL('image/png')`) WITHOUT any
 * network access (no fetch/XHR/CDP/CDN). This module holds the PURE, browser-free logic
 * (validation + data-URL decoding) so it can be tested offline; the DOM/canvas work lives
 * in FlowClient.extractImageElementIntrinsicPng().
 *
 * Nothing here performs network I/O: it only consumes pixels already loaded in the DOM.
 */

export interface ImageIntrinsicMetrics {
  complete?: unknown;
  naturalWidth?: unknown;
  naturalHeight?: unknown;
}

export type IntrinsicValidation = { ok: true; width: number; height: number } | { ok: false; reason: string };

/**
 * Validate that an image element is loaded and has usable intrinsic dimensions.
 * Fail-closed for: not complete, non-numeric/zero/negative dimensions.
 */
export function validateIntrinsicImage(metrics: ImageIntrinsicMetrics | undefined | null): IntrinsicValidation {
  if (!metrics || typeof metrics !== 'object') return { ok: false, reason: 'Image metrics were unavailable.' };
  if (metrics.complete !== true) return { ok: false, reason: 'Image element is not fully loaded (img.complete !== true).' };
  const w = typeof metrics.naturalWidth === 'number' && Number.isFinite(metrics.naturalWidth) ? Math.trunc(metrics.naturalWidth) : NaN;
  const h = typeof metrics.naturalHeight === 'number' && Number.isFinite(metrics.naturalHeight) ? Math.trunc(metrics.naturalHeight) : NaN;
  if (!Number.isInteger(w) || w <= 0) return { ok: false, reason: `Image has no usable intrinsic width (naturalWidth=${String(metrics.naturalWidth)}).` };
  if (!Number.isInteger(h) || h <= 0) return { ok: false, reason: `Image has no usable intrinsic height (naturalHeight=${String(metrics.naturalHeight)}).` };
  return { ok: true, width: w, height: h };
}

export type PngDecode = { ok: true; buffer: Buffer; width: number; height: number } | { ok: false; reason: string };

const PNG_SIGNATURE = '89504e470d0a1a0a';

/**
 * Decode a `data:image/png;base64,…` URL into a PNG Buffer and validate the container
 * signature + IHDR dimensions. Fail-closed for: wrong mime, empty/malformed base64, a
 * non-PNG payload, or dimensions that do not match the bytes.
 *
 * Pure and browser-free (Node Buffer only).
 */
export function decodePngDataUrl(dataUrl: unknown): PngDecode {
  const raw = typeof dataUrl === 'string' ? dataUrl.trim() : '';
  if (!raw) return { ok: false, reason: 'No image data was returned.' };
  const m = raw.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return { ok: false, reason: 'The returned data URL is not a base64 PNG (unexpected mime or encoding).' };
  let buffer: Buffer;
  try { buffer = Buffer.from(m[1], 'base64'); } catch { return { ok: false, reason: 'The PNG base64 payload could not be decoded.' }; }
  if (buffer.length < 24) return { ok: false, reason: 'The decoded PNG is too small to be valid.' };
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== PNG_SIGNATURE) return { ok: false, reason: 'The decoded payload is not a PNG (bad signature).' };
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    return { ok: false, reason: `The PNG exposes invalid dimensions (${width}x${height}).` };
  }
  return { ok: true, buffer, width, height };
}

/**
 * Decode a PNG data URL and write it to a caller-provided path. Returns the written
 * dimensions + byte size. Fail-closed: never writes a corrupt/empty asset.
 */
export async function writePngDataUrl(dataUrl: unknown, outputPath: string): Promise<{ path: string; width: number; height: number; bytes: number }> {
  const dest = String(outputPath ?? '').trim();
  if (!dest) throw new Error('writePngDataUrl requires an output path.');
  const decoded = decodePngDataUrl(dataUrl);
  if (!decoded.ok) throw new Error(`Refusing to write image: ${decoded.reason}`);
  const fs = await import('node:fs/promises');
  await fs.writeFile(dest, decoded.buffer);
  return { path: dest, width: decoded.width, height: decoded.height, bytes: decoded.buffer.length };
}
