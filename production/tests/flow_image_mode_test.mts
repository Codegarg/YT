// Offline tests for the standard-composer image-mode adapter (browser-free).
// No Chrome, no Flow, no generation, no credits.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const FI = await import(pathToFileURL(path.join(SRC, 'flowImageMode.ts')).href);

let passed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed += 1; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
}

// ---------------------------------------------------------------- pure decisions
check('1 Agent ON -> TOGGLE_OFF', FI.decideAgentToggle({ present: true, ariaPressed: 'true' }).action === 'TOGGLE_OFF', FI.decideAgentToggle({ present: true, ariaPressed: 'true' }));
check('2 Agent OFF -> no toggle', FI.decideAgentToggle({ present: true, ariaPressed: 'false' }).action === 'NONE', FI.decideAgentToggle({ present: true, ariaPressed: 'false' }));
check('2b missing Agent toggle -> STANDARD_COMPOSER_UNAVAILABLE', FI.decideAgentToggle({ present: false, ariaPressed: null }).code === 'STANDARD_COMPOSER_UNAVAILABLE');

const modeOpts = (imageChecked: boolean) => [{ name: 'Image', checked: imageChecked }, { name: 'Video', checked: !imageChecked }];
const d3 = FI.decideRadioGroup({ present: true, options: modeOpts(true), desired: 'Image', controlLabel: 'Mode', unavailableCode: 'IMAGE_MODE_UNAVAILABLE' });
check('3 Image already selected -> ALREADY_SELECTED', d3.state === 'ALREADY_SELECTED', d3);
const d4 = FI.decideRadioGroup({ present: true, options: modeOpts(false), desired: 'Image', controlLabel: 'Mode', unavailableCode: 'IMAGE_MODE_UNAVAILABLE' });
check('4 Video selected -> SELECT_REQUIRED Image', d4.state === 'SELECT_REQUIRED' && d4.index === 0, d4);

const asp = (v: string) => [{ name: '16:9', checked: v === '16:9' }, { name: '4:3', checked: v === '4:3' }];
check('5 16:9 already selected -> ALREADY_SELECTED', FI.decideRadioGroup({ present: true, options: asp('16:9'), desired: '16:9', controlLabel: 'Aspect ratio', unavailableCode: 'ASPECT_RATIO_UNAVAILABLE' }).state === 'ALREADY_SELECTED');
const d6 = FI.decideRadioGroup({ present: true, options: asp('4:3'), desired: '16:9', controlLabel: 'Aspect ratio', unavailableCode: 'ASPECT_RATIO_UNAVAILABLE' });
check('6 non-16:9 -> SELECT_REQUIRED 16:9', d6.state === 'SELECT_REQUIRED' && d6.index === 0, d6);

const cnt = (v: string) => [{ name: 'x1', checked: v === 'x1' }, { name: 'x2', checked: v === 'x2' }];
check('7 x1 already selected -> ALREADY_SELECTED', FI.decideRadioGroup({ present: true, options: cnt('x1'), desired: 'x1', controlLabel: 'Output count', unavailableCode: 'OUTPUT_COUNT_UNAVAILABLE' }).state === 'ALREADY_SELECTED');
const d8 = FI.decideRadioGroup({ present: true, options: cnt('x2'), desired: 'x1', controlLabel: 'Output count', unavailableCode: 'OUTPUT_COUNT_UNAVAILABLE' });
check('8 non-x1 -> SELECT_REQUIRED x1', d8.state === 'SELECT_REQUIRED' && d8.index === 0, d8);

check('9 Nano Banana 2 accepted', FI.decideImageModel({ present: true, text: '🍌 Nano Banana 2 arrow_drop_down' }).ok === true, FI.decideImageModel({ present: true, text: '🍌 Nano Banana 2 arrow_drop_down' }));
const d10 = FI.decideImageModel({ present: true, text: '🍌 Nano Banana 2 Lite' });
check('10 unexpected model rejected (exact match, not substring)', d10.ok === false && d10.code === 'UNSUPPORTED_IMAGE_MODEL', d10);
const d10b = FI.decideImageModel({ present: true, text: '🍌 Nano Banana Pro' });
check('10b Nano Banana Pro rejected', d10b.ok === false && d10b.code === 'UNSUPPORTED_IMAGE_MODEL', d10b);
check('9b missing model control -> IMAGE_MODEL_UNAVAILABLE', FI.decideImageModel({ present: false, text: '' }).code === 'IMAGE_MODEL_UNAVAILABLE');

check('11 missing Mode -> IMAGE_MODE_UNAVAILABLE', FI.decideRadioGroup({ present: false, options: [], desired: 'Image', controlLabel: 'Mode', unavailableCode: 'IMAGE_MODE_UNAVAILABLE' }).code === 'IMAGE_MODE_UNAVAILABLE');
check('12 missing Aspect -> ASPECT_RATIO_UNAVAILABLE', FI.decideRadioGroup({ present: false, options: [], desired: '16:9', controlLabel: 'Aspect ratio', unavailableCode: 'ASPECT_RATIO_UNAVAILABLE' }).code === 'ASPECT_RATIO_UNAVAILABLE');
check('13 missing Output -> OUTPUT_COUNT_UNAVAILABLE', FI.decideRadioGroup({ present: false, options: [], desired: 'x1', controlLabel: 'Output count', unavailableCode: 'OUTPUT_COUNT_UNAVAILABLE' }).code === 'OUTPUT_COUNT_UNAVAILABLE');

check('required image model is Nano Banana 2', FI.REQUIRED_IMAGE_MODEL === 'Nano Banana 2');
check('normalizeModelLabel strips emoji + arrow_drop_down', FI.normalizeModelLabel('🍌 Nano Banana 2 arrow_drop_down') === 'Nano Banana 2', FI.normalizeModelLabel('🍌 Nano Banana 2 arrow_drop_down'));
// --- video-path Agent-OFF safety: the SAME decision is reused (Agent ON must be disabled; fail closed) ---
check('video path reuses the Agent toggle decision (ON -> TOGGLE_OFF)', FI.decideAgentToggle({ present: true, ariaPressed: 'true' }).action === 'TOGGLE_OFF');
check('video path (Agent OFF) proceeds without toggling', FI.decideAgentToggle({ present: true, ariaPressed: 'false' }).action === 'NONE');
check('video path fails closed when the standard composer cannot be reached (no toggle)', FI.decideAgentToggle({ present: false, ariaPressed: null }).code === 'STANDARD_COMPOSER_UNAVAILABLE');
{
  const err = new FI.FlowImageModeError('UNSUPPORTED_IMAGE_MODEL', 'refusing');
  check('FlowImageModeError carries code + prefixed message', err.code === 'UNSUPPORTED_IMAGE_MODEL' && /^UNSUPPORTED_IMAGE_MODEL: refusing/.test(err.message), err.message);
}

// -------------------------------------------------- source: new adapter uses only current selectors
const flowClient = fs.readFileSync(path.join(SRC, 'flowClient.ts'), 'utf8');
const implStart = flowClient.indexOf('async ensureImageGenerationMode(');
const implEnd = flowClient.indexOf('Locate a settings option button');
const impl = flowClient.slice(implStart, implEnd > implStart ? implEnd : implStart + 9000);
check('14 new implementation has NO imageImage selector', !/imageImage/.test(impl));
check('14 new implementation has NO videocamVideo selector', !/videocamVideo/.test(impl));
check('14 new implementation has NO cdk-overlay-pane hasText regex', !/cdk-overlay-pane[\s\S]{0,200}hasText/.test(impl));
check('uses scoped Mode toggle', /S\.modeToggle/.test(impl) && /flow-toggles\[aria-label='Mode'\]/.test(fs.readFileSync(path.join(SRC, 'selectors.ts'), 'utf8')));
check('uses scoped Aspect ratio toggle', /S\.aspectRatioToggle/.test(impl));
check('uses scoped Output count toggle', /S\.outputCountToggle/.test(impl));
check('uses the image model control', /S\.imageModel/.test(impl));
check('turns Agent OFF via aria-pressed', /decideAgentToggle/.test(impl) && /aria-pressed/.test(impl));
check('selections are verified via aria-checked', /aria-checked/.test(impl) && /SELECT_REQUIRED|selectRadioInGroup/.test(impl));

const selectors = fs.readFileSync(path.join(SRC, 'selectors.ts'), 'utf8');
check('selectors expose agentModeToggle', /agentModeToggle:\["flow-agent-mode-toggle-chip button\.agent-mode-chip"\]/.test(selectors));
check('selectors expose modeToggle', /modeToggle:\["flow-toggles\[aria-label='Mode'\]"\]/.test(selectors));
check('selectors expose aspectRatioToggle', /aspectRatioToggle:\["flow-toggles\[aria-label='Aspect ratio'\]"\]/.test(selectors));
check('selectors expose outputCountToggle', /outputCountToggle:\["flow-toggles\[aria-label='Output count'\]"\]/.test(selectors));
check('selectors expose imageModel', /imageModel:\["button\[aria-label='Select model family'\]"\]/.test(selectors));
check('settingsTrigger + aspect16x9 + promptInput + submit retained', /settingsTrigger:/.test(selectors) && /aspect16x9:/.test(selectors) && /promptInput:/.test(selectors) && /submit:/.test(selectors));

// -------------------------------------------------- runner orchestration unchanged
const runnerSrc = fs.readFileSync(path.join(SRC, 'runner.ts'), 'utf8');
check('runner still calls ensureImageGenerationMode() (interface unchanged)', /flow\.ensureImageGenerationMode\(\)/.test(runnerSrc));
check('runner background sequence preserved',
  /returnToProjectGrid\(\)[\s\S]{0,160}ensureImageGenerationMode\(\)[\s\S]{0,400}generateBackground\(\)[\s\S]{0,200}renameGeneratedBackground/.test(runnerSrc));

// -------------------------------------------------- video path preserved (untouched)
const videoStart = flowClient.indexOf('async configureVideoGeneration(');
const videoImpl = flowClient.slice(videoStart, implStart);
check('video configuration path preserved (imageImage/videocamVideo untouched)', /videocamVideo/.test(videoImpl) && /imageImage/.test(videoImpl));
check('video settingsTrigger usage preserved', /S\.settingsTrigger/.test(videoImpl));

console.log(`\nFLOW-IMAGE-MODE ADAPTER TESTS PASSED (${passed} checks)`);
