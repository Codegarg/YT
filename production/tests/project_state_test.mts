// Offline project-state + renderMode tests (STEP-8DF). Temp dirs only. No Flow/Chrome.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);

import { SRC } from './_testPaths.mjs';
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;

const ps = await import(pathToFileURL(`${SRC}/projectState.ts`).href);
const sr = await import(pathToFileURL(`${SRC}/sceneRenderer.ts`).href);
const { deriveProjectState, toProjectStateRecord, saveProjectState, loadProjectState, projectStatePath, isLegalTransition, assertLegalTransition, classifySceneOutput, recordedKeysFrom, safeOutputPath, PROJECT_STATE_SCHEMA_VERSION } = ps;
const { renderScene, probeSceneOutput } = sr;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

function makePng(w: number, h: number, ct = 6): Buffer {
  const T: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct;
  const ch = ct === 6 ? 4 : 2; const raw = Buffer.alloc(h * (1 + w * ch), 0x80);
  for (let _y = 0; _y < h; _y++) raw[_y * (1 + w * ch)] = 0; // filter byte = None
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const wav = (file: string, sec: number, rate = 8000) => { const n = Math.round(sec * rate); const data = Buffer.alloc(n * 2); const b = Buffer.alloc(44 + data.length); b.write('RIFF', 0); b.writeUInt32LE(36 + data.length, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(data.length, 40); fs.writeFileSync(file, b); };

const PID = 'proj-8df';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8df-'));
const INPUTS = path.join(tmp, 'inputs');
const root = path.join(INPUTS, PID);
const OUT = path.join(tmp, 'outputs', PID);
for (const c of ['characters', 'narration', 'flow-clips', 'backgrounds', 'music']) fs.mkdirSync(path.join(root, c), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(root, 'backgrounds', 'BGD-01.png'), makePng(1920, 1080, 2));
fs.writeFileSync(path.join(root, 'characters', 'CHAR-01-ARJUN.png'), makePng(1024, 1024, 6));
wav(path.join(root, 'narration', 'narration-0001.wav'), 4);
wav(path.join(root, 'narration', 'narration-0002.wav'), 4);
// STRICT local-synthesis policy: EVERY scene requires a valid supplied clip, so the character scene 1
// AND the background-only scene 2 both get one (SUPPLIED_VIDEO). Character identity stays in the
// fixture, and a character change still moves that scene's render key via the existing `chars:` input.
for (const n of [1, 2]) {
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    path.join(root, 'flow-clips', `scene-000${n}.mp4`)]);
}

const pipeline = {
  project_id: PID, characters: [{ tag: '@CHAR-01-ARJUN' }], backgrounds: [{ tag: '#BGD-01' }],
  scenes: [
    { scene_number: 1, title: 'A', background_tag: '#BGD-01', character_tags: ['@CHAR-01-ARJUN'], speaker: 'NARRATOR', camera: 'Wide', visual_action: 'x', effects: '', narration_text: 'क', devanagari_dialogue: '', clip_length_seconds: null, edit_length_seconds: null },
    { scene_number: 2, title: 'B', background_tag: '#BGD-01', character_tags: [], speaker: 'NARRATOR', camera: 'Wide', visual_action: 'x', effects: '', narration_text: 'क', devanagari_dialogue: '', clip_length_seconds: null, edit_length_seconds: null },
  ],
};
const D = { pipeline, inputRoot: root, outputsDir: OUT };

// ---- 12/13. all ready / waiting ----
{
  const d = await deriveProjectState(D);
  check('all scenes ready -> READY_FOR_RENDER (no outputs yet)', d.state === 'READY_FOR_RENDER' && d.counts.ready === 2, JSON.stringify({ state: d.state, counts: d.counts }));
}
{
  // Under STRICT a missing supplied clip is the blocker for any scene type, so a background-only
  // scene with no clip reports as waiting for its clip rather than for its narrator file.
  // (WAITING_FOR_NARRATION is reachable only under the ALLOW_LOCAL dev/emergency opt-in.)
  const clip2 = path.join(root, 'flow-clips', 'scene-0002.mp4');
  fs.rmSync(path.join(root, 'narration', 'narration-0002.wav'));
  fs.rmSync(clip2);
  const d = await deriveProjectState(D);
  check('missing scene input -> WAITING_FOR_INPUTS', d.state === 'WAITING_FOR_INPUTS' && d.counts.waitingVideo === 1 && d.counts.invalid === 0, JSON.stringify({ s: d.state, c: d.counts }));
  wav(path.join(root, 'narration', 'narration-0002.wav'), 4);
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip2]);
}
{
  // invalid character: opaque
  const op = makePng(1024, 1024, 6); op[25] = 2;
  fs.renameSync(path.join(root, 'characters', 'CHAR-01-ARJUN.png'), path.join(tmp, 'keep.png'));
  fs.writeFileSync(path.join(root, 'characters', 'CHAR-01-ARJUN.png'), op);
  const d = await deriveProjectState(D);
  // Only scene 1 references CHAR-01-ARJUN (scene 2 is background-only), so exactly one scene is invalid.
  check('invalid scene input -> INPUTS_INVALID', d.state === 'INPUTS_INVALID' && d.counts.invalid === 1, JSON.stringify({ s: d.state, c: d.counts }));
  fs.rmSync(path.join(root, 'characters', 'CHAR-01-ARJUN.png'));
  fs.renameSync(path.join(tmp, 'keep.png'), path.join(root, 'characters', 'CHAR-01-ARJUN.png'));
}

// ---- 15/16/17/18/19. output classification ----
{
  // derive to get render keys
  const d = await deriveProjectState(D);
  const key1 = d.scenes[0].inspection.renderKey;
  // valid output present but no recorded key -> STALE_UNKNOWN
  const out1 = path.join(OUT, 'scene-0001.mp4');
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=4', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out1]);
  const cUnknown = await classifySceneOutput({ sceneNumber: 1, outputsDir: OUT, currentRenderKey: key1 });
  check('output with no recorded key -> STALE_UNKNOWN', cUnknown.outputState === 'STALE_UNKNOWN', cUnknown.outputState);
  const cCurrent = await classifySceneOutput({ sceneNumber: 1, outputsDir: OUT, currentRenderKey: key1, recorded: { render_key: key1 } });
  check('matching render key + valid output -> CURRENT', cCurrent.outputState === 'CURRENT', cCurrent.outputState);
  const cStale = await classifySceneOutput({ sceneNumber: 1, outputsDir: OUT, currentRenderKey: key1, recorded: { render_key: 'different' } });
  check('changed render key -> STALE', cStale.outputState === 'STALE');
  const cHash = await classifySceneOutput({ sceneNumber: 1, outputsDir: OUT, currentRenderKey: key1, recorded: { render_key: key1, output_hash: 'deadbeef' } });
  check('output hash mismatch -> INVALID_OUTPUT', cHash.outputState === 'INVALID_OUTPUT');
  const cMissing = await classifySceneOutput({ sceneNumber: 2, outputsDir: OUT, currentRenderKey: key1 });
  check('missing output -> MISSING_OUTPUT', cMissing.outputState === 'MISSING_OUTPUT');
  // invalid output media
  fs.writeFileSync(path.join(OUT, 'scene-0002.mp4'), Buffer.from('not a video at all, but long enough to look like something'));
  const cInvalid = await classifySceneOutput({ sceneNumber: 2, outputsDir: OUT, currentRenderKey: key1, recorded: { render_key: key1 } });
  check('unreadable output -> INVALID_OUTPUT', cInvalid.outputState === 'INVALID_OUTPUT');
  fs.rmSync(path.join(OUT, 'scene-0002.mp4'));
}

// ---- 1-4. state loading ----
{
  const d = await deriveProjectState(D);
  const rec = toProjectStateRecord(PID, d, d.state === 'RENDERED' ? { edit_state: 'NOT_STARTED', mix_state: 'NOT_STARTED', bed_state: 'NOT_STARTED', title_state: 'NOT_STARTED', output_path: null, output_hash: null } : { edit_state: 'NOT_STARTED', mix_state: 'NOT_STARTED', bed_state: 'NOT_STARTED', title_state: 'NOT_STARTED', output_path: null, output_hash: null });
  const file = await saveProjectState(PID, rec, path.join(tmp, 'outputs'));
  check('missing state -> derive (load of absent returns null)', (await loadProjectState('no-such', path.join(tmp, 'outputs'))) === null);
  const loaded = await loadProjectState(PID, path.join(tmp, 'outputs'));
  check('valid state loads back', loaded !== null && loaded.project_id === PID && loaded.schema_version === PROJECT_STATE_SCHEMA_VERSION);
  check('atomic write leaves no temp file', !fs.readdirSync(OUT).some((f) => f.includes('.tmp')));
  fs.writeFileSync(file, '{ broken');
  check('malformed state ignored (null)', (await loadProjectState(PID, path.join(tmp, 'outputs'))) === null);
  fs.writeFileSync(file, JSON.stringify({ ...rec, schema_version: 99 }));
  check('wrong schema ignored (null)', (await loadProjectState(PID, path.join(tmp, 'outputs'))) === null);
  fs.writeFileSync(file, JSON.stringify({ ...rec, project_id: 'other' }));
  check('wrong project id ignored (null)', (await loadProjectState(PID, path.join(tmp, 'outputs'))) === null);
  fs.rmSync(file);
}

// ---- 40/22. corrupt state cannot make an output appear CURRENT ----
{
  const d = await deriveProjectState(D);
  const key1 = d.scenes[0].inspection.renderKey;
  check('recordedKeysFrom(null) is empty (corrupt -> conservative)', recordedKeysFrom(null).size === 0);
  const rec = toProjectStateRecord(PID, d, { edit_state: 'NOT_STARTED', mix_state: 'NOT_STARTED', bed_state: 'NOT_STARTED', title_state: 'NOT_STARTED', output_path: null, output_hash: null });
  const tampered = { ...rec, renderer_contract_version: 'bogus-0' };
  check('contract-version mismatch -> no recorded keys (forces revalidation)', recordedKeysFrom(tampered as any).size === 0);
  void key1;
}

// ---- 7/8/9/10/11. transitions ----
check('legal: WAITING_FOR_INPUTS -> READY_FOR_RENDER', isLegalTransition('WAITING_FOR_INPUTS', 'READY_FOR_RENDER'));
check('legal: RENDERING -> RENDERED', isLegalTransition('RENDERING', 'RENDERED'));
check('legal: AWAITING_APPROVAL -> COMPLETED (human approval)', isLegalTransition('AWAITING_APPROVAL', 'COMPLETED'));
check('illegal: WAITING_FOR_INPUTS -> COMPLETED', isLegalTransition('WAITING_FOR_INPUTS', 'COMPLETED') === false);
check('illegal: READY_FOR_RENDER -> AWAITING_APPROVAL (cannot skip)', isLegalTransition('READY_FOR_RENDER', 'AWAITING_APPROVAL') === false);
check('COMPLETED is terminal', ps.LEGAL_TRANSITIONS.COMPLETED.length === 0);
check('FAILED can recover to active states', isLegalTransition('FAILED', 'READY_FOR_RENDER') && isLegalTransition('FAILED', 'RENDERING'));
check('rejection returns AWAITING_APPROVAL -> EDITING', isLegalTransition('AWAITING_APPROVAL', 'EDITING'));
check('assertLegalTransition throws on an illegal jump', (() => { try { assertLegalTransition('WAITING_FOR_INPUTS', 'RENDERING'); return false; } catch { return true; } })());
check('COMPLETED never derived without approval', (await (async () => {
  const d = await deriveProjectState({ ...D, approved: false, stages: { edit: true, mix: true, bed: true, title: true } });
  return d.state !== 'COMPLETED';
})()));

// ---- 14. all outputs current -> RENDERED ----
{
  const d0 = await deriveProjectState(D);
  const key1 = d0.scenes[0].inspection.renderKey, key2 = d0.scenes[1].inspection.renderKey;
  const rec = toProjectStateRecord(PID, d0, { edit_state: 'NOT_STARTED', mix_state: 'NOT_STARTED', bed_state: 'NOT_STARTED', title_state: 'NOT_STARTED', output_path: null, output_hash: null });
  const withKeys = { ...rec, scenes: { '1': { ...rec.scenes['1'], render_key: key1 }, '2': { ...rec.scenes['2'], render_key: key2 } } };
  // both outputs present + valid + matching keys
  const o2 = path.join(OUT, 'scene-0002.mp4');
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=4', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', o2]);
  const keys = recordedKeysFrom(withKeys);
  const d = await deriveProjectState({ ...D, recorded: keys });
  check('all outputs current -> RENDERED', d.state === 'RENDERED', JSON.stringify({ state: d.state, o: d.scenes.map((s) => s.outputState) }));
  // stale one -> READY_FOR_RENDER
  const d2 = await deriveProjectState({ ...D, recorded: new Map([[2, { render_key: 'wrong' }], [1, { render_key: key1 }]]) });
  check('stale output -> READY_FOR_RENDER', d2.state === 'READY_FOR_RENDER', d2.state);
}

// ---- 25/26/27. targeted invalidation ----
{
  const base = await deriveProjectState(D);
  const key1 = base.scenes[0].inspection.renderKey, key2 = base.scenes[1].inspection.renderKey;
  // change character -> only the scene that CITES it goes stale (scene 2 is background-only)
  const rec = toProjectStateRecord(PID, base, { edit_state: 'NOT_STARTED', mix_state: 'NOT_STARTED', bed_state: 'NOT_STARTED', title_state: 'NOT_STARTED', output_path: null, output_hash: null });
  const withKeys = { ...rec, scenes: { '1': { ...rec.scenes['1'], render_key: key1 }, '2': { ...rec.scenes['2'], render_key: key2 } } };
  const chg = makePng(1024, 1024, 6); chg.writeUInt32BE(0x11223344, 40);
  fs.writeFileSync(path.join(root, 'characters', 'CHAR-01-ARJUN.png'), chg);
  const after = await deriveProjectState({ ...D, recorded: recordedKeysFrom(withKeys) });
  check('changed character -> the dependent scene becomes STALE (independent scene untouched)',
    after.scenes[0].outputState === 'STALE' && after.scenes[1].outputState === 'CURRENT',
    JSON.stringify(after.scenes.map((s) => s.outputState)));
  check('render key changes when a character changes', after.scenes[0].inspection.renderKey !== key1);
  // restore
  fs.writeFileSync(path.join(root, 'characters', 'CHAR-01-ARJUN.png'), makePng(1024, 1024, 6));
}

// ---- 20/28. unchanged key -> CURRENT ; BGM does not invalidate clips ----
{
  const d = await deriveProjectState(D);
  const rec = toProjectStateRecord(PID, d, { edit_state: 'NOT_STARTED', mix_state: 'NOT_STARTED', bed_state: 'NOT_STARTED', title_state: 'NOT_STARTED', output_path: null, output_hash: null });
  const keys = recordedKeysFrom(rec);
  const again = await deriveProjectState({ ...D, recorded: keys });
  check('unchanged inputs -> render keys stable', again.scenes[0].inspection.renderKey === d.scenes[0].inspection.renderKey);
  // BGM change: scene render keys are BGM-independent
  fs.writeFileSync(path.join(root, 'music', 'background-music.mp3'), Buffer.from('fake-bgm'));
  const afterBgm = await deriveProjectState(D);
  check('changed BGM does not change any scene render key (clips stay CURRENT)', afterBgm.scenes.every((s, i) => s.inspection.renderKey === d.scenes[i].inspection.renderKey));
  fs.rmSync(path.join(root, 'music', 'background-music.mp3'));
}

// ---- 38/39. path safety ----
check('output path cannot escape the output root', (() => { try { safeOutputPath(OUT, '../evil.mp4'); return false; } catch { return true; } })());
check('state path stays inside the outputs root', path.dirname(projectStatePath(PID, path.join(tmp, 'outputs'))) === path.resolve(tmp, 'outputs', PID));
check('state path rejects a traversal project id', (() => { try { projectStatePath('../evil', path.join(tmp, 'outputs')); return false; } catch { return true; } })());

// ---- 29-37. render modes (real renders) ----
const bg = path.join(root, 'backgrounds', 'BGD-01.png');
const renderDir = path.join(tmp, 'renders');
{
  const local = await renderScene({ sceneNumber: 1, backgroundImagePath: bg, durationSeconds: 3, motion: 'STATIC', mode: 'background-only' }, { outputDir: renderDir });
  check('29. LOCAL_SYNTHESIS preserves existing behaviour', local.ok === true && local.renderMode === 'LOCAL_SYNTHESIS' && local.suppliedVideoReused === false, JSON.stringify(local));
}
const clipDir = path.join(root, 'flow-clips');
const goodClip = path.join(clipDir, 'scene-0002.mp4');
await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=4', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', goodClip]);
{
  const sup = await renderScene({ sceneNumber: 2, backgroundImagePath: bg, durationSeconds: 4, mode: 'background-only', renderMode: 'SUPPLIED_VIDEO', suppliedClipPath: goodClip }, { outputDir: renderDir });
  check('30. SUPPLIED_VIDEO valid input accepted', sup.ok === true && sup.renderMode === 'SUPPLIED_VIDEO', JSON.stringify(sup));
  check('37. supplied video reused deterministically (byte-identical when already perfect)', sup.ok && sup.suppliedVideoReused === true);
  if (sup.ok) {
    const p = await probeSceneOutput(sup.outputPath);
    check('36. supplied video preserves the audio contract', p.video && p.audio && p.durationSeconds > 0, JSON.stringify(p));
  }
}
{
  const badClip = path.join(clipDir, 'scene-0003.mp4'); fs.writeFileSync(badClip, Buffer.from('garbage video bytes that are not a real mp4 at all'));
  const bad = await renderScene({ sceneNumber: 3, backgroundImagePath: bg, durationSeconds: 4, mode: 'background-only', renderMode: 'SUPPLIED_VIDEO', suppliedClipPath: badClip }, { outputDir: renderDir });
  check('31. SUPPLIED_VIDEO invalid input rejected', bad.ok === false && bad.code === 'SUPPLIED_VIDEO_INVALID', JSON.stringify(bad));
  const auto = await renderScene({ sceneNumber: 3, backgroundImagePath: bg, durationSeconds: 4, mode: 'background-only', renderMode: 'AUTO', suppliedClipPath: badClip }, { outputDir: renderDir });
  check('34. AUTO does not hide an invalid supplied video', auto.ok === false && auto.code === 'SUPPLIED_VIDEO_INVALID', JSON.stringify(auto));
}
{
  const auto = await renderScene({ sceneNumber: 4, backgroundImagePath: bg, durationSeconds: 4, mode: 'background-only', renderMode: 'AUTO', suppliedClipPath: goodClip }, { outputDir: renderDir });
  check('32. AUTO chooses supplied video when valid', auto.ok === true && auto.renderMode === 'SUPPLIED_VIDEO', JSON.stringify(auto));
  const autoLocal = await renderScene({ sceneNumber: 5, backgroundImagePath: bg, durationSeconds: 4, mode: 'background-only', renderMode: 'AUTO', suppliedClipPath: path.join(clipDir, 'scene-0099.mp4') }, { outputDir: renderDir });
  check('33. AUTO chooses local synthesis when no supplied clip', autoLocal.ok === true && autoLocal.renderMode === 'LOCAL_SYNTHESIS', JSON.stringify(autoLocal));
}
{
  const sup = await renderScene({ sceneNumber: 6, backgroundImagePath: bg, durationSeconds: 4, mode: 'background-only', renderMode: 'SUPPLIED_VIDEO' }, { outputDir: renderDir });
  check('SUPPLIED_VIDEO without a path fails closed', sup.ok === false && sup.code === 'SUPPLIED_VIDEO_UNAVAILABLE');
  const noDur = await renderScene({ sceneNumber: 7, backgroundImagePath: bg, durationSeconds: undefined as any, mode: 'background-only' }, { outputDir: renderDir });
  check('35. unresolved duration rejected', noDur.ok === false && noDur.code === 'DURATION_UNRESOLVED', JSON.stringify(noDur));
}

const srcText = fs.readFileSync(`${SRC}/projectState.ts`, 'utf8');
const srcCode = srcText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
check('projectState performs no network I/O', !/fetch\(|XMLHttpRequest|https?:\/\//.test(srcCode));
check('projectState has no Flow/Chrome dependency', !/playwright|FlowClient|chrome/i.test(srcCode));
check('projectState never writes pipeline.json', !/pipeline\.json/.test(srcCode));

console.log(`\nPROJECT-STATE TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
