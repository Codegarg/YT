/**
 * PHASE 5 — long-form output contract.
 *
 * One read-only report that answers a single question honestly:
 *
 *   "Is the media this project just produced a publishable programme, and if not, exactly which
 *    contract clause failed?"
 *
 * It does NOT re-implement media analysis. It COMPOSES the two boundaries that already exist:
 *
 *   · Phase 4 `runProjectMediaQa` — container/streams/aspect/fps/A-V/duration/scene-order/
 *     narration evidence, bound to the exact final artifact hash.
 *   · `evaluateApproval` — the human decision, bound to that same hash and to the TITLE stage key.
 *
 * What it adds is the mapping from raw QA checks onto the named long-form contract clauses, plus
 * the one property that must never be inferred: **a successful render is not a publishable video.**
 * `publishable` is true only when the artifact is QA-clean, explicitly approved by a human, and the
 * approval hash matches the QA artifact hash. Even then the only thing it authorizes is handing the
 * artifact to the EXTERNAL publisher — this module never uploads, never publishes and never
 * touches the network for publishing.
 *
 * Deliberate limits (reported as SKIPPED/WARNING, never silently assumed clean):
 *   · The title/branding overlay is verified via the TITLE stage sidecar, not by pixel recognition.
 *   · Scene-transition continuity, caption timing and stem-separated music mixing remain the
 *     documented Phase 4 gaps.
 */

import path from 'node:path';
import {
  qaAuthorizesArtifact,
  runProjectMediaQa,
  type ProjectMediaQaOptions,
  type ProjectMediaQaReport,
} from './projectMediaQa.js';
import type { QaCheck, QaCheckStatus } from './mediaQa.js';
import {
  evaluateApproval,
  type ApprovalVerdict,
  type ApproveInput,
} from './approval.js';
import { stageOutputName } from './downstreamStages.js';

export const OUTPUT_CONTRACT_SCHEMA_VERSION = 1;

export const CONTRACT_CATEGORIES = [
  'duration',
  'streams',
  'resolution_aspect',
  'fps',
  'av_sync',
  'scene_order',
  'narration_coverage',
  'branding_title',
  'qa_evidence',
  'approval',
] as const;
export type ContractCategory = (typeof CONTRACT_CATEGORIES)[number];

/** Contract clauses that must FAIL for the programme to be unpublishable. */
export const BLOCKING_CATEGORIES: readonly ContractCategory[] = [
  'duration', 'streams', 'resolution_aspect', 'fps', 'av_sync', 'scene_order', 'narration_coverage', 'branding_title', 'qa_evidence', 'approval',
] as const;

export interface OutputContractCheck {
  id: string;
  category: ContractCategory;
  status: QaCheckStatus;
  severity: string;
  expected: unknown;
  actual: unknown;
  detail: string;
  /** QA evidence rows that produced this clause (bounded to the ones that are not PASS). */
  evidence: Array<{ id: string; asset: string; status: QaCheckStatus; explanation: string }>;
}

export interface OutputContractReport {
  schema_version: number;
  project_id: string;
  generated_at: string;
  read_only: true;
  status: QaCheckStatus;
  checks: OutputContractCheck[];
  /** Clause-level blockers (FAIL rows). Empty means the media itself satisfies the contract. */
  blockers: OutputContractCheck[];
  warnings: OutputContractCheck[];
  qa: {
    status: QaCheckStatus;
    artifact_hash: string | null;
    report_hash: string;
    generated_at: string;
  };
  approval: {
    status: 'APPROVED' | 'NOT_APPROVED' | 'STALE_APPROVAL';
    final_output_hash: string | null;
    /** True when the approval names exactly the artifact the QA run evaluated. */
    hash_bound: boolean;
    reason: string;
  };
  /**
   * True only when QA is not FAIL, a human approval exists, and the approval hash matches the QA
   * artifact hash. This is a HANDOFF readiness flag, never a publication action.
   */
  publishable: boolean;
  publish_boundary: 'READY_FOR_EXTERNAL_PUBLISHER' | 'BLOCKED';
  publish_block_reason: string;
}

export interface OutputContractOptions extends Omit<ProjectMediaQaOptions, 'projectId' | 'outputsDir'> {
  projectId: string;
  outputsDir: string;
  /** Absolute outputs root (production/outputs). Required for approval re-validation. */
  outputsRoot: string;
  inputRoot: string;
  pipeline: any;
  stageInputs?: any;
  /** Explicit artifact to contract-check (defaults to the canonical TITLE render). */
  candidatePath?: string;
  expectedHash?: string;
  /** Explicit reviewer choice: QA warnings also block. Default false (matches approval). */
  blockOnMediaQaWarnings?: boolean;
  /** Test seam: replace the QA engine. */
  mediaQa?: (args: {
    projectId: string;
    outputsDir: string;
    inputRoot: string;
    pipeline: any;
    finalPath: string;
    ffprobePath?: string;
    ffmpegPath?: string;
    now?: string;
  }) => Promise<ProjectMediaQaReport>;
  /** Test seam: replace the approval verdict. */
  evaluateApproval?: (input: ApproveInput) => Promise<ApprovalVerdict>;
  /** Test seam: replace the read-only project inspection used by approval re-validation. */
  inspectProject?: (args: any) => Promise<any>;
}

const clampText = (value: unknown, max = 300): string => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const statusRank = (status: QaCheckStatus): number =>
  status === 'FAIL' ? 3 : status === 'WARNING' ? 2 : status === 'SKIPPED' ? 1 : 0;

function combineStatus(checks: OutputContractCheck[]): QaCheckStatus {
  if (checks.some((c) => c.status === 'FAIL')) return 'FAIL';
  if (checks.some((c) => c.status === 'WARNING')) return 'WARNING';
  return checks.length > 0 ? 'PASS' : 'SKIPPED';
}

function finalAssetName(report: ProjectMediaQaReport): string {
  const finalArtifact = report.artifacts.find((artifact) => artifact.kind === 'final');
  return finalArtifact ? path.basename(finalArtifact.asset) : '';
}

function checksWith(report: ProjectMediaQaReport, ids: readonly string[], scope: 'final' | 'project'): QaCheck[] {
  const finalAsset = finalAssetName(report);
  return report.checks.filter((check) => {
    if (!ids.includes(check.id)) return false;
    // Project-scoped checks (`scenes.order`, `narration.*`) are attributed to the project or to a
    // narration asset, never to the final video. Final-scoped checks are matched to the final
    // artifact so a scene clip's `video.stream` can never satisfy the programme's stream clause.
    return scope === 'project' ? true : !finalAsset || check.asset === finalAsset;
  });
}

function makeCheck(input: {
  id: string;
  category: ContractCategory;
  status: QaCheckStatus;
  detail: string;
  expected?: unknown;
  actual?: unknown;
  evidence?: QaCheck[];
}): OutputContractCheck {
  return {
    id: input.id,
    category: input.category,
    status: input.status,
    severity: input.status === 'FAIL' ? 'BLOCKER' : input.status === 'WARNING' ? 'WARNING' : input.status === 'SKIPPED' ? 'SKIPPED' : 'INFO',
    expected: input.expected ?? null,
    actual: input.actual ?? null,
    detail: clampText(input.detail),
    evidence: (input.evidence ?? [])
      .filter((check) => check.status !== 'PASS')
      .slice(0, 8)
      .map((check) => ({ id: check.id, asset: check.asset, status: check.status, explanation: clampText(check.explanation, 200) })),
  };
}

/** Map QA rows for `ids` onto one contract clause. Missing rows are SKIPPED, never PASS. */
function clauseFromQa(input: {
  id: string;
  category: ContractCategory;
  label: string;
  report: ProjectMediaQaReport;
  ids: readonly string[];
  expected: unknown;
  scope?: 'final' | 'project';
}): OutputContractCheck {
  const rows = checksWith(input.report, input.ids, input.scope ?? 'final');
  if (rows.length === 0) {
    return makeCheck({
      id: input.id, category: input.category, status: 'SKIPPED',
      detail: `${input.label}: no ${input.ids.join('/')} evidence was produced by the QA run`,
      expected: input.expected,
    });
  }
  const status = rows.reduce<QaCheckStatus>((worst, row) => (statusRank(row.status) > statusRank(worst) ? row.status : worst), 'PASS');
  const actual = rows.map((row) => ({ id: row.id, actual: row.actual })).slice(0, 6);
  const explanation = rows.filter((row) => row.status !== 'PASS').map((row) => row.explanation).join(' ');
  return makeCheck({
    id: input.id,
    category: input.category,
    status,
    detail: explanation || `${input.label}: ${rows.length} check(s) passed`,
    expected: input.expected,
    actual,
    evidence: rows,
  });
}

function titleClause(report: ProjectMediaQaReport, candidatePath?: string): OutputContractCheck {
  const canonicalName = stageOutputName('TITLE');
  const evaluated = finalAssetName(report) || path.basename(candidatePath ?? '') || canonicalName;
  if (!report.artifactHash) {
    return makeCheck({
      id: 'branding.title_render', category: 'branding_title', status: 'FAIL',
      detail: 'no final artifact could be read, so the title/branding render is unverified',
      expected: canonicalName, actual: 'missing',
    });
  }
  if (evaluated !== canonicalName) {
    return makeCheck({
      id: 'branding.title_render', category: 'branding_title', status: 'WARNING',
      detail: `the evaluated artifact is ${evaluated}, not the canonical ${canonicalName}; title-overlay provenance must be confirmed by a reviewer`,
      expected: canonicalName, actual: evaluated,
    });
  }
  return makeCheck({
    id: 'branding.title_render', category: 'branding_title', status: 'PASS',
    detail: `the final artifact is the canonical ${canonicalName} produced by the TITLE stage; the overlay itself is verified by the stage sidecar, not by pixel recognition`,
    expected: canonicalName, actual: evaluated,
  });
}

function qaEvidenceClause(report: ProjectMediaQaReport): OutputContractCheck {
  if (!report.artifactHash) {
    return makeCheck({
      id: 'qa.artifact_bound', category: 'qa_evidence', status: 'FAIL',
      detail: 'the QA report did not identify an artifact, so no approval can be bound to it',
    });
  }
  if (report.status === 'FAIL') {
    return makeCheck({
      id: 'qa.artifact_bound', category: 'qa_evidence', status: 'FAIL',
      detail: 'the QA report recorded blocking failures',
      expected: 'no blockers', actual: `${report.counts.blockers} blocker(s)`,
    });
  }
  if (report.status === 'SKIPPED') {
    return makeCheck({
      id: 'qa.artifact_bound', category: 'qa_evidence', status: 'WARNING',
      detail: 'QA produced no analysable evidence; skipped is never treated as pass',
    });
  }
  return makeCheck({
    id: 'qa.artifact_bound', category: 'qa_evidence', status: report.status,
    detail: `QA evidence is bound to artifact ${report.artifactHash.slice(0, 12)}… (report ${report.reportHash.slice(0, 12)}…)`,
    expected: report.artifactHash, actual: report.artifactHash,
  });
}

function approvalClause(verdict: ApprovalVerdict, qa: ProjectMediaQaReport): OutputContractCheck {
  if (verdict.status === 'APPROVED') {
    const hashBound = String(verdict.finalOutputHash).toLowerCase() === String(qa.artifactHash ?? '').toLowerCase();
    if (!hashBound) {
      return makeCheck({
        id: 'approval.hash_binding', category: 'approval', status: 'FAIL',
        detail: 'the approval names a different artifact than the one QA evaluated',
        expected: qa.artifactHash, actual: verdict.finalOutputHash,
      });
    }
    return makeCheck({
      id: 'approval.hash_binding', category: 'approval', status: 'PASS',
      detail: `a human approval is bound to the exact QA artifact (${verdict.finalOutputHash.slice(0, 12)}…)`,
      expected: qa.artifactHash, actual: verdict.finalOutputHash,
    });
  }
  if (verdict.status === 'STALE_APPROVAL') {
    return makeCheck({
      id: 'approval.hash_binding', category: 'approval', status: 'WARNING',
      detail: `the recorded approval is stale: ${verdict.reason}`,
      expected: qa.artifactHash, actual: verdict.record?.approved_final_output_hash ?? null,
    });
  }
  return makeCheck({
    id: 'approval.hash_binding', category: 'approval', status: 'WARNING',
    detail: `no usable approval exists: ${verdict.reason}`,
  });
}

/**
 * Evaluate the long-form contract. Read-only: no rendering, no approval writes, no publishing.
 */
export async function evaluateOutputContract(options: OutputContractOptions): Promise<OutputContractReport> {
  const projectId = String(options.projectId ?? '').trim();
  if (!projectId) throw new Error('evaluateOutputContract requires a project id.');
  const outputsDir = path.resolve(options.outputsDir);
  const finalPath = options.candidatePath && String(options.candidatePath).trim()
    ? path.resolve(options.candidatePath)
    : path.join(outputsDir, stageOutputName('TITLE'));

  const qaRunner = options.mediaQa ?? runProjectMediaQa;
  const qaArgs: ProjectMediaQaOptions & { inputRoot: string; finalPath: string; projectId: string; outputsDir: string; pipeline: any } = {
    projectId,
    outputsDir,
    inputRoot: options.inputRoot,
    pipeline: options.pipeline,
    finalPath,
    ffprobePath: options.ffprobePath,
    ffmpegPath: options.ffmpegPath,
    now: options.now,
    scenes: options.scenes,
    referenceFinalPath: options.referenceFinalPath,
    expectedFinalDurationSeconds: options.expectedFinalDurationSeconds,
    skipScenes: options.skipScenes,
    skipNarration: options.skipNarration,
    skipFinal: options.skipFinal,
    minHeight: options.minHeight,
    targetHeight: options.targetHeight,
    sceneDurationToleranceSeconds: options.sceneDurationToleranceSeconds,
    finalDurationToleranceSeconds: options.finalDurationToleranceSeconds,
    runMediaQa: options.runMediaQa,
    probe: options.probe,
  };
  const qa = await qaRunner(qaArgs);

  const checks: OutputContractCheck[] = [
    clauseFromQa({ id: 'contract.duration', category: 'duration', label: 'programme duration', report: qa, ids: ['duration.expected', 'final.duration_match'], expected: 'within tolerance' }),
    clauseFromQa({ id: 'contract.streams', category: 'streams', label: 'audio+video streams', report: qa, ids: ['video.stream', 'audio.stream'], expected: 'both present' }),
    clauseFromQa({ id: 'contract.resolution_aspect', category: 'resolution_aspect', label: 'resolution and 16:9 aspect', report: qa, ids: ['video.dimensions', 'video.aspect'], expected: '>= 720p, 16:9' }),
    clauseFromQa({ id: 'contract.fps', category: 'fps', label: 'frame rate', report: qa, ids: ['video.fps'], expected: 'target frame rate' }),
    clauseFromQa({ id: 'contract.av_sync', category: 'av_sync', label: 'A/V duration match', report: qa, ids: ['av.duration_match'], expected: 'within 0.5 s' }),
    clauseFromQa({ id: 'contract.scene_order', category: 'scene_order', label: 'scene order', report: qa, ids: ['scenes.order', 'scenes.present', 'scene.reused'], expected: 'contiguous ascending scenes', scope: 'project' }),
    clauseFromQa({ id: 'contract.narration_coverage', category: 'narration_coverage', label: 'narration coverage', report: qa, ids: ['narration.missing', 'narration.ambiguous'], expected: 'every narrator scene covered', scope: 'project' }),
    titleClause(qa, options.candidatePath),
    qaEvidenceClause(qa),
  ];

  const approvalRunner = options.evaluateApproval ?? evaluateApproval;
  const verdict = await approvalRunner({
    projectId,
    outputsRoot: path.resolve(options.outputsRoot),
    outputsDir,
    inputRoot: options.inputRoot,
    pipeline: options.pipeline,
    ffprobePath: options.ffprobePath,
    ffmpegPath: options.ffmpegPath,
    stageInputs: options.stageInputs,
    candidatePath: options.candidatePath,
    expectedHash: options.expectedHash,
    now: options.now,
    inspectProject: options.inspectProject,
    blockOnMediaQaWarnings: options.blockOnMediaQaWarnings,
    // Reuse the QA run this contract already performed instead of analysing the media twice.
    mediaQa: async () => qa,
  });
  checks.push(approvalClause(verdict, qa));

  const status = combineStatus(checks);
  const blockers = checks.filter((check) => check.status === 'FAIL');
  const warnings = checks.filter((check) => check.status === 'WARNING');

  const approvalHash = verdict.status === 'APPROVED' ? String(verdict.finalOutputHash).toLowerCase() : '';
  const hashBound = Boolean(approvalHash) && qaAuthorizesArtifact(qa, approvalHash);
  const qaWarningsBlock = options.blockOnMediaQaWarnings === true && qa.status === 'WARNING';
  const publishable = verdict.status === 'APPROVED' && hashBound && qa.status !== 'FAIL' && !qaWarningsBlock && blockers.length === 0;

  const reason = publishable
    ? 'the artifact is QA-clean and explicitly approved; hand it to the external publisher with a fresh human confirmation'
    : verdict.status !== 'APPROVED'
      ? `publishing is blocked until a human approves the current artifact (${verdict.status === 'STALE_APPROVAL' ? verdict.reason : verdict.status === 'NOT_APPROVED' ? verdict.reason : 'unknown'})`
      : qa.status === 'FAIL'
        ? 'publishing is blocked by media QA failures'
        : qaWarningsBlock
          ? 'publishing is blocked by the explicit warnings-block policy'
          : 'publishing is blocked by contract failures';

  return {
    schema_version: OUTPUT_CONTRACT_SCHEMA_VERSION,
    project_id: projectId,
    generated_at: options.now ?? new Date().toISOString(),
    read_only: true,
    status,
    checks,
    blockers,
    warnings,
    qa: {
      status: qa.status,
      artifact_hash: qa.artifactHash,
      report_hash: qa.reportHash,
      generated_at: qa.generatedAt,
    },
    approval: {
      status: verdict.status,
      final_output_hash: verdict.status === 'APPROVED' ? verdict.finalOutputHash : verdict.status === 'STALE_APPROVAL' ? String(verdict.record?.approved_final_output_hash ?? '') || null : null,
      hash_bound: hashBound,
      reason: verdict.status === 'APPROVED' ? 'approval matches the QA artifact' : verdict.reason,
    },
    publishable,
    publish_boundary: publishable ? 'READY_FOR_EXTERNAL_PUBLISHER' : 'BLOCKED',
    publish_block_reason: clampText(reason, 400),
  };
}

/** Human-readable contract summary. PURE. */
export function renderOutputContractReport(report: OutputContractReport): string {
  const lines: string[] = [];
  lines.push(`output contract: ${report.status}  ${report.project_id}`);
  lines.push(`qa:       ${report.qa.status}  artifact ${report.qa.artifact_hash ?? '(none)'}`);
  lines.push(`approval: ${report.approval.status}${report.approval.hash_bound ? ' (hash-bound)' : ''}`);
  lines.push(`publish:  ${report.publish_boundary}`);
  if (!report.publishable) lines.push(`          ${report.publish_block_reason}`);
  for (const check of report.checks) {
    const mark = check.status === 'PASS' ? 'OK ' : check.status === 'SKIPPED' ? '-- ' : check.status === 'WARNING' ? '!  ' : 'X  ';
    lines.push(`  ${mark}${check.category.padEnd(18)} ${check.status.padEnd(7)} ${check.detail}`);
  }
  return lines.join('\n');
}
