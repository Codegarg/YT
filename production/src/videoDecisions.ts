/** Pure, browser-free decision helpers for the proven Flow video architecture.
 *
 * These encode three production rules discovered live and must stay deterministic
 * and Playwright-free so they can be unit-tested offline:
 *
 * 1. Video generation is only allowed at batch x1 — x2 produced TWO videos with
 *    the SAME auto title, which made title-based attachment ambiguous.
 * 2. A generated video may be attached to a scene only when EXACTLY ONE asset
 *    matches the expected generated title (no substring, no "first match wins").
 * 3. A timeline clip is only trusted once it survives a scene reopen.
 *
 * Nothing here touches the DOM, Playwright, Flow, or the pipeline files.
 */

/** Rejection from requireBatchX1 (thrown, never silently coerced). */
export class BatchNotX1Error extends Error {
  constructor(batch: unknown) {
    super(`Video generation requires batch x1; refusing to continue with batch ${JSON.stringify(batch ?? null)}.`);
    this.name = 'BatchNotX1Error';
  }
}

/**
 * Accept the batch setting ONLY when it is exactly "x1" (after trimming).
 * Any other value — including undefined/null/""/"x2"/"2"/"X1 "/"1" — throws.
 * The return type is the literal "x1" so a caller cannot accidentally continue
 * with a non-x1 batch.
 */
export function requireBatchX1(batch: unknown): 'x1' {
  const normalized = typeof batch === 'string' ? batch.trim() : batch === undefined || batch === null ? '' : String(batch).trim();
  if (normalized !== 'x1') throw new BatchNotX1Error(batch);
  return 'x1';
}

export interface VideoTitles {
  titles?: Array<string | null | undefined>;
}

/**
 * Normalize an asset/title input into a string array.
 * Accepts a plain string[] or objects carrying `title`/`ariaLabel`(string) so
 * DOM descriptors can be passed in without the helper depending on the browser.
 */
function toTitles(input: Array<string | null | undefined | { title?: unknown; ariaLabel?: unknown }> | undefined | null): string[] {
  if (!Array.isArray(input)) return [];
  return input.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') {
      const title = (entry as any).title;
      if (typeof title === 'string') return title;
      const aria = (entry as any).ariaLabel;
      if (typeof aria === 'string') return aria;
    }
    return '';
  });
}

/**
 * True only when EXACTLY ONE candidate title equals the expected title.
 * - exact, case-sensitive, no substring/fuzzy matching
 * - no whitespace trimming and no collapsing (the DOM title must match verbatim)
 * - empty/blank expected title ⇒ false (nothing is attachable)
 * - zero matches ⇒ false; two or more matches ⇒ false
 */
export function isSingleExactMatch(
  candidates: Array<string | null | undefined | { title?: unknown; ariaLabel?: unknown }> | undefined | null,
  expectedTitle: unknown,
): boolean {
  const expected = typeof expectedTitle === 'string' ? expectedTitle : '';
  if (!expected) return false;
  const titles = toTitles(candidates);
  return titles.filter((title) => title === expected).length === 1;
}

export type ClipPersistence =
  | 'PERSISTENT'
  | 'NOT_PERSISTENT'
  | 'AMBIGUOUS';

// ---------------------------------------------------------------------------
// Video generation configuration (pure verification, no browser).
// The proven-live configuration is the only accepted one.
// ---------------------------------------------------------------------------

export interface VideoGenerationConfig {
  mode: string;
  model: string;
  resolution: string;
  duration: string;
  aspect: string;
  batch: string;
}

/** The single proven-live configuration. Never silently substituted. */
export const REQUIRED_VIDEO_CONFIG: VideoGenerationConfig = {
  mode: 'Video',
  model: 'Omni 1.1 Flash',
  resolution: '720p',
  duration: '8s',
  aspect: '16:9',
  batch: 'x1',
};

export type VideoConfigField = keyof VideoGenerationConfig;

export class VideoConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'VideoConfigError'; }
}

/**
 * Normalize an observed settings snapshot into a canonical config, or throw when
 * any required value is missing, ambiguous, or different. Fail-closed: the batch
 * is validated through requireBatchX1 so x2/x3/x4 can never pass.
 */
export function verifyVideoGenerationConfig(observed: Partial<Record<VideoConfigField, unknown>> | undefined | null): VideoGenerationConfig {
  if (!observed || typeof observed !== 'object') {
    throw new VideoConfigError('Video configuration verification failed: no settings evidence was provided.');
  }
  const required = REQUIRED_VIDEO_CONFIG;
  const mismatch = (field: VideoConfigField, actual: unknown) =>
    new VideoConfigError(`Video configuration mismatch for ${field}: expected "${required[field]}", observed ${JSON.stringify(actual ?? null)}.`);

  for (const field of ['mode', 'model', 'resolution', 'duration', 'aspect'] as const) {
    const actual = observed[field];
    if (typeof actual !== 'string' || actual !== required[field]) throw mismatch(field, actual);
  }
  // Batch is safety-critical: delegate to the single source of truth.
  let batch: 'x1';
  try { batch = requireBatchX1(observed.batch); }
  catch { throw mismatch('batch', observed.batch); }

  return { mode: required.mode, model: required.model, resolution: required.resolution, duration: required.duration, aspect: required.aspect, batch };
}

/**
 * Exact option matching for settings menus (no substring, no fuzzy, no trimming).
 * Returns true only when the option list contains the expected value verbatim.
 */
export function hasExactOption(options: Array<string | null | undefined> | undefined | null, expected: unknown): boolean {
  const wanted = typeof expected === 'string' ? expected : '';
  if (!wanted || !Array.isArray(options)) return false;
  return options.some((option) => typeof option === 'string' && option === wanted);
}

/** Pick the exact option value for a field, or throw a clear error. */
export function requireExactOption(field: string, options: Array<string | null | undefined> | undefined | null, expected: string): string {
  if (!hasExactOption(options, expected)) {
    const available = Array.isArray(options) ? options.filter((o): o is string => typeof o === 'string' && o.length > 0) : [];
    throw new VideoConfigError(`Required ${field} option "${expected}" was not found. Available: ${available.length ? available.join('; ') : '(none)'}.`);
  }
  return expected;
}

/** Exact model-family match — "Omni 1.1 Flash" must match verbatim, no substrings. */
export function isExactModelFamily(options: Array<string | null | undefined> | undefined | null, expected: string = REQUIRED_VIDEO_CONFIG.model): boolean {
  return hasExactOption(options, expected);
}

// ---------------------------------------------------------------------------
// Project video inventory deltas (pure, browser-free).
// Generated video tiles expose NO stable media id, so identity is carried by the
// descriptor list itself and the ONLY safe invariant is a count increase of one.
// ---------------------------------------------------------------------------

export interface VideoDescriptor {
  /** The Flow-generated title, read from the tile. Never constructed by us. */
  title: string;
  /**
   * Exact Flow video artifact UUID captured from a GENERATION-TIME representation
   * of the asset.
   *
   * Live STEP-8Q proved the generation surface exposes
   * `flow-content.google/video/<uuid>` (and, for pre-existing assets,
   * `flow-content.google/image/<uuid>`), and live STEP-8S proved the SAME uuid is
   * exposed later by the scene-editor Videos picker as
   * `flow-content.google/image/<uuid>`.
   *
   * The uuid is path-segment agnostic: `/video/<uuid>` and `/image/<uuid>` are the
   * SAME artifact when the uuid is exactly equal (STEP-8S: generation-time
   * `…/video/829591f8…` === picker `…/image/829591f8…`).
   *
   * NOT derived from the reloaded project-grid poster: live STEP-8O proved those
   * thumbnails are opaque `https://flow.google.com/asb/ANqv…` blobs containing no
   * UUID, so they cannot supply an identity.
   */
  artifactId: string;
}

/**
 * Extract the single artifact UUID from a Flow media URL.
 *
 * Accepts BOTH observed forms and treats them as the same identity when the UUID
 * matches (path segment is irrelevant):
 *   `…/video/<uuid>…`  (generation-time representation, live STEP-8Q)
 *   `…/image/<uuid>…`  (picker/timeline representation, live STEP-8K/8S)
 * Opaque blob URLs (e.g. `https://flow.google.com/asb/ANqv…`) intentionally
 * produce '' — they carry no identity (live STEP-8O).
 *
 * Deterministic and exact: exactly ONE distinct UUID required; zero or more than
 * one ⇒ '' (fail closed). Case preserved. No fuzzy/partial matching.
 */
export function extractArtifactIdFromUrl(url: unknown): string {
  const raw = typeof url === 'string' ? url : '';
  if (!raw) return '';
  const matches = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
  const unique = Array.from(new Set(matches));
  return unique.length === 1 ? unique[0] : '';
}

/**
 * Extract the distinct artifact UUIDs from an array of raw URL strings captured
 * from the GENERATION SURFACE (un-navigated project page while/just after
 * generating). Only `flow-content.google/(video|image)/<uuid>` URLs contribute;
 * `/asb/` blobs are ignored (they carry no identity — STEP-8O). Each URL must
 * yield exactly one UUID (strict helper), duplicates collapse, and the result is
 * a de-duplicated set used for the before/after set difference (STEP-8Q).
 */
export function extractArtifactIdsFromUrls(urls: unknown): string[] {
  if (!Array.isArray(urls)) return [];
  const out = new Set<string>();
  for (const raw of urls) {
    const url = typeof raw === 'string' ? raw : '';
    if (!url) continue;
    // Only media-CDN URLs contribute identity; opaque /asb/ blobs never do.
    if (!/flow-content\.google\/(?:video|image)\//i.test(url)) continue;
    const id = extractArtifactIdFromUrl(url);
    if (id) out.add(id);
  }
  return Array.from(out);
}

/**
 * New artifact UUIDs = after − before, computed over GENERATION-SURFACE UUID sets
 * (STEP-8Q semantics). Pure and browser-free.
 *
 * Invariants:
 * - malformed evidence          ⇒ ambiguous
 * - duplicate ids within a side ⇒ ambiguous (identity must be unique)
 * - exactly 1 new id            ⇒ ok (that id)
 * - 0 new ids                   ⇒ none
 * - >1 new ids                  ⇒ ambiguous
 */
export function newArtifactIds(before: unknown, after: unknown): { kind: 'ok'; artifactId: string } | { kind: 'none' } | { kind: 'ambiguous'; reason: string } {
  if (!Array.isArray(before) || !Array.isArray(after)) return { kind: 'ambiguous', reason: 'Generation-surface evidence was malformed (expected two id arrays).' };
  const clean = (list: unknown[]) => list.map((x) => (typeof x === 'string' ? x.trim() : '')).filter((x) => x.length > 0);
  const b = clean(before); const a = clean(after);
  const dupes = (list: string[]) => { const seen = new Set<string>(); const dup = new Set<string>(); for (const id of list) { if (seen.has(id)) dup.add(id); seen.add(id); } return Array.from(dup); };
  const bDup = dupes(b); const aDup = dupes(a);
  if (bDup.length || aDup.length) {
    return { kind: 'ambiguous', reason: `Duplicate artifact ids on the generation surface: ${JSON.stringify([...bDup, ...aDup])}.` };
  }
  const beforeIds = new Set(b);
  const fresh = Array.from(new Set(a.filter((id) => !beforeIds.has(id))));
  if (fresh.length === 0) return { kind: 'none' };
  if (fresh.length > 1) return { kind: 'ambiguous', reason: `Generation surface gained ${fresh.length} new artifact ids (expected exactly 1): ${JSON.stringify(fresh)}.` };
  return { kind: 'ok', artifactId: fresh[0] };
}

export type StableBaseline =
  | { kind: 'stable'; ids: string[] }
  | { kind: 'unstable'; reads: number };

/**
 * Determine whether the generation surface has STABILIZED from a series of
 * successive UUID-set reads (pure, browser-free).
 *
 * Live STEP-8U exposed a hydration race: the project page (a CDK virtual-scroll
 * grid) was still mounting when the FIRST baseline read ran, so a later read
 * legitimately saw MORE (pre-existing) UUIDs and the delta falsely looked like a
 * new artifact. A baseline is therefore only valid once TWO CONSECUTIVE reads are
 * identical (exact set equality — order-independent, no count assumption).
 *
 * - `reads` items, last two equal  ⇒ stable (returns that set)
 * - fewer than 2 reads              ⇒ unstable
 * - trailing pair differs           ⇒ unstable
 * - duplicates within the last read ⇒ unstable (fail closed; identity must be unique)
 *
 * The caller keeps appending reads and re-invoking; when the visible window never
 * shows two equal consecutive sets within its bounded timeout, the caller fails
 * closed. Nothing here waits or loops.
 */
export function stableBaselineFromReads(reads: unknown): StableBaseline {
  if (!Array.isArray(reads) || reads.length < 2) return { kind: 'unstable', reads: Array.isArray(reads) ? reads.length : 0 };
  const norm = (v: unknown): string[] | null => {
    if (!Array.isArray(v)) return null;
    const ids = v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter((x) => x.length > 0);
    const seen = new Set<string>();
    for (const id of ids) { if (seen.has(id)) return null; seen.add(id); }   // duplicate ⇒ fail closed
    return Array.from(new Set(ids)).sort();                                  // order-independent exact set
  };
  const a = norm(reads[reads.length - 2]);
  const b = norm(reads[reads.length - 1]);
  if (!a || !b) return { kind: 'unstable', reads: reads.length };
  const equal = a.length === b.length && a.every((id, i) => id === b[i]);
  return equal ? { kind: 'stable', ids: b } : { kind: 'unstable', reads: reads.length };
}

/**
 * Decide whether a bounded sequence of repeated clip-count reads has STABILIZED
 * (LIVE STEP-8AG: `countTimelineClips()` right after a reopen returned 0 while the
 * clip had genuinely persisted — the scene was still hydrating).
 *
 * A result is stable once the LAST `requiredStable` reads are all identical AND
 * the count is a valid non-negative integer. The stable value may legitimately be
 * 0 (a hydrated EMPTY scene) — zero is NOT treated as failure here; the caller
 * decides based on the expected state.
 *
 * Returns `{ stable: true, count }` or `{ stable: false }`. Pure/deterministic.
 */
export function stableClipCountFromReads(reads: unknown, requiredStable = 2): { stable: boolean; count: number } {
  if (!Array.isArray(reads) || requiredStable < 1) return { stable: false, count: -1 };
  if (reads.length < requiredStable) return { stable: false, count: -1 };
  const tail = reads.slice(reads.length - requiredStable);
  if (tail.some((n) => typeof n !== 'number' || !Number.isInteger(n) || (n as number) < 0)) return { stable: false, count: -1 };
  const first = tail[0] as number;
  return tail.every((n) => n === first) ? { stable: true, count: first } : { stable: false, count: -1 };
}

/**
 * Decide whether a bounded sequence of rail reads has a STABLE active artifact
 * (LIVE STEP-8AI: the populated-scene rail read returned no active item while the
 * scene was still hydrating; a settled read then exposed exactly one).
 *
 * Each read is a rail snapshot; a snapshot contributes its single active uuid ('' if
 * none). Rules (pure/deterministic):
 * - any read with >1 active uuid            ⇒ ambiguous (fail closed)
 * - last `requiredStable` reads all equal a
 *   non-empty uuid                            ⇒ ok
 * - otherwise                                ⇒ not yet stable (keep polling)
 *
 * A stable EMPTY (no active uuid) is never "ok" here — the caller keeps polling and
 * fails closed on timeout. Never invents an identity; never uses order/title.
 */
export function stableActiveRailFromReads(reads: unknown, requiredStable = 2): { kind: 'ok'; artifactId: string } | { kind: 'pending' } | { kind: 'ambiguous'; reason: string } {
  if (!Array.isArray(reads) || requiredStable < 1) return { kind: 'ambiguous', reason: 'Navigation-rail evidence was malformed.' };
  for (const r of reads) {
    if (r && typeof r === 'object' && Number((r as any).activeCount) > 1) {
      return { kind: 'ambiguous', reason: `Navigation rail exposed ${(r as any).activeCount} active items (expected exactly 1).` };
    }
  }
  if (reads.length < requiredStable) return { kind: 'pending' };
  const tail = reads.slice(reads.length - requiredStable);
  const ids = tail.map((r: any) => String((r && typeof r === 'object' ? r.artifactId : '') ?? '').trim());
  if (ids.some((id) => id.length === 0)) return { kind: 'pending' };
  const first = ids[0];
  return ids.every((id) => id === first) ? { kind: 'ok', artifactId: first } : { kind: 'pending' };
}

/**
 * Build the persistence-reload navigation sequence (STEP-8AQ).
 *
 * Live 8AP proved a same-session `goto(canonicalSceneUrl)` can reuse Flow's stale
 * pre-attachment empty scene view, so persistence verification must first leave the
 * scene session. The required order is exactly:
 *
 *   [ validatedProjectUrl, canonicalSceneUrl ]   → then verify
 *
 * NOT `[sceneUrl, sceneUrl]` (a same-scene inflation) and NEVER `/edit/<id>`.
 * Pure/validated: returns [] when either route is missing or the scene route is not
 * a canonical `/project/<id>/scene/<sceneId>` (so callers fail closed).
 */
export function buildPersistenceReloadSequence(projectUrl: unknown, canonicalSceneUrlValue: unknown): string[] {
  const project = (typeof projectUrl === 'string' ? projectUrl.trim() : '').replace(/\/+$/, '');
  const scene = (typeof canonicalSceneUrlValue === 'string' ? canonicalSceneUrlValue.trim() : '').replace(/\/+$/, '');
  if (!project || !scene) return [];
  if (!isFlowProjectRoot(project)) return [];
  if (!isCanonicalFlowSceneRoute(scene)) return [];
  if (scene === project) return [];              // never a same-URL "refresh"
  if (/\/edit\//.test(scene)) return [];         // /edit is never a canonical route
  // The project route must be the same project as the scene route's project.
  if (!scene.startsWith(`${project}/scene/`)) return [];
  return [project, scene];
}

/**
 * Derive { projectUrl, canonicalSceneUrl } from a MOUNTED Flow scene-editor URL
 * (STEP-8CC). The editor mounts under **either** `/project/<id>/scene/<sceneId>` or
 * `/project/<id>/edit/<sceneId>` (live STEP-8J). Title-addressed scenes open via
 * `/edit/<sceneId>` and previously captured no project route, so persistence could not
 * run (live 8CB). This helper validates the mounted route and ALWAYS yields the
 * canonical `/project/<id>/scene/<sceneId>` form.
 *
 * Fail-closed (`{ ok:false }`) when: no valid project base, no valid scene id, or the
 * canonical route cannot be constructed deterministically. Never returns empty values.
 */
export function deriveRoutesFromMountedSceneUrl(mountedUrl: unknown): { ok: true; projectUrl: string; canonicalSceneUrl: string; sceneId: string } | { ok: false; reason: string } {
  const raw = typeof mountedUrl === 'string' ? mountedUrl.trim() : '';
  if (!raw) return { ok: false, reason: 'No mounted scene URL was provided.' };
  const m = raw.match(/^(https?:\/\/[^/]+(?:\/u\/\d+)?\/project\/[^/?#]+)\/(?:scene|edit)\/([^/?#]+)/);
  if (!m) return { ok: false, reason: `The mounted URL "${raw}" is not a Flow project scene route.` };
  const [, projectBase, sceneId] = m;
  const canonical = canonicalSceneUrl(projectBase, sceneId);
  if (!canonical) return { ok: false, reason: `Could not construct a canonical scene route from "${raw}".` };
  return { ok: true, projectUrl: projectBase, canonicalSceneUrl: canonical, sceneId };
}

/**
 * Classify reopen timeline evidence with a REAL hydration signal (STEP-8AN).
 *
 * Live evidence (STEP-8AN):
 *   EMPTY hydrated scene → `div.timeline-contents.is-empty` + `.empty-timeline-track`
 *   POPULATED scene      → `.timeline-contents` WITHOUT `is-empty`
 *   state A (mounted, clips not yet rendered) → no clip, NO is-empty marker
 *
 * - clipCount > 1                     ⇒ 'ambiguous' (fail closed)
 * - clipCount === 1                   ⇒ 'populated' (accept immediately)
 * - clipCount === 0 && hydratedEmpty   ⇒ 'empty'     (genuinely empty; NOT_PERSISTENT upstream)
 * - clipCount === 0 && !hydratedEmpty  ⇒ 'wait'      (STATE A — keep polling; never trust a bare zero)
 * - malformed count                    ⇒ 'ambiguous'
 *
 * `hydratedEmpty` MUST come from the explicit marker, never from a rail thumbnail or
 * a bare zero. Pure/deterministic — no time, no DOM.
 */
export function classifyTimelineHydrationEvidence(
  clipCount: unknown,
  hydratedEmpty: unknown,
): 'populated' | 'empty' | 'wait' | 'ambiguous' {
  const n = typeof clipCount === 'number' && Number.isFinite(clipCount) ? Math.trunc(clipCount) : NaN;
  if (!Number.isInteger(n) || n < 0) return 'ambiguous';
  if (n > 1) return 'ambiguous';
  if (n === 1) return 'populated';
  return hydratedEmpty === true ? 'empty' : 'wait';
}

/**
 * Decide the reopen persistence state from ONE clip-count observation plus elapsed
 * time (LIVE STEP-8AK/8AL, pure/deterministic).
 *
 * 8AK proved `countTimelineClips()` can return 0 for several consecutive 500 ms
 * reads BEFORE the persisted clip renders (~12 s observed), so a "stable 0" seen too
 * early is a hydration race, not "not persisted".
 *
 * - count > 1                                  ⇒ 'ambiguous' (fail closed)
 * - count === 1                                ⇒ 'ready'     (accept immediately; never delayed)
 * - count === 0, elapsed < minZeroObservationMs ⇒ 'wait'
 * - count === 0, elapsed >= floor, zero stable  ⇒ 'empty'     (genuine NOT_PERSISTENT)
 * - invalid count (negative/NaN/malformed)      ⇒ 'ambiguous'
 *
 * `elapsedMs` and `minZeroObservationMs` are injected — no wall-clock here.
 */
export function classifyClipCountObservation(
  count: unknown,
  elapsedMs: unknown,
  minZeroObservationMs: unknown,
  zeroStable: unknown,
): 'ready' | 'ambiguous' | 'wait' | 'empty' {
  const n = typeof count === 'number' && Number.isFinite(count) ? Math.trunc(count) : NaN;
  if (!Number.isInteger(n) || n < 0) return 'ambiguous';
  if (n > 1) return 'ambiguous';
  if (n === 1) return 'ready';
  const floor = typeof minZeroObservationMs === 'number' && Number.isFinite(minZeroObservationMs) ? minZeroObservationMs : Infinity;
  const elapsed = typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) ? elapsedMs : 0;
  if (elapsed < floor) return 'wait';
  return zeroStable === true ? 'empty' : 'wait';
}

/**
 * Google multi-account prefix `/u/<n>`.
 *
 * On a profile signed into more than one Google account, Flow URLs carry `/u/<n>` to say
 * WHICH account is acting. It is part of the real route and MUST be preserved when
 * navigating, but every route matcher/deriver must ACCEPT it: a matcher hard-coded to
 * `/project/<id>` silently fails on `/u/1/project/<id>` and the caller then fails closed
 * (or, worse, matches the wrong account).
 */
const FLOW_ACCOUNT_PREFIX = '(?:\\/u\\/\\d+)?';

/** Known Flow hosts. A route on any other host is never a Flow project route. */
const FLOW_HOSTS = ['flow.google.com', 'labs.google'];

/** The project base of a Flow route: `https://host[/u/n]/project/<projectId>`. Null when absent. */
export function matchFlowProjectBase(url: unknown): string | null {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw) return null;
  const m = raw.match(new RegExp(`^(https?:\\/\\/[^/]+${FLOW_ACCOUNT_PREFIX}\\/project\\/[^/?#]+)`));
  if (!m) return null;
  try {
    if (!FLOW_HOSTS.includes(new URL(m[1]).hostname.toLowerCase())) return null;
  } catch { return null; }
  return m[1];
}

/**
 * The scene id of a MOUNTED Flow scene route: `.../project/<id>/(scene|edit)/<sceneId>`.
 * Null when the URL is not a scene route.
 */
export function matchFlowSceneId(url: unknown): string | null {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw) return null;
  const m = raw.match(new RegExp(`^https?:\\/\\/[^/]+${FLOW_ACCOUNT_PREFIX}\\/project\\/[^/?#]+\\/(?:scene|edit)\\/([^/?#]+)`));
  return m ? m[1] : null;
}

/** True when the URL is a Flow project root (optionally account-prefixed) on a known Flow host. */
export function isFlowProjectRoot(url: unknown): boolean {
  const raw = typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
  if (!raw) return false;
  if (!new RegExp(`^https?:\\/\\/[^/]+${FLOW_ACCOUNT_PREFIX}\\/project\\/[^/?#]+$`).test(raw)) return false;
  return matchFlowProjectBase(raw) === raw;
}

/** True when the URL is a CANONICAL `/project/<id>/scene/<sceneId>` route (never `/edit/`). */
export function isCanonicalFlowSceneRoute(url: unknown): boolean {
  const raw = typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
  if (!raw) return false;
  if (!new RegExp(`^https?:\\/\\/[^/]+${FLOW_ACCOUNT_PREFIX}\\/project\\/[^/?#]+\\/scene\\/[^/?#]+$`).test(raw)) return false;
  return matchFlowProjectBase(raw) !== null;
}

/** How the target Flow scene was identified. Never a title. */
export type SceneAttachmentSource = 'MANIFEST_FLOW_SCENE_ID' | 'MOUNTED_ROUTE';

export type SceneAttachmentAction =
  | { kind: 'open-by-id'; sceneId: string; source: SceneAttachmentSource }
  | { kind: 'unresolved'; reason: string };

/** A Flow scene id is a UUID or a long opaque token (same rule as canonicalSceneUrl). */
export function isFlowSceneId(value: unknown): boolean {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || /^[A-Za-z0-9_-]{20,}$/.test(id);
}

/**
 * Decide WHICH Flow scene a generated result may be attached to.
 *
 * Attachment is only ever performed against a STABLE SCENE ID:
 *   1. the manifest's `flow_scene_id` when it holds a real id, otherwise
 *   2. the scene id parsed from the ACTUAL mounted Flow editor route.
 *
 * A manifest *title* is deliberately NOT an accepted identity. Flow scenes are commonly
 * auto-named ("Untitled Scene 10-06 08:27:47") while the manifest holds an English
 * working title, and a first-match title lookup can silently attach the result to an
 * unrelated scene. When neither stable id exists the caller MUST fail closed.
 *
 * Resolve this BEFORE generating: generation spends Flow credits and cannot be undone.
 */
export function resolveSceneAttachmentTarget(input: { flowSceneId?: unknown; mountedRouteSceneId?: unknown } | undefined | null): SceneAttachmentAction {
  const manifestId = String(input?.flowSceneId ?? '').trim();
  if (isFlowSceneId(manifestId)) return { kind: 'open-by-id', sceneId: manifestId, source: 'MANIFEST_FLOW_SCENE_ID' };
  const mountedId = String(input?.mountedRouteSceneId ?? '').trim();
  if (isFlowSceneId(mountedId)) return { kind: 'open-by-id', sceneId: mountedId, source: 'MOUNTED_ROUTE' };
  return {
    kind: 'unresolved',
    reason: 'the manifest has no flow_scene_id and the current Flow route is not a scene editor route, so no stable scene id identifies the target; refusing to attach by title because that can select an unrelated scene',
  };
}

/**
 * Derive the CANONICAL scene route `/project/<projectId>/scene/<sceneId>` from a
 * validated project URL + scene id (LIVE STEP-8AG: the attach/picker flow can leave
 * the browser on `/edit/<sceneId>`, which does NOT render the added clip on reload).
 *
 * Only accepts already-validated ids (project UUID + scene UUID-ish id); returns ''
 * when either is missing so callers fail closed rather than guessing a route.
 * The account prefix (`/u/<n>/`) is preserved when present.
 */
export function canonicalSceneUrl(projectUrl: unknown, sceneId: unknown): string {
  const base = typeof projectUrl === 'string' ? projectUrl.trim() : '';
  const id = typeof sceneId === 'string' ? sceneId.trim() : '';
  const projectBase = matchFlowProjectBase(base);
  const idOk = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || /^[A-Za-z0-9_-]{20,}$/.test(id);
  if (!projectBase || !idOk) return '';
  return `${projectBase}/scene/${id}`;
}

/**
 * Decide the next action while waiting for the empty-scene Videos asset list to
 * hydrate (LIVE STEP-8AE: the generated artifact appeared in the picker only AFTER
 * the first immediate read had captured 10 stale rows).
 *
 * `matches` is the count of rendered rows whose image UUID exactly equals the
 * expected artifact — never a title/order/count comparison.
 *
 * - 1   ⇒ 'ready'      (stop polling; the caller then re-verifies and clicks ONCE)
 * - 0   ⇒ 'wait'       (keep polling until the bounded timeout)
 * - >1  ⇒ 'ambiguous'  (fail closed immediately; never click)
 *
 * Pure and deterministic — the caller owns all waiting/DOM.
 */
export function decideAssetListSettle(matches: unknown): 'ready' | 'wait' | 'ambiguous' {
  const n = typeof matches === 'number' && Number.isFinite(matches) ? Math.trunc(matches) : -1;
  if (n < 0) return 'ambiguous';   // malformed evidence ⇒ fail closed
  if (n === 0) return 'wait';
  if (n === 1) return 'ready';
  return 'ambiguous';
}

/**
 * Resolve the expected artifact among the scene-editor Videos picker rows.
 *
 * Live STEP-8AC DOM (exact, EMPTY scene → Add Clip → Select media → Videos):
 *   mat-dialog-container[role="dialog"] ("Select media")
 *     > flow-add-menu-popover-content > flow-add-menu-side-nav
 *       > cdk-virtual-scroll-viewport.asset-list-viewport[role="listbox"][aria-label="Asset list"]
 *           > button.asset-item[role="option"]
 *               > img[src="https://flow-content.google/image/<uuid>"]
 *
 * Identity is the row's image URL UUID — NEVER the title (the Videos category
 * legitimately contains duplicate titles, STEP-8AC: 5 rows share "Man looking at
 * mobile phone" with 5 DIFFERENT uuids) and NEVER row order.
 *
 * Pure and browser-free: `rows` are the already-extracted row descriptors.
 * - exactly 1 row whose uuid === expected ⇒ ok
 * - 0 matches                             ⇒ none   (fail closed upstream)
 * - >1 matches                            ⇒ ambiguous
 * - expected empty/malformed              ⇒ ambiguous
 * - duplicate row uuids                   ⇒ ambiguous
 * - rows lacking a flow-content uuid      ⇒ ignored (never a match)
 */
export function resolveVideoPickerArtifact(expectedArtifactId: unknown, rows: unknown): { kind: 'ok'; artifactId: string } | { kind: 'none' } | { kind: 'ambiguous'; reason: string } {
  const expected = typeof expectedArtifactId === 'string' ? expectedArtifactId.trim() : '';
  if (!expected) return { kind: 'ambiguous', reason: 'The expected artifact id is empty; refusing to match a Videos-picker row.' };
  if (!Array.isArray(rows)) return { kind: 'ambiguous', reason: 'Videos-picker row evidence was malformed (expected an array).' };
  const ids: string[] = [];
  for (const row of rows) {
    const src = typeof row === 'string' ? row : (row && typeof row === 'object' ? String((row as any).imgSrc ?? (row as any).src ?? '') : '');
    // Only media-CDN image URLs contribute identity (STEP-8AC); rows without one are inert.
    if (!/flow-content\.google\/image\//i.test(src)) continue;
    const id = extractArtifactIdFromUrl(src);
    if (id) ids.push(id);
  }
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) return { kind: 'ambiguous', reason: `Duplicate artifact ids among Videos-picker rows: ${JSON.stringify(Array.from(new Set(dup)))}.` };
  const matches = ids.filter((id) => id === expected);
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length > 1) return { kind: 'ambiguous', reason: `Videos picker exposed ${matches.length} rows for artifact ${expected} (expected exactly 1).` };
  return { kind: 'ok', artifactId: matches[0] };
}

/**
 * Classify the scene timeline shape from a raw clip count (pure).
 *
 * Live evidence establishes behavior for 0 and 1 clips only; >1 is UNPROVEN and
 * must fail closed (STEP-8AB). Matches Flow's own `-1` "ambiguous" sentinel.
 */
export type SceneState = 'EMPTY' | 'SINGLE_CLIP' | 'MULTI_CLIP' | 'AMBIGUOUS';

export function classifySceneState(clipCount: unknown): SceneState {
  if (typeof clipCount !== 'number' || !Number.isInteger(clipCount) || clipCount < 0) return 'AMBIGUOUS';
  if (clipCount === 0) return 'EMPTY';
  if (clipCount === 1) return 'SINGLE_CLIP';
  return 'MULTI_CLIP';
}

/** Dedicated fail-closed error for the unproven multi-clip case (Part D). */
export class SceneContainsMultipleClipsError extends Error {
  readonly clipCount: number;
  constructor(clipCount: number) {
    super(`Scene contains ${clipCount} clips; multi-clip reconciliation is not supported by the evidence-backed automation.`);
    this.name = 'SceneContainsMultipleClipsError';
    this.clipCount = clipCount;
  }
}

/** True when exactly ONE rail item is the active/current media (STEP-8AA). */
export function exactlyOneActiveRailItem(items: unknown): boolean {
  if (!Array.isArray(items)) return false;
  return items.filter((it: any) => it && typeof it === 'object' && String(it.ariaCurrent ?? '').trim() === 'true').length === 1;
}

/**
 * Resolve the single ACTIVE navigation-rail media UUID (STEP-8AA/8AC).
 *
 * Observed DOM: `flow-navigation-rail button.thumbnail-button.active[aria-current="true"]
 *   > img.thumbnail-image[src="https://flow-content.google/image/<uuid>"]`.
 *
 * Fail closed:
 * - not exactly one active item            ⇒ ambiguous
 * - active item exposes no uuid            ⇒ none
 * - active item exposes >1 distinct uuid   ⇒ ambiguous
 * - duplicate uuids across items           ⇒ ambiguous
 */
export function resolveActiveRailArtifact(items: unknown): { kind: 'ok'; artifactId: string } | { kind: 'none' } | { kind: 'ambiguous'; reason: string } {
  if (!Array.isArray(items)) return { kind: 'ambiguous', reason: 'Navigation-rail evidence was malformed (expected an array).' };
  const actives = items.filter((it: any) => it && typeof it === 'object' && String(it.ariaCurrent ?? '').trim() === 'true');
  if (actives.length === 0) return { kind: 'none' };
  if (actives.length > 1) return { kind: 'ambiguous', reason: `Navigation rail exposed ${actives.length} active items (expected exactly 1).` };
  const src = String((actives[0] as any).imgSrc ?? '');
  const id = extractArtifactIdFromUrl(src);
  if (!id) return { kind: 'none' };
  return { kind: 'ok', artifactId: id };
}

/**
 * Decide whether a populated scene's active-rail identity may be accepted for the
 * expected generation artifact.
 *
 * Live 8Y/8Z/8AB proved the generation artifact uuid and the scene's media uuid can
 * DIFFER for the same generated video, and that a zero-clip scene still shows one
 * `aria-current` rail item — so `aria-current` alone is NOT proof of "the clip we
 * just generated". Binding is therefore accepted only on EXACT uuid equality; any
 * mismatch/missing id fails closed (never assumes, never uses the title).
 */
export function acceptPopulatedRailBinding(expectedArtifactId: unknown, railArtifactId: unknown): { accepted: boolean; reason: string } {
  const expected = typeof expectedArtifactId === 'string' ? expectedArtifactId.trim() : '';
  const rail = typeof railArtifactId === 'string' ? railArtifactId.trim() : '';
  if (!expected) return { accepted: false, reason: 'The expected generation artifact id is empty; refusing to bind the populated scene.' };
  if (!rail) return { accepted: false, reason: 'The populated scene exposed no current-media artifact id on the navigation rail.' };
  if (expected !== rail) return { accepted: false, reason: `The populated scene's current media (${rail}) does not equal the expected generated artifact (${expected}); refusing to assume they are the same media.` };
  return { accepted: true, reason: 'Exact artifact equality.' };
}

/**
 * Derive the single SELECTED Videos-picker artifact id from row evidence (STEP-8AY).
 *
 * Live 8AX: the Videos picker opens with exactly one row already selected
 * (`aria-selected="true"` + `asset-item-active`), and clicking a NON-selected row
 * merely MOVES the selection — a second confirm click is required. This pure helper
 * reads that selection state; identity is the row's own exact `artifactId`.
 *
 * Fail-closed (never returns a guess):
 * - not exactly one selected row            ⇒ `{ ok:false }`
 * - selected row has an empty/malformed id  ⇒ `{ ok:false }`
 * Unknown/malformed entries are ignored (they can never be "selected").
 */
export function exactlyOneSelectedVideoRow(rows: unknown): { ok: true; selectedArtifactId: string } | { ok: false; reason: string } {
  if (!Array.isArray(rows)) return { ok: false, reason: 'Video-row evidence was malformed (expected an array).' };
  const selected: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if ((row as any).selected !== true) continue;
    const id = typeof (row as any).artifactId === 'string' ? ((row as any).artifactId as string).trim() : '';
    selected.push(id);
  }
  if (selected.length === 0) return { ok: false, reason: 'No Videos row was selected (expected exactly 1).' };
  if (selected.length > 1) return { ok: false, reason: `Videos picker exposed ${selected.length} selected rows (expected exactly 1).` };
  if (!selected[0]) return { ok: false, reason: 'The selected Videos row exposed an empty/malformed artifact id.' };
  return { ok: true, selectedArtifactId: selected[0] };
}

/**
 * Classify whether the target artifact is ALREADY the single selected row (STEP-8AY).
 * Exact, case-sensitive string equality only — no trimming/substring/fuzzy matching.
 */
export function classifyVideoRowConfirmation(targetArtifactId: unknown, selectedArtifactId: unknown): 'already-selected' | 'needs-selection' {
  const target = typeof targetArtifactId === 'string' ? targetArtifactId : '';
  const selected = typeof selectedArtifactId === 'string' ? selectedArtifactId : '';
  return target !== '' && target === selected ? 'already-selected' : 'needs-selection';
}

/**
 * True only when the exact target artifact is the exact selected artifact (STEP-8AY).
 * Gates the confirmation click: a mis-selected picker must never be confirmed.
 */
export function confirmTargetSelection(targetArtifactId: unknown, selectedArtifactId: unknown): boolean {
  const target = typeof targetArtifactId === 'string' ? targetArtifactId : '';
  const selected = typeof selectedArtifactId === 'string' ? selectedArtifactId : '';
  return target !== '' && selected !== '' && target === selected;
}

/**
 * Resolve the COMMITTED SCENE media identity (STEP-8BA, pure).
 *
 * Live 8AZ/8AW/8AU proved Flow's picker/generation UUID is NOT the UUID the scene
 * commits (substitutions `eb28bea7…`, `33f9cdd3…`, `b75938b0…` — none present in the
 * picker). The scene's OWN committed media UUID — read from the fresh navigation-rail
 * / timeline surface — is therefore authoritative. This helper only validates that
 * identity; it MUST NOT be compared against the generated artifact.
 *
 * Fail closed for null/undefined/empty/malformed ids.
 */
export function resolveCommittedSceneIdentity(committedArtifactId: unknown): { ok: true; artifactId: string } | { ok: false; reason: string } {
  const id = typeof committedArtifactId === 'string' ? committedArtifactId.trim() : '';
  if (!id) return { ok: false, reason: 'The committed scene exposed no media identity.' };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return { ok: false, reason: `The committed scene media identity "${id}" is malformed (expected a UUID).` };
  }
  return { ok: true, artifactId: id };
}

/**
 * Classify a scene attachment's identity (STEP-8BA, pure).
 *
 * Success = a VALID committed scene identity EXISTS — NOT equality with the
 * generated artifact. A mismatch is recorded as diagnostic metadata
 * (`identityMatchedGeneration`) but MUST NEVER be treated as failure.
 */
export function classifySceneAttachmentIdentity(input: { committedArtifactId?: unknown; generatedArtifactId?: unknown } | undefined | null): {
  kind: 'COMMITTED_IDENTITY' | 'MISSING_COMMITTED_IDENTITY';
  committedArtifactId: string;
  generatedArtifactId: string;
  identityMatchedGeneration: boolean;
  reason: string;
} {
  const resolved = resolveCommittedSceneIdentity(input?.committedArtifactId);
  const generated = typeof input?.generatedArtifactId === 'string' ? (input.generatedArtifactId as string).trim() : '';
  if (!resolved.ok) {
    return { kind: 'MISSING_COMMITTED_IDENTITY', committedArtifactId: '', generatedArtifactId: generated, identityMatchedGeneration: false, reason: resolved.reason };
  }
  return {
    kind: 'COMMITTED_IDENTITY',
    committedArtifactId: resolved.artifactId,
    generatedArtifactId: generated,
    identityMatchedGeneration: generated !== '' && generated === resolved.artifactId,
    reason: 'Committed scene identity is valid (authoritative).',
  };
}

/**
 * Classify a fresh canonical persistence READ for retry (STEP-8BH, pure).
 *
 * Live 8BD/8BG: Flow exposes NO client-observable commit signal, and persistence is
 * intermittent — a scene can read as hydrated-empty immediately after an attachment
 * and become available on a LATER fresh read. This helper decides whether another
 * READ-ONLY fresh load is warranted. It NEVER authorizes re-attaching.
 *
 * Semantics (exact):
 *   clipCount === 1 && hydratedEmpty === false                         ⇒ 'PERSISTED'
 *   clipCount === 0 && hydratedEmpty === true && attempt < maxAttempts ⇒ 'RETRY_READ'
 *   clipCount === 0 && hydratedEmpty === true && attempt >= maxAttempts ⇒ 'NOT_PERSISTED'
 *   clipCount > 1                                                      ⇒ 'AMBIGUOUS'
 *   malformed / clipCount === 0 with hydratedEmpty !== true            ⇒ 'INVALID'
 *
 * A bare clipCount=0 is NEVER treated as empty unless the 8AN hydrated-empty marker
 * is also true (a marker-less zero means "state unknown" ⇒ INVALID, never retried).
 */
export function classifyPersistenceReadRetry(clipCount: unknown, hydratedEmpty: unknown, attempt: unknown, maxAttempts: unknown): 'PERSISTED' | 'RETRY_READ' | 'NOT_PERSISTED' | 'AMBIGUOUS' | 'INVALID' {
  const n = typeof clipCount === 'number' && Number.isFinite(clipCount) ? Math.trunc(clipCount) : NaN;
  const a = typeof attempt === 'number' && Number.isFinite(attempt) ? Math.trunc(attempt) : NaN;
  const max = typeof maxAttempts === 'number' && Number.isFinite(maxAttempts) ? Math.trunc(maxAttempts) : NaN;
  if (!Number.isInteger(n) || n < 0 || !Number.isInteger(a) || a < 1 || !Number.isInteger(max) || max < 1) return 'INVALID';
  if (n === 1) return hydratedEmpty === false ? 'PERSISTED' : 'INVALID';
  if (n > 1) return 'AMBIGUOUS';
  // n === 0
  if (hydratedEmpty !== true) return 'INVALID';
  return a < max ? 'RETRY_READ' : 'NOT_PERSISTED';
}

export type NewVideoResult =
  | { kind: 'ok'; video: VideoDescriptor }
  | { kind: 'none' }
  | { kind: 'ambiguous'; reason: string };

/** Normalize raw inventory input into clean descriptors (drops malformed entries). */
export function normalizeVideoInventory(input: Array<string | null | undefined | { title?: unknown; artifactId?: unknown }> | undefined | null): VideoDescriptor[] {
  if (!Array.isArray(input)) return [];
  const out: VideoDescriptor[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const title = typeof (entry as any).title === 'string' ? (entry as any).title.trim() : '';
    const artifactId = typeof (entry as any).artifactId === 'string' ? (entry as any).artifactId.trim() : '';
    if (!title || !artifactId) continue;      // fail closed: both fields are required
    out.push({ title, artifactId });
  }
  return out;
}

/**
 * Identify the single newly-created video from BEFORE/AFTER inventories.
 *
 * Identity is the ARTIFACT ID (unique per generated asset) — NOT the title, which
 * can legitimately repeat (live STEP-8L: a second run of the same scene prompt
 * produced the same auto-title as an earlier video).
 *
 * Invariants:
 * - malformed/empty evidence            ⇒ ambiguous
 * - duplicate artifactId within a side  ⇒ ambiguous (identity must be unique)
 * - newIds = after − before
 *   · exactly 1                         ⇒ ok (that exact descriptor)
 *   · 0                                 ⇒ none
 *   · >1                                ⇒ ambiguous
 */
export function identifyNewVideo(before: unknown, after: unknown): NewVideoResult {
  if (!Array.isArray(before) || !Array.isArray(after)) return { kind: 'ambiguous', reason: 'Inventory evidence was malformed (expected two descriptor arrays).' };
  const b = normalizeVideoInventory(before as any);
  const a = normalizeVideoInventory(after as any);
  const dupes = (list: VideoDescriptor[]) => {
    const seen = new Set<string>(); const dup = new Set<string>();
    for (const d of list) { if (seen.has(d.artifactId)) dup.add(d.artifactId); seen.add(d.artifactId); }
    return Array.from(dup);
  };
  const bDup = dupes(b); const aDup = dupes(a);
  if (bDup.length || aDup.length) {
    return { kind: 'ambiguous', reason: `Duplicate artifact ids in the video inventory: ${JSON.stringify([...bDup, ...aDup])}.` };
  }

  const beforeIds = new Set(b.map((d) => d.artifactId));
  const newOnes = a.filter((d) => !beforeIds.has(d.artifactId));
  if (newOnes.length === 0) return { kind: 'none' };
  if (newOnes.length > 1) {
    return { kind: 'ambiguous', reason: `Video inventory gained ${newOnes.length} new artifacts (expected exactly 1): ${JSON.stringify(newOnes.map((d) => d.artifactId))}.` };
  }
  return { kind: 'ok', video: newOnes[0] };
}

/**
 * Resolve the generated video's identity from generation-time descriptors.
 *
 * This is the narrow, explicit entry point for "which video did I just create?"
 * using artifact IDs captured WHILE generating (never a reloaded grid poster).
 * Semantics are identical to identifyNewVideo: exactly one new artifact id ⇒ that
 * descriptor; zero ⇒ none; more than one / duplicates / missing ids ⇒ fail closed.
 */
export function resolveGeneratedVideoIdentity(before: unknown, after: unknown): NewVideoResult {
  return identifyNewVideo(before, after);
}

/** Strict wrapper: throws unless exactly one new video is identified. */
export function requireExactlyOneNewVideo(before: unknown, after: unknown): VideoDescriptor {
  const result = identifyNewVideo(before, after);
  if (result.kind === 'ok') return result.video;
  if (result.kind === 'none') throw new VideoConfigError(`No new video appeared: the video inventory did not grow (before ${normalizeVideoInventory(before as any).length}, after ${normalizeVideoInventory(after as any).length}).`);
  throw new VideoConfigError(`Could not identify exactly one newly generated video: ${result.reason}`);
}

/** True when a raw tile descriptor looks like a generated VIDEO tile. */
export function isVideoTileEvidence(evidence: { text?: unknown; posterAlt?: unknown; posterClass?: unknown } | undefined | null): boolean {
  if (!evidence || typeof evidence !== 'object') return false;
  const text = typeof evidence.text === 'string' ? evidence.text : '';
  const alt = typeof evidence.posterAlt === 'string' ? evidence.posterAlt : '';
  const posterClass = typeof evidence.posterClass === 'string' ? evidence.posterClass : '';
  return /play_circle/.test(text) && /Generated video thumbnail/i.test(alt) && /thumbnail/.test(posterClass);
}

/**
 * Normalize raw scene-timeline DOM evidence into a real clip count.
 * Counts ONLY actual clip elements (the caller passes descriptors produced by
 * `flow-scene-timeline .clip` / `.clip.is-first`). Empty containers, drop zones,
 * composer elements, ingredient chips and clip DESCENDANTS must arrive as
 * `isClip:false` so they can never inflate the count. Fail-closed: malformed
 * evidence is reported as ambiguous rather than counted.
 */
export function normalizeClipCount(evidence: Array<{ isClip?: unknown }> | undefined | null): { count: number; ambiguous: boolean } {
  if (!Array.isArray(evidence)) return { count: 0, ambiguous: true };
  let count = 0;
  for (const entry of evidence) {
    if (!entry || typeof entry !== 'object') return { count: 0, ambiguous: true };
    if (entry.isClip === true) count += 1;
  }
  return { count, ambiguous: false };
}

/** True when at least one REAL clip element is present (empty slot never counts). */
export function sceneHasAnyClip(evidence: Array<{ isClip?: unknown }> | undefined | null): boolean {
  const normalized = normalizeClipCount(evidence);
  return !normalized.ambiguous && normalized.count >= 1;
}

/** Build persistence evidence from two normalized clip counts. */
export function clipPersistenceEvidence(beforeCount: number, afterCount: number, ambiguous = false): ClipPersistenceEvidence {
  return { beforeCount, afterCount, ambiguous };
}

/** Immediate attachment rule: a real clip exists right after the click. */
export function classifyImmediateAttachment(beforeCount: number, afterCount: number, ambiguous = false): 'ATTACHED' | 'NOT_ATTACHED' | 'AMBIGUOUS' {
  if (ambiguous || !Number.isFinite(beforeCount) || !Number.isFinite(afterCount)) return 'AMBIGUOUS';
  if (beforeCount !== 0) return 'AMBIGUOUS';   // attachment only valid onto an empty timeline
  if (afterCount === 1) return 'ATTACHED';
  if (afterCount === 0) return 'NOT_ATTACHED';
  return 'AMBIGUOUS';
}

/** Explicit, normalized evidence consumed by classifyClipPersistence. */
export interface ClipPersistenceEvidence {
  /** Count of ACTUAL clips in the timeline before navigating away (0 when empty). */
  beforeCount: number;
  /** Count of ACTUAL clips after reopening the same scene. */
  afterCount: number;
  /**
   * Set true when the reopen evidence cannot reliably establish the clip's
   * existence (for example more than one clip after reopen, or the intended
   * clip could not be distinguished). Forces AMBIGUOUS.
   */
  ambiguous?: boolean;
}

/**
 * Classify whether the intended timeline clip survived a scene reopen.
 *
 * Rules (an empty drop slot / container / descendant node never counts):
 * - beforeCount !== 1  ⇒ AMBIGUOUS (no valid single clip was established first)
 * - ambiguous === true ⇒ AMBIGUOUS
 * - afterCount === 1   ⇒ PERSISTENT
 * - afterCount === 0   ⇒ NOT_PERSISTENT
 * - any other afterCount (e.g. 2+) ⇒ AMBIGUOUS
 */
export function classifyClipPersistence(evidence: ClipPersistenceEvidence | undefined | null): ClipPersistence {
  const before = Number(evidence?.beforeCount);
  const after = Number(evidence?.afterCount);
  if (!Number.isFinite(before) || !Number.isFinite(after)) return 'AMBIGUOUS';
  if (before !== 1) return 'AMBIGUOUS';
  if (evidence?.ambiguous === true) return 'AMBIGUOUS';
  if (after === 1) return 'PERSISTENT';
  if (after === 0) return 'NOT_PERSISTENT';
  return 'AMBIGUOUS';
}

// ---------------------------------------------------------------------------------------
// Committed-clip download (STEP-8EI)
// ---------------------------------------------------------------------------------------

/**
 * Structured outcome of downloading one committed Flow scene clip.
 * Ordinary state outcomes are RETURNED, not thrown.
 */
export type ClipDownloadResult =
  | 'DOWNLOAD_SUCCESS'
  | 'ALREADY_VALID'
  | 'NO_COMMITTED_CLIP'
  | 'DOWNLOAD_CONTROL_NOT_FOUND'
  | 'DOWNLOAD_EVENT_TIMEOUT'
  | 'INVALID_DOWNLOADED_FILE'
  | 'FFPROBE_FAILURE'
  | 'DOWNLOAD_WRITE_FAILED'
  | 'DOWNLOAD_REJECTED'
  | 'PATH_INVALID';

/** The Download control is a MENU TRIGGER; its items are resolution options (live 8EI). */
export const DOWNLOAD_MENU_ITEM_ORIGINAL = '720p Original size';

/**
 * Pick the download option to use from the menu items offered by Flow.
 * Prefers the ORIGINAL (non-upscaled) export. Never upscales: an upscaled or GIF export is a
 * different artifact from the committed clip.
 */
export function chooseDownloadMenuItem(items: unknown): { kind: 'ok'; label: string } | { kind: 'none' } {
  const labels = (Array.isArray(items) ? items : []).map((i) => String(i ?? '').trim()).filter(Boolean);
  if (labels.includes(DOWNLOAD_MENU_ITEM_ORIGINAL)) return { kind: 'ok', label: DOWNLOAD_MENU_ITEM_ORIGINAL };
  // Fall back to any "Original size" item, but never an upscale or a GIF.
  const original = labels.find((l) => /original size/i.test(l));
  if (original) return { kind: 'ok', label: original };
  return { kind: 'none' };
}

/** Deterministic scene-clip filename from a PIPELINE scene number (never from the Flow title). */
export function sceneClipFilename(sceneNumber: unknown): string | null {
  const n = Number(sceneNumber);
  if (!Number.isInteger(n) || n <= 0 || n > 9999) return null;
  return `scene-${String(n).padStart(4, '0')}.mp4`;
}

/** Temporary sibling filename used during a download (kept out of the final name). */
export function clipDownloadTempName(finalName: unknown, pid: unknown = process.pid, stamp: unknown = Date.now()): string | null {
  const name = String(finalName ?? '').trim();
  if (!name) return null;
  return `${name}.flow-download.tmp-${Number(pid)}-${Number(stamp)}`;
}

/**
 * Decide what to do when the destination already exists.
 * A VALID existing clip is never re-downloaded without an explicit overwrite.
 */
export function decideClipDownload(existingValid: unknown, overwrite: unknown): { kind: 'skip' } | { kind: 'download' } {
  if (existingValid === true && overwrite !== true) return { kind: 'skip' };
  return { kind: 'download' };
}

/** Map a download/validation failure to a stable classification. */
export function classifyDownloadFailure(stage: unknown): ClipDownloadResult {
  switch (String(stage)) {
    case 'no-clip': return 'NO_COMMITTED_CLIP';
    case 'no-control': return 'DOWNLOAD_CONTROL_NOT_FOUND';
    case 'timeout': return 'DOWNLOAD_EVENT_TIMEOUT';
    case 'rejected': return 'DOWNLOAD_REJECTED';
    case 'invalid': return 'INVALID_DOWNLOADED_FILE';
    case 'ffprobe': return 'FFPROBE_FAILURE';
    case 'write': return 'DOWNLOAD_WRITE_FAILED';
    case 'path': return 'PATH_INVALID';
    default: return 'DOWNLOAD_WRITE_FAILED';
  }
}
// ---------------------------------------------------------------------------
// First-clip attachment via PREVIEW-VERIFIED artifact UUID (STEP-8ET / 8EU).
//
// 8ER proved the first-clip media-picker ROWS expose no artifact identity (opaque
// `/asb/` WebP thumbnails, duplicated titles). 8ET then proved row selection is
// PREVIEW-ONLY: clicking a row merely moves the selection and swaps the shared detail
// preview, whose `<video class="video-preview">` exposes the artifact UUID in
// `flow-content.google/video/<uuid>`; the scene is only mutated by the separate
// `button.detail-add-to-prompt-btn` ("Add media") control. These pure helpers encode
// that contract so attachment is unit-testable offline and fails closed.
// ---------------------------------------------------------------------------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Extract the artifact UUID from a picker preview video URL.
 * Accepts the canonical `flow-content.google/video/<uuid>` form (query params ignored).
 * Returns null for anything else — never guesses.
 */
export function extractPreviewArtifactUuid(src: unknown): string | null {
  const s = typeof src === 'string' ? src : '';
  if (!s) return null;
  const m = s.match(/flow-content\.google\/video\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Resolve EXACTLY ONE picker row carrying the target artifact, using the shared
 * preview UUID observed after each (preview-only) row click.
 *
 * Fails closed: zero matches and multiple matches both refuse. Never matches by title.
 */
export function resolvePickerCandidateByPreviewUuid(
  candidatePreviewUuids: unknown,
  targetArtifactId: unknown,
): { ok: true; rowIndex: number } | { ok: false; reason: string } {
  const target = typeof targetArtifactId === 'string' ? targetArtifactId.trim().toLowerCase() : '';
  if (!target || !UUID_RE.test(target)) return { ok: false, reason: 'The target artifact id is missing or malformed.' };
  if (!Array.isArray(candidatePreviewUuids)) return { ok: false, reason: 'Preview UUID evidence was malformed (expected an array).' };
  const matches: number[] = [];
  candidatePreviewUuids.forEach((u, i) => {
    const id = extractPreviewArtifactUuid(u);
    if (id && id === target) matches.push(i);
  });
  if (matches.length === 0) return { ok: false, reason: `No picker row previewed the target artifact ${target}.` };
  if (matches.length > 1) return { ok: false, reason: `The target artifact ${target} matched ${matches.length} picker rows (expected exactly 1).` };
  return { ok: true, rowIndex: matches[0] };
}

/**
 * Decide whether the Videos picker surface has genuinely HYDRATED, using only the
 * observable DOM evidence the current UI exposes:
 *   · at least one `button.asset-item[role="option"]` row is present, AND
 *   · the shared detail pane's `video.video-preview` (or any picker video) exposes a
 *     `flow-content.google/video/<uuid>` preview.
 *
 * This is the pure, deterministic gate the browser poller uses to distinguish
 * "surface still hydrating" from a decisive state. It NEVER infers identity from opaque
 * `/asb/` thumbnails and never guesses. Bounded polling is the caller's responsibility.
 */
export function pickerSurfaceHydration(
  input: { rowCount?: unknown; previewSrc?: unknown } | undefined | null,
): { ready: true; previewUuid: string } | { ready: false; reason: 'NO_ROWS' | 'NO_PREVIEW' | 'INVALID' } {
  if (!input || typeof input !== 'object') return { ready: false, reason: 'INVALID' };
  const rowCount = Number((input as any).rowCount);
  if (!Number.isFinite(rowCount) || rowCount < 1) return { ready: false, reason: 'NO_ROWS' };
  const previewUuid = extractPreviewArtifactUuid((input as any).previewSrc);
  if (!previewUuid) return { ready: false, reason: 'NO_PREVIEW' };
  return { ready: true, previewUuid };
}

/**
 * PURE: reduce a sequence of picker preview `src` values to the UNIQUE set of artifact UUIDs.
 *
 * This is the SNAPSHOT primitive for the project's Videos library: rows expose no identity of
 * their own (live: opaque `/asb/` thumbnails, duplicated titles), so the shared detail pane's
 * `video.video-preview` src — sampled once per row as a PREVIEW-ONLY probe — is the only
 * authoritative artifact identity surface.
 *
 * Invariants:
 * - a non-video / wrong-host / malformed src contributes NOTHING (never guessed);
 * - a row whose preview did not resolve contributes NOTHING (it is simply unobserved);
 * - the result is de-duplicated, so a UUID previewed by several rows appears ONCE;
 * - the result is sorted, so set comparison is order-independent.
 *
 * This never infers identity from a title, a row index, `aria-selected`, an `/asb/` token or a
 * project-grid tile.
 */
export function collectPreviewArtifactUuids(previewSrcs: unknown): string[] {
  if (!Array.isArray(previewSrcs)) return [];
  const ids = new Set<string>();
  for (const src of previewSrcs) {
    const uuid = extractPreviewArtifactUuid(src);
    if (uuid) ids.add(uuid);
  }
  return Array.from(ids).sort();
}

export type ProjectGenerationIdentityCode =
  | 'GENERATION_IDENTITY_RESOLVED'
  | 'GENERATION_IDENTITY_NONE'
  | 'GENERATION_IDENTITY_AMBIGUOUS';

/**
 * PURE: decide the generation identity from a STABILIZED pre-generation baseline and one
 * post-generation picker snapshot.
 *
 * The appearance of EXACTLY ONE new persistent Videos-picker UUID is the authoritative
 * identity/completion proof. It deliberately does not consult the project route (which never
 * exposes the generated asset), the scene surface, a title, a row order, or a grid tile.
 *
 * Fails closed: 0 new ⇒ NONE (the caller may keep polling); >1 new, or a duplicate inside either
 * snapshot ⇒ AMBIGUOUS (never pick one).
 */
export function decideProjectGenerationIdentity(input: {
  baseline?: unknown;
  snapshot?: unknown;
} | undefined | null): { ok: true; uuid: string; code: ProjectGenerationIdentityCode }
  | { ok: false; code: ProjectGenerationIdentityCode; reason: string } {
  if (!Array.isArray(input?.baseline) || !Array.isArray(input?.snapshot)) {
    return { ok: false, code: 'GENERATION_IDENTITY_AMBIGUOUS', reason: 'Generation identity evidence was malformed (expected a stabilized baseline and one picker snapshot).' };
  }
  const delta = newArtifactIds(input.baseline, input.snapshot);
  if (delta.kind === 'ok') return { ok: true, uuid: delta.artifactId, code: 'GENERATION_IDENTITY_RESOLVED' };
  if (delta.kind === 'none') {
    return { ok: false, code: 'GENERATION_IDENTITY_NONE', reason: 'no new artifact UUID appeared in the project Videos library; the generated asset is not yet observable.' };
  }
  return { ok: false, code: 'GENERATION_IDENTITY_AMBIGUOUS', reason: delta.reason };
}

/**
 * BOUNDED picker timing. Every value is derived from LIVE-PROVEN preview behaviour and is
 * deliberately finite.
 *
 * HISTORY OF THIS BLOCK. The first live snapshot read ONE uuid from TWELVE rows, which was
 * attributed to a too-short per-row sample. Extra per-row RETRIES were added on that theory and
 * are now DEAD MACHINERY: a later zero-credit investigation proved the real cause was structural,
 * not temporal (see `decideRowPreviewAction`), and that with the selected-row guard every row
 * resolves on the FIRST settle. The proven 1200 ms settle is therefore retained and
 * `rowPreviewRetries` is pinned to 0, which shrinks every derived budget honestly instead of
 * padding it.
 */
export const PICKER_TIMING = {
  /** Per-row preview settle, matching the proven attachment resolver's per-row wait. */
  rowPreviewSettleMs: 1200,
  /**
   * Extra reads for ONE row after its settle. ZERO, live-proven: with the selected-row guard
   * (never click the already-selected row) all 12 rows resolved on the first settle in ~15 s.
   * Retries cannot repair a destructive toggle, so they are removed rather than merely lowered.
   */
  rowPreviewRetries: 0,
  /**
   * Gap that WOULD separate extra reads. Inert while `rowPreviewRetries` is 0; kept so
   * `estimatePickerRowCycleMs()` stays a total function of the timing object.
   */
  rowPreviewReadMs: 250,
  /** Bounded picker hydration gate. */
  hydrationTimeoutMs: 20000,
  hydrationPollMs: 700,
  /** Safety bound on enumerated parent rows. */
  maxRows: 60,
  /** Fixed per-snapshot overhead: dialog open, category switch, first preview read, Escape. */
  snapshotOverheadMs: 8000,
} as const;

/** Worst-case cost of ONE complete row-probe cycle, in ms. */
export function estimatePickerRowCycleMs(timing: Partial<typeof PICKER_TIMING> = {}): number {
  const t = { ...PICKER_TIMING, ...timing };
  return Math.max(0, t.rowPreviewSettleMs + Math.max(0, t.rowPreviewRetries) * Math.max(0, t.rowPreviewReadMs));
}

/** Worst-case cost of ONE complete snapshot, in ms (hydration + every row + overhead). */
export function estimatePickerSnapshotMs(timing: Partial<typeof PICKER_TIMING> = {}): number {
  const t = { ...PICKER_TIMING, ...timing };
  return Math.max(0, t.hydrationTimeoutMs + t.maxRows * estimatePickerRowCycleMs(t) + t.snapshotOverheadMs);
}

/** Bounded budget large enough for TWO complete snapshots (the stabilization requirement). */
export function pickerBaselineBudgetMs(timing: Partial<typeof PICKER_TIMING> = {}): number {
  return Math.max(0, 2 * estimatePickerSnapshotMs(timing));
}

/**
 * ONE bounded preview read for a single parent row.
 *
 * CONTRACT (this is the field the live diagnostic proved was ambiguous):
 *   `uuid` is the ALREADY-EXTRACTED, BARE artifact identity — a bare
 *   `<8-4-4-4-12 hex>` uuid such as the one `extractPreviewArtifactUuid()` returns — or `null` when
 *   the preview element was absent or carried no valid identity. It is NEVER a URL and NEVER a
 *   preview `src`. (No observed uuid is ever hardcoded here; the 8BX audit enforces that.)
 *
 *   raw `video.video-preview` src
 *     -> `extractPreviewArtifactUuid(src)`   <-- the ONLY extraction boundary, at the producer
 *     -> `PickerRowPreviewRead.uuid` (bare)
 *     -> `decideRowPreviewIdentity()` consumes it as an IDENTITY, never as a URL.
 *
 *   Re-extracting here is what previously destroyed every snapshot: the reducer ran
 *   `extractPreviewArtifactUuid()` a second time on an already-bare value, the regex required the
 *   `flow-content.google/video/` prefix, so it returned null for all 12 rows and the snapshot
 *   reported 0/12 despite holding 12 correct distinct identities.
 */
export interface PickerRowPreviewRead {
  /** Already-extracted BARE artifact uuid, or null. NEVER a URL, NEVER a preview src. */
  uuid: string | null;
  /** Whether the shared preview element existed at all when this read was taken. */
  elementPresent: boolean;
  elapsedMs: number;
}

/** One parent row's bounded preview-probe record (diagnostic; `title` is NEVER identity). */
export interface PickerRowPreviewProbe {
  rowIndex: number;
  /** Diagnostic ONLY — never used for identity. */
  title?: string | null;
  /** Each bounded preview read. See {@link PickerRowPreviewRead} for the `uuid` contract. */
  reads: PickerRowPreviewRead[];
}

export type PickerRowPreviewDecision =
  | { resolved: true; rowIndex: number; uuid: string; readCount: number; elapsedMs: number }
  | { resolved: false; rowIndex: number; readCount: number; elapsedMs: number; reason: string };

export type PickerRowPreviewAction = 'READ' | 'CLICK';

/**
 * PURE: decide whether ONE picker row may be clicked as a preview action, or must instead be
 * READ from the shared detail-pane preview that is already displayed.
 *
 * WHY THIS EXISTS (live-proven, zero credit). The Videos picker AUTO-SELECTS row 0 when it opens
 * (`aria-selected="true"`, class `asset-item asset-item-active`) and immediately renders that
 * row's preview. Clicking an ALREADY-SELECTED row is therefore NOT a harmless preview action — it
 * is a destructive TOGGLE that deselects the row and DESTROYS the detail pane:
 *
 *   selected row        -> no selection at all
 *   flow-add-menu-detail-pane -> removed from the DOM
 *   video.video-preview -> gone (zero `<video>` in the WHOLE document)
 *   "Add media"         -> gone
 *
 * Because that pane holds the ONLY artifact identity in the entire app, one unconditional click on
 * row 0 destroys the ability to identify every remaining row. That is exactly why a previous
 * snapshot read 1 of 12 uuids (and burned 390 s retrying a structural fault), and why the
 * attachment resolver could only ever succeed when the target happened to be row 0.
 *
 * Clicking a row that is NOT selected is safe and is the correct preview action: selection moves
 * from A to B, the pane stays mounted, and the shared preview becomes B's uuid.
 *
 * INVARIANTS:
 * - `aria-selected` is an INTERACTION-STATE signal only. This helper NEVER inspects, derives or
 *   returns any media identity, and no caller may use it as one;
 * - the input is STRICT: only the literal booleans are accepted. A missing, stringified or
 *   otherwise malformed state fails closed with `ok: false` so the caller performs NO click, which
 *   is the only safe default when the state is unknown (an unknown state might be "selected");
 * - a READ costs nothing and a CLICK is a single, non-mutating, preview-only action. Neither ever
 *   touches `button.detail-add-to-prompt-btn`.
 */
export function decideRowPreviewAction(rowAlreadySelected: unknown):
  | { ok: true; action: 'READ' }
  | { ok: true; action: 'CLICK' }
  | { ok: false; reason: string } {
  if (rowAlreadySelected === true) return { ok: true, action: 'READ' };
  if (rowAlreadySelected === false) return { ok: true, action: 'CLICK' };
  return {
    ok: false,
    reason: 'the picker row selection state was not an explicit boolean, so the row cannot be safely interacted with; the caller must not click it.',
  };
}

/**
 * ANCHORED bare-artifact-UUID matcher. Deliberately anchored on BOTH ends so that a preview URL,
 * a `src` with a query string, or any decorated string can never satisfy it. This is what makes the
 * declared contract enforceable rather than merely documented.
 */
const BARE_ARTIFACT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PURE: the SINGLE validation boundary for an ALREADY-EXTRACTED artifact identity.
 *
 * This is deliberately NOT {@link extractPreviewArtifactUuid}: that function parses a preview URL
 * and is the producer-side extraction step, while this one validates a bare value that has already
 * been through it. Keeping the two separate is what makes double extraction impossible — a value
 * that came from the producer is validated here as an identity and is never re-parsed as a URL.
 *
 * Fails closed: null, non-strings, empty/whitespace strings, URLs, `src` values with query strings
 * and any malformed uuid all return null.
 */
export function normalizeExtractedArtifactUuid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!BARE_ARTIFACT_UUID_RE.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/**
 * PURE: decide one row's artifact identity from its BOUNDED preview reads.
 *
 * INPUT CONTRACT: `probe.reads[].uuid` is an ALREADY-EXTRACTED BARE uuid (see
 * {@link PickerRowPreviewRead}). It is consumed here as an IDENTITY through
 * {@link normalizeExtractedArtifactUuid} and is NEVER parsed as a URL — this function must not call
 * {@link extractPreviewArtifactUuid}, because doing so is the double-extraction defect that made a
 * live snapshot resolve 0 of 12 rows while holding 12 correct distinct uuids.
 *
 * Invariants:
 * - the first read carrying a VALID bare uuid wins;
 * - a read whose uuid is null, empty, a URL or malformed is rejected and scanning continues;
 * - a row may carry several bounded reads (the reducer stays order-tolerant), but the live-proven
 *   snapshot path now records exactly ONE read per row, so this never hides a failure behind a
 *   retry window;
 * - an UNCHANGED uuid across reads is NOT a failure: a row that is already previewed legitimately
 *   reports the same uuid before and after the click;
 * - failure ONLY when every bounded read is rejected;
 * - the row title is carried for diagnostics and is never consulted for identity.
 */
export function decideRowPreviewIdentity(probe: PickerRowPreviewProbe | null | undefined): PickerRowPreviewDecision {
  const rowIndex = Number(probe?.rowIndex);
  if (!probe || !Array.isArray(probe.reads) || probe.reads.length === 0) {
    return {
      resolved: false, rowIndex: Number.isFinite(rowIndex) ? rowIndex : -1, readCount: 0, elapsedMs: 0,
      reason: 'the row produced no preview reads at all within its bounded window.',
    };
  }
  const elapsedMs = probe.reads.reduce((n, r) => n + (Number.isFinite(Number(r?.elapsedMs)) ? Number(r.elapsedMs) : 0), 0);
  for (const read of probe.reads) {
    const uuid = normalizeExtractedArtifactUuid(read?.uuid);
    if (uuid) {
      return { resolved: true, rowIndex, uuid, readCount: probe.reads.length, elapsedMs };
    }
  }
  return {
    resolved: false, rowIndex, readCount: probe.reads.length, elapsedMs,
    reason: `the row exposed no valid bare artifact uuid across ${probe.reads.length} bounded read(s).`,
  };
}

export type PickerSnapshotCompleteness = 'COMPLETE' | 'PARTIAL' | 'INVALID';

export interface PickerSnapshotClassification {
  completeness: PickerSnapshotCompleteness;
  rowsObserved: number;
  rowsResolved: number;
  /** Row indices that never exposed a valid preview uuid. */
  unresolvedRows: number[];
  /** The unique artifact-uuid set observed across RESOLVED rows. */
  uuids: string[];
  /** Diagnostics: uuids exposed by more than one row (a valid observation, never a failure). */
  duplicateUuidRows: Array<{ uuid: string; rowIndexes: number[] }>;
  /** Per-row diagnostics (diagnostic only; titles are never identity). */
  rowDiagnostics: Array<{ rowIndex: number; title: string | null; resolved: boolean; uuid: string | null; readCount: number; elapsedMs: number; reads: PickerRowPreviewProbe['reads'] }>;
  reason: string;
}

/**
 * PURE: classify a picker snapshot by ROW-LEVEL OBSERVABILITY, never by an expected library size.
 *
 * The invariant is: EVERY enumerated parent row must expose a valid video preview uuid within its
 * bounded settle window. The number of video assets is deliberately NOT assumed — 12 rows may
 * legitimately resolve to 12, 6, or even 1 unique uuid.
 *
 * - no outcomes / empty outcomes            ⇒ INVALID (fail closed)
 * - every row resolved                      ⇒ COMPLETE (duplicates are recorded, never a failure)
 * - any row never resolved                  ⇒ PARTIAL (must NOT become a generation baseline)
 */
export function classifyPickerSnapshotCompleteness(
  probes: readonly PickerRowPreviewProbe[] | null | undefined,
): PickerSnapshotClassification {
  const list = Array.isArray(probes) ? probes : [];
  const rowsObserved = list.length;
  if (rowsObserved === 0) {
    return {
      completeness: 'INVALID', rowsObserved: 0, rowsResolved: 0, unresolvedRows: [], uuids: [],
      duplicateUuidRows: [], rowDiagnostics: [],
      reason: 'the picker snapshot enumerated zero parent rows, so no library identity can be proven.',
    };
  }
  const decisions = list.map((p) => decideRowPreviewIdentity(p));
  const rowDiagnostics = decisions.map((d, i) => ({
    rowIndex: d.rowIndex,
    title: list[i]?.title ?? null,
    resolved: d.resolved,
    uuid: d.resolved ? d.uuid : null,
    readCount: d.readCount,
    elapsedMs: d.elapsedMs,
    reads: Array.isArray(list[i]?.reads) ? list[i].reads : [],
  }));
  const resolved = rowDiagnostics.filter((r) => r.resolved && r.uuid);
  const unresolvedRows = rowDiagnostics.filter((r) => !r.resolved).map((r) => r.rowIndex);
  // These uuids are ALREADY validated as bare identities by `decideRowPreviewIdentity` via
  // `normalizeExtractedArtifactUuid`, so they are de-duplicated directly rather than re-parsed.
  // Re-parsing here (or anywhere downstream) would be the double-extraction defect.
  const byUuid = new Map<string, number[]>();
  for (const r of resolved) {
    const id = r.uuid as string;
    const list = byUuid.get(id);
    if (list) list.push(r.rowIndex); else byUuid.set(id, [r.rowIndex]);
  }
  const uuids = Array.from(byUuid.keys()).sort();
  const duplicateUuidRows = Array.from(byUuid.entries()).filter(([, idx]) => idx.length > 1).map(([uuid, rowIndexes]) => ({ uuid, rowIndexes }));
  const completeness: PickerSnapshotCompleteness = unresolvedRows.length === 0 ? 'COMPLETE' : 'PARTIAL';
  return {
    completeness,
    rowsObserved, rowsResolved: resolved.length, unresolvedRows, uuids, duplicateUuidRows, rowDiagnostics,
    reason: unresolvedRows.length === 0
      ? `all ${rowsObserved} enumerated parent row(s) exposed a valid video preview uuid (${uuids.length} unique); ${duplicateUuidRows.length} uuid(s) were exposed by more than one row.`
      : `${resolved.length}/${rowsObserved} parent row(s) exposed a valid video preview uuid; row(s) ${unresolvedRows.join(', ')} did not resolve within their bounded window, so this snapshot is PARTIAL and must not be used as a generation baseline.`,
  };
}

/**
 * Classify how many project-grid tiles match one artifact title.
 * The project grid exposes no artifact UUID, so the exact visible tile title (aria-label)
 * is the strongest deterministic identity available. Fails closed on zero or multiple.
 */
export type ProjectArtifactTileMatch = 'UNIQUE_ARTIFACT_TILE' | 'NO_ARTIFACT_TILE' | 'AMBIGUOUS_ARTIFACT_TILES';

export function classifyProjectArtifactTiles(matchCount: unknown): ProjectArtifactTileMatch {
  const n = Number(matchCount);
  if (!Number.isFinite(n) || n <= 0) return 'NO_ARTIFACT_TILE';
  if (n > 1) return 'AMBIGUOUS_ARTIFACT_TILES';
  return 'UNIQUE_ARTIFACT_TILE';
}

/**
 * Pure title matcher. `ariaLabels` are the visible project tile labels; `title` is the exact
 * artifact title to resolve. Only exact (trimmed) matches count — never substring/fuzzy.
 */
export function matchProjectArtifactTiles(
  ariaLabels: unknown,
  title: unknown,
): { matches: number[]; classification: ProjectArtifactTileMatch } {
  const wanted = typeof title === 'string' ? title.trim() : '';
  const labels = Array.isArray(ariaLabels) ? ariaLabels.map((x) => String(x ?? '').trim()) : [];
  const matches: number[] = [];
  if (wanted) labels.forEach((label, index) => { if (label === wanted) matches.push(index); });
  return { matches, classification: classifyProjectArtifactTiles(matches.length) };
}

/**
 * Decide whether it is safe to perform the single "Add media" mutation.
 * Requires: the preview still shows the exact target UUID and an Add media control exists.
 */
export function decideFirstClipAttachment(input: {
  previewArtifactId?: unknown;
  targetArtifactId?: unknown;
  addMediaPresent?: unknown;
} | undefined | null): { ok: true } | { ok: false; reason: string } {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'No attachment decision input was supplied.' };
  const target = typeof input.targetArtifactId === 'string' ? input.targetArtifactId.trim().toLowerCase() : '';
  const preview = typeof input.previewArtifactId === 'string' ? input.previewArtifactId.trim().toLowerCase() : '';
  if (!target || !UUID_RE.test(target)) return { ok: false, reason: 'The target artifact id is missing or malformed.' };
  if (input.addMediaPresent !== true) return { ok: false, reason: 'The picker has no "Add media" confirmation control.' };
  if (!preview) return { ok: false, reason: 'The picker preview exposed no artifact UUID.' };
  if (preview !== target) return { ok: false, reason: `The picker preview (${preview}) does not equal the target artifact (${target}); refusing to attach.` };
  return { ok: true };
}

/** Classify the outcome of a first-clip attachment attempt. */
export type FirstClipAttachmentClassification =
  | 'ATTACHED_AND_PERSISTED'
  | 'ATTACHED_BUT_NOT_PERSISTED'
  | 'ATTACHMENT_FAILED'
  | 'TARGET_ARTIFACT_IDENTITY_UNCERTAIN'
  | 'SCENE_STATE_UNEXPECTED';

export function classifyFirstClipAttachment(evidence: {
  sceneWasEmpty?: unknown;
  identityResolved?: unknown;
  immediateClipCount?: unknown;
  persistedClipCounts?: unknown;
} | undefined | null): FirstClipAttachmentClassification {
  if (!evidence || typeof evidence !== 'object') return 'SCENE_STATE_UNEXPECTED';
  if (evidence.sceneWasEmpty !== true) return 'SCENE_STATE_UNEXPECTED';
  if (evidence.identityResolved !== true) return 'TARGET_ARTIFACT_IDENTITY_UNCERTAIN';
  const immediate = Number(evidence.immediateClipCount);
  if (!Number.isFinite(immediate) || immediate < 1) return 'ATTACHMENT_FAILED';
  const reads = Array.isArray(evidence.persistedClipCounts) ? evidence.persistedClipCounts.map((c) => Number(c)) : [];
  if (reads.length === 0 || !reads.every((c) => c >= 1)) return 'ATTACHED_BUT_NOT_PERSISTED';
  return 'ATTACHED_AND_PERSISTED';
}

// ---------------------------------------------------------------------------
// Hydration-aware persistence classification (STEP-8EX).
//
// 8EW proved the attach helper's internal persistence reads could return [0,0,1]:
// the first fresh reads hit STATE A (timeline mounted but the committed clip not yet
// rendered), and the EMPTY marker (`div.timeline-contents.is-empty`) is still present
// transiently. A bare zero must therefore NEVER be classified as HYDRATED_EMPTY until
// the bounded hydration window has expired AND the zero has stayed stable.
//
// This wraps the existing 8AK classifier (`classifyClipCountObservation`) so the
// semantics are shared, and exposes the five required states.
// ---------------------------------------------------------------------------

export type HydrationClassification = 'HYDRATING' | 'POPULATED' | 'HYDRATED_EMPTY' | 'AMBIGUOUS' | 'INVALID';

/**
 * Classify ONE hydration observation.
 * `elapsedMs` / `minHydrationMs` are injected (no wall-clock here) so it is pure/testable.
 *
 * - invalid/negative count                 => INVALID
 * - count > 1                              => AMBIGUOUS (fail closed)
 * - count === 1                            => POPULATED (never delayed)
 * - count === 0, elapsed < minHydrationMs  => HYDRATING (never NOT_PERSISTED yet)
 * - count === 0, floor met, zero stable    => HYDRATED_EMPTY
 * - count === 0, floor met, zero unstable  => HYDRATING (keep polling)
 */
export function classifyHydrationObservation(
  clipCount: unknown,
  elapsedMs: unknown,
  minHydrationMs: unknown,
  zeroStable: unknown,
): HydrationClassification {
  const raw = typeof clipCount === 'number' && Number.isFinite(clipCount) ? clipCount : NaN;
  if (!Number.isInteger(raw) || raw < 0) return 'INVALID';
  const decision = classifyClipCountObservation(raw, elapsedMs, minHydrationMs, zeroStable);
  switch (decision) {
    case 'ready': return 'POPULATED';
    case 'ambiguous': return 'AMBIGUOUS';
    case 'empty': return 'HYDRATED_EMPTY';
    default: return 'HYDRATING';
  }
}

/**
 * Decide whether a bounded hydration loop has produced a FINAL observation.
 * HYDRATING is the only non-final state (keep polling until the bound expires).
 * When the bound expires mid-hydration the caller must treat it as a failure
 * (`HYDRATING` is returned and the loop reports timeout), never as NOT_PERSISTED.
 */
export function isFinalHydrationState(state: unknown): state is 'POPULATED' | 'HYDRATED_EMPTY' | 'AMBIGUOUS' | 'INVALID' {
  return state === 'POPULATED' || state === 'HYDRATED_EMPTY' || state === 'AMBIGUOUS' || state === 'INVALID';
}

// ---------------------------------------------------------------------------
// Bounded download filesystem recovery (STEP-8EX).
//
// 8EW proved the browser may materialize the exported file in the download directory
// AFTER the 60 s download-event window closes (the page tears down on the download
// event, losing the automation path()). This pure helper decides, given a before/after
// snapshot of the download directory plus a per-candidate size-stability sighting count,
// which newly-created candidate (if any) is a COMPLETE file ready to validate.
// Pre-existing files are ignored; growing files keep polling; a candidate is accepted
// only once its size is stable across two consecutive samples.
// ---------------------------------------------------------------------------

export interface DownloadCandidateSighting { name?: unknown; size?: unknown; firstSeenMs?: unknown; stableHits?: unknown; }

/**
 * Pick the single recoverable download candidate from observed sightings.
 * `beforeNames` is the pre-click directory snapshot; any name in it is ignored.
 *
 * Fail-closed: returns `{ kind: 'pending' }` while any candidate is still growing or
 * no candidate exists yet, and `{ kind: 'ambiguous' }` if two or more distinct new
 * candidates are simultaneously stable (never guess between them).
 */
export function selectRecoverableDownload(
  sightings: unknown,
  beforeNames: unknown,
): { kind: 'ok'; name: string } | { kind: 'pending' } | { kind: 'ambiguous' } {
  const before = new Set((Array.isArray(beforeNames) ? beforeNames : []).map((n) => String(n ?? '')));
  if (!Array.isArray(sightings)) return { kind: 'pending' };
  const stable: Array<{ name: string; size: number }> = [];
  let anyNew = false;
  for (const s of sightings as DownloadCandidateSighting[]) {
    if (!s || typeof s !== 'object') continue;
    const name = typeof s.name === 'string' ? s.name : '';
    if (!name || before.has(name)) continue;                       // pre-existing / malformed → ignore
    if (!/\.(mp4|tmp)$/i.test(name)) continue;                     // only download artifacts
    anyNew = true;
    const size = Number(s.size);
    if (!Number.isFinite(size) || size <= 0) continue;             // empty → keep waiting
    if (Number(s.stableHits) >= 2) stable.push({ name, size });    // two consecutive equal samples
  }
  if (stable.length === 0) return { kind: 'pending' };
  if (stable.length > 1) return { kind: 'ambiguous' };
  return { kind: 'ok', name: stable[0].name };
}

// ---------------------------------------------------------------------------
// Fresh-navigation MOUNT GATE (STEP-8EZ).
//
// 8EY proved a fresh /scene navigation can report `clipCount:0 + hydratedEmpty:false`
// while the timeline surface has NOT yet mounted. Starting the hydration clock in that
// state burns the timeout before the surface is observable, producing a false zero.
//
// The mount gate MUST run before the hydration clock starts. This pure classifier
// separates MOUNTING (surface not yet observable) from the post-mount hydration states.
// ---------------------------------------------------------------------------

export type MountAwareState = 'MOUNTING' | 'MOUNT_TIMEOUT' | 'POPULATED' | 'HYDRATING' | 'HYDRATED_EMPTY' | 'AMBIGUOUS' | 'INVALID';

/**
 * Decide the observation state BEFORE the hydration clock is allowed to start.
 *
 * - timeline not mounted                      => MOUNTING (keep polling the gate; clock NOT started)
 * - mount gate window expired                 => MOUNT_TIMEOUT (fail closed, distinct from empty)
 * - mounted + invalid/negative clip count     => INVALID
 * - mounted + count > 1                       => AMBIGUOUS
 * - mounted + count === 1                     => POPULATED (immediate)
 * - mounted + count === 0, zero stable/floor  => HYDRATED_EMPTY
 * - mounted + count === 0 otherwise           => HYDRATING
 *
 * `mounted` is the observable timeline-surface state; `mountElapsedMs`/`mountTimeoutMs`
 * are injected (no wall-clock here). A pre-mount zero can NEVER become HYDRATED_EMPTY.
 */
export function classifyMountAwareObservation(input: {
  mounted?: unknown;
  mountElapsedMs?: unknown;
  mountTimeoutMs?: unknown;
  clipCount?: unknown;
  hydrationElapsedMs?: unknown;
  minHydrationMs?: unknown;
  zeroStable?: unknown;
} | undefined | null): MountAwareState {
  if (!input || typeof input !== 'object') return 'INVALID';
  if (input.mounted !== true) {
    const elapsed = Number(input.mountElapsedMs);
    const bound = Number(input.mountTimeoutMs);
    if (Number.isFinite(elapsed) && Number.isFinite(bound) && elapsed >= bound) return 'MOUNT_TIMEOUT';
    return 'MOUNTING';
  }
  return classifyHydrationObservation(input.clipCount, input.hydrationElapsedMs, input.minHydrationMs, input.zeroStable) as MountAwareState;
}

/** True only for terminal mount-aware states (everything except MOUNTING/HYDRATING). */
export function isTerminalMountAwareState(state: unknown): boolean {
  return state === 'MOUNT_TIMEOUT' || state === 'POPULATED' || state === 'HYDRATED_EMPTY' || state === 'AMBIGUOUS' || state === 'INVALID';
}

// ---------------------------------------------------------------------------
// Download capture lifecycle (STEP-8FB).
//
// Productizes the Scene 5 manual capture: while the browser context is held alive,
// the exported file can materialize as a UUID-named `.tmp`/`.mp4` long after the
// download event. This pure helper classifies the single candidate's lifecycle so the
// browser loop only performs bounded, deterministic polling.
// ---------------------------------------------------------------------------

export type DownloadCaptureState =
  | 'WAITING'          // no new candidate yet (keep polling)
  | 'GROWING'          // candidate present but not yet size-stable
  | 'READY'            // exactly one stable, non-empty candidate → validate/promote
  | 'AMBIGUOUS'        // more than one stable candidate → fail closed
  | 'DEADLINE_EXCEEDED'; // bounded window expired with no ready candidate

/**
 * Classify the download capture lifecycle for one sweep.
 * `deadlineExceeded` is injected (no wall-clock here) so it is pure/testable.
 * `sightings`/`beforeNames` follow the same contract as {@link selectRecoverableDownload}.
 */
export function classifyDownloadCapture(
  sightings: unknown,
  beforeNames: unknown,
  deadlineExceeded: unknown,
): DownloadCaptureState {
  const pick = selectRecoverableDownload(sightings, beforeNames);
  if (pick.kind === 'ok') return 'READY';
  if (pick.kind === 'ambiguous') return 'AMBIGUOUS';
  // pending: distinguish "a new candidate exists but is still growing" from "nothing yet".
  const before = new Set((Array.isArray(beforeNames) ? beforeNames : []).map((n) => String(n ?? '')));
  const arr = Array.isArray(sightings) ? (sightings as DownloadCandidateSighting[]) : [];
  const hasGrowing = arr.some((s) => {
    if (!s || typeof s !== 'object') return false;
    const name = typeof s.name === 'string' ? s.name : '';
    if (!name || before.has(name) || !/\.(mp4|tmp)$/i.test(name)) return false;
    const size = Number(s.size);
    return Number.isFinite(size) && size > 0 && Number(s.stableHits) < 2;
  });
  if (hasGrowing) return 'GROWING';
  return deadlineExceeded === true ? 'DEADLINE_EXCEEDED' : 'WAITING';
}

// ---------------------------------------------------------------------------
// Post-mount settle gate for the FIRST authoritative read (STEP-8FB).
//
// 8FA/8EY left the attach helper's first read premature even after the 8EZ mount gate:
// the timeline was mounted but not yet settled, so the first authoritative observation
// could still see a transient zero. This gate requires a short, bounded post-mount
// settle tied to the proven mounted/visible condition BEFORE the first authoritative
// read is allowed. It never bypasses hydration classification and never turns a
// transient zero into success.
// ---------------------------------------------------------------------------

/**
 * Decide whether the first authoritative post-mount read may proceed.
 * - not mounted                         => false (keep waiting on the mount gate)
 * - mounted, settle window not elapsed => false (keep settling; bounded)
 * - mounted, settle window elapsed     => true  (proceed to hydration classification)
 * Pure: `postMountElapsedMs` / `settleMs` are injected.
 */
export function canTakeFirstAuthoritativeRead(input: {
  mounted?: unknown;
  postMountElapsedMs?: unknown;
  settleMs?: unknown;
} | undefined | null): boolean {
  if (!input || typeof input !== 'object') return false;
  if (input.mounted !== true) return false;
  const elapsed = Number(input.postMountElapsedMs);
  const settle = Number(input.settleMs);
  if (!Number.isFinite(elapsed) || !Number.isFinite(settle) || settle < 0) return false;
  return elapsed >= settle;
}

// ---------------------------------------------------------------------------
// HOSTED DOWNLOAD FLUSH phase (STEP-8FD).
//
// 8FC proved the exported file only becomes filesystem-visible while the browser
// page/context stays actively hosted; a pure filesystem poll during an idle context
// can miss it. This pure helper models the bounded phase machine so the browser loop
// stays deterministic/testable:
//
//   DOWNLOAD EVENT
//        ↓
//   WAITING            (no candidate yet, hosted flush not required/available)
//        ↓
//   HOSTED_FLUSH       (page/context kept alive with a harmless bounded tick)
//        ↓
//   FILESYSTEM_CAPTURE (existing bounded recovery poll)
//        ↓
//   GROWING → READY → VALIDATE → PROMOTE
// ---------------------------------------------------------------------------

export type DownloadFlushPhase = 'WAITING' | 'HOSTED_FLUSH' | 'FILESYSTEM_CAPTURE' | 'GROWING' | 'READY' | 'AMBIGUOUS' | 'DEADLINE_EXCEEDED';

/**
 * Decide the next hosted-flush phase from observed state. Pure/injected (no wall-clock).
 *
 * - a stable candidate exists                     => READY
 * - multiple stable candidates                    => AMBIGUOUS
 * - a growing candidate exists                    => GROWING (keep polling; hosting not needed)
 * - no candidate, download event fired, hosted
 *   flush window not yet elapsed                  => HOSTED_FLUSH (keep context alive)
 * - no candidate, hosted flush elapsed            => FILESYSTEM_CAPTURE (bounded recovery)
 * - no candidate, deadline elapsed                => DEADLINE_EXCEEDED
 */
export function classifyDownloadFlushPhase(input: {
  sightings?: unknown;
  beforeNames?: unknown;
  downloadEventFired?: unknown;
  hostedFlushElapsedMs?: unknown;
  hostedFlushMs?: unknown;
  deadlineExceeded?: unknown;
} | undefined | null): DownloadFlushPhase {
  if (!input || typeof input !== 'object') return 'DEADLINE_EXCEEDED';
  const capture = classifyDownloadCapture(input.sightings, input.beforeNames, input.deadlineExceeded);
  if (capture === 'READY') return 'READY';
  if (capture === 'AMBIGUOUS') return 'AMBIGUOUS';
  if (capture === 'GROWING') return 'GROWING';
  if (input.deadlineExceeded === true) return 'DEADLINE_EXCEEDED';
  // No candidate and nothing growing: choose hosted flush vs filesystem capture.
  const fired = input.downloadEventFired === true;
  const elapsed = Number(input.hostedFlushElapsedMs);
  const bound = Number(input.hostedFlushMs);
  if (fired && Number.isFinite(elapsed) && Number.isFinite(bound) && elapsed < bound) return 'HOSTED_FLUSH';
  return 'FILESYSTEM_CAPTURE';
}

/** True while the hosted flush should keep the page/context actively ticked. */
export function shouldContinueHostedFlush(input: {
  phase?: unknown;
  hostedFlushElapsedMs?: unknown;
  hostedFlushMs?: unknown;
} | undefined | null): boolean {
  if (!input || typeof input !== 'object') return false;
  if (input.phase !== 'HOSTED_FLUSH') return false;
  const elapsed = Number(input.hostedFlushElapsedMs);
  const bound = Number(input.hostedFlushMs);
  return Number.isFinite(elapsed) && Number.isFinite(bound) && elapsed < bound;
}

/** True when the bounded hosted flush has elapsed and filesystem capture must begin. */
export function shouldTransitionToFilesystemCapture(input: {
  downloadEventFired?: unknown;
  hostedFlushElapsedMs?: unknown;
  hostedFlushMs?: unknown;
  haveCandidate?: unknown;
} | undefined | null): boolean {
  if (!input || typeof input !== 'object') return true;
  if (input.haveCandidate === true) return false;
  if (input.downloadEventFired !== true) return true;
  const elapsed = Number(input.hostedFlushElapsedMs);
  const bound = Number(input.hostedFlushMs);
  if (!Number.isFinite(elapsed) || !Number.isFinite(bound)) return true;
  return elapsed >= bound;
}

// ---------------------------------------------------------------------------
// Attach first-read MOUNT-SURFACE gate (STEP-8FD).
//
// 8FC showed attachFirstClipByArtifactId still raced the freshly navigated scene even
// though waitForHydratedTimelineEvidence itself is mount/settle aware. This gate makes
// the attach helper wait for the scene timeline SURFACE (flow-scene-timeline laid out
// with .timeline-contents) BEFORE its first hydration read. It never classifies a
// pre-mount zero as empty and never depends on a fixed delay alone.
// ---------------------------------------------------------------------------

/**
 * Decide the attach first-read surface readiness.
 * - surface not visible/mounted         => 'WAIT'
 * - surface mounted, settle incomplete  => 'SETTLE'
 * - surface mounted, settle complete    => 'READ'
 * - surface never mounts within bound   => 'SURFACE_TIMEOUT' (bounded failure, not empty)
 * Pure: all timings injected.
 */
export function classifyAttachSurfaceReadiness(input: {
  surfaceVisible?: unknown;
  surfaceMounted?: unknown;
  elapsedMs?: unknown;
  timeoutMs?: unknown;
  postMountElapsedMs?: unknown;
  settleMs?: unknown;
} | undefined | null): 'WAIT' | 'SETTLE' | 'READ' | 'SURFACE_TIMEOUT' {
  if (!input || typeof input !== 'object') return 'SURFACE_TIMEOUT';
  const elapsed = Number(input.elapsedMs);
  const bound = Number(input.timeoutMs);
  if (input.surfaceVisible !== true || input.surfaceMounted !== true) {
    if (Number.isFinite(elapsed) && Number.isFinite(bound) && elapsed >= bound) return 'SURFACE_TIMEOUT';
    return 'WAIT';
  }
  const pm = Number(input.postMountElapsedMs);
  const settle = Number(input.settleMs);
  if (!Number.isFinite(pm) || !Number.isFinite(settle) || pm < settle) return 'SETTLE';
  return 'READ';
}

// ---------------------------------------------------------------------------
// browser Download-object transport (STEP-8FW).
//
// 8FV forensic proved the Flow export is delivered as a real browser Download
// object (`download-fired`, saveAs/createReadStream available) and that `download.path()`
// fails only because Flow tears the page down on the event. The correct transport is to
// CAPTURE the Download object and call `saveAs()` while the context is still alive — never
// to wait for a browser/OS filesystem file in ~/Downloads (which never appears).
//
// These pure helpers classify the transport decision + result, so the browser code stays
// thin and testable.
// ---------------------------------------------------------------------------

export type DownloadTransport = 'DOWNLOAD_OBJECT' | 'FILESYSTEM_FALLBACK' | 'NONE';

/**
 * Decide how a clip was (or will be) transported to a local file.
 * - a browser Download object was captured → DOWNLOAD_OBJECT
 * - no object, but a stable filesystem candidate exists → FILESYSTEM_FALLBACK
 * - neither → NONE
 */
export function classifyDownloadTransport(input: { downloadObjectReceived?: unknown; filesystemCandidatePresent?: unknown } | undefined | null): DownloadTransport {
  if (!input || typeof input !== 'object') return 'NONE';
  if (input.downloadObjectReceived === true) return 'DOWNLOAD_OBJECT';
  if (input.filesystemCandidatePresent === true) return 'FILESYSTEM_FALLBACK';
  return 'NONE';
}

/**
 * Map a transport + validation + promotion outcome to the existing ClipDownloadResult codes.
 * Reuses established terminology; introduces no new codes.
 */
export function classifyDownloadOutcome(input: {
  downloadObjectReceived?: unknown;
  savedOk?: unknown;
  validationOk?: unknown;
  promotionOk?: unknown;
} | undefined | null): 'DOWNLOAD_SUCCESS' | 'DOWNLOAD_WRITE_FAILED' | 'INVALID_DOWNLOADED_FILE' | 'DOWNLOAD_EVENT_TIMEOUT' {
  if (!input || typeof input !== 'object') return 'DOWNLOAD_EVENT_TIMEOUT';
  if (input.savedOk !== true) return input.downloadObjectReceived === true ? 'DOWNLOAD_WRITE_FAILED' : 'DOWNLOAD_EVENT_TIMEOUT';
  if (input.validationOk !== true) return 'INVALID_DOWNLOADED_FILE';
  if (input.promotionOk !== true) return 'DOWNLOAD_WRITE_FAILED';
  return 'DOWNLOAD_SUCCESS';
}

/** Safe diagnostic descriptor for a captured Download object (never includes secrets). */
export function downloadObjectDiagnostic(download: { suggestedFilename?: unknown } | undefined | null): { suggestedFilename: string | null } {
  const s = download && typeof download.suggestedFilename === 'function' ? download.suggestedFilename() : (download as any)?.suggestedFilename;
  const name = typeof s === 'string' ? s.trim() : '';
  return { suggestedFilename: name || null };
}
