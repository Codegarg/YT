// Offline unit tests for the STEP-8ET/8EU first-clip preview-identity helpers. No browser, no Flow.
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const { extractPreviewArtifactUuid, resolvePickerCandidateByPreviewUuid, decideFirstClipAttachment, classifyFirstClipAttachment } =
  await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);

let passed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed += 1; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
}

const TARGET = 'eb70b706-5fb4-4c7d-9649-83ca230cdffb';
const OTHER = 'c5f68b4c-8e59-4b05-a40e-e48c83d69fdf';
const url = (uuid: string) => `https://flow-content.google/video/${uuid}?Expires=1790868443&KeyName=labs-flow-prod-cdn-key&Signature=abc`;

// ---------------------------------------------------- extractPreviewArtifactUuid
check('extracts the target UUID from a full preview URL (ignores query)', extractPreviewArtifactUuid(url(TARGET)) === TARGET);
check('extracts a different UUID correctly', extractPreviewArtifactUuid(url(OTHER)) === OTHER);
check('returns null for a non-flow-content URL', extractPreviewArtifactUuid('https://flow.google.com/asb/ANqvLOabc') === null);
check('returns null for empty input', extractPreviewArtifactUuid('') === null);
check('returns null for non-string input', extractPreviewArtifactUuid(undefined) === null && extractPreviewArtifactUuid(42) === null);
check('returns null for an image (not video) URL', extractPreviewArtifactUuid('https://flow-content.google/image/' + TARGET) === null);
check('normalizes uppercase UUIDs to lowercase', extractPreviewArtifactUuid('https://flow-content.google/video/' + TARGET.toUpperCase()) === TARGET);

// ------------------------------------------- resolvePickerCandidateByPreviewUuid
check('exactly one matching row resolves to its index', JSON.stringify(resolvePickerCandidateByPreviewUuid([url(OTHER), url(TARGET), url(OTHER)], TARGET)) === JSON.stringify({ ok: true, rowIndex: 1 }));
check('zero matching rows fails closed', resolvePickerCandidateByPreviewUuid([url(OTHER), url(OTHER)], TARGET).ok === false);
check('duplicate matches fail closed (never picks first)', resolvePickerCandidateByPreviewUuid([url(TARGET), url(TARGET)], TARGET).ok === false);
check('malformed target id fails closed', resolvePickerCandidateByPreviewUuid([url(TARGET)], 'not-a-uuid').ok === false);
check('empty target fails closed', resolvePickerCandidateByPreviewUuid([url(TARGET)], '').ok === false);
check('non-array evidence fails closed', resolvePickerCandidateByPreviewUuid(null, TARGET).ok === false);
check('null preview entries are ignored, not matched', resolvePickerCandidateByPreviewUuid([null, url(TARGET), undefined], TARGET).rowIndex === 1);
check('case-insensitive target matches lowercase preview', resolvePickerCandidateByPreviewUuid([url(TARGET)], TARGET.toUpperCase()).ok === true);

// --------------------------------------------------------- decideFirstClipAttachment
check('safe when preview == target and Add media present', decideFirstClipAttachment({ previewArtifactId: TARGET, targetArtifactId: TARGET, addMediaPresent: true }).ok === true);
check('refuses when preview != target (mutation guard)', decideFirstClipAttachment({ previewArtifactId: OTHER, targetArtifactId: TARGET, addMediaPresent: true }).ok === false);
check('refuses when Add media is absent', decideFirstClipAttachment({ previewArtifactId: TARGET, targetArtifactId: TARGET, addMediaPresent: false }).ok === false);
check('refuses when preview UUID is missing', decideFirstClipAttachment({ previewArtifactId: null, targetArtifactId: TARGET, addMediaPresent: true }).ok === false);
check('refuses a malformed target', decideFirstClipAttachment({ previewArtifactId: TARGET, targetArtifactId: 'x', addMediaPresent: true }).ok === false);
check('refuses null input', decideFirstClipAttachment(null).ok === false);
check('accepts target/preview case-insensitively', decideFirstClipAttachment({ previewArtifactId: TARGET, targetArtifactId: TARGET.toUpperCase(), addMediaPresent: true }).ok === true);

// -------------------------------------------------------- classifyFirstClipAttachment
check('CLASSIFY: attached + survives all reads', classifyFirstClipAttachment({ sceneWasEmpty: true, identityResolved: true, immediateClipCount: 1, persistedClipCounts: [1, 1, 1] }) === 'ATTACHED_AND_PERSISTED');
check('CLASSIFY: attached but disappears on reload', classifyFirstClipAttachment({ sceneWasEmpty: true, identityResolved: true, immediateClipCount: 1, persistedClipCounts: [0, 0, 0] }) === 'ATTACHED_BUT_NOT_PERSISTED');
check('CLASSIFY: no immediate clip', classifyFirstClipAttachment({ sceneWasEmpty: true, identityResolved: true, immediateClipCount: 0, persistedClipCounts: [0, 0, 0] }) === 'ATTACHMENT_FAILED');
check('CLASSIFY: identity unresolved', classifyFirstClipAttachment({ sceneWasEmpty: true, identityResolved: false, immediateClipCount: 1, persistedClipCounts: [1, 1, 1] }) === 'TARGET_ARTIFACT_IDENTITY_UNCERTAIN');
check('CLASSIFY: scene was not empty', classifyFirstClipAttachment({ sceneWasEmpty: false, identityResolved: true, immediateClipCount: 1, persistedClipCounts: [1, 1, 1] }) === 'SCENE_STATE_UNEXPECTED');
check('CLASSIFY: null evidence → unexpected', classifyFirstClipAttachment(null) === 'SCENE_STATE_UNEXPECTED');
check('CLASSIFY: partial persistence → NOT_PERSISTED', classifyFirstClipAttachment({ sceneWasEmpty: true, identityResolved: true, immediateClipCount: 1, persistedClipCounts: [1, 0, 1] }) === 'ATTACHED_BUT_NOT_PERSISTED');

// ===========================================================================
// 8BX: canonical empty-scene attach now uses the PREVIEW-UUID identity path.
// Focused offline coverage for (a) identity mechanism, (b) 0-match fail-closed,
// (c) >1-match fail-closed, (d) one exact match selects the target, and
// (e) post-click picker disappearance does not itself invalidate a mutation.
// ===========================================================================
import fs from 'node:fs';
import path from 'node:path';
const { FlowClient } = await import(pathToFileURL(`${SRC}/flowClient.ts`).href);

const fcSrc = fs.readFileSync(path.join(SRC, 'flowClient.ts'), 'utf8');
const bodyOf = (name: string) => { const s = fcSrc.indexOf(`async ${name}(`); if (s < 0) return ''; const rest = fcSrc.slice(s + 1); const m = rest.match(/\n  (private |protected |public )?async |\n  private [a-zA-Z]+\(|\n  [a-zA-Z]+\([^)]*\):\s*/); const end = m && m.index !== undefined ? s + 1 + m.index : fcSrc.length; return fcSrc.slice(s, end); };
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

const attachBody = strip(bodyOf('attachGeneratedVideoToEmptyScene'));
const resolverBody = strip(bodyOf('resolvePickerRowByPreviewUuid'));

// (a) identity is preview/artifact based, NOT img[src*="<generation UUID>"].
check('8BX(a) canonical attach resolves identity via the shared preview-UUID resolver',
  /resolvePickerRowByPreviewUuid\(expected\)/.test(attachBody));
check('8BX(a) canonical attach does not build an img[src*=generation-uuid] row locator',
  !/img\[src\*="\$\{expected\}"\]/.test(attachBody) && !/videoRowLocator\(/.test(attachBody) && !/resolveVideoPickerArtifact\(expected, rows\)/.test(attachBody));
check('8BX(a) preview resolver reads the detail-pane video preview and delegates to the pure helper',
  /extractPreviewArtifactUuid\(previewSrc\)/.test(resolverBody) && /resolvePickerCandidateByPreviewUuid\(seen, target\)/.test(resolverBody) && resolverBody.includes('flow-content') && resolverBody.includes('video'));

// (b)/(c)/(d): the pure resolver used by the canonical path.
check('8BX(b) zero preview matches -> fail closed', resolvePickerCandidateByPreviewUuid([url(OTHER)], TARGET).ok === false && String((resolvePickerCandidateByPreviewUuid([url(OTHER)], TARGET) as any).reason).toLowerCase().includes('no picker row'));
check('8BX(c) >1 preview matches -> fail closed (never picks the first)', (() => { const r: any = resolvePickerCandidateByPreviewUuid([url(TARGET), url(TARGET)], TARGET); return r.ok === false; })());
check('8BX(d) exactly one preview match selects the intended artifact index', (() => { const r: any = resolvePickerCandidateByPreviewUuid([url(OTHER), url(TARGET)], TARGET); return r.ok === true && r.rowIndex === 1; })());

// Behavioural (offline, stubbed page): the canonical attach performs exactly ONE
// mutation ("Add media") and NEVER a second, and fails closed with 0 matches.
const makeClient = (opts: { previews: string[]; addMediaClickFails?: boolean; pickerClosesAfterClick?: boolean }) => {
  let addMediaClicks = 0; let rowClicks = 0; let previewIdx = 0; let pickerClosed = false;
  const page: any = {
    locator: (sel: string) => {
      // The Videos tab / Add clip / row locators are only touched by the resolver/tab logic.
      const make = (id: string): any => ({
        first: () => make(id),
        filter: () => make(id),
        locator: (child?: string) => make(child ? `${id} ${child}` : id),
        waitFor: async () => {},
        isVisible: async () => !(pickerClosed && /detail-add-to-prompt-btn/.test(id)) ? true : false,
        getAttribute: async () => 'true',
        click: async () => {
          if (/asset-item\[role="option"\]/.test(id)) { rowClicks++; previewIdx = Math.min(previewIdx + 1, opts.previews.length - 1); }
          else if (/detail-add-to-prompt-btn/.test(id)) { addMediaClicks++; if (opts.pickerClosesAfterClick) pickerClosed = true; }
        },
        count: async () => (/detail-add-to-prompt-btn/.test(id) ? 1 : opts.previews.length),
        nth: () => make(id),
      });
      return make(sel);
    },
    evaluate: async (fn: any) => {
      // Hydration poller evaluates a function containing `rowCount` and expects an
      // evidence object; the preview reader expects the raw preview URL string.
      const src = opts.previews[Math.min(previewIdx, opts.previews.length - 1)] ?? '';
      const body = typeof fn === 'function' ? String(fn) : String(fn ?? '');
      if (body.includes('rowCount')) return { rowCount: opts.previews.length, previewSrc: src };
      return src;
    },
    keyboard: { press: async () => {} },
    url: () => 'https://flow.google.com/project/p/scene/s',
  };
  const client: any = new FlowClient(page, () => {});
  client.sceneHasClip = async () => false;                 // empty scene
  client.waitForMediaPickerSurface = async () => page.locator('div.flow-media-picker-dialog-panel').first();
  client.waitForClipEvidence = async () => false;          // simulate NO immediate clip (race)
  return { client, counts: () => ({ addMediaClicks, rowClicks }) };
};

{
  // (d) one exact preview already shown -> resolver returns ok without extra row probing;
  // attach mutates "Add media" exactly once, and no immediate clip is NOT fatal.
  const { client, counts } = makeClient({ previews: [url(TARGET)] });
  const r = await client.attachGeneratedVideoToEmptyScene(TARGET.toLowerCase());
  check('8BX(d) canonical attach performs exactly ONE Add media mutation', counts().addMediaClicks === 1, JSON.stringify(counts()));
  check('8BX(e) picker/missing-immediate-clip race does NOT throw (delegated to persistence)',
    r && r.mode === 'attached' && r.artifactId === TARGET.toLowerCase() && r.persistent === true, JSON.stringify(r));
}
{
  // (b) 0 matches -> fail closed BEFORE any mutation.
  const { client, counts } = makeClient({ previews: [url(OTHER)] });
  let msg = ''; try { await client.attachGeneratedVideoToEmptyScene(TARGET); } catch (e: any) { msg = String(e.message); }
  check('8BX(b) canonical attach fails closed on 0 preview matches', /Empty-scene attach failed/.test(msg), msg);
  check('8BX(b) 0 matches performs NO Add media mutation', counts().addMediaClicks === 0, JSON.stringify(counts()));
}
{
  // (e) picker closes right after the mutation -> still no throw (success delegated).
  const { client, counts } = makeClient({ previews: [url(TARGET)], pickerClosesAfterClick: true });
  const r = await client.attachGeneratedVideoToEmptyScene(TARGET);
  check('8BX(e) post-click picker disappearance is tolerated (no attachment failure)', r.persistent === true && counts().addMediaClicks === 1, JSON.stringify({ r, counts: counts() }));
}

// ===========================================================================
// SELECTED-ROW PREVIEW CONTRACT (live-proven, zero credit) — behavioural regression.
//
// The picker AUTO-SELECTS row 0 on open and previews it immediately. Clicking that already-selected
// row is a DESTRUCTIVE TOGGLE: it deselects the row and DESTROYS the detail pane, taking
// video.video-preview — the only identity surface in the app — with it. The resolver must therefore
// READ a selected row and CLICK only an unselected one.
//
// The stub below models that UI faithfully: `aria-selected` per row, one shared preview that moves
// on a safe click, and pane destruction on a click of the already-selected row.
// ===========================================================================
const rowUuid = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const LIBRARY_12 = Array.from({ length: 12 }, (_, i) => rowUuid(i));

const makeSelectionAwareClient = (opts: { rowUuids: string[]; initiallySelected?: number }) => {
  const rowUuids = opts.rowUuids;
  let paneAlive = true;
  let selected = opts.initiallySelected ?? 0;
  let addMediaClicks = 0;
  const clickedRows: number[] = [];
  const sharedPreview = () => (paneAlive && selected >= 0 && selected < rowUuids.length ? url(rowUuids[selected]) : null);

  const make = (sel: string, idx: number | null = null): any => ({
    first: () => make(sel, 0),
    filter: () => make(sel, idx),
    locator: (child?: string) => make(child ? `${sel} ${child}` : sel, idx),
    waitFor: async () => {},
    isVisible: async () => true,
    getAttribute: async (name: string) => (name === 'aria-selected' ? (idx !== null && idx === selected ? 'true' : 'false') : 'true'),
    // readPickerRowSelectionState evaluates on the ROW element and maps the attribute to a strict boolean
    evaluate: async () => (idx !== null && idx === selected),
    click: async () => {
      if (/asset-item\[role="option"\]/.test(sel) && idx !== null) {
        clickedRows.push(idx);
        if (idx === selected) { selected = -1; paneAlive = false; }   // destructive toggle
        else selected = idx;                                            // safe preview action
      } else if (/detail-add-to-prompt-btn/.test(sel)) {
        addMediaClicks += 1;
      }
    },
    count: async () => (/detail-add-to-prompt-btn/.test(sel) ? 1 : (/asset-item\[role="option"\]/.test(sel) ? rowUuids.length : 1)),
    nth: (n: number) => make(sel, n),
  });

  const page: any = {
    locator: (sel: string) => make(sel),
    evaluate: async (fn: any) => {
      const body = typeof fn === 'function' ? String(fn) : String(fn ?? '');
      if (body.includes('rowCount')) return { rowCount: rowUuids.length, previewSrc: sharedPreview() };
      return sharedPreview();
    },
    keyboard: { press: async () => {} },
    url: () => 'https://flow.google.com/project/p/scene/s',
  };
  const client: any = new FlowClient(page, () => {});
  client.sceneHasClip = async () => false;
  client.waitForMediaPickerSurface = async () => page.locator('div.flow-media-picker-dialog-panel').first();
  client.waitForClipEvidence = async () => false;
  return { client, clickedRows, addMediaClicks: () => addMediaClicks, paneAlive: () => paneAlive };
};

{
  // (1) TARGET IS ROW 0 — already selected: READ it, never click it.
  const t0 = LIBRARY_12[0];
  const { client, clickedRows, addMediaClicks } = makeSelectionAwareClient({ rowUuids: LIBRARY_12, initiallySelected: 0 });
  const r = await client.attachGeneratedVideoToEmptyScene(t0);
  check('SR1 a row-0 target resolves through a READ with ZERO row clicks', clickedRows.length === 0, clickedRows);
  check('SR1b the row-0 attach still performs exactly ONE Add media mutation', addMediaClicks() === 1, addMediaClicks());
  check('SR1c the row-0 attach reports persistent', r.mode === 'attached' && r.artifactId === t0);
}
{
  // (2) TARGET IS ROW 3 — row 0 is READ (not clicked), rows 1..3 are clicked.
  const t3 = LIBRARY_12[3];
  const { client, clickedRows, addMediaClicks } = makeSelectionAwareClient({ rowUuids: LIBRARY_12, initiallySelected: 0 });
  const r = await client.attachGeneratedVideoToEmptyScene(t3);
  check('SR2 a row-3 target resolves after clicking rows 1..3', JSON.stringify(clickedRows) === JSON.stringify([1, 2, 3]), clickedRows);
  check('SR2b row 0 is NEVER clicked merely to advance the scan', !clickedRows.includes(0), clickedRows);
  check('SR2c the row-3 attach performs exactly ONE Add media mutation', addMediaClicks() === 1, addMediaClicks());
  check('SR2d the row-3 attach reports persistent', r.artifactId === t3);
}
{
  // (3) TARGET IS ROW 11 — the last row: every non-selected row is clicked, row 0 never is.
  const t11 = LIBRARY_12[11];
  const { client, clickedRows, addMediaClicks } = makeSelectionAwareClient({ rowUuids: LIBRARY_12, initiallySelected: 0 });
  const r = await client.attachGeneratedVideoToEmptyScene(t11);
  check('SR3 a row-11 target resolves after clicking rows 1..11', JSON.stringify(clickedRows) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), clickedRows);
  check('SR3b row 0 is NEVER clicked merely to advance the scan', !clickedRows.includes(0), clickedRows);
  check('SR3c the row-11 attach performs exactly ONE Add media mutation', addMediaClicks() === 1, addMediaClicks());
  check('SR3d the row-11 attach reports persistent', r.artifactId === t11);
}
{
  // (4) A target that is NOT in the library fails closed with NO mutation (all 11 rows scanned).
  const absent = '99999999-1111-4111-8111-111111111111';
  const { client, clickedRows, addMediaClicks } = makeSelectionAwareClient({ rowUuids: LIBRARY_12, initiallySelected: 0 });
  let msg = ''; try { await client.attachGeneratedVideoToEmptyScene(absent); } catch (e: any) { msg = String(e.message); }
  check('SR4 an absent target fails closed with NO Add media mutation', addMediaClicks() === 0 && /No picker row previewed the target artifact/.test(msg), msg);
  check('SR4b the full scan still never clicked the selected row 0', !clickedRows.includes(0) && clickedRows.length === 11, clickedRows);
}
{
  // (5) A library containing the target twice still mutates EXACTLY ONCE and never twice.
  const dup = [...LIBRARY_12.slice(0, 4)];
  dup[2] = dup[1];                       // rows 1 and 2 now expose the identical artifact
  const { client, clickedRows, addMediaClicks } = makeSelectionAwareClient({ rowUuids: dup, initiallySelected: 0 });
  const r = await client.attachGeneratedVideoToEmptyScene(dup[1]);
  check('SR5 a duplicated target across two rows still performs EXACTLY ONE Add media mutation',
    addMediaClicks() === 1 && r.artifactId === dup[1], { addMediaClicks: addMediaClicks() });
  check('SR5b the resolver short-circuits on the first exact preview match (no further rows clicked)',
    JSON.stringify(clickedRows) === JSON.stringify([1]), clickedRows);
  check('SR5c the >1-match ambiguity guard is still enforced by the pure matcher',
    resolvePickerCandidateByPreviewUuid([url(dup[1]), url(dup[1])], dup[1]).ok === false);
}
{
  // (6) NO title matching: two rows may share one exact title; only the preview uuid decides.
  const shared = makeSelectionAwareClient({ rowUuids: LIBRARY_12, initiallySelected: 0 });
  check('SR6 rows with identical titles but distinct uuids still resolve by preview uuid only',
    (await shared.client.attachGeneratedVideoToEmptyScene(LIBRARY_12[5])).artifactId === LIBRARY_12[5]
    && JSON.stringify(shared.clickedRows) === JSON.stringify([1, 2, 3, 4, 5]), shared.clickedRows);
}
{
  // (7) An UNESTABLISHED selection state must produce NO click at all (fail closed).
  const rowUuids = LIBRARY_12;
  let paneAlive = true; let selected = 0; let addMediaClicks = 0; const clickedRows: number[] = [];
  const make = (sel: string, idx: number | null = null): any => ({
    first: () => make(sel, 0),
    filter: () => make(sel, idx),
    locator: (child?: string) => make(child ? `${sel} ${child}` : sel, idx),
    waitFor: async () => {},
    isVisible: async () => true,
    getAttribute: async () => 'true',
    evaluate: async () => { throw new Error('selection state unavailable'); },   // -> null
    click: async () => {
      if (/asset-item\[role="option"\]/.test(sel) && idx !== null) {
        clickedRows.push(idx); selected = idx;
      } else if (/detail-add-to-prompt-btn/.test(sel)) addMediaClicks += 1;
    },
    count: async () => (/detail-add-to-prompt-btn/.test(sel) ? 1 : (/asset-item\[role="option"\]/.test(sel) ? rowUuids.length : 1)),
    nth: (n: number) => make(sel, n),
  });
  const page: any = {
    locator: (sel: string) => make(sel),
    evaluate: async (fn: any) => (String(fn).includes('rowCount')
      ? { rowCount: rowUuids.length, previewSrc: url(rowUuids[selected]) }
      : url(rowUuids[selected])),
    keyboard: { press: async () => {} },
    url: () => 'https://flow.google.com/project/p/scene/s',
  };
  const client: any = new FlowClient(page, () => {});
  client.sceneHasClip = async () => false;
  client.waitForMediaPickerSurface = async () => page.locator('div.flow-media-picker-dialog-panel').first();
  client.waitForClipEvidence = async () => false;
  await client.attachGeneratedVideoToEmptyScene(rowUuids[0]);
  check('SR7 an unreadable selection state performs NO row click (fails closed toward READ)', clickedRows.length === 0, clickedRows);
  check('SR7b the already-displayed row-0 target still resolves and mutates exactly once', addMediaClicks === 1 && paneAlive, { addMediaClicks });
}
{
  // (8) Source audit: no hardcoded uuid, no title/asb/order identity inside the resolver.
  check('SR8 the resolver contains no hardcoded uuid and no title/asb/row-order identity',
    !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(resolverBody)
    && !/asset-title|\/asb\/|hasText|\.first\(\)/.test(resolverBody.replace(/rows\.nth\(i\)/g, '')), resolverBody.slice(0, 200));
  check('SR9 the resolver reads the selection state and defers to the pure decision helper',
    /readPickerRowSelectionState\(rows\.nth\(i\)\)/.test(resolverBody)
    && /decideRowPreviewAction\(selected\)/.test(resolverBody));
  check('SR10 the resolver still fails closed through the existing pure matcher and keeps the 1200 ms settle',
    /resolvePickerCandidateByPreviewUuid\(seen, target\)/.test(resolverBody)
    && /setTimeout\(r, 1200\)/.test(resolverBody));
}

console.log(`\nFIRST-CLIP PREVIEW-IDENTITY TESTS PASSED (${passed} checks)`);
