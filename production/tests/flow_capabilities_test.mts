// Offline capability-boundary tests for Flow still-image/background generation.
// Browser-free, network-free, no Flow, no credits. Uses dependency injection.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const FC = await import(pathToFileURL(path.join(SRC, 'flowCapabilities.ts')).href);
const { run, selectWork } = await import(pathToFileURL(path.join(SRC, 'runner.ts')).href);

let passed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed += 1; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcaps-'));
const tmpOut = path.join(tmpRoot, 'out');
const tmpFile = path.join(tmpRoot, 'pipeline.json');

function fakeFlow() {
  const calls: string[] = [];
  const push = (n: string) => { calls.push(n); };
  return {
    calls,
    async returnToProjectGrid() { push('returnToProjectGrid'); },
    async ensureImageGenerationMode() { push('ensureImageGenerationMode'); },
    async prompt(_t: string) { push('prompt'); },
    async click(_s: unknown) { push('click'); },
    async generateBackground() { push('generateBackground'); },
    async renameGeneratedBackground(_n: string) { push('renameGeneratedBackground'); },
  };
}

const bg = (over: Record<string, unknown> = {}) => ({ tag: '#BGD-01-ARJUN-ROOM-WIDE', status: 'pending', full_prompt: 'empty background plate', ...over });
const pipeline = (backgrounds: any[]) => ({ project_id: 'test-proj', characters: [], backgrounds, scenes: [] });
const selectionFor = (p: any) => ({ characters: [], backgrounds: p.backgrounds, scenes: [] });
const collect = () => { const events: any[] = []; return { events, log: (e: string, d: any = {}) => events.push({ e, d }) }; };

// ---------------------------------------------------------------- 1. pure capability contract
{
  const cur = FC.currentFlowImageGenerationCapability();
  check('current capability is AVAILABLE (standard composer image path)', cur.state === 'AVAILABLE', cur);
  check('current capability has no blocking reason', cur.reason === null, cur);
  check('current capability detail never suggests prompting the Agent', !/agent|prompt/i.test(cur.detail), cur.detail);
}

// ---------------------------------------------------------------- 2. pure decision matrix
{
  const none = FC.flowImageGenerationUnavailableProductUi();
  const cached = FC.classifyBackgroundGeneration({ local: 'CACHED', capability: none });
  const supplied = FC.classifyBackgroundGeneration({ local: 'SUPPLIED', capability: none });
  const blocked = FC.classifyBackgroundGeneration({ local: 'NONE', capability: none });
  const available = FC.classifyBackgroundGeneration({ local: 'NONE', capability: FC.flowImageGenerationAvailable() });
  const unknown = FC.classifyBackgroundGeneration({ local: 'NONE', capability: FC.flowImageGenerationUnknown() });
  check('cached background -> REUSE_LOCAL / BACKGROUND_CACHE_HIT', cached.action === 'REUSE_LOCAL' && cached.code === 'BACKGROUND_CACHE_HIT', cached);
  check('supplied background -> REUSE_LOCAL / BACKGROUND_SUPPLIED', supplied.action === 'REUSE_LOCAL' && supplied.code === 'BACKGROUND_SUPPLIED', supplied);
  check('missing + unavailable -> WAITING_EXTERNAL_INPUT', blocked.action === 'WAITING_EXTERNAL_INPUT' && blocked.code === FC.WAITING_FOR_EXTERNAL_BACKGROUND_INPUT, blocked);
  check('missing + unavailable carries deterministic reason', blocked.reason === FC.CURRENT_UI_NO_DETERMINISTIC_IMAGE_PATH, blocked);
  check('missing + available -> GENERATE_FLOW (forward compatible)', available.action === 'GENERATE_FLOW', available);
  check('missing + unknown -> WAITING_EXTERNAL_INPUT (fail closed)', unknown.action === 'WAITING_EXTERNAL_INPUT', unknown);
  check('no plan selects an Agent fallback', ![cached, supplied, blocked, available, unknown].some((p: any) => /agent/i.test(p.action + ' ' + p.code + ' ' + (p.reason ?? ''))), 'agent fallback leaked');
}

// ---------------------------------------------- 3. missing background + unavailable => blocked
{
  const p = pipeline([bg()]);
  const flow = fakeFlow();
  const { events, log } = collect();
  await run(flow as any, {} as any, p as any, tmpFile, tmpOut, log, selectionFor(p) as any, true, {
    backgroundLocalState: () => 'NONE',
    imageGenerationCapability: () => FC.flowImageGenerationUnavailableProductUi(),
  });
  check('4 unavailable capability never calls ensureImageGenerationMode()', !flow.calls.includes('ensureImageGenerationMode'), flow.calls);
  check('4 unavailable capability never calls prompt/generateBackground/rename',
    !flow.calls.includes('prompt') && !flow.calls.includes('generateBackground') && !flow.calls.includes('renameGeneratedBackground'), flow.calls);
  check('3 missing background is BLOCKED (not pending/failed)', p.backgrounds[0].status === 'blocked', p.backgrounds[0]);
  check('6 blocked code is WAITING_FOR_EXTERNAL_BACKGROUND_INPUT', p.backgrounds[0].blocked?.code === FC.WAITING_FOR_EXTERNAL_BACKGROUND_INPUT, p.backgrounds[0].blocked);
  check('6 blocked reason is CURRENT_UI_NO_DETERMINISTIC_IMAGE_PATH', p.backgrounds[0].blocked?.reason === FC.CURRENT_UI_NO_DETERMINISTIC_IMAGE_PATH, p.backgrounds[0].blocked);
  check('3 blocked state reuses existing WAITING_FOR_BACKGROUND readiness', p.backgrounds[0].blocked?.readiness === 'WAITING_FOR_BACKGROUND', p.backgrounds[0].blocked);
  check('3 structured blocked event logged', events.some((e) => e.e === 'background_generation_blocked'), events.map((e) => e.e));
  check('5 no Agent-mediated method was invoked', !flow.calls.some((c) => /agent/i.test(c)), flow.calls);
  check('3 blocked status is persisted to the pipeline file', JSON.parse(fs.readFileSync(tmpFile, 'utf8')).backgrounds[0].status === 'blocked');
}

// ---------------------------------------------------------------- 4. cached background bypass
{
  const p = pipeline([bg()]);
  const flow = fakeFlow();
  const { events, log } = collect();
  await run(flow as any, {} as any, p as any, tmpFile, tmpOut, log, selectionFor(p) as any, true, {
    backgroundLocalState: () => 'CACHED',
    imageGenerationCapability: () => FC.flowImageGenerationUnavailableProductUi(),
  });
  check('1 cached background bypasses Flow capability requirement', p.backgrounds[0].status === 'done', p.backgrounds[0]);
  check('1 cached background makes ZERO Flow calls', flow.calls.length === 0, flow.calls);
  check('1 cached reuse logged with BACKGROUND_CACHE_HIT', events.some((e) => e.e === 'background_reuse_local' && e.d.code === 'BACKGROUND_CACHE_HIT'), events);
}

// -------------------------------------------------------------- 5. supplied background bypass
{
  const p = pipeline([bg()]);
  const flow = fakeFlow();
  const { events, log } = collect();
  await run(flow as any, {} as any, p as any, tmpFile, tmpOut, log, selectionFor(p) as any, true, {
    backgroundLocalState: () => 'SUPPLIED',
    imageGenerationCapability: () => FC.flowImageGenerationUnavailableProductUi(),
  });
  check('2 supplied local background bypasses Flow capability requirement', p.backgrounds[0].status === 'done', p.backgrounds[0]);
  check('2 supplied background makes ZERO Flow calls', flow.calls.length === 0, flow.calls);
  check('2 supplied reuse logged with BACKGROUND_SUPPLIED', events.some((e) => e.e === 'background_reuse_local' && e.d.code === 'BACKGROUND_SUPPLIED'), events);
}

// ------------------------------------------- 6. forward compatibility: AVAILABLE => existing seq
{
  const p = pipeline([bg()]);
  const flow = fakeFlow();
  const { log } = collect();
  await run(flow as any, {} as any, p as any, tmpFile, tmpOut, log, selectionFor(p) as any, true, {
    backgroundLocalState: () => 'NONE',
    imageGenerationCapability: () => FC.flowImageGenerationAvailable(),
  });
  const expected = ['returnToProjectGrid', 'ensureImageGenerationMode', 'prompt', 'click', 'generateBackground', 'renameGeneratedBackground'];
  check('available capability runs the EXISTING Flow background sequence exactly once',
    expected.every((m) => flow.calls.includes(m)) && flow.calls.filter((c) => c === 'generateBackground').length === 1, flow.calls);
  check('available capability marks the background done', p.backgrounds[0].status === 'done', p.backgrounds[0]);
}

// -------------------------------------------------- 7. default capability enables the standard path
{
  const p = pipeline([bg()]);
  const flow = fakeFlow();
  const { log } = collect();
  await run(flow as any, {} as any, p as any, tmpFile, tmpOut, log, selectionFor(p) as any, true, {
    backgroundLocalState: () => 'NONE',
  });
  check('default (current UI) capability uses the standard Flow image path (no block)',
    p.backgrounds[0].status === 'done' && flow.calls.includes('ensureImageGenerationMode') && flow.calls.filter((c) => c === 'generateBackground').length === 1,
    { status: p.backgrounds[0].status, calls: flow.calls });
}

// ------------------------------------------- 8. unrelated Flow/video/selection paths unchanged
{
  const runnerSrc = fs.readFileSync(path.join(SRC, 'runner.ts'), 'utf8');
  check('7 character loop unchanged (renameGeneratedCharacter)', /renameGeneratedCharacter\(tileName\)/.test(runnerSrc));
  check('7 voice verification + locking unchanged', /verifyVoiceApplied/.test(runnerSrc) && /locked = true/.test(runnerSrc));
  check('7 scene video path unchanged (generateProjectVideo + reconcile)',
    /generateProjectVideo\(String\(built\.prompt\)\)/.test(runnerSrc) && /reconcileGeneratedVideoWithScene\(generated\.title, generated\.artifactId\)/.test(runnerSrc));
  check('7 scene lock gate unchanged', /assertSceneAssetsLocked\(p,s\)/.test(runnerSrc));
  check('7 forward-compatible Flow background sequence preserved',
    /renameGeneratedBackground/.test(runnerSrc) && /S\.aspect16x9/.test(runnerSrc) && /flow\.ensureImageGenerationMode\(\)/.test(runnerSrc));
  check('7 selectWork still resolves the scene subset',
    (() => {
      const p: any = { characters: [{ tag: '@C', status: 'pending' }], backgrounds: [{ tag: '#B', status: 'pending' }], scenes: [{ scene_number: 1, background_tag: '#B', character_tags: ['@C'], status: 'pending' }] };
      const plan = selectWork(p, { only: [1] });
      return plan.scenes.length === 1 && plan.characters.length === 1 && plan.backgrounds.length === 1;
    })());
}

console.log(`\nFLOW-CAPABILITIES TESTS PASSED (${passed} checks)`);
