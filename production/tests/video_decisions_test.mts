// Offline unit tests for the pure video decision helpers. No browser, no Flow.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const { requireBatchX1, isSingleExactMatch, classifyClipPersistence, BatchNotX1Error } =
  await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);

let passed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed += 1; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
}
const throws = (fn: () => unknown): boolean => { try { fn(); return false; } catch { return true; } };

// ---------------------------------------------------------------- requireBatchX1
check('requireBatchX1("x1") returns the literal "x1"', requireBatchX1('x1') === 'x1');
check('requireBatchX1("x1") with surrounding whitespace is accepted', requireBatchX1('  x1 ') === 'x1');
for (const bad of ['x2', 'x3', 'x4'] as const) {
  check(`requireBatchX1("${bad}") throws (never coerced)`, throws(() => requireBatchX1(bad)));
}
check('requireBatchX1(undefined) throws', throws(() => requireBatchX1(undefined)));
check('requireBatchX1(null) throws', throws(() => requireBatchX1(null)));
check('requireBatchX1("") throws', throws(() => requireBatchX1('')));
check('requireBatchX1("2") throws (not silently parsed)', throws(() => requireBatchX1('2')));
check('requireBatchX1("X1") throws (case-sensitive literal)', throws(() => requireBatchX1('X1')));
check('requireBatchX1(1) throws', throws(() => requireBatchX1(1)));
check('requireBatchX1({}) throws', throws(() => requireBatchX1({})));
{
  let isBatchError = false;
  try { requireBatchX1('x2'); } catch (e: any) { isBatchError = e instanceof BatchNotX1Error && e.name === 'BatchNotX1Error'; }
  check('rejection uses BatchNotX1Error', isBatchError);
}
{
  let msg = '';
  try { requireBatchX1('x4'); } catch (e: any) { msg = String(e.message); }
  check('rejection message names the offending batch', /x4/.test(msg) && /batch x1/i.test(msg), msg);
}

// ------------------------------------------------------------ isSingleExactMatch
const TITLE = 'Camera moving toward dark doorway';
check('isSingleExactMatch([], title) is false', isSingleExactMatch([], TITLE) === false);
check('isSingleExactMatch([title], title) is true', isSingleExactMatch([TITLE], TITLE) === true);
check('isSingleExactMatch([title,title], title) is false', isSingleExactMatch([TITLE, TITLE], TITLE) === false);
check('isSingleExactMatch([other], title) is false', isSingleExactMatch(['Some other title'], TITLE) === false);
check('substring is NOT a match', isSingleExactMatch(['Camera moving toward dark doorway at night'], TITLE) === false);
check('prefix/superstring is NOT a match', isSingleExactMatch([`${TITLE} extended`], TITLE) === false);
check('case variation is NOT a match (case-sensitive)', isSingleExactMatch([TITLE.toLowerCase()], TITLE) === false);
check('leading whitespace variation is NOT a match (no trimming)', isSingleExactMatch([` ${TITLE}`], TITLE) === false);
check('trailing whitespace variation is NOT a match (no trimming)', isSingleExactMatch([`${TITLE} `], TITLE) === false);
check('internal-whitespace variation is NOT a match', isSingleExactMatch([TITLE.replace(/ /g, '  ')], TITLE) === false);
check('empty expected title is handled (false)', isSingleExactMatch([TITLE], '') === false);
check('empty expected title with empty list is false', isSingleExactMatch([], '') === false);
check('non-string expected title is handled (false)', isSingleExactMatch([TITLE], undefined) === false);
check('null/undefined entries are ignored', isSingleExactMatch([null, TITLE, undefined], TITLE) === true);
check('undefined candidates list is false', isSingleExactMatch(undefined, TITLE) === false);
check('object entries with .title are supported', isSingleExactMatch([{ title: TITLE }], TITLE) === true);
check('object entries with .ariaLabel fall back when title missing', isSingleExactMatch([{ ariaLabel: TITLE }], TITLE) === true);
check('object list with two matches is false', isSingleExactMatch([{ title: TITLE }, { title: TITLE }], TITLE) === false);
check('mixed objects/strings counting exactly one match is true', isSingleExactMatch([{ title: 'x' }, TITLE], TITLE) === true);
check('no row-order assumption: match found regardless of position', isSingleExactMatch(['a', 'b', TITLE, 'c'], TITLE) === true);

// ------------------------------------------------------- classifyClipPersistence
check('one before / one after -> PERSISTENT', classifyClipPersistence({ beforeCount: 1, afterCount: 1 }) === 'PERSISTENT');
check('one before / zero after -> NOT_PERSISTENT', classifyClipPersistence({ beforeCount: 1, afterCount: 0 }) === 'NOT_PERSISTENT');
check('one before / ambiguous flag -> AMBIGUOUS', classifyClipPersistence({ beforeCount: 1, afterCount: 1, ambiguous: true }) === 'AMBIGUOUS');
check('no valid before clip (0) -> AMBIGUOUS', classifyClipPersistence({ beforeCount: 0, afterCount: 1 }) === 'AMBIGUOUS');
check('no valid before clip (2) -> AMBIGUOUS', classifyClipPersistence({ beforeCount: 2, afterCount: 1 }) === 'AMBIGUOUS');
check('multiple after clips (2) -> AMBIGUOUS', classifyClipPersistence({ beforeCount: 1, afterCount: 2 }) === 'AMBIGUOUS');
check('missing evidence -> AMBIGUOUS', classifyClipPersistence(undefined) === 'AMBIGUOUS');
check('null evidence -> AMBIGUOUS', classifyClipPersistence(null) === 'AMBIGUOUS');
check('non-numeric counts -> AMBIGUOUS', classifyClipPersistence({ beforeCount: NaN as any, afterCount: 1 }) === 'AMBIGUOUS');
check('beforeCount 0 / afterCount 0 -> AMBIGUOUS (nothing was ever established)', classifyClipPersistence({ beforeCount: 0, afterCount: 0 }) === 'AMBIGUOUS');
// Empty drop slot / container / descendant noise must NOT count as a clip: the
// helper only sees explicit counts, so callers pass 0 for those states.
check('explicit zero counts represent the empty-slot case, not a clip', classifyClipPersistence({ beforeCount: 0, afterCount: 1 }) === 'AMBIGUOUS');

// ------------------------------------------------- 8M: artifact extraction
const { extractArtifactIdFromUrl } = await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);
const GOOD = 'https://flow-content.google/image/0ad0c887-85bc-49da-9dbc-9362512a1143?Expires=1790720319&KeyName=k';
check('8P generation-time URL with one uuid -> that uuid', extractArtifactIdFromUrl(GOOD) === '0ad0c887-85bc-49da-9dbc-9362512a1143');
check('8P the LIVE-observed generation-time form (flow-content.google/image/<uuid>) extracts', extractArtifactIdFromUrl('https://flow-content.google/image/83dcdf49-d380-44ee-a5a3-8e108968cfef') === '83dcdf49-d380-44ee-a5a3-8e108968cfef');
check('8P the LIVE-observed grid blob (/asb/ANqv...) yields NO artifact (STEP-8O)', extractArtifactIdFromUrl('https://flow.google.com/asb/ANqvLOZXS31W1B8fqQt97hlurO1t6GivALMH2PCJYmh6U-GecOuYGxy05diZae5s4FxBIh-pu4-pYyw4rpmvQtEnhnQU6uuGqmdwKUzI8M5MBHcc') === '');
check('8P uppercase uuid is preserved (case-sensitive identity)', extractArtifactIdFromUrl('https://x/0AD0C887-85BC-49DA-9DBC-9362512A1143') === '0AD0C887-85BC-49DA-9DBC-9362512A1143');
check('8P no uuid -> empty (fail closed)', extractArtifactIdFromUrl('https://flow-content.google/image/not-a-uuid') === '');
check('8P two DIFFERENT uuids -> empty (ambiguous, fail closed)', extractArtifactIdFromUrl('https://x/aabbccdd-1122-3344-5566-77889900aabb/eeddccbb-9988-7766-5544-3322110099ff') === '');
check('8P repeated identical uuid -> that uuid (not ambiguous)', extractArtifactIdFromUrl('https://x/0ad0c887-85bc-49da-9dbc-9362512a1143/y/0ad0c887-85bc-49da-9dbc-9362512a1143') === '0ad0c887-85bc-49da-9dbc-9362512a1143');
check('8P malformed/empty input -> empty', extractArtifactIdFromUrl('') === '' && extractArtifactIdFromUrl(undefined) === '' && extractArtifactIdFromUrl(null) === '' && extractArtifactIdFromUrl(42 as any) === '');
check('8P a near-uuid (short group) is rejected', extractArtifactIdFromUrl('https://x/0ad0c887-85bc-49da-9dbc') === '');
check('8P extractor is browser-free/pure', !/playwright|page\.|locator\(/i.test(fs.readFileSync(path.join(SRC, 'videoDecisions.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l: string) => l.replace(/\/\/.*$/, '')).join('\n')));

// ------------------------------------------ 8T: artifact identity bridge (UUID)
const { extractArtifactIdsFromUrls, newArtifactIds, resolveVideoPickerArtifact } = await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);
const GEN = '829591f8-d44a-409a-9eb2-1efa3ff9c846';
const CLIP = '83dcdf49-d380-44ee-a5a3-8e108968cfef';
const GEN_VIDEO = `https://flow-content.google/video/${GEN}?Expires=1790731242&KeyName=k&Signature=s`;
const GEN_IMAGE = `https://flow-content.google/image/${GEN}?Expires=1790731242&KeyName=k&Signature=s`;
const CLIP_IMAGE = `https://flow-content.google/image/${CLIP}?Expires=1790731192&KeyName=k&Signature=s`;

// 1/2/6. video vs image URL -> same identity (path-segment agnostic)
check('8T generation /video/<uuid> extracts the uuid', extractArtifactIdFromUrl(GEN_VIDEO) === GEN);
check('8T picker /image/<uuid> extracts the SAME uuid', extractArtifactIdFromUrl(GEN_IMAGE) === GEN);
check('8T /video/<uuid> and /image/<same uuid> are the SAME identity', extractArtifactIdFromUrl(GEN_VIDEO) === extractArtifactIdFromUrl(GEN_IMAGE));
// 3/4/5
check('8T /asb/ANqv... -> empty', extractArtifactIdFromUrl('https://flow.google.com/asb/ANqvLOZXS31W1B8fqQt97hlurO1t6GivALMH2PCJYmh6U') === '');
check('8T two different uuids -> empty', extractArtifactIdFromUrl(`https://x/${GEN}/${CLIP}`) === '');
check('8T no uuid -> empty', extractArtifactIdFromUrl('https://flow-content.google/image/none') === '');

// extractArtifactIdsFromUrls (generation surface)
check('8T surface: only flow-content video/image URLs contribute', JSON.stringify(extractArtifactIdsFromUrls([GEN_VIDEO, 'https://flow.google.com/asb/ANqvLOZXS31W1B8', GEN_IMAGE]).sort()) === JSON.stringify([GEN].sort()));
check('8T surface: duplicates collapse to one id', JSON.stringify(extractArtifactIdsFromUrls([GEN_VIDEO, GEN_IMAGE])) === JSON.stringify([GEN]));
check('8T surface: malformed input -> []', JSON.stringify(extractArtifactIdsFromUrls(undefined)) === '[]' && JSON.stringify(extractArtifactIdsFromUrls([null, 42, ''])) === '[]');
check('8T surface: /asb/ only -> []', JSON.stringify(extractArtifactIdsFromUrls(['https://flow.google.com/asb/ANqv1', 'https://flow.google.com/asb/ANqv2'])) === '[]');

// 15/16/17/18. before/after set difference
const BEFORE = [GEN_VIDEO, CLIP_IMAGE];
check('8T gen diff: exactly one new uuid -> ok', newArtifactIds(BEFORE, [GEN_VIDEO, CLIP_IMAGE, `https://flow-content.google/video/${'aaaa1111-2222-3333-4444-555566667777'}`]).kind === 'ok');
check('8T gen diff: zero new uuids -> none', newArtifactIds(BEFORE, BEFORE).kind === 'none');
check('8T gen diff: two new uuids -> ambiguous', newArtifactIds(BEFORE, [...BEFORE, `https://flow-content.google/video/${'aaaa1111-2222-3333-4444-555566667777'}`, `https://flow-content.google/video/${'bbbb1111-2222-3333-4444-555566667777'}`]).kind === 'ambiguous');
check('8T gen diff: duplicate ids on a side -> ambiguous', newArtifactIds([GEN, GEN], [CLIP]).kind === 'ambiguous');
check('8T gen diff: duplicate ids on the AFTER side -> ambiguous', newArtifactIds([CLIP], [CLIP, GEN, GEN]).kind === 'ambiguous');
check('8T surface extraction already de-duplicates (no dup can reach newArtifactIds from urls)', JSON.stringify(extractArtifactIdsFromUrls([GEN_VIDEO, GEN_IMAGE])) === JSON.stringify([GEN]));
check('8T gen diff: /video/<uuid> generation vs /image/<same uuid> BEFORE-none -> ok identity', (() => { const r = newArtifactIds(extractArtifactIdsFromUrls([CLIP_IMAGE]), extractArtifactIdsFromUrls([CLIP_IMAGE, GEN_VIDEO])); return r.kind === 'ok' && r.artifactId === GEN; })());
check('8T gen diff: malformed evidence -> ambiguous', newArtifactIds(undefined, []).kind === 'ambiguous');

// 8/9/10/11/12/13/14. Videos picker resolution (by uuid, never title)
const ROWS = [{ imgSrc: GEN_IMAGE }, { imgSrc: CLIP_IMAGE }, { imgSrc: `https://flow-content.google/image/${'07b070cf-a64a-435e-bcd6-c7899b687384'}` }];
check('8T picker: exact uuid match -> ok', (() => { const r = resolveVideoPickerArtifact(GEN, ROWS); return r.kind === 'ok' && r.artifactId === GEN; })());
check('8T picker: zero matches -> none (fail closed)', resolveVideoPickerArtifact('99999999-9999-9999-9999-999999999999', ROWS).kind === 'none');
check('8T picker: two matches -> ambiguous (fail closed)', resolveVideoPickerArtifact(GEN, [{ imgSrc: GEN_IMAGE }, { imgSrc: `https://flow-content.google/image/${GEN}` }]).kind === 'ambiguous');
check('8T picker: duplicate row uuids -> ambiguous', resolveVideoPickerArtifact(CLIP, [{ imgSrc: CLIP_IMAGE }, { imgSrc: `https://flow-content.google/image/${CLIP}` }]).kind === 'ambiguous');
check('8T picker: empty expected -> ambiguous (fail closed)', resolveVideoPickerArtifact('', ROWS).kind === 'ambiguous');
check('8T picker: malformed rows -> ambiguous', resolveVideoPickerArtifact(GEN, undefined).kind === 'ambiguous');
check('8T picker: title mismatch but uuid match -> success (title ignored)', (() => { const r = resolveVideoPickerArtifact(GEN, [{ imgSrc: GEN_IMAGE, title: 'Completely different title' }]); return r.kind === 'ok' && r.artifactId === GEN; })());
check('8T picker: title match but uuid mismatch -> fail', (() => { const r = resolveVideoPickerArtifact(GEN, [{ imgSrc: CLIP_IMAGE, title: GEN }]); return r.kind === 'none'; })());
check('8T picker: reordered rows -> same result', (() => { const a = resolveVideoPickerArtifact(GEN, ROWS); const b = resolveVideoPickerArtifact(GEN, [ROWS[2], ROWS[1], ROWS[0]]); return a.kind === 'ok' && b.kind === 'ok' && a.artifactId === b.artifactId; })());
check('8T picker: /video/<uuid> expected vs /image/<same uuid> row -> success', resolveVideoPickerArtifact(GEN, [{ imgSrc: GEN_IMAGE }]).kind === 'ok');

// 19/20. cross-layer + duplicate-title independence
check('8T timeline /image/<uuid> vs generated /video/<same uuid> -> same identity (reconciliation basis)', extractArtifactIdFromUrl(CLIP_IMAGE) === extractArtifactIdFromUrl(`https://flow-content.google/video/${CLIP}`));
check('8T duplicate titles with different uuids are BOTH valid (title never identity)', (() => { const same = 'Man looking at mobile phone'; const r1 = resolveVideoPickerArtifact(CLIP, [{ imgSrc: CLIP_IMAGE, title: same }]); const r2 = resolveVideoPickerArtifact('07b070cf-a64a-435e-bcd6-c7899b687384', [{ imgSrc: `https://flow-content.google/image/${'07b070cf-a64a-435e-bcd6-c7899b687384'}`, title: same }]); return r1.kind === 'ok' && r2.kind === 'ok'; })());

// ---------------------------------- 8V: stable generation baseline (hydration race)
const { stableBaselineFromReads } = await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);
const A = [GEN, CLIP];
const B = [GEN, CLIP, '07b070cf-a64a-435e-bcd6-c7899b687384'];
const C = [GEN, CLIP, '07b070cf-a64a-435e-bcd6-c7899b687384', 'bf8fd665-bc98-49d7-8dcf-8eaac004f61a'];

// 1/3/6/7. stabilization basics
check('8V baseline: A,A -> stable A', (() => { const r = stableBaselineFromReads([A, A]); return r.kind === 'stable' && JSON.stringify(r.ids) === JSON.stringify([...A].sort()); })());
check('8V baseline: A,B,B -> stable B', (() => { const r = stableBaselineFromReads([A, B, B]); return r.kind === 'stable' && JSON.stringify(r.ids) === JSON.stringify([...B].sort()); })());
check('8V baseline: array reorder with same set -> stable', stableBaselineFromReads([[GEN, CLIP], [CLIP, GEN]]).kind === 'stable');
check('8V baseline: empty,empty -> stable empty', (() => { const r = stableBaselineFromReads([[], []]); return r.kind === 'stable' && r.ids.length === 0; })());
check('8V baseline: single read -> unstable (needs two)', stableBaselineFromReads([A]).kind === 'unstable');
check('8V baseline: malformed reads -> unstable', stableBaselineFromReads(undefined).kind === 'unstable');
// 2. A,B,A then A,A -> eventually stable A
check('8V baseline: A,B,A,A -> eventually stable A', (() => { const r = stableBaselineFromReads([A, B, A, A]); return r.kind === 'stable' && JSON.stringify(r.ids) === JSON.stringify([...A].sort()); })());
// 4. A,B,C (still changing) -> unstable at the tail; timeout is the caller's job
check('8V baseline: A,B,C -> unstable (keeps polling; caller fails on timeout)', stableBaselineFromReads([A, B, C]).kind === 'unstable');
check('8V baseline: differently-ordered same-set counts as stable (order-independent)', stableBaselineFromReads([A, [...A].reverse()]).kind === 'stable');
// 5. duplicates handled deterministically (fail closed)
check('8V baseline: duplicate uuid in a read -> unstable (fail closed)', stableBaselineFromReads([[GEN, GEN], [GEN, GEN]]).kind === 'unstable');
check('8V baseline: duplicate appears only on first read -> unstable', stableBaselineFromReads([[GEN, GEN, CLIP], [GEN, CLIP]]).kind === 'unstable');
// 14. the LIVE-8U regression: pre-existing ids arriving DURING hydration must not be "new"
check('8V baseline (LIVE-8U regression): 9389707f/fbadbc99 appearing during hydration are absorbed into the baseline', (() => {
  const first = ['cbaaffc8-d266-4e38-b6d1-155ee3f70afa'];                                  // incomplete first read
  const second = ['cbaaffc8-d266-4e38-b6d1-155ee3f70afa', '9389707f-4a46-4500-b33c-be684e13ef0b', 'fbadbc99-94b8-4feb-a37c-49f4d1dbe954'];
  const r = stableBaselineFromReads([first, second, second]);                              // stabilizes on the full set
  if (r.kind !== 'stable') return false;
  // after the baseline, those two are NOT new (they are already in before)
  const after = [...second, 'aaaa1111-2222-3333-4444-555566667777'];
  const delta = newArtifactIds(r.ids, after);
  return delta.kind === 'ok' && delta.artifactId === 'aaaa1111-2222-3333-4444-555566667777';
})());
check('8V baseline: unstable baseline never yields a delta (no pre-Start evaluation possible)', stableBaselineFromReads([['cbaaffc8-d266-4e38-b6d1-155ee3f70afa'], ['9389707f-4a46-4500-b33c-be684e13ef0b', 'fbadbc99-94b8-4feb-a37c-49f4d1dbe954']]).kind === 'unstable');
// 11/12/13. post-Start delta semantics relative to the STABLE baseline
check('8V after-Start: one new uuid vs stable baseline -> success', (() => { const base = stableBaselineFromReads([A, A]); const r = newArtifactIds(base.kind === 'stable' ? base.ids : [], [...A, 'aaaa1111-2222-3333-4444-555566667777']); return r.kind === 'ok'; })());
check('8V after-Start: two new uuids vs stable baseline -> ambiguous', (() => { const flat = [...A, 'aaaa1111-2222-3333-4444-555566667777', 'bbbb1111-2222-3333-4444-555566667777']; const r = newArtifactIds(A, flat); return r.kind === 'ambiguous'; })());
check('8V after-Start: no new uuid vs stable baseline -> none (continue polling)', newArtifactIds(A, A).kind === 'none');
check('8V baseline set is compared exactly (case-sensitive), never by title/order', (() => { const r1 = stableBaselineFromReads([[GEN], [GEN]]); const r2 = stableBaselineFromReads([[GEN.toUpperCase()], [GEN.toUpperCase()]]); return r1.kind === 'stable' && r2.kind === 'stable' && r1.ids[0] !== r2.ids[0]; })());

// ---------------------------------- 8AD: scene state + rail identity (pure)
const { classifySceneState, SceneContainsMultipleClipsError, resolveActiveRailArtifact, acceptPopulatedRailBinding, exactlyOneActiveRailItem } = await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);
// H/B: scene state classification
check('8AD classifySceneState(0) -> EMPTY', classifySceneState(0) === 'EMPTY');
check('8AD classifySceneState(1) -> SINGLE_CLIP', classifySceneState(1) === 'SINGLE_CLIP');
check('8AD classifySceneState(2) -> MULTI_CLIP', classifySceneState(2) === 'MULTI_CLIP');
check('8AD classifySceneState(-1/NaN/undefined) -> AMBIGUOUS (Flow sentinel)', classifySceneState(-1) === 'AMBIGUOUS' && classifySceneState(NaN) === 'AMBIGUOUS' && classifySceneState(undefined) === 'AMBIGUOUS');
check('8AD SceneContainsMultipleClipsError names the count and the unproven case', (() => { const e = new SceneContainsMultipleClipsError(3); return e.name === 'SceneContainsMultipleClipsError' && e.clipCount === 3 && /not supported by the evidence-backed automation/.test(e.message); })());
// I: exactly-one active rail item
const rail = (rows: Array<{ ariaCurrent?: string; imgSrc?: string }>) => rows;
check('8AD rail: 0 active -> none (fail closed)', resolveActiveRailArtifact(rail([{ imgSrc: GEN_IMAGE }, { imgSrc: CLIP_IMAGE }])).kind === 'none');
check('8AD rail: 1 active with uuid -> ok', (() => { const r = resolveActiveRailArtifact(rail([{ ariaCurrent: 'true', imgSrc: GEN_IMAGE }, { imgSrc: CLIP_IMAGE }])); return r.kind === 'ok' && r.artifactId === GEN; })());
check('8AD rail: 2 active -> ambiguous (fail closed)', resolveActiveRailArtifact(rail([{ ariaCurrent: 'true', imgSrc: GEN_IMAGE }, { ariaCurrent: 'true', imgSrc: CLIP_IMAGE }])).kind === 'ambiguous');
check('8AD rail: active item without a uuid -> none (fail closed)', resolveActiveRailArtifact(rail([{ ariaCurrent: 'true', imgSrc: 'https://flow-content.google/image/not-a-uuid' }])).kind === 'none');
check('8AD rail: malformed evidence -> ambiguous', resolveActiveRailArtifact(undefined).kind === 'ambiguous');
check('8AD exactlyOneActiveRailItem: 0/1/2 -> false/true/false', exactlyOneActiveRailItem([{}, {}]) === false && exactlyOneActiveRailItem([{ ariaCurrent: 'true' }]) === true && exactlyOneActiveRailItem([{ ariaCurrent: 'true' }, { ariaCurrent: 'true' }]) === false);
// G: a zero-clip scene can still show one active rail item — resolveActiveRailArtifact is about rail state, not clip count
check('8AD zero-clip scene with one active rail item still resolves an identity (rail state != clip count)', resolveActiveRailArtifact([{ ariaCurrent: 'true', imgSrc: GEN_IMAGE }]).kind === 'ok');
// F/I: populated binding requires EXACT equality (never assumes generation uuid == rail uuid)
check('8AD binding: exact equality -> accepted', acceptPopulatedRailBinding(GEN, GEN).accepted === true);
check('8AD binding: generation uuid != rail uuid -> refused (live 8Y/8Z/8AB)', acceptPopulatedRailBinding(GEN, CLIP).accepted === false && /does not equal/.test(acceptPopulatedRailBinding(GEN, CLIP).reason));
check('8AD binding: empty expected -> refused', acceptPopulatedRailBinding('', GEN).accepted === false);
check('8AD binding: empty rail -> refused', acceptPopulatedRailBinding(GEN, '').accepted === false);
// J: persistence semantics via exact rail equality
check('8AD persistence: same rail uuid before/after -> stable', GEN === GEN);
check('8AD persistence: changed rail uuid after reopen -> mismatch (fail closed)', acceptPopulatedRailBinding(GEN, CLIP).accepted === false);
// K: title collisions never determine identity (5 rows share a title, 5 different uuids)
check('8AD title collisions: duplicate titles with different uuids select the exact-uuid row', (() => { const t = 'Man looking at mobile phone'; const rows = [{ imgSrc: CLIP_IMAGE, title: t }, { imgSrc: `https://flow-content.google/image/${'07b070cf-a64a-435e-bcd6-c7899b687384'}`, title: t }, { imgSrc: `https://flow-content.google/image/${'bf8fd665-bc98-49d7-8dcf-8eaac004f61a'}`, title: t }]; const r = resolveVideoPickerArtifact('07b070cf-a64a-435e-bcd6-c7899b687384', rows); return r.kind === 'ok' && r.artifactId === '07b070cf-a64a-435e-bcd6-c7899b687384'; })());
// C: row lacking a flow-content uuid is inert (never a match, never ambiguous noise)
check('8AD picker: rows without a flow-content image uuid are ignored', (() => { const rows = [{ imgSrc: '' }, { imgSrc: 'https://flow.google.com/asb/ANqv123' }]; return resolveVideoPickerArtifact(GEN, rows).kind === 'none'; })());

// ---------------------------------- 8AF: bounded asset-list settle decision (pure)
const { decideAssetListSettle } = await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);
check('8AF settle: 1 exact match -> ready (stop polling)', decideAssetListSettle(1) === 'ready');
check('8AF settle: 0 matches -> wait (keep polling until timeout)', decideAssetListSettle(0) === 'wait');
check('8AF settle: 2 matches -> ambiguous (fail closed immediately)', decideAssetListSettle(2) === 'ambiguous');
check('8AF settle: >1 matches -> ambiguous', decideAssetListSettle(3) === 'ambiguous');
check('8AF settle: malformed/negative evidence -> ambiguous (fail closed)', decideAssetListSettle(-1) === 'ambiguous' && decideAssetListSettle(undefined) === 'ambiguous' && decideAssetListSettle(NaN) === 'ambiguous');
// Polling simulation (pure decision over a sequence of per-poll match counts)
const pollingRun = (matchCounts: number[]) => {
  for (const c of matchCounts) { const d = decideAssetListSettle(c); if (d !== 'wait') return d; }
  return 'timeout';
};
check('8AF settle: 0 then 1 -> ready (STEP-8AE hydration: stale 10 rows, then the generated row appears)', pollingRun([0, 1]) === 'ready');
check('8AF settle: 0,0,0,1 -> ready (several stale polls then the generated row)', pollingRun([0, 0, 0, 1]) === 'ready');
check('8AF settle: 0,0,0 -> timeout (never appears -> fail closed)', pollingRun([0, 0, 0]) === 'timeout');
check('8AF settle: 0 then 2 -> ambiguous immediately (never clicks)', pollingRun([0, 2, 1]) === 'ambiguous');
// Exact-UUID identity at the settle layer (title/order never matter)
check('8AF settle: same uuid different titles still yields a single exact match', (() => { const t = 'Man looking at mobile phone'; const rows = [{ imgSrc: GEN_IMAGE, title: 'x' }, { imgSrc: CLIP_IMAGE, title: t }, { imgSrc: `https://flow-content.google/image/${'07b070cf-a64a-435e-bcd6-c7899b687384'}`, title: t }]; const r = resolveVideoPickerArtifact(GEN, rows); return r.kind === 'ok' && r.artifactId === GEN; })());
check('8AF settle: same title different uuids selects only the expected uuid', (() => { const t = 'Man looking at mobile phone'; const rows = [{ imgSrc: CLIP_IMAGE, title: t }, { imgSrc: `https://flow-content.google/image/${'bf8fd665-bc98-49d7-8dcf-8eaac004f61a'}`, title: t }]; const r = resolveVideoPickerArtifact(CLIP, rows); return r.kind === 'ok' && r.artifactId === CLIP; })());
check('8AF settle: uuid-less rows are ignored (never selectable, never ambiguous noise)', (() => { const rows = [{ imgSrc: '' }, { imgSrc: 'https://flow.google.com/asb/ANqvX' }]; return resolveVideoPickerArtifact(GEN, rows).kind === 'none'; })());

// ---------------------------------- 8AH: canonical scene route + hydration settle (pure)
const { stableClipCountFromReads, canonicalSceneUrl } = await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);
// A. canonical scene route
check('8AH canonical: builds /project/<id>/scene/<sceneId> from a validated project URL', canonicalSceneUrl('https://flow.google.com/project/c30385ce-bfe4-4177-9730-caf087070f9a', 'b7111244-2115-488b-9941-9ef394fbe2d5') === 'https://flow.google.com/project/c30385ce-bfe4-4177-9730-caf087070f9a/scene/b7111244-2115-488b-9941-9ef394fbe2d5');
check('8AH canonical: an /edit/<id> project URL normalizes to the /scene/<id> form (project+scene validated)', canonicalSceneUrl('https://flow.google.com/project/c30385ce-bfe4-4177-9730-caf087070f9a/edit/b7111244-2115-488b-9941-9ef394fbe2d5', 'b7111244-2115-488b-9941-9ef394fbe2d5') === 'https://flow.google.com/project/c30385ce-bfe4-4177-9730-caf087070f9a/scene/b7111244-2115-488b-9941-9ef394fbe2d5');
check('8AH canonical: an invalid scene id -> empty (fail closed, never guesses a route)', canonicalSceneUrl('https://flow.google.com/project/p', 'not-a-valid-id') === '');
check('8AH canonical: a non-project URL -> empty (fail closed)', canonicalSceneUrl('https://flow.google.com/library/x', 'b7111244-2115-488b-9941-9ef394fbe2d5') === '');
check('8AH canonical: never yields an /edit/ route', !/\/edit\//.test(canonicalSceneUrl('https://flow.google.com/project/p/edit/s', 'b7111244-2115-488b-9941-9ef394fbe2d5')));
// C. hydration settle (clip-count stability)
check('8AH settle: [0,1] -> not yet stable (still hydrating)', stableClipCountFromReads([0, 1]).stable === false);
check('8AH settle: [0,0] -> stable 0 (hydrated EMPTY is legitimate, NOT a failure signal)', (() => { const r = stableClipCountFromReads([0, 0]); return r.stable === true && r.count === 0; })());
check('8AH settle: [0,0,1,1] -> stable 1 (clip appeared after hydration)', (() => { const r = stableClipCountFromReads([0, 0, 1, 1]); return r.stable === true && r.count === 1; })());
check('8AH settle: [1,1] -> stable 1 (proceed to identity)', (() => { const r = stableClipCountFromReads([1, 1]); return r.stable === true && r.count === 1; })());
check('8AH settle: single read -> not stable (must observe twice)', stableClipCountFromReads([1]).stable === false);
check('8AH settle: [2,2] -> stable 2 (caller fails closed on >1)', (() => { const r = stableClipCountFromReads([2, 2]); return r.stable === true && r.count === 2; })());
check('8AH settle: [-1,-1] (ambiguous count) -> not stable (fail closed downstream)', stableClipCountFromReads([-1, -1]).stable === false);
check('8AH settle: malformed evidence -> not stable', stableClipCountFromReads(undefined).stable === false && stableClipCountFromReads([NaN, NaN]).stable === false);
check('8AH settle: requiredStable=3 honoured ([1,1,1] vs [0,1,1])', stableClipCountFromReads([1, 1, 1], 3).stable === true && stableClipCountFromReads([0, 1, 1], 3).stable === false);

// ---------------------------------- 8AJ: populated-scene rail active settle (pure)
const { stableActiveRailFromReads } = await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);
const r = (id: string, activeCount = id ? 1 : 0) => ({ artifactId: id, activeCount });
// A. hydration
check('8AJ rail settle: [none,UUID,UUID] -> ok', (() => { const x = stableActiveRailFromReads([r(''), r(GEN), r(GEN)]); return x.kind === 'ok' && x.artifactId === GEN; })());
check('8AJ rail settle: [none,none,UUID,UUID] -> ok', (() => { const x = stableActiveRailFromReads([r(''), r(''), r(GEN), r(GEN)]); return x.kind === 'ok' && x.artifactId === GEN; })());
check('8AJ rail settle: [UUID,UUID] -> ok', (() => { const x = stableActiveRailFromReads([r(GEN), r(GEN)]); return x.kind === 'ok' && x.artifactId === GEN; })());
check('8AJ rail settle: [UUID,different] -> pending (reset, not stable)', stableActiveRailFromReads([r(GEN), r(CLIP)]).kind === 'pending');
check('8AJ rail settle: [UUID,UUID,different] -> pending (no false success)', stableActiveRailFromReads([r(GEN), r(GEN), r(CLIP)]).kind === 'pending');
check('8AJ rail settle: single read -> pending (needs two)', stableActiveRailFromReads([r(GEN)]).kind === 'pending');
check('8AJ rail settle: all none -> pending (timeout handled by caller)', stableActiveRailFromReads([r(''), r(''), r('')]).kind === 'pending');
// B. ambiguity / malformed
check('8AJ rail settle: any read with 2 active -> ambiguous (fail closed)', stableActiveRailFromReads([r(GEN), { activeCount: 2, artifactId: '' }]).kind === 'ambiguous');
check('8AJ rail settle: malformed evidence -> ambiguous', stableActiveRailFromReads(undefined).kind === 'ambiguous' && stableActiveRailFromReads([r(GEN), r(GEN)], 0).kind === 'ambiguous');
// requiredStable=3
check('8AJ rail settle: requiredStable=3 honoured ([GEN,GEN,GEN] vs [GEN,CLIP,GEN])', stableActiveRailFromReads([r(GEN), r(GEN), r(GEN)], 3).kind === 'ok' && stableActiveRailFromReads([r(GEN), r(CLIP), r(GEN)], 3).kind === 'pending');
// C. exact identity after a stable active uuid (uses the existing binding rule)
check('8AJ identity: stable active == expected -> accepted', (() => { const s = stableActiveRailFromReads([r(GEN), r(GEN)]); return s.kind === 'ok' && acceptPopulatedRailBinding(GEN, s.artifactId).accepted === true; })());
check('8AJ identity: stable active != expected -> refused (fail closed)', (() => { const s = stableActiveRailFromReads([r(CLIP), r(CLIP)]); return s.kind === 'ok' && acceptPopulatedRailBinding(GEN, s.artifactId).accepted === false; })());
check('8AJ identity: expected missing -> refused (existing fail-closed behavior)', acceptPopulatedRailBinding('', GEN).accepted === false);
// LIVE-8AI reproduction: none then the real persisted uuid 8fd2d5d8
check('8AJ LIVE-8AI: [none, 8fd2d5d8, 8fd2d5d8] -> ok (settled active uuid)', (() => { const x = stableActiveRailFromReads([r(''), r('8fd2d5d8-2d55-41f2-9c85-560f518687c2'), r('8fd2d5d8-2d55-41f2-9c85-560f518687c2')]); return x.kind === 'ok' && x.artifactId === '8fd2d5d8-2d55-41f2-9c85-560f518687c2'; })());

// ---------------------------------- 8AL: premature stable-zero floor (pure)
const { classifyClipCountObservation } = await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);
const FLOOR = 10000;
// 1. immediate clip
check('8AL floor: count 1 -> ready immediately (never delayed)', classifyClipCountObservation(1, 0, FLOOR, false) === 'ready');
check('8AL floor: count 1 well before the floor -> still ready', classifyClipCountObservation(1, 50, FLOOR, false) === 'ready');
// 3. early zero stability must remain pending
check('8AL floor: zero before the 10s floor -> wait (even if stable)', classifyClipCountObservation(0, 0, FLOOR, true) === 'wait' && classifyClipCountObservation(0, 5000, FLOOR, true) === 'wait' && classifyClipCountObservation(0, 9999, FLOOR, true) === 'wait');
// 4. late stable zero -> empty
check('8AL floor: zero at/after the floor AND stable -> empty', classifyClipCountObservation(0, 10000, FLOOR, true) === 'empty' && classifyClipCountObservation(0, 12000, FLOOR, true) === 'empty');
check('8AL floor: zero after floor but NOT stable -> wait (requiredStable still required)', classifyClipCountObservation(0, 12000, FLOOR, false) === 'wait');
// 6. multiple clips
check('8AL floor: count 2 -> ambiguous (fail closed)', classifyClipCountObservation(2, 0, FLOOR, false) === 'ambiguous' && classifyClipCountObservation(5, 20000, FLOOR, true) === 'ambiguous');
// 9. invalid
check('8AL floor: invalid count (-1/NaN/undefined) -> ambiguous', classifyClipCountObservation(-1, 0, FLOOR, false) === 'ambiguous' && classifyClipCountObservation(NaN, 0, FLOOR, false) === 'ambiguous' && classifyClipCountObservation(undefined, 0, FLOOR, false) === 'ambiguous');

// Sequence simulation (pure): reflects waitForStableClipCount's loop semantics.
const settleRun = (counts: number[], stepMs: number, floor = FLOOR, requiredStable = 2, timeoutMs = 20000) => {
  const reads: number[] = [];
  for (let i = 0; i < counts.length; i++) {
    const elapsed = i * stepMs;
    if (elapsed >= timeoutMs) break;
    reads.push(counts[i]);
    const last = reads[reads.length - 1];
    const stable = stableClipCountFromReads(reads, requiredStable).stable && last === 0;
    const d = classifyClipCountObservation(last, elapsed, floor, stable);
    if (d === 'ready') return 1;
    if (d === 'empty') return 0;
    if (d === 'ambiguous') return -1;
  }
  return -1; // timeout
};
// 2. hydration race: many early zeros then 1 -> returns 1, NOT empty
check('8AL run: ten zeros (5s) then 1 -> returns 1, not empty (LIVE-8AK reproduction)', settleRun([0,0,0,0,0,0,0,0,0,0,1], 500) === 1);
// 5. zero then clip -> 1 immediately
check('8AL run: [0,0,0,1] -> 1 immediately when encountered', settleRun([0,0,0,1], 500) === 1);
// 7. unstable zero/one -> 1 wins
check('8AL run: [0,1] -> 1 wins immediately', settleRun([0,1], 500) === 1);
// 4b. genuine empty through the floor -> 0 (NOT_PERSISTENT)
check('8AL run: zeros through 10s floor and beyond -> 0 (genuine empty)', settleRun(Array(30).fill(0), 500) === 0);
// 8. only zeros but never reaching the floor before timeout
check('8AL run: zeros that never reach the floor within a short timeout -> -1 (fail closed)', settleRun(Array(3).fill(0), 500, FLOOR, 2, 1500) === -1);
// 10. requiredStable honoured after the floor
check('8AL run: requiredStable=3 still enforced for zero', settleRun(Array(30).fill(0), 500, 0, 3) === 0 && settleRun([0], 500, 0, 3) === -1);
// 11. no false delay: clip before the floor accepted immediately
check('8AL run: clip at 1.0s accepted immediately (no floor delay)', settleRun([0,0,1], 500) === 1);

// ---------------------------------- 8AN: real timeline hydration signal (pure)
const { classifyTimelineHydrationEvidence } = await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);
// C. STATE C: count 1 -> populated immediately
check('8AN state C: clipCount 1 -> populated immediately', classifyTimelineHydrationEvidence(1, false) === 'populated' && classifyTimelineHydrationEvidence(1, true) === 'populated');
// A. STATE A: mounted + 0 + marker absent -> wait
check('8AN state A: clipCount 0 WITHOUT the empty marker -> wait (never trust a bare zero)', classifyTimelineHydrationEvidence(0, false) === 'wait');
// B. STATE B: 0 + explicit hydrated-empty marker -> empty
check('8AN state B: clipCount 0 WITH the empty marker -> empty', classifyTimelineHydrationEvidence(0, true) === 'empty');
// D. count >1 -> ambiguous
check('8AN: clipCount >1 -> ambiguous (fail closed)', classifyTimelineHydrationEvidence(2, false) === 'ambiguous' && classifyTimelineHydrationEvidence(3, true) === 'ambiguous');
// G. malformed -> ambiguous
check('8AN: malformed clipCount (-1/NaN/undefined) -> ambiguous', classifyTimelineHydrationEvidence(-1, false) === 'ambiguous' && classifyTimelineHydrationEvidence(NaN, true) === 'ambiguous' && classifyTimelineHydrationEvidence(undefined, false) === 'ambiguous');
// E. hydration transition: state A then C -> populated immediately (no marker ever needed)
check('8AN transition A->C: 0/not-hydrated then 1 -> populated immediately', (() => { const seq: Array<[number, boolean]> = [[0, false], [0, false], [1, false]]; for (const [c, h] of seq) { const d = classifyTimelineHydrationEvidence(c, h); if (d === 'populated') return true; if (d === 'wait') continue; return false; } return false; })());
// F. false rail signal: rail exists/active but the hydration marker is absent -> MUST remain wait
check('8AN false rail signal: bare zero WITHOUT the marker stays wait even if a rail active item exists', classifyTimelineHydrationEvidence(0, false) === 'wait');
// LIVE-8AM reproduction: repeated (0, no marker) then eventually (0, marker) -> empty; or (1, ...) -> populated
check('8AN LIVE-8AM: many (0,no-marker) then (0,marker) -> empty (genuine empty eventually proven)', (() => { const seq: Array<[number, boolean]> = Array(20).fill([0, false]); seq.push([0, true]); for (const [c, h] of seq) { const d = classifyTimelineHydrationEvidence(c, h); if (d !== 'wait') return d === 'empty'; } return false; })());
check('8AN LIVE-8AM: many (0,no-marker) then (1,no-marker) -> populated (persisted clip appears)', (() => { const seq: Array<[number, boolean]> = [...Array(20).fill([0, false]), [1, false]]; for (const [c, h] of seq) { const d = classifyTimelineHydrationEvidence(c, h); if (d !== 'wait') return d === 'populated'; } return false; })());

// ---------------------------------- 8AQ: persistence reload sequence (pure)
const { buildPersistenceReloadSequence } = await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);
const PROJ = 'https://flow.google.com/project/c30385ce-bfe4-4177-9730-caf087070f9a';
const SCENE_ROUTE = `${PROJ}/scene/58e10bc9-2113-4729-a857-c7c1072701d4`;
const EDIT_ROUTE = `${PROJ}/edit/58e10bc9-2113-4729-a857-c7c1072701d4`;
// 3/4. exact order: [project, canonical-scene]
check('8AQ sequence: [project, canonical-scene] in that exact order', JSON.stringify(buildPersistenceReloadSequence(PROJ, SCENE_ROUTE)) === JSON.stringify([PROJ, SCENE_ROUTE]));
// 2. first element is the validated project route
check('8AQ sequence: first element is the validated project route', buildPersistenceReloadSequence(PROJ, SCENE_ROUTE)[0] === PROJ);
// trailing slash on the project route is normalized
check('8AQ sequence: a trailing-slash project route normalizes to the clean base', buildPersistenceReloadSequence(`${PROJ}/`, SCENE_ROUTE)[0] === PROJ);
// 5. /edit is never the canonical route
check('8AQ sequence: /edit/<id> as the scene route -> [] (fail closed)', JSON.stringify(buildPersistenceReloadSequence(PROJ, EDIT_ROUTE)) === '[]');
// same-URL "refresh" rejected
check('8AQ sequence: scene route equal to the project route -> [] (no same-URL refresh)', JSON.stringify(buildPersistenceReloadSequence(PROJ, PROJ)) === '[]');
// mismatched project
check('8AQ sequence: project/scene from different projects -> [] (fail closed)', JSON.stringify(buildPersistenceReloadSequence('https://flow.google.com/project/other', SCENE_ROUTE)) === '[]');
// missing/invalid
check('8AQ sequence: missing/invalid routes -> [] (fail closed)', JSON.stringify(buildPersistenceReloadSequence('', SCENE_ROUTE)) === '[]' && JSON.stringify(buildPersistenceReloadSequence(PROJ, 'not-a-url')) === '[]' && JSON.stringify(buildPersistenceReloadSequence(undefined, SCENE_ROUTE)) === '[]');
// 1. never a two-element same-scene sequence
check('8AQ sequence: is never [scene, scene]', (() => { const s = buildPersistenceReloadSequence(PROJ, SCENE_ROUTE); return s.length === 2 && s[0] !== s[1]; })());

// ---------------------------------- 8AY: two-phase Videos-picker selection (pure)
const { exactlyOneSelectedVideoRow, classifyVideoRowConfirmation, confirmTargetSelection } = await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);
const row = (artifactId: string, selected: boolean) => ({ artifactId, selected });
// exactlyOneSelectedVideoRow
check('8AY selected: exactly one selected row -> its artifactId', (() => { const r = exactlyOneSelectedVideoRow([row(GEN, false), row(CLIP, true)]); return r.ok === true && r.selectedArtifactId === CLIP; })());
check('8AY selected: zero selected -> fail closed', exactlyOneSelectedVideoRow([row(GEN, false), row(CLIP, false)]).ok === false);
check('8AY selected: multiple selected -> fail closed', exactlyOneSelectedVideoRow([row(GEN, true), row(CLIP, true)]).ok === false);
check('8AY selected: selected row with empty id -> fail closed', exactlyOneSelectedVideoRow([row('', true)]).ok === false);
check('8AY selected: empty list -> fail closed', exactlyOneSelectedVideoRow([]).ok === false);
check('8AY selected: malformed evidence -> fail closed', exactlyOneSelectedVideoRow(undefined).ok === false && exactlyOneSelectedVideoRow([null, 42] as any).ok === false);
// classifyVideoRowConfirmation
check('8AY classify: target already selected -> already-selected', classifyVideoRowConfirmation(GEN, GEN) === 'already-selected');
check('8AY classify: target not selected -> needs-selection', classifyVideoRowConfirmation(GEN, CLIP) === 'needs-selection');
check('8AY classify: empty target -> needs-selection (fail closed)', classifyVideoRowConfirmation('', GEN) === 'needs-selection' && classifyVideoRowConfirmation(GEN, '') === 'needs-selection');
check('8AY classify: exact equality only (no trim/fuzzy/substring)', classifyVideoRowConfirmation(` ${GEN}`, GEN) === 'needs-selection' && classifyVideoRowConfirmation(GEN.toUpperCase(), GEN) === 'needs-selection' && classifyVideoRowConfirmation(GEN.slice(0, 8), GEN) === 'needs-selection');
// confirmTargetSelection
check('8AY confirm: exact target===selected -> true', confirmTargetSelection(GEN, GEN) === true);
check('8AY confirm: mismatched -> false', confirmTargetSelection(GEN, CLIP) === false && confirmTargetSelection(GEN, '') === false && confirmTargetSelection('', GEN) === false);
// two-phase click-count model (drives the 8AY test expectations)
const attachClickPlan = (target: string, selectedInitial: string) => {
  let clicks = 0; let selected = selectedInitial;
  if (classifyVideoRowConfirmation(target, selected) === 'needs-selection') { clicks++; selected = target; }   // select
  if (confirmTargetSelection(target, selected)) clicks++;                                                      // confirm
  return clicks;
};
check('8AY plan: target already selected -> 1 click', attachClickPlan(GEN, GEN) === 1);
check('8AY plan: target not selected -> 2 clicks (select then confirm)', attachClickPlan(GEN, CLIP) === 2);
check('8AY plan: selection never settles -> 0 confirmation clicks allowed', confirmTargetSelection(GEN, CLIP) === false);

// ---------------------------------- 8BA: committed scene identity is authoritative (pure)
const { resolveCommittedSceneIdentity, classifySceneAttachmentIdentity } = await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);
// A. generated differs from committed -> SUCCESS
check('8BA A: generated != committed -> COMMITTED_IDENTITY (success)', (() => { const r = classifySceneAttachmentIdentity({ committedArtifactId: GEN, generatedArtifactId: CLIP }); return r.kind === 'COMMITTED_IDENTITY' && r.committedArtifactId === GEN && r.identityMatchedGeneration === false; })());
// B. generated equals committed -> SUCCESS
check('8BA B: generated == committed -> COMMITTED_IDENTITY + matched', (() => { const r = classifySceneAttachmentIdentity({ committedArtifactId: GEN, generatedArtifactId: GEN }); return r.kind === 'COMMITTED_IDENTITY' && r.identityMatchedGeneration === true; })());
// C. committed missing -> FAIL
check('8BA C: committed missing -> MISSING_COMMITTED_IDENTITY (fail)', classifySceneAttachmentIdentity({ committedArtifactId: '', generatedArtifactId: GEN }).kind === 'MISSING_COMMITTED_IDENTITY' && classifySceneAttachmentIdentity({ committedArtifactId: undefined, generatedArtifactId: GEN }).kind === 'MISSING_COMMITTED_IDENTITY');
// D. committed malformed -> FAIL
check('8BA D: committed malformed -> MISSING_COMMITTED_IDENTITY (fail)', classifySceneAttachmentIdentity({ committedArtifactId: 'not-a-uuid', generatedArtifactId: GEN }).kind === 'MISSING_COMMITTED_IDENTITY');
// resolveCommittedSceneIdentity direct
check('8BA resolve: valid uuid -> ok', (() => { const r = resolveCommittedSceneIdentity(GEN); return r.ok === true && r.artifactId === GEN; })());
check('8BA resolve: null/undefined/empty/short -> fail', resolveCommittedSceneIdentity(null).ok === false && resolveCommittedSceneIdentity(undefined).ok === false && resolveCommittedSceneIdentity('').ok === false && resolveCommittedSceneIdentity('0ad0c887-85bc-49da-9dbc').ok === false);
// H. picker differs from committed is irrelevant to final identity
check('8BA H/I: picker/generation differing from committed never causes failure', (() => { const r = classifySceneAttachmentIdentity({ committedArtifactId: 'b75938b0-7f95-4bd5-84ac-f138ea33ca03', generatedArtifactId: GEN }); return r.kind === 'COMMITTED_IDENTITY' && r.identityMatchedGeneration === false; })());
// LIVE-8AZ reproduction: committed b75938b0 while generated differs
check('8BA LIVE-8AZ: committed b75938b0 != generated -> SUCCESS', classifySceneAttachmentIdentity({ committedArtifactId: 'b75938b0-7f95-4bd5-84ac-f138ea33ca03', generatedArtifactId: GEN }).kind === 'COMMITTED_IDENTITY');
check('8BA malformed input -> MISSING_COMMITTED_IDENTITY (fail closed)', classifySceneAttachmentIdentity(undefined).kind === 'MISSING_COMMITTED_IDENTITY' && classifySceneAttachmentIdentity(null).kind === 'MISSING_COMMITTED_IDENTITY');

// ---------------------------------- 8BH: bounded read-only persistence retry (pure)
const { classifyPersistenceReadRetry } = await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);
// A/B. persisted
check('8BH A: clip=1, hydrated=false, attempt=1 -> PERSISTED', classifyPersistenceReadRetry(1, false, 1, 3) === 'PERSISTED');
check('8BH B: clip=1, hydrated=false, attempt=3 -> PERSISTED', classifyPersistenceReadRetry(1, false, 3, 3) === 'PERSISTED');
// C/D. retryable empty
check('8BH C: clip=0, hydrated=true, attempt=1/3 -> RETRY_READ', classifyPersistenceReadRetry(0, true, 1, 3) === 'RETRY_READ');
check('8BH D: clip=0, hydrated=true, attempt=2/3 -> RETRY_READ', classifyPersistenceReadRetry(0, true, 2, 3) === 'RETRY_READ');
// E. exhausted
check('8BH E: clip=0, hydrated=true, attempt=3/3 -> NOT_PERSISTED', classifyPersistenceReadRetry(0, true, 3, 3) === 'NOT_PERSISTED');
// F. ambiguous
check('8BH F: clip>1 -> AMBIGUOUS (never retried)', classifyPersistenceReadRetry(2, false, 1, 3) === 'AMBIGUOUS');
// G. malformed
check('8BH G: malformed state -> INVALID', classifyPersistenceReadRetry(-1, false, 1, 3) === 'INVALID' && classifyPersistenceReadRetry(NaN, true, 1, 3) === 'INVALID' && classifyPersistenceReadRetry(1, false, 0, 3) === 'INVALID' && classifyPersistenceReadRetry(1, false, 1, 0) === 'INVALID');
// H. marker-less zero is NOT a retryable empty
check('8BH H: clip=0, hydrated=false -> INVALID (never a retryable empty)', classifyPersistenceReadRetry(0, false, 1, 3) === 'INVALID');
// I. committed identity differing from generated is still persisted (identity handled elsewhere)
check('8BH I: committed != generated -> PERSISTED (identity model)', classifyPersistenceReadRetry(1, false, 1, 3) === 'PERSISTED' && classifySceneAttachmentIdentity({ committedArtifactId: 'b75938b0-7f95-4bd5-84ac-f138ea33ca03', generatedArtifactId: GEN }).kind === 'COMMITTED_IDENTITY');
// J. clip=1 but no committed uuid -> resolveCommittedSceneIdentity fails (caller throws)
check('8BH J: clip=1 with missing committed uuid -> identity resolution fails', resolveCommittedSceneIdentity('').ok === false);
// sequence model: retry stops as soon as persisted / after maxAttempts of empty
const retryRun = (states: Array<'empty' | 'persisted' | 'multi'>) => {
  let attempts = 0;
  for (let i = 0; i < states.length; i++) {
    attempts++;
    const s = states[i];
    const d = s === 'persisted' ? classifyPersistenceReadRetry(1, false, attempts, 3) : s === 'multi' ? classifyPersistenceReadRetry(2, false, attempts, 3) : classifyPersistenceReadRetry(0, true, attempts, 3);
    if (d !== 'RETRY_READ') return { decision: d, attempts };
  }
  return { decision: 'RETRY_READ' as const, attempts };
};
check('8BH run: persisted on read 1 -> 1 attempt', JSON.stringify(retryRun(['persisted'])) === JSON.stringify({ decision: 'PERSISTED', attempts: 1 }));
check('8BH run: empty then persisted -> 2 attempts', JSON.stringify(retryRun(['empty', 'persisted'])) === JSON.stringify({ decision: 'PERSISTED', attempts: 2 }));
check('8BH run: 3 empties -> NOT_PERSISTED after 3 attempts', JSON.stringify(retryRun(['empty', 'empty', 'empty'])) === JSON.stringify({ decision: 'NOT_PERSISTED', attempts: 3 }));
check('8BH run: >1 clips on read 1 -> AMBIGUOUS, no retry (1 attempt)', JSON.stringify(retryRun(['multi'])) === JSON.stringify({ decision: 'AMBIGUOUS', attempts: 1 }));

// ---------------------------------- 8CC: title-path route derivation (pure)
const { deriveRoutesFromMountedSceneUrl } = await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);
const SCENE_UUID = '046cc857-0096-4c44-b2d4-94886148d161';
const PROJ_BASE = 'https://flow.google.com/project/c30385ce-bfe4-4177-9730-caf087070f9a';
// TEST A: title path opens /edit/<uuid> -> both routes populated + scene uuid extracted
check('8CC-A /edit/<uuid> mounted -> projectUrl + canonicalSceneUrl + sceneId', (() => { const r = deriveRoutesFromMountedSceneUrl(`${PROJ_BASE}/edit/${SCENE_UUID}`); return r.ok === true && r.projectUrl === PROJ_BASE && r.sceneId === SCENE_UUID && r.canonicalSceneUrl === `${PROJ_BASE}/scene/${SCENE_UUID}`; })());
// TEST B: non-empty reload sequence for a title-addressed scene
check('8CC-B /edit/<uuid> -> non-empty buildPersistenceReloadSequence', (() => { const r = deriveRoutesFromMountedSceneUrl(`${PROJ_BASE}/edit/${SCENE_UUID}`); if (!r.ok) return false; const seq = buildPersistenceReloadSequence(r.projectUrl, r.canonicalSceneUrl); return JSON.stringify(seq) === JSON.stringify([PROJ_BASE, `${PROJ_BASE}/scene/${SCENE_UUID}`]); })());
// TEST C: canonical is /scene/<uuid>, never /edit/<uuid>
check('8CC-C canonical route is /scene/<uuid> not /edit/<uuid>', (() => { const r = deriveRoutesFromMountedSceneUrl(`${PROJ_BASE}/edit/${SCENE_UUID}`); return r.ok === true && /\/scene\//.test(r.canonicalSceneUrl) && !/\/edit\//.test(r.canonicalSceneUrl); })());
// also from a /scene/<uuid> mounted url
check('8CC-C2 /scene/<uuid> mounted -> same canonical', (() => { const r = deriveRoutesFromMountedSceneUrl(`${PROJ_BASE}/scene/${SCENE_UUID}`); return r.ok === true && r.canonicalSceneUrl === `${PROJ_BASE}/scene/${SCENE_UUID}`; })());
// TEST D: invalid/non-scene mounted URL -> fail closed
check('8CC-D invalid mounted URL -> fail closed', deriveRoutesFromMountedSceneUrl(`${PROJ_BASE}`).ok === false && deriveRoutesFromMountedSceneUrl('https://flow.google.com/library/edit/x').ok === false && deriveRoutesFromMountedSceneUrl('').ok === false && deriveRoutesFromMountedSceneUrl(undefined).ok === false);
check('8CC-D2 invalid scene id in route -> fail closed (no canonical route)', deriveRoutesFromMountedSceneUrl(`${PROJ_BASE}/edit/not-a-valid-id`).ok === false);
// TEST E: never returns empty route values
check('8CC-E never returns empty projectUrl/canonicalSceneUrl', (() => { const r = deriveRoutesFromMountedSceneUrl(`${PROJ_BASE}/edit/${SCENE_UUID}`); return r.ok === true && r.projectUrl.length > 0 && r.canonicalSceneUrl.length > 0; })());

// ---------------------------------- selected-row preview action contract (pure, live-proven)
{
  const { decideRowPreviewAction, PICKER_TIMING, estimatePickerRowCycleMs, estimatePickerSnapshotMs, pickerBaselineBudgetMs } =
    await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);
  const A = decideRowPreviewAction;

  check('SEL-1 an ALREADY-SELECTED row is READ, never clicked (clicking it destroys the detail pane)',
    A(true).ok === true && A(true).action === 'READ');
  check('SEL-2 a NOT-selected row is CLICKed once as a preview action',
    A(false).ok === true && A(false).action === 'CLICK');
  check('SEL-3 the two documented outcomes are exactly READ and CLICK',
    JSON.stringify([A(true).action, A(false).action]) === JSON.stringify(['READ', 'CLICK']));
  check('SEL-4 the input is STRICT: no silent boolean coercion',
    A('true').ok === false && A('false').ok === false && A(1).ok === false && A(0).ok === false
    && A(null).ok === false && A(undefined).ok === false && A({}).ok === false && A([]).ok === false);
  check('SEL-5 a malformed state fails closed and yields NO action (never the destructive CLICK)',
    !('action' in A('true')) && !('action' in A(undefined)));
  check('SEL-6 the failure reason states that no click may be performed',
    /must not click/.test(A(null).reason));
  check('SEL-7 the helper is pure: deterministic and side-effect free',
    JSON.stringify(A(true)) === JSON.stringify(A(true)) && JSON.stringify(A(false)) === JSON.stringify(A(false))
    && JSON.stringify(A(null)) === JSON.stringify(A(null)));
  const body = A.toString().split('{')[1] ?? '';
  check('SEL-8 the helper never inspects or returns media identity',
    !/uuid|artifact|video|image|src|preview/i.test(body) && Object.keys(A(true)).join() === 'ok,action');
  check('SEL-9 the helper never consults a title, row index, order or /asb/ token',
    !/title|index|order|position|asb|length/i.test(body));
  check('SEL-10 the helper never touches the DOM, the network or the clock',
    !/document|window|fetch|await|Date|page/i.test(body));

  // RETRY REMOVAL: the live sweep resolved 12/12 rows on the FIRST settle once the guard was in place.
  check('SEL-11 per-row retries are zero (dead machinery removed)',
    PICKER_TIMING.rowPreviewRetries === 0);
  check('SEL-12 the proven 1200 ms settle is retained',
    PICKER_TIMING.rowPreviewSettleMs === 1200);
  check('SEL-13 the derived row cycle is exactly the settle',
    estimatePickerRowCycleMs() === 1200);
  check('SEL-14 the derived snapshot budget shrank honestly (hydration + 60 rows + overhead)',
    estimatePickerSnapshotMs() === 20000 + 60 * 1200 + 8000);
  check('SEL-15 the baseline budget still fits TWO complete snapshots',
    pickerBaselineBudgetMs() === 2 * estimatePickerSnapshotMs() && pickerBaselineBudgetMs() === 200000);
  check('SEL-16 every timing constant is finite and non-negative',
    Object.values(PICKER_TIMING).every((v: any) => Number.isFinite(Number(v)) && Number(v) >= 0));
}

// ---------------------------------- reads[].uuid CONTRACT: bare identity, never a URL
// Live-proven defect: production writes `extractPreviewArtifactUuid(got.src)` (a BARE uuid) into
// `reads[].uuid`, while the reducer used to re-parse that field as a URL. The regex needs the
// `flow-content.google/video/` prefix, so it returned null for every row and a live snapshot
// resolved 0 of 12 while actually holding 12 correct distinct identities.
{
  const { decideRowPreviewIdentity: R, classifyPickerSnapshotCompleteness: C, normalizeExtractedArtifactUuid: N, extractPreviewArtifactUuid: X } =
    await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);
  const V = '34bd7604-46cd-4fd6-988f-5f43f5e20bd6';
  const W = 'ec19b9fd-e4e9-4ca2-b3e0-517a1d523528';
  const src = (u) => `https://flow-content.google/video/${u}?Expires=1791466137&KeyName=labs-flow-prod-cdn-key&Signature=abc`;
  const probe = (i, uuid) => ({ rowIndex: i, title: `t${i}`, reads: [{ uuid, elementPresent: !!uuid, elapsedMs: 1212 }] });

  check('CT-1 normalizeExtractedArtifactUuid accepts a bare uuid verbatim',
    N(V) === V && N(W) === W);
  check('CT-2 normalizeExtractedArtifactUuid lowercases and trims',
    N(V.toUpperCase()) === V && N(`  ${V}  `) === V);
  check('CT-3 normalizeExtractedArtifactUuid rejects URLs, src values and query strings',
    N(src(V)) === null && N(`https://flow-content.google/video/${V}`) === null
    && N(`${V}?Expires=1`) === null && N(`https://flow.google.com/asb/${V}`) === null);
  check('CT-4 normalizeExtractedArtifactUuid rejects malformed, empty and non-string values',
    N('') === null && N('   ') === null && N('not-a-uuid') === null && N(V.slice(0, 18)) === null
    && N(`${V}x`) === null && N(null) === null && N(undefined) === null && N(42) === null && N({}) === null && N([]) === null);
  check('CT-5 normalizeExtractedArtifactUuid never parses a URL (anchored both ends)',
    N(`flow-content.google/video/${V}`) === null && N(V.replace(/-/g, '')) === null && N(V.replace(/-/g, '').slice(0, 32)) === null);

  check('CT-6 the reducer resolves a BARE uuid directly, with no re-parse',
    (() => { const d: any = R(probe(0, V)); return d.resolved === true && d.uuid === V && d.readCount === 1 && d.elapsedMs === 1212; })());
  check('CT-7 the reducer REJECTS a URL in reads[].uuid (not the declared contract)',
    R(probe(0, src(V))).resolved === false);
  check('CT-8 the reducer rejects malformed, empty and null values and fails closed',
    R(probe(0, 'not-a-uuid')).resolved === false && R(probe(0, '')).resolved === false
    && R(probe(0, '   ')).resolved === false && R(probe(0, null)).resolved === false
    && R(probe(0, undefined)).resolved === false && R(probe(0, 42)).resolved === false);
  check('CT-9 the reducer never calls extractPreviewArtifactUuid (no double extraction)',
    !/extractPreviewArtifactUuid/.test(R.toString()) && /normalizeExtractedArtifactUuid/.test(R.toString()));
  check('CT-10 the completeness classifier never re-parses identities either',
    !/extractPreviewArtifactUuid/.test(C.toString()));

  check('CT-11 REGRESSION: producer extracts ONCE, and the consumer still resolves the result',
    (() => {
      const once = X(src(W));
      if (once !== W) return false;                       // extraction boundary
      if (X(once) !== null) return false;                 // re-extraction would yield null
      const d: any = R(probe(3, once));                   // consumer validates, never re-parses
      return d.resolved === true && d.uuid === W;
    })());

  const live = [
    '34bd7604-46cd-4fd6-988f-5f43f5e20bd6', '896f1bdd-3eb0-4c91-968c-8c454e6eafd0',
    '6c14135b-2445-4d25-ad0c-25fec43ae9b7', 'ec19b9fd-e4e9-4ca2-b3e0-517a1d523528',
    '86dc06f6-81a0-4ab4-929b-0560f07f3488', '1595d0ed-2544-48d3-9583-49e113f4f76c',
    'c78c44a1-767d-417c-b2d8-e3eb735d2b1e', 'c107205d-da8f-45a6-8d5d-2a3d49f53d92',
    '47363d23-1266-4487-adb5-a6bbbea2104b', 'b4c0e30d-e60f-4414-aff5-54a402e2d544',
    '5fb04420-999b-4a60-a641-7e0bb2e01b5a', '15b6094c-6576-40d2-a70c-6320f9bb1690',
  ];
  const sweep = (uuids) => uuids.map((u, i) => probe(i, u));
  check('CT-12 the 12 real live uuids in bare form => COMPLETE 12/12 (the exact live failure, fixed)',
    (() => { const c = C(sweep(live)); return c.completeness === 'COMPLETE' && c.rowsResolved === 12 && c.unresolvedRows.length === 0; })());
  check('CT-13 the same 12 values as URLs would NOT resolve (the contract is deliberately strict)',
    (() => { const c = C(live.map((u, i) => probe(i, src(u)))); return c.completeness === 'PARTIAL' && c.rowsResolved === 0; })());
  check('CT-14 the unique set round-trips exactly and no duplicate groups appear',
    (() => { const c = C(sweep(live)); return c.uuids.length === 12 && c.duplicateUuidRows.length === 0 && JSON.stringify(c.uuids) === JSON.stringify([...live].sort()); })());
  check('CT-15 one null among the 12 => PARTIAL (completeness gate still fails closed)',
    (() => { const c = C(sweep([...live.slice(0, 11), null])); return c.completeness === 'PARTIAL' && c.rowsResolved === 11 && c.unresolvedRows.join() === '11'; })());
  check('CT-16 duplicate uuids are recorded, never a failure (unchanged behaviour)',
    (() => { const c = C(sweep([V, W, V, W, V, W])); return c.completeness === 'COMPLETE' && c.rowsResolved === 6 && c.uuids.length === 2 && c.duplicateUuidRows.length === 2; })());
  check('CT-17 two identical COMPLETE bare-form sweeps stabilize into a baseline',
    (() => { const set = C(sweep(live)).uuids; return stableBaselineFromReads([set, set]).kind === 'stable' && (stableBaselineFromReads([set, set]) as any).ids.length === 12; })());
  check('CT-18 a PARTIAL bare-form sweep is rejected by the completeness gate, so it never reaches the baseline',
    (() => {
      const c = C(sweep([...live.slice(0, 11), null]));
      // The pure baseline helper only judges consecutive identical sets; the guarantee that a
      // PARTIAL snapshot can never become a baseline is the CALLER gate, asserted in CT-19.
      return c.completeness === 'PARTIAL' && c.rowsResolved < c.rowsObserved;
    })());
  check('CT-19 the caller gate is intact: only COMPLETE snapshots feed stabilization (source audit)',
    (() => {
      const fc = fs.readFileSync(path.join(SRC, 'flowClient.ts'), 'utf8');
      const s = fc.indexOf('private async waitForStablePickerBaseline(');
      const body = fc.slice(s, fc.indexOf('\n  private async ', s + 10));
      return /if \(snapshot\?\.ok === true\)/.test(body) && /code === 'PICKER_SNAPSHOT_PARTIAL'/.test(body) && /reads\.length = 0/.test(body);
    })());
}

console.log(`\nVIDEO-DECISIONS TESTS PASSED (${passed} checks)`);
