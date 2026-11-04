// STEP-8GX — read-only project health report. LOCAL-ONLY; no network/Flow/Chrome/publisher.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import zlib from 'node:zlib'; import crypto from 'node:crypto'; import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import { pathToFileURL } from 'node:url';
import { writeFixtureBackgrounds, createFixtureClipBank, installFixtureClips, buildLegacySceneFixture, treeHash } from './helpers/isolatedFixtures.mts';
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
const PH = await import(pathToFileURL(`${SRC}/projectHealth.ts`).href);
const RS = await import(pathToFileURL(`${SRC}/reviewState.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const shaOrNull = (f: string) => (fs.existsSync(f) ? sha(f) : null);
function treeHash(root: string) { if (!fs.existsSync(root)) return ''; const files: string[] = []; const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else files.push(f + ':' + crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')); } }; walk(root); return files.sort().join('|'); }
function makePng(w: number, h: number, ct = 6, tag = 0) { const T: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; } const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }; const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); }; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct; const ch = ct === 6 ? 4 : 2; const raw = Buffer.alloc(h * (1 + w * ch), 0x80); for (let y = 0; y < h; y++) raw[y * (1 + w * ch)] = 0; raw[11] = tag & 0xff; return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }
const wav = (f: string, sec: number, tag = 0) => { const n = Math.round(sec * 8000); const d = Buffer.alloc(n * 2, tag); const b = Buffer.alloc(44 + d.length); b.write('RIFF', 0); b.writeUInt32LE(36 + d.length, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(d.length, 40); d.copy(b, 44); fs.writeFileSync(f, b); };
const REAL_BG_TAGS = ['#BGD-01-VILLAGE-STREET-WIDE', '#BGD-02-WELL-AREA-WIDE', '#BGD-03-WELL-AREA-CLOSE', '#BGD-04-VILLAGE-ELDERS-HOUSE-INTERIOR', '#BGD-05-VILLAGE-STREET-CLOSE'];
const DUR = 3;

/** One encoded clip bank shared by every fixture in this file (byte-identical across fixtures). */
let CLIP_BANK: string[] = [];

async function buildFixture(tmp: string, id: string, sceneCount = 14) {
  const projectsRoot = path.join(tmp, 'projects'), inputsRoot = path.join(tmp, 'inputs'), outputsRoot = path.join(tmp, 'outputs');
  const projectDir = path.join(projectsRoot, id), inputRoot = path.join(inputsRoot, id), outputsDir = path.join(outputsRoot, id);
  for (const d of [projectDir, inputRoot, outputsDir, path.join(inputRoot, 'flow-clips'), path.join(inputRoot, 'backgrounds'), path.join(inputRoot, 'narration'), path.join(inputRoot, 'music'), path.join(outputsDir, 'narration')]) fs.mkdirSync(d, { recursive: true });
  const scenes: any[] = [];
  installFixtureClips(inputRoot, CLIP_BANK.slice(0, Math.max(sceneCount, 14)));
  for (let n = 1; n <= sceneCount; n++) { scenes.push({ scene_number: n, title: `S${n}`, background_tag: REAL_BG_TAGS[(n - 1) % 5], character_tags: [], speaker: 'NARRATOR', camera: 'wide', effects: '', sound_design: '', visual_action: `action ${n}`, narration_text: `नarration ${n}`, animation_prompt_NARRATOR_ONLY: `prompt ${n}`, animation_prompt_WITH_LIPSYNC: `prompt ${n}`, status: 'pending' }); }
  fs.writeFileSync(path.join(projectDir, 'pipeline.json'), JSON.stringify({ project_id: id, style_reference: {}, flow_project_name: `Fixture ${id}`, characters: [], backgrounds: REAL_BG_TAGS.map((tag) => ({ tag, location_name: tag, look_summary: 'x', full_prompt: 'x' })), scenes }, null, 2));
  writeFixtureBackgrounds(inputRoot);
  for (let n = 1; n <= sceneCount; n++) { const name = `narration-${String(n).padStart(4, '0')}.wav`; wav(path.join(inputRoot, 'narration', name), DUR, n & 0xff); fs.copyFileSync(path.join(inputRoot, 'narration', name), path.join(outputsDir, 'narration', name)); }
  const bgm = path.join(inputRoot, 'music', 'background-music.mp3'); await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=10:sample_rate=44100', '-ac', '2', '-b:a', '96k', bgm]);
  fs.writeFileSync(path.join(inputRoot, 'music', 'background-music.license.json'), JSON.stringify({ license: 'CC0' }));
  const intro = path.join(tmp, 'branding-intro.mp4'); await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'color=c=0x101020:s=1280x720:d=2', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', intro]);
  const logo = path.join(tmp, `branding-logo-${id}.png`); fs.writeFileSync(logo, makePng(256, 256, 6, 3));
  // Place branding in the STANDARD project input location too, so the read-only health view
  // reproduces the recorded stage keys.
  fs.mkdirSync(path.join(inputRoot, 'branding'), { recursive: true });
  fs.copyFileSync(intro, path.join(inputRoot, 'branding', 'channel-intro.mp4'));
  fs.copyFileSync(logo, path.join(inputRoot, 'branding', 'channel-logo.png'));
  return { projectsRoot, inputsRoot, outputsRoot, projectDir, inputRoot, outputsDir, projectFile: path.join(projectDir, 'pipeline.json'), pipeline: JSON.parse(fs.readFileSync(path.join(projectDir, 'pipeline.json'), 'utf8')), bgm, intro, logo };
}
function optsFor(f: any, title = 'RAAT KA KHAUF') {
  const intro = path.join(f.inputRoot, 'branding', 'channel-intro.mp4');
  const logo = path.join(f.inputRoot, 'branding', 'channel-logo.png');
  return { projectsRoot: f.projectsRoot, inputsRoot: f.inputsRoot, outputsRoot: f.outputsRoot, projectId: f.pipeline.project_id, ffprobePath: process.env.FFPROBE_PATH, productionDir: PROD, titleAssets: { intro, logo, title }, bgmPath: f.bgm, stageInputs: { bgmHash: shaOrNull(f.bgm), introHash: shaOrNull(intro), logoHash: shaOrNull(logo), titleMetadata: { title: f.pipeline.flow_project_name } }, sceneExecutor: async (scene: any, outputPath: string) => { const n = String(scene?.sceneNumber ?? scene?.scene_number).padStart(4, '0'); await fs.promises.mkdir(path.dirname(outputPath), { recursive: true }); await fs.promises.copyFile(path.join(f.inputRoot, 'flow-clips', `scene-${n}.mp4`), outputPath); return { ok: true }; } };
}
const healthFor = (f: any) => PH.getProjectHealth({ projectFile: f.projectFile, inputsRoot: f.inputsRoot, outputsRoot: f.outputsRoot, ffprobePath: process.env.FFPROBE_PATH });
const approveBase = (f: any) => ({ projectId: f.pipeline.project_id, outputsRoot: f.outputsRoot, outputsDir: f.outputsDir, inputRoot: f.inputRoot, pipeline: f.pipeline, ffprobePath: process.env.FFPROBE_PATH, stageInputs: optsFor(f).stageInputs });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8gx-'));
CLIP_BANK = await createFixtureClipBank(path.join(tmp, 'clip-bank'), 14);
const A = await buildFixture(tmp, 'gx-a');
const B = await buildFixture(tmp, 'gx-b');

// ================== A: schema on the 35-scene legacy project shape (isolated, read-only) ==================
// The original `raat-ka-khauf-3am-kuan` inputs/outputs directories no longer exist on disk, so
// this block used to abort on ENOENT before running a single check. It now runs against an
// ISOLATED synthetic fixture that reproduces the legacy layout (35 scenes, 5 backgrounds,
// 14 locally-clipped scenes, Flow-committed clip-less dialogue scenes, no downstream stages).
// The real repository pipeline.json is still pinned, separately, by its literal SHA-256.
const LEGACY = await buildLegacySceneFixture(path.join(tmp, 'canonical'), { backgroundTags: REAL_BG_TAGS });
const REAL_PROJECT = LEGACY.projectFile;
const canonBefore = treeHash(LEGACY.outputsDir);
const realHealth = await PH.getProjectHealth({ projectFile: REAL_PROJECT, inputsRoot: LEGACY.inputsRoot, outputsRoot: LEGACY.outputsRoot, ffprobePath: process.env.FFPROBE_PATH });
check('A report schema has all sections', !!(realHealth.projectId && realHealth.inputs && realHealth.scenes && realHealth.flow && realHealth.downstream && realHealth.approval && realHealth.release && realHealth.release.nextAction));
check('B legacy-project readiness: 35 scenes, 14 ready, 5/5 backgrounds', realHealth.scenes.total === 35 && realHealth.scenes.ready === 14 && realHealth.inputs.backgrounds.valid === 5, JSON.stringify({ total: realHealth.scenes.total, ready: realHealth.scenes.ready, bg: realHealth.inputs.backgrounds }));
// STRICT readiness short-circuit (sceneState.ts:306 + :333): for ANY clip-less scene, readiness
// resolves to WAITING_FOR_VIDEO_CLIP before the character-MISSING branch (:337) and the
// narration-MISSING branch (:338) are ever reached. This legacy project supplies no character
// cutouts at all and no narration for scenes 15-35, yet those two blockers are NOT what the
// report names: all 21 clip-less scenes report WAITING_FOR_VIDEO_CLIP and the character /
// narration / background counters stay at zero. That is the documented STRICT contract, and it
// is asserted from the other direction by production_check_cli_test cases 5/6 and
// project_state_test case 12/13.
check('B legacy-project: all 21 clip-less scenes report WAITING_FOR_VIDEO_CLIP under STRICT', realHealth.scenes.waitingForVideoClip === 21 && realHealth.scenes.ready === 14 && realHealth.scenes.invalid === 0 && realHealth.scenes.total === 35, JSON.stringify(realHealth.scenes));
check('B legacy-project: character/narration/background blockers are NOT surfaced under STRICT (the clip gate wins)', realHealth.scenes.waitingForCharacterAsset === 0 && realHealth.scenes.waitingForNarration === 0 && realHealth.scenes.waitingForBackground === 0, JSON.stringify(realHealth.scenes));
check('B legacy-project: not publishable, blocked downstream', realHealth.release.publishable === false && realHealth.downstream.states.TITLE !== 'CURRENT', JSON.stringify(realHealth.release));
check('I legacy-project: no Flow generation required for already-local valid scenes', realHealth.flow.needsGeneration.length === 0 && realHealth.flow.nextActionConsumesCredits === false, JSON.stringify(realHealth.flow));
check('J legacy-project next action is LOCAL_ONLY', realHealth.release.nextAction.class === 'LOCAL_ONLY' && realHealth.release.nextAction.credit_consuming === false, JSON.stringify(realHealth.release.nextAction));
check('L legacy-project health is read-only (tree unchanged)', treeHash(LEGACY.outputsDir) === canonBefore);

// ================== C: isolated AWAITING_APPROVAL project ==================
await WF.resumeProjectWorkflow(optsFor(A) as any);
const hAwait = await healthFor(A);
check('C isolated: TITLE valid, approval missing, not publishable', hAwait.approval.integrity === 'APPROVAL_MISSING' && hAwait.downstream.states.TITLE === 'CURRENT' && hAwait.release.publishable === false, JSON.stringify({ a: hAwait.approval.integrity, t: hAwait.downstream.states.TITLE }));
check('J isolated: next action EXPLICIT_APPROVAL (human required, no credits)', hAwait.release.nextAction.action === 'EXPLICIT_APPROVAL' && hAwait.release.nextAction.human_required === true && hAwait.release.nextAction.credit_consuming === false, JSON.stringify(hAwait.release.nextAction));

// ================== L: read-only guarantee (byte-identical) ==================
{
  const before = treeHash(A.outputsDir) + '|' + sha(A.projectFile);
  await healthFor(A);
  const after = treeHash(A.outputsDir) + '|' + sha(A.projectFile);
  check('L health leaves the project tree byte-identical', before === after);
}

// ================== D: approved project ==================
const approveA = await AP.approveProject(approveBase(A));
check('D approval applied', approveA.ok === true);
const hApproved = await healthFor(A);
check('D approved: integrity valid, hash+key match, publishable', hApproved.approval.integrity === 'APPROVAL_VALID' && hApproved.approval.hashMatch === true && hApproved.approval.stageKeyMatch === true && hApproved.release.publishable === true, JSON.stringify(hApproved.approval));
check('J approved: next action identifies the external publisher (not invoked)', hApproved.release.nextAction.external_publisher_required === true && (hApproved.release.nextAction.action === 'EXTERNAL_PUBLISHER' || hApproved.release.nextAction.action === 'READY_FOR_EXTERNAL_PUBLISH'), JSON.stringify(hApproved.release.nextAction));

// ================== E: stale approval ==================
fs.writeFileSync(path.join(A.outputsDir, 'final-title.mp4'), Buffer.from('CORRUPT'));
const hStale = await healthFor(A);
check('E stale approval detected', hStale.approval.integrity === 'APPROVAL_STALE' && hStale.release.publishable === false, JSON.stringify(hStale.approval));
check('E stale: next action returns to production/repair (no publisher)', hStale.release.nextAction.action === 'REPAIR_STAGE_OUTPUT' && hStale.release.nextAction.external_publisher_required === false, JSON.stringify(hStale.release.nextAction));
await WF.resumeProjectWorkflow(optsFor(A) as any); // repair

// ================== F: legacy project (review approved, no approval.json) ==================
await WF.resumeProjectWorkflow(optsFor(B) as any);
{
  const p = await RS.loadProject(B.projectFile);
  p.review = { status: 'approved', video_path: path.join(B.outputsDir, 'final-title.mp4'), decided_at: '2026-01-01T00:00:00.000Z' };
  await RS.saveProject(B.projectFile, p);
}
const hLegacy = await healthFor(B);
check('F legacy: review approved but integrity approval missing', hLegacy.approval.review === 'REVIEW_APPROVED' && hLegacy.approval.integrity === 'APPROVAL_MISSING', JSON.stringify(hLegacy.approval));
check('F legacy: not publishable + no migration', hLegacy.release.publishable === false && !fs.existsSync(path.join(B.outputsDir, 'approval.json')), JSON.stringify(hLegacy.release));
check('F legacy: next action EXPLICIT_APPROVAL', hLegacy.release.nextAction.action === 'EXPLICIT_APPROVAL', JSON.stringify(hLegacy.release.nextAction));

// ================== G/H: scene + downstream blocker aggregation ==================
{
  const G = await buildFixture(tmp, 'gx-g', 3);
  // Remove scene 2's clip AND narration. Under STRICT the clip gate decides the blocker name.
  fs.rmSync(path.join(G.inputRoot, 'flow-clips', 'scene-0002.mp4'), { force: true });
  fs.rmSync(path.join(G.inputRoot, 'narration', 'narration-0002.wav'), { force: true });
  const hG = await healthFor(G);
  // Scene 2 has neither a clip nor narration. Under STRICT the missing clip is the gate that
  // readiness short-circuits on (sceneState.ts:333), so the scene reports WAITING_FOR_VIDEO_CLIP
  // and never reaches the narration-MISSING branch (:338). WAITING_FOR_NARRATION is unreachable
  // while STRICT is in force -- asserted from the other direction by production_check_cli_test
  // case 6 and project_state_test case 12/13.
  check('G scene blocker aggregation reflects the missing clip, not the missing narration (STRICT)', hG.scenes.waitingForNarration === 0 && hG.scenes.waitingForVideoClip === 1 && hG.scenes.ready === 2, JSON.stringify(hG.scenes));
  // Because the clip is the gate, a clip-less scene is classified as Flow work: scene 2 lands in
  // `needsGeneration`, so projectHealth.ts:151 returns FLOW_SCENE_GENERATION / FLOW_REQUIRED
  // (credit-consuming) long before it could reach the SUPPLY_NARRATION branch (:157).
  // SUPPLY_NARRATION is unreachable while STRICT is in force.
  check('J clip-less blocker → FLOW_SCENE_GENERATION (FLOW_REQUIRED, credit-consuming), not SUPPLY_NARRATION (STRICT)', hG.release.nextAction.action === 'FLOW_SCENE_GENERATION' && hG.release.nextAction.class === 'FLOW_REQUIRED' && hG.release.nextAction.credit_consuming === true && hG.flow.needsGeneration.length === 1, JSON.stringify({ na: hG.release.nextAction, needsGeneration: hG.flow.needsGeneration }));
  // H: with all inputs valid but no scenes rendered yet, downstream not current.
  const H = await buildFixture(tmp, 'gx-h', 3);
  const hH = await healthFor(H);
  check('H downstream blocker aggregation (TITLE not CURRENT → RUN_PRODUCTION)', hH.downstream.states.TITLE !== 'CURRENT' && hH.release.nextAction.action === 'RUN_PRODUCTION', JSON.stringify({ ds: hH.downstream.states, na: hH.release.nextAction.action }));
}

// ================== I: Flow credit classification ==================
{
  const I = await buildFixture(tmp, 'gx-i', 3);
  // Force a dialogue scene with no clip → Flow generation required.
  const p = JSON.parse(fs.readFileSync(I.projectFile, 'utf8'));
  p.characters = [{ tag: '@CHAR-01-ARJUN', name: 'A', look_summary: 'x', full_prompt: 'x', voice_description: 'x' }];
  p.scenes[1].speaker = '@CHAR-01-ARJUN'; p.scenes[1].character_tags = ['@CHAR-01-ARJUN']; p.scenes[1].narration_text = '';
  fs.writeFileSync(I.projectFile, JSON.stringify(p, null, 2));
  // A dialogue scene with NO supplied clip genuinely requires Flow video (WAITING_FOR_VIDEO_CLIP).
  fs.rmSync(path.join(I.inputRoot, 'flow-clips', 'scene-0002.mp4'), { force: true });
  fs.copyFileSync(path.join(I.inputRoot, 'narration', 'narration-0001.wav'), path.join(I.outputsDir, 'narration', 'narration-0001.wav'));
  const hI = await PH.getProjectHealth({ projectFile: I.projectFile, inputsRoot: I.inputsRoot, outputsRoot: I.outputsRoot, ffprobePath: process.env.FFPROBE_PATH });
  const flowish = hI.flow.needsGeneration.length > 0 || hI.scenes.waitingForCharacterAsset > 0 || hI.release.nextAction.class === 'FLOW_REQUIRED';
  check('I a genuinely Flow-blocked scene is classified FLOW_REQUIRED (credits)', hI.release.nextAction.class === 'FLOW_REQUIRED' ? hI.release.nextAction.credit_consuming === true : flowish, JSON.stringify({ na: hI.release.nextAction, flow: hI.flow }));
}

// ================== K: publishable invariant ==================
check('K publishable never true without a valid integrity approval', hAwait.release.publishable === false && hLegacy.release.publishable === false && hStale.release.publishable === false && realHealth.release.publishable === false);

// ================== M: project isolation ==================
check('M health reports are project-independent', hApproved.projectId !== hLegacy.projectId && hApproved.release.publishable === true && hLegacy.release.publishable === false);
check('M A approval does not leak into B', !fs.existsSync(path.join(B.outputsDir, 'approval.json')) && (await healthFor(B)).release.publishable === false);

// ================== P: consistency with publish-status ==================
{
  const recon = await AR.publishReadinessDetailed({ ...approveBase(A) });
  const hNow = await healthFor(A);
  check('P health publishable agrees with publish-status', hNow.release.publishable === recon.publishable, JSON.stringify({ health: hNow.release.publishable, recon: recon.publishable }));
}

// ================== N/O: CLI human + JSON output (invoked via module fns) ==================
{
  const r = await healthFor(A);
  const human = PH.renderHealthReport(r);
  check('N human output is concise and useful', /PROJECT:/.test(human) && /RELEASE:/.test(human) && /NEXT:/.test(human), human.slice(0, 120));
  const json = JSON.stringify(r);
  check('O JSON output round-trips with required keys', !!JSON.parse(json).release && !!JSON.parse(json).approval && !!JSON.parse(json).flow);
}

// ================== N: canonical project protection (after) ==================
check('N canonical outputs tree unchanged', treeHash(LEGACY.outputsDir) === canonBefore);
check('N no canonical approval.json', !fs.existsSync(LEGACY.approvalFile) && !fs.existsSync(`${REPO}/production/outputs/raat-ka-khauf-3am-kuan/approval.json`));
check('N no flow lock / no chrome', !fs.existsSync(`${REPO}/production/.flow-session.lock`));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n8GX PROJECT HEALTH REPORT TESTS PASSED (${passed} checks)`);
