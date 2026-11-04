// STEP-8GZ — legacy prodCheck --execute-stages TITLE key provenance. REAL legacy path, no Flow.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import zlib from 'node:zlib'; import crypto from 'node:crypto'; import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import { pathToFileURL } from 'node:url';
import { writeFixtureBackgrounds, buildIsolatedCanonical, treeHash } from './helpers/isolatedFixtures.mts';
const exec = promisify(execFile);
import { REPO } from './_testPaths.mjs';
const SRC = `${REPO}/production/src`; const PROD = `${REPO}/production`;
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
process.env.PATH = `${FF};${process.env.PATH}`;
const PC = await import(pathToFileURL(`${SRC}/prodCheck.ts`).href);
const PH = await import(pathToFileURL(`${SRC}/projectHealth.ts`).href);
const AP = await import(pathToFileURL(`${SRC}/approval.ts`).href);
const ORCH = await import(pathToFileURL(`${SRC}/productionOrchestrator.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const shaOrNull = (f: string) => (fs.existsSync(f) ? sha(f) : null);
function treeHash(root: string) { if (!fs.existsSync(root)) return ''; const out: string[] = []; const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out.push(f + ':' + sha(f) + ':' + fs.statSync(f).mtimeMs); } }; walk(root); return out.join('|'); }
function makePng(w: number, h: number, ct = 6, tag = 0) { const T: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; } const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }; const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); }; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct; const ch = ct === 6 ? 4 : 2; const raw = Buffer.alloc(h * (1 + w * ch), 0x80); for (let y = 0; y < h; y++) raw[y * (1 + w * ch)] = 0; raw[11] = tag & 0xff; return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }
const wav = (f: string, sec: number, tag = 0) => { const n = Math.round(sec * 8000); const d = Buffer.alloc(n * 2, tag); const b = Buffer.alloc(44 + d.length); b.write('RIFF', 0); b.writeUInt32LE(36 + d.length, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(d.length, 40); d.copy(b, 44); fs.writeFileSync(f, b); };
async function mkMp4(o: string, d = 2, color = '0x203040') { await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=640x360:d=${d}`, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', String(d), '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', o]); }
const BG_TAGS = ['#BGD-01', '#BGD-02', '#BGD-03', '#BGD-04', '#BGD-05'];

/** Isolated project with 3 scenes and REAL scene outputs already CURRENT (via orchestrate executor). */
async function buildExecutedFixture(tmp: string, id: string) {
  const projectsRoot = path.join(tmp, 'projects'), inputsRoot = path.join(tmp, 'inputs'), outputsRoot = path.join(tmp, 'outputs');
  const projectDir = path.join(projectsRoot, id), inputRoot = path.join(inputsRoot, id), outputsDir = path.join(outputsRoot, id);
  for (const d of [projectDir, inputRoot, outputsDir, path.join(inputRoot, 'flow-clips'), path.join(inputRoot, 'backgrounds'), path.join(inputRoot, 'narration'), path.join(inputRoot, 'music'), path.join(inputRoot, 'branding'), path.join(outputsDir, 'narration')]) fs.mkdirSync(d, { recursive: true });
  const scenes: any[] = [];
  for (let n = 1; n <= 3; n++) scenes.push({ scene_number: n, title: `S${n}`, background_tag: BG_TAGS[(n - 1) % 5], character_tags: [], speaker: 'NARRATOR', camera: 'wide', effects: '', sound_design: '', visual_action: `a${n}`, narration_text: `न${n}`, animation_prompt_NARRATOR_ONLY: 'p', animation_prompt_WITH_LIPSYNC: 'p', status: 'pending' });
  fs.writeFileSync(path.join(projectDir, 'pipeline.json'), JSON.stringify({ project_id: id, flow_project_name: `Fixture ${id}`, characters: [], backgrounds: BG_TAGS.map((t) => ({ tag: t, location_name: t, look_summary: 'x', full_prompt: 'x' })), scenes }, null, 2));
  writeFixtureBackgrounds(inputRoot);
  for (let n = 1; n <= 3; n++) {
    await mkMp4(path.join(inputRoot, 'flow-clips', `scene-000${n}.mp4`), 2, '0x203040');
    const name = `narration-000${n}.wav`; wav(path.join(inputRoot, 'narration', name), 3, n & 0xff); fs.copyFileSync(path.join(inputRoot, 'narration', name), path.join(outputsDir, 'narration', name));
  }
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=8', '-c:a', 'libmp3lame', path.join(inputRoot, 'music', 'background-music.mp3')]);
  fs.writeFileSync(path.join(inputRoot, 'music', 'background-music.license.json'), JSON.stringify({ license: 'CC0' }));
  // Standard branding in-input location + non-standard external copies.
  const stdIntro = path.join(inputRoot, 'branding', 'channel-intro.mp4'); await mkMp4(stdIntro, 2, '0x101020');
  const stdLogo = path.join(inputRoot, 'branding', 'channel-logo.png'); fs.writeFileSync(stdLogo, makePng(256, 256, 6, 3));
  const nonStdIntro = path.join(tmp, `custom-intro-${id}.mp4`); await mkMp4(nonStdIntro, 2, '0x446688');
  const nonStdLogo = path.join(tmp, `custom-logo-${id}.png`); fs.writeFileSync(nonStdLogo, makePng(256, 256, 6, 9));
  const nonStdBgm = path.join(tmp, `custom-bgm-${id}.mp3`); await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=8', '-c:a', 'libmp3lame', nonStdBgm]);
  // Materialize scene outputs + sidecars CURRENT via the EXISTING orchestrator scene-executor
  // pattern, so the downstream stages are legitimately eligible for execution.
  const pipeline = JSON.parse(fs.readFileSync(path.join(projectDir, 'pipeline.json'), 'utf8'));
  await ORCH.orchestrate({
    pipeline, projectId: id, inputRoot, outputsDir, outputsRoot, ffprobePath: process.env.FFPROBE_PATH,
    executor: async (scene: any, out: string) => { const n = String(scene?.sceneNumber).padStart(4, '0'); await fs.promises.mkdir(path.dirname(out), { recursive: true }); await fs.promises.copyFile(path.join(inputRoot, 'flow-clips', `scene-${n}.mp4`), out); return { ok: true }; },
  });
  return { projectsRoot, inputsRoot, outputsRoot, projectDir, inputRoot, outputsDir, projectFile: path.join(projectDir, 'pipeline.json'), pipeline, stdIntro, stdLogo, nonStdIntro, nonStdLogo, nonStdBgm };
}

/** Run the REAL legacy prodCheck --execute-stages path. */
async function legacyExecute(f: any, assets: { intro: string; logo: string; title: string }, bgm: string) {
  return PC.runCheck({ project: f.projectFile, inputsDir: f.inputsRoot, outputsDir: f.outputsDir, outputsRoot: f.outputsRoot, executeStages: true, productionDir: PROD, titleAssets: assets, bgmPath: bgm } as any);
}
const titleSidecar = (f: any) => JSON.parse(fs.readFileSync(path.join(f.outputsDir, 'final-title.mp4.stage'), 'utf8'));
const healthFor = (f: any) => PH.getProjectHealth({ projectFile: f.projectFile, inputsRoot: f.inputsRoot, outputsRoot: f.outputsRoot, ffprobePath: process.env.FFPROBE_PATH });
const titleKey = (f: any) => titleSidecar(f).key;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8gz-'));
// The historical `raat-ka-khauf-3am-kuan` inputs/outputs directories no longer exist on disk, so
// hashing them would pass vacuously. Guard an ISOLATED canonical tree that sits outside the
// projects/inputs/outputs roots handed to the code under test, plus the real repository
// pipeline.json.
const CANON = buildIsolatedCanonical(path.join(tmp, 'canonical'));
const canonPipeline = sha(`${REPO}/scripting/projects/raat-ka-khauf-3am-kuan/pipeline.json`);
const canonTree = treeHash(CANON.outputsDir, { includeMtime: true });
const canonState = sha(CANON.stateFile);

// ================== 1: LEGACY NON-STANDARD TITLE ==================
let NS: any;
{
  NS = await buildExecutedFixture(tmp, 'gz-nonstd');
  const assets = { intro: NS.nonStdIntro, logo: NS.nonStdLogo, title: 'CUSTOM META' };
  const res = await legacyExecute(NS, assets, NS.nonStdBgm);
  check('1a legacy --execute-stages ran TITLE', /Executed stages:.*TITLE/.test((res as any).text ?? '') || fs.existsSync(path.join(NS.outputsDir, 'final-title.mp4.stage')), JSON.stringify((res as any).text ?? (res as any).json).slice(0, 200));
  const sc = titleSidecar(NS);
  check('1b legacy TITLE sidecar contains key_inputs', !!sc.key_inputs && typeof sc.key_inputs === 'object', JSON.stringify(sc));
  check('1c key_inputs hold the ACTUAL non-standard hashes/meta', sc.key_inputs.introHash === sha(assets.intro) && sc.key_inputs.logoHash === sha(assets.logo) && sc.key_inputs.bgmHash === sha(NS.nonStdBgm) && JSON.stringify(sc.key_inputs.titleMetadata) === JSON.stringify({ title: 'CUSTOM META' }), JSON.stringify(sc.key_inputs));
  // Remove the standard branding so fallback CANNOT reproduce the key.
  fs.rmSync(path.join(NS.inputRoot, 'branding', 'channel-intro.mp4'), { force: true });
  fs.rmSync(path.join(NS.inputRoot, 'branding', 'channel-logo.png'), { force: true });
  const h = await healthFor(NS);
  check('1d health TITLE CURRENT from legacy non-standard execution', h.downstream.states.TITLE === 'CURRENT', JSON.stringify(h.downstream.states));
  check('1e health reports RECORDED_STAGE_METADATA', h.approval.titleInputProvenance === 'RECORDED_STAGE_METADATA', h.approval.titleInputProvenance);
  // Health-derived TITLE key must EXACTLY equal the recorded key (else TITLE would be STALE).
  const inspect1f = await ORCH.inspectProject({ pipeline: NS.pipeline, projectId: NS.pipeline.project_id, inputRoot: NS.inputRoot, outputsDir: NS.outputsDir, outputsRoot: NS.outputsRoot, ffprobePath: process.env.FFPROBE_PATH, stageInputs: titleSidecar(NS).key_inputs, readOnly: true } as any);
  check('1f health-derived key equals recorded key', inspect1f.downstream.keys.TITLE === titleKey(NS) && h.downstream.states.TITLE === 'CURRENT', JSON.stringify({ derived: inspect1f.downstream.keys.TITLE, recorded: titleKey(NS) }));
  // approval binds to the recorded non-standard key
  const appr = await AP.approveProject({ projectId: NS.pipeline.project_id, outputsRoot: NS.outputsRoot, outputsDir: NS.outputsDir, inputRoot: NS.inputRoot, pipeline: NS.pipeline, ffprobePath: process.env.FFPROBE_PATH });
  check('1g approval valid for legacy non-standard artifact + health publishable', appr.ok === true && appr.record.approved_final_stage_key === titleKey(NS) && (await healthFor(NS)).release.publishable === true, JSON.stringify({ ok: appr.ok }));
}

// ================== 2: LEGACY STANDARD TITLE ==================
let STD: any;
{
  STD = await buildExecutedFixture(tmp, 'gz-std');
  const assets = { intro: STD.stdIntro, logo: STD.stdLogo, title: 'STD META' };
  await legacyExecute(STD, assets, path.join(STD.inputRoot, 'music', 'background-music.mp3'));
  const sc = titleSidecar(STD);
  check('2a standard legacy TITLE sidecar has key_inputs with standard hashes', sc.key_inputs.introHash === sha(STD.stdIntro) && sc.key_inputs.logoHash === sha(STD.stdLogo), JSON.stringify(sc.key_inputs));
  const h = await healthFor(STD);
  check('2b standard legacy TITLE CURRENT + RECORDED_STAGE_METADATA', h.downstream.states.TITLE === 'CURRENT' && h.approval.titleInputProvenance === 'RECORDED_STAGE_METADATA', JSON.stringify({ t: h.downstream.states.TITLE, p: h.approval.titleInputProvenance }));
  const appr = await AP.approveProject({ projectId: STD.pipeline.project_id, outputsRoot: STD.outputsRoot, outputsDir: STD.outputsDir, inputRoot: STD.inputRoot, pipeline: STD.pipeline, ffprobePath: process.env.FFPROBE_PATH });
  check('2c standard approval behavior unchanged (valid)', appr.ok === true);
}

// ================== 8: IDEMPOTENCY (before mutations) ==================
{
  const before = sha(path.join(STD.outputsDir, 'final-title.mp4.stage'));
  const keyBefore = titleSidecar(STD).key_inputs;
  await legacyExecute(STD, { intro: STD.stdIntro, logo: STD.stdLogo, title: 'STD META' }, path.join(STD.inputRoot, 'music', 'background-music.mp3'));
  const after = sha(path.join(STD.outputsDir, 'final-title.mp4.stage'));
  check('8a repeated legacy execution does not rewrite a CURRENT sidecar', before === after, JSON.stringify({ before, after }));
  check('8b key_inputs byte-stable on repeat', JSON.stringify(titleSidecar(STD).key_inputs) === JSON.stringify(keyBefore));
}

// ================== 3: MISSING key_inputs ==================
{
  const sc = titleSidecar(STD);
  const key = sc.key;
  delete sc.key_inputs;
  fs.writeFileSync(path.join(STD.outputsDir, 'final-title.mp4.stage'), JSON.stringify(sc, null, 2));
  // The legacy TITLE was produced with a NON-default title metadata ('STD META'), so the standard
  // fallback (which derives metadata from the pipeline) cannot safely reproduce the key →
  // FAIL CLOSED (never fabricate). This is the safe, required behavior.
  const h = await healthFor(STD);
  check('3a missing key_inputs + no reproducible provenance → fail closed (not CURRENT)', h.downstream.states.TITLE !== 'CURRENT' && h.release.publishable === false, JSON.stringify({ t: h.downstream.states.TITLE, p: h.approval.titleInputProvenance }));
  check('3b recorded key preserved (health never rewrites it)', titleKey(STD) === key);
  // Approval must also fail closed without recorded provenance it cannot reproduce.
  const apprNoProv = await AP.approveProject({ projectId: STD.pipeline.project_id, outputsRoot: STD.outputsRoot, outputsDir: STD.outputsDir, inputRoot: STD.inputRoot, pipeline: STD.pipeline, ffprobePath: process.env.FFPROBE_PATH });
  check('3c approval fails closed without reproducible provenance', apprNoProv.ok === false, JSON.stringify(apprNoProv));
  // Restore provenance by re-running the legacy execution with the TITLE sidecar removed
  // (forces re-execution, which re-persists key_inputs).
  fs.rmSync(path.join(STD.outputsDir, 'final-title.mp4.stage'), { force: true });
  fs.rmSync(path.join(STD.outputsDir, 'final-title.mp4'), { force: true });
  await legacyExecute(STD, { intro: STD.stdIntro, logo: STD.stdLogo, title: 'STD META' }, path.join(STD.inputRoot, 'music', 'background-music.mp3'));
  check('3d valid re-execution restores recorded provenance', !!titleSidecar(STD).key_inputs && titleKey(STD) === key);
}

// ================== 4: MALFORMED key_inputs ==================
{
  const sc = titleSidecar(STD);
  const key = sc.key;
  sc.key_inputs = { introHash: 'not-a-hash', logoHash: 123, titleMetadata: null };
  fs.writeFileSync(path.join(STD.outputsDir, 'final-title.mp4.stage'), JSON.stringify(sc, null, 2));
  const h = await healthFor(STD);
  check('4a malformed key_inputs never falsely CURRENT', h.downstream.states.TITLE !== 'CURRENT' && h.release.publishable === false, JSON.stringify({ t: h.downstream.states.TITLE }));
  // Restore a valid sidecar by re-running legacy execution with real inputs.
  await legacyExecute(STD, { intro: STD.stdIntro, logo: STD.stdLogo, title: 'STD META' }, path.join(STD.inputRoot, 'music', 'background-music.mp3'));
  check('4b valid re-execution restores provenance', !!titleSidecar(STD).key_inputs && titleKey(STD) === key);
}

// ================== 5: OUTPUT CORRUPTION ==================
{
  const F = await buildExecutedFixture(tmp, 'gz-corrupt');
  await legacyExecute(F, { intro: F.stdIntro, logo: F.stdLogo, title: 'STD META' }, path.join(F.inputRoot, 'music', 'background-music.mp3'));
  const appr = await AP.approveProject({ projectId: F.pipeline.project_id, outputsRoot: F.outputsRoot, outputsDir: F.outputsDir, inputRoot: F.inputRoot, pipeline: F.pipeline, ffprobePath: process.env.FFPROBE_PATH });
  check('5a pre-corrupt approval valid + publishable', appr.ok === true && (await healthFor(F)).release.publishable === true, JSON.stringify(appr));
  fs.writeFileSync(path.join(F.outputsDir, 'final-title.mp4'), Buffer.from('CORRUPT'));
  const h = await healthFor(F);
  check('5b corrupt TITLE → integrity detects it, approval stale, not publishable', h.approval.integrity === 'APPROVAL_STALE' && h.release.publishable === false, JSON.stringify({ i: h.approval.integrity }));
}

// ================== 6: READ-ONLY HEALTH ==================
{
  const F = await buildExecutedFixture(tmp, 'gz-ro');
  await legacyExecute(F, { intro: F.nonStdIntro, logo: F.nonStdLogo, title: 'CUSTOM META' }, F.nonStdBgm);
  const snap = () => treeHash(F.outputsDir) + '|' + treeHash(F.inputRoot) + '|' + sha(F.projectFile);
  const before = snap();
  await healthFor(F); await healthFor(F);
  check('6a repeated health is byte+timestamp stable (read-only)', snap() === before);
}

// ================== 7: PROJECT ISOLATION ==================
{
  const A = await buildExecutedFixture(tmp, 'gz-isoA');
  const B = await buildExecutedFixture(tmp, 'gz-isoB');
  await legacyExecute(A, { intro: A.nonStdIntro, logo: A.nonStdLogo, title: 'META-A' }, A.nonStdBgm);
  // B: no execution at all.
  const hA = await healthFor(A); const hB = await healthFor(B);
  check('7a A TITLE CURRENT, B has no TITLE artifact', hA.downstream.states.TITLE === 'CURRENT' && hB.downstream.states.TITLE !== 'CURRENT', JSON.stringify({ a: hA.downstream.states.TITLE, b: hB.downstream.states.TITLE }));
  check('7b A provenance does not leak into B (no B approval/sidecar)', !fs.existsSync(path.join(B.outputsDir, 'final-title.mp4.stage')) && !fs.existsSync(path.join(B.outputsDir, 'approval.json')) && hB.approval.titleInputProvenance !== 'RECORDED_STAGE_METADATA');
}

// ================== regression: canonical untouched ==================
check('canonical pipeline unchanged', sha(`${REPO}/scripting/projects/raat-ka-khauf-3am-kuan/pipeline.json`) === canonPipeline);
check('canonical state unchanged', sha(CANON.stateFile) === canonState);
check('canonical outputs tree unchanged', treeHash(CANON.outputsDir, { includeMtime: true }) === canonTree);
check('canonical no approval.json / no flow lock', !fs.existsSync(CANON.approvalFile) && !fs.existsSync(`${REPO}/production/outputs/raat-ka-khauf-3am-kuan/approval.json`) && !fs.existsSync(`${REPO}/production/.flow-session.lock`));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n8GZ LEGACY TITLE PROVENANCE TESTS PASSED (${passed} checks)`);
