/**
 * Character provider abstraction: Flow is PRIMARY; OpenAI is an OPTIONAL fallback (browser-free).
 *
 * Why: Google Flow is already authenticated/funded and is the cost-effective path for this
 * workflow. A Flow-native character is a first-class Flow ingredient used DIRECTLY by Flow scene
 * generation — it is NOT required to be a local transparent PNG. The existing local PNG system
 * (currently produced via the OpenAI image provider) remains as a FALLBACK for local/offline
 * compositing and must not be weakened, faked, or screenshotted from Flow.
 *
 * This module is PURE: no Playwright, no filesystem, no network, no Flow, no credits. The concrete
 * `FlowCharacterProvider` (browser) implements `CharacterGenerationProvider` elsewhere.
 */
import type { CharacterGenerationSpec } from './characterGenerationSpec.js';
import { CHARACTER_GENERATION_SPECS } from './characterGenerationSpec.js';

/** A character provider knows how to produce/reuse a character for a spec. */
export interface CharacterGenerationProvider {
  readonly name: string;
  /** Whether this provider can produce a character for the given spec, and in which mode. */
  isCapable(spec: CharacterGenerationSpec): ProviderCapability;
  generateCharacter(spec: CharacterGenerationSpec, options: CharacterOperationOptions): Promise<ProviderCharacterResult>;
  verifyCharacter(tag: string, options: CharacterOperationOptions): Promise<ProviderCharacterResult>;
  findCharacter(tag: string, options: CharacterOperationOptions): Promise<ProviderCharacterResult>;
  renameCharacter(tag: string, displayName: string, options: CharacterOperationOptions): Promise<ProviderCharacterResult>;
}

export type CharacterProviderKind = 'flow' | 'openai';
import type { CharacterOperationMode } from './flowCharacterState.js';

/** Options threaded through every provider call. `mode` is REQUIRED so a recon can never generate. */
export interface CharacterOperationOptions {
  mode: CharacterOperationMode;
  flowProjectId?: string;
  /** Pipeline-derived spec set (source of truth); providers never re-derive specs themselves. */
  pipeline?: unknown;
}

export interface ProviderCapability {
  ok: boolean;
  /** 'flow-native' = a Flow ingredient used directly; 'local-png' = a validated local cutout. */
  produces: 'flow-native' | 'local-png' | 'none';
  reason?: string;
}

export type ProviderCharacterResult =
  | { ok: true; tag: string; provider: string; produces: 'flow-native' | 'local-png'; flowCharacterUuid?: string | null; displayName?: string | null; path?: string }
  | { ok: false; tag: string; provider: string; state: string; reason: string };

// ---------------------------------------------------------------------------------------
// Default provider selection
// ---------------------------------------------------------------------------------------

/** Default = Flow (primary). OpenAI is opt-in only. */
export const DEFAULT_CHARACTER_PROVIDER: CharacterProviderKind = 'flow';

/**
 * Pure selection: `kind` wins when given; otherwise the default (Flow). Unknown → fail closed to
 * the default so a misconfigured caller never silently selects a paid fallback.
 */
export function selectCharacterProvider(kind?: string | null): CharacterProviderKind {
  const k = String(kind ?? '').trim().toLowerCase();
  if (k === 'openai') return 'openai';
  if (k === 'flow' || k === '') return DEFAULT_CHARACTER_PROVIDER;
  return DEFAULT_CHARACTER_PROVIDER;
}

/** True only when the caller EXPLICITLY requested the OpenAI fallback. */
export function isOpenAIFallbackExplicitlyRequested(kind?: string | null): boolean {
  return String(kind ?? '').trim().toLowerCase() === 'openai';
}

// ---------------------------------------------------------------------------------------
// Deterministic Flow character prompt (from the CURRENT pipeline spec)
// ---------------------------------------------------------------------------------------

/** Shared Flow horror art direction (mirrors the project's established style; no invention). */
export const FLOW_CHARACTER_STYLE =
  '2D semi-realistic Indian horror illustration, bold clean outlines, flat cel shading, subtle cinematic lighting, Indian visual design, expressive detailed face, polished digital illustration, consistent proportions and line quality';

/**
 * Build a DETERMINISTIC Flow character-generation prompt from a pipeline-derived spec.
 * Preserves appearance/style/consistency and includes age/gender ONLY when specified. Missing
 * optional attributes are simply omitted — never invented. Contains no Flow URLs/secrets.
 */
export function buildFlowCharacterPrompt(spec: CharacterGenerationSpec): string {
  if (!spec || typeof spec !== 'object' || !String(spec.tag ?? '').trim()) {
    throw new Error('buildFlowCharacterPrompt requires a character spec with a tag.');
  }
  const subject = String(spec.physical_appearance ?? spec.generation_prompt ?? '').trim();
  if (!subject) throw new Error(`Character ${spec.tag} has no visual description to prompt from.`);

  const attrs: string[] = [];
  if (String(spec.age ?? '').trim()) attrs.push(String(spec.age).trim());
  if (String(spec.gender ?? '').trim()) attrs.push(String(spec.gender).trim());

  const extras: string[] = [];
  if (String(spec.personality ?? '').trim()) extras.push(`personality: ${String(spec.personality).trim()}`);

  const lines = [
    'Single character reference of ONE person, full body, neutral three-quarter standing pose, feet visible, subject centred on a plain neutral grey studio background.',
    subject,
    attrs.length ? `Character: ${attrs.join(', ')}.` : '',
    extras.length ? extras.join(' ') : '',
    `Style: ${spec.common_style || FLOW_CHARACTER_STYLE}.`,
    'Consistency: same face, hair, clothing and proportions every time; no second person, no model sheet, no turnaround sheet, no multiple views, no text, no labels, no watermark, no border.',
  ].filter(Boolean);
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Pure mapping: exact pipeline character tags → specs (source of truth). When a pipeline is given,
 * its characters are used; otherwise the built-in example cast. Never invents tags.
 */
export function characterSpecsByTag(specs: readonly CharacterGenerationSpec[]): Map<string, CharacterGenerationSpec> {
  const map = new Map<string, CharacterGenerationSpec>();
  for (const s of specs) map.set(String(s.tag), s);
  return map;
}

/** The built-in example cast's tags (used only when no pipeline is supplied). */
export const EXAMPLE_CHARACTER_TAGS: readonly string[] = CHARACTER_GENERATION_SPECS.map((s) => s.tag);

// ---------------------------------------------------------------------------------------
// Pure decision helpers for the Flow-native lifecycle
// ---------------------------------------------------------------------------------------

/** Exact-tag lookup over already-resolved Flow character candidates → READY / NOT_FOUND / AMBIGUOUS. */
export function lookupFlowCharacterByTag(
  candidates: readonly { tag: string; characterId: string | null }[],
  wantedTag: string,
): ProviderCharacterResult {
  const tag = String(wantedTag ?? '').trim();
  const matches = (Array.isArray(candidates) ? candidates : []).filter((c) => String(c.tag ?? '').trim() === tag);
  if (matches.length === 1) return { ok: true, tag, provider: 'flow', produces: 'flow-native', flowCharacterUuid: matches[0].characterId, displayName: tag };
  if (matches.length > 1) return { ok: false, tag, provider: 'flow', state: 'FLOW_CHARACTER_AMBIGUOUS', reason: `Multiple Flow characters matched tag ${tag}.` };
  return { ok: false, tag, provider: 'flow', state: 'FLOW_CHARACTER_NOT_FOUND', reason: `No Flow character matched tag ${tag}.` };
}

/** Pure rename verification: the observed name must equal the requested display name exactly. */
export function verifyFlowCharacterRename(observedName: unknown, requestedName: unknown): { ok: boolean; reason: string } {
  const want = String(requestedName ?? '').trim();
  const got = String(observedName ?? '').trim();
  if (!want) return { ok: false, reason: 'Requested rename target was empty.' };
  return got === want ? { ok: true, reason: `Flow character renamed to "${want}".` } : { ok: false, reason: `Rename verification failed: expected "${want}", saw "${got}".` };
}

/** Pure identity persistence decision: the same characterId must be observed before and after. */
export function verifyFlowCharacterIdentityPersisted(beforeId: unknown, afterId: unknown): { ok: boolean; reason: string } {
  const a = String(beforeId ?? '').trim();
  const b = String(afterId ?? '').trim();
  if (!a) return { ok: false, reason: 'No character identity was available to persist.' };
  return a === b ? { ok: true, reason: `Flow character identity ${a} persisted.` } : { ok: false, reason: `Flow character identity changed: ${a} → ${b}.` };
}

/** Pure ingredient-selection verification: exactly one exact-tag row must be present and selected. */
export function verifyFlowCharacterIngredientSelection(input: { rows: readonly string[]; wantedTag: string; selectedCount: number }): { ok: boolean; reason: string } {
  const want = String(input.wantedTag ?? '').trim();
  const matches = (input.rows ?? []).filter((r) => String(r ?? '').trim() === want).length;
  if (matches === 0) return { ok: false, reason: `Ingredient "${want}" was not present in the Characters category.` };
  if (matches > 1) return { ok: false, reason: `Ingredient "${want}" was ambiguous (${matches} rows).` };
  if (input.selectedCount !== 1) return { ok: false, reason: `Ingredient "${want}" selection was not confirmed (selectedCount=${input.selectedCount}).` };
  return { ok: true, reason: `Ingredient "${want}" selected deterministically.` };
}
