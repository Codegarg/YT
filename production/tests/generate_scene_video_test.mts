// Focused OFFLINE regression tests for the two repaired generateSceneVideo() defects:
//   1. artifact-UUID delta must come from readGenerationSurfaceArtifactIds() (never listProjectVideos())
//   2. ingredient verification must use ACTUAL chip evidence (never raw prompt text)
// Pure-helper tests + a browser-free source audit of the method body. NO browser, NO Flow, NO credits.
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const VD = await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);
const SLG = await import(pathToFileURL(`${SRC}/sceneLocalGeneration.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const BG = '#BGD-01-ARJUN-ROOM-WIDE';
const CH = '@CHAR-01-ARJUN';

// ============ 3/5/6/7. UUID delta via the existing pure helper ============
console.log('--- artifact UUID delta (newArtifactIds) ---');
{
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const C = '33333333-3333-4333-8333-333333333333';

  const one = VD.newArtifactIds([A, B], [A, B, C]);
  check('3 before/after UUID delta yields exactly one UUID', one.kind === 'ok' && one.artifactId === C, one);
  check('7 the returned artifactId is the real UUID string', one.kind === 'ok' && /^[0-9a-f-]{36}$/.test(one.artifactId), one);

  const zero = VD.newArtifactIds([A, B], [A, B]);
  check('6 zero new UUIDs fail closed (kind "none")', zero.kind === 'none', zero);

  const many = VD.newArtifactIds([A], [A, B, C]);
  check('5 multiple new UUIDs fail closed (kind "ambiguous")', many.kind === 'ambiguous', many);

  const dupes = VD.newArtifactIds([A], [A, B, B]);
  check('5b duplicate ids on the surface fail closed', dupes.kind === 'ambiguous', dupes);

  // 4. listProjectVideos() returns OBJECTS (artifactId always '') — they must never become identity.
  const objects = [{ title: 'x', artifactId: '' }, { title: 'y', artifactId: '' }];
  const fromObjects = VD.newArtifactIds(objects as any, objects as any);
  check('4 listProjectVideos()-shaped objects can never yield a valid artifact id', fromObjects.kind !== 'ok', fromObjects);
  const mixed = VD.newArtifactIds([], objects as any);
  check('4b an object-array delta cannot produce kind "ok" with a real id', mixed.kind !== 'ok' || /^[0-9a-f-]{36}$/.test((mixed as any).artifactId) === false, mixed);
}

// ============ 10-16. ingredient evidence (resolved chip identity) ============
console.log('--- ingredient chip identity ---');
{
  const BGD_SRC = 'https://flow-content.google/image/ccef4b18-bd27-49ca-913b-9df3b6b91e06?Expires=1&KeyName=k&Signature=s';
  const CH_TOKEN = 'ANqvLOZFRtN_rGJtVov-uurQdHR9u_I8251JrG98HK2zZ5w06';
  const CH_SRC = `https://lh3.googleusercontent.com/asb/${CH_TOKEN}?s=1`;
  const RAIL = [{ tag: BG, src: BGD_SRC }];
  const CH_EV = { expectedTag: CH, pickerToken: CH_TOKEN, chipToken: CH_TOKEN, verified: true, code: 'CHARACTER_ATTACHMENT_VERIFIED' };
  const exact = { chipSrcs: [BGD_SRC], railEntries: RAIL, characterChipSrcs: [CH_SRC], characterAttachmentEvidence: [CH_EV] };

  check('10 exact resolved chip evidence passes', SLG.verifyIngredientEvidence([BG, CH], exact).ok === true);

  const noBg = SLG.verifyIngredientEvidence([BG, CH], { chipSrcs: [], railEntries: RAIL, characterChipSrcs: [CH_SRC], characterAttachmentEvidence: [CH_EV] });
  check('11 a background represented only as TEXT (no chip) does NOT satisfy verification', noBg.ok === false && /MISSING/.test(noBg.reason), noBg);
  const noCh = SLG.verifyIngredientEvidence([BG, CH], { chipSrcs: [BGD_SRC], railEntries: RAIL, characterChipSrcs: [], characterAttachmentEvidence: [] });
  check('12 a character represented only as TEXT (no chip) does NOT satisfy verification', noCh.ok === false && /MISSING/.test(noCh.reason), noCh);

  const missBg = SLG.classifyIngredientEvidence([BG, CH], { chipSrcs: [], railEntries: RAIL, characterChipSrcs: [CH_SRC], characterAttachmentEvidence: [CH_EV] });
  check('13 a missing background chip fails', missBg.state === 'MISSING' && missBg.missing.join(',') === BG, missBg);
  const missCh = SLG.classifyIngredientEvidence([BG, CH], { chipSrcs: [BGD_SRC], railEntries: RAIL, characterChipSrcs: [], characterAttachmentEvidence: [] });
  check('14 a missing character chip fails', missCh.state === 'MISSING' && missCh.missing.join(',') === CH, missCh);

  const dup = SLG.verifyIngredientEvidence([BG, CH], { chipSrcs: [BGD_SRC], railEntries: RAIL, characterChipSrcs: [CH_SRC, CH_SRC], characterAttachmentEvidence: [CH_EV, CH_EV] });
  check('15 a duplicated ingredient chip fails', dup.ok === false && /DUPLICATE/.test(dup.reason), dup);

  const ghostSrc = 'https://lh3.googleusercontent.com/asb/ZZZZZZZZZZZZZZZZZZZZ?s=1';
  const ghostEv = { expectedTag: '@CHAR-09-GHOST', pickerToken: 'ZZZZZZZZZZZZZZZZZZZZ', chipToken: 'ZZZZZZZZZZZZZZZZZZZZ', verified: true, code: 'CHARACTER_ATTACHMENT_VERIFIED' };
  const unexp = SLG.verifyIngredientEvidence([BG, CH], { chipSrcs: [BGD_SRC], railEntries: RAIL, characterChipSrcs: [CH_SRC, ghostSrc], characterAttachmentEvidence: [CH_EV, ghostEv] });
  check('16 an unexpected ingredient chip fails', unexp.ok === false && /UNEXPECTED/.test(unexp.reason), unexp);

  const unresolved = SLG.verifyIngredientEvidence([BG, CH], { chipSrcs: [BGD_SRC], railEntries: RAIL, characterChipSrcs: [CH_SRC], characterAttachmentEvidence: [] });
  check('16b a character chip with no verified transaction fails closed (IDENTITY_UNRESOLVED)', unresolved.ok === false && /IDENTITY_UNRESOLVED/.test(unresolved.reason), unresolved);
  check('16c malformed evidence fails closed', SLG.verifyIngredientEvidence([BG, CH], undefined as any).ok === false);
}

// ============ 1/2/8/9/17. source audit of generateSceneVideo() ============
console.log('--- generateSceneVideo source audit ---');
{
  const src = await fs.readFile(`${SRC}/flowClient.ts`, 'utf8');
  const start = src.indexOf('async generateSceneVideo(');
  const nextMethod = src.indexOf('\n  async ', start + 10);
  const body = start >= 0 ? src.slice(start, nextMethod > 0 ? nextMethod : src.length) : '';
  check('AUDIT generateSceneVideo exists', start >= 0 && body.length > 0);

  // 1/2. BOTH before and after identity come from readGenerationSurfaceArtifactIds().
  const beforeRead = /const beforeIds = await this\.readGenerationSurfaceArtifactIds\(/.test(body);
  const afterRead = /const afterIds = await this\.readGenerationSurfaceArtifactIds\(/.test(body);
  check('1 before artifact IDs come from readGenerationSurfaceArtifactIds()', beforeRead, body.slice(0, 200));
  check('2 after artifact IDs come from readGenerationSurfaceArtifactIds()', afterRead);

  // 3. delta uses the existing pure helper.
  check('3 the delta uses the existing pure newArtifactIds(before, after)', /newArtifactIds\(beforeIds, afterIds\)/.test(body));

  // 4. listProjectVideos() objects are NEVER used for identity.
  check('4 listProjectVideos() is NOT CALLED for artifact identity', !/this\.listProjectVideos\(/.test(body), 'listProjectVideos() called');

  // 5/6. exactly-one requirement + fail closed.
  check('5/6 the delta result must be kind "ok" (fail closed otherwise)', /delta\.kind !== 'ok'/.test(body));
  check('7 the method returns { title: \'\', artifactId: delta.artifactId }', /return \{ title: '', artifactId: delta\.artifactId \}/.test(body));

  // 8. exactly ONE generation click.
  check('8 generateSceneVideo performs exactly ONE generation click', (body.match(/gen\.click\(\)/g) ?? []).length === 1, (body.match(/gen\.click\(\)/g) ?? []).length);

  // 9. chips are re-established after the prompt fill (not merely filled over).
  check('9 the prompt is filled then expected chips are re-established via selectAsset',
    /editor\.fill\(text\)/.test(body) && /await this\.selectAsset\(tag\)/.test(body));
  check('9b the chip re-establishment is idempotent (only missing chips are selected)',
    /if \(!presentTags\.includes\(tag\)\)/.test(body) && /classifyIngredientEvidence\(expected, present\)\.resolvedTags/.test(body));

  // 10. verification uses ACTUAL evidence, never the old raw-text includes check.
  check('10 the guard verifies CHIP evidence via verifyIngredientEvidence', /verifyIngredientEvidence\(expected, evidence\)/.test(body));
  check('10b the guard reads evidence via readSceneComposerIngredientEvidence()', /readSceneComposerIngredientEvidence\(\)/.test(body));
  check('11/12 the old raw-text includes() guard is GONE', !/composerText[\s\S]{0,80}\.includes\(t\)/.test(body) && !/promptBox\.innerText\(\)/.test(body));
  check('13/14 a failed chip verification throws (fail closed)', /if \(!verdict\.ok\) throw new Error/.test(body));

  // 17. the existing project-level generator is unchanged in its identity model.
  const gpStart = src.indexOf('async generateProjectVideo(');
  const gpNext = src.indexOf('\n  async ', gpStart + 10);
  const gpBody = src.slice(gpStart, gpNext > 0 ? gpNext : src.length);
  check('17 generateProjectVideo still exists', gpStart >= 0 && gpBody.length > 0);
  check('17b generateProjectVideo still uses readGenerationSurfaceArtifactIds + newArtifactIds',
    /readGenerationSurfaceArtifactIds\(\)/.test(gpBody) && /newArtifactIds\(beforeIds, afterIds\)/.test(gpBody));
  check('17c generateProjectVideo is unchanged in returning identity.artifactId', /artifactId: identity\.artifactId/.test(gpBody));

  // The evidence reader is a read-only DOM probe keyed on the PROVEN ingredient DOM.
  const evStart = src.indexOf('async readSceneComposerIngredientEvidence(');
  const evNext = src.indexOf('tokens of all currently attached character chips', evStart);
  const evBody = src.slice(evStart, evNext > 0 ? evNext : src.length);
  check('EV the reader uses the PROVEN ingredient DOM (flow-image-ingredient-chip + flow-character-ingredient-chip + img.chip-image)',
    /flow-image-ingredient-chip/.test(evBody) && /flow-character-ingredient-chip/.test(evBody) && /img\.chip-image/.test(evBody));
  check('EV2 the reader uses the navigation-rail identity source (button.thumbnail-button[aria-label])',
    /button\.thumbnail-button\[aria-label\]/.test(evBody));
  check('EV2b the reader does NOT do post-attachment character picker lookup',
    !/readCharacterPickerIdentityEntries/.test(evBody) && !/assetPicker/.test(evBody) && !/addIngredients/.test(evBody));
  check('EV3 the reader NO LONGER uses [contenteditable="false"] as ingredient evidence',
    !/contenteditable/.test(evBody) && !/textOnly/.test(evBody));

  // The character SELECTION method captures picker identity BEFORE the click.
  const scStart = src.indexOf('async selectCharacterAssetWithVerification(');
  const scNext = src.indexOf('\n  async ', scStart + 10);
  const scBody = src.slice(scStart, scNext > 0 ? scNext : src.length);
  check('EV4 selectCharacterAssetWithVerification captures the picker row identity BEFORE selection (identity capture only)',
    /findCharacterPickerRowIdentity/.test(scBody) && /assetPicker/.test(scBody) && !/\.row\.click/.test(scBody));
  check('EV5 actual selection is DELEGATED to the proven selectAsset() (no bespoke row click)',
    /await this\.selectAsset\(tag\)/.test(scBody) && !/scrollIntoViewIfNeeded/.test(scBody) && !/\.row\.click/.test(scBody) && !/waitForAssetRowToSettle/.test(scBody));
  check('EV6 the identity-capture picker is closed WITHOUT selecting before selectAsset runs',
    scBody.indexOf("keyboard.press('Escape')") > 0 && scBody.indexOf("keyboard.press('Escape')") < scBody.indexOf('await this.selectAsset(tag)'));
  check('EV7 the transaction compares pickerToken to chipToken via the pure verifier',
    /verifyCharacterAttachmentSelection/.test(scBody) && /beforeTokens/.test(scBody) && /afterTokens/.test(scBody));
}

// ============ P1–P10. prompt-editor resolution (fail-closed, DOM editability) ============
console.log('--- prompt-editor resolver ---');
{
  const editable = (index: number, over: any = {}) => ({ index, exists: true, visible: true, editable: true, ariaReadonly: false, disabled: false, ...over });
  const nonEditable = (index: number, over: any = {}) => ({ index, exists: true, visible: true, editable: false, ariaReadonly: false, disabled: false, ...over });

  // A. one contenteditable=false + one contenteditable=true -> selects the editable one
  const a = SLG.resolvePromptEditorCandidate([nonEditable(0), editable(1)]);
  check('P1 a non-editable ProseMirror first + an editable one -> the editable candidate wins',
    a.ok === true && a.index === 1 && a.eligibleCount === 1, a);
  check('P1b reversed order still selects the editable candidate',
    SLG.resolvePromptEditorCandidate([editable(0), nonEditable(1)]).index === 0);

  // B. multiple candidates, only one visible/editable
  const b = SLG.resolvePromptEditorCandidate([
    nonEditable(0), editable(1, { visible: false }), editable(2), editable(3, { ariaReadonly: true }),
  ]);
  check('P2 hidden, aria-readonly and non-editable candidates are skipped for the one truly editable',
    b.ok === true && b.index === 2 && b.eligibleCount === 1, b);

  // C. all candidates non-editable -> fail closed
  const c = SLG.resolvePromptEditorCandidate([nonEditable(0), nonEditable(1)]);
  check('P3 all candidates non-editable -> fail closed with PROMPT_EDITOR_NOT_EDITABLE',
    c.ok === false && c.code === 'PROMPT_EDITOR_NOT_EDITABLE' && /editable/.test(String(c.reason)), c);
  check('P3b no candidates at all -> fail closed with PROMPT_EDITOR_NOT_FOUND',
    (() => { const r = SLG.resolvePromptEditorCandidate([]); return r.ok === false && r.code === 'PROMPT_EDITOR_NOT_FOUND'; })());
  check('P3c a null/undefined candidate list is rejected, never treated as success',
    SLG.resolvePromptEditorCandidate(null as any).ok === false && SLG.resolvePromptEditorCandidate(undefined as any).ok === false);

  // D. aria-readonly rejected
  check('P4 an aria-readonly="true" candidate is rejected even when editable',
    SLG.isEligiblePromptEditor(editable(0, { ariaReadonly: true })) === false);
  check('P4b the resolver refuses when the ONLY editable candidate is aria-readonly',
    SLG.resolvePromptEditorCandidate([editable(0, { ariaReadonly: true })]).ok === false);

  // E. disabled rejected
  check('P5 a disabled candidate is rejected',
    SLG.isEligiblePromptEditor(editable(0, { disabled: true })) === false);

  // F. hidden rejected
  check('P6 a hidden candidate is rejected',
    SLG.isEligiblePromptEditor(editable(0, { visible: false })) === false);

  // G. an existing valid prompt editor succeeds
  const g = SLG.resolvePromptEditorCandidate([editable(0)]);
  check('P7 an existing valid editable prompt editor resolves', g.ok === true && g.index === 0, g);
  check('P7b a non-existent candidate is rejected',
    SLG.isEligiblePromptEditor({ index: 0, exists: false, visible: true, editable: true, ariaReadonly: false, disabled: false }) === false);
  check('P7c the deterministic tie-break is the lowest-index ELIGIBLE candidate',
    SLG.resolvePromptEditorCandidate([nonEditable(0), editable(5), editable(2)]).index === 2);

  // H. `.first()` is never the sole selection criterion
  const flowSrc = await fs.readFile(`${SRC}/flowClient.ts`, 'utf8');
  const genStart = flowSrc.indexOf('async generateSceneVideo(');
  const genBody = flowSrc.slice(genStart, flowSrc.indexOf('\n  /**', genStart));
  const resStart = flowSrc.indexOf('private async resolveScenePromptEditor(');
  // The resolver ends at the next method declaration (not necessarily generateSceneVideo).
  const resEnd = flowSrc.indexOf('\n  async ', resStart + 10) > 0
    ? Math.min(...[flowSrc.indexOf('\n  async ', resStart + 10), flowSrc.indexOf('\n  private async ', resStart + 10)].filter((i) => i > 0))
    : flowSrc.length;
  const resBody = flowSrc.slice(resStart, resEnd);
  check('P8 the generate path no longer selects the editor with `.first()`',
    !/SCENE_LOCAL_GENERATE_CONTROLS\.proseMirror\)\.first\(\)/.test(genBody) && !/\.ProseMirror[\s\S]{0,40}\.first\(\)/.test(genBody), genBody.slice(0, 200));
  check('P8b the resolver measures DOM editability (contenteditable / aria-readonly / disabled / visibility)',
    /getComputedStyle/.test(resBody) && /contenteditable/.test(resBody) && /aria-readonly/.test(resBody) && /hasAttribute\('disabled'\)|aria-disabled/.test(resBody));
  check('P8c the resolver enumerates EVERY candidate and delegates to the pure decision',
    /proseMirror\.nth\(index\)\.evaluate/.test(resBody) && /resolvePromptEditorCandidate/.test(resBody));
  check('P8d the resolver throws a fail-closed refusal instead of filling an invalid element',
    /promptEditorRefusal/.test(resBody) && /PROMPT_EDITOR_NOT_EDITABLE/.test(resBody));
  check('P8e the scoped editable selector is explicitly contenteditable="true"',
    SLG.SCENE_LOCAL_GENERATE_CONTROLS.proseMirrorEditable === ".ProseMirror[contenteditable='true']"
    && /proseMirrorEditable/.test(resBody));
  check('P8f the resolution failure message names the refusal code',
    /generateSceneVideo refused: \$\{code\}|generateSceneVideo refused/.test(SLG.promptEditorRefusal({ ok: false, code: 'PROMPT_EDITOR_NOT_EDITABLE', reason: 'x' })));

  // I. the existing prompt text + generation behavior is preserved
  check('P9 the resolved editor is still clicked then filled with the SAME prompt text',
    /await editor\.click\(\);\s*await editor\.fill\(text\)/.test(genBody) && /const text = String\(prompt \?\? ''\)\.trim\(\)/.test(genBody));
  check('P9b exactly ONE Start-generation click is still performed, unchanged',
    (genBody.match(/\.click\(\)/g) ?? []).length === 2 && /await gen\.click\(\)/.test(genBody));
  check('P9c the ingredient re-check, chip verification and UUID delta are unchanged',
    /readSceneComposerIngredientEvidence/.test(genBody) && /verifyIngredientEvidence/.test(genBody) && /newArtifactIds/.test(genBody));

  // J. the resolver introduces no asset/character/settings/generation change
  check('P10 the resolver does not touch asset or character verification',
    !/listRailAssetTags|listCharacterPickerTags|verifyAssetLocks|verifyCharacterAttachmentSelection|selectCharacterAssetWithVerification|selectAsset/.test(resBody));
  check('P10b the resolver never clicks Start generation and never mutates the prompt',
    !/Start generation|generateButton|generateSceneVideo/.test(resBody) && !/\.fill\(/.test(resBody));
  check('P10c asset verification + character attachment code is untouched by this change',
    !/resolvePromptEditorCandidate|promptEditorRefusal/.test(await fs.readFile(`${SRC}/assetVerification.ts`, 'utf8')));
  const selBody = flowSrc.slice(flowSrc.indexOf('async selectAsset(tag:string)'), flowSrc.indexOf('\n  // ------', flowSrc.indexOf('async selectAsset(tag:string)')));
  check('P10d selectAsset() is untouched by the prompt-editor change',
    !/resolvePromptEditorCandidate|promptEditorRefusal|ProseMirror/.test(selBody));
}

console.log(`\n${passed} generateSceneVideo regression checks passed (fully offline).`);
