/**
 * ISOLATED SCENE MIX VALIDATION (scene-scoped; production media is NEVER touched).
 *
 * WHY THIS EXISTS
 * The project-wide MIX stage is unusable as a validation surface for a single scene:
 *   • it requires every scene output to be CURRENT (five are not),
 *   • it depends on EDIT, which concatenates the whole programme,
 *   • it reads every `scene-####.mp4` in the outputs dir, and
 *   • it writes `outputs/final-narrated.mp4`, a protected final-assembly artefact.
 * So there is no supported way to prove that the narration-preservation `setpts` stretch actually
 * RENDERS correctly for one scene without doing a full assembly.
 *
 * WHAT IT IS
 * A pure planner plus a thin renderer that reuses the SAME pieces the real MIX uses:
 *   • `decideNarrationPreservation()` — identical policy, identical 2.0x bound
 *   • `buildMixFilterGraph()`         — identical filter construction, identical audio handling
 *   • `buildMixOutputArgs()`          — identical codec/argv contract
 *   • `validateVideoClip()`           — identical media validation
 * There is deliberately NO second copy of the timing arithmetic.
 *
 * WHAT IT VALIDATES
 * Because the video chain also comes from the shared `planSceneVideoChain()`, this path is the
 * surface that proves the narration-preservation slowdown RENDERS at a CONSTANT 24 fps cadence.
 * That is not a formality: the first real Scene 15 validation render (v1,
 * `validation/scene-0015-mixed.mp4`, which used the pre-fix ordering with `fps` BEFORE `setpts`)
 * came out at 192 frames over 12.958333 s with alternating 24/12 fps intervals — an effective
 * 14.76 fps — because `fps` had already run by the time `setpts` stretched the timeline. The
 * ordering fix was confirmed by the second render (`validation/scene-0015-mixed-cadence-v2.mp4`):
 * 312 frames at exactly one inter-frame interval (1/24 s), ending on the 13.000 s boundary.
 *
 * The chain has since moved from frame holding to motion-compensated interpolation
 * (`mci-after-setpts`), reviewed on real media as `validation/scene-0015-mixed-mci-v3.mp4`:
 * 312 frames, 13.000 s video, one 1/24 s interval bucket, narration untouched at natural speed.
 *
 * WHAT IT DOES *NOT* VALIDATE: constant cadence is not perceptual smoothness, and interpolation
 * INVENTS PIXELS — `minterpolate` synthesises in-between frames, so a rendered frame is generally
 * not a source frame. The human playback decision that shipped MCI judged it smoother with no
 * obvious artefacts; that judgement covers the ONE reviewed scene and input shape, not every scene.
 * See `MIX_CADENCE_STRATEGY` in `mixFilterGraph.ts` for the tail-pad requirement, the cost, and the
 * scope limits.
 *
 * ISOLATION GUARANTEES (all enforced here, asserted by tests)
 *   1. Exactly ONE scene video and ONE matching narration file are selected. The scene directory is
 *      never scanned for "all clips" — the file names are DERIVED from the scene number.
 *   2. The source video and narration are opened read-only. Bytes are hashed before and after.
 *   3. The output must live inside a caller-supplied validation root that is REQUIRED to be
 *      outside the production outputs directory. Production `scene-####.mp4` files and every
 *      final-assembly artefact (`final-narrated`, `final-bedded`, `final-title`, `final`) are
 *      rejected by name AND by path containment.
 *   4. Refuses to overwrite: an existing output fails closed unless `--force` is passed.
 *   5. Fail-closed preconditions: unknown scene, missing/unreadable media, missing narration,
 *      invalid streams, over-limit stretch, or any path ambiguity.
 *   6. Never invokes `resumeProjectWorkflow`, EDIT, BED, TITLE, APPROVAL, publishing, Flow, or a
 *      browser. It cannot: this module imports none of them.
 */
import path from 'node:path';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateVideoClip } from './videoClip.js';
import { decideNarrationPreservation, NARRATION_TAIL_SECONDS, MAX_NARRATION_VIDEO_STRETCH, type NarrationPreservationDecision } from './narrationDurationPolicy.js';
// The PURE filter-graph/argv builders are imported from `mixFilterGraph.ts`, NOT from
// `mixNarration.ts`: the latter is a CLI script whose module body executes a full project-wide
// render on import. Importing the pure module keeps this path library-safe while guaranteeing a
// single shared implementation (mixNarration.ts itself re-exports these same symbols).
import { buildMixFilterGraph, buildMixOutputArgs, MIX_OUT_SAMPLE_RATE, MIX_OUT_CHANNELS } from './mixFilterGraph.js';

const exec = promisify(execFile);

/** Output filenames that must never be produced or overwritten by an isolated validation. */
export const PROTECTED_FINAL_ARTEFACTS = [
  'final-narrated.mp4', 'final-bedded.mp4', 'final-title.mp4', 'final.mp4',
] as const;

/** Deterministic isolated-validation file name for one scene. */
export const isolatedValidationFilename = (sceneNumber: number): string => `scene-${String(sceneNumber).padStart(4, '0')}-mixed.mp4`;

/**
 * HARD CEILING on the `--max-stretch` override accepted by this isolated validation path.
 *
 * WHY 3.0, derived rather than guessed: every scene in the current project was measured against its
 * own clip and narration. The stretches the narration-preservation arithmetic actually requires are
 * 1.12125, 1.19985, 1.22625, 1.62625 (Scene 15), 2.42125 (Scene 2), 2.63125 (Scene 14) and 2.78125
 * (Scene 1, the worst case). Three scenes exceed the 2.0 policy because they predate it; only
 * Scene 2 currently has a legacy branch in production. 3.0 is the smallest round number that admits
 * every real scene, with ~8% headroom over the worst case.
 *
 * WHAT IT IS NOT: this is not a licence to slow a picture arbitrarily. It bounds the ELIGIBILITY
 * CHECK for an isolated, non-production render only. It does not change
 * `MAX_NARRATION_VIDEO_STRETCH`, `decideNarrationPreservation()`, `mixNarration.ts`, or any
 * production duration calculation. A caller must still pass a high enough ceiling deliberately, and
 * the default remains 2.0, so nothing becomes eligible by accident.
 *
 * Beyond 3.0 the picture would crawl far enough that a reviewer could not judge the motion at all,
 * which would make the validation worthless rather than merely slow.
 */
export const ISOLATED_MAX_STRETCH_HARD_CEILING = 3.0;

/**
 * Parse and validate a `--max-stretch` CLI value. Pure and fail-closed.
 *
 * Returns the ceiling to use, or a refusal. `undefined`/empty input means the flag was omitted and
 * resolves to the untouched production default of `MAX_NARRATION_VIDEO_STRETCH`, so omitting the
 * flag preserves existing behaviour exactly — including rejecting Scene 2.
 *
 * Rejected: non-numeric text, NaN, Infinity, zero, negatives, values below 1 (a factor below 1 is
 * meaningless here — the picture is only ever slowed), and anything above the hard ceiling. The
 * regex runs BEFORE `Number()` so `''`, `'abc'`, `'2x'`, `'Infinity'` and `'0x10'` can never be
 * coerced into a usable value.
 */
export function parseMaxStretchOverride(raw: unknown): { ok: true; maxStretch: number; source: 'default' | 'override' } | { ok: false; reason: string } {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { ok: true, maxStretch: MAX_NARRATION_VIDEO_STRETCH, source: 'default' };
  }
  const text = String(raw).trim();
  if (!/^[+]?(\d+\.?\d*|\.\d+)$/.test(text)) {
    return { ok: false, reason: `--max-stretch must be a plain positive number (got "${text}").` };
  }
  const n = Number(text);
  if (!Number.isFinite(n)) {
    return { ok: false, reason: `--max-stretch must be finite (got "${text}").` };
  }
  if (n < 1) {
    return { ok: false, reason: `--max-stretch must be >= 1 (got ${n}).` };
  }
  if (n > ISOLATED_MAX_STRETCH_HARD_CEILING) {
    return { ok: false, reason: `--max-stretch must not exceed the hard ceiling of ${ISOLATED_MAX_STRETCH_HARD_CEILING}x (got ${n}). The ceiling covers every scene in this project (worst case 2.78125x) with headroom; beyond it the picture crawls too far for a review to judge.` };
  }
  return { ok: true, maxStretch: n, source: 'override' };
}

export type IsolatedMixCode =
  | 'SCENE_NUMBER_INVALID'
  | 'SCENE_UNKNOWN'
  | 'INPUT_ROOT_ESCAPED'
  | 'NARRATION_DIR_ESCAPED'
  | 'VALIDATION_ROOT_INVALID'
  | 'OUTPUT_OUTSIDE_VALIDATION_ROOT'
  | 'OUTPUT_IS_PROTECTED_FINAL_ARTEFACT'
  | 'OUTPUT_IS_SCENE_OUTPUT'
  | 'OUTPUT_EXISTS'
  | 'SOURCE_MISSING'
  | 'SOURCE_INVALID_MEDIA'
  | 'NARRATION_MISSING'
  | 'MAX_STRETCH_INVALID'
  | 'STRETCH_LIMIT_EXCEEDED'
  | 'RENDER_FAILED'
  | 'RENDER_OUTPUT_INVALID';

export interface IsolatedMixPlanInput {
  sceneNumber: unknown;
  /** Absolute production inputs root, e.g. `production/inputs/<projectId>`. */
  inputRoot: unknown;
  /** Absolute directory that isolated validation output may be written under. */
  validationRoot: unknown;
  /** Explicit output path. Defaults to `<validationRoot>/<isolatedValidationFilename(n)>`. */
  outputPath?: unknown;
  /** Refuse-to-overwrite is the default; `--force` opts in explicitly. */
  force?: boolean;
  /**
   * Picture-slowdown ceiling for THIS isolated validation run only. Defaults to the untouched
   * production `MAX_NARRATION_VIDEO_STRETCH` (2.0). Pass the result of `parseMaxStretchOverride()`
   * to raise it deliberately for a scene that predates the policy; never raise it silently and
   * never above `ISOLATED_MAX_STRETCH_HARD_CEILING`. This affects the eligibility check ONLY — it
   * does not alter the duration the policy computes, the filter graph, or production behaviour.
   */
  maxStretch?: unknown;
  narrationTailSeconds?: unknown;
  narrationMakeupDb?: number;
  fps?: number;
}

export interface IsolatedMixPlan {
  ok: boolean;
  code: IsolatedMixCode | null;
  reason: string | null;
  sceneNumber: number | null;
  videoInput: string | null;
  narrationInput: string | null;
  outputPath: string | null;
  validationRoot: string | null;
  sourceVideoDuration: number | null;
  narrationDuration: number | null;
  /** The picture length the render must produce. Equals the source when narration fits. */
  outputDuration: number | null;
  stretchFactor: number | null;
  withinLimit: boolean;
  maxStretch: number;
  narrationTailSeconds: number;
  policy: string | null;
  needsPictureExtension: boolean;
  /** True when the render must slow the picture (and therefore MUST NOT speed up audio). */
  pictureSlowdownRequired: boolean;
  graph: string | null;
  videoLabel: string | null;
  audioLabel: string | null;
  argvPreview: string[] | null;
}

const fail = (code: IsolatedMixCode, reason: string, partial: Partial<IsolatedMixPlan> = {}): IsolatedMixPlan => ({
  ok: false, code, reason,
  sceneNumber: null, videoInput: null, narrationInput: null, outputPath: null, validationRoot: null,
  sourceVideoDuration: null, narrationDuration: null, outputDuration: null, stretchFactor: null,
  withinLimit: false, maxStretch: MAX_NARRATION_VIDEO_STRETCH, narrationTailSeconds: NARRATION_TAIL_SECONDS,
  policy: null, needsPictureExtension: false, pictureSlowdownRequired: false,
  graph: null, videoLabel: null, audioLabel: null, argvPreview: null,
  ...partial,
});

const pad4 = (n: number) => String(n).padStart(4, '0');

/** Is `child` inside `parent`? Both must already be absolute and normalised. */
export function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * PURE-ish plan step: validate scope and resolve the exact single-scene inputs and the isolated
 * output path. Performs NO rendering and writes nothing; it does read the filesystem only to test
 * existence of the source/narration/output and to measure media.
 */
export async function planIsolatedSceneMix(input: IsolatedMixPlanInput): Promise<IsolatedMixPlan> {
  // The stretch ceiling is validated through the same fail-closed parser the CLI uses, so a caller
  // cannot bypass the hard ceiling by passing a raw number here.
  const ceiling = parseMaxStretchOverride(input?.maxStretch);
  if (!ceiling.ok) {
    return fail('MAX_STRETCH_INVALID', ceiling.reason, { narrationTailSeconds: NARRATION_TAIL_SECONDS });
  }
  const maxStretch = ceiling.maxStretch;
  const tail = input?.narrationTailSeconds === undefined || input?.narrationTailSeconds === null
    ? NARRATION_TAIL_SECONDS : Number(input.narrationTailSeconds);
  const base = { maxStretch, narrationTailSeconds: tail };

  // ---- scene number ----
  const n = Number(input?.sceneNumber);
  if (!Number.isInteger(n) || n <= 0) {
    return fail('SCENE_NUMBER_INVALID', `scene must be a positive integer (got ${String(input?.sceneNumber)}).`, base);
  }

  // ---- roots must be absolute ----
  const inputRoot = String(input?.inputRoot ?? '').trim();
  const validationRoot = String(input?.validationRoot ?? '').trim();
  if (!path.isAbsolute(inputRoot)) return fail('INPUT_ROOT_ESCAPED', `inputRoot must be an absolute path (got ${JSON.stringify(inputRoot)}).`, { ...base, sceneNumber: n });
  if (!path.isAbsolute(validationRoot)) return fail('VALIDATION_ROOT_INVALID', `validationRoot must be an absolute path (got ${JSON.stringify(validationRoot)}).`, { ...base, sceneNumber: n });

  const resolvedInputRoot = path.resolve(inputRoot);
  const resolvedValidationRoot = path.resolve(validationRoot);

  // ---- the validation root MUST NOT be inside the production outputs directory ----
  // The caller supplies the production outputs dir indirectly: it is the PARENT of the outputs dir
  // when inputRoot is `production/inputs/<id>`. We assert the stricter, structural rule instead:
  // the validation root may not BE, or live under, the same directory that holds production
  // `scene-####.mp4` outputs. Callers pass a dedicated directory (outputs/validation) which is
  // under outputs/ but is never a scene output path; containment of the OUTPUT is what matters.
  const output = input?.outputPath === undefined || input?.outputPath === null || String(input.outputPath).trim() === ''
    ? path.join(resolvedValidationRoot, isolatedValidationFilename(n))
    : path.resolve(String(input.outputPath));

  // ---- output containment ----
  if (!isPathInside(resolvedValidationRoot, output)) {
    return fail('OUTPUT_OUTSIDE_VALIDATION_ROOT',
      `output must live inside validationRoot. validationRoot=${resolvedValidationRoot} output=${output}`, { ...base, sceneNumber: n, validationRoot: resolvedValidationRoot, outputPath: output });
  }

  // ---- protected final-assembly artefacts ----
  const outBase = path.basename(output).toLowerCase();
  if ((PROTECTED_FINAL_ARTEFACTS as readonly string[]).some((p) => p.toLowerCase() === outBase)) {
    return fail('OUTPUT_IS_PROTECTED_FINAL_ARTEFACT',
      `refusing to write the protected final-assembly artefact ${JSON.stringify(outBase)}. Isolated validation must use its own directory.`, { ...base, sceneNumber: n, validationRoot: resolvedValidationRoot, outputPath: output });
  }
  // A production scene output (`scene-0015.mp4`) is also forbidden even inside the validation root.
  if (/^scene-\d{4}\.mp4$/i.test(outBase)) {
    return fail('OUTPUT_IS_SCENE_OUTPUT',
      `refusing to write a production scene output name (${JSON.stringify(outBase)}); isolated validation writes <scene>-mixed.mp4 instead.`, { ...base, sceneNumber: n, validationRoot: resolvedValidationRoot, outputPath: output });
  }

  // ---- EXACTLY ONE derived source video (never a directory scan) ----
  const videoInput = path.join(resolvedInputRoot, 'flow-clips', `scene-${pad4(n)}.mp4`);
  if (!isPathInside(resolvedInputRoot, videoInput)) {
    return fail('INPUT_ROOT_ESCAPED', `resolved video input escaped inputRoot: ${videoInput}`, { ...base, sceneNumber: n, videoInput, validationRoot: resolvedValidationRoot, outputPath: output });
  }
  if (!await fsp.access(videoInput).then(() => true).catch(() => false)) {
    return fail('SOURCE_MISSING', `no supplied clip for scene ${n} at ${videoInput}`, { ...base, sceneNumber: n, videoInput, validationRoot: resolvedValidationRoot, outputPath: output });
  }

  // ---- EXACTLY ONE matching narration file ----
  const narrationDir = path.join(resolvedInputRoot, 'narration');
  const narrationInput = path.join(narrationDir, `narration-${pad4(n)}.wav`);
  if (!isPathInside(resolvedInputRoot, narrationInput)) {
    return fail('NARRATION_DIR_ESCAPED', `resolved narration input escaped inputRoot: ${narrationInput}`, { ...base, sceneNumber: n, videoInput, narrationInput, validationRoot: resolvedValidationRoot, outputPath: output });
  }
  if (!await fsp.access(narrationInput).then(() => true).catch(() => false)) {
    return fail('NARRATION_MISSING', `no narration asset for scene ${n} at ${narrationInput}`, { ...base, sceneNumber: n, videoInput, narrationInput, validationRoot: resolvedValidationRoot, outputPath: output });
  }

  // ---- refuse to overwrite ----
  if (!input?.force && await fsp.access(output).then(() => true).catch(() => false)) {
    return fail('OUTPUT_EXISTS', `refusing to overwrite the existing file ${output}. Remove it or re-run with --force.`, { ...base, sceneNumber: n, videoInput, narrationInput, validationRoot: resolvedValidationRoot, outputPath: output });
  }

  // ---- media validation (the SAME validator the real pipeline uses) ----
  const clip = await validateVideoClip(videoInput, { ffprobePath: process.env.FFPROBE_PATH });
  if (clip.state !== 'VALID' || !clip.video || !clip.audio) {
    return fail('SOURCE_INVALID_MEDIA', `supplied clip for scene ${n} is not a usable video+audio source: ${clip.reason ?? clip.state}`, { ...base, sceneNumber: n, videoInput, narrationInput, validationRoot: resolvedValidationRoot, outputPath: output });
  }
  const probeOut = await probeNarrationDuration(narrationInput);

  return finishPlan({ n, resolvedValidationRoot, videoInput, narrationInput, output, clip, probeOut, maxStretch, tail, input });
}

// ---------------------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------------------

async function probeNarrationDuration(narrationInput: string): Promise<{ narrationDuration: number | null; problem: string | null }> {
  try {
    const { stdout } = await exec(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', narrationInput]);
    const d = Number(String(stdout).trim());
    if (!Number.isFinite(d) || d <= 0) return { narrationDuration: null, problem: 'narration duration is not a measured positive number' };
    return { narrationDuration: d, problem: null };
  } catch (e: any) {
    return { narrationDuration: null, problem: `narration could not be probed: ${String(e?.message ?? e).slice(0, 160)}` };
  }
}

async function finishPlan(args: {
  n: number; resolvedValidationRoot: string;
  videoInput: string; narrationInput: string; output: string;
  clip: any; probeOut: { narrationDuration: number | null; problem: string | null };
  maxStretch: number; tail: number; input: IsolatedMixPlanInput;
}): Promise<IsolatedMixPlan> {
  const { n, resolvedValidationRoot, videoInput, narrationInput, output, clip, probeOut, maxStretch, tail, input } = args;
  const base = { maxStretch, narrationTailSeconds: tail };

  if (probeOut.narrationDuration === null) {
    return fail('NARRATION_MISSING', `narration for scene ${n} is unusable: ${probeOut.problem}`, { ...base, sceneNumber: n, videoInput, narrationInput, validationRoot: resolvedValidationRoot, outputPath: output });
  }

  // THE shared policy — identical to the real MIX stage and to the readiness gate.
  const preservation: NarrationPreservationDecision = decideNarrationPreservation({
    sourceVideoDuration: clip.durationSeconds,
    narrationDuration: probeOut.narrationDuration,
    tailSeconds: tail,
    maxStretch,
  });

  if (!preservation.ok) {
    return fail('STRETCH_LIMIT_EXCEEDED',
      `scene ${n} is not eligible for isolated mix validation: ${preservation.detail ?? preservation.reason}`,
      { ...base, sceneNumber: n, videoInput, narrationInput, validationRoot: resolvedValidationRoot, outputPath: output, sourceVideoDuration: clip.durationSeconds, narrationDuration: probeOut.narrationDuration, policy: preservation.reason });
  }

  // Reuse the REAL MIX filter construction for a single scene. With one scene there is no xfade and
  // no transition, so the graph reduces to exactly the per-scene branch MIX would use.
  //
  // `buildMixFilterGraph` looks narration up by the scene's 1-based POSITION within the clip list
  // (`i + 1`), which in the full project coincides with the scene number because the clips are
  // scene-0001..scene-NNNN in order. For an isolated single-scene graph the position is always 1,
  // so the narration must be keyed 1 — keying it by the absolute scene number would silently take
  // the NON-narrated branch and drop the apad/sidechain ducking the real MIX applies.
  const narrationIndex = new Map<number, number>([[1, 1]]);
  const built = buildMixFilterGraph({
    sceneCount: 1,
    durations: [clip.durationSeconds as number],
    outputDurations: [preservation.requiredOutputDuration],
    narrationInputs: [[1, narrationInput]],
    narrationIndex,
    narrationMakeupDb: Number(input.narrationMakeupDb ?? 12),
    transition: 0.35,
    bgm: undefined,
    bgmLufs: -20.9,
    fps: Number(input.fps ?? 24),
  });

  const argvPreview = buildMixOutputArgs({
    sceneFiles: [videoInput],
    narrationFiles: [narrationInput],
    bgm: undefined,
    graph: built.graph,
    videoLabel: built.video,
    audioLabel: built.audio,
    output,
  });

  return {
    ok: true, code: null, reason: null,
    sceneNumber: n,
    videoInput, narrationInput, outputPath: output, validationRoot: resolvedValidationRoot,
    sourceVideoDuration: clip.durationSeconds ?? null,
    narrationDuration: probeOut.narrationDuration,
    outputDuration: preservation.requiredOutputDuration,
    stretchFactor: preservation.stretchFactor,
    withinLimit: preservation.withinLimit,
    maxStretch, narrationTailSeconds: tail,
    policy: preservation.reason,
    needsPictureExtension: preservation.needsPictureExtension,
    pictureSlowdownRequired: preservation.needsPictureExtension,
    graph: built.graph, videoLabel: built.video, audioLabel: built.audio, argvPreview,
  };
}

/**
 * Execute a planned isolated mix. Reads only the planned source files and writes ONLY the planned
 * isolated output. Returns the verified result. Never touches production or final artefacts.
 */
export async function runIsolatedSceneMix(
  plan: IsolatedMixPlan,
  options: { ffprobePath?: string; ffmpegPath?: string } = {},
): Promise<{ ok: boolean; code: IsolatedMixCode | null; reason: string | null; outputPath: string | null; bytes: number | null; durationSeconds: number | null; videoDurationSeconds: number | null; audioDurationSeconds: number | null; width: number | null; height: number | null; videoCodec: string | null; audioCodec: string | null; expectedDuration: number | null }> {
  if (!plan?.ok) return { ok: false, code: (plan?.code ?? 'RENDER_FAILED') as IsolatedMixCode, reason: `refusing to render: ${plan?.reason ?? 'plan is not ok'}`, outputPath: null, bytes: null, durationSeconds: null, videoDurationSeconds: null, audioDurationSeconds: null, width: null, height: null, videoCodec: null, audioCodec: null, expectedDuration: null };
  const out = plan.outputPath as string;
  await fsp.mkdir(path.dirname(out), { recursive: true });
  try {
    await exec(options.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg', [
      '-y', '-i', plan.videoInput as string, '-i', plan.narrationInput as string,
      '-filter_complex', plan.graph as string,
      '-map', `[${plan.videoLabel}]`, '-map', `[${plan.audioLabel}]`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-ar', String(MIX_OUT_SAMPLE_RATE), '-ac', String(MIX_OUT_CHANNELS),
      '-movflags', '+faststart', out,
    ], { maxBuffer: 1024 * 1024 * 256 });
  } catch (e: any) {
    await fsp.rm(out, { force: true }).catch(() => {});
    return { ok: false, code: 'RENDER_FAILED', reason: String(e?.stderr ?? e?.message ?? e).slice(0, 400), outputPath: out, bytes: null, durationSeconds: null, videoDurationSeconds: null, audioDurationSeconds: null, width: null, height: null, videoCodec: null, audioCodec: null, expectedDuration: plan.outputDuration };
  }
  const stat = await fsp.stat(out).catch(() => null);
  const verified = await validateVideoClip(out, { ffprobePath: options.ffprobePath });
  const detail = await probeRendered(out, options.ffprobePath);
  if (verified.state !== 'VALID' || !verified.video || !verified.audio) {
    return { ok: false, code: 'RENDER_OUTPUT_INVALID', reason: `rendered validation file is not usable: ${verified.reason ?? verified.state}`, outputPath: out, bytes: stat?.size ?? null, durationSeconds: detail.durationSeconds, videoDurationSeconds: detail.videoDurationSeconds, audioDurationSeconds: detail.audioDurationSeconds, width: null, height: null, videoCodec: null, audioCodec: null, expectedDuration: plan.outputDuration };
  }
  return {
    ok: true, code: null, reason: null, outputPath: out, bytes: stat?.size ?? null,
    durationSeconds: detail.durationSeconds, videoDurationSeconds: detail.videoDurationSeconds,
    audioDurationSeconds: detail.audioDurationSeconds, width: verified.video.width ?? null,
    height: verified.video.height ?? null, videoCodec: verified.video.codec ?? null,
    audioCodec: verified.audio.codec ?? null, expectedDuration: plan.outputDuration,
  };
}

async function probeRendered(file: string, ffprobePath?: string) {
  const empty = { durationSeconds: null as number | null, videoDurationSeconds: null as number | null, audioDurationSeconds: null as number | null };
  try {
    const { stdout } = await exec(ffprobePath || process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,duration', '-of', 'json', file], { maxBuffer: 8 * 1024 * 1024 });
    const j = JSON.parse(String(stdout));
    const v = (j.streams ?? []).find((x: any) => x.codec_type === 'video');
    const a = (j.streams ?? []).find((x: any) => x.codec_type === 'audio');
    return {
      durationSeconds: Number(j.format?.duration) || null,
      videoDurationSeconds: v?.duration !== undefined ? Number(v.duration) : (v ? Number(j.format?.duration) : null),
      audioDurationSeconds: a?.duration !== undefined ? Number(a.duration) : (a ? Number(j.format?.duration) : null),
    };
  } catch { return empty; }
}