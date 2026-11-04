// Offline tests for the SEO → review adapter (production/src/seoGenerator.ts).
//
// No Python process, no model, no network, no publishing: the child spawn is injected.
// Proves the CLI mapping, report parsing, refusal handling, fail-closed success rule, and
// that the SEO path has no route to the publisher.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';

const mod = await import(pathToFileURL(`${SRC}/seoGenerator.ts`).href);
const { buildSeoArgs, parseSeoReport, resolveSeoProjectFile, createPythonSeoGenerator, statusFromExit } = mod;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed += 1; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const REPO = path.resolve(SRC, '..', '..');
const PROJECT_ID = 'seo-adapter-fixture';
const PACKAGE_REL = 'seo/seo-package.json';

/** Fake spawn that records the call and optionally materialises the package file. */
function fakeSpawn(behaviour: {
  code?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  writePackage?: boolean;
}) {
  const calls: Array<{ command: string; args: string[]; opts: any }> = [];
  const spawn = async (command: string, args: string[], opts: any) => {
    calls.push({ command, args, opts });
    if (behaviour.writePackage) {
      const projectFile = args[args.indexOf('--project') + 1];
      const packagePath = path.join(path.dirname(projectFile), PACKAGE_REL);
      await fsp.mkdir(path.dirname(packagePath), { recursive: true });
      await fsp.writeFile(packagePath, JSON.stringify({ project_id: PROJECT_ID }), 'utf8');
    }
    return {
      code: behaviour.code === undefined ? 0 : behaviour.code,
      stdout: behaviour.stdout ?? '',
      stderr: behaviour.stderr ?? '',
      timedOut: behaviour.timedOut ?? false,
    };
  };
  return { spawn, calls };
}

async function workspace(): Promise<{ root: string; projectFile: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'seo-adapter-'));
  const projectDir = path.join(root, 'projects', PROJECT_ID);
  await fsp.mkdir(projectDir, { recursive: true });
  const projectFile = path.join(projectDir, 'pipeline.json');
  await fsp.writeFile(projectFile, JSON.stringify({ project_id: PROJECT_ID }), 'utf8');
  return { root, projectFile };
}

function successReport(projectFile: string, over: Record<string, any> = {}) {
  return {
    ok: true,
    status: 'CREATED',
    project_id: PROJECT_ID,
    package_path: path.join(path.dirname(projectFile), PACKAGE_REL),
    markdown_path: path.join(path.dirname(projectFile), 'seo/seo-package.md'),
    metadata_path: path.join(path.dirname(projectFile), 'seo/youtube-metadata.json'),
    recommended_title: 'श्मशान से आती आवाज़',
    title_candidates: ['श्मशान से आती आवाज़', 'अमावस की रात का राज़', 'रात के 2 बजे की पुकार'],
    generation: 1,
    attempts: 1,
    warnings: [],
    errors: [],
    publisher_invoked: false,
    network_used: true,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------
// 1. Argument mapping
// ---------------------------------------------------------------------------------------
{
  const file = 'C:/repo/scripting/projects/p/pipeline.json';
  const base = buildSeoArgs(file, {});
  check('args: always requests the JSON report', base.includes('--json'), base);
  check('args: uses the python module entrypoint', base.slice(0, 2).join(' ') === '-m pipeline.seo', base);
  check('args: targets the project file', base[base.indexOf('--project') + 1] === file, base);
  check('args: no flags by default', base.length === 5, base);

  check('args: --regenerate mapped', buildSeoArgs(file, { regenerate: true }).includes('--regenerate'));
  check('args: --extract-only mapped', buildSeoArgs(file, { extractOnly: true }).includes('--extract-only'));
  const attempts = buildSeoArgs(file, { maxAttempts: 2 });
  check('args: --max-attempts mapped', attempts[attempts.indexOf('--max-attempts') + 1] === '2', attempts);
  const model = buildSeoArgs(file, { model: 'some-model' });
  check('args: --model mapped', model[model.indexOf('--model') + 1] === 'some-model', model);

  const approve = buildSeoArgs(file, { approveMetadata: true, approvedBy: 'Ridham' });
  check('args: --approve-metadata mapped', approve.includes('--approve-metadata'));
  check('args: --approve-metadata sends explicit --yes', approve.includes('--yes'));
  check('args: --approve-metadata records the approver', approve[approve.indexOf('--by') + 1] === 'Ridham');
  check('args: --approve-metadata sends no generation flags',
    !approve.includes('--regenerate') && !approve.includes('--extract-only'), approve);

  let threw = false;
  try { buildSeoArgs(file, { approveMetadata: true }); } catch { threw = true; }
  check('args: approval without an approver is refused before spawn', threw);

  check('args: extract-only is not combined with approval',
    !buildSeoArgs(file, { extractOnly: true }).includes('--approve-metadata'));
}

// ---------------------------------------------------------------------------------------
// 2. Project resolution
// ---------------------------------------------------------------------------------------
{
  const opts = { repoRoot: 'C:/repo' };
  const fromId = resolveSeoProjectFile({ projectId: 'abc' }, opts);
  check('resolve: id maps to scripting/projects/<id>/pipeline.json',
    fromId === path.resolve('C:/repo/scripting/projects/abc/pipeline.json'), fromId);
  const fromPath = resolveSeoProjectFile({ projectFile: 'C:/repo/x/pipeline.json' }, opts);
  check('resolve: explicit path wins', fromPath === path.resolve('C:/repo/x/pipeline.json'), fromPath);
  const custom = resolveSeoProjectFile({ projectId: 'abc' }, { repoRoot: 'C:/repo', projectsRoot: 'D:/projects' });
  check('resolve: projectsRoot override honoured',
    custom === path.resolve('D:/projects/abc/pipeline.json'), custom);

  let threw = false;
  try { resolveSeoProjectFile({}, opts); } catch { threw = true; }
  check('resolve: missing project is a caller error', threw);

  for (const bad of ['../escape', 'a/b', 'a\\b']) {
    let refused = false;
    try { resolveSeoProjectFile({ projectId: bad }, opts); } catch { refused = true; }
    check(`resolve: rejects unsafe project id ${JSON.stringify(bad)}`, refused);
  }
}

// ---------------------------------------------------------------------------------------
// 3. Report parsing
// ---------------------------------------------------------------------------------------
{
  check('parse: plain report', parseSeoReport('{"ok":true,"status":"CREATED"}')?.status === 'CREATED');
  check('parse: leading provider noise tolerated',
    parseSeoReport('[retry] provider call failed\n{"ok":true,"status":"CREATED"}')?.status === 'CREATED');
  check('parse: trailing prose tolerated',
    parseSeoReport('{"ok":true}\nDone.')?.ok === true);
  const two = parseSeoReport('{"status":"FAILED"}\n{"status":"CREATED"}');
  check('parse: keeps the last complete document', two?.status === 'CREATED', two);
  check('parse: braces inside strings do not confuse the scanner',
    parseSeoReport('{"description":"a } b { c","status":"CREATED"}')?.status === 'CREATED');
  check('parse: escaped quotes handled',
    parseSeoReport('{"description":"he said \\"hi\\"","status":"CREATED"}')?.status === 'CREATED');
  check('parse: garbage yields null', parseSeoReport('not json at all') === null);
  check('parse: empty yields null', parseSeoReport('') === null);
  check('parse: arrays are not reports', parseSeoReport('[1,2,3]') === null);
  // REGRESSION: a nested object used to overwrite the enclosing report with its inner payload.
  const nested = parseSeoReport('{"ok":true,"status":"EXTRACT_ONLY","facts":{"scene_count":23}}');
  check('REGRESSION: nested objects do not shadow the report', nested?.status === 'EXTRACT_ONLY', nested);
  check('REGRESSION: nested payload stays nested', (nested as any)?.facts?.scene_count === 23, nested);
  check('exit map: 3 is EXISTS', statusFromExit(3) === 'EXISTS');
  check('exit map: 1 is FAILED', statusFromExit(1) === 'FAILED');
  check('exit map: null is FAILED', statusFromExit(null) === 'FAILED');
}

// ---------------------------------------------------------------------------------------
// 4. Runner: success, fail-closed, refusal, usage, spawn contract
// ---------------------------------------------------------------------------------------
{
  const { root, projectFile } = await workspace();
  const fake = fakeSpawn({ stdout: JSON.stringify(successReport(projectFile)), writePackage: true });
  const runSeo = createPythonSeoGenerator({ repoRoot: root, pythonPath: 'python', spawn: fake.spawn });
  const result = await runSeo({ projectFile });

  check('runner: success reported', result.ok === true, result.reason);
  check('runner: status CREATED', result.status === 'CREATED', result.status);
  check('runner: exit code preserved', result.exitCode === 0, result.exitCode);
  check('runner: recommended title surfaced', result.recommendedTitle === 'श्मशान से आती आवाज़');
  check('runner: three candidates surfaced', (result.titleCandidates ?? []).length === 3);
  check('runner: package path surfaced', result.packagePath === path.join(root, 'projects', PROJECT_ID, PACKAGE_REL));
  check('runner: publisher never invoked', result.publisherInvoked === false);
  check('runner: spawn ran once', fake.calls.length === 1, fake.calls.length);
  check('runner: spawn cwd is scripting/', fake.calls[0].opts.cwd === path.join(root, 'scripting'), fake.calls[0].opts.cwd);
  check('runner: UTF-8 forced for the child', fake.calls[0].opts.env.PYTHONIOENCODING === 'utf-8'
    && fake.calls[0].opts.env.PYTHONUTF8 === '1');
  check('runner: provider keys are not injected by the adapter',
    !Object.keys(fake.calls[0].opts.env).some((k) => /^SEO_.*KEY$/.test(k)));
  await fsp.rm(root, { recursive: true, force: true });
}

{
  // A report that claims success but left no package behind must NOT be reported as success.
  const { root, projectFile } = await workspace();
  const fake = fakeSpawn({ stdout: JSON.stringify(successReport(projectFile)) });
  const runSeo = createPythonSeoGenerator({ repoRoot: root, pythonPath: 'python', spawn: fake.spawn });
  const result = await runSeo({ projectFile });
  check('runner: missing package fails closed', result.ok === false, result.status);
  check('runner: missing package reported as FAILED', result.status === 'FAILED', result.status);
  check('runner: missing package reason is explicit', /no package exists/.test(result.reason ?? ''), result.reason);
  await fsp.rm(root, { recursive: true, force: true });
}

{
  // Exit 3 = refused because a package already exists (regeneration not requested).
  const { root, projectFile } = await workspace();
  const refusal = { ok: false, status: 'EXISTS', reason: 'an SEO package already exists', errors: [] };
  const fake = fakeSpawn({ code: 3, stdout: JSON.stringify(refusal), stderr: 'an SEO package already exists' });
  const runSeo = createPythonSeoGenerator({ repoRoot: root, pythonPath: 'python', spawn: fake.spawn });
  const result = await runSeo({ projectFile });
  check('runner: refusal exits 3', result.exitCode === 3, result.exitCode);
  check('runner: refusal status EXISTS', result.status === 'EXISTS', result.status);
  check('runner: refusal is not ok', result.ok === false);
  check('runner: refusal keeps the reason', /already exists/.test(result.reason ?? ''), result.reason);
  await fsp.rm(root, { recursive: true, force: true });
}

{
  // Exit 1 = generation/validation failure; details must survive.
  const { root, projectFile } = await workspace();
  const failure = { ok: false, status: 'FAILED', reason: 'SEO generation failed after 3 attempt(s)', errors: ['title: too long'] };
  const fake = fakeSpawn({ code: 1, stdout: JSON.stringify(failure), stderr: 'failed' });
  const runSeo = createPythonSeoGenerator({ repoRoot: root, pythonPath: 'python', spawn: fake.spawn });
  const result = await runSeo({ projectFile });
  check('runner: failure exits 1', result.exitCode === 1);
  check('runner: failure status FAILED', result.status === 'FAILED');
  check('runner: failure carries the validation detail', (result.errors ?? []).includes('title: too long'), result.errors);
  check('runner: failure is not ok', result.ok === false);
  await fsp.rm(root, { recursive: true, force: true });
}

{
  // Exit 2 = usage error, no report body.
  const { root, projectFile } = await workspace();
  const fake = fakeSpawn({ code: 2, stderr: '--approve-metadata requires --yes and --by <name>.' });
  const runSeo = createPythonSeoGenerator({ repoRoot: root, pythonPath: 'python', spawn: fake.spawn });
  const result = await runSeo({ projectFile });
  check('runner: usage error exits 2', result.exitCode === 2);
  check('runner: usage error falls back to FAILED', result.status === 'FAILED');
  check('runner: usage error keeps the stderr tail', /--by/.test(result.reason ?? ''), result.reason);
  await fsp.rm(root, { recursive: true, force: true });
}

{
  // Missing project file: refused by the adapter before any process is started.
  const { root } = await workspace();
  const fake = fakeSpawn({ stdout: '{}' });
  const runSeo = createPythonSeoGenerator({ repoRoot: root, pythonPath: 'python', spawn: fake.spawn });
  const result = await runSeo({ projectId: 'does-not-exist' });
  check('runner: missing project fails without spawning', fake.calls.length === 0, fake.calls.length);
  check('runner: missing project exits 2', result.exitCode === 2, result.exitCode);
  check('runner: missing project explains itself', /not found/.test(result.reason ?? ''), result.reason);
  await fsp.rm(root, { recursive: true, force: true });
}

{
  // --extract-only makes no provider call, so network_used must stay false.
  const { root, projectFile } = await workspace();
  const extract = { ok: true, status: 'EXTRACT_ONLY', project_id: PROJECT_ID, facts: { scene_count: 23 }, network_used: false };
  const fake = fakeSpawn({ stdout: JSON.stringify(extract) });
  const runSeo = createPythonSeoGenerator({ repoRoot: root, pythonPath: 'python', spawn: fake.spawn });
  const result = await runSeo({ projectFile, extractOnly: true });
  check('runner: extract-only succeeds', result.ok === true, result.reason);
  check('runner: extract-only never needs a package file', result.status === 'EXTRACT_ONLY');
  check('runner: extract-only reports no network use', result.networkUsed === false);
  check('runner: extract-only passes the flag', fake.calls[0].args.includes('--extract-only'));
  await fsp.rm(root, { recursive: true, force: true });
}

{
  // Metadata approval is an explicit, local-only action.
  const { root, projectFile } = await workspace();
  const metadataPath = path.join(path.dirname(projectFile), 'seo', 'youtube-metadata.json');
  await fsp.mkdir(path.dirname(metadataPath), { recursive: true });
  await fsp.writeFile(metadataPath, JSON.stringify({ status: 'approved' }), 'utf8');
  const approved = { ok: true, status: 'METADATA_APPROVED', project_id: PROJECT_ID, metadata_path: metadataPath, publisher_invoked: false, network_used: false };
  const fake = fakeSpawn({ stdout: JSON.stringify(approved) });
  const runSeo = createPythonSeoGenerator({ repoRoot: root, pythonPath: 'python', spawn: fake.spawn });
  const result = await runSeo({ projectFile, approveMetadata: true, approvedBy: 'Ridham' });
  check('runner: metadata approval succeeds', result.ok === true, result.reason);
  check('runner: metadata approval status', result.status === 'METADATA_APPROVED', result.status);
  check('runner: metadata approval verifies the recorded file', result.metadataPath === metadataPath);
  check('runner: metadata approval sends --yes', fake.calls[0].args.includes('--yes'));
  check('runner: metadata approval sends the approver', fake.calls[0].args[fake.calls[0].args.indexOf('--by') + 1] === 'Ridham');
  check('runner: metadata approval never reports a publish', result.publisherInvoked === false);
  await fsp.rm(root, { recursive: true, force: true });
}

{
  // A spawning failure (null exit code) is a failure, never a silent success.
  const { root, projectFile } = await workspace();
  const fake = fakeSpawn({ code: null, stderr: 'spawn python ENOENT' });
  const runSeo = createPythonSeoGenerator({ repoRoot: root, pythonPath: 'python', spawn: fake.spawn });
  const result = await runSeo({ projectFile });
  check('runner: spawn failure is not ok', result.ok === false);
  check('runner: spawn failure keeps the stderr', /ENOENT/.test(`${result.reason}`), result.reason);
  await fsp.rm(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------
// 5. No route to the publisher (static guarantees)
// ---------------------------------------------------------------------------------------
{
  const seoSource = await fsp.readFile(path.join(SRC, 'seoGenerator.ts'), 'utf8');
  const imports = [...seoSource.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  check('static: SEO adapter imports only node builtins + the pipeline adapter',
    imports.every((spec) => spec.startsWith('node:') || spec === './pipelineGenerator.js'), imports);
  check('static: SEO adapter never imports zernio/r2/approval',
    !imports.some((spec) => /zernio|r2Media|approval|publish/i.test(spec)), imports);

  const zernioSource = await fsp.readFile(path.join(SRC, 'zernio.ts'), 'utf8');
  check('static: the publisher never references the SEO engine',
    !/seoGenerator|youtube-metadata|seo-package/i.test(zernioSource));

  const videoSource = await fsp.readFile(path.join(SRC, 'video.ts'), 'utf8');
  check('static: video CLI keeps SEO behind an explicit command',
    /command === 'seo'/.test(videoSource));
  check('static: create only runs SEO with an explicit --seo flag',
    /hasFlag\('--seo'\)/.test(videoSource));
  check('static: the SEO command block never calls the publisher',
    !/createPythonSeoGenerator[\s\S]{0,4000}?publishToZernio/.test(videoSource));
}

console.log(`\n${passed} checks passed`);
console.log('SEO ADAPTER TESTS PASSED');
