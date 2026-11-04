// Regression tests for STATUS VISIBILITY UNDER BLOCKERS.
//
// Issue: in src/projectOrchestrator.ts the readiness-only inspection pass was gated on
// `blockers.length === 0`. Any missing input therefore left `orchestration` null and `status`
// reported NO per-scene and NO per-stage state at all, so an operator could not see which scenes
// were already produced, which stage was CURRENT, or where production had stalled.
//
// Also covers the companion safety guard in `classifyRunStatus`: a real stage failure must never
// be reported as WAITING_FOR_INPUTS.
//
// LOCAL-ONLY, fully offline, isolated os.tmpdir() fixtures. No Flow/Chrome/network, no real
// project data, no production stages executed.
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

const PO = await import(pathToFileURL(`${SRC}/projectOrchestrator.ts`).href);
const ORCH = await import(pathToFileURL(`${SRC}/productionOrchestrator.ts`).href);
const { runProject, classifyRunStatus, collectBlockers } = PO;

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'status-visibility-'));
const projectsRoot = path.join(tmp, 'projects');
const inputsRoot = path.join(tmp, 'inputs');
const outputsRoot = path.join(tmp, 'outputs');

const BG = '#BGD-01-STREET';
/**
 * Build a project whose inputs are COMPLETE (so every scene is READY) and whose scene outputs can
 * be rendered. `omitNarration` deliberately leaves one narration file out, which is the blocker
 * used to prove that `status` still reports per-scene/per-stage state.
 */
async function buildProject(id: string, opts: { omitNarration?: number } = {}) {
  const projectDir = path.join(projectsRoot, id);
  const inputRoot = path.join(inputsRoot, id);
  const outputsDir = path.join(outputsRoot, id);
  for (const d of [projectDir, inputRoot, outputsDir,
    path.join(inputRoot, 'flow-clips'), path.join(inputRoot, 'backgrounds'), path.join(inputRoot, 'narration'),
    path.join(inputRoot, 'music'), path.join(inputRoot, 'branding')]) fs.mkdirSync(d, { recursive: true });

  const scenes: any[] = [];
  for (let n = 1; n <= 2; n++) {
    scenes.push({
      scene_number: n, title: `S${n}`, background_tag: BG, character_tags: [], speaker: 'NARRATOR',
      camera: 'wide', effects: '', visual_action: `action ${n}`, narration_text: `n ${n}`,
      devanagari_dialogue: '', clip_length_seconds: null, edit_length_seconds: null, status: 'pending',
    });
  }
  fs.writeFileSync(path.join(projectDir, 'pipeline.json'), JSON.stringify({
    project_id: id, style_reference: {}, flow_project_name: id, characters: [],
    backgrounds: [{ tag: BG, location_name: BG, look_summary: 'x', full_prompt: 'x' }], scenes,
  }, null, 2));

  fs.writeFileSync(path.join(inputRoot, 'backgrounds', 'BGD-01-STREET.png'), makePng(1280, 720, 2, 1));
  for (let n = 1; n <= 2; n++) {
    await mkMp4(path.join(inputRoot, 'flow-clips', `scene-${String(n).padStart(4, '0')}.mp4`), n === 1 ? '0x213141' : '0x314151');
    if (opts.omitNarration === n) continue;
    wav(path.join(inputRoot, 'narration', `narration-${String(n).padStart(4, '0')}.wav`), 2, n);
  }
  // Music and branding are REQUIRED project inputs (inputValidator; manifest requirement:
  // 'REQUIRED'; BED/TITLE stages read these exact paths). They are supplied here so that a
  // fixture built WITHOUT `omitNarration` is genuinely complete — which is what the "no blockers"
  // case in section C asserts. Without them that assertion was only passing because missing
  // music/branding was never propagated into blockers.
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=6:sample_rate=44100', '-ac', '2', '-b:a', '96k', path.join(inputRoot, 'music', 'background-music.mp3')]);
  fs.writeFileSync(path.join(inputRoot, 'music', 'background-music.license.json'), JSON.stringify({ license: 'CC0' }));
  await mkMp4(path.join(inputRoot, 'branding', 'channel-intro.mp4'), '0x101020');
  fs.writeFileSync(path.join(inputRoot, 'branding', 'channel-logo.png'), makePng(256, 256, 6, 3));

  return { id, projectDir, inputRoot, outputsDir, projectFile: path.join(projectDir, 'pipeline.json'), pipeline: JSON.parse(fs.readFileSync(path.join(projectDir, 'pipeline.json'), 'utf8')) };
}

/** Render scene outputs (read-only stage planning is separate) so the project has real progress. */
async function renderScenes(f: any) {
  const sceneEx = async (scene: any, out: string) => { await mkMp4(out, '0x203040'); return { ok: true }; };
  await ORCH.orchestrate({ pipeline: f.pipeline, projectId: f.id, inputRoot: f.inputRoot, outputsDir: f.outputsDir, outputsRoot, executor: sceneEx, ffprobePath: process.env.FFPROBE_PATH });
}

// =======================================================================================
// A. Pure decision function: a real stage failure must outrank missing inputs
// =======================================================================================
{
  const blockers = [{ category: 'narration' as const, detail: 'missing narration for scene(s) 2' }];
  check('A1. blockers alone still mean WAITING_FOR_INPUTS (unchanged)',
    classifyRunStatus({ blockers }) === 'WAITING_FOR_INPUTS', classifyRunStatus({ blockers }));
  check('A2. a real stage failure is NOT masked by blockers',
    classifyRunStatus({ blockers, failedStages: ['MIX'] }) === 'RECOVERABLE_FAILURE', classifyRunStatus({ blockers, failedStages: ['MIX'] }));
  check('A3. an empty failedStages array preserves blocker behaviour',
    classifyRunStatus({ blockers, failedStages: [] }) === 'WAITING_FOR_INPUTS', classifyRunStatus({ blockers, failedStages: [] }));
  check('A4. failure outranks even an all-current downstream chain',
    classifyRunStatus({ blockers, failedStages: ['BED'], downstreamAllCurrent: true, titleCurrent: true }) === 'RECOVERABLE_FAILURE');
  check('A5. a completed chain with no blockers is unchanged',
    classifyRunStatus({ downstreamAllCurrent: true, titleCurrent: true }) === 'COMPLETED_TO_APPROVAL');
  check('A6. no blockers and not complete is still RECOVERABLE_FAILURE',
    classifyRunStatus({ downstreamAllCurrent: false, titleCurrent: false }) === 'RECOVERABLE_FAILURE');
  check('A7. undefined input is handled fail-safe',
    classifyRunStatus(undefined) === 'RECOVERABLE_FAILURE' && classifyRunStatus(null) === 'RECOVERABLE_FAILURE');
  check('A8. a failure with NO blockers is still a failure',
    classifyRunStatus({ blockers: [], failedStages: ['EDIT'] }) === 'RECOVERABLE_FAILURE');
}

// =======================================================================================
// B. THE REGRESSION: status must report per-scene and per-stage state even with blockers
// =======================================================================================
{
  // Project with BOTH scenes rendered, then narration for scene 2 removed -> a blocker exists.
  const f = await buildProject('blocked-project', { omitNarration: 2 });
  await renderScenes(f);
  check('B0. fixture produced two scene outputs', fs.existsSync(path.join(f.outputsDir, 'scene-0001.mp4')) && fs.existsSync(path.join(f.outputsDir, 'scene-0002.mp4')));

  // Capture the exact on-disk state so we can prove the read-only inspection changed nothing.
  // `run.log.jsonl` is excluded: runProject has ALWAYS appended a bounded run-log line unless
  // --dryRun (projectOrchestrator.ts appendBoundedRunLog), on the no-blocker path too. It is
  // pre-existing behaviour unrelated to this change, so it is asserted separately below.
  const snapshot = (dir: string): string => {
    const out: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { walk(p); continue; } if (path.basename(p) === 'run.log.jsonl') continue; out.push(`${path.relative(dir, p)}:${sha(p)}`); } };
    if (fs.existsSync(dir)) walk(dir);
    return out.sort().join('|');
  };
  const beforeOut = snapshot(f.outputsDir);
  const beforeIn = snapshot(f.inputRoot);
  const beforeOutList = fs.readdirSync(f.outputsDir).filter((f) => f !== 'run.log.jsonl').sort().join(',');
  const scene1Before = sha(path.join(f.outputsDir, 'scene-0001.mp4'));
  // state.json exists already (written by the render step above); the read-only pass must not touch it.
  const stateBefore = fs.existsSync(path.join(f.outputsDir, 'state.json')) ? sha(path.join(f.outputsDir, 'state.json')) : null;

  const r = await runProject({
    projectId: f.id, projectsRoot, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH,
    // NO sceneExecutor supplied -> nothing can execute; this is a pure status call.
  } as any);

  check('B1. a blocker IS present for the missing narration', r.blockers.some((b: any) => b.category === 'narration'), JSON.stringify(r.blockers));
  check('B2. status is still WAITING_FOR_INPUTS (behaviour preserved)', r.status === 'WAITING_FOR_INPUTS', r.status);
  check('B3. THE FIX: orchestration is NOT null under blockers', r.orchestration !== null && r.orchestration !== undefined, String(r.orchestration));

  const o = r.orchestration;
  check('B4. per-SCENE state is reported', Array.isArray(o.scenes) && o.scenes.length === 2, JSON.stringify(o.scenes?.length));
  check('B5. each scene carries its own classification', (o.scenes ?? []).every((s: any) => typeof s.outputState === 'string' && typeof s.readiness === 'string'),
    JSON.stringify((o.scenes ?? []).map((s: any) => ({ n: s.sceneNumber, o: s.outputState, r: s.readiness }))));
  check('B6. the already-rendered scene 1 is visible as CURRENT', (o.scenes ?? []).find((s: any) => Number(s.sceneNumber) === 1)?.outputState === 'CURRENT',
    JSON.stringify((o.scenes ?? []).map((s: any) => ({ n: s.sceneNumber, o: s.outputState }))));
  check('B7. per-STAGE state is reported for all four stages',
    ['EDIT', 'MIX', 'BED', 'TITLE'].every((s) => typeof o.downstream?.states?.[s] === 'string'), JSON.stringify(o.downstream?.states));
  check('B8. stage keys are reported', ['EDIT', 'MIX', 'BED', 'TITLE'].every((s) => typeof o.downstream?.keys?.[s] === 'string' && o.downstream.keys[s].length > 0));
  check('B9. the downstream work set is reported', Array.isArray(o.downstream?.workSet), JSON.stringify(o.downstream?.workSet));
  check('B10. scene output hashes are reported', Object.keys(o.sceneOutputHashes ?? {}).length >= 1, JSON.stringify(o.sceneOutputHashes));
  check('B11. stage counts are reported', typeof o.sceneCount === 'number' && o.sceneCount === 2, String(o.sceneCount));

  check('B12. nextAction still tells the operator what to supply', /Supply:/.test(r.nextAction), r.nextAction);
  check('B13. the read-only inspection wrote NOTHING to outputs (run.log.jsonl excluded)', snapshot(f.outputsDir) === beforeOut,
    snapshot(f.outputsDir));
  check('B13b. no file was added to or removed from the outputs dir (run.log.jsonl excluded)',
    fs.readdirSync(f.outputsDir).filter((f) => f !== 'run.log.jsonl').sort().join(',') === beforeOutList,
    `${beforeOutList} -> ${fs.readdirSync(f.outputsDir).sort().join(',')}`);
  check('B13c. the only write is the pre-existing bounded run log', fs.existsSync(path.join(f.outputsDir, 'run.log.jsonl')));
  check('B14. the read-only inspection wrote NOTHING to inputs', snapshot(f.inputRoot) === beforeIn);
  check('B15. no scene output was modified by the status call', sha(path.join(f.outputsDir, 'scene-0001.mp4')) === scene1Before);
  check('B16. the inspection did NOT execute any stage', (o.downstream?.executedStages ?? []).length === 0, JSON.stringify(o.downstream?.executedStages));
  check('B17. the read-only pass did NOT rewrite state.json', sha(path.join(f.outputsDir, 'state.json')) === stateBefore,
    sha(path.join(f.outputsDir, 'state.json')));
}

// =======================================================================================
// C. No regression: a project with NO blockers behaves exactly as before
// =======================================================================================
{
  const f = await buildProject('clean-project');
  await renderScenes(f);
  const r = await runProject({ projectId: f.id, projectsRoot, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH } as any);
  check('C1. a complete project has no blockers', r.blockers.length === 0, JSON.stringify(r.blockers));
  check('C2. status is not WAITING_FOR_INPUTS', r.status !== 'WAITING_FOR_INPUTS', r.status);
  check('C3. orchestration is still populated', r.orchestration !== null);
  check('C4. per-scene state is present', (r.orchestration?.scenes ?? []).length === 2);
  check('C5. per-stage state is present', ['EDIT', 'MIX', 'BED', 'TITLE'].every((s) => typeof r.orchestration?.downstream?.states?.[s] === 'string'));
  check('C6. all rendered scenes are CURRENT', (r.orchestration?.scenes ?? []).every((s: any) => s.outputState === 'CURRENT'),
    JSON.stringify((r.orchestration?.scenes ?? []).map((s: any) => s.outputState)));
}

// =======================================================================================
// D. Scoped runs are unchanged: blockers stay scoped to the SELECTION, and no stage executes
// =======================================================================================
{
  const f = await buildProject('scoped-project', { omitNarration: 2 });
  await renderScenes(f);
  // Unscoped: scene 2's missing narration IS a blocker.
  const full = await runProject({ projectId: f.id, projectsRoot, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH } as any);
  check('D1. unscoped: the unrelated scene\'s missing narration IS a blocker', full.blockers.some((b: any) => b.category === 'narration'), JSON.stringify(full.blockers));

  // Scoped to scene 1 only: blockers are scoped to the selection, so scene 2 is not considered.
  const r = await runProject({ projectId: f.id, projectsRoot, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, onlyScenes: [1] } as any);
  check('D2. scoped: an UNRELATED scene\'s missing input is not a blocker', !r.blockers.some((b: any) => b.category === 'narration'), JSON.stringify(r.blockers));
  check('D3. scoped: never executes downstream stages', ((r.orchestration?.downstream?.executedStages ?? []) as string[]).length === 0, JSON.stringify(r.orchestration?.downstream?.executedStages));
  check('D4. scoped: status is a scope status, never COMPLETED_TO_APPROVAL',
    ['SCENE_SCOPE_COMPLETED', 'SCENE_SCOPE_INCOMPLETE'].includes(r.status), r.status);
  // This change is deliberately UNSCOPED: a scoped run without an executor still returns
  // orchestration === null, exactly as before. Asserted so the scoped path cannot regress.
  check('D5. scoped: behaviour is UNCHANGED (no executor -> orchestration stays null)',
    r.orchestration === null || r.orchestration === undefined, String(r.orchestration));
}

// =======================================================================================
// E. collectBlockers contract (unchanged; guards the blocker inputs used above)
// =======================================================================================
{
  const b = collectBlockers({ missingNarrationScenes: [2], musicMissing: true });
  check('E1. narration blocker is produced', b.some((x) => x.category === 'narration'));
  check('E2. music blocker is produced when explicitly supplied', b.some((x) => x.category === 'music'));
  check('E3. no blockers when nothing is missing', collectBlockers({}).length === 0);
}

// ---- the real project was never touched ----
{
  check('no .stage-backups or state was created under the real outputs root',
    !fs.existsSync(`${REPO}/production/outputs/.stage-backups`));
  check('no fixture leaked into the real production tree',
    !fs.existsSync(`${REPO}/production/inputs/status-visibility-failed-project`)
    && !fs.existsSync(`${REPO}/production/outputs/blocked-project`));
}

console.log(`\nSTATUS VISIBILITY UNDER BLOCKERS TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
