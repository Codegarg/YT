// Offline regression tests for SCOPED Flow execution reachability.
// Proves a scoped, explicitly-authorised Flow run can reach the SceneExecutor, and that
// it still executes ONLY the selected scene. No Flow, no Chrome, no network, no credits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const PO = await import(pathToFileURL(`${SRC}/productionOrchestrator.ts`).href);
const { determineWorkSet } = PO;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

// A scene that BY DEFINITION cannot be READY: its supplied Flow clip is missing.
const scenes = [16, 17, 18, 19, 20, 21, 22, 23].map((n) => ({
  sceneNumber: n,
  outputState: n === 16 ? 'CURRENT' : 'STALE',
  inspection: { readiness: n === 16 ? 'READY' : 'WAITING_FOR_VIDEO_CLIP' },
}));

// ---- REGRESSION: the scoped Flow deadlock ----
// Before the fix, a scoped run passed flowExecutionEnabled=false, so flowEligibleScenes was
// undefined/empty, determineWorkSet returned [] and the SceneExecutor was never invoked.
const FLOW_ELIGIBLE = [20, 21, 22, 23];
const only20 = determineWorkSet(scenes as any, [20], FLOW_ELIGIBLE);
check('scoped Flow run reaches a work item (deadlock fixed)', only20.length === 1, JSON.stringify(only20));
check('and it is exactly the requested scene', only20[0] === 20);

// ---- scoped Flow never widens beyond the selection ----
for (const n of [16, 17, 18, 19, 21, 22, 23]) {
  check(`scene ${n} is NOT pulled in by flow eligibility`, !determineWorkSet(scenes as any, [20], FLOW_ELIGIBLE).includes(n));
}
check('a CURRENT scene is never re-executed', !determineWorkSet(scenes as any, [16], FLOW_ELIGIBLE).includes(16));

// ---- flow eligibility CANNOT bypass an explicit scope ----
check('scope wins even for a flow-eligible scene', JSON.stringify(determineWorkSet(scenes as any, [21], [])) === '[]');
check('an out-of-scope but flow-eligible scene is still excluded',
  JSON.stringify(determineWorkSet(scenes as any, [20], FLOW_ELIGIBLE)) === '[20]');

// ---- zero-credit default is unchanged (no session -> no flow eligibility) ----
check('without flow eligibility a non-READY scene yields no work', JSON.stringify(determineWorkSet(scenes as any, [20], undefined)) === '[]');
// A CURRENT scene is NEVER re-executed, flow-eligible or not (this is why scene 16 above is
// correctly absent: re-running a reconciled scene would waste credits).
check('a CURRENT scene is skipped even when in scope and READY', JSON.stringify(determineWorkSet(scenes as any, [16], undefined)) === '[]');
check('a CURRENT scene is skipped even when flow-eligible', JSON.stringify(determineWorkSet(scenes as any, [16], FLOW_ELIGIBLE)) === '[]');

// ---- source audit: the scope exemption that caused the deadlock is gone ----
const wfSrc = fs.readFileSync(path.join(SRC, 'projectWorkflow.ts'), 'utf8');
const wired = wfSrc.match(/flowExecutionEnabled:\s*([^,}]+)/);
check('projectWorkflow wires flowExecutionEnabled', !!wired, String(wired?.[1]));
check('REGRESSION: flowExecutionEnabled is NOT disabled for scoped runs',
  !!wired && !/scopedScenes/.test(wired[1]), String(wired?.[1]));
check('REGRESSION: it is still tied to an actually-opened session', !!wired && /useSession\s*===\s*true/.test(wired[1]));

console.log(`\nscoped Flow execution reachability: ${passed} checks passed`);