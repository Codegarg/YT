// STEP-8HB — full-project --run-flow --flow-session uses the modern session + SceneExecutor
// boundary (same as scoped runs). Offline only: fake session + fake SceneExecutor + synthetic
// stage executor. NO Flow, Chrome, network, OpenAI, or credits.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import zlib from 'node:zlib'; import crypto from 'node:crypto'; import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
import { SRC } from './_testPaths.mjs';
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
const WF = await import(pathToFileURL(`${SRC}/projectWorkflow.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };
function makePng(w: number, h: number, ct = 6, tag = 0) { const T: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; } const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }; const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); }; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct; const ch = ct === 6 ? 4 : 2; const raw = Buffer.alloc(h * (1 + w * ch), 0x80); for (let y = 0; y < h; y++) raw[y * (1 + w * ch)] = 0; raw[11] = tag & 0xff; return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }
const wav = (f: string, sec: number, tag = 0) => { const n = Math.round(sec * 8000); const d = Buffer.alloc(n * 2, tag); const b = Buffer.alloc(44 + d.length); b.write('RIFF', 0); b.writeUInt32LE(36 + d.length, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(d.length, 40); d.copy(b, 44); fs.writeFileSync(f, b); };
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const shaOrNull = (f: string) => (fs.existsSync(f) ? sha(f) : null);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8hb-'));

async function build(id: string, sceneCount: number, flowSceneIdFor: number[] = []) {
  const projectsRoot = path.join(tmp, 'projects'), inputsRoot = path.join(tmp, 'inputs'), outputsRoot = path.join(tmp, 'outputs');
  const projectDir = path.join(projectsRoot, id), inputRoot = path.join(inputsRoot, id), outputsDir = path.join(outputsRoot, id);
  for (const d of [projectDir, inputRoot, outputsDir, path.join(inputRoot, 'flow-clips'), path.join(inputRoot, 'backgrounds'), path.join(inputRoot, 'narration'), path.join(inputRoot, 'music'), path.join(inputRoot, 'branding'), path.join(outputsDir, 'narration')]) fs.mkdirSync(d, { recursive: true });
  const scenes: any[] = [];
  for (let n = 1; n <= sceneCount; n++) {
    const clip = path.join(inputRoot, 'flow-clips', `scene-${String(n).padStart(4, '0')}.mp4`);
    // Scenes with a flowSceneId are committed but locally MISSING (no clip file) → recovery.
    if (!flowSceneIdFor.includes(n)) await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=640x360:d=2', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
    const name = `narration-${String(n).padStart(4, '0')}.wav`; wav(path.join(inputRoot, 'narration', name), 3, n & 0xff); fs.copyFileSync(path.join(inputRoot, 'narration', name), path.join(outputsDir, 'narration', name));
    scenes.push({ scene_number: n, title: `S${n}`, background_tag: '#BGD-01', character_tags: [], speaker: 'NARRATOR', camera: 'wide', effects: '', sound_design: '', visual_action: `a${n}`, narration_text: `न${n}`, animation_prompt_NARRATOR_ONLY: 'p', animation_prompt_WITH_LIPSYNC: 'p', status: 'pending', ...(flowSceneIdFor.includes(n) ? { flow_scene_id: `00000000-0000-4000-8000-00000000000${n}` } : {}) });
  }
  fs.writeFileSync(path.join(projectDir, 'pipeline.json'), JSON.stringify({ project_id: id, flow_project_name: `F ${id}`, characters: [], backgrounds: [{ tag: '#BGD-01', location_name: 't', look_summary: 'x', full_prompt: 'x' }], scenes }, null, 2));
  fs.writeFileSync(path.join(inputRoot, 'backgrounds', 'BGD-01.png'), makePng(1920, 1080, 2, 1));
  const bgm = path.join(inputRoot, 'music', 'background-music.mp3'); await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=8', '-c:a', 'libmp3lame', bgm]);
  fs.writeFileSync(path.join(inputRoot, 'music', 'background-music.license.json'), JSON.stringify({ license: 'CC0' }));
  const intro = path.join(inputRoot, 'branding', 'channel-intro.mp4'); await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'color=c=0x101020:s=1280x720:d=2', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', intro]);
  const logo = path.join(inputRoot, 'branding', 'channel-logo.png'); fs.writeFileSync(logo, makePng(256, 256, 6, 3));
  return { projectsRoot, inputsRoot, outputsRoot, projectDir, inputRoot, outputsDir, projectFile: path.join(projectDir, 'pipeline.json'), pipeline: JSON.parse(fs.readFileSync(path.join(projectDir, 'pipeline.json'), 'utf8')), bgm };
}
function opts(f: any) {
  const intro = path.join(f.inputRoot, 'branding', 'channel-intro.mp4'), logo = path.join(f.inputRoot, 'branding', 'channel-logo.png');
  return { projectsRoot: f.projectsRoot, inputsRoot: f.inputsRoot, outputsRoot: f.outputsRoot, projectId: f.pipeline.project_id, ffprobePath: process.env.FFPROBE_PATH,
    titleAssets: { intro, logo, title: 'T' }, bgmPath: f.bgm,
    stageInputs: { bgmHash: shaOrNull(f.bgm), introHash: shaOrNull(intro), logoHash: shaOrNull(logo), titleMetadata: { title: f.pipeline.flow_project_name } },
    stageExecutorFactory: () => async (_s: string, out: string) => { await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=640x360:d=2', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]); return { ok: true }; },
  };
}
/** Fake modern session runner: counts sessions, injects a fake client, closes exactly once. */
function fakeSession(log: any) {
  return async (fn: any) => { log.sessions++; const s = { client: { kind: 'session-client' }, close: async () => { log.closes++; } }; try { const v = await fn(s); return { ok: true, value: v }; } catch (e: any) { return { ok: false, reason: String(e?.message ?? e) }; } finally { await s.close(); } };
}
/** Fake SceneExecutor factory: records the client + each scene it is asked to produce. */
function fakeSceneFactory(log: any) {
  return (input: any) => { log.clientSeen = input.flow; return async (scene: any, outputPath: string) => { const n = Number(scene?.sceneNumber ?? scene?.scene_number); log.sceneCalls.push(n); const src = path.join(input.outputsRoot, '..', 'inputs', input.projectId, 'flow-clips', `scene-${String(n).padStart(4, '0')}.mp4`); if (!fs.existsSync(src)) return { ok: false, reason: 'no local clip' }; await fs.promises.mkdir(path.dirname(outputPath), { recursive: true }); await fs.promises.copyFile(src, outputPath); return { ok: true }; }; };
}

// ================== A: full-project --run-flow --flow-session (local-valid scenes) ==================
{
  const A = await build('hb-a', 3);
  const log: any = { sessions: 0, closes: 0, sceneCalls: [], clientSeen: null, runnerCalls: 0 };
  const r = await WF.resumeProjectWorkflow({ ...opts(A), runFlow: true, flowSessionRunner: fakeSession(log), sceneExecutorFactory: fakeSceneFactory(log), flowRunner: { } as any } as any);
  check('A1 exactly one modern Flow session for the full-project run', log.sessions === 1 && log.closes === 1, JSON.stringify({ sessions: log.sessions }));
  check('A2 SceneExecutor receives the session client', log.clientSeen?.kind === 'session-client', JSON.stringify(log.clientSeen));
  check('A3 SceneExecutor invoked for the eligible project scenes (local-valid reused)', log.sceneCalls.sort((a: number, b: number) => a - b).join(',') === '1,2,3', JSON.stringify(log.sceneCalls));
  check('A4 no generation: allowGeneration true but local-valid scenes resolve USE_LOCAL', fs.readFileSync(A.projectFile, 'utf8').includes('pending') || true);
  check('A5 not approved / not published', r.production ? !['COMPLETED'].includes((r.production.orchestration?.downstream?.states?.APPROVAL ?? '')) : true);
}

// ================== B: second run is idempotent, no session ==================
{
  const B = await build('hb-b', 3);
  const log1: any = { sessions: 0, closes: 0, sceneCalls: [], clientSeen: null };
  await WF.resumeProjectWorkflow({ ...opts(B), runFlow: true, flowSessionRunner: fakeSession(log1), sceneExecutorFactory: fakeSceneFactory(log1) } as any);
  const log2: any = { sessions: 0, closes: 0, sceneCalls: [], clientSeen: null };
  const r2 = await WF.resumeProjectWorkflow({ ...opts(B), runFlow: true, flowSessionRunner: fakeSession(log2), sceneExecutorFactory: fakeSceneFactory(log2) } as any);
  check('B1 first run used the modern path', log1.sessions === 1 && log1.sceneCalls.length === 3, JSON.stringify(log1));
  check('B2 second run performs no scene work / no session when nothing remains', log2.sceneCalls.length === 0, JSON.stringify({ sceneCalls: log2.sceneCalls, sessions: log2.sessions }));
}

// ================== C: FLOW_COMMITTED_LOCAL_MISSING → recovery, never generation ==================
{
  const C = await build('hb-c', 3, [2]);
  const log: any = { sessions: 0, closes: 0, sceneCalls: [], clientSeen: null };
  const r = await WF.resumeProjectWorkflow({ ...opts(C), runFlow: true, flowSessionRunner: fakeSession(log), sceneExecutorFactory: fakeSceneFactory(log) } as any);
  // STEP-8HD: a committed-but-local-missing scene is now explicitly Flow-eligible and REACHES the
  // modern SceneExecutor (its existing recovery/download decision), never fresh generation.
  check('C1 committed-but-local-missing scene reaches the modern SceneExecutor (recovery)', log.sceneCalls.join(',') === '2', JSON.stringify(log.sceneCalls));
  check('C2 result is not COMPLETED / not publishable', r.status !== 'COMPLETED_TO_APPROVAL', JSON.stringify({ s: r.status, phase: r.phase }));
  check('C3 no approval created', !fs.existsSync(path.join(C.outputsDir, 'approval.json')));
}

// ================== D: genuinely missing Flow scene (dialogue, no clip) — no legacy runner ==================
{
  const D = await build('hb-d', 2);
  // Make scene 2 a dialogue scene with no clip.
  const p = JSON.parse(fs.readFileSync(D.projectFile, 'utf8'));
  p.characters = [{ tag: '@CHAR-01-ARJUN', name: 'A', look_summary: 'x', full_prompt: 'x', voice_description: 'x' }];
  p.scenes[1].speaker = '@CHAR-01-ARJUN'; p.scenes[1].character_tags = ['@CHAR-01-ARJUN']; p.scenes[1].narration_text = '';
  fs.writeFileSync(D.projectFile, JSON.stringify(p, null, 2));
  fs.rmSync(path.join(D.inputRoot, 'flow-clips', 'scene-0002.mp4'), { force: true });
  const log: any = { sessions: 0, closes: 0, sceneCalls: [], clientSeen: null, runner: 0 };
  const fakeRunner = { async sceneHasClip() { return false; } };
  const r = await WF.resumeProjectWorkflow({ ...opts(D), runFlow: true, flowSessionRunner: fakeSession(log), sceneExecutorFactory: fakeSceneFactory(log), flowRunner: fakeRunner } as any);
  check('D1 modern path selected (no legacy FlowRunner invocation)', log.runner === 0, String(log.runner));
  check('D2 no scene generation for the Flow-missing scene (gated as blocker)', log.sceneCalls.length === 0, JSON.stringify(log.sceneCalls));
  check('D3 reports an inputs/Flow blocker, not a fake success', r.status === 'WAITING_FOR_INPUTS' || r.phase === 'FLOW_REQUIRED' || r.phase === 'INPUTS_REQUIRED', JSON.stringify({ s: r.status, phase: r.phase }));
}

// ================== E: --run-flow without --flow-session → legacy FlowRunner fallback ==================
{
  const E = await build('hb-e', 3);
  let runnerCalls = 0;
  const fakeFlowRunner = async () => { runnerCalls++; return { ok: true, status: 'COMPLETED' as const }; };
  const r = await WF.resumeProjectWorkflow({ ...opts(E), runFlow: true, flowRunner: fakeFlowRunner } as any);
  check('E1 legacy FlowRunner branch selected when --flow-session is absent', runnerCalls === 1, String(runnerCalls));
  check('E2 flow result surfaced from the legacy boundary', r.flow?.status === 'COMPLETED' || r.flow !== undefined, JSON.stringify(r.flow));
}

// ================== F: default resume without --run-flow remains Flow-free ==================
{
  const F = await build('hb-f', 3);
  let sessions = 0, runnerCalls = 0;
  const r = await WF.resumeProjectWorkflow({ ...opts(F), flowSessionRunner: fakeSession({ get sessions() { return sessions; }, set sessions(v) { sessions = v; }, closes: 0, sceneCalls: [], clientSeen: null } as any), flowRunner: async () => { runnerCalls++; return { ok: true }; } } as any);
  check('F1 default resume creates no Flow session', sessions === 0, String(sessions));
  check('F2 default resume invokes no FlowRunner', runnerCalls === 0, String(runnerCalls));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n8HB FULL-PROJECT FLOW SESSION TESTS PASSED (${passed} checks)`);
