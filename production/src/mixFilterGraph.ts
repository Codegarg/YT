/**
 * MIX filter-graph and argv construction � PURE, SIDE-EFFECT FREE.
 *
 * Extracted VERBATIM from `mixNarration.ts` so that the real project-wide MIX stage and the
 * isolated scene-MIX validation path share ONE implementation of the timing, filter and codec
 * rules. Behaviour is unchanged; only the module boundary moved.
 *
 * Nothing in this file executes ffmpeg, reads the filesystem, or touches the network, so it is
 * safe to import from a library context. `mixNarration.ts` re-exports these symbols, so every
 * existing importer (`stageExecutor.ts`, `mix_narration_fix_test.mts`, ...) keeps working.
 */

/**
 * MIX output AUDIO contract. Pinned explicitly: without `-ar`/`-ac` FFmpeg negotiated the
 * output rate from the graph inputs, so a 24 kHz mono narration source dragged the whole
 * programme down to 24 kHz. Every stage artefact is 48 kHz stereo; MIX must be too.
 */
export const MIX_OUT_SAMPLE_RATE = 48000;

/**
 * Common frame rate applied to every input before xfade. Flow clips can carry differing timebases
 * (1/12288 vs 1/90000), and xfade fails hard when two inputs' timebases differ. Was previously a
 * CLI-derived local in mixNarration.ts (`arg('--fps','24')`); it is now a parameter with this
 * default so the pure builder no longer depends on process.argv. mixNarration still passes its
 * `--fps` value, so CLI behaviour is unchanged.
 */
export const MIX_DEFAULT_FPS = 24;
export const MIX_OUT_CHANNELS = 2;

/**
 * RESOURCE BOUND on FFmpeg threading for the MCI render.
 *
 * WHY: the shipped chain is
 *   `minterpolate=fps=F:mi_mode=mci:mc_mode=aobmc:me_mode=bidir`
 * which is the most memory-hungry interpolation FFmpeg offers -- bidirectional motion estimation
 * with adaptive block sizing keeps per-thread motion-vector and reference buffers for every frame
 * in flight. Left unbounded, FFmpeg sizes BOTH the filter graph and the encoder from the CPU
 * count, so each MIX instance multiplies those buffers by the core count. Under concurrent
 * workloads (the 95-file test suite runs many MIX renders at once) that has been observed to fail
 * outright with an allocation error inside the encoder (`x264: malloc ... failed`,
 * `Task finished with error code: -12 Cannot allocate memory`, then cascading `-22`).
 *
 * WHAT THIS DOES NOT CHANGE: nothing about the filter graph, the frame grid, the retiming factor,
 * the narration-preservation target or the audio contract. Frame COUNT and timing are unaffected,
 * because a 24 fps grid is a property of the graph, not of how many threads evaluate it.
 *
 * WHY 2: it caps per-instance thread memory at roughly an eighth of the 16-core default while
 * still letting one MIX render use more than a single core, so a real (single-project) production
 * run keeps its throughput. This is a bound, not a serialisation.
 */
export const MIX_MAX_FILTER_THREADS = 2;
export const MIX_MAX_ENCODER_THREADS = 2;

/**
 * Deterministic FFmpeg argv for the MIX render.
 *
 * The narration split labels are consumed by the graph; this builder only wires inputs, maps and
 * codecs. `-ar`/`-ac` pin the audio contract; the video settings are untouched.
 */
export function buildMixOutputArgs(p: {
  sceneFiles: readonly string[];
  narrationFiles: readonly string[];
  bgm?: string;
  graph: string;
  videoLabel: string;
  audioLabel: string;
  output: string;
}): string[] {
  return [
    '-y',
    ...p.sceneFiles.flatMap((file) => ['-i', file]),
    ...p.narrationFiles.flatMap((file) => ['-i', file]),
    ...(p.bgm ? ['-i', p.bgm] : []),
    '-filter_complex', p.graph,
    '-map', `[${p.videoLabel}]`, '-map', `[${p.audioLabel}]`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-ar', String(MIX_OUT_SAMPLE_RATE), '-ac', String(MIX_OUT_CHANNELS),
    '-movflags', '+faststart',
    // Resource bounds (see MIX_MAX_FILTER_THREADS). `-filter_threads` caps the filter graph
    // (minterpolate); `-threads` caps the video encoder. Both precede the output file so they
    // apply to the encoder. Neither alters the graph, the frame grid, or the audio contract.
    '-filter_threads', String(MIX_MAX_FILTER_THREADS),
    '-threads', String(MIX_MAX_ENCODER_THREADS),
    p.output,
  ];
}

/**
 * Output frame count a retimed scene is expected to carry.
 *
 * A `fps` filter resamples onto a constant grid of `fps`-second steps, so the count is simply the
 * output length in frames. Note that a 24 fps grid cannot represent an arbitrary duration: the
 * 13.010 s narration-preservation target rounds to 312 frames = 13.000 s, leaving the picture
 * 10 ms short of the audio rather than quantising the AUDIO to fit the video.
 */
export const expectedMixFrameCount = (outputDurationSeconds: number, fps: number = MIX_DEFAULT_FPS): number =>
  Math.round(outputDurationSeconds * fps);

/**
 * How a slowed picture is brought back to a constant frame rate.
 *
 * `frame-hold-after-setpts` (SHIPPED): a second `fps` filter AFTER the `setpts` retiming resamples
 * the stretched timeline onto a constant 24 fps grid. This yields a CONSTANT CADENCE — the measured
 * defect was an alternating 24/12 fps pattern, which this removes completely.
 *
 * THE SHIPPED STRATEGY INVENTS PIXELS, and that is the accepted trade:
 *   `minterpolate` synthesises in-between frames, so a rendered frame is generally NOT a source
 *   frame. The human playback review accepted this in exchange for smoother motion, but it means
 *   MCI output cannot be verified by frame identity, and optical-flow artefacts remain possible on
 *   faces, hair, hands and high-contrast edges. Any future claim that this path is "artifact-free"
 *   is wrong.
 *
 * MEASUREMENT HISTORY — how it was measured, which matters:
 * A lossless (FFV1) export of this exact chain, applied to the real Scene 15 Flow clip and decoded
 * with `-fps_mode passthrough`, produced 312 output frames of which ALL 312 were BYTE-IDENTICAL to
 * some source frame, drawn from 192 distinct source images, with hold-run lengths of 1 and 2. Mean
 * absolute error against the source frame each output slot depicts was 0.000. For that input the
 * post-retiming `fps` filter therefore SELECTS AND HOLDS source frames; it does not mix them.
 *
 * An earlier version of this comment claimed TEMPORAL FRAME BLENDING and "invents pixels". That
 * claim was WRONG and has been retracted. It came from hashing frames extracted from a LOSSY H.264
 * render, where re-encoding perturbs decoded pixels so a held frame no longer hashes identically
 * to its twin — making holding look like blending. Re-tested losslessly, it is holding.
 *
 * SCOPE OF THE CLAIM — deliberately narrow: this was verified on ONE input shape (a 192-frame,
 * 24 fps, 1280x720 H.264 Flow clip retimed 1.62625x to a 13.010 s target at 24 fps). It is not a
 * general guarantee that `fps` never interpolates; `fps` upsampling behaviour depends on the input
 * rate relationship, and a different source or a larger retime factor could resample differently.
 * Anything beyond that needs its own lossless frame-identity test before it is claimed.
 *
 * CONSEQUENCES — what is and is not true of the HELD-FRAME approach this strategy replaced:
 *   • For the tested input it invented no pixels: every output frame was a source frame.
 *   • TRADE-OFF: it HELD frames, so motion was juddery rather than interpolated. Holding does NOT
 *     eliminate judder, which is what motivated the move to MCI.
 *   • CONSTANT CADENCE DOES NOT PROVE PERCEPTUAL SMOOTHNESS. The tests prove a constant 24 fps
 *     timestamp grid, the planned frame count, and (for the tested input) lossless frame identity.
 *     Only human visual review can judge motion quality, and no approved human review exists.
 *   • Encoder-level softness is a SEPARATE issue from this filter: measured high-frequency
 *     retention in the opening was 22.2% losslessly versus 21.2% through libx264, on a source
 *     whose own opening detail is low. Raising CRF moved that only 19.3 -> 20.7%.
 *
 * Historical note: this identifier has been renamed twice. `duplicate-after-setpts` ->
 * `blend-after-setpts` (wrong: the blend claim above) -> `frame-hold-after-setpts` ->
 * `mci-after-setpts` (current).
 * `tests/mix_video_cadence_test.mts` section 4 pins the identifier and the retraction so the blend
 * claim cannot silently return.
 *
 * `minterpolate` / optical flow — NOW SHIPPED, on the strength of a human playback decision:
 * the operator reviewed Scene 15 rendered both ways and judged MCI smoother with no obvious
 * artefacts, while also judging frame hold "smooth enough, with no noticeable judder". Visual
 * quality was chosen as the priority even at higher processing cost, so MCI is the declared
 * strategy even though it is far more expensive (measured ~37 s per scene versus ~0.2 s, roughly
 * 150x; across a 23-scene MIX that is a real cost, accepted deliberately).
 *
 * WHY A TAIL PAD IS REQUIRED (this is the non-obvious part):
 * `minterpolate` synthesises frames BETWEEN adjacent input frames; it cannot emit a frame at or
 * beyond the final input frame's own timestamp. Retimed by K, the last real frame therefore lands
 * short of the target and the output falls behind — measured 309 frames / 12.875 s against a
 * 312-frame / 13.000 s target, a 0.125 s shortfall. Cloning extra input frames BEFORE the retiming
 * gives the interpolator a following frame to work towards at the end of the shot, which closes
 * the gap exactly. The pad is therefore a correctness requirement of the strategy, not a cosmetic
 * tweak, and it is why this chain cannot simply swap `fps` for `minterpolate`.
 *
 * The pad is measured in FRAMES, not seconds, so it stays meaningful if the output frame rate
 * changes. It is deliberately NOT `NARRATION_TAIL_SECONDS` even though both evaluate to 0.25 s at
 * 24 fps: they are different concerns (a visual tail after the last word vs interpolator headroom
 * before the last frame) and conflating them would let a change to one silently alter the other.
 */
export const MIX_CADENCE_STRATEGY = 'mci-after-setpts' as const;

/**
 * Interpolation headroom, expressed in output frames.
 *
 * One frame is the mathematical minimum: with the source padded by 1/fps, the final input frame
 * has a successor to interpolate towards, so the retimed stream can reach the full target length.
 * Six frames is used to leave headroom for rounding and for the interpolator's own boundary
 * handling, and it is the value that was rendered and reviewed for Scene 15.
 */
export const MIX_MCI_TAIL_PAD_FRAMES = 6;

/**
 * The MCI interpolation stage, as a template over the output frame rate. Exported so tests and
 * documentation cannot drift from what `planSceneVideoChain` actually emits.
 */
export const mixMciInterpolationFilter = (fps: number): string =>
  `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir`;

/**
 * PURE planner for one scene's video chain. Extracted from the inline construction so the timing
 * and cadence rules can be asserted directly by tests instead of being string-grepped.
 *
 * ORDER IS LOAD-BEARING. Four stages, and each one depends on the stage before it:
 *
 *   1. `fps=F`          — source normalisation. Required BEFORE anything else for an unrelated
 *                         reason: Flow clips carry differing timebases (1/12288 vs 1/90000) and
 *                         `xfade` fails hard when its two inputs' timebases differ.
 *   2. `tpad=...`       — clone extra tail frames so the interpolator has a following frame to
 *                         work towards at the end of the shot. See `MIX_CADENCE_STRATEGY` for why
 *                         this is required rather than optional. Measured in output frames so it
 *                         tracks the frame rate.
 *   3. `setpts=K*PTS`   — the visual slowdown that preserves narration. `setpts` only rewrites
 *                         timestamps; it never creates frames. K IS NOT HARDCODED: it is
 *                         `outputDuration / sourceDuration`, i.e. whatever the shared
 *                         `decideNarrationPreservation()` policy already decided for this scene.
 *                         The graph derives its timing from the policy; it never decides timing.
 *   4. `minterpolate=…` — synthesise the intermediate frames, landing on a constant F fps grid.
 *
 * Stages 2-4 are emitted ONLY when the policy says the picture must be extended. A scene whose
 * narration already fits keeps the exact chain it has always had (`fps`, `trim`, `setpts`) and so
 * carries zero regression risk and no interpolation cost.
 *
 * A scene needing only a SHORTER picture is never slowed: `setpts` is only ever a multiplier > 1.
 */
export function planSceneVideoChain(p: {
  sourceDurationSeconds: number;
  outputDurationSeconds: number;
  fps?: number;
}): {
  fps: number;
  needsPictureExtension: boolean;
  retimeFactor: number | null;
  /** Seconds of cloned tail added before retiming, or 0 when no extension is needed. */
  tailPadSeconds: number;
  expectedFrameCount: number;
  /** Filters in application order, without input/output labels. */
  chain: string;
} {
  const fps = p.fps ?? MIX_DEFAULT_FPS;
  // Fail closed on unusable input rather than emitting NaN/Infinity into an FFmpeg graph.
  if (!Number.isFinite(p.sourceDurationSeconds) || !Number.isFinite(p.outputDurationSeconds)
    || p.sourceDurationSeconds <= 0 || p.outputDurationSeconds <= 0
    || !Number.isFinite(fps) || fps <= 0) {
    throw new Error(`planSceneVideoChain requires finite positive durations (source=${p.sourceDurationSeconds}, output=${p.outputDurationSeconds}, fps=${fps}).`);
  }

  const needsPictureExtension = p.outputDurationSeconds > p.sourceDurationSeconds;
  const retimeFactor = needsPictureExtension ? p.outputDurationSeconds / p.sourceDurationSeconds : null;

  // The pad is stated in output frames and expressed in source seconds, because it has to be
  // cloned BEFORE the retiming scales everything. It is a fixed quantity of source footage, not a
  // function of any one scene's numbers.
  const tailPadSeconds = needsPictureExtension ? MIX_MCI_TAIL_PAD_FRAMES / fps : 0;

  // The written factor is `outputDuration / sourceDuration` — the policy's ratio, UNCHANGED by the
  // pad. This is deliberate and it reproduces the reviewed Scene 15 artifact exactly:
  //   8.000 s clip + 0.250 s clone = 8.250 s, x 1.626250 = 13.416 s of retimed content,
  //   then `trim=duration=13.010` takes exactly the requested length off the front.
  // The clone is INTERPOLATOR HEADROOM past the target, not extra programme, so scaling the factor
  // by it would silently shorten every real frame. The pad buys the interpolator a following frame
  // to work towards; the trim decides how much of the shot is actually kept.
  const chain = [
    `fps=${fps}`,
    ...(needsPictureExtension
      ? [
        `tpad=stop_mode=clone:stop_duration=${tailPadSeconds.toFixed(6)}`,
        `setpts=${retimeFactor!.toFixed(6)}*PTS`,
        mixMciInterpolationFilter(fps),
      ]
      : []),
    `trim=duration=${p.outputDurationSeconds.toFixed(3)}`,
    'setpts=PTS-STARTPTS',
  ].join(',');
  return {
    fps,
    needsPictureExtension,
    retimeFactor,
    tailPadSeconds,
    expectedFrameCount: expectedMixFrameCount(p.outputDurationSeconds, fps),
    chain,
  };
}

/**
 * Build the complete MIX filter graph (extracted verbatim from the inline construction so it is
 * unit-testable; behaviour is unchanged).
 *
 * NARRATION SPLIT (fix): each narration stream feeds TWO consumers — the `sidechaincompress`
 * sidechain and the `amix` sum. A `filter_complex` stream label may be consumed only ONCE, so the
 * shared label silently starved the `amix` branch and every narrator scene came out DIGITAL
 * SILENCE. The voice is therefore `asplit` AFTER its existing trim, so both branches carry
 * identical content and duration.
 *
 * VIDEO CADENCE (fix): the per-scene video chain comes from `planSceneVideoChain()`, which puts the
 * output `fps` normalisation AFTER the `setpts` slowdown. See that function for the full rationale.
 */
export function buildMixFilterGraph(p: {
  sceneCount: number;
  durations: readonly number[];
  outputDurations: readonly number[];
  narrationInputs: readonly (readonly [number, string])[];
  narrationIndex: ReadonlyMap<number, number>;
  narrationMakeupDb: number;
  transition: number;
  bgm?: string;
  bgmLufs: number;
  fps?: number;
}): { graph: string; video: string; audio: string; runningDuration: number } {
  const { sceneCount, durations, outputDurations, narrationIndex, narrationMakeupDb, transition } = p;
  const fps = p.fps ?? MIX_DEFAULT_FPS;
  let graph = '';
  for (let i = 0; i < sceneCount; i++) {
    const scene = i + 1;
    const video = planSceneVideoChain({
      sourceDurationSeconds: durations[i],
      outputDurationSeconds: outputDurations[i],
      fps,
    });
    graph += `${graph ? ';' : ''}[${i}:v]${video.chain}[v${i}]`;
    const voiceInput = narrationIndex.get(scene);
    if (voiceInput === undefined) {
      graph += `;[${i}:a]atrim=duration=${outputDurations[i].toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`;
    } else {
      // Keep the Flow ambience and scene SFX. They duck beneath the Hindi
      // narration instead of being muted, so narration gaps never become
      // dead air. Character scenes (without narration) remain fully native.
      //
      // `asplit=2` comes AFTER the existing `atrim`, so the sidechain and the mix receive the exact
      // same trimmed narration; timing/trim behaviour is otherwise untouched.
      graph += `;[${i}:a]apad,atrim=duration=${outputDurations[i].toFixed(3)},asetpts=PTS-STARTPTS[source${i}]`;
      graph += `;[${voiceInput}:a]acompressor=threshold=0.05:ratio=8:attack=5:release=100:makeup=${narrationMakeupDb},alimiter=limit=0.9:level=0,asetpts=PTS-STARTPTS,apad,atrim=duration=${outputDurations[i].toFixed(3)},asplit=2[voice_sc${i}][voice_mix${i}]`;
      // `sidechaincompress` is a DUAL-input filter whose main input is the scene ambience and whose
      // sidechain is the (possibly different-rate) narration, so ffmpeg negotiates a resampler
      // inside it. Measured consequence of leaving this edge unguarded: its output length and head
      // content depended on run-time frame-delivery scheduling between the two inputs, and because
      // `amix=duration=first` adopts whatever arrives, the per-scene mix came out a different
      // length on each run (observed 4.40284 / 4.48818 / 4.54984 s for a 4.550 s scene at 3 scenes,
      // and 11 distinct durations in 12 runs at 8 scenes). Applying the SAME guard every other
      // audio edge in this graph already uses pins the ducked ambience to exactly
      // `outputDurations[i]` and rebases its timestamps, which makes the render reproducible.
      graph += `;[source${i}][voice_sc${i}]sidechaincompress=threshold=0.025:ratio=12:attack=80:release=500,apad,atrim=duration=${outputDurations[i].toFixed(3)},asetpts=PTS-STARTPTS[duckedsource${i}]`;
      graph += `;[duckedsource${i}][voice_mix${i}]amix=inputs=2:duration=first:normalize=0[a${i}]`;
    }
  }
  let runningDuration = outputDurations[0];
  let video = 'v0';
  let audio = 'a0';
  for (let i = 1; i < sceneCount; i++) {
    const nextVideo = `vx${i}`;
    const nextAudio = `ax${i}`;
    graph += `;[${video}][v${i}]xfade=transition=fade:duration=${transition}:offset=${Math.max(0, runningDuration - transition).toFixed(3)}[${nextVideo}]`;
    graph += `;[${audio}][a${i}]acrossfade=d=${transition}:c1=tri:c2=tri[${nextAudio}]`;
    video = nextVideo;
    audio = nextAudio;
    runningDuration += outputDurations[i] - transition;
  }
  if (p.bgm) {
    const bgmInput = sceneCount + p.narrationInputs.length;
    graph += `;[${bgmInput}:a]aloop=loop=-1:size=2147483647,loudnorm=I=${p.bgmLufs}:TP=-5:LRA=7,atrim=duration=${runningDuration.toFixed(3)},asetpts=PTS-STARTPTS[bgm]`;
    graph += `;[${audio}][bgm]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=0[mixedaudio]`;
    audio = 'mixedaudio';
  }
  return { graph, video, audio, runningDuration };
}
