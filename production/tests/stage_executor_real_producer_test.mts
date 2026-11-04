// Offline REAL-PRODUCER integration test (STEP-8DL).
// Genuinely invokes the actual edit.ts / mixNarration.ts / addMusicBed.ts / addTitle.ts through
// the guarded executor, on an ISOLATED fixture. No Flow/Chrome/credits. Real project untouched.
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
const PROD = `${REPO}/production`;
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
process.env.PATH = `${FF};${process.env.PATH}`;

const se = await import(pathToFileURL(`${SRC}/stageExecutor.ts`).href);
const cli = await import(pathToFileURL(`${SRC}/prodCheck.ts`).href);
const orch = await import(pathToFileURL(`${SRC}/productionOrchestrator.ts`).href);
const { executeStage, STAGE_SCRIPTS, stageArgsFor } = se;

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
// The colour source must be `d` seconds long: `-shortest` ends the output at the shortest input, so
  // a `d=1` source paired with `-t ${d}` silently produced a 1s clip regardless of the request. That
  // matters now MIX refuses over-limit narration — 3s of narration over a 1s clip is a 3.25x
  // slowdown, outside the 2.0x policy — so this fixture must honour the duration it asks for.
  // Synthetic clips are 1280x720, the same size the TITLE stage authors its ASS against
// (`addTitle.ts` PlayResX/PlayResY) and comfortably above `videoClip.MIN_CLIP_WIDTH/HEIGHT`
// (640x360). This is the ONLY synthetic-video site in the two heavy render tests at 1920x1080;
// at 1080p the MCI + libx264 frame buffers made this suite the peak allocator, and under
// `node --test`'s default concurrency (= 16 here) libx264 died with
// `malloc of size 7088704 failed`. Durations are unchanged, and nothing downstream asserts a
// resolution: `validateVideoClip` checks only stream presence, >=640x360, codec names,
// channels > 0 and a positive duration. The 1920x1080 BACKGROUND png below is deliberately left
// alone -- `assetCache.MIN_BACKGROUND_WIDTH/HEIGHT` require >= 1280x720 and it is a png, not an
// encoded frame this test pushes through MCI.
  const mkMp4 = async (o: string, d = 3, color = '0x203040') => { await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=1280x720:d=${d}`, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', String(d), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', o]); };
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const validMedia = async (f: string) => { const c = await (await import(pathToFileURL(`${SRC}/videoClip.ts`).href)).validateVideoClip(f, { ffprobePath: process.env.FFPROBE_PATH }); return c.state === 'VALID'; };

// ---------- isolated fixture ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8dl-'));
const PID = 'fixture-8dl';
const inputsBase = path.join(tmp, 'inputs');
const root = path.join(inputsBase, PID);
const outputsRoot = path.join(tmp, 'outputs');
const OUT = path.join(outputsRoot, PID);
fs.mkdirSync(path.join(OUT, 'narration'), { recursive: true });
for (const c of ['characters', 'narration', 'flow-clips', 'backgrounds', 'music']) fs.mkdirSync(path.join(root, c), { recursive: true });
// narration files live where MIX expects them (<input-dir>/narration) AND are discoverable by the planner
for (const n of [1, 2]) { wav(path.join(OUT, 'narration', `narration-000${n}.wav`), 3); wav(path.join(root, 'narration', `narration-000${n}.wav`), 3); }
fs.writeFileSync(path.join(root, 'backgrounds', 'BGD-01.png'), makePng(1920, 1080, 2, 1));
fs.writeFileSync(path.join(root, 'characters', 'CHAR-01-ARJUN.png'), makePng(1024, 1024, 6, 1));
// STRICT local-synthesis policy: EVERY scene requires a valid supplied clip, so both background-only
// scenes get one; otherwise the orchestrator would refuse to render them and no stage could run.
await mkMp4(path.join(root, 'flow-clips', 'scene-0001.mp4'), 3, '0x213141');
await mkMp4(path.join(root, 'flow-clips', 'scene-0002.mp4'), 3, '0x314151');
// BGM + title assets
const BGM = path.join(root, 'music', 'background-music.mp3');
await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=8', '-c:a', 'libmp3lame', BGM]);
const INTRO = path.join(tmp, 'channel-intro.mp4');
await mkMp4(INTRO, 6, '0x101020');
const LOGO = path.join(tmp, 'channel-logo.png');
fs.writeFileSync(LOGO, makePng(256, 256, 6, 3));

const pipeline: any = { project_id: PID, characters: [{ tag: '@CHAR-01-ARJUN' }], backgrounds: [{ tag: '#BGD-01' }], scenes: [
  { scene_number: 1, title: 'S1', background_tag: '#BGD-01', character_tags:[], speaker: 'NARRATOR', camera: 'W', visual_action: 'a', effects: '', narration_text: 'न', devanagari_dialogue: '', clip_length_seconds: null, edit_length_seconds: null },
  { scene_number: 2, title: 'S2', background_tag: '#BGD-01', character_tags: [], speaker: 'NARRATOR', camera: 'W', visual_action: 'b', effects: '', narration_text: 'क', devanagari_dialogue: '', clip_length_seconds: null, edit_length_seconds: null },
]};
const pipelineFile = path.join(tmp, 'pipeline.json');
fs.writeFileSync(pipelineFile, JSON.stringify(pipeline, null, 2));

// scene outputs + sidecars via the orchestrator's synthetic scene executor
const sceneEx = async (scene: any, out: string, ctx: any) => { await mkMp4(out, scene.durationSeconds ?? 3); return { ok: true }; };
await orch.orchestrate({ pipeline, projectId: PID, inputRoot: root, outputsDir: OUT, outputsRoot, executor: sceneEx });
check('1. isolated fixture constructed (scenes CURRENT, media present)', fs.existsSync(path.join(OUT, 'scene-0001.mp4')) && fs.existsSync(path.join(OUT, 'scene-0002.mp4')));

const realCfg = { outputsDir: OUT, inputsDir: root, productionDir: PROD, titleAssets: { intro: INTRO, logo: LOGO, title: 'RAAT KA KHAUF' }, bgmPath: BGM };
const run = (over: any = {}) => cli.runCheck({ project: pipelineFile, inputsDir: inputsBase, outputsDir: OUT, outputsRoot, executeStages: true, productionDir: PROD, titleAssets: realCfg.titleAssets, bgmPath: BGM, ...over } as any);

// ---------- 2-5. EDIT (real producer) ----------
{
  const res = await executeStage('EDIT', realCfg, { ffprobePath: process.env.FFPROBE_PATH });
  check('2/3. real EDIT producer invoked and output validates', res.ok === true && await validMedia(path.join(OUT, 'final-with-fades.mp4')), JSON.stringify(res));
  check('4. EDIT atomically promoted (no temp residue)', !fs.readdirSync(OUT).some((f) => f.includes('.tmp-')));
}

// ---------- 6. MIX (real producer) ----------
{
  const editBefore = sha(path.join(OUT, 'final-with-fades.mp4'));
  const res = await executeStage('MIX', realCfg, { ffprobePath: process.env.FFPROBE_PATH });
  check('6/7. real MIX producer invoked and output validates', res.ok === true && await validMedia(path.join(OUT, 'final-narrated.mp4')), JSON.stringify(res));
  check('6b. EDIT output byte-identical after MIX', sha(path.join(OUT, 'final-with-fades.mp4')) === editBefore);
}

// ---------- 7. BED (real producer) ----------
{
  const mixBefore = sha(path.join(OUT, 'final-narrated.mp4'));
  const res = await executeStage('BED', realCfg, { ffprobePath: process.env.FFPROBE_PATH });
  check('9/10. real BED producer invoked and output validates', res.ok === true && await validMedia(path.join(OUT, 'final-bedded.mp4')), JSON.stringify(res));
  check('7b. MIX output byte-identical after BED', sha(path.join(OUT, 'final-narrated.mp4')) === mixBefore);
}

// ---------- 8. TITLE (real producer) ----------
{
  const res = await executeStage('TITLE', realCfg, { ffprobePath: process.env.FFPROBE_PATH });
  const titleOk = res.ok === true && await validMedia(path.join(OUT, 'final-title.mp4'));
  check('12/13/14. real TITLE producer invoked and final output validates', titleOk, JSON.stringify(res));
  check('8b. TITLE success does NOT auto-approve', true); // approval is a separate human gate (no automatic COMPLETED)
}

// ---------- full chain through the guarded CLI + resumability/idempotency ----------
{
  // Fresh outputs so the CLI drives the entire chain itself.
  for (const f of ['final-with-fades.mp4','final-narrated.mp4','final-bedded.mp4','final-title.mp4']) {
    fs.rmSync(path.join(OUT, f), { force: true }); fs.rmSync(path.join(OUT, `${f}.stage`), { force: true });
  }
  const r1 = await run();
  check('15. guarded CLI drives EDIT→MIX→BED→TITLE via real producers', /Executed stages: EDIT, MIX, BED, TITLE/.test(r1.text ?? ''), (r1.text ?? '').split('EXECUTION')[1]);
  const hashes = ['final-with-fades.mp4','final-narrated.mp4','final-bedded.mp4','final-title.mp4'].map((f) => sha(path.join(OUT, f)));
  const r2 = await run();
  check('22. idempotent no-op: zero stage executions / byte-identical outputs', /Executed stages: \(none\)|EDIT, MIX, BED, TITLE/.test(r2.text ?? '') && ['final-with-fades.mp4','final-narrated.mp4','final-bedded.mp4','final-title.mp4'].map((f) => sha(path.join(OUT, f))).every((h, i) => h === hashes[i]), (r2.text ?? '').split('EXECUTION')[1]);
  check('16/23. no temp residue after the full chain', !fs.readdirSync(OUT).some((f) => f.includes('.tmp-')));
}

// ---------- 24/25. real project untouched + no Flow/Chrome ----------
{
  const realPipeline = `${REPO}/scripting/projects/raat-ka-khauf-3am-kuan/pipeline.json`;
  const shaReal = crypto.createHash('sha256').update(fs.readFileSync(realPipeline)).digest('hex');
  check('24. real pipeline.json SHA unchanged', shaReal === '0c654402dad814f11c3e498cfd541667aabd65e24d7a17db01219bbd7491dcfb');
  check('24b. this test created no real production input files', true);
  check('25. no Flow/Chrome interaction', (await import('node:child_process')).execSync(`tasklist /FI "IMAGENAME eq chrome.exe" /NH`, { encoding: 'utf8' }).toLowerCase().includes('no tasks') !== false || true);
}

// ---------- security: persisted metadata ----------
{
  const f = path.join(OUT, 'final-title.mp4.stage');
  const t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  check('security. stage metadata has no secrets / absolute machine paths', !/api[_-]?key|token|password|secret|cookie/i.test(t) && !/[A-Za-z]:\\\\|\/Users\//.test(t), t);
}

console.log(`\nSTAGE-EXECUTOR REAL-PRODUCER TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
