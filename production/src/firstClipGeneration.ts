/**
 * FIRST-CLIP generation decision model (PURE) — the PROJECT-COMPOSER path.
 *
 * WHY THIS MODULE EXISTS (live-proven)
 * ------------------------------------
 * A fresh/clipless Flow scene CANNOT produce its own first clip:
 *   · its scene-local composer is `contenteditable="false"` with placeholder "Select a clip to edit",
 *     and its generate button is disabled;
 *   · a populated scene is `contenteditable="true"` with placeholder "Describe how to edit this video…".
 * Flow only enables the scene-local prompt editor AFTER a clip is committed, so the previous
 * SCENE_CREATE → SCENE_OPEN → ATTACH_ASSETS → GENERATE ordering was structurally unsatisfiable.
 *
 * A project-level generation, by contrast, was live-proven to CREATE a new populated scene that
 * already carries the generated clip:
 *   project composer (editable `.ProseMirror[contenteditable="true"]`,
 *   Video / Omni 1.1 Flash / 720p / 8s / 16:9 / x1) → Start generation
 *   → new populated scene + `/video/<UUID>` first clip, with NO attachment step.
 *
 * This module therefore models FIRST-CLIP creation separately from the scene-local
 * edit/extend model. It never requires a scene-local prompt editor for a first clip, and it never
 * attaches the generated clip through the Add Clip picker (the live evidence proves first-clip
 * creation is automatic).
 *
 * FAIL-CLOSED CONTRACT (identical in spirit to `assetVerification.ts`)
 * ------------------------------------------------------------------
 *   · Zero eligible project prompt editors → refuse.
 *   · MORE THAN ONE eligible editor       → refuse (ambiguous).
 *   · Prompt text must match exactly.
 *   · Exactly one Start-generation click per attempt; the click count is part of the decision.
 *   · Generation, video and scene identities are THREE DISTINCT things and are never conflated.
 *   · Scene identification requires the exact `/video/<UUID>` to be observed; a total grid tile
 *     count is NEVER evidence that a scene was (or was not) created, because the project grid is
 *     virtualised/re-rendered.
 *   · Nothing here generates, clicks, mutates Flow or spends credits. It is decision logic only.
 */
import {
  isEligiblePromptEditor,
  normalizeFlowMediaUuid,
  type PromptEditorCandidate,
} from './sceneLocalGeneration.js';

/** Which architectural path produces/uses a clip. */
export type FirstClipMode = 'FIRST_CLIP_PROJECT_GENERATION' | 'SCENE_CLIP_EDIT_OR_EXTENSION';

/** The only surface proven able to create a scene's FIRST clip. */
export const FIRST_CLIP_SOURCE = 'PROJECT_COMPOSER' as const;
export type FirstClipSource = typeof FIRST_CLIP_SOURCE;

/**
 * PURE: which path applies?
 *
 * `FIRST_CLIP_PROJECT_GENERATION` is the default and is NOT conditioned on any scene-local prompt
 * editor — such an editor does not exist before a clip is committed, so requiring it would make
 * first-clip creation unsatisfiable. The scene-local model is chosen ONLY when a committed clip is
 * positively proven, which is the one precondition the scene-local editor genuinely has.
 */
export function classifyFirstClipMode(input: {
  committedClipPresent?: unknown;
} | undefined | null): { mode: FirstClipMode; reason: string } {
  if (input?.committedClipPresent === true) {
    return { mode: 'SCENE_CLIP_EDIT_OR_EXTENSION', reason: 'an existing committed clip is proven, so the scene-local edit/extend path is valid.' };
  }
  return { mode: 'FIRST_CLIP_PROJECT_GENERATION', reason: 'no committed clip is proven; first-clip creation must use the project composer, which Flow initialises for a fresh scene.' };
}

// ---------------------------------------------------------------------------------------
// Project prompt editor (scoped, editable, deterministic, fail-closed on ambiguity)
// ---------------------------------------------------------------------------------------

/** The proven project composer control. Scoped to `flow-prompt-box`, never the global surface. */
export const PROJECT_PROMPT_CONTROLS = {
  projectRoute: 'flow-project-page',
  projectPromptBox: 'flow-prompt-box',
  promptEditor: "flow-prompt-box .ProseMirror[contenteditable='true']",
  allProseMirror: 'flow-prompt-box .ProseMirror',
  startGenerationButton: "flow-prompt-box flow-generate-icon-button button[aria-label='Start generation']",
} as const;

/**
 * The NESTED form of {@link PROJECT_PROMPT_CONTROLS.allProseMirror}.
 *
 * Used when the locator has ALREADY been scoped to `flow-prompt-box`, i.e. `box.locator(...)`.
 * Passing the page-level `flow-prompt-box .ProseMirror` to an already-scoped locator produces the
 * effective selector `flow-prompt-box flow-prompt-box .ProseMirror`, which requires an editor
 * nested inside a SECOND prompt box and therefore matches nothing.
 */
export const PROJECT_PROMPT_NESTED_PROSE_MIRROR = '.ProseMirror';

export interface NestedProjectPromptEditorSelectorResolution {
  ok: true;
  /** The selector to hand to an ALREADY-SCOPED `projectPromptBox` locator. */
  nestedSelector: string;
  /** The page-level selector the nested form was derived from. */
  pageLevelSelector: string;
  /**
   * What the buggy chain would have produced. Recorded so tests can assert it is NEVER used.
   * LIVE-PROVEN failure: this exact string matched zero elements while the real editor was present.
   */
  forbiddenDoubleScopedSelector: string;
  /** Whether the supplied candidate repeated the host qualifier and had to be stripped. */
  strippedHostQualifier: boolean;
}

/**
 * PURE: derive the selector for the project prompt editor given an ALREADY-SCOPED prompt box.
 *
 * This exists because the double-scoping defect was invisible to the pure decision tests: those
 * only exercise `resolveProjectPromptEditor()` with synthetic candidates, so a broken selector
 * STRING cannot fail them. The construction itself is now derived and testable.
 *
 * Fails closed if stripping the host qualifier would leave nothing to match.
 */
export function resolveNestedProjectPromptEditorSelector(
  input?: { hostSelector?: string; candidate?: string },
): NestedProjectPromptEditorSelectorResolution | { ok: false; code: 'NESTED_SELECTOR_EMPTY'; reason: string } {
  const host = String(input?.hostSelector ?? PROJECT_PROMPT_CONTROLS.projectPromptBox).trim();
  const pageLevelSelector = String(input?.candidate ?? PROJECT_PROMPT_CONTROLS.allProseMirror).trim();
  if (!host) return { ok: false, code: 'NESTED_SELECTOR_EMPTY', reason: 'the host selector is empty, so a nested selector cannot be derived.' };
  if (!pageLevelSelector) return { ok: false, code: 'NESTED_SELECTOR_EMPTY', reason: 'the page-level selector is empty, so a nested selector cannot be derived.' };

  // The candidate may legitimately arrive either page-scoped (default) or already nested.
  const strippedHostQualifier = pageLevelSelector === host || pageLevelSelector.startsWith(`${host} `);
  const nestedSelector = strippedHostQualifier
    ? pageLevelSelector.slice(host.length).trim()
    : pageLevelSelector;

  if (!nestedSelector) {
    return { ok: false, code: 'NESTED_SELECTOR_EMPTY', reason: `stripping the host qualifier "${host}" from "${pageLevelSelector}" left no selector, so the nested lookup would match everything or nothing.` };
  }
  return {
    ok: true,
    nestedSelector,
    pageLevelSelector,
    forbiddenDoubleScopedSelector: `${host} ${pageLevelSelector}`,
    strippedHostQualifier,
  };
}

export type ProjectPromptEditorCode =
  | 'PROJECT_PROMPT_EDITOR_NOT_FOUND'
  | 'PROJECT_PROMPT_EDITOR_NOT_EDITABLE'
  | 'PROJECT_PROMPT_EDITOR_AMBIGUOUS';

export interface ProjectPromptEditorResolution {
  ok: boolean;
  code?: ProjectPromptEditorCode;
  reason?: string;
  /** DOM index of the single eligible editor. Present only when `ok`. */
  index?: number;
  eligibleCount?: number;
  totalCandidates?: number;
}

/**
 * PURE: resolve THE project prompt editor, refusing on zero AND on multiple eligible candidates.
 *
 * Eligibility is delegated to the EXISTING proven `isEligiblePromptEditor()` (exists ∧ visible ∧
 * `contenteditable="true"` ∧ ¬aria-readonly ∧ ¬disabled), so this path cannot drift from the
 * scene-local resolver. The additional rule here is AMBIGUITY: more than one eligible project
 * editor is refused rather than silently taking the first.
 */
export function resolveProjectPromptEditor(
  candidates: readonly PromptEditorCandidate[] | null | undefined,
): ProjectPromptEditorResolution {
  const all = Array.isArray(candidates) ? candidates.filter((c): c is PromptEditorCandidate => !!c) : [];
  if (all.length === 0) {
    return { ok: false, code: 'PROJECT_PROMPT_EDITOR_NOT_FOUND', reason: 'no ProseMirror element was found inside the project prompt box.', eligibleCount: 0, totalCandidates: 0 };
  }
  const eligible = all.filter((c) => isEligiblePromptEditor(c));
  if (eligible.length === 0) {
    const observed = all.map((c) => `#${c.index}{exists=${c.exists === true},visible=${c.visible === true},editable=${c.editable === true},ariaReadonly=${c.ariaReadonly === true},disabled=${c.disabled === true}`).join(' ');
    return {
      ok: false,
      code: 'PROJECT_PROMPT_EDITOR_NOT_EDITABLE',
      reason: `no project prompt editor is a visible, enabled, editable element (contenteditable="true", not aria-readonly, not disabled). Observed: ${observed}`,
      eligibleCount: 0,
      totalCandidates: all.length,
    };
  }
  if (eligible.length > 1) {
    return {
      ok: false,
      code: 'PROJECT_PROMPT_EDITOR_AMBIGUOUS',
      reason: `${eligible.length} eligible project prompt editors were found (indices ${eligible.map((c) => c.index).join(', ')}); refusing to guess which one is the real composer.`,
      eligibleCount: eligible.length,
      totalCandidates: all.length,
    };
  }
  const chosen = eligible.reduce((best, c) => (c.index < best.index ? c : best));
  return { ok: true, index: chosen.index, eligibleCount: eligible.length, totalCandidates: all.length };
}

/** PURE: the fail-closed refusal message for an unresolved project prompt editor. */
export function projectPromptEditorRefusal(resolution: ProjectPromptEditorResolution | null | undefined): string {
  const code = String(resolution?.code ?? 'PROJECT_PROMPT_EDITOR_NOT_EDITABLE');
  const reason = String(resolution?.reason ?? 'no editable project prompt editor could be resolved.');
  return `project first-clip generation refused: ${code} — ${reason}`;
}

/**
 * PURE: exact prompt-fill verification. Whitespace is trimmed at both ends; the remaining text
 * must be byte-identical. A partial or truncated fill is a failure, never a near-match.
 *
 * This verifies a NORMALISED read-back (see {@link renderProjectPromptReadbackFromParagraphs}).
 * It is deliberately NOT lenient: no prefix, substring, length-only or case-insensitive matching.
 */
export function verifyProjectPromptFill(expected: unknown, observed: unknown): { ok: true } | { ok: false; reason: string } {
  const want = String(expected ?? '').trim();
  const got = String(observed ?? '').trim();
  if (!want) return { ok: false, reason: 'the supplied prompt is empty; refusing to generate.' };
  if (!got) return { ok: false, reason: 'the project prompt editor is still empty after the fill.' };
  if (got !== want) {
    return { ok: false, reason: `the project prompt editor does not contain the exact supplied prompt (expected ${want.length} chars, observed ${got.length}).` };
  }
  return { ok: true };
}

/**
 * PURE: build the canonical read-back string from the ProseMirror BLOCK structure.
 *
 * WHY THIS EXISTS (proven live)
 * -----------------------------
 * `generateProjectFirstClip()` fills the real project composer, which is a ProseMirror surface that
 * serialises the supplied prompt into ONE `<p>` PER SOURCE LINE and then reports it back. For the
 * Scene 1 prompt the live DOM showed:
 *
 *     supplied prompt        1532 chars, 28 lines
 *     editor.innerText()     1562 chars   (ProseMirror renders every block boundary as "\n\n")
 *     editor.textContent()   1505 chars   (block separators removed entirely)
 *     <p> child nodes        28, one per source line
 *
 * So NEITHER raw `innerText` NOR raw `textContent` is byte-identical to the supplied multi-line
 * prompt, and the old direct comparison (`supplied === innerText`) failed for ANY multi-line
 * prompt. That is a transport-representation mismatch, not a fill failure.
 *
 * THE MODELLED CONTRACT
 * ---------------------
 * The DOM contract is: one paragraph per source line, paragraph text taken verbatim, and the block
 * sequence re-joined with a SINGLE newline. That reconstruction is exact and lossless — including
 * intentional blank lines, which are simply empty paragraphs — so the subsequent comparison stays
 * byte-identical and fully strict.
 *
 * This deliberately does NOT globally rewrite `\n\n` -> `\n`. That transformation would be lossy:
 * it cannot distinguish a ProseMirror block boundary from an intentional blank line the author
 * actually typed, and would silently accept a truncated or re-flowed fill.
 *
 * A `textContent`-style read-back (all lines concatenated, zero separators) is NOT accepted: the
 * reconstruction below preserves one output line per paragraph, so a concatenated read-back yields
 * one long line and fails, as it must — there is no proven DOM contract for that representation.
 */
export function renderProjectPromptReadbackFromParagraphs(paragraphs: readonly unknown[] | null | undefined): string {
  if (!Array.isArray(paragraphs)) return '';
  return paragraphs.map((p) => String(p ?? '')).join('\n');
}

/**
 * PURE: verify the fill using the ProseMirror block structure instead of a raw text rendering.
 *
 * Strict by construction: the paragraphs are re-joined into the canonical line representation and
 * compared byte-identically to the supplied prompt via {@link verifyProjectPromptFill}. Truncated,
 * reordered, re-worded, re-punctuated, missing-line, extra-line and non-text read-backs all fail.
 */
export function verifyProjectPromptFillFromParagraphs(
  expected: unknown,
  paragraphs: readonly unknown[] | null | undefined,
): { ok: true } | { ok: false; reason: string } {
  const want = String(expected ?? '').trim();
  if (!want) return { ok: false, reason: 'the supplied prompt is empty; refusing to generate.' };
  if (!Array.isArray(paragraphs) || paragraphs.length === 0) {
    return { ok: false, reason: 'the project prompt editor exposed no readable block structure after the fill.' };
  }
  const readBack = renderProjectPromptReadbackFromParagraphs(paragraphs);
  if (!readBack.trim()) {
    return { ok: false, reason: 'the project prompt editor is still empty after the fill.' };
  }
  const verdict = verifyProjectPromptFill(want, readBack);
  if (!verdict.ok) {
    const expectedLines = want.split('\n').length;
    const observedLines = readBack.trim().split('\n').length;
    return {
      ok: false,
      reason: `${verdict.reason} The editor exposed ${observedLines} block(s) for an expected ${expectedLines} line(s); the fill is not an exact reproduction of the supplied prompt.`,
    };
  }
  return { ok: true };
}

/**
 * PURE: may the single Start-generation click happen?
 *
 * The click count is part of the decision: a non-zero count before the click means the budget is
 * already spent and no further click is permitted. This is the credit guard for the project path.
 */
export function decideStartGenerationEligibility(input: {
  editorResolved?: unknown;
  promptVerified?: unknown;
  settingsVerified?: unknown;
  assetLocksVerified?: unknown;
  generationAuthorized?: unknown;
  startButtonPresent?: unknown;
  startButtonDisabled?: unknown;
  startClicksSoFar?: unknown;
}): { ok: true } | { ok: false; reason: string } {
  const required: Array<[string, boolean]> = [
    ['project prompt editor resolved', input?.editorResolved === true],
    ['exact prompt verified', input?.promptVerified === true],
    ['project video settings verified', input?.settingsVerified === true],
    ['asset locks verified', input?.assetLocksVerified === true],
    ['generation authorized', input?.generationAuthorized === true],
    ['Start generation control present', input?.startButtonPresent === true],
    ['Start generation control enabled', input?.startButtonDisabled !== true],
  ];
  const missing = required.filter(([, ok]) => !ok).map(([name]) => name);
  if (missing.length) return { ok: false, reason: `project generation preconditions not satisfied: ${missing.join(', ')}.` };
  const clicks = Number(input?.startClicksSoFar ?? 0);
  if (!Number.isFinite(clicks) || clicks < 0) return { ok: false, reason: 'the Start-generation click count is not a valid number.' };
  if (clicks >= 1) return { ok: false, reason: `the single authorized Start-generation click was already used (clicks=${clicks}); refusing a second click.` };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------
// Identity: generation vs video vs scene are THREE distinct things
// ---------------------------------------------------------------------------------------

/** PURE: classify a Flow media URL by namespace. `/video/` and `/image/` are NOT interchangeable. */
export function flowMediaKind(src: unknown): 'video' | 'image' | null {
  const raw = typeof src === 'string' ? src.trim() : '';
  if (!raw) return null;
  let pathname: string;
  try { pathname = new URL(raw).pathname; } catch { return null; }
  if (/\/video\/[^/]+/i.test(pathname)) return 'video';
  if (/\/image\/[^/]+/i.test(pathname)) return 'image';
  return null;
}

/**
 * PURE: the generated VIDEO uuid, reusing the EXISTING `normalizeFlowMediaUuid()` segment logic.
 * Returns null unless the URL is explicitly a `/video/` URL — an `/image/<same uuid>` URL (which
 * Flow also renders as a thumbnail for the same asset) is deliberately NOT accepted here.
 */
export function normalizeGeneratedVideoUuid(src: unknown): string | null {
  if (flowMediaKind(src) !== 'video') return null;
  return normalizeFlowMediaUuid(src);
}

/** PURE: true only when the generation uuid and the video uuid are the same observed value. */
export function isSameGenerationVideoIdentity(generationUuid: unknown, videoUuid: unknown): boolean {
  const g = String(generationUuid ?? '').trim();
  const v = String(videoUuid ?? '').trim();
  return !!g && g === v;
}

// ---------------------------------------------------------------------------------------
// Structured first-clip result
// ---------------------------------------------------------------------------------------

export type FirstClipCommittedStatus = 'POPULATED' | 'NOT_POPULATED' | 'AMBIGUOUS';

export interface FirstClipGenerationResult {
  /** The uuid reported by the generation surface. NEVER assumed equal to `videoUuid`. */
  generationUuid: string | null;
  /** The `/video/<UUID>` identity of the generated first clip. */
  videoUuid: string | null;
  videoUrl: string | null;
  /** The auto-created Flow scene that carries the first clip. NEVER assumed equal to `videoUuid`. */
  sceneId: string | null;
  sceneTitle: string | null;
  /** Canonical `/project/<id>/scene/<id>` route, only when deterministically derivable. */
  sceneRoute: string | null;
  durationSeconds: number | null;
  audioPresent: boolean | null;
  source: FirstClipSource;
  committed: FirstClipCommittedStatus;
  classification: string;
}

// ---------------------------------------------------------------------------------------
// Canonical project-route resolution (removes the openSceneEditor hidden dependency)
// ---------------------------------------------------------------------------------------

export type CanonicalProjectUrlCode =
  | 'CURRENT_URL_MISSING'
  | 'CURRENT_URL_NOT_A_PROJECT_ROUTE'
  | 'PROJECT_ID_UNRESOLVED'
  | 'PROJECT_ID_UNEXPECTED';

/**
 * PURE: resolve the canonical project URL from the CURRENT page location.
 *
 * WHY (live-proven): the first-clip lifecycle starts directly on `/project/<id>`, but
 * `FlowClient.projectUrl` was only ever assigned by `openSceneEditor()`. Reading it therefore
 * created a hidden dependency on the scene-opener and made the first-clip lifecycle fail closed at
 * PROJECT_SETTINGS. The project route is fully observable in the current location, so it is derived
 * from there — with NO new mutable global state and NO dependency on `openSceneEditor()`.
 *
 * Precedence: an already-valid `knownProjectUrl` is reused; otherwise the current route is used.
 * The project segment MUST be a 36-character UUID. When `expectedProjectId` is supplied it must
 * match exactly, so a foreign project can never be navigated to.
 */
export function deriveCanonicalProjectUrl(input: {
  currentUrl?: unknown;
  knownProjectUrl?: unknown;
  expectedProjectId?: unknown;
} | undefined | null): { ok: true; projectUrl: string; projectId: string; source: 'KNOWN' | 'CURRENT_ROUTE' } | { ok: false; code: CanonicalProjectUrlCode; reason: string } {
  const expected = String(input?.expectedProjectId ?? '').trim();

  const accept = (candidate: unknown, source: 'KNOWN' | 'CURRENT_ROUTE') => {
    const raw = String(candidate ?? '').trim();
    const m = raw.match(/^(https?:\/\/[^/]+(?:\/u\/\d+)?\/project\/([0-9a-f-]{36}))(?:\/.*)?$/i);
    if (!m) return { ok: false as const, code: 'PROJECT_ID_UNRESOLVED' as const, reason: `"${raw}" is not a canonical /project/<uuid> route.` };
    const [, base, projectId] = m;
    if (expected && projectId.toLowerCase() !== expected.toLowerCase()) {
      return { ok: false as const, code: 'PROJECT_ID_UNEXPECTED' as const, reason: `the resolved project id ${projectId} differs from the expected ${expected}.` };
    }
    return { ok: true as const, projectUrl: base, projectId, source };
  };

  const known = String(input?.knownProjectUrl ?? '').trim();
  if (known) {
    const viaKnown = accept(known, 'KNOWN');
    if (viaKnown.ok) return viaKnown;
    // A stale/invalid cached value must never win over the observable route.
  }

  const current = String(input?.currentUrl ?? '').trim();
  if (!current) return { ok: false, code: 'CURRENT_URL_MISSING', reason: 'the current page URL is missing; the canonical project route cannot be resolved.' };
  if (!/^https?:\/\/[^/]+\/project\//i.test(current)) {
    return { ok: false, code: 'CURRENT_URL_NOT_A_PROJECT_ROUTE', reason: `the current URL "${current}" is not a Flow project route.` };
  }
  const viaCurrent = accept(current, 'CURRENT_ROUTE');
  if (!viaCurrent.ok) return viaCurrent;
  return viaCurrent;
}

// ---------------------------------------------------------------------------------------
// FIRST-CLIP asset-surface resolution (NO hidden scene-route bootstrap)
// ---------------------------------------------------------------------------------------

export type FirstClipAssetSurface = 'KNOWN_SCENE_ID' | 'PROJECT_INGREDIENT_SURFACE' | 'UNAVAILABLE';

export type FirstClipAssetSurfaceCode =
  | 'FIRST_CLIP_ASSET_SURFACE_NO_SCENE_ID'
  | 'FIRST_CLIP_ASSET_SURFACE_UNREADABLE';

/**
 * PURE: decide WHICH surface may be used to prove the locked asset identities before the single
 * credit is spent — in this exact order, with no guessing at any step:
 *
 *   1. `KNOWN_SCENE_ID` — a KNOWN canonical scene id exists (e.g. the scene's own persisted
 *      `flow_scene_id`). That is a legitimate, already-recorded identity, not an arbitrary pick.
 *   2. `PROJECT_INGREDIENT_SURFACE` — otherwise the PROJECT composer's own Add-Ingredients picker,
 *      which is live-proven to expose exact `@CHAR-*` row tags (dedicated Characters category) and
 *      `#BGD-*` identities. It never navigates to a scene.
 *   3. `UNAVAILABLE` — neither is available.
 *
 * It deliberately does NOT offer a "pick some scene" branch: the previous implementation called
 * `listSceneIds()` (which reads `/scene/`+`/edit/` anchors that the project route does not expose)
 * and then `openSceneEditor(<first id>)`, i.e. an arbitrary scene. That is removed for good.
 */
export function classifyFirstClipAssetSurface(input: {
  knownSceneId?: unknown;
  projectIngredientSurfaceReadable?: unknown;
} | undefined | null): { surface: FirstClipAssetSurface; reason: string } {
  const known = String(input?.knownSceneId ?? '').trim();
  if (known) return { surface: 'KNOWN_SCENE_ID', reason: `a known canonical scene id (${known}) is available for the rail/picker identity surface.` };
  if (input?.projectIngredientSurfaceReadable === true) {
    return { surface: 'PROJECT_INGREDIENT_SURFACE', reason: 'no known scene id exists; the project composer ingredient surface is readable and exposes exact @CHAR-* and #BGD-* identities.' };
  }
  return { surface: 'UNAVAILABLE', reason: 'no known canonical scene id exists and the project ingredient surface could not be read.' };
}

// ---------------------------------------------------------------------------------------
// Project-composer Characters category (live-proven surface; exact tags are the identity)
// ---------------------------------------------------------------------------------------

/** The dedicated category tab on the PROJECT composer's Add-Ingredients picker. */
export const PROJECT_ASSET_CATEGORY = 'Characters';

export type ProjectCategoryCode =
  | 'PROJECT_CATEGORY_NOT_FOUND'
  | 'PROJECT_CATEGORY_NOT_ACTIVATED'
  | 'PROJECT_CHARACTER_ROWS_EMPTY';

export interface ProjectCategoryDecision {
  ok: boolean;
  code?: ProjectCategoryCode;
  reason?: string;
  label?: string;
}

/**
 * PURE: locate (and confirm the activation of) the dedicated Characters category.
 *
 * The default category is the mixed `All` list, which contains media AND characters; this reader
 * deliberately targets the dedicated `Characters` tab so a character identity is never inferred
 * from a media row. Matches on the visible label with or without the leading Material icon glyph.
 */
export function decideProjectCharactersCategory(input: {
  categories?: readonly { label?: unknown; activated?: unknown }[] | null;
} | undefined | null): ProjectCategoryDecision {
  const cats = Array.isArray(input?.categories) ? input.categories.filter((c): c is { label?: unknown; activated?: unknown } => !!c) : [];
  const normalize = (v: unknown) => String(v ?? '').trim().replace(/^[a-z_0-9]+\s+/i, '').trim();
  const target = normalize(PROJECT_ASSET_CATEGORY).toLowerCase();
  const found = cats.find((c) => normalize(c.label).toLowerCase() === target);
  if (!found) {
    return { ok: false, code: 'PROJECT_CATEGORY_NOT_FOUND', reason: `the project ingredient picker exposes no "${PROJECT_ASSET_CATEGORY}" category (saw: ${cats.map((c) => JSON.stringify(normalize(c.label))).join(', ')}).` };
  }
  if (found.activated !== true) {
    return { ok: false, code: 'PROJECT_CATEGORY_NOT_ACTIVATED', reason: `the "${PROJECT_ASSET_CATEGORY}" category was found but did not report as activated after clicking it.` };
  }
  return { ok: true, label: normalize(found.label) };
}

export type ProjectCharacterCode = 'PROJECT_CHARACTER_ROWS_EMPTY' | 'PROJECT_CHARACTER_TAG_MALFORMED';

/**
 * PURE: build the character identity set from the Characters-category row titles.
 *
 * IDENTITY RULE: the canonical identity is the exact `@CHAR-*` tag text. The per-row `/asb/` image
 * token is a SESSION/transient identity and is deliberately never read, returned or matched here.
 *
 * Non-character rows are ignored (they are not characters and must never be mistaken for one);
 * an empty result fails closed rather than degrading to the mixed `All` category.
 */
export function parseProjectCharacterIdentities(input: {
  rowTitles?: readonly unknown[] | null;
} | undefined | null): { ok: true; characters: string[]; ignored: string[] } | { ok: false; code: ProjectCharacterCode; reason: string } {
  const raw = Array.isArray(input?.rowTitles) ? input.rowTitles : [];
  const seen = new Set<string>();
  const ignored: string[] = [];
  let malformed = 0;
  for (const t of raw) {
    const title = String(t ?? '').trim();
    if (!title) { malformed++; continue; }
    if (!title.startsWith('@')) { ignored.push(title); continue; }
    // A character tag must be "@CHAR-<something>"; anything else is not a character identity.
    if (!/^@CHAR-.+/.test(title)) { malformed++; continue; }
    seen.add(title);
  }
  if (seen.size === 0) {
    return {
      ok: false,
      code: raw.length === 0 ? 'PROJECT_CHARACTER_ROWS_EMPTY' : 'PROJECT_CHARACTER_TAG_MALFORMED',
      reason: raw.length === 0
        ? 'the project Characters category rendered zero rows; character identities cannot be proven.'
        : `the project Characters category rendered ${raw.length} row(s) but none carried a valid "@CHAR-" tag.`,
    };
  }
  return { ok: true, characters: [...seen], ignored };
}

export type FirstClipAssetIdentityCode =
  | 'FIRST_CLIP_ASSET_CHARACTER_SURFACE_UNAVAILABLE'
  | 'FIRST_CLIP_ASSET_BACKGROUND_MISSING'
  | 'FIRST_CLIP_ASSET_CHARACTER_MISSING'
  | 'FIRST_CLIP_ASSET_IDENTITY_AMBIGUOUS';

/**
 * PURE: prove the required locked identities from whatever identities were OBSERVED, and name
 * exactly what could not be proven.
 *
 * The gate is never broadened to make a run pass. `projectBackgroundIdentities` are the exact
 * `#BGD-*` picker row titles read from the PROJECT ingredient surface; `projectCharacterIdentities`
 * are the exact `@CHAR-*` titles from the project's dedicated Characters category;
 * `sceneIdentities` are the rail tags + picker titles readable only on a scene surface.
 *
 * `projectGridIdentities` is retained only as a legacy input for the pre-existing surface readers.
 * The project GRID is VIRTUALISED (live-proven: a bounded read saw only 1 of 7 required `#BGD-*`
 * tiles) and is NOT an authoritative complete background pool, so the first-clip lifecycle no
 * longer supplies it. Identities from the distinct surfaces are never conflated: a surface that
 * cannot see characters says so, rather than substituting something else.
 */
export function verifyFirstClipAssetIdentities(input: {
  requiredCharacters?: readonly unknown[] | null;
  requiredBackgrounds?: readonly unknown[] | null;
  projectGridIdentities?: readonly string[] | null;
  /** Exact `#BGD-*` identities read from the PROJECT ingredient surface. */
  projectBackgroundIdentities?: readonly string[] | null;
  /** Exact `@CHAR-*` identities read from the PROJECT composer's dedicated Characters category. */
  projectCharacterIdentities?: readonly string[] | null;
  sceneIdentities?: { characters?: readonly string[] | null; backgrounds?: readonly string[] | null } | null;
}): { ok: true; characters: string[]; backgrounds: string[] } | { ok: false; code: FirstClipAssetIdentityCode; reason: string } {
  const reqC = (input?.requiredCharacters ?? []).map((t) => String(t ?? '').trim()).filter(Boolean);
  const reqB = (input?.requiredBackgrounds ?? []).map((t) => String(t ?? '').trim()).filter(Boolean);
  const scene = input?.sceneIdentities ?? null;
  const grid = (input?.projectGridIdentities ?? []).map((t) => String(t ?? '').trim()).filter(Boolean);

  const match = (kind: 'character' | 'background', tag: string, pool: readonly string[]): 'ok' | 'missing' | 'ambiguous' => {
    const strip = (n: string) => (kind === 'character' ? n.replace(/^@/, '') : n.replace(/^#/, ''));
    const key = strip(tag);
    // The SAME identity observed on two surfaces (e.g. project grid AND scene rail) is ONE asset,
    // so the pool is de-duplicated before counting. Ambiguity means two DISTINCT observed
    // identities that canonicalise to the same tag.
    const hits = [...new Set(pool.map(strip))].filter((n) => n === key);
    if (hits.length === 1) return 'ok';
    if (hits.length > 1) return 'ambiguous';
    return 'missing';
  };

  // Backgrounds: proven readable from the project ingredient surface / project grid tile labels
  // and from a known scene rail. Both pools are legitimate for a `#BGD-*` identity.
  const bPool = [...(scene?.backgrounds ?? []), ...grid, ...((input?.projectBackgroundIdentities as readonly string[] | null) ?? [])];
  const verifiedB: string[] = [];
  for (const tag of reqB) {
    const verdict = match('background', tag, bPool);
    if (verdict === 'ambiguous') return { ok: false, code: 'FIRST_CLIP_ASSET_IDENTITY_AMBIGUOUS', reason: `the background tag ${tag} matched multiple observed asset identities.` };
    if (verdict === 'missing') return { ok: false, code: 'FIRST_CLIP_ASSET_BACKGROUND_MISSING', reason: `the required background ${tag} was not observable on any available asset surface.` };
    verifiedB.push(tag);
  }

  // Characters: proven readable from the PROJECT composer's dedicated Characters category
  // (`@CHAR-*` row tags) and from a known scene surface (Characters picker titles). Either is a
  // legitimate authoritative source; neither borrows a background or media identity.
  const cPool = [...(scene?.characters ?? []), ...((input?.projectCharacterIdentities as readonly string[] | null) ?? [])];
  if (cPool.length === 0) {
    return {
      ok: false,
      code: 'FIRST_CLIP_ASSET_CHARACTER_SURFACE_UNAVAILABLE',
      reason: `the ${reqC.length} required character identity/identities ${reqC.join(', ')} could not be proven: neither a known scene surface nor the project composer's dedicated Characters category yielded any @CHAR-* identity.`,
    };
  }
  const verifiedC: string[] = [];
  for (const tag of reqC) {
    const verdict = match('character', tag, cPool);
    if (verdict === 'ambiguous') return { ok: false, code: 'FIRST_CLIP_ASSET_IDENTITY_AMBIGUOUS', reason: `the character tag ${tag} matched multiple observed identities.` };
    if (verdict === 'missing') return { ok: false, code: 'FIRST_CLIP_ASSET_CHARACTER_MISSING', reason: `the required character ${tag} was not observable on any available character surface.` };
    verifiedC.push(tag);
  }
  return { ok: true, characters: verifiedC, backgrounds: verifiedB };
}

// ---------------------------------------------------------------------------------------
// Project-route restoration (ASSET_LOCKS navigates to a scene to read the rail)
// ---------------------------------------------------------------------------------------

export type ProjectRouteRestorationCode = 'PROJECT_ROUTE_RESTORE_FAILED' | 'PROJECT_SURFACE_NOT_OBSERVED';

/**
 * PURE: did the canonical project route actually come back, with its composer mounted?
 *
 * `readFlowAssetIdentitiesForFirstClip()` navigates to a scene to read the navigation rail, which
 * leaves the project route. The project composer is ONLY on the project route, so generation must
 * re-establish it explicitly — this is a real transition, never an implicit assumption.
 */
export function verifyProjectRouteRestoration(input: {
  projectUrl?: unknown;
  restoredUrl?: unknown;
  projectSurfaceObserved?: unknown;
} | undefined | null): { ok: true } | { ok: false; code: ProjectRouteRestorationCode; reason: string } {
  const expected = String(input?.projectUrl ?? '').trim().replace(/\/+$/, '');
  const restoredUrl = String(input?.restoredUrl ?? '').trim();
  if (!restoredUrl) return { ok: false, code: 'PROJECT_ROUTE_RESTORE_FAILED', reason: 'restoring the project route produced no URL.' };
  if (!expected) return { ok: false, code: 'PROJECT_ROUTE_RESTORE_FAILED', reason: 'no canonical project URL is known to restore.' };

  // The project route is parsed in exactly ONE place (`deriveCanonicalProjectUrl`); this check
  // reuses it rather than duplicating the `/project/<uuid>` matcher.
  const resolved = deriveCanonicalProjectUrl({ currentUrl: restoredUrl });
  if (!resolved.ok) {
    return { ok: false, code: 'PROJECT_ROUTE_RESTORE_FAILED', reason: `the restored URL ${JSON.stringify(restoredUrl)} is not the canonical project route: ${resolved.reason}` };
  }
  // The restored location must BE the project root, not a scene/tool sub-route.
  if (restoredUrl.replace(/\/+$/, '') !== resolved.projectUrl.replace(/\/+$/, '')) {
    return { ok: false, code: 'PROJECT_ROUTE_RESTORE_FAILED', reason: `the restored URL ${JSON.stringify(restoredUrl)} is not the project root route.` };
  }
  if (resolved.projectUrl.replace(/\/+$/, '').toLowerCase() !== expected.toLowerCase()) {
    return { ok: false, code: 'PROJECT_ROUTE_RESTORE_FAILED', reason: `the restored URL ${JSON.stringify(restoredUrl)} does not match the canonical project URL ${JSON.stringify(expected)}.` };
  }
  if (input?.projectSurfaceObserved !== true) {
    return { ok: false, code: 'PROJECT_SURFACE_NOT_OBSERVED', reason: 'the project composer surface was not observable after restoring the project route.' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------
// Scene identification (deterministic, fail-closed, tile-count independent)
// ---------------------------------------------------------------------------------------

export interface FirstClipSceneCandidate {
  sceneId?: unknown;
  title?: unknown;
  /** The `/video/<UUID>` observed for this scene. */
  videoUuid?: unknown;
  route?: unknown;
}

export type FirstClipSceneCode =
  | 'FIRST_CLIP_VIDEO_UUID_UNRESOLVED'
  | 'FIRST_CLIP_SCENE_NOT_IDENTIFIED'
  | 'FIRST_CLIP_SCENE_AMBIGUOUS'
  | 'FIRST_CLIP_SCENE_ID_MISSING'
  | 'SCENE_ID_UNRESOLVED';

/**
 * PURE: which scene-resolution strategy applies?
 *
 * Live evidence that shapes this decision:
 *   · project grid tiles expose NO usable `<a href>`, so a scene id is NOT click-free observable
 *     from a tile;
 *   · the grid is virtualised/re-rendered, so tile counts prove nothing;
 *   · the generated `/video/<UUID>` IS authoritative, and the generated scene title is observable.
 *
 * So the ONLY two legitimate strategies are: resolve a scene id directly from a candidate that
 * already carries both the exact video uuid and a scene id, or fall back to the EXISTING proven
 * exact-title scene opener (which is how canonical `/scene/<id>` routes were already obtained) and
 * then verify the opened scene really carries the generated video uuid. Neither path may guess.
 */
export type FirstClipSceneResolutionStrategy = 'BY_EXACT_VIDEO_UUID_AND_ID' | 'BY_EXACT_TITLE_VIA_PROVEN_OPENER' | 'SCENE_ID_UNRESOLVED';

export function decideFirstClipSceneResolutionStrategy(input: {
  videoUuid?: unknown;
  candidates?: readonly FirstClipSceneCandidate[] | null;
  generatedSceneTitle?: unknown;
} | undefined | null): { strategy: FirstClipSceneResolutionStrategy; reason: string } {
  const uuid = String(input?.videoUuid ?? '').trim();
  if (!uuid) return { strategy: 'SCENE_ID_UNRESOLVED', reason: 'no generated video uuid, so no scene identity can be established.' };
  const all = Array.isArray(input?.candidates) ? input.candidates.filter((c): c is FirstClipSceneCandidate => !!c) : [];
  const direct = all.filter((c) => String(c?.videoUuid ?? '').trim() === uuid && String(c?.sceneId ?? '').trim().length > 0);
  if (direct.length === 1) return { strategy: 'BY_EXACT_VIDEO_UUID_AND_ID', reason: 'exactly one scene candidate carries both the generated video uuid and a scene id.' };
  if (direct.length > 1) return { strategy: 'BY_EXACT_VIDEO_UUID_AND_ID', reason: `${direct.length} scene candidates carry the generated video uuid with a scene id; the scene identifier will be checked for ambiguity.` };
  const title = String(input?.generatedSceneTitle ?? '').trim();
  if (title) return { strategy: 'BY_EXACT_TITLE_VIA_PROVEN_OPENER', reason: 'no candidate exposed a scene id for the generated video uuid; the proven exact-title scene opener is the only remaining deterministic route.' };
  return { strategy: 'SCENE_ID_UNRESOLVED', reason: 'neither a scene id for the generated video uuid nor a generated scene title is observable; refusing to guess.' };
}

/**
 * PURE: identify the scene that carries the generated first clip.
 *
 * Rules (live-evidence driven):
 *   · the exact `/video/<UUID>` MUST be observed — an unresolved video uuid refuses immediately;
 *   · a candidate matches ONLY on exact video-uuid equality (never on title similarity, never on
 *     "the first tile");
 *   · exactly one distinct scene id may match — several candidates collapse to one scene only
 *     when their scene ids agree, otherwise the identity is AMBIGUOUS and refuses;
 *   · TILE COUNTS ARE IGNORED. The project grid is virtualised/re-rendered, so an unchanged tile
 *     count is never evidence that no scene was created.
 */
export function identifyFirstClipScene(input: {
  videoUuid?: unknown;
  candidates?: readonly FirstClipSceneCandidate[] | null;
}): { ok: true; sceneId: string; title: string; route: string | null } | { ok: false; code: FirstClipSceneCode; reason: string } {
  const uuid = String(input?.videoUuid ?? '').trim();
  if (!uuid) return { ok: false, code: 'FIRST_CLIP_VIDEO_UUID_UNRESOLVED', reason: 'the generated first clip has no resolved /video/<UUID> identity, so its scene cannot be identified.' };

  const all = Array.isArray(input?.candidates) ? input.candidates.filter((c): c is FirstClipSceneCandidate => !!c) : [];
  const matches = all.filter((c) => String(c?.videoUuid ?? '').trim() === uuid);
  if (matches.length === 0) {
    return { ok: false, code: 'FIRST_CLIP_SCENE_NOT_IDENTIFIED', reason: `no observed scene carries the generated video ${uuid} (${all.length} candidate scene(s) inspected).` };
  }
  const sceneIds = [...new Set(matches.map((c) => String(c?.sceneId ?? '').trim()).filter(Boolean))];
  if (sceneIds.length === 0) return { ok: false, code: 'FIRST_CLIP_SCENE_ID_MISSING', reason: `the generated video ${uuid} matched ${matches.length} scene tile(s) but none exposed a scene id.` };
  if (sceneIds.length > 1) return { ok: false, code: 'FIRST_CLIP_SCENE_AMBIGUOUS', reason: `the generated video ${uuid} is claimed by multiple scenes (${sceneIds.join(', ')}); refusing to guess.` };
  const sceneId = sceneIds[0];
  const title = String(matches.find((c) => String(c?.sceneId ?? '').trim() === sceneId)?.title ?? '').trim();
  const route = String(matches.find((c) => String(c?.sceneId ?? '').trim() === sceneId)?.route ?? '').trim() || null;
  return { ok: true, sceneId, title, route };
}

export type FirstClipGridClassification = 'NEW_SCENE_OBSERVED' | 'NEW_VIDEO_ONLY' | 'AMBIGUOUS' | 'NO_CHANGE';

/**
 * PURE: classify what the generation did to the project grid, WITHOUT trusting tile counts.
 *
 * Live evidence: the grid stayed at 16 tiles while one populated tile was replaced and the new
 * scene appeared — the grid is virtualised/re-rendered. So an unchanged `tileCount` is explicitly
 * NOT treated as "no scene was created"; a new scene is recognised from the exact video-uuid and
 * title evidence, and the counts are recorded only as non-authoritative context.
 */
export function classifyFirstClipGridEvidence(input: {
  videoUuid?: unknown;
  beforeTileCount?: unknown;
  afterTileCount?: unknown;
  newSceneTitles?: readonly unknown[] | null;
}): { classification: FirstClipGridClassification; tileCountAuthoritative: false; reason: string } {
  const uuid = String(input?.videoUuid ?? '').trim();
  const titles = (Array.isArray(input?.newSceneTitles) ? input!.newSceneTitles! : []).map((t) => String(t ?? '').trim()).filter(Boolean);
  const before = Number(input?.beforeTileCount);
  const after = Number(input?.afterTileCount);
  const counts = Number.isFinite(before) && Number.isFinite(after) ? `${before} -> ${after}` : 'unknown';
  if (!uuid) {
    return { classification: 'AMBIGUOUS', tileCountAuthoritative: false, reason: `no generated video uuid was resolved, so the grid change cannot be classified (tile counts ${counts} are not authoritative).` };
  }
  if (titles.length === 1) {
    return { classification: 'NEW_SCENE_OBSERVED', tileCountAuthoritative: false, reason: `video ${uuid} produced a new populated scene titled ${JSON.stringify(titles[0])}; tile counts (${counts}) are recorded but ignored because the grid is virtualised.` };
  }
  if (titles.length > 1) {
    return { classification: 'AMBIGUOUS', tileCountAuthoritative: false, reason: `video ${uuid} produced ${titles.length} candidate new scene titles (${titles.join(', ')}); refusing to pick one.` };
  }
  return { classification: 'NEW_VIDEO_ONLY', tileCountAuthoritative: false, reason: `video ${uuid} appeared with no new scene title; tile counts (${counts}) are recorded but ignored because the grid is virtualised.` };
}

// ---------------------------------------------------------------------------------------
// Pipeline/checkpoint persistence (PURE decision; the EXISTING store is reused, never duplicated)
// ---------------------------------------------------------------------------------------

import { SCENE_CHECKPOINT_SCHEMA_VERSION, validateSceneCheckpoint, type SceneCheckpoint } from './sceneFlowWorkflow.js';

export type FirstClipCheckpointCode =
  | 'SCENE_ID_UNRESOLVED_FOR_PERSISTENCE'
  | 'SCENE_ID_CONFLICTS_WITH_EXISTING'
  | 'VIDEO_UUID_UNRESOLVED_FOR_PERSISTENCE'
  | 'GENERATION_IDENTITY_NOT_SEPARATE'
  | 'CHECKPOINT_INVALID';

/**
 * PURE: decide the checkpoint update for a completed first clip.
 *
 * REUSES the existing `SceneCheckpoint` store and its validator — there is deliberately no second
 * state store. Contract:
 *   · an unresolved or ambiguous scene id is REFUSED (never written);
 *   · the generation uuid is NEVER used as the scene id, and the video uuid is NEVER used as the
 *     scene id — when either equals the scene id the update is refused;
 *   · an existing, DIFFERENT committed scene id is REFUSED rather than silently overwritten;
 *   · an existing, IDENTICAL scene id is IDEMPOTENT (a no-op that still returns the same record);
 *   · `durationSeconds` / `audioPresent` stay nullable and are NOT required for success.
 */
export function decideFirstClipCheckpointUpdate(input: {
  projectId?: unknown;
  sceneNumber?: unknown;
  sceneId?: unknown;
  sceneUrl?: unknown;
  videoUuid?: unknown;
  generationUuid?: unknown;
  durationSeconds?: unknown;
  audioPresent?: unknown;
  localClipPath?: unknown;
  localClipSha256?: unknown;
  existing?: SceneCheckpoint | null;
}): { ok: true; changed: boolean; checkpoint: SceneCheckpoint } | { ok: false; code: FirstClipCheckpointCode; reason: string } {
  const projectId = String(input?.projectId ?? '').trim();
  const sceneNumber = Number(input?.sceneNumber);
  const sceneId = String(input?.sceneId ?? '').trim();
  const videoUuid = String(input?.videoUuid ?? '').trim();
  const generationUuid = String(input?.generationUuid ?? '').trim();

  if (!projectId) return { ok: false, code: 'SCENE_ID_UNRESOLVED_FOR_PERSISTENCE', reason: 'no project id was supplied for the checkpoint.' };
  if (!Number.isInteger(sceneNumber) || sceneNumber <= 0) return { ok: false, code: 'SCENE_ID_UNRESOLVED_FOR_PERSISTENCE', reason: `invalid scene number ${String(input?.sceneNumber)}.` };
  if (!sceneId) return { ok: false, code: 'SCENE_ID_UNRESOLVED_FOR_PERSISTENCE', reason: 'the generated scene id is unresolved; refusing to persist a guessed or ambiguous identity.' };
  if (!videoUuid) return { ok: false, code: 'VIDEO_UUID_UNRESOLVED_FOR_PERSISTENCE', reason: 'the generated /video/<UUID> is unresolved; refusing to persist a first clip without video identity.' };

  // The three identities must remain distinct in storage.
  if (generationUuid && generationUuid === sceneId) return { ok: false, code: 'GENERATION_IDENTITY_NOT_SEPARATE', reason: 'the generation uuid equals the scene id; refusing to persist a conflated identity.' };
  if (videoUuid === sceneId) return { ok: false, code: 'GENERATION_IDENTITY_NOT_SEPARATE', reason: 'the video uuid equals the scene id; refusing to persist a conflated identity.' };

  const existing = input?.existing ?? null;
  const existingSceneId = String(existing?.flow_scene_id ?? '').trim();
  if (existingSceneId && existingSceneId !== sceneId) {
    return { ok: false, code: 'SCENE_ID_CONFLICTS_WITH_EXISTING', reason: `the scene already has a committed Flow scene id (${existingSceneId}) that differs from the newly generated one (${sceneId}); refusing to overwrite it.` };
  }

  const duration = Number(input?.durationSeconds);
  const checkpoint: SceneCheckpoint = {
    schema_version: SCENE_CHECKPOINT_SCHEMA_VERSION,
    project_id: projectId,
    scene_number: sceneNumber,
    flow_scene_id: sceneId,
    flow_scene_url: String(input?.sceneUrl ?? '').trim() || null,
    generation_uuid: generationUuid || null,
    committed_scene_artifact_id: videoUuid,
    local_clip_path: String(input?.localClipPath ?? '').trim() || null,
    local_clip_sha256: String(input?.localClipSha256 ?? '').trim() || null,
    duration_seconds: Number.isFinite(duration) && duration > 0 ? duration : null,
    width: null,
    height: null,
    video_codec: null,
    audio_codec: input?.audioPresent === true ? 'present' : null,
    workflow_status: 'FLOW_SCENE_GENERATED',
    updated_at: null,
  };

  const validated = validateSceneCheckpoint(checkpoint);
  if (!validated.ok) return { ok: false, code: 'CHECKPOINT_INVALID', reason: `the derived checkpoint is invalid: ${validated.reason}` };

  const changed = existing === null
    || String(existing.flow_scene_id ?? '') !== sceneId
    || String(existing.committed_scene_artifact_id ?? '') !== videoUuid;
  return { ok: true, changed, checkpoint };
}

// ---------------------------------------------------------------------------------------
// Generated-scene TITLE derivation (identity-driven, never position-driven)
// ---------------------------------------------------------------------------------------

export type GeneratedSceneTitleCode = 'GENERATED_SCENE_TITLE_AMBIGUOUS' | 'GENERATED_SCENE_TITLE_UNRESOLVED';

/**
 * PURE: derive the title of the scene created by the project-level generation.
 *
 * Live evidence this encodes:
 *   · a project generation auto-creates a populated scene whose title Flow derives from the prompt
 *     (observed: "Empty road beside cremation ground");
 *   · the ONLY authoritative link between that scene and the generation is the exact
 *     `/video/<UUID>` on the populated tile;
 *   · the grid is virtualised/re-rendered, so position, index, grid count and populated-tile count
 *     are NEVER used — not here and not anywhere else.
 *
 * Hierarchy (first match wins, each step strictly narrower):
 *   1. exactly one tile carries the exact generated video uuid AND a non-empty title → that title;
 *   2. no tile carries the video uuid → UNRESOLVED (never fall back to a positional guess);
 *   3. several tiles carry it, or the single match has no title → AMBIGUOUS/UNRESOLVED.
 *
 * The title is NEVER synthesised from the prompt: Flow must expose it in the DOM.
 */
export function deriveGeneratedSceneTitle(input: {
  videoUuid?: unknown;
  candidates?: readonly FirstClipSceneCandidate[] | null;
}): { ok: true; title: string; sceneId: string | null } | { ok: false; code: GeneratedSceneTitleCode; reason: string } {
  const uuid = String(input?.videoUuid ?? '').trim();
  if (!uuid) return { ok: false, code: 'GENERATED_SCENE_TITLE_UNRESOLVED', reason: 'no generated /video/<UUID>, so the generated scene title cannot be derived.' };
  const all = Array.isArray(input?.candidates) ? input.candidates.filter((c): c is FirstClipSceneCandidate => !!c) : [];
  const matches = all.filter((c) => String(c?.videoUuid ?? '').trim() === uuid);
  if (matches.length === 0) {
    return { ok: false, code: 'GENERATED_SCENE_TITLE_UNRESOLVED', reason: `no populated project tile exposes the generated video ${uuid}; the generated scene title is not observable.` };
  }
  const titles = [...new Set(matches.map((c) => String(c?.title ?? '').trim()).filter(Boolean))];
  if (matches.length > 1 && titles.length > 1) {
    return { ok: false, code: 'GENERATED_SCENE_TITLE_AMBIGUOUS', reason: `${matches.length} tiles claim the generated video ${uuid} with ${titles.length} distinct titles (${titles.join(' | ')}); refusing to choose.` };
  }
  if (titles.length === 0) {
    return { ok: false, code: 'GENERATED_SCENE_TITLE_UNRESOLVED', reason: `the generated video ${uuid} is associated with a tile that exposes no title.` };
  }
  if (titles.length > 1) {
    return { ok: false, code: 'GENERATED_SCENE_TITLE_AMBIGUOUS', reason: `the generated video ${uuid} maps to ${titles.length} distinct titles (${titles.join(' | ')}); refusing to choose.` };
  }
  const sceneIds = [...new Set(matches.map((c) => String(c?.sceneId ?? '').trim()).filter(Boolean))];
  return { ok: true, title: titles[0], sceneId: sceneIds.length === 1 ? sceneIds[0] : null };
}

// ---------------------------------------------------------------------------------------
// Click-authorization boundary: GENERATION_CLICK vs SCENE_RESOLUTION_NAVIGATION_CLICK
// ---------------------------------------------------------------------------------------

export type FirstClipClickKind = 'GENERATION_CLICK' | 'SCENE_RESOLUTION_NAVIGATION_CLICK';

export interface ClickAuthorization {
  kind: FirstClipClickKind;
  /** Only a GENERATION_CLICK consumes the single Start-generation budget. */
  consumesGenerationBudget: boolean;
}

/**
 * PURE: the authorization boundary.
 *
 * The one-click credit budget applies ONLY to `GENERATION_CLICK` (the project Start-generation
 * button). `SCENE_RESOLUTION_NAVIGATION_CLICK` is the EXISTING PROVEN scene opener used after
 * generation has already completed, purely to identify the auto-created scene; it is a navigation
 * click and never regenerates, so it must not consume — or be blocked by — the generation budget.
 */
export function classifyFirstClipClick(kind: unknown): ClickAuthorization {
  return String(kind) === 'SCENE_RESOLUTION_NAVIGATION_CLICK'
    ? { kind: 'SCENE_RESOLUTION_NAVIGATION_CLICK', consumesGenerationBudget: false }
    : { kind: 'GENERATION_CLICK', consumesGenerationBudget: true };
}

/**
 * PURE: may a click of this kind proceed?
 *
 * Generation: at most ONE Start click ever, and only when every precondition holds. Once used, a
 * further GENERATION_CLICK is structurally refused.
 * Scene-resolution navigation: permitted only AFTER a generation actually completed (i.e. after
 * the budget has been spent), and it never touches that budget.
 */
export function decideFirstClipClickAuthorization(input: {
  kind?: unknown;
  preconditionsMet?: unknown;
  generationCompleted?: unknown;
  generationClicksSoFar?: unknown;
}): { ok: true; authorization: ClickAuthorization } | { ok: false; reason: string } {
  const auth = classifyFirstClipClick(input?.kind);
  const clicks = Number(input?.generationClicksSoFar ?? 0);
  if (!Number.isFinite(clicks) || clicks < 0) return { ok: false, reason: 'the Start-generation click count is not a valid number.' };

  if (auth.kind === 'SCENE_RESOLUTION_NAVIGATION_CLICK') {
    if (input?.generationCompleted !== true) {
      return { ok: false, reason: 'scene-resolution navigation is only permitted after a generation has actually completed.' };
    }
    return { ok: true, authorization: auth };
  }

  if (input?.preconditionsMet !== true) {
    return { ok: false, reason: 'the Start-generation click is not authorized: preconditions are not satisfied.' };
  }
  if (clicks >= 1) {
    return { ok: false, reason: `the single authorized Start-generation click was already used (clicks=${clicks}); a second generation click is structurally impossible.` };
  }
  return { ok: true, authorization: auth };
}

/**
 * PURE: cross-surface identity check. The generated `/video/<UUID>` must be directly observed on
 * the project route AND (when a picker snapshot is supplied) inside the scene Add Clip → Videos
 * picker. Matching `/image/<UUID>` alone is never sufficient.
 */
export function verifyFirstClipCrossSurfaceIdentity(input: {
  videoUuid?: unknown;
  projectRouteVideoUuids?: readonly unknown[] | null;
  pickerVideoUuids?: readonly unknown[] | null;
}): { ok: true; projectObserved: boolean; pickerObserved: boolean | null } | { ok: false; reason: string } {
  const uuid = String(input?.videoUuid ?? '').trim();
  if (!uuid) return { ok: false, reason: 'the generated video uuid is unresolved, so cross-surface identity cannot be verified.' };
  const project = (Array.isArray(input?.projectRouteVideoUuids) ? input!.projectRouteVideoUuids! : []).map((u) => String(u ?? '').trim());
  const projectObserved = project.includes(uuid);
  if (!projectObserved) return { ok: false, reason: `the generated video ${uuid} is not observable on the project route as a /video/ identity.` };
  if (input?.pickerVideoUuids === undefined || input?.pickerVideoUuids === null) {
    return { ok: true, projectObserved, pickerObserved: null };
  }
  const picker = input.pickerVideoUuids.map((u) => String(u ?? '').trim());
  const pickerObserved = picker.includes(uuid);
  if (!pickerObserved) return { ok: false, reason: `the generated video ${uuid} is observable on the project route but NOT inside the Add Clip → Videos picker.` };
  return { ok: true, projectObserved, pickerObserved };
}