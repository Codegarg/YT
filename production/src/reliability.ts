/**
 * PHASE 5 — long-form production reliability view.
 *
 * This module is a DERIVED, read-only view over evidence that already exists:
 *
 *   · `pipeline.json` / scene inspection (`sceneState.ts`)
 *   · per-scene render sidecars + project state (`projectState.ts`)
 *   · downstream stage sidecars (`downstreamStages.ts` / `productionOrchestrator.ts`)
 *   · the Phase 4 QA report summary and the human approval record (`approval.ts`)
 *
 * It deliberately does NOT introduce a competing state store. `pipeline.json` stays authoritative
 * for story/scene data, the Phase 2 generation ledger stays authoritative for paid submissions, and
 * `state.json` stays authoritative for the persisted project checkpoint. Nothing here writes,
 * renders, opens a browser or spends credits.
 *
 * What it adds is the missing cross-stage vocabulary the long-form workflow needs:
 *
 *   · an explicit state per production stage (pending/running/completed/failed/blocked/skipped/stale)
 *   · validated transitions between those states
 *   · stable input/output fingerprints per stage
 *   · a precise resume decision ("earliest genuinely incomplete or invalid stage")
 *   · a secret-free, machine-path-free observability record
 */

import crypto from 'node:crypto';
import { SECRET_REDACTION_RE } from './projectState.js';
import { sceneDefinitionFingerprint } from './sceneState.js';

export const RELIABILITY_SCHEMA_VERSION = 1;

/**
 * The long-form production stages, in dependency order.
 *
 * STORY → STORY_VALIDATION → SCENE_PLANNING → NARRATION → GENERATION → SCENE_ASSEMBLY →
 * AUDIO_MIX → MUSIC_BED → FINAL_RENDER → MEDIA_QA → HUMAN_REVIEW → APPROVAL → PUBLISH_HANDOFF
 *
 * `SCENE_ASSEMBLY`/`AUDIO_MIX`/`MUSIC_BED`/`FINAL_RENDER` map 1:1 onto the existing downstream
 * EDIT/MIX/BED/TITLE stages. No new media stage is invented.
 */
export const RELIABILITY_STAGES = [
  'STORY',
  'STORY_VALIDATION',
  'SCENE_PLANNING',
  'NARRATION',
  'GENERATION',
  'SCENE_ASSEMBLY',
  'AUDIO_MIX',
  'MUSIC_BED',
  'FINAL_RENDER',
  'MEDIA_QA',
  'HUMAN_REVIEW',
  'APPROVAL',
  'PUBLISH_HANDOFF',
] as const;

export type ReliabilityStage = (typeof RELIABILITY_STAGES)[number];

/** Production stages that can actually do work (everything before the human/QA gates). */
export const PRODUCTION_STAGES: readonly ReliabilityStage[] = [
  'STORY', 'STORY_VALIDATION', 'SCENE_PLANNING', 'NARRATION', 'GENERATION',
  'SCENE_ASSEMBLY', 'AUDIO_MIX', 'MUSIC_BED', 'FINAL_RENDER',
];

/** Human / QA gates after the media is produced. They never execute media work. */
export const REVIEW_STAGES: readonly ReliabilityStage[] = [
  'MEDIA_QA', 'HUMAN_REVIEW', 'APPROVAL', 'PUBLISH_HANDOFF',
];

export type StageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'skipped' | 'stale';

export const STAGE_STATUSES: readonly StageStatus[] = [
  'pending', 'running', 'completed', 'failed', 'blocked', 'skipped', 'stale',
];

/**
 * Legal state transitions.
 *
 * The important safety properties:
 *   · `completed` can only be left by invalidation (`stale`/`pending`), never by an ad-hoc edit.
 *   · `pending`/`running` never jump straight to `completed` without the caller recording that its
 *     output was verified — the caller is responsible for that, and this table makes the intent
 *     explicit instead of allowing arbitrary jumps.
 *   · `blocked` is a deliberate, non-terminal state: the pipeline is waiting for a human input or an
 *     approval, not broken.
 */
export const LEGAL_STAGE_TRANSITIONS: Record<StageStatus, readonly StageStatus[]> = {
  pending: ['running', 'blocked', 'skipped', 'completed', 'stale'],
  running: ['completed', 'failed', 'blocked', 'pending'],
  completed: ['stale', 'pending'],
  failed: ['pending', 'running', 'blocked', 'skipped'],
  blocked: ['pending', 'running', 'skipped', 'failed'],
  skipped: ['pending', 'running', 'completed'],
  stale: ['pending', 'running', 'completed', 'blocked'],
};

export function isStageStatus(value: unknown): value is StageStatus {
  return STAGE_STATUSES.includes(String(value) as StageStatus);
}

export function isLegalStageTransition(from: StageStatus, to: StageStatus): boolean {
  if (from === to) return true;
  return (LEGAL_STAGE_TRANSITIONS[from] ?? []).includes(to);
}

export function assertLegalStageTransition(from: StageStatus, to: StageStatus): void {
  if (!isStageStatus(from) || !isStageStatus(to)) throw new Error(`Unknown stage status ${String(from)} -> ${String(to)}.`);
  if (!isLegalStageTransition(from, to)) throw new Error(`Illegal stage status transition ${from} -> ${to}.`);
}

// ---------------------------------------------------------------------------------------
// Evidence input (everything is optional; missing evidence fails closed as pending/blocked)
// ---------------------------------------------------------------------------------------

export interface ReliabilitySceneEvidence {
  sceneNumber: number;
  readiness: string;
  outputState: string;
  outputHash?: string | null;
  renderKey?: string | null;
}

export interface ReliabilityQaEvidence {
  status: 'PASS' | 'WARNING' | 'FAIL' | 'SKIPPED';
  artifactHash?: string | null;
  reportHash?: string | null;
  generatedAt?: string | null;
  reportStatus?: string;
}

export interface ReliabilityEvidence {
  projectId: string;
  now?: string;
  /** Story evidence. `present`/`valid` describe the pipeline on disk right now. */
  pipeline?: { present: boolean; valid: boolean; scenes?: any[]; reason?: string } | null;
  /** Phase 3 report, when a validator actually ran in this pass. */
  storyValidation?: { available?: boolean; status?: string; blockers?: string[]; warnings?: string[]; reason?: string } | null;
  /** Gate decision, when the workflow computed one. */
  storyGate?: { allowed: boolean; code?: string; reason?: string } | null;
  /** Scene inspection evidence (priorOutputStates + work items are enough). */
  scenes?: ReliabilitySceneEvidence[] | null;
  /** Explicit narration absence evidence (scene numbers). */
  narration?: { required?: number[]; missing?: number[]; present?: number[] } | null;
  /** Downstream stage plan/execution evidence. */
  downstream?: {
    states: Record<string, string>;
    failedStages?: string[];
    executedStages?: string[];
    keys?: Record<string, string>;
  } | null;
  failedScenes?: number[] | null;
  qa?: ReliabilityQaEvidence | null;
  approval?: { status: string; finalOutputHash?: string | null; reason?: string } | null;
  publish?: { readiness: string; publishable?: boolean } | null;
  /** Optional retry counters, already measured by the caller. */
  retryCounts?: Partial<Record<ReliabilityStage, number>> | null;
}

export interface ReliabilityStageRecord {
  stage: ReliabilityStage;
  status: StageStatus;
  /** Human-readable, secret-free explanation of the decision. */
  detail: string;
  /** Stable fingerprint of the stage's declared inputs, or null when unknown. */
  input_fingerprint: string | null;
  /** Stable fingerprint of the stage's verified output, or null when unknown. */
  output_fingerprint: string | null;
  /** True when a VERIFIED existing output may be reused without re-running the stage. */
  reusable: boolean;
  retry_count: number;
  error_category: string | null;
  recovery_decision: string;
  reuse_or_rerender_reason: string;
}

export interface ReliabilityBlocker {
  stage: ReliabilityStage;
  category: string;
  detail: string;
}

export interface ReliabilityReport {
  schema_version: number;
  project_id: string;
  generated_at: string;
  read_only: true;
  stages: ReliabilityStageRecord[];
  /** Earliest production stage that is not safely complete, or null when all are complete. */
  resume_from: ReliabilityStage | null;
  /** First QA/human gate that is not yet satisfied, or null when all are satisfied. */
  next_gate: ReliabilityStage | null;
  /** Stages this pass would (re)run, in dependency order. */
  work_set: ReliabilityStage[];
  /** Completed stages whose verified outputs are reused as-is. */
  reusable: ReliabilityStage[];
  blockers: ReliabilityBlocker[];
  /** Always false here: this module never authorises publishing. */
  publishable: false;
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

const sha = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
const sortedNumbers = (values: Iterable<number>): number[] => [...values].sort((a, b) => a - b);

function normalizeSceneList(scenes: ReliabilitySceneEvidence[] | null | undefined): ReliabilitySceneEvidence[] {
  return (scenes ?? []).filter((s) => Number.isInteger(Number(s?.sceneNumber))).map((s) => ({ ...s, sceneNumber: Number(s.sceneNumber) }));
}

function storyFingerprint(evidence: ReliabilityEvidence, scenes: ReliabilitySceneEvidence[]): string | null {
  const pipelineScenes = Array.isArray(evidence.pipeline?.scenes) ? evidence.pipeline!.scenes! : null;
  if (pipelineScenes && pipelineScenes.length > 0) {
    const parts = pipelineScenes
      .map((s: any) => `${Number(s?.scene_number)}:${sha(sceneDefinitionFingerprint(s))}`)
      .sort();
    return sha(`story|v1|${parts.join('|')}`);
  }
  if (scenes.length > 0) return sha(`story|v1|${scenes.map((s) => s.sceneNumber).sort((a, b) => a - b).join(',')}`);
  return null;
}

function sceneSetFingerprint(scenes: ReliabilitySceneEvidence[]): string | null {
  if (scenes.length === 0) return null;
  return sha(`scenes|v1|${scenes
    .map((s) => `${s.sceneNumber}:${String(s.renderKey ?? 'nokey')}:${String(s.outputHash ?? 'none')}`)
    .sort()
    .join('|')}`);
}

function generationOutputFingerprint(scenes: ReliabilitySceneEvidence[]): string | null {
  const rendered = scenes.filter((s) => typeof s.outputHash === 'string' && s.outputHash);
  if (rendered.length === 0) return null;
  return sha(`generation|v1|${rendered.map((s) => `${s.sceneNumber}:${s.outputHash}`).sort().join('|')}`);
}

const DOWNSTREAM_STAGE_MAP: Partial<Record<ReliabilityStage, string>> = {
  SCENE_ASSEMBLY: 'EDIT',
  AUDIO_MIX: 'MIX',
  MUSIC_BED: 'BED',
  FINAL_RENDER: 'TITLE',
};

/** Map the existing stage state vocabulary onto the reliability vocabulary. */
export function mapDownstreamState(state: unknown, failed: boolean): { status: StageStatus; reason: string } {
  if (failed) return { status: 'failed', reason: 'the stage was attempted and failed' };
  switch (String(state ?? 'NOT_STARTED')) {
    case 'CURRENT': return { status: 'completed', reason: 'verified output matches the current dependency key' };
    case 'STALE': return { status: 'stale', reason: 'a dependency changed; the output is no longer current' };
    case 'STALE_UNKNOWN': return { status: 'stale', reason: 'the output exists without a trustworthy dependency key' };
    case 'INVALID_OUTPUT': return { status: 'stale', reason: 'the recorded output failed verification' };
    case 'MISSING_OUTPUT': return { status: 'stale', reason: 'the recorded output is missing' };
    default: return { status: 'pending', reason: 'no verified stage output exists yet' };
  }
}

function errorCategoryFor(status: StageStatus, stage: ReliabilityStage, hasQaFail: boolean): string | null {
  if (status === 'completed' || status === 'skipped' || status === 'pending' || status === 'running') return null;
  if (status === 'stale') return 'OUTPUT_STALE';
  if (status === 'blocked') return 'INPUTS_BLOCKED';
  if (stage === 'MEDIA_QA' || hasQaFail) return 'QA_FAILED';
  if (stage === 'GENERATION') return 'SCENE_FAILED';
  if (stage === 'STORY' || stage === 'SCENE_PLANNING') return 'INVALID_PIPELINE';
  return 'STAGE_FAILED';
}

function record(
  stage: ReliabilityStage,
  status: StageStatus,
  detail: string,
  opts: {
    input?: string | null;
    output?: string | null;
    reusable?: boolean;
    retry?: number;
    recovery?: string;
    reason?: string;
    hasQaFail?: boolean;
  } = {},
): ReliabilityStageRecord {
  return {
    stage,
    status,
    detail: safeLogText(detail),
    input_fingerprint: opts.input ?? null,
    output_fingerprint: opts.output ?? null,
    reusable: opts.reusable === true,
    retry_count: Number.isInteger(opts.retry) && (opts.retry as number) > 0 ? Number(opts.retry) : 0,
    error_category: errorCategoryFor(status, stage, opts.hasQaFail === true),
    recovery_decision: safeLogText(opts.recovery ?? defaultRecovery(status)),
    reuse_or_rerender_reason: safeLogText(opts.reason ?? defaultReason(status)),
  };
}

function defaultRecovery(status: StageStatus): string {
  switch (status) {
    case 'completed': return 'reuse-verified-output';
    case 'skipped': return 'skip-not-applicable';
    case 'running': return 'resume-inspect-running-marker';
    case 'failed': return 'retry-after-diagnosis';
    case 'blocked': return 'wait-for-input-or-approval';
    case 'stale': return 'rerun-invalidated-stage';
    default: return 'run-missing-stage';
  }
}

function defaultReason(status: StageStatus): string {
  switch (status) {
    case 'completed': return 'no relevant input changed';
    case 'skipped': return 'stage did not apply to this run';
    case 'running': return 'a previous attempt was interrupted before it recorded completion';
    case 'failed': return 'the recorded attempt failed';
    case 'blocked': return 'a required input or human decision is missing';
    case 'stale': return 'a dependency changed or the output is no longer verifiable';
    default: return 'no verified output exists';
  }
}

/**
 * Redact anything that must never reach a persisted/printed log: credentials, signed-URL markers,
 * private browser-profile locations and absolute machine paths.
 *
 * The credential pattern is the SAME shared `SECRET_REDACTION_RE` used by `state.json`, so the two
 * can never drift. Path redaction is deliberately conservative: it only rewrites path-looking
 * tokens, never ordinary stage names or hashes.
 */
export function safeLogText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let text = raw
    .replace(SECRET_REDACTION_RE, '[redacted]')
    .replace(/\b(?:blob:|chrome-profile|KeyName=|Expires=|Signature=)[^\s"']*/gi, '[redacted]')
    // Windows absolute paths (C:\..., \\server\share\...)
    .replace(/\b[A-Za-z]:[\\/][^\s"',;)]*/g, '<path>')
    .replace(/\\\\[^\s"',;)]+/g, '<path>')
    // POSIX absolute paths (but never a bare "/" or a URL scheme).
    .replace(/(?<![\w:./-])\/(?:[^\s"'/]+\/)+[^\s"',;)]*/g, '<path>');
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}

// ---------------------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------------------

export function deriveReliability(evidence: ReliabilityEvidence): ReliabilityReport {
  const projectId = String(evidence?.projectId ?? '').trim();
  if (!projectId) throw new Error('deriveReliability requires a project id.');

  const scenes = normalizeSceneList(evidence.scenes);
  const story = storyFingerprint(evidence, scenes);
  const sceneSet = sceneSetFingerprint(scenes);
  const generationOutput = generationOutputFingerprint(scenes);
  const retry = (stage: ReliabilityStage): number => Number(evidence.retryCounts?.[stage] ?? 0) || 0;

  const stages: ReliabilityStageRecord[] = [];

  // ---- STORY ----
  {
    const present = evidence.pipeline?.present === true;
    const valid = evidence.pipeline?.valid === true;
    if (!present) {
      stages.push(record('STORY', 'blocked', evidence.pipeline?.reason ?? 'pipeline.json is absent', {
        input: null, recovery: 'create-the-story-first', reason: 'the story boundary has not run',
      }));
    } else if (!valid) {
      stages.push(record('STORY', 'failed', evidence.pipeline?.reason ?? 'pipeline.json is malformed or incomplete', {
        input: story, recovery: 'regenerate-or-repair-the-pipeline', reason: 'the pipeline failed structural validation',
      }));
    } else {
      stages.push(record('STORY', 'completed', 'pipeline.json is present and structurally valid', {
        input: story, output: story, reusable: true,
      }));
    }
  }

  // ---- STORY_VALIDATION (Phase 3) ----
  {
    const sv = evidence.storyValidation;
    const gate = evidence.storyGate;
    if (gate && gate.allowed === false) {
      stages.push(record('STORY_VALIDATION', 'blocked', `story gate ${gate.code ?? 'BLOCKED'}: ${gate.reason ?? 'blocked'}`, {
        input: story, recovery: 'fix-the-story-findings', reason: 'Phase 3 blocks production for this story',
      }));
    } else if (!sv) {
      stages.push(record('STORY_VALIDATION', 'skipped', 'no Phase 3 validator ran in this pass', {
        input: story, recovery: 'run-video-validate', reason: 'validation is not bypassed; it simply was not part of this command',
      }));
    } else if (sv.available === false) {
      stages.push(record('STORY_VALIDATION', 'blocked', sv.reason ?? 'the story validator is unavailable', {
        input: story, recovery: 'install-or-configure-the-validator', reason: 'a missing validator is never treated as a clean story',
      }));
    } else if ((sv.blockers ?? []).length > 0) {
      stages.push(record('STORY_VALIDATION', 'blocked', `${sv.blockers!.length} Phase 3 blocker(s)`, {
        input: story, recovery: 'fix-the-story-findings', reason: 'Phase 3 blockers stop production',
      }));
    } else {
      stages.push(record('STORY_VALIDATION', 'completed', `${(sv.warnings ?? []).length} warning(s), 0 blocker(s)`, {
        input: story, output: sha(`story-validation|${sv.status ?? 'OK'}|${(sv.warnings ?? []).length}`), reusable: true,
      }));
    }
  }

  // ---- SCENE_PLANNING ----
  {
    const invalid = scenes.filter((s) => String(s.readiness).toUpperCase() === 'INVALID');
    if (scenes.length === 0) {
      stages.push(record('SCENE_PLANNING', 'failed', 'the pipeline declares no inspectable scenes', {
        input: story, recovery: 'repair-the-scene-manifest', reason: 'no scene can be planned or rendered',
      }));
    } else if (invalid.length > 0) {
      stages.push(record('SCENE_PLANNING', 'failed', `scene(s) ${invalid.map((s) => s.sceneNumber).join(', ')} are INVALID`, {
        input: story, recovery: 'fix-the-invalid-scene-inputs', reason: 'an invalid scene blocks planning',
      }));
    } else {
      stages.push(record('SCENE_PLANNING', 'completed', `${scenes.length} scene(s) inspected with resolvable render inputs`, {
        input: story, output: sceneSet, reusable: true,
      }));
    }
  }

  // ---- NARRATION (external input) ----
  {
    const missing = sortedNumbers(new Set<number>([
      ...(evidence.narration?.missing ?? []).map(Number),
      ...scenes.filter((s) => String(s.readiness) === 'WAITING_FOR_NARRATION').map((s) => s.sceneNumber),
    ])).filter((n) => Number.isInteger(n));
    const present = (evidence.narration?.present ?? []).length
      || scenes.filter((s) => String(s.readiness) !== 'WAITING_FOR_NARRATION').length;
    if (missing.length > 0) {
      stages.push(record('NARRATION', 'blocked', `missing narration for scene(s) ${missing.join(', ')}`, {
        input: sceneSet, recovery: 'supply-the-narration-audio', reason: 'narration is a required external input before mixing',
      }));
    } else if (scenes.length === 0) {
      stages.push(record('NARRATION', 'pending', 'no scenes to narrate', { input: null }));
    } else {
      stages.push(record('NARRATION', 'completed', `${present} scene(s) have narration evidence or require none`, {
        input: sceneSet, output: sha(`narration|${sortedNumbers(scenes.map((s) => s.sceneNumber)).join(',')}`), reusable: true,
      }));
    }
  }

  // ---- GENERATION ----
  {
    const failedScenes = new Set((evidence.failedScenes ?? []).map(Number));
    const failedNow = scenes.filter((s) => failedScenes.has(s.sceneNumber) || String(s.outputState) === 'INVALID_OUTPUT');
    const missing = scenes.filter((s) => !failedScenes.has(s.sceneNumber) && String(s.outputState) === 'MISSING_OUTPUT');
    const staleOrUnknown = scenes.filter((s) => ['STALE', 'STALE_UNKNOWN'].includes(String(s.outputState)));
    const current = scenes.filter((s) => String(s.outputState) === 'CURRENT');
    if (scenes.length === 0) {
      stages.push(record('GENERATION', 'pending', 'no scenes to generate', { input: sceneSet, retry: retry('GENERATION') }));
    } else if (failedNow.length > 0) {
      stages.push(record('GENERATION', 'failed', `scene(s) ${failedNow.map((s) => s.sceneNumber).join(', ')} failed or produced invalid media`, {
        input: sceneSet, output: generationOutput, retry: retry('GENERATION'),
        recovery: 'diagnose-the-scene-and-resume',
        reason: 'a failed scene is never recorded as CURRENT; existing valid clips are reused',
      }));
    } else if (current.length === scenes.length) {
      stages.push(record('GENERATION', 'completed', `${current.length} scene output(s) CURRENT with matching render keys`, {
        input: sceneSet, output: generationOutput, reusable: true, retry: retry('GENERATION'),
      }));
    } else if (missing.length === scenes.length) {
      stages.push(record('GENERATION', 'pending', `${missing.length} scene(s) not rendered yet`, {
        input: sceneSet, retry: retry('GENERATION'),
      }));
    } else {
      stages.push(record('GENERATION', 'stale', `${staleOrUnknown.length} scene(s) exist but are not current; ${current.length} reusable`, {
        input: sceneSet, output: generationOutput, retry: retry('GENERATION'),
        recovery: 'rerun-only-the-invalidated-scenes',
        reason: 'current scene outputs are reused; only invalidated scenes are re-produced',
      }));
    }
  }

  // ---- downstream media stages ----
  for (const stage of ['SCENE_ASSEMBLY', 'AUDIO_MIX', 'MUSIC_BED', 'FINAL_RENDER'] as const) {
    const downstreamStage = DOWNSTREAM_STAGE_MAP[stage]!;
    const failed = (evidence.downstream?.failedStages ?? []).includes(downstreamStage);
    const mapped = mapDownstreamState(evidence.downstream?.states?.[downstreamStage], failed);
    const key = evidence.downstream?.keys?.[downstreamStage] ?? null;
    stages.push(record(stage, mapped.status, `${downstreamStage}: ${mapped.reason}`, {
      input: key,
      output: mapped.status === 'completed' ? key : (generationOutput ?? null),
      reusable: mapped.status === 'completed',
      retry: retry(stage),
      recovery: mapped.status === 'failed' ? 'diagnose-and-rerun-stage' : defaultRecovery(mapped.status),
      reason: mapped.reason,
    }));
  }

  const qa = evidence.qa ?? null;
  const qaFail = qa?.status === 'FAIL';
  const approvalStatus = String(evidence.approval?.status ?? 'NOT_APPROVED');
  const approvalHash = String(evidence.approval?.finalOutputHash ?? '').toLowerCase();
  const qaHash = String(qa?.artifactHash ?? '').toLowerCase();
  const hashBound = Boolean(qaHash) && approvalHash === qaHash;

  // ---- MEDIA_QA (Phase 4) ----
  {
    if (!qa) {
      stages.push(record('MEDIA_QA', 'pending', 'no media QA evidence recorded for the current artifact', {
        input: generationOutput, recovery: 'run-video-qa-or-approve-with-qa', reason: 'QA evidence must be bound to the exact artifact',
      }));
    } else if (qaFail) {
      stages.push(record('MEDIA_QA', 'failed', `media QA status ${qa.status}`, {
        input: qa.artifactHash ?? generationOutput, output: qa.reportHash ?? null, hasQaFail: true,
        recovery: 'fix-the-media-findings', reason: 'a QA FAIL blocks approval',
      }));
    } else if (qa.status === 'SKIPPED') {
      stages.push(record('MEDIA_QA', 'skipped', 'media QA was explicitly skipped', {
        input: qa.artifactHash ?? generationOutput, hasQaFail: false,
        recovery: 'review-manually', reason: 'SKIPPED is never treated as PASS',
      }));
    } else {
      stages.push(record('MEDIA_QA', 'completed', `media QA status ${qa.status}`, {
        input: qa.artifactHash ?? generationOutput, output: qa.reportHash ?? qa.artifactHash ?? null, reusable: true,
      }));
    }
  }

  // ---- HUMAN_REVIEW ----
  if (approvalStatus === 'APPROVED') {
    stages.push(record('HUMAN_REVIEW', 'completed', 'a human approval record exists for the current artifact', {
      input: qaHash || generationOutput, output: approvalHash || null, reusable: true,
    }));
  } else if (approvalStatus === 'STALE_APPROVAL') {
    stages.push(record('HUMAN_REVIEW', 'stale', evidence.approval?.reason ?? 'the approval no longer matches the artifact', {
      input: qaHash || generationOutput, recovery: 'review-the-new-artifact',
      reason: 'changed media invalidates the previous human decision',
    }));
  } else if (qa && qa.status !== 'FAIL') {
    stages.push(record('HUMAN_REVIEW', 'pending', 'media is ready; an explicit human decision is required', {
      input: qaHash || generationOutput, recovery: 'ask-the-human', reason: 'approval is never automatic',
    }));
  } else {
    stages.push(record('HUMAN_REVIEW', 'blocked', 'review cannot start until QA is available and passing', {
      input: generationOutput, recovery: 'complete-media-qa-first',
    }));
  }

  // ---- APPROVAL (explicit, hash-bound) ----
  if (approvalStatus === 'APPROVED') {
    if (qaHash && !hashBound) {
      stages.push(record('APPROVAL', 'stale', 'the approval hash does not match the QA artifact hash', {
        input: qaHash, output: approvalHash || null, recovery: 're-approve-the-current-artifact',
        reason: 'approval is bound to one exact artifact',
      }));
    } else {
      stages.push(record('APPROVAL', 'completed', 'approval is recorded for the current artifact', {
        input: approvalHash || qaHash, output: approvalHash || null, reusable: true,
      }));
    }
  } else if (approvalStatus === 'STALE_APPROVAL') {
    stages.push(record('APPROVAL', 'stale', evidence.approval?.reason ?? 'the recorded approval is stale', {
      input: qaHash || generationOutput, recovery: 're-approve-after-review',
    }));
  } else {
    stages.push(record('APPROVAL', 'pending', evidence.approval?.reason ?? 'no approval has been recorded', {
      input: qaHash || generationOutput, recovery: 'wait-for-explicit-human-approval', reason: 'approval is a human action',
    }));
  }

  // ---- PUBLISH_HANDOFF (always external and always blocked here) ----
  {
    const readiness = evidence.publish?.readiness ?? (approvalStatus === 'APPROVED' && (hashBound || !qaHash)
      ? 'PUBLISH_BLOCKED_UNTIL_EXTERNAL_PUBLISHER'
      : approvalStatus === 'STALE_APPROVAL' ? 'PUBLISH_BLOCKED_STALE_APPROVAL' : 'PUBLISH_BLOCKED_NOT_APPROVED');
    const ready = readiness === 'PUBLISH_BLOCKED_UNTIL_EXTERNAL_PUBLISHER';
    stages.push(record('PUBLISH_HANDOFF', 'blocked', readiness, {
      input: approvalHash || qaHash || generationOutput,
      output: ready ? approvalHash || qaHash || null : null,
      recovery: ready ? 'await-explicit-external-publish-confirmation' : 'approve-before-publishing',
      reason: ready
        ? 'rendering success never publishes; the external publisher still needs an explicit human confirmation'
        : 'publishing is blocked until the artifact is approved',
    }));
  }

  const isDone = (s: ReliabilityStageRecord) => s.status === 'completed' || s.status === 'skipped';
  const production = stages.filter((s) => PRODUCTION_STAGES.includes(s.stage));
  // PUBLISH_HANDOFF is intentionally NOT a gate: it is an external action that stays blocked until
  // a human publishes, so it must never make a finished project look permanently incomplete.
  const reviewGates = stages.filter((s) => REVIEW_STAGES.includes(s.stage) && s.stage !== 'PUBLISH_HANDOFF');
  const resumeFrom = production.find((s) => !isDone(s))?.stage ?? null;
  const firstUnsatisfiedGate = reviewGates.find((s) => !isDone(s))?.stage ?? null;
  const nextGate = firstUnsatisfiedGate;
  const workSet = [
    ...production.filter((s) => !isDone(s)).map((s) => s.stage),
    ...(firstUnsatisfiedGate ? [firstUnsatisfiedGate] : []),
  ];

  // PUBLISH_HANDOFF is excluded: it is a permanent external handoff state, not a blocker, and
  // including it would make every report look blocked even for a finished, approved programme.
  const blockers: ReliabilityBlocker[] = stages
    .filter((s) => (s.status === 'failed' || s.status === 'blocked') && s.stage !== 'PUBLISH_HANDOFF')
    .map((s) => ({ stage: s.stage, category: s.error_category ?? 'STAGE_BLOCKED', detail: s.detail }));

  return {
    schema_version: RELIABILITY_SCHEMA_VERSION,
    project_id: projectId,
    generated_at: evidence.now ?? new Date().toISOString(),
    read_only: true,
    stages,
    resume_from: resumeFrom,
    next_gate: nextGate,
    work_set: workSet,
    reusable: stages.filter((s) => s.reusable && s.status === 'completed').map((s) => s.stage),
    blockers,
    publishable: false,
  };
}

// ---------------------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------------------

export interface StageLogEntry {
  schema_version: number;
  ts: string;
  project_id: string;
  stage: ReliabilityStage;
  status: StageStatus;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  input_fingerprint: string | null;
  output_fingerprint: string | null;
  retry_count: number;
  error_category: string | null;
  recovery_decision: string;
  reuse_or_rerender_reason: string;
  detail: string;
}

/** Build ONE bounded, secret-free stage log record. Never throws on partial input. */
export function buildStageLogEntry(input: {
  projectId: string;
  stage: ReliabilityStage;
  status: StageStatus;
  startedAt?: string | null;
  endedAt?: string | null;
  inputFingerprint?: string | null;
  outputFingerprint?: string | null;
  retryCount?: number;
  errorCategory?: string | null;
  recoveryDecision?: string;
  reuseOrRerenderReason?: string;
  detail?: string;
  now?: string;
}): StageLogEntry {
  const started = typeof input.startedAt === 'string' ? input.startedAt : null;
  const ended = typeof input.endedAt === 'string' ? input.endedAt : null;
  const startMs = started ? Date.parse(started) : NaN;
  const endMs = ended ? Date.parse(ended) : NaN;
  const duration = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : null;
  const status = isStageStatus(input.status) ? input.status : 'pending';
  return {
    schema_version: RELIABILITY_SCHEMA_VERSION,
    ts: input.now ?? new Date().toISOString(),
    project_id: safeLogText(input.projectId),
    stage: input.stage,
    status,
    started_at: started,
    ended_at: ended,
    duration_ms: duration,
    input_fingerprint: input.inputFingerprint ?? null,
    output_fingerprint: input.outputFingerprint ?? null,
    retry_count: Number.isInteger(input.retryCount) && (input.retryCount as number) > 0 ? Number(input.retryCount) : 0,
    error_category: input.errorCategory ?? null,
    recovery_decision: safeLogText(input.recoveryDecision ?? defaultRecovery(status)),
    reuse_or_rerender_reason: safeLogText(input.reuseOrRerenderReason ?? defaultReason(status)),
    detail: safeLogText(input.detail ?? ''),
  };
}

/** True when a text blob contains an obvious credential/token marker (test + guard helper). */
export function containsSecretMaterial(text: unknown): boolean {
  const value = typeof text === 'string' ? text : JSON.stringify(text ?? '');
  return /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|authorization|bearer|password|cookie|secret)\b\s*[:=]\s*\S+/i.test(value)
    || /[?&](?:KeyName|Expires|Signature|X-Amz-Credential)=/i.test(value)
    || /blob:/i.test(value);
}

// ---------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------

export function renderReliabilityReport(report: ReliabilityReport): string {
  const lines: string[] = [];
  lines.push(`reliability: ${report.project_id}`);
  lines.push(`resume from: ${report.resume_from ?? '(nothing left to render)'}`);
  lines.push(`next gate:   ${report.next_gate ?? '(all gates satisfied)'}`);
  lines.push(`reusable:    ${report.reusable.length ? report.reusable.join(', ') : '-'}`);
  lines.push(`work set:    ${report.work_set.length ? report.work_set.join(', ') : '-'}`);
  for (const stage of report.stages) {
    const mark = stage.status === 'completed' ? 'OK ' : stage.status === 'skipped' ? '-- ' : '!  ';
    lines.push(`  ${mark}${stage.stage.padEnd(16)} ${stage.status.padEnd(9)} ${stage.detail}`);
    if (stage.status === 'failed' || stage.status === 'blocked' || stage.status === 'stale') {
      lines.push(`      recovery: ${stage.recovery_decision}; reason: ${stage.reuse_or_rerender_reason}`);
    }
  }
  return lines.join('\n');
}
