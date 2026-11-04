/**
 * PROJECT picker category-label normalisation (PURE).
 *
 * WHY (live-proven)
 * -----------------
 * The project Add-Ingredients picker renders each category as a Material list item whose `innerText`
 * carries the icon LIGATURE TEXT before the human label. The exact live strings were:
 *
 *     "dashboard All"                    -> "All"
 *     "image Images"                     -> "Images"
 *     "videocam Videos"                  -> "Videos"
 *     "voice_selection Voices"           -> "Voices"
 *     "accessibility_new Characters"     -> "Characters"
 *     "face Avatars"                     -> "Avatars"
 *     "drive_folder_upload Uploads"      -> "Uploads"
 *
 * A locator that searches raw `innerText` for `(^|\s)Characters(\s|$)` therefore MISSES the tab
 * (live failure: the reader returned `PROJECT_CATEGORY_NOT_FOUND` and never clicked).
 *
 * SCOPE AND SAFETY
 * ----------------
 *   · the ligature set is NOT hard-coded to `Characters`; any leading snake_case/lowercase ligature
 *     token is stripped, so all seven live categories normalise correctly;
 *   · normalisation NEVER invents a label: an icon-only item normalises to the empty string and is
 *     rejected downstream, because a category with no human label cannot be matched exactly;
 *   · matching stays DETERMINISTIC — exact equality on the normalised label, never substring,
 *     never a fuzzy match, never an index assumption;
 *   · zero matches and duplicate matches both fail closed rather than picking one.
 */

/**
 * Material icon ligature tokens, as observed live on the project picker.
 *
 * Kept explicit so behaviour is auditable rather than pattern-guessed, but the normaliser also
 * accepts any other leading snake_case ligature token (see `LIGATURE_PREFIX`), so an icon this
 * build does not know about still normalises correctly.
 */
export const PROJECT_CATEGORY_LIGATURES = [
  'dashboard',
  'image',
  'videocam',
  'voice_selection',
  'accessibility_new',
  'face',
  'drive_folder_upload',
] as const;

/** A standalone leading Material ligature token: lowercase word, optionally snake_cased. */
const LIGATURE_TOKEN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
/**
 * A GLUED leading ligature, e.g. `accessibility_newCharacters`. This is the shape an element's
 * `textContent` takes when the icon element and the label element are adjacent siblings with no
 * whitespace text node between them — the live form that broke the raw `hasText` regex.
 */
const GLUED_LIGATURE = new RegExp(`^(?:${PROJECT_CATEGORY_LIGATURES.join('|')})(?=[A-Z])`);

const collapseWhitespace = (t: string): string => t.replace(/\s+/g, ' ').trim();

/**
 * PURE: reduce a raw category text (ligature + human label) to its human-readable label.
 *
 *   "accessibility_new Characters"  -> "Characters"   (space-separated innerText form)
 *   "accessibility_newCharacters"   -> "Characters"   (glued textContent form)
 *   "  dashboard   All  "           -> "All"
 *   "accessibility_new"             -> ""   (icon only: no label to match)
 *   "Characters"                    -> "Characters"   (already normalised)
 *   "My Custom Category"            -> "My Custom Category" (never invented, never guessed)
 */
export function normalizeProjectAssetCategoryLabel(text: unknown): string {
  const raw = typeof text === 'string' ? text : text === null || text === undefined ? '' : String(text);
  const collapsed = collapseWhitespace(raw);
  if (!collapsed) return '';

  // 1. Glued ligature: strip the known ligature immediately before an uppercase letter.
  if (GLUED_LIGATURE.test(collapsed)) return collapsed.replace(GLUED_LIGATURE, '').trim();

  // 2. Space-separated form: drop a leading standalone ligature token.
  const tokens = collapsed.split(' ');
  if (tokens.length < 2) {
    // A single standalone ligature token is an icon with NO human label.
    return LIGATURE_TOKEN.test(tokens[0]) ? '' : collapsed;
  }
  if (!LIGATURE_TOKEN.test(tokens[0])) return collapsed;
  return tokens.slice(1).join(' ').trim();
}

/** Is this raw text a category item with NO human-readable label (icon only)? */
export const isIconOnlyProjectCategoryLabel = (text: unknown): boolean =>
  normalizeProjectAssetCategoryLabel(text) === '';

export type ProjectCategoryLookupCode =
  | 'PROJECT_CATEGORY_LABEL_MISSING'
  | 'PROJECT_CATEGORY_LABEL_EMPTY'
  | 'PROJECT_CATEGORY_LABEL_NOT_FOUND'
  | 'PROJECT_CATEGORY_LABEL_AMBIGUOUS';

export type ProjectCategoryLookup =
  | { ok: true; label: string; index: number; matches: number }
  | { ok: false; code: ProjectCategoryLookupCode; reason: string; available: string[] };

/**
 * PURE: find the ONE category whose normalised label equals `wanted`, exactly.
 *
 * Matching rules (unchanged strictness):
 *   · exact equality on the normalised label — no substring, no prefix, no `includes`;
 *   · NO index assumption — the index is derived from the observed order and reported back;
 *   · zero matches  -> `PROJECT_CATEGORY_LABEL_NOT_FOUND`      (fail closed)
 *   · two or more    -> `PROJECT_CATEGORY_LABEL_AMBIGUOUS`      (fail closed, never pick one)
 *   · an empty/absent observation -> `PROJECT_CATEGORY_LABEL_EMPTY` (fail closed)
 *
 * An empty `wanted` label is never matched, so a missing target can never resolve by accident.
 */
export function findProjectAssetCategory(input: {
  labels?: readonly unknown[] | null;
  wanted?: unknown;
} | undefined | null): ProjectCategoryLookup {
  const wanted = normalizeProjectAssetCategoryLabel(input?.wanted);
  const rawLabels = Array.isArray(input?.labels) ? input.labels : [];
  if (rawLabels.length === 0) {
    return { ok: false, code: 'PROJECT_CATEGORY_LABEL_EMPTY', reason: 'no category label was observed, so the requested category cannot be resolved.', available: [] };
  }
  if (!wanted) {
    return { ok: false, code: 'PROJECT_CATEGORY_LABEL_MISSING', reason: 'the requested category label is empty after normalisation; an empty label is never matched.', available: [] };
  }
  const normalized = rawLabels.map((l) => normalizeProjectAssetCategoryLabel(l));
  const hits: number[] = [];
  normalized.forEach((label, i) => { if (label === wanted) hits.push(i); });
  const available = [...new Set(normalized.filter(Boolean))];
  if (hits.length === 0) {
    return { ok: false, code: 'PROJECT_CATEGORY_LABEL_NOT_FOUND', reason: `no category normalised to exactly "${wanted}" (observed: ${available.length ? available.map((a) => JSON.stringify(a)).join(', ') : 'none'}); substring matching is not permitted.`, available };
  }
  if (hits.length > 1) {
    return { ok: false, code: 'PROJECT_CATEGORY_LABEL_AMBIGUOUS', reason: `${hits.length} categories normalised to exactly "${wanted}" (indices ${hits.join(', ')}); an ambiguous category is never chosen.`, available };
  }
  return { ok: true, label: wanted, index: hits[0], matches: hits.length };
}
