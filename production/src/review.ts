import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadProject, markReviewPending, saveProject } from './reviewState.js';
import { acquirePublishLock, inspectPublishLock, type PublishLockInfo } from './publishLock.js';

/**
 * Human review CLI.
 *
 * `approve`, `reject`, and `request` mutate the project, so they take the SAME per-project
 * publication lock the publisher uses. While a publish is in flight the review state is
 * read-only: the action is refused with an explanation instead of waiting, because a rejection
 * that lands mid-submission either blocks a video that is already on its way to the provider or,
 * worse, gets overwritten by the publisher's own state write.
 *
 * `status` stays completely read-only and never takes the lock.
 */

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const command = process.argv[2] ?? 'status';
const projectFile = arg('--project');
if (!projectFile) throw new Error('Pass --project <pipeline.json>.');
const absoluteProject = path.resolve(projectFile);

function reviewResponse(review: any): Record<string, unknown> {
  const response: Record<string, unknown> = { review };
  if (review?.status === 'rejected') response.next_question = 'Should I regenerate the video?';
  if (review?.status === 'approved') response.next_step = 'Connect a YouTube account and use the Zernio publish command when you are ready.';
  return response;
}

/** Explain a refused mutation. Exit code 3 distinguishes "busy" from a real error (1). */
async function refuseWhilePublishing(action: string): Promise<void> {
  const active = await inspectPublishLock(absoluteProject).catch((): PublishLockInfo => ({ present: false }));
  console.error(JSON.stringify({
    refused: 'publication-in-progress',
    action,
    project: absoluteProject,
    publication_lock: {
      present: active.present,
      ...(active.ownerId ? { owner: active.ownerId } : {}),
      ...(active.pid ? { pid: active.pid } : {}),
      ...(active.acquiredAt ? { acquired_at: active.acquiredAt } : {}),
      ...(active.unreadable ? { unreadable: true } : {}),
    },
    reason: 'A publication operation currently holds this project\'s publication lock. The review state must not change while a publish is in flight, because the submission may already have been sent to the provider.',
    next_step: 'Wait for the publish to finish, then re-run this review command. If no publisher is running, the lock is stale: reconcile review.publish against the Zernio dashboard first, then follow the documented stale-lock procedure.',
  }, null, 2));
  process.exitCode = 3;
}

/** Best-effort owner token so the lock file records which review command held it. */
function reviewOwnerToken(): string {
  return `review:${randomUUID()}`;
}

if (command === 'request') {
  const video = arg('--video');
  if (!video) throw new Error('Pass --video <final.mp4>.');
  const absoluteVideo = path.resolve(video);
  await fs.access(absoluteVideo);

  const lock = await acquirePublishLock(absoluteProject, reviewOwnerToken());
  if (!lock) {
    await refuseWhilePublishing('request');
  } else {
    try {
      const review = await markReviewPending(absoluteProject, absoluteVideo, arg('--title'));
      console.log(JSON.stringify({ review, questions: ['Should I approve this video?', 'Is it good to post on YouTube or not?'], approve: `npm run review -- approve --project "${absoluteProject}"`, reject: `npm run review -- reject --project "${absoluteProject}"` }, null, 2));
    } finally {
      await lock.release();
    }
  }
} else if (command === 'approve' || command === 'reject') {
  const lock = await acquirePublishLock(absoluteProject, reviewOwnerToken());
  if (!lock) {
    await refuseWhilePublishing(command);
  } else {
    try {
      // Re-read under the lock so the decision is applied to the latest state and an existing
      // `review.publish` marker is preserved rather than rebuilt from a stale snapshot.
      const project = await loadProject(absoluteProject);
      if (!project.review) throw new Error('This project has not reached the review step. Run `review request` after the final video is rendered.');
      project.review.status = command === 'approve' ? 'approved' : 'rejected';
      project.review.decided_at = new Date().toISOString();
      delete project.review.error;
      await saveProject(absoluteProject, project);
      console.log(JSON.stringify(reviewResponse(project.review), null, 2));
    } finally {
      await lock.release();
    }
  }
} else {
  const project = await loadProject(absoluteProject);
  if (!project.review) throw new Error('This project has not reached the review step. Run `review request` after the final video is rendered.');
  if (command !== 'status') throw new Error('Use one of: request, status, approve, reject.');
  console.log(JSON.stringify(reviewResponse(project.review), null, 2));
}
