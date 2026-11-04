/**
 * Per-project publication lock, shared by the publisher (`zernio.ts`) and the human review
 * actions (`review.ts`).
 *
 * WHY THIS IS SHARED
 * The publisher holds this lock for the whole submission window: under-lock approval
 * re-validation, R2 upload/presign, the SUBMITTING marker, and the POST. A `review reject`
 * landing inside that window used to be able to race a submission that was already on its way to
 * the provider. Both sides now take the same exclusive lock, so a review decision happens either
 * entirely before the publisher starts or entirely after it finishes.
 *
 * SAFETY PROPERTIES
 *  - `wx` open is atomic: two processes cannot both hold the lock.
 *  - The lock is never stolen automatically. A crash leaves the file behind (fail-closed) and it
 *    must be reconciled manually.
 *  - Release deletes the file only while it still records THIS owner's token, so a lock that was
 *    manually replaced by another process is never deleted by the previous owner.
 *  - Acquisition never blocks. A caller that finds the lock held refuses immediately instead of
 *    waiting, which keeps both the publisher and the review CLI free of deadlocks.
 *
 * MANUAL STALE-LOCK RECONCILIATION (no reset command exists on purpose)
 *   1. Confirm no publisher or review command is running for this project.
 *   2. Read `<pipeline.json>.publish.lock`. The owner token must match
 *      `review.publish.submission_id` (publisher) or start with `review:` (review action). An
 *      empty/unparseable file means the owning process died before recording itself.
 *   3. Reconcile `review.publish` (SUBMITTING/AMBIGUOUS) against the Zernio dashboard and the
 *      YouTube channel BEFORE deleting anything.
 *   4. Delete the lock file manually, then update `review.publish` deliberately.
 * Never delete the lock while a `SUBMITTING` marker is still unexplained.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const PUBLISH_LOCK_SUFFIX = '.publish.lock';

export interface PublishLock {
  ownerId: string;
  lockPath: string;
  release: () => Promise<void>;
}

export interface PublishLockInfo {
  present: boolean;
  /** Owner token (`submission_id` in the lock file). Absent when the file is unparseable/empty. */
  ownerId?: string;
  pid?: number;
  acquiredAt?: string;
  /** The file exists but its contents cannot be attributed to an owner. */
  unreadable?: boolean;
}

/** Absolute path of the lock that guards `projectFile`. */
export function publishLockPath(projectFile: string): string {
  return `${path.resolve(projectFile)}${PUBLISH_LOCK_SUFFIX}`;
}

/**
 * Read-only inspection. Never steals, never deletes, never waits. Used only to explain WHY an
 * acquisition failed; the acquisition itself is what actually guards the critical section.
 */
export async function inspectPublishLock(projectFile: string): Promise<PublishLockInfo> {
  const lockPath = publishLockPath(projectFile);
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, 'utf8');
  } catch {
    return { present: false };
  }
  let record: { submission_id?: unknown; pid?: unknown; acquired_at?: unknown };
  try {
    record = JSON.parse(raw) as typeof record;
  } catch {
    return { present: true, unreadable: true };
  }
  const ownerId = typeof record?.submission_id === 'string' ? record.submission_id : undefined;
  return {
    present: true,
    ...(ownerId ? { ownerId } : { unreadable: true }),
    ...(typeof record?.pid === 'number' ? { pid: record.pid } : {}),
    ...(typeof record?.acquired_at === 'string' ? { acquiredAt: record.acquired_at } : {}),
  };
}

/**
 * Take the exclusive lock for `projectFile`, owned by `ownerId`.
 *
 * Returns `null` when the lock is already held (by a publisher, by a review action, or by a
 * crashed process) — the caller must refuse, never wait and never steal.
 */
export async function acquirePublishLock(projectFile: string, ownerId: string): Promise<PublishLock | null> {
  const lockPath = publishLockPath(projectFile);
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(lockPath, 'wx');
  } catch (error: any) {
    if (error?.code === 'EEXIST') return null;
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ submission_id: ownerId, pid: process.pid, acquired_at: new Date().toISOString() })}\n`, 'utf8');
  } catch (error) {
    await handle.close().catch(() => {});
    // Only an empty file can be proven to be the lock we just created; anything else belongs to
    // someone who replaced it in the meantime and must not be touched.
    await removeLockIfStillEmpty(lockPath);
    throw error;
  }
  await handle.close();
  let released = false;
  return {
    ownerId,
    lockPath,
    release: async () => {
      if (released) return;
      released = true;
      await releaseOwnedLock(lockPath, ownerId);
    },
  };
}

async function removeLockIfStillEmpty(lockPath: string): Promise<void> {
  try {
    const stat = await fs.stat(lockPath);
    if (stat.size !== 0) return;
  } catch {
    return;
  }
  await fs.unlink(lockPath).catch(() => {});
}

/**
 * Delete the lock only when it still records this exact owner. A missing lock is fine (it is
 * already gone). An empty or unparseable lock, or one owned by someone else, is left in place:
 * that is the fail-closed outcome and it requires manual reconciliation.
 */
async function releaseOwnedLock(lockPath: string, ownerId: string): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, 'utf8');
  } catch {
    return;
  }
  let owner: unknown = null;
  try {
    owner = (JSON.parse(raw) as { submission_id?: unknown })?.submission_id;
  } catch {
    owner = null;
  }
  if (owner !== ownerId) return;
  await fs.unlink(lockPath).catch(() => {});
}
