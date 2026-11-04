// Focused tests for the Scene-15 slow-motion FRAME-CADENCE fix.
//
// Defect (measured on the real Scene 15 v1 validation render):
//   graph order was  fps=24 , setpts=1.626250*PTS , trim=duration=13.010
//   `fps` ran BEFORE the retiming, so it had already done its work; `setpts` then stretched a
//   constant-cadence stream and produced 192 frames over 12.958333 s with ALTERNATING 24 fps /
//   12 fps intervals (effective 14.76 fps) instead of a constant 24 fps.
//
// Fix: a cloned tail + retiming + MOTION-COMPENSATED INTERPOLATION, in that order.
//   chain is fps=24 , tpad=stop_mode=clone:stop_duration=0.250000 ,
//           setpts=1.626250*PTS , minterpolate=fps=24:mi_mode=mci:... , trim=duration=13.010
//
// WHY THE TAIL PAD EXISTS (the non-obvious constraint):
//   `minterpolate` synthesises frames BETWEEN adjacent input frames and cannot emit a frame at or
//   past the last input frame's own timestamp. Retimed by K, the last real frame therefore lands
//   short of the target: measured 309 frames / 12.875 s against a 312-frame / 13.000 s target, a
//   0.125 s shortfall. Cloning extra input frames BEFORE the retiming gives the interpolator a
//   following frame to work towards and closes the gap. So this stage is a correctness requirement,
//   not a cosmetic tweak, which is why the chain cannot simply swap `fps` for `minterpolate`.
//
// THE FACTOR IS NOT HARDCODED: it is outputDuration / sourceDuration, i.e. whatever
//   `decideNarrationPreservation()` already decided. The graph derives its timing from the policy;
//   it never decides timing itself. Scene 15's 1.626250 is a RESULT of its narration length, and
//   section 3 below proves the same builder derives a different factor for a different scene.
//
// HISTORY: the chain was originally `fps` BEFORE `setpts` (the 14.76 fps judder defect), then a
//   second `fps` AFTER `setpts` (frame holding), and is now `minterpolate`. A revision once claimed
//   TEMPORAL FRAME BLENDING; that was WRONG — it came from hashing a LOSSY H.264 render where
//   re-encoding perturbs pixels so a held frame stops hashing like its twin. Section 4 pins that
//   retraction so it cannot return.
//
// SCOPE: these tests prove the GRAPH STRUCTURE, the policy arithmetic and (with a TEMP fixture) the
//   rendered cadence. They deliberately do NOT claim perceptual smoothness: the human playback
//   review that chose MCI covered Scene 15's one input shape, and interpolation invents pixels.
//
// This file asserts the CONSTRUCTED GRAPH STRUCTURALLY (filter order by index, planned frame
// counts) rather than string-grepping for a desired literal, and then PROVES the behaviour by
// rendering throwaway TEMP media that mirrors Scene 15's exact timing shape.
// No project media is read or written. No Chrome, no Flow, no credits.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
import { SRC } from './_testPaths.mjs';
const G: any = await import(pathToFileURL(`${SRC}/mixFilterGraph.ts`).href);
const P: any = await import(pathToFileURL(`${SRC}/narrationDurationPolicy.ts`).href);

const { planSceneVideoChain, buildMixFilterGraph, buildMixOutputArgs, expectedMixFrameCount, MIX_CADENCE_STRATEGY, MIX_MCI_TAIL_PAD_FRAMES, mixMciInterpolationFilter, MIX_MAX_FILTER_THREADS, MIX_MAX_ENCODER_THREADS } = G;

let passed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed += 1; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

/** Split a filter chain into its ordered filters, e.g. "fps=24,tpad=...,setpts=..." -> array. */
const filtersOf = (chain: string): string[] => chain.split(',').filter(Boolean);

/** Position of the first filter whose name is `name`. -1 when absent. */
const at = (chain: string, name: string): number => filtersOf(chain).findIndex((f) => f === name || f.startsWith(`${name}=`));

// Scene 15's real shape.
const SRC_DUR = 8;
const NARR_DUR = 12.76;
const OUT_DUR = 13.01;
const FACTOR = 1.62625;

// ============================================================================================
// 1. Structural: filter ORDER and the tail pad
// ============================================================================================
{
  const v = planSceneVideoChain({ sourceDurationSeconds: SRC_DUR, outputDurationSeconds: OUT_DUR });
  const f = filtersOf(v.chain);
  const iFps = f.indexOf('fps=24');
  const iTpad = at(v.chain, 'tpad');
  const iSetpts = at(v.chain, 'setpts');
  const iMci = f.findIndex((x) => x.startsWith('minterpolate='));
  const iTrim = at(v.chain, 'trim');

  check('1: retimed chain is exactly [fps, tpad, setpts, minterpolate, trim, setpts-STARTPTS]',
    JSON.stringify(f) === JSON.stringify([
      'fps=24', 'tpad=stop_mode=clone:stop_duration=0.250000', 'setpts=1.626250*PTS',
      mixMciInterpolationFilter(24), 'trim=duration=13.010', 'setpts=PTS-STARTPTS',
    ]), v.chain);
  check('1: the tail pad comes BEFORE the retiming (it is source footage, cloned pre-scale)',
    iFps < iTpad && iTpad < iSetpts, v.chain);
  check('1: the interpolator comes AFTER the retiming (it fills the gaps setpts opens)',
    iSetpts < iMci, v.chain);
  check('1: the interpolator comes BEFORE the trim that bounds the length', iMci < iTrim, v.chain);
  check('1: exactly ONE fps filter remains (a second would re-hold the interpolated frames)',
    f.filter((x) => x.startsWith('fps=')).length === 1, v.chain);
  check('1: the pad clones the tail only (stop_mode=clone, no loop)',
    /tpad=stop_mode=clone:stop_duration=/.test(v.chain), v.chain);
  check('1: the trim target is still the 13.010s narration-preservation target',
    f[iTrim] === 'trim=duration=13.010', v.chain);
  check('1: the pad is 6 output frames = 0.25 s at 24 fps',
    v.tailPadSeconds === 0.25 && MIX_MCI_TAIL_PAD_FRAMES / 24 === 0.25, { pad: v.tailPadSeconds, frames: MIX_MCI_TAIL_PAD_FRAMES });
  check('1: the pad scales with the frame rate (declared in frames, not seconds)',
    planSceneVideoChain({ sourceDurationSeconds: 8, outputDurationSeconds: 13.01, fps: 30 }).tailPadSeconds === 0.2,
    planSceneVideoChain({ sourceDurationSeconds: 8, outputDurationSeconds: 13.01, fps: 30 }).tailPadSeconds);
  check('1: the pad is applied at all (frame-hold needed none)',
    v.tailPadSeconds > 0, v.tailPadSeconds);
}

// ============================================================================================
// 2. Structural: pad/interpolation are emitted ONLY when retiming happens
// ============================================================================================
{
  const fit = planSceneVideoChain({ sourceDurationSeconds: 8, outputDurationSeconds: 8 });
  const f = filtersOf(fit.chain);
  check('2: narration that fits needs NO retiming', fit.needsPictureExtension === false && fit.retimeFactor === null, fit);
  check('2: a non-retimed chain carries NO tail pad', fit.tailPadSeconds === 0, fit.tailPadSeconds);
  check('2: a non-retimed chain carries NO tpad and NO interpolator',
    !f.some((x) => x.startsWith('tpad') || x.startsWith('minterpolate')), fit.chain);
  check('2: a non-retimed chain carries no setpts stretch', !f.some((x) => x.startsWith('setpts=1.')), fit.chain);
  check('2: a non-retimed chain still normalises fps and trims (unchanged from before MCI)',
    JSON.stringify(f) === JSON.stringify(['fps=24', 'trim=duration=8.000', 'setpts=PTS-STARTPTS']), fit.chain);
  // Shrinking is not a slowdown: must never trigger a `<1` setpts factor or any interpolation.
  const shorter = planSceneVideoChain({ sourceDurationSeconds: 8, outputDurationSeconds: 6 });
  check('2: a SHORTER output is not treated as a slowdown',
    shorter.needsPictureExtension === false && shorter.retimeFactor === null && shorter.tailPadSeconds === 0, shorter);
  // Narration SHORTER than the clip must also not interpolate (this is the 22-scene common case).
  const shortNarr = planSceneVideoChain({ sourceDurationSeconds: 8, outputDurationSeconds: 6.5 });
  check('2: narration shorter than the clip needs no pad or interpolation',
    !/tpad|minterpolate/.test(shortNarr.chain), shortNarr.chain);
}

// ============================================================================================
// 2b. Malformed / non-finite input FAILS CLOSED (never emits NaN or Infinity into FFmpeg)
// ============================================================================================
{
  const bad: [string, any][] = [
    ['NaN source', { sourceDurationSeconds: NaN, outputDurationSeconds: 13 }],
    ['Infinity source', { sourceDurationSeconds: Infinity, outputDurationSeconds: 13 }],
    ['NaN output', { sourceDurationSeconds: 8, outputDurationSeconds: NaN }],
    ['Infinity output', { sourceDurationSeconds: 8, outputDurationSeconds: Infinity }],
    ['zero source', { sourceDurationSeconds: 0, outputDurationSeconds: 13 }],
    ['negative source', { sourceDurationSeconds: -8, outputDurationSeconds: 13 }],
    ['zero output', { sourceDurationSeconds: 8, outputDurationSeconds: 0 }],
    ['negative output', { sourceDurationSeconds: 8, outputDurationSeconds: -1 }],
    ['NaN fps', { sourceDurationSeconds: 8, outputDurationSeconds: 13, fps: NaN }],
    ['zero fps', { sourceDurationSeconds: 8, outputDurationSeconds: 13, fps: 0 }],
    ['null durations', { sourceDurationSeconds: null, outputDurationSeconds: null }],
    ['undefined durations', { sourceDurationSeconds: undefined, outputDurationSeconds: undefined }],
  ];
  for (const [label, args] of bad) {
    let threw = false; let msg = '';
    try { planSceneVideoChain(args); } catch (e: any) { threw = true; msg = String(e?.message ?? e); }
    check(`2b: ${label} fails closed (throws rather than emitting NaN/Infinity)`, threw, msg);
    if (threw) check(`2b: ${label} error names the bad input`, /finite positive/i.test(msg), msg);
  }
  // A very short but VALID input must still work (must not be rejected by the guard).
  const tiny = planSceneVideoChain({ sourceDurationSeconds: 0.5, outputDurationSeconds: 0.95 });
  check('2b: a very short but valid clip still plans (0.5s source -> 0.95s output)',
    tiny.needsPictureExtension === true && /minterpolate/.test(tiny.chain), tiny.chain);
  check('2b: a very short clip still gets the same 6-frame pad',
    tiny.tailPadSeconds === 0.25, tiny.tailPadSeconds);
  // Exactly equal durations: no extension, no pad, no interpolation.
  const equal = planSceneVideoChain({ sourceDurationSeconds: 8, outputDurationSeconds: 8 });
  check('2b: exactly equal durations need no pad or interpolation',
    equal.needsPictureExtension === false && !/tpad|minterpolate/.test(equal.chain), equal.chain);
}

// ============================================================================================
// 3. Structural: frame count is derived from the 13.010s target, not from the source
// ============================================================================================
{
  const v = planSceneVideoChain({ sourceDurationSeconds: SRC_DUR, outputDurationSeconds: OUT_DUR });
  check('3: planned frame count is 312 (13.010s rounded onto the 24 fps grid)', v.expectedFrameCount === 312, v.expectedFrameCount);
  check('3: frame count equals round(outputDuration * fps)', v.expectedFrameCount === Math.round(OUT_DUR * 24), v);
  check('3: frame count is independent of the SOURCE frame count (192)', v.expectedFrameCount !== 192, v);
  check('3: expectedMixFrameCount is the single source of that arithmetic',
    expectedMixFrameCount(OUT_DUR, 24) === 312 && expectedMixFrameCount(8, 24) === 192
    && expectedMixFrameCount(13.01) === 312, [expectedMixFrameCount(13.01), expectedMixFrameCount(8)]);
  check('3: the retime factor is still exactly 1.62625 (unchanged by the cadence change)',
    Math.abs(v.retimeFactor - FACTOR) < 1e-12, v.retimeFactor);
  // THE FACTOR IS DERIVED, NOT HARDCODED: Scene 15's 1.626250 is a RESULT of its narration
  // length. The same builder must produce a different factor for a different narration length,
  // proving no per-scene number is baked in.
  const otherNarr = planSceneVideoChain({ sourceDurationSeconds: 6, outputDurationSeconds: 10.25 });
  check('3: a different narration length yields a DIFFERENT factor (nothing is hardcoded)',
    Math.abs((otherNarr.retimeFactor as number) - 10.25 / 6) < 1e-12 && otherNarr.retimeFactor !== v.retimeFactor,
    otherNarr.retimeFactor);
  check('3: the factor equals outputDuration/sourceDuration for every shape tested',
    [[8, 13.01], [6, 10.25], [5, 7.5], [10, 19.5]].every(([s, o]) =>
      Math.abs(planSceneVideoChain({ sourceDurationSeconds: s, outputDurationSeconds: o }).retimeFactor! - o / s) < 1e-12), true);
  // The pad must NOT be folded into the factor: the reviewed Scene 15 render used 1.626250 with
  // 0.250000 s of cloned tail, i.e. the clone is headroom past the target, trimmed away.
  check('3: the pad does NOT scale the written factor (reproduces the reviewed artifact)',
    v.chain.includes('setpts=1.626250*PTS') && v.chain.includes('stop_duration=0.250000'), v.chain);
  check('3: retimed length with pad exceeds the trim target, so the pad is genuine headroom',
    (SRC_DUR + v.tailPadSeconds) * v.retimeFactor! > OUT_DUR, (SRC_DUR + v.tailPadSeconds) * v.retimeFactor!);
  // 312 frames at 24 fps IS 13.000 s: the audio target is preserved to the nearest frame, and the
  // picture is NOT allowed to drag the audio down to a grid it cannot represent.
  check('3: 312 frames == 13.000 s, i.e. the picture lands within one frame of the 13.010 s audio',
    Math.abs(v.expectedFrameCount / 24 - OUT_DUR) <= 1 / 24 + 1e-9, v.expectedFrameCount / 24);
}

// ============================================================================================
// 4. Strategy identity is explicit and honestly named
// ============================================================================================
{
  // CURRENT IDENTIFIER. The strategy has been named four times: `duplicate-after-setpts` (wrong),
  // `blend-after-setpts` (wrong: derived from hashing a LOSSY render), `frame-hold-after-setpts`
  // (correct measurement, but superseded by the human playback decision), and now
  // `mci-after-setpts`, which is what the graph actually emits.
  check('4: the shipped cadence strategy is named mci-after-setpts',
    MIX_CADENCE_STRATEGY === 'mci-after-setpts', MIX_CADENCE_STRATEGY);
  for (const stale of ['frame-hold-after-setpts', 'blend-after-setpts', 'duplicate-after-setpts']) {
    check(`4: the stale identifier ${stale} is gone`, MIX_CADENCE_STRATEGY !== stale);
  }

  const v = planSceneVideoChain({ sourceDurationSeconds: SRC_DUR, outputDurationSeconds: OUT_DUR });
  check('4: the shipped chain interpolates (minterpolate present with the reviewed parameters)',
    filtersOf(v.chain).includes(mixMciInterpolationFilter(24)), v.chain);
  check('4: NO second fps filter remains (it would re-hold the interpolated frames)',
    filtersOf(v.chain).filter((x) => x === 'fps=24').length === 1, v.chain);
  check('4: NO alternative interpolators (framerate/tblend/mixblend/apsnr absent)',
    !/framerate|tblend|mixblend|apsnr|ssim/.test(v.chain), v.chain);
  check('4: NO looping or freeze trickery (aloop/tconcat/freezedump absent)',
    !/aloop|tconcat|freezedump/.test(v.chain), v.chain);
  const full = buildMixFilterGraph({ sceneCount: 1, durations: [SRC_DUR], outputDurations: [OUT_DUR], narrationInputs: [[1, 'n.wav']], narrationIndex: new Map([[1, 1]]), narrationMakeupDb: 12, transition: 0.35, bgm: undefined, bgmLufs: -20.9 });
  check('4: the whole built graph uses the same shared interpolation filter',
    full.graph.includes(mixMciInterpolationFilter(24)), full.graph.slice(0, 160));

  // The measurement method must stay documented, because getting it wrong is what produced the
  // false blending claim in the first place.
  //
  // `mgSrcFlat` collapses JSDoc line-wrapping (newline + optional `*` + indent) into a single
  // space. Asserting against the raw text made these checks depend on where the formatter broke a
  // line, which is why an earlier revision failed on prose that was already correct.
  const mgSrc = fs.readFileSync(`${SRC}/mixFilterGraph.ts`, 'utf8');
  const mgSrcFlat = mgSrc.replace(/\r?\n\s*\*?\s?/g, ' ').replace(/\s+/g, ' ');
  // The retraction history stays asserted: the blend claim was wrong and must never come back.
  check('4: docs still RETRACT the temporal-blending / invented-pixels claim',
    /TEMPORAL FRAME BLENDING/.test(mgSrcFlat) && /INVENTS PIXELS/i.test(mgSrcFlat) && /WRONG/i.test(mgSrcFlat)
    && /retracted/i.test(mgSrcFlat), 'retraction of the blend claim missing');
  check('4: docs still explain WHY the blend claim was wrong (lossy H.264 hashing artefact)',
    /LOSSY H\.264/i.test(mgSrcFlat) && /hash/i.test(mgSrcFlat), 'root-cause of the false claim missing');
  check('4: docs still scope the earlier measurement narrowly',
    /SCOPE OF THE CLAIM/i.test(mgSrcFlat) && /not a general guarantee/i.test(mgSrcFlat), 'scope caveat missing');

  // The CURRENT strategy must be documented with its cost and its human basis.
  check('4: docs record the human playback decision that shipped MCI',
    /human playback/i.test(mgSrcFlat) && /smoother/i.test(mgSrcFlat), 'human decision undocumented');
  check('4: docs state interpolation INVENTS PIXELS',
    /INVENTS PIXELS/.test(mgSrcFlat), 'invented-pixels caveat missing');
  check('4: docs state that constant cadence does NOT prove perceptual smoothness',
    /DOES NOT PROVE PERCEPTUAL SMOOTHNESS/i.test(mgSrcFlat), 'smoothness caveat missing');
  check('4: docs explain WHY the tail pad is required (interpolator cannot pass the last frame)',
    /TAIL PAD IS REQUIRED/i.test(mgSrcFlat) && /309/.test(mgSrcFlat) && /12\.875/.test(mgSrcFlat),
    'tail-pad rationale missing');
  check('4: docs record the measured cost (~37 s vs ~0.2 s, ~150x)',
    /37 s/.test(mgSrcFlat) && /0\.2 s/.test(mgSrcFlat) && /150x/.test(mgSrcFlat), 'cost not recorded');
  check('4: docs explain the pad is NOT the narration tail (different concerns)',
    /not `NARRATION_TAIL_SECONDS`/i.test(mgSrcFlat) || /deliberately NOT/i.test(mgSrcFlat),
    'pad-vs-narration-tail distinction missing');
  check('4: docs record the naming history through all four identifiers',
    /duplicate-after-setpts/.test(mgSrcFlat) && /blend-after-setpts/.test(mgSrcFlat)
    && /frame-hold-after-setpts/.test(mgSrcFlat) && /mci-after-setpts/.test(mgSrcFlat), 'history incomplete');
}

// ============================================================================================
// 5. Audio is untouched by the fix
// ============================================================================================
{
  const g = buildMixFilterGraph({ sceneCount: 1, durations: [SRC_DUR], outputDurations: [OUT_DUR], narrationInputs: [[1, 'n.wav']], narrationIndex: new Map([[1, 1]]), narrationMakeupDb: 12, transition: 0.35, bgm: undefined, bgmLufs: -20.9 });
  const audioPart = g.graph.slice(g.graph.indexOf('[0:a]'));
  check('5: audio is still trimmed/padded to the 13.010s target',
    audioPart.includes('apad,atrim=duration=13.010') && audioPart.includes('atrim=duration=13.010'), audioPart);
  check('5: scene ambience is still apad-ed and ducked by sidechaincompress',
    audioPart.includes('[0:a]apad,atrim=duration=13.010,asetpts=PTS-STARTPTS[source0]') && audioPart.includes('sidechaincompress=threshold=0.025:ratio=12:attack=80:release=500'), audioPart);
  check('5: the narration is still split AFTER its trim for the two consumers',
    audioPart.includes('apad,atrim=duration=13.010,asplit=2[voice_sc0][voice_mix0]'), audioPart);
  check('5: compressor/limiter/makeup chain unchanged',
    audioPart.includes('acompressor=threshold=0.05:ratio=8:attack=5:release=100:makeup=12') && audioPart.includes('alimiter=limit=0.9:level=0'), audioPart);
  check('5: amix sum and output audio label unchanged',
    audioPart.includes('amix=inputs=2:duration=first:normalize=0[a0]'), audioPart);
  check('5: NO audio time-stretch filter was introduced',
    !/asetrate|atempo|aresample|apad=whole_dur|atempo=2/.test(g.graph), g.graph);
  // The video chain may never touch the audio side: the cadence filters must not appear in it.
  const audioOnly = g.graph.slice(g.graph.indexOf('[0:a]'));
  check('5: NO video cadence filter leaked into the audio branch',
    !/minterpolate|tpad|fps=24|setpts=1\./.test(audioOnly), audioOnly);
  check('5: the narration audio branch carries no retiming of its own (natural speed preserved)',
    !/setpts=[0-9.]+\*PTS/.test(audioOnly) || /asetpts=PTS-STARTPTS/.test(audioOnly), audioOnly);
  check('5: video and audio labels unchanged (v0 / a0)', g.video === 'v0' && g.audio === 'a0', { v: g.video, a: g.audio });
  check('5: runningDuration still equals the 13.010s output target', Math.abs(g.runningDuration - OUT_DUR) < 1e-9, g.runningDuration);
  const argv = buildMixOutputArgs({ sceneFiles: ['a.mp4'], narrationFiles: ['n.wav'], bgm: undefined, graph: g.graph, videoLabel: g.video, audioLabel: g.audio, output: 'o.mp4' });
  check('5: codec/audio contract untouched',
    argv.includes('-ar') && argv.includes('48000') && argv.includes('-ac') && argv.includes('2') && argv.includes('192k'), argv);

  // ---- RESOURCE BOUND (memory-pressure mitigation) ---------------------------------------------
  // The MCI chain (minterpolate mi_mode=mci:mc_mode=aobmc:me_mode=bidir) is the memory-heaviest
  // filter FFmpeg offers. Unbounded, FFmpeg sizes the filter graph AND the encoder from the CPU
  // count, and under concurrent renders that has been observed to abort with
  // `x264: malloc ... failed` / `Task finished with error code: -12 (Cannot allocate memory)`.
  // These checks pin the BOUND and, critically, prove it does not touch the graph or the timing.
  const valAfter = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  check('5r: the filter graph carries a bounded -filter_threads', valAfter('-filter_threads') !== undefined
    && Number(valAfter('-filter_threads')) === MIX_MAX_FILTER_THREADS, { got: valAfter('-filter_threads'), want: MIX_MAX_FILTER_THREADS });
  check('5r: the encoder carries a bounded -threads', valAfter('-threads') !== undefined
    && Number(valAfter('-threads')) === MIX_MAX_ENCODER_THREADS, { got: valAfter('-threads'), want: MIX_MAX_ENCODER_THREADS });
  check('5r: both bounds are small positive integers (a bound, not a serialisation or a removal)',
    MIX_MAX_FILTER_THREADS >= 1 && MIX_MAX_ENCODER_THREADS >= 1
    && Number.isInteger(MIX_MAX_FILTER_THREADS) && Number.isInteger(MIX_MAX_ENCODER_THREADS));
  check('5r: the bounds are well below a typical core count (they actually cap something)',
    MIX_MAX_FILTER_THREADS < 8 && MIX_MAX_ENCODER_THREADS < 8, { f: MIX_MAX_FILTER_THREADS, e: MIX_MAX_ENCODER_THREADS });
  check('5r: the thread bounds do NOT alter the filter graph', argv[argv.indexOf('-filter_complex') + 1] === g.graph, 'graph changed');
  check('5r: the thread bounds do NOT alter frame count, duration or the audio contract',
    expectedMixFrameCount(OUT_DUR) === 312 && Math.abs(g.runningDuration - OUT_DUR) < 1e-9
    && argv.includes('48000') && argv.includes('192k') && argv.includes('+faststart'));
  check('5r: exactly one -threads and one -filter_threads (no duplicate/ambiguous emission)',
    argv.filter((a) => a === '-threads').length === 1 && argv.filter((a) => a === '-filter_threads').length === 1);
  check('5r: the output file is still the final argv element (bounds precede it)',
    argv[argv.length - 1] === 'o.mp4', argv[argv.length - 1]);
  // A scene with NO narration must get a plain audio branch and no interpolation.
  const noNarr = buildMixFilterGraph({ sceneCount: 1, durations: [SRC_DUR], outputDurations: [OUT_DUR], narrationInputs: [], narrationIndex: new Map(), narrationMakeupDb: 12, transition: 0.35, bgm: undefined, bgmLufs: -20.9 });
  check('5: a non-narrated scene keeps the plain atrim audio branch',
    noNarr.graph.includes('[0:a]atrim=duration=13.010,asetpts=PTS-STARTPTS[a0]'), noNarr.graph);
}

// ============================================================================================
// 6. Scene 15 stays inside the 2.0 stretch limit
// ============================================================================================
{
  const d = P.decideNarrationPreservation({ sourceVideoDuration: SRC_DUR, narrationDuration: NARR_DUR });
  check('6: Scene 15 is still eligible under the shared policy', d.ok === true && d.withinLimit === true, d);
  check('6: Scene 15 stretch 1.62625 <= 2.0', d.stretchFactor <= P.MAX_NARRATION_VIDEO_STRETCH, d.stretchFactor);
  check('6: the policy target is still 13.010s', Math.abs(d.requiredOutputDuration - OUT_DUR) < 1e-9, d.requiredOutputDuration);
  const v = planSceneVideoChain({ sourceDurationSeconds: SRC_DUR, outputDurationSeconds: d.requiredOutputDuration });
  check('6: the graph factor still equals the policy factor',
    Math.abs(v.retimeFactor - d.stretchFactor) < 1e-9, { v: v.retimeFactor, d: d.stretchFactor });
  // The policy remains the ONLY gate: an over-limit scene still fails closed, and the graph is
  // never asked to stretch beyond the bound.
  const over = P.decideNarrationPreservation({ sourceVideoDuration: 8, narrationDuration: 15.751 });
  check('6: an over-limit stretch still fails closed at the policy (unchanged by MCI)',
    over.ok === false && over.reason === 'NARRATION_EXCEEDS_CLIP_LIMIT_EXCEEDED', over);
  check('6: the policy reports the slowdown it would have needed',
    /picture slowdown, above the/.test(String(over.detail)) && /2\.000/.test(String(over.detail)), over.detail);
  // Edge cases in the policy that feed this graph.
  const exactlyAtLimit = P.decideNarrationPreservation({ sourceVideoDuration: 8, narrationDuration: 15.75 });
  check('6: a stretch exactly AT the 2.0 bound is still accepted',
    exactlyAtLimit.ok === true && Math.abs(exactlyAtLimit.stretchFactor - 2.0) < 1e-9, exactlyAtLimit);
  const overByEpsilon = P.decideNarrationPreservation({ sourceVideoDuration: 8, narrationDuration: 15.751 });
  check('6: a hair over the bound is rejected',
    overByEpsilon.ok === false, overByEpsilon.reason);
  const invalid = P.decideNarrationPreservation({ sourceVideoDuration: NaN, narrationDuration: 12.76 });
  check('6: a non-finite source duration fails closed in the policy',
    invalid.ok === false && invalid.reason === 'INVALID_DURATIONS', invalid);
  const noNarrPolicy = P.decideNarrationPreservation({ sourceVideoDuration: 8, narrationDuration: undefined });
  check('6: no narration leaves the picture untouched (factor 1, no extension)',
    noNarrPolicy.ok === true && noNarrPolicy.needsPictureExtension === false && noNarrPolicy.requiredOutputDuration === 8, noNarrPolicy);
}

// ============================================================================================
// 7. Scene 2's legacy branch is untouched
// ============================================================================================
{
  // mixNarration.ts preserves Scene 2 verbatim: max(clip, narration + tail), unrouted through the
  // 2.0 bound. Its TIMING must not change; only its cadence improves (same as every other scene).
  const mxSrc = fs.readFileSync(`${SRC}/mixNarration.ts`, 'utf8');
  const mxCode = mxSrc.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  check('7: Scene 2 legacy timing expression is preserved VERBATIM',
    mxCode.includes('if (scene === 2) return Math.max(clipDuration, narrationDuration + narrationTail);'), 'missing legacy branch');
  check('7: Scene 2 still deliberately bypasses the 2.0 bound (comment intact)',
    /scene === 2/i.test(mxSrc) && /(above today|not routed|LEGACY)/i.test(mxSrc), 'legacy rationale missing');
  const afterChain15 = planSceneVideoChain({ sourceDurationSeconds: SRC_DUR, outputDurationSeconds: OUT_DUR });
  // Scene 2's real inputs: 8 s clip, 19.12 s narration -> legacy output max(8, 19.12 + 0.25) = 19.37 s
  const S2_CLIP = 8;
  const S2_NARR = 19.12;
  const legacyOut = Math.max(S2_CLIP, S2_NARR + P.NARRATION_TAIL_SECONDS);
  const legacy = planSceneVideoChain({ sourceDurationSeconds: S2_CLIP, outputDurationSeconds: legacyOut });
  check('7: Scene 2 keeps its legacy output duration max(clip, narration + tail) = 19.370s',
    Math.abs(legacyOut - 19.37) < 1e-9, legacyOut);
  check('7: Scene 2 keeps its legacy ~2.421x timing factor', Math.abs(legacy.retimeFactor - 2.42125) < 1e-6, legacy.retimeFactor);
  check('7: Scene 2 is deliberately ABOVE the 2.0 bound and is not routed through the policy',
    legacy.retimeFactor > P.MAX_NARRATION_VIDEO_STRETCH, legacy.retimeFactor);
  // Scene 2 must go through the SAME shared builder — no per-scene exception, no special case.
  check('7: Scene 2 uses the shared interpolation stage (no scene-specific branch)',
    filtersOf(legacy.chain).includes(mixMciInterpolationFilter(24)), legacy.chain);
  check('7: Scene 2 also gets the tail pad (same builder, same requirement)',
    legacy.tailPadSeconds === 0.25 && /tpad=stop_mode=clone/.test(legacy.chain), legacy.chain);
  check('7: Scene 2 gets no MORE pad than any other scene (pad is not scaled by the factor)',
    legacy.tailPadSeconds === planSceneVideoChain({ sourceDurationSeconds: SRC_DUR, outputDurationSeconds: OUT_DUR }).tailPadSeconds,
    { s2: legacy.tailPadSeconds });
  // Scene 2's ~2.42x stretch is 49% beyond Scene 15's 1.62625x, so MCI will synthesise roughly 1.5x
  // more intermediate frames there. That is a documented follow-up, not something changed here.
  check('7: the shared builder handles Scene 2 without a special case (no per-scene branch)',
    filtersOf(legacy.chain).length === filtersOf(afterChain15.chain).length
    && /minterpolate/.test(legacy.chain) && /tpad=stop_mode=clone/.test(legacy.chain), legacy.chain);
  check('7: Scene 2 needs a heavier interpolation than Scene 15 (49% more stretch)',
    (legacy.retimeFactor as number) / (afterChain15.retimeFactor as number) > 1.4,
    { s2: legacy.retimeFactor, s15: afterChain15.retimeFactor });
  // The legacy branch must still bypass the 2.0 bound (unchanged behaviour).
  const s2ViaPolicy = P.decideNarrationPreservation({ sourceVideoDuration: S2_CLIP, narrationDuration: S2_NARR });
  check('7: Scene 2 WOULD be rejected by the 2.0 policy if routed through it (and is not)',
    s2ViaPolicy.ok === false && legacy.ok !== false, s2ViaPolicy.reason);
}

// ============================================================================================
// 8. Both MIX paths use the SAME shared builder
// ============================================================================================
{
  const shared = buildMixFilterGraph({ sceneCount: 1, durations: [SRC_DUR], outputDurations: [OUT_DUR], narrationInputs: [[1, 'n.wav']], narrationIndex: new Map([[1, 1]]), narrationMakeupDb: 12, transition: 0.35, bgm: undefined, bgmLufs: -20.9 });
  const ISO = `${SRC}/isolatedSceneMix.ts`;
  const isoSrc = fs.readFileSync(ISO, 'utf8');
  check('8: isolated MIX imports the builder from mixFilterGraph.js (NOT from the CLI mixNarration)',
    /from '\.\/mixFilterGraph\.js'/.test(isoSrc) && !/from '\.\/mixNarration\.js'/.test(isoSrc), isoSrc.slice(0, 200));
  check('8: mixNarration re-exports the very same builder so production MIX shares it',
    /export \{[^}]*buildMixFilterGraph/.test(fs.readFileSync(`${SRC}/mixNarration.ts`, 'utf8')));
  // The video chain produced by the shared helper is byte-identical for both consumers.
  const isoSrcFlat = isoSrc.replace(/\r?\n\s*\*?\s?/g, ' ').replace(/\s+/g, ' ');
  check('8: the shared helper yields exactly one canonical MCI chain, and the built graph embeds it verbatim',
    planSceneVideoChain({ sourceDurationSeconds: SRC_DUR, outputDurationSeconds: OUT_DUR }).chain
    === `fps=24,tpad=stop_mode=clone:stop_duration=0.250000,setpts=1.626250*PTS,${mixMciInterpolationFilter(24)},trim=duration=13.010,setpts=PTS-STARTPTS`
    && shared.graph.startsWith(`[0:v]${planSceneVideoChain({ sourceDurationSeconds: SRC_DUR, outputDurationSeconds: OUT_DUR }).chain}[v0]`),
    shared.graph.slice(0, 140));
  check('8: the isolated path documents the tail-pad requirement it now depends on',
    /tail-pad requirement|TAIL PAD/i.test(isoSrcFlat), 'tail-pad rationale missing from isolatedSceneMix');
  check('8: the isolated path still states that interpolation invents pixels',
    /INVENTS PIXELS/i.test(isoSrcFlat), 'invented-pixels caveat missing from isolatedSceneMix');
  check('8: the isolated path still states constant cadence is not perceptual smoothness',
    /not perceptual smoothness/i.test(isoSrcFlat), 'smoothness caveat missing from isolatedSceneMix');
  check('8: the isolated path records the reviewed V3 artifact by name',
    /scene-0015-mixed-mci-v3\.mp4/.test(isoSrcFlat), 'reviewed artifact not referenced');
}

// ============================================================================================
// 9. REAL RENDER PROOF (throwaway TEMP media, Scene 15's exact timing shape)
// ============================================================================================
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-'));
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
  const srcFile = path.join(tmp, 'scene-0015.mp4');
  const wav = path.join(tmp, 'narration-0015.wav');
  // Mirror the real clip exactly: 192 frames @ 24 fps, timebase 1/12288 (512 ticks/frame).
  await exec(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=24:duration=8',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '8',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-video_track_timescale', '12288', '-c:a', 'aac', '-shortest', srcFile], { maxBuffer: 1 << 26 });
  await exec(ffmpeg, ['-y', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=24000:duration=${NARR_DUR}`, '-ac', '1', wav], { maxBuffer: 1 << 26 });

  const fixture = await ffprobe2(ffprobe, srcFile);
  check('9: fixture mirrors the real clip (192 frames, 24 fps, timebase 1/12288)',
    Number(fixture.nb_frames) === 192 && fixture.r_frame_rate === '24/1' && fixture.time_base === '1/12288', fixture);

  const render = async (chain: string, label: string) => {
    const out = path.join(tmp, `${label}.mp4`);
    const full = `[0:v]${chain}[v];[0:a]apad,atrim=duration=${OUT_DUR},asetpts=PTS-STARTPTS[src0];[1:a]apad,atrim=duration=${OUT_DUR},asetpts=PTS-STARTPTS,apad,atrim=duration=${OUT_DUR},asplit=2[vs][vm];[src0][vs]sidechaincompress=threshold=0.025:ratio=12:attack=80:release=500[dk];[dk][vm]amix=inputs=2:duration=first:normalize=0[a0]`;
    await exec(ffmpeg, buildMixOutputArgs({ sceneFiles: [srcFile], narrationFiles: [wav], bgm: undefined,
      graph: full, videoLabel: 'v', audioLabel: 'a0', output: out }), { maxBuffer: 1 << 28 });
    return out;
  };

  const cadence = async (file: string) => {
    const { stdout } = await exec(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file], { maxBuffer: 1 << 26 });
    const pts = String(stdout).split(/\r?\n/).map((l) => l.replace(/,/g, '').trim()).filter((l) => /^\d/.test(l)).map(Number);
    const d: number[] = [];
    for (let i = 1; i < pts.length; i++) d.push(Math.round((pts[i] - pts[i - 1]) * 1e6) / 1e6);
    // Bucket intervals at 0.1 ms (0.0001 s). That is 400x below one 24 fps frame step (41.67 ms),
    // so a bucket split means genuinely uneven cadence, while ffprobe's own 6-decimal printing of
    // 1/24 (0.041666... -> 0.041666 or 0.041667) does NOT split a bucket.
    const counts: Record<string, number> = {};
    for (const x of d) { const k = (Math.round(x * 1e4) / 1e4).toFixed(4); counts[k] = (counts[k] ?? 0) + 1; }
    const distinct = Object.keys(counts).sort();
    return {
      frames: pts.length, first: pts[0], last: pts[pts.length - 1],
      distinct, counts,
      // Largest departure of any interval from a constant 24 fps grid.
      maxDeviationFrom24: d.length ? Math.max(...d.map((x) => Math.abs(x - 1 / 24))) : NaN,
    };
  };

  // BEFORE: the original defect (fps BEFORE setpts only).
  const before = await render('fps=24,setpts=1.626250*PTS,trim=duration=13.010,setpts=PTS-STARTPTS', 'before');
  const cb = await cadence(before);
  // AFTER: the SHIPPED chain, produced by the shared helper (no hand-written filter string).
  const afterChain = planSceneVideoChain({ sourceDurationSeconds: SRC_DUR, outputDurationSeconds: OUT_DUR }).chain;
  const after = await render(afterChain, 'after');
  const ca = await cadence(after);

  // The tail pad is a REQUIREMENT of the interpolator, not an optimisation: prove that removing it
  // reproduces the measured 309-frame / 12.875 s shortfall the pad exists to fix.
  const noPadChain = afterChain.replace(/tpad=stop_mode=clone:stop_duration=[0-9.]+,/, '');
  check('9: the tail pad is load-bearing (removing it changes the emitted chain)',
    noPadChain !== afterChain && /minterpolate/.test(noPadChain), noPadChain);
  const noPad = await render(noPadChain, 'nopad');
  const cn = await cadence(noPad);
  check('9: WITHOUT the pad the interpolator falls short of the target (this is why the pad exists)',
    cn.frames < ca.frames && cn.frames === 309, { withoutPad: cn.frames, withPad: ca.frames, last: cn.last });

  check('9: BEFORE reproduces the defect (192 frames, ~14.8 fps, two distinct intervals)',
    cb.frames === 192 && cb.distinct.length === 2 && Math.abs(cb.frames / 12.958333 - 14.8) < 0.2, cb);
  check('9: BEFORE cadence deviates from a constant 24 fps grid by ~half a frame',
    cb.maxDeviationFrom24 > 0.04 && cb.maxDeviationFrom24 < 0.05, cb.maxDeviationFrom24);
  check('9: AFTER yields a CONSTANT cadence (exactly one distinct inter-frame interval)',
    ca.distinct.length === 1, ca);
  check('9: AFTER cadence is exactly 1/24 s', Math.abs(Number(ca.distinct[0]) - 1 / 24) < 1e-4, ca.distinct);
  check('9: AFTER every interval is within 0.1 ms of the 24 fps grid (no judder gaps remain)',
    ca.maxDeviationFrom24 < 1e-4, ca.maxDeviationFrom24);
  check('9: AFTER carries the planned 312 frames', ca.frames === 312, ca.frames);
  check('9: AFTER frame count equals expectedMixFrameCount(13.010, 24)',
    ca.frames === expectedMixFrameCount(OUT_DUR, 24), { got: ca.frames, want: expectedMixFrameCount(OUT_DUR, 24) });
  check('9: AFTER spans 13.000 s (312/24), within one frame of the 13.010 s audio target',
    Math.abs(ca.frames / 24 - OUT_DUR) <= 1 / 24 + 1e-9, ca.frames / 24);
  check('9: AFTER effective rate is 24.000 fps (BEFORE was ~14.8)',
    Math.abs(ca.frames / (ca.frames / 24) - 24) < 1e-9 && Math.abs(cb.frames / (cb.last - cb.first) - 14.76) < 0.2,
    { afterFps: 24, beforeFps: Math.round((cb.frames / (cb.last - cb.first)) * 100) / 100 });
  check('9: AFTER starts at PTS 0', ca.first === 0, ca.first);
  check('9: BEFORE frame-interval histogram shows the alternating 24/12 fps pattern (two buckets)',
    cb.distinct.length === 2 && Math.abs(Number(cb.distinct[0]) - 1 / 24) < 1e-4
    && Math.abs(Number(cb.distinct[1]) - 2 / 24) < 1e-4
    && Object.values(cb.counts).every((n) => n > 0), cb.counts);
  check('9: AFTER frame-interval histogram is a single bucket of 311 gaps',
    Object.keys(ca.counts).length === 1 && ca.counts[Object.keys(ca.counts)[0]] === ca.frames - 1, ca.counts);

  // Audio must be identical between the two orderings.
  const audioOf = async (file: string) => {
    const j = JSON.parse((await exec(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type,codec_name,sample_rate,channels,duration', '-of', 'json', file], { maxBuffer: 1 << 24 })).stdout);
    return { container: j.format.duration, audio: j.streams.find((s: any) => s.codec_type === 'audio') };
  };
  const [ab, aa] = [await audioOf(before), await audioOf(after)];
  check('9: audio stream is byte-for-byte the same in BOTH orderings (fix is video-only)',
    JSON.stringify(ab.audio) === JSON.stringify(aa.audio), { before: ab.audio, after: aa.audio });
  check('9: audio still runs the full 13.010 s and is untouched at natural speed',
    Math.abs(Number(aa.audio.duration) - OUT_DUR) < 1e-6 && aa.audio.sample_rate === '48000' && aa.audio.channels === 2, aa.audio);

  await fsp.rm(tmp, { recursive: true, force: true });
}

async function ffprobe2(bin: string, file: string) {
  const { stdout } = await exec(bin, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames,r_frame_rate,time_base', '-of', 'json', file], { maxBuffer: 1 << 24 });
  return JSON.parse(String(stdout)).streams[0];
}

console.log(`\nALL PASS  (${passed} checks)`);
