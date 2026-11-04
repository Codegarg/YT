/**
 * Flow-commitment vs local-media state (STEP-8GF).
 *
 * Makes the relationship between a scene's FLOW commitment and its LOCALLY
 * available media explicit and deterministic. This exists because a scene can be
 * committed in Flow while its local `scene-####.mp4` is absent — a legitimate
 * external-input state that must NOT be collapsed into MISSING/INVALID/FAILED and
 * must NEVER be treated as renderable.
 *
 * Pure: no filesystem, no browser, no network, no mutation.
 */

/** Explicit Flow/local relationship for one scene. */
export type FlowLocalSceneState =
  | 'FLOW_UNKNOWN'                    // no verified Flow identity AND no local clip
  | 'FLOW_NOT_COMMITTED'              // local pipeline has no evidence of a committed Flow scene (and no local clip)
  | 'FLOW_COMMITTED_LOCAL_AVAILABLE'  // verified Flow identity + valid local clip
  | 'FLOW_COMMITTED_LOCAL_MISSING'    // verified Flow identity but no valid local clip (missing OR invalid)
  | 'LOCAL_AVAILABLE_FLOW_UNKNOWN';   // valid local clip but no Flow identity recorded

export interface FlowLocalFacts {
  /** Verified Flow scene id (36-char uuid) or null/undefined when none is known. */
  flowSceneId?: string | null;
  /** Flow scene URL (may carry the id) or null/undefined. */
  flowSceneUrl?: string | null;
  /** Does a local scene-####.mp4 exist on disk? */
  localClipExists: boolean;
  /** Does the local clip pass the existing videoClip validation contract? */
  localClipValid: boolean;
}

export interface FlowLocalDecision {
  state: FlowLocalSceneState;
  hasFlowCommitment: boolean;
  hasLocalClip: boolean;
  localClipValid: boolean;
  /** ONLY a valid local clip makes a scene renderable. A Flow commitment never does. */
  renderable: boolean;
  reason: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A Flow scene id is a verified commitment ONLY when it is a well-formed uuid.
 * Malformed ids fail closed (never treated as a commitment).
 */
export function isValidFlowSceneId(id: unknown): boolean {
  return typeof id === 'string' && UUID_RE.test(id.trim());
}

/**
 * Extract a verified Flow scene id from an explicit id field OR from a Flow scene URL
 * that contains a `/(scene|edit)/<uuid>` segment. Returns null when neither yields a
 * well-formed uuid (fail closed — no inference from scene numbers/titles).
 */
export function resolveFlowSceneId(facts: { flowSceneId?: unknown; flowSceneUrl?: unknown } | undefined | null): string | null {
  const id = facts && typeof facts.flowSceneId === 'string' ? facts.flowSceneId.trim() : '';
  if (isValidFlowSceneId(id)) return id;
  const url = facts && typeof facts.flowSceneUrl === 'string' ? facts.flowSceneUrl : '';
  const m = url.match(/\/(?:scene|edit)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : null;
}

/**
 * Derive the explicit state. Deterministic and fail-closed.
 *
 * Precedence:
 *   1. verified Flow id + valid local clip   -> FLOW_COMMITTED_LOCAL_AVAILABLE   (renderable)
 *   2. verified Flow id + no valid local clip-> FLOW_COMMITTED_LOCAL_MISSING     (NOT renderable)
 *   3. no Flow id + valid local clip         -> LOCAL_AVAILABLE_FLOW_UNKNOWN      (renderable)
 *   4/5. no Flow id + no local clip          -> FLOW_UNKNOWN | FLOW_NOT_COMMITTED (NOT renderable)
 */
export function deriveFlowLocalState(facts: FlowLocalFacts | undefined | null): FlowLocalDecision {
  const f: FlowLocalFacts = facts ?? { localClipExists: false, localClipValid: false };
  const hasLocalClip = f.localClipExists === true;
  const localClipValid = f.localClipValid === true && hasLocalClip;
  const flowId = resolveFlowSceneId(f);
  const hasFlowCommitment = flowId !== null;

  if (hasFlowCommitment && localClipValid) {
    return { state: 'FLOW_COMMITTED_LOCAL_AVAILABLE', hasFlowCommitment: true, hasLocalClip, localClipValid: true, renderable: true, reason: `Flow scene ${flowId} is committed and a valid local clip is available.` };
  }
  if (hasFlowCommitment) {
    const reason = hasLocalClip
      ? `Flow scene ${flowId} is committed but the local clip exists yet FAILS validation.`
      : `Flow scene ${flowId} is committed but no locally available scene clip exists.`;
    return { state: 'FLOW_COMMITTED_LOCAL_MISSING', hasFlowCommitment: true, hasLocalClip, localClipValid: false, renderable: false, reason };
  }
  if (localClipValid) {
    return { state: 'LOCAL_AVAILABLE_FLOW_UNKNOWN', hasFlowCommitment: false, hasLocalClip: true, localClipValid: true, renderable: true, reason: 'A valid local clip exists but no verified Flow scene identity is recorded.' };
  }
  if (hasLocalClip) {
    return { state: 'FLOW_UNKNOWN', hasFlowCommitment: false, hasLocalClip: true, localClipValid: false, renderable: false, reason: 'A local clip exists but fails validation and no verified Flow identity is recorded.' };
  }
  return { state: 'FLOW_NOT_COMMITTED', hasFlowCommitment: false, hasLocalClip: false, localClipValid: false, renderable: false, reason: 'No Flow commitment and no local clip.' };
}

/** True only when the state permits local rendering. */
export function isFlowLocalRenderable(state: unknown): boolean {
  return state === 'FLOW_COMMITTED_LOCAL_AVAILABLE' || state === 'LOCAL_AVAILABLE_FLOW_UNKNOWN';
}

/** True when a scene is committed in Flow but not locally usable (the Scene 15 case). */
export function isFlowCommittedLocalMissing(state: unknown): boolean {
  return state === 'FLOW_COMMITTED_LOCAL_MISSING';
}
