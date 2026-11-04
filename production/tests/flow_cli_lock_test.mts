// Offline regression tests for the Flow CLI <-> flowRunnerAdapter session-lock handshake.
// No Chrome, no Flow, no network, no browser launch. Temp lock root only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SRC } from './_testPaths.mjs';

const LOCK = await import(pathToFileURL(`${SRC}/flowCliLock.ts`).href);
const PO = await import(pathToFileURL(`${SRC}/projectOrchestrator.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

// ================== pure handshake ==================
check('standalone CLI (no flag) acquires the lock', LOCK.flowCliShouldAcquireLock({}) === true);
check('child of the canonical workflow (flag=1) does NOT re-acquire', LOCK.flowCliShouldAcquireLock({ [LOCK.FLOW_SESSION_LOCK_HELD_ENV]: '1' }) === false);
check('a malformed flag is not trusted (acquire is the safe default)', LOCK.flowCliShouldAcquireLock({ [LOCK.FLOW_SESSION_LOCK_HELD_ENV]: 'true' }) === true);
check('empty flag value is not trusted', LOCK.flowCliShouldAcquireLock({ [LOCK.FLOW_SESSION_LOCK_HELD_ENV]: '' }) === true);

check('lock root defaults to the invocation directory (productionDir parity)', LOCK.flowCliLockRoot({}, 'C:/repo/production') === path.resolve('C:/repo/production'));
check('lock root honours an explicit FLOW_LOCK_ROOT override', LOCK.flowCliLockRoot({ FLOW_LOCK_ROOT: 'C:/shared/lock' }, 'C:/repo/production') === path.resolve('C:/shared/lock'));

const childEnv = LOCK.flowSubprocessEnv({ PATH: 'x', FLOW_SESSION_LOCK_HELD: '0' });
check('child env sets the held flag to exactly "1"', childEnv[LOCK.FLOW_SESSION_LOCK_HELD_ENV] === '1');
check('child env preserves the parent environment', childEnv.PATH === 'x');
check('child env does not mutate the parent environment', (() => { const parent = { PATH: 'y' }; LOCK.flowSubprocessEnv(parent); return parent.FLOW_SESSION_LOCK_HELD === undefined; })());

// ================== the lock is genuinely non-reentrant ==================
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowlock-'));
try {
  const lockRoot = path.join(tmp, 'production');
  fs.mkdirSync(lockRoot, { recursive: true });
  const parent = await PO.acquireFlowSessionLock({ lockRoot });
  check('parent acquires the single session lock', parent.ok === true, parent);

  const second = await PO.acquireFlowSessionLock({ lockRoot });
  check('a second holder is refused while the parent lives (why the child flag exists)', second.ok === false, second);

  let ran = 0;
  let refusal = '';
  try {
    await PO.withFlowSessionLock({ lockRoot }, async () => { ran++; });
  } catch (error) {
    refusal = String((error as any)?.message ?? error);
  }
  check('withFlowSessionLock refuses to re-enter a held lock', ran === 0 && /withFlowSessionLock refused/.test(refusal), { ran, refusal });

  if (parent.ok) await parent.release();
  const after = await PO.acquireFlowSessionLock({ lockRoot });
  check('lock is released cleanly and reusable', after.ok === true, after);
  if (after.ok) await after.release();
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ================== wiring invariants (source-level, no execution) ==================
const cli = fs.readFileSync(`${SRC}/cli.ts`, 'utf8');
check('cli imports the canonical session lock', /import \{ withFlowSessionLock \} from '\.\/projectOrchestrator\.js'/.test(cli));
check('cli imports the shared handshake module', /flowCliShouldAcquireLock, flowCliLockRoot/.test(cli) && /from '\.\/flowCliLock\.js'/.test(cli));
check('browser start happens inside the guarded session function', cli.indexOf('async function runFlowSession') >= 0 && cli.indexOf('async function runFlowSession') < cli.indexOf('await start(url,profile,log)'));
check('the guarded function is the ONLY thing the lock wraps', /withFlowSessionLock\(\{ lockRoot: flowCliLockRoot\(\) \}, runFlowSession\)/.test(cli));
check('standalone runs still take the lock branch', /if \(flowCliShouldAcquireLock\(\)\)/.test(cli));

const adapter = fs.readFileSync(`${SRC}/flowRunnerAdapter.ts`, 'utf8');
check('adapter passes the held-flag environment to the child', /spawnCapture\(npm, args, \{ cwd: productionDir, env: flowSubprocessEnv\(\) \}\)/.test(adapter));
check('adapter still holds the lock around the child run', /withFlowSessionLock\(\{ lockRoot \}, async \(\) =>/.test(adapter));

console.log(`\nFLOW-CLI-LOCK TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
