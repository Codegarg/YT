// Offline tests for the single-scene Flow workflow (STEP-8EJ). No live Flow, no generation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
import { SRC } from './_testPaths.mjs';
import { FF } from './_testPaths.mjs';
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;

const wf = await import(pathToFileURL(`${SRC}/sceneFlowWorkflow.ts`).href);
const {
  decideSceneAction, decideCommitPrecedence, validateSceneCheckpoint, writeSceneCheckpoint,
  readSceneCheckpoint, sceneCheckpointPath, sceneClipDestination, sceneClipName,
  processSingleFlowScene, SCENE_CHECKPOINT_SCHEMA_VERSION,
} = wf;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

// Canonical asset metadata + an identifier-bearing prompt, as a real manifest has. The scene
// generation path resolves identifiers BEFORE submitting (see FLOW_OUTPUT_RESTRAINTS), so a
// prompt with no resolvable reference now fails closed instead of being submitted raw.
const ASSETS = {
  backgrounds: [{ tag: '#BGD-01-TEMPLE', location_name: 'Temple', look_summary: 'temple exterior' }],
  characters: [{ tag: '@CHAR-01-ARJUN', name: 'Arjun', look_summary: 'young Indian man' }],
};
const PROMPT = 'ACTIVE ENVIRONMENT: #BGD-01-TEMPLE\nACTIVE CHARACTERS: @CHAR-01-ARJUN';

// ---- decision precedence ----
check('valid local clip -> USE_LOCAL (no generation)', (() => { const d = decideSceneAction({ localClipValid: true, flowSceneCommitted: false, allowGeneration: true, generationAlreadyAttempted: false }); return d.action === 'USE_LOCAL' && d.status === 'LOCAL_CLIP_ALREADY_VALID'; })());
check('no local clip but Flow committed -> DOWNLOAD (no generation)', (() => { const d = decideSceneAction({ localClipValid: false, flowSceneCommitted: true, allowGeneration: true, generationAlreadyAttempted: false }); return d.action === 'DOWNLOAD' && d.status === 'FLOW_SCENE_ALREADY_COMMITTED'; })());
check('valid local clip beats committed (local wins)', decideSceneAction({ localClipValid: true, flowSceneCommitted: true, allowGeneration: true, generationAlreadyAttempted: false }).action === 'USE_LOCAL');
check('nothing committed + generation NOT allowed -> STOP (fail closed)', (() => { const d = decideSceneAction({ localClipValid: false, flowSceneCommitted: false, allowGeneration: false, generationAlreadyAttempted: false }); return d.action === 'STOP' && d.status === 'FLOW_GENERATION_REQUIRED'; })());
check('nothing committed + generation allowed -> GENERATE', decideSceneAction({ localClipValid: false, flowSceneCommitted: false, allowGeneration: true, generationAlreadyAttempted: false }).action === 'GENERATE');
check('generation already attempted -> STOP (never click again)', (() => { const d = decideSceneAction({ localClipValid: false, flowSceneCommitted: false, allowGeneration: true, generationAlreadyAttempted: true }); return d.action === 'STOP' && d.status === 'FLOW_GENERATION_FAILED'; })());

// ---- commit precedence ----
check('committed beats generated artifact', decideCommitPrecedence(true, 'uuid') === 'ALREADY_COMMITTED');
check('generated artifact when not committed', decideCommitPrecedence(false, 'uuid') === 'GENERATED');
check('nothing -> NOT_PROVEN', decideCommitPrecedence(false, '') === 'NOT_PROVEN' && decideCommitPrecedence(false, undefined) === 'NOT_PROVEN');

// ---- checkpoint serialization / validation ----
{
  const good = { schema_version: SCENE_CHECKPOINT_SCHEMA_VERSION, project_id: 'p', scene_number: 1, flow_scene_id: null, flow_scene_url: 'https://flow.google.com/project/x/edit/y', generation_uuid: 'u', local_clip_path: 'flow-clips/scene-0001.mp4', local_clip_sha256: 'a'.repeat(64), duration_seconds: 8, width: 1280, height: 720, video_codec: 'h264', audio_codec: 'aac', workflow_status: 'DOWNLOAD_SUCCESS', updated_at: '2026-10-01T00:00:00Z' };
  check('valid checkpoint accepted', validateSceneCheckpoint(good).ok === true);
  check('wrong schema rejected', validateSceneCheckpoint({ ...good, schema_version: 99 }).ok === false);
  check('missing project id rejected', validateSceneCheckpoint({ ...good, project_id: '' }).ok === false);
  check('invalid scene number rejected', validateSceneCheckpoint({ ...good, scene_number: 0 }).ok === false);
  check('absolute local_clip_path rejected', validateSceneCheckpoint({ ...good, local_clip_path: 'C:\\abs\\x.mp4' }).ok === false);
  check('blob url rejected (no secrets)', validateSceneCheckpoint({ ...good, local_clip_path: 'blob:https://flow.google.com/x' }).ok === false);
  check('signed-url markers rejected', validateSceneCheckpoint({ ...good, flow_scene_url: 'https://x/y?KeyName=k&Expires=1' }).ok === false);
  check('cookie/token text rejected', validateSceneCheckpoint({ ...good, generation_uuid: 'cookie-session' }).ok === false);
  check('deterministic path helper', sceneCheckpointPath('p', 1, 'out') === path.join(path.resolve('out'), 'p', 'flow-scenes', 'scene-0001.json'));
  check('checkpoint path rejects bad scene number', (() => { try { sceneCheckpointPath('p', 0); return false; } catch { return true; } })());
}

// ---- scene clip destination ----
{
  const dest = sceneClipDestination('C:/inputs/p', 1);
  check('destination is flow-clips/scene-0001.mp4', dest !== null && dest.replace(/\\/g, '/').endsWith('inputs/p/flow-clips/scene-0001.mp4'));
  check('sceneClipName pads to 4 digits', sceneClipName(7) === 'scene-0007.mp4' && sceneClipName(0) === null);
}

// ---- live-shaped: valid local clip short-circuits with ZERO generation/download ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8ej-'));
const inputRoot = path.join(tmp, 'inputs', 'proj');
const clipsDir = path.join(inputRoot, 'flow-clips');
fs.mkdirSync(clipsDir, { recursive: true });
const outputsRoot = path.join(tmp, 'outputs');
const makeMp4 = async (o: string, d = 3) => { await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', `color=c=0x203040:s=1280x720:d=${d}`, '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=48000:d=${d}`, '-t', String(d), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', o]); };

{
  const dest = path.join(clipsDir, 'scene-0001.mp4');
  await makeMp4(dest, 8);
  const shaBefore = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
  let genCalls = 0, dlCalls = 0;
  const flowStub = {
    sceneHasClip: async () => false,
    generateProjectVideo: async () => { genCalls++; return { title: 'T', artifactId: 'uuid' }; },
    downloadCommittedSceneClip: async () => { dlCalls++; return { ok: true, result: 'DOWNLOAD_SUCCESS' }; },
  };
  const scene = { scene_number: 1, title: 'S1', speaker: 'NARRATOR', animation_prompt_NARRATOR_ONLY: 'p', flow_scene_url: 'https://flow.google.com/project/p/edit/s' };
  const r1 = await processSingleFlowScene(scene, flowStub, { projectId: 'proj', inputRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH });
  check('RUN 1: valid local clip -> LOCAL_CLIP_ALREADY_VALID', r1.status === 'LOCAL_CLIP_ALREADY_VALID', JSON.stringify(r1));
  check('RUN 1: ZERO generation calls', genCalls === 0 && r1.generationAttempts === 0);
  check('RUN 1: ZERO download calls', dlCalls === 0 && r1.downloads === 0);
  check('RUN 1: SHA recorded', r1.sha256 === shaBefore);
  // checkpoint written
  const cpFile = sceneCheckpointPath('proj', 1, outputsRoot);
  const cp = await readSceneCheckpoint(cpFile);
  check('checkpoint written + valid', cp !== null && cp.workflow_status === 'LOCAL_CLIP_ALREADY_VALID' && cp.local_clip_sha256 === shaBefore);
  check('checkpoint contains no secrets', !/blob:|cookie|token|authorization|KeyName=|Expires=/i.test(fs.readFileSync(cpFile, 'utf8') || '{}'));

  // RUN 2: fully idempotent
  const r2 = await processSingleFlowScene(scene, flowStub, { projectId: 'proj', inputRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH });
  check('RUN 2: idempotent LOCAL_CLIP_ALREADY_VALID', r2.status === 'LOCAL_CLIP_ALREADY_VALID');
  check('RUN 2: still ZERO generation/download', genCalls === 0 && dlCalls === 0);
  check('RUN 2: local clip byte-identical (never overwritten)', crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex') === shaBefore);
  check('no temp residue in clips dir', !fs.readdirSync(clipsDir).some((f) => f.includes('.tmp')));
}

// ---- generation-required, NOT authorised -> STOP with zero clicks ----
{
  const input2 = path.join(tmp, 'inputs2', 'proj');
  fs.mkdirSync(path.join(input2, 'flow-clips'), { recursive: true });
  let genCalls = 0, dlCalls = 0;
  const flowStub = {
    sceneHasClip: async () => false,
    generateProjectVideo: async () => { genCalls++; return { title: 'T', artifactId: 'uuid' }; },
    downloadCommittedSceneClip: async () => { dlCalls++; return { ok: true, result: 'DOWNLOAD_SUCCESS' }; },
  };
  // Canonical asset metadata + an identifier-bearing prompt, as a real manifest has. The scene
  // generation path resolves identifiers BEFORE submitting (see FLOW_OUTPUT_RESTRAINTS), so a
  // prompt with no resolvable reference now fails closed instead of being submitted raw.
  const scene = { scene_number: 2, speaker: 'NARRATOR', animation_prompt_NARRATOR_ONLY: PROMPT };
  const r = await processSingleFlowScene(scene, flowStub, { projectId: 'proj', inputRoot: input2, outputsRoot, ffprobePath: process.env.FFPROBE_PATH });
  check('missing clip + generation not authorised -> FLOW_GENERATION_REQUIRED, zero clicks', r.status === 'FLOW_GENERATION_REQUIRED' && genCalls === 0 && dlCalls === 0, JSON.stringify(r));
  // authorised -> generates exactly once, then download
  const r2 = await processSingleFlowScene(scene, flowStub, { projectId: 'proj', inputRoot: input2, outputsRoot, allowGeneration: true, ffprobePath: process.env.FFPROBE_PATH, ...ASSETS });
  check('authorised -> exactly ONE generation attempt', genCalls === 1 && r2.generationAttempts === 1, JSON.stringify({ genCalls, r2 }));
  check('generation without commit -> FLOW_SCENE_NOT_COMMITTED (fail closed, no download)', r2.status === 'FLOW_SCENE_NOT_COMMITTED' && dlCalls === 0, JSON.stringify(r2));
}

// ---- failure is fail-closed ----
{
  const input3 = path.join(tmp, 'inputs3', 'proj');
  fs.mkdirSync(path.join(input3, 'flow-clips'), { recursive: true });
  let genCalls = 0;
  const flowStub = { sceneHasClip: async () => false, generateProjectVideo: async () => { genCalls++; throw new Error('flow error'); }, downloadCommittedSceneClip: async () => ({ ok: true }) };
  const r = await processSingleFlowScene({ scene_number: 3, speaker: 'NARRATOR', animation_prompt_NARRATOR_ONLY: PROMPT }, flowStub, { projectId: 'proj', inputRoot: input3, outputsRoot, allowGeneration: true, ffprobePath: process.env.FFPROBE_PATH, ...ASSETS });
  check('generation failure -> FLOW_GENERATION_FAILED, exactly one attempt, no retry', r.status === 'FLOW_GENERATION_FAILED' && genCalls === 1, JSON.stringify({ r, genCalls }));
  const cp = await readSceneCheckpoint(sceneCheckpointPath('proj', 3, outputsRoot));
  check('failure checkpoint persisted', cp !== null && cp.workflow_status === 'FLOW_GENERATION_FAILED');
}

// ---- committed Flow scene + download path (stub) ----
{
  const input4 = path.join(tmp, 'inputs4', 'proj');
  fs.mkdirSync(path.join(input4, 'flow-clips'), { recursive: true });
  let dlCalls = 0, genCalls = 0;
  const flowStub = {
    sceneHasClip: async () => true,
    generateProjectVideo: async () => { genCalls++; return { title: 'T', artifactId: 'u' }; },
    downloadCommittedSceneClip: async (_n: number, out: string) => { dlCalls++; await makeMp4(out, 8); return { ok: true, result: 'DOWNLOAD_SUCCESS' }; },
  };
  const r = await processSingleFlowScene({ scene_number: 4, speaker: 'NARRATOR', animation_prompt_NARRATOR_ONLY: 'p' }, flowStub, { projectId: 'proj', inputRoot: input4, outputsRoot, ffprobePath: process.env.FFPROBE_PATH });
  check('committed Flow scene -> FLOW_SCENE_ALREADY_COMMITTED + download, ZERO generation', r.status === 'FLOW_SCENE_ALREADY_COMMITTED' && dlCalls === 1 && genCalls === 0, JSON.stringify({ r, dlCalls, genCalls }));
  check('downloaded clip validated (duration/resolution recorded)', r.width === 1280 && r.height === 720 && r.videoCodec === 'h264' && r.durationSeconds > 0, JSON.stringify(r));
  check('committed-path result reports zero generation attempts', r.generationAttempts === 0 && r.downloads === 1);
}

// ---- generate -> commit -> download (authorised, exactly one generation) ----
{
  const input5 = path.join(tmp, 'inputs5', 'proj');
  fs.mkdirSync(path.join(input5, 'flow-clips'), { recursive: true });
  let genCalls = 0, dlCalls = 0, committed = false;
  const flowStub = {
    sceneHasClip: async () => committed,
    generateProjectVideo: async () => { genCalls++; committed = true; return { title: 'T', artifactId: 'gen-uuid' }; },
    downloadCommittedSceneClip: async (_n: number, out: string) => { dlCalls++; await makeMp4(out, 8); return { ok: true, result: 'DOWNLOAD_SUCCESS' }; },
  };
  const r = await processSingleFlowScene({ scene_number: 5, speaker: 'NARRATOR', animation_prompt_NARRATOR_ONLY: PROMPT }, flowStub, { projectId: 'proj', inputRoot: input5, outputsRoot, allowGeneration: true, ffprobePath: process.env.FFPROBE_PATH, ...ASSETS });
  check('authorised generate -> exactly ONE generation then download', genCalls === 1 && dlCalls === 1 && r.status === 'DOWNLOAD_SUCCESS', JSON.stringify({ r, genCalls, dlCalls }));
  const cp = await readSceneCheckpoint(sceneCheckpointPath('proj', 5, outputsRoot));
  check('checkpoint records the generation uuid', cp?.generation_uuid === 'gen-uuid' && cp?.workflow_status === 'DOWNLOAD_SUCCESS');
}

// ---- explicit scene-local authorization: policy + reference-aware lifecycle ----
{
  const TARGET_SCENE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const OTHER_SCENE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const COMMITTED_CLIP_ID = '11111111-1111-4111-8111-111111111111';
  const OTHER_CLIP_ID = '22222222-2222-4222-8222-222222222222';
  const BG = '#BGD-01-TEMPLE';
  const CH = '@CHAR-01-ARJUN';
  const BG_SRC = 'https://flow-content.google/image/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?Expires=1&KeyName=k&Signature=s';
  const CH_TOKEN = 'ANqvLOZFRtN_rGJtVov-uurQdHR9u_I8251JrG98HK2zZ5w06';
  const CH_SRC = `https://lh3.googleusercontent.com/asb/${CH_TOKEN}?s=1`;
  const GOOD_PROJECT_SETTINGS = { mode: 'Video', model: 'Omni 1.1 Flash', resolution: '720p', duration: '8s', aspect: '16:9', batch: 'x1' };
  const GOOD_DISPLAY = { model: 'Omni 1.1 Flash', duration: '8s', aspect: '16:9' };
  const EVIDENCE = {
    chipSrcs: [BG_SRC],
    railEntries: [{ tag: BG, src: BG_SRC }],
    characterChipSrcs: [CH_SRC],
  };
  const CH_EV = { expectedTag: CH, pickerToken: CH_TOKEN, chipToken: CH_TOKEN, verified: true, code: 'CHARACTER_ATTACHMENT_VERIFIED' };

  const auth = (over: any = {}) => ({ operation: 'EXTEND', targetSceneId: TARGET_SCENE_ID, expectedCommittedClipId: COMMITTED_CLIP_ID, ...over });

  function sceneLocalFlow(over: any = {}) {
    const calls = {
      generateSceneVideo: 0, generateProjectVideo: 0, createScene: 0, download: 0,
      openSceneEditor: [] as string[], sceneHasClip: 0, selectAsset: [] as string[],
    };
    const flow: any = {
      async configureVideoGeneration() { /* project-level settings only */ },
      async observeProjectVideoSettings() { return GOOD_PROJECT_SETTINGS; },
      async createScene() { calls.createScene++; throw new Error('createScene MUST NOT be called for an existing target'); },
      async openSceneEditor(id: string) {
        calls.openSceneEditor.push(id);
        return { url: `https://flow.google.com/project/proj/scene/${over.mountedSceneId ?? id}` };
      },
      async selectAsset(tag: string) { calls.selectAsset.push(tag); },
      async selectCharacterAssetWithVerification(tag: string) {
        if (over.failedAttachment) return { expectedTag: tag, pickerToken: CH_TOKEN, chipToken: CH_TOKEN, verified: false, code: 'CHARACTER_ATTACHMENT_UNVERIFIED' };
        return { ...CH_EV, expectedTag: tag };
      },
      async readSceneComposerIngredientEvidence() { return over.evidence ?? EVIDENCE; },
      async observeSceneInheritedDisplay() { return GOOD_DISPLAY; },
      async generateSceneVideo() {
        calls.generateSceneVideo++;
        if (over.generateSceneVideo) throw new Error('scene-local generation failed');
        return { title: 'T', artifactId: 'generated-artifact-id' };
      },
      async sceneHasClip() {
        calls.sceneHasClip++;
        if (over.sceneHasClip === 'throw') throw new Error('clip read failed');
        return over.sceneHasClip ?? true;
      },
      async readCommittedSceneArtifactId() {
        if (over.readCommittedSceneArtifactId === 'throw') throw new Error('clip id read failed');
        return over.readCommittedSceneArtifactId === undefined ? COMMITTED_CLIP_ID : over.readCommittedSceneArtifactId;
      },
      async downloadCommittedSceneClip(_n: number, out: string) {
        calls.download++;
        await makeMp4(out, 8);
        return { ok: true, result: 'DOWNLOAD_SUCCESS' };
      },
      async reconcileGeneratedVideoWithScene() { return { committedSceneArtifactId: over.committedClipId ?? COMMITTED_CLIP_ID }; },
      async listRailAssetTags() { return [BG]; },
      async listCharacterPickerTags() { return [CH]; },
      async listSceneIds() { return [TARGET_SCENE_ID]; },
      async generateProjectVideo() { calls.generateProjectVideo++; return { title: 'T', artifactId: 'project-artifact' }; },
    };
    return { flow, calls };
  }

  const scene = (n: number, over: any = {}) => ({
    scene_number: n,
    speaker: 'NARRATOR',
    animation_prompt_NARRATOR_ONLY: PROMPT,
    background_tag: BG,
    character_tags: [CH],
    flow_scene_id: TARGET_SCENE_ID,
    ...over,
  });
  const localConfig = (inputRoot: string, over: any = {}) => ({
    projectId: 'proj', inputRoot, outputsRoot, allowGeneration: true,
    ffprobePath: process.env.FFPROBE_PATH, ...ASSETS, sceneLocalAuthorization: auth(), ...over,
  });

  // 1. Authorized EXTEND routes through runSceneProductionLifecycle with exact evidence.
  {
    const input = path.join(tmp, 'inputs-local-extend', 'proj');
    fs.mkdirSync(path.join(input, 'flow-clips'), { recursive: true });
    const { flow, calls } = sceneLocalFlow();
    const r = await processSingleFlowScene(scene(10), flow, localConfig(input));
    const cp = await readSceneCheckpoint(sceneCheckpointPath('proj', 10, outputsRoot));
    check('auth EXTEND -> SCENE_LOCAL_EXTENSION_COMPLETE', r.status === 'SCENE_LOCAL_EXTENSION_COMPLETE', JSON.stringify(r));
    check('auth EXTEND -> exactly ONE scene-local generation, no project generation, no scene create',
      calls.generateSceneVideo === 1 && calls.generateProjectVideo === 0 && calls.createScene === 0, calls);
    check('auth EXTEND -> every editor open is the EXACT authorized target',
      calls.openSceneEditor.length > 0 && calls.openSceneEditor.every((id) => id === TARGET_SCENE_ID), calls.openSceneEditor);
    check('auth EXTEND -> exact committed identities persisted',
      cp?.workflow_status === 'DOWNLOAD_SUCCESS' && cp?.flow_scene_id === TARGET_SCENE_ID
      && cp?.committed_scene_artifact_id === COMMITTED_CLIP_ID && cp?.generation_uuid === 'generated-artifact-id', cp);
    check('auth EXTEND -> local clip validated and reported', r.localClipPath !== null && fs.existsSync(r.localClipPath)
      && r.generationAttempts === 1 && r.downloads === 1, r);
  }

  // 2. Authorized REGENERATE uses the same exact lifecycle, not a project-composer path.
  {
    const input = path.join(tmp, 'inputs-local-regenerate', 'proj');
    fs.mkdirSync(path.join(input, 'flow-clips'), { recursive: true });
    const { flow, calls } = sceneLocalFlow();
    const r = await processSingleFlowScene(scene(11), flow, localConfig(input, { sceneLocalAuthorization: auth({ operation: 'REGENERATE' }) }));
    check('auth REGENERATE -> SCENE_LOCAL_REGENERATE_COMPLETE',
      r.status === 'SCENE_LOCAL_REGENERATE_COMPLETE' && calls.generateSceneVideo === 1 && calls.generateProjectVideo === 0, { r, calls });
    check('auth REGENERATE -> exactly one attempt and download', r.generationAttempts === 1 && r.downloads === 1, r);
  }

  // 3. allowGeneration alone (with no explicit authorization) remains DOWNLOAD_ONLY.
  {
    const input = path.join(tmp, 'inputs-local-downloadonly', 'proj');
    fs.mkdirSync(path.join(input, 'flow-clips'), { recursive: true });
    const { flow, calls } = sceneLocalFlow();
    const r = await processSingleFlowScene(scene(12), flow, localConfig(input, { sceneLocalAuthorization: null, allowGeneration: true }));
    check('allowGeneration alone -> DOWNLOAD_ONLY, never scene-local generation',
      r.status === 'FLOW_SCENE_ALREADY_COMMITTED' && calls.generateSceneVideo === 0 && calls.generateProjectVideo === 0, { r, calls });
    check('allowGeneration alone -> one download, zero generation attempts', r.downloads === 1 && r.generationAttempts === 0, r);
  }

  // 4. Missing committed clip id is UNKNOWN, never ABSENT and never generation.
  {
    const input = path.join(tmp, 'inputs-local-unknown', 'proj');
    fs.mkdirSync(path.join(input, 'flow-clips'), { recursive: true });
    const { flow, calls } = sceneLocalFlow({ readCommittedSceneArtifactId: null });
    const r = await processSingleFlowScene(scene(13), flow, localConfig(input));
    check('missing committed clip id -> SCENE_LOCAL_BLOCKED/SCENE_STATE_UNKNOWN',
      r.status === 'SCENE_LOCAL_BLOCKED' && /SCENE_STATE_UNKNOWN/.test(String(r.detail)), r);
    check('missing committed clip id -> no generation and no lifecycle checkpoint',
      calls.generateSceneVideo === 0 && calls.generateProjectVideo === 0
      && (await readSceneCheckpoint(sceneCheckpointPath('proj', 13, outputsRoot))) === null, calls);
  }

  // 5. Mismatched live committed id stops before lifecycle.
  {
    const input = path.join(tmp, 'inputs-local-mismatch', 'proj');
    fs.mkdirSync(path.join(input, 'flow-clips'), { recursive: true });
    const { flow, calls } = sceneLocalFlow({ readCommittedSceneArtifactId: OTHER_CLIP_ID });
    const r = await processSingleFlowScene(scene(14), flow, localConfig(input));
    check('mismatched committed clip id -> COMMITTED_CLIP_MISMATCH, no generation',
      r.status === 'SCENE_LOCAL_BLOCKED' && /COMMITTED_CLIP_MISMATCH/.test(String(r.detail)) && calls.generateSceneVideo === 0, { r, calls });
  }

  // 6. A stale prior checkpoint contradicts live evidence -> stop.
  {
    const input = path.join(tmp, 'inputs-local-stale', 'proj');
    fs.mkdirSync(path.join(input, 'flow-clips'), { recursive: true });
    await writeSceneCheckpoint(sceneCheckpointPath('proj', 15, outputsRoot), {
      schema_version: SCENE_CHECKPOINT_SCHEMA_VERSION, project_id: 'proj', scene_number: 15,
      flow_scene_id: TARGET_SCENE_ID, flow_scene_url: null, generation_uuid: null,
      committed_scene_artifact_id: OTHER_CLIP_ID, local_clip_path: null, local_clip_sha256: null,
      duration_seconds: null, width: null, height: null, video_codec: null, audio_codec: null,
      workflow_status: 'FLOW_SCENE_ALREADY_COMMITTED', updated_at: null,
    });
    const { flow, calls } = sceneLocalFlow();
    const r = await processSingleFlowScene(scene(15), flow, localConfig(input));
    check('stale prior committed clip -> COMMITTED_CLIP_MISMATCH, no generation',
      r.status === 'SCENE_LOCAL_BLOCKED' && /COMMITTED_CLIP_MISMATCH/.test(String(r.detail)) && calls.generateSceneVideo === 0, { r, calls });
  }

  // 7. Mounting a different scene than the authorized target stops before lifecycle generation.
  {
    const input = path.join(tmp, 'inputs-local-target-mismatch', 'proj');
    fs.mkdirSync(path.join(input, 'flow-clips'), { recursive: true });
    const { flow, calls } = sceneLocalFlow({ mountedSceneId: OTHER_SCENE_ID });
    const r = await processSingleFlowScene(scene(16), flow, localConfig(input));
    check('mounted target mismatch -> TARGET_MISMATCH, no generation',
      r.status === 'SCENE_LOCAL_BLOCKED' && /TARGET_MISMATCH/.test(String(r.detail)) && calls.generateSceneVideo === 0, { r, calls });
  }

  // 8. Trusted project metadata contradicting the authorization stops before opening.
  {
    const input = path.join(tmp, 'inputs-local-trusted-mismatch', 'proj');
    fs.mkdirSync(path.join(input, 'flow-clips'), { recursive: true });
    const { flow, calls } = sceneLocalFlow();
    const r = await processSingleFlowScene(scene(17, { flow_scene_id: OTHER_SCENE_ID }), flow, localConfig(input));
    check('trusted target mismatch -> TARGET_MISMATCH before any editor open',
      r.status === 'SCENE_LOCAL_BLOCKED' && /TARGET_MISMATCH/.test(String(r.detail)) && calls.openSceneEditor.length === 0 && calls.generateSceneVideo === 0, { r, calls });
  }

  // 9. Ingredient verification failure prevents generation and success checkpointing.
  {
    const input = path.join(tmp, 'inputs-local-ingredients', 'proj');
    fs.mkdirSync(path.join(input, 'flow-clips'), { recursive: true });
    const { flow, calls } = sceneLocalFlow({ evidence: { chipSrcs: [], railEntries: [], characterChipSrcs: [] } });
    const r = await processSingleFlowScene(scene(18), flow, localConfig(input));
    check('ingredient failure -> SCENE_LOCAL_GENERATION_FAILED/INGREDIENTS_NOT_READY',
      r.status === 'SCENE_LOCAL_GENERATION_FAILED' && /INGREDIENTS_NOT_READY/.test(String(r.detail)), r);
    check('ingredient failure -> no generation and no success checkpoint',
      calls.generateSceneVideo === 0 && (await readSceneCheckpoint(sceneCheckpointPath('proj', 18, outputsRoot))) === null, calls);
  }

  // 10. Scene-local generation failure is not retried.
  {
    const input = path.join(tmp, 'inputs-local-genfail', 'proj');
    fs.mkdirSync(path.join(input, 'flow-clips'), { recursive: true });
    const { flow, calls } = sceneLocalFlow({ generateSceneVideo: true });
    const r = await processSingleFlowScene(scene(19), flow, localConfig(input));
    check('scene-local generation failure -> exactly one attempt, no retry',
      r.status === 'SCENE_LOCAL_GENERATION_FAILED' && calls.generateSceneVideo === 1 && /GENERATION_FAILED/.test(String(r.detail)), { r, calls });
    check('scene-local generation failure -> no success checkpoint',
      (await readSceneCheckpoint(sceneCheckpointPath('proj', 19, outputsRoot))) === null);
  }

  // 11. A valid local clip is never overwritten by an explicit authorization.
  {
    const input = path.join(tmp, 'inputs-local-protected', 'proj');
    const clipDir = path.join(input, 'flow-clips');
    fs.mkdirSync(clipDir, { recursive: true });
    const dest = path.join(clipDir, 'scene-0020.mp4');
    await makeMp4(dest, 8);
    const before = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
    const { flow, calls } = sceneLocalFlow();
    const r = await processSingleFlowScene(scene(20), flow, localConfig(input));
    const after = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
    check('valid local clip + authorization -> LOCAL_CLIP_PRESENT, never overwritten',
      r.status === 'SCENE_LOCAL_BLOCKED' && /LOCAL_CLIP_PRESENT/.test(String(r.detail)) && before === after, { r, before, after });
    check('valid local clip + authorization -> no editor open and no generation',
      calls.openSceneEditor.length === 0 && calls.generateSceneVideo === 0 && calls.generateProjectVideo === 0, calls);
  }

  // 12. Clipless + explicit authorization never falls back to first-clip project generation.
  {
    const input = path.join(tmp, 'inputs-local-clipless', 'proj');
    fs.mkdirSync(path.join(input, 'flow-clips'), { recursive: true });
    const { flow, calls } = sceneLocalFlow({ sceneHasClip: false });
    const r = await processSingleFlowScene(scene(21), flow, localConfig(input));
    check('clipless + authorization -> SCENE_LOCAL_UNSUPPORTED, no first-clip fallback',
      r.status === 'SCENE_LOCAL_BLOCKED' && /SCENE_LOCAL_UNSUPPORTED/.test(String(r.detail))
      && calls.generateProjectVideo === 0 && calls.generateSceneVideo === 0, { r, calls });
  }

  // 13. First clip with no authorization still uses the project composer, never the lifecycle.
  {
    const input = path.join(tmp, 'inputs-first-clip-only', 'proj');
    fs.mkdirSync(path.join(input, 'flow-clips'), { recursive: true });
    const { flow, calls } = sceneLocalFlow({ sceneHasClip: false });
    flow.generateProjectVideo = async () => { calls.generateProjectVideo++; return { title: 'T', artifactId: 'project-artifact' }; };
    const r = await processSingleFlowScene(scene(22, { flow_scene_id: null }), flow, localConfig(input, { sceneLocalAuthorization: null }));
    check('clipless + no authorization -> project-composer generation only',
      r.status === 'FLOW_SCENE_NOT_COMMITTED' && calls.generateProjectVideo === 1 && calls.generateSceneVideo === 0, { r, calls });
    check('clipless first clip never creates/opens the scene-local lifecycle', calls.createScene === 0, calls);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nSCENE-FLOW-WORKFLOW TESTS PASSED (${passed} checks)`);
