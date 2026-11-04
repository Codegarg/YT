// Offline integration test: checkInputs() surfaces explicit Flow/local state (STEP-8GF).
// Uses an ISOLATED temp project; never touches the real project. No browser, no Flow.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO } from './_testPaths.mjs';
const SRC = `${REPO}/production/src`;
const { checkInputs } = await import(pathToFileURL(`${SRC}/checkInputs.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8gf-'));
const PID = 'synthetic-8gf';
const inputsRoot = path.join(tmp, 'inputs');
const root = path.join(inputsRoot, PID);
for (const c of ['backgrounds', 'characters', 'narration', 'flow-clips', 'music']) fs.mkdirSync(path.join(root, c), { recursive: true });
const pipeline: any = { project_id: PID, scenes: [
  { scene_number: 1, title: 'S1', background_tag: '#BGD-01', character_tags: [], speaker: 'NARRATOR', visual_action: '', camera: '', effects: '', narration_text: 'न' },
  { scene_number: 2, title: 'S2', background_tag: '#BGD-01', character_tags: [], speaker: 'NARRATOR', visual_action: '', camera: '', effects: '', narration_text: 'न' },
]};

// checkInputs with Flow facts: scene 1 committed+local missing; scene 2 flow unknown.
const flowSceneById = { 1: { flowSceneId: '7eb3ac95-3f15-47a9-8586-9e573d30c254', flowSceneUrl: null } };
const diag = await checkInputs({ pipeline, inputsRoot, projectId: PID, outputsDir: path.join(tmp, 'outputs', PID), ffprobePath: process.env.FFPROBE_PATH, flowSceneById } as any);

const s1 = diag.scenes.find((s: any) => s.sceneNumber === 1);
const s2 = diag.scenes.find((s: any) => s.sceneNumber === 2);
check('scene1 committed + no local -> flowLocal FLOW_COMMITTED_LOCAL_MISSING', s1?.flowLocal?.state === 'FLOW_COMMITTED_LOCAL_MISSING');
check('scene1 renderable=false', s1?.flowLocal?.renderable === false);
check('report lists scene1 in flowCommittedLocalMissing', (diag as any).flowCommittedLocalMissing.includes(1));
check('scene2 (no flow, no local) -> FLOW_NOT_COMMITTED', s2?.flowLocal?.state === 'FLOW_NOT_COMMITTED');
check('scene2 renderable=false', s2?.flowLocal?.renderable === false);
check('finalEditReady=false while a scene is flow-committed-local-missing', diag.finalEditReady === false);
check('no fake checkpoint created (outputs dir untouched)', !fs.existsSync(path.join(tmp, 'outputs', PID, 'flow-scenes')));
check('read-only: no write to input root beyond dirs we created', fs.readdirSync(root).sort().join(',') === 'backgrounds,characters,flow-clips,music,narration');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nCHECKINPUTS FLOW/LOCAL INTEGRATION TESTS PASSED (${passed} checks)`);
