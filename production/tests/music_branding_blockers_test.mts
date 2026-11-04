// Regression tests: MISSING BGM / BRANDING BLOCKER PROPAGATION.
//
// Issue: `collectBlockers` accepts `musicMissing` and `brandingMissing`, and both feed real
// consumer logic (`projectHealth` already reports them), but `runProject` never passed them — so a
// project missing its background music or branding reported NO blocker for it.
//
// Both assets are REQUIRED by current code, not optional:
//   · inputValidator.ts:251  "Branding: channel intro video + logo image, required by addTitle.ts."
//   · stageExecutor.ts:84    BED defaults to <inputsDir>/music/background-music.mp3
//   · stageExecutor.ts:91-96 TITLE resolves branding canonically; absent branding "FAILS CLOSED"
//   · manifestWorkflow.ts:110/118/119 requirement: 'REQUIRED' for music, channel-intro, channel-logo
// `RunProjectConfig` exposes no bgmPath/titleAssets override, so the canonical input location is
// the only source. There is no optional/disabled mode for either asset.
//
// LOCAL-ONLY, fully offline, isolated os.tmpdir() fixtures. No Flow/Chrome/network, no real
// project data, no production stage producers executed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);

import { REPO } from './_testPaths.mjs';
const SRC = `${REPO}/production/src`;
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
process.env.PATH = `${FF};${process.env.PATH}`;

const PO = await import(pathToFileURL(`${SRC}/projectOrchestrator.ts`).href);
const IV = await import(pathToFileURL(`${SRC}/inputValidator.ts`).href);
const PH = await import(pathToFileURL(`${SRC}/projectHealth.ts`).href);
const { runProject, collectBlockers } = PO;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

function makePng(w: number, h: number, ct = 6, tag = 0) {
  const T: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct; const ch = ct === 6 ? 4 : 2; const raw = Buffer.alloc(h * (1 + w * ch), 0x80);
  for (let y = 0; y < h; y++) raw[y * (1 + w * ch)] = 0; raw[11] = (tag & 0xff);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const wav = (f: string, sec: number, tag = 0) => {
  const n = Math.round(sec * 8000); const d = Buffer.alloc(n * 2, tag); const b = Buffer.alloc(44 + d.length);
  b.write('RIFF', 0); b.writeUInt32LE(36 + d.length, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(d.length, 40); d.copy(b, 44);
  fs.writeFileSync(f, b);
};
const mkMp4 = async (o: string, color = '0x203040', d = 2) => {
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=640x360:d=${d}`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', String(d),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', o]);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'music-branding-blockers-'));
const projectsRoot = path.join(tmp, 'projects');
const inputsRoot = path.join(tmp, 'inputs');
const outputsRoot = path.join(tmp, 'outputs');
const BG = '#BGD-01-STREET';

/** A COMPLETE project: every required asset present and valid. */
async function buildComplete(id: string) {
  const projectDir = path.join(projectsRoot, id);
  const inputRoot = path.join(inputsRoot, id);
  const outputsDir = path.join(outputsRoot, id);
  for (const d of [projectDir, inputRoot, outputsDir,
    path.join(inputRoot, 'flow-clips'), path.join(inputRoot, 'backgrounds'), path.join(inputRoot, 'narration'),
    path.join(inputRoot, 'music'), path.join(inputRoot, 'branding')]) fs.mkdirSync(d, { recursive: true });
  const pipeline = { project_id: id, style_reference: {}, flow_project_name: id, characters: [],
    backgrounds: [{ tag: BG, location_name: BG, look_summary: 'x', full_prompt: 'x' }],
    scenes: [1, 2].map((n) => ({ scene_number: n, title: `S${n}`, background_tag: BG, character_tags: [], speaker: 'NARRATOR',
      camera: 'wide', effects: '', visual_action: `action ${n}`, narration_text: `n ${n}`, devanagari_dialogue: '',
      clip_length_seconds: null, edit_length_seconds: null, status: 'pending' })) };
  fs.writeFileSync(path.join(projectDir, 'pipeline.json'), JSON.stringify(pipeline, null, 2));

  fs.writeFileSync(path.join(inputRoot, 'backgrounds', 'BGD-01-STREET.png'), makePng(1280, 720, 2, 1));
  for (const n of [1, 2]) {
    await mkMp4(path.join(inputRoot, 'flow-clips', `scene-${String(n).padStart(4, '0')}.mp4`), `0x${(0x213140 + n * 0x010101).toString(16).padStart(6, '0')}`);
    wav(path.join(inputRoot, 'narration', `narration-${String(n).padStart(4, '0')}.wav`), 2, n);
  }
  // Required music: CC0 track + provenance sidecar.
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=6:sample_rate=44100', '-ac', '2', '-b:a', '96k', path.join(inputRoot, 'music', 'background-music.mp3')]);
  fs.writeFileSync(path.join(inputRoot, 'music', 'background-music.license.json'), JSON.stringify({ license: 'CC0' }));
  // Required branding: intro clip + logo.
  await mkMp4(path.join(inputRoot, 'branding', 'channel-intro.mp4'), '0x101020', 2);
  fs.writeFileSync(path.join(inputRoot, 'branding', 'channel-logo.png'), makePng(256, 256, 6, 3));

  return { id, inputRoot, outputsDir, projectDir };
}

const run = (f: any, over: any = {}) => runProject({ projectId: f.id, projectsRoot, inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH, ...over } as any);
const cats = (r: any) => r.blockers.map((b: any) => b.category);

// =======================================================================================
// A. Pure collector contract (unchanged; guards the shape the fix relies on)
// =======================================================================================
{
  const b = collectBlockers({ musicMissing: true });
  check('A. collectBlockers accepts musicMissing and emits a music blocker', b.length === 1 && b[0].category === 'music', JSON.stringify(b));
  const br = collectBlockers({ brandingMissing: ['channel-intro', 'channel-logo'] });
  check('A2. collectBlockers accepts brandingMissing (string[]) and names the assets',
    br.length === 1 && br[0].category === 'branding' && /channel-intro/.test(br[0].detail), JSON.stringify(br));
  check('A3. absent music/branding flags produce no such blockers',
    !collectBlockers({}).some((x: any) => x.category === 'music' || x.category === 'branding'));
  check('A4. an empty branding list produces no branding blocker', !collectBlockers({ brandingMissing: [] }).some((x: any) => x.category === 'branding'));
}

// =======================================================================================
// B. A COMPLETE project produces NO false blockers (regression guard for the fix)
// =======================================================================================
{
  const f = await buildComplete('complete');
  const music = await IV.validateMusicInputs({ inputRoot: f.inputRoot, ffprobePath: process.env.FFPROBE_PATH } as any);
  const branding = await IV.validateBrandingInputs({ inputRoot: f.inputRoot, ffprobePath: process.env.FFPROBE_PATH } as any);
  check('B0. fixture music is VALID', music.every((m: any) => m.state === 'VALID'), JSON.stringify(music.map((m: any) => m.state)));
  check('B0b. fixture branding is VALID', branding.every((b: any) => b.state === 'VALID'), JSON.stringify(branding.map((b: any) => b.state)));

  const r = await run(f);
  check('B. a complete project has NO blockers', r.blockers.length === 0, JSON.stringify(r.blockers));
  check('B2. specifically no music or branding blocker', !cats(r).includes('music') && !cats(r).includes('branding'), JSON.stringify(cats(r)));
  check('B3. status is not WAITING_FOR_INPUTS', r.status !== 'WAITING_FOR_INPUTS', r.status);
}

// =======================================================================================
// C. Missing required BGM is reported as a blocker (public status path)
// =======================================================================================
{
  const f = await buildComplete('no-music');
  fs.rmSync(path.join(f.inputRoot, 'music'), { recursive: true, force: true });
  const r = await run(f);
  check('C. missing BGM produces a music blocker via runProject', cats(r).includes('music'), JSON.stringify(r.blockers));
  check('C2. status is WAITING_FOR_INPUTS', r.status === 'WAITING_FOR_INPUTS', r.status);
  check('C3. nextAction tells the operator to supply music', /music/.test(r.nextAction), r.nextAction);
  check('C4. the blocker detail is human-readable', /background-music/.test(r.blockers.find((b: any) => b.category === 'music')?.detail ?? ''));
}

// =======================================================================================
// D. Missing required branding is reported as a blocker (public status path)
// =======================================================================================
{
  const f = await buildComplete('no-branding');
  fs.rmSync(path.join(f.inputRoot, 'branding'), { recursive: true, force: true });
  const r = await run(f);
  check('D. missing branding produces a branding blocker via runProject', cats(r).includes('branding'), JSON.stringify(r.blockers));
  check('D2. status is WAITING_FOR_INPUTS', r.status === 'WAITING_FOR_INPUTS', r.status);
  const b = r.blockers.find((x: any) => x.category === 'branding');
  check('D3. the blocker names BOTH required branding assets', /channel-intro/.test(b?.detail ?? '') && /channel-logo/.test(b?.detail ?? ''), b?.detail);
  check('D4. nextAction mentions branding', /branding/.test(r.nextAction), r.nextAction);
}

// =======================================================================================
// E. PARTIAL branding (logo only) still blocks and names what is missing
// =======================================================================================
{
  const f = await buildComplete('partial-branding');
  fs.rmSync(path.join(f.inputRoot, 'branding', 'channel-logo.png'), { force: true });
  const r = await run(f);
  check('E. a missing logo is still a branding blocker', cats(r).includes('branding'), JSON.stringify(r.blockers));
  const b = r.blockers.find((x: any) => x.category === 'branding');
  check('E2. the blocker names ONLY the missing logo', /channel-logo/.test(b?.detail ?? '') && !/channel-intro/.test(b?.detail ?? ''), b?.detail);
}

// =======================================================================================
// F. Invalid (not merely absent) music/branding also block
// =======================================================================================
{
  const f = await buildComplete('invalid-music');
  // Present but unusable: the licence sidecar is required provenance.
  fs.writeFileSync(path.join(f.inputRoot, 'music', 'background-music.license.json'), '{ broken json');
  const r = await run(f);
  check('F. music with invalid licence provenance blocks', cats(r).includes('music'), JSON.stringify(r.blockers));
}
{
  const f = await buildComplete('invalid-branding');
  fs.writeFileSync(path.join(f.inputRoot, 'branding', 'channel-logo.png'), 'not a png');
  const r = await run(f);
  check('F2. branding with an invalid logo blocks', cats(r).includes('branding'), JSON.stringify(r.blockers));
}

// =======================================================================================
// G. The blocker is visible through the PUBLIC health path too (agreement, not just a helper)
// =======================================================================================
{
  const f = await buildComplete('health-agreement');
  fs.rmSync(path.join(f.inputRoot, 'music'), { recursive: true, force: true });
  fs.rmSync(path.join(f.inputRoot, 'branding'), { recursive: true, force: true });
  const h = await PH.getProjectHealth({ projectFile: path.join(f.projectDir, 'pipeline.json'), inputsRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH });
  check('G. project health reports the missing music action', /BGM/i.test(JSON.stringify(h)), JSON.stringify(h).slice(0, 400));
  const r = await run(f);
  check('G2. runProject and health AGREE that music+branding are missing',
    cats(r).includes('music') && cats(r).includes('branding'), JSON.stringify(cats(r)));
}

// =======================================================================================
// H. Existing state semantics are unchanged
// =======================================================================================
{
  // Missing music/branding alongside a missing narration is still WAITING_FOR_INPUTS (not FAILED).
  const f = await buildComplete('state-semantics');
  fs.rmSync(path.join(f.inputRoot, 'music'), { recursive: true, force: true });
  fs.rmSync(path.join(f.inputRoot, 'narration', 'narration-0002.wav'), { force: true });
  // `runProject`'s no-write switch is `dryRun` (not `readOnly`, which belongs to orchestrate).
  // Blockers are computed before the dryRun gates, so the reporting behaviour is unchanged.
  const r = await run(f, { dryRun: true });
  check('H. blockers alone never escalate the project to FAILED', r.status === 'WAITING_FOR_INPUTS', r.status);
  check('H2. the narration blocker is still reported alongside music', cats(r).includes('narration') && cats(r).includes('music'), JSON.stringify(cats(r)));
}

// =======================================================================================
// I. Read-only status inspection does not write or alter persisted state
// =======================================================================================
{
  const f = await buildComplete('readonly-safety');
  fs.rmSync(path.join(f.inputRoot, 'music'), { recursive: true, force: true });
  const listingBefore = fs.readdirSync(f.outputsDir).sort().join(',');
  const r1 = await run(f, { dryRun: true });
  const listingAfter = fs.readdirSync(f.outputsDir).sort().join(',');
  check('I. dryRun (non-writing) status reports the music blocker', cats(r1).includes('music'), JSON.stringify(cats(r1)));
  check('I2. dryRun writes NOTHING to the outputs dir', listingAfter === listingBefore, `${listingBefore} -> ${listingAfter}`);
  check('I3. no state.json was created by the dryRun pass', !fs.existsSync(path.join(f.outputsDir, 'state.json')), listingAfter);
}

// ---- the real project was never touched ----
{
  check('no fixture leaked into the real production tree',
    !fs.existsSync(`${REPO}/production/inputs/no-music`) && !fs.existsSync(`${REPO}/production/outputs/no-music`));
}

console.log(`\nMUSIC / BRANDING BLOCKER TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
