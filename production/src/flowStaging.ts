/**
 * FLOW ARTIFACT STAGING PATHS (PURE).
 *
 * WHY THIS EXISTS
 * ---------------
 * The project `youtube-automation-2-20261003160855-2740` already has a committed, valid local
 * artifact for Scene 1:
 *
 *     production/outputs/youtube-automation-2-20261003160855-2740/scene-0001.mp4
 *     2,770,756 bytes, h264 1280x720 30fps + aac, 22.0s
 *     state.json -> render_mode LOCAL_SYNTHESIS, output_state CURRENT
 *     state.state = AWAITING_APPROVAL, and final-title.mp4 already depends on it
 *
 * A Flow download must therefore NEVER target `scene-####.mp4`. Doing so would silently destroy a
 * committed asset inside an already-rendered, awaiting-approval deliverable.
 *
 * THE TWO AUTHORITIES, KEPT SEPARATE
 * ---------------------------------
 *   · `scene-####.mp4`          — the LOCAL_SYNTHESIS / review artifact. Owned by the existing
 *                                 pipeline. Never written by a Flow download.
 *   · `flow-scene-####.mp4`     — the FLOW staging artifact. A Flow download lands here and only
 *                                 here. It is inert until an EXPLICIT future promotion step, which
 *                                 is deliberately NOT implemented.
 *
 * Promotion is not implicit, not automatic, and not modelled as a side effect of staging. This
 * module exposes no function that copies, renames, deletes or overwrites `scene-####.mp4`.
 */

import path from 'node:path';

/** The authoritative local scene artifact filename, owned by the existing pipeline. */
export const LOCAL_SCENE_FILENAME_PREFIX = 'scene-';
/** The Flow staging filename prefix. Deliberately distinct from {@link LOCAL_SCENE_FILENAME_PREFIX}. */
export const FLOW_STAGING_FILENAME_PREFIX = 'flow-scene-';

const pad4 = (n: number): string => String(n).padStart(4, '0');

/** `scene-0001.mp4` — the LOCAL artifact. Never a Flow download target. */
export function localSceneClipFilename(sceneNumber: unknown): string {
  const n = Number(sceneNumber);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`localSceneClipFilename requires a positive integer scene number (got ${String(sceneNumber)}).`);
  return `${LOCAL_SCENE_FILENAME_PREFIX}${pad4(n)}.mp4`;
}

/** `flow-scene-0001.mp4` — the FLOW staging artifact. The ONLY Flow download target. */
export function flowStagingClipFilename(sceneNumber: unknown): string {
  const n = Number(sceneNumber);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`flowStagingClipFilename requires a positive integer scene number (got ${String(sceneNumber)}).`);
  return `${FLOW_STAGING_FILENAME_PREFIX}${pad4(n)}.mp4`;
}

export type SceneOutputAuthority = 'LOCAL_SYNTHESIS' | 'FLOW_GENERATED';

/**
 * PURE: which artifact is authoritative for a scene, and where a Flow download may write.
 *
 * `downloadPath` is ALWAYS the staging path, for both authorities. There is deliberately no input
 * under which this function returns the local `scene-####.mp4` path, because there is no
 * implemented path that may overwrite it.
 */
export function resolveSceneArtifactPaths(input: {
  outputsDir: unknown;
  projectId?: unknown;
  sceneNumber: unknown;
  /** Recorded for the audit trail only; it never changes where a Flow download lands. */
  authority?: SceneOutputAuthority | unknown;
} | undefined | null): {
  ok: true;
  authority: SceneOutputAuthority;
  localPath: string;
  flowStagingPath: string;
  localPathIsProtected: true;
} | { ok: false; reason: string } {
  const outputsDir = typeof input?.outputsDir === 'string' ? input.outputsDir.trim() : '';
  if (!outputsDir) return { ok: false, reason: 'resolveSceneArtifactPaths requires an outputs directory.' };
  const projectId = typeof input?.projectId === 'string' ? input.projectId.trim() : '';
  const n = Number(input?.sceneNumber);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, reason: `sceneNumber must be a positive integer (got ${String(input?.sceneNumber)}).` };

  const authority: SceneOutputAuthority = input?.authority === 'FLOW_GENERATED' ? 'FLOW_GENERATED' : 'LOCAL_SYNTHESIS';
  const dir = path.resolve(outputsDir, projectId);
  return {
    ok: true,
    authority,
    localPath: path.join(dir, localSceneClipFilename(n)),
    flowStagingPath: path.join(dir, flowStagingClipFilename(n)),
    localPathIsProtected: true,
  };
}

/**
 * PURE: the ONLY path a Flow download may write to. Rejects the protected local filename outright.
 *
 * This is the single guard used at the download site so that a future caller cannot pass
 * `scene-####.mp4` and quietly destroy the existing local artifact.
 */
export function resolveFlowDownloadTarget(input: {
  outputsDir: unknown;
  projectId?: unknown;
  sceneNumber: unknown;
  /** An explicit candidate filename; validated, never trusted. */
  proposedFilename?: unknown;
} | undefined | null): { ok: true; filename: string; path: string } | { ok: false; code: 'FLOW_DOWNLOAD_TARGET_PROTECTED' | 'FLOW_DOWNLOAD_TARGET_INVALID'; reason: string } {
  const n = Number(input?.sceneNumber);
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, code: 'FLOW_DOWNLOAD_TARGET_INVALID', reason: `sceneNumber must be a positive integer (got ${String(input?.sceneNumber)}).` };
  }
  const expected = flowStagingClipFilename(n);
  const proposed = typeof input?.proposedFilename === 'string' ? input.proposedFilename.trim() : '';
  if (proposed && proposed !== expected) {
    // Compare on the BASENAME too, so `./scene-0001.mp4`, `.\scene-0001.mp4` and
    // `outputs/<id>/scene-0001.mp4` are all recognised as the protected local artifact.
    const normalized = proposed.replace(/\\/g, '/');
    const base = path.posix.basename(normalized);
    if (base === localSceneClipFilename(n) || base.startsWith(`${LOCAL_SCENE_FILENAME_PREFIX}`)) {
      return { ok: false, code: 'FLOW_DOWNLOAD_TARGET_PROTECTED', reason: `refusing to write the Flow download to ${JSON.stringify(proposed)}: the local scene artifact is owned by the existing review pipeline and must never be overwritten by a Flow download.` };
    }
    return { ok: false, code: 'FLOW_DOWNLOAD_TARGET_INVALID', reason: `the Flow download target must be ${JSON.stringify(expected)} (got ${JSON.stringify(proposed)}).` };
  }
  const resolved = resolveSceneArtifactPaths(input as never);
  if (!resolved.ok) return { ok: false, code: 'FLOW_DOWNLOAD_TARGET_INVALID', reason: resolved.reason };
  return { ok: true, filename: expected, path: resolved.flowStagingPath };
}

/**
 * PURE: promotion of a staged Flow artifact onto the local scene path is NOT IMPLEMENTED.
 *
 * The gate exists so that "promotion" is an explicit, named, currently-blocked operation rather
 * than an accident. Until a future workflow performs identity + persistence + download + media
 * validation and then calls this explicitly, staging never reaches the local artifact.
 */
export const FLOW_PROMOTION_STATUS = 'NOT_IMPLEMENTED' as const;

export function promoteFlowStagingToLocalArtifact(input: {
  stagingPath?: unknown;
  localPath?: unknown;
  /** Every precondition the future promotion workflow must satisfy first. */
  identityVerified?: boolean;
  persistenceVerified?: boolean;
  downloadVerified?: boolean;
  mediaValidated?: boolean;
  explicitUserAuthorization?: boolean;
} | undefined | null): {
  ok: false;
  status: typeof FLOW_PROMOTION_STATUS;
  reason: string;
  unmet: string[];
} {
  const unmet: string[] = [];
  if (input?.identityVerified !== true) unmet.push('identityVerified');
  if (input?.persistenceVerified !== true) unmet.push('persistenceVerified');
  if (input?.downloadVerified !== true) unmet.push('downloadVerified');
  if (input?.mediaValidated !== true) unmet.push('mediaValidated');
  if (input?.explicitUserAuthorization !== true) unmet.push('explicitUserAuthorization');
  return {
    ok: false,
    status: FLOW_PROMOTION_STATUS,
    reason: `promoting a Flow staging artifact onto the local scene artifact is not implemented; ${unmet.length} precondition(s) unmet (${unmet.join(', ')}). The existing local artifact remains authoritative.`,
    unmet,
  };
}
