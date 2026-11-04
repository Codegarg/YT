// Zernio publication hardening (P0/P1). OFFLINE ONLY: fake transport, fake R2 host, fake account
// list, fake gate. No credentials, network, uploads, presigning, publishing, or YouTube calls.
//
// These tests cover the defects found by the read-only lifecycle audit:
//   - the approval gate is re-evaluated under the lock, immediately before SUBMITTING;
//   - a concurrent `review reject`/re-approval can never be overwritten by a stale write;
//   - malformed `review.publish` state fails closed;
//   - lock ownership is verified before release;
//   - redirects and 409/408/425 are ambiguous, never retryable;
//   - confirmation requires an approved review, the exact recorded post ID, and a real video URL.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-hardening-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const activeAccount = {
  platform: 'youtube',
  accountId: ACCOUNT_ID,
  displayName: 'RAAT KA KHAUF',
  isActive: true,
};

const validPost = {
  id: 'post-1',
  platforms: [{ platform: 'youtube', platformPostUrl: 'https://youtu.be/dQw4w9WgXcQ' }],
};

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function okBody(): { status: number; bodyText: string } {
  return { status: 200, bodyText: JSON.stringify({ post: validPost }) };
}

function makeCase(key: string) {
  const root = path.join(tmp, key);
  // The publish allowlist is keyed by the pipeline directory name, so keep the real project ID
  // while the fixture lives in a disposable temp directory.
  const projectDir = path.join(root, PROJECT_ID);
  fs.mkdirSync(projectDir, { recursive: true });
  const mediaFile = path.join(root, 'candidate.mp4');
  fs.writeFileSync(mediaFile, Buffer.from(`offline-hardening-${key}`));
  const hash = sha256(fs.readFileSync(mediaFile));
  const projectFile = path.join(projectDir, 'pipeline.json');
  fs.writeFileSync(projectFile, JSON.stringify({
    project_id: PROJECT_ID,
    review: { status: 'approved', video_path: mediaFile, title: 'Hardening test' },
  }, null, 2));
  return { root, projectFile, mediaFile, hash };
}

function requestFor(c: ReturnType<typeof makeCase>, overrides: Record<string, unknown> = {}) {
  return {
    projectFile: c.projectFile,
    accountId: ACCOUNT_ID,
    mediaFile: c.mediaFile,
    title: 'Hardening test',
    mediaSha256: c.hash,
    confirmPublish: 'YES',
    visibility: 'private',
    ...overrides,
  };
}

/** Mutable gate stand-in: tests flip `state` while the R2 upload is "running". */
function trackGate(c: ReturnType<typeof makeCase>, state: any) {
  const calls: any[] = [];
  const gate = async (input: any) => {
    calls.push(input);
    if (state.ok === false) return { ok: false, reason: state.reason ?? 'integrity approval is no longer valid' };
    return {
      ok: true,
      approvedOutputPath: state.path ?? c.mediaFile,
      approvedOutputHash: state.hash ?? c.hash,
      approvedArtifactKind: state.kind ?? 'candidate',
    };
  };
  return { gate, calls };
}

function mediaHost(c: ReturnType<typeof makeCase>, onUpload?: () => Promise<void> | void) {
  return {
    uploadVideo: async () => {
      if (onUpload) await onUpload();
      return {
        bucket: 'offline-test-bucket',
        key: `youtube-automation/${PROJECT_ID}/${c.hash}.mp4`,
        sha256: c.hash,
        size: 1,
        contentType: 'video/mp4',
      };
    },
    uploadThumbnail: async () => { throw new Error('thumbnail is not used'); },
    presign: async () => 'https://signed.example/video?X-Amz-Signature=OFFLINE_SECRET',
  };
}

function depsFor(
  c: ReturnType<typeof makeCase>,
  options: {
    gate?: (input: any) => Promise<any>;
    onUpload?: () => Promise<void> | void;
    transport?: (payload: any) => Promise<{ status: number; bodyText: string }>;
    saveProject?: (file: string, project: any) => Promise<void>;
  } = {},
) {
  return {
    evaluateGate: options.gate ?? (async () => ({
      ok: true,
      approvedOutputPath: c.mediaFile,
      approvedOutputHash: c.hash,
      approvedArtifactKind: 'candidate',
    })),
    accountInspector: async () => [activeAccount],
    mediaHost: mediaHost(c, options.onUpload),
    ...(options.transport ? { publishTransport: options.transport } : {}),
    ...(options.saveProject ? { saveProject: options.saveProject } : {}),
  };
}

function readReview(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8')).review;
}

function readProject(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function lockPath(file: string): string {
  return `${path.resolve(file)}.publish.lock`;
}

async function acceptPublication(c: ReturnType<typeof makeCase>, options: Parameters<typeof depsFor>[1] = {}) {
  const out = await Z.publishToZernio(requestFor(c), depsFor(c, {
    ...options,
    transport: options.transport ?? (async () => okBody()),
  }));
  assert.equal(out.ok, true);
  assert.equal(readReview(c.projectFile).publish.status, 'ACCEPTED');
  return out;
}

// =====================================================================================
// 1-3, 14. The gate is re-evaluated under the lock, immediately before SUBMITTING.
// =====================================================================================

test('approval revoked during the R2 upload aborts before any provider request', async () => {
  const c = makeCase('revoked-during-upload');
  const state: any = { ok: true };
  const { gate, calls } = trackGate(c, state);
  let transportCalls = 0;

  const out = await Z.publishToZernio(requestFor(c), depsFor(c, {
    gate,
    onUpload: () => { state.ok = false; state.reason = 'approval.json was removed'; },
    transport: async () => { transportCalls++; return okBody(); },
  }));

  assert.equal(out.ok, false);
  assert.equal(out.refused, 'integrity');
  assert.equal(calls.length, 2, 'the gate must run once before the lock and once under the lock');
  assert.equal(transportCalls, 0, 'no provider request may be sent after the final gate fails');
  assert.equal(readReview(c.projectFile).publish, undefined, 'no SUBMITTING marker may be persisted');
  assert.equal(readReview(c.projectFile).status, 'approved');
  assert.equal(fs.existsSync(lockPath(c.projectFile)), false);
});

test('review reject during the R2 upload is preserved and cancels the submission', async () => {
  const c = makeCase('reject-during-upload');
  let transportCalls = 0;

  const out = await Z.publishToZernio(requestFor(c), depsFor(c, {
    onUpload: async () => {
      const project = readProject(c.projectFile);
      project.review.status = 'rejected';
      project.review.decided_at = new Date().toISOString();
      fs.writeFileSync(c.projectFile, `${JSON.stringify(project, null, 2)}\n`);
    },
    transport: async () => { transportCalls++; return okBody(); },
  }));

  assert.equal(out.ok, false);
  assert.equal(transportCalls, 0);
  const review = readReview(c.projectFile);
  assert.equal(review.status, 'rejected', 'the concurrent rejection must not be overwritten');
  assert.equal(review.publish, undefined);
});

test('a reject landing between validation and the SUBMITTING write is never overwritten', async () => {
  const c = makeCase('reject-between-validation-and-write');
  let gateCalls = 0;
  let transportCalls = 0;

  const out = await Z.publishToZernio(requestFor(c), depsFor(c, {
    gate: async () => {
      gateCalls++;
      if (gateCalls === 2) {
        // The under-lock verdict is computed from a snapshot taken just before this call; the
        // human rejects the review while that re-validation is running. The verdict itself stays
        // valid, so only the conditional write can catch this.
        const project = readProject(c.projectFile);
        project.review.status = 'rejected';
        project.review.decided_at = new Date().toISOString();
        fs.writeFileSync(c.projectFile, `${JSON.stringify(project, null, 2)}\n`);
      }
      return { ok: true, approvedOutputPath: c.mediaFile, approvedOutputHash: c.hash, approvedArtifactKind: 'candidate' };
    },
    transport: async () => { transportCalls++; return okBody(); },
  }));

  assert.equal(gateCalls, 2);
  assert.equal(out.ok, false);
  assert.equal(out.refused, 'state');
  assert.equal(transportCalls, 0, 'a stale SUBMITTING write must not lead to a provider request');
  const review = readReview(c.projectFile);
  assert.equal(review.status, 'rejected', 'the concurrent rejection must survive');
  assert.equal(review.publish, undefined);
});

test('approval replaced with a different candidate during the upload aborts the submission', async () => {
  const c = makeCase('approval-replaced');
  const otherFile = path.join(c.root, 'other-candidate.mp4');
  fs.writeFileSync(otherFile, Buffer.from('a different candidate'));
  const otherHash = sha256(fs.readFileSync(otherFile));
  const state: any = { ok: true };
  const { gate } = trackGate(c, state);
  let transportCalls = 0;

  const out = await Z.publishToZernio(requestFor(c), depsFor(c, {
    gate,
    onUpload: () => { state.path = otherFile; state.hash = otherHash; },
    transport: async () => { transportCalls++; return okBody(); },
  }));

  assert.equal(out.ok, false);
  assert.equal(out.refused, 'integrity');
  assert.match(out.reason, /hash changed|path changed/i);
  assert.equal(transportCalls, 0);
  assert.equal(readReview(c.projectFile).publish, undefined);
});

test('a blocking publication state rechecked under the lock stops the submission', async () => {
  const c = makeCase('blocking-under-lock');
  let transportCalls = 0;

  const out = await Z.publishToZernio(requestFor(c), depsFor(c, {
    onUpload: () => {
      const project = readProject(c.projectFile);
      project.review.publish = { status: 'AMBIGUOUS', submission_id: 'external-submission' };
      fs.writeFileSync(c.projectFile, `${JSON.stringify(project, null, 2)}\n`);
    },
    transport: async () => { transportCalls++; return okBody(); },
  }));

  assert.equal(out.ok, false);
  assert.equal(out.refused, 'duplicate');
  assert.equal(transportCalls, 0);
  assert.equal(readReview(c.projectFile).publish.submission_id, 'external-submission');
});

// =====================================================================================
// 4. Malformed publication state fails closed.
// =====================================================================================

test('only a genuinely absent review.publish resolves to IDLE', () => {
  assert.equal(RS.getPublicationStatus({ status: 'approved', video_path: 'x' }), 'IDLE');
  assert.equal(RS.getPublicationStatus({ status: 'approved', video_path: 'x', publish: undefined }), 'IDLE');

  for (const publish of [null, [], 'SUBMITTING', 42, {}]) {
    assert.equal(RS.getPublicationStatus({ status: 'approved', video_path: 'x', publish } as any), 'AMBIGUOUS', JSON.stringify(publish));
  }
  for (const status of ['PENDING', 'SUBMITTED', 'submittng', '', '   ', 7, null]) {
    assert.equal(RS.getPublicationStatus({ status: 'approved', video_path: 'x', publish: { status } } as any), 'AMBIGUOUS', String(status));
  }

  assert.equal(RS.getPublicationStatus({ status: 'approved', video_path: 'x', publish: { status: 'submitting' } }), 'SUBMITTING');
  assert.equal(RS.getPublicationStatus({ status: 'approved', video_path: 'x', publish: { status: ' accepted ' } }), 'ACCEPTED');
  assert.equal(RS.getPublicationStatus({ status: 'approved', video_path: 'x', publish: { status: 'FAILED' } }), 'FAILED');
  assert.equal(RS.getPublicationStatus(undefined), 'IDLE');
});

test('unknown or malformed review.publish.status blocks publishing even though the review is approved', async () => {
  for (const publish of [{ status: 'PENDING' }, { status: 42 }, {}, null, 'SUBMITTING']) {
    const c = makeCase(`malformed-${JSON.stringify(publish).replace(/[^a-z0-9]/gi, '-')}`);
    const project = readProject(c.projectFile);
    project.review.publish = publish;
    fs.writeFileSync(c.projectFile, `${JSON.stringify(project, null, 2)}\n`);
    let transportCalls = 0;

    const out = await Z.publishToZernio(requestFor(c), depsFor(c, {
      transport: async () => { transportCalls++; return okBody(); },
    }));

    assert.equal(out.ok, false, JSON.stringify(publish));
    assert.equal(out.refused, 'duplicate', JSON.stringify(publish));
    assert.equal(transportCalls, 0, JSON.stringify(publish));
  }
});

test('a legacy approved project with no review.publish stays retryable', async () => {
  const c = makeCase('legacy-idle');
  assert.equal(readReview(c.projectFile).publish, undefined);
  const out = await Z.publishToZernio(requestFor(c), depsFor(c, { transport: async () => okBody() }));
  assert.equal(out.ok, true);
  assert.equal(readReview(c.projectFile).publish.status, 'ACCEPTED');
});

// =====================================================================================
// 5-6. Lock ownership.
// =====================================================================================

test('an existing stale lock refuses publishing and is left untouched', async () => {
  const c = makeCase('stale-lock');
  const lock = lockPath(c.projectFile);
  const stale = `${JSON.stringify({ submission_id: 'dead-process', pid: 999999, acquired_at: '2026-01-01T00:00:00.000Z' })}\n`;
  fs.writeFileSync(lock, stale);
  let transportCalls = 0;

  const out = await Z.publishToZernio(requestFor(c), depsFor(c, {
    transport: async () => { transportCalls++; return okBody(); },
  }));

  assert.equal(out.ok, false);
  assert.equal(out.refused, 'duplicate');
  assert.equal(transportCalls, 0);
  assert.equal(fs.readFileSync(lock, 'utf8'), stale, 'a stale lock must never be stolen or removed');
  assert.equal(readReview(c.projectFile).publish, undefined);
});

test('a lock replaced by another process is not deleted by the original release', async () => {
  const c = makeCase('replaced-lock');
  const lock = lockPath(c.projectFile);
  const replacement = `${JSON.stringify({ submission_id: 'another-process', pid: 4242, acquired_at: '2026-01-01T00:00:00.000Z' })}\n`;

  const out = await Z.publishToZernio(requestFor(c), depsFor(c, {
    transport: async () => {
      // Simulate an operator/other process removing and re-creating the lock while this request
      // is in flight.
      fs.rmSync(lock, { force: true });
      fs.writeFileSync(lock, replacement);
      return okBody();
    },
  }));

  assert.equal(out.ok, true);
  assert.equal(readReview(c.projectFile).publish.status, 'ACCEPTED');
  assert.equal(fs.existsSync(lock), true, 'the replacement lock must survive the original release');
  assert.equal(fs.readFileSync(lock, 'utf8'), replacement);
  fs.rmSync(lock, { force: true });
});

// =====================================================================================
// 7-9. Redirects and failure classification.
// =====================================================================================

for (const status of [301, 302, 307, 308]) {
  test(`HTTP ${status} from the transport is AMBIGUOUS and blocks retry`, async () => {
    const c = makeCase(`redirect-${status}`);
    let calls = 0;
    const transport = async () => { calls++; return { status, bodyText: '' }; };

    await assert.rejects(
      () => Z.publishToZernio(requestFor(c), depsFor(c, { transport })),
      /Zernio publish failed/i,
    );

    assert.equal(calls, 1);
    const review = readReview(c.projectFile);
    assert.equal(review.publish.status, 'AMBIGUOUS');
    assert.equal(review.publish.http_status, status);
    assert.equal(review.status, 'approved');

    const retry = await Z.publishToZernio(requestFor(c), depsFor(c, { transport }));
    assert.equal(retry.ok, false);
    assert.equal(retry.refused, 'duplicate');
    assert.equal(calls, 1, 'an ambiguous result must never be retried automatically');
    assert.equal(fs.existsSync(lockPath(c.projectFile)), false);
  });
}

test('HTTP 409 is AMBIGUOUS and blocks retry', async () => {
  const c = makeCase('http-409');
  let calls = 0;
  const transport = async () => { calls++; throw new Z.ZernioPublishHttpError(409); };

  await assert.rejects(() => Z.publishToZernio(requestFor(c), depsFor(c, { transport })), /Zernio publish failed/i);

  assert.equal(calls, 1);
  const review = readReview(c.projectFile);
  assert.equal(review.publish.status, 'AMBIGUOUS');
  assert.equal(review.publish.http_status, 409);
  assert.match(review.publish.last_error, /ambiguous/i);

  const retry = await Z.publishToZernio(requestFor(c), depsFor(c, { transport }));
  assert.equal(retry.ok, false);
  assert.equal(retry.refused, 'duplicate');
  assert.equal(calls, 1);
});

test('HTTP 408 and 425 are AMBIGUOUS, never retryable', async () => {
  for (const status of [408, 425]) {
    const c = makeCase(`ambiguous-${status}`);
    let calls = 0;
    const transport = async () => { calls++; throw new Z.ZernioPublishHttpError(status); };
    await assert.rejects(() => Z.publishToZernio(requestFor(c), depsFor(c, { transport })), /Zernio publish failed/i);
    assert.equal(readReview(c.projectFile).publish.status, 'AMBIGUOUS', String(status));
    const retry = await Z.publishToZernio(requestFor(c), depsFor(c, { transport }));
    assert.equal(retry.refused, 'duplicate', String(status));
    assert.equal(calls, 1, String(status));
  }
});

test('the definitive-failure whitelist keeps a fixed request retryable', async () => {
  for (const status of [400, 401, 403, 404, 413, 422, 429]) {
    const c = makeCase(`definitive-${status}`);
    let calls = 0;
    const failed = await Z.publishToZernio(requestFor(c), depsFor(c, {
      transport: async () => { calls++; throw new Z.ZernioPublishHttpError(status); },
    }));

    assert.equal(failed.ok, false, String(status));
    assert.equal(failed.refused, 'provider', String(status));
    assert.equal(readReview(c.projectFile).publish.status, 'FAILED', String(status));
    assert.equal(calls, 1, String(status));

    const retried = await Z.publishToZernio(requestFor(c), depsFor(c, {
      transport: async () => { calls++; return okBody(); },
    }));
    assert.equal(retried.ok, true, String(status));
    assert.equal(readReview(c.projectFile).publish.status, 'ACCEPTED', String(status));
    assert.equal(calls, 2, String(status));
  }
});

// =====================================================================================
// 10-13. Confirmation hardening.
// =====================================================================================

test('confirmation after the review was rejected is refused and does not mark the review posted', async () => {
  const c = makeCase('confirm-after-reject');
  await acceptPublication(c);

  const project = readProject(c.projectFile);
  project.review.status = 'rejected';
  project.review.decided_at = new Date().toISOString();
  fs.writeFileSync(c.projectFile, `${JSON.stringify(project, null, 2)}\n`);

  const out = await Z.confirmZernioPublication({
    projectFile: c.projectFile,
    confirmPublish: 'YES',
    postId: 'post-1',
    youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  });

  assert.equal(out.ok, false);
  assert.equal(out.refused, 'state');
  const review = readReview(c.projectFile);
  assert.equal(review.status, 'rejected');
  assert.equal(review.publish.status, 'ACCEPTED');
  assert.equal(review.posted_at, undefined);
});

test('confirmation without the recorded post ID is refused', async () => {
  const c = makeCase('confirm-no-post-id');
  await acceptPublication(c);

  const out = await Z.confirmZernioPublication({
    projectFile: c.projectFile,
    confirmPublish: 'YES',
    youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  });

  assert.equal(out.ok, false);
  assert.equal(out.refused, 'validation');
  assert.match(out.reason, /post-id|post ID/i);
  const review = readReview(c.projectFile);
  assert.equal(review.status, 'approved');
  assert.equal(review.publish.status, 'ACCEPTED');
});

test('non-video, non-HTTPS, malformed, and unrelated-host URLs are refused', async () => {
  const c = makeCase('confirm-bad-urls');
  await acceptPublication(c);

  const rejected = [
    'https://www.youtube.com/channel/UC12345678901234567890',
    'https://www.youtube.com/playlist?list=PL1234567890abcdef',
    'https://www.youtube.com/',
    'https://www.youtube.com/@somechannel',
    'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://evil.example/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=too-short',
    'https://www.youtube.com/watch',
    'not a url',
    'youtu.be/dQw4w9WgXcQ',
  ];

  for (const url of rejected) {
    const out = await Z.confirmZernioPublication({
      projectFile: c.projectFile,
      confirmPublish: 'YES',
      postId: 'post-1',
      youtubeUrl: url,
    });
    assert.equal(out.ok, false, url);
    assert.equal(out.refused, 'validation', url);
  }

  const review = readReview(c.projectFile);
  assert.equal(review.status, 'approved');
  assert.equal(review.publish.status, 'ACCEPTED');
  assert.equal(review.posted_at, undefined);
});

test('standard watch, shorts, embed, live, and youtu.be URLs are accepted for confirmation', async () => {
  const accepted = [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ&list=PL1234567890', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ?feature=share', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ];

  for (const [url, videoId] of accepted) {
    const c = makeCase(`confirm-ok-${url.replace(/[^a-z0-9]/gi, '-')}`);
    await acceptPublication(c);
    const out = await Z.confirmZernioPublication({
      projectFile: c.projectFile,
      confirmPublish: 'YES',
      postId: 'post-1',
      youtubeUrl: url,
    });
    assert.equal(out.ok, true, url);
    assert.equal(out.publication.youtube_video_id, videoId, url);
    assert.equal(out.review.status, 'posted', url);
    assert.equal(readReview(c.projectFile).youtube_url, url, url);
  }

  assert.equal(Z.parseYouTubeVideoUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')?.videoId, 'dQw4w9WgXcQ');
  assert.equal(Z.parseYouTubeVideoUrl('https://youtu.be/dQw4w9WgXcQ?si=abc')?.videoId, 'dQw4w9WgXcQ');
});

test('confirmation persistence failure leaves the review approved and accepted', async () => {
  const c = makeCase('confirm-save-failure');
  await acceptPublication(c);

  const out = await Z.confirmZernioPublication(
    {
      projectFile: c.projectFile,
      confirmPublish: 'YES',
      postId: 'post-1',
      youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    },
    { saveProject: async () => { throw new Error('disk full'); } },
  );

  assert.equal(out.ok, false);
  assert.equal(out.refused, 'save');
  const review = readReview(c.projectFile);
  assert.equal(review.status, 'approved');
  assert.equal(review.publish.status, 'ACCEPTED');
  assert.equal(review.posted_at, undefined);
});

test('confirmation preserves provider reconciliation notes', async () => {
  const c = makeCase('confirm-keeps-note');
  await Z.publishToZernio(requestFor(c), depsFor(c, {
    transport: async () => ({
      status: 200,
      bodyText: JSON.stringify({ post: { id: 'post-9', platforms: [{ platform: 'youtube', platformPostUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }] } }),
    }),
  }));
  const project = readProject(c.projectFile);
  project.review.publish.note = 'provider: youtube result had no thumbnail';
  fs.writeFileSync(c.projectFile, `${JSON.stringify(project, null, 2)}\n`);

  const out = await Z.confirmZernioPublication({
    projectFile: c.projectFile,
    confirmPublish: 'YES',
    postId: 'post-9',
    youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ',
    note: 'Verified private in YouTube Studio',
  });

  assert.equal(out.ok, true);
  assert.match(out.publication.note, /provider: youtube result had no thumbnail/);
  assert.match(out.publication.note, /Verified private in YouTube Studio/);
});
