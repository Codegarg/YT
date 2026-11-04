/**
 * Private Cloudflare R2 media hosting.
 *
 * This module is deliberately side-effect free at import time: it never creates a client, reads
 * credentials, uploads, or presigns until an explicit function call. It is used by the gated
 * Zernio publisher so a local, approved media file can be uploaded and presigned in-process
 * without exposing a signed URL as a command-line argument or in logs.
 *
 * Safety invariants:
 *   · Required configuration is validated before any client/network operation.
 *   · The local SHA-256 is checked against the caller's approved hash before any R2 request.
 *   · Object keys are deterministic and include the content hash.
 *   · An existing object is never overwritten unless its remote bytes hash-match.
 *   · Uploaded bytes are read back and hashed; ETag alone is never trusted as a content hash.
 *   · No public ACL, bucket policy, or public-access operation is used.
 *   · Signed URLs are returned only to the caller and are never logged by this module.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const R2_KEY_PREFIX = 'youtube-automation';
export const DEFAULT_PRESIGN_TTL_SECONDS = 86_400;
export const MIN_PRESIGN_TTL_SECONDS = 3_600;
export const MAX_PRESIGN_TTL_SECONDS = 604_800;

const HEX64 = /^[0-9a-f]{64}$/i;
const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const SAFE_JURISDICTION = /^(default|eu|fedramp|us)$/;

export type R2ContentType = 'video/mp4' | 'image/jpeg' | 'image/png' | 'image/gif';
export type R2KeyExtension = 'mp4' | 'jpg' | 'jpeg' | 'png' | 'gif';

export interface R2MediaConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  jurisdiction?: string;
  presignTtlSeconds: number;
}

/** Minimal structural seam so tests can inject a deterministic fake S3 client. */
export interface R2ClientLike {
  send(command: any): Promise<any>;
}

export type R2PresignGet = (
  client: R2ClientLike,
  command: GetObjectCommand,
  options: { expiresIn: number },
) => Promise<string>;

export type R2PresignHead = (
  client: R2ClientLike,
  command: HeadObjectCommand,
  options: { expiresIn: number },
) => Promise<string>;

export interface R2MediaDeps {
  env?: NodeJS.ProcessEnv;
  client?: R2ClientLike;
  presignGet?: R2PresignGet;
  presignHead?: R2PresignHead;
}

export interface UploadedR2Media {
  bucket: string;
  key: string;
  sha256: string;
  size: number;
  contentType: R2ContentType;
}

export interface UploadVideoInput {
  filePath: string;
  projectId: string;
  expectedSha256: string;
  deps?: R2MediaDeps;
  config?: R2MediaConfig;
}

export interface UploadThumbnailInput {
  filePath: string;
  projectId: string;
  deps?: R2MediaDeps;
  config?: R2MediaConfig;
}

export interface PresignMediaInput {
  media: Pick<UploadedR2Media, 'bucket' | 'key'>;
  ttlSeconds?: number;
  deps?: R2MediaDeps;
  config?: R2MediaConfig;
}

export interface R2MediaService {
  config: R2MediaConfig;
  uploadVideo(input: Omit<UploadVideoInput, 'deps' | 'config'>): Promise<UploadedR2Media>;
  uploadThumbnail(input: Omit<UploadThumbnailInput, 'deps' | 'config'>): Promise<UploadedR2Media>;
  presign(media: Pick<UploadedR2Media, 'bucket' | 'key'>, ttlSeconds?: number): Promise<string>;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string {
  const raw = env[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

function parseTtl(raw: string | undefined, label: string): number {
  const text = String(raw ?? '').trim();
  if (!text) return DEFAULT_PRESIGN_TTL_SECONDS;
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be an integer between ${MIN_PRESIGN_TTL_SECONDS} and ${MAX_PRESIGN_TTL_SECONDS}.`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < MIN_PRESIGN_TTL_SECONDS || value > MAX_PRESIGN_TTL_SECONDS) {
    throw new Error(`${label} must be an integer between ${MIN_PRESIGN_TTL_SECONDS} and ${MAX_PRESIGN_TTL_SECONDS}.`);
  }
  return value;
}

/**
 * Load and validate R2 configuration. Error messages name missing/invalid variables only; they
 * never include an environment value.
 */
export function loadR2Config(env: NodeJS.ProcessEnv = process.env): R2MediaConfig {
  const required = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const;
  const missing = required.filter((name) => !envValue(env, name));
  if (missing.length) {
    throw new Error(`Missing required R2 configuration: ${missing.join(', ')}. Set these locally; never commit them.`);
  }

  const accountId = envValue(env, 'R2_ACCOUNT_ID');
  const accessKeyId = envValue(env, 'R2_ACCESS_KEY_ID');
  const secretAccessKey = envValue(env, 'R2_SECRET_ACCESS_KEY');
  const bucket = envValue(env, 'R2_BUCKET');
  const rawJurisdiction = envValue(env, 'R2_JURISDICTION').toLowerCase();
  const presignTtlSeconds = parseTtl(env.R2_PRESIGN_TTL_SECONDS, 'R2_PRESIGN_TTL_SECONDS');

  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('R2_ACCOUNT_ID is malformed.');
  if (!/^\S{16,256}$/.test(accessKeyId)) throw new Error('R2_ACCESS_KEY_ID is malformed.');
  if (!/^\S{16,512}$/.test(secretAccessKey)) throw new Error('R2_SECRET_ACCESS_KEY is malformed.');
  if (!SAFE_BUCKET.test(bucket) || bucket.includes('..') || /^\d{1,3}(\.\d{1,3}){3}$/.test(bucket)) {
    throw new Error('R2_BUCKET is malformed.');
  }
  if (rawJurisdiction && !SAFE_JURISDICTION.test(rawJurisdiction)) {
    throw new Error('R2_JURISDICTION must be one of: default, eu, fedramp, us.');
  }

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    ...(rawJurisdiction ? { jurisdiction: rawJurisdiction } : {}),
    presignTtlSeconds,
  };
}

/** R2's documented S3 endpoint for the default or a jurisdiction-scoped bucket. */
export function r2Endpoint(config: Pick<R2MediaConfig, 'accountId' | 'jurisdiction'>): string {
  const jurisdiction = config.jurisdiction?.trim().toLowerCase();
  const host = jurisdiction && jurisdiction !== 'default'
    ? `${config.accountId}.${jurisdiction}.r2.cloudflarestorage.com`
    : `${config.accountId}.r2.cloudflarestorage.com`;
  return `https://${host}`;
}

export function createR2Client(config: R2MediaConfig): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: r2Endpoint(config),
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

function sensitiveValues(config?: R2MediaConfig): string[] {
  return config ? [config.accessKeyId, config.secretAccessKey].filter((value) => Boolean(value)) : [];
}

/**
 * Remove signed and unsigned URLs, signature parameters, authorization material, and obvious raw
 * bodies from error text. This is intentionally conservative: it is better to lose detail than
 * leak an R2 endpoint, bucket, object key, bearer URL, or credential. Non-URL context is kept.
 */
export function redactSensitiveText(input: unknown, secrets: readonly string[] = []): string {
  let text = input instanceof Error ? input.message : String(input ?? '');
  // Redact complete URLs, including URLs without a query string, so provider errors cannot reveal
  // the R2 account endpoint, bucket name, object key, or signing material.
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]');
  text = text.replace(/\b(X-Amz-(?:Signature|Credential|Security-Token|SignedHeaders|Algorithm|Date|Expires|SignedHeaders))\b\s*[:=]\s*[^\s,;"'<>]+/gi, '$1=[redacted]');
  text = text.replace(/\b(Authorization|Proxy-Authorization)\s*:\s*(?:Bearer|Basic)\s+[^\s,;"'<>]+/gi, '$1=[redacted]');
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
  text = text.replace(/\b(access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key)\b\s*[:=]\s*[^\s,;"'<>]+/gi, '$1=[redacted]');
  text = text.replace(/AWS4-HMAC-SHA256\s+[^\s]+/gi, 'AWS4-HMAC-SHA256 [redacted]');
  text = text.replace(/(?:<\?xml[\s\S]*?>|<Error[\s\S]*?<\/Error>|\{[\s\S]{20,}\})/gi, '[redacted-body]');
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('[redacted]');
  }
  return text.slice(0, 400);
}

function safeError(prefix: string, error: unknown, config?: R2MediaConfig): Error {
  return new Error(`${prefix}: ${redactSensitiveText(error, sensitiveValues(config))}`);
}

export async function sha256File(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const digest = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(digest.digest('hex')));
  });
}

async function sha256Body(body: unknown): Promise<string> {
  const digest = crypto.createHash('sha256');
  if (body === undefined || body === null) throw new Error('R2 object response has no body.');
  if (typeof body === 'string') {
    digest.update(body);
    return digest.digest('hex');
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    digest.update(Buffer.from(body));
    return digest.digest('hex');
  }
  const asyncIterable = body as AsyncIterable<Uint8Array>;
  if (typeof asyncIterable[Symbol.asyncIterator] === 'function') {
    for await (const chunk of asyncIterable) digest.update(Buffer.from(chunk));
    return digest.digest('hex');
  }
  const webStream = body as ReadableStream<Uint8Array>;
  if (typeof webStream.getReader === 'function') {
    const reader = webStream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) digest.update(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return digest.digest('hex');
  }
  throw new Error('R2 object response body is not readable.');
}

function isNotFound(error: unknown): boolean {
  const e = error as any;
  return e?.$metadata?.httpStatusCode === 404
    || e?.name === 'NotFound'
    || e?.name === 'NoSuchKey'
    || e?.code === 'NotFound'
    || e?.code === 'NoSuchKey';
}

async function headObject(client: R2ClientLike, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function readObjectHash(
  client: R2ClientLike,
  bucket: string,
  key: string,
  expectedSize: number,
  config: R2MediaConfig,
): Promise<string> {
  const response: any = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (typeof response?.ContentLength === 'number' && response.ContentLength !== expectedSize) {
    throw new Error('R2 object size does not match the expected artifact.');
  }
  try {
    return await sha256Body(response?.Body);
  } catch (error) {
    throw safeError('Could not verify the R2 object', error, config);
  }
}

/** Validate a project ID before it can become part of an object key or path. */
export function validateProjectId(projectId: string): string {
  const id = String(projectId ?? '').trim();
  if (!SAFE_PROJECT_ID.test(id) || id === '.' || id === '..' || id.includes('..')) {
    throw new Error('Project id is not safe for an R2 object key.');
  }
  return id;
}

/** Deterministic key: youtube-automation/<project-id>/<sha256>.<extension> */
export function buildObjectKey(projectId: string, sha256: string, extension: R2KeyExtension = 'mp4'): string {
  const id = validateProjectId(projectId);
  const hash = String(sha256 ?? '').trim().toLowerCase();
  if (!HEX64.test(hash)) throw new Error('R2 object key requires a 64-character SHA-256 hex digest.');
  if (!['mp4', 'jpg', 'jpeg', 'png', 'gif'].includes(extension)) throw new Error('Unsupported R2 object extension.');
  return `${R2_KEY_PREFIX}/${id}/${hash}.${extension}`;
}

function validateExpectedHash(value: string): string {
  const hash = String(value ?? '').trim().toLowerCase();
  if (!HEX64.test(hash)) throw new Error('Expected media SHA-256 is malformed.');
  return hash;
}

async function statMediaFile(filePath: string): Promise<{ size: number }> {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    throw new Error('Media file is missing or unreadable.');
  }
  if (!stat.isFile() || stat.size <= 0) throw new Error('Media file is empty or is not a regular file.');
  return { size: stat.size };
}

/** Validate a YouTube custom thumbnail without network access. */
export async function validateThumbnailFile(filePath: string): Promise<{ size: number; contentType: R2ContentType; extension: R2KeyExtension }> {
  const stat = await statMediaFile(filePath);
  const max = 2 * 1024 * 1024;
  if (stat.size > max) throw new Error('Thumbnail must be 2 MB or smaller.');

  const handle = await fsp.open(filePath, 'r');
  let header: Buffer;
  try {
    header = Buffer.alloc(12);
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }

  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return { size: stat.size, contentType: 'image/jpeg', extension: 'jpg' };
  }
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { size: stat.size, contentType: 'image/png', extension: 'png' };
  }
  const gif = header.subarray(0, 6).toString('ascii');
  if (gif === 'GIF87a' || gif === 'GIF89a') {
    return { size: stat.size, contentType: 'image/gif', extension: 'gif' };
  }
  throw new Error('Thumbnail must be a JPEG, PNG, or GIF image.');
}

/** Validate an MP4 media file without network access. Only the ISO-BMFF `ftyp` box is checked. */
export async function validateVideoFile(filePath: string): Promise<{ size: number; contentType: R2ContentType; extension: R2KeyExtension }> {
  const stat = await statMediaFile(filePath);
  const handle = await fsp.open(filePath, 'r');
  let header: Buffer;
  let bytesRead = 0;
  try {
    header = Buffer.alloc(12);
    const result = await handle.read(header, 0, header.length, 0);
    bytesRead = result.bytesRead;
  } finally {
    await handle.close();
  }
  if (bytesRead < 12 || header.subarray(4, 8).toString('ascii') !== 'ftyp') {
    throw new Error('Video must be an MP4 file.');
  }
  return { size: stat.size, contentType: 'video/mp4', extension: 'mp4' };
}

async function uploadVerified(
  filePath: string,
  projectId: string,
  expectedSha256: string,
  contentType: R2ContentType,
  extension: R2KeyExtension,
  config: R2MediaConfig,
  deps: R2MediaDeps,
): Promise<UploadedR2Media> {
  const expected = validateExpectedHash(expectedSha256);
  const stat = await statMediaFile(filePath);

  let localHash: string;
  try {
    localHash = await sha256File(filePath);
  } catch (error) {
    throw safeError('Could not hash the local media file', error, config);
  }
  if (localHash.toLowerCase() !== expected) {
    throw new Error('Local media SHA-256 does not match the approved artifact; upload aborted.');
  }

  const key = buildObjectKey(projectId, localHash, extension);
  const client = deps.client ?? createR2Client(config);

  try {
    if (await headObject(client, config.bucket, key)) {
      const remoteHash = await readObjectHash(client, config.bucket, key, stat.size, config);
      if (remoteHash.toLowerCase() !== localHash.toLowerCase()) {
        throw new Error('Existing R2 object does not match the expected artifact; refusing to overwrite.');
      }
      return { bucket: config.bucket, key, sha256: localHash, size: stat.size, contentType };
    }
  } catch (error) {
    if (error instanceof Error && /refusing to overwrite|does not match the expected artifact/i.test(error.message)) throw error;
    throw safeError('R2 existing-object check failed', error, config);
  }

  try {
    await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentLength: stat.size,
      ContentType: contentType,
      CacheControl: 'private, no-store, max-age=0',
    }));
  } catch (error) {
    throw safeError('R2 upload failed', error, config);
  }

  const remoteHash = await readObjectHash(client, config.bucket, key, stat.size, config);
  if (remoteHash.toLowerCase() !== localHash.toLowerCase()) {
    throw new Error('Uploaded R2 object failed SHA-256 verification.');
  }
  return { bucket: config.bucket, key, sha256: localHash, size: stat.size, contentType };
}

export async function uploadVideo(input: UploadVideoInput): Promise<UploadedR2Media> {
  const config = input.config ?? loadR2Config(input.deps?.env ?? process.env);
  return uploadVerified(input.filePath, input.projectId, input.expectedSha256, 'video/mp4', 'mp4', config, input.deps ?? {});
}

export async function uploadThumbnail(input: UploadThumbnailInput): Promise<UploadedR2Media> {
  const config = input.config ?? loadR2Config(input.deps?.env ?? process.env);
  const validated = await validateThumbnailFile(input.filePath);
  const hash = await sha256File(input.filePath);
  return uploadVerified(input.filePath, input.projectId, hash, validated.contentType, validated.extension, config, input.deps ?? {});
}

function validatePresignTtl(ttlSeconds: number | undefined, config: R2MediaConfig): number {
  if (ttlSeconds === undefined) return config.presignTtlSeconds;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < MIN_PRESIGN_TTL_SECONDS || ttlSeconds > MAX_PRESIGN_TTL_SECONDS) {
    throw new Error(`Presigned URL TTL must be an integer between ${MIN_PRESIGN_TTL_SECONDS} and ${MAX_PRESIGN_TTL_SECONDS} seconds.`);
  }
  return ttlSeconds;
}

const defaultPresignGet: R2PresignGet = (client, command, options) =>
  getSignedUrl(client as S3Client, command, { expiresIn: options.expiresIn });

const defaultPresignHead: R2PresignHead = (client, command, options) =>
  getSignedUrl(client as S3Client, command, { expiresIn: options.expiresIn });

export async function presignGetUrl(input: PresignMediaInput): Promise<string> {
  const config = input.config ?? loadR2Config(input.deps?.env ?? process.env);
  if (!input.media || input.media.bucket !== config.bucket) throw new Error('Refusing to presign an object outside the configured R2 bucket.');
  if (!input.media.key || !input.media.key.startsWith(`${R2_KEY_PREFIX}/`)) throw new Error('Refusing to presign an unexpected R2 object key.');
  const ttl = validatePresignTtl(input.ttlSeconds, config);
  const client = input.deps?.client ?? createR2Client(config);
  const presign = input.deps?.presignGet ?? defaultPresignGet;
  try {
    const url = await presign(client, new GetObjectCommand({ Bucket: input.media.bucket, Key: input.media.key }), { expiresIn: ttl });
    if (!/^https:\/\//i.test(url)) throw new Error('Presigner returned a non-HTTPS URL.');
    return url;
  } catch (error) {
    throw safeError('R2 presign failed', error, config);
  }
}

/**
 * Presign a HEAD request for an existing object. This is intentionally separate from
 * presignGetUrl: S3 signatures are method-bound, so a HEAD probe cannot use a GET URL.
 */
export async function presignHeadUrl(input: PresignMediaInput): Promise<string> {
  const config = input.config ?? loadR2Config(input.deps?.env ?? process.env);
  if (!input.media || input.media.bucket !== config.bucket) throw new Error('Refusing to presign an object outside the configured R2 bucket.');
  if (!input.media.key || !input.media.key.startsWith(`${R2_KEY_PREFIX}/`)) throw new Error('Refusing to presign an unexpected R2 object key.');
  const ttl = validatePresignTtl(input.ttlSeconds, config);
  const client = input.deps?.client ?? createR2Client(config);
  const presign = input.deps?.presignHead ?? defaultPresignHead;
  try {
    const url = await presign(client, new HeadObjectCommand({ Bucket: input.media.bucket, Key: input.media.key }), { expiresIn: ttl });
    if (!/^https:\/\//i.test(url)) throw new Error('Presigner returned a non-HTTPS URL.');
    return url;
  } catch (error) {
    throw safeError('R2 presign failed', error, config);
  }
}

/** Build a service bound to one validated configuration. Construction performs no network I/O. */
export function createR2MediaService(options: { config?: R2MediaConfig; deps?: R2MediaDeps } = {}): R2MediaService {
  const deps = options.deps ?? {};
  const config = options.config ?? loadR2Config(deps.env ?? process.env);
  return {
    config,
    uploadVideo: (input) => uploadVideo({ ...input, config, deps }),
    uploadThumbnail: (input) => uploadThumbnail({ ...input, config, deps }),
    presign: (media, ttlSeconds) => presignGetUrl({ media, ttlSeconds, config, deps }),
  };
}
