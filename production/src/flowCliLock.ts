/**
 * Flow CLI session-lock handshake (STEP-QA-2).
 *
 * There is exactly ONE shared Flow/Chrome session lock. Two callers exist:
 *
 *   1. STANDALONE `npm run flow` — nobody holds the lock, so the CLI must acquire it.
 *   2. SUBPROCESS of the canonical workflow — `flowRunnerAdapter` already holds the lock for
 *      the whole session and then spawns `npm run flow`. Re-acquiring it in the child would
 *      either refuse (the parent is alive) or, at best, be a redundant round-trip.
 *
 * The lock is intentionally NOT reentrant across processes, so the parent passes
 * `FLOW_SESSION_LOCK_HELD=1` to the child. This module owns that flag name and the two
 * decisions derived from it, so neither the CLI nor the adapter can drift.
 *
 * It performs no I/O and never inspects the lock file: the adapter is the only writer of the
 * flag, and an absent flag means "acquire", which is the safe default.
 */
import path from 'node:path';

/** Environment flag set by the process that already holds the shared Flow session lock. */
export const FLOW_SESSION_LOCK_HELD_ENV = 'FLOW_SESSION_LOCK_HELD';

/** True when the CLI must acquire the lock itself (standalone invocation). */
export function flowCliShouldAcquireLock(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env[FLOW_SESSION_LOCK_HELD_ENV] ?? '').trim() !== '1';
}

/**
 * Lock root for a standalone CLI run. Mirrors `createRealFlowRunner`'s default (`productionDir`,
 * i.e. the directory `npm run flow` is invoked from). `FLOW_LOCK_ROOT` is an explicit override
 * for non-standard layouts; it is never required.
 */
export function flowCliLockRoot(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const override = String(env.FLOW_LOCK_ROOT ?? '').trim();
  return path.resolve(override || cwd);
}

/**
 * Child environment for `npm run flow` spawned by `flowRunnerAdapter`. PURE so the handshake is
 * testable without spawning a browser or a subprocess.
 */
export function flowSubprocessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, [FLOW_SESSION_LOCK_HELD_ENV]: '1' };
}
