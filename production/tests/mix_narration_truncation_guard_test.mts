// STEP-8HX — narration-preservation FAIL-CLOSED guard for the real MIX producer.
//
// REGRESSION. mixNarration.ts used to `return clipDuration` whenever
// decideNarrationPreservation() reported an over-limit stretch. MIX then exited 0, the temp
// artefact validated, it was promoted, and a `.stage` sidecar was written — a complete, valid,
// CURRENT-looking result in which the filter graph had silently `atrim`-ed the narration down to
// the shorter clip length. For a NARRATOR_ONLY scene nothing upstream raised DURATION_CONFLICT
// (sceneState.ts:275 gates that check on `narration === 'MIXED'`), so such a scene reached MIX
// READY and lost narration. AGENTS.md forbids truncating narration, so this must fail loudly.
//
// Also covers the scene-identity fix: scene numbers are parsed from the FILENAMES, so a
// non-contiguous clip set can no longer shift the Scene 2 legacy exception onto the wrong scene.
//
// Fully offline, isolated temp fixtures only. No network, no Flow, no Chrome, no real project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
import { REPO } from './_testPaths.mjs';
const SRC = `${REPO}/production/src`;
const PROD = `${REPO}/production`;
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
process.env.PATH = `${FF};${process.env.PATH}`;

const { executeDownstreamChain } = await import(pathToFileURL(`${SRC}/stageExecutor.ts`).href);
const { safeStageOutputPath } = await import(pathToFileURL(`${SRC}/downstreamStages.ts`).href);
const P = await import(pathToFileURL(`${SRC}/narrationDurationPolicy.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

const mkClip = async (o: string, sec: number) => {
  // The colour source must be as long as the requested clip: `-shortest` ends the output at the
  // shortest input, so a `d=1` source paired with `-t N` yields a 1s clip regardless of N.
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', `color=c=0x203040:s=640x360:d=${sec}`, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', String(sec), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', o]);
};
const mkNarr = (o: string, sec: number) => {
  const n = Math.round(sec * 8000), data = Buffer.alloc(n * 2), b = Buffer.alloc(44 + n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(((i * 7) % 2000) - 1000, i * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36);
  b.writeUInt32LE(n * 2, 40); data.copy(b, 44); fs.writeFileSync(o, b);
};
const durOf = async (f: string) => Number((await exec(process.env.FFPROBE_PATH!, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f])).stdout.trim());

/** Build an isolated project whose OUTPUTS dir holds the given scene clips. */
async function makeProject(id: string, sceneSecs: Record<number, number>, narrSecs: Record<number, number>) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8hx-'));
  const root = path.join(tmp, 'inputs', id);
  const out = path.join(tmp, 'outputs', id);
  fs.mkdirSync(path.join(root, 'narration'), { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  for (const [n, sec] of Object.entries(sceneSecs)) await mkClip(path.join(out, `scene-${String(n).padStart(4, '0')}.mp4`), sec);
  for (const [n, sec] of Object.entries(narrSecs)) mkNarr(path.join(root, 'narration', `narration-${String(n).padStart(4, '0')}.wav`), sec);
  return { tmp, root, out, cfg: { outputsDir: out, inputsDir: root, productionDir: PROD } as any };
}

/**
 * Run the REAL MIX stage through the guarded chain (the path that promotes artifacts AND writes
 * `.stage` sidecars), recording every persistStage call so we can prove a failed producer records
 * nothing. MIX is declared with EDIT upstream, so EDIT is stubbed CURRENT.
 */
async function runMix(f: any) {
  const persisted: { stage: string; hash: string }[] = [];
  const run: any = await executeDownstreamChain(
    { workSet: ['MIX'], sceneOutputsCurrent: true },
    f.cfg,
    {
      approved: true,
      stageState: (s: string) => (s === 'EDIT' ? 'CURRENT' : 'NOT_STARTED'),
      persistStage: async (s: any, rec: any) => {
        persisted.push({ stage: s, hash: rec.output_hash });
        fs.writeFileSync(`${safeStageOutputPath(f.out, s)}.stage`, JSON.stringify(rec));
      },
      resolveKey: async () => ({ key: 'K', keyInputs: {} }),
      ffprobePath: process.env.FFPROBE_PATH,
    },
  );
  return { run, persisted, finalOut: safeStageOutputPath(f.out, 'MIX') };
}

// ================== 1. over-limit NARRATOR_ONLY scene must FAIL, not truncate ==================
console.log('--- 1. an over-limit scene fails the real producer instead of truncating narration ---');
{
  // Scene 1: 8s clip, 22s narration => 22.25s / 8s = 2.78125x, above the 2.0x policy.
  // This is the real production Scene 1 shape.
  const f = await makeProject('hx-overlimit', { 1: 8, 3: 8 }, { 1: 22 });
  const { run, persisted, finalOut } = await runMix(f);
  const reason = String(run?.blocked?.reason ?? '');

  check('1.1 the producer FAILS instead of succeeding', run.blocked?.ok === false && run.blocked?.code === 'STAGE_FAILED', run.blocked);
  check('1.2 the failure names the real scene number (Scene 1)', /Scene 1\b/.test(reason), reason.slice(0, 400));
  check('1.3 the failure reports the measured clip and narration durations', /clip=8\.000s/.test(reason) && /narration=22\.000s/.test(reason), reason.slice(0, 400));
  check('1.4 the failure reports the required output and the required stretch', /22\.250s/.test(reason) && /2\.78125x/.test(reason), reason.slice(0, 400));
  check('1.5 the failure reports the configured policy limit', new RegExp(`${P.MAX_NARRATION_VIDEO_STRETCH}x`).test(reason), reason.slice(0, 400));
  check('1.6 the failure is ACTIONABLE (states what would be lost and how to resolve)',
    /would silently discard 14\.000s of narration/.test(reason) && /re-recording shorter narration|supplying a longer supplied clip|raising the stretch policy/.test(reason), reason.slice(0, 600));
  check('1.7 the policy reason is carried through', /NARRATION_EXCEEDS_CLIP_LIMIT_EXCEEDED/.test(reason), reason.slice(0, 600));

  // Requirement: a failed producer must not be recorded as a successful/CURRENT stage.
  check('1.8 NO MIX output was promoted into the outputs dir', !fs.existsSync(finalOut), finalOut);
  check('1.9 NO .stage sidecar was written (MIX cannot be reported CURRENT)', !fs.existsSync(`${finalOut}.stage`), `${finalOut}.stage`);
  check('1.10 persistStage was NEVER called for MIX (nothing recorded as successful)', persisted.length === 0, persisted);
  check('1.11 the stage run reports MIX as blocked, not executed', run.executed.length === 0 && run.blocked?.stage === 'MIX', { executed: run.executed, blockedStage: run.blocked?.stage });
  const leftovers = fs.readdirSync(f.out).filter((x) => /final-narrated|\.tmp-/i.test(x));
  check('1.12 no partial/temp MIX artifact was left behind', leftovers.length === 0, leftovers);

  fs.rmSync(f.tmp, { recursive: true, force: true });
}

// ================== 2. Scene 2's legacy exception still works ==================
console.log('--- 2. the Scene 2 legacy exception is unchanged and still stretches ---');
{
  // 2s clip + 5s narration => 5.25/2 = 2.625x, which the policy would REJECT but the legacy
  // branch still honours. If the exception were ever removed or mis-targeted this would fail.
  const f = await makeProject('hx-legacy', { 1: 2, 2: 2 }, { 2: 5 });
  const { run, persisted, finalOut } = await runMix(f);
  check('2.1 Scene 2 still succeeds via its explicit legacy exception', run.blocked === undefined && run.executed.includes('MIX'), run);
  check('2.2 a MIX artifact AND a .stage sidecar ARE written on success', fs.existsSync(finalOut) && fs.existsSync(`${finalOut}.stage`), finalOut);
  check('2.3 persistStage recorded MIX exactly once with an output hash', persisted.length === 1 && persisted[0].stage === 'MIX' && !!persisted[0].hash, persisted);
  const got = await durOf(finalOut);
  // scene1 2s + scene2 5.25s - 0.35s transition
  check('2.4 the legacy-stretched scene is really longer than the source clip (2.625x applied)',
    Math.abs(got - (2 + 5.25 - 0.35)) < 0.35, { got, expectedApprox: 6.9 });
  fs.rmSync(f.tmp, { recursive: true, force: true });
}

// ================== 3. scene identity comes from the FILENAME, not the array index ==================
console.log('--- 3. a non-contiguous clip set cannot shift the Scene 2 exception onto another scene ---');
{
  // Deliberately NON-CONTIGUOUS: scene-0001 and scene-0003, so scene 2's clip is withheld.
  // narration-0002 is over-limit (10s over a 2s clip = 5.125x).
  //   correct: neither scene has narration -> both stay 2s -> total 2 + 2 - 0.35 = 3.65s
  //   buggy  : index 1 was treated as "scene 2", so the legacy exception stretched scene-0003
  //            to 10.25s -> total ~10.9s (and the narration for a scene that has no clip is used)
  const f = await makeProject('hx-noncontig', { 1: 2, 3: 2 }, { 2: 10 });
  const { run, finalOut } = await runMix(f);
  check('3.1 the producer succeeds (narration-0002 has no matching clip, so it is simply unused)', run.blocked === undefined, run.blocked);
  const got = await durOf(finalOut);
  check('3.2 NEITHER scene was stretched (output is the natural 2 + 2 - 0.35)', Math.abs(got - 3.65) < 0.35, { got, naturalApprox: 3.65, wrongApprox: 11.9 });
  check('3.3 the legacy exception did not migrate onto scene 3', got < 6, got);
  fs.rmSync(f.tmp, { recursive: true, force: true });
}

// ================== 4. the producer source no longer contains the silent fallback ==================
console.log('--- 4. the silent fallback is gone from the producer source ---');
{
  const src = fs.readFileSync(path.join(SRC, 'mixNarration.ts'), 'utf8').replace(/\s+/g, ' ');
  check('4.1 no `if (!preservation.ok) return clipDuration;` remains', !/if \(!preservation\.ok\)\s*return clipDuration;/.test(src));
  check('4.2 the over-limit branch throws an explicit error', /if \(!preservation\.ok\)[\s\S]{0,900}?throw new Error\(/.test(src));
  check('4.3 scene identity is derived from the filename, not `index + 1`', !/const scene = index \+ 1;/.test(src) && /sceneNumbers\[index\]/.test(src));
  check('4.4 the Scene 2 exception is preserved verbatim', /if \(scene === 2\) return Math\.max\(clipDuration, narrationDuration \+ narrationTail\);/.test(src));
  check('4.5 the configured limit is unchanged by this guard', P.MAX_NARRATION_VIDEO_STRETCH === 2.0 && P.NARRATION_TAIL_SECONDS === 0.25);
}

console.log(`\n8HX NARRATION-TRUNCATION GUARD TESTS PASSED (${passed} checks)`);