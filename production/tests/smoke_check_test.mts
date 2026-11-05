// Focused regression tests for the offline smoke test (`production/src/smoke.ts`).
//
// These exercise the PURE helpers plus a few read-only assertions about the committed
// repository, so `npm run smoke` itself never has to be trusted blindly. Nothing here spawns
// Flow, Chrome, a model provider, ffmpeg or Python; nothing writes inside the repository.
// Everything is read from the checkout, so a fresh clone behaves the same as the original.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DOCUMENTED_ENV_TEMPLATE_KEYS,
  MIN_NODE_MAJOR,
  REQUIRED_ENV_TEMPLATE_KEYS,
  REQUIRED_PROVIDER_KEYS,
  documentedEnvKeys,
  meetsMinimum,
  parseEnvText,
  parseVersion,
  populatedKeys,
  renderSmokeReport,
  runSmoke,
  runtimeLayout,
  summarizeResults,
  tail,
  type SmokeResult,
} from '../src/smoke.js';
import { validateYouTubeAccountAllowlist } from '../src/youtubeAccountAllowlist.js';
import { renderUsage } from '../src/video.js';

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const PROD = path.resolve(TESTS, '..');
const REPO = path.resolve(PROD, '..');
const readText = (p: string) => fs.readFileSync(p, 'utf8');

// ---------------------------------------------------------------------------
// 1. Version parsing and minimum comparison (Node / Python reporting).
// ---------------------------------------------------------------------------
check('parseVersion reads a leading v', (() => { const v = parseVersion('v24.20.0'); return v!.major === 24 && v!.minor === 20 && v!.patch === 0; })());
check('parseVersion reads "Python 3.11.9"', (() => { const v = parseVersion('Python 3.11.9'); return v!.major === 3 && v!.minor === 11 && v!.patch === 9; })());
check('parseVersion tolerates a missing patch', (() => { const v = parseVersion('20.1'); return v!.major === 20 && v!.minor === 1 && v!.patch === 0; })());
check('parseVersion rejects text without a version', parseVersion('no-version-here') === null);
check('parseVersion takes the first triplet only', (() => { const v = parseVersion('ffmpeg version 9.0.2-full_build'); return v!.major === 9 && v!.minor === 0 && v!.patch === 2; })());

check('meetsMinimum accepts a newer major', meetsMinimum({ major: MIN_NODE_MAJOR + 1, minor: 0 }, { major: MIN_NODE_MAJOR, minor: 0 }));
check('meetsMinimum accepts an equal version', meetsMinimum({ major: 20, minor: 0 }, { major: 20, minor: 0 }));
check('meetsMinimum rejects an older minor', !meetsMinimum({ major: 20, minor: 1 }, { major: 20, minor: 11 }));
check('meetsMinimum rejects an older major', !meetsMinimum({ major: 19, minor: 99 }, { major: 20, minor: 0 }));

// ---------------------------------------------------------------------------
// 2. Runtime layout is derived, never hardcoded, and creates nothing to describe.
// ---------------------------------------------------------------------------
const layout = runtimeLayout(path.join('C:', 'tmp', 'repo'));
check('runtimeLayout names the four documented directories', ['projects', 'inputs', 'outputs', 'logs'].every((name) => path.basename((layout as any)[name]) === name), layout);
check('runtimeLayout keeps every directory under the given root', Object.values(layout).every((p) => path.dirname(p) === path.join('C:', 'tmp', 'repo')), layout);
check('runtimeLayout is pure (input root untouched)', (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-smoke-layout-'));
  try {
    runtimeLayout(root);
    return fs.readdirSync(root).length === 0;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})());

// ---------------------------------------------------------------------------
// 3. .env parsing matches start-video.ps1 semantics.
// ---------------------------------------------------------------------------
const envText = [
  '# comment line',
  '',
  '  OPENAI_API_KEY=   ',
  "GROQ_API_KEY='abc'",
  'R2_BUCKET="bucket-name"',
  'DUP=first',
  'DUP=second',
  '#   GEMINI_API_KEY=',
].join('\r\n');
const env = parseEnvText(envText);
check('parseEnvText skips comments and blank lines', !('comment' in env) && !('# comment line' in env));
check('parseEnvText keeps blank values (documented placeholder)', env.OPENAI_API_KEY === '');
check('parseEnvText strips single quotes', env.GROQ_API_KEY === 'abc');
check('parseEnvText strips double quotes', env.R2_BUCKET === 'bucket-name');
check('parseEnvText keeps the last duplicate', env.DUP === 'second');
check('parseEnvText ignores commented-out assignments', !('GEMINI_API_KEY' in env));
check('parseEnvText handles CRLF input', Object.keys(env).length === 4, Object.keys(env));

const documented = documentedEnvKeys(envText);
check('documentedEnvKeys includes commented-out keys', documented.includes('GEMINI_API_KEY'), documented);
check('documentedEnvKeys includes active keys', documented.includes('OPENAI_API_KEY'));
check('documentedEnvKeys does not invent keys from prose', !documented.includes('comment'), documented);

check('populatedKeys ignores blank and whitespace values', (() => {
  const keys = populatedKeys({ A: '', B: '   ', C: 'value' }, ['A', 'B', 'C', 'D']);
  return keys.length === 1 && keys[0] === 'C';
})());
check('populatedKeys never exposes the value', (() => {
  const keys = populatedKeys({ A: 'super-secret' }, ['A']);
  return keys.join(',') === 'A';
})());

// ---------------------------------------------------------------------------
// 4. Report rendering and summary counting.
// ---------------------------------------------------------------------------
const results: SmokeResult[] = [
  { name: 'node-version', status: 'PASS', detail: 'v20.0.0' },
  { name: 'ffmpeg', status: 'FAIL', detail: 'not runnable' },
  { name: 'python', status: 'SKIP', detail: 'not installed' },
];
const summary = summarizeResults(results);
check('summarizeResults counts each status', summary.pass === 1 && summary.fail === 1 && summary.skip === 1, summary);
check('summarizeResults fails when anything fails', summary.ok === false);
check('summarizeResults passes an all-clear set', summarizeResults(results.filter((r) => r.status === 'PASS')).ok === true);

const report = renderSmokeReport(results, ['header line']);
check('renderSmokeReport prints the header first', report.startsWith('header line'), report);
check('renderSmokeReport prints one line per check', ['node-version', 'ffmpeg', 'python'].every((name) => report.includes(name)));
check('renderSmokeReport prints the totals', report.includes('3 checks: 1 passed, 1 failed, 1 skipped'), report);
check('renderSmokeReport keeps columns aligned', report.split(/\r?\n/).filter((l) => /^(PASS|FAIL|SKIP)/.test(l)).every((l) => l.indexOf('  ') === 4), report);

check('tail keeps only the last lines', tail('a\nb\nc\nd\ne', 2) === 'd | e', tail('a\nb\nc\nd\ne', 2));
check('tail truncates very long output', tail('x'.repeat(1000), 1, 20).length === 20);
check('tail handles empty output', tail('   ') === '');

// ---------------------------------------------------------------------------
// 5. The committed templates are safe and complete (read-only).
// ---------------------------------------------------------------------------
const template = readText(path.join(REPO, 'scripting', '.env.example'));
const templateEnv = parseEnvText(template);
check('template documents every required active key', REQUIRED_ENV_TEMPLATE_KEYS.every((k) => k in templateEnv), REQUIRED_ENV_TEMPLATE_KEYS.filter((k) => !(k in templateEnv)));
check('template documents the optional/commented keys', DOCUMENTED_ENV_TEMPLATE_KEYS.every((k) => documentedEnvKeys(template).includes(k)));
check('template carries no credential values', populatedKeys(templateEnv, Object.keys(templateEnv)).length === 0, populatedKeys(templateEnv, Object.keys(templateEnv)));
check('template still documents the provider keys', REQUIRED_PROVIDER_KEYS.every((k) => k in templateEnv), REQUIRED_PROVIDER_KEYS);

const examplePath = path.join(PROD, 'config', 'youtube-accounts.example.json');
const example = validateYouTubeAccountAllowlist(JSON.parse(readText(examplePath)));
check('committed allowlist example validates', example.schema_version === 1 && Object.keys(example.projects).length >= 1);
check('committed allowlist example holds only placeholders', Object.values(example.projects).every((p) => /^YOUR_/i.test(p.accountId)), Object.values(example.projects));

// ---------------------------------------------------------------------------
// 6. CLI usage text is complete, safe and documents the runtime directories.
// ---------------------------------------------------------------------------
const usage = renderUsage();
const commands = ['create', 'resume', 'status', 'approve', 'publish-status', 'health', 'seo', 'qa', 'mix-validate', 'help'];
check('usage lists every command', commands.every((c) => usage.includes(c)), commands.filter((c) => !usage.includes(c)));
check('usage names the runtime roots', ['PROJECTS_ROOT', 'INPUTS_ROOT', 'OUTPUTS_ROOT'].every((v) => usage.includes(v)));
check('usage explains that inputs/ is user-created', /INPUTS_ROOT\s+\(create it yourself; never auto-created\)/.test(usage));
check('usage contains no absolute machine path', !/(C:\\|D:\\|\/Users\/|\/home\/)/.test(usage));
check('usage never asks for a secret', !/(API_KEY|SECRET|TOKEN)/.test(usage));

// ---------------------------------------------------------------------------
// 7. A fresh clone has the files the smoke test depends on.
// ---------------------------------------------------------------------------
const requiredFiles = [
  'production/package.json',
  'production/package-lock.json',
  'production/tsconfig.json',
  'production/src/smoke.ts',
  'production/src/video.ts',
  'production/config/youtube-accounts.example.json',
  'scripting/requirements.txt',
  'scripting/.env.example',
  'scripting/schema/pipeline.schema.json',
  'scripting/schema/seo.schema.json',
  'scripting/pipeline/one_minute.py',
  'scripting/pipeline/seo.py',
  'scripting/pipeline/project_check.py',
  'docs/SETUP_WINDOWS.md',
];
const missing = requiredFiles.filter((f) => !fs.statSync(path.join(REPO, f), { throwIfNoEntry: false })?.isFile());
check('every file the setup/smoke flow needs is committed', missing.length === 0, missing);

const pkg = JSON.parse(readText(path.join(PROD, 'package.json')));
check('package.json exposes npm run smoke', pkg.scripts?.smoke === 'tsx src/smoke.ts', pkg.scripts?.smoke);
check('package.json keeps the canonical video entrypoint', pkg.scripts?.video === 'tsx src/video.ts');

// ---------------------------------------------------------------------------
// 8. Runner argument validation (an unknown name fails fast and spawns nothing).
// ---------------------------------------------------------------------------
const unknownOnly = await runSmoke({ only: ['definitely-not-a-check'] });
check(
  'runSmoke rejects an unknown --only name',
  unknownOnly.length === 1 && unknownOnly[0].status === 'FAIL' && unknownOnly[0].detail.includes('definitely-not-a-check'),
  unknownOnly,
);
check('renderSmokeReport handles an empty result set', renderSmokeReport([]).includes('0 checks: 0 passed, 0 failed, 0 skipped'));

console.log(`\nSMOKE-CHECK TESTS PASSED (${passed} checks)`);
