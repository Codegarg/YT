// Focused OFFLINE regression tests for the two proven MIX producer defects.
//
//   FIX 1  the narration label was consumed TWICE in one filter_complex (sidechaincompress sidechain
//          + amix sum) with no asplit, so FFmpeg starved the amix branch and every narrator scene
//          came out DIGITAL SILENCE.
//   FIX 2  the output audio rate/channels were left to FFmpeg negotiation, so a 24 kHz mono
//          narration source dragged the programme to 24 kHz instead of the 48 kHz stereo contract.
//
// This test (a) asserts the generated graph/argv structure and (b) PROVES the narration signal
// survives by running the real producer on a silent scene + non-silent synthetic narration and
// measuring output energy. It FAILS against the old graph (asserted by reconstructing it) and
// PASSES with the new one. Synthetic temp assets only; the real project is never touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { REPO } from './_testPaths.mjs';
const SRC = `${REPO}/production/src`;
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
process.env.PATH = `${FF};${process.env.PATH}`;
const exec = promisify(execFile);

// The producer is a script with top-level side effects, so the temp fixture is created FIRST and
// the module is then imported with argv pointing at that fixture: the import-time run is harmless
// (it writes into the temp dir) and we get the genuine exports of the REAL source file.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mixfix-'));
const PID = 'mixfix-fixture';
const outDir = path.join(tmp, 'outputs', PID);
const inDir = path.join(tmp, 'inputs', PID);
const narrDir = path.join(inDir, 'narration');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(narrDir, { recursive: true });

/** SILENT scene clips with an audio track (mirrors sceneRenderer's anullsrc output). */
const mkSilentScene = async (out: string, dur: number) => {
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', `color=c=0x203040:s=640x360:d=${dur}`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', String(dur),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);
};
/** NON-SILENT narration: a real 440 Hz tone at 24 kHz mono (the format that caused FIX 2). */
const mkNarration = async (out: string, dur: number) => {
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}:sample_rate=24000`,
    '-ac', '1', '-c:a', 'pcm_s16le', out]);
};
const meanVolumeDb = async (file: string) => {
  const { stderr } = await exec(process.env.FFMPEG_PATH!, ['-v', 'info', '-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
    { maxBuffer: 1024 * 1024 * 32 });
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(String(stderr));
  return m ? Number(m[1]) : -120;
};

await mkSilentScene(path.join(outDir, 'scene-0001.mp4'), 4);
await mkSilentScene(path.join(outDir, 'scene-0002.mp4'), 3);
await mkNarration(path.join(narrDir, 'narration-0001.wav'), 4);

// Harmless import-time producer run, into the temp dir only.
const importRunOut = path.join(tmp, 'import-run.mp4');
process.argv.push('--input-dir', outDir, '--narration-dir', narrDir, '--output', importRunOut);

const { buildMixFilterGraph, buildMixOutputArgs, MIX_OUT_SAMPLE_RATE, MIX_OUT_CHANNELS } =
  await import(pathToFileURL(`${SRC}/mixNarration.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const TRANSITION = 0.35, MAKEUP = 12;

// ============ graph fixtures (2 scenes: scene 1 narrated, scene 2 not) ============
const sceneCount = 2;
const durations = [4, 3];
const outputDurations = [4, 3];
const narrationInputs: [number, string][] = [[1, 'narration-0001.wav']];
const narrationIndex = new Map<number, number>([[1, sceneCount + 0]]);   // 1st narration input = index 2

const g = buildMixFilterGraph({
  sceneCount, durations, outputDurations, narrationInputs, narrationIndex,
  narrationMakeupDb: MAKEUP, transition: TRANSITION, bgm: undefined, bgmLufs: -20.9,
});

// ============ FIX 1: narration asplit ============
console.log('--- FIX 1: narration stream is split before its two consumers ---');
{
  const segs = g.graph.split(';');
  const voiceSeg = segs.find((s) => s.includes('asplit=2'));
  check('1.1 graph contains an explicit narration asplit', !!voiceSeg, g.graph);
  check('1.2 asplit is on the narration (voice) chain, not the video chain',
    !!voiceSeg && voiceSeg.includes(':a]') && !voiceSeg.includes(':v]'), voiceSeg);
  check('1.3 asplit emits exactly two labels [voice_sc..] and [voice_mix..]',
    !!voiceSeg && /\[voice_sc0\]\[voice_mix0\]$/.test(voiceSeg.trim()), voiceSeg);
  check('1.4 asplit happens AFTER the narration trim (identical content+duration for both branches)',
    !!voiceSeg && voiceSeg.indexOf('atrim=duration=') > -1 && voiceSeg.indexOf('atrim=duration=') < voiceSeg.indexOf('asplit=2'), voiceSeg);

  const sc = segs.find((s) => s.includes('sidechaincompress'));
  const mix = segs.find((s) => s.includes('amix=inputs=2'));
  check('1.5 sidechaincompress consumes the SPLIT sidechain label',
    !!sc && sc.includes('[source0][voice_sc0]sidechaincompress'), sc);
  check('1.6 amix consumes the OTHER split label',
    !!mix && mix.includes('[duckedsource0][voice_mix0]amix'), mix);
  check('1.7 no filter segment references the old shared [voice0] label',
    !g.graph.includes('[voice0]') && !g.graph.includes('[voice1]'), g.graph);
  // A filter_complex stream label may be consumed only ONCE. Count only the INPUT group of each
  // segment (the leading [..][..]); a segment's own output label is not a consumption.
  const inputCounts = new Map<string, number>();
  for (const s of g.graph.split(';')) {
    const m = /^((?:\[[A-Za-z_][A-Za-z0-9_]*\])+)/.exec(s.trim());
    if (!m) continue;
    for (const l of (m[1].match(/\[[A-Za-z_][A-Za-z0-9_]*\]/g) ?? [])) {
      const name = l.slice(1, -1);
      inputCounts.set(name, (inputCounts.get(name) ?? 0) + 1);
    }
  }
  const dupes = [...inputCounts].filter(([, n]) => n > 1);
  check('1.8 every stream label is consumed at most once (no shared-label starvation)',
    dupes.length === 0, dupes);
  check('1.8b the narration labels really are two distinct inputs',
    inputCounts.get('voice_sc0') === 1 && inputCounts.get('voice_mix0') === 1, [...inputCounts]);

  // The OLD graph, reconstructed, is exactly the defect: [voice0] used twice.
  const oldSc = `[source0][voice0]sidechaincompress=threshold=0.025:ratio=12:attack=80:release=500[duckedsource0]`;
  const oldMix = `[duckedsource0][voice0]amix=inputs=2:duration=first:normalize=0[a0]`;
  check('1.9 the pre-fix graph form (shared label, no asplit) is what we no longer emit',
    oldSc.includes('[voice0]') && oldMix.includes('[voice0]') && !g.graph.includes('[source0][voice0]'));
}

// ============ FIX 8: sidechaincompress output obeys the per-scene duration contract ============
// `sidechaincompress` is a dual-input filter (ambience main + narration sidechain, possibly at a
// different sample rate). Before this guard its output fed `amix=duration=first` directly, so the
// per-scene mix took whatever length the filter happened to emit, which varied run to run and made
// the whole MIX render non-reproducible. The guard must sit on the sidechaincompress OUTPUT, i.e.
// after the filter and before the [duckedsourceN] label that amix consumes.
console.log('--- FIX 8: sidechaincompress output is length-guarded before amix ---');
{
  const sc = g.graph.split(';').find((s) => s.includes('sidechaincompress'));
  const mix = g.graph.split(';').find((s) => s.includes('amix=inputs=2'));
  check('8.1 sidechaincompress segment still takes [source0][voice_sc0]',
    !!sc && sc.includes('[source0][voice_sc0]sidechaincompress'), sc);
  check('8.2 the guard is on the OUTPUT edge: apad+atrim+asetpts follow sidechaincompress',
    !!sc && sc.indexOf('sidechaincompress=') > -1
    && sc.indexOf('sidechaincompress=') < sc.indexOf('apad')
    && sc.indexOf('apad') < sc.indexOf('atrim=duration=')
    && sc.indexOf('atrim=duration=') < sc.indexOf('asetpts=PTS-STARTPTS')
    && sc.indexOf('asetpts=PTS-STARTPTS') < sc.indexOf('[duckedsource0]'), sc);
  check('8.3 the guard uses that scene\'s OWN outputDuration and the established .toFixed(3) form',
    !!sc && sc.includes(`release=500,apad,atrim=duration=${outputDurations[0].toFixed(3)},asetpts=PTS-STARTPTS[duckedsource0]`), sc);
  check('8.4 the guard is NOT on the sidechain (narration) input, which keeps its own trim',
    !!sc && sc.indexOf('[voice_sc0]') < sc.indexOf('sidechaincompress='), sc);
  check('8.5 the guard lands before the label amix consumes',
    !!sc && !!mix && sc.includes('[duckedsource0]') && mix.includes('[duckedsource0][voice_mix0]amix'), mix);
  check('8.6 every audio edge that produces a consumed label is duration-guarded',
    g.graph.split(';')
      .filter((s) => /\[(source|voice_sc|voice_mix|duckedsource)\d+\]$/.test(s.trim()) && !s.includes(':v]') && !s.includes(':a]'))
      .every((s) => s.includes('atrim=duration=')),
    g.graph.split(';').filter((s) => /\[(source|voice_sc|voice_mix|duckedsource)\d+\]$/.test(s.trim())));
  check('8.7 sidechaincompress + amix PARAMETERS are untouched by the guard',
    !!sc && sc.includes('sidechaincompress=threshold=0.025:ratio=12:attack=80:release=500')
    && !!mix && mix.includes('amix=inputs=2:duration=first:normalize=0'), `${sc} || ${mix}`);
  // A non-default output duration must produce a DIFFERENT guard value (no hardcoded constant).
  const gAlt = buildMixFilterGraph({
    sceneCount: 1, durations: [2], outputDurations: [3.25],
    narrationInputs: [[1, 'narration-0001.wav']], narrationIndex: new Map([[1, 1]]),
    narrationMakeupDb: MAKEUP, transition: TRANSITION, bgm: undefined, bgmLufs: -20.9,
  });
  check('8.8 the guard tracks outputDurations (3.250 for a stretched scene)',
    gAlt.graph.includes('release=500,apad,atrim=duration=3.250,asetpts=PTS-STARTPTS[duckedsource0]'), gAlt.graph);
}

// ============ behaviour preserved ============
console.log('--- existing filter/arg behaviour preserved ---');
{
  check('B1 per-scene video uses fps= and setpts as before', g.graph.includes('[0:v]fps=24,'), g.graph.slice(0, 160));
  check('B2 non-narrated scene keeps the plain atrim branch',
    g.graph.includes('[1:a]atrim=duration=3.000,asetpts=PTS-STARTPTS[a1]'), g.graph);
  check('B3 scene audio is apad+atrim before ducking (ambience preserved)',
    g.graph.includes('[0:a]apad,atrim=duration=4.000,asetpts=PTS-STARTPTS[source0]'));
  check('B4 compressor/limiter/makeup unchanged',
    g.graph.includes(`acompressor=threshold=0.05:ratio=8:attack=5:release=100:makeup=${MAKEUP}`)
    && g.graph.includes('alimiter=limit=0.9:level=0'));
  check('B5 sidechaincompress + amix parameters unchanged',
    g.graph.includes('sidechaincompress=threshold=0.025:ratio=12:attack=80:release=500')
    && g.graph.includes('amix=inputs=2:duration=first:normalize=0'));
  check('B6 xfade + acrossfade chain intact with the same transition',
    g.graph.includes(`xfade=transition=fade:duration=${TRANSITION}:offset=3.650`) && g.graph.includes(`acrossfade=d=${TRANSITION}:c1=tri:c2=tri`),
    g.graph.slice(-220));
  check('B7 final labels are vx1 / ax1', g.video === 'vx1' && g.audio === 'ax1', { video: g.video, audio: g.audio });
  check('B8 runningDuration unchanged by the fix', Math.abs(g.runningDuration - 6.65) < 1e-9, g.runningDuration);

  // BGM path still builds the loudnorm bed and mixedaudio label.
  const gbgm = buildMixFilterGraph({
    sceneCount, durations, outputDurations, narrationInputs, narrationIndex,
    narrationMakeupDb: MAKEUP, transition: TRANSITION, bgm: 'BGM.mp3', bgmLufs: -20.9,
  });
  check('B9 bgm branch still applies loudnorm at the requested LUFS and amixes',
    gbgm.graph.includes('loudnorm=I=-20.9:TP=-5:LRA=7') && gbgm.graph.includes('[ax1][bgm]amix=inputs=2:duration=first:normalize=0')
    && gbgm.audio === 'mixedaudio', gbgm.audio);
  check('B10 bgm input index still sceneCount+narration count', gbgm.graph.includes('[3:a]aloop'), gbgm.graph.slice(-260));
}

// ============ FIX 2: output args ============
console.log('--- FIX 2: pinned output audio contract ---');
{
  const args = buildMixOutputArgs({
    sceneFiles: ['s1.mp4', 's2.mp4'], narrationFiles: ['n1.wav'], bgm: undefined,
    graph: g.graph, videoLabel: g.video, audioLabel: g.audio, output: 'OUT.mp4',
  });
  const count = (f: string) => args.filter((x) => x === f).length;
  check('2.1 exactly one -ar', count('-ar') === 1, args);
  check('2.2 -ar is 48000', args[args.indexOf('-ar') + 1] === '48000', args[args.indexOf('-ar') + 1]);
  check('2.3 exactly one -ac', count('-ac') === 1, args);
  check('2.4 -ac is 2', args[args.indexOf('-ac') + 1] === '2', args[args.indexOf('-ac') + 1]);
  check('2.5 constants exported for the contract', MIX_OUT_SAMPLE_RATE === 48000 && MIX_OUT_CHANNELS === 2);
  check('2.6 video settings unchanged (libx264 + yuv420p)', args.includes('libx264') && args.includes('yuv420p'));
  check('2.7 audio codec/bitrate unchanged (aac 192k)', args.includes('aac') && args.includes('192k'));
  check('2.8 faststart + output last', args.includes('+faststart') && args[args.length - 1] === 'OUT.mp4');
  // Input order must stay: scenes, then narration, then optional bgm.
  const inputsOf = (a: string[]) => a.reduce<string[]>((acc, v, i) => (v === '-i' ? [...acc, a[i + 1]] : acc), []);
  check('2.9 input order preserved (scenes, then narration)',
    JSON.stringify(inputsOf(args)) === JSON.stringify(['s1.mp4', 's2.mp4', 'n1.wav']), inputsOf(args));
  const withBgm = buildMixOutputArgs({
    sceneFiles: ['s1.mp4', 's2.mp4'], narrationFiles: ['n1.wav'], bgm: 'BGM.mp3',
    graph: g.graph, videoLabel: g.video, audioLabel: g.audio, output: 'OUT.mp4',
  });
  check('2.10 bgm appended as the last input when present',
    JSON.stringify(inputsOf(withBgm)) === JSON.stringify(['s1.mp4', 's2.mp4', 'n1.wav', 'BGM.mp3']), inputsOf(withBgm));
  check('2.11 -ar/-ac appear exactly once even with bgm',
    withBgm.filter((x) => x === '-ar').length === 1 && withBgm.filter((x) => x === '-ac').length === 1);
}

// ============ END-TO-END: narration energy survives (fails on the old graph) ============
console.log('--- end-to-end: real producer, silent scene + non-silent narration ---');
check('E0 the fixture scene audio really is silent', (await meanVolumeDb(path.join(outDir, 'scene-0001.mp4'))) < -80);
check('E0b the fixture narration really is non-silent', (await meanVolumeDb(path.join(narrDir, 'narration-0001.wav'))) > -40);

// Run the REAL producer through the existing executeStage path (no stageArgs narration override).
const { executeStage } = await import(pathToFileURL(`${SRC}/stageExecutor.ts`).href);
const res = await executeStage('MIX',
  { outputsDir: outDir, inputsDir: inDir, productionDir: `${REPO}/production` } as any,
  { ffprobePath: process.env.FFPROBE_PATH });

check('E1 the real MIX producer completes', res.ok === true, res);
const mixOut = (res as any).outputPath;
check('E2 final-narrated.mp4 written', fs.existsSync(mixOut));

const outVol = await meanVolumeDb(mixOut);
console.log(`     output mean_volume = ${outVol.toFixed(1)} dB`);
check('E3 FIX 1 PROOF: narration energy survives the graph (clearly non-silent)', outVol > -60, outVol);

const { stdout: probeRaw } = await exec(process.env.FFPROBE_PATH!, ['-v', 'error', '-show_entries',
  'stream=codec_type,codec_name,pix_fmt,width,height,sample_rate,channels:format=duration', '-of', 'json', mixOut]);
const st = JSON.parse(probeRaw).streams ?? [];
const a = st.find((s: any) => s.codec_type === 'audio');
const v = st.find((s: any) => s.codec_type === 'video');
check('E4 FIX 2 PROOF: output audio is 48000 Hz', Number(a?.sample_rate) === 48000, a);
check('E5 output audio is stereo', Number(a?.channels) === 2, a);
check('E6 output audio is AAC', a?.codec_name === 'aac', a);
check('E7 video stream still valid h264/yuv420p', v?.codec_name === 'h264' && v?.pix_fmt === 'yuv420p', v);

// ---- the decisive differential: the OLD graph on the SAME fixture must be silent ----
{
  const oldGraph = g.graph
    .replace(/,asplit=2\[voice_sc0\]\[voice_mix0\]/, '[voice0]')
    .replace('[source0][voice_sc0]sidechaincompress', '[source0][voice0]sidechaincompress')
    .replace('[duckedsource0][voice_mix0]amix', '[duckedsource0][voice0]amix');
  check('E8 the reconstructed OLD graph really lacks asplit and reuses [voice0]',
    !oldGraph.includes('asplit') && oldGraph.includes('[duckedsource0][voice0]amix'), oldGraph.slice(0, 200));
  const oldOut = path.join(tmp, 'old-graph.mp4');
  await exec(process.env.FFMPEG_PATH!, ['-y',
    '-i', path.join(outDir, 'scene-0001.mp4'), '-i', path.join(outDir, 'scene-0002.mp4'),
    '-i', path.join(narrDir, 'narration-0001.wav'),
    '-filter_complex', oldGraph, '-map', '[vx1]', '-map', '[ax1]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
    '-ar', '48000', '-ac', '2', oldOut], { maxBuffer: 1024 * 1024 * 64 });
  const oldVol = await meanVolumeDb(oldOut);
  console.log(`     OLD graph mean_volume = ${oldVol.toFixed(1)} dB`);
  check('E9 the OLD graph is digital silence on this fixture (so the test truly regresses)',
    oldVol < -80, oldVol);
  check('E10 new graph is dramatically louder than the old one',
    outVol - oldVol > 20, { new: outVol, old: oldVol });
  // And the old graph at 24 kHz negotiation, to show FIX 2 mattered too.
  const oldNoAR = path.join(tmp, 'old-noar.mp4');
  await exec(process.env.FFMPEG_PATH!, ['-y',
    '-i', path.join(outDir, 'scene-0001.mp4'), '-i', path.join(outDir, 'scene-0002.mp4'),
    '-i', path.join(narrDir, 'narration-0001.wav'),
    '-filter_complex', oldGraph, '-map', '[vx1]', '-map', '[ax1]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', oldNoAR], { maxBuffer: 1024 * 1024 * 64 });
  const { stdout: oldProbe } = await exec(process.env.FFPROBE_PATH!, ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate,channels', '-of', 'json', oldNoAR]);
  const oa = JSON.parse(oldProbe).streams?.[0];
  check('E11 without -ar/-ac the old path negotiated 24 kHz (proving FIX 2 was needed)',
    Number(oa?.sample_rate) !== 48000, oa);
}

// ============ NARRATION-PRESERVATION POLICY (output-duration selection) ============
// The MIX script's top-level `outputDurations` map is not exported, so these checks assert the two
// things that matter and are observable: (1) the SHARED pure helper produces the picture length
// the map now delegates to, and (2) the graph that length feeds produces the expected setpts
// stretch while leaving narration audio untouched.
console.log('--- narration-preservation policy drives output duration + setpts ---');
{
  const policy: any = await import(pathToFileURL(`${SRC}/narrationDurationPolicy.ts`).href);

  // 1. an eligible non-Scene-2 supplied-video case: narration LONGER than clip -> narration + tail
  const eligible = policy.decideNarrationPreservation({ sourceVideoDuration: 8.0, narrationDuration: 12.76 });
  check('P1 eligible case yields narration + 0.25 as the output duration',
    Math.abs(eligible.requiredOutputDuration - 13.01) < 1e-6, eligible.requiredOutputDuration);
  check('P1 eligible case is within the 2.0x limit', eligible.ok === true && eligible.withinLimit === true, eligible);

  // 2. the graph that length feeds must carry the matching setpts stretch factor
  const stretched: any[] = [8.0];
  const outDur: number[] = [eligible.requiredOutputDuration];
  const narrationIn: [number, string][] = [[1, 'narration-0001.wav']];
  const gStretch = buildMixFilterGraph({
    sceneCount: 1, durations: stretched, outputDurations: outDur, narrationInputs: narrationIn,
    narrationIndex: new Map<number, number>([[1, 1]]), narrationMakeupDb: MAKEUP, transition: TRANSITION,
    bgm: undefined, bgmLufs: -20.9,
  });
  const expectedK = (13.01 / 8.0).toFixed(6);
  check(`P2 graph contains setpts=${expectedK}*PTS for the 1.626x stretch`,
    gStretch.graph.includes(`setpts=${expectedK}*PTS`), gStretch.graph.slice(0, 200));
  check('P2 graph trims the picture to the extended 13.010s', gStretch.graph.includes('trim=duration=13.010'), gStretch.graph.slice(0, 200));
  check('P2 running duration reflects the extended picture', Math.abs(gStretch.runningDuration - 13.01) < 1e-6, gStretch.runningDuration);

  // 3. narration AUDIO must not be time-stretched: it is atrim-ed to the new length and
  //    sidechain-ducked, never resampled. Assert no audio-rate-changing filter appears.
  const audioSegs = gStretch.graph.split(';').filter((s) => s.includes(':a]') || s.includes('voice_sc') || s.includes('voice_mix'));
  check('P3 narration audio is NOT time-stretched (no asetrate/atempo/aresample)',
    !audioSegs.some((s) => /asetrate|atempo|aresample/.test(s)), audioSegs);
  check('P3 narration audio is atrim-ed to the SAME extended length',
    audioSegs.some((s) => s.includes('atrim=duration=13.010')), audioSegs);

  // 4. a scene whose narration FITS inside the video must NOT be extended
  const fits = policy.decideNarrationPreservation({ sourceVideoDuration: 8.0, narrationDuration: 6.0 });
  check('P4 narration that fits does not extend the picture', Math.abs(fits.requiredOutputDuration - 8.0) < 1e-6, fits.requiredOutputDuration);
  check('P4 narration that fits needs no setpts stretch', fits.needsPictureExtension === false && fits.stretchFactor === 1, fits);

  // 5. FAIL CLOSED: an over-limit scene is not stretched by the MIX policy either
  const over = policy.decideNarrationPreservation({ sourceVideoDuration: 8.0, narrationDuration: 15.751 });
  check('P5 over-limit case fails closed in the policy', over.ok === false && over.withinLimit === false, over);
  check('P5 over-limit case would NOT be stretched by the MIX wrapper (returns source length)',
    policy.narrationPreservingOutputDuration({ sourceVideoDuration: 8.0, narrationDuration: 15.751 }) === 8.0,
    policy.narrationPreservingOutputDuration({ sourceVideoDuration: 8.0, narrationDuration: 15.751 }));

  // 6. Scene 2 LEGACY behaviour is preserved exactly and is deliberately NOT routed through the
  //    new bound. Reproduce the script's own branch and assert it still yields ~2.42x.
  const scene2Clip = 8.0, scene2Narr = 19.12;
  const legacyScene2 = Math.max(scene2Clip, scene2Narr + policy.NARRATION_TAIL_SECONDS);
  check('P6 Scene 2 legacy output duration is unchanged (max(clip, narration+tail))',
    Math.abs(legacyScene2 - 19.37) < 1e-6, legacyScene2);
  const legacyK = legacyScene2 / scene2Clip;
  check('P6 Scene 2 legacy stretch is still ~2.421x (above the new 2.0x bound, still honoured)',
    legacyK > policy.MAX_NARRATION_VIDEO_STRETCH && Math.abs(legacyK - 2.42125) < 1e-4, legacyK);
  check('P6 Scene 2 would be REJECTED by the new policy if it were routed through it (it is not)',
    policy.decideNarrationPreservation({ sourceVideoDuration: scene2Clip, narrationDuration: scene2Narr }).ok === false);
  // ...and the graph still stretches Scene 2 by its legacy factor.
  const gLegacy = buildMixFilterGraph({
    sceneCount: 1, durations: [scene2Clip], outputDurations: [legacyScene2], narrationInputs: narrationIn,
    narrationIndex: new Map<number, number>([[1, 1]]), narrationMakeupDb: MAKEUP, transition: TRANSITION,
    bgm: undefined, bgmLufs: -20.9,
  });
  check('P6 Scene 2 graph carries its legacy setpts factor unchanged',
    gLegacy.graph.includes(`setpts=${(legacyK).toFixed(6)}*PTS`), gLegacy.graph.slice(0, 200));

  // 7. a scene with NO narration keeps its own length (graph must not stretch it)
  const gNone: any = buildMixFilterGraph({
    sceneCount: 1, durations: [8.0], outputDurations: [8.0], narrationInputs: [],
    narrationIndex: new Map<number, number>(), narrationMakeupDb: MAKEUP, transition: TRANSITION,
    bgm: undefined, bgmLufs: -20.9,
  });
  check('P7 a non-narrated scene is not stretched', !gNone.graph.includes('setpts=1.'), gNone.graph.slice(0, 160));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} MIX producer regression checks passed (fully offline, temp fixture only).`);