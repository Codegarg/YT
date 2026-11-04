// STEP-8GU — COMPLETE project-workflow E2E on an ISOLATED 14-scene fixture.
// Uses the REAL project workflow boundary (resumeProjectWorkflow -> runProject -> orchestrate)
// and the REAL downstream producers (edit/mixNarration/addMusicBed/addTitle). ZERO Flow/Chrome.
// Real canonical project is never touched. Scene clips and backgrounds are SYNTHESISED.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import zlib from 'node:zlib'; import crypto from 'node:crypto'; import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import { pathToFileURL } from 'node:url';
import { writeFixtureBackgrounds, createFixtureClipBank, installFixtureClips } from './helpers/isolatedFixtures.mts';
const exec = promisify(execFile);
import { REPO } from './_testPaths.mjs';
const SRC = `${REPO}/production/src`;
const PROD = `${REPO}/production`;
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
process.env.PATH = `${FF};${process.env.PATH}`;
const WF = await import(pathToFileURL(`${SRC}/projectWorkflow.ts`).href);
const VC = await import(pathToFileURL(`${SRC}/videoClip.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const shaOrNull = (f: string) => (fs.existsSync(f) ? sha(f) : null);

function makePng(w: number, h: number, ct = 6, tag = 0) { const T: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; } const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }; const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); }; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct; const ch = ct === 6 ? 4 : 2; const raw = Buffer.alloc(h * (1 + w * ch), 0x80); for (let y = 0; y < h; y++) raw[y * (1 + w * ch)] = 0; raw[11] = tag & 0xff; return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }
const wav = (f: string, sec: number, tag = 0) => { const n = Math.round(sec * 8000); const d = Buffer.alloc(n * 2, tag); const b = Buffer.alloc(44 + d.length); b.write('RIFF', 0); b.writeUInt32LE(36 + d.length, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(d.length, 40); d.copy(b, 44); fs.writeFileSync(f, b); };

// Synthetic background/scene media (nothing is read from the repository tree).
const REAL_BG_TAGS = ['#BGD-01-VILLAGE-STREET-WIDE', '#BGD-02-WELL-AREA-WIDE', '#BGD-03-WELL-AREA-CLOSE', '#BGD-04-VILLAGE-ELDERS-HOUSE-INTERIOR', '#BGD-05-VILLAGE-STREET-CLOSE'];

const DUR = 3; // synthetic narration seconds per scene

/**
 * Both fixtures are built from ONE encoded clip bank. T7 asserts that the two isolated
 * projects render byte-identical TITLE output, and two independent ffmpeg encodes of the
 * same parameters differ (the MP4 container carries a creation timestamp), so the clips
 * must be copied, not re-encoded.
 */
let CLIP_BANK: string[] = [];

async function buildFixture(tmp: string, id: string) {
  const projectsRoot = path.join(tmp, 'projects');
  const inputsRoot = path.join(tmp, 'inputs');
  const outputsRoot = path.join(tmp, 'outputs');
  const projectDir = path.join(projectsRoot, id), inputRoot = path.join(inputsRoot, id), outputsDir = path.join(outputsRoot, id);
  for (const d of [projectDir, inputRoot, outputsDir, path.join(inputRoot, 'flow-clips'), path.join(inputRoot, 'backgrounds'), path.join(inputRoot, 'narration'), path.join(inputRoot, 'music'), path.join(outputsDir, 'narration')]) fs.mkdirSync(d, { recursive: true });

  const scenes: any[] = [];
  installFixtureClips(inputRoot, CLIP_BANK);
  for (let n = 1; n <= 14; n++) {
    scenes.push({ scene_number: n, title: `S${n}`, background_tag: REAL_BG_TAGS[(n - 1) % 5], character_tags: [], speaker: 'NARRATOR', camera: 'wide', effects: '', sound_design: '', visual_action: `action ${n}`, narration_text: `नarration ${n}`, animation_prompt_NARRATOR_ONLY: `prompt ${n}`, animation_prompt_WITH_lipsync: `prompt ${n}`, status: 'pending' });
  }
  const pipeline = { project_id: id, style_reference: {}, flow_project_name: `Fixture ${id}`, characters: [], backgrounds: REAL_BG_TAGS.map((tag) => ({ tag, location_name: tag, look_summary: 'x', full_prompt: 'x' })), scenes };
  fs.writeFileSync(path.join(projectDir, 'pipeline.json'), JSON.stringify(pipeline, null, 2));

  writeFixtureBackgrounds(inputRoot);
  for (let n = 1; n <= 14; n++) { const name = `narration-${String(n).padStart(4, '0')}.wav`; wav(path.join(inputRoot, 'narration', name), DUR, n & 0xff); fs.copyFileSync(path.join(inputRoot, 'narration', name), path.join(outputsDir, 'narration', name)); }
  const bgm = path.join(inputRoot, 'music', 'background-music.mp3');
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=10:sample_rate=44100', '-ac', '2', '-b:a', '96k', bgm]);
  fs.writeFileSync(path.join(inputRoot, 'music', 'background-music.license.json'), JSON.stringify({ license: 'CC0' }));
  const intro = path.join(tmp, 'branding-intro.mp4');
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'color=c=0x101020:s=1280x720:d=2', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', intro]);
  const logo = path.join(tmp, 'branding-logo.png'); fs.writeFileSync(logo, makePng(256, 256, 6, 3));
  // Branding is a REQUIRED project input. These files also exist under `tmp` because the stage
  // executor is given them via an explicit titleAssets override, but the CANONICAL input location
  // was never populated — which went unnoticed because missing branding was not propagated into
  // blockers. Copy them into `<inputRoot>/branding/` so the fixture matches what it models.
  fs.mkdirSync(path.join(inputRoot, 'branding'), { recursive: true });
  fs.copyFileSync(intro, path.join(inputRoot, 'branding', 'channel-intro.mp4'));
  fs.copyFileSync(logo, path.join(inputRoot, 'branding', 'channel-logo.png'));
  return { projectsRoot, inputsRoot, outputsRoot, projectDir, inputRoot, outputsDir, pipeline, bgm, intro, logo };
}

/** Workflow options for the isolated fixture. Scene executor copies the local clips. */
function optsFor(f: any, title = 'RAAT KA KHAUF') {
  return {
    projectsRoot: f.projectsRoot, inputsRoot: f.inputsRoot, outputsRoot: f.outputsRoot,
    projectId: f.pipeline.project_id, ffprobePath: process.env.FFPROBE_PATH,
    productionDir: PROD,
    titleAssets: { intro: f.intro, logo: f.logo, title },
    bgmPath: f.bgm,
    stageInputs: { bgmHash: shaOrNull(f.bgm), introHash: shaOrNull(f.intro), logoHash: shaOrNull(f.logo), titleMetadata: { title } },
    sceneExecutor: async (scene: any, outputPath: string) => { const n = String(scene?.sceneNumber ?? scene?.scene_number).padStart(4, '0'); await fs.promises.mkdir(path.dirname(outputPath), { recursive: true }); await fs.promises.copyFile(path.join(f.inputRoot, 'flow-clips', `scene-${n}.mp4`), outputPath); return { ok: true }; },
  };
}
const stageSha = (f: any, name: string) => { const p = path.join(f.outputsDir, `${name}.mp4`); return fs.existsSync(p) ? sha(p) : null; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8gu-'));
CLIP_BANK = await createFixtureClipBank(path.join(tmp, 'clip-bank'), 14);
const A = await buildFixture(tmp, 'gu-a');
const B = await buildFixture(tmp, 'gu-b');

// ================== TEST 1: full workflow execution ==================
const run1 = await WF.resumeProjectWorkflow(optsFor(A) as any);
check('T1 workflow reaches AWAITING_APPROVAL', run1.status === 'COMPLETED_TO_APPROVAL' && run1.phase === 'AWAITING_APPROVAL', JSON.stringify({ s: run1.status, p: run1.phase, blockers: run1.blockers }));
const scenesReady = (run1.production?.orchestration?.scenes ?? []).filter((s: any) => s.readiness === 'READY').length;
check('T1 all 14 scenes READY', scenesReady === 14, String(scenesReady));
const ds1 = run1.production?.orchestration?.downstream;
check('T1 EDIT/MIX/BED/TITLE all CURRENT', ['EDIT', 'MIX', 'BED', 'TITLE'].every((s) => ds1?.states?.[s] === 'CURRENT'), JSON.stringify(ds1?.states));
check('T1 executed stages EDIT,MIX,BED,TITLE', (ds1?.executedStages ?? []).join(',') === 'EDIT,MIX,BED,TITLE', JSON.stringify(ds1?.executedStages));
check('T1 APPROVAL is a human gate (never executed)', !(ds1?.executedStages ?? []).includes('APPROVAL') && ds1?.states?.APPROVAL !== 'CURRENT');
const title1 = stageSha(A, 'final-title');
check('T1 final-title is valid H264/AAC', title1 !== null && (await VC.validateVideoClip(path.join(A.outputsDir, 'final-title.mp4'), { ffprobePath: process.env.FFPROBE_PATH })).state === 'VALID');
for (const st of ['EDIT', 'MIX', 'BED', 'TITLE']) check(`T1 ${st} sidecar recorded with key+hash`, (() => { const p = path.join(A.outputsDir, `final-${st === 'EDIT' ? 'with-fades' : st === 'MIX' ? 'narrated' : st === 'BED' ? 'bedded' : 'title'}.mp4.stage`); if (!fs.existsSync(p)) return false; const j = JSON.parse(fs.readFileSync(p, 'utf8')); return !!j.key && /^[0-9a-f]{64}$/.test(j.output_hash); })());

// ================== TEST 2: idempotency ==================
const clipShas1 = Array.from({ length: 14 }, (_, i) => sha(path.join(A.inputRoot, 'flow-clips', `scene-${String(i + 1).padStart(4, '0')}.mp4`)));
const sceneOut1 = Array.from({ length: 14 }, (_, i) => sha(path.join(A.outputsDir, `scene-${String(i + 1).padStart(4, '0')}.mp4`)));
const stage1 = { EDIT: stageSha(A, 'final-with-fades'), MIX: stageSha(A, 'final-narrated'), BED: stageSha(A, 'final-bedded'), TITLE: title1 };
const run2 = await WF.resumeProjectWorkflow(optsFor(A) as any);
const ds2 = run2.production?.orchestration?.downstream;
check('T2 second run executes zero stages', (ds2?.executedStages ?? []).length === 0, JSON.stringify(ds2?.executedStages));
check('T2 second run stays AWAITING_APPROVAL', run2.status === 'COMPLETED_TO_APPROVAL', run2.status);
check('T2 scene outputs unchanged', Array.from({ length: 14 }, (_, i) => sha(path.join(A.outputsDir, `scene-${String(i + 1).padStart(4, '0')}.mp4`))).every((s, i) => s === sceneOut1[i]));
check('T2 local clips unchanged', Array.from({ length: 14 }, (_, i) => sha(path.join(A.inputRoot, 'flow-clips', `scene-${String(i + 1).padStart(4, '0')}.mp4`))).every((s, i) => s === clipShas1[i]));
check('T2 stage outputs unchanged', stageSha(A, 'final-with-fades') === stage1.EDIT && stageSha(A, 'final-narrated') === stage1.MIX && stageSha(A, 'final-bedded') === stage1.BED && title1 === stage1.TITLE);

// ================== TEST 3: exact invalidation ==================
// narration change → MIX,BED,TITLE
wav(path.join(A.inputRoot, 'narration', 'narration-0001.wav'), DUR, 0x5a);
fs.copyFileSync(path.join(A.inputRoot, 'narration', 'narration-0001.wav'), path.join(A.outputsDir, 'narration', 'narration-0001.wav'));
const runN = await WF.resumeProjectWorkflow(optsFor(A) as any);
check('T3 narration change re-runs MIX,BED,TITLE', (runN.production?.orchestration?.downstream?.executedStages ?? []).join(',') === 'MIX,BED,TITLE', JSON.stringify(runN.production?.orchestration?.downstream?.executedStages));
check('T3 EDIT remains CURRENT on narration change', runN.production?.orchestration?.downstream?.states?.EDIT === 'CURRENT');
// restore narration → recovery/idempotency to the ORIGINAL narration bytes
wav(path.join(A.inputRoot, 'narration', 'narration-0001.wav'), DUR, 1 & 0xff);
fs.copyFileSync(path.join(A.inputRoot, 'narration', 'narration-0001.wav'), path.join(A.outputsDir, 'narration', 'narration-0001.wav'));
const runN2 = await WF.resumeProjectWorkflow(optsFor(A) as any);
check('T3 restore narration → MIX,BED,TITLE re-run back to original', (runN2.production?.orchestration?.downstream?.executedStages ?? []).join(',') === 'MIX,BED,TITLE', JSON.stringify(runN2.production?.orchestration?.downstream?.executedStages));
// BGM change → BED,TITLE
const bgm2 = path.join(tmp, 'bgm2.mp3');
await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=10:sample_rate=44100', '-ac', '2', '-b:a', '96k', bgm2]);
const optsBgm = optsFor(A); optsBgm.bgmPath = bgm2; optsBgm.stageInputs = { ...optsBgm.stageInputs, bgmHash: sha(bgm2) };
const runB = await WF.resumeProjectWorkflow(optsBgm as any);
check('T3 BGM change re-runs BED,TITLE', (runB.production?.orchestration?.downstream?.executedStages ?? []).join(',') === 'BED,TITLE', JSON.stringify(runB.production?.orchestration?.downstream?.executedStages));
check('T3 EDIT+MIX remain CURRENT on BGM change', runB.production?.orchestration?.downstream?.states?.EDIT === 'CURRENT' && runB.production?.orchestration?.downstream?.states?.MIX === 'CURRENT');
// Restore the original BGM and settle BED/TITLE so the branding test isolates branding only.
const runBrestore = await WF.resumeProjectWorkflow(optsFor(A) as any);
check('T3 restore BGM → BED,TITLE re-run back', (runBrestore.production?.orchestration?.downstream?.executedStages ?? []).join(',') === 'BED,TITLE', JSON.stringify(runBrestore.production?.orchestration?.downstream?.executedStages));
// branding/title change → TITLE only
const logo2 = path.join(tmp, 'logo2.png'); fs.writeFileSync(logo2, makePng(256, 256, 6, 9));
const optsTitle = optsFor(A); optsTitle.titleAssets = { intro: A.intro, logo: logo2, title: 'RAAT KA KHAUF' }; optsTitle.stageInputs = { ...optsTitle.stageInputs, logoHash: sha(logo2) };
const runT = await WF.resumeProjectWorkflow(optsTitle as any);
check('T3 branding change re-runs TITLE only', (runT.production?.orchestration?.downstream?.executedStages ?? []).join(',') === 'TITLE', JSON.stringify(runT.production?.orchestration?.downstream?.executedStages));
check('T3 EDIT+MIX+BED remain CURRENT on branding change', ['EDIT', 'MIX', 'BED'].every((s) => runT.production?.orchestration?.downstream?.states?.[s] === 'CURRENT'));
// Restore branding to the original logo and settle TITLE.
const runTrestore = await WF.resumeProjectWorkflow(optsFor(A) as any);
check('T3 restore branding → TITLE re-runs back', (runTrestore.production?.orchestration?.downstream?.executedStages ?? []).join(',') === 'TITLE', JSON.stringify(runTrestore.production?.orchestration?.downstream?.executedStages));

// ================== TEST 4: output corruption recovery ==================
fs.writeFileSync(path.join(A.outputsDir, 'final-title.mp4'), Buffer.from('CORRUPT'));
const runC = await WF.resumeProjectWorkflow(optsFor(A) as any);
check('T4 corrupt TITLE → TITLE reruns (integrity, not key-only)', (runC.production?.orchestration?.downstream?.executedStages ?? []).join(',') === 'TITLE', JSON.stringify(runC.production?.orchestration?.downstream?.executedStages));
const repairedTitleValid = (await VC.validateVideoClip(path.join(A.outputsDir, 'final-title.mp4'), { ffprobePath: process.env.FFPROBE_PATH })).state === 'VALID';
check('T4 repaired TITLE is valid media (not the corrupt bytes)', repairedTitleValid && fs.readFileSync(path.join(A.outputsDir, 'final-title.mp4')).toString('utf8', 0, 7) !== 'CORRUPT');
check('T4 upstream EDIT/MIX/BED remain CURRENT', ['EDIT', 'MIX', 'BED'].every((s) => runC.production?.orchestration?.downstream?.states?.[s] === 'CURRENT'));
// corrupt BED → BED+TITLE rerun
fs.writeFileSync(path.join(A.outputsDir, 'final-bedded.mp4'), Buffer.from('CORRUPT'));
const runCB = await WF.resumeProjectWorkflow(optsFor(A) as any);
check('T4 corrupt BED → BED,TITLE rerun', (runCB.production?.orchestration?.downstream?.executedStages ?? []).join(',') === 'BED,TITLE', JSON.stringify(runCB.production?.orchestration?.downstream?.executedStages));
check('T4 EDIT+MIX remain CURRENT on BED corruption', ['EDIT', 'MIX'].every((s) => runCB.production?.orchestration?.downstream?.states?.[s] === 'CURRENT'));

// ================== TEST 6: approval gate ==================
check('T6 final state is AWAITING_APPROVAL and never auto-approved', runCB.status === 'COMPLETED_TO_APPROVAL' && runCB.production?.orchestration?.downstream?.states?.APPROVAL !== 'CURRENT');

// ================== TEST 5: failure + recovery ==================
{
  const C = await buildFixture(tmp, 'gu-c');
  // Force BED to fail: point the BED producer at a garbage (non-audio) BGM file while the
  // project readiness (inputs/music) stays valid. The failing stage must NOT be marked CURRENT.
  const badBgm = path.join(tmp, 'bad-bgm.mp3');
  fs.writeFileSync(badBgm, Buffer.from('NOT_AN_AUDIO_FILE'));
  const optsBad = optsFor(C); optsBad.bgmPath = badBgm; optsBad.stageInputs = { ...optsBad.stageInputs, bgmHash: sha(badBgm) };
  const runF = await WF.resumeProjectWorkflow(optsBad as any);
  const failed = runF.production?.orchestration?.downstream?.failedStages ?? [];
  check('T5 a downstream stage failure is observable + not false CURRENT', failed.includes('BED') && runF.status !== 'COMPLETED_TO_APPROVAL', JSON.stringify({ status: runF.status, failed }));
  check('T5 upstream valid stages (EDIT,MIX) are reused after failure', runF.production?.orchestration?.downstream?.states?.EDIT === 'CURRENT' && runF.production?.orchestration?.downstream?.states?.MIX === 'CURRENT', JSON.stringify(runF.production?.orchestration?.downstream?.states));
  check('T5 BED is not falsely CURRENT after failure', runF.production?.orchestration?.downstream?.states?.BED !== 'CURRENT');
  // Fix the BGM and resume → completes.
  const runR = await WF.resumeProjectWorkflow(optsFor(C) as any);
  check('T5 recovery after fixing input completes to AWAITING_APPROVAL', runR.status === 'COMPLETED_TO_APPROVAL' && (runR.production?.orchestration?.downstream?.executedStages ?? []).join(',') === 'BED,TITLE', JSON.stringify({ s: runR.status, exec: runR.production?.orchestration?.downstream?.executedStages }));
}

// ================== TEST 7: project isolation ==================
{
  const runBonly = await WF.resumeProjectWorkflow(optsFor(B) as any);
  check('T7 both isolated projects complete independently', runBonly.status === 'COMPLETED_TO_APPROVAL');
  check('T7 state.json is per-project (different content/path)', path.join(A.outputsDir, 'state.json') !== path.join(B.outputsDir, 'state.json') && fs.existsSync(path.join(A.outputsDir, 'state.json')) && fs.existsSync(path.join(B.outputsDir, 'state.json')));
  check('T7 stage outputs live in separate project dirs', path.join(A.outputsDir, 'final-title.mp4') !== path.join(B.outputsDir, 'final-title.mp4') && fs.existsSync(path.join(A.outputsDir, 'final-title.mp4')) && fs.existsSync(path.join(B.outputsDir, 'final-title.mp4')));
  check('T7 scene checkpoints are separate files', path.join(A.outputsDir, 'scene-0001.json') !== path.join(B.outputsDir, 'scene-0001.json') && fs.existsSync(path.join(A.outputsDir, 'scene-0001.json')) && fs.existsSync(path.join(B.outputsDir, 'scene-0001.json')));
  check('T7 stage sidecars record the correct project-scoped keys', (() => { const a = JSON.parse(fs.readFileSync(path.join(A.outputsDir, 'final-title.mp4.stage'), 'utf8')); const b = JSON.parse(fs.readFileSync(path.join(B.outputsDir, 'final-title.mp4.stage'), 'utf8')); return !!a.key && !!b.key && a.output_hash === b.output_hash; })());
  check('T7 run logs are project-local', fs.existsSync(path.join(A.outputsDir, 'run.log.jsonl')) && fs.existsSync(path.join(B.outputsDir, 'run.log.jsonl')));
  check('T7 project dirs are distinct and no flow lock residue', A.outputsDir !== B.outputsDir && !fs.existsSync(path.join(A.outputsDir, '.flow-session.lock')) && !fs.existsSync(path.join(B.outputsDir, '.flow-session.lock')) && !fs.existsSync(path.join(A.outputsRoot, '.flow-session.lock')));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n8GU COMPLETE PROJECT WORKFLOW E2E TESTS PASSED (${passed} checks)`);
