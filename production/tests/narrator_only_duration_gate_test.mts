// Focused regression tests for the NARRATOR_ONLY narration-duration gate.
//
// GAP FIXED: `sceneState.ts` applied the narration-preservation duration gate to `MIXED` scenes
// ONLY. A `NARRATOR_ONLY` scene therefore could never raise `DURATION_CONFLICT` at readiness time,
// so over-limit narration could be reconciled to `CURRENT` and only fail later inside MIX.
//
// These tests drive the REAL pure inspection (`inspectProjectScenes`) against isolated temp
// fixtures — no production project, no Flow/Chrome, no media generation.
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

const SS = await import(pathToFileURL(`${SRC}/sceneState.ts`).href);
const P = await import(pathToFileURL(`${SRC}/narrationDurationPolicy.ts`).href);
const { inspectProjectScenes } = SS;
const { NARRATION_LEGACY_EXEMPT_SCENES, MAX_NARRATION_VIDEO_STRETCH, NARRATION_TAIL_SECONDS } = P;

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
const wav = (f: string, sec: number) => {
  const n = Math.round(sec * 8000); const d = Buffer.alloc(n * 2, 7); const b = Buffer.alloc(44 + d.length);
  b.write('RIFF', 0); b.writeUInt32LE(36 + d.length, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(d.length, 40); d.copy(b, 44);
  fs.writeFileSync(f, b);
};
const mkMp4 = async (o: string, d = 2) => {
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', `color=c=0x203040:s=640x360:d=${d}`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', String(d),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', o]);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'narrator-only-gate-'));
let caseNo = 0;

/**
 * One isolated scene. `opts.speaker` drives the narration kind via the real classifier:
 * NARRATOR -> NARRATOR_ONLY, a character -> MIXED (when both texts are present).
 */
async function buildScene(opts: {
  speaker: string;
  sceneNumber?: number;
  clipSeconds?: number | null;
  narrationSeconds?: number | null;
  withDialogue?: boolean;
}) {
  const id = `case-${++caseNo}`;
  const n = opts.sceneNumber ?? 1;
  const stem = String(n).padStart(4, '0');
  const inputRoot = path.join(tmp, id);
  for (const d of [inputRoot, path.join(inputRoot, 'flow-clips'), path.join(inputRoot, 'backgrounds'), path.join(inputRoot, 'narration')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(inputRoot, 'backgrounds', 'BGD-01.png'), makePng(1280, 720, 2, 1));
  if (opts.clipSeconds !== null) await mkMp4(path.join(inputRoot, 'flow-clips', `scene-${stem}.mp4`), opts.clipSeconds ?? 2);
  if (opts.narrationSeconds !== null) wav(path.join(inputRoot, 'narration', `narration-${stem}.wav`), opts.narrationSeconds ?? 2);
  const scene: any = {
    scene_number: n, title: `S${n}`, background_tag: '#BGD-01',
    character_tags: opts.speaker === 'NARRATOR' || opts.speaker === 'none' ? [] : ['@CHAR-01'],
    speaker: opts.speaker,
    camera: 'wide', effects: '', visual_action: 'a',
    // The SCRIPT text is always present; `narrationSeconds: null` omits only the AUDIO file, so the
    // scene stays NARRATOR_ONLY (narration required) while its audio is missing.
    narration_text: 'नैरेशन टेक्स्ट।',
    devanagari_dialogue: opts.withDialogue ? 'डायलॉग।' : '',
  };
  const pipeline = { project_id: id, style_reference: {}, flow_project_name: id, characters: [], backgrounds: [{ tag: '#BGD-01', location_name: '#BGD-01', look_summary: 'x', full_prompt: 'x' }], scenes: [scene] };
  return { inputRoot, pipeline, scene };
}

const inspect = async (c: any) => (await inspectProjectScenes(c.pipeline, { inputRoot: c.inputRoot, ffprobePath: process.env.FFPROBE_PATH } as any))[0];

// The gate only engages when narration genuinely exceeds the clip (tolerance 0.05s).
const CLIP = 2.0;
const FITS = CLIP + 1.0;                 // (2.0+0.25)/2.0 = 1.125x  -> within 2.0
const OVER = (MAX_NARRATION_VIDEO_STRETCH * CLIP) + 3.0; // (4.0+0.25)/2.0 = 2.125x -> over

// =======================================================================================
// A. NARRATOR_ONLY WITHIN the limit -> READY, no DURATION_CONFLICT
// =======================================================================================
{
  const c = await buildScene({ speaker: 'NARRATOR', clipSeconds: CLIP, narrationSeconds: FITS });
  const s = await inspect(c);
  check('A. fixture really is NARRATOR_ONLY', s.narration === 'NARRATOR_ONLY', s.narration);
  check('A2. in-limit NARRATOR_ONLY is READY', s.readiness === 'READY', { readiness: s.readiness, reasons: s.reasons });
  check('A3. no DURATION_CONFLICT', !s.reasons.includes('DURATION_CONFLICT'), s.reasons);
  check('A4. the preservation summary is reported for audit', !!s.narrationPreservation, JSON.stringify(s.narrationPreservation));
  check('A5. it is recorded as within the limit', s.narrationPreservation?.withinLimit === true, JSON.stringify(s.narrationPreservation));
}

// =======================================================================================
// B. NARRATOR_ONLY EXCEEDING the limit -> blocked by DURATION_CONFLICT  (the fixed gap)
// =======================================================================================
{
  const c = await buildScene({ speaker: 'NARRATOR', clipSeconds: CLIP, narrationSeconds: OVER });
  const s = await inspect(c);
  check('B. fixture really is NARRATOR_ONLY', s.narration === 'NARRATOR_ONLY', s.narration);
  check('B2. THE FIX: over-limit NARRATOR_ONLY is now blocked with DURATION_CONFLICT', s.reasons.includes('DURATION_CONFLICT'), { readiness: s.readiness, reasons: s.reasons });
  check('B3. it is NOT marked READY (so it can never be classified CURRENT)', s.readiness !== 'READY', s.readiness);
  check('B4. it fails closed as INVALID', s.readiness === 'INVALID', s.readiness);
  check('B5. the summary names the over-limit policy reason', s.narrationPreservation?.policy === 'NARRATION_EXCEEDS_CLIP_LIMIT_EXCEEDED', JSON.stringify(s.narrationPreservation));
  check('B6. the summary reports withinLimit=false and the stretch factor', s.narrationPreservation?.withinLimit === false && typeof s.narrationPreservation?.stretchFactor === 'number', JSON.stringify(s.narrationPreservation));
  check('B7. exactly one conflict reason, no duplication', s.reasons.filter((r: string) => r === 'DURATION_CONFLICT').length === 1, s.reasons);
}

// =======================================================================================
// C. MIXED retains its EXISTING behaviour (unchanged by this fix)
// =======================================================================================
{
  const overMixed = await buildScene({ speaker: '@CHAR-01', clipSeconds: CLIP, narrationSeconds: OVER, withDialogue: true });
  const sm = await inspect(overMixed);
  check('C. fixture is MIXED', sm.narration === 'MIXED', sm.narration);
  check('C2. MIXED over-limit still blocks with DURATION_CONFLICT', sm.reasons.includes('DURATION_CONFLICT'), { readiness: sm.readiness, reasons: sm.reasons });
  check('C3. MIXED over-limit is INVALID (unchanged)', sm.readiness === 'INVALID', sm.readiness);

  const okMixed = await buildScene({ speaker: '@CHAR-01', clipSeconds: CLIP, narrationSeconds: FITS, withDialogue: true });
  const sok = await inspect(okMixed);
  check('C4. MIXED in-limit is READY (unchanged)', sok.readiness === 'READY' && !sok.reasons.includes('DURATION_CONFLICT'), { readiness: sok.readiness, reasons: sok.reasons });
}

// =======================================================================================
// D. Scenes not eligible for the gate are untouched
// =======================================================================================
{
  // Narration script present but the AUDIO file is absent -> gate must not engage.
  const noNarr = await buildScene({ speaker: 'NARRATOR', clipSeconds: CLIP, narrationSeconds: null });
  const a = await inspect(noNarr);
  check('D. fixture is NARRATOR_ONLY with its audio missing', a.narration === 'NARRATOR_ONLY', a.narration);
  check('D2. missing narration is NOT reported as DURATION_CONFLICT', !a.reasons.includes('DURATION_CONFLICT'), { readiness: a.readiness, reasons: a.reasons });
  // A VALID supplied clip takes precedence over narration state (sceneState readiness precedence),
  // so the scene stays READY. That is pre-existing SUPPLIED_VIDEO behaviour, NOT something this
  // change introduced: the gate simply does not engage when the narration is absent.
  check('D3. the gate does not engage without narration audio (clip precedence unchanged)', a.readiness === 'READY', { readiness: a.readiness, reasons: a.reasons });
  check('D3b. the narration asset is genuinely missing', a.narrationAsset.state === 'MISSING', a.narrationAsset.state);

  // No supplied clip -> gate must not engage.
  const noClip = await buildScene({ speaker: 'NARRATOR', clipSeconds: null, narrationSeconds: OVER });
  const b = await inspect(noClip);
  check('D3. a scene with no supplied clip is NOT DURATION_CONFLICT', !b.reasons.includes('DURATION_CONFLICT'), { readiness: b.readiness, reasons: b.reasons });
  check('D4. it waits for its video clip instead', b.readiness === 'WAITING_FOR_VIDEO_CLIP', b.readiness);

  // Narration shorter than the clip -> no conflict (the `narrationExceedsClip` guard still holds).
  const short = await buildScene({ speaker: 'NARRATOR', clipSeconds: 6, narrationSeconds: 1 });
  const c = await inspect(short);
  check('D5. narration shorter than the clip is READY', c.readiness === 'READY' && !c.reasons.includes('DURATION_CONFLICT'), { readiness: c.readiness, reasons: c.reasons });
}

// =======================================================================================
// E. Scene 2's documented legacy exception is preserved (not silently changed)
// =======================================================================================
{
  check('E. Scene 2 is declared legacy-exempt', NARRATION_LEGACY_EXEMPT_SCENES.has(2), [...NARRATION_LEGACY_EXEMPT_SCENES]);
  check('E2. only Scene 2 is exempt', [...NARRATION_LEGACY_EXEMPT_SCENES].length === 1, [...NARRATION_LEGACY_EXEMPT_SCENES]);

  // Real Scene-2 geometry: 8.0 s clip, 19.12 s narration -> 2.42125x, above the 2.0 bound.
  const CLIP2 = 8.0, NARR2 = 19.12;
  const viaPolicy = P.decideNarrationPreservation({ sourceVideoDuration: CLIP2, narrationDuration: NARR2 });
  check('E3. the shared policy WOULD reject Scene 2 (it is genuinely over 2.0x)', viaPolicy.ok === false, JSON.stringify(viaPolicy));

  // ...but the readiness gate exempts scene 2, so it is not blocked.
  const s2 = await buildScene({ speaker: 'NARRATOR', sceneNumber: 2, clipSeconds: CLIP2, narrationSeconds: NARR2 });
  const ins2 = await inspect(s2);
  check('E4. THE EXCEPTION IS PRESERVED: Scene 2 is not blocked by DURATION_CONFLICT', !ins2.reasons.includes('DURATION_CONFLICT'), { readiness: ins2.readiness, reasons: ins2.reasons });
  check('E5. Scene 2 therefore stays READY, exactly as before this change', ins2.readiness === 'READY', ins2.readiness);

  // The exemption is scene-scoped, not a blanket relaxation: scene 1 with the SAME geometry blocks.
  const s1 = await buildScene({ speaker: 'NARRATOR', clipSeconds: CLIP2, narrationSeconds: NARR2 });
  const ins1 = await inspect(s1);
  check('E6. the exemption is scene-scoped only — identical geometry on scene 1 IS blocked', ins1.reasons.includes('DURATION_CONFLICT'), { readiness: ins1.readiness, reasons: ins1.reasons });

  // And the mixer's own legacy branch must still exist verbatim (guards against a silent change).
  const mx = fs.readFileSync(`${SRC}/mixNarration.ts`, 'utf8');
  check('E7. the mixer legacy branch is preserved verbatim',
    mx.includes('if (scene === 2) return Math.max(clipDuration, narrationDuration + narrationTail);'));
}

// =======================================================================================
// F. Source guards: the fix reuses the shared helper and adds no duplicated arithmetic
// =======================================================================================
{
  const ss = fs.readFileSync(`${SRC}/sceneState.ts`, 'utf8');
  const code = ss.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  check('F. sceneState still imports the SHARED helper', /decideNarrationPreservation/.test(ss) && /narrationExceedsClip/.test(ss));
  check('F2. sceneState still fails closed with DURATION_CONFLICT on the over-limit path',
    /!preservation\.ok\)\s*reasons\.push\('DURATION_CONFLICT'\)/.test(code.replace(/\s+/g, ' ')));
  check('F3. the policy bound is unchanged', MAX_NARRATION_VIDEO_STRETCH === 2.0 && NARRATION_TAIL_SECONDS === 0.25);
  check('F4. no inline duration comparison was reintroduced',
    !/narrationAsset\.durationSeconds\s*>\s*suppliedClip\.durationSeconds\s*\+/.test(code));
}

console.log(`\nNARRATOR-ONLY DURATION GATE TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
