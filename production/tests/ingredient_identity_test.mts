// Focused OFFLINE tests for the proven Flow ingredient-chip identity model.
//
// Covers: normalizeFlowMediaUuid, buildRailAssetIdentityMap, resolveIngredientChipTags, the
// classification of resolved background chips, the regression that `[contenteditable="false"]` is
// no longer ingredient evidence, and character-safety fail-closed behaviour.
// Fully offline. NO browser, NO Flow, NO credits.
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const SLG = await import(pathToFileURL(`${SRC}/sceneLocalGeneration.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const BG = '#BGD-01-ARJUN-ROOM-WIDE';
const CH = '@CHAR-01-ARJUN';
const U_BG = 'ccef4b18-bd27-49ca-913b-9df3b6b91e06';
const U_CH = 'aaaa1111-2222-4333-8444-555566667777';
const BGD_SRC = `https://flow-content.google/image/${U_BG}?Expires=1791297905&KeyName=labs-flow-prod-cdn-key&Signature=CxH84NeiT6doCH1MgqaX92fNIos`;
const CH_SRC = `https://flow-content.google/image/${U_CH}?Expires=999&KeyName=k&Signature=z`;
const RAIL = [{ tag: BG, src: BGD_SRC }, { tag: CH, src: CH_SRC }];

// ============ 1. normalizeFlowMediaUuid ============
console.log('--- normalizeFlowMediaUuid ---');
{
  check('1 a valid signed Flow URL yields the media uuid', SLG.normalizeFlowMediaUuid(BGD_SRC) === U_BG, SLG.normalizeFlowMediaUuid(BGD_SRC));
  const other = `https://flow-content.google/image/${U_BG}?Expires=1&KeyName=k&Signature=DIFFERENT`;
  check('1b the same uuid with different query params yields the SAME uuid',
    SLG.normalizeFlowMediaUuid(other) === U_BG && SLG.normalizeFlowMediaUuid(other) === SLG.normalizeFlowMediaUuid(BGD_SRC));
  check('1c a malformed URL yields null', SLG.normalizeFlowMediaUuid('not a url') === null && SLG.normalizeFlowMediaUuid('http://') === null, SLG.normalizeFlowMediaUuid('not a url'));
  check('1d a missing/short pathname segment yields null', SLG.normalizeFlowMediaUuid('https://flow-content.google/image/') === null && SLG.normalizeFlowMediaUuid('https://x/a/b') === null);
  check('1e empty / non-string yields null', SLG.normalizeFlowMediaUuid('') === null && SLG.normalizeFlowMediaUuid(null) === null && SLG.normalizeFlowMediaUuid(undefined) === null);
}

// ============ 2. buildRailAssetIdentityMap ============
console.log('--- rail identity map ---');
{
  const m = SLG.buildRailAssetIdentityMap(RAIL);
  check('2 a rail entry maps uuid -> tag', m.ok === true && m.map.get(U_BG) === BG && m.map.get(U_CH) === CH, m);
  const dupSame = SLG.buildRailAssetIdentityMap([{ tag: BG, src: BGD_SRC }, { tag: BG, src: `https://flow-content.google/image/${U_BG}?Expires=2&Signature=x` }]);
  check('2b duplicate uuid with the SAME tag is accepted', dupSame.ok === true && dupSame.map.get(U_BG) === BG, dupSame);
  const dupDiff = SLG.buildRailAssetIdentityMap([{ tag: BG, src: BGD_SRC }, { tag: '#BGD-99-OTHER', src: BGD_SRC }]);
  check('2c duplicate uuid mapping to DIFFERENT tags fails closed', dupDiff.ok === false, dupDiff);
  const emptyTag = SLG.buildRailAssetIdentityMap([{ tag: '', src: BGD_SRC }]);
  check('2d a uuid-bearing entry with an empty tag is invalid', emptyTag.ok === false, emptyTag);
  const ignored = SLG.buildRailAssetIdentityMap([{ tag: BG, src: 'not-a-url' }, { tag: CH, src: CH_SRC }]);
  check('2e entries without a resolvable uuid are ignored (not an error)', ignored.ok === true && ignored.map.size === 1 && ignored.map.get(U_CH) === CH, ignored);
}

// ============ 3. resolveIngredientChipTags + background classification ============
console.log('--- background chip resolution ---');
{
  const m = SLG.buildRailAssetIdentityMap(RAIL);
  const res = SLG.resolveIngredientChipTags([BGD_SRC], m.map);
  check('3 a known chip uuid resolves to its tag', res.state === 'RESOLVED' && res.tags.join(',') === BG, res);
  const absent = SLG.resolveIngredientChipTags([`https://flow-content.google/image/11111111-1111-4111-8111-111111111111?s=1`], m.map);
  check('3b a chip uuid absent from the rail map -> IDENTITY_UNRESOLVED', absent.state === 'IDENTITY_UNRESOLVED', absent);
  const malformed = SLG.resolveIngredientChipTags(['garbage'], m.map);
  check('3c a malformed chip src -> IDENTITY_UNRESOLVED', malformed.state === 'IDENTITY_UNRESOLVED', malformed);
  const noMap = SLG.resolveIngredientChipTags([BGD_SRC], undefined as any);
  check('3d an unavailable rail map -> INVALID', noMap.state === 'INVALID', noMap);

  const EXACT = { chipSrcs: [BGD_SRC, CH_SRC], railEntries: RAIL };
  check('3e exact background+character chips -> EXACT', SLG.classifyIngredientEvidence([BG, CH], EXACT).state === 'EXACT');
  check('3f a missing background chip -> MISSING', SLG.classifyIngredientEvidence([BG, CH], { chipSrcs: [CH_SRC], railEntries: RAIL }).state === 'MISSING');
  check('3g an unexpected chip -> UNEXPECTED',
    SLG.classifyIngredientEvidence([BG], { chipSrcs: [BGD_SRC, CH_SRC], railEntries: RAIL }).state === 'UNEXPECTED');
  check('3h a duplicate chip -> DUPLICATE', SLG.classifyIngredientEvidence([BG, CH], { chipSrcs: [BGD_SRC, CH_SRC, CH_SRC], railEntries: RAIL }).state === 'DUPLICATE');
  check('3i a chip uuid absent from the rail map -> IDENTITY_UNRESOLVED',
    SLG.classifyIngredientEvidence([BG, CH], { chipSrcs: [BGD_SRC, CH_SRC], railEntries: [{ tag: BG, src: BGD_SRC }] }).state === 'IDENTITY_UNRESOLVED');
  check('3j a malformed chip src -> IDENTITY_UNRESOLVED',
    SLG.classifyIngredientEvidence([BG], { chipSrcs: ['garbage'], railEntries: RAIL }).state === 'IDENTITY_UNRESOLVED');
  check('3k malformed evidence -> INVALID', SLG.classifyIngredientEvidence([BG], undefined as any).state === 'INVALID');
  check('3l a conflicting rail map -> INVALID',
    SLG.classifyIngredientEvidence([BG], { chipSrcs: [BGD_SRC], railEntries: [{ tag: BG, src: BGD_SRC }, { tag: '#BGD-99-OTHER', src: BGD_SRC }] }).state === 'INVALID');
}

// ============ 4. regression: contenteditable is NOT ingredient evidence ============
console.log('--- regression: no contenteditable marker ---');
{
  const src = await fs.readFile(`${SRC}/flowClient.ts`, 'utf8');
  const start = src.indexOf('async readSceneComposerIngredientEvidence(');
  const next = src.indexOf('\n  async ', start + 10);
  const body = src.slice(start, next > 0 ? next : src.length);
  check('4 the reader does NOT use [contenteditable="false"]', !/contenteditable/.test(body), 'contenteditable referenced');
  check('4b the reader reads the PROVEN chip DOM', /flow-ingredient-bar/.test(body) && /flow-image-ingredient-chip/.test(body) && /flow-character-ingredient-chip/.test(body) && /img\.chip-image/.test(body));
  check('4c the reader reads the rail identity source', /button\.thumbnail-button\[aria-label\]/.test(body));

  // A ProseMirror root with contenteditable=false and NO ingredient bar yields no chips.
  const noChips = { chipSrcs: [] as string[], railEntries: RAIL };
  check('4d a composer with no ingredient bar cannot pass', SLG.classifyIngredientEvidence([BG, CH], noChips).state === 'MISSING', SLG.classifyIngredientEvidence([BG, CH], noChips));
  check('4e empty chip evidence fails closed', SLG.verifyIngredientEvidence([BG, CH], noChips).ok === false);
}

// ============ 5. character safety ============
console.log('--- character safety ---');
{
  // The reader never reads the generic chip aria-label; identity comes only from the media uuid.
  const src = await fs.readFile(`${SRC}/flowClient.ts`, 'utf8');
  const start = src.indexOf('async readSceneComposerIngredientEvidence(');
  const next = src.indexOf('\n  async ', start + 10);
  const body = src.slice(start, next > 0 ? next : src.length);
  check('5 the reader never reads the generic chip aria-label (only the rail tag source)',
    !/chip-container/.test(body) && !/chip-image/.test(body.replace(/img\.chip-image/g, '')) && /button\.thumbnail-button\[aria-label\]/.test(body));

  // A character chip whose uuid is unresolved -> fail closed.
  const unresolvedChar = SLG.classifyIngredientEvidence([CH], { chipSrcs: [CH_SRC], railEntries: [] });
  check('5b an unresolved character identity fails closed', unresolvedChar.state === 'IDENTITY_UNRESOLVED' && SLG.verifyIngredientEvidence([CH], { chipSrcs: [CH_SRC], railEntries: [] }).ok === false, unresolvedChar);

  // The rail maps the chip uuid to a NON-tag label (e.g. the generic "Ingredient") -> the expected
  // character tag is MISSING -> fail closed. A generic label can never satisfy a character tag.
  const genericLabel = SLG.classifyIngredientEvidence([CH], { chipSrcs: [CH_SRC], railEntries: [{ tag: 'Ingredient', src: CH_SRC }] });
  check('5c a generic rail label can never satisfy a character tag', genericLabel.state === 'MISSING' && genericLabel.missing.join(',') === CH, genericLabel);

  // Only a genuine rail mapping of the chip uuid to the exact character tag passes.
  check('5d a genuine character tag mapping passes', SLG.classifyIngredientEvidence([CH], { chipSrcs: [CH_SRC], railEntries: [{ tag: CH, src: CH_SRC }] }).state === 'EXACT');
}

// ============ CHARACTER identity (A-F) ============
const CH1 = '@CHAR-01-ARJUN';
const CH2 = '@CHAR-02-MAA';
const CH3 = '@CHAR-03-RADHADEVI-ATMA';
const CH4 = '@CHAR-04-DADI';
const T1 = 'ANqvLOZFRtN_rGJtVov-uurQdHR9u_I8251JrG98HK2zZ5w06';
const T2 = 'ANqvLOZegsIBh7xrYmhSwsRuRU8faI5oUB6xXfRU-iVqDkUsf2CK';
const T3 = 'ANqvLOY_fpaVQcmp-_TxPpmpSmaZ-a4wNHH5N_CZQD8t253fmEwo';
const T4 = 'ANqvLOYM5geQTmjl9zA8uhRfGjYcYNLwIL-2RIr-Z6-6mbhPZt3';
const asb = (t: string, q = '?s=1') => `https://lh3.googleusercontent.com/asb/${t}${q}`;

console.log('--- A. character token normalization ---');
{
  check('A1 a valid /asb/<token> yields the token', SLG.normalizeFlowCharacterToken(asb(T1)) === T1);
  check('A2 the same token with different query params yields the SAME token', SLG.normalizeFlowCharacterToken(asb(T1, '?Expires=9&Signature=x')) === T1);
  check('A3 an /image/<uuid> URL is NOT a character token', SLG.normalizeFlowCharacterToken(`https://flow-content.google/image/${U_BG}?s=1`) === null);
  check('A4 a malformed URL yields null', SLG.normalizeFlowCharacterToken('not a url') === null && SLG.normalizeFlowCharacterToken('http://') === null);
  check('A5 an empty token yields null', SLG.normalizeFlowCharacterToken('https://lh3.googleusercontent.com/asb/') === null);
  check('A6 non-string yields null', SLG.normalizeFlowCharacterToken(null) === null && SLG.normalizeFlowCharacterToken(undefined) === null && SLG.normalizeFlowCharacterToken('') === null);
}

console.log('--- B. character attachment transaction (selection-time) ---');
{
  const tx = (tag: string, token: string) => ({ expectedTag: tag, pickerToken: token, chipToken: token, verified: true, code: 'CHARACTER_ATTACHMENT_VERIFIED' });
  const okEv = SLG.verifyCharacterAttachmentSelection({ expectedTag: CH1, pickerTag: CH1, pickerToken: asb(T1), chipToken: asb(T1) });
  check('B6 resolveCharacterToken accepts a raw /asb/ URL', SLG.resolveCharacterToken(asb(T1)) === T1);
  check('B6b resolveCharacterToken accepts an already-normalized bare token', SLG.resolveCharacterToken(T1) === T1);
  check('B6c resolveCharacterToken rejects a malformed value', SLG.resolveCharacterToken('garbage') === null && SLG.resolveCharacterToken('') === null && SLG.resolveCharacterToken(null) === null);
  check('B6d the verifier accepts bare tokens (already-normalized) on both sides', SLG.verifyCharacterAttachmentSelection({ expectedTag: CH1, pickerTag: CH1, pickerToken: T1, chipToken: T1 }).verified === true);
  check('B7 picker token == chip token -> VERIFIED', okEv.verified === true && okEv.code === 'CHARACTER_ATTACHMENT_VERIFIED', okEv);
  check('B7b the evidence carries both tokens (transient only)', okEv.pickerToken === T1 && okEv.chipToken === T1);
  const mismatch = SLG.verifyCharacterAttachmentSelection({ expectedTag: CH1, pickerTag: CH1, pickerToken: asb(T1), chipToken: asb(T2) });
  check('B8 picker token != chip token -> IDENTITY_MISMATCH', mismatch.verified === false && mismatch.code === 'CHARACTER_ATTACHMENT_IDENTITY_MISMATCH', mismatch);
  const chipMissing = SLG.verifyCharacterAttachmentSelection({ expectedTag: CH1, pickerTag: CH1, pickerToken: asb(T1), chipToken: null });
  check('B9 chip missing -> CHIP_MISSING', chipMissing.verified === false && chipMissing.code === 'CHARACTER_ATTACHMENT_CHIP_MISSING', chipMissing);
  const malformedPicker = SLG.verifyCharacterAttachmentSelection({ expectedTag: CH1, pickerTag: CH1, pickerToken: 'garbage', chipToken: asb(T1) });
  check('B10 malformed picker token -> IDENTITY_UNREADABLE', malformedPicker.verified === false && malformedPicker.code === 'CHARACTER_ATTACHMENT_IDENTITY_UNREADABLE', malformedPicker);
  const malformedChip = SLG.verifyCharacterAttachmentSelection({ expectedTag: CH1, pickerTag: CH1, pickerToken: asb(T1), chipToken: 'garbage' });
  check('B10b malformed chip token -> IDENTITY_UNREADABLE', malformedChip.verified === false && malformedChip.code === 'CHARACTER_ATTACHMENT_IDENTITY_UNREADABLE', malformedChip);
  const tagMismatch = SLG.verifyCharacterAttachmentSelection({ expectedTag: CH1, pickerTag: CH2, pickerToken: asb(T2), chipToken: asb(T2) });
  check('B11 picker tag != expected -> CHARACTER_PICKER_IDENTITY_UNAVAILABLE', tagMismatch.verified === false && tagMismatch.code === 'CHARACTER_PICKER_IDENTITY_UNAVAILABLE', tagMismatch);
  const pickerMissing = SLG.verifyCharacterAttachmentSelection({ expectedTag: CH1, pickerTag: null, pickerToken: null, chipToken: null });
  check('B12 expected tag not found -> CHARACTER_PICKER_IDENTITY_UNAVAILABLE', pickerMissing.verified === false && pickerMissing.code === 'CHARACTER_PICKER_IDENTITY_UNAVAILABLE', pickerMissing);

  // set-level
  const setOk = SLG.verifyCharacterAttachmentSet([CH1, CH2], [tx(CH1, T1), tx(CH2, T2)]);
  check('B13 a complete verified set passes', setOk.ok === true, setOk);
  check('B14 a missing verified transaction fails', SLG.verifyCharacterAttachmentSet([CH1, CH2], [tx(CH1, T1)]).ok === false);
  check('B15 a duplicate verified transaction fails', SLG.verifyCharacterAttachmentSet([CH1], [tx(CH1, T1), tx(CH1, T1)]).ok === false);
}

console.log('--- C. character chip classification ---');
{
  const tx = (tag: string, token: string) => ({ expectedTag: tag, pickerToken: token, chipToken: token, verified: true, code: 'CHARACTER_ATTACHMENT_VERIFIED' });
  const charEv = (chips: string[], evidence: any[] = []) => ({ chipSrcs: [] as string[], railEntries: [], characterChipSrcs: chips, characterAttachmentEvidence: evidence });
  check('C13 an exact single character -> EXACT', SLG.classifyIngredientEvidence([CH1], charEv([asb(T1)], [tx(CH1, T1)])).state === 'EXACT');
  check('C14 all four characters -> EXACT', SLG.classifyIngredientEvidence([CH1, CH2, CH3, CH4], charEv([asb(T1), asb(T2), asb(T3), asb(T4)], [tx(CH1, T1), tx(CH2, T2), tx(CH3, T3), tx(CH4, T4)])).state === 'EXACT');
  check('C15 a chip with no verified transaction -> IDENTITY_UNRESOLVED', SLG.classifyIngredientEvidence([CH1], charEv([asb(T1)], [])).state === 'IDENTITY_UNRESOLVED');
  check('C16 an unverified transaction -> IDENTITY_UNRESOLVED', SLG.classifyIngredientEvidence([CH1], charEv([asb(T1)], [{ ...tx(CH1, T1), verified: false, code: 'CHARACTER_ATTACHMENT_IDENTITY_MISMATCH' }])).state === 'IDENTITY_UNRESOLVED');
  check('C17 a duplicate character chip -> DUPLICATE', SLG.classifyIngredientEvidence([CH1], charEv([asb(T1), asb(T1)], [tx(CH1, T1), tx(CH1, T1)])).state === 'DUPLICATE');
  check('C18 an unexpected character chip -> UNEXPECTED', SLG.classifyIngredientEvidence([CH1], charEv([asb(T1), asb(T2)], [tx(CH1, T1), tx(CH2, T2)])).state === 'UNEXPECTED');
  check('C19 a missing expected character -> MISSING', SLG.classifyIngredientEvidence([CH1, CH2], charEv([asb(T1)], [tx(CH1, T1)])).state === 'MISSING');
  check('C19b a chip present but no chip-count match -> IDENTITY_UNRESOLVED', SLG.classifyIngredientEvidence([CH1], charEv([asb(T1), asb(T2)], [tx(CH1, T1)])).state === 'IDENTITY_UNRESOLVED');
}

console.log('--- D. mixed background + character ---');
{
  const tx = (tag: string, token: string) => ({ expectedTag: tag, pickerToken: token, chipToken: token, verified: true, code: 'CHARACTER_ATTACHMENT_VERIFIED' });
  const bgOk = { chipSrcs: [BGD_SRC], railEntries: RAIL };
  check('D20 exact BGD + exact ARJUN -> EXACT', SLG.classifyIngredientEvidence([BG, CH1], { ...bgOk, characterChipSrcs: [asb(T1)], characterAttachmentEvidence: [tx(CH1, T1)] }).state === 'EXACT');
  check('D21 exact BGD + ARJUN + MAA -> EXACT', SLG.classifyIngredientEvidence([BG, CH1, CH2], { ...bgOk, characterChipSrcs: [asb(T1), asb(T2)], characterAttachmentEvidence: [tx(CH1, T1), tx(CH2, T2)] }).state === 'EXACT');
  check('D22 background exact but character unresolved -> fail',
    SLG.verifyIngredientEvidence([BG, CH1], { ...bgOk, characterChipSrcs: [asb(T1)], characterAttachmentEvidence: [] }).ok === false);
  check('D23 background exact but wrong character -> fail',
    SLG.classifyIngredientEvidence([BG, CH1], { ...bgOk, characterChipSrcs: [asb(T2)], characterAttachmentEvidence: [tx(CH2, T2)] }).state === 'MISSING');
  check('D24 duplicate character -> fail',
    SLG.classifyIngredientEvidence([BG, CH1], { ...bgOk, characterChipSrcs: [asb(T1), asb(T1)], characterAttachmentEvidence: [tx(CH1, T1), tx(CH1, T1)] }).state === 'DUPLICATE');
}

console.log('--- E. DOM reader regression ---');
{
  const flowSrc = await fs.readFile(`${SRC}/flowClient.ts`, 'utf8');
  const start = flowSrc.indexOf('async readSceneComposerIngredientEvidence(');
  const next = flowSrc.indexOf('tokens of all currently attached character chips', start);
  const reader = flowSrc.slice(start, next > 0 ? next : flowSrc.length);
  const scStart = flowSrc.indexOf('async selectCharacterAssetWithVerification(');
  const scNext = flowSrc.indexOf('\n  async ', scStart + 10);
  const selection = flowSrc.slice(scStart, scNext > 0 ? scNext : flowSrc.length);
  const fStart = flowSrc.indexOf('private async findCharacterPickerRowIdentity(');
  const fNext = flowSrc.indexOf('\n  async ', fStart + 10);
  const finder = flowSrc.slice(fStart, fNext > 0 ? fNext : flowSrc.length);
  check('E25 the background chip selector uses flow-image-ingredient-chip', /flow-image-ingredient-chip/.test(reader));
  check('E26 the character chip selector uses flow-character-ingredient-chip', /flow-character-ingredient-chip/.test(reader));
  check('E27 the generic aria-label="Ingredient" is never identity', !/aria-label="Ingredient"/.test(reader) && !/chip-container/.test(reader));
  check('E28 ProseMirror contenteditable=false is never identity', !/contenteditable/.test(reader) && !/contenteditable/.test(selection) && !/contenteditable/.test(finder));
  check('E29 the picker row tag comes from span.asset-title', /assetTitle|asset-title/.test(finder));
  check('E30 the picker identity comes from the row image src', /getAttribute\('src'\)/.test(finder));
  check('E30b the reader does NOT do post-attachment character picker lookup',
    !/assetPicker/.test(reader) && !/addIngredients/.test(reader) && !/readCharacterPickerIdentityEntries/.test(reader));
  check('E30c the reader no longer references a character picker map', !/characterPickerEntries/.test(flowSrc) && !/buildCharacterPickerIdentityMap/.test(flowSrc));
}

console.log('--- F. session behaviour ---');
{
  const slgSrc = await fs.readFile(`${SRC}/sceneLocalGeneration.ts`, 'utf8');
  const lifeSrc = await fs.readFile(`${SRC}/sceneProductionLifecycle.ts`, 'utf8');
  const flowSrc = await fs.readFile(`${SRC}/flowClient.ts`, 'utf8');
  const wfSrc = await fs.readFile(`${SRC}/sceneFlowWorkflow.ts`, 'utf8');
  check('F31 the character helpers are pure (no fs/persistence imports)', !/from 'node:fs/.test(slgSrc) && !/writeFile/.test(slgSrc));
  check('F31b the lifecycle never writes tokens to disk', !/writeFile|writeSceneCheckpoint|pipeline\.json/.test(lifeSrc));
  check('F32 no character token field exists in the checkpoint schema', !/characterToken|asbToken|character_picker|characterPicker|pickerToken|chipToken/i.test(wfSrc));
  const readerBody = flowSrc.slice(flowSrc.indexOf('async readSceneComposerIngredientEvidence('), flowSrc.indexOf('tokens of all currently attached character chips'));
  const selBody = flowSrc.slice(flowSrc.indexOf('async selectCharacterAssetWithVerification('), flowSrc.indexOf('\n  async ', flowSrc.indexOf('async selectCharacterAssetWithVerification(') + 10));
  check('F32b the reader/selection do not persist tokens (no write calls)', !/writeFile|writeSceneCheckpoint|appendFile/.test(readerBody) && !/writeFile|writeSceneCheckpoint|appendFile/.test(selBody));
  const fStart = flowSrc.indexOf('private async findCharacterPickerRowIdentity(');
  const fNext = flowSrc.indexOf('\n  async ', fStart + 10);
  const finder = flowSrc.slice(fStart, fNext > 0 ? fNext : flowSrc.length);
  check('F33 the pre-selection picker lookup is bounded (finite MAX_STEPS, no scrollHeight exhaustion)',
    /MAX_STEPS = 30/.test(finder) && /step < MAX_STEPS/.test(finder) && !/scrollHeight/.test(finder));
  check('F34 the selection verifies the token in the SAME session (before vs after chip tokens)',
    /beforeTokens/.test(flowSrc.slice(flowSrc.indexOf('async selectCharacterAssetWithVerification('), flowSrc.indexOf('\n  async ', flowSrc.indexOf('async selectCharacterAssetWithVerification(') + 10))) && /afterTokens/.test(flowSrc));
  check('F35 token comparison is transient (verifyCharacterAttachmentSelection is pure)',
    /export function verifyCharacterAttachmentSelection/.test(slgSrc) && !/globalThis|process\.env/.test(slgSrc));
}

console.log('--- G. existing background regression ---');
{
  check('G35 the known BGD UUID mapping remains EXACT', SLG.classifyIngredientEvidence([BG], { chipSrcs: [BGD_SRC], railEntries: RAIL }).state === 'EXACT');
  const rotated = `https://flow-content.google/image/${U_BG}?Expires=999999&KeyName=other&Signature=ROTATED`;
  check('G36 signed query parameter changes do not break BGD identity',
    SLG.classifyIngredientEvidence([BG], { chipSrcs: [rotated], railEntries: RAIL }).state === 'EXACT');
}

console.log('--- H. selection delegation (Defect 2 fix) ---');
{
  const flowSrc = await fs.readFile(`${SRC}/flowClient.ts`, 'utf8');
  const scStart = flowSrc.indexOf('async selectCharacterAssetWithVerification(');
  const scNext = flowSrc.indexOf('\n  async ', scStart + 10);
  const scBody = flowSrc.slice(scStart, scNext > 0 ? scNext : flowSrc.length);
  const fStart = flowSrc.indexOf('private async findCharacterPickerRowIdentity(');
  const fNext = flowSrc.indexOf('\n  async ', fStart + 10);
  const finder = flowSrc.slice(fStart, fNext > 0 ? fNext : flowSrc.length);

  check('H1 identity is captured BEFORE selection (finder call precedes selectAsset call)',
    scBody.indexOf('findCharacterPickerRowIdentity') > 0 && scBody.indexOf('findCharacterPickerRowIdentity') < scBody.indexOf('await this.selectAsset(tag)'));
  check('H2 actual selection is delegated to the proven selectAsset()', /await this\.selectAsset\(tag\)/.test(scBody));
  check('H3 the selection method does NOT duplicate the proven picker click path',
    !/\.row\.click/.test(scBody) && !/scrollIntoViewIfNeeded/.test(scBody) && !/waitForAssetRowToSettle/.test(scBody) && !/waitForAssetSearchResultsToSettle/.test(scBody));
  check('H4 the identity-capture finder NEVER clicks a row', !/\.click\(/.test(finder));
  check('H5 the identity-capture picker is closed WITHOUT selecting, before selectAsset runs',
    scBody.indexOf("keyboard.press('Escape')") > 0 && scBody.indexOf("keyboard.press('Escape')") < scBody.indexOf('await this.selectAsset(tag)'));
  check('H6 selectAsset is the ONLY method that clicks a character row (no bespoke row.click anywhere)',
    (flowSrc.match(/\.row\.click/g) ?? []).length === 0);
  check('H7 the transaction requires BOTH pickerToken and chipToken (pure verifier)', /verifyCharacterAttachmentSelection/.test(scBody) && /beforeTokens/.test(scBody) && /afterTokens/.test(scBody));
  check('H8 no token persistence in the selection path', !/writeFile|writeSceneCheckpoint|appendFile/.test(scBody));
  check('H9 exactly one character-selection implementation exists (no parallel selector)',
    (flowSrc.match(/async selectCharacterAssetWithVerification/g) ?? []).length === 1);
}

console.log('--- I. picker identity-capture diagnostics ---');
{
  const base = { step: 0, pickerOpen: true, addIngredientsVisible: false, charactersCategoryVisible: true, charactersCategoryActive: true, renderedRowCount: 3, renderedTags: ['@CHAR-04-DADI'], expectedTagFound: false, tokenReadable: false };
  check('I1 picker closed -> PICKER_NOT_OPEN', SLG.classifyCharacterPickerDiagnostic({ ...base, pickerOpen: false }) === 'PICKER_NOT_OPEN');
  check('I2 picker open but Characters category inactive -> CATEGORY_NOT_ACTIVE', SLG.classifyCharacterPickerDiagnostic({ ...base, charactersCategoryActive: false }) === 'CATEGORY_NOT_ACTIVE');
  check('I2b Characters category not visible -> CATEGORY_NOT_ACTIVE', SLG.classifyCharacterPickerDiagnostic({ ...base, charactersCategoryVisible: false }) === 'CATEGORY_NOT_ACTIVE');
  check('I3 Characters active with zero rows -> NO_ROWS_RENDERED', SLG.classifyCharacterPickerDiagnostic({ ...base, renderedRowCount: 0, renderedTags: [] }) === 'NO_ROWS_RENDERED');
  check('I4 Characters active with rendered rows and tag absent -> EXPECTED_TAG_ABSENT', SLG.classifyCharacterPickerDiagnostic(base) === 'EXPECTED_TAG_ABSENT');
  check('I4b all rendered titles empty -> TITLE_EMPTY', SLG.classifyCharacterPickerDiagnostic({ ...base, renderedTags: ['', ''] }) === 'TITLE_EMPTY');
  check('I5 expected tag present and token readable -> RESOLVED', SLG.classifyCharacterPickerDiagnostic({ ...base, renderedTags: ['@CHAR-01-ARJUN'], expectedTagFound: true, tokenReadable: true }) === 'RESOLVED');
  check('I6 expected tag absent -> EXPECTED_TAG_ABSENT', SLG.classifyCharacterPickerDiagnostic({ ...base, expectedTagFound: false }) === 'EXPECTED_TAG_ABSENT');
  check('I7 expected tag present but image/token unreadable -> TOKEN_UNREADABLE', SLG.classifyCharacterPickerDiagnostic({ ...base, expectedTagFound: true, tokenReadable: false }) === 'TOKEN_UNREADABLE');
  check('I8 malformed diagnostic -> UNKNOWN', SLG.classifyCharacterPickerDiagnostic(undefined as any) === 'UNKNOWN' && SLG.classifyCharacterPickerDiagnostic(null as any) === 'UNKNOWN');

  const flowSrc = await fs.readFile(`${SRC}/flowClient.ts`, 'utf8');
  const fStart = flowSrc.indexOf('private async findCharacterPickerRowIdentity(');
  const fNext = flowSrc.indexOf('\n  async ', fStart + 10);
  const finder = flowSrc.slice(fStart, fNext > 0 ? fNext : flowSrc.length);
  const dStart = flowSrc.indexOf('private async readCharacterPickerStepDiagnostic(');
  const dNext = flowSrc.indexOf('private async findCharacterPickerRowIdentity(', dStart + 10);
  const diag = flowSrc.slice(dStart, dNext > 0 ? dNext : flowSrc.length);
  check('I9 the lookup is bounded (finite MAX_STEPS, no scrollHeight exhaustion)', /MAX_STEPS = 30/.test(finder) && /step < MAX_STEPS/.test(finder) && !/scrollHeight/.test(finder));
  check('I10 the diagnostic captures the rendered tag list', /renderedTags/.test(diag) && /expectedTagFound/.test(diag) && /tokenReadable/.test(diag) && /renderedRowCount/.test(diag));
  check('I11 neither the finder nor the diagnostic clicks a row', !/\.click\(/.test(finder) && !/\.click\(/.test(diag));
  check('I12 no token persistence in the finder/diagnostic', !/writeFile|writeSceneCheckpoint|appendFile/.test(finder) && !/writeFile|writeSceneCheckpoint|appendFile/.test(diag));
  check('I13 the finder still returns the identity {tag, token} (successful resolution unchanged)', /return \{ identity: \{ tag: title, token \}, diagnostics \}/.test(finder));
  check('I14 selectAsset retains its proven settle+scroll+click path (untouched by this change)',
    /resolveRow\(\)\.scrollIntoViewIfNeeded/.test(flowSrc) && /resolveRow\(\)\.click\(\)/.test(flowSrc) && /waitForAssetRowToSettle\(resolveRow\)/.test(flowSrc));
  check('I15 the diagnostic is read-only and pre-selection only (never selects)', !/this\.selectAsset\(/.test(diag) && !/\.click\(/.test(diag));
  check('I16 the verifier surfaces diagnostics without weakening the code', /diagnostics/.test(flowSrc.slice(flowSrc.indexOf('async selectCharacterAssetWithVerification('), flowSrc.indexOf('\n  async ', flowSrc.indexOf('async selectCharacterAssetWithVerification(') + 10))) && SLG.verifyCharacterAttachmentSelection({ expectedTag: CH1, pickerTag: null, pickerToken: null, chipToken: null, diagnostics: [base] }).code === 'CHARACTER_PICKER_IDENTITY_UNAVAILABLE');
}

console.log(`\n${passed} ingredient-identity checks passed (fully offline).`);
