/**
 * PHASE 3 — offline gate tests across the REAL boundaries.
 *
 * Proves the read-only story/scene audit is enforced at every paid-generation entry point and
 * that it NEVER mutates the project or a generation artefact.
 *
 * No network, no Chrome/Flow, no model, no publisher. Temp directories only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { SRC, FF } from './_testPaths.mjs';

process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;

const WF = await import(pathToFileURL(`${SRC}/projectWorkflow.ts`).href);
const FRA = await import(pathToFileURL(`${SRC}/flowRunnerAdapter.ts`).href);
const SEA = await import(pathToFileURL(`${SRC}/sceneExecutorAdapter.ts`).href);

const execFileAsync = promisify(execFile);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p3gate-'));
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function pipeline(id: string) {
  return {
    project_id: id,
    flow_project_name: 'F',
    characters: [],
    backgrounds: [{ tag: '#BGD-01-NIGHT-BUS', location_name: 'Night bus', look_summary: 'Empty night bus.', full_prompt: 'x' }],
    scenes: [1, 2].map((n) => ({
      scene_number: n,
      title: `S${n}`,
      background_tag: '#BGD-01-NIGHT-BUS',
      character_tags: [],
      speaker: 'NARRATOR',
      visual_action: `A specific filmable beat number ${n}.`,
      camera: 'static wide shot, eye level',
      effects: 'rain',
      sound_design: 'rain and engine hum',
      devanagari_dialogue: '',
      narration_text: 'रात के साढ़े तीन बजे बस की तीसरी सीट पर कोई अनजाना व्यक्ति बैठा था और बाहर घना अंधेरा था।',
      status: 'pending',
    })),
  };
}

function fixture(tag: string) {
  const root = path.join(tmp, tag);
  const projectsRoot = path.join(root, 'projects');
  const inputsRoot = path.join(root, 'inputs');
  const outputsRoot = path.join(root, 'outputs');
  const projectId = `p3-${tag}`;
  const projectDir = path.join(projectsRoot, projectId);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(inputsRoot, projectId), { recursive: true });
  fs.mkdirSync(path.join(outputsRoot, projectId), { recursive: true });
  const projectFile = path.join(projectDir, 'pipeline.json');
  fs.writeFileSync(projectFile, JSON.stringify(pipeline(projectId), null, 2), 'utf8');
  return { root, projectsRoot, inputsRoot, outputsRoot, projectId, projectDir, projectFile };
}

const finding = (severity: string, code: string, message: string, scene?: number) => ({
  code, message, severity, ...(scene !== undefined ? { scope: 'scene', scene } : { scope: 'story' }),
});
const validResult = (over: any = {}) => ({
  ok: true, available: true, status: 'PASS', projectId: 'p3', projectFile: 'p', exitCode: 0,
  blockers: [], warnings: [], infos: [], stdout: '', stderr: '', ...over,
});
const validator = (result: any) => { const calls: any[] = []; const fn = async (input: any) => { calls.push(input); return result; }; return { fn, calls }; };

const optsFor = (f: any, extra: any = {}) => ({
  projectsRoot: f.projectsRoot,
  inputsRoot: f.inputsRoot,
  outputsRoot: f.outputsRoot,
  projectId: f.projectId,
  ffprobePath: process.env.FFPROBE_PATH,
  productionDir: process.cwd(),
  ...extra,
});

try {
  // =====================================================================
  // A. resumeProjectWorkflow — blockers stop PAID generation, nothing is written
  // =====================================================================
  {
    const f = fixture('resume-blocked');
    const before = sha(f.projectFile);
    let flowCalls = 0;
    let executorBuilt = 0;
    const v = validator(validResult({ ok: false, status: 'BLOCKED', blockers: [finding('BLOCKER', 'NARRATION_MISSING', 'scene 1 has no narration')] }));
    const r: any = await WF.resumeProjectWorkflow(optsFor(f, {
      runFlow: true,
      storyValidator: v.fn,
      flowRunner: async () => { flowCalls++; return { ok: true }; },
      sceneExecutorFactory: () => { executorBuilt++; return async () => ({ ok: true }); },
    }));
    check('resume: a BLOCKER stops paid generation', r.phase === 'FAILED' && r.status === 'PERMANENT_FAILURE', { phase: r.phase, status: r.status });
    check('resume: the gate reason names the code', r.storyGate?.allowed === false && r.storyGate?.code === 'STORY_BLOCKED', r.storyGate);
    check('resume: the Flow boundary is NEVER invoked', flowCalls === 0);
    check('resume: no scene executor is built', executorBuilt === 0);
    check('resume: the pipeline file is byte-identical', sha(f.projectFile) === before);
    check('resume: no generation state is created', !fs.existsSync(path.join(f.outputsRoot, f.projectId, 'state.json')));
    check('resume: the report is surfaced on the result', r.storyValidation?.status === 'BLOCKED');
  }

  // =====================================================================
  // B. resumeProjectWorkflow — zero-credit resume is NOT blocked, but reports
  // =====================================================================
  {
    const f = fixture('resume-zerocredit');
    const before = sha(f.projectFile);
    let flowCalls = 0;
    const v = validator(validResult({ ok: false, status: 'BLOCKED', blockers: [finding('BLOCKER', 'NARRATION_MISSING', 'scene 1 has no narration')] }));
    const r: any = await WF.resumeProjectWorkflow(optsFor(f, {
      runFlow: false,
      storyValidator: v.fn,
      flowRunner: async () => { flowCalls++; return { ok: true }; },
    }));
    check('zero-credit resume is not stopped by the gate', r.phase !== 'FAILED', { phase: r.phase, status: r.status });
    check('zero-credit resume surfaces the BLOCKER report', r.storyValidation?.blockers?.length === 1 && r.storyGate?.code === 'STORY_BLOCKED');
    check('zero-credit resume never calls Flow', flowCalls === 0);
    check('zero-credit resume leaves the pipeline byte-identical', sha(f.projectFile) === before);
  }

  // =====================================================================
  // C. WARNINGs do not block by default; strict review does
  // =====================================================================
  {
    const f = fixture('resume-warn');
    let flowCalls = 0;
    const v = validator(validResult({ ok: true, status: 'REVIEW', warnings: [finding('WARNING', 'WEAK_OPENING', 'short hook')] }));
    const r: any = await WF.resumeProjectWorkflow(optsFor(f, {
      runFlow: true,
      storyValidator: v.fn,
      flowRunner: async () => { flowCalls++; return { ok: true, status: 'FLOW_REQUIRED' }; },
    }));
    check('warnings do NOT block paid generation by default', r.phase !== 'FAILED' && r.storyGate?.allowed === true, { phase: r.phase, gate: r.storyGate });
    check('warnings still reach the Flow boundary (nothing is silently skipped)', flowCalls === 1, flowCalls);
    check('warnings are surfaced for human review', r.storyValidation?.warnings?.length === 1);
  }
  {
    const f = fixture('resume-strict');
    let flowCalls = 0;
    const v = validator(validResult({ ok: true, status: 'REVIEW', warnings: [finding('WARNING', 'WEAK_OPENING', 'short hook')] }));
    const r: any = await WF.resumeProjectWorkflow(optsFor(f, {
      runFlow: true,
      blockOnStoryWarnings: true,
      storyValidator: v.fn,
      flowRunner: async () => { flowCalls++; return { ok: true }; },
    }));
    check('--story-warnings-block stops paid generation on a WARNING', r.phase === 'FAILED' && r.storyGate?.code === 'STORY_REVIEW_REQUIRED', r.storyGate);
    check('strict review never reaches the Flow boundary', flowCalls === 0);
  }

  // =====================================================================
  // D. an unusable validator fails CLOSED only for paid generation
  // =====================================================================
  {
    const f = fixture('resume-unavailable');
    let flowCalls = 0;
    const v = validator(validResult({ ok: false, available: false, status: 'UNAVAILABLE', reason: 'python missing' }));
    const paid: any = await WF.resumeProjectWorkflow(optsFor(f, {
      runFlow: true, storyValidator: v.fn,
      flowRunner: async () => { flowCalls++; return { ok: true }; },
    }));
    check('paid resume fails closed when validation is unavailable', paid.phase === 'FAILED' && paid.storyGate?.code === 'STORY_VALIDATION_UNAVAILABLE', paid.storyGate);
    check('paid resume does not invoke Flow when validation is unavailable', flowCalls === 0);

    const zero: any = await WF.resumeProjectWorkflow(optsFor(f, { runFlow: false, storyValidator: v.fn }));
    check('zero-credit resume tolerates an unavailable validator', zero.phase !== 'FAILED', zero.phase);
  }
  {
    const f = fixture('resume-no-validator');
    let flowCalls = 0;
    const r: any = await WF.resumeProjectWorkflow(optsFor(f, {
      runFlow: true,
      flowRunner: async () => { flowCalls++; return { ok: true, status: 'FLOW_REQUIRED' }; },
    }));
    check('no validator injected => unchanged behaviour (no gate, no report)', r.storyValidation === undefined && r.storyGate === undefined);
    check('no validator injected => Flow boundary still reachable', flowCalls === 1);
  }

  // =====================================================================
  // E. createProjectWorkflow — a blocked generated pipeline is not "created"
  // =====================================================================
  {
    const f = fixture('create-blocked');
    fs.rmSync(path.join(f.projectDir, 'pipeline.json'), { force: true });
    const generated = pipeline(f.projectId);
    const gen = async (input: any) => {
      fs.writeFileSync(input.pipelineFile, JSON.stringify(generated, null, 2), 'utf8');
      return { pipelineFile: input.pipelineFile };
    };
    const v = validator(validResult({ ok: false, status: 'BLOCKED', blockers: [finding('BLOCKER', 'UNKNOWN_BACKGROUND_REFERENCE', 'bad tag', 2)] }));
    const r: any = await WF.createProjectWorkflow(optsFor(f, { title: 'T', storyValidator: v.fn, pipelineGenerator: gen }));
    check('create: a blocked story is reported FAILED, not created', r.phase === 'FAILED' && r.storyGate?.code === 'STORY_BLOCKED', { phase: r.phase, gate: r.storyGate });
    check('create: the generated project files are preserved for inspection', fs.existsSync(f.projectFile));
  }
  {
    const f = fixture('create-clean');
    fs.rmSync(path.join(f.projectDir, 'pipeline.json'), { force: true });
    const generated = pipeline(f.projectId);
    const gen = async (input: any) => {
      fs.writeFileSync(input.pipelineFile, JSON.stringify(generated, null, 2), 'utf8');
      return { pipelineFile: input.pipelineFile };
    };
    const v = validator(validResult({ ok: true, status: 'PASS' }));
    const r: any = await WF.createProjectWorkflow(optsFor(f, { title: 'T', storyValidator: v.fn, pipelineGenerator: gen }));
    check('create: a clean story is not reported as blocked', r.phase !== 'FAILED' && r.storyGate?.allowed === true, { phase: r.phase, gate: r.storyGate });
    check('create: the validation report is attached', r.storyValidation?.status === 'PASS');
  }

  // =====================================================================
  // F. createRealFlowRunner — gate BEFORE the lock/subprocess
  // =====================================================================
  {
    const f = fixture('flowrunner-blocked');
    let subCalls = 0;
    const runner = FRA.createRealFlowRunner({
      productionDir: process.cwd(),
      inputsRoot: f.inputsRoot,
      outputsRoot: f.outputsRoot,
      ffprobePath: process.env.FFPROBE_PATH,
      storyValidator: validator(validResult({ ok: false, status: 'BLOCKED', blockers: [finding('BLOCKER', 'X', 'broken')] })).fn,
      runFlowSubprocess: async () => { subCalls++; return { code: 0, stdout: '', stderr: '' }; },
    });
    const r: any = await runner({
      projectId: f.projectId,
      pipelineFile: f.projectFile,
      outputDir: path.join(f.outputsRoot, f.projectId),
      inputRoot: path.join(f.inputsRoot, f.projectId),
      outputsRoot: f.outputsRoot,
      allowGeneration: true,
    });
    check('flow runner: a BLOCKER stops before the subprocess', r.ok === false && r.status === 'FAILED' && subCalls === 0, { status: r.status, subCalls });
    check('flow runner: the blocker is reported', /story-validation/.test((r.blockers ?? []).join(' ')), r.blockers);
  }
  {
    const f = fixture('flowrunner-clean');
    let subCalls = 0;
    const runner = FRA.createRealFlowRunner({
      productionDir: process.cwd(),
      inputsRoot: f.inputsRoot,
      outputsRoot: f.outputsRoot,
      ffprobePath: process.env.FFPROBE_PATH,
      storyValidator: validator(validResult()).fn,
      runFlowSubprocess: async () => { subCalls++; return { code: 0, stdout: '', stderr: '' }; },
    });
    const r: any = await runner({
      projectId: f.projectId,
      pipelineFile: f.projectFile,
      outputDir: path.join(f.outputsRoot, f.projectId),
      inputRoot: path.join(f.inputsRoot, f.projectId),
      outputsRoot: f.outputsRoot,
      allowGeneration: true,
    });
    check('flow runner: a clean report lets the subprocess run exactly once', subCalls === 1, subCalls);
    check('flow runner: success is still re-derived from evidence (not claimed blindly)', r.ok === false && r.status === 'RECOVERABLE_FAILURE', r.status);
  }
  {
    const f = fixture('flowrunner-warn');
    let subCalls = 0;
    const runner = FRA.createRealFlowRunner({
      productionDir: process.cwd(),
      inputsRoot: f.inputsRoot,
      outputsRoot: f.outputsRoot,
      ffprobePath: process.env.FFPROBE_PATH,
      blockOnStoryWarnings: true,
      storyValidator: validator(validResult({ ok: true, status: 'REVIEW', warnings: [finding('WARNING', 'W', 'meh')] })).fn,
      runFlowSubprocess: async () => { subCalls++; return { code: 0, stdout: '', stderr: '' }; },
    });
    const r: any = await runner({
      projectId: f.projectId,
      pipelineFile: f.projectFile,
      outputDir: path.join(f.outputsRoot, f.projectId),
      inputRoot: path.join(f.inputsRoot, f.projectId),
      outputsRoot: f.outputsRoot,
      allowGeneration: true,
    });
    check('flow runner: strict review stops before the subprocess', r.ok === false && subCalls === 0, { status: r.status, subCalls });
  }

  // =====================================================================
  // G. createRealSceneExecutor — per-scene defence only for the named scene
  // =====================================================================
  {
    const f = fixture('scene-gate');
    const p = JSON.parse(fs.readFileSync(f.projectFile, 'utf8'));
    const validation = validResult({
      ok: false,
      status: 'BLOCKED',
      blockers: [
        finding('BLOCKER', 'SCENE_PROBLEM', 'scene 2 is broken', 2),
        finding('BLOCKER', 'PROJECT_PROBLEM', 'project-level problem'),
      ],
    });
    const executor = SEA.createRealSceneExecutor({
      projectId: f.projectId,
      inputRoot: path.join(f.inputsRoot, f.projectId),
      outputsRoot: f.outputsRoot,
      pipeline: p,
      allowGeneration: true,
      ffprobePath: process.env.FFPROBE_PATH,
      storyValidation: validation,
    });
    const blocked: any = await executor({ sceneNumber: 2 }, path.join(f.outputsRoot, f.projectId, 'scene-0002.mp4'));
    check('scene executor: the named scene is refused before Flow/local work', blocked.ok === false && /blocked by story validation/.test(blocked.reason ?? ''), blocked);
    const unrelated: any = await executor({ sceneNumber: 1 }, path.join(f.outputsRoot, f.projectId, 'scene-0001.mp4'));
    check('scene executor: an unrelated scene is not blocked by another scene finding', !/blocked by story validation/.test(unrelated.reason ?? ''), unrelated.reason);
    check('scene executor: a project-level finding alone does not block a scene', !/PROJECT_PROBLEM/.test(unrelated.reason ?? ''), unrelated.reason);
  }

  // =====================================================================
  // H. the LEGACY `npm run flow` CLI cannot bypass validation
  // =====================================================================
  {
    // A real subprocess of src/cli.ts with a structurally broken project. The gate must stop it
    // BEFORE start() opens Chrome. Nothing here contacts the network: the process exits at the
    // audit, and the fixture is temp-only.
    const runLegacyCli = async (args: string[]) => {
      try {
        const r = await execFileAsync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
          cwd: process.cwd(),
          env: { ...process.env },
          timeout: 180_000,
          maxBuffer: 8 * 1024 * 1024,
        });
        return { code: 0, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
      } catch (error: any) {
        return { code: Number(error?.code ?? -1), stdout: String(error?.stdout ?? ''), stderr: String(error?.stderr ?? '') };
      }
    };

    const f = fixture('legacy-cli');
    const p = JSON.parse(fs.readFileSync(f.projectFile, 'utf8'));
    p.scenes[0].background_tag = '#BGD-DOES-NOT-EXIST';
    fs.writeFileSync(f.projectFile, JSON.stringify(p, null, 2), 'utf8');
    const before = sha(f.projectFile);
    const legacyOut = path.join(f.root, 'legacy-out');
    const r = await runLegacyCli(['--project', f.projectFile, '--output-dir', legacyOut]);
    const combined = `${r.stdout}\n${r.stderr}`;
    check('legacy CLI: a blocked story exits non-zero', r.code !== 0, r.code);
    check('legacy CLI: the refusal names story validation', /Story validation BLOCKED/.test(combined), combined.slice(-400));
    const logFile = path.join(legacyOut, 'run.log.jsonl');
    const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    check('legacy CLI: the refusal is logged', /story_validation_blocked/.test(logText), logText.slice(-400));
    check('legacy CLI: no Flow pass ever starts', !/pass_complete|login_required|"event":"start"/.test(logText), logText.slice(-400));
    check('legacy CLI: the project file is byte-identical', sha(f.projectFile) === before);
    check('legacy CLI: no generation state is created', !fs.existsSync(path.join(legacyOut, 'state.json')) && !fs.existsSync(path.join(legacyOut, 'generation-attempts.json')));
  }

  // =====================================================================
  // I. protected hashes: the real project is untouched by every test above
  // =====================================================================
  {
    const real = path.join(path.resolve(process.cwd(), '..'), 'scripting', 'projects', 'youtube-automation-2-20261003160855-2740', 'pipeline.json');
    if (fs.existsSync(real)) {
      const hash = sha(real);
      check('the real committed project is byte-identical (read-only guarantee)', hash.toUpperCase() === '49215CEF6882F9656AACDFB5EDAE4D87FB958CE818BE18F584043A82CB1E7773', hash);
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nPHASE 3 GATE TESTS PASSED (${passed} checks)`);
