/**
 * Single-scene Flow workflow (STEP-8EJ).
 *
 * One small, resumable, fail-closed integration that processes EXACTLY ONE scene end-to-end:
 *
 *   pipeline scene → canonical Flow ingredients → (existing committed clip | one generation)
 *   → proven commit → proven 8EI download → validated local scene-####.mp4 → atomic checkpoint
 *
 * Hard guarantees:
 *   · No accidental credit spend: generation happens ONLY when decision says it is required.
 *   · At most ONE generation attempt per run; a failure checkpoints and stops (never re-clicks).
 *   · A valid existing local clip is never overwritten or deleted.
 *   · Does NOT duplicate Flow logic — reuses FlowClient for ingredients, generation,
 *     commit detection and the 8EI downloader.
 *   · No secrets in the checkpoint (no cookies, tokens, signed URLs, profile paths).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { deriveRoutesFromMountedSceneUrl, isFlowSceneId, normalizeExtractedArtifactUuid, sceneClipFilename } from './videoDecisions.js';
import { validateVideoClip } from './videoClip.js';
import {
  createFlowSceneLifecyclePort,
  runSceneProductionLifecycle,
  SCENE_LIFECYCLE_FLOW_METHODS,
  type SceneLifecycleResult,
} from './sceneProductionLifecycle.js';
import {
  decideSceneGenerationPolicy,
  type SceneCommittedEvidence,
  type SceneGenerationPolicyStopCode,
  type SceneLocalAuthorization,
} from './sceneGenerationPolicy.js';
import { hardenFlowPrompt, findResidualMachineIds, type CanonicalBackground, type CanonicalCharacter } from './flowPromptHardening.js';
import {
  beginBoundedGeneration,
  finishBoundedGeneration,
  releaseBoundedGeneration,
  classifyGenerationFailure,
  createSubmissionProbe,
  generationLedgerPath,
  policyFromEnv,
  approvalFromEnv,
  resolveGenerationPolicy,
  type BoundedAttempt,
  type FailureCategory,
  type GenerationApproval,
  type GenerationPolicy,
  type SubmissionState,
} from './generationAttempts.js';
import {
  CHARACTER_LOCKS_HEADER,
  WARDROBE_CONTINUITY_RESTRAINTS,
  buildCharacterLockBlock,
  detectWardrobeMode,
  findIdentityVariantContradictions,
  findWardrobeContradictions,
  sanitizeSceneFacingText,
  sceneCharacterTags,
  type WardrobeMode,
  type WardrobeScene,
} from './characterWardrobe.js';

/** Explicit workflow outcomes — every transition is named, never hidden. */
export type SceneWorkflowStatus =
  | 'LOCAL_CLIP_ALREADY_VALID'
  | 'FLOW_SCENE_ALREADY_COMMITTED'
  | 'FLOW_SCENE_GENERATED'
  | 'FLOW_SCENE_NOT_COMMITTED'
  | 'DOWNLOAD_SUCCESS'
  | 'DOWNLOAD_ALREADY_VALID'
  | 'INPUT_INVALID'
  | 'FLOW_GENERATION_REQUIRED'
  | 'FLOW_GENERATION_FAILED'
  | 'FLOW_COMMIT_NOT_PROVEN'
  | 'DOWNLOAD_FAILED'
  | 'VALIDATION_FAILED'
  | 'SCENE_LOCAL_EXTENSION_COMPLETE'
  | 'SCENE_LOCAL_REGENERATE_COMPLETE'
  | 'SCENE_LOCAL_GENERATION_FAILED'
  | 'SCENE_LOCAL_BLOCKED'
  /** The bounded attempt budget (or the manual-approval gate) refused another paid submission. */
  | 'FLOW_GENERATION_BLOCKED';

export interface SceneCheckpoint {
  schema_version: number;
  project_id: string;
  scene_number: number;
  flow_scene_id: string | null;
  flow_scene_url: string | null;
  generation_uuid: string | null;
  /**
   * The COMMITTED canonical scene artifact identity — a DIFFERENT identity from
   * `generation_uuid`. Attaching a generated artifact to an empty Flow scene mints a new scene
   * artifact id, so the generation uuid and the committed scene uuid are never assumed equal.
   *
   * Optional and additive: legacy checkpoints that omit it stay valid and load unchanged. Absent
   * means "the committed identity was not known at write time" — it is NEVER derived from
   * `generation_uuid` and never fabricated.
   */
  committed_scene_artifact_id?: string | null;
  local_clip_path: string | null;
  /**
   * Conservative provenance for a locally-present clip: `'human-provided-local-recovery'` means a
   * prior checkpoint proves this scene was committed in Flow and the local clip was supplied
   * locally (e.g. a manual Flow Download handoff). It is NEVER "downloaded_from_flow" — the
   * system cannot establish that for a human handoff. Absent means no such claim is made.
   */
  local_clip_provenance?: 'human-provided-local-recovery';
  local_clip_sha256: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  workflow_status: SceneWorkflowStatus;
  updated_at: string | null;
}

export const SCENE_CHECKPOINT_SCHEMA_VERSION = 1;

/** Scene numbers we are willing to process (never inferred from a title). */
export function sceneClipName(sceneNumber: unknown): string | null {
  return sceneClipFilename(sceneNumber);
}

/**
 * PURE decision precedence for one scene. Decides whether generation may happen at all.
 * Order: valid local clip > committed Flow clip > (generate only if required and allowed).
 */
export function decideSceneAction(input: {
  localClipValid: boolean;
  flowSceneCommitted: boolean;
  allowGeneration: boolean;
  generationAlreadyAttempted: boolean;
}): { action: 'USE_LOCAL'; status: SceneWorkflowStatus }
  | { action: 'DOWNLOAD'; status: SceneWorkflowStatus }
  | { action: 'GENERATE'; status: SceneWorkflowStatus }
  | { action: 'STOP'; status: SceneWorkflowStatus } {
  if (input.localClipValid) return { action: 'USE_LOCAL', status: 'LOCAL_CLIP_ALREADY_VALID' };
  if (input.flowSceneCommitted) return { action: 'DOWNLOAD', status: 'FLOW_SCENE_ALREADY_COMMITTED' };
  if (!input.allowGeneration) return { action: 'STOP', status: 'FLOW_GENERATION_REQUIRED' };
  if (input.generationAlreadyAttempted) return { action: 'STOP', status: 'FLOW_GENERATION_FAILED' };
  return { action: 'GENERATE', status: 'FLOW_GENERATION_REQUIRED' };
}

/** Precedence for the commit question: an existing committed clip beats any generation plan. */
export function decideCommitPrecedence(committed: unknown, generatedArtifact: unknown): 'ALREADY_COMMITTED' | 'GENERATED' | 'NOT_PROVEN' {
  if (committed === true) return 'ALREADY_COMMITTED';
  if (typeof generatedArtifact === 'string' && generatedArtifact.trim()) return 'GENERATED';
  return 'NOT_PROVEN';
}

/** Validate a checkpoint's shape (no secrets; deterministic). */
export function validateSceneCheckpoint(record: unknown): { ok: true } | { ok: false; reason: string } {
  if (!record || typeof record !== 'object') return { ok: false, reason: 'Checkpoint is missing or not an object.' };
  const r = record as Partial<SceneCheckpoint>;
  if (r.schema_version !== SCENE_CHECKPOINT_SCHEMA_VERSION) return { ok: false, reason: `Unsupported checkpoint schema_version ${String(r.schema_version)}.` };
  if (typeof r.project_id !== 'string' || !r.project_id.trim()) return { ok: false, reason: 'Checkpoint is missing project_id.' };
  if (!Number.isInteger(r.scene_number) || (r.scene_number as number) <= 0) return { ok: false, reason: 'Checkpoint has an invalid scene_number.' };
  if (r.local_clip_sha256 !== null && (typeof r.local_clip_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.local_clip_sha256))) return { ok: false, reason: 'Checkpoint has an invalid local_clip_sha256.' };
  // Optional, additive provenance. Absent/null is valid (legacy checkpoints). When PRESENT it must
  // be a real non-empty id. It is never compared to, or derived from, `generation_uuid`: the
  // committed scene artifact is a DISTINCT identity minted by the attach.
  if (r.committed_scene_artifact_id !== undefined && r.committed_scene_artifact_id !== null) {
    if (typeof r.committed_scene_artifact_id !== 'string' || !r.committed_scene_artifact_id.trim()) {
      return { ok: false, reason: 'Checkpoint has an invalid committed_scene_artifact_id.' };
    }
  }
  // Optional, additive provenance. Only the one conservative value is permitted; an unrecognised
  // value fails closed rather than being silently accepted as a stronger provenance claim.
  if (r.local_clip_provenance !== undefined && r.local_clip_provenance !== null) {
    if (r.local_clip_provenance !== 'human-provided-local-recovery') {
      return { ok: false, reason: `Checkpoint has an unrecognised local_clip_provenance ${JSON.stringify(r.local_clip_provenance)}.` };
    }
  }
  if (r.local_clip_path !== null && (typeof r.local_clip_path !== 'string' || path.isAbsolute(r.local_clip_path))) return { ok: false, reason: 'Checkpoint local_clip_path must be relative.' };
  // Never persist secrets. A normal project URL is permitted; blob/signed URLs and
  // credentials are not.
  if (/blob:|cookie|authorization|bearer|chrome-profile|access_token|KeyName=|Expires=/i.test(JSON.stringify(record))) {
    return { ok: false, reason: 'Checkpoint contains forbidden secret material.' };
  }
  return { ok: true };
}

/** Atomic checkpoint write (temp sibling + rename). */
export async function writeSceneCheckpoint(file: string, record: SceneCheckpoint): Promise<string> {
  const v = validateSceneCheckpoint(record);
  if (!v.ok) throw new Error(`Refusing to write an invalid checkpoint: ${v.reason}`);
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
  return file;
}

/** Load + validate a checkpoint (a malformed one is ignored, never trusted). */
export async function readSceneCheckpoint(file: string): Promise<SceneCheckpoint | null> {
  let raw: string;
  try { raw = await fsp.readFile(file, 'utf8'); } catch { return null; }
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return null; }
  return validateSceneCheckpoint(parsed).ok ? (parsed as SceneCheckpoint) : null;
}

/** Deterministic checkpoint path inside the project outputs (never inside the input asset). */
export function sceneCheckpointPath(projectId: string, sceneNumber: number, outputsRoot = 'outputs'): string {
  const id = String(projectId ?? '').trim();
  if (!id) throw new Error('sceneCheckpointPath requires a project id.');
  const n = Number(sceneNumber);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`sceneCheckpointPath requires a positive scene number (got ${String(sceneNumber)}).`);
  return path.join(path.resolve(outputsRoot), id, 'flow-scenes', `scene-${String(n).padStart(4, '0')}.json`);
}

/**
 * PURE: does this checkpoint prove the scene was already committed in Flow (or that Flow already
 * produced the local clip)?
 *
 * This is the single source of truth for "Flow owns this scene" and is deliberately local +
 * read-only: it never contacts Flow and never infers commitment. It is the reason a committed-but-
 * locally-missing scene is recovered by DOWNLOAD rather than silently replaced by a local
 * synthesis — see the adapter's render-mode dispatch.
 */
export function checkpointProvesFlowCommit(checkpoint: SceneCheckpoint | null | undefined): boolean {
  if (checkpoint === null || checkpoint === undefined) return false;
  const committedId = typeof checkpoint.committed_scene_artifact_id === 'string' ? checkpoint.committed_scene_artifact_id.trim() : '';
  if (committedId !== '') return true;
  return /^(FLOW_|DOWNLOAD_)/.test(String(checkpoint.workflow_status));
}

/** Deterministic local clip destination for a scene. */
export function sceneClipDestination(inputRoot: string, sceneNumber: number): string | null {
  const name = sceneClipFilename(sceneNumber);
  if (!name) return null;
  return path.join(path.resolve(inputRoot), 'flow-clips', name);
}

export interface ProcessSceneConfig {
  projectId: string;
  /** Absolute project input root (production/inputs/<project-id>). */
  inputRoot: string;
  /** Base outputs root for checkpoints (defaults to `outputs`). */
  outputsRoot?: string;
  /** Allow ONE generation attempt when the scene has no committed clip. Default FALSE. */
  allowGeneration?: boolean;
  ffprobePath?: string;
  downloadDir?: string;
  /**
   * Canonical `pipeline.json` asset metadata, used ONLY to resolve machine identifiers
   * (`@CHAR-*` / `#BGD-*`) into their human-readable descriptions before the prompt is
   * submitted to Flow. Missing metadata makes generation fail closed - it is never guessed.
   */
  backgrounds?: readonly CanonicalBackground[] | null;
  characters?: readonly CanonicalCharacter[] | null;
  /** Explicit contract mode. Omit for deterministic auto-detection from `characters`. */
  wardrobeMode?: WardrobeMode;
  /**
   * OPT-IN explicit authorization for exactly one existing scene to be extended or regenerated.
   * Absent/null keeps the legacy first-clip/download behaviour. This is NEVER inferred from
   * `allowGeneration`, scene existence, a URL, or a committed clip.
   */
  sceneLocalAuthorization?: SceneLocalAuthorization | null;
  /**
   * Bounded-attempt policy for paid Flow submissions (PHASE-2). Omitted values come from the
   * environment (`FLOW_MAX_ATTEMPTS_*`); the conservative defaults apply when nothing is set.
   */
  generationPolicy?: Partial<GenerationPolicy> | null;
  /**
   * Explicit operator approval for ONE recovery attempt that the ledger would otherwise refuse
   * (ambiguous/unknown submission, crash recovery, non-retryable failure, exhausted consecutive
   * failures). It never raises a ceiling — raise the policy instead.
   */
  generationApproval?: GenerationApproval | null;
}

/**
 * Explicit output restraints appended to EVERY scene prompt submitted to Flow.
 *
 * LIVE EVIDENCE (RAAT KA KHAUF): a generated scene carried the literal strings
 * "Radha Devi (@CHAR-03-RADHADEVI-ATMA)" and "Arjun (@CHAR-01-ARJUN)" burned into the frame.
 * The cause was that the RAW manifest prompt — which embeds machine identifiers by design —
 * was submitted verbatim: `hardenFlowPrompt` was wired only into the first-clip lifecycle and
 * never into this per-scene path. Identifiers are now resolved away before submission, and this
 * block states the prohibition positively so the composer is never tempted to render labels.
 *
 * Also restates the project's locked art direction, because the observed result drifted to a
 * washed-out, semi-realistic look instead of the established flat 2D cel-shaded style.
 */
export const FLOW_OUTPUT_RESTRAINTS = [
  '### OUTPUT RESTRAINTS (absolute)',
  '- NO on-screen text of any kind: no captions, no subtitles, no character names, no labels, no name tags, no identifiers, no title cards, no signage text',
  '- NO UI overlays, no interface elements, no watermarks, no logos, no brand marks',
  '- NO burned-in identifiers of any form; a character is never annotated on screen',
  '',
  '### LOCKED VISUAL STYLE (must match the established project references)',
  '2D semi-realistic cartoon illustration with bold clean outlines and smooth flat cel shading. Maintain 100% flat 2D vector-art aesthetics and realistic adult human proportions.',
  'Moody teal-blue rainy night lighting. NO photorealism, NO 3D rendering, NO CGI shading, NO oversized head or body, NO realistic skin or hair textures, NO depth-of-field that breaks the 2D plane.',
].join('\n');

export type ScenePromptBuild =
  | {
      ok: true;
      prompt: string;
      resolvedCount: number;
      /** Every resolved machine identifier, in first-seen order (used by first-clip diagnostics). */
      resolved: Array<{ kind: 'background' | 'character'; tag: string; description: string }>;
      mode: WardrobeMode;
    }
  | { ok: false; reason: string };

/**
 * PURE: produce the exact prompt text submitted to Flow for one scene.
 *
 * Order is mandatory:
 *   1. identifiers are RESOLVED (never stripped, never guessed),
 *   2. reference-sheet-only phrases are removed from the scene-facing prose,
 *   3. in strict wardrobe mode each declared character gets an authoritative CHARACTER LOCK and
 *      the prompt gets the wardrobe-continuity restraints,
 *   4. the output restraints are appended.
 *
 * A prompt that still carries a raw `#BGD-`/`@CHAR-` identity, a reference with no canonical
 * metadata, a missing strict wardrobe contract, an unknown outfit selection, or a scene-prose
 * contradiction fails closed and NO generation is attempted.
 */
export function buildFlowScenePrompt(input: {
  prompt?: unknown;
  backgrounds?: readonly CanonicalBackground[] | null;
  characters?: readonly CanonicalCharacter[] | null;
  /** The canonical scene, used for declared tags and explicit `outfit_ids`. */
  scene?: WardrobeScene | null;
  /** Explicit contract mode. Omit for deterministic auto-detection from `characters`. */
  wardrobeMode?: WardrobeMode;
} | undefined | null): ScenePromptBuild {
  const mode = input?.wardrobeMode ?? detectWardrobeMode(input?.characters);
  const scene = input?.scene ?? null;
  const hardened = hardenFlowPrompt({
    prompt: input?.prompt,
    backgrounds: input?.backgrounds ?? null,
    characters: input?.characters ?? null,
    wardrobeMode: mode,
  });
  if (!hardened.ok) return { ok: false, reason: `${hardened.code}: ${hardened.reason}` };

  const residuals = findResidualMachineIds(hardened.hardenedPrompt);
  if (residuals.length > 0) {
    return { ok: false, reason: `PROMPT_RESIDUAL_MACHINE_ID: the prompt to submit still contains ${residuals.length} identifier(s) (${residuals.join(', ')}); refusing to submit a prompt that Flow may render as an on-screen label.` };
  }

  const declared = sceneCharacterTags(scene);
  const resolvedCharacters = hardened.resolved.filter((r) => r.kind === 'character').map((r) => r.tag);
  const tags: string[] = [];
  for (const tag of [...declared, ...resolvedCharacters]) if (!tags.includes(tag)) tags.push(tag);

  let lockSection = '';
  if (mode === 'strict' && tags.length > 0) {
    const overrides = scene && typeof scene === 'object' && scene.outfit_ids && typeof scene.outfit_ids === 'object'
      ? scene.outfit_ids as Record<string, unknown>
      : {};
    for (const tag of Object.keys(overrides)) {
      if (!tags.includes(tag)) {
        return { ok: false, reason: `WARDROBE_SCENE_OVERRIDE_UNKNOWN_CHARACTER: scene selects an outfit for ${tag}, but that character is not declared in the scene or its prompt.` };
      }
    }
    const sceneForWardrobe: WardrobeScene = { ...(scene ?? {}), character_tags: tags };
    const harness = (input?.characters ?? []) as any[];
    const wardrobeIssues = [
      ...findWardrobeContradictions(sceneForWardrobe, harness, mode),
      ...findIdentityVariantContradictions(sceneForWardrobe, harness, mode),
    ];
    if (wardrobeIssues.length > 0) {
      return { ok: false, reason: `${wardrobeIssues[0].code}: ${wardrobeIssues[0].reason}` };
    }
    const blocks: string[] = [];
    for (const tag of tags) {
      const character = (input?.characters ?? []).find((c) => String(c?.tag ?? '').trim() === tag);
      if (!character) {
        return { ok: false, reason: `WARDROBE_SCHEMA_INVALID: scene declares ${tag}, but no canonical character metadata was supplied.` };
      }
      const lock = buildCharacterLockBlock(character, sceneForWardrobe, mode);
      if (!lock.ok) return { ok: false, reason: `${lock.code}: ${lock.reason}` };
      blocks.push(lock.block);
    }
    lockSection = `\n\n${CHARACTER_LOCKS_HEADER}\n${blocks.join('\n\n')}\n\n${WARDROBE_CONTINUITY_RESTRAINTS}`;
  }

  const sceneFacing = sanitizeSceneFacingText(hardened.hardenedPrompt);
  return {
    ok: true,
    prompt: `${sceneFacing}${lockSection}\n\n${FLOW_OUTPUT_RESTRAINTS}`,
    resolvedCount: hardened.resolved.length,
    resolved: hardened.resolved,
    mode,
  };
}

export interface ProcessSceneResult {
  status: SceneWorkflowStatus;
  sceneNumber: number;
  localClipPath: string | null;
  sha256: string | null;
  durationSeconds?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  detail?: string;
  checkpointPath: string;
  generationAttempts: number;
  downloads: number;
}

/** A validated explicit scene-local authorization (normalized identities). */
type ValidSceneLocalAuthorization = {
  operation: 'EXTEND' | 'REGENERATE';
  targetSceneId: string;
  expectedCommittedClipId: string;
};

type SceneLocalEvidenceResult =
  | { ok: true; evidence: SceneCommittedEvidence }
  | { ok: false; code: SceneGenerationPolicyStopCode; reason: string };

/** Fail closed before any lifecycle/editor work. */
function sceneLocalBlocked(base: ProcessSceneResult, code: string, reason: string): ProcessSceneResult {
  return {
    ...base,
    status: 'SCENE_LOCAL_BLOCKED',
    detail: `${code}: ${String(reason ?? 'scene-local authorization blocked').slice(0, 260)}`,
  };
}

/** Validate the operator's opt-in authorization BEFORE opening any target editor. */
function validateSceneLocalAuthorization(input: unknown):
  | { ok: true; authorization: ValidSceneLocalAuthorization }
  | { ok: false; code: SceneGenerationPolicyStopCode; reason: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'AUTHORIZATION_INVALID', reason: 'scene-local authorization is not an object.' };
  }
  const r = input as Record<string, unknown>;
  const operation = String(r.operation ?? '').trim();
  if (operation !== 'EXTEND' && operation !== 'REGENERATE') {
    return { ok: false, code: 'AUTHORIZATION_INVALID', reason: `scene-local operation ${JSON.stringify(r.operation)} is not EXTEND or REGENERATE.` };
  }
  const targetSceneId = String(r.targetSceneId ?? '').trim();
  if (!targetSceneId || !isFlowSceneId(targetSceneId)) {
    return { ok: false, code: 'TARGET_UNRESOLVED', reason: 'scene-local authorization has no stable target scene id.' };
  }
  const expectedCommittedClipId = normalizeExtractedArtifactUuid(r.expectedCommittedClipId) ?? '';
  if (!expectedCommittedClipId) {
    return { ok: false, code: 'COMMITTED_CLIP_UNRESOLVED', reason: 'scene-local authorization has no valid expected committed clip id.' };
  }
  return { ok: true, authorization: { operation, targetSceneId, expectedCommittedClipId } };
}

/**
 * Read trusted target identities from the pipeline record and the prior checkpoint. These are
 * CONSTRAINTS on the explicit authorization, never a substitute for it. Malformed legacy values are
 * ignored; multiple DISTINCT valid targets are ambiguous and fail closed.
 */
function trustedTargetSceneIds(scene: any, checkpoint: SceneCheckpoint | null): string[] {
  const ids = new Set<string>();
  const addId = (value: unknown) => {
    const v = typeof value === 'string' ? value.trim() : '';
    if (v && isFlowSceneId(v)) ids.add(v);
  };
  const addUrl = (value: unknown) => {
    const v = typeof value === 'string' ? value.trim() : '';
    if (!v) return;
    const derived = deriveRoutesFromMountedSceneUrl(v);
    if (derived.ok && isFlowSceneId(derived.sceneId)) ids.add(derived.sceneId);
  };
  addId(scene?.flow_scene_id);
  addUrl(scene?.flow_scene_url);
  addId(checkpoint?.flow_scene_id);
  addUrl(checkpoint?.flow_scene_url);
  return [...ids];
}

/** The full lifecycle port plus the exact-target evidence reader must be present. */
function hasSceneLocalCapabilities(flow: any): boolean {
  if (!flow || typeof flow.readCommittedSceneArtifactId !== 'function') return false;
  return SCENE_LIFECYCLE_FLOW_METHODS.every((name) => typeof flow?.[name] === 'function');
}

/**
 * OPEN THE EXACT AUTHORIZED SCENE and read its committed evidence.
 *
 * This is a READ-ONLY probe: `openSceneEditor()` never creates a scene and never generates. The
 * mounted URL is derived and compared with the authorized id BEFORE the current-scene clip readers
 * are consulted, so a current-page probe can never be mistaken for the requested scene. A failed
 * read is UNKNOWN (never ABSENT). A target that mounts to a different scene, or evidence that
 * contradicts the prior checkpoint, stops before the lifecycle can attach/generate.
 */
async function readAuthorizedSceneEvidence(
  flow: any,
  authorization: ValidSceneLocalAuthorization,
  scene: any,
  checkpoint: SceneCheckpoint | null,
): Promise<SceneLocalEvidenceResult> {
  const trusted = trustedTargetSceneIds(scene, checkpoint);
  if (trusted.length > 1) {
    return { ok: false, code: 'SCENE_STATE_AMBIGUOUS', reason: `trusted project metadata carries multiple scene ids (${trusted.join(', ')}); refusing to choose one.` };
  }
  if (trusted.length === 1 && trusted[0] !== authorization.targetSceneId) {
    return { ok: false, code: 'TARGET_MISMATCH', reason: `trusted project metadata names scene ${trusted[0]} but the authorization names ${authorization.targetSceneId}.` };
  }

  let opened: { url?: string } | undefined;
  try {
    opened = await flow.openSceneEditor(authorization.targetSceneId);
  } catch (e: any) {
    return { ok: false, code: 'SCENE_STATE_UNKNOWN', reason: `the exact target scene could not be opened: ${String(e?.message ?? e).slice(0, 200)}` };
  }

  const mounted = deriveRoutesFromMountedSceneUrl(opened?.url);
  if (!mounted.ok) {
    return { ok: false, code: 'TARGET_UNRESOLVED', reason: `the opened editor did not expose a stable scene route: ${mounted.reason}` };
  }
  if (mounted.sceneId !== authorization.targetSceneId) {
    return { ok: false, code: 'TARGET_MISMATCH', reason: `requested scene ${authorization.targetSceneId} but the editor mounted ${mounted.sceneId}.` };
  }

  let hasClip: boolean;
  try {
    hasClip = (await flow.sceneHasClip()) === true;
  } catch (e: any) {
    return { ok: false, code: 'SCENE_STATE_UNKNOWN', reason: `the exact target scene clip state could not be read: ${String(e?.message ?? e).slice(0, 200)}` };
  }
  if (!hasClip) {
    return { ok: true, evidence: { state: 'ABSENT', sceneId: authorization.targetSceneId } };
  }

  let observedClipId = '';
  try {
    observedClipId = normalizeExtractedArtifactUuid(await flow.readCommittedSceneArtifactId()) ?? '';
  } catch (e: any) {
    return { ok: false, code: 'SCENE_STATE_UNKNOWN', reason: `the exact committed clip id could not be read: ${String(e?.message ?? e).slice(0, 200)}` };
  }
  if (!observedClipId) {
    return { ok: false, code: 'SCENE_STATE_UNKNOWN', reason: 'the target scene reports a clip but exposes no stable committed clip id; refusing to guess.' };
  }

  const priorRaw = checkpoint?.committed_scene_artifact_id;
  if (priorRaw !== undefined && priorRaw !== null && String(priorRaw).trim() !== '') {
    const priorClipId = normalizeExtractedArtifactUuid(priorRaw);
    if (!priorClipId) {
      return { ok: false, code: 'COMMITTED_CLIP_UNRESOLVED', reason: 'the prior checkpoint contains an invalid committed clip id.' };
    }
    if (priorClipId !== observedClipId) {
      return { ok: false, code: 'COMMITTED_CLIP_MISMATCH', reason: `the prior checkpoint clip ${priorClipId} does not match the live committed clip ${observedClipId}.` };
    }
  }

  return {
    ok: true,
    evidence: { state: 'PRESENT', sceneId: authorization.targetSceneId, committedClipId: observedClipId },
  };
}

/**
 * Reserve ONE paid submission for a scene against the shared persistent ledger.
 *
 * All credit-free validation is expected to have run before this is called; the reservation happens
 * only when the scene is genuinely about to submit. A denial is fail-closed and writes nothing.
 */
export async function beginSceneGenerationAttempt(
  config: ProcessSceneConfig,
  sceneNumber: number,
) {
  const policy = resolveGenerationPolicy({ ...policyFromEnv(), ...(config.generationPolicy ?? {}) });
  return beginBoundedGeneration({
    ledgerFile: generationLedgerPath({ projectId: config.projectId, outputsRoot: config.outputsRoot ?? 'outputs' }),
    projectId: config.projectId,
    subject: { kind: 'scene', id: String(sceneNumber), sceneNumber },
    policy,
    approval: config.generationApproval ?? approvalFromEnv(),
  });
}

/**
 * Process EXACTLY ONE scene. `flow` is the existing FlowClient (or a compatible stub in tests).
 * Generation is opt-in and capped at ONE attempt; everything else is idempotent.
 */
export async function processSingleFlowScene(
  scene: any,
  flow: any,
  config: ProcessSceneConfig,
): Promise<ProcessSceneResult> {
  const sceneNumber = Number(scene?.scene_number);
  const name = sceneClipFilename(sceneNumber);
  const checkpointPath = sceneCheckpointPath(config.projectId, sceneNumber, config.outputsRoot ?? 'outputs');
  const base: ProcessSceneResult = { status: 'VALIDATION_FAILED', sceneNumber, localClipPath: null, sha256: null, checkpointPath, generationAttempts: 0, downloads: 0 };

  if (!name) return { ...base, status: 'INPUT_INVALID', detail: `Invalid scene number ${String(scene?.scene_number)}.` };

  const dest = sceneClipDestination(config.inputRoot, sceneNumber);
  if (!dest) return { ...base, status: 'INPUT_INVALID', detail: 'Could not derive the destination clip path.' };

  // 1. Is there already a VALID local clip? (never overwrite a valid artifact)
  const existing = await validateVideoClip(dest, { ffprobePath: config.ffprobePath });
  const localClipValid = existing.state === 'VALID';

  // 1b. Prior checkpoint provenance (read-only, local only). Carried forward so a manual
  //     Flow-clip handoff recovered across a process restart does not lose the fact that this
  //     scene was committed in Flow. Never written unless a real prior value exists.
  const priorCheckpoint = await readSceneCheckpoint(checkpointPath);
  const priorCommittedId = typeof priorCheckpoint?.committed_scene_artifact_id === 'string' && priorCheckpoint.committed_scene_artifact_id.trim()
    ? priorCheckpoint.committed_scene_artifact_id
    : null;
  /**
   * Conservative, provable signal that this local clip is the human recovery of a Flow-committed
   * scene. Set ONLY when a prior checkpoint already proves Flow commitment — never inferred, never
   * asserted for a clip this workflow did not download. Deliberately NOT named
   * "downloaded_from_flow": the system cannot establish that provenance for a human handoff.
   */
  const priorProvesFlowCommit = checkpointProvesFlowCommit(priorCheckpoint);

  // 1c. EXPLICIT scene-local authorization is a SEPARATE opt-in path. It is never inferred from
  //     `allowGeneration`, scene existence, the prior checkpoint, or a committed clip. When it is
  //     supplied, it either runs the exact target through the reference-aware lifecycle or stops;
  //     it NEVER falls through to first-clip project generation.
  if (config.sceneLocalAuthorization !== undefined && config.sceneLocalAuthorization !== null) {
    if (localClipValid) {
      return sceneLocalBlocked(base, 'LOCAL_CLIP_PRESENT', 'a valid local clip is present; refusing to overwrite it with scene-local generation.');
    }
    if (config.allowGeneration !== true) {
      return sceneLocalBlocked(base, 'GENERATION_NOT_AUTHORIZED', 'scene-local generation requires explicit run-level generation permission.');
    }
    if (!hasSceneLocalCapabilities(flow)) {
      return sceneLocalBlocked(base, 'SCENE_LOCAL_UNAVAILABLE', 'the Flow client does not expose the complete scene-local lifecycle and exact-target evidence methods.');
    }

    const validated = validateSceneLocalAuthorization(config.sceneLocalAuthorization);
    if (!validated.ok) return sceneLocalBlocked(base, validated.code, validated.reason);

    // Build the prompt and required-asset contract BEFORE opening any editor. A defective prompt or
    // missing asset metadata costs zero Flow work.
    const narrator = scene?.speaker === 'NARRATOR' || scene?.speaker === 'none';
    const prompt = String((narrator ? scene?.animation_prompt_NARRATOR_ONLY : scene?.animation_prompt_WITH_lipsync) ?? '').trim();
    if (!prompt) return { ...base, status: 'INPUT_INVALID', detail: 'The scene has no animation prompt to generate from.' };

    const backgroundTag = String(scene?.background_tag ?? '').trim();
    if (!backgroundTag) return { ...base, status: 'INPUT_INVALID', detail: 'The scene has no background tag for scene-local generation.' };
    const characterTags = (Array.isArray(scene?.character_tags) ? scene.character_tags : [])
      .map((t: unknown) => String(t ?? '').trim())
      .filter(Boolean);
    const requiredCharacters = (config.characters ?? [])
      .map((c: any) => String(c?.tag ?? '').trim())
      .filter(Boolean);
    const requiredBackgrounds = (config.backgrounds ?? [])
      .map((b: any) => String(b?.tag ?? '').trim())
      .filter(Boolean);
    if (requiredCharacters.length === 0 || requiredBackgrounds.length === 0) {
      return sceneLocalBlocked(base, 'ASSET_LOCKS_NOT_VERIFIED', 'canonical character/background metadata is required for scene-local asset verification.');
    }

    const built = buildFlowScenePrompt({
      prompt,
      backgrounds: config.backgrounds ?? null,
      characters: config.characters ?? null,
      scene,
      wardrobeMode: config.wardrobeMode,
    });
    if (!built.ok) return { ...base, status: 'INPUT_INVALID', detail: built.reason.slice(0, 200) };

    const evidenceResult = await readAuthorizedSceneEvidence(flow, validated.authorization, scene, priorCheckpoint);
    if (!evidenceResult.ok) return sceneLocalBlocked(base, evidenceResult.code, evidenceResult.reason);

    const policy = decideSceneGenerationPolicy({
      localClipValid: false,
      committed: evidenceResult.evidence,
      allowGeneration: true,
      sceneLocalAvailable: true,
      sceneLocalAuthorization: validated.authorization,
    });
    if (policy.action === 'STOP') return sceneLocalBlocked(base, policy.code, policy.reason);
    if (policy.action !== 'SCENE_LOCAL_EXTENSION' && policy.action !== 'SCENE_LOCAL_REGENERATE') {
      return sceneLocalBlocked(base, 'AUTHORIZATION_INVALID', `policy returned ${policy.action}; explicit scene-local authorization never falls back to first-clip generation.`);
    }
    if (evidenceResult.evidence.state !== 'PRESENT') {
      return sceneLocalBlocked(base, 'SCENE_STATE_AMBIGUOUS', 'scene-local policy authorized generation without PRESENT committed evidence.');
    }

    // The lifecycle is now one click away from a paid submission: reserve it against the SAME
    // persistent budget the project-composer path uses. A refusal stops before any browser work.
    const attempt = await beginSceneGenerationAttempt(config, sceneNumber);
    if (!attempt.ok) {
      return sceneLocalBlocked(base, 'GENERATION_BLOCKED', `${attempt.code}: ${attempt.reason}`);
    }
    const handle: BoundedAttempt = attempt.handle;
    const probe = createSubmissionProbe(flow);

    let port: ReturnType<typeof createFlowSceneLifecyclePort>;
    try {
      port = createFlowSceneLifecyclePort(flow, { assetVerificationSceneId: validated.authorization.targetSceneId });
    } catch (e: any) {
      await releaseBoundedGeneration({ handle, reason: 'the scene-local lifecycle port could not be built before any submission.' });
      return sceneLocalBlocked(base, 'SCENE_LOCAL_UNAVAILABLE', `scene-local lifecycle port could not be built: ${String(e?.message ?? e).slice(0, 200)}`);
    }

    let lifecycle: SceneLifecycleResult;
    try {
      lifecycle = await runSceneProductionLifecycle(port, {
        sceneNumber,
        targetSceneId: validated.authorization.targetSceneId,
        prompt: built.prompt,
        backgroundTag,
        characterTags,
        destinationPath: dest,
        requiredAssets: { characters: requiredCharacters, backgrounds: requiredBackgrounds },
        visibleAssets: { characters: [], backgrounds: [] },
        readOk: false,
        generationAuthorized: true,
        localClipValid: false,
        committedClipPresent: true,
        sceneLocalAuthorization: validated.authorization,
        observedCommittedClipId: evidenceResult.evidence.committedClipId,
        validateDownloaded: async (p: string) => {
          const meta = await validateVideoClip(p, { ffprobePath: config.ffprobePath });
          return meta.state === 'VALID'
            ? { ok: true, ...meta }
            : { ok: false, reason: meta.reason ?? `downloaded clip state ${meta.state}`, ...meta };
        },
        overwrite: false,
        downloadOptions: { ffprobePath: config.ffprobePath, downloadDir: config.downloadDir },
      });
    } catch (e: any) {
      const detail = String(e?.message ?? e).slice(0, 260);
      const classification = classifyGenerationFailure({ error: e, submitted: probe.read() });
      await finishBoundedGeneration({ handle, outcome: 'FAILED', category: classification.category, submission: classification.submission, reason: detail });
      return { ...base, status: 'SCENE_LOCAL_GENERATION_FAILED', detail };
    }

    const generationAttempts = lifecycle.phases.includes('GENERATE') ? 1 : 0;
    if (!lifecycle.ok) {
      const detail = `${lifecycle.code ?? 'FAILED'}@${lifecycle.phase ?? '-'}: ${String(lifecycle.reason ?? 'scene-local lifecycle failed').slice(0, 220)}`;
      const submitted = probe.read();
      if (!lifecycle.phases.includes('GENERATE') && submitted === false) {
        // Proven no-submit: the budget is untouched, exactly as if the attempt never happened.
        await releaseBoundedGeneration({ handle, reason: detail });
      } else {
        const classification = classifyGenerationFailure({ error: detail, submitted });
        await finishBoundedGeneration({ handle, outcome: 'FAILED', category: classification.category, submission: classification.submission, reason: detail });
      }
      return {
        ...base,
        status: 'SCENE_LOCAL_GENERATION_FAILED',
        generationAttempts,
        detail,
      };
    }

    // The lifecycle has already validated the downloaded media, but re-read the exact contract here
    // so the checkpoint and the workflow result are both derived from the file on disk.
    const localMeta = await validateVideoClip(dest, { ffprobePath: config.ffprobePath });
    if (localMeta.state !== 'VALID') {
      await finishBoundedGeneration({
        handle,
        outcome: 'FAILED',
        category: 'UNKNOWN',
        submission: 'SUBMITTED_CONFIRMED',
        reason: `downloaded scene-local clip is ${localMeta.state}`,
      });
      return { ...base, status: 'SCENE_LOCAL_GENERATION_FAILED', generationAttempts, detail: `downloaded scene-local clip is ${localMeta.state}: ${String(localMeta.reason ?? '').slice(0, 180)}` };
    }

    await writeSceneCheckpoint(checkpointPath, {
      schema_version: SCENE_CHECKPOINT_SCHEMA_VERSION,
      project_id: config.projectId,
      scene_number: sceneNumber,
      flow_scene_id: validated.authorization.targetSceneId,
      flow_scene_url: scene?.flow_scene_url ?? null,
      generation_uuid: lifecycle.artifactId ?? null,
      committed_scene_artifact_id: lifecycle.committedClipId ?? null,
      local_clip_path: `flow-clips/${name}`,
      local_clip_sha256: localMeta.sha256 ?? null,
      duration_seconds: localMeta.durationSeconds ?? null,
      width: localMeta.video?.width ?? null,
      height: localMeta.video?.height ?? null,
      video_codec: localMeta.video?.codec ?? null,
      audio_codec: localMeta.audio?.codec ?? null,
      workflow_status: 'DOWNLOAD_SUCCESS',
      updated_at: new Date().toISOString(),
    });

    await finishBoundedGeneration({
      handle,
      outcome: 'SUCCEEDED',
      submission: 'SUBMITTED_CONFIRMED',
      clipDownloaded: true,
      validationPassed: true,
    });

    return {
      ...base,
      status: policy.action === 'SCENE_LOCAL_EXTENSION' ? 'SCENE_LOCAL_EXTENSION_COMPLETE' : 'SCENE_LOCAL_REGENERATE_COMPLETE',
      localClipPath: dest,
      sha256: localMeta.sha256 ?? null,
      durationSeconds: localMeta.durationSeconds,
      width: localMeta.video?.width,
      height: localMeta.video?.height,
      videoCodec: localMeta.video?.codec,
      audioCodec: localMeta.audio?.codec,
      generationAttempts: 1,
      downloads: 1,
      detail: `scene-local ${policy.operation} complete via the reference-aware lifecycle (scene ${validated.authorization.targetSceneId}, committed ${validated.authorization.expectedCommittedClipId}).`,
    };
  }

  // 2. Is the Flow scene already committed? (read-only; no generation)
  //
  // Flow is consulted ONLY when local media is unusable. `decideSceneAction()` ignores
  // `flowSceneCommitted` whenever `localClipValid` is true, so probing Flow on that branch is
  // pure overhead AND would make a recovered/human-supplied clip require a live Flow round-trip
  // (browser context, possible credits). Recovery and resume must never contact Flow.
  let committed = false;
  if (!localClipValid && flow?.sceneHasClip) {
    committed = await flow.sceneHasClip().catch(() => false);
  }

  /**
   * READ-ONLY provenance: the COMMITTED scene artifact id, when the client can genuinely resolve
   * it. This is a DIFFERENT identity from `generation_uuid` — attaching a generated artifact to an
   * empty scene mints a new scene artifact id. Returns null when unavailable; the field is then
   * simply ABSENT from the checkpoint. It is never derived from, or assumed equal to, the
   * generation uuid, and never fabricated.
   */
  const readCommittedId = async (): Promise<string | null> => {
    if (typeof flow?.readCommittedSceneArtifactId !== 'function') return null;
    try {
      const id = await flow.readCommittedSceneArtifactId();
      return typeof id === 'string' && id.trim() ? id.trim() : null;
    } catch { return null; }
  };
  /** Spread into a checkpoint only when a real id was resolved — otherwise the key is omitted. */
  const committedField = async (): Promise<{ committed_scene_artifact_id?: string; local_clip_provenance?: 'human-provided-local-recovery' }> => {
    const id = await readCommittedId();
    return id ? { committed_scene_artifact_id: id } : {};
  };

  const decision = decideSceneAction({
    localClipValid,
    flowSceneCommitted: committed,
    allowGeneration: config.allowGeneration === true,
    generationAlreadyAttempted: false,
  });

  if (decision.action === 'USE_LOCAL') {
    const meta = await validateVideoClip(dest, { ffprobePath: config.ffprobePath });
    const checkpoint: SceneCheckpoint = {
      schema_version: SCENE_CHECKPOINT_SCHEMA_VERSION, project_id: config.projectId, scene_number: sceneNumber,
      flow_scene_id: scene?.flow_scene_id ?? null, flow_scene_url: scene?.flow_scene_url ?? null, generation_uuid: null,
      local_clip_path: `flow-clips/${name}`, local_clip_sha256: meta.sha256 ?? null,
      duration_seconds: meta.durationSeconds ?? null, width: meta.video?.width ?? null, height: meta.video?.height ?? null,
      video_codec: meta.video?.codec ?? null, audio_codec: meta.audio?.codec ?? null,
      ...(priorCommittedId ? { committed_scene_artifact_id: priorCommittedId } : {}),
      ...(priorProvesFlowCommit ? { local_clip_provenance: 'human-provided-local-recovery' as const } : {}),
      workflow_status: 'LOCAL_CLIP_ALREADY_VALID', updated_at: new Date().toISOString(),
    };
    await writeSceneCheckpoint(checkpointPath, checkpoint);
    return { ...base, status: 'LOCAL_CLIP_ALREADY_VALID', localClipPath: dest, sha256: meta.sha256 ?? null, durationSeconds: meta.durationSeconds, width: meta.video?.width, height: meta.video?.height, videoCodec: meta.video?.codec, audioCodec: meta.audio?.codec };
  }

  if (decision.action === 'STOP') {
    await writeSceneCheckpoint(checkpointPath, {
      schema_version: SCENE_CHECKPOINT_SCHEMA_VERSION, project_id: config.projectId, scene_number: sceneNumber,
      flow_scene_id: scene?.flow_scene_id ?? null, flow_scene_url: scene?.flow_scene_url ?? null, generation_uuid: null,
      local_clip_path: null, local_clip_sha256: null, duration_seconds: null, width: null, height: null,
      video_codec: null, audio_codec: null, workflow_status: 'FLOW_GENERATION_REQUIRED', updated_at: new Date().toISOString(),
    });
    return { ...base, status: 'FLOW_GENERATION_REQUIRED', detail: 'The scene has no committed Flow clip and generation is not authorised for this run.' };
  }

  // DOWNLOAD path: the Flow scene is ALREADY committed — never generate on this branch.
  if (decision.action === 'DOWNLOAD') {
    if (typeof flow?.downloadCommittedSceneClip !== 'function') {
      return { ...base, status: 'DOWNLOAD_FAILED', detail: 'The Flow client does not expose downloadCommittedSceneClip.' };
    }
    const dl0 = await flow.downloadCommittedSceneClip(sceneNumber, dest, { ffprobePath: config.ffprobePath, downloadDir: config.downloadDir });
    if (!dl0?.ok) {
      return { ...base, status: 'DOWNLOAD_FAILED', detail: String(dl0?.reason ?? dl0?.result ?? 'download failed').slice(0, 200) };
    }
    const meta0 = await validateVideoClip(dest, { ffprobePath: config.ffprobePath });
    await writeSceneCheckpoint(checkpointPath, {
      schema_version: SCENE_CHECKPOINT_SCHEMA_VERSION, project_id: config.projectId, scene_number: sceneNumber,
      flow_scene_id: scene?.flow_scene_id ?? null, flow_scene_url: scene?.flow_scene_url ?? null, generation_uuid: null,
      local_clip_path: `flow-clips/${name}`, local_clip_sha256: meta0.sha256 ?? null,
      duration_seconds: meta0.durationSeconds ?? null, width: meta0.video?.width ?? null, height: meta0.video?.height ?? null,
      video_codec: meta0.video?.codec ?? null, audio_codec: meta0.audio?.codec ?? null,
      ...(await committedField()),
      workflow_status: 'FLOW_SCENE_ALREADY_COMMITTED', updated_at: new Date().toISOString(),
    });
    return { ...base, status: 'FLOW_SCENE_ALREADY_COMMITTED', localClipPath: dest, sha256: meta0.sha256 ?? null, durationSeconds: meta0.durationSeconds, width: meta0.video?.width, height: meta0.video?.height, videoCodec: meta0.video?.codec, audioCodec: meta0.audio?.codec, downloads: 1 };
  }

  // GENERATE path: exactly ONE paid submission, reserved against the persistent attempt budget.
  const generationAttempts = 1;
  let generated: { title: string; artifactId: string } | null = null;

  const narrator = scene?.speaker === 'NARRATOR' || scene?.speaker === 'none';
  // Field name is `animation_prompt_WITH_lipsync` (lowercase `sync`) — matches runner.ts.
  const prompt = String((narrator ? scene?.animation_prompt_NARRATOR_ONLY : scene?.animation_prompt_WITH_lipsync) ?? '').trim();
  if (!prompt) return { ...base, status: 'INPUT_INVALID', detail: 'The scene has no animation prompt to generate from.' };
  // Resolve every machine identifier into its canonical human description and append the
  // explicit output restraints BEFORE submitting. Submitting the raw manifest prompt is what
  // caused Flow to render "@CHAR-03-RADHADEVI-ATMA" as a burned-in caption (see
  // FLOW_OUTPUT_RESTRAINTS). Fails closed, so a defective prompt costs zero credits.
  const built = buildFlowScenePrompt({
    prompt,
    backgrounds: config.backgrounds ?? null,
    characters: config.characters ?? null,
    scene,
    wardrobeMode: config.wardrobeMode,
  });
  if (!built.ok) return { ...base, status: 'INPUT_INVALID', detail: built.reason.slice(0, 200) };

  // Every credit-free check has passed. Reserve the attempt IMMEDIATELY before the submission so a
  // refusal cannot consume budget and a crash leaves a durable IN_PROGRESS marker that fails closed.
  const attempt = await beginSceneGenerationAttempt(config, sceneNumber);
  if (!attempt.ok) {
    return {
      ...base,
      status: 'FLOW_GENERATION_BLOCKED',
      detail: `${attempt.code}: ${attempt.reason}`,
    };
  }
  const handle: BoundedAttempt = attempt.handle;
  const probe = createSubmissionProbe(flow);

  /** Close the reserved attempt exactly once, recording what really happened. */
  const closeAttempt = async (
    outcome: 'SUCCEEDED' | 'FAILED',
    detail: string | null,
    opts: { category?: FailureCategory; submission?: SubmissionState; clipDownloaded?: boolean; validationPassed?: boolean } = {},
  ): Promise<void> => {
    await finishBoundedGeneration({
      handle,
      outcome,
      category: outcome === 'SUCCEEDED' ? 'NONE' : (opts.category ?? 'UNKNOWN'),
      submission: opts.submission ?? (outcome === 'SUCCEEDED' ? 'SUBMITTED_CONFIRMED' : 'SUBMISSION_UNKNOWN'),
      reason: detail,
      clipDownloaded: opts.clipDownloaded === true,
      validationPassed: opts.validationPassed === true,
    });
  };

  try {
    generated = await flow.generateProjectVideo(built.prompt);
  } catch (e: any) {
    const detail = String(e?.message ?? e).slice(0, 200);
    const classification = classifyGenerationFailure({ error: e, submitted: probe.read() });
    await closeAttempt('FAILED', detail, { category: classification.category, submission: classification.submission });
    await writeSceneCheckpoint(checkpointPath, {
      schema_version: SCENE_CHECKPOINT_SCHEMA_VERSION, project_id: config.projectId, scene_number: sceneNumber,
      flow_scene_id: scene?.flow_scene_id ?? null, flow_scene_url: scene?.flow_scene_url ?? null, generation_uuid: null,
      local_clip_path: null, local_clip_sha256: null, duration_seconds: null, width: null, height: null,
      video_codec: null, audio_codec: null, workflow_status: 'FLOW_GENERATION_FAILED', updated_at: new Date().toISOString(),
    });
    return { ...base, status: 'FLOW_GENERATION_FAILED', generationAttempts, detail };
  }

  // Commit verification: generation success ≠ committed.
  const precedence = decideCommitPrecedence(false, generated?.artifactId);
  if (precedence !== 'GENERATED') {
    await closeAttempt('FAILED', 'No generated artifact id was returned.', { category: 'UNKNOWN', submission: 'SUBMITTED_CONFIRMED' });
    return { ...base, status: 'FLOW_COMMIT_NOT_PROVEN', generationAttempts, detail: 'No generated artifact id was returned.' };
  }
  let nowCommitted = false;
  if (flow?.sceneHasClip) nowCommitted = await flow.sceneHasClip().catch(() => false);
  if (!nowCommitted) {
    await closeAttempt('FAILED', `Generated ${generated!.artifactId} but the scene did not commit a clip.`, { category: 'UNKNOWN', submission: 'SUBMITTED_CONFIRMED' });
    await writeSceneCheckpoint(checkpointPath, {
      schema_version: SCENE_CHECKPOINT_SCHEMA_VERSION, project_id: config.projectId, scene_number: sceneNumber,
      flow_scene_id: scene?.flow_scene_id ?? null, flow_scene_url: scene?.flow_scene_url ?? null, generation_uuid: generated!.artifactId,
      local_clip_path: null, local_clip_sha256: null, duration_seconds: null, width: null, height: null,
      video_codec: null, audio_codec: null, workflow_status: 'FLOW_SCENE_NOT_COMMITTED', updated_at: new Date().toISOString(),
    });
    return { ...base, status: 'FLOW_SCENE_NOT_COMMITTED', generationAttempts, detail: `Generated ${generated!.artifactId} but the scene did not commit a clip.` };
  }

  // DOWNLOAD via the proven 8EI implementation (never duplicated here).
  if (typeof flow.downloadCommittedSceneClip !== 'function') {
    await closeAttempt('FAILED', 'The Flow client does not expose downloadCommittedSceneClip.', { category: 'UNKNOWN', submission: 'SUBMITTED_CONFIRMED' });
    return { ...base, status: 'DOWNLOAD_FAILED', generationAttempts, detail: 'The Flow client does not expose downloadCommittedSceneClip.' };
  }
  const dl = await flow.downloadCommittedSceneClip(sceneNumber, dest, { ffprobePath: config.ffprobePath, downloadDir: config.downloadDir });
  if (!dl?.ok) {
    const detail = String(dl?.reason ?? dl?.result ?? 'download failed').slice(0, 200);
    await closeAttempt('FAILED', detail, { category: 'RETRYABLE', submission: 'SUBMITTED_CONFIRMED' });
    return { ...base, status: 'DOWNLOAD_FAILED', generationAttempts, detail };
  }
  const meta = await validateVideoClip(dest, { ffprobePath: config.ffprobePath });
  await writeSceneCheckpoint(checkpointPath, {
    schema_version: SCENE_CHECKPOINT_SCHEMA_VERSION, project_id: config.projectId, scene_number: sceneNumber,
    flow_scene_id: scene?.flow_scene_id ?? null, flow_scene_url: scene?.flow_scene_url ?? null, generation_uuid: generated!.artifactId,
    local_clip_path: `flow-clips/${name}`, local_clip_sha256: meta.sha256 ?? null,
    duration_seconds: meta.durationSeconds ?? null, width: meta.video?.width ?? null, height: meta.video?.height ?? null,
    video_codec: meta.video?.codec ?? null, audio_codec: meta.audio?.codec ?? null,
    ...(await committedField()),
    workflow_status: 'DOWNLOAD_SUCCESS', updated_at: new Date().toISOString(),
  });
  await closeAttempt('SUCCEEDED', null, {
    submission: 'SUBMITTED_CONFIRMED',
    clipDownloaded: true,
    validationPassed: meta.state === 'VALID',
  });
  return { ...base, status: 'DOWNLOAD_SUCCESS', localClipPath: dest, sha256: meta.sha256 ?? null, durationSeconds: meta.durationSeconds, width: meta.video?.width, height: meta.video?.height, videoCodec: meta.video?.codec, audioCodec: meta.audio?.codec, generationAttempts, downloads: 1 };
}
