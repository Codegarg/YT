/**
 * DETERMINISTIC CHARACTER APPEARANCE + WARDROBE CONTRACT (PURE).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Legacy projects carry a single `look_summary` string that mixes physical identity, clothing,
 * expression and a reference-sheet pose. That string is useful for generating a character
 * reference sheet, but it is the wrong source for a scene prompt: it lets the same sentence become
 * clothing, expression and pose at once, and it leaks "neutral 3/4 pose" into generated scenes.
 *
 * New projects opt into an ADDITIVE, version-gated contract:
 *
 *   appearance_lock: { age, gender, build, skin, face, hair, facial_hair, marks }
 *   wardrobe:        { default_outfit, outfits: { <outfit_id>: { top, bottom, ... } } }
 *   scene.outfit_ids:{ "@CHAR-...": "<outfit_id>" }   // only for intentional changes
 *
 * The contract is additive so existing manifests keep working in LEGACY mode. Strict mode is
 * selected when a project/character declares the new fields (or when a caller explicitly asks for
 * it); it FAILS CLOSED when appearance or wardrobe data is missing.
 *
 * This module is deliberately:
 *   · pure (no filesystem, browser, network, clock or randomness),
 *   · deterministic (same input -> same output),
 *   · non-inventive (missing data is reported, never filled with a guess),
 *   · independent of Flow/Playwright and of the Python pipeline.
 */

export type WardrobeMode = 'strict' | 'legacy';

export interface CanonicalAppearance {
  age?: unknown;
  gender?: unknown;
  build?: unknown;
  skin?: unknown;
  face?: unknown;
  hair?: unknown;
  facial_hair?: unknown;
  marks?: unknown;
  [key: string]: unknown;
}

export interface CanonicalOutfit {
  label?: unknown;
  top?: unknown;
  bottom?: unknown;
  outerwear?: unknown;
  footwear?: unknown;
  accessories?: unknown;
  hair?: unknown;
  notes?: unknown;
  [key: string]: unknown;
}

export interface CanonicalWardrobe {
  default_outfit?: unknown;
  outfits?: Record<string, CanonicalOutfit | unknown>;
  [key: string]: unknown;
}

export interface WardrobeCharacter {
  tag?: unknown;
  name?: unknown;
  look_summary?: unknown;
  appearance_lock?: unknown;
  wardrobe?: unknown;
  [key: string]: unknown;
}

export interface WardrobeScene {
  scene_number?: unknown;
  outfit_ids?: unknown;
  character_tags?: unknown;
  assets?: { character_tags?: unknown; [key: string]: unknown } | null;
  visual_action?: unknown;
  camera?: unknown;
  effects?: unknown;
  [key: string]: unknown;
}

export type WardrobeIssueCode =
  | 'WARDROBE_SCHEMA_INVALID'
  | 'APPEARANCE_MISSING'
  | 'WARDROBE_MISSING'
  | 'WARDROBE_DEFAULT_UNKNOWN'
  | 'WARDROBE_OUTFIT_UNKNOWN'
  | 'WARDROBE_OUTFIT_EMPTY'
  | 'WARDROBE_SCENE_OVERRIDE_UNKNOWN_CHARACTER'
  | 'WARDROBE_CONTRADICTION'
  | 'IDENTITY_VARIANT_CONTRADICTION'
  | 'REFERENCE_SHEET_LANGUAGE';

export interface WardrobeIssue {
  code: WardrobeIssueCode;
  reason: string;
  tag?: string;
  sceneNumber?: number;
  outfitId?: string;
}

export interface WardrobeValidationResult {
  ok: boolean;
  mode: WardrobeMode;
  issues: WardrobeIssue[];
}

export type OutfitResolution =
  | { ok: true; outfitId: string; outfit: CanonicalOutfit; source: 'default' | 'scene' }
  | { ok: false; code: WardrobeIssueCode; reason: string; outfitId?: string };

export type CharacterLockResult =
  | { ok: true; block: string; outfitId: string; appearanceText: string; wardrobeText: string }
  | { ok: false; code: WardrobeIssueCode; reason: string };

const text = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v)).trim();
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isOmitted = (v: unknown): boolean => {
  const s = text(v).toLowerCase();
  return s === '' || s === 'unknown' || s === 'unspecified' || s === 'null' || s === 'n/a' || s === 'na';
};

const CHARACTER_TAG = /^@CHAR-.+/;

/** Canonical scene-facing wardrobe continuity restraints. Shared by every strict generation path. */
export const WARDROBE_CONTINUITY_RESTRAINTS = [
  '### WARDROBE CONTINUITY (absolute)',
  '- Every character wears exactly the outfit specified in their CHARACTER LOCK for this entire clip.',
  '- Garment type, construction, layer order, sleeve length, neckline, hem length, fabric, colour, pattern, accessories, footwear and hair must remain identical from the first frame to the last.',
  '- Do not add, remove, open, untuck, roll up, tie, drape, recolour, restyle, damage, or replace any garment.',
  '- Do not let another character\'s clothing appear on this character.',
  '- Only an explicit scene outfit selection may use a different canonical outfit; never improvise a costume change.',
].join('\n');

export const CHARACTER_LOCKS_HEADER = '### CHARACTER LOCKS (authoritative; must not change)';

/**
 * PURE: decide the contract mode.
 *
 * Accepted inputs:
 *   · a character array,
 *   · a project object with `characters` and/or `wardrobe_schema_version`,
 *   · null/undefined (legacy).
 *
 * A project marker >= 1 is authoritative. Otherwise the presence of any explicit appearance or
 * wardrobe record promotes the project to strict mode, so a partially migrated manifest cannot
 * silently fall back to legacy look_summary behaviour.
 */
export function detectWardrobeMode(input: unknown): WardrobeMode {
  if (Array.isArray(input)) {
    return input.some((c) => isRecord(c) && (isRecord(c.wardrobe) || isRecord(c.appearance_lock))) ? 'strict' : 'legacy';
  }
  if (isRecord(input)) {
    const version = Number(input.wardrobe_schema_version);
    if (Number.isFinite(version) && version >= 1) return 'strict';
    const chars = input.characters;
    if (Array.isArray(chars)) return detectWardrobeMode(chars);
  }
  return 'legacy';
}

export const wardrobeModeForProject = detectWardrobeMode;

/** Ordered canonical appearance fields. */
const APPEARANCE_FIELDS = ['age', 'gender', 'build', 'skin', 'face', 'hair', 'facial_hair', 'marks'] as const;

/** PURE: format an explicit appearance lock as deterministic field-labelled prose. */
export function formatAppearance(appearance: unknown): string {
  if (!isRecord(appearance)) return '';
  const parts: string[] = [];
  for (const field of APPEARANCE_FIELDS) {
    const value = appearance[field];
    if (isOmitted(value)) continue;
    parts.push(`${field}: ${text(value)}`);
  }
  return parts.join('; ');
}

/** Ordered canonical wardrobe slots. */
const OUTFIT_FIELDS = ['top', 'bottom', 'outerwear', 'footwear', 'accessories', 'hair', 'notes'] as const;

/** PURE: format one outfit as deterministic field-labelled prose. */
export function formatOutfit(outfit: unknown): string {
  if (!isRecord(outfit)) return '';
  const parts: string[] = [];
  for (const field of OUTFIT_FIELDS) {
    const value = outfit[field];
    if (isOmitted(value)) continue;
    parts.push(`${field}: ${text(value)}`);
  }
  return parts.join('; ');
}

/** PURE: the scene's declared character tags, de-duplicated and order-preserving. */
export function sceneCharacterTags(scene: WardrobeScene | null | undefined): string[] {
  const raw = Array.isArray(scene?.character_tags)
    ? scene.character_tags
    : Array.isArray(scene?.assets?.character_tags)
      ? scene.assets.character_tags
      : [];
  const out: string[] = [];
  for (const value of raw) {
    const tag = text(value);
    if (!tag || !CHARACTER_TAG.test(tag) || out.includes(tag)) continue;
    out.push(tag);
  }
  return out;
}

/** PURE: resolve the exact canonical outfit for one character (scene override or default). */
export function resolveOutfit(
  character: WardrobeCharacter | null | undefined,
  scene?: WardrobeScene | null,
  mode: WardrobeMode = 'strict',
): OutfitResolution {
  const tag = text(character?.tag);
  if (!tag) return { ok: false, code: 'WARDROBE_SCHEMA_INVALID', reason: 'character has no @CHAR- tag.' };
  if (mode === 'legacy') {
    return { ok: false, code: 'WARDROBE_MISSING', reason: `character ${tag} is in legacy mode and has no explicit wardrobe contract.` };
  }
  const wardrobe = character?.wardrobe;
  if (!isRecord(wardrobe)) {
    return { ok: false, code: 'WARDROBE_MISSING', reason: `character ${tag} is missing wardrobe data; strict mode fails closed.` };
  }
  const outfits = wardrobe.outfits;
  if (!isRecord(outfits)) {
    return { ok: false, code: 'WARDROBE_MISSING', reason: `character ${tag} wardrobe has no outfits map; strict mode fails closed.` };
  }
  const overrides = isRecord(scene?.outfit_ids) ? scene.outfit_ids : {};
  const overrideRaw = overrides[tag];
  const override = text(overrideRaw);
  if (overrideRaw !== undefined && !override) {
    return { ok: false, code: 'WARDROBE_OUTFIT_UNKNOWN', reason: `character ${tag} has an empty scene outfit selection.` };
  }
  const defaultRaw = wardrobe.default_outfit;
  const defaultId = text(defaultRaw);
  if (!override && !defaultId) {
    return { ok: false, code: 'WARDROBE_DEFAULT_UNKNOWN', reason: `character ${tag} wardrobe has no default_outfit.` };
  }
  const outfitId = override || defaultId;
  if (!Object.prototype.hasOwnProperty.call(outfits, outfitId)) {
    return {
      ok: false,
      code: override ? 'WARDROBE_OUTFIT_UNKNOWN' : 'WARDROBE_DEFAULT_UNKNOWN',
      reason: override
        ? `character ${tag} selects unknown outfit ${JSON.stringify(outfitId)} in this scene.`
        : `character ${tag} default_outfit ${JSON.stringify(outfitId)} is not present in its outfits map.`,
      outfitId,
    };
  }
  const outfit = outfits[outfitId];
  if (!isRecord(outfit)) {
    return { ok: false, code: 'WARDROBE_OUTFIT_EMPTY', reason: `character ${tag} outfit ${JSON.stringify(outfitId)} is not an object.`, outfitId };
  }
  const wardrobeText = formatOutfit(outfit);
  if (!wardrobeText) {
    return { ok: false, code: 'WARDROBE_OUTFIT_EMPTY', reason: `character ${tag} outfit ${JSON.stringify(outfitId)} has no garment data.`, outfitId };
  }
  return { ok: true, outfitId, outfit, source: override ? 'scene' : 'default' };
}

export type ReferenceSheetMatch = { phrase: string };

const REFERENCE_SHEET_SOURCES = [
  String.raw`neutral\s+(?:3\s*\/\s*4|three[-\s]quarter)\s+(?:reference\s+)?pose`,
  String.raw`neutral\s+(?:3\s*\/\s*4|three[-\s]quarter)\s+reference`,
  String.raw`\b(?:full\s+)?character\s+reference\s+sheet\b`,
  String.raw`\breference[-\s]sheet\b`,
  String.raw`\bclear\s+front[-\s]facing\s+expression\b`,
  String.raw`\bfront[-\s]facing\s+expression\b`,
  String.raw`\bneutral\s+grey\s+studio\s+background\b`,
  String.raw`\bgrey\s+studio\s+background\b`,
  String.raw`\bneutral\s+grey\s+backdrop\b`,
  String.raw`\bgrey\s+backdrop\b`,
  String.raw`\bturnaround\s+sheet\b`,
  String.raw`--ar\s+\d+:\d+`,
  String.raw`\bneutral\s+pose\b`,
];

const freshReferenceScanner = (): RegExp => new RegExp(`(?:${REFERENCE_SHEET_SOURCES.join('|')})`, 'gi');

/** PURE: every reference-sheet-only phrase present in a text, de-duplicated in first-seen order. */
export function findReferenceSheetPhrases(input: unknown): string[] {
  const src = text(input);
  if (!src) return [];
  const out: string[] = [];
  const scanner = freshReferenceScanner();
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(src)) !== null) {
    if (!out.includes(match[0])) out.push(match[0]);
    if (match[0].length === 0) scanner.lastIndex++;
  }
  return out;
}

/**
 * PURE: remove reference-sheet-only phrases from scene-facing prose, then repair the resulting
 * punctuation/whitespace. Other text is preserved. This is deliberately a scene-facing sanitizer,
 * not a canonical resolver: the canonical pipeline data itself is not modified.
 */
export function sanitizeSceneFacingText(input: unknown): string {
  let out = text(input);
  if (!out) return '';
  const scanner = freshReferenceScanner();
  out = out.replace(scanner, '');
  out = out
    .replace(/\(\s*\)/g, '')
    .replace(/,\s*([.;!?])/g, '$1')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:])\s*([,.;:!?])/g, '$1')
    .replace(/\.{2,}/g, '.')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+$/gm, '')
    .trim();
  return out;
}

/** PURE: does a text carry reference-sheet-only language? */
export function hasReferenceSheetLanguage(input: unknown): boolean {
  return findReferenceSheetPhrases(input).length > 0;
}

/**
 * PURE: build the authoritative character lock block for one character.
 * Strict mode requires appearance_lock + a resolvable outfit and rejects reference-sheet language.
 */
export function buildCharacterLockBlock(
  character: WardrobeCharacter | null | undefined,
  scene?: WardrobeScene | null,
  mode: WardrobeMode = 'strict',
): CharacterLockResult {
  const tag = text(character?.tag);
  const name = text(character?.name) || tag || 'the character';
  if (mode === 'legacy') {
    return { ok: false, code: 'WARDROBE_MISSING', reason: `character ${tag || name} is in legacy mode; no character lock is available.` };
  }
  const appearanceText = formatAppearance(character?.appearance_lock);
  if (!appearanceText) {
    return { ok: false, code: 'APPEARANCE_MISSING', reason: `character ${tag || name} is missing appearance_lock data; strict mode fails closed.` };
  }
  const outfit = resolveOutfit(character, scene, mode);
  if (!outfit.ok) return { ok: false, code: outfit.code, reason: outfit.reason };
  const wardrobeText = formatOutfit(outfit.outfit);
  if (!wardrobeText) {
    return { ok: false, code: 'WARDROBE_OUTFIT_EMPTY', reason: `character ${tag || name} outfit ${JSON.stringify(outfit.outfitId)} has no garment data.` };
  }
  const label = text(outfit.outfit.label);
  const combined = [appearanceText, wardrobeText, label].join(' ');
  const forbidden = findReferenceSheetPhrases(combined);
  if (forbidden.length > 0) {
    return {
      ok: false,
      code: 'REFERENCE_SHEET_LANGUAGE',
      reason: `character ${tag || name} explicit contract contains reference-sheet-only language (${forbidden.join(', ')}); strict mode rejects it.`,
    };
  }
  const labelSuffix = label ? ` (${label})` : '';
  const block = [
    `- ${name}`,
    `  IDENTITY (fixed): ${appearanceText}.`,
    `  WARDROBE (fixed; outfit ${JSON.stringify(outfit.outfitId)}${labelSuffix}): ${wardrobeText}.`,
    '  Do not change, add, remove, recolour, restyle, tuck, roll up, open, or damage any garment. Do not copy another character\'s clothing.',
  ].join('\n');
  return { ok: true, block, outfitId: outfit.outfitId, appearanceText, wardrobeText };
}

const GARMENT_GROUPS: readonly (readonly string[])[] = [
  ['t-shirt', 'tshirt', 'shirt', 'कमीज', 'शर्ट'],
  ['kurta', 'कुर्ता'],
  ['saree', 'sari', 'साड़ी'],
  ['pyjama', 'pajama', 'pajamas', 'पैजामा'],
  ['trousers', 'trouser', 'pants', 'pant', 'पतलून'],
  ['dhoti', 'धोती'],
  ['blouse', 'ब्लाउज'],
  ['shawl', 'शॉल'],
  ['dupatta', 'दुपट्टा'],
  ['jacket', 'coat', 'sweater', 'hoodie', 'जैकेट', 'कोट'],
  ['dress', 'frock', 'gown', 'पोशाक'],
  ['skirt', 'shorts', 'लहंगा'],
  ['footwear', 'shoes', 'sandals', 'slippers', 'chappal', 'जूते', 'चप्पल'],
  ['spectacles', 'glasses', 'चश्मा'],
  ['bangle', 'bangles', 'bracelet', 'jewellery', 'jewelry', 'कंगन', 'गहने'],
  ['nightwear', 'nightdress', 'sleepwear'],
];

const COLOR_GROUPS: readonly (readonly string[])[] = [
  ['red', 'लाल'],
  ['blue', 'नीला', 'नीली'],
  ['green', 'हरा', 'हरी'],
  ['white', 'सफेद', 'सफ़ेद'],
  ['black', 'काला', 'काली'],
  ['grey', 'gray', 'भूरा', 'स्लेटी'],
  ['brown', 'भूरा'],
  ['beige', 'बेज'],
  ['navy', 'नेवी'],
  ['maroon', 'मैरून'],
  ['pink', 'गुलाबी'],
  ['purple', 'बैंगनी'],
  ['yellow', 'पीला', 'पीली'],
  ['orange', 'नारंगी'],
  ['golden', 'gold', 'सुनहरा', 'सुनहरी'],
  ['silver', 'चांदी'],
  ['saffron', 'केसरिया'],
];

const WEARING_TERMS = /\b(?:wearing|dressed\s+in|clad\s+in|changes?\s+into|changed\s+into|outfit|costume)\b|पहन(?:ा|ी|े|ता|ती)|वेशभूषा/i;
const ADULT_AGE = /\b(?:1[89]|[2-9]\d)\b/;
const PRONOUN = /\b(?:he|she|his|her|him)\b|वह|उसने|उसका|उसकी/i;

const normalize = (s: string): string => s.toLowerCase().replace(/[’']/g, "'").replace(/[‐‑]/g, '-');
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * PURE: does one sentence portray this SPECIFIC named adult as a child?
 * A bare mention of a different child ("Arjun tells the child a story") must not count, so the
 * name has to be directly modified by a child term or joined to a child predicate.
 */
function namesChildVariant(sentence: string, name: string): boolean {
  const n = escapeRegExp(name.trim());
  if (!n) return false;
  const childNoun = String.raw`(?:child|kid|toddler|infant|young\s+(?:boy|girl)|small\s+(?:boy|girl)|little\s+(?:boy|girl))`;
  const patterns = [
    String.raw`\b(?:young|little|child|kid)\s+${n}\b`,
    String.raw`\b${n}\b\s*,?\s*(?:is|was|as|appears|looks(?:\s+like)?)\s+(?:a\s+|an\s+|the\s+)?(?:young\s+|small\s+|little\s+)?${childNoun}\b`,
    String.raw`\b${n}\b\s*,\s*(?:a\s+|an\s+)?(?:young\s+|small\s+|little\s+)?${childNoun}\b`,
  ];
  return patterns.some((p) => new RegExp(p, 'i').test(sentence));
}

const groupMatches = (haystack: string, groups: readonly (readonly string[])[]): string[] => {
  const h = normalize(haystack);
  const hits: string[] = [];
  for (const group of groups) {
    if (group.some((term) => h.includes(normalize(term)))) {
      for (const term of group) if (h.includes(normalize(term))) hits.push(term);
    }
  }
  return hits;
};

const groupAllowed = (corpus: string, group: readonly string[]): boolean => {
  const c = normalize(corpus);
  return group.some((term) => c.includes(normalize(term)));
};

/** PURE: find scene prose that contradicts the declared wardrobe. */
export function findWardrobeContradictions(
  scene: WardrobeScene | null | undefined,
  characters: readonly WardrobeCharacter[] | null | undefined,
  mode: WardrobeMode = 'strict',
): WardrobeIssue[] {
  if (mode !== 'strict' || !scene) return [];
  const tags = sceneCharacterTags(scene);
  if (tags.length === 0) return [];
  const declared = tags
    .map((tag) => (characters ?? []).find((c) => text(c?.tag) === tag))
    .filter((c): c is WardrobeCharacter => !!c);
  if (declared.length === 0) return [];
  const corpus = declared
    .map((c) => {
      const r = resolveOutfit(c, scene, mode);
      if (!r.ok) return '';
      return `${text(c.name)} ${formatOutfit(r.outfit)} ${text(r.outfit.label)}`;
    })
    .join(' ');
  const sceneNumber = Number(scene.scene_number);
  const fields: Array<[string, unknown]> = [
    ['visual_action', scene.visual_action],
    ['camera', scene.camera],
    ['effects', scene.effects],
  ];
  const issues: WardrobeIssue[] = [];
  for (const [field, raw] of fields) {
    const src = text(raw);
    if (!src) continue;
    for (const sentence of src.split(/[.!?।\n]+/)) {
      const s = sentence.trim();
      if (!s) continue;
      const names = declared.map((c) => text(c.name)).filter(Boolean);
      const named = names.some((n) => normalize(s).includes(normalize(n)));
      const pronoun = declared.length === 1 && PRONOUN.test(s);
      if (!named && !pronoun) continue;
      const garmentHits = groupMatches(s, GARMENT_GROUPS);
      // A colour is only a wardrobe signal when the same sentence also names a garment or uses a
      // wearing verb. Otherwise "her red eyes glow" / "red moonlight" would be misread as an
      // improvised outfit. Appearance colours live in appearance_lock, not in the outfit corpus.
      const wearing = WEARING_TERMS.test(s);
      if (garmentHits.length === 0 && !wearing) continue;
      for (const group of COLOR_GROUPS) {
        if (!groupMatches(s, [group]).length) continue;
        if (!groupAllowed(corpus, group)) {
          issues.push({
            code: 'WARDROBE_CONTRADICTION',
            sceneNumber: Number.isInteger(sceneNumber) ? sceneNumber : undefined,
            reason: `scene ${Number.isInteger(sceneNumber) ? sceneNumber : '?'} ${field} names a colour (${group[0]}) that is absent from the declared outfit(s); do not improvise a wardrobe change.`,
          });
        }
      }
      for (const group of GARMENT_GROUPS) {
        if (!groupMatches(s, [group]).length) continue;
        if (!groupAllowed(corpus, group)) {
          issues.push({
            code: 'WARDROBE_CONTRADICTION',
            sceneNumber: Number.isInteger(sceneNumber) ? sceneNumber : undefined,
            reason: `scene ${Number.isInteger(sceneNumber) ? sceneNumber : '?'} ${field} names a garment (${group[0]}) that is absent from the declared outfit(s); add an explicit outfit_ids entry instead.`,
          });
        }
      }
    }
  }
  return issues;
}

/** PURE: detect an adult character being written as a child in scene prose without a distinct variant tag. */
export function findIdentityVariantContradictions(
  scene: WardrobeScene | null | undefined,
  characters: readonly WardrobeCharacter[] | null | undefined,
  mode: WardrobeMode = 'strict',
): WardrobeIssue[] {
  if (mode !== 'strict' || !scene) return [];
  const tags = sceneCharacterTags(scene);
  if (tags.length === 0) return [];
  const sceneNumber = Number(scene.scene_number);
  const src = [text(scene.visual_action), text(scene.camera), text(scene.effects)].filter(Boolean).join(' ');
  if (!src) return [];
  const issues: WardrobeIssue[] = [];
  for (const tag of tags) {
    const character = (characters ?? []).find((c) => text(c?.tag) === tag);
    if (!character) continue;
    const appearance = isRecord(character.appearance_lock) ? character.appearance_lock : {};
    const ageText = text(appearance.age);
    if (!ageText || !ADULT_AGE.test(ageText) || /child|minor|teen|बच्च/i.test(ageText)) continue;
    const name = text(character.name);
    if (!name) continue;
    for (const sentence of src.split(/[.!?।\n]+/)) {
      const s = sentence.trim();
      if (!s || !namesChildVariant(s, name)) continue;
      issues.push({
        code: 'IDENTITY_VARIANT_CONTRADICTION',
        tag,
        sceneNumber: Number.isInteger(sceneNumber) ? sceneNumber : undefined,
        reason: `scene ${Number.isInteger(sceneNumber) ? sceneNumber : '?'} portrays adult character ${tag} as a child; use a separate character tag (for example @CHAR-05-YOUNG-ARJUN) with its own appearance_lock and wardrobe.`,
      });
      break;
    }
  }
  return issues;
}

/** PURE: validate a whole project's appearance/wardrobe contract. Legacy projects pass unchanged. */
export function validateWardrobe(project: unknown, options?: { mode?: WardrobeMode } | null): WardrobeValidationResult {
  const mode = options?.mode ?? detectWardrobeMode(project);
  if (mode === 'legacy') return { ok: true, mode, issues: [] };
  const issues: WardrobeIssue[] = [];
  const p = isRecord(project) ? project : {};
  const characters = Array.isArray(p.characters) ? p.characters : [];
  const scenes = Array.isArray(p.scenes) ? p.scenes : [];
  if (characters.length === 0) {
    return { ok: false, mode, issues: [{ code: 'WARDROBE_SCHEMA_INVALID', reason: 'strict wardrobe mode requires a non-empty characters array.' }] };
  }
  const byTag = new Map<string, WardrobeCharacter>();
  for (const raw of characters) {
    if (!isRecord(raw)) {
      issues.push({ code: 'WARDROBE_SCHEMA_INVALID', reason: 'character entry is not an object.' });
      continue;
    }
    const c = raw as WardrobeCharacter;
    const tag = text(c.tag);
    if (!CHARACTER_TAG.test(tag)) {
      issues.push({ code: 'WARDROBE_SCHEMA_INVALID', reason: `character tag ${JSON.stringify(c.tag)} is not an exact "@CHAR-" identity.` });
      continue;
    }
    if (byTag.has(tag)) {
      issues.push({ code: 'WARDROBE_SCHEMA_INVALID', tag, reason: `duplicate character tag ${tag}.` });
      continue;
    }
    byTag.set(tag, c);
    const appearanceText = formatAppearance(c.appearance_lock);
    if (!appearanceText) {
      issues.push({ code: 'APPEARANCE_MISSING', tag, reason: `character ${tag} is missing appearance_lock.` });
    } else if (hasReferenceSheetLanguage(appearanceText)) {
      issues.push({ code: 'REFERENCE_SHEET_LANGUAGE', tag, reason: `character ${tag} appearance_lock contains reference-sheet-only language.` });
    }
    const wardrobe = c.wardrobe;
    if (!isRecord(wardrobe)) {
      issues.push({ code: 'WARDROBE_MISSING', tag, reason: `character ${tag} is missing wardrobe.` });
      continue;
    }
    const outfits = wardrobe.outfits;
    if (!isRecord(outfits) || Object.keys(outfits).length === 0) {
      issues.push({ code: 'WARDROBE_MISSING', tag, reason: `character ${tag} wardrobe has no outfits.` });
      continue;
    }
    const defaultId = text(wardrobe.default_outfit);
    if (!defaultId) {
      issues.push({ code: 'WARDROBE_DEFAULT_UNKNOWN', tag, reason: `character ${tag} wardrobe has no default_outfit.` });
    } else if (!Object.prototype.hasOwnProperty.call(outfits, defaultId)) {
      issues.push({ code: 'WARDROBE_DEFAULT_UNKNOWN', tag, outfitId: defaultId, reason: `character ${tag} default_outfit ${JSON.stringify(defaultId)} is not in outfits.` });
    }
    for (const [outfitId, rawOutfit] of Object.entries(outfits)) {
      if (!outfitId.trim()) {
        issues.push({ code: 'WARDROBE_SCHEMA_INVALID', tag, reason: `character ${tag} has an empty outfit id.` });
        continue;
      }
      if (!isRecord(rawOutfit)) {
        issues.push({ code: 'WARDROBE_OUTFIT_EMPTY', tag, outfitId, reason: `character ${tag} outfit ${JSON.stringify(outfitId)} is not an object.` });
        continue;
      }
      const outfitText = formatOutfit(rawOutfit);
      if (!outfitText) {
        issues.push({ code: 'WARDROBE_OUTFIT_EMPTY', tag, outfitId, reason: `character ${tag} outfit ${JSON.stringify(outfitId)} has no garment data.` });
      } else if (hasReferenceSheetLanguage(outfitText)) {
        issues.push({ code: 'REFERENCE_SHEET_LANGUAGE', tag, outfitId, reason: `character ${tag} outfit ${JSON.stringify(outfitId)} contains reference-sheet-only language.` });
      }
    }
  }

  for (const rawScene of scenes) {
    if (!isRecord(rawScene)) continue;
    const scene = rawScene as WardrobeScene;
    const sceneNumber = Number(scene.scene_number);
    const tags = sceneCharacterTags(scene);
    const overrides = scene.outfit_ids;
    if (overrides !== undefined && overrides !== null && !isRecord(overrides)) {
      issues.push({ code: 'WARDROBE_SCHEMA_INVALID', sceneNumber: Number.isInteger(sceneNumber) ? sceneNumber : undefined, reason: 'outfit_ids must be an object keyed by character tag.' });
    }
    if (isRecord(overrides)) {
      for (const [tag, value] of Object.entries(overrides)) {
        if (!tags.includes(tag)) {
          issues.push({
            code: 'WARDROBE_SCENE_OVERRIDE_UNKNOWN_CHARACTER',
            tag,
            sceneNumber: Number.isInteger(sceneNumber) ? sceneNumber : undefined,
            reason: `scene ${Number.isInteger(sceneNumber) ? sceneNumber : '?'} selects an outfit for ${tag}, but that character is not declared in the scene.`,
          });
        }
        if (!text(value)) {
          issues.push({ code: 'WARDROBE_OUTFIT_UNKNOWN', tag, sceneNumber: Number.isInteger(sceneNumber) ? sceneNumber : undefined, reason: `scene outfit selection for ${tag} is empty.` });
        }
      }
    }
    for (const tag of tags) {
      const character = byTag.get(tag);
      if (!character) {
        issues.push({ code: 'WARDROBE_SCHEMA_INVALID', tag, sceneNumber: Number.isInteger(sceneNumber) ? sceneNumber : undefined, reason: `scene declares unknown character ${tag}.` });
        continue;
      }
      const outfit = resolveOutfit(character, scene, mode);
      if (!outfit.ok) {
        issues.push({ code: outfit.code, tag, sceneNumber: Number.isInteger(sceneNumber) ? sceneNumber : undefined, outfitId: outfit.outfitId, reason: outfit.reason });
      }
    }
    issues.push(...findWardrobeContradictions(scene, characters as WardrobeCharacter[], mode));
    issues.push(...findIdentityVariantContradictions(scene, characters as WardrobeCharacter[], mode));
  }

  return { ok: issues.length === 0, mode, issues };
}

/** PURE: concise, deterministic human-readable issue list (for CLI/docs/tests). */
export function formatWardrobeIssues(issues: readonly WardrobeIssue[]): string {
  return issues.map((i) => `${i.code}${i.tag ? ` [${i.tag}]` : ''}${i.sceneNumber !== undefined ? ` scene ${i.sceneNumber}` : ''}: ${i.reason}`).join('\n');
}
