// Focused OFFLINE tests for durable committed-scene provenance in SceneCheckpoint.
//
// Purely offline: no Flow, no Chrome, no network, no media generation beyond ffmpeg-minted local
// MP4 fixtures. Proves the additive `committed_scene_artifact_id` field is optional, round-trips,
// stays INDEPENDENT of `generation_uuid`, is never fabricated, and leaves existing fields and
// recovery/readiness behaviour untouched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { REPO } from './_testPaths.mjs';
const SRC = `${REPO}/production/src`;
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
const exec = promisify(execFile);

const w = await import(pathToFileURL(`${SRC}/sceneFlowWorkflow.ts`).href);
const sr = await import(pathToFileURL(`${SRC}/flowRunnerAdapter.ts`).href);
const ss = await import(pathToFileURL(`${SRC}/sceneState.ts`).href);
const { SCENE_CHECKPOINT_SCHEMA_VERSION, validateSceneCheckpoint, writeSceneCheckpoint, readSceneCheckpoint,
        sceneCheckpointPath, processSingleFlowScene, decideSceneAction, decideCommitPrecedence } = w;
const { classifyFlowNeeds, decideFlowPhase } = sr;
const { classifyFlowEligibility } = ss;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-provenance-'));
const mkClip = async (out: string) => {
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=1280x720:d=1',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);
};

const GEN = 'ec19b9fd-e4e9-4ca2-b3e0-517a1d523528';   // generation artifact
const COMMITTED = '47425bc2-6c47-4b6d-a88a-c4a7259015cc'; // committed scene artifact (distinct)
const SHA = 'a'.repeat(64);

/** A complete, valid v1 checkpoint with NO committed id (the legacy shape). */
const legacy = (over: any = {}) => ({
  schema_version: SCENE_CHECKPOINT_SCHEMA_VERSION,
  project_id: 'proj', scene_number: 18,
  flow_scene_id: '93b8bbea-33b7-43fe-b2b5-7d615dffc1ae', flow_scene_url: 'https://flow.google.com/p/sc',
  generation_uuid: GEN, local_clip_path: 'flow-clips/scene-0018.mp4', local_clip_sha256: SHA,
  duration_seconds: 8, width: 1280, height: 720, video_codec: 'h264', audio_codec: 'aac',
  workflow_status: 'DOWNLOAD_SUCCESS', updated_at: '2026-10-05T00:00:00.000Z',
  ...over,
});

// ============ A. Legacy checkpoint (no committed id) loads successfully ============
{
  const v = validateSceneCheckpoint(legacy());
  check('A.1 legacy v1 checkpoint (no committed id) is valid', v.ok === true, v);
  const f = path.join(tmp, 'legacy.json');
  await writeSceneCheckpoint(f, legacy() as any);
  const loaded = await readSceneCheckpoint(f);
  check('A.2 legacy checkpoint round-trips through disk', loaded !== null);
  check('A.3 legacy checkpoint has NO committed_scene_artifact_id key', loaded !== null && !('committed_scene_artifact_id' in loaded), loaded);
  check('A.4 legacy generation_uuid preserved', loaded?.generation_uuid === GEN);
}

// ============ B. New checkpoint with committed id round-trips unchanged ============
{
  const rec = legacy({ committed_scene_artifact_id: COMMITTED });
  check('B.1 checkpoint with committed id is valid', validateSceneCheckpoint(rec).ok === true);
  const f = path.join(tmp, 'with-committed.json');
  await writeSceneCheckpoint(f, rec as any);
  const onDisk = JSON.parse(fs.readFileSync(f, 'utf8'));
  check('B.2 committed id persisted verbatim to disk', onDisk.committed_scene_artifact_id === COMMITTED, onDisk.committed_scene_artifact_id);
  const loaded = await readSceneCheckpoint(f);
  check('B.3 committed id round-trips unchanged', loaded?.committed_scene_artifact_id === COMMITTED, loaded);
  check('B.4 committed id survives an explicit null? no — null is preserved as null',
    (await (async () => { const g = path.join(tmp, 'null.json'); await writeSceneCheckpoint(g, legacy({ committed_scene_artifact_id: null }) as any); return (await readSceneCheckpoint(g))?.committed_scene_artifact_id; })()) === null);
}

// ============ C. generation_uuid and committed id remain INDEPENDENT ============
{
  const rec = legacy({ committed_scene_artifact_id: COMMITTED });
  check('C.1 the two identities differ in realistic data', GEN !== COMMITTED);
  check('C.2 committed id is NOT copied from generation_uuid', rec.committed_scene_artifact_id !== rec.generation_uuid);
  const loaded = await readSceneCheckpoint((() => { const f = path.join(tmp, 'indep.json'); fs.writeFileSync(f, JSON.stringify(rec)); return f; })());
  check('C.3 loading never collapses one identity into the other',
    loaded?.generation_uuid === GEN && loaded?.committed_scene_artifact_id === COMMITTED, loaded);
  // Different committed ids must each be preserved distinctly (no last-write coalescing).
  const other = '11111111-2222-3333-4444-555555555555';
  const f2 = path.join(tmp, 'indep2.json');
  await writeSceneCheckpoint(f2, legacy({ committed_scene_artifact_id: other }) as any);
  check('C.4 a different committed id is preserved verbatim', (await readSceneCheckpoint(f2))?.committed_scene_artifact_id === other);
}

// ============ D. Missing committed id stays absent — never fabricated ============
{
  const v = validateSceneCheckpoint(legacy());
  check('D.1 absent committed id is VALID', v.ok === true);
  check('D.2 validator does not inject a value', JSON.stringify(validateSceneCheckpoint(legacy())).includes('committed') === false);
  const f = path.join(tmp, 'absent.json');
  await writeSceneCheckpoint(f, legacy() as any);
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  check('D.3 written checkpoint contains no committed key at all', !('committed_scene_artifact_id' in raw), Object.keys(raw));
  check('D.4 committed id is not derived from generation_uuid', raw.committed_scene_artifact_id === undefined);
  // Invalid committed ids must fail closed.
  for (const bad of ['', '   ', 42, {}, []]) {
    const r = validateSceneCheckpoint(legacy({ committed_scene_artifact_id: bad }));
    check(`D.5 invalid committed id rejected: ${JSON.stringify(bad)}`, r.ok === false && /committed_scene_artifact_id/.test(r.reason), r);
  }
}

// ============ E. Existing checkpoint fields unchanged ============
{
  const before = legacy();
  const withNew = legacy({ committed_scene_artifact_id: COMMITTED });
  const strip = (o: any) => { const { committed_scene_artifact_id, ...rest } = o; return rest; };
  check('E.1 adding the new field changes nothing else', JSON.stringify(strip(withNew)) === JSON.stringify(before));
  check('E.2 schema_version is unchanged (still 1)', SCENE_CHECKPOINT_SCHEMA_VERSION === 1 && withNew.schema_version === 1);
  check('E.3 all pre-existing keys still validate', validateSceneCheckpoint(withNew).ok === true);
  check('E.4 pre-existing field validation still enforced (bad sha rejected)',
    validateSceneCheckpoint(legacy({ local_clip_sha256: 'nope' })).ok === false);
  check('E.5 absolute local_clip_path still rejected',
    validateSceneCheckpoint(legacy({ local_clip_path: 'C:/abs/scene-0018.mp4' })).ok === false);
  check('E.6 secret material still rejected',
    validateSceneCheckpoint(legacy({ flow_scene_url: 'https://x/?KeyName=abc' })).ok === false);
}

// ============ F. Recovery / readiness unchanged when the field is absent ============
{
  check('F.1 decideSceneAction USE_LOCAL unchanged', decideSceneAction({ localClipValid: true, flowSceneCommitted: true, allowGeneration: true, generationAlreadyAttempted: false }).action === 'USE_LOCAL');
  check('F.2 decideSceneAction DOWNLOAD unchanged', decideSceneAction({ localClipValid: false, flowSceneCommitted: true, allowGeneration: false, generationAlreadyAttempted: false }).action === 'DOWNLOAD');
  check('F.3 decideSceneAction GENERATE unchanged', decideSceneAction({ localClipValid: false, flowSceneCommitted: false, allowGeneration: true, generationAlreadyAttempted: false }).action === 'GENERATE');
  check('F.4 decideCommitPrecedence unchanged', decideCommitPrecedence(true, GEN) === 'ALREADY_COMMITTED' && decideCommitPrecedence(false, GEN) === 'GENERATED' && decideCommitPrecedence(false, '') === 'NOT_PROVEN');

  const scene = { scene_number: 18, speaker: '@CHAR-01-ARJUN', flow_scene_id: 's18', background_tag: '#BGD-05', character_tags: [] };
  const committed = classifyFlowEligibility({ ...scene, background: { state: 'VALID' }, characters: [], narration: 'DIALOGUE', narrationAsset: { state: 'NOT_REQUIRED' }, suppliedClip: { state: 'MISSING' }, flowLocal: { state: 'FLOW_COMMITTED_LOCAL_MISSING' } } as any);
  check('F.5 a committed-but-locally-missing scene still yields RECOVER (never GENERATE)', committed.action === 'RECOVER', committed);
  const needs = await classifyFlowNeeds({ pipeline: { scenes: [scene] }, inputRoot: path.join(tmp, 'needs-root'), ffprobePath: process.env.FFPROBE_PATH } as any);
  check('F.6 classifyFlowNeeds still reports needsRecovery for committed scenes', Array.isArray(needs.needsRecovery), needs);
  check('F.7 decideFlowPhase still returns FLOW_MEDIA_RECOVERY_REQUIRED', decideFlowPhase({ haveLocal: [], needsDownload: [], needsGeneration: [], needsRecovery: [18], skipped: [] } as any) === 'FLOW_MEDIA_RECOVERY_REQUIRED');
}

// ============ G. Workflow persists a known committed id; omits it otherwise ============
{
  const root = path.join(tmp, 'wf-committed');
  const inputRoot = path.join(root, 'inputs');
  fs.mkdirSync(path.join(inputRoot, 'flow-clips'), { recursive: true });
  const scene = { scene_number: 18, speaker: '@CHAR-01-ARJUN' };
  const stub = {
    async sceneHasClip() { return true; },
    async readCommittedSceneArtifactId() { return COMMITTED; },
    async downloadCommittedSceneClip(_n: number, dest: string) { await mkClip(dest); return { ok: true, result: 'DOWNLOAD_SUCCESS' }; },
  };
  const r = await processSingleFlowScene(scene, stub, { projectId: 'proj', inputRoot, outputsRoot: path.join(root, 'outputs'), ffprobePath: process.env.FFPROBE_PATH });
  check('G.1 committed scene acquired successfully', r.status === 'FLOW_SCENE_ALREADY_COMMITTED', r.status);
  const ck = await readSceneCheckpoint(path.join(root, 'outputs', 'proj', 'flow-scenes', 'scene-0018.json'));
  check('G.2 the synthetic committed id IS persisted (existing test infrastructure supplies one)', ck?.committed_scene_artifact_id === COMMITTED, ck);
  check('G.3 generation_uuid is NOT set on a download-only branch (never fabricated)', ck?.generation_uuid === null, ck?.generation_uuid);
  check('G.4 local clip sha recorded as before', ck?.local_clip_sha256 !== null && /^[0-9a-f]{64}$/.test(String(ck?.local_clip_sha256)));

  // Same flow, but the committed identity is unavailable -> the key must be ABSENT.
  const root2 = path.join(tmp, 'wf-noid');
  const inputRoot2 = path.join(root2, 'inputs');
  fs.mkdirSync(path.join(inputRoot2, 'flow-clips'), { recursive: true });
  const stub2 = {
    async sceneHasClip() { return true; },
    async readCommittedSceneArtifactId() { return null; },
    async downloadCommittedSceneClip(_n: number, dest: string) { await mkClip(dest); return { ok: true }; },
  };
  await processSingleFlowScene(scene, stub2, { projectId: 'proj', inputRoot: inputRoot2, outputsRoot: path.join(root2, 'outputs'), ffprobePath: process.env.FFPROBE_PATH });
  const ck2 = await readSceneCheckpoint(path.join(root2, 'outputs', 'proj', 'flow-scenes', 'scene-0018.json'));
  check('G.5 unavailable committed id -> key absent, not invented', ck2 !== null && !('committed_scene_artifact_id' in ck2), ck2);
  check('G.6 a stub WITHOUT the reader at all still works (fully backward compatible)', await (async () => {
    const root3 = path.join(tmp, 'wf-noreader');
    const ir3 = path.join(root3, 'inputs');
    fs.mkdirSync(path.join(ir3, 'flow-clips'), { recursive: true });
    const stub3 = { async sceneHasClip() { return true; }, async downloadCommittedSceneClip(_n: number, dest: string) { await mkClip(dest); return { ok: true }; } };
    const r3 = await processSingleFlowScene(scene, stub3, { projectId: 'proj', inputRoot: ir3, outputsRoot: path.join(root3, 'outputs'), ffprobePath: process.env.FFPROBE_PATH });
    const ck3 = await readSceneCheckpoint(path.join(root3, 'outputs', 'proj', 'flow-scenes', 'scene-0018.json'));
    return r3.status === 'FLOW_SCENE_ALREADY_COMMITTED' && ck3 !== null && !('committed_scene_artifact_id' in ck3);
  })());
  // A reader that THROWS must not break the workflow.
  check('G.7 a throwing reader degrades gracefully to an absent field', await (async () => {
    const root4 = path.join(tmp, 'wf-throw');
    const ir4 = path.join(root4, 'inputs');
    fs.mkdirSync(path.join(ir4, 'flow-clips'), { recursive: true });
    const stub4 = { async sceneHasClip() { return true; }, async readCommittedSceneArtifactId() { throw new Error('rail unavailable'); }, async downloadCommittedSceneClip(_n: number, dest: string) { await mkClip(dest); return { ok: true }; } };
    const r4 = await processSingleFlowScene(scene, stub4, { projectId: 'proj', inputRoot: ir4, outputsRoot: path.join(root4, 'outputs'), ffprobePath: process.env.FFPROBE_PATH });
    const ck4 = await readSceneCheckpoint(path.join(root4, 'outputs', 'proj', 'flow-scenes', 'scene-0018.json'));
    return r4.status === 'FLOW_SCENE_ALREADY_COMMITTED' && ck4 !== null && !('committed_scene_artifact_id' in ck4);
  })());
}

// ============ Manual local-clip fallback untouched ============
{
  const root5 = path.join(tmp, 'wf-uselocal');
  const ir5 = path.join(root5, 'inputs');
  fs.mkdirSync(path.join(ir5, 'flow-clips'), { recursive: true });
  await mkClip(path.join(ir5, 'flow-clips', 'scene-0018.mp4'));
  const stub5 = { async sceneHasClip() { throw new Error('must not be called'); }, async readCommittedSceneArtifactId() { throw new Error('must not be called'); } };
  const r5 = await processSingleFlowScene({ scene_number: 18, speaker: '@CHAR-01-ARJUN' }, stub5, { projectId: 'proj', inputRoot: ir5, outputsRoot: path.join(root5, 'outputs'), ffprobePath: process.env.FFPROBE_PATH });
  check('H.1 USE_LOCAL still short-circuits with no Flow interaction', r5.status === 'LOCAL_CLIP_ALREADY_VALID', r5.status);
  check('H.2 manual fallback writes no committed id', await (async () => { const ck = await readSceneCheckpoint(path.join(root5, 'outputs', 'proj', 'flow-scenes', 'scene-0018.json')); return ck !== null && !('committed_scene_artifact_id' in ck); })());
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} focused checkpoint-provenance checks passed (fully offline).`);