/**
 * Scene-local generation decision helpers (STEP-8EN).
 *
 * Pure, browser-free logic for the scene-CREATION and scene-LOCAL-generation paths.
 * 8EM proved the project-level path (`generateProjectVideo`) produces a library artifact that
 * is never bound to a scene, while the scene builder owns its own prompt box + generate control.
 * These helpers encode the safety rules for that path so they are unit-testable offline.
 */
import { isFlowSceneId, normalizeExtractedArtifactUuid } from './videoDecisions.js';
import type { SceneLocalAuthorization } from './sceneGenerationPolicy.js';

/** Marker for the scene-local generate control (scoped, never the global surface-ambiguous one). */
export const SCENE_LOCAL_GENERATE_CONTROLS = {
  sceneBuilder: 'flow-scene-builder',
  promptBox: 'flow-base-prompt-box',
  composer: 'flow-rich-text-editor.prompt-input',
  proseMirror: '.ProseMirror',
  /**
   * The EDITABLE subset of the same element. Flow exposes a non-editable
   * `contenteditable="false"` ProseMirror alongside the real editor, so the editable form is the
   * only one that may be filled. Used as a scoped, fail-fast precondition before enumeration.
   */
  proseMirrorEditable: ".ProseMirror[contenteditable='true']",
  generateButtonHost: 'flow-generate-icon-button',
  generateButton: "flow-generate-icon-button button[aria-label='Start generation']",
  timeline: 'flow-scene-timeline',
  thumbnailStrip: 'flow-thumbnail-strip',
  settingsTrigger: 'button.settings-trigger-button',
} as const;

/** The scene-creation entry discovered live in 8EN (non-generative). */
export const SCENE_CREATE_MENU = {
  addMediaMenu: "button[aria-label='Add media menu']",
  newSceneItem: 'play_movies New scene',
} as const;

/**
 * Reject the GLOBAL, surface-ambiguous generate selector.
 * 8EM proved `button[aria-label='Start generation']` matches BOTH the project composer and the
 * scene builder; using it alone risks generating on the wrong surface. The scene-local path must
 * be scoped to `flow-generate-icon-button` *inside* the scene builder.
 */
export function isSceneLocalGenerateSelector(selector: unknown): boolean {
  const s = String(selector ?? '');
  return /flow-generate-icon-button/i.test(s);
}

/** Decide whether to REUSE an existing Flow scene or CREATE a new one (never duplicates). */
export function decideSceneExistence(input: { matchingSceneIds?: unknown; localClipValid?: unknown }): { action: 'REUSE'; sceneId: string } | { action: 'CREATE' } | { action: 'AMBIGUOUS'; count: number } {
  const ids = (Array.isArray(input.matchingSceneIds) ? input.matchingSceneIds : []).map((x) => String(x ?? '').trim()).filter(Boolean);
  if (ids.length > 1) return { action: 'AMBIGUOUS', count: ids.length };
  if (ids.length === 1) return { action: 'REUSE', sceneId: ids[0] };
  return { action: 'CREATE' };
}

/** The pipeline's authoritative scene prompt field name (8EK defect: wrong casing broke it). */
export const SCENE_PROMPT_FIELDS = { dialogue: 'animation_prompt_WITH_lipsync', narrator: 'animation_prompt_NARRATOR_ONLY' } as const;

/** Resolve the scene prompt from the pipeline record using the EXACT field names. */
export function resolveScenePrompt(scene: any): { field: string; prompt: string } | { field: null; prompt: '' } {
  const narrator = scene?.speaker === 'NARRATOR' || scene?.speaker === 'none';
  const field = narrator ? SCENE_PROMPT_FIELDS.narrator : SCENE_PROMPT_FIELDS.dialogue;
  const prompt = String(scene?.[field] ?? '').trim();
  return prompt ? { field, prompt } : { field: null, prompt: '' };
}

/** Required scene-generation settings (mirrors REQUIRED_VIDEO_CONFIG). */
export const REQUIRED_SCENE_SETTINGS = { model: 'Omni 1.1 Flash', resolution: '720p', duration: '8s', aspect: '16:9', batch: 'x1' } as const;

/** Verify observed settings match the required contract exactly. */
export function verifySceneSettings(observed: Partial<Record<'model' | 'resolution' | 'duration' | 'aspect' | 'batch', unknown>> | undefined | null): { ok: true } | { ok: false; reason: string } {
  if (!observed || typeof observed !== 'object') return { ok: false, reason: 'Scene settings were not observed.' };
  for (const [key, want] of Object.entries(REQUIRED_SCENE_SETTINGS)) {
    const got = String((observed as any)[key] ?? '').trim();
    if (got !== want) return { ok: false, reason: `Scene setting ${key}="${got}" != required "${want}".` };
  }
  return { ok: true };
}

export interface ScenePreGenerationDecision {
  sceneNumber: number;
  sceneExists: boolean;
  localClipValid: boolean;
  committedClipPresent: boolean;
  nativeCharacterVerified: boolean;
  nativeBackgroundVerified: boolean;
  promptVerified: boolean;
  settingsVerified: boolean;
  generationAuthorized: boolean;
  generationAttempts: number;
}

/**
 * The CREDIT GUARD. Generation may proceed ONLY when every precondition is true and no attempt
 * has been made. Any false value → refuse (fail closed, never spend a credit).
 */
export function canGenerateScene(d: ScenePreGenerationDecision): { ok: true } | { ok: false; reason: string } {
  if (!d) return { ok: false, reason: 'No pre-generation decision was supplied.' };
  if (d.generationAttempts > 0) return { ok: false, reason: `Generation already attempted (${d.generationAttempts}); refusing a second click.` };
  if (d.localClipValid === true) return { ok: false, reason: 'A valid local clip already exists; generation is unnecessary.' };
  if (d.committedClipPresent === true) return { ok: false, reason: 'The scene already has a committed Flow clip; download instead of generating.' };
  const missing = (['sceneExists', 'nativeCharacterVerified', 'nativeBackgroundVerified', 'promptVerified', 'settingsVerified', 'generationAuthorized'] as const).filter((k) => d[k] !== true);
  if (missing.length) return { ok: false, reason: `Generation preconditions not satisfied: ${missing.join(', ')}.` };
  return { ok: true };
}

/**
 * DEDICATED credit guard for an EXPLICITLY AUTHORIZED scene-local extension/regeneration.
 *
 * This is deliberately separate from `canGenerateScene()`: that guard must keep refusing a scene
 * with `committedClipPresent: true` because an ordinary scene-local generation must never overwrite
 * a committed clip. Here the committed clip is the required STARTING POINT, so the dedicated guard
 * accepts it only when the operator supplied an exact authorization binding to that same scene and
 * that same committed clip.
 *
 * It never infers authorization from scene existence, a URL, a committed artifact, or the
 * run-level `allowGeneration` flag. Every precondition fails closed.
 */
export interface AuthorizedSceneLocalGuardInput {
  sceneNumber: number;
  prompt: string;
  ingredients: { charactersPresent: boolean; backgroundPresent: boolean };
  settingsVerified: boolean;
  generationAuthorized: boolean;
  generationAttempts: number;
  localClipValid: boolean;
  committedClipPresent: boolean;
  sceneExists: boolean;
  /** The exact target scene id the lifecycle is about to open. */
  targetSceneId: string;
  /** The exact committed clip id observed on that target before any generation. */
  observedCommittedClipId: string;
  authorization: SceneLocalAuthorization | null | undefined;
}

export function canGenerateAuthorizedSceneLocal(d: AuthorizedSceneLocalGuardInput): { ok: true } | { ok: false; reason: string } {
  if (!d) return { ok: false, reason: 'No authorized scene-local decision was supplied.' };
  if (!d.authorization || typeof d.authorization !== 'object') {
    return { ok: false, reason: 'Scene-local generation requires an explicit EXTEND/REGENERATE authorization.' };
  }
  if (d.authorization.operation !== 'EXTEND' && d.authorization.operation !== 'REGENERATE') {
    return { ok: false, reason: `Scene-local authorization operation ${JSON.stringify((d.authorization as any).operation)} is not EXTEND or REGENERATE.` };
  }
  if (!Number.isInteger(Number(d.sceneNumber)) || Number(d.sceneNumber) <= 0) {
    return { ok: false, reason: 'Scene-local generation requires a positive scene number.' };
  }
  if (d.generationAttempts > 0) return { ok: false, reason: `Generation already attempted (${d.generationAttempts}); refusing a second click.` };
  if (d.localClipValid === true) return { ok: false, reason: 'A valid local clip already exists; refusing to overwrite it with scene-local generation.' };
  if (d.committedClipPresent !== true) {
    return { ok: false, reason: 'Scene-local generation requires the exact committed clip it is authorized to replace.' };
  }
  if (d.sceneExists !== true) return { ok: false, reason: 'Scene-local generation requires an existing canonical scene.' };
  if (d.ingredients?.charactersPresent !== true || d.ingredients?.backgroundPresent !== true) {
    return { ok: false, reason: 'Scene-local generation requires verified character and background ingredients.' };
  }
  if (String(d.prompt ?? '').trim() === '') return { ok: false, reason: 'Scene-local generation requires a non-empty prompt.' };
  if (d.settingsVerified !== true) return { ok: false, reason: 'Scene-local generation requires verified project/scene settings.' };
  if (d.generationAuthorized !== true) return { ok: false, reason: 'Scene-local generation requires explicit run-level generation permission.' };

  const authorizedTarget = String(d.authorization.targetSceneId ?? '').trim();
  if (!authorizedTarget || !isFlowSceneId(authorizedTarget)) {
    return { ok: false, reason: 'Scene-local authorization has no stable target scene id.' };
  }
  const observedTarget = String(d.targetSceneId ?? '').trim();
  if (!observedTarget || observedTarget !== authorizedTarget) {
    return { ok: false, reason: `Scene-local target ${JSON.stringify(observedTarget)} does not match the authorized target ${JSON.stringify(authorizedTarget)}.` };
  }

  const expectedClip = normalizeExtractedArtifactUuid(d.authorization.expectedCommittedClipId);
  if (!expectedClip) return { ok: false, reason: 'Scene-local authorization has no valid expected committed clip id.' };
  const observedClip = normalizeExtractedArtifactUuid(d.observedCommittedClipId);
  if (!observedClip) return { ok: false, reason: 'The target scene has no valid observed committed clip id.' };
  if (observedClip !== expectedClip) {
    return { ok: false, reason: `Scene-local observed committed clip ${observedClip} does not match the authorized clip ${expectedClip}.` };
  }
  return { ok: true };
}

/** Commit classification from structural evidence (8EF/8EG) + fresh reloads. */
export type SceneCommitClassification = 'COMMITTED' | 'NOT_COMMITTED' | 'AMBIGUOUS' | 'INVALID';

export function classifySceneCommit(evidence: {
  editorLoaded?: unknown;
  clipCount?: unknown;
  thumbnailStripFrames?: unknown;
  freshReloadClipCounts?: unknown;
} | undefined | null): SceneCommitClassification {
  if (!evidence || typeof evidence !== 'object') return 'INVALID';
  if (evidence.editorLoaded !== true) return 'INVALID';
  const clips = Number(evidence.clipCount);
  const frames = Number(evidence.thumbnailStripFrames);
  if (!Number.isFinite(clips) || clips < 0) return 'INVALID';
  const reloads = Array.isArray(evidence.freshReloadClipCounts) ? evidence.freshReloadClipCounts : [];
  const reloadsOk = reloads.length > 0 && reloads.every((c) => Number(c) >= 1);
  const structural = clips >= 1 && Number.isFinite(frames) && frames > 0;
  if (structural && reloadsOk) return 'COMMITTED';
  if (!structural && reloads.every((c) => Number(c) === 0)) return 'NOT_COMMITTED';
  if (structural !== reloadsOk) return 'AMBIGUOUS';
  return 'AMBIGUOUS';
}

// ---------------------------------------------------------------------------------------
// Composer ingredient EVIDENCE (pure) — resolved from the PROVEN live DOM identity model
// ---------------------------------------------------------------------------------------
//
// PROVEN live DOM (no guessing):
//   flow-ingredient-bar.prompt-ingredient-bar
//     -> flow-ingredient-chip -> flow-image-ingredient-chip
//       -> button.chip-container[aria-label="Ingredient"] -> img.chip-image[src]
//   The chip's `img.chip-image[src]` is `https://flow-content.google/image/<UUID>?<signed query>`.
//   The SAME media appears in the navigation rail as
//     button.thumbnail-button[aria-label="<TAG>"] -> img.thumbnail-image[src=".../image/<UUID>?..."]
//   The STABLE identity is the URL PATHNAME final segment (the media UUID); signed query params
//   are ephemeral and MUST be ignored.
//
// ---------------------------------------------------------------------------------------
// Prompt-editor resolution (PURE, fail-closed) — DOM editability, never positional guessing
// ---------------------------------------------------------------------------------------

/**
 * One observed prompt-editor candidate inside the scene-local `flow-base-prompt-box`.
 *
 * WHY THIS EXISTS (live-proven): `flow-base-prompt-box .ProseMirror` can match MULTIPLE elements,
 * and `.first()` resolved a `<div class="ProseMirror" contenteditable="false">` that cannot be
 * filled — which aborted generation with `locator.fill: Element is not an <input>…`. The real
 * editor is identified by DOM EDITABILITY, never by position.
 *
 * A candidate is eligible only when it exists, is visible, is genuinely editable
 * (`contenteditable="true"`), and is neither `aria-readonly="true"` nor disabled.
 */
export interface PromptEditorCandidate {
  /** DOM order index among all `.ProseMirror` nodes in the prompt box. */
  index: number;
  exists: boolean;
  visible: boolean;
  /** `contenteditable="true"` (case-insensitive). `contenteditable="false"` is NEVER editable. */
  editable: boolean;
  ariaReadonly: boolean;
  disabled: boolean;
}

export type PromptEditorResolutionCode = 'PROMPT_EDITOR_NOT_FOUND' | 'PROMPT_EDITOR_NOT_EDITABLE';

export interface PromptEditorResolution {
  ok: boolean;
  code?: PromptEditorResolutionCode;
  reason?: string;
  /** The chosen candidate's DOM index. Present only when `ok`. */
  index?: number;
  /** How many candidates were eligible. */
  eligibleCount?: number;
  /** How many candidates were inspected. */
  totalCandidates?: number;
}

/**
 * PURE: is this candidate a valid fill target? Rejects missing, hidden, non-editable,
 * aria-readonly and disabled elements. `contenteditable="false"` is explicitly NOT editable.
 */
export function isEligiblePromptEditor(candidate: PromptEditorCandidate | null | undefined): boolean {
  if (!candidate || typeof candidate !== 'object') return false;
  return candidate.exists === true
    && candidate.visible === true
    && candidate.editable === true
    && candidate.ariaReadonly !== true
    && candidate.disabled !== true;
}

/** PURE, deterministic, fail-closed: choose THE editable prompt editor, or refuse. */
export function resolvePromptEditorCandidate(candidates: readonly PromptEditorCandidate[] | null | undefined): PromptEditorResolution {
  const all = Array.isArray(candidates) ? candidates.filter((c): c is PromptEditorCandidate => !!c) : [];
  if (all.length === 0) {
    return { ok: false, code: 'PROMPT_EDITOR_NOT_FOUND', reason: 'no ProseMirror element was found inside the scene-local prompt box.', eligibleCount: 0, totalCandidates: 0 };
  }
  const eligible = all.filter(isEligiblePromptEditor);
  if (eligible.length === 0) {
    const observed = all.map((c) => `#${c.index}{exists=${c.exists === true},visible=${c.visible === true},editable=${c.editable === true},ariaReadonly=${c.ariaReadonly === true},disabled=${c.disabled === true}}`).join(' ');
    return {
      ok: false,
      code: 'PROMPT_EDITOR_NOT_EDITABLE',
      reason: `no candidate is a visible, enabled, editable prompt editor (contenteditable="true", not aria-readonly, not disabled). Observed: ${observed}`,
      eligibleCount: 0,
      totalCandidates: all.length,
    };
  }
  // Deterministic: the lowest-index ELIGIBLE candidate. Eligibility is the selection criterion —
  // position is only the tie-breaker among candidates that already passed it, so `.first()` is
  // never the sole condition.
  const chosen = eligible.reduce((best, c) => (c.index < best.index ? c : best));
  return { ok: true, index: chosen.index, eligibleCount: eligible.length, totalCandidates: all.length };
}

/** PURE: the caller-facing failure message for an unresolved prompt editor. */
export function promptEditorRefusal(resolution: PromptEditorResolution | null | undefined): string {
  const code = String(resolution?.code ?? 'PROMPT_EDITOR_NOT_EDITABLE');
  const reason = String(resolution?.reason ?? 'no editable prompt editor could be resolved.');
  return `generateSceneVideo refused: ${code} — ${reason}`;
}

// The previous `[contenteditable="false"]` marker was WRONG (it matches the ProseMirror editor
// root) and is no longer used anywhere as ingredient evidence.

/**
 * PURE: extract the stable media identifier (final pathname segment) from a Flow media URL.
 * Query parameters are ignored entirely. Returns null for a malformed URL or a missing/invalid
 * identifier — callers must treat null as "cannot resolve" (fail closed).
 */
export function normalizeFlowMediaUuid(src: unknown): string | null {
  const raw = typeof src === 'string' ? src.trim() : '';
  if (!raw) return null;
  let pathname: string;
  try { pathname = new URL(raw).pathname; } catch { return null; }
  const seg = pathname.split('/').filter(Boolean).pop() ?? '';
  // A valid media identifier: non-empty, deterministic, alphanumeric/underscore/hyphen, >= 8 chars.
  if (!/^[A-Za-z0-9_-]{8,}$/.test(seg)) return null;
  return seg;
}

/**
 * PURE: build the rail UUID → tag identity map from the currently hydrated rail entries.
 * Fail-closed on: a uuid-bearing entry with an empty tag, or the same uuid mapping to two
 * different tags. Entries whose src has no resolvable uuid are ignored (not an error).
 */
export function buildRailAssetIdentityMap(entries: ReadonlyArray<{ tag?: unknown; src?: unknown }>): { ok: true; map: Map<string, string> } | { ok: false; reason: string } {
  const map = new Map<string, string>();
  for (const entry of entries ?? []) {
    const uuid = normalizeFlowMediaUuid(entry?.src);
    if (!uuid) continue;
    const tag = String(entry?.tag ?? '').trim();
    if (!tag) return { ok: false, reason: `rail entry for media ${uuid} has an empty tag.` };
    const existing = map.get(uuid);
    if (existing !== undefined && existing !== tag) {
      return { ok: false, reason: `rail media ${uuid} maps to conflicting tags ${JSON.stringify(existing)} and ${JSON.stringify(tag)}.` };
    }
    map.set(uuid, tag);
  }
  return { ok: true, map };
}

export type ChipResolutionState = 'RESOLVED' | 'IDENTITY_UNRESOLVED' | 'INVALID';

export interface ChipResolution {
  state: ChipResolutionState;
  /** Tags the rail map resolved each chip to (in chip order). */
  tags: string[];
  /** Media uuids that were NOT present in the rail map (cannot be resolved). */
  unresolvedUuids: string[];
  /** Count of chips whose src was malformed / had no media uuid. */
  invalidCount: number;
  reason?: string;
}

/**
 * PURE: resolve each chip's media uuid to a tag through the rail identity map.
 * Fail-closed: a malformed chip src → INVALID; a chip uuid absent from the rail map →
 * IDENTITY_UNRESOLVED. Never guesses a tag from a uuid alone.
 */
export function resolveIngredientChipTags(chipSrcs: readonly string[], railMap: Map<string, string> | undefined | null): ChipResolution {
  if (!(railMap instanceof Map)) return { state: 'INVALID', tags: [], unresolvedUuids: [], invalidCount: 0, reason: 'rail identity map is unavailable.' };
  const tags: string[] = [];
  const unresolvedUuids: string[] = [];
  let invalidCount = 0;
  for (const src of chipSrcs ?? []) {
    const uuid = normalizeFlowMediaUuid(src);
    if (!uuid) { invalidCount += 1; continue; }
    const tag = railMap.get(uuid);
    if (tag === undefined) { unresolvedUuids.push(uuid); continue; }
    tags.push(tag);
  }
  if (invalidCount > 0 || unresolvedUuids.length > 0) {
    const reason = invalidCount > 0
      ? `${invalidCount} chip(s) have a malformed media src.`
      : `${unresolvedUuids.length} chip media uuid(s) are absent from the rail identity map.`;
    return { state: 'IDENTITY_UNRESOLVED', tags, unresolvedUuids, invalidCount, reason };
  }
  return { state: 'RESOLVED', tags, unresolvedUuids: [], invalidCount: 0 };
}

// ---------------------------------------------------------------------------------------
// CHARACTER ingredient identity (proven live): chip `flow-character-ingredient-chip` and the
// character picker row share an opaque `lh3.googleusercontent.com/asb/<TOKEN>` image URL. The
// TOKEN is a SESSION-derived key: it is re-read from the picker every verification session and is
// NEVER persisted. `/image/<uuid>` is a BACKGROUND identity and is NOT a character token.
// ---------------------------------------------------------------------------------------

/**
 * PURE: extract the opaque character token from an `/asb/<TOKEN>` image URL.
 * Query parameters are ignored. Returns null for a malformed URL, a non-`/asb/` path
 * (so `/image/<uuid>` is rejected), or an empty/invalid token.
 */
export function normalizeFlowCharacterToken(src: unknown): string | null {
  const raw = typeof src === 'string' ? src.trim() : '';
  if (!raw) return null;
  let pathname: string;
  try { pathname = new URL(raw).pathname; } catch { return null; }
  if (!pathname.startsWith('/asb/')) return null;
  const seg = pathname.slice('/asb/'.length).split('/').filter(Boolean).pop() ?? '';
  if (!/^[A-Za-z0-9_-]{8,}$/.test(seg)) return null;
  return seg;
}

/**
 * A character's identity as observed on the PICKER ROW immediately before selection.
 * `token` is the `/asb/<TOKEN>` opaque token — a SAME-SESSION comparison key only.
 */
export interface CharacterSelectionIdentity {
  tag: string;
  token: string;
}

/**
 * TRANSIENT selection-time transaction evidence for ONE character attachment.
 * This is never persisted (not to pipeline.json, checkpoints, scene metadata or project state).
 */
export type CharacterAttachmentCode =
  | 'CHARACTER_ATTACHMENT_VERIFIED'
  | 'CHARACTER_ATTACHMENT_IDENTITY_MISMATCH'
  | 'CHARACTER_ATTACHMENT_CHIP_MISSING'
  | 'CHARACTER_ATTACHMENT_IDENTITY_UNREADABLE'
  | 'CHARACTER_PICKER_IDENTITY_UNAVAILABLE';

export interface CharacterAttachmentEvidence {
  expectedTag: string;
  pickerToken: string | null;
  chipToken: string | null;
  verified: boolean;
  code: CharacterAttachmentCode;
  reason?: string;
  /** Read-only per-step picker diagnostics (bounded; no persistence). */
  diagnostics?: CharacterPickerStepDiagnostic[];
}

/**
 * PURE: accept EITHER a raw `/asb/<token>` URL OR an already-normalized bare token.
 * Returns the normalized token, or null when the value is neither. This lets callers pass a raw
 * `src` (from the DOM) or a token that was already normalized (e.g. by `readCharacterChipTokens`).
 */
export function resolveCharacterToken(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const fromUrl = normalizeFlowCharacterToken(s);
  if (fromUrl) return fromUrl;
  return /^[A-Za-z0-9_-]{8,}$/.test(s) ? s : null;
}

/**
 * PURE: per-step, read-only diagnostic for the bounded character-picker identity lookup.
 * Serializable and free of tokens beyond what is already public in the DOM.
 */
export interface CharacterPickerStepDiagnostic {
  step: number;
  pickerOpen: boolean;
  addIngredientsVisible: boolean;
  charactersCategoryVisible: boolean;
  charactersCategoryActive: boolean;
  renderedRowCount: number;
  renderedTags: string[];
  expectedTagFound: boolean;
  tokenReadable: boolean;
}

export type CharacterPickerDiagnosis =
  | 'PICKER_NOT_OPEN'
  | 'CATEGORY_NOT_ACTIVE'
  | 'NO_ROWS_RENDERED'
  | 'TITLE_EMPTY'
  | 'EXPECTED_TAG_ABSENT'
  | 'TOKEN_UNREADABLE'
  | 'RESOLVED'
  | 'UNKNOWN';

/**
 * PURE: classify ONE bounded-step observation into a concrete picker state. Used only for
 * diagnostics — it never changes selection or verification behaviour.
 */
export function classifyCharacterPickerDiagnostic(step: CharacterPickerStepDiagnostic | undefined | null): CharacterPickerDiagnosis {
  if (!step || typeof step !== 'object') return 'UNKNOWN';
  if (!step.pickerOpen) return 'PICKER_NOT_OPEN';
  if (!step.charactersCategoryVisible || !step.charactersCategoryActive) return 'CATEGORY_NOT_ACTIVE';
  if (!Number.isFinite(step.renderedRowCount) || step.renderedRowCount <= 0) return 'NO_ROWS_RENDERED';
  const tags = Array.isArray(step.renderedTags) ? step.renderedTags : [];
  if (tags.length > 0 && tags.every((t) => !String(t ?? '').trim())) return 'TITLE_EMPTY';
  if (step.expectedTagFound) return step.tokenReadable ? 'RESOLVED' : 'TOKEN_UNREADABLE';
  return 'EXPECTED_TAG_ABSENT';
}

/**
 * PURE: verify ONE character attachment transaction.
 *
 * The picker ROW tag establishes WHICH expected character was selected; the token comparison
 * establishes that the inserted chip corresponds to that exact picker asset — both within the
 * SAME session. Flow removes an already-attached character from the picker, so this is the ONLY
 * valid verification sequence: capture before the click, compare immediately after.
 */
export function verifyCharacterAttachmentSelection(input: {
  expectedTag?: unknown;
  pickerTag?: unknown;
  pickerToken?: unknown;
  chipToken?: unknown;
  diagnostics?: readonly CharacterPickerStepDiagnostic[];
}): CharacterAttachmentEvidence {
  const expectedTag = String(input?.expectedTag ?? '').trim();
  const pickerTag = String(input?.pickerTag ?? '').trim();
  const pickerRaw = input?.pickerToken == null ? null : String(input.pickerToken);
  const chipRaw = input?.chipToken == null ? null : String(input.chipToken);
  const pickerToken = resolveCharacterToken(pickerRaw);
  const chipToken = resolveCharacterToken(chipRaw);
  const diagnostics = Array.isArray(input?.diagnostics) ? input!.diagnostics!.slice(0, 64) : undefined;
  const base = { expectedTag, pickerToken, chipToken, ...(diagnostics ? { diagnostics } : {}) };
  if (!expectedTag) return { ...base, verified: false, code: 'CHARACTER_ATTACHMENT_IDENTITY_UNREADABLE', reason: 'expected character tag is empty.' };
  if (!pickerTag || pickerTag !== expectedTag) {
    return { ...base, verified: false, code: 'CHARACTER_PICKER_IDENTITY_UNAVAILABLE', reason: `picker tag ${JSON.stringify(pickerTag)} does not equal the expected tag ${JSON.stringify(expectedTag)}.` };
  }
  if (pickerRaw != null && !pickerToken) return { ...base, verified: false, code: 'CHARACTER_ATTACHMENT_IDENTITY_UNREADABLE', reason: 'the picker row token is malformed.' };
  if (!pickerToken) return { ...base, verified: false, code: 'CHARACTER_PICKER_IDENTITY_UNAVAILABLE', reason: 'the picker row exposed no /asb/ token.' };
  if (chipRaw == null) return { ...base, verified: false, code: 'CHARACTER_ATTACHMENT_CHIP_MISSING', reason: 'no inserted character chip was observed after the selection.' };
  if (!chipToken) return { ...base, verified: false, code: 'CHARACTER_ATTACHMENT_IDENTITY_UNREADABLE', reason: 'the inserted character chip token is malformed.' };
  if (pickerToken !== chipToken) return { ...base, verified: false, code: 'CHARACTER_ATTACHMENT_IDENTITY_MISMATCH', reason: 'the inserted chip token does not match the picker row token.' };
  return { ...base, verified: true, code: 'CHARACTER_ATTACHMENT_VERIFIED' };
}

/**
 * PURE: verify the WHOLE character attachment set from per-selection transaction evidence.
 * Exactly one verified transaction per expected character; no duplicates, no unexpected.
 */
export function verifyCharacterAttachmentSet(expectedTags: readonly string[], evidence: readonly CharacterAttachmentEvidence[] | undefined | null): { ok: true } | { ok: false; code: CharacterAttachmentCode; reason: string } {
  const expected = (expectedTags ?? []).map((t) => String(t ?? '').trim()).filter(Boolean);
  if (expected.length === 0) return { ok: true };
  const list = Array.isArray(evidence) ? evidence : [];
  const verifiedTags = list.filter((e) => e && e.verified === true).map((e) => String(e.expectedTag ?? '').trim()).filter(Boolean);
  const counts = new Map<string, number>();
  for (const tag of verifiedTags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const missing = expected.filter((t) => (counts.get(t) ?? 0) === 0);
  const duplicates = expected.filter((t) => (counts.get(t) ?? 0) > 1);
  if (missing.length > 0) return { ok: false, code: 'CHARACTER_ATTACHMENT_CHIP_MISSING', reason: `missing verified character attachment(s): ${missing.join(', ')}.` };
  if (duplicates.length > 0) return { ok: false, code: 'CHARACTER_ATTACHMENT_IDENTITY_MISMATCH', reason: `duplicate character attachment transaction(s): ${duplicates.join(', ')}.` };
  // Unexpected verified transactions are NOT rejected here: they are surfaced by the classifier's
  // `unexpected` computation so the verdict is UNEXPECTED (not IDENTITY_UNRESOLVED).
  return { ok: true };
}

/** Evidence read (read-only) from the scene surface: raw chip srcs + currently hydrated rail entries. */
export interface ComposerIngredientEvidence {
  /** BACKGROUND `img.chip-image[src]` for every `flow-image-ingredient-chip`. */
  chipSrcs: string[];
  /** Currently hydrated rail entries: `button.thumbnail-button[aria-label]` ↔ `img.thumbnail-image[src]`. */
  railEntries: Array<{ tag: string; src: string }>;
  /** CHARACTER `img.chip-image[src]` for every `flow-character-ingredient-chip`. */
  characterChipSrcs?: string[];
  /**
   * TRANSIENT selection-time transaction evidence for each attached character. This is produced by
   * the selection transaction itself and is NEVER persisted.
   */
  characterAttachmentEvidence?: CharacterAttachmentEvidence[];
}

export type IngredientEvidenceState = 'EXACT' | 'MISSING' | 'DUPLICATE' | 'UNEXPECTED' | 'IDENTITY_UNRESOLVED' | 'INVALID';

export interface IngredientEvidenceDecision {
  state: IngredientEvidenceState;
  expected: string[];
  resolvedTags: string[];
  missing: string[];
  duplicates: string[];
  unexpected: string[];
  unresolvedUuids: string[];
  charactersPresent: boolean;
  backgroundPresent: boolean;
  reason?: string;
}

/**
 * PURE: classify composer ingredient evidence against the EXACT expected tags.
 *
 * Resolution: chip src → media uuid → rail uuid→tag map. A chip whose uuid is not in the rail map
 * is IDENTITY_UNRESOLVED (never guessed). A malformed rail map or chip src is INVALID. Only a fully
 * RESOLVED set is classified EXACT/MISSING/DUPLICATE/UNEXPECTED.
 *
 * CHARACTER SAFETY: there is NO character-specific identity rule. A character expected tag passes
 * only if the rail map genuinely maps its chip uuid to that exact tag; otherwise it is MISSING or
 * IDENTITY_UNRESOLVED and the verdict fails closed.
 */
export function classifyIngredientEvidence(expected: readonly string[], evidence: ComposerIngredientEvidence | undefined | null): IngredientEvidenceDecision {
  const expectedList = (expected ?? []).map((t) => String(t ?? '').trim()).filter(Boolean);
  const base = { expected: expectedList, resolvedTags: [] as string[], missing: [] as string[], duplicates: [] as string[], unexpected: [] as string[], unresolvedUuids: [] as string[], charactersPresent: false, backgroundPresent: false };
  if (!evidence || !Array.isArray(evidence.chipSrcs) || !Array.isArray(evidence.railEntries)) {
    return { state: 'INVALID', ...base, reason: 'ingredient evidence is malformed.' };
  }

  // ---- BACKGROUND (proven): chip src -> media uuid -> rail uuid->tag map ----
  const rail = buildRailAssetIdentityMap(evidence.railEntries);
  if (!rail.ok) return { state: 'INVALID', ...base, reason: rail.reason };
  const bgResolution = resolveIngredientChipTags(evidence.chipSrcs, rail.map);
  if (bgResolution.state !== 'RESOLVED') {
    return { state: bgResolution.state === 'INVALID' ? 'INVALID' : 'IDENTITY_UNRESOLVED', ...base, resolvedTags: bgResolution.tags, unresolvedUuids: bgResolution.unresolvedUuids, reason: bgResolution.reason };
  }

  // ---- CHARACTER (selection-time transaction evidence) ----
  // Flow REMOVES an already-attached character from the picker, so post-attachment picker lookup is
  // architecturally invalid. Character identity comes ONLY from the per-selection transaction
  // evidence captured immediately before/after the picker click. Never reconstructed post-hoc.
  const characterChipSrcs = Array.isArray(evidence.characterChipSrcs) ? evidence.characterChipSrcs : [];
  const characterAttachmentEvidence = Array.isArray(evidence.characterAttachmentEvidence) ? evidence.characterAttachmentEvidence : [];
  const expectedCharacters = expectedList.filter((t) => t.startsWith('@'));
  void expectedCharacters;
  let characterTags: string[] = [];
  if (characterChipSrcs.length > 0) {
    // Every character chip MUST correspond to a verified selection-time transaction.
    const verified = characterAttachmentEvidence.filter((e) => e && e.verified === true);
    if (verified.length !== characterChipSrcs.length) {
      return { state: 'IDENTITY_UNRESOLVED', ...base, resolvedTags: bgResolution.tags, reason: `observed ${characterChipSrcs.length} character chip(s) but ${verified.length} verified attachment transaction(s).` };
    }
    characterTags = verified.map((e) => String(e.expectedTag ?? '').trim()).filter(Boolean);
  } else if (characterAttachmentEvidence.some((e) => e && e.verified === true)) {
    // No chip but a verified transaction claims an attachment -> inconsistent -> fail closed.
    return { state: 'IDENTITY_UNRESOLVED', ...base, resolvedTags: bgResolution.tags, reason: 'a verified character attachment transaction exists but no character chip is present.' };
  }
  // Otherwise: expected characters without a chip/transaction classify as MISSING via `counts`.

  const resolvedTags = [...bgResolution.tags, ...characterTags];
  const counts = new Map<string, number>();
  for (const tag of resolvedTags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const missing = expectedList.filter((t) => (counts.get(t) ?? 0) === 0);
  const duplicates = expectedList.filter((t) => (counts.get(t) ?? 0) > 1);
  const expectedSet = new Set(expectedList);
  const unexpected = [...counts.keys()].filter((t) => !expectedSet.has(t));
  const state: IngredientEvidenceState = missing.length > 0 ? 'MISSING'
    : duplicates.length > 0 ? 'DUPLICATE'
      : unexpected.length > 0 ? 'UNEXPECTED'
        : 'EXACT';
  const exactly = (tag: string) => (counts.get(tag) ?? 0) === 1;
  return {
    state, ...base,
    resolvedTags, missing, duplicates, unexpected,
    charactersPresent: expectedList.filter((t) => t.startsWith('@')).every(exactly),
    backgroundPresent: expectedList.filter((t) => t.startsWith('#')).every(exactly),
  };
}

/** PURE: fail-closed verdict for the composer ingredient evidence. */
export function verifyIngredientEvidence(expected: readonly string[], evidence: ComposerIngredientEvidence | undefined | null): { ok: true } | { ok: false; reason: string } {
  const d = classifyIngredientEvidence(expected, evidence);
  if (d.state === 'EXACT') return { ok: true };
  const detail = `missing=${d.missing.join(',') || '-'}, duplicates=${d.duplicates.join(',') || '-'}, unexpected=${d.unexpected.join(',') || '-'}, unresolved=${d.unresolvedUuids.join(',') || '-'}`;
  return { ok: false, reason: `scene ingredients are ${d.state}${d.reason ? ` (${d.reason})` : ''} (${detail}).` };
}
