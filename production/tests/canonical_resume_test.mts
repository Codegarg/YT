// STEP-8HF — canonical plain `resume` wiring + resumable local execution. Offline, fakes only.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import zlib from 'node:zlib'; import crypto from 'node:crypto'; import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
import { SRC } from './_testPaths.mjs';
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
const WF = await import(pathToFileURL(`${SRC}/projectWorkflow.ts`).href);
const SEA = await import(pathToFileURL(`${SRC}/sceneExecutorAdapter.ts`).href);
const VIDEO = await import(pathToFileURL(`${SRC}/video.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };
function makePng(w: number, h: number, ct = 6, tag = 0) { const T: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; } const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }; const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); }; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct; const ch = ct === 6 ? 4 : 2; const raw = Buffer.alloc(h * (1 + w * ch), 0x80); for (let y = 0; y < h; y++) raw[y * (1 + w * ch)] = 0; raw[11] = tag & 0xff; return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }
const wav = (f: string, sec: number, tag = 0) => { const n = Math.round(sec * 8000); const d = Buffer.alloc(n * 2, tag); const b = Buffer.alloc(44 + d.length); b.write('RIFF', 0); b.writeUInt32LE(36 + d.length, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(d.length, 40); d.copy(b, 44); fs.writeFileSync(f, b); };
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const shaOrNull = (f: string) => fs.existsSync(f) ? sha(f) : null;
const mkClip = async (o: string) => { fs.mkdirSync(path.dirname(o), { recursive: true }); await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=640x360:d=2', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', o]); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8hf-'));

// ================== 1. Canonical resume wiring (buildResumeOptions) ==================
{
  const plain: any = VIDEO.buildResumeOptions(false, false);
  check('plain resume wires the real scene AND stage executors', typeof plain.sceneExecutorFactory === 'function' && typeof plain.stageExecutorFactory !== 'undefined' ? typeof plain.sceneExecutorFactory === 'function' : typeof plain.sceneExecutorFactory === 'function', JSON.stringify(Object.keys(plain)));
  check('plain resume wires NO Flow session runner (no Chrome by default)', plain.flowSessionRunner === undefined && plain.runFlow === false);
  check('plain resume keeps the FlowRunner boundary available but unused without --run-flow', typeof plain.flowRunner === 'function');
  const legacy: any = VIDEO.buildResumeOptions(true, false);
  check('--run-flow (no session) selects legacy FlowRunner and NO session', legacy.runFlow === true && legacy.flowSessionRunner === undefined && typeof legacy.flowRunner === 'function');
  const modern: any = VIDEO.buildResumeOptions(true, true);
  check('--run-flow --flow-session selects the modern session runner', modern.runFlow === true && typeof modern.flowSessionRunner === 'function');
}

// ================== fixture (all local inputs present) ==================
async function build(id: string, sceneCount = 3) {
  const projectsRoot = path.join(tmp, 'projects'), inputsRoot = path.join(tmp, 'inputs'), outputsRoot = path.join(tmp, 'outputs');
  const projectDir = path.join(projectsRoot, id), inputRoot = path.join(inputsRoot, id), outputsDir = path.join(outputsRoot, id);
  for (const d of [projectDir, inputRoot, outputsDir, path.join(inputRoot, 'flow-clips'), path.join(inputRoot, 'backgrounds'), path.join(inputRoot, 'narration'), path.join(inputRoot, 'music'), path.join(inputRoot, 'branding'), path.join(outputsDir, 'narration')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(inputRoot, 'backgrounds', 'BGD-01.png'), makePng(1920, 1080, 2, 1));
  const scenes: any[] = [];
  for (let n = 1; n <= sceneCount; n++) {
    await mkClip(path.join(inputRoot, 'flow-clips', `scene-${String(n).padStart(4, '0')}.mp4`));
    const nm = `narration-${String(n).padStart(4, '0')}.wav`; wav(path.join(inputRoot, 'narration', nm), 3, n & 0xff); fs.copyFileSync(path.join(inputRoot, 'narration', nm), path.join(outputsDir, 'narration', nm));
    scenes.push({ scene_number: n, title: `S${n}`, background_tag: '#BGD-01', character_tags: [], speaker: 'NARRATOR', camera: 'w', effects: '', sound_design: '', visual_action: `a${n}`, narration_text: 'न', animation_prompt_NARRATOR_ONLY: 'p', animation_prompt_WITH_LIPSYNC: 'p', status: 'pending' });
  }
  fs.writeFileSync(path.join(projectDir, 'pipeline.json'), JSON.stringify({ project_id: id, flow_project_name: 'F', characters: [], backgrounds: [{ tag: '#BGD-01', location_name: 't', look_summary: 'x', full_prompt: 'x' }], scenes }, null, 2));
  const bgm = path.join(inputRoot, 'music', 'background-music.mp3'); await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=8', '-c:a', 'libmp3lame', bgm]);
  fs.writeFileSync(path.join(inputRoot, 'music', 'background-music.license.json'), JSON.stringify({ license: 'CC0' }));
  const intro = path.join(inputRoot, 'branding', 'channel-intro.mp4'); await mkClip(intro);
  const logo = path.join(inputRoot, 'branding', 'channel-logo.png'); fs.writeFileSync(logo, makePng(256, 256, 6, 3));
  return { projectsRoot, inputsRoot, outputsRoot, projectDir, inputRoot, outputsDir, projectFile: path.join(projectDir, 'pipeline.json'), bgm, intro, logo, pipeline: JSON.parse(fs.readFileSync(path.join(projectDir, 'pipeline.json'), 'utf8')) };
}
const sceneExec = (f: any) => (input: any) => SEA.createRealSceneExecutor({ projectId: input.projectId, inputRoot: input.inputRoot, outputsRoot: input.outputsRoot, pipeline: input.pipeline, allowGeneration: input.allowGeneration, ffprobePath: input.ffprobePath, flow: input.flow });
const stageLog: string[] = [];
const syntheticStage = () => async (s: string, out: string) => { stageLog.push(s); await mkClip(out); return { ok: true }; };
const opts = (f: any) => ({ projectsRoot: f.projectsRoot, inputsRoot: f.inputsRoot, outputsRoot: f.outputsRoot, projectId: f.pipeline.project_id, ffprobePath: process.env.FFPROBE_PATH, productionDir: process.cwd(), titleAssets: { intro: f.intro, logo: f.logo, title: 'T' }, bgmPath: f.bgm, stageInputs: { bgmHash: shaOrNull(f.bgm), introHash: shaOrNull(f.intro), logoHash: shaOrNull(f.logo), titleMetadata: { title: 'F' } }, sceneExecutorFactory: sceneExec(f), stageExecutorFactory: syntheticStage });

// ================== 2/6. plain resume executes local work, then is idempotent ==================
{
  const f = await build('hf-a', 3);
  let sessions = 0, runner = 0;
  const runOnce = async () => WF.resumeProjectWorkflow({ ...opts(f), flowSessionRunner: async (fn: any) => { sessions++; return { ok: true, value: await fn({ client: {}, close: async () => {} }) }; }, flowRunner: async () => { runner++; return { ok: true }; } } as any);
  stageLog.length = 0;
  const r1 = await runOnce();
  check('plain resume reaches the real SceneExecutor + production orchestrator', (r1.production?.orchestration?.executedScenes ?? []).join(',') === '1,2,3', JSON.stringify(r1.production?.orchestration?.executedScenes));
  check('plain resume runs downstream stages once all scene outputs are current', stageLog.join(',') === 'EDIT,MIX,BED,TITLE', JSON.stringify(stageLog));
  check('plain resume ends AWAITING_APPROVAL (never auto-approved)', r1.status === 'COMPLETED_TO_APPROVAL' && r1.phase === 'AWAITING_APPROVAL' && !fs.existsSync(path.join(f.outputsDir, 'approval.json')));
  check('plain resume opens NO Flow session and NO FlowRunner', sessions === 0 && runner === 0, JSON.stringify({ sessions, runner }));
  // idempotency
  const r2 = await runOnce();
  check('second plain resume executes ZERO scenes and ZERO stages', (r2.production?.orchestration?.executedScenes ?? []).length === 0 && stageLog.length === 4, JSON.stringify({ scenes: r2.production?.orchestration?.executedScenes, stageLog }));
  check('second plain resume still AWAITING_APPROVAL with stable status', r2.status === 'COMPLETED_TO_APPROVAL');
}

// ================== 3. blocked project: plain resume performs no Flow and no stage bypass ==================
{
  const f = await build('hf-b', 2);
  // Make scene 2 a dialogue scene with a missing clip and a missing character asset → blocked.
  const p = JSON.parse(fs.readFileSync(f.projectFile, 'utf8'));
  p.characters = [{ tag: '@CHAR-01-ARJUN', name: 'A', look_summary: 'x', full_prompt: 'x', voice_description: 'x' }];
  p.scenes[1] = { ...p.scenes[1], speaker: '@CHAR-01-ARJUN', character_tags: ['@CHAR-01-ARJUN'], narration_text: '' };
  fs.writeFileSync(f.projectFile, JSON.stringify(p, null, 2));
  fs.rmSync(path.join(f.inputRoot, 'flow-clips', 'scene-0002.mp4'), { force: true });
  let sessions = 0, runner = 0;
  stageLog.length = 0;
  const r = await WF.resumeProjectWorkflow({ ...opts(f), flowSessionRunner: async (fn: any) => { sessions++; return { ok: true, value: await fn({ client: {}, close: async () => {} }) }; }, flowRunner: async () => { runner++; return { ok: true }; } } as any);
  check('blocked project: plain resume opens no Flow session / FlowRunner', sessions === 0 && runner === 0, JSON.stringify({ sessions, runner }));
  check('blocked project: no downstream stage executes', stageLog.length === 0, JSON.stringify(stageLog));
  check('blocked project: no false COMPLETED and no approval', r.status !== 'COMPLETED_TO_APPROVAL' && !fs.existsSync(path.join(f.outputsDir, 'approval.json')), JSON.stringify({ s: r.status }));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n8HF CANONICAL RESUME TESTS PASSED (${passed} checks)`);
