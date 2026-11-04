// Offline orchestrator-level downstream corruption tests (STEP-8FQ).
// Temp dirs only. Synthetic scene/stage producers. No Flow/Chrome/credits/OpenAI.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
import { REPO } from './_testPaths.mjs';
const SRC = `${REPO}/production/src`;
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
const ORCH = await import(pathToFileURL(`${SRC}/productionOrchestrator.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };
function makePng(w: number, h: number, ct = 6, tag = 0) { const T: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; } const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }; const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); }; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct; const ch = ct === 6 ? 4 : 2; const raw = Buffer.alloc(h * (1 + w * ch), 0x80); for (let y = 0; y < h; y++) raw[y * (1 + w * ch)] = 0; raw[11] = (tag & 0xff); return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }
const wav = (f: string, sec: number, tag = 0) => { const n = Math.round(sec * 8000); const d = Buffer.alloc(n * 2, tag); const b = Buffer.alloc(44 + d.length); b.write('RIFF', 0); b.writeUInt32LE(36 + d.length, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(d.length, 40); fs.writeFileSync(f, b); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8fq-'));
const PID = 'synthetic-8fq';
const root = path.join(tmp, 'inputs', PID);
const outputsRoot = path.join(tmp, 'outputs');
const OUT = path.join(outputsRoot, PID);
for (const c of ['characters', 'narration', 'flow-clips', 'backgrounds', 'music']) fs.mkdirSync(path.join(root, c), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(root, 'backgrounds', 'BGD-01.png'), makePng(1920, 1080, 2, 1));
fs.writeFileSync(path.join(root, 'characters', 'CHAR-01-ARJUN.png'), makePng(1024, 1024, 6, 1));
wav(path.join(root, 'narration', 'narration-0001.wav'), 4, 0);
wav(path.join(root, 'narration', 'narration-0002.wav'), 4, 0);
// STRICT local-synthesis policy: EVERY scene requires a valid supplied clip, so both background-only
// scenes get one (real media, so validateVideoClip accepts them).
for (const n of [1, 2]) {
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', `color=c=0x${(0x203040 + n * 0x010203).toString(16)}:s=1280x720:d=4`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(root, 'flow-clips', `scene-000${n}.mp4`)]);
}
const pipeline: any = { project_id: PID, characters: [{ tag: '@CHAR-01-ARJUN' }], backgrounds: [{ tag: '#BGD-01' }], scenes: [
  { scene_number: 1, title: 'S1', background_tag: '#BGD-01', character_tags:[], speaker: 'NARRATOR', camera: 'W', visual_action: 'a', effects: '', narration_text: 'न1', devanagari_dialogue: '', clip_length_seconds: null, edit_length_seconds: null },
  { scene_number: 2, title: 'S2', background_tag: '#BGD-01', character_tags:[], speaker: 'NARRATOR', camera: 'W', visual_action: 'b', effects: '', narration_text: 'न2', devanagari_dialogue: '', clip_length_seconds: null, edit_length_seconds: null },
]};
// synthetic but REAL media scene outputs (ffmpeg), so validateVideoClip accepts them
const sceneExec = async (scene: any, out: string, ctx: any) => { const dur = scene.durationSeconds ?? 3; const h = parseInt(String(scene.renderKey ?? '0').slice(0, 6), 16) || 0; const color = `0x${(0x203040 ^ (h & 0xffffff)).toString(16).padStart(6, '0')}`; await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${ctx.width}x${ctx.height}:d=1`, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', String(dur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]); return { ok: true }; };
let stageCalls: string[] = [];
const stageExec = async (stage: string, out: string, keys: any) => { stageCalls.push(stage); await fsp.writeFile(out, `SYNTH-${stage}-${keys?.stageKey ?? 'nokey'}\n`); return { ok: true }; };
const mk = () => ({ pipeline, projectId: PID, inputRoot: root, outputsDir: OUT, outputsRoot, executor: sceneExec, stageExecutor: stageExec, stageInputs: { bgmHash: 'bgm-v1', introHash: 'intro-v1', logoHash: 'logo-v1', titleMetadata: { title: 'T1' } } });
const reset = () => { stageCalls = []; };
const titleFile = path.join(OUT, 'final-title.mp4');
const S = (r: any) => r.downstream.states;

// 1. first run
{ reset(); const r = await ORCH.orchestrate(mk() as any); check('1. first run executes EDIT,MIX,BED,TITLE', r.downstream.executedStages.join(',') === 'EDIT,MIX,BED,TITLE', JSON.stringify(r.downstream.executedStages)); check('1b. all stages CURRENT', ['EDIT', 'MIX', 'BED', 'TITLE'].every((s) => S(r)[s] === 'CURRENT')); check('1c. state AWAITING_APPROVAL', r.state === 'AWAITING_APPROVAL', r.state); }
// 2. idempotent second run
{ reset(); const r = await ORCH.orchestrate(mk() as any); check('2. second run executes ZERO stages', stageCalls.length === 0, JSON.stringify(stageCalls)); }
// 3. corrupt TITLE -> only TITLE reruns; others CURRENT; recovers
{ await fsp.writeFile(titleFile, Buffer.from('CORRUPT')); reset(); const r = await ORCH.orchestrate(mk() as any); check('3. corrupt TITLE -> only TITLE reruns', stageCalls.join(',') === 'TITLE', JSON.stringify(stageCalls)); check('3b. EDIT/MIX/BED CURRENT', ['EDIT', 'MIX', 'BED'].every((s) => S(r)[s] === 'CURRENT')); check('3c. TITLE recovered', S(r).TITLE === 'CURRENT' && !(await fsp.readFile(titleFile)).equals(Buffer.from('CORRUPT'))); }
// 4. corrupt BED
{ await fsp.writeFile(path.join(OUT, 'final-bedded.mp4'), Buffer.from('X')); reset(); const r = await ORCH.orchestrate(mk() as any); check('4. corrupt BED -> BED,TITLE rerun', stageCalls.join(',') === 'BED,TITLE', JSON.stringify(stageCalls)); check('4b. EDIT/MIX CURRENT', S(r).EDIT === 'CURRENT' && S(r).MIX === 'CURRENT'); }
// 5. corrupt MIX
{ await fsp.writeFile(path.join(OUT, 'final-narrated.mp4'), Buffer.from('X')); reset(); const r = await ORCH.orchestrate(mk() as any); check('5. corrupt MIX -> MIX,BED,TITLE rerun', stageCalls.join(',') === 'MIX,BED,TITLE', JSON.stringify(stageCalls)); check('5b. EDIT CURRENT', S(r).EDIT === 'CURRENT'); }
// 6. corrupt EDIT
{ await fsp.writeFile(path.join(OUT, 'final-with-fades.mp4'), Buffer.from('X')); reset(); const r = await ORCH.orchestrate(mk() as any); check('6. corrupt EDIT -> EDIT,MIX,BED,TITLE rerun', stageCalls.join(',') === 'EDIT,MIX,BED,TITLE', JSON.stringify(stageCalls)); check('6b. all recovered CURRENT', ['EDIT', 'MIX', 'BED', 'TITLE'].every((s) => S(r)[s] === 'CURRENT')); }
// 7. deleted TITLE
{ await fsp.rm(titleFile, { force: true }); reset(); const r = await ORCH.orchestrate(mk() as any); check('7. deleted TITLE -> TITLE reruns', stageCalls.join(',') === 'TITLE', JSON.stringify(stageCalls)); check('7b. TITLE CURRENT', S(r).TITLE === 'CURRENT'); }
// 8. malformed recorded hash
{ const sc = path.join(OUT, 'final-with-fades.mp4.stage'); const rec = JSON.parse(await fsp.readFile(sc, 'utf8')); rec.output_hash = 'bad'; await fsp.writeFile(sc, JSON.stringify(rec)); reset(); const r = await ORCH.orchestrate(mk() as any); check('8. malformed recorded hash -> EDIT reruns', stageCalls.includes('EDIT'), JSON.stringify(stageCalls)); check('8b. EDIT CURRENT after recovery', S(r).EDIT === 'CURRENT'); }
// 9. missing recorded hash
{ const sc = path.join(OUT, 'final-title.mp4.stage'); const rec = JSON.parse(await fsp.readFile(sc, 'utf8')); delete rec.output_hash; await fsp.writeFile(sc, JSON.stringify(rec)); reset(); const r = await ORCH.orchestrate(mk() as any); check('9. missing recorded hash -> TITLE reruns', stageCalls.includes('TITLE'), JSON.stringify(stageCalls)); }

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nORCHESTRATOR INTEGRITY TESTS PASSED (${passed} checks)`);
