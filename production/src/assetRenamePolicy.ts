/**
 * PURE exact-target policy for renaming EXISTING Flow assets.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The legacy background rename silently fell back to the first image tile when the requested
 * current name was not found. The generated-character rename likewise fell back to the first
 * character tile when no untitled tile was present. Both behaviours can rename the WRONG asset.
 *
 * This module makes the target decision explicit and fail-closed. It is intentionally browser-free:
 * callers observe the tile labels from Flow, pass them here, and only mutate when this module
 * returns a RENAME/SKIP decision. No stable Flow asset id is invented.
 *
 * IDENTITY LIMIT
 * --------------
 * Flow's grid rows expose title text, not a stable asset id. The strongest available evidence for
 * an existing tile is therefore:
 *   1. an exact, unique current title before mutation; and
 *   2. the SAME tile reading back the exact target title afterwards, with the target title unique
 *      across the surface and the old title gone.
 *
 * A target title alone is NOT proof that the intended tile changed.
 */

export type FlowAssetRenameErrorCode =
  | 'BACKGROUND_TARGET_INVALID'
  | 'BACKGROUND_CURRENT_TARGET_MISSING'
  | 'BACKGROUND_CURRENT_TARGET_AMBIGUOUS'
  | 'BACKGROUND_TARGET_ALREADY_EXISTS'
  | 'BACKGROUND_TARGET_AMBIGUOUS'
  | 'BACKGROUND_GENERATED_TARGET_NOT_FOUND'
  | 'BACKGROUND_RENAME_VERIFICATION_FAILED'
  | 'BACKGROUND_RENAME_WRONG_TILE'
  | 'BACKGROUND_RENAME_PERSISTENCE_FAILED'
  | 'BACKGROUND_RENAME_PERSISTENCE_UNVERIFIABLE'
  | 'CHARACTER_TARGET_INVALID'
  | 'CHARACTER_CURRENT_TARGET_MISSING'
  | 'CHARACTER_CURRENT_TARGET_AMBIGUOUS'
  | 'CHARACTER_TARGET_ALREADY_EXISTS'
  | 'CHARACTER_TARGET_AMBIGUOUS'
  | 'CHARACTER_GENERATED_TARGET_NOT_FOUND'
  | 'CHARACTER_GENERATED_TARGET_AMBIGUOUS'
  | 'CHARACTER_RENAME_VERIFICATION_FAILED'
  | 'CHARACTER_RENAME_WRONG_TILE'
  | 'CHARACTER_RENAME_PERSISTENCE_FAILED'
  | 'CHARACTER_RENAME_PERSISTENCE_UNVERIFIABLE';

/** Typed, fail-closed rename refusal. Thrown BEFORE any Flow mutation. */
export class FlowAssetRenameError extends Error {
  readonly name = 'FlowAssetRenameError';
  constructor(
    readonly code: FlowAssetRenameErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export type RenameAction = 'RENAME' | 'RENAME_GENERATED' | 'SKIP';

export interface RenameDecision {
  ok: true;
  action: RenameAction;
  /** Index into the SAME tile list whose labels were observed. */
  index: number;
  currentName: string;
  targetName: string;
}

export interface RenameRefusal {
  ok: false;
  code: FlowAssetRenameErrorCode;
  reason: string;
  detail?: Record<string, unknown>;
}

export type RenameTargetDecision = RenameDecision | RenameRefusal;

const normalizeNames = (names: readonly unknown[] | null | undefined): string[] =>
  (Array.isArray(names) ? names : []).map((n) => String(n ?? '').trim());

const unreadableReason = (read: { ok: true; names: readonly unknown[] } | { ok: false; reason: string } | null | undefined): string | null =>
  read && read.ok === false ? read.reason : null;

const fail = (code: FlowAssetRenameErrorCode, reason: string, detail?: Record<string, unknown>): RenameRefusal =>
  ({ ok: false, code, reason, ...(detail ? { detail } : {}) });

const hits = (names: readonly string[], wanted: string): number[] => {
  const out: number[] = [];
  if (!wanted) return out;
  for (let i = 0; i < names.length; i++) if (names[i] === wanted) out.push(i);
  return out;
};

interface ExactCodes {
  invalid: FlowAssetRenameErrorCode;
  missing: FlowAssetRenameErrorCode;
  ambiguousCurrent: FlowAssetRenameErrorCode;
  ambiguousTarget: FlowAssetRenameErrorCode;
  targetExists: FlowAssetRenameErrorCode;
}

function decideExactRename(input: {
  targetName: unknown;
  currentName: unknown;
  observedNames: readonly unknown[] | null | undefined;
  codes: ExactCodes;
  assetLabel: string;
}): RenameTargetDecision {
  const targetName = String(input.targetName ?? '').trim();
  const currentName = String(input.currentName ?? '').trim();
  const names = normalizeNames(input.observedNames);

  if (!targetName) return fail(input.codes.invalid, `${input.assetLabel} rename refused: target name is empty.`);
  if (!currentName) return fail(input.codes.missing, `${input.assetLabel} rename refused: an exact current name is required; no tile can be selected without it.`);

  const currentHits = hits(names, currentName);
  if (currentHits.length === 0) {
    return fail(
      input.codes.missing,
      `${input.assetLabel} rename refused: no tile has the exact current name ${JSON.stringify(currentName)}; refusing to fall back to another tile.`,
      { currentName, observedNames: names },
    );
  }
  if (currentHits.length > 1) {
    return fail(
      input.codes.ambiguousCurrent,
      `${input.assetLabel} rename refused: ${currentHits.length} tiles have the exact current name ${JSON.stringify(currentName)}.`,
      { currentName, matches: currentHits, observedNames: names },
    );
  }

  const targetHits = hits(names, targetName);
  if (targetHits.length > 1) {
    return fail(
      input.codes.ambiguousTarget,
      `${input.assetLabel} rename refused: the target name ${JSON.stringify(targetName)} already exists on ${targetHits.length} tiles.`,
      { targetName, matches: targetHits, observedNames: names },
    );
  }
  if (targetHits.length === 1) {
    if (targetHits[0] === currentHits[0] && currentName === targetName) {
      return { ok: true, action: 'SKIP', index: currentHits[0], currentName, targetName };
    }
    return fail(
      input.codes.targetExists,
      `${input.assetLabel} rename refused: a different tile already has the target name ${JSON.stringify(targetName)}.`,
      { targetName, currentName, targetIndex: targetHits[0], currentIndex: currentHits[0] },
    );
  }

  return { ok: true, action: 'RENAME', index: currentHits[0], currentName, targetName };
}

/**
 * Existing background/image tile. When `currentName` is supplied, exactly one tile must carry it.
 * No fallback to the first image tile is permitted.
 *
 * With no `currentName`, the caller is on the immediate post-generation path. That path keeps the
 * existing "first image tile is the just-generated tile" contract, but it still refuses duplicate
 * targets and never falls back from a supplied current name.
 */
export function decideBackgroundRenameTarget(input: {
  targetName?: unknown;
  currentName?: unknown;
  observedNames?: readonly unknown[] | null;
} | null | undefined): RenameTargetDecision {
  const targetName = String(input?.targetName ?? '').trim();
  const currentName = String(input?.currentName ?? '').trim();
  const names = normalizeNames(input?.observedNames);
  const hasExplicitCurrent = input?.currentName !== undefined && input?.currentName !== null;

  if (!targetName) return fail('BACKGROUND_TARGET_INVALID', 'Background rename refused: target name is empty.');

  if (hasExplicitCurrent) {
    if (!currentName) {
      return fail(
        'BACKGROUND_CURRENT_TARGET_MISSING',
        'Background rename refused: an explicit current name was supplied but is empty; refusing to fall back to the first image tile.',
        { observedNames: names },
      );
    }
    return decideExactRename({
      targetName,
      currentName,
      observedNames: names,
      assetLabel: 'Background',
      codes: {
        invalid: 'BACKGROUND_TARGET_INVALID',
        missing: 'BACKGROUND_CURRENT_TARGET_MISSING',
        ambiguousCurrent: 'BACKGROUND_CURRENT_TARGET_AMBIGUOUS',
        ambiguousTarget: 'BACKGROUND_TARGET_AMBIGUOUS',
        targetExists: 'BACKGROUND_TARGET_ALREADY_EXISTS',
      },
    });
  }

  // Immediate post-generation path (legacy caller compatibility): the newest image tile is first.
  if (names.length === 0) {
    return fail(
      'BACKGROUND_GENERATED_TARGET_NOT_FOUND',
      `Background rename refused: no image tile is observable to rename to ${JSON.stringify(targetName)}.`,
    );
  }
  const targetHits = hits(names, targetName);
  if (targetHits.length > 1) {
    return fail(
      'BACKGROUND_TARGET_AMBIGUOUS',
      `Background rename refused: the target name ${JSON.stringify(targetName)} already exists on ${targetHits.length} tiles.`,
      { targetName, matches: targetHits, observedNames: names },
    );
  }
  if (targetHits.length === 1) {
    if (targetHits[0] === 0) {
      return { ok: true, action: 'SKIP', index: 0, currentName: names[0] ?? '', targetName };
    }
    return fail(
      'BACKGROUND_TARGET_ALREADY_EXISTS',
      `Background rename refused: a different tile already has the target name ${JSON.stringify(targetName)}.`,
      { targetName, targetIndex: targetHits[0], observedNames: names },
    );
  }
  return { ok: true, action: 'RENAME_GENERATED', index: 0, currentName: names[0] ?? '', targetName };
}

/** Flow's freshly generated character label. */
export function isUntitledCharacterLabel(name: unknown): boolean {
  return /untitled character/i.test(String(name ?? ''));
}

/** Existing named character tile. Exact unique current title required; no first/untitled fallback. */
export function decideCharacterRenameTarget(input: {
  targetName?: unknown;
  currentName?: unknown;
  observedNames?: readonly unknown[] | null;
} | null | undefined): RenameTargetDecision {
  return decideExactRename({
    targetName: input?.targetName,
    currentName: input?.currentName,
    observedNames: input?.observedNames,
    assetLabel: 'Character',
    codes: {
      invalid: 'CHARACTER_TARGET_INVALID',
      missing: 'CHARACTER_CURRENT_TARGET_MISSING',
      ambiguousCurrent: 'CHARACTER_CURRENT_TARGET_AMBIGUOUS',
      ambiguousTarget: 'CHARACTER_TARGET_AMBIGUOUS',
      targetExists: 'CHARACTER_TARGET_ALREADY_EXISTS',
    },
  });
}

/**
 * Generated-character flow: exactly one "Untitled character" tile must be observable. If there are
 * zero or multiple untitled tiles, refuse. It never falls back to the first named character.
 */
export function decideGeneratedCharacterRenameTarget(input: {
  targetName?: unknown;
  observedNames?: readonly unknown[] | null;
} | null | undefined): RenameTargetDecision {
  const targetName = String(input?.targetName ?? '').trim();
  const names = normalizeNames(input?.observedNames);
  if (!targetName) return fail('CHARACTER_TARGET_INVALID', 'Character rename refused: target name is empty.');

  const targetHits = hits(names, targetName);
  if (targetHits.length > 1) {
    return fail(
      'CHARACTER_TARGET_AMBIGUOUS',
      `Character rename refused: the target name ${JSON.stringify(targetName)} already exists on ${targetHits.length} tiles.`,
      { targetName, matches: targetHits, observedNames: names },
    );
  }
  if (targetHits.length === 1) {
    return fail(
      'CHARACTER_TARGET_ALREADY_EXISTS',
      `Character rename refused: a character tile already has the target name ${JSON.stringify(targetName)}.`,
      { targetName, targetIndex: targetHits[0], observedNames: names },
    );
  }

  const untitled = names.map((n, i) => (isUntitledCharacterLabel(n) ? i : -1)).filter((i) => i >= 0);
  if (untitled.length === 0) {
    return fail(
      'CHARACTER_GENERATED_TARGET_NOT_FOUND',
      'Character rename refused: no unique untitled generated character is observable; refusing the first-character fallback.',
      { observedNames: names },
    );
  }
  if (untitled.length > 1) {
    return fail(
      'CHARACTER_GENERATED_TARGET_AMBIGUOUS',
      `Character rename refused: ${untitled.length} untitled character tiles are observable; cannot identify the newly generated one.`,
      { matches: untitled, observedNames: names },
    );
  }
  return { ok: true, action: 'RENAME_GENERATED', index: untitled[0], currentName: names[untitled[0]] ?? '', targetName };
}

export type RenameOutcome =
  | { ok: true; targetName: string }
  | { ok: false; code: FlowAssetRenameErrorCode; reason: string };

function verifyOutcome(input: {
  targetName: unknown;
  expectedCurrentName?: unknown;
  observedNamesAfter?: readonly unknown[] | null;
  intendedTileLabel?: unknown;
  assetLabel: string;
  verificationCode: FlowAssetRenameErrorCode;
  wrongTileCode: FlowAssetRenameErrorCode;
  ambiguousCode: FlowAssetRenameErrorCode;
}): RenameOutcome {
  const targetName = String(input.targetName ?? '').trim();
  const expectedCurrent = String(input.expectedCurrentName ?? '').trim();
  const names = normalizeNames(input.observedNamesAfter);
  const intended = String(input.intendedTileLabel ?? '').trim();

  if (!targetName) return { ok: false, code: input.verificationCode, reason: `${input.assetLabel} rename verification failed: target name is empty.` };
  if (intended !== targetName) {
    return {
      ok: false,
      code: input.wrongTileCode,
      reason: `${input.assetLabel} rename verification failed: the intended tile reads ${JSON.stringify(intended)} instead of ${JSON.stringify(targetName)}.`,
    };
  }

  const targetHits = hits(names, targetName);
  if (targetHits.length === 0) {
    return { ok: false, code: input.verificationCode, reason: `${input.assetLabel} rename verification failed: the target name ${JSON.stringify(targetName)} is not observable afterwards.` };
  }
  if (targetHits.length > 1) {
    return { ok: false, code: input.ambiguousCode, reason: `${input.assetLabel} rename verification failed: ${targetHits.length} tiles now carry the target name ${JSON.stringify(targetName)}.` };
  }
  if (expectedCurrent && expectedCurrent !== targetName && names.includes(expectedCurrent)) {
    return { ok: false, code: input.verificationCode, reason: `${input.assetLabel} rename verification failed: the old title ${JSON.stringify(expectedCurrent)} is still observable.` };
  }
  return { ok: true, targetName };
}

/** Post-mutation check: same intended tile reads the exact target; target is unique; old title gone. */
export function verifyBackgroundRenameOutcome(input: {
  targetName?: unknown;
  expectedCurrentName?: unknown;
  observedNamesAfter?: readonly unknown[] | null;
  intendedTileLabel?: unknown;
} | null | undefined): RenameOutcome {
  return verifyOutcome({
    targetName: input?.targetName,
    expectedCurrentName: input?.expectedCurrentName,
    observedNamesAfter: input?.observedNamesAfter,
    intendedTileLabel: input?.intendedTileLabel,
    assetLabel: 'Background',
    verificationCode: 'BACKGROUND_RENAME_VERIFICATION_FAILED',
    wrongTileCode: 'BACKGROUND_RENAME_WRONG_TILE',
    ambiguousCode: 'BACKGROUND_TARGET_AMBIGUOUS',
  });
}

/** Post-mutation check for characters, using exact `span.character-tile-name` titles. */
export function verifyCharacterRenameOutcome(input: {
  targetName?: unknown;
  expectedCurrentName?: unknown;
  observedNamesAfter?: readonly unknown[] | null;
  intendedTileLabel?: unknown;
} | null | undefined): RenameOutcome {
  return verifyOutcome({
    targetName: input?.targetName,
    expectedCurrentName: input?.expectedCurrentName,
    observedNamesAfter: input?.observedNamesAfter,
    intendedTileLabel: input?.intendedTileLabel,
    assetLabel: 'Character',
    verificationCode: 'CHARACTER_RENAME_VERIFICATION_FAILED',
    wrongTileCode: 'CHARACTER_RENAME_WRONG_TILE',
    ambiguousCode: 'CHARACTER_TARGET_AMBIGUOUS',
  });
}

// =====================================================================================
// DURABLE-RENAME PERSISTENCE CONTRACT
// =====================================================================================
// The immediate inline-label check above is intentionally NOT a durable-success check.
// Flow can update the local tile label before the save is committed. This contract only
// returns PERSISTENCE_PASS after a fresh project-route reload observes the exact target
// once and the old title nowhere. IMMEDIATE_UI_PASS is deliberately `ok: false`.
// =====================================================================================

export type RenamePersistenceStatus =
  | 'IMMEDIATE_UI_PASS'
  | 'PERSISTENCE_PASS'
  | 'PERSISTENCE_FAIL'
  | 'PERSISTENCE_UNVERIFIABLE';

export type RenamePersistenceAsset = 'background' | 'character';

/** One exact tile-label read. `ok:false` means the surface itself could not be read. */
export type RenamePersistenceSurfaceRead =
  | { ok: true; names: readonly unknown[] }
  | { ok: false; reason: string };

/** The supported project-route reload result. */
export type RenamePersistenceReload =
  | { attempted: false }
  | { attempted: true; completed: false; reason: string }
  | { attempted: true; completed: true; surface: RenamePersistenceSurfaceRead };

export interface RenamePersistenceInput {
  asset: RenamePersistenceAsset;
  targetName: unknown;
  expectedCurrentName: unknown;
  preRename: RenamePersistenceSurfaceRead;
  immediateUi: RenamePersistenceSurfaceRead;
  commitCompleted: boolean;
  reload: RenamePersistenceReload;
  /** Diagnostic only; the durable contract is exact target uniqueness + old absence. */
  intendedTileIndex?: number | null;
}

export interface RenamePersistenceResult {
  status: RenamePersistenceStatus;
  /** True ONLY for PERSISTENCE_PASS. */
  ok: boolean;
  reason: string;
  code?: FlowAssetRenameErrorCode;
  targetName: string;
  currentName: string;
  detail: Record<string, unknown>;
}

/**
 * Decide whether a rename is durable.
 *
 * Ordering is deliberate:
 *   1. exact pre-rename identity + target absence
 *   2. commit completion
 *   3. immediate UI readback (used only for IMMEDIATE_UI_PASS)
 *   4. fresh project-route reload
 *   5. exact post-reload target uniqueness + old-title absence
 *
 * An immediate UI success with no reload returns IMMEDIATE_UI_PASS and `ok:false`;
 * it can never be mistaken for a durable success.
 */
export function verifyRenamePersistence(input: RenamePersistenceInput): RenamePersistenceResult {
  const assetLabel = input?.asset === 'background' ? 'Background' : 'Character';
  const failureCode: FlowAssetRenameErrorCode = input?.asset === 'background'
    ? 'BACKGROUND_RENAME_PERSISTENCE_FAILED'
    : 'CHARACTER_RENAME_PERSISTENCE_FAILED';
  const unverifiableCode: FlowAssetRenameErrorCode = input?.asset === 'background'
    ? 'BACKGROUND_RENAME_PERSISTENCE_UNVERIFIABLE'
    : 'CHARACTER_RENAME_PERSISTENCE_UNVERIFIABLE';
  const targetName = String(input?.targetName ?? '').trim();
  const currentName = String(input?.expectedCurrentName ?? '').trim();
  const baseDetail = {
    targetName,
    expectedCurrentName: currentName,
    intendedTileIndex: typeof input?.intendedTileIndex === 'number' && Number.isInteger(input.intendedTileIndex)
      ? input.intendedTileIndex
      : null,
  };
  const result = (
    status: RenamePersistenceStatus,
    reason: string,
    code: FlowAssetRenameErrorCode | undefined,
    detail: Record<string, unknown>,
  ): RenamePersistenceResult => ({
    status,
    ok: status === 'PERSISTENCE_PASS',
    reason,
    ...(code ? { code } : {}),
    targetName,
    currentName,
    detail: { ...baseDetail, ...detail },
  });

  if (!targetName) {
    return result('PERSISTENCE_FAIL', `${assetLabel} persistence failed: target name is empty.`, failureCode, { reasonCode: 'TARGET_INVALID' });
  }
  if (!currentName) {
    return result('PERSISTENCE_FAIL', `${assetLabel} persistence failed: an exact current name is required.`, failureCode, { reasonCode: 'CURRENT_NAME_INVALID' });
  }

  if (!input?.preRename || input.preRename.ok !== true) {
    return result('PERSISTENCE_UNVERIFIABLE', `${assetLabel} persistence unverifiable: the pre-rename surface could not be read.`, unverifiableCode, {
      reasonCode: 'PRE_RENAME_UNREADABLE',
      readReason: unreadableReason(input?.preRename),
    });
  }
  const preNames = normalizeNames(input.preRename.names);
  const preCurrent = hits(preNames, currentName);
  const preTarget = hits(preNames, targetName);
  if (preCurrent.length !== 1) {
    return result('PERSISTENCE_FAIL', `${assetLabel} persistence failed: the exact current title must be unique before mutation.`, failureCode, {
      reasonCode: 'PRE_RENAME_CURRENT_NOT_UNIQUE',
      preRenameNames: preNames,
      currentMatchCount: preCurrent.length,
    });
  }
  if (preTarget.length !== 0) {
    return result('PERSISTENCE_FAIL', `${assetLabel} persistence failed: the target title already existed before mutation.`, failureCode, {
      reasonCode: 'PRE_RENAME_TARGET_PRESENT',
      preRenameNames: preNames,
      targetMatchCount: preTarget.length,
    });
  }

  if (input.commitCompleted !== true) {
    return result('PERSISTENCE_FAIL', `${assetLabel} persistence failed: the rename commit did not complete.`, failureCode, {
      reasonCode: 'COMMIT_NOT_COMPLETED',
    });
  }

  if (!input.immediateUi || input.immediateUi.ok !== true) {
    return result('PERSISTENCE_UNVERIFIABLE', `${assetLabel} persistence unverifiable: the immediate UI readback could not be read.`, unverifiableCode, {
      reasonCode: 'IMMEDIATE_UI_UNREADABLE',
      readReason: unreadableReason(input?.immediateUi),
    });
  }
  const immediateNames = normalizeNames(input.immediateUi.names);
  const immediateCurrent = hits(immediateNames, currentName);
  const immediateTarget = hits(immediateNames, targetName);
  const intendedIndex = typeof input.intendedTileIndex === 'number' && Number.isInteger(input.intendedTileIndex)
    ? input.intendedTileIndex
    : null;
  const immediateIntended = intendedIndex !== null && intendedIndex >= 0
    ? (immediateNames[intendedIndex] ?? '')
    : null;
  if (immediateTarget.length !== 1 || immediateCurrent.length !== 0
    || (immediateIntended !== null && immediateIntended !== targetName)) {
    return result('PERSISTENCE_FAIL', `${assetLabel} persistence failed: the immediate UI did not show the exact target uniquely with the old title absent.`, failureCode, {
      reasonCode: 'IMMEDIATE_UI_NOT_CONFIRMED',
      immediateNames,
      currentMatchCount: immediateCurrent.length,
      targetMatchCount: immediateTarget.length,
      intendedLabel: immediateIntended,
    });
  }

  const reload = input.reload;
  if (!reload || reload.attempted !== true) {
    return result('IMMEDIATE_UI_PASS', `${assetLabel} immediate UI readback passed, but no fresh project-route reload was attempted.`, undefined, {
      reasonCode: 'RELOAD_NOT_ATTEMPTED',
      immediateNames,
    });
  }
  if (reload.completed !== true) {
    return result('PERSISTENCE_UNVERIFIABLE', `${assetLabel} persistence unverifiable: the fresh project-route reload did not complete.`, unverifiableCode, {
      reasonCode: 'RELOAD_FAILED',
      reloadReason: reload.reason,
      immediateNames,
    });
  }
  if (!reload.surface || reload.surface.ok !== true) {
    return result('PERSISTENCE_UNVERIFIABLE', `${assetLabel} persistence unverifiable: the post-reload surface could not be read.`, unverifiableCode, {
      reasonCode: 'POST_RELOAD_SURFACE_UNREADABLE',
      readReason: unreadableReason(reload.surface),
      immediateNames,
    });
  }

  const postNames = normalizeNames(reload.surface.names);
  const postTarget = hits(postNames, targetName);
  const postCurrent = hits(postNames, currentName);
  if (postTarget.length === 0) {
    return result('PERSISTENCE_FAIL', `${assetLabel} persistence failed: the target title is missing after the fresh project-route reload.`, failureCode, {
      reasonCode: 'TARGET_MISSING_AFTER_RELOAD',
      postReloadNames: postNames,
      currentMatchCount: postCurrent.length,
      targetMatchCount: postTarget.length,
      immediateNames,
    });
  }
  if (postTarget.length > 1) {
    return result('PERSISTENCE_FAIL', `${assetLabel} persistence failed: ${postTarget.length} tiles carry the target title after the fresh project-route reload.`, failureCode, {
      reasonCode: 'TARGET_DUPLICATE_AFTER_RELOAD',
      postReloadNames: postNames,
      currentMatchCount: postCurrent.length,
      targetMatchCount: postTarget.length,
      immediateNames,
    });
  }
  if (postCurrent.length > 0) {
    return result('PERSISTENCE_FAIL', `${assetLabel} persistence failed: the old title is still present after the fresh project-route reload.`, failureCode, {
      reasonCode: 'OLD_TITLE_PRESENT_AFTER_RELOAD',
      postReloadNames: postNames,
      currentMatchCount: postCurrent.length,
      targetMatchCount: postTarget.length,
      immediateNames,
    });
  }

  return result('PERSISTENCE_PASS', `${assetLabel} rename persisted: the exact target is unique after a fresh project-route reload and the old title is absent.`, undefined, {
    reasonCode: 'TARGET_UNIQUE_AFTER_RELOAD_AND_OLD_ABSENT',
    postReloadNames: postNames,
    currentMatchCount: postCurrent.length,
    targetMatchCount: postTarget.length,
    immediateNames,
  });
}

// =====================================================================================
// CHARACTER GRID -> DETAIL IDENTITY BRIDGE
// =====================================================================================
// Exact-name uniqueness and a matching detail name are necessary but NOT sufficient to prove
// that the detail page belongs to the clicked grid tile. The only accepted association evidence
// is an actual stable DOM attribute on the selected tile whose value equals the captured detail
// route character ID. No Flow asset id is invented here.
// =====================================================================================

export type CharacterGridSelectionStatus =
  | 'EXPECTED_NAME_INVALID'
  | 'GRID_SURFACE_UNREADABLE'
  | 'GRID_TILE_MISSING'
  | 'GRID_NAME_AMBIGUOUS'
  | 'GRID_TILE_UNIQUE';

export interface CharacterStableDomIdentity {
  attribute: string;
  value: string;
}

export interface CharacterGridTileObservation {
  displayName: string;
  /** Actual id/data-* attributes observed on the tile. Empty when the UI exposes none. */
  stableIdentityCandidates?: readonly CharacterStableDomIdentity[] | null;
}

export interface CharacterGridReadEvidence {
  readable: boolean;
  tiles?: readonly CharacterGridTileObservation[] | null;
  reason?: string;
}

export interface CharacterGridSelection {
  ok: boolean;
  status: CharacterGridSelectionStatus;
  exactNameUnique: boolean;
  exactNameMatchCount: number;
  selectedTileIndex: number | null;
  selectedTileName: string | null;
  selectedTileStableIdentityCandidates: readonly CharacterStableDomIdentity[];
  reason: string;
  detail: Record<string, unknown>;
}

const normalizeStableDomIdentities = (
  items: readonly CharacterStableDomIdentity[] | null | undefined,
): CharacterStableDomIdentity[] => {
  const out: CharacterStableDomIdentity[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    const attribute = String(item?.attribute ?? '').trim();
    const value = String(item?.value ?? '').trim();
    if ((attribute === 'id' || attribute.startsWith('data-')) && value) out.push({ attribute, value });
  }
  return out;
};

const FLOW_CHARACTER_ROUTE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const normalizeCharacterRouteId = (id: unknown): string | null => {
  const value = String(id ?? '').trim();
  return FLOW_CHARACTER_ROUTE_ID_RE.test(value) ? value : null;
};

/**
 * Select the detail-navigation target from an observed character grid.
 *
 * This is deliberately stricter than `findCharacterTileByName`: zero or multiple exact-name
 * matches fail closed and expose no clickable index. The selected index is the array position in
 * the same observation used by the caller immediately before clicking.
 */
export function selectExactCharacterTileForDetail(
  input: {
    expectedCurrentName?: unknown;
    grid?: CharacterGridReadEvidence | null;
  } | null | undefined,
): CharacterGridSelection {
  const expected = String(input?.expectedCurrentName ?? '').trim();
  const grid = input?.grid;
  const baseDetail = { expectedCurrentName: expected };
  const result = (
    status: CharacterGridSelectionStatus,
    exactNameUnique: boolean,
    exactNameMatchCount: number,
    selectedTileIndex: number | null,
    selectedTileName: string | null,
    candidates: readonly CharacterStableDomIdentity[],
    reason: string,
    detail: Record<string, unknown> = {},
  ): CharacterGridSelection => ({
    ok: status === 'GRID_TILE_UNIQUE',
    status,
    exactNameUnique,
    exactNameMatchCount,
    selectedTileIndex,
    selectedTileName,
    selectedTileStableIdentityCandidates: candidates,
    reason,
    detail: { ...baseDetail, ...detail },
  });

  if (!expected) {
    return result('EXPECTED_NAME_INVALID', false, 0, null, null, [], 'An exact current character name is required.', { observedNames: [] });
  }
  if (!grid || grid.readable !== true) {
    return result('GRID_SURFACE_UNREADABLE', false, 0, null, null, [], `The character grid could not be read${grid?.reason ? `: ${grid.reason}` : '.'}`, {
      readReason: grid?.reason ?? null,
    });
  }

  const tiles = Array.isArray(grid.tiles) ? grid.tiles : [];
  const names = tiles.map((tile) => String(tile?.displayName ?? '').trim());
  const matches = names
    .map((name, index) => ({ name, index }))
    .filter((entry) => entry.name === expected);

  if (matches.length === 0) {
    return result('GRID_TILE_MISSING', false, 0, null, null, [], `No character tile is named exactly "${expected}".`, {
      observedNames: names,
    });
  }
  if (matches.length > 1) {
    return result('GRID_NAME_AMBIGUOUS', false, matches.length, null, null, [], `${matches.length} character tiles are named exactly "${expected}".`, {
      observedNames: names,
      matchIndexes: matches.map((entry) => entry.index),
    });
  }

  const selected = matches[0];
  const candidates = normalizeStableDomIdentities(tiles[selected.index]?.stableIdentityCandidates);
  return result('GRID_TILE_UNIQUE', true, 1, selected.index, expected, candidates, `Exactly one character tile is named exactly "${expected}".`, {
    observedNames: names,
  });
}

export type CharacterDetailIdentityStatus =
  | CharacterGridSelectionStatus
  | 'DETAIL_NAVIGATION_NOT_ATTEMPTED'
  | 'DETAIL_NAVIGATION_FAILED'
  | 'DETAIL_NAME_MISMATCH'
  | 'DETAIL_ID_MISSING'
  | 'ASSOCIATION_UNPROVEN'
  | 'ASSOCIATION_PROVEN';

export interface CharacterDetailNavigationEvidence {
  attempted: boolean;
  succeeded: boolean;
  reason?: string;
}

export interface CharacterDetailObservation {
  name?: unknown;
  characterId?: unknown;
}

export interface CharacterDetailIdentityResult {
  /** True ONLY for ASSOCIATION_PROVEN. */
  ok: boolean;
  status: CharacterDetailIdentityStatus;
  expectedCurrentName: string;
  exactNameUnique: boolean;
  exactNameMatchCount: number;
  selectedTileIndex: number | null;
  selectedTileName: string | null;
  selectedTileStableIdentityCandidates: readonly CharacterStableDomIdentity[];
  navigationAttempted: boolean;
  navigationSucceeded: boolean;
  detailName: string | null;
  detailNameMatches: boolean;
  characterId: string | null;
  matchedStableIdentity: CharacterStableDomIdentity | null;
  gridToDetailIdentityProven: boolean;
  reason: string;
  detail: Record<string, unknown>;
}

/**
 * Classify the character grid -> detail navigation evidence.
 *
 * Stages are intentionally explicit:
 *   - exact-name uniqueness is carried from the selection result;
 *   - navigation success is independent;
 *   - detail-name match is independent;
 *   - grid-to-detail identity is proven ONLY by a stable DOM attribute value equal to the route ID.
 */
export function verifyCharacterDetailIdentity(
  input: {
    expectedCurrentName?: unknown;
    selection?: CharacterGridSelection | null;
    navigation?: CharacterDetailNavigationEvidence | null;
    detail?: CharacterDetailObservation | null;
  } | null | undefined,
): CharacterDetailIdentityResult {
  const selection = input?.selection ?? null;
  const navigation = input?.navigation ?? null;
  const detail = input?.detail ?? null;
  const expected = String(input?.expectedCurrentName ?? selection?.selectedTileName ?? '').trim();
  const navigationAttempted = navigation?.attempted === true;
  const navigationSucceeded = navigation?.succeeded === true;
  const detailNameRaw = String(detail?.name ?? '').trim();
  const detailName = detailNameRaw || null;
  const detailNameMatches = expected.length > 0 && detailNameRaw === expected;
  const rawCharacterId = String(detail?.characterId ?? '').trim();
  const characterId = normalizeCharacterRouteId(rawCharacterId);
  const candidates = selection?.selectedTileStableIdentityCandidates ?? [];
  const matchedStableIdentity = characterId
    ? candidates.find((candidate) => candidate.value === characterId) ?? null
    : null;
  const baseDetail = {
    expectedCurrentName: expected,
    selectionStatus: selection?.status ?? null,
    selectionReason: selection?.reason ?? null,
    navigation,
    detailName: detailNameRaw,
    rawCharacterId: rawCharacterId || null,
    stableIdentityCandidates: candidates,
  };
  const result = (
    status: CharacterDetailIdentityStatus,
    reason: string,
    detail: Record<string, unknown> = {},
  ): CharacterDetailIdentityResult => ({
    ok: status === 'ASSOCIATION_PROVEN',
    status,
    expectedCurrentName: expected,
    exactNameUnique: selection?.ok === true && selection.exactNameUnique === true,
    exactNameMatchCount: selection?.exactNameMatchCount ?? 0,
    selectedTileIndex: selection?.selectedTileIndex ?? null,
    selectedTileName: selection?.selectedTileName ?? null,
    selectedTileStableIdentityCandidates: candidates,
    navigationAttempted,
    navigationSucceeded,
    detailName,
    detailNameMatches,
    characterId,
    matchedStableIdentity,
    gridToDetailIdentityProven: status === 'ASSOCIATION_PROVEN',
    reason,
    detail: { ...baseDetail, ...detail },
  });

  if (!selection || selection.ok !== true) {
    return result(selection?.status ?? 'GRID_TILE_MISSING', selection?.reason ?? 'No exact character tile selection was available.');
  }
  if (!navigationAttempted) {
    return result('DETAIL_NAVIGATION_NOT_ATTEMPTED', 'Character-detail navigation was not attempted.');
  }
  if (!navigationSucceeded) {
    return result('DETAIL_NAVIGATION_FAILED', `Character-detail navigation failed${navigation?.reason ? `: ${navigation.reason}` : '.'}`);
  }
  if (!detailNameMatches) {
    return result('DETAIL_NAME_MISMATCH', `Character-detail name ${JSON.stringify(detailNameRaw)} does not match the requested current name ${JSON.stringify(expected)}.`);
  }
  if (!characterId) {
    return result('DETAIL_ID_MISSING', 'The detail name matched, but no valid character-detail route ID was captured.');
  }
  if (matchedStableIdentity) {
    return result('ASSOCIATION_PROVEN', `Grid-to-detail identity associated: the clicked tile exposes ${matchedStableIdentity.attribute}=${matchedStableIdentity.value}, matching the detail route ID.`);
  }
  return result('ASSOCIATION_UNPROVEN', 'The detail name matched and a route character ID was captured, but no stable DOM identity on the clicked tile equals that route ID. A matching name alone is not proof of grid-to-detail identity.');
}
