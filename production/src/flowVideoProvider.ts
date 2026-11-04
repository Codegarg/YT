/**
 * FLOW VIDEO PROVIDER (asset ACQUISITION) â€” the proven Flow -> MP4 path.
 *
 * WHAT THIS IS
 * ------------
 * Flow remains the video-generation provider. This module is the acquisition half only: it turns
 * an ALREADY-GENERATED, verified Flow artifact UUID into a validated local MP4 at the permanent
 * backend-independent contract
 *
 *     inputs/<projectId>/flow-clips/scene-####.mp4
 *
 * The transport was proven live against artifact 9cb6c125-9154-42a2-82fc-cfc0bb98191a:
 *
 *     artifact uuid
 *       -> signed https://flow-content.google/video/<uuid>?...  (read from video.video-preview)
 *       -> Playwright BrowserContext.request   (HTTP 200, video/mp4, 2,964,630 bytes)
 *       -> Buffer  (ftyp/isom verified)
 *       -> videoClip.validateVideoClip        (VALID, 1280x720, h264+aac, 8s)
 *       -> atomic rename onto flow-clips/scene-####.mp4
 *
 * WHAT THIS IS NOT
 * ----------------
 * It performs NO generation, NO scene creation, NO attachment, NO scene persistence, NO Add Media,
 * NO Save to project, NO download control and NO project mutation. It has no internal retry. The
 * two transports proven to fail are never used: `page.evaluate(fetch)` is cross-origin blocked and
 * Playwright `response.body()` is unreliable for `resourceType=media`.
 *
 * The audited `VideoProvider` shape is a TEXT-TO-VIDEO contract. Flow here is an ACQUISITION
 * provider, so this class implements the same disciplined surface â€” a pure `isCapable()` that never
 * performs I/O, exactly ONE method that would, and the same REUSED/INSTALLED/FAILED/INVALID/SKIPPED
 * result vocabulary â€” with the artifact identity, rather than a prompt, as its input.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { validateVideoClip, SUPPORTED_CLIP_EXTENSIONS } from './videoClip.js';
import { extractPreviewArtifactUuid } from './videoDecisions.js';
import { localSceneClipFilename } from './flowStaging.js';
import type { FlowClient } from './flowClient.js';

export const FLOW_VIDEO_PROVIDER_NAME = 'flow-video';

/** A Flow artifact id is a bare 36-character uuid. Never a URL, never a title. */
export const FLOW_ARTIFACT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FlowArtifactStatus = 'REUSED' | 'INSTALLED' | 'FAILED' | 'INVALID' | 'SKIPPED';

export type FlowArtifactCode =
  | 'ARTIFACT_ID_INVALID'
  | 'SCENE_NUMBER_INVALID'
  | 'INPUT_ROOT_MISSING'
  | 'PICKER_UNAVAILABLE'
  | 'ARTIFACT_NOT_RESOLVED'
  | 'ARTIFACT_ID_MISMATCH'
  | 'TRANSPORT_FAILED'
  | 'TRANSPORT_STATUS_INVALID'
  | 'TRANSPORT_CONTENT_TYPE_INVALID'
  | 'TRANSPORT_BODY_EMPTY'
  | 'CLIP_INVALID'
  | 'PROMOTION_FAILED';

export type FlowArtifactResult =
  | {
      ok: true;
      status: Extract<FlowArtifactStatus, 'REUSED' | 'INSTALLED'>;
      provider: typeof FLOW_VIDEO_PROVIDER_NAME;
      sceneNumber: number;
      artifactId: string;
      path: string;
      bytes: number;
      sha256?: string;
      durationSeconds?: number;
      /** Redacted form only. The signed URL itself is NEVER returned or logged. */
      mediaUrlRedacted?: string;
    }
  | {
      ok: false;
      status: Extract<FlowArtifactStatus, 'FAILED' | 'INVALID' | 'SKIPPED'>;
      provider: typeof FLOW_VIDEO_PROVIDER_NAME;
      sceneNumber: number;
      artifactId: string;
      code: FlowArtifactCode;
      reason: string;
    };

// ---------------------------------------------------------------------------------------
// PURE helpers (unit-tested offline; no browser, no network, no filesystem writes)
// ---------------------------------------------------------------------------------------

/** Accept a bare Flow artifact uuid. Anything else is refused. */
export function isValidFlowArtifactId(value: unknown): boolean {
  return typeof value === 'string' && FLOW_ARTIFACT_UUID_RE.test(value.trim());
}

/**
 * NEVER emit a signed URL. Every signature/credential/expiry parameter collapses to
 * `<signed-params-redacted>`; the artifact path segment is preserved because it is the identity.
 */
export function redactFlowSignedMediaUrl(url: unknown): string {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw) return '';
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return '<unparseable-url>'; }
  const id = extractPreviewArtifactUuid(raw);
  const path = id ? `/video/${id}` : parsed.pathname;
  const hasQuery = parsed.search.length > 0;
  return `${parsed.origin}${path}${hasQuery ? '?<signed-params-redacted>' : ''}`;
}

/**
 * Verify a resolved preview URL really is the requested artifact, using the EXISTING repository
 * extractor. Fails closed on any mismatch so a wrong clip can never be fetched.
 */
export function verifyFlowArtifactMediaUrl(
  url: unknown,
  expectedArtifactId: unknown,
): { ok: true; artifactId: string; signedUrl: string } | { ok: false; code: 'ARTIFACT_ID_INVALID' | 'ARTIFACT_ID_MISMATCH'; reason: string } {
  if (!isValidFlowArtifactId(expectedArtifactId)) {
    return { ok: false, code: 'ARTIFACT_ID_INVALID', reason: 'the expected artifact id is not a bare Flow uuid.' };
  }
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw) return { ok: false, code: 'ARTIFACT_ID_MISMATCH', reason: 'no signed media URL was resolved.' };
  const observed = extractPreviewArtifactUuid(raw);
  const expected = String(expectedArtifactId).trim().toLowerCase();
  if (observed !== expected) {
    return { ok: false, code: 'ARTIFACT_ID_MISMATCH', reason: `the resolved media URL previews ${observed ?? 'no artifact'}, not the requested ${expected}; refusing to fetch.` };
  }
  return { ok: true, artifactId: expected, signedUrl: raw };
}

/**
 * The permanent supplied-clip destination. Built ONLY from the inputs-side `flow-clips` category
 * and the canonical `scene-####.mp4` name â€” the exact pair `validateFlowClipInputs()` reads â€” so it
 * structurally cannot address the protected outputs-side local artifact that `flowStaging.ts`
 * guards.
 */
export function resolveSuppliedClipDestination(input: {
  inputRoot?: unknown;
  projectId?: unknown;
  sceneNumber?: unknown;
} | undefined | null): { ok: true; dir: string; filename: string; path: string } | { ok: false; code: 'SCENE_NUMBER_INVALID' | 'INPUT_ROOT_MISSING'; reason: string } {
  const n = Number(input?.sceneNumber);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, code: 'SCENE_NUMBER_INVALID', reason: `sceneNumber must be a positive integer (got ${String(input?.sceneNumber)}).` };
  const projectId = typeof input?.projectId === 'string' ? input.projectId.trim() : '';
  if (!projectId) return { ok: false, code: 'INPUT_ROOT_MISSING', reason: 'a projectId is required to resolve the flow-clips input category.' };
  const inputRoot = typeof input?.inputRoot === 'string' ? input.inputRoot.trim() : '';
  if (!inputRoot) return { ok: false, code: 'INPUT_ROOT_MISSING', reason: 'inputRoot is required.' };
  const dir = path.join(inputRoot, 'flow-clips');
  const filename = localSceneClipFilename(n);
  return { ok: true, dir, filename, path: path.join(dir, filename) };
}

/**
 * Idempotency. A VALID existing clip is reused and Flow is never contacted. An INVALID existing
 * clip is never silently replaced: replacement requires the explicit `overwrite` opt-in, exactly
 * like the narration install path.
 */
export function decideSuppliedClipAction(input: {
  exists?: boolean;
  state?: string | null;
  overwrite?: boolean;
} | undefined | null): { action: 'REUSE' | 'REPLACE' | 'DOWNLOAD' | 'REFUSE_INVALID' } {
  if (input?.exists !== true) return { action: 'DOWNLOAD' };
  if (input?.state === 'VALID') return { action: 'REUSE' };
  if (input?.overwrite === true) return { action: 'REPLACE' };
  return { action: 'REFUSE_INVALID' };
}

/**
 * Temporary file for the tmp -> validate -> atomic-rename path. It lives in the SAME directory as
 * the final target (so the rename is same-volume and atomic) and keeps a `.mp4`/`.m4v` extension so
 * `validateVideoClip()` will accept it. A partially written `scene-####.mp4` is therefore
 * structurally impossible.
 */
export function buildSuppliedClipTempPath(dir: string, sceneNumber: unknown, unique: string): string {
  const n = Number(sceneNumber);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`buildSuppliedClipTempPath requires a positive integer scene number (got ${String(sceneNumber)}).`);
  const ext = SUPPORTED_CLIP_EXTENSIONS[0];
  const token = String(unique ?? '').replace(/[^A-Za-z0-9_-]/g, '') || `${process.pid}`;
  return path.join(dir, `.${localSceneClipFilename(n)}.${token}.tmp${ext}`);
}

/**
 * A 200 video/* response is the only acceptable transport outcome.
 *
 * `byteLength` is OPTIONAL because the pre-flight call runs before any body has been read. When it
 * IS supplied (the post-body call) a non-positive length is refused, so an empty body can never be
 * promoted. The pre-flight call therefore validates status and content-type only.
 */
export function classifyFlowMediaResponse(meta: {
  status?: unknown;
  contentType?: unknown;
  byteLength?: unknown;
} | undefined | null): { ok: true } | { ok: false; code: FlowArtifactCode; reason: string } {
  const status = Number(meta?.status);
  if (!Number.isInteger(status) || status !== 200) {
    return { ok: false, code: 'TRANSPORT_STATUS_INVALID', reason: `the media endpoint returned HTTP ${String(meta?.status)}; expected 200.` };
  }
  const ct = typeof meta?.contentType === 'string' ? meta.contentType : '';
  if (!/^video\//i.test(ct)) {
    return { ok: false, code: 'TRANSPORT_CONTENT_TYPE_INVALID', reason: `the media endpoint returned content-type ${JSON.stringify(ct)}; expected video/*.` };
  }
  if (meta?.byteLength !== undefined && meta?.byteLength !== null) {
    const bytes = Number(meta.byteLength);
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return { ok: false, code: 'TRANSPORT_BODY_EMPTY', reason: 'the media endpoint returned an empty body.' };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------
// Injected dependencies (mocked in tests; live-wired by the factory below)
// ---------------------------------------------------------------------------------------

export interface FlowVideoProviderDeps {
  /**
   * Identity half. Resolves the signed preview URL for a verified artifact id using the scene
   * Videos picker. MUST be read-only: no generation, no attachment, no persistence.
   */
  resolveSignedMediaUrl(artifactId: string): Promise<{ ok: true; signedUrl: string } | { ok: false; reason: string }>;
  /**
   * Transport half. The authenticated Node-side request context bound to the browser context.
   * Never `page.evaluate(fetch)`, never `response.body()`, never an external HTTP client.
   */
  requestGet(url: string, options?: { timeout?: number }): Promise<{
    ok: boolean;
    status: number;
    contentType: string | null;
    body(): Promise<Buffer>;
  }>;
  /** Optional ffprobe override, forwarded verbatim to the existing validator. */
  ffprobePath?: string;
}

export class FlowVideoProvider {
  readonly name = FLOW_VIDEO_PROVIDER_NAME;

  constructor(private readonly deps: FlowVideoProviderDeps) {}

  /**
   * PURE capability report. Performs no I/O, opens no browser and never contacts Flow. Mirrors
   * `NarrationTtsProvider.isCapable()`.
   */
  isCapable(config: { hasAuthenticatedContext?: boolean } | undefined | null): { ok: boolean; produces: 'local-mp4' | 'none'; reason?: string } {
    if (config?.hasAuthenticatedContext !== true) {
      return { ok: false, produces: 'none', reason: 'no authenticated Flow browser context is bound; the signed media URL cannot be requested.' };
    }
    return { ok: true, produces: 'local-mp4' };
  }

  /**
   * THE ONLY method that performs I/O. One attempt, no internal retry.
   *
   * Order of operations is fixed and fail-closed:
   *   1. validate the artifact identity and the destination path
   *   2. REUSE a valid existing clip without touching Flow at all
   *   3. resolve the signed URL and re-verify the uuid
   *   4. GET it through the authenticated request context
   *   5. write a temporary file in the destination directory
   *   6. validate with the EXISTING, unmodified `videoClip.validateVideoClip`
   *   7. atomic rename onto flow-clips/scene-####.mp4
   */
  async acquireScene(input: {
    sceneNumber: number;
    artifactId: string;
    projectId: string;
    inputRoot: string;
    overwrite?: boolean;
    timeoutMs?: number;
  }): Promise<FlowArtifactResult> {
    const sceneNumber = Number(input?.sceneNumber);
    const artifactId = typeof input?.artifactId === 'string' ? input.artifactId.trim().toLowerCase() : '';
    const fail = (status: Extract<FlowArtifactStatus, 'FAILED' | 'INVALID' | 'SKIPPED'>, code: FlowArtifactCode, reason: string): FlowArtifactResult =>
      ({ ok: false, status, provider: FLOW_VIDEO_PROVIDER_NAME, sceneNumber, artifactId, code, reason });

    if (!Number.isInteger(sceneNumber) || sceneNumber <= 0) return fail('SKIPPED', 'SCENE_NUMBER_INVALID', `sceneNumber must be a positive integer (got ${String(input?.sceneNumber)}).`);
    if (!isValidFlowArtifactId(artifactId)) return fail('SKIPPED', 'ARTIFACT_ID_INVALID', 'the artifact id must be a bare 36-character Flow uuid.');

    const dest = resolveSuppliedClipDestination({ inputRoot: input?.inputRoot, projectId: input?.projectId, sceneNumber });
    if (!dest.ok) return fail('SKIPPED', dest.code, dest.reason);
    const target = dest.path;

    // ---- 2. idempotency: a valid existing clip never contacts Flow ----
    const existingState = await fsp.stat(target).then((s) => s.isFile()).catch(() => false)
      ? (await validateVideoClip(target, { ffprobePath: this.deps.ffprobePath }).catch(() => ({ state: 'INVALID' as const })))
      : null;
    const action = decideSuppliedClipAction({
      exists: existingState !== null,
      state: existingState?.state ?? null,
      overwrite: input?.overwrite === true,
    });
    if (action.action === 'REUSE') {
      return {
        ok: true, status: 'REUSED', provider: FLOW_VIDEO_PROVIDER_NAME, sceneNumber, artifactId, path: target,
        bytes: Number((existingState as any)?.bytes ?? 0), sha256: (existingState as any)?.sha256,
        durationSeconds: (existingState as any)?.durationSeconds,
      };
    }
    if (action.action === 'REFUSE_INVALID') {
      return fail('INVALID', 'CLIP_INVALID', `an invalid clip already exists at the destination and overwrite was not requested, so it was left untouched: ${(existingState as any)?.reason ?? 'unknown validation failure'}`);
    }

    // ---- 3. resolve the signed URL and re-verify the identity ----
    let resolvedSigned: string;
    try {
      const r = await this.deps.resolveSignedMediaUrl(artifactId);
      if (!r?.ok) return fail('FAILED', 'ARTIFACT_NOT_RESOLVED', `the Flow picker did not resolve the artifact: ${r?.reason ?? 'unknown'}`);
      const verified = verifyFlowArtifactMediaUrl(r.signedUrl, artifactId);
      if (!verified.ok) return fail('FAILED', verified.code, verified.reason);
      resolvedSigned = verified.signedUrl;
    } catch (e: any) {
      return fail('FAILED', 'PICKER_UNAVAILABLE', `resolving the artifact's signed media URL threw: ${String(e?.message ?? e).slice(0, 200)}`);
    }

    // ---- 4. authenticated Node-side transport ----
    let body: Buffer;
    let meta: { status: number; contentType: string | null };
    try {
      const res = await this.deps.requestGet(resolvedSigned, { timeout: input?.timeoutMs });
      const classified = classifyFlowMediaResponse({ status: res?.status, contentType: res?.contentType, byteLength: (res as any)?.byteLength });
      if (!classified.ok) return fail('FAILED', classified.code, classified.reason);
      body = await res.body();
      const after = classifyFlowMediaResponse({ status: res?.status, contentType: res?.contentType, byteLength: body?.length });
      if (!after.ok) return fail('FAILED', after.code, after.reason);
      meta = { status: res.status, contentType: res.contentType };
    } catch (e: any) {
      return fail('FAILED', 'TRANSPORT_FAILED', `the authenticated media request failed: ${String(e?.message ?? e).slice(0, 200)}`);
    }

    // ---- 5/6. temp file, then the EXISTING validator ----
    await fsp.mkdir(dest.dir, { recursive: true });
    const tmp = buildSuppliedClipTempPath(dest.dir, sceneNumber, `${process.pid}-${Date.now()}`);
    try {
      await fsp.writeFile(tmp, body, { flag: 'wx' });
    } catch (e: any) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      return fail('FAILED', 'PROMOTION_FAILED', `the temporary clip file could not be written: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    const validated = await validateVideoClip(tmp, { ffprobePath: this.deps.ffprobePath }).catch((e: any) => ({ state: 'INVALID' as const, reason: String(e?.message ?? e).slice(0, 160) }));
    if (validated.state !== 'VALID') {
      // Never leave a partial artifact, and never touch an existing final file.
      await fsp.rm(tmp, { force: true }).catch(() => {});
      return fail('INVALID', 'CLIP_INVALID', `the retrieved bytes did not satisfy the supplied-clip contract: ${(validated as any)?.reason ?? validated.state}`);
    }

    // ---- 7. atomic promotion ----
    try {
      await fsp.rename(tmp, target);
    } catch (e: any) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      return fail('FAILED', 'PROMOTION_FAILED', `atomic promotion to the destination failed: ${String(e?.message ?? e).slice(0, 200)}`);
    }

    return {
      ok: true, status: 'INSTALLED', provider: FLOW_VIDEO_PROVIDER_NAME, sceneNumber, artifactId, path: target,
      bytes: body.length, sha256: (validated as any)?.sha256, durationSeconds: (validated as any)?.durationSeconds,
      mediaUrlRedacted: redactFlowSignedMediaUrl(resolvedSigned),
    };
  }
}

/**
 * Live wiring. `resolveSignedMediaUrl` reuses `FlowClient.resolveArtifactSignedMediaUrl()` (which
 * itself reuses the existing picker trigger, category lookup, hydration gate and guarded row
 * resolver). `requestGet` is the Playwright `APIRequestContext` bound to the authenticated browser
 * context â€” the transport proven to return HTTP 200 with a complete `video/mp4` body.
 */
export function createFlowVideoProvider(parts: {
  flow: Pick<FlowClient, 'resolveArtifactSignedMediaUrl'>;
  context: BrowserContext;
  page: Page;
  ffprobePath?: string;
}): FlowVideoProvider {
  return new FlowVideoProvider({
    ffprobePath: parts.ffprobePath,
    resolveSignedMediaUrl: async (artifactId: string) => {
      const r = await parts.flow.resolveArtifactSignedMediaUrl(artifactId);
      return r.ok ? { ok: true as const, signedUrl: r.signedUrl } : { ok: false as const, reason: `${r.code}: ${r.reason}` };
    },
    requestGet: async (url: string, options?: { timeout?: number }) => {
      const api = (parts.context as any).request;
      if (!api?.get) throw new Error('the browser context exposes no APIRequestContext; cannot request the signed media URL.');
      const res = await api.get(url, { timeout: options?.timeout ?? 120000, maxRedirects: 5 });
      return {
        ok: res.ok(),
        status: res.status(),
        contentType: res.headers()['content-type'] ?? null,
        body: () => res.body(),
      };
    },
  });
}
