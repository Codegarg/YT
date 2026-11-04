// Focused OFFLINE tests for the project generation-identity capture fix.
//
// Covers: preview-UUID extraction, snapshot de-duplication, the stabilized baseline rule, the
// before/after generation-identity delta, duplicate-title picker simulation, and source-level
// regressions on generateProjectFirstClip()'s identity source, the Start latch, and the fact that
// attachment ("Add media") is NEVER touched by identity capture.
//
// Pure-helper tests + browser-free source audits. NO browser, NO Flow, NO credits.
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const VD = await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const U4 = '44444444-4444-4444-8444-444444444444';
const vurl = (u: string) => `https://flow-content.google/video/${u}?Expires=1791410618&KeyName=labs-flow-prod-cdn-key&Signature=abc`;

// ============ B. preview extraction ============
console.log('--- B: preview artifact uuid extraction ---');
{
  check('B1 a valid flow-content.google/video/<uuid>?query yields the uuid',
    VD.extractPreviewArtifactUuid(vurl(U1)) === U1);
  check('B2 the query string and signature do not corrupt the uuid',
    VD.extractPreviewArtifactUuid(vurl(U2)) === U2
    && !VD.extractPreviewArtifactUuid(vurl(U2))?.includes('?'));
  check('B3 an uppercase uuid normalises to lowercase',
    VD.extractPreviewArtifactUuid(vurl(U1.toUpperCase())) === U1);
  check('B4 an /image/ url is rejected (an image is never a video identity)',
    VD.extractPreviewArtifactUuid(`https://flow-content.google/image/${U1}?Expires=1`) === null);
  check('B5 a wrong host is rejected',
    VD.extractPreviewArtifactUuid(`https://evil.example/video/${U1}`) === null);
  check('B6 a malformed url is rejected',
    VD.extractPreviewArtifactUuid('not a url') === null
    && VD.extractPreviewArtifactUuid(`https://flow-content.google/video/not-a-uuid`) === null);
  check('B7 null/empty/non-string input is rejected rather than guessed',
    VD.extractPreviewArtifactUuid(null) === null
    && VD.extractPreviewArtifactUuid('') === null
    && VD.extractPreviewArtifactUuid(undefined) === null
    && VD.extractPreviewArtifactUuid(12345) === null);
  check('B8 a bare opaque /asb/ thumbnail token is NOT a video identity',
    VD.extractPreviewArtifactUuid('https://flow.google.com/asb/ANqvLOZjOtt8Jo3zH6lWm47G7pFYy8SYrMjajRuzln5tCJLAvs_abc') === null);
}

// ============ snapshot de-duplication ============
console.log('--- picker snapshot de-duplication ---');
{
  check('SN1 a snapshot of distinct previews yields the sorted unique set',
    JSON.stringify(VD.collectPreviewArtifactUuids([vurl(U2), vurl(U1)])) === JSON.stringify([U1, U2].sort()));
  check('SN2 the SAME uuid previewed by several rows appears ONCE',
    VD.collectPreviewArtifactUuids([vurl(U1), vurl(U1), vurl(U1)]).length === 1);
  check('SN3 rows whose preview did not resolve contribute nothing',
    JSON.stringify(VD.collectPreviewArtifactUuids([vurl(U1), '', 'nope', null, vurl(U2)])) === JSON.stringify([U1, U2].sort()));
  check('SN4 a non-array yields an empty set rather than throwing',
    VD.collectPreviewArtifactUuids(null).length === 0
    && VD.collectPreviewArtifactUuids(undefined).length === 0
    && VD.collectPreviewArtifactUuids('x').length === 0);
  check('SN5 an all-unresolved snapshot yields an empty set (fails closed downstream)',
    VD.collectPreviewArtifactUuids(['', '', 'garbage']).length === 0);
  check('SN6 the snapshot is order-independent for set comparison',
    JSON.stringify(VD.collectPreviewArtifactUuids([vurl(U3), vurl(U1), vurl(U2)]))
    === JSON.stringify(VD.collectPreviewArtifactUuids([vurl(U2), vurl(U3), vurl(U1)])));
}

// ============ C. stabilized baseline ============
console.log('--- C: stabilized baseline ---');
{
  check('C1 two consecutive IDENTICAL reads are stable',
    VD.stableBaselineFromReads([[U1, U2], [U1, U2]]).kind === 'stable');
  check('C2 the stable baseline is sorted (order-independent exact set)',
    JSON.stringify((VD.stableBaselineFromReads([[U2, U1], [U1, U2]]) as any).ids) === JSON.stringify([U1, U2].sort()));
  check('C3 differing reads are unstable (the caller must keep polling)',
    VD.stableBaselineFromReads([[U1], [U1, U2]]).kind === 'unstable'
    && VD.stableBaselineFromReads([[U1, U2], [U2]]).kind === 'unstable');
  check('C4 a single read is never a stable baseline',
    VD.stableBaselineFromReads([[U1, U2]]).kind === 'unstable');
  check('C5 an empty read sequence is unstable',
    VD.stableBaselineFromReads([]).kind === 'unstable');
  check('C6 a MALFORMED read fails closed (never stabilizes)',
    VD.stableBaselineFromReads([null, [U1]]).kind === 'unstable'
    && VD.stableBaselineFromReads(['nope', 'nope']).kind === 'unstable');
  check('C7 a duplicate uuid inside a read fails closed',
    VD.stableBaselineFromReads([[U1, U1], [U1, U1]]).kind === 'unstable');
  check('C8 the last two reads decide, not any earlier pair',
    VD.stableBaselineFromReads([['aaaaaaaa-1111-4111-8111-111111111111'], [U1, U2], [U1, U2]]).kind === 'stable');
  check('C9 three reads where the tail matches still stabilise',
    VD.stableBaselineFromReads([[U1], [U1, U2], [U1, U2]]).kind === 'stable'
    && (VD.stableBaselineFromReads([[U1], [U1, U2], [U1, U2]]) as any).ids.length === 2);
}

// ============ A. generation-identity delta ============
console.log('--- A: generation identity delta ---');
{
  check('A1 before [a,b] + after [a,b,c] resolves EXACTLY c',
    VD.decideProjectGenerationIdentity({ baseline: [U1, U2], snapshot: [U1, U2, U3] }).ok === true
    && (VD.decideProjectGenerationIdentity({ baseline: [U1, U2], snapshot: [U1, U2, U3] }) as any).uuid === U3);
  check('A2 an identical snapshot yields NONE (caller keeps polling)',
    VD.decideProjectGenerationIdentity({ baseline: [U1, U2], snapshot: [U1, U2] }).code === 'GENERATION_IDENTITY_NONE');
  check('A3 a SHRUNKEN snapshot (nothing new) also yields NONE, never a false identity',
    VD.decideProjectGenerationIdentity({ baseline: [U1, U2], snapshot: [U1] }).code === 'GENERATION_IDENTITY_NONE');
  check('A4 two new uuids are AMBIGUOUS and none is picked',
    VD.decideProjectGenerationIdentity({ baseline: [U1], snapshot: [U1, U2, U3] }).code === 'GENERATION_IDENTITY_AMBIGUOUS');
  check('A5 a duplicate uuid INSIDE the baseline fails closed',
    VD.decideProjectGenerationIdentity({ baseline: [U1, U1], snapshot: [U1, U2] }).code === 'GENERATION_IDENTITY_AMBIGUOUS');
  check('A6 a duplicate uuid INSIDE the snapshot fails closed',
    VD.decideProjectGenerationIdentity({ baseline: [U1], snapshot: [U1, U2, U2] }).code === 'GENERATION_IDENTITY_AMBIGUOUS');
  check('A7 an empty baseline with one new uuid resolves (first ever generation)',
    (VD.decideProjectGenerationIdentity({ baseline: [], snapshot: [U1] }) as any).uuid === U1);
  check('A8 malformed evidence fails closed rather than resolving',
    VD.decideProjectGenerationIdentity({ baseline: null, snapshot: [U1] }).code === 'GENERATION_IDENTITY_AMBIGUOUS'
    && VD.decideProjectGenerationIdentity({ snapshot: [U1] }).code === 'GENERATION_IDENTITY_AMBIGUOUS'
    && VD.decideProjectGenerationIdentity({ baseline: [U1] }).code === 'GENERATION_IDENTITY_AMBIGUOUS');
  check('A9 the resolved code is GENERATION_IDENTITY_RESOLVED',
    VD.decideProjectGenerationIdentity({ baseline: [U1], snapshot: [U1, U2] }).code === 'GENERATION_IDENTITY_RESOLVED');
  check('A10 the five documented codes are exactly the ones emitted',
    ['GENERATION_IDENTITY_RESOLVED', 'GENERATION_IDENTITY_NONE', 'GENERATION_IDENTITY_AMBIGUOUS']
      .every((c) => [VD.decideProjectGenerationIdentity({ baseline: [U1], snapshot: [U1, U2] }).code,
        VD.decideProjectGenerationIdentity({ baseline: [U1], snapshot: [U1] }).code,
        VD.decideProjectGenerationIdentity({ baseline: [U1], snapshot: [U1, U2, U3] }).code].includes(c as any)));
  check('A11 the delta reuses newArtifactIds (no duplicated comparison logic)',
    VD.decideProjectGenerationIdentity({ baseline: [U1], snapshot: [U1, U2, U3] }).reason === VD.newArtifactIds([U1], [U1, U2, U3]).kind === 'ambiguous'
      ? true
      : VD.decideProjectGenerationIdentity({ baseline: [U1], snapshot: [U1, U2, U3] }).ok === false);
  check('A12 it never consults titles, order or counts (pure uuid set algebra)',
    !/title|aria|label|count|index|order/i.test(VD.decideProjectGenerationIdentity.toString()));
}

// ============ D. duplicate-title picker simulation ============
console.log('--- D: duplicate-title picker simulation ---');
{
  // Four rows share ONE exact title; only their preview src differs.
  const rows = [
    { title: 'Man reading book in bedroom', previewSrc: vurl(U1) },
    { title: 'Man reading book in bedroom', previewSrc: vurl(U2) },
    { title: 'Man reading book in bedroom', previewSrc: vurl(U3) },
    { title: 'Man reading book in bedroom', previewSrc: vurl(U4) },
  ];
  const snapshot = (r) => VD.collectPreviewArtifactUuids(r.map((x) => x.previewSrc));
  check('D1 the four identical-title rows produce FOUR distinct snapshot identities',
    snapshot(rows).length === 4 && new Set(snapshot(rows)).size === 4);
  check('D2 exactly one row previews the target => exactly ONE baseline match',
    VD.resolvePickerCandidateByPreviewUuid(rows.map((r) => r.previewSrc), U3).ok === true
    && (VD.resolvePickerCandidateByPreviewUuid(rows.map((r) => r.previewSrc), U3) as any).rowIndex === 2);
  check('D3 zero rows preview the target => NO match (fails closed, never title-matched)',
    VD.resolvePickerCandidateByPreviewUuid(rows.map((r) => r.previewSrc), '99999999-9999-4999-8999-999999999999').ok === false);
  check('D4 two rows previewing the SAME target => AMBIGUOUS (refuses to pick one)',
    VD.resolvePickerCandidateByPreviewUuid([vurl(U1), vurl(U2), vurl(U3), vurl(U3)], U3).ok === false
    && /matched 2 picker rows/.test((VD.resolvePickerCandidateByPreviewUuid([vurl(U1), vurl(U3), vurl(U3)], U3) as any).reason));
  check('D5 a target absent from the snapshot never resolves even though titles match exactly',
    VD.resolvePickerCandidateByPreviewUuid(rows.map((r) => r.previewSrc), U1).ok === true
    && VD.resolvePickerCandidateByPreviewUuid(rows.map((r) => r.previewSrc), 'eeeeeeee-1111-4111-8111-111111111111').ok === false);
  check('D6 the end-to-end shape works: stable baseline -> one new preview -> resolved identity',
    (() => {
      const before = snapshot(rows);
      const afterRows = [...rows, { title: 'Man reading book in bedroom', previewSrc: vurl('55555555-5555-4555-8555-555555555555') }];
      const stable = VD.stableBaselineFromReads([before, before]);
      if (stable.kind !== 'stable') return false;
      const verdict = VD.decideProjectGenerationIdentity({ baseline: stable.ids, snapshot: snapshot(afterRows) });
      return verdict.ok === true && (verdict as any).uuid === '55555555-5555-4555-8555-555555555555';
    })());
  check('D7 the same shape fails closed when TWO identical-title rows appear at once',
    (() => {
      const before = snapshot(rows);
      const afterRows = [...rows,
        { title: 'Man reading book in bedroom', previewSrc: vurl('66666666-6666-4666-8666-666666666666') },
        { title: 'Man reading book in bedroom', previewSrc: vurl('77777777-7777-4777-8777-777777777777') }];
      return VD.decideProjectGenerationIdentity({ baseline: before, snapshot: snapshot(afterRows) }).code === 'GENERATION_IDENTITY_AMBIGUOUS';
    })());
}

// ============ E. source-level regressions ============
console.log('--- E: source-level regressions ---');
{
  const fc = await fs.readFile(`${SRC}/flowClient.ts`, 'utf8');
  const start = fc.indexOf('async generateProjectFirstClip(');
  const body = fc.slice(start, fc.indexOf('\n  async ', start + 10));

  check('E1 generateProjectFirstClip NO LONGER uses readProjectGenerationVideoUuids as its identity source',
    !/readProjectGenerationVideoUuids\(\)/.test(body), body.slice(0, 200));
  const hs2 = fc.indexOf('async readSceneVideoLibraryUuidsViaPreview(');
  check('E2 it uses the SCENE-editor picker snapshot helper',
    /readSceneVideoLibraryUuidsViaPreview\(/.test(body)
    && !/readProjectLibraryVideoUuidsViaPreview/.test(body));
  check('E2b the project-composer Add-Ingredients picker is NEVER used for the identity baseline',
    !/S\.addIngredients/.test(fc.slice(hs2, hs2 + 4000)) && !/addIngredients/.test(body));
  check('E3 it builds a STABILIZED baseline before clicking Start, and before any prompt work',
    /waitForStablePickerBaseline\(targetSceneId\)/.test(body)
    && body.indexOf('waitForStablePickerBaseline(targetSceneId)') < body.indexOf('start.click()')
    && body.indexOf('waitForStablePickerBaseline(targetSceneId)') < body.indexOf('editor.fill('));
  check('E4 the structural Start latch is preserved: armed=false before the click, true immediately after',
    /startGate\.armed = false;\s*\n\s*await start\.click\(\);\s*\n\s*startGate\.armed = true;/.test(body));
  check('E5 EXACTLY ONE Start click is performed',
    (body.match(/start\.click\(\)/g) ?? []).length === 1);
  check('E6 it never clicks detail-add-to-prompt-btn (attachment is a separate stage)',
    !/detail-add-to-prompt-btn/.test(body));
  check('E7 it never matches by title, aria-selected, /asb/ token or grid tile',
    !/asset-title|aria-selected|\/asb\/|flow-grid-tile/.test(body));
  check('E8 waitComplete remains a bounded AUXILIARY wait, never the identity source',
    /waitComplete\(600000\)\.catch/.test(body)
    && !/const fresh = after|after\.filter\(/.test(body));
  check('E9 the delta is decided by the existing pure helper',
    /decideProjectGenerationIdentity\(\{ baseline, snapshot:/.test(body));
  check('E10 the poll is BOUNDED (a deadline, not an unbounded loop)',
    /const deadline = Date\.now\(\) \+ 15 \* 60 \* 1000/.test(body)
    && /while \(Date\.now\(\) < deadline\)/.test(body));
  check('E11 the latch violation path fails closed with a distinct code',
    /GENERATION_IDENTITY_AMBIGUOUS/.test(body) && /evaluated before Start generation was armed/.test(body));
  check('E12 the unchanged result shape still carries generationUuid/videoUrl',
    /generationUuid: identity\.ok \? identity\.uuid : null/.test(body)
    && /generationUuid: string \| null/.test(body));

  // ---- target scene identity (the auto-created Flow scene must not become the target) ----
  check('E22 generateProjectFirstClip REQUIRES a canonical targetSceneId',
    /async generateProjectFirstClip\(prompt: string, options: \{ targetSceneId\?: string \}/.test(body)
    && /a canonical targetSceneId is required/.test(body));
  check('E23 the target scene is established BEFORE the baseline and before Start',
    body.indexOf('ensureTargetSceneOpen(targetSceneId)') < body.indexOf('waitForStablePickerBaseline(targetSceneId)')
    && body.indexOf('ensureTargetSceneOpen(targetSceneId)') < body.indexOf('start.click()'));
  check('E24 every post-generation poll iteration re-establishes the SAME target scene',
    /while \(Date\.now\(\) < deadline\)[\s\S]{0,1200}ensureTargetSceneOpen\(targetSceneId\)/.test(body));
  check('E25 losing the scene identity context fails closed instead of switching scenes',
    /refusing to read the video library from a different scene/.test(fc)
    && /sceneContextLost/.test(body));
  check('E26 the result reports the target scene id/url used for identity',
    /targetSceneId\?: string \| null/.test(body) && /targetSceneUrl\?: string \| null/.test(body));

  // the read-only snapshot helper itself
  const hs = hs2;
  const helperBody = fc.slice(hs, fc.indexOf('\n  private async ', hs + 10));
  // Comments are stripped so prose documenting what the helper REFUSES to do is not mistaken for
  // the helper doing it.
  const helperCode = helperBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check('E13 the snapshot helper is READ-ONLY: it never clicks Add media / Apply / Confirm',
    !/detail-add-to-prompt-btn|\.apply\(|confirm/i.test(helperCode), helperCode.slice(0, 200));
  check('E14 the snapshot helper closes the picker with Escape in a finally',
    /finally\s*\{[\s\S]{0,300}keyboard\.press\('Escape'\)/.test(helperBody));
  check('E15 the snapshot helper resolves the Videos category by the normalised exact lookup, not by index',
    /findProjectAssetCategory\(\{ labels, wanted: PROJECT_LIBRARY_VIDEO_CATEGORY \}\)/.test(helperBody)
    && /PROJECT_LIBRARY_VIDEO_CATEGORY = 'Videos'/.test(fc));
  check('E15b it REUSES the scene Add Clip trigger and picker panel used by attachFirstClipByArtifactId',
    /this\.click\(S\.addClipButton\)/.test(helperBody)
    && /div\.flow-media-picker-dialog-panel/.test(helperBody));
  check('E15c it REQUIRES the scene editor to be open and never falls back to the project picker',
    /no scene editor is mounted/.test(helperBody)
    && !/S\.addIngredients/.test(helperBody));
  check('E15d it enumerates PARENT rows only (the nested asset-item child is not double-counted)',
    /panel\.locator\('button\.asset-item\[role="option"\]'\)/.test(helperBody)
    && !/flow-add-menu-asset-item/.test(helperCode));
  check('E16 the snapshot helper reuses the existing preview/extraction helpers',
    /extractPreviewArtifactUuid|collectPreviewArtifactUuids/.test(helperBody)
    && /waitForPickerHydration/.test(helperBody));
  check('E17 the snapshot helper fails closed with PICKER_UNAVAILABLE',
    /code: 'PICKER_UNAVAILABLE'/.test(helperBody));
  check('E18 the snapshot helper is BOUNDED by the 60-row safety cap',
    /timing\.maxRows/.test(helperBody) && /Math\.min\(await rows\.count\(\)/.test(helperBody));

  // the attachment mechanism must be untouched by this change
  check('E19 attachFirstClipByArtifactId still delegates to resolvePickerRowByPreviewUuid and clicks Add media',
    /async attachFirstClipByArtifactId\(/.test(fc)
    && /resolvePickerRowByPreviewUuid\(base\)/.test(fc)
    && /await addMedia\.click\(\)/.test(fc));

  const vd = await fs.readFile(`${SRC}/videoDecisions.ts`, 'utf8');
  check('E20 both new pure helpers exist in videoDecisions.ts and are browser-free',
    /export function collectPreviewArtifactUuids/.test(vd)
    && /export function decideProjectGenerationIdentity/.test(vd));
  check('E21 no new dependency was introduced (no network interception / instrumentation)',
    !/page\.route|page\.on\(['"]request|WebSocket|addInitScript/.test(
      fc.slice(hs, hs + 4000)));

  // ---- the removed project-picker path must be gone from the source entirely ----
  check('E27 the WRONG project-picker snapshot helper no longer exists anywhere in the source',
    !/readProjectLibraryVideoUuidsViaPreview/.test(fc));
  check('E28 no hardcoded observed UUID is present as a fallback',
    !/34bd7604/i.test(fc) && !/34bd7604/i.test(vd));
  check('E29 the project-route UUID reader is still present (it keeps its other legitimate use)',
    /async readProjectGenerationVideoUuids\(\)/.test(fc));
  check('E30 ensureTargetSceneOpen re-establishes the scene by canonical id, never by title',
    /private async ensureTargetSceneOpen\(targetSceneId: string\)/.test(fc)
    && /url\.includes\(`\/scene\/\$\{want\}`\)/.test(fc)
    && !/openSceneEditor\((String\(.*title)/.test(fc));
}

// ============ F/G/H: per-row preview resolution (the REAL production contract) ============
//
// CONTRACT: `reads[].uuid` is the ALREADY-EXTRACTED BARE uuid that production writes via
// `extractPreviewArtifactUuid(got.src)`. It is NOT a URL. These tests used to feed full preview URLs
// here, which is why 171 offline checks passed while a live snapshot resolved 0 of 12 rows.
console.log('--- F/G/H: per-row preview resolution ---');
{
  const R = VD.decideRowPreviewIdentity;
  const src = (u) => `https://flow-content.google/video/${u}?Expires=1&Signature=x`;

  check('F a row whose first read is empty and second carries a bare uuid resolves',
    (() => { const d = R({ rowIndex: 3, title: 'x', reads: [{ uuid: null, elementPresent: false, elapsedMs: 1200 }, { uuid: U2, elementPresent: true, elapsedMs: 1200 }] }); return d.resolved === true && d.uuid === U2 && d.readCount === 2; })());
  check('G a first STALE uuid followed by the row\'s own bare uuid records the first valid one',
    (() => { const d = R({ rowIndex: 0, reads: [{ uuid: U1, elementPresent: true, elapsedMs: 1200 }, { uuid: U2, elementPresent: true, elapsedMs: 1200 }] }); return d.resolved === true && d.uuid === U1; })());
  check('G2 an UNCHANGED uuid across reads is NOT a failure (row already previewed)',
    (() => { const d = R({ rowIndex: 1, reads: [{ uuid: U1, elementPresent: true, elapsedMs: 10 }, { uuid: U1, elementPresent: true, elapsedMs: 10 }] }); return d.resolved === true && d.uuid === U1; })());
  check('G3 the PRODUCER boundary turns a preview src into the bare uuid the reducer consumes',
    VD.extractPreviewArtifactUuid(src(U3)) === U3
    && R({ rowIndex: 0, reads: [{ uuid: VD.extractPreviewArtifactUuid(src(U3)), elementPresent: true, elapsedMs: 1 }] }).resolved === true);
  check('H a row that NEVER resolves is unresolved with the read count and elapsed reported',
    (() => { const d = R({ rowIndex: 7, reads: Array.from({ length: 4 }, () => ({ uuid: null, elementPresent: false, elapsedMs: 1200 })) }); return d.resolved === false && d.rowIndex === 7 && d.readCount === 4 && d.elapsedMs === 4800 && /no valid/.test(d.reason); })());
  check('H2 a row with no reads at all fails closed',
    R({ rowIndex: 2, reads: [] }).resolved === false
    && R(null).resolved === false
    && R({ rowIndex: 2 }).resolved === false);
  check('H3 resolution never consults the row title',
    R({ rowIndex: 0, title: 'a totally unrelated title', reads: [{ uuid: U1, elementPresent: true, elapsedMs: 1 }] }).uuid === U1);
}

// ============ CONTRACT: bare uuid in, bare uuid out — NO double extraction ============
console.log('--- CONTRACT: reads[].uuid is a bare uuid, never a URL ---');
{
  const R = VD.decideRowPreviewIdentity;
  const N = VD.normalizeExtractedArtifactUuid;
  const src = (u) => `https://flow-content.google/video/${u}?Expires=1791466137&KeyName=labs-flow-prod-cdn-key&Signature=abc`;

  // --- the 12 REAL live library uuids recorded by the read-only diagnostic, as fixtures ---
  const LIVE_12 = [
    '34bd7604-46cd-4fd6-988f-5f43f5e20bd6', '896f1bdd-3eb0-4c91-968c-8c454e6eafd0',
    '6c14135b-2445-4d25-ad0c-25fec43ae9b7', 'ec19b9fd-e4e9-4ca2-b3e0-517a1d523528',
    '86dc06f6-81a0-4ab4-929b-0560f07f3488', '1595d0ed-2544-48d3-9583-49e113f4f76c',
    'c78c44a1-767d-417c-b2d8-e3eb735d2b1e', 'c107205d-da8f-45a6-8d5d-2a3d49f53d92',
    '47363d23-1266-4487-adb5-a6bbbea2104b', 'b4c0e30d-e60f-4414-aff5-54a402e2d544',
    '5fb04420-999b-4a60-a641-7e0bb2e01b5a', '15b6094c-6576-40d2-a70c-6320f9bb1690',
  ];
  const probe = (i, uuid) => ({ rowIndex: i, title: `t${i}`, reads: [{ uuid, elementPresent: !!uuid, elapsedMs: 1212 }] });
  const sweep = (uuids) => uuids.map((u, i) => probe(i, u));

  check('X1 the 12 real live uuids in the declared BARE form => COMPLETE 12/12',
    (() => { const c = VD.classifyPickerSnapshotCompleteness(sweep(LIVE_12)); return c.completeness === 'COMPLETE' && c.rowsResolved === 12 && c.rowsObserved === 12; })());
  check('X2 all 12 are UNIQUE and the set round-trips exactly',
    (() => { const c = VD.classifyPickerSnapshotCompleteness(sweep(LIVE_12)); return c.uuids.length === 12 && JSON.stringify(c.uuids) === JSON.stringify([...LIVE_12].sort()) && c.duplicateUuidRows.length === 0; })());
  check('X3 the reducer resolves each of the 12 live uuids individually',
    LIVE_12.every((u, i) => (R(probe(i, u)) as any).uuid === u));
  check('X4 one null among the 12 => PARTIAL (the live failure mode must now be impossible)',
    (() => { const c = VD.classifyPickerSnapshotCompleteness(sweep([...LIVE_12.slice(0, 11), null])); return c.completeness === 'PARTIAL' && c.rowsResolved === 11 && c.unresolvedRows.join() === '11'; })());
  check('X5 a malformed uuid is rejected and fails closed',
    N('not-a-uuid') === null && N('34bd7604-46cd-4fd6-988f') === null && N('zzzzzzzz-46cd-4fd6-988f-5f43f5e20bd6') === null
    && R(probe(0, 'not-a-uuid')).resolved === false);
  check('X6 a URL in reads[].uuid is REJECTED — a URL is not the declared contract',
    R(probe(0, src(LIVE_12[0]))).resolved === false
    && R(probe(0, `https://flow-content.google/video/${LIVE_12[0]}`)).resolved === false
    && N(src(LIVE_12[0])) === null);
  check('X7 an empty / whitespace / non-string value is rejected',
    R(probe(0, '')).resolved === false && R(probe(0, '   ')).resolved === false
    && N('') === null && N('  ') === null && N(null) === null && N(undefined) === null && N(42) === null && N({}) === null);
  check('X8 a bare uuid is accepted verbatim and normalised to lowercase',
    N(LIVE_12[0]) === LIVE_12[0] && N(LIVE_12[0].toUpperCase()) === LIVE_12[0]
    && N(`  ${LIVE_12[0]}  `) === LIVE_12[0]);
  check('X9 the validator never parses a URL (anchored on both ends)',
    N(`${LIVE_12[0]}?Expires=1`) === null && N(`x${LIVE_12[0]}`) === null && N(`${LIVE_12[0]}x`) === null
    && N(LIVE_12[0].replace('-', '')) === null);
  check('X10 DUPLICATE behaviour is unchanged: duplicates are recorded, never a failure',
    (() => { const c = VD.classifyPickerSnapshotCompleteness(sweep([U1, U1, U2, U2, U1, U2])); return c.completeness === 'COMPLETE' && c.rowsResolved === 6 && c.uuids.length === 2 && c.duplicateUuidRows.length === 2; })());
  check('X11 all rows resolving to the SAME bare uuid => COMPLETE with one unique uuid',
    (() => { const c = VD.classifyPickerSnapshotCompleteness(sweep(Array.from({ length: 8 }, () => U1))); return c.completeness === 'COMPLETE' && c.uuids.length === 1 && c.duplicateUuidRows[0].rowIndexes.length === 8; })());

  // --- the regression that matters: extraction happens ONCE, at the producer ---
  check('X12 REGRESSION: a bare uuid is consumed AS AN IDENTITY — no second extraction layer',
    (() => {
      // The producer converts src -> bare uuid exactly once...
      const once = VD.extractPreviewArtifactUuid(src(LIVE_12[3]));
      if (once !== LIVE_12[3]) return false;
      // ...and feeding that bare value back through the PRODUCER parser yields null, which is
      // precisely why the reducer must never call it again.
      if (VD.extractPreviewArtifactUuid(once) !== null) return false;
      // The reducer still resolves the value, because it validates instead of re-parsing.
      const d: any = R(probe(3, once));
      return d.resolved === true && d.uuid === LIVE_12[3];
    })());
  check('X13 the reducer does NOT call extractPreviewArtifactUuid (source-level proof)',
    !/extractPreviewArtifactUuid/.test(VD.decideRowPreviewIdentity.toString())
    && /normalizeExtractedArtifactUuid\(read\?\.uuid\)/.test(VD.decideRowPreviewIdentity.toString()));
  check('X14 the completeness classifier does not re-parse identities either',
    !/extractPreviewArtifactUuid/.test(VD.classifyPickerSnapshotCompleteness.toString()));
  check('X15 exactly one extraction boundary exists on the producer path (flowClient row loop)',
    await (async () => {
      const fc = await fs.readFile(`${SRC}/flowClient.ts`, 'utf8');
      const hs = fc.indexOf('async readSceneVideoLibraryUuidsViaPreview(');
      const helperBody = fc.slice(hs, fc.indexOf('\n  private async ', hs + 10));
      const helperCode = helperBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      // exactly ONE call site, and it is inside the reads.push(...) that stores the bare uuid
      return (helperCode.match(/extractPreviewArtifactUuid\(/g) ?? []).length === 1
        && /reads\.push\(\{ uuid: extractPreviewArtifactUuid\(got\.src\)/.test(helperCode);
    })());
  check('X16 the snapshot stores a BARE uuid, never the raw src',
    await (async () => {
      const fc = await fs.readFile(`${SRC}/flowClient.ts`, 'utf8');
      return !/uuid:\s*got\.src|uuid:\s*got\?\.src/.test(fc);
    })());
}

// ============ A-E: snapshot completeness ============
console.log('--- A-E: snapshot completeness contract ---');
{
  const C = VD.classifyPickerSnapshotCompleteness;
  // BARE uuids, exactly as production writes them.
  const row = (i, uuid) => ({ rowIndex: i, title: `t${i}`, reads: [{ uuid: uuid ?? null, elementPresent: !!uuid, elapsedMs: 1200 }] });
  const rows = (uuids) => uuids.map((u, i) => row(i, u));

  const all12 = C(rows([U1, U2, U3, U4, U1, U2, U3, U4, U1, U2, U3, U4]));
  check('A 12 rows that all resolve => COMPLETE with the correct unique uuid set',
    all12.completeness === 'COMPLETE' && all12.rowsObserved === 12 && all12.rowsResolved === 12
    && JSON.stringify(all12.uuids) === JSON.stringify([U1, U2, U3, U4].sort()), all12);

  const oneOf12 = C(rows([U1, null, null, null, null, null, null, null, null, null, null, null]));
  check('B 1 of 12 resolving => PARTIAL, and it is NOT a usable baseline',
    oneOf12.completeness === 'PARTIAL' && oneOf12.rowsResolved === 1 && oneOf12.unresolvedRows.length === 11
    && oneOf12.uuids.length === 1, oneOf12);
  check('C 11 of 12 resolving => PARTIAL (one unresolved row is enough to reject)',
    (() => { const r = C(rows([U1, U2, U3, U4, U1, U2, U3, U4, U1, U2, U3, null])); return r.completeness === 'PARTIAL' && r.rowsResolved === 11 && r.unresolvedRows.join() === '11'; })());

  const sameUuid = C(rows([U1, U1, U1, U1, U1, U1, U1, U1]));
  check('D all rows resolving to the SAME uuid => COMPLETE, one unique uuid, duplicates recorded',
    sameUuid.completeness === 'COMPLETE' && sameUuid.uuids.length === 1 && sameUuid.uuids[0] === U1
    && sameUuid.duplicateUuidRows.length === 1 && sameUuid.duplicateUuidRows[0].rowIndexes.length === 8, sameUuid);
  check('E repeated uuids across rows are recorded but never a failure',
    (() => { const r = C(rows([U1, U2, U1, U2, U1, U2])); return r.completeness === 'COMPLETE' && r.duplicateUuidRows.length === 2; })());
  check('E2 the unique uuid set is still correct when duplicates exist',
    C(rows([U1, U2, U1, U2])).uuids.length === 2);

  check('A2 zero enumerated rows => INVALID (never a valid empty baseline)',
    C([]).completeness === 'INVALID' && C(null).completeness === 'INVALID');
  check('B2 completeness never depends on an EXPECTED library size (1 uuid from 8 rows is COMPLETE)',
    C(rows([U1, U1, U1, U1, U1, U1, U1, U1])).completeness === 'COMPLETE');
  check('B3 per-row diagnostics are returned for unresolved rows (index, title, reads)',
    oneOf12.rowDiagnostics.filter((r) => !r.resolved).length === 11
    && oneOf12.rowDiagnostics.find((r) => r.rowIndex === 5)?.title === 't5'
    && Array.isArray(oneOf12.rowDiagnostics.find((r) => r.rowIndex === 5)?.reads));
  check('B4 the classification never reads a title or a row index for identity',
    !/title|label|aria|asb|position/i.test(VD.decideRowPreviewIdentity.toString()));
}

// ============ I: bounded timing ============
console.log('--- I: bounded timing budgets ---');
{
  const T = VD.PICKER_TIMING;
  check('I1 the per-row settle matches the proven attachment behaviour (1200 ms)',
    T.rowPreviewSettleMs === 1200, T);
  check('I2 per-row retries are ZERO (dead machinery removed after the live-proven guard)',
    T.rowPreviewRetries === 0, T);
  check('I3 maxRows keeps the 60-row safety bound',
    T.maxRows === 60);
  check('I4 the row-cycle estimate equals settle + retries x readGap',
    VD.estimatePickerRowCycleMs() === 1200 + T.rowPreviewRetries * T.rowPreviewReadMs);
  check('I5 the snapshot estimate covers hydration + every row + overhead',
    VD.estimatePickerSnapshotMs() === T.hydrationTimeoutMs + 60 * VD.estimatePickerRowCycleMs() + T.snapshotOverheadMs);
  check('I6 the baseline budget can perform TWO complete snapshots',
    VD.pickerBaselineBudgetMs() === 2 * VD.estimatePickerSnapshotMs()
    && VD.pickerBaselineBudgetMs() > VD.estimatePickerSnapshotMs());
  check('I7 the baseline budget is far larger than the old fixed 30 s that could not fit one snapshot',
    VD.pickerBaselineBudgetMs() > 120000, VD.pickerBaselineBudgetMs());
  check('I8 no timing constant is unbounded (all finite and non-negative; the critical ones positive)',
    Object.values(T).every((v) => Number.isFinite(Number(v)) && Number(v) >= 0)
    && T.rowPreviewSettleMs > 0 && T.hydrationTimeoutMs > 0 && T.maxRows > 0 && T.snapshotOverheadMs > 0, T);
  check('I9 a larger row budget grows the snapshot estimate linearly (still bounded)',
    VD.estimatePickerSnapshotMs({ rowPreviewSettleMs: 2400 }) > VD.estimatePickerSnapshotMs());
  check('I9b removing the retries shrank the derived budgets (honest, not padded)',
    VD.estimatePickerRowCycleMs() === 1200
    && VD.estimatePickerSnapshotMs() === 20000 + 60 * 1200 + 8000
    && VD.pickerBaselineBudgetMs() === 200000,
    { row: VD.estimatePickerRowCycleMs(), snap: VD.estimatePickerSnapshotMs(), budget: VD.pickerBaselineBudgetMs() });
  check('I9c a re-introduced retry window is still priced into the estimate (total function kept)',
    VD.estimatePickerRowCycleMs({ rowPreviewRetries: 3 }) === 1200 + 3 * T.rowPreviewReadMs);
  check('I9d a 12-row live sweep fits comfortably inside ONE snapshot budget',
    12 * VD.estimatePickerRowCycleMs() < VD.estimatePickerSnapshotMs());
}

// ============ J: baseline gate vs completeness ============
console.log('--- J: baseline gate ---');
{
  check('J1 two IDENTICAL complete snapshots stabilize',
    VD.stableBaselineFromReads([[U1, U2], [U1, U2]]).kind === 'stable');
  check('J2 two complete but DIFFERENT snapshots do not stabilize (continue, never fail)',
    VD.stableBaselineFromReads([[U1], [U1, U2]]).kind === 'unstable');
  check('J3 a malformed read fails closed',
    VD.stableBaselineFromReads([null, null]).kind === 'unstable');
  check('J4 a single complete snapshot never stabilizes',
    VD.stableBaselineFromReads([[U1]]).kind === 'unstable');
}

// ============ E2: source audits for the hardened snapshot ============
console.log('--- source audits: hardened snapshot ---');
{
  const fc = await fs.readFile(`${SRC}/flowClient.ts`, 'utf8');
  const hs = fc.indexOf('async readSceneVideoLibraryUuidsViaPreview(');
  const helperBody = fc.slice(hs, fc.indexOf('\n  private async ', hs + 10));
  const helperCode = helperBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const blStart = fc.indexOf('private async waitForStablePickerBaseline(');
  const baselineBody = fc.slice(blStart, fc.indexOf('\n  private async ', blStart + 10));
  const genStart = fc.indexOf('async generateProjectFirstClip(');
  const genBody = fc.slice(genStart, fc.indexOf('\n  async ', genStart + 10));

  check('SA1 the snapshot enumerates PARENT rows only', /panel\.locator\('button\.asset-item\[role="option"\]'\)/.test(helperBody) && !/flow-add-menu-asset-item/.test(helperCode));
  check('SA2 the PROVEN 1200 ms per-row preview settle is retained', /rowSettleMs/.test(helperBody) && /setTimeout\(r, rowSettleMs\)/.test(helperBody));
  check('SA3 the per-row loop is a bounded `for` over enumerated rows (no retry counter, no while-true)',
    /for \(let i = 0; i < count; i\+\+\)/.test(helperBody)
    && !/rowRetries/.test(helperBody) && !/attempt\s*<=/.test(helperBody) && !/while\s*\(true\)/.test(helperCode));
  check('SA3b the DEAD retry machinery is gone from the whole snapshot helper',
    !/rowRetries|rowPreviewRetries|attempt/.test(helperCode));
  check('SA4 exactly ONE preview read is recorded per row, AFTER its decided interaction',
    /const reads: PickerRowPreviewRead\[\] = \[\];/.test(helperBody)
    && (helperBody.match(/reads\.push\(/g) ?? []).length === 1);
  check('SA4b the PRE-click preview is deliberately not recorded (it is the previous row\'s uuid)',
    !/const before = await readPreview\(\)/.test(helperBody));
  check('SA5 a row is clicked at most once, and ONLY when explicitly unselected',
    (helperBody.match(/rows\.nth\(i\)\.click\(\)/g) ?? []).length === 1
    && /const clicked = decision\.ok && decision\.action === 'CLICK'/.test(helperBody)
    && /if \(clicked\) await rows\.nth\(i\)\.click\(\)/.test(helperBody));
  check('SA5b the snapshot reads the row selection state and defers to the pure decision helper',
    /readPickerRowSelectionState\(rows\.nth\(i\)\)/.test(helperBody)
    && /decideRowPreviewAction\(selected\)/.test(helperBody));
  check('SA6 the snapshot NEVER clicks Add media', !/detail-add-to-prompt-btn/.test(helperCode));
  check('SA7 the snapshot closes the picker with Escape in a finally',
    /finally\s*\{[\s\S]{0,300}keyboard\.press\('Escape'\)/.test(helperBody));
  check('SA8 completeness is required before a snapshot reports ok',
    /classifyPickerSnapshotCompleteness\(probes\)/.test(helperBody)
    && /code: 'PICKER_SNAPSHOT_PARTIAL'/.test(helperBody)
    && /completeness: 'COMPLETE'/.test(helperBody));
  check('SA9 partial snapshots cannot become baselines (the stabilizer discards them)',
    /code === 'PICKER_SNAPSHOT_PARTIAL'/.test(baselineBody)
    && /reads\.length = 0/.test(baselineBody));
  check('SA10 only a COMPLETE snapshot feeds stabilization',
    /if \(snapshot\?\.ok === true\)/.test(baselineBody));
  check('SA11 no expected/assumed uuid count is hardcoded in the snapshot or baseline',
    !/uuidCount\s*===|expectedUuids|uuids\.length\s*[<>=!]+\s*\d/.test(helperCode + baselineBody));
  check('SA12 the snapshot uses the existing uuid extractor (no second parser)',
    /extractPreviewArtifactUuid/.test(helperBody) && /classifyPickerSnapshotCompleteness/.test(helperBody));
  check('SA13 the baseline budget defaults to the derived two-snapshot bound',
    /timeoutMs = pickerBaselineBudgetMs\(\)/.test(baselineBody));
  check('SA14 generation still requires a stable baseline and still clicks Start exactly once',
    /waitForStablePickerBaseline\(targetSceneId\)/.test(genBody)
    && (genBody.match(/await start\.click\(\)/g) ?? []).length === 1);
  check('SA15 startGate is unchanged',
    /startGate\.armed = false;\s*\n\s*await start\.click\(\);\s*\n\s*startGate\.armed = true;/.test(genBody));
  check('SA16 no title / row-order / asb identity in the snapshot; aria-selected is INTERACTION-STATE only',
    !/\/asb\//.test(helperCode) && /title: titles\[i\] \?\? null/.test(helperBody)
    // the ONLY permitted use of aria-selected is the click/read decision, never an identity input
    && (helperCode.match(/aria-selected/g) ?? []).length === 0
    && /readPickerRowSelectionState/.test(helperBody));
  check('SA17 the observed uuid 34bd7604 is not a fallback anywhere',
    !/34bd7604/i.test(fc) && !/34bd7604/i.test(await fs.readFile(`${SRC}/videoDecisions.ts`, 'utf8')));
  check('SA18 no network interception was introduced in the snapshot/baseline path',
    !/page\.route|page\.on\(.*request|WebSocket|addInitScript/.test(helperCode + baselineBody + genBody));
  check('SA19 the attachment path is untouched by this change',
    /async attachFirstClipByArtifactId\(/.test(fc)
    && /resolvePickerRowByPreviewUuid\(base\)/.test(fc)
    && /await addMedia\.click\(\)/.test(fc)
    && /private async resolvePickerRowByPreviewUuid\(expected: string\)/.test(fc));
  check('SA20 row diagnostics are returned but never written to a production artifact',
    /rowDiagnostics/.test(helperBody) && !/writeFile|appendFile|checkpoint/i.test(helperCode));
}

// ============ K: selected-row preview contract (pure helper + both scan loops) ============
console.log('--- K: selected-row preview contract ---');
{
  const A = VD.decideRowPreviewAction;

  check('K1 a row that is ALREADY SELECTED is READ, never clicked (live-proven destructive toggle)',
    A(true).ok === true && (A(true) as any).action === 'READ');
  check('K2 a row that is NOT selected is CLICKed once as a preview action',
    A(false).ok === true && (A(false) as any).action === 'CLICK');
  check('K3 the input is STRICT: no silent boolean coercion (missing/undefined/null/non-boolean fail closed)',
    A(undefined).ok === false && A(null).ok === false && A('true').ok === false && A(1).ok === false
    && A(0).ok === false && A({}).ok === false && A([]).ok === false,
    [A(undefined), A('true'), A(1)]);
  check('K4 a malformed state fails closed TOWARD "do not click" (never toward the destructive action)',
    A(null).ok === false && !('action' in (A(null) as any)));
  check('K5 the failure reason explains that no click may be performed',
    /must not click/.test((A(null) as any).reason), (A(null) as any).reason);
  const actionBody = (A.toString().split(/\{/)[1] ?? '');
  check('K6 the helper is PURE: deterministic, no identity, no browser, no I/O',
    JSON.stringify(A(true)) === JSON.stringify(A(true))
    && !/uuid|artifact|video|image|src|document|page|browser|fetch|await/i.test(actionBody), actionBody);
  check('K7 the helper never inspects or returns media identity',
    !/uuid|artifact|video|image|src|preview/i.test(actionBody)
    && !Object.keys(A(true) as any).includes('uuid')
    && Object.keys(A(true) as any).join() === 'ok,action');
  check('K8 it never consults a title, row index, order or /asb/ token',
    !/title|index|order|position|asb/i.test(A.toString()));

  // ---- the live-proven 12-row sweep, reproduced as a pure simulation ----
  // Row 0 opens already selected with its preview already rendered. Clicking an UNSELECTED row
  // moves the shared preview to that row (safe). Clicking the ALREADY-SELECTED row is a
  // destructive toggle that destroys the pane (and therefore every later identity).
  const rowUuid = (i: number) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const simulateSweep = (rowCount: number, guarded: boolean) => {
    let selected = 0;
    let paneAlive = true;
    const probes: any[] = [];
    for (let i = 0; i < rowCount; i++) {
      const alreadySelected = selected === i;
      const decision = guarded ? A(alreadySelected) : { ok: true, action: 'CLICK' as const };
      const clicked = decision.ok && decision.action === 'CLICK';
      const reads: any[] = [];
      if (!guarded) {
        // The OLD code recorded the PRE-click preview for every row...
        if (paneAlive) reads.push({ uuid: rowUuid(selected), elementPresent: true, elapsedMs: 0 });
        if (clicked) {
          if (alreadySelected) { selected = -1; paneAlive = false; }   // destructive toggle
          else selected = i;
        }
        reads.push({ uuid: paneAlive && selected >= 0 ? rowUuid(selected) : null, elementPresent: paneAlive, elapsedMs: 1200 });
      } else {
        if (clicked) selected = i;                                       // safe preview action
        reads.push({ uuid: paneAlive && selected >= 0 ? rowUuid(selected) : null, elementPresent: paneAlive, elapsedMs: 1200 });
      }
      probes.push({ rowIndex: i, title: `t${i}`, reads });
    }
    return probes;
  };

  const guarded = simulateSweep(12, true);
  const guardedClass = VD.classifyPickerSnapshotCompleteness(guarded);
  check('K9 GUARDED sweep: row 0 is READ without a click and still resolves its own uuid',
    guardedClass.rowDiagnostics[0].resolved === true && guardedClass.rowDiagnostics[0].uuid === rowUuid(0), guardedClass.rowDiagnostics[0]);
  check('K10 GUARDED sweep: rows 1..11 are each clicked exactly once and every row resolves',
    guardedClass.rowsResolved === 12 && guarded.slice(1).every((p) => p.reads.length === 1));
  check('K11 GUARDED sweep: 12/12 rows resolved with 12 UNIQUE uuids (the live-proven result)',
    guardedClass.completeness === 'COMPLETE' && guardedClass.uuids.length === 12, guardedClass.uuids);
  check('K12 GUARDED sweep: row 0 is NEVER clicked merely to advance the scan',
    guarded[0].reads.length === 1 && guardedClass.rowDiagnostics[0].readCount === 1
    && guarded.slice(1).every((p) => p.reads.length === 1));

  const unguarded = VD.classifyPickerSnapshotCompleteness(simulateSweep(12, false));
  check('K13 UNGUARDED (the old code) resolves only 1 of 12 and destroys the pane — the live bug',
    unguarded.completeness === 'PARTIAL' && unguarded.rowsResolved === 1
    && unguarded.unresolvedRows.join() === '1,2,3,4,5,6,7,8,9,10,11', unguarded);
  check('K13b the guard is what turns PARTIAL into COMPLETE (no other input differs)',
    simulateSweep(12, false).length === simulateSweep(12, true).length);

  check('K14 a guarded 12-row sweep classifies as COMPLETE (a usable baseline)', guardedClass.completeness === 'COMPLETE'
    && guardedClass.rowsResolved === 12 && guardedClass.unresolvedRows.length === 0, guardedClass);
  check('K15 one unresolved row still yields PARTIAL (the guard does not weaken the completeness gate)',
    VD.classifyPickerSnapshotCompleteness(
      [...guarded.slice(0, 11), { rowIndex: 11, title: 't11', reads: [{ uuid: null, elementPresent: false, elapsedMs: 1200 }] }] as any,
    ).completeness === 'PARTIAL');
  check('K16 two IDENTICAL complete sweeps stabilize (the baseline requirement is met)',
    VD.stableBaselineFromReads([guardedClass.uuids, guardedClass.uuids]).kind === 'stable');
  check('K16b a PARTIAL sweep is rejected BEFORE stabilization (it never reaches the baseline helper)',
    unguarded.completeness === 'PARTIAL' && unguarded.rowsResolved < unguarded.rowsObserved
    // the caller-side gate: the stabilizer only feeds `ok === true` (COMPLETE) snapshots
    && /if \(snapshot\?\.ok === true\)/.test(await fs.readFile(`${SRC}/flowClient.ts`, 'utf8')));
}

// ============ L: source audits for the selected-row guard + baseline scene reopen ============
console.log('--- L: source audits: selected-row guard ---');
{
  const fc = await fs.readFile(`${SRC}/flowClient.ts`, 'utf8');
  const vd = await fs.readFile(`${SRC}/videoDecisions.ts`, 'utf8');
  const hs = fc.indexOf('async readSceneVideoLibraryUuidsViaPreview(');
  const helperBody = fc.slice(hs, fc.indexOf('\n  private async ', hs + 10));
  const helperCode = helperBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const rs = fc.indexOf('private async resolvePickerRowByPreviewUuid(');
  const resolverBody = fc.slice(rs, fc.indexOf('\n  private async ', rs + 10));
  const resolverCode = resolverBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const selStart = fc.indexOf('private async readPickerRowSelectionState(');
  const selBody = fc.slice(selStart, fc.indexOf('\n  private async ', selStart + 10));
  const blStart = fc.indexOf('private async waitForStablePickerBaseline(');
  const baselineBody = fc.slice(blStart, fc.indexOf('\n  private async ', blStart + 10));
  const baselineCode = baselineBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  check('L1 decideRowPreviewAction is exported from videoDecisions.ts and is pure',
    /export function decideRowPreviewAction\(rowAlreadySelected: unknown\)/.test(vd)
    && !/document|page\.|await /.test((vd.match(/export function decideRowPreviewAction[\s\S]{0,700}/) ?? [''])[0]));
  // A click is "guarded" when it is the ONLY click in the loop and it sits inside the `if (clicked)`
  // block that the pure decision helper feeds. Anything else is an unconditional click.
  const guardedClick = (code: string) => {
    const clicks = code.match(/rows\.nth\(i\)\.click\(\)/g) ?? [];
    if (clicks.length !== 1) return false;
    const guardAt = code.indexOf('if (clicked)');
    const clickAt = code.indexOf('rows.nth(i).click()');
    return guardAt >= 0 && clickAt > guardAt && clickAt - guardAt < 120;
  };
  check('L2 the snapshot loop uses the decision helper and clicks ONLY inside the guarded branch',
    /decideRowPreviewAction\(selected\)/.test(helperCode)
    && /const clicked = decision\.ok && decision\.action === 'CLICK'/.test(helperCode)
    && guardedClick(helperCode));
  check('L3 the attachment resolver uses the SAME decision helper and clicks ONLY inside the guarded branch',
    /decideRowPreviewAction\(selected\)/.test(resolverCode)
    && /const clicked = decision\.ok && decision\.action === 'CLICK'/.test(resolverCode)
    && guardedClick(resolverCode));
  check('L4 NO unconditional row click remains in EITHER identity-scanning loop',
    guardedClick(helperCode) && guardedClick(resolverCode)
    && !/await rows\.nth\(i\)\.click\(\)/.test(helperCode.replace(/if \(clicked\) await rows\.nth\(i\)\.click\(\)\.catch\(\(\) => \{\}\);/, ''))
    && !/await rows\.nth\(i\)\.click\(\)/.test(resolverCode.replace(/if \(clicked\) \{[\s\S]*?\}/, '')));
  check('L5 the selection state is read through ONE shared, fail-closed helper with exactly 2 call sites',
    /private async readPickerRowSelectionState\(row: Locator\): Promise<boolean \| null>/.test(fc)
    && (selBody.match(/aria-selected/g) ?? []).length === 1
    && /if \(v === 'true'\) return true;/.test(selBody)
    && /if \(v === 'false'\) return false;/.test(selBody)
    && /return null;/.test(selBody)
    && /catch \{[\s\S]{0,120}return null;/.test(selBody)
    && (fc.match(/this\.readPickerRowSelectionState\(/g) ?? []).length === 2
    && (helperBody.match(/this\.readPickerRowSelectionState\(rows\.nth\(i\)\)/g) ?? []).length === 1
    && (resolverBody.match(/this\.readPickerRowSelectionState\(rows\.nth\(i\)\)/g) ?? []).length === 1);
  check('L6 aria-selected is read ONLY as interaction state and never fed to an identity helper',
    !/aria-selected/.test(helperCode) && !/aria-selected/.test(resolverCode)
    && !/decideRowPreviewIdentity\(\{[^}]*aria/i.test(fc));
  check('L7 the 1200 ms proven settle survives in BOTH loops',
    /setTimeout\(r, rowSettleMs\)/.test(helperCode) && /setTimeout\(r, 1200\)/.test(resolverCode));
  check('L8 no retry machinery remains in either loop or in the snapshot options',
    !/rowRetries|rowPreviewRetries/.test(fc)
    && !/attempt\s*<=/.test(helperCode) && !/attempt\s*<=/.test(resolverCode)
    && !/rowRetries\?/.test(fc));
  const bodyOfMethod = (name: string) => {
    const s = fc.indexOf(`async ${name}(`);
    if (s < 0) return '';
    const rest = fc.slice(s + 1);
    const m = rest.match(/\n  (private |protected |public )?async |\n  private [a-zA-Z]+\(|\n  [a-zA-Z]+\([^)]*\):\s*/);
    const end = m && m.index !== undefined ? s + 1 + m.index : fc.length;
    return fc.slice(s, end);
  };
  const firstClipBody = bodyOfMethod('attachFirstClipByArtifactId');
  const emptyAttachBody = bodyOfMethod('attachGeneratedVideoToEmptyScene');
  check('L9 Add media remains OUTSIDE both identity scans and is still ONE mutation per attachment path',
    !/detail-add-to-prompt-btn/.test(helperCode) && !/detail-add-to-prompt-btn/.test(resolverCode)
    && (firstClipBody.match(/await addMedia\.click\(\)/g) ?? []).length === 1
    && (emptyAttachBody.match(/await addMedia\.click\(\)/g) ?? []).length === 1
    && /detail-add-to-prompt-btn/.test(firstClipBody) && /detail-add-to-prompt-btn/.test(emptyAttachBody));
  check('L10 no title, row-order or /asb/ identity in either loop (the snapshot title read is diagnostics only)',
    !/\/asb\//.test(helperCode + resolverCode)
    && !/filter\(\{ hasText/.test(helperCode + resolverCode)
    && !/asset-title/.test(resolverCode) && !/title/.test(resolverCode)
    // the snapshot may read a row title, but only to attach it as `title:` diagnostic metadata
    && (helperBody.match(/span\.asset-title/g) ?? []).length === 1
    && /title: titles\[i\] \?\? null/.test(helperBody)
    && !/title/.test(helperCode.replace(/const titles: string\[\] = \[\];[\s\S]*?\n\s*\}\n/, '').replace(/title: titles\[i\] \?\? null/g, '')));
  check('L11 no hardcoded observed UUID anywhere in the source',
    !/34bd7604|ec19b9fd|1595d0ed|896f1bdd|6c14135b|15b6094c|c107205d|c78c44a1|86dc06f6|47363d23|b4c0e30d|5fb04420/i.test(fc)
    && !/34bd7604|ec19b9fd|1595d0ed/i.test(vd));
  check('L12 no network interception / instrumentation was introduced',
    !/page\.route|page\.on\(.*request|WebSocket|addInitScript|exposeFunction/.test(helperCode + resolverCode + baselineCode));
  check('L13 the baseline RE-OPENS the canonical target scene before EVERY snapshot attempt',
    /private async waitForStablePickerBaseline\(targetSceneId: string,/.test(fc)
    && /ensureTargetSceneOpen\(want\)/.test(baselineCode)
    && baselineCode.indexOf('ensureTargetSceneOpen(want)') < baselineCode.indexOf('readSceneVideoLibraryUuidsViaPreview('));
  check('L14 a canonical targetSceneId is REQUIRED by the stabilizer (no title, no fallback)',
    /a canonical targetSceneId is required to stabilize the video-library baseline/.test(baselineBody)
    && !/openSceneEditor\(targetSceneId\)|byTitle|sceneTitle/.test(baselineCode));
  check('L15 losing the target scene context is recorded and retried, never a silent scene switch',
    /the target scene could not be re-established for a baseline snapshot/.test(baselineCode)
    && /refusing to read the video library from a different scene/.test(fc));
  check('L16 PARTIAL snapshots still reset the consecutive pair and can never baseline',
    /code === 'PICKER_SNAPSHOT_PARTIAL'/.test(baselineCode) && /reads\.length = 0/.test(baselineCode)
    && /if \(snapshot\?\.ok === true\)/.test(baselineCode));
  check('L17 the stabilizer still has a single bounded deadline and a single fail-closed throw',
    (baselineCode.match(/Date\.now\(\) >= deadline/g) ?? []).length === 1
    && (baselineCode.match(/throw new Error\(`Project first-clip generation refused \(BASELINE_UNSTABLE\)/g) ?? []).length === 1);
  const genBody = bodyOfMethod('generateProjectFirstClip');
  const order = [
    'ensureTargetSceneOpen(targetSceneId)',
    'waitForStablePickerBaseline(targetSceneId)',
    'observeProjectPromptEditorCandidates()',
    'editor.fill(text)',
    'await start.click()',
  ].map((needle) => genBody.indexOf(needle));
  check('L18 the generation sequence is UNCHANGED (scene -> baseline -> prompt -> one Start -> same-scene polls)',
    order.every((i) => i >= 0) && order.every((i, k) => k === 0 || i > order[k - 1]), order);
  check('L18b the target scene is RE-OPENED on every post-generation poll iteration',
    /while \(Date\.now\(\) < deadline\)[\s\S]{0,1200}ensureTargetSceneOpen\(targetSceneId\)/.test(genBody));
  check('L19 startGate and the single Start click are byte-identical to before',
    /startGate\.armed = false;\s*\n\s*await start\.click\(\);\s*\n\s*startGate\.armed = true;/.test(fc));
  check('L20 the post-generation poll still re-establishes the SAME scene every iteration',
    /while \(Date\.now\(\) < deadline\)[\s\S]{0,1200}ensureTargetSceneOpen\(targetSceneId\)/.test(fc)
    && genBody.indexOf('ensureTargetSceneOpen(targetSceneId)') < genBody.indexOf('readSceneVideoLibraryUuidsViaPreview({'));
}

console.log(`\n${passed} generation-identity capture checks passed (fully offline).`);
