// Offline TITLE-stage graph tests. No FFmpeg/Chrome/Flow/network.
//
// Proves the opt-in `--skip-logo` mode removes the logo input/stream/overlay while the
// default graph remains byte-for-byte the existing branded graph.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { REPO } from './_testPaths.mjs';
const SRC = `${REPO}/production/src`;
const { buildTitleFilterGraph, buildTitleFfmpegArgs, FLOW_SPARKLE_DELOGO_FILTER } = await import(pathToFileURL(`${SRC}/titleGraph.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const baseGraph = {
  storySize: { width: 1280, height: 720 },
  introSeconds: 5,
  introFadeSeconds: 0.5,
  mainTitleFilter: "subtitles=filename='C\\:/tmp/title.ass':fontsdir='C\\:/Windows/Fonts'",
  logoHeight: 76,
  logoRight: 72,
  logoBottom: 75,
  skipLogo: false,
};

const expectedHead = [
  "[0:v]trim=duration=5,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,settb=AVTB,setsar=1,setpts=PTS-STARTPTS[introvideo]",
  "[1:v]subtitles=filename='C\\:/tmp/title.ass':fontsdir='C\\:/Windows/Fonts',scale=1280:720,fps=30,settb=AVTB,setsar=1,setpts=PTS-STARTPTS[storyvideo]",
];
const expectedAudio = [
  '[0:a]atrim=duration=5,asetpts=PTS-STARTPTS[introaudio]',
  '[1:a]asetpts=PTS-STARTPTS[storyaudio]',
  '[introaudio][storyaudio]acrossfade=d=0.5:c1=tri:c2=tri[audio]',
];

// ---- 1. Default graph is unchanged and still applies the logo overlay ----
{
  const graph = buildTitleFilterGraph(baseGraph);
  const expected = [
    ...expectedHead,
    '[introvideo][storyvideo]xfade=transition=fade:duration=0.5:offset=4.5[joinedvideo]',
    '[2:v]format=rgba,scale=-1:76[brand]',
    '[joinedvideo][brand]overlay=x=W-w-72:y=H-h-75:format=auto:shortest=1[video]',
    ...expectedAudio,
  ].join(';');
  check('1a default graph is byte-for-byte unchanged', graph === expected, { graph, expected });
  check('1b default graph consumes the logo stream', graph.includes('[2:v]format=rgba') && graph.includes('[brand]'));
  check('1c default graph contains the persistent overlay', graph.includes('[joinedvideo][brand]overlay=x=W-w-72:y=H-h-75:format=auto:shortest=1[video]'));
}

// ---- 2. --skip-logo graph has no logo input/stream/overlay at all ----
{
  const graph = buildTitleFilterGraph({ ...baseGraph, skipLogo: true });
  const expected = [
    ...expectedHead,
    '[introvideo][storyvideo]xfade=transition=fade:duration=0.5:offset=4.5[video]',
    ...expectedAudio,
  ].join(';');
  check('2a skip-logo graph is the exact no-logo graph', graph === expected, { graph, expected });
  check('2b skip-logo graph has no logo stream', !graph.includes('[2:v]') && !graph.includes('[brand]'));
  check('2c skip-logo graph has no overlay filter', !graph.includes('overlay='));
  check('2d skip-logo graph does not reference the logo path/word', !/logo/i.test(graph), graph);
  check('2e skip-logo graph keeps intro, title, transition, and audio',
    graph.includes('[introvideo]') && graph.includes('[storyvideo]') && graph.includes('subtitles=filename=') &&
    graph.includes('xfade=transition=fade:duration=0.5:offset=4.5[video]') && graph.includes('acrossfade=d=0.5:c1=tri:c2=tri[audio]'));
}

// ---- 3. Default ffmpeg argv still opens the logo; skip-logo argv does not ----
{
  const common = { intro: 'intro.mp4', input: 'story.mp4', logo: 'logo.png', output: 'out.mp4' };
  const defaultGraph = buildTitleFilterGraph(baseGraph);
  const skipGraph = buildTitleFilterGraph({ ...baseGraph, skipLogo: true });
  const defaultArgs = buildTitleFfmpegArgs({ ...common, graph: defaultGraph, skipLogo: false });
  const skipArgs = buildTitleFfmpegArgs({ ...common, graph: skipGraph, skipLogo: true });

  check('3a default argv still has the looped logo input',
    defaultArgs.join('|').includes('-i|intro.mp4|-i|story.mp4|-loop|1|-i|logo.png'));
  check('3b skip-logo argv has no logo input',
    !skipArgs.includes('logo.png') && !skipArgs.join('|').includes('-loop|1'));
  check('3c skip-logo argv still maps video and audio',
    skipArgs.includes('[video]') && skipArgs.includes('[audio]'));

  const encoding = ['-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];
  check('3d default encoding settings unchanged', defaultArgs.slice(-encoding.length - 1, -1).join('|') === encoding.join('|'));
  check('3e skip-logo encoding settings unchanged', skipArgs.slice(-encoding.length - 1, -1).join('|') === encoding.join('|'));
}

// ---- 4. Default ffmpeg argv is byte-for-byte unchanged ----
{
  const defaultGraph = buildTitleFilterGraph(baseGraph);
  const expectedArgs = [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', 'intro.mp4', '-i', 'story.mp4',
    '-loop', '1', '-i', 'logo.png', '-filter_complex', defaultGraph,
    '-map', '[video]', '-map', '[audio]',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', 'out.mp4',
  ];
  const args = buildTitleFfmpegArgs({ intro: 'intro.mp4', input: 'story.mp4', logo: 'logo.png', output: 'out.mp4', graph: defaultGraph, skipLogo: false });
  check('4a default argv is byte-for-byte unchanged', args.join('|') === expectedArgs.join('|'), { args, expectedArgs });
}

// ---- 5. --remove-flow-sparkle is fully opt-in and story-stream-only ----
{
  const defaultGraph = buildTitleFilterGraph(baseGraph);
  const explicitFalse = buildTitleFilterGraph({ ...baseGraph, removeFlowSparkle: false });
  check('5a omitted and explicit-false sparkle flags are byte-identical', defaultGraph === explicitFalse, { defaultGraph, explicitFalse });

  const graph = buildTitleFilterGraph({ ...baseGraph, removeFlowSparkle: true });
  const expectedSparkleStory = `[1:v]${FLOW_SPARKLE_DELOGO_FILTER},subtitles=filename='C\\:/tmp/title.ass':fontsdir='C\\:/Windows/Fonts',scale=1280:720,fps=30,settb=AVTB,setsar=1,setpts=PTS-STARTPTS[storyvideo]`;
  const expected = [
    expectedHead[0],
    expectedSparkleStory,
    '[introvideo][storyvideo]xfade=transition=fade:duration=0.5:offset=4.5[joinedvideo]',
    '[2:v]format=rgba,scale=-1:76[brand]',
    '[joinedvideo][brand]overlay=x=W-w-72:y=H-h-75:format=auto:shortest=1[video]',
    ...expectedAudio,
  ].join(';');
  check('5b opt-in graph adds delogo only to the story stream', graph === expected, { graph, expected });
  check('5c intro stream is byte-identical', graph.split(';')[0] === expectedHead[0]);
  check('5d logo stream and overlay are byte-identical',
    graph.includes('[2:v]format=rgba,scale=-1:76[brand]') &&
    graph.includes('[joinedvideo][brand]overlay=x=W-w-72:y=H-h-75:format=auto:shortest=1[video]'));
  check('5e delogo appears exactly once', (graph.match(/delogo=/g) ?? []).length === 1);
  const introLine = graph.split(';')[0];
  const logoLine = graph.split(';').find((line) => line.startsWith('[2:v]')) ?? '';
  check('5f delogo is absent from intro and logo streams', !introLine.includes('delogo=') && !logoLine.includes('delogo='));
  check('5g no-logo + sparkle keeps the logo absent',
    buildTitleFilterGraph({ ...baseGraph, skipLogo: true, removeFlowSparkle: true }).includes('delogo=') &&
    !buildTitleFilterGraph({ ...baseGraph, skipLogo: true, removeFlowSparkle: true }).includes('[2:v]'));
  check('5h skip-title + sparkle uses delogo then null',
    buildTitleFilterGraph({ ...baseGraph, mainTitleFilter: 'null', removeFlowSparkle: true }).includes(`[1:v]${FLOW_SPARKLE_DELOGO_FILTER},null,scale=`));

  const sparkleArgs = buildTitleFfmpegArgs({
    intro: 'intro.mp4', input: 'story.mp4', logo: 'logo.png', output: 'out.mp4', graph, skipLogo: false,
  });
  const defaultArgs = buildTitleFfmpegArgs({
    intro: 'intro.mp4', input: 'story.mp4', logo: 'logo.png', output: 'out.mp4', graph: defaultGraph, skipLogo: false,
  });
  const differing = sparkleArgs.map((value, index) => value === defaultArgs[index] ? -1 : index).filter((index) => index >= 0);
  check('5i sparkle flag changes only the filter graph in argv',
    sparkleArgs.length === defaultArgs.length &&
    differing.length === 1 &&
    differing[0] === sparkleArgs.indexOf('-filter_complex') + 1, { differing });
  check('5j the tested delogo box is exact', FLOW_SPARKLE_DELOGO_FILTER === 'delogo=x=1132:y=572:w=58:h=58', FLOW_SPARKLE_DELOGO_FILTER);
}

// ---- 6. addTitle wiring: opt-in flags remain explicit and default-off ----
{
  const addTitle = fs.readFileSync(`${SRC}/addTitle.ts`, 'utf8');
  check('6a addTitle parses --skip-logo', /process\.argv\.includes\('--skip-logo'\)/.test(addTitle));
  check('6b logo access is skipped only in --skip-logo mode',
    /if \(!skipLogo\) await fs\.access\(logo\)/.test(addTitle) && !/^\s*await fs\.access\(logo\);/m.test(addTitle));
  check('6c default/no-flag path still requires the logo', !/if \(skipLogo\) await fs\.access\(logo\)/.test(addTitle));
  check('6d addTitle parses --remove-flow-sparkle as an explicit opt-in',
    /const removeFlowSparkle = process\.argv\.includes\('--remove-flow-sparkle'\)/.test(addTitle));
  check('6e addTitle passes removeFlowSparkle to the graph builder', /removeFlowSparkle,/.test(addTitle));
  check('6f default addTitle stdout is unchanged (field appears only when enabled)',
    /\.\.\.\(removeFlowSparkle \? \{ removeFlowSparkle: true \} : \{\}\)/.test(addTitle));
}

console.log(`\n${passed} title graph checks passed.`);
