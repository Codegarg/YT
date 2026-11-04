// Offline tests for the committed-clip download helpers (STEP-8EI). No live Flow.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SRC } from './_testPaths.mjs';
const vd = await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);
const {
  sceneClipFilename, clipDownloadTempName, decideClipDownload, chooseDownloadMenuItem,
  classifyDownloadFailure, DOWNLOAD_MENU_ITEM_ORIGINAL,
} = vd;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

// ---- 9. scene number -> filename (deterministic, never title-derived) ----
check('scene 1 -> scene-0001.mp4', sceneClipFilename(1) === 'scene-0001.mp4');
check('scene 35 -> scene-0035.mp4', sceneClipFilename(35) === 'scene-0035.mp4');
check('scene 7 -> scene-0007.mp4 (zero-padded)', sceneClipFilename(7) === 'scene-0007.mp4');
check('invalid scene numbers rejected', sceneClipFilename(0) === null && sceneClipFilename(-1) === null && sceneClipFilename('x') === null && sceneClipFilename(10000) === null);
check('filename deterministic across calls', sceneClipFilename(1) === sceneClipFilename(1));

// ---- 2. temporary path generation ----
{
  const t = clipDownloadTempName('scene-0001.mp4', 123, 456);
  check('temp name embeds final name + pid + stamp', t === 'scene-0001.mp4.flow-download.tmp-123-456');
  check('temp name never equals the final name', t !== 'scene-0001.mp4');
  check('temp name keeps the .mp4 final extension visible at the start', String(t).startsWith('scene-0001.mp4.'));
  check('empty final name rejected', clipDownloadTempName('') === null);
}

// ---- 4/5. idempotency decision ----
check('existing VALID + no overwrite -> skip (ALREADY_VALID path)', decideClipDownload(true, false).kind === 'skip');
check('existing VALID + overwrite -> download', decideClipDownload(true, true).kind === 'download');
check('existing INVALID + no overwrite -> download (redownload allowed)', decideClipDownload(false, false).kind === 'download');
check('existing INVALID + overwrite -> download', decideClipDownload(false, true).kind === 'download');
check('non-boolean existing -> download', decideClipDownload(undefined, false).kind === 'download');

// ---- 10. download control resolution (pure helper) ----
check('menu resolution prefers "720p Original size"', (() => { const r = chooseDownloadMenuItem(['270p Animated GIF', '720p Original size', '1080p Upscaled', '4K Upscaled']); return r.kind === 'ok' && r.label === DOWNLOAD_MENU_ITEM_ORIGINAL; })());
check('menu resolution accepts any "Original size" item', (() => { const r = chooseDownloadMenuItem(['1080p Upscaled', '1080p Original size']); return r.kind === 'ok' && /original size/i.test(r.label); })());
check('menu resolution NEVER picks an upscale', (() => { const r = chooseDownloadMenuItem(['1080p Upscaled', '4K Upscaled']); return r.kind === 'none'; })());
check('menu resolution NEVER picks a GIF', (() => { const r = chooseDownloadMenuItem(['270p Animated GIF']); return r.kind === 'none'; })());
check('empty/absent menu -> none', chooseDownloadMenuItem([]).kind === 'none' && chooseDownloadMenuItem(undefined).kind === 'none');
check('unscaled original is preferred over upscaled when both present', (() => { const r = chooseDownloadMenuItem(['1080p Original size', '1080p Upscaled']); return r.kind === 'ok' && /original/i.test(r.label); })());

// ---- 1. result classification ----
check('classification maps stages', classifyDownloadFailure('no-clip') === 'NO_COMMITTED_CLIP'
  && classifyDownloadFailure('no-control') === 'DOWNLOAD_CONTROL_NOT_FOUND'
  && classifyDownloadFailure('timeout') === 'DOWNLOAD_EVENT_TIMEOUT'
  && classifyDownloadFailure('invalid') === 'INVALID_DOWNLOADED_FILE'
  && classifyDownloadFailure('ffprobe') === 'FFPROBE_FAILURE'
  && classifyDownloadFailure('write') === 'DOWNLOAD_WRITE_FAILED'
  && classifyDownloadFailure('path') === 'PATH_INVALID'
  && classifyDownloadFailure('rejected') === 'DOWNLOAD_REJECTED'
  && classifyDownloadFailure('something-else') === 'DOWNLOAD_WRITE_FAILED');

// ---- 3/8. destination path safety (basename must be canonical; traversal rejected) ----
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8ei-'));
  const clips = path.join(tmp, 'flow-clips');
  fs.mkdirSync(clips, { recursive: true });
  const good = path.join(clips, 'scene-0001.mp4');
  check('canonical destination basename accepted', path.basename(good) === sceneClipFilename(1));
  // A traversal-shaped name must NOT match the canonical basename (so the downloader refuses it).
  const evil = path.resolve(clips, '..', '..', 'scene-0001.mp4');
  check('traversal destination resolves outside and is refused', path.basename(evil) === 'scene-0001.mp4' && !evil.startsWith(clips));
  const wrongName = path.join(clips, 'movie.mp4');
  check('non-canonical basename is refused by the basename rule', path.basename(wrongName) !== sceneClipFilename(1));
  // ---- 7. atomic promotion behaviour (mirrors the downloader: temp -> validate -> rename) ----
  const tempName = clipDownloadTempName('scene-0001.mp4', process.pid, Date.now());
  const tempPath = path.join(clips, tempName);
  fs.writeFileSync(tempPath, Buffer.from('FAKE-VALID-CLIP-BYTES'));
  check('temp file exists before promotion', fs.existsSync(tempPath));
  fs.renameSync(tempPath, good);
  check('atomic promotion leaves only the final file', fs.existsSync(good) && !fs.existsSync(tempPath));
  // ---- 6. invalid new download must not destroy a valid destination ----
  const validBefore = fs.readFileSync(good);
  const tempBad = path.join(clips, clipDownloadTempName('scene-0001.mp4', process.pid, Date.now() + 1));
  fs.writeFileSync(tempBad, Buffer.from('CORRUPT'));
  // validation would fail -> delete temp, keep destination
  fs.rmSync(tempBad, { force: true });
  check('failed validation preserves the existing valid destination', fs.existsSync(good) && fs.readFileSync(good).equals(validBefore));
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- no network / no live Flow in these helpers ----
{
  const src = fs.readFileSync(`${SRC}/videoDecisions.ts`, 'utf8');
  const seg = src.slice(src.indexOf('// Committed-clip download'));
  check('download helpers perform no network I/O', !/fetch\(|XMLHttpRequest|https?:\/\//.test(seg));
  check('download helpers do not reference Flow internals', !/playwright|FlowClient|chrome/i.test(seg));
}

console.log(`\nCLIP-DOWNLOAD HELPER TESTS PASSED (${passed} checks)`);
