/**
 * FIRST-CLIP production lifecycle (project-first).
 *
 * WHY THIS IS SEPARATE FROM `sceneProductionLifecycle.ts`
 * -----------------------------------------------------
 * Live evidence proved a fresh/clipless Flow scene CANNOT produce its own first clip: its
 * scene-local composer is `contenteditable="false"` ("Select a clip to edit") with a disabled
 * generate button, and Flow only enables it AFTER a clip is committed. The previous ordering
 * (SCENE_CREATE → SCENE_OPEN → ATTACH_ASSETS → GENERATE → COMMIT) was therefore structurally
 * unsatisfiable for a new scene.
 *
 * A project-level generation, by contrast, was live-proven to CREATE a new populated scene that
 * already carries the generated first clip — with NO attachment step. This lifecycle encodes
 * exactly that, and it never:
 *   · requires a scene-local prompt editor (that is the scene-EDIT path's precondition),
 *   · attaches the generated clip through Add Clip (first-clip creation is automatic),
 *   · falls back to local synthesis, guesses a selector, or accepts an ambiguous identity.
 *
 * `sceneProductionLifecycle.ts` is retained UNCHANGED as the explicit
 * `SCENE_CLIP_EDIT_OR_EXTENSION` path, which requires an already-committed clip.
 *
 * CREDIT SAFETY
 * -------------
 *   · `decideStartGenerationEligibility()` is evaluated IMMEDIATELY before the click and carries
 *     the click count, so a second click is structurally impossible.
 *   · EXACTLY ONE `generateProjectFirstClip()` call. No retry, no second candidate.
 *   · Any unresolved precondition returns a typed code and stops.
 */
import { verifyAssetLocks, type AssetVerificationResult } from './assetVerification.js';
import { verifyProjectVideoSettings, type ProjectVideoSettingsObservation } from './sceneProductionLifecycle.js';
import { deriveRoutesFromMountedSceneUrl } from './videoDecisions.js';
import {
  classifyFirstClipMode,
  decideFirstClipCheckpointUpdate,
  decideFirstClipClickAuthorization,
  decideFirstClipSceneResolutionStrategy,
  decideStartGenerationEligibility,
  identifyFirstClipScene,
  isSameGenerationVideoIdentity,
  normalizeGeneratedVideoUuid,
  verifyFirstClipAssetIdentities,
  verifyProjectPromptFill,
  verifyProjectRouteRestoration,
  FIRST_CLIP_SOURCE,
  type FirstClipGenerationResult,
  type FirstClipMode,
  type FirstClipSceneCandidate,
  type ProjectPromptEditorResolution,
} from './firstClipGeneration.js';
import { buildFlowScenePrompt, type SceneCheckpoint } from './sceneFlowWorkflow.js';
import {
  resolveSceneAssetDependencies,
  verifySceneAssetLocks,
  findResidualMachineIds,
} from './flowPromptHardening.js';
import { detectWardrobeMode, type WardrobeMode } from './characterWardrobe.js';

export type FirstClipLifecycleFailureCode =
  | 'PROJECT_VIDEO_SETTINGS_NOT_READY'
  | 'ASSET_LOCKS_NOT_VERIFIED'
  | 'PROMPT_HARDENING_FAILED'
  | 'PROJECT_ROUTE_RESTORE_FAILED'
  | 'PROJECT_PROMPT_EDITOR_UNRESOLVED'
  | 'PROJECT_PROMPT_FILL_UNVERIFIED'
  | 'GENERATION_GUARD_FAILED'
  | 'PROJECT_GENERATION_FAILED'
  | 'FIRST_CLIP_VIDEO_UUID_UNRESOLVED'
  | 'FIRST_CLIP_SCENE_UNRESOLVED'
  | 'CLIP_PERSISTENCE_FAILED'
  | 'DOWNLOAD_FAILED'
  | 'DOWNLOADED_CLIP_INVALID';

/** The explicit, ordered phases for first-clip creation. */
export const FIRST_CLIP_LIFECYCLE_PHASES = [
  'PROJECT_SETTINGS', 'ASSET_LOCKS', 'RESTORE_PROJECT_ROUTE', 'FIRST_CLIP_PROJECT_GENERATION', 'FIRST_CLIP_RESULT',
  'SCENE_RESOLUTION', 'PERSIST_FIRST_CLIP_CHECKPOINT', 'DOWNLOAD', 'VALIDATE',
] as const;
/**
 * Additional pre-generation phases reported alongside {@link FIRST_CLIP_LIFECYCLE_PHASES}.
 *
 * They run AFTER `ASSET_LOCKS` and BEFORE `RESTORE_PROJECT_ROUTE`, and both fail closed before any
 * credit is spent. They are appended here rather than spliced into the core order so the
 * long-standing nine-phase order stays byte-identical.
 */
export const FIRST_CLIP_PREFLIGHT_PHASES = [
  'SCENE_REQUIRED_ASSET_LOCKS', 'PROMPT_HARDENING',
] as const;
export type FirstClipPreflightPhase = typeof FIRST_CLIP_PREFLIGHT_PHASES[number];
export type FirstClipLifecyclePhase = typeof FIRST_CLIP_LIFECYCLE_PHASES[number] | FirstClipPreflightPhase;

export interface FirstClipLifecyclePort {
  /** Open the canonical PROJECT route (where the editable first-clip composer lives). */
  openProjectRoute(): Promise<{ url: string }>;
  /** Configure the PROJECT composer's authoritative video settings. Never clicks Start. */
  configureProjectVideoSettings(): Promise<void>;
  /** Read the observed PROJECT video settings for pure verification. */
  observeProjectVideoSettings(): Promise<Record<string, unknown>>;
  /**
   * READ-ONLY live asset identities plus whether the surface was actually observed.
   *
   * `knownSceneId` is the scene's OWN already-recorded `flow_scene_id` when one exists — never an
   * arbitrary or "first" scene. With no recorded id the implementation must fail closed rather than
   * invent a surface.
   */
  readFlowAssetIdentities(knownSceneId?: string | null): Promise<{
    ok: boolean; characters: readonly string[]; backgrounds: readonly string[];
    reason?: string; surface?: string; projectGridIdentities?: readonly string[];
    projectBackgroundIdentities?: readonly string[];
    projectCharacterIdentities?: readonly string[];
  }>;
  /**
   * Re-establish the canonical PROJECT route after ASSET_LOCKS left it.
   *
   * Asset verification navigates to a scene to read the navigation rail, so the project composer is
   * no longer mounted. Generation is only possible on the project route, so this transition is
   * explicit and fail-closed: it must report the restored URL and whether the project surface is
   * observable again. It never reconfigures settings and never spends credits.
   */
  restoreProjectRoute(): Promise<{ url: string; projectSurfaceObserved: boolean }>;
  /**
   * Resolve THE editable project prompt editor, fill it, verify the fill, verify Start is enabled,
   * click Start EXACTLY once, wait for completion, and return the raw evidence. Must not retry.
   */
  generateProjectFirstClip(prompt: string): Promise<{
    editorResolution: ProjectPromptEditorResolution;
    observedPromptText: string;
    startButtonDisabledBeforeClick: boolean | null;
    startClicks: number;
    generationUuid: string | null;
    videoUrl: string | null;
    durationSeconds: number | null;
    audioPresent: boolean | null;
    projectRouteVideoUuids: readonly string[];
    /**
     * The scene title Flow derived from the prompt, when observable. Nullable: it is only an INPUT
     * to the exact-title fallback strategy and is never treated as an identity on its own.
     */
    generatedSceneTitle?: string | null;
    /** Why the generated scene title could not be derived (diagnostic; never a substitute). */
    generatedSceneTitleReason?: string | null;
  }>;
  /** Read every observable scene candidate with its exact `/video/<UUID>` (read-only). */
  resolveFirstClipSceneCandidates(): Promise<FirstClipSceneCandidate[]>;
  /**
   * Fallback scene resolution through the EXISTING PROVEN exact-title scene opener, used only when
   * no candidate exposes a scene id for the generated video uuid. It opens that exact scene and
   * must report the scene id, its canonical route, and the `/video/<UUID>` actually observed on the
   * opened scene so the caller can re-verify identity. Navigation only; never attaches anything.
   */
  openGeneratedSceneByExactTitle(title: string): Promise<{ sceneId: string; route: string; videoUuid: string | null }>;
  /**
   * Persist the resolved identity into the EXISTING `SceneCheckpoint` store. Supplied by the caller
   * (typically `writeSceneCheckpoint`); the lifecycle only decides WHEN it may run.
   */
  persistFirstClipCheckpoint?(checkpoint: SceneCheckpoint): Promise<{ ok: boolean; reason?: string }>;
  /** Canonical persistence verification for the identified scene (fresh reads; never attaches). */
  verifyScenePersistence(sceneRef: string, artifactId: string): Promise<{ committedClipId: string }>;
  downloadCommittedSceneClip(sceneNumber: number, destination: string, options?: Record<string, unknown>): Promise<{ ok: boolean; result?: string; reason?: string; meta?: any }>;
}

/** PURE: speaker-aware selection of the canonical prompt variant for a first clip. */
export type FirstClipScenePromptSelection =
  | { ok: true; prompt: string; field: 'animation_prompt_NARRATOR_ONLY' | 'animation_prompt_WITH_lipsync'; speaker: string }
  | { ok: false; field: string; speaker: string; reason: string };

export function selectFirstClipScenePrompt(scene: {
  speaker?: unknown;
  animation_prompt_NARRATOR_ONLY?: unknown;
  animation_prompt_WITH_lipsync?: unknown;
} | null | undefined): FirstClipScenePromptSelection {
  const speaker = String(scene?.speaker ?? '').trim();
  const upper = speaker.toUpperCase();
  const narrator = speaker === '' || upper === 'NARRATOR' || upper === 'NONE' || upper === 'NOBODY';
  const field = narrator ? 'animation_prompt_NARRATOR_ONLY' as const : 'animation_prompt_WITH_lipsync' as const;
  const selected = String(scene?.[field] ?? '').trim();
  if (selected) return { ok: true, prompt: selected, field, speaker };
  // Backward-compatible inference ONLY when the manifest has no speaker metadata at all. An
  // explicit speaker must never silently borrow the other variant: that would drop dialogue or
  // narrate a character-speaking scene.
  if (!speaker) {
    const otherField = narrator ? 'animation_prompt_WITH_lipsync' as const : 'animation_prompt_NARRATOR_ONLY' as const;
    const fallback = String(scene?.[otherField] ?? '').trim();
    if (fallback) return { ok: true, prompt: fallback, field: otherField, speaker };
  }
  return {
    ok: false,
    field,
    speaker,
    reason: `scene speaker ${JSON.stringify(speaker || '(missing)')} requires ${field}, but that prompt is empty. The other variant is not substituted.`,
  };
}

export interface FirstClipLifecycleInput {
  sceneNumber: number;
  prompt: string;
  /**
   * The canonical scene whose dependencies gate this generation.
   *
   * `background_tag` / `character_tags` are the SCENE-scoped lock. `speaker` chooses between
   * `animation_prompt_WITH_lipsync` (character dialogue) and `animation_prompt_NARRATOR_ONLY`
   * (narration); the selected raw prompt is hardened before it reaches the composer.
   */
  scene?: {
    scene_number?: unknown;
    background_tag?: unknown;
    character_tags?: unknown;
    speaker?: unknown;
    outfit_ids?: unknown;
    assets?: { character_tags?: unknown; [key: string]: unknown } | null;
    animation_prompt_NARRATOR_ONLY?: unknown;
    animation_prompt_WITH_lipsync?: unknown;
    visual_action?: unknown;
    camera?: unknown;
    effects?: unknown;
  } | null;
  /** Canonical `pipeline.json.backgrounds[]` — the ONLY background description source. */
  canonicalBackgrounds?: readonly { tag?: unknown; location_name?: unknown; look_summary?: unknown }[] | null;
  /** Canonical `pipeline.json.characters[]` — the ONLY character description source. */
  canonicalCharacters?: readonly {
    tag?: unknown;
    name?: unknown;
    look_summary?: unknown;
    appearance_lock?: unknown;
    wardrobe?: unknown;
  }[] | null;
  /** Explicit wardrobe contract mode. Omit for deterministic auto-detection. */
  wardrobeMode?: WardrobeMode;
  /** Canonical project route — required to verify RESTORE_PROJECT_ROUTE. */
  projectUrl?: string;
  projectId?: string;
  existingCheckpoint?: SceneCheckpoint | null;
  destinationPath: string;
  requiredAssets: { characters: readonly string[]; backgrounds: readonly string[] };
  generationAuthorized: boolean;
  validateDownloaded: (path: string) => Promise<{ ok: boolean; reason?: string; [k: string]: unknown }>;
  overwrite?: boolean;
  downloadOptions?: Record<string, unknown>;
}

export interface FirstClipLifecycleResult {
  ok: boolean;
  code?: FirstClipLifecycleFailureCode;
  phase?: FirstClipLifecyclePhase;
  reason?: string;
  mode: FirstClipMode;
  phases: FirstClipLifecyclePhase[];
  firstClip?: FirstClipGenerationResult;
  sceneId?: string;
  committedClipId?: string;
  clipPath?: string;
  lockVerification?: AssetVerificationResult;
  projectSettings?: ProjectVideoSettingsObservation;
  /** Non-authoritative observations recorded while resolving the generated scene. */
  sceneResolutionStrategy?: string;
  sceneResolutionVerifiedOnOpenedScene?: boolean;
  sceneResolutionOpenError?: string;
  checkpointChanged?: boolean;
}

const fail = (
  code: FirstClipLifecycleFailureCode,
  phase: FirstClipLifecyclePhase,
  phases: FirstClipLifecyclePhase[],
  reason: string,
  mode: FirstClipMode,
  extra: Partial<FirstClipLifecycleResult> = {},
): FirstClipLifecycleResult => ({ ok: false, code, phase, reason, mode, phases, ...extra });

/** Run the FIRST-CLIP project lifecycle ONCE. Deterministic, fail-closed, no retries. */
export async function runFirstClipProjectLifecycle(
  port: FirstClipLifecyclePort,
  input: FirstClipLifecycleInput,
): Promise<FirstClipLifecycleResult> {
  const phases: FirstClipLifecyclePhase[] = [];
  /** Non-authoritative observations recorded while running the lifecycle. */
  const report: Record<string, unknown> = {};
  // A first clip is produced by the PROJECT composer. The scene-local model is only selected when
  // an already-committed clip is proven, which by definition is not this lifecycle.
  const { mode } = classifyFirstClipMode({ committedClipPresent: false });

  // 1. PROJECT_SETTINGS — authoritative, on the project route.
  let projectSettings: ProjectVideoSettingsObservation | undefined;
  try {
    const opened = await port.openProjectRoute();
    if (!opened?.url) throw new Error('the canonical project route could not be opened.');
    projectSettings = await (async () => {
      await port.configureProjectVideoSettings();
      return port.observeProjectVideoSettings() as Promise<ProjectVideoSettingsObservation>;
    })();
    phases.push('PROJECT_SETTINGS');
    const verdict = verifyProjectVideoSettings(projectSettings);
    if (!verdict.ok) return fail('PROJECT_VIDEO_SETTINGS_NOT_READY', 'PROJECT_SETTINGS', phases, verdict.reason, mode);
  } catch (e: any) {
    phases.push('PROJECT_SETTINGS');
    return fail('PROJECT_VIDEO_SETTINGS_NOT_READY', 'PROJECT_SETTINGS', phases, String(e?.message ?? e), mode);
  }

  // 2. ASSET_LOCKS — verified against the LIVE surface before any credit is spent.
  phases.push('ASSET_LOCKS');
  let lockVerification: AssetVerificationResult;
  // Hoisted so the SCENE-scoped gate below can reuse the SAME live read (never a second read).
  let observedBackgrounds: string[] = [];
  let observedCharacters: string[] = [];
  try {
    // The ONLY legitimate scene surface is the scene's own already-recorded flow_scene_id. There is
    // deliberately no "pick some scene" fallback.
    const knownSceneId = String(input.existingCheckpoint?.flow_scene_id ?? '').trim();
    const surface = await port.readFlowAssetIdentities(knownSceneId || null);
    observedBackgrounds = [...(surface?.projectBackgroundIdentities ?? surface?.projectGridIdentities ?? surface?.backgrounds ?? [])];
    observedCharacters = [...(surface?.projectCharacterIdentities ?? surface?.characters ?? [])];
    report.assetSurface = {
      surface: surface?.surface ?? null, knownSceneId: knownSceneId || null,
      projectBackgroundCount: observedBackgrounds.length,
      projectCharacterCount: observedCharacters.length,
    };

    // The pure verifier names EXACTLY which identity cannot be proven; the gate is never broadened.
    // Characters may come from the project's dedicated Characters category and/or a known scene
    // surface; backgrounds from the project ingredient surface, project grid, and/or a scene rail.
    const precise = verifyFirstClipAssetIdentities({
      requiredCharacters: input.requiredAssets.characters,
      requiredBackgrounds: input.requiredAssets.backgrounds,
      // The virtualised project grid is NOT an authoritative background pool for the first clip.
      projectGridIdentities: null,
      projectBackgroundIdentities: observedBackgrounds,
      projectCharacterIdentities: observedCharacters,
      sceneIdentities: knownSceneId ? { characters: surface?.characters ?? [], backgrounds: surface?.backgrounds ?? [] } : null,
    });
    if (!precise.ok) {
      return fail('ASSET_LOCKS_NOT_VERIFIED', 'ASSET_LOCKS', phases,
        `${precise.reason} (asset surface: ${String(surface?.surface ?? 'unknown')})`, mode, { projectSettings });
    }
    lockVerification = verifyAssetLocks({
      required: input.requiredAssets,
      visible: { characters: precise.characters, backgrounds: precise.backgrounds },
      readOk: true,
    });
  } catch (e: any) {
    return fail('ASSET_LOCKS_NOT_VERIFIED', 'ASSET_LOCKS', phases, String(e?.message ?? e), mode, { projectSettings });
  }
  if (!lockVerification.ok) {
    return fail('ASSET_LOCKS_NOT_VERIFIED', 'ASSET_LOCKS', phases, String(lockVerification.reason ?? 'asset locks not verified'), mode, { lockVerification, projectSettings });
  }

  // 3. RESTORE_PROJECT_ROUTE — ASSET_LOCKS navigated away to read the rail. The project composer
  //    is ONLY on the project route, so this is an explicit, fail-closed transition rather than an
  //    implicit assumption. It never reconfigures settings and never spends credits.
  phases.push('RESTORE_PROJECT_ROUTE');
  let restoredUrl = '';
  let projectSurfaceObserved = false;
  try {
    const restored = await port.restoreProjectRoute();
    restoredUrl = String(restored?.url ?? '').trim();
    projectSurfaceObserved = restored?.projectSurfaceObserved === true;
  } catch (e: any) {
    return fail('PROJECT_ROUTE_RESTORE_FAILED', 'RESTORE_PROJECT_ROUTE', phases, String(e?.message ?? e), mode, { lockVerification, projectSettings });
  }
  const restoration = verifyProjectRouteRestoration({
    projectUrl: input.projectUrl,
    restoredUrl,
    projectSurfaceObserved,
  });
  if (!restoration.ok) {
    return fail('PROJECT_ROUTE_RESTORE_FAILED', 'RESTORE_PROJECT_ROUTE', phases, restoration.reason, mode, { lockVerification, projectSettings });
  }

  // 3b. SCENE_REQUIRED_ASSET_LOCKS + PROMPT_HARDENING — settled BEFORE the credit-consuming port.
  //
  // The project-wide inventory read above is PROJECT_ASSET_SURFACE_INTEGRITY and stays exactly as
  // strict as before (all declared project assets must be observable). GENERATION, however, is gated
  // only on the SCENE's OWN declared dependencies, so a scene that needs one background is not
  // blocked by six unrelated ones.
  //
  // The raw `animation_prompt_NARRATOR_ONLY` embeds machine identifiers (`#BGD-*`, `@CHAR-*`). Those
  // are resolved to their canonical human-readable descriptions BEFORE the prompt reaches the
  // composer; an unresolvable reference fails closed rather than being stripped or guessed.
  phases.push('SCENE_REQUIRED_ASSET_LOCKS');
  const sceneDeps = resolveSceneAssetDependencies(input.scene);
  if (!sceneDeps.ok) {
    return fail('ASSET_LOCKS_NOT_VERIFIED', 'SCENE_REQUIRED_ASSET_LOCKS', phases, sceneDeps.reason, mode, { projectSettings });
  }
  const sceneLocks = verifySceneAssetLocks({
    requiredBackgrounds: sceneDeps.backgroundTags,
    requiredCharacters: sceneDeps.characterTags,
    availableBackgrounds: observedBackgrounds,
    availableCharacters: observedCharacters,
  });
  if (!sceneLocks.ok) {
    return fail('ASSET_LOCKS_NOT_VERIFIED', 'SCENE_REQUIRED_ASSET_LOCKS', phases, sceneLocks.reason, mode, { projectSettings });
  }

  phases.push('PROMPT_HARDENING');
  // Speaker-aware variant selection is part of the contract: a character-speaking scene must use
  // its WITH_lipsync prompt (and retain Flow character audio); a narrator-only scene must use its
  // NARRATOR_ONLY prompt. An explicit speaker never silently falls back to the other variant.
  const scenePrompt = input.scene
    ? selectFirstClipScenePrompt(input.scene)
    : { ok: true as const, prompt: String(input.prompt ?? ''), field: null, speaker: '' };
  if (!scenePrompt.ok) {
    return fail('PROMPT_HARDENING_FAILED', 'PROMPT_HARDENING', phases, scenePrompt.reason, mode, { projectSettings });
  }
  const built = buildFlowScenePrompt({
    prompt: scenePrompt.prompt,
    backgrounds: input.canonicalBackgrounds,
    characters: input.canonicalCharacters,
    scene: input.scene,
    wardrobeMode: input.wardrobeMode ?? detectWardrobeMode(input.canonicalCharacters),
  });
  if (!built.ok) {
    return fail('PROMPT_HARDENING_FAILED', 'PROMPT_HARDENING', phases, built.reason, mode, { projectSettings });
  }
  // TASK 4: the builder fails closed on residual identifiers, missing wardrobe, unknown outfits and
  // contradictory scene prose; this final guard keeps that invariant explicit at the call site.
  const residual = findResidualMachineIds(built.prompt);
  if (residual.length > 0) {
    return fail('PROMPT_HARDENING_FAILED', 'PROMPT_HARDENING', phases, `${residual.length} raw machine identifier(s) remain in the hardened prompt (${residual.join(', ')}).`, mode, { projectSettings });
  }
  const promptCorresponds = verifySceneAssetLocks({
    requiredBackgrounds: sceneLocks.requiredBackgrounds,
    requiredCharacters: sceneLocks.requiredCharacters,
    availableBackgrounds: observedBackgrounds,
    availableCharacters: observedCharacters,
  });
  if (!promptCorresponds.ok) {
    return fail('PROMPT_HARDENING_FAILED', 'PROMPT_HARDENING', phases, promptCorresponds.reason, mode, { projectSettings });
  }

  // 4. FIRST_CLIP_PROJECT_GENERATION — exactly one port call, one Start click.
  //
  // PRE-GATE (before the port is touched): the port performs the credit-consuming click, so every
  // precondition that is already knowable MUST be settled first. `decideStartGenerationEligibility()`
  // is invoked here with the post-port fields unset, so an unauthorized or unverified run never
  // reaches `generateProjectFirstClip()` at all.
  const preGate = decideStartGenerationEligibility({
    editorResolved: true,          // verified inside the port (fill + read-back)
    promptVerified: true,          // verified inside the port (exact read-back)
    settingsVerified: true,        // PROJECT_SETTINGS above
    assetLocksVerified: lockVerification.ok,
    generationAuthorized: input.generationAuthorized === true,
    startButtonPresent: true,      // verified inside the port
    startButtonDisabled: false,    // verified inside the port
    startClicksSoFar: 0,
  });
  if (!preGate.ok) {
    return fail('GENERATION_GUARD_FAILED', 'ASSET_LOCKS', phases, preGate.reason, mode, { lockVerification, projectSettings });
  }

  // AUTHORIZATION BOUNDARY — the single Start-generation click is gated here, explicitly.
  //   GENERATION_CLICK                  → consumes the one-click credit budget
  //   SCENE_RESOLUTION_NAVIGATION_CLICK → does NOT consume it, and is only allowed after
  //                                       generation has actually completed
  const generationAuth = decideFirstClipClickAuthorization({
    kind: 'GENERATION_CLICK',
    preconditionsMet: preGate.ok,
    generationCompleted: false,
    generationClicksSoFar: 0,
  });
  if (!generationAuth.ok) {
    return fail('GENERATION_GUARD_FAILED', 'ASSET_LOCKS', phases, generationAuth.reason, mode, { lockVerification, projectSettings });
  }

  let raw: Awaited<ReturnType<FirstClipLifecyclePort['generateProjectFirstClip']>>;
  // The HARDENED prompt is authoritative for generation. `input.prompt` is only a fallback for a
  // caller that supplied no scene metadata at all; when a scene IS supplied, the raw prompt is
  // never handed to the composer because it carries raw #BGD-*/@CHAR-* identities.
  const promptToFill = input.scene ? built.prompt : String(input.prompt);
  try {
    report.hardenedPrompt = promptToFill;
    report.promptVariant = input.scene ? scenePrompt.field : null;
    report.wardrobeMode = input.scene ? built.mode : null;
    report.hardenedPromptResolutions = input.scene ? built.resolved : [];
    report.sceneRequiredAssets = { backgrounds: sceneLocks.requiredBackgrounds, characters: sceneLocks.requiredCharacters };
    raw = await port.generateProjectFirstClip(promptToFill);
    phases.push('FIRST_CLIP_PROJECT_GENERATION');
  } catch (e: any) {
    return fail('PROJECT_GENERATION_FAILED', 'FIRST_CLIP_PROJECT_GENERATION', phases, String(e?.message ?? e), mode, { lockVerification, projectSettings });
  }
  if (!raw?.editorResolution?.ok) {
    return fail('PROJECT_PROMPT_EDITOR_UNRESOLVED', 'FIRST_CLIP_PROJECT_GENERATION', phases,
      String(raw?.editorResolution?.reason ?? 'the project prompt editor could not be resolved.'),
      mode, { lockVerification, projectSettings });
  }
  // The read-back must match EXACTLY the text that was sent to the composer — i.e. the hardened
  // prompt when a scene was supplied. Comparing against the raw prompt would always mismatch.
  // `observedPromptText` is already the canonical block-normalised reconstruction produced by
  // `renderProjectPromptReadbackFromParagraphs()` inside the port, so the strict byte-identical
  // comparison is preserved here.
  const fill = verifyProjectPromptFill(promptToFill, raw.observedPromptText);
  if (!fill.ok) {
    return fail('PROJECT_PROMPT_FILL_UNVERIFIED', 'FIRST_CLIP_PROJECT_GENERATION', phases, fill.reason, mode, { lockVerification, projectSettings });
  }
  if (Number(raw.startClicks ?? 0) !== 1) {
    return fail('GENERATION_GUARD_FAILED', 'FIRST_CLIP_PROJECT_GENERATION', phases,
      `exactly one Start-generation click is required, observed ${String(raw.startClicks)}.`,
      mode, { lockVerification, projectSettings });
  }
  const guard = decideStartGenerationEligibility({
    editorResolved: raw.editorResolution.ok === true,
    promptVerified: fill.ok,
    settingsVerified: true,
    assetLocksVerified: lockVerification.ok,
    generationAuthorized: input.generationAuthorized === true,
    startButtonPresent: raw.startButtonDisabledBeforeClick !== null,
    startButtonDisabled: raw.startButtonDisabledBeforeClick === true,
    startClicksSoFar: 0,   // evaluated pre-click semantics; the port already made the one click
  });
  if (!guard.ok) {
    return fail('GENERATION_GUARD_FAILED', 'FIRST_CLIP_PROJECT_GENERATION', phases, guard.reason, mode, { lockVerification, projectSettings });
  }

  // 5. FIRST_CLIP_RESULT — build the structured result. Generation ≠ video ≠ scene.
  phases.push('FIRST_CLIP_RESULT');
  const videoUuid = normalizeGeneratedVideoUuid(raw.videoUrl);
  const firstClip: FirstClipGenerationResult = {
    generationUuid: String(raw.generationUuid ?? '').trim() || null,
    videoUuid,
    videoUrl: raw.videoUrl ?? null,
    sceneId: null,
    sceneTitle: null,
    sceneRoute: null,
    durationSeconds: Number.isFinite(Number(raw.durationSeconds)) ? Number(raw.durationSeconds) : null,
    audioPresent: raw.audioPresent === true ? true : raw.audioPresent === false ? false : null,
    source: FIRST_CLIP_SOURCE,
    committed: 'AMBIGUOUS',
    classification: isSameGenerationVideoIdentity(raw.generationUuid, videoUuid)
      ? 'GENERATION_AND_VIDEO_IDENTITY_COINCIDE'
      : 'GENERATION_AND_VIDEO_IDENTITIES_DISTINCT',
  };
  if (!videoUuid) {
    return fail('FIRST_CLIP_VIDEO_UUID_UNRESOLVED', 'FIRST_CLIP_RESULT', phases,
      'the generation produced no observable /video/<UUID> first-clip identity.', mode, { firstClip, lockVerification, projectSettings });
  }

  // 6. SCENE_RESOLUTION — deterministic, never a tile count, never a guessed id.
  //    Two legitimate strategies only: a candidate that already carries the exact video uuid AND a
  //    scene id, or the EXISTING PROVEN exact-title scene opener followed by re-verification of the
  //    generated /video/<UUID> on the opened scene.
  let scene: FirstClipSceneCandidate[] = [];
  try { scene = await port.resolveFirstClipSceneCandidates(); } catch { /* classified below */ }
  const strategy = decideFirstClipSceneResolutionStrategy({
    videoUuid,
    candidates: scene,
    generatedSceneTitle: raw.generatedSceneTitle,
  });
  report.sceneResolutionStrategy = strategy.strategy;
  let identified: ReturnType<typeof identifyFirstClipScene> | null = null;
  if (strategy.strategy === 'BY_EXACT_VIDEO_UUID_AND_ID') {
    identified = identifyFirstClipScene({ videoUuid, candidates: scene });
  } else if (strategy.strategy === 'BY_EXACT_TITLE_VIA_PROVEN_OPENER') {
    const title = String(raw.generatedSceneTitle ?? '').trim();
    report.generatedSceneTitleReason = raw.generatedSceneTitleReason ?? null;
    // Navigation click: explicitly NOT a generation click, and only after generation completed.
    const navAuth = decideFirstClipClickAuthorization({
      kind: 'SCENE_RESOLUTION_NAVIGATION_CLICK',
      generationCompleted: true,
      generationClicksSoFar: Number(raw.startClicks ?? 0),
    });
    if (!navAuth.ok) {
      identified = { ok: false, code: 'SCENE_ID_UNRESOLVED', reason: navAuth.reason } as any;
    } else {
      try {
        const opened = await port.openGeneratedSceneByExactTitle(title);
        // Re-verify identity on the OPENED scene: it must carry the exact generated /video/<UUID>.
        identified = identifyFirstClipScene({
          videoUuid,
          candidates: [{ sceneId: opened?.sceneId, title, videoUuid: opened?.videoUuid, route: opened?.route }],
        });
        if (identified.ok) report.sceneResolutionVerifiedOnOpenedScene = true;
      } catch (e: any) {
        report.sceneResolutionOpenError = String(e?.message ?? e);
        identified = { ok: false, code: 'SCENE_ID_UNRESOLVED', reason: `the proven exact-title scene opener failed: ${String(e?.message ?? e)}` } as any;
      }
    }
  } else {
    identified = { ok: false, code: 'SCENE_ID_UNRESOLVED', reason: strategy.reason } as any;
  }
  phases.push('SCENE_RESOLUTION');
  if (!identified || !identified.ok) {
    return fail('FIRST_CLIP_SCENE_UNRESOLVED', 'SCENE_RESOLUTION', phases, String((identified as any)?.reason ?? 'the generated scene could not be identified.'), mode,
      { firstClip, lockVerification, projectSettings,
        sceneResolutionStrategy: String(report.sceneResolutionStrategy ?? ''),
        sceneResolutionOpenError: typeof report.sceneResolutionOpenError === 'string' ? String(report.sceneResolutionOpenError) : undefined });
  }
  firstClip.sceneId = identified.sceneId;
  firstClip.sceneTitle = identified.title || null;
  firstClip.sceneRoute = identified.route;
  firstClip.committed = 'POPULATED';

  // 7. PERSISTENCE — the EXISTING SceneCheckpoint store, decided purely and only after resolution.
  phases.push('PERSIST_FIRST_CLIP_CHECKPOINT');
  const update = decideFirstClipCheckpointUpdate({
    projectId: input.projectId,
    sceneNumber: input.sceneNumber,
    sceneId: identified.sceneId,
    sceneUrl: identified.route,
    videoUuid,
    generationUuid: firstClip.generationUuid,
    durationSeconds: firstClip.durationSeconds,
    audioPresent: firstClip.audioPresent,
    existing: input.existingCheckpoint ?? null,
  });
  if (!update.ok) {
    return fail('CLIP_PERSISTENCE_FAILED', 'PERSIST_FIRST_CLIP_CHECKPOINT', phases, update.reason, mode,
      { firstClip, sceneId: identified.sceneId, lockVerification, projectSettings });
  }
  report.checkpointChanged = update.changed;
  if (typeof port.persistFirstClipCheckpoint === 'function' && update.changed) {
    try {
      const written = await port.persistFirstClipCheckpoint(update.checkpoint);
      if (!written?.ok) {
        return fail('CLIP_PERSISTENCE_FAILED', 'PERSIST_FIRST_CLIP_CHECKPOINT', phases, String(written?.reason ?? 'checkpoint persistence failed'), mode,
          { firstClip, sceneId: identified.sceneId, lockVerification, projectSettings });
      }
    } catch (e: any) {
      return fail('CLIP_PERSISTENCE_FAILED', 'PERSIST_FIRST_CLIP_CHECKPOINT', phases, String(e?.message ?? e), mode,
        { firstClip, sceneId: identified.sceneId, lockVerification, projectSettings });
    }
  }

  // PERSIST before download: the identified scene must be proven to carry the clip.
  let committedClipId = '';
  try { committedClipId = String((await port.verifyScenePersistence(identified.sceneId, videoUuid))?.committedClipId ?? '').trim(); }
  catch (e: any) { /* classified below */ }
  if (!committedClipId) {
    return fail('CLIP_PERSISTENCE_FAILED', 'SCENE_RESOLUTION', phases,
      `the generated clip is not proven persisted on scene ${identified.sceneId}; refusing to download.`,
      mode, { firstClip, sceneId: identified.sceneId, lockVerification, projectSettings });
  }

  // 6. DOWNLOAD — only after the scene is resolved AND persistence is proven.
  phases.push('DOWNLOAD');
  try {
    const dl = await port.downloadCommittedSceneClip(input.sceneNumber, input.destinationPath, { ...(input.downloadOptions ?? {}), overwrite: input.overwrite === true });
    if (!dl?.ok) {
      return fail('DOWNLOAD_FAILED', 'DOWNLOAD', phases, String(dl?.reason ?? dl?.result ?? 'download failed'), mode,
        { firstClip, sceneId: identified.sceneId, committedClipId, lockVerification, projectSettings });
    }
  } catch (e: any) {
    return fail('DOWNLOAD_FAILED', 'DOWNLOAD', phases, String(e?.message ?? e), mode,
      { firstClip, sceneId: identified.sceneId, committedClipId, lockVerification, projectSettings });
  }

  // 7. VALIDATE.
  phases.push('VALIDATE');
  try {
    const validated = await input.validateDownloaded(input.destinationPath);
    if (!validated?.ok) {
      return fail('DOWNLOADED_CLIP_INVALID', 'VALIDATE', phases, String(validated?.reason ?? 'downloaded clip failed validation'), mode,
        { firstClip, sceneId: identified.sceneId, committedClipId, lockVerification, projectSettings });
    }
  } catch (e: any) {
    return fail('DOWNLOADED_CLIP_INVALID', 'VALIDATE', phases, String(e?.message ?? e), mode,
      { firstClip, sceneId: identified.sceneId, committedClipId, lockVerification, projectSettings });
  }

  return {
    ok: true, mode, phases, firstClip, sceneId: identified.sceneId, committedClipId,
    clipPath: input.destinationPath, lockVerification, projectSettings,
    sceneResolutionStrategy: String(report.sceneResolutionStrategy ?? ''),
    sceneResolutionVerifiedOnOpenedScene: report.sceneResolutionVerifiedOnOpenedScene === true,
    checkpointChanged: report.checkpointChanged === true,
  };
}

/**
 * The FlowClient methods this lifecycle depends on. Missing any of them fails closed at binding.
 * `resolveProjectPromptEditor` and the pure decisions are supplied by `firstClipGeneration.ts`.
 */
export const FIRST_CLIP_LIFECYCLE_FLOW_METHODS = [
  'openProjectRoute', 'configureVideoGeneration', 'observeProjectVideoSettings',
  'openSceneEditor', 'reconcileGeneratedVideoWithScene', 'downloadCommittedSceneClip',
] as const;

/** Bind an existing FlowClient to the first-clip port. Throws when a required primitive is absent. */
export function createFirstClipLifecyclePort(flow: any): FirstClipLifecyclePort {
  for (const name of FIRST_CLIP_LIFECYCLE_FLOW_METHODS) {
    if (typeof flow?.[name] !== 'function') throw new Error(`Flow client does not expose ${name}(); refusing to build the first-clip lifecycle port.`);
  }
  return {
    openProjectRoute: () => flow.openProjectRoute(),
    configureProjectVideoSettings: () => flow.configureVideoGeneration(),
    observeProjectVideoSettings: () => flow.observeProjectVideoSettings(),
    readFlowAssetIdentities: (knownSceneId?: string | null) => flow.readFlowAssetIdentitiesForFirstClip(knownSceneId ?? null),
    restoreProjectRoute: async () => {
      const r = await flow.openProjectRoute();
      const observed = await flow.page.locator('flow-prompt-box').first().isVisible().catch(() => false);
      return { url: r.url, projectSurfaceObserved: observed };
    },
    generateProjectFirstClip: (prompt: string) => flow.generateProjectFirstClip(prompt),
    resolveFirstClipSceneCandidates: () => flow.resolveFirstClipSceneCandidates(),
    openGeneratedSceneByExactTitle: async (title: string) => {
      const opened = await flow.openSceneEditor(String(title ?? '').trim());
      const derived = deriveRoutesFromMountedSceneUrl(opened.url);
      const videoUuids = await flow.readProjectGenerationVideoUuids();
      return { sceneId: derived.ok ? derived.sceneId : '', route: derived.ok ? derived.canonicalSceneUrl : String(opened.url), videoUuid: videoUuids[0] ?? null };
    },
    verifyScenePersistence: async (sceneRef: string, artifactId: string) => {
      const r = await flow.reconcileGeneratedVideoWithScene(sceneRef, artifactId);
      return { committedClipId: String(r?.committedSceneArtifactId ?? '') };
    },
    downloadCommittedSceneClip: (n: number, dest: string, opts?: Record<string, unknown>) => flow.downloadCommittedSceneClip(n, dest, opts),
  };
}