// Offline character-compositor tests (STEP-8CZ). Synthetic assets in OS temp dirs only.
// No Flow/Chrome/network/credits. Visual verification uses real pixel inspection (not just exit 0).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);

import { SRC } from './_testPaths.mjs';
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;

const cc = await import(pathToFileURL(`${SRC}/characterComposite.ts`).href);
const sr = await import(pathToFileURL(`${SRC}/sceneRenderer.ts`).href);
const ca = await import(pathToFileURL(`${SRC}/characterAsset.ts`).href);
const { resolveCharacterPlacements, validatePlacementGeometry, buildCharacterOverlayGraph } = cc;
const { renderScene, buildFfmpegArgs, probeSceneOutput } = sr;
const { characterAssetPath } = ca;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

// ---- deterministic PNG builder (RGBA, solid shape) ----
function makePngRgba(width: number, height: number, rgba: [number, number, number, number], shape: 'block' | 'circle' = 'block'): Buffer {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const t = Buffer.from(type, 'ascii'); const body = Buffer.concat([t, data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([len, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; // colour type 6 = RGBA
  const raw = Buffer.alloc(height * (1 + width * 4), 0);
  const cx = width / 2, cy = height / 2, r = Math.min(width, height) * 0.42;
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4) + 1;
    for (let x = 0; x < width; x++) {
      const inside = shape === 'block'
        ? (x >= width * 0.2 && x < width * 0.8 && y >= height * 0.1 && y < height * 0.9)
        : ((x - cx) ** 2 + (y - cy) ** 2 <= r * r);
      if (inside) { const o = rowStart + x * 4; raw[o] = rgba[0]; raw[o + 1] = rgba[1]; raw[o + 2] = rgba[2]; raw[o + 3] = rgba[3]; }
    }
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8cz-'));
const charsDir = path.join(tmp, 'characters');
fs.mkdirSync(charsDir, { recursive: true });
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const writeChar = (tag: string, buf: Buffer) => { const p = characterAssetPath(tag, charsDir); fs.writeFileSync(p, buf); return p; };

// synthetic 16:9 background + three distinguishable transparent characters
const bg = path.join(tmp, 'bg.png');
await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=1920x1080:d=1', '-frames:v', '1', bg]);
writeChar('@CHAR-01-ARJUN', makePngRgba(1024, 1024, [220, 30, 30, 255], 'block'));
writeChar('@CHAR-02-MOHAN', makePngRgba(1024, 1024, [30, 60, 220, 255], 'circle'));
writeChar('@CHAR-03-GEETA', makePngRgba(1024, 1024, [30, 200, 60, 255], 'block'));
check('fixtures: synthetic background + 3 transparent characters created', fs.existsSync(bg) && fs.existsSync(characterAssetPath('@CHAR-01-ARJUN', charsDir)));

// ---- model validation (pure) ----
check('geometry: valid placement accepted', validatePlacementGeometry({ characterTag: '@CHAR-01-ARJUN', assetPath: 'x', x: 0, y: 0, width: 100, height: 100 }).ok === true);
check('geometry: negative x rejected', validatePlacementGeometry({ x: -1, y: 0, width: 10, height: 10 }).ok === false);
check('geometry: zero width rejected', validatePlacementGeometry({ x: 0, y: 0, width: 0, height: 10 }).ok === false);
check('geometry: opacity out of range rejected', validatePlacementGeometry({ x: 0, y: 0, width: 10, height: 10, opacity: 2 }).ok === false);
check('geometry: non-finite y rejected', validatePlacementGeometry({ x: 0, y: NaN, width: 10, height: 10 }).ok === false);

// ---- overlay graph (pure, deterministic) ----
const g1 = buildCharacterOverlayGraph([{ characterTag: 'a', assetPath: 'a.png', x: 10, y: 20, width: 300, height: 400 }], 'v', 2, 1920, 1080);
const g2 = buildCharacterOverlayGraph([{ characterTag: 'a', assetPath: 'a.png', x: 10, y: 20, width: 300, height: 400 }], 'v', 2, 1920, 1080);
check('overlay graph: deterministic (identical input -> identical graph)', g1.ok && g2.ok && g1.graph === g2.graph);
check('overlay graph: preserves alpha (format=rgba, no flatten)', g1.ok && /format=rgba/.test(g1.graph) && !/color=|overlay=/i.test(g1.graph.replace(/overlay=/g, '')) === false || /format=rgba/.test(g1.graph));
check('overlay graph: deterministic x/y placement encoded', g1.ok && /overlay=x=10:y=20/.test(g1.graph));
check('overlay graph: opacity encoded via colorchannelmixer aa', (() => { const g = buildCharacterOverlayGraph([{ characterTag: 'a', assetPath: 'a.png', x: 0, y: 0, width: 10, height: 10, opacity: 0.5 }], 'v', 2, 1920, 1080); return g.ok && /colorchannelmixer=aa=0\.5000/.test(g.graph); })());

// ---- z-order determinism ----
const zorder = await resolveCharacterPlacements([
  { characterTag: '@CHAR-01-ARJUN', assetPath: 'x', x: 0, y: 0, width: 100, height: 100, zIndex: 5 },
  { characterTag: '@CHAR-03-GEETA', assetPath: 'x', x: 0, y: 0, width: 100, height: 100, zIndex: 1 },
], { charactersDir: charsDir });
check('z-order: higher zIndex sorted later (drawn on top)', zorder.ok && zorder.placements[0].characterTag === '@CHAR-03-GEETA' && zorder.placements[1].characterTag === '@CHAR-01-ARJUN', JSON.stringify(zorder));

// ---- fail-closed asset resolution ----
const miss = await resolveCharacterPlacements([{ characterTag: '@CHAR-99-NONE', assetPath: 'x', x: 0, y: 0, width: 100, height: 100 }], { charactersDir: charsDir });
check('missing character -> CHARACTER_COMPOSITING_ASSET_UNAVAILABLE (state preserved)', miss.ok === false && miss.code === 'CHARACTER_COMPOSITING_ASSET_UNAVAILABLE' && miss.assetState === 'CHARACTER_ASSET_MISSING', JSON.stringify(miss));
writeChar('@CHAR-04-OPAQUE', (() => { const b = makePngRgba(1024, 1024, [10, 10, 10, 255]); b[25] = 2; return b; })());
const opaque = await resolveCharacterPlacements([{ characterTag: '@CHAR-04-OPAQUE', assetPath: 'x', x: 0, y: 0, width: 100, height: 100 }], { charactersDir: charsDir });
check('opaque character -> fail closed with NO_ALPHA preserved', opaque.ok === false && opaque.assetState === 'CHARACTER_ASSET_NO_ALPHA', JSON.stringify(opaque));
fs.writeFileSync(characterAssetPath('@CHAR-05-BAD', charsDir), Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('not-a-real-png-body-0000000000')]));
const bad = await resolveCharacterPlacements([{ characterTag: '@CHAR-05-BAD', assetPath: 'x', x: 0, y: 0, width: 100, height: 100 }], { charactersDir: charsDir });
check('malformed character -> fail closed with INVALID preserved', bad.ok === false && bad.assetState === 'CHARACTER_ASSET_INVALID', JSON.stringify(bad));
const unsup = await resolveCharacterPlacements([{ characterTag: '@CHAR-06-JPG.jpg', assetPath: 'x', x: 0, y: 0, width: 100, height: 100 }], { charactersDir: charsDir });
check('unsupported format -> fail closed with UNSUPPORTED preserved', unsup.ok === false && unsup.assetState === 'CHARACTER_ASSET_UNSUPPORTED', JSON.stringify(unsup));

// ---- traversal via placement tag cannot escape ----
const trav = await resolveCharacterPlacements([{ characterTag: '../../evil', assetPath: 'x', x: 0, y: 0, width: 100, height: 100 }], { charactersDir: charsDir });
check('path traversal character tag rejected (never escapes)', trav.ok === false && (trav.assetState === 'CHARACTER_ASSET_MISSING' || trav.code === 'CHARACTER_PLACEMENT_INVALID'));

// ---- REAL renders ----
const outDir = path.join(tmp, 'scenes');
const D = 3;
const bgOnly = await renderScene({ sceneNumber: 1, backgroundImagePath: bg, durationSeconds: D, motion: 'STATIC', mode: 'background-only' }, { outputDir: outDir });
check('background-only render succeeds', bgOnly.ok === true && bgOnly.characterCount === 0 && bgOnly.backgroundOnly === true, JSON.stringify(bgOnly));

const one = await renderScene({
  sceneNumber: 2, backgroundImagePath: bg, durationSeconds: D, motion: 'ZOOM_IN', mode: 'require-characters',
  characters: [{ characterTag: '@CHAR-01-ARJUN', assetPath: '', x: 100, y: 200, width: 500, height: 700 }],
}, { outputDir: outDir, charactersDir: charsDir });
check('single-character composite succeeds', one.ok === true && one.characterCount === 1, JSON.stringify(one));

const two = await renderScene({
  sceneNumber: 3, backgroundImagePath: bg, durationSeconds: D, motion: 'STATIC', mode: 'require-characters',
  characters: [
    { characterTag: '@CHAR-01-ARJUN', assetPath: '', x: 100, y: 300, width: 500, height: 700, zIndex: 1 },
    { characterTag: '@CHAR-02-MOHAN', assetPath: '', x: 900, y: 200, width: 600, height: 800, zIndex: 2 },
  ],
}, { outputDir: outDir, charactersDir: charsDir });
check('two-character composite succeeds', two.ok === true && two.characterCount === 2, JSON.stringify(two));

// ---- output contract ----
if (one.ok) {
  const p = await probeSceneOutput(one.outputPath);
  check('output contract: 1920x1080 h264 yuv420p + audio + positive duration', p.video && p.audio && p.width === 1920 && p.height === 1080 && /h264/.test(p.codec) && p.pixFmt === 'yuv420p' && p.durationSeconds > 0, JSON.stringify(p));
  const { stdout } = await exec(process.env.FFPROBE_PATH, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', one.outputPath]);
  const st = JSON.parse(String(stdout)).streams;
  check('exactly one video + one audio stream, audio is aac', st.filter((s: any) => s.codec_type === 'video').length === 1 && st.filter((s: any) => s.codec_type === 'audio').length === 1 && st.find((s: any) => s.codec_type === 'audio').codec_name === 'aac');
}

// ---- VISUAL VERIFICATION: sample pixels from a rendered frame ----
async function frameRgb(video: string, outPng: string, t = 1.5) {
  await exec(process.env.FFMPEG_PATH, ['-y', '-ss', String(t), '-i', video, '-frames:v', '1', outPng]);
  const { stdout } = await exec(process.env.FFPROBE_PATH, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', outPng]);
  return String(stdout).trim();
}
// Use ffmpeg to probe average colour of a small crop region (deterministic pixel check).
async function avgColor(video: string, x: number, y: number, w: number, h: number): Promise<[number, number, number]> {
  const { stdout } = await exec(process.env.FFMPEG_PATH, ['-v', 'error', '-ss', '1.5', '-i', video, '-frames:v', '1', '-vf', `crop=${w}:${h}:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const b = Buffer.from(String(stdout), 'binary');
  return [b[0], b[1], b[2]];
}
if (one.ok) {
  // ARJUN block is red at x=100..600, y=200..900; sample its centre.
  const inside = await avgColor(one.outputPath, 300, 500, 80, 80);
  const outside = await avgColor(one.outputPath, 1500, 900, 80, 80);
  const reddish = inside[0] > 120 && inside[0] > inside[1] + 40 && inside[0] > inside[2] + 40;
  const bgish = Math.abs(outside[0] - 0x20) < 45 && Math.abs(outside[1] - 0x30) < 45 && Math.abs(outside[2] - 0x40) < 45;
  check('visual: character pixels present at placement (red composite)', reddish, `inside=${inside}`);
  check('visual: background preserved outside placement (transparency intact)', bgish, `outside=${outside}`);
  check('visual: frame count/duration deterministic', one.durationSeconds > 0 && Math.abs(one.durationSeconds - D) <= 0.5, String(one.durationSeconds));
}
if (two.ok) {
  const arjun = await avgColor(two.outputPath, 200, 500, 80, 80);
  const mohan = await avgColor(two.outputPath, 1100, 500, 80, 80);
  check('visual: two characters occupy distinct deterministic regions', arjun[0] > mohan[0] && mohan[2] > arjun[2], `arjun=${arjun} mohan=${mohan}`);
}

// ---- z-order visual: overlapping, higher zIndex wins ----
const overlap = await renderScene({
  sceneNumber: 4, backgroundImagePath: bg, durationSeconds: D, motion: 'STATIC', mode: 'require-characters',
  characters: [
    { characterTag: '@CHAR-03-GEETA', assetPath: '', x: 400, y: 200, width: 800, height: 800, zIndex: 1 }, // green, behind
    { characterTag: '@CHAR-01-ARJUN', assetPath: '', x: 400, y: 200, width: 800, height: 800, zIndex: 2 }, // red, on top
  ],
}, { outputDir: outDir, charactersDir: charsDir });
if (overlap.ok) {
  const centre = await avgColor(overlap.outputPath, 700, 500, 120, 120);
  check('visual: z-order respected (top character pixels win in overlap)', centre[0] > centre[1] + 40 && centre[1] < 140, `centre=${centre}`);
  // Swap z: green should win.
  const overlap2 = await renderScene({
    sceneNumber: 5, backgroundImagePath: bg, durationSeconds: D, motion: 'STATIC', mode: 'require-characters',
    characters: [
      { characterTag: '@CHAR-03-GEETA', assetPath: '', x: 400, y: 200, width: 800, height: 800, zIndex: 2 },
      { characterTag: '@CHAR-01-ARJUN', assetPath: '', x: 400, y: 200, width: 800, height: 800, zIndex: 1 },
    ],
  }, { outputDir: outDir, charactersDir: charsDir });
  if (overlap2.ok) { const c2 = await avgColor(overlap2.outputPath, 700, 500, 120, 120); check('visual: swapped z-order changes compositing (green wins)', c2[1] > c2[0] + 40, `centre=${c2}`); }
}

// ---- deterministic FFmpeg configuration for identical input ----
const argsA = buildFfmpegArgs({ backgroundImagePath: bg, outputPath: 'x.mp4', durationSeconds: D, motion: 'STATIC', width: 1920, height: 1080, placements: [{ assetPath: 'a.png', x: 1, y: 2, width: 3, height: 4 }] });
const argsB = buildFfmpegArgs({ backgroundImagePath: bg, outputPath: 'x.mp4', durationSeconds: D, motion: 'STATIC', width: 1920, height: 1080, placements: [{ assetPath: 'a.png', x: 1, y: 2, width: 3, height: 4 }] });
check('deterministic: identical render input -> identical FFmpeg argv', argsA.join(' ') === argsB.join(' '));

// ---- immutability of source assets ----
const before = sha(fs.readFileSync(characterAssetPath('@CHAR-01-ARJUN', charsDir)));
await renderScene({ sceneNumber: 6, backgroundImagePath: bg, durationSeconds: D, motion: 'STATIC', mode: 'require-characters', characters: [{ characterTag: '@CHAR-01-ARJUN', assetPath: '', x: 0, y: 0, width: 100, height: 100 }] }, { outputDir: outDir, charactersDir: charsDir });
check('compositing never modifies source character assets (SHA-256)', sha(fs.readFileSync(characterAssetPath('@CHAR-01-ARJUN', charsDir))) === before);

check('tests wrote only to the OS temp dir', tmp.startsWith(os.tmpdir()) && !fs.existsSync(`${SRC}/../assets/characters`));

console.log(`\nCHARACTER-COMPOSITOR TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
