/**
 * Flow still-image generation capability contract (browser-free).
 *
 * WHY THIS EXISTS
 * The current Flow UI exposes a deterministic image-only path ONLY when Agent is OFF
 * (standard composer → Settings trigger → Mode=Image → 16:9 / x1 / image model Nano Banana 2).
 * `flowClient.ensureImageGenerationMode()` drives that standard path. This contract lets the
 * runner gate background generation on that capability and fail closed with an explicit,
 * machine-readable blocked state if the capability is ever unavailable (e.g. a future UI
 * regression), instead of a raw selector timeout or an unsafe guess.
 *
 * Agent-mediated generation is NOT an acceptable substitute and is NEVER selected by
 * this contract.
 *
 * PURITY
 * No Playwright, no filesystem, no network, no Flow calls. Deterministic types/helpers only.
 */

/**
 * Machine-readable reason: the current Flow UI exposes no deterministic reusable
 * still-image/background generation path. This is a PRODUCT-CAPABILITY fact, not a
 * selector failure.
 */
export const CURRENT_UI_NO_DETERMINISTIC_IMAGE_PATH = 'CURRENT_UI_NO_DETERMINISTIC_IMAGE_PATH';

/** Capability classification for reusable Flow still-image generation. */
export type FlowImageGenerationState = 'AVAILABLE' | 'UNAVAILABLE_PRODUCT_UI' | 'UNKNOWN';

export interface FlowImageGenerationCapability {
  state: FlowImageGenerationState;
  /** Machine-readable reason; null only when state === 'AVAILABLE'. */
  reason: string | null;
  /** Actionable human-readable detail. Never suggests prompting the Agent. */
  detail: string;
}

/** The blocked state code used when a background requires Flow but the capability is absent. */
export const WAITING_FOR_EXTERNAL_BACKGROUND_INPUT = 'WAITING_FOR_EXTERNAL_BACKGROUND_INPUT';

/** The EXISTING per-scene readiness state that already represents missing background input. */
export const EXTERNAL_BACKGROUND_READINESS = 'WAITING_FOR_BACKGROUND';

const UNAVAILABLE_DETAIL =
  'Reusable Flow still-image generation is unavailable in the current Flow UI. ' +
  'Provide the background asset locally (inputs/<project>/backgrounds/<tag>.png) ' +
  'or wait for a future deterministic Flow still-image action. Agent-mediated generation is disabled.';

const UNKNOWN_DETAIL =
  'Flow still-image generation capability could not be determined. Failing closed: ' +
  'supply the background locally or wait for a deterministic Flow still-image action.';

/** Explicit capability values. */
export function flowImageGenerationAvailable(): FlowImageGenerationCapability {
  return { state: 'AVAILABLE', reason: null, detail: 'A deterministic Flow still-image generation action is available.' };
}

export function flowImageGenerationUnavailableProductUi(): FlowImageGenerationCapability {
  return { state: 'UNAVAILABLE_PRODUCT_UI', reason: CURRENT_UI_NO_DETERMINISTIC_IMAGE_PATH, detail: UNAVAILABLE_DETAIL };
}

export function flowImageGenerationUnknown(): FlowImageGenerationCapability {
  return { state: 'UNKNOWN', reason: 'FLOW_IMAGE_GENERATION_CAPABILITY_UNKNOWN', detail: UNKNOWN_DETAIL };
}

/**
 * The capability of the CURRENT Flow UI. The standard (Agent-OFF) composer is a verified
 * deterministic image-only path, so this resolves to AVAILABLE. Replace THIS function's body
 * (only) if a future UI change removes that path; runner orchestration stays intact.
 */
export function currentFlowImageGenerationCapability(): FlowImageGenerationCapability {
  return flowImageGenerationAvailable();
}

/** Where an already-satisfied background comes from. */
export type BackgroundInputSource = 'CACHED' | 'SUPPLIED' | 'NONE';

export type BackgroundGenerationAction = 'REUSE_LOCAL' | 'GENERATE_FLOW' | 'WAITING_EXTERNAL_INPUT';

export type BackgroundGenerationCode =
  | 'BACKGROUND_CACHE_HIT'
  | 'BACKGROUND_SUPPLIED'
  | 'FLOW_IMAGE_GENERATION_AVAILABLE'
  | typeof WAITING_FOR_EXTERNAL_BACKGROUND_INPUT;

export interface BackgroundGenerationPlan {
  action: BackgroundGenerationAction;
  code: BackgroundGenerationCode;
  /** Machine-readable reason (only for WAITING_EXTERNAL_INPUT). */
  reason: string | null;
  detail: string;
}

/**
 * PURE, deterministic decision for one background:
 *   · a cached/supplied local asset is reused (no Flow capability required),
 *   · otherwise generation is attempted ONLY when a deterministic capability exists,
 *   · otherwise the background is blocked as an explicit external dependency.
 * It never selects an Agent-mediated fallback.
 */
export function classifyBackgroundGeneration(input: {
  local?: BackgroundInputSource | null;
  capability?: FlowImageGenerationCapability | null;
}): BackgroundGenerationPlan {
  const local: BackgroundInputSource = input?.local ?? 'NONE';
  const capability: FlowImageGenerationCapability = input?.capability ?? flowImageGenerationUnknown();

  if (local === 'CACHED') {
    return {
      action: 'REUSE_LOCAL', code: 'BACKGROUND_CACHE_HIT', reason: null,
      detail: 'A cached background PNG exists locally; no Flow generation is required.',
    };
  }
  if (local === 'SUPPLIED') {
    return {
      action: 'REUSE_LOCAL', code: 'BACKGROUND_SUPPLIED', reason: null,
      detail: 'A locally supplied background PNG exists; no Flow generation is required.',
    };
  }
  if (capability.state === 'AVAILABLE') {
    return {
      action: 'GENERATE_FLOW', code: 'FLOW_IMAGE_GENERATION_AVAILABLE', reason: null,
      detail: 'A deterministic Flow still-image generation action is available.',
    };
  }
  return {
    action: 'WAITING_EXTERNAL_INPUT',
    code: WAITING_FOR_EXTERNAL_BACKGROUND_INPUT,
    reason: capability.reason ?? 'FLOW_IMAGE_GENERATION_CAPABILITY_UNKNOWN',
    detail:
      'This background has no local asset and reusable Flow still-image generation is unavailable. ' +
      'Provide the background locally (inputs/<project>/backgrounds/<tag>.png) or wait for a future ' +
      'deterministic Flow still-image action. Agent-mediated generation is disabled.',
  };
}
