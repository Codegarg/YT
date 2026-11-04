// Focused OFFLINE tests for the STRICT / ALLOW_LOCAL local-synthesis production policy.
//
// POLICY UNDER TEST: under the default STRICT policy EVERY scene requires a valid supplied
// (Google Flow) video clip -- character scenes AND background-only scenes alike. Without one a scene
// fails closed: renderMode NONE, readiness WAITING_FOR_VIDEO_CLIP, reason SUPPLIED_VIDEO_REQUIRED.
// LOCAL_SYNTHESIS is NEVER selected by default production inspection. A valid supplied clip always
// wins (SUPPLIED_VIDEO / READY). ALLOW_LOCAL is an explicit opt-in only and is deliberately not
// reachable from the CLI/orchestrator. Synthetic temp fixtures only. No Flow/Chrome/network/credits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { REPO } from './_testPaths.mjs';
const SRC = `${REPO}/production/src`;
import { FF as FFBIN } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FFBIN}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FFBIN}/ffprobe.exe`;
process.env.PATH = `${FFBIN};${process.env.PATH}`;
const exec = promisify(execFile);

const { inspectSceneState, resolveLocalSynthesisPolicy } = await import(pathToFileURL(`${SRC}/sceneState.ts`).href);
const orch = await import(pathToFileURL(`${SRC}/productionOrchestrator.ts`).href);
const { createRealSceneExecutor, decideRenderDispatch } = await import(pathToFileURL(`${SRC}/sceneExecutorAdapter.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

// ---------- synthetic assets ----------
const CRC: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; }
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function makePng(w: number, h: number, colourType: 2 | 6, alphaDisc = false) {
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(body), 0); return Buffer.concat([l, body, c]); };
  const bpp = colourType === 6 ? 4 : 3;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = colourType;
  const raw = Buffer.alloc(h * (1 + w * bpp));
  const cx = w / 2, cy = h / 2, rMax = Math.min(w, h) / 2;
  for (let y = 0; y < h; y++) {
    const rs = y * (1 + w * bpp); raw[rs] = 0;
    for (let x = 0; x < w; x++) {
      const p = rs + 1 + x * bpp;
      raw[p] = (x * 7) % 256; raw[p + 1] = (y * 11) % 256; raw[p + 2] = 90;
      if (bpp === 4) {
        // characterAsset requires a GENUINELY transparent pixel: opaque disc, transparent surround.
        raw[p + 3] = alphaDisc && Math.hypot(x - cx, y - cy) <= rMax * 0.8 ? 255 : (alphaDisc ? 0 : 255);
      }
    }
  }
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const wav = (f: string, sec: number) => { const n = Math.round(sec * 8000); const d = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) d.writeInt16LE(Math.round(3000 * Math.sin(i / 12)), i * 2); const b = Buffer.alloc(44 + d.length); b.write('RIFF',0); b.writeUInt32LE(36+d.length,4); b.write('WAVE',8); b.write('fmt ',12); b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(8000,24); b.writeUInt32LE(16000,28); b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(d.length,40); d.copy(b,44); fs.writeFileSync(f,b); };
// The colour source must be `dur` seconds long: `-shortest` ends the output at the shortest input,
// so a `d=1` source paired with `-t ${dur}` silently produced a 1s clip REGARDLESS of `dur`. That
// made these clips 1s against 3s narration — a 3.25x ratio, far outside the 2.0x narration-
// preservation bound — which is now (correctly) rejected at readiness for a NARRATOR_ONLY scene.
// `dur` is honoured here so the fixture matches the geometry it always intended.
const mkClip = async (o: string, dur = 3) => { await exec(process.env.FFMPEG_PATH!, ['-y','-f','lavfi','-i',`color=c=0x203040:s=1280x720:d=${dur}`,'-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000','-t',String(dur),'-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',o]); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-'));
const PID = 'policy-fixture';
const inputRoot = path.join(tmp, 'inputs', PID);
const outputsRoot = path.join(tmp, 'outputs');
const outputsDir = path.join(outputsRoot, PID);
for (const d of ['backgrounds','characters','narration','flow-clips']) fs.mkdirSync(path.join(inputRoot, d), { recursive: true });
fs.mkdirSync(outputsDir, { recursive: true });
fs.writeFileSync(path.join(inputRoot, 'backgrounds', 'BGD-01.png'), makePng(1280, 720, 2));
fs.writeFileSync(path.join(inputRoot, 'characters', 'CHAR-01.png'), makePng(1024, 1024, 6, true));
for (const n of [1, 2, 3, 4]) wav(path.join(inputRoot, 'narration', `narration-000${n}.wav`), 3);

const sceneChar = (n: number) => ({ scene_number: n, title: `S${n}`, background_tag: '#BGD-01', character_tags: ['@CHAR-01'], speaker: 'NARRATOR', camera: 'wide', visual_action: 'a', narration_text: 'x', devanagari_dialogue: '' });
const sceneBgOnly = (n: number) => ({ ...sceneChar(n), character_tags: [] as string[] });
const OPTS = { inputRoot, ffprobePath: process.env.FFPROBE_PATH } as any;

// ================= A: STRICT + character scene + no supplied clip =================
console.log('--- A: STRICT, character scene, no supplied clip ---');
{
  const s = await inspectSceneState(sceneChar(1), OPTS);
  check('A1 STRICT default: character scene renderMode is NONE', s.renderMode === 'NONE', s.renderMode);
  check('A2 STRICT default: character scene readiness is WAITING_FOR_VIDEO_CLIP', s.readiness === 'WAITING_FOR_VIDEO_CLIP', s.readiness);
  check('A3 STRICT default: character scene reasons include SUPPLIED_VIDEO_REQUIRED', s.reasons.includes('SUPPLIED_VIDEO_REQUIRED'), s.reasons);
  check('A4 character scene is NOT renderable (no local synthesis selected)', s.renderMode !== 'LOCAL_SYNTHESIS');

  // explicit STRICT is identical to the default
  const sExp = await inspectSceneState(sceneChar(1), { ...OPTS, localSynthesisPolicy: 'STRICT' });
  check('A5 explicit STRICT === default behaviour', sExp.renderMode === s.renderMode && sExp.readiness === s.readiness && sExp.renderKey === s.renderKey);
}

// ================= B: STRICT + background-only scene + no supplied clip =================
console.log('--- B: STRICT, background-only scene, no supplied clip ---');
{
  const bg = await inspectSceneState(sceneBgOnly(2), OPTS);
  check('B0 the fixture really is background-only (no character_tags)', bg.characterTags.length === 0, bg.characterTags);
  check('B0b its background asset is genuinely VALID', bg.background.state === 'VALID', bg.background.state);
  check('B0c its narration asset is genuinely VALID', bg.narrationAsset.state === 'VALID', bg.narrationAsset.state);
  check('B1 STRICT default: background-only scene renderMode is NONE', bg.renderMode === 'NONE', bg.renderMode);
  check('B2 STRICT default: background-only scene readiness is WAITING_FOR_VIDEO_CLIP', bg.readiness === 'WAITING_FOR_VIDEO_CLIP', bg.readiness);
  check('B3 STRICT default: background-only scene reasons include SUPPLIED_VIDEO_REQUIRED', bg.reasons.includes('SUPPLIED_VIDEO_REQUIRED'), bg.reasons);
  check('B4 background-only scene is NOT renderable (LOCAL_SYNTHESIS never selected)', bg.renderMode !== 'LOCAL_SYNTHESIS');
  check('B5 valid local background+narration assets do NOT make it READY', bg.readiness !== 'READY', bg.readiness);
  check('B6 valid local background+narration assets do NOT select a local mode', bg.renderMode !== 'LOCAL_SYNTHESIS' && bg.renderMode !== 'AUTO', bg.renderMode);
}

// ================= C: STRICT + valid supplied clip + character =================
console.log('--- C: STRICT, valid supplied clip, character scene ---');
await mkClip(path.join(inputRoot, 'flow-clips', 'scene-0003.mp4'), 3);
{
  const s = await inspectSceneState(sceneChar(3), OPTS);
  check('C1 STRICT + valid clip: renderMode SUPPLIED_VIDEO', s.renderMode === 'SUPPLIED_VIDEO', s.renderMode);
  check('C2 STRICT + valid clip: readiness READY', s.readiness === 'READY', s.readiness);
  check('C3 STRICT + valid clip: no SUPPLIED_VIDEO_REQUIRED reason', !s.reasons.includes('SUPPLIED_VIDEO_REQUIRED'), s.reasons);
  check('C4 STRICT + valid clip: supplied clip is VALID and recorded', s.suppliedClip.state === 'VALID' && !!s.suppliedClip.sha256, s.suppliedClip.state);
  check('C5 STRICT + valid clip: duration provenance is supplied-video', s.durationProvenance === 'supplied-video', s.durationProvenance);
  // the clip must not be downgraded because local assets exist
  const al = await inspectSceneState(sceneChar(3), { ...OPTS, localSynthesisPolicy: 'ALLOW_LOCAL' });
  check('C6 a valid clip wins under ALLOW_LOCAL too (never downgraded)', al.renderMode === 'SUPPLIED_VIDEO', al.renderMode);
}

// ================= D: STRICT + valid supplied clip + background-only =================
console.log('--- D: STRICT, valid supplied clip, background-only scene ---');
await mkClip(path.join(inputRoot, 'flow-clips', 'scene-0004.mp4'), 3);
{
  const s = await inspectSceneState(sceneBgOnly(4), OPTS);
  check('D1 STRICT + valid clip: background-only renderMode SUPPLIED_VIDEO', s.renderMode === 'SUPPLIED_VIDEO', s.renderMode);
  check('D2 STRICT + valid clip: background-only readiness READY', s.readiness === 'READY', s.readiness);
  check('D3 STRICT + valid clip: background-only has no SUPPLIED_VIDEO_REQUIRED', !s.reasons.includes('SUPPLIED_VIDEO_REQUIRED'), s.reasons);
  check('D4 STRICT + valid clip: background-only duration provenance is supplied-video', s.durationProvenance === 'supplied-video', s.durationProvenance);
  check('D5 STRICT + valid clip: background-only supplied clip is VALID', s.suppliedClip.state === 'VALID', s.suppliedClip.state);
}

// ================= E: ALLOW_LOCAL is an explicit opt-in only =================
console.log('--- E: ALLOW_LOCAL explicit opt-in ---');
{
  check('E1 unknown/absent policy values fail closed to STRICT',
    resolveLocalSynthesisPolicy(undefined) === 'STRICT' && resolveLocalSynthesisPolicy('NONSENSE') === 'STRICT'
    && resolveLocalSynthesisPolicy('strict') === 'STRICT' && resolveLocalSynthesisPolicy(null) === 'STRICT');
  check('E2 only the exact literal ALLOW_LOCAL opts out',
    resolveLocalSynthesisPolicy('ALLOW_LOCAL') === 'ALLOW_LOCAL' && resolveLocalSynthesisPolicy('allow_local') === 'STRICT'
    && resolveLocalSynthesisPolicy(true) === 'STRICT' && resolveLocalSynthesisPolicy(1) === 'STRICT');

  const al = await inspectSceneState(sceneChar(1), { ...OPTS, localSynthesisPolicy: 'ALLOW_LOCAL' });
  check('E3 ALLOW_LOCAL: character scene returns to LOCAL_SYNTHESIS', al.renderMode === 'LOCAL_SYNTHESIS', al.renderMode);
  check('E4 ALLOW_LOCAL: character scene readiness READY', al.readiness === 'READY', al.readiness);
  check('E5 ALLOW_LOCAL: no SUPPLIED_VIDEO_REQUIRED reason', !al.reasons.includes('SUPPLIED_VIDEO_REQUIRED'), al.reasons);

  const alBg = await inspectSceneState(sceneBgOnly(2), { ...OPTS, localSynthesisPolicy: 'ALLOW_LOCAL' });
  check('E6 ALLOW_LOCAL: background-only scene returns to LOCAL_SYNTHESIS', alBg.renderMode === 'LOCAL_SYNTHESIS', alBg.renderMode);
  check('E7 ALLOW_LOCAL: background-only scene readiness READY', alBg.readiness === 'READY', alBg.readiness);

  // an omitted option must behave exactly like STRICT (never fail open)
  const dflt = await inspectSceneState(sceneChar(1), OPTS);
  check('E8 omitting the option is identical to STRICT (cannot fail open by omission)',
    dflt.renderMode === 'NONE' && dflt.readiness === 'WAITING_FOR_VIDEO_CLIP', { mode: dflt.renderMode, ready: dflt.readiness });
}

// ================= F: repeated calls remain deterministic =================
console.log('--- F: determinism ---');
{
  const mk = async (scene: any) => {
    const a = await inspectSceneState(scene, OPTS);
    const b = await inspectSceneState(scene, OPTS);
    return a.renderMode === b.renderMode && a.readiness === b.readiness
      && JSON.stringify(a.reasons) === JSON.stringify(b.reasons) && a.renderKey === b.renderKey
      && a.durationSeconds === b.durationSeconds && a.renderKey === a.renderKey;
  };
  check('F1 repeated calls: character scene without a clip are identical', await mk(sceneChar(1)));
  check('F2 repeated calls: background-only scene without a clip are identical', await mk(sceneBgOnly(2)));
  check('F3 repeated calls: character scene with a clip are identical', await mk(sceneChar(3)));
  check('F4 repeated calls: background-only scene with a clip are identical', await mk(sceneBgOnly(4)));
  const ten = await Promise.all(Array.from({ length: 10 }, () => inspectSceneState(sceneChar(1), OPTS)));
  check('F5 ten concurrent inspections all agree',
    new Set(ten.map((x) => `${x.renderMode}|${x.readiness}|${x.renderKey}`)).size === 1);
}

// ================= G: no production path can silently fall back to LOCAL_SYNTHESIS =================
console.log('--- G: no silent LOCAL_SYNTHESIS fallback ---');
{
  const blockedChar = await inspectSceneState(sceneChar(1), OPTS);
  const blockedBg = await inspectSceneState(sceneBgOnly(2), OPTS);
  check('G1 blocked character scene dispatches to FAIL_CLOSED, never LOCAL_SYNTHESIS',
    decideRenderDispatch(blockedChar.renderMode).action === 'FAIL_CLOSED', decideRenderDispatch(blockedChar.renderMode));
  check('G2 blocked background-only scene dispatches to FAIL_CLOSED, never LOCAL_SYNTHESIS',
    decideRenderDispatch(blockedBg.renderMode).action === 'FAIL_CLOSED', decideRenderDispatch(blockedBg.renderMode));
  const reason = String((decideRenderDispatch(blockedChar.renderMode) as any).reason);
  check('G3 the fail-closed reason forbids Flow fallback / substitution',
    /refusing to fall back to Flow generation or substitute another asset/.test(reason), reason);

  // exhaustive sweep: no scene shape may yield LOCAL_SYNTHESIS under default STRICT
  const shapes: Array<[string, any]> = [
    ['character scene', sceneChar(1)],
    ['background-only scene', sceneBgOnly(2)],
    ['scene with no background_tag', { ...sceneBgOnly(2), background_tag: null }],
    ['scene with an unknown background tag', { ...sceneChar(1), background_tag: '#BGD-NOPE' }],
    ['scene with an unknown character tag', { ...sceneChar(1), character_tags: ['@CHAR-NOPE'] }],
    ['dialogue-only scene', { ...sceneBgOnly(2), speaker: '@CHAR-01', narration_text: '', devanagari_dialogue: 'डायलॉग' }],
  ];
  const leaked = [] as string[];
  for (const [label, scene] of shapes) {
    const r = await inspectSceneState(scene, OPTS);
    if (r.renderMode === 'LOCAL_SYNTHESIS') leaked.push(label);
  }
  check('G4 no scene shape yields LOCAL_SYNTHESIS under default STRICT', leaked.length === 0, leaked);
  check('G5 every blocked shape is WAITING_FOR_VIDEO_CLIP or INVALID (never READY)',
    shapes.every(([, sc]) => true) && (await Promise.all(shapes.map(async ([, sc]) => (await inspectSceneState(sc, OPTS)).readiness)))
      .every((rd) => rd === 'WAITING_FOR_VIDEO_CLIP' || rd === 'INVALID'),
    await Promise.all(shapes.map(async ([l, sc]) => `${l}=${(await inspectSceneState(sc, OPTS)).readiness}`)));

  // The executor itself refuses and writes nothing.
  const pipeline: any = { project_id: PID, backgrounds: [{ tag: '#BGD-01' }], characters: [{ tag: '@CHAR-01' }],
    scenes: [sceneChar(1), sceneBgOnly(2)] };
  const ex = createRealSceneExecutor({ projectId: PID, inputRoot, outputsRoot, pipeline, allowGeneration: false, ffprobePath: process.env.FFPROBE_PATH, ffmpegPath: process.env.FFMPEG_PATH });
  const outChar = path.join(outputsDir, 'scene-0001.mp4');
  const outBg = path.join(outputsDir, 'scene-0002.mp4');
  const resChar = await ex(blockedChar as any, outChar, { projectId: PID, inputRoot, outputsDir, width: 640, height: 360 });
  const resBg = await ex(blockedBg as any, outBg, { projectId: PID, inputRoot, outputsDir, width: 640, height: 360 });
  check('G6 the executor fails closed for a blocked character scene', resChar.ok === false && /not dispatchable/.test(String(resChar.reason)), resChar);
  check('G7 the executor fails closed for a blocked background-only scene', resBg.ok === false && /not dispatchable/.test(String(resBg.reason)), resBg);
  check('G8 no local scene output was fabricated for either blocked scene',
    !fs.existsSync(outChar) && !fs.existsSync(outBg));
}

// ================= H: renderer capability retained under ALLOW_LOCAL =================
console.log('--- H: dev/emergency renderer capability retained ---');
{
  const { renderScene } = await import(pathToFileURL(`${SRC}/sceneRenderer.ts`).href);
  const r = await renderScene(
    { sceneNumber: 1, backgroundImagePath: path.join(inputRoot, 'backgrounds', 'BGD-01.png'), durationSeconds: 2, motion: 'ZOOM_IN', width: 640, height: 360, mode: 'require-characters', renderMode: 'LOCAL_SYNTHESIS',
      characters: [{ characterTag: '@CHAR-01', assetPath: '', x: 10, y: 10, width: 100, height: 100, opacity: 1, zIndex: 0 }] },
    { outputDir: path.join(tmp, 'renderer-dev'), charactersDir: path.join(inputRoot, 'characters'), ffprobePath: process.env.FFPROBE_PATH, overwrite: true },
  );
  check('H1 renderer still supports character compositing (dev/emergency capability retained)', r.ok === true, r);
}

// ================= I: orchestrator behaviour end-to-end =================
console.log('--- I: orchestrator ---');
{
  // scene 1 = blocked character, scene 2 = blocked background-only, scene 3 = character with a clip.
  const pipeline: any = { project_id: PID, backgrounds: [{ tag: '#BGD-01' }], characters: [{ tag: '@CHAR-01' }],
    scenes: [sceneChar(1), sceneBgOnly(2), sceneChar(3)] };
  const outputsDir2 = path.join(outputsRoot, PID);
  const report = await orch.orchestrate({
    pipeline, projectId: PID, inputRoot, outputsDir: outputsDir2, outputsRoot,
    ffprobePath: process.env.FFPROBE_PATH, width: 640, height: 360,
    executor: createRealSceneExecutor({ projectId: PID, inputRoot, outputsRoot, pipeline, allowGeneration: false, ffprobePath: process.env.FFPROBE_PATH, ffmpegPath: process.env.FFMPEG_PATH }) as any,
  });
  const s1 = report.scenes.find((x: any) => x.sceneNumber === 1);
  const s2 = report.scenes.find((x: any) => x.sceneNumber === 2);
  const s3 = report.scenes.find((x: any) => x.sceneNumber === 3);
  console.log(`     state=${report.state} workSet=[${report.workSet}] failed=[${report.failedScenes}]`);
  check('I1 blocked character scene is EXCLUDED from the work set', !report.workSet.includes(1), report.workSet);
  check('I2 blocked character scene is reported WAITING_FOR_VIDEO_CLIP', s1?.readiness === 'WAITING_FOR_VIDEO_CLIP', s1?.readiness);
  check('I3 blocked character scene has renderMode NONE', s1?.renderMode === 'NONE', s1?.renderMode);
  check('I4 blocked BACKGROUND-ONLY scene is EXCLUDED from the work set', !report.workSet.includes(2), report.workSet);
  check('I5 blocked background-only scene is reported WAITING_FOR_VIDEO_CLIP', s2?.readiness === 'WAITING_FOR_VIDEO_CLIP', s2?.readiness);
  check('I6 blocked background-only scene has renderMode NONE', s2?.renderMode === 'NONE', s2?.renderMode);
  check('I7 project is WAITING_FOR_INPUTS, not FAILED', report.state === 'WAITING_FOR_INPUTS', report.state);
  check('I8 no scene failed during the run', report.failedScenes.length === 0, report.failedScenes);
  check('I9 no output fabricated for either blocked scene',
    !fs.existsSync(path.join(outputsDir2, 'scene-0001.mp4')) && !fs.existsSync(path.join(outputsDir2, 'scene-0002.mp4')));
  check('I10 supplied-clip scene stays SUPPLIED_VIDEO and is CURRENT', s3?.renderMode === 'SUPPLIED_VIDEO' && s3?.outputState === 'CURRENT', { mode: s3?.renderMode, state: s3?.outputState });
  check('I11 counts report both blocked scenes as waiting, none invalid', report.counts.invalid === 0 && report.counts.waitingVideo === 2, report.counts);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} local-synthesis policy checks passed (fully offline, temp fixtures only).`);