/**
 * BOUNDED project-picker asset traversal — the PURE decision model (no browser, no I/O).
 *
 * WHY THIS EXISTS (live-proven)
 * -----------------------------
 * A read-only probe of the project Add-Ingredients picker showed the DEFAULT (mixed) category
 * rendering 15 rows of which only ONE was an exact `#BGD-*` identity, and the dedicated `Images`
 * category rendering zero. The picker is VIRTUALISED: the un-scrolled first viewport is NOT a
 * complete inventory of the project's assets. The project GRID is virtualised too, so it is not a
 * substitute. Consequently a single non-scrolling read cannot satisfy the seven-background gate.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * A deterministic state machine that decides, from OBSERVED viewport states only, whether to read
 * again, scroll a bounded amount, stop, or fail closed. It is deliberately inert: it never scrolls,
 * never reads a page, and never guesses. A live adapter (NOT built yet) will perform one bounded
 * scroll/read per iteration and feed the observation back in.
 *
 * HARD GUARANTEES
 * ---------------
 *   1. Only OBSERVED exact `#BGD-*` titles ever enter the discovered set. A required identity that
 *      has not been seen is NEVER inferred from the required list, the asset count, or expectation.
 *   2. Re-observing an already-known identity is not progress.
 *   3. A viewport whose identity set was already seen, and which yields nothing new, is `STALLED` —
 *      the traversal stops instead of scrolling forever.
 *   4. At most `maxIterations` read/scroll steps and at most `maxScrollPerStep` pixels of movement
 *      per step. There is no "scroll until everything appears" mode anywhere in this module.
 *   5. `COMPLETE` requires EVERY required identity to have been observed EXACTLY. Extra `#BGD-*`
 *      tags outside the required set do not satisfy it and are reported separately.
 *   6. Exhausting the budget before the required set is complete fails closed as
 *      `BUDGET_EXHAUSTED` and names exactly what is still missing.
 */

export const PROJECT_BACKGROUND_TAG_PREFIX = '#BGD-';

/** Canonical required first-clip background identities. Exact match, no normalisation. */
export const REQUIRED_PROJECT_BACKGROUNDS = [
  '#BGD-01-ARJUN-ROOM-WIDE',
  '#BGD-02-ARJUN-ROOM-WINDOW-CLOSE',
  '#BGD-03-STREET-TO-CREMATION-WIDE',
  '#BGD-04-CREMATION-GROUND-WIDE',
  '#BGD-05-CREMATION-GROUND-PYRE-CLOSE',
  '#BGD-06-CREMATION-GROUND-STONE-CLOSE',
  '#BGD-07-ARJUN-HOME-INTERIOR-WIDE',
] as const;

/** Hard traversal limits. Deliberately small and explicit; never unbounded. */
export const PROJECT_TRAVERSAL_LIMITS = {
  /** Maximum read/scroll iterations in a single traversal. */
  maxIterations: 12,
  /** Maximum pixels of movement allowed in ONE iteration. */
  maxScrollPerStep: 600,
  /** A viewport within this many pixels of the container end counts as the end. */
  endEpsilon: 8,
} as const;

export type ProjectTraversalDecision =
  | 'DISCOVERED'
  | 'CONTINUE_SCROLL'
  | 'COMPLETE'
  | 'STALLED'
  | 'BUDGET_EXHAUSTED'
  | 'INVALID';

export interface ProjectTraversalObservation {
  /** Exact `span.asset-title` text of the currently rendered rows, in render order. */
  visibleTitles?: readonly unknown[] | null;
  /** Current scroll offset of the scrollable picker list. */
  scrollPosition?: number | null;
  /** Full scrollable extent of the list. */
  containerExtent?: number | null;
  /** Visible extent of the list viewport. */
  viewportExtent?: number | null;
  /** Set by the adapter when the list reports it cannot scroll further. */
  reachedEnd?: boolean;
}

export interface ProjectTraversalState {
  iteration: number;
  /** Exact `#BGD-*` identities observed so far, in first-seen order, de-duplicated. */
  discovered: string[];
  /** Non-`#BGD-*` titles seen, kept only for diagnostics. */
  ignoredTitles: string[];
  /** Identity-set fingerprints already observed, to detect a repeated viewport. */
  seenViewports: string[];
  /** Total pixels requested so far, for the budget audit. */
  totalScroll: number;
}

export const initialProjectTraversalState = (): ProjectTraversalState => ({
  iteration: 0,
  discovered: [],
  ignoredTitles: [],
  seenViewports: [],
  totalScroll: 0,
});

export type ProjectTraversalResult =
  | {
      ok: true;
      decision: ProjectTraversalDecision;
      /** Identities newly observed THIS iteration. */
      newIdentities: string[];
      /** Identities observed at any point so far. */
      discovered: string[];
      /** Required identities not yet observed. Empty only when `decision === 'COMPLETE'`. */
      missing: string[];
      /** Observed `#BGD-*` tags that are not in the required set. */
      unexpected: string[];
      /** The step the adapter may take next; never an unbounded scroll. */
      next: {
        shouldRead: boolean;
        shouldScroll: boolean;
        scrollBy: number;
        nextScrollPosition: number;
        iterationsRemaining: number;
      };
      state: ProjectTraversalState;
      reason: string;
    }
  | { ok: false; decision: 'INVALID'; reason: string; state: ProjectTraversalState; missing: string[]; discovered: string[] };

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Extract the exact `#BGD-*` identities from a viewport's titles. Malformed titles are ignored. */
export function extractObservedBackgroundIdentities(titles: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(titles)) return [];
  const out: string[] = [];
  for (const raw of titles) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim();
    if (!t) continue;
    // Exact prefix match: `#BGD-` plus at least one further character. A bare `#BGD-`, a `#BGD` or
    // any other sigil is NOT an identity, and a loose substring is NOT an identity.
    if (new RegExp(`^${PROJECT_BACKGROUND_TAG_PREFIX}.+`).test(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

const fingerprint = (ids: string[], titles: string[]): string =>
  `${ids.join('|')}::${titles.slice(0, 24).join('|')}`;

/**
 * PURE: fold ONE observed viewport into the traversal state and decide the next bounded step.
 *
 * `observation` describes what the adapter actually rendered. The returned `next` block is the ONLY
 * permitted action: a single bounded read and, when warranted, a single bounded scroll of at most
 * `maxScrollPerStep` pixels.
 */
export function decideProjectAssetTraversal(input: {
  state?: ProjectTraversalState | null;
  observation?: ProjectTraversalObservation | null;
  required?: readonly string[] | null;
  limits?: Partial<typeof PROJECT_TRAVERSAL_LIMITS> | null;
} | undefined | null): ProjectTraversalResult {
  const state: ProjectTraversalState = { ...initialProjectTraversalState(), ...(input?.state ?? {}) };
  const limits = { ...PROJECT_TRAVERSAL_LIMITS, ...(input?.limits ?? {}) };
  const required: string[] = [...new Set((input?.required ?? REQUIRED_PROJECT_BACKGROUNDS).map((t) => String(t).trim()).filter(Boolean))];
  const missingOf = (discovered: string[]) => required.filter((r) => !discovered.includes(r));

  const obs = input?.observation;
  const titles = Array.isArray(obs?.visibleTitles)
    ? (obs!.visibleTitles as unknown[]).filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean)
    : null;
  if (!obs || !titles) {
    return { ok: false, decision: 'INVALID', reason: 'no viewport observation was supplied; the traversal never assumes an asset exists.', state, missing: missingOf(state.discovered), discovered: [...state.discovered] };
  }
  if (!Number.isInteger(limits.maxIterations) || limits.maxIterations <= 0) {
    return { ok: false, decision: 'INVALID', reason: 'the iteration budget must be a positive integer; an unbounded traversal is never permitted.', state, missing: missingOf(state.discovered), discovered: [...state.discovered] };
  }
  if (!isFiniteNumber(limits.maxScrollPerStep) || limits.maxScrollPerStep <= 0) {
    return { ok: false, decision: 'INVALID', reason: 'the per-step scroll budget must be a positive finite number; an unbounded scroll is never permitted.', state, missing: missingOf(state.discovered), discovered: [...state.discovered] };
  }

  const observed = extractObservedBackgroundIdentities(titles);
  const ignoredTitles = titles.filter((t) => !observed.includes(t));
  const seenViewport = fingerprint(observed, titles);
  const viewportRepeated = state.seenViewports.includes(seenViewport);

  // GUARANTEE 1/2: accumulate only what was actually rendered; repeats are not progress.
  const newIdentities = observed.filter((id) => !state.discovered.includes(id));
  const discovered = [...state.discovered, ...newIdentities];
  const missing = missingOf(discovered);
  const unexpected = discovered.filter((id) => !required.includes(id));

  const nextState: ProjectTraversalState = {
    iteration: state.iteration + 1,
    discovered,
    ignoredTitles: [...new Set([...state.ignoredTitles, ...ignoredTitles])],
    seenViewports: [...state.seenViewports, seenViewport],
    totalScroll: state.totalScroll,
  };

  const scrollPos = isFiniteNumber(obs.scrollPosition) ? Math.max(0, obs.scrollPosition) : null;
  const container = isFiniteNumber(obs.containerExtent) ? Math.max(0, obs.containerExtent) : null;
  const viewport = isFiniteNumber(obs.viewportExtent) ? Math.max(0, obs.viewportExtent) : null;
  const atEndFromGeometry = container !== null && viewport !== null && scrollPos !== null
    && scrollPos + viewport >= container - limits.endEpsilon;
  const atEnd = obs.reachedEnd === true || atEndFromGeometry;

  const exhausted = nextState.iteration >= limits.maxIterations;
  const maxScrollRemaining = Math.max(0, limits.maxScrollPerStep);
  const requestedScroll = atEnd ? 0 : maxScrollRemaining;

  // An unknown scroll position is expressed as 0 so the adapter can only ever request a bounded,
  // positive step; it can never request "scroll to the very end".
  const knownScrollPosition = scrollPos ?? 0;
  const stop = (decision: ProjectTraversalDecision, reason: string, shouldScroll: boolean, scrollBy: number): ProjectTraversalResult => ({
    ok: true, decision, newIdentities, discovered: [...discovered], missing, unexpected,
    next: { shouldRead: false, shouldScroll, scrollBy, nextScrollPosition: knownScrollPosition, iterationsRemaining: Math.max(0, limits.maxIterations - nextState.iteration) },
    state: nextState, reason,
  });

  // COMPLETE requires the EXACT required set. Extra #BGD-* tags never satisfy it.
  if (missing.length === 0) {
    return stop('COMPLETE', `every one of the ${required.length} required background identity/identities was observed exactly${unexpected.length ? `; ${unexpected.length} extra #BGD-* tag(s) were observed and ignored for completeness` : ''}.`, false, 0);
  }
  // GUARANTEE 3: a repeated viewport with nothing new is a stall, not an invitation to scroll on.
  if (viewportRepeated && newIdentities.length === 0) {
    return stop('STALLED', `the viewport repeated with no newly observed identity after ${nextState.iteration} iteration(s); ${missing.length} required identity/identities are still unproven, so the traversal stops instead of scrolling further.`, false, 0);
  }
  if (newIdentities.length === 0 && !viewportRepeated && !atEnd) {
    // Progress was made in position but the row set is unchanged: report it honestly, keep going.
    if (exhausted) {
      return stop('BUDGET_EXHAUSTED', `the ${limits.maxIterations}-iteration budget ended with ${newIdentities.length} new identity/identities on the last read; still missing ${missing.join(', ')}.`, false, 0);
    }
    return { ok: true, decision: 'DISCOVERED', newIdentities, discovered: [...discovered], missing, unexpected, next: { shouldRead: true, shouldScroll: true, scrollBy: requestedScroll, nextScrollPosition: knownScrollPosition + requestedScroll, iterationsRemaining: Math.max(0, limits.maxIterations - nextState.iteration) }, state: nextState, reason: `no new identity appeared on iteration ${nextState.iteration}; scrolling a bounded ${requestedScroll}px to read the next viewport.` };
  }
  if (exhausted) {
    return stop('BUDGET_EXHAUSTED', `the ${limits.maxIterations}-iteration budget ended after ${nextState.iteration} iteration(s) with ${discovered.length}/${required.length} required identity/identities observed; still missing ${missing.join(', ')}.`, false, 0);
  }
  if (atEnd) {
    // The list reports it is fully traversed yet the required set is incomplete: fail closed and
    // name exactly what could not be proven rather than inventing it.
    return stop('STALLED', `the picker reported the end of its list after ${nextState.iteration} iteration(s) but ${missing.length} required identity/identities were never rendered (${missing.join(', ')}); the traversal stops and fails closed.`, false, 0);
  }
  return {
    ok: true,
    decision: newIdentities.length > 0 ? 'DISCOVERED' : 'CONTINUE_SCROLL',
    newIdentities, discovered: [...discovered], missing, unexpected,
    next: { shouldRead: true, shouldScroll: true, scrollBy: requestedScroll, nextScrollPosition: knownScrollPosition + requestedScroll, iterationsRemaining: Math.max(0, limits.maxIterations - nextState.iteration) },
    state: nextState,
    reason: newIdentities.length > 0
      ? `${newIdentities.length} new identity/identities observed on iteration ${nextState.iteration}; scrolling a bounded ${requestedScroll}px to read the next viewport.`
      : `scrolling a bounded ${requestedScroll}px to read the next viewport (${discovered.length}/${required.length} required observed).`,
  };
}

export type ProjectTraversalRun = {
  ok: boolean;
  decision: ProjectTraversalDecision;
  discovered: string[];
  missing: string[];
  unexpected: string[];
  iterations: number;
  totalScroll: number;
  reason: string;
};

/**
 * PURE: fold a sequence of viewport observations through the state machine, following ONLY the
 * `next` blocks the machine itself returns. No hidden scrolling, no early exit that skips the model.
 */
export function runProjectAssetTraversal(input: {
  observations: readonly ProjectTraversalObservation[];
  required?: readonly string[] | null;
  limits?: Partial<typeof PROJECT_TRAVERSAL_LIMITS> | null;
} | undefined | null): ProjectTraversalRun {
  const obs = Array.isArray(input?.observations) ? input!.observations : [];
  if (obs.length === 0) {
    return { ok: false, decision: 'INVALID', discovered: [], missing: [...(input?.required ?? REQUIRED_PROJECT_BACKGROUNDS)], unexpected: [], iterations: 0, totalScroll: 0, reason: 'no viewport observations were supplied; nothing can be proven.' };
  }
  const limits = { ...PROJECT_TRAVERSAL_LIMITS, ...(input?.limits ?? {}) };
  let state = initialProjectTraversalState();
  let last: ProjectTraversalResult = decideProjectAssetTraversal({ state, observation: null, required: input?.required, limits });
  for (const o of obs) {
    if (last.ok && last.decision === 'COMPLETE') break;
    last = decideProjectAssetTraversal({ state, observation: o, required: input?.required, limits });
    if (!last.ok) break;
    state = last.state;
    // The model's own bounded step is the ONLY movement; it is recorded for the audit trail.
    if (last.next.shouldScroll && last.next.scrollBy > 0) state = { ...state, totalScroll: state.totalScroll + last.next.scrollBy };
  }
  const discovered = last.ok ? last.discovered : last.discovered;
  const required: string[] = [...new Set((input?.required ?? REQUIRED_PROJECT_BACKGROUNDS).map((t) => String(t).trim()).filter(Boolean))];
  return {
    ok: last.ok && last.decision === 'COMPLETE',
    decision: last.decision,
    discovered,
    missing: last.missing,
    unexpected: last.ok ? last.unexpected : [],
    iterations: state.iteration,
    totalScroll: state.totalScroll,
    reason: last.reason,
  };
}
