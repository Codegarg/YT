/**
 * Shared, self-locating absolute paths for the offline production test suite.
 *
 * WHY THIS EXISTS
 * Every test used to hardcode the authoring machine's absolute paths, e.g. a
 * `<user>/Downloads/<old-folder>/youtube-automation/production/src` source root and a
 * WinGet `Gyan.FFmpeg...` package `bin` directory.
 * Both broke when the repository and the FFmpeg install moved, and neither was
 * discoverable from the code. This module derives every path from its OWN location
 * (`import.meta.url`), so the suite follows the repository wherever it lives.
 *
 * FF is resolved from FFMPEG_PATH when set, otherwise by scanning PATH, so the tests
 * do not depend on a particular WinGet package or build name.
 *
 * Paths are normalised to forward slashes so that `\`${SRC}/file.ts\`` concatenation
 * (used throughout the suite) keeps producing exactly the same string shape as before.
 *
 * This file is intentionally `.mjs`, not `.mts`: `npm test` discovers `tests/*.mts`,
 * so a helper here must not be picked up as a test file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toPosix = (p) => p.replace(/\\/g, '/');

/** <repo>/production/tests */
export const TESTS = toPosix(path.dirname(fileURLToPath(import.meta.url)));
/** <repo>/production */
export const PROD = toPosix(path.resolve(TESTS, '..'));
/** <repo> */
export const REPO = toPosix(path.resolve(PROD, '..'));
/** <repo>/production/src */
export const SRC = toPosix(path.join(PROD, 'src'));
/** <repo>/production/inputs */
export const INPUTS = toPosix(path.join(PROD, 'inputs'));
/** <repo>/production/outputs */
export const OUTPUTS = toPosix(path.join(PROD, 'outputs'));
/** <repo>/production/assets */
export const ASSETS = toPosix(path.join(PROD, 'assets'));

function findExeDir(exeNames) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of exeNames) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return path.dirname(candidate);
      } catch {
        // not here; keep looking
      }
    }
  }
  return '';
}

/**
 * Directory containing ffmpeg/ffprobe. Honours FFMPEG_PATH first, then PATH.
 * Empty string when neither resolves; `test_paths_resolution_test.mts` asserts this
 * never happens on a working machine, so the failure surfaces once, loudly.
 */
export const FF = (() => {
  const explicit = process.env.FFMPEG_PATH;
  if (explicit && fs.existsSync(explicit)) return toPosix(path.dirname(explicit));
  return toPosix(findExeDir(['ffmpeg.exe', 'ffmpeg']));
})();
