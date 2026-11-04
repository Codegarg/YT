// Offline Step-6 tests: runner scene-stage video integration (browser-free).
// No Chrome, no Flow, no media generated, no credits spent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const { assertSceneAssetsLocked, selectWork, run } = await import(pathToFileURL(path.join(SRC, 'runner.ts')).href);
  // Pure, browser-free decision helpers ("Nothing here touches the DOM, Playwright, Flow, or the
  // pipeline files"), so importing it for a behavioural assertion introduces no side effects.
  const { resolveSceneAttachmentTarget, isFlowSceneId } = await import(pathToFileURL(path.join(SRC, 'videoDecisions.ts')).href);

let passed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed += 1; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
}

const runnerSrc = fs.readFileSync(path.join(SRC, 'runner.ts'), 'utf8');
const sceneStage = runnerSrc.slice(runnerSrc.indexOf('for(const s of selection.scenes)'));
const stageCode = sceneStage.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

// ------------------------------------------------------------------ 1. order
{
  const order = ['assertSceneAssetsLocked', 'generateProjectVideo', 'openSceneEditor', 'reconcileGeneratedVideoWithScene', 'selectAsset'];
  const positions = order.map((name) => stageCode.indexOf(name));
  check('scene order: lock gate -> generateProjectVideo -> openSceneEditor -> reconcileGeneratedVideoWithScene -> existing continuation',
    positions.every((p) => p >= 0) && positions.every((p, i) => i === 0 || p > positions[i - 1]), JSON.stringify(positions));
  check('the lock gate runs before any generation/attachment',
    stageCode.indexOf('assertSceneAssetsLocked') < stageCode.indexOf('generateProjectVideo') &&
    stageCode.indexOf('assertSceneAssetsLocked') < stageCode.indexOf('reconcileGeneratedVideoWithScene'));
}

// ------------------------------------------------- 2-3. title handoff (no prediction)
check('generateProjectVideo is awaited and its .title is captured', /const generated=await flow\.generateProjectVideo\(String\(built\.prompt\)\)/.test(stageCode));
check('reconciliation receives EXACTLY generated.title', /await flow\.reconcileGeneratedVideoWithScene\(generated\.title/.test(stageCode));
check('runner does NOT construct/predict the title itself', !/title\s*=\s*['"`]/.test(stageCode) && !/camera moving toward/i.test(stageCode) && !/Empty village street/.test(stageCode));
check('runner reads the canonical lower-case WITH_lipsync key and hardens before generation',
  /animation_prompt_WITH_lipsync/.test(stageCode)
  && !/animation_prompt_WITH_LIPSYNC/.test(stageCode)
  && stageCode.indexOf('buildFlowScenePrompt(') >= 0
  && stageCode.indexOf('buildFlowScenePrompt(') < stageCode.indexOf('flow.generateProjectVideo('));
check('runner sends the built prompt, never the raw tagged prompt', /generateProjectVideo\(String\(built\.prompt\)\)/.test(stageCode));

// ---------------------------------------------------------- 4. forbidden calls
check('runner does NOT call flow.generate()', !/flow\.generate\(\)/.test(stageCode));
check('runner does NOT call configureVideoGeneration() directly', !/configureVideoGeneration/.test(stageCode));
check('runner does NOT click Start generation directly', !/S\.submit/.test(stageCode));
check('runner does NOT use download as a replacement for attachment', !/flow\.download\(/.test(stageCode));
check('runner does NOT use the obsolete image-generation path', !/S\.aspect16x9/.test(stageCode) && !/flow\.generateBackground/.test(stageCode));
check('runner does NOT create a scene via S.addScene', !/S\.addScene/.test(stageCode));

// -------------------------------------------------------------- 5. required calls
check('runner calls generateProjectVideo()', /flow\.generateProjectVideo\(/.test(stageCode));
check('runner calls openSceneEditor()', /flow\.openSceneEditor\(/.test(stageCode));
check('runner calls reconcileGeneratedVideoWithScene()', /flow\.reconcileGeneratedVideoWithScene\(/.test(stageCode));

// ------------------------------------------------------ 6-7-8. failure + no retry
check('generation failure stops attachment (sequential awaits, no try/catch swallow)',
  !/try\s*\{[\s\S]*generateProjectVideo[\s\S]*\}\s*catch/.test(stageCode));
check('attachment failure stops scene continuation (no catch around attach)',
  !/try\s*\{[\s\S]*attachVideoClipToTimeline[\s\S]*\}\s*catch/.test(stageCode));
check('no retry loop wraps generation/attachment',
  !/for\s*\([^)]*\)\s*\{[^}]*generateProjectVideo/s.test(stageCode) &&
  !/while\s*\([^)]*\)\s*\{[^}]*generateProjectVideo/s.test(stageCode) &&
  !/for\s*\([^)]*\)\s*\{[^}]*attachVideoClipToTimeline/s.test(stageCode),
  'no enclosing for/while around the generation or attachment calls');
check('exactly one generateProjectVideo and one reconcile call site',
  (stageCode.match(/flow\.generateProjectVideo\(/g) ?? []).length === 1 && (stageCode.match(/flow\.reconcileGeneratedVideoWithScene\(/g) ?? []).length === 1);
check('scene continuation still attaches background then character tags',
  /await flow\.selectAsset\(String\(assets\?\.background_tag\)\)/.test(stageCode) && /for\(const tag of \(assets\?\.character_tags\?\?\[\]\)\) await flow\.selectAsset\(String\(tag\)\)/.test(stageCode));

// ------------------------------------------------------- 9. lock gate preserved
check('assertSceneAssetsLocked is still imported and called', /assertSceneAssetsLocked/.test(runnerSrc) && /assertSceneAssetsLocked\(p,s\)/.test(stageCode));
check('character/background loops unchanged (S.addCharacter / voice verify / locked=true / renameGeneratedBackground)',
  /renameGeneratedCharacter\(tileName\)/.test(runnerSrc) && /verifyVoiceApplied/.test(runnerSrc) && /locked = true/.test(runnerSrc) && /renameGeneratedBackground/.test(runnerSrc) && /S\.aspect16x9/.test(runnerSrc));
check('existing runner failure/state handling (once + mark + save) is untouched', /function mark\(item:Item,status/.test(runnerSrc) && /await save\(file,p\)/.test(runnerSrc) && /log\('failed'/.test(runnerSrc));
check('runner keeps the resumable retryable() contract unchanged', /function retryable\(item:Item\)\{ return item\.status!=='done'; \}/.test(runnerSrc));

// ----------------------------------------------------------- 10. scene identity
// Behavioural assertions against the real exported resolver. These previously asserted source
// TEXT (`/String((s as any).title/` and `/has no flow_scene_id\/title/`), i.e. that a title
// fallback existed. It no longer does, deliberately: `resolveSceneAttachmentTarget` resolves by
// stable scene id ONLY and fails closed, because a Flow scene's auto-title is not an identity and
// a title lookup can silently attach a scene's generated video to an UNRELATED scene. Asserting
// the real contract here is STRONGER than the old regexes - it executes the decision instead of
// pattern-matching its source.
{
  const MANIFEST_ID = '3f6b1c2a-9d4e-4f2b-8a1c-7e5d3b9f0a26';
  const ROUTE_ID = 'a1b2c3d4-e5f6-4788-99aa-bbccddeeff00';
  const r = (flowSceneId: unknown, mountedRouteSceneId: unknown = null) =>
    resolveSceneAttachmentTarget({ flowSceneId, mountedRouteSceneId });

  // isFlowSceneId is the gate the resolver uses; assert the ids we rely on are accepted so a
  // future change to the id rule cannot silently invalidate the rest of this block.
  check('scene id contract: the ids used here are accepted by isFlowSceneId', isFlowSceneId(MANIFEST_ID) && isFlowSceneId(ROUTE_ID));

  check('scene id: a valid manifest flow_scene_id resolves BY ID',
    r(MANIFEST_ID, ROUTE_ID).kind === 'open-by-id' && r(MANIFEST_ID, ROUTE_ID).sceneId === MANIFEST_ID
    && r(MANIFEST_ID, ROUTE_ID).source === 'MANIFEST_FLOW_SCENE_ID',
    JSON.stringify(r(MANIFEST_ID, ROUTE_ID)));

  check('scene id: manifest id wins over the mounted route',
    r(MANIFEST_ID, ROUTE_ID).sceneId === MANIFEST_ID, r(MANIFEST_ID, ROUTE_ID).sceneId);

  check('scene id: a valid MOUNTED-ROUTE id is used when the manifest id is absent',
    r(undefined, ROUTE_ID).kind === 'open-by-id' && r(undefined, ROUTE_ID).sceneId === ROUTE_ID
    && r(undefined, ROUTE_ID).source === 'MOUNTED_ROUTE', JSON.stringify(r(undefined, ROUTE_ID)));

  check('scene id: an INVALID manifest id falls back to the mounted route, not to a title',
    r('  ', ROUTE_ID).source === 'MOUNTED_ROUTE' && r('not-a-scene-id', ROUTE_ID).source === 'MOUNTED_ROUTE',
    JSON.stringify([r('  ', ROUTE_ID), r('not-a-scene-id', ROUTE_ID)]));

  // Fail-closed cases: the resolver must never invent an identity.
  const unres = [r(undefined, null), r(null, undefined), r('', ''), r('nope', 'nope'), r({}, [])];
  check('scene id: missing/invalid ids FAIL CLOSED (never resolved)',
    unres.every((a: any) => a.kind === 'unresolved'), JSON.stringify(unres));

  check('scene id: the unresolved reason explains the refusal to attach by title',
    unres.every((a: any) => /refusing to attach by title/i.test(String(a.reason))), JSON.stringify(unres[0]));

  check('scene id: the resolver has no title-based path at all',
    !('title' in (r(MANIFEST_ID, ROUTE_ID) as any)) && !('title' in (unres[0] as any)),
    JSON.stringify(r(MANIFEST_ID, ROUTE_ID)));

  // The call site must actually use this resolver (guards against the helper being bypassed).
  check('runner resolves the attachment target before generating, via resolveSceneAttachmentTarget',
    /resolveSceneAttachmentTarget\(\{/.test(stageCode) && /flow_scene_id/.test(stageCode)
    && /mountedRouteSceneId:mounted\.ok\?mounted\.sceneId:null/.test(stageCode));

  check('runner throws (fails closed) when the attachment target is unresolved',
    /attachment target is not identifiable/.test(stageCode) && /target\.kind==='unresolved'/.test(stageCode));

  check('runner opens the scene by resolved id only, with no title fallback',
    /openSceneEditor\(target\.sceneId\)/.test(stageCode) && !/\(s as any\)\.title/.test(stageCode));
}
check('no fuzzy scene search is introduced', !/getByText|hasText|filter\(\{ ?hasText/.test(stageCode));
check('captured scene url is retained on the scene item', /flow_scene_url = opened\.url/.test(stageCode));

// ------------------------------------------- 11-12. narration/output naming intact
check('scene output naming convention scene-NNNN.mp4 is documented/preserved', /scene-NNNN\.mp4/.test(sceneStage));
check('no narration/post-production file names were touched by runner.ts', !/narration-manifest|mixed|final\.mp4/i.test(runnerSrc));

// ------------------------------------------------------------ 13-15. imports/misc
check('runner imports only what it needs from flowClient/selectors', /import \{ FlowClient \} from '\.\/flowClient\.js'/.test(runnerSrc) && /import \{ S \} from '\.\/selectors\.js'/.test(runnerSrc));
check('selectors.ts unchanged (no video-only selectors added by this step)', !/videoTab|videosTab|clipPersistenceHelper/.test(fs.readFileSync(path.join(SRC, 'selectors.ts'), 'utf8')));
// The previous assertion here was `runner does not import videoDecisions helpers directly
// (FlowClient owns them)` (`!/videoDecisions\.js/`). It enforced the PRE-hardening layering and
// directly contradicts the contract this file now asserts: id resolution must happen in the
// runner, before generation, or an unidentifiable scene would spend Flow credits. It was also
// unreachable while the suite died at the stale scene-identity assertions. Replaced with a
// POSITIVE guard on the import and on the ordering that makes the fail-closed path safe.
check('runner imports the scene-attachment resolver from videoDecisions.js', /import \{[^}]*\bresolveSceneAttachmentTarget\b[^}]*\} from '\.\/videoDecisions\.js'/.test(runnerSrc));
check('the resolver is called BEFORE generateProjectVideo (an unidentifiable scene costs zero credits)', stageCode.indexOf('resolveSceneAttachmentTarget({') >= 0 && stageCode.indexOf('resolveSceneAttachmentTarget({') < stageCode.indexOf('flow.generateProjectVideo('), JSON.stringify({ resolveAt: stageCode.indexOf('resolveSceneAttachmentTarget({'), generateAt: stageCode.indexOf('flow.generateProjectVideo(') }));

// ------------------------------------- pure lock-gate behaviour still enforced
{
  const p: any = {
    characters: [{ tag: '@CHAR-01-ARJUN', status: 'done', locked: true }],
    backgrounds: [{ tag: '#BGD-01-VILLAGE-STREET-WIDE', status: 'done', locked: true }],
    scenes: [{ scene_number: 1, title: 'Village Night', background_tag: '#BGD-01-VILLAGE-STREET-WIDE', character_tags: ['@CHAR-01-ARJUN'], speaker: 'NARRATOR', status: 'pending' }],
  };
  let ok = true;
  try { assertSceneAssetsLocked(p, p.scenes[0]); } catch { ok = false; }
  check('lock gate passes for locked assets', ok);
  let unlockedThrew = false;
  try { assertSceneAssetsLocked({ ...p, backgrounds: [{ tag: '#BGD-01-VILLAGE-STREET-WIDE', status: 'done', locked: false }] }, p.scenes[0]); } catch { unlockedThrew = true; }
  check('lock gate still blocks an unlocked background', unlockedThrew);
  let charThrew = false;
  try { assertSceneAssetsLocked({ ...p, characters: [{ tag: '@CHAR-01-ARJUN', status: 'done', locked: false }] }, p.scenes[0]); } catch { charThrew = true; }
  check('lock gate still blocks an unlocked character', charThrew);
  const plan = selectWork(p, { only: [1] });
  check('selectWork still resolves the scene subset (unchanged)', plan.scenes.length === 1 && plan.characters.length === 1 && plan.backgrounds.length === 1);
}

// --------------------------------------------------- 8K. runner uses reconciliation
check('8K runner calls reconcileGeneratedVideoWithScene with generated.title', /await flow\.reconcileGeneratedVideoWithScene\(generated\.title/.test(stageCode));
check('8K runner no longer calls attachVideoClipToTimeline directly', !/flow\.attachVideoClipToTimeline\(/.test(stageCode));
check('8AD runner lets reconcile own identity (passes the generated artifact id, no separate picker read)', /reconcileGeneratedVideoWithScene\(generated\.title, generated\.artifactId\)/.test(stageCode) && !/readGeneratedVideoArtifact|readVideoPickerArtifact/.test(stageCode));
check('8K runner still performs exactly one generation call', (stageCode.match(/flow\.generateProjectVideo\(/g) ?? []).length === 1);
check('8K runner still runs background/character attachment after reconciliation',
  stageCode.indexOf('reconcileGeneratedVideoWithScene') < stageCode.indexOf('selectAsset(String(assets?.background_tag))'));
check('8K no second generation or retry was introduced', !/for\s*\([^)]*\)\s*\{[^}]*generateProjectVideo/s.test(stageCode) && !/while\s*\([^)]*\)\s*\{[^}]*generateProjectVideo/s.test(stageCode));
check('8K flow_scene_url is still persisted after openSceneEditor', /flow_scene_url = opened\.url/.test(stageCode));
// REMOVED (was: '8K scene id/title preference unchanged (flow_scene_id then exact title)',
  // asserting `/flow_scene_id/ && /String\(\(s as any\)\.title/`). That required the obsolete
  // title-fallback source pattern, which the hardened id-only contract deliberately removed, and it
  // duplicated the behavioural scene-identity block above ("10. scene identity"), which asserts the
  // same contract far more strictly: manifest-id preference, mounted-route fallback, invalid-id
  // handling, fail-closed on unresolvable inputs, the refusal-to-title reason, and the zero-credit
  // ordering of the resolver before generateProjectVideo. No coverage is lost by deleting it; the
  // id-preference behaviour is still asserted, just behaviourally rather than by source text.

// ------------------------------------- behavioural prompt submission
// Executes the real runner scene stage with a fake Flow client. It proves the canonical lower-case
// WITH_lipsync prompt is selected, the builder (not the raw manifest prompt) is submitted, and no
// raw @CHAR-* / #BGD-* identifier reaches generation.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-wardrobe-'));
  const projectId = '11111111-1111-4111-8111-111111111111';
  const sceneId = '22222222-2222-4222-8222-222222222222';
  const bg = '#BGD-01-VILLAGE-STREET-WIDE';
  const char = '@CHAR-01-ARJUN';
  const scene: any = {
    scene_number: 1, title: 'Village Night', background_tag: bg, character_tags: [char],
    speaker: char, status: 'pending', flow_scene_id: sceneId, assets: { background_tag: bg, character_tags: [char] },
    animation_prompt_NARRATOR_ONLY: `ACTIVE ENVIRONMENT: ${bg}\nACTIVE CHARACTERS: ${char}\n\nNARRATOR_ONLY_MARKER`,
    animation_prompt_WITH_lipsync: `ACTIVE ENVIRONMENT: ${bg}\nACTIVE CHARACTERS: ${char}\n\nWITH_LIPSYNC_MARKER`,
  };
  const p: any = {
    project_id: 'offline-runner-test',
    characters: [{ tag: char, name: 'Arjun', status: 'done', locked: true, look_summary: '22-year-old Indian man, casual nightwear.' }],
    backgrounds: [{ tag: bg, status: 'done', locked: true, location_name: 'Village street', look_summary: 'Rainy village street at night.' }],
    scenes: [scene],
  };
  const file = path.join(tmp, 'pipeline.json');
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
  let submitted = '';
  let generationCalls = 0;
  const flow: any = {
    generateProjectVideo: async (prompt: string) => { submitted = prompt; generationCalls++; return { title: 'Generated', artifactId: '33333333-3333-4333-8333-333333333333' }; },
    openSceneEditor: async (id: string) => ({ url: `https://labs.google/fx/tools/flow/scene/${id}` }),
    reconcileGeneratedVideoWithScene: async () => undefined,
    selectAsset: async () => undefined,
  };
  const page = { url: () => `https://labs.google/fx/tools/flow/project/${projectId}` };
  await run(flow, page, p, file, path.join(tmp, 'out'), () => undefined, { characters: [], backgrounds: [], scenes: [scene] });
  check('behavioural: exactly one generation call', generationCalls === 1);
  check('behavioural: character speaker uses WITH_lipsync, not NARRATOR_ONLY',
    submitted.includes('WITH_LIPSYNC_MARKER') && !submitted.includes('NARRATOR_ONLY_MARKER'));
  check('behavioural: generation receives no raw machine identifiers', !/#BGD|@CHAR/.test(submitted));
  check('behavioural: generation receives canonical human descriptions', submitted.includes('Rainy village street at night.') && submitted.includes('22-year-old Indian man'));
  check('behavioural: generation receives the scene builder restraints', submitted.includes('### OUTPUT RESTRAINTS (absolute)'));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nVIDEO-RUNNER-INTEGRATION TESTS PASSED (${passed} checks)`);
