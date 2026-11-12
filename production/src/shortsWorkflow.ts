/**
 * PHASE 6 — Shorts workflow: plan → render → QA → approve, with independent resume.
 *
 * This is a CHILD-SCOPE workflow. It reuses the existing infrastructure and adds no competing
 * project state, no second generation ledger, no second QA engine and no second approval system:
 *
 *   · state lives under `outputs/<projectId>/shorts/` and nowhere else;
 *   · media measurement is the Phase 4 `runMediaQa` engine (via `shortsQa.ts`);
 *   · clip validation is the existing `validateVideoClip`/`probeMedia` layer;
 *   · narration discovery/duration is the existing `narrationDuration` layer;
 *   · approval follows the Phase 4 record principles, scoped to one Short artifact.
 *
 * Independent resume: each Short has its own checkpoint (`shorts/<shortId>/short.json`) and its own
 * render key. A valid, unchanged Short is reused without re-rendering; rendering or re-rendering one
 * Short never invalidates another. The long-form pipeline, its outputs, its manifests and its
 * approval record are read-only inputs and are never written by this module.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  SHORTS_SCHEMA_VERSION,
  SHORTS_WIDTH,
  SHORTS_HEIGHT,
  type CaptionSegment,
  type NarrationSegment,
  type ShortApprovalRecord,
  type ShortApprovalVerdict,
  type ShortCheckpoint,
  type ShortMetadata,
  type ShortPlan,
  type ShortQaReport,
  type ShortState,
  type ShortStatus,
  type ShortsPlanFile,
  type ShortsStatusReport,
} from './shortsTypes.js';
import { createShortsPlan, planHashFor } from './shortsPlan.js';
import { buildAssFile, buildSrtFile, captionHash, validateCaptions } from './shortsCaptions.js';
import { resolveShortClips, type ResolvedShortClip } from './shortsClips.js';
import {
  buildShortTimeline,
  captionsForTimeline,
  renderShort,
  shortRenderKey,
  SHORTS_RENDERER_VERSION,
  SHORT_CAPTION_FILE,
  type ShortTimeline,
  type ShortFfmpegRunner,
} from './shortsRender.js';
import { runShortQa, artifactSha256, type MediaQaRunner } from './shortsQa.js';
import { mapNarrationFiles, measureAudioDuration } from './narrationDuration.js';
import { isNarrationScene } from './narrationWorkflow.js';
import { validateVideoClip } from './videoClip.js';
import { validateShortMetadata } from './shortsMetadata.js';

export const SHORTS_PLAN_FILE = 'shorts-plan.json';
export const SHORTS_CHECKPOINT_FILE = 'short.json';
export const SHORTS_QA_FILE = 'qa.json';
export const SHORTS_APPROVAL_FILE = 'approval.json';
export const SHORTS_CAPTIONS_JSON = 'captions.json';

const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
const normalize = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();

/** `<outputsRoot>/<projectId>/shorts` — the ONLY directory this module may write. */
export function shortsRoot(outputsRoot: string, projectId: string): string {
  return path.join(outputsRoot, projectId, 'shorts');
}
export function shortsPlanPath(outputsRoot: string, projectId: string): string {
  return path.join(shortsRoot(outputsRoot, projectId), SHORTS_PLAN_FILE);
}
export function shortDir(outputsRoot: string, projectId: string, shortId: string): string {
  return path.join(shortsRoot(outputsRoot, projectId), shortId);
}
export function shortArtifactName(shortId: string): string {
  return `${shortId}.mp4`;
}

async function writeAtomic(file: string, contents: string | Buffer): Promise<void> {
  const target = path.resolve(file);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  await fsp.writeFile(temp, contents);
  await fsp.rename(temp, target);
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Guard: every write must stay inside `<outputsRoot>/<projectId>/shorts`. */
export function assertInsideShortsRoot(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`refusing to write outside the shorts directory: ${target}`);
  }
}

export interface WorkflowOptions {
  projectId: string;
  projectFile: string;
  outputsRoot: string;
  inputRoot: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  now?: string;
  /** Test seams. */
  runner?: ShortFfmpegRunner;
  mediaQa?: MediaQaRunner;
}

interface ProjectContext {
  projectId: string;
  pipeline: any;
  outputsRoot: string;
  inputRoot: string;
  shortsDir: string;
}

async function loadContext(options: WorkflowOptions): Promise<ProjectContext> {
  const projectId = String(options.projectId ?? '').trim();
  if (!projectId || !/^[A-Za-z0-9._-]+$/.test(projectId)) throw new Error(`invalid project id ${JSON.stringify(options.projectId)}`);
  const raw = await fsp.readFile(options.projectFile, 'utf8');
  const pipeline = JSON.parse(raw);
  return {
    projectId,
    pipeline,
    outputsRoot: options.outputsRoot,
    inputRoot: options.inputRoot,
    shortsDir: shortsRoot(options.outputsRoot, projectId),
  };
}

interface NarrationEvidence {
  files: Record<number, string>;
  durations: Record<number, number>;
  warnings: string[];
}

/** Resolve + measure narration audio for the scenes a Short actually needs. */
async function narrationEvidence(ctx: ProjectContext, sceneRefs: number[]): Promise<NarrationEvidence> {
  const dir = path.join(ctx.inputRoot, 'narration');
  const files: Record<number, string> = {};
  const durations: Record<number, number> = {};
  const warnings: string[] = [];
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    warnings.push(`no narration directory at ${path.join('inputs', 'narration')} for ${ctx.projectId}`);
    return { files, durations, warnings };
  }
  const { byScene, ambiguous } = mapNarrationFiles(entries);
  for (const sceneNumber of sceneRefs) {
    // Same long-form rule: a narrator track is installed only where the manifest asks for
    // narration. Character-speaking scenes keep the Flow clip's own dialogue audio.
    if (!isNarrationScene(ctx.pipeline, sceneNumber)) continue;
    if (ambiguous.has(sceneNumber)) {
      warnings.push(`scene ${sceneNumber} has multiple narration files; none is used`);
      continue;
    }
    const name = byScene.get(sceneNumber);
    if (!name) continue;
    const absolute = path.join(dir, name);
    const measured = await measureAudioDuration(absolute);
    if (!measured.ok) {
      warnings.push(`scene ${sceneNumber} narration is unreadable: ${measured.reason}`);
      continue;
    }
    files[sceneNumber] = absolute;
    durations[sceneNumber] = Number(measured.durationSeconds.toFixed(3));
  }
  return { files, durations, warnings };
}

interface PreparedShort {
  plan: ShortPlan;
  clips: ResolvedShortClip[];
  timeline: ShortTimeline;
  captions: CaptionSegment[];
  captionHash: string;
  metadata: ShortMetadata;
  logoPath: string | null;
  logoHash: string | null;
  shortKey: string;
  errors: string[];
  warnings: string[];
}

/** Recompute everything needed to render AND to verify one Short (no writes). */
async function prepareShort(ctx: ProjectContext, plan: ShortPlan, options: WorkflowOptions): Promise<PreparedShort> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const clips = await resolveShortClips({
    sceneRefs: plan.scene_refs,
    outputsDir: path.join(ctx.outputsRoot, ctx.projectId),
    inputRoot: ctx.inputRoot,
    ffprobePath: options.ffprobePath,
  });
  for (const clip of clips) if (clip.status !== 'OK') errors.push(`scene ${clip.scene_number}: ${clip.reason}`);

  const narration = await narrationEvidence(ctx, plan.scene_refs);
  warnings.push(...narration.warnings);

  // Hash the narration bytes as well as measuring them: a re-recorded line with an identical
  // duration must still invalidate the render key, otherwise a stale Short would be reused.
  const narrationHashes: Record<number, string> = {};
  for (const [scene, absolute] of Object.entries(narration.files)) {
    try {
      narrationHashes[Number(scene)] = crypto.createHash('sha256').update(await fsp.readFile(absolute)).digest('hex');
    } catch {
      warnings.push(`scene ${scene} narration could not be hashed; it is not part of the render key`);
    }
  }

  const timeline = buildShortTimeline({
    plan,
    clips,
    narrationFiles: narration.files,
    narrationDurations: narration.durations,
    narrationHashes,
  });
  warnings.push(...timeline.warnings);
  if (timeline.scenes.length !== plan.scene_refs.length) {
    errors.push(`the render timeline covers ${timeline.scenes.length} of ${plan.scene_refs.length} planned scene(s)`);
  }

  const captions = captionsForTimeline(timeline);
  const validation = validateCaptions(captions, {
    width: SHORTS_WIDTH,
    height: SHORTS_HEIGHT,
    durationSeconds: timeline.total_seconds,
  });
  if (validation.status === 'FAIL') {
    for (const issue of validation.issues.filter((issue) => issue.severity === 'FAIL')) errors.push(`caption ${issue.code}: ${issue.detail}`);
  }

  const metadataValidation = validateShortMetadata(plan.metadata, { projectId: ctx.projectId });
  if (!metadataValidation.ok) errors.push(`metadata: ${metadataValidation.reason}`);
  const metadata = plan.metadata;

  const logoPath = path.join(ctx.inputRoot, 'branding', 'channel-logo.png');
  let logo: string | null = null;
  let logoHash: string | null = null;
  try {
    const buffer = await fsp.readFile(logoPath);
    logo = logoPath;
    logoHash = crypto.createHash('sha256').update(buffer).digest('hex');
  } catch {
    warnings.push('no channel logo found under inputs/branding; the Short renders without the brand overlay');
  }

  const captionDigest = captionHash(captions);
  const shortKey = shortRenderKey({
    planHash: plan.plan_hash,
    timeline,
    captionHash: captionDigest,
    metadataHash: metadata.metadata_hash,
    logoHash,
    rendererVersion: SHORTS_RENDERER_VERSION,
  });

  return { plan, clips, timeline, captions, captionHash: captionDigest, metadata, logoPath: logo, logoHash, shortKey, errors, warnings };
}

function plannedCount(requested: number): number {
  const value = Math.trunc(Number(requested));
  if (!Number.isFinite(value)) return 3;
  return Math.min(3, Math.max(2, value));
}

export interface PlanShortsResult {
  ok: boolean;
  projectId: string;
  planPath: string;
  changed: boolean;
  plan: ShortsPlanFile | null;
  warnings: string[];
  errors: string[];
}

/**
 * Create (or refresh) the Shorts plan for a project. Repeatable: an unchanged story re-plans to an
 * identical `input_hash`, and the existing file is left untouched.
 */
export async function planShorts(options: WorkflowOptions & { count?: number }): Promise<PlanShortsResult> {
  const ctx = await loadContext(options);
  const count = plannedCount(options.count ?? 3);

  const sceneDurations: Record<number, number> = {};
  for (const scene of Array.isArray(ctx.pipeline?.scenes) ? ctx.pipeline.scenes : []) {
    const sceneNumber = Number(scene?.scene_number);
    if (!Number.isInteger(sceneNumber)) continue;
    let name = `scene-${String(sceneNumber).padStart(4, '0')}.mp4`;
    let absolute = path.join(ctx.outputsRoot, ctx.projectId, name);
    let stat = await fsp.stat(absolute).catch(() => null);
    if (!stat?.isFile()) {
      absolute = path.join(ctx.inputRoot, 'flow-clips', name);
      stat = await fsp.stat(absolute).catch(() => null);
    }
    if (!stat?.isFile()) continue;
    const clip = await validateVideoClip(absolute, { ffprobePath: options.ffprobePath });
    if (clip.state === 'VALID' && typeof clip.durationSeconds === 'number') {
      sceneDurations[sceneNumber] = Number(clip.durationSeconds.toFixed(3));
    }
  }

  const narration = await narrationEvidence(ctx, Object.keys(sceneDurations).map((key) => Number(key)));

  const plan = createShortsPlan({
    projectId: ctx.projectId,
    pipeline: ctx.pipeline,
    count,
    sceneDurations,
    narrationDurations: narration.durations,
    narrationFiles: Object.fromEntries(
      Object.entries(narration.files).map(([scene, absolute]) => [scene, path.relative(ctx.inputRoot, absolute).split(path.sep).join('/')]),
    ),
    now: options.now,
  });

  // Enrich each Short with the ACTUAL clip reuse evidence and the composition strategies really
  // used, so the plan is a truthful description of what will be rendered. `plan_hash` is recomputed
  // afterwards because the composition requirement is part of it.
  for (let index = 0; index < plan.shorts.length; index += 1) {
    const short = plan.shorts[index];
    const clips = await resolveShortClips({
      sceneRefs: short.scene_refs,
      outputsDir: path.join(ctx.outputsRoot, ctx.projectId),
      inputRoot: ctx.inputRoot,
      ffprobePath: options.ffprobePath,
    });
    const strategies = Array.from(new Set(clips
      .map((clip) => clip.reframe?.mode)
      .filter((mode): mode is 'cover' | 'crop' | 'blur_fill' => Boolean(mode))));
    const enriched = {
      ...short,
      clips: clips.map(({ absolutePath: _absolute, has_audio: _hasAudio, ...selection }) => selection),
      composition: { ...short.composition, strategies: strategies.length > 0 ? strategies : short.composition.strategies },
    };
    const { plan_hash: _originalHash, ...base } = enriched;
    plan.shorts[index] = { ...base, plan_hash: planHashFor(base) };
  }

  const planPath = shortsPlanPath(ctx.outputsRoot, ctx.projectId);
  assertInsideShortsRoot(ctx.shortsDir, planPath);
  const existing = await readJson<ShortsPlanFile>(planPath);
  const unchanged = Boolean(existing && existing.input_hash === plan.input_hash && existing.count === plan.count
    && existing.shorts.map((s) => s.plan_hash).join(',') === plan.shorts.map((s) => s.plan_hash).join(','));

  if (!unchanged) {
    await writeJsonAtomic(planPath, plan);
  }

  return {
    ok: plan.count >= 2,
    projectId: ctx.projectId,
    planPath,
    changed: !unchanged,
    plan: unchanged ? existing : plan,
    warnings: [...plan.warnings, ...narration.warnings],
    errors: plan.count >= 2 ? [] : [`only ${plan.count} coherent Short(s) could be planned; at least 2 are required`],
  };
}

async function loadPlan(ctx: ProjectContext): Promise<ShortsPlanFile | null> {
  return readJson<ShortsPlanFile>(shortsPlanPath(ctx.outputsRoot, ctx.projectId));
}

/** Read the per-Short checkpoint. */
export async function loadCheckpoint(ctx: { outputsRoot: string; projectId: string }, shortId: string): Promise<ShortCheckpoint | null> {
  return readJson<ShortCheckpoint>(path.join(shortDir(ctx.outputsRoot, ctx.projectId, shortId), SHORTS_CHECKPOINT_FILE));
}

/** Read the per-Short QA report. */
export async function loadShortQa(ctx: { outputsRoot: string; projectId: string }, shortId: string): Promise<ShortQaReport | null> {
  return readJson<ShortQaReport>(path.join(shortDir(ctx.outputsRoot, ctx.projectId, shortId), SHORTS_QA_FILE));
}

/** Read the per-Short approval record. */
export async function loadShortApproval(ctx: { outputsRoot: string; projectId: string }, shortId: string): Promise<ShortApprovalRecord | null> {
  return readJson<ShortApprovalRecord>(path.join(shortDir(ctx.outputsRoot, ctx.projectId, shortId), SHORTS_APPROVAL_FILE));
}

/**
 * Hash-bound approval verdict for ONE Short. An approval is only valid for the exact bytes it was
 * granted against and for the render key it was granted under.
 */
export async function shortApprovalVerdict(ctx: { outputsRoot: string; projectId: string }, shortId: string, currentKey?: string | null): Promise<ShortApprovalVerdict> {
  const record = await loadShortApproval(ctx, shortId);
  if (!record) return { status: 'NOT_APPROVED', reason: 'no approval record exists for this Short' };
  if (record.artifact_kind !== 'short' || record.short_id !== shortId) {
    return { status: 'STALE_APPROVAL', reason: 'the approval record does not belong to this Short', record };
  }
  if (currentKey && record.approved_short_key !== currentKey) {
    return { status: 'STALE_APPROVAL', reason: 'the Short inputs changed after approval', record };
  }
  const absolute = path.join(shortDir(ctx.outputsRoot, ctx.projectId, shortId), record.approved_output_path);
  let actual: string | null = null;
  try {
    actual = crypto.createHash('sha256').update(await fsp.readFile(absolute)).digest('hex');
  } catch {
    return { status: 'STALE_APPROVAL', reason: 'the approved artifact is missing', record };
  }
  if (actual !== record.approved_output_hash) {
    return { status: 'STALE_APPROVAL', reason: 'the approved artifact bytes changed', record };
  }
  return { status: 'APPROVED', record, outputHash: actual };
}

function stateFor(input: {
  checkpoint: ShortCheckpoint | null;
  qa: ShortQaReport | null;
  approval: ShortApprovalVerdict;
  rerenderReason: string | null;
}): ShortState {
  if (!input.checkpoint) return 'planned';
  if (input.approval.status === 'STALE_APPROVAL') return 'stale';
  if (input.approval.status === 'APPROVED' && !input.rerenderReason) return 'approved';
  if (input.qa?.status === 'FAIL') return 'qa_failed';
  // Any pending re-render (changed inputs, a missing artifact or changed artifact bytes) means the
  // bytes on disk are no longer the ones the plan describes, so the Short is stale — never
  // "awaiting_approval", which would imply the current artifact is reviewable.
  if (input.rerenderReason) return 'stale';
  if (input.qa) return 'awaiting_approval';
  return 'rendered';
}

export interface RenderShortsResult {
  ok: boolean;
  projectId: string;
  planPath: string;
  rendered: Array<{ shortId: string; action: 'RENDERED' | 'REUSED' | 'FAILED'; outputPath: string | null; reason: string; shortKey?: string }>;
  errors: string[];
  warnings: string[];
}

/**
 * Render every selected Short. A Short is reused when its render key matches the checkpoint and the
 * artifact bytes still hash to the recorded value. One Short's failure never stops the others.
 */
export async function renderShorts(options: WorkflowOptions & { shortId?: string; count?: number }): Promise<RenderShortsResult> {
  const ctx = await loadContext(options);
  const result: RenderShortsResult = { ok: true, projectId: ctx.projectId, planPath: shortsPlanPath(ctx.outputsRoot, ctx.projectId), rendered: [], errors: [], warnings: [] };

  const plan = await loadPlan(ctx);
  if (!plan) {
    result.ok = false;
    result.errors.push('no Shorts plan exists; run `video shorts plan` first');
    return result;
  }
  const selected = options.shortId ? plan.shorts.filter((short) => short.short_id === options.shortId) : plan.shorts;
  if (options.shortId && selected.length === 0) {
    result.ok = false;
    result.errors.push(`the plan has no Short ${options.shortId}`);
    return result;
  }

  for (const shortPlan of selected) {
    const dir = shortDir(ctx.outputsRoot, ctx.projectId, shortPlan.short_id);
    const artifact = path.join(dir, shortArtifactName(shortPlan.short_id));
    assertInsideShortsRoot(ctx.shortsDir, artifact);

    const prepared = await prepareShort(ctx, shortPlan, options);
    result.warnings.push(...prepared.warnings.map((warning) => `${shortPlan.short_id}: ${warning}`));
    if (prepared.errors.length > 0) {
      result.ok = false;
      result.rendered.push({ shortId: shortPlan.short_id, action: 'FAILED', outputPath: null, reason: prepared.errors.join('; ') });
      continue;
    }

    const previous = await loadCheckpoint(ctx, shortPlan.short_id);
    const currentHash = await artifactSha256(artifact);
    if (previous && previous.short_key === prepared.shortKey && currentHash && currentHash === previous.output_hash) {
      result.rendered.push({ shortId: shortPlan.short_id, action: 'REUSED', outputPath: artifact, reason: 'render key and artifact hash are unchanged', shortKey: prepared.shortKey });
      continue;
    }

    // Captions and metadata are written before the media so the burn-in always matches the
    // checkpointed caption hash and the reviewer can read the track without the video.
    await writeAtomic(path.join(dir, SHORT_CAPTION_FILE), buildAssFile(prepared.captions));
    await writeAtomic(path.join(dir, 'captions.srt'), buildSrtFile(prepared.captions));
    await writeJsonAtomic(path.join(dir, SHORTS_CAPTIONS_JSON), {
      schema_version: SHORTS_SCHEMA_VERSION,
      project_id: ctx.projectId,
      short_id: shortPlan.short_id,
      caption_hash: prepared.captionHash,
      total_seconds: prepared.timeline.total_seconds,
      segments: prepared.captions,
    });
    await writeJsonAtomic(path.join(dir, 'metadata.json'), prepared.metadata);

    const rendered = await renderShort({
      timeline: prepared.timeline,
      shortDir: dir,
      outputPath: artifact,
      logoPath: prepared.logoPath,
      burnCaptions: true,
      runner: options.runner,
    });
    if (!rendered.ok) {
      result.ok = false;
      result.rendered.push({ shortId: shortPlan.short_id, action: 'FAILED', outputPath: null, reason: rendered.reason });
      continue;
    }

    const probe = await validateVideoClip(artifact, { ffprobePath: options.ffprobePath });
    const outputHash = probe.sha256 ?? await artifactSha256(artifact);
    if (probe.state !== 'VALID' || !outputHash) {
      result.ok = false;
      result.rendered.push({ shortId: shortPlan.short_id, action: 'FAILED', outputPath: artifact, reason: `rendered file failed validation: ${probe.reason ?? 'unknown'}` });
      continue;
    }

    const checkpoint: ShortCheckpoint = {
      schema_version: SHORTS_SCHEMA_VERSION,
      project_id: ctx.projectId,
      short_id: shortPlan.short_id,
      short_key: prepared.shortKey,
      plan_hash: shortPlan.plan_hash,
      output_path: shortArtifactName(shortPlan.short_id),
      output_hash: outputHash,
      duration_seconds: probe.durationSeconds ?? prepared.timeline.total_seconds,
      width: probe.video?.width ?? SHORTS_WIDTH,
      height: probe.video?.height ?? SHORTS_HEIGHT,
      scene_refs: [...shortPlan.scene_refs],
      clip_hashes: Object.fromEntries(prepared.clips.filter((clip) => clip.sha256).map((clip) => [String(clip.scene_number), clip.sha256 as string])),
      narration_hashes: Object.fromEntries(prepared.timeline.scenes
        .filter((scene) => scene.narration_sha256)
        .map((scene) => [String(scene.scene_number), String(scene.narration_sha256)])),
      caption_hash: prepared.captionHash,
      metadata_hash: prepared.metadata.metadata_hash,
      renderer_version: SHORTS_RENDERER_VERSION,
      rendered_at: options.now ?? new Date().toISOString(),
    };
    await writeJsonAtomic(path.join(dir, SHORTS_CHECKPOINT_FILE), checkpoint);

    // A re-render invalidates the old QA evidence and any approval of the old bytes, but only for
    // THIS Short.
    await fsp.rm(path.join(dir, SHORTS_QA_FILE), { force: true }).catch(() => undefined);
    await fsp.rm(path.join(dir, SHORTS_APPROVAL_FILE), { force: true }).catch(() => undefined);

    result.rendered.push({ shortId: shortPlan.short_id, action: 'RENDERED', outputPath: artifact, reason: `rendered ${probe.durationSeconds?.toFixed(2) ?? '?'}s at ${probe.video?.width ?? '?'}×${probe.video?.height ?? '?'}`, shortKey: prepared.shortKey });
  }

  return result;
}

export interface ShortsStatusOptions extends WorkflowOptions {
  shortId?: string;
}

/** READ-ONLY status across all Shorts (also used by `resume` decisions). */
export async function shortsStatus(options: ShortsStatusOptions): Promise<ShortsStatusReport> {
  const ctx = await loadContext(options);
  const plan = await loadPlan(ctx);
  const shorts: ShortStatus[] = [];

  for (const shortPlan of plan?.shorts ?? []) {
    if (options.shortId && shortPlan.short_id !== options.shortId) continue;
    const checkpoint = await loadCheckpoint(ctx, shortPlan.short_id);
    const qa = await loadShortQa(ctx, shortPlan.short_id);
    const prepared = await prepareShort(ctx, shortPlan, options);
    const verdict = await shortApprovalVerdict(ctx, shortPlan.short_id, prepared.shortKey);
    const artifact = path.join(shortDir(ctx.outputsRoot, ctx.projectId, shortPlan.short_id), shortArtifactName(shortPlan.short_id));
    const actual = await artifactSha256(artifact);

    let rerenderReason: string | null = null;
    if (!checkpoint) rerenderReason = 'no checkpoint';
    else if (checkpoint.short_key !== prepared.shortKey) rerenderReason = 'inputs changed';
    else if (!actual) rerenderReason = 'artifact missing';
    else if (actual !== checkpoint.output_hash) rerenderReason = 'artifact hash changed';

    shorts.push({
      short_id: shortPlan.short_id,
      title: shortPlan.title,
      state: stateFor({ checkpoint, qa, approval: verdict, rerenderReason }),
      checkpoint,
      artifact_hash: actual,
      qa: qa ? { status: qa.status, report_hash: qa.reportHash, artifact_hash: qa.artifactHash } : null,
      approval: verdict,
      rerender_reason: rerenderReason,
      publishable: false,
    });
  }

  return {
    schema_version: SHORTS_SCHEMA_VERSION,
    project_id: ctx.projectId,
    generated_at: options.now ?? new Date().toISOString(),
    read_only: true,
    plan_present: Boolean(plan),
    plan_hash: plan ? hashOfPlan(plan) : null,
    count: shorts.length,
    shorts,
    long_form_modified: false,
    publishable: false,
  };
}

/** Fingerprint of the whole plan file (all Short plan hashes, in order). */
export function hashOfPlan(plan: ShortsPlanFile): string {
  return sha256(JSON.stringify({ input_hash: plan.input_hash, shorts: plan.shorts.map((short) => short.plan_hash) }));
}

export interface QaShortsResult {
  ok: boolean;
  projectId: string;
  reports: Array<{ shortId: string; status: ShortQaReport['status'] | 'STALE' | 'MISSING'; reportPath: string | null; reason: string }>;
  errors: string[];
}

/** Run Shorts QA for one or all Shorts. Read-only on the media; writes only `qa.json`. */
export async function qaShorts(options: WorkflowOptions & { shortId?: string }): Promise<QaShortsResult> {
  const ctx = await loadContext(options);
  const result: QaShortsResult = { ok: true, projectId: ctx.projectId, reports: [], errors: [] };
  const plan = await loadPlan(ctx);
  if (!plan) {
    result.ok = false;
    result.errors.push('no Shorts plan exists; run `video shorts plan` first');
    return result;
  }
  const selected = options.shortId ? plan.shorts.filter((short) => short.short_id === options.shortId) : plan.shorts;
  if (options.shortId && selected.length === 0) {
    result.ok = false;
    result.errors.push(`the plan has no Short ${options.shortId}`);
    return result;
  }

  for (const shortPlan of selected) {
    const checkpoint = await loadCheckpoint(ctx, shortPlan.short_id);
    if (!checkpoint) {
      result.reports.push({ shortId: shortPlan.short_id, status: 'MISSING', reportPath: null, reason: 'no checkpoint: render this Short first' });
      result.ok = false;
      continue;
    }
    const prepared = await prepareShort(ctx, shortPlan, options);
    if (prepared.shortKey !== checkpoint.short_key) {
      result.reports.push({ shortId: shortPlan.short_id, status: 'STALE', reportPath: null, reason: 'the Short inputs changed since it was rendered; re-render before QA' });
      result.ok = false;
      continue;
    }
    if (prepared.errors.length > 0) {
      result.reports.push({ shortId: shortPlan.short_id, status: 'STALE', reportPath: null, reason: prepared.errors.join('; ') });
      result.ok = false;
      continue;
    }

    const dir = shortDir(ctx.outputsRoot, ctx.projectId, shortPlan.short_id);
    const artifact = path.join(dir, shortArtifactName(shortPlan.short_id));
    const report = await runShortQa({
      projectId: ctx.projectId,
      plan: shortPlan,
      clips: prepared.clips,
      timeline: prepared.timeline,
      captions: prepared.captions,
      artifactPath: artifact,
      expectedHash: checkpoint.output_hash,
      ffmpegPath: options.ffmpegPath,
      ffprobePath: options.ffprobePath,
      now: options.now,
      mediaQa: options.mediaQa,
    });
    const reportPath = path.join(dir, SHORTS_QA_FILE);
    assertInsideShortsRoot(ctx.shortsDir, reportPath);
    await writeJsonAtomic(reportPath, report);
    if (report.status === 'FAIL') result.ok = false;
    result.reports.push({ shortId: shortPlan.short_id, status: report.status, reportPath, reason: `${report.counts.fail} blocker(s), ${report.counts.warning} warning(s)` });
  }

  return result;
}

export interface ApproveShortResult {
  ok: boolean;
  status: 'APPROVED' | 'REFUSED' | 'ERROR';
  shortId: string;
  record: ShortApprovalRecord | null;
  reason: string;
  outputHash: string | null;
}

/**
 * Record an explicit human approval for ONE Short artifact.
 *
 * Refused when: no checkpoint, QA missing/FAILED, QA bound to different bytes, the artifact bytes do
 * not match the checkpoint, or an expected hash was supplied that does not match. Warnings are
 * recorded and are only blocking when `blockOnWarnings` is set.
 */
export async function approveShort(options: WorkflowOptions & { shortId: string; approvedBy?: string | null; expectedHash?: string | null; blockOnWarnings?: boolean; confirmed?: boolean }): Promise<ApproveShortResult> {
  const ctx = await loadContext(options);
  const shortId = String(options.shortId ?? '').trim();
  if (!shortId) return { ok: false, status: 'ERROR', shortId, record: null, reason: 'a Short id is required', outputHash: null };
  if (options.confirmed !== true) {
    return { ok: false, status: 'REFUSED', shortId, record: null, reason: 'explicit confirmation is required (--yes) before an approval is recorded', outputHash: null };
  }

  const plan = await loadPlan(ctx);
  const shortPlan = plan?.shorts.find((short) => short.short_id === shortId) ?? null;
  if (!shortPlan) return { ok: false, status: 'ERROR', shortId, record: null, reason: `the plan has no Short ${shortId}`, outputHash: null };

  const checkpoint = await loadCheckpoint(ctx, shortId);
  if (!checkpoint) return { ok: false, status: 'REFUSED', shortId, record: null, reason: 'the Short has not been rendered', outputHash: null };

  const prepared = await prepareShort(ctx, shortPlan, options);
  if (prepared.shortKey !== checkpoint.short_key) {
    return { ok: false, status: 'REFUSED', shortId, record: null, reason: 'the Short inputs changed since it was rendered; re-render and re-run QA', outputHash: null };
  }

  const dir = shortDir(ctx.outputsRoot, ctx.projectId, shortId);
  const artifact = path.join(dir, shortArtifactName(shortId));
  const actual = await artifactSha256(artifact);
  if (!actual) return { ok: false, status: 'REFUSED', shortId, record: null, reason: 'the rendered artifact is missing', outputHash: null };
  if (actual !== checkpoint.output_hash) {
    return { ok: false, status: 'REFUSED', shortId, record: null, reason: 'the artifact bytes do not match the checkpoint; re-render before approving', outputHash: actual };
  }
  const expected = String(options.expectedHash ?? '').trim().toLowerCase();
  if (expected && expected !== actual) {
    return { ok: false, status: 'REFUSED', shortId, record: null, reason: `--sha256 ${expected.slice(0, 12)}… does not match the artifact ${actual.slice(0, 12)}…`, outputHash: actual };
  }

  const qa = await loadShortQa(ctx, shortId);
  if (!qa) return { ok: false, status: 'REFUSED', shortId, record: null, reason: 'no Shorts QA report exists; run `video shorts qa` first', outputHash: actual };
  if (qa.status === 'FAIL' || !qa.ok) {
    return { ok: false, status: 'REFUSED', shortId, record: null, reason: `Shorts QA has ${qa.counts.fail} blocker(s); a failing Short cannot be approved`, outputHash: actual };
  }
  if (options.blockOnWarnings && qa.counts.warning > 0) {
    return { ok: false, status: 'REFUSED', shortId, record: null, reason: `Shorts QA has ${qa.counts.warning} warning(s) and --qa-warnings-block is set`, outputHash: actual };
  }
  if (qa.artifactHash !== actual) {
    return { ok: false, status: 'REFUSED', shortId, record: null, reason: 'the QA report was produced for different bytes; re-run `video shorts qa`', outputHash: actual };
  }

  const record: ShortApprovalRecord = {
    schema_version: SHORTS_SCHEMA_VERSION,
    project_id: ctx.projectId,
    short_id: shortId,
    artifact_kind: 'short',
    status: 'approved',
    approved_at: options.now ?? new Date().toISOString(),
    approved_by: normalize(options.approvedBy) || null,
    approved_output_path: shortArtifactName(shortId),
    approved_output_hash: actual,
    approved_short_key: checkpoint.short_key,
    media_qa: {
      status: qa.media_qa.status,
      artifact_hash: qa.artifactHash ?? actual,
      report_hash: qa.reportHash,
      generated_at: qa.generated_at,
    },
  };
  const approvalPath = path.join(dir, SHORTS_APPROVAL_FILE);
  assertInsideShortsRoot(ctx.shortsDir, approvalPath);
  await writeJsonAtomic(approvalPath, record);
  return { ok: true, status: 'APPROVED', shortId, record, reason: 'approval recorded locally; nothing was uploaded or published', outputHash: actual };
}

/** Human-readable status report. */
export function renderShortsStatus(report: ShortsStatusReport): string {
  const lines: string[] = [];
  lines.push(`shorts:        ${report.count} planned (${report.plan_present ? 'plan present' : 'no plan'})`);
  lines.push(`plan hash:     ${report.plan_hash ? `${report.plan_hash.slice(0, 16)}…` : 'none'}`);
  for (const short of report.shorts) {
    const approval = short.approval.status === 'APPROVED' ? 'approved' : short.approval.status === 'STALE_APPROVAL' ? 'stale approval' : 'not approved';
    lines.push(`  ${short.short_id}  ${short.state.padEnd(18)} qa ${(short.qa?.status ?? 'none').padEnd(8)} ${approval}`);
    if (short.rerender_reason) lines.push(`      re-render: ${short.rerender_reason}`);
  }
  lines.push('long-form:     unchanged (read-only parent)');
  lines.push('publishable:   false — every Short needs its own explicit approval');
  return lines.join('\n');
}

/** Human-readable render report. */
export function renderShortsRenderReport(result: RenderShortsResult): string {
  const lines: string[] = [];
  for (const entry of result.rendered) {
    lines.push(`${entry.shortId}: ${entry.action} — ${entry.reason}`);
  }
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  for (const error of result.errors) lines.push(`error: ${error}`);
  lines.push('note: nothing was uploaded or published.');
  return lines.join('\n');
}

export type { ResolvedShortClip, ShortTimeline, NarrationSegment };
