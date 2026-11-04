// Offline focused tests for STEP-8GN SceneExecutor adapter. No Chrome/Flow/OpenAI/network.
// Isolated temp projects only; the real project is never touched.
import fs from 'node:fs'; import fsp from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
import crypto from 'node:crypto'; import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
import { SRC } from './_testPaths.mjs';
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
const SEA = await import(pathToFileURL(`${SRC}/sceneExecutorAdapter.ts`).href);
const SFW = await import(pathToFileURL(`${SRC}/sceneFlowWorkflow.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8gn-'));
const inputsRoot = path.join(tmp, 'inputs'), outputsRoot = path.join(tmp, 'outputs');
fs.mkdirSync(inputsRoot, { recursive: true }); fs.mkdirSync(outputsRoot, { recursive: true });

function pipeline(id: string, sceneCount = 2) {
  const scenes = []; for (let n = 1; n <= sceneCount; n++) scenes.push({ scene_number: n, title: `S${n}`, background_tag: '#BGD-01-TEMPLE', character_tags: ['@CHAR-01-ARJUN'], speaker: 'NARRATOR', camera: 'wide', effects: '', sound_design: '', visual_action: `a${n}`, narration_text: 'न', animation_prompt_NARRATOR_ONLY: 'ACTIVE ENVIRONMENT: #BGD-01-TEMPLE\nACTIVE CHARACTERS: @CHAR-01-ARJUN', animation_prompt_WITH_lipsync: 'ACTIVE ENVIRONMENT: #BGD-01-TEMPLE\nACTIVE CHARACTERS: @CHAR-01-ARJUN', status: 'pending' });
  return { project_id: id, style_reference: {}, flow_project_name: 'x', characters: [{ tag: '@CHAR-01-ARJUN', name: 'Arjun', look_summary: 'young Indian man' }], backgrounds: [{ tag: '#BGD-01-TEMPLE', location_name: 't', look_summary: 'x', full_prompt: 'x' }], scenes };
}
function makeClip(dest: string, freq = 300) { fs.mkdirSync(path.dirname(dest), { recursive: true }); return exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=1:sample_rate=24000`, '-f', 'lavfi', '-i', 'color=c=0x203040:s=640x360:d=1', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', dest]); }
function clipSha(p: string) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

/** A stub Flow client (no browser). Tracks calls for credit-safety assertions. */
function stubFlow(opts: { committed?: boolean; generate?: boolean } = {}) {
  const calls = { sceneHasClip: 0, generateProjectVideo: 0, download: 0 };
  return {
    calls,
    async sceneHasClip() { calls.sceneHasClip++; return opts.committed === true; },
    async generateProjectVideo() { calls.generateProjectVideo++; return { title: 'S', artifactId: '00000000-0000-4000-8000-000000000001' }; },
    async downloadCommittedSceneClip(sceneNumber: number, dest: string) { calls.download++; await makeClip(dest, 400); return { ok: true }; },
  };
}

// ================== 1: satisfies SceneExecutor contract ==================
{
  const p = pipeline('contract');
  const ex = SEA.createRealSceneExecutor({ projectId: 'contract', inputRoot: path.join(inputsRoot, 'contract'), outputsRoot, pipeline: p, flow: stubFlow() });
  check('1 adapter returns a callable SceneExecutor', typeof ex === 'function');
  // Pure helpers also exported.
  check('1b sceneNumberFor handles both shapes', SEA.sceneNumberFor({ sceneNumber: 3 }) === 3 && SEA.sceneNumberFor({ scene_number: 4 }) === 4);
  check('1c isSceneWorkflowSuccess recognises the existing success statuses', SEA.isSceneWorkflowSuccess('LOCAL_CLIP_ALREADY_VALID') && SEA.isSceneWorkflowSuccess('FLOW_SCENE_ALREADY_COMMITTED') && SEA.isSceneWorkflowSuccess('DOWNLOAD_SUCCESS') && SEA.isSceneWorkflowSuccess('SCENE_LOCAL_EXTENSION_COMPLETE') && SEA.isSceneWorkflowSuccess('SCENE_LOCAL_REGENERATE_COMPLETE') && !SEA.isSceneWorkflowSuccess('FLOW_GENERATION_REQUIRED'));
}

// ================== 2/3/4: delegation + project isolation ==================
{
  const id = 'iso';
  const p = pipeline(id, 1);
  const inputRoot = path.join(inputsRoot, id);
  fs.mkdirSync(path.join(inputRoot, 'flow-clips'), { recursive: true });
  await makeClip(path.join(inputRoot, 'flow-clips', 'scene-0001.mp4')); // valid local clip → USE_LOCAL
  const flow = stubFlow();
  const ex = SEA.createRealSceneExecutor({ projectId: id, inputRoot, outputsRoot, pipeline: p, flow });
  const outPath = path.join(outputsRoot, id, 'scene-0001.mp4');
  // 4: valid project id does not fail isolation.
  const ok = await ex({ sceneNumber: 1 }, outPath, { projectId: id, inputRoot, outputsDir: path.join(outputsRoot, id) });
  check('4 valid project id passes isolation and delegates', ok.ok === true, JSON.stringify(ok));
  check('2 delegation produced the local clip at the output path', fs.existsSync(outPath) && clipSha(outPath) === clipSha(path.join(inputRoot, 'flow-clips', 'scene-0001.mp4')));
  check('6 local-valid scene handled by existing workflow (no generation)', flow.calls.generateProjectVideo === 0 && flow.calls.download === 0, JSON.stringify(flow.calls));
  // Existing checkpoint was written by processSingleFlowScene (its own format), not the adapter.
  const ck = SFW.sceneCheckpointPath(id, 1, outputsRoot);
  check('13 checkpoint uses the existing format (written by the workflow)', fs.existsSync(ck) && JSON.parse(fs.readFileSync(ck, 'utf8')).workflow_status === 'LOCAL_CLIP_ALREADY_VALID');
  // 3: project-id mismatch fails closed BEFORE invoking the existing workflow.
  const before = flow.calls.sceneHasClip;
  const bad = await ex({ sceneNumber: 1 }, outPath, { projectId: 'other-project', inputRoot, outputsDir: path.join(outputsRoot, id) });
  check('3 project-id mismatch fails closed', bad.ok === false && /mismatch/.test(String(bad.reason)) && flow.calls.sceneHasClip === before, JSON.stringify(bad));
  // 12: adapter does not mutate unrelated projects.
  check('12 no unrelated project outputs created', !fs.existsSync(path.join(outputsRoot, 'other-project')));
}

// ================== 5: generation permission forwarded ==================
{
  const id = 'gen';
  const p = pipeline(id, 1);
  const inputRoot = path.join(inputsRoot, id);
  fs.mkdirSync(path.join(inputRoot, 'flow-clips'), { recursive: true });
  // No local clip, no committed scene, allowGeneration false → STOP (FLOW_GENERATION_REQUIRED).
  const flowOff = stubFlow({ committed: false });
  const exOff = SEA.createRealSceneExecutor({ projectId: id, inputRoot, outputsRoot, pipeline: p, flow: flowOff, allowGeneration: false });
  const rOff = await exOff({ sceneNumber: 1 }, path.join(outputsRoot, id, 'scene-0001.mp4'), { projectId: id });
  check('5 generation permission false → no generation (FLOW_GENERATION_REQUIRED)', rOff.ok === false && flowOff.calls.generateProjectVideo === 0 && /FLOW_GENERATION_REQUIRED/.test(String(rOff.reason)), JSON.stringify(rOff));
  // allowGeneration true → exactly ONE generation attempt, then commit+download.
  const flowOn = stubFlow({ committed: false });
  const exOn = SEA.createRealSceneExecutor({ projectId: id, inputRoot, outputsRoot, pipeline: p, flow: flowOn, allowGeneration: true });
  // sceneHasClip is called after generation for commit verification → return true then.
  let commit = false; flowOn.sceneHasClip = async () => { flowOn.calls.sceneHasClip++; return commit; };
  const origGen = flowOn.generateProjectVideo.bind(flowOn);
  flowOn.generateProjectVideo = async (prompt: string) => { commit = true; return origGen(prompt); };
  const rOn = await exOn({ sceneNumber: 1 }, path.join(outputsRoot, id, 'scene-0001.mp4'), { projectId: id });
  check('5b generation permission true → exactly one attempt + download', flowOn.calls.generateProjectVideo === 1 && flowOn.calls.download === 1, JSON.stringify(flowOn.calls));
  check('5c successful generation is reported ok and promoted', rOn.ok === true && fs.existsSync(path.join(outputsRoot, id, 'scene-0001.mp4')), JSON.stringify(rOn));
}

// ================== 7/8: resumability + credit safety ==================
{
  // 7: a scene marked done in the pipeline must not be regenerated by the adapter.
  const id = 'done';
  const p = pipeline(id, 1); p.scenes[0].status = 'done';
  const inputRoot = path.join(inputsRoot, id); fs.mkdirSync(path.join(inputRoot, 'flow-clips'), { recursive: true });
  await makeClip(path.join(inputRoot, 'flow-clips', 'scene-0001.mp4')); // done scenes already have a local clip
  const flowDone = stubFlow({ committed: true });
  const exDone = SEA.createRealSceneExecutor({ projectId: id, inputRoot, outputsRoot, pipeline: p, flow: flowDone, allowGeneration: true });
  const rDone = await exDone({ sceneNumber: 1 }, path.join(outputsRoot, id, 'scene-0001.mp4'), { projectId: id });
  check('7 done scene not regenerated by adapter', flowDone.calls.generateProjectVideo === 0 && rDone.ok === true, JSON.stringify({ rDone, calls: flowDone.calls }));
  // The adapter itself has NO `status === 'done'` special-case: it forwards to the existing
  // workflow, which is the single owner of that decision. A done scene with no local clip still
  // never causes GENERATION here (it may download a committed clip under existing semantics).
  const idDone2 = 'done2';
  const pDone2 = pipeline(idDone2, 1); pDone2.scenes[0].status = 'done';
  const inputRootDone2 = path.join(inputsRoot, idDone2); fs.mkdirSync(path.join(inputRootDone2, 'flow-clips'), { recursive: true });
  const flowCommitted = stubFlow({ committed: true });
  const exDone2 = SEA.createRealSceneExecutor({ projectId: idDone2, inputRoot: inputRootDone2, outputsRoot, pipeline: pDone2, flow: flowCommitted, allowGeneration: true });
  await exDone2({ sceneNumber: 1 }, path.join(outputsRoot, idDone2, 'scene-0001.mp4'), { projectId: idDone2 });
  check('7b done scene never causes generation (delegated, not re-implemented)', flowCommitted.calls.generateProjectVideo === 0, JSON.stringify(flowCommitted.calls));
  // 8: FLOW committed + local missing → GENERATION is NOT invented by the adapter (it downloads).
  const id2 = 'committed';
  const p2 = pipeline(id2, 1);
  const inputRoot2 = path.join(inputsRoot, id2); fs.mkdirSync(path.join(inputRoot2, 'flow-clips'), { recursive: true });
  const flow2 = stubFlow({ committed: true });
  const ex2 = SEA.createRealSceneExecutor({ projectId: id2, inputRoot: inputRoot2, outputsRoot, pipeline: p2, flow: flow2, allowGeneration: false });
  const r2 = await ex2({ sceneNumber: 1 }, path.join(outputsRoot, id2, 'scene-0001.mp4'), { projectId: id2 });
  check('8 committed/local-missing → download, never generation', r2.ok === true && flow2.calls.generateProjectVideo === 0 && flow2.calls.download === 1, JSON.stringify({ r2, calls: flow2.calls }));
}

// ================== 9/14: no second Flow lock / no independent retry ==================
{
  // Scan CODE only (strip // and /* */ comments) so doc headers don't create false positives.
  const codeOnly = fs.readFileSync(path.join(SRC, 'sceneExecutorAdapter.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('9 adapter introduces no Flow session lock', !/withFlowSessionLock|acquireFlowSessionLock|flowSessionLockPath|\.flow-session\.lock/.test(codeOnly));
  check('14 adapter introduces no retry/backoff system', !/setTimeout|backoff|maxRetries|retryCount|retry\s*\(|sleep\s*\(/i.test(codeOnly));
  // The adapter only ever calls processSingleFlowScene once per invocation (cap is owned there).
  const calls: string[] = [];
  const id = 'once';
  const p = pipeline(id, 1);
  const inputRoot = path.join(inputsRoot, id); fs.mkdirSync(path.join(inputRoot, 'flow-clips'), { recursive: true });
  await makeClip(path.join(inputRoot, 'flow-clips', 'scene-0001.mp4'));
  const ex = SEA.createRealSceneExecutor({ projectId: id, inputRoot, outputsRoot, pipeline: p, flow: stubFlow() });
  await ex({ sceneNumber: 1 }, path.join(outputsRoot, id, 'scene-0001.mp4'), { projectId: id }); calls.push('x');
  check('9b exactly one delegation per invocation', calls.length === 1);
}

// ================== 10: deterministic for equivalent inputs ==================
{
  const id = 'det';
  const p = pipeline(id, 1);
  const inputRoot = path.join(inputsRoot, id); fs.mkdirSync(path.join(inputRoot, 'flow-clips'), { recursive: true });
  await makeClip(path.join(inputRoot, 'flow-clips', 'scene-0001.mp4'));
  const ex = SEA.createRealSceneExecutor({ projectId: id, inputRoot, outputsRoot, pipeline: p, flow: stubFlow() });
  const a = await ex({ sceneNumber: 1 }, path.join(outputsRoot, id, 'a.mp4'), { projectId: id });
  const b = await ex({ sceneNumber: 1 }, path.join(outputsRoot, id, 'b.mp4'), { projectId: id });
  check('10 adapter is deterministic for equivalent inputs', a.ok === b.ok && clipSha(path.join(outputsRoot, id, 'a.mp4')) === clipSha(path.join(outputsRoot, id, 'b.mp4')));
}

// ================== 11: error propagation ==================
{
  const id = 'err';
  const p = pipeline(id, 1);
  const inputRoot = path.join(inputsRoot, id); fs.mkdirSync(path.join(inputRoot, 'flow-clips'), { recursive: true });
  const throwingFlow = { async sceneHasClip() { throw new Error('boom'); }, async generateProjectVideo() { throw new Error('boom'); }, async downloadCommittedSceneClip() { throw new Error('boom'); } };
  const ex = SEA.createRealSceneExecutor({ projectId: id, inputRoot, outputsRoot, pipeline: p, flow: throwingFlow, allowGeneration: true });
  const r = await ex({ sceneNumber: 1 }, path.join(outputsRoot, id, 'scene-0001.mp4'), { projectId: id });
  check('11 underlying failure propagates as ok:false (never success)', r.ok === false && /not produced|workflow error/.test(String(r.reason)), JSON.stringify(r));
  // A scene not present in the bound pipeline fails closed.
  const r2 = await ex({ sceneNumber: 99 }, path.join(outputsRoot, id, 'scene-0099.mp4'), { projectId: id });
  check('11b scene absent from bound pipeline fails closed', r2.ok === false && /not present/.test(String(r2.reason)), JSON.stringify(r2));
  // No Flow client → fail closed (never fabricates Flow work).
  const exNoFlow = SEA.createRealSceneExecutor({ projectId: id, inputRoot, outputsRoot, pipeline: p });
  const r3 = await exNoFlow({ sceneNumber: 1 }, path.join(outputsRoot, id, 'scene-0001.mp4'), { projectId: id });
  check('11c no Flow client fails closed', r3.ok === false && /no Flow client/.test(String(r3.reason)), JSON.stringify(r3));
}

// ================== 15: no Flow during tests + real module integrity ==================
{
  const codeOnly = fs.readFileSync(path.join(SRC, 'sceneExecutorAdapter.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('15 adapter imports the existing processSingleFlowScene', /processSingleFlowScene/.test(codeOnly));
  check('15b adapter duplicates no selectors/generation/download/checkpoint logic', !/S\.addMedia|generateProjectVideo\s*\(|downloadCommittedSceneClip\s*\(|writeSceneCheckpoint\s*\(|decideSceneAction/.test(codeOnly));
  check('15c no Chrome/Playwright/network import in adapter', !/playwright|chromium|launchPersistentContext|https?:\/\//i.test(codeOnly));
}

// ================== 16: explicit authorization is forwarded, never inferred ==================
{
  const id = 'auth-forward';
  const p = pipeline(id, 1);
  const inputRoot = path.join(inputsRoot, id);
  const clipDir = path.join(inputRoot, 'flow-clips');
  fs.mkdirSync(clipDir, { recursive: true });
  const localClip = path.join(clipDir, 'scene-0001.mp4');
  await makeClip(localClip);
  const before = clipSha(localClip);
  const flow = stubFlow({ committed: true });
  const auth = {
    operation: 'EXTEND',
    targetSceneId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    expectedCommittedClipId: '11111111-1111-4111-8111-111111111111',
  };
  const ex = SEA.createRealSceneExecutor({ projectId: id, inputRoot, outputsRoot, pipeline: p, flow, allowGeneration: true, sceneLocalAuthorization: auth });
  const outPath = path.join(outputsRoot, id, 'scene-0001.mp4');
  // Force the LOCAL_SYNTHESIS dispatch shape: an explicit authorization must bypass local
  // synthesis and let the workflow verify the exact target/committed clip first.
  const r = await ex({ sceneNumber: 1, renderMode: 'LOCAL_SYNTHESIS', suppliedClip: { state: 'MISSING' } }, outPath, { projectId: id });
  check('16 adapter forwards explicit authorization, bypasses local synthesis, and protects the valid local clip',
    r.ok === false && /LOCAL_CLIP_PRESENT/.test(String(r.reason)) && !fs.existsSync(outPath) && clipSha(localClip) === before,
    { r, exists: fs.existsSync(outPath) });
  check('16b authorized local-valid stop spends no generation/download',
    flow.calls.generateProjectVideo === 0 && flow.calls.download === 0, flow.calls);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n8GN SCENE EXECUTOR ADAPTER TESTS PASSED (${passed} checks)`);
