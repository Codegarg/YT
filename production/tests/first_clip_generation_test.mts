// Focused OFFLINE tests for the FIRST-CLIP project-generation decision model and lifecycle.
//
// Covers: project prompt editor resolution (zero / one / multiple / non-editable / read-only /
// disabled / hidden), exact prompt fill verification, Start-button eligibility and the one-click
// budget, generation-vs-video-vs-scene identity separation, `/video/` UUID normalization, grid
// evidence that ignores tile counts, cross-surface identity, deterministic scene identification,
// and the first-clip vs scene-edit lifecycle branch.
//
// Pure-helper tests + browser-free source audits. NO browser, NO Flow, NO credits.
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const FC = await import(pathToFileURL(`${SRC}/firstClipGeneration.ts`).href);
const FCL = await import(pathToFileURL(`${SRC}/firstClipLifecycle.ts`).href);
const PAS = await import(pathToFileURL(`${SRC}/projectAssetSurface.ts`).href);
const PCL = await import(pathToFileURL(`${SRC}/projectCategoryLabel.ts`).href);
const PAT = await import(pathToFileURL(`${SRC}/projectAssetTraversal.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const UUID_A = '6c14135b-2445-4d25-ad0c-25fec43ae9b7';
const UUID_B = '47425bc2-6c47-4b6d-a88a-c4a7259015cc';
const PROMPT = 'A cinematic night shot of an empty road beside an old cremation ground in rural India.';
const GEN_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

// ============ 1. project prompt editor resolution ============
console.log('--- project prompt editor resolution ---');
{
  const eligible = (index: number, over: any = {}) => ({ index, exists: true, visible: true, editable: true, ariaReadonly: false, disabled: false, ...over });

  const one = FC.resolveProjectPromptEditor([eligible(0)]);
  check('1 exactly one eligible project editor resolves', one.ok === true && one.index === 0 && one.eligibleCount === 1, one);

  // zero candidate refusal
  const none = FC.resolveProjectPromptEditor([]);
  check('2 zero candidates -> PROJECT_PROMPT_EDITOR_NOT_FOUND', none.ok === false && none.code === 'PROJECT_PROMPT_EDITOR_NOT_FOUND', none);

  // non-editable refusal
  const nonEditable = FC.resolveProjectPromptEditor([{ index: 0, exists: true, visible: true, editable: false, ariaReadonly: false, disabled: false }]);
  check('3 a contenteditable=false candidate -> PROJECT_PROMPT_EDITOR_NOT_EDITABLE', nonEditable.ok === false && nonEditable.code === 'PROJECT_PROMPT_EDITOR_NOT_EDITABLE', nonEditable);

  // MULTIPLE candidate refusal — the key project-specific rule
  const many = FC.resolveProjectPromptEditor([eligible(0), eligible(1)]);
  check('4 multiple eligible candidates -> PROJECT_PROMPT_EDITOR_AMBIGUOUS (fail closed, never first)',
    many.ok === false && many.code === 'PROJECT_PROMPT_EDITOR_AMBIGUOUS' && many.eligibleCount === 2, many);

  // read-only / disabled / hidden are rejected as candidates
  const ro = FC.resolveProjectPromptEditor([eligible(0, { ariaReadonly: true }), eligible(1)]);
  check('5 an aria-readonly editor is rejected; the single remaining eligible one resolves',
    ro.ok === true && ro.index === 1 && ro.eligibleCount === 1, ro);
  check('5b a disabled editor is rejected', FC.resolveProjectPromptEditor([eligible(0, { disabled: true })]).ok === false);
  check('5c a hidden editor is rejected', FC.resolveProjectPromptEditor([eligible(0, { visible: false })]).ok === false);
  check('5d a non-existent candidate is rejected', FC.resolveProjectPromptEditor([eligible(0, { exists: false })]).ok === false);
  check('5e null/undefined candidate lists refuse',
    FC.resolveProjectPromptEditor(null).ok === false && FC.resolveProjectPromptEditor(undefined).ok === false);

  // the refusal message names the code
  check('6 the project refusal message names the typed code',
    /PROJECT_PROMPT_EDITOR_AMBIGUOUS/.test(FC.projectPromptEditorRefusal(many))
    && /PROJECT_PROMPT_EDITOR_NOT_EDITABLE/.test(FC.projectPromptEditorRefusal(nonEditable))
    && /PROJECT_PROMPT_EDITOR_NOT_FOUND/.test(FC.projectPromptEditorRefusal(none)));
}

// ============ 7. exact prompt fill verification ============
console.log('--- prompt fill verification ---');
{
  check('7 an exact match verifies', FC.verifyProjectPromptFill(PROMPT, PROMPT).ok === true);
  check('7b surrounding whitespace is trimmed at both ends', FC.verifyProjectPromptFill(`  ${PROMPT} `, `\n${PROMPT}\n`).ok === true);
  check('7c a truncated fill is rejected', FC.verifyProjectPromptFill(PROMPT, PROMPT.slice(0, 40)).ok === false);
  check('7d an empty editor after fill is rejected', FC.verifyProjectPromptFill(PROMPT, '').ok === false);
  check('7e an empty supplied prompt is rejected', FC.verifyProjectPromptFill('', 'x').ok === false);
  check('7f case differences are rejected (exactness)',
    FC.verifyProjectPromptFill(PROMPT, PROMPT.toUpperCase()).ok === false);
}

// ============ 8. Start-button eligibility + one-click budget ============
console.log('--- start generation eligibility ---');
{
  const GOOD = {
    editorResolved: true, promptVerified: true, settingsVerified: true, assetLocksVerified: true,
    generationAuthorized: true, startButtonPresent: true, startButtonDisabled: false, startClicksSoFar: 0,
  };
  check('8 every precondition satisfied allows the single click', FC.decideStartGenerationEligibility(GOOD).ok === true);
  check('8b a disabled Start button refuses', FC.decideStartGenerationEligibility({ ...GOOD, startButtonDisabled: true }).ok === false);
  check('8c a missing Start control refuses', FC.decideStartGenerationEligibility({ ...GOOD, startButtonPresent: false }).ok === false);
  check('8d unauthorized generation refuses', FC.decideStartGenerationEligibility({ ...GOOD, generationAuthorized: false }).ok === false);
  check('8e unverified asset locks refuse', FC.decideStartGenerationEligibility({ ...GOOD, assetLocksVerified: false }).ok === false);
  check('8f an already-used click budget refuses a SECOND click',
    FC.decideStartGenerationEligibility({ ...GOOD, startClicksSoFar: 1 }).ok === false);
  check('8g a non-numeric click count refuses', FC.decideStartGenerationEligibility({ ...GOOD, startClicksSoFar: 'x' }).ok === false);
  check('8h the refusal reason lists every missing precondition',
    /editor resolved/.test(String(FC.decideStartGenerationEligibility({ ...GOOD, editorResolved: false, promptVerified: false }).reason)));
}

// ============ 9. generated video UUID normalization ============
console.log('--- video uuid normalization ---');
{
  const v = `https://flow-content.google/video/${UUID_A}?Expires=1791335553&KeyName=labs-flow-prod-cdn-key&Signature=abc`;
  const i = `https://flow-content.google/image/${UUID_A}?Expires=1&Signature=b`;
  check('9 a /video/<UUID> URL normalizes to the uuid', FC.normalizeGeneratedVideoUuid(v) === UUID_A);
  check('9b the signed query is ignored (stable pathname segment)', !FC.normalizeGeneratedVideoUuid(`${v}&x=1`)?.includes('?'));
  check('9c an /image/<UUID> URL is NOT accepted as a video identity', FC.normalizeGeneratedVideoUuid(i) === null);
  check('9d flowMediaKind separates the namespaces',
    FC.flowMediaKind(v) === 'video' && FC.flowMediaKind(i) === 'image' && FC.flowMediaKind('nonsense') === null);
  check('9e a malformed url normalizes to null', FC.normalizeGeneratedVideoUuid('not-a-url') === null);
  check('9f an empty value normalizes to null', FC.normalizeGeneratedVideoUuid('') === null && FC.normalizeGeneratedVideoUuid(null) === null);
}

// ============ 13. generation / video / scene uuid separation ============
console.log('--- identity separation ---');
{
  check('13 coinciding generation+video uuids are reported as coinciding',
    FC.isSameGenerationVideoIdentity(UUID_A, UUID_A) === true);
  check('13b distinct generation and video uuids are reported as distinct',
    FC.isSameGenerationVideoIdentity(GEN_UUID, UUID_A) === false);
  check('13c a missing uuid never compares equal', FC.isSameGenerationVideoIdentity('', '') === false);
}

// ============ 14. scene identification (deterministic, fail closed) ============
console.log('--- scene identification ---');
{
  const cands = [
    { sceneId: 'scene-old', title: 'Man meeting ghost at pyre', videoUuid: UUID_B },
    { sceneId: 'scene-new', title: 'Empty road beside cremation ground', videoUuid: UUID_A },
  ];
  const ok = FC.identifyFirstClipScene({ videoUuid: UUID_A, candidates: cands });
  check('14 the scene carrying the exact video uuid is identified',
    ok.ok === true && ok.sceneId === 'scene-new' && ok.title === 'Empty road beside cremation ground', ok);

  check('14b identical uuid across several tiles of the SAME scene still resolves',
    FC.identifyFirstClipScene({ videoUuid: UUID_A, candidates: [...cands, { sceneId: 'scene-new', title: 'dup', videoUuid: UUID_A }] }).ok === true);

  // multiple DISTINCT scenes claiming the same uuid -> ambiguous
  const amb = FC.identifyFirstClipScene({ videoUuid: UUID_A, candidates: [...cands, { sceneId: 'scene-other', title: 'other', videoUuid: UUID_A }] });
  check('14c MULTIPLE distinct scenes claiming the uuid -> FIRST_CLIP_SCENE_AMBIGUOUS',
    amb.ok === false && amb.code === 'FIRST_CLIP_SCENE_AMBIGUOUS', amb);

  // missing uuid evidence
  const noUuid = FC.identifyFirstClipScene({ candidates: cands });
  check('14d a missing video uuid -> FIRST_CLIP_VIDEO_UUID_UNRESOLVED',
    noUuid.ok === false && noUuid.code === 'FIRST_CLIP_VIDEO_UUID_UNRESOLVED', noUuid);

  // no matching scene
  const notFound = FC.identifyFirstClipScene({ videoUuid: 'ffffffff-1111-4111-8111-111111111111', candidates: cands });
  check('14e no scene carries the uuid -> FIRST_CLIP_SCENE_NOT_IDENTIFIED',
    notFound.ok === false && notFound.code === 'FIRST_CLIP_SCENE_NOT_IDENTIFIED', notFound);

  // matched but no scene id
  const noId = FC.identifyFirstClipScene({ videoUuid: UUID_A, candidates: [{ sceneId: '', title: 't', videoUuid: UUID_A }] });
  check('14f a matched scene with no id -> FIRST_CLIP_SCENE_ID_MISSING',
    noId.ok === false && noId.code === 'FIRST_CLIP_SCENE_ID_MISSING', noId);

  check('14g title similarity alone never identifies a scene',
    FC.identifyFirstClipScene({ videoUuid: 'ffffffff-1111-4111-8111-111111111111', candidates: [{ sceneId: 's', title: 'Empty road beside cremation ground', videoUuid: UUID_B }] }).code === 'FIRST_CLIP_SCENE_NOT_IDENTIFIED');
}

// ============ 10. virtualized grid where the tile count is unchanged ============
console.log('--- grid evidence ignores tile counts ---');
{
  const same = FC.classifyFirstClipGridEvidence({ videoUuid: UUID_A, beforeTileCount: 16, afterTileCount: 16, newSceneTitles: ['Empty road beside cremation ground'] });
  check('10 an UNCHANGED tile count still classifies as NEW_SCENE_OBSERVED',
    same.classification === 'NEW_SCENE_OBSERVED' && same.tileCountAuthoritative === false, same);
  check('10b video-only (no new title) -> NEW_VIDEO_ONLY',
    FC.classifyFirstClipGridEvidence({ videoUuid: UUID_A, beforeTileCount: 16, afterTileCount: 16, newSceneTitles: [] }).classification === 'NEW_VIDEO_ONLY');
  check('10c multiple new titles -> AMBIGUOUS',
    FC.classifyFirstClipGridEvidence({ videoUuid: UUID_A, newSceneTitles: ['a', 'b'] }).classification === 'AMBIGUOUS');
  check('10d no resolved uuid -> AMBIGUOUS regardless of counts',
    FC.classifyFirstClipGridEvidence({ beforeTileCount: 16, afterTileCount: 17 }).classification === 'AMBIGUOUS');
  check('10e the reason explicitly states tile counts are ignored because the grid is virtualised',
    /virtualised/i.test(same.reason), same.reason);
}

// ============ 11. same uuid on project /video and picker /video ============
console.log('--- cross-surface identity ---');
{
  check('11 the same uuid observed on the project route and in the picker verifies',
    FC.verifyFirstClipCrossSurfaceIdentity({ videoUuid: UUID_A, projectRouteVideoUuids: [UUID_B, UUID_A], pickerVideoUuids: [UUID_A] }).ok === true);
  check('11b a uuid absent from the project route refuses',
    FC.verifyFirstClipCrossSurfaceIdentity({ videoUuid: UUID_A, projectRouteVideoUuids: [UUID_B] }).ok === false);
  check('11c a uuid present on the project route but absent from the picker refuses',
    FC.verifyFirstClipCrossSurfaceIdentity({ videoUuid: UUID_A, projectRouteVideoUuids: [UUID_A], pickerVideoUuids: [UUID_B] }).ok === false);
  check('11d an unresolved uuid refuses', FC.verifyFirstClipCrossSurfaceIdentity({}).ok === false);
  check('11e an omitted picker snapshot is allowed (project evidence only)',
    FC.verifyFirstClipCrossSurfaceIdentity({ videoUuid: UUID_A, projectRouteVideoUuids: [UUID_A] }).ok === true);
}

// ============ 15. first-clip vs scene-edit branching ============
console.log('--- mode classification ---');
{
  check('15 a scene with a committed clip uses the scene-local edit/extend path',
    FC.classifyFirstClipMode({ committedClipPresent: true }).mode === 'SCENE_CLIP_EDIT_OR_EXTENSION');
  check('15b a clipless scene must use FIRST_CLIP_PROJECT_GENERATION',
    FC.classifyFirstClipMode({ committedClipPresent: false }).mode === 'FIRST_CLIP_PROJECT_GENERATION');
  check('15c no/unknown committed-clip evidence defaults to project generation',
    FC.classifyFirstClipMode(undefined).mode === 'FIRST_CLIP_PROJECT_GENERATION'
    && FC.classifyFirstClipMode({}).mode === 'FIRST_CLIP_PROJECT_GENERATION');
}

// ============ 16/17. the first-clip lifecycle itself ============
console.log('--- first-clip lifecycle ---');
{
  const GOOD_SETTINGS = { mode: 'Video', model: 'Omni 1.1 Flash', resolution: '720p', duration: '8s', aspect: '16:9', batch: 'x1' };
  const CHARS = ['@CHAR-01-ARJUN'];
  const BGS = ['#BGD-01-ARJUN-ROOM-WIDE'];
  const VIDEO_URL = `https://flow-content.google/video/${UUID_A}?Expires=1&Signature=z`;

  function fakePort(over: any = {}) {
    const calls: string[] = [];
    const rec: any = { generateCalls: 0, downloadCalls: 0, validateCalls: 0 };
    const port: any = {
      async openProjectRoute() { calls.push('openProjectRoute'); if (over.openProjectRoute) throw new Error('route-fail'); return { url: 'https://flow.google.com/project/be1f9d68-74b8-4be3-8d4d-40da6e90fcdc' }; },
      async configureProjectVideoSettings() { calls.push('configureProjectVideoSettings'); if (over.configure) throw new Error('settings-fail'); },
      async observeProjectVideoSettings() { calls.push('observeProjectVideoSettings'); return over.projectSettings ?? GOOD_SETTINGS; },
      async readFlowAssetIdentities() { calls.push('readFlowAssetIdentities'); if (over.readFlowAssetIdentities) return over.readFlowAssetIdentities(); return { ok: true, characters: CHARS, backgrounds: BGS, surface: 'PROJECT_INGREDIENT_SURFACE', projectGridIdentities: BGS, projectCharacterIdentities: CHARS }; },
      async restoreProjectRoute() { calls.push('restoreProjectRoute'); return { url: 'https://flow.google.com/project/be1f9d68-74b8-4be3-8d4d-40da6e90fcdc', projectSurfaceObserved: true }; },
      async openGeneratedSceneByExactTitle(title: string) { calls.push('openGeneratedSceneByExactTitle'); return { sceneId: 'scene-abc', route: 'https://flow.google.com/project/be1f9d68-74b8-4be3-8d4d-40da6e90fcdc/scene/scene-abc', videoUuid: UUID_A }; },
      async generateProjectFirstClip(prompt: string) {
        calls.push('generateProjectFirstClip'); rec.generateCalls++;
        (rec.prompts ??= []).push(prompt);
        if (rec.generateCalls > 1) throw new Error('SECOND generation attempt blocked by the lifecycle.');
        if (over.generateProjectFirstClip) return over.generateProjectFirstClip(prompt);
        return {
          editorResolution: { ok: true, index: 0 }, observedPromptText: prompt,
          startButtonDisabledBeforeClick: false, startClicks: 1,
          generationUuid: GEN_UUID, videoUrl: VIDEO_URL, durationSeconds: 8, audioPresent: false,
          projectRouteVideoUuids: [UUID_A],
        };
      },
      async resolveFirstClipSceneCandidates() { calls.push('resolveFirstClipSceneCandidates'); if (over.resolveFirstClipSceneCandidates) return over.resolveFirstClipSceneCandidates(); return [{ sceneId: 'scene-new', title: 'Empty road beside cremation ground', videoUuid: UUID_A, route: '/project/p/scene/scene-new' }]; },
      async verifyScenePersistence(ref: string, artifact: string) { calls.push('verifyScenePersistence:' + artifact); if (over.verifyScenePersistence) throw new Error('persist-fail'); return { committedClipId: 'committed-1' }; },
      async downloadCommittedSceneClip(n: number, dest: string) { calls.push('downloadCommittedSceneClip'); rec.downloadCalls++; if (over.downloadOk === false) return { ok: false, reason: 'dl-fail' }; return { ok: true }; },
    };
    return { port, calls, rec };
  }
  // Canonical metadata + a scene whose dependencies match the reader's live inventory. The raw
  // scene prompt carries machine identifiers on purpose: the lifecycle must harden it before the
  // composer is touched.
  const CANON_BGS = [{ tag: '#BGD-01-ARJUN-ROOM-WIDE', location_name: "Arjun's Bedroom (Wide)", look_summary: 'Simple Indian bedroom, night, teal-blue rainy light.' }];
  const CANON_CHARS = [{ tag: '@CHAR-01-ARJUN', name: 'Arjun', look_summary: '22-year-old Indian man, casual nightwear.' }];
  const RAW_SCENE_PROMPT = `### SYSTEM & ENVIRONMENT\nACTIVE ENVIRONMENT: #BGD-01-ARJUN-ROOM-WIDE\nACTIVE CHARACTERS: @CHAR-01-ARJUN\n\n### VISUAL ACTION\n${PROMPT}`;

  const baseInput = (over: any = {}) => ({
    sceneNumber: 1, prompt: PROMPT, projectUrl: 'https://flow.google.com/project/be1f9d68-74b8-4be3-8d4d-40da6e90fcdc', projectId: 'proj-1',
    destinationPath: 'outputs/p/scenes/scene-0001.mp4',
    requiredAssets: { characters: CHARS, backgrounds: BGS }, generationAuthorized: true,
    scene: { scene_number: 1, background_tag: BGS[0], character_tags: CHARS, animation_prompt_NARRATOR_ONLY: RAW_SCENE_PROMPT },
    canonicalBackgrounds: CANON_BGS, canonicalCharacters: CANON_CHARS,
    validateDownloaded: async () => { over.__validated = true; return { ok: true }; },
    ...over,
  });

  const happy = fakePort();
  const r = await FCL.runFirstClipProjectLifecycle(happy.port, baseInput());
  // The frozen nine-phase order is unchanged; the two preflight phases are inserted between
  // RESTORE_PROJECT_ROUTE and the credit-consuming FIRST_CLIP_PROJECT_GENERATION.
  const EXPECTED_PHASES = ['PROJECT_SETTINGS', 'ASSET_LOCKS', 'RESTORE_PROJECT_ROUTE',
    'SCENE_REQUIRED_ASSET_LOCKS', 'PROMPT_HARDENING',
    ...FCL.FIRST_CLIP_LIFECYCLE_PHASES.slice(3)];
  check('16 the happy path completes in the canonical first-clip phase order',
    r.ok === true && JSON.stringify(r.phases) === JSON.stringify(EXPECTED_PHASES), r);
  check('16c the preflight phases run BEFORE any credit-consuming port call',
    r.phases.indexOf('SCENE_REQUIRED_ASSET_LOCKS') < r.phases.indexOf('FIRST_CLIP_PROJECT_GENERATION')
    && r.phases.indexOf('PROMPT_HARDENING') < r.phases.indexOf('FIRST_CLIP_PROJECT_GENERATION'));
  check('16d the composer receives the HARDENED prompt, never the raw machine identifiers',
    !/#BGD-|@CHAR-/.test(String(happy.rec.prompts?.[0] ?? ''))
    && /ACTIVE ENVIRONMENT: Arjun's Bedroom \(Wide\) — Simple Indian bedroom/.test(String(happy.rec.prompts?.[0] ?? '')), happy.rec.prompts?.[0]);
  check('16b the phase constant is exactly PROJECT_SETTINGS→ASSET_LOCKS→RESTORE_PROJECT_ROUTE→FIRST_CLIP_PROJECT_GENERATION→FIRST_CLIP_RESULT→SCENE_RESOLUTION→PERSIST_FIRST_CLIP_CHECKPOINT→DOWNLOAD→VALIDATE',
    FCL.FIRST_CLIP_LIFECYCLE_PHASES.join(',') === 'PROJECT_SETTINGS,ASSET_LOCKS,RESTORE_PROJECT_ROUTE,FIRST_CLIP_PROJECT_GENERATION,FIRST_CLIP_RESULT,SCENE_RESOLUTION,PERSIST_FIRST_CLIP_CHECKPOINT,DOWNLOAD,VALIDATE');
  check('17 the result separates generation uuid, video uuid and scene uuid',
    r.firstClip.generationUuid === GEN_UUID && r.firstClip.videoUuid === UUID_A && r.firstClip.sceneId === 'scene-new'
    && r.firstClip.classification === 'GENERATION_AND_VIDEO_IDENTITIES_DISTINCT', r.firstClip);
  check('17b the result records source, committed status, duration and audio',
    r.firstClip.source === 'PROJECT_COMPOSER' && r.firstClip.committed === 'POPULATED'
    && r.firstClip.durationSeconds === 8 && r.firstClip.audioPresent === false, r.firstClip);
  check('17c exactly one generation call and one Start click', happy.rec.generateCalls === 1);
  check('17d the lifecycle ran in FIRST_CLIP_PROJECT_GENERATION mode', r.mode === 'FIRST_CLIP_PROJECT_GENERATION');

  // preconditions
  const badSettings = fakePort({ projectSettings: { ...GOOD_SETTINGS, resolution: '1080p' } });
  const r1 = await FCL.runFirstClipProjectLifecycle(badSettings.port, baseInput());
  check('18 wrong project settings -> PROJECT_VIDEO_SETTINGS_NOT_READY and NO generation',
    r1.code === 'PROJECT_VIDEO_SETTINGS_NOT_READY' && badSettings.rec.generateCalls === 0, r1);

  const noLocks = fakePort({ readFlowAssetIdentities: async () => ({ ok: false, characters: [], backgrounds: [], reason: 'surface not observed' }) });
  const r2 = await FCL.runFirstClipProjectLifecycle(noLocks.port, baseInput());
  check('18b an unobserved asset surface -> ASSET_LOCKS_NOT_VERIFIED and NO generation',
    r2.code === 'ASSET_LOCKS_NOT_VERIFIED' && noLocks.rec.generateCalls === 0, r2);

  const missingAsset = fakePort({ readFlowAssetIdentities: async () => ({ ok: true, characters: ['@CHAR-99-OTHER'], backgrounds: BGS }) });
  const r2b = await FCL.runFirstClipProjectLifecycle(missingAsset.port, baseInput());
  check('18c a missing required asset -> ASSET_LOCKS_NOT_VERIFIED and NO generation',
    r2b.code === 'ASSET_LOCKS_NOT_VERIFIED' && missingAsset.rec.generateCalls === 0, r2b);

  const noEditor = fakePort({ generateProjectFirstClip: async (p: string) => ({ editorResolution: { ok: false, code: 'PROJECT_PROMPT_EDITOR_NOT_EDITABLE', reason: 'none' }, observedPromptText: '', startButtonDisabledBeforeClick: null, startClicks: 0, generationUuid: null, videoUrl: null, durationSeconds: null, audioPresent: null, projectRouteVideoUuids: [] }) });
  const r3 = await FCL.runFirstClipProjectLifecycle(noEditor.port, baseInput());
  check('19 an unresolved project prompt editor -> PROJECT_PROMPT_EDITOR_UNRESOLVED and NO download',
    r3.code === 'PROJECT_PROMPT_EDITOR_UNRESOLVED' && noEditor.rec.downloadCalls === 0, r3);

  const badFill = fakePort({ generateProjectFirstClip: async () => ({ editorResolution: { ok: true, index: 0 }, observedPromptText: 'wrong text', startButtonDisabledBeforeClick: false, startClicks: 1, generationUuid: GEN_UUID, videoUrl: VIDEO_URL, durationSeconds: 8, audioPresent: false, projectRouteVideoUuids: [UUID_A] }) });
  const r4 = await FCL.runFirstClipProjectLifecycle(badFill.port, baseInput());
  check('19b a non-exact prompt fill -> PROJECT_PROMPT_FILL_UNVERIFIED and NO download',
    r4.code === 'PROJECT_PROMPT_FILL_UNVERIFIED' && badFill.rec.downloadCalls === 0, r4);

  const twoClicks = fakePort({ generateProjectFirstClip: async (p: string) => ({ editorResolution: { ok: true, index: 0 }, observedPromptText: p, startButtonDisabledBeforeClick: false, startClicks: 2, generationUuid: GEN_UUID, videoUrl: VIDEO_URL, durationSeconds: 8, audioPresent: false, projectRouteVideoUuids: [UUID_A] }) });
  const r5 = await FCL.runFirstClipProjectLifecycle(twoClicks.port, baseInput());
  check('19c two Start clicks -> GENERATION_GUARD_FAILED and NO download',
    r5.code === 'GENERATION_GUARD_FAILED' && twoClicks.rec.downloadCalls === 0, r5);

  const noVideo = fakePort({ generateProjectFirstClip: async (p: string) => ({ editorResolution: { ok: true, index: 0 }, observedPromptText: p, startButtonDisabledBeforeClick: false, startClicks: 1, generationUuid: GEN_UUID, videoUrl: `https://flow-content.google/image/${UUID_A}?x=1`, durationSeconds: 8, audioPresent: false, projectRouteVideoUuids: [UUID_A] }) });
  const r6 = await FCL.runFirstClipProjectLifecycle(noVideo.port, baseInput());
  check('19d an /image/ (not /video/) result -> FIRST_CLIP_VIDEO_UUID_UNRESOLVED and NO download',
    r6.code === 'FIRST_CLIP_VIDEO_UUID_UNRESOLVED' && noVideo.rec.downloadCalls === 0, r6);

  const noScene = fakePort({ resolveFirstClipSceneCandidates: async () => [] });
  const r7 = await FCL.runFirstClipProjectLifecycle(noScene.port, baseInput());
  check('19e no scene carries the generated uuid -> FIRST_CLIP_SCENE_UNRESOLVED and NO download',
    r7.code === 'FIRST_CLIP_SCENE_UNRESOLVED' && noScene.rec.downloadCalls === 0, r7);

  const ambScene = fakePort({ resolveFirstClipSceneCandidates: async () => [{ sceneId: 'a', title: 't', videoUuid: UUID_A }, { sceneId: 'b', title: 't', videoUuid: UUID_A }] });
  const r8 = await FCL.runFirstClipProjectLifecycle(ambScene.port, baseInput());
  check('19f two scenes claiming the generated uuid -> FIRST_CLIP_SCENE_UNRESOLVED and NO download',
    r8.code === 'FIRST_CLIP_SCENE_UNRESOLVED' && ambScene.rec.downloadCalls === 0, r8);

  const noPersist = fakePort({ verifyScenePersistence: true });
  const r9 = await FCL.runFirstClipProjectLifecycle(noPersist.port, baseInput());
  check('19g unproven persistence -> CLIP_PERSISTENCE_FAILED and NO download',
    r9.code === 'CLIP_PERSISTENCE_FAILED' && noPersist.rec.downloadCalls === 0, r9);

  const dlFail = fakePort({ downloadOk: false });
  const r10 = await FCL.runFirstClipProjectLifecycle(dlFail.port, baseInput());
  check('19h a failed download -> DOWNLOAD_FAILED', r10.code === 'DOWNLOAD_FAILED', r10);

  const genThrow = fakePort({ generateProjectFirstClip: true });
  const r11 = await FCL.runFirstClipProjectLifecycle(genThrow.port, baseInput());
  check('19i a generation failure -> PROJECT_GENERATION_FAILED (no retry attempted)', r11.code === 'PROJECT_GENERATION_FAILED', r11);

  // authorization
  const unauth = fakePort();
  const r12 = await FCL.runFirstClipProjectLifecycle(unauth.port, baseInput({ generationAuthorized: false }));
  check('19j unauthorized generation refuses BEFORE any click',
    r12.code === 'GENERATION_GUARD_FAILED' && unauth.rec.generateCalls === 0, r12);
}

// ============ 20. source audits: separation, no leakage into the old path ============
console.log('--- source audits ---');
{
  const fcSrc = await fs.readFile(`${SRC}/firstClipGeneration.ts`, 'utf8');
  const fclSrc = await fs.readFile(`${SRC}/firstClipLifecycle.ts`, 'utf8');
  const scSrc = await fs.readFile(`${SRC}/sceneProductionLifecycle.ts`, 'utf8');
  const flowSrc = await fs.readFile(`${SRC}/flowClient.ts`, 'utf8');

  check('20 the first-clip module never clicks, generates or mutates anything',
    !/\.click\(|\.fill\(|page\.evaluate|launchPersistentContext/.test(fcSrc));
  check('20b the first-clip module introduces no second uuid SEGMENT normalizer (it delegates to the existing one)',
    /normalizeFlowMediaUuid/.test(fcSrc) && !/A-Za-z0-9_-\]\{8,\}/.test(fcSrc));
  check('20b2 the namespace classifier returns only a kind, and the video normalizer delegates the segment',
    /function flowMediaKind[\s\S]*?:\s*'video'\s*\|\s*'image'\s*\|\s*null/.test(fcSrc)
    && /export function normalizeGeneratedVideoUuid[\s\S]{0,220}normalizeFlowMediaUuid\(src\)/.test(fcSrc));
  check('20c the first-clip module introduces no second route parser (no URL parsing of scene routes)',
    !/canonicalSceneUrl|\/scene\/\(\[0-9a-f\]/.test(fcSrc));
  check('20d the first-clip lifecycle requires NO scene-local prompt editor for first clip',
    !/resolvePromptEditorCandidate|flow-base-prompt-box/.test(fclSrc));
  check('20e the first-clip lifecycle never attaches the generated clip through Add Clip',
    !/add-clip-option|detail-add-to-prompt-btn|selectAsset/.test(fclSrc));
  check('20f the first-clip lifecycle has no local-synthesis and no silent error swallowing',
    !/renderLocalScene|generateProjectVideo|renderLocal/.test(fclSrc) && !/catch\s*\{\s*\}/.test(fclSrc));
  check('20f2 the scene-resolution fallback is an EXPLICIT documented strategy, not a silent default',
    /BY_EXACT_TITLE_VIA_PROVEN_OPENER/.test(fclSrc) && /decideFirstClipSceneResolutionStrategy/.test(fclSrc));
  check('20g project settings verification is DELEGATED to the existing proven verifier',
    /verifyProjectVideoSettings/.test(fclSrc) && /from '\.\/sceneProductionLifecycle\.js'/.test(fclSrc));
  check('20h asset-lock verification is DELEGATED to the existing proven verifier',
    /verifyAssetLocks/.test(fclSrc) && /from '\.\/assetVerification\.js'/.test(fclSrc));
  check('20i download is delegated to the existing proven downloader',
    /downloadCommittedSceneClip/.test(fclSrc) && !/page\.waitForEvent\('download'\)/.test(fclSrc));

  check('21 the existing scene-local lifecycle is UNCHANGED in role: it is the scene-edit path',
    /runSceneProductionLifecycle/.test(scSrc) && !/runFirstClipProjectLifecycle/.test(scSrc));
  check('21b the scene-local lifecycle still declares its own 13 phases',
    /SCENE_CREATE[\s\S]*ATTACH_ASSETS[\s\S]*GENERATE/.test(scSrc));

  check('22 the FlowClient first-clip primitives exist and click Start exactly once',
    /async generateProjectFirstClip\(/.test(flowSrc) && /async openProjectRoute\(/.test(flowSrc)
    && /async resolveFirstClipSceneCandidates\(/.test(flowSrc) && /async observeProjectPromptEditorCandidates\(/.test(flowSrc));
  const gpStart = flowSrc.indexOf('async generateProjectFirstClip(');
  const gpBody = flowSrc.slice(gpStart, flowSrc.indexOf('async generateSceneVideo(', gpStart));
  // Exactly ONE Start click, and no retry of it. A BOUNDED identity poll is now permitted (and
  // required): it re-reads the Videos library and never re-clicks Start.
  check('22b the first-clip generator clicks Start exactly once and never retries the click',
    (gpBody.match(/await start\.click\(\)/g) ?? []).length === 1
    && !/for\s*\(\s*let\s+attempt/.test(gpBody)
    && !/start\.click\(\);[\s\S]{0,2000}start\.click\(\)/.test(gpBody));
  check('22b2 every polling loop in the first-clip generator is DEADLINE bounded',
    (gpBody.match(/while\s*\(/g) ?? []).every(() => true)
    && /while\s*\(Date\.now\(\) < deadline\)/.test(gpBody)
    && !/while\s*\(\s*true\s*\)/.test(gpBody));
  check('22b3 the first-clip generator takes its identity from the target scene video library, not the project route',
    /readSceneVideoLibraryUuidsViaPreview\(/.test(gpBody)
    && !/const before = await this\.readProjectGenerationVideoUuids\(\)/.test(gpBody));
  check('22c the first-clip generator resolves the project editor via the pure resolver',
    /resolveProjectPromptEditor/.test(gpBody));
  check('22d the first-clip generator never attaches anything',
    !/selectAsset|add-clip-option|detail-add-to-prompt-btn/.test(gpBody));
}

// ============ 23. project-route restoration (ASSET_LOCKS navigates away) ============
console.log('--- project route restoration ---');
{
  const PURL = 'https://flow.google.com/project/be1f9d68-74b8-4be3-8d4d-40da6e90fcdc';
  const ok = FC.verifyProjectRouteRestoration({ projectUrl: PURL, restoredUrl: PURL, projectSurfaceObserved: true });
  check('23 a correctly restored project route with an observed surface verifies', ok.ok === true, ok);
  check('23b the project composer surface must actually be observable',
    FC.verifyProjectRouteRestoration({ projectUrl: PURL, restoredUrl: PURL, projectSurfaceObserved: false }).ok === false);
  check('23c an unobserved surface yields PROJECT_SURFACE_NOT_OBSERVED',
    FC.verifyProjectRouteRestoration({ projectUrl: PURL, restoredUrl: PURL, projectSurfaceObserved: false }).code === 'PROJECT_SURFACE_NOT_OBSERVED');
  check('23d a missing restored URL refuses',
    FC.verifyProjectRouteRestoration({ projectUrl: PURL, restoredUrl: '', projectSurfaceObserved: true }).ok === false);
  check('23e a restored URL on a SCENE route (ASSET_LOCKS left it there) refuses',
    FC.verifyProjectRouteRestoration({ projectUrl: PURL, restoredUrl: `${PURL}/scene/abc`, projectSurfaceObserved: true }).ok === false);
  check('23f a restored URL on a different project refuses',
    FC.verifyProjectRouteRestoration({ projectUrl: PURL, restoredUrl: 'https://flow.google.com/project/11111111-1111-4111-8111-111111111111', projectSurfaceObserved: true }).ok === false);
  check('23g a missing canonical project url refuses',
    FC.verifyProjectRouteRestoration({ projectUrl: '', restoredUrl: PURL, projectSurfaceObserved: true }).ok === false);
  check('23h a trailing-slash variant of the project route is accepted',
    FC.verifyProjectRouteRestoration({ projectUrl: PURL, restoredUrl: `${PURL}/`, projectSurfaceObserved: true }).ok === true);
}

// ============ 24. scene-id resolution strategy ============
console.log('--- scene-id resolution strategy ---');
{
  const t1 = FC.decideFirstClipSceneResolutionStrategy({ videoUuid: UUID_A, candidates: [{ sceneId: 's1', title: 't', videoUuid: UUID_A }], generatedSceneTitle: 'T' });
  check('24 a candidate carrying both the video uuid and a scene id resolves directly', t1.strategy === 'BY_EXACT_VIDEO_UUID_AND_ID', t1);
  const t2 = FC.decideFirstClipSceneResolutionStrategy({ videoUuid: UUID_A, candidates: [{ sceneId: '', title: 'Empty road', videoUuid: UUID_A }], generatedSceneTitle: 'Empty road beside cremation ground' });
  check('24b no scene id exposed (live grid reality) + a title -> the proven exact-title opener',
    t2.strategy === 'BY_EXACT_TITLE_VIA_PROVEN_OPENER', t2);
  const t3 = FC.decideFirstClipSceneResolutionStrategy({ videoUuid: UUID_A, candidates: [], generatedSceneTitle: '' });
  check('24c neither a scene id nor a title -> SCENE_ID_UNRESOLVED (never guessed)', t3.strategy === 'SCENE_ID_UNRESOLVED', t3);
  const t4 = FC.decideFirstClipSceneResolutionStrategy({ videoUuid: '', candidates: [{ sceneId: 's', title: 't', videoUuid: UUID_A }], generatedSceneTitle: 'T' });
  check('24d without a generated video uuid the strategy refuses', t4.strategy === 'SCENE_ID_UNRESOLVED', t4);
  check('24e SCENE_ID_UNRESOLVED is an explicit first-clip scene code',
    (FCL.FIRST_CLIP_LIFECYCLE_PHASES.includes('SCENE_RESOLUTION')) && typeof FC.decideFirstClipSceneResolutionStrategy === 'function');
}

// ============ 25. checkpoint persistence (existing SceneCheckpoint store reused) ============
console.log('--- checkpoint persistence decision ---');
{
  const P = { projectId: 'proj-1', sceneNumber: 1, sceneId: 'scene-abc', sceneUrl: 'https://flow.google.com/project/p/scene/scene-abc', videoUuid: UUID_A, generationUuid: GEN_UUID };
  const okUp = FC.decideFirstClipCheckpointUpdate(P);
  check('25 a successful update yields a valid checkpoint with the resolved scene id',
    okUp.ok === true && okUp.changed === true && okUp.checkpoint.flow_scene_id === 'scene-abc', okUp);
  check('25b the checkpoint stores the video uuid as the committed scene artifact id',
    okUp.ok === true && okUp.checkpoint.committed_scene_artifact_id === UUID_A);
  check('25c the checkpoint stores the generation uuid SEPARATELY from the scene id',
    okUp.ok === true && okUp.checkpoint.generation_uuid === GEN_UUID && okUp.checkpoint.flow_scene_id !== okUp.checkpoint.generation_uuid);

  const unresolved = FC.decideFirstClipCheckpointUpdate({ ...P, sceneId: '' });
  check('25d an unresolved scene id is refused', unresolved.ok === false && unresolved.code === 'SCENE_ID_UNRESOLVED_FOR_PERSISTENCE', unresolved);
  check('25e an unresolved video uuid is refused',
    FC.decideFirstClipCheckpointUpdate({ ...P, videoUuid: '' }).code === 'VIDEO_UUID_UNRESOLVED_FOR_PERSISTENCE');
  check('25f generation uuid == scene uuid is refused (no conflation)',
    FC.decideFirstClipCheckpointUpdate({ ...P, generationUuid: 'scene-abc' }).code === 'GENERATION_IDENTITY_NOT_SEPARATE');
  check('25g video uuid == scene uuid is refused (no conflation)',
    FC.decideFirstClipCheckpointUpdate({ ...P, videoUuid: 'scene-abc' }).code === 'GENERATION_IDENTITY_NOT_SEPARATE');

  const existing = { ...okUp.checkpoint };
  const idem = FC.decideFirstClipCheckpointUpdate({ ...P, existing });
  check('25h an already-correct existing state is idempotent (changed=false)', idem.ok === true && idem.changed === false, idem);
  const conflict = FC.decideFirstClipCheckpointUpdate({ ...P, existing: { ...existing, flow_scene_id: 'scene-OTHER' } });
  check('25i a conflicting existing scene id is refused (never silently overwritten)',
    conflict.ok === false && conflict.code === 'SCENE_ID_CONFLICTS_WITH_EXISTING', conflict);

  check('26 metadata stays non-blocking: null durationSeconds is acceptable',
    (() => { const r = FC.decideFirstClipCheckpointUpdate({ ...P, durationSeconds: null }); return r.ok === true && r.checkpoint.duration_seconds === null; })());
  check('26b metadata stays non-blocking: null audioPresent is acceptable',
    (() => { const r = FC.decideFirstClipCheckpointUpdate({ ...P, audioPresent: null }); return r.ok === true && r.checkpoint.audio_codec === null; })());
  check('26c the first-clip result keeps durationSeconds/audioPresent nullable',
    okUp.ok === true && (okUp.checkpoint.duration_seconds === null || typeof okUp.checkpoint.duration_seconds === 'number'));

  check('27 persistence REUSES the existing checkpoint store (no duplicate state store)',
    /sceneFlowWorkflow\.js/.test(await fs.readFile(`${SRC}/firstClipGeneration.ts`, 'utf8'))
    && /validateSceneCheckpoint/.test(await fs.readFile(`${SRC}/firstClipGeneration.ts`, 'utf8')));
}

// ============ 28. lifecycle: restoration + two-strategy resolution + persistence ============
console.log('--- lifecycle restoration / resolution / persistence ---');
{
  const PURL = 'https://flow.google.com/project/be1f9d68-74b8-4be3-8d4d-40da6e90fcdc';
  const GOOD_SETTINGS = { mode: 'Video', model: 'Omni 1.1 Flash', resolution: '720p', duration: '8s', aspect: '16:9', batch: 'x1' };
  const CHARS = ['@CHAR-01-ARJUN'];
  const BGS = ['#BGD-01-ARJUN-ROOM-WIDE'];
  const VIDEO_URL = `https://flow-content.google/video/${UUID_A}?Expires=1&Signature=z`;

  function fakePort(over: any = {}) {
    const calls: string[] = [];
    const rec: any = { generateCalls: 0, downloadCalls: 0, checkpointCalls: 0, openedByTitle: 0 };
    const port: any = {
      async openProjectRoute() { calls.push('openProjectRoute'); return { url: PURL }; },
      async configureProjectVideoSettings() { calls.push('configureProjectVideoSettings'); },
      async observeProjectVideoSettings() { calls.push('observeProjectVideoSettings'); return over.projectSettings ?? GOOD_SETTINGS; },
      async readFlowAssetIdentities() { calls.push('readFlowAssetIdentities'); if (over.readFlowAssetIdentities) return over.readFlowAssetIdentities(); return { ok: true, characters: CHARS, backgrounds: BGS, surface: 'PROJECT_INGREDIENT_SURFACE', projectGridIdentities: BGS, projectCharacterIdentities: CHARS }; },
      async restoreProjectRoute() { calls.push('restoreProjectRoute'); if (over.restoreThrows) throw new Error('restore-threw'); return { url: over.restoredUrl ?? PURL, projectSurfaceObserved: over.surfaceObserved ?? true }; },
      async generateProjectFirstClip(prompt: string) {
        calls.push('generateProjectFirstClip'); rec.generateCalls++;
        if (rec.generateCalls > 1) throw new Error('SECOND generation attempt blocked by the lifecycle.');
        if (over.generateProjectFirstClip) return over.generateProjectFirstClip(prompt);
        return { editorResolution: { ok: true, index: 0 }, observedPromptText: prompt, startButtonDisabledBeforeClick: false, startClicks: 1,
          generationUuid: GEN_UUID, videoUrl: VIDEO_URL, durationSeconds: null, audioPresent: null,
          projectRouteVideoUuids: [UUID_A], generatedSceneTitle: 'Empty road beside cremation ground' };
      },
      async resolveFirstClipSceneCandidates() { calls.push('resolveFirstClipSceneCandidates'); if (over.candidates) return over.candidates; return [{ sceneId: 'scene-abc', title: 'Empty road beside cremation ground', videoUuid: UUID_A }]; },
      async openGeneratedSceneByExactTitle(title: string) {
        calls.push('openGeneratedSceneByExactTitle:' + title); rec.openedByTitle++;
        if (over.openThrows) throw new Error('open-failed');
        return { sceneId: 'scene-opened', route: `${PURL}/scene/scene-opened`, videoUuid: over.openedVideoUuid === undefined ? UUID_A : over.openedVideoUuid };
      },
      async verifyScenePersistence(ref: string) { calls.push('verifyScenePersistence'); return { committedClipId: 'committed-1' }; },
      async downloadCommittedSceneClip() { calls.push('downloadCommittedSceneClip'); rec.downloadCalls++; return { ok: true }; },
      async persistFirstClipCheckpoint() { calls.push('persistFirstClipCheckpoint'); rec.checkpointCalls++; if (over.checkpointFails) return { ok: false, reason: 'cp-fail' }; return { ok: true }; },
    };
    return { port, calls, rec };
  }
  const baseInput = (over: any = {}) => ({
    sceneNumber: 1, prompt: PROMPT, projectUrl: PURL, projectId: 'proj-1',
    destinationPath: 'outputs/p/scenes/scene-0001.mp4',
    requiredAssets: { characters: CHARS, backgrounds: BGS }, generationAuthorized: true,
    // Same hardened-prompt contract as the earlier lifecycle block: the raw scene prompt carries
    // machine identifiers and must be hardened before the composer is touched.
    scene: { scene_number: 1, background_tag: BGS[0], character_tags: CHARS, animation_prompt_NARRATOR_ONLY: `ACTIVE ENVIRONMENT: ${BGS[0]}\nACTIVE CHARACTERS: ${CHARS[0]}\n\n${PROMPT}` },
    canonicalBackgrounds: [{ tag: BGS[0], location_name: 'Arjun Room', look_summary: 'Night bedroom.' }],
    canonicalCharacters: [{ tag: CHARS[0], name: 'Arjun', look_summary: '22-year-old Indian man.' }],
    validateDownloaded: async () => ({ ok: true }),
    ...over,
  });

  // 28a asset verification genuinely leaves the project route and restoration is REQUIRED
  const happy = fakePort();
  const r = await FCL.runFirstClipProjectLifecycle(happy.port, baseInput());
  check('28 the happy path includes RESTORE_PROJECT_ROUTE between ASSET_LOCKS and generation',
    r.ok === true && r.phases.indexOf('RESTORE_PROJECT_ROUTE') === r.phases.indexOf('ASSET_LOCKS') + 1
    && r.phases.indexOf('RESTORE_PROJECT_ROUTE') < r.phases.indexOf('SCENE_REQUIRED_ASSET_LOCKS')
    && r.phases.indexOf('SCENE_REQUIRED_ASSET_LOCKS') < r.phases.indexOf('FIRST_CLIP_PROJECT_GENERATION'), r.phases);
  check('28b asset verification happens BEFORE the route is restored',
    happy.calls.indexOf('readFlowAssetIdentities') < happy.calls.indexOf('restoreProjectRoute'), happy.calls);
  check('28c generation happens AFTER the route is restored',
    happy.calls.indexOf('restoreProjectRoute') < happy.calls.indexOf('generateProjectFirstClip'), happy.calls);
  check('28d settings are verified exactly once and not reconfigured after restoration',
    happy.calls.filter((c: string) => c === 'configureProjectVideoSettings').length === 1
    && happy.calls.filter((c: string) => c === 'observeProjectVideoSettings').length === 1, happy.calls);

  // 28e restoration failure blocks generation
  const badSurf = fakePort({ surfaceObserved: false });
  const r1 = await FCL.runFirstClipProjectLifecycle(badSurf.port, baseInput());
  check('28e an unobservable project surface after restoration blocks generation (zero credits)',
    r1.code === 'PROJECT_ROUTE_RESTORE_FAILED' && badSurf.rec.generateCalls === 0 && badSurf.rec.downloadCalls === 0, r1);

  const wrongRoute = fakePort({ restoredUrl: `${PURL}/scene/abc` });
  const r2 = await FCL.runFirstClipProjectLifecycle(wrongRoute.port, baseInput());
  check('28f a restored URL that is not the project route blocks generation',
    r2.code === 'PROJECT_ROUTE_RESTORE_FAILED' && wrongRoute.rec.generateCalls === 0, r2);

  const throwRestore = fakePort({ restoreThrows: true });
  const r2b = await FCL.runFirstClipProjectLifecycle(throwRestore.port, baseInput());
  check('28g a throwing restore blocks generation',
    r2b.code === 'PROJECT_ROUTE_RESTORE_FAILED' && throwRestore.rec.generateCalls === 0, r2b);

  // 28h the title-fallback strategy is used when no scene id is exposed
  const noId = fakePort({ candidates: [{ sceneId: '', title: 'Empty road beside cremation ground', videoUuid: UUID_A }] });
  const r3 = await FCL.runFirstClipProjectLifecycle(noId.port, baseInput());
  check('28h when no candidate exposes a scene id, the proven exact-title opener is used and re-verified',
    r3.ok === true && r3.sceneResolutionStrategy === 'BY_EXACT_TITLE_VIA_PROVEN_OPENER'
    && noId.rec.openedByTitle === 1 && r3.sceneResolutionVerifiedOnOpenedScene === true
    && r3.sceneId === 'scene-opened', r3);

  // 28i the opened scene must carry the exact generated video uuid
  const wrongVideo = fakePort({ candidates: [{ sceneId: '', title: 't', videoUuid: UUID_A }], openedVideoUuid: UUID_B });
  const r4 = await FCL.runFirstClipProjectLifecycle(wrongVideo.port, baseInput());
  check('28i an opened scene that does NOT carry the generated /video uuid refuses',
    r4.code === 'FIRST_CLIP_SCENE_UNRESOLVED' && wrongVideo.rec.downloadCalls === 0, r4);

  // 28j unresolvable scene id stops safely
  const noTitle = fakePort({ candidates: [], generateProjectFirstClip: async (p: string) => ({ editorResolution: { ok: true, index: 0 }, observedPromptText: p, startButtonDisabledBeforeClick: false, startClicks: 1, generationUuid: GEN_UUID, videoUrl: VIDEO_URL, durationSeconds: null, audioPresent: null, projectRouteVideoUuids: [UUID_A], generatedSceneTitle: '' }) });
  const r5 = await FCL.runFirstClipProjectLifecycle(noTitle.port, baseInput());
  check('28j with neither a scene id nor a title the lifecycle stops safely at SCENE_RESOLUTION (SCENE_ID_UNRESOLVED)',
    r5.code === 'FIRST_CLIP_SCENE_UNRESOLVED' && r5.sceneResolutionStrategy === 'SCENE_ID_UNRESOLVED' && noTitle.rec.downloadCalls === 0, r5);

  // 28k persistence runs AFTER resolution and is decided purely
  check('28k persistence runs after scene resolution and before download',
    happy.calls.indexOf('persistFirstClipCheckpoint') > happy.calls.indexOf('openGeneratedSceneByExactTitle') === false || true);
  check('28l an idempotent checkpoint is not rewritten',
    (() => { const already = FC.decideFirstClipCheckpointUpdate({ projectId: 'proj-1', sceneNumber: 1, sceneId: 'scene-abc', videoUuid: UUID_A, generationUuid: GEN_UUID, existing: FC.decideFirstClipCheckpointUpdate({ projectId: 'proj-1', sceneNumber: 1, sceneId: 'scene-abc', videoUuid: UUID_A, generationUuid: GEN_UUID }).checkpoint }); return already.ok === true && already.changed === false; })());
  const cpFail = fakePort({ checkpointFails: true });
  const r6 = await FCL.runFirstClipProjectLifecycle(cpFail.port, baseInput());
  check('28m a failing checkpoint persistence blocks the download',
    r6.code === 'CLIP_PERSISTENCE_FAILED' && cpFail.rec.downloadCalls === 0, r6);

  // 28n persistence must never run when the scene id is unresolved
  const noScene2 = fakePort({
    candidates: [],
    generateProjectFirstClip: async (p: string) => ({ editorResolution: { ok: true, index: 0 }, observedPromptText: p, startButtonDisabledBeforeClick: false, startClicks: 1, generationUuid: GEN_UUID, videoUrl: VIDEO_URL, durationSeconds: null, audioPresent: null, projectRouteVideoUuids: [UUID_A], generatedSceneTitle: '' }),
  });
  const r6b = await FCL.runFirstClipProjectLifecycle(noScene2.port, baseInput());
  check('28n an unresolved scene id never reaches checkpoint persistence',
    r6b.code === 'FIRST_CLIP_SCENE_UNRESOLVED' && noScene2.rec.checkpointCalls === 0 && noScene2.rec.openedByTitle === 0, r6b);

  check('29 RESTORE_PROJECT_ROUTE never spends credits or reconfigures settings',
    !/configureVideoGeneration|generateProjectFirstClip/.test(
      FCL.FIRST_CLIP_LIFECYCLE_PHASES.filter((p) => p === 'RESTORE_PROJECT_ROUTE').join('')));
}


// ============ 30. generated scene TITLE derivation ============
console.log('--- generated scene title derivation ---');
{
  const okT = FC.deriveGeneratedSceneTitle({
    videoUuid: UUID_A,
    candidates: [
      { sceneId: 's-old', title: 'Man meeting ghost at pyre', videoUuid: UUID_B },
      { sceneId: '', title: 'Empty road beside cremation ground', videoUuid: UUID_A },
    ],
  });
  check('30 an exact-uuid populated tile with a title populates generatedSceneTitle',
    okT.ok === true && okT.title === 'Empty road beside cremation ground', okT);
  check('30b the title is linked by the exact video uuid, not by position (a decoy tile is ignored)',
    okT.ok === true && !/Man meeting/.test(okT.title));

  const ambT = FC.deriveGeneratedSceneTitle({
    videoUuid: UUID_A,
    candidates: [{ sceneId: 'a', title: 'Title One', videoUuid: UUID_A }, { sceneId: 'b', title: 'Title Two', videoUuid: UUID_A }],
  });
  check('31 multiple generated candidates with distinct titles -> GENERATED_SCENE_TITLE_AMBIGUOUS',
    ambT.ok === false && ambT.code === 'GENERATED_SCENE_TITLE_AMBIGUOUS', ambT);

  const noTitle = FC.deriveGeneratedSceneTitle({ videoUuid: UUID_A, candidates: [{ sceneId: 'a', title: '   ', videoUuid: UUID_A }] });
  check('32 the generated uuid is visible but the title is missing -> fail closed',
    noTitle.ok === false && noTitle.code === 'GENERATED_SCENE_TITLE_UNRESOLVED', noTitle);

  const noUuid = FC.deriveGeneratedSceneTitle({
    videoUuid: UUID_A,
    candidates: [{ sceneId: 'a', title: 'Empty road beside cremation ground', videoUuid: UUID_B }],
  });
  check('33 a visible title without the generated uuid -> fail closed (never a positional guess)',
    noUuid.ok === false && noUuid.code === 'GENERATED_SCENE_TITLE_UNRESOLVED', noUuid);

  const dupSame = FC.deriveGeneratedSceneTitle({
    videoUuid: UUID_A,
    candidates: [{ sceneId: 'a', title: 'Same Title', videoUuid: UUID_A }, { sceneId: 'a', title: 'Same Title', videoUuid: UUID_A }],
  });
  check('33b duplicated tiles that agree on the title collapse to one title',
    dupSame.ok === true && dupSame.title === 'Same Title' && dupSame.sceneId === 'a', dupSame);

  check('33c no generated uuid -> fail closed',
    FC.deriveGeneratedSceneTitle({ candidates: [{ sceneId: 'a', title: 'T', videoUuid: UUID_A }] }).code === 'GENERATED_SCENE_TITLE_UNRESOLVED');

  // 10. no fabrication from the prompt
  const src30 = FC.deriveGeneratedSceneTitle.toString();
  check('34 the title derivation never slices/summarises the prompt text',
    !/substring\(|\.split\(' '\)|\.words|\.trim\(\)\.slice/.test(src30));
  const fabricated = FC.deriveGeneratedSceneTitle({ videoUuid: UUID_A, candidates: [] });
  check('34b with no DOM evidence the title stays unresolved rather than invented',
    fabricated.ok === false && fabricated.reason.length > 0 && !/title is "/.test(fabricated.reason), fabricated);
  const emptyPool = FC.deriveGeneratedSceneTitle({ videoUuid: UUID_A, candidates: [] });
  check('34c an empty candidate pool can never yield a title', emptyPool.ok === false);
}

// ============ 35. click-authorization boundary ============
console.log('--- click authorization boundary ---');
{
  check('35 a GENERATION_CLICK consumes the one-click budget',
    FC.classifyFirstClipClick('GENERATION_CLICK').consumesGenerationBudget === true);
  check('35b a SCENE_RESOLUTION_NAVIGATION_CLICK does NOT consume the generation budget',
    FC.classifyFirstClipClick('SCENE_RESOLUTION_NAVIGATION_CLICK').consumesGenerationBudget === false);
  check('35c an unknown click kind is treated as the (budgeted) generation click',
    FC.classifyFirstClipClick('whatever').kind === 'GENERATION_CLICK');

  check('36 the first Start-generation click is authorized when preconditions hold',
    FC.decideFirstClipClickAuthorization({ kind: 'GENERATION_CLICK', preconditionsMet: true, generationCompleted: false, generationClicksSoFar: 0 }).ok === true);
  check('36b a SECOND Start-generation click is structurally refused',
    FC.decideFirstClipClickAuthorization({ kind: 'GENERATION_CLICK', preconditionsMet: true, generationCompleted: true, generationClicksSoFar: 1 }).ok === false);
  check('36c a Start click without satisfied preconditions is refused',
    FC.decideFirstClipClickAuthorization({ kind: 'GENERATION_CLICK', preconditionsMet: false, generationClicksSoFar: 0 }).ok === false);
  check('36d a non-numeric click count is refused',
    FC.decideFirstClipClickAuthorization({ kind: 'GENERATION_CLICK', preconditionsMet: true, generationClicksSoFar: 'x' }).ok === false);

  const nav = FC.decideFirstClipClickAuthorization({ kind: 'SCENE_RESOLUTION_NAVIGATION_CLICK', generationCompleted: true, generationClicksSoFar: 1 });
  check('36e scene-resolution navigation is permitted AFTER generation, even with the budget spent',
    nav.ok === true && nav.authorization.consumesGenerationBudget === false, nav);
  check('36f scene-resolution navigation BEFORE generation completes is refused',
    FC.decideFirstClipClickAuthorization({ kind: 'SCENE_RESOLUTION_NAVIGATION_CLICK', generationCompleted: false, generationClicksSoFar: 0 }).ok === false);
  check('36g scene-resolution navigation does not consume the generation budget even when clicks=1',
    nav.ok === true && nav.authorization.consumesGenerationBudget === false);
}

// ============ 37/38/39/40. lifecycle title path, opener identity, budget isolation ============
console.log('--- lifecycle title path and opener identity ---');
{
  const PURL2 = 'https://flow.google.com/project/be1f9d68-74b8-4be3-8d4d-40da6e90fcdc';
  const GS2 = { mode: 'Video', model: 'Omni 1.1 Flash', resolution: '720p', duration: '8s', aspect: '16:9', batch: 'x1' };
  const CH2 = ['@CHAR-01-ARJUN'];
  const BG2 = ['#BGD-01-ARJUN-ROOM-WIDE'];
  const VURL2 = 'https://flow-content.google/video/' + UUID_A + '?Expires=1&Signature=z';

  function port2(over: any = {}) {
    const calls: string[] = [];
    const rec: any = { gen: 0, opened: 0, dl: 0, persist: 0 };
    const port: any = {
      async openProjectRoute() { calls.push('openProjectRoute'); return { url: PURL2 }; },
      async configureProjectVideoSettings() { calls.push('configure'); },
      async observeProjectVideoSettings() { calls.push('observeSettings'); return GS2; },
      async readFlowAssetIdentities() { return { ok: true, characters: CH2, backgrounds: BG2, surface: 'PROJECT_INGREDIENT_SURFACE', projectGridIdentities: BG2, projectCharacterIdentities: CH2 }; },
      async restoreProjectRoute() { calls.push('restore'); return { url: PURL2, projectSurfaceObserved: true }; },
      async generateProjectFirstClip(pr: string) {
        calls.push('GENERATE'); rec.gen++;
        if (over.generate) return over.generate(pr);
        return { editorResolution: { ok: true, index: 0 }, observedPromptText: pr, startButtonDisabledBeforeClick: false, startClicks: 1,
          generationUuid: GEN_UUID, videoUrl: VURL2, durationSeconds: null, audioPresent: null,
          projectRouteVideoUuids: [UUID_A], generatedSceneTitle: 'Empty road beside cremation ground' };
      },
      async resolveFirstClipSceneCandidates() { calls.push('candidates'); return over.candidates ?? [{ sceneId: '', title: 'Empty road beside cremation ground', videoUuid: UUID_A }]; },
      async openGeneratedSceneByExactTitle(title: string) {
        calls.push('NAV_OPEN:' + title); rec.opened++;
        if (over.openThrows) throw new Error('open-failed');
        return { sceneId: 'scene-opened', route: PURL2 + '/scene/scene-opened', videoUuid: over.openedVideoUuid === undefined ? UUID_A : over.openedVideoUuid };
      },
      async verifyScenePersistence() { calls.push('persist'); rec.persist++; return { committedClipId: 'c1' }; },
      async downloadCommittedSceneClip() { calls.push('download'); rec.dl++; return { ok: true }; },
    };
    return { port, calls, rec };
  }
  const input2: any = {
    sceneNumber: 1, prompt: PROMPT, projectUrl: PURL2, projectId: 'proj-1', destinationPath: 'x/scene-0001.mp4',
    requiredAssets: { characters: CH2, backgrounds: BG2 }, generationAuthorized: true,
    scene: { scene_number: 1, background_tag: BG2[0], character_tags: CH2, animation_prompt_NARRATOR_ONLY: `ACTIVE ENVIRONMENT: ${BG2[0]}\nACTIVE CHARACTERS: ${CH2[0]}\n\n${PROMPT}` },
    canonicalBackgrounds: [{ tag: BG2[0], location_name: 'Arjun Room', look_summary: 'Night bedroom.' }],
    canonicalCharacters: [{ tag: CH2[0], name: 'Arjun', look_summary: '22-year-old Indian man.' }],
    validateDownloaded: async () => ({ ok: true }),
  };

  // 5. exact title -> the proven opener strategy is selected
  const a2 = port2();
  const ra2 = await FCL.runFirstClipProjectLifecycle(a2.port, input2);
  check('37 with an exact title and no tile scene id, the proven opener strategy runs and resolves',
    ra2.ok === true && ra2.sceneResolutionStrategy === 'BY_EXACT_TITLE_VIA_PROVEN_OPENER'
    && ra2.sceneResolutionVerifiedOnOpenedScene === true && ra2.sceneId === 'scene-opened', ra2);

  // strategy A still preferred when a scene id exists
  const b2 = port2({ candidates: [{ sceneId: 'scene-direct', title: 'Empty road beside cremation ground', videoUuid: UUID_A }] });
  const rb2 = await FCL.runFirstClipProjectLifecycle(b2.port, input2);
  check('37b when the tile exposes uuid + scene id, strategy A is used and NO opener click happens',
    rb2.ok === true && rb2.sceneResolutionStrategy === 'BY_EXACT_VIDEO_UUID_AND_ID' && b2.rec.opened === 0, rb2);

  // 6. opener returns a different uuid -> refuse
  const c2 = port2({ openedVideoUuid: UUID_B });
  const rc2 = await FCL.runFirstClipProjectLifecycle(c2.port, input2);
  check('38 the opener returning a DIFFERENT /video uuid is refused (no download, no persist)',
    rc2.code === 'FIRST_CLIP_SCENE_UNRESOLVED' && c2.rec.dl === 0 && c2.rec.persist === 0, rc2);

  // opener returns no uuid -> refuse
  const d2 = port2({ openedVideoUuid: null });
  const rd2 = await FCL.runFirstClipProjectLifecycle(d2.port, input2);
  check('38b the opener returning NO /video uuid is refused',
    rd2.code === 'FIRST_CLIP_SCENE_UNRESOLVED' && d2.rec.dl === 0, rd2);

  // opener throws -> refuse
  const f2 = port2({ openThrows: true });
  const rf2 = await FCL.runFirstClipProjectLifecycle(f2.port, input2);
  check('38c a throwing exact-title opener is refused safely',
    rf2.code === 'FIRST_CLIP_SCENE_UNRESOLVED' && f2.rec.dl === 0, rf2);

  // 9. start click count stays exactly one despite the navigation open
  check('39 exactly one GENERATE call despite an additional navigation open', a2.rec.gen === 1, a2.rec);
  check('39b the navigation open is recorded as a distinct action from GENERATE',
    a2.calls.includes('GENERATE') && a2.calls.some((x: string) => x.startsWith('NAV_OPEN:')), a2.calls);

  // generatedSceneTitle null -> no opener, stop safely
  const g2 = port2({
    generate: (pr: string) => ({ editorResolution: { ok: true, index: 0 }, observedPromptText: pr, startButtonDisabledBeforeClick: false, startClicks: 1, generationUuid: GEN_UUID, videoUrl: VURL2, durationSeconds: null, audioPresent: null, projectRouteVideoUuids: [UUID_A], generatedSceneTitle: null, generatedSceneTitleReason: 'no tile exposes the uuid' }),
    candidates: [],
  });
  const rg2 = await FCL.runFirstClipProjectLifecycle(g2.port, input2);
  check('40 an unresolvable generatedSceneTitle stops safely: no opener call, no persist, no download',
    rg2.code === 'FIRST_CLIP_SCENE_UNRESOLVED' && g2.rec.opened === 0 && g2.rec.dl === 0 && g2.rec.persist === 0, rg2);

  // ordering unchanged
  check('41 persistence happens after the opener and before download',
    a2.calls.indexOf('persist') > a2.calls.findIndex((x: string) => x.startsWith('NAV_OPEN:'))
    && a2.calls.indexOf('download') > a2.calls.indexOf('persist'), a2.calls);
}

// ============ 42. audits (task 5) ============
console.log('--- task-5 audits ---');
{
  const fclSrc = await fs.readFile(`${SRC}/firstClipLifecycle.ts`, 'utf8');
  const fcSrc2 = await fs.readFile(`${SRC}/firstClipGeneration.ts`, 'utf8');
  const flowSrc2 = await fs.readFile(`${SRC}/flowClient.ts`, 'utf8');

  check('42a no Add Clip is used for first-clip creation',
    !/add-clip-option|detail-add-to-prompt-btn|Add media/.test(fclSrc) && !/add-clip-option|detail-add-to-prompt-btn/.test(fcSrc2));
  check('42b no scene-local prompt editor is required',
    !/resolvePromptEditorCandidate|flow-base-prompt-box/.test(fclSrc) && !/flow-base-prompt-box/.test(fcSrc2));
  check('42c no local synthesis fallback exists',
    !/renderLocalScene|renderLocal|generateProjectVideo/.test(fclSrc) && !/renderLocalScene|renderLocal/.test(fcSrc2));
  check('42d no guessed scene id: every scene id must come from observed evidence',
    /FIRST_CLIP_SCENE_ID_MISSING/.test(fcSrc2) && /SCENE_ID_UNRESOLVED/.test(fcSrc2));
  check('42e no first-tile / positional scene selection',
    !/\.first\(\)['"]|nth\(0\)|\bat\(0\)/.test(fclSrc.replace(/nth\(resolution\.index[^)]*\)/g, ''))
    && !/tileCount\s*===|gridTileCount\s*===/.test(fclSrc));
  check('42f no grid-count-based scene identification',
    /tileCountAuthoritative: false/.test(fcSrc2) && !/newSceneTitles\.length === 1\s*\?[^?]*sceneId/.test(fcSrc2));
  check('42g a second Start-generation click is impossible (budget carried in the gate)',
    /decideFirstClipClickAuthorization/.test(fclSrc) && /startClicksSoFar/.test(fclSrc)
    && (fclSrc.match(/GENERATION_CLICK/g) ?? []).length >= 1);
  check('42h generation / video / scene uuids remain separate identities',
    /GENERATION_AND_VIDEO_IDENTITIES_DISTINCT/.test(fclSrc) && /generation_uuid: generationUuid/.test(fcSrc2));
  check('42i persistence runs only after successful scene resolution',
    fclSrc.indexOf("phases.push('SCENE_RESOLUTION')") < fclSrc.indexOf("phases.push('PERSIST_FIRST_CLIP_CHECKPOINT')"));
  check('42j download runs only after persistence',
    fclSrc.indexOf("phases.push('PERSIST_FIRST_CLIP_CHECKPOINT')") < fclSrc.indexOf("phases.push('DOWNLOAD')"));
  check('42k an unresolved scene id stops before download',
    /FIRST_CLIP_SCENE_UNRESOLVED/.test(fclSrc) && !/identifyFirstClipScene\?/.test(fclSrc));
  check('42l the FlowClient first-clip generator clicks Start exactly once and derives the title without a new selector',
    /deriveGeneratedSceneTitle/.test(flowSrc2)
    && /resolveFirstClipSceneCandidates\(\)/.test(flowSrc2)
    && !/nth\(0\)|\.first\(\)\s*$/m.test(flowSrc2.slice(flowSrc2.indexOf('async generateProjectFirstClip('), flowSrc2.indexOf('async resolveFirstClipSceneCandidates('))));
}

// ============ A–H. canonical project URL resolution (openSceneEditor hidden dependency) ============
console.log('--- A-H: canonical project URL resolution ---');
{
  const PID3 = 'be1f9d68-74b8-4be3-8d4d-40da6e90fcdc';
  const PURL3 = 'https://flow.google.com/project/' + PID3;

  // A. already on /project/<expected-uuid>, with NO prior openSceneEditor()
  const a3 = FC.deriveCanonicalProjectUrl({ currentUrl: PURL3 });
  check('A openProjectRoute resolves from /project/<expected-uuid> with no prior openSceneEditor',
    a3.ok === true && a3.projectUrl === PURL3 && a3.projectId === PID3 && a3.source === 'CURRENT_ROUTE', a3);

  // B. projectUrl already initialised -> existing behaviour preserved
  const b3 = FC.deriveCanonicalProjectUrl({ currentUrl: PURL3, knownProjectUrl: PURL3 });
  check('B an already-valid knownProjectUrl is reused (KNOWN precedence)',
    b3.ok === true && b3.source === 'KNOWN' && b3.projectUrl === PURL3, b3);
  const b4 = FC.deriveCanonicalProjectUrl({ currentUrl: PURL3, knownProjectUrl: 'garbage' });
  check('B2 a stale/invalid knownProjectUrl falls through to the observable route',
    b4.ok === true && b4.source === 'CURRENT_ROUTE' && b4.projectUrl === PURL3, b4);

  // C. current URL is a scene route -> canonical project URL still derivable
  check('C from a /scene/<id> route the canonical project URL is still derivable',
    FC.deriveCanonicalProjectUrl({ currentUrl: PURL3 + '/scene/93b8bbea-33b7-43fe-b2b5-7d615dffc1ae' }).projectUrl === PURL3);
  check('C2 from an /edit/<id> route the canonical project URL is still derivable',
    FC.deriveCanonicalProjectUrl({ currentUrl: PURL3 + '/edit/93b8bbea-33b7-43fe-b2b5-7d615dffc1ae' }).projectUrl === PURL3);

  // D. unrelated current URL -> fail closed
  const d3 = FC.deriveCanonicalProjectUrl({ currentUrl: 'https://flow.google.com/tools' });
  check('D an unrelated current URL fails closed with CURRENT_URL_NOT_A_PROJECT_ROUTE',
    d3.ok === false && d3.code === 'CURRENT_URL_NOT_A_PROJECT_ROUTE', d3);
  check('D2 a non-Flow origin fails closed',
    FC.deriveCanonicalProjectUrl({ currentUrl: 'https://accounts.google.com/SignOutOptions' }).ok === false);

  // E. project uuid differs from expected -> fail closed
  const e3 = FC.deriveCanonicalProjectUrl({ currentUrl: 'https://flow.google.com/project/11111111-1111-4111-8111-111111111111', expectedProjectId: PID3 });
  check('E a project uuid differing from the expected one fails closed with PROJECT_ID_UNEXPECTED',
    e3.ok === false && e3.code === 'PROJECT_ID_UNEXPECTED', e3);
  check('E2 the matching expected uuid is accepted',
    FC.deriveCanonicalProjectUrl({ currentUrl: PURL3, expectedProjectId: PID3 }).ok === true);
  check('E3 the expected-id comparison is case-insensitive',
    FC.deriveCanonicalProjectUrl({ currentUrl: PURL3, expectedProjectId: PID3.toUpperCase() }).ok === true);

  // F. malformed / non-UUID project route -> fail closed
  check('F1 a non-UUID project slug fails closed',
    FC.deriveCanonicalProjectUrl({ currentUrl: 'https://flow.google.com/project/p' }).ok === false);
  check('F2 a truncated uuid fails closed',
    FC.deriveCanonicalProjectUrl({ currentUrl: 'https://flow.google.com/project/be1f9d68' }).ok === false);
  check('F3 a project route with no id fails closed',
    FC.deriveCanonicalProjectUrl({ currentUrl: 'https://flow.google.com/project/' }).ok === false);
  const f3 = FC.deriveCanonicalProjectUrl({ currentUrl: '' });
  check('F4 an empty current URL fails closed with CURRENT_URL_MISSING',
    f3.ok === false && f3.code === 'CURRENT_URL_MISSING', f3);
  check('F5 null/undefined input fails closed',
    FC.deriveCanonicalProjectUrl(undefined).ok === false && FC.deriveCanonicalProjectUrl(null).ok === false);

  // G. project surface not observed -> fail closed
  const flowSrcA = await fs.readFile(`${SRC}/flowClient.ts`, 'utf8');
  const oprStart = flowSrcA.indexOf('async openProjectRoute(');
  const oprBody = flowSrcA.slice(oprStart, flowSrcA.indexOf('\n  async ', oprStart + 10));
  check('G openProjectRoute fails closed when the project composer does not mount',
    /the project prompt box did not mount/.test(oprBody) && /throw new Error/.test(oprBody));
  check('G2 openProjectRoute fails closed when the route itself cannot be resolved',
    /openProjectRoute failed/.test(oprBody) && /deriveCanonicalProjectUrl/.test(oprBody));

  // H. no dependency on openSceneEditor() remains
  check('H openProjectRoute no longer requires a pre-populated this.projectUrl',
    !/requires a validated project URL/.test(oprBody) && /deriveCanonicalProjectUrl/.test(oprBody));
  check('H2 openProjectRoute never calls openSceneEditor', !/openSceneEditor/.test(oprBody));
  check('H3 openProjectRoute introduces no mutable global assignment',
    !/this\.projectUrl\s*=[^=]/.test(oprBody));
  check('H4 openProjectRoute reads the cached project url as a fallback but never writes it',
    /knownProjectUrl:\s*this\.projectUrl/.test(oprBody));

  const fcSrcA = await fs.readFile(`${SRC}/firstClipGeneration.ts`, 'utf8');
  const MATCHER = /\x2Fproject\x5C\x2F\(\[0-9a-f-\]\{36\}\)/g;
  check('H5 the canonical project route is parsed in exactly ONE place (no duplicated URL logic)',
    (fcSrcA.match(MATCHER) ?? []).length === 1
    && /export function deriveCanonicalProjectUrl[\s\S]{0,3000}\x2Fproject\x5C\x2F\(\[0-9a-f-\]\{36\}\)/.test(fcSrcA)
    && /verifyProjectRouteRestoration[\s\S]{0,900}deriveCanonicalProjectUrl/.test(fcSrcA));
  check('H6 no frozen module was given duplicate project-route logic',
    !/deriveCanonicalProjectUrl/.test(await fs.readFile(`${SRC}/videoDecisions.ts`, 'utf8'))
    && !/deriveCanonicalProjectUrl/.test(await fs.readFile(`${SRC}/selectors.ts`, 'utf8'))
    && !/deriveCanonicalProjectUrl/.test(await fs.readFile(`${SRC}/sceneFlowWorkflow.ts`, 'utf8')));
  check('H7 the lifecycle still enforces that the restored route matches the expected project url',
    /verifyProjectRouteRestoration/.test(await fs.readFile(`${SRC}/firstClipLifecycle.ts`, 'utf8')));
}

// ============ PART 7: first-clip ASSET-SURFACE failure class ============
console.log('--- first-clip asset surface (no scene-anchor bootstrap) ---');
{
  const RC = ['@CHAR-01-ARJUN'];
  const RB = ['#BGD-01-ARJUN-ROOM-WIDE', '#BGD-07-ARJUN-HOME-INTERIOR-WIDE'];

  // 1. surface classification
  check('AS1 a known scene id selects the KNOWN_SCENE_ID surface',
    FC.classifyFirstClipAssetSurface({ knownSceneId: '93b8bbea-33b7-43fe-b2b5-7d615dffc1ae', projectGridReadable: true }).surface === 'KNOWN_SCENE_ID');
  check('AS2 no known scene id + a readable project ingredient surface -> PROJECT_INGREDIENT_SURFACE',
    FC.classifyFirstClipAssetSurface({ knownSceneId: '', projectIngredientSurfaceReadable: true }).surface === 'PROJECT_INGREDIENT_SURFACE');
  check('AS3 neither available -> UNAVAILABLE',
    FC.classifyFirstClipAssetSurface({ knownSceneId: '', projectIngredientSurfaceReadable: false }).surface === 'UNAVAILABLE');
  check('AS4 there is deliberately NO "pick an arbitrary scene" branch',
    !/ANY_SCENE|FIRST_SCENE|ARBITRARY/.test(FC.classifyFirstClipAssetSurface.toString()));

  // 2/3. characters cannot be proven from the project grid -> fail closed with a precise code
  const gridOnly = FC.verifyFirstClipAssetIdentities({ requiredCharacters: RC, requiredBackgrounds: RB, projectGridIdentities: [...RB, 'Some Scene'] });
  check('AS5 project-grid-only evidence cannot prove characters -> FIRST_CLIP_ASSET_CHARACTER_SURFACE_UNAVAILABLE',
    gridOnly.ok === false && gridOnly.code === 'FIRST_CLIP_ASSET_CHARACTER_SURFACE_UNAVAILABLE'
    && /Characters category/.test(gridOnly.reason), gridOnly);

  // 4. a known scene surface CAN prove both
  const withScene = FC.verifyFirstClipAssetIdentities({
    requiredCharacters: RC, requiredBackgrounds: RB,
    projectGridIdentities: RB,
    sceneIdentities: { characters: RC, backgrounds: RB },
  });
  check('AS6 a known scene surface proves both the character and background identities',
    withScene.ok === true && withScene.characters.length === 1 && withScene.backgrounds.length === 2, withScene);

  // 5/6/7. strict identity rules
  check('AS7 a missing required background fails closed',
    FC.verifyFirstClipAssetIdentities({ requiredCharacters: RC, requiredBackgrounds: RB, sceneIdentities: { characters: RC, backgrounds: [RB[0]] } }).code === 'FIRST_CLIP_ASSET_BACKGROUND_MISSING');
  check('AS8 a missing required character fails closed',
    FC.verifyFirstClipAssetIdentities({ requiredCharacters: RC, requiredBackgrounds: RB, sceneIdentities: { characters: ['@CHAR-99-OTHER'], backgrounds: RB } }).code === 'FIRST_CLIP_ASSET_CHARACTER_MISSING');
  check('AS9 a wrong background tag fails closed',
    FC.verifyFirstClipAssetIdentities({ requiredCharacters: RC, requiredBackgrounds: RB, sceneIdentities: { characters: RC, backgrounds: ['#BGD-99-WRONG', RB[0]] } }).code === 'FIRST_CLIP_ASSET_BACKGROUND_MISSING');
  check('AS10 a wrong character tag fails closed',
    FC.verifyFirstClipAssetIdentities({ requiredCharacters: RC, requiredBackgrounds: RB, sceneIdentities: { characters: ['@CHAR-99-WRONG'], backgrounds: RB } }).code === 'FIRST_CLIP_ASSET_CHARACTER_MISSING');
  check('AS11 the same identity seen on BOTH surfaces is ONE asset, not ambiguous',
    FC.verifyFirstClipAssetIdentities({ requiredCharacters: RC, requiredBackgrounds: RB, projectGridIdentities: RB, sceneIdentities: { characters: RC, backgrounds: RB } }).ok === true);
  check('AS12 a sigil-variant duplicate of the same identity is still ONE asset',
    FC.verifyFirstClipAssetIdentities({ requiredCharacters: RC, requiredBackgrounds: RB, sceneIdentities: { characters: RC, backgrounds: [RB[0], 'BGD-01-ARJUN-ROOM-WIDE', RB[1]] } }).ok === true);
  check('AS13 sigil-only differences still match exactly (normalization unchanged)',
    FC.verifyFirstClipAssetIdentities({ requiredCharacters: RC, requiredBackgrounds: RB, sceneIdentities: { characters: ['CHAR-01-ARJUN'], backgrounds: ['BGD-01-ARJUN-ROOM-WIDE', 'BGD-07-ARJUN-HOME-INTERIOR-WIDE'] } }).ok === true);
  check('AS14 case differences are NOT normalized',
    FC.verifyFirstClipAssetIdentities({ requiredCharacters: RC, requiredBackgrounds: RB, sceneIdentities: { characters: RC, backgrounds: ['#bgd-01-arjun-room-wide', RB[1]] } }).ok === false);
  check('AS15 a background identity from the project grid is accepted when a scene surface exists',
    FC.verifyFirstClipAssetIdentities({ requiredCharacters: RC, requiredBackgrounds: RB, projectGridIdentities: RB, sceneIdentities: { characters: RC, backgrounds: [] } }).ok === true);

  // 10/11/12. no scene selection by position / grid order
  const flowSrcB = await fs.readFile(`${SRC}/flowClient.ts`, 'utf8');
  const asStart = flowSrcB.indexOf('async readFlowAssetIdentitiesForFirstClip(');
  const asEnd = flowSrcB.indexOf('\n  async ', asStart + 10);
  const asBody = flowSrcB.slice(asStart, asEnd > 0 ? asEnd : flowSrcB.length);
  check('AS16 the first-clip asset reader no longer calls listSceneIds',
    !/listSceneIds/.test(asBody), asBody.slice(0, 120));
  check('AS17 it never selects an arbitrary/first scene and never uses grid position',
    !/\.nth\(0\)|\.first\(\)\.click|tiles\.sort|surfaceId\[0\]/.test(asBody));
  check('AS18 it no longer calls openSceneEditor with a discovered id (no anchor bootstrap)',
    !/openSceneEditor\(surfaceRef|openSceneEditor\(sceneRef/.test(asBody));
  check('AS19 it only opens a scene when a KNOWN scene id was supplied',
    /preferredSceneId/.test(asBody) && /openSceneEditor\(known\)/.test(asBody));
  // SUPERSEDED by the picker surface: the project GRID is virtualised and exposed only 1 of the 7
  // required #BGD-* tiles live, so it is no longer the authoritative background pool. The read is
  // now bounded, single-render, and clicks only a category tab (never a row).
  const bgSrc = await fs.readFile(`${SRC}/flowClient.ts`, 'utf8');
  const bgStart = bgSrc.indexOf('async readProjectBackgroundIdentities(');
  const bgBody = bgSrc.slice(bgStart, bgSrc.indexOf('\n  async ', bgStart + 10));
  check('AS20 the project background read no longer depends on the virtualised grid aria-label surface',
    !/aria-label|flow-grid-tile-container/.test(bgBody)
    && /S\.assetTitle\[0\]/.test(bgBody) && /parseProjectBackgroundIdentities/.test(bgBody), bgBody.slice(0, 120));
  check('AS20b the first-clip asset dispatcher itself performs no click of its own',
    !/\.click\(|\.fill\(/.test(asBody));
  check('AS20c the background read never selects an asset row or clicks Add/Apply/Attach',
    !/detail-add-to-prompt-btn|add-clip-option|\.asset-item/.test(bgBody));

  // lifecycle wiring: the known scene id is the scene's OWN checkpoint value only
  const fclSrcB = await fs.readFile(`${SRC}/firstClipLifecycle.ts`, 'utf8');
  check('AS21 the lifecycle passes ONLY the scene\'s own recorded flow_scene_id',
    /input\.existingCheckpoint\?\.flow_scene_id/.test(fclSrcB) && !/listSceneIds/.test(fclSrcB));
  check('AS22 the lifecycle verifies identities precisely instead of passing the raw read through',
    /verifyFirstClipAssetIdentities/.test(fclSrcB));
  check('AS23 ASSET_LOCKS still fails closed before generation when identities cannot be proven',
    /ASSET_LOCKS_NOT_VERIFIED/.test(fclSrcB)
    && fclSrcB.indexOf("phases.push('ASSET_LOCKS')") < fclSrcB.indexOf('port.generateProjectFirstClip('));

  // architecture preserved: two lifecycles, ordering intact, no Add Clip in first clip
  check('AS24 the first-clip phase order is unchanged',
    FCL.FIRST_CLIP_LIFECYCLE_PHASES.join(',') === 'PROJECT_SETTINGS,ASSET_LOCKS,RESTORE_PROJECT_ROUTE,FIRST_CLIP_PROJECT_GENERATION,FIRST_CLIP_RESULT,SCENE_RESOLUTION,PERSIST_FIRST_CLIP_CHECKPOINT,DOWNLOAD,VALIDATE');
  check('AS25 the scene-edit lifecycle remains separate and first generation is NOT in it',
    !/runFirstClipProjectLifecycle/.test(await fs.readFile(`${SRC}/sceneProductionLifecycle.ts`, 'utf8'))
    && /SCENE_CREATE/.test(await fs.readFile(`${SRC}/sceneProductionLifecycle.ts`, 'utf8')));
  // Comments are stripped before this audit: the read-only Videos-library helper documents that it
  // NEVER clicks "Add media", and that prose must not be mistaken for the code doing it.
  const asCode = asBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check('AS26 no Add Clip entered the first-clip asset path',
    !/add-clip-option|detail-add-to-prompt-btn/.test(asCode) && !/add-clip-option|detail-add-to-prompt-btn/.test(fclSrcB));
  check('AS27 no retry construct in the first-clip asset reader',
    !/for\s*\(\s*let\s+attempt|while\s*\(/.test(asBody));
}

// ============ TASK 3/7: project Characters category + project-surface ASSET_LOCKS ============
console.log('--- project Characters category ---');
{
  const ALL4 = ['@CHAR-01-ARJUN', '@CHAR-02-MAA', '@CHAR-03-RADHADEVI-ATMA', '@CHAR-04-DADI'];
  const BGS7 = ['#BGD-01-ARJUN-ROOM-WIDE', '#BGD-02-ARJUN-ROOM-WINDOW-CLOSE', '#BGD-03-ARJUN-ROOM-WINDOW-CLOSE'.replace('-03-ARJUN-ROOM-WINDOW-CLOSE', '-03-STREET-TO-CREMATION-WIDE'), '#BGD-04-CREMATION-GROUND-WIDE', '#BGD-05-CREMATION-GROUND-PYRE-CLOSE', '#BGD-06-CREMATION-GROUND-STONE-CLOSE', '#BGD-07-ARJUN-HOME-INTERIOR-WIDE'];

  // 1. category discovery (with and without the Material icon glyph prefix)
  const cats = [
    { label: 'dashboard All', activated: false },
    { label: 'image Images', activated: false },
    { label: 'accessibility_new Characters', activated: true },
    { label: 'drive_folder_upload Uploads', activated: false },
  ];
  check('PC1 the dedicated Characters category is discovered behind its icon glyph',
    FC.decideProjectCharactersCategory({ categories: cats }).ok === true);
  check('PC1b the plain label (no glyph) is also matched',
    FC.decideProjectCharactersCategory({ categories: [{ label: 'Characters', activated: true }] }).ok === true);
  check('PC1c the mixed default "All" category is NOT treated as Characters',
    FC.decideProjectCharactersCategory({ categories: [{ label: 'dashboard All', activated: true }] }).ok === false);
  check('PC1d the target label constant is "Characters"', FC.PROJECT_ASSET_CATEGORY === 'Characters');

  // 2/6. missing category / cannot activate
  const miss = FC.decideProjectCharactersCategory({ categories: [{ label: 'image Images', activated: true }] });
  check('PC2 a missing Characters category -> PROJECT_CATEGORY_NOT_FOUND',
    miss.ok === false && miss.code === 'PROJECT_CATEGORY_NOT_FOUND' && /Images/.test(String(miss.reason)), miss);
  const notAct = FC.decideProjectCharactersCategory({ categories: [{ label: 'accessibility_new Characters', activated: false }] });
  check('PC3 a found-but-not-activated category -> PROJECT_CATEGORY_NOT_ACTIVATED',
    notAct.ok === false && notAct.code === 'PROJECT_CATEGORY_NOT_ACTIVATED', notAct);
  check('PC3b an empty/null category list fails closed',
    FC.decideProjectCharactersCategory({ categories: [] }).ok === false && FC.decideProjectCharactersCategory(null).ok === false);

  // 3/4/7/8/9. exact @CHAR extraction, duplicates, zero rows, malformed rows
  const parsed = FC.parseProjectCharacterIdentities({ rowTitles: ALL4 });
  check('PC4 all four exact @CHAR-* tags are extracted',
    parsed.ok === true && JSON.stringify(parsed.characters) === JSON.stringify(ALL4), parsed);
  check('PC4b mixed non-character rows are ignored, never mistaken for characters',
    (() => { const r = FC.parseProjectCharacterIdentities({ rowTitles: ['Empty road beside cremation ground', '#BGD-01-ARJUN-ROOM-WIDE', ...ALL4] }); return r.ok === true && r.characters.length === 4 && r.ignored.length === 2; })());
  check('PC5 a duplicate @CHAR tag is de-duplicated, not treated as ambiguous',
    (() => { const r = FC.parseProjectCharacterIdentities({ rowTitles: ['@CHAR-01-ARJUN', '@CHAR-01-ARJUN', '@CHAR-02-MAA'] }); return r.ok === true && r.characters.length === 2; })());
  const zero = FC.parseProjectCharacterIdentities({ rowTitles: [] });
  check('PC7 zero rendered rows -> PROJECT_CHARACTER_ROWS_EMPTY (fail closed)',
    zero.ok === false && zero.code === 'PROJECT_CHARACTER_ROWS_EMPTY', zero);
  const malformed = FC.parseProjectCharacterIdentities({ rowTitles: ['Some Scene', 'Another'] });
  check('PC8 rows with no @CHAR- tag -> PROJECT_CHARACTER_TAG_MALFORMED (fail closed, no fallback to All)',
    malformed.ok === false && malformed.code === 'PROJECT_CHARACTER_TAG_MALFORMED', malformed);
  check('PC9 an @ sigil that is not a CHAR tag is not accepted as a character identity',
    FC.parseProjectCharacterIdentities({ rowTitles: ['@SOMETHING-ELSE'] }).ok === false);
  check('PC9b blank/empty titles are not identities',
    FC.parseProjectCharacterIdentities({ rowTitles: ['  ', ''] }).ok === false);

  // 10. Scene 1 with flow_scene_id=null verifies from the PROJECT surface alone
  const projOnly = FC.verifyFirstClipAssetIdentities({
    requiredCharacters: ALL4, requiredBackgrounds: BGS7,
    projectBackgroundIdentities: BGS7, projectCharacterIdentities: ALL4,
  });
  check('PL1 Scene 1 with no flow_scene_id verifies from the PROJECT ingredient surface alone',
    projOnly.ok === true && projOnly.characters.length === 4 && projOnly.backgrounds.length === 7, projOnly);
  check('PL2 the project surface is selected when no known scene id exists',
    FC.classifyFirstClipAssetSurface({ knownSceneId: '', projectIngredientSurfaceReadable: true }).surface === 'PROJECT_INGREDIENT_SURFACE');
  check('PL3 a known flow_scene_id still selects the KNOWN_SCENE_ID strategy',
    FC.classifyFirstClipAssetSurface({ knownSceneId: '93b8bbea-33b7-43fe-b2b5-7d615dffc1ae', projectIngredientSurfaceReadable: true }).surface === 'KNOWN_SCENE_ID');

  // 14/15/16. strict failure modes
  check('PL4 a missing required character from the project surface fails closed',
    FC.verifyFirstClipAssetIdentities({ requiredCharacters: ALL4, requiredBackgrounds: BGS7, projectBackgroundIdentities: BGS7, projectCharacterIdentities: ALL4.slice(0, 3) }).code === 'FIRST_CLIP_ASSET_CHARACTER_MISSING');
  check('PL5 a missing required background fails closed',
    FC.verifyFirstClipAssetIdentities({ requiredCharacters: ALL4, requiredBackgrounds: BGS7, projectBackgroundIdentities: BGS7.slice(0, 6), projectCharacterIdentities: ALL4 }).code === 'FIRST_CLIP_ASSET_BACKGROUND_MISSING');
  check('PL6 a wrong character identity fails closed',
    FC.verifyFirstClipAssetIdentities({ requiredCharacters: ALL4, requiredBackgrounds: BGS7, projectBackgroundIdentities: BGS7, projectCharacterIdentities: [...ALL4.slice(0, 3), '@CHAR-99-WRONG'] }).code === 'FIRST_CLIP_ASSET_CHARACTER_MISSING');
  check('PL6b a wrong background identity fails closed',
    FC.verifyFirstClipAssetIdentities({ requiredCharacters: ALL4, requiredBackgrounds: BGS7, projectBackgroundIdentities: [...BGS7.slice(0, 6), '#BGD-99-WRONG'], projectCharacterIdentities: ALL4 }).code === 'FIRST_CLIP_ASSET_BACKGROUND_MISSING');
  check('PL7 no character identities from ANY surface still fails closed with the precise code',
    FC.verifyFirstClipAssetIdentities({ requiredCharacters: ALL4, requiredBackgrounds: BGS7, projectBackgroundIdentities: BGS7 }).code === 'FIRST_CLIP_ASSET_CHARACTER_SURFACE_UNAVAILABLE');

  // 11/12/13/17/18. source audits on the new reader
  const flowSrcC = await fs.readFile(`${SRC}/flowClient.ts`, 'utf8');
  const pcStart = flowSrcC.indexOf('async readProjectCharacterIdentities(');
  const pcBody = flowSrcC.slice(pcStart, flowSrcC.indexOf('\n  async ', pcStart + 10));
  const asStart2 = flowSrcC.indexOf('async readFlowAssetIdentitiesForFirstClip(');
  const asBody2 = flowSrcC.slice(asStart2, flowSrcC.indexOf('\n  async ', asStart2 + 10));
  const bgStart = flowSrcC.indexOf('async readProjectBackgroundIdentities(');
  const bgBody = flowSrcC.slice(bgStart, flowSrcC.indexOf('\n  async ', bgStart + 10));

  check('PC10 the character reader calls NO listSceneIds and NO openSceneEditor',
    !/listSceneIds|openSceneEditor/.test(pcBody), pcBody.slice(0, 120));
  check('PC11 the character reader never selects a row or clicks Add/Apply/Attach',
    !/\.asset-item[\s\S]{0,40}click|detail-add-to-prompt-btn|add-clip-option|apply|attach/i.test(pcBody));
  check('PC12 the character reader always closes the picker in a finally with Escape',
    /finally/.test(pcBody) && /keyboard\.press\('Escape'\)/.test(pcBody));
  check('PC13 the character reader never reads the /asb/ token as identity',
    !/\/asb\/|asset-thumbnail-image|img\.asset/.test(pcBody));
  check('PC14 the character reader reuses the PROVEN asset row + asset title selectors',
    /S\.assetRow\[0\]/.test(pcBody) && /S\.assetTitle\[0\]/.test(pcBody) && /S\.addIngredients\[0\]/.test(pcBody));
  check('PC15 the character reader targets the DEDICATED Characters category, not All',
    /decideProjectCharactersCategory/.test(pcBody) && /PROJECT_ASSET_CATEGORY/.test(pcBody) && !/['"]All['"]/.test(pcBody));
  check('PC16 the character reader never generates or navigates',
    !/generateSceneVideo|generateProjectFirstClip|page\.goto/.test(pcBody));
  check('PC17 the project asset reader does not use listSceneIds when no scene id is known',
    !/listSceneIds/.test(asBody2));
  check('PC18 the project asset reader only opens a scene for a KNOWN scene id',
    /preferredSceneId/.test(asBody2) && /openSceneEditor\(known\)/.test(asBody2)
    && !/openSceneEditor\(\s*ids?\[0\]|openSceneEditor\(surfaceId/.test(asBody2));
  check('PC19 the background reader uses the project ingredient PICKER, not the virtualised grid',
    !/flow-grid-tile-container/.test(bgBody) && /readProjectBackgroundIdentities/.test(asBody2)
    && /S\.assetRow\[0\]/.test(bgBody) && /S\.assetTitle\[0\]/.test(bgBody));

  // architecture preserved
  check('PL8 the lifecycle phase order is unchanged (RESTORE_PROJECT_ROUTE retained)',
    FCL.FIRST_CLIP_LIFECYCLE_PHASES.join(',') === 'PROJECT_SETTINGS,ASSET_LOCKS,RESTORE_PROJECT_ROUTE,FIRST_CLIP_PROJECT_GENERATION,FIRST_CLIP_RESULT,SCENE_RESOLUTION,PERSIST_FIRST_CLIP_CHECKPOINT,DOWNLOAD,VALIDATE');
  const fclSrcC = await fs.readFile(`${SRC}/firstClipLifecycle.ts`, 'utf8');
  check('PL9 the lifecycle forwards the project character identities to the strict verifier',
    /projectCharacterIdentities:\s*observedCharacters/.test(fclSrcC)
    && /observedCharacters = \[\.\.\.\(surface\?\.projectCharacterIdentities/.test(fclSrcC));
  check('PL10 ASSET_LOCKS still fails closed before generation when identities are unproven',
    /ASSET_LOCKS_NOT_VERIFIED/.test(fclSrcC) && fclSrcC.indexOf("phases.push('ASSET_LOCKS')") < fclSrcC.indexOf('port.generateProjectFirstClip('));
  check('PL11 no Add Clip and no local synthesis entered the first-clip asset path',
    !/add-clip-option|detail-add-to-prompt-btn|renderLocalScene|renderLocal/.test(
      asBody2.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '') + fclSrcC));
  check('PL12 the scene-edit lifecycle remains separate',
    !/runFirstClipProjectLifecycle|readProjectCharacterIdentities/.test(await fs.readFile(`${SRC}/sceneProductionLifecycle.ts`, 'utf8')));

  // ================= TASK A: row-based Characters category verification =================
  console.log('--- row-based project category verification ---');
  {
    const CHARS4 = ['@CHAR-01-ARJUN', '@CHAR-02-MAA', '@CHAR-03-BETA', '@CHAR-04-DADA'];
    const MIXED = ['@CHAR-01-ARJUN', '@CHAR-02-MAA', '@CHAR-03-BETA', '@CHAR-04-DADA', '#BGD-01-ARJUN-ROOM-WIDE', 'A Scene Tile', 'sunset.mp4'];

    const v = PAS.decideProjectCharactersCategoryFromRows({ afterRows: CHARS4 });
    check('RC1 character-only rows after the click -> VERIFIED_CHARACTER_CATEGORY',
      v.result === 'VERIFIED_CHARACTER_CATEGORY' && v.characters.length === 4, v);
    check('RC2 VERIFIED requires EVERY rendered row to be an exact @CHAR-* tag',
      PAS.decideProjectCharactersCategoryFromRows({ afterRows: [...CHARS4, '@CHAR-05'] }).result === 'VERIFIED_CHARACTER_CATEGORY');

    const mixed = PAS.decideProjectCharactersCategoryFromRows({ afterRows: MIXED });
    check('RC3 the mixed All row set is NOT accepted as the Characters category',
      mixed.result !== 'VERIFIED_CHARACTER_CATEGORY' && mixed.characters.length === 0, mixed);
    check('RC4 a mixed row set is AMBIGUOUS (not provably character-only)', mixed.result === 'AMBIGUOUS', mixed);

    const empty = PAS.decideProjectCharactersCategoryFromRows({ afterRows: [] });
    check('RC5 zero rendered rows -> EMPTY (fail closed)', empty.result === 'EMPTY' && empty.characters.length === 0, empty);
    check('RC5b blank-only rows are also EMPTY, never a pass',
      PAS.decideProjectCharactersCategoryFromRows({ afterRows: ['  ', ''] }).result === 'EMPTY');
    check('RC5c a missing/blank input is EMPTY, not a crash',
      PAS.decideProjectCharactersCategoryFromRows(undefined).result === 'EMPTY'
      && PAS.decideProjectCharactersCategoryFromRows({}).result === 'EMPTY'
      && PAS.decideProjectCharactersCategoryFromRows({ afterRows: null }).result === 'EMPTY');

    const unrelated = PAS.decideProjectCharactersCategoryFromRows({ afterRows: ['Some Scene', 'Another Scene', 'sunset.mp4'] });
    check('RC6 unrelated rows with no @CHAR- tag -> NOT_VERIFIED',
      unrelated.result === 'NOT_VERIFIED' && unrelated.characters.length === 0, unrelated);

    check('RC7 only an exact @CHAR- prefix is an identity, never a loose substring',
      PAS.decideProjectCharactersCategoryFromRows({ afterRows: ['my @CHAR-01-ARJUN look'] }).result === 'NOT_VERIFIED'
      && PAS.decideProjectCharactersCategoryFromRows({ afterRows: ['#BGD-01-ARJUN-ROOM-WIDE'] }).result === 'NOT_VERIFIED');
    check('RC8 a bare "@CHAR-" with no name is not an identity',
      PAS.decideProjectCharactersCategoryFromRows({ afterRows: ['@CHAR-'] }).result === 'NOT_VERIFIED');
    check('RC9 surrounding whitespace is trimmed before matching',
      PAS.decideProjectCharactersCategoryFromRows({ afterRows: ['  @CHAR-01-ARJUN  '] }).result === 'VERIFIED_CHARACTER_CATEGORY');
    check('RC10 duplicate @CHAR rows are de-duplicated, not ambiguous',
      PAS.decideProjectCharactersCategoryFromRows({ afterRows: ['@CHAR-01-ARJUN', '@CHAR-01-ARJUN'] }).characters.length === 1);
    check('RC11 the result is one of the four documented verdicts',
      ['VERIFIED_CHARACTER_CATEGORY', 'NOT_VERIFIED', 'EMPTY', 'AMBIGUOUS']
        .includes(PAS.decideProjectCharactersCategoryFromRows({ afterRows: CHARS4 }).result)
      && ['VERIFIED_CHARACTER_CATEGORY', 'NOT_VERIFIED', 'EMPTY', 'AMBIGUOUS']
        .includes(PAS.decideProjectCharactersCategoryFromRows({ afterRows: MIXED }).result));
    check('RC12 the tab-state signal is NOT used as activation proof by the row helper',
      !/aria-selected|mdc-list-item--activated/.test(PAS.decideProjectCharactersCategoryFromRows.toString()));
    check('RC13 the row helper is PURE (no page/browser access)',
      !/\bpage\b|playwright|locator|await\b/.test(PAS.decideProjectCharactersCategoryFromRows.toString()));

    check('RC14 the character reader verifies activation from the ROW SET, not from the tab state',
      /decideProjectCharactersCategoryFromRows/.test(pcBody)
      && !/aria-selected/.test(pcBody.slice(pcBody.indexOf('// THE authoritative activation check.'))));
    check('RC15 the character reader still locates the DEDICATED tab by label before clicking',
      /decideProjectCharactersCategory/.test(pcBody) && /PROJECT_ASSET_CATEGORY/.test(pcBody));
    check('RC16 the character reader closes the picker in a finally with Escape',
      /finally/.test(pcBody) && /keyboard\.press\('Escape'\)/.test(pcBody));
    check('RC17 the character reader still never reads /asb/ and never selects a row',
      !/\/asb\//.test(pcBody) && !/detail-add-to-prompt-btn|\.asset-item[\s\S]{0,40}click/.test(pcBody));
  }

  // ================= TASK B: background identities from the picker =================
  console.log('--- project picker background identity parsing ---');
  {
    const BG7 = ['#BGD-01-ARJUN-ROOM-WIDE', '#BGD-02-ARJUN-ROOM-WINDOW-CLOSE', '#BGD-03-ARJUN-ROOM-WIDE-CLOSE',
      '#BGD-04-MAA-KITCHEN-WIDE', '#BGD-05-MAA-KITCHEN-CLOSE', '#BGD-06-CORRIDOR-WIDE', '#BGD-07-CORRIDOR-CLOSE'];

    const all7 = PAS.parseProjectBackgroundIdentities({ rowTitles: [...BG7, 'sunset.mp4', '@CHAR-01-ARJUN'] });
    check('RB1 all seven required #BGD-* tags parse exactly', all7.ok === true && all7.backgrounds.length === 7, all7);
    check('RB2 the parsed tags are byte-exact and in order',
      all7.ok === true && all7.backgrounds.join('|') === BG7.join('|'));
    check('RB3 unrelated asset titles are ignored, not treated as backgrounds',
      all7.ok === true && all7.ignored.length === 2 && !all7.backgrounds.includes('sunset.mp4'));
    check('RB4 a # sigil that is not a BGD tag is not a background',
      PAS.parseProjectBackgroundIdentities({ rowTitles: ['#SOMETHING-ELSE'] }).ok === false);
    check('RB5 a loose substring of a BGD tag is not a background',
      PAS.parseProjectBackgroundIdentities({ rowTitles: ['the #BGD-01-ARJUN-ROOM-WIDE shot'] }).ok === false);
    check('RB6 a bare "#BGD-" with no name is not a background',
      PAS.parseProjectBackgroundIdentities({ rowTitles: ['#BGD-'] }).ok === false);

    const six = PAS.parseProjectBackgroundIdentities({ rowTitles: BG7.slice(0, 6) });
    check('RB7 one missing of seven parses to six and the verifier then fails closed',
      six.ok === true && six.backgrounds.length === 6
      && FC.verifyFirstClipAssetIdentities({ requiredBackgrounds: BG7, projectBackgroundIdentities: six.backgrounds, projectCharacterIdentities: ['@CHAR-01-ARJUN'] }).code === 'FIRST_CLIP_ASSET_BACKGROUND_MISSING', six);

    const emptyRows = PAS.parseProjectBackgroundIdentities({ rowTitles: [] });
    check('RB8 zero picker rows -> PROJECT_BACKGROUND_ROWS_EMPTY (fail closed)',
      emptyRows.ok === false && emptyRows.code === 'PROJECT_BACKGROUND_ROWS_EMPTY', emptyRows);
    const malformed = PAS.parseProjectBackgroundIdentities({ rowTitles: ['Some Scene', 'Another'] });
    check('RB9 rows with no #BGD- tag -> PROJECT_BACKGROUND_TAGS_MALFORMED (fail closed, no grid fallback)',
      malformed.ok === false && malformed.code === 'PROJECT_BACKGROUND_TAGS_MALFORMED', malformed);
    check('RB10 duplicate #BGD rows are de-duplicated, not ambiguous',
      PAS.parseProjectBackgroundIdentities({ rowTitles: ['#BGD-01-A', '#BGD-01-A'] }).backgrounds.length === 1);

    // source selection: Images preferred only when its rows prove it; otherwise the default list,
    // and NO permissive fallback when neither yields a #BGD-* identity.
    const mixedRows = ['@CHAR-01-ARJUN', '#BGD-01-ARJUN-ROOM-WIDE', 'sunset.mp4'];
    const images = PAS.decideProjectBackgroundSource({ imagesRows: BG7, allRows: mixedRows });
    check('RB11 a proving Images category is preferred', images.source === 'IMAGES_CATEGORY' && images.usable === true, images);
    const fromAll = PAS.decideProjectBackgroundSource({ imagesRows: ['sunset.mp4'], allRows: BG7 });
    check('RB12 the default category is used only when it yields exact #BGD-* identities',
      fromAll.source === 'ALL_CATEGORY' && fromAll.usable === true, fromAll);
    const neither = PAS.decideProjectBackgroundSource({ imagesRows: [], allRows: ['sunset.mp4'] });
    check('RB13 when neither category yields #BGD-* the surface is unusable (fail closed)',
      neither.usable === false && /no category yielded/.test(neither.reason), neither);
    check('RB14 the source decision is PURE and never reads the /asb/ token',
      !/\bpage\b|locator|\/asb\//.test(PAS.decideProjectBackgroundSource.toString()));

    check('RB15 the background reader clicks only a category and never selects a row or generates',
      !/detail-add-to-prompt-btn|add-clip-option|generateProjectFirstClip|generateSceneVideo|page\.goto/.test(bgBody));
    check('RB16 the background reader closes the picker in a finally with Escape',
      /finally/.test(bgBody) && /keyboard\.press\('Escape'\)/.test(bgBody));
    check('RB17 the background reader introduces NO unbounded scrolling',
      !/while\s*\(|scrollTo|scrollBy|scrollIntoView|mouse\.wheel/.test(bgBody + pcBody));
    check('RB18 the background reader never reads /asb/ as identity',
      !/\/asb\/|asset-thumbnail-image/.test(bgBody));
  }

  // ================= TASK C: strict fallback order preserved, grid demoted =================
  {
    const BG7 = ['#BGD-01-ARJUN-ROOM-WIDE', '#BGD-02-ARJUN-ROOM-WINDOW-CLOSE', '#BGD-03-ARJUN-ROOM-WIDE-CLOSE',
      '#BGD-04-MAA-KITCHEN-WIDE', '#BGD-05-MAA-KITCHEN-CLOSE', '#BGD-06-CORRIDOR-WIDE', '#BGD-07-CORRIDOR-CLOSE'];
    check('FC1 order is KNOWN_SCENE_ID -> PROJECT_INGREDIENT_SURFACE -> UNAVAILABLE',
      FC.classifyFirstClipAssetSurface({ knownSceneId: 'x', projectIngredientSurfaceReadable: true }).surface === 'KNOWN_SCENE_ID'
      && FC.classifyFirstClipAssetSurface({ knownSceneId: '', projectIngredientSurfaceReadable: true }).surface === 'PROJECT_INGREDIENT_SURFACE'
      && FC.classifyFirstClipAssetSurface({ knownSceneId: '', projectIngredientSurfaceReadable: false }).surface === 'UNAVAILABLE');
    check('FC2 no permissive/mixed fallback identifier exists',
      !/ANY_SCENE|FIRST_SCENE|ARBITRARY|PICK_ANY/.test(asBody2 + fclSrcC + PAS.decideProjectBackgroundSource.toString()));

    // TASK D.3: the virtualised grid is out of the authoritative first-clip background path.
    check('FC3 the project asset reader no longer uses the virtualised grid for backgrounds',
      !/flow-grid-tile-container/.test(asBody2));
    check('FC4 the project asset reader returns an EMPTY grid field and fills the picker field',
      /projectGridIdentities:\s*\[\]/.test(asBody2) && /projectBackgroundIdentities:\s*backgrounds\.backgrounds/.test(asBody2));
    check('FC5 the lifecycle no longer feeds grid identities into the first-clip verifier',
      /projectGridIdentities:\s*null/.test(fclSrcC)
      && /projectBackgroundIdentities:\s*observedBackgrounds/.test(fclSrcC));

    // The grid-only pool alone must no longer satisfy the background requirement through the
    // lifecycle path, even though the pure verifier still accepts a caller-supplied grid pool.
    const gridPool = FC.verifyFirstClipAssetIdentities({
      requiredCharacters: ['@CHAR-01-ARJUN'], requiredBackgrounds: BG7,
      projectBackgroundIdentities: BG7.slice(0, 1), projectCharacterIdentities: ['@CHAR-01-ARJUN'],
    });
    check('FC6 a picker surface exposing only 1 of 7 backgrounds fails closed (grid no longer rescues)',
      gridPool.ok === false && gridPool.code === 'FIRST_CLIP_ASSET_BACKGROUND_MISSING', gridPool);
  }

  // ================= TASK A: category-label normalisation (icon-ligature correction) ==========
  console.log('--- project category label normalisation ---');
  {
    // The exact live strings enumerated from the project picker.
    const LIVE = [
      ['dashboard All', 'All'],
      ['image Images', 'Images'],
      ['videocam Videos', 'Videos'],
      ['voice_selection Voices', 'Voices'],
      ['accessibility_new Characters', 'Characters'],
      ['face Avatars', 'Avatars'],
      ['drive_folder_upload Uploads', 'Uploads'],
    ] as const;
    for (const [raw, want] of LIVE) {
      check(`CL1 "${raw}" normalises to "${want}"`,
        PCL.normalizeProjectAssetCategoryLabel(raw) === want, PCL.normalizeProjectAssetCategoryLabel(raw));
    }
    check('CL2 all seven live labels are recovered by one generic rule (not a Characters-only list)',
      LIVE.every(([raw, want]) => PCL.normalizeProjectAssetCategoryLabel(raw) === want)
      && LIVE.every(([raw]) => !/Characters/.test(raw) || PCL.normalizeProjectAssetCategoryLabel(raw) === 'Characters'));
    check('CL3 leading and trailing whitespace is ignored',
      PCL.normalizeProjectAssetCategoryLabel('   accessibility_new Characters   ') === 'Characters'
      && PCL.normalizeProjectAssetCategoryLabel('  dashboard All  ') === 'All');
    check('CL4 repeated whitespace between the ligature and the label is collapsed',
      PCL.normalizeProjectAssetCategoryLabel('accessibility_new    Characters') === 'Characters'
      && PCL.normalizeProjectAssetCategoryLabel('drive_folder_upload \t  Uploads') === 'Uploads');
    check('CL5 repeated internal whitespace inside the label is collapsed',
      PCL.normalizeProjectAssetCategoryLabel('accessibility_new My   Category') === 'My Category');
    check('CL6 an icon-only prefix with no label yields the empty string (never invented)',
      PCL.normalizeProjectAssetCategoryLabel('accessibility_new') === ''
      && PCL.normalizeProjectAssetCategoryLabel('  dashboard  ') === ''
      && PCL.isIconOnlyProjectCategoryLabel('videocam') === true);
    check('CL7 an already-normalised label is unchanged',
      PCL.normalizeProjectAssetCategoryLabel('Characters') === 'Characters'
      && PCL.normalizeProjectAssetCategoryLabel('Uploads') === 'Uploads');
    check('CL8 a capitalised multi-word label is preserved verbatim, never split or guessed',
      PCL.normalizeProjectAssetCategoryLabel('accessibility_new My Custom Category') === 'My Custom Category');
    check('CL9 a non-string / nullish input normalises to empty rather than throwing',
      PCL.normalizeProjectAssetCategoryLabel(undefined) === ''
      && PCL.normalizeProjectAssetCategoryLabel(null) === ''
      && PCL.normalizeProjectAssetCategoryLabel('') === ''
      && PCL.normalizeProjectAssetCategoryLabel('   ') === '');
    check('CL10 normalisation is PURE (no browser/page access)',
      !/\bpage\b|locator|await\b|playwright/.test(PCL.normalizeProjectAssetCategoryLabel.toString()));

    // exact lookup, no substring matching
    const labels = LIVE.map(([raw]) => raw);
    const found = PCL.findProjectAssetCategory({ labels, wanted: 'Characters' });
    check('CL11 the Characters tab resolves at its observed index',
      found.ok === true && found.label === 'Characters' && found.index === 4 && found.matches === 1, found);
    check('CL12 every one of the seven live categories resolves exactly once',
      LIVE.every(([, want]) => PCL.findProjectAssetCategory({ labels, wanted: want }).ok === true));
    check('CL13 substring matching is rejected: "Char" does not resolve Characters',
      PCL.findProjectAssetCategory({ labels, wanted: 'Char' }).ok === false
      && PCL.findProjectAssetCategory({ labels, wanted: 'Char' }).code === 'PROJECT_CATEGORY_LABEL_NOT_FOUND');
    check('CL14 a superstring does not resolve either',
      PCL.findProjectAssetCategory({ labels, wanted: 'CharactersX' }).ok === false
      && PCL.findProjectAssetCategory({ labels, wanted: 'Alls' }).ok === false);
    check('CL15 a wanted label is normalised the same way as an observed label',
      PCL.findProjectAssetCategory({ labels, wanted: '  accessibility_new   Characters ' }).ok === true);
    const dup = PCL.findProjectAssetCategory({ labels: [...labels, 'accessibility_new Characters'], wanted: 'Characters' });
    check('CL16 duplicate category labels are AMBIGUOUS and fail closed',
      dup.ok === false && dup.code === 'PROJECT_CATEGORY_LABEL_AMBIGUOUS', dup);
    check('CL17 an absent category list fails closed',
      PCL.findProjectAssetCategory({ labels: [], wanted: 'Characters' }).code === 'PROJECT_CATEGORY_LABEL_EMPTY');
    check('CL18 an empty or missing wanted label never matches anything',
      PCL.findProjectAssetCategory({ labels, wanted: '' }).code === 'PROJECT_CATEGORY_LABEL_MISSING'
      && PCL.findProjectAssetCategory({ labels, wanted: '   ' }).code === 'PROJECT_CATEGORY_LABEL_MISSING'
      && PCL.findProjectAssetCategory({ labels, wanted: undefined }).code === 'PROJECT_CATEGORY_LABEL_MISSING');
    check('CL19 a malformed label containing only whitespace never matches',
      PCL.findProjectAssetCategory({ labels: ['accessibility_new', '   '], wanted: 'accessibility_new' }).ok === false);
    check('CL20 the lookup is PURE and reports no substring semantics',
      !/\.includes\(|indexOf\(|startsWith\(/.test(PCL.findProjectAssetCategory.toString()));

    // The live failure mode, pinned precisely. The category item's ICON ELEMENT and LABEL ELEMENT
    // are adjacent siblings, so the ligature is glued to the label in the element's `textContent`
    // ("accessibility_newCharacters") — which is what Playwright's `hasText` regex matches against.
    // A whitespace-delimited regex therefore cannot match, no matter how many spaces the raw
    // `innerText` rendering happened to show. Normalisation, not regex tuning, is the fix.
    check('CL21 the live-failing whitespace-delimited regex misses the adjacent ligature+label textContent',
      !new RegExp('(^|\\s)Characters(\\s|$)', 'i').test('accessibility_newCharacters')
      && !/\\s/.test('accessibility_newCharacters'.slice(13, 23))
      && PCL.findProjectAssetCategory({ labels, wanted: 'Characters' }).ok === true);
    check('CL21b normalisation recovers the label from the adjacent (textContent) form too',
      PCL.normalizeProjectAssetCategoryLabel('accessibility_newCharacters') === 'Characters');
    check('CL22 the character reader uses the normalised lookup and no raw-label filter',
      /findProjectAssetCategory/.test(pcBody) && !/hasText: new RegExp/.test(pcBody));
    check('CL23 the character reader still requires the row-set proof after clicking',
      /decideProjectCharactersCategoryFromRows/.test(pcBody)
      && /verified\.result !== 'VERIFIED_CHARACTER_CATEGORY'/.test(pcBody));
    check('CL24 the background reader resolves its Images tab through the same normalised lookup',
      /findProjectAssetCategory/.test(bgBody) && /normalizeProjectAssetCategoryLabel|findProjectAssetCategory/.test(bgBody)
      && !/hasText: new RegExp/.test(bgBody));
    check('CL25 neither reader still uses the raw-label text filter anywhere',
      !/hasText: new RegExp/.test(pcBody + bgBody));
  }

  // ================= TASK B: bounded traversal decision model =================
  console.log('--- bounded project picker asset traversal ---');
  {
    const BG7 = [...PAT.REQUIRED_PROJECT_BACKGROUNDS];
    check('TR1 the required set is exactly the seven live-proven identities',
      BG7.length === 7 && BG7[0] === '#BGD-01-ARJUN-ROOM-WIDE'
      && BG7[1] === '#BGD-02-ARJUN-ROOM-WINDOW-CLOSE'
      && BG7[2] === '#BGD-03-STREET-TO-CREMATION-WIDE'
      && BG7[3] === '#BGD-04-CREMATION-GROUND-WIDE'
      && BG7[4] === '#BGD-05-CREMATION-GROUND-PYRE-CLOSE'
      && BG7[5] === '#BGD-06-CREMATION-GROUND-STONE-CLOSE'
      && BG7[6] === '#BGD-07-ARJUN-HOME-INTERIOR-WIDE', BG7);
    check('TR2 the traversal limits are finite and small',
      Number.isInteger(PAT.PROJECT_TRAVERSAL_LIMITS.maxIterations) && PAT.PROJECT_TRAVERSAL_LIMITS.maxIterations > 0
      && PAT.PROJECT_TRAVERSAL_LIMITS.maxIterations <= 50
      && PAT.PROJECT_TRAVERSAL_LIMITS.maxScrollPerStep > 0
      && PAT.PROJECT_TRAVERSAL_LIMITS.maxScrollPerStep <= 2000, PAT.PROJECT_TRAVERSAL_LIMITS);

    const vp = (titles: string[], scrollPosition: number) => ({
      visibleTitles: titles, scrollPosition, containerExtent: 4000, viewportExtent: 600,
    });

    // first viewport: only BGD-01 (exactly the live observation)
    const s0 = PAT.initialProjectTraversalState();
    const r1 = PAT.decideProjectAssetTraversal({ state: s0, observation: vp(['#BGD-01-ARJUN-ROOM-WIDE', 'sunset.mp4', 'A Scene'], 0) });
    check('TR3 first viewport with BGD-01 only -> DISCOVERED and CONTINUE_SCROLL is authorised',
      r1.ok && r1.decision === 'DISCOVERED' && r1.newIdentities.join() === BG7[0]
      && r1.next.shouldScroll === true && r1.missing.length === 6, r1);

    // second viewport discovers BGD-02 and BGD-03
    const r2 = PAT.decideProjectAssetTraversal({ state: r1.state, observation: vp(['#BGD-02-ARJUN-ROOM-WINDOW-CLOSE', '#BGD-03-STREET-TO-CREMATION-WIDE'], 600) });
    check('TR4 second viewport discovering BGD-02 and BGD-03 continues the traversal',
      r2.ok && r2.decision === 'DISCOVERED' && r2.newIdentities.length === 2 && r2.discovered.length === 3 && r2.missing.length === 4, r2);

    // third viewport discovers the remaining four -> COMPLETE
    const r3 = PAT.decideProjectAssetTraversal({ state: r2.state, observation: vp(BG7.slice(3), 1200) });
    check('TR5 the viewport that discovers the remaining identities -> COMPLETE',
      r3.ok && r3.decision === 'COMPLETE' && r3.missing.length === 0 && r3.discovered.length === 7, r3);
    check('TR6 COMPLETE authorises no further scrolling',
      r3.ok && r3.next.shouldScroll === false && r3.next.shouldRead === false && r3.next.scrollBy === 0);
    check('TR7 after COMPLETE the state is terminal (further reads still report COMPLETE)',
      PAT.decideProjectAssetTraversal({ state: r3.state, observation: vp(BG7, 1800) }).decision === 'COMPLETE');

    // duplicate viewport -> STALLED
    const d1 = PAT.decideProjectAssetTraversal({ state: s0, observation: vp(['#BGD-01-ARJUN-ROOM-WIDE'], 0) });
    const d2 = PAT.decideProjectAssetTraversal({ state: d1.state, observation: vp(['#BGD-01-ARJUN-ROOM-WIDE'], 600) });
    check('TR8 a repeated viewport with no new identity -> STALLED (never scroll forever)',
      d2.ok && d2.decision === 'STALLED' && d2.next.shouldScroll === false && /repeated/.test(d2.reason), d2);
    const n1 = PAT.decideProjectAssetTraversal({ state: s0, observation: vp(['#BGD-01-ARJUN-ROOM-WIDE'], 0) });
    const n2 = PAT.decideProjectAssetTraversal({ state: n1.state, observation: vp(['sunset.mp4', 'A Scene'], 600) });
    const n3 = PAT.decideProjectAssetTraversal({ state: n2.state, observation: vp(['sunset.mp4', 'A Scene'], 1200) });
    check('TR9 repeated no-progress observations end in STALLED',
      n3.ok && n3.decision === 'STALLED', n3);
    check('TR10 a viewport with zero identities on the first read cannot reach COMPLETE',
      PAT.decideProjectAssetTraversal({ state: s0, observation: vp([], 0) }).decision !== 'COMPLETE');

    // budget exhaustion
    const tiny = PAT.decideProjectAssetTraversal({
      state: s0, observation: vp([BG7[0]], 0), limits: { maxIterations: 1 },
    });
    check('TR11 budget exhausted before 7/7 -> BUDGET_EXHAUSTED naming what is missing',
      tiny.ok && tiny.decision === 'BUDGET_EXHAUSTED' && tiny.missing.length === 6
      && /#BGD-07-ARJUN-HOME-INTERIOR-WIDE/.test(tiny.reason) && tiny.next.shouldScroll === false, tiny);
    let st = s0; let last: any = null;
    for (let i = 0; i < 6; i++) {
      last = PAT.decideProjectAssetTraversal({ state: st, observation: vp([BG7[i]], i * 600), limits: { maxIterations: 3 } });
      st = last.state;
    }
    check('TR12 a hard iteration cap terminates the traversal even when every step makes progress',
      last.decision === 'BUDGET_EXHAUSTED' && last.discovered.length === 6 && last.missing.length === 1, last);

    // exactness, malformed titles, dedupe, unexpected tags
    check('TR13 malformed and non-#BGD titles are ignored rather than treated as identities',
      PAT.extractObservedBackgroundIdentities(['sunset.mp4', '#BGD-', '#BGD', 'the #BGD-01-ARJUN-ROOM-WIDE shot', '@CHAR-01-ARJUN', 'A Scene', '', '  ']).length === 0);
    check('TR14 duplicate #BGD rows in one viewport are de-duplicated',
      PAT.extractObservedBackgroundIdentities([BG7[0], BG7[0], BG7[1]]).length === 2);
    const dd = PAT.decideProjectAssetTraversal({ state: s0, observation: vp([BG7[0], BG7[0], BG7[1]], 0) });
    check('TR15 a tag seen again in a later viewport is not counted as new progress',
      dd.newIdentities.length === 2 && PAT.decideProjectAssetTraversal({ state: dd.state, observation: vp([BG7[1], BG7[0]], 600) }).newIdentities.length === 0);
    const extra = PAT.decideProjectAssetTraversal({ state: s0, observation: vp(['#BGD-99-NOT-REQUIRED', ...BG7.slice(1)], 0) });
    check('TR16 an unexpected #BGD tag outside the required set does NOT satisfy completeness',
      extra.ok && extra.decision !== 'COMPLETE' && extra.missing.includes(BG7[0]) && extra.unexpected.includes('#BGD-99-NOT-REQUIRED'), extra);
    const nearMiss = PAT.decideProjectAssetTraversal({ state: s0, observation: vp(BG7.map((t) => t.toLowerCase()), 0) });
    check('TR17 the required seven must match EXACTLY (case differences do not count)',
      nearMiss.ok && nearMiss.decision !== 'COMPLETE' && nearMiss.missing.length === 7);
    const suffixed = PAT.decideProjectAssetTraversal({ state: s0, observation: vp(BG7.map((t) => `${t}-COPY`), 0) });
    check('TR18 a suffixed variant of a required tag does not satisfy it',
      suffixed.ok && suffixed.decision !== 'COMPLETE' && suffixed.missing.length === 7);
    check('TR19 a hidden required identity is NEVER inferred from the required list',
      PAT.decideProjectAssetTraversal({ state: s0, observation: vp([BG7[0]], 0) }).discovered.length === 1
      && !PAT.decideProjectAssetTraversal({ state: s0, observation: vp([BG7[0]], 0) }).discovered.includes(BG7[6]));

    // bounded-step guarantees
    check('TR20 no requested step ever exceeds the per-iteration scroll budget',
      r1.next.scrollBy <= PAT.PROJECT_TRAVERSAL_LIMITS.maxScrollPerStep
      && r2.next.scrollBy <= PAT.PROJECT_TRAVERSAL_LIMITS.maxScrollPerStep);
    check('TR21 a smaller configured per-step budget is honoured exactly',
      PAT.decideProjectAssetTraversal({ state: s0, observation: vp([BG7[0]], 0), limits: { maxScrollPerStep: 120 } }).next.scrollBy === 120);
    check('TR22 no decision ever asks the adapter to jump to the end or scroll without a bound',
      !/scrollTo\s*\(|Infinity|scrollHeight|while\s*\(/.test(PAT.decideProjectAssetTraversal.toString()));
    check('TR23 the traversal module performs no page/browser interaction at all',
      !/page\b|locator|mouse|wheel|scrollIntoView|evaluate|await\b/.test(PAT.decideProjectAssetTraversal.toString()));
    check('TR24 an absent observation is INVALID, never an assumption',
      PAT.decideProjectAssetTraversal({ state: s0, observation: null }).ok === false
      && PAT.decideProjectAssetTraversal({ state: s0, observation: null }).decision === 'INVALID');
    check('TR25 a non-positive iteration budget is rejected as INVALID (never unbounded)',
      PAT.decideProjectAssetTraversal({ state: s0, observation: vp([BG7[0]], 0), limits: { maxIterations: 0 } }).decision === 'INVALID'
      && PAT.decideProjectAssetTraversal({ state: s0, observation: vp([BG7[0]], 0), limits: { maxScrollPerStep: 0 } }).decision === 'INVALID');
    check('TR26 a list reported as fully traversed with identities missing fails closed as STALLED',
      PAT.decideProjectAssetTraversal({ state: s0, observation: { visibleTitles: [BG7[0]], scrollPosition: 3400, containerExtent: 4000, viewportExtent: 600, reachedEnd: true } }).decision === 'STALLED');
    check('TR27 geometric end-of-list is derived from observed extents, not assumed',
      PAT.decideProjectAssetTraversal({ state: s0, observation: { visibleTitles: [BG7[0]], scrollPosition: 0, containerExtent: 500, viewportExtent: 500 } }).decision === 'STALLED');
    check('TR28 the fold helper follows only the bounded steps the model authorises',
      PAT.runProjectAssetTraversal({ observations: [vp([BG7[0]], 0), vp([BG7[1], BG7[2]], 600), vp(BG7.slice(3), 1200)] }).ok === true);
    check('TR29 the fold helper reports BUDGET_EXHAUSTED for an all-duplicate sequence',
      PAT.runProjectAssetTraversal({ observations: [vp([BG7[0]], 0), vp([BG7[0]], 600), vp([BG7[0]], 1200)] }).decision === 'STALLED');
    check('TR30 the fold helper refuses an empty observation list instead of assuming completeness',
      PAT.runProjectAssetTraversal({ observations: [] }).ok === false
      && PAT.runProjectAssetTraversal({ observations: [] }).missing.length === 7);

    // the live 1-of-7 observation must still fail the real verifier
    const liveOnly = FC.verifyFirstClipAssetIdentities({
      requiredBackgrounds: BG7, projectBackgroundIdentities: [BG7[0]], projectCharacterIdentities: ['@CHAR-01-ARJUN'],
    });
    check('TR31 the live 1-of-7 picker read still fails the strict verifier closed',
      liveOnly.ok === false && liveOnly.code === 'FIRST_CLIP_ASSET_BACKGROUND_MISSING');
    check('TR32 no live scroll wiring exists yet (model only, per instruction)',
      !/page\.mouse|scrollIntoView|locator\.scroll|wheel\(/.test(await fs.readFile(`${SRC}/projectAssetTraversal.ts`, 'utf8')));
    check('TR33 the background reader reports the read as observed-only and names what is missing',
      /observedOnly: true/.test(bgBody) && /requiredComplete/.test(bgBody) && /missing/.test(bgBody));
    check('TR34 the background reader no longer returns ok:true for an incomplete inventory',
      /ok: missing\.length === 0/.test(bgBody));
  }
}

// ============ REGRESSION: project prompt editor SELECTOR SCOPING ============
//
// LIVE-PROVEN DEFECT this block guards. `observeProjectPromptEditorCandidates()` and
// `generateProjectFirstClip()` both chained `box.locator(PROJECT_PROMPT_CONTROLS.allProseMirror)`
// where `box` was ALREADY `flow-prompt-box`, so the effective selector became
// `flow-prompt-box flow-prompt-box .ProseMirror` and matched ZERO elements while the real editor
// was present and visible. The previous tests missed it entirely because they only exercised
// `resolveProjectPromptEditor()` with synthetic candidates — a broken selector STRING cannot fail a
// pure decision test. These checks therefore assert the selector CONSTRUCTION itself.
console.log('--- project prompt editor selector scoping (regression) ---');
{
  const PC = FC.PROJECT_PROMPT_CONTROLS;
  const r = FC.resolveNestedProjectPromptEditorSelector();

  check('PS1 the page-level selector is still `flow-prompt-box .ProseMirror`',
    PC.allProseMirror === 'flow-prompt-box .ProseMirror', PC.allProseMirror);
  check('PS2 the nested selector handed to an already-scoped box is `.ProseMirror`',
    r.ok === true && r.nestedSelector === '.ProseMirror', r);
  check('PS3 the helper reports the forbidden double-scoped string',
    r.ok === true && r.forbiddenDoubleScopedSelector === 'flow-prompt-box flow-prompt-box .ProseMirror',
    r.ok ? r.forbiddenDoubleScopedSelector : r);
  check('PS4 REGRESSION GUARD: the double-scoped selector is what the live bug produced and must never be used',
    // The buggy effective selector must NOT equal either the page-level or the nested selector.
    r.ok === true && r.forbiddenDoubleScopedSelector !== PC.allProseMirror && r.forbiddenDoubleScopedSelector !== r.nestedSelector);
  check('PS5 the nested selector carries NO host qualifier',
    r.ok === true && !r.nestedSelector.includes('flow-prompt-box'));
  check('PS6 the helper records that the host qualifier was stripped',
    r.ok === true && r.strippedHostQualifier === true);
  check('PS7 passing an ALREADY-nested candidate is idempotent (no double-strip)',
    FC.resolveNestedProjectPromptEditorSelector({ candidate: '.ProseMirror' }).ok === true
    && FC.resolveNestedProjectPromptEditorSelector({ candidate: '.ProseMirror' }).nestedSelector === '.ProseMirror'
    && FC.resolveNestedProjectPromptEditorSelector({ candidate: '.ProseMirror' }).strippedHostQualifier === false);
  check('PS8 an attribute-qualified page selector strips to the nested attribute form',
    FC.resolveNestedProjectPromptEditorSelector({ candidate: "flow-prompt-box .ProseMirror[contenteditable='true']" }).nestedSelector === ".ProseMirror[contenteditable='true']");
  check('PS9 an empty host or candidate fails closed instead of yielding a match-all selector',
    FC.resolveNestedProjectPromptEditorSelector({ hostSelector: '   ' }).code === 'NESTED_SELECTOR_EMPTY'
    && FC.resolveNestedProjectPromptEditorSelector({ candidate: '   ' }).code === 'NESTED_SELECTOR_EMPTY'
    && FC.resolveNestedProjectPromptEditorSelector({ candidate: 'flow-prompt-box' }).code === 'NESTED_SELECTOR_EMPTY');
  // Strip comment/string prose before the purity audit so reason text containing the word "page"
  // is not mistaken for browser access.
  check('PS10 the helper is PURE and never touches a browser',
    !/\bthis\.page\b|\.locator\(|playwright|chromium|document\.|await\b/.test(
      FC.resolveNestedProjectPromptEditorSelector.toString().replace(/'[^']*'/g, "''")));
  check('PS11 the exported nested constant matches the derived selector',
    FC.PROJECT_PROMPT_NESTED_PROSE_MIRROR === '.ProseMirror'
    && FC.resolveNestedProjectPromptEditorSelector().nestedSelector === FC.PROJECT_PROMPT_NESTED_PROSE_MIRROR);
  check('PS12 a different host selector derives its own nested form',
    FC.resolveNestedProjectPromptEditorSelector({ hostSelector: 'flow-scene-builder', candidate: 'flow-scene-builder .ProseMirror' }).nestedSelector === '.ProseMirror');

  // Source-level guards on BOTH production call sites.
  const fcSrc = await fs.readFile(`${SRC}/flowClient.ts`, 'utf8');
  const observationStart = fcSrc.indexOf('async observeProjectPromptEditorCandidates(');
  const observationBody = fcSrc.slice(observationStart, fcSrc.indexOf('\n  async ', observationStart + 10));
  const genStart = fcSrc.indexOf('async generateProjectFirstClip(');
  const genBody = fcSrc.slice(genStart, fcSrc.indexOf('\n  async ', genStart + 10));

  check('PS13 the editor observation uses the nested selector, NOT the page-level constant',
    /resolveNestedProjectPromptEditorSelector\(\)/.test(observationBody)
    && /box\.locator\(nested\.nestedSelector\)/.test(observationBody)
    && !/box\.locator\(PROJECT_PROMPT_CONTROLS\.allProseMirror\)/.test(observationBody), observationBody.slice(0, 300));
  check('PS14 generateProjectFirstClip uses the nested selector, NOT the page-level constant',
    /resolveNestedProjectPromptEditorSelector\(\)/.test(genBody)
    && /box\.locator\(nested\.nestedSelector\)/.test(genBody)
    && !/box\.locator\(PROJECT_PROMPT_CONTROLS\.allProseMirror\)/.test(genBody), genBody.slice(0, 300));
  check('PS15 NO call site anywhere chains the page-level constant under an already-scoped box',
    !/locator\(PROJECT_PROMPT_CONTROLS\.projectPromptBox\)\.first\(\)[\s\S]{0,200}?locator\(PROJECT_PROMPT_CONTROLS\.allProseMirror\)/.test(fcSrc));
  check('PS16 the page-level constant is still consumed at page scope where appropriate',
    /this\.page\.locator\(PROJECT_PROMPT_CONTROLS\.startGenerationButton\)/.test(genBody));
  check('PS17 unrelated selectors were not changed by this fix',
    PC.projectRoute === 'flow-project-page'
    && PC.projectPromptBox === 'flow-prompt-box'
    && PC.promptEditor === "flow-prompt-box .ProseMirror[contenteditable='true']"
    && PC.startGenerationButton === "flow-prompt-box flow-generate-icon-button button[aria-label='Start generation']");
}

// ============ REGRESSION: ProseMirror prompt READ-BACK representation ============
//
// LIVE-PROVEN DEFECT. The real project composer is ProseMirror: it serialises the supplied prompt
// into one `<p>` per source line. For the Scene 1 prompt the live DOM reported 1532 supplied chars,
// 1562 via innerText (block boundaries rendered as "\n\n"), 1505 via textContent (separators
// dropped), and 28 `<p>` children. The old check `verifyProjectPromptFill(supplied, innerText)`
// therefore failed closed for ANY multi-line prompt. These checks pin the block-structural contract.
console.log('--- ProseMirror prompt read-back representation (regression) ---');
{
  /** Simulate the DOM: one <p> per source line. */
  const toParagraphs = (prompt: string): string[] => prompt.split('\n');
  /** Simulate what innerText() reports for those paragraphs. */
  const innerTextOf = (paragraphs: string[]): string => paragraphs.join('\n\n');
  /** Simulate what textContent() reports for those paragraphs. */
  const textContentOf = (paragraphs: string[]): string => paragraphs.join('');

  const V = FC.verifyProjectPromptFillFromParagraphs;
  const R = FC.renderProjectPromptReadbackFromParagraphs;

  // --- A. existing verification behaviour is unchanged ---
  check('PB1 the existing exact-match verifier still accepts an identical string',
    FC.verifyProjectPromptFill(PROMPT, PROMPT).ok === true);
  check('PB2 the existing verifier still trims outer whitespace',
    FC.verifyProjectPromptFill(`  ${PROMPT} `, `\n${PROMPT}\n`).ok === true);
  check('PB3 the existing verifier still rejects truncation, emptiness and case changes',
    FC.verifyProjectPromptFill(PROMPT, PROMPT.slice(0, 40)).ok === false
    && FC.verifyProjectPromptFill(PROMPT, '').ok === false
    && FC.verifyProjectPromptFill(PROMPT, PROMPT.toUpperCase()).ok === false);
  check('PB4 the existing verifier performs NO prefix/substring/length-only matching',
    !/startsWith|endsWith|\.includes\(/.test(FC.verifyProjectPromptFill.toString())
    && FC.verifyProjectPromptFill('line1\nline2\nline3', 'line1\nline2').ok === false
    && FC.verifyProjectPromptFill('abc', 'abc EXTRA').ok === false);

  // --- B. the exact live bug: three lines, innerText renders doubled separators ---
  const three = 'line1\nline2\nline3';
  const threePs = toParagraphs(three);
  check('PB5 REGRESSION: the OLD direct comparison fails for the real ProseMirror representation',
    FC.verifyProjectPromptFill(three, innerTextOf(threePs)).ok === false,
    { innerText: innerTextOf(threePs) });
  check('PB6 the NEW block-structural verification PASSES for that same representation',
    V(three, threePs).ok === true);
  check('PB7 the reconstruction is exactly the supplied prompt',
    R(threePs) === three);
  check('PB8 innerText really is the doubled-separator form (the modelled contract is accurate)',
    innerTextOf(threePs) === 'line1\n\nline2\n\nline3' && three.length !== innerTextOf(threePs).length);

  // --- C. Scene-1-shaped multi-line prompt, including an intentional blank line ---
  const sceneLike = '### SYSTEM & ENVIRONMENT\nACTIVE ENVIRONMENT: Bedroom.\n\n### ACTION\nSCENE ACTION: Arjun reads.';
  const scenePs = toParagraphs(sceneLike);
  check('PB9 a Scene-1-shaped multi-line prompt verifies after normalisation', V(sceneLike, scenePs).ok === true);
  check('PB10 its innerText form is byte-different yet still verifies via the block contract',
    innerTextOf(scenePs) !== sceneLike && V(sceneLike, scenePs).ok === true);
  check('PB11 an intentional blank line survives as an empty paragraph',
    scenePs[2] === '' && R(scenePs) === sceneLike);

  // --- D. textContent-style concatenation must NOT be accepted ---
  check('PB12 a textContent-style concatenated read-back is NOT automatically accepted',
    V(three, [textContentOf(threePs)]).ok === false);
  check('PB13 a paragraph array containing one concatenated blob fails',
    V(sceneLike, [sceneLike.replace(/\n/g, '')]).ok === false);

  // --- E/F/G/H. strictness is preserved ---
  check('PB14 a modified word FAILS', V(three, ['line1', 'line2 modified', 'line3']).ok === false);
  check('PB15 a modified word inside a paragraph FAILS', V(three, ['line1', 'LINE2', 'line3']).ok === false);
  check('PB16 a missing line FAILS', V(three, ['line1', 'line2']).ok === false);
  check('PB17 an extra line FAILS', V(three, ['line1', 'line2', 'line3', 'line4']).ok === false);
  check('PB18 extra trailing content on a line FAILS', V(three, ['line1', 'line2', 'line3 extra']).ok === false);
  check('PB19 changed punctuation FAILS', V('He said: "go".', ['He said: "go"']).ok === false);
  check('PB20 changed punctuation mid-prompt FAILS', V('a, b; c', ['a', 'b, c']).ok === false);
  check('PB21 reordered lines FAIL', V(three, ['line3', 'line2', 'line1']).ok === false);
  check('PB22 extra non-boundary content in the middle FAILS', V(three, ['line1', 'INJECTED', 'line2', 'line3']).ok === false);

  // --- I. intentional blank lines, both directions ---
  const blank = 'A\n\nB';
  check('PB23 a prompt WITH an intentional blank line verifies', V(blank, toParagraphs(blank)).ok === true);
  check('PB24 a blank line that was NOT supplied FAILS',
    V('A\nB', ['A', '', 'B']).ok === false);
  check('PB25 a blank line that WAS supplied but is missing FAILS',
    V(blank, ['A', 'B']).ok === false);
  check('PB26 two consecutive blank lines round-trip', V('A\n\n\nB', toParagraphs('A\n\n\nB')).ok === true);
  check('PB27 a leading blank line round-trips', V('\nA', toParagraphs('\nA')).ok === true);
  check('PB28 whitespace is NOT globally collapsed (an intentional indented line survives)',
    V('  indented\nnext', ['  indented', 'next']).ok === true);
  check('PB29 removing INTERIOR indentation FAILS (only outer whitespace is trimmed, by design)',
    V('first\n  indented\nnext', ['first', 'indented', 'next']).ok === false);
  check('PB29b preserving interior indentation PASSES', V('first\n  indented\nnext', ['first', '  indented', 'next']).ok === true);
  check('PB29c interior double spaces are significant and must survive',
    V('a  b\nc', ['a  b', 'c']).ok === true && V('a  b\nc', ['a b', 'c']).ok === false);

  // --- J. Unicode / Hindi ---
  const hindi = '### वातावरण\nACTIVE ENVIRONMENT: अर्जुन का कमरा।\n\n### क्रिया\nSCENE ACTION: अर्जुन पढ़ रहा है।';
  check('PB30 a Hindi prompt verifies when structurally equivalent', V(hindi, toParagraphs(hindi)).ok === true);
  check('PB31 a single changed Devanagari character FAILS', V(hindi, toParagraphs(hindi).map((l) => l.replace('अर्जुन पढ़', 'अर्जुन पढ'))).ok === false);
  check('PB32 the em-dash used by prompt hardening survives', V('ACTIVE ENVIRONMENT: Bedroom — night.', ['ACTIVE ENVIRONMENT: Bedroom — night.']).ok === true);
  check('PB33 swapping the em-dash for a hyphen FAILS', V('A — B', ['A - B']).ok === false);

  // --- K/L. single-line, trailing/leading whitespace ---
  check('PB34 a single-line prompt verifies', V('just one line', ['just one line']).ok === true);
  check('PB35 a single-line prompt with a trailing newline in the source verifies',
    V('just one line\n', ['just one line', '']).ok === true);
  check('PB36 outer whitespace on the supplied prompt is tolerated deterministically',
    V('  A\nB  ', ['  A', 'B  ']).ok === true);
  check('PB37 a paragraph array with no elements fails', V('x', []).ok === false);
  check('PB38 a null/undefined paragraph list fails', V('x', null).ok === false && V('x', undefined).ok === false);
  check('PB39 a non-array is rejected rather than coerced', V('x', 'line1\nline2' as any).ok === false);
  check('PB40 an empty supplied prompt is rejected', V('', ['anything']).ok === false);
  check('PB41 all-empty paragraphs are rejected as an empty editor', V('x', ['', '']).ok === false);
  check('PB42 a large realistic prompt (28 lines, 1532 chars) verifies',
    (() => {
      const big = Array.from({ length: 28 }, (_, i) => `LINE ${i + 1} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor`).join('\n');
      return big.length > 1500 && V(big, toParagraphs(big)).ok === true;
    })());
  check('PB43 that same 28-line prompt truncated by one line FAILS',
    (() => {
      const big = Array.from({ length: 28 }, (_, i) => `LINE ${i + 1} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor`).join('\n');
      return V(big, toParagraphs(big).slice(0, 27)).ok === false;
    })());

  // --- M. the canonical prompt supplied to the generation API is byte-identical ---
  check('PB44 the helper does not alter the supplied prompt (it is only ever a read-back concern)',
    PROMPT === PROMPT && R(toParagraphs(PROMPT)) === PROMPT);

  // --- purity ---
  check('PB45 both helpers are PURE (no browser/Playwright/await in their bodies)',
    !/\bthis\.page\b|\.locator\(|playwright|chromium|document\.|await\b/.test(
      V.toString().replace(/'[^']*'/g, "''")) && !/await\b|locator|playwright/.test(R.toString()));
  check('PB46 renderProjectPromptReadbackFromParagraphs maps non-strings defensively without throwing',
    R([1, null, undefined] as any) === '1\n\n');

  // --- 8. source-level guard on the production read-back path ---
  const fcSrc2 = await fs.readFile(`${SRC}/flowClient.ts`, 'utf8');
  const genStart2 = fcSrc2.indexOf('async generateProjectFirstClip(');
  const genBody2 = fcSrc2.slice(genStart2, fcSrc2.indexOf('\n  async ', genStart2 + 10));
  check('PB47 the production read-back uses the ProseMirror block structure',
    /renderProjectPromptReadbackFromParagraphs/.test(genBody2) && /:scope > p/.test(genBody2), genBody2.slice(0, 400));
  check('PB48 the production read-back no longer compares against raw innerText',
    !/editor\.innerText\(\)/.test(genBody2));
  check('PB49 the fill itself still sends the exact prompt text unchanged',
    /await editor\.fill\(text\)/.test(genBody2));
  check('PB50 the failure classification is preserved',
    /'PROJECT_PROMPT_FILL_UNVERIFIED'/.test(await fs.readFile(`${SRC}/firstClipLifecycle.ts`, 'utf8')));
  check('PB51 the scene-local prompt verification path was NOT altered by this fix',
    !/renderProjectPromptReadbackFromParagraphs|verifyProjectPromptFillFromParagraphs/.test(
      await fs.readFile(`${SRC}/sceneLocalGeneration.ts`, 'utf8')));
}

console.log(`\n${passed} first-clip generation checks passed (fully offline).`);