// Offline per-scene readiness + render-key tests (STEP-8DE). Temp dirs only. No Flow/Chrome.
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
const ss = await import(pathToFileURL(`${SRC}/sceneState.ts`).href);
const { inspectSceneState, computeRenderKey, sceneDefinitionFingerprint, RENDERER_CONTRACT_VERSION } = ss;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

function makePng(width: number, height: number, colourType = 6): Buffer {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = colourType;
  const ch = colourType === 6 ? 4 : 2;
  const raw = Buffer.alloc(height * (1 + width * ch), 0x80);
  for (let _y = 0; _y < height; _y++) raw[_y * (1 + width * ch)] = 0; // filter byte = None
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const wav = (file: string, seconds: number, rate = 8000) => {
  const n = Math.max(1, Math.round(seconds * rate)); const data = Buffer.alloc(n * 2);
  const buf = Buffer.alloc(44 + data.length); buf.write('RIFF', 0); buf.writeUInt32LE(36 + data.length, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(data.length, 40); fs.writeFileSync(file, buf);
};
const scene = (over: any = {}) => ({
  scene_number: 1, title: 'T', background_tag: '#BGD-01-VILLAGE-STREET-WIDE', character_tags: ['@CHAR-01-ARJUN'],
  speaker: 'NARRATOR', camera: 'Wide', visual_action: 'Arjun', effects: 'wind', narration_text: 'कहानी', devanagari_dialogue: '',
  clip_length_seconds: null, edit_length_seconds: null, ...over,
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8de-ss-'));
const root = path.join(tmp, 'raat-ka-khauf-3am-kuan');
for (const c of ['characters', 'narration', 'flow-clips', 'backgrounds', 'music']) fs.mkdirSync(path.join(root, c), { recursive: true });
const put = (cat: string, name: string, buf: Buffer) => fs.writeFileSync(path.join(root, cat, name), buf);
put('backgrounds', 'BGD-01-VILLAGE-STREET-WIDE.png', makePng(1920, 1080, 2));
put('characters', 'CHAR-01-ARJUN.png', makePng(1024, 1024, 6));

const S = { inputRoot: root, localSynthesisPolicy: 'ALLOW_LOCAL' as const };
// This suite exercises readiness / render-key semantics as they behaved BEFORE the local-synthesis
// policy, so it opts into ALLOW_LOCAL explicitly. Under the STRICT production default a character
// scene with no supplied clip is reported WAITING_FOR_VIDEO_CLIP / SUPPLIED_VIDEO_REQUIRED, which
// would mask the per-asset readiness states this suite is asserting.
// The STRICT policy itself is proven by tests/local_synthesis_policy_test.mts.
const S_ALLOW_LOCAL = S;
{
  const strict = await inspectSceneState(scene(), { inputRoot: root });
  check('STRICT production default blocks a character scene with no supplied clip',
    strict.renderMode === 'NONE' && strict.readiness === 'WAITING_FOR_VIDEO_CLIP' && strict.reasons.includes('SUPPLIED_VIDEO_REQUIRED'),
    JSON.stringify({ m: strict.renderMode, r: strict.readiness, rs: strict.reasons }));
}

// ---- 24. narrator-only readiness ----
{
  const s = await inspectSceneState(scene(), S_ALLOW_LOCAL);
  check('narrator-only without narration -> WAITING_FOR_NARATION', s.readiness === 'WAITING_FOR_NARRATION' && s.narration === 'NARRATOR_ONLY', JSON.stringify({ r: s.readiness, n: s.narration }));
}
put('narration', 'narration-0001.wav', (() => { const p = path.join(root, 'narration', 'narration-0001.wav'); wav(p, 4); return fs.readFileSync(p); })());
{
  const s = await inspectSceneState(scene(), S_ALLOW_LOCAL);
  check('narrator-only with bg+narration -> READY via narration duration', s.readiness === 'READY' && s.durationProvenance === 'narration' && Math.abs(s.durationSeconds - 4) < 0.15, JSON.stringify({ r: s.readiness, d: s.durationSeconds, p: s.durationProvenance }));
  check('narrator-only does NOT require supplied video', s.suppliedClip.state === 'MISSING' && s.renderMode === 'LOCAL_SYNTHESIS', JSON.stringify(s.renderMode));
}

// ---- 23. character missing / invalid ----
{
  const s = await inspectSceneState(scene({ scene_number: 2, character_tags: ['@CHAR-02-MOHAN'], narration_text: 'x' }), S);
  check('missing character asset -> WAITING_FOR_CHARACTER_ASSET', s.readiness === 'WAITING_FOR_CHARACTER_ASSET', JSON.stringify(s.readiness));
}
put('characters', 'CHAR-03-GEETA.png', (() => { const b = makePng(1024, 1024, 6); b[25] = 2; return b; })()); // opaque
{
  const s = await inspectSceneState(scene({ scene_number: 3, character_tags: ['@CHAR-03-GEETA'], narration_text: 'x' }), S);
  check('opaque character -> INVALID (NO_ALPHA)', s.readiness === 'INVALID' && s.characters[0].state === 'INVALID', JSON.stringify(s.characters));
}

// ---- 25. dialogue-only without video ----
{
  const s = await inspectSceneState(scene({ scene_number: 4, speaker: '@CHAR-01-ARJUN', narration_text: '', devanagari_dialogue: 'x' }), S);
  check('dialogue-only without clip -> WAITING_FOR_VIDEO_CLIP (no local dialogue audio)', s.readiness === 'WAITING_FOR_VIDEO_CLIP' && s.reasons.includes('NO_LOCAL_DIALOGUE_AUDIO') && s.renderMode === 'NONE', JSON.stringify({ r: s.readiness, m: s.renderMode }));
}

// ---- 26. supplied video override ----
const clip = path.join(root, 'flow-clips', 'scene-0005.mp4');
await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=6', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
{
  const s = await inspectSceneState(scene({ scene_number: 5, speaker: '@CHAR-01-ARJUN', narration_text: '', devanagari_dialogue: 'x' }), S);
  check('supplied clip -> READY with SUPPLIED_VIDEO and clip duration', s.readiness === 'READY' && s.renderMode === 'SUPPLIED_VIDEO' && s.durationProvenance === 'supplied-video' && Math.abs(s.durationSeconds - 6) < 0.3, JSON.stringify({ r: s.readiness, m: s.renderMode, d: s.durationSeconds }));
  check('supplied clip overrides local synthesis even with assets present', s.renderMode === 'SUPPLIED_VIDEO');
}

// ---- 21. "AUTO..." and generator "8s" never become duration ----
{
  const s = await inspectSceneState(scene({ scene_number: 6, character_tags: [], speaker: 'none', narration_text: 'x', clip_length_seconds: null, edit_length_seconds: null, timestamp: 'AUTO — determined by the completed Flow clip' }), S);
  check('"AUTO — determined by the completed Flow clip" never becomes duration', s.durationSeconds === null || s.durationProvenance === 'narration', JSON.stringify({ d: s.durationSeconds, p: s.durationProvenance }));
  const s2 = await inspectSceneState(scene({ scene_number: 7, character_tags: [], speaker: 'none', narration_text: '', clip_length_seconds: null, edit_length_seconds: null }), S);
  check('generator "8s" setting is never used as duration', s2.durationSeconds !== 8 && s2.durationSeconds !== 5);
}

// ---- 20. duration precedence ----
{
  const a = await inspectSceneState(scene({ scene_number: 8, clip_length_seconds: 9 }), S);
  check('precedence: numeric clip_length_seconds -> pipeline', a.durationSeconds === 9 && a.durationProvenance === 'pipeline');
  const b = await inspectSceneState(scene({ scene_number: 9, edit_length_seconds: 7, clip_length_seconds: 9 }), S);
  check('precedence: edit_length_seconds beats clip_length_seconds', b.durationSeconds === 7 && b.durationProvenance === 'pipeline');
  const c = await inspectSceneState(scene({ scene_number: 10, clip_length_seconds: 0 }), S);
  check('zero/negative durations rejected', c.durationProvenance !== 'pipeline');
}

// ---- 22. mixed duration conflict ----
{
  const mixedClip = path.join(root, 'flow-clips', 'scene-0011.mp4');
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=2', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mixedClip]);
  wav(path.join(root, 'narration', 'narration-0011.wav'), 30); // 2s clip vs 30s narration = 15x, far beyond the 2.0x bound
  const s = await inspectSceneState(scene({ scene_number: 11, speaker: '@CHAR-01-ARJUN', narration_text: 'x', devanagari_dialogue: 'y' }), S);
  check('mixed scene: narration needing >2.0x stretch -> DURATION_CONFLICT + INVALID', s.readiness === 'INVALID' && s.reasons.includes('DURATION_CONFLICT'), JSON.stringify({ r: s.readiness, reasons: s.reasons }));
  check('over-limit scene reports the failing stretch factor and withinLimit=false',
    s.narrationPreservation?.withinLimit === false && (s.narrationPreservation?.stretchFactor ?? 0) > 2, JSON.stringify(s.narrationPreservation));
}

// ---- 22b. narration-preservation policy: MIXED within the bound stays READY ----
{
  // The Scene 15 shape: an 8s supplied clip whose narration runs 12.76s. The required picture
  // length is 13.01s, i.e. a 1.62625x slowdown - inside the 2.0x bound - so narration must be
  // preserved by slowing the PICTURE rather than by cutting words or failing the scene.
  const clip = path.join(root, 'flow-clips', 'scene-0015.mp4');
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=8', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
  wav(path.join(root, 'narration', 'narration-0015.wav'), 12.76);
  const s = await inspectSceneState(scene({ scene_number: 15, speaker: '@CHAR-04-DADI', character_tags: ['@CHAR-01-ARJUN'], narration_text: 'x', devanagari_dialogue: 'y' }), S);
  check('MIXED within the stretch bound: NO DURATION_CONFLICT', !s.reasons.includes('DURATION_CONFLICT'), JSON.stringify({ r: s.readiness, reasons: s.reasons }));
  check('MIXED within the stretch bound: readiness is READY', s.readiness === 'READY', JSON.stringify({ r: s.readiness, reasons: s.reasons }));
  check('MIXED within the stretch bound: render_mode is SUPPLIED_VIDEO', s.renderMode === 'SUPPLIED_VIDEO', s.renderMode);
  // The authoritative SOURCE duration semantics must be untouched by this policy.
  check('MIXED within the bound: durationSeconds stays the SOURCE clip length (8s)', s.durationSeconds === 8, s.durationSeconds);
  check('MIXED within the bound: durationProvenance stays supplied-video', s.durationProvenance === 'supplied-video', s.durationProvenance);
  // The assembled length is reported as a diagnostic only.
  const np = s.narrationPreservation;
  check('MIXED within the bound: narrationPreservation reports requiredOutputDuration 13.01', Math.abs((np?.requiredOutputDuration ?? 0) - 13.01) < 0.02, JSON.stringify(np));
  check('MIXED within the bound: narrationPreservation reports stretch ~1.626x within limit',
    Math.abs((np?.stretchFactor ?? 0) - 1.62625) < 0.005 && np?.withinLimit === true, JSON.stringify(np));
  check('MIXED within the bound: policy is NARRATION_EXCEEDS_CLIP_WITHIN_LIMIT', np?.policy === 'NARRATION_EXCEEDS_CLIP_WITHIN_LIMIT', np?.policy);
}

// ---- 22c. the bound is inclusive and fail-closed just above it ----
{
  // 2.0x of 8s = 16.0s required => 15.75s narration: exactly at the bound, allowed.
  const atClip = path.join(root, 'flow-clips', 'scene-0021.mp4');
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=8', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', atClip]);
  wav(path.join(root, 'narration', 'narration-0021.wav'), 15.75);
  const at = await inspectSceneState(scene({ scene_number: 21, speaker: '@CHAR-01-ARJUN', narration_text: 'x', devanagari_dialogue: 'y' }), S);
  check('exactly 2.0x is ALLOWED (READY, no DURATION_CONFLICT)', at.readiness === 'READY' && !at.reasons.includes('DURATION_CONFLICT'), JSON.stringify({ r: at.readiness, reasons: at.reasons }));
  check('exactly 2.0x reports withinLimit true', at.narrationPreservation?.withinLimit === true, JSON.stringify(at.narrationPreservation));

  // 15.751s narration needs 2.0002x: just over, must fail closed. This scene needs its own 8s
  // supplied clip, otherwise it would fall back to LOCAL_SYNTHESIS under ALLOW_LOCAL and never
  // reach the duration gate at all.
  const overClip = path.join(root, 'flow-clips', 'scene-0022.mp4');
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=8', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', overClip]);
  wav(path.join(root, 'narration', 'narration-0022.wav'), 15.751);
  const over = await inspectSceneState(scene({ scene_number: 22, speaker: '@CHAR-01-ARJUN', narration_text: 'x', devanagari_dialogue: 'y' }), S);
  check('just over 2.0x FAILS CLOSED with DURATION_CONFLICT + INVALID',
    over.readiness === 'INVALID' && over.reasons.includes('DURATION_CONFLICT'), JSON.stringify({ r: over.readiness, reasons: over.reasons }));
  check('just over 2.0x reports withinLimit false', over.narrationPreservation?.withinLimit === false, JSON.stringify(over.narrationPreservation));
}

// ---- 22d. the policy does NOT loosen other duration protections ----
{
  // A MIXED scene with narration present but no narration ASSET must still wait for narration: the
  // policy never invents either a clip or a voice, and must not reach the duration gate at all.
  wav(path.join(root, 'narration', 'narration-0023.wav'), 12.76);
  const missing = await inspectSceneState(scene({ scene_number: 23, speaker: '@CHAR-01-ARJUN', narration_text: 'x', devanagari_dialogue: 'y' }), S);
  // Under this suite's ALLOW_LOCAL policy a clip-less MIXED scene still falls back to
  // LOCAL_SYNTHESIS (pre-existing behaviour, unrelated to this policy). What matters is that the
  // narration-preservation policy did NOT fabricate a supplied clip or extend anything.
  check('MIXED with no supplied clip is not rescued into SUPPLIED_VIDEO by the policy',
    missing.renderMode !== 'SUPPLIED_VIDEO', JSON.stringify({ m: missing.renderMode, r: missing.readiness, reasons: missing.reasons }));
  check('MIXED with no supplied clip reports no narrationPreservation decision',
    missing.narrationPreservation === undefined, JSON.stringify(missing.narrationPreservation));

  // NARRATOR_ONLY scenes were never subject to DURATION_CONFLICT and must stay that way.
  const narrOnly = path.join(root, 'flow-clips', 'scene-0002.mp4');
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=8', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', narrOnly]);
  wav(path.join(root, 'narration', 'narration-0002.wav'), 19.12);
  const n = await inspectSceneState(scene({ scene_number: 2, speaker: 'NARRATOR', narration_text: 'x', devanagari_dialogue: '' }), S);
  check('NARRATOR_ONLY is still exempt from DURATION_CONFLICT (unchanged)', !n.reasons.includes('DURATION_CONFLICT'), JSON.stringify({ r: n.readiness, reasons: n.reasons }));
  check('NARRATOR_ONLY still reports READY', n.readiness === 'READY', JSON.stringify({ r: n.readiness, reasons: n.reasons }));

  // Non-positive durations remain rejected (case 21 above).
}

// ---- 28/29/30. render key determinism + sensitivity + purity ----
{
  const k1 = computeRenderKey({ sceneNumber: 1, narration: 'NARRATOR_ONLY', renderMode: 'LOCAL_SYNTHESIS', durationSeconds: 4, backgroundSha: 'a', characterShas: ['b'], narrationSha: 'c', clipSha: null, sceneDefinition: 'def' });
  const k2 = computeRenderKey({ sceneNumber: 1, narration: 'NARRATOR_ONLY', renderMode: 'LOCAL_SYNTHESIS', durationSeconds: 4, backgroundSha: 'a', characterShas: ['b'], narrationSha: 'c', clipSha: null, sceneDefinition: 'def' });
  check('deterministic render key (same inputs -> same key)', k1 === k2 && /^[0-9a-f]{64}$/.test(k1));
  const k3 = computeRenderKey({ sceneNumber: 1, narration: 'NARRATOR_ONLY', renderMode: 'LOCAL_SYNTHESIS', durationSeconds: 4, backgroundSha: 'a', characterShas: ['b'], narrationSha: 'DIFFERENT', clipSha: null, sceneDefinition: 'def' });
  check('changed input -> different render key', k3 !== k1);
  const kNoAbs = computeRenderKey({ sceneNumber: 1, narration: 'NARRATOR_ONLY', renderMode: 'LOCAL_SYNTHESIS', durationSeconds: 4, backgroundSha: '/abs/path/bg.png', characterShas: [], narrationSha: null, clipSha: null, sceneDefinition: 'def' });
  // The key is a hash; it must never embed literal paths.
  check('render key never contains absolute paths', !/[A-Za-z]:\\|\/Users\/|C:\//.test(kNoAbs));
  check('renderer contract version is a constant string', typeof RENDERER_CONTRACT_VERSION === 'string' && RENDERER_CONTRACT_VERSION.length > 0);
}

// ---- input immutability ----
{
  const sc = scene({ scene_number: 1 });
  const snap = JSON.stringify(sc);
  await inspectSceneState(sc, S);
  check('inspectSceneState never mutates the scene', JSON.stringify(sc) === snap);
}

// ---- no network / no writes ----
const srcText = fs.readFileSync(`${SRC}/sceneState.ts`, 'utf8');
check('sceneState performs no network I/O', !/fetch\(|XMLHttpRequest|https?:\/\//.test(srcText));
check('sceneState never writes files', !/writeFile|createWriteStream|rename\(|mkdir/.test(srcText));
check('sceneState has no Flow/Chrome dependency', !/playwright|FlowClient|chrome/i.test(srcText));
check('sceneState reuses existing validators (no duplicated rules)', /getCharacterAsset/.test(srcText) && /readPngDimensions/.test(srcText) && /resolveSceneNarrationDuration/.test(srcText) && /validateVideoClip/.test(srcText));

console.log(`\nSCENE-STATE TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
