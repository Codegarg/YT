// STEP-8HH — authoritative publish gate. Offline only: mock publisher, no network/Chrome/Flow.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import zlib from 'node:zlib'; import crypto from 'node:crypto'; import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
import { SRC } from './_testPaths.mjs';
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
const WF = await import(pathToFileURL(`${SRC}/projectWorkflow.ts`).href);
const AP = await import(pathToFileURL(`${SRC}/approval.ts`).href);
const Z = await import(pathToFileURL(`${SRC}/zernio.ts`).href);
const RS = await import(pathToFileURL(`${SRC}/reviewState.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };
function makePng(w: number, h: number, ct = 6, tag = 0) { const T: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; } const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }; const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); }; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct; const ch = ct === 6 ? 4 : 2; const raw = Buffer.alloc(h * (1 + w * ch), 0x80); for (let y = 0; y < h; y++) raw[y * (1 + w * ch)] = 0; raw[11] = tag & 0xff; return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }
const wav = (f: string, sec: number, tag = 0) => { const n = Math.round(sec * 8000); const d = Buffer.alloc(n * 2, tag); const b = Buffer.alloc(44 + d.length); b.write('RIFF', 0); b.writeUInt32LE(36 + d.length, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(d.length, 40); d.copy(b, 44); fs.writeFileSync(f, b); };
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const shaOrNull = (f: string) => fs.existsSync(f) ? sha(f) : null;
const mkClip = async (o: string) => { fs.mkdirSync(path.dirname(o), { recursive: true }); await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=640x360:d=2', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', o]); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8hh-'));
const APPROVED_PROJECT_ID = 'youtube-automation-2-20261003160855-2740';
const APPROVED_YOUTUBE_ACCOUNT_ID = '6ae2401339a3d63e1238c167';
const approvedAccountInspector = async () => [{
  platform: 'youtube',
  accountId: APPROVED_YOUTUBE_ACCOUNT_ID,
  displayName: 'RAAT KA KHAUF',
  isActive: true,
}];

async function buildApproved(caseKey: string) {
  const caseRoot = path.join(tmp, caseKey);
  const projectsRoot = path.join(caseRoot, 'projects'), inputsRoot = path.join(caseRoot, 'inputs'), outputsRoot = path.join(caseRoot, 'outputs');
  const projectDir = path.join(projectsRoot, APPROVED_PROJECT_ID), inputRoot = path.join(inputsRoot, APPROVED_PROJECT_ID), outputsDir = path.join(outputsRoot, APPROVED_PROJECT_ID);
  for (const d of [projectDir, inputRoot, outputsDir, path.join(inputRoot, 'flow-clips'), path.join(inputRoot, 'backgrounds'), path.join(inputRoot, 'narration'), path.join(inputRoot, 'music'), path.join(inputRoot, 'branding'), path.join(outputsDir, 'narration')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(inputRoot, 'backgrounds', 'BGD-01.png'), makePng(1920, 1080, 2, 1));
  const scenes: any[] = [];
  for (let n = 1; n <= 2; n++) { await mkClip(path.join(inputRoot, 'flow-clips', `scene-000${n}.mp4`)); const nm = `narration-000${n}.wav`; wav(path.join(inputRoot, 'narration', nm), 3, n & 0xff); fs.copyFileSync(path.join(inputRoot, 'narration', nm), path.join(outputsDir, 'narration', nm)); scenes.push({ scene_number: n, title: `S${n}`, background_tag: '#BGD-01', character_tags: [], speaker: 'NARRATOR', camera: 'w', effects: '', sound_design: '', visual_action: `a${n}`, narration_text: 'न', animation_prompt_NARRATOR_ONLY: 'p', animation_prompt_WITH_LIPSYNC: 'p', status: 'pending' }); }
  fs.writeFileSync(path.join(projectDir, 'pipeline.json'), JSON.stringify({ project_id: APPROVED_PROJECT_ID, flow_project_name: 'HH', characters: [], backgrounds: [{ tag: '#BGD-01', location_name: 't', look_summary: 'x', full_prompt: 'x' }], scenes }, null, 2));
  const bgm = path.join(inputRoot, 'music', 'background-music.mp3'); await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=8', '-c:a', 'libmp3lame', bgm]);
  fs.writeFileSync(path.join(inputRoot, 'music', 'background-music.license.json'), JSON.stringify({ license: 'CC0' }));
  const intro = path.join(inputRoot, 'branding', 'channel-intro.mp4'); await mkClip(intro);
  const logo = path.join(inputRoot, 'branding', 'channel-logo.png'); fs.writeFileSync(logo, makePng(256, 256, 6, 3));
  const projectFile = path.join(projectDir, 'pipeline.json');
  const stageInputs = { bgmHash: shaOrNull(bgm), introHash: shaOrNull(intro), logoHash: shaOrNull(logo), titleMetadata: { title: 'HH' } };
  const sceneExec = (input: any) => SEA.createRealSceneExecutor({ projectId: input.projectId, inputRoot: input.inputRoot, outputsRoot: input.outputsRoot, pipeline: input.pipeline, allowGeneration: input.allowGeneration, ffprobePath: input.ffprobePath, flow: input.flow });
  // reach AWAITING_APPROVAL
  await WF.resumeProjectWorkflow({ projectsRoot, inputsRoot, outputsRoot, projectId: APPROVED_PROJECT_ID, ffprobePath: process.env.FFPROBE_PATH, titleAssets: { intro, logo, title: 'HH' }, bgmPath: bgm, stageInputs, sceneExecutorFactory: sceneExec as any, stageExecutorFactory: () => async (_s: string, out: string) => { await mkClip(out); return { ok: true }; } } as any);
  // explicit approval
  await AP.approveProject({ projectId: APPROVED_PROJECT_ID, outputsRoot, outputsDir, inputRoot, pipeline: JSON.parse(fs.readFileSync(projectFile, 'utf8')), ffprobePath: process.env.FFPROBE_PATH });
  // legacy review approved
  const project = await RS.loadProject(projectFile); project.review = { status: 'approved', video_path: path.join(outputsDir, 'final-title.mp4'), decided_at: new Date().toISOString() }; await RS.saveProject(projectFile, project);
  return { projectsRoot, inputsRoot, outputsRoot, projectDir, inputRoot, outputsDir, projectFile };
}
const SEA = await import(pathToFileURL(`${SRC}/sceneExecutorAdapter.ts`).href);
const req = (f: any) => ({ projectFile: f.projectFile, accountId: APPROVED_YOUTUBE_ACCOUNT_ID, mediaUrl: 'https://example.invalid/media.mp4', title: 'T', outputsRoot: f.outputsRoot, inputsRoot: f.inputsRoot, ffprobePath: process.env.FFPROBE_PATH });

// ================== E. positive: both gates pass → injected publisher reached ==================
{
  const f = await buildApproved('hh-ok');
  let published = 0;
  const out = await Z.publishToZernio({ ...req(f), confirmPublish: 'YES' }, { accountInspector: approvedAccountInspector, publisher: async (payload: any) => { published++; return { post: { id: 'p1', platforms: [{ platform: 'youtube', platformPostUrl: 'https://youtu.be/x' }] } }; } });
  check('E both gates pass → injected publisher reached exactly once', out.ok === true && published === 1, JSON.stringify({ out, published }));
  const acceptedState = (await RS.loadProject(f.projectFile)).review;
  check('E accepted submission does NOT mark the review posted', acceptedState?.status === 'approved' && acceptedState?.publish?.status === 'ACCEPTED' && acceptedState?.zernio_post_id === undefined && acceptedState?.posted_at === undefined, JSON.stringify(acceptedState));
}

// ================== helper for refused cases ==================
async function refusedCase(id: string, mutate: (f: any) => void, confirm: string | undefined): Promise<{ f: any; out: any; published: number }> {
  const f = await buildApproved(id);
  mutate?.(f);
  let published = 0;
  const out = await Z.publishToZernio({ ...req(f), confirmPublish: confirm }, { accountInspector: approvedAccountInspector, publisher: async () => { published++; return {}; } });
  return { f, out, published };
}

// ================== A. missing approval.json ==================
{
  const { f, out, published } = await refusedCase('hh-noappr', (x) => fs.rmSync(path.join(x.outputsDir, 'approval.json'), { force: true }), 'YES');
  check('A missing approval.json → refused, publisher not invoked', out.ok === false && out.refused === 'integrity' && published === 0, JSON.stringify(out));
  check('A refusal left no Flow lock', !fs.existsSync(path.join(f.outputsRoot, '.flow-session.lock')) && !fs.existsSync(path.join(tmp, '.flow-session.lock')));
}

// ================== C. valid integrity approval + legacy review NOT approved ==================
{
  const { out, published } = await refusedCase('hh-noreview', (x) => { const p = JSON.parse(fs.readFileSync(x.projectFile, 'utf8')); p.review = { status: 'awaiting_approval', video_path: 'x' }; fs.writeFileSync(x.projectFile, JSON.stringify(p, null, 2)); }, 'YES');
  check('C legacy review not approved → refused, publisher not invoked', out.ok === false && out.refused === 'review' && published === 0, JSON.stringify(out));
}

// ================== D. missing --confirm-publish YES ==================
{
  const { out, published } = await refusedCase('hh-noconfirm', () => {}, undefined);
  check('D absent --confirm-publish YES → refused, publisher not invoked', out.ok === false && out.refused === 'confirm' && published === 0, JSON.stringify(out));
  const { out: out2 } = await refusedCase('hh-badconfirm2', () => {}, 'yes');
  check('D2 incorrect confirm value → refused', out2.ok === false && out2.refused === 'confirm');
}

// ================== F. TITLE dependency mutation (key_inputs changed) → stale ==================
{
  const { out, published } = await refusedCase('hh-mutate', (x) => { const sc = JSON.parse(fs.readFileSync(path.join(x.outputsDir, 'final-title.mp4.stage'), 'utf8')); sc.key_inputs = { ...sc.key_inputs, titleMetadata: { title: 'MUTATED' } }; fs.writeFileSync(path.join(x.outputsDir, 'final-title.mp4.stage'), JSON.stringify(sc, null, 2)); }, 'YES');
  check('F TITLE dependency mutation → refused (stale), publisher not invoked', out.ok === false && out.refused === 'integrity' && published === 0, JSON.stringify(out));
}

// ================== G. TITLE output corruption ==================
{
  const { out, published } = await refusedCase('hh-corrupt', (x) => fs.writeFileSync(path.join(x.outputsDir, 'final-title.mp4'), Buffer.from('CORRUPT')), 'YES');
  check('G TITLE corruption → refused, publisher not invoked', out.ok === false && out.refused === 'integrity' && published === 0, JSON.stringify(out));
}

// ================== H. approval key/hash mismatch ==================
{
  const { out, published } = await refusedCase('hh-keymismatch', (x) => { const a = JSON.parse(fs.readFileSync(path.join(x.outputsDir, 'approval.json'), 'utf8')); a.approved_final_stage_key = 'deadbeef'.repeat(8); fs.writeFileSync(path.join(x.outputsDir, 'approval.json'), JSON.stringify(a, null, 2)); }, 'YES');
  check('H approval stage-key mismatch → refused, publisher not invoked', out.ok === false && out.refused === 'integrity' && published === 0, JSON.stringify(out));
}

// ================== I. deterministic + read-only gate evaluation ==================
{
  const f = await buildApproved('hh-deterministic');
  const gateIn = { projectFile: f.projectFile, outputsRoot: f.outputsRoot, outputsDir: f.outputsDir, inputRoot: f.inputRoot, pipeline: JSON.parse(fs.readFileSync(f.projectFile, 'utf8')), projectId: path.basename(f.projectDir), ffprobePath: process.env.FFPROBE_PATH };
  const before = sha(f.projectFile) + '|' + sha(path.join(f.outputsDir, 'approval.json'));
  const g1 = await Z.evaluatePublishGate(gateIn);
  const g2 = await Z.evaluatePublishGate(gateIn);
  const after = sha(f.projectFile) + '|' + sha(path.join(f.outputsDir, 'approval.json'));
  check('I gate verdict is deterministic and read-only', g1.ok === true && g2.ok === true && before === after, JSON.stringify({ g1, g2, before: before === after }));
}

// ================== B. legacy approved + stale integrity (tampered) refused ==================
{
  const { out, published } = await refusedCase('hh-stale', (x) => { const a = JSON.parse(fs.readFileSync(path.join(x.outputsDir, 'approval.json'), 'utf8')); a.approved_final_output_hash = '00'.repeat(32); fs.writeFileSync(path.join(x.outputsDir, 'approval.json'), JSON.stringify(a, null, 2)); }, 'YES');
  check('B legacy approved + stale integrity approval → refused', out.ok === false && out.refused === 'integrity' && published === 0, JSON.stringify(out));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n8HH PUBLISH GATE TESTS PASSED (${passed} checks)`);
