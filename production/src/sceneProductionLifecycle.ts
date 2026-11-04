/**
 * Canonical Scene production lifecycle (project-first settings).
 *
 * PURPOSE
 * -------
 * Composes the EXISTING FlowClient primitives into one deterministic, fail-closed lifecycle for a
 * single pipeline scene:
 *
 *   PROJECT_SETTINGS → ASSET_LOCKS → SCENE_CREATE → SCENE_OPEN → ATTACH_ASSETS
 *     → VERIFY_INGREDIENTS → VERIFY_INHERITED_DISPLAY → GENERATION_GUARD → GENERATE
 *     → COMMIT → PERSIST → DOWNLOAD → VALIDATE
 *
 * It invents NO new Flow architecture: settings, scene creation, asset selection, generation,
 * persistence and download are all delegated to existing FlowClient methods. This module owns only
 * the ORDER, the fail-closed classification, and the credit-guard placement.
 *
 * WHY PROJECT-LEVEL SETTINGS (live-established)
 * ---------------------------------------------
 * Read-only live investigation established that the PROJECT composer owns the real generation
 * settings (`flow-toggles` Mode / Aspect ratio / Output count + `Select model family`), while the
 * SCENE builder exposes NO configurable generation controls — its `button.settings-trigger-button`
 * is `display:none` + `hidden=""`, its `model-chip` is an informational `div` (no role/tabindex/
 * aria-haspopup/cdkoverlayorigin), and no scene-level `flow-toggles` exist. The scene surface only
 * DISPLAYS inherited values (`model-chip` = "Omni 1.1 Flash", an "8s" summary, a "16:9" indicator).
 *
 * Therefore project settings are configured FIRST and are the explicit SOURCE OF TRUTH. The
 * scene-side observation is confirmation ONLY, and it is deliberately limited to the three values
 * the scene surface actually exposes (model / duration / aspect). `720p` and `x1` are NOT exposed
 * on the scene surface and are verified at the PROJECT level only.
 *
 * NOTE ON INHERITANCE: project→scene inheritance is strongly indicated by the live evidence but is
 * NOT directly proven here. This module therefore records the scene-side observation as evidence
 * and never asserts inheritance as fact.
 *
 * CREDIT SAFETY
 * -------------
 *   · `canGenerateScene()` (the existing credit guard) is evaluated IMMEDIATELY before the click.
 *   · EXACTLY ONE `generateSceneVideo()` call. No retry, no second candidate, no catch-and-continue.
 *   · The scene is never created if project settings fail to configure/verify.
 *   · Any failure returns a typed failure code and stops. No silent fallback, no local synthesis.
 */
import { verifyAssetLocks, readFlowSceneSurfaceAssets, resolveAssetVerificationSceneId, type AssetVerificationResult } from './assetVerification.js';
import { canGenerateScene, canGenerateAuthorizedSceneLocal, verifySceneSettings, REQUIRED_SCENE_SETTINGS, classifyIngredientEvidence, type ScenePreGenerationDecision, type ComposerIngredientEvidence, type IngredientEvidenceDecision, type CharacterAttachmentEvidence } from './sceneLocalGeneration.js';
import { deriveRoutesFromMountedSceneUrl, isFlowSceneId, normalizeExtractedArtifactUuid } from './videoDecisions.js';
import type { SceneLocalAuthorization } from './sceneGenerationPolicy.js';

// ---------------------------------------------------------------------------------------
// Failure codes (each phase has its OWN code — never collapsed into a generic error)
// ---------------------------------------------------------------------------------------

export type SceneLifecycleFailureCode =
  | 'PROJECT_VIDEO_SETTINGS_NOT_READY'
  | 'ASSET_LOCKS_NOT_VERIFIED'
  | 'TARGET_SCENE_INVALID'
  | 'TARGET_SCENE_AMBIGUOUS'
  | 'SCENE_CREATE_FAILED'
  | 'SCENE_ID_UNAVAILABLE'
  | 'SCENE_OPEN_FAILED'
  | 'INGREDIENTS_NOT_READY'
  | 'SCENE_INHERITED_SETTINGS_MISMATCH'
  | 'GENERATION_GUARD_FAILED'
  | 'GENERATION_FAILED'
  | 'CLIP_NOT_COMMITTED'
  | 'CLIP_PERSISTENCE_FAILED'
  | 'DOWNLOAD_FAILED'
  | 'DOWNLOADED_CLIP_INVALID';

/** The explicit, ordered phases. Exported so tests can assert the sequence. */
export const SCENE_LIFECYCLE_PHASES = [
  'PROJECT_SETTINGS', 'ASSET_LOCKS', 'SCENE_CREATE', 'SCENE_OPEN', 'ATTACH_ASSETS',
  'VERIFY_INGREDIENTS', 'VERIFY_INHERITED_DISPLAY', 'GENERATION_GUARD', 'GENERATE',
  'COMMIT', 'PERSIST', 'DOWNLOAD', 'VALIDATE',
] as const;
/**
 * `TARGET_SCENE` is a PREFLIGHT phase used only when an optional existing target is supplied and
 * cannot be resolved unambiguously. It is not part of {@link SCENE_LIFECYCLE_PHASES}, so the
 * canonical new-scene phase list remains byte-identical.
 */
export type SceneLifecyclePhase = typeof SCENE_LIFECYCLE_PHASES[number] | 'TARGET_SCENE';

/** Non-fatal classification of the scene-side inherited-display observation. */
export type InheritedDisplayStatus = 'SCENE_INHERITED_SETTINGS_MATCH' | 'SCENE_INHERITED_SETTINGS_UNOBSERVABLE';

// ---------------------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------------------

export interface ProjectVideoSettingsObservation {
  mode?: unknown; model?: unknown; resolution?: unknown; duration?: unknown; aspect?: unknown; batch?: unknown;
}

/**
 * PURE: verify the PROJECT-level video settings against the required contract.
 * Mode is checked here because the existing `verifySceneSettings()` contract covers only
 * model/resolution/duration/aspect/batch; the rest is delegated so there is ONE field rule.
 */
export function verifyProjectVideoSettings(observed: ProjectVideoSettingsObservation | undefined | null): { ok: true } | { ok: false; reason: string } {
  if (!observed || typeof observed !== 'object') return { ok: false, reason: 'Project video settings were not observed.' };
  if (String((observed as any).mode ?? '').trim() !== 'Video') {
    return { ok: false, reason: `Project mode="${String((observed as any).mode ?? '')}" != required "Video".` };
  }
  return verifySceneSettings(observed as any);
}

export interface InheritedDisplayObservation {
  model?: string | null;
  duration?: string | null;
  aspect?: string | null;
}

export interface InheritedDisplayDecision {
  state: 'MATCH' | 'MISMATCH' | 'UNOBSERVABLE';
  status: InheritedDisplayStatus;
  /** Fields that were observed and CONTRADICT the project settings. */
  mismatches: Array<{ field: string; expected: string; observed: string }>;
  /** Fields the scene surface did not expose. */
  unobservable: string[];
}

/**
 * PURE: classify the scene-side inherited-display observation.
 *
 * ONLY the three values the scene surface actually exposes are checked: model, duration, aspect.
 * `resolution` (720p) and `batch` (x1) are deliberately EXCLUDED — they are not exposed on the
 * scene surface and remain project-level authoritative.
 *
 *   · an observed value that CONTRADICTS the expected value  → MISMATCH (fail closed)
 *   · a value the surface does not expose                    → UNOBSERVABLE (proceed, recorded)
 *   · every exposed value matches                            → MATCH (proceed)
 */
export function classifyInheritedDisplay(
  observed: InheritedDisplayObservation | undefined | null,
  expected: { model: string; duration: string; aspect: string },
): InheritedDisplayDecision {
  const fields: Array<[string, string, unknown]> = [
    ['model', expected.model, observed?.model],
    ['duration', expected.duration, observed?.duration],
    ['aspect', expected.aspect, observed?.aspect],
  ];
  const mismatches: Array<{ field: string; expected: string; observed: string }> = [];
  const unobservable: string[] = [];
  for (const [field, want, got] of fields) {
    const value = String(got ?? '').trim();
    if (!value) { unobservable.push(field); continue; }
    if (value !== want) mismatches.push({ field, expected: want, observed: value });
  }
  if (mismatches.length > 0) return { state: 'MISMATCH', status: 'SCENE_INHERITED_SETTINGS_MATCH', mismatches, unobservable };
  if (unobservable.length > 0) return { state: 'UNOBSERVABLE', status: 'SCENE_INHERITED_SETTINGS_UNOBSERVABLE', mismatches, unobservable };
  return { state: 'MATCH', status: 'SCENE_INHERITED_SETTINGS_MATCH', mismatches, unobservable };
}

// Ingredient verification uses ACTUAL attached-chip EVIDENCE (never raw prompt text). The pure
// classifier/verdict live in sceneLocalGeneration.ts so the FlowClient guard and this lifecycle
// share ONE rule — there is no second ingredient system.

export interface GenerationGuardInput {
  sceneNumber: number;
  prompt: string;
  ingredients: IngredientEvidenceDecision;
  settingsVerified: boolean;
  generationAuthorized: boolean;
  generationAttempts: number;
  localClipValid: boolean;
  committedClipPresent: boolean;
  sceneExists: boolean;
}

/** PURE: evaluate the credit guard via the EXISTING `canGenerateScene()`. */
export function evaluateGenerationGuard(input: GenerationGuardInput): { ok: true } | { ok: false; reason: string } {
  const decision: ScenePreGenerationDecision = {
    sceneNumber: Number(input.sceneNumber),
    sceneExists: input.sceneExists === true,
    localClipValid: input.localClipValid === true,
    committedClipPresent: input.committedClipPresent === true,
    nativeCharacterVerified: input.ingredients.charactersPresent === true,
    nativeBackgroundVerified: input.ingredients.backgroundPresent === true,
    promptVerified: String(input.prompt ?? '').trim().length > 0,
    settingsVerified: input.settingsVerified === true,
    generationAuthorized: input.generationAuthorized === true,
    generationAttempts: Number(input.generationAttempts ?? 0),
  };
  return canGenerateScene(decision);
}

/** PURE: download is permitted ONLY after canonical persistence is proven. */
export function decideDownloadAfterPersistence(persisted: boolean): { ok: true } | { ok: false; code: SceneLifecycleFailureCode; reason: string } {
  return persisted === true
    ? { ok: true }
    : { ok: false, code: 'CLIP_PERSISTENCE_FAILED', reason: 'The generated clip is not proven persisted on the canonical scene; refusing to download.' };
}

// ---------------------------------------------------------------------------------------
// Port (implemented by FlowClient in production; faked in tests)
// ---------------------------------------------------------------------------------------

export interface SceneLifecyclePort {
  /** Configure the PROJECT composer's video settings (authoritative). Never clicks Start. */
  configureProjectVideoSettings(): Promise<void>;
  /** Read the observed PROJECT video settings (for pure verification). */
  observeProjectVideoSettings(): Promise<Record<string, unknown>>;
  /**
   * READ-ONLY: the project's asset identities observed LIVE on a canonical Flow scene surface,
   * plus whether that surface was ACTUALLY observed.
   *
   * ASSET_LOCKS uses this INSTEAD of any caller-supplied list, so a successful-but-empty read can
   * never be mistaken for "the assets exist" and caller-supplied state can never substitute for
   * live verification. Fail-closed: `ok:false` (or a throw) blocks the lifecycle.
   */
  readFlowAssetIdentities(): Promise<{ ok: boolean; characters: readonly string[]; backgrounds: readonly string[]; reason?: string }>;
  createScene(): Promise<{ sceneId: string; url: string }>;
  openSceneEditor(sceneIdOrTitle: string): Promise<{ url: string }>;
  selectAsset(tag: string): Promise<void>;
  /**
   * Select ONE character via the picker AND verify the attachment at selection time (token
   * comparison). Returns transient transaction evidence; never reopens the picker afterwards.
   */
  selectCharacterAssetWithVerification(tag: string): Promise<CharacterAttachmentEvidence>;
  /** Read the scene composer's ACTUAL ingredient-chip EVIDENCE (never raw prompt text). Read-only. */
  readSceneComposerIngredientEvidence(): Promise<ComposerIngredientEvidence>;
  /** Read the scene surface's DISPLAYED inherited model/duration/aspect. Read-only. */
  observeSceneInheritedDisplay(): Promise<InheritedDisplayObservation>;
  generateSceneVideo(prompt: string, options: { expectedIngredients?: string[] }): Promise<{ title: string; artifactId: string }>;
  sceneHasClip(): Promise<boolean>;
  /** Canonical persistence verification (fresh /scene/<id> reads). Must NOT attach. */
  verifyScenePersistence(sceneRef: string, artifactId: string): Promise<{ committedClipId: string }>;
  downloadCommittedSceneClip(sceneNumber: number, destination: string, options?: Record<string, unknown>): Promise<{ ok: boolean; result?: string; reason?: string; meta?: any }>;
}

export interface SceneLifecycleInput {
  sceneNumber: number;
  /**
   * Optional EXISTING Flow scene id. When supplied (either this or `targetSceneUrl`, never both),
   * the lifecycle opens that exact scene and never calls `createScene()`.
   */
  targetSceneId?: string;
  /**
   * Optional EXISTING Flow scene URL. It must resolve to exactly one stable scene id. Supplying
   * both this and `targetSceneId` is ambiguous and fails closed before any Flow work.
   */
  targetSceneUrl?: string;
  prompt: string;
  backgroundTag: string;
  characterTags: readonly string[];
  destinationPath: string;
  requiredAssets: { characters: readonly string[]; backgrounds: readonly string[] };
  /**
   * @deprecated ASSET_LOCKS no longer consumes a caller-supplied asset list. Kept only for input
   * compatibility; live verification comes exclusively from `port.readFlowAssetIdentities()`.
   */
  visibleAssets: { characters: readonly string[]; backgrounds: readonly string[] };
  /** @deprecated See {@link visibleAssets}. Never trusted for asset verification. */
  readOk: boolean;
  /** @deprecated See {@link visibleAssets}. Never trusted for asset verification. */
  readReason?: string;
  generationAuthorized: boolean;
  localClipValid?: boolean;
  committedClipPresent?: boolean;
  /**
   * Explicit operator authorization for an EXTEND/REGENERATE of this exact existing scene.
   * Present ONLY on the authorized scene-local path. Ordinary lifecycle callers omit it and keep
   * the existing `canGenerateScene()` guard, which refuses a committed clip.
   */
  sceneLocalAuthorization?: SceneLocalAuthorization | null;
  /** The exact committed clip id observed on the target before the lifecycle started. */
  observedCommittedClipId?: string;
  validateDownloaded: (path: string) => Promise<{ ok: boolean; reason?: string; [k: string]: unknown }>;
  overwrite?: boolean;
  downloadOptions?: Record<string, unknown>;
}

export interface SceneLifecycleResult {
  ok: boolean;
  code?: SceneLifecycleFailureCode;
  phase?: SceneLifecyclePhase;
  reason?: string;
  sceneId?: string;
  artifactId?: string;
  committedClipId?: string;
  clipPath?: string;
  phases: SceneLifecyclePhase[];
  lockVerification?: AssetVerificationResult;
  /** Non-fatal scene-side inherited-display classification (only on a completed run). */
  inheritedDisplay?: InheritedDisplayStatus;
  projectSettings?: ProjectVideoSettingsObservation;
}

const fail = (code: SceneLifecycleFailureCode, phase: SceneLifecyclePhase, phases: SceneLifecyclePhase[], reason: string, extra: Partial<SceneLifecycleResult> = {}): SceneLifecycleResult =>
  ({ ok: false, code, phase, reason, phases, ...extra });

/**
 * Resolve the optional existing-target input WITHOUT touching Flow.
 *
 * - neither field supplied  -> create a new scene (legacy behaviour)
 * - exactly one supplied    -> resolve one stable scene id
 * - both supplied / empty / malformed / multiple scene routes -> fail closed as ambiguous/invalid
 *
 * A Flow scene URL is accepted only when it contains exactly one `/scene/<id>` or `/edit/<id>`
 * segment. Titles are never accepted as identity.
 */
function resolveExistingSceneTarget(input: SceneLifecycleInput):
  | { kind: 'new' }
  | { kind: 'existing'; sceneId: string }
  | { kind: 'invalid'; code: 'TARGET_SCENE_INVALID' | 'TARGET_SCENE_AMBIGUOUS'; reason: string } {
  const idSupplied = input.targetSceneId !== undefined && input.targetSceneId !== null;
  const urlSupplied = input.targetSceneUrl !== undefined && input.targetSceneUrl !== null;
  if (!idSupplied && !urlSupplied) return { kind: 'new' };
  if (idSupplied && urlSupplied) {
    return {
      kind: 'invalid',
      code: 'TARGET_SCENE_AMBIGUOUS',
      reason: 'both targetSceneId and targetSceneUrl were supplied; provide exactly one existing scene target.',
    };
  }

  if (idSupplied) {
    const id = typeof input.targetSceneId === 'string' ? input.targetSceneId.trim() : '';
    if (!id) return { kind: 'invalid', code: 'TARGET_SCENE_INVALID', reason: 'targetSceneId was supplied but is empty.' };
    if (!isFlowSceneId(id)) {
      return { kind: 'invalid', code: 'TARGET_SCENE_INVALID', reason: `targetSceneId "${id}" is not a stable Flow scene id.` };
    }
    return { kind: 'existing', sceneId: id };
  }

  const url = typeof input.targetSceneUrl === 'string' ? input.targetSceneUrl.trim() : '';
  if (!url) return { kind: 'invalid', code: 'TARGET_SCENE_INVALID', reason: 'targetSceneUrl was supplied but is empty.' };
  const sceneRoutes = [...url.matchAll(/\/(?:scene|edit)\/([^/?#]+)/g)].map((m) => m[1]);
  if (sceneRoutes.length > 1) {
    return {
      kind: 'invalid',
      code: 'TARGET_SCENE_AMBIGUOUS',
      reason: `targetSceneUrl contains ${sceneRoutes.length} scene routes; refusing to choose one.`,
    };
  }
  if (sceneRoutes.length === 0) {
    return { kind: 'invalid', code: 'TARGET_SCENE_INVALID', reason: `targetSceneUrl "${url}" is not a Flow scene route.` };
  }
  const derived = deriveRoutesFromMountedSceneUrl(url);
  if (!derived.ok) return { kind: 'invalid', code: 'TARGET_SCENE_INVALID', reason: derived.reason };
  if (!isFlowSceneId(derived.sceneId)) {
    return { kind: 'invalid', code: 'TARGET_SCENE_INVALID', reason: `targetSceneUrl resolved to an invalid scene id "${derived.sceneId}".` };
  }
  if (derived.sceneId !== sceneRoutes[0]) {
    return {
      kind: 'invalid',
      code: 'TARGET_SCENE_AMBIGUOUS',
      reason: `targetSceneUrl resolved to scene "${derived.sceneId}" but the route names "${sceneRoutes[0]}".`,
    };
  }
  return { kind: 'existing', sceneId: derived.sceneId };
}

/**
 * Run the canonical scene lifecycle ONCE. Deterministic, fail-closed, no retries.
 */
export async function runSceneProductionLifecycle(port: SceneLifecyclePort, input: SceneLifecycleInput): Promise<SceneLifecycleResult> {
  const phases: SceneLifecyclePhase[] = [];
  const step = <T>(phase: SceneLifecyclePhase, fn: () => Promise<T>) => { phases.push(phase); return fn(); };

  // 0. TARGET_SCENE — pure preflight. Only an explicitly supplied existing target is validated;
  //    when neither field is supplied the legacy new-scene path is byte-for-byte unchanged.
  const target = resolveExistingSceneTarget(input);
  if (target.kind === 'invalid') return fail(target.code, 'TARGET_SCENE', [], target.reason);

  // 0b. AUTHORIZED SCENE-LOCAL PREFLIGHT — before project settings, scene creation, attach, or any
  //     editor open. Authorization is only meaningful for an exact EXISTING target with an exact
  //     committed clip observation. A missing target must never silently create a new scene.
  if (input.sceneLocalAuthorization) {
    const auth = input.sceneLocalAuthorization;
    if (target.kind !== 'existing') {
      return fail('TARGET_SCENE_INVALID', 'TARGET_SCENE', [], 'scene-local authorization requires exactly one existing target scene; refusing to create a new scene.');
    }
    if (String(auth.operation ?? '').trim() !== 'EXTEND' && String(auth.operation ?? '').trim() !== 'REGENERATE') {
      return fail('TARGET_SCENE_INVALID', 'TARGET_SCENE', [], `scene-local authorization operation ${JSON.stringify((auth as any).operation)} is not EXTEND or REGENERATE.`);
    }
    if (String(auth.targetSceneId ?? '').trim() !== target.sceneId) {
      return fail('TARGET_SCENE_INVALID', 'TARGET_SCENE', [], `scene-local authorization target ${JSON.stringify(auth.targetSceneId)} does not match the resolved target ${target.sceneId}.`);
    }
    if (!normalizeExtractedArtifactUuid(auth.expectedCommittedClipId)) {
      return fail('TARGET_SCENE_INVALID', 'TARGET_SCENE', [], 'scene-local authorization has no valid expected committed clip id.');
    }
    if (input.committedClipPresent !== true) {
      return fail('GENERATION_GUARD_FAILED', 'TARGET_SCENE', [], 'scene-local authorization requires a verified committed clip.');
    }
    if (!normalizeExtractedArtifactUuid(input.observedCommittedClipId)) {
      return fail('GENERATION_GUARD_FAILED', 'TARGET_SCENE', [], 'scene-local authorization requires the exact observed committed clip id.');
    }
  }

  // 1. PROJECT_SETTINGS — authoritative; MUST precede scene creation.
  let projectSettings: ProjectVideoSettingsObservation | undefined;
  try {
    projectSettings = await step('PROJECT_SETTINGS', async () => {
      await port.configureProjectVideoSettings();
      return port.observeProjectVideoSettings() as Promise<ProjectVideoSettingsObservation>;
    });
    const verdict = verifyProjectVideoSettings(projectSettings);
    if (!verdict.ok) return fail('PROJECT_VIDEO_SETTINGS_NOT_READY', 'PROJECT_SETTINGS', phases, verdict.reason);
  } catch (e: any) {
    return fail('PROJECT_VIDEO_SETTINGS_NOT_READY', 'PROJECT_SETTINGS', phases, String(e?.message ?? e));
  }

  // 2. ASSET_LOCKS — verified against the LIVE Flow scene surface before any live mutation.
  //    A caller-supplied list is NEVER used here: only observed identities count, and `readOk` is
  //    true only when the reader actually observed a valid surface.
  phases.push('ASSET_LOCKS');
  let surface: { ok: boolean; characters: readonly string[]; backgrounds: readonly string[]; reason?: string };
  try {
    surface = await port.readFlowAssetIdentities();
  } catch (e: any) {
    return fail('ASSET_LOCKS_NOT_VERIFIED', 'ASSET_LOCKS', phases,
      `Flow asset surface could not be read: ${String(e?.message ?? e)}`, { projectSettings });
  }
  const lockVerification = verifyAssetLocks({
    required: input.requiredAssets,
    visible: { characters: surface?.characters ?? [], backgrounds: surface?.backgrounds ?? [] },
    readOk: surface?.ok === true,
    readReason: surface?.reason,
  });
  if (!lockVerification.ok) {
    return fail('ASSET_LOCKS_NOT_VERIFIED', 'ASSET_LOCKS', phases, String(lockVerification.reason ?? 'asset locks not verified'), { lockVerification, projectSettings });
  }

  // 3. SCENE_CREATE — skipped entirely when an existing target was supplied.
  let sceneId = '';
  if (target.kind === 'existing') {
    sceneId = target.sceneId;
  } else {
    try {
      const created = await step('SCENE_CREATE', () => port.createScene());
      sceneId = String(created?.sceneId ?? '').trim();
    } catch (e: any) {
      return fail('SCENE_CREATE_FAILED', 'SCENE_CREATE', phases, String(e?.message ?? e), { lockVerification, projectSettings });
    }
    if (!sceneId) return fail('SCENE_ID_UNAVAILABLE', 'SCENE_CREATE', phases, 'createScene returned no scene id.', { lockVerification, projectSettings });
  }

  // 4. SCENE_OPEN — the EXACT existing target when supplied; otherwise the newly created scene.
  try { await step('SCENE_OPEN', () => port.openSceneEditor(sceneId)); }
  catch (e: any) { return fail('SCENE_OPEN_FAILED', 'SCENE_OPEN', phases, String(e?.message ?? e), { sceneId, lockVerification, projectSettings }); }

  // 5. ATTACH_ASSETS — background first, then characters (each character verified AT SELECTION TIME).
  const characterAttachmentEvidence: CharacterAttachmentEvidence[] = [];
  try {
    await step('ATTACH_ASSETS', async () => {
      await port.selectAsset(String(input.backgroundTag));
      for (const tag of input.characterTags ?? []) {
        const ev = await port.selectCharacterAssetWithVerification(String(tag));
        characterAttachmentEvidence.push(ev);
        if (!ev.verified) {
          throw new Error(`character attachment not verified for ${tag}: ${ev.code}${ev.reason ? ` (${ev.reason})` : ''}`);
        }
      }
    });
  } catch (e: any) {
    return fail('INGREDIENTS_NOT_READY', 'ATTACH_ASSETS', phases, String(e?.message ?? e), { sceneId, lockVerification, projectSettings });
  }

  // 6. VERIFY_INGREDIENTS — exact set, no missing/duplicate/unexpected.
  // Background identity comes from the DOM reader; character identity comes ONLY from the
  // selection-time transaction evidence (the picker removes attached characters, so there is no
  // post-attachment character lookup).
  const expectedIngredients = [String(input.backgroundTag), ...(input.characterTags ?? []).map(String)];
  let ingredients: IngredientEvidenceDecision;
  try {
    const evidence = await step('VERIFY_INGREDIENTS', () => port.readSceneComposerIngredientEvidence());
    ingredients = classifyIngredientEvidence(expectedIngredients, { ...evidence, characterAttachmentEvidence });
  } catch (e: any) {
    return fail('INGREDIENTS_NOT_READY', 'VERIFY_INGREDIENTS', phases, String(e?.message ?? e), { sceneId, lockVerification, projectSettings });
  }
  if (ingredients.state !== 'EXACT') {
    return fail('INGREDIENTS_NOT_READY', 'VERIFY_INGREDIENTS', phases,
      `scene composer ingredients are ${ingredients.state} (missing=${ingredients.missing.join(',') || '-'}, duplicates=${ingredients.duplicates.join(',') || '-'}, unexpected=${ingredients.unexpected.join(',') || '-'}).`,
      { sceneId, lockVerification, projectSettings });
  }

  // 7. VERIFY_INHERITED_DISPLAY — confirmation ONLY (model/duration/aspect). 720p/x1 excluded.
  let inheritedDisplay: InheritedDisplayStatus;
  try {
    const observed = await step('VERIFY_INHERITED_DISPLAY', () => port.observeSceneInheritedDisplay());
    const decision = classifyInheritedDisplay(observed, {
      model: String((projectSettings as any)?.model ?? REQUIRED_SCENE_SETTINGS.model),
      duration: String((projectSettings as any)?.duration ?? REQUIRED_SCENE_SETTINGS.duration),
      aspect: String((projectSettings as any)?.aspect ?? REQUIRED_SCENE_SETTINGS.aspect),
    });
    if (decision.state === 'MISMATCH') {
      return fail('SCENE_INHERITED_SETTINGS_MISMATCH', 'VERIFY_INHERITED_DISPLAY', phases,
        `scene displays ${decision.mismatches.map((m) => `${m.field}="${m.observed}" (expected "${m.expected}")`).join(', ')}.`,
        { sceneId, lockVerification, projectSettings });
    }
    inheritedDisplay = decision.status;
  } catch (e: any) {
    // An unreadable scene surface is UNOBSERVABLE, not a failure: project settings stay authoritative.
    inheritedDisplay = 'SCENE_INHERITED_SETTINGS_UNOBSERVABLE';
  }

  // 8. GENERATION_GUARD — evaluated IMMEDIATELY before the click.
  //
  // Ordinary lifecycle calls keep `canGenerateScene()`, which deliberately refuses a committed
  // clip. The ONLY exception is an explicitly authorized scene-local EXTEND/REGENERATE: it uses the
  // dedicated guard below, which requires the committed clip to be PRESENT and to match the exact
  // authorization. This never passes `committedClipPresent: false` for a committed scene.
  const guard = input.sceneLocalAuthorization
    ? canGenerateAuthorizedSceneLocal({
        sceneNumber: input.sceneNumber,
        prompt: input.prompt,
        ingredients,
        settingsVerified: true,   // project settings verified above (authoritative)
        generationAuthorized: input.generationAuthorized,
        generationAttempts: 0,
        localClipValid: input.localClipValid === true,
        committedClipPresent: input.committedClipPresent === true,
        sceneExists: true,
        targetSceneId: sceneId,
        observedCommittedClipId: String(input.observedCommittedClipId ?? ''),
        authorization: input.sceneLocalAuthorization,
      })
    : evaluateGenerationGuard({
        sceneNumber: input.sceneNumber,
        prompt: input.prompt,
        ingredients,
        settingsVerified: true,   // project settings verified above (authoritative)
        generationAuthorized: input.generationAuthorized,
        generationAttempts: 0,
        localClipValid: input.localClipValid === true,
        committedClipPresent: input.committedClipPresent === true,
        sceneExists: true,
      });
  phases.push('GENERATION_GUARD');
  if (!guard.ok) return fail('GENERATION_GUARD_FAILED', 'GENERATION_GUARD', phases, guard.reason, { sceneId, lockVerification, projectSettings, inheritedDisplay });

  // 9. GENERATE — EXACTLY ONE call. No retry, no second candidate.
  let artifactId = '';
  try {
    const generated = await step('GENERATE', () => port.generateSceneVideo(String(input.prompt), { expectedIngredients }));
    artifactId = String(generated?.artifactId ?? '').trim();
    if (!artifactId) return fail('GENERATION_FAILED', 'GENERATE', phases, 'generateSceneVideo returned no artifact id.', { sceneId, lockVerification, projectSettings, inheritedDisplay });
  } catch (e: any) {
    return fail('GENERATION_FAILED', 'GENERATE', phases, String(e?.message ?? e), { sceneId, lockVerification, projectSettings, inheritedDisplay });
  }

  // 10. COMMIT — the clip must actually be bound to the canonical scene.
  let hasClip = false;
  try { hasClip = (await step('COMMIT', () => port.sceneHasClip())) === true; }
  catch (e: any) { return fail('CLIP_NOT_COMMITTED', 'COMMIT', phases, String(e?.message ?? e), { sceneId, artifactId, lockVerification, projectSettings, inheritedDisplay }); }
  if (!hasClip) return fail('CLIP_NOT_COMMITTED', 'COMMIT', phases, 'the generated artifact is not bound to the canonical scene.', { sceneId, artifactId, lockVerification, projectSettings, inheritedDisplay });

  // 11. PERSIST — canonical fresh-read persistence (never the editor rail alone).
  let committedClipId = '';
  try {
    const persisted = await step('PERSIST', () => port.verifyScenePersistence(sceneId, artifactId));
    committedClipId = String(persisted?.committedClipId ?? '').trim();
    if (!committedClipId) return fail('CLIP_PERSISTENCE_FAILED', 'PERSIST', phases, 'persistence verification returned no committed clip id.', { sceneId, artifactId, lockVerification, projectSettings, inheritedDisplay });
  } catch (e: any) {
    return fail('CLIP_PERSISTENCE_FAILED', 'PERSIST', phases, String(e?.message ?? e), { sceneId, artifactId, lockVerification, projectSettings, inheritedDisplay });
  }

  // 12. DOWNLOAD — permitted ONLY after persistence.
  const downloadGate = decideDownloadAfterPersistence(true);
  phases.push('DOWNLOAD');
  if (!downloadGate.ok) return fail(downloadGate.code, 'DOWNLOAD', phases, downloadGate.reason, { sceneId, artifactId, committedClipId, lockVerification, projectSettings, inheritedDisplay });
  try {
    const dl = await port.downloadCommittedSceneClip(input.sceneNumber, input.destinationPath, { ...(input.downloadOptions ?? {}), overwrite: input.overwrite === true });
    if (!dl?.ok) return fail('DOWNLOAD_FAILED', 'DOWNLOAD', phases, String(dl?.reason ?? dl?.result ?? 'download failed'), { sceneId, artifactId, committedClipId, lockVerification, projectSettings, inheritedDisplay });
  } catch (e: any) {
    return fail('DOWNLOAD_FAILED', 'DOWNLOAD', phases, String(e?.message ?? e), { sceneId, artifactId, committedClipId, lockVerification, projectSettings, inheritedDisplay });
  }

  // 13. VALIDATE — the downloaded file must satisfy the existing clip contract.
  try {
    const validated = await step('VALIDATE', () => input.validateDownloaded(input.destinationPath));
    if (!validated?.ok) return fail('DOWNLOADED_CLIP_INVALID', 'VALIDATE', phases, String(validated?.reason ?? 'downloaded clip failed validation'), { sceneId, artifactId, committedClipId, lockVerification, projectSettings, inheritedDisplay });
  } catch (e: any) {
    return fail('DOWNLOADED_CLIP_INVALID', 'VALIDATE', phases, String(e?.message ?? e), { sceneId, artifactId, committedClipId, lockVerification, projectSettings, inheritedDisplay });
  }

  return { ok: true, sceneId, artifactId, committedClipId, clipPath: input.destinationPath, phases, lockVerification, projectSettings, inheritedDisplay };
}

/** The required scene video settings (re-exported so callers share ONE contract). */
export const SCENE_REQUIRED_SETTINGS = REQUIRED_SCENE_SETTINGS;

// ---------------------------------------------------------------------------------------
// Production binding: FlowClient → SceneLifecyclePort (browser-free; no DOM here)
// ---------------------------------------------------------------------------------------

/** The FlowClient methods this lifecycle depends on. Missing any of them fails closed. */
export const SCENE_LIFECYCLE_FLOW_METHODS = [
  'configureVideoGeneration', 'observeProjectVideoSettings', 'createScene', 'openSceneEditor', 'selectAsset',
  'selectCharacterAssetWithVerification', 'readSceneComposerIngredientEvidence', 'observeSceneInheritedDisplay', 'generateSceneVideo',
  'sceneHasClip', 'reconcileGeneratedVideoWithScene', 'downloadCommittedSceneClip',
  'listRailAssetTags', 'listCharacterPickerTags',
] as const;

/**
 * Bind an existing FlowClient (or compatible object) to the lifecycle port.
 *
 * `configureProjectVideoSettings` uses the EXISTING project-level `configureVideoGeneration()`
 * (the authoritative settings mechanism). `observeProjectVideoSettings` uses the read-only
 * `observeProjectVideoSettings()` wrapper. `observeSceneInheritedDisplay` reads only the three
 * values the scene surface exposes. `verifyScenePersistence` delegates to the EXISTING
 * `reconcileGeneratedVideoWithScene()` SINGLE_CLIP branch (verify + bounded fresh reads; no attach).
 */
/**
 * `readFlowAssetIdentities` opens a canonical scene surface READ-ONLY (it never creates a scene and
 * never selects an asset) and then reads the STABLE identities observed there: background tags from
 * the navigation rail, character tags from the Characters picker. It is fail-closed: when no scene
 * surface can be resolved, or the read produces nothing, it returns `ok:false`.
 */
export function createFlowSceneLifecyclePort(flow: any, options: { assetVerificationSceneId?: string } = {}): SceneLifecyclePort {
  for (const name of SCENE_LIFECYCLE_FLOW_METHODS) {
    if (typeof flow?.[name] !== 'function') throw new Error(`Flow client does not expose ${name}(); refusing to build the scene lifecycle port.`);
  }
  return {
    configureProjectVideoSettings: () => flow.configureVideoGeneration(),
    observeProjectVideoSettings: () => flow.observeProjectVideoSettings(),
    readFlowAssetIdentities: async () => {
      const sceneRef = await resolveAssetVerificationSceneId(flow, options.assetVerificationSceneId);
      if (!sceneRef) return { ok: false, characters: [], backgrounds: [], reason: 'no canonical Flow scene surface could be resolved for asset verification.' };
      await flow.openSceneEditor(sceneRef);
      return readFlowSceneSurfaceAssets(flow);
    },
    createScene: () => flow.createScene(),
    openSceneEditor: (sceneIdOrTitle: string) => flow.openSceneEditor(sceneIdOrTitle),
    selectAsset: (tag: string) => flow.selectAsset(tag),
    selectCharacterAssetWithVerification: (tag: string) => flow.selectCharacterAssetWithVerification(tag),
    readSceneComposerIngredientEvidence: () => flow.readSceneComposerIngredientEvidence(),
    observeSceneInheritedDisplay: () => flow.observeSceneInheritedDisplay(),
    generateSceneVideo: (prompt: string, options: { expectedIngredients?: string[] }) => flow.generateSceneVideo(prompt, options),
    sceneHasClip: () => flow.sceneHasClip(),
    verifyScenePersistence: async (sceneRef: string, artifactId: string) => {
      const r = await flow.reconcileGeneratedVideoWithScene(sceneRef, artifactId);
      return { committedClipId: String(r?.committedSceneArtifactId ?? '') };
    },
    downloadCommittedSceneClip: (sceneNumber: number, destination: string, options?: Record<string, unknown>) => flow.downloadCommittedSceneClip(sceneNumber, destination, options),
  };
}
