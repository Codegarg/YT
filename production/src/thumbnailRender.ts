/**
 * PHASE 7 — deterministic thumbnail renderer (FFmpeg + libass).
 *
 * Offline by construction: the renderer reads a still (a frame of an already-rendered scene clip) or
 * synthesises a deterministic gradient card, then draws Devanagari type with libass and overlays the
 * channel logo. There is NO image-generation API call, NO browser and NO network access here.
 *
 * The graph is built by ONE function so the artifact, the pixel-measurement passes and QA can never
 * disagree about what was drawn.
 *
 * Writes are atomic: temp file in the artifact directory → verify → rename. A failed render leaves
 * no artifact behind and the workflow never records a checkpoint for it.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  THUMBNAIL_PALETTE,
  THUMBNAIL_RENDERER_VERSION,
  type ThumbnailDesign,
  type ThumbnailSourceRef,
} from './thumbnailTypes.js';

const exec = promisify(execFile);

export const THUMBNAIL_ASS_FILE = 'thumbnail.ass';

export interface RenderSourcePaths {
  /** Absolute base media path (image or video clip); null for a designed card. */
  base: string | null;
  /** Absolute logo path; null when the project ships no logo. */
  logo: string | null;
}

export interface GraphOptions {
  withText: boolean;
  withLogo: boolean;
}

function assColor(hex: string, alpha = '00'): string {
  const match = String(hex ?? '').trim().match(/^#?([0-9a-f]{6})$/i);
  const rgb = match ? match[1] : 'FFFFFF';
  const r = rgb.slice(0, 2);
  const g = rgb.slice(2, 4);
  const b = rgb.slice(4, 6);
  return `&H${alpha}${b}${g}${r}`.toUpperCase();
}

/** FFmpeg colour literal (`0xRRGGBB`) from a CSS hex string. */
function ffColor(hex: string): string {
  const match = String(hex ?? '').trim().match(/^#?([0-9a-f]{6})$/i);
  return `0x${(match ? match[1] : '000000').toUpperCase()}`;
}

function escapeAssText(value: string): string {
  return String(value ?? '').replace(/[{}]/g, (char) => `\\${char}`).replace(/\r?\n/g, ' ');
}

function timestamp(seconds: number): string {
  const total = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total - h * 3600) / 60);
  const s = total - h * 3600 - m * 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

/**
 * Author the ASS document for a design. `WrapStyle: 2` disables automatic wrapping so the ONLY line
 * breaks are the ones the design computed (a wrapped line can never move the layout at render time).
 */
export function buildThumbnailAss(design: ThumbnailDesign): string {
  const { width, height } = design;
  const blocks = design.text.blocks;
  const headlineBlock = blocks.find((block) => block.id === 'headline');
  const bodySize = headlineBlock?.font_size ? Math.round(headlineBlock.font_size * 0.4) : 36;

  const styles = [
    `Style: Kicker,${design.text.font_family},${blocks.find((b) => b.id === 'kicker')?.font_size ?? 30},${assColor(THUMBNAIL_PALETTE.accent)},${assColor(THUMBNAIL_PALETTE.accent)},${assColor(THUMBNAIL_PALETTE.outline)},&H80000000,0,0,0,0,100,100,0,0,1,1.6,2,7,0,0,0,1`,
    `Style: Headline,${design.text.font_family},${headlineBlock?.font_size ?? 96},${assColor(THUMBNAIL_PALETTE.text)},${assColor(THUMBNAIL_PALETTE.text)},${assColor(THUMBNAIL_PALETTE.outline)},&H80000000,-1,0,0,0,100,100,0,0,1,3.2,4,7,0,0,0,1`,
    `Style: Subhead,${design.text.font_family},${blocks.find((b) => b.id === 'subhead')?.font_size ?? bodySize},${assColor(THUMBNAIL_PALETTE.muted)},${assColor(THUMBNAIL_PALETTE.muted)},${assColor(THUMBNAIL_PALETTE.outline)},&H80000000,0,0,0,0,100,100,0,0,1,2.2,3,7,0,0,0,1`,
    `Style: Wordmark,${design.text.font_family},${design.branding.wordmark.font_size},${assColor(design.branding.wordmark.color)},${assColor(design.branding.wordmark.color)},${assColor(THUMBNAIL_PALETTE.outline)},&H80000000,-1,0,0,0,100,100,2,0,1,1.6,2,7,0,0,0,1`,
  ];

  const events: string[] = [];
  const styleFor: Record<string, string> = { kicker: 'Kicker', headline: 'Headline', subhead: 'Subhead' };
  for (const block of blocks) {
    for (let index = 0; index < block.lines.length; index += 1) {
      const y = block.y + index * block.line_height;
      events.push(
        `Dialogue: 0,${timestamp(0)},${timestamp(3600)},${styleFor[block.id] ?? 'Headline'},,0,0,0,,{\\an7\\pos(${Math.round(block.x)},${Math.round(y)})}${escapeAssText(block.lines[index].text)}`,
      );
    }
  }
  if (design.branding.wordmark.visible) {
    events.push(
      `Dialogue: 0,${timestamp(0)},${timestamp(3600)},Wordmark,,0,0,0,,{\\an7\\pos(${Math.round(design.branding.wordmark.x)},${Math.round(design.branding.wordmark.y)})}${escapeAssText(design.branding.wordmark.text)}`,
    );
  }

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes
[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
${styles.join('\n')}
[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
${events.join('\n')}
`;
}

/**
 * Build the exact FFmpeg filter graph. `withText`/`withLogo` exist so QA can render reference passes
 * (text-less, logo-less) that isolate exactly which pixels are type and which are branding.
 */
export function buildThumbnailGraph(design: ThumbnailDesign, options: GraphOptions): string {
  const { width, height } = design;
  const band = design.text.band;
  const scrimTop = Math.max(0, Math.round(band.y - 56));
  const scrimBottom = Math.min(height, Math.round(band.y + band.height + 56));
  const scrimHeight = Math.max(1, scrimBottom - scrimTop);
  const parts: string[] = [];

  const chain = [
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    'setsar=1',
    'format=rgba',
    'eq=brightness=-0.12:saturation=0.95',
  ];
  if (design.render.vignette) chain.push('vignette=angle=PI/5');
  // A soft scrim behind the type block keeps Devanagari legible over a bright still without
  // hiding the artwork everywhere else.
  chain.push(`drawbox=x=0:y=${scrimTop}:w=${width}:h=${scrimHeight}:color=${ffColor(design.palette.overlay)}@0.55:t=fill`);
  parts.push(`${chain.join(',')}[base]`);
  let current = '[base]';

  if (options.withText) {
    parts.push(`${current}subtitles=filename='${THUMBNAIL_ASS_FILE}'[text]`);
    current = '[text]';
  }

  if (design.branding.logo_relative_path) {
    const placement = design.branding.placement;
    const box = placement.height;
    if (options.withLogo) {
      // The logo is CONTAINED inside its permanent brand box (never scaled past the safe inset and
      // never cropped by the canvas), so any logo aspect ratio keeps the branding inside the box QA
      // measures.
      parts.push(`[1:v]format=rgba,scale=w=${box}:h=${box}:force_original_aspect_ratio=decrease,pad=${box}:${box}:(ow-iw)/2:(oh-ih)/2:color=black@0[brand]`);
    } else {
      // Reference pass: the SAME overlay stage with transparent content, so the logo-less frame differs
      // from the artifact only where the logo actually drew ink (never by a pixel-format shift).
      parts.push(`color=c=black@0:s=${box}x${box}:d=1,format=rgba[brand]`);
    }
    parts.push(`${current}[brand]overlay=x=${placement.x}:y=${placement.y}:format=auto[vout]`);
    current = '[vout]';
  }

  parts.push(`${current}null[vfinal]`);
  return parts.join(';');
}

export function buildThumbnailArgs(input: {
  design: ThumbnailDesign;
  paths: RenderSourcePaths;
  options: GraphOptions;
  /** Output PNG, or `null` when the caller only wants a raw gray frame on stdout. */
  output: string | null;
}): string[] {
  const { design, paths, options } = input;
  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-y'];

  if (paths.base) {
    const frameSeconds = Number(design.render.frame_seconds ?? 0);
    if (frameSeconds > 0) args.push('-ss', String(frameSeconds));
    args.push('-i', paths.base);
  } else {
    args.push('-f', 'lavfi', '-i', `color=c=${design.palette.background}:s=${design.width}x${design.height}:d=1:r=1`);
  }

  const usesLogo = Boolean(options.withLogo && paths.logo && design.branding.logo_relative_path);
  if (usesLogo) args.push('-i', String(paths.logo));
  args.push('-filter_complex', buildThumbnailGraph(design, { withText: options.withText, withLogo: usesLogo }));
  args.push('-map', '[vfinal]', '-frames:v', '1');

  if (input.output) {
    args.push('-update', '1', input.output);
  } else {
    args.push('-f', 'rawvideo', '-pix_fmt', 'gray', '-');
  }
  return args;
}

async function runCapture(args: string[], options: { cwd: string; binary: string }): Promise<{ stdout: Buffer; stderr: string }> {
  const result = await exec(options.binary, args, {
    cwd: options.cwd,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'buffer',
  } as any) as unknown as { stdout: Buffer; stderr: Buffer };
  return { stdout: result.stdout, stderr: String(result.stderr ?? '') };
}

export interface RenderThumbnailResult {
  ok: boolean;
  outputPath: string;
  sha256: string | null;
  bytes: number | null;
  error: string | null;
}

/**
 * Render one thumbnail atomically.
 *
 * The ASS file is written next to the artifact (it is design provenance and makes the render
 * exactly reproducible). Rendering with `cwd` = the artifact directory lets libass resolve
 * `filename='thumbnail.ass'` even when the project path contains spaces — the same trick the TITLE
 * stage uses.
 */
export async function renderThumbnail(input: {
  design: ThumbnailDesign;
  paths: RenderSourcePaths;
  outputPath: string;
  workDir: string;
  ffmpegPath?: string;
}): Promise<RenderThumbnailResult> {
  const workDir = path.resolve(input.workDir);
  const outputPath = path.resolve(input.outputPath);
  const ffmpeg = input.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';

  await fsp.mkdir(workDir, { recursive: true });
  const assPath = path.join(workDir, THUMBNAIL_ASS_FILE);
  await fsp.writeFile(assPath, buildThumbnailAss(input.design), 'utf8');

  const tempPath = `${outputPath}.tmp-${process.pid}-${Date.now().toString(36)}.png`;
  const args = buildThumbnailArgs({
    design: input.design,
    paths: input.paths,
    options: { withText: true, withLogo: true },
    output: tempPath,
  });

  try {
    await exec(ffmpeg, args, { cwd: workDir, maxBuffer: 64 * 1024 * 1024 });
    const stat = await fsp.stat(tempPath);
    if (!stat.isFile() || stat.size < 1024) {
      await fsp.rm(tempPath, { force: true });
      return { ok: false, outputPath, sha256: null, bytes: null, error: 'the renderer produced an empty image' };
    }
    await fsp.rename(tempPath, outputPath);
    const bytes = await fsp.readFile(outputPath);
    return {
      ok: true,
      outputPath,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      error: null,
    };
  } catch (error: any) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    return { ok: false, outputPath, sha256: null, bytes: null, error: String(error?.stderr ?? error?.message ?? error).slice(0, 400) };
  }
}

export interface InkBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  pixels: number;
}

/** Render one reference variant and return its raw 8-bit gray frame. */
export async function renderThumbnailGray(input: {
  design: ThumbnailDesign;
  paths: RenderSourcePaths;
  workDir: string;
  options: GraphOptions;
  ffmpegPath?: string;
}): Promise<Buffer | null> {
  const workDir = path.resolve(input.workDir);
  const assPath = path.join(workDir, THUMBNAIL_ASS_FILE);
  await fsp.mkdir(workDir, { recursive: true });
  await fsp.writeFile(assPath, buildThumbnailAss(input.design), 'utf8');
  const ffmpeg = input.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
  const args = buildThumbnailArgs({ design: input.design, paths: input.paths, options: input.options, output: null });
  try {
    const { stdout } = await runCapture(args, { cwd: workDir, binary: ffmpeg });
    const expected = input.design.width * input.design.height;
    if (stdout.length < expected) return null;
    return stdout.subarray(0, expected);
  } catch {
    return null;
  }
}

/** Decode any image to a raw gray frame (used to verify the artifact against a fresh render). */
export async function decodeGray(input: { file: string; width: number; height: number; ffmpegPath?: string; cwd: string }): Promise<Buffer | null> {
  const ffmpeg = input.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
  try {
    const { stdout } = await runCapture(
      ['-hide_banner', '-loglevel', 'error', '-i', path.basename(input.file), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
      { cwd: input.cwd, binary: ffmpeg },
    );
    const expected = input.width * input.height;
    return stdout.length >= expected ? stdout.subarray(0, expected) : null;
  } catch {
    return null;
  }
}

/** Bounding box + pixel count of the difference between two gray frames. */
export function diffInk(a: Buffer, b: Buffer, width: number, height: number, threshold = 0): InkBox | null {
  let x1 = width;
  let y1 = height;
  let x2 = -1;
  let y2 = -1;
  let pixels = 0;
  const limit = Math.min(a.length, b.length, width * height);
  for (let index = 0; index < limit; index += 1) {
    const delta = Math.abs(a[index] - b[index]);
    if (delta <= threshold) continue;
    const x = index % width;
    const y = (index - x) / width;
    pixels += 1;
    if (x < x1) x1 = x;
    if (y < y1) y1 = y;
    if (x > x2) x2 = x;
    if (y > y2) y2 = y;
  }
  if (pixels === 0) return null;
  return { x1, y1, x2, y2, pixels };
}

/** True when two frames are pixel-identical. */
export function framesEqual(a: Buffer, b: Buffer): boolean {
  const limit = Math.min(a.length, b.length);
  if (limit === 0 || a.length !== b.length) return false;
  for (let index = 0; index < limit; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

export { THUMBNAIL_RENDERER_VERSION, exec as thumbnailExec };
