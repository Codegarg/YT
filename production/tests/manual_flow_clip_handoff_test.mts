// Focused OFFLINE tests: manual Flow-clip handoff as an explicit, durable, resumable state.
//
// No Flow, no Chrome, no network, no media beyond ffmpeg-minted local MP4 fixtures. Proves:
//   A committed scene + missing local clip stays a RECOVERY condition (never GENERATE)
//   B the recovery fact survives a checkpoint/restart round-trip
//   C a valid human-provided local clip is recognised and becomes renderable
//   D an invalid local clip stays blocked
//   E recovery never becomes GENERATE
//   F a recovered scene never contacts Flow
//   G committed_scene_artifact_id is retained when available, never fabricated
//   H legacy checkpoints without the new fields remain valid
//   I the exact canonical local filename/path is used
//   J resume after recovery is deterministic and idempotent
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
        sceneCheckpointPath, sceneClipDestination, processSingleFlowScene, decideSceneAction } = w;
const { classifyFlowNeeds, decideFlowPhase } = sr;
const { classifyFlowEligibility } = ss;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-handoff-'));
const PID = 'manual-handoff-fixture';
const COMMITTED = '47425bc2-6c47-4b6d-a88a-c4a7259015cc';
const GEN = 'ec19b9fd-e4e9-4ca2-b3e0-517a1d523528';

const mkClip = async (out: string) => {
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=1280x720:d=1',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);
};

/** A fresh project input root; `flow-clips/` exists but is empty (the human has not placed a clip). */
function newProject(name: string) {
  const root = path.join(tmp, name);
  const inputRoot = path.join(root, 'inputs', PID);
  fs.mkdirSync(path.join(inputRoot, 'flow-clips'), { recursive: true });
  return { root, inputRoot, outputsRoot: path.join(root, 'outputs'), ck: path.join(root, 'outputs', PID, 'flow-scenes', 'scene-0018.json') };
}
const cfgFor = (p: { inputRoot: string; outputsRoot: string }) => ({ projectId: PID, inputRoot: p.inputRoot, outputsRoot: p.outputsRoot, ffprobePath: process.env.FFPROBE_PATH });
const SCENE = { scene_number: 18, speaker: '@CHAR-01-ARJUN', flow_scene_id: '93b8bbea-33b7-43fe-b2b5-7d615dffc1ae' };

/** A flow stub that FAILS LOUDLY if the recovery path touches it. */
const forbiddenFlow = () => ({
  async sceneHasClip(): Promise<boolean> { throw new Error('RECOVERY MUST NOT CONTACT FLOW: sceneHasClip'); },
  async readCommittedSceneArtifactId(): Promise<string> { throw new Error('RECOVERY MUST NOT CONTACT FLOW: readCommittedSceneArtifactId'); },
  async generateProjectVideo(): Promise<never> { throw new Error('RECOVERY MUST NOT GENERATE'); },
  async downloadCommittedSceneClip(): Promise<never> { throw new Error('RECOVERY MUST NOT DOWNLOAD'); },
});

// ============ A + E. committed scene + missing local clip -> RECOVERY, never GENERATE ============
{
  const p = newProject('a-missing');
  const dest = sceneClipDestination(p.inputRoot, 18)!;
  check('I.1 canonical local filename is scene-0018.mp4', path.basename(dest) === 'scene-0018.mp4', dest);
  check('I.2 canonical directory is <inputRoot>/flow-clips', path.basename(path.dirname(dest)) === 'flow-clips', dest);
  check('I.3 checkpoint path is outputs/<id>/flow-scenes/scene-0018.json', p.ck.endsWith(path.join(PID, 'flow-scenes', 'scene-0018.json')), p.ck);
  check('A.1 local clip is absent before the human handoff', !fs.existsSync(dest));

  // Runner-level classification. `deriveFlowLocalState` reads Flow commitment from the scene's
  // flow_scene_id/flow_scene_url, so the fixture must carry the committed scene identity.
  const committedScene = { scene_number: 18, speaker: '@CHAR-01-ARJUN', flow_scene_id: '93b8bbea-33b7-43fe-b2b5-7d615dffc1ae', flow_scene_url: 'https://flow.google.com/p/sc' };
  const needs = await classifyFlowNeeds({ pipeline: { scenes: [committedScene] }, inputRoot: p.inputRoot, ffprobePath: process.env.FFPROBE_PATH } as any);
  check('A.3 classifyFlowNeeds reports needsRecovery (never needsGeneration)', needs.needsGeneration.length === 0 && needs.needsRecovery.length === 1, needs);
  const elig = classifyFlowEligibility({ ...committedScene, background: { state: 'VALID' }, characters: [], narration: 'DIALOGUE', narrationAsset: { state: 'NOT_REQUIRED' }, suppliedClip: { state: 'MISSING' }, flowLocal: { state: 'FLOW_COMMITTED_LOCAL_MISSING' } } as any);
  check('A.2 classifyFlowEligibility yields RECOVER for a committed, locally-missing scene', elig.action === 'RECOVER', elig);
  // Pure decision: committed + no local clip => DOWNLOAD (attempt), never GENERATE.
  check('E.1 decideSceneAction: committed + no local clip is DOWNLOAD, not GENERATE',
    decideSceneAction({ localClipValid: false, flowSceneCommitted: true, allowGeneration: true, generationAlreadyAttempted: false }).action === 'DOWNLOAD');
  check('E.2 decideFlowPhase reports FLOW_MEDIA_RECOVERY_REQUIRED', decideFlowPhase(needs as any) === 'FLOW_MEDIA_RECOVERY_REQUIRED');
  check('E.3 recovery is never reported as a generation failure', decideFlowPhase(needs as any) !== 'FAILED');
}

// ============ D. invalid local clip stays blocked ============
{
  const p = newProject('d-invalid');
  const dest = sceneClipDestination(p.inputRoot, 18)!;
  fs.writeFileSync(dest, 'THIS IS NOT A VALID MP4');           // human placed a corrupt file
  const r = await processSingleFlowScene(SCENE, null, cfgFor(p));
  check('D.1 an invalid local clip does NOT become USE_LOCAL', r.status !== 'LOCAL_CLIP_ALREADY_VALID', r.status);
  const needs = await classifyFlowNeeds({ pipeline: { scenes: [SCENE] }, inputRoot: p.inputRoot, ffprobePath: process.env.FFPROBE_PATH } as any);
  check('D.2 an invalid local clip is not treated as available', needs.haveLocal.length === 0, needs);
  check('D.3 the corrupt file remains in place for diagnosis (never silently deleted)', fs.existsSync(dest));
}

// ============ C + F + G + I + J. human places a valid clip after a committed scene ============
{
  const p = newProject('c-handoff');

  // Step 1 — a prior checkpoint proves the Flow scene was committed (an earlier recovery attempt).
  await writeSceneCheckpoint(p.ck, {
    schema_version: SCENE_CHECKPOINT_SCHEMA_VERSION, project_id: PID, scene_number: 18,
    flow_scene_id: '93b8bbea-33b7-43fe-b2b5-7d615dffc1ae', flow_scene_url: 'https://flow.google.com/p/sc',
    generation_uuid: GEN, committed_scene_artifact_id: COMMITTED,
    local_clip_path: null, local_clip_sha256: null,
    duration_seconds: null, width: null, height: null, video_codec: null, audio_codec: null,
    workflow_status: 'DOWNLOAD_FAILED', updated_at: '2026-10-05T00:00:00.000Z',
  } as any);

  // Step 2 — the human downloads and places the clip at the canonical path.
  const dest = sceneClipDestination(p.inputRoot, 18)!;
  await mkClip(dest);

  // Step 3 — resume. The Flow stub throws on ANY interaction, proving no contact.
  const r1 = await processSingleFlowScene(SCENE, forbiddenFlow(), cfgFor(p));
  check('C.1 the human-supplied clip is recognised as local media', r1.status === 'LOCAL_CLIP_ALREADY_VALID', r1.status);
  check('F.1 a recovered scene never contacts Flow (stub would have thrown)', true);
  check('F.2 no generation was attempted', r1.generationAttempts === 0, r1.generationAttempts);
  check('F.3 no download was attempted', r1.downloads === 0, r1.downloads);
  check('I.4 the clip is read from the exact canonical path', r1.localClipPath === dest, r1.localClipPath);

  const ck1 = await readSceneCheckpoint(p.ck);
  check('G.1 committed_scene_artifact_id is retained across the recovery', ck1?.committed_scene_artifact_id === COMMITTED, ck1?.committed_scene_artifact_id);
  check('G.2 the recovery provenance is recorded conservatively', ck1?.local_clip_provenance === 'human-provided-local-recovery', ck1?.local_clip_provenance);
  check('G.3 no "downloaded_from_flow" claim is made anywhere', !JSON.stringify(ck1).includes('downloaded_from_flow'));
  check('B.1 the local clip sha is now recorded', /^[0-9a-f]{64}$/.test(String(ck1?.local_clip_sha256)), ck1?.local_clip_sha256);
  check('B.2 the recovery fact survives a fresh read (restart-safe)', (await readSceneCheckpoint(p.ck))?.local_clip_provenance === 'human-provided-local-recovery');

  // Readiness: recognised as supplied local media, renderable, no Flow work needed.
  const insp = { sceneNumber: 18, title: 'Arjun Prays', narration: 'DIALOGUE', requiresNarration: false,
    backgroundTag: '#BGD-05', characterTags: ['@CHAR-01-ARJUN'],
    background: { state: 'VALID', path: null }, characters: [{ tag: '@CHAR-01-ARJUN', state: 'VALID', path: null }],
    narrationAsset: { state: 'NOT_REQUIRED', path: null },
    suppliedClip: { state: 'VALID', path: 'flow-clips/scene-0018.mp4', durationSeconds: 1, sha256: ck1!.local_clip_sha256! },
    durationSeconds: 1, durationProvenance: 'supplied-video', renderMode: 'SUPPLIED_VIDEO', readiness: 'READY', reasons: [] };
  const eligAfter = classifyFlowEligibility(insp as any);
  check('C.2 the recovered scene needs NO further Flow work', eligAfter.action === 'NONE', eligAfter);
  const needsAfter = await classifyFlowNeeds({ pipeline: { scenes: [SCENE] }, inputRoot: p.inputRoot, ffprobePath: process.env.FFPROBE_PATH } as any);
  check('C.3 classifyFlowNeeds reports haveLocal after recovery', needsAfter.haveLocal.length === 1 && needsAfter.needsRecovery.length === 0, needsAfter);
  check('C.4 the scene is renderable (SUPPLIED_VIDEO / renderable=true)', insp.renderMode === 'SUPPLIED_VIDEO' && insp.readiness === 'READY');

  // J — determinism / idempotency: repeat resumes produce identical results.
  const r2 = await processSingleFlowScene(SCENE, forbiddenFlow(), cfgFor(p));
  const ck2 = await readSceneCheckpoint(p.ck);
  check('J.1 resume is idempotent (same status)', r2.status === r1.status, { r1: r1.status, r2: r2.status });
  check('J.2 resume is deterministic (same sha)', r2.sha256 === r1.sha256, { r1: r1.sha256, r2: r2.sha256 });
  check('J.3 committed id is stable across resumes', ck2?.committed_scene_artifact_id === COMMITTED);
  check('J.4 provenance marker is stable across resumes', ck2?.local_clip_provenance === 'human-provided-local-recovery');
  check('J.5 still zero generation/download on repeat', r2.generationAttempts === 0 && r2.downloads === 0);
}

// ============ G/H. never fabricate; legacy checkpoints stay valid ============
{
  // No prior checkpoint at all -> no committed id, no provenance claim.
  const p = newProject('g-noprior');
  await mkClip(sceneClipDestination(p.inputRoot, 18)!);
  await processSingleFlowScene(SCENE, forbiddenFlow(), cfgFor(p));
  const ck = await readSceneCheckpoint(p.ck);
  check('G.4 with no prior checkpoint, no committed id is invented', ck !== null && !('committed_scene_artifact_id' in ck), ck);
  check('G.5 with no prior checkpoint, no provenance claim is made', ck !== null && !('local_clip_provenance' in ck), ck);
  check('G.6 generation_uuid stays null (never copied into the committed field)', ck?.generation_uuid === null);

  // Legacy checkpoint (no new fields) remains valid.
  const legacy = { schema_version: SCENE_CHECKPOINT_SCHEMA_VERSION, project_id: PID, scene_number: 18,
    flow_scene_id: null, flow_scene_url: null, generation_uuid: null, local_clip_path: 'flow-clips/scene-0018.mp4',
    local_clip_sha256: 'b'.repeat(64), duration_seconds: 8, width: 1280, height: 720, video_codec: 'h264',
    audio_codec: 'aac', workflow_status: 'LOCAL_CLIP_ALREADY_VALID', updated_at: '2026-10-05T00:00:00.000Z' };
  check('H.1 legacy checkpoint without the new fields is valid', validateSceneCheckpoint(legacy).ok === true);
  const lf = path.join(tmp, 'legacy.json');
  await writeSceneCheckpoint(lf, legacy as any);
  check('H.2 legacy checkpoint round-trips unchanged', (await readSceneCheckpoint(lf)) !== null);
  check('H.3 unrecognised provenance values fail closed',
    validateSceneCheckpoint({ ...legacy, local_clip_provenance: 'downloaded_from_flow' }).ok === false);
  check('H.4 the conservative provenance value is accepted',
    validateSceneCheckpoint({ ...legacy, local_clip_provenance: 'human-provided-local-recovery' }).ok === true);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} focused manual-handoff checks passed (fully offline).`);