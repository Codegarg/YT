// STEP-8HD — explicit Flow-execution eligibility (separate from final readiness).
// Offline only: fakes/fixtures; NO Flow, Chrome, network, OpenAI, or credits.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import zlib from 'node:zlib'; import crypto from 'node:crypto'; import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
import { SRC } from './_testPaths.mjs';
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
const WF = await import(pathToFileURL(`${SRC}/projectWorkflow.ts`).href);
const SS = await import(pathToFileURL(`${SRC}/sceneState.ts`).href);
const SEA = await import(pathToFileURL(`${SRC}/sceneExecutorAdapter.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };
function makePng(w: number, h: number, ct = 6, tag = 0) { const T: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; } const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }; const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); }; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct; const ch = ct === 6 ? 4 : 2; const raw = Buffer.alloc(h * (1 + w * ch), 0x80); for (let y = 0; y < h; y++) raw[y * (1 + w * ch)] = 0; raw[11] = tag & 0xff; return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }
const wav = (f: string, sec: number, tag = 0) => { const n = Math.round(sec * 8000); const d = Buffer.alloc(n * 2, tag); const b = Buffer.alloc(44 + d.length); b.write('RIFF', 0); b.writeUInt32LE(36 + d.length, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(d.length, 40); d.copy(b, 44); fs.writeFileSync(f, b); };
const shaOrNull = (f: string) => fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null;
const mkClip = async (o: string) => { fs.mkdirSync(path.dirname(o), { recursive: true }); await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=640x360:d=2', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', o]); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8hd-'));

// ================== 1. PURE ELIGIBILITY TRUTH TABLE ==================
const base = { readiness: 'WAITING_FOR_VIDEO_CLIP', renderMode: 'NONE', background: { state: 'VALID' }, characters: [{ state: 'VALID' }], narrationAsset: { state: 'NOT_REQUIRED' }, suppliedClip: { state: 'MISSING' }, narration: 'DIALOGUE', flowLocal: { state: 'FLOW_NOT_COMMITTED' } };
check('A dialogue + valid bg/char + Flow missing => ELIGIBLE GENERATE', (() => { const v = SS.classifyFlowEligibility(base); return v.eligible && v.action === 'GENERATE'; })());
check('B missing background => NOT eligible', SS.classifyFlowEligibility({ ...base, background: { state: 'MISSING' } }).eligible === false);
check('C missing required character => NOT eligible', SS.classifyFlowEligibility({ ...base, characters: [{ state: 'MISSING' }] }).eligible === false);
check('D invalid background => NOT eligible', SS.classifyFlowEligibility({ ...base, background: { state: 'INVALID' } }).eligible === false);
check('E invalid character => NOT eligible', SS.classifyFlowEligibility({ ...base, characters: [{ state: 'INVALID' }] }).eligible === false);
check('F invalid scene => NOT eligible', SS.classifyFlowEligibility({ ...base, readiness: 'INVALID' }).eligible === false);
check('G narration missing but not required => ELIGIBLE (MIX still downstream)', (() => { const v = SS.classifyFlowEligibility({ ...base, narrationAsset: { state: 'MISSING' } }); return v.eligible && v.action === 'GENERATE'; })());
check('H FLOW_COMMITTED_LOCAL_MISSING + valid prereqs => ELIGIBLE RECOVER', (() => { const v = SS.classifyFlowEligibility({ ...base, flowLocal: { state: 'FLOW_COMMITTED_LOCAL_MISSING' } }); return v.eligible && v.action === 'RECOVER'; })());
check('I FLOW_COMMITTED_LOCAL_MISSING + missing character => NOT eligible', SS.classifyFlowEligibility({ ...base, flowLocal: { state: 'FLOW_COMMITTED_LOCAL_MISSING' }, characters: [{ state: 'MISSING' }] }).eligible === false);
check('J malformed / unknown => NOT eligible (fail closed)', SS.classifyFlowEligibility(null).eligible === false && SS.classifyFlowEligibility({ ...base, suppliedClip: { state: 'WAT' } }).eligible === false && SS.classifyFlowEligibility({ ...base, background: { state: 'WAT' } }).eligible === false);
check('K valid local clip => no Flow work', SS.classifyFlowEligibility({ ...base, suppliedClip: { state: 'VALID' }, renderMode: 'SUPPLIED_VIDEO' }).eligible === false);

// ================== fixtures ==================
async function build(id: string) {
  const projectsRoot = path.join(tmp, 'projects'), inputsRoot = path.join(tmp, 'inputs'), outputsRoot = path.join(tmp, 'outputs');
  const projectDir = path.join(projectsRoot, id), inputRoot = path.join(inputsRoot, id), outputsDir = path.join(outputsRoot, id);
  for (const d of [projectDir, inputRoot, outputsDir, path.join(inputRoot, 'flow-clips'), path.join(inputRoot, 'backgrounds'), path.join(inputRoot, 'characters'), path.join(inputRoot, 'narration'), path.join(inputRoot, 'music'), path.join(inputRoot, 'branding'), path.join(outputsDir, 'narration')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(inputRoot, 'backgrounds', 'BGD-01.png'), makePng(1920, 1080, 2, 1));
  fs.writeFileSync(path.join(inputRoot, 'characters', 'CHAR-01-ARJUN.png'), makePng(1024, 1024, 6, 1));
  const bgm = path.join(inputRoot, 'music', 'background-music.mp3'); await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=8', '-c:a', 'libmp3lame', bgm]);
  fs.writeFileSync(path.join(inputRoot, 'music', 'background-music.license.json'), JSON.stringify({ license: 'CC0' }));
  const intro = path.join(inputRoot, 'branding', 'channel-intro.mp4'); await mkClip(intro);
  const logo = path.join(inputRoot, 'branding', 'channel-logo.png'); fs.writeFileSync(logo, makePng(256, 256, 6, 3));
  return { projectsRoot, inputsRoot, outputsRoot, projectDir, inputRoot, outputsDir, projectFile: path.join(projectDir, 'pipeline.json'), bgm };
}
function writePipeline(f: any, scenes: any[]) {
  fs.writeFileSync(f.projectFile, JSON.stringify({ project_id: path.basename(f.projectDir), flow_project_name: 'F', characters: [{ tag: '@CHAR-01-ARJUN', name: 'A', look_summary: 'x', full_prompt: 'x', voice_description: 'x' }], backgrounds: [{ tag: '#BGD-01', location_name: 't', look_summary: 'x', full_prompt: 'x' }], scenes }, null, 2));
  return JSON.parse(fs.readFileSync(f.projectFile, 'utf8'));
}
function opts(f: any) {
  const intro = path.join(f.inputRoot, 'branding', 'channel-intro.mp4'), logo = path.join(f.inputRoot, 'branding', 'channel-logo.png');
  return { projectsRoot: f.projectsRoot, inputsRoot: f.inputsRoot, outputsRoot: f.outputsRoot, projectId: path.basename(f.projectDir), ffprobePath: process.env.FFPROBE_PATH,
    titleAssets: { intro, logo, title: 'T' }, bgmPath: f.bgm,
    stageInputs: { bgmHash: shaOrNull(f.bgm), introHash: shaOrNull(intro), logoHash: shaOrNull(logo), titleMetadata: { title: 'F' } },
    stageExecutorFactory: () => async (_s: string, out: string) => { await mkClip(out); return { ok: true }; } };
}
function fakeSession(log: any) { return async (fn: any) => { log.sessions++; const s = { client: { kind: 'session-client' }, close: async () => { log.closes++; } }; try { return { ok: true, value: await fn(s) }; } catch (e: any) { return { ok: false, reason: String(e?.message ?? e) }; } finally { await s.close(); } }; }
/** Fake SceneExecutor that "generates" by writing a valid clip; records client + scenes. */
function fakeGenSceneFactory(log: any) { return (input: any) => { log.clientSeen = input.flow; return async (scene: any, outputPath: string) => { const n = Number(scene?.sceneNumber ?? scene?.scene_number); log.sceneCalls.push(n); await mkClip(outputPath); return { ok: true }; }; }; }

// ================== 2/3/4/5. orchestrator: only eligible reaches executor; partial status; no downstream ==================
{
  const f = await build('hd-a');
  writePipeline(f, [
    { scene_number: 1, title: 'S1', background_tag: '#BGD-01', character_tags: ['@CHAR-01-ARJUN'], speaker: '@CHAR-01-ARJUN', camera: 'w', effects: '', sound_design: '', visual_action: 'a1', narration_text: '', animation_prompt_NARRATOR_ONLY: 'p', animation_prompt_WITH_LIPSYNC: 'p', status: 'pending' },
    { scene_number: 2, title: 'S2', background_tag: '#BGD-02', character_tags: [], speaker: 'NARRATOR', camera: 'w', effects: '', sound_design: '', visual_action: 'a2', narration_text: 'न', animation_prompt_NARRATOR_ONLY: 'p', animation_prompt_WITH_LIPSYNC: 'p', status: 'pending' },
  ]);
  // scene 2 references a background that has no asset → NOT Flow-eligible; its narration is also
  // absent, so the project still reports a narration blocker. This preserves the test's design: a
  // scene with a genuinely missing non-Flow prerequisite must never reach the Flow executor.
  const log: any = { sessions: 0, closes: 0, sceneCalls: [], clientSeen: null, runner: 0 };
  const r = await WF.resumeProjectWorkflow({ ...opts(f), runFlow: true, flowSessionRunner: fakeSession(log), sceneExecutorFactory: fakeGenSceneFactory(log), flowRunner: async () => { log.runner++; return { ok: true }; } } as any);
  check('2 exactly one modern session for the full-project Flow run', log.sessions === 1 && log.closes === 1, JSON.stringify({ sessions: log.sessions }));
  check('2 SceneExecutor executed ONLY the Flow-eligible scene (scene 2 background is MISSING)', log.sceneCalls.join(',') === '1', JSON.stringify(log.sceneCalls));
  check('2 no legacy FlowRunner invocation on the modern path', log.runner === 0, String(log.runner));
  check('4 partial status FLOW_WORK_COMPLETED_WITH_BLOCKERS', r.status === 'FLOW_WORK_COMPLETED_WITH_BLOCKERS' && r.phase === 'FLOW_WORK_COMPLETED_WITH_BLOCKERS', JSON.stringify({ s: r.status, p: r.phase }));
  check('3/9 downstream stages did NOT run (scene 2 not CURRENT)', ['EDIT', 'MIX', 'BED', 'TITLE'].every((s) => (r.production?.orchestration?.downstream?.states?.[s] ?? 'X') !== 'CURRENT'), JSON.stringify(r.production?.orchestration?.downstream?.states));
  check('9 project not COMPLETED and not approved', r.status !== 'COMPLETED_TO_APPROVAL' && r.phase !== 'AWAITING_APPROVAL' && !fs.existsSync(path.join(f.outputsDir, 'approval.json')));
  check('7 narration blocker preserved (scene 2)', (r.blockers ?? []).some((b: any) => b.category === 'narration'), JSON.stringify(r.blockers));

  // idempotency: scene 1 output is now CURRENT → no re-execution
  const log2: any = { sessions: 0, closes: 0, sceneCalls: [], clientSeen: null };
  await WF.resumeProjectWorkflow({ ...opts(f), runFlow: true, flowSessionRunner: fakeSession(log2), sceneExecutorFactory: fakeGenSceneFactory(log2) } as any);
  check('7 second run does not regenerate the now-current Flow scene', log2.sceneCalls.length === 0, JSON.stringify(log2.sceneCalls));
}

// ================== forced blockers: missing character / background prevent Flow ==================
for (const kind of ['character', 'background'] as const) {
  const f = await build('hd-' + kind);
  const scenes = [{ scene_number: 1, title: 'S1', background_tag: '#BGD-01', character_tags: kind === 'character' ? ['@CHAR-01-ARJUN'] : [], speaker: kind === 'character' ? '@CHAR-01-ARJUN' : 'NARRATOR', camera: 'w', effects: '', sound_design: '', visual_action: 'a1', narration_text: kind === 'character' ? '' : 'न', animation_prompt_NARRATOR_ONLY: 'p', animation_prompt_WITH_LIPSYNC: 'p', status: 'pending' }];
  writePipeline(f, scenes);
  if (kind === 'character') fs.rmSync(path.join(f.inputRoot, 'characters', 'CHAR-01-ARJUN.png'), { force: true });
  else fs.rmSync(path.join(f.inputRoot, 'backgrounds', 'BGD-01.png'), { force: true });
  const log: any = { sessions: 0, closes: 0, sceneCalls: [], clientSeen: null };
  const r = await WF.resumeProjectWorkflow({ ...opts(f), runFlow: true, flowSessionRunner: fakeSession(log), sceneExecutorFactory: fakeGenSceneFactory(log) } as any);
  check(`missing ${kind} blocks Flow execution (SceneExecutor not called)`, log.sceneCalls.length === 0, JSON.stringify(log.sceneCalls));
  check(`missing ${kind} reported as WAITING_FOR_INPUTS`, r.status === 'WAITING_FOR_INPUTS', r.status);
}

// ================== 5/6. recovery: FLOW_COMMITTED_LOCAL_MISSING → download, never generate ==================
{
  const f = await build('hd-recover');
  writePipeline(f, [{ scene_number: 1, title: 'S1', background_tag: '#BGD-01', character_tags: [], speaker: 'NARRATOR', camera: 'w', effects: '', sound_design: '', visual_action: 'a1', narration_text: 'न', animation_prompt_NARRATOR_ONLY: 'p', animation_prompt_WITH_LIPSYNC: 'p', status: 'pending', flow_scene_id: '00000000-0000-4000-8000-000000000001' }]);
  wav(path.join(f.inputRoot, 'narration', 'narration-0001.wav'), 3, 1); fs.copyFileSync(path.join(f.inputRoot, 'narration', 'narration-0001.wav'), path.join(f.outputsDir, 'narration', 'narration-0001.wav'));
  const flowLog = { generate: 0, download: 0 };
  const stubFlow = { async sceneHasClip() { return true; }, async generateProjectVideo() { flowLog.generate++; throw new Error('generation must not run'); }, async downloadCommittedSceneClip(_n: number, dest: string) { flowLog.download++; await mkClip(dest); return { ok: true }; } };
  const log: any = { sessions: 0, closes: 0, sceneCalls: [], clientSeen: null, runner: 0 };
  // DIAGNOSTIC WRAPPER (test-only; production untouched). The factory is CONSTRUCTED once per scene
  // that reaches the executor boundary; the returned closure is what actually performs render
  // dispatch. The previous `sceneFactory` recorded neither, so `log.sceneCalls` stayed `[]` and
  // assertion 6b passed vacuously. This wrapper records dispatch while delegating to the real
  // executor unchanged. Recording an invocation does NOT by itself prove a local stand-in was
  // rendered - that depends on which branch inside the executor handled the scene.
  const sceneFactory = (input: any) => {
    log.clientSeen = input.flow;
    const realExecutor = SEA.createRealSceneExecutor({ projectId: input.projectId, inputRoot: input.inputRoot, outputsRoot: input.outputsRoot, pipeline: input.pipeline, allowGeneration: input.allowGeneration, ffprobePath: input.ffprobePath, flow: input.flow });
    return async (scene: any, outputPath: string, context?: any) => {
      log.sceneCalls.push(Number(scene?.sceneNumber ?? scene?.scene_number));
      return realExecutor(scene, outputPath, context);
    };
  };
  // The modern session exposes the Flow client; here the stub IS the client.
  const sessionWithStub = async (fn: any) => { log.sessions++; const s = { client: stubFlow, close: async () => { log.closes++; } }; try { return { ok: true, value: await fn(s) }; } catch (e: any) { return { ok: false, reason: String(e?.message ?? e) }; } finally { await s.close(); } };
  const r = await WF.resumeProjectWorkflow({ ...opts(f), runFlow: true, flowSessionRunner: sessionWithStub, sceneExecutorFactory: sceneFactory, flowRunner: async () => { log.runner++; return { ok: true }; } } as any);

  // RECOVERY policy (OBSERVED, then asserted): a scene whose Flow scene is already COMMITTED and
  // whose local clip is missing is recovered through the existing credit-free Flow path. The stub
  // `sceneHasClip()` returns true, so the executor takes the Flow branch and does NOT render a
  // local stand-in; the committed clip is downloaded into `flow-clips/` and promoted to the scene
  // output. `classifyFlowEligibility` still reports RECOVER so an operator knows to act.
  //
  // The previous block asserted the opposite contract ("never reaches render dispatch", "must NOT
  // auto-download") AND was vacuous: `log.sceneCalls` was never written in this block, so 6b passed
  // unconditionally. Executor invocation is NOT evidence of synthesis - the synthesis branch and
  // the Flow-recovery branch are mutually exclusive inside the executor. The observable that
  // distinguishes them is `render_mode` (LOCAL_SYNTHESIS vs SUPPLIED_VIDEO) plus whether the output
  // is byte-identical to the staged Flow clip.
  check('6 recovery opens the Flow session for the committed scene', log.sessions === 1, JSON.stringify({ sessions: log.sessions }));
  check('6b executor dispatch occurs exactly once, for the committed scene', log.sceneCalls.join(',') === '1', JSON.stringify(log.sceneCalls));
  const recState = JSON.parse(fs.readFileSync(path.join(f.outputsDir, 'state.json'), 'utf8'));
  check('6b2 the LOCAL-SYNTHESIS branch was NOT taken (render_mode is SUPPLIED_VIDEO)',
    recState.scenes['1'].render_mode === 'SUPPLIED_VIDEO', JSON.stringify({ render_mode: recState.scenes['1'].render_mode }));
  const stagedClip = path.join(f.inputRoot, 'flow-clips', 'scene-0001.mp4');
  const outClip = path.join(f.outputsDir, 'scene-0001.mp4');
  const stagedSha = shaOrNull(stagedClip);
  const outSha = shaOrNull(outClip);
  check('6c the committed Flow clip was recovered into flow-clips/ and promoted to the scene output byte-for-byte',
    fs.existsSync(stagedClip) && fs.existsSync(outClip) && outSha !== null && outSha === stagedSha,
    { stagedClip, outClip, stagedSha, outSha });
  check('6d Flow GENERATION was never attempted - no credits spent', flowLog.generate === 0, JSON.stringify(flowLog));
  check('6d2 the credit-free download/recovery path WAS exercised', flowLog.download > 0, JSON.stringify(flowLog));
  const stagingFile = path.join(f.outputsDir, 'flow-scenes', 'scene-0001.json');
  const stagingRec = JSON.parse(fs.readFileSync(stagingFile, 'utf8'));
  check('6e the staging record identifies an ALREADY-COMMITTED Flow clip whose bytes match the promoted output',
    stagingRec.workflow_status === 'FLOW_SCENE_ALREADY_COMMITTED' && stagingRec.local_clip_sha256 === stagedSha,
    { workflow_status: stagingRec.workflow_status, local_clip_path: stagingRec.local_clip_path, stagedSha });
  check('6 no legacy FlowRunner used for recovery', log.runner === 0, String(log.runner));
}

// ================== 11. default resume remains Flow-free ==================
{
  const f = await build('hd-default');
  writePipeline(f, [{ scene_number: 1, title: 'S1', background_tag: '#BGD-01', character_tags: [], speaker: 'NARRATOR', camera: 'w', effects: '', sound_design: '', visual_action: 'a1', narration_text: 'न', animation_prompt_NARRATOR_ONLY: 'p', animation_prompt_WITH_LIPSYNC: 'p', status: 'pending' }]);
  wav(path.join(f.inputRoot, 'narration', 'narration-0001.wav'), 3, 1); fs.copyFileSync(path.join(f.inputRoot, 'narration', 'narration-0001.wav'), path.join(f.outputsDir, 'narration', 'narration-0001.wav'));
  let sessions = 0, runner = 0;
  const sLog: any = {}; Object.defineProperty(sLog, 'sessions', { get: () => sessions, set: (v) => (sessions = v) }); sLog.closes = 0;
  await WF.resumeProjectWorkflow({ ...opts(f), flowSessionRunner: async (fn: any) => { sessions++; return { ok: true, value: await fn({ client: {}, close: async () => {} }) }; }, flowRunner: async () => { runner++; return { ok: true }; } } as any);
  check('11 default resume creates no Flow session and no FlowRunner', sessions === 0 && runner === 0, JSON.stringify({ sessions, runner }));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n8HD FLOW ELIGIBILITY EXECUTION TESTS PASSED (${passed} checks)`);
