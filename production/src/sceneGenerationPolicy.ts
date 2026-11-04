/**
 * Explicit scene-generation policy (PURE).
 *
 * This module answers ONE question before any Flow work is attempted:
 *
 *   use the valid local clip, download the committed Flow clip, create a first clip through the
 *   project composer, or perform an EXPLICITLY AUTHORIZED scene-local extension/regeneration?
 *
 * It is deliberately separate from `sceneFlowWorkflow.ts` and `sceneProductionLifecycle.ts`.
 * It performs no I/O, resolves no selectors, and never treats a scene id, a committed clip, or
 * `allowGeneration` as permission to extend/regenerate. Authorization is a separate, exact binding
 * to the observed scene and observed committed clip.
 *
 * INTEGRATION
 * -----------
 * The explicit scene-local branch is wired in `sceneFlowWorkflow.ts`:
 *   · it opens the EXACT authorized target and reads the committed clip BEFORE selecting the path;
 *   · it passes a truthful `committedClipPresent: true` to the reference-aware lifecycle;
 *   · the lifecycle uses the dedicated `canGenerateAuthorizedSceneLocal()` guard, because the
 *     ordinary `canGenerateScene()` deliberately refuses `committedClipPresent: true`;
 *   · FIRST_CLIP remains on the existing project-composer path and is never used as a fallback.
 *
 * The ordinary no-authorization download/first-clip branches keep their pre-policy legacy decision
 * (`decideSceneAction`) because they do not have an exact target+clip binding to feed this policy.
 */
import { isFlowSceneId, normalizeExtractedArtifactUuid } from './videoDecisions.js';

export type SceneCommittedEvidence =
  | { state: 'PRESENT'; sceneId: string; committedClipId: string }
  | { state: 'ABSENT'; sceneId: string | null }
  | { state: 'UNKNOWN'; reason: string };

export type SceneLocalOperation = 'EXTEND' | 'REGENERATE';

export interface SceneLocalAuthorization {
  operation: SceneLocalOperation;
  /** The exact stable Flow scene id the operator authorizes. */
  targetSceneId: string;
  /** The exact committed Flow artifact id currently bound to that scene. */
  expectedCommittedClipId: string;
}

export interface SceneGenerationPolicyInput {
  localClipValid: boolean;
  committed: SceneCommittedEvidence;
  /** Existing credit permission (`--run-flow`). Never extension authorization by itself. */
  allowGeneration: boolean;
  /** Whether the scene-local lifecycle/port is available in this runtime. */
  sceneLocalAvailable: boolean;
  sceneLocalAuthorization?: SceneLocalAuthorization | null;
}

export type SceneGenerationPolicyStopCode =
  | 'LOCAL_CLIP_PRESENT'
  | 'SCENE_STATE_UNKNOWN'
  | 'SCENE_STATE_AMBIGUOUS'
  | 'AUTHORIZATION_INVALID'
  | 'GENERATION_NOT_AUTHORIZED'
  | 'SCENE_LOCAL_UNAVAILABLE'
  | 'TARGET_UNRESOLVED'
  | 'TARGET_MISMATCH'
  | 'COMMITTED_CLIP_UNRESOLVED'
  | 'COMMITTED_CLIP_MISMATCH'
  | 'SCENE_LOCAL_UNSUPPORTED'
  | 'FIRST_CLIP_TARGET_UNSUPPORTED';

export type SceneGenerationPolicyDecision =
  | { action: 'USE_LOCAL'; reason: string }
  | { action: 'DOWNLOAD_ONLY'; sceneId: string; committedClipId: string; reason: string }
  | { action: 'FIRST_CLIP'; mode: 'FIRST_CLIP_PROJECT_GENERATION'; reason: string }
  | {
      action: 'SCENE_LOCAL_EXTENSION';
      mode: 'SCENE_CLIP_EDIT_OR_EXTENSION';
      operation: 'EXTEND';
      targetSceneId: string;
      expectedCommittedClipId: string;
      reason: string;
    }
  | {
      action: 'SCENE_LOCAL_REGENERATE';
      mode: 'SCENE_CLIP_EDIT_OR_EXTENSION';
      operation: 'REGENERATE';
      targetSceneId: string;
      expectedCommittedClipId: string;
      reason: string;
    }
  | { action: 'STOP'; code: SceneGenerationPolicyStopCode; reason: string };

const stop = (code: SceneGenerationPolicyStopCode, reason: string): SceneGenerationPolicyDecision =>
  ({ action: 'STOP', code, reason });

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/**
 * Decide the ONE permitted generation path. Pure, deterministic, fail-closed.
 *
 * Precedence:
 *   1. unknown/malformed committed evidence -> STOP
 *   2. valid local clip -> USE_LOCAL (or STOP if an overwrite was explicitly requested)
 *   3. committed clip + no authorization -> DOWNLOAD_ONLY
 *   4. committed clip + exact authorization -> SCENE_LOCAL_EXTENSION / REGENERATE
 *   5. clipless + no authorization -> FIRST_CLIP (never scene-local)
 *   6. anything else -> STOP
 */
export function decideSceneGenerationPolicy(input: SceneGenerationPolicyInput): SceneGenerationPolicyDecision {
  if (!input || typeof input !== 'object') {
    return stop('SCENE_STATE_UNKNOWN', 'scene-generation policy received no input; refusing to infer a scene state.');
  }

  const committed = input.committed as unknown;
  if (!committed || typeof committed !== 'object' || Array.isArray(committed)) {
    return stop('SCENE_STATE_UNKNOWN', 'committed scene evidence is missing; refusing to treat an unreadable probe as ABSENT.');
  }

  const committedRecord = committed as Record<string, unknown>;
  const state = text(committedRecord.state);

  // UNKNOWN is ALWAYS a stop, even if a local clip happens to exist: the policy never guesses
  // which Flow path owns the scene. A malformed state is ambiguous, not ABSENT.
  if (state === 'UNKNOWN') {
    return stop('SCENE_STATE_UNKNOWN', text(committedRecord.reason) || 'committed scene state is UNKNOWN.');
  }
  if (state !== 'PRESENT' && state !== 'ABSENT') {
    return stop('SCENE_STATE_AMBIGUOUS', `committed scene state ${JSON.stringify(state)} is not one of PRESENT, ABSENT, UNKNOWN.`);
  }

  let observedSceneId = '';
  let observedClipId = '';

  if (state === 'PRESENT') {
    observedSceneId = text(committedRecord.sceneId);
    if (!isFlowSceneId(observedSceneId)) {
      return stop('SCENE_STATE_AMBIGUOUS', `PRESENT committed evidence has no stable Flow scene id (${JSON.stringify(committedRecord.sceneId)}).`);
    }
    observedClipId = normalizeExtractedArtifactUuid(committedRecord.committedClipId) ?? '';
    if (!observedClipId) {
      return stop('SCENE_STATE_AMBIGUOUS', `PRESENT committed evidence has no valid committed clip id (${JSON.stringify(committedRecord.committedClipId)}).`);
    }
  } else {
    // ABSENT may carry the existing scene's id (an existing clipless scene). It is still not a
    // scene-local generation target; it is only used to reject an ambiguous first-clip request.
    observedSceneId = text(committedRecord.sceneId);
    if (observedSceneId && !isFlowSceneId(observedSceneId)) {
      return stop('SCENE_STATE_AMBIGUOUS', `ABSENT committed evidence carries a malformed scene id (${JSON.stringify(observedSceneId)}).`);
    }
  }

  const hasAuthorization = input.sceneLocalAuthorization !== undefined && input.sceneLocalAuthorization !== null;

  // A valid local clip is authoritative and is never overwritten implicitly. An explicit
  // extension/regeneration request must not silently proceed without a separate overwrite policy.
  if (input.localClipValid === true) {
    if (hasAuthorization) {
      return stop('LOCAL_CLIP_PRESENT', 'a valid local clip is present; refusing to overwrite it implicitly with scene-local generation.');
    }
    return { action: 'USE_LOCAL', reason: 'a valid local clip is present; no Flow generation or download is required.' };
  }

  if (state === 'PRESENT') {
    if (!hasAuthorization) {
      return {
        action: 'DOWNLOAD_ONLY',
        sceneId: observedSceneId,
        committedClipId: observedClipId,
        reason: 'the Flow scene is committed and no explicit scene-local authorization was supplied; download only.',
      };
    }

    const authorization = input.sceneLocalAuthorization as unknown;
    if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) {
      return stop('AUTHORIZATION_INVALID', 'scene-local authorization is present but is not an object.');
    }
    const auth = authorization as Record<string, unknown>;
    const operation = text(auth.operation);
    if (operation !== 'EXTEND' && operation !== 'REGENERATE') {
      return stop('AUTHORIZATION_INVALID', `scene-local operation ${JSON.stringify(operation)} is not EXTEND or REGENERATE.`);
    }

    const targetSceneId = text(auth.targetSceneId);
    if (!targetSceneId || !isFlowSceneId(targetSceneId)) {
      return stop('TARGET_UNRESOLVED', `authorized target scene id ${JSON.stringify(targetSceneId)} is not a stable Flow scene id.`);
    }
    if (targetSceneId !== observedSceneId) {
      return stop('TARGET_MISMATCH', `authorized target ${targetSceneId} does not match the observed committed scene ${observedSceneId}.`);
    }

    const expectedCommittedClipId = normalizeExtractedArtifactUuid(auth.expectedCommittedClipId) ?? '';
    if (!expectedCommittedClipId) {
      return stop('COMMITTED_CLIP_UNRESOLVED', `authorized expected committed clip id ${JSON.stringify(auth.expectedCommittedClipId)} is not a valid Flow artifact id.`);
    }
    if (expectedCommittedClipId !== observedClipId) {
      return stop('COMMITTED_CLIP_MISMATCH', `authorized expected clip ${expectedCommittedClipId} does not match the observed committed clip ${observedClipId}.`);
    }

    if (input.allowGeneration !== true) {
      return stop('GENERATION_NOT_AUTHORIZED', 'scene-local generation is not authorized by the run-level generation permission.');
    }
    if (input.sceneLocalAvailable !== true) {
      return stop('SCENE_LOCAL_UNAVAILABLE', 'the scene-local lifecycle/port is not available in this runtime.');
    }

    const common = {
      mode: 'SCENE_CLIP_EDIT_OR_EXTENSION' as const,
      targetSceneId,
      expectedCommittedClipId,
    };
    if (operation === 'EXTEND') {
      return {
        ...common,
        action: 'SCENE_LOCAL_EXTENSION',
        operation: 'EXTEND',
        reason: `explicitly authorized extension of scene ${targetSceneId} from committed clip ${expectedCommittedClipId}.`,
      };
    }
    return {
      ...common,
      action: 'SCENE_LOCAL_REGENERATE',
      operation: 'REGENERATE',
      reason: `explicitly authorized regeneration of scene ${targetSceneId} from committed clip ${expectedCommittedClipId}.`,
    };
  }

  // ABSENT: a clipless scene. It may only use the project-composer first-clip path. An explicit
  // scene-local request is unsupported and MUST NOT silently downgrade to first-clip generation.
  if (hasAuthorization) {
    return stop('SCENE_LOCAL_UNSUPPORTED', 'the scene has no committed clip; scene-local extension/regeneration is unsupported (no fallback to first-clip generation).');
  }
  if (observedSceneId) {
    return stop('FIRST_CLIP_TARGET_UNSUPPORTED', `scene ${observedSceneId} exists but has no committed clip; the first-clip project-composer path does not target an existing scene.`);
  }
  if (input.allowGeneration !== true) {
    return stop('GENERATION_NOT_AUTHORIZED', 'first-clip generation requires explicit run-level generation permission.');
  }
  return {
    action: 'FIRST_CLIP',
    mode: 'FIRST_CLIP_PROJECT_GENERATION',
    reason: 'no committed clip and no explicit scene-local authorization; create the first clip through the project composer.',
  };
}
