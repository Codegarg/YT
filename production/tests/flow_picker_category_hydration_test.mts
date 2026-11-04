// Focused OFFLINE tests for the picker CATEGORY-LABEL HYDRATION race.
// No browser, no Flow, no network, no real sleeps: `read` and `sleep` are injected.
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const M = await import(pathToFileURL(`${SRC}/flowClient.ts`).href);
const { decideCategoryLabelRead, awaitCategoryLabels, CATEGORY_LABEL_HYDRATION_DEFAULTS } = M as any;
// The SAME exact-match resolver the generation reader passes its labels to, so GEN CASE A proves
// the downstream step actually succeeds on the labels the helper returns.
const P = await import(pathToFileURL(`${SRC}/projectCategoryLabel.ts`).href);
const { findProjectAssetCategory: findCategory } = P as any;

let passed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed += 1; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const WANTED = 'Videos';
const GOOD = { panelVisible: true, labels: ['Characters', 'Videos', 'Uploads'] };

// ================= PURE DECISION =================
check('accept: wanted label present', decideCategoryLabelRead({ observation: GOOD, wanted: WANTED }).action === 'ACCEPT');
check('accept: stops on the FIRST read, no retry needed', decideCategoryLabelRead({ observation: GOOD, wanted: WANTED, attempt: 1, maxAttempts: 24 }).action === 'ACCEPT');
check('retry: panel visible + ZERO labels -> RETRY (this is the race)', decideCategoryLabelRead({ observation: { panelVisible: true, labels: [] }, wanted: WANTED, attempt: 1, maxAttempts: 24 }).action === 'RETRY');
check('retry: blank/whitespace labels are normalised to empty and still RETRY', decideCategoryLabelRead({ observation: { panelVisible: true, labels: ['  ', ''] }, wanted: WANTED, attempt: 1, maxAttempts: 24 }).action === 'RETRY');
check('fail closed: panel NOT visible -> FAIL_CLOSED immediately, never retried', decideCategoryLabelRead({ observation: { panelVisible: false, labels: [] }, wanted: WANTED, attempt: 1, maxAttempts: 24 }).action === 'FAIL_CLOSED');
check('retry: a PARTIAL render missing the wanted label is still hydration, not a mismatch', decideCategoryLabelRead({ observation: { panelVisible: true, labels: ['Characters'] }, wanted: WANTED, attempt: 1, maxAttempts: 24, settledLabels: [] }).action === 'RETRY');
check('fail closed: a SETTLED list (identical twice) without the wanted label -> FAIL_CLOSED', decideCategoryLabelRead({ observation: { panelVisible: true, labels: ['Characters', 'Uploads'] }, wanted: WANTED, attempt: 2, maxAttempts: 24, settledLabels: ['Characters', 'Uploads'] }).action === 'FAIL_CLOSED');
check('fail closed: a changing list is never treated as settled', decideCategoryLabelRead({ observation: { panelVisible: true, labels: ['Characters', 'Uploads'] }, wanted: WANTED, attempt: 2, maxAttempts: 24, settledLabels: ['Characters'] }).action === 'RETRY');
check('never weakens: a settled list that lacks the wanted label is never ACCEPTed', decideCategoryLabelRead({ observation: { panelVisible: true, labels: ['Characters'] }, wanted: WANTED, attempt: 2, maxAttempts: 24, settledLabels: ['Characters'] }).action !== 'ACCEPT');
check('fail closed: missing observation -> FAIL_CLOSED', decideCategoryLabelRead({ observation: null, wanted: WANTED }).action === 'FAIL_CLOSED');
check('fail closed: no wanted label -> FAIL_CLOSED', decideCategoryLabelRead({ observation: GOOD, wanted: '' }).action === 'FAIL_CLOSED');
check('bounded: RETRY stops at the attempt cap', decideCategoryLabelRead({ observation: { panelVisible: true, labels: [] }, wanted: WANTED, attempt: 24, maxAttempts: 24 }).action === 'FAIL_CLOSED');
check('bounded: the last permitted attempt is still a RETRY', decideCategoryLabelRead({ observation: { panelVisible: true, labels: [] }, wanted: WANTED, attempt: 23, maxAttempts: 24 }).action === 'RETRY');
check('never weakens: an empty label list is NEVER accepted', (() => { for (let a = 1; a <= 24; a++) if (decideCategoryLabelRead({ observation: { panelVisible: true, labels: [] }, wanted: WANTED, attempt: a, maxAttempts: 24 }).action === 'ACCEPT') return false; return true; })());

// ================= CASE A — labels appear during a bounded retry =================
const caseA = await (async () => {
  const seq = [
    { panelVisible: true, labels: [] },              // 1: panel up, tabs not rendered
    { panelVisible: true, labels: [] },              // 2: still not rendered
    { panelVisible: true, labels: ['Characters'] },   // 3: partially rendered
    { panelVisible: true, labels: ['Characters', 'Videos', 'Uploads'] }, // 4: hydrated
  ];
  let i = 0; let sleeps = 0;
  const r = await awaitCategoryLabels({
    read: async () => seq[Math.min(i++, seq.length - 1)],
    wanted: WANTED,
    sleep: async () => { sleeps += 1; },   // no real delay
  });
  return { r, reads: i, sleeps };
})();
check('CASE A: succeeds after the categories render during the bounded retry', caseA.r.ok === true, caseA.r);
check('CASE A: stopped as soon as the wanted label was available (4 reads, not 24)', caseA.r.attempts === 4 && caseA.reads === 4, caseA);
check('CASE A: slept between retries only, never before the first read', caseA.sleeps === 3, caseA);
check('CASE A: returns the rendered labels', caseA.r.ok === true && caseA.r.labels.includes(WANTED));

// ================= CASE B — labels never render; deadline expires, fail closed =================
const caseB = await (async () => {
  let reads = 0; let sleeps = 0;
  const r = await awaitCategoryLabels({
    read: async () => { reads += 1; return { panelVisible: true, labels: [] }; },  // never hydrates
    wanted: WANTED,
    sleep: async () => { sleeps += 1; },
    maxAttempts: 5,
  });
  return { r, reads, sleeps };
})();
check('CASE B: fails closed with PICKER_UNAVAILABLE', caseB.r.ok === false && caseB.r.code === 'PICKER_UNAVAILABLE', caseB.r);
check('CASE B: reason names the hydration deadline, not a generic absence', /did not render|hydration deadline/i.test(String(caseB.r.reason)), caseB.r.reason);
check('CASE B: bounded - exactly maxAttempts reads, never an infinite loop', caseB.r.attempts === 5 && caseB.reads === 5, caseB);
check('CASE B: never returns a usable label list', Array.isArray(caseB.r.labels) && caseB.r.labels.length === 0);

// ================= CASE B2 — the wall-clock deadline also stops the loop =================
const caseB2 = await (async () => {
  let reads = 0; let fakeNow = 0;
  const realNow = Date.now;
  (Date as any).now = () => fakeNow;
  try {
    const r = await awaitCategoryLabels({
      read: async () => { reads += 1; fakeNow += 1000; return { panelVisible: true, labels: [] }; },
      wanted: WANTED,
      sleep: async () => {},
      deadlineMs: 3000,
      maxAttempts: 1000,      // cap deliberately huge: the deadline must be what stops it
    });
    return { r, reads };
  } finally { (Date as any).now = realNow; }
})();
check('CASE B2: the explicit deadline stops the loop even when maxAttempts is huge', caseB2.r.ok === false && caseB2.r.attempts < 1000, caseB2);
check('CASE B2: deadline failure is PICKER_UNAVAILABLE', caseB2.r.code === 'PICKER_UNAVAILABLE');

// ================= CASE C — a genuinely absent panel fails immediately =================
const caseC = await (async () => {
  let reads = 0; let sleeps = 0;
  const r = await awaitCategoryLabels({
    read: async () => { reads += 1; return { panelVisible: false, labels: [] }; },
    wanted: WANTED,
    sleep: async () => { sleeps += 1; },
  });
  return { r, reads, sleeps };
})();
check('CASE C: an absent panel fails on the first read without retrying', caseC.r.ok === false && caseC.r.code === 'PICKER_UNAVAILABLE' && caseC.reads === 1 && caseC.sleeps === 0, caseC);

// ================= CASE D — rendered categories without the wanted label =================
const caseD = await (async () => {
  let reads = 0;
  const r = await awaitCategoryLabels({
    read: async () => { reads += 1; return { panelVisible: true, labels: ['Characters', 'Uploads'] }; },
    wanted: WANTED,
    sleep: async () => {},
  });
  return { r, reads };
})();
check('CASE D: a settled list without the wanted label fails closed', caseD.r.ok === false && caseD.r.code === 'PICKER_UNAVAILABLE', caseD.r);
check('CASE D: it is detected as settled after two identical reads, then stopped', caseD.reads === 2, caseD);

const caseE = await (async () => {
  let reads = 0; const seen: string[][] = [];
  const r = await awaitCategoryLabels({
    read: async () => {
      const next = [['Characters'], ['Characters', 'Images'], ['Characters', 'Images', 'Videos']][Math.min(reads, 2)];
      reads += 1; seen.push(next); return { panelVisible: true, labels: next };
    },
    wanted: WANTED,
    sleep: async () => {},
  });
  return { r, reads, seen };
})();
check('CASE E: a still-GROWING list is retried, not failed', caseE.r.ok === true && caseE.reads === 3, caseE);
check('CASE E: no growing snapshot was ever mistaken for settled', caseE.r.ok === true);

// ================= defaults are short and bounded =================
check('defaults: poll is short (<=500ms), deadline <=10s, attempts <=32', CATEGORY_LABEL_HYDRATION_DEFAULTS.pollMs <= 500 && CATEGORY_LABEL_HYDRATION_DEFAULTS.deadlineMs <= 10000 && CATEGORY_LABEL_HYDRATION_DEFAULTS.maxAttempts <= 32, CATEGORY_LABEL_HYDRATION_DEFAULTS);
check('defaults: a real-time run terminates (deadline is finite)', Number.isFinite(CATEGORY_LABEL_HYDRATION_DEFAULTS.deadlineMs) && CATEGORY_LABEL_HYDRATION_DEFAULTS.deadlineMs > 0);

// ================= source guard: the fix is narrowly scoped =================
const fs = await import('node:fs');
const raw = fs.readFileSync(`${SRC}/flowClient.ts`, 'utf8');
const code = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
check('source: resolveArtifactSignedMediaUrl uses the bounded hydration helper', /awaitCategoryLabels\(\{/.test(code) && /PROJECT_LIBRARY_VIDEO_CATEGORY,/.test(code.slice(code.indexOf('async resolveArtifactSignedMediaUrl'), code.indexOf('async resolveArtifactSignedMediaUrl') + 6000)));
check('source: the single-shot label read is gone from that method', (() => {
  const seg = code.slice(code.indexOf('async resolveArtifactSignedMediaUrl'), code.indexOf('async resolveArtifactSignedMediaUrl') + 6000);
  return !/const labels: string\[\] = await this\.page\.evaluate/.test(seg);
})());
check('source: no page reload, no generation and no attachment added by the fix', !/page\.reload|waitForNavigation/.test(code.slice(code.indexOf('const hydration = await awaitCategoryLabels'), code.indexOf('const hydration = await awaitCategoryLabels') + 2500)));
check('source: the exact-match category resolver is still used afterwards', /findProjectAssetCategory\(\{ labels, wanted: PROJECT_LIBRARY_VIDEO_CATEGORY \}\)/.test(code));
check('source: PICKER_UNAVAILABLE classification is preserved', (code.match(/code: 'PICKER_UNAVAILABLE'/g) ?? []).length >= 3);

// =====================================================================================
// SECOND CALL SITE — the GENERATION-path reader.
//
// Scene 3 stopped before Start-generation with 0 credits because this reader still did a
// SINGLE-SHOT category-label read. `generateProjectFirstClip()` polls it via
// `waitForStablePickerBaseline()` and requires two consecutive identical COMPLETE snapshots,
// so a single transient empty-label observation was enough to refuse the generation.
// `readSceneVideoLibraryUuidsViaPreview()` now routes through the SAME `awaitCategoryLabels()`
// driver. This is a regression guard, not a new helper: the driver itself is untouched.
// =====================================================================================
const methodSeg = (name: string, span = 9000) => {
  const i = code.indexOf(name);
  return i < 0 ? '' : code.slice(i, i + span);
};
const genReader = methodSeg('async readSceneVideoLibraryUuidsViaPreview');

check('source: readSceneVideoLibraryUuidsViaPreview exists and uses awaitCategoryLabels()',
  genReader.length > 0 && /awaitCategoryLabels\(\{/.test(genReader), genReader.length);
check('source: readSceneVideoLibraryUuidsViaPreview no longer does a single-shot label read',
  genReader.length > 0 && !/const labels: string\[\] = await this\.page\.evaluate/.test(genReader));
check('source: the generation reader still resolves the category through findProjectAssetCategory',
  /findProjectAssetCategory\(\{ labels, wanted: PROJECT_LIBRARY_VIDEO_CATEGORY \}\)/.test(genReader));
check('source: the generation reader feeds the helper labels straight into the existing resolver',
  /const labels: string\[\] = categoryHydration\.labels;/.test(genReader));
check('source: the generation reader still fails closed with PICKER_UNAVAILABLE/INVALID on hydration failure',
  /if \(!categoryHydration\.ok\)/.test(genReader)
  && /code: 'PICKER_UNAVAILABLE', completeness: 'INVALID'/.test(genReader));
check('source: the fix adds no page reload and no navigation to the generation reader',
  !/page\.reload|waitForNavigation|goto\(/.test(genReader));
// `awaitCategoryLabels` itself matches an `(await|waitFor)…CategoryLabel` shape, so the existing
// driver is subtracted before looking for any ADDITIONAL helper of the same family.
const categoryLabelHelpers = (code.match(/export (?:async )?function [A-Za-z0-9_]*[Cc]ategoryLabel[A-Za-z0-9_]*\(/g) ?? [])
  .filter((s) => !/awaitCategoryLabels|decideCategoryLabelRead/.test(s)); // the two EXISTING exports
check('source: the fix introduces NO second hydration helper (only the existing driver is defined)',
  (code.match(/export async function awaitCategoryLabels\(/g) ?? []).length === 1
  && categoryLabelHelpers.length === 0, categoryLabelHelpers);
check('source: exactly TWO call sites now consume the shared driver',
  (code.match(/awaitCategoryLabels\(\{/g) ?? []).length === 2,
  (code.match(/awaitCategoryLabels\(\{/g) ?? []).length);
check('source: the already-fixed resolveArtifactSignedMediaUrl path remains protected',
  /awaitCategoryLabels\(\{/.test(methodSeg('async resolveArtifactSignedMediaUrl', 6000))
  && !/const labels: string\[\] = await this\.page\.evaluate/.test(methodSeg('async resolveArtifactSignedMediaUrl', 6000)));
check('source: the 200s baseline stability budget is unchanged',
  /waitForStablePickerBaseline\(targetSceneId: string, timeoutMs = pickerBaselineBudgetMs\(\)/.test(code));

// ---------- CASE A: labels absent, then appear during bounded polling -> reader continues ----------
const genCaseA = await (async () => {
  const seq = [
    { panelVisible: true, labels: [] },                                          // panel up, tabs not rendered
    { panelVisible: true, labels: ['Characters', 'Images'] },                     // partial / growing
    { panelVisible: true, labels: ['Characters', 'Images', 'Videos'] },           // hydrated
  ];
  let i = 0; let sleeps = 0;
  const r = await awaitCategoryLabels({ read: async () => seq[Math.min(i++, seq.length - 1)], wanted: WANTED, sleep: async () => { sleeps += 1; } });
  // the downstream step the generation reader performs next
  const resolved = r.ok ? findCategory({ labels: r.labels, wanted: WANTED }) : { ok: false };
  return { r, resolved, reads: i, sleeps };
})();
// PROJECT_LIBRARY_VIDEO_CATEGORY is module-private in flowClient.ts, so bind the canonical literal
// from the SOURCE instead of importing it, and assert the two agree.
const canonicalVideoCategory = /const PROJECT_LIBRARY_VIDEO_CATEGORY = '([^']+)'/.exec(code)?.[1] ?? null;
check('GEN CASE A: the canonical Videos constant is Videos, matching the case under test',
  canonicalVideoCategory === WANTED, { canonical: canonicalVideoCategory, testWanted: WANTED });
check('GEN CASE A: bounded retry succeeds once the categories render', genCaseA.r.ok === true, genCaseA.r);
check('GEN CASE A: the Videos category is returned to the downstream resolver', genCaseA.resolved.ok === true, genCaseA.resolved);
check('GEN CASE A: it stops at the FIRST render that contains Videos (3 reads, not 24)', genCaseA.r.attempts === 3 && genCaseA.reads === 3, genCaseA);

// ---------- CASE B: labels never appear -> bounded fail-closed, no infinite retry ----------
const genCaseB = await (async () => {
  let reads = 0; let sleeps = 0;
  const r = await awaitCategoryLabels({ read: async () => { reads += 1; return { panelVisible: true, labels: [] }; }, wanted: WANTED, sleep: async () => { sleeps += 1; }, maxAttempts: 6 });
  return { r, reads, sleeps };
})();
check('GEN CASE B: fails closed when labels never render', genCaseB.r.ok === false && genCaseB.r.code === 'PICKER_UNAVAILABLE', genCaseB.r);
check('GEN CASE B: bounded - exactly maxAttempts reads, never an infinite loop', genCaseB.r.attempts === 6 && genCaseB.reads === 6, genCaseB);
check('GEN CASE B: returns no labels, so the downstream resolver cannot run', genCaseB.r.labels.length === 0);
check('GEN CASE B: the deadline alone bounds the loop even with a huge attempt cap', await (async () => {
  const r = await awaitCategoryLabels({
    read: async () => { await new Promise((res) => setTimeout(res, 5)); return { panelVisible: true, labels: [] }; },
    wanted: WANTED, sleep: async () => {}, deadlineMs: 120, maxAttempts: 100000,
  });
  return r.ok === false && r.attempts < 100000;
})());

// =====================================================================================
// LIGATURE NORMALISATION — the exact live failure that blocked Scene 3.
//
// The picker renders categories with their Material icon ligature glued on:
//   ["videocam Videos", "drive_folder_upload Uploads"]
// `decideCategoryLabelRead()` compared RAW text, so a fully settled, healthy picker failed closed
// on `"videocam Videos" !== "Videos"` and the generation baseline gate refused to click Start.
// The fix reuses the repository's canonical `normalizeProjectAssetCategoryLabel()` and preserves
// EXACT equality after normalisation — no includes/startsWith/substring/case-folding/regex.
// =====================================================================================
const { normalizeProjectAssetCategoryLabel: norm } = P as any;
const LIVE = ['videocam Videos', 'drive_folder_upload Uploads'];

// -- CASE 1: the live label set, wanted Videos -> ACCEPT
check('CASE 1: "videocam Videos" is ACCEPTed for wanted "Videos" (the live Scene 3 blocker)',
  decideCategoryLabelRead({ observation: { panelVisible: true, labels: LIVE }, wanted: WANTED }).action === 'ACCEPT',
  decideCategoryLabelRead({ observation: { panelVisible: true, labels: LIVE }, wanted: WANTED }));
check('CASE 1: the canonical normalizer maps the live labels to ["Videos","Uploads"]',
  JSON.stringify(LIVE.map(norm)) === JSON.stringify(['Videos', 'Uploads']), LIVE.map(norm));

// -- CASE 2: the same live set, wanted Uploads -> ACCEPT
check('CASE 2: "drive_folder_upload Uploads" is ACCEPTed for wanted "Uploads"',
  decideCategoryLabelRead({ observation: { panelVisible: true, labels: LIVE }, wanted: 'Uploads' }).action === 'ACCEPT');

// -- CASE 2b: a glued-ligature textContent form is handled by the same canonical normalizer
check('CASE 2b: the glued textContent form "videocamVideos" also normalises to Videos',
  norm('videocamVideos') === 'Videos', norm('videocamVideos'));
check('CASE 2b: and is ACCEPTed for wanted "Videos"',
  decideCategoryLabelRead({ observation: { panelVisible: true, labels: ['videocamVideos'] }, wanted: WANTED }).action === 'ACCEPT');

// -- CASE 2c: end-to-end through the driver AND the real downstream resolver
const ligE2E = await (async () => {
  let reads = 0;
  const r = await awaitCategoryLabels({ read: async () => { reads += 1; return { panelVisible: true, labels: LIVE }; }, wanted: WANTED, sleep: async () => {} });
  return { r, reads, resolved: r.ok ? findCategory({ labels: r.labels, wanted: WANTED }) : { ok: false } };
})();
check('CASE 2c: driver returns ok on the first read of the live label set', ligE2E.r.ok === true, ligE2E.r);
check('CASE 2c: the downstream findProjectAssetCategory resolves Videos from the returned labels',
  ligE2E.resolved.ok === true && ligE2E.resolved.index === 0, ligE2E.resolved);
check('CASE 2c: it took exactly one read - no retry was needed', ligE2E.r.attempts === 1);

// -- CASE 3: a settled, unrelated category -> FAIL_CLOSED (not a retry loop)
const case3a = decideCategoryLabelRead({ observation: { panelVisible: true, labels: ['Some Other Category'] }, wanted: WANTED, attempt: 1, maxAttempts: 24 });
const case3b = decideCategoryLabelRead({ observation: { panelVisible: true, labels: ['Some Other Category'] }, wanted: WANTED, attempt: 2, maxAttempts: 24, settledLabels: ['Some Other Category'] });
check('CASE 3: a first observation of an unrelated category RETRIES (may still be growing)', case3a.action === 'RETRY', case3a);
check('CASE 3: two identical settled observations without Videos FAIL_CLOSED', case3b.action === 'FAIL_CLOSED', case3b);
check('CASE 3: the settled live-shaped set also FAIL_CLOSEDs when Videos is wanted but absent',
  decideCategoryLabelRead({ observation: { panelVisible: true, labels: ['drive_folder_upload Uploads'] }, wanted: WANTED, attempt: 2, maxAttempts: 24, settledLabels: ['drive_folder_upload Uploads'] }).action === 'FAIL_CLOSED');

// -- CASE 4: normalisation must not manufacture a false positive
check('CASE 4: substring must NOT match - "Videos Archive" is not "Videos"',
  decideCategoryLabelRead({ observation: { panelVisible: true, labels: ['Videos Archive'] }, wanted: WANTED, attempt: 2, maxAttempts: 24, settledLabels: ['Videos Archive'] }).action === 'FAIL_CLOSED');
check('CASE 4: prefix must NOT match - "My Videos" is not "Videos"',
  decideCategoryLabelRead({ observation: { panelVisible: true, labels: ['My Videos'] }, wanted: WANTED, attempt: 2, maxAttempts: 24, settledLabels: ['My Videos'] }).action === 'FAIL_CLOSED');
check('CASE 4: case-folding must NOT match - "videos" is not "Videos"',
  decideCategoryLabelRead({ observation: { panelVisible: true, labels: ['videos'] }, wanted: WANTED, attempt: 2, maxAttempts: 24, settledLabels: ['videos'] }).action === 'FAIL_CLOSED');
check('CASE 4: an ICON-ONLY item normalises to "" and can never satisfy a wanted human label',
  norm('videocam') === ''
  && decideCategoryLabelRead({ observation: { panelVisible: true, labels: ['videocam'] }, wanted: WANTED, attempt: 2, maxAttempts: 24, settledLabels: ['videocam'] }).action === 'FAIL_CLOSED');
check('CASE 4: a wanted value that normalises to empty is refused (an empty label is never matched)',
  decideCategoryLabelRead({ observation: { panelVisible: true, labels: LIVE }, wanted: 'videocam' }).action === 'FAIL_CLOSED');
check('CASE 4: a missing wanted label is still refused', decideCategoryLabelRead({ observation: { panelVisible: true, labels: LIVE }, wanted: '' }).action === 'FAIL_CLOSED');

// -- CASE 5: existing hydration behaviour is preserved
check('CASE 5: zero labels still RETRY', decideCategoryLabelRead({ observation: { panelVisible: true, labels: [] }, wanted: WANTED, attempt: 1, maxAttempts: 24 }).action === 'RETRY');
check('CASE 5: a still-growing list still RETRYs',
  decideCategoryLabelRead({ observation: { panelVisible: true, labels: ['dashboard All'] }, wanted: WANTED, attempt: 2, maxAttempts: 24, settledLabels: ['accessibility_new Characters'] }).action === 'RETRY');
check('CASE 5: a partial live-shaped render missing Videos still RETRYs',
  decideCategoryLabelRead({ observation: { panelVisible: true, labels: ['drive_folder_upload Uploads'] }, wanted: WANTED, attempt: 1, maxAttempts: 24, settledLabels: [] }).action === 'RETRY');
check('CASE 5: an absent panel still FAIL_CLOSEs immediately with no retry',
  decideCategoryLabelRead({ observation: { panelVisible: false, labels: LIVE }, wanted: WANTED, attempt: 1, maxAttempts: 24 }).action === 'FAIL_CLOSED');
check('CASE 5: the attempt cap still bounds RETRY',
  decideCategoryLabelRead({ observation: { panelVisible: true, labels: [] }, wanted: WANTED, attempt: 24, maxAttempts: 24 }).action === 'FAIL_CLOSED');
check('CASE 5: an empty label list is still NEVER accepted',
  (() => { for (let a = 1; a <= 24; a++) if (decideCategoryLabelRead({ observation: { panelVisible: true, labels: [] }, wanted: WANTED, attempt: a, maxAttempts: 24 }).action === 'ACCEPT') return false; return true; })());

// -- the decision function must reuse the CANONICAL normalizer, not a private copy
check('source: decideCategoryLabelRead normalises via the canonical normalizer',
  /decideCategoryLabelRead[\s\S]{0,3000}normalizeProjectAssetCategoryLabel\(input\?\.wanted\)/.test(code));
check('source: it does NOT use includes/startsWith/substring matching on labels',
  !/labels\.(?:includes|startsWith|endsWith)\(/.test(methodSeg('export function decideCategoryLabelRead', 3000)));
check('source: canonical normalizer is imported from the shared module (not redefined here)',
  /import \{[^}]*normalizeProjectAssetCategoryLabel[^}]*\} from '\.\/projectCategoryLabel\.js'/.test(code)
  && !/function normalizeProjectAssetCategoryLabel/.test(code));
check('source: the generator/acquisition readers are untouched by this fix (still exactly two consumers)',
  (code.match(/awaitCategoryLabels\(\{/g) ?? []).length === 2);

console.log(`\nALL PASS  (${passed} checks)`);
