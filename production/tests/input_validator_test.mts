// Offline external-input validator tests (STEP-8DM). Temp dirs only. No Flow/Chrome. Read-only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);

import { REPO } from './_testPaths.mjs';
const SRC = `${REPO}/production/src`;
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;

const iv = await import(pathToFileURL(`${SRC}/inputValidator.ts`).href);
const { validateProjectInputs, validateBackgroundInputs, validateCharacterInputs, validateNarrationInputs, validateFlowClipInputs, validateMusicInputs, validateBrandingInputs, deriveRequiredInputs, safeInputPath } = iv;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

function makePng(w: number, h: number, ct = 6, tag = 0) {
  const T: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct; const ch = ct === 6 ? 4 : 2; const raw = Buffer.alloc(h * (1 + w * ch), 0x80);
  for (let _y = 0; _y < h; _y++) raw[_y * (1 + w * ch)] = 0; // filter byte = None raw[10] = tag & 0xff;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const wav = (f: string, sec: number, tag = 0) => { const n = Math.round(sec * 8000); const d = Buffer.alloc(n * 2, tag); const b = Buffer.alloc(44 + d.length); b.write('RIFF', 0); b.writeUInt32LE(36 + d.length, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(d.length, 40); fs.writeFileSync(f, b); };
const mkMp4 = async (o: string, d = 3, withAudio = true) => { const args = ['-y', '-f', 'lavfi', '-i', `color=c=0x203040:s=1920x1080:d=${d}`]; if (withAudio) args.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=48000:d=${d}`); args.push('-t', String(d), '-c:v', 'libx264', '-pix_fmt', 'yuv420p'); if (withAudio) args.push('-c:a', 'aac'); args.push('-shortest', o); await exec(process.env.FFMPEG_PATH, args); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8dm-'));
const PID = 'fixture-8dm';
const root = path.join(tmp, 'inputs', PID);
for (const c of ['backgrounds','characters','narration','flow-clips','music','branding']) fs.mkdirSync(path.join(root, c), { recursive: true });
const BGS = ['#BGD-01-VILLAGE-STREET-WIDE', '#BGD-02-WELL-AREA-WIDE'];
const CHARS = ['@CHAR-01-ARJUN', '@CHAR-02-MOHAN'];
const base = { projectId: PID, inputRoot: root, requiredBackgrounds: BGS, requiredCharacters: CHARS, narrationScenes: [1, 2], sceneNumbers: [1, 2], requiredClips: [2], ffprobePath: process.env.FFPROBE_PATH };

// ---- 1. missing input root ----
{
  const r = await validateProjectInputs({ ...base, inputRoot: path.join(tmp, 'no-such') });
  check('1. missing input root -> MISSING everywhere, no creation', r.inputRootExists === false && r.counts.backgrounds.valid === 0 && !fs.existsSync(path.join(tmp, 'no-such')));
}

// ---- 2/3/4. backgrounds ----
{
  fs.writeFileSync(path.join(root, 'backgrounds', 'BGD-01-VILLAGE-STREET-WIDE.png'), makePng(1920, 1080, 2, 1));
  let r = await validateBackgroundInputs(base);
  check('2. valid background accepted (16:9, ≥1280x720)', r.find((x) => x.id === BGS[0])?.state === 'VALID');
  check('2b. unsupplied background is MISSING', r.find((x) => x.id === BGS[1])?.state === 'MISSING');
  fs.writeFileSync(path.join(root, 'backgrounds', 'BGD-02-WELL-AREA-WIDE.png'), makePng(640, 360, 2, 2));
  r = await validateBackgroundInputs(base);
  check('3. invalid background dimensions -> INVALID', r.find((x) => x.id === BGS[1])?.state === 'INVALID');
  fs.writeFileSync(path.join(root, 'backgrounds', 'BGD-02-WELL-AREA-WIDE.png'), makePng(2000, 2000, 2, 2));
  r = await validateBackgroundInputs(base);
  check('4. invalid background aspect -> INVALID', r.find((x) => x.id === BGS[1])?.state === 'INVALID' && /aspect/i.test(r.find((x) => x.id === BGS[1])!.reason ?? ''));
  fs.writeFileSync(path.join(root, 'backgrounds', 'BGD-02-WELL-AREA-WIDE.png'), makePng(1920, 1080, 2, 2));
}

// ---- 5/6/7/8. characters ----
{
  fs.writeFileSync(path.join(root, 'characters', 'CHAR-01-ARJUN.png'), makePng(1024, 1024, 6, 1));
  let r = await validateCharacterInputs(base);
  check('5. valid transparent character accepted', r.find((x) => x.id === CHARS[0])?.state === 'VALID');
  check('5b. unsupplied character is MISSING', r.find((x) => x.id === CHARS[1])?.state === 'MISSING');
  const op = makePng(1024, 1024, 6); op[25] = 2;
  fs.writeFileSync(path.join(root, 'characters', 'CHAR-02-MOHAN.png'), op);
  r = await validateCharacterInputs(base);
  check('6. character without alpha -> INVALID', r.find((x) => x.id === CHARS[1])?.state === 'INVALID' && /alpha/i.test(r.find((x) => x.id === CHARS[1])!.reason ?? ''));
  fs.writeFileSync(path.join(root, 'characters', 'CHAR-02-MOHAN.png'), makePng(512, 512, 6, 2));
  r = await validateCharacterInputs(base);
  check('7. character too small -> INVALID', r.find((x) => x.id === CHARS[1])?.state === 'INVALID');
  fs.writeFileSync(path.join(root, 'characters', 'CHAR-02-MOHAN.png'), makePng(1024, 1024, 6, 2));
  // both png and webp -> duplicate
  fs.writeFileSync(path.join(root, 'characters', 'CHAR-02-MOHAN.webp'), Buffer.from('RIFF....WEBPVP8X'));
  r = await validateCharacterInputs(base);
  check('8. duplicate character files -> DUPLICATE (path-ambiguity rejected)', r.find((x) => x.id === CHARS[1])?.state === 'DUPLICATE');
  fs.rmSync(path.join(root, 'characters', 'CHAR-02-MOHAN.webp'));
}

// ---- 9/10/11/12. narration ----
{
  wav(path.join(root, 'narration', 'narration-0001.wav'), 3);
  let r = await validateNarrationInputs(base);
  check('9. valid narration accepted with measured duration', r.find((x) => x.id === 'narration-0001')?.state === 'VALID' && r.find((x) => x.id === 'narration-0001')!.durationSeconds! > 2.8);
  check('10. missing narration -> MISSING', r.find((x) => x.id === 'narration-0002')?.state === 'MISSING');
  wav(path.join(root, 'narration', 'narration-0002.mp3'), 3);
  wav(path.join(root, 'narration', 'narration-0002.wav'), 3);
  r = await validateNarrationInputs(base);
  check('11. ambiguous narration extensions -> DUPLICATE', r.find((x) => x.id === 'narration-0002')?.state === 'DUPLICATE', JSON.stringify(r.find((x) => x.id === 'narration-0002')));
  fs.rmSync(path.join(root, 'narration', 'narration-0002.mp3'));
  fs.writeFileSync(path.join(root, 'narration', 'narration-0002.wav'), Buffer.from('not real audio at all, padded to some length'));
  r = await validateNarrationInputs(base);
  check('12. invalid narration audio -> INVALID', r.find((x) => x.id === 'narration-0002')?.state === 'INVALID');
  wav(path.join(root, 'narration', 'narration-0002.wav'), 3);
}

// ---- 13/14/15. flow clips ----
{
  await mkMp4(path.join(root, 'flow-clips', 'scene-0002.mp4'), 3, true);
  let r = await validateFlowClipInputs(base);
  check('13. valid flow clip accepted with measured duration', r.find((x) => x.id === 'scene-0002')?.state === 'VALID' && r.find((x) => x.id === 'scene-0002')!.durationSeconds! > 2.8);
  await mkMp4(path.join(root, 'flow-clips', 'scene-0002.mp4'), 3, false);
  r = await validateFlowClipInputs(base);
  check('14. flow clip missing audio -> INVALID (edit.ts requires audio)', r.find((x) => x.id === 'scene-0002')?.state === 'INVALID', r.find((x) => x.id === 'scene-0002')!.reason);
  fs.writeFileSync(path.join(root, 'flow-clips', 'scene-0002.mp4'), Buffer.from('garbage not a real mp4 container at all'));
  r = await validateFlowClipInputs(base);
  check('15. invalid flow clip -> INVALID', r.find((x) => x.id === 'scene-0002')?.state === 'INVALID');
  await mkMp4(path.join(root, 'flow-clips', 'scene-0002.mp4'), 3, true);
  // clip duration comes from ffprobe, never the generator "8s" setting
  check('15b. actual duration from ffprobe, not the 8s generator setting', r.find((x) => x.id === 'scene-0002')?.durationSeconds !== 8);
}

// ---- 16-20. music / licence ----
{
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=5', '-c:a', 'libmp3lame', path.join(root, 'music', 'background-music.mp3')]);
  let r = await validateMusicInputs(base);
  check('16. BGM present but no provenance -> LICENSE_INVALID', r[0].state === 'LICENSE_INVALID');
  const lic = (license: string, attribution?: string) => fs.writeFileSync(path.join(root, 'music', 'background-music.license.json'), JSON.stringify({ license, attribution, source: 'human-supplied' }));
  lic('CC BY-NC 4.0'); r = await validateMusicInputs(base);
  check('17. NC licence rejected', r[0].state === 'LICENSE_INVALID', r[0].reason);
  lic('CC BY-ND 4.0'); r = await validateMusicInputs(base);
  check('18. ND licence rejected', r[0].state === 'LICENSE_INVALID');
  lic('All Rights Reserved'); r = await validateMusicInputs(base);
  check('19. unknown licence rejected', r[0].state === 'LICENSE_INVALID');
  lic('CC BY 4.0'); r = await validateMusicInputs(base);
  check('20. CC-BY without attribution rejected', r[0].state === 'LICENSE_INVALID');
  lic('CC BY 4.0', 'Composer X, CC BY 4.0'); r = await validateMusicInputs(base);
  check('20b. CC BY accepted with attribution metadata', r[0].state === 'VALID' && r[0].license?.kind === 'cc-by' && r[0].license?.attributionRequired === true, JSON.stringify(r[0]));
  lic('CC0'); r = await validateMusicInputs(base);
  check('20c. CC0 accepted without attribution', r[0].state === 'VALID' && r[0].license?.kind === 'cc0');
}

// ---- 21/22/23. branding ----
{
  await mkMp4(path.join(root, 'branding', 'channel-intro.mp4'), 5, true);
  fs.writeFileSync(path.join(root, 'branding', 'channel-logo.png'), makePng(256, 256, 6, 3));
  let r = await validateBrandingInputs(base);
  check('21. valid branding accepted (intro + logo)', r.every((x) => x.state === 'VALID'), JSON.stringify(r));
  fs.rmSync(path.join(root, 'branding', 'channel-intro.mp4'));
  r = await validateBrandingInputs(base);
  check('22. missing intro -> MISSING', r.find((x) => x.id === 'channel-intro')?.state === 'MISSING');
  await mkMp4(path.join(root, 'branding', 'channel-intro.mp4'), 5, true);
  fs.writeFileSync(path.join(root, 'branding', 'channel-logo.png'), Buffer.from('not a png at all, padded to reasonable length'));
  r = await validateBrandingInputs(base);
  check('23. invalid logo -> INVALID', r.find((x) => x.id === 'channel-logo')?.state === 'INVALID');
  fs.writeFileSync(path.join(root, 'branding', 'channel-logo.png'), makePng(256, 256, 6, 3));
}

// ---- 24. path traversal rejection ----
{
  const bad = ['../../secret.png', '..\\..\\secret.png', 'C:\\secret.png', '/etc/passwd', '\\\\unc\\x'];
  for (const b of bad) {
    let escaped = false;
    try { const p = safeInputPath(root, b); escaped = !p.startsWith(path.resolve(root)); } catch { escaped = false; }
    check(`24. traversal rejected: ${JSON.stringify(b.slice(0, 18))}`, !escaped);
  }
  check('24b. safe relative path resolves inside the root', safeInputPath(root, 'backgrounds/x.png').startsWith(path.resolve(root)));
}

// ---- 25. complete valid fixture -> READY inputs ----
{
  const r = await validateProjectInputs(base);
  check('25. complete valid fixture -> all categories fully valid', r.counts.backgrounds.valid === 2 && r.counts.characters.valid === 2 && r.counts.narration.valid === 2 && r.counts.flowClips.valid === 1 && r.counts.music.valid === 1 && r.counts.branding.valid === 2, JSON.stringify(r.counts));
  check('25b. no issues reported for a fully valid fixture', r.issues.length === 0, JSON.stringify(r.issues));
}

// ---- 26. partial fixture -> complete diagnostic (one invalid never hides another) ----
{
  fs.rmSync(path.join(root, 'backgrounds', 'BGD-01-VILLAGE-STREET-WIDE.png'));
  const sp = makePng(1024, 1024, 6); sp[25] = 2;
  fs.writeFileSync(path.join(root, 'characters', 'CHAR-01-ARJUN.png'), sp);
  const r = await validateProjectInputs(base);
  const states = [...r.backgrounds, ...r.characters].map((x) => x.state);
  check('26. partial fixture reports EVERY problem (no hiding)', states.filter((s) => s !== 'VALID').length >= 2 && r.issues.length >= 2, JSON.stringify(r.issues));
  fs.writeFileSync(path.join(root, 'backgrounds', 'BGD-01-VILLAGE-STREET-WIDE.png'), makePng(1920, 1080, 2, 1));
  fs.writeFileSync(path.join(root, 'characters', 'CHAR-01-ARJUN.png'), makePng(1024, 1024, 6, 1));
}

// ---- 27. no filesystem mutation during validation ----
{
  const snapshot = (b: string): string => { const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => { const f = path.join(d, e.name); return e.isDirectory() ? walk(f) : [`${path.relative(b, f)}:${fs.statSync(f).size}:${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}`]; }); return walk(b).sort().join('|'); };
  const before = snapshot(tmp);
  await validateProjectInputs(base); await validateProjectInputs({ ...base, inputRoot: path.join(tmp, 'nope') });
  check('27. validation performs ZERO filesystem mutation', snapshot(tmp) === before);
}

// ---- 28/29. manifest/relative paths + determinism ----
{
  const r = await validateProjectInputs(base);
  const all = [...r.backgrounds, ...r.characters, ...r.narration, ...r.flowClips, ...r.music, ...r.branding];
  check('28. all relativePath values are relative (no drive letters)', all.every((a) => a.relativePath === null || !/[A-Za-z]:\\\\/.test(a.relativePath)));
  const r2 = await validateProjectInputs(base);
  const strip = (x: any) => JSON.stringify(x);
  check('29. deterministic validation output across runs', strip({ ...r, inputRootExists: true }) === strip({ ...r2, inputRootExists: true }));
}

// ---- deriveRequiredInputs from a real-shaped pipeline ----
{
  const NARR = (n: number) => ({ narration_text: `narr ${n}`, animation_prompt_NARRATOR_ONLY: 'No voice synthesis. Narrator voiceover will be layered in editing.' });
  const pipeline: any = { characters: [{ tag: '@CHAR-01-ARJUN' }, { tag: '@CHAR-02-MOHAN' }], backgrounds: [{ tag: '#BGD-01' }, { tag: '#BGD-02' }], scenes: [
    { scene_number: 1, background_tag: '#BGD-01', character_tags: ['@CHAR-01-ARJUN'], speaker: 'NARRATOR', ...NARR(1) },
    { scene_number: 2, background_tag: '#BGD-02', character_tags: [], speaker: 'none', ...NARR(2) },
    { scene_number: 3, background_tag: '#BGD-01', character_tags: ['@CHAR-02-MOHAN'], speaker: '@CHAR-02-MOHAN', devanagari_dialogue: 'मोहन बोलता है।' },
  ] };
  const d = deriveRequiredInputs(pipeline);
  check('deriveRequiredInputs: backgrounds/characters/scenes derived', d.backgrounds.length === 2 && d.characters.length === 2 && d.sceneNumbers.join(',') === '1,2,3');
  check('deriveRequiredInputs: narration scenes = NARRATOR|none', d.narrationScenes.join(',') === '1,2');
  check('deriveRequiredInputs: dialogue scenes require clips', d.requiredClips.join(',') === '3');
}

// ---- 30. real project remains untouched ----
{
  const realPipeline = `${REPO}/scripting/projects/raat-ka-khauf-3am-kuan/pipeline.json`;
  const h = crypto.createHash('sha256').update(fs.readFileSync(realPipeline)).digest('hex');
  check('30. real pipeline.json SHA unchanged', h === '0c654402dad814f11c3e498cfd541667aabd65e24d7a17db01219bbd7491dcfb');
  check('30b. this test created no production input files', !fs.existsSync(`${SRC}/../assets/characters`));
}

const srcText = fs.readFileSync(`${SRC}/inputValidator.ts`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
check('inputValidator performs no network I/O', !/fetch\(|XMLHttpRequest|https?:\/\//.test(srcText));
check('inputValidator never writes/mutates inputs', !/writeFile|appendFile|rename\(|mkdir|rm\(/.test(srcText));
check('inputValidator has no Flow/Chrome dependency', !/playwright|FlowClient|chrome/i.test(srcText));

console.log(`\nINPUT-VALIDATOR TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
