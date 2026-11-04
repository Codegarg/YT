// Offline character-asset contract tests (STEP-8CY). Temp dirs only; no Flow/Chrome/network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const ca = await import(pathToFileURL(`${SRC}/characterAsset.ts`).href);
const {
  characterFilename, characterAssetPath, getCharacterAsset, getCharacterAssets, parsePng, parseWebp,
  extensionOf, isCharacterAspectAcceptable, meetsCharacterMinimum,
  MIN_CHARACTER_WIDTH, MIN_CHARACTER_HEIGHT, SUPPORTED_CHARACTER_EXTENSIONS,
} = ca;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

// ---- deterministic PNG builder with selectable colour type (alpha) ----
function makePng(width: number, height: number, colourType = 6): Buffer {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const t = Buffer.from(type, 'ascii'); const body = Buffer.concat([t, data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([len, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = colourType;
  const channels = colourType === 6 ? 4 : colourType === 4 ? 2 : colourType === 2 ? 3 : 1;
  const raw = Buffer.alloc(height * (1 + width * channels), colourType === 4 || colourType === 6 ? 0x80 : 0x40);
  // Non-alpha colour types carry no alpha channel; alpha-capable types get 0x80 (<255) so the
  // pixel-level decoder reports genuine transparency. Filter bytes must be 0 (None).
  for (let y = 0; y < height; y++) raw[y * (1 + width * channels)] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// Minimal deterministic VP8X WebP (alpha flag set/unset)
function makeWebpVp8x(width: number, height: number, hasAlpha: boolean): Buffer {
  const w = width - 1, h = height - 1;
  const vp8x = Buffer.alloc(18);
  vp8x.write('VP8X', 0, 'ascii'); vp8x.writeUInt32LE(10, 4);
  vp8x[8] = hasAlpha ? 0x10 : 0x00;
  vp8x[12] = w & 0xff; vp8x[13] = (w >> 8) & 0xff; vp8x[14] = (w >> 16) & 0xff;
  vp8x[15] = h & 0xff; vp8x[16] = (h >> 8) & 0xff; vp8x[17] = (h >> 16) & 0xff;
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), vp8x, Buffer.alloc(8)]);
  const riff = Buffer.alloc(8); riff.write('RIFF', 0, 'ascii'); riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8cy-'));
const dir = path.join(tmp, 'characters');
fs.mkdirSync(dir, { recursive: true });
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const write = (tag: string, buf: Buffer, ext = '.png') => { const p = characterAssetPath(tag, dir); fs.writeFileSync(p.replace(/\.png$/, ext), buf); return p.replace(/\.png$/, ext); };

// ---- 1. safe filename mapping (all four existing character tags) ----
check('filename: @CHAR-01-ARJUN', characterFilename('@CHAR-01-ARJUN') === 'CHAR-01-ARJUN.png');
check('filename: @CHAR-02-MOHAN', characterFilename('@CHAR-02-MOHAN') === 'CHAR-02-MOHAN.png');
check('filename: @CHAR-03-GEETA', characterFilename('@CHAR-03-GEETA') === 'CHAR-03-GEETA.png');
check('filename: @CHAR-04-BUZURG', characterFilename('@CHAR-04-BUZURG') === 'CHAR-04-BUZURG.png');
check('filename: webp extension honored', characterFilename('@CHAR-01-ARJUN', '.webp') === 'CHAR-01-ARJUN.webp');
check('filename: unsupported ext rejected', characterFilename('@CHAR-01-ARJUN', '.jpg' as any) === null);
check('filename: empty/whitespace rejected', characterFilename('') === null && characterFilename('   ') === null);

// ---- 13. different tags do not collide ----
check('distinct tags -> distinct filenames', new Set(['@CHAR-01-ARJUN', '@CHAR-02-MOHAN', '@CHAR-03-GEETA', '@CHAR-04-BUZURG'].map((t) => characterFilename(t))).size === 4);

// ---- 2/3/14. path traversal + absolute paths + hostile tags ----
const hostile = ['../../secret.png', '..\\..\\secret.png', 'C:\\secret.png', 'D:/secret.png', '@CHAR/evil', '@CHAR\\evil', '', '   ', '..', '.', '\0null', 'x'.repeat(400), '@CHAR-01-ARJUN/../evil'];
for (const h of hostile) {
  let escaped = false;
  try { const p = characterAssetPath(h, dir); escaped = path.dirname(p) !== path.resolve(dir) || !/\.png$/.test(p); }
  catch { escaped = false; }
  check(`traversal protection: ${JSON.stringify(h.slice(0, 30))}`, !escaped);
}
check('separators never survive into the stem', !/[/\\]/.test(characterFilename('#CHAR/evil\\x') ?? ''));
check('very long tag truncated safely', (() => { const f = characterFilename('x'.repeat(400)); return !!f && f.length <= 124; })());

// ---- 4. missing character ----
const missing = await getCharacterAsset('@CHAR-02-MOHAN', { charactersDir: dir });
check('missing character -> CHARACTER_ASSET_MISSING', missing.state === 'CHARACTER_ASSET_MISSING' && missing.ok === false, JSON.stringify(missing));

// ---- 8DW/8DX: PIXEL-LEVEL alpha verification (regression for the opaque-RGBA defect) ----
// Build a PNG with real IDAT data and an explicit alpha value for every pixel.
function makePngWithAlpha(width: number, height: number, colourType: 4 | 6, alpha: number, transparentPixelAt?: { x: number; y: number }): Buffer {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const t = Buffer.from(type, 'ascii'); const body = Buffer.concat([t, data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([len, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = colourType;
  const channels = colourType === 6 ? 4 : 2;
  const raw = Buffer.alloc(height * (1 + width * channels), 0x80);
  // Filter byte per scanline must be 0 (None); only pixel bytes are filled with the sample value.
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * channels);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const a = rowStart + 1 + x * channels + (channels - 1);
      raw[a] = 255;
    }
  }
  if (transparentPixelAt) { const off = transparentPixelAt.y * (1 + width * channels) + 1; raw[off + transparentPixelAt.x * channels + (channels - 1)] = alpha; }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
check('A. PNG colour type 6, ALL pixels alpha=255 -> NO_ALPHA', await (async () => { const b = makePngWithAlpha(1024, 1024, 6, 255); check('A0. decoder reports hasAlpha=false', parsePng(b).ok === true && parsePng(b).hasAlpha === false, JSON.stringify(parsePng(b))); fs.writeFileSync(path.join(dir, 'CHAR-20-RGBAOPAQUE.png'), b); return (await getCharacterAsset('@CHAR-20-RGBAOPAQUE', { charactersDir: dir })).state === 'CHARACTER_ASSET_NO_ALPHA'; })());
check('B. PNG colour type 6, ONE pixel alpha<255 -> HIT', await (async () => { const b = makePngWithAlpha(1024, 1024, 6, 0, { x: 500, y: 500 }); check('B0. decoder reports hasAlpha=true', parsePng(b).hasAlpha === true); fs.writeFileSync(path.join(dir, 'CHAR-21-RGBAALPHA.png'), b); return (await getCharacterAsset('@CHAR-21-RGBAALPHA', { charactersDir: dir })).state === 'CHARACTER_ASSET_HIT'; })());
check('C. PNG colour type 4, ALL pixels alpha=255 -> NO_ALPHA', await (async () => { const b = makePngWithAlpha(1024, 1024, 4, 255); check('C0. decoder reports hasAlpha=false', parsePng(b).hasAlpha === false); fs.writeFileSync(path.join(dir, 'CHAR-22-GREYOPAQUE.png'), b); return (await getCharacterAsset('@CHAR-22-GREYOPAQUE', { charactersDir: dir })).state === 'CHARACTER_ASSET_NO_ALPHA'; })());
check('D. PNG colour type 4, ONE pixel alpha<255 -> HIT', await (async () => { const b = makePngWithAlpha(1024, 1024, 4, 128, { x: 1, y: 1 }); check('D0. decoder reports hasAlpha=true', parsePng(b).hasAlpha === true); fs.writeFileSync(path.join(dir, 'CHAR-23-GREYALPHA.png'), b); return (await getCharacterAsset('@CHAR-23-GREYALPHA', { charactersDir: dir })).state === 'CHARACTER_ASSET_HIT'; })());
// unfiltered scanline correctness: a filter-1 (Sub) row must decode
check('D1. decoder handles non-zero PNG scanline filters', (() => {
  const width = 4, height = 1, channels = 4;
  const crcTable: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  // Build unfiltered row then apply Sub filter (raw = filtered - left) for the alpha byte.
  const base = Buffer.alloc(1 + width * channels, 0xff);
  base[0] = 1; // Sub
  for (let x = width - 1; x >= 1; x--) for (let ch = 0; ch < channels; ch++) { const i = 1 + x * channels + ch; base[i] = (base[i] - base[i - channels]) & 0xff; }
  const aIdx = 1 + 2 * channels + 3; base[aIdx] = (0 - 255) & 0xff; // pixel 2 alpha 0 after unfilter
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(base)), chunk('IEND', Buffer.alloc(0))]);
  const r = parsePng(png);
  return r.ok === true && r.hasAlpha === true;
})());
check('E. opaque RGB (colour type 2) still reports no alpha', parsePng(makePng(1024, 1024, 2)).hasAlpha === false);
check('F. invalid PNG signature still rejected', parsePng(Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('garbage-body-padding-here')])).ok === false || parsePng(Buffer.from('not a png at all, padded out')).ok === false);
check('G. dimension/aspect failures preserved', meetsCharacterMinimum(512, 512) === false && isCharacterAspectAcceptable(4096, 512) === false);
check('H. duplicate .png + .webp still detected', await (async () => { fs.writeFileSync(path.join(dir, 'CHAR-24-DUP.png'), makePngWithAlpha(1024, 1024, 6, 128, { x: 0, y: 0 })); fs.writeFileSync(path.join(dir, 'CHAR-24-DUP.webp'), makeWebpVp8x(1024, 1024, true)); const r = await getCharacterAsset('@CHAR-24-DUP', { charactersDir: dir }); fs.rmSync(path.join(dir, 'CHAR-24-DUP.webp'), { force: true }); fs.rmSync(path.join(dir, 'CHAR-24-DUP.png'), { force: true }); return r.state === 'CHARACTER_ASSET_HIT'; })());
// ---- WebP: VP8X alpha flag is a container hint and must FAIL CLOSED (no WebP pixel decoder) ----
check('WebP VP8X alpha flag -> fails closed (no unverifiable cutout)', parseWebp(makeWebpVp8x(1024, 1024, true)).ok === false);
check('WebP VP8X without alpha flag -> parses, hasAlpha=false', (() => { const r = parseWebp(makeWebpVp8x(1024, 1024, false)); return r.ok === true && r.hasAlpha === false; })());

// ---- 8. valid transparent PNG -> HIT ----
const arjunBuf = makePng(1024, 1024, 6);
write('@CHAR-01-ARJUN', arjunBuf);
const hit = await getCharacterAsset('@CHAR-01-ARJUN', { charactersDir: dir });
check('valid transparent PNG -> CHARACTER_ASSET_HIT', hit.state === 'CHARACTER_ASSET_HIT' && hit.ok === true, JSON.stringify(hit));
check('hit record correctness (tag/path/format/dims/alpha/source/validated)', (() => {
  const r = hit.record;
  return r.characterTag === '@CHAR-01-ARJUN' && r.format === 'png' && r.width === 1024 && r.height === 1024 && r.hasAlpha === true && r.source === 'human-supplied' && r.validated === true;
})());
check('hit exposes the exact file for a future compositor', hit.ok && fs.existsSync(hit.record.filePath));

// ---- 9. opaque PNG -> NO_ALPHA ----
write('@CHAR-03-GEETA', makePng(1024, 1024, 2));
const opaque = await getCharacterAsset('@CHAR-03-GEETA', { charactersDir: dir });
check('opaque PNG -> CHARACTER_ASSET_NO_ALPHA (not falsely a cutout)', opaque.state === 'CHARACTER_ASSET_NO_ALPHA' && opaque.ok === false, JSON.stringify(opaque));

// ---- 5/6. dimensions ----
write('@CHAR-04-BUZURG', makePng(2048, 2048, 6));
check('valid 2048x2048 transparent PNG -> HIT', (await getCharacterAsset('@CHAR-04-BUZURG', { charactersDir: dir })).state === 'CHARACTER_ASSET_HIT');
write('@CHAR-05-SMALL', makePng(512, 512, 6));
const small = await getCharacterAsset('@CHAR-05-SMALL', { charactersDir: dir });
check('undersized PNG -> CHARACTER_ASSET_INVALID', small.state === 'CHARACTER_ASSET_INVALID' && /minimum/i.test(small.reason), JSON.stringify(small));
write('@CHAR-06-BANNER', makePng(4096, 512, 6));
const banner = await getCharacterAsset('@CHAR-06-BANNER', { charactersDir: dir });
check('extreme aspect (4096x512) -> CHARACTER_ASSET_INVALID', banner.state === 'CHARACTER_ASSET_INVALID', JSON.stringify(banner));
// A square-ish-but-wide asset that clears the minimum height still fails on aspect.
write('@CHAR-06B-BANNER', makePng(2560, 1080, 6));
const banner2 = await getCharacterAsset('@CHAR-06B-BANNER', { charactersDir: dir });
check('wide 2560x1080 asset -> INVALID with aspect reason', banner2.state === 'CHARACTER_ASSET_INVALID' && /aspect/i.test(banner2.reason), JSON.stringify(banner2));
check('resolution: 512x512 false, 1024x1024 true', meetsCharacterMinimum(512, 512) === false && meetsCharacterMinimum(1024, 1024) === true);
check('aspect: 4096x512 false, 1024x1024 true, 1200x1500 true', isCharacterAspectAcceptable(4096, 512) === false && isCharacterAspectAcceptable(1024, 1024) === true && isCharacterAspectAcceptable(1200, 1500) === true);

// ---- 7. invalid PNG signature ----
write('@CHAR-07-BAD', Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('garbage-not-a-real-png-body-padding')]));
const bad = await getCharacterAsset('@CHAR-07-BAD', { charactersDir: dir });
check('invalid PNG signature -> CHARACTER_ASSET_INVALID', bad.state === 'CHARACTER_ASSET_INVALID', JSON.stringify(bad));
write('@CHAR-08-EMPTY', Buffer.alloc(0));
check('zero-byte asset -> CHARACTER_ASSET_INVALID', (await getCharacterAsset('@CHAR-08-EMPTY', { charactersDir: dir })).state === 'CHARACTER_ASSET_INVALID');

// ---- 10. unsupported extension ----
fs.writeFileSync(path.join(dir, 'CHAR-09-JPG.jpg'), makePng(1024, 1024, 6));
const unsupported = await getCharacterAsset('@CHAR-09-JPG.jpg', { charactersDir: dir });
check('unsupported extension -> CHARACTER_ASSET_UNSUPPORTED', unsupported.state === 'CHARACTER_ASSET_UNSUPPORTED', JSON.stringify(unsupported));
check('supported extensions are png+webp only', JSON.stringify([...SUPPORTED_CHARACTER_EXTENSIONS]) === JSON.stringify(['.png', '.webp']));

// ---- 11. WebP validation ----
fs.writeFileSync(path.join(dir, 'CHAR-10-WEBP.webp'), makeWebpVp8x(1024, 1024, true));
const webpHit = await getCharacterAsset('@CHAR-10-WEBP.webp', { charactersDir: dir });
check('8DX: VP8X alpha flag now fails closed (cannot verify pixels)', webpHit.state === 'CHARACTER_ASSET_INVALID' && /cannot be verified/.test((webpHit as any).reason ?? ''), JSON.stringify(webpHit));
fs.writeFileSync(path.join(dir, 'CHAR-11-WEBP.webp'), makeWebpVp8x(1024, 1024, false));
check('opaque WebP -> NO_ALPHA', (await getCharacterAsset('@CHAR-11-WEBP.webp', { charactersDir: dir })).state === 'CHARACTER_ASSET_NO_ALPHA');
check('parseWebp rejects non-RIFF bytes', parseWebp(Buffer.from('not a webp at all, padded to length thirty')).ok === false);
check('parsePng reports alpha from colour type', parsePng(makePng(64, 64, 6)).hasAlpha === true && parsePng(makePng(64, 64, 2)).hasAlpha === false);

// ---- 12. deterministic repeated resolution ----
const r1 = await getCharacterAsset('@CHAR-01-ARJUN', { charactersDir: dir });
const r2 = await getCharacterAsset('@CHAR-01-ARJUN', { charactersDir: dir });
check('repeated resolution is deterministic (same state+path)', r1.state === r2.state && r1.filePath === r2.filePath);

// ---- 15/16. lookups never modify assets ----
const p1 = characterAssetPath('@CHAR-01-ARJUN', dir);
const before = fs.readFileSync(p1); const beforeSha = sha(before);
await getCharacterAsset('@CHAR-01-ARJUN', { charactersDir: dir });
await getCharacterAsset('@CHAR-01-ARJUN', { charactersDir: dir });
check('valid asset never modified by lookup (SHA-256)', sha(fs.readFileSync(p1)) === beforeSha);

const corruptFile = characterAssetPath('@CHAR-07-BAD', dir);
const corruptBefore = sha(fs.readFileSync(corruptFile));
await getCharacterAsset('@CHAR-07-BAD', { charactersDir: dir });
await getCharacterAsset('@CHAR-07-BAD', { charactersDir: dir });
check('corrupted asset unchanged after failed lookup (SHA-256)', sha(fs.readFileSync(corruptFile)) === corruptBefore);

// ---- no substitute characters / no network / no writes ----
check('missing tag does not substitute another character', (await getCharacterAsset('@CHAR-99-NOBODY', { charactersDir: dir })).state === 'CHARACTER_ASSET_MISSING');
const srcText = fs.readFileSync(`${SRC}/characterAsset.ts`, 'utf8');
check('module performs no network I/O', !/fetch\(|XMLHttpRequest|https?:\/\//.test(srcText));
check('module never writes/generates assets', !/writeFile|createWriteStream|mkdir|rename\(/.test(srcText));
check('future-flow-export declared but not implemented', /future-flow-export/.test(srcText) && !/extractImageElementIntrinsicPng|flowClient/.test(srcText));
check('module has no Flow/Chrome/playwright dependency', !/playwright|FlowClient|chrome/i.test(srcText));

// ---- batch resolution preserves order + per-item states ----
const many = await getCharacterAssets(['@CHAR-01-ARJUN', '@CHAR-02-MOHAN', '@CHAR-03-GEETA'], { charactersDir: dir });
check('batch resolution preserves order and per-item states', many.length === 3 && many[0].state === 'CHARACTER_ASSET_HIT' && many[1].state === 'CHARACTER_ASSET_MISSING' && many[2].state === 'CHARACTER_ASSET_NO_ALPHA');

// ---- configuration error throws ----
check('missing charactersDir throws (configuration error)', await (async () => { try { await getCharacterAsset('@CHAR-01-ARJUN', { charactersDir: '' }); return false; } catch { return true; } })());
check('tests wrote only to the OS temp dir', tmp.startsWith(os.tmpdir()) && !fs.existsSync(`${SRC}/../assets/characters`));

console.log(`\nCHARACTER-ASSET TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
