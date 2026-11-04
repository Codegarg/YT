/**
 * Standalone, prepare-only private-R2 media workflow.
 *
 * This module deliberately has no Zernio, YouTube, approval, review, or pipeline dependencies.
 * It reuses `r2Media.ts` for hashing, deterministic object keys, upload, read-back verification,
 * and GET presigning. The presigned URL is generated after read-back verification and is
 * immediately discarded. An optional probe fetches only the first byte through that URL, checks it
 * against the validated local MP4, and never returns, prints, logs, or persists the URL or body.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  buildObjectKey,
  createR2MediaService,
  validateProjectId,
  validateVideoFile,
  type R2ContentType,
  type R2MediaDeps,
  type R2MediaService,
  type UploadedR2Media,
} from './r2Media.js';

export type PrepareMediaReason =
  | 'CONFIRMATION_REQUIRED'
  | 'INVALID_PROJECT_ID'
  | 'INVALID_HASH'
  | 'INVALID_FILE_PATH'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'MISSING_CREDENTIALS'
  | 'R2_CONFIG_INVALID'
  | 'LOCAL_HASH_MISMATCH'
  | 'UPLOAD_FAILED'
  | 'READBACK_MISMATCH'
  | 'PRESIGN_FAILED'
  | 'PRESIGNED_GET_PROBE_FAILED';

export type PresignedGetProbe = 'NOT_REQUESTED' | 'PASS' | 'FAIL';

export type PrepareMediaFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface PrepareMediaDeps extends R2MediaDeps {
  /** Test seam for the in-process presigned GET probe. Defaults to global fetch. */
  fetchImpl?: PrepareMediaFetch;
  /** Test-only probe timeout override. Defaults to 10 seconds. */
  probeTimeoutMs?: number;
}

export interface PrepareMediaInput {
  projectId: string;
  mediaFile: string;
  mediaSha256: string;
  /** Must be exactly `YES`; this command performs an external storage write. */
  confirmR2Upload?: string;
  /** Defaults to OUTPUTS_ROOT or the current working directory's `outputs` folder. */
  outputsRoot?: string;
  /** Optional in-process HTTP GET probe of the generated presigned GET URL. */
  probePresignedGet?: boolean;
  /** Test-only R2 and probe seams. */
  deps?: PrepareMediaDeps;
}

export interface PrepareMediaResult {
  ok: boolean;
  /** Controlled failure code. Never contains provider text or URLs. */
  reason?: PrepareMediaReason;
  projectId: string | null;
  objectKey: string | null;
  bucket: string | null;
  sha256: string | null;
  fileSize: number | null;
  contentType: R2ContentType | null;
  presignGenerated: boolean;
  presignedGetProbe: PresignedGetProbe;
  httpStatus: number | null;
}

/** The safe metadata fields printed by the CLI. */
export interface PrepareMediaOutput {
  projectId: string | null;
  objectKey: string | null;
  bucket: string | null;
  sha256: string | null;
  fileSize: number | null;
  contentType: R2ContentType | null;
  presignGenerated: boolean;
  presignedGetProbe: PresignedGetProbe;
  httpStatus: number | null;
}

export function toPrepareMediaOutput(result: PrepareMediaResult): PrepareMediaOutput {
  return {
    projectId: result.projectId,
    objectKey: result.objectKey,
    bucket: result.bucket,
    sha256: result.sha256,
    fileSize: result.fileSize,
    contentType: result.contentType,
    presignGenerated: result.presignGenerated,
    presignedGetProbe: result.presignedGetProbe,
    httpStatus: result.httpStatus,
  };
}

function baseResult(probeRequested: boolean): PrepareMediaResult {
  return {
    ok: false,
    projectId: null,
    objectKey: null,
    bucket: null,
    sha256: null,
    fileSize: null,
    contentType: null,
    presignGenerated: false,
    presignedGetProbe: probeRequested ? 'FAIL' : 'NOT_REQUESTED',
    httpStatus: null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

/**
 * Resolve the media path and require it to remain inside this project's outputs directory.
 * Both lexical and real-path checks are used so symlinks cannot escape the project boundary.
 */
async function resolveProjectMediaPath(projectId: string, mediaFile: string, outputsRoot?: string): Promise<string> {
  const raw = typeof mediaFile === 'string' ? mediaFile.trim() : '';
  if (!raw || raw.includes('\0')) throw new Error('Media file path is invalid.');

  const root = path.resolve(outputsRoot ?? process.env.OUTPUTS_ROOT ?? path.resolve('outputs'));
  const projectDir = path.resolve(root, projectId);
  let resolved: string;
  try {
    resolved = path.resolve(raw);
  } catch {
    throw new Error('Media file path is invalid.');
  }

  const lexicalRelative = path.relative(projectDir, resolved);
  if (!lexicalRelative || lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) {
    throw new Error('Media file must be inside the project outputs directory.');
  }

  let projectReal: string;
  let fileReal: string;
  try {
    [projectReal, fileReal] = await Promise.all([fsp.realpath(projectDir), fsp.realpath(resolved)]);
  } catch {
    throw new Error('Media file or project outputs directory is missing.');
  }

  const realRelative = path.relative(projectReal, fileReal);
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error('Media file resolves outside the project outputs directory.');
  }

  const stat = await fsp.stat(fileReal).catch(() => null);
  if (!stat || !stat.isFile() || stat.size <= 0) {
    throw new Error('Media file is missing, empty, or not a regular file.');
  }
  return fileReal;
}

/** Read the first byte of the validated local media file for the presigned GET byte check. */
async function readFirstByte(filePath: string): Promise<number> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(1);
    const { bytesRead } = await handle.read(buffer, 0, 1, 0);
    if (bytesRead !== 1) throw new Error('Media file is empty.');
    return buffer[0];
  } finally {
    await handle.close();
  }
}

function configReason(error: unknown): PrepareMediaReason {
  return /Missing required R2 configuration/i.test(errorMessage(error))
    ? 'MISSING_CREDENTIALS'
    : 'R2_CONFIG_INVALID';
}

function uploadReason(error: unknown): PrepareMediaReason {
  const message = errorMessage(error);
  if (/Local media SHA-256 does not match the approved artifact/i.test(message)) {
    return 'LOCAL_HASH_MISMATCH';
  }
  if (/failed SHA-256 verification|does not match the expected artifact|refusing to overwrite|size does not match|Could not verify the R2 object/i.test(message)) {
    return 'READBACK_MISMATCH';
  }
  return 'UPLOAD_FAILED';
}

export const PRESIGNED_GET_PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_BYTES = 1;

interface PresignedGetProbeResult {
  presignedGetProbe: 'PASS' | 'FAIL';
  httpStatus: number | null;
}

function httpStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}

async function discardResponseBody(response: Response | null | undefined): Promise<void> {
  try {
    await response?.body?.cancel();
  } catch {
    // A body that cannot be cancelled is still never read. Do not expose the error.
  }
}

/**
 * Fetch only the first byte through the generated presigned GET URL and require it to equal the
 * first byte of the validated local MP4.
 *
 * Redirects are not followed (`redirect: 'manual'`), non-206 responses are cancelled before
 * their bodies are read, and reading stops as soon as more than one byte has arrived. The URL,
 * headers, body, and provider errors are never returned or logged.
 *
 * Limitation: the byte limit applies to bytes counted from stream chunks, not to the HTTP
 * runtime's internal buffering. A single read may deliver more than one byte (and the runtime may
 * buffer a network chunk), but the loop never requests another chunk and cancels the reader, so
 * the full object is never downloaded.
 */
async function probePresignedGetUrl(
  url: string,
  expectedSize: number,
  expectedFirstByte: number,
  deps: PrepareMediaDeps,
): Promise<PresignedGetProbeResult> {
  const controller = new AbortController();
  const configuredTimeout = deps.probeTimeoutMs;
  const timeoutMs = typeof configuredTimeout === 'number'
    && Number.isSafeInteger(configuredTimeout)
    && configuredTimeout > 0
    ? configuredTimeout
    : PRESIGNED_GET_PROBE_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await (deps.fetchImpl ?? fetch)(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      redirect: 'manual',
      signal: controller.signal,
    });

    const status = httpStatus(response?.status);
    if (!response || response.ok !== true || status !== 206) {
      await discardResponseBody(response);
      return { presignedGetProbe: 'FAIL', httpStatus: status };
    }

    const contentRange = typeof response.headers?.get === 'function'
      ? response.headers.get('content-range')
      : null;
    if (contentRange) {
      const match = /^bytes\s+0-0\/(\d+)$/i.exec(contentRange.trim());
      const total = match ? Number(match[1]) : NaN;
      if (!match || !Number.isSafeInteger(total) || total !== expectedSize) {
        await discardResponseBody(response);
        return { presignedGetProbe: 'FAIL', httpStatus: status };
      }
    }

    const body = response.body;
    if (!body || typeof body.getReader !== 'function') {
      await discardResponseBody(response);
      return { presignedGetProbe: 'FAIL', httpStatus: status };
    }

    const reader = body.getReader();
    let received = 0;
    let firstByte: number | null = null;
    try {
      while (received <= PROBE_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          if (firstByte === null) firstByte = value[0];
          received += value.byteLength;
          if (received > PROBE_MAX_BYTES) break;
        }
      }
    } catch {
      await reader.cancel().catch(() => {});
      return { presignedGetProbe: 'FAIL', httpStatus: status };
    }

    // Discard any remainder without downloading the object.
    await reader.cancel().catch(() => {});
    return received === PROBE_MAX_BYTES && firstByte === expectedFirstByte
      ? { presignedGetProbe: 'PASS', httpStatus: status }
      : { presignedGetProbe: 'FAIL', httpStatus: status };
  } catch {
    // Timeouts, TLS failures, redirect rejection, and malformed responses all fail safely.
    return { presignedGetProbe: 'FAIL', httpStatus: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Prepare one project media file in private R2.
 *
 * Ordering is intentional:
 *   1. explicit confirmation,
 *   2. project ID and hash validation,
 *   3. project-contained path and MP4 validation,
 *   4. R2 configuration/credential validation,
 *   5. local hash + upload + read-back verification (inside r2Media),
 *   6. GET presign only after verification, then discard the URL,
 *   7. optional ranged HTTP GET through that URL, also discarded immediately.
 */
export async function prepareMedia(input: PrepareMediaInput): Promise<PrepareMediaResult> {
  const probeRequested = input.probePresignedGet === true;
  const result = baseResult(probeRequested);

  if (input.confirmR2Upload !== 'YES') {
    return { ...result, reason: 'CONFIRMATION_REQUIRED' };
  }

  let projectId: string;
  try {
    projectId = validateProjectId(input.projectId);
  } catch {
    return { ...result, reason: 'INVALID_PROJECT_ID' };
  }
  result.projectId = projectId;

  const expectedSha256 = String(input.mediaSha256 ?? '').trim().toLowerCase();
  let expectedKey: string;
  try {
    expectedKey = buildObjectKey(projectId, expectedSha256);
  } catch {
    return { ...result, reason: 'INVALID_HASH' };
  }
  result.sha256 = expectedSha256;
  result.objectKey = expectedKey;

  let mediaPath: string;
  try {
    mediaPath = await resolveProjectMediaPath(projectId, input.mediaFile, input.outputsRoot);
  } catch {
    return { ...result, reason: 'INVALID_FILE_PATH' };
  }

  try {
    const validated = await validateVideoFile(mediaPath);
    result.fileSize = validated.size;
    result.contentType = validated.contentType;
  } catch (error) {
    const reason: PrepareMediaReason = /MP4 file/i.test(errorMessage(error))
      ? 'UNSUPPORTED_FILE_TYPE'
      : 'INVALID_FILE_PATH';
    return { ...result, reason };
  }

  let mediaFirstByte: number;
  try {
    mediaFirstByte = await readFirstByte(mediaPath);
  } catch {
    return { ...result, reason: 'INVALID_FILE_PATH' };
  }

  let service: R2MediaService;
  try {
    service = createR2MediaService({ deps: input.deps });
  } catch (error) {
    return { ...result, reason: configReason(error) };
  }
  result.bucket = service.config.bucket;

  let uploaded: UploadedR2Media;
  try {
    uploaded = await service.uploadVideo({
      filePath: mediaPath,
      projectId,
      expectedSha256,
    });
  } catch (error) {
    return { ...result, reason: uploadReason(error) };
  }

  result.objectKey = uploaded.key;
  result.bucket = uploaded.bucket;
  result.sha256 = uploaded.sha256;
  result.fileSize = uploaded.size;
  result.contentType = uploaded.contentType;

  let presignedUrl: string;
  try {
    presignedUrl = await service.presign({ bucket: uploaded.bucket, key: uploaded.key });
  } catch {
    return {
      ...result,
      reason: 'PRESIGN_FAILED',
      presignGenerated: false,
      presignedGetProbe: probeRequested ? 'FAIL' : 'NOT_REQUESTED',
      httpStatus: null,
    };
  }
  result.presignGenerated = true;

  if (probeRequested) {
    const probe = await probePresignedGetUrl(presignedUrl, uploaded.size, mediaFirstByte, input.deps ?? {});
    result.presignedGetProbe = probe.presignedGetProbe;
    result.httpStatus = probe.httpStatus;
    if (probe.presignedGetProbe !== 'PASS') {
      return { ...result, ok: false, reason: 'PRESIGNED_GET_PROBE_FAILED' };
    }
  }

  return { ...result, ok: true, presignGenerated: true };
}
