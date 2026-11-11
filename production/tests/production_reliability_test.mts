// PHASE 5 — offline long-form production reliability tests.
//
// Everything runs in ISOLATED temp projects with injected fakes. No Chrome, no Flow, no OpenAI,
// no network, no credits, no publishing, and the real project is never touched.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);

import { SRC, FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;

const REL = await import(pathToFileURL(`${SRC}/reliability.ts`).href);
const PF = await import(pathToFileURL(`${SRC}/resourcePreflight.ts`).href);
const OC = await import(pathToFileURL(`${SRC}/outputContract.ts`).href);
const PO = await import(pathToFileURL(`${SRC}/projectOrchestrator.ts`).href);
const WF = await import(pathToFileURL(`${SRC}/sceneFlowWorkflow.ts`).href);
const GA = await import(pathToFileURL(`${SRC}/generationAttempts.ts`).href);
const VC = await import(pathToFileURL(`${SRC}/videoClip.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); return; }
  console.log(`FAIL ${label}`, detail ?? '');
  throw new Error(`FAIL ${label}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p5rel-'));
const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const H = (n: string) => sha(n).slice(0, 64);

// ---------------------------------------------------------------------------------------
// Shared derivation fixtures
// ---------------------------------------------------------------------------------------

const scene = (n: number, outputState = 'CURRENT', readiness = 'READY', hash: string | null = H(`scene-${n}`), renderKey: string | null = H(`key-${n}`)) => ({
  sceneNumber: n, readiness, outputState, outputHash: hash, renderKey,
});
const downstream = (edit: string, mix: string, bed: string, title: string, failedStages: string[] = []) => ({
  states: { EDIT: edit, MIX: mix, BED: bed, TITLE: title },
  failedStages,
  executedStages: [],
  keys: { EDIT: H('edit-key'), MIX: H('mix-key'), BED: H('bed-key'), TITLE: H('title-key') },
});
const allCurrentScenes = () => [scene(1), scene(2), scene(3)];
const allCurrentDownstream = () => downstream('CURRENT', 'CURRENT', 'CURRENT', 'CURRENT');
const pipelineEvidence = (n = 3) => ({ present: true, valid: true, scenes: Array.from({ length: n }, (_, i) => ({ scene_number: i + 1, speaker: 'NARRATOR', narration_text: `line ${i + 1}`, visual_action: 'x', background_tag: '#BGD-01', character_tags: [] })) });
const stageOf = (report: any, name: string) => report.stages.find((s: any) => s.stage === name);

// ---- 1. Fresh sequence: explicit stage states, no false completion --------------------
{
  const r = REL.deriveReliability({
    projectId: 'fresh',
    pipeline: pipelineEvidence(),
    scenes: [scene(1, 'MISSING_OUTPUT', 'READY', null), scene(2, 'MISSING_OUTPUT', 'READY', null)],
    narration: { present: [1, 2], missing: [] },
    downstream: downstream('NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED'),
    failedScenes: [],
    now: '2026-01-01T00:00:00.000Z',
  });
  check('1 fresh sequence: all 13 stages have an explicit state', r.stages.length === 13 && r.stages.every((s: any) => REL.STAGE_STATUSES.includes(s.status)));
  check('1b fresh sequence resumes at GENERATION', r.resume_from === 'GENERATION', r.resume_from);
  check('1c fresh sequence next gate is MEDIA_QA', r.next_gate === 'MEDIA_QA', r.next_gate);
  check('1d fresh sequence is never publishable', r.publishable === false && stageOf(r, 'PUBLISH_HANDOFF').status === 'blocked');
  check('1e fresh sequence schedules every missing stage in dependency order', r.work_set.join(',') === 'GENERATION,SCENE_ASSEMBLY,AUDIO_MIX,MUSIC_BED,FINAL_RENDER,MEDIA_QA', r.work_set);
}

// ---- 2. No-op resume: verified outputs are reused, nothing is re-run -----------------
{
  const qa = { status: 'PASS', artifactHash: H('final'), reportHash: H('qa-report'), generatedAt: '2026-01-01T00:00:00.000Z' };
  const r = REL.deriveReliability({
    projectId: 'noop',
    pipeline: pipelineEvidence(),
    scenes: allCurrentScenes(),
    narration: { present: [1, 2, 3] },
    downstream: allCurrentDownstream(),
    qa,
    approval: { status: 'APPROVED', finalOutputHash: H('final') },
  });
  check('2 no-op resume: nothing resumes', r.resume_from === null, r.resume_from);
  check('2b no-op resume: all gates satisfied (handoff is not a gate)', r.next_gate === null, r.next_gate);
  check('2c no-op resume: work set is empty', r.work_set.length === 0, r.work_set);
  check('2d no-op resume: production stages stay reusable', ['STORY', 'SCENE_PLANNING', 'NARRATION', 'GENERATION', 'SCENE_ASSEMBLY', 'AUDIO_MIX', 'MUSIC_BED', 'FINAL_RENDER'].every((s) => r.reusable.includes(s as any)), r.reusable);
}

// ---- 3. Invalid or missing scene output never counts as complete ---------------------
{
  const invalid = REL.deriveReliability({ projectId: 'inv', pipeline: pipelineEvidence(), scenes: [scene(1, 'INVALID_OUTPUT'), scene(2)], narration: { present: [1, 2] }, downstream: downstream('NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED'), failedScenes: [1] });
  check('3 invalid scene output → GENERATION failed', stageOf(invalid, 'GENERATION').status === 'failed' && stageOf(invalid, 'GENERATION').retry_count === 0);
  check('3b invalid scene output resumes at GENERATION', invalid.resume_from === 'GENERATION');
  const missing = REL.deriveReliability({ projectId: 'miss', pipeline: pipelineEvidence(), scenes: [scene(1, 'MISSING_OUTPUT', 'READY', null)], narration: { present: [1] }, downstream: downstream('NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED') });
  check('3c missing scene output → GENERATION pending, never completed', stageOf(missing, 'GENERATION').status === 'pending');
}

// ---- 4. Input invalidation: changed dependency invalidates dependents ----------------
{
  const r = REL.deriveReliability({
    projectId: 'inval',
    pipeline: pipelineEvidence(),
    scenes: allCurrentScenes(),
    narration: { present: [1, 2, 3] },
    downstream: downstream('CURRENT', 'STALE', 'STALE', 'STALE'),
  });
  check('4 changed scene input invalidates AUDIO_MIX and later', stageOf(r, 'SCENE_ASSEMBLY').status === 'completed' && stageOf(r, 'AUDIO_MIX').status === 'stale' && stageOf(r, 'FINAL_RENDER').status === 'stale');
  check('4b invalidation resumes at the earliest stale stage', r.resume_from === 'AUDIO_MIX', r.resume_from);
  check('4c upstream EDIT output stays reusable', r.reusable.includes('SCENE_ASSEMBLY' as any));
}

// ---- 5. Unrelated stages stay reusable ------------------------------------------------
{
  const r = REL.deriveReliability({
    projectId: 'unrelated',
    pipeline: pipelineEvidence(),
    scenes: [scene(1), scene(2, 'STALE', 'READY', H('scene-2')), scene(3)],
    narration: { present: [1, 2, 3] },
    downstream: downstream('STALE', 'NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED'),
  });
  check('5 one stale scene does not invalidate the story/planning/narration', ['STORY', 'SCENE_PLANNING', 'NARRATION'].every((s) => r.reusable.includes(s as any)), r.reusable);
  check('5b one stale scene marks GENERATION stale and resumes there', stageOf(r, 'GENERATION').status === 'stale' && r.resume_from === 'GENERATION');
}

// ---- 6. Interruption: STALE_UNKNOWN is never complete --------------------------------
{
  const r = REL.deriveReliability({ projectId: 'intr', pipeline: pipelineEvidence(), scenes: [scene(1, 'STALE_UNKNOWN')], narration: { present: [1] }, downstream: downstream('STALE_UNKNOWN', 'NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED') });
  check('6 interrupted run leaves GENERATION stale, not completed', stageOf(r, 'GENERATION').status === 'stale' && stageOf(r, 'SCENE_ASSEMBLY').status === 'stale');
  check('6b interruption resumes at GENERATION with an inspection decision', r.resume_from === 'GENERATION' && /invalidated|verif/i.test(stageOf(r, 'GENERATION').reuse_or_rerender_reason));
}

// ---- 7. Output written before checkpoint (crash window) ------------------------------
{
  const r = REL.deriveReliability({ projectId: 'crash', pipeline: pipelineEvidence(), scenes: [scene(1, 'MISSING_OUTPUT', 'READY', H('file-on-disk-no-sidecar'))], narration: { present: [1] }, downstream: downstream('NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED') });
  check('7 output present without a checkpoint is NOT treated as complete', stageOf(r, 'GENERATION').status === 'pending' && !r.reusable.includes('GENERATION' as any));
  check('7b crash window resumes at GENERATION', r.resume_from === 'GENERATION');
}

// ---- 8. FFmpeg/stage failure ----------------------------------------------------------
{
  const r = REL.deriveReliability({ projectId: 'fffail', pipeline: pipelineEvidence(), scenes: allCurrentScenes(), narration: { present: [1, 2, 3] }, downstream: downstream('CURRENT', 'NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED', ['MIX']) });
  check('8 a genuine stage failure is failed, not pending/stale', stageOf(r, 'AUDIO_MIX').status === 'failed');
  check('8b the failure names the stage and category', stageOf(r, 'AUDIO_MIX').error_category === 'STAGE_FAILED' && r.blockers.some((b: any) => b.stage === 'AUDIO_MIX'));
  check('8c a stage failure resumes at that stage', r.resume_from === 'AUDIO_MIX');
}

// ---- 9. Disk preflight ----------------------------------------------------------------
{
  const dir = path.join(tmp, 'preflight-disk');
  fs.mkdirSync(dir, { recursive: true });
  const okRun = async () => ({ stdout: 'ffmpeg version test', stderr: '' });
  const low = await PF.preflightProject({ projectId: 'disk', outputsDir: dir, sceneCount: 10, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runner: okRun, statfs: async () => ({ bsize: 1024, bavail: 4 }) });
  check('9 low disk space is a hard preflight blocker', low.ok === false && low.status === 'INSUFFICIENT_DISK' && low.blockers.some((b: any) => b.category === 'INSUFFICIENT_DISK'));
  const unknown = await PF.preflightProject({ projectId: 'disk2', outputsDir: dir, sceneCount: 10, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runner: okRun, statfs: async () => { throw new Error('not supported'); } });
  check('9b unknown disk capacity is a warning, not a failure', unknown.ok === true && unknown.status === 'UNKNOWN');
  check('9c the conservative estimate is positive and scales with scenes', PF.estimateProjectBytes({ sceneCount: 35 }) > PF.estimateProjectBytes({ sceneCount: 5 }));
}

// ---- 10. Lock contention and project isolation ---------------------------------------
{
  const lockRoot = path.join(tmp, 'locks');
  const a = await PO.acquireProjectLock({ outputsRoot: lockRoot, projectId: 'p10', host: 'H', now: 1000, pidAlive: async () => true });
  const b = await PO.acquireProjectLock({ outputsRoot: lockRoot, projectId: 'p10', host: 'H', now: 2000, pidAlive: async () => true });
  const other = await PO.acquireProjectLock({ outputsRoot: lockRoot, projectId: 'p10-other', host: 'H', now: 2000, pidAlive: async () => true });
  check('10 a second run on the same project is refused', a.ok === true && b.ok === false);
  check('10b another project can run concurrently', other.ok === true);
  if (a.ok) await a.handle.release();
  if (other.ok) await other.handle.release();
}

// ---- 11. Partial render is never valid and is never deleted --------------------------
{
  const partial = path.join(tmp, 'partial.mp4');
  fs.writeFileSync(partial, Buffer.from('not-a-real-mp4'));
  const before = crypto.createHash('sha256').update(fs.readFileSync(partial)).digest('hex');
  const verdict = await VC.validateVideoClip(partial, { ffprobePath: process.env.FFPROBE_PATH });
  check('11 a partial render fails media validation', verdict.state !== 'VALID', verdict.state);
  const r = REL.deriveReliability({ projectId: 'partial', pipeline: pipelineEvidence(), scenes: allCurrentScenes(), narration: { present: [1, 2, 3] }, downstream: downstream('CURRENT', 'CURRENT', 'INVALID_OUTPUT', 'NOT_STARTED') });
  check('11b an invalid recorded stage output is stale', stageOf(r, 'MUSIC_BED').status === 'stale');
  check('11c deriving reliability never deletes the partial file', fs.existsSync(partial) && crypto.createHash('sha256').update(fs.readFileSync(partial)).digest('hex') === before);
}

// ---- 12. Corrupt state fails closed --------------------------------------------------
{
  const file = path.join(tmp, 'corrupt-ledger.json');
  fs.writeFileSync(file, 'not json', 'utf8');
  const r = await GA.readGenerationLedger(file, { projectId: 'corrupt' });
  check('12 a corrupt ledger fails closed', r.ok === false && /not valid JSON/i.test(String(r.reason)));
  const state = REL.deriveReliability({ projectId: 'corrupt-story', pipeline: { present: true, valid: false, reason: 'malformed' }, scenes: [scene(1, 'MISSING_OUTPUT', 'READY', null)] });
  check('12b a malformed pipeline is a STORY failure, never completed', stageOf(state, 'STORY').status === 'failed');
}

// ---- 13. Missing dependency ----------------------------------------------------------
{
  const missing = await PF.checkDependency('ffmpeg', 'definitely-missing-binary-xyz', { runner: async () => { const e: any = new Error('not found'); e.code = 'ENOENT'; throw e; } });
  check('13 a missing binary is DEPENDENCY_MISSING', missing.ok === false && missing.error_category === 'DEPENDENCY_MISSING');
  const dir = path.join(tmp, 'preflight-dep');
  fs.mkdirSync(dir, { recursive: true });
  const report = await PF.preflightProject({ projectId: 'dep', outputsDir: dir, sceneCount: 2, ffmpegPath: 'definitely-missing-binary-xyz', ffprobePath: 'also-missing-xyz', runner: async () => { const e: any = new Error('not found'); e.code = 'ENOENT'; throw e; }, statfs: async () => ({ bsize: 4096, bavail: 1e9 }) });
  check('13b preflight blocks before rendering when a dependency is missing', report.ok === false && report.status === 'DEPENDENCY_MISSING' && report.blockers.length === 2);
}

// ---- 14. Invalid download must not become success, and must not touch the ledger -----
{
  const projectId = 'dl-invalid';
  const inputRoot = path.join(tmp, 'inputs', projectId);
  const outputsRoot = path.join(tmp, 'outputs');
  fs.mkdirSync(path.join(inputRoot, 'flow-clips'), { recursive: true });
  let downloads = 0;
  const flow = {
    sceneHasClip: async () => true,
    downloadCommittedSceneClip: async () => { downloads++; return { ok: true, result: 'DOWNLOAD_SUCCESS' }; },
  };
  const sceneDef = { scene_number: 1, speaker: 'NARRATOR', animation_prompt_NARRATOR_ONLY: 'a dark room' };
  const r = await WF.processSingleFlowScene(sceneDef, flow, { projectId, inputRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH });
  const cpPath = path.join(outputsRoot, projectId, 'flow-scenes', 'scene-0001.json');
  const cp = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
  check('14 a transport success with unusable media is DOWNLOAD_FAILED', r.status === 'DOWNLOAD_FAILED' && downloads === 1, r);
  check('14b the checkpoint never claims DOWNLOAD_SUCCESS', cp.workflow_status === 'DOWNLOAD_FAILED', cp.workflow_status);
  check('14c a committed download never creates a paid-attempt ledger', !fs.existsSync(path.join(outputsRoot, projectId, 'flow-scenes', 'generation-attempts.json')));
}

// ---- 15. Ambiguous paid submission is never auto-retried -----------------------------
{
  const projectId = 'ambiguous';
  const inputRoot = path.join(tmp, 'inputs', projectId);
  const outputsRoot = path.join(tmp, 'outputs');
  fs.mkdirSync(path.join(inputRoot, 'flow-clips'), { recursive: true });
  let generated = 0;
  const flow = {
    sceneHasClip: async () => false,
    generateProjectVideo: async () => { generated++; throw new Error('Timeout 15000ms exceeded'); },
    downloadCommittedSceneClip: async () => ({ ok: true }),
  };
  const assets = {
    backgrounds: [{ tag: '#BGD-01', location_name: 'Room', look_summary: 'dark room' }],
    characters: [{ tag: '@CHAR-01', name: 'Arjun', look_summary: 'young man' }],
  };
  const sceneDef = { scene_number: 2, speaker: 'NARRATOR', animation_prompt_NARRATOR_ONLY: 'ACTIVE ENVIRONMENT: #BGD-01\nACTIVE CHARACTERS: @CHAR-01' };
  const cfg = { projectId, inputRoot, outputsRoot, allowGeneration: true, ffprobePath: process.env.FFPROBE_PATH, ...assets };
  const first = await WF.processSingleFlowScene(sceneDef, flow, cfg);
  const second = await WF.processSingleFlowScene(sceneDef, flow, cfg);
  check('15 the first ambiguous submission runs once and fails', first.status === 'FLOW_GENERATION_FAILED' && generated === 1);
  check('15b the retry is BLOCKED instead of submitting again', second.status === 'FLOW_GENERATION_BLOCKED' && generated === 1, second);
}

// ---- 16. Phase 3 gate is preserved ---------------------------------------------------
{
  const blocked = REL.deriveReliability({ projectId: 'p3gate', pipeline: pipelineEvidence(), storyGate: { allowed: false, code: 'BLOCKED_BY_VALIDATION', reason: '2 structural blockers' }, scenes: allCurrentScenes(), narration: { present: [1, 2, 3] }, downstream: allCurrentDownstream() });
  check('16 a Phase 3 blocker blocks STORY_VALIDATION', stageOf(blocked, 'STORY_VALIDATION').status === 'blocked' && blocked.resume_from === 'STORY_VALIDATION');
  const unavailable = REL.deriveReliability({ projectId: 'p3missing', pipeline: pipelineEvidence(), storyValidation: { available: false, status: 'UNAVAILABLE', reason: 'validator not installed' }, scenes: allCurrentScenes(), narration: { present: [1, 2, 3] }, downstream: allCurrentDownstream() });
  check('16b an unavailable validator is never treated as a clean story', stageOf(unavailable, 'STORY_VALIDATION').status === 'blocked');
}

// ---- 17. Phase 4 QA gate is preserved ------------------------------------------------
{
  const r = REL.deriveReliability({ projectId: 'p4gate', pipeline: pipelineEvidence(), scenes: allCurrentScenes(), narration: { present: [1, 2, 3] }, downstream: allCurrentDownstream(), qa: { status: 'FAIL', artifactHash: H('final'), reportHash: H('qa') } });
  check('17 a QA FAIL blocks MEDIA_QA and HUMAN_REVIEW', stageOf(r, 'MEDIA_QA').status === 'failed' && stageOf(r, 'HUMAN_REVIEW').status === 'blocked');
  check('17b QA failure can never authorize an approval', stageOf(r, 'APPROVAL').status === 'pending' && r.publishable === false);
  const skipped = REL.deriveReliability({ projectId: 'p4skip', pipeline: pipelineEvidence(), scenes: allCurrentScenes(), narration: { present: [1, 2, 3] }, downstream: allCurrentDownstream(), qa: { status: 'SKIPPED', artifactHash: H('final'), reportHash: H('qa') } });
  check('17c SKIPPED QA is never treated as PASS', stageOf(skipped, 'MEDIA_QA').status === 'skipped');
}

// ---------------------------------------------------------------------------------------
// Output contract (read-only composition of Phase 4 QA + approval)
// ---------------------------------------------------------------------------------------

const FINAL_ASSET = 'final-title.mp4';
const qaCheck = (id: string, status: string, asset = FINAL_ASSET, actual: any = null, expected: any = null) => ({ id, asset, status, severity: status === 'FAIL' ? 'BLOCKER' : 'INFO', expected, actual, explanation: `${id} ${status}` });
const group = (checks: any[]): any => {
  const count = (s: string) => checks.filter((c) => c.status === s).length;
  const status = checks.some((c) => c.status === 'FAIL') ? 'FAIL' : checks.some((c) => c.status === 'WARNING') ? 'WARNING' : checks.length ? 'PASS' : 'SKIPPED';
  return { status, total: checks.length, pass: count('PASS'), warning: count('WARNING'), fail: count('FAIL'), skipped: count('SKIPPED'), blockers: count('FAIL'), warnings: count('WARNING'), checks };
};
function makeQa(overrides: any = {}) {
  const finalChecks = overrides.finalChecks ?? [
    qaCheck('video.stream', 'PASS'), qaCheck('audio.stream', 'PASS'),
    qaCheck('video.dimensions', 'PASS', FINAL_ASSET, { width: 1280, height: 720 }),
    qaCheck('video.aspect', 'PASS'), qaCheck('video.fps', 'PASS'),
    qaCheck('av.duration_match', 'PASS'), qaCheck('duration.expected', 'PASS'), qaCheck('final.duration_match', 'PASS'),
  ];
  const checks = [...finalChecks, ...(overrides.extraChecks ?? [])];
  const artifactHash = overrides.artifactHash ?? H('final');
  return {
    version: 1, readOnly: true, projectId: 'contract', generatedAt: '2026-01-01T00:00:00.000Z',
    status: overrides.status ?? (checks.some((c) => c.status === 'FAIL') ? 'FAIL' : checks.some((c) => c.status === 'WARNING') ? 'WARNING' : 'PASS'),
    artifactHash,
    reportHash: overrides.reportHash ?? H('qa-report'),
    artifacts: [{ asset: FINAL_ASSET, kind: 'final', sceneNumber: null, path: '/x/final-title.mp4', sha256: artifactHash, bytes: 10, durationSeconds: 300, fps: 24, width: 1280, height: 720, status: 'PASS', checks: finalChecks }],
    scenes: group(overrides.sceneChecks ?? []), narration: group(overrides.narrationChecks ?? []), final: group(finalChecks),
    counts: group(checks), checks, skipped: [],
  };
}
const approvedVerdict = (hash = H('final')) => ({
  status: 'APPROVED',
  record: { status: 'approved', approved_final_output_hash: hash, media_qa: { status: 'PASS', artifact_hash: hash, report_hash: H('qa-report'), generated_at: '2026-01-01T00:00:00.000Z', blockers: 0, warnings: 0, checks: [] } },
  finalOutputHash: hash,
  finalOutputPath: '/x/final-title.mp4',
});
const contractInput = (extra: any = {}) => ({
  projectId: 'contract',
  pipeline: { scenes: [] },
  outputsRoot: tmp,
  outputsDir: path.join(tmp, 'contract-out'),
  inputRoot: path.join(tmp, 'contract-in'),
  mediaQa: async () => makeQa(extra.qa),
  evaluateApproval: async () => extra.verdict ?? approvedVerdict(),
  now: '2026-01-01T00:00:00.000Z',
});

// ---- 18. Publishing is blocked without a real, hash-bound approval -------------------
{
  const dir = path.join(tmp, 'contract-out');
  fs.mkdirSync(dir, { recursive: true });
  const before = fs.readdirSync(dir).sort().join(',');
  const notApproved = await OC.evaluateOutputContract(contractInput({ verdict: { status: 'NOT_APPROVED', reason: 'no approval record exists' } }));
  check('18 no approval → not publishable, boundary blocked', notApproved.publishable === false && notApproved.publish_boundary === 'BLOCKED' && /approve/i.test(notApproved.publish_block_reason));
  const mismatched = await OC.evaluateOutputContract(contractInput({ verdict: approvedVerdict(H('other-artifact')) }));
  check('18b an approval for a different artifact cannot authorize publishing', mismatched.publishable === false && stageOfContract(mismatched, 'approval').status === 'FAIL');
  const approved = await OC.evaluateOutputContract(contractInput());
  check('18c only a QA-clean hash-bound approval is handoff-ready', approved.publishable === true && approved.publish_boundary === 'READY_FOR_EXTERNAL_PUBLISHER');
  check('18d the contract never writes anything', fs.readdirSync(dir).sort().join(',') === before);
}
function stageOfContract(report: any, category: string) { return report.checks.find((c: any) => c.category === category); }

// ---- 19. Clip reuse: a valid clip short-circuits all Flow work ----------------------
{
  const projectId = 'reuse';
  const inputRoot = path.join(tmp, 'inputs', projectId);
  const outputsRoot = path.join(tmp, 'outputs');
  const clips = path.join(inputRoot, 'flow-clips');
  fs.mkdirSync(clips, { recursive: true });
  const dest = path.join(clips, 'scene-0001.mp4');
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=640x360:d=1', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', dest]);
  let downloads = 0, generated = 0;
  const flow = {
    sceneHasClip: async () => false,
    generateProjectVideo: async () => { generated++; return { title: 'T', artifactId: 'u' }; },
    downloadCommittedSceneClip: async (_n: number, out: string) => { downloads++; await fsp.copyFile(dest, out); return { ok: true, result: 'DOWNLOAD_SUCCESS' }; },
  };
  const sceneDef = { scene_number: 1, speaker: 'NARRATOR', animation_prompt_NARRATOR_ONLY: 'a dark room' };
  const cfg = { projectId, inputRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH };
  const first = await WF.processSingleFlowScene(sceneDef, flow, cfg);
  const second = await WF.processSingleFlowScene(sceneDef, flow, cfg);
  check('19 a valid local clip is reused without regeneration or download', first.status === 'LOCAL_CLIP_ALREADY_VALID' && generated === 0 && downloads === 0, first);
  check('19b the second run is a true no-op (no download, no generation)', second.status === 'LOCAL_CLIP_ALREADY_VALID' && downloads === 0 && generated === 0, { second, downloads, generated });
}

// ---- 20. Protected outputs are never rewritten --------------------------------------
{
  const protectedFile = path.join(tmp, 'protected-final-title.mp4');
  fs.writeFileSync(protectedFile, 'approved-final-bytes');
  const before = crypto.createHash('sha256').update(fs.readFileSync(protectedFile)).digest('hex');
  REL.deriveReliability({ projectId: 'protect', pipeline: pipelineEvidence(), scenes: allCurrentScenes(), narration: { present: [1, 2, 3] }, downstream: allCurrentDownstream(), qa: { status: 'PASS', artifactHash: H('final'), reportHash: H('qa') }, approval: { status: 'APPROVED', finalOutputHash: H('final') } });
  await OC.evaluateOutputContract(contractInput());
  await PF.preflightProject({ projectId: 'protect', outputsDir: tmp, sceneCount: 1, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runner: async () => ({ stdout: 'v', stderr: '' }), statfs: async () => ({ bsize: 4096, bavail: 1e9 }) });
  const after = crypto.createHash('sha256').update(fs.readFileSync(protectedFile)).digest('hex');
  check('20 protected media bytes are unchanged by every Phase 5 path', before === after);
  const relSrc = fs.readFileSync(path.join(SRC, 'reliability.ts'), 'utf8');
  const ocSrc = fs.readFileSync(path.join(SRC, 'outputContract.ts'), 'utf8');
  check('20b reliability/contract source contains no media write/delete API', !/\bwriteFile\b|\brename\b|\bunlink\b|\bfsp\.rm\b/.test(relSrc) && !/\bwriteFile\b|\brename\b|\bunlink\b|\bfsp\.rm\b/.test(ocSrc));
}

// ---- 21. Diagnostics are secret- and machine-path-free ------------------------------
{
  const dirty = 'failed: api_key=SUPERSECRET authorization: Bearer abc.def C:\\Users\\TestUser\\Downloads\\clip.mp4 https://s3.example/x?Signature=abc123 blob:https://flow/x';
  const clean = REL.safeLogText(dirty);
  check('21 safeLogText removes credentials, signed URLs and machine paths', !/SUPERSECRET|abc\.def|Signature=abc123|blob:|C:\\\\Users/i.test(clean) && clean.includes('[redacted]') && clean.includes('<path>'), clean);
  check('21b containsSecretMaterial detects real secrets only', REL.containsSecretMaterial('api_key=abcdef') === true && REL.containsSecretMaterial('sha256 deadbeef') === false);
}

// ---- 22. Stage transition validation -------------------------------------------------
{
  const legal = REL.isLegalStageTransition('pending', 'completed') && REL.isLegalStageTransition('completed', 'stale') && REL.isLegalStageTransition('failed', 'running');
  const illegal = REL.isLegalStageTransition('completed', 'failed') === false && REL.isLegalStageTransition('skipped', 'failed') === false;
  check('22 legal transitions are accepted and illegal ones rejected', legal && illegal);
  let threw = false;
  try { REL.assertLegalStageTransition('completed', 'failed'); } catch { threw = true; }
  check('22b assertLegalStageTransition throws on an illegal jump', threw);
}

// ---- 23. Stage log records are complete, bounded and secret-free --------------------
{
  const entry = REL.buildStageLogEntry({
    projectId: 'log-project', stage: 'GENERATION', status: 'failed',
    startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:02.500Z',
    inputFingerprint: H('in'), outputFingerprint: null, retryCount: 2,
    errorCategory: 'SCENE_FAILED', recoveryDecision: 'diagnose-the-scene-and-resume',
    reuseOrRerenderReason: 'scene 3 failed', detail: 'api_key=SECRET C:\\Users\\TestUser\\clip.mp4',
  });
  check('23 a stage log record has every required field', ['project_id', 'stage', 'status', 'started_at', 'ended_at', 'duration_ms', 'input_fingerprint', 'output_fingerprint', 'retry_count', 'error_category', 'recovery_decision', 'reuse_or_rerender_reason', 'detail'].every((k) => k in entry));
  check('23b duration and retry count are measured, never fabricated', entry.duration_ms === 2500 && entry.retry_count === 2);
  check('23c the log detail is secret- and path-free', !/SECRET|C:\\\\Users/.test(entry.detail) && entry.detail.includes('[redacted]'));
}

// ---- 24. Contract maps every clause; missing evidence is never PASS ------------------
{
  const report = await OC.evaluateOutputContract(contractInput({
    qa: {
      finalChecks: [qaCheck('video.stream', 'PASS'), qaCheck('audio.stream', 'PASS'), qaCheck('video.dimensions', 'PASS'), qaCheck('video.aspect', 'PASS'), qaCheck('video.fps', 'FAIL', FINAL_ASSET, 12, 24), qaCheck('av.duration_match', 'PASS'), qaCheck('duration.expected', 'PASS')],
      extraChecks: [qaCheck('scenes.order', 'FAIL', 'project')],
    },
  }));
  check('24 a QA failure lands on the named contract clause', stageOfContract(report, 'fps').status === 'FAIL' && stageOfContract(report, 'scene_order').status === 'FAIL');
  check('24b the contract fails as a whole and names its blockers', report.status === 'FAIL' && report.blockers.length >= 2 && report.publishable === false);
  check('24c narration with no QA rows is SKIPPED, never PASS', stageOfContract(report, 'narration_coverage').status === 'SKIPPED');
  const rendered = OC.renderOutputContractReport(report);
  check('24d the human report names the publish boundary', /publish:\s+BLOCKED/.test(rendered));
}

console.log(`\n${passed} checks passed. Temp: ${tmp}`);
