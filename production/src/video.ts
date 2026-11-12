/**
 * `npm run video` — top-level single-command workflow (STEP-8GL, extended in 8GM).
 *
 *   npm run video -- create --title "रात के 3 बजे कुएं से आती आवाज़"
 *   npm run video -- resume --project <pipeline.json>            (zero-credit; Flow disabled)
 *   npm run video -- resume --project <pipeline.json> --run-flow (explicitly enables Flow)
 *   npm run video -- status --project <pipeline.json>
 *
 * This is the ONE orchestration authority over the existing story/Flow/production/review
 * components. It does NOT remove or replace `npm run project ...`; both remain valid.
 *
 * SAFETY: `resume` is ZERO-CREDIT by default. Flow is only invoked when the user passes
 * `--run-flow`. It NEVER opens Chrome unless Flow is explicitly requested, NEVER calls
 * OpenAI/network, NEVER approves and NEVER publishes.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createProjectWorkflow, resumeProjectWorkflow, projectWorkflowStatus, renderWorkflowReport, type WorkflowResult } from './projectWorkflow.js';
import { createPythonPipelineGenerator } from './pipelineGenerator.js';
import { createPythonSeoGenerator, type SeoResult } from './seoGenerator.js';
import { createRealFlowRunner } from './flowRunnerAdapter.js';
import { withFlowSession } from './flowSession.js';
import { resolveOnlyArg } from './sceneScope.js';
import { createRealSceneExecutor } from './sceneExecutorAdapter.js';
import { approveProject, publishReadiness, loadApproval } from './approval.js';
import { publishReadinessDetailed, reconcileApprovalReview, syncReviewFromApproval } from './approvalReview.js';
import { getProjectHealth, renderHealthReport } from './projectHealth.js';
import { planIsolatedSceneMix, runIsolatedSceneMix, parseMaxStretchOverride } from './isolatedSceneMix.js';
import { MAX_NARRATION_VIDEO_STRETCH } from './narrationDurationPolicy.js';
import { runMediaQa, renderMediaQaReport } from './mediaQa.js';
import { runProjectMediaQa, renderProjectQaReport } from './projectMediaQa.js';
import { evaluateOutputContract, renderOutputContractReport } from './outputContract.js';
import { generationLedgerPath, readGenerationLedger, renderGenerationHistory } from './generationAttempts.js';
import { createPythonStoryValidator, renderStoryReport, type StoryValidationResult } from './storyValidation.js';
import { planShorts, renderShorts, shortsStatus, qaShorts, approveShort, renderShortsStatus, renderShortsRenderReport } from './shortsWorkflow.js';
import { refreshNarrationAssets, narrationStatus, qaNarrationAssets, approveNarrationAssets, renderNarrationStatus } from './narrationAssetWorkflow.js';
import { renderNarrationQaReport } from './narrationQa.js';
import { planThumbnail, renderThumbnailArtifact, qaThumbnailArtifact, approveThumbnailArtifact, thumbnailStatus, renderThumbnailStatus } from './thumbnailWorkflow.js';
import { renderThumbnailQaReport } from './thumbnailQa.js';

function arg(name: string, fallback?: string): string | undefined { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; }
function jsonFlag(): boolean { return process.argv.includes('--json'); }
function hasFlag(name: string): boolean { return process.argv.includes(name); }

const REPO_ROOT = path.resolve(process.cwd(), '..');
const PRODUCTION_DIR = process.cwd();
const PROJECTS_ROOT = process.env.PROJECTS_ROOT ?? path.join(REPO_ROOT, 'scripting', 'projects');
const INPUTS_ROOT = process.env.INPUTS_ROOT ?? path.join(process.cwd(), 'inputs');
const OUTPUTS_ROOT = process.env.OUTPUTS_ROOT ?? path.join(process.cwd(), 'outputs');

function baseOptions() {
  return {
    projectsRoot: PROJECTS_ROOT,
    inputsRoot: INPUTS_ROOT,
    outputsRoot: OUTPUTS_ROOT,
    ffprobePath: process.env.FFPROBE_PATH,
    ffmpegPath: process.env.FFMPEG_PATH,
    productionDir: PRODUCTION_DIR,
    logRetention: process.env.LOG_RETENTION ? Number(process.env.LOG_RETENTION) : undefined,
    logMaxBytes: process.env.LOG_MAX_BYTES ? Number(process.env.LOG_MAX_BYTES) : undefined,
    pipelineGenerator: createPythonPipelineGenerator({ repoRoot: REPO_ROOT }),
  };
}

/** The production Flow boundary (only wired, only invoked when --run-flow is passed). */
function flowOptions() {
  return {
    flowRunner: createRealFlowRunner({
      productionDir: PRODUCTION_DIR,
      inputsRoot: INPUTS_ROOT,
      outputsRoot: OUTPUTS_ROOT,
      ffprobePath: process.env.FFPROBE_PATH,
      // PHASE 3: the CLI-subprocess Flow path is gated BEFORE the lock/subprocess, so a broken
      // story can never reach a paid Flow submission through either Flow strategy.
      storyValidator: createPythonStoryValidator({ repoRoot: REPO_ROOT }),
      blockOnStoryWarnings: hasFlag('--story-warnings-block'),
    }),
  };
}

/**
 * The interactive Flow session boundary (STEP-8GO). Opt-in via `--flow-session`; it owns the
 * browser/client lifecycle and holds the single Flow session lock. Wired ONLY when explicitly
 * requested, so the default `--run-flow` CLI path is unchanged.
 */
function flowSessionOptions() {
  const profile = process.env.FLOW_USER_DATA_DIR ?? path.join(PRODUCTION_DIR, 'chrome-profile');
  return {
    flowSessionRunner: <T>(fn: (s: { client: any; close(): Promise<void> }) => Promise<T>) =>
      withFlowSession({ lockRoot: PRODUCTION_DIR, userDataDir: profile, url: process.env.FLOW_URL }, fn),
  };
}

/**
 * Production SceneExecutor boundary (STEP-8GS). Wired whenever scoped execution is requested so
 * `video resume --only N` actually executes scenes through the existing `processSingleFlowScene`.
 * No Flow client is required: a locally-valid scene resolves to USE_LOCAL inside the workflow.
 */
/**
 * PHASE 3 story/scene intelligence boundary. Read-only: it shells out to the existing
 * `python -m pipeline.one_minute --check` CLI and never writes, never spends credits.
 * `--story-warnings-block` makes a human-review WARNING stop PAID generation too.
 */
function storyValidationOptions() {
  return {
    storyValidator: createPythonStoryValidator({ repoRoot: REPO_ROOT }),
    blockOnStoryWarnings: hasFlag('--story-warnings-block'),
  };
}

function sceneExecutorOptions() {
  return {
    sceneExecutorFactory: (input: any) => createRealSceneExecutor({
      projectId: input.projectId,
      inputRoot: input.inputRoot,
      outputsRoot: input.outputsRoot ?? OUTPUTS_ROOT,
      pipeline: input.pipeline,
      allowGeneration: input.allowGeneration === true,
      ffprobePath: input.ffprobePath ?? process.env.FFPROBE_PATH,
      flow: input.flow,
      sceneLocalAuthorization: input.sceneLocalAuthorization ?? null,
      storyValidation: input.storyValidation,
      blockOnStoryWarnings: input.blockOnStoryWarnings === true,
    }),
  };
}

/** project id from a `--project <pipeline.json>` path (canonical layout: parent dir name). */
function projectIdFromProjectArg(): string | undefined {
  const p = arg('--project');
  if (!p) return undefined;
  return path.basename(path.dirname(path.resolve(String(p))));
}

/**
 * SEO boundary (opt-in only). Wraps the Python SEO engine; it has no publishing path, so
 * wiring it here can never reach Zernio, YouTube, R2 or presign code.
 */
function seoOptions() {
  return { repoRoot: REPO_ROOT, projectsRoot: PROJECTS_ROOT };
}

/**
 * PHASE 4 media QA boundary for approvals (READ-ONLY). Runs the project QA composition against
 * the exact artifact being approved; it never writes media, state or approval records.
 */
function mediaQaBoundary() {
  return async (args: {
    projectId: string;
    outputsDir: string;
    inputRoot: string;
    pipeline: any;
    finalPath: string;
    ffprobePath?: string;
    ffmpegPath?: string;
    now?: string;
  }) => runProjectMediaQa({
    projectId: args.projectId,
    pipeline: args.pipeline,
    outputsDir: args.outputsDir,
    inputRoot: args.inputRoot,
    finalPath: args.finalPath,
    ffmpegPath: args.ffmpegPath ?? process.env.FFMPEG_PATH,
    ffprobePath: args.ffprobePath ?? process.env.FFPROBE_PATH,
    now: args.now,
  });
}

/** Human-readable SEO summary (the JSON form is the parsed CLI report). */
function renderSeoSummary(r: SeoResult): string {
  const lines: string[] = [];
  if (!r.ok) {
    lines.push(`seo:            ${r.status} (exit ${r.exitCode})`);
    if (r.reason) lines.push(`reason:         ${r.reason}`);
    for (const error of r.errors.slice(0, 10)) lines.push(`  - ${error}`);
    return lines.join('\n');
  }
  if (r.status === 'EXTRACT_ONLY') {
    const facts = (r.report?.facts ?? {}) as any;
    const plan = (r.report?.keyword_plan ?? {}) as any;
    lines.push('seo:            EXTRACT_ONLY (no model call, nothing written)');
    lines.push(`project:        ${r.projectId ?? ''}`);
    lines.push(`scenes:         ${facts.scene_count ?? '?'}   acts: ${(facts.acts ?? []).length}`);
    lines.push(`story anchors:  ${(facts.story_anchors ?? []).join(' | ')}`);
    lines.push(`primary:        ${(plan.primary ?? []).slice(0, 5).map((k: any) => k.term).join(' | ')}`);
    return lines.join('\n');
  }
  if (r.status === 'METADATA_APPROVED') {
    lines.push('seo:            METADATA_APPROVED');
    lines.push(`metadata:       ${r.metadataPath ?? ''}`);
    lines.push('note:           approval is recorded locally; nothing was uploaded or published.');
    return lines.join('\n');
  }
  lines.push(`seo:            ${r.status}${r.generation ? ` (generation ${r.generation})` : ''}`);
  if (r.recommendedTitle) lines.push(`title:          ${r.recommendedTitle}`);
  for (const candidate of (r.titleCandidates ?? []).slice(1)) lines.push(`candidate:      ${candidate}`);
  if (r.packagePath) lines.push(`package:        ${r.packagePath}`);
  if (r.markdownPath) lines.push(`review doc:     ${r.markdownPath}`);
  if (r.metadataPath) lines.push(`metadata:       ${r.metadataPath} (not approved yet)`);
  if (typeof r.attempts === 'number') lines.push(`attempts:       ${r.attempts}`);
  for (const warning of r.warnings.slice(0, 10)) lines.push(`warning:        ${warning}`);
  lines.push('note:           nothing was uploaded or published. Review the package before approving it.');
  return lines.join('\n');
}

/**
 * STEP-8HF: canonical options for `resume`. Ordinary resume ALWAYS wires the real scene/stage
 * executors (so it is the single resumable execution path), the FlowRunner boundary (used only
 * when `--run-flow` without a session), and the interactive Flow session ONLY when explicitly
 * requested. Flow work itself remains gated by `runFlow` + eligibility inside the workflow.
 */
export function buildResumeOptions(runFlow: boolean, includeSession: boolean, only?: number[], preflight = false) {
  const sessionOpts = runFlow && includeSession ? flowSessionOptions() : {};
  return {
    ...baseOptions(),
    ...flowOptions(),
    ...sessionOpts,
    ...sceneExecutorOptions(),
    ...storyValidationOptions(),
    only,
    runFlow,
    preflight,
  };
}

/** Workflow exit code used by every workflow-emitting command. */
function workflowExitCode(r: WorkflowResult): number {
  if (r.status === 'WAITING_FOR_INPUTS' || r.status === 'COMPLETED_TO_APPROVAL' || r.status === 'SCENE_SCOPE_COMPLETED' || r.status === 'FLOW_WORK_COMPLETED_WITH_BLOCKERS' || r.phase === 'CREATED') return 0;
  return 1;
}

function emit(r: WorkflowResult): number {
  if (jsonFlag()) { console.log(JSON.stringify(r, null, 2)); }
  else console.log(renderWorkflowReport(r));
  return workflowExitCode(r);
}

/**
 * Usage text. Printed on stdout for an explicit `help`/`--help` (exit 0) and on stderr for an
 * unrecognised command (exit 2), so `--help` is always a safe, side-effect-free smoke check.
 */
export function renderUsage(): string {
  return [
    'Usage: npm run video -- <create|resume|status|validate|approve|publish-status|health|seo|qa|contract|shorts|narration|thumbnail|mix-validate|flow-attempts>',
    '  [--title ...] [--project <pipeline.json>] [--only 1,2,3] [--run-flow] [--flow-session] [--preflight] [--yes] [--json]',
    '  create: [--seo]   # opt-in: also generate the reviewable SEO package for the new story',
    '  resume: [--preflight]  # opt-in resource preflight (ffmpeg/ffprobe, outputs dir, free disk);',
    '       # a real blocker fails closed before the lock is taken. Status/dry inspection never',
    '       # probes or creates anything.',
    '  validate: --project <pipeline.json> | --project-id <id> [--json] [--strict]',
    '       # READ-ONLY story & scene intelligence: structural BLOCKERs, human-review WARNINGs and',
    '       # INFO context. It writes nothing, calls no model and spends no credits. Exit 0 = no',
    '       # blockers, 1 = blocked (or warnings with --strict), 2 = usage.',
    '  resume|create: [--story-warnings-block]',
    '       # Treat validation WARNINGs as blocking for PAID generation (--run-flow). Default:',
    '       # blockers stop generation; warnings are reported and reviewed by a human.',
    '  approve: [--candidate <path inside project outputs> --sha256 <expected SHA-256>]',
    '       [--qa-warnings-block]',
    '       # Media QA runs read-only against the exact artifact being approved; any blocker',
    '       # refuses approval. Warnings are recorded for the reviewer and block only with',
    '       # --qa-warnings-block. No path can auto-approve or publish.',
    '  flow-attempts: --project-id <id> | --project <pipeline.json> [--limit N] [--json]',
    '       # READ-ONLY: per-scene/asset attempt budget, failure category, submission state,',
    '       # manual-approval state and the recent attempt history from',
    '       # <outputsRoot>/<projectId>/flow-scenes/generation-attempts.json.',
    '  resume|create: [--approve-generation-recovery --yes]',
    '       [--approve-generation-recovery-scenes 3,7]',
    '       # Grants ONE extra attempt that the bounded budget/ambiguity gate refused.',
    '       # It never raises a ceiling; raise FLOW_MAX_ATTEMPTS_PER_SCENE deliberately.',
    '  seo: --project <pipeline.json> | --project-id <id>',
    '       [--regenerate] [--extract-only] [--max-attempts 1..5] [--model <name>]',
    '       [--approve-metadata --yes --by <name>]',
    '       # writes <project>/seo/ only; never uploads, never calls Zernio/YouTube/R2.',
    '  qa: --input <media file> [--json]',
    '      [--target-lufs -14] [--loudness-tolerance 3] [--min-height 720] [--target-height 1080]',
    '      [--expect-duration <s>] [--duration-tolerance 2] [--black-min 0.5] [--freeze-min 3]',
    '      [--skip-black] [--skip-freeze] [--skip-audio]',
    '      # READ-ONLY: black/freeze frames, 16:9 + resolution, frame rate, container,',
    '      # stream presence, audio duration/sync, clipping, loudness, silence.',
    '      # Never renders, writes, uploads or publishes; exit 1 only for hard FAIL findings.',
    '  qa: --project <pipeline.json> | --project-id <id> [--json]',
    '      [--final <artifact>] [--skip-scenes] [--skip-narration] [--skip-final]',
    '      [--expect-duration <s>] [--duration-tolerance 2] [--min-height 720] [--target-height 720]',
    '      [--skip-black] [--skip-freeze]',
    '      # READ-ONLY project QA: per-scene clips + render-sidecar provenance, narration audio',
    '      # and the final TITLE artifact, with an artifact hash bound to the exact bytes.',
    '      # Exit 0 = PASS/WARNING (warnings printed), 1 = FAIL, 2 = usage.',
    '  contract: --project <pipeline.json> | --project-id <id> [--json]',
    '      [--final <artifact>] [--sha256 <expected SHA-256>] [--qa-warnings-block]',
    '      [--expect-duration <s>] [--duration-tolerance 2] [--min-height 720] [--target-height 720]',
    '      # READ-ONLY long-form output contract: duration tolerance, streams, 16:9/resolution, fps,',
    '      # A/V sync, scene order, narration coverage, TITLE/branding, QA hash binding and the human',
    '      # approval verdict, as ONE mapped report. Rendering success never makes it publishable:',
    '      # publishable requires a QA-clean artifact + explicit hash-bound approval. It never',
    '      # approves, uploads or publishes. Exit 0 = PASS/WARNING, 1 = FAIL, 2 = usage.',
    '  shorts <plan|render|status|qa|approve> --project <pipeline.json> | --project-id <id>',
    '      [--short short-01] [--count 2|3] [--yes] [--by <name>] [--sha256 <hash>]',
    '      [--qa-warnings-block] [--json]',
    '      # PHASE 6: derive 2–3 standalone 1080×1920 vertical Shorts from the SAME story. Clips are',
    '      # REUSED from existing scene outputs (no Flow run, no credits), reframed with recorded',
    '      # crop/blur metadata, captioned in Devanagari and QA-ed with the Phase 4 media engine.',
    '      # Everything is written under outputs/<id>/shorts/; the long-form artifacts and approval',
    '      # record are never touched. approve requires --yes and a QA-clean artifact; each Short is',
    '      # approved independently and nothing is ever uploaded or published. Exit 0 = ok, 1 = fail.',
    '  narration <refresh|status|qa|approve> --project <pipeline.json> | --project-id <id>',
    '      [--yes] [--by <name>] [--qa-warnings-block] [--pronunciation <file>] [--json]',
    '      # PHASE 7: the Hindi narration INVENTORY. Reads inputs/<id>/narration/, measures the real',
    '      # duration with ffprobe, records container/codec/sample-rate/channels, bytes SHA-256, the',
    '      # script text hash, the voice/pronunciation config hash and provenance. States are explicit:',
    '      # ready / missing / empty / corrupt / format_invalid / stale. It never generates audio, never',
    '      # calls a provider and never rewrites an operator audio file. Outputs',
    '      # outputs/<id>/narration/{narration-ledger,narration-qa,narration-approval}.json.',
    '      # approve requires --yes and a QA result bound to these exact bytes.',
    '  thumbnail <plan|render|status|qa|approve> [--short <short-id>]',
    '      --project <pipeline.json> | --project-id <id> [--headline <text>] [--subhead <text>]',
    '      [--kicker <text>] [--scene N] [--designed-card] [--yes] [--by <name>] [--sha256 <hash>]',
    '      [--qa-warnings-block] [--json]',
    '      # PHASE 7: deterministic thumbnails. Without --short: the long-form 1280×720 16:9 thumbnail',
    '      # under outputs/<id>/thumbnail/. With --short: that Short gets its own 1080×1920 9:16 cover',
    '      # at outputs/<id>/shorts/<shortId>/cover/. A still is taken from an already-rendered scene clip',
    '      # (or a deterministic card when none exists), Devanagari type is drawn with libass and the',
    '      # channel logo is overlaid at the permanent lower-right position. No image-generation API is',
    '      # ever called. QA measures the rendered ink box, verifies branding pixels and re-renders to',
    '      # prove the recorded render key. approve requires --yes and a QA-clean artifact.',
    '  mix-validate: [--scene N] --input-root <production/inputs/<projectId>> --validation-root <isolated dir>',
    '                 [--output <file>] [--force] [--max-stretch <x>]',
    '                 # renders ONE scene; never runs EDIT/MIX-stage/BED/TITLE/APPROVAL,',
    '                 # never writes production scene outputs or final-assembly media.',
    '                 # --max-stretch raises the ELIGIBILITY CEILING for this isolated run only.',
    '                 # Omitted, it stays at the 2.0x policy limit; hard ceiling is 3.0x.',
    '                 # It never changes the computed duration, the graph, or production behaviour.',
    '  help: print this text and exit 0 (no files read, no network, no Flow).',
    '',
    'Runtime directories (defaults, all overridable):',
    '  projects  scripting/projects              PROJECTS_ROOT',
    '  inputs    production/inputs               INPUTS_ROOT   (create it yourself; never auto-created)',
    '  outputs   production/outputs              OUTPUTS_ROOT  (created on demand by production stages)',
  ].join('\n');
}

async function main(): Promise<number> {
  const command = String(process.argv[2] ?? '').trim();

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(renderUsage());
    return 0;
  }

  // EXPLICIT recovery approval. It is opt-in per invocation, requires --yes, and only ever grants
  // ONE extra attempt that the bounded budget/ambiguity gate refused — never a raised ceiling.
  if (hasFlag('--approve-generation-recovery-scenes') && !hasFlag('--approve-generation-recovery')) {
    console.error('--approve-generation-recovery-scenes requires --approve-generation-recovery (and --yes).');
    return 2;
  }
  if (hasFlag('--approve-generation-recovery')) {
    if (!hasFlag('--yes')) {
      console.error('--approve-generation-recovery requires explicit --yes (it authorises a paid Flow recovery attempt).');
      console.error('Inspect the attempt history first: npm run video -- flow-attempts --project-id <id>');
      return 2;
    }
    const scenes = String(arg('--approve-generation-recovery-scenes') ?? '').trim();
    if (scenes) process.env.FLOW_APPROVE_GENERATION_RECOVERY_SCENES = scenes;
    else process.env.FLOW_APPROVE_GENERATION_RECOVERY = '1';
    console.error('generation recovery approval granted for this invocation only.');
  }

  if (command === 'flow-attempts') {
    const projectId = arg('--project-id') ?? projectIdFromProjectArg();
    if (!projectId) { console.error('video flow-attempts requires --project-id <id> or --project <pipeline.json>.'); return 2; }
    const ledgerFile = generationLedgerPath({ projectId, outputsRoot: OUTPUTS_ROOT });
    const read = await readGenerationLedger(ledgerFile, { projectId });
    if (!read.ok) {
      // READ-ONLY and fail-closed: an unreadable ledger is never silently reset here.
      console.error(`video flow-attempts: the ledger at ${ledgerFile} is unreadable (${read.reason}).`);
      console.error('Nothing was changed. Inspect the file; to operate under explicit approval run a real command with --approve-generation-recovery --yes, which quarantines the corrupt file first.');
      return 1;
    }
    if (!read.exists || !read.ledger) {
      if (jsonFlag()) console.log(JSON.stringify({ projectId, ledgerFile, exists: false, ledger: null }, null, 2));
      else console.log(`no generation attempts recorded for ${projectId}\n  ledger: ${ledgerFile}`);
      return 0;
    }
    const limitRaw = Number(arg('--limit') ?? 20);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 20;
    if (jsonFlag()) console.log(JSON.stringify({ projectId, ledgerFile, exists: true, ledger: read.ledger }, null, 2));
    else console.log(renderGenerationHistory(read.ledger, { limit }));
    return 0;
  }

  if (command === 'validate') {
    // PHASE 3 READ-ONLY story & scene audit. Delegates to the ONE canonical validator
    // (`python -m pipeline.one_minute --check`); this command has no write path at all.
    const projectArg = arg('--project');
    const projectIdArg = arg('--project-id');
    if (!projectArg && !projectIdArg) {
      console.error('video validate requires --project <pipeline.json> or --project-id <id>.');
      return 2;
    }
    const projectFile = projectArg
      ? path.resolve(String(projectArg))
      : path.join(PROJECTS_ROOT, String(projectIdArg), 'pipeline.json');
    const result = await createPythonStoryValidator({ repoRoot: REPO_ROOT })({ projectFile, strict: hasFlag('--strict') });
    if (jsonFlag()) {
      console.log(JSON.stringify(result.report ?? {
        ok: false, status: result.status, read_only: true, project_file: result.projectFile,
        project_id: result.projectId, reason: result.reason ?? 'the validator produced no report',
      }, null, 2));
    } else if (result.report) {
      console.log(renderStoryReport(result.report));
    } else {
      console.error(`video validate: ${result.reason ?? 'the validator produced no report'}`);
    }
    if (!result.available || result.blockers.length) return 1;
    return hasFlag('--strict') && result.warnings.length ? 1 : 0;
  }

  if (command === 'create') {
    const title = arg('--title');
    if (!title) { console.error('video create requires --title "<story title>".'); return 2; }
    const r = await createProjectWorkflow({
      ...baseOptions(),
      ...storyValidationOptions(),
      title,
      concept: arg('--concept'),
      durationMinutes: arg('--duration') ? Number(arg('--duration')) : undefined,
      scenes: arg('--scenes') ? Number(arg('--scenes')) : undefined,
      model: arg('--model'),
    });
    // OPT-IN SEO stage. Omitted by default so the canonical create path is unchanged and never
    // spends an extra model call. It only reads the generated story and writes <project>/seo/.
    if (hasFlag('--seo')) {
      if (r.phase !== 'CREATED') {
        console.error(`video create --seo skipped: the story pipeline did not reach CREATED (phase ${r.phase}).`);
        return emit(r);
      }
      const seoResult = await createPythonSeoGenerator(seoOptions())({ projectFile: r.projectPath });
      if (jsonFlag()) console.log(JSON.stringify({ ...r, seo: seoResult }, null, 2));
      else {
        console.log(renderWorkflowReport(r));
        console.log('');
        console.log(renderSeoSummary(seoResult));
        if (!seoResult.ok) console.error(`seo: FAILED (${seoResult.reason ?? 'unknown'}); the story pipeline itself was created.`);
      }
      return workflowExitCode(r);
    }
    return emit(r);
  }

  if (command === 'resume' || command === 'status') {
    const projectId = projectIdFromProjectArg();
    if (!projectId) { console.error(`video ${command} requires --project <pipeline.json>.`); return 2; }
    if (command === 'status') {
      // status is strictly read-only: no Flow boundary is ever wired here.
      const r = await projectWorkflowStatus({ ...baseOptions(), projectId });
      return emit(r);
    }
    // resume: the canonical resumable execution path. Scene + stage executors are always wired
    // (real ones), so ordinary `resume` actually executes required local work. Flow is invoked
    // only when explicitly requested: `--run-flow` (legacy CLI boundary) or
    // `--run-flow --flow-session` (modern session + SceneExecutor). `--only` scopes execution.
    const runFlow = hasFlag('--run-flow');
    const onlyResolved = resolveOnlyArg(arg('--only'));
    if (!onlyResolved.ok) { console.error(`video resume: ${onlyResolved.reason}`); return 2; }
    const r = await resumeProjectWorkflow({ ...buildResumeOptions(runFlow, hasFlag('--flow-session'), onlyResolved.only, hasFlag('--preflight')), projectId });
    return emit(r);
  }

  if (command === 'health') {
    const projectId = projectIdFromProjectArg();
    if (!projectId) { console.error('video health requires --project <pipeline.json>.'); return 2; }
    const projectFile = path.resolve(String(arg('--project')));
    const report = await getProjectHealth({ projectFile, inputsRoot: INPUTS_ROOT, outputsRoot: OUTPUTS_ROOT, ffprobePath: process.env.FFPROBE_PATH });
    if (jsonFlag()) console.log(JSON.stringify(report, null, 2));
    else console.log(renderHealthReport(report));
    return 0; // health is a read-only report; it never fails the process
  }

  if (command === 'approve' || command === 'publish-status') {
    const projectId = projectIdFromProjectArg();
    if (!projectId) { console.error(`video ${command} requires --project <pipeline.json>.`); return 2; }
    const pipelineFile = path.resolve(String(arg('--project')));
    const pipeline = JSON.parse(await (await import('node:fs/promises')).readFile(pipelineFile, 'utf8'));
    const outputsDir = path.join(OUTPUTS_ROOT, projectId);
    const base = { projectId, outputsRoot: OUTPUTS_ROOT, outputsDir, inputRoot: path.join(INPUTS_ROOT, projectId), pipeline, ffprobePath: process.env.FFPROBE_PATH };

    if (command === 'approve') {
      // Explicit, deliberate approval. `resume`/`status` NEVER reach this code path.
      if (!hasFlag('--yes')) { console.error('video approve requires explicit --yes to confirm human approval (no auto-approval).'); return 2; }
      const candidatePath = arg('--candidate');
      const expectedHash = arg('--sha256');
      if (candidatePath && !expectedHash) { console.error('video approve --candidate requires --sha256 <expected candidate SHA-256>.'); return 2; }
      if (expectedHash && !/^[0-9a-f]{64}$/i.test(expectedHash)) { console.error('video approve --sha256 must be a 64-character SHA-256 hex digest.'); return 2; }
      const r = await approveProject({
        ...base,
        candidatePath,
        expectedHash,
        // PHASE 4: media QA must not FAIL before an approval can be recorded. Warnings stay
        // visible in the record; they block only when the reviewer opts in.
        mediaQa: mediaQaBoundary(),
        blockOnMediaQaWarnings: hasFlag('--qa-warnings-block'),
      });
      // Opt-in (never automatic) bridge: mirror a VALID integrity approval into an existing
      // `awaiting_approval` review record. Does not create review records, does not overwrite
      // posted/rejected history, and never bypasses integrity approval.
      if (r.ok && hasFlag('--sync-review')) {
        await syncReviewFromApproval({ ...base, projectFile: pipelineFile }).catch(() => {});
      }
      if (jsonFlag()) console.log(JSON.stringify(r, null, 2));
      else if (r.ok) console.log(`approval: ${r.record.status}${r.idempotent ? ' (idempotent)' : ''}\nkind:     ${r.record.approved_artifact_kind ?? 'canonical'}\nfinal:    ${r.record.approved_final_output_path}\nhash:     ${r.record.approved_final_output_hash}\nstageKey: ${r.record.approved_final_stage_key}`);
      else console.error(`APPROVAL REFUSED: ${r.reason}`);
      return r.ok ? 0 : 1;
    }

    // publish-status: read-only reconciliation of integrity approval vs legacy review; NEVER
    // publishes, never writes, never calls the network.
    const readiness = await publishReadinessDetailed({ ...base, projectFile: pipelineFile });
    if (jsonFlag()) console.log(JSON.stringify(readiness, null, 2));
    else {
      console.log(`publish readiness: ${readiness.readiness}`);
      console.log(`integrity: ${readiness.reconciliation.integrity}`);
      console.log(`review:    ${readiness.reconciliation.review}`);
      console.log(`publishable: ${readiness.publishable}`);
      if ('reason' in readiness) console.log(`reason:    ${readiness.reason}`);
    }
    return readiness.publishable ? 0 : 1;
  }

  if (command === 'seo') {
    // SEO PACKAGE generation for an EXISTING project (reusable; never regenerates the story).
    // It reads `pipeline.json` read-only and writes only <project dir>/seo/. It NEVER uploads,
    // never presigns, never calls Zernio/YouTube, and never approves or publishes metadata.
    const projectArg = arg('--project');
    const projectIdArg = arg('--project-id');
    if (!projectArg && !projectIdArg) {
      console.error('video seo requires --project <pipeline.json> or --project-id <id>.');
      return 2;
    }
    const approveMetadata = hasFlag('--approve-metadata');
    const approvedBy = arg('--by');
    if (approveMetadata && (!hasFlag('--yes') || !approvedBy)) {
      console.error('video seo --approve-metadata requires explicit --yes and --by "<your name>".');
      console.error('This records human approval of seo/youtube-metadata.json only; it never publishes.');
      return 2;
    }
    let maxAttempts: number | undefined;
    if (arg('--max-attempts') !== undefined) {
      const value = Number(arg('--max-attempts'));
      if (!Number.isInteger(value) || value < 1 || value > 5) {
        console.error('video seo --max-attempts must be an integer between 1 and 5.');
        return 2;
      }
      maxAttempts = value;
    }
    const runSeo = createPythonSeoGenerator(seoOptions());
    let result: SeoResult;
    try {
      result = await runSeo({
        projectFile: projectArg,
        projectId: projectIdArg,
        regenerate: hasFlag('--regenerate'),
        extractOnly: hasFlag('--extract-only'),
        approveMetadata,
        approvedBy,
        maxAttempts,
        model: arg('--model'),
      });
    } catch (error) {
      console.error(`video seo: ${String((error as any)?.message ?? error)}`);
      return 2;
    }
    if (jsonFlag()) console.log(JSON.stringify(result, null, 2));
    else if (result.ok) console.log(renderSeoSummary(result));
    else { console.error(renderSeoSummary(result)); }
    // The Python exit code is authoritative: 0 ok, 1 failure, 2 usage, 3 refused (exists).
    return result.exitCode;
  }

  if (command === 'mix-validate') {
    // ISOLATED scene MIX validation. Renders exactly ONE scene to prove the narration-preservation
    // `setpts` stretch actually materialises. It deliberately does NOT touch the project-wide
    // downstream chain: it never invokes `resume`, EDIT, MIX-as-a-stage, BED, TITLE, APPROVAL or
    // publishing, and it never opens a browser or spends a Flow credit.
    //
    // Isolation is enforced by `planIsolatedSceneMix()`: exactly one derived scene clip and one
    // derived narration file (never a directory scan), read-only sources, a refused-overwrite
    // output, and an output that must live under `--validation-root` and may never be a production
    // `scene-####.mp4` or a final-assembly artefact (`final-narrated`/`final-bedded`/`final-title`).
    const sceneNumber = Number(arg('--scene'));
    const inputRoot = String(arg('--input-root') ?? '');
    const validationRoot = String(arg('--validation-root') ?? '');
    if (!inputRoot || !validationRoot) {
      console.error('video mix-validate requires --input-root <production/inputs/<projectId>> and --validation-root <isolated output dir>.');
      console.error('It writes ONLY <validation-root>/scene-<NNNN>-mixed.mp4 and never touches production or final-assembly media.');
      return 2;
    }
    // `--max-stretch` raises the ELIGIBILITY CEILING for this isolated run only. Omitted, it stays at
    // the production 2.0 limit, so Scene 2 (2.42125x) is still rejected unless a caller asks for a
    // higher ceiling explicitly. It never changes the duration the policy computes, the graph, or
    // any production behaviour — see parseMaxStretchOverride().
    const rawMaxStretch = arg('--max-stretch');
    const ceiling = parseMaxStretchOverride(rawMaxStretch);
    if (!ceiling.ok) {
      console.error(`mix-validate: MAX_STRETCH_INVALID: ${ceiling.reason}`);
      return 2;
    }
    if (ceiling.source === 'override') {
      console.log(`max-stretch:      ${ceiling.maxStretch}x (explicit override of the ${MAX_NARRATION_VIDEO_STRETCH}x policy, isolated run only)`);
    }
    const plan = await planIsolatedSceneMix({
      sceneNumber, inputRoot, validationRoot,
      outputPath: arg('--output'), force: hasFlag('--force'),
      maxStretch: ceiling.maxStretch,
    });
    if (!plan.ok) {
      console.error(`mix-validate: ${plan.code}: ${plan.reason}`);
      return 1;
    }
    console.log(`scene:            ${plan.sceneNumber}`);
    console.log(`video input:      ${plan.videoInput}  (${plan.sourceVideoDuration}s, read-only)`);
    console.log(`narration input:  ${plan.narrationInput}  (${plan.narrationDuration}s, read-only)`);
    console.log(`policy:           ${plan.policy}  tail=${plan.narrationTailSeconds}s maxStretch=${plan.maxStretch}x`);
    console.log(`target duration:  ${plan.outputDuration}s  stretch=${plan.stretchFactor}x  pictureSlowdown=${plan.pictureSlowdownRequired}`);
    console.log(`isolated output:  ${plan.outputPath}`);
    const rendered = await runIsolatedSceneMix(plan);
    if (!rendered.ok) {
      console.error(`mix-validate: ${rendered.code}: ${rendered.reason}`);
      return 1;
    }
    console.log(`rendered:         ${rendered.bytes} bytes`);
    console.log(`video stream:     ${rendered.videoCodec} ${rendered.width}x${rendered.height}  ${rendered.videoDurationSeconds}s`);
    console.log(`audio stream:     ${rendered.audioCodec}  ${rendered.audioDurationSeconds}s`);
    console.log(`container:        ${rendered.durationSeconds}s  (expected ${rendered.expectedDuration}s)`);
    console.log('note:             this is an ISOLATED validation render. No EDIT/BED/TITLE/APPROVAL ran and no production or final-assembly media was written.');
    return 0;
  }

  if (command === 'qa') {
    // READ-ONLY automated media QA probe (black/freeze frames, aspect/resolution, clipping,
    // loudness). It never renders, never writes, never opens a browser and never touches
    // Flow/Zernio/YouTube. Findings are advisory except for hard failures (exit 1).
    const numeric = (name: string): number | undefined => {
      const raw = arg(name);
      if (raw === undefined) return undefined;
      const value = Number(raw);
      return Number.isFinite(value) ? value : NaN;
    };
    const numericArgs = ['--target-lufs', '--loudness-tolerance', '--min-height', '--target-height', '--expect-duration', '--duration-tolerance', '--black-min', '--freeze-min'] as const;
    const parsed: Record<string, number | undefined> = {};
    for (const name of numericArgs) {
      const value = numeric(name);
      if (typeof value === 'number' && Number.isNaN(value)) {
        console.error(`video qa: ${name} must be a number, got "${arg(name)}".`);
        return 2;
      }
      parsed[name] = value;
    }

    const projectArg = arg('--project');
    const projectIdArg = arg('--project-id');
    if (projectArg || projectIdArg) {
      // PHASE 4 project QA: scenes + narration + final roll-up. Still READ-ONLY.
      const projectId = projectArg ? path.basename(path.dirname(path.resolve(String(projectArg)))) : String(projectIdArg ?? '').trim();
      if (!projectId || !/^[A-Za-z0-9._-]+$/.test(projectId)) {
        console.error('video qa: --project-id must be a safe project id.');
        return 2;
      }
      const pipelineFile = projectArg ? path.resolve(String(projectArg)) : path.join(PROJECTS_ROOT, projectId, 'pipeline.json');
      let pipeline: any;
      try {
        const fsp = await import('node:fs/promises');
        pipeline = JSON.parse(await fsp.readFile(pipelineFile, 'utf8'));
      } catch (e: any) {
        console.error(`video qa: could not read pipeline ${pipelineFile}: ${String(e?.message ?? e).slice(0, 160)}`);
        return 2;
      }
      const finalArg = arg('--final');
      const report = await runProjectMediaQa({
        projectId,
        pipeline,
        outputsDir: path.join(OUTPUTS_ROOT, projectId),
        inputRoot: path.join(INPUTS_ROOT, projectId),
        finalPath: finalArg ? path.resolve(String(finalArg)) : undefined,
        ffmpegPath: process.env.FFMPEG_PATH,
        ffprobePath: process.env.FFPROBE_PATH,
        minHeight: parsed['--min-height'],
        targetHeight: parsed['--target-height'],
        expectedFinalDurationSeconds: parsed['--expect-duration'],
        finalDurationToleranceSeconds: parsed['--duration-tolerance'],
        sceneDurationToleranceSeconds: parsed['--duration-tolerance'],
        skipScenes: hasFlag('--skip-scenes'),
        skipNarration: hasFlag('--skip-narration'),
        skipFinal: hasFlag('--skip-final'),
        skipBlack: hasFlag('--skip-black'),
        skipFreeze: hasFlag('--skip-freeze'),
      });
      if (jsonFlag()) console.log(JSON.stringify(report, null, 2));
      else console.log(renderProjectQaReport(report));
      return report.status === 'FAIL' ? 1 : 0;
    }

    const input = arg('--input');
    if (!input) {
      console.error('video qa requires --input <media file> or --project <pipeline.json> | --project-id <id>.');
      console.error('It analyses EXISTING media read-only; it never renders or overwrites anything.');
      return 2;
    }
    const report = await runMediaQa({
      input: path.resolve(String(input)),
      ffmpegPath: process.env.FFMPEG_PATH,
      ffprobePath: process.env.FFPROBE_PATH,
      targetLufs: parsed['--target-lufs'],
      loudnessToleranceLu: parsed['--loudness-tolerance'],
      minHeight: parsed['--min-height'],
      targetHeight: parsed['--target-height'],
      expectDurationSeconds: parsed['--expect-duration'],
      durationToleranceSeconds: parsed['--duration-tolerance'],
      blackMinSeconds: parsed['--black-min'],
      freezeMinSeconds: parsed['--freeze-min'],
      skipBlack: hasFlag('--skip-black'),
      skipFreeze: hasFlag('--skip-freeze'),
      skipAudio: hasFlag('--skip-audio'),
    });
    if (jsonFlag()) console.log(JSON.stringify(report, null, 2));
    else console.log(renderMediaQaReport(report));
    return report.ok ? 0 : 1;
  }

  if (command === 'contract') {
    // READ-ONLY long-form output contract. Composes the Phase 4 QA report and the durable
    // approval verdict into ONE mapped view. It never approves, uploads, publishes or renders.
    const projectArg = arg('--project');
    const projectIdArg = arg('--project-id');
    if (!projectArg && !projectIdArg) {
      console.error('video contract requires --project <pipeline.json> or --project-id <id>.');
      return 2;
    }
    const projectId = projectArg ? path.basename(path.dirname(path.resolve(String(projectArg)))) : String(projectIdArg ?? '').trim();
    if (!projectId || !/^[A-Za-z0-9._-]+$/.test(projectId)) {
      console.error('video contract: --project-id must be a safe project id.');
      return 2;
    }
    const pipelineFile = projectArg ? path.resolve(String(projectArg)) : path.join(PROJECTS_ROOT, projectId, 'pipeline.json');
    let pipeline: any;
    try {
      const fsp = await import('node:fs/promises');
      pipeline = JSON.parse(await fsp.readFile(pipelineFile, 'utf8'));
    } catch (e: any) {
      console.error(`video contract: could not read pipeline ${pipelineFile}: ${String(e?.message ?? e).slice(0, 160)}`);
      return 2;
    }
    const numeric = (name: string): number | undefined => {
      const raw = arg(name);
      if (raw === undefined) return undefined;
      const value = Number(raw);
      return Number.isFinite(value) ? value : NaN;
    };
    for (const name of ['--expect-duration', '--duration-tolerance', '--min-height', '--target-height'] as const) {
      const value = numeric(name);
      if (typeof value === 'number' && Number.isNaN(value)) {
        console.error(`video contract: ${name} must be a number, got "${arg(name)}".`);
        return 2;
      }
    }
    const finalArg = arg('--final');
    const expectedHash = arg('--sha256');
    const report = await evaluateOutputContract({
      projectId,
      pipeline,
      outputsRoot: OUTPUTS_ROOT,
      outputsDir: path.join(OUTPUTS_ROOT, projectId),
      inputRoot: path.join(INPUTS_ROOT, projectId),
      candidatePath: finalArg ? path.resolve(String(finalArg)) : undefined,
      expectedHash,
      ffmpegPath: process.env.FFMPEG_PATH,
      ffprobePath: process.env.FFPROBE_PATH,
      minHeight: numeric('--min-height'),
      targetHeight: numeric('--target-height'),
      expectedFinalDurationSeconds: numeric('--expect-duration'),
      finalDurationToleranceSeconds: numeric('--duration-tolerance'),
      sceneDurationToleranceSeconds: numeric('--duration-tolerance'),
      blockOnMediaQaWarnings: hasFlag('--qa-warnings-block'),
    });
    if (jsonFlag()) console.log(JSON.stringify(report, null, 2));
    else console.log(renderOutputContractReport(report));
    return report.status === 'FAIL' ? 1 : 0;
  }

  if (command === 'shorts') {
    // PHASE 6: standalone vertical Shorts derived from the SAME story. Child scope only:
    // everything is written under outputs/<id>/shorts/, the long-form pipeline/outputs/approval
    // are read-only, no Flow run is possible from here, and nothing is ever uploaded or published.
    const action = String(process.argv[3] ?? '').trim();
    if (!['plan', 'render', 'status', 'qa', 'approve'].includes(action)) {
      console.error('video shorts requires one of: plan | render | status | qa | approve');
      return 2;
    }
    const projectArg = arg('--project');
    const projectIdArg = arg('--project-id');
    if (!projectArg && !projectIdArg) {
      console.error('video shorts requires --project <pipeline.json> or --project-id <id>.');
      return 2;
    }
    const projectId = projectArg ? path.basename(path.dirname(path.resolve(String(projectArg)))) : String(projectIdArg ?? '').trim();
    if (!projectId || !/^[A-Za-z0-9._-]+$/.test(projectId)) {
      console.error('video shorts: --project-id must be a safe project id.');
      return 2;
    }
    const projectFile = projectArg ? path.resolve(String(projectArg)) : path.join(PROJECTS_ROOT, projectId, 'pipeline.json');
    const shortId = String(arg('--short') ?? '').trim() || undefined;
    const countRaw = arg('--count');
    let count: number | undefined;
    if (countRaw !== undefined) {
      const parsed = Number(countRaw);
      if (!Number.isInteger(parsed) || parsed < 2 || parsed > 3) {
        console.error('video shorts: --count must be 2 or 3.');
        return 2;
      }
      count = parsed;
    }
    if (action === 'approve' && !shortId) {
      console.error('video shorts approve requires --short <short-id> (approval is per Short).');
      return 2;
    }
    const shortsOptions = {
      projectId,
      projectFile,
      outputsRoot: OUTPUTS_ROOT,
      // Per-project inputs dir, matching the Phase 4 QA boundary (`inputs/<id>`).
      inputRoot: path.join(INPUTS_ROOT, projectId),
      ffmpegPath: process.env.FFMPEG_PATH,
      ffprobePath: process.env.FFPROBE_PATH,
    };
    try {
      if (action === 'plan') {
        const result = await planShorts({ ...shortsOptions, count });
        if (jsonFlag()) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(`project:       ${result.projectId}`);
          console.log(`plan:          ${result.planPath}${result.changed ? '' : ' (unchanged)'}`);
          console.log(`shorts:        ${result.plan?.count ?? 0} of ${result.plan?.requested_count ?? count ?? 3} requested`);
          for (const short of result.plan?.shorts ?? []) {
            console.log(`  ${short.short_id}  scenes ${short.scene_refs.join(',')}  ~${short.estimated_duration_seconds}s  ${short.title}`);
          }
          for (const warning of result.warnings) console.log(`warning:       ${warning}`);
          for (const error of result.errors) console.error(`error:         ${error}`);
          console.log('note:          planning is read-only; no media was rendered, generated or uploaded.');
        }
        return result.ok ? 0 : 1;
      }

      if (action === 'render') {
        const result = await renderShorts({ ...shortsOptions, shortId });
        if (jsonFlag()) console.log(JSON.stringify(result, null, 2));
        else console.log(renderShortsRenderReport(result));
        return result.ok ? 0 : 1;
      }

      if (action === 'status') {
        const report = await shortsStatus({ ...shortsOptions, shortId });
        if (jsonFlag()) console.log(JSON.stringify(report, null, 2));
        else console.log(renderShortsStatus(report));
        return 0;
      }

      if (action === 'qa') {
        const result = await qaShorts({ ...shortsOptions, shortId });
        if (jsonFlag()) console.log(JSON.stringify(result, null, 2));
        else {
          for (const report of result.reports) {
            console.log(`${report.shortId}: ${report.status} — ${report.reason}`);
            if (report.reportPath) console.log(`  report: ${report.reportPath}`);
          }
          for (const error of result.errors) console.error(`error: ${error}`);
          console.log('note:          QA is read-only on the media; it never approves, uploads or publishes.');
        }
        return result.ok ? 0 : 1;
      }

      const approval = await approveShort({
        ...shortsOptions,
        shortId: String(shortId),
        approvedBy: arg('--by') ?? null,
        expectedHash: arg('--sha256') ?? null,
        blockOnWarnings: hasFlag('--qa-warnings-block'),
        confirmed: hasFlag('--yes'),
      });
      if (jsonFlag()) console.log(JSON.stringify(approval, null, 2));
      else {
        console.log(`short:         ${approval.shortId}`);
        console.log(`approval:      ${approval.status}`);
        console.log(`reason:        ${approval.reason}`);
        if (approval.outputHash) console.log(`artifact:      ${approval.outputHash}`);
        if (approval.status === 'APPROVED') console.log('note:          approval is recorded locally; nothing was uploaded or published.');
      }
      return approval.status === 'APPROVED' ? 0 : 1;
    } catch (error: any) {
      console.error(`video shorts ${action}: ${String(error?.message ?? error).slice(0, 300)}`);
      return 1;
    }
  }

  if (command === 'narration') {
    // PHASE 7: narration INVENTORY + QA + per-asset approval. Read-only on the audio sources; writes
    // only outputs/<id>/narration/. No provider call, no TTS, no network.
    const action = String(process.argv[3] ?? '').trim();
    if (!['refresh', 'status', 'qa', 'approve'].includes(action)) {
      console.error('video narration requires one of: refresh | status | qa | approve');
      return 2;
    }
    const projectArg = arg('--project');
    const projectIdArg = arg('--project-id');
    if (!projectArg && !projectIdArg) {
      console.error('video narration requires --project <pipeline.json> or --project-id <id>.');
      return 2;
    }
    const projectId = projectArg ? path.basename(path.dirname(path.resolve(String(projectArg)))) : String(projectIdArg ?? '').trim();
    if (!projectId || !/^[A-Za-z0-9._-]+$/.test(projectId)) {
      console.error('video narration: --project-id must be a safe project id.');
      return 2;
    }
    const projectFile = projectArg ? path.resolve(String(projectArg)) : path.join(PROJECTS_ROOT, projectId, 'pipeline.json');
    let pipeline: any = null;
    try {
      pipeline = JSON.parse(await fs.readFile(projectFile, 'utf8'));
    } catch (error: any) {
      if (action !== 'status') {
        console.error(`video narration ${action}: cannot read ${projectFile} (${String(error?.message ?? error).slice(0, 160)})`);
        return 1;
      }
    }
    const narrationOptions = {
      projectId,
      pipeline,
      outputsRoot: OUTPUTS_ROOT,
      inputRoot: path.join(INPUTS_ROOT, projectId),
      pronunciationPath: arg('--pronunciation') ?? null,
      ffmpegPath: process.env.FFMPEG_PATH,
      ffprobePath: process.env.FFPROBE_PATH,
    };
    try {
      if (action === 'refresh') {
        const result = await refreshNarrationAssets(narrationOptions);
        if (jsonFlag()) console.log(JSON.stringify(result, null, 2));
        else {
          const ledger = result.ledger;
          console.log(`project:       ${result.projectId}`);
          console.log(`ledger:        ${result.ledgerPath}${result.written ? '' : ' (unchanged)'}`);
          console.log(`voice:         ${ledger.voice.provider}/${ledger.voice.model}/${ledger.voice.voice} (${ledger.voice.language})`);
          console.log(`narrator:      ${ledger.scene_texts.filter((plan) => plan.required).length} scene(s) require narration`);
          console.log(`assets:        ${ledger.assets.filter((asset) => asset.state === 'ready').length} ready of ${ledger.assets.length}`);
          console.log(`measured:      ${ledger.total_duration_seconds}s (ffprobe)`);
          if (ledger.missing_scenes.length) console.log(`missing:       scene(s) ${ledger.missing_scenes.join(', ')}`);
          if (ledger.stale_scenes.length) console.log(`stale:         scene(s) ${ledger.stale_scenes.join(', ')} (re-record)`);
          if (ledger.invalid_scenes.length) console.log(`invalid:       scene(s) ${ledger.invalid_scenes.join(', ')}`);
          for (const change of result.changes) if (change.bytes_changed || change.script_or_voice_changed) console.log(`changed:       ${change.asset} ${change.from ?? '(new)'} -> ${change.to}`);
          if (result.invalidation.changed_scenes.length) console.log(`invalidated:   dependents ${Object.keys(result.invalidation.stale_dependents).join(', ')}`);
          for (const warning of result.warnings) console.log(`warning:       ${warning}`);
          console.log('note:          the narration audio files were NOT modified; nothing was generated or uploaded.');
        }
        const clean = result.ledger.missing_scenes.length === 0 && result.ledger.invalid_scenes.length === 0 && result.ledger.stale_scenes.length === 0;
        return clean ? 0 : 1;
      }

      if (action === 'status') {
        const report = await narrationStatus(narrationOptions);
        if (jsonFlag()) console.log(JSON.stringify(report, null, 2));
        else console.log(renderNarrationStatus(report));
        return 0;
      }

      if (action === 'qa') {
        const result = await qaNarrationAssets(narrationOptions);
        if (jsonFlag()) console.log(JSON.stringify(result, null, 2));
        else if (result.report) {
          console.log(renderNarrationQaReport(result.report));
          console.log(`report:        ${result.reportPath}${result.written ? '' : ' (unchanged)'}`);
        }
        for (const error of result.errors) console.error(`error:         ${error}`);
        return result.ok ? 0 : 1;
      }

      const approval = await approveNarrationAssets({
        ...narrationOptions,
        approvedBy: arg('--by') ?? null,
        blockOnWarnings: hasFlag('--qa-warnings-block'),
        confirmed: hasFlag('--yes'),
      });
      if (jsonFlag()) console.log(JSON.stringify(approval, null, 2));
      else {
        console.log(`narration:     ${approval.projectId}`);
        console.log(`approval:      ${approval.status}`);
        console.log(`reason:        ${approval.reason}`);
        if (approval.ok) console.log('note:          approval is local evidence for these exact bytes; nothing was uploaded or published.');
      }
      return approval.ok ? 0 : 1;
    } catch (error: any) {
      console.error(`video narration ${action}: ${String(error?.message ?? error).slice(0, 300)}`);
      return 1;
    }
  }

  if (command === 'thumbnail') {
    // PHASE 7: deterministic thumbnails (long-form 1280×720 and per-Short 1080×1920 covers).
    // Offline renderer only: a still from an existing clip (or a deterministic card) + libass type +
    // the channel logo. No image-generation API, no Flow, no upload.
    const action = String(process.argv[3] ?? '').trim();
    if (!['plan', 'render', 'status', 'qa', 'approve'].includes(action)) {
      console.error('video thumbnail requires one of: plan | render | status | qa | approve');
      return 2;
    }
    const projectArg = arg('--project');
    const projectIdArg = arg('--project-id');
    if (!projectArg && !projectIdArg) {
      console.error('video thumbnail requires --project <pipeline.json> or --project-id <id>.');
      return 2;
    }
    const projectId = projectArg ? path.basename(path.dirname(path.resolve(String(projectArg)))) : String(projectIdArg ?? '').trim();
    if (!projectId || !/^[A-Za-z0-9._-]+$/.test(projectId)) {
      console.error('video thumbnail: --project-id must be a safe project id.');
      return 2;
    }
    const projectFile = projectArg ? path.resolve(String(projectArg)) : path.join(PROJECTS_ROOT, projectId, 'pipeline.json');
    const shortId = String(arg('--short') ?? '').trim() || undefined;
    if (action === 'approve' && !hasFlag('--yes')) {
      console.error('video thumbnail approve requires explicit --yes (approval is a human decision).');
      return 2;
    }
    let pipeline: any = null;
    try {
      pipeline = JSON.parse(await fs.readFile(projectFile, 'utf8'));
    } catch (error: any) {
      if (action !== 'status') {
        console.error(`video thumbnail ${action}: cannot read ${projectFile} (${String(error?.message ?? error).slice(0, 160)})`);
        return 1;
      }
    }
    const sceneArg = arg('--scene');
    const sceneNumber = sceneArg !== undefined ? Number(sceneArg) : undefined;
    if (sceneNumber !== undefined && (!Number.isInteger(sceneNumber) || sceneNumber < 1)) {
      console.error('video thumbnail: --scene must be a positive integer.');
      return 2;
    }
    const thumbnailOptions = {
      projectId,
      pipeline,
      outputsRoot: OUTPUTS_ROOT,
      inputRoot: path.join(INPUTS_ROOT, projectId),
      shortId,
      overrides: {
        headline: arg('--headline') ?? null,
        subhead: arg('--subhead') ?? null,
        kicker: arg('--kicker') ?? null,
        sceneNumber: sceneNumber ?? null,
      },
      backgroundMode: hasFlag('--designed-card') ? 'designed_card' as const : undefined,
      ffmpegPath: process.env.FFMPEG_PATH,
      ffprobePath: process.env.FFPROBE_PATH,
    };
    try {
      if (action === 'plan') {
        const result = await planThumbnail(thumbnailOptions);
        if (jsonFlag()) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(`thumbnail:     ${result.ownerId} (${result.kind})`);
          console.log(`design:        ${result.designPath}${result.written ? '' : ' (unchanged)'}`);
          if (result.design) {
            const design = result.design;
            console.log(`size:          ${design.width}x${design.height}`);
            console.log(`headline:      ${design.concept.headline}`);
            if (design.concept.subhead) console.log(`subhead:       ${design.concept.subhead}`);
            console.log(`source:        ${design.sources.find((source) => source.role === 'base')?.relative_path ?? '(designed card)'}`);
            console.log(`design hash:   ${design.design_hash}`);
          }
          for (const warning of result.warnings) console.log(`warning:       ${warning}`);
          for (const error of result.errors) console.error(`error:         ${error}`);
          console.log('note:          planning is read-only for media; no image API was called.');
        }
        return result.ok ? 0 : 1;
      }

      if (action === 'render') {
        const result = await renderThumbnailArtifact(thumbnailOptions);
        if (jsonFlag()) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(`thumbnail:     ${result.ownerId} (${result.kind})`);
          console.log(`render:        ${result.action}`);
          console.log(`artifact:      ${result.artifactPath}`);
          if (result.checkpoint) console.log(`sha256:        ${result.checkpoint.artifact_hash}`);
          for (const warning of result.warnings) console.log(`warning:       ${warning}`);
          for (const error of result.errors) console.error(`error:         ${error}`);
        }
        return result.action === 'FAILED' ? 1 : 0;
      }

      if (action === 'status') {
        const report = await thumbnailStatus({ ...thumbnailOptions, pipeline: thumbnailOptions.pipeline });
        if (jsonFlag()) console.log(JSON.stringify(report, null, 2));
        else console.log(renderThumbnailStatus(report));
        return 0;
      }

      if (action === 'qa') {
        const result = await qaThumbnailArtifact(thumbnailOptions);
        if (jsonFlag()) console.log(JSON.stringify(result, null, 2));
        else if (result.report) {
          console.log(renderThumbnailQaReport(result.report));
          console.log(`  report:    ${result.reportPath}${result.written ? '' : ' (unchanged)'}`);
        }
        for (const error of result.errors) console.error(`error:         ${error}`);
        return result.ok ? 0 : 1;
      }

      const approval = await approveThumbnailArtifact({
        ...thumbnailOptions,
        approvedBy: arg('--by') ?? null,
        expectedHash: arg('--sha256') ?? null,
        blockOnWarnings: hasFlag('--qa-warnings-block'),
        confirmed: hasFlag('--yes'),
      });
      if (jsonFlag()) console.log(JSON.stringify(approval, null, 2));
      else {
        console.log(`thumbnail:     ${approval.ownerId} (${approval.kind})`);
        console.log(`approval:      ${approval.status}`);
        console.log(`reason:        ${approval.reason}`);
        if (approval.ok) console.log('note:          approval is local evidence for these exact bytes; nothing was uploaded or published.');
      }
      return approval.status === 'APPROVED' ? 0 : 1;
    } catch (error: any) {
      console.error(`video thumbnail ${action}: ${String(error?.message ?? error).slice(0, 300)}`);
      return 1;
    }
  }

  console.error(renderUsage());
  return 2;
}

// Execute only when invoked directly as the CLI (keeps the module importable for tests).
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main().then((code) => { process.exitCode = code; }).catch((e) => { console.error(String(e?.message ?? e)); process.exitCode = 1; });
