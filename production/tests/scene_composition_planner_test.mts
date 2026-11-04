// Offline scene-composition planner tests (STEP-8DA). Synthetic scenes only. No Flow/assets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const sp = await import(pathToFileURL(`${SRC}/sceneCompositionPlanner.ts`).href);
const { planScene, planPipeline, summarizePlans, classifyNarration, fallbackLayout, requiresNarrationAudio, FALLBACK_LAYOUT } = sp;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

const KNOWN = { backgrounds: ['#BGD-01-VILLAGE-STREET-WIDE', '#BGD-02-WELL-AREA-WIDE'], characters: ['@CHAR-01-ARJUN', '@CHAR-02-MOHAN', '@CHAR-03-GEETA', '@CHAR-04-BUZURG'] };
const base = (over: any = {}) => ({
  scene_number: 1, title: 'T', background_tag: '#BGD-01-VILLAGE-STREET-WIDE', character_tags: ['@CHAR-01-ARJUN'],
  speaker: 'NARRATOR', camera: 'Wide shot', effects: 'wind', visual_action: 'Arjun stands', narration_text: 'कहानी', devanagari_dialogue: '',
  timestamp: 'AUTO — determined by the completed Flow clip', clip_length_seconds: null, edit_length_seconds: null,
  animation_prompt_NARRATOR_ONLY: 'Narrator voiceover will be layered in editing.', animation_prompt_WITH_lipsync: 'x', status: 'pending', ...over,
});

// ---- 1/2/3. character counts + placements ----
{
  const z = planScene(base({ character_tags: [] }), KNOWN);
  check('zero-character scene: no placements, positionSource=none', z.placements.length === 0 && z.positionSource === 'none' && z.characters.length === 0);
  const one = planScene(base({ character_tags: ['@CHAR-01-ARJUN'] }), KNOWN);
  check('one-character scene: single centered fallback placement', one.placements.length === 1 && one.positionSource === 'deterministic-fallback' && one.placements[0].characterTag === '@CHAR-01-ARJUN');
  const two = planScene(base({ character_tags: ['@CHAR-01-ARJUN', '@CHAR-02-MOHAN'] }), KNOWN);
  check('two-character scene: deterministic left/right placement', two.placements.length === 2 && two.placements[0].x < two.placements[1].x);
}

// ---- 4/20. determinism ----
check('repeated layout is deterministic', JSON.stringify(planScene(base({ character_tags: ['@CHAR-01-ARJUN', '@CHAR-02-MOHAN'] }), KNOWN).placements) === JSON.stringify(planScene(base({ character_tags: ['@CHAR-01-ARJUN', '@CHAR-02-MOHAN'] }), KNOWN).placements));
check('fallbackLayout deterministic + 3/4/5+ bands', JSON.stringify(fallbackLayout(3, 1920, 1080)) === JSON.stringify(fallbackLayout(3, 1920, 1080)) && fallbackLayout(5, 1920, 1080).length === 5);

// ---- 5/6/7. background failures ----
check('missing background tag -> BACKGROUND_ASSET_TAG_MISSING', planScene(base({ background_tag: null }), KNOWN).background.state === 'BACKGROUND_ASSET_TAG_MISSING');
check('malformed background tag -> BACKGROUND_ASSET_TAG_INVALID', planScene(base({ background_tag: '#BGD 01 bad!' }), KNOWN).background.state === 'BACKGROUND_ASSET_TAG_INVALID');
check('unknown background tag -> BACKGROUND_ASSET_UNKNOWN', planScene(base({ background_tag: '#BGD-99-NOPE' }), KNOWN).background.state === 'BACKGROUND_ASSET_UNKNOWN');

// ---- 8/9/10/11. character failures ----
check('missing character tag -> CHARACTER_TAG_MISSING', planScene(base({ character_tags: [''] }), KNOWN).characters[0].assetState === 'CHARACTER_TAG_MISSING');
check('unknown character -> CHARACTER_TAG_UNKNOWN', planScene(base({ character_tags: ['@CHAR-99-GHOST'] }), KNOWN).characters[0].assetState === 'CHARACTER_TAG_UNKNOWN');
check('malformed character -> CHARACTER_TAG_INVALID', planScene(base({ character_tags: ['@CHAR bad!'] }), KNOWN).characters[0].assetState === 'CHARACTER_TAG_INVALID');
check('duplicate character -> CHARACTER_TAG_DUPLICATE', planScene(base({ character_tags: ['@CHAR-01-ARJUN', '@CHAR-01-ARJUN'] }), KNOWN).characters[1].assetState === 'CHARACTER_TAG_DUPLICATE');
check('planner never claims CHARACTER_ASSET_HIT (planning only)', planScene(base(), KNOWN).characters.every((c: any) => c.assetState !== 'CHARACTER_ASSET_HIT'));

// ---- 12/13. duration ----
check('unresolved duration -> null + durationSource=unresolved', (() => { const p = planScene(base(), KNOWN); return p.durationSeconds === null && p.durationSource === 'unresolved'; })());
check('numeric pipeline duration honored (flow-clip)', (() => { const p = planScene(base({ clip_length_seconds: 7.5 }), KNOWN); return p.durationSeconds === 7.5 && p.durationSource === 'flow-clip'; })());
check('edit_length_seconds honored as pipeline duration', (() => { const p = planScene(base({ edit_length_seconds: 4.25 }), KNOWN); return p.durationSeconds === 4.25 && p.durationSource === 'pipeline'; })());
check('zero/negative duration is NOT accepted', planScene(base({ clip_length_seconds: 0 }), KNOWN).durationSeconds === null && planScene(base({ clip_length_seconds: -3 }), KNOWN).durationSeconds === null);
check('no test fallback (5s) leaks into planning', planScene(base(), KNOWN).durationSeconds !== 5);

// ---- 14. motion ----
check('motion resolved from camera/visual_action (existing helper)', planScene(base({ camera: 'Slow push in closer to the well' }), KNOWN).motion === 'ZOOM_IN');
check('motion unresolved when no text -> MOTION_UNRESOLVED reason', (() => { const p = planScene(base({ camera: '', visual_action: '', effects: '' }), KNOWN); return p.motion === null && p.reasons.includes('MOTION_UNRESOLVED'); })());

// ---- 15/16/17. narration classification ----
check('narrator-only classified', classifyNarration(base({ speaker: 'NARRATOR', narration_text: 'x', devanagari_dialogue: '' })) === 'NARRATOR_ONLY');
check('dialogue classified', classifyNarration(base({ speaker: '@CHAR-01-ARJUN', narration_text: '', devanagari_dialogue: 'x' })) === 'DIALOGUE');
check('mixed classified (both narration + dialogue)', classifyNarration(base({ speaker: '@CHAR-01-ARJUN', narration_text: 'x', devanagari_dialogue: 'y' })) === 'MIXED');
check('silent classified', classifyNarration(base({ speaker: 'none', narration_text: '', devanagari_dialogue: '' })) === 'SILENT');
check('requiresNarrationAudio true for narrator-only', requiresNarrationAudio(base(), 'NARRATOR_ONLY') === true);

// ---- 18. multiple simultaneous reasons preserved ----
{
  const p = planScene(base({ character_tags: ['@CHAR-01-ARJUN'], clip_length_seconds: null }), KNOWN);
  check('multiple reasons preserved (character + duration)', p.reasons.includes('CHARACTER_ASSET_REQUIRED:@CHAR-01-ARJUN') && p.reasons.includes('DURATION_UNRESOLVED'));
  check('status precedence: requires-character-assets wins when both apply', p.status === 'REQUIRES_CHARACTER_ASSETS');
}
{
  const p = planScene(base({ character_tags: ['@CHAR-99-GHOST'], clip_length_seconds: null }), KNOWN);
  check('unknown character -> INVALID_SCENE while keeping duration reason too', p.status === 'INVALID_SCENE' && p.reasons.includes('DURATION_UNRESOLVED'));
}

// ---- statuses ----
check('zero-char + unresolved duration -> REQUIRES_DURATION', planScene(base({ character_tags: [] }), KNOWN).status === 'REQUIRES_DURATION');
check('invalid scene number -> INVALID_SCENE', planScene(base({ scene_number: 0 }), KNOWN).status === 'INVALID_SCENE');

// ---- 19. no mutation of input ----
{
  const scene = base({ character_tags: ['@CHAR-01-ARJUN', '@CHAR-02-MOHAN'] });
  const snapshot = JSON.stringify(scene);
  planScene(scene, KNOWN);
  check('input scene object is never mutated', JSON.stringify(scene) === snapshot);
}

// ---- batch planning ----
{
  const pipeline = { backgrounds: [{ tag: '#BGD-01-VILLAGE-STREET-WIDE' }], characters: [{ tag: '@CHAR-01-ARJUN' }], scenes: [base({ scene_number: 1 }), base({ scene_number: 2, character_tags: [] })] };
  const snap = JSON.stringify(pipeline);
  const plans = planPipeline(pipeline);
  check('planPipeline plans every scene in order', plans.length === 2 && plans[0].sceneNumber === 1 && plans[1].sceneNumber === 2);
  check('planPipeline never mutates the pipeline', JSON.stringify(pipeline) === snap);
  const s = summarizePlans(plans);
  check('summarizePlans counts statuses', s.total === 2 && s.requiresCharacterAssets === 1 && s.requiresDuration === 1);
}

// ---- no network / no writes ----
const srcText = fs.readFileSync(`${SRC}/sceneCompositionPlanner.ts`, 'utf8');
check('planner performs no network I/O', !/fetch\(|XMLHttpRequest|https?:\/\//.test(srcText));
check('planner never writes files', !/writeFile|createWriteStream|rename\(|mkdir/.test(srcText));
check('planner has no Flow/Chrome/playwright dependency', !/playwright|FlowClient|chrome/i.test(srcText));
check('planner reuses existing motion helper + placement type', /motionFromSceneText/.test(srcText) && /CharacterPlacement/.test(srcText));
check('fallback layout is documented as deterministic-fallback', /deterministic-fallback/.test(srcText));

console.log(`\nSCENE-COMPOSITION-PLANNER TESTS PASSED (${passed} checks)`);
