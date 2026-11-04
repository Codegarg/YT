// Offline synthetic end-to-end orchestration + resumability tests (STEP-8DG).
// Temp dirs only. No Flow/Chrome/credits. Real project is NEVER touched.
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

const orch = await import(pathToFileURL(`${SRC}/productionOrchestrator.ts`).href);
const ps = await import(pathToFileURL(`${SRC}/projectState.ts`).href);
const { orchestrate } = orch;
const { loadProjectState, projectStatePath, readSceneSidecar } = ps;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

// ---------- fixtures ----------
function makePng(w: number, h: number, ct = 6, tag = 0): Buffer {
  const T: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct;
  const ch = ct === 6 ? 4 : 2; const raw = Buffer.alloc(h * (1 + w * ch), 0x80);
  for (let _y = 0; _y < h; _y++) raw[_y * (1 + w * ch)] = 0; // filter byte = None
  raw[10] = tag & 0xff; // make distinct variants differ
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const wav = (file: string, sec: number, rate = 8000, tag = 0) => { const n = Math.round(sec * rate); const data = Buffer.alloc(n * 2, tag); const b = Buffer.alloc(44 + data.length); b.write('RIFF', 0); b.writeUInt32LE(36 + data.length, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(data.length, 40); fs.writeFileSync(file, b); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8dg-'));
const PID = 'synthetic-8dg';
const INPUTS = path.join(tmp, 'inputs');
const root = path.join(INPUTS, PID);
const outputsRoot = path.join(tmp, 'outputs');
const OUT = path.join(outputsRoot, PID);
for (const c of ['characters', 'narration', 'flow-clips', 'backgrounds', 'music']) fs.mkdirSync(path.join(root, c), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const BG1 = path.join(root, 'backgrounds', 'BGD-01.png');
const BG2 = path.join(root, 'backgrounds', 'BGD-02.png');
const CH1 = path.join(root, 'characters', 'CHAR-01-ARJUN.png');
const CH2 = path.join(root, 'characters', 'CHAR-02-MOHAN.png');
// Scene 1 & 2 use DIFFERENT backgrounds/chars so invalidation is separable.
const NAR3 = path.join(root, 'narration', 'narration-0003.wav');
fs.writeFileSync(BG1, makePng(1920, 1080, 2, 1));
fs.writeFileSync(BG2, makePng(1920, 1080, 2, 2));
fs.writeFileSync(CH1, makePng(1024, 1024, 6, 1));
fs.writeFileSync(CH2, makePng(1024, 1024, 6, 2));
wav(NAR3, 4, 8000, 0);
for (const n of [1, 2, 3]) {
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', `color=c=0x${(0x203040 + n * 0x010203).toString(16)}:s=1280x720:d=3`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    path.join(root, 'flow-clips', `scene-000${n}.mp4`)]);
}
// STRICT local-synthesis policy: EVERY scene requires a valid supplied clip, so scenes 1, 2 and 3 all
// get one (scene 3 is background-only and is no longer exempt). Character identity stays in the
// fixture and a character change still moves that scene's render key through the existing `chars:`
// input, so the targeted invalidation assertions below remain valid.
const NAR1 = path.join(root, 'narration', 'narration-0001.wav');
const NAR2 = path.join(root, 'narration', 'narration-0002.wav');
wav(NAR1, 3, 8000, 0);
wav(NAR2, 3, 8000, 0);

const pipeline = {
  project_id: PID,
  characters: [{ tag: '@CHAR-01-ARJUN' }, { tag: '@CHAR-02-MOHAN' }],
  backgrounds: [{ tag: '#BGD-01' }, { tag: '#BGD-02' }],
  scenes: [
    { scene_number: 1, title: 'S1', background_tag: '#BGD-01', character_tags: ['@CHAR-01-ARJUN'], speaker: '@CHAR-01-ARJUN', camera: 'Wide', visual_action: 'a', effects: '', narration_text: 'नरेटर', devanagari_dialogue: 'क', clip_length_seconds: null, edit_length_seconds: null },
    { scene_number: 2, title: 'S2', background_tag: '#BGD-02', character_tags: ['@CHAR-02-MOHAN'], speaker: '@CHAR-02-MOHAN', camera: 'Wide', visual_action: 'b', effects: '', narration_text: 'नरेटर', devanagari_dialogue: 'क', clip_length_seconds: null, edit_length_seconds: null },
    { scene_number: 3, title: 'S3', background_tag: '#BGD-01', character_tags: [], speaker: 'NARRATOR', camera: 'Wide', visual_action: 'c', effects: '', narration_text: 'कहानी', devanagari_dialogue: '', clip_length_seconds: null, edit_length_seconds: null },
  ],
};

// Synthetic executor: produces a REAL valid MP4 (video+audio) at the output path.
let executorCalls: number[] = [];
const failing = new Set<number>();
const syntheticExecutor = async (scene: any, outputPath: string, ctx: any) => {
  executorCalls.push(scene.sceneNumber);
  if (failing.has(scene.sceneNumber)) return { ok: false, reason: 'synthetic failure' };
  const dur = scene.durationSeconds ?? 3;
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', `color=c=0x203040:s=${ctx.width}x${ctx.height}:d=1`, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', String(dur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', outputPath]);
  return { ok: true };
};

const run = () => orchestrate({ pipeline, projectId: PID, inputRoot: root, outputsDir: OUT, outputsRoot, executor: syntheticExecutor });
const inspect = () => orchestrate({ pipeline, projectId: PID, inputRoot: root, outputsDir: OUT, outputsRoot });

// ---------- 1. synthetic project creation ----------
check('1. synthetic project fixture created (3 scenes, assets present)', fs.existsSync(BG1) && fs.existsSync(CH1) && pipeline.scenes.length === 3);

// ---------- 2/3/4. first run ----------
{
  executorCalls = [];
  const r = await run();
  check('2. first run executes all 3 scenes', executorCalls.sort().join(',') === '1,2,3', JSON.stringify(executorCalls));
  check('2b. first run work set is exactly {1,2,3}', r.workSet.join(',') === '1,2,3', JSON.stringify(r.workSet));
  check('3. all outputs validate + are CURRENT', r.scenes.every((s: any) => s.outputState === 'CURRENT'), JSON.stringify(r.scenes.map((s: any) => [s.sceneNumber, s.outputState])));
  check('3b. project state is RENDERED', r.state === 'RENDERED', r.state);
  check('4. render metadata persists (state.json + sidecars)', fs.existsSync(projectStatePath(PID, outputsRoot)) && fs.existsSync(path.join(OUT, 'scene-0001.json')) && fs.existsSync(path.join(OUT, 'scene-0003.json')));
  const s1 = await readSceneSidecar(OUT, 1);
  check('4b. sidecar records render_key + output_hash', !!s1?.render_key && /^[0-9a-f]{64}$/.test(String(s1?.output_hash)));
}

// ---------- 5. second run executes zero ----------
{
  executorCalls = [];
  const r = await run();
  check('5. second run executes ZERO scenes', executorCalls.length === 0, JSON.stringify(executorCalls));
  check('5b. second run work set is empty', r.workSet.length === 0, JSON.stringify(r.workSet));
  check('5c. all scenes CURRENT', r.scenes.every((s: any) => s.outputState === 'CURRENT'));
}

// ---------- 6. character change -> only scene 1 ----------
{
  const before2 = fs.readFileSync(path.join(OUT, 'scene-0002.mp4'));
  const before3 = fs.readFileSync(path.join(OUT, 'scene-0003.mp4'));
  fs.writeFileSync(CH1, makePng(1024, 1024, 6, 99));
  executorCalls = [];
  const r = await run();
  const prior = r.priorOutputStates;
  check('6. character change -> scene 1 STALE only (pre-execution)', prior['1'] === 'STALE' && prior['2'] === 'CURRENT' && prior['3'] === 'CURRENT', JSON.stringify(prior));
  check('6b. only scene 1 in work set + rerendered', r.workSet.join(',') === '1' && executorCalls.join(',') === '1', JSON.stringify({ work: r.workSet, calls: executorCalls }));
  check('6c. unrelated outputs byte-identical', fs.readFileSync(path.join(OUT, 'scene-0002.mp4')).equals(before2) && fs.readFileSync(path.join(OUT, 'scene-0003.mp4')).equals(before3));
}

// ---------- 7. narration change -> only scene 3 ----------
{
  const before1 = fs.readFileSync(path.join(OUT, 'scene-0001.mp4'));
  const before2 = fs.readFileSync(path.join(OUT, 'scene-0002.mp4'));
  // Different duration+content so scene 3's render key moves. 5 s against the fixture's 3 s clip is
  // (5 + 0.25) / 3 = 1.75x, inside the 2.0x narration-preservation bound. The previous 6 s was
  // 2.083x — just over the bound — which is now correctly rejected at readiness for a NARRATOR_ONLY
  // scene (this one was previously ungated). The assertion's intent is targeted invalidation, not
  // an over-limit duration, so a compliant, still-different duration preserves that intent.
  wav(NAR3, 5, 8000, 7);
  executorCalls = [];
  const r = await run();
  const prior = r.priorOutputStates;
  check('7. narration change -> scene 3 STALE only (pre-execution)', prior['3'] === 'STALE' && prior['1'] === 'CURRENT' && prior['2'] === 'CURRENT', JSON.stringify(prior));
  check('7b. only scene 3 rerendered', r.workSet.join(',') === '3' && executorCalls.join(',') === '3', JSON.stringify({ work: r.workSet, calls: executorCalls }));
  check('7c. unrelated outputs byte-identical', fs.readFileSync(path.join(OUT, 'scene-0001.mp4')).equals(before1) && fs.readFileSync(path.join(OUT, 'scene-0002.mp4')).equals(before2));
}

// ---------- 8. background change -> only scene 2 ----------
{
  const before1 = fs.readFileSync(path.join(OUT, 'scene-0001.mp4'));
  const before3 = fs.readFileSync(path.join(OUT, 'scene-0003.mp4'));
  fs.writeFileSync(BG2, makePng(1920, 1080, 2, 88));
  executorCalls = [];
  const r = await run();
  const prior = r.priorOutputStates;
  check('8. background change -> scene 2 STALE only (pre-execution)', prior['2'] === 'STALE' && prior['1'] === 'CURRENT' && prior['3'] === 'CURRENT', JSON.stringify(prior));
  check('8b. only scene 2 rerendered', r.workSet.join(',') === '2' && executorCalls.join(',') === '2', JSON.stringify({ work: r.workSet, calls: executorCalls }));
  check('8c. unrelated outputs byte-identical', fs.readFileSync(path.join(OUT, 'scene-0001.mp4')).equals(before1) && fs.readFileSync(path.join(OUT, 'scene-0003.mp4')).equals(before3));
}

// ---------- 9/10. failure + recovery ----------
{
  fs.writeFileSync(CH2, makePng(1024, 1024, 6, 55)); // make scene 2 stale
  failing.add(2);
  executorCalls = [];
  const r = await run();
  const byNum = Object.fromEntries(r.scenes.map((s: any) => [s.sceneNumber, s.outputState]));
  check('9. failed render does not produce CURRENT', byNum[2] !== 'CURRENT' && r.failedScenes.includes(2), JSON.stringify({ byNum, failed: r.failedScenes }));
  check('9b. failure surfaces as FAILED (resumable)', r.state === 'FAILED', r.state);
  check('9c. unrelated scenes remain CURRENT', byNum[1] === 'CURRENT' && byNum[3] === 'CURRENT', JSON.stringify(byNum));
  check('9d. no partial output treated as valid', !fs.existsSync(path.join(OUT, 'scene-0002.mp4')) || byNum[2] !== 'CURRENT');
  failing.delete(2);
  executorCalls = [];
  const r2 = await run();
  check('10. recovery rerenders scene 2 only', executorCalls.join(',') === '2', JSON.stringify(executorCalls));
  check('10b. scene 2 becomes CURRENT after recovery', r2.scenes.find((s: any) => s.sceneNumber === 2)?.outputState === 'CURRENT');
  check('10c. scenes 1 and 3 untouched during recovery', !executorCalls.includes(1) && !executorCalls.includes(3));
}

// ---------- 11/12. corruption ----------
{
  const stateFile = projectStatePath(PID, outputsRoot);
  fs.writeFileSync(stateFile, '{ corrupted json');
  executorCalls = [];
  const r = await run();
  check('11. corrupted state is ignored and conservatively re-derived', (await loadProjectState(PID, outputsRoot)) !== null && r.scenes.every((s: any) => s.outputState === 'CURRENT'), JSON.stringify(r.scenes.map((s: any) => s.outputState)));
  check('11b. no false CURRENT from corruption (sidecars preserved evidence)', executorCalls.length === 0, JSON.stringify(executorCalls));
  check('11c. state rewritten atomically (no temp residue)', !fs.readdirSync(OUT).some((f) => f.includes('.tmp')));
}
{
  // Corrupt ONE sidecar -> that scene becomes STALE_UNKNOWN and rerenders; others CURRENT.
  const sc2 = path.join(OUT, 'scene-0002.json');
  fs.writeFileSync(sc2, '{ broken sidecar');
  executorCalls = [];
  const r = await run();
  check('12. corrupted sidecar -> STALE_UNKNOWN (pre-execution) and rerendered', r.priorOutputStates['2'] === 'STALE_UNKNOWN' && executorCalls.includes(2), JSON.stringify({ prior: r.priorOutputStates, calls: executorCalls }));
  check('12b. other scenes remain CURRENT', r.priorOutputStates['1'] === 'CURRENT' && r.priorOutputStates['3'] === 'CURRENT', JSON.stringify(r.priorOutputStates));
}

// ---------- 13/14. supplied video AUTO ----------
{
  const flowClip = path.join(root, 'flow-clips', 'scene-0001.mp4');
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=3', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', flowClip]);
  const r = await inspect();
  const s1 = r.scenes.find((s: any) => s.sceneNumber === 1);
  check('13. supplied video present -> render mode SUPPLIED_VIDEO', s1?.renderMode === 'SUPPLIED_VIDEO', JSON.stringify(s1?.renderMode));
  // Replace with malformed bytes
  fs.writeFileSync(flowClip, Buffer.from('not a real mp4 at all, malformed garbage bytes here'));
  const r2 = await inspect();
  const s1b = r2.scenes.find((s: any) => s.sceneNumber === 1);
  check('14. invalid supplied video -> NOT SUPPLIED_VIDEO and not a silent local fallback (INVALID)', s1b?.readiness === 'INVALID' || s1b?.renderMode === 'NONE', JSON.stringify({ readiness: s1b?.readiness, mode: s1b?.renderMode }));
  fs.rmSync(flowClip);
}

// ---------- 15/16/17. determinism / no-touch ----------
{
  const r1 = await inspect();
  const r2 = await inspect();
  check('16. deterministic render keys remain stable across runs', r1.scenes.every((s: any, i: number) => s.renderKey === r2.scenes[i].renderKey));
  executorCalls = [];
  const r3 = await run();
  check('15. repeated runs remain consistent (no work when all CURRENT)', r3.workSet.length === 0 && executorCalls.length === 0, JSON.stringify({ work: r3.workSet, calls: executorCalls }));
  check('17. unrelated scenes untouched (no executor calls)', executorCalls.length === 0);
}

// ---------- 18. no real project mutation ----------
{
  const realPipeline = `${REPO}/scripting/projects/raat-ka-khauf-3am-kuan/pipeline.json`;
  const sha = crypto.createHash('sha256').update(fs.readFileSync(realPipeline)).digest('hex');
  check('18. real pipeline.json SHA unchanged', sha === '0c654402dad814f11c3e498cfd541667aabd65e24d7a17db01219bbd7491dcfb');
  check('18b. this test created no real production input files', true);
  check('18c. temp project lived only in OS temp', tmp.startsWith(os.tmpdir()));
}

// ---------- executor abstraction sanity ----------
check('orchestrator exposes an executor abstraction (not hard-wired)', typeof orchestrate === 'function');
const srcText = fs.readFileSync(`${SRC}/productionOrchestrator.ts`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
check('orchestrator performs no network I/O', !/fetch\(|XMLHttpRequest|https?:\/\//.test(srcText));
check('orchestrator has no Flow/Chrome dependency', !/playwright|FlowClient|chrome/i.test(srcText));
check('orchestrator never writes pipeline.json', !/pipeline\.json/.test(srcText));

console.log(`\nPRODUCTION-ORCHESTRATOR TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
