// Offline pure tests for the STEP-8GF Flow-commitment vs local-media state model. No browser, no Flow.
import { pathToFileURL } from 'node:url';
import { SRC } from './_testPaths.mjs';
const { deriveFlowLocalState, isValidFlowSceneId, resolveFlowSceneId, isFlowLocalRenderable, isFlowCommittedLocalMissing } =
  await import(pathToFileURL(`${SRC}/flowMediaState.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

const ID = '7eb3ac95-3f15-47a9-8586-9e573d30c254';
const URL_OK = 'https://flow.google.com/project/c30385ce-bfe4-4177-9730-caf087070f9a/scene/' + ID;

// 1. no Flow id + no local clip
check('1 no flow + no local -> FLOW_NOT_COMMITTED, not renderable', (() => { const r = deriveFlowLocalState({ localClipExists: false, localClipValid: false }); return r.state === 'FLOW_NOT_COMMITTED' && r.renderable === false; })());
// 2. no Flow id + valid local clip
check('2 no flow + valid local -> LOCAL_AVAILABLE_FLOW_UNKNOWN, renderable', (() => { const r = deriveFlowLocalState({ localClipExists: true, localClipValid: true }); return r.state === 'LOCAL_AVAILABLE_FLOW_UNKNOWN' && r.renderable === true; })());
// 3. Flow id + valid local clip
check('3 flow + valid local -> FLOW_COMMITTED_LOCAL_AVAILABLE, renderable', (() => { const r = deriveFlowLocalState({ flowSceneId: ID, localClipExists: true, localClipValid: true }); return r.state === 'FLOW_COMMITTED_LOCAL_AVAILABLE' && r.renderable === true; })());
// 4. Flow id + missing local clip (Scene 15 case)
check('4 flow + missing local -> FLOW_COMMITTED_LOCAL_MISSING, NOT renderable', (() => { const r = deriveFlowLocalState({ flowSceneId: ID, localClipExists: false, localClipValid: false }); return r.state === 'FLOW_COMMITTED_LOCAL_MISSING' && r.renderable === false; })());
// 5. Flow id + local clip exists but invalid
check('5 flow + invalid local -> FLOW_COMMITTED_LOCAL_MISSING (invalid reason)', (() => { const r = deriveFlowLocalState({ flowSceneId: ID, localClipExists: true, localClipValid: false }); return r.state === 'FLOW_COMMITTED_LOCAL_MISSING' && r.renderable === false && /FAILS validation/i.test(r.reason); })());
// 6. malformed Flow id -> fail closed (not a commitment)
check('6 malformed flow id -> not a commitment', (() => { const r = deriveFlowLocalState({ flowSceneId: 'not-a-uuid', localClipExists: false, localClipValid: false }); return r.hasFlowCommitment === false; })());
check('6b malformed flow id + no local -> NOT renderable', deriveFlowLocalState({ flowSceneId: 'xyz', localClipExists: false, localClipValid: false }).renderable === false);
check('6c malformed flow id + valid local -> LOCAL_AVAILABLE_FLOW_UNKNOWN', deriveFlowLocalState({ flowSceneId: 'xyz', localClipExists: true, localClipValid: true }).state === 'LOCAL_AVAILABLE_FLOW_UNKNOWN');
// 7. empty Flow id
check('7 empty flow id -> no commitment', (() => { const r = deriveFlowLocalState({ flowSceneId: '', localClipExists: false, localClipValid: false }); return r.hasFlowCommitment === false; })());
check('7b whitespace flow id -> no commitment', resolveFlowSceneId({ flowSceneId: '   ' }) === null);
// 8. Flow URL with valid scene id
check('8 flow URL (scene) -> id extracted', resolveFlowSceneId({ flowSceneUrl: URL_OK }) === ID);
check('8b flow URL (edit) -> id extracted', resolveFlowSceneId({ flowSceneUrl: 'https://flow.google.com/project/p/edit/' + ID }) === ID);
check('8c explicit id beats url', resolveFlowSceneId({ flowSceneId: ID, flowSceneUrl: 'x' }) === ID);
// 9. malformed Flow URL
check('9 malformed flow URL -> null', resolveFlowSceneId({ flowSceneUrl: 'https://flow.google.com/project/p/scene/not-a-uuid' }) === null);
check('9b flow URL without scene id -> null', resolveFlowSceneId({ flowSceneUrl: 'https://flow.google.com/project/p' }) === null);
// 10. local clip exists but validation fails (already in 5, plus explicit)
check('10 local exists + invalid -> not renderable', deriveFlowLocalState({ localClipExists: true, localClipValid: false }).renderable === false);
check('10b localClipValid=true but exists=false is coerced to invalid', deriveFlowLocalState({ flowSceneId: ID, localClipExists: false, localClipValid: true }).state === 'FLOW_COMMITTED_LOCAL_MISSING');
// 11. determinism
check('11 deterministic for identical input', JSON.stringify(deriveFlowLocalState({ flowSceneId: ID, localClipExists: true, localClipValid: true })) === JSON.stringify(deriveFlowLocalState({ flowSceneId: ID, localClipExists: true, localClipValid: true })));
// 12. NO state permits rendering when local media is missing
check('12 flow-committed-missing never renderable', isFlowCommittedLocalMissing('FLOW_COMMITTED_LOCAL_MISSING') === true && deriveFlowLocalState({ flowSceneId: ID, localClipExists: false, localClipValid: false }).renderable === false);
check('12b renderable iff valid local clip', isFlowLocalRenderable('FLOW_COMMITTED_LOCAL_AVAILABLE') === true && isFlowLocalRenderable('FLOW_COMMITTED_LOCAL_MISSING') === false && isFlowLocalRenderable('FLOW_UNKNOWN') === false && isFlowLocalRenderable('FLOW_NOT_COMMITTED') === false && isFlowLocalRenderable('LOCAL_AVAILABLE_FLOW_UNKNOWN') === true);
// uuid validator
check('valid uuid accepted', isValidFlowSceneId(ID) === true && isValidFlowSceneId(ID.toUpperCase()) === true);
check('non-uuid rejected', isValidFlowSceneId('abc') === false && isValidFlowSceneId(null) === false && isValidFlowSceneId(12345) === false);
// null / malformed input fail closed
check('null input -> FLOW_NOT_COMMITTED not renderable', (() => { const r = deriveFlowLocalState(null); return r.state === 'FLOW_NOT_COMMITTED' && r.renderable === false; })());

console.log(`\nFLOW/LOCAL MEDIA STATE TESTS PASSED (${passed} checks)`);
