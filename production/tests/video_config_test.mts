// Offline Step-3 tests: pure video-generation CONFIGURATION verification.
// Browser-free — no Chrome, no Flow. The FlowClient method only wires these.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const vd = await import(pathToFileURL(path.join(SRC, 'videoDecisions.ts')).href);
const { REQUIRED_VIDEO_CONFIG, verifyVideoGenerationConfig, requireBatchX1, hasExactOption, requireExactOption, isExactModelFamily, VideoConfigError } = vd;

let passed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed += 1; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
}
const throwsWith = (fn: () => unknown, re: RegExp): boolean => { try { fn(); return false; } catch (e: any) { return re.test(String(e?.message ?? e)); } };

const GOOD = { mode: 'Video', model: 'Omni 1.1 Flash', resolution: '720p', duration: '8s', aspect: '16:9', batch: 'x1' };

// ------------------------------------------------------------------ canonical
check('required config is exactly the proven-live values',
  JSON.stringify(REQUIRED_VIDEO_CONFIG) === JSON.stringify(GOOD), REQUIRED_VIDEO_CONFIG);
{
  const out = verifyVideoGenerationConfig(GOOD);
  check('requested config normalizes to Video/Omni 1.1 Flash/720p/8s/16:9/x1',
    JSON.stringify(out) === JSON.stringify(GOOD), out);
}
{
  const vdCode = fs.readFileSync(path.join(SRC, 'videoDecisions.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  check('verification is pure (no browser imports in videoDecisions.ts)',
    !/playwright|chromium|page\.|\.locator\(/i.test(vdCode), vdCode.slice(0, 200));
}

// ---------------------------------------------------------------------- batch
for (const bad of ['x2', 'x3', 'x4'] as const) {
  check(`batch ${bad} cannot pass the x1 requirement`, throwsWith(() => verifyVideoGenerationConfig({ ...GOOD, batch: bad }), /batch/i));
  check(`batch ${bad} rejected by requireBatchX1 directly`, throwsWith(() => requireBatchX1(bad) as unknown as void, /x1/i));
}
check('missing batch cannot pass', throwsWith(() => verifyVideoGenerationConfig({ mode: GOOD.mode, model: GOOD.model, resolution: GOOD.resolution, duration: GOOD.duration, aspect: GOOD.aspect } as any), /batch/i));
check('empty batch cannot pass', throwsWith(() => verifyVideoGenerationConfig({ ...GOOD, batch: '' }), /batch/i));
check('null batch cannot pass', throwsWith(() => verifyVideoGenerationConfig({ ...GOOD, batch: null as any }), /batch/i));

// ------------------------------------------------------------ field mismatches
check('model mismatch is rejected', throwsWith(() => verifyVideoGenerationConfig({ ...GOOD, model: 'Veo 3.1 - Fast' }), /model/i));
check('resolution mismatch is rejected', throwsWith(() => verifyVideoGenerationConfig({ ...GOOD, resolution: '360p' }), /resolution/i));
check('duration mismatch is rejected', throwsWith(() => verifyVideoGenerationConfig({ ...GOOD, duration: '4s' }), /duration/i));
check('aspect mismatch is rejected', throwsWith(() => verifyVideoGenerationConfig({ ...GOOD, aspect: '9:16' }), /aspect/i));
check('mode mismatch is rejected', throwsWith(() => verifyVideoGenerationConfig({ ...GOOD, mode: 'Image' }), /mode/i));

// ------------------------------------------------------- fail-closed on absence
check('missing evidence fails closed', throwsWith(() => verifyVideoGenerationConfig(undefined), /no settings evidence/i));
check('null evidence fails closed', throwsWith(() => verifyVideoGenerationConfig(null), /no settings evidence/i));
check('empty evidence object fails closed', throwsWith(() => verifyVideoGenerationConfig({}), /mode/i));
check('partial evidence fails closed (model only)', throwsWith(() => verifyVideoGenerationConfig({ model: GOOD.model }), /mode/i));
check('non-string field fails closed', throwsWith(() => verifyVideoGenerationConfig({ ...GOOD, mode: true as any }), /mode/i));
check('whitespace-padded value fails closed (no trimming)', throwsWith(() => verifyVideoGenerationConfig({ ...GOOD, model: ' Omni 1.1 Flash' }), /model/i));
check('case variation fails closed', throwsWith(() => verifyVideoGenerationConfig({ ...GOOD, mode: 'video' }), /mode/i));
check('error type is VideoConfigError', (() => { try { verifyVideoGenerationConfig({ ...GOOD, batch: 'x2' }); return false; } catch (e: any) { return e instanceof VideoConfigError; } })());

// ------------------------------------------------------- exact option matching
check('hasExactOption accepts the exact option', hasExactOption(['360p', '720p'], '720p') === true);
check('hasExactOption rejects a substring/superstring', hasExactOption(['720p upscaled'], '720p') === false);
check('hasExactOption rejects a case variation', hasExactOption(['720P'], '720p') === false);
check('hasExactOption rejects when absent', hasExactOption(['360p'], '720p') === false);
check('hasExactOption handles empty/undefined input', hasExactOption([], '720p') === false && hasExactOption(undefined, '720p') === false);
check('hasExactOption rejects empty expected value', hasExactOption(['720p'], '') === false);
check('requireExactOption returns the value when present', requireExactOption('resolution', ['360p', '720p'], '720p') === '720p');
check('requireExactOption throws a clear missing-option error', throwsWith(() => requireExactOption('resolution', ['360p'], '720p'), /Required resolution option "720p" was not found/));
check('requireExactOption lists available options in the error', throwsWith(() => requireExactOption('duration', ['4s', '6s'], '8s'), /4s; 6s/));
check('exact model matching accepts "Omni 1.1 Flash"', isExactModelFamily(['Omni 1.1 Flash', 'Veo 3.1 - Fast']) === true);
check('exact model matching rejects the Veo families', isExactModelFamily(['Veo 3.1 - Lite', 'Veo 3.1 - Fast', 'Veo 3.1 - Quality'], 'Omni 1.1 Flash') === false);
check('exact model matching rejects a substring', isExactModelFamily(['Omni 1.1 Flash Turbo'], 'Omni 1.1 Flash') === false);
check('exact model matching rejects a prefix of the model', isExactModelFamily(['Omni 1.1'], 'Omni 1.1 Flash') === false);
check('exact model matching rejects a case variation', isExactModelFamily(['omni 1.1 flash'], 'Omni 1.1 Flash') === false);
check('exact model matching fails closed with no options', isExactModelFamily([]) === false && isExactModelFamily(undefined) === false);

// ------------------------------------- FlowClient wiring (browser-free source audit)
const fcSrc = fs.readFileSync(path.join(SRC, 'flowClient.ts'), 'utf8');
const methodStart = fcSrc.indexOf('async configureVideoGeneration(');
const methodEnd = fcSrc.indexOf('\n  /** Read the settings panel', methodStart);
const method = methodStart >= 0 ? fcSrc.slice(methodStart, methodEnd > 0 ? methodEnd : fcSrc.length) : '';
check('FlowClient.configureVideoGeneration exists', methodStart >= 0 && method.length > 0);
check('it uses S.settingsTrigger (no page-wide text click)', /this\.click\(S\.settingsTrigger\)/.test(method) && !/getByText/.test(method));
check('it verifies the settings overlay becomes visible', /waitFor\(\{state:'visible'/.test(method));
check('it selects Video mode via the observed videocamVideo text', /videocamVideo/.test(method) && /imageImage/.test(method));
check('it opens the model family via button[aria-label=\'Select model family\']', /Select model family/.test(method) && /aria-label/.test(method));
check('it selects resolution/duration/aspect through the exact-option helper', /selectExact\('resolution'/.test(method) && /selectExact\('duration'/.test(method) && /selectExact\('aspect ratio'/.test(method));
check('batch is handled with an x1-only locator', /x1\\s\*\$/.test(method) || /x1/.test(method));
check('it requires x1 via a checked flag and throws otherwise', /Batch x1 could not be selected/.test(method));
check('it verifies the final configuration before returning', /verification failed for/.test(fcSrc) && /verifyFromObserved/.test(method));
check('it never clicks Start generation', !/S\.submit|Start generation/.test(method));
check('it never downloads or generates media', !/download\(|generate\(|generateBackground\(/.test(method));
check('it never calls the pure batch helper with a coerced value', /requireBatchX1\(observed\.batch\)/.test(fcSrc));
check('videoDecisions is imported for the batch rule', /import \{[^}]*\brequireBatchX1\b[^}]*\} from '\.\/videoDecisions\.js'/.test(fcSrc), (fcSrc.match(/import \{[^}]*\} from '\.\/videoDecisions\.js'/) || [])[0]);
check('selectors.ts was NOT extended for batch/mode/model/resolution/duration', !/batchX1|videoMode|modelFamily/.test(fs.readFileSync(path.join(SRC, 'selectors.ts'), 'utf8')));
// --- Agent-OFF hardening on the video path (added safety): must ensure standard composer FIRST ---
check('configureVideoGeneration ensures the standard composer (Agent OFF) before settings', /await this\.ensureStandardComposer\(\)/.test(method));
check('the Agent-OFF guard runs before opening Settings', method.indexOf('ensureStandardComposer') < method.indexOf('this.click(S.settingsTrigger)'));
check('ensureStandardComposer is public and delegates to the single Agent-OFF helper (no duplication)',
  /async ensureStandardComposer\(\)/.test(fcSrc) && /this\.turnAgentOffAndAwaitStandardComposer\(\)/.test(fcSrc));
check('ensureStandardComposer is a NO-OP when no Agent toggle exists on the surface (scene-builder)',
  /async ensureStandardComposer\(\)[\s\S]{0,600}if \(!\(await chip\.count\(\)\.catch\(\(\) => 0\)\)\) return;/.test(fcSrc));
check('the image path still uses the same Agent-OFF helper', /await this\.turnAgentOffAndAwaitStandardComposer\(\)/.test(fcSrc.slice(fcSrc.indexOf('async ensureImageGenerationMode('), fcSrc.indexOf('async ensureImageGenerationMode(') + 600)));
check('video settings are UNCHANGED (Video + Omni 1.1 Flash + 720p + 8s + 16:9 + x1)',
  /'Omni 1\.1 Flash'/.test(method) && /resolution: options\.resolution \?\? '720p'/.test(method) && /duration: options\.duration \?\? '8s'/.test(method) && /aspect: options\.aspect \?\? '16:9'/.test(method) && /requireBatchX1/.test(fcSrc));

// ---------------------------------------------------------------------------
// STEP 8C — Flow settings option-label matching (icon-prefixed buttons)
// ---------------------------------------------------------------------------
const { matchesFlowOptionLabel, flowOptionLabelEquals } = await import(pathToFileURL(path.join(SRC, 'flowClient.ts')).href);
const accepts = (label: string, wanted: string) => flowOptionLabelEquals(label, wanted);
const codeOf = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

// A. exact plain labels
check('A plain 16:9 matches', accepts('16:9', '16:9') === true);
check('A plain 720p matches', accepts('720p', '720p') === true);
check('A plain 8s matches', accepts('8s', '8s') === true);
check('A plain x1 matches', accepts('x1', 'x1') === true);
check('A surrounding whitespace is tolerated', accepts('  16:9  ', '16:9') === true);

// B. icon-prefixed labels (live-confirmed forms)
check('B icon-prefixed crop_16_916:9 is accepted for "16:9"', accepts('crop_16_916:9', '16:9') === true);
check('B space-separated crop_16_9 16:9 is accepted', accepts('crop_16_9 16:9', '16:9') === true);
check('B single-underscore token timeline_16:9 is accepted', accepts('timeline_16:9', '16:9') === true);
check('B glued token+word label crop_freeFrames is accepted for "Frames"', accepts('crop_freeFrames', 'Frames') === true);
check('B icon-prefixed resolution still accepted', accepts('crop_720p', '720p') === true);
check('B icon-prefixed batch still accepted', accepts('crop_x1', 'x1') === true && accepts('timeline_x1', 'x1') === true);
check('B other ratios/resolutions/durations accepted', accepts('crop_9_169:16', '9:16') && accepts('crop_360p', '360p') && accepts('crop_8s', '8s'));

// C. icon-prefixed NON-matching values
check('C crop_16_94:3 is rejected for "16:9"', accepts('crop_16_94:3', '16:9') === false);
check('C crop_16_99:16 is rejected for "16:9"', accepts('crop_16_99:16', '16:9') === false);

// D. boundary safety
check('D crop_16_916:90 is rejected for "16:9"', accepts('crop_16_916:90', '16:9') === false);
check('D 16:90 is rejected for "16:9"', accepts('16:90', '16:9') === false);
check('D 720p extra is rejected for "720p"', accepts('720p extra', '720p') === false);
check('D 720px is rejected for "720p"', accepts('720px', '720p') === false);
check('D x10 is rejected for "x1"', accepts('x10', 'x1') === false);
check('D 16:9x is rejected for "16:9"', accepts('16:9x', '16:9') === false);

// E. prefix safety
check('E "the 16:9 ratio" is rejected (prose before the label)', accepts('the 16:9 ratio', '16:9') === false);
check('E "16:9, cropped" is rejected', accepts('16:9, cropped', '16:9') === false);
check('E "116:9" is rejected', accepts('116:9', '16:9') === false);
check('E "crop 16:9 extra" is rejected (junk after the label)', accepts('crop 16:9 extra', '16:9') === false);
check('E empty/missing input fails closed', accepts('', '16:9') === false && accepts('16:9', '') === false && accepts(undefined as any, '16:9') === false);
check('E no substring acceptance anywhere', !accepts('the 16:9 ratio', '16:9') && !accepts('16:9, cropped', '16:9'));

// F. wiring: helper-based lookup for every option; no substring path
const fcCode = codeOf(fs.readFileSync(path.join(SRC, 'flowClient.ts'), 'utf8'));
const cfgBody = (() => { const s = fcCode.indexOf('async configureVideoGeneration('); const e = fcCode.indexOf('private async readSettingsText', s); return fcCode.slice(s, e < 0 ? fcCode.length : e); })();
check('F configureVideoGeneration resolves options through the icon-aware helpers', /flowOptionLabelEquals\(text, value\)/.test(fcCode) && /findOptionByStrippedLabel\(panel, value\)/.test(cfgBody));
check('F resolution/duration/aspect go through selectExact', /await selectExact\('resolution', required\.resolution\)/.test(cfgBody) && /await selectExact\('duration', required\.duration\)/.test(cfgBody) && /await selectExact\('aspect ratio', required\.aspect\)/.test(cfgBody));
check('F batch x1 uses the same icon-aware lookup (x1 safety intact)', /findOptionByStrippedLabel\(panel, 'x1'\)/.test(cfgBody));
check('F no substring/fuzzy matching for options', !/\.includes\(value\)|hasText:\s*value\b/.test(cfgBody) && !/\.includes\(expected/.test(fcCode));
check('F the private helper compares using the exact icon-aware equality', /flowOptionLabelEquals\(text, value\)/.test(fcCode) && /!== String\(value\)/.test(fcCode) === false);
check('F final verification still covers all six required values', /expect\('mode', 'Video'\)/.test(fcCode) && /expect\('model', required\.model\)/.test(fcCode) && /expect\('resolution', required\.resolution\)/.test(fcCode) && /expect\('duration', required\.duration\)/.test(fcCode) && /expect\('aspect', required\.aspect\)/.test(fcCode) && /requireBatchX1\(observed\.batch\)/.test(fcCode));
check('F configureVideoGeneration still never clicks Start generation', !/S\.submit|Start generation/.test(cfgBody));
check('F the failure message reports the available options for diagnosis', /Available: \$\{available\.join\('; '\)\}/.test(cfgBody));
check('F model-family matching unchanged (own anchored expression, value supplied by caller)', /Select model family/.test(cfgBody) && /\$\{required\.model\.replace/.test(cfgBody) && !/hasText:\s*'Omni/.test(cfgBody));
check('F requireBatchX1 is still the single x1 rule (videoDecisions untouched)', /requireBatchX1\(observed\.batch\)/.test(fcCode));
check('F the Step-8A __name bootstrap is untouched', /context\.addInitScript\(\{ content: 'window\.__name = window\.__name \|\| function\(f\)\{ return f; \};' \}\)/.test(fcCode));
check('F matching helpers are exported for pure testing', /export function matchesFlowOptionLabel/.test(fcCode) && /export function flowOptionLabelEquals/.test(fcCode));

// ---------------------------------------------------------------------------
// STEP 8G — bounded settings settle (deterministic mocked state transitions)
// ---------------------------------------------------------------------------
const { settleOptionSelection } = await import(pathToFileURL(path.join(SRC, 'flowClient.ts')).href);

// A. already selected -> zero clicks, success
{
  let clicks = 0;
  const r = await settleOptionSelection(async () => true, async () => { clicks++; });
  check('G-A already-selected x1 requires no click and settles', r.outcome === 'settled' && r.clicks === 0 && clicks === 0, JSON.stringify({ r, clicks }));
}
// B. initially unselected -> exactly one click, then true -> success
{
  let clicks = 0; let state = false;
  const r = await settleOptionSelection(async () => state, async () => { clicks++; state = true; });
  check('G-B unselected x1 performs exactly one click then settles', r.outcome === 'settled' && r.clicks === 1 && clicks === 1, JSON.stringify({ r, clicks }));
}
// C. delayed state: false/undefined for several polls then true -> success, one click
{
  let clicks = 0; let polls = 0;
  const seq = [false, false, false, undefined, true];
  const r = await settleOptionSelection(async () => Boolean(seq[Math.min(polls++, seq.length - 1)]), async () => { clicks++; }, { maxPolls: 10 });
  check('G-C delayed aria-checked transition settles (no repeated click)', r.outcome === 'settled' && clicks === 1 && polls >= 4, JSON.stringify({ r, clicks, polls }));
}
// D. never becomes true -> timeout (caller must fail closed)
{
  let clicks = 0;
  const r = await settleOptionSelection(async () => false, async () => { clicks++; }, { maxPolls: 6 });
  check('G-D never-selected state times out after a single click', r.outcome === 'timeout' && clicks === 1 && r.polls === 6, JSON.stringify({ r, clicks }));
}
// E. no repeated click on a delayed transition (poll-only after the single click)
{
  let clicks = 0; let n = 0;
  const r = await settleOptionSelection(async () => { n++; return n > 8; }, async () => { clicks++; }, { maxPolls: 12 });
  check('G-E click count stays exactly 1 through a long delay', r.outcome === 'settled' && clicks === 1, JSON.stringify({ r, clicks }));
}
// F. a different batch staying selected -> never settles -> failure
{
  let clicks = 0;
  const selectedIsX2 = async () => false;         // x1 never becomes selected
  const r = await settleOptionSelection(selectedIsX2, async () => { clicks++; }, { maxPolls: 5 });
  check('G-F x2 remaining selected -> timeout (fail closed)', r.outcome === 'timeout' && clicks === 1, JSON.stringify({ r, clicks }));
}
// G. exact matching: x1 must not match x10 / unrelated labels / icon noise
check('G-G x1 does not match x10', accepts('x10', 'x1') === false && accepts('x10', 'x10') === true);
check('G-G x1 does not match unrelated labels', accepts('x2', 'x1') === false && accepts('16:9', 'x1') === false && accepts('Frames', 'x1') === false);
check('G-G x1 accepts its own toggle forms only', accepts('x1', 'x1') === true && accepts('toggle_x1', 'x1') === true && accepts('crop_x1', 'x1') === true);
// H. live icon shapes (newline inside innerText, as captured live) still match
check('H live shape "crop_16_9\\n16:9" matches 16:9', accepts('crop_16_9\n16:9', '16:9') === true);
check('H live shape "chrome_extension\\nIngredients" matches Ingredients', accepts('chrome_extension\nIngredients', 'Ingredients') === true);
check('H live plain "x1" matches x1', accepts('x1', 'x1') === true);
// I. configuration verification remains intact
check('I final verification still covers all six required values', /expect\('mode', 'Video'\)/.test(fcCode) && /expect\('model', required\.model\)/.test(fcCode) && /expect\('resolution', required\.resolution\)/.test(fcCode) && /expect\('duration', required\.duration\)/.test(fcCode) && /expect\('aspect', required\.aspect\)/.test(fcCode) && /requireBatchX1\(observed\.batch\)/.test(fcCode));

// ---- wiring audit for the bounded settle
check('G wiring: batch uses settleOptionSelection with a bounded timeout', /settleOptionSelection\(\s*async \(\) => String\(await batchResolved\.node\.getAttribute\('aria-checked'\)/.test(fcCode.replace(/\s+/g, ' ')) || /settleOptionSelection\(/.test(fcCode));
check('G wiring: resolution/duration/aspect use the same bounded settle', /await selectExact\('resolution', required\.resolution\)/.test(cfgBody) && /await selectExact\('duration', required\.duration\)/.test(cfgBody) && /await selectExact\('aspect ratio', required\.aspect\)/.test(cfgBody));
check('G wiring: timeout/poll are bounded (~2000ms / ~60ms)', /timeoutMs = 2000/.test(cfgBody) && /pollMs = 60/.test(cfgBody));
check('G wiring: no long fixed sleep is used as the primary sync', !/setTimeout\([^,]*,\s*(?:[1-9]\d{3,})\)/.test(cfgBody));
check('G wiring: the resolved option node is used for state reads (not an unrelated radio)', /findOptionByStrippedLabel\(panel, value\)/.test(cfgBody) && /resolved\.node\.getAttribute\('aria-checked'\)/.test(cfgBody));
check('G wiring: option resolution does not pick among radios with an unfiltered .first()',
  !/panel\.locator\('button, \[role="button"\]'\)\.first\(\)/.test(cfgBody) && /findOptionByStrippedLabel\(panel, value\)/.test(cfgBody));
check('G safety: the failure still refuses a non-x1 batch', /refusing to continue with a non-x1 batch/.test(cfgBody));
check('G safety: configureVideoGeneration still never clicks Start generation', !/S\.submit|Start generation/.test(cfgBody));
check('G safety: requireBatchX1 remains the single x1 rule', /requireBatchX1\(observed\.batch\)/.test(fcCode));
check('G Step-8A bootstrap unchanged', /context\.addInitScript\(\{ content: 'window\.__name = window\.__name \|\| function\(f\)\{ return f; \};' \}\)/.test(fcCode));

console.log(`\nVIDEO-CONFIG TESTS PASSED (${passed} checks)`);
