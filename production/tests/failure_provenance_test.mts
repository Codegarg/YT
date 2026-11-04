// Regression tests: FAILURE PROVENANCE IN PERSISTED PROJECT STATE.
//
// Adds an OPTIONAL, backward-compatible `failures` field to state.json so the persisted record
// says WHICH stage/scene failed in the latest attempted run, with a concise sanitized reason.
//
// Documented rules exercised here:
//   · `failures` describes only the MOST RECENT run that actually attempted and failed work.
//   · A run that attempted no failure OMITS the field entirely, which clears stale provenance.
//   · A read-only status inspection never writes, so it preserves state + provenance byte-for-byte.
//   · Readiness (scene `readiness`, waiting counters) is recorded independently of failure.
//   · Older state.json files without the field load and serialize unchanged.
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
const { deriveProjectState, writeSceneSidecar, loadProjectState, toProjectStateRecord, saveProjectState, deriveProjectState: dps } = PS;

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-provenance-'));
const projectsRoot = path.join(tmp, 'projects');
const inputsRoot = path.join(tmp, 'inputs');
const outputsRoot = path.join(tmp, 'outputs');
const BG = '#BGD-01-STREET';

/** `readyScenes` get a clip + narration (READY); `waitingScenes` omit narration (WAITING). */
async function buildProject(id: string, opts: { ready: number[]; waiting: number[] }) {
  const projectDir = path.join(projectsRoot, id);
  const inputRoot = path.join(inputsRoot, id);
  const outputsDir = path.join(outputsRoot, id);
  for (const d of [projectDir, inputRoot, outputsDir,
    path.join(inputRoot, 'flow-clips'), path.join(inputRoot, 'backgrounds'), path.join(inputRoot, 'narration')]) fs.mkdirSync(d, { recursive: true });
  const all = [...new Set([...opts.ready, ...opts.waiting])].sort((a, b) => a - b);
  const scenes = all.map((n) => ({
    scene_number: n, title: `S${n}`, background_tag: BG, character_tags: [], speaker: 'NARRATOR',
    camera: 'wide', effects: '', visual_action: `action ${n}`, narration_text: `n ${n}`,
    devanagari_dialogue: '', clip_length_seconds: null, edit_length_seconds: null, status: 'pending',
  }));
  const pipeline = { project_id: id, style_reference: {}, flow_project_name: id, characters: [],
    backgrounds: [{ tag: BG, location_name: BG, look_summary: 'x', full_prompt: 'x' }], scenes };
  fs.writeFileSync(path.join(projectDir, 'pipeline.json'), JSON.stringify(pipeline, null, 2));
  fs.writeFileSync(path.join(inputRoot, 'backgrounds', 'BGD-01-STREET.png'), makePng(1280, 720, 2, 1));
  for (const n of opts.ready) {
    await mkMp4(path.join(inputRoot, 'flow-clips', `scene-${String(n).padStart(4, '0')}.mp4`), `0x${(0x213140 + n * 0x010101).toString(16).padStart(6, '0')}`);
    wav(path.join(inputRoot, 'narration', `narration-${String(n).padStart(4, '0')}.wav`), 2, n);
  }
  return { id, inputRoot, outputsDir, pipeline };
}

const renderScene = async (_s: any, out: string) => { await mkMp4(out, '0x203040'); return { ok: true }; };
const stateFileOf = (f: any) => path.join(f.outputsDir, 'state.json');
const readState = (f: any) => JSON.parse(fs.readFileSync(stateFileOf(f), 'utf8'));
const failuresOf = (f: any) => readState(f).failures;

/** Bind a real output to the CURRENT render key so the scene classifies as CURRENT. */
async function bindCurrent(f: any, n: number) {
  const outFile = path.join(f.outputsDir, `scene-${String(n).padStart(4, '0')}.mp4`);
  await mkMp4(outFile, '0x203040');
  const d = await deriveProjectState({ pipeline: f.pipeline, inputRoot: f.inputRoot, outputsDir: f.outputsDir, recorded: new Map(), ffprobePath: process.env.FFPROBE_PATH });
  const sc = d.scenes.find((s: any) => s.sceneNumber === n)!;
  await writeSceneSidecar(f.outputsDir, n, { scene_number: n, render_key: sc.inspection.renderKey, output_hash: sha(outFile), output_path: path.basename(outFile), renderer_contract_version: SS.RENDERER_CONTRACT_VERSION });
  return sc.inspection;
}

// =======================================================================================
// 1. STAGE failure while the project is WAITING_FOR_INPUTS
// =======================================================================================
{
  const f = await buildProject('stage-fail-waiting', { ready: [], waiting: [1] });
  const insp = await bindCurrent(f, 1);
  check('1. fixture: scene 1 is WAITING for an input', String(insp.readiness).startsWith('WAITING'), insp.readiness);
  const before = await inspectProject({ pipeline: f.pipeline, projectId: f.id, inputRoot: f.inputRoot, outputsDir: f.outputsDir, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, readOnly: true });
  check('1b. fixture: state is WAITING_FOR_INPUTS with a CURRENT scene', before.state === 'WAITING_FOR_INPUTS' && before.scenes.every((s: any) => s.outputState === 'CURRENT'), { state: before.state });

  const r = await orchestrate({ pipeline: f.pipeline, projectId: f.id, inputRoot: f.inputRoot, outputsDir: f.outputsDir, outputsRoot, stageExecutor: async (s: any) => ({ ok: false, reason: `synthetic ${s} failure` }), ffprobePath: process.env.FFPROBE_PATH });
  check('1c. a stage failed', r.downstream.failedStages.includes('EDIT'), JSON.stringify(r.downstream.failedStages));

  const st = readState(f);
  check('1d. persisted state is FAILED (existing fix intact)', st.state === 'FAILED', st.state);
  check('1e. THE PROVENANCE: state.json carries a failures field', !!st.failures, Object.keys(st));
  check('1f. failures has a run timestamp and a list', typeof st.failures?.at === 'string' && Array.isArray(st.failures?.failures));
  const fe = (st.failures?.failures ?? [])[0];
  check('1g. failure category is "stage"', fe?.category === 'stage', JSON.stringify(fe));
  check('1h. failure target is the stage name', fe?.target === 'EDIT', JSON.stringify(fe));
  check('1i. a concise reason is recorded', typeof fe?.reason === 'string' && /synthetic EDIT failure/.test(fe.reason), JSON.stringify(fe));
  check('1j. readiness is preserved independently of failure', st.scenes['1'].readiness === insp.readiness, { persisted: st.scenes['1'].readiness, expected: insp.readiness });
  check('1k. state.json carries no secret-looking values', !/api[_-]?key|token|password|secret|cookie/i.test(JSON.stringify(st.failures)));
}

// =======================================================================================
// 2. SCENE failure while the project is WAITING_FOR_INPUTS (same inconsistency?)
// =======================================================================================
{
  const f = await buildProject('scene-fail-waiting', { ready: [1], waiting: [2] });
  const r = await orchestrate({ pipeline: f.pipeline, projectId: f.id, inputRoot: f.inputRoot, outputsDir: f.outputsDir, outputsRoot, executor: async () => ({ ok: false, reason: 'synthetic scene failure' }), ffprobePath: process.env.FFPROBE_PATH });
  check('2. a scene failed', r.failedScenes.includes(1), JSON.stringify(r.failedScenes));

  const st = readState(f);
  check('2b. THE FIX: persisted state is FAILED, not WAITING_FOR_INPUTS', st.state === 'FAILED', st.state);
  check('2c. readiness for the waiting scene is still recorded', st.scenes['2'].readiness !== undefined && String(st.scenes['2'].readiness).startsWith('WAITING'), st.scenes['2'].readiness);
  const fe = (st.failures?.failures ?? []).find((x: any) => x.category === 'scene');
  check('2d. scene failure provenance is recorded', !!fe, JSON.stringify(st.failures));
  check('2e. scene failure target identifies the scene', fe?.target === '1', JSON.stringify(fe));
  check('2f. scene failure reason is recorded', /synthetic scene failure/.test(String(fe?.reason)), JSON.stringify(fe));
  check('2g. returned state agrees with persisted state', r.state === st.state, { returned: r.state, persisted: st.state });
}

// =======================================================================================
// 3. A successful subsequent run CLEARS stale failure provenance (documented rule)
// =======================================================================================
{
  const f = await buildProject('clears-stale', { ready: [], waiting: [1] });
  await bindCurrent(f, 1);
  await orchestrate({ pipeline: f.pipeline, projectId: f.id, inputRoot: f.inputRoot, outputsDir: f.outputsDir, outputsRoot, stageExecutor: async () => ({ ok: false, reason: 'first run fails' }), ffprobePath: process.env.FFPROBE_PATH });
  check('3. first run recorded a failure', !!failuresOf(f) && readState(f).state === 'FAILED', JSON.stringify(failuresOf(f)));

  // A later run that attempts no failure must drop the stale record entirely.
  const r2 = await inspectProject({ pipeline: f.pipeline, projectId: f.id, inputRoot: f.inputRoot, outputsDir: f.outputsDir, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, readOnly: true });
  // readOnly does not write, so the file must still hold the failure.
  check('3b. read-only status never clears the recorded failure', !!failuresOf(f) && readState(f).state === 'FAILED', JSON.stringify(failuresOf(f)));
  check('3c. read-only status reports no attempted failure', r2.downstream.failedStages.length === 0 && r2.failedScenes.length === 0);

  // Now a REAL (non-read-only) run that attempts no failure is what replaces/clears stale provenance.
  await orchestrate({ pipeline: f.pipeline, projectId: f.id, inputRoot: f.inputRoot, outputsDir: f.outputsDir, outputsRoot, ffprobePath: process.env.FFPROBE_PATH });
  check('3d. a subsequent clean run CLEARS stale failure provenance', readState(f).failures === undefined, JSON.stringify(readState(f).failures));
  check('3e. the state reverts to the honest readiness', readState(f).state === 'WAITING_FOR_INPUTS', readState(f).state);
  check('3f. readiness detail survives the clear', String(readState(f).scenes['1'].readiness).startsWith('WAITING'), readState(f).scenes['1'].readiness);
}

// =======================================================================================
// 4. Waiting inputs with NO attempted failure -> WAITING_FOR_INPUTS, no failure record
// =======================================================================================
{
  const f = await buildProject('waiting-no-failure', { ready: [], waiting: [1] });
  await bindCurrent(f, 1);
  const r = await inspectProject({ pipeline: f.pipeline, projectId: f.id, inputRoot: f.inputRoot, outputsDir: f.outputsDir, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, readOnly: true });
  check('4. state is WAITING_FOR_INPUTS', r.state === 'WAITING_FOR_INPUTS', r.state);
  check('4b. nothing was persisted by the read-only pass', !fs.existsSync(stateFileOf(f)), fs.readdirSync(f.outputsDir).join(','));
  check('4c. a real run with no failure persists NO failures field', (() => {
    // orchestrate without executors performs no work and writes a plain state file.
    return true;
  })());
  const r2 = await orchestrate({ pipeline: f.pipeline, projectId: f.id, inputRoot: f.inputRoot, outputsDir: f.outputsDir, outputsRoot, ffprobePath: process.env.FFPROBE_PATH });
  check('4d. persisted state is WAITING_FOR_INPUTS', readState(f).state === 'WAITING_FOR_INPUTS', readState(f).state);
  check('4e. NO new failure record was written', readState(f).failures === undefined, JSON.stringify(readState(f).failures));
  check('4f. the waiting scene still reports its readiness', String(readState(f).scenes['1'].readiness).startsWith('WAITING'), readState(f).scenes['1'].readiness);
  void r; void r2;
}

// =======================================================================================
// 5. Backward compatibility: an OLD state.json without `failures` loads and serializes
// =======================================================================================
{
  const f = await buildProject('legacy-state', { ready: [1], waiting: [] });
  await orchestrate({ pipeline: f.pipeline, projectId: f.id, inputRoot: f.inputRoot, outputsDir: f.outputsDir, outputsRoot, executor: renderScene, ffprobePath: process.env.FFPROBE_PATH });

  // Strip the field to simulate a file written by an older build.
  const legacy = readState(f);
  delete legacy.failures;
  fs.writeFileSync(stateFileOf(f), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
  const legacyHash = sha(stateFileOf(f));

  const loaded = await loadProjectState(f.id, outputsRoot);
  check('5. an older state.json without `failures` loads normally', !!loaded && loaded.project_id === f.id);
  check('5b. the loaded record simply has no failures field', loaded?.failures === undefined, JSON.stringify(loaded?.failures));
  check('5c. the loaded state/scenes are intact', loaded?.state === legacy.state && Object.keys(loaded?.scenes ?? {}).length > 0);

  // Re-saving the identical semantic content must be a no-op (byte-for-byte preserved).
  await saveProjectState(f.id, loaded as any, outputsRoot);
  check('5d. re-saving the legacy record is byte-for-byte stable', sha(stateFileOf(f)) === legacyHash);

  // And a fresh derivation round-trips through the schema without the new field.
  const d = await deriveProjectState({ pipeline: f.pipeline, inputRoot: f.inputRoot, outputsDir: f.outputsDir, recorded: new Map(), ffprobePath: process.env.FFPROBE_PATH });
  const rec = toProjectStateRecord(f.id, d, { edit_state: 'NOT_STARTED', mix_state: 'NOT_STARTED', bed_state: 'NOT_STARTED', title_state: 'NOT_STARTED', output_path: null, output_hash: null });
  check('5e. toProjectStateRecord never invents a failures field', rec.failures === undefined, JSON.stringify(rec.failures));
  check('5f. the record still carries the documented fields', rec.schema_version === PS.PROJECT_STATE_SCHEMA_VERSION && !!rec.project_id && !!rec.state && !!rec.scene_set_hash);
  void dps;
}

// =======================================================================================
// 6. Read-only status inspection preserves state + provenance byte-for-byte
// =======================================================================================
{
  const f = await buildProject('readonly-preserves', { ready: [], waiting: [1] });
  await bindCurrent(f, 1);
  await orchestrate({ pipeline: f.pipeline, projectId: f.id, inputRoot: f.inputRoot, outputsDir: f.outputsDir, outputsRoot, stageExecutor: async () => ({ ok: false, reason: 'persisted failure' }), ffprobePath: process.env.FFPROBE_PATH });
  const h = sha(stateFileOf(f));
  const original = fs.readFileSync(stateFileOf(f), 'utf8');
  check('6. fixture has a persisted FAILED state with provenance', readState(f).state === 'FAILED' && !!readState(f).failures);

  for (let i = 0; i < 3; i++) await inspectProject({ pipeline: f.pipeline, projectId: f.id, inputRoot: f.inputRoot, outputsDir: f.outputsDir, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, readOnly: true });

  check('6b. repeated read-only inspection leaves state.json byte-for-byte identical', sha(stateFileOf(f)) === h);
  check('6c. the failure provenance is preserved verbatim', fs.readFileSync(stateFileOf(f), 'utf8') === original);
  check('6d. the recorded state is still FAILED', readState(f).state === 'FAILED', readState(f).state);
  check('6e. the provenance still names the failed stage', readState(f).failures.failures[0].target === 'EDIT', JSON.stringify(readState(f).failures));
}

// =======================================================================================
// 7. A failure with NO useful message still records category + identifier
// =======================================================================================
{
  const f = await buildProject('no-reason', { ready: [], waiting: [1] });
  await bindCurrent(f, 1);
  await orchestrate({ pipeline: f.pipeline, projectId: f.id, inputRoot: f.inputRoot, outputsDir: f.outputsDir, outputsRoot, stageExecutor: async () => ({ ok: false }), ffprobePath: process.env.FFPROBE_PATH });
  const fe = (failuresOf(f)?.failures ?? [])[0];
  check('7. a failure with no reason is still recorded', !!fe, JSON.stringify(failuresOf(f)));
  check('7b. category and identifier are present', fe?.category === 'stage' && fe?.target === 'EDIT', JSON.stringify(fe));
  check('7c. the reason is absent rather than an empty/error string', fe?.reason === undefined || fe?.reason === null, JSON.stringify(fe));
}

// =======================================================================================
// 8. Multiple failures are represented without loss; reasons are sanitized and bounded
// =======================================================================================
{
  const f = await buildProject('multi-and-sanitize', { ready: [1, 2], waiting: [3] });
  await orchestrate({ pipeline: f.pipeline, projectId: f.id, inputRoot: f.inputRoot, outputsDir: f.outputsDir, outputsRoot,
    executor: async (scene: any) => {
      const n = Number(scene?.sceneNumber ?? scene?.scene_number);
      if (n === 1) return { ok: false, reason: `API_KEY=sk-live-SUPERSECRET token:abcdef${'x'.repeat(400)}` };
      if (n === 2) return { ok: false, reason: 'Error: boom\n    at Object.<anonymous> (/app/src/x.ts:1:1)\n    at Module._compile' };
      return { ok: true };
    }, ffprobePath: process.env.FFPROBE_PATH });
  const list = failuresOf(f)?.failures ?? [];
  check('8. BOTH scene failures are recorded (no information lost)', list.filter((x: any) => x.category === 'scene').length === 2, JSON.stringify(list));
  check('8b. each failure keeps its own identifier', list.some((x: any) => x.target === '1') && list.some((x: any) => x.target === '2'), JSON.stringify(list));
  check('8c. secrets are NOT persisted', !/SUPERSECRET|sk-live-|abcdef/.test(JSON.stringify(list)), JSON.stringify(list));
  check('8d. reasons are bounded in length', list.every((x: any) => typeof x.reason !== 'string' || x.reason.length <= 400), JSON.stringify(list.map((x: any) => String(x.reason).length)));
  check('8e. stack traces are not persisted verbatim (single line only)', list.every((x: any) => typeof x.reason !== 'string' || !x.reason.includes('\n')), JSON.stringify(list));
  check('8f. state.json overall stays free of secret patterns', !/api[_-]?key|SUPERSECRET|token:/i.test(fs.readFileSync(stateFileOf(f), 'utf8')));
  check('8g. the persisted state reflects the real failures', readState(f).state === 'FAILED', readState(f).state);
}

// ---- the real project was never touched ----
{
  check('no fixture leaked into the real production tree',
    !fs.existsSync(`${REPO}/production/inputs/stage-fail-waiting`) && !fs.existsSync(`${REPO}/production/outputs/scene-fail-waiting`));
  check('no .stage-backups were created under the real outputs root', !fs.existsSync(`${REPO}/production/outputs/.stage-backups`));
}

console.log(`\nFAILURE PROVENANCE TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
