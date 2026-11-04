// Focused offline tests for the bounded Videos-picker hydration gate (Scene-4 regression).
// No browser, no Flow, no credits. Exercises the pure gate + the FlowClient poller/resolver.
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const { pickerSurfaceHydration, extractPreviewArtifactUuid, resolvePickerCandidateByPreviewUuid, decideFirstClipAttachment } =
  await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);
const { FlowClient } = await import(pathToFileURL(`${SRC}/flowClient.ts`).href);

let passed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed += 1; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
}

const TARGET = '32058b4f-4aeb-4694-a4bc-6c30f175c248';
const OTHER = 'c5f68b4c-8e59-4b05-a40e-e48c83d69fdf';
const url = (uuid: string) => `https://flow-content.google/video/${uuid}?Expires=1790868443&KeyName=labs-flow-prod-cdn-key&Signature=abc`;

// ------------------------------------------------------- pure hydration gate
check('gate: rows absent -> not ready (NO_ROWS)', pickerSurfaceHydration({ rowCount: 0, previewSrc: url(TARGET) }).ready === false);
check('gate: rows present but preview absent -> not ready (NO_PREVIEW)',
  (() => { const r: any = pickerSurfaceHydration({ rowCount: 1, previewSrc: null }); return r.ready === false && r.reason === 'NO_PREVIEW'; })());
check('gate: rows + valid preview -> ready with the exact preview UUID',
  (() => { const r: any = pickerSurfaceHydration({ rowCount: 1, previewSrc: url(TARGET) }); return r.ready === true && r.previewUuid === TARGET; })());
check('gate: opaque /asb/ thumbnail is NEVER accepted as identity',
  (() => { const r: any = pickerSurfaceHydration({ rowCount: 3, previewSrc: 'https://flow.google.com/asb/ANqvLOabc=s1600-rw' }); return r.ready === false && r.reason === 'NO_PREVIEW'; })());
check('gate: malformed/empty evidence -> not ready', pickerSurfaceHydration(null).ready === false && pickerSurfaceHydration(undefined).ready === false);

// Sequencing: rows absent initially, then appear.
{
  const seq = [{ rowCount: 0, previewSrc: null }, { rowCount: 0, previewSrc: null }, { rowCount: 1, previewSrc: url(TARGET) }];
  const ready = seq.map((e) => pickerSurfaceHydration(e).ready);
  check('sequence: rows appear later -> gate only opens once the row is present', JSON.stringify(ready) === JSON.stringify([false, false, true]), ready);
}
// Sequencing: rows present but preview absent initially, then preview appears.
{
  const seq = [{ rowCount: 1, previewSrc: null }, { rowCount: 1, previewSrc: '' }, { rowCount: 1, previewSrc: url(TARGET) }];
  const ready = seq.map((e) => pickerSurfaceHydration(e).ready);
  check('sequence: preview appears later -> gate only opens once the preview is present', JSON.stringify(ready) === JSON.stringify([false, false, true]), ready);
}

// ------------------------------------------------------- FlowClient poller
const makeHydrationClient = (evidenceSeq: Array<{ rowCount: number; previewSrc: string | null }>) => {
  let i = 0;
  const page: any = {
    evaluate: async (fn: any) => {
      const body = typeof fn === 'function' ? String(fn) : String(fn ?? '');
      if (body.includes('rowCount')) { const ev = evidenceSeq[Math.min(i, evidenceSeq.length - 1)]; i += 1; return ev; }
      return '';
    },
  };
  return new FlowClient(page, () => {});
};

{
  const c: any = makeHydrationClient([{ rowCount: 0, previewSrc: null }, { rowCount: 1, previewSrc: null }, { rowCount: 1, previewSrc: url(TARGET) }]);
  const r: any = await c.waitForPickerHydration(3000, 5);
  check('poller: polls until rows+preview hydrate, then resolves the preview UUID', r.ok === true && r.previewUuid === TARGET, r);
}
{
  const c: any = makeHydrationClient([{ rowCount: 0, previewSrc: null }]);
  const r: any = await c.waitForPickerHydration(80, 10);
  check('poller: zero rows after the bounded deadline -> fail closed', r.ok === false, r);
}
{
  const c: any = makeHydrationClient([{ rowCount: 1, previewSrc: 'https://flow.google.com/asb/ANqvLOabc=s1600-rw' }]);
  const r: any = await c.waitForPickerHydration(80, 10);
  check('poller: /asb/-only evidence after the bounded deadline -> fail closed', r.ok === false, r);
}
{
  const c: any = makeHydrationClient([{ rowCount: 1, previewSrc: url(OTHER) }, { rowCount: 1, previewSrc: url(OTHER) }]);
  const r: any = await c.waitForPickerHydration(60, 10);
  // Hydration succeeds (a valid preview exists) but it is NOT the target — identity is
  // rejected downstream; the poller itself must not confuse "hydrated" with "matched".
  check('poller: hydrated but non-target preview is still returned as hydrated (identity checked downstream)', r.ok === true && r.previewUuid === OTHER, r);
}

// ------------------------------------------------------- pure resolver + guards
check('resolver: exactly one matching row resolves to its index',
  (() => { const r: any = resolvePickerCandidateByPreviewUuid([url(OTHER), url(TARGET)], TARGET); return r.ok === true && r.rowIndex === 1; })());
check('resolver: preview UUID mismatch -> fail closed',
  (() => { const r: any = resolvePickerCandidateByPreviewUuid([url(OTHER)], TARGET); return r.ok === false && /no picker row/i.test(String(r.reason)); })());
check('resolver: multiple matching rows -> fail closed (never pick the first)',
  resolvePickerCandidateByPreviewUuid([url(TARGET), url(TARGET)], TARGET).ok === false);
check('resolver: opaque /asb/ URLs contribute no matches',
  resolvePickerCandidateByPreviewUuid(['https://flow.google.com/asb/ANqvLOabc=s1600-rw'], TARGET).ok === false);
check('extract: /asb/ URL yields no identity', extractPreviewArtifactUuid('https://flow.google.com/asb/ANqvLOabc') === null);

// ------------------------------------------------------- mutation guard end-to-end
const makeAttachClient = (previews: string[]) => {
  let addMediaClicks = 0; let rowClicks = 0; let previewIdx = 0;
  const page: any = {
    locator: (sel: string) => {
      const make = (id: string): any => ({
        first: () => make(id),
        filter: () => make(id),
        locator: (child?: string) => make(child ? `${id} ${child}` : id),
        waitFor: async () => {},
        isVisible: async () => true,
        getAttribute: async () => 'true',
        click: async () => {
          if (/asset-item\[role="option"\]/.test(id)) { rowClicks += 1; previewIdx = Math.min(previewIdx + 1, previews.length - 1); }
          else if (/detail-add-to-prompt-btn/.test(id)) { addMediaClicks += 1; }
        },
        count: async () => (/detail-add-to-prompt-btn/.test(id) ? 1 : previews.length),
        nth: () => make(id),
      });
      return make(sel);
    },
    evaluate: async (fn: any) => {
      const body = typeof fn === 'function' ? String(fn) : String(fn ?? '');
      const src = previews[Math.min(previewIdx, previews.length - 1)] ?? '';
      if (body.includes('rowCount')) return { rowCount: previews.length, previewSrc: src };
      return src;
    },
    keyboard: { press: async () => {} },
    url: () => 'https://flow.google.com/project/p/scene/s',
  };
  const client: any = new FlowClient(page, () => {});
  client.sceneHasClip = async () => false;
  client.waitForMediaPickerSurface = async () => page.locator('div.flow-media-picker-dialog-panel').first();
  client.waitForClipEvidence = async () => false;
  return { client, counts: () => ({ addMediaClicks, rowClicks }) };
};

{
  const { client, counts } = makeAttachClient([url(OTHER)]);
  let msg = ''; try { await client.attachGeneratedVideoToEmptyScene(TARGET); } catch (e: any) { msg = String(e.message); }
  check('mutation guard: preview mismatch -> NO Add media mutation', counts().addMediaClicks === 0, JSON.stringify(counts()));
  check('mutation guard: preview mismatch -> fail closed with a clear reason', /Empty-scene attach failed/.test(msg), msg);
}
{
  const { client, counts } = makeAttachClient([url(TARGET)]);
  const r: any = await client.attachGeneratedVideoToEmptyScene(TARGET);
  check('mutation guard: unique identity -> exactly ONE Add media mutation', counts().addMediaClicks === 1, JSON.stringify(counts()));
  check('mutation guard: unique identity -> attach succeeds (persistence delegated)', r && r.persistent === true && r.artifactId === TARGET, JSON.stringify(r));
}
check('decision: Add media still refuses unless preview === target',
  decideFirstClipAttachment({ previewArtifactId: url(TARGET), targetArtifactId: TARGET, addMediaPresent: true }).ok === false);

console.log(`\nPICKER HYDRATION TESTS PASSED (${passed} checks)`);
