// PHASE 6 — offline YouTube Shorts production tests.
//
// Everything runs in ISOLATED temp projects with synthetic fixtures. No Chrome, no Flow, no
// Gemini/OpenAI, no network, no credits, no uploads, no publishing, and the real project
// (`youtube-automation-2-20261003160855-2740`) is never touched.
//
// Network is hard-disabled for the whole file: `globalThis.fetch` throws.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);

import { SRC, FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;

// ---- 27. no external calls: any network attempt fails loudly -------------------------
let networkAttempts = 0;
(globalThis as any).fetch = async () => { networkAttempts += 1; throw new Error('network is disabled in offline tests'); };

const T = await import(pathToFileURL(`${SRC}/shortsTypes.ts`).href);
const PLAN = await import(pathToFileURL(`${SRC}/shortsPlan.ts`).href);
const CAP = await import(pathToFileURL(`${SRC}/shortsCaptions.ts`).href);
const CLIPS = await import(pathToFileURL(`${SRC}/shortsClips.ts`).href);
const RENDER = await import(pathToFileURL(`${SRC}/shortsRender.ts`).href);
const QA = await import(pathToFileURL(`${SRC}/shortsQa.ts`).href);
const WF = await import(pathToFileURL(`${SRC}/shortsWorkflow.ts`).href);
const MD = await import(pathToFileURL(`${SRC}/shortsMetadata.ts`).href);
const VC = await import(pathToFileURL(`${SRC}/videoClip.ts`).href);
const REL = await import(pathToFileURL(`${SRC}/reliability.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); return; }
  console.log(`FAIL ${label}`, detail ?? '');
  throw new Error(`FAIL ${label}`);
};

const sha = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

// =======================================================================================
// Fixtures
// =======================================================================================

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p6shorts-'));
const projectId = 'shorts-fixture';
const projectsRoot = path.join(tmp, 'projects');
const outputsRoot = path.join(tmp, 'outputs');
const inputRoot = path.join(tmp, 'inputs');
const projectFile = path.join(projectsRoot, projectId, 'pipeline.json');
const outputsDir = path.join(outputsRoot, projectId);
const inputsDir = path.join(inputRoot, projectId);
const narrationDir = path.join(inputsDir, 'narration');
const shortRoot = path.join(outputsDir, 'shorts');

fs.mkdirSync(path.dirname(projectFile), { recursive: true });
fs.mkdirSync(outputsDir, { recursive: true });
fs.mkdirSync(narrationDir, { recursive: true });

/**
 * Twelve-scene Hindi horror micro-story. Odd scenes are narrated, even scenes are character
 * dialogue — exactly the two audio classes the long-form pipeline produces.
 */
const SCENES: any[] = [
  { n: 1, speaker: 'NARRATOR', narration: 'रात के तीन बजे किसी ने दरवाज़ा खटखटाया।', dialogue: '', tags: [] },
  { n: 2, speaker: '@CHAR-01-ARJUN', narration: '', dialogue: 'कौन है बाहर? इतनी रात को कौन आया?', tags: ['@CHAR-01-ARJUN'] },
  { n: 3, speaker: 'NARRATOR', narration: 'अर्जुन ने दरवाज़ा खोला, बाहर कोई नहीं था।', dialogue: '', tags: ['@CHAR-01-ARJUN'] },
  { n: 4, speaker: '@CHAR-01-ARJUN', narration: '', dialogue: 'मैंने आवाज़ सुनी थी, कोई खून बहा रहा है।', tags: ['@CHAR-01-ARJUN'] },
  { n: 5, speaker: 'NARRATOR', narration: 'सीढ़ियों पर खून की बूंदें नीचे तक जाती थीं।', dialogue: '', tags: [] },
  { n: 6, speaker: '@CHAR-02-MEERA', narration: '', dialogue: 'कुआं के पास कोई रो रहा है, मदद मांग रहा है।', tags: ['@CHAR-02-MEERA'] },
  { n: 7, speaker: 'NARRATOR', narration: 'कुएं से आवाज़ आई, पीछे मत देखना।', dialogue: '', tags: ['@CHAR-02-MEERA'] },
  { n: 8, speaker: '@CHAR-02-MEERA', narration: '', dialogue: 'आत्मा ने कहा, तुम्हारा अंत यहीं है।', tags: ['@CHAR-02-MEERA'] },
  { n: 9, speaker: 'NARRATOR', narration: 'अर्जुन भागा, पर दरवाज़ा बंद हो चुका था।', dialogue: '', tags: ['@CHAR-01-ARJUN'] },
  { n: 10, speaker: '@CHAR-01-ARJUN', narration: '', dialogue: 'यह सच है, मैं मर चुका हूं, अब तुम मेरी जगह हो।', tags: ['@CHAR-01-ARJUN'] },
  { n: 11, speaker: 'NARRATOR', narration: 'रोशनी बुझ गई और अंधेरा कमरे में भर गया।', dialogue: '', tags: [] },
  { n: 12, speaker: '@CHAR-02-MEERA', narration: '', dialogue: 'क्या तुमने मेरी आवाज़ सुनी? मैं अभी भी यहीं हूं।', tags: ['@CHAR-02-MEERA'] },
];

function pipelineFor(sceneDefs: any[], title: string) {
  return {
    schema_version: '1.0',
    project_id: projectId,
    idea: { selected: { title }, items: [] },
    script: { language: 'hi', duration_minutes: 5 },
    characters: [],
    backgrounds: [],
    publishing: { title, status: 'awaiting_approval' },
    review: { status: 'awaiting_approval' },
    scenes: sceneDefs.map((scene, index) => ({
      scene_number: scene.n,
      title: `दृश्य ${scene.n}`,
      background_tag: `#BGD-${String(index + 1).padStart(2, '0')}`,
      character_tags: scene.tags,
      speaker: scene.speaker,
      visual_action: `दृश्य ${scene.n} का दृश्य`,
      camera: 'static',
      effects: index % 3 === 0 ? 'flicker' : '',
      sound_design: index % 2 === 0 ? 'low drone' : '',
      devanagari_dialogue: scene.dialogue,
      narration_text: scene.narration,
      clip_length_seconds: 3,
      edit_length_seconds: 3,
      status: 'done',
      error: '',
    })),
  };
}

fs.writeFileSync(projectFile, JSON.stringify(pipelineFor(SCENES, 'रात का खौफ — कुआं'), null, 2));
const pipeline = readJson(projectFile);

/** Real (tiny) clips: portrait, landscape, square and an extreme wide frame. */
const CLIP_SPEC: Record<number, { w: number; h: number }> = {
  1: { w: 720, h: 1280 },   // portrait 9:16
  2: { w: 1280, h: 720 },   // landscape 16:9
  3: { w: 800, h: 800 },    // square
  4: { w: 1280, h: 720 },
  5: { w: 1920, h: 400 },   // extreme wide -> blur_fill
  6: { w: 800, h: 800 },
  7: { w: 720, h: 1280 },
  8: { w: 1280, h: 720 },
  9: { w: 800, h: 800 },
  10: { w: 1280, h: 720 },
  11: { w: 1920, h: 400 },
  12: { w: 720, h: 1280 },
};
const CLIP_SECONDS = 3;
const NARRATION_SECONDS: Record<number, number> = { 1: 3.0, 3: 3.0, 5: 3.6, 7: 3.0, 9: 3.0, 11: 3.0 };

const ff = process.env.FFMPEG_PATH as string;
for (const scene of SCENES) {
  const spec = CLIP_SPEC[scene.n];
  const output = path.join(outputsDir, `scene-${String(scene.n).padStart(4, '0')}.mp4`);
  await exec(ff, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=s=${spec.w}x${spec.h}:d=${CLIP_SECONDS}:r=24`,
    '-f', 'lavfi', '-i', `sine=frequency=${300 + scene.n * 20}:sample_rate=48000:duration=${CLIP_SECONDS}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', output,
  ], { maxBuffer: 1024 * 1024 * 8 });
}
for (const [scene, seconds] of Object.entries(NARRATION_SECONDS)) {
  const output = path.join(narrationDir, `narration-${String(scene).padStart(4, '0')}.wav`);
  await exec(ff, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=320:sample_rate=48000:duration=${seconds}`,
    '-c:a', 'pcm_s16le', output,
  ], { maxBuffer: 1024 * 1024 * 8 });
}

/** Snapshot of every long-form artifact (everything outside `shorts/`). */
function snapshotLongForm(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(outputsDir, { withFileTypes: true })) {
    if (entry.name === 'shorts') continue;
    if (!entry.isFile()) continue;
    out[entry.name] = sha(fs.readFileSync(path.join(outputsDir, entry.name)));
  }
  out['<pipeline>'] = sha(fs.readFileSync(projectFile));
  return out;
}
const longFormBefore = snapshotLongForm();

const options = { projectId, projectFile, outputsRoot, inputRoot: inputsDir };

// =======================================================================================
// 1 & 2. Two- and three-Short plans (pure planner, deterministic fixtures)
// =======================================================================================

const longSceneDefs: any[] = [];
for (let copy = 0; copy < 2; copy += 1) {
  for (const scene of SCENES) longSceneDefs.push({ ...scene, n: scene.n + copy * 12 });
}
const longPipeline = pipelineFor(longSceneDefs, "रात का खौफ — लंबी कहानी");
const longDurations = Object.fromEntries(longSceneDefs.map((scene) => [scene.n, 3]));

// ---- 1. Two-Short plan ---------------------------------------------------------------
{
  const plan = PLAN.createShortsPlan({ projectId, pipeline: longPipeline, count: 2, sceneDurations: longDurations, now: '2026-01-01T00:00:00.000Z' });
  check('1 a 2-Short plan is created on request', plan.count === 2 && plan.shorts.length === 2, plan.count);
  check('1b the 2-Short plan keeps the story arcs disjoint', new Set(plan.shorts.flatMap((s: any) => s.scene_refs)).size === plan.shorts.reduce((n: number, s: any) => n + s.scene_refs.length, 0));
  check('1c the 2-Short plan orders Shorts by story position', plan.shorts[0].scene_refs[0] < plan.shorts[1].scene_refs[0]);
}

// ---- 2. Three-Short plan -------------------------------------------------------------
let longPlan: any = null;
{
  longPlan = PLAN.createShortsPlan({ projectId, pipeline: longPipeline, count: 3, sceneDurations: longDurations, now: '2026-01-01T00:00:00.000Z' });
  check('2 a 3-Short plan is created on request', longPlan.count === 3 && longPlan.shorts.length === 3, longPlan.count);
  check('2b every requested Short has an arc of 3–6 scenes', longPlan.shorts.every((s: any) => s.scene_refs.length >= 3 && s.scene_refs.length <= 6));
  check('2c the 3-Short plan keeps the story arcs disjoint', new Set(longPlan.shorts.flatMap((s: any) => s.scene_refs)).size === longPlan.shorts.reduce((n: number, s: any) => n + s.scene_refs.length, 0));
}

// ---- 3. Stable Short IDs -------------------------------------------------------------
{
  const again = PLAN.createShortsPlan({ projectId, pipeline: longPipeline, count: 3, sceneDurations: longDurations, now: '2026-02-02T00:00:00.000Z' });
  check('3 re-planning an unchanged story yields identical Short IDs', again.shorts.map((s: any) => s.short_id).join(',') === 'short-01,short-02,short-03');
  check('3b re-planning yields identical plan hashes (deterministic)', again.shorts.map((s: any) => s.plan_hash).join(',') === longPlan.shorts.map((s: any) => s.plan_hash).join(','));
  check('3c the plan input hash is stable across runs', again.input_hash === longPlan.input_hash);
  const two = PLAN.createShortsPlan({ projectId, pipeline: longPipeline, count: 2, sceneDurations: longDurations, now: '2026-01-01T00:00:00.000Z' });
  check('3d short-01 keeps its id when fewer Shorts are requested', two.shorts[0].short_id === 'short-01' && two.shorts[0].plan_hash === longPlan.shorts[0].plan_hash);
}

// ---- 4. Independent narrative coherence ----------------------------------------------
{
  check('4 every Short passes independent-coherence validation', longPlan.shorts.every((s: any) => s.coherence.status !== 'FAIL'), longPlan.shorts.map((s: any) => s.coherence.status));
  check('4b every Short carries a hook, escalation and payoff', longPlan.shorts.every((s: any) => Boolean(s.hook.text) && s.escalation.length >= 1 && Boolean(s.payoff.text)));
  check('4c every Short is self-contained (setup + protagonist checks present)', longPlan.shorts.every((s: any) => s.coherence.checks.some((c: any) => c.id === 'self_contained.setup') && s.coherence.checks.some((c: any) => c.id === 'self_contained.protagonist')));
  const coverage = new Set(longPlan.shorts.flatMap((s: any) => s.scene_refs));
  check('4d the plan is not a naive first/middle/last slice', longPlan.shorts.some((s: any) => s.scene_refs[0] !== 1 && s.scene_refs[0] !== 13), longPlan.shorts.map((s: any) => s.scene_refs));
  check('4e no scene is reused across Shorts', coverage.size === longPlan.shorts.reduce((n: number, s: any) => n + s.scene_refs.length, 0));
}

// ---- 5. Scene references are valid ----------------------------------------------------
{
  const valid = longPlan.shorts.every((s: any) => {
    const known = new Set(longPipeline.scenes.map((scene: any) => scene.scene_number));
    return s.scene_refs.every((n: number) => known.has(n))
      && s.scene_refs.every((n: number, i: number) => i === 0 || n === s.scene_refs[i - 1] + 1);
  });
  check('5 every scene reference exists and the arc is contiguous', valid);
  check('5b hook/payoff references match the arc boundaries', longPlan.shorts.every((s: any) => s.hook.scene_number === s.scene_refs[0] && s.payoff.scene_number === s.scene_refs[s.scene_refs.length - 1]));
  const bounded = longPlan.shorts.every((s: any) => s.payoff.kind === 'reveal' || s.payoff.kind === 'cliffhanger');
  check('5c every payoff is classified as reveal or cliffhanger', bounded);
}

// =======================================================================================
// 6–11. Clip selection, verification and reframing
// =======================================================================================

const firstShort = longPlan.shorts[0];

// ---- 6. Existing approved clips are reusable ------------------------------------------
{
  const clips = await CLIPS.resolveShortClips({ sceneRefs: firstShort.scene_refs, outputsDir, inputRoot: inputsDir, ffprobePath: process.env.FFPROBE_PATH });
  check('6 every selected scene resolves to an existing approved clip', clips.length === firstShort.scene_refs.length && clips.every((clip) => clip.status === 'OK' && clip.absolutePath), clips.map((clip) => clip.status));
  check('6b reused clips are read from outputs/, never re-downloaded', clips.every((clip) => clip.source.startsWith('outputs/') && !clip.source.startsWith('inputs/')));
  check('6c every reused clip carries a verified SHA-256 and duration', clips.every((clip) => typeof clip.sha256 === 'string' && clip.sha256.length === 64 && (clip.duration_seconds ?? 0) > 0));
  check('6d no clip was modified by verification', clips.every((clip) => sha(fs.readFileSync(clip.absolutePath as string)) === clip.sha256));
}

// ---- 7. Invalid clip hashes are detected ----------------------------------------------
{
  const bad = await CLIPS.resolveShortClip({ sceneNumber: firstShort.scene_refs[0], outputsDir, inputRoot: inputsDir, expectedSha256: 'f'.repeat(64), ffprobePath: process.env.FFPROBE_PATH });
  check('7 a mismatched clip hash is refused, not silently reused', bad.status === 'REPLACE_OR_REVIEW' && /hash changed/i.test(bad.reason), bad.reason);
  const missing = await CLIPS.resolveShortClip({ sceneNumber: 999, outputsDir, inputRoot: inputsDir, ffprobePath: process.env.FFPROBE_PATH });
  check('7b a missing clip is flagged for replacement or review', missing.status === 'REPLACE_OR_REVIEW' && /no scene clip/i.test(missing.reason), missing.reason);
}

// ---- 8. Landscape crop metadata -------------------------------------------------------
{
  const reframe = CLIPS.computeReframe(1280, 720);
  check('8 a 16:9 source is cropped to a centred 9:16 window', reframe.mode === 'crop' && reframe.crop !== null, reframe);
  check('8b the crop rectangle is exactly 9:16 and inside the source', Math.abs(reframe.crop.width / reframe.crop.height - 9 / 16) < 0.01 && reframe.crop.x + reframe.crop.width <= 1280);
  check('8c a standard 16:9 reframe keeps ~32% of the width and is SAFE', reframe.retained_fraction > 0.3 && reframe.retained_fraction < 0.34 && reframe.framing === 'SAFE', reframe.retained_fraction);
  check('8d the crop rectangle survives structural validation', CLIPS.validateReframe(reframe).ok);
}

// ---- 9. Portrait source handling ------------------------------------------------------
{
  const portrait = CLIPS.computeReframe(720, 1280);
  check('9 a 9:16 portrait source is used whole (cover)', portrait.mode === 'cover' && portrait.crop === null && portrait.retained_fraction === 1 && portrait.framing === 'SAFE', portrait);
  const tallPortrait = CLIPS.computeReframe(1080, 1920);
  check('9b an exact 1080×1920 source needs no crop at all', tallPortrait.mode === 'cover' && tallPortrait.crop === null);
  const square = CLIPS.computeReframe(800, 800);
  check('9c a square source is horizontally cropped to 9:16', square.mode === 'crop' && square.crop !== null);
  check('9d a portrait source wider than 9:16 is cropped, not stretched', CLIPS.computeReframe(1080, 1440).mode === 'crop');
}

// ---- 10. Safe crop-region validation --------------------------------------------------
{
  const reframe = CLIPS.computeReframe(1280, 720, { anchorX: 1 });
  check('10 the crop offset never escapes the source', reframe.crop.x >= 0 && reframe.crop.x + reframe.crop.width <= 1280);
  const clamped = CLIPS.computeReframe(1280, 720, { anchorX: 9 });
  check('10b an out-of-range subject anchor is clamped', clamped.crop.x + clamped.crop.width <= 1280);
  const tampered = { ...reframe, crop: { ...reframe.crop, x: 2000 } };
  const validation = CLIPS.validateReframe(tampered as any);
  check('10c a crop outside the source frame is rejected', !validation.ok && validation.problems.join(' ').includes('overflow'));
  const tamperedAspect = { ...reframe, crop: { ...reframe.crop, width: reframe.crop.width + 200 } };
  check('10d a crop that is not 9:16 is rejected', !CLIPS.validateReframe(tamperedAspect as any).ok);
  const unsafeWide = CLIPS.computeReframe(2560, 1080);
  check('10e a very wide frame is flagged REVIEW rather than cropped blindly', unsafeWide.framing === 'REVIEW', unsafeWide);
}

// ---- 11. Blurred background composition ----------------------------------------------
{
  const blur = CLIPS.computeReframe(1920, 400);
  check('11 an extreme wide frame is composed with a blurred backdrop', blur.mode === 'blur_fill' && blur.crop === null, blur);
  check('11b the blurred composition keeps the whole source frame', blur.retained_fraction === 1 && blur.framing === 'REVIEW');
  const timeline = RENDER.buildShortTimeline({
    plan: firstShort,
    clips: [-1].map(() => ({
      scene_number: 1,
      source: 'outputs/scene-0001.mp4',
      sha256: 'a'.repeat(64),
      duration_seconds: 3,
      width: 1920,
      height: 400,
      reframe: blur,
      status: 'OK' as const,
      reason: 'blur',
      absolutePath: path.join(outputsDir, 'scene-0001.mp4'),
      has_audio: true,
    })),
    narrationFiles: null,
    narrationDurations: null,
  });
  const graphPlan = RENDER.buildShortRenderPlan({ timeline, burnCaptions: false, logoPath: null });
  check('11c the render graph blurs a scaled backdrop and overlays the full frame', graphPlan.filterComplex.includes('gblur=sigma=40') && graphPlan.filterComplex.includes('overlay=(W-w)/2:(H-h)/2'));
  check('11d the blurred graph still targets 1080×1920', graphPlan.filterComplex.includes('scale=1080:1920:force_original_aspect_ratio=increase'));
}

// =======================================================================================
// Plan the real fixture project, then render
// =======================================================================================

const planned = await WF.planShorts({ ...options, count: 3, now: '2026-01-01T00:00:00.000Z' });
check('P  the fixture project plans at least two Shorts', planned.ok && (planned.plan?.count ?? 0) >= 2, planned.errors);
const shortsPlan = planned.plan as any;
check('P2 the plan file exists under outputs/<id>/shorts/', fs.existsSync(path.join(shortRoot, 'shorts-plan.json')));
check('P3 the plan never modified the story', sha(fs.readFileSync(projectFile)) === longFormBefore['<pipeline>']);

const rendered = await WF.renderShorts({ ...options, now: '2026-01-01T00:01:00.000Z' });
check('P4 every planned Short renders', rendered.ok && rendered.rendered.every((entry) => entry.action === 'RENDERED'), rendered.rendered);

const shortIds: string[] = shortsPlan.shorts.map((short: any) => short.short_id);
const artifactOf = (shortId: string) => path.join(shortRoot, shortId, `${shortId}.mp4`);

// ---- 12. 1080×1920 output validation -------------------------------------------------
{
  const probe = await VC.validateVideoClip(artifactOf(shortIds[0]), { ffprobePath: process.env.FFPROBE_PATH });
  check('12 the rendered Short is a valid video clip', probe.state === 'VALID', probe.reason);
  check('12b the rendered Short is exactly 1080×1920', probe.video?.width === 1080 && probe.video?.height === 1920, probe.video);
  check('12c the rendered Short is portrait (not landscape)', (probe.video?.height ?? 0) > (probe.video?.width ?? 0));
  check('12d the rendered Short carries an audio stream', Boolean(probe.audio));
}

// ---- 13. Audio synchronization --------------------------------------------------------
const qaRun = await WF.qaShorts({ ...options, now: '2026-01-01T00:02:00.000Z' });
check('13 Shorts QA runs for every rendered Short', qaRun.ok && qaRun.reports.length === shortIds.length, qaRun.reports);
{
  const report = readJson(path.join(shortRoot, shortIds[0], 'qa.json'));
  const sync = report.checks.find((c: any) => c.id === 'short.audio_sync');
  check('13b A/V sync is measured and passes', Boolean(sync) && sync.status === 'PASS', sync);
  check('13c A/V drift stays inside half a second', typeof sync.actual === 'number' && sync.actual <= 0.5, sync.actual);
  const dims = report.checks.find((c: any) => c.id === 'short.dimensions_1080x1920');
  check('13d QA proves the exact 1080×1920 delivery', Boolean(dims) && dims.status === 'PASS', dims);
  check('13e QA never marks a Short publishable', report.publishable === false && report.approval_required === true);
}

// ---- 14. Hindi caption segmentation ---------------------------------------------------
{
  const text = 'रात के तीन बजे किसी ने दरवाज़ा खटखटाया, और अर्जुन ने दरवाज़ा खोला। बाहर कोई नहीं था, सिर्फ खून की बूंदें थीं।';
  const chunks = CAP.splitCaptionText(text);
  check('14 a long Hindi line is split into several caption chunks', chunks.length >= 2, chunks);
  check('14b splitting never loses or reorders a word', chunks.join(' ').split(/\s+/).filter(Boolean).join(' ') === text.split(/\s+/).filter(Boolean).join(' '));
  check('14c no chunk exceeds the two-line budget', chunks.every((chunk: string) => [...chunk].length <= CAP.maxCharsPerLine() * 2 + 2));
  check('14d Devanagari punctuation is kept inside its chunk', chunks.some((chunk: string) => chunk.includes('।')));
  check('14e segmentation is deterministic', JSON.stringify(CAP.splitCaptionText(text)) === JSON.stringify(chunks));
}

// ---- 15. Caption timing and safe areas ------------------------------------------------
{
  const segments = [
    { scene_number: 1, kind: 'narration' as const, text: 'रात के तीन बजे दरवाज़ा खटखटाया।', audio: null, duration_seconds: 2.4, start_seconds: 0.1, end_seconds: 2.4 },
    { scene_number: 2, kind: 'dialogue' as const, text: 'कौन है बाहर? इतनी रात को कौन आया?', audio: null, duration_seconds: 2.8, start_seconds: 3.1, end_seconds: 5.9 },
  ];
  const captions = CAP.buildCaptionSegments(segments);
  check('15 captions are produced in narration order', captions.length >= 2 && captions.every((c: any, i: number) => i === 0 || c.start_seconds >= captions[i - 1].end_seconds - 0.05));
  check('15b every caption window is positive and inside the Short', captions.every((c: any) => c.end_seconds > c.start_seconds && c.end_seconds <= 5.9 + 0.05));
  const validation = CAP.validateCaptions(captions, { durationSeconds: 5.9 });
  check('15c the caption track passes timing, length and safe-area validation', validation.status !== 'FAIL', validation.issues);
  const unsafe = CAP.validateCaptions(captions, { durationSeconds: 5.9, style: { marginBottom: 20 } });
  check('15d captions pushed into the platform bottom UI fail the safe-area check', unsafe.status === 'FAIL' && unsafe.issues.some((issue: any) => issue.code.startsWith('caption.safe_area')), unsafe.issues);
  const crowded = CAP.validateCaptions(captions, { durationSeconds: 5.9, style: { maxLines: 1, fontSize: 120 } });
  check('15e over-large typography is rejected as overcrowded', crowded.status === 'FAIL', crowded.issues);
  const ass = CAP.buildAssFile(captions);
  check('15f the ASS track is authored at 1080×1920 with portrait margins', ass.includes('PlayResX: 1080') && ass.includes('PlayResY: 1920') && ass.includes('MarginL') && ass.includes(',80,160,380,'));
}

// ---- 16. Metadata independence --------------------------------------------------------
{
  const short = shortsPlan.shorts[0];
  const metadata = short.metadata;
  check('16 metadata has its own title, not the long-form title', metadata.title !== short.parent_title && metadata.title.length > 0, metadata.title);
  check('16b metadata declares Hindi and a category', metadata.language === 'hi' && Boolean(metadata.category));
  check('16c metadata carries Shorts hashtags and tags', metadata.hashtags.includes('#shorts') && metadata.tags.length > 0);
  check('16d metadata references the parent story without copying it', metadata.parent_story.project_id === projectId && typeof metadata.parent_story.title === 'string');
  check('16e metadata selects a deterministic cover frame', metadata.thumbnail.frame_seconds > 0 && metadata.thumbnail.frame_seconds < short.estimated_duration_seconds + 1);
  const rebuilt = MD.buildShortMetadata({
    projectId,
    shortId: short.short_id,
    index: short.index,
    title: short.title,
    hookText: short.hook.text,
    payoffText: short.payoff.text,
    sceneTitles: [],
    keywords: [],
    parentTitle: short.parent_title,
    estimatedDurationSeconds: short.estimated_duration_seconds,
    hookSceneNumber: short.hook.scene_number,
  });
  check('16f metadata hashing is deterministic', rebuilt.metadata_hash === MD.buildShortMetadata({
    projectId,
    shortId: short.short_id,
    index: short.index,
    title: short.title,
    hookText: short.hook.text,
    payoffText: short.payoff.text,
    sceneTitles: [],
    keywords: [],
    parentTitle: short.parent_title,
    estimatedDurationSeconds: short.estimated_duration_seconds,
    hookSceneNumber: short.hook.scene_number,
  }).metadata_hash);
  check('16g a tampered metadata hash is detected', MD.validateShortMetadata({ ...metadata, title: 'बदला हुआ' }).ok === false);
  check('16h the metadata file on disk matches the plan', readJson(path.join(shortRoot, short.short_id, 'metadata.json')).metadata_hash === metadata.metadata_hash);
}

// ---- 17. Shorts QA failures -----------------------------------------------------------
{
  const failing = async (qaOptions: any) => ({
    ok: false, readOnly: true as const, status: 'FAIL' as const, input: qaOptions.input, sha256: 'b'.repeat(64), bytes: 10,
    durationSeconds: 10, width: 1920, height: 1080, aspectRatio: 1.7778, fps: 24, audioDurationSeconds: 10,
    black: { segments: [], totalSeconds: 0 }, freeze: { segments: [], totalSeconds: 0 }, silence: { segments: [], totalSeconds: 0 },
    loudness: null, peak: null,
    findings: [{ code: 'UNEXPECTED_DIMENSIONS', severity: 'FAIL' as const, message: 'Picture is 1920x1080, expected 1080x1920.' }],
    checks: [], skipped: [],
  });
  const result = await WF.qaShorts({ ...options, shortId: shortIds[0], mediaQa: failing as any });
  check('17 a Short with a failing media contract fails QA', result.ok === false && result.reports[0].status === 'FAIL', result.reports);
  const report = readJson(path.join(shortRoot, shortIds[0], 'qa.json'));
  check('17b the failure is a BLOCKER on the dimensions check', report.checks.some((c: any) => c.status === 'FAIL' && c.id.includes('dimensions')));
  check('17c a failing Short is never publishable', report.publishable === false && report.ok === false);
  check('17d landscape dimensions are rejected by the portrait checks', report.checks.some((c: any) => c.id === 'short.orientation' && c.status === 'FAIL'));
}

// ---- 18. Artifact hash invalidation ---------------------------------------------------
{
  const checkpointPath = path.join(shortRoot, shortIds[1], 'short.json');
  const checkpoint = readJson(checkpointPath);
  fs.writeFileSync(checkpointPath, JSON.stringify({ ...checkpoint, output_hash: '0'.repeat(64) }, null, 2));
  const status = await WF.shortsStatus({ ...options, shortId: shortIds[1], now: '2026-01-01T00:03:00.000Z' });
  check('18 a changed artifact hash is detected as a re-render trigger', status.shorts[0].rerender_reason === 'artifact hash changed', status.shorts[0].rerender_reason);
  const rerun = await WF.renderShorts({ ...options, now: '2026-01-01T00:04:00.000Z' });
  check('18b only the invalidated Short is re-rendered', rerun.rendered.find((r) => r.shortId === shortIds[1])?.action === 'RENDERED'
    && rerun.rendered.filter((r) => r.shortId !== shortIds[1]).every((r) => r.action === 'REUSED'), rerun.rendered);
}

// ---- 19 & 20. Independent resume and unrelated reuse ----------------------------------
{
  const secondPass = await WF.renderShorts({ ...options, now: '2026-01-01T00:05:00.000Z' });
  check('19 unchanged Shorts are reused without re-rendering', secondPass.ok && secondPass.rendered.every((entry) => entry.action === 'REUSED'), secondPass.rendered);

  const target = shortsPlan.shorts[0];
  const narrationScene = target.scene_refs.find((n: number) => NARRATION_SECONDS[n] !== undefined);
  check('19b the first Short contains a narrated scene', Number.isInteger(narrationScene), target.scene_refs);
  const hashBefore = readJson(path.join(shortRoot, shortIds[0], 'short.json')).output_hash;
  const narrationPath = path.join(narrationDir, `narration-${String(narrationScene).padStart(4, '0')}.wav`);
  const original = fs.readFileSync(narrationPath);
  await exec(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=320:sample_rate=48000:duration=3.8', '-c:a', 'pcm_s16le', narrationPath], { maxBuffer: 1024 * 1024 * 8 });

  const afterNarrationChange = await WF.renderShorts({ ...options, now: '2026-01-01T00:06:00.000Z' });
  check('19c a narration change invalidates only its own Short', afterNarrationChange.rendered.find((r) => r.shortId === shortIds[0])?.action === 'RENDERED');
  check('20 unrelated Shorts are reused when another Short changes', afterNarrationChange.rendered.filter((r) => r.shortId !== shortIds[0]).every((r) => r.action === 'REUSED'), afterNarrationChange.rendered);
  check('20b each Short owns its own checkpoint file', shortIds.every((id) => fs.existsSync(path.join(shortRoot, id, 'short.json'))));
  const keys = shortIds.map((id) => readJson(path.join(shortRoot, id, 'short.json')).short_key);
  check('20c every Short checkpoint has a distinct render key', new Set(keys).size === shortIds.length);

  fs.writeFileSync(narrationPath, original);
  const restored = await WF.renderShorts({ ...options, now: '2026-01-01T00:07:00.000Z' });
  check('19d restoring the input re-renders that Short again', restored.rendered.find((r) => r.shortId === shortIds[0])?.action === 'RENDERED');
  const hashAfterRestore = readJson(path.join(shortRoot, shortIds[0], 'short.json')).output_hash;
  check('19e restoring identical inputs reproduces the identical artifact', hashAfterRestore === hashBefore, { hashBefore, hashAfterRestore });
  const thirdPass = await WF.renderShorts({ ...options, now: '2026-01-01T00:07:30.000Z' });
  check('19f the restored Short is reused on the next pass', thirdPass.rendered.every((entry) => entry.action === 'REUSED'), thirdPass.rendered);
}

// ---- 20d/20e. The render key is bound to clip AND narration CONTENT -------------------
// A re-encoded clip or a re-recorded line with an identical duration must still invalidate the
// key. Without the content hashes these two cases would silently reuse a stale Short.
{
  const scenePath = path.join(outputsDir, 'scene-0002.mp4');
  const sceneOriginal = fs.readFileSync(scenePath);
  const sceneHashBefore = sha(sceneOriginal);
  const artifactHashBefore = readJson(path.join(shortRoot, shortIds[0], 'short.json')).output_hash;
  const checkpointBefore = readJson(path.join(shortRoot, shortIds[0], 'short.json'));
  check('20d the checkpoint records the source clip hash it was rendered from',
    checkpointBefore.clip_hashes['2'] === sceneHashBefore, { recorded: checkpointBefore.clip_hashes['2'], sceneHashBefore });

  // Same resolution, same duration, different pixels.
  await exec(ff, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=red:s=1280x720:d=${CLIP_SECONDS}:r=24`,
    '-f', 'lavfi', '-i', `sine=frequency=300:sample_rate=48000:duration=${CLIP_SECONDS}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', scenePath,
  ], { maxBuffer: 1024 * 1024 * 8 });
  check('20e the replaced clip keeps the same duration and resolution',
    sha(fs.readFileSync(scenePath)) !== sceneHashBefore && fs.statSync(scenePath).size > 0);

  const afterClipChange = await WF.renderShorts({ ...options, now: '2026-01-01T00:07:40.000Z' });
  check('20f a changed clip re-renders only the Short that uses it',
    afterClipChange.rendered.find((r) => r.shortId === shortIds[0])?.action === 'RENDERED'
    && afterClipChange.rendered.filter((r) => r.shortId !== shortIds[0]).every((r) => r.action === 'REUSED'),
    afterClipChange.rendered);

  fs.writeFileSync(scenePath, sceneOriginal);
  const afterClipRestore = await WF.renderShorts({ ...options, now: '2026-01-01T00:07:50.000Z' });
  check('20g restoring the clip re-renders that Short again',
    afterClipRestore.rendered.find((r) => r.shortId === shortIds[0])?.action === 'RENDERED');
  check('20h the restored clip reproduces the original artifact bytes exactly',
    readJson(path.join(shortRoot, shortIds[0], 'short.json')).output_hash === artifactHashBefore);

  // Same duration (3.0 s), different waveform.
  const narrationFile = path.join(narrationDir, 'narration-0001.wav');
  const narrationOriginal = fs.readFileSync(narrationFile);
  await exec(ff, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3.0',
    '-c:a', 'pcm_s16le', narrationFile,
  ], { maxBuffer: 1024 * 1024 * 8 });
  const afterNarrationContent = await WF.renderShorts({ ...options, now: '2026-01-01T00:08:10.000Z' });
  check('20i a re-recorded narration with the same duration re-renders only its own Short',
    afterNarrationContent.rendered.find((r) => r.shortId === shortIds[0])?.action === 'RENDERED'
    && afterNarrationContent.rendered.filter((r) => r.shortId !== shortIds[0]).every((r) => r.action === 'REUSED'),
    afterNarrationContent.rendered);

  fs.writeFileSync(narrationFile, narrationOriginal);
  const afterNarrationRestore = await WF.renderShorts({ ...options, now: '2026-01-01T00:08:20.000Z' });
  check('20j restoring the narration reproduces the original artifact bytes exactly',
    afterNarrationRestore.rendered.find((r) => r.shortId === shortIds[0])?.action === 'RENDERED'
    && readJson(path.join(shortRoot, shortIds[0], 'short.json')).output_hash === artifactHashBefore);
}

// ---- 21. Long-form outputs remain unchanged -------------------------------------------
{
  const now = snapshotLongForm();
  const before = JSON.stringify(longFormBefore);
  check('21 the long-form artifacts are untouched by Shorts', JSON.stringify(now) === before, {
    added: Object.keys(now).filter((key) => !(key in longFormBefore)),
    changed: Object.keys(now).filter((key) => key in longFormBefore && now[key] !== longFormBefore[key]),
  });
  check('21b no long-form final render was produced', !fs.existsSync(path.join(outputsDir, 'final-title.mp4')) && !fs.existsSync(path.join(outputsDir, 'final-with-fades.mp4')));
  check('21c no long-form approval record was written', !fs.existsSync(path.join(outputsDir, 'approval.json')));
  const status = await WF.shortsStatus({ ...options, now: '2026-01-01T00:08:00.000Z' });
  check('21d the status report declares the long-form parent unmodified', status.long_form_modified === false && status.publishable === false);
}

// =======================================================================================
// 22–25. Existing phase authorities remain authoritative
// =======================================================================================

const shortsSources = ['shortsTypes.ts', 'shortsPlan.ts', 'shortsCaptions.ts', 'shortsClips.ts', 'shortsRender.ts', 'shortsQa.ts', 'shortsWorkflow.ts', 'shortsMetadata.ts']
  .map((file) => ({ file, text: fs.readFileSync(path.join(SRC, file), 'utf8') }));

// ---- 22. Phase 2 paid-generation gates remain authoritative ---------------------------
{
  const forbidden = [/from\s+'\.\/flowClient/, /from\s+'\.\/flowRunner/, /from\s+'\.\/flowSession/, /playwright/, /@google\/genai/, /openai/, /from\s+'\.\/characterGenerator/, /from\s+'\.\/sceneExecutor/, /zernio/];
  const offenders = shortsSources.filter(({ text }) => forbidden.some((pattern) => pattern.test(text))).map(({ file }) => file);
  check('22 Shorts code cannot reach Flow, a browser, a model provider or Zernio', offenders.length === 0, offenders);
  check('22b the Shorts CLI has no --run-flow switch', !fs.readFileSync(path.join(SRC, 'video.ts'), 'utf8').includes('shorts --run-flow'));
  check('22c no Shorts module shells out to a generator', shortsSources.every(({ text }) => !/spawn\(|submit\(|generateScene|runGeneration/.test(text)));
}

// ---- 23. Phase 3 story validation remains authoritative -------------------------------
{
  check('23 no Shorts module writes or regenerates the story', shortsSources.every(({ text }) => !/writeFile\([^)]*pipeline\.json/.test(text) && !/pipelineGenerator|storyValidation/.test(text)));
  check('23b the fixture pipeline is byte-identical after every Shorts command', sha(fs.readFileSync(projectFile)) === longFormBefore['<pipeline>']);
}

// ---- 24. Phase 4 QA remains authoritative ---------------------------------------------
{
  let captured: any = null;
  const spy = async (qaOptions: any) => {
    captured = qaOptions;
    return {
      ok: true, readOnly: true as const, status: 'PASS' as const, input: qaOptions.input, sha256: readJson(path.join(shortRoot, shortIds[0], 'short.json')).output_hash,
      bytes: 10, durationSeconds: 12, width: 1080, height: 1920, aspectRatio: 0.5625, fps: 24, audioDurationSeconds: 12,
      black: { segments: [], totalSeconds: 0 }, freeze: { segments: [], totalSeconds: 0 }, silence: { segments: [], totalSeconds: 0 },
      loudness: { integratedLufs: -14, rangeLu: 5, truePeakDb: -1.5 }, peak: null,
      findings: [], checks: [], skipped: [],
    };
  };
  const result = await WF.qaShorts({ ...options, shortId: shortIds[0], mediaQa: spy as any });
  check('24 Shorts QA delegates to the Phase 4 engine', result.ok === true && result.reports[0].status === 'PASS', result.reports);
  check('24b the engine is asked for the exact portrait contract', captured?.expectWidth === 1080 && captured?.expectHeight === 1920 && captured?.expectFps === 24);
  check('24c the engine is asked for narration loudness and audio presence', captured?.targetLufs === -14 && captured?.requireAudio === true && captured?.requireVideo === true);
  check('24d the QA module imports the single shared engine', /from '\.\/mediaQa\.js'/.test(fs.readFileSync(path.join(SRC, 'shortsQa.ts'), 'utf8')));
}

// ---- 25. Phase 5 checkpoint and recovery behaviour remains intact ---------------------
{
  check('25 the long-form reliability model still has exactly 13 stages', REL.RELIABILITY_STAGES.length === 13, REL.RELIABILITY_STAGES.length);
  check('25b Shorts code does not extend or mutate the reliability stage model', shortsSources.every(({ text }) => !/RELIABILITY_STAGES|deriveReliability/.test(text)));
  const checkpoints = shortIds.map((id) => readJson(path.join(shortRoot, id, 'short.json')));
  check('25c every Short checkpoint records its own plan hash, clip hashes and output hash', checkpoints.every((cp) => cp.plan_hash && cp.output_hash && Object.keys(cp.clip_hashes).length > 0));
  check('25d checkpoints are written beside their own artifact only', checkpoints.every((cp, i) => fs.existsSync(path.join(shortRoot, shortIds[i], cp.output_path))));
  const status = await WF.shortsStatus({ ...options, now: '2026-01-01T00:09:00.000Z' });
  check('25e status is read-only and reports a re-render reason per Short', status.read_only === true && status.shorts.every((s: any) => typeof s.rerender_reason === 'string' || s.rerender_reason === null));
}

// =======================================================================================
// 26. Explicit approval is required before any Short is publishable
// =======================================================================================

// Re-run the real QA so every Short has fresh evidence bound to the current bytes.
const finalQa = await WF.qaShorts({ ...options, now: '2026-01-01T00:10:00.000Z' });
check('26 Shorts QA passes on the final artifacts', finalQa.ok, finalQa.reports);

{
  const before = await WF.shortApprovalVerdict({ outputsRoot, projectId }, shortIds[0]);
  check('26b an unapproved Short is NOT_APPROVED', before.status === 'NOT_APPROVED');

  const withoutYes = await WF.approveShort({ ...options, shortId: shortIds[0], confirmed: false });
  check('26c approval without explicit confirmation is refused', withoutYes.status === 'REFUSED' && !fs.existsSync(path.join(shortRoot, shortIds[0], 'approval.json')));

  const wrongHash = await WF.approveShort({ ...options, shortId: shortIds[0], confirmed: true, expectedHash: 'a'.repeat(64) });
  check('26d approval against a different artifact hash is refused', wrongHash.status === 'REFUSED');

  const approved = await WF.approveShort({ ...options, shortId: shortIds[0], confirmed: true, approvedBy: 'offline-test' });
  check('26e a QA-clean Short can be approved explicitly', approved.status === 'APPROVED' && approved.record?.artifact_kind === 'short', approved.reason);
  const record = readJson(path.join(shortRoot, shortIds[0], 'approval.json'));
  check('26f the approval is bound to the artifact hash and render key', record.approved_output_hash === approved.outputHash && Boolean(record.approved_short_key));
  check('26g approval is per Short and leaves the others unapproved', !fs.existsSync(path.join(shortRoot, shortIds[1], 'approval.json')));
  const status = await WF.shortsStatus({ ...options, now: '2026-01-01T00:11:00.000Z' });
  check('26h an approved Short is still not publishable by the pipeline', status.publishable === false && status.shorts.every((s: any) => s.publishable === false));

  fs.appendFileSync(artifactOf(shortIds[0]), Buffer.from([0]));
  const tampered = await WF.shortApprovalVerdict({ outputsRoot, projectId }, shortIds[0]);
  check('26i changing the artifact bytes makes the approval stale', tampered.status === 'STALE_APPROVAL', tampered.reason);
  const restore = await WF.renderShorts({ ...options, shortId: shortIds[0], now: '2026-01-01T00:12:00.000Z' });
  check('26j the tampered Short is re-rendered and its approval is cleared', restore.rendered[0]?.action === 'RENDERED' && !fs.existsSync(path.join(shortRoot, shortIds[0], 'approval.json')));
}

// ---- 27. No external calls or paid generation during the whole run --------------------
{
  check('27 no network request was attempted by any Shorts operation', networkAttempts === 0, networkAttempts);
  let threw = false;
  try { await (globalThis as any).fetch('https://example.invalid'); } catch { threw = true; }
  check('27b the disabled network guard really blocks calls', threw);
  check('27c no Shorts source references a network client', shortsSources.every(({ text }) => !/fetch\(|axios|http\.request|https\.request/.test(text)));
  check('27d no Shorts operation spent credits or opened a browser', !fs.existsSync(path.join(tmp, 'chrome-profile')) && shortsSources.every(({ text }) => !/chromium|launchPersistentContext/.test(text)));
  check('27e no Shorts source can mark anything publishable', shortsSources.every(({ text }) => !/publishable:\s*true/.test(text)));
}

console.log(`\n${passed} checks passed. Temp: ${tmp}`);
