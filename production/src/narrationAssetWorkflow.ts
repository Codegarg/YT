/**
 * PHASE 7 — narration asset workflow: refresh → QA → approve → status.
 *
 * Everything is scoped to `outputs/<projectId>/narration/`. The narration SOURCE files stay in
 * `inputs/<projectId>/narration/` and are only ever read: this workflow never rewrites, normalizes or
 * deletes an operator/provider audio file, and it never touches the long-form render or its approval.
 *
 * Resume: the ledger is rewritten only when its content actually changes, so an unchanged story
 * re-runs to identical bytes with zero writes. Approval is per asset and bound to that asset's exact
 * SHA-256 plus the QA evidence hash, so re-recording ONE line invalidates ONLY that line's approval.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  assertInsideNarrationRoot,
  buildNarrationLedger,
  computeNarrationInvalidation,
  loadNarrationLedger,
  narrationApprovalPath,
  narrationDependentClaims,
  narrationIsComplete,
  narrationQaPath,
  narrationRoot,
  writeNarrationLedger,
  type NarrationAssetRecord,
  type NarrationInvalidation,
  type NarrationLedger,
  type NarrationVoiceConfig,
  type PronunciationConfig,
} from './narrationAssets.js';
import {
  narrationQaCovers,
  runNarrationQa,
  type NarrationQaReport,
  type MediaQaRunner,
} from './narrationQa.js';

export const NARRATION_APPROVAL_VERSION = 1;

export interface NarrationApprovalAsset {
  scene_number: number;
  asset: string;
  sha256: string;
  duration_seconds: number | null;
  /** Global QA report the entry was captured from (audit trail). */
  qa_report_hash: string;
  /** That asset's own QA verdict at approval time (per-asset evidence binding). */
  qa_asset_status: NarrationQaReport['status'];
  approved_at: string;
}

export interface NarrationApprovalRecord {
  schema_version: number;
  project_id: string;
  status: 'approved';
  approved_at: string;
  approved_by: string | null;
  /** Ledger identity the approval was granted against. */
  ledger_fingerprint: string;
  /** QA evidence the approval is bound to. */
  qa: {
    status: NarrationQaReport['status'];
    report_hash: string;
    artifact_hash: string;
    generated_at: string;
  };
  /** Per-asset records: one changed line invalidates only its own entry. */
  assets: NarrationApprovalAsset[];
}

export type NarrationAssetVerdictStatus = 'APPROVED' | 'NOT_APPROVED' | 'STALE_APPROVAL';

export interface NarrationAssetVerdict {
  scene_number: number;
  asset: string;
  status: NarrationAssetVerdictStatus;
  reason: string;
}

export interface NarrationApprovalVerdict {
  status: NarrationAssetVerdictStatus;
  assets: NarrationAssetVerdict[];
  record: NarrationApprovalRecord | null;
  reason: string;
}

export interface NarrationWorkflowOptions {
  projectId: string;
  pipeline: any;
  outputsRoot: string;
  inputRoot: string;
  pronunciation?: PronunciationConfig | null;
  pronunciationPath?: string | null;
  voice?: Partial<NarrationVoiceConfig>;
  ffmpegPath?: string;
  ffprobePath?: string;
  now?: string;
  /** Test seams. */
  runMediaQa?: MediaQaRunner;
  probe?: (file: string) => Promise<any>;
}

async function writeJsonAtomic(target: string, value: unknown, guardRoot: string): Promise<boolean> {
  assertInsideNarrationRoot(guardRoot, target);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const existing = await fsp.readFile(target, 'utf8');
    if (existing === text) return false;
  } catch {
    // absent
  }
  const temp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await fsp.writeFile(temp, text, 'utf8');
  await fsp.rename(temp, target);
  return true;
}

export interface RefreshNarrationResult {
  ok: boolean;
  projectId: string;
  ledgerPath: string;
  written: boolean;
  ledger: NarrationLedger;
  changes: ReturnType<typeof describeChanges>;
  invalidation: NarrationInvalidation;
  pronunciationSource: string | null;
  warnings: string[];
}

function describeChanges(changes: Array<{ scene_number: number; asset: string; from: string | null; to: string; sha256_changed: boolean; input_key_changed: boolean }>) {
  return changes.map((change) => ({
    scene: change.scene_number,
    asset: change.asset,
    from: change.from,
    to: change.to,
    bytes_changed: change.sha256_changed,
    script_or_voice_changed: change.input_key_changed,
  }));
}

/**
 * Refresh the narration ledger and persist it only when it changed.
 *
 * The invalidation report is computed against the DEPENDENTS that recorded which bytes they used, so
 * one re-recorded line names exactly the long-form mix/QA and the specific Shorts that must be redone.
 */
export async function refreshNarrationAssets(options: NarrationWorkflowOptions): Promise<RefreshNarrationResult> {
  // The previous ledger is the record of what the long-form dependents were built from, so it must be
  // read BEFORE this pass overwrites it.
  const previous = await loadNarrationLedger(options.outputsRoot, options.projectId);
  const { ledger, changes, pronunciationSource } = await buildNarrationLedger({
    projectId: options.projectId,
    pipeline: options.pipeline,
    inputRoot: options.inputRoot,
    outputsRoot: options.outputsRoot,
    pronunciation: options.pronunciation ?? null,
    pronunciationPath: options.pronunciationPath ?? null,
    voice: options.voice,
    probe: options.probe,
    now: options.now,
  });
  const written = await writeNarrationLedger(options.outputsRoot, options.projectId, ledger);
  const claims = await narrationDependentClaims({ outputsRoot: options.outputsRoot, projectId: options.projectId, ledger, previous });
  const invalidation = computeNarrationInvalidation(ledger, claims, { previous });

  return {
    ok: ledger.missing_scenes.length === 0 && ledger.invalid_scenes.length === 0,
    projectId: options.projectId,
    ledgerPath: path.join(narrationRoot(options.outputsRoot, options.projectId), 'narration-ledger.json'),
    written,
    ledger,
    changes: describeChanges(changes),
    invalidation,
    pronunciationSource,
    warnings: ledger.warnings,
  };
}

export interface NarrationStatusReport {
  project_id: string;
  generated_at: string;
  read_only: true;
  ledger_present: boolean;
  complete: boolean;
  fingerprint: string | null;
  asset_set_hash: string | null;
  voice: NarrationLedger['voice'] | null;
  required_scenes: number[];
  assets: Array<{
    scene_number: number;
    asset: string;
    state: string;
    sha256: string | null;
    duration_seconds: number | null;
    reason: string;
  }>;
  invalidation: NarrationInvalidation;
  approval: NarrationApprovalVerdict;
  qa: { status: string; report_hash: string | null; artifact_hash: string | null } | null;
  publishable: false;
}

async function loadJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Read-only status. Never writes, never measures media, never approves. */
export async function narrationStatus(options: NarrationWorkflowOptions): Promise<NarrationStatusReport> {
  const ledger = await loadNarrationLedger(options.outputsRoot, options.projectId);
  const root = narrationRoot(options.outputsRoot, options.projectId);
  const qa = await loadJson<NarrationQaReport>(path.join(root, 'narration-qa.json'));
  const approval = await loadJson<NarrationApprovalRecord>(narrationApprovalPath(options.outputsRoot, options.projectId));

  if (!ledger) {
    return {
      project_id: options.projectId,
      generated_at: options.now ?? new Date().toISOString(),
      read_only: true,
      ledger_present: false,
      complete: false,
      fingerprint: null,
      asset_set_hash: null,
      voice: null,
      required_scenes: [],
      assets: [],
      invalidation: { changed_scenes: [], stale_dependents: {}, long_form_affected: false, shorts_affected: [] },
      approval: { status: 'NOT_APPROVED', assets: [], record: null, reason: 'no narration ledger exists; run `video narration refresh`' },
      qa: null,
      publishable: false,
    };
  }

  const claims = await narrationDependentClaims({ outputsRoot: options.outputsRoot, projectId: options.projectId, ledger });
  const invalidation = computeNarrationInvalidation(ledger, claims);

  return {
    project_id: options.projectId,
    generated_at: options.now ?? new Date().toISOString(),
    read_only: true,
    ledger_present: true,
    complete: narrationIsComplete(ledger),
    fingerprint: ledger.fingerprint,
    asset_set_hash: ledger.asset_set_hash,
    voice: ledger.voice,
    required_scenes: ledger.scene_texts.filter((plan) => plan.required).map((plan) => plan.scene_number),
    assets: ledger.assets.map((asset) => ({
      scene_number: asset.scene_number,
      asset: asset.asset,
      state: asset.state,
      sha256: asset.sha256,
      duration_seconds: asset.duration_seconds,
      reason: asset.reason,
    })),
    invalidation,
    approval: evaluateNarrationApproval(approval, ledger, qa),
    qa: qa ? { status: qa.status, report_hash: qa.report_hash, artifact_hash: qa.artifact_hash } : null,
    publishable: false,
  };
}

export interface QaNarrationResult {
  ok: boolean;
  projectId: string;
  report: NarrationQaReport | null;
  reportPath: string;
  written: boolean;
  errors: string[];
}

/** Run the narration QA against the CURRENT ledger and persist the evidence atomically. */
export async function qaNarrationAssets(options: NarrationWorkflowOptions): Promise<QaNarrationResult> {
  const ledger = await loadNarrationLedger(options.outputsRoot, options.projectId);
  const reportPath = narrationQaPath(options.outputsRoot, options.projectId);
  if (!ledger) {
    return { ok: false, projectId: options.projectId, report: null, reportPath, written: false, errors: ['no narration ledger exists; run `video narration refresh` first'] };
  }
  const report = await runNarrationQa({
    ledger,
    inputRoot: options.inputRoot,
    ffmpegPath: options.ffmpegPath,
    ffprobePath: options.ffprobePath,
    now: options.now,
    runMediaQa: options.runMediaQa,
    probe: options.probe,
  });
  const written = await writeJsonAtomic(reportPath, report, narrationRoot(options.outputsRoot, options.projectId));
  return { ok: report.ok, projectId: options.projectId, report, reportPath, written, errors: [] };
}

function evaluateNarrationApproval(
  record: NarrationApprovalRecord | null,
  ledger: NarrationLedger,
  qa: NarrationQaReport | null,
): NarrationApprovalVerdict {
  if (!record) {
    return { status: 'NOT_APPROVED', assets: [], record: null, reason: 'no narration approval has been recorded' };
  }
  const approvedByScene = new Map(record.assets.map((asset) => [asset.scene_number, asset]));
  const verdicts: NarrationAssetVerdict[] = ledger.assets.map((asset) => {
    const approved = approvedByScene.get(asset.scene_number);
    if (!approved) return { scene_number: asset.scene_number, asset: asset.asset, status: 'NOT_APPROVED', reason: 'this asset was never approved' };
    if (approved.sha256 !== asset.sha256) {
      return { scene_number: asset.scene_number, asset: asset.asset, status: 'STALE_APPROVAL', reason: 'the audio bytes changed since approval' };
    }
    // Per-asset QA binding: the evidence must describe THESE bytes. A different line being re-recorded
    // and re-QA'd therefore never invalidates the untouched entries.
    const qaAsset = qa?.assets.find((entry) => entry.scene_number === asset.scene_number && entry.sha256 === asset.sha256) ?? null;
    if (!qaAsset) {
      return { scene_number: asset.scene_number, asset: asset.asset, status: 'STALE_APPROVAL', reason: 'no QA evidence exists for these exact bytes; re-run `video narration qa`' };
    }
    if (qaAsset.status === 'FAIL') {
      return { scene_number: asset.scene_number, asset: asset.asset, status: 'STALE_APPROVAL', reason: 'the QA verdict for these bytes is FAIL' };
    }
    if (approved.qa_asset_status !== qaAsset.status) {
      return { scene_number: asset.scene_number, asset: asset.asset, status: 'STALE_APPROVAL', reason: `the QA verdict changed from ${approved.qa_asset_status} to ${qaAsset.status}` };
    }
    if (asset.state !== 'ready') {
      return { scene_number: asset.scene_number, asset: asset.asset, status: 'STALE_APPROVAL', reason: `the asset is ${asset.state}, not ready` };
    }
    return { scene_number: asset.scene_number, asset: asset.asset, status: 'APPROVED', reason: 'approved for these exact bytes' };
  });

  const overall: NarrationAssetVerdictStatus = verdicts.length === 0
    ? 'NOT_APPROVED'
    : verdicts.every((verdict) => verdict.status === 'APPROVED')
      ? 'APPROVED'
      : verdicts.some((verdict) => verdict.status === 'STALE_APPROVAL') ? 'STALE_APPROVAL' : 'NOT_APPROVED';

  return {
    status: overall,
    assets: verdicts,
    record,
    reason: overall === 'APPROVED'
      ? `${verdicts.length} narration asset(s) approved for their exact bytes`
      : overall === 'STALE_APPROVAL'
        ? 'at least one asset or its QA evidence changed since approval'
        : 'at least one asset has no approval record',
  };
}

export interface ApproveNarrationOptions extends NarrationWorkflowOptions {
  approvedBy?: string | null;
  confirmed: boolean;
  blockOnWarnings?: boolean;
}

export interface ApproveNarrationResult {
  ok: boolean;
  projectId: string;
  status: NarrationAssetVerdictStatus | 'REFUSED';
  reason: string;
  approvalPath: string;
  record: NarrationApprovalRecord | null;
}

/**
 * Record a per-asset approval, bound to the exact bytes and the QA evidence.
 *
 * Refusals (never auto-approved): missing `--yes`, no ledger, incomplete/stale/invalid assets, no QA,
 * QA that does not cover these bytes, QA FAIL (or WARNING with `--qa-warnings-block`).
 */
export async function approveNarrationAssets(options: ApproveNarrationOptions): Promise<ApproveNarrationResult> {
  const approvalPath = narrationApprovalPath(options.outputsRoot, options.projectId);
  if (!options.confirmed) {
    return { ok: false, projectId: options.projectId, status: 'REFUSED', reason: 'narration approval requires an explicit --yes (it is a human decision).', approvalPath, record: null };
  }
  const ledger = await loadNarrationLedger(options.outputsRoot, options.projectId);
  if (!ledger) {
    return { ok: false, projectId: options.projectId, status: 'REFUSED', reason: 'no narration ledger exists; run `video narration refresh` first.', approvalPath, record: null };
  }
  const notReady = ledger.assets.filter((asset) => asset.state !== 'ready');
  if (notReady.length > 0) {
    return {
      ok: false, projectId: options.projectId, status: 'REFUSED',
      reason: `refusing to approve: scene(s) ${notReady.map((asset) => asset.scene_number).join(', ')} are not ready (${notReady.map((asset) => asset.state).join(', ')})`,
      approvalPath, record: null,
    };
  }
  if (!narrationIsComplete(ledger)) {
    return { ok: false, projectId: options.projectId, status: 'REFUSED', reason: 'refusing to approve: some narrator scenes have no usable audio.', approvalPath, record: null };
  }

  const qa = await loadJson<NarrationQaReport>(narrationQaPath(options.outputsRoot, options.projectId));
  if (!qa) {
    return { ok: false, projectId: options.projectId, status: 'REFUSED', reason: 'refusing to approve: run `video narration qa` first.', approvalPath, record: null };
  }
  if (qa.status === 'FAIL') {
    return { ok: false, projectId: options.projectId, status: 'REFUSED', reason: 'refusing to approve: narration QA is FAIL.', approvalPath, record: null };
  }
  if (options.blockOnWarnings && qa.status === 'WARNING') {
    return { ok: false, projectId: options.projectId, status: 'REFUSED', reason: 'refusing to approve: --qa-warnings-block is set and QA reported warnings.', approvalPath, record: null };
  }
  if (!narrationQaCovers(qa, ledger)) {
    return { ok: false, projectId: options.projectId, status: 'REFUSED', reason: 'refusing to approve: the QA evidence does not cover the current narration bytes; re-run QA.', approvalPath, record: null };
  }
  const failing = qa.assets.filter((asset) => asset.status === 'FAIL');
  if (failing.length > 0) {
    return { ok: false, projectId: options.projectId, status: 'REFUSED', reason: `refusing to approve: QA failed for scene(s) ${failing.map((asset) => asset.scene_number).join(', ')}.`, approvalPath, record: null };
  }

  const approvedAt = options.now ?? new Date().toISOString();
  const qaByScene = new Map(qa.assets.map((asset) => [asset.scene_number, asset]));
  const assets: NarrationApprovalAsset[] = ledger.assets
    .filter((asset): asset is NarrationAssetRecord & { sha256: string } => typeof asset.sha256 === 'string')
    .map((asset) => ({
      scene_number: asset.scene_number,
      asset: asset.asset,
      sha256: asset.sha256,
      duration_seconds: asset.duration_seconds,
      qa_report_hash: qa.report_hash,
      qa_asset_status: qaByScene.get(asset.scene_number)?.status ?? 'SKIPPED',
      approved_at: approvedAt,
    }));

  const record: NarrationApprovalRecord = {
    schema_version: NARRATION_APPROVAL_VERSION,
    project_id: options.projectId,
    status: 'approved',
    approved_at: approvedAt,
    approved_by: options.approvedBy ?? null,
    ledger_fingerprint: ledger.fingerprint,
    qa: {
      status: qa.status,
      report_hash: qa.report_hash,
      artifact_hash: qa.artifact_hash ?? '',
      generated_at: qa.generated_at,
    },
    assets,
  };
  await writeJsonAtomic(approvalPath, record, narrationRoot(options.outputsRoot, options.projectId));
  return {
    ok: true,
    projectId: options.projectId,
    status: 'APPROVED',
    reason: `${assets.length} narration asset(s) approved for their exact bytes (publishing is a separate, explicit step).`,
    approvalPath,
    record,
  };
}

export function renderNarrationStatus(report: NarrationStatusReport): string {
  const lines: string[] = [];
  lines.push(`narration:    ${report.project_id}`);
  if (!report.ledger_present) {
    lines.push('  ledger:     absent — run `video narration refresh --project <pipeline.json>`');
    return lines.join('\n');
  }
  lines.push(`  voice:       ${report.voice?.provider}/${report.voice?.model}/${report.voice?.voice} (${report.voice?.language})`);
  lines.push(`  complete:    ${report.complete ? 'yes' : 'NO'}`);
  lines.push(`  fingerprint: ${report.fingerprint}`);
  lines.push(`  assets:      ${report.assets.length} of ${report.required_scenes.length} narrator scene(s)`);
  for (const asset of report.assets) {
    lines.push(`    ${asset.state.padEnd(14)} ${asset.asset}  ${asset.duration_seconds ?? '?'}s  ${asset.sha256 ? asset.sha256.slice(0, 12) : 'no-bytes'}`);
    if (asset.state !== 'ready') lines.push(`        ${asset.reason}`);
  }
  if (report.invalidation.changed_scenes.length > 0) {
    lines.push(`  invalidated: scene(s) ${report.invalidation.changed_scenes.join(', ')}`);
    lines.push(`    dependents: ${Object.keys(report.invalidation.stale_dependents).join(', ') || 'none'}`);
  } else {
    lines.push('  invalidated: none — every dependent was built from the current bytes');
  }
  lines.push(`  qa:          ${report.qa ? `${report.qa.status} (${String(report.qa.report_hash).slice(0, 12)})` : 'absent'}`);
  lines.push(`  approval:    ${report.approval.status} — ${report.approval.reason}`);
  lines.push('  publishable: false — approval is local evidence only; nothing is uploaded.');
  return lines.join('\n');
}
