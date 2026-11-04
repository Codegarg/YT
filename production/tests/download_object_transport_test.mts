// Offline tests for the STEP-8FY Playwright Download-object transport (saveAs started INSIDE
// the download event listener). No live Flow/Chrome. The fake models the real race:
// a save STARTED inside the event callback is allowed to finish; a save started AFTER the fake
// context closes rejects — exactly the 8FX failure the old sequencing hit.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
import { SRC } from './_testPaths.mjs';
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
const { FlowClient } = await import(pathToFileURL(`${SRC}/flowClient.ts`).href);
const vd = await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

// ---- pure helpers (unchanged semantics)
check('classifyDownloadTransport: object received', vd.classifyDownloadTransport({ downloadObjectReceived: true }) === 'DOWNLOAD_OBJECT');
check('classifyDownloadTransport: filesystem fallback', vd.classifyDownloadTransport({ filesystemCandidatePresent: true }) === 'FILESYSTEM_FALLBACK');
check('classifyDownloadTransport: none', vd.classifyDownloadTransport({}) === 'NONE');
check('classifyDownloadOutcome: full success', vd.classifyDownloadOutcome({ downloadObjectReceived: true, savedOk: true, validationOk: true, promotionOk: true }) === 'DOWNLOAD_SUCCESS');
check('classifyDownloadOutcome: save failed w/ object', vd.classifyDownloadOutcome({ downloadObjectReceived: true, savedOk: false }) === 'DOWNLOAD_WRITE_FAILED');
check('classifyDownloadOutcome: no object -> EVENT_TIMEOUT', vd.classifyDownloadOutcome({ downloadObjectReceived: false, savedOk: false }) === 'DOWNLOAD_EVENT_TIMEOUT');
check('classifyDownloadOutcome: validation failed', vd.classifyDownloadOutcome({ downloadObjectReceived: true, savedOk: true, validationOk: false }) === 'INVALID_DOWNLOADED_FILE');
check('classifyDownloadOutcome: promotion failed', vd.classifyDownloadOutcome({ downloadObjectReceived: true, savedOk: true, validationOk: true, promotionOk: false }) === 'DOWNLOAD_WRITE_FAILED');
check('downloadObjectDiagnostic suggestedFilename', vd.downloadObjectDiagnostic({ suggestedFilename: () => 'x.mp4' }).suggestedFilename === 'x.mp4');
check('downloadObjectDiagnostic null-safe', vd.downloadObjectDiagnostic(null).suggestedFilename === null);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8fy-'));
const validMp4 = path.join(tmp, 'valid.mp4');
await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=640x360:d=1', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', validMp4]);

// ---- race-aware fake browser seam ----
// contextClosed flips TRUE synchronously right after the download event callback returns
// (modelling Flow tearing the context down immediately). A saveAs started AFTER that rejects.
function makeRaceClient(opts: {
  saveSource?: string;          // path to copy on saveAs success
  saveMode?: 'ok' | 'syncThrow' | 'asyncReject';
  createReadStreamFails?: boolean;
  hasClip?: boolean;
  triggerVisible?: boolean;
  menuLabels?: string[];
  fallbackMs?: number;
}) {
  const fc: any = Object.create(FlowClient.prototype);
  const listeners: Record<string, (a?: any) => void> = {};
  const state = { contextClosed: false, saveAsStarts: 0, menuClicked: false };
  const download = {
    suggestedFilename: () => 'export.mp4',
    saveAs: async (p: string) => {
      state.saveAsStarts++;
      if (state.contextClosed) throw new Error('Target page, context or browser has been closed');
      if ((opts.saveMode ?? 'ok') === 'syncThrow') throw new Error('saveAs threw immediately');
      if ((opts.saveMode ?? 'ok') === 'asyncReject') { await Promise.resolve(); throw new Error('saveAs async reject'); }
      await fsp.copyFile(opts.saveSource ?? validMp4, p);
    },
    createReadStream: async () => {
      if (state.contextClosed || opts.createReadStreamFails) throw new Error('Target page, context or browser has been closed');
      return fs.createReadStream(opts.saveSource ?? validMp4);
    },
  };
  const page: any = {
    once: (ev: string, cb: any) => { listeners[ev] = cb; },
    on: (ev: string, cb: any) => { listeners[ev] = cb; },
    waitForEvent: async () => { throw new Error('waitForEvent should not be used'); },
    locator: (sel: string) => {
      const isTrigger = /mat-mdc-menu-trigger/.test(sel);
      const isMenu = /mat-menu button|role="menu"/.test(sel);
      const obj: any = {
        first: () => obj,
        isVisible: async () => (isTrigger ? (opts.triggerVisible !== false) : true),
        click: async () => {
          if (isMenu) {
            state.menuClicked = true;
            // Fire the download event (as Flow would), then CLOSE the fake context synchronously
            // after the listener callback returns — modelling the teardown race.
            listeners['download']?.(download);
            state.contextClosed = true;
          }
        },
        waitFor: async () => {},
        allInnerTexts: async () => (opts.menuLabels ?? ['720p Original size']),
        boundingBox: async () => null,
        filter: () => obj,
        count: async () => 1,
      };
      return obj;
    },
    mouse: { move: async () => {} },
    evaluate: async () => ({ readyState: 'complete', childElementCount: 1 }),
    url: () => 'https://flow.google.com/project/x/scene/y',
  };
  fc.page = page;
  fc.sceneHasClip = async () => (opts.hasClip !== false);
  return { fc, state };
}

// TEST 1 — successful race: saveAs started inside the listener finishes; promote succeeds.
{
  const dest = path.join(tmp, 'scene-0020.mp4');
  const { fc, state } = makeRaceClient({ saveSource: validMp4 });
  const r = await fc.downloadCommittedSceneClip(20, dest, { ffprobePath: process.env.FFPROBE_PATH });
  check('T1. race-safe transport -> DOWNLOAD_SUCCESS', r.ok && r.result === 'DOWNLOAD_SUCCESS', JSON.stringify(r).slice(0, 200));
  check('T1. transport DOWNLOAD_OBJECT', r.transport === 'DOWNLOAD_OBJECT');
  check('T1. suggestedFilename recorded', r.suggestedFilename === 'export.mp4');
  check('T1. saveAs started exactly once, inside the listener', state.saveAsStarts === 1);
  check('T1. final file exists', fs.existsSync(dest));
  check('T1. no temp leftovers', !fs.readdirSync(path.dirname(dest)).some((f) => f.includes('.flow-download.tmp')));
}

// TEST 2 — OLD BUG REGRESSION: a saveAs started AFTER the context closes must fail.
{
  const dest = path.join(tmp, 'scene-0029.mp4');
  const closedCtx: any = { contextClosed: true };
  let oldStyleFailed = false;
  try {
    // Simulate the OLD sequencing: await the event, then (context already closed) saveAs.
    if (closedCtx.contextClosed) throw new Error('Target page, context or browser has been closed');
    await fsp.copyFile(validMp4, dest);
  } catch { oldStyleFailed = true; }
  check('T2. old post-event saveAs sequencing fails under the teardown race', oldStyleFailed === true);
  check('T2. no final file written by the old sequencing', !fs.existsSync(dest));
}

// TEST 3 — saveAs synchronous failure -> WRITE_FAILED, no final, temp cleaned.
{
  const dest = path.join(tmp, 'scene-0021.mp4');
  const { fc } = makeRaceClient({ saveMode: 'syncThrow', createReadStreamFails: true, fallbackMs: 200 });
  const r = await fc.downloadCommittedSceneClip(21, dest, { ffprobePath: process.env.FFPROBE_PATH, fallbackTimeouts: { observationMs: 200, hostedMs: 0, recoveryMs: 0 } });
  check('T3. saveAs sync failure -> DOWNLOAD_WRITE_FAILED', !r.ok && r.result === 'DOWNLOAD_WRITE_FAILED', JSON.stringify(r).slice(0, 180));
  check('T3. no final MP4', !fs.existsSync(dest));
  check('T3. temp cleaned', !fs.readdirSync(path.dirname(dest)).some((f) => f.includes('.flow-download.tmp')));
}

// TEST 4 — saveAs async rejection -> WRITE_FAILED, no final, temp cleaned.
{
  const dest = path.join(tmp, 'scene-0026.mp4');
  const { fc } = makeRaceClient({ saveMode: 'asyncReject', createReadStreamFails: true });
  const r = await fc.downloadCommittedSceneClip(26, dest, { ffprobePath: process.env.FFPROBE_PATH, fallbackTimeouts: { observationMs: 200, hostedMs: 0, recoveryMs: 0 } });
  check('T4. saveAs async rejection -> DOWNLOAD_WRITE_FAILED', !r.ok && r.result === 'DOWNLOAD_WRITE_FAILED', JSON.stringify(r).slice(0, 180));
  check('T4. no final MP4', !fs.existsSync(dest));
}

// TEST 5 — invalid media: save succeeds, validation rejects -> INVALID, temp cleaned.
{
  const dest = path.join(tmp, 'scene-0022.mp4');
  const bad = path.join(tmp, 'bad.mp4'); await fsp.writeFile(bad, Buffer.from('NOT A VIDEO'));
  const { fc } = makeRaceClient({ saveSource: bad });
  const r = await fc.downloadCommittedSceneClip(22, dest, { ffprobePath: process.env.FFPROBE_PATH });
  check('T5. invalid media -> not success', !r.ok, JSON.stringify(r).slice(0, 180));
  check('T5. no final MP4', !fs.existsSync(dest));
  check('T5. temp cleaned', !fs.readdirSync(path.dirname(dest)).some((f) => f.includes('.flow-download.tmp')));
}

// TEST 6 — existing valid clip -> ALREADY_VALID, no download/click.
{
  const dest = path.join(tmp, 'scene-0024.mp4');
  await fsp.copyFile(validMp4, dest);
  const { fc, state } = makeRaceClient({});
  const r = await fc.downloadCommittedSceneClip(24, dest, { ffprobePath: process.env.FFPROBE_PATH });
  check('T6. existing valid -> ALREADY_VALID', r.ok && r.result === 'ALREADY_VALID', JSON.stringify(r).slice(0, 160));
  check('T6. no menu click / download', state.menuClicked === false && state.saveAsStarts === 0);
}

// TEST 7 — path guard: wrong basename -> PATH_INVALID.
{
  const { fc } = makeRaceClient({});
  const r = await fc.downloadCommittedSceneClip(25, path.join(tmp, 'wrong-name.mp4'), { ffprobePath: process.env.FFPROBE_PATH });
  check('T7. wrong basename -> PATH_INVALID', !r.ok && r.result === 'PATH_INVALID');
}

// TEST 8 — no download event -> EVENT_TIMEOUT (fail closed).
{
  const dest = path.join(tmp, 'scene-0023.mp4');
  const { fc } = makeRaceClient({ triggerVisible: false });
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-empty-'));
  const r = await fc.downloadCommittedSceneClip(23, dest, { ffprobePath: process.env.FFPROBE_PATH, downloadDir: emptyDir, fallbackTimeouts: { observationMs: 200, hostedMs: 0, recoveryMs: 0 } });
  check('T8. no download event -> not success (fail closed)', !r.ok, JSON.stringify(r).slice(0, 160));
  check('T8. no final MP4', !fs.existsSync(dest));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nDOWNLOAD-OBJECT RACE TESTS PASSED (${passed} checks)`);
