// Zernio publication lifecycle. OFFLINE ONLY: fake transport, fake R2 host, fake account list.
// No credentials, network, uploads, presigning, publishing, or YouTube calls.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import { SRC } from './_testPaths.mjs';

const Z = await import(pathToFileURL(`${SRC}/zernio.ts`).href);
const RS = await import(pathToFileURL(`${SRC}/reviewState.ts`).href);

const PROJECT_ID = 'youtube-automation-2-20261003160855-2740';
const ACCOUNT_ID = '6ae2401339a3d63e1238c167';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-lifecycle-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const activeAccount = {
  platform: 'youtube',
  accountId: ACCOUNT_ID,
  displayName: 'RAAT KA KHAUF',
  isActive: true,
};

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function makeCase(key: string) {
  const root = path.join(tmp, key);
  // The allowlist is keyed by the pipeline directory name, so keep the real project ID while
  // using a disposable temp directory. No production artifact or approval is touched.
  const projectDir = path.join(root, PROJECT_ID);
  fs.mkdirSync(projectDir, { recursive: true });
  const mediaFile = path.join(root, 'candidate.mp4');
  fs.writeFileSync(mediaFile, Buffer.from(`offline-lifecycle-${key}`));
  const hash = sha256(fs.readFileSync(mediaFile));
  const projectFile = path.join(projectDir, 'pipeline.json');
  fs.writeFileSync(projectFile, JSON.stringify({
    project_id: PROJECT_ID,
    review: { status: 'approved', video_path: mediaFile, title: 'Lifecycle test' },
  }, null, 2));
  return { root, projectFile, mediaFile, hash };
}

function requestFor(c: ReturnType<typeof makeCase>, overrides: Record<string, unknown> = {}) {
  return {
    projectFile: c.projectFile,
    accountId: ACCOUNT_ID,
    mediaFile: c.mediaFile,
    title: 'Lifecycle test',
    mediaSha256: c.hash,
    confirmPublish: 'YES',
    visibility: 'private',
    ...overrides,
  };
}

function mediaHostFor(c: ReturnType<typeof makeCase>) {
  return {
    uploadVideo: async () => ({
      bucket: 'offline-test-bucket',
      key: `youtube-automation/${PROJECT_ID}/${c.hash}.mp4`,
      sha256: c.hash,
      size: 1,
      contentType: 'video/mp4',
    }),
    uploadThumbnail: async () => { throw new Error('thumbnail is not used'); },
    presign: async () => 'https://signed.example/video?X-Amz-Signature=OFFLINE_SECRET',
  };
}

function depsFor(c: ReturnType<typeof makeCase>, transport: any, extra: Record<string, unknown> = {}) {
  return {
    evaluateGate: async () => ({
      ok: true,
      approvedOutputPath: c.mediaFile,
      approvedOutputHash: c.hash,
      approvedArtifactKind: 'candidate',
    }),
    accountInspector: async () => [activeAccount],
    mediaHost: mediaHostFor(c),
    ...(transport ? { publishTransport: transport } : {}),
    ...extra,
  };
}

function bodyWith(post: unknown): string {
  return JSON.stringify({ post });
}

const validPost = { id: 'post-1', platforms: [{ platform: 'youtube', platformPostUrl: 'https://youtu.be/dQw4w9WgXcQ' }] };

function readReview(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8')).review;
}

function lockPath(file: string): string {
  return `${path.resolve(file)}.publish.lock`;
}

test('valid post response is ACCEPTED, not CONFIRMED or posted', async () => {
  const c = makeCase('valid');
  let calls = 0;
  const out = await Z.publishToZernio(requestFor(c), depsFor(c, async () => {
    calls++;
    return { status: 200, bodyText: bodyWith(validPost) };
  }));

  assert.equal(out.ok, true);
  assert.equal(out.accepted, true);
  assert.equal(out.confirmed, false);
  assert.equal(out.publication.status, 'ACCEPTED');
  assert.equal(out.post_id, 'post-1');
  assert.equal(out.youtube_url, 'https://youtu.be/dQw4w9WgXcQ');
  assert.equal(calls, 1);

  const review = readReview(c.projectFile);
  assert.equal(review.status, 'approved');
  assert.equal(review.posted_at, undefined);
  assert.equal(review.zernio_post_id, undefined);
  assert.equal(review.youtube_url, undefined);
  assert.equal(review.publish.status, 'ACCEPTED');
  assert.equal(review.publish.zernio_post_id, 'post-1');
  assert.equal(review.publish.youtube_video_id, 'dQw4w9WgXcQ');
  assert.equal(fs.existsSync(lockPath(c.projectFile)), false);
});

test('missing post ID is AMBIGUOUS and never posted', async () => {
  const c = makeCase('missing-id');
  const out = await Z.publishToZernio(requestFor(c), depsFor(c, async () => ({
    status: 200,
    bodyText: bodyWith({ platforms: validPost.platforms }),
  })));

  assert.equal(out.ok, false);
  assert.equal(out.refused, 'ambiguous');
  const review = readReview(c.projectFile);
  assert.equal(review.status, 'approved');
  assert.equal(review.publish.status, 'AMBIGUOUS');
  assert.equal(review.publish.zernio_post_id, undefined);
  assert.match(review.publish.last_error, /non-empty post ID/i);
  assert.equal(fs.existsSync(lockPath(c.projectFile)), false);
});

test('malformed success response is AMBIGUOUS', async () => {
  const c = makeCase('malformed');
  const out = await Z.publishToZernio(requestFor(c), depsFor(c, async () => ({
    status: 200,
    bodyText: 'this is not json',
  })));

  assert.equal(out.ok, false);
  assert.equal(out.refused, 'ambiguous');
  const review = readReview(c.projectFile);
  assert.equal(review.publish.status, 'AMBIGUOUS');
  assert.match(review.publish.last_error, /malformed JSON/i);
  assert.equal(review.status, 'approved');
});

test('missing YouTube platform result accepts the post ID but not a URL', async () => {
  const c = makeCase('missing-platform');
  const out = await Z.publishToZernio(requestFor(c), depsFor(c, async () => ({
    status: 200,
    bodyText: bodyWith({ id: 'post-2' }),
  })));

  assert.equal(out.ok, true);
  assert.equal(out.publication.status, 'ACCEPTED');
  assert.equal(out.post_id, 'post-2');
  assert.equal(out.youtube_url, undefined);
  const review = readReview(c.projectFile);
  assert.equal(review.publish.youtube_url, undefined);
  assert.match(review.publish.note, /no platform results/i);
});

test('non-YouTube platform result never becomes a YouTube URL', async () => {
  const c = makeCase('non-youtube');
  const out = await Z.publishToZernio(requestFor(c), depsFor(c, async () => ({
    status: 200,
    bodyText: bodyWith({ id: 'post-3', platforms: [{ platform: 'tiktok', platformPostUrl: 'https://youtu.be/dQw4w9WgXcQ' }] }),
  })));

  assert.equal(out.ok, true);
  assert.equal(out.post_id, 'post-3');
  assert.equal(out.youtube_url, undefined);
  assert.match(readReview(c.projectFile).publish.note, /no YouTube platform result/i);
});

test('a YouTube-labelled result with a non-YouTube URL is rejected as a URL', async () => {
  const c = makeCase('bad-youtube-url');
  const out = await Z.publishToZernio(requestFor(c), depsFor(c, async () => ({
    status: 200,
    bodyText: bodyWith({ id: 'post-4', platforms: [{ platform: 'youtube', platformPostUrl: 'https://evil.example/video' }] }),
  })));

  assert.equal(out.ok, true);
  assert.equal(out.post_id, 'post-4');
  assert.equal(out.youtube_url, undefined);
  assert.match(readReview(c.projectFile).publish.note, /not a YouTube URL/i);
});

test('HTTP 202 is ACCEPTED but not CONFIRMED', async () => {
  const c = makeCase('http-202');
  const out = await Z.publishToZernio(requestFor(c), depsFor(c, async () => ({
    status: 202,
    bodyText: bodyWith(validPost),
  })));

  assert.equal(out.ok, true);
  assert.equal(out.accepted, true);
  assert.equal(out.confirmed, false);
  assert.equal(out.publication.status, 'ACCEPTED');
  assert.equal(out.publication.http_status, 202);
  const review = readReview(c.projectFile);
  assert.equal(review.status, 'approved');
  assert.equal(review.posted_at, undefined);
});

test('timeout after submission is AMBIGUOUS and re-throws without retry', async () => {
  const c = makeCase('timeout');
  let calls = 0;
  await assert.rejects(
    () => Z.publishToZernio(requestFor(c), depsFor(c, async () => {
      calls++;
      throw new Error('The operation was aborted due to timeout');
    })),
    /Zernio publish failed/i,
  );

  assert.equal(calls, 1);
  const review = readReview(c.projectFile);
  assert.equal(review.status, 'approved');
  assert.equal(review.publish.status, 'AMBIGUOUS');
  assert.match(review.publish.last_error, /ambiguous/i);
  assert.equal(fs.existsSync(lockPath(c.projectFile)), false);
});

test('ambiguous network failure is AMBIGUOUS and re-throws without retry', async () => {
  const c = makeCase('network');
  let calls = 0;
  await assert.rejects(
    () => Z.publishToZernio(requestFor(c), depsFor(c, async () => {
      calls++;
      throw new Error('socket hang up');
    })),
    /Zernio publish failed/i,
  );

  assert.equal(calls, 1);
  assert.equal(readReview(c.projectFile).publish.status, 'AMBIGUOUS');
  assert.equal(readReview(c.projectFile).status, 'approved');
});

test('sequential duplicate invocation is refused without a second request', async () => {
  const c = makeCase('duplicate');
  let calls = 0;
  const transport = async () => {
    calls++;
    return { status: 200, bodyText: bodyWith(validPost) };
  };

  const first = await Z.publishToZernio(requestFor(c), depsFor(c, transport));
  assert.equal(first.ok, true);
  assert.equal(calls, 1);

  const second = await Z.publishToZernio(requestFor(c), depsFor(c, transport));
  assert.equal(second.ok, false);
  assert.equal(second.refused, 'duplicate');
  assert.equal(calls, 1);
  assert.equal(readReview(c.projectFile).publish.status, 'ACCEPTED');
});

test('concurrent publisher invocations submit at most once', async () => {
  const c = makeCase('concurrent');
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const transport = async () => {
    calls++;
    await gate;
    return { status: 200, bodyText: bodyWith(validPost) };
  };

  const first = Z.publishToZernio(requestFor(c), depsFor(c, transport));
  const second = Z.publishToZernio(requestFor(c), depsFor(c, transport));
  await new Promise((resolve) => setTimeout(resolve, 25));
  release();
  const outcomes = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.equal(outcomes.filter((outcome: any) => outcome.ok === true).length, 1);
  assert.equal(outcomes.filter((outcome: any) => outcome.ok === false && outcome.refused === 'duplicate').length, 1);
  assert.equal(readReview(c.projectFile).publish.status, 'ACCEPTED');
  assert.equal(fs.readFileSync(c.projectFile, 'utf8').includes('"status": "SUBMITTING"'), false);
});

test('save failure before the request leaves state unsubmitted and never calls the publisher', async () => {
  const c = makeCase('save-before');
  let calls = 0;
  const out = await Z.publishToZernio(
    requestFor(c),
    depsFor(c, async () => { calls++; return { status: 200, bodyText: bodyWith(validPost) }; }, {
      saveProject: async () => { throw new Error('disk full'); },
    }),
  );

  assert.equal(out.ok, false);
  assert.equal(out.refused, 'state');
  assert.equal(calls, 0);
  const review = readReview(c.projectFile);
  assert.equal(review.status, 'approved');
  assert.equal(review.publish, undefined);
  assert.equal(fs.existsSync(lockPath(c.projectFile)), false);
});

test('save failure after acceptance keeps SUBMITTING on disk and refuses a retry', async () => {
  const c = makeCase('save-after');
  let saves = 0;
  let calls = 0;
  const saveProject = async (file: string, project: any) => {
    saves++;
    if (saves === 1) return RS.saveProject(file, project);
    throw new Error('disk full');
  };

  const out = await Z.publishToZernio(
    requestFor(c),
    depsFor(c, async () => { calls++; return { status: 200, bodyText: bodyWith(validPost) }; }, { saveProject }),
  );

  assert.equal(out.ok, false);
  assert.equal(out.refused, 'state');
  assert.equal(calls, 1);
  assert.equal(out.publication.status, 'ACCEPTED');
  const review = readReview(c.projectFile);
  assert.equal(review.publish.status, 'SUBMITTING');
  assert.equal(review.status, 'approved');

  const retry = await Z.publishToZernio(requestFor(c), depsFor(c, async () => { calls++; return { status: 200, bodyText: bodyWith(validPost) }; }));
  assert.equal(retry.ok, false);
  assert.equal(retry.refused, 'duplicate');
  assert.equal(calls, 1);
});

test('definitive HTTP 400 is FAILED and a fixed request may be retried', async () => {
  const c = makeCase('http-400');
  const failed = await Z.publishToZernio(requestFor(c), depsFor(c, async () => {
    throw new Z.ZernioPublishHttpError(400);
  }));

  assert.equal(failed.ok, false);
  assert.equal(failed.refused, 'provider');
  const failedReview = readReview(c.projectFile);
  assert.equal(failedReview.publish.status, 'FAILED');
  assert.equal(failedReview.status, 'approved');

  const retried = await Z.publishToZernio(requestFor(c), depsFor(c, async () => ({
    status: 200,
    bodyText: bodyWith(validPost),
  })));
  assert.equal(retried.ok, true);
  assert.equal(readReview(c.projectFile).publish.status, 'ACCEPTED');
});

test('only explicit confirmation marks the review posted', async () => {
  const c = makeCase('confirm');
  const accepted = await Z.publishToZernio(requestFor(c), depsFor(c, async () => ({
    status: 200,
    bodyText: bodyWith(validPost),
  })));
  assert.equal(accepted.ok, true);
  assert.equal(readReview(c.projectFile).status, 'approved');

  const noConfirm = await Z.confirmZernioPublication({ projectFile: c.projectFile });
  assert.equal(noConfirm.ok, false);
  assert.equal(noConfirm.refused, 'confirm');

  const wrongId = await Z.confirmZernioPublication({
    projectFile: c.projectFile,
    confirmPublish: 'YES',
    postId: 'different-post',
    youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ',
  });
  assert.equal(wrongId.ok, false);
  assert.equal(wrongId.refused, 'validation');

  const badUrl = await Z.confirmZernioPublication({
    projectFile: c.projectFile,
    confirmPublish: 'YES',
    postId: 'post-1',
    youtubeUrl: 'https://evil.example/watch?v=dQw4w9WgXcQ',
  });
  assert.equal(badUrl.ok, false);
  assert.equal(badUrl.refused, 'validation');

  const confirmed = await Z.confirmZernioPublication({
    projectFile: c.projectFile,
    confirmPublish: 'YES',
    postId: 'post-1',
    youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    note: 'Verified private in YouTube Studio',
  });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.publication.status, 'CONFIRMED');

  const review = readReview(c.projectFile);
  assert.equal(review.status, 'posted');
  assert.equal(review.publish.status, 'CONFIRMED');
  assert.equal(review.zernio_post_id, 'post-1');
  assert.equal(review.youtube_url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.ok(review.posted_at);
  assert.ok(review.publish.confirmed_at);
  assert.equal(review.publish.youtube_video_id, 'dQw4w9WgXcQ');

  const again = await Z.publishToZernio(requestFor(c), depsFor(c, async () => ({
    status: 200,
    bodyText: bodyWith(validPost),
  })));
  assert.equal(again.ok, false);
  assert.equal(again.refused, 'review');

  const confirmAgain = await Z.confirmZernioPublication({
    projectFile: c.projectFile,
    confirmPublish: 'YES',
    youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ',
  });
  assert.equal(confirmAgain.ok, false);
  assert.equal(confirmAgain.refused, 'state');
});
