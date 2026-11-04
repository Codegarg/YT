/**
 * Local scene renderer (STEP-8CT).
 *
 * Produces `scene-####.mp4` locally from an ALREADY-EXTRACTED background PNG plus a REAL
 * measured duration, using FFmpeg only — no Flow, no network, no TTS, no external service.
 *
 * CHARACTER POLICY (live 8CQ): existing character thumbnails are cross-origin
 * (`flow-content.google`) and canvas extraction is blocked (SecurityError), so character
 * imagery is NOT locally obtainable. This renderer therefore NEVER silently fakes a
 * character:
 *   · mode "require-characters" → fail closed (CHARACTER_ASSETS_UNAVAILABLE or
 *     CHARACTER_COMPOSITING_NOT_IMPLEMENTED)
 *   · mode "background-only"    → render background only and mark the result explicitly
 *
 * "background-only" is NEVER a hidden default — the caller must pass a mode.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { motionFromSceneText, validateSceneRenderInput, validateSceneDuration, sceneClipFilename, type SceneMotion } from './sceneRender.js';
import { resolveCharacterPlacements, buildCharacterOverlayGraph, type CharacterPlacement, type CharacterAssetState } from './characterComposite.js';
import { validateVideoClip } from './videoClip.js';

const exec = promisify(execFile);

export type SceneRenderMode = 'background-only' | 'require-characters';

/**
 * 8DF pipe render mode — how a scene is PRODUCED (distinct from the character policy `mode`).
 *   · LOCAL_SYNTHESIS — render from local background + character assets (existing behaviour)
 *   · SUPPLIED_VIDEO  — consume an already-supplied, validated scene clip
 *   · AUTO            — choose SUPPLIED_VIDEO if a VALID clip exists, else LOCAL_SYNTHESIS;
 *                       never hides an INVALID supplied clip by falling back
 */
export type ScenePipeRenderMode = 'LOCAL_SYNTHESIS' | 'SUPPLIED_VIDEO' | 'AUTO';

export interface SceneRenderInputEx {
  sceneNumber: number;
  backgroundImagePath: string;
  durationSeconds: number;
  motion?: SceneMotion;
  width?: number;
  height?: number;
  mode: SceneRenderMode;
  /** Deterministic character placements. Required (non-empty) when mode is require-characters. */
  characters?: CharacterPlacement[];
  /** 8DF production path. Defaults to LOCAL_SYNTHESIS (preserves previous behaviour). */
  renderMode?: ScenePipeRenderMode;
  /** Supplied clip path used by SUPPLIED_VIDEO / AUTO. */
  suppliedClipPath?: string;
}

export interface SceneRenderOptions {
  outputDir: string;
  /** Directory holding local character cutouts; required when characters are composited. */
  charactersDir?: string;
  /** FFmpeg executable; defaults to PATH `ffmpeg` or FFPEG_PATH/FFMPEG_PATH env. */
  ffmpegPath?: string;
  /** ffprobe executable for post-render validation. */
  ffprobePath?: string;
  /** Overwrite an existing output (default: true). */
  overwrite?: boolean;
  /** Post-render duration tolerance in seconds (default 0.5). */
  durationToleranceSeconds?: number;
}

export type SceneRenderResult =
  | {
      ok: true;
      sceneNumber: number;
      outputPath: string;
      width: number;
      height: number;
      fps: number;
      durationSeconds: number;
      mode: SceneRenderMode;
      backgroundOnly: boolean;
      motion: SceneMotion;
      videoCodec: string;
      pixFmt: string;
      hasAudio: true;
      /** Number of character overlays composited (0 = background-only). */
      characterCount: number;
      /** Which production path produced this scene (8DF). */
      renderMode: ScenePipeRenderMode;
      /** True when an existing supplied clip was reused rather than synthesized. */
      suppliedVideoReused: boolean;
    }
  | { ok: false; sceneNumber: number; code: SceneRenderErrorCode; reason: string; characterTag?: string; assetState?: CharacterAssetState };

export type SceneRenderErrorCode =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_BACKGROUND'
  | 'BACKGROUND_NOT_FOUND'
  | 'CHARACTER_ASSETS_UNAVAILABLE'
  | 'CHARACTER_COMPOSITING_NOT_IMPLEMENTED'
  | 'CHARACTER_COMPOSITING_ASSET_UNAVAILABLE'
  | 'CHARACTER_PLACEMENT_INVALID'
  | 'SUPPLIED_VIDEO_UNAVAILABLE'
  | 'SUPPLIED_VIDEO_INVALID'
  | 'DURATION_UNRESOLVED'
  | 'FFMPEG_FAILURE'
  | 'OUTPUT_VALIDATION_FAILED';

const SUPPORTED_IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp'];
export const RENDER_FPS = 30;
export const FADE_SECONDS = 0.35;

/** Deterministic FFmpeg filter graph for a motion + fade. Same inputs ⇒ same output. */
export function buildFilterGraph(motion: SceneMotion, width: number, height: number, durationSeconds: number, fps = RENDER_FPS, fadeSeconds = FADE_SECONDS): string {
  // Bounded fade: never exceed half the clip.
  const fade = Math.min(fadeSeconds, Math.max(0, durationSeconds / 2 - 0.01));
  const fadeOutStart = Math.max(0, durationSeconds - fade).toFixed(3);
  // Fill 16:9 without stretching: scale up preserving aspect, then centre-crop.
  const fill = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
  // Deterministic motion via zoompan (single output frame per input frame; fps fixed).
  const frames = Math.max(1, Math.round(durationSeconds * fps));
  const zoomExpr = (from: number, to: number) => `zoompan=z='${from}+(${to}-${from})*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps}`;
  const pan = (axis: 'x' | 'y', dir: -1 | 1, z = 1.12) => {
    const travel = `(iw-iw/zoom)`;
    const xExpr = axis === 'x' ? (dir === 1 ? `(iw-iw/zoom)*on/${frames}` : `(iw-iw/zoom)*(1-on/${frames})`) : `iw/2-(iw/zoom/2)`;
    const yExpr = axis === 'y' ? (dir === 1 ? `(ih-ih/zoom)*on/${frames}` : `(ih-ih/zoom)*(1-on/${frames})`) : `ih/2-(ih/zoom/2)`;
    void travel;
    return `zoompan=z='${z}':x='${xExpr}':y='${yExpr}':d=1:s=${width}x${height}:fps=${fps}`;
  };
  let motionFilter: string;
  switch (motion) {
    case 'STATIC': motionFilter = zoomExpr(1.0, 1.0); break;
    case 'ZOOM_IN': motionFilter = zoomExpr(1.0, 1.12); break;
    case 'ZOOM_OUT': motionFilter = zoomExpr(1.12, 1.0); break;
    case 'PAN_LEFT': motionFilter = pan('x', -1); break;
    case 'PAN_RIGHT': motionFilter = pan('x', 1); break;
    case 'PAN_UP': motionFilter = pan('y', -1); break;
    case 'PAN_DOWN': motionFilter = pan('y', 1); break;
    case 'ZOOM_IN_PAN_LEFT': motionFilter = `zoompan=z='1+0.12*on/${frames}':x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps}`; break;
    case 'ZOOM_IN_PAN_RIGHT': motionFilter = `zoompan=z='1+0.12*on/${frames}':x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps}`; break;
    case 'ZOOM_OUT_PAN_LEFT': motionFilter = `zoompan=z='1.12-0.12*on/${frames}':x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps}`; break;
    case 'ZOOM_OUT_PAN_RIGHT': motionFilter = `zoompan=z='1.12-0.12*on/${frames}':x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps}`; break;
    default: motionFilter = zoomExpr(1.0, 1.12);
  }
  return `${fill},${motionFilter},fade=t=in:st=0:d=${fade.toFixed(3)},fade=t=out:st=${fadeOutStart}:d=${fade.toFixed(3)},format=yuv420p`;
}

/** Deterministic FFmpeg argv for a scene render (exported for testability). */
export function buildFfmpegArgs(
  input: {
    backgroundImagePath: string;
    outputPath: string;
    durationSeconds: number;
    motion: SceneMotion;
    width: number;
    height: number;
    /** Resolved, z-ordered character placements (empty = background-only). */
    placements?: readonly { assetPath: string; x: number; y: number; width: number; height: number; opacity?: number }[];
  },
  opts: { overwrite?: boolean } = {},
): string[] {
  const placements = input.placements ?? [];
  const bgGraph = buildFilterGraph(input.motion, input.width, input.height, input.durationSeconds);
  if (placements.length === 0) {
    return [
      '-y',
      ...(opts.overwrite === false ? ['-n'] : []),
      '-loop', '1', '-i', input.backgroundImagePath,
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-filter_complex', `[0:v]${bgGraph}[v]`,
      '-map', '[v]', '-map', '1:a',
      '-t', String(input.durationSeconds.toFixed(3)),
      '-r', String(RENDER_FPS),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart',
      '-shortest',
      input.outputPath,
    ];
  }

  // Character inputs: each character PNG is a looped image input AFTER the background (0)
  // and the silent audio source (1). Indices therefore start at 2.
  const charInputs = placements.flatMap((p) => ['-loop', '1', '-i', p.assetPath]);
  const audioIndex = 1;
  const charStart = 2;
  const overlay = buildCharacterOverlayGraph(placements as any, 'v', charStart, input.width, input.height);
  if (!overlay.ok) throw new Error(`Character overlay graph could not be built: ${overlay.reason}`);
  const graph = `[0:v]${bgGraph}[v];${overlay.graph}`;
  return [
    '-y',
    ...(opts.overwrite === false ? ['-n'] : []),
    '-loop', '1', '-i', input.backgroundImagePath,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    ...charInputs,
    '-filter_complex', graph,
    '-map', `[${overlay.label}]`, '-map', `${audioIndex}:a`,
    '-t', String(input.durationSeconds.toFixed(3)),
    '-r', String(RENDER_FPS),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    '-shortest',
    input.outputPath,
  ];
}

function binPath(kind: 'ffmpeg' | 'ffprobe', explicit?: string): string {
  const envKey = kind === 'ffmpeg' ? (process.env.FFMPEG_PATH || process.env.FFPEG_PATH) : process.env.FFPROBE_PATH;
  return String(explicit || envKey || kind).trim();
}

/**
 * 8DF supplied-video handling. A supplied clip is accepted ONLY if it already satisfies the
 * scene contract (valid video+audio streams, positive duration, usable resolution).
 * If it already matches the required dimensions it is reused byte-for-byte (no transcode);
 * otherwise it is normalized deterministically (preserving audio + duration).
 */
async function acceptSuppliedVideo(
  clipPath: string, outputPath: string,
  opts: { width: number; height: number; durationSeconds: number; ffprobePath?: string; overwrite: boolean },
): Promise<{ ok: true; reused: boolean; width: number; height: number; durationSeconds: number; codec: string; pixFmt: string } | { ok: false; reason: string }> {
  const clip = await validateVideoClip(clipPath, { ffprobePath: opts.ffprobePath });
  if (clip.state !== 'VALID' || !clip.video || !clip.audio) return { ok: false, reason: clip.reason ?? 'Supplied clip is not valid.' };
  await fsp.mkdir(path.dirname(outputPath), { recursive: true }).catch(() => {});

  const probe = await probeSceneOutput(clipPath, opts.ffprobePath);
  const alreadyPerfect = probe.video && probe.audio && probe.width === opts.width && probe.height === opts.height
    && /h264|avc/i.test(probe.codec) && probe.pixFmt === 'yuv420p' && probe.durationSeconds > 0;

  if (alreadyPerfect) {
    // Reuse without re-encoding: copy the bytes to the deterministic scene path.
    await fsp.copyFile(clipPath, outputPath);
    return { ok: true, reused: true, width: probe.width, height: probe.height, durationSeconds: probe.durationSeconds, codec: probe.codec, pixFmt: probe.pixFmt };
  }

  // Deterministic normalization; preserves audio and duration; fail closed on error.
  const args = [
    '-y', ...(opts.overwrite ? [] : ['-n']), '-i', clipPath,
    '-vf', `scale=${opts.width}:${opts.height}:force_original_aspect_ratio=increase,crop=${opts.width}:${opts.height},format=yuv420p`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', outputPath,
  ];
  try { await exec(binPath('ffmpeg'), args, { maxBuffer: 1024 * 1024 * 8 }); }
  catch (e: any) { await fsp.rm(outputPath, { force: true }).catch(() => {}); return { ok: false, reason: `Supplied-clip normalization failed: ${String(e?.message ?? e)}` }; }

  const normalized = await probeSceneOutput(outputPath, opts.ffprobePath);
  if (!normalized.video || !normalized.audio || normalized.width !== opts.width || normalized.height !== opts.height || !(normalized.durationSeconds > 0)) {
    await fsp.rm(outputPath, { force: true }).catch(() => {});
    return { ok: false, reason: `Normalized supplied clip failed validation (${normalized.width}x${normalized.height}, video=${normalized.video}, audio=${normalized.audio}).` };
  }
  return { ok: true, reused: false, width: normalized.width, height: normalized.height, durationSeconds: normalized.durationSeconds, codec: normalized.codec, pixFmt: normalized.pixFmt };
}

/** Validate a background image path: exists, regular file, supported extension. */
async function validateBackground(p: string): Promise<{ ok: true } | { ok: false; code: SceneRenderErrorCode; reason: string }> {
  const ext = p.slice(p.lastIndexOf('.')).toLowerCase();
  if (!SUPPORTED_IMAGE_EXT.includes(ext)) return { ok: false, code: 'UNSUPPORTED_BACKGROUND', reason: `Unsupported background image extension "${ext}" (expected ${SUPPORTED_IMAGE_EXT.join(', ')}).` };
  let stat;
  try { stat = await fsp.stat(p); } catch { return { ok: false, code: 'BACKGROUND_NOT_FOUND', reason: `Background image does not exist: ${p}.` }; }
  if (!stat.isFile()) return { ok: false, code: 'BACKGROUND_NOT_FOUND', reason: `Background path is not a regular file: ${p}.` };
  return { ok: true };
}

/** Probe a rendered MP4 for the quality gates. Exported for testability. */
export async function probeSceneOutput(outputPath: string, ffprobePath?: string): Promise<{ video: boolean; audio: boolean; width: number; height: number; durationSeconds: number; codec: string; pixFmt: string }> {
  const bin = binPath('ffprobe', ffprobePath);
  const { stdout } = await exec(bin, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,pix_fmt:format=duration', '-of', 'json', outputPath]);
  const parsed = JSON.parse(String(stdout));
  const streams: any[] = parsed.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  return {
    video: !!v, audio: !!a,
    width: Number(v?.width ?? 0), height: Number(v?.height ?? 0),
    durationSeconds: Number(parsed?.format?.duration ?? 0),
    codec: String(v?.codec_name ?? ''), pixFmt: String(v?.pix_fmt ?? ''),
  };
}

/**
 * Render ONE scene to `scene-####.mp4`.
 * Fail-closed at every stage; never reports success on an invalid output.
 */
export async function renderScene(input: SceneRenderInputEx, options: SceneRenderOptions): Promise<SceneRenderResult> {
  const n = Number(input?.sceneNumber);
  const mode: SceneRenderMode | '' = input?.mode ?? '';

  // ---- mode + character policy (no silent default) ----
  if (mode !== 'background-only' && mode !== 'require-characters') {
    return { ok: false, sceneNumber: n, code: 'INVALID_INPUT', reason: `renderScene requires an explicit mode ("background-only" | "require-characters"); got ${JSON.stringify(mode)}.` };
  }

  const width = input.width ?? 1920;
  const height = input.height ?? 1080;
  const motion: SceneMotion = input.motion ?? motionFromSceneText('');

  const outputDir = String(options?.outputDir ?? '').trim();
  if (!outputDir) return { ok: false, sceneNumber: n, code: 'INVALID_INPUT', reason: 'renderScene requires options.outputDir.' };
  const outputPathEarly = `${outputDir.replace(/[\\/]+$/, '')}/${sceneClipFilename(n)}`;

  // ---- 8DF: resolve the production path (never hides an invalid supplied clip) ----
  const requestedMode: ScenePipeRenderMode = input.renderMode ?? 'LOCAL_SYNTHESIS';
  if (requestedMode !== 'LOCAL_SYNTHESIS' && requestedMode !== 'SUPPLIED_VIDEO' && requestedMode !== 'AUTO') {
    return { ok: false, sceneNumber: n, code: 'INVALID_INPUT', reason: `Unknown renderMode ${JSON.stringify(requestedMode)}.` };
  }
  let effectiveMode: 'LOCAL_SYNTHESIS' | 'SUPPLIED_VIDEO' = 'LOCAL_SYNTHESIS';
  if (requestedMode !== 'LOCAL_SYNTHESIS') {
    const clipPath = String(input.suppliedClipPath ?? '').trim();
    if (!clipPath) {
      if (requestedMode === 'SUPPLIED_VIDEO') return { ok: false, sceneNumber: n, code: 'SUPPLIED_VIDEO_UNAVAILABLE', reason: 'SUPPLIED_VIDEO requires input.suppliedClipPath.' };
      effectiveMode = 'LOCAL_SYNTHESIS'; // AUTO with no clip → local
    } else {
      const clip = await validateVideoClip(clipPath, { ffprobePath: options.ffprobePath });
      if (clip.state === 'VALID') {
        // A VALID clip satisfies the scene; eat it forward to the supplied-video path.
        const reused = await acceptSuppliedVideo(clipPath, outputPathEarly, { width, height, durationSeconds: clip.durationSeconds ?? 0, ffprobePath: options.ffprobePath, overwrite: options.overwrite !== false });
        if (reused.ok) {
          return {
            ok: true, sceneNumber: n, outputPath: outputPathEarly, width: reused.width, height: reused.height, fps: RENDER_FPS,
            durationSeconds: reused.durationSeconds, mode: 'background-only', backgroundOnly: false, motion,
            videoCodec: reused.codec, pixFmt: reused.pixFmt, hasAudio: true, characterCount: 0,
            renderMode: 'SUPPLIED_VIDEO', suppliedVideoReused: reused.reused,
          };
        }
        if (requestedMode === 'SUPPLIED_VIDEO') {
          return { ok: false, sceneNumber: n, code: 'OUTPUT_VALIDATION_FAILED', reason: reused.reason };
        }
        // AUTO: a VALID-but-unusable clip must NOT silently fall back.
        return { ok: false, sceneNumber: n, code: 'SUPPLIED_VIDEO_INVALID', reason: reused.reason };
      }
      // Present but NOT valid → never hide it behind local synthesis.
      if (requestedMode === 'SUPPLIED_VIDEO') return { ok: false, sceneNumber: n, code: 'SUPPLIED_VIDEO_INVALID', reason: clip.reason ?? 'Supplied clip is not valid.' };
      if (clip.state !== 'MISSING') return { ok: false, sceneNumber: n, code: 'SUPPLIED_VIDEO_INVALID', reason: `AUTO refuses to hide a non-valid supplied clip: ${clip.reason ?? clip.state}.` };
      effectiveMode = 'LOCAL_SYNTHESIS'; // AUTO with an absent clip → local
    }
  }

  // ---- resolve + validate character placements (fail closed) ----
  let resolvedPlacements: CharacterPlacement[] = [];
  if (mode === 'require-characters') {
    const charsDir = String(options?.charactersDir ?? '').trim();
    if (!charsDir) {
      return { ok: false, sceneNumber: n, code: 'INVALID_INPUT', reason: 'require-characters mode requires options.charactersDir.' };
    }
    if (!Array.isArray(input.characters) || input.characters.length === 0) {
      return { ok: false, sceneNumber: n, code: 'CHARACTER_ASSETS_UNAVAILABLE', reason: 'require-characters mode requires at least one character placement.' };
    }
    const resolved = await resolveCharacterPlacements(input.characters, { charactersDir: charsDir });
    if (!resolved.ok) return { ok: false, sceneNumber: n, code: resolved.code, reason: resolved.reason, characterTag: resolved.characterTag, assetState: resolved.assetState };
    resolvedPlacements = resolved.placements;
  }

  // ---- input validation (before any FFmpeg) ----
  if (input.durationSeconds === undefined || input.durationSeconds === null) {
    return { ok: false, sceneNumber: n, code: 'DURATION_UNRESOLVED', reason: 'renderScene requires a resolved durationSeconds (8DE sceneState); it never invents one.' };
  }
  const dur = validateSceneDuration(input.durationSeconds);
  if (!dur.ok) return { ok: false, sceneNumber: n, code: 'INVALID_INPUT', reason: dur.reason };
  const base = validateSceneRenderInput({ sceneNumber: n, backgroundImagePath: input.backgroundImagePath, durationSeconds: dur.effective, motion, width, height });
  if (!base.ok) return { ok: false, sceneNumber: n, code: 'INVALID_INPUT', reason: base.reason };
  const bg = await validateBackground(String(input.backgroundImagePath));
  if (!bg.ok) return { ok: false, sceneNumber: n, code: bg.code, reason: bg.reason };

  const outputPath = outputPathEarly;
  await fsp.mkdir(outputDir, { recursive: true });

  // ---- render ----
  const args = buildFfmpegArgs({ backgroundImagePath: String(input.backgroundImagePath), outputPath, durationSeconds: dur.effective, motion, width, height, placements: resolvedPlacements }, { overwrite: options.overwrite !== false });
  try {
    await exec(binPath('ffmpeg', options.ffmpegPath), args, { maxBuffer: 1024 * 1024 * 8 });
  } catch (e: any) {
    await fsp.rm(outputPath, { force: true }).catch(() => {});
    return { ok: false, sceneNumber: n, code: 'FFMPEG_FAILURE', reason: `FFmpeg failed: ${String(e?.message ?? e)}` };
  }

  // ---- quality gates ----
  try {
    const stat = await fsp.stat(outputPath);
    if (!stat.isFile() || stat.size <= 0) {
      await fsp.rm(outputPath, { force: true }).catch(() => {});
      return { ok: false, sceneNumber: n, code: 'OUTPUT_VALIDATION_FAILED', reason: `Rendered output is missing or empty (${outputPath}).` };
    }
    const probe = await probeSceneOutput(outputPath, options.ffprobePath);
    const tol = Number.isFinite(options.durationToleranceSeconds) ? Number(options.durationToleranceSeconds) : 0.5;
    const problems: string[] = [];
    if (!probe.video) problems.push('no video stream');
    if (!probe.audio) problems.push('no audio stream (edit.ts requires one)');
    if (probe.width !== width || probe.height !== height) problems.push(`dimensions ${probe.width}x${probe.height} != ${width}x${height}`);
    if (probe.codec && !/h264|avc/i.test(probe.codec)) problems.push(`codec ${probe.codec} is not H.264`);
    if (probe.pixFmt && probe.pixFmt !== 'yuv420p') problems.push(`pix_fmt ${probe.pixFmt} != yuv420p`);
    if (!(probe.durationSeconds > 0)) problems.push('duration is not positive');
    else if (Math.abs(probe.durationSeconds - dur.effective) > tol) problems.push(`duration ${probe.durationSeconds}s differs from requested ${dur.effective}s by more than ${tol}s`);
    if (problems.length) {
      await fsp.rm(outputPath, { force: true }).catch(() => {});
      return { ok: false, sceneNumber: n, code: 'OUTPUT_VALIDATION_FAILED', reason: `Rendered scene failed validation: ${problems.join('; ')}.` };
    }
    return {
      ok: true, sceneNumber: n, outputPath, width, height, fps: RENDER_FPS,
      durationSeconds: probe.durationSeconds, mode, backgroundOnly: resolvedPlacements.length === 0, motion,
      videoCodec: probe.codec, pixFmt: probe.pixFmt, hasAudio: true,
      characterCount: resolvedPlacements.length,
      renderMode: effectiveMode, suppliedVideoReused: false,
    };
  } catch (e: any) {
    await fsp.rm(outputPath, { force: true }).catch(() => {});
    return { ok: false, sceneNumber: n, code: 'OUTPUT_VALIDATION_FAILED', reason: `Output validation could not be completed: ${String(e?.message ?? e)}` };
  }
}
