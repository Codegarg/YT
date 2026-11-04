// STEP-8GY — TITLE stage-key provenance hardening. LOCAL-ONLY; no network/Flow/Chrome/publisher.
// Proves health reproduces the EXACT TITLE key the real executor recorded, including a
// NON-STANDARD configured branding/BGM/title-metadata case, and fails closed when provenance
// cannot be resolved.
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
const PH = await import(pathToFileURL(`${SRC}/projectHealth.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const shaOrNull = (f: string) => (fs.existsSync(f) ? sha(f) : null);
function treeHash(root: string) { if (!fs.existsSync(root)) return ''; const files: string[] = []; const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else files.push(f + ':' + sha(f)); } }; walk(root); return files.sort().join('|'); }
function makePng(w: number, h: number, ct = 6, tag = 0) { const T: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; } const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }; const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); }; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct; const ch = ct === 6 ? 4 : 2; const raw = Buffer.alloc(h * (1 + w * ch), 0x80); for (let y = 0; y < h; y++) raw[y * (1 + w * ch)] = 0; raw[11] = tag & 0xff; return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }
const wav = (f: string, sec: number, tag = 0) => { const n = Math.round(sec * 8000); const d = Buffer.alloc(n * 2, tag); const b = Buffer.alloc(44 + d.length); b.write('RIFF', 0); b.writeUInt32LE(36 + d.length, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(d.length, 40); d.copy(b, 44); fs.writeFileSync(f, b); };
const REAL_BG_TAGS = ['#BGD-01-VILLAGE-STREET-WIDE', '#BGD-02-WELL-AREA-WIDE', '#BGD-03-WELL-AREA-CLOSE', '#BGD-04-VILLAGE-ELDERS-HOUSE-INTERIOR', '#BGD-05-VILLAGE-STREET-CLOSE'];
const DUR = 3;

/** One encoded clip bank shared by every fixture in this file (byte-identical across fixtures). */
let CLIP_BANK: string[] = [];

async function buildFixture(tmp: string, id: string) {
  const projectsRoot = path.join(tmp, 'projects'), inputsRoot = path.join(tmp, 'inputs'), outputsRoot = path.join(tmp, 'outputs');
  const projectDir = path.join(projectsRoot, id), inputRoot = path.join(inputsRoot, id), outputsDir = path.join(outputsRoot, id);
  for (const d of [projectDir, inputRoot, outputsDir, path.join(inputRoot, 'flow-clips'), path.join(inputRoot, 'backgrounds'), path.join(inputRoot, 'narration'), path.join(inputRoot, 'music'), path.join(inputRoot, 'branding'), path.join(outputsDir, 'narration')]) fs.mkdirSync(d, { recursive: true });
  const scenes: any[] = [];
  installFixtureClips(inputRoot, CLIP_BANK);
  for (let n = 1; n <= 14; n++) { scenes.push({ scene_number: n, title: `S${n}`, background_tag: REAL_BG_TAGS[(n - 1) % 5], character_tags: [], speaker: 'NARRATOR', camera: 'wide', effects: '', sound_design: '', visual_action: `action ${n}`, narration_text: `नarration ${n}`, animation_prompt_NARRATOR_ONLY: `prompt ${n}`, animation_prompt_WITH_LIPSYNC: `prompt ${n}`, status: 'pending' }); }
  fs.writeFileSync(path.join(projectDir, 'pipeline.json'), JSON.stringify({ project_id: id, style_reference: {}, flow_project_name: `Fixture ${id}`, characters: [], backgrounds: REAL_BG_TAGS.map((tag) => ({ tag, location_name: tag, look_summary: 'x', full_prompt: 'x' })), scenes }, null, 2));
  writeFixtureBackgrounds(inputRoot);
  for (let n = 1; n <= 14; n++) { const name = `narration-${String(n).padStart(4, '0')}.wav`; wav(path.join(inputRoot, 'narration', name), DUR, n & 0xff); fs.copyFileSync(path.join(inputRoot, 'narration', name), path.join(outputsDir, 'narration', name)); }
  const bgm = path.join(inputRoot, 'music', 'background-music.mp3'); await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=10:sample_rate=44100', '-ac', '2', '-b:a', '96k', bgm]);
  fs.writeFileSync(path.join(inputRoot, 'music', 'background-music.license.json'), JSON.stringify({ license: 'CC0' }));
  const intro = path.join(tmp, `branding-intro-${id}.mp4`); await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'color=c=0x101020:s=1280x720:d=2', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', intro]);
  const logo = path.join(tmp, `branding-logo-${id}.png`); fs.writeFileSync(logo, makePng(256, 256, 6, 3));
  fs.copyFileSync(intro, path.join(inputRoot, 'branding', 'channel-intro.mp4'));
  fs.copyFileSync(logo, path.join(inputRoot, 'branding', 'channel-logo.png'));
  return { projectsRoot, inputsRoot, outputsRoot, projectDir, inputRoot, outputsDir, projectFile: path.join(projectDir, 'pipeline.json'), pipeline: JSON.parse(fs.readFileSync(path.join(projectDir, 'pipeline.json'), 'utf8')), bgm, intro, logo };
}
/** Non-standard inputs: external files NOT in the standard input location. */
function optsNonStandard(f: any, tmp: string) {
  const intro = path.join(tmp, 'custom-intro.mp4');
  const logo = path.join(tmp, 'custom-logo.png');
  const bgm = path.join(tmp, 'custom-bgm.mp3');
  return { projectsRoot: f.projectsRoot, inputsRoot: f.inputsRoot, outputsRoot: f.outputsRoot, projectId: f.pipeline.project_id, ffprobePath: process.env.FFPROBE_PATH, productionDir: PROD, titleAssets: { intro, logo, title: 'CUSTOM TITLE META' }, bgmPath: bgm, stageInputs: { bgmHash: shaOrNull(bgm), introHash: shaOrNull(intro), logoHash: shaOrNull(logo), titleMetadata: { title: 'CUSTOM TITLE META' } }, sceneExecutor: async (scene: any, outputPath: string) => { const n = String(scene?.sceneNumber ?? scene?.scene_number).padStart(4, '0'); await fs.promises.mkdir(path.dirname(outputPath), { recursive: true }); await fs.promises.copyFile(path.join(f.inputRoot, 'flow-clips', `scene-${n}.mp4`), outputPath); return { ok: true }; } };
}
const healthFor = (f: any) => PH.getProjectHealth({ projectFile: f.projectFile, inputsRoot: f.inputsRoot, outputsRoot: f.outputsRoot, ffprobePath: process.env.FFPROBE_PATH });
const titleKey = (f: any) => JSON.parse(fs.readFileSync(path.join(f.outputsDir, 'final-title.mp4.stage'), 'utf8')).key;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8gy-'));
CLIP_BANK = await createFixtureClipBank(path.join(tmp, 'clip-bank'), 14);
// The historical `raat-ka-khauf-3am-kuan` inputs/outputs directories no longer exist on disk, so
// hashing them would pass vacuously. Guard an ISOLATED canonical tree that sits outside the
// projects/inputs/outputs roots handed to the code under test, plus the real repository
// pipeline.json.
const CANON = buildIsolatedCanonical(path.join(tmp, 'canonical'));
const canonTree = treeHash(CANON.outputsDir);
const canonPipeline = sha(`${REPO}/scripting/projects/raat-ka-khauf-3am-kuan/pipeline.json`);

// ================== A: 8GU-style STANDARD fixture ==================
{
  const A = await buildFixture(tmp, 'gy-std');
  const run = await WF.resumeProjectWorkflow({ projectsRoot: A.projectsRoot, inputsRoot: A.inputsRoot, outputsRoot: A.outputsRoot, projectId: A.pipeline.project_id, ffprobePath: process.env.FFPROBE_PATH, productionDir: PROD, titleAssets: { intro: A.intro, logo: A.logo, title: 'RAAT' }, bgmPath: A.bgm, stageInputs: { bgmHash: sha(A.bgm), introHash: sha(A.intro), logoHash: sha(A.logo), titleMetadata: { title: A.pipeline.flow_project_name } }, sceneExecutor: async (scene: any, outputPath: string) => { const n = String(scene?.sceneNumber ?? scene?.scene_number).padStart(4, '0'); await fs.promises.mkdir(path.dirname(outputPath), { recursive: true }); await fs.promises.copyFile(path.join(A.inputRoot, 'flow-clips', `scene-${n}.mp4`), outputPath); return { ok: true }; } } as any);
  check('A standard fixture reaches AWAITING_APPROVAL', run.status === 'COMPLETED_TO_APPROVAL', JSON.stringify({ s: run.status }));
  const h = await healthFor(A);
  check('A TITLE CURRENT + provenance RECORDED_STAGE_METADATA', h.downstream.states.TITLE === 'CURRENT' && h.approval.titleInputProvenance === 'RECORDED_STAGE_METADATA', JSON.stringify({ t: h.downstream.states.TITLE, p: h.approval.titleInputProvenance }));
  // health's stageKeyMatch must reflect the recorded key (approve then verify).
  const appr = await AP.approveProject({ projectId: A.pipeline.project_id, outputsRoot: A.outputsRoot, outputsDir: A.outputsDir, inputRoot: A.inputRoot, pipeline: A.pipeline, ffprobePath: process.env.FFPROBE_PATH, stageInputs: { bgmHash: sha(A.bgm), introHash: sha(A.intro), logoHash: sha(A.logo), titleMetadata: { title: A.pipeline.flow_project_name } } });
  check('A approval valid + health publishable', appr.ok === true && (await healthFor(A)).release.publishable === true, JSON.stringify({ ok: appr.ok }));
}

// ================== B: NON-STANDARD configured TITLE inputs ==================
{
  const B = await buildFixture(tmp, 'gy-nonstd');
  const o = optsNonStandard(B, tmp);
  // Create the non-standard inputs (guaranteed different from the standard branding location).
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'color=c=0x446688:s=1280x720:d=2', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', o.titleAssets.intro]);
  fs.writeFileSync(o.titleAssets.logo, makePng(256, 256, 6, 9));
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=10:sample_rate=44100', '-ac', '2', '-b:a', '96k', o.bgmPath]);
  o.stageInputs = { bgmHash: sha(o.bgmPath), introHash: sha(o.titleAssets.intro), logoHash: sha(o.titleAssets.logo), titleMetadata: { title: 'CUSTOM TITLE META' } };
  const run = await WF.resumeProjectWorkflow(o as any);
  check('B non-standard fixture reaches AWAITING_APPROVAL', run.status === 'COMPLETED_TO_APPROVAL', JSON.stringify({ s: run.status }));
  const recordedKey = titleKey(B);
  const sidecar = JSON.parse(fs.readFileSync(path.join(B.outputsDir, 'final-title.mp4.stage'), 'utf8'));
  check('B recorded TITLE sidecar carries key_inputs provenance', !!sidecar.key_inputs && sidecar.key_inputs.introHash === sha(o.titleAssets.intro) && sidecar.key_inputs.logoHash === sha(o.titleAssets.logo));
  const h = await healthFor(B);
  check('B health reproduces the EXACT recorded TITLE key (no STANDARD fallback)', h.downstream.states.TITLE === 'CURRENT' && h.approval.titleInputProvenance === 'RECORDED_STAGE_METADATA', JSON.stringify({ t: h.downstream.states.TITLE, p: h.approval.titleInputProvenance }));
  // approve + confirm publishable (approval ties to the recorded non-standard key/hash)
  const appr = await AP.approveProject({ projectId: B.pipeline.project_id, outputsRoot: B.outputsRoot, outputsDir: B.outputsDir, inputRoot: B.inputRoot, pipeline: B.pipeline, ffprobePath: process.env.FFPROBE_PATH, stageInputs: o.stageInputs });
  check('B approval valid for the non-standard artifact', appr.ok === true && appr.record.approved_final_stage_key === recordedKey, JSON.stringify({ ok: appr.ok }));
  check('B health publishable with non-standard provenance', (await healthFor(B)).release.publishable === true);
}

// ================== C: AMBIGUOUS provenance fails closed ==================
{
  const C = await buildFixture(tmp, 'gy-ambig');
  const o = optsNonStandard(C, tmp);
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'color=c=0x446688:s=1280x720:d=2', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', o.titleAssets.intro]);
  fs.writeFileSync(o.titleAssets.logo, makePng(256, 256, 6, 9));
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=10:sample_rate=44100', '-ac', '2', '-b:a', '96k', o.bgmPath]);
  o.stageInputs = { bgmHash: sha(o.bgmPath), introHash: sha(o.titleAssets.intro), logoHash: sha(o.titleAssets.logo), titleMetadata: { title: 'CUSTOM TITLE META' } };
  await WF.resumeProjectWorkflow(o as any);
  const recordedKey = titleKey(C);
  await AP.approveProject({ projectId: C.pipeline.project_id, outputsRoot: C.outputsRoot, outputsDir: C.outputsDir, inputRoot: C.inputRoot, pipeline: C.pipeline, ffprobePath: process.env.FFPROBE_PATH, stageInputs: o.stageInputs });
  // Strip the recorded provenance from the sidecar (keep the key) → ambiguity.
  const sc = JSON.parse(fs.readFileSync(path.join(C.outputsDir, 'final-title.mp4.stage'), 'utf8'));
  delete sc.key_inputs;
  fs.writeFileSync(path.join(C.outputsDir, 'final-title.mp4.stage'), JSON.stringify(sc, null, 2));
  // Remove standard branding too, so no standard fallback can reconstruct the key.
  fs.rmSync(path.join(C.inputRoot, 'branding', 'channel-intro.mp4'), { force: true });
  fs.rmSync(path.join(C.inputRoot, 'branding', 'channel-logo.png'), { force: true });
  const h = await healthFor(C);
  check('C ambiguous provenance fails closed (not CURRENT / not APPROVED)', h.downstream.states.TITLE !== 'CURRENT' && h.approval.integrity !== 'APPROVAL_VALID' && h.release.publishable === false, JSON.stringify({ t: h.downstream.states.TITLE, i: h.approval.integrity, p: h.release.publishable }));
  check('C ambiguity never fabricates a matching key', h.approval.stageKeyMatch === false || h.approval.integrity === 'APPROVAL_STALE', JSON.stringify(h.approval));
  check('C recorded key preserved (health did not rewrite it)', titleKey(C) === recordedKey);
}

// ================== D: stale/corrupt TITLE keeps integrity behavior ==================
{
  const D = await buildFixture(tmp, 'gy-stale');
  const run = await WF.resumeProjectWorkflow({ projectsRoot: D.projectsRoot, inputsRoot: D.inputsRoot, outputsRoot: D.outputsRoot, projectId: D.pipeline.project_id, ffprobePath: process.env.FFPROBE_PATH, productionDir: PROD, titleAssets: { intro: D.intro, logo: D.logo, title: 'RAAT' }, bgmPath: D.bgm, stageInputs: { bgmHash: sha(D.bgm), introHash: sha(D.intro), logoHash: sha(D.logo), titleMetadata: { title: D.pipeline.flow_project_name } }, sceneExecutor: async (scene: any, outputPath: string) => { const n = String(scene?.sceneNumber ?? scene?.scene_number).padStart(4, '0'); await fs.promises.mkdir(path.dirname(outputPath), { recursive: true }); await fs.promises.copyFile(path.join(D.inputRoot, 'flow-clips', `scene-${n}.mp4`), outputPath); return { ok: true }; } } as any);
  await AP.approveProject({ projectId: D.pipeline.project_id, outputsRoot: D.outputsRoot, outputsDir: D.outputsDir, inputRoot: D.inputRoot, pipeline: D.pipeline, ffprobePath: process.env.FFPROBE_PATH, stageInputs: { bgmHash: sha(D.bgm), introHash: sha(D.intro), logoHash: sha(D.logo), titleMetadata: { title: D.pipeline.flow_project_name } } });
  fs.writeFileSync(path.join(D.outputsDir, 'final-title.mp4'), Buffer.from('CORRUPT'));
  const h = await healthFor(D);
  check('D corrupt TITLE → APPROVAL_STALE + not publishable', h.approval.integrity === 'APPROVAL_STALE' && h.release.publishable === false, JSON.stringify({ i: h.approval.integrity }));
}

// ================== E: read-only ==================
{
  const E = await buildFixture(tmp, 'gy-ro');
  const o = optsNonStandard(E, tmp);
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'color=c=0x446688:s=1280x720:d=2', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', o.titleAssets.intro]);
  fs.writeFileSync(o.titleAssets.logo, makePng(256, 256, 6, 9));
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=10:sample_rate=44100', '-ac', '2', '-b:a', '96k', o.bgmPath]);
  o.stageInputs = { bgmHash: sha(o.bgmPath), introHash: sha(o.titleAssets.intro), logoHash: sha(o.titleAssets.logo), titleMetadata: { title: 'CUSTOM TITLE META' } };
  await WF.resumeProjectWorkflow(o as any);
  const before = treeHash(E.outputsDir) + '|' + treeHash(E.inputRoot) + '|' + sha(E.projectFile);
  const h1 = await healthFor(E);
  const h2 = await healthFor(E);
  const after = treeHash(E.outputsDir) + '|' + treeHash(E.inputRoot) + '|' + sha(E.projectFile);
  check('E health is strictly read-only (tree byte-identical)', before === after);
  check('E health is deterministic across calls', JSON.stringify(h1.downstream.states) === JSON.stringify(h2.downstream.states) && h1.approval.titleInputProvenance === h2.approval.titleInputProvenance);
}

// ================== F: isolation ==================
{
  const P1 = await buildFixture(tmp, 'gy-iso1');
  const P2 = await buildFixture(tmp, 'gy-iso2');
  await WF.resumeProjectWorkflow({ projectsRoot: P1.projectsRoot, inputsRoot: P1.inputsRoot, outputsRoot: P1.outputsRoot, projectId: P1.pipeline.project_id, ffprobePath: process.env.FFPROBE_PATH, productionDir: PROD, titleAssets: { intro: P1.intro, logo: P1.logo, title: 'RAAT' }, bgmPath: P1.bgm, stageInputs: { bgmHash: sha(P1.bgm), introHash: sha(P1.intro), logoHash: sha(P1.logo), titleMetadata: { title: P1.pipeline.flow_project_name } }, sceneExecutor: async (scene: any, outputPath: string) => { const n = String(scene?.sceneNumber ?? scene?.scene_number).padStart(4, '0'); await fs.promises.mkdir(path.dirname(outputPath), { recursive: true }); await fs.promises.copyFile(path.join(P1.inputRoot, 'flow-clips', `scene-${n}.mp4`), outputPath); return { ok: true }; } } as any);
  const h1 = await healthFor(P1);
  const h2 = await healthFor(P2);
  check('F project A provenance does not affect B (B has no TITLE artifact)', h1.projectId !== h2.projectId && h1.downstream.states.TITLE === 'CURRENT' && h2.downstream.states.TITLE !== 'CURRENT', JSON.stringify({ a: h1.downstream.states.TITLE, b: h2.downstream.states.TITLE }));
  check('F provenance is project-local (no cross approval.json)', !fs.existsSync(path.join(P2.outputsDir, 'approval.json')));
}

// ================== regression: canonical untouched ==================
check('canonical outputs tree unchanged', treeHash(CANON.outputsDir) === canonTree);
check('canonical pipeline unchanged', sha(`${REPO}/scripting/projects/raat-ka-khauf-3am-kuan/pipeline.json`) === canonPipeline);
check('canonical no approval.json / no flow lock', !fs.existsSync(CANON.approvalFile) && !fs.existsSync(`${REPO}/production/outputs/raat-ka-khauf-3am-kuan/approval.json`) && !fs.existsSync(`${REPO}/production/.flow-session.lock`));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n8GY TITLE KEY PROVENANCE TESTS PASSED (${passed} checks)`);
