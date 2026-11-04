// Offline regression tests for the deterministic appearance/wardrobe contract.
// No Flow, no Chrome, no network, no credits, no project writes.
import { pathToFileURL } from 'node:url';
import { SRC } from './_testPaths.mjs';

const W = await import(pathToFileURL(`${SRC}/characterWardrobe.ts`).href);
const H = await import(pathToFileURL(`${SRC}/flowPromptHardening.ts`).href);
const FCL = await import(pathToFileURL(`${SRC}/firstClipLifecycle.ts`).href);
const WF = await import(pathToFileURL(`${SRC}/sceneFlowWorkflow.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const BG = { tag: '#BGD-01-ARJUN-ROOM-WIDE', location_name: "Arjun's Bedroom", look_summary: 'Simple Indian bedroom at night.' };
const ARJUN = {
  tag: '@CHAR-01-ARJUN',
  name: 'Arjun',
  look_summary: '22-year-old Indian man, casual nightwear, neutral 3/4 pose.',
  full_prompt: 'Reference sheet: old red shirt, neutral 3/4 pose.',
  appearance_lock: {
    age: '22-year-old adult Indian man',
    gender: 'male',
    build: 'medium build',
    skin: 'medium brown skin',
    face: 'oval face, clean-shaven',
    hair: 'short black hair',
    facial_hair: 'none',
    marks: 'none',
  },
  wardrobe: {
    default_outfit: 'nightwear',
    outfits: {
      nightwear: {
        label: 'sleepwear',
        top: 'steel grey cotton t-shirt',
        bottom: 'navy blue pyjama trousers',
        outerwear: 'none',
        footwear: 'barefoot',
        accessories: 'none',
        notes: 'loose comfortable fit',
      },
      rain_coat: {
        label: 'rain outfit',
        top: 'dark green rain jacket',
        bottom: 'navy blue pyjama trousers',
        outerwear: 'dark green hooded raincoat',
        footwear: 'black rubber sandals',
        accessories: 'none',
        notes: 'hood down',
      },
    },
  },
};
const YOUNG_ARJUN = {
  ...ARJUN,
  tag: '@CHAR-05-YOUNG-ARJUN',
  name: 'Young Arjun',
  appearance_lock: { ...ARJUN.appearance_lock, age: '8-year-old Indian child', build: 'small child build' },
  wardrobe: {
    default_outfit: 'play_clothes',
    outfits: {
      play_clothes: {
        top: 'faded olive green cotton shirt',
        bottom: 'brown cotton shorts',
        outerwear: 'none',
        footwear: 'worn brown sandals',
        accessories: 'none',
        notes: 'child-sized, slightly dusty',
      },
    },
  },
};
const CHARACTERS = [ARJUN, YOUNG_ARJUN];
const SCENE = {
  scene_number: 1,
  background_tag: BG.tag,
  character_tags: [ARJUN.tag],
  speaker: 'NARRATOR',
  visual_action: 'Arjun stands near the window.',
  camera: 'static wide shot',
  effects: 'rain',
  outfit_ids: {},
};
const PROMPT = `ACTIVE ENVIRONMENT: ${BG.tag}\nACTIVE CHARACTERS: ${ARJUN.tag}\n\nSCENE ACTION: Arjun stands near the window.`;

// 1. Mode + deterministic formatting.
check('detectWardrobeMode promotes an explicit contract to strict', W.detectWardrobeMode(CHARACTERS) === 'strict');
check('detectWardrobeMode keeps a look_summary-only cast legacy',
  W.detectWardrobeMode([{ tag: ARJUN.tag, name: 'Arjun', look_summary: '22-year-old man.' }]) === 'legacy');
check('project marker is authoritative',
  W.detectWardrobeMode({ wardrobe_schema_version: 1, characters: [] }) === 'strict');
check('appearance formatting is exact and deterministic',
  W.formatAppearance(ARJUN.appearance_lock) ===
  'age: 22-year-old adult Indian man; gender: male; build: medium build; skin: medium brown skin; face: oval face, clean-shaven; hair: short black hair; facial_hair: none; marks: none');
check('outfit formatting emits exact clothing slots',
  W.formatOutfit(ARJUN.wardrobe.outfits.nightwear) ===
  'top: steel grey cotton t-shirt; bottom: navy blue pyjama trousers; outerwear: none; footwear: barefoot; accessories: none; notes: loose comfortable fit');

// 2. Deterministic outfit resolution, including intentional scene changes.
const def = W.resolveOutfit(ARJUN, SCENE, 'strict');
check('default outfit resolves deterministically', def.ok && def.outfitId === 'nightwear' && def.outfit.top === 'steel grey cotton t-shirt');
const override = W.resolveOutfit(ARJUN, { ...SCENE, outfit_ids: { [ARJUN.tag]: 'rain_coat' } }, 'strict');
check('scene outfit_ids selects the exact canonical outfit', override.ok && override.source === 'scene' && override.outfit.top === 'dark green rain jacket');
const unknown = W.resolveOutfit(ARJUN, { ...SCENE, outfit_ids: { [ARJUN.tag]: 'missing_outfit' } }, 'strict');
check('unknown outfit id fails closed', !unknown.ok && unknown.code === 'WARDROBE_OUTFIT_UNKNOWN');
const noWardrobe = W.resolveOutfit({ tag: ARJUN.tag, name: 'Arjun' }, SCENE, 'strict');
check('missing wardrobe fails closed', !noWardrobe.ok && noWardrobe.code === 'WARDROBE_MISSING');

// 3. Lock block: exact identity + wardrobe, no reference-sheet leakage.
const lock = W.buildCharacterLockBlock(ARJUN, SCENE, 'strict');
check('lock block builds', lock.ok);
check('lock block carries exact clothing', lock.ok && lock.block.includes('top: steel grey cotton t-shirt'));
check('lock block carries explicit physical identity', lock.ok && lock.block.includes('hair: short black hair'));
check('lock block carries no reference-sheet pose', lock.ok && !/neutral\s+3\s*\/\s*4/i.test(lock.block));
check('lock block carries no tags', lock.ok && !/#BGD|@CHAR/.test(lock.block));

// 4. Reference-sheet language detection/sanitization.
check('reference-sheet pose is detected', W.findReferenceSheetPhrases(ARJUN.look_summary).length > 0);
const cleaned = W.sanitizeSceneFacingText(ARJUN.look_summary);
check('reference-sheet pose is removed', !/neutral\s+3\s*\/\s*4/i.test(cleaned));
check('reference-sheet sanitization preserves identity', cleaned.includes('22-year-old Indian man') && cleaned.includes('casual nightwear'));
check('reference-sheet sanitization is deterministic', cleaned === W.sanitizeSceneFacingText(ARJUN.look_summary));

// 5. Whole-project validation and contradiction checks.
const validProject = {
  wardrobe_schema_version: 1,
  characters: CHARACTERS,
  scenes: [SCENE, { ...SCENE, scene_number: 2, character_tags: [YOUNG_ARJUN.tag], visual_action: 'Young Arjun plays near the door.' }],
};
const valid = W.validateWardrobe(validProject);
check('valid strict project passes', valid.ok, valid.issues);
const red = { ...SCENE, visual_action: 'Arjun is wearing a red shirt.' };
const redResult = W.validateWardrobe({ ...validProject, scenes: [red] });
check('contradictory scene prose fails closed', !redResult.ok && redResult.issues.some((i: any) => i.code === 'WARDROBE_CONTRADICTION'), redResult.issues);
const redEyes = { ...SCENE, visual_action: "Arjun's eyes glow red in the dark." };
const redEyesResult = W.validateWardrobe({ ...validProject, scenes: [redEyes] });
check('non-wardrobe colour prose does not fail as an outfit contradiction', redEyesResult.ok, redEyesResult.issues);
const child = { ...SCENE, visual_action: 'Arjun is a small child.' };
const childResult = W.validateWardrobe({ ...validProject, scenes: [child] });
check('adult character portrayed as a child fails closed', !childResult.ok && childResult.issues.some((i: any) => i.code === 'IDENTITY_VARIANT_CONTRADICTION'), childResult.issues);
const otherChild = { ...SCENE, visual_action: 'Arjun tells the child a story and is scared of the dark.' };
const otherChildResult = W.validateWardrobe({ ...validProject, scenes: [otherChild] });
check('a different child in the scene does not flag the adult as a child variant', otherChildResult.ok, otherChildResult.issues);
const childVariant = { ...SCENE, scene_number: 2, character_tags: [YOUNG_ARJUN.tag], visual_action: 'Young Arjun is a small child at the door.' };
const childVariantResult = W.validateWardrobe({ ...validProject, scenes: [childVariant] });
check('separate child variant tag is accepted with its own appearance/wardrobe', childVariantResult.ok, childVariantResult.issues);
const missingWardrobeProject = { ...validProject, characters: [ARJUN, { tag: '@CHAR-02-MAA', name: 'Maa', appearance_lock: ARJUN.appearance_lock }] };
const missingResult = W.validateWardrobe(missingWardrobeProject);
check('missing strict wardrobe fails validation', !missingResult.ok && missingResult.issues.some((i: any) => i.code === 'WARDROBE_MISSING'), missingResult.issues);
const unknownProject = { ...validProject, scenes: [{ ...SCENE, outfit_ids: { [ARJUN.tag]: 'missing_outfit' } }] };
const unknownResult = W.validateWardrobe(unknownProject);
check('unknown scene outfit fails validation', !unknownResult.ok && unknownResult.issues.some((i: any) => i.code === 'WARDROBE_OUTFIT_UNKNOWN'), unknownResult.issues);

// 6. Hardening: strict uses appearance only and fails closed on missing data.
const hardened = H.hardenFlowPrompt({ prompt: PROMPT, backgrounds: [BG], characters: CHARACTERS, wardrobeMode: 'strict' });
check('strict hardening succeeds', hardened.ok);
check('strict hardening resolves the character identity', hardened.ok && hardened.hardenedPrompt.includes('22-year-old adult Indian man'));
check('strict hardening does not inline wardrobe', hardened.ok && !hardened.hardenedPrompt.includes('steel grey cotton t-shirt'));
check('strict hardening removes reference-sheet pose', hardened.ok && !/neutral\s+3\s*\/\s*4/i.test(hardened.hardenedPrompt));
const missingAppearance = H.hardenFlowPrompt({
  prompt: PROMPT, backgrounds: [BG], wardrobeMode: 'strict',
  characters: [{ tag: ARJUN.tag, name: 'Arjun', wardrobe: ARJUN.wardrobe }],
});
check('strict hardening fails on missing appearance_lock', !missingAppearance.ok && missingAppearance.code === 'APPEARANCE_MISSING', missingAppearance);
const missingWardrobe = H.hardenFlowPrompt({
  prompt: PROMPT, backgrounds: [BG], wardrobeMode: 'strict',
  characters: [{ tag: ARJUN.tag, name: 'Arjun', appearance_lock: ARJUN.appearance_lock }],
});
check('strict hardening fails on missing wardrobe', !missingWardrobe.ok && missingWardrobe.code === 'WARDROBE_MISSING', missingWardrobe);

// 7. Scene builder: authoritative lock + continuity, no leakage, override support.
const built = WF.buildFlowScenePrompt({ prompt: PROMPT, backgrounds: [BG], characters: CHARACTERS, scene: SCENE, wardrobeMode: 'strict' });
check('strict scene builder succeeds', built.ok, built.ok ? undefined : built.reason);
check('scene builder appends the character lock header', built.ok && built.prompt.includes(W.CHARACTER_LOCKS_HEADER));
check('scene builder carries exact clothing', built.ok && built.prompt.includes('top: steel grey cotton t-shirt'));
check('scene builder appends wardrobe continuity restraints', built.ok && built.prompt.includes(W.WARDROBE_CONTINUITY_RESTRAINTS));
check('scene builder removes reference-sheet pose', built.ok && !/neutral\s+3\s*\/\s*4/i.test(built.prompt));
check('scene builder leaves no raw machine identifiers', built.ok && !/#BGD|@CHAR/.test(built.prompt));
const builtOverride = WF.buildFlowScenePrompt({
  prompt: PROMPT, backgrounds: [BG], characters: CHARACTERS,
  scene: { ...SCENE, outfit_ids: { [ARJUN.tag]: 'rain_coat' } }, wardrobeMode: 'strict',
});
check('scene builder honors an explicit outfit override', builtOverride.ok && builtOverride.prompt.includes('dark green rain jacket'));
const builtUnknown = WF.buildFlowScenePrompt({
  prompt: PROMPT, backgrounds: [BG], characters: CHARACTERS,
  scene: { ...SCENE, outfit_ids: { [ARJUN.tag]: 'missing_outfit' } }, wardrobeMode: 'strict',
});
check('scene builder fails on an unknown outfit', !builtUnknown.ok && builtUnknown.reason.includes('WARDROBE_OUTFIT_UNKNOWN'), builtUnknown);
const builtRed = WF.buildFlowScenePrompt({
  prompt: PROMPT, backgrounds: [BG], characters: CHARACTERS,
  scene: { ...SCENE, visual_action: 'Arjun is wearing a red shirt.' }, wardrobeMode: 'strict',
});
check('scene builder fails on contradictory prose', !builtRed.ok && builtRed.reason.includes('WARDROBE_CONTRADICTION'), builtRed);

// 8. Speaker-aware first-clip prompt selection.
const narrator = FCL.selectFirstClipScenePrompt({ speaker: 'NARRATOR', animation_prompt_NARRATOR_ONLY: 'N', animation_prompt_WITH_lipsync: 'L' });
check('narrator selects NARRATOR_ONLY', narrator.ok && narrator.field === 'animation_prompt_NARRATOR_ONLY' && narrator.prompt === 'N');
const speaker = FCL.selectFirstClipScenePrompt({ speaker: ARJUN.tag, animation_prompt_NARRATOR_ONLY: 'N', animation_prompt_WITH_lipsync: 'L' });
check('character speaker selects WITH_lipsync', speaker.ok && speaker.field === 'animation_prompt_WITH_lipsync' && speaker.prompt === 'L');
const missingVariant = FCL.selectFirstClipScenePrompt({ speaker: ARJUN.tag, animation_prompt_NARRATOR_ONLY: 'N' });
check('explicit character speaker never falls back to narrator', !missingVariant.ok);
const legacyNoSpeaker = FCL.selectFirstClipScenePrompt({ animation_prompt_NARRATOR_ONLY: 'N' });
check('speaker-less legacy scene keeps the narrator prompt', legacyNoSpeaker.ok && legacyNoSpeaker.field === 'animation_prompt_NARRATOR_ONLY');

// 9. Legacy behavior remains byte-compatible for the inline resolver.
const legacy = H.hardenFlowPrompt({
  prompt: PROMPT,
  backgrounds: [BG],
  characters: [{ tag: ARJUN.tag, name: 'Arjun', look_summary: ARJUN.look_summary }],
});
check('legacy hardening preserves the exact look_summary inline', legacy.ok && legacy.hardenedPrompt.includes(ARJUN.look_summary));

console.log(`\nCHARACTER WARDROBE TESTS PASSED (${passed} checks)`);
