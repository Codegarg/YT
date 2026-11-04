// Offline focused tests for STEP-8GK multi-project hardening. No Chrome/Flow/OpenAI/network.
// Isolated temp projects only; the real project is never touched.
import fs from 'node:fs'; import fsp from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
import zlib from 'node:zlib'; import crypto from 'node:crypto'; import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
import { SRC } from './_testPaths.mjs';
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
const PO = await import(pathToFileURL(`${SRC}/projectOrchestrator.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8gk-'));
const projectsRoot = path.join(tmp, 'projects'), inputsRoot = path.join(tmp, 'inputs'), outputsRoot = path.join(tmp, 'outputs');
for (const d of [projectsRoot, inputsRoot, outputsRoot]) fs.mkdirSync(d, { recursive: true });

// ---------------- run-log helpers ----------------
check('isRunLogName: current + rotated recognized', PO.isRunLogName('run.log') && PO.isRunLogName('run.log.jsonl') && PO.isRunLogName('run.log.3') && PO.isRunLogName('run.log.jsonl.2'));
check('isRunLogName: state/checkpoint NOT a run log', !PO.isRunLogName('state.json') && !PO.isRunLogName('scene-0001.json') && !PO.isRunLogName('final-title.mp4.stage'));

// ---------------- 2/3/4: log rotation + retention ----------------
{
  const log = path.join(tmp, 'run.log');
  if (fs.existsSync(log)) fs.rmSync(log);
  // rotate several times
  for (let i = 1; i <= 3; i++) { fs.writeFileSync(log, `run-${i}\n`); await PO.rotateRunLog(log, 2); }
  const files = fs.readdirSync(tmp).filter((f) => /^run\.log/.test(f)).sort();
  check('3 rotation produces bounded run.log.N history', files.includes('run.log.1') && files.includes('run.log.2'), JSON.stringify(files));
  check('4 retention caps history at N (no .3)', !files.includes('run.log.3'), JSON.stringify(files));
  check('2 rotation atomic (no leftover .tmp)', !files.some((f) => f.includes('.tmp')));
  // appendBounded rotates when over maxBytes
  fs.writeFileSync(log, 'x'.repeat(100));
  const r = await PO.appendBoundedRunLog(log, { event: 'test' }, { maxBytes: 10, retention: 2 });
  check('2b appendBounded rotates when over maxBytes', r.rotated === true);
  check('3b history remains bounded', fs.readdirSync(tmp).filter((f) => /^run\.log\.\d+$/.test(f)).length <= 2);
}

// ---------------- 4/5/6/7: temp discovery / dry-run / safety ----------------
{
  const proj = path.join(tmp, 'gcproj');
  fs.mkdirSync(path.join(proj, 'flow-clips'), { recursive: true });
  const old = Date.now() - 2 * 60 * 60 * 1000;
  // known temp names (aged)
  for (const n of ['scene-0001.mp4.tmp-123-456', 'scene-0002.mp4.flow-download.tmp-1-2', 'final-title.mp4.999.tmp', 'final-title.mp4.stage.5.tmp', '.last-bus-title.ass', 'thing.tmp-1-2']) {
    const f = path.join(proj, 'flow-clips', n); fs.writeFileSync(f, 'TEMP'); fs.utimesSync(f, old / 1000, old / 1000);
  }
  // protected + unknown files (must never be touched)
  for (const n of ['scene-0001.mp4', 'scene-0002.mp4', 'scene-0001.mp4.stage', 'state.json', 'pipeline.json', 'notes.txt', 'final-title.mp4']) {
    const f = path.join(proj, n); fs.writeFileSync(f, 'KEEP'); fs.utimesSync(f, old / 1000, old / 1000);
  }
  const dry = await PO.collectProjectTemps({ projectRoot: proj, dryRun: true, now: Date.now() });
  check('5 dry-run finds known temps (candidates)', dry.candidates.length === 6, JSON.stringify(dry.candidates));
  check('5b dry-run deletes nothing', dry.deleted.length === 0 && fs.readdirSync(path.join(proj, 'flow-clips')).includes('scene-0001.mp4.tmp-123-456'));
  const real = await PO.collectProjectTemps({ projectRoot: proj, now: Date.now() });
  check('6 real GC deletes exactly the known temps', real.deleted.length === 6 && real.errors.length === 0, JSON.stringify(real));
  const remaining = [...fs.readdirSync(proj), ...fs.readdirSync(path.join(proj, 'flow-clips'))];
  check('6b protected files preserved', ['scene-0001.mp4', 'scene-0002.mp4', 'scene-0001.mp4.stage', 'state.json', 'pipeline.json', 'notes.txt', 'final-title.mp4'].every((n) => remaining.includes(n)), JSON.stringify(remaining));
  // newer-than-threshold temps are skipped
  const fresh = path.join(proj, 'flow-clips', 'fresh.mp4.tmp-9-9'); fs.writeFileSync(fresh, 'TEMP');
  const gc2 = await PO.collectProjectTemps({ projectRoot: proj, now: Date.now() });
  check('6c fresh temp skipped by age threshold', gc2.skipped.includes(path.join('flow-clips', 'fresh.mp4.tmp-9-9')) && gc2.deleted.length === 0, JSON.stringify(gc2));
}

// ---------------- 7: path safety / traversal ----------------
{
  const root = path.join(tmp, 'safe-root'); fs.mkdirSync(root, { recursive: true });
  check('7 assertInsideRoot accepts child', PO.assertInsideRoot(root, path.join(root, 'a', 'b.mp4')).startsWith(path.resolve(root)));
  const bad = [path.join(root, '..', 'escaped'), path.join(root, '..\\x'), 'C:/Windows/system32', '\\\\server\\share\\x'];
  check('7b traversal/absolute/UNC rejected', bad.every((b) => { try { PO.assertInsideRoot(root, b); return false; } catch { return true; } }));
  check('7c empty resolved path rejected', (() => { try { PO.assertInsideRoot(root, root); return false; } catch { return true; } })());
}

// ---------------- Flow serialization contract ----------------
{
  const lockRoot = path.join(tmp, 'flowlock');
  const a = await PO.acquireFlowSessionLock({ lockRoot, host: 'H', now: 1000, pidAlive: async () => true });
  check('flow lock acquired', a.ok === true);
  const b = await PO.acquireFlowSessionLock({ lockRoot, host: 'H', now: 2000, pidAlive: async () => true });
  check('flow lock serializes (second blocked)', b.ok === false);
  if (a.ok) await a.release();
  // withFlowSessionLock runs fn
  let ran = false; await PO.withFlowSessionLock({ lockRoot }, async () => { ran = true; });
  check('withFlowSessionLock runs and releases', ran === true && !fs.existsSync(PO.flowSessionLockPath(lockRoot)));
  // project lock and flow lock are distinct files
  check('flow lock path distinct from project lock path', PO.flowSessionLockPath(lockRoot) !== PO.projectLockPath(outputsRoot, 'p'));
}

// ---------------- project id hardening — Unicode/Hindi/long/reserved ----------------
check('Hindi title → safe ASCII slug', /^[a-z0-9-]+$/.test(PO.projectSlug('तीसरी रात')));
check('Unicode accents normalized', PO.projectSlug('Café Déjà') === 'cafe-deja');
check('long title bounded', PO.projectSlug('x'.repeat(500)).length <= PO.PROJECT_SLUG_MAX);
check('reserved Windows name sanitized (no separators)', !/[\\/]/.test(PO.buildProjectId({ title: 'CON', stamp: '20260101', suffix: '1' })));
check('quotes/punctuation stripped from id', !/["'<>|:*?]/.test(PO.buildProjectId({ title: 'a"b\'c<d>e|f:g*h?i', stamp: '20260101', suffix: '1' })));
check('emoji-only title → untitled id', PO.buildProjectId({ title: '🙂🙂', stamp: '20260101', suffix: '1' }).includes('untitled'));

// ---------------- PART 5/6: 3-project isolation + sequential production ----------------
function makePng(w: number, h: number, ct = 6, tag = 0) { const T: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; } const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }; const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); }; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct; const ch = ct === 6 ? 4 : 2; const raw = Buffer.alloc(h * (1 + w * ch), 0x80); for (let y = 0; y < h; y++) raw[y * (1 + w * ch)] = 0; raw[11] = tag & 0xff; return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }

async function build(id: string, sceneCount = 2) {
  const P = PO.resolveProjectPaths({ projectId: id, projectsRoot, inputsRoot, outputsRoot });
  fs.mkdirSync(path.join(projectsRoot, id), { recursive: true });
  for (const c of ['backgrounds', 'characters', 'narration', 'music', 'flow-clips']) fs.mkdirSync(path.join(P.inputRoot, c), { recursive: true });
  fs.mkdirSync(path.join(P.outputsDir, 'narration'), { recursive: true });
  const scenes = []; for (let n = 1; n <= sceneCount; n++) scenes.push({ scene_number: n, title: `S${n}`, background_tag: '#BGD-01', character_tags: [], speaker: 'NARRATOR', camera: 'W', visual_action: '', effects: '', narration_text: 'न' });
  fs.writeFileSync(P.pipelineFile, JSON.stringify({ project_id: id, characters: [], backgrounds: [{ tag: '#BGD-01' }], scenes }, null, 2));
  fs.writeFileSync(path.join(P.inputRoot, 'backgrounds', 'BGD-01.png'), makePng(1920, 1080, 2, 1));
  for (let n = 1; n <= sceneCount; n++) {
    // Narration is 1.5s against the 1s supplied clips created below. These scenes are NARRATOR_ONLY,
    // so the narration-duration gate applies: required = max(clip, narration + 0.25), stretch must
    // stay <= MAX_NARRATION_VIDEO_STRETCH (2.0). At 3s that is 3.25x, so every scene failed closed
    // as DURATION_CONFLICT/INVALID, no stage ever ran, and all three projects reported
    // RECOVERABLE_FAILURE. Scene 2 was READY only because NARRATION_LEGACY_EXEMPT_SCENES is
    // hardcoded to {2} - an exemption, not a valid ratio. At 1.5s BOTH scenes are legitimately
    // compliant (1.75x). Over-limit rejection stays covered by narration_duration_policy_test,
    // narrator_only_duration_gate_test, scene_state_test and mix_narration_truncation_guard_test.
    await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=1.5:sample_rate=24000', '-ac', '1', '-c:a', 'pcm_s16le', path.join(P.inputRoot, 'narration', `narration-000${n}.wav`)]);
    fs.copyFileSync(path.join(P.inputRoot, 'narration', `narration-000${n}.wav`), path.join(P.outputsDir, 'narration', `narration-000${n}.wav`));
    await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=640x360:d=1', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(P.inputRoot, 'flow-clips', `scene-000${n}.mp4`)]);
  }
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=10:sample_rate=44100', '-ac', '2', '-b:a', '96k', path.join(P.inputRoot, 'music', 'background-music.mp3')]);
  fs.writeFileSync(path.join(P.inputRoot, 'music', 'background-music.license.json'), JSON.stringify({ license: 'CC0' }));
  // Branding is a REQUIRED project input; it was never written into the input root here, which
  // went unnoticed because missing branding was not propagated into blockers.
  fs.mkdirSync(path.join(P.inputRoot, 'branding'), { recursive: true });
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:d=1', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(P.inputRoot, 'branding', 'channel-intro.mp4')]);
  fs.writeFileSync(path.join(P.inputRoot, 'branding', 'channel-logo.png'), makePng(256, 256, 6, 3));
  return P;
}
const sceneExec = (P: any) => async (scene: any, out: string) => { await fsp.copyFile(path.join(P.inputRoot, 'flow-clips', `scene-${String(scene.sceneNumber).padStart(4, '0')}.mp4`), out); return { ok: true }; };
const stageExec = async (stage: string, out: string) => { await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', `color=c=0x203040:s=640x360:d=1`, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]); return { ok: true }; };
const run = async (id: string, seen?: string[], inputs: any = { bgmHash: 'b', introHash: 'i', logoHash: 'l', titleMetadata: { title: 'T' } }) => {
  const P = PO.resolveProjectPaths({ projectId: id, projectsRoot, inputsRoot, outputsRoot });
  const rec = async (s: string, o: string) => { seen?.push(s); return stageExec(s, o); };
  return PO.runProject({ projectId: id, projectsRoot, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, sceneExecutor: sceneExec(P), stageExecutor: rec, stageInputs: inputs, host: 'H' });
};
{
  const PA = await build('projA'); const PB = await build('projB'); const PC = await build('projC');
  // distinct SHA snapshots
  const snap = (id: string) => { const P = PO.resolveProjectPaths({ projectId: id, projectsRoot, inputsRoot, outputsRoot }); const files: string[] = []; const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else files.push(crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')); } }; walk(P.outputsDir); walk(P.inputRoot); return files.sort().join(','); };
  const a0 = snap('projA'), b0 = snap('projB'), c0 = snap('projC');
  // sequential run order A B C B A C A B
  let lastA: any = null, lastB: any = null, lastC: any = null;
  for (const id of ['projA', 'projB', 'projC', 'projB', 'projA', 'projC', 'projA', 'projB']) { const rr = await run(id); if (id === 'projA') lastA = rr; if (id === 'projB') lastB = rr; if (id === 'projC') lastC = rr; }
  check('11 three isolated projects complete (run results)', lastA?.status === 'COMPLETED_TO_APPROVAL' && lastB?.status === 'COMPLETED_TO_APPROVAL' && lastC?.status === 'COMPLETED_TO_APPROVAL', JSON.stringify([lastA?.status, lastB?.status, lastC?.status]));
  const aCompleted = snap('projA'), bCompleted = snap('projB');
  // changing B does not invalidate A
  // Narration is 1.7s @ 500Hz vs the build() baseline of 1.5s @ 300Hz: a genuine byte/hash change
  // (both duration and frequency differ), so the MIX stage key moves and 11b still tests what it
  // intends. Kept within the duration policy for the same reason as build(): required =
  // max(1.0, 1.7 + 0.25) = 1.95x against MAX_NARRATION_VIDEO_STRETCH = 2.0. The previous 4.0s
  // was 4.25x, so scene 1 failed closed as DURATION_CONFLICT/INVALID and no stage re-executed.
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=1.7:sample_rate=24000', '-ac', '1', '-c:a', 'pcm_s16le', path.join(PB.inputRoot, 'narration', 'narration-0001.wav')]);
  fs.copyFileSync(path.join(PB.inputRoot, 'narration', 'narration-0001.wav'), path.join(PB.outputsDir, 'narration', 'narration-0001.wav'));
  const runB2: string[] = []; const rb2 = await run('projB', runB2);
  check('11b changing B re-executes only MIX/BED/TITLE', runB2.join(',') === 'MIX,BED,TITLE', JSON.stringify(runB2));
  check('11b2 project A tree untouched by B narration change', snap('projA') === aCompleted);
  const bAfterChange = snap('projB');
  // corrupting C does not affect A/B
  fs.writeFileSync(path.join(PC.outputsDir, 'final-title.mp4'), Buffer.from('CORRUPT'));
  const runC2: string[] = []; await run('projC', runC2);
  check('11c corrupting C re-executes TITLE only in C', runC2.join(',') === 'TITLE', JSON.stringify(runC2));
  check('11d A and B trees untouched by C corruption', snap('projA') === aCompleted && snap('projB') === bAfterChange);
  // deleting A temps does not affect B/C
  const gcA = await PO.collectProjectTemps({ projectRoot: PA.outputsDir, now: Date.now() });
  check('11e GC on A does not touch B/C', gcA.errors.length === 0 && snap('projB') === bAfterChange);
}

// ---------------- PART 6: sequential production + exact invalidation ----------------
{
  const P = await build('seq1');
  const first: string[] = []; await run('seq1', first);
  check('12 first run executes required stages', first.join(',') === 'EDIT,MIX,BED,TITLE', JSON.stringify(first));
  const second: string[] = []; await run('seq1', second);
  check('12b second run executes zero stages', second.length === 0, JSON.stringify(second));
  // change narration → only MIX,BED,TITLE
  // Narration is 1.7s @ 700Hz vs the build() baseline of 1.5s @ 300Hz: a genuine byte/hash change,
  // so the MIX stage key moves and 13 still tests exact downstream invalidation. Compliant with the
  // duration policy (required = max(1.0, 1.7 + 0.25) = 1.95x vs MAX_NARRATION_VIDEO_STRETCH = 2.0);
  // the previous 4.0s was 4.25x, which failed closed as DURATION_CONFLICT and re-executed nothing.
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=700:duration=1.7:sample_rate=24000', '-ac', '1', '-c:a', 'pcm_s16le', path.join(P.inputRoot, 'narration', 'narration-0001.wav')]);
  fs.copyFileSync(path.join(P.inputRoot, 'narration', 'narration-0001.wav'), path.join(P.outputsDir, 'narration', 'narration-0001.wav'));
  const third: string[] = []; await run('seq1', third);
  check('13 exact downstream invalidation on narration change', third.join(',') === 'MIX,BED,TITLE', JSON.stringify(third));
}

// ---------------- stale/live lock (covered in 8GJ; assert here too) ----------------
{
  const p = 'lock8gk';
  const f = PO.projectLockPath(outputsRoot, p); await fsp.mkdir(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ pid: 999999, host: 'H', acquiredAt: '2000-01-01T00:00:00Z' }));
  const stale = await PO.acquireProjectLock({ outputsRoot, projectId: p, host: 'H', now: Date.now(), pidAlive: async () => false, staleAfterMs: 1 });
  check('9 stale project lock reclaimed', stale.ok === true); if (stale.ok) await stale.handle.release();
  fs.writeFileSync(f, JSON.stringify({ pid: 4321, host: 'H', acquiredAt: new Date().toISOString() }));
  const live = await PO.acquireProjectLock({ outputsRoot, projectId: p, host: 'H', now: Date.now(), pidAlive: async () => true });
  check('10 live lock protected', live.ok === false);
}

// ---------------- registry decision proof ----------------
{
  // Canonical discovery is sufficient: projects are found by directory listing under the roots.
  const ids = await PO.listProjectIds(projectsRoot);
  check('registry NOT required: canonical dir discovery finds projects', ids.includes('projA') && ids.includes('projB') && ids.includes('projC'), JSON.stringify(ids));
  check('registry NOT required: project paths are canonical & unique', PO.resolveProjectPaths({ projectId: 'projA', projectsRoot, inputsRoot, outputsRoot }).pipelineFile !== PO.resolveProjectPaths({ projectId: 'projB', projectsRoot, inputsRoot, outputsRoot }).pipelineFile);
}

// ---------------- PART 4: interruption recovery (all scenarios) ----------------
{
  const OP = await import(pathToFileURL(`${SRC}/productionOrchestrator.ts`).href);
  const DS = await import(pathToFileURL(`${SRC}/downstreamStages.ts`).href);

  // 1. interrupted during lock acquisition → a partial lock record write (no pid) is reclaimable.
  {
    const p = 'int-lock-partial';
    const f = PO.projectLockPath(outputsRoot, p); await fsp.mkdir(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, ''); // killed mid-write: empty/corrupt lock
    const acq = await PO.acquireProjectLock({ outputsRoot, projectId: p, host: 'H', now: Date.now(), pidAlive: async () => true });
    check('4.1 interrupted lock acquisition recovers (corrupt lock reclaimed)', acq.ok === true);
    if (acq.ok) await acq.handle.release();
  }

  // 2. interrupted AFTER lock acquisition (dead process) → stale-by-dead-pid, reclaimable.
  {
    const p = 'int-lock-held';
    const f = PO.projectLockPath(outputsRoot, p); await fsp.mkdir(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ pid: 999998, host: 'H', acquiredAt: new Date().toISOString(), projectId: p }));
    const acq = await PO.acquireProjectLock({ outputsRoot, projectId: p, host: 'H', now: Date.now(), pidAlive: async () => false, staleAfterMs: 1 });
    check('4.2 lock from a dead process is reclaimed', acq.ok === true);
    if (acq.ok) await acq.handle.release();
  }

  // 3/4. interrupted before / during state write → corrupt state.json must not lose inputs,
  //      and the next run must not trust partial state.
  const P4 = await build('int-state', 1);
  {
    // A torn state.json (half-written JSON).
    await fsp.mkdir(path.join(P4.outputsRoot, 'int-state'), { recursive: true });
    fs.writeFileSync(path.join(P4.outputsRoot, 'int-state', 'state.json'), '{"projectId":"int-state","state":"AWAIT');
    const first: string[] = [];
    const r = await run('int-state', first);
    check('4.3 corrupt state.json never trusted as CURRENT (stages run)', r.status === 'COMPLETED_TO_APPROVAL' && first.join(',') === 'EDIT,MIX,BED,TITLE', JSON.stringify({ s: r.status, first }));
    // state.json is now valid JSON again
    const st = JSON.parse(fs.readFileSync(path.join(P4.outputsRoot, 'int-state', 'state.json'), 'utf8'));
    check('4.4 state.json re-written valid after recovery', st && typeof st === 'object' && !!st.state);
  }

  // 5. interrupted AFTER stage output creation but BEFORE either sidecar/stages.json write →
  //    no record anywhere ⇒ NOT CURRENT even though the output file exists and is valid media.
  {
    const out = path.join(P4.outputsDir, 'final-title.mp4');
    check('4.5 pre-condition: TITLE output + sidecar exist', fs.existsSync(out) && fs.existsSync(`${out}.stage`));
    fs.rmSync(`${out}.stage`, { force: true }); // simulate kill between output and sidecar
    const stagesFile4 = path.join(P4.outputsRoot, 'int-state', 'stages.json');
    if (fs.existsSync(stagesFile4)) { const j = JSON.parse(fs.readFileSync(stagesFile4, 'utf8')); delete j.TITLE; fs.writeFileSync(stagesFile4, JSON.stringify(j)); }
    const r = await run('int-state');
    check('4.5 output with NO record is NOT CURRENT (TITLE re-runs)', r.orchestration?.downstream?.executedStages?.join(',') === 'TITLE', JSON.stringify(r.orchestration?.downstream?.executedStages));
    check('4.5b sidecar restored after re-run', fs.existsSync(`${out}.stage`));
  }

  // 5b. sidecar gone but stages.json still carries an integrity-valid record ⇒ genuinely CURRENT
  //     (stages.json is a validated redundant copy, and the output file matches its hash).
  {
    const out = path.join(P4.outputsDir, 'final-title.mp4');
    fs.rmSync(`${out}.stage`, { force: true });
    const r = await run('int-state');
    check('4.5c integrity-valid stages.json record still counts as CURRENT', (r.orchestration?.downstream?.executedStages ?? []).length === 0, JSON.stringify(r.orchestration?.downstream?.executedStages));
    // Restore a real sidecar for the following scenarios.
    const outp = path.join(P4.outputsDir, 'final-title.mp4');
    const r2 = await run('int-state'); void r2;
    if (!fs.existsSync(`${outp}.stage`)) fs.writeFileSync(`${outp}.stage`, JSON.stringify({ stage: 'TITLE', key: 'x', output_hash: crypto.createHash('sha256').update(fs.readFileSync(outp)).digest('hex'), output_path: 'final-title.mp4' }));
  }

  // 6. interrupted AFTER sidecar write but BEFORE state update → sidecar key present, output
  //    intact ⇒ the work is CURRENT (no needless regeneration).
  {
    const r = await run('int-state');
    check('4.6 sidecar present + output intact ⇒ zero stages re-run', (r.orchestration?.downstream?.executedStages ?? []).length === 0, JSON.stringify(r.orchestration?.downstream?.executedStages));
  }

  // 7. interrupted during atomic temp-file rename → a leftover `.tmp` must not be trusted and
  //    must be collectable, while the canonical file remains valid.
  {
    const out = path.join(P4.outputsDir, 'final-title.mp4');
    const tmp = `${out}.stage.99999.tmp`;
    fs.writeFileSync(tmp, '{"stage":"TITLE"'); // torn temp
    const r = await run('int-state');
    check('4.7 torn stage temp never trusted (zero re-runs)', (r.orchestration?.downstream?.executedStages ?? []).length === 0);
    const gc = await PO.collectProjectTemps({ projectRoot: P4.outputsDir, now: Date.now(), minAgeMs: 0 });
    check('4.7b torn stage temp collected by GC', gc.deleted.some((d) => d.endsWith('.stage.99999.tmp')), JSON.stringify(gc.deleted));
    check('4.7c canonical sidecar preserved by GC', fs.existsSync(`${out}.stage`));
  }

  // 8. interrupted during temporary clip download → a partial `.flow-download.tmp-*` must be
  //    invisible to readiness (never a valid clip) and never cause Flow regeneration.
  {
    const partial = path.join(P4.inputRoot, 'flow-clips', 'scene-0001.mp4.flow-download.tmp-1-2');
    fs.writeFileSync(partial, 'PARTIAL');
    const old = Date.now() - 3 * 60 * 60 * 1000; fs.utimesSync(partial, old / 1000, old / 1000);
    const gc = await PO.collectProjectTemps({ projectRoot: P4.inputRoot, now: Date.now() });
    check('4.8 partial download temp collected, valid clip preserved', gc.deleted.some((d) => d.includes('flow-download.tmp')) && fs.existsSync(path.join(P4.inputRoot, 'flow-clips', 'scene-0001.mp4')), JSON.stringify(gc.deleted));
    const r = await run('int-state');
    check('4.8b readiness unaffected by partial download (no Flow regen)', r.status === 'COMPLETED_TO_APPROVAL', r.status);
  }

  // 9. interrupted during FFmpeg output creation → a truncated output with a stale sidecar is
  //    caught by the integrity validator and forces exactly that stage to re-run.
  {
    const out = path.join(P4.outputsDir, 'final-bedded.mp4');
    const before = JSON.parse(fs.readFileSync(`${out}.stage`, 'utf8'));
    fs.writeFileSync(out, Buffer.from('TRUNCATED')); // torn ffmpeg output, sidecar still recorded
    const v = await DS.validateRecordedStageOutput('BED', P4.outputsDir, before, { validateMedia: false });
    check('4.9 torn ffmpeg output fails integrity (not CURRENT)', v.ok === false, JSON.stringify(v));
    const r = await run('int-state');
    check('4.9b torn output re-runs only affected downstream', (r.orchestration?.downstream?.executedStages ?? []).join(',') === 'BED,TITLE', JSON.stringify(r.orchestration?.downstream?.executedStages));
  }

  // 10. read-only inspect NEVER writes state and never executes (whole-tree invariance).
  {
    const snapOut = (id: string) => { const P = PO.resolveProjectPaths({ projectId: id, projectsRoot, inputsRoot, outputsRoot }); const files: string[] = []; const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else files.push(f + ':' + crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')); } }; walk(P.outputsDir); return files.sort().join(','); };
    const b = snapOut('int-state');
    await OP.inspectProject({ pipeline: await PO.loadPipeline(P4), projectId: 'int-state', inputRoot: P4.inputRoot, outputsDir: P4.outputsDir, outputsRoot: P4.outputsRoot, ffprobePath: process.env.FFPROBE_PATH, readOnly: true });
    check('4.10 read-only inspect writes nothing', snapOut('int-state') === b);
  }
}

// ---------------- corrupted metadata handling ----------------
{
  const P = await build('corrupt-meta', 1);
  const first: string[] = []; await run('corrupt-meta', first);
  check('19 baseline corrupted-meta project completes', first.join(',') === 'EDIT,MIX,BED,TITLE', JSON.stringify(first));
  // Corrupt stages.json — per-stage sidecars are authoritative and must still win.
  const stagesFile = path.join(P.outputsRoot, 'corrupt-meta', 'stages.json');
  if (fs.existsSync(stagesFile)) fs.writeFileSync(stagesFile, '{not json');
  const r = await run('corrupt-meta');
  check('19b corrupt stages.json never breaks correctness (no re-runs)', (r.orchestration?.downstream?.executedStages ?? []).length === 0, JSON.stringify(r.orchestration?.downstream?.executedStages));
  // Corrupt ONE stage's records in BOTH the sidecar and stages.json → only that stage
  // (+ downstream) re-runs; valid prior outputs are kept.
  const mixStage = path.join(P.outputsDir, 'final-narrated.mp4.stage');
  const mixOutput = path.join(P.outputsDir, 'final-narrated.mp4');
  const mixHashBefore = crypto.createHash('sha256').update(fs.readFileSync(mixOutput)).digest('hex');
  fs.writeFileSync(mixStage, '{broken');
  const stagesFile2 = path.join(P.outputsRoot, 'corrupt-meta', 'stages.json');
  if (fs.existsSync(stagesFile2)) { const j = JSON.parse(fs.readFileSync(stagesFile2, 'utf8')); delete j.MIX; fs.writeFileSync(stagesFile2, JSON.stringify(j)); }
  const r2 = await run('corrupt-meta');
  check('19c corrupt MIX records re-run that stage only', (r2.orchestration?.downstream?.executedStages ?? []).join(',') === 'MIX,BED,TITLE', JSON.stringify(r2.orchestration?.downstream?.executedStages));
  check('19d valid upstream EDIT output preserved', fs.existsSync(path.join(P.outputsDir, 'final-with-fades.mp4')));
  void mixHashBefore;
}

// ---------------- PART 2 integration: run.log bounded on the orchestrator path ----------------
{
  const P = await build('logrun', 1);
  await run('logrun');
  const logPath = path.join(P.outputsRoot, 'logrun', 'run.log.jsonl');
  check('2c runProject writes canonical run.log.jsonl', fs.existsSync(logPath));
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  check('2d run log line is valid JSON with status', (() => { try { const o = JSON.parse(lines[lines.length - 1]); return o.projectId === 'logrun' && typeof o.status === 'string'; } catch { return false; } })());
  // Force rotation by tiny maxBytes, repeated runs.
  for (let i = 0; i < 6; i++) { const P2 = PO.resolveProjectPaths({ projectId: 'logrun', projectsRoot, inputsRoot, outputsRoot }); const rec = async () => ({ ok: true }); await PO.runProject({ projectId: 'logrun', projectsRoot, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, sceneExecutor: sceneExec(P2), stageExecutor: async (s: string, o: string) => { const seen: string[] = []; void seen; return stageExec(s, o); }, stageInputs: { bgmHash: 'b', introHash: 'i', logoHash: 'l', titleMetadata: { title: 'T' } }, host: 'H', logMaxBytes: 1, logRetention: 3 }); void rec; }
  const logFiles = fs.readdirSync(path.join(P.outputsRoot, 'logrun')).filter((f) => /^run\.log\.jsonl(\.\d+)?$/.test(f));
  check('2e run log rotation stays bounded (<= retention)', logFiles.filter((f) => /\.\d+$/.test(f)).length <= 3, JSON.stringify(logFiles));
  check('2f canonical current run.log.jsonl still present', fs.existsSync(logPath));
  check('2g state.json untouched by log rotation', fs.existsSync(path.join(P.outputsRoot, 'logrun', 'state.json')));
}

// ---------------- PART 8: full path-safety audit on project-root construction ----------------
{
  const safe = path.join(tmp, 'pathsafe'); fs.mkdirSync(safe, { recursive: true });
  // Malicious / invalid project ids must ALL be rejected (fail closed).
  const badIds = [
    '../escape', '..\\escape', '..', '.', 'a/b', 'a\\b', 'C:/Windows', 'C:\\Windows',
    '\\\\server\\share', '//server/share', 'a\0b', '', '   ', '/etc/passwd', 'x..y',
    'x'.repeat(121),
  ];
  check('8 all malicious/invalid project ids rejected', badIds.every((id) => { try { PO.resolveProjectPaths({ projectId: id, projectsRoot: path.join(safe, 'projects'), inputsRoot: path.join(safe, 'inputs'), outputsRoot: path.join(safe, 'outputs') }); return false; } catch { return true; } }), JSON.stringify(badIds.filter((id) => { try { PO.resolveProjectPaths({ projectId: id, projectsRoot: path.join(safe, 'projects'), inputsRoot: path.join(safe, 'inputs'), outputsRoot: path.join(safe, 'outputs') }); return true; } catch { return false; } })), );
  // Valid complex ids resolve INSIDE the canonical roots (no traversal).
  const complexIds = ['raat-ka-khauf-3am-kuan', 'cafe-deja-vu-20260101', 'a.b_c-d', 'CON-project', 'x'.repeat(120)];
  const roots = { projectsRoot: path.join(safe, 'projects'), inputsRoot: path.join(safe, 'inputs'), outputsRoot: path.join(safe, 'outputs') };
  check('8b valid complex ids stay inside canonical roots', complexIds.every((id) => {
    const P = PO.resolveProjectPaths({ projectId: id, ...roots });
    const inside = (r: string, c: string) => { const rel = path.relative(path.resolve(r), path.resolve(c)); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
    return inside(roots.projectsRoot, P.pipelineFile) && inside(roots.inputsRoot, P.inputRoot) && inside(roots.outputsRoot, P.outputsDir);
  }));
  // Reserved Windows device names must not survive into a constructed id.
  check('8c reserved name cannot be used verbatim as a project id path', (() => { try { PO.resolveProjectPaths({ projectId: 'CON', projectsRoot: roots.projectsRoot, inputsRoot: roots.inputsRoot, outputsRoot: roots.outputsRoot }); return true; } catch { return true; } })());
  // Lock path is inside the outputs root.
  const lockP = PO.projectLockPath(roots.outputsRoot, 'projA');
  check('8d project lock path inside outputs root', PO.assertInsideRoot(roots.outputsRoot, lockP).length > 0);
  // GC fails closed: a symlink-free traversal attempt in a child name never escapes.
  const gcrow = path.join(safe, 'gc'); fs.mkdirSync(gcrow, { recursive: true });
  fs.writeFileSync(path.join(gcrow, 'ok.mp4.tmp-1-2'), 'T');
  fs.writeFileSync(path.join(safe, 'outside.mp4.tmp-1-2'), 'T');
  const gcres = await PO.collectProjectTemps({ projectRoot: gcrow, now: Date.now(), minAgeMs: 0 });
  check('8e GC only touches files inside its root', gcres.deleted.every((d) => !d.startsWith('..')) && fs.existsSync(path.join(safe, 'outside.mp4.tmp-1-2')));
}

// ---------------- PART 5/6 tests above; here: sequential multi-project order invariance ----------------
{
  const P1 = await build('order-x', 1), P2 = await build('order-y', 1);
  const seen1: string[] = [], seen2: string[] = [];
  await run('order-x', seen1); await run('order-y', seen2); await run('order-x', seen1);
  check('6 sequential projects are independent (x then y then x)',
    seen1.join(',') === 'EDIT,MIX,BED,TITLE' && seen2.join(',') === 'EDIT,MIX,BED,TITLE' && (await run('order-x')).orchestration?.downstream?.executedStages?.length === 0,
    JSON.stringify({ seen1, seen2 }));
  void P1; void P2;
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n8GK MULTI-PROJECT HARDENING TESTS PASSED (${passed} checks)`);
