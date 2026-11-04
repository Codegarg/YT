// Offline unit tests for the STEP-8EX timing helpers. No browser, no Flow, no Chrome.
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const { classifyHydrationObservation, isFinalHydrationState, selectRecoverableDownload, classifyMountAwareObservation, isTerminalMountAwareState, classifyDownloadCapture, canTakeFirstAuthoritativeRead, classifyDownloadFlushPhase, shouldContinueHostedFlush, shouldTransitionToFilesystemCapture, classifyAttachSurfaceReadiness, classifyPersistenceReadRetry } =
  await import(pathToFileURL(`${SRC}/videoDecisions.ts`).href);

let passed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed += 1; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
}

// ================================================================ PART A — hydration
const MIN = 12000;

// 1. immediate 0 + not hydrated → HYDRATING (never failure)
check('A1 transient zero before window → HYDRATING', classifyHydrationObservation(0, 1000, MIN, false) === 'HYDRATING');
check('A1b transient zero at window edge but zero unstable → HYDRATING', classifyHydrationObservation(0, MIN, MIN, false) === 'HYDRATING');

// 2. later 1 + hydrated → POPULATED
check('A2 one clip → POPULATED (immediate, never delayed)', classifyHydrationObservation(1, 0, MIN, false) === 'POPULATED');
check('A2b one clip late → POPULATED', classifyHydrationObservation(1, 30000, MIN, false) === 'POPULATED');

// 3. hydrated empty → HYDRATED_EMPTY
check('A3 zero past window + stable → HYDRATED_EMPTY', classifyHydrationObservation(0, MIN, MIN, true) === 'HYDRATED_EMPTY');
check('A3b zero well past window + stable → HYDRATED_EMPTY', classifyHydrationObservation(0, 25000, MIN, true) === 'HYDRATED_EMPTY');

// 4. >1 clips → AMBIGUOUS
check('A4 two clips → AMBIGUOUS', classifyHydrationObservation(2, MIN, MIN, true) === 'AMBIGUOUS');
check('A4b three clips → AMBIGUOUS', classifyHydrationObservation(3, 0, MIN, false) === 'AMBIGUOUS');

// 5. malformed evidence → INVALID
check('A5 negative count → INVALID', classifyHydrationObservation(-1, MIN, MIN, true) === 'INVALID');
check('A5b NaN count → INVALID', classifyHydrationObservation(NaN, MIN, MIN, true) === 'INVALID');
check('A5c null count → INVALID', classifyHydrationObservation(null, MIN, MIN, true) === 'INVALID');

// 6. bounded timeout expiry → HYDRATING is the only non-final state
check('A6 HYDRATING is not final (loop keeps polling)', isFinalHydrationState('HYDRATING') === false);
check('A6b POPULATED is final', isFinalHydrationState('POPULATED') === true);
check('A6c HYDRATED_EMPTY is final', isFinalHydrationState('HYDRATED_EMPTY') === true);
check('A6d AMBIGUOUS is final', isFinalHydrationState('AMBIGUOUS') === true);
check('A6e INVALID is final', isFinalHydrationState('INVALID') === true);
check('A6f unknown state is not final', isFinalHydrationState('WHATEVER') === false);

// The critical invariant: a transient 0 + not-hydrated must NEVER be HYDRATED_EMPTY.
check('A-INV transient zero is never HYDRATED_EMPTY', classifyHydrationObservation(0, 5000, MIN, false) !== 'HYDRATED_EMPTY');

// ================================================================ PART B — download recovery
const BEFORE = ['scene-0001.mp4', 'yeh pehnu.mp4'];

// 1. no new candidate → pending (event success path is handled elsewhere)
check('B1 no new candidate → pending', selectRecoverableDownload([], BEFORE).kind === 'pending');
check('B1b only pre-existing files → pending', selectRecoverableDownload([{ name: 'scene-0001.mp4', size: 5000000, stableHits: 5 }], BEFORE).kind === 'pending');

// 2. event timeout + new .tmp appears → recovery
check('B2 new stable .tmp → ok', JSON.stringify(selectRecoverableDownload([{ name: 'c1d31a0c-267d-4694-a1cc-1cf97377dc19.tmp', size: 2160632, stableHits: 2 }], BEFORE)) === JSON.stringify({ kind: 'ok', name: 'c1d31a0c-267d-4694-a1cc-1cf97377dc19.tmp' }));
check('B2b new stable .mp4 → ok', selectRecoverableDownload([{ name: 'clip.mp4', size: 2160632, stableHits: 3 }], BEFORE).kind === 'ok');

// 3. .tmp appears but still growing → keep polling
check('B3 growing .tmp (1 hit) → pending', selectRecoverableDownload([{ name: 'grow.tmp', size: 500000, stableHits: 1 }], BEFORE).kind === 'pending');
check('B3b size changed resets to 1 hit → pending', selectRecoverableDownload([{ name: 'grow.tmp', size: 900000, stableHits: 1 }], BEFORE).kind === 'pending');

// 4. .tmp stabilizes → accepted
check('B4 stabilized .tmp (2 hits) → ok', selectRecoverableDownload([{ name: 's.tmp', size: 1000000, stableHits: 2 }], BEFORE).kind === 'ok');

// 5. pre-existing .tmp → ignored
check('B5 pre-existing .tmp ignored → pending', selectRecoverableDownload([{ name: 'scene-0001.mp4', size: 9000000, stableHits: 9 }, { name: 'old.tmp', size: 800000, stableHits: 4 }], [...BEFORE, 'old.tmp']).kind === 'pending');

// 6. no candidate before deadline → pending (caller classifies failure on bound expiry)
check('B6 empty sightings within bound → pending', selectRecoverableDownload([], BEFORE).kind === 'pending');
check('B6b malformed sightings → pending (fail closed)', selectRecoverableDownload(null, BEFORE).kind === 'pending');

// 7/8. candidate acceptance is size-based only; media validity is enforced by ffprobe downstream.
check('B7 zero-size candidate → pending (not accepted)', selectRecoverableDownload([{ name: 'empty.tmp', size: 0, stableHits: 5 }], BEFORE).kind === 'pending');
check('B8 two simultaneously-stable candidates → ambiguous (never guess)', selectRecoverableDownload([{ name: 'a.tmp', size: 1000, stableHits: 2 }, { name: 'b.tmp', size: 2000, stableHits: 2 }], BEFORE).kind === 'ambiguous');
check('B8b non-media extension ignored', selectRecoverableDownload([{ name: 'notes.txt', size: 100, stableHits: 5 }], BEFORE).kind === 'pending');

// ================================================================ PART C — mount gate (8EZ)
const MTO = 30000;

// 1. fresh navigation + no timeline mount → MOUNTING
check('C1 not mounted → MOUNTING', classifyMountAwareObservation({ mounted: false, mountElapsedMs: 1000, mountTimeoutMs: MTO }) === 'MOUNTING');
// 8. mount timeout → MOUNT_TIMEOUT
check('C8 mount window expired → MOUNT_TIMEOUT', classifyMountAwareObservation({ mounted: false, mountElapsedMs: MTO, mountTimeoutMs: MTO }) === 'MOUNT_TIMEOUT');
check('C8b mount beyond window → MOUNT_TIMEOUT', classifyMountAwareObservation({ mounted: false, mountElapsedMs: 40000, mountTimeoutMs: MTO }) === 'MOUNT_TIMEOUT');

// 2. timeline becomes mounted → hydration clock starts (mounted ⇒ post-mount states)
check('C2 mounted + count 1 → POPULATED', classifyMountAwareObservation({ mounted: true, clipCount: 1, hydrationElapsedMs: 0, minHydrationMs: MIN, zeroStable: false }) === 'POPULATED');
// 3. mounted + clipCount 0 + hydratedEmpty false → HYDRATING
check('C3 mounted + zero unsettled → HYDRATING', classifyMountAwareObservation({ mounted: true, clipCount: 0, hydrationElapsedMs: 1000, minHydrationMs: MIN, zeroStable: false }) === 'HYDRATING');
// 4. mounted + clipCount 1 → POPULATED (redundant explicit)
check('C4 mounted + one clip immediately → POPULATED', classifyMountAwareObservation({ mounted: true, clipCount: 1, hydrationElapsedMs: 0, minHydrationMs: MIN, zeroStable: false }) === 'POPULATED');
// 5. mounted + stable hydrated empty after floor → HYDRATED_EMPTY
check('C5 mounted + stable zero past floor → HYDRATED_EMPTY', classifyMountAwareObservation({ mounted: true, clipCount: 0, hydrationElapsedMs: MIN, minHydrationMs: MIN, zeroStable: true }) === 'HYDRATED_EMPTY');
// 6. >1 → AMBIGUOUS
check('C6 mounted + two clips → AMBIGUOUS', classifyMountAwareObservation({ mounted: true, clipCount: 2, hydrationElapsedMs: 0, minHydrationMs: MIN, zeroStable: false }) === 'AMBIGUOUS');
// 7. malformed → INVALID
check('C7 mounted + negative → INVALID', classifyMountAwareObservation({ mounted: true, clipCount: -1, hydrationElapsedMs: 0, minHydrationMs: MIN, zeroStable: false }) === 'INVALID');
check('C7b null input → INVALID', classifyMountAwareObservation(null) === 'INVALID');

// CRITICAL INVARIANT: a pre-mount clipCount=0 must NEVER become HYDRATED_EMPTY.
check('C-INV pre-mount zero never HYDRATED_EMPTY', classifyMountAwareObservation({ mounted: false, mountElapsedMs: 1000, mountTimeoutMs: MTO, clipCount: 0, hydrationElapsedMs: MIN, minHydrationMs: MIN, zeroStable: true }) === 'MOUNTING');
check('C-INV2 pre-mount zero past floor still MOUNTING', classifyMountAwareObservation({ mounted: false, mountElapsedMs: MIN, mountTimeoutMs: MTO, clipCount: 0, hydrationElapsedMs: 99999, minHydrationMs: MIN, zeroStable: true }) === 'MOUNTING');

// Terminal-state helper
check('C-T1 MOUNTING is not terminal', isTerminalMountAwareState('MOUNTING') === false);
check('C-T2 HYDRATING is not terminal', isTerminalMountAwareState('HYDRATING') === false);
check('C-T3 MOUNT_TIMEOUT is terminal', isTerminalMountAwareState('MOUNT_TIMEOUT') === true);
check('C-T4 POPULATED is terminal', isTerminalMountAwareState('POPULATED') === true);

// ============================================================ PART D — download recovery edges
// 1/2. immediate event success and delayed filesystem path both reduce to candidate selection.
check('D1 immediate stable candidate → ok', selectRecoverableDownload([{ name: 'a.tmp', size: 1000000, stableHits: 2 }], BEFORE).kind === 'ok');
// 3. late .tmp appears before deadline → ok (selection is time-independent; the bound is in the loop)
check('D3 late-but-before-deadline stable candidate → ok', selectRecoverableDownload([{ name: 'late.tmp', size: 500000, stableHits: 2 }], BEFORE).kind === 'ok');
// 4. grows → pending
check('D4 growing candidate → pending', selectRecoverableDownload([{ name: 'g.tmp', size: 10, stableHits: 1 }], BEFORE).kind === 'pending');
// 5. stabilizes → ok
check('D5 stabilized candidate → ok', selectRecoverableDownload([{ name: 'g.tmp', size: 999, stableHits: 2 }], BEFORE).kind === 'ok');
// 6. pre-existing ignored
check('D6 pre-existing ignored → pending', selectRecoverableDownload([{ name: 'a.tmp', size: 100, stableHits: 9 }], ['a.tmp']).kind === 'pending');
// 7. two stable → ambiguous
check('D7 two stable candidates → ambiguous', selectRecoverableDownload([{ name: 'a.tmp', size: 1, stableHits: 2 }, { name: 'b.tmp', size: 2, stableHits: 2 }], BEFORE).kind === 'ambiguous');
// 8. invalid (non-media / zero-size) → not accepted
check('D8 non-media candidate → pending', selectRecoverableDownload([{ name: 'x.txt', size: 10, stableHits: 3 }], BEFORE).kind === 'pending');
check('D8b zero-size candidate → pending', selectRecoverableDownload([{ name: 'z.tmp', size: 0, stableHits: 3 }], BEFORE).kind === 'pending');
// 9. no candidate by deadline → pending (loop converts to DOWNLOAD_EVENT_TIMEOUT)
check('D9 no candidate → pending', selectRecoverableDownload([], BEFORE).kind === 'pending');
// 10. appears near deadline and stabilizes → ok
check('D10 near-deadline stable candidate → ok', selectRecoverableDownload([{ name: 'n.tmp', size: 2160632, stableHits: 2 }], BEFORE).kind === 'ok');
// 11. appears after deadline → the loop never sees it, so it is never offered (pending)
check('D11 unseen-after-deadline candidate is not offered → pending', selectRecoverableDownload([], BEFORE).kind === 'pending');
// 12. bounded recovery is a structural property of the loop (no unbounded helper state); helper is pure.
check('D12 helper is pure/deterministic for identical input', JSON.stringify(selectRecoverableDownload([{ name: 'q.tmp', size: 5, stableHits: 2 }], BEFORE)) === JSON.stringify(selectRecoverableDownload([{ name: 'q.tmp', size: 5, stableHits: 2 }], BEFORE)));

// ============================================================ PART E — download capture lifecycle (8FB)
// 1/2/3. immediate MP4, delayed TMP, delayed MP4 all reduce to a stable candidate.
check('E1 immediate completed MP4 → READY', classifyDownloadCapture([{ name: 'now.mp4', size: 2160000, stableHits: 2 }], BEFORE, false) === 'READY');
check('E2 delayed TMP (stable) → READY', classifyDownloadCapture([{ name: 'dl.tmp', size: 1900000, stableHits: 2 }], BEFORE, false) === 'READY');
check('E3 delayed MP4 (stable) → READY', classifyDownloadCapture([{ name: 'dl.mp4', size: 1900000, stableHits: 2 }], BEFORE, false) === 'READY');
// 4. growing TMP → GROWING
check('E4 growing TMP → GROWING', classifyDownloadCapture([{ name: 'g.tmp', size: 1000, stableHits: 1 }], BEFORE, false) === 'GROWING');
// 5. two stable samples → READY
check('E5 two stable samples → READY', classifyDownloadCapture([{ name: 's.tmp', size: 5, stableHits: 2 }], BEFORE, false) === 'READY');
// 6. pre-existing candidate ignored → WAITING
check('E6 pre-existing ignored → WAITING', classifyDownloadCapture([{ name: 'old.tmp', size: 9, stableHits: 5 }], ['old.tmp'], false) === 'WAITING');
// 7. multiple candidates → AMBIGUOUS
check('E7 multiple stable → AMBIGUOUS', classifyDownloadCapture([{ name: 'a.tmp', size: 1, stableHits: 2 }, { name: 'b.tmp', size: 2, stableHits: 2 }], BEFORE, false) === 'AMBIGUOUS');
// 8. invalid candidate (non-media / zero-size) → nothing ready
check('E8 non-media → WAITING', classifyDownloadCapture([{ name: 'n.txt', size: 9, stableHits: 3 }], BEFORE, false) === 'WAITING');
check('E8b zero-size → WAITING', classifyDownloadCapture([{ name: 'z.tmp', size: 0, stableHits: 3 }], BEFORE, false) === 'WAITING');
// 9. no candidate → WAITING (then DEADLINE_EXCEEDED at the bound)
check('E9 no candidate → WAITING', classifyDownloadCapture([], BEFORE, false) === 'WAITING');
check('E9b no candidate at deadline → DEADLINE_EXCEEDED', classifyDownloadCapture([], BEFORE, true) === 'DEADLINE_EXCEEDED');
// 10/11. event fired + late materialization / near-deadline stable candidate → READY
check('E10 late stable materialization → READY', classifyDownloadCapture([{ name: 'late.tmp', size: 1900000, stableHits: 2 }], BEFORE, false) === 'READY');
check('E11 near-deadline stable candidate → READY', classifyDownloadCapture([{ name: 'near.tmp', size: 1900000, stableHits: 2 }], BEFORE, false) === 'READY');
// 12. candidate appears AFTER the deadline → not offered (WAITING → deadline exceeded)
check('E12 post-deadline candidate not offered → DEADLINE_EXCEEDED', classifyDownloadCapture([], BEFORE, true) === 'DEADLINE_EXCEEDED');
// 13. deterministic
check('E13 deterministic for identical input', classifyDownloadCapture([{ name: 'q.tmp', size: 5, stableHits: 2 }], BEFORE, false) === classifyDownloadCapture([{ name: 'q.tmp', size: 5, stableHits: 2 }], BEFORE, false));
// 14. teardown represented at decision level: firing the event but only a growing file → GROWING (never READY early)
check('E14 event fired + growing file → GROWING (not premature READY)', classifyDownloadCapture([{ name: 'p.tmp', size: 42, stableHits: 1 }], BEFORE, false) === 'GROWING');
check('E14b deadline during growth still reports GROWING (loop terminates on its own bound)', classifyDownloadCapture([{ name: 'p.tmp', size: 42, stableHits: 1 }], BEFORE, true) === 'GROWING');

// ================================================= PART F — post-mount first-read settle (8FB)
const SETTLE = 4000;
// 24. first authoritative read cannot occur before mount
check('F24 not mounted → first read forbidden', canTakeFirstAuthoritativeRead({ mounted: false, postMountElapsedMs: 99999, settleMs: SETTLE }) === false);
// 25. post-mount settle does not bypass hydration classification (gate is only about timing)
check('F25 mounted but pre-settle → forbidden', canTakeFirstAuthoritativeRead({ mounted: true, postMountElapsedMs: 1000, settleMs: SETTLE }) === false);
check('F25b mounted at settle boundary → allowed', canTakeFirstAuthoritativeRead({ mounted: true, postMountElapsedMs: SETTLE, settleMs: SETTLE }) === true);
check('F25c mounted past settle → allowed', canTakeFirstAuthoritativeRead({ mounted: true, postMountElapsedMs: 9000, settleMs: SETTLE }) === true);
check('F25d malformed input → forbidden (fail closed)', canTakeFirstAuthoritativeRead(null) === false);
check('F25e settle bypass still classifies via hydration (one clip → POPULATED)', classifyHydrationObservation(1, 0, MIN, false) === 'POPULATED');
check('F25f settle bypass still classifies transient zero → HYDRATING', classifyHydrationObservation(0, 1000, MIN, false) === 'HYDRATING');

// ================================================= PART G — hosted flush lifecycle (8FD)
const HF = 45000;
// 1/2. event fires → hosted flush active (no candidate yet)
check('G1/G2 event fired, no candidate → HOSTED_FLUSH', classifyDownloadFlushPhase({ sightings: [], beforeNames: BEFORE, downloadEventFired: true, hostedFlushElapsedMs: 1000, hostedFlushMs: HF }) === 'HOSTED_FLUSH');
// 3. candidate appears during hosted flush → READY
check('G3 candidate appears during hosted flush → READY', classifyDownloadFlushPhase({ sightings: [{ name: 'a.tmp', size: 1000000, stableHits: 2 }], beforeNames: BEFORE, downloadEventFired: true, hostedFlushElapsedMs: 5000, hostedFlushMs: HF }) === 'READY');
// 4. candidate after hosted flush → FILESYSTEM_CAPTURE
check('G4 no candidate, hosted flush elapsed → FILESYSTEM_CAPTURE', classifyDownloadFlushPhase({ sightings: [], beforeNames: BEFORE, downloadEventFired: true, hostedFlushElapsedMs: HF, hostedFlushMs: HF }) === 'FILESYSTEM_CAPTURE');
// 5. candidate grows → GROWING
check('G5 growing candidate → GROWING', classifyDownloadFlushPhase({ sightings: [{ name: 'g.tmp', size: 10, stableHits: 1 }], beforeNames: BEFORE, downloadEventFired: true, hostedFlushElapsedMs: 1000, hostedFlushMs: HF }) === 'GROWING');
// 6. two stable samples → READY
check('G6 two stable samples → READY', classifyDownloadFlushPhase({ sightings: [{ name: 's.tmp', size: 5, stableHits: 2 }], beforeNames: BEFORE, downloadEventFired: true, hostedFlushElapsedMs: 2000, hostedFlushMs: HF }) === 'READY');
// 7. pre-existing ignored
check('G7 pre-existing ignored → HOSTED_FLUSH', classifyDownloadFlushPhase({ sightings: [{ name: 'old.tmp', size: 9, stableHits: 9 }], beforeNames: ['old.tmp'], downloadEventFired: true, hostedFlushElapsedMs: 1000, hostedFlushMs: HF }) === 'HOSTED_FLUSH');
// 8. multiple candidates → AMBIGUOUS
check('G8 multiple stable → AMBIGUOUS', classifyDownloadFlushPhase({ sightings: [{ name: 'a.tmp', size: 1, stableHits: 2 }, { name: 'b.tmp', size: 2, stableHits: 2 }], beforeNames: BEFORE, downloadEventFired: true, hostedFlushElapsedMs: 1000, hostedFlushMs: HF }) === 'AMBIGUOUS');
// 9. invalid candidate
check('G9 non-media ignored → HOSTED_FLUSH', classifyDownloadFlushPhase({ sightings: [{ name: 'n.txt', size: 9, stableHits: 3 }], beforeNames: BEFORE, downloadEventFired: true, hostedFlushElapsedMs: 1000, hostedFlushMs: HF }) === 'HOSTED_FLUSH');
check('G9b zero-size → HOSTED_FLUSH', classifyDownloadFlushPhase({ sightings: [{ name: 'z.tmp', size: 0, stableHits: 3 }], beforeNames: BEFORE, downloadEventFired: true, hostedFlushElapsedMs: 1000, hostedFlushMs: HF }) === 'HOSTED_FLUSH');
// 10. no candidate → bounded failure at deadline
check('G10 no candidate, deadline → DEADLINE_EXCEEDED', classifyDownloadFlushPhase({ sightings: [], beforeNames: BEFORE, downloadEventFired: true, hostedFlushElapsedMs: HF, hostedFlushMs: HF, deadlineExceeded: true }) === 'DEADLINE_EXCEEDED');
check('G10b malformed input → DEADLINE_EXCEEDED (fail closed)', classifyDownloadFlushPhase(null) === 'DEADLINE_EXCEEDED');
// 11/12. hosted flush cancellation / deadline
check('G11 shouldContinueHostedFlush true while in phase and under bound', shouldContinueHostedFlush({ phase: 'HOSTED_FLUSH', hostedFlushElapsedMs: 1000, hostedFlushMs: HF }) === true);
check('G11b shouldContinueHostedFlush false past bound', shouldContinueHostedFlush({ phase: 'HOSTED_FLUSH', hostedFlushElapsedMs: HF, hostedFlushMs: HF }) === false);
check('G11c shouldContinueHostedFlush false outside phase (cancelled)', shouldContinueHostedFlush({ phase: 'READY', hostedFlushElapsedMs: 0, hostedFlushMs: HF }) === false);
check('G11d malformed → false (fail closed)', shouldContinueHostedFlush(null) === false);
// 13. deterministic transitions
check('G13 transition to filesystem capture when elapsed', shouldTransitionToFilesystemCapture({ downloadEventFired: true, hostedFlushElapsedMs: HF, hostedFlushMs: HF, haveCandidate: false }) === true);
check('G13b no transition while hosting', shouldTransitionToFilesystemCapture({ downloadEventFired: true, hostedFlushElapsedMs: 100, hostedFlushMs: HF, haveCandidate: false }) === false);
check('G13c transition suppressed when candidate present', shouldTransitionToFilesystemCapture({ downloadEventFired: true, hostedFlushElapsedMs: HF, hostedFlushMs: HF, haveCandidate: true }) === false);
check('G13d no event fired → immediate filesystem capture', shouldTransitionToFilesystemCapture({ downloadEventFired: false, hostedFlushElapsedMs: 0, hostedFlushMs: HF, haveCandidate: false }) === true);

// ========================================== PART H — attach mount-surface readiness (8FD)
const STO = 30000, SSET = 4000;
// 15/16. navigation starts, surface not mounted → no authoritative read (WAIT)
check('H16 surface not mounted → WAIT (no read)', classifyAttachSurfaceReadiness({ surfaceVisible: false, surfaceMounted: false, elapsedMs: 1000, timeoutMs: STO }) === 'WAIT');
// 17. surface mounts → settle begins
check('H17 surface mounted, settle incomplete → SETTLE', classifyAttachSurfaceReadiness({ surfaceVisible: true, surfaceMounted: true, elapsedMs: 1000, timeoutMs: STO, postMountElapsedMs: 500, settleMs: SSET }) === 'SETTLE');
// 18. settle incomplete → no read
check('H18 settle incomplete → SETTLE (no read)', classifyAttachSurfaceReadiness({ surfaceVisible: true, surfaceMounted: true, elapsedMs: 2000, timeoutMs: STO, postMountElapsedMs: SSET - 1, settleMs: SSET }) === 'SETTLE');
// 19. settle complete → first authoritative read allowed
check('H19 settle complete → READ', classifyAttachSurfaceReadiness({ surfaceVisible: true, surfaceMounted: true, elapsedMs: 6000, timeoutMs: STO, postMountElapsedMs: SSET, settleMs: SSET }) === 'READ');
// 25. mount timeout → bounded failure
check('H25 surface never mounts → SURFACE_TIMEOUT', classifyAttachSurfaceReadiness({ surfaceVisible: false, surfaceMounted: false, elapsedMs: STO, timeoutMs: STO }) === 'SURFACE_TIMEOUT');
check('H25b malformed → SURFACE_TIMEOUT (fail closed)', classifyAttachSurfaceReadiness(null) === 'SURFACE_TIMEOUT');
// 20-24. after the gate allows READ, hydration classification is unchanged (no bypass)
check('H20 first read clip=1 → POPULATED', classifyHydrationObservation(1, 0, MIN, false) === 'POPULATED');
check('H21 first read clip=0 → HYDRATING', classifyHydrationObservation(0, 1000, MIN, false) === 'HYDRATING');
check('H22 stable zero → HYDRATED_EMPTY', classifyHydrationObservation(0, MIN, MIN, true) === 'HYDRATED_EMPTY');
check('H23 >1 → AMBIGUOUS', classifyHydrationObservation(2, 0, MIN, false) === 'AMBIGUOUS');
check('H24 malformed → INVALID', classifyHydrationObservation(-1, 0, MIN, false) === 'INVALID');
// 26. no regression to 8EZ/8FB state machine
check('H26 mount-aware MOUNTING preserved', classifyMountAwareObservation({ mounted: false, mountElapsedMs: 1000, mountTimeoutMs: MTO }) === 'MOUNTING');
check('H26b mount-aware MOUNT_TIMEOUT preserved', classifyMountAwareObservation({ mounted: false, mountElapsedMs: MTO, mountTimeoutMs: MTO }) === 'MOUNT_TIMEOUT');
check('H26c pre-mount zero still never HYDRATED_EMPTY', classifyMountAwareObservation({ mounted: false, mountElapsedMs: 1, mountTimeoutMs: MTO, clipCount: 0, hydrationElapsedMs: MIN, minHydrationMs: MIN, zeroStable: true }) === 'MOUNTING');
check('H26d canTakeFirstAuthoritativeRead preserved', canTakeFirstAuthoritativeRead({ mounted: true, postMountElapsedMs: 0, settleMs: 4000 }) === false);

// ==================================== PART I — attach read-retry alignment (8FF)
const MAXATT = 3;
check('I1 first cold read HYDRATED_EMPTY → RETRY_READ (not final)', classifyPersistenceReadRetry(0, true, 1, MAXATT) === 'RETRY_READ');
check('I2 retry then POPULATED → PERSISTED', classifyPersistenceReadRetry(1, false, 2, MAXATT) === 'PERSISTED');
check('I3 transient zero (not hydrated) is INVALID, never empty', classifyPersistenceReadRetry(0, false, 1, MAXATT) === 'INVALID');
check('I4 stable empty on last attempt → NOT_PERSISTED', classifyPersistenceReadRetry(0, true, MAXATT, MAXATT) === 'NOT_PERSISTED');
check('I5 populated returns immediately (attempt 1)', classifyPersistenceReadRetry(1, false, 1, MAXATT) === 'PERSISTED');
check('I6 >1 → AMBIGUOUS', classifyPersistenceReadRetry(2, false, 1, MAXATT) === 'AMBIGUOUS');
check('I7 malformed → INVALID', classifyPersistenceReadRetry(-1, false, 1, MAXATT) === 'INVALID');
check('I7b non-integer attempt → INVALID', classifyPersistenceReadRetry(0, true, 0, MAXATT) === 'INVALID');
check('I8 surface never mounts → SURFACE_TIMEOUT', classifyAttachSurfaceReadiness({ surfaceVisible: false, surfaceMounted: false, elapsedMs: 30000, timeoutMs: 30000 }) === 'SURFACE_TIMEOUT');
check('I9 transient zero never HYDRATED_EMPTY (hydration)', classifyHydrationObservation(0, 1000, MIN, false) === 'HYDRATING');
check('I9b mount-aware MOUNTING preserved', classifyMountAwareObservation({ mounted: false, mountElapsedMs: 1, mountTimeoutMs: MTO }) === 'MOUNTING');
check('I9c hosted-flush phase preserved', classifyDownloadFlushPhase({ sightings: [], beforeNames: BEFORE, downloadEventFired: true, hostedFlushElapsedMs: 1000, hostedFlushMs: 45000 }) === 'HOSTED_FLUSH');

console.log(`\nTIMING-HARDENING TESTS PASSED (${passed} checks)`);