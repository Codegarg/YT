/**
 * Story → pipeline adapter (STEP-8GL).
 *
 * Thin boundary over the EXISTING scripting pipeline (`scripting/pipeline/one_minute.py`).
 * It shells out to the Python CLI rather than importing Python internals, because the CLI
 * is the stable, already-supported entrypoint. No story-generation logic is duplicated here.
 *
 * Guarantees:
 *   · captures exit code + stdout/stderr
 *   · detects the generated pipeline path and verifies it exists
 *   · never claims success when generation failed
 *   · never overwrites an existing project
 *   · no retries, no provider fallback invented here (the Python client owns provider policy)
 *
 * The provider key (OPENAI_API_KEY / GROQ_API_KEY) is read from the process environment; the
 * adapter never stores it and never prints it.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { PipelineGenerator } from './projectWorkflow.js';

export interface PythonPipelineGeneratorOptions {
  /** Repository root containing `scripting/`. */
  repoRoot: string;
  /** Python executable; defaults to the project venv then `python`. */
  pythonPath?: string;
  /** Extra environment for the child (merged over process.env). Never logged. */
  env?: Record<string, string>;
  /** Hard cap on the child process duration. */
  timeoutMs?: number;
}

/** Locate the best Python launcher for a repo (venv first, then PATH). */
export async function resolvePython(repoRoot: string): Promise<string> {
  const venv = path.join(repoRoot, 'scripting', '.venv', 'Scripts', 'python.exe');
  if (await fsp.stat(venv).then((s) => s.isFile()).catch(() => false)) return venv;
  const venvPosix = path.join(repoRoot, 'scripting', '.venv', 'bin', 'python');
  if (await fsp.stat(venvPosix).then((s) => s.isFile()).catch(() => false)) return venvPosix;
  return 'python';
}

export interface SpawnResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; }

/** Run a child process, capturing output. Never throws on non-zero exit. */
export function spawnCapture(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* ignore */ } }, opts.timeoutMs) : null;
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr + String(e?.message ?? e), timedOut }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

/**
 * Build a production `PipelineGenerator` that runs `python -m pipeline.one_minute`.
 * The generated pipeline path is derived canonically; existence is verified.
 */
export function createPythonPipelineGenerator(opts: PythonPipelineGeneratorOptions): PipelineGenerator {
  return async (input) => {
    const python = opts.pythonPath ?? (await resolvePython(opts.repoRoot));
    const scriptingDir = path.join(opts.repoRoot, 'scripting');
    // Refuse to overwrite an existing pipeline (CREATE safety).
    if (await fsp.stat(input.pipelineFile).then((s) => s.isFile()).catch(() => false)) {
      throw new Error(`Refusing to overwrite existing pipeline: ${input.pipelineFile}`);
    }
    const args = ['-m', 'pipeline.one_minute', '--project-id', input.projectId, '--title', input.title];
    if (input.concept) args.push('--concept', input.concept);
    if (typeof input.durationMinutes === 'number') args.push('--duration', String(input.durationMinutes));
    if (typeof input.scenes === 'number' && input.scenes > 0) args.push('--scenes', String(input.scenes));
    if (input.model) args.push('--model', input.model);

    const env = { ...process.env, ...(opts.env ?? {}) };
    const res = await spawnCapture(python, args, { cwd: scriptingDir, env, timeoutMs: opts.timeoutMs ?? 6 * 60 * 60 * 1000 });
    const exists = await fsp.stat(input.pipelineFile).then((s) => s.isFile()).catch(() => false);
    if (res.code !== 0 || !exists) {
      const tail = (res.stderr || res.stdout || '').trim().split('\n').slice(-8).join('\n');
      throw new Error(`story generation failed (exit ${res.code ?? 'null'}${res.timedOut ? ', timed out' : ''}). ${tail}`.slice(0, 600));
    }
    return { pipelineFile: input.pipelineFile };
  };
}
