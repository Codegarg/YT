/**
 * `npm run smoke` — OFFLINE reproducibility check for a fresh clone.
 *
 * This module answers one question: "can this checkout run the pipeline's local tooling?"
 * It never touches the network, never opens Chrome/Flow, never spends credits, never uploads,
 * never publishes, and never writes inside an existing project. The only filesystem writes are
 * inside a throwaway directory under the OS temp root, which is removed afterwards.
 *
 * Checks
 *   node-version        Node is new enough for `node --import tsx` and `node --test`
 *   node-dependencies   every package.json dependency is present in node_modules (`npm ci`)
 *   typecheck           `tsc --noEmit` is clean
 *   python              a Python interpreter resolves (repo venv first, then PATH)
 *   python-imports      the pipeline modules import
 *   python-dependencies groq/openai/jsonschema/dotenv are installed
 *   project-schema      both committed JSON schemas are loadable by jsonschema
 *   ffmpeg              ffmpeg + ffprobe resolve and execute
 *   cli-help            `video --help` exits 0
 *   cli-status          `video status` on a missing project is read-only and reports NOT_FOUND
 *   config              the committed allowlist example validates; the real file is local-only
 *   env-template        scripting/.env.example documents the keys and holds no real values
 *   runtime-dirs        the documented runtime layout can be created and written
 *   credentials         reports which optional keys are present (never their values)
 *
 * Exit code is 0 when no check FAILs. SKIP is reported for checks that need a missing optional
 * tool (e.g. no venv, no ffmpeg) only where the rest of the pipeline can still be inspected;
 * dependencies that are strictly required FAIL with an actionable fix.
 */
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolvePython, spawnCapture } from './pipelineGenerator.js';
import { validateYouTubeAccountAllowlist } from './youtubeAccountAllowlist.js';
import { ffprobeBinary } from './videoClip.js';

export const MIN_NODE_MAJOR = 20;
export const MIN_PYTHON_MAJOR = 3;
export const MIN_PYTHON_MINOR = 10;

/** Keys the scripting stages require for a new story (one of them). */
export const REQUIRED_PROVIDER_KEYS = ['OPENAI_API_KEY', 'GROQ_API_KEY'];

/** Keys that must exist as active (uncommented) lines in scripting/.env.example. */
export const REQUIRED_ENV_TEMPLATE_KEYS = [
  'OPENAI_API_KEY',
  'GROQ_API_KEY',
  'ZERNIO_API_KEY',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'FREESOUND_CLIENT_ID',
  'FREESOUND_CLIENT_SECRET',
  'FREESOUND_REFRESH_TOKEN',
];

/** Keys that must at least be documented in the template, active or commented out. */
export const DOCUMENTED_ENV_TEMPLATE_KEYS = ['GEMINI_API_KEY', 'OPENAI_MODEL', 'GROQ_MODEL', 'FLOW_MAX_RETRY_HOURS'];

const PRODUCTION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PRODUCTION_DIR, '..');
const PYTHON_ENV = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };

export type SmokeStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface SmokeResult {
  name: string;
  status: SmokeStatus;
  detail: string;
}

// ---------------------------------------------------------------------------------------
// Pure helpers (unit tested without spawning anything)
// ---------------------------------------------------------------------------------------

/** Parse `v24.20.0`, `24.20.0` or `Python 3.11.9` into numeric parts. */
export function parseVersion(text: string): { major: number; minor: number; patch: number } | null {
  const match = String(text).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) };
}

/** True when `version` is at least `minimum` (major, then minor). */
export function meetsMinimum(
  version: { major: number; minor: number },
  minimum: { major: number; minor: number },
): boolean {
  if (version.major !== minimum.major) return version.major > minimum.major;
  return version.minor >= minimum.minor;
}

/** Canonical runtime layout under one root (documented in README/docs/SETUP_WINDOWS.md). */
export function runtimeLayout(root: string): {
  projects: string;
  inputs: string;
  outputs: string;
  logs: string;
} {
  return {
    projects: path.join(root, 'projects'),
    inputs: path.join(root, 'inputs'),
    outputs: path.join(root, 'outputs'),
    logs: path.join(root, 'logs'),
  };
}

/**
 * Parse `KEY=value` lines the same way start-video.ps1 does (comments and blanks skipped).
 * Duplicate keys keep the last value, matching dotenv's behaviour.
 */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!line) continue;
    const value = line[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    out[line[1]] = value;
  }
  return out;
}

/** Keys named in `KEY=` lines, including commented-out ones (documentation coverage). */
export function documentedEnvKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.match(/^\s*#?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (line) keys.add(line[1]);
  }
  return [...keys];
}

/** Keys from `keys` that have a non-empty value. Values are never returned or printed. */
export function populatedKeys(env: Record<string, string>, keys: string[]): string[] {
  return keys.filter((key) => Boolean((env[key] ?? '').trim()));
}

export function summarizeResults(results: SmokeResult[]): {
  ok: boolean;
  pass: number;
  fail: number;
  skip: number;
} {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  return { ok: fail === 0, pass, fail, skip };
}

/** Render the human-readable report (no ANSI, stable column widths, no secret values). */
export function renderSmokeReport(results: SmokeResult[], header: string[] = []): string {
  const width = Math.max(...results.map((r) => r.name.length), 10);
  const lines: string[] = [];
  if (header.length) {
    lines.push(...header, '');
  }
  for (const r of results) {
    lines.push(`${r.status.padEnd(4)}  ${r.name.padEnd(width)}  ${r.detail}`);
  }
  const summary = summarizeResults(results);
  lines.push('');
  lines.push(
    `${results.length} checks: ${summary.pass} passed, ${summary.fail} failed, ${summary.skip} skipped`,
  );
  return lines.join('\n');
}

/** Tail of a child-process output, used for concise failure details. */
export function tail(text: string, lines = 4, maxChars = 400): string {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  const tailLines = trimmed.split(/\r?\n/).slice(-lines).join(' | ');
  return tailLines.slice(-maxChars);
}

// ---------------------------------------------------------------------------------------
// Check implementations
// ---------------------------------------------------------------------------------------

interface CheckContext {
  root: string;
}

type Check = (ctx: CheckContext) => Promise<SmokeResult>;

function result(name: string, status: SmokeStatus, detail: string): SmokeResult {
  return { name, status, detail };
}

const checkNodeVersion: Check = async () => {
  const parsed = parseVersion(process.version);
  if (!parsed) return result('node-version', 'FAIL', `cannot parse Node version "${process.version}"`);
  const ok = meetsMinimum(parsed, { major: MIN_NODE_MAJOR, minor: 0 });
  return result(
    'node-version',
    ok ? 'PASS' : 'FAIL',
    ok
      ? `${process.version} (requires >= v${MIN_NODE_MAJOR})`
      : `${process.version} is too old; install Node.js >= ${MIN_NODE_MAJOR} and rerun npm ci`,
  );
};

async function readPackageJson(): Promise<any> {
  return JSON.parse(await fsp.readFile(path.join(PRODUCTION_DIR, 'package.json'), 'utf8'));
}

const checkNodeDependencies: Check = async () => {
  const pkg = await readPackageJson();
  const required = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const missing: string[] = [];
  for (const name of Object.keys(required)) {
    const manifest = path.join(PRODUCTION_DIR, 'node_modules', name, 'package.json');
    if (!fs.existsSync(manifest)) missing.push(name);
  }
  if (missing.length) {
    return result(
      'node-dependencies',
      'FAIL',
      `missing ${missing.length}/${Object.keys(required).length} packages (${missing.slice(0, 4).join(', ')}). Run "npm ci" in production/`,
    );
  }
  return result('node-dependencies', 'PASS', `${Object.keys(required).length} packages present in production/node_modules`);
};

const checkTypecheck: Check = async () => {
  const tsc = path.join(PRODUCTION_DIR, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) {
    return result('typecheck', 'FAIL', 'typescript is not installed; run "npm ci" in production/');
  }
  const res = await spawnCapture(process.execPath, [tsc, '--noEmit'], {
    cwd: PRODUCTION_DIR,
    timeoutMs: 300_000,
  });
  if (res.code === 0) return result('typecheck', 'PASS', 'tsc --noEmit is clean');
  return result('typecheck', 'FAIL', `tsc exited ${res.code ?? 'null'}: ${tail(res.stdout || res.stderr)}`);
};

const checkPython: Check = async () => {
  const python = await resolvePython(REPO_ROOT);
  const res = await spawnCapture(python, ['--version'], {
    cwd: path.join(REPO_ROOT, 'scripting'),
    env: { ...process.env, ...PYTHON_ENV },
    timeoutMs: 60_000,
  });
  const text = `${res.stdout}\n${res.stderr}`.trim();
  if (res.code !== 0 || !text) {
    return result(
      'python',
      'FAIL',
      `"${python}" could not run. Create the venv (see docs/SETUP_WINDOWS.md) or put Python on PATH`,
    );
  }
  const parsed = parseVersion(text);
  if (!parsed) return result('python', 'FAIL', `cannot parse "${text}"`);
  const ok = meetsMinimum(parsed, { major: MIN_PYTHON_MAJOR, minor: MIN_PYTHON_MINOR });
  const where = python === 'python' ? 'PATH' : 'scripting/.venv';
  return result(
    'python',
    ok ? 'PASS' : 'FAIL',
    ok
      ? `${parsed.major}.${parsed.minor}.${parsed.patch} from ${where} (requires >= ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR})`
      : `${parsed.major}.${parsed.minor} from ${where} is too old; install Python >= ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR}`,
  );
};

async function runPython(source: string, timeoutMs = 120_000) {
  const python = await resolvePython(REPO_ROOT);
  return spawnCapture(python, ['-c', source], {
    cwd: path.join(REPO_ROOT, 'scripting'),
    env: { ...process.env, ...PYTHON_ENV },
    timeoutMs,
  });
}

const checkPythonImports: Check = async () => {
  const modules = ['pipeline.one_minute', 'pipeline.seo', 'pipeline.project_check', 'pipeline.anthropic_client'];
  const res = await runPython(`import ${modules.join(', ')}`);
  if (res.code === 0) return result('python-imports', 'PASS', `${modules.length} modules import`);
  return result('python-imports', 'FAIL', `import failed: ${tail(res.stderr || res.stdout)}`);
};

const checkPythonDependencies: Check = async () => {
  const modules = ['groq', 'openai', 'jsonschema', 'dotenv'];
  const res = await runPython(`import ${modules.join(', ')}`);
  if (res.code === 0) return result('python-dependencies', 'PASS', `${modules.join(', ')} import`);
  return result(
    'python-dependencies',
    'FAIL',
    `missing package(s): ${tail(res.stderr || res.stdout)}. Run "pip install -r requirements.txt" in scripting/`,
  );
};

const checkProjectSchema: Check = async () => {
  const schemas = ['schema/pipeline.schema.json', 'schema/seo.schema.json'];
  const source = [
    'import json, jsonschema',
    `paths = ${JSON.stringify(schemas)}`,
    'for p in paths:',
    "    doc = json.load(open(p, encoding='utf-8'))",
    '    jsonschema.validators.validator_for(doc)(doc).check_schema(doc)',
    'print(len(paths))',
  ].join('\n');
  const res = await runPython(source);
  if (res.code === 0) return result('project-schema', 'PASS', `${schemas.length} schemas check out (jsonschema)`);
  return result('project-schema', 'FAIL', `schema check failed: ${tail(res.stderr || res.stdout)}`);
};

const checkFfmpeg: Check = async () => {
  const ffmpeg = String(process.env.FFMPEG_PATH || 'ffmpeg').trim();
  const probe = ffprobeBinary();
  const missing: string[] = [];
  const versions: string[] = [];
  for (const [label, binary] of [
    ['ffmpeg', ffmpeg],
    ['ffprobe', probe],
  ] as const) {
    const res = await spawnCapture(binary, ['-version'], { timeoutMs: 30_000 });
    if (res.code !== 0) {
      missing.push(label);
      continue;
    }
    const first = String(res.stdout).split(/\r?\n/)[0] ?? '';
    const parsed = parseVersion(first);
    versions.push(`${label} ${parsed ? `${parsed.major}.${parsed.minor}` : '?'}`);
  }
  if (missing.length) {
    return result(
      'ffmpeg',
      'FAIL',
      `${missing.join(' + ')} not runnable. Install FFmpeg, put it on PATH, or set FFMPEG_PATH/FFPROBE_PATH`,
    );
  }
  return result('ffmpeg', 'PASS', `${versions.join(', ')} (${path.dirname(ffmpeg) === '.' ? 'PATH' : 'configured'})`);
};

const checkCliHelp: Check = async () => {
  const res = await spawnCapture(
    process.execPath,
    ['--import', 'tsx', path.join(PRODUCTION_DIR, 'src', 'video.ts'), '--help'],
    { cwd: PRODUCTION_DIR, timeoutMs: 120_000 },
  );
  const text = `${res.stdout}\n${res.stderr}`;
  if (res.code !== 0) return result('cli-help', 'FAIL', `--help exited ${res.code ?? 'null'}: ${tail(text)}`);
  if (!text.includes('<create|resume|status|validate|approve|publish-status|health|seo|qa|mix-validate|flow-attempts>')) {
    return result('cli-help', 'FAIL', 'usage text did not list the supported commands');
  }
  return result('cli-help', 'PASS', 'video --help exits 0 and lists every command');
};

const checkCliStatus: Check = async (ctx) => {
  const layout = runtimeLayout(path.join(ctx.root, 'status'));
  const projectFile = path.join(layout.projects, 'smoke-readonly-probe', 'pipeline.json');
  const res = await spawnCapture(
    process.execPath,
    ['--import', 'tsx', path.join(PRODUCTION_DIR, 'src', 'video.ts'), 'status', '--project', projectFile, '--json'],
    {
      cwd: PRODUCTION_DIR,
      timeoutMs: 180_000,
      env: {
        ...process.env,
        PROJECTS_ROOT: layout.projects,
        INPUTS_ROOT: layout.inputs,
        OUTPUTS_ROOT: layout.outputs,
      },
    },
  );
  const text = `${res.stdout}\n${res.stderr}`;
  let parsed: any = null;
  try {
    parsed = JSON.parse(String(res.stdout));
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.status !== 'NOT_FOUND') {
    return result('cli-status', 'FAIL', `expected NOT_FOUND for a missing project, got: ${tail(text)}`);
  }
  // Read-only proof: the temp roots the command was pointed at must not have been created.
  const created: string[] = [];
  for (const dir of [layout.projects, layout.inputs, layout.outputs]) {
    if (await fsp.stat(dir).then(() => true).catch(() => false)) created.push(path.basename(dir));
  }
  if (created.length) {
    return result('cli-status', 'FAIL', `status created ${created.join(', ')}; it must be read-only`);
  }
  return result('cli-status', 'PASS', 'reports NOT_FOUND for a missing project and writes nothing');
};

const checkConfig: Check = async () => {
  const examplePath = path.join(PRODUCTION_DIR, 'config', 'youtube-accounts.example.json');
  const realPath = path.join(PRODUCTION_DIR, 'config', 'youtube-accounts.json');
  const problems: string[] = [];
  let exampleProjects = 0;
  try {
    const example = JSON.parse(await fsp.readFile(examplePath, 'utf8'));
    exampleProjects = Object.keys(validateYouTubeAccountAllowlist(example).projects).length;
  } catch (e: any) {
    problems.push(`example invalid: ${String(e?.message ?? e)}`);
  }
  const realExists = await fsp.stat(realPath).then((s) => s.isFile()).catch(() => false);
  if (realExists) {
    try {
      const real = JSON.parse(await fsp.readFile(realPath, 'utf8'));
      const count = Object.keys(validateYouTubeAccountAllowlist(real).projects).length;
      if (problems.length) return result('config', 'FAIL', problems.join('; '));
      // Values are deliberately not printed: only counts and presence.
      return result('config', 'PASS', `example valid (${exampleProjects} placeholder); local allowlist present (${count} project)`);
    } catch (e: any) {
      return result('config', 'FAIL', `local allowlist invalid: ${String(e?.message ?? e)} (values not printed)`);
    }
  }
  if (problems.length) return result('config', 'FAIL', problems.join('; '));
  return result(
    'config',
    'PASS',
    `example valid (${exampleProjects} placeholder); no local allowlist yet (copy the example when publishing)`,
  );
};

const checkEnvTemplate: Check = async () => {
  const templatePath = path.join(REPO_ROOT, 'scripting', '.env.example');
  const text = await fsp.readFile(templatePath, 'utf8').catch(() => null);
  if (text === null) return result('env-template', 'FAIL', 'scripting/.env.example is missing');
  const env = parseEnvText(text);
  const missingActive = REQUIRED_ENV_TEMPLATE_KEYS.filter((key) => !(key in env));
  if (missingActive.length) {
    return result('env-template', 'FAIL', `template is missing ${missingActive.join(', ')}`);
  }
  const documented = new Set(documentedEnvKeys(text));
  const missingDocumented = DOCUMENTED_ENV_TEMPLATE_KEYS.filter((key) => !documented.has(key));
  if (missingDocumented.length) {
    return result('env-template', 'FAIL', `template does not document ${missingDocumented.join(', ')}`);
  }
  const populated = populatedKeys(env, Object.keys(env));
  if (populated.length) {
    return result('env-template', 'FAIL', `template must not carry real values; ${populated.length} key(s) are non-empty`);
  }
  return result(
    'env-template',
    'PASS',
    `${Object.keys(env).length} active keys (all blank), ${documented.size} keys documented`,
  );
};

const checkRuntimeDirs: Check = async (ctx) => {
  const root = path.join(ctx.root, 'runtime');
  const layout = runtimeLayout(root);
  for (const dir of Object.values(layout)) {
    await fsp.mkdir(dir, { recursive: true });
  }
  const probe = path.join(layout.outputs, '.smoke-probe');
  await fsp.writeFile(probe, 'ok', 'utf8');
  const readBack = await fsp.readFile(probe, 'utf8');
  if (readBack !== 'ok') return result('runtime-dirs', 'FAIL', 'probe file did not read back');
  const entries = await fsp.readdir(root);
  return result(
    'runtime-dirs',
    'PASS',
    `${entries.sort().join(', ')} created under a temp root and written`,
  );
};

const checkCredentials: Check = async () => {
  const present = REQUIRED_PROVIDER_KEYS.filter((key) => Boolean(String(process.env[key] ?? '').trim()));
  const found = present.length ? present.join(' + ') : 'none';
  return result(
    'credentials',
    'PASS',
    `${found} set; not required for offline checks (needed only for "video create")`,
  );
};

const CHECKS: Array<{ name: string; run: Check }> = [
  { name: 'node-version', run: checkNodeVersion },
  { name: 'node-dependencies', run: checkNodeDependencies },
  { name: 'typecheck', run: checkTypecheck },
  { name: 'python', run: checkPython },
  { name: 'python-imports', run: checkPythonImports },
  { name: 'python-dependencies', run: checkPythonDependencies },
  { name: 'project-schema', run: checkProjectSchema },
  { name: 'ffmpeg', run: checkFfmpeg },
  { name: 'cli-help', run: checkCliHelp },
  { name: 'cli-status', run: checkCliStatus },
  { name: 'config', run: checkConfig },
  { name: 'env-template', run: checkEnvTemplate },
  { name: 'runtime-dirs', run: checkRuntimeDirs },
  { name: 'credentials', run: checkCredentials },
];

/**
 * Run every check in an isolated temp root. `only` restricts execution by check name.
 * Never throws for a failed check: failures are values, so one broken tool never hides the rest.
 */
export async function runSmoke(options: { only?: string[]; log?: (line: string) => void } = {}): Promise<SmokeResult[]> {
  const requested = options.only?.filter(Boolean) ?? [];
  const unknown = requested.filter((name) => !CHECKS.some((check) => check.name === name));
  if (unknown.length) {
    return [
      result(
        'smoke-args',
        'FAIL',
        `unknown check(s): ${unknown.join(', ')}; valid: ${CHECKS.map((c) => c.name).join(', ')}`,
      ),
    ];
  }
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'yt-smoke-'));
  const selected = requested.length ? CHECKS.filter((c) => requested.includes(c.name)) : CHECKS;
  const results: SmokeResult[] = [];
  try {
    for (const check of selected) {
      let outcome: SmokeResult;
      try {
        outcome = await check.run({ root });
      } catch (e: any) {
        outcome = result(check.name, 'FAIL', `unexpected error: ${String(e?.message ?? e)}`);
      }
      results.push(outcome);
      options.log?.(`${outcome.status}  ${outcome.name}`);
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  return results;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const onlyIndex = process.argv.indexOf('--only');
  const only = onlyIndex >= 0 ? String(process.argv[onlyIndex + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const json = process.argv.includes('--json');
  runSmoke({ only })
    .then((results) => {
      const summary = summarizeResults(results);
      if (json) {
        console.log(JSON.stringify({ ok: summary.ok, summary, results }, null, 2));
      } else {
        console.log(
          renderSmokeReport(results, [
            'YouTube automation — offline smoke test',
            `repo ${REPO_ROOT}`,
            'No network, no Flow, no Chrome, no uploads, no publishing.',
          ]),
        );
      }
      process.exitCode = summary.ok ? 0 : 1;
    })
    .catch((e) => {
      console.error(String(e?.message ?? e));
      process.exitCode = 1;
    });
}
