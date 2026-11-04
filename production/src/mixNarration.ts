/**
 * Mix Google AI Studio narration over non-character scenes.
 * The source clip audio is muted only where narration exists; character
 * dialogue clips retain their native Flow audio. Full clip lengths and fades
 * are preserved.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveBgmSource } from './bgm.js';
import { decideNarrationPreservation, NARRATION_TAIL_SECONDS, MAX_NARRATION_VIDEO_STRETCH } from './narrationDurationPolicy.js';

const exec = promisify(execFile);
const arg = (name: string, fallback?: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
};
// MIX output constants and the filter-graph / argv builders now live in the pure, side-effect-free
// mixFilterGraph.ts so the project-wide MIX stage and the isolated scene-MIX validation path share
// ONE implementation. Imported for local use below AND re-exported, so every existing importer is
// unaffected.
import { buildMixOutputArgs, buildMixFilterGraph } from './mixFilterGraph.js';
export { MIX_OUT_SAMPLE_RATE, MIX_OUT_CHANNELS, buildMixOutputArgs, buildMixFilterGraph } from './mixFilterGraph.js';

const inputDir = path.resolve(arg('--input-dir') ?? 'outputs');
const narrationDir = path.resolve(arg('--narration-dir') ?? path.join(inputDir, 'narration'));
const output = path.resolve(arg('--output') ?? path.join(inputDir, 'final-narrated.mp4'));
// Common frame rate applied to every input before xfade: Flow clips can carry differing
// timebases (1/12288 vs 1/90000), and xfade fails hard when the two inputs' timebases differ.
const MIX_FPS = Number(arg('--fps', '24'));
// Manual --bgm keeps its exact previous behavior. --auto-bgm downloads a
// copyright-safe track into <input-dir>/background-music.mp3 and uses it.
const bgm = await resolveBgmSource({
  bgm: arg('--bgm'),
  autoBgm: process.argv.includes('--auto-bgm'),
  inputDir,
  query: arg('--bgm-query'),
});
// The Google AI Studio narration is quiet by design. Compression with 12 dB
// makeup yields a measured ~-14 LUFS narration against a -20.9 LUFS music bed.
const narrationMakeupDb = Number(arg('--narration-makeup-db', '12'));const bgmLufs = Number(arg('--bgm-lufs', '-20.9'));
const transition = Number(arg('--transition', '0.35'));
if (!Number.isFinite(transition) || transition <= 0) throw new Error('--transition must be greater than 0');
if (!Number.isFinite(narrationMakeupDb) || narrationMakeupDb < 0 || narrationMakeupDb > 24) throw new Error('--narration-makeup-db must be between 0 and 24.');
if (!Number.isFinite(bgmLufs) || bgmLufs > -5 || bgmLufs < -40) throw new Error('--bgm-lufs must be between -40 and -5.');

const sceneFiles = (await fs.readdir(inputDir))
  .filter((file) => /^scene-\d{4}\.mp4$/i.test(file))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  .map((file) => path.join(inputDir, file));
if (sceneFiles.length < 2) throw new Error(`Expected at least two scene-####.mp4 clips in ${inputDir}`);
// Scene identity is read from the FILENAME, never inferred from the array position. `index + 1`
// silently mis-targets a scene the moment the clip set is non-contiguous (one withheld clip shifts
// every later index), which would move the Scene 2 legacy exception onto a different scene. The
// narration lookup below is already keyed on the number parsed from the filename, so deriving the
// scene the same way keeps the two from ever disagreeing.
const sceneNumbers = sceneFiles.map((file) => Number(/^scene-(\d{4})\.mp4$/i.exec(path.basename(file))![1]));

const audioExtensions = new Set(['.wav', '.mp3', '.m4a', '.aac', '.ogg']);
const narrationNames = new Map<number, string>();
for (const name of await fs.readdir(narrationDir)) {
  const match = /^narration-(\d{4})\.(\w+)$/i.exec(name);
  if (match && audioExtensions.has(`.${match[2].toLowerCase()}`)) narrationNames.set(Number(match[1]), path.join(narrationDir, name));
}
if (!narrationNames.size) throw new Error(`No narration-#### audio files found in ${narrationDir}`);

async function duration(file: string): Promise<number> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= transition) throw new Error(`${path.basename(file)} is too short for a ${transition}s transition`);
  return seconds;
}

const durations = await Promise.all(sceneFiles.map(duration));
const narrationInputs = [...narrationNames.entries()].sort(([a], [b]) => a - b);
if (bgm) await fs.access(bgm);
const narrationDurations = new Map(await Promise.all(narrationInputs.map(async ([scene, file]) => [scene, await duration(file)] as const)));
// Narrator shots should end with the spoken thought. Keep a tiny visual tail,
// but do not pad a short narration with several seconds of silence.
const narrationTail = NARRATION_TAIL_SECONDS;
console.error(`[mix] narration-preservation policy active: tail=${narrationTail}s maxStretch=${MAX_NARRATION_VIDEO_STRETCH}x (Scene 2 legacy exception preserved)`);
// NARRATION-PRESERVATION POLICY. Default rule: a shot ends on the completed thought, so the
// picture is trimmed to `min(clip, narration + tail)` and narration that fits is never stretched.
// Where the narration does NOT fit, the picture is SLOWED instead of cutting words â€” but only
// while the required slowdown stays within MAX_NARRATION_VIDEO_STRETCH. The arithmetic is owned by
// the shared pure helper (the same one sceneState.ts gates readiness with), so this stage and the
// readiness gate can never disagree about whether a scene is extendable.
// Audio is never time-stretched: narration is `atrim`-ed to the same duration and plays at its
// natural speed while only the picture is slowed by the existing `setpts` path in
// buildMixFilterGraph(). No tpad, no looping, no frame freezing, no extra Flow generation.
// LEGACY: Scene 2 predates this policy and needs a ~2.42x slowdown, above today's 2.0x maximum.
// Its completed behaviour is preserved EXACTLY and it is deliberately NOT routed through the new
// bound, so this change cannot shorten or otherwise alter what Scene 2 already produces.
const outputDurations = durations.map((clipDuration, index) => {
  const scene = sceneNumbers[index];
  const narrationDuration = narrationDurations.get(scene);
  if (narrationDuration === undefined) return clipDuration;
  // Scene 2 needs the full establishing narration before the driver speaks.
  // Slow the picture rather than cutting the final words of its voiceover.
  if (scene === 2) return Math.max(clipDuration, narrationDuration + narrationTail);
  const preservation = decideNarrationPreservation({ sourceVideoDuration: clipDuration, narrationDuration, tailSeconds: narrationTail });
  // FAIL LOUDLY on an over-limit stretch. This used to `return clipDuration`, which let MIX exit 0
  // with a complete, valid, CURRENT-looking artefact while the filter graph silently `atrim`-ed the
  // narration down to the shorter clip length. For a NARRATOR_ONLY scene nothing upstream raised
  // DURATION_CONFLICT (sceneState.ts:275 gates that check on `narration === 'MIXED'`), so a scene
  // needing more than MAX_NARRATION_VIDEO_STRETCH could reach this point READY and be silently
  // truncated. Truncating narration is forbidden by AGENTS.md, so the only correct outcome here is
  // an explicit failure that names the scene and the exact policy conflict.
  if (!preservation.ok) {
    const required = preservation.requiredOutputDuration;
    const stretch = preservation.stretchFactor;
    const lost = Math.max(0, narrationDuration - clipDuration);
    const requiredText = Number.isFinite(required as number) ? `${(required as number).toFixed(3)}s` : 'unknown';
    const stretchText = Number.isFinite(stretch as number) ? `${(stretch as number).toFixed(5)}x` : 'unknown';
    throw new Error(
      `Scene ${scene}: narration cannot be preserved within the narration-preservation policy. `
      + `clip=${clipDuration.toFixed(3)}s narration=${narrationDuration.toFixed(3)}s tail=${narrationTail}s `
      + `requires ${requiredText} of picture (a ${stretchText} slowdown), above the configured `
      + `MAX_NARRATION_VIDEO_STRETCH of ${MAX_NARRATION_VIDEO_STRETCH}x. `
      + `Refusing to mix: rendering this scene at ${clipDuration.toFixed(3)}s would silently discard `
      + `${lost.toFixed(3)}s of narration. Resolve by re-recording shorter narration for this scene, `
      + `supplying a longer supplied clip, or explicitly raising the stretch policy for it. `
      + `Policy: ${preservation.reason}${preservation.detail ? ` — ${preservation.detail}` : ''}`,
    );
  }
  return preservation.requiredOutputDuration;
});
const narrationIndex = new Map(narrationInputs.map(([scene], index) => [scene, sceneFiles.length + index]));

const { graph, video, audio, runningDuration } = buildMixFilterGraph({
  sceneCount: sceneFiles.length,
  durations,
  outputDurations,
  narrationInputs,
  narrationIndex,
  narrationMakeupDb,
  transition,
  bgm,
  bgmLufs,
  fps: MIX_FPS,
});

await fs.mkdir(path.dirname(output), { recursive: true });
await exec('ffmpeg', buildMixOutputArgs({
  sceneFiles,
  narrationFiles: narrationInputs.map(([, file]) => file),
  bgm,
  graph,
  videoLabel: video,
  audioLabel: audio,
  output,
}), { maxBuffer: 1024 * 1024 * 8 });
console.log(JSON.stringify({ output, clips: sceneFiles.length, narrationScenes: narrationInputs.map(([scene]) => scene), narrationMakeupDb, bgm, bgmLufs, transitionSeconds: transition, durationSeconds: Number(runningDuration.toFixed(3)) }));
