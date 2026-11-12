/**
 * PHASE 7 — thumbnail workflow: plan → render → QA → approve → status.
 *
 * Child-scoped by construction:
 *
 *   long-form thumbnail : outputs/<projectId>/thumbnail/
 *   Short cover         : outputs/<projectId>/shorts/<shortId>/cover/
 *
 * Nothing here writes into the long-form media, the Shorts video artifacts, the approved SEO package,
 * `approval.json` or `pipeline.json`. A cover lives inside its Short's own directory, so one Short's
 * cover can never invalidate another Short or the long-form thumbnail.
 *
 * Resume is hash-bound at three levels:
 *   · `design_hash` — an unchanged design is never rewritten;
 *   · `render_key`  — an unchanged design + unchanged source bytes reuses the rendered PNG;
 *   · `artifact_hash` + QA `report_hash` — approval is bound to the exact bytes and evidence.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { computeFileSha256, validateVideoClip, probeMedia } from './videoClip.js';
import {
  buildThumbnailDesign,
  representativeScene,
  thumbnailDesignHash,
  thumbnailRenderKey,
  type ConceptOverrides,
  type ShortStoryContext,
} from './thumbnailDesign.js';
import { renderThumbnail, type RenderSourcePaths } from './thumbnailRender.js';
import { runThumbnailQa, thumbnailQaCovers } from './thumbnailQa.js';
import {
  SHORTS_COVER_DIMENSIONS,
  THUMBNAIL_SCHEMA_VERSION,
  brandPlacement,
  type ThumbnailApprovalRecord,
  type ThumbnailApprovalVerdict,
  type ThumbnailCheckpoint,
  type ThumbnailDesign,
  type ThumbnailKind,
  type ThumbnailQaReport,
  type ThumbnailState,
  type ThumbnailStatus,
  type ThumbnailStatusReport,
} from './thumbnailTypes.js';
import { thumbnailLayoutFor } from './thumbnailDesign.js';

export const THUMBNAIL_DESIGN_FILE = 'design.json';
export const THUMBNAIL_CHECKPOINT_FILE = 'render.json';
export const THUMBNAIL_QA_FILE = 'qa.json';
export const THUMBNAIL_APPROVAL_FILE = 'approval.json';

const sha256 = (text: string): string => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

export function longFormThumbnailDir(outputsRoot: string, projectId: string): string {
  return path.join(outputsRoot, projectId, 'thumbnail');
}

export function shortCoverDir(outputsRoot: string, projectId: string, shortId: string): string {
  return path.join(outputsRoot, projectId, 'shorts', shortId, 'cover');
}

export function thumbnailDirFor(outputsRoot: string, projectId: string, kind: ThumbnailKind, ownerId: string): string {
  return kind === 'long_form' ? longFormThumbnailDir(outputsRoot, projectId) : shortCoverDir(outputsRoot, projectId, ownerId);
}

export function thumbnailArtifactName(kind: ThumbnailKind): string {
  return kind === 'long_form' ? 'thumbnail.png' : 'cover.png';
}

/** Reject any write that escapes the owner's own directory. */
export function assertInside(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`refusing to write outside ${root}: ${target}`);
  }
}

/** Source paths are stored with an explicit, machine-independent namespace. */
export function resolveSourcePath(options: {
  projectId: string;
  outputsRoot: string;
  inputRoot: string;
  relative: string;
}): string | null {
  const value = String(options.relative ?? '');
  if (value.startsWith('outputs:')) return path.join(options.outputsRoot, options.projectId, value.slice('outputs:'.length));
  if (value.startsWith('inputs:')) return path.join(options.inputRoot, value.slice('inputs:'.length));
  return null;
}

export interface ThumbnailWorkflowOptions {
  projectId: string;
  pipeline: any;
  outputsRoot: string;
  inputRoot: string;
  /** Set for a Short cover; omitted for the long-form thumbnail. */
  shortId?: string;
  overrides?: ConceptOverrides;
  backgroundMode?: 'scene_frame' | 'designed_card';
  ffmpegPath?: string;
  ffprobePath?: string;
  now?: string;
  /** Test seam. */
  qa?: typeof runThumbnailQa;
}

async function loadJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(target: string, value: unknown, guardRoot: string): Promise<boolean> {
  assertInside(guardRoot, target);
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

/** Read the Shorts plan (read-only) to obtain this Short's own hook/title/scenes. */
export async function loadShortContext(outputsRoot: string, projectId: string, shortId: string): Promise<ShortStoryContext | null> {
  const planFile = path.join(outputsRoot, projectId, 'shorts', 'shorts-plan.json');
  const plan = await loadJson<any>(planFile);
  const entry = Array.isArray(plan?.shorts) ? plan.shorts.find((short: any) => short?.short_id === shortId) : null;
  if (!entry) return null;
  return {
    short_id: String(entry.short_id),
    title: String(entry.title ?? ''),
    hook: {
      scene_number: Number(entry.hook?.scene_number ?? 0),
      text: String(entry.hook?.text ?? ''),
    },
    scene_refs: Array.isArray(entry.scene_refs) ? entry.scene_refs.map(Number) : [],
  };
}

async function resolveSceneClip(options: {
  projectId: string;
  outputsRoot: string;
  inputRoot: string;
  sceneNumber: number;
  ffprobePath?: string;
}): Promise<{ absolute: string; relative: string; sha256: string; frameSeconds: number } | null> {
  const name = `scene-${String(options.sceneNumber).padStart(4, '0')}.mp4`;
  const candidates: Array<{ absolute: string; relative: string }> = [
    { absolute: path.join(options.outputsRoot, options.projectId, name), relative: `outputs:${name}` },
    { absolute: path.join(options.inputRoot, 'flow-clips', name), relative: `inputs:flow-clips/${name}` },
  ];
  for (const candidate of candidates) {
    const clip = await validateVideoClip(candidate.absolute, { ffprobePath: options.ffprobePath }).catch(() => null);
    if (!clip || clip.state !== 'VALID' || typeof clip.durationSeconds !== 'number' || clip.durationSeconds <= 0) continue;
    const hash = await computeFileSha256(candidate.absolute);
    // A frame at 35% of the clip avoids the opening fade without ever picking a random moment.
    const frameSeconds = Number(Math.min(Math.max(clip.durationSeconds * 0.35, 0), 2.5).toFixed(3));
    return { absolute: candidate.absolute, relative: candidate.relative, sha256: hash, frameSeconds };
  }
  return null;
}

async function resolveLogo(inputRoot: string): Promise<{ absolute: string; relative: string; sha256: string } | null> {
  const absolute = path.join(inputRoot, 'branding', 'channel-logo.png');
  try {
    const stat = await fsp.stat(absolute);
    if (!stat.isFile() || stat.size <= 0) return null;
  } catch {
    return null;
  }
  const hash = await computeFileSha256(absolute);
  return { absolute, relative: 'inputs:branding/channel-logo.png', sha256: hash };
}

export interface ThumbnailPlanResult {
  ok: boolean;
  kind: ThumbnailKind;
  ownerId: string;
  designPath: string;
  design: ThumbnailDesign | null;
  written: boolean;
  warnings: string[];
  errors: string[];
}

/** Derive (and persist only when changed) the design for one owner. */
export async function planThumbnail(options: ThumbnailWorkflowOptions): Promise<ThumbnailPlanResult> {
  const kind: ThumbnailKind = options.shortId ? 'short_cover' : 'long_form';
  const ownerId = options.shortId ?? 'long-form';
  const dir = thumbnailDirFor(options.outputsRoot, options.projectId, kind, ownerId);
  const designPath = path.join(dir, THUMBNAIL_DESIGN_FILE);
  const warnings: string[] = [];
  const errors: string[] = [];

  if (kind === 'short_cover') {
    const dirGuard = path.join(options.outputsRoot, options.projectId, 'shorts');
    assertInside(dirGuard, dir);
  }

  let short: ShortStoryContext | null = null;
  if (kind === 'short_cover') {
    short = await loadShortContext(options.outputsRoot, options.projectId, String(options.shortId));
    if (!short) {
      return { ok: false, kind, ownerId, designPath, design: null, written: false, warnings, errors: [`no Short ${options.shortId} exists in the Shorts plan; run \`video shorts plan\` first`] };
    }
  }

  // ---- resolve the story-specific source ----
  const sceneNumber = options.overrides?.sceneNumber !== undefined && options.overrides?.sceneNumber !== null
    ? Number(options.overrides.sceneNumber)
    : kind === 'short_cover' && short
      ? Number(short.hook.scene_number || short.scene_refs[0] || 0) || null
      // The long-form default is the same deterministic narrator scene the concept names, so the
      // still can never contradict spoken dialogue.
      : representativeScene(options.pipeline);

  const sources: ThumbnailDesign['sources'] = [];
  let backgroundMode = options.backgroundMode;

  const base = sceneNumber
    ? await resolveSceneClip({
      projectId: options.projectId, outputsRoot: options.outputsRoot, inputRoot: options.inputRoot,
      sceneNumber, ffprobePath: options.ffprobePath,
    })
    : null;

  if (base) {
    sources.push({
      role: 'base',
      relative_path: base.relative,
      sha256: base.sha256,
      scene_number: sceneNumber,
      frame_seconds: base.frameSeconds,
    });
  } else {
    backgroundMode = 'designed_card';
    warnings.push(sceneNumber
      ? `scene ${sceneNumber} has no valid rendered clip; the ${kind === 'long_form' ? 'thumbnail' : 'cover'} uses a designed card instead of inventing imagery`
      : `no story frame is available; the ${kind === 'long_form' ? 'thumbnail' : 'cover'} uses a designed card instead of inventing imagery`);
  }

  const logo = await resolveLogo(options.inputRoot);
  if (logo) {
    sources.push({ role: 'logo', relative_path: logo.relative, sha256: logo.sha256 });
  } else {
    warnings.push('no channel logo was found in inputs/<id>/branding; branding presence will fail QA');
  }

  const createdAt = options.now ?? new Date().toISOString();
  const design = buildThumbnailDesign({
    projectId: options.projectId,
    kind,
    pipeline: options.pipeline,
    short,
    sources: sources as any,
    overrides: options.overrides,
    backgroundMode,
    createdAt,
  });

  const existing = await loadJson<ThumbnailDesign>(designPath);
  if (existing && existing.design_hash === design.design_hash) {
    return { ok: true, kind, ownerId, designPath, design: existing, written: false, warnings, errors };
  }

  await fsp.mkdir(dir, { recursive: true });
  await writeJsonAtomic(designPath, design, dir);
  return { ok: true, kind, ownerId, designPath, design, written: true, warnings, errors };
}

export interface ThumbnailRenderResult {
  ok: boolean;
  kind: ThumbnailKind;
  ownerId: string;
  action: 'RENDERED' | 'REUSED' | 'FAILED';
  artifactPath: string;
  checkpoint: ThumbnailCheckpoint | null;
  warnings: string[];
  errors: string[];
}

/** Render the design, or reuse the existing artifact when the render key and bytes still match. */
export async function renderThumbnailArtifact(options: ThumbnailWorkflowOptions): Promise<ThumbnailRenderResult> {
  const kind: ThumbnailKind = options.shortId ? 'short_cover' : 'long_form';
  const ownerId = options.shortId ?? 'long-form';
  const dir = thumbnailDirFor(options.outputsRoot, options.projectId, kind, ownerId);
  const artifactPath = path.join(dir, thumbnailArtifactName(kind));
  const checkpointPath = path.join(dir, THUMBNAIL_CHECKPOINT_FILE);
  const warnings: string[] = [];
  const errors: string[] = [];

  const design = await loadJson<ThumbnailDesign>(path.join(dir, THUMBNAIL_DESIGN_FILE));
  if (!design) {
    return { ok: false, kind, ownerId, action: 'FAILED', artifactPath, checkpoint: null, warnings, errors: [`no design exists for ${ownerId}; run \`video thumbnail plan\` first`] };
  }

  // ---- re-verify every source: a changed clip means the design is stale ----
  const paths: RenderSourcePaths = { base: null, logo: null };
  const changed: string[] = [];
  for (const source of design.sources) {
    const absolute = resolveSourcePath({
      projectId: options.projectId, outputsRoot: options.outputsRoot, inputRoot: options.inputRoot, relative: source.relative_path,
    });
    if (!absolute) {
      errors.push(`source ${source.relative_path} cannot be resolved`);
      continue;
    }
    const current = await computeFileSha256(absolute).catch(() => null);
    if (current !== source.sha256) changed.push(`${source.relative_path} (${source.role})`);
    if (source.role === 'base') paths.base = absolute;
    if (source.role === 'logo') paths.logo = absolute;
  }

  if (errors.length > 0) {
    return { ok: false, kind, ownerId, action: 'FAILED', artifactPath, checkpoint: null, warnings, errors };
  }
  if (changed.length > 0) {
    return {
      ok: false, kind, ownerId, action: 'FAILED', artifactPath, checkpoint: null, warnings,
      errors: [`source changed since the design was planned: ${changed.join(', ')}; re-run \`video thumbnail plan\` to record the new hashes`],
    };
  }

  const renderKey = thumbnailRenderKey(design);
  const existingCheckpoint = await loadJson<ThumbnailCheckpoint>(checkpointPath);
  if (existingCheckpoint && existingCheckpoint.render_key === renderKey) {
    const currentHash = await computeFileSha256(artifactPath).catch(() => null);
    if (currentHash && currentHash === existingCheckpoint.artifact_hash) {
      return { ok: true, kind, ownerId, action: 'REUSED', artifactPath, checkpoint: existingCheckpoint, warnings, errors };
    }
  }

  await fsp.mkdir(dir, { recursive: true });
  const rendered = await renderThumbnail({
    design,
    paths,
    outputPath: artifactPath,
    workDir: dir,
    ffmpegPath: options.ffmpegPath,
  });
  if (!rendered.ok || !rendered.sha256) {
    return { ok: false, kind, ownerId, action: 'FAILED', artifactPath, checkpoint: null, warnings, errors: [rendered.error ?? 'the renderer failed'] };
  }

  // Verify the produced image before recording a checkpoint: a failed render must never checkpoint.
  const probe = await probeMedia(artifactPath, { ffprobePath: options.ffprobePath }).catch(() => null);
  const width = probe?.video?.width ?? null;
  const height = probe?.video?.height ?? null;
  if (width !== design.width || height !== design.height) {
    await fsp.rm(artifactPath, { force: true }).catch(() => undefined);
    return {
      ok: false, kind, ownerId, action: 'FAILED', artifactPath, checkpoint: null, warnings,
      errors: [`the renderer produced ${width ?? '?'}x${height ?? '?'}, expected ${design.width}x${design.height}; the artifact was discarded`],
    };
  }

  const checkpoint: ThumbnailCheckpoint = {
    schema_version: THUMBNAIL_SCHEMA_VERSION,
    project_id: options.projectId,
    kind,
    owner_id: ownerId,
    render_key: renderKey,
    design_hash: design.design_hash,
    artifact_path: path.basename(artifactPath),
    artifact_hash: rendered.sha256,
    bytes: rendered.bytes ?? 0,
    width: design.width,
    height: design.height,
    format: probe?.formatName ?? 'png',
    sources: design.sources,
    branding_applied: Boolean(paths.logo) && Boolean(design.branding.logo_relative_path),
    renderer_version: design.render.renderer_version,
    rendered_at: options.now ?? new Date().toISOString(),
  };
  await writeJsonAtomic(checkpointPath, checkpoint, dir);
  return { ok: true, kind, ownerId, action: 'RENDERED', artifactPath, checkpoint, warnings, errors };
}

export interface ThumbnailQaResult {
  ok: boolean;
  kind: ThumbnailKind;
  ownerId: string;
  report: ThumbnailQaReport | null;
  reportPath: string;
  written: boolean;
  errors: string[];
}

export async function qaThumbnailArtifact(options: ThumbnailWorkflowOptions): Promise<ThumbnailQaResult> {
  const kind: ThumbnailKind = options.shortId ? 'short_cover' : 'long_form';
  const ownerId = options.shortId ?? 'long-form';
  const dir = thumbnailDirFor(options.outputsRoot, options.projectId, kind, ownerId);
  const reportPath = path.join(dir, THUMBNAIL_QA_FILE);

  const design = await loadJson<ThumbnailDesign>(path.join(dir, THUMBNAIL_DESIGN_FILE));
  const checkpoint = await loadJson<ThumbnailCheckpoint>(path.join(dir, THUMBNAIL_CHECKPOINT_FILE));
  if (!design || !checkpoint) {
    return { ok: false, kind, ownerId, report: null, reportPath, written: false, errors: ['no design/checkpoint exists; plan and render before QA'] };
  }
  const artifactPath = path.join(dir, thumbnailArtifactName(kind));

  const paths: RenderSourcePaths = { base: null, logo: null };
  const sourceHashes: Record<string, string | null> = {};
  for (const source of design.sources) {
    const absolute = resolveSourcePath({
      projectId: options.projectId, outputsRoot: options.outputsRoot, inputRoot: options.inputRoot, relative: source.relative_path,
    });
    sourceHashes[source.relative_path] = absolute ? await computeFileSha256(absolute).catch(() => null) : null;
    if (absolute && source.role === 'base') paths.base = absolute;
    if (absolute && source.role === 'logo') paths.logo = absolute;
  }

  let longForm: { design_hash: string; headline: string; base_sha256: string | null } | null = null;
  if (kind === 'short_cover') {
    const longFormDesign = await loadJson<ThumbnailDesign>(path.join(longFormThumbnailDir(options.outputsRoot, options.projectId), THUMBNAIL_DESIGN_FILE));
    if (longFormDesign) {
      longForm = {
        design_hash: longFormDesign.design_hash,
        headline: longFormDesign.concept.headline,
        base_sha256: longFormDesign.sources.find((source) => source.role === 'base')?.sha256 ?? null,
      };
    }
  }

  const runner = options.qa ?? runThumbnailQa;
  const report = await runner({
    design,
    checkpoint,
    artifactPath,
    workDir: dir,
    paths,
    sourceHashes,
    longForm,
    ffmpegPath: options.ffmpegPath,
    ffprobePath: options.ffprobePath,
    now: options.now,
  });

  const written = await writeJsonAtomic(reportPath, report, dir);
  return { ok: report.ok, kind, ownerId, report, reportPath, written, errors: [] };
}

function evaluateApproval(input: {
  record: ThumbnailApprovalRecord | null;
  checkpoint: ThumbnailCheckpoint | null;
  qa: ThumbnailQaReport | null;
  artifactHash: string | null;
  design: ThumbnailDesign | null;
}): ThumbnailApprovalVerdict {
  const { record, checkpoint, qa, artifactHash, design } = input;
  if (!record) return { status: 'NOT_APPROVED', reason: 'no thumbnail approval has been recorded' };
  if (!checkpoint || !artifactHash) {
    return { status: 'STALE_APPROVAL', reason: 'the rendered artifact is missing', record };
  }
  if (record.approved_artifact_hash !== artifactHash) {
    return { status: 'STALE_APPROVAL', reason: 'the image bytes changed since approval', record };
  }
  if (record.approved_render_key !== checkpoint.render_key) {
    return { status: 'STALE_APPROVAL', reason: 'the render key changed since approval', record };
  }
  if (!design || !thumbnailQaCovers(qa, {
    artifactHash,
    designHash: design.design_hash,
    kind: design.kind,
    ownerId: design.owner_id,
  })) {
    return { status: 'STALE_APPROVAL', reason: 'the QA evidence no longer covers this image and design', record };
  }
  return { status: 'APPROVED', record, artifactHash };
}

export interface ApproveThumbnailOptions extends ThumbnailWorkflowOptions {
  confirmed: boolean;
  approvedBy?: string | null;
  expectedHash?: string | null;
  blockOnWarnings?: boolean;
}

export interface ApproveThumbnailResult {
  ok: boolean;
  kind: ThumbnailKind;
  ownerId: string;
  status: ThumbnailApprovalVerdict['status'] | 'REFUSED';
  reason: string;
  artifactPath: string;
  record: ThumbnailApprovalRecord | null;
}

export async function approveThumbnailArtifact(options: ApproveThumbnailOptions): Promise<ApproveThumbnailResult> {
  const kind: ThumbnailKind = options.shortId ? 'short_cover' : 'long_form';
  const ownerId = options.shortId ?? 'long-form';
  const dir = thumbnailDirFor(options.outputsRoot, options.projectId, kind, ownerId);
  const artifactPath = path.join(dir, thumbnailArtifactName(kind));
  const refuse = (reason: string): ApproveThumbnailResult => ({ ok: false, kind, ownerId, status: 'REFUSED', reason, artifactPath, record: null });

  if (!options.confirmed) return refuse('thumbnail approval requires an explicit --yes (it is a human decision).');

  const design = await loadJson<ThumbnailDesign>(path.join(dir, THUMBNAIL_DESIGN_FILE));
  const checkpoint = await loadJson<ThumbnailCheckpoint>(path.join(dir, THUMBNAIL_CHECKPOINT_FILE));
  if (!design || !checkpoint) return refuse('no rendered thumbnail exists; run `video thumbnail render` first.');

  const currentHash = await computeFileSha256(artifactPath).catch(() => null);
  if (!currentHash) return refuse('the rendered thumbnail is missing.');
  if (currentHash !== checkpoint.artifact_hash) return refuse('the image bytes do not match the checkpoint; re-render before approving.');
  if (options.expectedHash && String(options.expectedHash).toLowerCase() !== currentHash.toLowerCase()) {
    return refuse(`--sha256 ${String(options.expectedHash).slice(0, 12)}… does not match the artifact ${currentHash.slice(0, 12)}…`);
  }
  const currentKey = thumbnailRenderKey(design);
  if (currentKey !== checkpoint.render_key) return refuse('the design changed since the render; re-render before approving.');

  const qa = await loadJson<ThumbnailQaReport>(path.join(dir, THUMBNAIL_QA_FILE));
  if (!qa) return refuse('run `video thumbnail qa` before approving.');
  if (qa.status === 'FAIL') return refuse('the thumbnail QA is FAIL; fix the findings first.');
  if (options.blockOnWarnings && qa.status === 'WARNING') return refuse('--qa-warnings-block is set and QA reported warnings.');
  if (!thumbnailQaCovers(qa, { artifactHash: currentHash, designHash: design.design_hash, kind, ownerId })) {
    return refuse('the QA evidence does not cover the current image; re-run QA.');
  }

  const record: ThumbnailApprovalRecord = {
    schema_version: THUMBNAIL_SCHEMA_VERSION,
    project_id: options.projectId,
    kind,
    owner_id: ownerId,
    status: 'approved',
    approved_at: options.now ?? new Date().toISOString(),
    approved_by: options.approvedBy ?? null,
    approved_artifact_path: path.basename(artifactPath),
    approved_artifact_hash: currentHash,
    approved_render_key: checkpoint.render_key,
    media_qa: {
      status: qa.status,
      artifact_hash: currentHash,
      report_hash: qa.report_hash,
      generated_at: qa.generated_at,
    },
  };
  await writeJsonAtomic(path.join(dir, THUMBNAIL_APPROVAL_FILE), record, dir);
  return {
    ok: true, kind, ownerId, status: 'APPROVED',
    reason: 'approved for these exact bytes (nothing is uploaded; publishing is a separate explicit step).',
    artifactPath, record,
  };
}

export interface ThumbnailStatusOptions extends Omit<ThumbnailWorkflowOptions, 'pipeline'> {
  pipeline?: any;
}

async function statusFor(options: ThumbnailStatusOptions, kind: ThumbnailKind, ownerId: string): Promise<ThumbnailStatus | null> {
  const dir = thumbnailDirFor(options.outputsRoot, options.projectId, kind, ownerId);
  const design = await loadJson<ThumbnailDesign>(path.join(dir, THUMBNAIL_DESIGN_FILE));
  if (!design) return null;
  const checkpoint = await loadJson<ThumbnailCheckpoint>(path.join(dir, THUMBNAIL_CHECKPOINT_FILE));
  const artifactPath = path.join(dir, thumbnailArtifactName(kind));
  const artifactHash = await computeFileSha256(artifactPath).catch(() => null);
  const qa = await loadJson<ThumbnailQaReport>(path.join(dir, THUMBNAIL_QA_FILE));
  const approvalRecord = await loadJson<ThumbnailApprovalRecord>(path.join(dir, THUMBNAIL_APPROVAL_FILE));

  // Stale detection is read-only: recompute the key and re-hash the sources.
  let staleReason: string | null = null;
  if (!checkpoint) staleReason = 'the design has not been rendered yet';
  else if (!artifactHash) staleReason = 'the rendered image is missing';
  else if (artifactHash !== checkpoint.artifact_hash) staleReason = 'the image bytes changed since the render';
  else {
    const expectedKey = thumbnailRenderKey(design);
    if (expectedKey !== checkpoint.render_key) staleReason = 'the design changed since the render';
    else {
      const changed: string[] = [];
      for (const source of design.sources) {
        const absolute = resolveSourcePath({
          projectId: options.projectId, outputsRoot: options.outputsRoot, inputRoot: options.inputRoot, relative: source.relative_path,
        });
        const current = absolute ? await computeFileSha256(absolute).catch(() => null) : null;
        if (current !== source.sha256) changed.push(source.role);
      }
      if (changed.length > 0) staleReason = `source changed: ${changed.join(', ')}`;
    }
  }

  const approval = evaluateApproval({ record: approvalRecord, checkpoint, qa, artifactHash, design });
  const freshQa = qa && thumbnailQaCovers(qa, {
    artifactHash,
    designHash: design.design_hash,
    kind,
    ownerId,
  });

  let state: ThumbnailState;
  if (staleReason) state = 'stale';
  else if (!checkpoint) state = 'planned';
  else if (!qa) state = 'rendered';
  else if (qa.status === 'FAIL') state = 'qa_failed';
  else if (!freshQa) state = 'rendered';
  else if (approval.status === 'APPROVED') state = 'approved';
  else if (approval.status === 'STALE_APPROVAL') state = 'stale';
  else state = 'awaiting_approval';

  return {
    kind,
    owner_id: ownerId,
    state,
    artifact_path: artifactPath,
    artifact_hash: artifactHash,
    design_hash: design.design_hash,
    render_key: checkpoint?.render_key ?? null,
    stale_reason: staleReason,
    qa: qa ? { status: qa.status, report_hash: qa.report_hash, artifact_hash: qa.artifact_hash } : null,
    approval,
    publishable: false,
  };
}

/** Read-only status for the long-form thumbnail and every planned Short cover. */
export async function thumbnailStatus(options: ThumbnailStatusOptions): Promise<ThumbnailStatusReport> {
  const longForm = await statusFor(options, 'long_form', 'long-form');

  const covers: ThumbnailStatus[] = [];
  const plan = await loadJson<any>(path.join(options.outputsRoot, options.projectId, 'shorts', 'shorts-plan.json'));
  const shortIds: string[] = Array.isArray(plan?.shorts) ? plan.shorts.map((short: any) => String(short.short_id)) : [];
  for (const shortId of shortIds) {
    const status = await statusFor(options, 'short_cover', shortId);
    if (status) covers.push(status);
  }

  return {
    schema_version: THUMBNAIL_SCHEMA_VERSION,
    project_id: options.projectId,
    generated_at: options.now ?? new Date().toISOString(),
    read_only: true,
    long_form: longForm,
    covers,
    long_form_media_modified: false,
    publishable: false,
  };
}

export function renderThumbnailStatus(report: ThumbnailStatusReport): string {
  const lines: string[] = [];
  lines.push(`thumbnails:    ${report.project_id}`);
  const rows: Array<[string, ThumbnailStatus | null]> = [
    ['long-form', report.long_form],
    ...report.covers.map((cover) => [`cover:${cover.owner_id}`, cover] as [string, ThumbnailStatus]),
  ];
  for (const [label, status] of rows) {
    if (!status) {
      lines.push(`  ${label.padEnd(16)} not planned`);
      continue;
    }
    lines.push(`  ${label.padEnd(16)} ${status.state.padEnd(16)} ${status.artifact_hash ? status.artifact_hash.slice(0, 12) : 'no-bytes'}  ${status.approval.status}`);
    if (status.stale_reason) lines.push(`      stale: ${status.stale_reason}`);
  }
  lines.push('  long-form media: unchanged (thumbnails are derived artifacts)');
  lines.push('  publishable:     false — every thumbnail needs its own explicit approval.');
  return lines.join('\n');
}

/** Re-export for the CLI layer (one import site for the command implementation). */
export { thumbnailDesignHash, SHORTS_COVER_DIMENSIONS, brandPlacement, thumbnailLayoutFor };
export type { ThumbnailDesign, ThumbnailKind };
