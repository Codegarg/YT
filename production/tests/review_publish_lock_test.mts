// Review <-> publication lock coordination. OFFLINE ONLY: fake transport, fake R2 host, fake
// account list, temp fixtures. The review CLI is spawned locally with tsx; no network, no
// credentials, no uploads, no publishing.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import { PROD, SRC } from './_testPaths.mjs';

const exec = promisify(execFile);

const Z = await import(pathToFileURL(`${SRC}/zernio.ts`).href);
const RS = await import(pathToFileURL(`${SRC}/reviewState.ts`).href);
const LOCK = await import(pathToFileURL(`${SRC}/publishLock.ts`).href);

const PROJECT_ID = 'youtube-automation-2-20261003160855-2740';
const ACCOUNT_ID = '6ae2401339a3d63e1238c167';
const REVIEW_CLI = `${SRC}/review.ts`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-publish-lock-'));
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
  const projectDir = path.join(root, PROJECT_ID);
  fs.mkdirSync(projectDir, { recursive: true });
  const mediaFile = path.join(root, 'candidate.mp4');
  fs.writeFileSync(mediaFile, Buffer.from(`offline-review-lock-${key}`));
  const hash = sha256(fs.readFileSync(mediaFile));
  const projectFile = path.join(projectDir, 'pipeline.json');
  fs.writeFileSync(projectFile, JSON.stringify({
    project_id: PROJECT_ID,
    review: { status: 'approved', video_path: mediaFile, title: 'Review lock test' },
  }, null, 2));
  return { root, projectFile, mediaFile, hash };
}

function requestFor(c: ReturnType<typeof makeCase>) {
  return {
    projectFile: c.projectFile,
    accountId: ACCOUNT_ID,
    mediaFile: c.mediaFile,
    title: 'Review lock test',
    mediaSha256: c.hash,
    confirmPublish: 'YES',
    visibility: 'private',
  };
}

function depsFor(
  c: ReturnType<typeof makeCase>,
  transport?: (payload: any) => Promise<{ status: number; bodyText: string }>,
) {
  return {
    evaluateGate: async () => ({
      ok: true,
      approvedOutputPath: c.mediaFile,
      approvedOutputHash: c.hash,
      approvedArtifactKind: 'candidate',
    }),
    accountInspector: async () => [activeAccount],
    mediaHost: {
      uploadVideo: async () => ({
        bucket: 'offline-test-bucket',
        key: `youtube-automation/${PROJECT_ID}/${c.hash}.mp4`,
        sha256: c.hash,
        size: 1,
        contentType: 'video/mp4',
      }),
      uploadThumbnail: async () => { throw new Error('thumbnail is not used'); },
      presign: async () => 'https://signed.example/video?X-Amz-Signature=OFFLINE_SECRET',
    },
    ...(transport ? { publishTransport: transport } : {}),
  };
}

function readReview(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8')).review;
}

function lockPath(file: string): string {
  return `${path.resolve(file)}${LOCK.PUBLISH_LOCK_SUFFIX}`;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Spawn the real review CLI. Returns its exit code and captured streams. */
async function runReview(
  command: 'approve' | 'reject' | 'status' | 'request',
  projectFile: string,
  extra: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(
      process.execPath,
      ['--import', 'tsx', REVIEW_CLI, command, '--project', projectFile, ...extra],
      { cwd: PROD, windowsHide: true },
    );
    return { code: 0, stdout, stderr };
  } catch (error: any) {
    return {
      code: typeof error?.code === 'number' ? error.code : 1,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? ''),
    };
  }
}

async function accept(c: ReturnType<typeof makeCase>) {
  const out = await Z.publishToZernio(requestFor(c), depsFor(c, async () => okBody()));
  assert.equal(out.ok, true);
  assert.equal(readReview(c.projectFile).publish.status, 'ACCEPTED');
  return out;
}

/**
 * Start a real publish, wait until it has persisted SUBMITTING (which only happens while it owns
 * the lock) and is parked inside the transport, run a review command, then let it finish.
 */
async function runReviewWhilePublishing(command: 'approve' | 'reject', key: string) {
  const c = makeCase(key);
  const gate = deferred();
  let transportCalls = 0;
  const publishing = Z.publishToZernio(requestFor(c), depsFor(c, async () => {
    transportCalls++;
    await gate.promise;
    return okBody();
  }));

  let observed: any = {};
  try {
    await waitFor(() => {
      try {
        return readReview(c.projectFile).publish?.status === 'SUBMITTING';
      } catch {
        return false;
      }
    }, 'the SUBMITTING marker');

    const projectWhileHeld = fs.readFileSync(c.projectFile, 'utf8');
    const result = await runReview(command, c.projectFile);
    const lockWhileHeld = JSON.parse(fs.readFileSync(lockPath(c.projectFile), 'utf8'));
    const projectAfterRefusal = fs.readFileSync(c.projectFile, 'utf8');
    observed = { projectWhileHeld, result, lockWhileHeld, projectAfterRefusal };
  } finally {
    gate.resolve();
  }

  const outcome = await publishing;
  return { c, outcome, transportCalls, ...observed };
}

// =====================================================================================
// 1-2. A review decision cannot race an active publish.
// =====================================================================================

test('a rejection attempted while the publication lock is held is refused', async () => {
  const { c, result, lockWhileHeld, outcome, transportCalls, projectWhileHeld, projectAfterRefusal } = await runReviewWhilePublishing('reject', 'reject-while-publishing');

  assert.equal(result.code, 3, 'a busy publication must be a distinct refusal, not a generic error');
  assert.match(result.stderr, /publication-in-progress/);
  assert.match(result.stderr, /publication lock/i);
  assert.equal(result.stdout, '');
  assert.equal(projectAfterRefusal, projectWhileHeld, 'a refused review action must not touch the project');

  // The publisher kept ownership and the review stayed approved.
  assert.ok(lockWhileHeld?.submission_id);
  assert.equal(String(lockWhileHeld.submission_id).startsWith('review:'), false);
  assert.equal(readReview(c.projectFile).status, 'approved');

  assert.equal(outcome.ok, true);
  assert.equal(transportCalls, 1);
  const review = readReview(c.projectFile);
  assert.equal(review.status, 'approved');
  assert.equal(review.publish.status, 'ACCEPTED');
  assert.equal(fs.existsSync(lockPath(c.projectFile)), false, 'the publisher releases its lock');
});

test('an approval attempted while the publication lock is held is refused', async () => {
  const { c, result, lockWhileHeld, outcome } = await runReviewWhilePublishing('approve', 'approve-while-publishing');

  assert.equal(result.code, 3);
  assert.match(result.stderr, /publication-in-progress/);
  assert.equal(String(lockWhileHeld?.submission_id ?? '').startsWith('review:'), false);
  assert.equal(readReview(c.projectFile).status, 'approved');
  assert.equal(outcome.ok, true);
  assert.equal(readReview(c.projectFile).publish.status, 'ACCEPTED');
});

test('a publish is refused while a review action owns the lock', async () => {
  const c = makeCase('publish-while-review-lock');
  const lock = lockPath(c.projectFile);
  const contents = `${JSON.stringify({ submission_id: 'review:test-owner', pid: 4321, acquired_at: '2026-01-01T00:00:00.000Z' })}\n`;
  fs.writeFileSync(lock, contents);
  let transportCalls = 0;

  const out = await Z.publishToZernio(requestFor(c), depsFor(c, async () => { transportCalls++; return okBody(); }));

  assert.equal(out.ok, false);
  assert.equal(out.refused, 'state');
  assert.match(out.reason, /review approval\/rejection/i);
  assert.equal(transportCalls, 0);
  assert.equal(fs.readFileSync(lock, 'utf8'), contents, 'the review lock must not be removed by the publisher');
  assert.equal(readReview(c.projectFile).publish, undefined);
  fs.rmSync(lock, { force: true });
});

// =====================================================================================
// 3-4. Success after release, and lock ownership.
// =====================================================================================

test('a review action succeeds after the publication lock is released', async () => {
  const c = makeCase('after-release');
  await accept(c);
  assert.equal(fs.existsSync(lockPath(c.projectFile)), false);

  const rejected = await runReview('reject', c.projectFile);
  assert.equal(rejected.code, 0);
  assert.match(rejected.stdout, /"status": "rejected"/);
  assert.match(rejected.stdout, /Should I regenerate the video\?/);

  const review = readReview(c.projectFile);
  assert.equal(review.status, 'rejected');
  assert.equal(review.publish.status, 'ACCEPTED', 'the publication marker is preserved, not rebuilt');
  assert.equal(review.publish.zernio_post_id, 'post-1');
  assert.equal(fs.existsSync(lockPath(c.projectFile)), false, 'the review command releases its own lock');

  const approved = await runReview('approve', c.projectFile);
  assert.equal(approved.code, 0);
  assert.equal(readReview(c.projectFile).status, 'approved');
  assert.equal(readReview(c.projectFile).publish.status, 'ACCEPTED');
  assert.equal(fs.existsSync(lockPath(c.projectFile)), false);
});

test('a review action never deletes a lock owned by another process', async () => {
  const c = makeCase('foreign-lock');
  const lock = lockPath(c.projectFile);
  const contents = `${JSON.stringify({ submission_id: 'publisher-owner', pid: 1234, acquired_at: '2026-01-01T00:00:00.000Z' })}\n`;
  fs.writeFileSync(lock, contents);

  const result = await runReview('reject', c.projectFile);

  assert.equal(result.code, 3);
  assert.match(result.stderr, /publication-in-progress/);
  assert.equal(fs.readFileSync(lock, 'utf8'), contents, 'a foreign lock must be left byte-identical');
  assert.equal(readReview(c.projectFile).status, 'approved');
  fs.rmSync(lock, { force: true });
});

test('the lock helpers are ownership-checked and never steal a live lock', async () => {
  const c = makeCase('lock-helpers');
  const first = await LOCK.acquirePublishLock(c.projectFile, 'owner-a');
  assert.ok(first);
  assert.equal(await LOCK.acquirePublishLock(c.projectFile, 'owner-b'), null, 'a held lock cannot be acquired twice');

  const info = await LOCK.inspectPublishLock(c.projectFile);
  assert.equal(info.present, true);
  assert.equal(info.ownerId, 'owner-a');

  // Replace the lock behind the owner's back: release must not delete the replacement.
  fs.rmSync(lockPath(c.projectFile), { force: true });
  fs.writeFileSync(lockPath(c.projectFile), `${JSON.stringify({ submission_id: 'owner-b' })}\n`);
  await first!.release();
  assert.equal(fs.existsSync(lockPath(c.projectFile)), true);
  assert.equal(JSON.parse(fs.readFileSync(lockPath(c.projectFile), 'utf8')).submission_id, 'owner-b');
  fs.rmSync(lockPath(c.projectFile), { force: true });
});

// =====================================================================================
// 5. Ordinary review operations do not change publication semantics.
// =====================================================================================

test('ordinary review operations do not disturb the publication lifecycle', async () => {
  const c = makeCase('lifecycle-unaffected');
  await accept(c);

  const before = fs.readFileSync(c.projectFile, 'utf8');
  const status = await runReview('status', c.projectFile);
  assert.equal(status.code, 0);
  assert.match(status.stdout, /"status": "approved"/);
  assert.match(status.stdout, /"status": "ACCEPTED"/);
  assert.equal(fs.readFileSync(c.projectFile, 'utf8'), before, '`review status` is read-only');
  assert.equal(fs.existsSync(lockPath(c.projectFile)), false, '`review status` never takes the lock');

  const second = await Z.publishToZernio(requestFor(c), depsFor(c, async () => okBody()));
  assert.equal(second.ok, false);
  assert.equal(second.refused, 'duplicate', 'ACCEPTED still blocks a second submission');

  const rejected = await runReview('reject', c.projectFile);
  assert.equal(rejected.code, 0);
  const review = readReview(c.projectFile);
  assert.equal(review.status, 'rejected');
  assert.equal(review.publish.status, 'ACCEPTED', 'SUBMITTING/ACCEPTED/AMBIGUOUS/CONFIRMED/FAILED survive a review edit');

  // A rejected review cannot be confirmed; the accepted submission stays pending reconciliation.
  const confirm = await Z.confirmZernioPublication({
    projectFile: c.projectFile,
    confirmPublish: 'YES',
    postId: 'post-1',
    youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ',
  });
  assert.equal(confirm.ok, false);
  assert.equal(confirm.refused, 'state');
  assert.equal(readReview(c.projectFile).status, 'rejected');
});

test('review request still works normally when no publication is active', async () => {
  const c = makeCase('request-idle');
  const out = await runReview('request', c.projectFile, ['--video', c.mediaFile]);

  assert.equal(out.code, 0);
  assert.match(out.stdout, /"status": "awaiting_approval"/);
  assert.ok(readReview(c.projectFile).requested_at);
  assert.equal(fs.existsSync(lockPath(c.projectFile)), false, 'the review command releases its own lock');
});

test('review request is refused while a publication is active and does not clear the marker', async () => {
  const c = makeCase('request-while-publishing');
  const gate = deferred();
  const publishing = Z.publishToZernio(requestFor(c), depsFor(c, async () => {
    await gate.promise;
    return okBody();
  }));
  await waitFor(() => {
    try {
      return readReview(c.projectFile).publish?.status === 'SUBMITTING';
    } catch {
      return false;
    }
  }, 'the SUBMITTING marker');

  let result: { code: number; stdout: string; stderr: string } = { code: 0, stdout: '', stderr: '' };
  try {
    result = await runReview('request', c.projectFile, ['--video', c.mediaFile]);
    assert.equal(result.code, 3);
    assert.match(result.stderr, /publication-in-progress/);
    assert.equal(readReview(c.projectFile).publish.status, 'SUBMITTING', 'the marker is never replaced by a review request');
  } finally {
    gate.resolve();
  }
  const outcome = await publishing;
  assert.equal(outcome.ok, true);
  assert.equal(readReview(c.projectFile).status, 'approved');
});

// =====================================================================================
// 6. A rejected review cannot reach the publisher.
// =====================================================================================

test('no publisher call occurs after the review was rejected', async () => {
  const c = makeCase('rejected-no-publish');
  const rejected = await runReview('reject', c.projectFile);
  assert.equal(rejected.code, 0);
  assert.equal(readReview(c.projectFile).status, 'rejected');

  let calls = 0;
  const out = await Z.publishToZernio(requestFor(c), depsFor(c, async () => { calls++; return okBody(); }));

  assert.equal(out.ok, false);
  assert.equal(out.refused, 'review');
  assert.equal(calls, 0, 'the transport must never be reached for a rejected review');
  assert.equal(readReview(c.projectFile).publish, undefined);
  assert.equal(fs.existsSync(lockPath(c.projectFile)), false);
});

test('an approved review still publishes normally after a reject/approve round trip', async () => {
  const c = makeCase('reject-approve-publish');
  assert.equal((await runReview('reject', c.projectFile)).code, 0);
  assert.equal((await runReview('approve', c.projectFile)).code, 0);
  assert.equal(readReview(c.projectFile).status, 'approved');

  let calls = 0;
  const out = await Z.publishToZernio(requestFor(c), depsFor(c, async () => { calls++; return okBody(); }));
  assert.equal(out.ok, true);
  assert.equal(calls, 1);
  assert.equal(readReview(c.projectFile).publish.status, 'ACCEPTED');
  assert.equal(fs.existsSync(lockPath(c.projectFile)), false);
});
