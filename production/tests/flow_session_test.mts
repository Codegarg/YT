// Offline focused tests for STEP-8GO Flow session lifecycle. No Chrome/Flow/OpenAI/network.
// Isolated temp projects only; the real project is never touched.
import fs from 'node:fs'; import fsp from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
import zlib from 'node:zlib'; import crypto from 'node:crypto'; import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
import { SRC } from './_testPaths.mjs';
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
const FSE = await import(pathToFileURL(`${SRC}/flowSession.ts`).href);
const WF = await import(pathToFileURL(`${SRC}/projectWorkflow.ts`).href);
const PO = await import(pathToFileURL(`${SRC}/projectOrchestrator.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8go-'));
const projectsRoot = path.join(tmp, 'projects'), inputsRoot = path.join(tmp, 'inputs'), outputsRoot = path.join(tmp, 'outputs'), lockRoot = path.join(tmp, 'lockroot');
for (const d of [projectsRoot, inputsRoot, outputsRoot, lockRoot]) fs.mkdirSync(d, { recursive: true });

// ---------- helpers ----------
function makePng(w, h, ct = 6, tag = 0) { const T = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; } const crc = (b) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }; const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); }; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct; const ch = ct === 6 ? 4 : 2; const raw = Buffer.alloc(h * (1 + w * ch), 0x80); for (let y = 0; y < h; y++) raw[y * (1 + w * ch)] = 0; raw[11] = tag & 0xff; return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }
async function makeClip(dest, freq = 300) { fs.mkdirSync(path.dirname(dest), { recursive: true }); await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=1:sample_rate=24000`, '-f', 'lavfi', '-i', 'color=c=0x203040:s=640x360:d=1', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', dest]); }

/** A fake `start()` lifecycle: records close calls, no Playwright. */
function fakeStart(overrides: any = {}) {
  const rec = { created: 0, closed: 0 };
  const start = async (url: string, userDataDir: string) => {
    rec.created++;
    if (overrides.throwOnStart) throw new Error('browser launch failed');
    const client = { kind: 'fake-flow-client', url, userDataDir };
    return {
      context: { async close() { rec.closed++; if (overrides.throwOnClose) throw new Error('close failed'); } },
      page: {},
      flow: client,
    };
  };
  return { start, rec };
}

// ================== 1/2/3/4: session factory contract + success + close ==================
{
  const { start, rec } = fakeStart();
  const session = await FSE.createRealFlowSession({ userDataDir: path.join(tmp, 'profile'), start });
  check('1 session factory returns {client, close}', typeof session.client === 'object' && typeof session.close === 'function');
  check('2 session creation succeeds', session.client.kind === 'fake-flow-client');
  check('3 client is exposed to the consumer', session.client.userDataDir === path.join(tmp, 'profile'));
  await session.close();
  check('4 close called on successful use', rec.closed === 1 && rec.created === 1);
  await session.close();
  check('4b close is idempotent (never closes twice)', rec.closed === 1);
}

// ================== 5/6/7/8: withFlowSession cleanup + failure ==================
{
  // 5: close after consumer failure (consumer returns a failure value, not a throw).
  const { start, rec } = fakeStart();
  const r = await FSE.withFlowSession({ lockRoot, userDataDir: path.join(tmp, 'p5'), start }, async () => { throw new Error('consumer boom'); });
  check('5 close called after consumer failure', rec.closed === 1 && r.ok === false && /consumer boom/.test(String(r.reason)), JSON.stringify({ r, rec }));
  check('8 no leaked session after failure (lock released)', !fs.existsSync(PO.flowSessionLockPath(lockRoot)));
  // 6: close after session/use exception (thrown).
  const { start: s6, rec: r6 } = fakeStart();
  const r6res = await FSE.withFlowSession({ lockRoot, userDataDir: path.join(tmp, 'p6'), start: s6 }, async () => { throw new Error('thrown'); });
  check('6 close called after thrown exception', r6.closed === 1 && r6res.ok === false, JSON.stringify(r6res));
  check('6b lock released after thrown exception', !fs.existsSync(PO.flowSessionLockPath(lockRoot)));
  // 7: session creation failure propagates; no session, lock released.
  const { start: s7, rec: r7 } = fakeStart({ throwOnStart: true });
  const r7res = await FSE.withFlowSession({ lockRoot, userDataDir: path.join(tmp, 'p7'), start: s7 }, async () => 'unreached');
  check('7 session creation failure propagates (fail closed)', r7res.ok === false && /creation failed/.test(String(r7res.reason)) && r7.created === 1 && r7.closed === 0, JSON.stringify({ r7res, r7 }));
  check('7b no leaked lock after creation failure', !fs.existsSync(PO.flowSessionLockPath(lockRoot)));
  // 25: close failure surfaced safely without masking the primary failure.
  const { start: s25 } = fakeStart({ throwOnClose: true });
  const r25primary = await FSE.withFlowSession({ lockRoot, userDataDir: path.join(tmp, 'p25'), start: s25 }, async () => { throw new Error('primary error'); });
  check('25 close failure never masks the primary failure', /primary error/.test(String(r25primary.reason)) && !/close failed/.test(String(r25primary.reason)), JSON.stringify(r25primary));
  const { start: s25b } = fakeStart({ throwOnClose: true });
  const r25b = await FSE.withFlowSession({ lockRoot, userDataDir: path.join(tmp, 'p25b'), start: s25b }, async () => 'ok');
  check('25b close failure surfaced when consumer succeeded', r25b.ok === false && /close failed/.test(String(r25b.reason)), JSON.stringify(r25b));
}

// ================== 9/10: single Flow session lock ==================
{
  const { start } = fakeStart();
  // Hold the lock externally → session creation must NOT proceed (single owner, no override).
  const held = await PO.acquireFlowSessionLock({ lockRoot, host: 'local', pidAlive: async () => true });
  check('9 the existing Flow session lock is used', held.ok === true);
  const { start: sBlocked, rec: rBlocked } = fakeStart();
  const blocked = await FSE.withFlowSession({ lockRoot, userDataDir: path.join(tmp, 'pblocked'), start: sBlocked }, async () => 'x');
  check('9b contended lock blocks session creation (no bypass)', blocked.ok === false && rBlocked.created === 0, JSON.stringify({ blocked, rBlocked }));
  if (held.ok) await held.release();
  check('10 no second lock file is created', fs.readdirSync(lockRoot).filter((f) => /lock/.test(f)).length === 0);
  // A normal session uses the SAME lock path (never a parallel one).
  const r = await FSE.withFlowSession({ lockRoot, userDataDir: path.join(tmp, 'p9'), start }, async () => 'ok');
  check('10b withFlowSession uses the existing lock (released after)', r.ok === true && !fs.existsSync(PO.flowSessionLockPath(lockRoot)));
}

// ================== 11/12: project isolation ==================
{
  // The session boundary itself carries no project data. Project isolation is enforced by the
  // SceneExecutor adapter (8GN) — prove it still fails closed for a mismatched project.
  const SEA = await import(pathToFileURL(`${SRC}/sceneExecutorAdapter.ts`).href);
  const ex = SEA.createRealSceneExecutor({ projectId: 'proj-A', inputRoot: path.join(inputsRoot, 'proj-A'), outputsRoot, pipeline: { scenes: [{ scene_number: 1 }] }, flow: { async sceneHasClip() { return false; } } });
  const bad = await ex({ sceneNumber: 1 }, path.join(outputsRoot, 'proj-A', 'scene-0001.mp4'), { projectId: 'proj-B' });
  check('11/12 project A session cannot receive project B pipeline (fails closed)', bad.ok === false && /mismatch/.test(String(bad.reason)), JSON.stringify(bad));
}

// ================== 13/14/15/16: workflow integration + session injection ==================
{
  // Build a project whose ONLY blocker is a missing Flow clip (dialogue scene).
  const id = 'wf';
  const pdir = path.join(projectsRoot, id); fs.mkdirSync(pdir, { recursive: true });
  const p = {
    project_id: id, style_reference: {}, flow_project_name: 'x',
    characters: [{ tag: '@CHAR-01-ARJUN', name: 'Arjun', look_summary: 'x', full_prompt: 'x', voice_description: 'x', status: 'pending' }],
    backgrounds: [{ tag: '#BGD-01-TEMPLE', location_name: 't', look_summary: 'x', full_prompt: 'x', status: 'pending' }],
    scenes: [{ scene_number: 1, title: 'S1', background_tag: '#BGD-01-TEMPLE', character_tags: ['@CHAR-01-ARJUN'], speaker: '@CHAR-01-ARJUN', camera: 'wide', effects: '', sound_design: '', visual_action: 'a1', narration_text: '', animation_prompt_NARRATOR_ONLY: 'p', animation_prompt_WITH_lipsync: 'p', status: 'pending' }],
  };
  fs.writeFileSync(path.join(pdir, 'pipeline.json'), JSON.stringify(p, null, 2));
  const inp = path.join(inputsRoot, id); fs.mkdirSync(path.join(inp, 'flow-clips'), { recursive: true });
  fs.mkdirSync(path.join(outputsRoot, id), { recursive: true });
  fs.mkdirSync(path.join(inp, 'backgrounds'), { recursive: true });
  fs.writeFileSync(path.join(inp, 'backgrounds', 'BGD-01-TEMPLE.png'), makePng(1920, 1080, 2, 1));
  fs.mkdirSync(path.join(inp, 'characters'), { recursive: true });
  fs.writeFileSync(path.join(inp, 'characters', 'CHAR-01-ARJUN.png'), makePng(1024, 1024, 6, 1));
  fs.mkdirSync(path.join(inp, 'music'), { recursive: true });
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=10:sample_rate=44100', '-ac', '2', '-b:a', '96k', path.join(inp, 'music', 'background-music.mp3')]);
  fs.writeFileSync(path.join(inp, 'music', 'background-music.license.json'), JSON.stringify({ license: 'CC0' }));
  // Canonical branding inputs so this fixture's ONLY blocker stays the missing Flow clip for
  // scene 1 (branding is a project-level required asset; without it the run reports two
  // blocker categories and the phase becomes INPUTS_REQUIRED instead of FLOW_REQUIRED).
  fs.mkdirSync(path.join(inp, 'branding'), { recursive: true });
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'color=c=0x101020:s=1280x720:d=2', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(inp, 'branding', 'channel-intro.mp4')]);
  fs.writeFileSync(path.join(inp, 'branding', 'channel-logo.png'), makePng(256, 256, 6, 3));
  // NOTE: flow-clips stays empty on purpose — the missing Flow clip is the blocker under test.

  const base = { projectsRoot, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, stageExecutorFactory: () => async () => ({ ok: true }) };

  // 13: status creates zero sessions.
  let sessionCalls = 0;
  const spySession = (fn: any) => { sessionCalls++; return fn({ client: { kind: 'fake' }, close: async () => {} }); };
  await WF.projectWorkflowStatus({ ...base, projectId: id, flowSessionRunner: spySession });
  check('13 status creates zero sessions', sessionCalls === 0, String(sessionCalls));

  // 14: resume without --run-flow creates zero sessions.
  const r14 = await WF.resumeProjectWorkflow({ ...base, projectId: id, flowSessionRunner: spySession, runFlow: false });
  check('14 resume without --run-flow creates zero sessions', sessionCalls === 0, JSON.stringify({ sessionCalls, phase: r14.phase }));
  check('14b resume without --run-flow still reports FLOW_REQUIRED', r14.phase === 'FLOW_REQUIRED', r14.phase);

  // 15/16: resume with --run-flow + fake session → exactly one session, client reaches the
  // SceneExecutor, and production runs inside the session.
  let injectedClient: any = null; let closeCount = 0;
  const fakeSessionRunner = async (fn: any) => {
    sessionCalls++;
    const session = { client: { kind: 'session-client' }, close: async () => { closeCount++; } };
    try { const value = await fn(session); return { ok: true, value }; }
    catch (e: any) { return { ok: false, reason: String(e?.message ?? e) }; }
    finally { await session.close(); }
  };
  // A scene executor factory that records the injected client.
  const sceneFactory = (input: any) => { injectedClient = input.flow; return async () => ({ ok: true }); };
  const r15 = await WF.resumeProjectWorkflow({ ...base, projectId: id, flowSessionRunner: fakeSessionRunner, sceneExecutorFactory: sceneFactory, runFlow: true });
  check('15 resume with --run-flow injects the fake session exactly once', sessionCalls === 1 && closeCount === 1, JSON.stringify({ sessionCalls, closeCount, r15: r15.phase }));
  check('16 SceneExecutor receives the injected session client', injectedClient?.kind === 'session-client', JSON.stringify(injectedClient));
  check('15b no FlowRunner was invoked on the session path (single strategy)', r15.flow === undefined, JSON.stringify(r15.flow));

  // 22: session factory remains injectable (already proven by the above); and withFlowSession is
  // exported and reusable.
  check('22 flowSession boundary remains injectable', typeof FSE.withFlowSession === 'function' && typeof FSE.createRealFlowSession === 'function');
}

// ================== 23/24: fake session simulates client/close failure ==================
{
  const r23 = await FSE.withFlowSession({ lockRoot, userDataDir: path.join(tmp, 'p23'), start: fakeStart({ throwOnStart: true }).start }, async () => 'x');
  check('23 fake session can simulate client failure', r23.ok === false && /creation failed/.test(String(r23.reason)));
  const r24 = await FSE.withFlowSession({ lockRoot, userDataDir: path.join(tmp, 'p24'), start: fakeStart({ throwOnClose: true }).start }, async () => 'x');
  check('24 fake session can simulate close failure', r24.ok === false && /close failed/.test(String(r24.reason)));
}

// ================== 17/18/19/20/21: no duplicated logic; deterministic cleanup ==================
{
  const codeOnly = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const session = codeOnly('flowSession.ts');
  const adapter = codeOnly('sceneExecutorAdapter.ts');
  // 17: the session does not reimplement the scene delegation (it lives in the adapter).
  check('17 existing SceneExecutor delegation remains unchanged (session has no scene logic)', !/processSingleFlowScene/.test(session));
  // 18: no generation policy duplicated in the session.
  check('18 no generation policy duplicated in the session', !/decideSceneAction|generateProjectVideo|allowGeneration\s*[:=]\s*true/.test(session));
  // 19: no checkpoint logic duplicated.
  // The session must not touch checkpoints at all — `flowSession.ts` lists the checkpoint schema as
  // an explicit non-responsibility, and today it contains none of these identifiers. The adapter is
  // different: `sceneCheckpointPath`/`readSceneCheckpoint`/`priorCheckpoint` ARE its role (it reads a
  // prior checkpoint), so prohibiting them there could never pass and was not a meaningful guard.
  // What the adapter must not do is WRITE a checkpoint — `writeSceneCheckpoint` is owned by
  // sceneFlowWorkflow.ts. Both operands are comment-stripped by `codeOnly`, and the prohibited set is
  // concrete identifiers rather than the bare word, so prose mentioning the checkpoint schema in a
  // docstring cannot trip this.
  const CHECKPOINT_IDS = /writeSceneCheckpoint|sceneCheckpointPath|readSceneCheckpoint|priorCheckpoint/;
  check('19 no checkpoint logic duplicated', !CHECKPOINT_IDS.test(session) && !/writeSceneCheckpoint/.test(adapter));
  // 20: no retry logic duplicated.
  check('20 no retry logic duplicated', !/setTimeout|backoff|retryCount|retry\s*\(|sleep\s*\(/i.test(session));
  // 18b: no second FlowClient / browser launcher.
  check('18b no second FlowClient or browser launcher', !/class\s+FlowClient|launchPersistentContext|chromium/.test(session));
  // 18c: session reuses the existing start() lifecycle.
  check('18c session reuses the existing start() lifecycle', /import\('\.\/flowClient\.js'\)/.test(session) && /mod\.start\(/.test(session));
  // 21: deterministic cleanup — 5 sequential runs, each closes exactly once.
  let closes = 0;
  for (let i = 0; i < 5; i++) {
    const { start, rec } = fakeStart();
    const r = await FSE.withFlowSession({ lockRoot, userDataDir: path.join(tmp, `det${i}`), start }, async () => 'ok');
    if (r.ok) closes += rec.closed;
  }
  check('21 deterministic cleanup across repeated sessions', closes === 5 && !fs.existsSync(PO.flowSessionLockPath(lockRoot)));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n8GO FLOW SESSION LIFECYCLE TESTS PASSED (${passed} checks)`);
