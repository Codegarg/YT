/**
 * Production Flow session lifecycle (STEP-8GO).
 *
 * The ONE owner of the interactive browser/client lifecycle for Flow scene work:
 *
 *   projectWorkflow (explicit --run-flow)
 *     → withFlowSession()            ← acquires the EXISTING 8GK Flow session lock
 *         → createRealFlowSession()  ← reuses the EXISTING `start()` browser/profile lifecycle
 *             → FlowClient           ← the real existing client
 *         → consumer (SceneExecutor → processSingleFlowScene)
 *       → close()                    ← closes the browser context exactly once
 *     → lock released
 *
 * Non-responsibilities (never duplicated here):
 *   selectors, Flow operations, generation policy, retry/backoff, checkpoint schema, downloads.
 *
 * There is exactly ONE Flow session lock (8GK `withFlowSessionLock`) and ONE browser launcher
 * (the existing `start()`). This module only composes them.
 */
import { withFlowSessionLock, acquireFlowSessionLock, type LockHandle } from './projectOrchestrator.js';

/** Explicit session handle. `client` is the real existing FlowClient. */
export interface FlowSession {
  client: any;
  /** Close the browser/context exactly once. Never throws into a caller's primary path. */
  close(): Promise<void>;
}

/** The raw lifecycle object the existing `start()` returns. */
export interface RawFlowSession {
  context: { close(): Promise<void> };
  page?: any;
  flow: any;
}

export interface CreateRealFlowSessionOptions {
  /** Flow URL (defaults to the production CLI's FLOW_URL or flow.google.com). */
  url?: string;
  /** Persistent authenticated profile directory. */
  userDataDir: string;
  log?: (event: string, data?: Record<string, unknown>) => void;
  /**
   * Lifecycle launcher. Defaults to the EXISTING `start()` from flowClient.ts. Injectable so
   * tests can supply a fake without Playwright/Chrome.
   */
  start?: (url: string, userDataDir: string, log: (e: string, d?: any) => void) => Promise<RawFlowSession>;
}

/** Execute the existing browser lifecycle. Loaded lazily so tests never touch Playwright. */
async function defaultStart(url: string, userDataDir: string, log: (e: string, d?: any) => void): Promise<RawFlowSession> {
  const mod = await import('./flowClient.js');
  return mod.start(url, userDataDir, log);
}

/**
 * Create a Flow session using the existing browser/profile lifecycle. Ownership of the
 * browser context is transferred to the returned session; callers MUST call `close()`.
 * Construction failure propagates (fail closed) — no partial session is exposed.
 */
export async function createRealFlowSession(opts: CreateRealFlowSessionOptions): Promise<FlowSession> {
  const url = String(opts.url ?? process.env.FLOW_URL ?? 'https://flow.google.com');
  const userDataDir = String(opts.userDataDir ?? '').trim();
  if (!userDataDir) throw new Error('createRealFlowSession requires a userDataDir (authenticated Flow profile).');
  const log = opts.log ?? (() => {});
  const start = opts.start ?? defaultStart;

  const raw = await start(url, userDataDir, log as (e: string, d?: any) => void);
  if (!raw || !raw.context) throw new Error('Flow session start() returned no browser context.');

  let closed = false;
  return {
    client: raw.flow,
    async close() {
      if (closed) return; // idempotent — never close twice
      closed = true;
      await raw.context.close();
    },
  };
}

export interface WithFlowSessionOptions extends CreateRealFlowSessionOptions {
  /** Flow session lock root (shared Chrome/Flow). */
  lockRoot: string;
  host?: string;
  pidAlive?: (pid: number) => Promise<boolean>;
  staleAfterMs?: number;
}

export interface WithFlowSessionResult<T> {
  ok: boolean;
  value?: T;
  reason?: string;
  /** Present when the underlying consumer threw (structured, never a raw exception). */
  error?: string;
}

/**
 * Run `fn` inside the EXISTING Flow session lock with a real session, closing the session and
 * releasing the lock on EVERY path (success, expected failure, thrown exception).
 *
 * Error semantics:
 *   · lock unavailable            → ok:false, no session created, nothing to close
 *   · session creation failure    → ok:false, no session exposed
 *   · consumer throws             → ok:false with the consumer error
 *   · close() throws              → surfaced as `reason` ONLY when the consumer succeeded;
 *                                   never masks an existing consumer failure
 */
export async function withFlowSession<T>(
  opts: WithFlowSessionOptions,
  fn: (session: FlowSession) => Promise<T>,
): Promise<WithFlowSessionResult<T>> {
  // Acquire the ONE existing Flow session lock (never a second one).
  const acquired = await acquireFlowSessionLock({ lockRoot: opts.lockRoot, host: opts.host, pidAlive: opts.pidAlive, staleAfterMs: opts.staleAfterMs });
  if (!acquired.ok) return { ok: false, reason: acquired.reason };
  const lock: LockHandle | { release(): Promise<void> } = acquired;

  let session: FlowSession | undefined;
  try {
    session = await createRealFlowSession(opts);
  } catch (e: any) {
    await lock.release().catch(() => {});
    return { ok: false, reason: `Flow session creation failed: ${String(e?.message ?? e).slice(0, 200)}` };
  }

  let value: T | undefined;
  let primaryError: string | undefined;
  let closeError: string | undefined;
  try {
    value = await fn(session);
  } catch (e: any) {
    primaryError = String(e?.message ?? e).slice(0, 300);
  } finally {
    try { await session.close(); } catch (e: any) { closeError = String(e?.message ?? e).slice(0, 200); }
    await lock.release().catch(() => {});
  }

  if (primaryError) return { ok: false, reason: primaryError, error: primaryError };
  if (closeError) return { ok: false, reason: `Flow session close failed: ${closeError}` };
  return { ok: true, value };
}

/** Re-exported for callers that need the raw lock without a session (e.g. FlowRunner). */
export { withFlowSessionLock, acquireFlowSessionLock };
