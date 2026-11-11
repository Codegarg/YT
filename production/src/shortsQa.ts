/**
 * PHASE 6 — Shorts QA.
 *
 * This module does NOT re-implement media analysis. Every picture/audio measurement is delegated
 * to the Phase 4 engine (`runMediaQa` in `mediaQa.ts`); this layer only adds the Shorts-specific
 * contract on top:
 *
 *   · exact 1080×1920 portrait delivery (not 1080p landscape, not a square crop);
 *   · portrait orientation and a 9:16 aspect ratio;
 *   · a Shorts-plausible duration range;
 *   · video + audio streams present, and picture/sound covering the same span (A/V sync);
 *   · Devanagari caption ordering, timing, readability and the portrait safe area;
 *   · every planned scene present, in order, with verified clips (no dropped or duplicated scene);
 *   · narration coverage for every planned narration segment;
 *   · framing decisions recorded and structurally valid, with REVIEW framing surfaced as a
 *     WARNING that a human must confirm;
 *   · the SHA-256 of the exact artifact, so an approval can be bound to immutable bytes.
 *
 * A technically invalid Short can never pass: `ok` is false whenever any BLOCKER check fails.
 * Uncertain visual framing is only ever a WARNING, never a blocker. `publishable` is always false
 * and `approval_required` is always true.
 */

import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import {
  SHORTS_WIDTH,
  SHORTS_HEIGHT,
  SHORTS_FPS,
  SHORTS_MIN_SECONDS,
  SHORTS_MAX_SECONDS,
  SHORTS_WARN_SECONDS,
  SHORTS_SCHEMA_VERSION,
  type CaptionSegment,
  type ShortClipSelection,
  type ShortPlan,
  type ShortQaCheck,
  type ShortQaReport,
} from './shortsTypes.js';
import { runMediaQa, type MediaQaOptions, type MediaQaReport } from './mediaQa.js';
import { validateCaptions } from './shortsCaptions.js';
import { validateReframe } from './shortsClips.js';
import { validateShortMetadata } from './shortsMetadata.js';
import { stableStringify } from './projectMediaQa.js';
import type { ShortTimeline } from './shortsRender.js';

export type MediaQaRunner = (options: MediaQaOptions) => Promise<MediaQaReport>;

export interface ShortQaInput {
  projectId: string;
  plan: ShortPlan;
  /** Verified clip decisions actually used for this render. */
  clips: ShortClipSelection[];
  timeline: ShortTimeline;
  captions: CaptionSegment[];
  /** Absolute path of the rendered Short. */
  artifactPath: string;
  /** Expected artifact hash (checkpoint / approval). Mismatch is a BLOCKER. */
  expectedHash?: string | null;
  ffmpegPath?: string;
  ffprobePath?: string;
  now?: string;
  /** Test seam: defaults to the real Phase 4 engine. */
  mediaQa?: MediaQaRunner;
}

const ASPECT_TOLERANCE = 0.004;

function check(
  id: string,
  asset: string,
  status: ShortQaCheck['status'],
  explanation: string,
  extra: { expected?: unknown; actual?: unknown; severity?: ShortQaCheck['severity'] } = {},
): ShortQaCheck {
  const severity = extra.severity
    ?? (status === 'FAIL' ? 'BLOCKER' : status === 'WARNING' ? 'WARNING' : status === 'SKIPPED' ? 'SKIPPED' : 'INFO');
  return {
    id,
    asset,
    status,
    severity,
    expected: extra.expected ?? null,
    actual: extra.actual ?? null,
    explanation,
  };
}

function statusOf(findings: MediaQaReport['findings']): ShortQaReport['media_qa']['status'] {
  if (findings.some((finding) => finding.severity === 'FAIL')) return 'FAIL';
  if (findings.some((finding) => finding.severity === 'WARN')) return 'WARNING';
  return 'PASS';
}

/** Count checks into the report buckets. */
export function countChecks(checks: ShortQaCheck[]): ShortQaReport['counts'] {
  return {
    pass: checks.filter((c) => c.status === 'PASS').length,
    warning: checks.filter((c) => c.status === 'WARNING').length,
    fail: checks.filter((c) => c.status === 'FAIL').length,
    skipped: checks.filter((c) => c.status === 'SKIPPED').length,
  };
}

function overallStatus(checks: ShortQaCheck[]): ShortQaReport['status'] {
  if (checks.some((c) => c.status === 'FAIL')) return 'FAIL';
  if (checks.some((c) => c.status === 'WARNING')) return 'WARNING';
  if (checks.length > 0 && checks.every((c) => c.status === 'SKIPPED')) return 'SKIPPED';
  return 'PASS';
}

/** SHA-256 of a rendered artifact (null when unreadable). */
export async function artifactSha256(file: string): Promise<string | null> {
  try {
    const buffer = await fsp.readFile(file);
    return crypto.createHash('sha256').update(buffer).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Run the complete Shorts QA for one Short.
 */
export async function runShortQa(input: ShortQaInput): Promise<ShortQaReport> {
  const shortId = input.plan.short_id;
  const artifact = input.artifactPath;
  const checks: ShortQaCheck[] = [];

  const stat = await fsp.stat(artifact).catch(() => null);
  const exists = Boolean(stat?.isFile()) && (stat?.size ?? 0) > 0;
  checks.push(check('short.exists', shortId, exists ? 'PASS' : 'FAIL',
    exists ? `rendered Short exists (${stat?.size ?? 0} bytes)` : 'the rendered Short file is missing or empty',
    { expected: 'a non-empty mp4', actual: exists ? `${stat?.size} bytes` : 'missing' }));

  const captionValidation = validateCaptions(input.captions, {
    width: SHORTS_WIDTH,
    height: SHORTS_HEIGHT,
    durationSeconds: input.timeline.total_seconds,
  });
  for (const issue of captionValidation.issues) {
    checks.push(check(
      issue.code.startsWith('caption.') ? issue.code : `caption.${issue.code}`,
      shortId,
      issue.severity === 'FAIL' ? 'FAIL' : 'WARNING',
      issue.detail,
      { expected: 'readable, in-order, inside the portrait safe area', actual: issue.code },
    ));
  }
  if (captionValidation.issues.length === 0) {
    checks.push(check('caption.track', shortId, 'PASS', `${input.captions.length} caption segment(s) validated for order, timing, length and safe area`));
  }

  // ---- plan / scene integrity (independent of the media probe) ----
  const planRefs = [...input.plan.scene_refs];
  const timelineRefs = input.timeline.scenes.map((scene) => scene.scene_number);
  const sameCount = timelineRefs.length === planRefs.length;
  checks.push(check('short.scene_count', shortId, sameCount ? 'PASS' : 'FAIL',
    sameCount ? `all ${planRefs.length} planned scene(s) are in the render timeline` : `the timeline has ${timelineRefs.length} scene(s) but the plan has ${planRefs.length}`,
    { expected: planRefs.length, actual: timelineRefs.length }));

  const ordered = timelineRefs.every((value, index) => index === 0 || value === timelineRefs[index - 1] + 1)
    && timelineRefs.every((value, index) => planRefs[index] === value);
  checks.push(check('short.scene_order', shortId, ordered ? 'PASS' : 'FAIL',
    ordered ? 'render scenes follow the plan order contiguously' : `render scene order ${JSON.stringify(timelineRefs)} does not match the plan ${JSON.stringify(planRefs)}`,
    { expected: planRefs, actual: timelineRefs }));

  const unusable = input.clips.filter((clip) => clip.status !== 'OK');
  checks.push(check('short.clip_reuse', shortId, unusable.length === 0 ? 'PASS' : 'FAIL',
    unusable.length === 0
      ? `all ${input.clips.length} scene clip(s) were reused from approved outputs`
      : `${unusable.length} scene clip(s) cannot be reused: ${unusable.map((clip) => `scene ${clip.scene_number} (${clip.reason})`).join('; ')}`,
    { expected: 'every clip reusable', actual: unusable.map((clip) => clip.scene_number) }));

  const hashes = input.clips.map((clip) => clip.sha256).filter((value): value is string => Boolean(value));
  const duplicated = hashes.filter((value, index) => hashes.indexOf(value) !== index);
  checks.push(check('short.duplicate_clips', shortId, duplicated.length === 0 ? 'PASS' : 'WARNING',
    duplicated.length === 0
      ? 'no two scenes reuse the same source clip'
      : `${duplicated.length} scene(s) reuse an identical source clip; confirm the repetition is intentional`,
    { expected: 'distinct clips', actual: Array.from(new Set(duplicated)).map((hash) => hash.slice(0, 12)) }));

  const reframeProblems: string[] = [];
  for (const clip of input.clips) {
    if (!clip.reframe) { reframeProblems.push(`scene ${clip.scene_number} has no reframe decision`); continue; }
    const validation = validateReframe(clip.reframe);
    if (!validation.ok) reframeProblems.push(`scene ${clip.scene_number}: ${validation.problems.join(', ')}`);
  }
  checks.push(check('short.reframe_metadata', shortId, reframeProblems.length === 0 ? 'PASS' : 'FAIL',
    reframeProblems.length === 0 ? 'every clip carries a consistent portrait reframe decision' : reframeProblems.join('; '),
    { expected: 'valid crop/cover/blur_fill metadata', actual: reframeProblems.length }));

  const reviewScenes = input.clips.filter((clip) => clip.reframe?.framing === 'REVIEW').map((clip) => clip.scene_number);
  checks.push(check('short.framing_review', shortId, reviewScenes.length === 0 ? 'PASS' : 'WARNING',
    reviewScenes.length === 0
      ? 'portrait framing is deterministic for every scene'
      : `scene(s) ${reviewScenes.join(', ')} use a wide/reduced crop or a blurred backdrop; a human must confirm the framing`,
    { expected: 'deterministic SAFE framing', actual: reviewScenes }));

  // A scene that plans to speak but has neither narration nor source audio would be silent.
  const silentScenes = input.timeline.scenes
    .filter((scene) => {
      const planned = input.plan.narration_segments.find((segment) => segment.scene_number === scene.scene_number);
      return Boolean(planned && planned.text.trim()) && scene.audio.kind === 'silence';
    })
    .map((scene) => scene.scene_number);
  checks.push(check('short.narration_coverage', shortId, silentScenes.length === 0 ? 'PASS' : 'FAIL',
    silentScenes.length === 0
      ? `${input.timeline.narration_segments.filter((segment) => segment.audio).length} narration/dialogue segment(s) carry real audio`
      : `scene(s) ${silentScenes.join(', ')} plan spoken text but have no narration file and no source audio`,
    { expected: 'audio for every spoken segment', actual: silentScenes }));

  const metadataValidation = validateShortMetadata(input.plan.metadata, { projectId: input.projectId });
  const metadataIndependent = metadataValidation.ok
    && input.plan.metadata.title !== (input.plan.parent_title ?? '');
  checks.push(check('short.metadata', shortId, metadataIndependent ? 'PASS' : 'FAIL',
    !metadataValidation.ok
      ? `metadata is invalid: ${metadataValidation.reason}`
      : metadataIndependent
        ? 'metadata is independent and bound to this parent story'
        : 'metadata title is identical to the long-form title; a Short needs its own title',
    { expected: 'independent, hash-valid metadata', actual: metadataValidation.ok ? 'valid' : metadataValidation.reason }));

  // ---- media QA (Phase 4 engine) ----
  let mediaReport: MediaQaReport | null = null;
  if (exists) {
    const runner = input.mediaQa ?? runMediaQa;
    try {
      mediaReport = await runner({
        input: artifact,
        ffmpegPath: input.ffmpegPath,
        ffprobePath: input.ffprobePath,
        expectWidth: SHORTS_WIDTH,
        expectHeight: SHORTS_HEIGHT,
        expectFps: SHORTS_FPS,
        expectDurationSeconds: input.timeline.total_seconds,
        durationToleranceSeconds: 2,
        requireAudio: true,
        requireVideo: true,
        targetLufs: -14,
        loudnessToleranceLu: 4,
      });
    } catch (error: any) {
      checks.push(check('media.analysis', shortId, 'FAIL', `the media QA engine failed to run: ${String(error?.message ?? error).slice(0, 200)}`));
    }
  }

  if (mediaReport) {
    for (const finding of mediaReport.findings) {
      checks.push(check(
        `media.${finding.code}`,
        shortId,
        finding.severity === 'FAIL' ? 'FAIL' : finding.severity === 'WARN' ? 'WARNING' : 'PASS',
        finding.message,
        { expected: 'the Shorts media contract', actual: finding.code },
      ));
    }

    const width = mediaReport.width;
    const height = mediaReport.height;
    const portrait = typeof width === 'number' && typeof height === 'number' && height > width;
    checks.push(check('short.orientation', shortId, portrait ? 'PASS' : 'FAIL',
      portrait ? `portrait ${width}×${height}` : `not portrait (${width ?? '?'}×${height ?? '?'})`,
      { expected: 'height > width', actual: `${width ?? '?'}×${height ?? '?'}` }));

    const aspect = typeof width === 'number' && typeof height === 'number' && height > 0 ? width / height : null;
    const aspectOk = aspect !== null && Math.abs(aspect - SHORTS_WIDTH / SHORTS_HEIGHT) <= ASPECT_TOLERANCE;
    checks.push(check('short.aspect_9_16', shortId, aspectOk ? 'PASS' : 'FAIL',
      aspectOk ? `aspect ${aspect.toFixed(4)} is 9:16` : `aspect ${aspect === null ? '?' : aspect.toFixed(4)} is not 9:16`,
      { expected: Number((SHORTS_WIDTH / SHORTS_HEIGHT).toFixed(4)), actual: aspect === null ? null : Number(aspect.toFixed(4)) }));

    const exact = width === SHORTS_WIDTH && height === SHORTS_HEIGHT;
    checks.push(check('short.dimensions_1080x1920', shortId, exact ? 'PASS' : 'FAIL',
      exact ? `exactly ${SHORTS_WIDTH}×${SHORTS_HEIGHT}` : `picture is ${width ?? '?'}×${height ?? '?'}, expected ${SHORTS_WIDTH}×${SHORTS_HEIGHT}`,
      { expected: `${SHORTS_WIDTH}x${SHORTS_HEIGHT}`, actual: `${width ?? '?'}x${height ?? '?'}` }));

    const duration = mediaReport.durationSeconds;
    if (typeof duration === 'number' && duration > 0) {
      const inRange = duration >= SHORTS_MIN_SECONDS && duration <= SHORTS_MAX_SECONDS;
      checks.push(check('short.duration', shortId, inRange ? 'PASS' : 'FAIL',
        `duration ${duration.toFixed(2)}s is ${inRange ? 'inside' : 'outside'} ${SHORTS_MIN_SECONDS}–${SHORTS_MAX_SECONDS}s`,
        { expected: `${SHORTS_MIN_SECONDS}–${SHORTS_MAX_SECONDS}s`, actual: Number(duration.toFixed(2)) }));
      const longish = duration > SHORTS_WARN_SECONDS;
      checks.push(check('short.duration_convention', shortId, longish ? 'WARNING' : 'PASS',
        longish ? `duration ${duration.toFixed(2)}s exceeds the ${SHORTS_WARN_SECONDS}s Shorts convention` : `duration ${duration.toFixed(2)}s fits the Shorts convention`,
        { expected: `<= ${SHORTS_WARN_SECONDS}s`, actual: Number(duration.toFixed(2)) }));
    } else {
      checks.push(check('short.duration', shortId, 'FAIL', 'the container does not expose a duration', { expected: 'a measurable duration', actual: null }));
    }

    if (typeof mediaReport.audioDurationSeconds === 'number' && typeof duration === 'number') {
      const drift = Math.abs(duration - mediaReport.audioDurationSeconds);
      const synced = drift <= 0.5;
      checks.push(check('short.audio_sync', shortId, synced ? 'PASS' : 'FAIL',
        `picture and sound differ by ${drift.toFixed(3)}s`,
        { expected: '≤ 0.5s A/V drift', actual: Number(drift.toFixed(3)) }));
    } else {
      checks.push(check('short.audio_sync', shortId, 'FAIL',
        'the audio stream duration could not be measured, so A/V sync cannot be proven',
        { expected: 'a measurable audio stream', actual: null }));
    }

    const loudness = mediaReport.loudness?.integratedLufs;
    checks.push(check('short.loudness', shortId,
      typeof loudness === 'number' ? 'PASS' : 'SKIPPED',
      typeof loudness === 'number' ? `integrated loudness ${loudness.toFixed(1)} LUFS` : 'integrated loudness was not measured',
      { expected: '-14 LUFS ± 4', actual: typeof loudness === 'number' ? Number(loudness.toFixed(1)) : null }));
  }

  const artifactHash = await artifactSha256(artifact);
  const expected = String(input.expectedHash ?? '').trim().toLowerCase();
  if (!artifactHash) {
    checks.push(check('short.artifact_hash', shortId, 'FAIL', 'the artifact hash could not be computed', { expected: 'sha256', actual: null }));
  } else if (expected && artifactHash !== expected) {
    checks.push(check('short.artifact_hash', shortId, 'FAIL',
      `artifact hash ${artifactHash.slice(0, 12)}… does not match the expected ${expected.slice(0, 12)}…`,
      { expected: expected.slice(0, 16), actual: artifactHash.slice(0, 16) }));
  } else {
    checks.push(check('short.artifact_hash', shortId, 'PASS', `artifact SHA-256 ${artifactHash.slice(0, 12)}…`, { actual: artifactHash.slice(0, 16) }));
  }

  const counts = countChecks(checks);
  const status = overallStatus(checks);
  const base = {
    schema_version: SHORTS_SCHEMA_VERSION,
    project_id: input.projectId,
    short_id: shortId,
    generated_at: input.now ?? new Date().toISOString(),
    read_only: true as const,
    status,
    ok: status !== 'FAIL',
    artifactHash,
    artifact: 'short.mp4',
    durationSeconds: mediaReport?.durationSeconds ?? null,
    width: mediaReport?.width ?? null,
    height: mediaReport?.height ?? null,
    checks,
    counts,
    caption: captionValidation,
    framing: { status: reviewScenes.length === 0 ? 'SAFE' as const : 'REVIEW' as const, review_scenes: reviewScenes },
    media_qa: {
      status: mediaReport ? statusOf(mediaReport.findings) : 'SKIPPED' as const,
      artifact_hash: mediaReport?.sha256 ?? null,
      report_hash: null as string | null,
      loudness_lufs: mediaReport?.loudness?.integratedLufs ?? null,
    },
    publishable: false as const,
    approval_required: true as const,
  };
  const partial = {
    ...base,
    media_qa: { ...base.media_qa, report_hash: mediaReport ? crypto.createHash('sha256').update(stableStringify(mediaReport)).digest('hex') : null },
  };
  const reportHash = crypto.createHash('sha256').update(stableStringify(partial)).digest('hex');
  return { ...partial, reportHash };
}

/** Human-readable one-Short QA summary. */
export function renderShortQaReport(report: ShortQaReport): string {
  const lines: string[] = [];
  lines.push(`short:         ${report.short_id}`);
  lines.push(`status:        ${report.status} (${report.counts.pass} pass, ${report.counts.warning} warning, ${report.counts.fail} fail, ${report.counts.skipped} skipped)`);
  if (report.width && report.height) lines.push(`picture:       ${report.width}×${report.height}  ${report.durationSeconds?.toFixed(2) ?? '?'}s`);
  lines.push(`artifact:      ${report.artifactHash ? `${report.artifactHash.slice(0, 16)}…` : 'not hashed'}`);
  lines.push(`captions:      ${report.caption.status} (${report.caption.checks} check(s))`);
  lines.push(`framing:       ${report.framing.status}${report.framing.review_scenes.length > 0 ? ` (review scene(s) ${report.framing.review_scenes.join(', ')})` : ''}`);
  lines.push(`publishable:   false — explicit human approval of this artifact is required`);
  for (const failed of report.checks.filter((c) => c.status === 'FAIL')) lines.push(`  BLOCKER ${failed.id}: ${failed.explanation}`);
  for (const warned of report.checks.filter((c) => c.status === 'WARNING')) lines.push(`  WARNING ${warned.id}: ${warned.explanation}`);
  return lines.join('\n');
}
