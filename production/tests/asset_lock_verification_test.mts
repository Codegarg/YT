// Focused OFFLINE tests for Flow-native asset lock verification.
//
// Proves the fail-closed contract: exact identity only; 0 matches -> MISSING, >1 -> AMBIGUOUS,
// unreadable surface -> cannot lock; locks persist ONLY after a successful verification; and the
// read-only reader never generates/contacts Flow beyond the listing surface. No Chrome, no network,
// no credits, no real project access.
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

import { SRC } from './_testPaths.mjs';
const AV = await import(pathToFileURL(`${SRC}/assetVerification.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const CHAR = '@CHAR-01-ARJUN';
const BG = '#BGD-01-ARJUN-ROOM-WIDE';

// ============ canonical identity ============
console.log('--- identity ---');
check('canonical strips exactly one leading character sigil', AV.canonicalAssetName('character', '@CHAR-01-ARJUN') === 'CHAR-01-ARJUN');
check('canonical strips exactly one leading background sigil', AV.canonicalAssetName('background', '#BGD-01-X') === 'BGD-01-X');
check('canonical leaves an already-bare name unchanged', AV.canonicalAssetName('character', 'CHAR-01-ARJUN') === 'CHAR-01-ARJUN');
check('canonical trims surrounding whitespace', AV.canonicalAssetName('background', '  #BGD-01-X  ') === 'BGD-01-X');
check('canonical does NOT case-fold', AV.canonicalAssetName('character', '@char-01') === 'char-01');
check('canonical does NOT strip the wrong sigil', AV.canonicalAssetName('background', '@BGD-01') === '@BGD-01');

// ============ exact match ============
console.log('--- exact matching ---');
{
  const r = AV.verifyAssetLocks({ required: { characters: [CHAR], backgrounds: [BG] }, visible: { characters: ['CHAR-01-ARJUN'], backgrounds: ['BGD-01-ARJUN-ROOM-WIDE'] }, readOk: true });
  check('exact tag + bare Flow name verifies', r.ok === true && r.verifiedCharacters.length === 1 && r.verifiedBackgrounds.length === 1, r);
  const r2 = AV.verifyAssetLocks({ required: { characters: [CHAR], backgrounds: [BG] }, visible: { characters: ['@CHAR-01-ARJUN'], backgrounds: ['#BGD-01-ARJUN-ROOM-WIDE'] }, readOk: true });
  check('sigil-prefixed Flow names verify too', r2.ok === true, r2);
}

// ============ fail closed: missing / ambiguous / unreadable / near-miss ============
console.log('--- fail-closed ---');
{
  const missing = AV.verifyAssetLocks({ required: { characters: [CHAR], backgrounds: [BG] }, visible: { characters: [], backgrounds: ['BGD-01-ARJUN-ROOM-WIDE'] }, readOk: true });
  check('a missing required character -> NOT ok', missing.ok === false && missing.missing.length === 1 && missing.missing[0].kind === 'character', missing);

  const amb = AV.verifyAssetLocks({ required: { characters: [CHAR], backgrounds: [] }, visible: { characters: ['CHAR-01-ARJUN', 'CHAR-01-ARJUN'], backgrounds: [] }, readOk: true });
  check('two Flow tiles with the same canonical name -> AMBIGUOUS, NOT ok', amb.ok === false && amb.ambiguous.length === 1, amb);

  const unreadable = AV.verifyAssetLocks({ required: { characters: [CHAR], backgrounds: [BG] }, visible: { characters: [], backgrounds: [] }, readOk: false, readReason: 'surface unavailable' });
  check('an unreadable surface -> NOT ok (never misread as an empty project)', unreadable.ok === false && /could not be read/.test(String(unreadable.reason)), unreadable);

  const near = AV.verifyAssetLocks({ required: { characters: [CHAR], backgrounds: [] }, visible: { characters: ['CHAR-01-ARJUN-EXTRA'], backgrounds: [] }, readOk: true });
  check('prefix/suffix near-miss does NOT verify (no fuzzy matching)', near.ok === false && near.missing.length === 1, near);

  const partial = AV.verifyAssetLocks({ required: { characters: [CHAR], backgrounds: [BG] }, visible: { characters: ['CHAR-01-ARJUN'], backgrounds: [] }, readOk: true });
  check('partial verification is NOT ok (all-or-nothing)', partial.ok === false && partial.missing.length === 1, partial);

  const empty = AV.verifyAssetLocks({ required: { characters: [], backgrounds: [] }, visible: { characters: ['anything'], backgrounds: [] }, readOk: true });
  check('no required assets -> trivially ok', empty.ok === true, empty);
}

// ============ determinism ============
console.log('--- determinism ---');
{
  const req = { characters: [CHAR, '@CHAR-02-MAA'], backgrounds: [BG] };
  const vis = { characters: ['CHAR-02-MAA', 'CHAR-01-ARJUN'], backgrounds: ['BGD-01-ARJUN-ROOM-WIDE'] };
  const a = AV.verifyAssetLocks({ required: req, visible: vis, readOk: true });
  const b = AV.verifyAssetLocks({ required: req, visible: vis, readOk: true });
  check('repeated verification is byte-identical', JSON.stringify(a) === JSON.stringify(b), { a, b });
  check('verification order follows the required order', a.verifiedCharacters.join(',') === '@CHAR-01-ARJUN,@CHAR-02-MAA', a.verifiedCharacters);
}

// ============ reader: fail closed, read-only ============
console.log('--- read-only reader ---');
{
  const none = await AV.readFlowProjectAssets(null);
  check('no client -> read fails closed', none.ok === false && none.reason !== undefined, none);
  const partialClient = { listCharacterNames: async () => ['A'] };
  const partial = await AV.readFlowProjectAssets(partialClient as any);
  check('incomplete reader surface -> read fails closed', partial.ok === false, partial);
  const throwing = { listCharacterNames: async () => { throw new Error('boom'); }, listImageNames: async () => [] };
  const threw = await AV.readFlowProjectAssets(throwing as any);
  check('a reader that throws -> read fails closed with the reason', threw.ok === false && /boom/.test(String(threw.reason)), threw);
  const ok = await AV.readFlowProjectAssets({ listCharacterNames: async () => ['  A  ', '', 'B'], listImageNames: async () => ['BG1'] } as any);
  check('a working reader returns trimmed, non-empty names', ok.ok === true && ok.characters.join(',') === 'A,B' && ok.backgrounds.join(',') === 'BG1', ok);

  const combined = await AV.verifyFlowProjectAssets({ listCharacterNames: async () => [CHAR], listImageNames: async () => [BG] } as any, { characters: [CHAR], backgrounds: [BG] });
  check('verifyFlowProjectAssets combines read + verify', combined.ok === true && combined.verifiedCharacters.length === 1, combined);
  const combinedMissing = await AV.verifyFlowProjectAssets({ listCharacterNames: async () => [], listImageNames: async () => [] } as any, { characters: [CHAR], backgrounds: [BG] });
  check('verifyFlowProjectAssets fails closed when assets are absent', combinedMissing.ok === false, combinedMissing);

  // A project-route read that yields nothing was never OBSERVED: it must not report ok:true.
  const emptyProject = await AV.readFlowProjectAssets({ listCharacterNames: async () => [], listImageNames: async () => [] } as any);
  check('an empty project-route read fails closed (never "these assets do not exist")',
    emptyProject.ok === false && emptyProject.characters.length === 0 && /not observed/.test(String(emptyProject.reason)), emptyProject);
  const emptyProjectVerified = await AV.verifyFlowProjectAssets({ listCharacterNames: async () => [], listImageNames: async () => [] } as any, { characters: [CHAR], backgrounds: [BG] });
  check('an empty project-route read can never yield a verified lock',
    emptyProjectVerified.ok === false && emptyProjectVerified.verifiedCharacters.length === 0 && emptyProjectVerified.verifiedBackgrounds.length === 0, emptyProjectVerified);
}

// ============ scene-surface reader: the surface where identities are observable ============
console.log('--- scene-surface reader ---');
{
  const CHARS = ['@CHAR-01-ARJUN', '@CHAR-02-MAA', '@CHAR-03-RADHADEVI-ATMA', '@CHAR-04-DADI'];
  const BGS = ['#BGD-01-ARJUN-ROOM-WIDE', '#BGD-02-ARJUN-ROOM-WINDOW-CLOSE', '#BGD-03-STREET-TO-CREMATION-WIDE',
    '#BGD-04-CREMATION-GROUND-WIDE', '#BGD-05-CREMATION-GROUND-PYRE-CLOSE', '#BGD-06-CREMATION-GROUND-STONE-CLOSE',
    '#BGD-07-ARJUN-HOME-INTERIOR-WIDE'];
  const required = { characters: CHARS, backgrounds: BGS };
  const rail = BGS.concat(['Untitled Scene 10-06 08:27:47', 'Man meeting ghost at pyre']);
  const surface = { listRailAssetTags: async () => rail, listCharacterPickerTags: async () => CHARS };

  check('9 a null client -> scene-surface read fails closed',
    (await AV.readFlowSceneSurfaceAssets(null)).ok === false);
  check('9b a client missing the character picker reader fails closed',
    (await AV.readFlowSceneSurfaceAssets({ listRailAssetTags: async () => rail } as any)).ok === false);
  check('9c a rail reader that throws fails closed with the reason',
    /rail read failed/.test(String((await AV.readFlowSceneSurfaceAssets({ ...surface, listRailAssetTags: async () => { throw new Error('no rail'); } } as any)).reason)));
  check('9d a picker reader that throws fails closed with the reason',
    /picker read failed/.test(String((await AV.readFlowSceneSurfaceAssets({ ...surface, listCharacterPickerTags: async () => { throw new Error('no picker'); } } as any)).reason)));
  const bothEmpty = await AV.readFlowSceneSurfaceAssets({ listRailAssetTags: async () => [], listCharacterPickerTags: async () => [] } as any);
  check('9e two empty surfaces fail closed (the surface was never observed)', bothEmpty.ok === false && /not observed/.test(String(bothEmpty.reason)), bothEmpty);

  const read = await AV.readFlowSceneSurfaceAssets(surface as any);
  check('9f the scene surface supplies every required background identity from the rail',
    read.ok === true && BGS.every((b) => read.backgrounds.includes(b)), read);
  check('9g the scene surface supplies every required character identity from the picker titles',
    CHARS.every((c) => read.characters.includes(c)), read);
  check('9h only STABLE tags are read — no picker token, chip token or generation uuid',
    !/\/asb\//.test(JSON.stringify(read)) && !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(JSON.stringify(read)), read);
  check('9i the two surfaces are never mixed (characters never come from the rail)',
    !read.backgrounds.includes(CHARS[0]) && !read.characters.includes(BGS[0]), read);

  const verified = await AV.verifyFlowSceneSurfaceAssets(surface as any, required);
  check('10 exact rail + picker identities verify all 11 required assets',
    verified.ok === true && verified.verifiedCharacters.length === 4 && verified.verifiedBackgrounds.length === 7, verified);

  const withoutBg7 = await AV.verifyFlowSceneSurfaceAssets({ ...surface, listRailAssetTags: async () => rail.filter((t) => t !== BGS[6]) } as any, required);
  check('11 a missing required background remains a failure', withoutBg7.ok === false && withoutBg7.missing.some((m) => m.tag === BGS[6]), withoutBg7);
  const withoutChar4 = await AV.verifyFlowSceneSurfaceAssets({ ...surface, listCharacterPickerTags: async () => CHARS.slice(0, 3) } as any, required);
  check('11b a missing required character remains a failure', withoutChar4.ok === false && withoutChar4.missing.some((m) => m.tag === CHARS[3]), withoutChar4);
  const dupBg = await AV.verifyFlowSceneSurfaceAssets({ ...surface, listRailAssetTags: async () => rail.concat([BGS[0]]) } as any, required);
  check('12 a duplicated required background identity remains AMBIGUOUS (a failure)',
    dupBg.ok === false && dupBg.ambiguous.some((a) => a.tag === BGS[0]), dupBg);
  const dupChar = await AV.verifyFlowSceneSurfaceAssets({ ...surface, listCharacterPickerTags: async () => CHARS.concat([CHARS[0]]) } as any, required);
  check('12b a duplicated required character identity remains AMBIGUOUS (a failure)',
    dupChar.ok === false && dupChar.ambiguous.some((a) => a.tag === CHARS[0]), dupChar);
  const underHydrated = await AV.verifyFlowSceneSurfaceAssets({ ...surface, listCharacterPickerTags: async () => [] } as any, required);
  check('12c an under-hydrated picker under-reports and fails closed (never a false verification)',
    underHydrated.ok === false && underHydrated.verifiedCharacters.length === 0, underHydrated);

  // sigil-insensitive but otherwise exact: normalization is unchanged.
  const noSigil = await AV.verifyFlowSceneSurfaceAssets({ listRailAssetTags: async () => BGS.map((b) => b.slice(1)), listCharacterPickerTags: async () => CHARS.map((c) => c.slice(1)) } as any, required);
  check('13 a tag differing only by its leading sigil still matches (normalization unchanged)', noSigil.ok === true, noSigil);
  const caseFolded = await AV.verifyFlowSceneSurfaceAssets({ ...surface, listRailAssetTags: async () => BGS.map((b) => b.toLowerCase()) } as any, required);
  check('13b identity is still EXACT — case differences are NOT normalized', caseFolded.ok === false, caseFolded);

  // scene resolution is read-only and fails closed
  check('14 an explicit scene id wins and is returned verbatim',
    (await AV.resolveAssetVerificationSceneId(null, '  scene-pinned ')) === 'scene-pinned');
  check('14b no client and no preferred id -> "" (caller must fail closed)',
    (await AV.resolveAssetVerificationSceneId(null)) === '');
  check('14c the first discoverable scene id is used when none is preferred',
    (await AV.resolveAssetVerificationSceneId({ listSceneIds: async () => ['  scene-a ', '', 'scene-b'] } as any)) === 'scene-a');
  check('14d an empty project resolves to "" rather than inventing a surface',
    (await AV.resolveAssetVerificationSceneId({ listSceneIds: async () => [] } as any)) === '');
  check('14e a throwing scene lister resolves to ""',
    (await AV.resolveAssetVerificationSceneId({ listSceneIds: async () => { throw new Error('x'); } } as any)) === '');

  // no generation path may exist in asset verification
  const avSrc = fs.readFileSync(`${SRC}/assetVerification.ts`, 'utf8');
  check('15 no generation path is introduced into asset verification',
    !/generateSceneVideo|generateProjectVideo|Start generation|generate-icon|confirm\(\)/.test(avSrc));
  const flowSrc = fs.readFileSync(`${SRC}/flowClient.ts`, 'utf8');
  const railStart = flowSrc.indexOf('async listRailAssetTags(');
  const pickStart = flowSrc.indexOf('async listCharacterPickerTags(');
  const railBody = flowSrc.slice(railStart, pickStart);
  const pickBody = flowSrc.slice(pickStart, flowSrc.indexOf('// After rename the runner is on the grid', pickStart));
  check('15b the rail reader reuses the existing proven rail reader and adds no new selector',
    /readSceneComposerIngredientEvidence\(\)/.test(railBody) && !/querySelector/.test(railBody), railBody.slice(0, 200));
  check('15c the picker reader reads titles only and never clicks a row',
    /span\.asset-title/.test(pickBody) && !/asset-item\[role="option"\][\s\S]{0,120}\.click/.test(pickBody)
    && !/resolveRow|selectAsset\(/.test(pickBody));
  check('15d the picker reader always closes the picker and never reads an /asb/ token',
    /finally/.test(pickBody) && /Escape/.test(pickBody) && !/\/asb\/|asset-thumbnail-image/.test(pickBody));
  check('15e neither asset reader touches generation',
    !/generate/i.test(railBody) && !/generate/i.test(pickBody));
}

// ============ persistence planning + apply ============
console.log('--- persistence ---');
{
  const pipeline: any = {
    characters: [{ tag: '@CHAR-01-ARJUN' }, { tag: '@CHAR-02-MAA', locked: true }],
    backgrounds: [{ tag: '#BGD-01-ARJUN-ROOM-WIDE' }],
  };
  const failed = AV.verifyAssetLocks({ required: { characters: ['@CHAR-01-ARJUN'], backgrounds: ['#BGD-01-ARJUN-ROOM-WIDE'] }, visible: { characters: [], backgrounds: [] }, readOk: true });
  const planFailed = AV.planAssetLockPersistence(pipeline, failed);
  check('a FAILED verification plans NO lock persistence', planFailed.changed === false && planFailed.lockCharacters.length === 0 && planFailed.lockBackgrounds.length === 0, planFailed);
  check('a FAILED verification leaves the pipeline untouched', pipeline.characters[0].locked === undefined && pipeline.backgrounds[0].locked === undefined);

  const ok = AV.verifyAssetLocks({ required: { characters: ['@CHAR-01-ARJUN', '@CHAR-02-MAA'], backgrounds: ['#BGD-01-ARJUN-ROOM-WIDE'] }, visible: { characters: ['CHAR-01-ARJUN', 'CHAR-02-MAA'], backgrounds: ['BGD-01-ARJUN-ROOM-WIDE'] }, readOk: true });
  const plan = AV.planAssetLockPersistence(pipeline, ok);
  check('an OK verification plans only the un-locked verified tags', plan.lockCharacters.join(',') === '@CHAR-01-ARJUN' && plan.lockBackgrounds.join(',') === '#BGD-01-ARJUN-ROOM-WIDE' && plan.changed === true, plan);

  const applied = AV.applyAssetLockPlan(pipeline, plan);
  check('apply sets locked=true and status=done for verified tags', pipeline.characters[0].locked === true && pipeline.characters[0].status === 'done' && pipeline.backgrounds[0].locked === true && pipeline.backgrounds[0].status === 'done', pipeline);
  check('apply reports exactly what it locked', applied.lockedCharacters.join(',') === '@CHAR-01-ARJUN' && applied.lockedBackgrounds.join(',') === '#BGD-01-ARJUN-ROOM-WIDE', applied);
  check('apply does not re-touch an already-locked asset', pipeline.characters[1].status !== 'done', pipeline.characters[1]);

  const plan2 = AV.planAssetLockPersistence(pipeline, ok);
  check('persistence planning is idempotent after apply', plan2.changed === false, plan2);
}

// ============ required-asset derivation ============
console.log('--- required assets ---');
{
  const req = AV.requiredAssetsForScenes([
    { background_tag: '#BGD-01', character_tags: ['@CHAR-01'] },
    { background_tag: '#BGD-01', character_tags: ['@CHAR-01', '@CHAR-02'] },
    { background_tag: '#BGD-02', character_tags: [] },
  ]);
  check('required assets are deduped in stable first-seen order',
    req.backgrounds.join(',') === '#BGD-01,#BGD-02' && req.characters.join(',') === '@CHAR-01,@CHAR-02', req);
  const viaAssets = AV.requiredAssetsForScenes([{ assets: { background_tag: '#B', character_tags: ['@C'] } }]);
  check('required assets fall back to the scene.assets shape', viaAssets.backgrounds.join(',') === '#B' && viaAssets.characters.join(',') === '@C', viaAssets);
}

console.log(`\n${passed} asset-lock verification checks passed (fully offline).`);
