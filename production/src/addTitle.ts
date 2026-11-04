import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { markReviewPending } from './reviewState.js';
import { buildTitleFfmpegArgs, buildTitleFilterGraph } from './titleGraph.js';

const exec = promisify(execFile);
const arg = (name: string, fallback?: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
};

const input = path.resolve(arg('--input') ?? 'outputs/last-bus-narrated-synced.mp4');
const output = path.resolve(arg('--output') ?? 'outputs/last-bus-title.mp4');
const title = arg('--title', 'AAKHRI BUS KI TEESRI SEAT')!;
const skipTitle = process.argv.includes('--skip-title');
const skipLogo = process.argv.includes('--skip-logo');
// Opt-in, story-only treatment for the embedded Flow sparkle. The intro is never touched.
const removeFlowSparkle = process.argv.includes('--remove-flow-sparkle');
const projectFile = arg('--project');
const intro = path.resolve(arg('--intro') ?? 'assets/channel-intro.mp4');
const logo = path.resolve(arg('--logo') ?? 'assets/channel-logo.png');
const introSeconds = 5;
const introFadeSeconds = 0.5;
const escapeAss = (value: string) => value.replace(/[{}\\]/g, (char) => `\\${char}`);
await fs.access(intro);
// --skip-logo is explicit and opt-in: the logo must not even be required in that mode.
if (!skipLogo) await fs.access(logo);
async function resolution(file: string): Promise<{ width: number; height: number }> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', file]);
  const [width, height] = stdout.trim().split('x').map(Number);
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error(`Could not read video dimensions for ${file}`);
  return { width, height };
}
const storySize = await resolution(input);
// Reference placement at 1280x720: a 76px-square logo, inset 72px from the
// right and 75px from the bottom. Scale those proportions for every export.
const logoHeight = Math.round(storySize.height * 0.1056);
const logoRight = Math.round(storySize.width * 0.05625);
const logoBottom = Math.round(storySize.height * 0.10417);
const ass = path.join(path.dirname(output), '.last-bus-title.ass');
await fs.writeFile(ass, `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Title,Georgia,82,&H00F8F1E5,&H00F8F1E5,&HDC0B1B22,&H80000000,-1,0,0,0,100,100,0,0,1,2.5,3,8,60,60,108,1
Style: Kicker,Georgia,19,&H009ED5D7,&H009ED5D7,&HDC0B1B22,&H80000000,0,0,0,0,100,100,5,0,1,1,2,8,60,60,200,1
[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
Dialogue: 0,0:00:00.00,0:00:03.70,Title,,0,0,0,,{\\fad(400,700)\\fscx72\\fscy72\\t(0,400,\\fscx100\\fscy100)}${escapeAss(title)}
Dialogue: 1,0:00:00.00,0:00:03.70,Kicker,,0,0,0,,{\\fad(400,700)\\fscx72\\fscy72\\t(0,400,\\fscx100\\fscy100)}H I N D I   F O L K   H O R R O R
`);
const escapedAss = ass.replace(/\\/g, '/').replace(':', '\\:');
const mainTitleFilter = skipTitle ? 'null' : `subtitles=filename='${escapedAss}':fontsdir='C\\:/Windows/Fonts'`;
const graph = buildTitleFilterGraph({
  storySize, introSeconds, introFadeSeconds, mainTitleFilter, logoHeight, logoRight, logoBottom, skipLogo,
  removeFlowSparkle,
});

await exec('ffmpeg', buildTitleFfmpegArgs({
  intro, input, logo, output, graph, skipLogo,
}), { maxBuffer: 1024 * 1024 * 8 });
const review = projectFile ? await markReviewPending(path.resolve(projectFile), output, title) : undefined;
console.log(JSON.stringify({
  input, output, title, skipTitle, titleEndSeconds: skipTitle ? 0 : 3.7, intro, introSeconds, logo,
  ...(skipLogo
    ? { skipLogo: true, logoPlacement: null }
    : { logoPlacement: { height: logoHeight, right: logoRight, bottom: logoBottom } }),
  ...(removeFlowSparkle ? { removeFlowSparkle: true } : {}),
  review,
  questions: review ? ['Should I approve this video?', 'Is it good to post on YouTube or not?'] : undefined,
}));
