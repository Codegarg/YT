// Focused regression: the handoff/validator derivation MUST match the authoritative
// narration/Flow-video classification (16 narration, 7 Flow-video), incl. Scene 15 MIXED.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { SRC } from './_testPaths.mjs';
import { REPO as ROOT } from './_testPaths.mjs';
const { deriveRequiredInputs } = await import(pathToFileURL(`${SRC}/inputValidator.ts`).href);
const { draftManifest, supplyChecklist } = await import(pathToFileURL(`${SRC}/manifestWorkflow.ts`).href);
const { classifyNarration, requiresNarrationAudio } = await import(pathToFileURL(`${SRC}/sceneCompositionPlanner.ts`).href);

let passed = 0;
const check = (l: string, ok: boolean, d?: unknown) => { if (ok) { passed++; console.log('PASS ' + l); } else { console.log('FAIL ' + l, d ?? ''); throw new Error('FAIL ' + l); } };

const raw = fs.readFileSync(`${ROOT}/scripting/projects/youtube-automation-2-20261003160855-2740/pipeline.json`, 'utf8');
const pipeline = JSON.parse(raw);
const req = deriveRequiredInputs(pipeline);

const NARR = [1, 2, 3, 6, 7, 8, 9, 10, 13, 14, 15, 16, 20, 21, 22, 23];
const CLIPS = [4, 5, 11, 12, 17, 18, 19];

check('narrationScenes = 16 including scene 15', JSON.stringify(req.narrationScenes) === JSON.stringify(NARR), req.narrationScenes);
check('requiredClips = 7 dialogue scenes only (excludes scene 15)', JSON.stringify(req.requiredClips) === JSON.stringify(CLIPS), req.requiredClips);
check('narration and clips partition every scene exactly once', req.narrationScenes.length + req.requiredClips.length === pipeline.scenes.length && !req.narrationScenes.some((n: number) => req.requiredClips.includes(n)));

// the derivation agrees with the authoritative classifier for every scene
{
  let agree = true;
  for (const s of pipeline.scenes) {
    const narrReq = requiresNarrationAudio(s, classifyNarration(s));
    const isDialogue = classifyNarration(s) === 'DIALOGUE';
    if (narrReq !== req.narrationScenes.includes(Number(s.scene_number))) agree = false;
    if (isDialogue !== req.requiredClips.includes(Number(s.scene_number))) agree = false;
  }
  check('derivation matches classifyNarration/requiresNarrationAudio for all 23 scenes', agree);
}

// handoff draft includes narration-0015 and does NOT demand scene-0015 clip
const draft = draftManifest(pipeline, raw);
check('draft narration includes narration-0015', draft.assets.narration.some((a: any) => a.id === 'narration-0015'));
check('draft narration count = 16', draft.assets.narration.length === 16, draft.assets.narration.length);
check('draft flow_clips REQUIRED set = 7 dialogue scenes only', draft.assets.flow_clips.filter((a: any) => a.requirement === 'REQUIRED').map((a: any) => a.scene_number).join(',') === '4,5,11,12,17,18,19', draft.assets.flow_clips.filter((a: any) => a.requirement === 'REQUIRED').map((a: any) => a.scene_number));
check('draft scene-0015 clip is OPTIONAL (not REQUIRED)', draft.assets.flow_clips.find((a: any) => a.id === 'scene-0015')?.requirement === 'OPTIONAL');

// supply checklist mentions the narration category and the 16-set
{
  const rows = supplyChecklist(pipeline, raw);
  const narrRows = rows.filter((r: any) => r.category === 'narration');
  check('supplyChecklist lists 16 narration rows (incl. 0015)', narrRows.length === 16 && narrRows.some((r: any) => r.id === 'narration-0015'), narrRows.map((r: any) => r.id));
  const reqClipRows = rows.filter((r: any) => r.category === 'flow_clips' && r.required === true);
  check('supplyChecklist REQUIRED flow clips = 7 dialogue scenes', reqClipRows.map((r: any) => r.sceneNumber).join(',') === '4,5,11,12,17,18,19', reqClipRows.map((r: any) => r.sceneNumber));
}

console.log(`\nNARRATION-HANDOFF DERIVATION TESTS PASSED (${passed} checks)`);
