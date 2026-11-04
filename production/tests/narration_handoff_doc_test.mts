// Focused integrity test for the per-project narration handoff doc.
// Ensures the doc cannot drift from the authoritative handoff contract (deriveRequiredInputs via
// draftManifest). No media, no Flow, no Chrome, no OpenAI.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { REPO as ROOT } from './_testPaths.mjs';
const SRC = `${ROOT}/production/src`;
const ID = 'youtube-automation-2-20261003160855-2740';
const { draftManifest } = await import(pathToFileURL(`${SRC}/manifestWorkflow.ts`).href);

let passed = 0;
const check = (l: string, ok: boolean, d?: unknown) => { if (ok) { passed++; console.log('PASS ' + l); } else { console.log('FAIL ' + l, d ?? ''); throw new Error('FAIL ' + l); } };

const raw = fs.readFileSync(`${ROOT}/scripting/projects/${ID}/pipeline.json`, 'utf8');
const pipeline = JSON.parse(raw);
const d = draftManifest(pipeline, raw);
const docFile = `${ROOT}/production/docs/NARRATION_HANDOFF-${ID}.md`;
const doc = fs.readFileSync(docFile, 'utf8');

check('handoff doc exists', fs.existsSync(docFile));
check('doc names the authoritative input narration directory', doc.includes(`production/inputs/${ID}/narration/`));
check('doc warns AGAINST production/outputs narration path', /Do NOT use/.test(doc) && doc.includes('production/outputs/<project>/narration/'));

const narrIds = d.assets.narration.map((a: any) => a.id).sort();
check('doc lists all 16 narration ids', narrIds.length === 16 && narrIds.every((id: string) => doc.includes(`${id}.wav`)), narrIds.filter((id: string) => !doc.includes(`${id}.wav`)));
check('doc includes narration-0015 (MIXED scene 15)', doc.includes('narration-0015'));

const forbidden = ['narration-0004.*', 'narration-0005.*', 'narration-0011.*', 'narration-0012.*', 'narration-0017.*', 'narration-0018.*', 'narration-0019.*'];
check('doc lists all 7 forbidden narration scenes', forbidden.every((f) => doc.includes(f)), forbidden.filter((f) => !doc.includes(f)));

const requiredClips = d.assets.flow_clips.filter((a: any) => a.requirement === 'REQUIRED').map((a: any) => a.scene_number).sort((x: number, y: number) => x - y);
check('doc describes the 7 dialogue Flow scenes', requiredClips.length === 7 && doc.includes(requiredClips.join(', ')), requiredClips);

check('doc states Scene 15 is MIXED and narration-required', /MIXED/.test(doc) && /Scene 15/.test(doc) && /narration-0015/.test(doc));
check('doc states flow video OPTIONAL for scene 15', /OPTIONAL/.test(doc));
check('doc documents supported extensions', ['.wav', '.mp3', '.m4a', '.aac', '.ogg'].every((e) => doc.includes(e)));
check('doc documents ffprobe + no-fabrication validation', /ffprobe/.test(doc) && /never inferred from text/i.test(doc));
check('doc says narration not supplied / WAITING_FOR_INPUTS', /NOT supplied/.test(doc) && /WAITING_FOR_INPUTS/.test(doc));

// README no longer instructs supplying narration into the outputs path as the destination.
{
  const readme = fs.readFileSync(`${ROOT}/README.md`, 'utf8');
  check('README directs narration to production/inputs/<project-id>/narration/', /production\/inputs\/<project-id>\/narration\//.test(readme));
  check('README warns the outputs narration path is not consumed', /not consumed by input validation/.test(readme));
}

console.log(`\nNARRATION HANDOFF DOC TESTS PASSED (${passed} checks)`);
