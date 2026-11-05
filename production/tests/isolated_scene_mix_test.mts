// Focused OFFLINE tests for the ISOLATED scene MIX validation capability.
// No browser, no Flow, no credits. Real ffmpeg is used only to BUILD throwaway fixture media in TEMP.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
import { SRC } from './_testPaths.mjs';
const M: any = await import(pathToFileURL(`${SRC}/isolatedSceneMix.ts`).href);
const V: any = await import(pathToFileURL(`${SRC}/video.ts`).href);
const P: any = await import(pathToFileURL(`${SRC}/narrationDurationPolicy.ts`).href);
const {
  planIsolatedSceneMix, runIsolatedSceneMix, isolatedValidationFilename,
  PROTECTED_FINAL_ARTEFACTS, isPathInside,
  parseMaxStretchOverride, ISOLATED_MAX_STRETCH_HARD_CEILING,
} = M;

let passed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed += 1; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-mix-'));
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const inputRoot = path.join(tmp, 'inputs');
const validationRoot = path.join(tmp, 'outputs', 'validation');
fs.mkdirSync(path.join(inputRoot, 'flow-clips'), { recursive: true });
fs.mkdirSync(path.join(inputRoot, 'narration'), { recursive: true });

const mkVideo = (file: string, seconds: number) => exec(ffmpeg, ['-y', '-f', 'lavfi', '-i', `testsrc=size=1280x720:rate=24:duration=${seconds}`, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file], { maxBuffer: 1024 * 1024 * 64 });
const mkWav = (file: string, seconds: number) => exec(ffmpeg, ['-y', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`, '-ac', '2', file], { maxBuffer: 1024 * 1024 * 64 });
const clipOf = (scene: number) => path.join(inputRoot, 'flow-clips', `scene-${String(scene).padStart(4, '0')}.mp4`);
const narrOf = (scene: number) => path.join(inputRoot, 'narration', `narration-${String(scene).padStart(4, '0')}.wav`);
const shaOf = (p: string) => crypto0(p);
import crypto from 'node:crypto';
function crypto0(p: string) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

// ---- fixtures: Scene 15's real shape (8.000 video / 12.760 narration) ----
await mkVideo(clipOf(15), 8);
await mkWav(narrOf(15), 12.76);
await mkVideo(clipOf(16), 8);
await mkWav(narrOf(16), 10.12);
// a narration so long it exceeds the 2.0x bound
await mkVideo(clipOf(20), 8);
await mkWav(narrOf(20), 15.751);
// a scene whose narration fits comfortably
await mkVideo(clipOf(21), 8);
await mkWav(narrOf(21), 6);
// a scene with a clip but NO narration
await mkVideo(clipOf(22), 8);

// ===== 1. correct single-scene input selection =====
{
  const p = await planIsolatedSceneMix({ sceneNumber: 15, inputRoot, validationRoot });
  check('1: plan succeeds for scene 15', p.ok === true, p);
  check('1: selects EXACTLY the scene-0015 clip by derived name (no directory scan)', p.videoInput === clipOf(15), p.videoInput);
  check('1: selects EXACTLY the matching narration-0015.wav', p.narrationInput === narrOf(15), p.narrationInput);
  check('1: default output is <validationRoot>/scene-0015-mixed.mp4',
    p.outputPath === path.join(validationRoot, 'scene-0015-mixed.mp4'), p.outputPath);
  check('1: derived filename helper matches', isolatedValidationFilename(15) === 'scene-0015-mixed.mp4', isolatedValidationFilename(15));
  check('1: scene 16 inputs are NOT touched by a scene-15 plan',
    !String(p.videoInput).includes('0016') && !String(p.narrationInput).includes('0016'));
}

// ===== 2. exact Scene 15 timing values =====
{
  const p = await planIsolatedSceneMix({ sceneNumber: 15, inputRoot, validationRoot });
  check('2: source video duration is 8.000s', Math.abs((p.sourceVideoDuration ?? 0) - 8) < 0.02, p.sourceVideoDuration);
  check('2: narration duration is 12.760s', Math.abs((p.narrationDuration ?? 0) - 12.76) < 0.02, p.narrationDuration);
  check('2: target output duration is 13.010s', Math.abs((p.outputDuration ?? 0) - 13.01) < 0.02, p.outputDuration);
  check('2: stretch factor is 1.62625', Math.abs((p.stretchFactor ?? 0) - 1.62625) < 0.0005, p.stretchFactor);
  check('2: within the 2.0 bound', p.withinLimit === true && (p.stretchFactor ?? 9) <= P.MAX_NARRATION_VIDEO_STRETCH, p.stretchFactor);
  check('2: policy reported as NARRATION_EXCEEDS_CLIP_WITHIN_LIMIT', p.policy === 'NARRATION_EXCEEDS_CLIP_WITHIN_LIMIT', p.policy);
  check('2: picture slowdown is REQUIRED (and therefore audio is not stretched)', p.pictureSlowdownRequired === true, p);
  // the shared policy must agree exactly
  const d = P.decideNarrationPreservation({ sourceVideoDuration: 8, narrationDuration: 12.76 });
  check('2: values come from the SHARED policy helper, not a private copy',
    Math.abs(d.requiredOutputDuration - p.outputDuration) < 1e-9 && Math.abs(d.stretchFactor - p.stretchFactor) < 1e-9, { d, p });
}

// ===== 3. natural-speed audio + visual-only slowdown =====
{
  const p = await planIsolatedSceneMix({ sceneNumber: 15, inputRoot, validationRoot });
  const k = (13.01 / 8).toFixed(6);
  check('3: graph carries the visual-only setpts stretch', String(p.graph).includes(`setpts=${k}*PTS`), String(p.graph).slice(0, 200));
  check('3: graph pins fps then trims to the extended length',
    String(p.graph).includes('fps=24') && String(p.graph).includes('trim=duration=13.010'), String(p.graph).slice(0, 200));
  check('3: NO audio time-stretch filter anywhere in the graph',
    !/asetrate|atempo|aresample/.test(String(p.graph)), String(p.graph));
  check('3: narration audio is atrim-ed to the SAME extended length (natural speed, full length)',
    String(p.graph).includes('atrim=duration=13.010'), String(p.graph));
  check('3: scene ambience is apad+atrim before ducking (existing MIX behaviour reused)',
    String(p.graph).includes('apad,atrim=duration=13.010') && String(p.graph).includes('sidechaincompress'), String(p.graph).slice(0, 260));
  // `tpad=stop_mode=clone` IS now part of the shipped chain: MCI cannot synthesise a frame at or past
  // the last input frame, so a short cloned tail gives the interpolator a following frame to work
  // towards. It is tail-only cloning — no loop, no freeze, no concat — and it is trimmed away by
  // `trim=duration=13.010`, so no held footage reaches the output. See mixFilterGraph.ts.
  check('3: the only padding is a tail-only tpad clone (no loop/freeze/concat)',
    /tpad=stop_mode=clone:stop_duration=0\.250000/.test(String(p.graph))
    && !/aloop|tconcat|freezedump|loop=image|stop_mode=loop/.test(String(p.graph)), String(p.graph).slice(0, 220));
  check('3: the cloned tail is trimmed away so no held footage survives',
    /tpad=stop_mode=clone[^,]*,setpts=[0-9.]+\*PTS,minterpolate=[^,]*,trim=duration=13\.010/.test(String(p.graph)),
    String(p.graph).slice(0, 220));
  check('3: interpolation is present and happens AFTER retiming',
    /setpts=[0-9.]+\*PTS,minterpolate=fps=24:mi_mode=mci/.test(String(p.graph)), String(p.graph).slice(0, 220));
  check('3: argv uses the MIX codec contract (libx264 / yuv420p / aac 192k / 48k stereo)',
    String(p.argvPreview).includes('libx264') && String(p.argvPreview).includes('yuv420p')
    && String(p.argvPreview).includes('192k') && String(p.argvPreview).includes('-ar') && String(p.argvPreview).includes('48000'), p.argvPreview);
  check('3: argv has exactly ONE video input and ONE narration input',
    (p.argvPreview ?? []).filter((a) => a === p.videoInput).length === 1
    && (p.argvPreview ?? []).filter((a) => a === p.narrationInput).length === 1, p.argvPreview);
}

// ===== 4. fail-safe preconditions =====
{
  const bad = await planIsolatedSceneMix({ sceneNumber: 0, inputRoot, validationRoot });
  check('4: sceneNumber 0 -> SCENE_NUMBER_INVALID', bad.ok === false && bad.code === 'SCENE_NUMBER_INVALID', bad.code);
  const bad2 = await planIsolatedSceneMix({ sceneNumber: -3, inputRoot, validationRoot });
  check('4: negative scene -> SCENE_NUMBER_INVALID', bad2.ok === false && bad2.code === 'SCENE_NUMBER_INVALID', bad2.code);
  const bad3 = await planIsolatedSceneMix({ sceneNumber: 99, inputRoot, validationRoot });
  check('4: unknown scene (no clip) -> SOURCE_MISSING', bad3.ok === false && bad3.code === 'SOURCE_MISSING', bad3.code);
  const bad4 = await planIsolatedSceneMix({ sceneNumber: 22, inputRoot, validationRoot });
  check('4: scene with a clip but NO narration -> NARRATION_MISSING', bad4.ok === false && bad4.code === 'NARRATION_MISSING', bad4.code);
  const bad5 = await planIsolatedSceneMix({ sceneNumber: 20, inputRoot, validationRoot });
  check('4: over-limit stretch -> STRETCH_LIMIT_EXCEEDED (fail closed)',
    bad5.ok === false && bad5.code === 'STRETCH_LIMIT_EXCEEDED', { code: bad5.code, reason: bad5.reason });
  check('4: over-limit reason names the slowdown and the bound',
    /slowdown/.test(String(bad5.reason)) && /maximum/.test(String(bad5.reason)), bad5.reason);
  // a narration that fits must NOT be extended
  const fits = await planIsolatedSceneMix({ sceneNumber: 21, inputRoot, validationRoot });
  check('4: narration that fits -> 8.0s output, no slowdown',
    fits.ok === true && Math.abs((fits.outputDuration ?? 0) - 8) < 1e-6 && fits.stretchFactor === 1 && fits.pictureSlowdownRequired === false, fits);
  check('4: fitting scene graph contains NO setpts stretch', !/setpts=1\.\d+\*PTS/.test(String(fits.graph)), String(fits.graph).slice(0, 160));
}

// ===== 4b. --max-stretch override: eligibility ONLY, fail-closed, default unchanged =====
// Scene 2's real shape: an 8.000 s clip with 19.120 s narration. Production MIX preserves
// max(8, 19.12 + 0.25) = 19.370 s, a 2.42125x slowdown, which is ABOVE the 2.0x policy bound and
// is deliberately unrouted through it. The isolated planner must therefore REFUSE it by default,
// and accept it only when a caller explicitly raises the ceiling.
const S2_CLIP = 8;
const S2_NARR = 19.12;
const S2_REQUIRED = S2_NARR + P.NARRATION_TAIL_SECONDS;   // 19.370
const S2_FACTOR = S2_REQUIRED / S2_CLIP;                    // 2.42125
{
  // ---- fixture: a real Scene-2-shaped clip + narration in TEMP ----
  const s2Root = path.join(tmp, 'inputs-s2');
  fs.mkdirSync(path.join(s2Root, 'flow-clips'), { recursive: true });
  fs.mkdirSync(path.join(s2Root, 'narration'), { recursive: true });
  const s2Clip = path.join(s2Root, 'flow-clips', 'scene-0002.mp4');
  const s2Narr = path.join(s2Root, 'narration', 'narration-0002.wav');
  await exec(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=8',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '8',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-video_track_timescale', '12288',
    '-c:a', 'aac', '-shortest', s2Clip], { maxBuffer: 1 << 26 });
  await exec(ffmpeg, ['-y', '-f', 'lavfi', '-i', `sine=frequency=300:sample_rate=24000:duration=${S2_NARR}`, '-ac', '1', s2Narr], { maxBuffer: 1 << 26 });
  const s2ValRoot = path.join(tmp, 'validation-s2');
  fs.mkdirSync(s2ValRoot, { recursive: true });

  // ---- (a) DEFAULT behaviour is unchanged: Scene 2 is rejected ----
  const dflt = await planIsolatedSceneMix({ sceneNumber: 2, inputRoot: s2Root, validationRoot: s2ValRoot });
  check('4b: DEFAULT still rejects Scene 2 (no flag => 2.0x policy applies)', dflt.ok === false && dflt.code === 'STRETCH_LIMIT_EXCEEDED', { code: dflt.code, reason: dflt.reason });
  check('4b: the default refusal names the stretch it would have needed',
    /2\.4/.test(String(dflt.reason)) && /above the 2x maximum/.test(String(dflt.reason)), dflt.reason);
  check('4b: the default refusal reports the production limit, not a raised one',
    dflt.maxStretch === P.MAX_NARRATION_VIDEO_STRETCH, dflt.maxStretch);

  // ---- (b) an explicit safe ceiling admits it ----
  const raised = await planIsolatedSceneMix({ sceneNumber: 2, inputRoot: s2Root, validationRoot: s2ValRoot, maxStretch: 2.5 });
  check('4b: an explicit 2.5x ceiling allows Scene 2 to plan', raised.ok === true, { code: raised.code, reason: raised.reason });
  check('4b: the plan reports the raised ceiling and the 2.42125x factor',
    raised.maxStretch === 2.5 && Math.abs((raised.stretchFactor ?? 0) - S2_FACTOR) < 1e-6, { max: raised.maxStretch, factor: raised.stretchFactor });

  // ---- (c) a ceiling BELOW the requirement still rejects ----
  const tooLow = await planIsolatedSceneMix({ sceneNumber: 2, inputRoot: s2Root, validationRoot: s2ValRoot, maxStretch: 2.42125 });
  check('4b: a ceiling exactly AT the requirement admits it', tooLow.ok === true, { code: tooLow.code, reason: tooLow.reason });
  const justUnder = await planIsolatedSceneMix({ sceneNumber: 2, inputRoot: s2Root, validationRoot: s2ValRoot, maxStretch: 2.4 });
  check('4b: a ceiling BELOW 2.42125x still rejects', justUnder.ok === false && justUnder.code === 'STRETCH_LIMIT_EXCEEDED', { code: justUnder.code });

  // ---- (d) invalid / non-finite / excessive values fail closed, in the parser AND the planner ----
  // "Absent or unusable as a number-of-record" resolves to the STRICTER production default rather
  // than to anything raised. That is deliberate: `arg()` cannot distinguish "--max-stretch omitted"
  // from "--max-stretch with no value", and falling back to 2.0 can only ever be MORE restrictive.
  for (const [label, raw] of [['empty string', ''], ['whitespace', '   '], ['undefined', undefined], ['null', null]] as [string, any][]) {
    const p = parseMaxStretchOverride(raw);
    check(`4b: ${label} resolves to the STRICTER production default (never a raised ceiling)`,
      p.ok === true && p.maxStretch === P.MAX_NARRATION_VIDEO_STRETCH && p.source === 'default', p);
  }
  const badRaw: [string, unknown][] = [
    ['non-numeric', 'abc'], ['trailing unit', '2.5x'], ['hex', '0x10'],
    ['Infinity string', 'Infinity'], ['NaN string', 'NaN'], ['negative', '-2.5'],
    ['zero', '0'], ['fraction below 1', '0.5'], ['above hard ceiling', '3.01'], ['absurd', '1000'],
    ['exponent form', '1e309'], ['comma decimal', '2,5'], ['double flag', '--force'],
  ];
  for (const [label, raw] of badRaw) {
    const p = parseMaxStretchOverride(raw);
    check(`4b: parser rejects ${label}`, p.ok === false, p);
    if (!p.ok) check(`4b: parser explains ${label}`, /--max-stretch/.test(p.reason), p.reason);
  }
  check('4b: parser accepts the hard ceiling exactly', parseMaxStretchOverride(String(ISOLATED_MAX_STRETCH_HARD_CEILING)).ok === true);
  check('4b: parser accepts the minimum useful value of 1', parseMaxStretchOverride('1').ok === true);
  check('4b: parser accepts Scene 2\'s exact requirement as a ceiling', parseMaxStretchOverride('2.42125').ok === true);
  check('4b: parser flags an explicit override distinctly from the default',
    parseMaxStretchOverride('2.5').ok === true && (parseMaxStretchOverride('2.5') as any).source === 'override');
  // the planner must not be bypassable by handing it a raw bad number
  for (const [label, raw] of [['NaN via planner', NaN], ['Infinity via planner', Infinity], ['excessive via planner', 99]] as [string, any][]) {
    const p = await planIsolatedSceneMix({ sceneNumber: 2, inputRoot: s2Root, validationRoot: s2ValRoot, maxStretch: raw });
    check(`4b: planner refuses ${label} (ceiling cannot be bypassed)`, p.ok === false && p.code === 'MAX_STRETCH_INVALID', { code: p.code, reason: p.reason });
  }

  // ---- (e) the override changes ELIGIBILITY ONLY ----
  const base15 = await planIsolatedSceneMix({ sceneNumber: 15, inputRoot, validationRoot, outputPath: path.join(validationRoot, 'x-a.mp4') });
  const sameCeiling = await planIsolatedSceneMix({ sceneNumber: 15, inputRoot, validationRoot, outputPath: path.join(validationRoot, 'x-b.mp4'), maxStretch: 2.0 });
  check('4b: the override does NOT change the planned output duration',
    Math.abs((base15.outputDuration ?? 0) - (sameCeiling.outputDuration ?? 0)) < 1e-12, { a: base15.outputDuration, b: sameCeiling.outputDuration });
  check('4b: the override does NOT change the stretch factor',
    Math.abs((base15.stretchFactor ?? 0) - (sameCeiling.stretchFactor ?? 0)) < 1e-12);
  const onlyPaths = (g: string | null) => String(g).replace(/\[v0\]/, '').replace(/\[[a-z0-9]+\]/g, '');
  check('4b: the override does NOT change the filter graph',
    onlyPaths(base15.graph) === onlyPaths(sameCeiling.graph), { a: onlyPaths(base15.graph), b: onlyPaths(sameCeiling.graph) });
  // The output path is argv's LAST element and is deliberately different between the two plans
  // (x-a vs x-b), so compare everything before it.
  const argvWithoutOutput = (a: string[]) => a.slice(0, -1).join(' ');
  check('4b: the override does NOT change the audio graph or argv (output path excluded)',
    base15.audioLabel === sameCeiling.audioLabel
    && argvWithoutOutput(base15.argvPreview!) === argvWithoutOutput(sameCeiling.argvPreview!),
    { a: argvWithoutOutput(base15.argvPreview!), b: argvWithoutOutput(sameCeiling.argvPreview!) });
  check('4b: the two plans differ ONLY in their output path',
    base15.argvPreview!.slice(0, -1).every((x, i) => x === sameCeiling.argvPreview![i])
    && base15.argvPreview!.at(-1) !== sameCeiling.argvPreview!.at(-1));
  check('4b: a raised ceiling leaves Scene 15 (inside policy) completely unaffected',
    base15.maxStretch === P.MAX_NARRATION_VIDEO_STRETCH && sameCeiling.maxStretch === 2.0);
  // the PRODUCTION policy is untouched by any of this
  check('4b: production MAX_NARRATION_VIDEO_STRETCH is still exactly 2.0', P.MAX_NARRATION_VIDEO_STRETCH === 2.0, P.MAX_NARRATION_VIDEO_STRETCH);
  const prod = P.decideNarrationPreservation({ sourceVideoDuration: S2_CLIP, narrationDuration: S2_NARR });
  check('4b: the production policy still rejects Scene 2 (override never leaks into it)',
    prod.ok === false && prod.reason === 'NARRATION_EXCEEDS_CLIP_LIMIT_EXCEEDED', prod.reason);
  check('4b: Scene 2 raises the policy limit to exactly 2.42125x',
    Math.abs((prod.stretchFactor ?? 0) - S2_FACTOR) < 1e-6, prod.stretchFactor);

  // ---- (f) path protections and overwrite refusal still work WITH the override ----
  const s2Out = path.join(s2ValRoot, 'scene-0002-mixed.mp4');
  fs.writeFileSync(s2Out, 'PRE-EXISTING-S2');
  const refused = await planIsolatedSceneMix({ sceneNumber: 2, inputRoot: s2Root, validationRoot: s2ValRoot, maxStretch: 2.5 });
  check('4b: overwrite refusal still applies when the ceiling is raised', refused.ok === false && refused.code === 'OUTPUT_EXISTS', { code: refused.code });
  check('4b: the pre-existing file was NOT touched by the refused plan', fs.readFileSync(s2Out, 'utf8') === 'PRE-EXISTING-S2');
  for (const prot of PROTECTED_FINAL_ARTEFACTS) {
    const r = await planIsolatedSceneMix({ sceneNumber: 2, inputRoot: s2Root, validationRoot: s2ValRoot, maxStretch: 2.5, outputPath: path.join(s2ValRoot, prot) });
    check(`4b: protected artefact ${prot} still refused with the override`, r.ok === false, r.code);
  }
  const sceneOut = await planIsolatedSceneMix({ sceneNumber: 2, inputRoot: s2Root, validationRoot: s2ValRoot, maxStretch: 2.5, outputPath: path.join(s2ValRoot, 'scene-0002.mp4') });
  check('4b: production scene output name still refused with the override',
    sceneOut.ok === false && sceneOut.code === 'OUTPUT_IS_SCENE_OUTPUT', sceneOut.code);
  const escaped = await planIsolatedSceneMix({ sceneNumber: 2, inputRoot: s2Root, validationRoot: s2ValRoot, maxStretch: 2.5, outputPath: path.join(tmp, 'escape.mp4') });
  check('4b: output outside the validation root still refused with the override',
    escaped.ok === false && escaped.code === 'OUTPUT_OUTSIDE_VALIDATION_ROOT', escaped.code);
  fs.rmSync(s2Out, { force: true });
  fs.rmSync(s2Root, { recursive: true, force: true });
  fs.rmSync(s2ValRoot, { recursive: true, force: true });
}

// ===== 5. refuse to overwrite =====
{
  fs.mkdirSync(validationRoot, { recursive: true });
  const target = path.join(validationRoot, 'scene-0015-mixed.mp4');
  fs.writeFileSync(target, 'PRE-EXISTING');
  const blocked = await planIsolatedSceneMix({ sceneNumber: 15, inputRoot, validationRoot });
  check('5: pre-existing output -> OUTPUT_EXISTS (refuses by default)', blocked.ok === false && blocked.code === 'OUTPUT_EXISTS', blocked.code);
  check('5: refusal reports the exact path', blocked.outputPath === target && String(blocked.reason).includes(target), { outputPath: blocked.outputPath, reason: blocked.reason });
  check('5: pre-existing file was NOT modified', fs.readFileSync(target, 'utf8') === 'PRE-EXISTING');
  const forced = await planIsolatedSceneMix({ sceneNumber: 15, inputRoot, validationRoot, force: true });
  check('5: --force allows planning over an existing file', forced.ok === true, forced.code);
  fs.rmSync(target, { force: true });
}

// ===== 6. output-path containment + protected-path rejection =====
{
  const outside = await planIsolatedSceneMix({ sceneNumber: 15, inputRoot, validationRoot, outputPath: path.join(tmp, 'escaped.mp4') });
  check('6: output OUTSIDE validationRoot -> OUTPUT_OUTSIDE_VALIDATION_ROOT',
    outside.ok === false && outside.code === 'OUTPUT_OUTSIDE_VALIDATION_ROOT', outside.code);
  const traversal = await planIsolatedSceneMix({ sceneNumber: 15, inputRoot, validationRoot, outputPath: path.join(validationRoot, '..', 'final-narrated.mp4') });
  check('6: ../ traversal -> OUTPUT_OUTSIDE_VALIDATION_ROOT',
    traversal.ok === false && traversal.code === 'OUTPUT_OUTSIDE_VALIDATION_ROOT', traversal.code);
  for (const prot of PROTECTED_FINAL_ARTEFACTS) {
    const r = await planIsolatedSceneMix({ sceneNumber: 15, inputRoot, validationRoot, outputPath: path.join(validationRoot, prot) });
    check(`6: protected final artefact ${prot} -> refused`,
      r.ok === false && (r.code === 'OUTPUT_IS_PROTECTED_FINAL_ARTEFACT' || r.code === 'OUTPUT_OUTSIDE_VALIDATION_ROOT'), r.code);
  }
  // a production scene output name is refused even inside the validation root
  const sceneOut = await planIsolatedSceneMix({ sceneNumber: 15, inputRoot, validationRoot, outputPath: path.join(validationRoot, 'scene-0015.mp4') });
  check('6: production scene output name -> OUTPUT_IS_SCENE_OUTPUT',
    sceneOut.ok === false && sceneOut.code === 'OUTPUT_IS_SCENE_OUTPUT', sceneOut.code);
  // relative roots are refused outright
  const rel = await planIsolatedSceneMix({ sceneNumber: 15, inputRoot: 'inputs', validationRoot });
  check('6: relative inputRoot -> INPUT_ROOT_ESCAPED', rel.ok === false && rel.code === 'INPUT_ROOT_ESCAPED', rel.code);
  const relv = await planIsolatedSceneMix({ sceneNumber: 15, inputRoot, validationRoot: 'out' });
  check('6: relative validationRoot -> VALIDATION_ROOT_INVALID', relv.ok === false && relv.code === 'VALIDATION_ROOT_INVALID', relv.code);
  // path containment primitive itself
  check('6: isPathInside rejects a sibling and accepts a child',
    isPathInside(validationRoot, path.join(validationRoot, 'x.mp4')) === true
    && isPathInside(validationRoot, path.join(tmp, 'x.mp4')) === false);
}

// ===== 7. no project-wide stage / orchestrator calls =====
{
  const fs2 = await import('node:fs');
  const code = fs2.readFileSync(`${SRC}/isolatedSceneMix.ts`, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  check('7: isolated module imports NO orchestrator/workflow/stage/approval/publishing module',
    !/projectWorkflow|productionOrchestrator|downstreamStages|stageExecutor|approval|publish|runner|edit\.js|addMusicBed|addTitle/.test(code), code.slice(0, 400));
  check('7: isolated module imports NO Flow/browser/HTTP client',
    !/flowClient|playwright|chromium|flowSession|axios|fetch\(|request\./.test(code));
  check('7: isolated module invokes no EDIT/BED/TITLE/APPROVAL stage',
    !/'EDIT'|'BED'|'TITLE'|'APPROVAL'|executeDownstreamChain|resumeProjectWorkflow/.test(code));
  // The protected names may appear ONLY inside the denylist that REFUSES them; nowhere else — in
  // particular never as an ffmpeg destination or an fs write/copy target.
  const denylist = code.match(/PROTECTED_FINAL_ARTEFACTS\s*=\s*\[[^\]]*\]/);
  check('7: the protected final names appear only in the denylist array', denylist !== null, code.slice(0, 200));
  check('7: isolated module NEVER writes final-narrated/final-bedded/final-title',
    !/final-narrated|final-bedded|final-title|final\.mp4/.test(code.replace(denylist![0], '')),
    code.replace(denylist![0], '').match(/.{0,80}final-.{0,80}/g));
  check('7: isolated module reuses the SHARED policy (single arithmetic source)',
    /decideNarrationPreservation/.test(code) && /MAX_NARRATION_VIDEO_STRETCH/.test(code));
  check('7: isolated module reuses the REAL MIX graph + argv builders',
    /buildMixFilterGraph/.test(code) && /buildMixOutputArgs/.test(code));
  // the CLI wires only the isolated operation
  const vcode = fs2.readFileSync(`${SRC}/video.ts`, 'utf8');
  const segStart = vcode.indexOf("command === 'mix-validate'");
  const segEnd = vcode.indexOf('console.error(renderUsage());', segStart);
  // The slice must span exactly the mix-validate branch; a missing anchor would otherwise
  // silently widen it to the end of the file.
  check('7: the mix-validate branch and its terminator both exist', segStart >= 0 && segEnd > segStart, { segStart, segEnd });
  const seg = vcode.slice(segStart, segEnd);
  check('7: the mix-validate CLI branch calls ONLY plan+runIsolatedSceneMix',
    /planIsolatedSceneMix/.test(seg) && /runIsolatedSceneMix/.test(seg)
    && !/resumeProjectWorkflow|createProjectWorkflow|approveProject|publishReadiness|createRealFlowRunner|withFlowSession|createRealSceneExecutor/.test(seg), seg.slice(0, 300));
  check('7: mix-validate appears in the CLI usage/help text', /mix-validate/.test(vcode));
}

// ===== 8. existing normal MIX behaviour remains compatible =====
// `mixNarration.ts` is a CLI script: importing it executes its top-level render. Point it at a
// throwaway fixture directory that satisfies its own >=2-clip precondition so the import is
// harmless. This is the same technique mix_narration_fix_test.mts uses.
{
  const fxDir = path.join(tmp, 'miximport');
  const fxNarr = path.join(tmp, 'miximport-narr');
  const fxOut = path.join(tmp, 'miximport-out.mp4');
  fs.mkdirSync(fxDir, { recursive: true });
  fs.mkdirSync(fxNarr, { recursive: true });
  await mkVideo(path.join(fxDir, 'scene-0001.mp4'), 3);
  await mkVideo(path.join(fxDir, 'scene-0002.mp4'), 3);
  await mkWav(path.join(fxNarr, 'narration-0001.wav'), 2);
  process.argv.push('--input-dir', fxDir, '--narration-dir', fxNarr, '--output', fxOut);
  const mx: any = await import(pathToFileURL(`${SRC}/mixNarration.ts`).href);
  const g = mx.buildMixFilterGraph({
    sceneCount: 2, durations: [8, 8], outputDurations: [8, 8],
    narrationInputs: [[1, 'n1.wav']], narrationIndex: new Map([[1, 2]]),
    narrationMakeupDb: 12, transition: 0.35, bgm: undefined, bgmLufs: -20.9,
  });
  check('8: buildMixFilterGraph still exported and unchanged for a 2-scene plan', typeof g.graph === 'string' && g.graph.length > 0);
  check('8: MIX_OUT_SAMPLE_RATE / CHANNELS still exported', mx.MIX_OUT_SAMPLE_RATE === 48000 && mx.MIX_OUT_CHANNELS === 2);
  const args = mx.buildMixOutputArgs({ sceneFiles: ['a.mp4'], narrationFiles: ['n.wav'], bgm: undefined, graph: 'g', videoLabel: 'v0', audioLabel: 'a0', output: 'o.mp4' });
  check('8: buildMixOutputArgs contract intact', args.includes('libx264') && args.includes('yuv420p') && args.at(-1) === 'o.mp4');
  // the isolated argv builder is the SAME function
  check('8: isolated argv is produced by buildMixOutputArgs (not a fork)',
    String((await planIsolatedSceneMix({ sceneNumber: 21, inputRoot, validationRoot })).argvPreview).includes('libx264'));
  // duration policy module untouched
  check('8: NARRATION_TAIL_SECONDS still 0.25 and MAX still 2.0 (unchanged)',
    P.NARRATION_TAIL_SECONDS === 0.25 && P.MAX_NARRATION_VIDEO_STRETCH === 2.0);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nALL PASS  (${passed} checks)`);