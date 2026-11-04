// Standalone R2 prepare-only workflow. OFFLINE ONLY: fake S3 client and fake presigner.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import { SRC } from './_testPaths.mjs';

const P = await import(pathToFileURL(`${SRC}/prepareMedia.ts`).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-media-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const PROJECT_ID = 'youtube-automation-2-20261003160855-2740';
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const ACCESS_KEY = 'A'.repeat(32);
const SECRET_KEY = 'S'.repeat(64);
const BUCKET = 'test-bucket';

const env = {
  R2_ACCOUNT_ID: ACCOUNT_ID,
  R2_ACCESS_KEY_ID: ACCESS_KEY,
  R2_SECRET_ACCESS_KEY: SECRET_KEY,
  R2_BUCKET: BUCKET,
  R2_PRESIGN_TTL_SECONDS: '86400',
};

const outputsRoot = path.join(tmp, 'outputs');
const projectDir = path.join(outputsRoot, PROJECT_ID);
fs.mkdirSync(projectDir, { recursive: true });

// Minimal ISO-BMFF header: size + ftyp + isom + minor version + compatible brands.
const mp4Bytes = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('isomiso2', 'ascii'),
]);
const mediaHash = crypto.createHash('sha256').update(mp4Bytes).digest('hex');
const mediaFile = path.join(projectDir, 'final-title-no-logo-sparkle-candidate.mp4');
fs.writeFileSync(mediaFile, mp4Bytes);
const expectedSignedUrl = `https://signed.example/${BUCKET}/youtube-automation/${PROJECT_ID}/${mediaHash}.mp4?X-Amz-Signature=SECRET_SIGNATURE&X-Amz-Expires=86400`;

const approvalFile = path.join(projectDir, 'approval.json');
const pipelineFile = path.join(projectDir, 'pipeline.json');
fs.writeFileSync(approvalFile, JSON.stringify({ schema_version: 1, project_id: PROJECT_ID, status: 'approved' }, null, 2));
fs.writeFileSync(pipelineFile, JSON.stringify({ project_id: PROJECT_ID, review: { status: 'approved' } }, null, 2));

const fileSha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

class FakeS3 {
  objects = new Map<string, Buffer>();
  calls: any[] = [];
  events: string[] = [];
  corruptPut = false;
  putError: Error | null = null;

  async send(command: any): Promise<any> {
    const name = command.constructor.name;
    this.events.push(name);
    this.calls.push(command);
    const input = command.input ?? {};
    const key = `${input.Bucket}/${input.Key}`;

    if (name === 'HeadObjectCommand') {
      if (!this.objects.has(key)) {
        const error: any = new Error('NotFound');
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return { ContentLength: this.objects.get(key)!.length };
    }
    if (name === 'PutObjectCommand') {
      if (this.putError) throw this.putError;
      const chunks: Buffer[] = [];
      for await (const chunk of input.Body) chunks.push(Buffer.from(chunk));
      const original = Buffer.concat(chunks);
      this.objects.set(key, this.corruptPut && original.length
        ? Buffer.concat([Buffer.from([original[0] ^ 0xff]), original.subarray(1)])
        : original);
      return { ETag: 'fake-etag-not-a-content-hash' };
    }
    if (name === 'GetObjectCommand') {
      const body = this.objects.get(key);
      if (!body) {
        const error: any = new Error('NoSuchKey');
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return { Body: Readable.from([body]), ContentLength: body.length };
    }
    throw new Error(`unexpected fake S3 command ${name}`);
  }
}

function fakePresign(events: string[], fail = false) {
  return async (_client: any, command: any, options: { expiresIn: number }): Promise<string> => {
    events.push('PresignGet');
    if (fail) throw new Error('SECRET_PRESIGN_FAILURE https://private.example/?X-Amz-Signature=SECRET_SIGNATURE');
    return `https://signed.example/${command.input.Bucket}/${command.input.Key}?X-Amz-Signature=SECRET_SIGNATURE&X-Amz-Expires=${options.expiresIn}`;
  };
}

function rangedResponse(bytes: number[], contentRange?: string): Response {
  const headers = new Headers();
  if (contentRange) headers.set('Content-Range', contentRange);
  return new Response(bytes.length ? new Uint8Array(bytes) : null, { status: 206, headers });
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT_ID,
    mediaFile,
    mediaSha256: mediaHash,
    confirmR2Upload: 'YES',
    outputsRoot,
    ...overrides,
  };
}

async function runCase(options: {
  input?: Record<string, unknown>;
  client?: FakeS3;
  env?: NodeJS.ProcessEnv;
  presignFail?: boolean;
  probe?: boolean;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  probeTimeoutMs?: number;
} = {}) {
  const client = options.client ?? new FakeS3();
  const presign = fakePresign(client.events, options.presignFail);
  const result = await P.prepareMedia({
    ...baseInput(options.input),
    ...(options.probe ? { probePresignedGet: true } : {}),
    deps: {
      env: options.env ?? env,
      client,
      presignGet: presign,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.probeTimeoutMs !== undefined ? { probeTimeoutMs: options.probeTimeoutMs } : {}),
    },
  });
  return { result, client, events: client.events };
}

test('correct hash uploads privately, reads back, and presigns after verification', async () => {
  let fetchCalled = false;
  const { result, client, events } = await runCase({
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error('fetch must not run without the probe flag');
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, undefined);
  assert.equal(result.projectId, PROJECT_ID);
  assert.equal(result.objectKey, `youtube-automation/${PROJECT_ID}/${mediaHash}.mp4`);
  assert.equal(result.bucket, BUCKET);
  assert.equal(result.sha256, mediaHash);
  assert.equal(result.fileSize, mp4Bytes.length);
  assert.equal(result.contentType, 'video/mp4');
  assert.equal(result.presignGenerated, true);
  assert.equal(result.presignedGetProbe, 'NOT_REQUESTED');
  assert.equal(result.httpStatus, null);
  assert.equal(fetchCalled, false);
  assert.deepEqual(events, ['HeadObjectCommand', 'PutObjectCommand', 'GetObjectCommand', 'PresignGet']);

  const output = P.toPrepareMediaOutput(result);
  assert.deepEqual(Object.keys(output).sort(), [
    'bucket', 'contentType', 'fileSize', 'httpStatus', 'objectKey',
    'presignGenerated', 'presignedGetProbe', 'projectId', 'sha256',
  ]);
  assert.equal(JSON.stringify(output).includes('SECRET_SIGNATURE'), false);
  assert.equal(JSON.stringify(output).includes('https://'), false);

  const put = client.calls.find((command) => command.constructor.name === 'PutObjectCommand');
  assert.equal(put.input.ContentType, 'video/mp4');
  assert.match(put.input.CacheControl, /private/i);
  assert.match(put.input.CacheControl, /no-store/i);
  assert.equal('ACL' in put.input, false);
  assert.equal(client.events.some((name) => /Acl$|PublicAccess|Policy/i.test(name)), false);
});

test('incorrect hash is rejected before any R2 call', async () => {
  const { result, events } = await runCase({ input: { mediaSha256: '0'.repeat(64) } });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'LOCAL_HASH_MISMATCH');
  assert.equal(result.presignGenerated, false);
  assert.deepEqual(events, []);
});

test('missing credentials fail before any R2 call', async () => {
  const { result, events } = await runCase({ env: {} });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'MISSING_CREDENTIALS');
  assert.equal(result.bucket, null);
  assert.deepEqual(events, []);
});

test('unsafe project ID is rejected before any R2 call', async () => {
  const { result, events } = await runCase({ input: { projectId: '../escape' } });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'INVALID_PROJECT_ID');
  assert.equal(result.projectId, null);
  assert.deepEqual(events, []);
});

test('malformed hash is rejected before any R2 call', async () => {
  const { result, events } = await runCase({ input: { mediaSha256: 'not-a-hash' } });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'INVALID_HASH');
  assert.equal(result.sha256, null);
  assert.deepEqual(events, []);
});

test('media path outside the project outputs is rejected before any R2 call', async () => {
  const outside = path.join(tmp, 'outside.mp4');
  fs.writeFileSync(outside, mp4Bytes);
  const { result, events } = await runCase({ input: { mediaFile: outside } });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'INVALID_FILE_PATH');
  assert.deepEqual(events, []);
});

test('missing media path is rejected before any R2 call', async () => {
  const missing = path.join(projectDir, 'missing.mp4');
  const { result, events } = await runCase({ input: { mediaFile: missing } });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'INVALID_FILE_PATH');
  assert.deepEqual(events, []);
});

test('unsupported file type is rejected before any R2 call', async () => {
  const textFile = path.join(projectDir, 'not-video.mp4');
  fs.writeFileSync(textFile, Buffer.from('this is not an mp4 file'));
  const { result, events } = await runCase({ input: { mediaFile: textFile } });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'UNSUPPORTED_FILE_TYPE');
  assert.deepEqual(events, []);
});

test('missing or negative confirmation is required', async () => {
  for (const confirmation of [undefined, 'NO', 'yes', 'TRUE']) {
    const { result, events } = await runCase({ input: { confirmR2Upload: confirmation } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'CONFIRMATION_REQUIRED');
    assert.equal(result.presignGenerated, false);
    assert.deepEqual(events, []);
  }
});

test('read-back hash mismatch fails and never presigns', async () => {
  const client = new FakeS3();
  client.corruptPut = true;
  const { result, events } = await runCase({ client });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'READBACK_MISMATCH');
  assert.equal(result.presignGenerated, false);
  assert.deepEqual(events, ['HeadObjectCommand', 'PutObjectCommand', 'GetObjectCommand']);
});

test('upload failure is sanitized and never presigns', async () => {
  const client = new FakeS3();
  client.putError = new Error('RAW_PROVIDER_RESPONSE_SECRET');
  const { result, events } = await runCase({ client });
  const output = P.toPrepareMediaOutput(result);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'UPLOAD_FAILED');
  assert.equal(result.presignGenerated, false);
  assert.deepEqual(events, ['HeadObjectCommand', 'PutObjectCommand']);
  assert.equal(JSON.stringify(output).includes('RAW_PROVIDER_RESPONSE_SECRET'), false);
});

test('presign failure is sanitized and reported as not generated', async () => {
  const { result, events } = await runCase({ presignFail: true });
  const output = P.toPrepareMediaOutput(result);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'PRESIGN_FAILED');
  assert.equal(result.presignGenerated, false);
  assert.equal(result.presignedGetProbe, 'NOT_REQUESTED');
  assert.equal(result.httpStatus, null);
  assert.deepEqual(events, ['HeadObjectCommand', 'PutObjectCommand', 'GetObjectCommand', 'PresignGet']);
  assert.equal(JSON.stringify(output).includes('SECRET_PRESIGN_FAILURE'), false);
  assert.equal(JSON.stringify(output).includes('SECRET_SIGNATURE'), false);
  assert.equal(JSON.stringify(output).includes('https://'), false);
});

test('no presigned GET probe is made when the flag is absent', async () => {
  let fetchCalled = false;
  const { result } = await runCase({
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error('unexpected probe');
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.presignedGetProbe, 'NOT_REQUESTED');
  assert.equal(result.httpStatus, null);
  assert.equal(fetchCalled, false);
});

test('presigned GET probe succeeds with a one-byte ranged response', async () => {
  let calls = 0;
  let seenUrl: string | undefined;
  let seenInit: RequestInit | undefined;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    seenUrl = String(input);
    seenInit = init;
    return rangedResponse([mp4Bytes[0]], `bytes 0-0/${mp4Bytes.length}`);
  };

  const { result, events } = await runCase({ probe: true, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.reason, undefined);
  assert.equal(result.presignGenerated, true);
  assert.equal(result.presignedGetProbe, 'PASS');
  assert.equal(result.httpStatus, 206);
  assert.equal(calls, 1);
  assert.equal(seenUrl, expectedSignedUrl);
  assert.equal(seenInit?.method, 'GET');
  assert.equal(seenInit?.redirect, 'manual');
  assert.equal((seenInit?.headers as Record<string, string>).Range, 'bytes=0-0');
  assert.ok(seenInit?.signal);
  assert.deepEqual(events, ['HeadObjectCommand', 'PutObjectCommand', 'GetObjectCommand', 'PresignGet']);

  const output = P.toPrepareMediaOutput(result);
  assert.equal(JSON.stringify(output).includes('SECRET_SIGNATURE'), false);
  assert.equal(JSON.stringify(output).includes('https://'), false);
});

test('presigned GET probe requires the first byte to match the local MP4', async () => {
  const wrongFirstByte = mp4Bytes[0] ^ 0xff;
  const { result } = await runCase({
    probe: true,
    fetchImpl: async () => rangedResponse([wrongFirstByte], `bytes 0-0/${mp4Bytes.length}`),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'PRESIGNED_GET_PROBE_FAILED');
  assert.equal(result.presignGenerated, true);
  assert.equal(result.presignedGetProbe, 'FAIL');
  assert.equal(result.httpStatus, 206);
});

test('presigned GET probe rejects an empty response body', async () => {
  const emptyStream = new Response(new Uint8Array(0), {
    status: 206,
    headers: { 'Content-Range': `bytes 0-0/${mp4Bytes.length}` },
  });
  const { result } = await runCase({
    probe: true,
    fetchImpl: async () => emptyStream,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'PRESIGNED_GET_PROBE_FAILED');
  assert.equal(result.presignedGetProbe, 'FAIL');
  assert.equal(result.httpStatus, 206);
});

test('presigned GET probe rejects a malformed or mismatched Content-Range', async () => {
  for (const contentRange of [
    'not-a-byte-range',
    `bytes 0-1/${mp4Bytes.length}`,
    `bytes 0-0/${mp4Bytes.length + 1}`,
    'bytes */123',
  ]) {
    const { result } = await runCase({
      probe: true,
      fetchImpl: async () => rangedResponse([mp4Bytes[0]], contentRange),
    });
    assert.equal(result.ok, false, `unexpected pass for ${contentRange}`);
    assert.equal(result.reason, 'PRESIGNED_GET_PROBE_FAILED');
    assert.equal(result.presignedGetProbe, 'FAIL');
    assert.equal(result.httpStatus, 206);
  }
});

test('presigned GET probe fails on HTTP 403', async () => {
  const { result } = await runCase({
    probe: true,
    fetchImpl: async () => new Response(null, { status: 403 }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'PRESIGNED_GET_PROBE_FAILED');
  assert.equal(result.presignGenerated, true);
  assert.equal(result.presignedGetProbe, 'FAIL');
  assert.equal(result.httpStatus, 403);
});

test('presigned GET probe fails on HTTP 404', async () => {
  const { result } = await runCase({
    probe: true,
    fetchImpl: async () => new Response(null, { status: 404 }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'PRESIGNED_GET_PROBE_FAILED');
  assert.equal(result.presignGenerated, true);
  assert.equal(result.presignedGetProbe, 'FAIL');
  assert.equal(result.httpStatus, 404);
});

test('presigned GET probe does not follow redirects', async () => {
  let calls = 0;
  let seenInit: RequestInit | undefined;
  const { result } = await runCase({
    probe: true,
    fetchImpl: async (_input, init) => {
      calls++;
      seenInit = init;
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://unexpected.example/redirect' },
      });
    },
  });
  const output = P.toPrepareMediaOutput(result);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'PRESIGNED_GET_PROBE_FAILED');
  assert.equal(result.presignedGetProbe, 'FAIL');
  assert.equal(result.httpStatus, 302);
  assert.equal(calls, 1);
  assert.equal(seenInit?.redirect, 'manual');
  assert.equal(JSON.stringify(output).includes('unexpected.example'), false);
});

test('presigned GET probe times out safely', async () => {
  let aborted = false;
  const fetchImpl = (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    const onAbort = () => {
      aborted = true;
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });

  const { result } = await runCase({ probe: true, fetchImpl, probeTimeoutMs: 10 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'PRESIGNED_GET_PROBE_FAILED');
  assert.equal(result.presignedGetProbe, 'FAIL');
  assert.equal(result.httpStatus, null);
  assert.equal(aborted, true);
});

test('presigned GET probe rejects an oversized response chunk even when the first byte matches', async () => {
  const { result } = await runCase({
    probe: true,
    fetchImpl: async () => rangedResponse([mp4Bytes[0], 0x01], `bytes 0-0/${mp4Bytes.length}`),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'PRESIGNED_GET_PROBE_FAILED');
  assert.equal(result.presignedGetProbe, 'FAIL');
  assert.equal(result.httpStatus, 206);
});

test('presigned GET probe rejects a malformed response', async () => {
  const malformed = { status: 206, ok: true, headers: null, body: null } as unknown as Response;
  const { result } = await runCase({
    probe: true,
    fetchImpl: async () => malformed,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'PRESIGNED_GET_PROBE_FAILED');
  assert.equal(result.presignedGetProbe, 'FAIL');
  assert.equal(result.httpStatus, 206);
});

test('presigned URL never appears in output, console, or thrown errors', async () => {
  const fetchImpl = async () => {
    throw new Error(`UPSTREAM_FAILURE ${expectedSignedUrl}`);
  };
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };

  try {
    const { result } = await runCase({ probe: true, fetchImpl });
    const output = P.toPrepareMediaOutput(result);
    logs.push(JSON.stringify(output));
    logs.push(result.reason ?? '');

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'PRESIGNED_GET_PROBE_FAILED');
    assert.equal(result.httpStatus, null);
    assert.equal(JSON.stringify(result).includes(expectedSignedUrl), false);
    assert.equal(JSON.stringify(output).includes(expectedSignedUrl), false);
    assert.equal(logs.join('\n').includes(expectedSignedUrl), false);
    assert.equal(logs.join('\n').includes('SECRET_SIGNATURE'), false);
    assert.equal(logs.join('\n').includes('https://'), false);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test('prepare-only workflow does not modify approval.json or pipeline.json', async () => {
  const beforeApproval = fileSha256(approvalFile);
  const beforePipeline = fileSha256(pipelineFile);

  const { result } = await runCase();
  assert.equal(result.ok, true);

  assert.equal(fileSha256(approvalFile), beforeApproval);
  assert.equal(fileSha256(pipelineFile), beforePipeline);
});

test('prepare module has no publisher, approval, review, or pipeline dependencies', () => {
  const source = fs.readFileSync(path.join(SRC, 'prepareMedia.ts'), 'utf8');
  assert.equal(/from\s+['"][^'"]*(?:zernio|reviewState|approval|pipeline|youtube)[^'"]*['"]/.test(source), false);
  assert.equal(/publishToZernio|\/posts|API_BASE|ZERNIO_API_KEY|writeFile|appendFile|saveProject/.test(source), false);

  const cli = fs.readFileSync(path.join(SRC, 'zernio.ts'), 'utf8');
  const start = cli.indexOf("command === 'prepare-media'");
  const end = cli.indexOf("command === 'connect-youtube'");
  assert.ok(start >= 0 && end > start);
  const branch = cli.slice(start, end);
  assert.equal(branch.includes('publishToZernio'), false);
  assert.equal(branch.includes("request('/posts'"), false);
});
