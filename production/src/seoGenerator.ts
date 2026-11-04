/**
 * SEO → review adapter (SEO engine wrapper).
 *
 * Thin, publish-free boundary over the EXISTING Python SEO engine
 * (`scripting/pipeline/seo.py`). Exactly like `pipelineGenerator.ts`, it shells out to the
 * stable Python CLI instead of re-implementing the engine in TypeScript, so there is one
 * source of truth for extraction, validation and packaging.
 *
 * Guarantees:
 *   · opt-in only — nothing here runs as part of `create`/`resume`/`status`
 *   · never calls the publisher (no Zernio, no YouTube, no R2, no presign, no upload)
 *   · never claims success unless the CLI exited 0 AND the package file exists
 *   · distinguishes "refused because a package already exists" (exit 3) from a failure
 *   · never prints or stores provider keys (they stay in the child environment)
 *   · no retries invented here: the Python engine owns its own bounded repair loop
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolvePython, spawnCapture, type SpawnResult } from './pipelineGenerator.js';

export interface PythonSeoGeneratorOptions {
  /** Repository root containing `scripting/`. */
  repoRoot: string;
  /** Root that contains `<projectId>/pipeline.json` (defaults to `<repoRoot>/scripting/projects`). */
  projectsRoot?: string;
  /** Python executable; defaults to the project venv then `python`. */
  pythonPath?: string;
  /** Extra environment for the child (merged over process.env). Never logged. */
  env?: Record<string, string>;
  /** Hard cap on the child process duration (generation includes bounded repair attempts). */
  timeoutMs?: number;
  /** Injectable spawn (tests use a fake; production uses `spawnCapture`). */
  spawn?: (command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<SpawnResult>;
}

export interface SeoRequest {
  /** Project id; used to resolve `<projectsRoot>/<projectId>/pipeline.json` when no path is given. */
  projectId?: string;
  /** Explicit path to the project `pipeline.json` (wins over `projectId`). */
  projectFile?: string;
  /** Replace an existing package (the previous one is archived under `seo/history/`). */
  regenerate?: boolean;
  /** Print the extracted facts + keyword plan without calling the model. */
  extractOnly?: boolean;
  /** Record explicit human approval of `seo/youtube-metadata.json`. */
  approveMetadata?: boolean;
  /** Required with `approveMetadata`. */
  approvedBy?: string;
  /** Bounded generation attempts (1..5). Omitted = engine default. */
  maxAttempts?: number;
  /** Optional writing-model override for the Python provider client. */
  model?: string;
}

export type SeoStatus = 'CREATED' | 'REGENERATED' | 'METADATA_APPROVED' | 'EXTRACT_ONLY' | 'EXISTS' | 'FAILED';

/** Machine-readable report emitted by `python -m pipeline.seo --json`. */
export interface SeoReport {
  ok?: boolean;
  status?: string;
  project_id?: string;
  reason?: string;
  errors?: string[];
  warnings?: string[];
  package_path?: string;
  markdown_path?: string;
  metadata_path?: string;
  recommended_title?: string;
  title_candidates?: string[];
  generation?: number;
  attempts?: number;
  scenarios?: unknown;
  facts?: Record<string, unknown>;
  keyword_plan?: Record<string, unknown>;
  publisher_invoked?: boolean;
  network_used?: boolean;
  [key: string]: unknown;
}

export interface SeoResult {
  ok: boolean;
  status: SeoStatus;
  /** Raw Python CLI exit code (0 ok, 1 failure, 2 usage, 3 refused). */
  exitCode: number;
  reason?: string;
  errors: string[];
  warnings: string[];
  report?: SeoReport;
  projectId?: string;
  packagePath?: string;
  markdownPath?: string;
  metadataPath?: string;
  recommendedTitle?: string;
  titleCandidates?: string[];
  generation?: number;
  attempts?: number;
  /** Always false: this adapter has no publishing path at all. */
  publisherInvoked: false;
  /** True only when a provider call actually happened (generation, never extract-only). */
  networkUsed: boolean;
  stdout: string;
  stderr: string;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** Resolve the project file the CLI should operate on. */
export function resolveSeoProjectFile(
  request: Pick<SeoRequest, 'projectId' | 'projectFile'>,
  opts: { repoRoot: string; projectsRoot?: string },
): string {
  if (request.projectFile && request.projectFile.trim()) return path.resolve(request.projectFile);
  const id = request.projectId?.trim();
  if (!id) throw new Error('seo: pass --project <pipeline.json> or --project-id <project id>');
  if (id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error(`seo: invalid project id "${id}"`);
  }
  const root = opts.projectsRoot ?? path.join(opts.repoRoot, 'scripting', 'projects');
  return path.join(root, id, 'pipeline.json');
}

/**
 * Build the `python -m pipeline.seo` argument vector.
 *
 * `--json` is always appended so the adapter parses a structured report instead of scraping
 * human-oriented prose. `--approve-metadata` implies its own explicit `--yes`.
 */
export function buildSeoArgs(projectFile: string, request: SeoRequest = {}): string[] {
  const args = ['-m', 'pipeline.seo', '--project', projectFile, '--json'];
  if (request.approveMetadata) {
    const by = request.approvedBy?.trim();
    if (!by) throw new Error('seo: --approve-metadata requires --by <name>');
    args.push('--approve-metadata', '--yes', '--by', by);
    return args;
  }
  if (request.extractOnly) args.push('--extract-only');
  if (request.regenerate) args.push('--regenerate');
  if (typeof request.maxAttempts === 'number' && Number.isFinite(request.maxAttempts)) {
    args.push('--max-attempts', String(Math.trunc(request.maxAttempts)));
  }
  if (request.model?.trim()) args.push('--model', request.model.trim());
  return args;
}

/**
 * Parse the last complete JSON object from CLI stdout.
 *
 * The Python CLI writes exactly one JSON document with `--json`, but warnings from a provider
 * retry can be interleaved, so the parser scans for balanced objects and keeps the last one
 * that parses. Returns null instead of throwing: a missing report is handled as a failure.
 */
export function parseSeoReport(stdout: string): SeoReport | null {
  const text = String(stdout ?? '');
  let best: SeoReport | null = null;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      // Quotes in surrounding prose are not string delimiters.
      if (depth > 0) inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          const parsed = JSON.parse(text.slice(start, index + 1));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) best = parsed as SeoReport;
        } catch { /* keep scanning */ }
        start = -1;
      }
    }
  }
  return best;
}

/** Map a CLI exit code to a status when the report itself does not carry one. */
export function statusFromExit(code: number | null): SeoStatus {
  if (code === 3) return 'EXISTS';
  return 'FAILED';
}

function tail(value: string, lines = 12): string {
  return String(value ?? '').trim().split('\n').slice(-lines).join('\n');
}

/**
 * Build the production SEO runner. It never publishes, never approves on its own, and never
 * touches media: the only side effects are the files the Python engine writes under
 * `<project dir>/seo/`.
 */
export function createPythonSeoGenerator(opts: PythonSeoGeneratorOptions) {
  return async function runSeo(request: SeoRequest): Promise<SeoResult> {
    const projectFile = resolveSeoProjectFile(request, opts);
    const args = buildSeoArgs(projectFile, request);
    const python = opts.pythonPath ?? (await resolvePython(opts.repoRoot));
    const cwd = path.join(opts.repoRoot, 'scripting');
    const spawn = opts.spawn ?? spawnCapture;

    const exists = await fsp.stat(projectFile).then((stat) => stat.isFile()).catch(() => false);
    if (!exists) {
      return {
        ok: false,
        status: 'FAILED',
        exitCode: 2,
        reason: `project file not found: ${projectFile}`,
        errors: [`project file not found: ${projectFile}`],
        warnings: [],
        publisherInvoked: false,
        networkUsed: false,
        stdout: '',
        stderr: '',
      };
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(opts.env ?? {}),
      // Keep Devanagari intact through the Windows console code page.
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    };

    const result = await spawn(python, args, {
      cwd,
      env,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    const report = parseSeoReport(result.stdout) ?? undefined;
    const exitCode = result.code ?? 1;
    const status: SeoStatus =
      report?.status === 'CREATED' || report?.status === 'REGENERATED'
        || report?.status === 'METADATA_APPROVED' || report?.status === 'EXTRACT_ONLY'
        || report?.status === 'EXISTS'
        ? (report.status as SeoStatus)
        : statusFromExit(result.code);

    const errors = Array.isArray(report?.errors) ? report!.errors.map(String) : [];
    const warnings = Array.isArray(report?.warnings) ? report!.warnings.map(String) : [];
    const reason = report?.reason ? String(report.reason)
      : exitCode === 0 ? undefined
        : tail(result.stderr || result.stdout) || `python exited with code ${result.code ?? 'null'}${result.timedOut ? ' (timed out)' : ''}`;

    const base: SeoResult = {
      ok: false,
      status,
      exitCode,
      reason,
      errors,
      warnings,
      report,
      projectId: report?.project_id ? String(report.project_id) : (request.projectId ?? path.basename(path.dirname(projectFile))),
      packagePath: report?.package_path ? String(report.package_path) : undefined,
      markdownPath: report?.markdown_path ? String(report.markdown_path) : undefined,
      metadataPath: report?.metadata_path ? String(report.metadata_path) : undefined,
      recommendedTitle: report?.recommended_title ? String(report.recommended_title) : undefined,
      titleCandidates: Array.isArray(report?.title_candidates) ? report!.title_candidates!.map(String) : undefined,
      generation: typeof report?.generation === 'number' ? report.generation : undefined,
      attempts: typeof report?.attempts === 'number' ? report.attempts : undefined,
      publisherInvoked: false,
      networkUsed: Boolean(report?.network_used),
      stdout: result.stdout,
      stderr: result.stderr,
    };

    if (exitCode !== 0 || report?.ok === false) {
      if (!base.reason) base.reason = 'SEO generation failed';
      return base;
    }

    // Success is only claimed when the artefact the CLI claims to have written exists.
    const needsPackage = status === 'CREATED' || status === 'REGENERATED';
    const needsMetadata = status === 'METADATA_APPROVED';
    if (needsPackage || needsMetadata) {
      const requiredPath = needsPackage ? base.packagePath : base.metadataPath;
      const label = needsPackage ? 'package' : 'metadata mapping';
      const existsOnDisk = requiredPath
        ? await fsp.stat(requiredPath).then((stat) => stat.isFile()).catch(() => false)
        : false;
      if (!existsOnDisk) {
        return {
          ...base,
          ok: false,
          status: 'FAILED',
          reason: `CLI reported ${status} but no ${label} exists at ${requiredPath ?? '(unknown path)'}`,
        };
      }
    }

    return { ...base, ok: true };
  };
}

export type SeoGenerator = ReturnType<typeof createPythonSeoGenerator>;
