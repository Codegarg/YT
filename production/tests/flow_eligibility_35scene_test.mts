// STEP-8HE — 35-scene Flow-eligibility / work-set regression (offline, fakes only).
// Mirrors the canonical 35-scene shape using SYNTHETIC backgrounds and scene clips.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import zlib from 'node:zlib'; import crypto from 'node:crypto'; import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import { pathToFileURL } from 'node:url';
import { writeFixtureBackgrounds, createFixtureClipBank, installFixtureClips } from './helpers/isolatedFixtures.mts';
const exec = promisify(execFile);
import { SRC } from './_testPaths.mjs';
import { REPO } from './_testPaths.mjs';
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
const WF = await import(pathToFileURL(`${SRC}/projectWorkflow.ts`).href);
const SS = await import(pathToFileURL(`${SRC}/sceneState.ts`).href);
const CI = await import(pathToFileURL(`${SRC}/checkInputs.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };
function makePng(w: number, h: number, ct = 6, tag = 0) { const T: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; } const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }; const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); }; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct; const ch = ct === 6 ? 4 : 2; const raw = Buffer.alloc(h * (1 + w * ch), 0x80); for (let y = 0; y < h; y++) raw[y * (1 + w * ch)] = 0; raw[11] = tag & 0xff; return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }
const wav = (f: string, sec: number, tag = 0) => { const n = Math.round(sec * 8000); const d = Buffer.alloc(n * 2, tag); const b = Buffer.alloc(44 + d.length); b.write('RIFF', 0); b.writeUInt32LE(36 + d.length, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(d.length, 40); d.copy(b, 44); fs.writeFileSync(f, b); };
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const shaOrNull = (f: string) => fs.existsSync(f) ? sha(f) : null;
const mkClip = async (o: string) => { fs.mkdirSync(path.dirname(o), { recursive: true }); await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=640x360:d=2', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', o]); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8he-'));
const id = 'he35';
const projectsRoot = path.join(tmp, 'projects'), inputsRoot = path.join(tmp, 'inputs'), outputsRoot = path.join(tmp, 'outputs');
const projectDir = path.join(projectsRoot, id), inputRoot = path.join(inputsRoot, id), outputsDir = path.join(outputsRoot, id);
for (const d of [projectDir, inputRoot, outputsDir, path.join(inputRoot, 'flow-clips'), path.join(inputRoot, 'backgrounds'), path.join(inputRoot, 'characters'), path.join(inputRoot, 'narration'), path.join(inputRoot, 'music'), path.join(inputRoot, 'branding'), path.join(outputsDir, 'narration')]) fs.mkdirSync(d, { recursive: true });
// Synthetic backgrounds + one valid character cutout.
writeFixtureBackgrounds(inputRoot);
fs.writeFileSync(path.join(inputRoot, 'characters', 'CHAR-01-ARJUN.png'), makePng(1024, 1024, 6, 1));
const bgm = path.join(inputRoot, 'music', 'background-music.mp3'); await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=8', '-c:a', 'libmp3lame', bgm]);
fs.writeFileSync(path.join(inputRoot, 'music', 'background-music.license.json'), JSON.stringify({ license: 'CC0' }));
const intro = path.join(inputRoot, 'branding', 'channel-intro.mp4'); await mkClip(intro);
const logo = path.join(inputRoot, 'branding', 'channel-logo.png'); fs.writeFileSync(logo, makePng(256, 256, 6, 3));
// 35 scenes: 1–14 NARRATOR with local clips (NOT Flow work); 15–33 DIALOGUE, clip-less
// (20 = RECOVER, the rest GENERATE); 34–35 NARRATOR, clip-less (GENERATE under STRICT —
// narration kind never exempts a clip-less scene from Flow).
const scenes: any[] = [];
for (let n = 1; n <= 35; n++) {
  if (n <= 14) scenes.push({ scene_number: n, title: `S${n}`, background_tag: '#BGD-01-VILLAGE-STREET-WIDE', character_tags: [], speaker: 'NARRATOR', camera: 'w', effects: '', sound_design: '', visual_action: `a${n}`, narration_text: 'न', animation_prompt_NARRATOR_ONLY: 'p', animation_prompt_WITH_LIPSYNC: 'p', status: 'pending' });
  else if (n <= 33) scenes.push({ scene_number: n, title: `S${n}`, background_tag: '#BGD-01-VILLAGE-STREET-WIDE', character_tags: ['@CHAR-01-ARJUN'], speaker: '@CHAR-01-ARJUN', camera: 'w', effects: '', sound_design: '', visual_action: `a${n}`, narration_text: '', animation_prompt_NARRATOR_ONLY: 'p', animation_prompt_WITH_LIPSYNC: 'p', status: 'pending', ...(n === 20 ? { flow_scene_id: '00000000-0000-4000-8000-000000000020' } : {}) });
  else scenes.push({ scene_number: n, title: `S${n}`, background_tag: '#BGD-01-VILLAGE-STREET-WIDE', character_tags: [], speaker: 'NARRATOR', camera: 'w', effects: '', sound_design: '', visual_action: `a${n}`, narration_text: 'न', animation_prompt_NARRATOR_ONLY: 'p', animation_prompt_WITH_LIPSYNC: 'p', status: 'pending' });
}
fs.writeFileSync(path.join(projectDir, 'pipeline.json'), JSON.stringify({ project_id: id, flow_project_name: 'HE35', characters: [{ tag: '@CHAR-01-ARJUN', name: 'Arjun', look_summary: 'x', full_prompt: 'x', voice_description: 'x' }], backgrounds: [{ tag: '#BGD-01-VILLAGE-STREET-WIDE', location_name: 'x', look_summary: 'x', full_prompt: 'x' }], scenes }, null, 2));
const pipeline = JSON.parse(fs.readFileSync(path.join(projectDir, 'pipeline.json'), 'utf8'));
installFixtureClips(inputRoot, await createFixtureClipBank(path.join(tmp, 'clip-bank'), 14));
for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 34, 35]) { const nm = `narration-${String(n).padStart(4, '0')}.wav`; wav(path.join(inputRoot, 'narration', nm), 3, n & 0xff); fs.copyFileSync(path.join(inputRoot, 'narration', nm), path.join(outputsDir, 'narration', nm)); }
const projectFile = path.join(projectDir, 'pipeline.json');

// ================== TASK 1/2: eligibility + workset matrix from authoritative diagnostics ==================
{
  const diag = await CI.checkInputs({ pipeline, inputsRoot, projectId: id, outputsDir, ffprobePath: process.env.FFPROBE_PATH });
  const verdict = new Map<number, string>();
  for (const d of diag.scenes as any[]) verdict.set(Number(d.sceneNumber), SS.classifyFlowEligibility(d).action);
  const generate = [...verdict].filter(([, a]) => a === 'GENERATE').map(([n]) => n).sort((a, b) => a - b);
  const recover = [...verdict].filter(([, a]) => a === 'RECOVER').map(([n]) => n).sort((a, b) => a - b);
  const none = [...verdict].filter(([, a]) => a === 'NONE').map(([n]) => n).sort((a, b) => a - b);
  check('T1 scenes 1–14 have valid local clips and are NOT Flow-eligible', none.filter((n) => n <= 14).length === 14 && !generate.some((n) => n <= 14) && !recover.some((n) => n <= 14), JSON.stringify({ generate, recover }));
  // STRICT universal policy (sceneState.ts:306 + :449-451): EVERY clip-less scene is Flow work
  // regardless of narration kind. NARRATOR_ONLY, DIALOGUE, MIXED and background-only scenes all
  // classify GENERATE once their non-Flow prerequisites are valid and no local clip exists --
  // narration kind is deliberately NOT part of the GENERATE decision. The LOCAL_SYNTHESIS escape
  // (:457) requires the explicit ALLOW_LOCAL dev opt-in, which checkInputs never requests.
  const expectedGenerate = Array.from({ length: 21 }, (_, i) => i + 15).filter((n) => n !== 20).join(',');
  check('T1 GENERATE set = 15..35 except the RECOVER scene 20 (STRICT universal policy)', generate.join(',') === expectedGenerate, JSON.stringify(generate));
  check('T1 RECOVER set = {20} (flow-committed, local missing)', recover.join(',') === '20', JSON.stringify(recover));
  check('T1 scenes 34–35 (narrator-only, clip-less) ARE GENERATE under STRICT', generate.includes(34) && generate.includes(35) && !recover.includes(34) && !recover.includes(35), JSON.stringify({ generate, recover }));
  // Only the 14 scenes that actually hold a valid local clip escape Flow work; there is no
  // "local synthesis" NONE bucket left under STRICT.
  check('T1 NONE is exactly the 14 locally-clipped scenes (no local-synthesis escape)', none.length === 14 && none.every((n) => n <= 14), JSON.stringify({ none }));
}

// ================== TASK 3: isolated modern Flow-enabled run (fakes) ==================
function fakeSession(log: any) { return async (fn: any) => { log.sessions++; const s = { client: { kind: 'session' }, close: async () => { log.closes++; } }; try { return { ok: true, value: await fn(s) }; } catch (e: any) { return { ok: false, reason: String(e?.message ?? e) }; } finally { await s.close(); } }; }
function fakeGen(log: any, copyLocalOnly = false) { return (input: any) => async (scene: any, outputPath: string) => { const n = Number(scene?.sceneNumber ?? scene?.scene_number); log.sceneCalls.push(n); const inputClip = path.join(input.inputRoot, 'flow-clips', `scene-${String(n).padStart(4, '0')}.mp4`); await mkClip(inputClip); await mkClip(outputPath); return { ok: true }; }; }
const base = () => ({ projectsRoot, inputsRoot, outputsRoot, projectId: id, ffprobePath: process.env.FFPROBE_PATH, titleAssets: { intro, logo, title: 'HE35' }, bgmPath: bgm, stageInputs: { bgmHash: shaOrNull(bgm), introHash: shaOrNull(intro), logoHash: shaOrNull(logo), titleMetadata: { title: 'HE35' } }, stageExecutorFactory: () => async (_s: string, out: string) => { await mkClip(out); return { ok: true }; } });

let firstRunSceneCalls: number[] = [];
{
  const log: any = { sessions: 0, closes: 0, sceneCalls: [], runner: 0 };
  const r = await WF.resumeProjectWorkflow({ ...base(), runFlow: true, flowSessionRunner: fakeSession(log), sceneExecutorFactory: fakeGen(log), flowRunner: async () => { log.runner++; return { ok: true }; } } as any);
  firstRunSceneCalls = [...log.sceneCalls].sort((a, b) => a - b);
  check('T3 exactly one modern session', log.sessions === 1 && log.closes === 1, JSON.stringify({ sessions: log.sessions }));
  // Every clip-less scene (15..35, RECOVER included) is dispatched through the Flow scene executor.
  check('T3 Flow-eligible scenes 15–35 reached SceneExecutor', firstRunSceneCalls.join(',') === Array.from({ length: 21 }, (_, i) => i + 15).join(','), JSON.stringify(firstRunSceneCalls));
  check('T3 scenes 1–14 NOT regenerated in the Flow run', !firstRunSceneCalls.some((n) => n <= 14), JSON.stringify(firstRunSceneCalls));
  check('T3 narration-only 34–35 ARE dispatched to Flow (no local-synthesis escape under STRICT)', firstRunSceneCalls.includes(34) && firstRunSceneCalls.includes(35), JSON.stringify(firstRunSceneCalls));
  check('T3 no legacy FlowRunner', log.runner === 0);
  check('T3 downstream stages blocked (not all scene outputs exist)', ['EDIT', 'MIX', 'BED', 'TITLE'].every((s) => (r.production?.orchestration?.downstream?.states?.[s] ?? 'X') !== 'CURRENT'), JSON.stringify(r.production?.orchestration?.downstream?.states));
  check('T3 partial status reported (Flow work executed)', r.status === 'FLOW_WORK_COMPLETED_WITH_BLOCKERS' && r.phase === 'FLOW_WORK_COMPLETED_WITH_BLOCKERS', JSON.stringify({ s: r.status }));
  check('T3 not falsely COMPLETED / approved', r.status !== 'COMPLETED_TO_APPROVAL' && !fs.existsSync(path.join(outputsDir, 'approval.json')));
}

// ================== TASK 3B/4: reconciliation run picks up postponed READY work; then stable ==================
{
  // After the Flow run, the flow-eligible scenes have downloaded clips. A subsequent run must
  // (a) reconcile the one-time render-key change, (b) process the postponed READY scenes 1–14,
  // and (c) then be stable (no re-execution of 15–33, no unnecessary Flow work, no session).
  const logStab: any = { sessions: 0, closes: 0, sceneCalls: [], runner: 0 };
  await WF.resumeProjectWorkflow({ ...base(), runFlow: true, flowSessionRunner: fakeSession(logStab), sceneExecutorFactory: fakeGen(logStab) } as any);
  check('T4 postponed READY scenes 1–14 are processed on the next run (no stuck state)', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].every((n) => logStab.sceneCalls.includes(n)), JSON.stringify(logStab.sceneCalls));
  const log: any = { sessions: 0, closes: 0, sceneCalls: [], runner: 0 };
  const r = await WF.resumeProjectWorkflow({ ...base(), runFlow: true, flowSessionRunner: fakeSession(log), sceneExecutorFactory: fakeGen(log) } as any);
  check('T3B stabilized run does NOT re-execute any Flow scene 15–35 (CURRENT reused)', !log.sceneCalls.some((n: number) => n >= 15), JSON.stringify(log.sceneCalls));
  check('T4 stabilized run opens at most one session and no legacy runner', log.sessions <= 1 && log.runner === 0, JSON.stringify({ sessions: log.sessions, runner: log.runner }));
  check('T4 stabilized run does not falsely remain partial', r.status !== 'FLOW_WORK_COMPLETED_WITH_BLOCKERS', JSON.stringify({ s: r.status, p: r.phase }));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n8HE 35-SCENE FLOW ELIGIBILITY TESTS PASSED (${passed} checks)`);
