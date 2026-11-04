// Focused offline test: TITLE branding path consistency (no Chrome, no Flow, no network).
//
// Proves the SINGLE canonical branding contract:
//   · validateBrandingInputs()/projectHealth read <inputsDir>/branding/{channel-intro.mp4,channel-logo.png}
//   · stageArgsFor('TITLE') must resolve --intro/--logo to exactly those same files
//   · an explicit titleAssets override still wins
//   · addTitle.ts must never be able to silently source a second, competing assets/ directory
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { REPO } from './_testPaths.mjs';
const SRC = `${REPO}/production/src`;

const se = await import(pathToFileURL(`${SRC}/stageExecutor.ts`).href);
const iv = await import(pathToFileURL(`${SRC}/inputValidator.ts`).href);
const { stageArgsFor } = se;
const { validateBrandingInputs } = iv;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brandpath-'));
const inputRoot = path.join(tmp, 'inputs', 'brandpath-fixture');
const outputsDir = path.join(tmp, 'outputs', 'brandpath-fixture');
fs.mkdirSync(path.join(inputRoot, 'branding'), { recursive: true });
fs.mkdirSync(outputsDir, { recursive: true });

const EXPECT_INTRO = path.join(inputRoot, 'branding', 'channel-intro.mp4');
const EXPECT_LOGO = path.join(inputRoot, 'branding', 'channel-logo.png');

// ---- 1. TITLE resolves branding from the canonical input-root location ----
{
  const cfg = { outputsDir, inputsDir: inputRoot, productionDir: path.join(tmp, 'prod') };
  const args = stageArgsFor('TITLE', cfg, path.join(tmp, 'out.mp4'));
  const intro = args[args.indexOf('--intro') + 1];
  const logo = args[args.indexOf('--logo') + 1];
  check('1a TITLE always emits --intro', args.includes('--intro'));
  check('1b TITLE always emits --logo', args.includes('--logo'));
  check('1c TITLE --intro resolves to <inputsDir>/branding/channel-intro.mp4', intro === EXPECT_INTRO, { intro, EXPECT_INTRO });
  check('1d TITLE --logo resolves to <inputsDir>/branding/channel-logo.png', logo === EXPECT_LOGO, { logo, EXPECT_LOGO });
}

// ---- 2. An explicit override still wins (established legacy contract) ----
{
  const cfg = {
    outputsDir, inputsDir: inputRoot, productionDir: path.join(tmp, 'prod'),
    titleAssets: { intro: path.join(tmp, 'custom-intro.mp4'), logo: path.join(tmp, 'custom-logo.png'), title: 'CUSTOM META' },
  };
  const args = stageArgsFor('TITLE', cfg, path.join(tmp, 'out.mp4'));
  check('2a explicit titleAssets.intro wins', args[args.indexOf('--intro') + 1] === cfg.titleAssets.intro);
  check('2b explicit titleAssets.logo wins', args[args.indexOf('--logo') + 1] === cfg.titleAssets.logo);
  check('2c explicit title metadata preserved', args[args.indexOf('--title') + 1] === 'CUSTOM META');
}

// ---- 3. No silent second branding source / no assets/ fallback reachable ----
{
  const src = fs.readFileSync(`${SRC}/stageExecutor.ts`, 'utf8');
  const titleCase = src.slice(src.indexOf("case 'TITLE'"), src.indexOf('case', src.indexOf("case 'TITLE'") + 5));
  check('3a TITLE case never references a bare assets/ directory', !/['"]assets\//.test(titleCase), titleCase);
  check('3b TITLE case resolves branding only via inputsDir/branding', /branding/.test(titleCase) && /channel-intro\.mp4/.test(titleCase) && /channel-logo\.png/.test(titleCase));

  const addTitle = fs.readFileSync(`${SRC}/addTitle.ts`, 'utf8');
  check('3c addTitle.ts fail-closes on missing branding (fs.access on both)', /fs\.access\(intro\)/.test(addTitle) && /fs\.access\(logo\)/.test(addTitle));
  check('3d addTitle.ts still requires explicit branding or its legacy default; stageExecutor always passes explicit args',
    /arg\('--intro'\)/.test(addTitle) && /arg\('--logo'\)/.test(addTitle));
}

// ---- 4. The validator and TITLE agree on the SAME two files (contract agreement) ----
{
  const res = await validateBrandingInputs({ projectId: 'brandpath-fixture', inputRoot, requiredBackgrounds: [], requiredCharacters: [], narrationScenes: [], sceneNumbers: [], requiredClips: [] } as any);
  const byId = new Map(res.map((r: any) => [r.id, r.relativePath]));
  check('4a validator expects branding/channel-intro.mp4', byId.get('channel-intro') === 'branding/channel-intro.mp4', [...byId.entries()]);
  check('4b validator expects branding/channel-logo.png', byId.get('channel-logo') === 'branding/channel-logo.png', [...byId.entries()]);
  const cfg = { outputsDir, inputsDir: inputRoot, productionDir: path.join(tmp, 'prod') };
  const args = stageArgsFor('TITLE', cfg, path.join(tmp, 'out.mp4'));
  check('4c TITLE --intro is exactly the validator path', path.join(inputRoot, String(byId.get('channel-intro'))) === args[args.indexOf('--intro') + 1]);
  check('4d TITLE --logo is exactly the validator path', path.join(inputRoot, String(byId.get('channel-logo'))) === args[args.indexOf('--logo') + 1]);
  // Absent branding must be reported MISSING (fail closed), never VALID via another path.
  check('4e absent branding reports MISSING for both assets', res.every((r: any) => r.state === 'MISSING'), res);
}

// ---- 5. BED keeps its own input-root music default (unchanged by this fix) ----
{
  const cfg = { outputsDir, inputsDir: inputRoot, productionDir: path.join(tmp, 'prod') };
  const bed = stageArgsFor('BED', cfg, path.join(tmp, 'out.mp4'));
  check('5a BED still defaults --bgm to <inputsDir>/music/background-music.mp3',
    bed[bed.indexOf('--bgm') + 1] === path.join(inputRoot, 'music', 'background-music.mp3'), bed);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} branding path consistency checks passed.`);