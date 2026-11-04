// Focused OFFLINE tests for universal Flow-generation eligibility.
//
// POLICY UNDER TEST: every scene type (NARRATOR_ONLY, DIALOGUE, MIXED, background-only) is eligible
// for Flow GENERATE once its non-Flow prerequisites are valid and it has no valid local clip. The
// narration kind is NOT part of the decision. A valid local clip skips generation; a committed Flow
// scene is RECOVER (download), never GENERATE; and an ALLOW_LOCAL scene is never sent to Flow.
// Pure function only: no Flow, Chrome, network, or credits.
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const SS = await import(pathToFileURL(`${SRC}/sceneState.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

/** A valid, Flow-eligible inspection baseline (STRICT: clip missing -> renderMode NONE). */
const base = {
  readiness: 'WAITING_FOR_VIDEO_CLIP',
  renderMode: 'NONE',
  background: { state: 'VALID' },
  characters: [{ state: 'VALID' }],
  narrationAsset: { state: 'VALID' },
  suppliedClip: { state: 'MISSING' },
  narration: 'DIALOGUE',
  flowLocal: { state: 'FLOW_NOT_COMMITTED' },
};
const bgOnly = { ...base, characters: [], narration: 'NARRATOR_ONLY' };

const verdict = (v: any) => `${v.eligible}|${v.action}`;

// ============ every scene type is eligible for GENERATE ============
console.log('--- universal eligibility ---');
check('NARRATOR_ONLY + no clip -> GENERATE', verdict(SS.classifyFlowEligibility({ ...base, narration: 'NARRATOR_ONLY' })) === 'true|GENERATE');
check('DIALOGUE + no clip -> GENERATE', verdict(SS.classifyFlowEligibility({ ...base, narration: 'DIALOGUE' })) === 'true|GENERATE');
check('MIXED + no clip -> GENERATE', verdict(SS.classifyFlowEligibility({ ...base, narration: 'MIXED' })) === 'true|GENERATE');
check('background-only + no clip -> GENERATE', verdict(SS.classifyFlowEligibility(bgOnly)) === 'true|GENERATE');
check('renderMode NONE (STRICT) is required for GENERATE', verdict(SS.classifyFlowEligibility({ ...base, renderMode: 'NONE' })) === 'true|GENERATE');
check('an unknown narration kind does NOT block GENERATE (kind is irrelevant)', verdict(SS.classifyFlowEligibility({ ...base, narration: 'SOMETHING_NEW' })) === 'true|GENERATE');

// ============ a valid local Flow clip skips generation ============
console.log('--- skip when already satisfied ---');
check('a valid local clip -> NONE (no Flow work, no regeneration)', verdict(SS.classifyFlowEligibility({ ...base, suppliedClip: { state: 'VALID' }, renderMode: 'SUPPLIED_VIDEO' })) === 'false|NONE');

// ============ committed -> RECOVER, never GENERATE ============
console.log('--- recovery vs generation ---');
check('committed in Flow + local clip missing -> RECOVER', verdict(SS.classifyFlowEligibility({ ...base, flowLocal: { state: 'FLOW_COMMITTED_LOCAL_MISSING' } })) === 'true|RECOVER');
check('committed is RECOVER for a NARRATOR_ONLY scene too', verdict(SS.classifyFlowEligibility({ ...bgOnly, flowLocal: { state: 'FLOW_COMMITTED_LOCAL_MISSING' } })) === 'true|RECOVER');
check('committed RECOVER never becomes GENERATE', SS.classifyFlowEligibility({ ...base, flowLocal: { state: 'FLOW_COMMITTED_LOCAL_MISSING' } }).action !== 'GENERATE');

// ============ invalid scenes are never eligible ============
console.log('--- fail closed ---');
check('missing background -> not eligible', SS.classifyFlowEligibility({ ...base, background: { state: 'MISSING' } }).eligible === false);
check('invalid background -> not eligible', SS.classifyFlowEligibility({ ...base, background: { state: 'INVALID' } }).eligible === false);
check('missing required character -> not eligible', SS.classifyFlowEligibility({ ...base, characters: [{ state: 'MISSING' }] }).eligible === false);
check('invalid required character -> not eligible', SS.classifyFlowEligibility({ ...base, characters: [{ state: 'INVALID' }] }).eligible === false);
check('INVALID scene -> not eligible', SS.classifyFlowEligibility({ ...base, readiness: 'INVALID' }).eligible === false);
check('INVALID narration -> not eligible', SS.classifyFlowEligibility({ ...base, narrationAsset: { state: 'INVALID' } }).eligible === false);
check('AMBIGUOUS narration -> not eligible', SS.classifyFlowEligibility({ ...base, narrationAsset: { state: 'AMBIGUOUS' } }).eligible === false);
check('INVALID supplied clip -> not eligible', SS.classifyFlowEligibility({ ...base, suppliedClip: { state: 'INVALID' } }).eligible === false);
check('malformed input -> not eligible', SS.classifyFlowEligibility(null).eligible === false && SS.classifyFlowEligibility({ ...base, suppliedClip: { state: 'WAT' } }).eligible === false);
check('missing narration that is not required is still eligible', verdict(SS.classifyFlowEligibility({ ...base, narrationAsset: { state: 'MISSING' } })) === 'true|GENERATE');

// ============ no local fallback: ALLOW_LOCAL scenes never go to Flow ============
console.log('--- no local fallback ---');
check('renderMode LOCAL_SYNTHESIS (ALLOW_LOCAL dev opt-in) -> NOT Flow-eligible', SS.classifyFlowEligibility({ ...base, renderMode: 'LOCAL_SYNTHESIS' }).eligible === false);
check('a background-only ALLOW_LOCAL scene is also not Flow-eligible', SS.classifyFlowEligibility({ ...bgOnly, renderMode: 'LOCAL_SYNTHESIS' }).eligible === false);
check('LOCAL_SYNTHESIS never yields GENERATE', SS.classifyFlowEligibility({ ...base, renderMode: 'LOCAL_SYNTHESIS' }).action === 'NONE');

// ============ determinism ============
console.log('--- determinism ---');
{
  const inputs = [
    { ...base, narration: 'NARRATOR_ONLY' }, { ...base, narration: 'DIALOGUE' },
    { ...base, narration: 'MIXED' }, bgOnly, { ...base, suppliedClip: { state: 'VALID' }, renderMode: 'SUPPLIED_VIDEO' },
  ];
  const once = inputs.map((i) => verdict(SS.classifyFlowEligibility(i)));
  const twice = inputs.map((i) => verdict(SS.classifyFlowEligibility(i)));
  check('repeated classification is byte-identical', JSON.stringify(once) === JSON.stringify(twice), { once, twice });
  check('all four scene types classify to GENERATE in one deterministic pass',
    once.slice(0, 4).every((v) => v === 'true|GENERATE'), once);
}

console.log(`\n${passed} Flow-generation eligibility checks passed (fully offline).`);
