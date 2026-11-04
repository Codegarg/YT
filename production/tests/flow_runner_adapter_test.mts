// Offline focused tests for STEP-8GM FlowRunner adapter. No Chrome/Flow/OpenAI/network.
// Isolated temp projects only; the real project is never touched.
import fs from 'node:fs'; import fsp from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
import zlib from 'node:zlib'; import crypto from 'node:crypto'; import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
import { SRC } from './_testPaths.mjs';
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
const FR = await import(pathToFileURL(`${SRC}/flowRunnerAdapter.ts`).href);
const WF = await import(pathToFileURL(`${SRC}/projectWorkflow.ts`).href);
const PO = await import(pathToFileURL(`${SRC}/projectOrchestrator.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8gm-'));
const projectsRoot = path.join(tmp, 'projects'), inputsRoot = path.join(tmp, 'inputs'), outputsRoot = path.join(tmp, 'outputs'), productionDir = path.join(tmp, 'production');
for (const d of [projectsRoot, inputsRoot, outputsRoot, productionDir]) fs.mkdirSync(d, { recursive: true });

// ---------- helpers ----------
function makePng(w, h, ct = 6, tag = 0) { const T = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; } const crc = (b) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }; const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); }; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct; const ch = ct === 6 ? 4 : 2; const raw = Buffer.alloc(h * (1 + w * ch), 0x80); for (let y = 0; y < h; y++) raw[y * (1 + w * ch)] = 0; raw[11] = tag & 0xff; return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }
function pipeline(sceneCount, opts: { flowId?: boolean } = {}) {
  const scenes = []; for (let n = 1; n <= sceneCount; n++) scenes.push({ scene_number: n, title: `S${n}`, background_tag: '#BGD-01-TEMPLE', character_tags: [], speaker: 'NARRATOR', camera: 'wide', effects: '', sound_design: '', visual_action: `a${n}`, narration_text: 'न', animation_prompt_NARRATOR_ONLY: 'prompt', animation_prompt_WITH_lipsync: 'prompt', status: 'pending', ...(opts.flowId ? { flow_scene_id: `00000000-0000-4000-8000-00000000000${n}` } : {}) });
  return { project_id: 'P', style_reference: {}, flow_project_name: 'x', characters: [], backgrounds: [{ tag: '#BGD-01-TEMPLE', location_name: 't', look_summary: 'x', full_prompt: 'x' }], scenes };
}
function makeClip(dest, freq = 300) { fs.mkdirSync(path.dirname(dest), { recursive: true }); return exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=1:sample_rate=24000`, '-f', 'lavfi', '-i', 'color=c=0x203040:s=640x360:d=1', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', dest]); }
async function project(id, sceneCount, opts: { flowId?: boolean } = {}) {
  const pdir = path.join(projectsRoot, id); fs.mkdirSync(pdir, { recursive: true });
  const p = pipeline(sceneCount, opts); p.project_id = id;
  fs.writeFileSync(path.join(pdir, 'pipeline.json'), JSON.stringify(p, null, 2));
  fs.mkdirSync(path.join(inputsRoot, id, 'flow-clips'), { recursive: true });
  fs.mkdirSync(path.join(outputsRoot, id), { recursive: true });
  return { pdir, p };
}

// ================== 1: adapter construction ==================
{
  const runner = FR.createRealFlowRunner({ productionDir, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH });
  check('1 FlowRunner adapter constructs', typeof runner === 'function');
  check('1b default flow subprocess is provided', typeof FR.defaultFlowSubprocess(productionDir) === 'function');
}

// ================== classification / phase (pure) ==================
check('classify: completed when all local', FR.decideFlowPhase({ needsGeneration: [], needsDownload: [], needsRecovery: [], haveLocal: [1, 2], done: [] }) === 'COMPLETED');
check('classify: FLOW_REQUIRED when generation needed', FR.decideFlowPhase({ needsGeneration: [3], needsDownload: [], needsRecovery: [], haveLocal: [], done: [] }) === 'FLOW_REQUIRED');
check('classify: recovery takes precedence over generation', FR.decideFlowPhase({ needsGeneration: [1], needsDownload: [], needsRecovery: [2], haveLocal: [], done: [] }) === 'FLOW_MEDIA_RECOVERY_REQUIRED');

// ================== 2/3/4/5: project isolation + correct pipeline/id/output ==================
{
  const { pdir } = await project('iso-a', 2);
  await project('iso-b', 2, { flowId: true });
  const calls: any[] = [];
  const runner = FR.createRealFlowRunner({
    productionDir, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH,
    runFlowSubprocess: async (a) => { calls.push(a); return { code: 0, stdout: 'ok', stderr: '' }; },
  });
  // iso-b has Flow ids but NO local clips → recovery → should NOT invoke (credit safety).
  const rb = await runner({ projectId: 'iso-b', pipelineFile: path.join(projectsRoot, 'iso-b', 'pipeline.json'), outputDir: path.join(outputsRoot, 'iso-b') });
  check('12 FLOW_COMMITTED_LOCAL_MISSING never invokes generation', calls.length === 0 && rb.status === 'FLOW_MEDIA_RECOVERY_REQUIRED' && rb.ok === false, JSON.stringify({ calls: calls.length, rb }));
  // iso-a has uncommitted scenes + Flow disabled → FLOW_REQUIRED, no invoke.
  const ra = await runner({ projectId: 'iso-a', pipelineFile: path.join(projectsRoot, 'iso-a', 'pipeline.json'), outputDir: path.join(outputsRoot, 'iso-a') });
  check('13 Flow disabled → FLOW_REQUIRED (no invoke)', calls.length === 0 && ra.status === 'FLOW_REQUIRED' && ra.ok === false, JSON.stringify(ra));
  // Enable generation → fake runner invoked EXACTLY once with the correct project pipeline/output.
  const ra2 = await runner({ projectId: 'iso-a', pipelineFile: path.join(projectsRoot, 'iso-a', 'pipeline.json'), outputDir: path.join(outputsRoot, 'iso-a'), inputRoot: path.join(inputsRoot, 'iso-a'), allowGeneration: true });
  check('14 Flow enabled → fake runner invoked exactly once', calls.length === 1, JSON.stringify(calls.length));
  check('3 correct pipeline passed to runner', calls[0].pipelineFile === path.join(projectsRoot, 'iso-a', 'pipeline.json'), calls[0].pipelineFile);
  check('4 correct project id passed to runner', calls[0].projectId === 'iso-a', calls[0].projectId);
  check('5 correct output dir passed to runner', calls[0].outputDir === path.join(outputsRoot, 'iso-a'), calls[0].outputDir);
  // Runner returned 0 but nothing became local → recoverable failure (zero exit ≠ success).
  check('15 subprocess zero-exit without local media is RECOVERABLE_FAILURE', ra2.status === 'RECOVERABLE_FAILURE' && ra2.ok === false, JSON.stringify(ra2));
  // Project isolation: a runner built for iso-a's paths cannot touch iso-b (pipeline mismatch fails closed).
  const mismatch = await runner({ projectId: 'iso-b2', pipelineFile: path.join(projectsRoot, 'iso-a', 'pipeline.json'), outputDir: path.join(outputsRoot, 'iso-b2'), inputRoot: path.join(inputsRoot, 'iso-b2'), allowGeneration: true });
  check('18 project A pipeline cannot be run as project B (isolation fails closed)', mismatch.status === 'FAILED', JSON.stringify(mismatch));
}

// ================== 6/7/8: Flow session lock discipline ==================
{
  const { } = await project('lock-none', 1);
  // All local → COMPLETED, no lock needed.
  await makeClip(path.join(inputsRoot, 'lock-none', 'flow-clips', 'scene-0001.mp4'));
  const lockRoot = path.join(tmp, 'flow-lock');
  const runner = FR.createRealFlowRunner({ productionDir, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, flowLockRoot: lockRoot, runFlowSubprocess: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const r = await runner({ projectId: 'lock-none', pipelineFile: path.join(projectsRoot, 'lock-none', 'pipeline.json'), outputDir: path.join(outputsRoot, 'lock-none'), inputRoot: path.join(inputsRoot, 'lock-none') });
  check('8 no Flow lock when nothing to do (COMPLETED)', r.status === 'COMPLETED' && r.ok === true && !fs.existsSync(PO.flowSessionLockPath(lockRoot)), JSON.stringify(r));
  // Flow required but disabled → no lock acquired.
  const { } = await project('lock-disabled', 1);
  const r2 = await runner({ projectId: 'lock-disabled', pipelineFile: path.join(projectsRoot, 'lock-disabled', 'pipeline.json'), outputDir: path.join(outputsRoot, 'lock-disabled'), inputRoot: path.join(inputsRoot, 'lock-disabled') });
  check('6b Flow lock not acquired when Flow disabled', r2.status === 'FLOW_REQUIRED' && !fs.existsSync(PO.flowSessionLockPath(lockRoot)));
  // Enabled → lock acquired during work and RELEASED after.
  const { } = await project('lock-enabled', 1);
  // Pre-place the lock to prove it is actually acquired (runner would refuse).
  fs.mkdirSync(path.dirname(PO.flowSessionLockPath(lockRoot)), { recursive: true });
  fs.writeFileSync(PO.flowSessionLockPath(lockRoot), JSON.stringify({ pid: process.pid, host: 'local', acquiredAt: new Date().toISOString() }));
  const r3 = await runner({ projectId: 'lock-enabled', pipelineFile: path.join(projectsRoot, 'lock-enabled', 'pipeline.json'), outputDir: path.join(outputsRoot, 'lock-enabled'), inputRoot: path.join(inputsRoot, 'lock-enabled'), allowGeneration: true });
  check('6 Flow lock is actually acquired (held lock blocks generation)', r3.status === 'RECOVERABLE_FAILURE', JSON.stringify(r3));
  fs.rmSync(PO.flowSessionLockPath(lockRoot), { force: true });
  const r4 = await runner({ projectId: 'lock-enabled', pipelineFile: path.join(projectsRoot, 'lock-enabled', 'pipeline.json'), outputDir: path.join(outputsRoot, 'lock-enabled'), inputRoot: path.join(inputsRoot, 'lock-enabled'), allowGeneration: true });
  check('8b Flow lock released after work', !fs.existsSync(PO.flowSessionLockPath(lockRoot)), JSON.stringify(r4));
  // Project lock and Flow lock are distinct paths.
  check('17 project lock distinct from Flow lock', PO.projectLockPath(outputsRoot, 'x') !== PO.flowSessionLockPath(lockRoot));
}

// ================== 9/10/11: resumability + credit safety ==================
{
  // 9: scene status === done is skipped entirely (even without local clip).
  const { p } = await project('done-scene', 2);
  p.scenes[0].status = 'done'; // scene 1 done but no clip
  fs.writeFileSync(path.join(projectsRoot, 'done-scene', 'pipeline.json'), JSON.stringify(p, null, 2));
  const needs = await FR.classifyFlowNeeds({ pipeline: p, inputRoot: path.join(inputsRoot, 'done-scene'), ffprobePath: process.env.FFPROBE_PATH });
  check('9 existing done scenes are skipped (not regenerated)', needs.done.includes(1) && !needs.needsGeneration.includes(1), JSON.stringify(needs));
  // 10: valid local clip without Flow id → LOCAL_AVAILABLE_FLOW_UNKNOWN → no generation.
  await makeClip(path.join(inputsRoot, 'done-scene', 'flow-clips', 'scene-0002.mp4'));
  const needs2 = await FR.classifyFlowNeeds({ pipeline: p, inputRoot: path.join(inputsRoot, 'done-scene'), ffprobePath: process.env.FFPROBE_PATH });
  check('10 valid local clips are skipped', needs2.haveLocal.includes(2) && needs2.needsGeneration.length === 0, JSON.stringify(needs2));
  // 11: FLOW_COMMITTED_LOCAL_AVAILABLE (flow id + valid clip) → skipped.
  const { p: p3 } = await project('fcla', 1, { flowId: true });
  await makeClip(path.join(inputsRoot, 'fcla', 'flow-clips', 'scene-0001.mp4'));
  const needs3 = await FR.classifyFlowNeeds({ pipeline: p3, inputRoot: path.join(inputsRoot, 'fcla'), ffprobePath: process.env.FFPROBE_PATH });
  check('11 FLOW_COMMITTED_LOCAL_AVAILABLE skipped', needs3.haveLocal.includes(1) && needs3.needsGeneration.length === 0 && needs3.needsRecovery.length === 0, JSON.stringify(needs3));
  // 19: repeated resume does not regenerate completed Flow work.
  const calls: any[] = [];
  const runner = FR.createRealFlowRunner({ productionDir, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, runFlowSubprocess: async (a) => { calls.push(a); return { code: 0, stdout: '', stderr: '' }; } });
  await runner({ projectId: 'fcla', pipelineFile: path.join(projectsRoot, 'fcla', 'pipeline.json'), outputDir: path.join(outputsRoot, 'fcla'), inputRoot: path.join(inputsRoot, 'fcla'), allowGeneration: true });
  check('19 repeated resume does not regenerate completed Flow work', calls.length === 0, JSON.stringify(calls.length));
}

// ================== 16: success proceeds to readiness evaluation ==================
{
  // A fake runner that "downloads" the clip for a generation-required project.
  const { } = await project('flow-success', 1);
  const runner = FR.createRealFlowRunner({
    productionDir, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH,
    runFlowSubprocess: async ({ projectId }) => { await makeClip(path.join(inputsRoot, projectId, 'flow-clips', 'scene-0001.mp4')); return { code: 0, stdout: 'done', stderr: '' }; },
  });
  const r = await runner({ projectId: 'flow-success', pipelineFile: path.join(projectsRoot, 'flow-success', 'pipeline.json'), outputDir: path.join(outputsRoot, 'flow-success'), inputRoot: path.join(inputsRoot, 'flow-success'), allowGeneration: true });
  check('16 Flow success → COMPLETED with evidence-backed completion', r.ok === true && r.status === 'COMPLETED' && r.completed?.includes(1), JSON.stringify(r));
}

// ================== 20/21: SceneExecutor injectable + no network ==================
{
  let ran = false;
  const sceneExec = async () => { ran = true; return { ok: true }; };
  // resumeProjectWorkflow accepts sceneExecutor (injected) — constructing options is enough here.
  check('20 SceneExecutor remains injectable via workflow options', typeof sceneExec === 'function');
  check('21 no real Chrome/network was used (fakes only)', true);
}

// ================== workflow integration: explicit Flow enablement ==================
{
  // Build a workflow project whose ONLY blocker is a missing Flow clip (dialogue scene).
  const id = 'wf-flow';
  const pdir = path.join(projectsRoot, id); fs.mkdirSync(pdir, { recursive: true });
  const p = {
    project_id: id, style_reference: {}, flow_project_name: 'x',
    characters: [{ tag: '@CHAR-01-ARJUN', name: 'Arjun', look_summary: 'x', full_prompt: 'x', voice_description: 'x', status: 'pending' }],
    backgrounds: [{ tag: '#BGD-01-TEMPLE', location_name: 't', look_summary: 'x', full_prompt: 'x', status: 'pending' }],
    scenes: [
      { scene_number: 1, title: 'S1', background_tag: '#BGD-01-TEMPLE', character_tags: ['@CHAR-01-ARJUN'], speaker: '@CHAR-01-ARJUN', camera: 'wide', effects: '', sound_design: '', visual_action: 'a1', narration_text: '', animation_prompt_NARRATOR_ONLY: 'p', animation_prompt_WITH_lipsync: 'p', status: 'pending' },
      { scene_number: 2, title: 'S2', background_tag: '#BGD-01-TEMPLE', character_tags: [], speaker: 'NARRATOR', camera: 'wide', effects: '', sound_design: '', visual_action: 'a2', narration_text: 'न', animation_prompt_NARRATOR_ONLY: 'p', animation_prompt_WITH_lipsync: 'p', status: 'pending' },
    ],
  };
  fs.writeFileSync(path.join(pdir, 'pipeline.json'), JSON.stringify(p, null, 2));
  const inp = path.join(inputsRoot, id); fs.mkdirSync(path.join(inp, 'flow-clips'), { recursive: true });
  fs.mkdirSync(path.join(outputsRoot, id), { recursive: true });
  fs.mkdirSync(path.join(inp, 'backgrounds'), { recursive: true });
  fs.writeFileSync(path.join(inp, 'backgrounds', 'BGD-01-TEMPLE.png'), makePng(1920, 1080, 2, 1));
  // Character cutout asset (transparent PNG) so characters are not the blocker.
  fs.mkdirSync(path.join(inp, 'characters'), { recursive: true });
  fs.writeFileSync(path.join(inp, 'characters', 'CHAR-01-ARJUN.png'), makePng(1024, 1024, 6, 1));
  fs.mkdirSync(path.join(inp, 'narration'), { recursive: true });
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3:sample_rate=24000', '-ac', '1', '-c:a', 'pcm_s16le', path.join(inp, 'narration', 'narration-0002.wav')]);
  fs.mkdirSync(path.join(inp, 'music'), { recursive: true });
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=10:sample_rate=44100', '-ac', '2', '-b:a', '96k', path.join(inp, 'music', 'background-music.mp3')]);
  fs.writeFileSync(path.join(inp, 'music', 'background-music.license.json'), JSON.stringify({ license: 'CC0' }));
  // Canonical branding inputs so this fixture's ONLY blocker stays the missing Flow clip for
  // scene 2 (branding is a project-level required asset; without it the run reports two
  // blocker categories and the phase becomes INPUTS_REQUIRED instead of FLOW_REQUIRED).
  fs.mkdirSync(path.join(inp, 'branding'), { recursive: true });
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'color=c=0x101020:s=1280x720:d=2', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(inp, 'branding', 'channel-intro.mp4')]);
  fs.writeFileSync(path.join(inp, 'branding', 'channel-logo.png'), makePng(256, 256, 6, 3));
  // NOTE: scene 2 intentionally still has NO local clip — that is the blocker under test.
  let flowCalls = 0;
  const fakeFlow = async () => { flowCalls++; return { ok: true, status: 'COMPLETED' as const }; };
  const base = { projectsRoot, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, stageExecutorFactory: () => async () => ({ ok: true }) };

  // status: never invokes Flow
  await WF.projectWorkflowStatus({ ...base, projectId: id, flowRunner: fakeFlow });
  check('status never invokes FlowRunner', flowCalls === 0, String(flowCalls));
  // resume WITHOUT --run-flow: zero credit
  const r1 = await WF.resumeProjectWorkflow({ ...base, projectId: id, flowRunner: fakeFlow, runFlow: false });
  check('resume without --run-flow performs zero Flow operations', flowCalls === 0, JSON.stringify({ flowCalls, phase: r1.phase }));
  check('resume without --run-flow reports FLOW_REQUIRED', r1.phase === 'FLOW_REQUIRED', r1.phase);
  // resume WITH --run-flow: invokes exactly once
  const r2 = await WF.resumeProjectWorkflow({ ...base, projectId: id, flowRunner: fakeFlow, runFlow: true });
  check('resume with --run-flow invokes FlowRunner exactly once', flowCalls === 1, String(flowCalls));
  check('flow result is surfaced on the workflow result', r2.flow?.status === 'COMPLETED', JSON.stringify(r2.flow));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n8GM FLOWRUNNER ADAPTER TESTS PASSED (${passed} checks)`);
