// OFFLINE diagnostic instrumentation for the Flow asset-picker transition.
//
// Pure and browser-free: it never launches Flow, never clicks, and never touches
// the production selection path. A caller supplies a row probe (backed by the
// EXISTING picker-scoped locator in real use, or a fake in tests) and the ordered
// phases to model. It records one sample per bounded poll and reports the FIRST
// phase whose required condition never settles — so a live failure at the picker
// can be attributed to a specific phase instead of the final timeout.
//
// This module is intentionally NOT wired into FlowClient.selectAsset().

export type PickerPhase =
  | 'picker-open'
  | 'category'
  | 'category-settle'
  | 'search'
  | 'search-settle'
  | 'row-stability';

export interface PickerRowState {
  count: number;
  visible: boolean;
  enabled: boolean;
}

export interface PickerSample {
  phase: PickerPhase;
  elapsedMs: number;
  rowCount: number;
  visible: boolean;
  enabled: boolean;
}

export interface PickerPhaseSpec {
  phase: PickerPhase;
  /** Required condition for this phase. Defaults to count===1 && visible && enabled. */
  required?: (row: PickerRowState, ctx: { categoryPresent?: boolean }) => boolean;
  /** Optional Images-category probe (present/active) using the existing selector abstractions. */
  categoryPresent?: () => boolean | Promise<boolean>;
  /** Optional per-phase probe override (used by offline tests to script a phase). */
  probe?: () => Promise<PickerRowState>;
}

export interface PickerPhaseResult {
  phase: PickerPhase;
  samples: PickerSample[];
  settled: boolean;
  firstUnavailableElapsedMs: number | null;
}

export interface PickerDiagnosticResult {
  phases: PickerPhaseResult[];
  firstUnavailablePhase: PickerPhase | null;
}

export interface PickerDiagnosticOptions {
  /** Continuous hold required to consider a phase settled. */
  windowMs?: number;
  /** Bounded poll interval (not a fixed sleep). */
  intervalMs?: number;
  /** Upper bound for a single phase. */
  phaseTimeoutMs?: number;
  /** Injectable clock for deterministic offline tests. */
  now?: () => number;
  /** Injectable poll wait for deterministic offline tests. */
  sleep?: (ms: number) => Promise<void>;
}

export const defaultPickerRequired = (row: PickerRowState): boolean =>
  row.count === 1 && row.visible && row.enabled;

/**
 * Poll each phase in order using the supplied row probe, recording
 * { phase, elapsedMs, rowCount, visible, enabled } per sample. Stops at the
 * first phase that does not settle within `phaseTimeoutMs` and returns it as
 * `firstUnavailablePhase`. Never clicks, never launches a browser.
 */
export async function diagnosePickerTransition(
  specs: PickerPhaseSpec[],
  probe: () => Promise<PickerRowState>,
  options: PickerDiagnosticOptions = {},
): Promise<PickerDiagnosticResult> {
  const windowMs = options.windowMs ?? 300;
  const intervalMs = options.intervalMs ?? 50;
  const phaseTimeoutMs = options.phaseTimeoutMs ?? 5000;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const phases: PickerPhaseResult[] = [];
  let firstUnavailablePhase: PickerPhase | null = null;

  for (const spec of specs) {
    const required = spec.required ?? defaultPickerRequired;
    const samples: PickerSample[] = [];
    const phaseStart = now();
    let stableSince: number | null = null;
    let settled = false;
    let firstUnavailableElapsedMs: number | null = null;

    while (now() - phaseStart <= phaseTimeoutMs) {
      const row = await (spec.probe ?? probe)();
      const elapsedMs = now() - phaseStart;
      let categoryPresent: boolean | undefined;
      if (spec.categoryPresent) categoryPresent = await spec.categoryPresent();
      const ok = required(row, { categoryPresent });
      samples.push({ phase: spec.phase, elapsedMs, rowCount: row.count, visible: row.visible, enabled: row.enabled });
      if (ok) {
        if (stableSince === null) stableSince = now();
        if (now() - stableSince >= windowMs) { settled = true; break; }
      } else {
        if (firstUnavailableElapsedMs === null) firstUnavailableElapsedMs = elapsedMs;
        stableSince = null;
      }
      await sleep(intervalMs);
    }

    phases.push({ phase: spec.phase, samples, settled, firstUnavailableElapsedMs });
    if (!settled) {
      firstUnavailablePhase = spec.phase;
      break;
    }
  }

  return { phases, firstUnavailablePhase };
}

// ---------------------------------------------------------------------------
// Category -> search -> target transition diagnostic (offline instrumentation).
// Models ONLY: Images applied -> picker settles -> search usable -> search fill
// -> filter -> exact target row valid. Never clicks an asset row and is not
// wired into FlowClient.selectAsset().
// ---------------------------------------------------------------------------

export type CategorySearchPhase =
  | 'category-applied'
  | 'post-category-picker-settle'
  | 'search-ready'
  | 'search-filled'
  | 'post-search-filter'
  | 'target-valid';

export interface CategorySearchState {
  pickerPresent: boolean;
  searchPresent: boolean;
  searchVisible: boolean;
  searchEnabled: boolean;
  rowCount: number;
  rowVisible: boolean;
  rowEnabled: boolean;
}

export interface CategorySearchSample extends CategorySearchState {
  phase: CategorySearchPhase;
  elapsedMs: number;
}

export type CategorySearchFailure =
  | 'A-picker-rebuilt'
  | 'B-search-not-ready'
  | 'C-filter-not-settled'
  | 'D-target-absent'
  | 'E-target-invisible'
  | 'F-target-disabled'
  | 'G-not-continuous'
  | 'H-settled';

export interface CategorySearchSpec {
  phase: CategorySearchPhase;
  /** Optional per-phase probe override (used by offline tests to script a phase). */
  probe?: () => Promise<CategorySearchState>;
  /** Required condition for this phase. Defaults to defaultCategorySearchRequired[phase]. */
  required?: (state: CategorySearchState) => boolean;
}

export interface CategorySearchPhaseResult {
  phase: CategorySearchPhase;
  samples: CategorySearchSample[];
  settled: boolean;
  firstUnavailableElapsedMs: number | null;
}

export interface CategorySearchDiagnosticResult {
  phases: CategorySearchPhaseResult[];
  firstFailedPhase: CategorySearchPhase | null;
  classification: CategorySearchFailure;
}

export const defaultCategorySearchRequired: Record<CategorySearchPhase, (s: CategorySearchState) => boolean> = {
  'category-applied': (s) => s.pickerPresent,
  'post-category-picker-settle': (s) => s.pickerPresent && s.searchPresent && s.searchVisible,
  'search-ready': (s) => s.pickerPresent && s.searchPresent && s.searchVisible && s.searchEnabled,
  'search-filled': (s) => s.pickerPresent && s.searchPresent && s.searchVisible,
  'post-search-filter': (s) => s.pickerPresent && s.searchPresent,
  'target-valid': (s) => s.rowCount === 1 && s.rowVisible && s.rowEnabled,
};

type CategoryLikeSample = {
  pickerPresent: boolean;
  searchPresent: boolean;
  searchVisible: boolean;
  searchEnabled: boolean;
  rowCount: number;
  rowVisible: boolean;
  rowEnabled: boolean;
};

function classifyCategoryLikeFailure(phase: CategorySearchPhase, samples: CategoryLikeSample[]): CategorySearchFailure {
  const anyNoPicker = samples.some((s) => !s.pickerPresent);
  const anySearchNotReady = samples.some((s) => !s.searchPresent || !s.searchVisible || !s.searchEnabled);
  const anyRow = samples.some((s) => s.rowCount > 0);
  const anyVisible = samples.some((s) => s.rowCount > 0 && s.rowVisible);
  const anyEnabled = samples.some((s) => s.rowCount > 0 && s.rowVisible && s.rowEnabled);
  switch (phase) {
    case 'category-applied':
      return anyNoPicker ? 'A-picker-rebuilt' : 'A-picker-rebuilt';
    case 'post-category-picker-settle':
    case 'search-ready':
      return anySearchNotReady ? 'B-search-not-ready' : 'A-picker-rebuilt';
    case 'search-filled':
    case 'post-search-filter':
      if (!anyRow) return 'D-target-absent';
      if (!anyVisible) return 'E-target-invisible';
      if (!anyEnabled) return 'F-target-disabled';
      return 'C-filter-not-settled';
    case 'target-valid':
      if (!anyRow) return 'D-target-absent';
      if (!anyVisible) return 'E-target-invisible';
      if (!anyEnabled) return 'F-target-disabled';
      return 'G-not-continuous';
  }
}

/** Classify WHY the first failed phase failed, using only that phase's samples. */
export function classifyCategorySearchFailure(
  phase: CategorySearchPhase,
  samples: CategorySearchSample[],
): CategorySearchFailure {
  return classifyCategoryLikeFailure(phase, samples);
}

/**
 * Poll each phase in order, recording
 * { phase, elapsedMs, pickerPresent, searchPresent, searchVisible,
 *   searchEnabled, rowCount, rowVisible, rowEnabled } per sample. Re-resolves
 * the caller's probe every sample (no cached ElementHandle), tolerates transient
 * unavailability, and returns the FIRST phase that never settles plus a
 * classification (A–H). Never clicks; bounded polling only.
 */
export async function diagnoseCategorySearchTransition(
  specs: CategorySearchSpec[],
  probe: () => Promise<CategorySearchState>,
  options: PickerDiagnosticOptions = {},
): Promise<CategorySearchDiagnosticResult> {
  const windowMs = options.windowMs ?? 300;
  const intervalMs = options.intervalMs ?? 50;
  const phaseTimeoutMs = options.phaseTimeoutMs ?? 5000;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const phases: CategorySearchPhaseResult[] = [];
  let firstFailedPhase: CategorySearchPhase | null = null;

  for (const spec of specs) {
    const required = spec.required ?? defaultCategorySearchRequired[spec.phase];
    const samples: CategorySearchSample[] = [];
    const phaseStart = now();
    let stableSince: number | null = null;
    let settled = false;
    let firstUnavailableElapsedMs: number | null = null;

    while (now() - phaseStart <= phaseTimeoutMs) {
      const state = await (spec.probe ?? probe)();
      const elapsedMs = now() - phaseStart;
      samples.push({ phase: spec.phase, elapsedMs, ...state });
      if (required(state)) {
        if (stableSince === null) stableSince = now();
        if (now() - stableSince >= windowMs) { settled = true; break; }
      } else {
        if (firstUnavailableElapsedMs === null) firstUnavailableElapsedMs = elapsedMs;
        stableSince = null;
      }
      await sleep(intervalMs);
    }

    phases.push({ phase: spec.phase, samples, settled, firstUnavailableElapsedMs });
    if (!settled) { firstFailedPhase = spec.phase; break; }
  }

  const classification = firstFailedPhase
    ? classifyCategorySearchFailure(firstFailedPhase, phases[phases.length - 1].samples)
    : 'H-settled';

  return { phases, firstFailedPhase, classification };
}

// ---------------------------------------------------------------------------
// Picker lifecycle state machine (offline instrumentation).
// Establishes picker presence BEFORE inferring category/search/target state.
// Never clicks an asset row and is not wired into FlowClient.selectAsset().
// ---------------------------------------------------------------------------

export type PickerLifecyclePhase =
  | 'add-ingredients-clicked'
  | 'picker-open'
  | 'category-available'
  | 'category-applied'
  | 'post-category-picker-settle'
  | 'search-ready'
  | 'search-filled'
  | 'post-search-filter'
  | 'target-valid';

export interface PickerLifecycleState {
  addIngredientsClicked: boolean;
  pickerPresent: boolean;
  categoryPresent: boolean;
  searchPresent: boolean;
  searchVisible: boolean;
  searchEnabled: boolean;
  rowCount: number;
  rowVisible: boolean;
  rowEnabled: boolean;
}

export interface PickerLifecycleSample extends PickerLifecycleState {
  phase: PickerLifecyclePhase;
  elapsedMs: number;
}

export type PickerLifecycleFailure = 'PICKER_NOT_OPENED' | 'CATEGORY_UNAVAILABLE' | CategorySearchFailure;

export interface PickerLifecycleSpec {
  phase: PickerLifecyclePhase;
  /** Optional per-phase probe override (used by offline tests to script a phase). */
  probe?: () => Promise<PickerLifecycleState>;
  /** Required condition for this phase. Defaults to defaultPickerLifecycleRequired[phase]. */
  required?: (state: PickerLifecycleState) => boolean;
}

export interface PickerLifecyclePhaseResult {
  phase: PickerLifecyclePhase;
  samples: PickerLifecycleSample[];
  settled: boolean;
  firstUnavailableElapsedMs: number | null;
}

export interface PickerLifecycleResult {
  phases: PickerLifecyclePhaseResult[];
  firstFailedPhase: PickerLifecyclePhase | null;
  classification: PickerLifecycleFailure;
  /** Elapsed ms until the picker first became present (null if never observed). */
  pickerOpenElapsedMs: number | null;
}

export const defaultPickerLifecycleRequired: Record<PickerLifecyclePhase, (s: PickerLifecycleState) => boolean> = {
  'add-ingredients-clicked': (s) => s.addIngredientsClicked,
  'picker-open': (s) => s.pickerPresent,
  'category-available': (s) => s.pickerPresent && s.categoryPresent,
  'category-applied': (s) => s.pickerPresent,
  'post-category-picker-settle': (s) => s.pickerPresent && s.searchPresent && s.searchVisible,
  'search-ready': (s) => s.pickerPresent && s.searchPresent && s.searchVisible && s.searchEnabled,
  'search-filled': (s) => s.pickerPresent && s.searchPresent && s.searchVisible,
  'post-search-filter': (s) => s.pickerPresent && s.searchPresent,
  'target-valid': (s) => s.rowCount === 1 && s.rowVisible && s.rowEnabled,
};

/**
 * Classify a lifecycle failure. Picker presence is established FIRST: a failure
 * before/at `picker-open` is PICKER_NOT_OPENED (never category/search/target),
 * a failure at `category-available` is CATEGORY_UNAVAILABLE, and later phases
 * reuse the existing A–H category/search classifications.
 */
export function classifyPickerLifecycleFailure(
  phase: PickerLifecyclePhase,
  samples: PickerLifecycleSample[],
): PickerLifecycleFailure {
  if (phase === 'add-ingredients-clicked' || phase === 'picker-open') return 'PICKER_NOT_OPENED';
  if (phase === 'category-available') return 'CATEGORY_UNAVAILABLE';
  return classifyCategoryLikeFailure(phase as CategorySearchPhase, samples);
}

/**
 * Run the picker lifecycle state machine in order, recording per sample
 * { phase, elapsedMs, addIngredientsClicked, pickerPresent, categoryPresent,
 *   searchPresent, searchVisible, searchEnabled, rowCount, rowVisible, rowEnabled }.
 * Bounded polling only (injectable now/sleep); tolerant of transient absence;
 * stops at the first phase that never settles. Never clicks.
 */
export async function diagnosePickerLifecycle(
  specs: PickerLifecycleSpec[],
  probe: () => Promise<PickerLifecycleState>,
  options: PickerDiagnosticOptions = {},
): Promise<PickerLifecycleResult> {
  const windowMs = options.windowMs ?? 300;
  const intervalMs = options.intervalMs ?? 50;
  const phaseTimeoutMs = options.phaseTimeoutMs ?? 5000;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const phases: PickerLifecyclePhaseResult[] = [];
  let firstFailedPhase: PickerLifecyclePhase | null = null;
  let pickerOpenElapsedMs: number | null = null;

  for (const spec of specs) {
    const required = spec.required ?? defaultPickerLifecycleRequired[spec.phase];
    const samples: PickerLifecycleSample[] = [];
    const phaseStart = now();
    let stableSince: number | null = null;
    let settled = false;
    let firstUnavailableElapsedMs: number | null = null;

    while (now() - phaseStart <= phaseTimeoutMs) {
      const state = await (spec.probe ?? probe)();
      const elapsedMs = now() - phaseStart;
      samples.push({ phase: spec.phase, elapsedMs, ...state });
      if (spec.phase === 'picker-open' && pickerOpenElapsedMs === null && state.pickerPresent) pickerOpenElapsedMs = elapsedMs;
      if (required(state)) {
        if (stableSince === null) stableSince = now();
        if (now() - stableSince >= windowMs) { settled = true; break; }
      } else {
        if (firstUnavailableElapsedMs === null) firstUnavailableElapsedMs = elapsedMs;
        stableSince = null;
      }
      await sleep(intervalMs);
    }

    phases.push({ phase: spec.phase, samples, settled, firstUnavailableElapsedMs });
    if (!settled) { firstFailedPhase = spec.phase; break; }
  }

  const classification: PickerLifecycleFailure = firstFailedPhase
    ? classifyPickerLifecycleFailure(firstFailedPhase, phases[phases.length - 1].samples)
    : 'H-settled';

  return { phases, firstFailedPhase, classification, pickerOpenElapsedMs };
}
