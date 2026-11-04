// Offline input-manifest + secure-path tests (STEP-8DE). Temp dirs only. No Flow/Chrome.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const im = await import(pathToFileURL(`${SRC}/inputManifest.ts`).href);
const {
  assertSafeProjectId, projectInputRoot, inputCategoryDir, inputManifestPath, resolveManifestAssetPath,
  validateManifest, loadManifest, discoverInputAssets, compareManifestToFilesystem, logicalAssetKey,
  INPUT_SCHEMA_VERSION, INPUT_CATEGORIES, computeFileSha256,
} = im;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8de-im-'));
const inputsRoot = tmp;
const PID = 'raat-ka-khauf-3am-kuan';

// ---- 1/2. project id safety ----
check('valid project id accepted', assertSafeProjectId(PID) === PID);
const badIds = ['../evil', '..\\evil', 'a/b', 'a\\b', 'C:\\abs', 'C:/abs', '//unc/share', '\\\\unc\\share', '', '   ', 'a\0b', 'x'.repeat(200), '.', '..', 'proj/../other'];
for (const b of badIds) {
  let threw = false;
  try { assertSafeProjectId(b); } catch { threw = true; }
  check(`malicious project id rejected: ${JSON.stringify(b.slice(0, 20))}`, threw);
}

// ---- 3. path helpers stay inside the root ----
check('project input root is a single deterministic path', projectInputRoot(PID, inputsRoot) === path.resolve(inputsRoot, PID));
check('category dirs are direct children', INPUT_CATEGORIES.every((c) => path.dirname(inputCategoryDir(PID, c, inputsRoot)) === path.resolve(inputsRoot, PID)));
check('manifest path is at the input root', path.dirname(inputManifestPath(PID, inputsRoot)) === path.resolve(inputsRoot, PID));
check('safe relative path resolves inside root', path.dirname(resolveManifestAssetPath('characters/CHAR-01-ARJUN.png', PID, inputsRoot)) === path.resolve(inputsRoot, PID, 'characters'));
const badRels = ['../../secret.png', '..\\..\\secret.png', 'C:\\secret.png', 'D:/secret.png', '/etc/passwd', '\\\\unc\\x', 'a/../../b', '\0x'];
for (const r of badRels) {
  let escaped = false;
  try { const p = resolveManifestAssetPath(r, PID, inputsRoot); escaped = !p.startsWith(path.resolve(inputsRoot, PID)); }
  catch { escaped = false; }
  check(`relative path traversal rejected: ${JSON.stringify(r.slice(0, 20))}`, !escaped);
}

// ---- 3/4/5. manifest structure ----
const dir = projectInputRoot(PID, inputsRoot);
fs.mkdirSync(inputCategoryDir(PID, 'characters', inputsRoot), { recursive: true });
const okManifest = { schema_version: 1, project_id: PID, assets: [
  { type: 'character', tag: '@CHAR-01-ARJUN', scene_number: null, relative_path: 'characters/CHAR-01-ARJUN.png', source: 'human-supplied', validation: 'VALID', sha256: null, width: 1024, height: 1024, durationSeconds: null, streams: null, updated_at: null },
]};
check('valid manifest accepted', validateManifest(okManifest, PID, inputsRoot).ok === true);
check('malformed manifest (not object) rejected', validateManifest('nope' as any, PID, inputsRoot).ok === false);
check('wrong schema_version rejected', validateManifest({ ...okManifest, schema_version: 2 }, PID, inputsRoot).ok === false);
check('wrong project_id rejected', validateManifest({ ...okManifest, project_id: 'other' }, PID, inputsRoot).ok === false);
check('unknown asset type rejected', validateManifest({ ...okManifest, assets: [{ ...okManifest.assets[0], type: 'bogus' }] }, PID, inputsRoot).ok === false);
check('unknown source rejected', validateManifest({ ...okManifest, assets: [{ ...okManifest.assets[0], source: 'magic' }] }, PID, inputsRoot).ok === false);
check('absolute relative_path rejected', validateManifest({ ...okManifest, assets: [{ ...okManifest.assets[0], relative_path: 'C:\\x.png' }] }, PID, inputsRoot).ok === false);
check('traversal relative_path rejected', validateManifest({ ...okManifest, assets: [{ ...okManifest.assets[0], relative_path: '../../x.png' }] }, PID, inputsRoot).ok === false);
check('flow-clip without scene_number rejected', validateManifest({ ...okManifest, assets: [{ type: 'flow-clip', tag: null, scene_number: null, relative_path: 'flow-clips/scene-0001.mp4', source: 'human-supplied', validation: 'VALID' }] }, PID, inputsRoot).ok === false);
check('harmless extra metadata tolerated', validateManifest({ ...okManifest, assets: [{ ...okManifest.assets[0], note: 'from AI Studio' }] }, PID, inputsRoot).ok === true);

// ---- 8/9. duplicates ----
check('duplicate logical character rejected', validateManifest({ ...okManifest, assets: [okManifest.assets[0], { ...okManifest.assets[0] }] }, PID, inputsRoot).ok === false);
check('duplicate scene narration rejected', validateManifest({ ...okManifest, assets: [
  { type: 'narration', tag: null, scene_number: 5, relative_path: 'narration/narration-0005.wav', source: 'human-supplied', validation: 'VALID' },
  { type: 'narration', tag: null, scene_number: 5, relative_path: 'narration/narration-0005.mp3', source: 'human-supplied', validation: 'VALID' },
] }, PID, inputsRoot).ok === false);

// ---- loadManifest: absent is not an error ----
check('absent manifest -> ok with null', (await loadManifest('no-such-project', inputsRoot)).ok === true);
fs.writeFileSync(inputManifestPath(PID, inputsRoot), '{ broken json');
check('malformed JSON manifest -> not ok', (await loadManifest(PID, inputsRoot)).ok === false);
fs.writeFileSync(inputManifestPath(PID, inputsRoot), JSON.stringify(okManifest));
check('well-formed manifest loads', (await loadManifest(PID, inputsRoot)).ok === true);

// ---- discovery ----
for (const c of INPUT_CATEGORIES) fs.mkdirSync(inputCategoryDir(PID, c, inputsRoot), { recursive: true });
fs.writeFileSync(path.join(inputCategoryDir(PID, 'characters', inputsRoot), 'CHAR-01-ARJUN.png'), Buffer.from('x'));
fs.writeFileSync(path.join(inputCategoryDir(PID, 'narration', inputsRoot), 'narration-0005.wav'), Buffer.from('x'));
fs.writeFileSync(path.join(inputCategoryDir(PID, 'flow-clips', inputsRoot), 'scene-0001.mp4'), Buffer.from('x'));
fs.writeFileSync(path.join(inputCategoryDir(PID, 'backgrounds', inputsRoot), 'BGD-01-VILLAGE-STREET-WIDE.png'), Buffer.from('x'));
fs.writeFileSync(path.join(inputCategoryDir(PID, 'music', inputsRoot), 'background-music.mp3'), Buffer.from('x'));
fs.writeFileSync(path.join(inputCategoryDir(PID, 'characters', inputsRoot), 'notes.txt'), Buffer.from('x'));
const disc = await discoverInputAssets(PID, inputsRoot);
check('discovery finds each category', disc.characters.length === 1 && disc.narration.length === 1 && disc.flowClips.length === 1 && disc.backgrounds.length === 1 && disc.music.length === 1);
check('discovery reports unexpected files (not silently consumed)', disc.unexpected.includes('characters/notes.txt'));
check('discovery for a missing project is empty but safe', (await discoverInputAssets('nope-project', inputsRoot)).rootExists === false);

// ---- manifest vs filesystem (filesystem wins) ----
const mism = await compareManifestToFilesystem({ schema_version: 1, project_id: PID, assets: [
  { ...okManifest.assets[0], sha256: 'deadbeef' },
  { type: 'narration', tag: null, scene_number: 9, relative_path: 'narration/narration-0009.wav', source: 'human-supplied', validation: 'VALID' } as any,
] }, disc, PID, inputsRoot);
check('manifest hash mismatch detected', mism.some((d) => d.issue === 'HASH_MISMATCH'));
check('manifest missing file detected', mism.some((d) => d.issue === 'MISSING_FILE'));
check('filesystem files absent from manifest reported', mism.some((d) => d.issue === 'NOT_IN_MANIFEST'));
check('logical key is deterministic', logicalAssetKey('character', '@CHAR-01-ARJUN', null) === logicalAssetKey('character', '@CHAR-01-ARJUN', null));

// ---- no writes / no network ----
const srcText = fs.readFileSync(`${SRC}/inputManifest.ts`, 'utf8');
check('inputManifest performs no network I/O', !/fetch\(|XMLHttpRequest|https?:\/\//.test(srcText));
check('inputManifest never writes files', !/writeFile|createWriteStream|rename\(|mkdir/.test(srcText));
check('inputManifest has no Flow/Chrome dependency', !/playwright|FlowClient|chrome/i.test(srcText));
check('schema version pinned to 1', INPUT_SCHEMA_VERSION === 1);

console.log(`\nINPUT-MANIFEST TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
