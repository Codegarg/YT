// Focused OFFLINE tests for the explicit scene-generation policy.
//
// Pure decision logic only: no browser, no Flow, no filesystem writes, no network.
// The cases below correspond to the supplied design matrix and integration constraints.
import { pathToFileURL } from 'node:url';
import { SRC } from './_testPaths.mjs';

const P = await import(pathToFileURL(`${SRC}/sceneGenerationPolicy.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const SCENE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SCENE_ID = '22222222-2222-4222-8222-222222222222';
const CLIP_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_CLIP_ID = '44444444-4444-4444-8444-444444444444';

const auth = (over: any = {}) => ({
  operation: 'EXTEND',
  targetSceneId: SCENE_ID,
  expectedCommittedClipId: CLIP_ID,
  ...over,
});

const base = (over: any = {}) => ({
  localClipValid: false,
  committed: { state: 'PRESENT', sceneId: SCENE_ID, committedClipId: CLIP_ID },
  allowGeneration: true,
  sceneLocalAvailable: true,
  sceneLocalAuthorization: auth(),
  ...over,
});

const noAuth = (over: any = {}) => base({ sceneLocalAuthorization: null, ...over });

console.log('--- local clip precedence / overwrite protection ---');
{
  const r = P.decideSceneGenerationPolicy(noAuth({ localClipValid: true }));
  check('1 valid local clip + no authorization -> USE_LOCAL', r.action === 'USE_LOCAL', r);

  const r2 = P.decideSceneGenerationPolicy(base({ localClipValid: true }));
  check('2 valid local clip + authorization -> STOP, never implicit overwrite',
    r2.action === 'STOP' && r2.code === 'LOCAL_CLIP_PRESENT', r2);

  const r3 = P.decideSceneGenerationPolicy(noAuth({
    localClipValid: true,
    committed: { state: 'UNKNOWN', reason: 'scene probe timed out' },
  }));
  check('3 unknown scene state stops even with a local clip', r3.action === 'STOP' && r3.code === 'SCENE_STATE_UNKNOWN', r3);
}

console.log('--- committed scene / download-only ---');
{
  const r = P.decideSceneGenerationPolicy(noAuth({ allowGeneration: true }));
  check('4 committed + no authorization -> DOWNLOAD_ONLY', r.action === 'DOWNLOAD_ONLY', r);
  check('4b download-only carries the exact observed identities',
    r.sceneId === SCENE_ID && r.committedClipId === CLIP_ID, r);

  const r2 = P.decideSceneGenerationPolicy(noAuth({ allowGeneration: false }));
  check('4c allowGeneration alone never changes the no-authorization outcome',
    r2.action === 'DOWNLOAD_ONLY', r2);
}

console.log('--- authorization validation ---');
{
  const r = P.decideSceneGenerationPolicy(base({ allowGeneration: false }));
  check('5 authorization denied by run-level generation permission',
    r.action === 'STOP' && r.code === 'GENERATION_NOT_AUTHORIZED', r);

  const r2 = P.decideSceneGenerationPolicy(base({ sceneLocalAvailable: false }));
  check('6 unavailable scene-local capability stops',
    r2.action === 'STOP' && r2.code === 'SCENE_LOCAL_UNAVAILABLE', r2);

  const r3 = P.decideSceneGenerationPolicy(base({ sceneLocalAuthorization: auth({ targetSceneId: '' }) }));
  check('7 missing target id stops', r3.action === 'STOP' && r3.code === 'TARGET_UNRESOLVED', r3);

  const r4 = P.decideSceneGenerationPolicy(base({ sceneLocalAuthorization: auth({ targetSceneId: '   ' }) }));
  check('7b blank target id stops', r4.action === 'STOP' && r4.code === 'TARGET_UNRESOLVED', r4);

  const r5 = P.decideSceneGenerationPolicy(base({ sceneLocalAuthorization: auth({ targetSceneId: 'a scene title' }) }));
  check('7c malformed target id stops', r5.action === 'STOP' && r5.code === 'TARGET_UNRESOLVED', r5);

  const r6 = P.decideSceneGenerationPolicy(base({ sceneLocalAuthorization: auth({ targetSceneId: OTHER_SCENE_ID }) }));
  check('8 mismatched target scene id stops',
    r6.action === 'STOP' && r6.code === 'TARGET_MISMATCH', r6);

  const r7 = P.decideSceneGenerationPolicy(base({ sceneLocalAuthorization: auth({ expectedCommittedClipId: '' }) }));
  check('9 missing expected committed clip id stops',
    r7.action === 'STOP' && r7.code === 'COMMITTED_CLIP_UNRESOLVED', r7);

  const r8 = P.decideSceneGenerationPolicy(base({ sceneLocalAuthorization: auth({ expectedCommittedClipId: OTHER_CLIP_ID }) }));
  check('10 mismatched expected committed clip id stops',
    r8.action === 'STOP' && r8.code === 'COMMITTED_CLIP_MISMATCH', r8);

  const r9 = P.decideSceneGenerationPolicy(base({ sceneLocalAuthorization: auth({ operation: 'REPLACE' }) }));
  check('11 invalid operation stops',
    r9.action === 'STOP' && r9.code === 'AUTHORIZATION_INVALID', r9);

  const r10 = P.decideSceneGenerationPolicy(base({ sceneLocalAuthorization: { operation: 'EXTEND' } }));
  check('11b incomplete authorization object stops',
    r10.action === 'STOP' && r10.code === 'TARGET_UNRESOLVED', r10);

  const r11 = P.decideSceneGenerationPolicy(base({
    committed: { state: 'PRESENT', sceneId: SCENE_ID, committedClipId: '' },
  }));
  check('12 committed PRESENT with no clip id is ambiguous, not download',
    r11.action === 'STOP' && r11.code === 'SCENE_STATE_AMBIGUOUS', r11);

  const r12 = P.decideSceneGenerationPolicy(base({
    committed: { state: 'PRESENT', sceneId: '', committedClipId: CLIP_ID },
  }));
  check('12b committed PRESENT with no scene id is ambiguous',
    r12.action === 'STOP' && r12.code === 'SCENE_STATE_AMBIGUOUS', r12);
}

console.log('--- unknown / malformed state ---');
{
  const r = P.decideSceneGenerationPolicy(noAuth({
    committed: { state: 'UNKNOWN', reason: 'read failed' },
  }));
  check('13 unknown committed state stops', r.action === 'STOP' && r.code === 'SCENE_STATE_UNKNOWN', r);
  check('13b unknown reason is preserved', r.reason === 'read failed', r);

  const r2 = P.decideSceneGenerationPolicy(noAuth({
    committed: { state: 'MAYBE', sceneId: SCENE_ID },
  }));
  check('13c malformed committed state is ambiguous, not ABSENT',
    r2.action === 'STOP' && r2.code === 'SCENE_STATE_AMBIGUOUS', r2);

  const r3 = P.decideSceneGenerationPolicy(noAuth({ committed: null }));
  check('13d missing committed evidence stops as unknown',
    r3.action === 'STOP' && r3.code === 'SCENE_STATE_UNKNOWN', r3);
}

console.log('--- clipless / first-clip separation ---');
{
  const r = P.decideSceneGenerationPolicy(noAuth({
    committed: { state: 'ABSENT', sceneId: null },
  }));
  check('14 clipless + no authorization + no target -> FIRST_CLIP',
    r.action === 'FIRST_CLIP' && r.mode === 'FIRST_CLIP_PROJECT_GENERATION', r);

  const rNoPermission = P.decideSceneGenerationPolicy(noAuth({
    committed: { state: 'ABSENT', sceneId: null },
    allowGeneration: false,
  }));
  check('14b clipless first clip still requires run-level generation permission',
    rNoPermission.action === 'STOP' && rNoPermission.code === 'GENERATION_NOT_AUTHORIZED', rNoPermission);

  const r2 = P.decideSceneGenerationPolicy(noAuth({
    committed: { state: 'ABSENT', sceneId: SCENE_ID },
  }));
  check('15 clipless + existing target + no authorization -> STOP, first clip does not target it',
    r2.action === 'STOP' && r2.code === 'FIRST_CLIP_TARGET_UNSUPPORTED', r2);

  const r3 = P.decideSceneGenerationPolicy(base({
    committed: { state: 'ABSENT', sceneId: null },
  }));
  check('16 clipless + scene-local authorization -> STOP, never downgrade to first clip',
    r3.action === 'STOP' && r3.code === 'SCENE_LOCAL_UNSUPPORTED', r3);

  const r4 = P.decideSceneGenerationPolicy(noAuth({
    committed: { state: 'ABSENT', sceneId: 'not a flow scene id' },
  }));
  check('16b clipless + malformed target identity is ambiguous',
    r4.action === 'STOP' && r4.code === 'SCENE_STATE_AMBIGUOUS', r4);
}

console.log('--- authorized scene-local outcomes ---');
{
  const r = P.decideSceneGenerationPolicy(base());
  check('17 authorized EXTEND -> SCENE_LOCAL_EXTENSION',
    r.action === 'SCENE_LOCAL_EXTENSION' && r.operation === 'EXTEND'
    && r.mode === 'SCENE_CLIP_EDIT_OR_EXTENSION', r);
  check('17b extension carries the exact target and expected clip',
    r.targetSceneId === SCENE_ID && r.expectedCommittedClipId === CLIP_ID, r);

  const r2 = P.decideSceneGenerationPolicy(base({ sceneLocalAuthorization: auth({ operation: 'REGENERATE' }) }));
  check('18 authorized REGENERATE -> SCENE_LOCAL_REGENERATE',
    r2.action === 'SCENE_LOCAL_REGENERATE' && r2.operation === 'REGENERATE'
    && r2.mode === 'SCENE_CLIP_EDIT_OR_EXTENSION', r2);

  const r3 = P.decideSceneGenerationPolicy(base({
    sceneLocalAuthorization: auth({ expectedCommittedClipId: CLIP_ID.toUpperCase() }),
  }));
  check('19 committed clip identity is normalized through the existing artifact validator',
    r3.action === 'SCENE_LOCAL_EXTENSION' && r3.expectedCommittedClipId === CLIP_ID, r3);

  const LONG_SCENE_ID = 'abcdefghijklmnopqrstuvwx';
  const r4 = P.decideSceneGenerationPolicy(base({
    committed: { state: 'PRESENT', sceneId: LONG_SCENE_ID, committedClipId: CLIP_ID },
    sceneLocalAuthorization: auth({ targetSceneId: LONG_SCENE_ID }),
  }));
  check('20 the existing stable Flow scene-id format (long opaque token) is accepted',
    r4.action === 'SCENE_LOCAL_EXTENSION' && r4.targetSceneId === LONG_SCENE_ID, r4);
}

console.log(`\n${passed} scene-generation policy checks passed (fully offline).`);
