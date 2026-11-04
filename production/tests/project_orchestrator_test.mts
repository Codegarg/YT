// Offline focused tests for the STEP-8GJ top-level project orchestrator. No Chrome/Flow/OpenAI/network.
// Uses ISOLATED temp projects only; the real project is never touched.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
import { SRC, REPO } from './_testPaths.mjs';
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
const PO = await import(pathToFileURL(`${SRC}/projectOrchestrator.ts`).href);
const SE = await import(pathToFileURL(`${SRC}/stageExecutor.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8gj-'));
const projectsRoot = path.join(tmp, 'projects');
const inputsRoot = path.join(tmp, 'inputs');
const outputsRoot = path.join(tmp, 'outputs');
for (const d of [projectsRoot, inputsRoot, outputsRoot]) fs.mkdirSync(d, { recursive: true });

// ---------------- 2/3/4: project id + slug ----------------
check('2 slug: deterministic for same title', PO.projectSlug('तीसरी रात') === PO.projectSlug('तीसरी रात'));
check('2b slug: filesystem-safe [a-z0-9-] only', /^[a-z0-9-]+$/.test(PO.projectSlug('Raat Ka Khauf: 3AM (Kuan!)')));
check('2c slug: bounded length', PO.projectSlug('x'.repeat(200)).length <= PO.PROJECT_SLUG_MAX);
check('2d slug: empty/emoji → "untitled"', PO.projectSlug('') === 'untitled' && PO.projectSlug('🙂🙂') === 'untitled');
check('4 path traversal title sanitized (no separators/dots)', (() => { const id = PO.buildProjectId({ title: '../../etc/passwd', stamp: '20260101', suffix: '1' }); return !/[\\/.]/.test(id) && id.startsWith('youtube-automation-'); })());
check('4b traversal via slug never escapes', (() => { const id = PO.buildProjectId({ title: 'a/../b\\c', stamp: '20260101', suffix: '1' }); return !id.includes('..') && !id.includes('/') && !id.includes('\\'); })());
check('3 unique suffix helper avoids collisions', PO.nextUniqueSuffix(['a', 'a-1'], 'a') === 'a-2');

// ---------------- 1: allocate a new project (no existing collision) ----------------
const alloc1 = await PO.allocateProjectId({ title: 'First Story', projectsRoot, inputsRoot, outputsRoot, stamp: '20260101', suffix: '1' });
check('1 allocate new project id', alloc1.ok === true && /youtube-automation-first-story-20260101-1/.test(alloc1.projectId), alloc1.projectId);
check('1b allocate wrote nothing', !fs.existsSync(path.join(projectsRoot, alloc1.projectId)) && !fs.existsSync(alloc1.paths!.outputsDir));

// ---------------- 3b: repeated same-title creation → unique ids ----------------
{
  // Pre-create the first id's pipeline dir so the second allocation must disambiguate.
  fs.mkdirSync(path.join(projectsRoot, alloc1.projectId), { recursive: true });
  const alloc2 = await PO.allocateProjectId({ title: 'First Story', projectsRoot, inputsRoot, outputsRoot, stamp: '20260101', suffix: '1' });
  check('3b same title+stamp → unique id (counter suffix)', alloc2.ok && alloc2.projectId !== alloc1.projectId, `${alloc1.projectId} vs ${alloc2.projectId}`);
}

// ---------------- 5/6/7/9: project lock ----------------
{
  const pid = 'lockproj';
  const a = await PO.acquireProjectLock({ outputsRoot, projectId: pid, host: 'H', now: 1000, pidAlive: async () => true });
  check('5 first lock acquired', a.ok === true);
  const b = await PO.acquireProjectLock({ outputsRoot, projectId: pid, host: 'H', now: 2000, pidAlive: async () => true });
  check('6 second lock on same project blocked', b.ok === false && /locked/i.test(b.reason));
  const other = await PO.acquireProjectLock({ outputsRoot, projectId: 'otherproj', host: 'H', now: 2000, pidAlive: async () => true });
  check('7 independent project locks coexist', other.ok === true);
  if (a.ok) await a.handle.release();
  check('9 lock released on normal completion', (await PO.readProjectLock(outputsRoot, pid)) === null);
}

// ---------------- 8: stale lock recovery (same host, dead pid) ----------------
{
  const pid = 'staleproj';
  const file = PO.projectLockPath(outputsRoot, pid);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ pid: 999999, host: 'H', acquiredAt: '2000-01-01T00:00:00Z', projectId: pid }));
  const r = await PO.acquireProjectLock({ outputsRoot, projectId: pid, host: 'H', now: Date.now(), pidAlive: async () => false, staleAfterMs: 1 });
  check('8 stale lock (dead pid, same host) reclaimed', r.ok === true);
  if (r.ok) await r.handle.release();
  // live owner → never steal
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ pid: 4242, host: 'H', acquiredAt: new Date().toISOString(), projectId: pid }));
  const live = await PO.acquireProjectLock({ outputsRoot, projectId: pid, host: 'H', now: Date.now(), pidAlive: async () => true });
  check('8b live lock never stolen', live.ok === false);
  // cross-host → never steal
  const xh = await PO.acquireProjectLock({ outputsRoot, projectId: pid, host: 'OTHERHOST', now: Date.now(), pidAlive: async () => false });
  check('8c cross-host lock never stolen', xh.ok === false);
}

// ---------------- fixtures for runProject ----------------
function makePng(w: number, h: number, ct = 6, tag = 0) { const T: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; } const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }; const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); }; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct; const ch = ct === 6 ? 4 : 2; const raw = Buffer.alloc(h * (1 + w * ch), 0x80); for (let y = 0; y < h; y++) raw[y * (1 + w * ch)] = 0; raw[11] = (tag & 0xff); return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }
const wav = (f: string, sec: number, tag = 0) => { const n = Math.round(sec * 8000); const d = Buffer.alloc(n * 2, tag); const b = Buffer.alloc(44 + d.length); b.write('RIFF', 0); b.writeUInt32LE(36 + d.length, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(d.length, 40); fs.writeFileSync(f, b); };

async function buildProject(projectId: string, opts: { withNarration: boolean; withBgm: boolean; withBranding: boolean; sceneCount?: number }) {
  const P = PO.resolveProjectPaths({ projectId, projectsRoot, inputsRoot, outputsRoot });
  fs.mkdirSync(path.join(projectsRoot, projectId), { recursive: true });
  fs.mkdirSync(path.join(P.inputRoot, 'backgrounds'), { recursive: true });
  fs.mkdirSync(path.join(P.inputRoot, 'characters'), { recursive: true });
  fs.mkdirSync(path.join(P.inputRoot, 'narration'), { recursive: true });
  fs.mkdirSync(path.join(P.inputRoot, 'music'), { recursive: true });
  fs.mkdirSync(path.join(P.inputRoot, 'flow-clips'), { recursive: true });
  fs.mkdirSync(path.join(P.outputsDir, 'narration'), { recursive: true });
  const scenes = [] as any[];
  for (let n = 1; n <= (opts.sceneCount ?? 2); n++) scenes.push({ scene_number: n, title: `S${n}`, background_tag: '#BGD-01', character_tags: [], speaker: 'NARRATOR', camera: 'W', visual_action: '', effects: '', narration_text: 'न' });
  const pipeline = { project_id: projectId, characters: [], backgrounds: [{ tag: '#BGD-01' }], scenes };
  fs.writeFileSync(P.pipelineFile, JSON.stringify(pipeline, null, 2));
  fs.writeFileSync(path.join(P.inputRoot, 'backgrounds', 'BGD-01.png'), makePng(1920, 1080, 2, 1));
  for (let n = 1; n <= scenes.length; n++) {
    // Narration is 1.5s against the 1.0s supplied clips created below. The gate computes
    // max(clip, narration + NARRATION_TAIL_SECONDS=0.25) / clip and fails a NARRATOR_ONLY scene
    // closed above MAX_NARRATION_VIDEO_STRETCH=2.0. At 3s narration EVERY scene here was a 3.25x
    // conflict, not just scene 1 -- scene 2 only avoided INVALID because
    // NARRATION_LEGACY_EXEMPT_SCENES is hardcoded to {2}, which is an exemption, not valid media.
    // 1.5s gives max(1.0, 1.5+0.25) = 1.75x for every scene, so the project genuinely reaches
    // READY. Over-limit rejection stays covered by narration_duration_policy_test,
    // narrator_only_duration_gate_test, scene_state_test and mix_narration_truncation_guard_test.
    if (opts.withNarration) { wav(path.join(P.inputRoot, 'narration', `narration-${String(n).padStart(4, '0')}.wav`), 1.5, 0); fs.copyFileSync(path.join(P.inputRoot, 'narration', `narration-${String(n).padStart(4, '0')}.wav`), path.join(P.outputsDir, 'narration', `narration-${String(n).padStart(4, '0')}.wav`)); }
    // local clip already present (SUPPLIED_VIDEO) so production is eligible
    await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', `color=c=0x203040:s=640x360:d=1`, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(P.inputRoot, 'flow-clips', `scene-${String(n).padStart(4, '0')}.mp4`)]);
  }
  if (opts.withBgm) { await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=10:sample_rate=44100', '-ac', '2', '-b:a', '96k', path.join(P.inputRoot, 'music', 'background-music.mp3')]); fs.writeFileSync(path.join(P.inputRoot, 'music', 'background-music.license.json'), JSON.stringify({ license: 'CC0' })); }
  // Branding is a REQUIRED project input (inputValidator: "required by addTitle.ts"; the manifest
  // marks channel-intro/channel-logo REQUIRED). This previously wrote the two files into `tmp`
  // only and never created `<inputRoot>/branding`, so `withBranding: true` was effectively a
  // no-op for the project under test — which went unnoticed precisely because missing branding was
  // never propagated into blockers. The assets are now placed at the canonical input location.
  if (opts.withBranding) {
    fs.mkdirSync(path.join(P.inputRoot, 'branding'), { recursive: true });
    await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:d=1:r=24', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(P.inputRoot, 'branding', 'channel-intro.mp4')]);
    await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'color=c=white:s=256x256:d=1', '-frames:v', '1', path.join(P.inputRoot, 'branding', 'channel-logo.png')]);
  }
  return { P, pipeline };
}

// Shared test scene executor: for SUPPLIED_VIDEO scenes, copy the project's local clip to the
// scene output path (models what the production scene executor does for supplied Flow clips).
const makeSceneExec = (P: any) => async (scene: any, out: string) => {
  await fsp.copyFile(path.join(P.inputRoot, 'flow-clips', `scene-${String(scene.sceneNumber).padStart(4, '0')}.mp4`), out);
  return { ok: true };
};

// ---------------- 15/16/17/18: WAITING_FOR_INPUTS blockers ----------------
{
  const { P } = await buildProject('wp1', { withNarration: false, withBgm: false, withBranding: false });
  const r = await PO.projectStatus({ projectId: 'wp1', projectsRoot, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH });
  check('15 missing narration → WAITING_FOR_INPUTS', r.status === 'WAITING_FOR_INPUTS' && r.blockers.some((b) => b.category === 'narration'));
  check('15b narration blocker is precise (scene numbers)', r.blockers.some((b) => b.category === 'narration' && /scene\(s\) 1, 2/.test(b.detail)), JSON.stringify(r.blockers));
  check('status is resumable', r.resumable === true);

  // now add narration only → still WAITING (for a full production run we need a stage executor; status must still be blocked? no—it becomes COMPLETED_TO_APPROVAL only when downstream current). Expect not WAITING for narration.
  const { P: P2 } = await buildProject('wp2', { withNarration: true, withBgm: false, withBranding: false });
  const r2 = await PO.projectStatus({ projectId: 'wp2', projectsRoot, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH });
  check('18 with narration present → narration blocker gone', !r2.blockers.some((b) => b.category === 'narration'));
}

// ---------------- 19/20/24: full run with an injected stage executor → COMPLETED_TO_APPROVAL ----------------
{
  const { P } = await buildProject('full1', { withNarration: true, withBgm: true, withBranding: true, sceneCount: 2 });
  const stageExec = async (stage: string, out: string) => { await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=640x360:d=1', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]); return { ok: true }; };
  const stageInputs = { bgmHash: 'b', introHash: 'i', logoHash: 'l', titleMetadata: { title: 'T' } };
  const r1 = await PO.runProject({ projectId: 'full1', projectsRoot, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, sceneExecutor: makeSceneExec(P), stageExecutor: stageExec, stageInputs, host: 'H' });
  check('19/24 all inputs available + executor → COMPLETED_TO_APPROVAL', r1.status === 'COMPLETED_TO_APPROVAL', `${r1.status} ${JSON.stringify(r1.blockers)}`);
  check('lock acquired and released after run', r1.lockAcquired === true && (await PO.readProjectLock(outputsRoot, 'full1')) === null);
  // second run → zero stages
  let calls = 0; const counting = async (stage: string, out: string) => { calls++; return stageExec(stage, out); };
  const r2 = await PO.runProject({ projectId: 'full1', projectsRoot, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, sceneExecutor: makeSceneExec(P), stageExecutor: counting, stageInputs, host: 'H' });
  check('20 existing CURRENT stages reused (2nd run executes 0 stages)', calls === 0 && r2.status === 'COMPLETED_TO_APPROVAL', `calls=${calls}`);
  // corrupt TITLE → TITLE only
  await fsp.writeFile(path.join(P.outputsDir, 'final-title.mp4'), Buffer.from('CORRUPT'));
  const execT: string[] = []; const record = async (stage: string, out: string) => { execT.push(stage); return stageExec(stage, out); };
  await PO.runProject({ projectId: 'full1', projectsRoot, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, sceneExecutor: makeSceneExec(P), stageExecutor: record, stageInputs, host: 'H' });
  check('21 corrupt TITLE → TITLE only', execT.join(',') === 'TITLE', JSON.stringify(execT));
  // corrupt BED → BED,TITLE
  await fsp.writeFile(path.join(P.outputsDir, 'final-bedded.mp4'), Buffer.from('CORRUPT'));
  const execB: string[] = []; const recordB = async (stage: string, out: string) => { execB.push(stage); return stageExec(stage, out); };
  await PO.runProject({ projectId: 'full1', projectsRoot, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, sceneExecutor: makeSceneExec(P), stageExecutor: recordB, stageInputs, host: 'H' });
  check('22b corrupt BED → BED,TITLE', execB.join(',') === 'BED,TITLE', JSON.stringify(execB));
}

// ---------------- 22: changed BGM → BED,TITLE ; 23: changed narration → MIX,BED,TITLE ----------------
{
  const { P } = await buildProject('inv1', { withNarration: true, withBgm: true, withBranding: true, sceneCount: 2 });
  const stageExec = async (stage: string, out: string) => { await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=640x360:d=1', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]); return { ok: true }; };
  const baseIn = { bgmHash: 'bgm1', introHash: 'i', logoHash: 'l', titleMetadata: { title: 'T' } };
  await PO.runProject({ projectId: 'inv1', projectsRoot, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, sceneExecutor: makeSceneExec(P), stageExecutor: stageExec, stageInputs: baseIn, host: 'H' });
  const run = async (stageInputs: any) => { const seen: string[] = []; const rec = async (stage: string, out: string) => { seen.push(stage); return stageExec(stage, out); }; await PO.runProject({ projectId: 'inv1', projectsRoot, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, sceneExecutor: makeSceneExec(P), stageExecutor: rec, stageInputs, host: 'H' }); return seen; };
  const bgmChanged = await run({ ...baseIn, bgmHash: 'bgm2' });
  check('22 changed BGM → BED,TITLE', bgmChanged.join(',') === 'BED,TITLE', JSON.stringify(bgmChanged));
  // change narration in the canonical inputs dir (byte-different file → MIX key changes).
  // 1.7s @ 700Hz vs the 1.5s @ (the `wav()` tag tone) original: still a genuine byte/hash change,
  // but within policy. The previous 4.0s needed max(1.0, 4.0+0.25)/1.0 = 4.25x, above
  // MAX_NARRATION_VIDEO_STRETCH=2.0, so scene 1 failed closed as DURATION_CONFLICT/INVALID and the
  // scene never re-rendered — the invalidation this assertion tests was never reached.
  // At 1.7s: max(1.0, 1.7+0.25)/1.0 = 1.95x, within the 2x limit.
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=700:duration=1.7:sample_rate=24000', '-ac', '1', '-c:a', 'pcm_s16le', path.join(P.inputRoot, 'narration', 'narration-0001.wav')]);
  fs.copyFileSync(path.join(P.inputRoot, 'narration', 'narration-0001.wav'), path.join(P.outputsDir, 'narration', 'narration-0001.wav'));
  const narrExec = await run({ ...baseIn, bgmHash: 'bgm2' });
  check('23 changed narration → MIX,BED,TITLE', narrExec.join(',') === 'MIX,BED,TITLE', JSON.stringify(narrExec));
}

// ---------------- 25: approval never automatically granted (pure review semantics) ----------------
{
  const { P } = await buildProject('appr1', { withNarration: true, withBgm: true, withBranding: true, sceneCount: 2 });
  const RS = await import(pathToFileURL(`${SRC}/reviewState.ts`).href);
  const st = await RS.markReviewPending(P.pipelineFile, path.join(P.outputsDir, 'final-title.mp4'), 'T');
  check('25 runProject/review reaches awaiting_approval, never approved', st.status === 'awaiting_approval');
}

// ---------------- 26: resume after simulated interruption ----------------
{
  const { P } = await buildProject('res1', { withNarration: true, withBgm: true, withBranding: true, sceneCount: 2 });
  const stageExec = async (stage: string, out: string) => { await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=640x360:d=1', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]); return { ok: true }; };
  const in1 = { bgmHash: 'b', introHash: 'i', logoHash: 'l', titleMetadata: { title: 'T' } };
  // simulate interruption: only EDIT produced (run once with a 1-stage executor)
  let n = 0; const partial = async (stage: string, out: string) => { if (n++ === 0) return stageExec(stage, out); return { ok: false, reason: 'simulated interruption' }; };
  await PO.runProject({ projectId: 'res1', projectsRoot, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, sceneExecutor: makeSceneExec(P), stageExecutor: partial, stageInputs: in1, host: 'H' });
  // resume: full executor must run the REMAINING stages and reach COMPLETED_TO_APPROVAL
  const r = await PO.runProject({ projectId: 'res1', projectsRoot, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, sceneExecutor: makeSceneExec(P), stageExecutor: stageExec, stageInputs: in1, host: 'H' });
  check('26 resume completes after interruption', r.status === 'COMPLETED_TO_APPROVAL', r.status);
}

// ---------------- 27: project A cannot affect project B ----------------
{
  const a = await buildProject('isoA', { withNarration: true, withBgm: true, withBranding: true, sceneCount: 2 });
  const b = await buildProject('isoB', { withNarration: false, withBgm: false, withBranding: false, sceneCount: 2 });
  const aBefore = (await PO.projectStatus({ projectId: 'isoA', projectsRoot, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH })).status;
  // run B (blocked) — must not touch A
  await PO.runProject({ projectId: 'isoB', projectsRoot, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, host: 'H' });
  const aAfter = fs.readFileSync(a.P.pipelineFile, 'utf8');
  check('27 project B run does not mutate project A pipeline', aAfter.includes('isoA'));
  check('27b project A status unaffected', (await PO.projectStatus({ projectId: 'isoA', projectsRoot, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH })).status === aBefore);
}

// ---------------- 28: real project paths never touched by isolated tests ----------------
{
  const realRoot = REPO;
  check('28 isolated roots are NOT under the real project', !path.resolve(inputsRoot).startsWith(path.resolve(realRoot + '/production/inputs')) && !path.resolve(outputsRoot).startsWith(path.resolve(realRoot + '/production/outputs')));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nRUNPROJECT ORCHESTRATOR TESTS PASSED (${passed} checks)`);
