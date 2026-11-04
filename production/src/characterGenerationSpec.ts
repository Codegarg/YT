/**
 * Character asset generation specification (STEP-8DZ; project-derived).
 *
 * A typed, deterministic spec that lets an EXTERNAL, off-Flow image provider produce clean
 * transparent cutouts satisfying the existing local contract.
 *
 * The spec is derived FROM A PROJECT'S pipeline.json (the source of truth) via
 * `loadCharacterGenerationSpecs()`, so the character identity/tags/visual descriptions always
 * match the project being produced. Story-specific constants are intentionally NOT hard-coded.
 *
 * Why this file exists:
 *   · 8DU/8DV proved Flow character output is an OPAQUE 1376×768 model sheet — unusable, and
 *     unrecoverable (cross-origin, no export, no alpha).
 *   · The local contract requires a transparent PNG/WebP, ≥1024×1024, square-ish, single
 *     character, real pixel alpha (8DX hardened).
 *
 * `CHARACTER_GENERATION_SPECS` remains as a small built-in EXAMPLE cast so provider/testing
 * flows keep working; the production path uses `loadCharacterGenerationSpecs(pipeline)`.
 *
 * NO provider is called here.
 */
import { MIN_CHARACTER_WIDTH, MIN_CHARACTER_HEIGHT, CHARACTER_ASPECT_RATIO, CHARACTER_ASPECT_TOLERANCE, SUPPORTED_CHARACTER_EXTENSIONS } from './characterAsset.js';
import {
  detectWardrobeMode,
  formatAppearance,
  formatOutfit,
  resolveOutfit,
  sanitizeSceneFacingText,
} from './characterWardrobe.js';

/**
 * Reference-sheet-only expression/pose. These are used for the character cutout asset, never as
 * scene-facing narrative direction. Explicit wardrobe data supplies clothing in strict mode.
 */
export const REFERENCE_SHEET_EXPRESSION = 'neutral, calm expression';
export const REFERENCE_SHEET_POSE = 'neutral three-quarter standing reference pose, relaxed natural posture';

/** The single shared art direction for all four characters. */
export const COMMON_STYLE =
  '2D semi-realistic Indian horror illustration, bold clean outlines, flat cel shading, subtle cinematic lighting, Indian visual design, expressive faces, polished digital illustration, consistent proportions and line quality';

/**
 * Project-derived VISUAL style: pipeline.json character prompts already embed the project's own
 * style (e.g. "2D semi-realistic cartoon illustration…"). When present it is used VERBATIM as the
 * spec's `common_style`; otherwise the built-in `COMMON_STYLE` is used. Never invents a style.
 */
export const PROJECT_VISUAL_STYLE_MARKER = '2D semi-realistic';
export const PROJECT_VISUAL_STYLE_FALLBACK = 'neutral grey studio background';

/** One shared negative prompt for every character. */
export const SHARED_NEGATIVE_PROMPT = [
  'character sheet', 'turnaround sheet', 'multiple views', 'side view', 'back view',
  'multiple characters', 'duplicate character', 'extra person',
  'cropped body', 'cropped feet', 'missing limbs', 'extra limbs', 'extra fingers', 'deformed hands',
  'text', 'typography', 'labels', 'captions', 'watermark', 'logo', 'UI', 'interface', 'frame', 'border',
  'grey studio background', 'colored background', 'scenery', 'room', 'props', 'background objects',
  'opaque background', 'white background', 'black background', 'gradient background',
  'photographic realism', '3D render', 'anime', 'chibi', 'exaggerated cartoon proportions',
].join(', ');

/** Renderer/compositor contract every generated asset must satisfy. */
export interface RequiredOutputContract {
  format: 'png';
  transparency: 'required';
  /** Real pixel alpha — `∃ pixel alpha < 255` (8DX). An all-opaque RGBA image is rejected. */
  pixelAlpha: 'required';
  minWidth: number;
  minHeight: number;
  aspect: 'square-ish';
  aspectRatio: number;
  aspectTolerance: number;
  singleCharacter: true;
  fullBody: true;
  feetVisible: true;
  maxCharacters: 1;
  compositingWidth: 1920;
  compositingHeight: 1080;
}

export const REQUIRED_OUTPUT_CONTRACT: RequiredOutputContract = {
  format: 'png',
  transparency: 'required',
  pixelAlpha: 'required',
  minWidth: MIN_CHARACTER_WIDTH,
  minHeight: MIN_CHARACTER_HEIGHT,
  aspect: 'square-ish',
  aspectRatio: CHARACTER_ASPECT_RATIO,
  aspectTolerance: CHARACTER_ASPECT_TOLERANCE,
  singleCharacter: true,
  fullBody: true,
  feetVisible: true,
  maxCharacters: 1,
  compositingWidth: 1920,
  compositingHeight: 1080,
};

/** Universal image requirements phrased as prompt text (appended to every character prompt). */
export const UNIVERSAL_IMAGE_REQUIREMENTS =
  'full body, one single character only, standing neutral three-quarter reference pose, feet visible, relaxed natural posture, isolated on a fully transparent background with true alpha transparency, square canvas, no cropping, no second character, no props, no text, no labels, no UI, no model sheet, no turnaround sheet, no multiple poses, no side or back views, no studio or coloured background, no border, no frame, no watermark, no logo';

export interface CharacterGenerationSpec {
  tag: string;
  name: string;
  age: string;
  gender: string;
  personality: string;
  voice_description: string;
  physical_appearance: string;
  clothing: string;
  expression: string;
  pose: string;
  common_style: string;
  generation_prompt: string;
  negative_prompt: string;
  required_output_contract: RequiredOutputContract;
}

const base = (
  c: Omit<CharacterGenerationSpec, 'common_style' | 'required_output_contract'>,
): CharacterGenerationSpec => ({
  ...c,
  common_style: COMMON_STYLE,
  required_output_contract: REQUIRED_OUTPUT_CONTRACT,
});

const prompt = (subject: string, extraNegative = ''): string =>
  `${COMMON_STYLE}. ${subject}. ${UNIVERSAL_IMAGE_REQUIREMENTS}.`;

// ---------------------------------------------------------------------------------------
// Project-derived specs (single source of truth = the project's pipeline.json)
// ---------------------------------------------------------------------------------------

/** Explicit failure state when pipeline characters cannot be turned into valid specs. */
export interface CharacterSpecSourceResult {
  ok: boolean;
  specs: CharacterGenerationSpec[];
  reason?: string;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Preserve a value string verbatim; `null`/`undefined`/blank become '' (never invented). */
const optString = (v: unknown): string => (v === null || v === undefined || v === '' ? '' : String(v).trim());

/** Build a human age phrase from pipeline `age` when it is a finite number; else '' (not invented). */
function agePhrase(age: unknown): string {
  return typeof age === 'number' && Number.isFinite(age) ? `approximately ${age} years old` : '';
}

/**
 * Preserve a field's semantics WITHOUT inventing a value: return '' when the pipeline value is
 * absent so `validateCharacterSpecs` fails closed (the project must supply the data). No made-up
 * defaults are ever substituted.
 */
const preserveOrEmpty = (v: unknown): string => optString(v);

/**
 * Derive the project's VISUAL style from its own character prompts (verbatim substring), so all
 * project-derived character prompts share the project's established art direction. Falls back to
 * the built-in `COMMON_STYLE` when the prompts carry no recognizable style; never invents one.
 */
export function deriveVisualStyle(rawCharacters: readonly unknown[]): string {
  for (const raw of rawCharacters) {
    const full = (raw as any)?.full_prompt;
    if (!isNonEmptyString(full)) continue;
    const idx = full.indexOf(PROJECT_VISUAL_STYLE_MARKER);
    if (idx >= 0) {
      const end = full.indexOf(PROJECT_VISUAL_STYLE_FALLBACK, idx);
      return (end > idx ? full.slice(idx, end) : full.slice(idx)).trim().replace(/[,\s]+$/, '');
    }
  }
  return COMMON_STYLE;
}

/**
 * PURE: build generation specs from an array of pipeline character entries. Fail-closed per entry
 * with a precise reason. Uses the exact pipeline tag + full visual prompt; does not invent values.
 */
export function characterSpecsFromPipeline(pipeline: unknown): CharacterSpecSourceResult {
  const characters = (pipeline as any)?.characters;
  if (!Array.isArray(characters) || characters.length === 0) {
    return { ok: false, specs: [], reason: 'Pipeline exposes no characters array to derive specs from.' };
  }
  const projectStyle = deriveVisualStyle(characters);
  const style = projectStyle === COMMON_STYLE ? COMMON_STYLE : `${COMMON_STYLE}; project art direction: ${projectStyle}`;
  const mode = detectWardrobeMode(pipeline);
  const specs: CharacterGenerationSpec[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < characters.length; i++) {
    const c: any = characters[i] ?? {};
    const tag = optString(c.tag);
    if (!/^@CHAR-\d{2}-[A-Z0-9-]+$/.test(tag)) return { ok: false, specs: [], reason: `Character ${i}: invalid or missing tag ${JSON.stringify(c.tag)}.` };
    if (seen.has(tag)) return { ok: false, specs: [], reason: `Character ${i}: duplicate tag ${tag}.` };
    seen.add(tag);
    if (!isNonEmptyString(c.full_prompt)) return { ok: false, specs: [], reason: `Character ${tag}: missing the authoritative full_prompt visual description.` };

    if (mode === 'strict') {
      const appearance = formatAppearance(c.appearance_lock);
      if (!appearance) return { ok: false, specs: [], reason: `Character ${tag}: missing appearance_lock; strict wardrobe mode fails closed.` };
      const outfit = resolveOutfit(c, null, 'strict');
      if (!outfit.ok) return { ok: false, specs: [], reason: `Character ${tag}: ${outfit.reason}` };
      const wardrobe = formatOutfit(outfit.outfit);
      if (!wardrobe) return { ok: false, specs: [], reason: `Character ${tag}: default outfit ${JSON.stringify(outfit.outfitId)} has no garment data.` };
      specs.push({
        tag,
        name: optString(c.name),
        age: agePhrase(c.age) || preserveOrEmpty(c.age),
        gender: preserveOrEmpty(c.gender),
        personality: preserveOrEmpty(c.personality),
        voice_description: preserveOrEmpty(c.voice_description),
        // Strict mode: apparel comes ONLY from the explicit wardrobe contract. `look_summary` and
        // `full_prompt` remain available for the reference sheet, but never become scene clothing.
        physical_appearance: appearance,
        clothing: wardrobe,
        expression: REFERENCE_SHEET_EXPRESSION,
        pose: REFERENCE_SHEET_POSE,
        common_style: style,
        generation_prompt: `${style}. ${appearance}. WARDROBE (fixed): ${wardrobe}. ${REFERENCE_SHEET_EXPRESSION}, ${REFERENCE_SHEET_POSE}. ${UNIVERSAL_IMAGE_REQUIREMENTS}.`,
        negative_prompt: SHARED_NEGATIVE_PROMPT,
        required_output_contract: REQUIRED_OUTPUT_CONTRACT,
      });
      continue;
    }

    // LEGACY fallback: the project has no explicit wardrobe contract. Preserve the historical
    // generation prompt byte-for-byte, but stop treating one look_summary sentence as clothing,
    // expression AND pose. Clothing is only the sanitized legacy identity source; the reference
    // sheet gets neutral expression/pose constants.
    if (!isNonEmptyString(c.look_summary)) return { ok: false, specs: [], reason: `Character ${tag}: missing look_summary in legacy mode.` };
    const legacyClothing = sanitizeSceneFacingText(String(c.look_summary).trim());
    specs.push({
      tag,
      name: optString(c.name),
      age: agePhrase(c.age) || preserveOrEmpty(c.age),
      gender: preserveOrEmpty(c.gender),
      personality: preserveOrEmpty(c.personality),
      voice_description: preserveOrEmpty(c.voice_description),
      physical_appearance: String(c.full_prompt).trim(),
      clothing: legacyClothing,
      expression: REFERENCE_SHEET_EXPRESSION,
      pose: REFERENCE_SHEET_POSE,
      common_style: style,
      generation_prompt: `${style}. ${String(c.full_prompt).trim()}. ${UNIVERSAL_IMAGE_REQUIREMENTS}.`,
      negative_prompt: SHARED_NEGATIVE_PROMPT,
      required_output_contract: REQUIRED_OUTPUT_CONTRACT,
    });
  }
  return { ok: true, specs };
}

/**
 * Pure alias intended callers use: derive specs from an already-parsed pipeline object.
 * Compatible with callers that hold the pipeline JSON in memory (no filesystem, no Flow).
 */
export function loadCharacterGenerationSpecs(pipeline: unknown): CharacterGenerationSpec[] {
  const r = characterSpecsFromPipeline(pipeline);
  if (!r.ok) throw new Error(`Could not derive character specs from the pipeline: ${r.reason}`);
  return r.specs;
}

export const CHARACTER_GENERATION_SPECS: readonly CharacterGenerationSpec[] = [
  base({
    tag: '@CHAR-01-ARJUN',
    name: 'अर्जुन',
    age: 'approximately 22 years old',
    gender: 'male',
    personality: 'calm, curious (as expressed through a calm curious demeanour)',
    voice_description: 'Young male, native North Indian Hindi voice, calm and curious tone.',
    physical_appearance:
      'young Indian man, slim build, medium brown skin, sharp jawline, expressive dark brown eyes, straight nose, thick eyebrows, short black hair neatly combed, clean-shaven, no facial hair, no scars, no distinguishing marks',
    clothing: 'light blue cotton kurta, white pajama trousers, light shawl draped over one shoulder',
    expression: 'calm, curious',
    pose: 'neutral three-quarter standing reference pose, relaxed natural posture',
    generation_prompt: prompt(
      'Young Indian man approximately 22 years old, slim build, medium brown skin, sharp jawline, expressive dark brown eyes, straight nose, thick eyebrows, short black hair neatly combed, clean-shaven with no facial hair and no distinguishing marks, wearing a light blue cotton kurta with white pajama trousers and a light shawl draped over one shoulder, calm curious expression, relaxed natural posture',
    ),
    negative_prompt: `${SHARED_NEGATIVE_PROMPT}, facial hair, beard, moustache, stubble, scars, tattoos, blemishes`,
  }),
  base({
    tag: '@CHAR-02-MOHAN',
    name: 'मोहन',
    age: 'approximately 23 years old',
    gender: 'male',
    personality: 'anxious, hesitant',
    voice_description: 'Young male, native North Indian Hindi voice, anxious and hesitant tone.',
    physical_appearance:
      'young Indian man, medium build, warm brown skin, round face, soft dark brown eyes, broad nose, thick eyebrows, short wavy black hair, clean-shaven, no facial hair, no scars, no distinguishing marks',
    clothing: 'simple checked cotton shirt with rolled-up sleeves, dark trousers',
    expression: 'anxious and hesitant',
    pose: 'neutral three-quarter standing reference pose, natural slightly tense posture',
    generation_prompt: prompt(
      'Young Indian man approximately 23 years old, medium build, warm brown skin, round face, soft dark brown eyes, broad nose, thick eyebrows, short wavy black hair, clean-shaven with no facial hair and no distinguishing marks, wearing a simple checked cotton shirt with rolled-up sleeves and dark trousers, anxious hesitant expression, natural slightly tense posture',
    ),
    negative_prompt: `${SHARED_NEGATIVE_PROMPT}, facial hair, beard, moustache, stubble, scars, tattoos`,
  }),
  base({
    tag: '@CHAR-03-GEETA',
    name: 'गीता',
    age: 'appearing approximately 20 years old',
    gender: 'female (supernatural entity / ghost)',
    personality: 'eerie yet calm; haunting stillness',
    voice_description: 'Female ghost/entity, native North Indian Hindi voice, eerie and haunting tone.',
    physical_appearance:
      'female ghost/entity, slender build, pale greenish-grey skin, gaunt face, sharp jawline, hollow cheeks, glowing white eyes, thin arched eyebrows, slender nose, long messy untamed black hair',
    clothing: 'tattered traditional saree, faded red, with visible tears and dirt, subtle eerie under-glow beneath the feet',
    expression: 'haunting but calm',
    pose: 'neutral three-quarter standing reference pose',
    generation_prompt: prompt(
      'Female ghost entity appearing approximately 20 years old, slender build, pale greenish-grey skin, gaunt face with sharp jawline and hollow cheeks, glowing white eyes, thin arched eyebrows, slender nose, long messy untamed black hair, wearing a tattered faded-red traditional saree with visible tears and dirt and a subtle eerie under-glow beneath the feet, haunting but calm expression, eerie supernatural presence yet visually consistent with a grounded Indian village horror cast',
    ),
    negative_prompt: `${SHARED_NEGATIVE_PROMPT}, gore, blood, wounds, injury, decay, maggots, extra entities, multiple ghosts, floating, levitation, translucent body, monster, demon horns`,
  }),
  base({
    tag: '@CHAR-04-BUZURG',
    name: 'बुजुर्ग',
    age: 'approximately 70 years old',
    gender: 'male (elderly)',
    personality: 'wise, calm',
    voice_description: 'Elderly male, native North Indian Hindi voice, wise and calm tone.',
    physical_appearance:
      'elderly Indian man, lean build, dark brown skin with visible wrinkles and age spots, oval face, deep-set dark brown eyes, hooked nose, bushy white eyebrows, short white hair, neatly trimmed white beard and moustache, no scars, no unusual distinguishing marks',
    clothing: 'white cotton dhoti, white kurta, beige shawl',
    expression: 'wise and calm',
    pose: 'neutral three-quarter standing reference pose, natural elderly posture',
    generation_prompt: prompt(
      'Elderly Indian man approximately 70 years old, lean build, dark brown skin with visible wrinkles and age spots, oval face, deep-set dark brown eyes, hooked nose, bushy white eyebrows, short white hair, neatly trimmed white beard and moustache, no scars and no unusual distinguishing marks, wearing a white cotton dhoti with a white kurta and a beige shawl, wise calm expression, natural elderly posture',
    ),
    negative_prompt: `${SHARED_NEGATIVE_PROMPT}, scars, tattoos, dirt, rags, hunched-over distortion, missing teeth, extreme frailty`,
  }),
];

/** Deterministic canonical filename for a character tag (mirrors the local contract). */
export function canonicalCharacterFilename(tag: unknown): string | null {
  const stem = String(tag ?? '').trim().replace(/^[@#]\s*/, '')
    .replace(/[/\\]/g, '-').replace(/[:*?"<>|]/g, '').replace(/\.+/g, '-')
    .replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  const limited = stem.slice(0, 120).replace(/^-+|-+$/g, '');
  return limited ? `${limited}.png` : null;
}

/** Validate that every spec is complete and internally consistent. */
export function validateCharacterSpecs(specs: readonly CharacterGenerationSpec[] = CHARACTER_GENERATION_SPECS): { ok: true } | { ok: false; reason: string } {
  if (!Array.isArray(specs) || specs.length === 0) return { ok: false, reason: 'No character specs were provided.' };
  const seen = new Set<string>();
  for (const s of specs) {
    if (!s.tag || !/^@CHAR-\d{2}-[A-Z0-9-]+$/.test(s.tag)) return { ok: false, reason: `Invalid or missing tag: ${JSON.stringify(s.tag)}.` };
    if (seen.has(s.tag)) return { ok: false, reason: `Duplicate tag: ${s.tag}.` };
    seen.add(s.tag);
    if (!s.name?.trim()) return { ok: false, reason: `${s.tag} is missing a name.` };
    if (typeof s.age !== 'string') return { ok: false, reason: `${s.tag} age must be a string.` };
    for (const field of ['gender', 'personality', 'voice_description', 'physical_appearance', 'clothing', 'expression', 'pose', 'generation_prompt', 'negative_prompt'] as const) {
      if (typeof (s as any)[field] !== 'string' || !(s as any)[field].trim()) return { ok: false, reason: `${s.tag} is missing ${field}.` };
    }
    if (!s.generation_prompt.includes(COMMON_STYLE)) return { ok: false, reason: `${s.tag} prompt does not embed the common style.` };
    if (!/transparent background/i.test(s.generation_prompt) || !/true alpha transparency/i.test(s.generation_prompt)) return { ok: false, reason: `${s.tag} prompt does not demand a transparent alpha background.` };
    // The prompt must explicitly FORBID a model sheet / studio background (the 8DV failure shape).
    if (!/no model sheet/i.test(s.generation_prompt) || !/no studio or coloured background/i.test(s.generation_prompt)) return { ok: false, reason: `${s.tag} prompt does not explicitly forbid model sheets and studio backgrounds.` };
    if (/https?:\/\/|flow\.google|flow-content/i.test(s.generation_prompt)) return { ok: false, reason: `${s.tag} prompt references a Flow URL.` };
    const c = s.required_output_contract;
    if (c.format !== 'png' || c.transparency !== 'required' || c.pixelAlpha !== 'required') return { ok: false, reason: `${s.tag} output contract must require PNG + transparency + pixel alpha.` };
    if (c.minWidth < 1024 || c.minHeight < 1024) return { ok: false, reason: `${s.tag} output contract minimum is below 1024×1024.` };
    if (c.aspect !== 'square-ish') return { ok: false, reason: `${s.tag} output contract must require a square-ish canvas.` };
    if (!SHARED_NEGATIVE_PROMPT.split(', ').every((n) => s.negative_prompt.includes(n))) return { ok: false, reason: `${s.tag} negative prompt is missing shared exclusions.` };
  }
  return { ok: true };
}

/** Deterministic generation plan (prompts + target filenames + size + transparency). */
export function characterGenerationPlan(size = '1024x1024'): Array<{ tag: string; name: string; filename: string; size: string; transparentBackground: true; promptValid: boolean; negativePromptValid: boolean }> {
  const v = validateCharacterSpecs();
  return CHARACTER_GENERATION_SPECS.map((s) => ({
    tag: s.tag,
    name: s.name,
    filename: canonicalCharacterFilename(s.tag) as string,
    size,
    transparentBackground: true as const,
    promptValid: v.ok && s.generation_prompt.trim().length > 0,
    negativePromptValid: v.ok && s.negative_prompt.trim().length > 0,
  }));
}

export const SUPPORTED_GENERATION_FORMATS = SUPPORTED_CHARACTER_EXTENSIONS;
