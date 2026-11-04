// Offline regression tests for exact-target Flow asset renaming.
// No browser, network, Flow session, generation, download, attachment, publish or approval path.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';

const R = await import(pathToFileURL(path.join(SRC, 'assetRenamePolicy.ts')).href);
const flowSrc = fs.readFileSync(path.join(SRC, 'flowClient.ts'), 'utf8');
const providerSrc = fs.readFileSync(path.join(SRC, 'flowCharacterProvider.ts'), 'utf8');
const policySrc = fs.readFileSync(path.join(SRC, 'assetRenamePolicy.ts'), 'utf8');
const runnerSrc = fs.readFileSync(path.join(SRC, 'runner.ts'), 'utf8');

let passed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) {
    passed++;
    console.log(`PASS ${label}`);
  } else {
    console.log(`FAIL ${label}`, detail ?? '');
    throw new Error(`FAIL ${label}`);
  }
};

const between = (startMarker: string, endMarker: string): string => {
  const start = flowSrc.indexOf(startMarker);
  if (start < 0) return '';
  const end = flowSrc.indexOf(endMarker, start + startMarker.length);
  return flowSrc.slice(start, end < 0 ? flowSrc.length : end);
};

const BG_CURRENT = 'BG-01-Houseview';
const BG_TARGET = '#BGD-01-ARJUN-ROOM-WIDE';
const CHAR_CURRENT = 'CH-01-Artist';
const CHAR_TARGET = '@CHAR-01-ARJUN';
const CHAR_ID = '7f0c0b2d-4f1a-4e35-9d43-6f2a8c1e5b70';

// ---- 1. typed refusals -----------------------------------------------------------------------
{
  const err = new R.FlowAssetRenameError('BACKGROUND_CURRENT_TARGET_MISSING', 'refused', { observed: 2 });
  check('typed rename refusal is a distinct Error carrying a stable code',
    err instanceof Error && err.name === 'FlowAssetRenameError' && err.code === 'BACKGROUND_CURRENT_TARGET_MISSING', err);
  check('typed rename refusal carries diagnostic detail', err.detail.observed === 2, err.detail);
}

// ---- 2. background exact/unique target ---------------------------------------------------------
{
  const d = R.decideBackgroundRenameTarget({
    targetName: BG_TARGET,
    currentName: BG_CURRENT,
    observedNames: ['#BGD-00-OTHER', BG_CURRENT],
  });
  check('background exact unique current title permits a rename at that exact tile index',
    d.ok === true && d.action === 'RENAME' && d.index === 1 && d.currentName === BG_CURRENT && d.targetName === BG_TARGET, d);

  const already = R.decideBackgroundRenameTarget({
    targetName: BG_TARGET,
    currentName: BG_TARGET,
    observedNames: [BG_TARGET, BG_CURRENT],
  });
  check('background exact current title already equal to target is a no-mutation SKIP',
    already.ok === true && already.action === 'SKIP' && already.index === 0, already);
}

// ---- 3. missing explicit background current name NEVER falls back --------------------------------
{
  const d = R.decideBackgroundRenameTarget({
    targetName: BG_TARGET,
    currentName: 'BG-99-NOT-THERE',
    observedNames: ['#BGD-00-FIRST', BG_CURRENT],
  });
  check('missing requested background current title fails closed',
    d.ok === false && d.code === 'BACKGROUND_CURRENT_TARGET_MISSING', d);
  check('missing requested background current title exposes no fallback tile index',
    d.ok === false && !('index' in d), d);

  const empty = R.decideBackgroundRenameTarget({
    targetName: BG_TARGET,
    currentName: '   ',
    observedNames: ['#BGD-00-FIRST'],
  });
  check('explicit empty background current title fails closed instead of selecting the first tile',
    empty.ok === false && empty.code === 'BACKGROUND_CURRENT_TARGET_MISSING', empty);
}

// ---- 4. duplicate current / duplicate target backgrounds ---------------------------------------
{
  const dupCurrent = R.decideBackgroundRenameTarget({
    targetName: BG_TARGET,
    currentName: BG_CURRENT,
    observedNames: [BG_CURRENT, '#BGD-00-OTHER', BG_CURRENT],
  });
  check('duplicate background current titles fail closed as ambiguous',
    dupCurrent.ok === false && dupCurrent.code === 'BACKGROUND_CURRENT_TARGET_AMBIGUOUS', dupCurrent);

  const targetElsewhere = R.decideBackgroundRenameTarget({
    targetName: BG_TARGET,
    currentName: BG_CURRENT,
    observedNames: [BG_CURRENT, BG_TARGET],
  });
  check('background target already present on a different tile fails closed (no duplicate identity)',
    targetElsewhere.ok === false && targetElsewhere.code === 'BACKGROUND_TARGET_ALREADY_EXISTS', targetElsewhere);

  const duplicateTarget = R.decideBackgroundRenameTarget({
    targetName: BG_TARGET,
    currentName: BG_CURRENT,
    observedNames: [BG_CURRENT, BG_TARGET, '#BGD-00-OTHER', BG_TARGET],
  });
  check('duplicate background target titles fail closed as ambiguous',
    duplicateTarget.ok === false && duplicateTarget.code === 'BACKGROUND_TARGET_AMBIGUOUS', duplicateTarget);
}

// ---- 5. generated background compatibility (no current name) ----------------------------------
{
  const generated = R.decideBackgroundRenameTarget({
    targetName: BG_TARGET,
    observedNames: ['', BG_CURRENT],
  });
  check('immediate post-generation background workflow still targets the first image tile',
    generated.ok === true && generated.action === 'RENAME_GENERATED' && generated.index === 0, generated);

  const generatedAlready = R.decideBackgroundRenameTarget({
    targetName: BG_TARGET,
    observedNames: [BG_TARGET, BG_CURRENT],
  });
  check('immediate post-generation background already at target is a no-mutation SKIP',
    generatedAlready.ok === true && generatedAlready.action === 'SKIP' && generatedAlready.index === 0, generatedAlready);

  const generatedCollision = R.decideBackgroundRenameTarget({
    targetName: BG_TARGET,
    observedNames: ['', BG_TARGET],
  });
  check('immediate post-generation background refuses a target that exists on another tile',
    generatedCollision.ok === false && generatedCollision.code === 'BACKGROUND_TARGET_ALREADY_EXISTS', generatedCollision);
}

// ---- 6. existing character exact target / no generated fallback --------------------------------
{
  const exact = R.decideCharacterRenameTarget({
    targetName: CHAR_TARGET,
    currentName: CHAR_CURRENT,
    observedNames: [CHAR_CURRENT, '@CHAR-02-MAA'],
  });
  check('existing character exact unique current title permits a rename at that exact tile index',
    exact.ok === true && exact.action === 'RENAME' && exact.index === 0 && exact.currentName === CHAR_CURRENT, exact);

  const missing = R.decideCharacterRenameTarget({
    targetName: CHAR_TARGET,
    currentName: CHAR_CURRENT,
    observedNames: ['@CHAR-02-MAA'],
  });
  check('missing existing-character current title fails closed',
    missing.ok === false && missing.code === 'CHARACTER_CURRENT_TARGET_MISSING', missing);

  const emptyCurrent = R.decideCharacterRenameTarget({
    targetName: CHAR_TARGET,
    currentName: '   ',
    observedNames: [CHAR_CURRENT],
  });
  check('empty existing-character current title fails closed',
    emptyCurrent.ok === false && emptyCurrent.code === 'CHARACTER_CURRENT_TARGET_MISSING', emptyCurrent);

  const dupCurrent = R.decideCharacterRenameTarget({
    targetName: CHAR_TARGET,
    currentName: CHAR_CURRENT,
    observedNames: [CHAR_CURRENT, '@CHAR-02-MAA', CHAR_CURRENT],
  });
  check('duplicate existing-character current titles fail closed as ambiguous',
    dupCurrent.ok === false && dupCurrent.code === 'CHARACTER_CURRENT_TARGET_AMBIGUOUS', dupCurrent);

  const targetElsewhere = R.decideCharacterRenameTarget({
    targetName: CHAR_TARGET,
    currentName: CHAR_CURRENT,
    observedNames: [CHAR_CURRENT, CHAR_TARGET],
  });
  check('existing-character target already present elsewhere fails closed',
    targetElsewhere.ok === false && targetElsewhere.code === 'CHARACTER_TARGET_ALREADY_EXISTS', targetElsewhere);

  const duplicateTarget = R.decideCharacterRenameTarget({
    targetName: CHAR_TARGET,
    currentName: CHAR_CURRENT,
    observedNames: [CHAR_CURRENT, CHAR_TARGET, '@CHAR-02-MAA', CHAR_TARGET],
  });
  check('duplicate character target titles fail closed as ambiguous',
    duplicateTarget.ok === false && duplicateTarget.code === 'CHARACTER_TARGET_AMBIGUOUS', duplicateTarget);
}

// ---- 7. generated-character preflight: no first/named fallback --------------------------------
{
  const oneUntitled = R.decideGeneratedCharacterRenameTarget({
    targetName: CHAR_TARGET,
    observedNames: ['Untitled character', '@CHAR-02-MAA'],
  });
  check('generated character with exactly one untitled tile targets that tile',
    oneUntitled.ok === true && oneUntitled.action === 'RENAME_GENERATED' && oneUntitled.index === 0, oneUntitled);

  const namedOnly = R.decideGeneratedCharacterRenameTarget({
    targetName: CHAR_TARGET,
    observedNames: [CHAR_CURRENT, '@CHAR-02-MAA'],
  });
  check('generated-character preflight refuses a named existing character (no first-character fallback)',
    namedOnly.ok === false && namedOnly.code === 'CHARACTER_GENERATED_TARGET_NOT_FOUND', namedOnly);

  const noTiles = R.decideGeneratedCharacterRenameTarget({ targetName: CHAR_TARGET, observedNames: [] });
  check('generated-character preflight refuses an empty character surface',
    noTiles.ok === false && noTiles.code === 'CHARACTER_GENERATED_TARGET_NOT_FOUND', noTiles);

  const twoUntitled = R.decideGeneratedCharacterRenameTarget({
    targetName: CHAR_TARGET,
    observedNames: ['Untitled character', 'Untitled character'],
  });
  check('generated-character preflight refuses multiple untitled candidates',
    twoUntitled.ok === false && twoUntitled.code === 'CHARACTER_GENERATED_TARGET_AMBIGUOUS', twoUntitled);

  const targetExists = R.decideGeneratedCharacterRenameTarget({
    targetName: CHAR_TARGET,
    observedNames: [CHAR_TARGET, 'Untitled character'],
  });
  check('generated-character preflight refuses an already-existing target identity',
    targetExists.ok === false && targetExists.code === 'CHARACTER_TARGET_ALREADY_EXISTS', targetExists);
}

// ---- 8. post-rename verification is explicit and not title-only --------------------------------
{
  const bgOk = R.verifyBackgroundRenameOutcome({
    targetName: BG_TARGET,
    expectedCurrentName: BG_CURRENT,
    observedNamesAfter: [BG_TARGET, '#BGD-00-OTHER'],
    intendedTileLabel: BG_TARGET,
  });
  check('background post-rename verification accepts only exact intended-tile + unique target + old title gone',
    bgOk.ok === true && bgOk.targetName === BG_TARGET, bgOk);

  const bgMissing = R.verifyBackgroundRenameOutcome({
    targetName: BG_TARGET,
    expectedCurrentName: BG_CURRENT,
    observedNamesAfter: [BG_CURRENT],
    intendedTileLabel: BG_CURRENT,
  });
  check('background post-rename target absence is surfaced explicitly',
    bgMissing.ok === false && bgMissing.code === 'BACKGROUND_RENAME_WRONG_TILE', bgMissing);

  const bgWrongTile = R.verifyBackgroundRenameOutcome({
    targetName: BG_TARGET,
    expectedCurrentName: BG_CURRENT,
    observedNamesAfter: [BG_TARGET],
    intendedTileLabel: '#BGD-00-OTHER',
  });
  check('background post-rename wrong intended tile is surfaced explicitly',
    bgWrongTile.ok === false && bgWrongTile.code === 'BACKGROUND_RENAME_WRONG_TILE', bgWrongTile);

  const bgTargetMissing = R.verifyBackgroundRenameOutcome({
    targetName: BG_TARGET,
    expectedCurrentName: BG_CURRENT,
    observedNamesAfter: ['#BGD-00-OTHER'],
    intendedTileLabel: BG_TARGET,
  });
  check('background post-rename missing unique target is surfaced explicitly',
    bgTargetMissing.ok === false && bgTargetMissing.code === 'BACKGROUND_RENAME_VERIFICATION_FAILED', bgTargetMissing);

  const bgDuplicate = R.verifyBackgroundRenameOutcome({
    targetName: BG_TARGET,
    expectedCurrentName: BG_CURRENT,
    observedNamesAfter: [BG_TARGET, BG_TARGET],
    intendedTileLabel: BG_TARGET,
  });
  check('background post-rename duplicate target identity is surfaced explicitly',
    bgDuplicate.ok === false && bgDuplicate.code === 'BACKGROUND_TARGET_AMBIGUOUS', bgDuplicate);

  const bgOldStillThere = R.verifyBackgroundRenameOutcome({
    targetName: BG_TARGET,
    expectedCurrentName: BG_CURRENT,
    observedNamesAfter: [BG_TARGET, BG_CURRENT],
    intendedTileLabel: BG_TARGET,
  });
  check('background post-rename lingering old title is surfaced explicitly',
    bgOldStillThere.ok === false && bgOldStillThere.code === 'BACKGROUND_RENAME_VERIFICATION_FAILED', bgOldStillThere);

  const charOk = R.verifyCharacterRenameOutcome({
    targetName: CHAR_TARGET,
    expectedCurrentName: 'Untitled character',
    observedNamesAfter: [CHAR_TARGET, '@CHAR-02-MAA'],
    intendedTileLabel: CHAR_TARGET,
  });
  check('character post-rename verification accepts the exact intended tile and unique target',
    charOk.ok === true, charOk);

  const charWrong = R.verifyCharacterRenameOutcome({
    targetName: CHAR_TARGET,
    expectedCurrentName: CHAR_CURRENT,
    observedNamesAfter: [CHAR_TARGET],
    intendedTileLabel: CHAR_CURRENT,
  });
  check('character post-rename wrong intended tile is surfaced explicitly',
    charWrong.ok === false && charWrong.code === 'CHARACTER_RENAME_WRONG_TILE', charWrong);
}

// ---- 8b. durable persistence contract ---------------------------------------------------------
{
  const persistenceInput = (overrides: Record<string, unknown> = {}) => ({
    asset: 'background',
    targetName: BG_TARGET,
    expectedCurrentName: BG_CURRENT,
    preRename: { ok: true, names: [BG_CURRENT] },
    immediateUi: { ok: true, names: [BG_TARGET] },
    commitCompleted: true,
    reload: { attempted: true, completed: true, surface: { ok: true, names: [BG_TARGET] } },
    intendedTileIndex: 0,
    ...overrides,
  });

  const persisted = R.verifyRenamePersistence(persistenceInput());
  check('persistence: exact target unique after reload + old title absent → PERSISTENCE_PASS',
    persisted.status === 'PERSISTENCE_PASS' && persisted.ok === true, persisted);

  const immediateOnly = R.verifyRenamePersistence(persistenceInput({ reload: { attempted: false } }));
  check('persistence: immediate UI success alone is IMMEDIATE_UI_PASS, never PERSISTENCE_PASS',
    immediateOnly.status === 'IMMEDIATE_UI_PASS' && immediateOnly.ok === false, immediateOnly);

  const reverted = R.verifyRenamePersistence(persistenceInput({
    reload: { attempted: true, completed: true, surface: { ok: true, names: [BG_CURRENT] } },
  }));
  check('persistence: immediate target then reload restores old title → PERSISTENCE_FAIL',
    reverted.status === 'PERSISTENCE_FAIL' && reverted.ok === false
    && reverted.detail.reasonCode === 'TARGET_MISSING_AFTER_RELOAD', reverted);

  const missingTarget = R.verifyRenamePersistence(persistenceInput({
    reload: { attempted: true, completed: true, surface: { ok: true, names: ['#BGD-00-OTHER'] } },
  }));
  check('persistence: target title missing after reload → PERSISTENCE_FAIL',
    missingTarget.status === 'PERSISTENCE_FAIL' && missingTarget.ok === false
    && missingTarget.detail.reasonCode === 'TARGET_MISSING_AFTER_RELOAD', missingTarget);

  const duplicateTarget = R.verifyRenamePersistence(persistenceInput({
    reload: { attempted: true, completed: true, surface: { ok: true, names: [BG_TARGET, BG_TARGET] } },
  }));
  check('persistence: duplicate target title after reload → PERSISTENCE_FAIL',
    duplicateTarget.status === 'PERSISTENCE_FAIL' && duplicateTarget.ok === false
    && duplicateTarget.detail.reasonCode === 'TARGET_DUPLICATE_AFTER_RELOAD', duplicateTarget);

  const oldRemains = R.verifyRenamePersistence(persistenceInput({
    reload: { attempted: true, completed: true, surface: { ok: true, names: [BG_TARGET, BG_CURRENT] } },
  }));
  check('persistence: old title remains after reload → PERSISTENCE_FAIL',
    oldRemains.status === 'PERSISTENCE_FAIL' && oldRemains.ok === false
    && oldRemains.detail.reasonCode === 'OLD_TITLE_PRESENT_AFTER_RELOAD', oldRemains);

  const reloadFailed = R.verifyRenamePersistence(persistenceInput({
    reload: { attempted: true, completed: false, reason: 'navigation timeout' },
  }));
  check('persistence: project-route reload failure → PERSISTENCE_UNVERIFIABLE',
    reloadFailed.status === 'PERSISTENCE_UNVERIFIABLE' && reloadFailed.ok === false
    && reloadFailed.detail.reasonCode === 'RELOAD_FAILED', reloadFailed);

  const surfaceUnreadable = R.verifyRenamePersistence(persistenceInput({
    reload: { attempted: true, completed: true, surface: { ok: false, reason: 'detached tile' } },
  }));
  check('persistence: post-reload surface read failure → PERSISTENCE_UNVERIFIABLE',
    surfaceUnreadable.status === 'PERSISTENCE_UNVERIFIABLE' && surfaceUnreadable.ok === false
    && surfaceUnreadable.detail.reasonCode === 'POST_RELOAD_SURFACE_UNREADABLE', surfaceUnreadable);

  const preTargetPresent = R.verifyRenamePersistence(persistenceInput({
    preRename: { ok: true, names: [BG_CURRENT, BG_TARGET] },
  }));
  check('persistence: target already present before mutation → PERSISTENCE_FAIL',
    preTargetPresent.status === 'PERSISTENCE_FAIL' && preTargetPresent.ok === false
    && preTargetPresent.detail.reasonCode === 'PRE_RENAME_TARGET_PRESENT', preTargetPresent);

  const preCurrentAmbiguous = R.verifyRenamePersistence(persistenceInput({
    preRename: { ok: true, names: [BG_CURRENT, BG_CURRENT] },
  }));
  check('persistence: non-unique pre-rename current title → PERSISTENCE_FAIL',
    preCurrentAmbiguous.status === 'PERSISTENCE_FAIL' && preCurrentAmbiguous.ok === false
    && preCurrentAmbiguous.detail.reasonCode === 'PRE_RENAME_CURRENT_NOT_UNIQUE', preCurrentAmbiguous);

  const preUnreadable = R.verifyRenamePersistence(persistenceInput({
    preRename: { ok: false, reason: 'preflight read failed' },
  }));
  check('persistence: unreadable pre-rename surface → PERSISTENCE_UNVERIFIABLE',
    preUnreadable.status === 'PERSISTENCE_UNVERIFIABLE' && preUnreadable.ok === false
    && preUnreadable.detail.reasonCode === 'PRE_RENAME_UNREADABLE', preUnreadable);

  const commitIncomplete = R.verifyRenamePersistence(persistenceInput({ commitCompleted: false }));
  check('persistence: incomplete commit never yields durable success → PERSISTENCE_FAIL',
    commitIncomplete.status === 'PERSISTENCE_FAIL' && commitIncomplete.ok === false
    && commitIncomplete.detail.reasonCode === 'COMMIT_NOT_COMPLETED', commitIncomplete);

  const characterPersisted = R.verifyRenamePersistence(persistenceInput({
    asset: 'character',
    targetName: CHAR_TARGET,
    expectedCurrentName: CHAR_CURRENT,
    preRename: { ok: true, names: [CHAR_CURRENT] },
    immediateUi: { ok: true, names: [CHAR_TARGET] },
    reload: { attempted: true, completed: true, surface: { ok: true, names: [CHAR_TARGET] } },
  }));
  check('persistence: character exact target survives reload + old absent → PERSISTENCE_PASS',
    characterPersisted.status === 'PERSISTENCE_PASS' && characterPersisted.ok === true
    && characterPersisted.code === undefined, characterPersisted);
}

// ---- 8b. character grid -> detail identity bridge ---------------------------------------------
{
  const tile = (displayName: string, stableIdentityCandidates: Array<{ attribute: string; value: string }> = []) => ({
    displayName,
    stableIdentityCandidates,
  });
  const uniqueGrid = {
    readable: true,
    tiles: [
      tile('CH-00-Other'),
      tile(CHAR_CURRENT, [{ attribute: 'data-character-id', value: CHAR_ID }]),
      tile('CH-02-Other'),
    ],
  };
  const uniqueSelection = R.selectExactCharacterTileForDetail({
    expectedCurrentName: CHAR_CURRENT,
    grid: uniqueGrid,
  });
  check('character detail identity: exactly one exact current-name tile is selected',
    uniqueSelection.ok === true
    && uniqueSelection.status === 'GRID_TILE_UNIQUE'
    && uniqueSelection.exactNameUnique === true
    && uniqueSelection.exactNameMatchCount === 1
    && uniqueSelection.selectedTileIndex === 1
    && uniqueSelection.selectedTileName === CHAR_CURRENT, uniqueSelection);

  const missing = R.selectExactCharacterTileForDetail({
    expectedCurrentName: CHAR_CURRENT,
    grid: { readable: true, tiles: [tile('CH-00-Other')] },
  });
  check('character detail identity: missing exact tile fails closed with no clickable index',
    missing.ok === false
    && missing.status === 'GRID_TILE_MISSING'
    && missing.exactNameUnique === false
    && missing.exactNameMatchCount === 0
    && missing.selectedTileIndex === null, missing);

  const duplicate = R.selectExactCharacterTileForDetail({
    expectedCurrentName: CHAR_CURRENT,
    grid: { readable: true, tiles: [tile(CHAR_CURRENT), tile(CHAR_CURRENT)] },
  });
  check('character detail identity: duplicate exact names fail closed with no clickable index',
    duplicate.ok === false
    && duplicate.status === 'GRID_NAME_AMBIGUOUS'
    && duplicate.exactNameUnique === false
    && duplicate.exactNameMatchCount === 2
    && duplicate.selectedTileIndex === null, duplicate);

  const unreadable = R.selectExactCharacterTileForDetail({
    expectedCurrentName: CHAR_CURRENT,
    grid: { readable: false, reason: 'detached tile' },
  });
  check('character detail identity: unreadable grid fails closed',
    unreadable.ok === false && unreadable.status === 'GRID_SURFACE_UNREADABLE', unreadable);

  const mismatch = R.verifyCharacterDetailIdentity({
    expectedCurrentName: CHAR_CURRENT,
    selection: uniqueSelection,
    navigation: { attempted: true, succeeded: true },
    detail: { name: 'CH-02-Other', characterId: CHAR_ID },
  });
  check('character detail identity: navigation to a mismatched detail name fails closed',
    mismatch.ok === false
    && mismatch.status === 'DETAIL_NAME_MISMATCH'
    && mismatch.exactNameUnique === true
    && mismatch.navigationSucceeded === true
    && mismatch.detailNameMatches === false
    && mismatch.gridToDetailIdentityProven === false, mismatch);

  const noEvidenceSelection = R.selectExactCharacterTileForDetail({
    expectedCurrentName: CHAR_CURRENT,
    grid: {
      readable: true,
      tiles: [tile(CHAR_CURRENT, [{ attribute: 'data-testid', value: 'character-tile' }])],
    },
  });
  const unproven = R.verifyCharacterDetailIdentity({
    expectedCurrentName: CHAR_CURRENT,
    selection: noEvidenceSelection,
    navigation: { attempted: true, succeeded: true },
    detail: { name: CHAR_CURRENT, characterId: CHAR_ID },
  });
  check('character detail identity: matching name and route id without tile evidence stays UNPROVEN',
    unproven.ok === false
    && unproven.status === 'ASSOCIATION_UNPROVEN'
    && unproven.exactNameUnique === true
    && unproven.navigationSucceeded === true
    && unproven.detailNameMatches === true
    && unproven.characterId === CHAR_ID
    && unproven.matchedStableIdentity === null
    && unproven.gridToDetailIdentityProven === false, unproven);

  const displayOnlySelection = R.selectExactCharacterTileForDetail({
    expectedCurrentName: CHAR_CURRENT,
    grid: {
      readable: true,
      tiles: [tile(CHAR_CURRENT, [{ attribute: 'aria-label', value: CHAR_ID }])],
    },
  });
  const displayOnly = R.verifyCharacterDetailIdentity({
    expectedCurrentName: CHAR_CURRENT,
    selection: displayOnlySelection,
    navigation: { attempted: true, succeeded: true },
    detail: { name: CHAR_CURRENT, characterId: CHAR_ID },
  });
  check('character detail identity: display-text attributes are not accepted as stable identity',
    displayOnly.ok === false
    && displayOnly.status === 'ASSOCIATION_UNPROVEN'
    && displayOnly.selectedTileStableIdentityCandidates.length === 0
    && displayOnly.gridToDetailIdentityProven === false, displayOnly);

  const proven = R.verifyCharacterDetailIdentity({
    expectedCurrentName: CHAR_CURRENT,
    selection: uniqueSelection,
    navigation: { attempted: true, succeeded: true },
    detail: { name: CHAR_CURRENT, characterId: CHAR_ID },
  });
  check('character detail identity: only a matching clicked-tile DOM identity proves association',
    proven.ok === true
    && proven.status === 'ASSOCIATION_PROVEN'
    && proven.exactNameUnique === true
    && proven.navigationSucceeded === true
    && proven.detailNameMatches === true
    && proven.gridToDetailIdentityProven === true
    && proven.matchedStableIdentity?.attribute === 'data-character-id'
    && proven.matchedStableIdentity?.value === CHAR_ID, proven);

  const navigationFailed = R.verifyCharacterDetailIdentity({
    expectedCurrentName: CHAR_CURRENT,
    selection: uniqueSelection,
    navigation: { attempted: true, succeeded: false, reason: 'navigation timeout' },
    detail: null,
  });
  check('character detail identity: failed navigation never yields association',
    navigationFailed.ok === false
    && navigationFailed.status === 'DETAIL_NAVIGATION_FAILED'
    && navigationFailed.navigationSucceeded === false
    && navigationFailed.gridToDetailIdentityProven === false, navigationFailed);

  const idMissing = R.verifyCharacterDetailIdentity({
    expectedCurrentName: CHAR_CURRENT,
    selection: uniqueSelection,
    navigation: { attempted: true, succeeded: true },
    detail: { name: CHAR_CURRENT, characterId: null },
  });
  check('character detail identity: matching detail name without a route id stays UNPROVEN',
    idMissing.ok === false
    && idMissing.status === 'DETAIL_ID_MISSING'
    && idMissing.detailNameMatches === true
    && idMissing.characterId === null
    && idMissing.gridToDetailIdentityProven === false, idMissing);

  const idMalformed = R.verifyCharacterDetailIdentity({
    expectedCurrentName: CHAR_CURRENT,
    selection: uniqueSelection,
    navigation: { attempted: true, succeeded: true },
    detail: { name: CHAR_CURRENT, characterId: 'not-a-uuid' },
  });
  check('character detail identity: malformed route id is rejected, not treated as evidence',
    idMalformed.ok === false
    && idMalformed.status === 'DETAIL_ID_MISSING'
    && idMalformed.characterId === null
    && idMalformed.gridToDetailIdentityProven === false, idMalformed);
}

// ---- 9. FlowClient integration: exact policy calls, no unsafe fallback ------------------------
{
  const bgBody = between('async renameGeneratedBackground(', 'private async renameCharacterTile(');
  check('background rename uses the pure exact-target preflight',
    /decideBackgroundRenameTarget\(/.test(bgBody) && /FlowAssetRenameError/.test(bgBody), bgBody.slice(0, 200));
  check('background rename contains no first-image-tile fallback',
    !/findImageTileByName\(['"]{2}\)/.test(bgBody) && !/if\s*\(!tile\)\s*tile\s*=/.test(bgBody), bgBody);
  check('background rename verifies the intended tile, target uniqueness and old-title absence',
    /verifyBackgroundRenameOutcome\(/.test(bgBody) && /intendedTileLabel/.test(bgBody) && /expectedCurrentName/.test(bgBody), bgBody);
  check('background post-rename verification failure throws a typed error',
    /if\s*\(!outcome\.ok\)\s*throw new FlowAssetRenameError\(outcome\.code, outcome\.reason\)/.test(bgBody), bgBody);

  const genCharBody = between('async renameGeneratedCharacter(', 'async renameExistingCharacter(');
  check('generated-character rename uses the unique-untitled preflight',
    /decideGeneratedCharacterRenameTarget\(/.test(genCharBody), genCharBody.slice(0, 200));
  check('generated-character rename contains no first-character/tile fallback',
    !/findGeneratedCharacterTile\(/.test(genCharBody) && !/tiles\.first\(\)/.test(genCharBody), genCharBody);
  check('generated-character rename verifies the exact target and old title',
    /verifyCharacterRenameOutcome\(/.test(genCharBody) && /intendedTileLabel/.test(genCharBody), genCharBody);

  const existingCharBody = between('async renameExistingCharacter(', 'async returnToProjectGrid(');
  check('existing-character rename has a narrowly scoped exact-target method',
    /async renameExistingCharacter\(targetName:string, currentName:string\)/.test(existingCharBody), existingCharBody.slice(0, 200));
  check('existing-character rename uses exact-current preflight, not untitled/first fallback',
    /decideCharacterRenameTarget\(/.test(existingCharBody) && !/isUntitledCharacterName|findGeneratedCharacterTile|tiles\.first\(\)/.test(existingCharBody), existingCharBody);
  check('existing-character rename verifies the exact intended tile after mutation',
    /verifyCharacterRenameOutcome\(/.test(existingCharBody), existingCharBody);

  const findGenBody = between('async findGeneratedCharacterTile(', 'async findCharacterTileByName(');
  check('findGeneratedCharacterTile returns only a single untitled tile (or null), never tiles.first()',
    /untitled\.length===1/.test(findGenBody) && !/tiles\.first\(\)/.test(findGenBody), findGenBody);

  check('rename preflight contains no generation/download/attachment/publish/approval call',
    !/generateBackground\(|generate\(|Start generation|S\.submit|download|attach|publish|approve/i.test(`${bgBody}\n${genCharBody}\n${existingCharBody}`),
    `${bgBody}\n${genCharBody}\n${existingCharBody}`);

  const persistenceGateBody = between('private async reloadAndReadRenameSurface(', '/** The single untitled generated character tile');
  check('all asset rename paths call the durable persistence gate after immediate verification',
    /enforceRenamePersistence\(/.test(bgBody)
    && bgBody.indexOf('verifyBackgroundRenameOutcome') < bgBody.indexOf('enforceRenamePersistence')
    && /enforceRenamePersistence\(/.test(genCharBody)
    && genCharBody.indexOf('verifyCharacterRenameOutcome') < genCharBody.indexOf('enforceRenamePersistence')
    && /enforceRenamePersistence\(/.test(existingCharBody)
    && existingCharBody.indexOf('verifyCharacterRenameOutcome') < existingCharBody.indexOf('enforceRenamePersistence'),
    `${bgBody}\n---\n${genCharBody}\n---\n${existingCharBody}`);
  check('persistence gate uses the supported project-route reload and strict surface reads',
    /openProjectRoute\(/.test(persistenceGateBody)
    && /strictImageTileLabels\(/.test(persistenceGateBody)
    && /strictCharacterTileLabels\(/.test(persistenceGateBody)
    && /verifyRenamePersistence\(/.test(persistenceGateBody),
    persistenceGateBody.slice(0, 800));
  check('persistence gate contains no generation/attachment/download/publish/approval/deletion call',
    !/generateBackground\(|generateCharacter\(|S\.submit|download|attach|publish|approve|delete|remove|createScene/i.test(persistenceGateBody),
    persistenceGateBody);
  check('persistence gate throws for every non-PERSISTENCE_PASS status',
    /result\.status\s*!==\s*'PERSISTENCE_PASS'/.test(persistenceGateBody)
    && /throw new FlowAssetRenameError\(/.test(persistenceGateBody),
    persistenceGateBody);
}

// ---- 10. provider exact-current precondition before mutation ----------------------------------
{
  const renameBody = providerSrc.slice(providerSrc.indexOf('async renameCharacter('), providerSrc.indexOf('async renameCharacter(') + 3600);
  check('provider rename proves the exact current detail name before clicking',
    /const currentName = String\(await input\.inputValue\(\)/.test(renameBody)
    && /currentName !== expectedCurrent/.test(renameBody)
    && renameBody.indexOf('currentName !== expectedCurrent') < renameBody.indexOf('input.click('), renameBody);
  check('provider rename verifies the same character-detail identity after mutation',
    /afterId !== characterId/.test(renameBody), renameBody);
}

// ---- 10b. offline character grid -> detail identity bridge source checks -----------------------
{
  const bridgeBody = between('async openCharacterDetailWithIdentity(', 'async configureVoice(');
  check('character detail bridge re-selects the exact unique tile immediately before clicking',
    /selectExactCharacterTileForDetail\(/.test(bridgeBody)
    && bridgeBody.indexOf('selectExactCharacterTileForDetail') < bridgeBody.indexOf('characterTileThumbnail'),
    bridgeBody);
  check('character detail bridge reads actual id/data-* attributes instead of inventing an identity',
    /getAttributeNames\(/.test(bridgeBody)
    && /attribute === 'id' \|\| attribute\.startsWith\('data-'\)/.test(bridgeBody),
    bridgeBody);
  check('character detail bridge captures the detail name and route character id',
    /characterDetailNameInput/.test(bridgeBody)
    && /inputValue\(\)/.test(bridgeBody)
    && /resolveFlowCharacterIdFromUrl\(this\.page\.url\(\)\)/.test(bridgeBody),
    bridgeBody);
  check('character detail bridge classifies the evidence fail-closed',
    /verifyCharacterDetailIdentity\(/.test(bridgeBody), bridgeBody);
  check('character detail bridge does not delegate to the first-match openCharacterDetail helper',
    !/this\.openCharacterDetail\(/.test(bridgeBody), bridgeBody);
  check('character detail bridge is defined but not wired into the runner',
    (flowSrc.match(/openCharacterDetailWithIdentity\(/g) ?? []).length === 1
    && !/openCharacterDetailWithIdentity\(/.test(runnerSrc),
    { flowOccurrences: (flowSrc.match(/openCharacterDetailWithIdentity\(/g) ?? []).length });
  check('character detail bridge contains no rename/generation/download/publish/approval call',
    !/renameImageTile\s*\(|renameCharacter\s*\(|generateBackground\s*\(|generateCharacter\s*\(|Start generation|S\.submit|download|attach|publish|approve|delete|remove/i.test(bridgeBody),
    bridgeBody);
}

// ---- 11. pure policy has no action surface -----------------------------------------------------
{
  check('rename policy module is pure (no browser, network, filesystem or media actions)',
    !/from ['"]|require\(|playwright|page\.|\.locator\(|\.click\(|fetch\(|download|attach|publish|approve|writeFile|createWriteStream|mkdir/i.test(policySrc),
    policySrc.slice(0, 300));
  check('rename policy module does not expose generation entry points',
    !/generateBackground|generateCharacter|Start generation|S\.submit/i.test(policySrc), policySrc.slice(0, 300));
}

console.log(`\nFLOW ASSET RENAME REGRESSION TESTS PASSED (${passed} checks)`);
