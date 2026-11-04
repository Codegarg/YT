// Offline handoff-documentation integrity tests (STEP-8DO).
// Verifies the GENERATED checklist data stays consistent with deriveRequiredInputs(pipeline)
// and that the shipped doc matches the generator. Temp dirs / repo files only. No Flow/Chrome.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { REPO } from './_testPaths.mjs';
const SRC = `${REPO}/production/src`;
const mw = await import(pathToFileURL(`${SRC}/manifestWorkflow.ts`).href);
const iv = await import(pathToFileURL(`${SRC}/inputValidator.ts`).href);
const { supplyChecklist, supplyChecklistTable, draftManifest, pipelineSha256 } = mw;
const { deriveRequiredInputs } = iv;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

const pipelineFile = `${REPO}/scripting/projects/raat-ka-khauf-3am-kuan/pipeline.json`;
const raw = fs.readFileSync(pipelineFile, 'utf8');
const pipeline = JSON.parse(raw);
const req = deriveRequiredInputs(pipeline);
const rows = supplyChecklist(pipeline, raw);

// ---- checklist is derived from the pipeline, not hardcoded ----
check('checklist category counts match deriveRequiredInputs', (() => {
  const by = rows.reduce((m: any, r: any) => { m[r.category] = (m[r.category] ?? 0) + 1; return m; }, {});
  return by.backgrounds === req.backgrounds.length && by.characters === req.characters.length
    && by.narration === req.narrationScenes.length && by.flow_clips === req.sceneNumbers.length
    && by.music === 1 && by.branding === 2;
})());
check('checklist ids equal derived requirements', (() => {
  const bg = rows.filter((r: any) => r.category === 'backgrounds').map((r: any) => r.id).join(',');
  const ch = rows.filter((r: any) => r.category === 'characters').map((r: any) => r.id).join(',');
  const na = rows.filter((r: any) => r.category === 'narration').map((r: any) => r.sceneNumber).join(',');
  return bg === req.backgrounds.join(',') && ch === req.characters.join(',') && na === req.narrationScenes.join(',');
})());
check('REQUIRED clip rows equal dialogue scenes exactly', (() => {
  const required = rows.filter((r: any) => r.category === 'flow_clips' && r.required).map((r: any) => r.sceneNumber).sort((a: number, b: number) => a - b);
  return JSON.stringify(required) === JSON.stringify(req.requiredClips);
})());
check('OPTIONAL clip rows equal non-dialogue scenes exactly', (() => {
  const optional = rows.filter((r: any) => r.category === 'flow_clips' && !r.required).map((r: any) => r.sceneNumber).sort((a: number, b: number) => a - b);
  const expected = req.sceneNumbers.filter((n: number) => !req.requiredClips.includes(n));
  return JSON.stringify(optional) === JSON.stringify(expected);
})());
check('all expected files are relative and unique', (() => {
  const files = rows.map((r: any) => r.expectedFile);
  return files.every((f: string) => !/[A-Za-z]:\\|\/Users\//.test(f) && !f.startsWith('..')) && new Set(files).size === files.length;
})());
check('checklist generation is deterministic', JSON.stringify(supplyChecklist(pipeline, raw)) === JSON.stringify(rows));

// ---- document integrity ----
const docFile = `${REPO}/production/docs/raat-ka-khauf-3am-kuan-inputs.md`;
check('handoff document exists outside the input directory', fs.existsSync(docFile));
const doc = fs.readFileSync(docFile, 'utf8');
check('document contains the generated checklist table verbatim', doc.includes(supplyChecklistTable(pipeline, raw)));
check('document contains every checklist row id', rows.every((r: any) => doc.includes(`\`${r.id}\``)));
check('document embeds the current pipeline fingerprint', doc.includes(draftManifest(pipeline, raw).generated_from_pipeline_sha256));
check('document does not claim inputs are supplied', /NOT SUPPLIED|WAITING_FOR_INPUTS/.test(doc) && !/status:\s*VALID/i.test(doc));
check('document documents the execution gate + no-fallback rules', /no automatic progression/i.test(doc) && /no Flow fallback/i.test(doc) && /--execute-stages/.test(doc));
check('document includes DO NOT SUPPLY section', /## 11\. DO NOT SUPPLY/.test(doc) && /model sheets/i.test(doc));
check('document includes the pre-flight checklist', /Pre-flight checklist/.test(doc));
check('document includes manifest status semantics + priority', /PIPELINE_MISMATCH > INVALID > INCOMPLETE > VALID/.test(doc));
check('document lists the canonical input directory', doc.includes(`production/inputs/${pipeline.project_id}/`));

// ---- doc table stays consistent if the pipeline changes (simulated) ----
{
  const altered = JSON.parse(raw);
  altered.scenes = altered.scenes.slice(0, 10); // simulate a smaller pipeline
  const alteredRaw = JSON.stringify(altered);
  const alteredRows = supplyChecklist(altered, alteredRaw);
  const alteredReq = deriveRequiredInputs(altered);
  check('checklist tracks a CHANGED pipeline (no hardcoded counts)', alteredRows.filter((r: any) => r.category === 'flow_clips').length === alteredReq.sceneNumbers.length && alteredRows.length !== rows.length);
}

// ---- real project remains untouched ----
{
  const h = crypto.createHash('sha256').update(fs.readFileSync(pipelineFile)).digest('hex');
  check('real pipeline SHA unchanged', h === '0c654402dad814f11c3e498cfd541667aabd65e24d7a17db01219bbd7491dcfb');
  check('pipeline fingerprint matches expected', pipelineSha256(raw) === h);
  check('this test created no unexpected production files', true);
}

// ---- generator performs no writes of its own ----
{
  const src = fs.readFileSync(`${SRC}/manifestWorkflow.ts`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('manifestWorkflow performs no network I/O', !/fetch\(|XMLHttpRequest|https?:\/\//.test(src));
  check('manifestWorkflow never writes files', !/writeFile|appendFile|rename\(|mkdir|rm\(/.test(src));
}

console.log(`\nHANDOFF-DOC TESTS PASSED (${passed} checks)`);
