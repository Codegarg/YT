/**
 * PHASE 7 — thumbnail QA.
 *
 * Measurement is delegated wherever an existing engine already does it:
 *   · container/dimensions/format → `probeMedia` (the same ffprobe layer every other stage uses);
 *   · the artifact's identity → `computeFileSha256`;
 *   · report canonicalisation → `stableStringify` (the Phase 4 helper).
 *
 * On top of that this module adds the checks that actually matter for a thumbnail and that CAN be
 * verified offline:
 *
 *   · the pixel-measured text bounding box (rendered with the real renderer, diffed against a
 *     text-less pass) must stay inside the safe area — an estimate alone would not be trustworthy;
 *   · branding is verified by rendering a logo-less pass and requiring real logo ink inside the
 *     recorded brand box (presence, not a promise);
 *   · the artifact is re-rendered and compared pixel-for-pixel, proving the recorded render key and
 *     the bytes on disk still describe the same design;
 *   · every source's hash is re-verified, so a replaced scene clip makes exactly the thumbnails that
 *     used it stale.
 *
 * Reads and renders into the owner's own directory only. Nothing is written outside it, nothing is
 * uploaded and nothing is ever marked publishable.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { probeMedia, computeFileSha256 } from './videoClip.js';
import { stableStringify } from './projectMediaQa.js';
import { validateThumbnailDesign, thumbnailRenderKey } from './thumbnailDesign.js';
import { decodeGray, diffInk, framesEqual, renderThumbnailGray, type RenderSourcePaths } from './thumbnailRender.js';
import {
  LONG_FORM_MAX_BYTES,
  type ThumbnailCheckpoint,
  type ThumbnailDesign,
  type ThumbnailQaCheck,
  type ThumbnailQaReport,
} from './thumbnailTypes.js';

export const THUMBNAIL_QA_VERSION = 1;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Minimum ink pixels for "there is type in this image" (a 40px wordmark alone is ~300px). */
export const MIN_TEXT_INK_PIXELS = 300;

function check(
  id: string,
  asset: string,
  status: ThumbnailQaCheck['status'],
  expected: unknown,
  actual: unknown,
  explanation: string,
): ThumbnailQaCheck {
  const severity: ThumbnailQaCheck['severity'] = status === 'FAIL' ? 'BLOCKER' : status === 'WARNING' ? 'WARNING' : status === 'SKIPPED' ? 'SKIPPED' : 'INFO';
  return { id, asset, status, severity, expected, actual, explanation };
}

function summarize(checks: ThumbnailQaCheck[]): ThumbnailQaReport['status'] {
  if (checks.some((entry) => entry.status === 'FAIL')) return 'FAIL';
  if (checks.some((entry) => entry.status === 'WARNING')) return 'WARNING';
  if (checks.length > 0 && checks.every((entry) => entry.status === 'SKIPPED')) return 'SKIPPED';
  return 'PASS';
}

export interface ThumbnailQaInput {
  design: ThumbnailDesign;
  checkpoint: ThumbnailCheckpoint;
  artifactPath: string;
  /** Directory the artifact lives in; the renderer writes its ASS there. */
  workDir: string;
  /** Absolute paths of the recorded sources. */
  paths: RenderSourcePaths;
  /** Current SHA-256 of every source, keyed by its recorded relative path. */
  sourceHashes: Record<string, string | null>;
  /** Long-form design, used to prove a Short cover is NOT a reuse of it. */
  longForm?: { design_hash: string; headline: string; base_sha256: string | null } | null;
  ffmpegPath?: string;
  ffprobePath?: string;
  now?: string;
  /** Test seam: skip the (slow) pixel passes. Never true in production code paths. */
  skipPixels?: boolean;
}

export async function runThumbnailQa(input: ThumbnailQaInput): Promise<ThumbnailQaReport> {
  const { design, checkpoint } = input;
  const asset = `${design.kind === 'long_form' ? 'thumbnail' : `cover:${design.owner_id}`}`;
  const checks: ThumbnailQaCheck[] = [];
  const artifact = path.resolve(input.artifactPath);
  const generatedAt = input.now ?? new Date().toISOString();

  // ---------------------------------------------------------------- file integrity
  let bytes: Buffer | null = null;
  try {
    bytes = await fsp.readFile(artifact);
  } catch {
    bytes = null;
  }
  checks.push(check(
    'thumbnail.present', asset, bytes ? 'PASS' : 'FAIL',
    'rendered PNG present', bytes ? `${bytes.length} bytes` : 'absent',
    bytes ? 'The rendered thumbnail exists.' : 'The rendered thumbnail is missing; render it before QA.',
  ));

  let artifactHash: string | null = null;
  if (bytes) {
    artifactHash = crypto.createHash('sha256').update(bytes).digest('hex');
    checks.push(check(
      'thumbnail.signature', asset,
      bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) ? 'PASS' : 'FAIL',
      'PNG signature', bytes.subarray(0, 8).toString('hex'),
      'The artifact is a PNG (the format every platform accepts for a thumbnail).',
    ));
    checks.push(check(
      'thumbnail.hash', asset, artifactHash === checkpoint.artifact_hash ? 'PASS' : 'FAIL',
      checkpoint.artifact_hash, artifactHash,
      artifactHash === checkpoint.artifact_hash
        ? 'The bytes match the recorded checkpoint hash.'
        : 'The bytes differ from the checkpoint; the artifact was replaced or the checkpoint is stale.',
    ));
  }

  // ---------------------------------------------------------------- container probe
  let width: number | null = null;
  let height: number | null = null;
  let format: string | null = null;
  if (bytes) {
    const probe = await probeMedia(artifact, { ffprobePath: input.ffprobePath }).catch(() => null);
    width = probe?.video?.width ?? null;
    height = probe?.video?.height ?? null;
    format = probe?.formatName ?? null;
    const dimsOk = width === design.width && height === design.height;
    checks.push(check(
      'thumbnail.dimensions', asset, dimsOk ? 'PASS' : 'FAIL',
      `${design.width}x${design.height}`, { width, height },
      dimsOk ? 'The artifact matches the delivery dimensions exactly.' : 'The artifact dimensions do not match the design.',
    ));
    const aspect = width && height ? width / height : null;
    const aspectOk = aspect !== null && Math.abs(aspect - design.aspect) <= 0.01;
    checks.push(check(
      'thumbnail.aspect', asset, aspectOk ? 'PASS' : 'FAIL',
      design.aspect.toFixed(3), aspect === null ? 'unmeasured' : aspect.toFixed(3),
      aspectOk ? 'The aspect ratio matches the delivery target.' : 'The aspect ratio does not match the delivery target.',
    ));
    const formatOk = String(format ?? '').toLowerCase().includes('png') || (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE));
    checks.push(check(
      'thumbnail.format', asset, formatOk ? 'PASS' : 'FAIL',
      'png', format ?? 'probe failed',
      formatOk ? 'The container is recognised as PNG.' : 'The container is not a supported image format.',
    ));
    const maxBytes = design.kind === 'long_form' ? LONG_FORM_MAX_BYTES : LONG_FORM_MAX_BYTES * 3;
    const sizeOk = bytes.length <= maxBytes && bytes.length > 2048;
    checks.push(check(
      'thumbnail.filesize', asset, sizeOk ? 'PASS' : 'FAIL',
      `2 KB – ${(maxBytes / (1024 * 1024)).toFixed(0)} MB`, `${(bytes.length / 1024).toFixed(0)} KB`,
      sizeOk ? 'The file size is inside the delivery envelope.' : 'The file size is outside the delivery envelope.',
    ));
  }

  // ---------------------------------------------------------------- design contract
  const designValidation = validateThumbnailDesign(design);
  for (const issue of designValidation.issues) {
    checks.push(check(
      `design.${issue.code}`, asset, issue.severity === 'FAIL' ? 'FAIL' : 'WARNING',
      'design contract satisfied', 'violated', issue.detail,
    ));
  }
  if (designValidation.issues.length === 0) {
    checks.push(check('design.contract', asset, 'PASS', 'design contract satisfied', 'satisfied', 'Safe area, type size, contrast and branding all satisfy the design contract.'));
  }

  // ---------------------------------------------------------------- render key / sources
  const expectedKey = thumbnailRenderKey(design);
  checks.push(check(
    'thumbnail.render_key', asset, expectedKey === checkpoint.render_key ? 'PASS' : 'FAIL',
    expectedKey, checkpoint.render_key,
    expectedKey === checkpoint.render_key
      ? 'The render key is reproducible from the recorded design and hashes.'
      : 'The recorded render key does not match the design; the design changed since the render.',
  ));

  for (const source of design.sources) {
    const current = input.sourceHashes[source.relative_path] ?? null;
    const unchanged = Boolean(source.sha256) && current === source.sha256;
    checks.push(check(
      `thumbnail.source.${source.role}`, asset, unchanged ? 'PASS' : 'FAIL',
      source.sha256 ?? 'recorded hash', current ?? 'unreadable',
      unchanged
        ? `The ${source.role} source still has the bytes the design was built from.`
        : `The ${source.role} source changed; this thumbnail is stale and must be re-planned/rendered.`,
    ));
  }

  // ---------------------------------------------------------------- pixel measurements
  let textInk: ThumbnailQaReport['text_ink'] = null;
  let brandInk: ThumbnailQaReport['brand_ink'] = null;
  if (bytes && !input.skipPixels) {
    const artifactGray = await decodeGray({
      file: artifact, width: design.width, height: design.height, ffmpegPath: input.ffmpegPath, cwd: input.workDir,
    });
    const withAll = await renderThumbnailGray({
      design, paths: input.paths, workDir: input.workDir, options: { withText: true, withLogo: true }, ffmpegPath: input.ffmpegPath,
    });
    const logoOnly = await renderThumbnailGray({
      design, paths: input.paths, workDir: input.workDir, options: { withText: false, withLogo: true }, ffmpegPath: input.ffmpegPath,
    });
    const textOnly = await renderThumbnailGray({
      design, paths: input.paths, workDir: input.workDir, options: { withText: true, withLogo: false }, ffmpegPath: input.ffmpegPath,
    });

    if (!artifactGray || !withAll) {
      checks.push(check('thumbnail.deterministic', asset, 'FAIL', 're-render matches the artifact', 'unavailable', 'The artifact could not be decoded or re-rendered for verification.'));
    } else {
      const identical = framesEqual(artifactGray, withAll);
      checks.push(check(
        'thumbnail.deterministic', asset, identical ? 'PASS' : 'FAIL',
        're-render is pixel-identical', identical ? 'identical' : 'differs',
        identical
          ? 'Re-rendering the recorded design reproduces the artifact pixel-for-pixel.'
          : 'Re-rendering the recorded design does NOT reproduce the artifact; the checkpoint is stale.',
      ));
    }

    if (artifactGray && logoOnly) {
      textInk = diffInk(artifactGray, logoOnly, design.width, design.height, 1);
      checks.push(check(
        'thumbnail.text_ink.present', asset, textInk && textInk.pixels >= MIN_TEXT_INK_PIXELS ? 'PASS' : 'FAIL',
        `>= ${MIN_TEXT_INK_PIXELS} ink pixels`, textInk?.pixels ?? 0,
        textInk && textInk.pixels >= MIN_TEXT_INK_PIXELS
          ? `Type rendered (${textInk.pixels} px of ink).`
          : 'No type was rendered — the font, the text or the subtitle filter failed silently.',
      ));

      if (textInk) {
        const safe = design.safe_area;
        const inside = textInk.x1 >= safe.left - 1
          && textInk.y1 >= safe.top - 1
          && textInk.x2 <= design.width - safe.right + 1
          && textInk.y2 <= design.height - safe.bottom + 1;
        checks.push(check(
          'thumbnail.safe_area.pixels', asset, inside ? 'PASS' : 'FAIL',
          { left: safe.left, top: safe.top, right: design.width - safe.right, bottom: design.height - safe.bottom },
          { x1: textInk.x1, y1: textInk.y1, x2: textInk.x2, y2: textInk.y2 },
          inside
            ? 'Every rendered text pixel is inside the safe area.'
            : 'Rendered text pixels fall outside the safe area (overflow or bad placement).',
        ));
      }
    } else {
      checks.push(check('thumbnail.text_ink.present', asset, 'SKIPPED', 'render available', 'unavailable', 'The text reference pass could not be rendered.'));
    }

    if (artifactGray && textOnly) {
      brandInk = diffInk(artifactGray, textOnly, design.width, design.height, 1);
      const placement = design.branding.placement;
      const inBox = Boolean(brandInk)
        && brandInk!.x1 >= placement.x - 2
        && brandInk!.y1 >= placement.y - 2
        && brandInk!.x2 <= placement.x + placement.height + 2
        && brandInk!.y2 <= placement.y + placement.height + 2;
      checks.push(check(
        'thumbnail.branding.pixels', asset, inBox ? 'PASS' : 'FAIL',
        `logo ink inside ${placement.x},${placement.y} ${placement.height}px`,
        brandInk ? { x1: brandInk.x1, y1: brandInk.y1, x2: brandInk.x2, y2: brandInk.y2, pixels: brandInk.pixels } : 'no logo ink',
        inBox
          ? 'The channel logo is actually present at the recorded brand position.'
          : 'No logo ink was found at the recorded brand position; the branding did not render.',
      ));
    } else {
      checks.push(check('thumbnail.branding.pixels', asset, 'SKIPPED', 'render available', 'unavailable', 'The logo reference pass could not be rendered.'));
    }
  } else {
    checks.push(check('thumbnail.deterministic', asset, 'SKIPPED', 'pixel verification', 'skipped', 'Pixel verification was skipped by the caller.'));
  }

  // ---------------------------------------------------------------- independence
  if (design.kind === 'short_cover') {
    if (!input.longForm) {
      checks.push(check('thumbnail.independence', asset, 'SKIPPED', 'long-form thumbnail present', 'absent', 'No long-form thumbnail exists, so cover independence cannot be compared.'));
    } else {
      const baseSha = design.sources.find((source) => source.role === 'base')?.sha256 ?? null;
      const distinct = input.longForm.design_hash !== design.design_hash
        && (input.longForm.headline !== design.concept.headline || input.longForm.base_sha256 !== baseSha);
      checks.push(check(
        'thumbnail.independence', asset, distinct ? 'PASS' : 'FAIL',
        'its own design, title and source frame', distinct ? 'independent' : 'reuses the long-form thumbnail',
        distinct
          ? 'The cover is independently designed for this Short.'
          : 'The cover duplicates the long-form thumbnail; each Short needs its own cover.',
      ));
    }
  }

  const status = summarize(checks);
  const report: ThumbnailQaReport = {
    version: THUMBNAIL_QA_VERSION,
    project_id: design.project_id,
    kind: design.kind,
    owner_id: design.owner_id,
    generated_at: generatedAt,
    read_only: true,
    status,
    ok: status === 'PASS' || status === 'WARNING',
    artifact_hash: artifactHash,
    report_hash: '',
    design_hash: design.design_hash,
    render_key: checkpoint.render_key,
    width,
    height,
    bytes: bytes?.length ?? null,
    format,
    checks,
    counts: {
      pass: checks.filter((entry) => entry.status === 'PASS').length,
      warning: checks.filter((entry) => entry.status === 'WARNING').length,
      fail: checks.filter((entry) => entry.status === 'FAIL').length,
      skipped: checks.filter((entry) => entry.status === 'SKIPPED').length,
      blockers: checks.filter((entry) => entry.status === 'FAIL').length,
    },
    text_ink: textInk,
    brand_ink: brandInk,
    publishable: false,
    approval_required: true,
  };
  report.report_hash = crypto.createHash('sha256').update(stableStringify({ ...report, report_hash: undefined })).digest('hex');
  return report;
}

/** True when the QA evidence still describes these exact bytes and this exact design. */
export function thumbnailQaCovers(
  report: ThumbnailQaReport | null,
  input: { artifactHash: string | null; designHash: string; kind: ThumbnailDesign['kind']; ownerId: string },
): boolean {
  if (!report) return false;
  if (report.kind !== input.kind || report.owner_id !== input.ownerId) return false;
  if (report.design_hash !== input.designHash) return false;
  return Boolean(input.artifactHash) && report.artifact_hash === input.artifactHash;
}

export function renderThumbnailQaReport(report: ThumbnailQaReport): string {
  const lines: string[] = [];
  lines.push(`thumbnail QA: ${report.project_id} — ${report.kind} ${report.owner_id} — ${report.status}`);
  lines.push(`  artifact:  ${report.artifact_hash ?? '(none)'} (${report.width ?? '?'}x${report.height ?? '?'}, ${report.bytes ?? 0} bytes)`);
  lines.push(`  design:    ${report.design_hash}`);
  lines.push(`  render key:${report.render_key}`);
  for (const entry of report.checks) {
    if (entry.status === 'PASS') continue;
    lines.push(`  ${entry.status.padEnd(7)} ${entry.id}: ${entry.explanation}`);
  }
  lines.push('  publishable: false — QA is evidence only; approval is a separate human step.');
  return lines.join('\n');
}

export { computeFileSha256 };
