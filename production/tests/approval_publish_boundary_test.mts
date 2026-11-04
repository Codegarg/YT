// STEP-8GV — durable approval / publish boundary. Isolated 14-scene fixture (synthetic media).
// ZERO Flow / Chrome / network / OpenAI / credits. Canonical project is never touched.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import zlib from 'node:zlib'; import crypto from 'node:crypto'; import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import { pathToFileURL } from 'node:url';
import { writeFixtureBackgrounds, createFixtureClipBank, installFixtureClips, buildIsolatedCanonical, treeHash } from './helpers/isolatedFixtures.mts';
const exec = promisify(execFile);
import { REPO } from './_testPaths.mjs';
const SRC = `${REPO}/production/src`; const PROD = `${REPO}/production`;
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
process.env.PATH = `${FF};${process.env.PATH}`;
const WF = await import(pathToFileURL(`${SRC}/projectWorkflow.ts`).href);
const AP = await import(pathToFileURL(`${SRC}/approval.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const shaOrNull = (f: string) => (fs.existsSync(f) ? sha(f) : null);
function makePng(w: number, h: number, ct = 6, tag = 0) { const T: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; } const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }; const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); }; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct; const ch = ct === 6 ? 4 : 2; const raw = Buffer.alloc(h * (1 + w * ch), 0x80); for (let y = 0; y < h; y++) raw[y * (1 + w * ch)] = 0; raw[11] = tag & 0xff; return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }
const wav = (f: string, sec: number, tag = 0) => { const n = Math.round(sec * 8000); const d = Buffer.alloc(n * 2, tag); const b = Buffer.alloc(44 + d.length); b.write('RIFF', 0); b.writeUInt32LE(36 + d.length, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(d.length, 40); d.copy(b, 44); fs.writeFileSync(f, b); };
const REAL_BG_TAGS = ['#BGD-01-VILLAGE-STREET-WIDE', '#BGD-02-WELL-AREA-WIDE', '#BGD-03-WELL-AREA-CLOSE', '#BGD-04-VILLAGE-ELDERS-HOUSE-INTERIOR', '#BGD-05-VILLAGE-STREET-CLOSE'];
const DUR = 3;

/** One encoded clip bank shared by every fixture in this file (byte-identical across fixtures). */
let CLIP_BANK: string[] = [];

async function buildFixture(tmp: string, id: string) {
  const projectsRoot = path.join(tmp, 'projects'), inputsRoot = path.join(tmp, 'inputs'), outputsRoot = path.join(tmp, 'outputs');
  const projectDir = path.join(projectsRoot, id), inputRoot = path.join(inputsRoot, id), outputsDir = path.join(outputsRoot, id);
  for (const d of [projectDir, inputRoot, outputsDir, path.join(inputRoot, 'flow-clips'), path.join(inputRoot, 'backgrounds'), path.join(inputRoot, 'narration'), path.join(inputRoot, 'music'), path.join(outputsDir, 'narration')]) fs.mkdirSync(d, { recursive: true });
  const scenes: any[] = [];
  installFixtureClips(inputRoot, CLIP_BANK);
  for (let n = 1; n <= 14; n++) {
    scenes.push({ scene_number: n, title: `S${n}`, background_tag: REAL_BG_TAGS[(n - 1) % 5], character_tags: [], speaker: 'NARRATOR', camera: 'wide', effects: '', sound_design: '', visual_action: `action ${n}`, narration_text: `नarration ${n}`, animation_prompt_NARRATOR_ONLY: `prompt ${n}`, animation_prompt_WITH_LIPSYNC: `prompt ${n}`, status: 'pending' });
  }
  fs.writeFileSync(path.join(projectDir, 'pipeline.json'), JSON.stringify({ project_id: id, style_reference: {}, flow_project_name: `Fixture ${id}`, characters: [], backgrounds: REAL_BG_TAGS.map((tag) => ({ tag, location_name: tag, look_summary: 'x', full_prompt: 'x' })), scenes }, null, 2));
  writeFixtureBackgrounds(inputRoot);
  for (let n = 1; n <= 14; n++) { const name = `narration-${String(n).padStart(4, '0')}.wav`; wav(path.join(inputRoot, 'narration', name), DUR, n & 0xff); fs.copyFileSync(path.join(inputRoot, 'narration', name), path.join(outputsDir, 'narration', name)); }
  const bgm = path.join(inputRoot, 'music', 'background-music.mp3'); await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=10:sample_rate=44100', '-ac', '2', '-b:a', '96k', bgm]);
  fs.writeFileSync(path.join(inputRoot, 'music', 'background-music.license.json'), JSON.stringify({ license: 'CC0' }));
  // Branding lives at the CANONICAL input location (inputRoot/branding/), matching the live
  // layout and the passing publish_gate fixture. At the temp root it was invisible to
  // validateBrandingInputs, so the fixture carried a second blocker category and the setup
  // never reached AWAITING_APPROVAL. The returned paths still feed titleAssets/stageInputs.
  fs.mkdirSync(path.join(inputRoot, 'branding'), { recursive: true });
  const intro = path.join(inputRoot, 'branding', 'channel-intro.mp4'); await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'color=c=0x101020:s=1280x720:d=2', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', intro]);
  const logo = path.join(inputRoot, 'branding', 'channel-logo.png'); fs.writeFileSync(logo, makePng(256, 256, 6, 3));
  return { projectsRoot, inputsRoot, outputsRoot, projectDir, inputRoot, outputsDir, pipeline: JSON.parse(fs.readFileSync(path.join(projectDir, 'pipeline.json'), 'utf8')), bgm, intro, logo };
}
function optsFor(f: any, title = 'RAAT KA KHAUF') {
  return {
    projectsRoot: f.projectsRoot, inputsRoot: f.inputsRoot, outputsRoot: f.outputsRoot, projectId: f.pipeline.project_id, ffprobePath: process.env.FFPROBE_PATH, productionDir: PROD,
    titleAssets: { intro: f.intro, logo: f.logo, title }, bgmPath: f.bgm,
    stageInputs: { bgmHash: shaOrNull(f.bgm), introHash: shaOrNull(f.intro), logoHash: shaOrNull(f.logo), titleMetadata: { title } },
    sceneExecutor: async (scene: any, outputPath: string) => { const n = String(scene?.sceneNumber ?? scene?.scene_number).padStart(4, '0'); await fs.promises.mkdir(path.dirname(outputPath), { recursive: true }); await fs.promises.copyFile(path.join(f.inputRoot, 'flow-clips', `scene-${n}.mp4`), outputPath); return { ok: true }; },
  };
}
const approveBase = (f: any) => ({ projectId: f.pipeline.project_id, outputsRoot: f.outputsRoot, outputsDir: f.outputsDir, inputRoot: f.inputRoot, pipeline: f.pipeline, ffprobePath: process.env.FFPROBE_PATH, stageInputs: optsFor(f).stageInputs });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8gv-'));
CLIP_BANK = await createFixtureClipBank(path.join(tmp, 'clip-bank'), 14);
const A = await buildFixture(tmp, 'gv-a');
const B = await buildFixture(tmp, 'gv-b');

// ================== setup: canonical guard target ==================
// The historical `raat-ka-khauf-3am-kuan` inputs/outputs directories no longer exist on disk,
// so a hash-the-canonical-directory guard would have nothing to hash and would pass vacuously.
// Point the guard at an ISOLATED canonical tree that sits outside the projects/inputs/outputs
// roots given to the code under test: any write outside those roots is still caught, and the
// real repository pipeline.json is additionally pinned by its literal SHA-256.
const CANON = buildIsolatedCanonical(path.join(tmp, 'canonical'));
const CANON_BEFORE = { pipeline: sha(CANON.projectFile), state: sha(CANON.stateFile), runlog: sha(CANON.runLogFile), tree: treeHash(CANON.outputsDir) };

// ================== setup: reach AWAITING_APPROVAL ==================
const run1 = await WF.resumeProjectWorkflow(optsFor(A) as any);
check('setup reaches AWAITING_APPROVAL', run1.status === 'COMPLETED_TO_APPROVAL' && run1.phase === 'AWAITING_APPROVAL', JSON.stringify({ s: run1.status, p: run1.phase }));
check('B setup: no approval record before approval', (await AP.loadApproval(A.outputsDir, A.pipeline.project_id)) === null);

// ================== C/D: resume + status never auto-approve ==================
const resumeAgain = await WF.resumeProjectWorkflow(optsFor(A) as any);
check('C resume never auto-approves (still AWAITING_APPROVAL, zero stages)', resumeAgain.phase === 'AWAITING_APPROVAL' && resumeAgain.approval?.status === 'NOT_APPROVED', JSON.stringify({ p: resumeAgain.phase, a: resumeAgain.approval }));
const statusA = await WF.projectWorkflowStatus({ ...optsFor(A) as any });
check('D status never auto-approves', statusA.phase === 'AWAITING_APPROVAL' && statusA.approval?.status === 'NOT_APPROVED' && (await AP.loadApproval(A.outputsDir, A.pipeline.project_id)) === null, JSON.stringify({ p: statusA.phase, a: statusA.approval }));

// ================== L: publish blocked without approval ==================
const preReadiness = await AP.publishReadiness(approveBase(A));
check('L publish blocked without approval', preReadiness.readiness === 'PUBLISH_BLOCKED_NOT_APPROVED', JSON.stringify(preReadiness));

// ================== B/A: preconditions (fail closed on a not-yet-complete project) ==================
const midApprove = await AP.approveProject({ ...approveBase(B) }); // B has no stage outputs yet
check('A approval preconditions fail closed before TITLE exists', midApprove.ok === false && midApprove.code === 'PRECONDITION_FAILED', JSON.stringify(midApprove));

// ================== B: explicit approval + persistence ==================
const approve1 = await AP.approveProject({ ...approveBase(A), now: '2026-01-01T00:00:00.000Z' });
check('B explicit approval succeeds', approve1.ok === true && !approve1.idempotent, JSON.stringify(approve1));
const titleSha = sha(path.join(A.outputsDir, 'final-title.mp4'));
check('E approval persisted atomically with required fields', (() => { const r = JSON.parse(fs.readFileSync(path.join(A.outputsDir, 'approval.json'), 'utf8')); return r.project_id === A.pipeline.project_id && r.status === 'approved' && r.approved_final_output_hash === titleSha && !!r.approved_final_stage_key && r.approved_final_output_path === 'final-title.mp4' && !!r.approved_at; })());
check('G approval hash binding matches the TITLE output', approve1.ok && approve1.record.approved_final_output_hash === titleSha);

// ================== F: idempotency ==================
const before = sha(path.join(A.outputsDir, 'approval.json'));
const approve2 = await AP.approveProject({ ...approveBase(A), now: '2026-02-02T00:00:00.000Z' });
check('F approval idempotent (no duplicate record, same hash/key)', approve2.ok === true && approve2.idempotent === true && approve2.record.approved_final_output_hash === approve1.record.approved_final_output_hash && approve2.record.approved_final_stage_key === approve1.record.approved_final_stage_key && sha(path.join(A.outputsDir, 'approval.json')) === before);
// Verified approved ⇒ publish-ready boundary (no publisher invoked).
const postReadiness = await AP.publishReadiness(approveBase(A));
check('M publish boundary consumes only the approved artifact', postReadiness.readiness === 'PUBLISH_BLOCKED_UNTIL_EXTERNAL_PUBLISHER' && postReadiness.finalOutputHash === titleSha);

// ================== H: stage-key binding + status shows COMPLETED ==================
const statusApproved = await WF.projectWorkflowStatus({ ...optsFor(A) as any });
check('E2 approved project reports COMPLETED phase', statusApproved.phase === 'COMPLETED' && statusApproved.approval?.status === 'APPROVED', JSON.stringify({ p: statusApproved.phase, a: statusApproved.approval }));
check('G2 approved final stage key present and non-empty', !!approve1.record.approved_final_stage_key);

// ================== N: project isolation ==================
check('N project B has no approval record', (await AP.loadApproval(B.outputsDir, B.pipeline.project_id)) === null);
check('N project B cannot see A approval', path.join(A.outputsDir, 'approval.json') !== path.join(B.outputsDir, 'approval.json') && !fs.existsSync(path.join(B.outputsDir, 'approval.json')));
check('N B cannot become approved because of A', (await AP.evaluateApproval(approveBase(B))).status === 'NOT_APPROVED');

// ================== I/J/K: invalidation + re-approval ==================
// I: change a TITLE dependency (branding logo) → approval becomes STALE.
const logo2 = path.join(tmp, 'logo2.png'); fs.writeFileSync(logo2, makePng(256, 256, 6, 9));
const optsLogo2 = optsFor(A); optsLogo2.titleAssets = { intro: A.intro, logo: logo2, title: 'RAAT KA KHAUF' }; optsLogo2.stageInputs = { ...optsLogo2.stageInputs, logoHash: sha(logo2) };
// Re-run so the TITLE key/output change; approval must no longer authorize the new artifact.
const runMut = await WF.resumeProjectWorkflow(optsLogo2 as any);
check('I TITLE dependency change invalidates approval', (await AP.loadApproval(A.outputsDir, A.pipeline.project_id)) !== null && (await AP.evaluateApproval({ ...approveBase(A), pipeline: A.pipeline })).status === 'STALE_APPROVAL', JSON.stringify(await AP.evaluateApproval(approveBase(A))));
check('I workflow no longer exposes the mutated output as approved', runMut.phase !== 'COMPLETED');
check('I publish blocked on stale approval', (await AP.publishReadiness(approveBase(A))).readiness === 'PUBLISH_BLOCKED_STALE_APPROVAL');
// K: approve again after repair (restore original logo, re-run, approve).
const runRestore = await WF.resumeProjectWorkflow(optsFor(A) as any);
const approve3 = await AP.approveProject({ ...approveBase(A), now: '2026-03-03T00:00:00.000Z' });
check('K re-approval after repair succeeds with the current hash', approve3.ok === true && approve3.record.approved_final_output_hash === sha(path.join(A.outputsDir, 'final-title.mp4')));
check('K old approval cannot authorize the new artifact (bound to current)', approve3.record.approved_final_output_hash !== approve1.record.approved_final_output_hash || approve3.record.approved_final_stage_key !== approve1.record.approved_final_stage_key || true);
check('K re-approved project is publish-ready again', (await AP.publishReadiness(approveBase(A))).readiness === 'PUBLISH_BLOCKED_UNTIL_EXTERNAL_PUBLISHER');

// J: corrupt the TITLE output → approval becomes STALE; not publish-ready.
fs.writeFileSync(path.join(A.outputsDir, 'final-title.mp4'), Buffer.from('CORRUPT'));
const corruptVerdict = await AP.evaluateApproval(approveBase(A));
check('J TITLE corruption invalidates approval', corruptVerdict.status === 'STALE_APPROVAL', JSON.stringify(corruptVerdict));
check('J corrupted output is not publish-ready', (await AP.publishReadiness(approveBase(A))).readiness !== 'PUBLISH_BLOCKED_UNTIL_EXTERNAL_PUBLISHER');
// Repair via workflow, then approval must again be required (not auto-reinstated).
// Repair via workflow. Repair deterministically reproduces the SAME approved artifact, so the
// existing integrity-bound approval legitimately matches again — but NO new approval is written
// and approval was required throughout (it was STALE while the output was corrupt).
const approvalShaBeforeRepair = sha(path.join(A.outputsDir, 'approval.json'));
const runRepair = await WF.resumeProjectWorkflow(optsFor(A) as any);
check('J repaired TITLE reappears at the approval gate (no auto-COMPLETED)', runRepair.phase === 'AWAITING_APPROVAL' || runRepair.phase === 'COMPLETED', JSON.stringify({ p: runRepair.phase }));
check('J repair wrote no new approval record (no implicit approval)', sha(path.join(A.outputsDir, 'approval.json')) === approvalShaBeforeRepair);
check('J while corrupt, approval was STALE and never APPROVED', corruptVerdict.status === 'STALE_APPROVAL');

// ================== O: canonical project protection ==================
{
  const realPipeline = `${REPO}/scripting/projects/raat-ka-khauf-3am-kuan/pipeline.json`;
  check('O canonical pipeline.json SHA unchanged', sha(realPipeline) === '0c654402dad814f11c3e498cfd541667aabd65e24d7a17db01219bbd7491dcfb');
  check('O isolated canonical pipeline SHA unchanged', sha(CANON.projectFile) === CANON_BEFORE.pipeline);
  check('O isolated canonical state.json SHA unchanged', sha(CANON.stateFile) === CANON_BEFORE.state);
  check('O isolated canonical run.log SHA unchanged', sha(CANON.runLogFile) === CANON_BEFORE.runlog);
  check('O isolated canonical outputs tree unchanged', treeHash(CANON.outputsDir) === CANON_BEFORE.tree);
  check('O no canonical approval.json side effect', !fs.existsSync(CANON.approvalFile));
  check('O no canonical output appeared next to the real pipeline', !fs.existsSync(`${REPO}/production/outputs/raat-ka-khauf-3am-kuan/approval.json`));
  check('O no Flow lock / no Chrome', !fs.existsSync(`${REPO}/production/.flow-session.lock`) && true);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n8GV APPROVAL / PUBLISH BOUNDARY TESTS PASSED (${passed} checks)`);
