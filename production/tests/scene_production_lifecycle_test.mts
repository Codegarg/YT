// Focused OFFLINE tests for the canonical Scene production lifecycle (project-first settings).
//
// Proves: project settings precede scene creation and gate it; exact required project settings;
// asset-lock gating; exact ingredient set; scene inherited-display observation (model/duration/
// aspect only); inherited mismatch fails, unobservable does not; 720p/x1 stay project-level;
// the credit guard sits immediately before generation; exactly one generation; no retry;
// no project-level generation; no local synthesis; persistence-before-download; per-phase failure
// classification. Fully offline: a fake port records calls. NO browser, NO Flow, NO credits.
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const L = await import(pathToFileURL(`${SRC}/sceneProductionLifecycle.ts`).href);
const SLG = await import(pathToFileURL(`${SRC}/sceneLocalGeneration.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const BG = '#BGD-01-ARJUN-ROOM-WIDE';
const CH = '@CHAR-01-ARJUN';
const BG_SRC = 'https://flow-content.google/image/ccef4b18-bd27-49ca-913b-9df3b6b91e06?Expires=1&KeyName=k&Signature=s';
const CH_TOKEN = 'ANqvLOZFRtN_rGJtVov-uurQdHR9u_I8251JrG98HK2zZ5w06';
const CH_SRC = `https://lh3.googleusercontent.com/asb/${CH_TOKEN}?s=1`;
const RAIL_OK = [{ tag: BG, src: BG_SRC }];
const CH_EV = { expectedTag: CH, pickerToken: CH_TOKEN, chipToken: CH_TOKEN, verified: true, code: 'CHARACTER_ATTACHMENT_VERIFIED' };
const EV_OK = { chipSrcs: [BG_SRC], railEntries: RAIL_OK, characterChipSrcs: [CH_SRC], characterAttachmentEvidence: [CH_EV] };
const CHARS = ['@CHAR-01-ARJUN', '@CHAR-02-MAA', '@CHAR-03-RADHADEVI-ATMA', '@CHAR-04-DADI'];
const BGS = ['#BGD-01-ARJUN-ROOM-WIDE', '#BGD-02-ARJUN-ROOM-WINDOW-CLOSE', '#BGD-03-STREET-TO-CREMATION-WIDE', '#BGD-04-CREMATION-GROUND-WIDE', '#BGD-05-CREMATION-GROUND-PYRE-CLOSE', '#BGD-06-CREMATION-GROUND-STONE-CLOSE', '#BGD-07-ARJUN-HOME-INTERIOR-WIDE'];
const PROMPT = '### SYSTEM & ENVIRONMENT\nCLIP LENGTH: Let Flow determine...\nACTIVE ENVIRONMENT: ' + BG + '\nACTIVE CHARACTERS: ' + CH;
const GOOD_PROJECT_SETTINGS = { mode: 'Video', model: 'Omni 1.1 Flash', resolution: '720p', duration: '8s', aspect: '16:9', batch: 'x1' };
const GOOD_DISPLAY = { model: 'Omni 1.1 Flash', duration: '8s', aspect: '16:9' };
const AUTH_TARGET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AUTH_CLIP = '11111111-1111-4111-8111-111111111111';
const AUTH_OTHER_CLIP = '22222222-2222-4222-8222-222222222222';
const AUTH = { operation: 'EXTEND' as const, targetSceneId: AUTH_TARGET, expectedCommittedClipId: AUTH_CLIP };

function fakePort(overrides: any = {}) {
  const calls: string[] = [];
  const rec = { generateSceneVideoPrompts: [] as string[], generateSceneVideoOptions: [] as any[], generateProjectVideoCalls: 0, selectAssetTags: [] as string[] };
  const port: any = {
    async configureProjectVideoSettings() { calls.push('configureProjectVideoSettings'); if (overrides.configureProjectVideoSettings) throw new Error('project-settings-fail'); },
    async observeProjectVideoSettings() { calls.push('observeProjectVideoSettings'); return overrides.projectSettings ?? GOOD_PROJECT_SETTINGS; },
    // Live Flow asset identities. Defaults to the exact required sets; `visibleAssets`/`readOk`/
    // `readReason` overrides model what the READER observed, exactly as a real surface would.
    async readFlowAssetIdentities() { calls.push('readFlowAssetIdentities'); if (overrides.readFlowAssetIdentities) return overrides.readFlowAssetIdentities(); return { ok: overrides.readOk ?? true, characters: overrides.visibleAssets?.characters ?? CHARS, backgrounds: overrides.visibleAssets?.backgrounds ?? BGS, ...(overrides.readReason ? { reason: overrides.readReason } : {}) }; },
    async createScene() { calls.push('createScene'); if (overrides.createScene) throw new Error('create-fail'); return overrides.sceneId === null ? { sceneId: '', url: '' } : { sceneId: 'scene-uuid-0001', url: 'u' }; },
    async openSceneEditor(id: string) { calls.push('openSceneEditor:' + id); if (overrides.openSceneEditor) throw new Error('open-fail'); return { url: 'u' }; },
    async selectAsset(tag: string) { calls.push('selectAsset:' + tag); rec.selectAssetTags.push(tag); if (overrides.selectAsset) throw new Error('asset-fail'); },
    async selectCharacterAssetWithVerification(tag: string) { calls.push('selectCharacterAssetWithVerification:' + tag); rec.selectAssetTags.push(tag); if (overrides.selectCharacterAssetWithVerification) return overrides.selectCharacterAssetWithVerification(tag); return { ...CH_EV, expectedTag: tag }; },
    async readSceneComposerIngredientEvidence() { calls.push('readSceneComposerIngredientEvidence'); return overrides.evidence ?? EV_OK; },
    async observeSceneInheritedDisplay() { calls.push('observeSceneInheritedDisplay'); if (overrides.observeSceneInheritedDisplay) throw new Error('display-unreadable'); return overrides.display ?? GOOD_DISPLAY; },
    async generateSceneVideo(prompt: string, options: any) { calls.push('generateSceneVideo'); rec.generateSceneVideoPrompts.push(prompt); rec.generateSceneVideoOptions.push(options); if (overrides.generateSceneVideo) throw new Error('gen-fail'); return { title: '', artifactId: overrides.artifactId ?? 'artifact-uuid-abc' }; },
    async sceneHasClip() { calls.push('sceneHasClip'); return overrides.sceneHasClip ?? true; },
    async verifyScenePersistence(_ref: string, artifactId: string) { calls.push('verifyScenePersistence'); if (overrides.verifyScenePersistence) throw new Error('persist-fail'); return { committedClipId: overrides.committedClipId ?? 'committed-uuid-xyz' }; },
    async downloadCommittedSceneClip(n: number, dest: string, opts: any) { calls.push('downloadCommittedSceneClip:' + dest); if (overrides.downloadCommittedSceneClip) throw new Error('dl-fail'); return { ok: overrides.downloadOk ?? true, result: 'DOWNLOAD_SUCCESS' }; },
    // Forbidden project-level generator (distinct from configureVideoGeneration).
    async generateProjectVideo() { rec.generateProjectVideoCalls++; throw new Error('PROJECT-LEVEL GENERATION MUST NOT BE CALLED'); },
    async renderLocalScene() { calls.push('renderLocalScene'); throw new Error('LOCAL SYNTHESIS MUST NOT BE CALLED'); },
  };
  return { port, calls, rec };
}

const baseInput = (over: any = {}) => ({
  sceneNumber: 1,
  prompt: PROMPT,
  backgroundTag: BG,
  characterTags: [CH],
  destinationPath: 'inputs/p/flow-clips/scene-0001.mp4',
  requiredAssets: { characters: CHARS, backgrounds: BGS },
  visibleAssets: { characters: CHARS, backgrounds: BGS },
  readOk: true,
  generationAuthorized: true,
  validateDownloaded: async () => ({ ok: true, durationSeconds: 8, width: 1280, height: 720 }),
  ...over,
});

// ============ 1/2. project settings precede + gate scene creation ============
console.log('--- project settings ordering ---');
{
  const { port, calls } = fakePort();
  const r = await L.runSceneProductionLifecycle(port, baseInput());
  check('1 happy path succeeds', r.ok === true && r.sceneId === 'scene-uuid-0001' && r.artifactId === 'artifact-uuid-abc' && r.committedClipId === 'committed-uuid-xyz', r);
  check('1b phases execute in the exact canonical order', JSON.stringify(r.phases) === JSON.stringify(L.SCENE_LIFECYCLE_PHASES), r.phases);
  check('1c the phase constant is the canonical 13-phase order',
    L.SCENE_LIFECYCLE_PHASES.join(',') === 'PROJECT_SETTINGS,ASSET_LOCKS,SCENE_CREATE,SCENE_OPEN,ATTACH_ASSETS,VERIFY_INGREDIENTS,VERIFY_INHERITED_DISPLAY,GENERATION_GUARD,GENERATE,COMMIT,PERSIST,DOWNLOAD,VALIDATE', L.SCENE_LIFECYCLE_PHASES);
  check('1d project settings are configured BEFORE scene creation',
    calls.indexOf('configureProjectVideoSettings') < calls.indexOf('createScene') && calls.indexOf('configureProjectVideoSettings') === 0, calls);
  check('1e project settings are verified before scene creation',
    calls.indexOf('observeProjectVideoSettings') < calls.indexOf('createScene'), calls);

  const bad = fakePort({ configureProjectVideoSettings: true });
  const r2 = await L.runSceneProductionLifecycle(bad.port, baseInput());
  check('2 a project-settings configure failure -> PROJECT_VIDEO_SETTINGS_NOT_READY @ PROJECT_SETTINGS',
    r2.ok === false && r2.code === 'PROJECT_VIDEO_SETTINGS_NOT_READY' && r2.phase === 'PROJECT_SETTINGS', r2);
  check('2b scene creation is NEVER attempted when project settings fail', !bad.calls.includes('createScene'), bad.calls);
  check('2c nothing after project settings runs', bad.calls.length === 1 && bad.calls[0] === 'configureProjectVideoSettings', bad.calls);
}

// ============ 3. exact required project settings ============
console.log('--- project settings contract ---');
{
  check('3 required project settings are Video/Omni 1.1 Flash/720p/8s/16:9/x1',
    L.SCENE_REQUIRED_SETTINGS.model === 'Omni 1.1 Flash' && L.SCENE_REQUIRED_SETTINGS.resolution === '720p'
    && L.SCENE_REQUIRED_SETTINGS.duration === '8s' && L.SCENE_REQUIRED_SETTINGS.aspect === '16:9' && L.SCENE_REQUIRED_SETTINGS.batch === 'x1', L.SCENE_REQUIRED_SETTINGS);
  check('3b a fully-correct observation verifies', L.verifyProjectVideoSettings(GOOD_PROJECT_SETTINGS).ok === true);
  check('3c mode != Video -> not ready', L.verifyProjectVideoSettings({ ...GOOD_PROJECT_SETTINGS, mode: 'Image' }).ok === false);
  check('3d wrong resolution -> not ready', L.verifyProjectVideoSettings({ ...GOOD_PROJECT_SETTINGS, resolution: '1080p' }).ok === false);
  check('3e non-x1 batch -> not ready', L.verifyProjectVideoSettings({ ...GOOD_PROJECT_SETTINGS, batch: 'x2' }).ok === false);
  check('3f missing observation -> not ready', L.verifyProjectVideoSettings(undefined).ok === false);

  const wrongMode = fakePort({ projectSettings: { ...GOOD_PROJECT_SETTINGS, mode: 'Image' } });
  const r = await L.runSceneProductionLifecycle(wrongMode.port, baseInput());
  check('3g a wrong project mode fails closed and blocks scene creation',
    r.code === 'PROJECT_VIDEO_SETTINGS_NOT_READY' && !wrongMode.calls.includes('createScene'), r);
}

// ============ 4. asset-lock gating ============
console.log('--- asset locks ---');
{
  // The asset gate reads the LIVE surface via port.readFlowAssetIdentities(); `visibleAssets`/
// `readOk`/`readReason` now configure what that READER observed, not the lifecycle input.
  const missing = fakePort({ visibleAssets: { characters: CHARS, backgrounds: BGS.filter((b: string) => b !== BG) } });
  const r1 = await L.runSceneProductionLifecycle(missing.port, baseInput());
  check('4 a missing required background -> ASSET_LOCKS_NOT_VERIFIED', r1.code === 'ASSET_LOCKS_NOT_VERIFIED' && r1.phase === 'ASSET_LOCKS', r1);
  check('4b asset-lock failure blocks scene creation', !missing.calls.includes('createScene'), missing.calls);
  const amb = fakePort({ visibleAssets: { characters: [...CHARS, CH], backgrounds: BGS } });
  const r2 = await L.runSceneProductionLifecycle(amb.port, baseInput());
  check('4c an ambiguous character -> ASSET_LOCKS_NOT_VERIFIED', r2.code === 'ASSET_LOCKS_NOT_VERIFIED', r2);
  const unread = fakePort({ readOk: false, readReason: 'surface down' });
  const r3 = await L.runSceneProductionLifecycle(unread.port, baseInput());
  check('4d an unreadable surface -> ASSET_LOCKS_NOT_VERIFIED (never "empty")', r3.code === 'ASSET_LOCKS_NOT_VERIFIED' && /surface down/.test(String(r3.reason)), r3);

  // An EMPTY-but-successful read must NOT be accepted as verified.
  const emptyOk = fakePort({ readFlowAssetIdentities: async () => ({ ok: true, characters: [], backgrounds: [] }) });
  const r3b = await L.runSceneProductionLifecycle(emptyOk.port, baseInput());
  check('4e a successful-but-EMPTY live read is NOT verified (11 assets read as missing)',
    r3b.code === 'ASSET_LOCKS_NOT_VERIFIED' && !emptyOk.calls.includes('generateSceneVideo'), r3b);

  // Caller-supplied asset state must NOT substitute for live verification.
  const supplied = fakePort({ readFlowAssetIdentities: async () => ({ ok: false, characters: [], backgrounds: [], reason: 'surface not observed' }) });
  const r3c = await L.runSceneProductionLifecycle(supplied.port, baseInput({ visibleAssets: { characters: CHARS, backgrounds: BGS }, readOk: true }));
  check('4f caller-supplied visibleAssets are IGNORED by ASSET_LOCKS (never a bypass)',
    r3c.code === 'ASSET_LOCKS_NOT_VERIFIED' && /not observed/.test(String(r3c.reason)), r3c);
  check('4g ASSET_LOCKS reads the live surface and nothing after it runs when the read fails',
    supplied.calls.includes('readFlowAssetIdentities') && !supplied.calls.includes('createScene')
    && !supplied.calls.includes('generateSceneVideo'), supplied.calls);
  const okSurf = fakePort();
  const r3d = await L.runSceneProductionLifecycle(okSurf.port, baseInput());
  check('4h a live read of the exact required identities verifies and proceeds',
    r3d.ok === true && okSurf.calls.indexOf('readFlowAssetIdentities') < okSurf.calls.indexOf('createScene'), okSurf.calls);
}

// ============ 5/6. ingredients ============
console.log('--- ingredients ---');
{
  const EXACT_EV = EV_OK;
  check('5 exact chip evidence classifies EXACT', SLG.classifyIngredientEvidence([BG, CH], EXACT_EV).state === 'EXACT');
  check('5b EXACT reports both background and character present',
    SLG.classifyIngredientEvidence([BG, CH], EXACT_EV).backgroundPresent && SLG.classifyIngredientEvidence([BG, CH], EXACT_EV).charactersPresent);
  check('6 missing chip -> MISSING', SLG.classifyIngredientEvidence([BG, CH], { chipSrcs: [BG_SRC], railEntries: RAIL_OK, characterChipSrcs: [], characterAttachmentEvidence: [] }).state === 'MISSING');
  check('6b duplicate character transaction -> DUPLICATE', SLG.classifyIngredientEvidence([BG, CH], { chipSrcs: [BG_SRC], railEntries: RAIL_OK, characterChipSrcs: [CH_SRC, CH_SRC], characterAttachmentEvidence: [CH_EV, CH_EV] }).state === 'DUPLICATE');
  check('6c an unverified character transaction -> IDENTITY_UNRESOLVED',
    SLG.classifyIngredientEvidence([BG, CH], { chipSrcs: [BG_SRC], railEntries: RAIL_OK, characterChipSrcs: [CH_SRC], characterAttachmentEvidence: [{ ...CH_EV, verified: false, code: 'CHARACTER_ATTACHMENT_IDENTITY_MISMATCH' }] }).state === 'IDENTITY_UNRESOLVED');
  check('6d a chip uuid absent from the rail map -> IDENTITY_UNRESOLVED',
    SLG.classifyIngredientEvidence([BG, CH], { chipSrcs: [BG_SRC], railEntries: [], characterChipSrcs: [CH_SRC], characterAttachmentEvidence: [CH_EV] }).state === 'IDENTITY_UNRESOLVED');
  check('6e malformed evidence -> INVALID', SLG.classifyIngredientEvidence([BG, CH], undefined as any).state === 'INVALID');

  const dup = fakePort({ evidence: { chipSrcs: [BG_SRC], railEntries: RAIL_OK, characterChipSrcs: [CH_SRC, CH_SRC], characterAttachmentEvidence: [CH_EV, CH_EV] } });
  const r = await L.runSceneProductionLifecycle(dup.port, baseInput());
  check('6f duplicate ingredients fail closed with INGREDIENTS_NOT_READY', r.code === 'INGREDIENTS_NOT_READY' && r.phase === 'VERIFY_INGREDIENTS', r);
  check('6g a failed ingredient check never reaches generation', !dup.calls.includes('generateSceneVideo'), dup.calls);

  const failedTxn = fakePort({ selectCharacterAssetWithVerification: () => ({ ...CH_EV, verified: false, code: 'CHARACTER_ATTACHMENT_IDENTITY_MISMATCH' }) });
  const r2 = await L.runSceneProductionLifecycle(failedTxn.port, baseInput());
  check('6h a failed character selection transaction blocks at ATTACH_ASSETS', r2.code === 'INGREDIENTS_NOT_READY' && r2.phase === 'ATTACH_ASSETS', r2);
  check('6i a failed transaction never reaches generation', !failedTxn.calls.includes('generateSceneVideo'), failedTxn.calls);
}

// ============ 7/8/9/10. inherited display ============
console.log('--- inherited display ---');
{
  const d1 = L.classifyInheritedDisplay(GOOD_DISPLAY, GOOD_DISPLAY);
  check('7 all three exposed values match -> MATCH', d1.state === 'MATCH' && d1.status === 'SCENE_INHERITED_SETTINGS_MATCH', d1);
  check('7b MATCH reports no mismatches and no unobservable fields', d1.mismatches.length === 0 && d1.unobservable.length === 0, d1);

  const d2 = L.classifyInheritedDisplay({ model: 'Veo 3', duration: '8s', aspect: '16:9' }, GOOD_DISPLAY);
  check('8 a contradicting displayed model -> MISMATCH', d2.state === 'MISMATCH' && d2.mismatches.some((m: any) => m.field === 'model'), d2);

  const mismatch = fakePort({ display: { model: 'Veo 3', duration: '8s', aspect: '16:9' } });
  const r = await L.runSceneProductionLifecycle(mismatch.port, baseInput());
  check('8b a contradicting scene display fails closed with SCENE_INHERITED_SETTINGS_MISMATCH',
    r.code === 'SCENE_INHERITED_SETTINGS_MISMATCH' && r.phase === 'VERIFY_INHERITED_DISPLAY', r);
  check('8c a mismatch never reaches generation', !mismatch.calls.includes('generateSceneVideo'), mismatch.calls);

  const d3 = L.classifyInheritedDisplay({ model: null, duration: null, aspect: null }, GOOD_DISPLAY);
  check('9 no exposed values -> UNOBSERVABLE (not a failure)', d3.state === 'UNOBSERVABLE' && d3.status === 'SCENE_INHERITED_SETTINGS_UNOBSERVABLE', d3);

  const unobs = fakePort({ display: { model: null, duration: null, aspect: null } });
  const r2 = await L.runSceneProductionLifecycle(unobs.port, baseInput());
  check('9b an unobservable display still completes the lifecycle', r2.ok === true, r2);
  check('9c the unobservable case is classified separately', r2.inheritedDisplay === 'SCENE_INHERITED_SETTINGS_UNOBSERVABLE', r2.inheritedDisplay);

  const unreadable = fakePort({ observeSceneInheritedDisplay: true });
  const r3 = await L.runSceneProductionLifecycle(unreadable.port, baseInput());
  check('9d an unreadable scene surface is UNOBSERVABLE, not a failure', r3.ok === true && r3.inheritedDisplay === 'SCENE_INHERITED_SETTINGS_UNOBSERVABLE', r3);

  // 10. 720p / x1 are project-level authoritative and NEVER part of the scene check.
  const d4 = L.classifyInheritedDisplay({ model: 'Omni 1.1 Flash', duration: '8s', aspect: '16:9' }, GOOD_DISPLAY);
  check('10 resolution/batch are not fields of the inherited-display check', !('resolution' in d4) && !('batch' in d4) && d4.unobservable.length === 0, d4);
  check('10b the project contract still enforces 720p and x1', L.verifyProjectVideoSettings({ ...GOOD_PROJECT_SETTINGS, resolution: '1080p' }).ok === false && L.verifyProjectVideoSettings({ ...GOOD_PROJECT_SETTINGS, batch: 'x4' }).ok === false);
}

// ============ 11. generation guard immediately before generation ============
console.log('--- credit guard ---');
{
  const okIng = SLG.classifyIngredientEvidence([BG, CH], EV_OK);
  const good = L.evaluateGenerationGuard({ sceneNumber: 1, prompt: PROMPT, ingredients: okIng, settingsVerified: true, generationAuthorized: true, generationAttempts: 0, localClipValid: false, committedClipPresent: false, sceneExists: true });
  check('11 a fully-satisfied guard passes', good.ok === true, good);
  const cases: Array<[string, any]> = [
    ['not authorized', { generationAuthorized: false }],
    ['attempt already made', { generationAttempts: 1 }],
    ['local clip already valid', { localClipValid: true }],
    ['clip already committed', { committedClipPresent: true }],
    ['scene does not exist', { sceneExists: false }],
    ['settings not verified', { settingsVerified: false }],
    ['empty prompt', { prompt: '   ' }],
  ];
  for (const [label, over] of cases) {
    const g = L.evaluateGenerationGuard({ sceneNumber: 1, prompt: PROMPT, ingredients: okIng, settingsVerified: true, generationAuthorized: true, generationAttempts: 0, localClipValid: false, committedClipPresent: false, sceneExists: true, ...over });
    check(`11 guard fails closed: ${label}`, g.ok === false, g);
  }
  const unauthorized = fakePort();
  const r = await L.runSceneProductionLifecycle(unauthorized.port, baseInput({ generationAuthorized: false }));
  check('11b unauthorized generation -> GENERATION_GUARD_FAILED @ GENERATION_GUARD', r.code === 'GENERATION_GUARD_FAILED' && r.phase === 'GENERATION_GUARD', r);
  check('11c the guard sits immediately before generation (no generate call)', !unauthorized.calls.includes('generateSceneVideo'), unauthorized.calls);
  check('11d VERIFY_INHERITED_DISPLAY precedes GENERATION_GUARD in the phase list',
    L.SCENE_LIFECYCLE_PHASES.indexOf('VERIFY_INHERITED_DISPLAY') < L.SCENE_LIFECYCLE_PHASES.indexOf('GENERATION_GUARD'));

  // Dedicated AUTHORIZED scene-local guard: it is the ONLY guard that accepts a committed clip,
  // and only when the exact scene/clip authorization matches the observed evidence.
  const authGuard = (over: any = {}) => ({
    sceneNumber: 1, prompt: PROMPT, ingredients: okIng, settingsVerified: true,
    generationAuthorized: true, generationAttempts: 0, localClipValid: false,
    committedClipPresent: true, sceneExists: true, targetSceneId: AUTH_TARGET,
    observedCommittedClipId: AUTH_CLIP, authorization: AUTH, ...over,
  });
  check('11e dedicated authorized guard accepts exact committed evidence',
    SLG.canGenerateAuthorizedSceneLocal(authGuard()).ok === true, SLG.canGenerateAuthorizedSceneLocal(authGuard()));
  const authCases: Array<[string, any]> = [
    ['missing authorization', { authorization: null }],
    ['committed clip absent', { committedClipPresent: false }],
    ['unobserved committed clip', { observedCommittedClipId: '' }],
    ['mismatched committed clip', { observedCommittedClipId: AUTH_OTHER_CLIP }],
    ['mismatched target', { targetSceneId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }],
    ['local clip present', { localClipValid: true }],
    ['generation not authorized', { generationAuthorized: false }],
    ['attempt already made', { generationAttempts: 1 }],
  ];
  for (const [label, over] of authCases) {
    check(`11f authorized guard fails closed: ${label}`, SLG.canGenerateAuthorizedSceneLocal(authGuard(over)).ok === false);
  }

  const authPort = fakePort();
  const authRun = await L.runSceneProductionLifecycle(authPort.port, baseInput({
    targetSceneId: AUTH_TARGET, committedClipPresent: true,
    sceneLocalAuthorization: AUTH, observedCommittedClipId: AUTH_CLIP,
  }));
  check('11g authorized scene-local lifecycle succeeds with the exact committed clip',
    authRun.ok === true && authPort.calls.filter((c) => c === 'generateSceneVideo').length === 1, authRun);
  const authMismatchPort = fakePort();
  const authMismatch = await L.runSceneProductionLifecycle(authMismatchPort.port, baseInput({
    targetSceneId: AUTH_TARGET, committedClipPresent: true,
    sceneLocalAuthorization: AUTH, observedCommittedClipId: AUTH_OTHER_CLIP,
  }));
  check('11h authorized guard mismatch stops before any generation',
    authMismatch.code === 'GENERATION_GUARD_FAILED' && !authMismatchPort.calls.includes('generateSceneVideo'), authMismatch);

  // The lifecycle itself also refuses an authorized request without an exact existing target or a
  // verified committed clip, BEFORE project settings/scene creation/editor work.
  const authNoTarget = fakePort();
  const noTargetRun = await L.runSceneProductionLifecycle(authNoTarget.port, baseInput({
    sceneLocalAuthorization: AUTH, committedClipPresent: true, observedCommittedClipId: AUTH_CLIP,
  }));
  check('11i authorized lifecycle without an existing target stops before any Flow work',
    noTargetRun.code === 'TARGET_SCENE_INVALID' && noTargetRun.phase === 'TARGET_SCENE' && authNoTarget.calls.length === 0, noTargetRun);
  const authNoClip = fakePort();
  const noClipRun = await L.runSceneProductionLifecycle(authNoClip.port, baseInput({
    targetSceneId: AUTH_TARGET, committedClipPresent: false,
    sceneLocalAuthorization: AUTH, observedCommittedClipId: AUTH_CLIP,
  }));
  check('11j authorized lifecycle without a committed clip stops before any Flow work',
    noClipRun.code === 'GENERATION_GUARD_FAILED' && noClipRun.phase === 'TARGET_SCENE' && authNoClip.calls.length === 0, noClipRun);
}

// ============ 12/13. exactly one generation, no retry ============
console.log('--- generation call contract ---');
{
  const { port, rec, calls } = fakePort();
  await L.runSceneProductionLifecycle(port, baseInput());
  check('12 the EXACT scene prompt is propagated', rec.generateSceneVideoPrompts.length === 1 && rec.generateSceneVideoPrompts[0] === PROMPT);
  check('12b expectedIngredients is exactly [background, ...characters]', JSON.stringify(rec.generateSceneVideoOptions[0].expectedIngredients) === JSON.stringify([BG, CH]), rec.generateSceneVideoOptions[0]);
  check('12c generateSceneVideo is called EXACTLY once', calls.filter((c) => c === 'generateSceneVideo').length === 1, calls);
  check('12d assets are attached background-first then characters', JSON.stringify(rec.selectAssetTags) === JSON.stringify([BG, CH]), rec.selectAssetTags);

  const fail = fakePort({ generateSceneVideo: true });
  const r = await L.runSceneProductionLifecycle(fail.port, baseInput());
  check('13 a generation failure is NOT retried (exactly one attempt)', r.code === 'GENERATION_FAILED' && fail.calls.filter((c) => c === 'generateSceneVideo').length === 1, fail.calls);
  check('13b no phase runs after a generation failure', !fail.calls.includes('verifyScenePersistence') && !fail.calls.some((c) => c.startsWith('downloadCommittedSceneClip')), fail.calls);
}

// ============ 14/15. forbidden paths ============
console.log('--- forbidden paths ---');
{
  const { port, rec, calls } = fakePort();
  const r = await L.runSceneProductionLifecycle(port, baseInput());
  check('14 the lifecycle never calls generateProjectVideo', rec.generateProjectVideoCalls === 0 && r.ok === true, rec);
  check('14b only scene-local generation is used', calls.includes('generateSceneVideo') && !calls.includes('generateProjectVideo'), calls);
  check('15 the lifecycle never calls a local synthesiser', !calls.includes('renderLocalScene'), calls);
  check('15b the module exposes no project-level generation entry point', !/generateProjectVideo/.test(String(L.runSceneProductionLifecycle)), 'n/a');
}

// ============ 16/17. persistence gating ============
console.log('--- persistence before download ---');
{
  const persistFail = fakePort({ verifyScenePersistence: true });
  const r = await L.runSceneProductionLifecycle(persistFail.port, baseInput());
  check('16 a persistence failure -> CLIP_PERSISTENCE_FAILED', r.code === 'CLIP_PERSISTENCE_FAILED' && r.phase === 'PERSIST', r);
  check('16b download is NEVER attempted when persistence fails', !persistFail.calls.some((c) => c.startsWith('downloadCommittedSceneClip')), persistFail.calls);

  const notCommitted = fakePort({ sceneHasClip: false });
  const r2 = await L.runSceneProductionLifecycle(notCommitted.port, baseInput());
  check('16c an uncommitted clip -> CLIP_NOT_COMMITTED and no persistence/download',
    r2.code === 'CLIP_NOT_COMMITTED' && !notCommitted.calls.includes('verifyScenePersistence') && !notCommitted.calls.some((c) => c.startsWith('downloadCommittedSceneClip')), r2);

  const ok = fakePort();
  const r3 = await L.runSceneProductionLifecycle(ok.port, baseInput());
  check('17 download happens AFTER persistence on the happy path', ok.calls.indexOf('verifyScenePersistence') < ok.calls.findIndex((c) => c.startsWith('downloadCommittedSceneClip')), ok.calls);
  check('17b download targets the exact canonical destination', r3.clipPath === 'inputs/p/flow-clips/scene-0001.mp4' && ok.calls.some((c) => c === 'downloadCommittedSceneClip:inputs/p/flow-clips/scene-0001.mp4'), r3);
  check('17c decideDownloadAfterPersistence refuses before persistence', L.decideDownloadAfterPersistence(false).ok === false);
  check('17d decideDownloadAfterPersistence permits after persistence', L.decideDownloadAfterPersistence(true).ok === true);
}

// ============ 18. failure classification per phase ============
console.log('--- failure classification ---');
{
  const expect = async (label: string, over: any, code: string, phase: string) => {
    const { port } = fakePort(over);
    const r = await L.runSceneProductionLifecycle(port, baseInput());
    check(`18 ${label} -> ${code} @ ${phase}`, r.ok === false && r.code === code && r.phase === phase, r);
  };
  await expect('create throws', { createScene: true }, 'SCENE_CREATE_FAILED', 'SCENE_CREATE');
  await expect('no scene id', { sceneId: null }, 'SCENE_ID_UNAVAILABLE', 'SCENE_CREATE');
  await expect('open throws', { openSceneEditor: true }, 'SCENE_OPEN_FAILED', 'SCENE_OPEN');
  await expect('asset attach throws', { selectAsset: true }, 'INGREDIENTS_NOT_READY', 'ATTACH_ASSETS');
  await expect('generation throws', { generateSceneVideo: true }, 'GENERATION_FAILED', 'GENERATE');
  await expect('download fails', { downloadCommittedSceneClip: true }, 'DOWNLOAD_FAILED', 'DOWNLOAD');

  const invalid = fakePort();
  const r = await L.runSceneProductionLifecycle(invalid.port, baseInput({ validateDownloaded: async () => ({ ok: false, reason: 'no audio stream' }) }));
  check('18 downloaded clip invalid -> DOWNLOADED_CLIP_INVALID @ VALIDATE', r.code === 'DOWNLOADED_CLIP_INVALID' && r.phase === 'VALIDATE', r);

  const noArtifact = fakePort({ artifactId: '' });
  const r2 = await L.runSceneProductionLifecycle(noArtifact.port, baseInput());
  check('18 no artifact id -> GENERATION_FAILED', r2.code === 'GENERATION_FAILED', r2);
}

// ============ 19. existing target scene ============
console.log('--- existing target scene ---');
{
  const TARGET = '11111111-1111-4111-8111-111111111111';
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const TARGET_URL = `https://flow.google.com/project/project-1/scene/${TARGET}`;

  const byId = fakePort();
  const r = await L.runSceneProductionLifecycle(byId.port, baseInput({ targetSceneId: TARGET }));
  check('21 existing target skips createScene', !byId.calls.includes('createScene') && r.ok === true, byId.calls);
  check('21b existing target opens the EXACT scene id', byId.calls.includes(`openSceneEditor:${TARGET}`) && r.sceneId === TARGET, { calls: byId.calls, r });
  check('21c existing-target phases omit SCENE_CREATE but keep the canonical attach/verify/generate order',
    JSON.stringify(r.phases) === JSON.stringify([
      'PROJECT_SETTINGS', 'ASSET_LOCKS', 'SCENE_OPEN', 'ATTACH_ASSETS', 'VERIFY_INGREDIENTS',
      'VERIFY_INHERITED_DISPLAY', 'GENERATION_GUARD', 'GENERATE', 'COMMIT', 'PERSIST', 'DOWNLOAD', 'VALIDATE',
    ]), r.phases);
  check('21d open precedes background attach, verification and generation',
    byId.calls.indexOf(`openSceneEditor:${TARGET}`) < byId.calls.indexOf(`selectAsset:${BG}`)
    && byId.calls.indexOf(`selectAsset:${BG}`) < byId.calls.indexOf('readSceneComposerIngredientEvidence')
    && byId.calls.indexOf('readSceneComposerIngredientEvidence') < byId.calls.indexOf('generateSceneVideo'), byId.calls);
  check('21e existing target still supplies the exact expected ingredient set',
    JSON.stringify(byId.rec.generateSceneVideoOptions[0].expectedIngredients) === JSON.stringify([BG, CH]), byId.rec.generateSceneVideoOptions[0]);

  const byUrl = fakePort();
  const rUrl = await L.runSceneProductionLifecycle(byUrl.port, baseInput({ targetSceneUrl: TARGET_URL }));
  check('22 an existing-target URL resolves to the exact scene id and skips createScene',
    rUrl.ok === true && rUrl.sceneId === TARGET && !byUrl.calls.includes('createScene')
    && byUrl.calls.includes(`openSceneEditor:${TARGET}`), { calls: byUrl.calls, r: rUrl });

  const both = fakePort();
  const rBoth = await L.runSceneProductionLifecycle(both.port, baseInput({ targetSceneId: TARGET, targetSceneUrl: TARGET_URL }));
  check('23 both target forms -> TARGET_SCENE_AMBIGUOUS before any Flow work',
    rBoth.ok === false && rBoth.code === 'TARGET_SCENE_AMBIGUOUS' && rBoth.phase === 'TARGET_SCENE' && both.calls.length === 0, { r: rBoth, calls: both.calls });

  const empty = fakePort();
  const rEmpty = await L.runSceneProductionLifecycle(empty.port, baseInput({ targetSceneId: '   ' }));
  check('24 an empty target id -> TARGET_SCENE_INVALID before any Flow work',
    rEmpty.ok === false && rEmpty.code === 'TARGET_SCENE_INVALID' && rEmpty.phase === 'TARGET_SCENE' && empty.calls.length === 0, { r: rEmpty, calls: empty.calls });

  const multi = fakePort();
  const rMulti = await L.runSceneProductionLifecycle(multi.port, baseInput({ targetSceneUrl: `${TARGET_URL}/scene/${OTHER}` }));
  check('25 a URL containing multiple scene routes -> TARGET_SCENE_AMBIGUOUS before any Flow work',
    rMulti.ok === false && rMulti.code === 'TARGET_SCENE_AMBIGUOUS' && rMulti.phase === 'TARGET_SCENE' && multi.calls.length === 0, { r: rMulti, calls: multi.calls });

  const notScene = fakePort();
  const rNotScene = await L.runSceneProductionLifecycle(notScene.port, baseInput({ targetSceneUrl: 'https://flow.google.com/project/project-1' }));
  check('26 a non-scene URL -> TARGET_SCENE_INVALID before any Flow work',
    rNotScene.ok === false && rNotScene.code === 'TARGET_SCENE_INVALID' && rNotScene.phase === 'TARGET_SCENE' && notScene.calls.length === 0, { r: rNotScene, calls: notScene.calls });

  const badEvidence = fakePort({
    evidence: { chipSrcs: [BG_SRC], railEntries: RAIL_OK, characterChipSrcs: [], characterAttachmentEvidence: [] },
  });
  const rBad = await L.runSceneProductionLifecycle(badEvidence.port, baseInput({ targetSceneId: TARGET }));
  check('27 failed exact-ingredient verification on an existing target blocks generation',
    rBad.code === 'INGREDIENTS_NOT_READY' && rBad.phase === 'VERIFY_INGREDIENTS'
    && !badEvidence.calls.includes('generateSceneVideo') && badEvidence.calls.includes('readSceneComposerIngredientEvidence'), badEvidence.calls);

  const badTxn = fakePort({
    selectCharacterAssetWithVerification: () => ({ ...CH_EV, verified: false, code: 'CHARACTER_ATTACHMENT_IDENTITY_MISMATCH' }),
  });
  const rBadTxn = await L.runSceneProductionLifecycle(badTxn.port, baseInput({ targetSceneId: TARGET }));
  check('28 failed character attachment on an existing target blocks generation',
    rBadTxn.code === 'INGREDIENTS_NOT_READY' && rBadTxn.phase === 'ATTACH_ASSETS'
    && !badTxn.calls.includes('generateSceneVideo'), badTxn.calls);
}

// ============ 20. preserved behaviour ============
console.log('--- preserved behaviour ---');
{
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(`${SRC}/sceneProductionLifecycle.ts`, 'utf8');
  check('19 the lifecycle module does not reference the legacy runner', !/runner\.js/.test(src), 'n/a');
  check('19b the lifecycle uses the project-level configureVideoGeneration binding, never generateProjectVideo',
    /configureProjectVideoSettings: \(\) => flow\.configureVideoGeneration\(\)/.test(src) && !/flow\.generateProjectVideo/.test(src), 'n/a');
  check('20 the existing scene-local settings contract is unchanged',
    SLG.REQUIRED_SCENE_SETTINGS.model === 'Omni 1.1 Flash' && typeof SLG.verifySceneSettings === 'function' && SLG.verifySceneSettings(GOOD_PROJECT_SETTINGS).ok === true);
  check('20b the lifecycle still uses scene-local generation (generateSceneVideo)', /generateSceneVideo/.test(src));

  // production binding
  const complete = {
    configureVideoGeneration: async () => {}, observeProjectVideoSettings: async () => GOOD_PROJECT_SETTINGS,
    createScene: async () => ({ sceneId: 's', url: 'u' }), openSceneEditor: async () => ({ url: 'u' }),
    selectAsset: async () => {}, selectCharacterAssetWithVerification: async (t: string) => ({ ...CH_EV, expectedTag: t }), readSceneComposerIngredientEvidence: async () => EV_OK, observeSceneInheritedDisplay: async () => GOOD_DISPLAY,
    generateSceneVideo: async () => ({ title: '', artifactId: 'a' }), sceneHasClip: async () => true,
    reconcileGeneratedVideoWithScene: async () => ({ committedSceneArtifactId: 'committed-1' }),
    downloadCommittedSceneClip: async () => ({ ok: true }),
    listSceneIds: async () => ['scene-1'],
    listRailAssetTags: async () => BGS,
    listCharacterPickerTags: async () => CHARS,
  };
  const bound = L.createFlowSceneLifecyclePort(complete);
  check('20c a complete FlowClient binds to the port', typeof bound.generateSceneVideo === 'function' && typeof bound.observeSceneInheritedDisplay === 'function');
  check('20d verifyScenePersistence maps reconcileGeneratedVideoWithScene → committedClipId',
    JSON.stringify(await bound.verifyScenePersistence('scene-1', 'artifact-1')) === JSON.stringify({ committedClipId: 'committed-1' }));
  const liveSurface = await bound.readFlowAssetIdentities();
  check('20g readFlowAssetIdentities opens a scene surface and reads STABLE identities from it',
    liveSurface.ok === true && JSON.stringify(liveSurface.backgrounds) === JSON.stringify(BGS)
    && JSON.stringify(liveSurface.characters) === JSON.stringify(CHARS)
    && !/\/asb\//.test(JSON.stringify(liveSurface)), liveSurface);
  const noScene = { ...complete, listSceneIds: async () => [] } as any;
  const noSceneSurface = await L.createFlowSceneLifecyclePort(noScene).readFlowAssetIdentities();
  check('20h an unresolvable scene surface fails closed (never "no assets")',
    noSceneSurface.ok === false && !noSceneSurface.characters.length && /no canonical Flow scene surface/.test(String(noSceneSurface.reason)), noSceneSurface);
  const pref = await L.createFlowSceneLifecyclePort(complete, { assetVerificationSceneId: 'scene-pinned' }).readFlowAssetIdentities();
  check('20i an explicit assetVerificationSceneId pins the verification surface', pref.ok === true, pref);
  const missingSurface = { ...complete } as any; delete missingSurface.listRailAssetTags;
  let threw2 = false; try { L.createFlowSceneLifecyclePort(missingSurface); } catch { threw2 = true; }
  check('20j a client missing the scene asset readers fails closed at port construction', threw2 === true);
  const incomplete = { ...complete } as any; delete incomplete.observeSceneInheritedDisplay;
  let threw = false; try { L.createFlowSceneLifecyclePort(incomplete); } catch { threw = true; }
  check('20e a client missing a required primitive fails closed', threw === true);
  const r = await L.runSceneProductionLifecycle(L.createFlowSceneLifecyclePort(complete), baseInput());
  check('20f the bound lifecycle completes the happy path', r.ok === true && r.committedClipId === 'committed-1', r);
}

console.log(`\n${passed} scene-production lifecycle checks passed (fully offline).`);
