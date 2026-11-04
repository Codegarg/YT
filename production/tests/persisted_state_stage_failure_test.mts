// Regression tests: PERSISTED PROJECT STATE AFTER A GENUINE STAGE FAILURE.
//
// Invariant under test: when a downstream stage was actually ATTEMPTED and FAILED, the persisted
// project state must not record that failed run as merely WAITING_FOR_INPUTS.
//
// Before the fix, productionOrchestrator.ts escalated a stage failure to FAILED only when the
// derived state was NEITHER INPUTS_INVALID NOR WAITING_FOR_INPUTS, so a missing input silently
// downgraded a real, already-occurred stage failure to "just waiting for inputs" in state.json.
//
// LOCAL-ONLY, fully offline, isolated os.tmpdir() fixtures. No Flow/Chrome/network, no real
// project data, no production stage producers executed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);

import { REPO } from './_testPaths.mjs';
const SRC = `${REPO}/production/src`;
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
process.env.PATH = `${FF};${process.env.PATH}`;

const ORCH = await import(pathToFileURL(`${SRC}/productionOrchestrator.ts`).href);
const PS = await import(pathToFileURL(`${SRC}/projectState.ts`).href);
const SS = await import(pathToFileURL(`${SRC}/sceneState.ts`).href);
const { orchestrate, inspectProject } = ORCH;
const { deriveProjectState, writeSceneSidecar, loadProjectState, isLegalTransition } = PS;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

function makePng(w: number, h: number, ct = 6, tag = 0) {
  const T: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct; const ch = ct === 6 ? 4 : 2; const raw = Buffer.alloc(h * (1 + w * ch), 0x80);
  for (let y = 0; y < h; y++) raw[y * (1 + w * ch)] = 0; raw[11] = (tag & 0xff);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const wav = (f: string, sec: number, tag = 0) => {
  const n = Math.round(sec * 8000); const d = Buffer.alloc(n * 2, tag); const b = Buffer.alloc(44 + d.length);
  b.write('RIFF', 0); b.writeUInt32LE(36 + d.length, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(d.length, 40); d.copy(b, 44);
  fs.writeFileSync(f, b);
};
const mkMp4 = async (o: string, color = '0x203040') => {
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=640x360:d=2`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', o]);
};
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'state-escalation-'));
const projectsRoot = path.join(tmp, 'projects');
const inputsRoot = path.join(tmp, 'inputs');
const outputsRoot = path.join(tmp, 'outputs');
const BG = '#BGD-01-STREET';

async function buildProject(id: string, opts: { omitNarration?: boolean } = {}) {
  const projectDir = path.join(projectsRoot, id);
  const inputRoot = path.join(inputsRoot, id);
  const outputsDir = path.join(outputsRoot, id);
  for (const d of [projectDir, inputRoot, outputsDir,
    path.join(inputRoot, 'flow-clips'), path.join(inputRoot, 'backgrounds'), path.join(inputRoot, 'narration')]) fs.mkdirSync(d, { recursive: true });
  const scenes = [1].map((n) => ({
    scene_number: n, title: `S${n}`, background_tag: BG, character_tags: [], speaker: 'NARRATOR',
    camera: 'wide', effects: '', visual_action: `action ${n}`, narration_text: `n ${n}`,
    devanagari_dialogue: '', clip_length_seconds: null, edit_length_seconds: null, status: 'pending',
  }));
  const pipeline = { project_id: id, style_reference: {}, flow_project_name: id, characters: [],
    backgrounds: [{ tag: BG, location_name: BG, look_summary: 'x', full_prompt: 'x' }], scenes };
  fs.writeFileSync(path.join(projectDir, 'pipeline.json'), JSON.stringify(pipeline, null, 2));
  fs.writeFileSync(path.join(inputRoot, 'backgrounds', 'BGD-01-STREET.png'), makePng(1280, 720, 2, 1));
  if (!opts.omitNarration) {
    await mkMp4(path.join(inputRoot, 'flow-clips', 'scene-0001.mp4'), '0x213141');
    wav(path.join(inputRoot, 'narration', 'narration-0001.wav'), 2, 1);
  }
  return { id, inputRoot, outputsDir, pipeline, projectFile: path.join(projectDir, 'pipeline.json') };
}

/** Render scene outputs through the orchestrator's scene executor (synthetic producer). */
async function renderScenes(f: any) {
  const sceneEx = async (_s: any, out: string) => { await mkMp4(out, '0x203040'); return { ok: true }; };
  await orchestrate({ pipeline: f.pipeline, projectId: f.id, inputRoot: f.inputRoot, outputsDir: f.outputsDir, outputsRoot, executor: sceneEx, ffprobePath: process.env.FFPROBE_PATH });
}

/**
 * Build the exact scenario the bug needs: the project is WAITING_FOR_INPUTS (an input is missing)
 * while EVERY scene output is still CURRENT (valid output + matching sidecar). Stages are allowed
 * to run in this state because the orchestrator gates them on `allScenesCurrent`, which is
 * independent of readiness — exactly how a real project ends up "waiting" yet still stageable.
 */
async function buildWaitingButCurrent(f: any) {
  const outFile = path.join(f.outputsDir, 'scene-0001.mp4');
  await mkMp4(outFile, '0x203040');
  // Read the CURRENT render key for this (input-incomplete) scene, then bind the output to it.
  const d = await deriveProjectState({ pipeline: f.pipeline, inputRoot: f.inputRoot, outputsDir: f.outputsDir, recorded: new Map(), ffprobePath: process.env.FFPROBE_PATH });
  const key = d.scenes[0].inspection.renderKey;
  await writeSceneSidecar(f.outputsDir, 1, {
    scene_number: 1, render_key: key, output_hash: sha(outFile),
    output_path: 'scene-0001.mp4', renderer_contract_version: SS.RENDERER_CONTRACT_VERSION,
  });
  return { renderKey: key, readiness: d.scenes[0].inspection.readiness, derivedState: d.state, counts: d.counts };
}

const failingStageExecutor = async (stage: any) => ({ ok: false, reason: `synthetic ${stage} failure` });
const okStageExecutor = async (stage: any, outPath: string) => { await mkMp4(outPath, '0x5a6b7c'); return { ok: true, outputHash: sha(outPath) }; };
const persisted = async (f: any) => JSON.parse(fs.readFileSync(path.join(f.outputsDir, 'state.json'), 'utf8'));

// =======================================================================================
// 1. Missing inputs, NO attempted stage failure -> legitimate WAITING_FOR_INPUTS is preserved
// =======================================================================================
{
  const f = await buildProject('waiting-no-failure', { omitNarration: true });
  const info = await buildWaitingButCurrent(f);
  check('1.0 fixture: the scene really is WAITING for an input', String(info.readiness).startsWith('WAITING'), info.readiness);
  check('0b. fixture: the derived state is WAITING_FOR_INPUTS', info.derivedState === 'WAITING_FOR_INPUTS', info.derivedState);

  // NO stageExecutor -> no stage is attempted, so nothing may be escalated.
  // `readOnly: true` is what production's status path uses (projectOrchestrator.ts), so this is a
  // genuine STATUS INSPECTION: it must never rewrite state.json.
  const r = await inspectProject({ pipeline: f.pipeline, projectId: f.id, inputRoot: f.inputRoot, outputsDir: f.outputsDir, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, readOnly: true });
  check('1. no stage was attempted', (r.downstream.failedStages ?? []).length === 0, JSON.stringify(r.downstream.failedStages));
  check('1b. returned state stays WAITING_FOR_INPUTS', r.state === 'WAITING_FOR_INPUTS', r.state);
  check('1c. the readiness detail is retained (waiting counters are non-zero)',
    (info.counts.waitingNarration + info.counts.waitingVideo + info.counts.waitingBackground + info.counts.waitingCharacter) > 0, JSON.stringify(info.counts));
  check('1d. the scene output is still CURRENT', r.scenes[0].outputState === 'CURRENT', r.scenes[0].outputState);
}

// =======================================================================================
// 2. Attempted stage fails, NO blockers -> persisted state is FAILED (existing behaviour)
// =======================================================================================
{
  const f = await buildProject('fails-clean');
  await renderScenes(f);
  const r = await orchestrate({ pipeline: f.pipeline, projectId: f.id, inputRoot: f.inputRoot, outputsDir: f.outputsDir, outputsRoot, stageExecutor: failingStageExecutor, ffprobePath: process.env.FFPROBE_PATH });
  check('2. a stage was attempted and failed', r.downstream.failedStages.length > 0, JSON.stringify(r.downstream.failedStages));
  check('2b. returned state is FAILED', r.state === 'FAILED', r.state);
  const st = await persisted(f);
  check('2c. PERSISTED state.json is FAILED', st.state === 'FAILED', st.state);
  check('2d. the failed stage is retained in the report', r.downstream.failedStages.includes('EDIT'), JSON.stringify(r.downstream.failedStages));
  check('2e. the failed stage did not become CURRENT', r.downstream.states.EDIT !== 'CURRENT', r.downstream.states.EDIT);
  check('2f. no stage sidecar was written for the failure', !fs.existsSync(path.join(f.outputsDir, 'final-with-fades.mp4.stage')));
}

// =======================================================================================
// 3. THE REGRESSION: a genuine stage failure must NOT be persisted as WAITING_FOR_INPUTS
// =======================================================================================
{
  const f = await buildProject('fails-while-waiting', { omitNarration: true });
  const info = await buildWaitingButCurrent(f);
  check('3.0 fixture: WAITING_FOR_INPUTS with all scenes CURRENT', info.derivedState === 'WAITING_FOR_INPUTS', info.derivedState);

  const before = await inspectProject({ pipeline: f.pipeline, projectId: f.id, inputRoot: f.inputRoot, outputsDir: f.outputsDir, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, readOnly: true });
  check('3.0b. without an executor the state is WAITING_FOR_INPUTS (the downgrade source)',
    before.state === 'WAITING_FOR_INPUTS' && before.scenes.every((s: any) => s.outputState === 'CURRENT'), { state: before.state, scenes: before.scenes.map((s: any) => s.outputState) });

  // Now attempt a stage that FAILS, while the project is waiting on an input.
  const r = await orchestrate({ pipeline: f.pipeline, projectId: f.id, inputRoot: f.inputRoot, outputsDir: f.outputsDir, outputsRoot, stageExecutor: failingStageExecutor, ffprobePath: process.env.FFPROBE_PATH });
  check('3. the stage really was attempted and failed', r.downstream.failedStages.length > 0, JSON.stringify(r.downstream.failedStages));

  const st = await persisted(f);
  check('3b. THE FIX: persisted state is FAILED, not WAITING_FOR_INPUTS', st.state === 'FAILED', st.state);
  check('3c. returned state is FAILED too (no disagreement between the two)', r.state === 'FAILED', r.state);
  check('3d. the failed stage is still reported', r.downstream.failedStages.includes('EDIT'), JSON.stringify(r.downstream.failedStages));
  check('3e. readiness/failure are NOT conflated: the input is still reported as missing',
    (r.counts.waitingNarration + r.counts.waitingVideo) > 0, JSON.stringify(r.counts));
  check('3f. scene readiness detail survives in state.json',
    st.scenes['1'].readiness === String(info.readiness), { persisted: st.scenes['1'].readiness, expected: info.readiness });
  check('3g. the scene output was NOT destroyed by the failure', r.scenes[0].outputState === 'CURRENT', r.scenes[0].outputState);

  // ---- 4. repeated inspection must not mutate state or erase the recorded failure ----
  const stateFile = path.join(f.outputsDir, 'state.json');
  const stHash = sha(stateFile);
  const again = await inspectProject({ pipeline: f.pipeline, projectId: f.id, inputRoot: f.inputRoot, outputsDir: f.outputsDir, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, readOnly: true });
  check('4. repeated read-only inspection does NOT rewrite state.json', sha(stateFile) === stHash);
  check('4b. the recorded FAILED failure is not erased', (await persisted(f)).state === 'FAILED', (await persisted(f)).state);
  check('4c. a fresh derivation reports the current readiness honestly (WAITING, no execution attempted)',
    again.state === 'WAITING_FOR_INPUTS' && again.downstream.failedStages.length === 0, { state: again.state, failed: again.downstream.failedStages });
  check('4d. the read-only pass performed no stage execution', (again.downstream.executedStages ?? []).length === 0, JSON.stringify(again.downstream.executedStages));
}

// =======================================================================================
// 5. Successful execution retains the existing successful-state behaviour (no FAILED)
// =======================================================================================
{
  const f = await buildProject('succeeds');
  await renderScenes(f);
  const r = await orchestrate({ pipeline: f.pipeline, projectId: f.id, inputRoot: f.inputRoot, outputsDir: f.outputsDir, outputsRoot, stageExecutor: okStageExecutor, ffprobePath: process.env.FFPROBE_PATH });
  const st = await persisted(f);
  check('5. no stage failed', r.downstream.failedStages.length === 0, JSON.stringify(r.downstream.failedStages));
  check('5b. persisted state is NOT FAILED', st.state !== 'FAILED', st.state);
  check('5c. persisted state matches the returned state', st.state === r.state, { persisted: st.state, returned: r.state });
  check('5d. the executed stage is not CURRENT-blocked', r.downstream.states.EDIT === 'CURRENT', r.downstream.states.EDIT);
}

// =======================================================================================
// 6. INPUTS_INVALID remains exempt (existing semantics preserved)
// =======================================================================================
{
  const f = await buildProject('invalid-inputs');
  // Corrupt the background PNG so the background is INVALID -> INPUTS_INVALID.
  fs.writeFileSync(path.join(f.inputRoot, 'backgrounds', 'BGD-01-STREET.png'), Buffer.from('not a png at all'));
  await mkMp4(path.join(f.inputRoot, 'flow-clips', 'scene-0001.mp4'), '0x213141');
  wav(path.join(f.inputRoot, 'narration', 'narration-0001.wav'), 2, 1);
  const r = await orchestrate({ pipeline: f.pipeline, projectId: f.id, inputRoot: f.inputRoot, outputsDir: f.outputsDir, outputsRoot, stageExecutor: failingStageExecutor, ffprobePath: process.env.FFPROBE_PATH });
  const st = await persisted(f);
  check('6. an invalid input still yields INPUTS_INVALID, not FAILED', st.state === 'INPUTS_INVALID', st.state);
  check('6b. INPUTS_INVALID is preserved exactly as before this change', r.state === 'INPUTS_INVALID', r.state);
}

// =======================================================================================
// 7. The documented state machine agrees with the new behaviour
// =======================================================================================
{
  check('7. WAITING_FOR_INPUTS -> FAILED is a legal transition', isLegalTransition('WAITING_FOR_INPUTS', 'FAILED') === true);
  check('7b. WAITING_FOR_INPUTS -> COMPLETED remains illegal', isLegalTransition('WAITING_FOR_INPUTS', 'COMPLETED') === false);
  check('7c. WAITING_FOR_INPUTS -> READY_FOR_RENDER remains legal', isLegalTransition('WAITING_FOR_INPUTS', 'READY_FOR_RENDER') === true);
  check('7d. FAILED can still recover to READY_FOR_RENDER', isLegalTransition('FAILED', 'READY_FOR_RENDER') === true);
}

// ---- the real project was never touched ----
{
  check('no fixture leaked into the real production tree',
    !fs.existsSync(`${REPO}/production/inputs/fails-while-waiting`) && !fs.existsSync(`${REPO}/production/outputs/fails-while-waiting`));
  check('no .stage-backups were created under the real outputs root', !fs.existsSync(`${REPO}/production/outputs/.stage-backups`));
}

console.log(`\nPERSISTED STATE AFTER STAGE FAILURE TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
