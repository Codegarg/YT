/**
 * Durable, auditable project approval boundary (STEP-8GV).
 *
 * Reuses the EXISTING architecture — it does NOT introduce a second approval model:
 *   · `ReviewState` (reviewState.ts) remains the human-facing review record.
 *   · `planDownstream` already makes APPROVAL CURRENT only when `approved === true`.
 *   · `projectState` already has AWAITING_APPROVAL -> COMPLETED (COMPLETED only from approval).
 *
 * This module adds the MISSING durable, integrity-bound approval for the project-workflow
 * boundary: an `approval.json` sidecar in the project outputs that binds approval to the EXACT
 * artifact path/hash and stage key. Canonical approvals keep the original final (TITLE) behavior;
 * an explicit candidate approval is additionally bound to the TITLE sidecar provenance.
 * Approval never publishes; publishing stays an explicit external operation (`zernio.ts`).
 *
 * No render/stage key may ever depend on this file (approval is derived FROM keys, never the
 * reverse). Persistence is atomic (temp sibling + rename), matching the rest of the codebase.
 */
import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeStageOutputPath, sha256OfFileOrNull, stageOutputName } from './downstreamStages.js';
import { validateVideoClip } from './videoClip.js';
import { projectQaEvidence, type MediaQaEvidence, type ProjectMediaQaReport } from './projectMediaQa.js';

export const APPROVAL_SCHEMA_VERSION = 1;

export type ApprovalStatus = 'approved' | 'stale';
export type ApprovalArtifactKind = 'canonical' | 'candidate';

/**
 * Provenance for an explicitly approved candidate artifact. The candidate is NOT a TITLE stage
 * output, so it must never masquerade as one. The record instead binds the candidate to the
 * TITLE sidecar that was current when approval was granted.
 */
export interface CandidateApprovalProvenance {
  source_stage: 'TITLE';
  source_stage_key: string;
  source_output_path: string;
  source_output_hash: string;
}

export interface ApprovalRecord {
  schema_version: number;
  project_id: string;
  status: ApprovalStatus;
  approved_at: string;
  /** Relative path inside the project's outputs directory (never absolute). */
  approved_final_output_path: string;
  approved_final_output_hash: string;
  approved_final_stage_key: string;
  /**
   * Optional for backward compatibility with schema-v1 canonical records. Missing means
   * `canonical`; a non-canonical path is rejected unless this is explicitly `candidate`.
   */
  approved_artifact_kind?: ApprovalArtifactKind;
  /** Required only for `candidate` records. */
  approved_candidate_provenance?: CandidateApprovalProvenance;
  /**
   * PHASE 4: optional QA evidence for the exact approved artifact. Absent means "legacy approval
   * predating media QA" and stays valid; when present it must cover the approved artifact hash.
   */
  media_qa?: MediaQaEvidence;
}

export interface ApproveInput {
  projectId: string;
  /** Absolute outputs root (production/outputs). */
  outputsRoot: string;
  /** Absolute project outputs dir (production/outputs/<id>). */
  outputsDir: string;
  /** Absolute project input root (production/inputs/<id>). */
  inputRoot: string;
  pipeline: any;
  ffprobePath?: string;
  /** Stage-key inputs (bgmHash/introHash/logoHash/titleMetadata) so stage keys match the recorded sidecars. */
  stageInputs?: any;
  /**
   * Optional explicit artifact to approve. It must resolve inside `outputsDir`. When omitted,
   * the existing canonical `final-title.mp4` behavior is preserved.
   */
  candidatePath?: string;
  /**
   * Required for candidate approval. The exact SHA-256 the caller intends to approve; the file
   * on disk must match it. Optional for canonical approval (and verified when supplied).
   */
  expectedHash?: string;
  /** Test/CLI seams. */
  now?: string;
  inspectProject?: (args: any) => Promise<any>;
  /**
   * PHASE 4 media QA boundary. When supplied, QA runs read-only against the exact artifact being
   * approved and must not FAIL. Omitted ⇒ legacy behavior (no QA evidence attached).
   */
  mediaQa?: (args: {
    projectId: string;
    outputsDir: string;
    inputRoot: string;
    pipeline: any;
    /** Absolute path of the exact artifact being approved (canonical or candidate). */
    finalPath: string;
    ffprobePath?: string;
    ffmpegPath?: string;
    now?: string;
  }) => Promise<ProjectMediaQaReport>;
  /** Explicit reviewer choice: QA warnings also block. Default false (warnings stay visible). */
  blockOnMediaQaWarnings?: boolean;
  /** ffmpeg binary for the QA boundary (defaults to the QA module's own resolution). */
  ffmpegPath?: string;
}

export type ApproveOutcome =
  | { ok: true; record: ApprovalRecord; idempotent: boolean }
  | { ok: false; code: 'PRECONDITION_FAILED' | 'QA_BLOCKED' | 'QA_UNAVAILABLE' | 'QA_STALE'; reason: string };

export type ApprovalVerdict =
  | { status: 'APPROVED'; record: ApprovalRecord; finalOutputHash: string; finalOutputPath: string }
  | { status: 'NOT_APPROVED'; reason: string }
  | { status: 'STALE_APPROVAL'; record: ApprovalRecord; reason: string };

function approvalPath(outputsDir: string, projectId: string): string {
  if (!String(projectId ?? '').trim()) throw new Error('approvalPath requires a project id.');
  return path.join(path.resolve(outputsDir), 'approval.json');
}

const HEX64 = /^[0-9a-f]{64}$/i;
const CANONICAL_TITLE_BASENAME = path.basename(stageOutputName('TITLE'));

/** Normalize a relative artifact path and reject traversal / absolute / Windows drive semantics. */
function normalizeRelativeOutputPath(value: unknown): { ok: true; relative: string } | { ok: false; reason: string } {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { ok: false, reason: 'approval output path is empty' };
  if (raw.includes('\0') || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    return { ok: false, reason: 'approval output path must be a relative path inside the project outputs directory' };
  }
  const segments = raw.split(/[\\/]+/);
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return { ok: false, reason: 'approval output path must not contain traversal or empty segments' };
  }
  // On Windows a colon can address an alternate data stream or a drive-relative path.
  if (segments.some((segment) => segment.includes(':'))) {
    return { ok: false, reason: 'approval output path contains a forbidden path separator form' };
  }
  return { ok: true, relative: segments.join('/') };
}

/** Compare two filesystem paths after resolving short names/symlinks (case-insensitive on Windows). */
export function sameArtifactPath(left: string, right: string): boolean {
  if (!left || !right) return false;
  const canonical = (value: string): string => {
    const resolved = path.resolve(value);
    try { return fsSync.realpathSync.native(resolved); } catch { return resolved; }
  };
  const a = canonical(left);
  const b = canonical(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function approvalArtifactKind(record: ApprovalRecord): ApprovalArtifactKind {
  return record.approved_artifact_kind === 'candidate' ? 'candidate' : 'canonical';
}

/** Resolve a relative approval path safely inside the project outputs root. */
async function resolveApprovalArtifactPath(
  outputsDir: string,
  relative: string,
  opts: { mustExist: boolean },
): Promise<{ ok: true; absPath: string; relativePath: string } | { ok: false; reason: string }> {
  const normalized = normalizeRelativeOutputPath(relative);
  if (!normalized.ok) return normalized;
  const root = path.resolve(outputsDir);
  const absPath = path.resolve(root, normalized.relative.split('/').join(path.sep));
  const lexicalRelative = path.relative(root, absPath);
  if (!lexicalRelative || lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) {
    return { ok: false, reason: 'approval output path resolves outside the project outputs directory' };
  }
  if (!opts.mustExist) return { ok: true, absPath, relativePath: normalized.relative };

  const stat = await fsp.stat(absPath).catch(() => null);
  if (!stat || !stat.isFile()) return { ok: false, reason: 'approved artifact is missing or is not a file' };
  const rootReal = await fsp.realpath(root).catch(() => null);
  const absReal = await fsp.realpath(absPath).catch(() => null);
  if (!rootReal || !absReal) return { ok: false, reason: 'approved artifact could not be resolved safely' };
  const realRelative = path.relative(rootReal, absReal);
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    return { ok: false, reason: 'approved artifact resolves outside the project outputs directory' };
  }
  return { ok: true, absPath: absReal, relativePath: normalized.relative };
}

/** Convert a CLI/caller-supplied candidate path into a safe relative path inside outputsDir. */
function candidateRelativePath(outputsDir: string, candidatePath: unknown): { ok: true; relative: string } | { ok: false; reason: string } {
  const raw = typeof candidatePath === 'string' ? candidatePath.trim() : '';
  if (!raw) return { ok: false, reason: 'candidate path is empty' };
  if (raw.includes('\0')) return { ok: false, reason: 'candidate path contains a NUL byte' };
  const root = path.resolve(outputsDir);
  // Reject drive-relative forms such as `C:foo` before resolving them.
  if (!path.isAbsolute(raw) && raw.includes(':')) return { ok: false, reason: 'candidate path uses a forbidden drive-relative form' };
  const absolute = path.resolve(root, raw);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, reason: 'candidate path must stay inside the project outputs directory' };
  }
  return normalizeRelativeOutputPath(relative.split(path.sep).join('/'));
}

/** Validate an approval record shape (no secrets; deterministic). */
export function validateApprovalRecord(record: unknown, projectId?: string): { ok: true } | { ok: false; reason: string } {
  if (!record || typeof record !== 'object') return { ok: false, reason: 'approval record is missing or not an object' };
  const r = record as Partial<ApprovalRecord>;
  if (r.schema_version !== APPROVAL_SCHEMA_VERSION) return { ok: false, reason: `unsupported approval schema_version ${String(r.schema_version)}` };
  if (typeof r.project_id !== 'string' || !r.project_id.trim()) return { ok: false, reason: 'approval record is missing project_id' };
  if (projectId !== undefined && String(r.project_id) !== String(projectId)) return { ok: false, reason: `approval project_id "${r.project_id}" does not match "${projectId}"` };
  if (r.status !== 'approved' && r.status !== 'stale') return { ok: false, reason: `invalid approval status "${String(r.status)}"` };
  if (!HEX64.test(String(r.approved_final_output_hash ?? ''))) return { ok: false, reason: 'approval is missing a valid final output hash' };
  if (typeof r.approved_final_stage_key !== 'string' || !r.approved_final_stage_key.trim()) return { ok: false, reason: 'approval is missing a final stage key' };

  const outputPath = normalizeRelativeOutputPath(r.approved_final_output_path);
  if (!outputPath.ok) return outputPath;

  const kind = r.approved_artifact_kind === undefined ? 'canonical' : r.approved_artifact_kind;
  if (kind !== 'canonical' && kind !== 'candidate') return { ok: false, reason: `invalid approval artifact kind "${String(kind)}"` };

  if (kind === 'canonical') {
    if (outputPath.relative !== CANONICAL_TITLE_BASENAME) {
      return { ok: false, reason: `canonical approval path must be ${CANONICAL_TITLE_BASENAME}` };
    }
    if (r.approved_candidate_provenance !== undefined) {
      return { ok: false, reason: 'canonical approval must not carry candidate provenance' };
    }
  } else {
    if (outputPath.relative === CANONICAL_TITLE_BASENAME) {
      return { ok: false, reason: 'candidate approval path must differ from the canonical TITLE output' };
    }
    const provenance = r.approved_candidate_provenance as Partial<CandidateApprovalProvenance> | undefined;
    if (!provenance || typeof provenance !== 'object') {
      return { ok: false, reason: 'candidate approval is missing TITLE provenance' };
    }
    if (provenance.source_stage !== 'TITLE') return { ok: false, reason: 'candidate approval provenance source_stage must be TITLE' };
    if (provenance.source_stage_key !== r.approved_final_stage_key) {
      return { ok: false, reason: 'candidate approval provenance stage key does not match the approved stage key' };
    }
    if (!HEX64.test(String(provenance.source_output_hash ?? ''))) {
      return { ok: false, reason: 'candidate approval provenance is missing a valid TITLE output hash' };
    }
    const sourcePath = normalizeRelativeOutputPath(provenance.source_output_path);
    if (!sourcePath.ok || sourcePath.relative !== CANONICAL_TITLE_BASENAME) {
      return { ok: false, reason: `candidate approval provenance source_output_path must be ${CANONICAL_TITLE_BASENAME}` };
    }
  }

  if (r.media_qa !== undefined) {
    const qa = r.media_qa as Partial<MediaQaEvidence> | null;
    if (!qa || typeof qa !== 'object') return { ok: false, reason: 'approval media_qa evidence must be an object' };
    if (!['PASS', 'WARNING', 'FAIL', 'SKIPPED'].includes(String(qa.status))) {
      return { ok: false, reason: `invalid approval media_qa status "${String(qa.status)}"` };
    }
    if (!HEX64.test(String(qa.artifact_hash ?? ''))) return { ok: false, reason: 'approval media_qa evidence is missing a valid artifact hash' };
    if (!HEX64.test(String(qa.report_hash ?? ''))) return { ok: false, reason: 'approval media_qa evidence is missing a valid report hash' };
    if (typeof qa.generated_at !== 'string' || !qa.generated_at.trim()) return { ok: false, reason: 'approval media_qa evidence is missing generated_at' };
    if (!Number.isFinite(Number(qa.blockers)) || !Number.isFinite(Number(qa.warnings))) {
      return { ok: false, reason: 'approval media_qa evidence is missing blocker/warning counts' };
    }
    if (!Array.isArray(qa.checks)) return { ok: false, reason: 'approval media_qa evidence is missing its checks list' };
    if (qa.status === 'FAIL') return { ok: false, reason: 'approval media_qa evidence records blocking failures' };
    if (String(qa.artifact_hash).toLowerCase() !== String(r.approved_final_output_hash).toLowerCase()) {
      return { ok: false, reason: 'approval media_qa evidence does not cover the approved artifact hash' };
    }
  }

  if (/blob:|cookie|authorization|bearer|chrome-profile|access_token/i.test(JSON.stringify(record))) return { ok: false, reason: 'approval record contains forbidden secret material' };
  return { ok: true };
}

/** Load an approval record (missing/malformed ⇒ null; never throws for corruption). */
export async function loadApproval(outputsDir: string, projectId: string): Promise<ApprovalRecord | null> {
  let raw: string;
  try { raw = await fsp.readFile(approvalPath(outputsDir, projectId), 'utf8'); } catch { return null; }
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return null; }
  return validateApprovalRecord(parsed, projectId).ok ? (parsed as ApprovalRecord) : null;
}

/** Atomic approval write (temp sibling + rename). */
export async function writeApproval(outputsDir: string, record: ApprovalRecord): Promise<string> {
  const v = validateApprovalRecord(record, record.project_id);
  if (!v.ok) throw new Error(`Refusing to write an invalid approval record: ${v.reason}`);
  const file = approvalPath(outputsDir, record.project_id);
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
  return file;
}

/** Read the recorded TITLE sidecar (authoritative stage record written during execution). */
async function readTitleStageRecord(outputsDir: string): Promise<{ key?: string; output_hash?: string; output_path?: string; key_inputs?: any } | null> {
  const sidecar = `${safeStageOutputPath(outputsDir, 'TITLE')}.stage`;
  try { return JSON.parse(await fsp.readFile(sidecar, 'utf8')); } catch { return null; }
}

/**
 * Resolve the EFFECTIVE TITLE stage inputs. Precedence:
 *   explicitly supplied `input.stageInputs` (current workflow/execution inputs — MUST win during a
 *   mutation/re-execution) → recorded sidecar `key_inputs` (lets `approveProject` reconstruct a
 *   non-standard artifact without the caller re-deriving paths) → undefined (existing standard
 *   behavior). Never fabricates provenance.
 */
async function effectiveTitleStageInputs(input: ApproveInput, outputsDir: string): Promise<any> {
  if (input.stageInputs) return input.stageInputs;
  const rec = await readTitleStageRecord(outputsDir);
  if (rec && rec.key_inputs && typeof rec.key_inputs === 'object' && Object.keys(rec.key_inputs).length > 0) return rec.key_inputs;
  return input.stageInputs;
}

/**
 * Evaluate the CURRENT approval verdict against durable evidence. Read-only. Fail closed:
 * any doubt ⇒ NOT_APPROVED or STALE_APPROVAL, never APPROVED.
 */
export async function evaluateApproval(input: ApproveInput): Promise<ApprovalVerdict> {
  const outputsDir = path.resolve(input.outputsDir);
  const record = await loadApproval(outputsDir, input.projectId);
  if (!record) return { status: 'NOT_APPROVED', reason: 'no approval record exists for this project' };
  if (record.status !== 'approved') {
    return { status: 'STALE_APPROVAL', record, reason: 'approval record is marked stale' };
  }

  // Recompute the CURRENT expected TITLE key + state from the read-only orchestrator view.
  const inspect = input.inspectProject ?? (async (args: any) => {
    const ORCH = await import('./productionOrchestrator.js');
    return ORCH.inspectProject(args);
  });
  let report: any;
  try {
    report = await inspect({ pipeline: input.pipeline, projectId: input.projectId, inputRoot: input.inputRoot, outputsDir, outputsRoot: input.outputsRoot, ffprobePath: input.ffprobePath, stageInputs: await effectiveTitleStageInputs(input, outputsDir), readOnly: true });
  } catch (e: any) {
    return { status: 'STALE_APPROVAL', record, reason: `could not re-derive project state: ${String(e?.message ?? e).slice(0, 120)}` };
  }
  const currentTitleKey = String(report?.downstream?.keys?.TITLE ?? '');
  if (!currentTitleKey) return { status: 'STALE_APPROVAL', record, reason: 'TITLE stage key could not be derived' };

  // Approval is bound to the exact final output hash + stage key.
  if (record.approved_final_stage_key !== currentTitleKey) {
    return { status: 'STALE_APPROVAL', record, reason: 'approved TITLE stage key no longer matches the current expected key' };
  }

  // Resolve the EXACT artifact named by the record. Never fall back to final-title.mp4: that
  // would silently authorize a different file after a candidate approval.
  const approvedPath = await resolveApprovalArtifactPath(outputsDir, record.approved_final_output_path, { mustExist: true });
  if (!approvedPath.ok) {
    return { status: 'STALE_APPROVAL', record, reason: `approved artifact path is unsafe or unavailable: ${approvedPath.reason}` };
  }
  const actual = await sha256OfFileOrNull(approvedPath.absPath);
  if (!actual || actual.toLowerCase() !== record.approved_final_output_hash.toLowerCase()) {
    return { status: 'STALE_APPROVAL', record, reason: 'approved final output hash does not match the file on disk' };
  }
  const clip = await validateVideoClip(approvedPath.absPath, { ffprobePath: input.ffprobePath });
  if (clip.state !== 'VALID') return { status: 'STALE_APPROVAL', record, reason: `approved final output failed media validation (${clip.state})` };

  // PHASE 4: persisted QA evidence must describe THIS artifact and must not record blockers.
  // Legacy approvals without media_qa stay valid; evidence for a different hash never authorizes
  // the current file.
  if (record.media_qa) {
    if (String(record.media_qa.artifact_hash).toLowerCase() !== actual.toLowerCase()) {
      return { status: 'STALE_APPROVAL', record, reason: 'media QA evidence does not cover the approved artifact' };
    }
    if (record.media_qa.status === 'FAIL') {
      return { status: 'STALE_APPROVAL', record, reason: 'media QA evidence recorded blocking failures for this artifact' };
    }
  }

  // A candidate is NOT the TITLE output, so its approval additionally has to remain tied to the
  // TITLE sidecar recorded at approval time. Missing/changed provenance is stale, never a reason
  // to fall back to final-title.mp4.
  if (approvalArtifactKind(record) === 'candidate') {
    const provenance = record.approved_candidate_provenance!;
    const recorded = await readTitleStageRecord(outputsDir);
    if (!recorded || !recorded.key) {
      return { status: 'STALE_APPROVAL', record, reason: 'candidate approval provenance sidecar is missing' };
    }
    if (recorded.key !== currentTitleKey || recorded.key !== provenance.source_stage_key) {
      return { status: 'STALE_APPROVAL', record, reason: 'candidate approval provenance stage key no longer matches the TITLE sidecar' };
    }
    if (!HEX64.test(String(recorded.output_hash ?? '')) || String(recorded.output_hash).toLowerCase() !== provenance.source_output_hash.toLowerCase()) {
      return { status: 'STALE_APPROVAL', record, reason: 'candidate approval provenance TITLE output hash no longer matches the TITLE sidecar' };
    }
    const recordedPath = normalizeRelativeOutputPath(recorded.output_path);
    if (!recordedPath.ok || recordedPath.relative !== CANONICAL_TITLE_BASENAME) {
      return { status: 'STALE_APPROVAL', record, reason: `candidate approval provenance is missing a valid ${CANONICAL_TITLE_BASENAME} path` };
    }
    const canonicalActual = await sha256OfFileOrNull(safeStageOutputPath(outputsDir, 'TITLE'));
    if (!canonicalActual || canonicalActual.toLowerCase() !== provenance.source_output_hash.toLowerCase()) {
      return { status: 'STALE_APPROVAL', record, reason: 'candidate approval provenance TITLE output no longer matches the file on disk' };
    }
  }

  return { status: 'APPROVED', record, finalOutputHash: actual, finalOutputPath: approvedPath.absPath };
}

/**
 * Explicitly approve the current final artifact. Fail-closed preconditions (STEP-8GV §2).
 * Idempotent: approving an unchanged, already-approved artifact rewrites nothing.
 */
export async function approveProject(input: ApproveInput): Promise<ApproveOutcome> {
  const outputsDir = path.resolve(input.outputsDir);
  const candidateRequested = input.candidatePath !== undefined && String(input.candidatePath).trim() !== '';
  const expectedHashRaw = input.expectedHash === undefined ? '' : String(input.expectedHash).trim();
  if (expectedHashRaw && !HEX64.test(expectedHashRaw)) {
    return { ok: false, code: 'PRECONDITION_FAILED', reason: 'expected artifact hash must be a 64-character SHA-256 hex digest' };
  }
  if (candidateRequested && !expectedHashRaw) {
    return { ok: false, code: 'PRECONDITION_FAILED', reason: 'candidate approval requires the exact expected SHA-256' };
  }
  const expectedHash = expectedHashRaw.toLowerCase();

  // Resolve the requested artifact BEFORE project inspection so traversal/absolute escapes fail
  // closed without touching any stage output.
  let target: { kind: ApprovalArtifactKind; absPath: string; relativePath: string };
  if (candidateRequested) {
    const relative = candidateRelativePath(outputsDir, input.candidatePath);
    if (!relative.ok) return { ok: false, code: 'PRECONDITION_FAILED', reason: relative.reason };
    const resolved = await resolveApprovalArtifactPath(outputsDir, relative.relative, { mustExist: true });
    if (!resolved.ok) return { ok: false, code: 'PRECONDITION_FAILED', reason: resolved.reason };
    target = { kind: 'candidate', absPath: resolved.absPath, relativePath: resolved.relativePath };
  } else {
    try {
      target = { kind: 'canonical', absPath: safeStageOutputPath(outputsDir, 'TITLE'), relativePath: CANONICAL_TITLE_BASENAME };
    } catch (e: any) {
      return { ok: false, code: 'PRECONDITION_FAILED', reason: String(e?.message ?? e).slice(0, 160) };
    }
  }

  // 1. Preconditions via the read-only orchestrator view.
  const inspect = input.inspectProject ?? (async (args: any) => {
    const ORCH = await import('./productionOrchestrator.js');
    return ORCH.inspectProject(args);
  });
  let report: any;
  try {
    report = await inspect({ pipeline: input.pipeline, projectId: input.projectId, inputRoot: input.inputRoot, outputsDir, outputsRoot: input.outputsRoot, ffprobePath: input.ffprobePath, stageInputs: await effectiveTitleStageInputs(input, outputsDir), readOnly: true });
  } catch (e: any) {
    return { ok: false, code: 'PRECONDITION_FAILED', reason: `could not derive project state: ${String(e?.message ?? e).slice(0, 160)}` };
  }

  // State must be at the approval gate (AWAITING_APPROVAL) and TITLE must be CURRENT.
  const state = String(report?.state ?? '');
  if (state !== 'AWAITING_APPROVAL') return { ok: false, code: 'PRECONDITION_FAILED', reason: `project state is ${state || 'unknown'}, expected AWAITING_APPROVAL` };
  const titleState = String(report?.downstream?.states?.TITLE ?? '');
  if (titleState !== 'CURRENT') return { ok: false, code: 'PRECONDITION_FAILED', reason: `TITLE is ${titleState || 'unknown'}, expected CURRENT` };
  // No upstream stage stale/invalid.
  for (const st of ['EDIT', 'MIX', 'BED']) {
    if (String(report?.downstream?.states?.[st] ?? '') !== 'CURRENT') return { ok: false, code: 'PRECONDITION_FAILED', reason: `${st} is not CURRENT` };
  }
  // No required input currently invalid.
  if (Number(report?.counts?.invalid ?? 0) > 0) return { ok: false, code: 'PRECONDITION_FAILED', reason: 'the project has invalid required inputs' };

  const currentTitleKey = String(report?.downstream?.keys?.TITLE ?? '');
  if (!currentTitleKey) return { ok: false, code: 'PRECONDITION_FAILED', reason: 'TITLE stage key could not be derived' };
  const rec = await readTitleStageRecord(outputsDir);
  if (!rec || !rec.key) return { ok: false, code: 'PRECONDITION_FAILED', reason: 'TITLE has no recorded stage sidecar' };
  if (rec.key !== currentTitleKey) return { ok: false, code: 'PRECONDITION_FAILED', reason: 'recorded TITLE stage key does not match the current expected key' };

  const titleFile = safeStageOutputPath(outputsDir, 'TITLE');
  const titleActual = await sha256OfFileOrNull(titleFile);
  if (!titleActual) return { ok: false, code: 'PRECONDITION_FAILED', reason: 'TITLE output is missing or unreadable' };
  if (!HEX64.test(String(rec.output_hash ?? '')) || String(rec.output_hash).toLowerCase() !== titleActual.toLowerCase()) {
    return { ok: false, code: 'PRECONDITION_FAILED', reason: 'recorded TITLE output hash does not match the file on disk' };
  }

  if (target.kind === 'candidate') {
    const recordedPath = normalizeRelativeOutputPath(rec.output_path);
    if (!recordedPath.ok || recordedPath.relative !== CANONICAL_TITLE_BASENAME) {
      return { ok: false, code: 'PRECONDITION_FAILED', reason: `TITLE sidecar is missing a valid ${CANONICAL_TITLE_BASENAME} provenance path` };
    }
  }

  const actual = target.kind === 'canonical' ? titleActual : await sha256OfFileOrNull(target.absPath);
  if (!actual) return { ok: false, code: 'PRECONDITION_FAILED', reason: `${target.kind === 'candidate' ? 'candidate' : 'TITLE'} output is missing or unreadable` };
  if (expectedHash && actual.toLowerCase() !== expectedHash) {
    return { ok: false, code: 'PRECONDITION_FAILED', reason: `artifact hash ${actual.toLowerCase()} does not match expected ${expectedHash}` };
  }
  const clip = await validateVideoClip(target.absPath, { ffprobePath: input.ffprobePath });
  if (clip.state !== 'VALID') return { ok: false, code: 'PRECONDITION_FAILED', reason: `${target.kind === 'candidate' ? 'candidate' : 'TITLE'} output failed media validation (${clip.state})` };

  // 2. PHASE 4 media QA gate (READ-ONLY). Only active when a QA boundary is injected; it must
  // evaluate the exact artifact verified above, never a different render.
  let qaEvidence: MediaQaEvidence | undefined;
  if (input.mediaQa) {
    let qaReport: ProjectMediaQaReport;
    try {
      qaReport = await input.mediaQa({
        projectId: input.projectId,
        outputsDir,
        inputRoot: input.inputRoot,
        pipeline: input.pipeline,
        finalPath: target.absPath,
        ffprobePath: input.ffprobePath,
        ffmpegPath: input.ffmpegPath,
        now: input.now,
      });
    } catch (e: any) {
      return { ok: false, code: 'QA_UNAVAILABLE', reason: `media QA could not run: ${String(e?.message ?? e).slice(0, 160)}` };
    }
    if (!qaReport || typeof qaReport !== 'object' || !qaReport.artifactHash) {
      return { ok: false, code: 'QA_UNAVAILABLE', reason: 'media QA did not evaluate a final artifact' };
    }
    if (String(qaReport.artifactHash).toLowerCase() !== actual.toLowerCase()) {
      return { ok: false, code: 'QA_STALE', reason: 'media QA evaluated a different artifact hash than the one being approved' };
    }
    if (qaReport.status === 'FAIL') {
      const first = qaReport.checks.find((check) => check.status === 'FAIL');
      const detail = first ? `: ${first.asset} ${first.id} — ${first.explanation}` : '';
      return { ok: false, code: 'QA_BLOCKED', reason: `media QA found ${qaReport.counts.blockers} blocking issue(s)${detail}` };
    }
    if (qaReport.status === 'WARNING' && input.blockOnMediaQaWarnings) {
      return { ok: false, code: 'QA_BLOCKED', reason: `media QA produced ${qaReport.counts.warnings} warning(s) and warnings are configured to block approval` };
    }
    const evidence = projectQaEvidence(qaReport);
    if (!evidence) return { ok: false, code: 'QA_UNAVAILABLE', reason: 'media QA evidence could not be associated with the approved artifact' };
    qaEvidence = evidence;
  }

  // 3. Build the durable record. Canonical records keep the legacy shape; candidate records
  // explicitly declare that they are not the TITLE output and bind the current TITLE sidecar.
  const record: ApprovalRecord = {
    schema_version: APPROVAL_SCHEMA_VERSION,
    project_id: input.projectId,
    status: 'approved',
    approved_at: input.now ?? new Date().toISOString(),
    approved_final_output_path: target.relativePath,
    approved_final_output_hash: actual,
    approved_final_stage_key: currentTitleKey,
    ...(target.kind === 'candidate' ? {
      approved_artifact_kind: 'candidate' as const,
      approved_candidate_provenance: {
        source_stage: 'TITLE' as const,
        source_stage_key: currentTitleKey,
        source_output_path: CANONICAL_TITLE_BASENAME,
        source_output_hash: String(rec.output_hash).toLowerCase(),
      },
    } : {}),
    ...(qaEvidence ? { media_qa: qaEvidence } : {}),
  };

  // 4. Idempotency: an identical existing approval is left byte-identical (no churn). QA evidence
  // is compared by artifact + status + counts so an unchanged artifact stays idempotent even
  // though a fresh report carries a new timestamp.
  const sameEvidence = (left?: MediaQaEvidence, right?: MediaQaEvidence): boolean => {
    if (!left && !right) return true;
    if (!left || !right) return false;
    return String(left.artifact_hash).toLowerCase() === String(right.artifact_hash).toLowerCase()
      && left.status === right.status
      && Number(left.blockers) === Number(right.blockers)
      && Number(left.warnings) === Number(right.warnings);
  };
  const existing = await loadApproval(outputsDir, input.projectId);
  const existingRelative = existing ? normalizeRelativeOutputPath(existing.approved_final_output_path) : null;
  const existingProvenance = existing?.approved_candidate_provenance;
  const sameProvenance = target.kind === 'canonical' || (
    existingProvenance?.source_stage === 'TITLE'
    && existingProvenance.source_stage_key === record.approved_final_stage_key
    && existingProvenance.source_output_path === CANONICAL_TITLE_BASENAME
    && String(existingProvenance.source_output_hash ?? '').toLowerCase() === String(record.approved_candidate_provenance?.source_output_hash ?? '').toLowerCase()
  );
  if (existing
    && existingRelative?.ok
    && existingRelative.relative === record.approved_final_output_path
    && approvalArtifactKind(existing) === target.kind
    && existing.approved_final_output_hash.toLowerCase() === record.approved_final_output_hash.toLowerCase()
    && existing.approved_final_stage_key === record.approved_final_stage_key
    && sameProvenance
    && sameEvidence(existing.media_qa, qaEvidence)
    && existing.status === 'approved') {
    return { ok: true, record: existing, idempotent: true };
  }

  await writeApproval(outputsDir, record);
  return { ok: true, record, idempotent: false };
}

/**
 * Publish-readiness boundary. NEVER publishes and NEVER touches the network. A real external
 * publisher (zernio.ts) must still be invoked explicitly by a human.
 */
export type PublishReadiness =
  | { readiness: 'PUBLISH_BLOCKED_UNTIL_EXTERNAL_PUBLISHER'; approval: ApprovalRecord; finalOutputHash: string; finalOutputPath: string }
  | { readiness: 'PUBLISH_BLOCKED_NOT_APPROVED'; reason: string }
  | { readiness: 'PUBLISH_BLOCKED_STALE_APPROVAL'; reason: string };

export async function publishReadiness(input: ApproveInput): Promise<PublishReadiness> {
  const verdict = await evaluateApproval(input);
  if (verdict.status === 'APPROVED') return { readiness: 'PUBLISH_BLOCKED_UNTIL_EXTERNAL_PUBLISHER', approval: verdict.record, finalOutputHash: verdict.finalOutputHash, finalOutputPath: verdict.finalOutputPath };
  if (verdict.status === 'STALE_APPROVAL') return { readiness: 'PUBLISH_BLOCKED_STALE_APPROVAL', reason: verdict.reason };
  return { readiness: 'PUBLISH_BLOCKED_NOT_APPROVED', reason: verdict.reason };
}

/** Path of the approval sidecar. Approved artifact paths themselves stay relative to outputsDir. */
export function approvalRecordPath(outputsDir: string, projectId: string): string { return approvalPath(outputsDir, projectId); }

export { sha256OfFileOrNull, crypto };
