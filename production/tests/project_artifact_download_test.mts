// Focused offline tests for project-artifact tile resolution + fail-closed download. No browser, no Flow.
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const { classifyProjectArtifactTiles, matchProjectArtifactTiles, chooseDownloadMenuItem, DOWNLOAD_MENU_ITEM_ORIGINAL } = await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);
const { FlowClient } = await import(pathToFileURL(`${SRC}/flowClient.ts`).href);

let passed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed += 1; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
}

const TITLE = 'Mother talking to son in bedroom…';

// ---- pure classifier ----
check('classify: 1 match -> UNIQUE', classifyProjectArtifactTiles(1) === 'UNIQUE_ARTIFACT_TILE');
check('classify: 0 match -> NO', classifyProjectArtifactTiles(0) === 'NO_ARTIFACT_TILE');
check('classify: 2 matches -> AMBIGUOUS', classifyProjectArtifactTiles(2) === 'AMBIGUOUS_ARTIFACT_TILES');
check('classify: negative/NaN/null -> NO (fail closed)', classifyProjectArtifactTiles(-1) === 'NO_ARTIFACT_TILE' && classifyProjectArtifactTiles(NaN) === 'NO_ARTIFACT_TILE' && classifyProjectArtifactTiles(null) === 'NO_ARTIFACT_TILE');

// ---- pure matcher ----
check('match: exact unique title resolves the single tile', (() => { const r = matchProjectArtifactTiles(['@CHAR-01-ARJUN', TITLE, '#BGD-01-X'], TITLE); return r.classification === 'UNIQUE_ARTIFACT_TILE' && r.matches.length === 1 && r.matches[0] === 1; })());
check('match: truncated visible title matches exactly', (() => { const r = matchProjectArtifactTiles([TITLE], TITLE); return r.classification === 'UNIQUE_ARTIFACT_TILE'; })());
check('match: zero matches fails closed', matchProjectArtifactTiles(['Other', 'Another'], TITLE).classification === 'NO_ARTIFACT_TILE');
check('match: multiple matches fails closed', matchProjectArtifactTiles([TITLE, TITLE], TITLE).classification === 'AMBIGUOUS_ARTIFACT_TILES');
check('match: unrelated titles never match', matchProjectArtifactTiles(['Mother speaking to son in bedroo…', 'Rain through window at night'], TITLE).classification === 'NO_ARTIFACT_TILE');
check('match: empty title fails closed', matchProjectArtifactTiles([TITLE], '').classification === 'NO_ARTIFACT_TILE');
check('match: non-array labels fails closed', matchProjectArtifactTiles(null, TITLE).classification === 'NO_ARTIFACT_TILE');
check('match: substring/fuzzy is never accepted', matchProjectArtifactTiles(['Mother talking to son in bedroom extended'], TITLE).classification === 'NO_ARTIFACT_TILE');
check('match: whitespace is trimmed for exact equality', matchProjectArtifactTiles([`  ${TITLE}  `], TITLE).classification === 'UNIQUE_ARTIFACT_TILE');

// ---- FlowClient fail-closed (no mutation before unique resolution) ----
const makeClient = (labels: Array<string | null>) => {
  let downloadClicks = 0;
  const tiles = labels.map((label) => ({
    isVisible: async () => label !== null,
    getAttribute: async () => label ?? '',
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    locator: () => ({ first: () => ({ count: async () => 1, click: async () => { downloadClicks += 1; } }) }),
  }));
  const page: any = {
    locator: () => ({ count: async () => labels.length, nth: (i: number) => tiles[i] }),
    once: () => {},
    keyboard: { press: async () => {} },
  };
  const client: any = new FlowClient(page, () => {});
  return { client, clicks: () => downloadClicks };
};

{
  const { client, clicks } = makeClient([TITLE, TITLE]);
  const r: any = await client.downloadProjectArtifact(TITLE, 'C:/tmp/out.mp4');
  check('fail-closed: two matching tiles -> refused', r.ok === false && /matching tile/.test(String(r.reason)), r);
  check('fail-closed: ambiguous resolution performs NO Download click', clicks() === 0);
}
{
  const { client, clicks } = makeClient(['Other tile']);
  const r: any = await client.downloadProjectArtifact(TITLE, 'C:/tmp/out.mp4');
  check('fail-closed: zero matching tiles -> refused', r.ok === false, r);
  check('fail-closed: zero matches performs NO Download click', clicks() === 0);
}
{
  const { client } = makeClient([TITLE]);
  const r: any = await client.downloadProjectArtifact('', 'C:/tmp/out.mp4');
  check('fail-closed: empty title -> refused', r.ok === false, r);
}

// ---- two-stage resolution chooser (stage 2) ----
const SUBMENU = ['270p Animated GIF', '720p Original size', '1080p Upscaled', '4K Upscaled'];
check('chooser: selects the ORIGINAL 720p item', (() => { const c = chooseDownloadMenuItem(SUBMENU); return c.kind === 'ok' && c.label === DOWNLOAD_MENU_ITEM_ORIGINAL; })());
check('chooser: never selects an upscaled option', (() => { const c = chooseDownloadMenuItem(['1080p Upscaled', '4K Upscaled']); return c.kind === 'none'; })());
check('chooser: never selects an animated GIF', chooseDownloadMenuItem(['270p Animated GIF']).kind === 'none');
check('chooser: falls back to an "Original size" variant', (() => { const c = chooseDownloadMenuItem(['720p Original size']); return c.kind === 'ok' && /original size/i.test(c.label); })());
check('chooser: unrelated labels -> none', chooseDownloadMenuItem(['Download', 'Rename']).kind === 'none');
check('chooser: non-array -> none', chooseDownloadMenuItem(null).kind === 'none');

// ---- download-event recovery (createReadStream first, saveAs fallback) ----
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

function makeDownloadPage(opts: { streamMode: 'ok' | 'null' | 'throw'; saveAs?: 'ok' | 'throw' | 'absent' }) {
  let downloadHandler: ((d: any) => void) | null = null;
  let resolutionClicks = 0;
  const fireDownload = () => {
    if (!downloadHandler) return;
    const fake: any = {
      suggestedFilename: () => 'scene-0004.mp4',
      createReadStream: async () => {
        if (opts.streamMode === 'throw') throw new Error('Target page, context or browser has been closed');
        if (opts.streamMode === 'null') return null;
        return {
          on(ev: string, cb: any) {
            if (ev === 'data') cb(Buffer.from('MP4BYTES'));
            else if (ev === 'end') setTimeout(() => cb(), 0);
            return this;
          },
        };
      },
    };
    if (opts.saveAs !== 'absent') fake.saveAs = async (p: string) => { if (opts.saveAs === 'throw') throw new Error('Target page, context or browser has been closed'); if (p) fs.writeFileSync(p, Buffer.from('SAVEASBYTES')); };
    downloadHandler(fake);
  };
  const node = (id: string): any => ({
    first: () => node(id), last: () => node(id), filter: () => node(id),
    locator: (child: string) => {
      const c = String(child);
      if (/More options/.test(c)) return node('kebab');
      if (/button, \[role="menuitem"\]/.test(c)) return node('resolution');
      return node('generic');
    },
    count: async () => 1, isVisible: async () => true,
    getAttribute: async () => (id === 'tile' ? TITLE : ''),
    click: async () => { if (id === 'resolution') { resolutionClicks += 1; fireDownload(); } },
    hover: async () => {}, scrollIntoViewIfNeeded: async () => {}, waitFor: async () => {},
    allInnerTexts: async () => ['270p Animated GIF', '720p Original size', '1080p Upscaled', '4K Upscaled'],
  });
  const page: any = {
    locator: (sel: string) => {
      if (sel === 'flow-grid-tile-container') return { count: async () => 1, nth: () => node('tile') };
      if (/submenu-trigger|aria-haspopup/.test(sel)) return node('trigger');
      if (/mat-mdc-menu-panel/.test(sel)) return node('panel');
      if (/button, \[role="menuitem"\]/.test(sel)) return node('resolution');
      if (/More options/.test(sel)) return node('kebab');
      return node('generic');
    },
    once: (ev: string, cb: any) => { if (ev === 'download') downloadHandler = cb; },
    keyboard: { press: async () => {} },
  };
  return { page, clicks: () => resolutionClicks };
}

{
  const out = path.join(os.tmpdir(), `pa-recovery-ok-${Date.now()}.mp4`);
  const { page, clicks } = makeDownloadPage({ streamMode: 'ok' });
  const client: any = new FlowClient(page, () => {});
  const r: any = await client.downloadProjectArtifact(TITLE, out, { timeoutMs: 5000 });
  check('recovery: createReadStream transport succeeds', r.ok === true && r.transport === 'createReadStream', r);
  check('recovery: createReadStream bytes were written', fs.existsSync(out) && fs.readFileSync(out).toString() === 'MP4BYTES');
  check('recovery: exactly ONE resolution click', clicks() === 1);
  fs.rmSync(out, { force: true });
}
{
  const out = path.join(os.tmpdir(), `pa-recovery-saveas-${Date.now()}.mp4`);
  const { page, clicks } = makeDownloadPage({ streamMode: 'throw', saveAs: 'ok' });
  const client: any = new FlowClient(page, () => {});
  const r: any = await client.downloadProjectArtifact(TITLE, out, { timeoutMs: 5000 });
  check('recovery: saveAs fallback succeeds when stream fails', r.ok === true && r.transport === 'saveAs', r);
  check('recovery: saveAs bytes were installed', fs.existsSync(out) && fs.readFileSync(out).toString() === 'SAVEASBYTES');
  check('recovery: exactly ONE resolution click on fallback', clicks() === 1);
  fs.rmSync(out, { force: true });
}
{
  const out = path.join(os.tmpdir(), `pa-recovery-fail-${Date.now()}.mp4`);
  const { page, clicks } = makeDownloadPage({ streamMode: 'throw', saveAs: 'absent' });
  const client: any = new FlowClient(page, () => {});
  const r: any = await client.downloadProjectArtifact(TITLE, out, { timeoutMs: 5000 });
  check('recovery: both transports failing -> fail closed', r.ok === false, r);
  check('recovery: no file left behind on failure', !fs.existsSync(out));
  check('recovery: exactly ONE resolution click before failure', clicks() === 1);
}

console.log(`\nPROJECT ARTIFACT DOWNLOAD TESTS PASSED (${passed} checks)`);
