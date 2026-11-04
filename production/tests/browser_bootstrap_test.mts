// Offline Step-8A tests: production browser __name bootstrap (browser-free audit).
// Verifies the shim is installed on the EXISTING BrowserContext before any
// page.evaluate can run. No Playwright, no Chrome, no Flow, no credits.
import fs from 'node:fs';
import path from 'node:path';

import { SRC } from './_testPaths.mjs';
const fcSrc = fs.readFileSync(path.join(SRC, 'flowClient.ts'), 'utf8');

let passed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed += 1; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
}

// ------------------------------------------------- start() body extraction
const startIdx = fcSrc.indexOf('export async function start(');
const startBody = startIdx >= 0 ? fcSrc.slice(startIdx) : '';
const code = startBody.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

check('FlowClient.start() exists', startIdx >= 0 && startBody.length > 0);

// ------------------------------------------------------------ 1. addInitScript
check('start() installs context.addInitScript', /await context\.addInitScript\(\{/.test(code));
check('addInitScript uses the EXISTING context (no new browser/context created)',
  /await context\.addInitScript\(/.test(code) && !/newContext|launch\(|new BrowserContext/.test(code));
check('only ONE addInitScript call is added (no unrelated second workaround)',
  (code.match(/addInitScript/g) ?? []).length === 1);

// --------------------------------------------------------- 2. window.__name
check('the installed script defines window.__name', /window\.__name\s*=/.test(code));
check('the content is passed as a string (browser-safe, no Node globals)',
  /content:\s*'[^']*window\.__name[^']*'/.test(code) && !/process\.|require\(|__dirname/.test((code.match(/content:\s*'[^']*'/) || [''])[0]));

// --------------------------------------------------- 3. preserves existing impl
check('it preserves an existing window.__name (uses ||= semantics)',
  /window\.__name\s*=\s*window\.__name\s*\|\|/.test(code), (code.match(/window\.__name[^;]*;/) || [])[0]);

// ------------------------------------------------------ 4. returns f unchanged
check('the shim returns the supplied function unchanged', /function\s*\(\s*f\s*\)\s*\{\s*return\s+f\s*;?\s*\}/.test(code), (code.match(/window\.__name[^;]*;/) || [])[0]);

// ------------------------------------- 5. installed BEFORE any page.evaluate
{
  const shimAt = code.indexOf('addInitScript');
  const gotoAt = code.indexOf('page.goto(');
  const newPageAt = code.indexOf('context.newPage()');
  const flowAt = code.indexOf('new FlowClient(');
  check('bootstrap runs before the initial page.goto()', shimAt >= 0 && gotoAt >= 0 && shimAt < gotoAt, JSON.stringify({ shimAt, gotoAt }));
  check('bootstrap runs before any FlowClient is constructed', shimAt >= 0 && flowAt >= 0 && shimAt < flowAt, JSON.stringify({ shimAt, flowAt }));
  check('bootstrap runs before context.newPage() fallback', newPageAt < 0 || shimAt < newPageAt, JSON.stringify({ shimAt, newPageAt }));
  // Every evaluate-bearing helper lives in the class, i.e. only usable after start() returns.
  const evaluateHelpers = ['listProjectVideos', 'sceneHasClip'];
  check('the evaluate-bearing helpers are class methods (unreachable before start())',
    evaluateHelpers.every((name) => fcSrc.includes(`async ${name}(`)) && fcSrc.indexOf('class FlowClient') < fcSrc.indexOf('async listProjectVideos('));
}

// ---------------------------------- 9. no evaluate-body workaround introduced
check('listProjectVideos was NOT rewritten (still uses page.evaluate)', /async listProjectVideos\(\)[\s\S]*?this\.page\.evaluate\(/.test(fcSrc));
check('sceneHasClip was NOT rewritten (still uses page.evaluate)', /async sceneHasClip\(\)[\s\S]*?this\.page\.evaluate\(/.test(fcSrc));
check('no ad-hoc per-call __name injection inside evaluate bodies', !/evaluate\([\s\S]{0,200}window\.__name/.test(fcSrc));

// ------------------------------------------------- 6-8. nothing else changed
const runnerSrc = fs.readFileSync(path.join(SRC, 'runner.ts'), 'utf8');
const selSrc = fs.readFileSync(path.join(SRC, 'selectors.ts'), 'utf8');
const vdSrc = fs.readFileSync(path.join(SRC, 'videoDecisions.ts'), 'utf8');
check('runner.ts has no __name/addInitScript change', !/__name|addInitScript/.test(runnerSrc));
check('selectors.ts has no __name/addInitScript change', !/__name|addInitScript/.test(selSrc));
check('videoDecisions.ts untouched by the bootstrap (still pure/browser-free)',
  !/__name|addInitScript|playwright/i.test(vdSrc.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')));
check('only flowClient.ts carries the shim', /__name/.test(fcSrc) && !/__name/.test(runnerSrc) && !/__name/.test(selSrc));
check('the shim lives in the real start() glue (not in a test helper)', /export async function start\([\s\S]*addInitScript[\s\S]*return \{context,page,flow:new FlowClient/.test(fcSrc));

// ------------------------------------- behavioural check of the shim semantics
{
  // Mirror the browser-side expression in a sandbox and prove the semantics.
  const sandbox: any = {};
  const install = new Function('window', 'window.__name = window.__name || function(f){ return f; };');
  install(sandbox);
  check('shim defines __name as a function', typeof sandbox.__name === 'function');
  const original = (x: number) => x * 2;
  check('shim returns the supplied function unchanged (identity)', sandbox.__name(original) === original);
  const sentinel = () => 'pre-existing';
  const withExisting: any = { __name: sentinel };
  new Function('window', 'window.__name = window.__name || function(f){ return f; };')(withExisting);
  check('shim preserves a pre-existing implementation', withExisting.__name === sentinel);
}

console.log(`\nBROWSER-BOOTSTRAP TESTS PASSED (${passed} checks)`);
