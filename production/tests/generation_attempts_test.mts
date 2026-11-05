// Offline tests for the bounded, persistent Flow generation-attempt ledger (PHASE 2).
// No Chrome, no Playwright, no Flow, no network, no credits. Temp fixtures only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';

const GA = await import(pathToFileURL(`${SRC}/generationAttempts.ts`).href);
const WF = await import(pathToFileURL(`${SRC}/sceneFlowWorkflow.ts`).href);

const {
  DEFAULT_GENERATION_POLICY, GENERATION_ATTEMPT_SCHEMA_VERSION, GENERATION_HISTORY_LIMIT,
  resolveGenerationPolicy, policyFromEnv, approvalFromEnv, approvalCovers,
  emptyGenerationLedger, validateGenerationLedger, generationLedgerPath,
  resolveLegacyGenerationLedgerPath, readGenerationLedger, writeGenerationLedger,
  classifyGenerationFailure, createSubmissionProbe, decideGenerationAttempt,
  beginBoundedGeneration, finishBoundedGeneration, releaseBoundedGeneration,
  renderGenerationHistory, subjectKey, subjectAttemptLimit,
} = GA;

let passed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const sceneSubject = (n: number) => ({ kind: 'scene', id: String(n), sceneNumber: n });
const assetSubject = (id: string) => ({ kind: 'character', id });

// The workflow paths read the REAL environment; keep this test independent of an operator's shell.
for (const name of [
  'FLOW_APPROVE_GENERATION_RECOVERY', 'FLOW_APPROVE_GENERATION_RECOVERY_SCENES',
  'FLOW_MAX_ATTEMPTS_PER_SCENE', 'FLOW_MAX_ATTEMPTS_PER_ASSET', 'FLOW_MAX_ATTEMPTS_PER_PROJECT',
  'FLOW_MAX_CONSECUTIVE_FAILURES', 'FLOW_REQUIRE_APPROVAL_AFTER_AMBIGUOUS', 'FLOW_ATTEMPT_LOCK_STALE_MINUTES',
]) delete process.env[name];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-attempts-'));

// ------------------------------------------------------------------ 1. policy defaults
check('default per-scene budget is 2', DEFAULT_GENERATION_POLICY.maxAttemptsPerScene === 2, DEFAULT_GENERATION_POLICY);
check('default per-asset budget is 2', DEFAULT_GENERATION_POLICY.maxAttemptsPerAsset === 2);
check('default per-project budget is 80', DEFAULT_GENERATION_POLICY.maxAttemptsPerProject === 80);
check('default consecutive-failure stop is 2', DEFAULT_GENERATION_POLICY.maxConsecutiveFailures === 2);
check('default ambiguous approval is required', DEFAULT_GENERATION_POLICY.requireApprovalAfterAmbiguous === true);
check('default active-attempt window is 30 minutes', DEFAULT_GENERATION_POLICY.activeAttemptStaleMs === 30 * 60 * 1000);
check('policy with no overrides equals the defaults',
  JSON.stringify(resolveGenerationPolicy(undefined)) === JSON.stringify(DEFAULT_GENERATION_POLICY));
check('env with no variables equals the defaults',
  JSON.stringify(policyFromEnv({})) === JSON.stringify(DEFAULT_GENERATION_POLICY));
check('an invalid env budget falls back to the default (never disables the budget)',
  policyFromEnv({ FLOW_MAX_ATTEMPTS_PER_SCENE: '0' }).maxAttemptsPerScene === 2
  && policyFromEnv({ FLOW_MAX_ATTEMPTS_PER_SCENE: 'abc' }).maxAttemptsPerScene === 2
  && policyFromEnv({ FLOW_MAX_ATTEMPTS_PER_SCENE: '-3' }).maxAttemptsPerScene === 2);
check('explicit env budgets are honoured',
  policyFromEnv({ FLOW_MAX_ATTEMPTS_PER_SCENE: '3', FLOW_MAX_ATTEMPTS_PER_ASSET: '4', FLOW_MAX_ATTEMPTS_PER_PROJECT: '120' }).maxAttemptsPerScene === 3
  && policyFromEnv({ FLOW_MAX_ATTEMPTS_PER_ASSET: '4' }).maxAttemptsPerAsset === 4
  && policyFromEnv({ FLOW_MAX_ATTEMPTS_PER_PROJECT: '120' }).maxAttemptsPerProject === 120);
check('FLOW_ATTEMPT_LOCK_STALE_MINUTES is converted to milliseconds',
  policyFromEnv({ FLOW_ATTEMPT_LOCK_STALE_MINUTES: '10' }).activeAttemptStaleMs === 10 * 60 * 1000);
check('subject limits follow the subject kind',
  subjectAttemptLimit(sceneSubject(4), DEFAULT_GENERATION_POLICY) === 2
  && subjectAttemptLimit(assetSubject('x'), DEFAULT_GENERATION_POLICY) === 2);

// ---------------------------------------------------------------- 2. approval surface
check('no approval by default', approvalFromEnv({}).mode === 'NONE');
check('FLOW_APPROVE_GENERATION_RECOVERY=1 approves the project', approvalFromEnv({ FLOW_APPROVE_GENERATION_RECOVERY: '1' }).mode === 'PROJECT');
check('a non-1 project flag is not approval', approvalFromEnv({ FLOW_APPROVE_GENERATION_RECOVERY: 'true' }).mode === 'PROJECT'
  && approvalFromEnv({ FLOW_APPROVE_GENERATION_RECOVERY: 'yes' }).mode === 'PROJECT'
  && approvalFromEnv({ FLOW_APPROVE_GENERATION_RECOVERY: '0' }).mode === 'NONE');
check('FLOW_APPROVE_GENERATION_RECOVERY_SCENES is parsed, de-duplicated and sorted',
  JSON.stringify(approvalFromEnv({ FLOW_APPROVE_GENERATION_RECOVERY_SCENES: ' 7, 3 ,7, x,0 ' })) === JSON.stringify({ mode: 'SCENES', scenes: [3, 7] }));
check('scene-scoped approval takes precedence over project-wide',
  approvalFromEnv({ FLOW_APPROVE_GENERATION_RECOVERY: '1', FLOW_APPROVE_GENERATION_RECOVERY_SCENES: '5' }).mode === 'SCENES');
check('project approval covers scenes and assets', approvalCovers({ mode: 'PROJECT' }, sceneSubject(9)) && approvalCovers({ mode: 'PROJECT' }, assetSubject('x')));
check('scene approval covers exactly the listed scenes', approvalCovers({ mode: 'SCENES', scenes: [3, 7] }, sceneSubject(3))
  && !approvalCovers({ mode: 'SCENES', scenes: [3, 7] }, sceneSubject(4))
  && !approvalCovers({ mode: 'SCENES', scenes: [3, 7] }, assetSubject('x')));
check('no approval covers nothing', !approvalCovers({ mode: 'NONE' }, sceneSubject(1)) && !approvalCovers(null, sceneSubject(1)));

// ------------------------------------------------------------ 3. failure classification
check('a network error proven not submitted is RETRYABLE/NOT_SUBMITTED', (() => {
  const c = classifyGenerationFailure({ error: new Error('net::ERR_CONNECTION_RESET while loading'), submitted: false });
  return c.category === 'RETRYABLE' && c.submission === 'NOT_SUBMITTED';
})());
check('a timeout proven not submitted is RETRYABLE', (() => {
  const c = classifyGenerationFailure({ error: new Error('navigation timeout of 30000 ms exceeded'), submitted: false });
  return c.category === 'RETRYABLE' && c.submission === 'NOT_SUBMITTED';
})());
check('a browser timeout with UNKNOWN submission is NOT retryable (fail closed)', (() => {
  const c = classifyGenerationFailure({ error: new Error('Timeout 15000ms exceeded'), submitted: 'unknown' });
  return c.category === 'UNKNOWN' && c.submission === 'SUBMISSION_UNKNOWN';
}, 'a timeout may hide a click that already landed'));
check('a browser timeout AFTER submission is UNKNOWN/SUBMITTED_CONFIRMED', (() => {
  const c = classifyGenerationFailure({ error: new Error('Target page, context or browser has been closed'), submitted: true });
  return c.category === 'UNKNOWN' && c.submission === 'SUBMITTED_CONFIRMED';
})());
check('a refusal before the click is NON_RETRYABLE/NOT_SUBMITTED', (() => {
  const c = classifyGenerationFailure({ error: new Error('generateProjectVideo requires a non-empty prompt.'), submitted: 'unknown' });
  return c.category === 'NON_RETRYABLE' && c.submission === 'NOT_SUBMITTED';
})());
check('an authorization refusal is NON_RETRYABLE', (() => {
  const c = classifyGenerationFailure({ error: new Error('GENERATION_NOT_AUTHORIZED: scene-local generation requires explicit approval'), submitted: false });
  return c.category === 'NON_RETRYABLE';
})());
check('an unrecognised error with unknown submission is UNKNOWN (not retryable)', (() => {
  const c = classifyGenerationFailure({ error: new Error('something unexpected happened'), submitted: 'unknown' });
  return c.category === 'UNKNOWN' && c.submission === 'SUBMISSION_UNKNOWN';
})());
check('the failure reason is bounded and whitespace-normalised', (() => {
  const c = classifyGenerationFailure({ error: new Error('  a\n\n  b\t'.repeat(400)), submitted: false });
  return c.reason.length <= 500 && !/\n/.test(c.reason);
})());

// -------------------------------------------------------- 4. submission probe (latch)
check('a client without the latch reports "unknown" (never "not submitted")', (() => {
  const probe = createSubmissionProbe({});
  return probe.read() === 'unknown';
})());
check('a throwing latch reports "unknown"', (() => {
  const probe = createSubmissionProbe({ getGenerationSubmissionState() { throw new Error('boom'); } });
  return probe.read() === 'unknown';
})());
check('the probe observes a monotonic latch transition', (() => {
  let state = { submitted: false, at: null as string | null };
  const client = { getGenerationSubmissionState: () => ({ ...state }) };
  const probe = createSubmissionProbe(client);
  const before = probe.read();
  state = { submitted: true, at: '2026-11-05T00:00:00.000Z' };
  const after = probe.read();
  return before === false && after === true;
})());
check('a second submission inside the same millisecond is still observed', (() => {
  let state = { submitted: true, at: '2026-11-05T00:00:00.000Z' };
  const probe = createSubmissionProbe({ getGenerationSubmissionState: () => ({ ...state }) });
  const before = probe.read();
  state = { submitted: true, at: '2026-11-05T00:00:00.001Z' };
  return before === false && probe.read() === true;
})());

// ------------------------------------------------------------- 5. pure decision matrix
const ledgerWithSubject = (state: any, projectAttempts = 1) => {
  const ledger = emptyGenerationLedger('p');
  ledger.project_attempts = projectAttempts;
  ledger.subjects[subjectKey(sceneSubject(1))] = {
    subject_kind: 'scene', subject_id: '1', scene_number: 1, attempts: 0, consecutive_failures: 0,
    last_outcome: null, last_failure_category: 'NONE', last_submission: null, last_attempt_at: null,
    manual_approval: 'NOT_REQUIRED', ...state,
  };
  return ledger;
};
const decide = (ledger: any, over: any = {}) => decideGenerationAttempt({
  ledger, projectId: 'p', subject: sceneSubject(1), policy: DEFAULT_GENERATION_POLICY, ...over,
});

check('no history -> first attempt allowed', (() => {
  const d = decide(emptyGenerationLedger('p'));
  return d.action === 'ALLOW' && d.code === 'ALLOWED' && d.attemptNumber === 1;
})());
check('a previous SUCCESS leaves a fresh attempt allowed within budget', (() => {
  const d = decide(ledgerWithSubject({ attempts: 1, last_outcome: 'SUCCEEDED', last_failure_category: 'NONE', last_submission: 'SUBMITTED_CONFIRMED' }));
  return d.action === 'ALLOW';
})());
check('a retryable pre-submit failure retries automatically inside the budget', (() => {
  const d = decide(ledgerWithSubject({ attempts: 1, consecutive_failures: 1, last_outcome: 'FAILED', last_failure_category: 'RETRYABLE', last_submission: 'NOT_SUBMITTED' }));
  return d.action === 'ALLOW' && d.code === 'ALLOWED';
})());
check('an ambiguous (UNKNOWN) failure requires manual approval', (() => {
  const d = decide(ledgerWithSubject({ attempts: 1, consecutive_failures: 1, last_outcome: 'FAILED', last_failure_category: 'UNKNOWN', last_submission: 'SUBMISSION_UNKNOWN' }));
  return d.action === 'DENY' && d.code === 'MANUAL_APPROVAL_REQUIRED';
})());
check('a SUBMITTED failure requires manual approval', (() => {
  const d = decide(ledgerWithSubject({ attempts: 1, consecutive_failures: 1, last_outcome: 'FAILED', last_failure_category: 'RETRYABLE', last_submission: 'SUBMITTED_CONFIRMED' }));
  return d.action === 'DENY' && d.code === 'MANUAL_APPROVAL_REQUIRED';
})());
check('a NON_RETRYABLE failure requires manual approval', (() => {
  const d = decide(ledgerWithSubject({ attempts: 1, consecutive_failures: 1, last_outcome: 'FAILED', last_failure_category: 'NON_RETRYABLE', last_submission: 'NOT_SUBMITTED' }));
  return d.action === 'DENY' && d.code === 'MANUAL_APPROVAL_REQUIRED';
})());
check('a crashed (IN_PROGRESS) attempt requires manual approval', (() => {
  const d = decide(ledgerWithSubject({ attempts: 1, consecutive_failures: 0, last_outcome: 'IN_PROGRESS', last_failure_category: 'NONE', last_submission: 'SUBMISSION_UNKNOWN' }));
  return d.action === 'DENY' && d.code === 'MANUAL_APPROVAL_REQUIRED';
})());
check('too many consecutive failures require manual approval', (() => {
  const d = decide(ledgerWithSubject({ attempts: 1, consecutive_failures: 2, last_outcome: 'FAILED', last_failure_category: 'RETRYABLE', last_submission: 'NOT_SUBMITTED' }));
  return d.action === 'DENY' && d.code === 'MANUAL_APPROVAL_REQUIRED';
})());
check('explicit approval allows exactly one recovery attempt', (() => {
  const d = decide(ledgerWithSubject({ attempts: 1, consecutive_failures: 1, last_outcome: 'FAILED', last_failure_category: 'UNKNOWN', last_submission: 'SUBMISSION_UNKNOWN' }), { approval: { mode: 'PROJECT' } });
  return d.action === 'ALLOW' && d.code === 'APPROVED_RECOVERY' && d.attemptNumber === 2;
})());
check('scene-scoped approval only unblocks the approved scene', (() => {
  const ledger = ledgerWithSubject({ attempts: 1, consecutive_failures: 1, last_outcome: 'FAILED', last_failure_category: 'UNKNOWN', last_submission: 'SUBMISSION_UNKNOWN' });
  return decide(ledger, { approval: { mode: 'SCENES', scenes: [1] } }).action === 'ALLOW'
    && decide(ledger, { approval: { mode: 'SCENES', scenes: [2] } }).action === 'DENY';
})());
check('approval NEVER raises the per-scene ceiling', (() => {
  const d = decide(ledgerWithSubject({ attempts: 2, consecutive_failures: 1, last_outcome: 'FAILED', last_failure_category: 'UNKNOWN', last_submission: 'SUBMISSION_UNKNOWN' }, 2), { approval: { mode: 'PROJECT' } });
  return d.action === 'DENY' && d.code === 'SUBJECT_BUDGET_EXHAUSTED';
})());
check('approval NEVER raises the per-project ceiling', (() => {
  const ledger = ledgerWithSubject({ attempts: 1 }, DEFAULT_GENERATION_POLICY.maxAttemptsPerProject);
  const d = decide(ledger, { approval: { mode: 'PROJECT' } });
  return d.action === 'DENY' && d.code === 'PROJECT_BUDGET_EXHAUSTED';
})());
check('a corrupt ledger fails closed without approval', (() => {
  const d = decideGenerationAttempt({ ledger: null, ledgerCorrupt: true, projectId: 'p', subject: sceneSubject(1), policy: DEFAULT_GENERATION_POLICY });
  return d.action === 'DENY' && d.code === 'LEDGER_CORRUPT';
})());
check('a corrupt ledger is only survivable with explicit approval', (() => {
  const d = decideGenerationAttempt({ ledger: null, ledgerCorrupt: true, projectId: 'p', subject: sceneSubject(1), policy: DEFAULT_GENERATION_POLICY, approval: { mode: 'PROJECT' } });
  return d.action === 'ALLOW' && d.code === 'APPROVED_RECOVERY';
})());
check('a ledger from a DIFFERENT project is refused, even with approval', (() => {
  const other = emptyGenerationLedger('other');
  const d = decideGenerationAttempt({ ledger: other, projectId: 'p', subject: sceneSubject(1), policy: DEFAULT_GENERATION_POLICY, approval: { mode: 'PROJECT' } });
  return d.action === 'DENY' && d.code === 'LEDGER_PROJECT_MISMATCH';
})());
check('the ambiguity flag can never weaken the fail-closed rule', (() => {
  const policy = { ...DEFAULT_GENERATION_POLICY, requireApprovalAfterAmbiguous: false };
  const d = decide(ledgerWithSubject({ attempts: 1, consecutive_failures: 1, last_outcome: 'FAILED', last_failure_category: 'UNKNOWN', last_submission: 'SUBMISSION_UNKNOWN' }), { policy });
  return d.action === 'DENY' && d.code === 'MANUAL_APPROVAL_REQUIRED';
})());

// ------------------------------------------------------- 6. ledger validation / corruption
check('schema version is pinned', GENERATION_ATTEMPT_SCHEMA_VERSION === 1);
check('a fresh ledger validates', validateGenerationLedger(emptyGenerationLedger('p'), { projectId: 'p' }).ok === true);
check('an unknown schema is corrupt', validateGenerationLedger({ ...emptyGenerationLedger('p'), schema_version: 99 }, { projectId: 'p' }).ok === false);
check('a project mismatch is corrupt', validateGenerationLedger(emptyGenerationLedger('p'), { projectId: 'other' }).ok === false);
check('secret material is corrupt (blob URL)', validateGenerationLedger({ ...emptyGenerationLedger('p'), note: 'blob:https://flow.google.com/x' }, { projectId: 'p' }).ok === false);
check('secret material is corrupt (cookie)', validateGenerationLedger({ ...emptyGenerationLedger('p'), note: 'Cookie: SID=abc' }, { projectId: 'p' }).ok === false);
check('an invalid attempt record is corrupt', (() => {
  const ledger = emptyGenerationLedger('p');
  (ledger.attempts as any[]).push({ attempt_id: 'x' });
  return validateGenerationLedger(ledger, { projectId: 'p' }).ok === false;
})());
{
  let rejected = false;
  try {
    await writeGenerationLedger(path.join(tmp, 'invalid-out.json'), { ...emptyGenerationLedger('p'), schema_version: 42 } as any);
  } catch { rejected = true; }
  check('an invalid ledger is refused before any byte is written', rejected && !fs.existsSync(path.join(tmp, 'invalid-out.json')));
}

// ------------------------------------------------------------------- 7. paths
check('the canonical ledger path mirrors the scene checkpoint tree', (() => {
  const p = generationLedgerPath({ projectId: 'proj', outputsRoot: path.join(tmp, 'outputs') });
  return p === path.join(tmp, 'outputs', 'proj', 'flow-scenes', 'generation-attempts.json');
})());
check('the legacy path treats an output dir named after the project as the project dir', (() => {
  const p = resolveLegacyGenerationLedgerPath({ projectId: 'proj', outputDir: path.join(tmp, 'outputs', 'proj') });
  return p === path.join(tmp, 'outputs', 'proj', 'flow-scenes', 'generation-attempts.json');
})());
check('the legacy path treats any other output dir as the outputs root', (() => {
  const p = resolveLegacyGenerationLedgerPath({ projectId: 'proj', outputDir: path.join(tmp, 'custom') });
  return p === path.join(tmp, 'custom', 'proj', 'flow-scenes', 'generation-attempts.json');
})());
check('a blank project id is rejected', (() => {
  let threw = false;
  try { generationLedgerPath({ projectId: '  ', outputsRoot: tmp }); } catch { threw = true; }
  return threw;
})());

// ------------------------------------------- 8. reservation, persistence and budgets
const budgetLedger = path.join(tmp, 'budget', 'flow-scenes', 'generation-attempts.json');
const begin = (over: any = {}) => beginBoundedGeneration({
  ledgerFile: budgetLedger, projectId: 'budget', subject: sceneSubject(1), ...over,
});

const first = await begin();
check('the first reservation is allowed', first.ok === true && first.code === 'ALLOWED', first);
check('reservation writes the ledger atomically', fs.existsSync(budgetLedger) && !fs.readdirSync(path.dirname(budgetLedger)).some((f) => f.endsWith('.tmp')));
check('the on-disk ledger records the attempt BEFORE any work', (() => {
  const raw = JSON.parse(fs.readFileSync(budgetLedger, 'utf8'));
  return raw.project_attempts === 1
    && raw.subjects['scene:1'].attempts === 1
    && raw.attempts.length === 1
    && raw.attempts[0].outcome === 'IN_PROGRESS'
    && raw.attempts[0].finished_at === null
    && Object.keys(raw.active).length === 1
    && typeof raw.attempts[0].attempt_id === 'string';
})());
{
  const concurrent = await begin();
  check('a live attempt for the same scene refuses a concurrent duplicate', concurrent.ok === false && concurrent.code === 'ATTEMPT_IN_PROGRESS', concurrent);
  check('a refused reservation writes nothing', JSON.parse(fs.readFileSync(budgetLedger, 'utf8')).project_attempts === 1);
}
await finishBoundedGeneration({
  handle: first.handle, outcome: 'FAILED', category: 'RETRYABLE', submission: 'NOT_SUBMITTED', reason: 'connection reset before the click',
});
check('finishing clears the active marker and records the outcome', (() => {
  const raw = JSON.parse(fs.readFileSync(budgetLedger, 'utf8'));
  return raw.project_attempts === 1
    && Object.keys(raw.active).length === 0
    && raw.subjects['scene:1'].last_outcome === 'FAILED'
    && raw.subjects['scene:1'].last_failure_category === 'RETRYABLE'
    && raw.subjects['scene:1'].consecutive_failures === 1
    && raw.attempts[0].retry_permitted === true;
})());
check('an attempt record carries every required audit field', (() => {
  const a = JSON.parse(fs.readFileSync(budgetLedger, 'utf8')).attempts[0];
  return ['attempt_id', 'project_id', 'attempt_number', 'subject_kind', 'subject_id', 'scene_number', 'started_at',
    'finished_at', 'failure_category', 'failure_reason', 'submission', 'clip_downloaded', 'validation_passed',
    'retry_permitted', 'manual_approval', 'outcome'].every((k) => k in a);
})());
check('the ledger contains no secret material', !/blob:|cookie|authorization|bearer|access_token/i.test(fs.readFileSync(budgetLedger, 'utf8')));

const second = await begin();
check('a restart re-reads the SAME budget (attempt 2 of 2)', second.ok === true && second.handle.attemptNumber === 2, second);
check('the second reservation does not reset earlier counters', JSON.parse(fs.readFileSync(budgetLedger, 'utf8')).project_attempts === 2);
await finishBoundedGeneration({ handle: second.handle, outcome: 'FAILED', category: 'UNKNOWN', submission: 'SUBMISSION_UNKNOWN', reason: 'ambiguous' });
{
  const third = await begin();
  check('the per-scene ceiling stops the third attempt', third.ok === false && third.code === 'SUBJECT_BUDGET_EXHAUSTED', third);
  check('the exhausted ceiling is stored, not recomputed from a fresh default', JSON.parse(fs.readFileSync(budgetLedger, 'utf8')).subjects['scene:1'].attempts === 2);
}
check('approval cannot buy an attempt past the ceiling', (await begin({ approval: { mode: 'PROJECT' } })).ok === false);

// --------------------------------------------------------------- 9. release (no submit)
const releaseFile = path.join(tmp, 'release', 'flow-scenes', 'generation-attempts.json');
{
  const reserved = await beginBoundedGeneration({ ledgerFile: releaseFile, projectId: 'release', subject: sceneSubject(2) });
  check('a reservation can be released when nothing was submitted', reserved.ok === true);
  const released = await GA.releaseBoundedGeneration({ handle: reserved.handle, reason: 'prompt hardening failed before submission' });
  check('release restores the pre-attempt budget exactly', released.ok === true
    && JSON.parse(fs.readFileSync(releaseFile, 'utf8')).project_attempts === 0
    && Object.keys(JSON.parse(fs.readFileSync(releaseFile, 'utf8')).active).length === 0);
  const again = await beginBoundedGeneration({ ledgerFile: releaseFile, projectId: 'release', subject: sceneSubject(2) });
  check('after a release the scene still has a full first attempt', again.ok === true && again.handle.attemptNumber === 1);
  await finishBoundedGeneration({ handle: again.handle, outcome: 'SUCCEEDED', submission: 'SUBMITTED_CONFIRMED' });
  const afterFinish = await GA.releaseBoundedGeneration({ handle: again.handle, reason: 'too late' });
  check('release refuses a reservation that is no longer active', afterFinish.ok === false);
}

// ------------------------------------------------------ 10. corrupted ledger handling
const corruptFile = path.join(tmp, 'corrupt', 'flow-scenes', 'generation-attempts.json');
fs.mkdirSync(path.dirname(corruptFile), { recursive: true });
fs.writeFileSync(corruptFile, '{ this is not json', 'utf8');
{
  const denied = await beginBoundedGeneration({ ledgerFile: corruptFile, projectId: 'corrupt', subject: sceneSubject(3) });
  check('a corrupt ledger fails closed', denied.ok === false && denied.code === 'LEDGER_CORRUPT', denied);
  check('a refused corrupt ledger is left untouched as evidence', fs.readFileSync(corruptFile, 'utf8') === '{ this is not json');
  const approved = await beginBoundedGeneration({ ledgerFile: corruptFile, projectId: 'corrupt', subject: sceneSubject(3), approval: { mode: 'PROJECT' } });
  check('explicit approval quarantines the corrupt ledger instead of overwriting it', approved.ok === true
    && fs.readdirSync(path.dirname(corruptFile)).some((f) => f.includes('.corrupt-') && f.endsWith('.json')), approved);
  check('the quarantined evidence still holds the original bytes', fs.readdirSync(path.dirname(corruptFile))
    .filter((f) => f.includes('.corrupt-'))
    .some((f) => fs.readFileSync(path.join(path.dirname(corruptFile), f), 'utf8') === '{ this is not json'));
  check('the approved recovery starts a fresh, valid ledger', (() => {
    const raw = JSON.parse(fs.readFileSync(corruptFile, 'utf8'));
    return raw.project_attempts === 1 && raw.project_id === 'corrupt';
  })());
}

// ------------------------------------------- 11. stale attempts and crashed processes
const staleFile = path.join(tmp, 'stale', 'flow-scenes', 'generation-attempts.json');
{
  const host = os.hostname();
  const live = await beginBoundedGeneration({
    ledgerFile: staleFile, projectId: 'stale', subject: sceneSubject(4),
    now: new Date('2026-11-05T00:00:00.000Z'), pid: 4242, host,
  });
  check('a same-host reservation is live while its pid exists', live.ok === true);
  const stillLive = await beginBoundedGeneration({
    ledgerFile: staleFile, projectId: 'stale', subject: sceneSubject(4),
    now: new Date('2026-11-05T00:01:00.000Z'), pid: 9999, host, pidAlive: () => true,
  });
  check('a live same-host pid blocks a concurrent duplicate', stillLive.ok === false && stillLive.code === 'ATTEMPT_IN_PROGRESS', stillLive);
  const liveApproved = await beginBoundedGeneration({
    ledgerFile: staleFile, projectId: 'stale', subject: sceneSubject(4),
    now: new Date('2026-11-05T00:01:30.000Z'), pid: 9999, host, pidAlive: () => true,
    approval: { mode: 'PROJECT' },
  });
  check('approval never overrides a genuinely live concurrent attempt',
    liveApproved.ok === false && liveApproved.code === 'ATTEMPT_IN_PROGRESS', liveApproved);
  const crashed = await beginBoundedGeneration({
    ledgerFile: staleFile, projectId: 'stale', subject: sceneSubject(4),
    now: new Date('2026-11-05T00:02:00.000Z'), pid: 9999, host, pidAlive: () => false,
  });
  check('a same-host pid that no longer exists stops being a concurrency block',
    crashed.ok === false && crashed.code === 'MANUAL_APPROVAL_REQUIRED', crashed);
  const recovered = await beginBoundedGeneration({
    ledgerFile: staleFile, projectId: 'stale', subject: sceneSubject(4),
    now: new Date('2026-11-05T00:03:00.000Z'), pid: 9999, host, pidAlive: () => false,
    approval: { mode: 'PROJECT' },
  });
  check('a crashed attempt needs explicit approval, then may proceed', recovered.ok === true && recovered.code === 'APPROVED_RECOVERY', recovered);
}
{
  const host = os.hostname();
  const other = await beginBoundedGeneration({
    ledgerFile: path.join(tmp, 'stale2', 'flow-scenes', 'generation-attempts.json'),
    projectId: 'stale2', subject: sceneSubject(5),
    now: new Date('2026-11-05T00:00:00.000Z'), pid: 1, host: 'some-other-host',
  });
  check('a remote-host reservation is live inside the stale window', other.ok === true);
  const insideWindow = await beginBoundedGeneration({
    ledgerFile: path.join(tmp, 'stale2', 'flow-scenes', 'generation-attempts.json'),
    projectId: 'stale2', subject: sceneSubject(5),
    now: new Date('2026-11-05T00:29:00.000Z'), pid: 2, host,
  });
  check('inside the stale window a remote reservation still blocks', insideWindow.ok === false && insideWindow.code === 'ATTEMPT_IN_PROGRESS');
  const outsideWindow = await beginBoundedGeneration({
    ledgerFile: path.join(tmp, 'stale2', 'flow-scenes', 'generation-attempts.json'),
    projectId: 'stale2', subject: sceneSubject(5),
    now: new Date('2026-11-05T00:31:00.000Z'), pid: 2, host,
  });
  check('outside the stale window the reservation stops blocking, but still needs approval',
    outsideWindow.ok === false && outsideWindow.code === 'MANUAL_APPROVAL_REQUIRED', outsideWindow);
}

// --------------------------------------------------------- 12. per-project budget
{
  const file = path.join(tmp, 'project-budget', 'flow-scenes', 'generation-attempts.json');
  const policy = { maxAttemptsPerProject: 2, maxAttemptsPerScene: 5 };
  const one = await beginBoundedGeneration({ ledgerFile: file, projectId: 'project-budget', subject: sceneSubject(1), policy });
  await finishBoundedGeneration({ handle: one.handle, outcome: 'SUCCEEDED', submission: 'SUBMITTED_CONFIRMED' });
  const two = await beginBoundedGeneration({ ledgerFile: file, projectId: 'project-budget', subject: sceneSubject(2), policy });
  await finishBoundedGeneration({ handle: two.handle, outcome: 'SUCCEEDED', submission: 'SUBMITTED_CONFIRMED' });
  const three = await beginBoundedGeneration({ ledgerFile: file, projectId: 'project-budget', subject: sceneSubject(3), policy });
  check('the per-project ceiling stops further paid submissions', three.ok === false && three.code === 'PROJECT_BUDGET_EXHAUSTED', three);
}

// ----------------------------------------------------------- 13. history rendering
{
  const file = path.join(tmp, 'history', 'flow-scenes', 'generation-attempts.json');
  const a = await beginBoundedGeneration({ ledgerFile: file, projectId: 'history', subject: sceneSubject(6) });
  await finishBoundedGeneration({ handle: a.handle, outcome: 'FAILED', category: 'UNKNOWN', submission: 'SUBMISSION_UNKNOWN', reason: 'ambiguous timeout after Start' });
  const ledger = (await readGenerationLedger(file, { projectId: 'history' })).ledger!;
  check('reading a valid ledger succeeds', ledger !== null && ledger.project_attempts === 1);
  const text = renderGenerationHistory(ledger, { limit: 5 });
  check('history shows the project budget', /attempts: 1\/80 project budget used/.test(text), text);
  check('history shows the subject, failure category, submission state and approval state',
    /scene:6/.test(text) && /UNKNOWN\/SUBMISSION_UNKNOWN/.test(text) && /approval=REQUIRED/.test(text), text);
  check('history keeps the human-readable failure reason', /ambiguous timeout after Start/.test(text));
  check('history never contains secret material', !/blob:|cookie|authorization|bearer/i.test(text));
  check('history limit is bounded to the requested number of records', renderGenerationHistory({
    ...ledger,
    attempts: Array.from({ length: 6 }, (_, i) => ({ ...ledger.attempts[0], attempt_id: `x${i}`, attempt_number: i + 1 })),
  }, { limit: 2 }).split('recent attempts')[1].split('\n').filter((l) => l.trim().startsWith('#')).length === 2);
  check('the bounded history limit is a sane constant', GENERATION_HISTORY_LIMIT >= 50);
}

// --------------------------------------- 14. workflow integration (Scene Flow workflow)
{
  const outputsRoot = path.join(tmp, 'workflow-outputs');
  const projectId = 'wf';
  const prompt = 'ACTIVE ENVIRONMENT: #BGD-01-TEMPLE\nACTIVE CHARACTERS: @CHAR-01-ARJUN';
  const assets = {
    backgrounds: [{ tag: '#BGD-01-TEMPLE', location_name: 'Temple', look_summary: 'temple exterior' }],
    characters: [{ tag: '@CHAR-01-ARJUN', name: 'Arjun', look_summary: 'young Indian man' }],
  };
  const scene = (n: number) => ({ scene_number: n, speaker: 'NARRATOR', animation_prompt_NARRATOR_ONLY: prompt });

  // A committed scene is downloaded and MUST NOT touch the attempt ledger.
  {
    const inputRoot = path.join(tmp, 'wf-in-committed', projectId);
    fs.mkdirSync(path.join(inputRoot, 'flow-clips'), { recursive: true });
    let generated = 0;
    const flow = {
      sceneHasClip: async () => true,
      generateProjectVideo: async () => { generated++; return { title: 'T', artifactId: 'u' }; },
      downloadCommittedSceneClip: async () => ({ ok: true, result: 'DOWNLOAD_SUCCESS' }),
    };
    const r = await WF.processSingleFlowScene(scene(1), flow, { projectId, inputRoot, outputsRoot, ffprobePath: process.env.FFPROBE_PATH });
    check('a committed Flow scene downloads with ZERO generation and ZERO attempt records',
      generated === 0 && r.generationAttempts === 0 && !fs.existsSync(path.join(outputsRoot, projectId, 'flow-scenes', 'generation-attempts.json')), { r, generated });
  }

  // A generation failure with no submission latch is ambiguous: ONE attempt, then a hard stop.
  {
    const inputRoot = path.join(tmp, 'wf-in-fail', projectId);
    fs.mkdirSync(path.join(inputRoot, 'flow-clips'), { recursive: true });
    let generated = 0;
    const flow = {
      sceneHasClip: async () => false,
      generateProjectVideo: async () => { generated++; throw new Error('Timeout 15000ms exceeded'); },
      downloadCommittedSceneClip: async () => ({ ok: true }),
    };
    const cfg = { projectId, inputRoot, outputsRoot, allowGeneration: true, ffprobePath: process.env.FFPROBE_PATH, ...assets };
    const r1 = await WF.processSingleFlowScene(scene(2), flow, cfg);
    check('the first paid attempt runs exactly once and reports failure', r1.status === 'FLOW_GENERATION_FAILED' && generated === 1, r1);
    const r2 = await WF.processSingleFlowScene(scene(2), flow, cfg);
    check('an ambiguous failure BLOCKS the next run instead of submitting again',
      r2.status === 'FLOW_GENERATION_BLOCKED' && generated === 1, { r2, generated });
    check('the block explains the manual-approval gate', /MANUAL_APPROVAL_REQUIRED/.test(String(r2.detail)), r2.detail);
    const r3 = await WF.processSingleFlowScene(scene(2), flow, { ...cfg, generationApproval: { mode: 'SCENES', scenes: [2] } });
    check('scene-scoped approval allows ONE more attempt, which also fails', r3.status === 'FLOW_GENERATION_FAILED' && generated === 2, { r3, generated });
    const r4 = await WF.processSingleFlowScene(scene(2), flow, { ...cfg, generationApproval: { mode: 'PROJECT' } });
    check('approval cannot exceed the per-scene ceiling of 2', r4.status === 'FLOW_GENERATION_BLOCKED' && generated === 2, { r4, generated });
    const ledger = JSON.parse(fs.readFileSync(path.join(outputsRoot, projectId, 'flow-scenes', 'generation-attempts.json'), 'utf8'));
    check('the workflow ledger records both attempts with their categories and submission states', ledger.attempts.length === 2
      && ledger.attempts.every((a: any) => a.outcome === 'FAILED' && a.submission === 'SUBMISSION_UNKNOWN' && a.failure_category === 'UNKNOWN'), ledger.attempts);
    check('the workflow ledger never stores a secret', !/blob:|cookie|authorization|bearer/i.test(JSON.stringify(ledger)));
  }

  // A corrupt ledger fails closed in the workflow too.
  {
    const inputRoot = path.join(tmp, 'wf-in-corrupt', 'corruptwf');
    fs.mkdirSync(path.join(inputRoot, 'flow-clips'), { recursive: true });
    const ledgerFile = path.join(outputsRoot, 'corruptwf', 'flow-scenes', 'generation-attempts.json');
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    fs.writeFileSync(ledgerFile, 'not json', 'utf8');
    let generated = 0;
    const flow = { sceneHasClip: async () => false, generateProjectVideo: async () => { generated++; throw new Error('x'); } };
    const r = await WF.processSingleFlowScene(scene(3), flow, { projectId: 'corruptwf', inputRoot, outputsRoot, allowGeneration: true, ffprobePath: process.env.FFPROBE_PATH, ...assets });
    check('a corrupt workflow ledger blocks generation entirely', r.status === 'FLOW_GENERATION_BLOCKED' && generated === 0 && /LEDGER_CORRUPT/.test(String(r.detail)), r);
  }
}

// ------------------------------------------------------------- 15. source hygiene
{
  const src = fs.readFileSync(path.join(SRC, 'generationAttempts.ts'), 'utf8');
  check('the ledger module imports no browser/Flow client', !/playwright|flowClient|from '\.\/flowClient/.test(src));
  check('the ledger module exposes atomic write + quarantine', /rename\(tmp, file\)/.test(src) && /corrupt-/.test(src));
  check('the ledger module documents that approval never raises a ceiling', /never raises? the ceiling|does not raise a ceiling|never raises a ceiling/i.test(src));

  const client = fs.readFileSync(path.join(SRC, 'flowClient.ts'), 'utf8');
  check('FlowClient exposes the monotonic submission probe', /getGenerationSubmissionState\(\)/.test(client));
  check('every paid generate action records the submission (generate/background/project/first-clip/scene)',
    (client.match(/this\.noteGenerationSubmission\(\);/g) ?? []).length === 5, (client.match(/this\.noteGenerationSubmission\(\);/g) ?? []).length);
  check('the submission latch is initialised once and never reset',
    (client.match(/submitted: false/g) ?? []).length === 1 && !/submitted: false/.test(client.split('noteGenerationSubmission')[1] ?? ''));

  const workflow = fs.readFileSync(path.join(SRC, 'sceneFlowWorkflow.ts'), 'utf8');
  check('the scene workflow reserves the attempt immediately before the paid call',
    workflow.indexOf('beginSceneGenerationAttempt(config, sceneNumber)') > 0
    && workflow.indexOf('beginSceneGenerationAttempt(config, sceneNumber)') < workflow.indexOf('flow.generateProjectVideo(built.prompt)'));
  check('the scene workflow exposes a distinct blocked status', /'FLOW_GENERATION_BLOCKED'/.test(workflow));

  const runner = fs.readFileSync(path.join(SRC, 'runner.ts'), 'utf8');
  check('the legacy runner gates characters, backgrounds and scenes', (runner.match(/beginBoundedAsset\(/g) ?? []).length === 4);
}

console.log(`\nGENERATION-ATTEMPTS TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
