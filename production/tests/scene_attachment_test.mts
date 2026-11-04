// Offline regression tests for Flow scene attachment + account-prefixed routes.
// Pure functions only — no Flow, no Chrome, no network, no credits.
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const vd = await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);
const {
  canonicalSceneUrl, deriveRoutesFromMountedSceneUrl, buildPersistenceReloadSequence,
  matchFlowProjectBase, matchFlowSceneId, isFlowProjectRoot, isCanonicalFlowSceneRoute,
  resolveSceneAttachmentTarget, isFlowSceneId,
} = vd;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

const PID = 'be1f9d68-74b8-4be3-8d4d-40da6e90fcdc';
const SID = '3f9a1c22-77bd-4a10-9e44-1c0aa1b2d3e4';
const PLAIN = `https://flow.google.com/project/${PID}`;
const MULTI = `https://flow.google.com/u/1/project/${PID}`;

// ---------- 1. account-prefixed /u/1/project/<UUID> routes ----------
check('matchFlowProjectBase: plain', matchFlowProjectBase(PLAIN) === PLAIN);
check('matchFlowProjectBase: /u/1/ prefix accepted', matchFlowProjectBase(MULTI) === MULTI);
check('matchFlowProjectBase: /u/0/ prefix accepted', matchFlowProjectBase(`https://flow.google.com/u/0/project/${PID}`) === `https://flow.google.com/u/0/project/${PID}`);
check('matchFlowProjectBase: foreign host rejected', matchFlowProjectBase(`https://evil.example.com/u/1/project/${PID}`) === null);
check('matchFlowSceneId: scene route', matchFlowSceneId(`${MULTI}/scene/${SID}`) === SID);
check('matchFlowSceneId: edit route', matchFlowSceneId(`${MULTI}/edit/${SID}`) === SID);
check('matchFlowSceneId: project root is not a scene route', matchFlowSceneId(MULTI) === null);
check('isFlowProjectRoot: /u/1/ accepted', isFlowProjectRoot(MULTI) && isFlowProjectRoot(`${MULTI}/`));
check('isFlowProjectRoot: scene route rejected', !isFlowProjectRoot(`${MULTI}/scene/${SID}`));
check('isFlowProjectRoot: foreign host rejected', !isFlowProjectRoot(`https://evil.example.com/u/1/project/${PID}`));
check('isCanonicalFlowSceneRoute: /u/1/ accepted', isCanonicalFlowSceneRoute(`${MULTI}/scene/${SID}`));
check('isCanonicalFlowSceneRoute: /edit/ rejected', !isCanonicalFlowSceneRoute(`${MULTI}/edit/${SID}`));

check('canonicalSceneUrl PRESERVES the account prefix', canonicalSceneUrl(MULTI, SID) === `${MULTI}/scene/${SID}`);
check('canonicalSceneUrl still works without a prefix', canonicalSceneUrl(PLAIN, SID) === `${PLAIN}/scene/${SID}`);
check('canonicalSceneUrl rejects a bad id', canonicalSceneUrl(MULTI, 'short') === '');

const d1 = deriveRoutesFromMountedSceneUrl(`${MULTI}/scene/${SID}`);
check('deriveRoutes: /u/1/ scene route ok', d1.ok === true && d1.ok && d1.projectUrl === MULTI && d1.sceneId === SID);
check('deriveRoutes: canonical keeps the prefix', d1.ok && d1.canonicalSceneUrl === `${MULTI}/scene/${SID}`);
const d2 = deriveRoutesFromMountedSceneUrl(`${MULTI}/edit/${SID}`);
check('deriveRoutes: /u/1/ edit route ok', d2.ok === true && d2.ok && d2.sceneId === SID);
check('deriveRoutes: project root is not a scene route', deriveRoutesFromMountedSceneUrl(MULTI).ok === false);
check('deriveRoutes: empty fails closed', deriveRoutesFromMountedSceneUrl('').ok === false);

check('persistence sequence accepts /u/1/ routes',
  JSON.stringify(buildPersistenceReloadSequence(MULTI, `${MULTI}/scene/${SID}`)) === JSON.stringify([MULTI, `${MULTI}/scene/${SID}`]));
check('persistence sequence rejects /edit/', buildPersistenceReloadSequence(MULTI, `${MULTI}/edit/${SID}`).length === 0);
check('persistence sequence rejects a mismatched project', buildPersistenceReloadSequence(MULTI, `${PLAIN}/scene/${SID}`).length === 0);

// ---------- 2. absent flow_scene_id ----------
check('isFlowSceneId: uuid ok', isFlowSceneId(SID));
check('isFlowSceneId: empty rejected', !isFlowSceneId('') && !isFlowSceneId(undefined) && !isFlowSceneId(null));
check('isFlowSceneId: english title rejected', !isFlowSceneId('Spirit Dissolves'));
check('isFlowSceneId: auto-named Flow title rejected', !isFlowSceneId('Untitled Scene 10-06 08:27:47'));

// ---------- 3. Flow titles differing from manifest titles ----------
// The manifest holds English working titles; Flow holds auto-generated names. Neither is
// an acceptable identity, so a title-only scene must NOT resolve to an attachment target.
check('no flow_scene_id + no mounted route -> unresolved', resolveSceneAttachmentTarget({}).kind === 'unresolved');
check('absent flow_scene_id with a mounted route resolves', (() => {
  const r = resolveSceneAttachmentTarget({ flowSceneId: undefined, mountedRouteSceneId: SID });
  return r.kind === 'open-by-id' && r.sceneId === SID && r.source === 'MOUNTED_ROUTE';
})());
check('manifest flow_scene_id wins when present', (() => {
  const r = resolveSceneAttachmentTarget({ flowSceneId: SID, mountedRouteSceneId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
  return r.kind === 'open-by-id' && r.sceneId === SID && r.source === 'MANIFEST_FLOW_SCENE_ID';
})());
check('a manifest TITLE is never accepted as identity', resolveSceneAttachmentTarget({ flowSceneId: 'Spirit Dissolves' }).kind === 'unresolved');
check('an auto-named Flow title is never accepted as identity', resolveSceneAttachmentTarget({ flowSceneId: 'Untitled Scene 10-06 08:27:47' }).kind === 'unresolved');

// ---------- 4. ambiguous / unresolvable target -> fail closed ----------
const unres = resolveSceneAttachmentTarget({ flowSceneId: '', mountedRouteSceneId: null });
check('ambiguous target fails closed', unres.kind === 'unresolved');
check('diagnostic explains why', unres.kind === 'unresolved' && /refusing to attach by title/.test(unres.reason) && /unrelated scene/.test(unres.reason));

// ---------- 5. prevention of attachment to the WRONG scene ----------
// Every unresolved case must NOT return a usable sceneId, so no caller can open a scene.
for (const bad of [{}, { flowSceneId: 'Eternal Search' }, { flowSceneId: 'Spirit Dissolves', mountedRouteSceneId: 'Untitled Scene 10-06 08:27:47' }]) {
  const r = resolveSceneAttachmentTarget(bad);
  check(`no sceneId leaks for ${JSON.stringify(bad)}`, r.kind === 'unresolved' && !('sceneId' in (r as any)));
}
// A resolved target is always an explicit id, never a title.
const okRes = resolveSceneAttachmentTarget({ flowSceneId: SID }) as any;
check('resolved target is an id, not a title', typeof okRes.sceneId === 'string' && okRes.sceneId === SID);

console.log(`\nscene attachment + account routes: ${passed} checks passed`);