// Focused regression tests for the shared test-path helper (production/tests/_testPaths.mjs).
//
// Guards the repair of the hardcoded absolute paths that the suite used to carry from a
// previous Windows installation. Reads files only: never writes to production/inputs,
// production/outputs, or any project artifact. No Flow, no Chrome, no network, no credits.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TESTS, PROD, REPO, SRC, INPUTS, OUTPUTS, ASSETS, FF } from './_testPaths.mjs';

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const THIS_FILE = fileURLToPath(import.meta.url);
const THIS_DIR = path.dirname(THIS_FILE);
const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
const isFile = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// ---------------------------------------------------------------------------
// 1. The helper locates itself, not a hardcoded machine layout.
// ---------------------------------------------------------------------------
check('TESTS resolves to the directory that holds this test file', norm(TESTS) === norm(THIS_DIR), `${TESTS} vs ${THIS_DIR}`);
check('TESTS is the repo\'s production/tests directory', path.basename(TESTS) === 'tests' && path.basename(path.dirname(TESTS)) === 'production', TESTS);
check('PROD is the parent of TESTS', norm(PROD) === norm(path.dirname(TESTS)), PROD);
check('REPO is the parent of PROD', norm(REPO) === norm(path.dirname(PROD)), REPO);
check('SRC is PROD/src', norm(SRC) === norm(path.join(PROD, 'src')), SRC);
check('INPUTS is PROD/inputs', norm(INPUTS) === norm(path.join(PROD, 'inputs')), INPUTS);
check('OUTPUTS is PROD/outputs', norm(OUTPUTS) === norm(path.join(PROD, 'outputs')), OUTPUTS);
check('ASSETS is PROD/assets', norm(ASSETS) === norm(path.join(PROD, 'assets')), ASSETS);

check('PROD is a real directory', isDir(PROD), PROD);
check('PROD holds the production package.json', isFile(path.join(PROD, 'package.json')));
check('REPO holds the repo AGENTS.md', isFile(path.join(REPO, 'AGENTS.md')));
check('REPO holds production/ and scripting/', isDir(path.join(REPO, 'production')) && isDir(path.join(REPO, 'scripting')));
check('SRC is a real directory', isDir(SRC), SRC);
check('SRC contains the modules the suite imports', ['videoClip.ts', 'projectEntry.ts', 'productionOrchestrator.ts', 'isolatedSceneMix.ts'].every((f) => isFile(path.join(SRC, f))));
check('helper paths use forward slashes (same string shape as the old literals)', [TESTS, PROD, REPO, SRC, FF].every((p) => !p.includes('\\')), JSON.stringify({ TESTS, PROD, REPO, SRC, FF }));

// ---------------------------------------------------------------------------
// 2. FFmpeg resolves without pinning a WinGet package/build name.
// ---------------------------------------------------------------------------
check('FF resolved to a non-empty directory', typeof FF === 'string' && FF.length > 0, JSON.stringify(FF));
check('FF contains ffmpeg.exe', isFile(path.join(FF, 'ffmpeg.exe')), FF);
check('FF contains ffprobe.exe', isFile(path.join(FF, 'ffprobe.exe')), FF);
check('FF is a directory', isDir(FF), FF);

// ---------------------------------------------------------------------------
// 3. No test file carries the stale absolute paths again.
//    Markers are assembled at runtime so this file never contains them verbatim.
// ---------------------------------------------------------------------------
const FORBIDDEN = [
  ['Downloads', 'YT Automation'].join('/'),
  ['Gyan.FFmpeg', 'Microsoft'].join('_'),
  ['RIDHAM', '1'].join('~'),
  ['Program Files', 'Python311'].join('/'),
  ['Program Files', 'Python311'].join('\\'),
  ['Downloads', 'YT Automation'].join('\\'),
];

const testFiles = fs.readdirSync(TESTS).filter((f) => f.endsWith('.mts')).sort();
const otherTestFiles = testFiles.filter((f) => path.resolve(TESTS, f) !== path.resolve(THIS_FILE));
check('the suite still has at least its 96 migrated test files (plus this one)', otherTestFiles.length >= 96, String(otherTestFiles.length));
check('the helper is .mjs so `tests/*.mts` never runs it as a test', !testFiles.includes('_testPaths.mjs') && isFile(path.join(TESTS, '_testPaths.mjs')));

const offenders: string[] = [];
for (const file of testFiles) {
  if (path.resolve(TESTS, file) === path.resolve(THIS_FILE)) continue;
  const text = fs.readFileSync(path.join(TESTS, file), 'utf8');
  for (const marker of FORBIDDEN) {
    if (text.includes(marker)) offenders.push(`${file}: ${marker}`);
  }
}
check('no test file contains a stale absolute path from the previous install', offenders.length === 0, offenders.slice(0, 10));

// No hardcoded user-profile directory either (C:/Users/... or C:\Users\...).
const profileOffenders = testFiles
  .filter((f) => path.resolve(TESTS, f) !== path.resolve(THIS_FILE))
  .filter((f) => /[A-Za-z]:[\\/]Users[\\/]/i.test(fs.readFileSync(path.join(TESTS, f), 'utf8')));
check('no test file hardcodes a C:/Users profile path', profileOffenders.length === 0, profileOffenders);

// ---------------------------------------------------------------------------
// 4. Every path name a test relies on is actually provided (imported or declared).
// ---------------------------------------------------------------------------
const HELPER_IMPORT = /import\s*\{([^}]*)\}\s*from\s*'\.\/_testPaths\.mjs'/g;
const NAMES = ['SRC', 'REPO', 'ROOT', 'FF'];

const unresolved: string[] = [];
for (const file of testFiles) {
  if (path.resolve(TESTS, file) === path.resolve(THIS_FILE)) continue;
  const text = fs.readFileSync(path.join(TESTS, file), 'utf8');
  const codeOnly = text
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .filter((l) => !/^\s*import\b/.test(l))
    .join('\n');

  const provided = new Set<string>();
  for (const m of text.matchAll(HELPER_IMPORT)) {
    for (const part of m[1].split(',')) {
      const nm = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (nm) provided.add(nm);
    }
  }

  for (const name of NAMES) {
    const used = new RegExp(`(?<![\\w.$])${name}(?![\\w$])`).test(codeOnly);
    if (!used) continue;
    const declared = new RegExp(`(?:const|let|var)\\s+${name}\\s*=`).test(codeOnly);
    if (!provided.has(name) && !declared) unresolved.push(`${file}: ${name}`);
  }
}
check('every test that uses SRC/REPO/ROOT/FF resolves it from the helper or declares it', unresolved.length === 0, unresolved.slice(0, 10));

// Files that do import the helper must reference a specifier that exists.
const badSpecifier = testFiles.filter((f) => {
  const text = fs.readFileSync(path.join(TESTS, f), 'utf8');
  return /from\s*'\.\/_testPaths\.mjs'/.test(text) && !isFile(path.join(TESTS, '_testPaths.mjs'));
});
check('helper import specifier points at a real file', badSpecifier.length === 0, badSpecifier);

console.log(`\ntest path resolution: ${passed} checks passed`);
