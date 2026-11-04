/**
 * PROJECT asset-surface identity decisions (PURE) — the project composer's Add-Ingredients picker.
 *
 * WHY (live-proven)
 * -----------------
 * The project picker exposes a dedicated `Characters` category and background identities, so the
 * first-clip ASSET_LOCKS gate can be satisfied entirely from the PROJECT route — no scene
 * navigation, no arbitrary scene, no credit.
 *
 * Two live findings drive the design:
 *   1. Clicking the `Characters` tab did NOT flip `aria-selected` / `mdc-list-item--activated`, so
 *      the tab's CSS/ARIA state is UNRELIABLE. Activation is therefore proven by the RENDERED ROW
 *      SET instead: the dedicated character list contains only `@CHAR-*` asset titles, whereas the
 *      mixed default list contains media titles too.
 *   2. The project GRID is virtualised — a non-scrolling grid read observed only 1 of the 7
 *      required `#BGD-*` tiles. The grid is therefore NOT the authoritative background pool;
 *      background identities are read from the picker surface instead.
 *
 * IDENTITY RULES (unchanged strictness)
 * -------------------------------------
 *   · the canonical identity is the EXACT `span.asset-title` text (`@CHAR-*` / `#BGD-*`);
 *   · the `/asb/` image token is transient and is never read, returned or matched;
 *   · unrelated titles are ignored, never mistaken for an identity;
 *   · no unbounded scrolling; every read is a single bounded render;
 *   · nothing is ever selected, attached, generated or navigated.
 */
import {
  decideProjectCharactersCategory,
  parseProjectCharacterIdentities,
  PROJECT_ASSET_CATEGORY,
  type ProjectCategoryDecision,
} from './firstClipGeneration.js';

export { PROJECT_ASSET_CATEGORY };

export type ProjectCategoryVerification =
  | 'VERIFIED_CHARACTER_CATEGORY'
  | 'NOT_VERIFIED'
  | 'EMPTY'
  | 'AMBIGUOUS';

/** Canonical character identity: the exact `@CHAR-*` asset-title text. */
export const PROJECT_CHARACTER_TAG_PATTERN = /^@CHAR-.+/;
/** Canonical background identity: the exact `#BGD-*` asset-title text. */
export const PROJECT_BACKGROUND_TAG_PATTERN = /^#BGD-.+/;
/** The dedicated background category on the project picker. */
export const PROJECT_BACKGROUND_CATEGORY = 'Images';

const normalizeTitles = (rows: readonly unknown[] | null | undefined): string[] =>
  (Array.isArray(rows) ? rows : []).map((r) => String(r ?? '').trim()).filter(Boolean);

/**
 * PURE: prove the dedicated Characters category is ACTIVE **by the rendered row set**, never by
 * the tab's CSS/ARIA state.
 *
 *   · every rendered row is an exact `@CHAR-*` tag -> VERIFIED_CHARACTER_CATEGORY
 *   · no rows rendered -> EMPTY
 *   · some `@CHAR-*` and some non-character rows -> AMBIGUOUS (not provably character-only)
 *   · rows but none are `@CHAR-*` (still the mixed list) -> NOT_VERIFIED
 */
export function decideProjectCharactersCategoryFromRows(input: {
  afterRows?: readonly unknown[] | null;
} | undefined | null): { result: ProjectCategoryVerification; characters: string[]; reason: string } {
  const rows = normalizeTitles(input?.afterRows);
  if (rows.length === 0) {
    return { result: 'EMPTY', characters: [], reason: 'the category rendered zero asset rows; character identities cannot be proven.' };
  }
  const chars = rows.filter((t) => PROJECT_CHARACTER_TAG_PATTERN.test(t));
  const others = rows.filter((t) => !PROJECT_CHARACTER_TAG_PATTERN.test(t));
  if (chars.length === 0) {
    return { result: 'NOT_VERIFIED', characters: [], reason: `no rendered row carried an exact "@CHAR-" identity (saw ${rows.length} row(s), e.g. ${JSON.stringify(rows[0])}); the dedicated Characters list is not proven active.` };
  }
  if (others.length > 0) {
    return { result: 'AMBIGUOUS', characters: [], reason: `${chars.length} character row(s) mixed with ${others.length} non-character row(s) (e.g. ${JSON.stringify(others[0])}); the row set cannot be established as character-only.` };
  }
  return { result: 'VERIFIED_CHARACTER_CATEGORY', characters: [...new Set(chars)], reason: `all ${rows.length} rendered rows are exact "@CHAR-" identities.` };
}

export type ProjectBackgroundParseCode = 'PROJECT_BACKGROUND_ROWS_EMPTY' | 'PROJECT_BACKGROUND_TAGS_MALFORMED';

/**
 * PURE: build the background identity set from picker row titles.
 *
 * Canonical identity = exact `#BGD-*` asset-title text. Unrelated titles are ignored; an empty
 * result fails closed so the verifier can name exactly which required identity is unproven.
 */
export function parseProjectBackgroundIdentities(input: {
  rowTitles?: readonly unknown[] | null;
} | undefined | null): { ok: true; backgrounds: string[]; ignored: string[] } | { ok: false; code: ProjectBackgroundParseCode; reason: string } {
  const rows = normalizeTitles(input?.rowTitles);
  const backgrounds = [...new Set(rows.filter((t) => PROJECT_BACKGROUND_TAG_PATTERN.test(t)))];
  const ignored = rows.filter((t) => !PROJECT_BACKGROUND_TAG_PATTERN.test(t));
  if (backgrounds.length === 0) {
    return {
      ok: false,
      code: rows.length === 0 ? 'PROJECT_BACKGROUND_ROWS_EMPTY' : 'PROJECT_BACKGROUND_TAGS_MALFORMED',
      reason: rows.length === 0
        ? 'the project picker category rendered zero asset rows; #BGD-* identities cannot be proven.'
        : `the project picker rendered ${rows.length} row(s) but none carried an exact "#BGD-" identity.`,
    };
  }
  return { ok: true, backgrounds, ignored };
}

/**
 * PURE: choose which picker category the background identities may be read from.
 *
 * The dedicated `Images` category is preferred, but only when its rendered rows prove it. The
 * default category is acceptable ONLY when exact `#BGD-*` identities are observable there — the
 * live-proven behaviour of the mixed list. No permissive fallback is introduced.
 */
export function decideProjectBackgroundSource(input: {
  imagesRows?: readonly unknown[] | null;
  allRows?: readonly unknown[] | null;
} | undefined | null): { source: 'IMAGES_CATEGORY' | 'ALL_CATEGORY'; usable: boolean; reason: string } {
  const fromImages = parseProjectBackgroundIdentities({ rowTitles: input?.imagesRows });
  if (fromImages.ok) return { source: 'IMAGES_CATEGORY', usable: true, reason: `the dedicated Images category yielded ${fromImages.backgrounds.length} exact #BGD-* identity/identities.` };
  const fromAll = parseProjectBackgroundIdentities({ rowTitles: input?.allRows });
  if (fromAll.ok) return { source: 'ALL_CATEGORY', usable: true, reason: `the default category yielded ${fromAll.backgrounds.length} exact #BGD-* identity/identities.` };
  return { source: 'ALL_CATEGORY', usable: false, reason: `no category yielded an exact #BGD-* identity (images: ${fromImages.reason}; all: ${fromAll.reason})` };
}

export { decideProjectCharactersCategory, parseProjectCharacterIdentities };
export type { ProjectCategoryDecision };