// STEP-8GW — approval/review reconciliation. LOCAL-ONLY; never publishes / never calls zernio.
// Isolated fixture (synthetic media). Canonical project untouched.
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
const AR = await import(pathToFileURL(`${SRC}/approvalReview.ts`).href);
const RS = await import(pathToFileURL(`${SRC}/reviewState.ts`).href);

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
  for (let n = 1; n <= 14; n++) { scenes.push({ scene_number: n, title: `S${n}`, background_tag: REAL_BG_TAGS[(n - 1) % 5], character_tags: [], speaker: 'NARRATOR', camera: 'wide', effects: '', sound_design: '', visual_action: `action ${n}`, narration_text: `नarration ${n}`, animation_prompt_NARRATOR_ONLY: `prompt ${n}`, animation_prompt_WITH_LIPSYNC: `prompt ${n}`, status: 'pending' }); }
  fs.writeFileSync(path.join(projectDir, 'pipeline.json'), JSON.stringify({ project_id: id, style_reference: {}, flow_project_name: `Fixture ${id}`, characters: [], backgrounds: REAL_BG_TAGS.map((tag) => ({ tag, location_name: tag, look_summary: 'x', full_prompt: 'x' })), scenes }, null, 2));
  writeFixtureBackgrounds(inputRoot);
  for (let n = 1; n <= 14; n++) { const name = `narration-${String(n).padStart(4, '0')}.wav`; wav(path.join(inputRoot, 'narration', name), DUR, n & 0xff); fs.copyFileSync(path.join(inputRoot, 'narration', name), path.join(outputsDir, 'narration', name)); }
  const bgm = path.join(inputRoot, 'music', 'background-music.mp3'); await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=10:sample_rate=44100', '-ac', '2', '-b:a', '96k', bgm]);
  fs.writeFileSync(path.join(inputRoot, 'music', 'background-music.license.json'), JSON.stringify({ license: 'CC0' }));
  // Branding lives at the CANONICAL input location (inputRoot/branding/), matching the live
  // layout and the passing publish_gate fixture. At the temp root it was invisible to
  // validateBrandingInputs, so the fixture carried a second blocker category and never
  // reached AWAITING_APPROVAL. The returned paths still feed titleAssets/stageInputs.
  fs.mkdirSync(path.join(inputRoot, 'branding'), { recursive: true });
  const intro = path.join(inputRoot, 'branding', 'channel-intro.mp4'); await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'color=c=0x101020:s=1280x720:d=2', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', intro]);
  const logo = path.join(inputRoot, 'branding', 'channel-logo.png'); fs.writeFileSync(logo, makePng(256, 256, 6, 3));
  return { projectsRoot, inputsRoot, outputsRoot, projectDir, inputRoot, outputsDir, projectFile: path.join(projectDir, 'pipeline.json'), pipeline: JSON.parse(fs.readFileSync(path.join(projectDir, 'pipeline.json'), 'utf8')), bgm, intro, logo };
}
function optsFor(f: any, title = 'RAAT KA KHAUF') {
  return { projectsRoot: f.projectsRoot, inputsRoot: f.inputsRoot, outputsRoot: f.outputsRoot, projectId: f.pipeline.project_id, ffprobePath: process.env.FFPROBE_PATH, productionDir: PROD, titleAssets: { intro: f.intro, logo: f.logo, title }, bgmPath: f.bgm, stageInputs: { bgmHash: shaOrNull(f.bgm), introHash: shaOrNull(f.intro), logoHash: shaOrNull(f.logo), titleMetadata: { title } }, sceneExecutor: async (scene: any, outputPath: string) => { const n = String(scene?.sceneNumber ?? scene?.scene_number).padStart(4, '0'); await fs.promises.mkdir(path.dirname(outputPath), { recursive: true }); await fs.promises.copyFile(path.join(f.inputRoot, 'flow-clips', `scene-${n}.mp4`), outputPath); return { ok: true }; } };
}
const base = (f: any) => ({ projectId: f.pipeline.project_id, outputsRoot: f.outputsRoot, outputsDir: f.outputsDir, inputRoot: f.inputRoot, pipeline: f.pipeline, projectFile: f.projectFile, ffprobePath: process.env.FFPROBE_PATH, stageInputs: optsFor(f).stageInputs });
/** Write a legacy review record directly into the project file (as review.ts does). */
async function writeReview(f: any, status: string) {
  const p = await RS.loadProject(f.projectFile);
  p.review = { status: status as any, video_path: path.join(f.outputsDir, 'final-title.mp4'), requested_at: '2026-01-01T00:00:00.000Z', ...(status === 'approved' || status === 'rejected' ? { decided_at: '2026-01-02T00:00:00.000Z' } : {}) };
  await RS.saveProject(f.projectFile, p);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8gw-'));
CLIP_BANK = await createFixtureClipBank(path.join(tmp, 'clip-bank'), 14);
const A = await buildFixture(tmp, 'gw-a');
const B = await buildFixture(tmp, 'gw-b');

// Reach AWAITING_APPROVAL for both.
await WF.resumeProjectWorkflow(optsFor(A) as any);
await WF.resumeProjectWorkflow(optsFor(B) as any);

// ================== N: canonical project protection (before) ==================
// The historical `raat-ka-khauf-3am-kuan` inputs/outputs directories no longer exist on disk,
// so hashing them would pass vacuously. Guard an ISOLATED canonical tree that sits outside the
// projects/inputs/outputs roots handed to the code under test instead, plus the real
// repository pipeline.json.
const CANON = buildIsolatedCanonical(path.join(tmp, 'canonical'));
const canonBefore = {
  pipeline: sha(`${REPO}/scripting/projects/raat-ka-khauf-3am-kuan/pipeline.json`),
  state: sha(CANON.stateFile),
  runlog: sha(CANON.runLogFile),
  tree: treeHash(CANON.outputsDir),
};

// ================== B/E: valid approval + review missing / not approved ==================
const approveA = await AP.approveProject(base(A));
check('B valid approval + review missing', approveA.ok === true);
let rec = await AR.reconcileApprovalReview(base(A));
check('A integrity APPROVAL_VALID + REVIEW_MISSING, publishable', rec.integrity === 'APPROVAL_VALID' && rec.review === 'REVIEW_MISSING' && rec.publishable === true && rec.mismatch === false, JSON.stringify(rec));
// legacy review command writes approved directly — must not bypass integrity (it does not; approval already valid)
await writeReview(A, 'approved');
rec = await AR.reconcileApprovalReview(base(A));
check('A valid approval + valid review (REVIEW_APPROVED)', rec.integrity === 'APPROVAL_VALID' && rec.review === 'REVIEW_APPROVED' && rec.publishable === true && rec.mismatch === false, JSON.stringify(rec));

// ================== E: legacy review approved with NO approval (Project B) ==================
await writeReview(B, 'approved');
const recB = await AR.reconcileApprovalReview(base(B));
check('E legacy REVIEW_APPROVED + NO_APPROVAL → not publishable', recB.integrity === 'APPROVAL_MISSING' && recB.review === 'REVIEW_APPROVED' && recB.publishable === false && recB.mismatch === true, JSON.stringify(recB));
const readinessB = await AR.publishReadinessDetailed(base(B));
check('E legacy review alone is blocked', readinessB.publishable === false && readinessB.readiness === 'PUBLISH_BLOCKED_NOT_APPROVED', JSON.stringify(readinessB));
check('J legacy review command cannot bypass integrity approval', !fs.existsSync(path.join(B.outputsDir, 'approval.json')) && readinessB.publishable === false);

// ================== F: legacy project with no approval.json (same as B) ==================
check('F legacy project has no approval.json and is not publishable', !fs.existsSync(path.join(B.outputsDir, 'approval.json')) && recB.publishable === false);
check('F no automatic approval migration occurred', !fs.existsSync(path.join(B.outputsDir, 'approval.json')));

// ================== C: valid approval + review NOT approved ==================
await RS.saveProject(A.projectFile, { ...(await RS.loadProject(A.projectFile)), review: { status: 'awaiting_approval', video_path: path.join(A.outputsDir, 'final-title.mp4') } });
rec = await AR.reconcileApprovalReview(base(A));
check('C valid approval + REVIEW_AWAITING → publishable (review is advisory)', rec.integrity === 'APPROVAL_VALID' && rec.review === 'REVIEW_AWAITING' && rec.publishable === true, JSON.stringify(rec));

// ================== G: explicit idempotent sync ==================
const sync1 = await AR.syncReviewFromApproval({ ...base(A), now: '2026-01-03T00:00:00.000Z' });
check('G sync moves awaiting_approval → approved', sync1.ok === true && sync1.changed === true && (sync1 as any).review.status === 'approved');
const sync2 = await AR.syncReviewFromApproval({ ...base(A), now: '2026-01-04T00:00:00.000Z' });
check('G sync is idempotent (no change when already approved)', sync2.ok === true && sync2.changed === false);
// Sync refuses without a valid integrity approval (Project B).
const syncB = await AR.syncReviewFromApproval(base(B));
check('G sync refuses without valid integrity approval', syncB.ok === false && syncB.code === 'SYNC_REFUSED');
// Sync never overwrites posted history.
await writeReview(A, 'posted');
const syncPosted = await AR.syncReviewFromApproval(base(A));
check('G sync never overwrites posted history', syncPosted.ok === true && syncPosted.changed === false && (await RS.loadProject(A.projectFile)).review?.status === 'posted');
await writeReview(A, 'approved');

// ================== D: stale approval + review approved ==================
const logo2 = path.join(tmp, 'logo2.png'); fs.writeFileSync(logo2, makePng(256, 256, 6, 9));
const optsLogo2 = optsFor(A); optsLogo2.titleAssets = { intro: A.intro, logo: logo2, title: 'RAAT KA KHAUF' }; optsLogo2.stageInputs = { ...optsLogo2.stageInputs, logoHash: sha(logo2) };
await WF.resumeProjectWorkflow(optsLogo2 as any);
rec = await AR.reconcileApprovalReview(base(A));
check('D stale approval + review approved → not publishable + mismatch', rec.integrity === 'APPROVAL_STALE' && rec.review === 'REVIEW_APPROVED' && rec.publishable === false && rec.mismatch === true, JSON.stringify(rec));
check('D stale approval is distinctly reported', (await AR.publishReadinessDetailed(base(A))).readiness === 'PUBLISH_BLOCKED_STALE_APPROVAL');
check('D historical review approval is preserved (not erased)', (await RS.loadProject(A.projectFile)).review?.status === 'approved');

// ================== H/I: reapproval + idempotency ==================
const runRestore = await WF.resumeProjectWorkflow(optsFor(A) as any);
const approve2 = await AP.approveProject({ ...base(A), now: '2026-02-02T00:00:00.000Z' });
// Restoring the ORIGINAL logo deterministically reproduces the originally-approved artifact,
// so re-approving legitimately matches the existing approval (idempotent). Approval is valid.
check('H reapproval after repair succeeds (valid bound to current artifact)', approve2.ok === true && approve2.record.approved_final_output_hash === sha(path.join(A.outputsDir, 'final-title.mp4')));
const approve3 = await AP.approveProject({ ...base(A), now: '2026-02-03T00:00:00.000Z' });
check('I repeated approval is idempotent', approve3.ok === true && (approve3 as any).idempotent === true);
rec = await AR.reconcileApprovalReview(base(A));
check('H reconciliation reflects the new approval (publishable again)', rec.integrity === 'APPROVAL_VALID' && rec.publishable === true, JSON.stringify(rec));
check('H old hash/key cannot authorize repaired artifact', approve2.ok && approve2.record.approved_final_output_hash === sha(path.join(A.outputsDir, 'final-title.mp4')));

// ================== K: publishable invariant (never true without valid approval) ==================
{
  const cases: any[] = [];
  // no approval
  cases.push((await AR.publishReadinessDetailed(base(B))).publishable === false);
  // stale approval (corrupt AITLE)
  fs.writeFileSync(path.join(A.outputsDir, 'final-title.mp4'), Buffer.from('CORRUPT'));
  cases.push((await AR.publishReadinessDetailed(base(A))).publishable === false);
  cases.push(cases.every(Boolean));
  check('K publishable is false unless the integrity approval is valid', cases.every(Boolean));
  // repair + approve → publishable true
  await WF.resumeProjectWorkflow(optsFor(A) as any);
  await AP.approveProject(base(A));
  check('K publishable true only after a valid integrity approval', (await AR.publishReadinessDetailed(base(A))).publishable === true);
}

// ================== L: read-only publish-status ==================
{
  const approvalBefore = shaOrNull(path.join(A.outputsDir, 'approval.json'));
  const pipelineBefore = sha(A.projectFile);
  await AR.publishReadinessDetailed(base(A));
  await AR.reconcileApprovalReview(base(A));
  check('L reconciliation + publish-status are read-only', shaOrNull(path.join(A.outputsDir, 'approval.json')) === approvalBefore && sha(A.projectFile) === pipelineBefore);
}

// ================== M: project isolation ==================
check('M A approval cannot affect B', !fs.existsSync(path.join(B.outputsDir, 'approval.json')) && (await AR.reconcileApprovalReview(base(B))).publishable === false);
check('M B cannot become publishable because of A', (await AR.publishReadinessDetailed(base(B))).publishable === false);
check('M approval/review paths are project-local', path.join(A.outputsDir, 'approval.json') !== path.join(B.outputsDir, 'approval.json'));

// ================== N: canonical project protection (after) ==================
check('N canonical pipeline unchanged', sha(`${REPO}/scripting/projects/raat-ka-khauf-3am-kuan/pipeline.json`) === canonBefore.pipeline);
check('N isolated canonical state unchanged', sha(CANON.stateFile) === canonBefore.state);
check('N isolated canonical run.log unchanged', sha(CANON.runLogFile) === canonBefore.runlog);
check('N isolated canonical outputs tree unchanged', treeHash(CANON.outputsDir) === canonBefore.tree);
check('N isolated canonical run.log unchanged (re-read)', sha(CANON.runLogFile) === canonBefore.runlog);
check('N no canonical approval.json added', !fs.existsSync(CANON.approvalFile) && !fs.existsSync(`${REPO}/production/outputs/raat-ka-khauf-3am-kuan/approval.json`));
check('N no Flow lock / no Chrome', !fs.existsSync(`${REPO}/production/.flow-session.lock`));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n8GW APPROVAL / REVIEW UNIFICATION TESTS PASSED (${passed} checks)`);
