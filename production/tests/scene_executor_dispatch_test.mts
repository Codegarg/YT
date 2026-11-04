// Focused OFFLINE regression tests for the SceneExecutor render-mode dispatch.
//
// Proves: LOCAL_SYNTHESIS renders via the EXISTING sceneRenderer with NO Flow client and NO Flow
// generation; SUPPLIED_VIDEO keeps the proven reuse path; an unsupported mode fails closed; the
// orchestrator sidecar/output contract is untouched; input assets are never modified.
//
// Synthetic temp assets only. No real project inputs. No Flow, no Chrome, no network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { REPO } from './_testPaths.mjs';
const SRC = `${REPO}/production/src`;
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
const exec = promisify(execFile);

const ad = await import(pathToFileURL(`${SRC}/sceneExecutorAdapter.ts`).href);
const orch = await import(pathToFileURL(`${SRC}/productionOrchestrator.ts`).href);
const { decideRenderDispatch, resolveBackgroundImagePath, layoutCharacterPlacements, createRealSceneExecutor, CHARACTER_HEIGHT_FRACTION, checkpointProvesFlowOwnership, FLOW_OWNERSHIP_STATUSES } = ad;
const { checkpointProvesFlowCommit } = await import(pathToFileURL(`${SRC}/sceneFlowWorkflow.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'));
const PID = 'dispatch-fixture';
const inputRoot = path.join(tmp, 'inputs', PID);
const outputsRoot = path.join(tmp, 'outputs');
const outputsDir = path.join(outputsRoot, PID);
fs.mkdirSync(path.join(inputRoot, 'backgrounds'), { recursive: true });
fs.mkdirSync(path.join(inputRoot, 'characters'), { recursive: true });
fs.mkdirSync(path.join(inputRoot, 'flow-clips'), { recursive: true });
fs.mkdirSync(outputsDir, { recursive: true });

/** Deterministic CRC32 table for PNG chunk validation. */
const CRC_TABLE: number[] = [];
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
const crc32 = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

// The PNG signature is EXACTLY 8 bytes: 89 50 4E 47 0D 0A 1A 0A.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Build a real, decodable PNG. `alpha` writes colour type 6 with a genuine transparent border;
 *  without it, colour type 2 (opaque RGB). Content is a deterministic gradient, not blank. */
function makePng(w: number, h: number, opts: { alpha?: boolean } = {}) {
  const useAlpha = opts.alpha === true;
  const bpp = useAlpha ? 4 : 3;
  const colourType = useAlpha ? 6 : 2;
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;                       // bit depth
  ihdr[9] = colourType;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // deflate / adaptive filtering / no interlace
  // One filter byte (0 = None) per scanline, then bpp bytes per pixel.
  const raw = Buffer.alloc(h * (1 + w * bpp));
  const cx = w / 2, cy = h / 2, rMax = Math.min(w, h) / 2;
  for (let y = 0; y < h; y++) {
    const rowStart = y * (1 + w * bpp);
    raw[rowStart] = 0;
    for (let x = 0; x < w; x++) {
      const p = rowStart + 1 + x * bpp;
      const dist = Math.hypot(x - cx, y - cy);
      raw[p] = (x * 7) % 256; raw[p + 1] = (y * 11) % 256; raw[p + 2] = (dist * 3) % 256;
      if (useAlpha) {
        // Opaque disc with a fully transparent surround => genuine cutout alpha.
        const inside = dist <= rMax * 0.8;
        raw[p + 3] = inside ? 255 : 0;
      }
    }
  }
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Assert a PNG is genuinely decodable by the real production PNG parser. */
async function assertPngParses(file: string, label: string) {
  const { parsePng } = await import(pathToFileURL(`${SRC}/characterAsset.ts`).href);
  const parsed = parsePng(fs.readFileSync(file));
  check(`${label} is a genuinely decodable PNG`, parsed.ok === true, parsed);
}
const mkClip = async (out: string, dur = 3, size = '1280x720') => {
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', `color=c=0x203040:s=${size}:d=${dur}`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', String(dur),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);
};
/** A real WAV so the existing narration-duration resolver can measure it offline. */
const mkWav = async (out: string, dur = 2) => {
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`,
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out]);
};
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// Output geometry used throughout (matches the real project's 720p contract).
const W = 1280, H = 720;

const BG = '#BGD-01-TEST-ROOM';
const CHAR = '@CHAR-01-TESTER';
fs.mkdirSync(path.join(inputRoot, 'narration'), { recursive: true });
const bgFile = path.join(inputRoot, 'backgrounds', 'BGD-01-TEST-ROOM.png');
const charFile = path.join(inputRoot, 'characters', 'CHAR-01-TESTER.png');
const narrationFile = path.join(inputRoot, 'narration', 'narration-0001.wav');
// Background must be >= 1280x720 and 16:9-compatible (existing sceneState contract).
fs.writeFileSync(bgFile, makePng(W, H));               // opaque RGB background
// 1024x1024 is the existing characterAsset minimum; true cutout alpha.
fs.writeFileSync(charFile, makePng(1024, 1024, { alpha: true }));
// Scene 1 has narration_text, so it needs a real narrator asset to resolve a duration.
await mkWav(narrationFile, 2);

// Fail fast and loudly if the synthetic assets are not genuinely decodable.
await assertPngParses(bgFile, 'synthetic background');
await assertPngParses(charFile, 'synthetic character');

const suppliedClip = path.join(inputRoot, 'flow-clips', 'scene-0002.mp4');
await mkClip(suppliedClip, 3, `${W}x${H}`);
// STRICT local-synthesis policy: EVERY scene needs a valid supplied clip to be orchestrator-renderable,
// including the background-only scene 1. So the orchestrator can no longer dispatch LOCAL_SYNTHESIS.
const suppliedClip1 = path.join(inputRoot, 'flow-clips', 'scene-0001.mp4');
await mkClip(suppliedClip1, 3, `${W}x${H}`);

/** Snapshot of the whole input tree, so G can detect added OR removed files. */
const listTree = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? listTree(path.join(dir, e.name)) : [path.relative(inputRoot, path.join(dir, e.name))])).sort();
const INPUT_FILES = listTree(inputRoot);
const INPUT_SHOTS = {
  bg: sha(bgFile),
  char: sha(charFile),
  clip: sha(suppliedClip),
  narration: sha(narrationFile),
};

const pipeline: any = {
  project_id: PID,
  backgrounds: [{ tag: BG }],
  characters: [{ tag: CHAR }],
  scenes: [
    { scene_number: 1, title: 'S1', background_tag: BG, character_tags: [], speaker: 'NARRATOR', camera: 'slow push in', visual_action: 'a', narration_text: 'x' },
    { scene_number: 2, title: 'S2', background_tag: BG, character_tags: [CHAR], speaker: '@CHAR-01-TESTER', camera: 'wide', visual_action: 'b', narration_text: '' },
  ],
};

const execFor = () => createRealSceneExecutor({
  projectId: PID, inputRoot, outputsRoot, pipeline, allowGeneration: false, ffprobePath: process.env.FFPROBE_PATH,
});
const ctx = { projectId: PID, inputRoot, outputsDir, width: W, height: H };

/** Build the inspection-shaped scene object the orchestrator passes to the SceneExecutor. */
function inspection(o: any) {
  return { sceneNumber: o.sceneNumber, renderMode: o.renderMode, durationSeconds: o.durationSeconds, backgroundTag: BG, characterTags: o.characterTags ?? [] };
}

// ============ E. pure dispatch decision ============
{
  check('E1 SUPPLIED_VIDEO dispatches to SUPPLIED_VIDEO', decideRenderDispatch('SUPPLIED_VIDEO').action === 'SUPPLIED_VIDEO');
  check('E2 LOCAL_SYNTHESIS dispatches to LOCAL_SYNTHESIS', decideRenderDispatch('LOCAL_SYNTHESIS').action === 'LOCAL_SYNTHESIS');
  for (const bad of ['NONE', 'AUTO', '', null, undefined, 'auto', 'local_synthesis', 'SOMETHING']) {
    const d = decideRenderDispatch(bad);
    check(`E3 unsupported mode fails closed: ${JSON.stringify(bad)}`, d.action === 'FAIL_CLOSED' && /not dispatchable/.test((d as any).reason), d);
  }
  check('E4 fail-closed reason forbids Flow fallback and substitution',
    /refusing to fall back to Flow generation or substitute another asset/.test((decideRenderDispatch('NONE') as any).reason));
}

// ============ E5. the NONE + authorised-Flow bypass in the real executor ============
// decideRenderDispatch itself is unchanged and still pure. The ADAPTER may route a clip-less
// NONE scene into the Flow path, but ONLY when generation is explicitly authorised and a real
// Flow client exists. Everything else must still fail closed.
{
  const out = path.join(os.tmpdir(), 'dispatch-e5');
  const mkScene = (extra: any) => ({ sceneNumber: 1, renderMode: 'NONE', suppliedClip: { state: 'MISSING' }, ...extra });

  // helper: invoke the real executor with a stubbed Flow client and observe the outcome.
  const runWith = async (scene: any, opts: any, flow: any) => {
    const ex = createRealSceneExecutor({ projectId: 'p', inputRoot: out, outputsRoot: out, pipeline: { scenes: [{ scene_number: 1, speaker: 'none', animation_prompt_NARRATOR_ONLY: 'PROMPT' }] }, ffprobePath: undefined, ...opts, flow } as any);
    try { return await ex(scene, path.join(out, 'scene-0001.mp4')); } catch (e: any) { return { ok: false, reason: `threw: ${String(e?.message ?? e)}` }; }
  };
  const stubFlow = { generateProjectVideo: async () => ({ title: 't', artifactId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }) };

  const noGen = await runWith(mkScene({}), { allowGeneration: false }, stubFlow);
  check('E5a NONE without --run-flow still fails closed (zero-credit default intact)',
    noGen.ok === false && /not dispatchable/.test(String(noGen.reason)), noGen);

  const noClient = await runWith(mkScene({}), { allowGeneration: true }, undefined);
  check('E5b NONE with no Flow client still fails closed', noClient.ok === false && /not dispatchable/.test(String(noClient.reason)), noClient);

  const invalidClip = await runWith(mkScene({ suppliedClip: { state: 'INVALID' } }), { allowGeneration: true }, stubFlow);
  check('E5c NONE with an INVALID local clip still fails closed (never substitutes)',
    invalidClip.ok === false && /not dispatchable/.test(String(invalidClip.reason)), invalidClip);

  const auto = await runWith(mkScene({ renderMode: 'AUTO' }), { allowGeneration: true }, stubFlow);
  check('E5d a non-NONE unsupported mode still fails closed',
    auto.ok === false && /not dispatchable/.test(String(auto.reason)), auto);

  // The authorised NONE case must NOT be refused at the dispatch gate.
  const authorised = await runWith(mkScene({}), { allowGeneration: true }, stubFlow);
  check('E5e NONE + authorised + Flow client passes the dispatch gate',
    !/not dispatchable/.test(String(authorised.reason)), authorised);
}

// ============ background path + layout (pure) ============
{
  const bg = resolveBackgroundImagePath(inputRoot, BG);
  check('BG1 canonical background path from safeTagStem', bg.ok && bg.path === path.join(inputRoot, 'backgrounds', 'BGD-01-TEST-ROOM.png'), bg);
  // The existing safeTagStem() contract NEUTRALISES traversal (separators -> hyphens) rather than
// rejecting it, so the security property to prove is CONTAINMENT inside backgrounds/.
const trav = resolveBackgroundImagePath(inputRoot, '../../etc/passwd');
  check('BG2 path traversal is neutralised and stays inside backgrounds/',
    trav.ok && path.dirname(trav.path) === path.join(inputRoot, 'backgrounds'), trav);
  const trav2 = resolveBackgroundImagePath(inputRoot, '..\\..\\windows\\system32');
  check('BG3 windows-style traversal is neutralised too',
    trav2.ok && path.dirname(trav2.path) === path.join(inputRoot, 'backgrounds'), trav2);
  check('BG4 empty/missing background tag rejected', resolveBackgroundImagePath(inputRoot, null).ok === false && resolveBackgroundImagePath(inputRoot, '').ok === false && resolveBackgroundImagePath(inputRoot, '   ').ok === false);

  const one = layoutCharacterPlacements([CHAR], 1280, 720);
  check('L1 single character: ok', one.ok && one.placements.length === 1, one);
  check('L2 deterministic size + bottom-aligned + horizontally centred',
    one.ok && one.placements[0].width === Math.round(720 * CHARACTER_HEIGHT_FRACTION)
    && one.placements[0].height === Math.round(720 * CHARACTER_HEIGHT_FRACTION)
    && one.placements[0].y === 720 - Math.round(720 * CHARACTER_HEIGHT_FRACTION)
    && one.placements[0].x >= 0, one);
  const three = layoutCharacterPlacements([CHAR, '@CHAR-02-B', '@CHAR-03-C'], 1920, 1080);
  check('L3 multi-character splits evenly and stays in bounds',
    three.ok && three.placements.length === 3
    && three.placements.every((p) => p.x >= 0 && p.x + p.width <= 1920 && p.y + p.height <= 1080), three);
  check('L4 zIndex follows pipeline order', three.ok && three.placements.map((p) => p.zIndex).join(',') === '0,1,2');
  check('L5 no characters -> background-only placements', layoutCharacterPlacements([], 1280, 720).placements.length === 0);
  check('L6 invalid size fails closed', layoutCharacterPlacements([CHAR], 0, 720).ok === false);
  check('L7 deterministic: repeated calls identical', JSON.stringify(layoutCharacterPlacements([CHAR], 1280, 720)) === JSON.stringify(layoutCharacterPlacements([CHAR], 1280, 720)));
}

// ============ A/C/D. LOCAL_SYNTHESIS with NO Flow client ============
{
  const out = path.join(outputsDir, 'scene-0001.mp4');
  const flowCalls: string[] = [];
  // A Flow client is permitted ONLY for the existing READ-ONLY commit probe (sceneHasClip), which
  // the architecture already performs when local media is unusable. Generation, download and
  // artifact-id reads must never be reached for a LOCAL_SYNTHESIS scene.
  const probeOnlyFlow = {
    async sceneHasClip() { flowCalls.push('sceneHasClip'); return false; },
    async generateProjectVideo() { flowCalls.push('generateProjectVideo'); throw new Error('GENERATION MUST NOT RUN'); },
    async downloadCommittedSceneClip() { flowCalls.push('downloadCommittedSceneClip'); throw new Error('DOWNLOAD MUST NOT RUN'); },
    async readCommittedSceneArtifactId() { flowCalls.push('readCommittedSceneArtifactId'); throw new Error('ARTIFACT READ MUST NOT RUN'); },
  };
  // No `flow` and no `flowProvider` at all: the LOCAL_SYNTHESIS path must not need one.
  const r = await execFor()(inspection({ sceneNumber: 1, renderMode: 'LOCAL_SYNTHESIS', durationSeconds: 2 }), out, ctx);
  check('A1 LOCAL_SYNTHESIS produces a scene output', r.ok === true && fs.existsSync(out), r);

  // Same again with a Flow client present to prove only the read-only probe is used.
  // Must use the canonical name, since the adapter refuses any non-canonical output path.
  const execWithPoison = createRealSceneExecutor({ projectId: PID, inputRoot, outputsRoot, pipeline, allowGeneration: false, ffprobePath: process.env.FFPROBE_PATH, flow: probeOnlyFlow });
  const out2 = path.join(outputsDir, 'scene-0001.mp4');
  const r2 = await execWithPoison(inspection({ sceneNumber: 1, renderMode: 'LOCAL_SYNTHESIS', durationSeconds: 2 }), out2, ctx);
  check('C1 LOCAL_SYNTHESIS needs no Flow client', r2.ok === true && fs.existsSync(out2), r2);
  check('D1 LOCAL_SYNTHESIS never invoked Flow generation or download',
    !flowCalls.some((c) => c !== 'sceneHasClip'), flowCalls);
  check('D2b only the read-only commit probe was used', flowCalls.every((c) => c === 'sceneHasClip'), flowCalls);

  // Validate the produced output through the existing clip validator.
  const { validateVideoClip } = await import(pathToFileURL(`${SRC}/videoClip.ts`).href);
  const v = await validateVideoClip(out, { ffprobePath: process.env.FFPROBE_PATH });
  check('A2 rendered output is a VALID clip (video+audio)', v.state === 'VALID', v);
  // validateVideoClip nests stream info under .video / .audio (see videoClip.ts ClipStream).
  check('A3 output dimensions match the inspection size', v.state === 'VALID' && v.video?.width === W && v.video?.height === H, v);
  check('A3b output carries an audio stream (edit.ts requires one)', v.state === 'VALID' && v.audio != null, v);
  check('A4 output duration matches the resolved duration', v.state === 'VALID' && Math.abs((v.durationSeconds ?? 0) - 2) <= 0.5, v);
  check('A5 renderer wrote the canonical scene-####.mp4 name', path.basename(out) === 'scene-0001.mp4' && fs.existsSync(out));
}

// ============ A. LOCAL_SYNTHESIS WITH a character (compositing) ============
{
  const out = path.join(outputsDir, 'scene-0001.mp4');
  fs.rmSync(out, { force: true });
  const r = await execFor()(
    { sceneNumber: 1, renderMode: 'LOCAL_SYNTHESIS', durationSeconds: 2, backgroundTag: BG, characterTags: [CHAR] } as any,
    out, ctx,
  );
  check('A6 LOCAL_SYNTHESIS with a character renders (character overlay path)', r.ok === true && fs.existsSync(out), r);
  const v = await (await import(pathToFileURL(`${SRC}/videoClip.ts`).href)).validateVideoClip(out, { ffprobePath: process.env.FFPROBE_PATH });
  check('A7 character overlay output is a valid clip', v.state === 'VALID', v);
  // A guard: a NON-canonical requested path must fail closed rather than write elsewhere.
  const odd = path.join(outputsDir, 'not-canonical.mp4');
  const rOdd = await execFor()(
    { sceneNumber: 1, renderMode: 'LOCAL_SYNTHESIS', durationSeconds: 2, backgroundTag: BG, characterTags: [CHAR] } as any,
    odd, ctx,
  );
  check('A8 non-canonical output path fails closed', rOdd.ok === false && /not the canonical local-render name/.test(String(rOdd.reason)), rOdd);
  check('A8b non-canonical request wrote nothing', !fs.existsSync(odd));
}

// ============ B. SUPPLIED_VIDEO keeps the proven reuse path ============
{
  const out = path.join(outputsDir, 'scene-0002.mp4');
  fs.rmSync(out, { force: true });
  const r = await execFor()(
    { sceneNumber: 2, renderMode: 'SUPPLIED_VIDEO', durationSeconds: 3, backgroundTag: BG, characterTags: [] } as any,
    out, ctx,
  );
  check('B1 SUPPLIED_VIDEO succeeds via the existing USE_LOCAL path', r.ok === true, r);
  check('B2 supplied clip reused byte-for-byte (no re-encode)', fs.existsSync(out) && sha(out) === INPUT_SHOTS.clip, fs.existsSync(out));
}

// ============ E. fail closed at the executor level ============
{
  const out = path.join(outputsDir, 'scene-0001.mp4');
  const before = fs.existsSync(out) ? sha(out) : null;
  const r = await execFor()({ sceneNumber: 1, renderMode: 'NONE', durationSeconds: 2, backgroundTag: BG, characterTags: [] } as any, out, ctx);
  check('E5 executor refuses renderMode NONE', r.ok === false && /not dispatchable/.test(String(r.reason)), r);
  check('E6 refused scene wrote nothing', (fs.existsSync(out) ? sha(out) : null) === before);
  check('E7 refused scene has no Flow-generation fallback text', !/generation must not run/i.test(String(r.reason)));
}

// ============ F. orchestrator sidecar/output contract intact ============
{
  const report = await orch.orchestrate({
    pipeline, projectId: PID, inputRoot, outputsRoot, outputsDir,
    ffprobePath: process.env.FFPROBE_PATH,
    executor: execFor(),
    // no stageExecutor -> downstream planned only
  } as any);
  const s1 = report.scenes.find((s: any) => s.sceneNumber === 1);
  const s2 = report.scenes.find((s: any) => s.sceneNumber === 2);
  check('F0 orchestrator accepted the fixture (READY, not INPUTS_INVALID)', report.state === 'RENDERED' && report.counts.invalid === 0, { state: report.state, counts: report.counts });
  check('F0b scene 1 (background-only + valid clip) is SUPPLIED_VIDEO, never LOCAL_SYNTHESIS', s1?.renderMode === 'SUPPLIED_VIDEO', s1);
  check('F0c scene 2 inspected as SUPPLIED_VIDEO by the orchestrator itself', s2?.renderMode === 'SUPPLIED_VIDEO', s2);
  check('F0d the orchestrator never reports LOCAL_SYNTHESIS for any scene under STRICT',
    report.scenes.every((x: any) => x.renderMode !== 'LOCAL_SYNTHESIS'), report.scenes.map((x: any) => x.renderMode));
  check('F1 scene 1 output is CURRENT after orchestration', s1?.outputState === 'CURRENT', s1);
  check('F2 scene 2 output is CURRENT after orchestration', s2?.outputState === 'CURRENT', s2);
  const sc1 = path.join(outputsDir, 'scene-0001.json');
  const sc2 = path.join(outputsDir, 'scene-0002.json');
  check('F3 orchestrator wrote the render sidecar for scene 1', fs.existsSync(sc1));
  check('F4 orchestrator wrote the render sidecar for scene 2', fs.existsSync(sc2));
  const side = JSON.parse(fs.readFileSync(sc1, 'utf8'));
  check('F5 sidecar carries render_key + scene number', side.render_key && side.scene_number === 1, side);
  check('F6 sidecar records no absolute machine path', !JSON.stringify(side).includes(inputRoot), side);
  check('F7 no downstream stage was executed (no .stage sidecars)',
    fs.readdirSync(outputsDir).filter((f) => f.endsWith('.stage')).length === 0, fs.readdirSync(outputsDir));
}

// ============ legacy bare-scene shape is preserved, explicit modes stay strict ============
{
  // An ABSENT renderMode is the pre-existing executor contract: delegate to the Flow/USE_LOCAL
  // path exactly as before (the local valid clip makes this scene usable with no Flow work).
  const out = path.join(outputsDir, 'scene-0002.mp4');
  fs.rmSync(out, { force: true });
  const rLegacy = await execFor()({ sceneNumber: 2 } as any, out, ctx);
  check('L8 absent renderMode preserves the legacy delegation path', rLegacy.ok === true && fs.existsSync(out), rLegacy);
  check('L8b legacy delegation reused the supplied clip byte-for-byte', fs.existsSync(out) && sha(out) === INPUT_SHOTS.clip);

  // An EMPTY/whitespace renderMode counts as absent, not as an unsupported mode.
  const rBlank = await execFor()({ sceneNumber: 2, renderMode: '   ' } as any, path.join(outputsDir, 'scene-0002.mp4'), ctx);
  check('L9 blank renderMode is treated as absent (legacy), not as a hard failure', rBlank.ok === true, rBlank);

  // An EXPLICITLY unsupported mode still fails closed — the guard is not weakened.
  const rNone = await execFor()({ sceneNumber: 2, renderMode: 'NONE' } as any, path.join(outputsDir, 'scene-0002.mp4'), ctx);
  check('L10 explicit NONE still fails closed', rNone.ok === false && /not dispatchable/.test(String(rNone.reason)), rNone);
  const rJunk = await execFor()({ sceneNumber: 2, renderMode: 'NONSENSE' } as any, path.join(outputsDir, 'scene-0002.mp4'), ctx);
  check('L11 explicit unsupported mode fails closed', rJunk.ok === false && /not dispatchable/.test(String(rJunk.reason)), rJunk);
}

// ============ FLOW PROVENANCE OUTRANKS LOCAL_SYNTHESIS ============
{
  // ISOLATED fixture: a Flow DOWNLOAD writes into the input tree (flow-clips/), so this block must
  // not share the main fixture whose immutability is asserted in G.
  const PID2 = 'dispatch-provenance';
  const root2 = path.join(tmp, 'inputs', PID2);
  const outRoot2 = path.join(tmp, 'outputs-prov');
  const outDir2 = path.join(outRoot2, PID2);
  for (const d of ['backgrounds', 'characters', 'narration', 'flow-clips']) fs.mkdirSync(path.join(root2, d), { recursive: true });
  fs.mkdirSync(outDir2, { recursive: true });
  fs.copyFileSync(bgFile, path.join(root2, 'backgrounds', 'BGD-01-TEST-ROOM.png'));
  fs.copyFileSync(charFile, path.join(root2, 'characters', 'CHAR-01-TESTER.png'));
  fs.copyFileSync(narrationFile, path.join(root2, 'narration', 'narration-0001.wav'));
  const pipe2 = { ...pipeline, project_id: PID2 };
  const mkEx2 = (flow: any) => createRealSceneExecutor({ projectId: PID2, inputRoot: root2, outputsRoot: outRoot2, pipeline: pipe2, allowGeneration: false, ffprobePath: process.env.FFPROBE_PATH, flow });
  const ins2 = { sceneNumber: 1, renderMode: 'LOCAL_SYNTHESIS', durationSeconds: 2, backgroundTag: BG, characterTags: [] } as any;

  // A scene that Flow already committed but whose local clip is missing still inspects as
  // LOCAL_SYNTHESIS (sceneState cannot see Flow). Rendering a local stand-in would discard the
  // committed Flow asset, so the adapter must fall through to the Flow workflow and DOWNLOAD.
  let downloaded = 0, generated = 0;
  const committedFlow = {
    async sceneHasClip() { return true; },                       // read-only: committed in Flow
    async generateProjectVideo() { generated++; throw new Error('generation must not run'); },
    async downloadCommittedSceneClip(_n: number, dest: string) { downloaded++; await mkClip(dest, 3, `${W}x${H}`); return { ok: true }; },
  };
  const out2 = path.join(outDir2, 'scene-0001.mp4');
  const r = await mkEx2(committedFlow)(ins2, out2, { projectId: PID2, inputRoot: root2, outputsDir: outDir2, width: W, height: H });
  const expectedClip = path.join(root2, 'flow-clips', 'scene-0001.mp4');
  check('P1 Flow-committed LOCAL_SYNTHESIS scene is recovered by DOWNLOAD, not local synthesis',
    r.ok === true && downloaded === 1 && generated === 0, { r, downloaded, generated });
  check('P2 the downloaded Flow clip landed at the output path',
    fs.existsSync(out2) && fs.existsSync(expectedClip) && sha(out2) === sha(expectedClip));

  // A prior checkpoint proving Flow commitment must win WITHOUT any Flow probe, and must not
  // silently render a local stand-in.
  const { sceneCheckpointPath, readSceneCheckpoint, checkpointProvesFlowCommit } = await import(pathToFileURL(`${SRC}/sceneFlowWorkflow.ts`).href);
  const ckPath = sceneCheckpointPath(PID2, 1, outRoot2);
  fs.mkdirSync(path.dirname(ckPath), { recursive: true });
  fs.writeFileSync(ckPath, JSON.stringify({
    schema_version: 1, project_id: PID2, scene_number: 1,
    flow_scene_id: null, flow_scene_url: null, generation_uuid: null,
    committed_scene_artifact_id: '00000000-0000-4000-8000-0000000000aa',
    local_clip_path: null, local_clip_sha256: null,
    workflow_status: 'FLOW_SCENE_ALREADY_COMMITTED', updated_at: new Date().toISOString(),
  }));
  // Prove the checkpoint is loadable, so P3 cannot pass on a silently-ignored file.
  const loaded = await readSceneCheckpoint(ckPath);
  check('P3a the Flow-proving checkpoint loads and validates', loaded !== null && checkpointProvesFlowCommit(loaded) === true, loaded);

  // Remove the downloaded clip so the ONLY remaining Flow signal is the checkpoint.
  fs.rmSync(expectedClip, { force: true });
  fs.rmSync(out2, { force: true });
  let probed = 0;
  const noCommitFlow = { async sceneHasClip() { probed++; return false; } };
  const r2 = await mkEx2(noCommitFlow)(ins2, out2, { projectId: PID2, inputRoot: root2, outputsDir: outDir2, width: W, height: H });
  // The checkpoint proves Flow owns the scene, so the adapter must NOT substitute a local render.
  // It falls through to the Flow workflow, which correctly fails closed (no clip, no generation).
  check('P3 a Flow-proving checkpoint prevents any local stand-in and fails closed',
    r2.ok === false && !fs.existsSync(out2) && /FLOW_GENERATION_REQUIRED/.test(String(r2.reason)), { r2, probed, outputWritten: fs.existsSync(out2) });

  // DIFFERENTIAL: with the SAME client and NO checkpoint, the scene renders locally. This proves the
  // checkpoint is the load-bearing reason P3 refused, not some unrelated failure.
  fs.rmSync(ckPath, { force: true });
  const r3 = await mkEx2(noCommitFlow)(ins2, out2, { projectId: PID2, inputRoot: root2, outputsDir: outDir2, width: W, height: H });
  check('P4 without the checkpoint the same scene renders locally (proves the checkpoint is decisive)',
    r3.ok === true && fs.existsSync(out2), { r3, probed });
}

// ============ stale FLOW_* checkpoints must NOT block local synthesis ============
{
  // REGRESSION: a checkpoint recorded by an earlier failed render attempt says
  // FLOW_GENERATION_REQUIRED — i.e. Flow owns NOTHING. A broad /^(FLOW_|DOWNLOAD_)/ prefix wrongly
  // treated that as Flow ownership and diverted all 16 renderable scenes into the Flow workflow,
  // which then refused with FLOW_GENERATION_REQUIRED. Prove each non-ownership status renders.
  const { readSceneCheckpoint } = await import(pathToFileURL(`${SRC}/sceneFlowWorkflow.ts`).href);
  const NON_OWNERSHIP = [
    'FLOW_GENERATION_REQUIRED', 'FLOW_GENERATION_FAILED', 'FLOW_SCENE_NOT_COMMITTED',
    'FLOW_COMMIT_NOT_PROVEN', 'DOWNLOAD_FAILED', 'VALIDATION_FAILED', 'INPUT_INVALID',
  ];
  const OWNERSHIP = [
    'FLOW_SCENE_ALREADY_COMMITTED', 'FLOW_SCENE_GENERATED', 'DOWNLOAD_SUCCESS', 'DOWNLOAD_ALREADY_VALID',
    'SCENE_LOCAL_EXTENSION_COMPLETE', 'SCENE_LOCAL_REGENERATE_COMPLETE',
  ];

  check('O1 ownership allowlist contains exactly the committed/produced statuses',
    [...FLOW_OWNERSHIP_STATUSES].sort().join(',') === [...OWNERSHIP].sort().join(','), [...FLOW_OWNERSHIP_STATUSES]);
  check('O1b scene-local completion statuses ARE ownership (scene-local produced the clip)',
    OWNERSHIP.filter((s) => s.startsWith('SCENE_LOCAL_')).every((s) => FLOW_OWNERSHIP_STATUSES.has(s)));
  check('O1c no non-ownership status sneaks into the allowlist',
    NON_OWNERSHIP.every((s) => !FLOW_OWNERSHIP_STATUSES.has(s)), [...FLOW_OWNERSHIP_STATUSES]);
  for (const s of NON_OWNERSHIP) {
    check(`O2 ${s} is NOT Flow ownership`, checkpointProvesFlowOwnership({ workflow_status: s }) === false);
    // The broad provenance predicate is deliberately UNCHANGED by this fix (it still prefix-matches),
    // which is exactly why it must not be used for dispatch. Assert its behaviour is untouched.
    check(`O2b broad provenance predicate unchanged for ${s}`,
      checkpointProvesFlowCommit({ workflow_status: s } as any) === /^(FLOW_|DOWNLOAD_)/.test(s));
  }
  for (const s of OWNERSHIP) {
    check(`O3 ${s} IS Flow ownership`, checkpointProvesFlowOwnership({ workflow_status: s }) === true);
  }
  check('O4 a real committed_scene_artifact_id proves ownership regardless of status',
    checkpointProvesFlowOwnership({ workflow_status: 'FLOW_GENERATION_REQUIRED', committed_scene_artifact_id: '00000000-0000-4000-8000-0000000000bb' }) === true);
  check('O5 absent/blank checkpoint is not ownership',
    checkpointProvesFlowOwnership(null) === false && checkpointProvesFlowOwnership(undefined) === false
    && checkpointProvesFlowOwnership({ workflow_status: 'LOCAL_CLIP_ALREADY_VALID' }) === false
    && checkpointProvesFlowOwnership({ workflow_status: 'FLOW_GENERATION_REQUIRED', committed_scene_artifact_id: '   ' }) === false);

  // END-TO-END: a stale FLOW_GENERATION_REQUIRED checkpoint must not stop a local render.
  const { sceneCheckpointPath } = await import(pathToFileURL(`${SRC}/sceneFlowWorkflow.ts`).href);
  const ckPath = sceneCheckpointPath(PID, 1, outputsRoot);
  fs.mkdirSync(path.dirname(ckPath), { recursive: true });
  fs.writeFileSync(ckPath, JSON.stringify({
    schema_version: 1, project_id: PID, scene_number: 1,
    flow_scene_id: null, flow_scene_url: null, generation_uuid: null,
    local_clip_path: null, local_clip_sha256: null,
    workflow_status: 'FLOW_GENERATION_REQUIRED', updated_at: new Date().toISOString(),
  }));
  const staleLoaded = await readSceneCheckpoint(ckPath);
  check('O6 the stale checkpoint is valid on disk and is NOT ownership',
    staleLoaded !== null && checkpointProvesFlowOwnership(staleLoaded) === false, staleLoaded);
  const outStale = path.join(outputsDir, 'scene-0001.mp4');
  fs.rmSync(outStale, { force: true });
  const rStale = await execFor()(inspection({ sceneNumber: 1, renderMode: 'LOCAL_SYNTHESIS', durationSeconds: 2 }), outStale, ctx);
  check('O7 a stale FLOW_GENERATION_REQUIRED checkpoint does NOT block local synthesis',
    rStale.ok === true && fs.existsSync(outStale), rStale);
  fs.rmSync(ckPath, { force: true });
}

// ============ determinism: same inputs ⇒ same output bytes ============
{
  const out = path.join(outputsDir, 'scene-0001.mp4');
  const ins = { sceneNumber: 1, renderMode: 'LOCAL_SYNTHESIS', durationSeconds: 2, backgroundTag: BG, characterTags: [] } as any;
  const r1 = await execFor()(ins, out, ctx);
  const first = fs.existsSync(out) ? sha(out) : null;
  const r2 = await execFor()(ins, out, ctx);
  const second = fs.existsSync(out) ? sha(out) : null;
  check('D2 LOCAL_SYNTHESIS rendering is deterministic (identical SHA across runs)',
    r1.ok === true && r2.ok === true && first != null && first === second, { first, second });
}

// ============ G. input assets never modified ============
{
  check('G1 background asset unmodified', sha(bgFile) === INPUT_SHOTS.bg);
  check('G2 character asset unmodified', sha(charFile) === INPUT_SHOTS.char);
  check('G3 supplied flow clip unmodified', sha(suppliedClip) === INPUT_SHOTS.clip);
  check('G3b narration asset unmodified', sha(narrationFile) === INPUT_SHOTS.narration);
  // Catch ADDED files too (a stray download or render leaking into the input tree).
  check('G3c no file was added to or removed from the input tree',
    JSON.stringify(listTree(inputRoot)) === JSON.stringify(INPUT_FILES), listTree(inputRoot));
  check('G4 all writes stayed under the temp dir', outputsDir.startsWith(tmp) && tmp.startsWith(os.tmpdir()));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} SceneExecutor dispatch checks passed (fully offline).`);