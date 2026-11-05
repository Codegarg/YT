/**
 * Bounded, persistent Flow generation attempts (credit safety, PHASE 2).
 *
 * This module owns the ONE credit-attempt ledger used by every production path that can submit a
 * paid Flow generation:
 *
 *   · `sceneFlowWorkflow.processSingleFlowScene` — project-composer scene generation and the
 *     explicitly authorised scene-local EXTEND/REGENERATE lifecycle;
 *   · `runner.run` — the legacy `npm run flow` project pass (scenes, characters, backgrounds).
 *
 * WHY IT EXISTS
 * -------------
 * Before this ledger, a failed generation was forgotten as soon as its checkpoint was written:
 * a resume, a CLI retry pass, or a second process could submit the same scene again indefinitely.
 * The ledger makes the attempt budget part of the PROJECT DATA (atomic JSON, no secrets), so a
 * restart can never reset it.
 *
 * HARD RULES
 * ----------
 *   · A valid local clip is authoritative — callers never reach the generation gate at all.
 *   · A committed Flow scene is DOWNLOADED, never regenerated — callers decide that first.
 *   · An attempt budget is a CEILING. Manual approval grants one more attempt while the ceiling
 *     remains, but it never raises the ceiling itself (raise the policy instead, deliberately).
 *   · Any failure whose submission state is UNKNOWN (or which was submitted and then failed)
 *     fails closed: another paid attempt requires an explicit, documented approval.
 *   · Unknown failures fail closed. Only failures PROVEN not to have submitted and classified as
 *     transient retry automatically, and only within the remaining budget.
 *   · No cookies, tokens, signed URLs, prompts or profile paths are ever written.
 *
 * The ledger is pure data + atomic I/O. It never imports Playwright, FlowClient or a selector.
 */
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const GENERATION_ATTEMPT_SCHEMA_VERSION = 1;
export const GENERATION_LEDGER_FILENAME = 'generation-attempts.json';
/** Bounded audit history: counters stay exact, only the oldest records are dropped. */
export const GENERATION_HISTORY_LIMIT = 500;
export const MAX_FAILURE_REASON_LENGTH = 500;

export type GenerationSubjectKind = 'scene' | 'character' | 'background';
export type FailureCategory = 'NONE' | 'RETRYABLE' | 'NON_RETRYABLE' | 'UNKNOWN';
export type SubmissionState = 'NOT_SUBMITTED' | 'SUBMITTED_CONFIRMED' | 'SUBMISSION_UNKNOWN';
export type ManualApprovalState = 'NOT_REQUIRED' | 'REQUIRED' | 'APPROVED';
export type AttemptOutcome = 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED';

export interface GenerationSubject {
  kind: GenerationSubjectKind;
  /** Stable subject key: scene number, character tag, or background tag. */
  id: string;
  /** Present for scene subjects only. */
  sceneNumber?: number | null;
}

export interface GenerationAttemptRecord {
  attempt_id: string;
  project_id: string;
  attempt_number: number;
  subject_kind: GenerationSubjectKind;
  subject_id: string;
  scene_number: number | null;
  started_at: string;
  finished_at: string | null;
  failure_category: FailureCategory;
  failure_reason: string | null;
  submission: SubmissionState;
  clip_downloaded: boolean;
  validation_passed: boolean;
  retry_permitted: boolean;
  manual_approval: ManualApprovalState;
  outcome: AttemptOutcome;
}

export interface GenerationSubjectState {
  subject_kind: GenerationSubjectKind;
  subject_id: string;
  scene_number: number | null;
  attempts: number;
  consecutive_failures: number;
  last_outcome: AttemptOutcome | null;
  last_failure_category: FailureCategory;
  last_submission: SubmissionState;
  last_attempt_at: string | null;
  manual_approval: ManualApprovalState;
}

export interface ActiveAttempt {
  attempt_id: string;
  pid: number;
  host: string;
  started_at: string;
}

export interface GenerationAttemptLedger {
  schema_version: number;
  project_id: string;
  project_attempts: number;
  consecutive_failures: number;
  subjects: Record<string, GenerationSubjectState>;
  active: Record<string, ActiveAttempt>;
  attempts: GenerationAttemptRecord[];
}

export interface GenerationPolicy {
  maxAttemptsPerScene: number;
  maxAttemptsPerAsset: number;
  maxAttemptsPerProject: number;
  maxConsecutiveFailures: number;
  requireApprovalAfterAmbiguous: boolean;
  activeAttemptStaleMs: number;
}

/**
 * Conservative defaults chosen from the EXISTING behaviour, not from provider pricing:
 *   · each scene had exactly one attempt per run → allow a second only after a PROVEN pre-submit
 *     transient failure;
 *   · the legacy CLI loop had no upper bound → cap the project at 80 submissions;
 *   · any ambiguous submission stops for a human.
 */
export const DEFAULT_GENERATION_POLICY: GenerationPolicy = {
  maxAttemptsPerScene: 2,
  maxAttemptsPerAsset: 2,
  maxAttemptsPerProject: 80,
  maxConsecutiveFailures: 2,
  requireApprovalAfterAmbiguous: true,
  activeAttemptStaleMs: 30 * 60 * 1000,
};

export type GenerationApproval =
  | { mode: 'NONE' }
  | { mode: 'PROJECT' }
  | { mode: 'SCENES'; scenes: readonly number[] };

export const NO_APPROVAL: GenerationApproval = { mode: 'NONE' };

const SUBJECT_KINDS: readonly GenerationSubjectKind[] = ['scene', 'character', 'background'];
const FAILURE_CATEGORIES: readonly FailureCategory[] = ['NONE', 'RETRYABLE', 'NON_RETRYABLE', 'UNKNOWN'];
const SUBMISSION_STATES: readonly SubmissionState[] = ['NOT_SUBMITTED', 'SUBMITTED_CONFIRMED', 'SUBMISSION_UNKNOWN'];
const APPROVAL_STATES: readonly ManualApprovalState[] = ['NOT_REQUIRED', 'REQUIRED', 'APPROVED'];
const OUTCOMES: readonly AttemptOutcome[] = ['IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'BLOCKED'];

const positiveInt = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

const boundedInt = (value: unknown, fallback: number, max: number): number => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
};

/** Merge a partial policy over the defaults without ever accepting an invalid number. */
export function resolveGenerationPolicy(partial: Partial<GenerationPolicy> | undefined | null): GenerationPolicy {
  const base = DEFAULT_GENERATION_POLICY;
  if (!partial || typeof partial !== 'object') return { ...base };
  return {
    maxAttemptsPerScene: positiveInt(partial.maxAttemptsPerScene, base.maxAttemptsPerScene),
    maxAttemptsPerAsset: positiveInt(partial.maxAttemptsPerAsset, base.maxAttemptsPerAsset),
    maxAttemptsPerProject: positiveInt(partial.maxAttemptsPerProject, base.maxAttemptsPerProject),
    maxConsecutiveFailures: positiveInt(partial.maxConsecutiveFailures, base.maxConsecutiveFailures),
    requireApprovalAfterAmbiguous: partial.requireApprovalAfterAmbiguous === undefined
      ? base.requireApprovalAfterAmbiguous
      : partial.requireApprovalAfterAmbiguous === true,
    activeAttemptStaleMs: positiveInt(partial.activeAttemptStaleMs, base.activeAttemptStaleMs),
  };
}

/**
 * Read the policy from the environment. Invalid values fall back to the conservative defaults
 * rather than silently disabling the budget (fail closed).
 */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): GenerationPolicy {
  return resolveGenerationPolicy({
    maxAttemptsPerScene: env.FLOW_MAX_ATTEMPTS_PER_SCENE === undefined ? undefined : Number(env.FLOW_MAX_ATTEMPTS_PER_SCENE),
    maxAttemptsPerAsset: env.FLOW_MAX_ATTEMPTS_PER_ASSET === undefined ? undefined : Number(env.FLOW_MAX_ATTEMPTS_PER_ASSET),
    maxAttemptsPerProject: env.FLOW_MAX_ATTEMPTS_PER_PROJECT === undefined ? undefined : Number(env.FLOW_MAX_ATTEMPTS_PER_PROJECT),
    maxConsecutiveFailures: env.FLOW_MAX_CONSECUTIVE_FAILURES === undefined ? undefined : Number(env.FLOW_MAX_CONSECUTIVE_FAILURES),
    requireApprovalAfterAmbiguous: env.FLOW_REQUIRE_APPROVAL_AFTER_AMBIGUOUS === undefined
      ? undefined
      : String(env.FLOW_REQUIRE_APPROVAL_AFTER_AMBIGUOUS).trim() !== '0',
    activeAttemptStaleMs: env.FLOW_ATTEMPT_LOCK_STALE_MINUTES === undefined
      ? undefined
      : Number(env.FLOW_ATTEMPT_LOCK_STALE_MINUTES) * 60 * 1000,
  });
}

/**
 * Explicit operator approval for a recovery attempt. `FLOW_APPROVE_GENERATION_RECOVERY=1` approves
 * the whole project; `FLOW_APPROVE_GENERATION_RECOVERY_SCENES=3,7` approves only those scenes.
 * Scene-scoped approval takes precedence when both are present.
 */
export function approvalFromEnv(env: NodeJS.ProcessEnv = process.env): GenerationApproval {
  const rawScenes = String(env.FLOW_APPROVE_GENERATION_RECOVERY_SCENES ?? '').trim();
  if (rawScenes) {
    const scenes = rawScenes.split(',').map((v) => Number(v.trim())).filter((n) => Number.isInteger(n) && n > 0);
    if (scenes.length) return { mode: 'SCENES', scenes: [...new Set(scenes)].sort((a, b) => a - b) };
  }
  const raw = String(env.FLOW_APPROVE_GENERATION_RECOVERY ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'all' || raw === 'project') return { mode: 'PROJECT' };
  return { mode: 'NONE' };
}

/** PURE: does this approval cover the given subject? Only scenes can be approved individually. */
export function approvalCovers(approval: GenerationApproval | undefined | null, subject: GenerationSubject): boolean {
  if (!approval || approval.mode === 'NONE') return false;
  if (approval.mode === 'PROJECT') return true;
  const n = Number(subject.sceneNumber ?? (subject.kind === 'scene' ? subject.id : NaN));
  return Number.isInteger(n) && approval.scenes.includes(n);
}

export function subjectKey(subject: GenerationSubject): string {
  return `${subject.kind}:${String(subject.id)}`;
}

export function subjectAttemptLimit(subject: GenerationSubject, policy: GenerationPolicy): number {
  return subject.kind === 'scene' ? policy.maxAttemptsPerScene : policy.maxAttemptsPerAsset;
}

export function emptyGenerationLedger(projectId: string): GenerationAttemptLedger {
  return {
    schema_version: GENERATION_ATTEMPT_SCHEMA_VERSION,
    project_id: String(projectId),
    project_attempts: 0,
    consecutive_failures: 0,
    subjects: {},
    active: {},
    attempts: [],
  };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Validate a ledger before it is trusted. Anything unexpected is CORRUPT: callers fail closed
 * instead of silently resetting a budget (which would allow unbounded paid generation).
 */
export function validateGenerationLedger(record: unknown, opts: { projectId?: string } = {}): { ok: true } | { ok: false; reason: string } {
  if (!isPlainObject(record)) return { ok: false, reason: 'ledger is missing or not an object' };
  if (record.schema_version !== GENERATION_ATTEMPT_SCHEMA_VERSION) {
    return { ok: false, reason: `unsupported schema_version ${String(record.schema_version)}` };
  }
  if (typeof record.project_id !== 'string' || !record.project_id.trim()) return { ok: false, reason: 'ledger has no project_id' };
  if (opts.projectId !== undefined && record.project_id !== String(opts.projectId)) {
    return { ok: false, reason: `ledger project_id ${JSON.stringify(record.project_id)} does not match ${JSON.stringify(opts.projectId)}` };
  }
  if (!Number.isInteger(record.project_attempts) || (record.project_attempts as number) < 0) return { ok: false, reason: 'invalid project_attempts' };
  if (!Number.isInteger(record.consecutive_failures) || (record.consecutive_failures as number) < 0) return { ok: false, reason: 'invalid consecutive_failures' };
  if (!isPlainObject(record.subjects)) return { ok: false, reason: 'subjects is not an object' };
  if (!isPlainObject(record.active)) return { ok: false, reason: 'active is not an object' };
  if (!Array.isArray(record.attempts)) return { ok: false, reason: 'attempts is not an array' };

  for (const [key, state] of Object.entries(record.subjects)) {
    if (!isPlainObject(state)) return { ok: false, reason: `subject ${key} is not an object` };
    if (!SUBJECT_KINDS.includes(state.subject_kind as GenerationSubjectKind)) return { ok: false, reason: `subject ${key} has an invalid kind` };
    if (typeof state.subject_id !== 'string' || !state.subject_id.trim()) return { ok: false, reason: `subject ${key} has no id` };
    if (!Number.isInteger(state.attempts) || (state.attempts as number) < 0) return { ok: false, reason: `subject ${key} has invalid attempts` };
    if (!Number.isInteger(state.consecutive_failures) || (state.consecutive_failures as number) < 0) return { ok: false, reason: `subject ${key} has invalid consecutive_failures` };
    if (state.last_failure_category !== null && !FAILURE_CATEGORIES.includes(state.last_failure_category as FailureCategory)) {
      return { ok: false, reason: `subject ${key} has an invalid failure category` };
    }
    if (state.last_submission !== null && !SUBMISSION_STATES.includes(state.last_submission as SubmissionState)) {
      return { ok: false, reason: `subject ${key} has an invalid submission state` };
    }
    if (state.last_outcome !== null && !OUTCOMES.includes(state.last_outcome as AttemptOutcome)) {
      return { ok: false, reason: `subject ${key} has an invalid outcome` };
    }
    if (!APPROVAL_STATES.includes(state.manual_approval as ManualApprovalState)) {
      return { ok: false, reason: `subject ${key} has an invalid manual_approval` };
    }
    if (state.last_attempt_at !== null && typeof state.last_attempt_at !== 'string') {
      return { ok: false, reason: `subject ${key} has an invalid last_attempt_at` };
    }
  }

  for (const [key, active] of Object.entries(record.active)) {
    if (!isPlainObject(active)) return { ok: false, reason: `active ${key} is not an object` };
    if (typeof active.attempt_id !== 'string' || !active.attempt_id) return { ok: false, reason: `active ${key} has no attempt_id` };
    if (!Number.isInteger(active.pid)) return { ok: false, reason: `active ${key} has an invalid pid` };
    if (typeof active.host !== 'string') return { ok: false, reason: `active ${key} has an invalid host` };
    if (typeof active.started_at !== 'string') return { ok: false, reason: `active ${key} has an invalid started_at` };
  }

  for (const attempt of record.attempts as unknown[]) {
    if (!isPlainObject(attempt)) return { ok: false, reason: 'an attempt record is not an object' };
    if (typeof attempt.attempt_id !== 'string' || !attempt.attempt_id) return { ok: false, reason: 'an attempt record has no attempt_id' };
    if (!Number.isInteger(attempt.attempt_number) || (attempt.attempt_number as number) <= 0) return { ok: false, reason: 'an attempt record has an invalid attempt_number' };
    if (!SUBJECT_KINDS.includes(attempt.subject_kind as GenerationSubjectKind)) return { ok: false, reason: 'an attempt record has an invalid subject_kind' };
    if (typeof attempt.subject_id !== 'string' || !attempt.subject_id.trim()) return { ok: false, reason: 'an attempt record has no subject_id' };
    if (!FAILURE_CATEGORIES.includes(attempt.failure_category as FailureCategory)) return { ok: false, reason: 'an attempt record has an invalid failure_category' };
    if (!SUBMISSION_STATES.includes(attempt.submission as SubmissionState)) return { ok: false, reason: 'an attempt record has an invalid submission state' };
    if (!APPROVAL_STATES.includes(attempt.manual_approval as ManualApprovalState)) return { ok: false, reason: 'an attempt record has an invalid manual_approval' };
    if (!OUTCOMES.includes(attempt.outcome as AttemptOutcome)) return { ok: false, reason: 'an attempt record has an invalid outcome' };
    if (typeof attempt.started_at !== 'string') return { ok: false, reason: 'an attempt record has an invalid started_at' };
    if (attempt.finished_at !== null && typeof attempt.finished_at !== 'string') return { ok: false, reason: 'an attempt record has an invalid finished_at' };
    if (attempt.failure_reason !== null && (typeof attempt.failure_reason !== 'string' || attempt.failure_reason.length > MAX_FAILURE_REASON_LENGTH)) {
      return { ok: false, reason: 'an attempt record has an invalid failure_reason' };
    }
    for (const flag of ['clip_downloaded', 'validation_passed', 'retry_permitted']) {
      if (typeof attempt[flag] !== 'boolean') return { ok: false, reason: `an attempt record has an invalid ${flag}` };
    }
  }

  // Never persist secret material — same rule as the scene checkpoints.
  if (/blob:|cookie|authorization|bearer|chrome-profile|access_token|KeyName=|Expires=/i.test(JSON.stringify(record))) {
    return { ok: false, reason: 'ledger contains forbidden secret material' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------

/** Canonical ledger path: `<outputsRoot>/<projectId>/flow-scenes/generation-attempts.json`. */
export function generationLedgerPath(input: { projectId: string; outputsRoot: string }): string {
  const id = String(input.projectId ?? '').trim();
  if (!id) throw new Error('generationLedgerPath requires a project id.');
  return path.join(path.resolve(input.outputsRoot), id, 'flow-scenes', GENERATION_LEDGER_FILENAME);
}

/**
 * Ledger path for the legacy `npm run flow` CLI, whose `--output-dir` is usually the project
 * output directory (`<outputsRoot>/<projectId>`). When it is not, the output dir itself is used as
 * the outputs root so the ledger still lives under the project's own output tree.
 */
export function resolveLegacyGenerationLedgerPath(input: { projectId: string; outputDir: string }): string {
  const id = String(input.projectId ?? '').trim();
  if (!id) throw new Error('resolveLegacyGenerationLedgerPath requires a project id.');
  const out = path.resolve(input.outputDir);
  const outputsRoot = path.basename(out) === id ? path.dirname(out) : out;
  return generationLedgerPath({ projectId: id, outputsRoot });
}

// ---------------------------------------------------------------------------------------
// Atomic I/O
// ---------------------------------------------------------------------------------------

export interface LedgerReadResult {
  ok: boolean;
  exists: boolean;
  ledger: GenerationAttemptLedger | null;
  reason?: string;
}

export async function readGenerationLedger(file: string, opts: { projectId: string }): Promise<LedgerReadResult> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { ok: true, exists: false, ledger: emptyGenerationLedger(opts.projectId) };
    return { ok: false, exists: false, ledger: null, reason: `cannot read ledger: ${String(error?.message ?? error).slice(0, 160)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, exists: true, ledger: null, reason: 'ledger is not valid JSON' };
  }
  const verdict = validateGenerationLedger(parsed, { projectId: opts.projectId });
  if (!verdict.ok) return { ok: false, exists: true, ledger: null, reason: verdict.reason };
  return { ok: true, exists: true, ledger: parsed as GenerationAttemptLedger };
}

/** Atomic write (temp sibling + rename). Never leaves a half-written budget behind. */
export async function writeGenerationLedger(file: string, ledger: GenerationAttemptLedger): Promise<string> {
  const verdict = validateGenerationLedger(ledger, { projectId: ledger?.project_id });
  if (!verdict.ok) throw new Error(`Refusing to write an invalid generation ledger: ${verdict.reason}`);
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
  return file;
}

/** Preserve a corrupted ledger next to the original instead of overwriting the evidence. */
export async function quarantineGenerationLedger(file: string, now: Date = new Date()): Promise<string | null> {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const target = `${file}.corrupt-${stamp}.json`;
  try {
    await fsp.rename(file, target);
    return target;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------------------

/**
 * Permanent failures: retrying them cannot succeed and would only spend credits.
 * Kept deliberately narrow — anything not matched here becomes UNKNOWN (which fails closed).
 */
const NON_RETRYABLE_PATTERNS: readonly RegExp[] = [
  /requires a non-empty prompt/i,
  /no animation prompt/i,
  /has no .*prompt/i,
  /refused \(/i,
  /refused:/i,
  /PROMPT_[A-Z_]+/,
  /INPUT_INVALID/,
  /PATH_INVALID/,
  /AUTHORIZATION_INVALID/,
  /GENERATION_NOT_AUTHORIZED/,
  /TARGET_MISMATCH/,
  /TARGET_UNRESOLVED/,
  /COMMITTED_CLIP_(MISMATCH|UNRESOLVED)/,
  /SCENE_LOCAL_UNSUPPORTED/,
  /FIRST_CLIP_TARGET_UNSUPPORTED/,
  /SCENE_STATE_(UNKNOWN|AMBIGUOUS)/,
  /not found in the pipeline/i,
  /is not locked/i,
  /has no .*tag/i,
  /voice verification failed/i,
  /project mismatch/i,
  /Path is not the canonical/i,
  /no Flow client/i,
];

/**
 * Transient failures that are safe to retry ONLY when the submission is proven absent.
 * A browser timeout is deliberately NOT assumed safe: it may hide a click that already landed.
 */
const RETRYABLE_PATTERNS: readonly RegExp[] = [
  /net::ERR_/,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE/,
  /socket hang up/i,
  /network (?:error|failure|unavailable)/i,
  /temporarily unavailable/i,
  /rate limit|too many requests|\b429\b/i,
  /\b(502|503|504)\b/,
  /navigation timeout/i,
  /target (?:page|closed)|browser has been closed/i,
  /timed? ?out|timeout/i,
];

/** Errors raised BEFORE a generate control was clicked (safe to treat as not submitted). */
const PRE_SUBMIT_PATTERNS: readonly RegExp[] = [
  /requires a non-empty prompt/i,
  /refused:/i,
  /is not visible/i,
  /is disabled/i,
  /is not mounted/i,
  /could not find/i,
  /not found in the pipeline/i,
  /is not locked/i,
  /PROMPT_[A-Z_]+/,
  /INPUT_INVALID/,
  /PATH_INVALID/,
  /AUTHORIZATION_INVALID/,
  /GENERATION_NOT_AUTHORIZED/,
  /TARGET_(MISMATCH|UNRESOLVED)/,
  /COMMITTED_CLIP_(MISMATCH|UNRESOLVED)/,
  /SCENE_STATE_(UNKNOWN|AMBIGUOUS)/,
];

const messageOf = (error: unknown): string => {
  const raw = typeof error === 'string' ? error : String((error as any)?.message ?? error ?? '');
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_FAILURE_REASON_LENGTH);
};

/**
 * Classify one failure. `submitted` is the OBSERVED submission state from the Flow client probe:
 *   true      — a generate control was pressed (credits may already be spent);
 *   false     — the client can prove nothing was pressed;
 *   'unknown' — no probe, or the probe could not answer.
 */
export function classifyGenerationFailure(input: {
  error: unknown;
  submitted: boolean | 'unknown';
}): { category: FailureCategory; submission: SubmissionState; reason: string } {
  const reason = messageOf(input.error);
  const nonRetryable = NON_RETRYABLE_PATTERNS.some((re) => re.test(reason));
  const preSubmitShape = PRE_SUBMIT_PATTERNS.some((re) => re.test(reason));

  const submission: SubmissionState = input.submitted === true
    ? 'SUBMITTED_CONFIRMED'
    : (input.submitted === false || preSubmitShape) ? 'NOT_SUBMITTED' : 'SUBMISSION_UNKNOWN';

  let category: FailureCategory;
  if (nonRetryable) category = 'NON_RETRYABLE';
  else if (submission !== 'NOT_SUBMITTED') category = 'UNKNOWN';
  else if (RETRYABLE_PATTERNS.some((re) => re.test(reason))) category = 'RETRYABLE';
  else category = 'UNKNOWN';

  return { category, submission, reason };
}

/**
 * Read the Flow client's monotonic submission latch. The probe reports `'unknown'` when the client
 * has no latch at all, so an older/injected client can never be mistaken for "nothing submitted".
 */
export function createSubmissionProbe(flow: any): { read(): boolean | 'unknown' } {
  const fn = flow && typeof flow.getGenerationSubmissionState === 'function'
    ? () => flow.getGenerationSubmissionState()
    : null;
  if (!fn) return { read: () => 'unknown' };
  let baselineAt: string | null;
  try {
    const initial = fn();
    baselineAt = typeof initial?.at === 'string' ? initial.at : null;
  } catch {
    return { read: () => 'unknown' };
  }
  return {
    read(): boolean | 'unknown' {
      try {
        const state = fn();
        if (!state || typeof state !== 'object') return 'unknown';
        const at = typeof state.at === 'string' ? state.at : null;
        if (state.submitted === true && at === null) return true;
        if (at !== baselineAt) return true;
        return false;
      } catch {
        return 'unknown';
      }
    },
  };
}

// ---------------------------------------------------------------------------------------
// Pure decision
// ---------------------------------------------------------------------------------------

export type GenerationDenialCode =
  | 'LEDGER_CORRUPT'
  | 'LEDGER_PROJECT_MISMATCH'
  | 'SUBJECT_BUDGET_EXHAUSTED'
  | 'PROJECT_BUDGET_EXHAUSTED'
  | 'MANUAL_APPROVAL_REQUIRED'
  | 'ATTEMPT_IN_PROGRESS';

export type GenerationDecision =
  | { action: 'ALLOW'; code: 'ALLOWED' | 'APPROVED_RECOVERY'; attemptNumber: number; reason: string }
  | { action: 'DENY'; code: GenerationDenialCode; reason: string };

export interface DecisionInput {
  ledger: GenerationAttemptLedger | null;
  ledgerCorrupt?: boolean;
  projectId: string;
  subject: GenerationSubject;
  policy: GenerationPolicy;
  approval?: GenerationApproval;
  now?: Date;
  pid?: number;
  host?: string;
  pidAlive?: (pid: number) => boolean;
}

/** Default liveness probe: same-host PIDs that no longer exist cannot still be generating. */
export function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

const subjectStateFor = (ledger: GenerationAttemptLedger, subject: GenerationSubject): GenerationSubjectState | undefined =>
  ledger.subjects[subjectKey(subject)];

function activeIsLive(input: DecisionInput, active: ActiveAttempt): boolean {
  const now = (input.now ?? new Date()).getTime();
  const started = Date.parse(active.started_at);
  const age = Number.isFinite(started) ? now - started : Number.POSITIVE_INFINITY;
  const host = input.host ?? os.hostname();
  const sameHost = active.host === host;
  // A same-host attempt whose process is gone is stale immediately, even inside the window.
  if (sameHost && typeof input.pidAlive === 'function' && Number.isInteger(active.pid)) {
    if (input.pidAlive(active.pid) === false) return false;
  }
  return age >= 0 && age < input.policy.activeAttemptStaleMs;
}

/**
 * PURE: may ONE more paid submission be made for this subject?
 *
 * Precedence (fail closed):
 *   1. corrupted/mismatched ledger       → DENY (approval may quarantine; caller does that)
 *   2. a live attempt for the subject    → DENY (concurrent duplicate)
 *   3. subject/project ceiling reached   → DENY (approval never raises the ceiling)
 *   4. ambiguous/unknown last failure    → DENY unless explicit approval covers the subject
 *   5. retryable pre-submit failure      → ALLOW while consecutive failures stay under the limit
 *   6. otherwise                         → ALLOW
 */
export function decideGenerationAttempt(input: DecisionInput): GenerationDecision {
  const subject = input.subject;
  const approvalCoversSubject = approvalCovers(input.approval, subject);

  if (input.ledgerCorrupt === true || !input.ledger) {
    if (approvalCoversSubject) {
      return {
        action: 'ALLOW',
        code: 'APPROVED_RECOVERY',
        attemptNumber: 1,
        reason: 'the attempt ledger is unreadable; operating under explicit recovery approval (the corrupt file will be quarantined).',
      };
    }
    return {
      action: 'DENY',
      code: 'LEDGER_CORRUPT',
      reason: 'the generation attempt ledger is unreadable; refusing to guess a budget. Inspect it, then re-run with explicit recovery approval to quarantine it.',
    };
  }

  if (input.ledger.project_id !== String(input.projectId)) {
    return {
      action: 'DENY',
      code: 'LEDGER_PROJECT_MISMATCH',
      reason: `the attempt ledger belongs to ${JSON.stringify(input.ledger.project_id)}, not ${JSON.stringify(String(input.projectId))}; refusing to share budgets across projects.`,
    };
  }

  const key = subjectKey(subject);
  const active = input.ledger.active[key];
  if (active && activeIsLive(input, active)) {
    return {
      action: 'DENY',
      code: 'ATTEMPT_IN_PROGRESS',
      reason: `attempt ${active.attempt_id} for ${key} is still in progress (pid ${active.pid}, started ${active.started_at}); refusing a concurrent duplicate.`,
    };
  }

  const state = subjectStateFor(input.ledger, subject);
  const attempts = state?.attempts ?? 0;
  const limit = subjectAttemptLimit(subject, input.policy);
  if (attempts >= limit) {
    return {
      action: 'DENY',
      code: 'SUBJECT_BUDGET_EXHAUSTED',
      reason: `${key} has used ${attempts}/${limit} of its attempt budget; explicit approval does not raise a ceiling — raise FLOW_MAX_ATTEMPTS_PER_${subject.kind === 'scene' ? 'SCENE' : 'ASSET'} deliberately if a new attempt is justified.`,
    };
  }
  if (input.ledger.project_attempts >= input.policy.maxAttemptsPerProject) {
    return {
      action: 'DENY',
      code: 'PROJECT_BUDGET_EXHAUSTED',
      reason: `the project has used ${input.ledger.project_attempts}/${input.policy.maxAttemptsPerProject} generation attempts.`,
    };
  }

  // No history → first attempt, allowed while inside the budget.
  if (!state || state.attempts === 0) {
    return { action: 'ALLOW', code: 'ALLOWED', attemptNumber: attempts + 1, reason: 'first recorded generation attempt for this subject.' };
  }

  // A crashed attempt (IN_PROGRESS record, stale marker) is ambiguous: it may have submitted.
  // A PREVIOUS SUCCESS is different: the work completed, so a fresh attempt is new work, not a
  // recovery — the remaining attempts budget still bounds it.
  const needsApproval = state.last_outcome === 'IN_PROGRESS'
    || state.last_outcome === 'BLOCKED'
    || state.last_failure_category === 'UNKNOWN'
    || state.last_failure_category === 'NON_RETRYABLE'
    || (state.last_outcome !== 'SUCCEEDED' && state.last_submission !== 'NOT_SUBMITTED')
    || state.consecutive_failures >= input.policy.maxConsecutiveFailures;

  if (needsApproval) {
    if (approvalCoversSubject) {
      return {
        action: 'ALLOW',
        code: 'APPROVED_RECOVERY',
        attemptNumber: attempts + 1,
        reason: `explicit recovery approval covers ${key}; the ambiguity recorded by the previous attempt is acknowledged.`,
      };
    }
    return {
      action: 'DENY',
      code: 'MANUAL_APPROVAL_REQUIRED',
      reason: `${key} needs explicit recovery approval: the previous attempt ended ${state.last_outcome} (${state.last_failure_category}, ${state.last_submission}) after ${state.consecutive_failures} consecutive failure(s). Inspect "npm run video -- flow-attempts", then set FLOW_APPROVE_GENERATION_RECOVERY=1 or FLOW_APPROVE_GENERATION_RECOVERY_SCENES=<n>.`,
    };
  }

  return { action: 'ALLOW', code: 'ALLOWED', attemptNumber: attempts + 1, reason: `the previous failure was a proven pre-submit retryable error; ${attempts}/${limit} attempts used.` };
}

// ---------------------------------------------------------------------------------------
// Pure ledger transitions
// ---------------------------------------------------------------------------------------

const trimHistory = (attempts: GenerationAttemptRecord[]): GenerationAttemptRecord[] =>
  attempts.length <= GENERATION_HISTORY_LIMIT ? attempts : attempts.slice(attempts.length - GENERATION_HISTORY_LIMIT);

export function beginAttemptOnLedger(input: {
  ledger: GenerationAttemptLedger;
  subject: GenerationSubject;
  attemptId: string;
  approvalGranted: boolean;
  now?: Date;
  pid?: number;
  host?: string;
}): GenerationAttemptLedger {
  const now = (input.now ?? new Date()).toISOString();
  const key = subjectKey(input.subject);
  const previous = input.ledger.subjects[key];
  const attemptNumber = (previous?.attempts ?? 0) + 1;

  const subjectState: GenerationSubjectState = {
    subject_kind: input.subject.kind,
    subject_id: String(input.subject.id),
    scene_number: input.subject.sceneNumber ?? null,
    attempts: attemptNumber,
    consecutive_failures: previous?.consecutive_failures ?? 0,
    last_outcome: previous?.last_outcome ?? null,
    last_failure_category: previous?.last_failure_category ?? 'NONE',
    last_submission: previous?.last_submission ?? 'SUBMISSION_UNKNOWN',
    last_attempt_at: now,
    manual_approval: input.approvalGranted ? 'APPROVED' : 'NOT_REQUIRED',
  };

  const record: GenerationAttemptRecord = {
    attempt_id: input.attemptId,
    project_id: input.ledger.project_id,
    attempt_number: attemptNumber,
    subject_kind: input.subject.kind,
    subject_id: String(input.subject.id),
    scene_number: input.subject.sceneNumber ?? null,
    started_at: now,
    finished_at: null,
    failure_category: 'NONE',
    failure_reason: null,
    submission: 'SUBMISSION_UNKNOWN',
    clip_downloaded: false,
    validation_passed: false,
    retry_permitted: false,
    manual_approval: input.approvalGranted ? 'APPROVED' : 'NOT_REQUIRED',
    outcome: 'IN_PROGRESS',
  };

  return {
    ...input.ledger,
    project_attempts: input.ledger.project_attempts + 1,
    subjects: { ...input.ledger.subjects, [key]: subjectState },
    active: {
      ...input.ledger.active,
      [key]: {
        attempt_id: input.attemptId,
        pid: input.pid ?? process.pid,
        host: input.host ?? os.hostname(),
        started_at: now,
      },
    },
    attempts: trimHistory([...(input.ledger.attempts ?? []), record]),
  };
}

export function finishAttemptOnLedger(input: {
  ledger: GenerationAttemptLedger;
  attemptId: string;
  subject: GenerationSubject;
  outcome: 'SUCCEEDED' | 'FAILED' | 'BLOCKED';
  category: FailureCategory;
  submission: SubmissionState;
  reason?: string | null;
  clipDownloaded?: boolean;
  validationPassed?: boolean;
  policy: GenerationPolicy;
  now?: Date;
}): GenerationAttemptLedger {
  const now = (input.now ?? new Date()).toISOString();
  const key = subjectKey(input.subject);
  const existingSubject = input.ledger.subjects[key];
  if (!existingSubject) throw new Error(`Cannot finish attempt ${input.attemptId}: subject ${key} has no state.`);

  const attempts = input.ledger.attempts.map((record) => record.attempt_id === input.attemptId
    ? {
      ...record,
      finished_at: now,
      failure_category: input.outcome === 'SUCCEEDED' ? 'NONE' as FailureCategory : input.category,
      failure_reason: input.outcome === 'SUCCEEDED' ? null : (input.reason ? input.reason.slice(0, MAX_FAILURE_REASON_LENGTH) : null),
      submission: input.submission,
      clip_downloaded: input.clipDownloaded === true,
      validation_passed: input.validationPassed === true,
      outcome: input.outcome,
    }
    : record);

  const limit = subjectAttemptLimit(input.subject, input.policy);
  const attemptsLeft = existingSubject.attempts < limit && input.ledger.project_attempts < input.policy.maxAttemptsPerProject;
  const autoEligible = input.outcome === 'FAILED'
    && input.category === 'RETRYABLE'
    && input.submission === 'NOT_SUBMITTED'
    && existingSubject.consecutive_failures + 1 < input.policy.maxConsecutiveFailures;
  const retryPermitted = attemptsLeft && autoEligible;

  const subjectState: GenerationSubjectState = {
    ...existingSubject,
    consecutive_failures: input.outcome === 'SUCCEEDED' ? 0 : existingSubject.consecutive_failures + 1,
    last_outcome: input.outcome,
    last_failure_category: input.outcome === 'SUCCEEDED' ? 'NONE' : input.category,
    last_submission: input.submission,
    last_attempt_at: now,
    // Manual approval state for the NEXT attempt: a proven pre-submit transient failure inside the
    // budget still retries automatically; every other failure needs a human.
    manual_approval: input.outcome === 'SUCCEEDED' || retryPermitted ? 'NOT_REQUIRED' : 'REQUIRED',
  };

  const finalized = attempts.map((record) => record.attempt_id === input.attemptId
    ? { ...record, retry_permitted: retryPermitted }
    : record);

  const active = { ...input.ledger.active };
  if (active[key]?.attempt_id === input.attemptId) delete active[key];

  return {
    ...input.ledger,
    consecutive_failures: input.outcome === 'SUCCEEDED' ? 0 : input.ledger.consecutive_failures + 1,
    subjects: { ...input.ledger.subjects, [key]: subjectState },
    active,
    attempts: finalized,
  };
}

/** Amend the current attempt with what actually happened to the clip on disk. */
export function recordAttemptArtifactsOnLedger(input: {
  ledger: GenerationAttemptLedger;
  attemptId: string;
  clipDownloaded: boolean;
  validationPassed: boolean;
}): GenerationAttemptLedger {
  return {
    ...input.ledger,
    attempts: input.ledger.attempts.map((record) => record.attempt_id === input.attemptId
      ? { ...record, clip_downloaded: input.clipDownloaded === true, validation_passed: input.validationPassed === true }
      : record),
  };
}

// ---------------------------------------------------------------------------------------
// I/O orchestration used by the generation paths
// ---------------------------------------------------------------------------------------

export interface BoundedAttempt {
  ledgerFile: string;
  ledger: GenerationAttemptLedger;
  /** The ledger as it was BEFORE this attempt was reserved (used only by a proven no-submit release). */
  ledgerBefore: GenerationAttemptLedger;
  attemptId: string;
  attemptNumber: number;
  subject: GenerationSubject;
  projectId: string;
  policy: GenerationPolicy;
}

export type BeginBoundedResult =
  | { ok: true; code: 'ALLOWED' | 'APPROVED_RECOVERY'; reason: string; handle: BoundedAttempt }
  | { ok: false; code: GenerationDenialCode; reason: string; ledgerCorrupt: boolean };

export interface BeginBoundedInput {
  ledgerFile: string;
  projectId: string;
  subject: GenerationSubject;
  policy?: Partial<GenerationPolicy>;
  approval?: GenerationApproval;
  now?: Date;
  pid?: number;
  host?: string;
  pidAlive?: (pid: number) => boolean;
  /** Injectable for tests; defaults to an on-disk quarantine rename. */
  quarantine?: (file: string, now: Date) => Promise<string | null>;
}

/**
 * Read the ledger, decide, and (when allowed) reserve the attempt BEFORE any Flow work.
 * A denied decision writes NOTHING: no credits were spent and no audit fiction is created.
 */
export async function beginBoundedGeneration(input: BeginBoundedInput): Promise<BeginBoundedResult> {
  const policy = resolveGenerationPolicy(input.policy);
  const approval = input.approval ?? NO_APPROVAL;
  const now = input.now ?? new Date();
  const read = await readGenerationLedger(input.ledgerFile, { projectId: input.projectId });

  let ledger = read.ledger;
  const corrupt = !read.ok;
  if (corrupt) {
    if (!approvalCovers(approval, input.subject)) {
      return { ok: false, code: 'LEDGER_CORRUPT', reason: read.reason ?? 'ledger is unreadable', ledgerCorrupt: true };
    }
    const quarantine = input.quarantine ?? quarantineGenerationLedger;
    const quarantined = await quarantine(input.ledgerFile, now).catch(() => null);
    if (!quarantined) {
      return { ok: false, code: 'LEDGER_CORRUPT', reason: `${read.reason ?? 'ledger is unreadable'}; the corrupt file could not be quarantined.`, ledgerCorrupt: true };
    }
    ledger = emptyGenerationLedger(input.projectId);
  }

  const decision = decideGenerationAttempt({
    ledger,
    ledgerCorrupt: false,
    projectId: input.projectId,
    subject: input.subject,
    policy,
    approval,
    now,
    pid: input.pid,
    host: input.host,
    pidAlive: input.pidAlive,
  });
  if (decision.action === 'DENY') {
    return { ok: false, code: decision.code, reason: decision.reason, ledgerCorrupt: corrupt };
  }

  const attemptId = randomUUID();
  const next = beginAttemptOnLedger({
    ledger: ledger!,
    subject: input.subject,
    attemptId,
    approvalGranted: decision.code === 'APPROVED_RECOVERY',
    now,
    pid: input.pid,
    host: input.host,
  });
  await writeGenerationLedger(input.ledgerFile, next);
  return {
    ok: true,
    code: decision.code,
    reason: decision.reason,
    handle: {
      ledgerFile: input.ledgerFile,
      ledger: next,
      ledgerBefore: ledger!,
      attemptId,
      attemptNumber: decision.attemptNumber,
      subject: input.subject,
      projectId: input.projectId,
      policy,
    },
  };
}

/**
 * Close an attempt. The write is best-effort from the caller's point of view (it returns a result),
 * because a persistence failure must never be reported as a generation success or failure.
 */
export async function finishBoundedGeneration(input: {
  handle: BoundedAttempt;
  outcome: 'SUCCEEDED' | 'FAILED' | 'BLOCKED';
  category?: FailureCategory;
  submission?: SubmissionState;
  reason?: string | null;
  clipDownloaded?: boolean;
  validationPassed?: boolean;
  now?: Date;
}): Promise<{ ok: boolean; reason?: string; ledger: GenerationAttemptLedger }> {
  const ledger = finishAttemptOnLedger({
    ledger: input.handle.ledger,
    attemptId: input.handle.attemptId,
    subject: input.handle.subject,
    outcome: input.outcome,
    category: input.category ?? (input.outcome === 'SUCCEEDED' ? 'NONE' : 'UNKNOWN'),
    submission: input.submission ?? (input.outcome === 'SUCCEEDED' ? 'SUBMITTED_CONFIRMED' : 'SUBMISSION_UNKNOWN'),
    reason: input.reason ?? null,
    clipDownloaded: input.clipDownloaded === true,
    validationPassed: input.validationPassed === true,
    policy: input.handle.policy,
    now: input.now,
  });
  try {
    await writeGenerationLedger(input.handle.ledgerFile, ledger);
    input.handle.ledger = ledger;
    return { ok: true, ledger };
  } catch (error: any) {
    input.handle.ledger = ledger;
    return { ok: false, reason: String(error?.message ?? error).slice(0, 200), ledger };
  }
}

/** Amend the CURRENT attempt record with download/validation truth (after finish or before it). */
export async function recordBoundedGenerationArtifacts(input: {
  handle: BoundedAttempt;
  clipDownloaded: boolean;
  validationPassed: boolean;
}): Promise<{ ok: boolean; reason?: string }> {
  const ledger = recordAttemptArtifactsOnLedger({
    ledger: input.handle.ledger,
    attemptId: input.handle.attemptId,
    clipDownloaded: input.clipDownloaded,
    validationPassed: input.validationPassed,
  });
  try {
    await writeGenerationLedger(input.handle.ledgerFile, ledger);
    input.handle.ledger = ledger;
    return { ok: true };
  } catch (error: any) {
    input.handle.ledger = ledger;
    return { ok: false, reason: String(error?.message ?? error).slice(0, 200) };
  }
}

/**
 * RELEASE a reservation that provably never submitted anything (all credit-free validation
 * failed). The attempt is removed from the ledger so a defective prompt/settings contract cannot
 * quietly exhaust a scene's credit budget. Callers MUST only use this when the submission probe
 * proves nothing was pressed; anything ambiguous must be finished, not released.
 */
export async function releaseBoundedGeneration(input: {
  handle: BoundedAttempt;
  reason: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const current = await readGenerationLedger(input.handle.ledgerFile, { projectId: input.handle.projectId });
  // Only release the exact reservation still on disk. A different/newer attempt is left alone.
  if (!current.ok || !current.ledger) return { ok: false, reason: 'the ledger could not be re-read; the attempt stays reserved.' };
  const key = subjectKey(input.handle.subject);
  if (current.ledger.active[key]?.attempt_id !== input.handle.attemptId) {
    return { ok: false, reason: 'the reservation is no longer the active attempt; leaving the ledger untouched.' };
  }
  try {
    await writeGenerationLedger(input.handle.ledgerFile, input.handle.ledgerBefore);
    input.handle.ledger = input.handle.ledgerBefore;
    return { ok: true };
  } catch (error: any) {
    return { ok: false, reason: String(error?.message ?? error).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------------------
// Reporting (read-only)
// ---------------------------------------------------------------------------------------

const stateLine = (key: string, state: GenerationSubjectState, policy: GenerationPolicy): string => {
  const limit = state.subject_kind === 'scene' ? policy.maxAttemptsPerScene : policy.maxAttemptsPerAsset;
  const last = state.last_outcome === null ? 'never attempted' : `${state.last_outcome} (${state.last_failure_category}, ${state.last_submission})`;
  return `${key.padEnd(18)} ${String(state.attempts).padStart(2)}/${limit} attempts  consecutive=${state.consecutive_failures}  last=${last}  approval=${state.manual_approval}`;
};

/** Human-readable audit view. Never includes prompts, cookies or signed URLs (the ledger has none). */
export function renderGenerationHistory(
  ledger: GenerationAttemptLedger,
  opts: { policy?: Partial<GenerationPolicy>; limit?: number } = {},
): string {
  const policy = resolveGenerationPolicy(opts.policy);
  const lines: string[] = [];
  lines.push(`project:  ${ledger.project_id}`);
  lines.push(`attempts: ${ledger.project_attempts}/${policy.maxAttemptsPerProject} project budget used`);
  lines.push(`subjects: ${Object.keys(ledger.subjects).length}`);
  const keys = Object.keys(ledger.subjects).sort();
  if (!keys.length) lines.push('(no generation attempts recorded)');
  for (const key of keys) lines.push(`  ${stateLine(key, ledger.subjects[key], policy)}`);

  const limit = Math.max(1, opts.limit ?? 20);
  const recent = ledger.attempts.slice(-limit).reverse();
  if (recent.length) {
    lines.push('');
    lines.push(`recent attempts (newest first, ${recent.length} of ${ledger.attempts.length}):`);
    for (const attempt of recent) {
      const when = attempt.finished_at ?? attempt.started_at;
      const reason = attempt.failure_reason ? ` — ${attempt.failure_reason.slice(0, 160)}` : '';
      lines.push(
        `  #${attempt.attempt_number} ${attempt.subject_kind}:${attempt.subject_id} ${when} `
        + `${attempt.outcome} ${attempt.failure_category}/${attempt.submission} `
        + `downloaded=${attempt.clip_downloaded} validated=${attempt.validation_passed} retry=${attempt.retry_permitted} approval=${attempt.manual_approval}${reason}`,
      );
    }
  }
  if (Object.keys(ledger.active).length) {
    lines.push('');
    lines.push('active attempts:');
    for (const [key, active] of Object.entries(ledger.active)) lines.push(`  ${key} pid=${active.pid} started=${active.started_at}`);
  }
  return lines.join('\n');
}
