// Offline Step-5 tests: scene video attachment + persistence (browser-free).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const vd = await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);
const { normalizeClipCount, sceneHasAnyClip, clipPersistenceEvidence, classifyImmediateAttachment, classifyClipPersistence, isSingleExactMatch } = vd;
const { FlowClient } = await import(pathToFileURL(`${SRC}/flowClient.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};
const fcSrc = fs.readFileSync(path.join(SRC, 'flowClient.ts'), 'utf8');
const fcSrcK = fcSrc;
const body = (name: string) => { const s = fcSrc.indexOf(`async ${name}(`); if (s < 0) return ''; const rest = fcSrc.slice(s + 1); const m = rest.match(/\n  (private |protected |public )?(async )?[a-zA-Z_$][\w$]*\s*\(/); const e = m && m.index !== undefined ? s + 1 + m.index : fcSrc.length; return fcSrc.slice(s, e); };
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const codeK = (s: string) => code(s);

// ------------------------------------------------------- pure clip helpers
check('normalizeClipCount counts real clips', normalizeClipCount([{ isClip: true }, { isClip: false }, { isClip: true }]).count === 2);
check('normalizeClipCount flags ambiguity on non-array/malformed input', normalizeClipCount(undefined).ambiguous === true && normalizeClipCount([null as any]).ambiguous === true);
check('normalizeClipCount ignores non-boolean isClip entries (only true counts)', normalizeClipCount([{ isClip: true }, { isClip: 'weird' } as any]).count === 1);
check('sceneHasAnyClip true with one clip', sceneHasAnyClip([{ isClip: false }, { isClip: true }]) === true);
check('sceneHasAnyClip false with none', sceneHasAnyClip([{ isClip: false }]) === false);
check('immediate: 0 -> 1 ATTACHED', classifyImmediateAttachment(0, 1) === 'ATTACHED');
check('immediate: 0 -> 0 NOT_ATTACHED', classifyImmediateAttachment(0, 0) === 'NOT_ATTACHED');
check('immediate: 1 -> 2 AMBIGUOUS (populated scene not allowed)', classifyImmediateAttachment(1, 2) === 'AMBIGUOUS');

// ------------------------------------------------------------ persistence
check('persistence evidence builder is explicit', JSON.stringify(clipPersistenceEvidence(1, 1, false)) === JSON.stringify({ beforeCount: 1, afterCount: 1, ambiguous: false }));
check('before 1 / after 1 -> PERSISTENT', classifyClipPersistence(clipPersistenceEvidence(1, 1)) === 'PERSISTENT');
check('before 1 / after 0 -> NOT_PERSISTENT', classifyClipPersistence(clipPersistenceEvidence(1, 0)) === 'NOT_PERSISTENT');
check('before 1 / after 2 -> AMBIGUOUS', classifyClipPersistence(clipPersistenceEvidence(1, 2)) === 'AMBIGUOUS');
check('before 0 / after 1 stays AMBIGUOUS through classifyClipPersistence (attachment handled separately)', classifyClipPersistence(clipPersistenceEvidence(0, 1)) === 'AMBIGUOUS');
check('ambiguous flag -> AMBIGUOUS', classifyClipPersistence(clipPersistenceEvidence(1, 1, true)) === 'AMBIGUOUS');

// ------------------------------------------------------- route predicates
const { pageUrlIsSceneRoute } = await import(pathToFileURL(`${SRC}/flowClient.ts`).href);
const PID = 'c30385ce-bfe4-4177-9730-caf087070f9a';
const SID = 'b7111244-2115-488b-9941-9ef394fbe2d5';
check('route A: /project/<id>/scene/<uuid> is accepted', pageUrlIsSceneRoute(`https://flow.google.com/project/${PID}/scene/${SID}`) === true);
check('route B: /project/<id>/edit/<uuid> is accepted', pageUrlIsSceneRoute(`https://flow.google.com/project/${PID}/edit/${SID}`) === true);
check('route C: /project/<id>/edit/ (no scene id) is rejected', pageUrlIsSceneRoute(`https://flow.google.com/project/${PID}/edit/`) === false);
check('route D: /project/<id>/scene/ (no scene id) is rejected', pageUrlIsSceneRoute(`https://flow.google.com/project/${PID}/scene/`) === false);
check('route F: an invalid project id is rejected', pageUrlIsSceneRoute(`https://flow.google.com/project/x/edit/${SID}`) === false && pageUrlIsSceneRoute(`https://flow.google.com/edit/${SID}`) === false);
check('route G: an invalid scene id is rejected', pageUrlIsSceneRoute(`https://flow.google.com/project/${PID}/edit/not-a-valid-id`) === false && pageUrlIsSceneRoute(`https://flow.google.com/project/${PID}/scene/x`) === false);
check('route: a non-project path with /edit/<id> is rejected', pageUrlIsSceneRoute(`https://flow.google.com/library/edit/${SID}`) === false);
check('route: trailing extra segments are rejected', pageUrlIsSceneRoute(`https://flow.google.com/project/${PID}/edit/${SID}/extra`) === false);
check('route: query/hash do not defeat the match', pageUrlIsSceneRoute(`https://flow.google.com/project/${PID}/edit/${SID}?x=1#y`) === true);

const openBody = body('openSceneEditor');
check('mount: /edit route alone with timeline+composer is accepted by the predicate+checks', pageUrlIsSceneRoute(`https://flow.google.com/project/${PID}/edit/${SID}`) === true && /flow-scene-timeline/.test(openBody) && /S\.scenePromptBox/.test(openBody));
check('mount: the /scene route + both signals path is unchanged', pageUrlIsSceneRoute(`https://flow.google.com/project/${PID}/scene/${SID}`) === true && /did not mount/.test(openBody));

const hasClipBody = body('sceneHasClip');
check('openSceneEditor uses the /scene/<id> project route', /\/scene\/\$\{target\}/.test(openBody) && /page\.goto/.test(openBody));
// STEP-8CC: title-addressed scenes must capture BOTH routes (live 8CB defect)
check('8CC title path derives projectUrl + canonicalSceneUrl from the mounted URL', /deriveRoutesFromMountedSceneUrl\(this\.page\.url\(\)\)/.test(openBody) && /this\.projectUrl = derived\.projectUrl/.test(openBody) && /this\.canonicalSceneUrl = derived\.canonicalSceneUrl/.test(openBody));
check('8CC title path fails closed when route derivation fails', /openSceneEditor failed: \$\{derived\.reason\}/.test(openBody));
check('8CC no longer assigns canonicalSceneUrl from a bare page.url()', !/this\.canonicalSceneUrl = this\.page\.url\(\)/.test(openBody));
// The ID-addressed branch must (a) resolve a VALIDATED project base, (b) fail closed when it
// cannot, (c) assign this.projectUrl from that base, (d) derive the canonical scene route from
// it, and only THEN (e) navigate. Asserted as ordered source structure over comment-stripped
// code, so an obsolete local name can never make this pass or fail spuriously.
const openCode = code(openBody);
const atBase = openCode.indexOf('const projectBase = matchFlowProjectBase(base)');
const atGuard = openCode.indexOf('if (!projectBase) throw new Error(');
const atProjectUrl = openCode.indexOf('this.projectUrl = projectBase');
const atCanonical = openCode.indexOf('canonicalSceneUrl(projectBase, target)');
const atNavigate = openCode.indexOf('this.page.goto(this.canonicalSceneUrl');
check('8CC ID-addressed path resolves a validated project base, fails closed without one, and sets projectUrl + canonicalSceneUrl before navigating',
  atBase >= 0
  && atGuard > atBase
  && atProjectUrl > atGuard
  && atCanonical > atProjectUrl
  && atNavigate > atCanonical
  && /openSceneEditor could not resolve the project URL/.test(openCode));
check('FlowClient.sceneHasClip exists', hasClipBody.length > 0);
check('sceneHasClip is scoped to flow-scene-timeline and .clip', /querySelector\('flow-scene-timeline'\)/.test(hasClipBody) && /querySelectorAll\('\.clip'\)/.test(hasClipBody));
check('sceneHasClip excludes descendants and empty slots', /clip-body|clip-content|clip-container/.test(hasClipBody) && /empty|drop-zone|placeholder/i.test(hasClipBody));
check('sceneHasClip delegates to the pure helper', /sceneHasAnyClip\(evidence/.test(hasClipBody));
check('sceneHasClip avoids chips/player/composer elements', !/chip-container|flow-base-prompt-box|video\b/.test(code(hasClipBody)));

const attachBody = body('attachVideoClipToTimeline');
check('FlowClient.attachVideoClipToTimeline exists', attachBody.length > 0);
check('attach refuses an already-populated scene', /scene already has a clip|refused/.test(attachBody) && /await this\.sceneHasClip\(\)/.test(attachBody));
check('attach selects the Videos category explicitly and verifies aria-selected', /Videos/.test(attachBody) && /aria-selected/.test(attachBody) && /could not be selected/.test(attachBody));
check('attach throws when Videos is unavailable', /Videos category is unavailable/.test(attachBody));
check('attach performs the persistence check after reopening the scene', /page\.goto\(sceneUrl/.test(attachBody) && /waitForClipEvidence/.test(attachBody));
check('attach uses classifyClipPersistence and requires PERSISTENT', /classifyClipPersistence\(clipPersistenceEvidence\(1,/.test(attachBody) && /PERSISTENT/.test(attachBody) && /persistence was/.test(attachBody));
check('attach returns {title, attached:true, persistent:true} with no invented ids', /return \{ title: wanted, attached: true, persistent: true \}/.test(attachBody) && !/mediaId|clipId|uuid|duration/i.test(code(attachBody)));
check('flowClient imports the pure clip helpers (no duplicated logic)', /isSingleExactMatch, classifyClipPersistence, clipPersistenceEvidence, classifyImmediateAttachment, sceneHasAnyClip/.test(fcSrc));
check('runner.ts WIRES the video reconciliation path', /flow\.reconcileGeneratedVideoWithScene\(/.test(fs.readFileSync(path.join(SRC, 'runner.ts'), 'utf8')));
check('selectors.ts was NOT extended for Videos category/clip helpers', !/videosCategory|clipPersistence|sceneHasClip/.test(fs.readFileSync(path.join(SRC, 'selectors.ts'), 'utf8')));

// STEP 8K - pre-populated edit session reconciliation
const reconBody = (() => { const s = fcSrcK.indexOf('async reconcileGeneratedVideoWithScene('); const e = fcSrcK.indexOf('\n  /**\n   * Bounded reopen', s); return s < 0 ? '' : fcSrcK.slice(s, e < 0 ? fcSrcK.length : e); })();
const reconCode = codeK(reconBody);

check('8K reconcileGeneratedVideoWithScene exists', reconBody.length > 0);

const makeRecon = (opts: { count: number | ((n: number) => number); reads?: number | ((n: number) => number); rail?: string; reopenRail?: string; committed?: string; attach?: (a: string) => Promise<any>; emptyAttachThrows?: boolean }) => {
  let counter = 0; let reopens = 0;
  const client: any = new FlowClient({ locator: () => ({ first: () => ({ waitFor: async () => {} }) }) } as any, () => {});
  client.countTimelineClips = async () => { const n = ++counter; return typeof opts.count === 'function' ? (opts.count as any)(n) : opts.count as number; };
  client.attachGeneratedVideoToEmptyScene = async (a: string) => { if (opts.emptyAttachThrows) throw new Error('attach failed'); return (opts.attach ? opts.attach(a) : { mode: 'attached', artifactId: a, persistent: true }); };
  client.verifyPopulatedSceneMedia = async (a: string) => { if (!a) throw new Error('Populated-scene verification failed: refusing to bind the populated scene (empty expected artifact).'); const rail = opts.rail ?? a; if (rail !== a) throw new Error(`Populated-scene verification failed: mismatch (${rail} != ${a}).`); return { mode: 'already-populated', railArtifactId: rail, active: true }; };
  client.readActiveRailArtifact = async () => ({ artifactId: (reopens > 0 ? (opts.reopenRail ?? opts.rail ?? '') : (opts.rail ?? '')) });
  // STEP-8BJ: the persistence read settles the committed rail identity via the 8AJ
  // bounded rail settle. `committed`/`reopenRail`/`rail` drive the settled UUID.
  let railReads = 0;
  client.waitForStableActiveRailArtifact = async () => { railReads++; const id = opts.committed !== undefined ? (opts.committed as string) : (reopens > 0 ? (opts.reopenRail ?? opts.rail ?? '') : (opts.rail ?? '')); return id ? { kind: 'ok', artifactId: id } : { kind: 'none' }; };
  client.__railReads = () => railReads;
  client.projectUrl = 'https://flow.google.com/project/p';
  client.canonicalSceneUrl = 'https://flow.google.com/project/p/scene/s';
  // STEP-8BH: each fresh persistence read resolves the stable timeline evidence and
  // the committed rail identity. `count` drives the per-read clip count.
  // STEP-8BH: a dedicated per-fresh-read sequence (independent of the branch-check counter).
  let readSeq = 0;
  const readCount = () => { const n = ++readSeq; if (opts.reads !== undefined) return typeof opts.reads === 'function' ? (opts.reads as any)(n) : opts.reads as number; return typeof opts.count === 'function' ? (opts.count as any)(n) : opts.count as number; };
  client.waitForStableTimelineEvidence = async () => { const c = readCount(); return { clipCount: c, hydratedEmpty: c === 0 }; };
  client.waitForStableClipCount = async () => readCount();
  const gotos: string[] = [];
  client.page = { url: () => 'https://flow.google.com/project/p/edit/s', goto: async (u: string) => { gotos.push(u); reopens++; }, locator: () => ({ first: () => ({ waitFor: async () => {} }) }) };
  return { client, reopenInfo: () => ({ reopens, counts: counter }), gotos: () => gotos };
};

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const C = 'cccccccc-3333-4333-8333-cccccccccccc';

// A. one clip + exact rail match -> already attached, persistence verified
{
  const { client, reopenInfo, gotos } = makeRecon({ count: 1, rail: A });
  const r = await client.reconcileGeneratedVideoWithScene('Video A', A);
  check('8K-A one verified clip -> already-attached success (no Add Clip, no row clicks)',
    r.mode === 'already-attached' && r.attached === true && r.persistent === true && reopenInfo().reopens === 2, JSON.stringify(r));
  check('8AQ navigation order is exactly [project, canonical-scene]', JSON.stringify(gotos()) === JSON.stringify(['https://flow.google.com/project/p', 'https://flow.google.com/project/p/scene/s']), JSON.stringify(gotos()));
  check('8AQ never navigates to /edit/<id> during persistence verification', !gotos().some((u) => /\/edit\//.test(u)), JSON.stringify(gotos()));
}
// B. one clip + different rail artifact -> the populate branch still binds exactly
{
  const { client } = makeRecon({ count: 1, rail: B });
  let msg = ''; try { await client.reconcileGeneratedVideoWithScene('Video A', A); } catch (e: any) { msg = String(e.message); }
  check('8K-B one clip with a different artifact -> fail closed', /mismatch|does not equal|refusing to bind/.test(msg), msg);
}
// C. one clip + missing identity -> fail closed
{
  const { client } = makeRecon({ count: 1, rail: '' });
  let msg = ''; try { await client.reconcileGeneratedVideoWithScene('Video A', ''); } catch (e: any) { msg = String(e.message); }
  check('8K-C one clip with no identity/artifact -> fail closed', /refusing to bind the populated scene|mismatch|empty/.test(msg), msg);
}
// D. zero clips -> delegates to the EMPTY-scene attach path with the exact artifact id
{
  let attachArgs: any = null;
  const { client } = makeRecon({ count: (n: number) => (n === 1 ? 0 : 1), rail: A, attach: async (a: string) => { attachArgs = a; return { mode: 'attached', artifactId: a, persistent: true }; } });
  const r = await client.reconcileGeneratedVideoWithScene('Video A', A);
  check('8K-D zero clips -> empty-scene attach invoked with the exact artifact id', attachArgs === A && r.mode === 'attached', JSON.stringify({ attachArgs, r }));
}
// E. two clips -> SceneContainsMultipleClipsError
{
  const { client } = makeRecon({ count: 2 });
  let err: any = null; try { await client.reconcileGeneratedVideoWithScene('Video A', A); } catch (e: any) { err = e; }
  check('8K-E two clips -> SceneContainsMultipleClipsError (multi-clip unsupported)', err && err.name === 'SceneContainsMultipleClipsError' && /not supported by the evidence-backed automation/.test(String(err.message)), String(err?.message));
}
// F/G. populated branch reopens exactly once for persistence
{
  const { client, reopenInfo } = makeRecon({ count: 1, rail: A });
  const r = await client.reconcileGeneratedVideoWithScene('Video A', A);
  check('8K-F populated branch: refresh+reopen for persistence (no Add Clip, no row clicks)',
    r.mode === 'already-attached' && reopenInfo().reopens === 2, JSON.stringify({ r, reopens: reopenInfo().reopens }));
}
// 8BA: the committed scene identity is authoritative — a DIFFERENT uuid is still SUCCESS
{
  const { client } = makeRecon({ count: 1, rail: A, committed: B });
  const r = await client.reconcileGeneratedVideoWithScene('Video A', A);
  check('8BA committed identity differs from generated -> SUCCESS (not a failure)', r.persistent === true && r.committedSceneArtifactId === B && r.generatedArtifactId === A, JSON.stringify(r));
  check('8BA result exposes generatedArtifactId + committedSceneArtifactId + identitySource', r.identitySource === 'scene-navigation-rail' && r.committedSceneArtifactId !== r.generatedArtifactId, JSON.stringify(r));
}
// 8BA: committed identity missing/invalid -> fail closed
{
  const { client } = makeRecon({ count: 1, rail: A, committed: '' });
  let msg = ''; try { await client.reconcileGeneratedVideoWithScene('Video A', A); } catch (e: any) { msg = String(e.message); }
  check('8BA committed identity missing -> fail closed', /no media identity/.test(msg), msg);
}
// persistence: a changed committed identity after reopen is ADOPTED (not a failure)
{
  const { client } = makeRecon({ count: 1, rail: A, reopenRail: C });
  const r = await client.reconcileGeneratedVideoWithScene('Video A', A);
  check('8BA a changed committed identity after reopen is ADOPTED (not a failure)', r.persistent === true && r.committedSceneArtifactId === C, JSON.stringify(r));
}
// persistence failure: clip disappears after reopen -> 3 empty fresh reads -> NOT_PERSISTED
{
  const { client } = makeRecon({ count: 1, reads: 0, rail: A });
  let msg = ''; try { await client.reconcileGeneratedVideoWithScene('Video A', A); } catch (e: any) { msg = String(e.message); }
  check('8K-F3 populated clip that vanishes after reopen -> fail closed', /did not persist after 3 fresh reads/.test(msg), msg);
}
// H/I. reconciliation branches by clip count and never mutates a populated scene
check('8K-H reconciliation branches by clip count via classifySceneState', /classifySceneState\(clipCount\)/.test(reconCode) && /SceneContainsMultipleClipsError/.test(reconCode));
check('8K-I reconciliation never removes or appends to a populated scene', !/remove|delete|splice/.test(reconCode));
check('8K reconcile routes 0->empty attach and 1->populated verify', /attachGeneratedVideoToEmptyScene\(expectedArtifactId\)/.test(reconCode) && /verifyPopulatedSceneMedia\(expectedArtifactId\)/.test(reconCode));
check('8AQ reopen refreshes via the validated PROJECT route before the canonical scene', /buildPersistenceReloadSequence\(this\.projectUrl, this\.canonicalSceneUrl\)/.test(reconCode) && /await this\.page\.goto\(projectRoute, \{ waitUntil: 'domcontentloaded' \}\)/.test(reconCode) && /await this\.page\.goto\(sceneUrl, \{ waitUntil: 'domcontentloaded' \}\)/.test(reconCode));
check('8AQ reopen never uses page.url() and never re-gotos the same scene', !/this\.page\.url\(\)/.test(reconCode) && /sequence\.length !== 2/.test(reconCode));
check('8AQ project surface must mount or the refresh fails closed', /the project surface did not mount during the persistence refresh/.test(reconCode) && /S\.addMedia/.test(reconCode));
check('8AQ the project URL is captured together with the canonical scene URL', /this\.projectUrl = projectBase/.test(fcSrcK) && /this\.canonicalSceneUrl = canonicalSceneUrl\(projectBase, target\)/.test(fcSrcK) && /private projectUrl = ''/.test(fcSrcK));
check('8AN timeline hydration semantics are unchanged by 8AQ/8BH', /classifyTimelineHydrationEvidence\(last\.clipCount, last\.hydratedEmpty\)/.test(fcSrcK) && /if \(decision === 'populated' \|\| decision === 'empty' \|\| decision === 'ambiguous'\) return last;/.test(fcSrcK) && /if \(decision === 'populated'\) return 1;/.test(fcSrcK) && /if \(decision === 'empty'\) return 0;/.test(fcSrcK));
check('8AQ reopen mount-checks timeline + composer before reading', /const mounted = await this\.page\.locator\('flow-scene-timeline'\)/.test(reconCode) && /const composer = await this\.first\(S\.scenePromptBox/.test(reconCode) && /did not remount on reopen/.test(reconCode));
check('8AQ/8BH reopen settles the clip count before classifying (no immediate 0=failure)', /await this\.waitForStableTimelineEvidence\(\)/.test(reconCode) && /classifyPersistenceReadRetry\(r\.clipCount, r\.hydratedEmpty, attempt, maxAttempts\)/.test(reconCode));
check('8AH settle is bounded (timeout + interval, no infinite wait)', /waitForStableClipCount\(/.test(fcSrcK) && /while \(Date\.now\(\) - start < timeoutMs\)/.test(fcSrcK));
check('8AN reopen now uses the EXPLICIT hydrated-empty marker (signal-bounded, not a bare zero)', /readTimelineEvidence\(\)/.test(fcSrcK) && /classifyTimelineHydrationEvidence\(/.test(fcSrcK) && /withStableTimelineEvidence|waitForStableTimelineEvidence/.test(fcSrcK));
check('8AN empty marker is the observed timeline-contents.is-empty / empty-timeline-track', /is-empty/.test(fcSrcK) && /empty-timeline-track/.test(fcSrcK) && /timeline-contents/.test(fcSrcK));
check('8AN a bare zero without the marker never returns empty (keeps polling)', /if \(decision === 'empty'\) return 0;/.test(fcSrcK) && /classifyTimelineHydrationEvidence/.test(fcSrcK) && !/stableClipCountFromReads[\s\S]{0,200}return 0/.test(fcSrcK));
check('8BA removes the generation==committed equality assertion', !/reopenedId !== expectedArtifactId/.test(fcSrcK) && /resolveCommittedSceneIdentity/.test(fcSrcK) && /classifySceneAttachmentIdentity/.test(fcSrcK));

// 8BB/8BX: empty-scene attach orchestration coverage (structure-level, source-driven)
const emptyAttachBody = body('attachGeneratedVideoToEmptyScene');
check('8BX D6 preview resolution failure (0/>1 matches) -> fail closed before any mutation', /if \(!resolved\.ok\)/.test(emptyAttachBody) && /Empty-scene attach failed: \$\{resolved\.reason\}/.test(emptyAttachBody) && emptyAttachBody.indexOf('if (!resolved.ok)') < emptyAttachBody.indexOf('addMedia.click()'));
check('8BX E the single mutation is decision-gated (Add media present + exact preview)', /decideFirstClipAttachment\(\{ previewArtifactId: expected, targetArtifactId: expected, addMediaPresent: addMediaCount === 1 \}\)/.test(emptyAttachBody) && /if \(!decision\.ok\)/.test(emptyAttachBody));
check('8BX E post-mutation picker disappearance is NOT an attachment failure', (() => { const i = emptyAttachBody.indexOf('addMedia.click()'); const j = emptyAttachBody.indexOf('waitForClipEvidence'); return i >= 0 && j > i && /await this\.waitForClipEvidence\(8000\)\.catch\(\(\) => false\)/.test(emptyAttachBody); })());

// 8AJ: populated-scene rail settle
const popBody = (() => { const s = fcSrcK.indexOf('async verifyPopulatedSceneMedia('); const e = fcSrcK.indexOf('\n  /**', s); return s < 0 ? '' : fcSrcK.slice(s, e < 0 ? fcSrcK.length : e); })();
check('8AJ populated verification settles the rail before binding (no one-shot read)', /await this\.waitForStableActiveRailArtifact\(\)/.test(popBody) && /stableActiveRailFromReads\(reads, requiredStable\)/.test(fcSrcK));
check('8AJ rail settle is bounded (20s / 500ms / stable 2), never unbounded', /waitForStableActiveRailArtifact\(timeoutMs = 20000, intervalMs = 500, requiredStable = 2\)/.test(fcSrcK));
check('8AJ populated verification still requires EXACT identity (settle alone is not enough)', /acceptPopulatedRailBinding\(expectedArtifactId, settled\.artifactId\)/.test(popBody));
check('8AJ populated verification never clicks Add Clip / a rail item / a row', !/addClipButton|\.click\(/.test(codeK(popBody)));
check('8AJ multi-clip still fails before any rail identity logic', /SceneContainsMultipleClipsError\(clipCount\)/.test(reconCode) && reconCode.indexOf('SceneContainsMultipleClipsError') < reconCode.indexOf('verifyPopulatedSceneMedia'));

// 8BH: bounded READ-ONLY persistence retry (integration through reconcileGeneratedVideoWithScene)
{
  // (1) first read persisted -> exactly one fresh read (2 gotos) and success
  const { client, gotos } = makeRecon({ count: 1, rail: A });
  const r = await client.reconcileGeneratedVideoWithScene('Video A', A);
  check('8BH-1 first read persisted -> 1 fresh read, success', r.persistent === true && gotos().length === 2, JSON.stringify({ gotos: gotos() }));
}
{
  // (2)+(3) first read empty, second read persisted -> success after 2 fresh reads (4 gotos)
  const { client, gotos } = makeRecon({ count: 1, reads: (n: number) => (n === 1 ? 0 : 1), rail: A });
  const r = await client.reconcileGeneratedVideoWithScene('Video A', A);
  check('8BH-2/3 first read empty then persisted -> retry succeeds (2 fresh reads)', r.persistent === true && gotos().length === 4, JSON.stringify({ gotos: gotos().length, r }));
}
{
  // (4)+(5) three reads empty -> NOT_PERSISTED after 3 fresh reads (6 gotos)
  const { client, gotos } = makeRecon({ count: 1, reads: 0 });
  let msg = ''; try { await client.reconcileGeneratedVideoWithScene('Video A', A); } catch (e: any) { msg = String(e.message); }
  check('8BH-4/5 three empty reads -> NOT_PERSISTED (3 fresh reads, fail closed)', /did not persist after 3 fresh reads/.test(msg) && gotos().length === 6, JSON.stringify({ msg, gotos: gotos().length }));
}
{
  // (6) >1 clips present on the fresh read -> hard failure, NO retry (single fresh read = 2 gotos)
  const { client, gotos } = makeRecon({ count: 1, reads: 2, rail: A });
  let msg = ''; try { await client.reconcileGeneratedVideoWithScene('Video A', A); } catch (e: any) { msg = String(e.message); }
  check('8BH-6 >1 clips -> hard failure, no retry (single fresh read)', /expected at most 1|SceneContainsMultipleClipsError/.test(msg) && gotos().length === 2, JSON.stringify({ msg, gotos: gotos().length }));
}
check('8BH persistence retries are READ-ONLY (never click/re-attach/generate)', /for \(let attempt = 1; attempt <= maxAttempts; attempt\+\+\)/.test(reconCode) && /const r = await reopenAndReadCommittedOnce\(\)/.test(reconCode) && !/for \(let attempt[\s\S]{0,700}click\(/.test(reconCode) && !/for \(let attempt[\s\S]{0,700}generateProjectVideo/.test(reconCode) && !/for \(let attempt[\s\S]{0,700}attachGeneratedVideoToEmptyScene/.test(reconCode));
check('8BH max attempts are bounded to 3 (no unbounded loop)', /const maxAttempts = 3;/.test(fcSrcK) && /for \(let attempt = 1; attempt <= maxAttempts; attempt\+\+\)/.test(fcSrcK));
check('8BH attachment is executed once, outside the retry loop', (reconCode.match(/await this\.attachGeneratedVideoToEmptyScene\(/g) ?? []).length === 1 && !/for \(let attempt[\s\S]{0,700}attachGeneratedVideoToEmptyScene/.test(reconCode));
check('8BH no generation retry exists', (fcSrcK.match(/generateProjectVideo/g) ?? []).length >= 1 && !/for \(let attempt[\s\S]{0,400}generateProjectVideo/.test(fcSrcK));

// 8BJ: settle the COMMITTED RAIL identity before persistence resolution
check('8BJ persistence read settles the rail identity after the timeline evidence', (() => { const once = reconCode.slice(reconCode.indexOf('const reopenAndReadCommittedOnce'), reconCode.indexOf('// Bounded READ-ONLY fresh-load retry')); const ti = once.indexOf('waitForStableTimelineEvidence()'); const ri = once.indexOf('waitForStableActiveRailArtifact()'); return ti >= 0 && ri > ti; })());
check('8BJ rail settle is reused (no duplicate rail polling in the read path)', /await this\.waitForStableActiveRailArtifact\(\)/.test(reconCode) && (reconCode.match(/waitForStableActiveRailArtifact\(/g) ?? []).length === 1);
check('8BJ rail settle only when a clip is present (clipCount===1)', /if \(evidence\.clipCount === 1\) \{[\s\S]{0,200}waitForStableActiveRailArtifact\(\)/.test(reconCode));
{
  // (1)+(2) clip=1, rail identity available -> PERSISTED, no persistence retry (single read)
  const { client, gotos } = makeRecon({ count: 1, rail: A, committed: B });
  const r = await client.reconcileGeneratedVideoWithScene('Video A', A);
  check('8BJ-1/2 clip=1 with settled rail -> PERSISTED, no retry (1 read)', r.persistent === true && r.committedSceneArtifactId === B && gotos().length === 2, JSON.stringify({ r, gotos: gotos().length }));
  check('8BJ rail settle polled the rail exactly once for a persisted scene', (client.__railReads?.() ?? -1) === 1, String(client.__railReads?.()));
}
{
  // (3) empty-branch attach, then the fresh read finds clip=1 but the rail settle exposes
  // no identity -> fail closed
  const { client } = makeRecon({ count: (n: number) => (n === 1 ? 0 : 1), reads: 1, rail: '', committed: '' });
  let msg = ''; try { await client.reconcileGeneratedVideoWithScene('Video A', A); } catch (e: any) { msg = String(e.message); }
  check('8BJ-3 clip=1 but no settled rail identity -> fail closed', /no media identity/.test(msg), msg);
}
check('8BJ-4 exactly one persistence read for a populated scene', /const r = await reopenAndReadCommittedOnce\(\);/.test(reconCode) && /for \(let attempt = 1; attempt <= maxAttempts; attempt\+\+\)/.test(reconCode));
check('8BJ-5/6 rail settle adds no attachment/generation retry', !/for \(let attempt[\s\S]{0,700}(attachGeneratedVideoToEmptyScene|generateProjectVideo)/.test(reconCode));
check('8BJ-7/8 identities may differ; committed identity is authoritative', /committedSceneArtifactId: identity\.committedArtifactId/.test(reconCode) && /identitySource: 'scene-navigation-rail'/.test(reconCode) && !/committedSceneArtifactId === expectedArtifactId/.test(reconCode));

// ---- 8BM: full reconciliation state-machine boundary audit ----
// (1) generated UUID may differ from committed UUID -> success
{
  const { client } = makeRecon({ count: 1, rail: A, committed: B });
  const r = await client.reconcileGeneratedVideoWithScene('Video A', A);
  check('8BM-1 generated UUID != committed UUID -> success', r.persistent === true && r.generatedArtifactId === A && r.committedSceneArtifactId === B, JSON.stringify(r));
}
// (2) picker UUID may differ from committed UUID -> success (picker never feeds the committed identity)
check('8BM-2 picker UUID != committed UUID -> success (picker never feeds committed identity)', /readActiveRailArtifact|waitForStableActiveRailArtifact/.test(fcSrcK) && !/committedArtifactId: expectedArtifactId/.test(reconCode) && !/committedArtifactId: selection/.test(reconCode));
// (3) committed UUID missing -> fail closed
{
  const { client } = makeRecon({ count: 1, rail: A, committed: '' });
  let msg = ''; try { await client.reconcileGeneratedVideoWithScene('Video A', A); } catch (e: any) { msg = String(e.message); }
  check('8BM-3 committed UUID missing -> fail closed', /no media identity/.test(msg), msg);
}
// (4)+(5) populated + rail settle -> PERSISTED, no persistence retry
{
  const { client, gotos } = makeRecon({ count: 1, rail: A, committed: B });
  const r = await client.reconcileGeneratedVideoWithScene('Video A', A);
  check('8BM-4/5 populated -> PERSISTED with no persistence retry (1 read)', r.persistent === true && gotos().length === 2, JSON.stringify({ gotos: gotos().length }));
}
// (6) empty hydrated scene -> retry
{
  const { client, gotos } = makeRecon({ count: 1, reads: (n: number) => (n === 1 ? 0 : 1), rail: A, committed: B });
  const r = await client.reconcileGeneratedVideoWithScene('Video A', A);
  check('8BM-6 empty hydrated first read -> retry then PERSISTED (2 reads)', r.persistent === true && gotos().length === 4, JSON.stringify({ gotos: gotos().length }));
}
// (7) three empty hydrated reads -> NOT_PERSISTED
{
  const { client, gotos } = makeRecon({ count: 1, reads: 0 });
  let msg = ''; try { await client.reconcileGeneratedVideoWithScene('Video A', A); } catch (e: any) { msg = String(e.message); }
  check('8BM-7 three empty hydrated reads -> NOT_PERSISTED (3 reads)', /did not persist after 3 fresh reads/.test(msg) && gotos().length === 6, JSON.stringify({ msg, gotos: gotos().length }));
}
// (8) >1 clips -> AMBIGUOUS
{
  const { client } = makeRecon({ count: 2 });
  let err: any = null; try { await client.reconcileGeneratedVideoWithScene('Video A', A); } catch (e: any) { err = e; }
  check('8BM-8 >1 clips -> AMBIGUOUS (SceneContainsMultipleClipsError)', err?.name === 'SceneContainsMultipleClipsError', String(err?.message));
}
// (9) malformed evidence -> INVALID (pure classifier)
check('8BM-9 malformed evidence -> INVALID', (vd as any).classifyPersistenceReadRetry(-1, false, 1, 3) === 'INVALID' && (vd as any).classifyPersistenceReadRetry(0, false, 1, 3) === 'INVALID');
// (10)+(11) no attachment / generation retry after NOT_PERSISTED
check('8BM-10/11 no attachment or generation retry after NOT_PERSISTED', !/for \(let attempt[\s\S]{0,800}(attachGeneratedVideoToEmptyScene|generateProjectVideo)/.test(reconCode));
// (12) rail polling is inside a single read (does not itself consume a persistence attempt)
check('8BM-12 rail polling is inside one read, not a persistence attempt', (() => { const s = reconCode.indexOf('const reopenAndReadCommittedOnce'); const e = reconCode.indexOf('const reopenAndReadCommitted ='); const once = reconCode.slice(s, e > s ? e : s + 4000); return /waitForStableActiveRailArtifact\(\)/.test(once) && !/attempt\+\+/.test(once); })());
// (13) one Start click invariant (within the generation function only)
check('8BM-13 generation clicks Start exactly once', (() => { const g = body('generateProjectVideo'); const gcode = g.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n'); const r = fs.readFileSync(path.join(SRC, 'runner.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n'); return (gcode.match(/this\.click\(S\.submit\)/g) ?? []).length === 1 && (r.match(/generateProjectVideo\(/g) ?? []).length === 1; })());
// (14) one attachment invariant
check('8BM-14 attachment happens at most once (single call in the EMPTY branch)', (reconCode.match(/attachGeneratedVideoToEmptyScene\(/g) ?? []).length === 1);
// (15) 8BX preview-UUID identity invariant intact (legacy img[src] helpers retained as compat)
check('8BM-15 8BX preview-UUID identity invariant intact', /resolvePickerRowByPreviewUuid\(expected\)/.test(body('attachGeneratedVideoToEmptyScene')) && /extractPreviewArtifactUuid/.test(fcSrc) && /resolvePickerCandidateByPreviewUuid\(seen, target\)/.test(fcSrc) && /exactlyOneSelectedVideoRow/.test(fcSrc) && /waitForVideoTargetSelection/.test(fcSrc));
check('8BM-15b pure preview helpers remain exported from videoDecisions', /export function classifyVideoRowConfirmation/.test(fs.readFileSync(path.join(SRC, 'videoDecisions.ts'), 'utf8')) && /export function resolvePickerCandidateByPreviewUuid/.test(fs.readFileSync(path.join(SRC, 'videoDecisions.ts'), 'utf8')));
// (16) canonical /scene route remains authoritative
check('8BM-16 canonical /scene route is authoritative for persistence', /buildPersistenceReloadSequence\(this\.projectUrl, this\.canonicalSceneUrl\)/.test(fcSrc) && !/\/edit\//.test(reconCode));
// (17) committed identity is never replaced by generation/picker identity
check('8BM-17 committed identity never substituted with generation/picker identity', /resolveCommittedSceneIdentity\(railArtifactId\)/.test(fcSrcK) && /committedSceneArtifactId: identity\.[a-zA-Z]+/.test(fcSrcK) && !/committedSceneArtifactId: expectedArtifactId/.test(fcSrcK));
// (18) success requires persistent=true
check('8BM-18 success returns persistent:true only with a valid committed identity', /persistent: true, mode: 'attached'/.test(reconCode) && /persistent: true, mode: 'already-attached'/.test(reconCode));

// (19) SELECTED-ROW PREVIEW CONTRACT (live-proven, zero credit).
// The picker auto-selects row 0; clicking that already-selected row is a destructive toggle that
// destroys flow-add-menu-detail-pane and therefore the ONLY identity surface in the app.
{
  const vdSrc = fs.readFileSync(path.join(SRC, 'videoDecisions.ts'), 'utf8');
  const selStart = fcSrc.indexOf('private async readPickerRowSelectionState(');
  const selBody = fcSrc.slice(selStart, fcSrc.indexOf('\n  private async ', selStart + 10));
  const rs = fcSrc.indexOf('private async resolvePickerRowByPreviewUuid(');
  const resolverRaw = fcSrc.slice(rs, fcSrc.indexOf('\n  private async ', rs + 10));
  const resolver = code(resolverRaw);
  const hs = fcSrc.indexOf('async readSceneVideoLibraryUuidsViaPreview(');
  const snap = code(fcSrc.slice(hs, fcSrc.indexOf('\n  private async ', hs + 10)));
  const bl = code(fcSrc.slice(fcSrc.indexOf('private async waitForStablePickerBaseline('), fcSrc.indexOf('\n  private async ', fcSrc.indexOf('private async waitForStablePickerBaseline(') + 10)));
  const guardedClick = (src: string) => {
    const clicks = src.match(/rows\.nth\(i\)\.click\(\)/g) ?? [];
    if (clicks.length !== 1) return false;
    const g = src.indexOf('if (clicked)');
    const c = src.indexOf('rows.nth(i).click()');
    return g >= 0 && c > g && c - g < 120;
  };

  check('8BX-SR1 decideRowPreviewAction is exported, pure and strictly boolean',
    /export function decideRowPreviewAction\(rowAlreadySelected: unknown\)/.test(vdSrc)
    && /if \(rowAlreadySelected === true\) return \{ ok: true, action: 'READ' \};/.test(vdSrc)
    && /if \(rowAlreadySelected === false\) return \{ ok: true, action: 'CLICK' \};/.test(vdSrc));
  check('8BX-SR2 the resolver reads the row selection state and defers to the pure decision',
    /readPickerRowSelectionState\(rows\.nth\(i\)\)/.test(resolver) && /decideRowPreviewAction\(selected\)/.test(resolver)
    && /const clicked = decision\.ok && decision\.action === 'CLICK';/.test(resolver));
  check('8BX-SR3 the resolver clicks ONLY inside the guarded branch (no unconditional row click)',
    guardedClick(resolver));
  check('8BX-SR4 the snapshot loop applies the SAME guard (no unconditional row click)',
    /decideRowPreviewAction\(selected\)/.test(snap) && guardedClick(snap));
  check('8BX-SR5 the selection state is read once, fail-closed, and mapped to a strict boolean',
    /Promise<boolean \| null>/.test(selBody) && /if \(v === 'true'\) return true;/.test(selBody)
    && /if \(v === 'false'\) return false;/.test(selBody) && /catch \{[\s\S]{0,120}return null;/.test(selBody)
    && (fcSrc.match(/this\.readPickerRowSelectionState\(/g) ?? []).length === 2);
  check('8BX-SR6 the proven 1200 ms settle survives in both loops and the retry machinery is gone',
    /setTimeout\(r, 1200\)/.test(resolver) && /setTimeout\(r, rowSettleMs\)/.test(snap)
    && !/rowRetries|attempt\s*<=/.test(resolver + snap) && !/rowRetries\?:/.test(fcSrc));
  check('8BX-SR7 aria-selected is never an IDENTITY input in either loop',
    !/aria-selected/.test(resolver) && !/aria-selected/.test(snap)
    && !/decideRowPreviewIdentity\(\{[^}]*selected/i.test(fcSrc));
  check('8BX-SR8 Add media stays OUTSIDE identity scanning and remains one mutation per attach path',
    !/detail-add-to-prompt-btn/.test(resolver) && !/detail-add-to-prompt-btn/.test(snap)
    && (body('attachFirstClipByArtifactId').match(/await addMedia\.click\(\)/g) ?? []).length === 1
    && (body('attachGeneratedVideoToEmptyScene').match(/await addMedia\.click\(\)/g) ?? []).length === 1);
  check('8BX-SR9 no title, /asb/, row-order or hardcoded uuid identity in either loop',
    !/\/asb\/|asset-title|hasText/.test(resolver)
    && !/\/asb\//.test(snap)
    && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(resolver));
  check('8BX-SR10 no network interception / instrumentation was introduced',
    !/page\.route|page\.on\(.*request|WebSocket|addInitScript|exposeFunction/.test(resolver + snap + bl));
  check('8BX-SR11 the baseline re-opens the CANONICAL target scene before every snapshot attempt',
    /private async waitForStablePickerBaseline\(targetSceneId: string,/.test(fcSrc)
    && bl.indexOf('ensureTargetSceneOpen(want)') >= 0
    && bl.indexOf('ensureTargetSceneOpen(want)') < bl.indexOf('readSceneVideoLibraryUuidsViaPreview('));
  check('8BX-SR12 a canonical targetSceneId is required by the stabilizer (no title fallback)',
    /a canonical targetSceneId is required to stabilize the video-library baseline/.test(fcSrc)
    && !/sceneTitle|byTitle/.test(bl));
  check('8BX-SR13 PARTIAL snapshots still break the consecutive pair and cannot baseline',
    /code === 'PICKER_SNAPSHOT_PARTIAL'/.test(bl) && /reads\.length = 0/.test(bl) && /if \(snapshot\?\.ok === true\)/.test(bl));
  check('8BX-SR14 generation order is unchanged and Start is still clicked exactly once',
    (() => { const g = body('generateProjectFirstClip'); const i1 = g.indexOf('ensureTargetSceneOpen(targetSceneId)'); const i2 = g.indexOf('waitForStablePickerBaseline(targetSceneId)'); const i3 = g.indexOf('editor.fill(text)'); const i4 = g.indexOf('await start.click()'); return i1 >= 0 && i1 < i2 && i2 < i3 && i3 < i4 && (g.match(/await start\.click\(\)/g) ?? []).length === 1; })());
}

console.log(`\nVIDEO-ATTACHMENT TESTS PASSED (${passed} checks)`);
