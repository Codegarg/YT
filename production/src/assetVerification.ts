/**
 * Flow-native asset lock verification.
 *
 * PURPOSE
 * -------
 * `assertSceneAssetsLocked()` (runner.ts) refuses to generate any scene until every referenced
 * character/background is `locked: true`. That flag is the production contract for "this exact
 * asset provably exists in the Flow project, so a scene may reference it". Historically it was set
 * as a side effect of creating the asset in Flow. For assets that already exist (or were supplied
 * out of band), there was previously NO way to establish the lock from evidence — which meant the
 * only options were to regenerate (spend credits) or to hand-edit pipeline.json (fabricate state).
 * Both are unacceptable.
 *
 * This module provides the missing third option: a READ-ONLY verification that the exact pipeline
 * tag exists on the Flow asset surface, followed by persistence of the lock ONLY when verification
 * genuinely succeeds.
 *
 * FAIL-CLOSED CONTRACT
 * --------------------
 *   · Identity is EXACT. A required tag matches a visible Flow name only when their canonical
 *     forms are byte-identical. No substring, prefix, case-folding or fuzzy matching.
 *   · Zero matches  → MISSING (cannot lock).
 *   · Two+ matches  → AMBIGUOUS (cannot lock; an arbitrary asset is never chosen).
 *   · Any failure to READ the surface → cannot lock (never treated as "no assets").
 *   · Nothing is ever generated, downloaded or mutated by verification itself.
 *
 * This module never weakens `assertSceneAssetsLocked()`: it only supplies a legitimate way for the
 * lock to become true, backed by observed evidence.
 */

/** Which Flow asset surface a tag belongs to. */
export type AssetKind = 'character' | 'background';

/**
 * Canonical, exact identity for a Flow tile name.
 *
 * The pipeline tag carries a leading sigil (`@` for characters, `#` for backgrounds) that was used
 * verbatim when the asset was named in Flow. A single leading sigil of the CORRECT kind is stripped
 * so a tag and a Flow name that differ only by that sigil still compare equal. Nothing else is
 * normalised: no case-folding, no internal whitespace collapsing, no suffix handling.
 */
export function canonicalAssetName(kind: AssetKind, raw: unknown): string {
  let s = String(raw ?? '').trim();
  const sigil = kind === 'character' ? '@' : '#';
  if (s.startsWith(sigil)) s = s.slice(1);
  return s.trim();
}

export interface RequiredFlowAssets {
  characters: readonly string[];
  backgrounds: readonly string[];
}

export interface FlowVisibleAssets {
  characters: readonly string[];
  backgrounds: readonly string[];
}

export interface AssetVerificationInput {
  required: RequiredFlowAssets;
  visible: FlowVisibleAssets;
  /**
   * Was the Flow asset surface actually READ? `false` means the read failed/was unavailable. A
   * failed read must NEVER be mistaken for "the project has no assets".
   */
  readOk: boolean;
  /** Optional reason to surface when `readOk` is false. */
  readReason?: string;
}

export interface AssetConflict {
  kind: AssetKind;
  tag: string;
  candidates: string[];
}

export interface AssetVerificationResult {
  ok: boolean;
  verifiedCharacters: string[];
  verifiedBackgrounds: string[];
  missing: Array<{ kind: AssetKind; tag: string }>;
  ambiguous: AssetConflict[];
  reason?: string;
}

interface SurfaceDecision {
  verified: string[];
  missing: string[];
  ambiguous: AssetConflict[];
}

/** Pure per-surface decision. Exact canonical match; fail closed on 0 or >1 matches. */
function decideSurface(kind: AssetKind, required: readonly string[], visible: readonly string[]): SurfaceDecision {
  const visibleCanonical = visible.map((v) => canonicalAssetName(kind, v)).filter((v) => v.length > 0);
  const counts = new Map<string, number>();
  for (const name of visibleCanonical) counts.set(name, (counts.get(name) ?? 0) + 1);

  const verified: string[] = [];
  const missing: string[] = [];
  const ambiguous: AssetConflict[] = [];
  for (const rawTag of required) {
    const tag = String(rawTag ?? '').trim();
    if (!tag) { missing.push(''); continue; }
    const key = canonicalAssetName(kind, tag);
    const hits = counts.get(key) ?? 0;
    if (hits === 1) verified.push(tag);
    else if (hits === 0) missing.push(tag);
    else ambiguous.push({ kind, tag, candidates: visibleCanonical.filter((v) => v === key) });
  }
  return { verified, missing, ambiguous };
}

/**
 * PURE, deterministic, fail-closed. Decide whether every required asset can be safely locked from
 * the observed Flow surface.
 */
export function verifyAssetLocks(input: AssetVerificationInput): AssetVerificationResult {
  if (!input.readOk) {
    return {
      ok: false, verifiedCharacters: [], verifiedBackgrounds: [],
      missing: [], ambiguous: [],
      reason: `Flow asset surface could not be read${input.readReason ? `: ${input.readReason}` : ''}; refusing to lock.`,
    };
  }
  const chars = decideSurface('character', input.required.characters, input.visible.characters);
  const bgs = decideSurface('background', input.required.backgrounds, input.visible.backgrounds);
  const missing = [
    ...chars.missing.map((tag) => ({ kind: 'character' as const, tag })),
    ...bgs.missing.map((tag) => ({ kind: 'background' as const, tag })),
  ];
  const ambiguous = [...chars.ambiguous, ...bgs.ambiguous];
  const ok = missing.length === 0 && ambiguous.length === 0;
  return {
    ok,
    verifiedCharacters: chars.verified,
    verifiedBackgrounds: bgs.verified,
    missing,
    ambiguous,
    reason: ok ? undefined
      : ambiguous.length > 0
        ? `Refusing to lock: ${ambiguous.length} asset tag(s) matched multiple Flow tiles.`
        : `Refusing to lock: ${missing.length} asset tag(s) not found on the Flow surface.`,
  };
}

// ---------------------------------------------------------------------------------------
// Read-only Flow reader (injectable; owns no browser lifecycle)
// ---------------------------------------------------------------------------------------

export interface FlowAssetSurface {
  /** Exact names of the project's Flow character tiles. */
  listCharacterNames?: () => Promise<readonly string[]>;
  /** Exact names (aria-labels) of the project's Flow image/background tiles. */
  listImageNames?: () => Promise<readonly string[]>;
}

export interface FlowAssetRead {
  ok: boolean;
  characters: string[];
  backgrounds: string[];
  reason?: string;
}

/**
 * Read the project's Flow asset surfaces. STRICTLY read-only: it never clicks a generation control,
 * never uploads, never downloads and never mutates Flow. Any missing reader or thrown error fails
 * closed (ok:false) rather than being reported as an empty project.
 */
export async function readFlowProjectAssets(flow: FlowAssetSurface | null | undefined): Promise<FlowAssetRead> {
  if (!flow || typeof flow.listCharacterNames !== 'function' || typeof flow.listImageNames !== 'function') {
    return { ok: false, characters: [], backgrounds: [], reason: 'Flow client does not expose the read-only asset listing surface.' };
  }
  try {
    const characters = (await flow.listCharacterNames()).map((n) => String(n ?? '').trim()).filter(Boolean);
    const backgrounds = (await flow.listImageNames()).map((n) => String(n ?? '').trim()).filter(Boolean);
    // A surface that yields NO identity at all was never actually OBSERVED (e.g. the project grid
    // has not hydrated, or the reader ran on the wrong route). Reporting `ok:true` with two empty
    // lists would assert "this project has no assets" from an unread page, so it fails closed.
    if (characters.length === 0 && backgrounds.length === 0) {
      return { ok: false, characters: [], backgrounds: [], reason: 'Flow project asset surface produced no asset identities; the surface was not observed.' };
    }
    return { ok: true, characters, backgrounds };
  } catch (e: any) {
    return { ok: false, characters: [], backgrounds: [], reason: `Flow asset surface read failed: ${String(e?.message ?? e).slice(0, 160)}` };
  }
}

/**
 * Read + verify in one read-only step. Convenience for callers that do not need the raw surface.
 */
export async function verifyFlowProjectAssets(
  flow: FlowAssetSurface | null | undefined,
  required: RequiredFlowAssets,
): Promise<AssetVerificationResult> {
  const read = await readFlowProjectAssets(flow);
  return verifyAssetLocks({ required, visible: { characters: read.characters, backgrounds: read.backgrounds }, readOk: read.ok, readReason: read.reason });
}

// ---------------------------------------------------------------------------------------
// Read-only SCENE-SURFACE reader (the surface where asset identities are actually observable)
// ---------------------------------------------------------------------------------------

/**
 * The scene-editor surface on which Flow asset identities were live-proven observable:
 * background identities from the navigation rail, character identities from the Characters picker.
 */
export interface FlowSceneAssetSurface {
  /** Stable rail asset TAGS (aria-labels), e.g. `#BGD-01-ARJUN-ROOM-WIDE`. */
  listRailAssetTags?: () => Promise<readonly string[]>;
  /** Stable Characters-picker row TITLES, e.g. `@CHAR-01-ARJUN`. NEVER `/asb/` tokens. */
  listCharacterPickerTags?: () => Promise<readonly string[]>;
}

/**
 * READ-ONLY: read the project's asset identities from the scene/editor surface.
 *
 * WHY A SEPARATE SURFACE (live evidence): on a freshly loaded PROJECT route the grid readers
 * (`listCharacterNames()` / `listImageNames()`) returned two empty lists with no error, so the
 * asset gate could never see the 11 required tags. On a scene route the same identities were
 * observable: the rail exposed every `#BGD-*` tag and the Characters picker exposed every
 * `@CHAR-*` title. This reader therefore reads THAT surface.
 *
 * IDENTITY RULES: only STABLE TAGS are used. Picker `/asb/` tokens, chip tokens and generation
 * UUIDs are session/transient identities and are never read, returned or persisted here.
 *
 * FAIL-CLOSED: `ok` is true only when at least one surface was genuinely observed. A missing
 * reader, a thrown read, or two empty surfaces all return `ok:false`, so an unreadable surface is
 * never reported as "the project has no assets".
 */
export async function readFlowSceneSurfaceAssets(flow: FlowSceneAssetSurface | null | undefined): Promise<FlowAssetRead> {
  if (!flow || typeof flow.listRailAssetTags !== 'function' || typeof flow.listCharacterPickerTags !== 'function') {
    return { ok: false, characters: [], backgrounds: [], reason: 'Flow client does not expose the read-only scene asset surface (rail tags + character picker tags).' };
  }
  let railTags: string[] = [];
  let pickerTags: string[] = [];
  try { railTags = (await flow.listRailAssetTags()).map((t) => String(t ?? '').trim()).filter(Boolean); }
  catch (e: any) { return { ok: false, characters: [], backgrounds: [], reason: `Flow scene rail read failed: ${String(e?.message ?? e).slice(0, 160)}` }; }
  try { pickerTags = (await flow.listCharacterPickerTags()).map((t) => String(t ?? '').trim()).filter(Boolean); }
  catch (e: any) { return { ok: false, characters: [], backgrounds: [], reason: `Flow character picker read failed: ${String(e?.message ?? e).slice(0, 160)}` }; }
  if (railTags.length === 0 && pickerTags.length === 0) {
    return { ok: false, characters: [], backgrounds: [], reason: 'Flow scene asset surface produced no asset identities; the surface was not observed.' };
  }
  // Background identities come from the stable rail TAGS; character identities come from the
  // stable picker TITLES. The two surfaces are never mixed.
  return { ok: true, characters: pickerTags, backgrounds: railTags };
}

/** Read + verify the scene surface in one read-only step. */
export async function verifyFlowSceneSurfaceAssets(
  flow: FlowSceneAssetSurface | null | undefined,
  required: RequiredFlowAssets,
): Promise<AssetVerificationResult> {
  const read = await readFlowSceneSurfaceAssets(flow);
  return verifyAssetLocks({ required, visible: { characters: read.characters, backgrounds: read.backgrounds }, readOk: read.ok, readReason: read.reason });
}

/**
 * Read-only resolution of WHICH canonical scene surface exposes the project's asset identities.
 * Prefers an explicitly known scene id; otherwise the first scene already discoverable in the
 * project. Returns '' when no scene can be resolved so the caller FAILS CLOSED instead of inventing
 * a surface. NEVER creates a scene.
 */
export async function resolveAssetVerificationSceneId(
  flow: { listSceneIds?: () => Promise<readonly string[]> } | null | undefined,
  preferredSceneId?: unknown,
): Promise<string> {
  const preferred = String(preferredSceneId ?? '').trim();
  if (preferred) return preferred;
  if (!flow || typeof flow.listSceneIds !== 'function') return '';
  try {
    const ids = (await flow.listSceneIds()).map((id) => String(id ?? '').trim()).filter(Boolean);
    return ids[0] ?? '';
  } catch { return ''; }
}

// ---------------------------------------------------------------------------------------
// Lock persistence planning (pure) — applied ONLY after a successful verification
// ---------------------------------------------------------------------------------------

export interface AssetLockPlan {
  /** Pipeline character tags whose lock should be set true. */
  lockCharacters: string[];
  /** Pipeline background tags whose lock should be set true. */
  lockBackgrounds: string[];
  /** True when at least one asset still needs its lock persisted. */
  changed: boolean;
}

function findAsset(list: readonly any[], kind: AssetKind, tag: string): any | undefined {
  const key = canonicalAssetName(kind, tag);
  return list.find((a) => canonicalAssetName(kind, a?.tag) === key);
}

/**
 * PURE: from a SUCCESSFUL verification result, plan which pipeline assets to lock.
 * Never plans anything for an unsuccessful result. Tags already locked are omitted (idempotent).
 */
export function planAssetLockPersistence(pipeline: { characters?: any[]; backgrounds?: any[] }, result: AssetVerificationResult): AssetLockPlan {
  if (!result.ok) return { lockCharacters: [], lockBackgrounds: [], changed: false };
  const characters = Array.isArray(pipeline?.characters) ? pipeline.characters : [];
  const backgrounds = Array.isArray(pipeline?.backgrounds) ? pipeline.backgrounds : [];
  const lockCharacters = result.verifiedCharacters.filter((tag) => {
    const asset = findAsset(characters, 'character', tag);
    return !!asset && asset.locked !== true;
  });
  const lockBackgrounds = result.verifiedBackgrounds.filter((tag) => {
    const asset = findAsset(backgrounds, 'background', tag);
    return !!asset && asset.locked !== true;
  });
  return { lockCharacters, lockBackgrounds, changed: lockCharacters.length > 0 || lockBackgrounds.length > 0 };
}

/**
 * Apply a lock plan to an ALREADY-VERIFIED pipeline object in place.
 *
 * A verified asset is marked `locked: true` (the gate contract) and `status: 'done'` (so the
 * existing resumable runner skips regenerating an asset that provably already exists). Returns the
 * tags actually changed. This function must only ever be called with a plan produced by
 * `planAssetLockPersistence` for an `ok` verification result.
 */
export function applyAssetLockPlan(pipeline: { characters?: any[]; backgrounds?: any[] }, plan: AssetLockPlan): { lockedCharacters: string[]; lockedBackgrounds: string[] } {
  const characters = Array.isArray(pipeline?.characters) ? pipeline.characters : [];
  const backgrounds = Array.isArray(pipeline?.backgrounds) ? pipeline.backgrounds : [];
  const lockedCharacters: string[] = [];
  const lockedBackgrounds: string[] = [];
  for (const tag of plan.lockCharacters) {
    const asset = findAsset(characters, 'character', tag);
    if (asset && asset.locked !== true) { asset.locked = true; asset.status = 'done'; asset.updated_at = new Date().toISOString(); lockedCharacters.push(asset.tag); }
  }
  for (const tag of plan.lockBackgrounds) {
    const asset = findAsset(backgrounds, 'background', tag);
    if (asset && asset.locked !== true) { asset.locked = true; asset.status = 'done'; asset.updated_at = new Date().toISOString(); lockedBackgrounds.push(asset.tag); }
  }
  return { lockedCharacters, lockedBackgrounds };
}

/** The exact asset tags a project's scenes require, in stable first-seen order. */
export function requiredAssetsForScenes(scenes: readonly any[]): RequiredFlowAssets {
  const characters: string[] = [];
  const backgrounds: string[] = [];
  const seenC = new Set<string>(), seenB = new Set<string>();
  for (const s of scenes ?? []) {
    const bg = String(s?.background_tag ?? s?.assets?.background_tag ?? '').trim();
    if (bg && !seenB.has(bg)) { seenB.add(bg); backgrounds.push(bg); }
    const tags = Array.isArray(s?.character_tags) ? s.character_tags : (s?.assets?.character_tags ?? []);
    for (const t of tags) { const tag = String(t ?? '').trim(); if (tag && !seenC.has(tag)) { seenC.add(tag); characters.push(tag); } }
  }
  return { characters, backgrounds };
}
