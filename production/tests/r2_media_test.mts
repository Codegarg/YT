// Private R2 media hosting. OFFLINE ONLY: fake S3 client + fake presigner; no credentials/network.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import { SRC } from './_testPaths.mjs';

const R2 = await import(pathToFileURL(`${SRC}/r2Media.ts`).href);
const Z = await import(pathToFileURL(`${SRC}/zernio.ts`).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-media-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const ACCESS_KEY = 'A'.repeat(32);
const SECRET_KEY = 'S'.repeat(64);
const BUCKET = 'test-bucket';
const YOUTUBE_PROJECT_ID = 'youtube-automation-2-20261003160855-2740';
const YOUTUBE_ACCOUNT_ID = '6ae2401339a3d63e1238c167';
const approvedAccountInspector = async () => [{
  platform: 'youtube',
  accountId: YOUTUBE_ACCOUNT_ID,
  displayName: 'RAAT KA KHAUF',
  isActive: true,
}];
const config = {
  accountId: ACCOUNT_ID,
  accessKeyId: ACCESS_KEY,
  secretAccessKey: SECRET_KEY,
  bucket: BUCKET,
  presignTtlSeconds: R2.DEFAULT_PRESIGN_TTL_SECONDS,
};

const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const mediaBytes = Buffer.from('offline-r2-media-fixture-bytes');
const mediaHash = sha256(mediaBytes);
const mediaFile = path.join(tmp, 'candidate.mp4');
fs.writeFileSync(mediaFile, mediaBytes);

class FakeS3 {
  objects = new Map<string, Buffer>();
  calls: any[] = [];
  corruptPut = false;
  putError: Error | null = null;

  async send(command: any): Promise<any> {
    this.calls.push(command);
    const name = command.constructor.name;
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

  names(): string[] {
    return this.calls.map((command) => command.constructor.name);
  }
}

const fakePresign = async (_client: any, command: any, options: { expiresIn: number }): Promise<string> => {
  return `https://${ACCOUNT_ID}.r2.cloudflarestorage.com/${command.input.Bucket}/${command.input.Key}?X-Amz-Signature=SECRET_SIGNATURE&X-Amz-Expires=${options.expiresIn}`;
};

test('missing configuration fails without echoing values', () => {
  let message = '';
  assert.throws(
    () => R2.loadR2Config({}),
    (error: unknown) => {
      message = error instanceof Error ? error.message : String(error);
      return /Missing required R2 configuration/i.test(message);
    },
  );
  for (const name of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) {
    assert.match(message, new RegExp(name));
  }
});

test('malformed configuration fails without echoing secret values', () => {
  const bad = {
    R2_ACCOUNT_ID: 'SECRET_ACCOUNT_VALUE',
    R2_ACCESS_KEY_ID: ACCESS_KEY,
    R2_SECRET_ACCESS_KEY: SECRET_KEY,
    R2_BUCKET: BUCKET,
  };
  let message = '';
  assert.throws(
    () => R2.loadR2Config(bad),
    (error: unknown) => {
      message = error instanceof Error ? error.message : String(error);
      return /R2_ACCOUNT_ID is malformed/i.test(message);
    },
  );
  assert.equal(message.includes('SECRET_ACCOUNT_VALUE'), false);

  let bucketMessage = '';
  assert.throws(
    () => R2.loadR2Config({ ...bad, R2_ACCOUNT_ID: ACCOUNT_ID, R2_BUCKET: 'Bad_Bucket' }),
    (error: unknown) => {
      bucketMessage = error instanceof Error ? error.message : String(error);
      return /R2_BUCKET is malformed/i.test(bucketMessage);
    },
  );
  assert.equal(bucketMessage.includes('Bad_Bucket'), false);
});

test('TTL parsing accepts only the documented bounded integer range', () => {
  const base = {
    R2_ACCOUNT_ID: ACCOUNT_ID,
    R2_ACCESS_KEY_ID: ACCESS_KEY,
    R2_SECRET_ACCESS_KEY: SECRET_KEY,
    R2_BUCKET: BUCKET,
  };
  assert.equal(R2.loadR2Config(base).presignTtlSeconds, 86_400);
  assert.equal(R2.loadR2Config({ ...base, R2_PRESIGN_TTL_SECONDS: '3600' }).presignTtlSeconds, 3_600);
  assert.equal(R2.loadR2Config({ ...base, R2_PRESIGN_TTL_SECONDS: '604800' }).presignTtlSeconds, 604_800);
  assert.throws(() => R2.loadR2Config({ ...base, R2_PRESIGN_TTL_SECONDS: '3599' }), /between 3600 and 604800/i);
  assert.throws(() => R2.loadR2Config({ ...base, R2_PRESIGN_TTL_SECONDS: '604801' }), /between 3600 and 604800/i);
  assert.throws(() => R2.loadR2Config({ ...base, R2_PRESIGN_TTL_SECONDS: '3600.5' }), /between 3600 and 604800/i);
  assert.throws(() => R2.loadR2Config({ ...base, R2_JURISDICTION: 'moon' }), /R2_JURISDICTION/i);
  assert.equal(R2.loadR2Config({ ...base, R2_JURISDICTION: 'eu' }).jurisdiction, 'eu');
});

test('endpoint uses region auto and the jurisdiction endpoint', () => {
  assert.equal(R2.r2Endpoint(config), `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`);
  assert.equal(R2.r2Endpoint({ ...config, jurisdiction: 'eu' }), `https://${ACCOUNT_ID}.eu.r2.cloudflarestorage.com`);
  assert.equal(R2.r2Endpoint({ ...config, jurisdiction: 'default' }), `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`);
});

test('deterministic object keys include project id and lowercase SHA-256', () => {
  const upper = 'A'.repeat(64);
  assert.equal(R2.buildObjectKey('raat-ka-khauf', upper), `youtube-automation/raat-ka-khauf/${'a'.repeat(64)}.mp4`);
  assert.equal(R2.buildObjectKey('raat-ka-khauf', upper), R2.buildObjectKey('raat-ka-khauf', upper));
  assert.equal(R2.buildObjectKey('raat-ka-khauf', upper, 'jpg'), `youtube-automation/raat-ka-khauf/${'a'.repeat(64)}.jpg`);
  assert.throws(() => R2.buildObjectKey('../escape', upper), /not safe/i);
  assert.throws(() => R2.buildObjectKey('project', 'not-a-hash'), /64-character SHA-256/i);
});

test('local hash mismatch stops before any S3 request', async () => {
  const client = new FakeS3();
  let message = '';
  await assert.rejects(
    () => R2.uploadVideo({
      filePath: mediaFile,
      projectId: 'r2-project',
      expectedSha256: '0'.repeat(64),
      config,
      deps: { client, presignGet: fakePresign },
    }),
    (error: unknown) => {
      message = error instanceof Error ? error.message : String(error);
      return /does not match the approved artifact/i.test(message);
    },
  );
  assert.equal(client.calls.length, 0);
});

test('upload uses video/mp4 and private cache metadata, with no public ACL operations', async () => {
  const client = new FakeS3();
  const uploaded = await R2.uploadVideo({
    filePath: mediaFile,
    projectId: 'r2-project',
    expectedSha256: mediaHash,
    config,
    deps: { client, presignGet: fakePresign },
  });

  assert.equal(uploaded.key, `youtube-automation/r2-project/${mediaHash}.mp4`);
  assert.equal(uploaded.sha256, mediaHash);
  assert.equal(uploaded.size, mediaBytes.length);
  assert.equal(uploaded.contentType, 'video/mp4');
  assert.deepEqual(client.names(), ['HeadObjectCommand', 'PutObjectCommand', 'GetObjectCommand']);

  const put = client.calls.find((command) => command.constructor.name === 'PutObjectCommand');
  assert.equal(put.input.ContentType, 'video/mp4');
  assert.match(put.input.CacheControl, /private/i);
  assert.match(put.input.CacheControl, /no-store/i);
  assert.equal('ACL' in put.input, false);
  assert.equal('GrantRead' in put.input, false);

  const forbidden = /CreateBucket|DeleteBucket|PutBucket|PutPublicAccessBlock|PutBucketAcl|PutObjectAcl/i;
  assert.equal(client.names().some((name) => forbidden.test(name)), false);
});

test('an existing matching object is reused without PutObject', async () => {
  const client = new FakeS3();
  const key = `youtube-automation/r2-project/${mediaHash}.mp4`;
  client.objects.set(`${BUCKET}/${key}`, mediaBytes);
  const uploaded = await R2.uploadVideo({
    filePath: mediaFile,
    projectId: 'r2-project',
    expectedSha256: mediaHash,
    config,
    deps: { client, presignGet: fakePresign },
  });
  assert.equal(uploaded.key, key);
  assert.deepEqual(client.names(), ['HeadObjectCommand', 'GetObjectCommand']);
});

test('an existing conflicting object fails closed and is never overwritten', async () => {
  const client = new FakeS3();
  const key = `youtube-automation/r2-project/${mediaHash}.mp4`;
  client.objects.set(`${BUCKET}/${key}`, Buffer.from('different-object-bytes'));
  await assert.rejects(
    () => R2.uploadVideo({
      filePath: mediaFile,
      projectId: 'r2-project',
      expectedSha256: mediaHash,
      config,
      deps: { client, presignGet: fakePresign },
    }),
    /does not match the expected artifact|refusing to overwrite/i,
  );
  assert.equal(client.names().includes('PutObjectCommand'), false);
});

test('remote read-back hash mismatch is rejected', async () => {
  const client = new FakeS3();
  client.corruptPut = true;
  await assert.rejects(
    () => R2.uploadVideo({
      filePath: mediaFile,
      projectId: 'r2-project',
      expectedSha256: mediaHash,
      config,
      deps: { client, presignGet: fakePresign },
    }),
    /failed SHA-256 verification/i,
  );
});

test('upload errors redact signed URLs and credentials', async () => {
  const client = new FakeS3();
  client.putError = new Error(`failed https://${ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}/key?X-Amz-Signature=SECRET_SIGNATURE Authorization: Bearer SECRET_TOKEN ${ACCESS_KEY} ${SECRET_KEY}`);
  let message = '';
  await assert.rejects(
    () => R2.uploadVideo({
      filePath: mediaFile,
      projectId: 'r2-project',
      expectedSha256: mediaHash,
      config,
      deps: { client, presignGet: fakePresign },
    }),
    (error: unknown) => {
      message = error instanceof Error ? error.message : String(error);
      return /R2 upload failed/i.test(message);
    },
  );
  for (const forbidden of ['SECRET_SIGNATURE', 'SECRET_TOKEN', ACCESS_KEY, SECRET_KEY, 'X-Amz-Signature=']) {
    assert.equal(message.includes(forbidden), false, `error leaked ${forbidden}`);
  }
});

test('presigned GET TTL is bounded and defaults to 86400', async () => {
  const client = new FakeS3();
  const uploaded = await R2.uploadVideo({
    filePath: mediaFile,
    projectId: 'r2-project',
    expectedSha256: mediaHash,
    config,
    deps: { client, presignGet: fakePresign },
  });

  await assert.rejects(
    () => R2.presignGetUrl({ media: uploaded, ttlSeconds: 3599, config, deps: { client, presignGet: fakePresign } }),
    /between 3600 and 604800/i,
  );
  await assert.rejects(
    () => R2.presignGetUrl({ media: uploaded, ttlSeconds: 604801, config, deps: { client, presignGet: fakePresign } }),
    /between 3600 and 604800/i,
  );

  const defaultUrl = await R2.presignGetUrl({ media: uploaded, config, deps: { client, presignGet: fakePresign } });
  assert.match(defaultUrl, /X-Amz-Expires=86400/);
  const minUrl = await R2.presignGetUrl({ media: uploaded, ttlSeconds: 3600, config, deps: { client, presignGet: fakePresign } });
  const maxUrl = await R2.presignGetUrl({ media: uploaded, ttlSeconds: 604800, config, deps: { client, presignGet: fakePresign } });
  assert.match(minUrl, /X-Amz-Expires=3600/);
  assert.match(maxUrl, /X-Amz-Expires=604800/);
});

test('presign refuses an object outside the configured bucket or key prefix', async () => {
  const client = new FakeS3();
  await assert.rejects(
    () => R2.presignGetUrl({ media: { bucket: 'other-bucket', key: 'youtube-automation/x/y.mp4' }, config, deps: { client, presignGet: fakePresign } }),
    /outside the configured R2 bucket/i,
  );
  await assert.rejects(
    () => R2.presignGetUrl({ media: { bucket: BUCKET, key: 'unexpected/key.mp4' }, config, deps: { client, presignGet: fakePresign } }),
    /unexpected R2 object key/i,
  );
});

test('presigned HEAD is method-bound and uses the same bucket/key/TTL guards', async () => {
  const client = new FakeS3();
  let commandName = '';
  const headPresign = async (_client: any, command: any, options: { expiresIn: number }): Promise<string> => {
    commandName = command.constructor.name;
    return `https://${ACCOUNT_ID}.r2.cloudflarestorage.com/${command.input.Bucket}/${command.input.Key}?X-Amz-Signature=SECRET_SIGNATURE&X-Amz-Expires=${options.expiresIn}`;
  };
  const media = { bucket: BUCKET, key: `youtube-automation/r2-project/${mediaHash}.mp4` };

  const url = await R2.presignHeadUrl({ media, ttlSeconds: 3600, config, deps: { client, presignHead: headPresign } });
  assert.equal(commandName, 'HeadObjectCommand');
  assert.match(url, /X-Amz-Expires=3600/);

  await assert.rejects(
    () => R2.presignHeadUrl({ media, ttlSeconds: 3599, config, deps: { client, presignHead: headPresign } }),
    /between 3600 and 604800/i,
  );
  await assert.rejects(
    () => R2.presignHeadUrl({ media: { bucket: 'other-bucket', key: media.key }, config, deps: { client, presignHead: headPresign } }),
    /outside the configured R2 bucket/i,
  );
  await assert.rejects(
    () => R2.presignHeadUrl({ media: { bucket: BUCKET, key: 'unexpected/key.mp4' }, config, deps: { client, presignHead: headPresign } }),
    /unexpected R2 object key/i,
  );
});

test('redaction removes signed query strings, authorization, and known secrets', () => {
  const signed = `https://${ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}/key?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${ACCESS_KEY}&X-Amz-Signature=SECRET_SIGNATURE`;
  const message = R2.redactSensitiveText(new Error(`failed ${signed} Authorization: Bearer SECRET_TOKEN ${SECRET_KEY}`), [ACCESS_KEY, SECRET_KEY]);
  for (const forbidden of ['SECRET_SIGNATURE', 'SECRET_TOKEN', ACCESS_KEY, SECRET_KEY, 'X-Amz-Signature=']) {
    assert.equal(message.includes(forbidden), false, `redaction leaked ${forbidden}`);
  }
  assert.match(message, /redacted/i);
});

test('redaction removes complete URLs with and without query strings', () => {
  const host = `${ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const objectPath = `youtube-automation/r2-project/${mediaHash}.mp4`;
  const signedUrl = `https://${host}/${BUCKET}/${objectPath}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${ACCESS_KEY}%2F20261031%2Fauto%2Fs3%2Faws4_request&X-Amz-Signature=SECRET_SIGNATURE`;
  const plainUrl = `https://${host}/${BUCKET}/${objectPath}`;
  const message = R2.redactSensitiveText(
    new Error(`after retry, upload failed for ${signedUrl} and ${plainUrl}`),
    [ACCESS_KEY, SECRET_KEY],
  );

  for (const forbidden of [
    'https://', host, ACCOUNT_ID, BUCKET, objectPath, mediaHash,
    'X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Signature', 'SECRET_SIGNATURE', ACCESS_KEY,
  ]) {
    assert.equal(message.includes(forbidden), false, `redaction leaked ${forbidden}`);
  }
  assert.match(message, /\[redacted-url\]/);
  assert.match(message, /after retry/);
  assert.match(message, /upload failed for/);
});

test('redaction removes raw provider response bodies but keeps surrounding context', () => {
  const xml = '<Error><Code>AccessDenied</Code><Message>private-bucket-detail</Message></Error>';
  const json = '{"error":"private-json-detail","bucket":"private-bucket-name"}';
  const xmlMessage = R2.redactSensitiveText(`R2 rejected the request: ${xml}`, []);
  const jsonMessage = R2.redactSensitiveText(`R2 rejected the request: ${json}`, []);

  for (const message of [xmlMessage, jsonMessage]) {
    assert.equal(message.includes('private-bucket-detail'), false);
    assert.equal(message.includes('private-json-detail'), false);
    assert.equal(message.includes('private-bucket-name'), false);
    assert.match(message, /\[redacted-body\]/);
    assert.match(message, /R2 rejected the request/);
  }
});

test('thumbnail validation accepts JPEG/PNG/GIF and enforces 2 MB', async () => {
  const png = path.join(tmp, 'thumb.png');
  fs.writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]));
  assert.equal((await R2.validateThumbnailFile(png)).contentType, 'image/png');

  const jpg = path.join(tmp, 'thumb.jpg');
  fs.writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
  assert.equal((await R2.validateThumbnailFile(jpg)).contentType, 'image/jpeg');

  const gif = path.join(tmp, 'thumb.gif');
  fs.writeFileSync(gif, Buffer.from('GIF89a', 'ascii'));
  assert.equal((await R2.validateThumbnailFile(gif)).contentType, 'image/gif');

  const invalid = path.join(tmp, 'thumb.txt');
  fs.writeFileSync(invalid, Buffer.from('not an image'));
  await assert.rejects(() => R2.validateThumbnailFile(invalid), /JPEG, PNG, or GIF/i);

  const tooBig = path.join(tmp, 'too-big.png');
  fs.writeFileSync(tooBig, Buffer.alloc(2 * 1024 * 1024 + 1, 0));
  await assert.rejects(() => R2.validateThumbnailFile(tooBig), /2 MB or smaller/i);
});

test('thumbnail upload uses the detected image MIME and a hash-based key', async () => {
  const png = path.join(tmp, 'upload-thumb.png');
  const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
  fs.writeFileSync(png, pngBytes);
  const client = new FakeS3();
  const uploaded = await R2.uploadThumbnail({ filePath: png, projectId: 'r2-project', config, deps: { client, presignGet: fakePresign } });
  assert.equal(uploaded.contentType, 'image/png');
  assert.equal(uploaded.key, `youtube-automation/r2-project/${sha256(pngBytes)}.png`);
});

test('publisher payload construction includes optional thumbnail and preserves private/synthetic metadata', () => {
  const withThumb = Z.buildZernioPayload({
    accountId: 'youtube-account',
    mediaUrl: 'https://signed.example/video?X-Amz-Signature=SECRET',
    thumbnailUrl: 'https://signed.example/thumb?X-Amz-Signature=SECRET',
    title: 'RAAT KA KHAUF',
    description: 'description',
    tags: 'horror, hindi',
    visibility: 'private',
  });
  assert.deepEqual(withThumb.mediaItems, [{
    type: 'video',
    url: 'https://signed.example/video?X-Amz-Signature=SECRET',
    thumbnail: 'https://signed.example/thumb?X-Amz-Signature=SECRET',
  }]);
  assert.equal(withThumb.platforms[0].platform, 'youtube');
  assert.equal(withThumb.platforms[0].accountId, 'youtube-account');
  assert.equal(withThumb.platforms[0].platformSpecificData.visibility, 'private');
  assert.equal(withThumb.platforms[0].platformSpecificData.containsSyntheticMedia, true);
  assert.equal(withThumb.publishNow, true);

  const withoutThumb = Z.buildZernioPayload({ accountId: 'a', mediaUrl: 'https://example.invalid/v.mp4', title: 'T' });
  assert.equal('thumbnail' in withoutThumb.mediaItems[0], false);
  assert.throws(() => Z.buildZernioPayload({ accountId: 'a', mediaUrl: 'https://example.invalid/v.mp4', title: 'T', visibility: 'friends' }), /Visibility/i);
});

test('publisher uses an injected media host and never returns the signed URL', async () => {
  const projectDir = path.join(tmp, 'projects-a', YOUTUBE_PROJECT_ID);
  fs.mkdirSync(projectDir, { recursive: true });
  const projectFile = path.join(projectDir, 'pipeline.json');
  fs.writeFileSync(projectFile, JSON.stringify({
    project_id: YOUTUBE_PROJECT_ID,
    review: { status: 'approved', video_path: mediaFile },
  }, null, 2));
  const thumbnailFile = path.join(tmp, 'thumb.png');
  fs.writeFileSync(thumbnailFile, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]));

  const videoUrl = 'https://signed.example/video?X-Amz-Signature=SECRET_VIDEO';
  const thumbnailUrl = 'https://signed.example/thumb?X-Amz-Signature=SECRET_THUMB';
  let uploadedVideo = false;
  let uploadedThumbnail = false;
  let captured: any = null;
  const mediaHost = {
    uploadVideo: async (input: any) => {
      uploadedVideo = true;
      assert.equal(input.filePath, mediaFile);
      assert.equal(input.projectId, YOUTUBE_PROJECT_ID);
      assert.equal(input.expectedSha256, mediaHash);
      return { bucket: BUCKET, key: `youtube-automation/${YOUTUBE_PROJECT_ID}/${mediaHash}.mp4`, sha256: mediaHash, size: mediaBytes.length, contentType: 'video/mp4' };
    },
    uploadThumbnail: async () => {
      uploadedThumbnail = true;
      return { bucket: BUCKET, key: `youtube-automation/${YOUTUBE_PROJECT_ID}/thumb.png`, sha256: 'b'.repeat(64), size: 16, contentType: 'image/png' };
    },
    presign: async (media: any) => media.key.endsWith('.png') ? thumbnailUrl : videoUrl,
  };

  const outcome = await Z.publishToZernio({
    projectFile,
    accountId: YOUTUBE_ACCOUNT_ID,
    mediaFile,
    thumbnailFile,
    title: 'RAAT KA KHAUF',
    mediaSha256: mediaHash,
    confirmPublish: 'YES',
  }, {
    evaluateGate: async () => ({ ok: true, approvedOutputPath: mediaFile, approvedOutputHash: mediaHash, approvedArtifactKind: 'candidate' }),
    accountInspector: approvedAccountInspector,
    mediaHost,
    publisher: async (payload: any) => {
      captured = payload;
      return { post: { id: 'post-1', platforms: [{ platformPostUrl: 'https://youtu.be/x' }] }, echoed: payload };
    },
  });

  assert.equal(outcome.ok, true);
  assert.equal(uploadedVideo, true);
  assert.equal(uploadedThumbnail, true);
  assert.equal(captured.mediaItems[0].url, videoUrl);
  assert.equal(captured.mediaItems[0].thumbnail, thumbnailUrl);
  assert.equal(captured.platforms[0].accountId, YOUTUBE_ACCOUNT_ID);
  assert.equal(captured.platforms[0].platformSpecificData.visibility, 'private');
  assert.equal(captured.platforms[0].platformSpecificData.containsSyntheticMedia, true);
  assert.equal(JSON.stringify(outcome).includes('SECRET_VIDEO'), false);
  assert.equal(JSON.stringify(outcome).includes('SECRET_THUMB'), false);
  assert.match(JSON.stringify(outcome.result), /redacted/i);
});

test('publisher exceptions redact any reflected signed URL', async () => {
  const projectDir = path.join(tmp, 'projects-b', YOUTUBE_PROJECT_ID);
  fs.mkdirSync(projectDir, { recursive: true });
  const projectFile = path.join(projectDir, 'pipeline.json');
  fs.writeFileSync(projectFile, JSON.stringify({ project_id: YOUTUBE_PROJECT_ID, review: { status: 'approved', video_path: mediaFile } }, null, 2));
  const mediaHost = {
    uploadVideo: async () => ({ bucket: BUCKET, key: `youtube-automation/${YOUTUBE_PROJECT_ID}/${mediaHash}.mp4`, sha256: mediaHash, size: mediaBytes.length, contentType: 'video/mp4' }),
    uploadThumbnail: async () => { throw new Error('not used'); },
    presign: async () => 'https://signed.example/video?X-Amz-Signature=SECRET_PUBLISH_ERROR',
  };
  let message = '';
  await assert.rejects(
    () => Z.publishToZernio({
      projectFile,
      accountId: YOUTUBE_ACCOUNT_ID,
      mediaFile,
      title: 'RAAT KA KHAUF',
      mediaSha256: mediaHash,
      confirmPublish: 'YES',
    }, {
      evaluateGate: async () => ({ ok: true, approvedOutputPath: mediaFile, approvedOutputHash: mediaHash, approvedArtifactKind: 'candidate' }),
      accountInspector: approvedAccountInspector,
      mediaHost,
      publisher: async () => { throw new Error('upstream failed for https://signed.example/video?X-Amz-Signature=SECRET_PUBLISH_ERROR'); },
    }),
    (error: unknown) => {
      message = error instanceof Error ? error.message : String(error);
      return /Zernio publish failed/i.test(message);
    },
  );
  assert.equal(message.includes('SECRET_PUBLISH_ERROR'), false);
  assert.equal(message.includes('X-Amz-Signature='), false);
});

test('R2 operations do not modify approval or pipeline state', async () => {
  const projectDir = path.join(tmp, 'projects', 'state-project');
  const outputsDir = path.join(tmp, 'outputs', 'state-project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(outputsDir, { recursive: true });
  const projectFile = path.join(projectDir, 'pipeline.json');
  const approvalFile = path.join(outputsDir, 'approval.json');
  fs.writeFileSync(projectFile, JSON.stringify({ project_id: 'state-project', review: { status: 'approved' } }, null, 2));
  fs.writeFileSync(approvalFile, JSON.stringify({ status: 'approved', hash: mediaHash }, null, 2));
  const beforeProject = sha256(fs.readFileSync(projectFile));
  const beforeApproval = sha256(fs.readFileSync(approvalFile));

  const client = new FakeS3();
  const uploaded = await R2.uploadVideo({
    filePath: mediaFile,
    projectId: 'state-project',
    expectedSha256: mediaHash,
    config,
    deps: { client, presignGet: fakePresign },
  });
  await R2.presignGetUrl({ media: uploaded, config, deps: { client, presignGet: fakePresign } });

  assert.equal(sha256(fs.readFileSync(projectFile)), beforeProject);
  assert.equal(sha256(fs.readFileSync(approvalFile)), beforeApproval);
});

test('no real network or publish call is reachable from these tests', () => {
  // The fake client/presigner above never use fetch; this test documents the invariant and
  // asserts the pure payload builder has no side effects.
  const before = JSON.stringify(process.env);
  const payload = Z.buildZernioPayload({ accountId: 'a', mediaUrl: 'https://example.invalid/v.mp4', title: 'T' });
  assert.equal(payload.publishNow, true);
  assert.equal(JSON.stringify(process.env), before);
});
