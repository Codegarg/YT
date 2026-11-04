/**
 * FLOW PROMPT HARDENING + SCENE DEPENDENCY LOCKS (PURE, DETERMINISTIC).
 *
 * WHY
 * ---
 * A scene's canonical `animation_prompt_NARRATOR_ONLY` embeds MACHINE identifiers, e.g.
 *
 *     ACTIVE ENVIRONMENT: #BGD-01-ARJUN-ROOM-WIDE
 *     ACTIVE CHARACTERS: @CHAR-01-ARJUN
 *
 * Those tags are the pipeline's identity keys, not prose. Flow conditions generation on the human
 * description carried alongside each tag in the canonical `pipeline.json` metadata, so the prompt
 * handed to the composer must resolve each tag to that canonical human-readable description.
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * It is NOT a tag stripper. Deleting `#BGD-...`/`@CHAR-...` would silently drop scene-conditioning
 * information, which is exactly the failure mode this module exists to prevent. Every referenced tag
 * must be RESOLVED or the whole hardening fails closed.
 *
 * CANONICAL SOURCE OF TRUTH
 * -------------------------
 * The project's own `pipeline.json` arrays. No second metadata system is introduced:
 *   · background -> `backgrounds[].tag` + `location_name` + `look_summary`
 *   · character  -> `characters[].tag`  + `name` + `look_summary`
 * The repository already treats these as canonical (`runner.ts`, `characterGenerationSpec.ts`).
 *
 * HARD GUARANTEES
 * ---------------
 *   1. No raw `#BGD-*` / `@CHAR-*` identifier survives in a hardened prompt.
 *   2. No description is ever invented: an unresolvable tag fails closed.
 *   3. An unresolved asset reference is never silently deleted.
 *   4. Every other character of the prompt is preserved byte-for-byte unless a replacement is
 *      required at that exact position.
 *   5. Pure: no filesystem, no browser, no network, no clock, no randomness.
 */

import {
  detectWardrobeMode,
  formatAppearance,
  hasReferenceSheetLanguage,
  resolveOutfit,
  type WardrobeIssueCode,
  type WardrobeMode,
} from './characterWardrobe.js';

/** Exact machine-identity patterns. A bare sigil, a wrong sigil, or a loose substring is NOT a tag. */
export const FLOW_BACKGROUND_TAG_PATTERN = /^#BGD-.+/;
export const FLOW_CHARACTER_TAG_PATTERN = /^@CHAR-.+/;
/**
 * Any machine identifier appearing inline in text. Used both as the rewrite scanner and as the
 * post-condition residual check.
 *
 * The identifier MUST end in an alphanumeric, so sentence punctuation is never swallowed: in
 * `char=@CHAR-01-ARJUN.` the match is `@CHAR-01-ARJUN`, not `@CHAR-01-ARJUN.`. Without that anchor a
 * trailing `.` would be absorbed into the tag, the tag would fail to resolve, and hardening would
 * fail closed on a perfectly valid prompt.
 */
export const RAW_FLOW_ID_SOURCE = '#BGD-[A-Za-z0-9_-]*[A-Za-z0-9]|@CHAR-[A-Za-z0-9_-]*[A-Za-z0-9]';
export const RAW_FLOW_ID_PATTERN = new RegExp(`(?:${RAW_FLOW_ID_SOURCE})`, 'g');
/** A fresh, non-global scanner instance (a shared /g regex carries `lastIndex` between calls). */
export const newRawFlowIdScanner = (): RegExp => new RegExp(`(?:${RAW_FLOW_ID_SOURCE})`, 'g');

/** Canonical background metadata, taken verbatim from `pipeline.json.backgrounds[]`. */
export interface CanonicalBackground {
  tag?: unknown;
  location_name?: unknown;
  look_summary?: unknown;
}

/**
 * Canonical character metadata, taken verbatim from `pipeline.json.characters[]`.
 *
 * `look_summary` is the LEGACY identity source. New projects add the explicit
 * `appearance_lock` / `wardrobe` contract, which is handled by `characterWardrobe.ts`.
 */
export interface CanonicalCharacter {
  tag?: unknown;
  name?: unknown;
  look_summary?: unknown;
  appearance_lock?: unknown;
  wardrobe?: unknown;
  [key: string]: unknown;
}

/** The two identity kinds a scene can depend on. */
export type FlowAssetKind = 'background' | 'character';

const text = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v)).trim();

/** Canonical human-readable description for one background tag, or null when unresolvable. */
export function resolveBackgroundDescription(tag: unknown, backgrounds: readonly CanonicalBackground[] | null | undefined): string | null {
  const t = text(tag);
  if (!FLOW_BACKGROUND_TAG_PATTERN.test(t)) return null;
  const hit = (backgrounds ?? []).find((b) => text(b?.tag) === t);
  if (!hit) return null;
  const look = text(hit.look_summary);
  const place = text(hit.location_name);
  if (look && place) return `${place} — ${look}`;
  if (look) return look;
  return place || null;
}

/**
 * Canonical human-readable identity for one character tag, or null when unresolvable.
 *
 * Legacy mode preserves the historical `name — look_summary` output byte-for-byte.
 * Strict mode uses ONLY `appearance_lock`; the authoritative wardrobe is appended by the
 * scene-prompt builder as a separate CHARACTER LOCK block, so a scene-specific outfit override
 * can never contradict a default outfit embedded in this inline description.
 */
export function resolveCharacterDescription(
  tag: unknown,
  characters: readonly CanonicalCharacter[] | null | undefined,
  options?: { mode?: WardrobeMode } | null,
): string | null {
  const t = text(tag);
  if (!FLOW_CHARACTER_TAG_PATTERN.test(t)) return null;
  const hit = (characters ?? []).find((c) => text(c?.tag) === t);
  if (!hit) return null;
  const mode = options?.mode ?? detectWardrobeMode(characters);
  const name = text(hit.name);
  if (mode === 'legacy') {
    const look = text(hit.look_summary);
    if (look && name) return `${name} — ${look}`;
    if (look) return look;
    return name || null;
  }
  const appearance = formatAppearance(hit.appearance_lock);
  if (!appearance || hasReferenceSheetLanguage(appearance)) return null;
  const wardrobe = resolveOutfit(hit, undefined, 'strict');
  if (!wardrobe.ok) return null;
  return name ? `${name} — ${appearance}` : appearance;
}

export type SceneDependencyCode =
  | 'SCENE_NUMBER_INVALID'
  | 'SCENE_TAGS_MISSING'
  | 'SCENE_TAG_MALFORMED';

export type SceneDependencyResult =
  | { ok: true; backgroundTags: string[]; characterTags: string[] }
  | { ok: false; code: SceneDependencyCode; reason: string };

/**
 * PURE: the scene's OWN declared dependencies, de-duplicated and order-preserving.
 *
 * This is deliberately SCENE-scoped. The project-wide inventory is verified separately as
 * `PROJECT_ASSET_SURFACE_INTEGRITY`; generation is gated only on what this scene actually needs.
 */
export function resolveSceneAssetDependencies(scene: {
  scene_number?: unknown; background_tag?: unknown; character_tags?: unknown;
} | null | undefined): SceneDependencyResult {
  if (!scene || typeof scene !== 'object') {
    return { ok: false, code: 'SCENE_TAGS_MISSING', reason: 'no scene object was supplied, so its asset dependencies cannot be resolved.' };
  }
  const n = Number(scene.scene_number);
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, code: 'SCENE_NUMBER_INVALID', reason: `scene_number must be a positive integer (got ${String(scene.scene_number)}).` };
  }
  const rawBackgrounds = text(scene.background_tag);
  const rawCharacters = Array.isArray(scene.character_tags) ? scene.character_tags : [];
  if (!rawBackgrounds && rawCharacters.length === 0) {
    return { ok: false, code: 'SCENE_TAGS_MISSING', reason: `scene ${n} declares neither a background_tag nor any character_tags; an undeclared dependency cannot be inferred.` };
  }
  const backgroundTags = rawBackgrounds ? [rawBackgrounds] : [];
  const characterTags: string[] = [];
  for (const c of rawCharacters) {
    const t = text(c);
    if (!t) continue;
    if (!FLOW_CHARACTER_TAG_PATTERN.test(t)) {
      return { ok: false, code: 'SCENE_TAG_MALFORMED', reason: `scene ${n} declares a character tag ${JSON.stringify(t)} that is not an exact "@CHAR-" identity; a malformed dependency fails closed.` };
    }
    if (!characterTags.includes(t)) characterTags.push(t);
  }
  for (const b of backgroundTags) {
    if (!FLOW_BACKGROUND_TAG_PATTERN.test(b)) {
      return { ok: false, code: 'SCENE_TAG_MALFORMED', reason: `scene ${n} declares a background tag ${JSON.stringify(b)} that is not an exact "#BGD-" identity; a malformed dependency fails closed.` };
    }
  }
  return { ok: true, backgroundTags, characterTags };
}

export type SceneAssetLockCode =
  | 'SCENE_REQUIRED_BACKGROUND_MISSING'
  | 'SCENE_REQUIRED_CHARACTER_MISSING'
  | 'SCENE_REQUIRED_ASSET_IDENTITY_AMBIGUOUS';

export type SceneAssetLockResult =
  | { ok: true; requiredBackgrounds: string[]; requiredCharacters: string[] }
  | { ok: false; code: SceneAssetLockCode; reason: string };

const canonical = (pool: readonly string[], tag: string, sigil: '#' | '@'): string => tag.slice(sigil.length);

/**
 * PURE: gate generation on the SCENE's dependencies against the project inventory.
 *
 * The inventory is the live-proven project surface (7 backgrounds, 4 characters). Unrelated
 * inventory entries are irrelevant and never cause a failure; only the scene's own declared tags do.
 * Project-wide integrity is verified by a separate check and is NOT weakened by this one.
 */
export function verifySceneAssetLocks(input: {
  requiredBackgrounds?: readonly string[] | null;
  requiredCharacters?: readonly string[] | null;
  /** The live-proven project inventory (`readProjectBackgroundIdentities` / `readProjectCharacterIdentities`). */
  availableBackgrounds?: readonly string[] | null;
  availableCharacters?: readonly string[] | null;
} | undefined | null): SceneAssetLockResult {
  const reqB = [...new Set((input?.requiredBackgrounds ?? []).map((t) => text(t)).filter(Boolean))];
  const reqC = [...new Set((input?.requiredCharacters ?? []).map((t) => text(t)).filter(Boolean))];
  const poolB = [...new Set((input?.availableBackgrounds ?? []).map((t) => text(t)).filter(Boolean))];
  const poolC = [...new Set((input?.availableCharacters ?? []).map((t) => text(t)).filter(Boolean))];

  for (const tag of reqB) {
    if (!FLOW_BACKGROUND_TAG_PATTERN.test(tag)) {
      return { ok: false, code: 'SCENE_REQUIRED_BACKGROUND_MISSING', reason: `required background ${JSON.stringify(tag)} is not an exact "#BGD-" identity.` };
    }
    const hits = poolB.filter((p) => canonical(poolB, p, '#') === canonical(poolB, tag, '#'));
    if (hits.length === 0) return { ok: false, code: 'SCENE_REQUIRED_BACKGROUND_MISSING', reason: `the scene's required background ${tag} is not present in the project asset inventory.` };
    if (hits.length > 1) return { ok: false, code: 'SCENE_REQUIRED_ASSET_IDENTITY_AMBIGUOUS', reason: `the scene's required background ${tag} matched ${hits.length} distinct inventory identities.` };
  }
  for (const tag of reqC) {
    if (!FLOW_CHARACTER_TAG_PATTERN.test(tag)) {
      return { ok: false, code: 'SCENE_REQUIRED_CHARACTER_MISSING', reason: `required character ${JSON.stringify(tag)} is not an exact "@CHAR-" identity.` };
    }
    const hits = poolC.filter((p) => canonical(poolC, p, '@') === canonical(poolC, tag, '@'));
    if (hits.length === 0) return { ok: false, code: 'SCENE_REQUIRED_CHARACTER_MISSING', reason: `the scene's required character ${tag} is not present in the project asset inventory.` };
    if (hits.length > 1) return { ok: false, code: 'SCENE_REQUIRED_ASSET_IDENTITY_AMBIGUOUS', reason: `the scene's required character ${tag} matched ${hits.length} distinct inventory identities.` };
  }
  return { ok: true, requiredBackgrounds: reqB, requiredCharacters: reqC };
}

export type PromptHardeningCode =
  | 'PROMPT_MISSING'
  | 'PROMPT_REFERENCE_UNRESOLVED'
  | 'PROMPT_RESIDUAL_MACHINE_ID'
  | 'PROMPT_SEMANTICS_LOST'
  | WardrobeIssueCode;

export type PromptHardeningResult =
  | {
      ok: true;
      hardenedPrompt: string;
      /** Every machine identifier that was resolved, in first-seen order. */
      resolved: Array<{ kind: FlowAssetKind; tag: string; description: string }>;
      unresolved: [];
    }
  | { ok: false; code: PromptHardeningCode; reason: string; unresolved: string[] };

/**
 * PURE: replace every machine identifier in a scene prompt with its canonical human-readable
 * description, leaving all other text byte-identical.
 *
 * Fails closed when a referenced tag has no canonical metadata. An unresolved reference is NEVER
 * deleted and NEVER replaced with a guess: the caller receives the offending tag and must stop.
 */
export function hardenFlowPrompt(input: {
  prompt?: unknown;
  backgrounds?: readonly CanonicalBackground[] | null;
  characters?: readonly CanonicalCharacter[] | null;
  /**
   * `strict` requires explicit appearance_lock + a resolvable wardrobe and fails closed when either
   * is missing. `legacy` preserves the historical look_summary behavior. Omit (or pass undefined)
   * for deterministic auto-detection from the supplied canonical characters.
   */
  wardrobeMode?: WardrobeMode;
  /** Reject any output that still contains a raw identifier. Default TRUE. */
  requireNoResidualIds?: boolean;
} | undefined | null): PromptHardeningResult {
  const prompt = typeof input?.prompt === 'string' ? input.prompt : '';
  if (!prompt.trim()) return { ok: false, code: 'PROMPT_MISSING', reason: 'the scene prompt is empty; nothing can be hardened.', unresolved: [] };

  const mode = input?.wardrobeMode ?? detectWardrobeMode(input?.characters);
  const resolved: Array<{ kind: FlowAssetKind; tag: string; description: string }> = [];
  const seen = new Set<string>();
  const unresolved: string[] = [];
  let firstFailure: DescriptionSourceFailure | null = null;

  // One explicit left-to-right scan. Every character that is not part of a matched identifier is
  // copied verbatim, so the surrounding prompt text is preserved byte-for-byte.
  const scanner = newRawFlowIdScanner();
  const out: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(prompt)) !== null) {
    out.push(prompt.slice(lastIndex, match.index));
    const tag = match[0];
    const source = descriptionResultFor(tag, input?.backgrounds, input?.characters, mode);
    if (!source.ok) {
      // GUARANTEE 3: the reference is PRESERVED verbatim, never deleted and never guessed.
      unresolved.push(tag);
      firstFailure ??= source;
      out.push(tag);
    } else {
      pushResolved(resolved, seen, tag, source.description);
      out.push(source.description);
    }
    lastIndex = match.index + tag.length;
  }
  out.push(prompt.slice(lastIndex));
  const hardenedPrompt = out.join('');

  if (unresolved.length > 0) {
    const unique = [...new Set(unresolved)];
    const code = firstFailure?.code ?? 'PROMPT_REFERENCE_UNRESOLVED';
    const detail = firstFailure?.reason
      ? `${firstFailure.reason} Reference(s): ${unique.join(', ')}. The reference is preserved and never guessed.`
      : `the scene prompt references ${unique.length} asset identifier(s) with no canonical metadata (${unique.join(', ')}); the reference is preserved and never guessed.`;
    return { ok: false, code, reason: detail, unresolved: unique };
  }
  if (input?.requireNoResidualIds !== false && findResidualMachineIds(hardenedPrompt).length > 0) {
    return {
      ok: false, code: 'PROMPT_RESIDUAL_MACHINE_ID',
      reason: `the hardened prompt still contains ${findResidualMachineIds(hardenedPrompt).length} raw machine identifier(s); a hardened prompt must carry no "#BGD-"/"@CHAR-" identity.`,
      unresolved: [...new Set(findResidualMachineIds(hardenedPrompt))],
    };
  }
  if (resolved.length === 0) {
    return {
      ok: false, code: 'PROMPT_SEMANTICS_LOST',
      reason: 'the scene prompt carried no resolvable asset reference, so hardening would silently strip nothing and lose scene conditioning.',
      unresolved: [],
    };
  }
  return { ok: true, hardenedPrompt, resolved, unresolved: [] };
}

type DescriptionSourceSuccess = { ok: true; description: string };
type DescriptionSourceFailure = { ok: false; code: WardrobeIssueCode | 'PROMPT_REFERENCE_UNRESOLVED'; reason: string };
type DescriptionSourceResult = DescriptionSourceSuccess | DescriptionSourceFailure;

function descriptionResultFor(
  tag: string,
  backgrounds: readonly CanonicalBackground[] | null | undefined,
  characters: readonly CanonicalCharacter[] | null | undefined,
  mode: WardrobeMode,
): DescriptionSourceResult {
  if (FLOW_BACKGROUND_TAG_PATTERN.test(tag)) {
    const description = resolveBackgroundDescription(tag, backgrounds);
    return description === null
      ? { ok: false, code: 'PROMPT_REFERENCE_UNRESOLVED', reason: `the prompt references canonical background ${tag}, which has no resolvable description.` }
      : { ok: true, description };
  }
  if (!FLOW_CHARACTER_TAG_PATTERN.test(tag)) {
    return { ok: false, code: 'PROMPT_REFERENCE_UNRESOLVED', reason: `the prompt contains a malformed character identifier ${JSON.stringify(tag)}.` };
  }
  const character = (characters ?? []).find((c) => text(c?.tag) === tag);
  if (!character) {
    return { ok: false, code: 'PROMPT_REFERENCE_UNRESOLVED', reason: `the prompt references canonical character ${tag}, which has no canonical metadata.` };
  }
  if (mode === 'legacy') {
    const description = resolveCharacterDescription(tag, characters, { mode: 'legacy' });
    return description === null
      ? { ok: false, code: 'PROMPT_REFERENCE_UNRESOLVED', reason: `the prompt references canonical character ${tag}, which has no legacy look_summary.` }
      : { ok: true, description };
  }
  const appearance = formatAppearance(character.appearance_lock);
  if (!appearance) {
    return { ok: false, code: 'APPEARANCE_MISSING', reason: `character ${tag} is missing appearance_lock; strict wardrobe mode fails closed.` };
  }
  if (hasReferenceSheetLanguage(appearance)) {
    return { ok: false, code: 'REFERENCE_SHEET_LANGUAGE', reason: `character ${tag} appearance_lock contains reference-sheet-only language; strict wardrobe mode rejects it.` };
  }
  const outfit = resolveOutfit(character, undefined, 'strict');
  if (!outfit.ok) {
    return { ok: false, code: outfit.code, reason: outfit.reason };
  }
  const name = text(character.name);
  return { ok: true, description: name ? `${name} — ${appearance}` : appearance };
}

function pushResolved(into: Array<{ kind: FlowAssetKind; tag: string; description: string }>, seen: Set<string>, tag: string, description: string): void {
  if (seen.has(tag)) return;
  seen.add(tag);
  into.push({ kind: FLOW_BACKGROUND_TAG_PATTERN.test(tag) ? 'background' : 'character', tag, description });
}

/** Every raw machine identifier still present in a text, de-duplicated. */
export function findResidualMachineIds(text: string): string[] {
  return [...new Set(String(text ?? '').match(RAW_FLOW_ID_PATTERN) ?? [])];
}
