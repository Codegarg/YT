/**
 * Pure TITLE-stage graph construction.
 *
 * `addTitle.ts` is a top-level CLI script, so its FFmpeg graph cannot be imported by unit
 * tests without executing the script. These builders keep the graph/argv logic pure and
 * testable while `addTitle.ts` remains the only module that runs FFmpeg.
 *
 * The default (`skipLogo: false`, `removeFlowSparkle: false`) graph is byte-for-byte the graph the
 * title stage has always produced. `skipLogo: true` is an explicit opt-in used only for alternate
 * review candidates; it removes the logo input, the `[brand]` stream, and the overlay filter
 * entirely. `removeFlowSparkle: true` is a separate opt-in that applies the localized Flow sparkle
 * treatment to the story stream only.
 */

/** Localized NLE/Flow sparkle removal box for the 1280x720 story frame. */
export const FLOW_SPARKLE_DELOGO_FILTER = 'delogo=x=1132:y=572:w=58:h=58';

export interface TitleGraphOptions {
  storySize: { width: number; height: number };
  introSeconds: number;
  introFadeSeconds: number;
  /** `null` when `--skip-title` is used, otherwise the subtitles filter. */
  mainTitleFilter: string;
  logoHeight: number;
  logoRight: number;
  logoBottom: number;
  skipLogo: boolean;
  /** Opt-in: apply the sparkle treatment to `[1:v]` only. Defaults to false. */
  removeFlowSparkle?: boolean;
}

export interface TitleFfmpegArgsOptions {
  intro: string;
  input: string;
  logo: string;
  output: string;
  graph: string;
  skipLogo: boolean;
}

/** Build the exact filter_complex graph for the TITLE stage. */
export function buildTitleFilterGraph(options: TitleGraphOptions): string {
  const { width, height } = options.storySize;
  const storyFilter = options.removeFlowSparkle
    ? `${FLOW_SPARKLE_DELOGO_FILTER},${options.mainTitleFilter}`
    : options.mainTitleFilter;
  const head = [
    `[0:v]trim=duration=${options.introSeconds},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=30,settb=AVTB,setsar=1,setpts=PTS-STARTPTS[introvideo]`,
    `[1:v]${storyFilter},scale=${width}:${height},fps=30,settb=AVTB,setsar=1,setpts=PTS-STARTPTS[storyvideo]`,
  ];
  const xfade = `[introvideo][storyvideo]xfade=transition=fade:duration=${options.introFadeSeconds}:offset=${options.introSeconds - options.introFadeSeconds}`;
  const audio = [
    `[0:a]atrim=duration=${options.introSeconds},asetpts=PTS-STARTPTS[introaudio]`,
    `[1:a]asetpts=PTS-STARTPTS[storyaudio]`,
    `[introaudio][storyaudio]acrossfade=d=${options.introFadeSeconds}:c1=tri:c2=tri[audio]`,
  ];

  if (options.skipLogo) return [...head, `${xfade}[video]`, ...audio].join(';');

  return [
    ...head,
    `${xfade}[joinedvideo]`,
    `[2:v]format=rgba,scale=-1:${options.logoHeight}[brand]`,
    `[joinedvideo][brand]overlay=x=W-w-${options.logoRight}:y=H-h-${options.logoBottom}:format=auto:shortest=1[video]`,
    ...audio,
  ].join(';');
}

/** Build the exact ffmpeg argv for the TITLE stage. */
export function buildTitleFfmpegArgs(options: TitleFfmpegArgsOptions): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', options.intro, '-i', options.input];
  if (!options.skipLogo) args.push('-loop', '1', '-i', options.logo);
  args.push(
    '-filter_complex', options.graph,
    '-map', '[video]', '-map', '[audio]',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', options.output,
  );
  return args;
}
