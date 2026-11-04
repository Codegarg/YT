/**
 * Standard-composer IMAGE-mode decisions for Google Flow (browser-free).
 *
 * The current Flow UI exposes a deterministic image-only path ONLY when Agent is OFF:
 *
 *   Agent OFF
 *     → flow-base-prompt-box (standard composer)
 *     → button[aria-label='Settings trigger']
 *     → flow-toggles[aria-label='Mode']        → Image radio
 *     → flow-toggles[aria-label='Aspect ratio'] → 16:9 radio
 *     → flow-toggles[aria-label='Output count'] → x1 radio
 *     → button[aria-label='Select model family'] → Nano Banana 2
 *     → button[aria-label='Start generation']
 *
 * This module contains ONLY pure, deterministic decisions so the adapter can be tested
 * offline. No Playwright, no DOM, no filesystem, no network, no Flow, no credits.
 */

/** The only image model family permitted for reusable background generation. */
export const REQUIRED_IMAGE_MODEL = 'Nano Banana 2';

/** Explicit, machine-readable failure codes for the standard-composer adapter. */
export type FlowImageModeErrorCode =
  | 'STANDARD_COMPOSER_UNAVAILABLE'
  | 'AGENT_MODE_DISABLE_FAILED'
  | 'IMAGE_MODE_UNAVAILABLE'
  | 'IMAGE_MODE_SELECTION_FAILED'
  | 'ASPECT_RATIO_UNAVAILABLE'
  | 'ASPECT_RATIO_SELECTION_FAILED'
  | 'OUTPUT_COUNT_UNAVAILABLE'
  | 'OUTPUT_COUNT_SELECTION_FAILED'
  | 'IMAGE_MODEL_UNAVAILABLE'
  | 'UNSUPPORTED_IMAGE_MODEL';

/**
 * Structured error carrying a machine-readable `code`. Reuses the project's existing
 * "structured code + reason" convention (see prodCheck `execution.blocked`) rather than
 * introducing a second error framework.
 */
export class FlowImageModeError extends Error {
  readonly code: FlowImageModeErrorCode;
  constructor(code: FlowImageModeErrorCode, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options as ErrorOptions);
    this.name = 'FlowImageModeError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------
// Agent toggle
// ---------------------------------------------------------------------------------------

export interface AgentToggleDecision {
  action: 'TOGGLE_OFF' | 'NONE';
  code?: FlowImageModeErrorCode;
  reason: string;
}

/** Decide whether the Agent toggle must be clicked to reach the standard composer. */
export function decideAgentToggle(input: { present: boolean; ariaPressed: string | null | undefined }): AgentToggleDecision {
  if (!input.present) {
    return { action: 'NONE', code: 'STANDARD_COMPOSER_UNAVAILABLE', reason: 'Agent mode toggle was not found; the standard composer cannot be reached.' };
  }
  const value = String(input.ariaPressed ?? '').trim();
  if (value === 'true') return { action: 'TOGGLE_OFF', reason: 'Agent mode is ON; turning it OFF to use the standard composer.' };
  if (value === 'false') return { action: 'NONE', reason: 'Agent mode is already OFF.' };
  return { action: 'NONE', code: 'AGENT_MODE_DISABLE_FAILED', reason: `Agent toggle reported an unexpected aria-pressed value (${JSON.stringify(value)}).` };
}

// ---------------------------------------------------------------------------------------
// Scoped radio groups (Mode / Aspect ratio / Output count)
// ---------------------------------------------------------------------------------------

export interface FlowRadioOption { name: string; checked: boolean }

export interface FlowRadioDecision {
  state: 'ALREADY_SELECTED' | 'SELECT_REQUIRED' | 'UNAVAILABLE';
  /** Index of the desired option within the observed list (when present). */
  index?: number;
  code?: FlowImageModeErrorCode;
  reason: string;
}

/**
 * Decide the action for a scoped radio group. The caller supplies the observed options
 * (accessible/label text + aria-checked) so this stays pure.
 * Fail-closed: a missing control or a missing required option is UNAVAILABLE.
 */
export function decideRadioGroup(input: {
  present: boolean;
  options: FlowRadioOption[];
  desired: string;
  controlLabel: string;
  unavailableCode: FlowImageModeErrorCode;
}): FlowRadioDecision {
  if (!input.present) {
    return { state: 'UNAVAILABLE', code: input.unavailableCode, reason: `${input.controlLabel} control was not found.` };
  }
  const index = input.options.findIndex((option) => String(option.name).trim() === input.desired);
  if (index < 0) {
    const available = input.options.map((option) => option.name).filter(Boolean).join('; ') || '(none)';
    return { state: 'UNAVAILABLE', code: input.unavailableCode, reason: `${input.controlLabel} does not offer the required option "${input.desired}". Available: ${available}.` };
  }
  if (input.options[index].checked) {
    return { state: 'ALREADY_SELECTED', index, reason: `${input.controlLabel} is already set to "${input.desired}".` };
  }
  return { state: 'SELECT_REQUIRED', index, reason: `${input.controlLabel} must be set to "${input.desired}".` };
}

// ---------------------------------------------------------------------------------------
// Image model family
// ---------------------------------------------------------------------------------------

/** Normalize a model trigger label ("🍌 Nano Banana 2 arrow_drop_down" → "Nano Banana 2"). */
export function normalizeModelLabel(raw: unknown): string {
  return String(raw ?? '')
    .replace(/arrow_drop_down/gi, ' ')
    .replace(/[^A-Za-z0-9. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type ImageModelDecision =
  | { ok: true; model: string; reason: string }
  | { ok: false; code: FlowImageModeErrorCode; reason: string };

/**
 * Verify the selected image model family is EXACTLY the required one. Exact equality after
 * normalization (so "Nano Banana 2 Lite" is rejected). Never selects a different model.
 */
export function decideImageModel(input: { present: boolean; text: string | null | undefined; required?: string }): ImageModelDecision {
  if (!input.present) {
    return { ok: false, code: 'IMAGE_MODEL_UNAVAILABLE', reason: 'Image model control (button[aria-label="Select model family"]) was not found.' };
  }
  const required = String(input.required ?? REQUIRED_IMAGE_MODEL);
  const model = normalizeModelLabel(input.text);
  if (model === required) return { ok: true, model, reason: `Image model is "${required}".` };
  return {
    ok: false,
    code: 'UNSUPPORTED_IMAGE_MODEL',
    reason: `Selected image model is "${model || String(input.text ?? '').trim()}" but the deterministic background path requires "${required}"; refusing to switch models.`,
  };
}
