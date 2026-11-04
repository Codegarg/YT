// Offline unit tests for downstream stage OUTPUT integrity (STEP-8FQ). No browser, no Flow.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { SRC } from './_testPaths.mjs';
const DS = await import(pathToFileURL(`${SRC}/downstreamStages.ts`).href);

let passed = 0;
function check(label: string, cond: boolean, detail?: unknown) { if (cond) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } }

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'stage-integrity-'));
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const stageFile = (stage: string) => path.join(tmp, DS.stageOutputName(stage));
const writeValid = async (stage: string, bytes = 'valid-mp4-bytes') => { await fsp.writeFile(stageFile(stage), Buffer.from(bytes)); return sha256(Buffer.from(bytes)); };
const rec = (stage: string, key: string, hash: string | null, outputPath?: string) => ({ EDIT: 'a', MIX: 'b', BED: 'c', TITLE: 'd' } as any)[stage] && { key, output_hash: hash ?? undefined, ...(outputPath ? { output_path: outputPath } : {}) };

// ------------------------------------------------------------------ validateRecordedStageOutput
for (const stage of ['EDIT', 'MIX', 'BED', 'TITLE']) {
  const hash = await writeValid(stage);
  const key = 'k-' + stage;
  const r = await DS.validateRecordedStageOutput(stage, tmp, { key, output_hash: hash });
  check(`${stage}: valid file + matching hash → ok`, r.ok === true && r.outputHash === hash);
}
// missing record / missing key
check('no record → fail closed', (await DS.validateRecordedStageOutput('EDIT', tmp, undefined)).ok === false);
check('record without key → fail closed', (await DS.validateRecordedStageOutput('EDIT', tmp, { output_hash: 'x' })).ok === false);
// missing hash
check('missing output_hash → fail closed', (await DS.validateRecordedStageOutput('EDIT', tmp, { key: 'k' })).ok === false);
// malformed hash
check('malformed output_hash → fail closed', (await DS.validateRecordedStageOutput('EDIT', tmp, { key: 'k', output_hash: 'not-hex' })).ok === false);
check('short hash → fail closed', (await DS.validateRecordedStageOutput('EDIT', tmp, { key: 'k', output_hash: 'abcd' })).ok === false);
// wrong but well-formed hash
{
  await writeValid('MIX');
  check('valid-but-wrong hash → fail closed', (await DS.validateRecordedStageOutput('MIX', tmp, { key: 'k', output_hash: 'a'.repeat(64) })).ok === false);
}
// deleted file
{
  const p = stageFile('BED'); await fsp.writeFile(p, Buffer.from('x')); const h = sha256(Buffer.from('x')); await fsp.rm(p);
  check('deleted output → fail closed', (await DS.validateRecordedStageOutput('BED', tmp, { key: 'k', output_hash: h })).ok === false);
}
// wrong explicit output_path
{
  const h = await writeValid('TITLE');
  check('mismatched recorded output_path → fail closed', (await DS.validateRecordedStageOutput('TITLE', tmp, { key: 'k', output_hash: h, output_path: 'other.mp4' })).ok === false);
}
// replaced by different bytes (new valid mp4) → hash mismatch
{
  const h1 = await writeValid('EDIT', 'original');
  await fsp.writeFile(stageFile('EDIT'), Buffer.from('replaced'));
  check('replaced output (different bytes) → fail closed', (await DS.validateRecordedStageOutput('EDIT', tmp, { key: 'k', output_hash: h1 })).ok === false);
}

// ------------------------------------------------------------------ validateRecordedStageOutputs (batch)
{
  const hE = await writeValid('EDIT'); const hM = await writeValid('MIX'); const hB = await writeValid('BED'); const hT = await writeValid('TITLE');
  const recorded = { EDIT: { key: 'kE', output_hash: hE }, MIX: { key: 'kM', output_hash: hM }, BED: { key: 'kB', output_hash: hB }, TITLE: { key: 'kT', output_hash: hT }, APPROVAL: undefined };
  const integ = await DS.validateRecordedStageOutputs(tmp, recorded);
  check('batch: all four stages ok', ['EDIT', 'MIX', 'BED', 'TITLE'].every((s) => integ[s]?.ok === true));
}

// ------------------------------------------------------------------ classifyStage integrity gating
{
  const inputs: any = { sceneOutputHashes: { '1': 'h1' }, narration: {}, editOutputHash: 'e', mixOutputHash: 'm', bedOutputHash: 'b', titleOutputHash: 't', bgmHash: 'g', introHash: 'i', logoHash: 'l', titleMetadata: {} };
  const g = Object.fromEntries(DS.buildStageGraph(inputs).map((n: any) => [n.stage, n.key]));
  const recAll: any = { EDIT: { key: g.EDIT }, MIX: { key: g.MIX }, BED: { key: g.BED }, TITLE: { key: g.TITLE }, APPROVAL: { key: g.APPROVAL } };
  // Without integrity: all CURRENT (legacy behavior preserved)
  check('no integrity map → legacy CURRENT preserved', DS.planDownstream(inputs, recAll, { approved: true }).states.TITLE === 'CURRENT');
  // With integrity all-ok: CURRENT
  const allOk: any = { EDIT: { ok: true }, MIX: { ok: true }, BED: { ok: true }, TITLE: { ok: true } };
  check('integrity all ok → TITLE CURRENT', DS.planDownstream(inputs, recAll, { approved: true, integrity: allOk }).states.TITLE === 'CURRENT');
  // Corrupt TITLE only
  const tBad: any = { ...allOk, TITLE: { ok: false, reason: 'x' } };
  const pT = DS.planDownstream(inputs, recAll, { approved: true, integrity: tBad });
  check('corrupt TITLE → TITLE not CURRENT', pT.states.TITLE !== 'CURRENT');
  check('corrupt TITLE → APPROVAL pulled, EDIT/MIX/BED stay CURRENT', pT.states.EDIT === 'CURRENT' && pT.states.MIX === 'CURRENT' && pT.states.BED === 'CURRENT' && pT.workSet.includes('TITLE'));
  // Corrupt BED → BED+TITLE+APPROVAL pulled, EDIT/MIX CURRENT
  const bBad: any = { ...allOk, BED: { ok: false } };
  const pB = DS.planDownstream(inputs, recAll, { approved: true, integrity: bBad });
  check('corrupt BED → BED/TITLE stale; EDIT/MIX CURRENT', pB.states.EDIT === 'CURRENT' && pB.states.MIX === 'CURRENT' && pB.states.BED !== 'CURRENT' && pB.states.TITLE !== 'CURRENT');
  // Corrupt MIX → MIX/BED/TITLE stale; EDIT CURRENT
  const mBad: any = { ...allOk, MIX: { ok: false } };
  const pM = DS.planDownstream(inputs, recAll, { approved: true, integrity: mBad });
  check('corrupt MIX → MIX/BED/TITLE stale; EDIT CURRENT', pM.states.EDIT === 'CURRENT' && pM.states.MIX !== 'CURRENT' && pM.states.BED !== 'CURRENT' && pM.states.TITLE !== 'CURRENT');
  // Corrupt EDIT → whole chain stale
  const eBad: any = { ...allOk, EDIT: { ok: false } };
  const pE = DS.planDownstream(inputs, recAll, { approved: true, integrity: eBad });
  check('corrupt EDIT → entire chain stale', ['EDIT', 'MIX', 'BED', 'TITLE', 'APPROVAL'].every((s) => pE.states[s] !== 'CURRENT'));
}

// ------------------------------------------------------------------ H: key matches but output missing → NOT CURRENT (via integrity)
{
  const inputs: any = { sceneOutputHashes: { '1': 'h1' }, narration: {}, editOutputHash: 'e', mixOutputHash: 'm', bedOutputHash: 'b', titleOutputHash: 't', bgmHash: 'g', introHash: 'i', logoHash: 'l', titleMetadata: {} };
  const g = Object.fromEntries(DS.buildStageGraph(inputs).map((n: any) => [n.stage, n.key]));
  const recAll: any = { EDIT: { key: g.EDIT, output_hash: 'a'.repeat(64) }, MIX: { key: g.MIX }, BED: { key: g.BED }, TITLE: { key: g.TITLE } };
  const integ = await DS.validateRecordedStageOutputs(tmp, recAll);
  check('key matches but recorded output_hash does not match file → EDIT gated', integ.EDIT?.ok === false);
}

await fsp.rm(tmp, { recursive: true, force: true });
console.log(`\nDOWNSTREAM INTEGRITY TESTS PASSED (${passed} checks)`);
