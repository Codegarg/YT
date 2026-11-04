/**
 * Per-scene input readiness + render key (STEP-8DE).
 *
 * Turns a pipeline scene into a deterministic readiness record: what inputs it needs, what is
 * present/valid, how its duration resolves, and which render mode applies. NO rendering, NO
 * mutation, NO Flow. Works for any valid pipeline (2–35 scenes); scene identity is always
 * `scene_number`.
 *
 * Reuses:
 *   · characterAsset.ts      → character validation + naming
 *   · assetCache.ts          → background validation rules
 *   · narrationDuration.ts   → narration duration (ffprobe)
 *   · videoClip.ts           → supplied clip validation
 *   · sceneCompositionPlanner.ts → scene classification (narration/dialogue/mixed)
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { getCharacterAsset, characterAssetPath, requestedTagExtension } from './characterAsset.js';
import { safeTagStem, readPngDimensions, isAspectCompatible, meetsMinimumResolution } from './assetCache.js';
import { resolveSceneNarrationDuration, mapNarrationFiles } from './narrationDuration.js';
import { validateVideoClip } from './videoClip.js';
import { classifyNarration, type NarrationKind } from './sceneCompositionPlanner.js';
import { decideNarrationPreservation, narrationExceedsClip, NARRATION_LEGACY_EXEMPT_SCENES } from './narrationDurationPolicy.js';

/** Bump when the renderer's input contract changes — invalidates all render keys. */
export const RENDERER_CONTRACT_VERSION = '8de-1';

export type RenderMode = 'LOCAL_SYNTHESIS' | 'SUPPLIED_VIDEO' | 'AUTO' | 'NONE';
export type SceneReadiness = 'READY' | 'WAITING_FOR_BACKGROUND' | 'WAITING_FOR_CHARACTER_ASSET' | 'WAITING_FOR_NARRATION' | 'WAITING_FOR_VIDEO_CLIP' | 'INVALID';

export type ReasonCode =
  | 'MISSING' | 'INVALID' | 'AMBIGUOUS' | 'UNSUPPORTED'
  | 'DURATION_UNRESOLVED' | 'DURATION_CONFLICT' | 'NO_LOCAL_DIALOGUE_AUDIO'
  /**
   * STRICT local-synthesis policy: a valid supplied video clip is mandatory for this scene under the
   * default production policy. Recorded so diagnostics can distinguish "policy forbids local synthesis
   * here" from a genuinely missing asset.
   */
  | 'SUPPLIED_VIDEO_REQUIRED';

export type DurationProvenance = 'supplied-video' | 'pipeline' | 'narration' | 'unresolved';

/**
 * Narration-preservation diagnostic, present ONLY when a scene's narration exceeds its supplied
 * clip. It describes the ASSEMBLED picture length the downstream mixer will use; it deliberately
 * does NOT change `durationSeconds` or `durationProvenance`, which continue to report the
 * authoritative source clip, and it never participates in `renderKey`.
 */
export interface SceneNarrationPreservationSummary {
  sourceVideoDuration: number | null;
  narrationDuration: number | null;
  requiredOutputDuration: number | null;
  stretchFactor: number | null;
  /** True when the slowdown is inside `MAX_NARRATION_VIDEO_STRETCH` and the scene may proceed. */
  withinLimit: boolean;
  policy: string;
  /** Populated only when the scene failed closed. */
  detail: string | null;
}

export interface SceneInputInspection {
  sceneNumber: number;
  title: string;
  narration: NarrationKind;
  requiresNarration: boolean;
  backgroundTag: string | null;
  characterTags: string[];
  background: { state: 'VALID' | 'MISSING' | 'INVALID' | 'UNSUPPORTED'; path: string | null; sha256?: string; width?: number; height?: number; reason?: string };
  characters: Array<{ tag: string; state: string; path: string | null; sha256?: string; reason?: string }>;
  narrationAsset: { state: 'VALID' | 'MISSING' | 'INVALID' | 'AMBIGUOUS' | 'NOT_REQUIRED'; path: string | null; durationSeconds?: number; sha256?: string; reason?: string };
  suppliedClip: { state: 'VALID' | 'MISSING' | 'INVALID' | 'UNSUPPORTED'; path: string | null; durationSeconds?: number; sha256?: string; reason?: string };
  durationSeconds: number | null;
  durationProvenance: DurationProvenance;
  renderMode: RenderMode;
  readiness: SceneReadiness;
  reasons: ReasonCode[];
  renderKey: string;
  /**
   * Narration-preservation diagnostic. Present ONLY when the scene's narration is longer than its
   * supplied clip; `undefined` otherwise. Never affects readiness on its own, never changes
   * `durationSeconds` / `durationProvenance`, and never participates in `renderKey`.
   */
  narrationPreservation?: SceneNarrationPreservationSummary;
}

export interface SceneStateOptions {
  /** Absolute project input root (production/inputs/<project-id>). */
  inputRoot: string;
  /** Explicit ffprobe path (defaults to FFPROBE_PATH / PATH). */
  ffprobePath?: string;
  /**
   * Local-synthesis policy. Defaults to `'STRICT'` (fail closed for EVERY scene).
   * Absent/unknown values are treated as `'STRICT'`, so a caller can never fail open by omission.
   */
  localSynthesisPolicy?: LocalSynthesisPolicy;
}

/**
 * Production visual policy for LOCAL_SYNTHESIS.
 *
 * · `STRICT` (DEFAULT) — EVERY scene MUST have a valid supplied video clip, with no exception for
 *   scene type. Character scenes and background-only scenes alike fail closed without one:
 *   `renderMode = 'NONE'`, `readiness = 'WAITING_FOR_VIDEO_CLIP'`, reason
 *   `SUPPLIED_VIDEO_REQUIRED`. LOCAL_SYNTHESIS is NEVER selected by default production inspection —
 *   not for character scenes, and not for background-only scenes. The presence of valid background,
 *   character, or narration assets can never make a scene production-ready or select a local mode.
 *   A valid supplied video clip always wins: `renderMode = 'SUPPLIED_VIDEO'`, `readiness = 'READY'`.
 * · `ALLOW_LOCAL` — explicit opt-in ONLY for offline tests, development, or an emergency/manual
 *   fallback. Restores the previous behaviour in which a scene with valid local assets could render
 *   via LOCAL_SYNTHESIS. Never the production default, and deliberately not plumbed through the CLI
 *   or orchestrator entry points, so the real workflow cannot fail open.
 */
export type LocalSynthesisPolicy = 'STRICT' | 'ALLOW_LOCAL';

/** Resolve the effective policy; anything other than an explicit ALLOW_LOCAL is STRICT. */
export function resolveLocalSynthesisPolicy(value: unknown): LocalSynthesisPolicy {
  return value === 'ALLOW_LOCAL' ? 'ALLOW_LOCAL' : 'STRICT';
}

const numericDuration = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** Resolve a background asset by tag from `backgrounds/<stem>.png`. Read-only. */
async function inspectBackground(tag: string | null, dir: string): Promise<SceneInputInspection['background']> {
  if (!tag) return { state: 'MISSING', path: null, reason: 'Scene has no background_tag.' };
  const stem = safeTagStem(tag);
  if (!stem) return { state: 'INVALID', path: null, reason: `Unsafe background tag ${tag}.` };
  const file = path.join(dir, `${stem}.png`);
  let stat;
  try { stat = await fsp.stat(file); } catch { return { state: 'MISSING', path: file, reason: 'Background file is not supplied.' }; }
  if (!stat.isFile()) return { state: 'MISSING', path: file, reason: 'Background path is not a regular file.' };
  if (stat.size <= 0) return { state: 'INVALID', path: file, reason: 'Background file is empty.' };
  const buffer = await fsp.readFile(file);
  const dims = readPngDimensions(buffer);
  if (!dims.ok) return { state: 'INVALID', path: file, reason: dims.reason };
  if (!meetsMinimumResolution(dims.width, dims.height)) return { state: 'INVALID', path: file, reason: `Background ${dims.width}x${dims.height} below minimum.` };
  if (!isAspectCompatible(dims.width, dims.height)) return { state: 'INVALID', path: file, reason: `Background ${dims.width}x${dims.height} is not 16:9-compatible.` };
  return { state: 'VALID', path: file, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), width: dims.width, height: dims.height };
}

/** Resolve a character asset, treating multiple valid candidates as AMBIGUOUS. */
async function inspectCharacter(tag: string, dir: string): Promise<SceneInputInspection['characters'][number]> {
  const candidates: string[] = [];
  const tagExt = requestedTagExtension(tag);
  const exts = tagExt === '.webp' ? ['.webp'] : tagExt ? [tagExt] : ['.png', '.webp'];
  for (const ext of exts) {
    const p = characterAssetPath(tag, dir).replace(/\.png$/i, ext === '.webp' ? '.webp' : ext);
    const ok = await fsp.stat(p).then((s) => s.isFile()).catch(() => false);
    if (ok) candidates.push(p);
  }
  if (candidates.length > 1) return { tag, state: 'AMBIGUOUS', path: null, reason: `Multiple character files exist for ${tag}.` };

  const result = await getCharacterAsset(tagExt === '.webp' ? `${tag}.webp` : tag, { charactersDir: dir });
  if (result.state === 'CHARACTER_ASSET_HIT') {
    const buffer = await fsp.readFile(result.filePath).catch(() => null);
    return { tag, state: 'VALID', path: result.filePath, sha256: buffer ? crypto.createHash('sha256').update(buffer).digest('hex') : undefined };
  }
  const mapped: Record<string, string> = {
    CHARACTER_ASSET_MISSING: 'MISSING', CHARACTER_ASSET_INVALID: 'INVALID',
    CHARACTER_ASSET_NO_ALPHA: 'INVALID', CHARACTER_ASSET_UNSUPPORTED: 'UNSUPPORTED',
  };
  return { tag, state: mapped[result.state] ?? 'INVALID', path: result.filePath, reason: (result as any).reason };
}

/** Resolve narration for a scene from `narration/`. Read-only. */
async function inspectNarration(sceneNumber: number, required: boolean, dir: string, ffprobePath?: string): Promise<SceneInputInspection['narrationAsset']> {
  if (!required) return { state: 'NOT_REQUIRED', path: null };
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  const { byScene, ambiguous } = mapNarrationFiles(names);
  if (ambiguous.has(sceneNumber)) return { state: 'AMBIGUOUS', path: null, reason: `Multiple narration files for scene ${sceneNumber}: ${JSON.stringify(ambiguous.get(sceneNumber))}.` };
  if (!byScene.has(sceneNumber)) return { state: 'MISSING', path: null, reason: `No narration-#### file for scene ${sceneNumber}.` };
  const resolved = await resolveSceneNarrationDuration(sceneNumber, dir);
  if (!resolved.ok) {
    const state = resolved.reason === 'MISSING_AUDIO' ? 'MISSING' : resolved.reason === 'AMBIGUOUS_MAPPING' ? 'AMBIGUOUS' : 'INVALID';
    return { state, path: null, reason: resolved.detail ?? resolved.reason };
  }
  const buffer = await fsp.readFile(resolved.audioPath).catch(() => null);
  return { state: 'VALID', path: resolved.audioPath, durationSeconds: resolved.durationSeconds, sha256: buffer ? crypto.createHash('sha256').update(buffer).digest('hex') : undefined };
}

/**
 * Build a deterministic render key from ACTUAL inputs. Contains no absolute paths,
 * timestamps, UUIDs or URLs — only logical identity + content hashes + contract version.
 */
export function computeRenderKey(parts: {
  sceneNumber: number; narration: NarrationKind; renderMode: RenderMode;
  durationSeconds: number | null; backgroundSha: string | null;
  characterShas: string[]; narrationSha: string | null; clipSha: string | null;
  sceneDefinition: string;
}): string {
  const canonical = [
    'v1', RENDERER_CONTRACT_VERSION,
    `scene:${parts.sceneNumber}`,
    `kind:${parts.narration}`,
    `mode:${parts.renderMode}`,
    `dur:${parts.durationSeconds === null ? 'unresolved' : parts.durationSeconds.toFixed(3)}`,
    `bg:${parts.backgroundSha ?? 'none'}`,
    `chars:${[...parts.characterShas].sort().join(',') || 'none'}`,
    `nar:${parts.narrationSha ?? 'none'}`,
    `clip:${parts.clipSha ?? 'none'}`,
    `def:${crypto.createHash('sha256').update(parts.sceneDefinition).digest('hex')}`,
  ].join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** Fields of the scene definition that actually affect the render. */
export function sceneDefinitionFingerprint(scene: any): string {
  return JSON.stringify({
    title: scene?.title ?? '', background_tag: scene?.background_tag ?? '',
    character_tags: Array.isArray(scene?.character_tags) ? [...scene.character_tags] : [],
    speaker: scene?.speaker ?? '', camera: scene?.camera ?? '', visual_action: scene?.visual_action ?? '',
    effects: scene?.effects ?? '',
  });
}

/**
 * Inspect one scene and produce its readiness record. Pure w.r.t. the pipeline (never mutates
 * the scene object).
 */
export async function inspectSceneState(scene: any, options: SceneStateOptions): Promise<SceneInputInspection> {
  const sceneNumber = Number(scene?.scene_number);
  const title = String(scene?.title ?? '');
  const narration = classifyNarration(scene);
  const characterTags: string[] = Array.isArray(scene?.character_tags) ? scene.character_tags.map((t: any) => String(t)) : [];
  const backgroundTag = scene?.background_tag ? String(scene.background_tag) : null;

  const backgroundsDir = path.join(options.inputRoot, 'backgrounds');
  const charactersDir = path.join(options.inputRoot, 'characters');
  const narrationDir = path.join(options.inputRoot, 'narration');
  const clipsDir = path.join(options.inputRoot, 'flow-clips');

  const background = await inspectBackground(backgroundTag, backgroundsDir);
  const characters = await Promise.all(characterTags.map((t) => inspectCharacter(t, charactersDir)));

  // A valid supplied clip can satisfy a scene on its own (dialogue audio is native to it).
  const clipPath = path.join(clipsDir, `scene-${String(sceneNumber).padStart(4, '0')}.mp4`);
  const clipCheck = await validateVideoClip(clipPath, { ffprobePath: options.ffprobePath });
  const suppliedClip: SceneInputInspection['suppliedClip'] =
    clipCheck.state === 'VALID' ? { state: 'VALID', path: clipCheck.path, durationSeconds: clipCheck.durationSeconds, sha256: clipCheck.sha256 }
    : clipCheck.state === 'MISSING' ? { state: 'MISSING', path: clipPath, reason: clipCheck.reason }
    : clipCheck.state === 'UNSUPPORTED' ? { state: 'UNSUPPORTED', path: clipCheck.path, reason: clipCheck.reason }
    : { state: 'INVALID', path: clipCheck.path, reason: clipCheck.reason };

  // Narration is required for narrator-only and mixed scenes.
  const narrationRequired = narration === 'NARRATOR_ONLY' || narration === 'MIXED';
  const narrationAsset = await inspectNarration(sceneNumber, narrationRequired, narrationDir, options.ffprobePath);

  // ---- duration resolution (deterministic precedence) ----
  const reasons: ReasonCode[] = [];
  /**
   * Narration-preservation summary for a scene whose narration exceeds its supplied clip. Present
   * only in that case; `undefined` otherwise. Diagnostic only: `durationSeconds` and
   * `durationProvenance` continue to describe the AUTHORITATIVE SOURCE clip, never the assembled
   * timeline length, and `renderKey` is unchanged by this field.
   */
  let preservationSummary: SceneNarrationPreservationSummary | undefined;
  const editLen = numericDuration(scene?.edit_length_seconds);
  const clipLen = numericDuration(scene?.clip_length_seconds);
  let durationSeconds: number | null = null;
  let durationProvenance: DurationProvenance = 'unresolved';
  if (suppliedClip.state === 'VALID' && suppliedClip.durationSeconds) { durationSeconds = suppliedClip.durationSeconds; durationProvenance = 'supplied-video'; }
  else if (editLen !== null) { durationSeconds = editLen; durationProvenance = 'pipeline'; }
  else if (clipLen !== null) { durationSeconds = clipLen; durationProvenance = 'pipeline'; }
  else if (narrationAsset.state === 'VALID' && narrationAsset.durationSeconds) { durationSeconds = narrationAsset.durationSeconds; durationProvenance = 'narration'; }

  // mixed scenes: narration must not exceed the supplied visual duration
  //
  // NARRATION-PRESERVATION POLICY. A supplied Flow clip is authoritative and is never stretched
  // at the source; AGENTS.md forbids cutting narration and forbids silent gaps. So when narration
  // is longer than the clip the picture must be SLOWED downstream (audio stays at natural speed)
  // rather than the voice being truncated. That is permitted ONLY while the required slowdown is
  // within `MAX_NARRATION_VIDEO_STRETCH`; beyond that bound the scene still fails closed with
  // DURATION_CONFLICT exactly as before. The shared pure helper owns the arithmetic, so this gate
  // and the downstream mixer can never disagree.
  // APPLIES TO `NARRATOR_ONLY` AS WELL AS `MIXED`. The gate used to be MIXED-only, which meant a
  // NARRATOR_ONLY scene could never raise DURATION_CONFLICT here; over-limit narration therefore
  // reached MIX READY and only failed at the mixer, long after the scene had been marked CURRENT.
  // Both kinds carry a narrator track bound to a supplied visual, so the same arithmetic governs
  // them. Scenes with no valid supplied clip, no narration, or no narration required are untouched
  // (the guards below still require both to be VALID). Scene 2 is excluded via
  // `NARRATION_LEGACY_EXEMPT_SCENES`, mirroring the mixer's documented legacy branch — without
  // that exclusion this gate would block a scene the mixer deliberately renders.
  const narrationPolicyApplies = (narration === 'NARRATOR_ONLY' || narration === 'MIXED')
    && !NARRATION_LEGACY_EXEMPT_SCENES.has(sceneNumber);
  if (narrationPolicyApplies && suppliedClip.state === 'VALID' && narrationAsset.state === 'VALID' && suppliedClip.durationSeconds && narrationAsset.durationSeconds
      && narrationExceedsClip(suppliedClip.durationSeconds, narrationAsset.durationSeconds)) {
    const preservation = decideNarrationPreservation({
      sourceVideoDuration: suppliedClip.durationSeconds,
      narrationDuration: narrationAsset.durationSeconds,
    });
    preservationSummary = {
      sourceVideoDuration: preservation.sourceVideoDuration,
      narrationDuration: preservation.narrationDuration,
      requiredOutputDuration: preservation.requiredOutputDuration,
      stretchFactor: preservation.stretchFactor,
      withinLimit: preservation.withinLimit,
      policy: preservation.reason,
      detail: preservation.ok ? null : preservation.detail,
    };
    // Fail closed on ANY unusable decision: an over-limit stretch, or invalid durations.
    if (!preservation.ok) reasons.push('DURATION_CONFLICT');
  }

  // ---- render mode ----
  const bgOk = background.state === 'VALID';
  const charsOk = characters.every((c) => c.state === 'VALID');
  const hasCharacters = characterTags.length > 0;
  const policy = resolveLocalSynthesisPolicy(options.localSynthesisPolicy);
  /**
   * STRICT policy: EVERY scene — character scene or background-only — may only ever be sourced from
   * a supplied (Flow) clip. Without one it MUST fail closed rather than silently substituting
   * LOCAL_SYNTHESIS, which would composite static 2D cutouts onto the background plate. This holds
   * regardless of scene type and regardless of which local assets happen to be present: local
   * assets never make a scene production-ready under STRICT.
   */
  const requiresSuppliedVideo = policy === 'STRICT';
  const narrationOk = narrationAsset.state === 'VALID' || narrationAsset.state === 'NOT_REQUIRED';
  const anyInvalid = background.state === 'INVALID' || background.state === 'UNSUPPORTED'
    || characters.some((c) => c.state === 'INVALID' || c.state === 'UNSUPPORTED' || c.state === 'AMBIGUOUS')
    || narrationAsset.state === 'INVALID' || narrationAsset.state === 'AMBIGUOUS'
    || suppliedClip.state === 'INVALID';
  const dialogueOnly = narration === 'DIALOGUE';
  const wantsLocal = !requiresSuppliedVideo && bgOk && narrationOk && (!hasCharacters || charsOk);

  let renderMode: RenderMode = 'NONE';
  if (suppliedClip.state === 'VALID') renderMode = 'SUPPLIED_VIDEO';
  else if (anyInvalid || reasons.includes('DURATION_CONFLICT')) renderMode = 'NONE'; // invalid input never selects a mode
  else if (dialogueOnly) renderMode = 'NONE';            // no local dialogue-audio synthesis exists
  else if (wantsLocal) renderMode = 'LOCAL_SYNTHESIS';

  // ---- readiness (fail closed, precise reasons) ----
  let readiness: SceneReadiness;
  if (!Number.isInteger(sceneNumber) || sceneNumber <= 0) { readiness = 'INVALID'; reasons.push('INVALID'); }
  else if (background.state === 'INVALID' || background.state === 'UNSUPPORTED') { readiness = 'INVALID'; reasons.push('INVALID'); }
  else if (characters.some((c) => c.state === 'AMBIGUOUS')) { readiness = 'INVALID'; reasons.push('AMBIGUOUS'); }
  else if (characters.some((c) => c.state === 'UNSUPPORTED')) { readiness = 'INVALID'; reasons.push('UNSUPPORTED'); }
  else if (characters.some((c) => c.state === 'INVALID')) { readiness = 'INVALID'; reasons.push('INVALID'); }
  else if (narrationAsset.state === 'AMBIGUOUS') { readiness = 'INVALID'; reasons.push('AMBIGUOUS'); }
  else if (narrationAsset.state === 'INVALID') { readiness = 'INVALID'; reasons.push('INVALID'); }
  else if (suppliedClip.state === 'INVALID') { readiness = 'INVALID'; reasons.push('INVALID'); }
  else if (reasons.includes('DURATION_CONFLICT')) { readiness = 'INVALID'; }
  else if (suppliedClip.state === 'VALID') { readiness = 'READY'; }
  else if (requiresSuppliedVideo) { readiness = 'WAITING_FOR_VIDEO_CLIP'; reasons.push('SUPPLIED_VIDEO_REQUIRED'); }
  else if (dialogueOnly) { readiness = 'WAITING_FOR_VIDEO_CLIP'; reasons.push('NO_LOCAL_DIALOGUE_AUDIO'); }
  else if (background.state === 'MISSING') { readiness = 'WAITING_FOR_BACKGROUND'; reasons.push('MISSING'); }
  else if (!bgOk) { readiness = 'INVALID'; reasons.push('INVALID'); }
  else if (characterTags.length && characters.some((c) => c.state === 'MISSING')) { readiness = 'WAITING_FOR_CHARACTER_ASSET'; reasons.push('MISSING'); }
  else if (narrationRequired && narrationAsset.state === 'MISSING') { readiness = 'WAITING_FOR_NARRATION'; reasons.push('MISSING'); }
  else if (narrationRequired && narrationAsset.state !== 'VALID') { readiness = 'WAITING_FOR_NARRATION'; reasons.push('MISSING'); }
  else if (durationSeconds === null) { readiness = 'INVALID'; reasons.push('DURATION_UNRESOLVED'); }
  else readiness = 'READY';

  const renderKey = computeRenderKey({
    sceneNumber: Number.isInteger(sceneNumber) ? sceneNumber : 0, narration, renderMode, durationSeconds,
    backgroundSha: background.sha256 ?? null,
    characterShas: characters.map((c) => c.sha256 ?? `missing:${c.tag}`),
    narrationSha: narrationAsset.sha256 ?? null,
    clipSha: suppliedClip.sha256 ?? null,
    sceneDefinition: sceneDefinitionFingerprint(scene),
  });

  return {
    sceneNumber: Number.isInteger(sceneNumber) ? sceneNumber : 0, title, narration,
    requiresNarration: narrationRequired, backgroundTag, characterTags, background, characters,
    narrationAsset, suppliedClip, durationSeconds, durationProvenance, renderMode, readiness,
    reasons: [...new Set(reasons)], renderKey,
    /** Narration-preservation diagnostic: present only when narration exceeds the supplied clip. */
    narrationPreservation: preservationSummary,
  };
}

/** Inspect every scene. Never mutates the pipeline. */
export async function inspectProjectScenes(pipeline: any, options: SceneStateOptions): Promise<SceneInputInspection[]> {
  const scenes = Array.isArray(pipeline?.scenes) ? pipeline.scenes : [];
  const out: SceneInputInspection[] = [];
  for (const s of scenes) out.push(await inspectSceneState(s, options));
  return out;
}

// ---------------------------------------------------------------------------------------
// FLOW EXECUTION ELIGIBILITY (STEP-8HD)
//
// A SEPARATE, fail-closed decision from FINAL PRODUCTION READINESS. A scene may be handed to
// the modern Flow SceneExecutor when all NON-Flow prerequisites are valid AND Flow work is
// genuinely required. It deliberately does NOT trust `readiness === WAITING_FOR_VIDEO_CLIP`
// (which sceneState assigns BEFORE background/character checks) and never makes a Flow-eligible
// scene globally READY.
// ---------------------------------------------------------------------------------------

export type FlowEligibilityAction = 'GENERATE' | 'RECOVER' | 'NONE';

export interface FlowEligibilityVerdict {
  eligible: boolean;
  action: FlowEligibilityAction;
  reason: string;
}

/** Structural input so this pure helper can consume a `checkInputs` SceneDiagnostic. */
export interface FlowEligibilityInput {
  readiness?: unknown;
  renderMode?: unknown;
  background?: { state?: unknown } | null;
  characters?: Array<{ state?: unknown }> | null;
  narrationAsset?: { state?: unknown } | null;
  suppliedClip?: { state?: unknown } | null;
  narration?: unknown;
  /** Present on checkInputs diagnostics: explicit Flow/local relationship. */
  flowLocal?: { state?: unknown } | null;
}

const FLOW_BG_STATES = new Set(['VALID', 'MISSING', 'INVALID', 'UNSUPPORTED']);
const FLOW_CLIP_STATES = new Set(['VALID', 'MISSING', 'INVALID', 'UNSUPPORTED']);
const FLOW_NARR_STATES = new Set(['VALID', 'MISSING', 'INVALID', 'AMBIGUOUS', 'NOT_REQUIRED']);

/**
 * PURE, deterministic, fail-closed. Decides whether a scene is eligible for modern Flow
 * execution (generation or committed-media recovery) given its inspected inputs.
 *
 * Non-Flow prerequisites (checked independently of `readiness`):
 *   · background must be VALID
 *   · every required character must be VALID
 *   · narration must not be INVALID/AMBIGUOUS (missing local narration is fine — it is a
 *     downstream MIX prerequisite, not a Flow-generation prerequisite)
 *   · scene must not be INVALID
 *
 * Flow work: recovered when the Flow scene is committed but local media is missing; generated for
 * ANY scene type (NARRATOR_ONLY / DIALOGUE / MIXED / background-only) when there is no valid local
 * clip and no local synthesis path. Under the universal production policy every scene needs a Flow
 * clip, so the narration kind is deliberately NOT part of the GENERATE decision.
 */
export function classifyFlowEligibility(scene: FlowEligibilityInput | undefined | null): FlowEligibilityVerdict {
  if (!scene || typeof scene !== 'object') return { eligible: false, action: 'NONE', reason: 'unresolved scene inspection' };

  const bg = scene.background?.state;
  const narr = scene.narrationAsset?.state;
  const clip = scene.suppliedClip?.state;
  const chars = Array.isArray(scene.characters) ? scene.characters : [];
  const flow = scene.flowLocal?.state;

  // Fail closed on unknown/malformed states.
  if (typeof bg !== 'string' || !FLOW_BG_STATES.has(bg)) return { eligible: false, action: 'NONE', reason: 'unknown background state' };
  if (typeof clip !== 'string' || !FLOW_CLIP_STATES.has(clip)) return { eligible: false, action: 'NONE', reason: 'unknown supplied-clip state' };
  if (typeof narr !== 'string' || !FLOW_NARR_STATES.has(narr)) return { eligible: false, action: 'NONE', reason: 'unknown narration state' };
  if (chars.some((c) => typeof c?.state !== 'string')) return { eligible: false, action: 'NONE', reason: 'unknown character state' };

  // Independent non-Flow prerequisite validation (never rely on `readiness`).
  if (String(scene.readiness) === 'INVALID') return { eligible: false, action: 'NONE', reason: 'scene is INVALID' };
  if (bg !== 'VALID') return { eligible: false, action: 'NONE', reason: `background is ${bg}` };
  if (chars.some((c) => c.state !== 'VALID')) return { eligible: false, action: 'NONE', reason: 'required character is not VALID' };
  if (narr === 'INVALID' || narr === 'AMBIGUOUS') return { eligible: false, action: 'NONE', reason: `narration is ${narr}` };
  if (clip === 'INVALID' || clip === 'UNSUPPORTED') return { eligible: false, action: 'NONE', reason: `supplied clip is ${clip}` };

  // Already have usable local media → no Flow work.
  if (clip === 'VALID') return { eligible: false, action: 'NONE', reason: 'valid local clip already present' };

  // Committed in Flow but local media missing → recovery/download only, never regeneration.
  if (flow === 'FLOW_COMMITTED_LOCAL_MISSING') return { eligible: true, action: 'RECOVER', reason: 'Flow scene committed; local clip missing (recovery/download)' };

  // Universal production policy: EVERY scene requires a supplied Flow video clip — its narration
  // kind is irrelevant. NARRATOR_ONLY, DIALOGUE, MIXED and background-only scenes are all eligible
  // once their non-Flow prerequisites are valid (checked above) and there is no valid local clip.
  //
  // The one exception is a scene that DOES have a local synthesis path: under the explicit
  // ALLOW_LOCAL dev/emergency opt-in, `renderMode` is LOCAL_SYNTHESIS and that scene is served
  // locally, so it must not also be handed to Flow. Under the default STRICT policy every
  // clip-less scene inspects as `renderMode: 'NONE'`, so this guard never blocks production work.
  if (String(scene.renderMode) === 'LOCAL_SYNTHESIS') {
    return { eligible: false, action: 'NONE', reason: 'local synthesis is enabled for this scene (ALLOW_LOCAL dev opt-in); not Flow work' };
  }
  if (clip === 'MISSING') return { eligible: true, action: 'GENERATE', reason: 'Flow video required (universal policy: every scene needs a supplied Flow clip)' };

  return { eligible: false, action: 'NONE', reason: 'no Flow work required' };
}
