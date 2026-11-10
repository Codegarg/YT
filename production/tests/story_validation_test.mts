/**
 * PHASE 3 — offline tests for the read-only story & scene intelligence boundary.
 *
 * No network, no model, no Flow, no browser, no publisher. Temp files only.
 *
 * Covers:
 *   · tolerant report parsing / normalisation (incl. backward-compatible reports)
 *   · the pure gate decisions (blockers, warnings, strict review, unavailable)
 *   · the per-scene defence
 *   · the Python bridge with an injectable spawn (success, blocked, unparsable, missing file)
 *   · ONE end-to-end run against the REAL canonical Python validator (read-only guarantee)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { REPO, SRC } from './_testPaths.mjs';

const SV = await import(pathToFileURL(`${SRC}/storyValidation.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

// ---------------------------------------------------------------------------
// 1. Tolerant parsing
// ---------------------------------------------------------------------------
{
  const clean = SV.parseStoryReport('{"ok":true,"status":"PASS"}');
  check('parseStoryReport parses a clean document', clean?.status === 'PASS');

  const noisy = SV.parseStoryReport('warning: something\n{"ok":false,"status":"BLOCKED","nested":{"a":"}"}}\ntrailing prose');
  check('parseStoryReport survives surrounding prose', noisy?.status === 'BLOCKED' && noisy?.nested?.a === '}');

  check('parseStoryReport returns null for non-JSON', SV.parseStoryReport('not json at all') === null);
  const arrayWrapped = SV.parseStoryReport('[{"ok":true,"status":"REVIEW"}]');
  check('parseStoryReport never throws on an array wrapper', arrayWrapped?.status === 'REVIEW');
}

// ---------------------------------------------------------------------------
// 2. Normalisation (new + backward-compatible shapes)
// ---------------------------------------------------------------------------
{
  const report = SV.normalizeStoryReport({
    ok: true,
    status: 'REVIEW',
    project_id: 'p1',
    scenes: 3,
    characters: 1,
    backgrounds: 2,
    counts: { blockers: 0, warnings: 1, infos: 0 },
    findings: [{ code: 'W', message: 'm', severity: 'WARNING', scope: 'scene', scene: 2 }],
    recommended_actions: ['fix it'],
    stats: { words: 10 },
  });
  check('normalizeStoryReport keeps counts/status/stats', report.status === 'REVIEW' && report.counts.warnings === 1 && report.stats.words === 10);
  check('normalizeStoryReport keeps the scene scope', report.findings[0].scope === 'scene' && report.findings[0].scene === 2);
  check('normalizeStoryReport projects recommended actions', report.recommendedActions[0] === 'fix it');

  const legacy = SV.normalizeStoryReport({
    ok: false,
    errors: [{ code: 'OLD_E', message: 'bad' }],
    warnings: [{ code: 'OLD_W', message: 'meh' }],
  });
  check('legacy errors map to BLOCKER findings', legacy.findings.find((f: any) => f.code === 'OLD_E')?.severity === 'BLOCKER');
  check('legacy warnings map to WARNING findings', legacy.findings.find((f: any) => f.code === 'OLD_W')?.severity === 'WARNING');
  check('legacy blocked status is derived from blockers', legacy.status === 'BLOCKED' && legacy.ok === false);

  const sceneOnly = SV.normalizeStoryReport({
    ok: true,
    findings: [{ code: 'S', message: 'x', severity: 'WARNING', scene: 7 }],
  });
  check('a finding that names a scene is scene-scoped', sceneOnly.findings[0].scope === 'scene' && sceneOnly.storyFindings.length === 0);
}

// ---------------------------------------------------------------------------
// 3. Gate decisions (pure)
// ---------------------------------------------------------------------------
{
  const empty = { ok: true, available: true, status: 'PASS', projectId: 'p', projectFile: 'f', exitCode: 0, blockers: [], warnings: [], infos: [], stdout: '', stderr: '' };
  check('gate: no validator result allows (legacy behaviour preserved)', SV.decideStoryGate(undefined).allowed === true);
  check('gate: PASS allows', SV.decideStoryGate(empty).allowed === true);

  const review = { ...empty, status: 'REVIEW', warnings: [{ code: 'W', message: 'meh', severity: 'WARNING', scope: 'story' }] };
  check('gate: warnings do NOT block by default', SV.decideStoryGate(review).allowed === true);
  const strict = SV.decideStoryGate(review, { blockOnWarnings: true });
  check('gate: warnings block under explicit strict review', strict.allowed === false && strict.code === 'STORY_REVIEW_REQUIRED');

  const blocked = { ...empty, status: 'BLOCKED', ok: false, blockers: [{ code: 'B', message: 'broken', severity: 'BLOCKER', scope: 'scene', scene: 3 }] };
  const blockedDecision = SV.decideStoryGate(blocked);
  check('gate: blockers always block', blockedDecision.allowed === false && blockedDecision.code === 'STORY_BLOCKED');
  check('gate: blocker reason names the scene and code', /B \(scene 3\)/.test(blockedDecision.reason ?? ''), blockedDecision.reason);

  const unavailable = { ...empty, ok: false, available: false, status: 'UNAVAILABLE', reason: 'python missing' };
  check('gate: unavailable fails CLOSED for a paid run', SV.decideStoryGate(unavailable).allowed === false && SV.decideStoryGate(unavailable).code === 'STORY_VALIDATION_UNAVAILABLE');
  check('gate: unavailable is tolerated for a zero-credit run', SV.decideStoryGate(unavailable, { allowUnavailable: true }).allowed === true);
}

// ---------------------------------------------------------------------------
// 4. Per-scene defence (pure)
// ---------------------------------------------------------------------------
{
  const result = {
    ok: false, available: true, status: 'BLOCKED', projectId: 'p', projectFile: 'f', exitCode: 1,
    blockers: [
      { code: 'SCENE_B', message: 'scene 2 broken', severity: 'BLOCKER', scope: 'scene', scene: 2 },
      { code: 'STORY_B', message: 'project broken', severity: 'BLOCKER', scope: 'story' },
    ],
    warnings: [{ code: 'SCENE_W', message: 'scene 3 warn', severity: 'WARNING', scope: 'scene', scene: 3 }],
    infos: [],
    stdout: '', stderr: '',
  };
  check('scene gate blocks the named scene', SV.decideSceneStoryGate(result, 2).allowed === false);
  check('scene gate allows an unrelated scene', SV.decideSceneStoryGate(result, 1).allowed === true);
  check('scene gate ignores project-level findings', SV.decideSceneStoryGate(result, 4).allowed === true);
  check('scene gate ignores WARNINGs by default', SV.decideSceneStoryGate(result, 3).allowed === true);
  check('scene gate blocks WARNINGs under strict review', SV.decideSceneStoryGate(result, 3, true).allowed === false);
  check('scene gate is inert without a report', SV.decideSceneStoryGate(undefined, 2).allowed === true);
}

// ---------------------------------------------------------------------------
// 5. Argument vector
// ---------------------------------------------------------------------------
{
  const args = SV.buildStoryValidationArgs('C:/p/pipeline.json', false);
  check('args: canonical read-only CLI invocation', args.join(' ') === '-m pipeline.one_minute --check --project-file C:/p/pipeline.json', args);
  check('args: --strict is appended only when asked', SV.buildStoryValidationArgs('p.json', true).includes('--strict'));
  check('args: never carries a write flag', !args.some((a: string) => /--(?:save|write|generate|publish)/.test(a)));
}

// ---------------------------------------------------------------------------
// 6. Python bridge with an injectable spawn
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p3sv-'));
try {
  const projectFile = path.join(tmp, 'pipeline.json');
  fs.writeFileSync(projectFile, '{"project_id":"p"}', 'utf8');

  const calls: any[] = [];
  const fakeSpawn = (code: number, stdout: string, stderr = '') => async (command: string, args: string[], opts: any) => {
    calls.push({ command, args, opts });
    return { code, stdout, stderr, timedOut: false };
  };

  const okBody = JSON.stringify({ ok: true, status: 'PASS', project_id: 'p', scenes: 2, characters: 0, backgrounds: 1, counts: { blockers: 0, warnings: 0, infos: 0 }, findings: [], stats: {} });
  const okRun = await SV.createPythonStoryValidator({ repoRoot: REPO, spawn: fakeSpawn(0, okBody) })({ projectFile });
  check('bridge: a clean report is available and ok', okRun.available === true && okRun.ok === true && okRun.status === 'PASS');
  check('bridge: spawn is called with the read-only args', calls[0].args.includes('--check') && calls[0].args.includes('--project-file'));
  check('bridge: child env keeps Devanagari intact (PYTHONIOENCODING)', calls[0].opts.env.PYTHONIOENCODING === 'utf-8');

  const blockedBody = JSON.stringify({ ok: false, status: 'BLOCKED', project_id: 'p', findings: [{ code: 'X', message: 'bad', severity: 'BLOCKER', scope: 'story' }], counts: { blockers: 1 } });
  const blockedRun = await SV.createPythonStoryValidator({ repoRoot: REPO, spawn: fakeSpawn(1, blockedBody) })({ projectFile });
  check('bridge: blockers surface even with a non-zero exit', blockedRun.available === true && blockedRun.blockers.length === 1 && blockedRun.ok === false);

  const noisyRun = await SV.createPythonStoryValidator({ repoRoot: REPO, spawn: fakeSpawn(0, `launcher noise\n${okBody}`) })({ projectFile });
  check('bridge: tolerates launcher noise before the JSON', noisyRun.available === true && noisyRun.status === 'PASS');

  const garbageRun = await SV.createPythonStoryValidator({ repoRoot: REPO, spawn: fakeSpawn(1, 'Traceback: boom', 'Traceback: boom') })({ projectFile });
  check('bridge: unparsable output is UNAVAILABLE, never PASS', garbageRun.available === false && garbageRun.ok === false && /no parsable report/.test(garbageRun.reason ?? ''), garbageRun.reason);

  const throwRun = await SV.createPythonStoryValidator({ repoRoot: REPO, spawn: async () => { throw new Error('ENOENT python'); } })({ projectFile });
  check('bridge: a spawn failure is UNAVAILABLE, never PASS', throwRun.available === false && /could not start/.test(throwRun.reason ?? ''), throwRun.reason);

  const missingRun = await SV.createPythonStoryValidator({ repoRoot: REPO, spawn: fakeSpawn(0, okBody) })({ projectFile: path.join(tmp, 'absent.json') });
  check('bridge: a missing project file is reported without spawning', missingRun.available === false && /not found/.test(missingRun.reason ?? ''), missingRun.reason);

  const strictCalls: any[] = [];
  await SV.createPythonStoryValidator({ repoRoot: REPO, spawn: async (c: string, a: string[]) => { strictCalls.push(a); return { code: 0, stdout: okBody, stderr: '', timedOut: false }; } })({ projectFile, strict: true });
  check('bridge: strict review forwards --strict', strictCalls[0].includes('--strict'));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 7. End-to-end against the REAL canonical Python validator (offline, read-only)
// ---------------------------------------------------------------------------
{
  const bgTag = '#BGD-01-NIGHT-BUS';
  const narration = 'रात के साढ़े तीन बजे बस की तीसरी सीट पर कोई अनजाना व्यक्ति बैठा था और खिड़की के बाहर सिर्फ़ घना अंधेरा था।';
  const scene = (n: number) => ({
    scene_number: n,
    title: `Scene ${n}`,
    background_tag: bgTag,
    character_tags: [],
    speaker: 'NARRATOR',
    visual_action: 'The empty night bus rocks gently while rain streaks the windows and the camera slowly pushes toward the third seat.',
    camera: 'slow push-in, eye level, static horizon, 35mm feel',
    effects: 'rain on glass',
    sound_design: 'rain, engine hum, distant thunder',
    devanagari_dialogue: '',
    narration_text: narration,
  });
  const payload = {
    project_id: 'phase3-fixture',
    characters: [],
    backgrounds: [{ tag: bgTag, location_name: 'Night bus interior', look_summary: 'Empty night bus interior.', full_prompt: 'x' }],
    scenes: [scene(1), scene(2)],
    script: { raw_text: 'word '.repeat(750).trim(), word_count: 750, duration_minutes: 5 },
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3real-'));
  try {
    const projectFile = path.join(dir, 'pipeline.json');
    fs.writeFileSync(projectFile, JSON.stringify(payload, null, 2), 'utf8');
    const before = fs.readFileSync(projectFile);
    const beforeHash = crypto.createHash('sha256').update(before).digest('hex');

    const result = await SV.createPythonStoryValidator({ repoRoot: REPO })({ projectFile });
    check('real validator: the bridge reaches the canonical Python audit', result.available === true, result.reason);
    check('real validator: a sound fixture has no BLOCKERs', result.blockers.length === 0, result.blockers);
    check('real validator: report is explicitly read-only', result.report?.readOnly === true);

    const afterHash = crypto.createHash('sha256').update(fs.readFileSync(projectFile)).digest('hex');
    check('real validator: pipeline.json is byte-identical afterwards', afterHash === beforeHash);
    check('real validator: no sibling files are created', fs.readdirSync(dir).join(',') === 'pipeline.json', fs.readdirSync(dir));

    // A structural contradiction must be a BLOCKER that the gate refuses.
    const broken = { ...payload, scenes: [scene(1), { ...scene(2), background_tag: '#BGD-99-ABSENT' }] };
    const brokenFile = path.join(dir, 'broken.json');
    fs.writeFileSync(brokenFile, JSON.stringify(broken, null, 2), 'utf8');
    const brokenResult = await SV.createPythonStoryValidator({ repoRoot: REPO })({ projectFile: brokenFile });
    check('real validator: an unknown background is a BLOCKER', brokenResult.available === true && brokenResult.blockers.length > 0, brokenResult.reason);
    check('real validator: the gate refuses the broken project', SV.decideStoryGate(brokenResult).allowed === false);

    // Missing narration on a narrated scene must also block.
    const silent = { ...payload, scenes: [{ ...scene(1), narration_text: '' }, scene(2)] };
    const silentFile = path.join(dir, 'silent.json');
    fs.writeFileSync(silentFile, JSON.stringify(silent, null, 2), 'utf8');
    const silentResult = await SV.createPythonStoryValidator({ repoRoot: REPO })({ projectFile: silentFile });
    check('real validator: missing narration is a BLOCKER', silentResult.blockers.some((f: any) => f.code === 'NARRATION_MISSING'), silentResult.blockers.map((f: any) => f.code));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nPHASE 3 STORY VALIDATION TESTS PASSED (${passed} checks)`);
