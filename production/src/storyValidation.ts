/**
 * PHASE 3 — story & scene intelligence boundary (read-only).
 *
 * There is exactly ONE authoritative validator: the Python `project_check` module, reached
 * through the already-supported CLI:
 *
 *   python -m pipeline.one_minute --check --project-file <pipeline.json>
 *
 * This module is a THIN bridge in the same shape as `seoGenerator.ts`:
 *   · it shells out to that CLI (never imports Python internals, never re-implements a rule)
 *   · it parses and normalises the JSON report into a stable typed shape
 *   · it renders a human-readable summary
 *   · it exposes a PURE gate decision the workflow can consult before paid generation
 *
 * SAFETY
 *   · It NEVER writes: the CLI is read-only, and this bridge only reads stdout.
 *   · It NEVER calls a model, the network, the browser, Flow, or the publisher.
 *   · Validation failure leaves the project and every generation artefact byte-identical.
 *   · Findings are classified BLOCKER / WARNING / INFO. Only BLOCKERs (and, when explicitly
 *     requested, WARNINGs) stop paid generation. INFOs are context only.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolvePython, spawnCapture, type SpawnResult } from './pipelineGenerator.js';

export type StorySeverity = 'BLOCKER' | 'WARNING' | 'INFO';
export type StoryStatus = 'PASS' | 'REVIEW' | 'BLOCKED';

/** One machine-readable finding. Extra keys are preserved verbatim from the CLI. */
export interface StoryFinding {
  code: string;
  message: string;
  severity: StorySeverity;
  scope: 'story' | 'scene';
  scene?: number;
  field?: string;
  recommendation?: string;
  [key: string]: unknown;
}

/** Normalised shape of the CLI report (additive fields are ignored, never required). */
export interface StoryValidationReport {
  ok: boolean;
  status: StoryStatus;
  readOnly: true;
  projectId: string;
  projectFile?: string;
  scenes: number;
  characters: number;
  backgrounds: number;
  counts: { blockers: number; warnings: number; infos: number };
  findings: StoryFinding[];
  storyFindings: StoryFinding[];
  sceneFindings: Array<{ scene: number; findings: StoryFinding[] }>;
  recommendedActions: string[];
  stats: Record<string, unknown>;
}

/** Result of one validation run (always described, even when the validator was unusable). */
export interface StoryValidationResult {
  /** True only when the validator ran AND reported no blockers. */
  ok: boolean;
  /** True only when a parsed report exists; false when Python/CLI was missing or unparsable. */
  available: boolean;
  status: StoryStatus | 'UNAVAILABLE';
  projectId: string;
  projectFile: string;
  exitCode: number | null;
  blockers: StoryFinding[];
  warnings: StoryFinding[];
  infos: StoryFinding[];
  report?: StoryValidationReport;
  reason?: string;
  stdout: string;
  stderr: string;
}

export interface StoryValidatorInput {
  /** Absolute path to the project `pipeline.json`. */
  projectFile: string;
  /** Treat WARNINGs as blocking for this run (explicit strict review). */
  strict?: boolean;
}

/** Injectable boundary: production wires the Python bridge, tests use a fake. */
export type StoryValidator = (input: StoryValidatorInput) => Promise<StoryValidationResult>;

export interface PythonStoryValidatorOptions {
  /** Repository root containing `scripting/`. */
  repoRoot: string;
  /** Python executable; defaults to the project venv then `python`. */
  pythonPath?: string;
  /** Extra environment for the child (merged over process.env). Never logged. */
  env?: Record<string, string>;
  /** Hard cap on the child process duration (validation is offline and fast). */
  timeoutMs?: number;
  /** Injectable spawn (tests use a fake; production uses `spawnCapture`). */
  spawn?: (command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<SpawnResult>;
}

export const DEFAULT_STORY_VALIDATION_TIMEOUT_MS = 120_000;

/** Canonical CLI argument vector for the read-only audit. */
export function buildStoryValidationArgs(projectFile: string, strict = false): string[] {
  const args = ['-m', 'pipeline.one_minute', '--check', '--project-file', projectFile];
  if (strict) args.push('--strict');
  return args;
}

/**
 * Parse the last complete JSON object from CLI stdout.
 *
 * The Python CLI writes exactly one JSON document, but a launcher wrapper (or a Python
 * warning) can emit prose first. Scanning for balanced objects and keeping the last one
 * that parses is the same tolerant approach `seoGenerator.parseSeoReport` uses.
 */
export function parseStoryReport(stdout: string): Record<string, unknown> | null {
  const text = String(stdout ?? '');
  let best: Record<string, unknown> | null = null;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      if (depth > 0) inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          const parsed = JSON.parse(text.slice(start, index + 1));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) best = parsed as Record<string, unknown>;
        } catch { /* keep scanning */ }
        start = -1;
      }
    }
  }
  return best;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeSeverity(value: unknown): StorySeverity {
  const text = asString(value).toUpperCase();
  return text === 'BLOCKER' ? 'BLOCKER' : text === 'INFO' ? 'INFO' : 'WARNING';
}

function normalizeFinding(raw: unknown, fallbackScope: 'story' | 'scene'): StoryFinding | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const code = asString(item.code).trim();
  if (!code) return null;
  const severity = normalizeSeverity(item.severity);
  const scene = typeof item.scene === 'number' && Number.isInteger(item.scene) ? item.scene : undefined;
  const scope: 'story' | 'scene' = item.scope === 'scene' || (item.scope !== 'story' && scene !== undefined) ? 'scene' : fallbackScope;
  return {
    ...item,
    code,
    message: asString(item.message),
    severity,
    scope,
    ...(scene !== undefined ? { scene } : {}),
    ...(typeof item.field === 'string' && item.field ? { field: item.field } : {}),
    ...(typeof item.recommendation === 'string' && item.recommendation ? { recommendation: item.recommendation } : {}),
  };
}

/** Normalise a raw CLI report. Tolerant: unknown/missing fields never throw. */
export function normalizeStoryReport(raw: Record<string, unknown>, projectFile = ''): StoryValidationReport {
  const rawFindings = asArray(raw.findings);
  const findings: StoryFinding[] = [];
  if (rawFindings.length) {
    for (const item of rawFindings) {
      const finding = normalizeFinding(item, 'story');
      if (finding) findings.push(finding);
    }
  } else {
    // Backward-compatible fallback: older/partial reports carry errors+warnings only.
    for (const item of asArray(raw.errors)) {
      const finding = normalizeFinding({ ...(item as object), severity: 'BLOCKER' }, 'story');
      if (finding) findings.push(finding);
    }
    for (const item of asArray(raw.warnings)) {
      const finding = normalizeFinding({ ...(item as object), severity: 'WARNING' }, 'story');
      if (finding) findings.push(finding);
    }
  }

  const blockers = findings.filter((finding) => finding.severity === 'BLOCKER');
  const warnings = findings.filter((finding) => finding.severity === 'WARNING');
  const infos = findings.filter((finding) => finding.severity === 'INFO');
  const rawCounts = raw.counts && typeof raw.counts === 'object' ? (raw.counts as Record<string, unknown>) : {};
  const statusText = asString(raw.status).toUpperCase();
  const status: StoryStatus = statusText === 'PASS' || statusText === 'REVIEW' || statusText === 'BLOCKED'
    ? (statusText as StoryStatus)
    : blockers.length ? 'BLOCKED' : warnings.length ? 'REVIEW' : 'PASS';

  const sceneFindings = asArray(raw.scene_findings)
    .map((group) => {
      if (!group || typeof group !== 'object') return null;
      const entry = group as Record<string, unknown>;
      const scene = asNumber(entry.scene, NaN);
      if (!Number.isInteger(scene)) return null;
      const items = asArray(entry.findings)
        .map((item) => normalizeFinding(item, 'scene'))
        .filter((item): item is StoryFinding => Boolean(item));
      return { scene, findings: items };
    })
    .filter((group): group is { scene: number; findings: StoryFinding[] } => Boolean(group));

  const storyFindings = asArray(raw.story_findings).length
    ? asArray(raw.story_findings)
        .map((item) => normalizeFinding(item, 'story'))
        .filter((item): item is StoryFinding => Boolean(item))
    : findings.filter((finding) => finding.scope === 'story');

  return {
    ok: blockers.length === 0 && raw.ok !== false,
    status,
    readOnly: true,
    projectId: asString(raw.project_id),
    ...(asString(raw.project_file) || projectFile ? { projectFile: asString(raw.project_file) || projectFile } : {}),
    scenes: asNumber(raw.scenes),
    characters: asNumber(raw.characters),
    backgrounds: asNumber(raw.backgrounds),
    counts: {
      blockers: asNumber(rawCounts.blockers, blockers.length),
      warnings: asNumber(rawCounts.warnings, warnings.length),
      infos: asNumber(rawCounts.infos, infos.length),
    },
    findings,
    storyFindings,
    sceneFindings,
    recommendedActions: asArray(raw.recommended_actions).map((action) => String(action)).filter(Boolean),
    stats: raw.stats && typeof raw.stats === 'object' && !Array.isArray(raw.stats) ? (raw.stats as Record<string, unknown>) : {},
  };
}

function findingLine(finding: StoryFinding): string {
  const where = finding.scope === 'scene' && finding.scene !== undefined
    ? `scene ${finding.scene}${finding.field ? ` (${finding.field})` : ''}`
    : finding.field ? `project (${finding.field})` : 'project';
  return `  [${finding.severity}] ${finding.code} @ ${where}: ${finding.message}`;
}

/** Compact human-readable summary. Never includes the raw pipeline body. */
export function renderStoryReport(report: StoryValidationReport, opts: { maxPerSeverity?: number } = {}): string {
  const limit = Math.max(1, opts.maxPerSeverity ?? 20);
  const lines: string[] = [];
  lines.push(`story validation: ${report.status} (${report.projectId || 'unknown project'})`);
  lines.push(`  scenes: ${report.scenes} | characters: ${report.characters} | backgrounds: ${report.backgrounds}`);
  lines.push(`  findings: ${report.counts.blockers} blocker(s), ${report.counts.warnings} warning(s), ${report.counts.infos} info`);
  const groups: Array<[string, StoryFinding[]]> = [
    ['BLOCKER', report.findings.filter((finding) => finding.severity === 'BLOCKER')],
    ['WARNING', report.findings.filter((finding) => finding.severity === 'WARNING')],
    ['INFO', report.findings.filter((finding) => finding.severity === 'INFO')],
  ];
  for (const [label, items] of groups) {
    if (!items.length) continue;
    lines.push(`  ${label.toLowerCase()}s:`);
    for (const finding of items.slice(0, limit)) lines.push(findingLine(finding));
    if (items.length > limit) lines.push(`  ... and ${items.length - limit} more ${label.toLowerCase()}s`);
  }
  if (report.recommendedActions.length) {
    lines.push('  next:');
    for (const action of report.recommendedActions.slice(0, limit)) lines.push(`    - ${action}`);
  }
  return lines.join('\n');
}

/** Render a result that never produced a report (validator missing/broken). */
export function renderStoryValidationFailure(result: StoryValidationResult): string {
  return [
    `story validation: UNAVAILABLE (${result.projectId || path.basename(path.dirname(result.projectFile))})`,
    `  reason: ${result.reason ?? 'the validator produced no parsable report'}`,
  ].join('\n');
}

// ---------------------------------------------------------------- gate (pure)

export type StoryGateCode =
  | 'STORY_BLOCKED'
  | 'STORY_REVIEW_REQUIRED'
  | 'STORY_VALIDATION_UNAVAILABLE';

export interface StoryGateDecision {
  allowed: boolean;
  code?: StoryGateCode;
  reason?: string;
}

export interface StoryGateOptions {
  /** Treat WARNINGs as blocking (explicit strict review). Blockers always block. */
  blockOnWarnings?: boolean;
  /**
   * When the validator cannot run, is generation still allowed?
   * Default FALSE: a paid run that cannot prove its story is structurally sound fails closed.
   * Zero-credit status/resume paths pass TRUE because nothing is being generated.
   */
  allowUnavailable?: boolean;
}

/**
 * Decide whether a validated report permits the NEXT paid generation step.
 *
 * No result (no validator injected) is allowed: callers that never opted into Phase 3 keep
 * their exact previous behaviour.
 */
export function decideStoryGate(result: StoryValidationResult | undefined | null, opts: StoryGateOptions = {}): StoryGateDecision {
  if (!result) return { allowed: true };
  if (!result.available) {
    if (opts.allowUnavailable) return { allowed: true };
    return {
      allowed: false,
      code: 'STORY_VALIDATION_UNAVAILABLE',
      reason: result.reason ?? 'the story/scene validator could not run; paid generation fails closed.',
    };
  }
  if (result.blockers.length) {
    const first = result.blockers[0];
    return {
      allowed: false,
      code: 'STORY_BLOCKED',
      reason: `${result.blockers.length} blocker(s); first: ${first.code}${first.scene !== undefined ? ` (scene ${first.scene})` : ''}: ${first.message}`,
    };
  }
  if (opts.blockOnWarnings && result.warnings.length) {
    const first = result.warnings[0];
    return {
      allowed: false,
      code: 'STORY_REVIEW_REQUIRED',
      reason: `${result.warnings.length} warning(s) need human review; first: ${first.code}${first.scene !== undefined ? ` (scene ${first.scene})` : ''}: ${first.message}`,
    };
  }
  return { allowed: true };
}

export interface SceneStoryGateDecision {
  allowed: boolean;
  /** The scene-scoped findings that caused the block (empty when allowed). */
  findings: StoryFinding[];
  reason?: string;
}

/**
 * Per-scene defence used by the scene executor. It only considers findings that NAME this scene,
 * so a project-level finding cannot silently stop an unrelated local render. When no report was
 * forwarded (the default for direct/test use) nothing is gated.
 */
export function decideSceneStoryGate(
  result: StoryValidationResult | undefined | null,
  scene: number,
  blockOnWarnings = false,
): SceneStoryGateDecision {
  if (!result || !result.available) return { allowed: true, findings: [] };
  const candidates = blockOnWarnings ? [...result.blockers, ...result.warnings] : result.blockers;
  const offending = candidates.filter((finding) => finding.scope === 'scene' && finding.scene === scene);
  if (!offending.length) return { allowed: true, findings: [] };
  const first = offending[0];
  return {
    allowed: false,
    findings: offending,
    reason: `${first.severity} ${first.code}: ${first.message}`,
  };
}

// ---------------------------------------------------------------- bridge (side-effect free)

function tail(value: string, lines = 12): string {
  return String(value ?? '').trim().split('\n').slice(-lines).join('\n');
}

/**
 * Build the production validator. It runs ONE process and never writes anything: the Python
 * `--check` path is read-only by contract (see `scripting/pipeline/project_check.py`).
 */
export function createPythonStoryValidator(opts: PythonStoryValidatorOptions): StoryValidator {
  return async function validateStory(input: StoryValidatorInput): Promise<StoryValidationResult> {
    const projectFile = path.resolve(String(input.projectFile ?? ''));
    const args = buildStoryValidationArgs(projectFile, Boolean(input.strict));
    const python = opts.pythonPath ?? (await resolvePython(opts.repoRoot));
    const cwd = path.join(opts.repoRoot, 'scripting');
    const spawn = opts.spawn ?? spawnCapture;
    const base = {
      available: false,
      status: 'UNAVAILABLE' as const,
      projectId: path.basename(path.dirname(projectFile)),
      projectFile,
      exitCode: null as number | null,
      blockers: [] as StoryFinding[],
      warnings: [] as StoryFinding[],
      infos: [] as StoryFinding[],
      stdout: '',
      stderr: '',
    };

    const exists = await fsp.stat(projectFile).then((stat) => stat.isFile()).catch(() => false);
    if (!exists) {
      return {
        ...base,
        ok: false,
        reason: `project file not found: ${projectFile}`,
      };
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(opts.env ?? {}),
      // Keep Devanagari findings intact through the Windows console code page.
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    };

    let result: SpawnResult;
    try {
      result = await spawn(python, args, {
        cwd,
        env,
        timeoutMs: opts.timeoutMs ?? DEFAULT_STORY_VALIDATION_TIMEOUT_MS,
      });
    } catch (error: any) {
      return { ...base, ok: false, reason: `validator could not start: ${error?.message ?? String(error)}` };
    }

    const exitCode = result.code ?? 1;
    const raw = parseStoryReport(result.stdout);
    if (!raw) {
      const detail = tail(result.stderr || result.stdout)
        || `python exited with code ${result.code ?? 'null'}${result.timedOut ? ' (timed out)' : ''}`;
      return {
        ...base,
        ok: false,
        exitCode,
        reason: `validator produced no parsable report: ${detail}`,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }

    const report = normalizeStoryReport(raw, projectFile);
    const blockers = report.findings.filter((finding) => finding.severity === 'BLOCKER');
    const warnings = report.findings.filter((finding) => finding.severity === 'WARNING');
    const infos = report.findings.filter((finding) => finding.severity === 'INFO');
    return {
      ok: blockers.length === 0 && report.ok,
      available: true,
      status: report.status,
      projectId: report.projectId || base.projectId,
      projectFile: report.projectFile || projectFile,
      exitCode,
      blockers,
      warnings,
      infos,
      report,
      ...(exitCode !== 0 && blockers.length === 0 ? { reason: tail(result.stderr) || undefined } : {}),
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
}
