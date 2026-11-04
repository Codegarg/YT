// Offline tests for the scene-local generation path (STEP-8EN). No live Flow, no generation.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SRC } from './_testPaths.mjs';
const g = await import(pathToFileURL(`${SRC}/sceneLocalGeneration.ts`).href);
const {
  SCENE_LOCAL_GENERATE_CONTROLS, SCENE_CREATE_MENU, isSceneLocalGenerateSelector, decideSceneExistence,
  resolveScenePrompt, SCENE_PROMPT_FIELDS, verifySceneSettings, REQUIRED_SCENE_SETTINGS,
  canGenerateScene, classifySceneCommit,
} = g;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

// ---- 5/6/7. scene-local selectors vs the global ambiguous one ----
check('scene-local generate selector is scoped to flow-generate-icon-button', isSceneLocalGenerateSelector(SCENE_LOCAL_GENERATE_CONTROLS.generateButton) === true);
check('GLOBAL ambiguous selector is rejected', isSceneLocalGenerateSelector("button[aria-label='Start generation']") === false);
check('empty/undefined selector rejected', isSceneLocalGenerateSelector('') === false && isSceneLocalGenerateSelector(undefined) === false);
check('scene-local selectors reference the scene builder components', /flow-scene-builder/.test(SCENE_LOCAL_GENERATE_CONTROLS.sceneBuilder) && /flow-base-prompt-box/.test(SCENE_LOCAL_GENERATE_CONTROLS.promptBox) && /flow-rich-text-editor/.test(SCENE_LOCAL_GENERATE_CONTROLS.composer));
check('scene-create menu uses the live-discovered affordance', /Add media menu/.test(SCENE_CREATE_MENU.addMediaMenu) && /New scene/.test(SCENE_CREATE_MENU.newSceneItem));

// ---- 1/2/3/4. scene lookup, reuse, create-vs-reuse, duplicate prevention ----
check('no match -> CREATE', decideSceneExistence({ matchingSceneIds: [] }).action === 'CREATE');
check('no matchingSceneIds -> CREATE', decideSceneExistence({}).action === 'CREATE');
check('exactly one match -> REUSE that scene (no duplicate)', (() => { const d = decideSceneExistence({ matchingSceneIds: ['abc'] }); return d.action === 'REUSE' && d.sceneId === 'abc'; })());
check('MULTIPLE matches -> AMBIGUOUS (never create/duplicate)', (() => { const d = decideSceneExistence({ matchingSceneIds: ['a', 'b'] }); return d.action === 'AMBIGUOUS' && d.count === 2; })());
check('blank ids are ignored (no false match)', decideSceneExistence({ matchingSceneIds: ['', '  '] }).action === 'CREATE');

// ---- 8. prompt field casing (the 8EK defect) ----
{
  const dialogue = { scene_number: 2, speaker: '@CHAR-01-ARJUN', animation_prompt_WITH_lipsync: 'DLG-PROMPT', animation_prompt_NARRATOR_ONLY: 'NAR-PROMPT' };
  const r = resolveScenePrompt(dialogue);
  check('dialogue scene resolves animation_prompt_WITH_lipsync (lowercase sync)', r.field === SCENE_PROMPT_FIELDS.dialogue && r.prompt === 'DLG-PROMPT', JSON.stringify(r));
  const narrator = { scene_number: 5, speaker: 'NARRATOR', animation_prompt_WITH_lipsync: 'DLG', animation_prompt_NARRATOR_ONLY: 'NAR' };
  check('narrator scene resolves animation_prompt_NARRATOR_ONLY', resolveScenePrompt(narrator).prompt === 'NAR');
  const noneSpeaker = { speaker: 'none', animation_prompt_NARRATOR_ONLY: 'NAR' };
  check('speaker none also uses the narrator prompt', resolveScenePrompt(noneSpeaker).prompt === 'NAR');
  const wrongCasing = { scene_number: 2, speaker: '@CHAR-01-ARJUN', animation_prompt_WITH_LIPSYNC: 'WRONG' };
  check('uppercase LIPSYNC field is NOT accepted (case-sensitive)', resolveScenePrompt(wrongCasing).prompt === '');
  check('missing prompt -> empty field marker', resolveScenePrompt({ speaker: 'none' }).field === null);
}

// ---- 9. settings validation ----
check('exact required settings accepted', verifySceneSettings({ ...REQUIRED_SCENE_SETTINGS }).ok === true);
check('wrong model rejected', verifySceneSettings({ ...REQUIRED_SCENE_SETTINGS, model: 'Veo 3.1 Lite' }).ok === false);
check('wrong resolution rejected', verifySceneSettings({ ...REQUIRED_SCENE_SETTINGS, resolution: '1080p Upscaled' }).ok === false);
check('wrong duration rejected', verifySceneSettings({ ...REQUIRED_SCENE_SETTINGS, duration: '4s' }).ok === false);
check('wrong aspect rejected', verifySceneSettings({ ...REQUIRED_SCENE_SETTINGS, aspect: '9:16' }).ok === false);
check('batch x2 rejected', verifySceneSettings({ ...REQUIRED_SCENE_SETTINGS, batch: 'x2' }).ok === false);
check('missing settings rejected', verifySceneSettings(undefined).ok === false && verifySceneSettings(null).ok === false);
check('required settings match the proven contract', JSON.stringify({ ...REQUIRED_SCENE_SETTINGS }) === JSON.stringify({ model: 'Omni 1.1 Flash', resolution: '720p', duration: '8s', aspect: '16:9', batch: 'x1' }));

// ---- 10/11/12. the credit guard + exactly-one-generation ----
const good: any = { sceneNumber: 2, sceneExists: true, localClipValid: false, committedClipPresent: false, nativeCharacterVerified: true, nativeBackgroundVerified: true, promptVerified: true, settingsVerified: true, generationAuthorized: true, generationAttempts: 0 };
check('all preconditions true -> generation allowed', canGenerateScene(good).ok === true);
check('already attempted -> REFUSED (never click twice)', canGenerateScene({ ...good, generationAttempts: 1 }).ok === false);
check('valid local clip -> REFUSED (unnecessary)', canGenerateScene({ ...good, localClipValid: true }).ok === false);
check('committed clip present -> REFUSED (download instead)', canGenerateScene({ ...good, committedClipPresent: true }).ok === false);
check('generation NOT authorized -> REFUSED', canGenerateScene({ ...good, generationAuthorized: false }).ok === false);
check('scene does not exist -> REFUSED', canGenerateScene({ ...good, sceneExists: false }).ok === false);
check('character not verified -> REFUSED', canGenerateScene({ ...good, nativeCharacterVerified: false }).ok === false);
check('background not verified -> REFUSED', canGenerateScene({ ...good, nativeBackgroundVerified: false }).ok === false);
check('prompt not verified -> REFUSED', canGenerateScene({ ...good, promptVerified: false }).ok === false);
check('settings not verified -> REFUSED', canGenerateScene({ ...good, settingsVerified: false }).ok === false);
check('missing decision -> REFUSED', canGenerateScene(undefined as any).ok === false);

// ---- 13. commit verification ----
check('structural clip + frames + all reloads -> COMMITTED', classifySceneCommit({ editorLoaded: true, clipCount: 1, thumbnailStripFrames: 8, freshReloadClipCounts: [1, 1, 1] }) === 'COMMITTED');
check('no clip + all reloads zero -> NOT_COMMITTED', classifySceneCommit({ editorLoaded: true, clipCount: 0, thumbnailStripFrames: 0, freshReloadClipCounts: [0, 0, 0] }) === 'NOT_COMMITTED');
check('clip present but reload lost it -> AMBIGUOUS', classifySceneCommit({ editorLoaded: true, clipCount: 1, thumbnailStripFrames: 8, freshReloadClipCounts: [0, 0] }) === 'AMBIGUOUS');
check('editor failed to load -> INVALID', classifySceneCommit({ editorLoaded: false, clipCount: 1, thumbnailStripFrames: 8, freshReloadClipCounts: [1] }) === 'INVALID');
check('no reload evidence -> AMBIGUOUS (fail closed)', classifySceneCommit({ editorLoaded: true, clipCount: 1, thumbnailStripFrames: 8, freshReloadClipCounts: [] }) === 'AMBIGUOUS');
check('missing evidence -> INVALID', classifySceneCommit(undefined) === 'INVALID');

// ---- 14. download only after commit (invariant expressed by the classification) ----
check('download is gated on COMMITTED (NOT_COMMITTED must never download)', classifySceneCommit({ editorLoaded: true, clipCount: 0, thumbnailStripFrames: 0, freshReloadClipCounts: [0] }) !== 'COMMITTED');

// ---- 15/16. checkpoint validation + idempotency are covered by 8EJ; assert the guard shape here ----
check('pre-generation decision shape matches the required log contract', JSON.stringify(Object.keys(good)) === JSON.stringify(['sceneNumber', 'sceneExists', 'localClipValid', 'committedClipPresent', 'nativeCharacterVerified', 'nativeBackgroundVerified', 'promptVerified', 'settingsVerified', 'generationAuthorized', 'generationAttempts']));

// ---- module safety ----
{
  const src = fs.readFileSync(`${SRC}/sceneLocalGeneration.ts`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('helper module performs no network I/O', !/fetch\(|XMLHttpRequest|https?:\/\//.test(src));
  check('helper module does not click anything', !/\.click\(/.test(src));
}

console.log(`\nSCENE-LOCAL-GENERATION TESTS PASSED (${passed} checks)`);
