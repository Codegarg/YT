import fs from 'node:fs/promises'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { start } from './flowClient.js'; import { run, selectWork } from './runner.js'; import { ensureProjectOpen, projectEntryDeps } from './projectEntry.js'; import { Pipeline, RunOptions } from './types.js'; import { WAITING_FOR_EXTERNAL_BACKGROUND_INPUT, CURRENT_UI_NO_DETERMINISTIC_IMAGE_PATH } from './flowCapabilities.js'; import { withFlowSessionLock } from './projectOrchestrator.js'; import { flowCliShouldAcquireLock, flowCliLockRoot } from './flowCliLock.js'; import { createPythonStoryValidator } from './storyValidation.js';
function arg(name:string, fallback?:string){ const i=process.argv.indexOf(name); return i>=0?process.argv[i+1]??fallback:fallback; }
function hasFlag(name:string){ return process.argv.includes(name); }
function flagValue(name:string){ const i=process.argv.indexOf(name); return i>=0?process.argv[i+1]:undefined; }
function parsePositiveInt(value:string, flag:string){ const n=Number(value); if(!Number.isInteger(n)||n<=0) throw new Error(`${flag} must be a positive integer, got "${value}"`); return n; }
function parseOnly(value:string){ const parts=value.split(',').map((x)=>x.trim()).filter(Boolean); if(!parts.length) throw new Error('--only requires comma-separated scene numbers, e.g. --only 1,2'); return [...new Set(parts.map((x)=>parsePositiveInt(x,'--only')))].sort((a,b)=>a-b); }

const file=path.resolve(arg('--project')??'../scripting/projects/example/pipeline.json'); const out=path.resolve(arg('--output-dir')??'outputs'); const profile=path.resolve(arg('--user-data-dir')??'chrome-profile'); const url=process.env.FLOW_URL??'https://flow.google.com';
const p=JSON.parse(await fs.readFile(file,'utf8')) as Pipeline; const logFile=path.join(out,'run.log.jsonl'); await fs.mkdir(out,{recursive:true});
const log=async(e:string,d:any={})=>{const row=JSON.stringify({at:new Date().toISOString(),event:e,...d}); console.log(row); await fs.appendFile(logFile,row+'\n');};

// Reusable CLI controls: --limit N (first N pending scenes), --only 1,2 (specific scenes), --fail-fast.
const options:RunOptions={};
if (hasFlag('--limit')) { const value=flagValue('--limit'); if(value===undefined) throw new Error('--limit requires a value, e.g. --limit 2'); options.limit=parsePositiveInt(value,'--limit'); }
if (hasFlag('--only')) { const value=flagValue('--only'); if(value===undefined) throw new Error('--only requires a value, e.g. --only 1,2'); options.only=parseOnly(value); }
const failFast=hasFlag('--fail-fast'); if (failFast) options.failFast=true;

const selection=selectWork(p, options);
if (options.only!==undefined) {
  const found=new Set(selection.scenes.map((s)=>Number(s.scene_number)));
  const missing=options.only.filter((n)=>!found.has(n));
  if (missing.length) throw new Error(`--only scene number(s) not found in project: ${missing.join(', ')}`);
}
if (selection.scenes.length===0) throw new Error('No scenes selected to process.');

const summary={ scenes:selection.scenes.map((s)=>Number(s.scene_number)), characters:selection.characters.map((c)=>String(c.tag)), backgrounds:selection.backgrounds.map((b)=>String(b.tag)), limit:options.limit??null, only:options.only??null, failFast };
await log('selection', summary);
console.log(`[selection] scenes=[${summary.scenes.join(', ')}] characters=[${summary.characters.join(', ')}] backgrounds=[${summary.backgrounds.join(', ')}] failFast=${failFast}`);

const sleep = (ms:number) => new Promise((resolve) => setTimeout(resolve, ms));
// Resumable retry loop: `run` skips items already marked `done`, so re-running
// the whole pass only retries pending/failed assets. Back off exponentially and
// keep going until every asset is done or the time cap is reached. With
// --fail-fast the loop stops on the first item error instead of retrying.
const maxRetryHours = Number(process.env.FLOW_MAX_RETRY_HOURS ?? '6');
const baseDelayMs = Math.max(1000, Number(process.env.FLOW_RETRY_BASE_MS ?? '5000'));
const maxDelayMs = Math.max(baseDelayMs, Number(process.env.FLOW_RETRY_MAX_MS ?? '300000'));
const loginTimeoutMs = Math.max(60000, Number(process.env.FLOW_LOGIN_TIMEOUT_MS ?? String(10 * 60 * 1000)));
const items = () => [...selection.characters, ...selection.backgrounds, ...selection.scenes];
const remaining = () => items().filter((item) => item.status !== 'done' && item.status !== 'blocked').length;
const blocked = () => items().filter((item) => item.status === 'blocked');
const done = () => items().filter((item) => item.status === 'done').length;
const deadline = Date.now() + maxRetryHours * 60 * 60 * 1000;
const flowHost = new URL(url).host;

// If Google redirects to a sign-in page, keep the browser open and wait for the
// human to finish logging in rather than closing the profile window immediately.
async function waitForFlowLogin(page:any): Promise<void> {
  const loginDeadline = Date.now() + loginTimeoutMs;
  let warned = false;
  while (!page.url().includes(flowHost)) {
    if (Date.now() >= loginDeadline) {
      await log('login_timeout',{url:page.url(),flowHost,hint:'Log in to Google, then rerun the flow command.'});
      throw new Error('Timed out waiting for Google login. Log in to Flow in the opened browser, then rerun.');
    }
    if (!warned) {
      await log('login_required',{url:page.url(),flowHost,hint:'Log in to Google in the opened browser; this run continues automatically once Flow loads.'});
      warned = true;
    }
    await sleep(3000);
  }
}

/**
 * One Flow session under the SINGLE shared session lock.
 *
 * Standalone `npm run flow` acquires the lock itself, so two concurrent CLI runs (or a CLI run
 * racing the canonical workflow) can never drive the same Chrome profile. When this process is
 * a child of `flowRunnerAdapter`, the parent already holds the lock and sets
 * FLOW_SESSION_LOCK_HELD=1; acquiring again here would refuse and abort the whole run.
 */
async function runFlowSession(): Promise<void> {
const {context,page,flow}=await start(url,profile,log);
try {
  await page.waitForLoadState('domcontentloaded');
  await waitForFlowLogin(page);
  // Enter the EXISTING project. FLOW_PROJECT_URL (https://flow.google.com/project/<uuid>) is
  // authoritative and bypasses title matching. Creating a project requires the explicit
  // --allow-create-project opt-in so a renamed/missing card can never duplicate the project.
  await ensureProjectOpen(projectEntryDeps(page, flow, log), String(p.flow_project_name ?? ''), {
    directUrl: process.env.FLOW_PROJECT_URL ?? null,
    allowCreate: hasFlag('--allow-create-project'),
  });
  let attempt = 0; let lastDone = done();
  while (true) {
    try { await run(flow,page,p,file,out,log,selection,failFast); }
    catch (error) { await log(failFast ? 'fail_fast_stop' : 'run_error', { error: String(error) }); throw error; }
    const blockedItems = blocked();
    const pending = remaining();
    await log('pass_complete',{attempt:attempt+1,pending,blocked:blockedItems.length,done:done()});
    if (blockedItems.length > 0) {
      // A generation block is NOT the external-background dependency: nothing was submitted and the
      // attempt budget (or the ambiguity gate) refused another paid attempt. Stop with a distinct,
      // actionable event instead of retrying a refusal for up to six hours.
      const generationBlocked = blockedItems.filter((item) => String((item as any).blocked?.code ?? '') === 'FLOW_GENERATION_BLOCKED');
      if (generationBlocked.length > 0) {
        await log('flow_generation_blocked', {
          count: generationBlocked.length,
          code: 'FLOW_GENERATION_BLOCKED',
          assets: generationBlocked.map((item) => String((item as any).tag ?? (item as any).scene_number ?? '')),
          denials: generationBlocked.map((item) => String((item as any).blocked?.denial_code ?? '')),
          hint: 'No credits were spent for the blocked assets. Inspect "npm run video -- flow-attempts --project-id <id>", verify Flow, then set FLOW_APPROVE_GENERATION_RECOVERY=1 or FLOW_APPROVE_GENERATION_RECOVERY_SCENES=<n> (or raise FLOW_MAX_ATTEMPTS_PER_SCENE deliberately).',
        });
        break;
      }
      await log('flow_image_generation_blocked', {
        count: blockedItems.length,
        code: WAITING_FOR_EXTERNAL_BACKGROUND_INPUT,
        reason: CURRENT_UI_NO_DETERMINISTIC_IMAGE_PATH,
        tags: blockedItems.map((item) => String((item as any).tag ?? '')),
        hint: 'Provide background PNGs locally (inputs/<project>/backgrounds/) or wait for a deterministic Flow still-image action. Agent generation is disabled.',
      });
      break;
    }
    if (pending === 0) { await log('all_complete',{attempt:attempt+1}); break; }
    if (failFast) { await log('fail_fast_incomplete',{pending}); break; }
    if (Date.now() >= deadline) { await log('retry_exhausted',{pending,maxRetryHours}); break; }
    const progressed = done() > lastDone; lastDone = done();
    const backoff = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
    const delayMs = progressed ? backoff : Math.min(backoff * 2, maxDelayMs);
    attempt += 1;
    await log('retry_wait',{attempt,delayMs,pending});
    await sleep(delayMs);
  }
} finally { await context.close(); }
}

// PHASE 3: fail closed BEFORE any Chrome/Flow submission. The story/scene audit is READ-ONLY and
// must report no BLOCKER (or no WARNING when FLOW_STORY_WARNINGS_BLOCK=1) for a paid CLI run.
// The audit never writes into the project and never spends a credit.
const storyStrict = process.env.FLOW_STORY_WARNINGS_BLOCK === '1';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const storyValidation = await createPythonStoryValidator({ repoRoot })({ projectFile: file, strict: storyStrict });
if (!storyValidation.available) {
  await log('story_validation_unavailable', { reason: storyValidation.reason ?? 'no report' });
  throw new Error(`Story validation could not run (${storyValidation.reason ?? 'no report'}); no Flow work was submitted. Inspect it: npm run video -- validate --project "${file}"`);
}
if (storyValidation.blockers.length > 0) {
  await log('story_validation_blocked', {
    status: storyValidation.status,
    blockers: storyValidation.blockers.map((finding) => finding.code),
    first: storyValidation.blockers[0]?.message,
    hint: `No credits were spent. Fix the findings, then re-run: npm run video -- validate --project "${file}"`,
  });
  throw new Error(`Story validation BLOCKED this run: ${storyValidation.blockers[0]?.code} — ${storyValidation.blockers[0]?.message}. No Flow work was submitted.`);
}
if (storyStrict && storyValidation.warnings.length > 0) {
  await log('story_validation_review_required', {
    status: storyValidation.status,
    warnings: storyValidation.warnings.map((finding) => finding.code),
    first: storyValidation.warnings[0]?.message,
    hint: 'FLOW_STORY_WARNINGS_BLOCK=1 treats human-review warnings as blocking. No credits were spent.',
  });
  throw new Error(`Story validation requires review (${storyValidation.warnings.length} warning(s)); FLOW_STORY_WARNINGS_BLOCK=1 blocks paid generation. No Flow work was submitted.`);
}
if (storyValidation.report) await log('story_validation_passed', { status: storyValidation.status, warnings: storyValidation.warnings.length, infos: storyValidation.infos.length });

if (flowCliShouldAcquireLock()) {
  await withFlowSessionLock({ lockRoot: flowCliLockRoot() }, runFlowSession);
} else {
  await runFlowSession();
}
