import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Download, Locator } from 'playwright';
import { S } from './selectors.js';
import { requireBatchX1, identifyNewVideo, isVideoTileEvidence, isSingleExactMatch, classifyClipPersistence, clipPersistenceEvidence, classifyImmediateAttachment, sceneHasAnyClip, normalizeClipCount, extractArtifactIdFromUrl, extractArtifactIdsFromUrls, newArtifactIds, resolveVideoPickerArtifact, stableBaselineFromReads, classifySceneState, SceneContainsMultipleClipsError, resolveActiveRailArtifact, acceptPopulatedRailBinding, decideAssetListSettle, stableClipCountFromReads, canonicalSceneUrl, stableActiveRailFromReads, matchFlowProjectBase, classifyClipCountObservation, classifyTimelineHydrationEvidence, buildPersistenceReloadSequence, exactlyOneSelectedVideoRow, confirmTargetSelection, resolveCommittedSceneIdentity, classifySceneAttachmentIdentity, classifyPersistenceReadRetry, deriveRoutesFromMountedSceneUrl, sceneClipFilename, clipDownloadTempName, decideClipDownload, chooseDownloadMenuItem, DOWNLOAD_MENU_ITEM_ORIGINAL, extractPreviewArtifactUuid, resolvePickerCandidateByPreviewUuid, decideFirstClipAttachment, classifyFirstClipAttachment, classifyHydrationObservation, isFinalHydrationState, selectRecoverableDownload, classifyMountAwareObservation, isTerminalMountAwareState, classifyDownloadCapture, canTakeFirstAuthoritativeRead, classifyDownloadFlushPhase, shouldContinueHostedFlush, shouldTransitionToFilesystemCapture, classifyAttachSurfaceReadiness, classifyDownloadTransport, classifyDownloadOutcome, downloadObjectDiagnostic, pickerSurfaceHydration, collectPreviewArtifactUuids, decideProjectGenerationIdentity, decideRowPreviewIdentity, decideRowPreviewAction, classifyPickerSnapshotCompleteness, PICKER_TIMING, pickerBaselineBudgetMs, estimatePickerSnapshotMs, estimatePickerRowCycleMs, classifyProjectArtifactTiles, matchProjectArtifactTiles, type ProjectGenerationIdentityCode, type PickerRowPreviewProbe, type PickerRowPreviewRead } from './videoDecisions.js';
import { validateIntrinsicImage } from './imageExtract.js';
import { decideAgentToggle, decideRadioGroup, decideImageModel, FlowImageModeError, type FlowImageModeErrorCode, type FlowRadioOption } from './flowImageMode.js';
import { SCENE_LOCAL_GENERATE_CONTROLS, SCENE_CREATE_MENU, verifyIngredientEvidence, classifyIngredientEvidence, normalizeFlowCharacterToken, verifyCharacterAttachmentSelection, resolvePromptEditorCandidate, promptEditorRefusal, type CharacterAttachmentEvidence, type CharacterPickerStepDiagnostic, type PromptEditorCandidate } from './sceneLocalGeneration.js';
import { PROJECT_PROMPT_CONTROLS, resolveProjectPromptEditor, resolveNestedProjectPromptEditorSelector, renderProjectPromptReadbackFromParagraphs, flowMediaKind, deriveGeneratedSceneTitle, deriveCanonicalProjectUrl, classifyFirstClipAssetSurface, decideProjectCharactersCategory, parseProjectCharacterIdentities, PROJECT_ASSET_CATEGORY, type FirstClipSceneCandidate, type ProjectPromptEditorResolution } from './firstClipGeneration.js';
import { decideProjectCharactersCategoryFromRows, decideProjectBackgroundSource, parseProjectBackgroundIdentities, PROJECT_BACKGROUND_CATEGORY } from './projectAssetSurface.js';
import { findProjectAssetCategory, normalizeProjectAssetCategoryLabel } from './projectCategoryLabel.js';
import { FlowAssetRenameError, decideBackgroundRenameTarget, decideCharacterRenameTarget, decideGeneratedCharacterRenameTarget, isUntitledCharacterLabel, verifyBackgroundRenameOutcome, verifyCharacterRenameOutcome, verifyRenamePersistence, selectExactCharacterTileForDetail, verifyCharacterDetailIdentity, type CharacterDetailIdentityResult, type CharacterDetailNavigationEvidence, type CharacterGridReadEvidence, type CharacterGridTileObservation, type CharacterStableDomIdentity, type RenamePersistenceAsset, type RenamePersistenceReload } from './assetRenamePolicy.js';
import { resolveFlowCharacterIdFromUrl } from './flowCharacterState.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Validate a downloaded clip against the production contract (STEP-8EI).
 * Reads duration/dimensions/codecs via ffprobe. Fail-closed.
 */
async function validateDownloadedClip(file: string, ffprobePath?: string): Promise<
  { ok: true; size: number; duration: number; width: number; height: number; videoCodec: string; pixFmt: string; fps: string; audioCodec: string; sampleRate: string; channels: number; sha256: string }
  | { ok: false; result: 'INVALID_DOWNLOADED_FILE' | 'FFPROBE_FAILURE' | 'PATH_INVALID'; reason: string }
> {
  const crypto = await import('node:crypto');
  let stat;
  try { stat = await fs.promises.stat(file); } catch { return { ok: false, result: 'INVALID_DOWNLOADED_FILE', reason: `Downloaded clip does not exist: ${path.basename(file)}.` }; }
  if (!stat.isFile() || stat.size <= 0) return { ok: false, result: 'INVALID_DOWNLOADED_FILE', reason: 'Downloaded clip is empty or not a regular file.' };
  let probe: any;
  try {
    const bin = String(ffprobePath || process.env.FFPROBE_PATH || 'ffprobe').trim();
    const { stdout } = await execFileAsync(bin, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,sample_rate,channels:format=duration', '-of', 'json', file]);
    probe = JSON.parse(String(stdout));
  } catch (e: any) { return { ok: false, result: 'FFPROBE_FAILURE', reason: `ffprobe could not read the download: ${String(e?.message ?? e)}` }; }
  const streams: any[] = probe?.streams ?? [];
  const v = streams.find((x) => x.codec_type === 'video');
  const a = streams.find((x) => x.codec_type === 'audio');
  if (!v) return { ok: false, result: 'INVALID_DOWNLOADED_FILE', reason: 'Downloaded clip has no video stream.' };
  if (!a) return { ok: false, result: 'INVALID_DOWNLOADED_FILE', reason: 'Downloaded clip has no audio stream.' };
  const width = Number(v.width), height = Number(v.height);
  if (!(width >= 640) || !(height >= 360)) return { ok: false, result: 'INVALID_DOWNLOADED_FILE', reason: `Downloaded resolution ${width}x${height} is below 640x360.` };
  const duration = Number(probe?.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) return { ok: false, result: 'INVALID_DOWNLOADED_FILE', reason: `Downloaded clip has an invalid duration (${String(probe?.format?.duration)}).` };
  const buf = await fs.promises.readFile(file);
  return {
    ok: true, size: stat.size, duration: Number(duration.toFixed(3)), width, height,
    videoCodec: String(v.codec_name ?? ''), pixFmt: String(v.pix_fmt ?? ''), fps: String(v.r_frame_rate ?? ''),
    audioCodec: String(a.codec_name ?? ''), sampleRate: String(a.sample_rate ?? ''), channels: Number(a.channels ?? 0),
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  };
}

// STEP-8V generation gate: a module-scoped latch. The after-delta guard in
// generateProjectVideo() can only run once this is armed, which happens
// IMMEDIATELY AFTER the single Start click — so "after evaluated before Start" is
// structurally impossible (not merely ordered by convention).
const startGate = { armed: false };

/** The project Videos LIBRARY category, resolved by the existing normalised exact lookup. */
const PROJECT_LIBRARY_VIDEO_CATEGORY = 'Videos';

// This project keeps its Playwright browsers beside `production/`. Point
// Playwright at them (before the dynamic import below) unless the environment
// already specifies a location, so `flow` and `login` work with no shell setup.
function ensureBrowsersPath(): void {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return;
  const localBrowsers = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.playwright-browsers');
  if (fs.existsSync(localBrowsers)) process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowsers;
}

/** A freshly generated Flow character is named "Untitled character" until renamed. */
export function isUntitledCharacterName(name: string): boolean {
  return isUntitledCharacterLabel(name);
}

/**
 * A freshly loaded URL is a Flow scene-editor route when it is
 * `/project/<projectId>/<scene|edit>/<sceneId>` with UUID-like ids.
 *
 * Live-confirmed: Flow uses BOTH shapes for the same editor —
 *   /project/<id>/scene/<uuid>   (opened from the project grid)
 *   /project/<id>/edit/<uuid>    (opened from the post-generation edit surface)
 * The predicate stays narrow: a project path, one of exactly two editor
 * segments, and a UUID-like scene id. It never accepts bare `/edit/`, `/scene/`,
 * other segments, or ids from a different host/path shape.
 */
export function pageUrlIsSceneRoute(url: string): boolean {
  try {
    const parsed = new URL(String(url ?? ''));
    const path = parsed.pathname;
    return /^\/(?:u\/\d+\/)?project\/[0-9a-f-]{8,}\/(?:scene|edit)\/[0-9a-f-]{8,}$/i.test(path);
  } catch {
    return false;
  }
}

/**
 * Exact option-label matcher for Flow settings buttons.
 *
 * Flow renders some options with a LEADING Material-symbol token (live-confirmed:
 * the aspect-ratio button's text is `crop_16_916:9`). We normalize ONLY a leading
 * icon token, then require the remaining label to equal the requested value
 * EXACTLY — no substring, no fuzzy, no trailing junk, no extra digits.
 *
 *   matchesFlowOptionLabel('16:9')            -> /^\s*(?:[a-z][a-z0-9_]*_)?(?:\s*16:9\s*)\s*$/
 *   accepts: '16:9', 'crop_16_916:9'
 *   rejects: 'crop_16_94:3', 'crop_16_916:90', '116:9', 'something16:9', '16:9 extra'
 */
/**
 * EXACT option-label comparison for Flow settings buttons.
 *
 * Flow renders some options with a LEADING Material-symbol token whose name is
 * derived from the option itself, glued to the label with no separator:
 *   live: 'crop_16_916:9'  ==  icon token 'crop_16_9' + label '16:9'
 *         'crop_freeFrames' == icon token 'crop_free' + label 'Frames'
 *         'timeline_16:9'   == icon token 'timeline_' + label '16:9'
 *         'crop_16_9 16:9'  == icon token + space + label
 *
 * The label is therefore the EXACT SUFFIX of the rendered option text. Matching
 * requires the option text to end with the requested value AND, when the value is
 * preceded by more characters, that the character immediately before it is part of
 * an icon token (a letter/digit/underscore) — never arbitrary prose or punctuation.
 * This keeps exact semantics: 'crop_16_916:90' and '16:90' do NOT match '16:9',
 * 'the 16:9 ratio' does NOT match, and no substring/fuzzy matching is used.
 */
export function flowOptionLabelEquals(label: string, value: string): boolean {
  const rendered = String(label ?? '').replace(/\s+/g, ' ').trim();
  const wanted = String(value ?? '');
  if (!rendered || !wanted) return false;
  if (rendered === wanted) return true;                       // plain label
  if (!rendered.endsWith(wanted)) return false;               // must be an exact suffix
  const prefix = rendered.slice(0, rendered.length - wanted.length);
  // The prefix must be an icon token: letters/digits/underscores, ending right at the
  // label, optionally with a single trailing space. No prose, no punctuation.
  return /^[A-Za-z][A-Za-z0-9_]*(?:\s)?$/.test(prefix);
}

/** Convenience wrapper kept for callers that want a RegExp (anchored, exact). */
export function matchesFlowOptionLabel(value: string): RegExp {
  return new RegExp(`^${String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

// ---------------------------------------------------------------------------
// Bounded settings-state settling (pure state machine; no browser, no sleeps).
// The Flow Settings panel is Material button-toggle based and can report a stale
// aria-checked for a short window right after it opens (live Step-8D: configured
// within ~300ms and x1 read as unselected; Step-8F waited ~2.5s and saw "true").
// The control is exact-match only — never substring/fuzzy, never .first()/.last()
// among unrelated radios.
// ---------------------------------------------------------------------------

export type SettleOutcome = 'settled' | 'timeout';

/**
 * Poll for an option's selected state to settle, clicking it at most ONCE when it
 * is not already selected. The caller supplies the observable state (so this stays
 * browser-free); no sleeps are performed here — the caller awaits the next tick.
 *
 * - already selected on the first read  ⇒ zero clicks
 * - not selected                        ⇒ exactly one click, then poll
 * - never becomes selected              ⇒ 'timeout' (caller must fail closed)
 */
export async function settleOptionSelection(
  readSelected: () => Promise<boolean>,
  clickOnce: () => Promise<void>,
  options: { timeoutMs?: number; maxPolls?: number } = {},
): Promise<{ outcome: SettleOutcome; clicks: number; polls: number }> {
  const maxPolls = options.maxPolls ?? Math.max(1, Math.round((options.timeoutMs ?? 2000) / 60));
  let clicks = 0;
  let polls = 0;

  let selected = await readSelected();
  polls += 1;
  if (!selected) {
    await clickOnce();
    clicks += 1;
  }
  while (!selected && polls < maxPolls) {
    selected = await readSelected();
    polls += 1;
  }
  return { outcome: selected ? 'settled' : 'timeout', clicks, polls };
}

// ---------------------------------------------------------------------------------------
// PICKER CATEGORY HYDRATION (bounded, fail-closed)
// ---------------------------------------------------------------------------------------
//
// THE RACE THIS FIXES
// The media picker's PANEL becomes visible before its category TABS have rendered. A single
// immediate label read therefore observes an empty list and the acquisition path fails with
// `PICKER_UNAVAILABLE: no category label was observed` — even though the picker is perfectly
// healthy. Observed live: a clean page load succeeded, a warm page failed twice, and the only
// recovery was a full browser reload. This is a ZERO-CREDIT acquisition-side race.
//
// The distinction that matters, and is preserved exactly:
//   • panel visible + labels EMPTY      -> NOT YET RENDERED  -> bounded RETRY
//   • panel NOT visible                 -> genuinely absent  -> FAIL CLOSED immediately
//   • labels PRESENT but `wanted` absent -> genuinely malformed -> FAIL CLOSED immediately
//   • deadline exhausted while still empty                  -> FAIL CLOSED (PICKER_UNAVAILABLE)
//
// An empty label list is NEVER accepted, so validation is not weakened: the caller still has to
// resolve the exact category through `findProjectAssetCategory()`.

/** Bounded defaults. No long sleeps: 250 ms poll, 6 s ceiling, hard attempt cap. */
export const CATEGORY_LABEL_HYDRATION_DEFAULTS = {
  pollMs: 250,
  deadlineMs: 6000,
  maxAttempts: 24,
} as const;

export type CategoryLabelAction = 'ACCEPT' | 'RETRY' | 'FAIL_CLOSED';

export interface CategoryLabelObservation {
  /** True when the picker panel itself is present and has a non-zero box. */
  panelVisible: boolean;
  /** The category tab labels currently rendered. Empty means "not rendered yet". */
  labels: readonly string[];
}

/** PURE: decide one bounded read of the picker's category labels. */
export function decideCategoryLabelRead(input: {
  observation?: CategoryLabelObservation | null;
  wanted?: string;
  attempt?: number;
  maxAttempts?: number;
  /**
   * The PREVIOUS read's labels, when the driver has one. A list that repeats byte-for-byte is
   * "settled". This is what separates a still-hydrating picker from a genuinely wrong one WITHOUT
   * accepting an empty or partial list, and WITHOUT any arbitrary settling sleep.
   */
  settledLabels?: readonly string[] | null;
} | undefined | null): { action: CategoryLabelAction; reason: string } {
  // The picker renders each category with its Material icon LIGATURE glued to the human label
  // (the live form is `videocam Videos`, `drive_folder_upload Uploads`). This helper MUST therefore
  // compare on the SAME canonical form `findProjectAssetCategory()` uses, otherwise a perfectly
  // healthy, fully settled picker fails closed on `"videocam Videos" !== "Videos"`.
  //
  // The canonical normalizer is reused verbatim. Exact equality is preserved AFTER normalisation:
  // no `includes`, no `startsWith`, no substring, no case-folding, no fix-specific regex.
  const wanted = normalizeProjectAssetCategoryLabel(input?.wanted);
  if (!wanted) return { action: 'FAIL_CLOSED', reason: 'no category label was requested, or it is empty after canonical normalisation.' };

  const observation = input?.observation;
  // Genuinely unavailable / malformed: the panel is not there at all. Retrying cannot help.
  if (observation?.panelVisible !== true) {
    return { action: 'FAIL_CLOSED', reason: 'the media picker panel is not visible, so its categories cannot be read.' };
  }

  // RAW labels keep their existing role: emptiness (hydration vs rendered) and the settled check.
  const labels = Array.isArray(observation.labels)
    ? observation.labels.map((l) => String(l ?? '').trim()).filter(Boolean)
    : [];

  // NORMALISED labels are used only to decide presence. Icon-only items normalise to '' and can
  // never equal a wanted human label, so they cannot create a false positive.
  const normalizedLabels = labels.map((l) => normalizeProjectAssetCategoryLabel(l));

  // Rendered, and the exact wanted label is present: stop immediately.
  if (normalizedLabels.some((l) => l !== '' && l === wanted)) return { action: 'ACCEPT', reason: 'the requested category label is present.' };

  // A PARTIAL render (some categories present, the wanted one not yet) is still hydration in
  // progress, exactly like the zero-label case. It is retried, NOT failed. Only a SETTLED
  // category list that still lacks the wanted label is a real mismatch - and "settled" is
  // established by repeating the same list twice in a row, which the driver supplies.
  const settled = Array.isArray(input?.settledLabels)
    && input!.settledLabels!.length === labels.length
    && input!.settledLabels!.every((l, k) => l === labels[k]);
  if (labels.length > 0 && settled) {
    return { action: 'FAIL_CLOSED', reason: `the media picker rendered ${labels.length} settled categor(ies) but none matched ${JSON.stringify(wanted)}.` };
  }

  // Zero labels, or a partial render still missing the wanted one: the hydration race.
  const attempt = Math.max(1, Number(input?.attempt ?? 1));
  const maxAttempts = Math.max(1, Number(input?.maxAttempts ?? CATEGORY_LABEL_HYDRATION_DEFAULTS.maxAttempts));
  if (attempt >= maxAttempts) {
    return { action: 'FAIL_CLOSED', reason: `the media picker panel was visible but its category labels did not render after ${attempt} bounded attempt(s) within the hydration deadline.` };
  }
  return { action: 'RETRY', reason: `the media picker panel is visible but its category labels have not rendered yet (attempt ${attempt}/${maxAttempts}).` };
}

/**
 * Bounded driver: read the category labels until the wanted one is present, the panel is genuinely
 * absent, or the deadline expires. Never reloads the page, never clicks, never loops forever.
 * `read` and `sleep` are injected so the behaviour is testable offline without real delays.
 */
export async function awaitCategoryLabels(input: {
  read: () => Promise<CategoryLabelObservation>;
  wanted: string;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  deadlineMs?: number;
  maxAttempts?: number;
}): Promise<
  { ok: true; labels: string[]; attempts: number }
  | { ok: false; code: 'PICKER_UNAVAILABLE'; reason: string; attempts: number; labels: string[] }
> {
  const wanted = String(input?.wanted ?? '').trim();
  const maxAttempts = Math.max(1, Number(input?.maxAttempts ?? CATEGORY_LABEL_HYDRATION_DEFAULTS.maxAttempts));
  const deadlineMs = Math.max(0, Number(input?.deadlineMs ?? CATEGORY_LABEL_HYDRATION_DEFAULTS.deadlineMs));
  const pollMs = Math.max(0, Number(input?.pollMs ?? CATEGORY_LABEL_HYDRATION_DEFAULTS.pollMs));
  const sleep = input?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startedAt = Date.now();

  let lastLabels: string[] = [];
  let lastReason = `the media picker's ${wanted} category could not be resolved: no category label was observed.`;
  let attempts = 0;
  let previousLabels: string[] | null = null;

  // The FIRST read is immediate; short bounded intervals follow.
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    const observation = await input.read();
    const labels = Array.isArray(observation?.labels)
      ? observation.labels.map((l) => String(l ?? '').trim()).filter(Boolean)
      : [];
    lastLabels = labels;
    const decision = decideCategoryLabelRead({
      observation: { panelVisible: observation?.panelVisible === true, labels },
      wanted, attempt, maxAttempts, settledLabels: previousLabels,
    });
    if (decision.action === 'ACCEPT') return { ok: true, labels, attempts };
    lastReason = decision.reason;
    if (decision.action === 'FAIL_CLOSED') break;
    previousLabels = labels;
    if (Date.now() - startedAt >= deadlineMs) break;
    await sleep(Math.min(pollMs, Math.max(0, deadlineMs - (Date.now() - startedAt))));
  }

  return { ok: false, code: 'PICKER_UNAVAILABLE', reason: `the media picker's ${wanted} category could not be resolved: ${lastReason}`, attempts, labels: lastLabels };
}

export class FlowClient {
  /**
   * CANONICAL scene route `/project/<id>/scene/<sceneId>` captured when the scene
   * editor was opened (STEP-8AG). Persistence reopen uses THIS, never page.url()
   * after the attach/picker flow (which can leave `/edit/<sceneId>` — a surface that
   * does not render the added clip on reload).
   */
  private canonicalSceneUrl = '';
  /**
   * Validated project route `/project/<projectId>` captured with the canonical scene
   * route (STEP-8AQ). Used as the NEUTRAL intermediate navigation that forces a fresh
   * committed-scene load during persistence verification (a same-session `goto` of the
   * scene can reuse Flow's stale pre-attachment empty view — live 8AP).
   */
  private projectUrl = '';
  constructor(private page:Page, private log:(e:string,d?:any)=>void) {}
  async first(candidates: readonly string[], timeout=15000) { for (const s of candidates) { const l=this.page.locator(s).first(); try { await l.waitFor({state:'visible',timeout}); return l; } catch {} } throw new Error(`Selector not found: ${candidates.join(' | ')}`); }
  async click(candidates:readonly string[]) { await (await this.first(candidates)).click(); }
  async fill(candidates:readonly string[], text:string) { const l=await this.first(candidates); await l.fill(text); }
  // Click the first visible candidate WITHIN a specific scope (e.g. the scene
  // composer) so a transient unrelated control can never be targeted.
  private async clickWithin(scope:Locator, candidates:readonly string[], timeout=15000) {
    for (const selector of candidates) {
      const target=scope.locator(selector).first();
      try { await target.waitFor({state:'visible',timeout}); await target.click(); return; } catch { /* try next */ }
    }
    throw new Error(`Selector not found within scope: ${candidates.join(' | ')}`);
  }
  async waitComplete(timeout=300000) { await this.first(S.completed, timeout); }
  // Evidence-based completion detector for background image generation.
  // Observed real Flow behaviour while generating: "Thinking…" + "imageNN%"
  // progress text + button[aria-label="Stop"]. On success all three clear and a
  // NEW img.image tile appears. None of S.completed's candidates ever appear.
  async waitForBackgroundComplete(timeout=300000) {
    const baseline = await this.countMediaImages();
    const deadline = Date.now() + timeout;
    const anyVisible = async (candidates: readonly string[]) => {
      for (const selector of candidates) {
        try { if (await this.page.locator(selector).first().isVisible()) return true; } catch { /* transient re-render */ }
      }
      return false;
    };
    while (Date.now() < deadline) {
      const progress = await anyVisible(S.generatingProgress);
      const thinking = await anyVisible(S.generatingThinking);
      const stop = await anyVisible(S.stopButton);
      const startReady = await anyVisible(S.submit);
      const images = await this.countMediaImages();
      if (!progress && !thinking && !stop && startReady && images > baseline) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Background generation did not complete within ${Math.round(timeout / 1000)}s.`);
  }
  async countMediaImages(): Promise<number> {
    try { return await this.page.locator(S.mediaImage[0]).count(); } catch { return -1; }
  }
  /**
   * Extract an ALREADY-LOADED image element at its INTRINSIC resolution via an in-page
   * canvas (STEP-8CP; live-proven by 8CO). Returns a `data:image/png;base64,…` string
   * that the caller persists with writePngDataUrl() (filesystem concerns stay separate).
   *
   * NETWORK-FREE: draws the pixels already present in the DOM. Never fetches
   * src/currentSrc, never uses fetch/XHR/page.request/CDP, never navigates to the image.
   *
   * Fail-closed: throws for an incomplete image, zero intrinsic dimensions, a missing 2D
   * context, a tainted canvas (SecurityError), or any unexpected toDataURL failure —
   * never returns a corrupt/empty asset.
   */
  async extractImageElementIntrinsicPng(image: Locator): Promise<string> {
    const metrics = await image.evaluate((el: any) => ({ complete: el?.complete, naturalWidth: el?.naturalWidth, naturalHeight: el?.naturalHeight }));
    const valid = validateIntrinsicImage(metrics as any);
    if (!valid.ok) throw new Error(`Intrinsic image extraction refused: ${valid.reason}`);

    const result = await image.evaluate((el: any, dims: any) => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = dims.width;
        canvas.height = dims.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return { ok: false, stage: 'getContext', error: 'A 2D canvas context was unavailable.' };
        ctx.drawImage(el, 0, 0, dims.width, dims.height);
        const dataUrl = canvas.toDataURL('image/png');
        return { ok: true, dataUrl };
      } catch (e: any) {
        return { ok: false, stage: 'draw/toDataURL', errorName: String(e?.name ?? ''), error: String(e?.message ?? e) };
      }
    }, { width: valid.width, height: valid.height });

    if (!result || result.ok !== true || typeof (result as any).dataUrl !== 'string' || !(result as any).dataUrl) {
      const name = (result as any)?.errorName ? ` (${(result as any).errorName})` : '';
      const stage = (result as any)?.stage ? ` at ${(result as any).stage}` : '';
      throw new Error(`Intrinsic image extraction failed${stage}${name}: ${(result as any)?.error ?? 'no PNG data was produced.'}`);
    }
    return String((result as any).dataUrl);
  }

  async generateBackground() { await this.waitForGenerationReady(); await this.click(S.submit); await this.waitForBackgroundComplete(); }
  async prompt(text:string) { await this.fill(S.promptInput,text); }
  async generate() { await this.waitForGenerationReady(); await this.click(S.submit); await this.waitComplete(); }
  // Deterministic readiness gate before clicking Start generation: the prompt
  // editor is present, the transient Add-media menu backdrop is gone, and the
  // submit control is visible and enabled (i.e. the prompt registered).
  async waitForGenerationReady(timeout=30000) {
    await this.first(S.promptInput, timeout);
    await this.page.locator('.cdk-overlay-backdrop:visible').first().waitFor({state:'hidden', timeout});
    const submit=await this.first(S.submit, timeout);
    const deadline=Date.now()+timeout;
    while (Date.now() < deadline) {
      if (await submit.isEnabled().catch(()=>false)) return;
      await new Promise((resolve)=>setTimeout(resolve,100));
    }
    throw new Error('Start generation did not become enabled after the prompt was entered.');
  }
  /** The image/background grid tiles, in Flow's rendered order. */
  private imageTileLocator():Locator {
    return this.page.locator('flow-grid-tile-container').filter({ has: this.page.locator('img.image') });
  }
  /** Exact aria-label for every image tile, preserving index-to-tile correspondence. */
  private async imageTileSnapshot():Promise<{tiles:Locator;labels:string[]}> {
    const tiles=this.imageTileLocator();
    const count=await tiles.count();
    const labels:string[]=[];
    for (let i=0;i<count;i++) {
      labels.push(String(await tiles.nth(i).getAttribute('aria-label').catch(()=>'')).trim());
    }
    return {tiles,labels};
  }
  /** The character grid tiles, in Flow's rendered order. */
  private characterTileLocator():Locator {
    return this.page.locator(S.characterTile[0]);
  }
  /** Exact `span.character-tile-name` for every character tile, preserving index correspondence. */
  private async characterTileSnapshot():Promise<{tiles:Locator;labels:string[]}> {
    const tiles=this.characterTileLocator();
    const count=await tiles.count();
    const labels:string[]=[];
    for (let i=0;i<count;i++) {
      labels.push(String(await tiles.nth(i).locator(S.characterTileName[0]).innerText().catch(()=>'')).trim());
    }
    return {tiles,labels};
  }
  /**
   * STRICT persistence reads. Unlike the immediate snapshot helpers above, these do not
   * swallow a read error into ''. A detached/unreadable tile must become
   * PERSISTENCE_UNVERIFIABLE, never a false "target missing" success/failure decision.
   */
  private async strictImageTileLabels():Promise<string[]> {
    const tiles=this.imageTileLocator();
    const count=await tiles.count();
    const labels:string[]=[];
    for (let i=0;i<count;i++) {
      labels.push(String((await tiles.nth(i).getAttribute('aria-label')) ?? '').trim());
    }
    return labels;
  }
  private async strictCharacterTileLabels():Promise<string[]> {
    const tiles=this.characterTileLocator();
    const count=await tiles.count();
    const labels:string[]=[];
    for (let i=0;i<count;i++) {
      labels.push(String((await tiles.nth(i).locator(S.characterTileName[0]).innerText()) ?? '').trim());
    }
    return labels;
  }
  /**
   * Wait for the reloaded project route to render at least one tile of the renamed
   * asset kind. A completely empty/unreadable surface stays unverifiable; a readable
   * surface that lacks the target is a persistence failure.
   */
  private async waitForRenameSurfaceTiles(asset:RenamePersistenceAsset, timeout=20000):Promise<number> {
    const deadline=Date.now()+timeout;
    let lastCount=0;
    while (Date.now()<deadline) {
      const count=asset==='background'
        ? await this.imageTileLocator().count().catch(()=>-1)
        : await this.characterTileLocator().count().catch(()=>-1);
      lastCount=count;
      if (count>0) return count;
      await new Promise((resolve)=>setTimeout(resolve,250));
    }
    return lastCount;
  }
  /** Exact image/background tile lookup (no first-tile fallback). */
  async findImageTileByName(name:string) {
    const wanted=String(name??'').trim();
    if (!wanted) return null;
    const {tiles,labels}=await this.imageTileSnapshot();
    for (let i=0;i<labels.length;i++) if (labels[i]===wanted) return tiles.nth(i);
    return null;
  }
  // Confirmed Flow UI (verified live): Rename turns the image tile's name into an
  // INLINE editor `input.editable-text-input.editing` (aria-label "Editable text")
  // with `button[aria-label='Done']` / `button[aria-label='Cancel']` inside the
  // tile. Selectors are scoped to the tile so the wrong kebab/menu is never used.
  async renameImageTile(tile:any, name:string) {
    await tile.hover().catch(()=>{});
    const kebab=tile.locator("button[aria-label='More options']").first();
    await kebab.waitFor({state:'visible',timeout:15000});
    await kebab.click();
    await this.click(S.rename);
    // The inline editor (div.editable-text-container > input.editable-text-input.editing)
    // is rendered OUTSIDE the tile subtree, so it must be resolved at PAGE scope —
    // the same page-scoped pattern the working character rename uses.
    const editor=this.page.locator(S.characterNameInput[0]).first();
    await editor.waitFor({state:'visible',timeout:15000});
    await this.fill(S.characterNameInput,name);
    await this.click(S.characterNameConfirm);
    await editor.waitFor({state:'hidden',timeout:15000});
  }
  // Rename a generated background/image tile to its pipeline tag; verify the final
  // tile exists by name. Never silently continues on an unverified rename.
  async renameGeneratedBackground(targetName:string, currentName?:string) {
    const name=String(targetName).trim();
    await this.first(S.allMedia,20000);
    const before=await this.imageTileSnapshot();
    const decision=decideBackgroundRenameTarget({ targetName:name, currentName, observedNames:before.labels });
    if (!decision.ok) throw new FlowAssetRenameError(decision.code, decision.reason, decision.detail);
    if (decision.action==='SKIP') { this.log('rename_skip',{name,currentName:decision.currentName}); return; }

    const tile=before.tiles.nth(decision.index);
    const observedBefore=String(await tile.getAttribute('aria-label').catch(()=>'')).trim();
    if (observedBefore!==decision.currentName) {
      throw new FlowAssetRenameError(
        'BACKGROUND_RENAME_VERIFICATION_FAILED',
        `Background rename refused: the selected tile changed during preflight (expected ${JSON.stringify(decision.currentName)}, saw ${JSON.stringify(observedBefore)}).`,
      );
    }

    await this.renameImageTile(tile,name);
    const intendedLabel=String(await tile.getAttribute('aria-label').catch(()=>'')).trim();
    const after=await this.imageTileSnapshot();
    const outcome=verifyBackgroundRenameOutcome({
      targetName:name,
      expectedCurrentName:decision.currentName,
      observedNamesAfter:after.labels,
      intendedTileLabel:intendedLabel,
    });
    if (!outcome.ok) throw new FlowAssetRenameError(outcome.code, outcome.reason);
    await this.enforceRenamePersistence({
      asset:'background',
      targetName:name,
      expectedCurrentName:decision.currentName,
      preRenameNames:before.labels,
      immediateUiNames:after.labels,
      intendedTileIndex:decision.index,
    });
  }
  // After a character is generated, Flow stays on the "New character" panel.
  // Return to the project grid and rename the generated (still untitled) tile
  // via its own kebab menu, scoped so the wrong "More options" is never used.
  private async renameCharacterTile(tile:any, name:string) {
    await tile.hover().catch(()=>{});
    const kebab=tile.locator("button[aria-label='More options']").first();
    await kebab.waitFor({state:'visible',timeout:15000});
    await kebab.click();
    await this.click(S.rename);
    await this.fill(S.characterNameInput,name);
    await this.click(S.characterNameConfirm);
    await this.page.locator(S.characterNameInput[0]).first().waitFor({state:'hidden',timeout:15000}).catch(()=>{});
  }
  /**
   * Rename the newly generated character. Exactly one untitled character tile must be observable;
   * there is no fallback to the first named character. Named assets use `renameExistingCharacter`.
   */
  async renameGeneratedCharacter(name:string) {
    await this.returnToProjectGrid();
    const before=await this.characterTileSnapshot();
    const decision=decideGeneratedCharacterRenameTarget({ targetName:name, observedNames:before.labels });
    if (!decision.ok) throw new FlowAssetRenameError(decision.code, decision.reason, decision.detail);
    if (decision.action==='SKIP') { this.log('rename_skip',{name,currentName:decision.currentName}); return; }

    const tile=before.tiles.nth(decision.index);
    await this.renameCharacterTile(tile,name);
    const intendedLabel=String(await tile.locator(S.characterTileName[0]).innerText().catch(()=>'')).trim();
    const after=await this.characterTileSnapshot();
    const outcome=verifyCharacterRenameOutcome({
      targetName:name,
      expectedCurrentName:decision.currentName,
      observedNamesAfter:after.labels,
      intendedTileLabel:intendedLabel,
    });
    if (!outcome.ok) throw new FlowAssetRenameError(outcome.code, outcome.reason);
    await this.enforceRenamePersistence({
      asset:'character',
      targetName:name,
      expectedCurrentName:decision.currentName,
      preRenameNames:before.labels,
      immediateUiNames:after.labels,
      intendedTileIndex:decision.index,
    });
  }
  /**
   * Exact-target rename for an EXISTING named character. Requires the exact current title to match
   * exactly one tile before mutation. There is no untitled/first-character fallback.
   */
  async renameExistingCharacter(targetName:string, currentName:string) {
    const name=String(targetName).trim();
    await this.returnToProjectGrid();
    const before=await this.characterTileSnapshot();
    const decision=decideCharacterRenameTarget({ targetName:name, currentName, observedNames:before.labels });
    if (!decision.ok) throw new FlowAssetRenameError(decision.code, decision.reason, decision.detail);
    if (decision.action==='SKIP') { this.log('rename_skip',{name,currentName:decision.currentName}); return; }

    const tile=before.tiles.nth(decision.index);
    const observedBefore=String(await tile.locator(S.characterTileName[0]).innerText().catch(()=>'')).trim();
    if (observedBefore!==decision.currentName) {
      throw new FlowAssetRenameError(
        'CHARACTER_RENAME_VERIFICATION_FAILED',
        `Character rename refused: the selected tile changed during preflight (expected ${JSON.stringify(decision.currentName)}, saw ${JSON.stringify(observedBefore)}).`,
      );
    }

    await this.renameCharacterTile(tile,name);
    const intendedLabel=String(await tile.locator(S.characterTileName[0]).innerText().catch(()=>'')).trim();
    const after=await this.characterTileSnapshot();
    const outcome=verifyCharacterRenameOutcome({
      targetName:name,
      expectedCurrentName:decision.currentName,
      observedNamesAfter:after.labels,
      intendedTileLabel:intendedLabel,
    });
    if (!outcome.ok) throw new FlowAssetRenameError(outcome.code, outcome.reason);
    await this.enforceRenamePersistence({
      asset:'character',
      targetName:name,
      expectedCurrentName:decision.currentName,
      preRenameNames:before.labels,
      immediateUiNames:after.labels,
      intendedTileIndex:decision.index,
    });
  }
  async returnToProjectGrid() {
    // Leave the "New character" panel (route /character) back to the project grid.
    const back=this.page.locator(S.goBack[0]).first();
    try { if (await back.isVisible()) await back.click(); } catch {}
    await this.first(S.allMedia,20000);
  }
  /**
   * Force the existing supported project-route navigation and read the renamed surface
   * again. A reload/read failure is returned as UNVERIFIABLE evidence; this method never
   * converts an unreadable surface into a successful rename.
   */
  private async reloadAndReadRenameSurface(asset:RenamePersistenceAsset):Promise<RenamePersistenceReload> {
    try {
      await this.openProjectRoute();
    } catch (e:unknown) {
      return { attempted:true, completed:false, reason:`project-route reload failed: ${String((e as any)?.message ?? e)}` };
    }
    try {
      await this.first(S.allMedia,20000);
    } catch (e:unknown) {
      return { attempted:true, completed:true, surface:{ ok:false, reason:`project asset surface did not mount: ${String((e as any)?.message ?? e)}` } };
    }
    try {
      const count=await this.waitForRenameSurfaceTiles(asset,20000);
      if (count<1) {
        return { attempted:true, completed:true, surface:{ ok:false, reason:`no ${asset} tiles appeared after the project-route reload` } };
      }
      const names=asset==='background'
        ? await this.strictImageTileLabels()
        : await this.strictCharacterTileLabels();
      return { attempted:true, completed:true, surface:{ ok:true, names } };
    } catch (e:unknown) {
      return { attempted:true, completed:true, surface:{ ok:false, reason:`post-reload ${asset} surface read failed: ${String((e as any)?.message ?? e)}` } };
    }
  }
  /**
   * The durable-success gate. The immediate label check above is retained for exact-target
   * identity, but success is reported ONLY when the fresh project-route reload still shows
   * the exact target once and the old title nowhere. The commit mechanism itself is not
   * changed by this gate; it only detects persistence.
   */
  private async enforceRenamePersistence(input:{
    asset:RenamePersistenceAsset;
    targetName:string;
    expectedCurrentName:string;
    preRenameNames:readonly string[];
    immediateUiNames:readonly string[];
    intendedTileIndex:number;
  }):Promise<void> {
    const reload=await this.reloadAndReadRenameSurface(input.asset);
    const result=verifyRenamePersistence({
      asset:input.asset,
      targetName:input.targetName,
      expectedCurrentName:input.expectedCurrentName,
      preRename:{ ok:true, names:input.preRenameNames },
      immediateUi:{ ok:true, names:input.immediateUiNames },
      commitCompleted:true,
      reload,
      intendedTileIndex:input.intendedTileIndex,
    });
    this.log('rename_persistence',{
      asset:input.asset,
      status:result.status,
      code:result.code ?? null,
      targetName:input.targetName,
      expectedCurrentName:input.expectedCurrentName,
      reason:result.reason,
      ...result.detail,
    });
    if (result.status!=='PERSISTENCE_PASS') {
      const fallbackCode = input.asset==='background'
        ? 'BACKGROUND_RENAME_PERSISTENCE_UNVERIFIABLE'
        : 'CHARACTER_RENAME_PERSISTENCE_UNVERIFIABLE';
      throw new FlowAssetRenameError(result.code ?? fallbackCode, result.reason, result.detail);
    }
  }
  /** The single untitled generated character tile, or null. Never falls back to the first tile. */
  async findGeneratedCharacterTile() {
    await this.first(S.characterTile,30000);
    const {tiles,labels}=await this.characterTileSnapshot();
    const untitled=labels.map((n,i)=>isUntitledCharacterName(n)?i:-1).filter((i)=>i>=0);
    return untitled.length===1 ? tiles.nth(untitled[0]) : null;
  }
  async findCharacterTileByName(name:string) {
    const wanted=String(name??'').trim();
    if (!wanted) return null;
    const {tiles,labels}=await this.characterTileSnapshot();
    for (let i=0;i<labels.length;i++) if (labels[i]===wanted) return tiles.nth(i);
    return null;
  }
  // READ-ONLY surface listing, used to verify that an exact pipeline tag already exists in the Flow
  // project (asset lock verification). These methods never click, upload, generate or download.
  /** Exact names of every character tile currently shown in the project. */
  async listCharacterNames():Promise<string[]> {
    const tiles=this.page.locator(S.characterTile[0]);
    const count=await tiles.count().catch(()=>0);
    const names:string[]=[];
    for (let i=0;i<count;i++) {
      const name=String(await tiles.nth(i).locator(S.characterTileName[0]).innerText().catch(()=>'')).trim();
      if (name) names.push(name);
    }
    return names;
  }
  /** Exact aria-labels of every image/background tile currently shown in the project. */
  async listImageNames():Promise<string[]> {
    const tiles=this.page.locator('flow-grid-tile-container').filter({ has: this.page.locator('img.image') });
    const count=await tiles.count().catch(()=>0);
    const names:string[]=[];
    for (let i=0;i<count;i++) {
      const label=String(await tiles.nth(i).getAttribute('aria-label').catch(()=>'')).trim();
      if (label) names.push(label);
    }
    return names;
  }
  /**
   * READ-ONLY: the stable background/image asset TAGS visible on the CURRENT surface.
   *
   * REUSES the already-PROVEN scene-route rail reader (`readSceneComposerIngredientEvidence()` →
   * `button.thumbnail-button[aria-label]`) instead of introducing a new selector. Live evidence
   * showed the project grid's `listImageNames()` returns nothing on a freshly loaded project route,
   * while the scene rail was observed to expose every `#BGD-*` tag.
   *
   * Returns STABLE TAGS ONLY: no `/asb/` picker token, no chip token and no generation UUID is read,
   * returned or persisted here.
   */
  async listRailAssetTags(): Promise<string[]> {
    const evidence = await this.readSceneComposerIngredientEvidence();
    return [...new Set(evidence.railEntries.map((r) => String(r?.tag ?? '').trim()).filter(Boolean))];
  }

  /**
   * READ-ONLY: the stable CHARACTER TAGS offered by the Characters category of the ingredient
   * picker (the picker row TITLES, e.g. `@CHAR-01-ARJUN`).
   *
   * Opens the picker, switches to the Characters category and reads ONLY `span.asset-title` text. It
   * NEVER clicks an asset row, NEVER selects or attaches a character, and NEVER reads, returns or
   * persists an `/asb/` picker token — the stable title is the sole identity used. The picker is
   * always closed with Escape.
   *
   * FAIL-CLOSED BY CONSTRUCTION: a partially hydrated virtual list UNDER-reports, which surfaces as
   * a MISSING asset in `verifyAssetLocks()` — never as a false verification.
   */
  async listCharacterPickerTags(): Promise<string[]> {
    const composer = this.page.locator(S.scenePromptBox[0]).first();
    const picker = this.page.locator(S.assetPicker[0]);
    try {
      await this.clickWithin(composer, S.addIngredients);
      await picker.waitFor({ state: 'visible', timeout: 15000 });
      await this.selectAssetCategory('Characters');
      return await this.page.evaluate(() =>
        Array.from(document.querySelectorAll('flow-add-menu-popover-content button.asset-item[role="option"] span.asset-title'))
          .map((el: any) => String(el?.innerText ?? el?.textContent ?? '').trim())
          .filter(Boolean));
    } finally {
      await this.page.keyboard.press('Escape').catch(() => {});
      await picker.waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
    }
  }
  // After rename the runner is on the grid; open the exact character's detail
  // page (where voice config lives) by clicking that tile, then wait for the
  // existing voice control before configureVoice() runs.
  async openCharacterDetail(name:string) {
    await this.first(S.characterTile,30000);
    const tile=await this.findCharacterTileByName(name);
    if (!tile) throw new Error(`Character detail navigation failed: no character tile named "${name}".`);
    await tile.hover().catch(()=>{});
    await tile.locator(S.characterTileThumbnail[0]).first().click();
    await this.first(S.characterEditPage,30000);
    await this.first(S.voice,30000);
  }
  /**
   * OFFLINE-REVIEWED IDENTITY BRIDGE. Not wired into production.
   *
   * The clicked tile is chosen only from a fresh observation with exactly one exact current-name
   * match. The detail name and route ID are captured independently. The association is reported
   * proven ONLY when an actual id/data-* attribute on the clicked tile equals that route ID.
   * A matching name without that bridge stays ASSOCIATION_UNPROVEN and must not be treated as
   * authorization for a mutation.
   *
   * LIMITATION: read-only project evidence observed explicitAssetId/imageUuid/stableId all null
   * for the target character grid tile. Until Flow exposes a matching stable attribute, this method
   * is expected to stay ASSOCIATION_UNPROVEN even when the detail name matches.
   */
  async openCharacterDetailWithIdentity(currentName:string):Promise<CharacterDetailIdentityResult> {
    const expected=String(currentName??'').trim();
    let grid:CharacterGridReadEvidence;
    try {
      await this.returnToProjectGrid();
      grid=await this.readCharacterGridTilesForDetail();
    } catch (e:unknown) {
      grid={readable:false,tiles:[],reason:`character grid readiness failed: ${String((e as any)?.message ?? e)}`};
    }
    const firstSelection=selectExactCharacterTileForDetail({expectedCurrentName:expected,grid});
    if (!firstSelection.ok) {
      return verifyCharacterDetailIdentity({expectedCurrentName:expected,selection:firstSelection,navigation:{attempted:false,succeeded:false,reason:'selection failed before navigation'},detail:null});
    }
    const beforeClick=await this.readCharacterGridTilesForDetail();
    const selection=selectExactCharacterTileForDetail({expectedCurrentName:expected,grid:beforeClick});
    if (!selection.ok) {
      return verifyCharacterDetailIdentity({expectedCurrentName:expected,selection,navigation:{attempted:false,succeeded:false,reason:'selection failed immediately before click'},detail:null});
    }
    const selectedIndex=selection.selectedTileIndex;
    if (selectedIndex===null) {
      return verifyCharacterDetailIdentity({expectedCurrentName:expected,selection,navigation:{attempted:false,succeeded:false,reason:'selection exposed no clickable index'},detail:null});
    }
    let navigation:CharacterDetailNavigationEvidence={attempted:true,succeeded:false,reason:'navigation did not complete'};
    try {
      const tile=this.characterTileLocator().nth(selectedIndex);
      await tile.hover().catch(()=>{});
      await tile.locator(S.characterTileThumbnail[0]).first().click();
      await this.first(S.characterEditPage,30000);
      await this.first(S.characterDetailNameInput,30000);
      await this.first(S.voice,30000);
      navigation={attempted:true,succeeded:true};
    } catch (e:unknown) {
      navigation={attempted:true,succeeded:false,reason:`character detail navigation failed: ${String((e as any)?.message ?? e)}`};
    }
    if (!navigation.succeeded) {
      return verifyCharacterDetailIdentity({expectedCurrentName:expected,selection,navigation,detail:null});
    }
    let detailName:string|null=null;
    try {
      detailName=String(await this.page.locator(S.characterDetailNameInput[0]).first().inputValue()).trim();
    } catch {}
    const characterId=resolveFlowCharacterIdFromUrl(this.page.url());
    return verifyCharacterDetailIdentity({expectedCurrentName:expected,selection,navigation,detail:{name:detailName,characterId}});
  }
  /** Read the rendered character tiles and only the id/data-* attributes that are actually present. */
  private async readCharacterGridTilesForDetail():Promise<CharacterGridReadEvidence> {
    try {
      await this.first(S.characterTile,30000);
      const tiles=this.characterTileLocator();
      const count=await tiles.count();
      const observed:CharacterGridTileObservation[]=[];
      for (let i=0;i<count;i++) {
        const tile=tiles.nth(i);
        const displayName=String(await tile.locator(S.characterTileName[0]).innerText()).trim();
        observed.push({displayName,stableIdentityCandidates:await this.readStableCharacterTileIdentities(tile)});
      }
      return {readable:true,tiles:observed};
    } catch (e:unknown) {
      return {readable:false,tiles:[],reason:`character grid read failed: ${String((e as any)?.message ?? e)}`};
    }
  }
  /**
   * Capture actual id/data-* attributes only. No attribute name is assumed to exist. If none is
   * present, or none equals the detail route ID, the bridge remains unproven.
   */
  private async readStableCharacterTileIdentities(tile:Locator):Promise<CharacterStableDomIdentity[]> {
    const observed=await tile.evaluate((el) => Array.from(el.getAttributeNames())
      .filter((attribute) => attribute === 'id' || attribute.startsWith('data-'))
      .map((attribute) => ({attribute,value:String(el.getAttribute(attribute) ?? '').trim()}))
      .filter((entry) => entry.value.length > 0));
    return observed;
  }
  async configureVoice(voice:{gender?:string;age?:string;descriptor?:string;name?:string;voiceName?:string} = {}) {
    const requested=String(voice.voiceName??voice.name??'').trim();
    await this.first(S.characterEditPage,30000);
    await this.click(S.voice);
    const dialog=await this.first(S.voiceDialog,30000);
    if (requested) {
      const option=dialog.locator(S.voiceOption[0]).filter({hasText:requested}).first();
      if ((await option.count()) === 0) {
        const available=(await dialog.locator(S.voiceOption[0]).allInnerTexts().catch(()=>[]))
          .map((t)=>t.replace(/\s+/g,' ').trim()).slice(0,40);
        throw new Error(`Requested voice "${requested}" was not found in the Flow voice picker. Available voices: ${available.join('; ')}`);
      }
      await option.waitFor({state:'visible',timeout:15000});
      await option.click();
    }
    const performance=String(voice.descriptor??'').trim();
    if (performance) await this.fill(S.voicePerformance,performance);
    await this.click(S.voiceApply);
    await dialog.waitFor({state:'hidden',timeout:30000});
  }
  // Verify the applied voice using only the KNOWN character-detail UI: after
  // "Add to character" the voice card on the detail page renders the selected
  // voice. We assert the dialog closed and the chosen voice name is visible on
  // the detail page. When no explicit voiceName is configured there is nothing
  // reliable to assert, so verification returns false.
  async verifyVoiceApplied(voiceName:string, timeout=15000) {
    const requested=String(voiceName??'').trim();
    if (!requested) return false;
    try {
      await this.first(S.voice, timeout);
      const card=this.page.locator('.voice-card-start-btn, .voice-card').first();
      if ((await card.count()) > 0) {
        const text=String(await card.innerText().catch(()=>'')).toLowerCase();
        if (text.includes(requested.toLowerCase())) return true;
      }
    } catch { return false; }
    return false;
  }
  // Select an existing asset inside the scene composer's ingredient picker.
  // Confirmed live: a character tag ('@…') opens the picker through the composer
  // mention flow, but a background tag ('#…') is inserted as literal
  // ProseMirror text and never opens it — so backgrounds open the picker via the
  // explicit "Add ingredients" control instead. The clickable element is the
  // picker ROW (`button.asset-item[role='option']`), identified by its child
  // `span.asset-title` holding the EXACT tag text; the title span itself is
  // never clicked. All lookup is scoped to `flow-add-menu-popover-content`, so a
  // same-named project-grid media tile (`span.footer-title`) can never match.
  async selectAsset(tag:string) {
    const name=String(tag??'').trim();
    if (!name) throw new Error('selectAsset requires a non-empty asset tag.');
    const picker=this.page.locator(S.assetPicker[0]);
    // Exact, picker-scoped row lookup by the asset title. Uses CSS :has() with
    // :text-is() so the whole chain stays rooted at the picker and does NOT rely
    // on Playwright's filter({has}) re-rooting — a picker-rooted inner locator
    // becomes an impossible nested chain there (live-confirmed: filter({has})
    // resolved 0 while the row and the exact title each resolved to 1).
    const quoted=name.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
    const rowSelector=`${S.assetRow[0]}:has(${S.assetTitle[0]}:text-is("${quoted}"))`;
    const resolveRow=()=>picker.locator(S.assetList[0]).locator(rowSelector).first();
    // BOTH backgrounds and characters are attached through the SCENE-EDITOR
    // ingredient picker: the project-level picker is transient (destroyed when
    // Flow navigates into the scene editor) and the old '@' mention has no
    // editable prompt there. Wait for the scene composer, click ITS "Add
    // ingredients" button, then use the stable picker it opens.
    const composer=this.page.locator(S.scenePromptBox[0]).first();
    try { await composer.waitFor({state:'visible',timeout:20000}); }
    catch { throw new Error(`Asset selection failed: the scene editor was not open (no ${S.scenePromptBox[0]}).`); }
    await this.clickWithin(composer, S.addIngredients);
    try { await picker.waitFor({state:'visible',timeout:15000}); }
    catch { throw new Error('Asset selection failed: the scene-editor ingredient picker did not open.'); }
    if (name.startsWith('#')) {
      // Backgrounds: optionally narrow to the Images category if that control is present.
      await this.selectAssetCategory('Images');
    } else {
      // Characters: the picker is CATEGORY-STICKY (it can reopen on Images after a
      // background attach), so explicitly switch to Characters. A visible-but-
      // unclickable category or a missing category fails clearly — never silently.
      if (!(await this.selectAssetCategory('Characters'))) {
        throw new Error('Asset selection failed: the "Characters" category is unavailable in the ingredient picker.');
      }
    }
    const search=this.page.locator(S.assetSearch[0]).first();
    if (await search.isVisible().catch(()=>false)) await search.fill(name);
    const row=resolveRow();
    try { await row.waitFor({state:'visible',timeout:15000}); }
    catch { throw new Error(`Asset selection failed: "${name}" was not found in the Flow ingredient picker.`); }
    // Require exactly one matching, visible, enabled row in the scene-editor
    // picker before settling/clicking (never select an unrelated row).
    const r=resolveRow();
    if ((await r.count()) !== 1) throw new Error(`Asset selection failed: expected exactly one row for "${name}" in the scene-editor picker.`);
    if (!(await r.isVisible().catch(()=>false))) throw new Error(`Asset selection failed: the row for "${name}" is not visible in the scene-editor picker.`);
    if (!(await r.isEnabled().catch(()=>false))) throw new Error(`Asset selection failed: the row for "${name}" is disabled in the scene-editor picker.`);
    // Post-search transition phase: let Flow's Angular/CDK filter UI finish
    // before the 400ms asset-row stability guard runs.
    await this.waitForAssetSearchResultsToSettle(resolveRow);
    // Deterministic settling check: immediately after the category switch / search
    // fill the CDK virtual list can still re-render, which is what raced the
    // click in the live runs (detachment, then an unresolvable row). Confirm the
    // row stays continuously resolvable and DOM-stable before clicking.
    await this.waitForAssetRowToSettle(resolveRow);
    if (!(await picker.first().isVisible().catch(()=>false))) {
      throw new Error(`Asset selection failed: the ingredient picker closed before selecting "${name}".`);
    }
    await resolveRow().scrollIntoViewIfNeeded().catch(()=>{});
    await resolveRow().click();
    const closed=await picker.waitFor({state:'hidden',timeout:15000}).then(()=>true).catch(()=>false);
    if (!closed) {
      const selected=String(await row.getAttribute('aria-selected').catch(()=>'')).trim();
      const cls=String(await row.getAttribute('class').catch(()=>''));
      if (selected!=='true' && !cls.includes('asset-item-active')) {
        throw new Error(`Asset selection failed: picker did not close after clicking "${name}".`);
      }
    }
  }
  // -------------------------------------------------------------------------
  // Project-level VIDEO generation configuration (settings only).
  // Proven-live target: Video + Omni 1.1 Flash + 720p + 8s + 16:9 + x1.
  // Fail-closed: every value is verified and any mismatch throws. This method
  // NEVER clicks Start generation and never generates media.
  // -------------------------------------------------------------------------
  async configureVideoGeneration(
    options: { model?: string; resolution?: string; duration?: string; aspect?: string } = {},
  ): Promise<void> {
    const required = { model: options.model ?? 'Omni 1.1 Flash', resolution: options.resolution ?? '720p', duration: options.duration ?? '8s', aspect: options.aspect ?? '16:9' };

    // 0. Ensure the DETERMINISTIC STANDARD composer (Agent OFF) before configuring Video mode.
    //    Reuses the SAME Agent-OFF helper as the image path (no duplicated implementation).
    //    Fail-closed: throws FlowImageModeError if Agent cannot be disabled.
    await this.ensureStandardComposer();

    // 1. Open Settings (scoped to the known trigger selector).
    await this.click(S.settingsTrigger);
    const panel = this.page.locator('.cdk-overlay-pane').first();
    await panel.waitFor({state:'visible',timeout:15000});

    // 2. Video mode — observed UI: 'imageImage' (Image) / 'videocamVideo' (Video).
    const modeButton = (which: 'Video'|'Image') => panel.locator('button, [role="button"]').filter({hasText: which==='Video'?/videocamVideo/:/imageImage/}).first();
    if (!(await modeButton('Video').isVisible().catch(()=>false))) throw new Error('Video mode control was not found in the Flow settings panel.');
    const videoChecked = String(await modeButton('Video').getAttribute('aria-checked').catch(()=>'')).trim();
    if (videoChecked !== 'true') { await modeButton('Video').click(); await new Promise((resolve)=>setTimeout(resolve,300)); }
    if (String(await modeButton('Video').getAttribute('aria-checked').catch(()=>'')).trim() !== 'true') {
      throw new Error('Video mode could not be selected (aria-checked never became true).');
    }

    // 3. Model family — exact match only.
    const modelTrigger = panel.locator("button[aria-label='Select model family']").first();
    if (!(await modelTrigger.isVisible().catch(()=>false))) throw new Error('Model family control was not found in the Flow settings panel.');
    const currentModel = await this.readSettingsText();
    if (!new RegExp(`(^|[^\\w])${required.model.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}([^\\w]|$)`).test(currentModel)) {
      await modelTrigger.click();
      const menu = this.page.locator('.cdk-overlay-pane [role="menu"], .cdk-overlay-pane [role="listbox"]').last();
      await menu.waitFor({state:'visible',timeout:10000});
      const option = menu.locator('[role="menuitem"], [role="option"], button').filter({hasText:new RegExp(`^\\s*\\w*\\s*${required.model.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s*$`)}).first();
      if (!(await option.isVisible().catch(()=>false))) {
        const available = (await menu.locator('[role="menuitem"], [role="option"], button').allInnerTexts().catch(()=>[])).map((t)=>t.replace(/\s+/g,' ').trim()).filter(Boolean).slice(0,20);
        throw new Error(`Required model family "${required.model}" was not found. Available: ${available.join('; ')}.`);
      }
      await option.click();
      await menu.waitFor({state:'hidden',timeout:10000}).catch(()=>{});
    }

    // 4-7. Resolution, duration, aspect, batch — exact option values in the panel.
    // Flow renders some options with a leading Material-symbol token (live: the
    // aspect-ratio button's text is `crop_16_916:9`). Normalize ONLY a leading icon
    // token, then compare the remaining label EXACTLY — never substring/fuzzy.
    const optionRegex = (value: string) => matchesFlowOptionLabel(value);
    // Bounded settle (≈2s, 60ms poll): the panel can report a stale aria-checked
    // briefly after opening, so read → (at most one click) → poll until settled.
    const pollMs = 60, timeoutMs = 2000, maxPolls = Math.max(1, Math.round(timeoutMs / pollMs));
    const selectExact = async (label: string, value: string) => {
      const resolved = await this.findOptionByStrippedLabel(panel, value);
      if (!resolved) {
        // Fail closed, but report what the panel actually offered for diagnosis.
        const available = (await panel.locator('button, [role="button"]').allInnerTexts().catch(()=>[]))
          .map((t)=>t.replace(/\s+/g,' ').trim()).filter(Boolean).slice(0,30);
        throw new Error(`Required ${label} option "${value}" was not found in the Flow settings panel. Available: ${available.join('; ')}.`);
      }
      const readSelected = async () => String(await resolved.node.getAttribute('aria-checked').catch(()=>'')).trim() === 'true';
      const settled = await settleOptionSelection(readSelected, async () => { await resolved.node.click(); }, { timeoutMs, maxPolls });
      if (settled.outcome !== 'settled') {
        throw new Error(`Required ${label} option "${value}" could not be selected (aria-checked never became true).`);
      }
    };
    await selectExact('resolution', required.resolution);
    await selectExact('duration', required.duration);
    await selectExact('aspect ratio', required.aspect);

    // Batch x1 is safety-critical: never silently accept x2/x3/x4.
    const batchResolved = await this.findOptionByStrippedLabel(panel, 'x1');
    if (!batchResolved) throw new Error('Batch option "x1" was not found in the Flow settings panel.');
    const batchSettled = await settleOptionSelection(
      async () => String(await batchResolved.node.getAttribute('aria-checked').catch(()=>'')).trim() === 'true',
      async () => { await batchResolved.node.click(); },
      { timeoutMs, maxPolls },
    );
    if (batchSettled.outcome !== 'settled') {
      throw new Error('Batch x1 could not be selected; refusing to continue with a non-x1 batch.');
    }

    // 8. Verify the final configuration before returning (fail closed).
    const observed = await this.readVideoSettings();
    this.verifyFromObserved(observed, required);
  }

  /**
   * Put the PROJECT composer into the deterministic IMAGE generation configuration.
   *
   * Current Flow UI: the deterministic image path exists ONLY in the STANDARD composer
   * (Agent OFF). This method:
   *   1. turns Agent OFF (`flow-agent-mode-toggle-chip button.agent-mode-chip`, aria-pressed),
   *   2. opens `button[aria-label='Settings trigger']`,
   *   3. selects Mode=Image, Aspect ratio=16:9, Output count=x1 (scoped to their
   *      `flow-toggles[aria-label='…']` groups),
   *   4. verifies the image model family is exactly "Nano Banana 2" (fail closed otherwise;
   *      it never switches models), and
   *   5. closes the settings panel.
   *
   * Fail-closed with structured FlowImageModeError codes. It NEVER drives the Agent composer,
   * never triggers a submit, and never spends credits.
   */
  async ensureImageGenerationMode(): Promise<void> {
    // 1. Reach the STANDARD composer (Agent OFF).
    await this.turnAgentOffAndAwaitStandardComposer();

    // 2. Open the standard Settings panel (model/aspect/count live here).
    try {
      await this.click(S.settingsTrigger);
    } catch (error) {
      throw new FlowImageModeError('STANDARD_COMPOSER_UNAVAILABLE', 'The standard composer Settings trigger was not found/visible after Agent was turned off.', { cause: error });
    }

    // The Mode control proves the settings panel is up.
    try {
      await this.first(S.modeToggle, 15000);
    } catch (error) {
      throw new FlowImageModeError('IMAGE_MODE_UNAVAILABLE', 'The Flow settings panel did not expose the Mode control.', { cause: error });
    }

    // 3. Mode = Image (explicit, scoped semantic radios only).
    await this.selectRadioInGroup({ groupSelector: S.modeToggle[0], desired: 'Image', controlLabel: 'Mode', unavailableCode: 'IMAGE_MODE_UNAVAILABLE', failedCode: 'IMAGE_MODE_SELECTION_FAILED' });
    // 4. Aspect ratio = 16:9.
    await this.selectRadioInGroup({ groupSelector: S.aspectRatioToggle[0], desired: '16:9', controlLabel: 'Aspect ratio', unavailableCode: 'ASPECT_RATIO_UNAVAILABLE', failedCode: 'ASPECT_RATIO_SELECTION_FAILED' });
    // 5. Output count = x1.
    await this.selectRadioInGroup({ groupSelector: S.outputCountToggle[0], desired: 'x1', controlLabel: 'Output count', unavailableCode: 'OUTPUT_COUNT_UNAVAILABLE', failedCode: 'OUTPUT_COUNT_SELECTION_FAILED' });

    // 6. Image model family must be exactly Nano Banana 2 (never open/switch the dropdown).
    const modelButton = this.page.locator(S.imageModel[0]).first();
    const modelPresent = ((await modelButton.count().catch(() => 0)) > 0) && await modelButton.isVisible().catch(() => false);
    const modelText = modelPresent ? await modelButton.innerText().catch(() => '') : '';
    const modelDecision = decideImageModel({ present: modelPresent, text: modelText });
    if (!modelDecision.ok) throw new FlowImageModeError(modelDecision.code, modelDecision.reason);

    // 7. Close the settings panel; the composer must remain usable.
    await this.page.keyboard.press('Escape').catch(() => {});
    const modeGroup = this.page.locator(S.modeToggle[0]).first();
    const closeDeadline = Date.now() + 5000;
    while (Date.now() < closeDeadline) {
      if (!(await modeGroup.isVisible().catch(() => false))) return;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw new FlowImageModeError('STANDARD_COMPOSER_UNAVAILABLE', 'The Flow settings panel did not close; the composer may be obstructed.');
  }

  /**
   * Public, reusable guard: ensure the deterministic STANDARD composer (Agent OFF) WHEN an Agent
   * toggle exists on the current surface. Delegates to the SAME `turnAgentOffAndAwaitStandardComposer()`.
   *
   * Surfaces differ: the PROJECT-LEVEL composer has an Agent toggle; the SCENE-BUILDER does not
   * (live-verified: 0 agent-mode elements). Where no toggle exists, Agent mode is inapplicable, so
   * this is a NO-OP (the caller proceeds on the deterministic scene builder). Where a toggle IS
   * present but cannot be turned OFF, it fails closed.
   */
  async ensureStandardComposer(): Promise<void> {
    const chip = this.page.locator(S.agentModeToggle[0]).first();
    if (!(await chip.count().catch(() => 0))) return; // no Agent mode on this surface (e.g. scene-builder)
    await this.turnAgentOffAndAwaitStandardComposer();
  }

  /** Turn Agent OFF (only if ON) and wait until it reports `aria-pressed="false"`. */
  private async turnAgentOffAndAwaitStandardComposer(): Promise<void> {
    const chip = this.page.locator(S.agentModeToggle[0]).first();
    const present = ((await chip.count().catch(() => 0)) > 0) && await chip.isVisible().catch(() => false);
    const ariaPressed = present ? await chip.getAttribute('aria-pressed').catch(() => null) : null;
    const decision = decideAgentToggle({ present, ariaPressed });
    if (decision.action === 'TOGGLE_OFF') {
      try { await chip.click({ timeout: 8000 }); }
      catch (error) { throw new FlowImageModeError('AGENT_MODE_DISABLE_FAILED', 'Clicking the Agent toggle failed.', { cause: error }); }
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (String(await chip.getAttribute('aria-pressed').catch(() => '')).trim() === 'false') return;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new FlowImageModeError('AGENT_MODE_DISABLE_FAILED', 'Clicking the Agent toggle did not switch it to aria-pressed="false".');
    }
    if (decision.code) throw new FlowImageModeError(decision.code, decision.reason);
  }

  /** Read a scoped `flow-toggles` group's radios (label text + aria-checked). */
  private async readRadioOptions(group: any): Promise<FlowRadioOption[]> {
    return await group.locator("button[role='radio']").evaluateAll((els: any[]) => els.map((button) => {
      const label = button.querySelector('.toggle-text') || button.querySelector('.mat-button-toggle-label-content');
      const name = String((label ? label.textContent : button.textContent) || '').replace(/\s+/g, ' ').trim();
      return { name, checked: button.getAttribute('aria-checked') === 'true' };
    })).catch(() => []);
  }

  /** Select a required radio within a scoped `flow-toggles` group; fail closed. */
  private async selectRadioInGroup(input: { groupSelector: string; desired: string; controlLabel: string; unavailableCode: FlowImageModeErrorCode; failedCode: FlowImageModeErrorCode }): Promise<void> {
    const group = this.page.locator(input.groupSelector).first();
    const present = ((await group.count().catch(() => 0)) > 0) && await group.isVisible().catch(() => false);
    const options = present ? await this.readRadioOptions(group) : [];
    const decision = decideRadioGroup({ present, options, desired: input.desired, controlLabel: input.controlLabel, unavailableCode: input.unavailableCode });
    if (decision.state === 'UNAVAILABLE') throw new FlowImageModeError(decision.code as FlowImageModeErrorCode, decision.reason);
    if (decision.state === 'ALREADY_SELECTED') return;
    const radio = group.locator("button[role='radio']").nth(decision.index as number);
    try { await radio.click({ timeout: 8000 }); }
    catch (error) { throw new FlowImageModeError(input.failedCode, `Clicking "${input.desired}" in ${input.controlLabel} failed.`, { cause: error }); }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (String(await radio.getAttribute('aria-checked').catch(() => '')).trim() === 'true') return;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw new FlowImageModeError(input.failedCode, `Clicking "${input.desired}" in ${input.controlLabel} did not set aria-checked="true".`);
  }

  /**
   * Locate a settings option button whose rendered label corresponds EXACTLY to
   * `value`. Returns BOTH the locator (for clicking) and the node so state reads
   * (aria-checked) are performed against the same element — no unrelated radios.
   * Fail-closed: returns null when nothing matches exactly.
   */
  private async findOptionByStrippedLabel(panel: any, value: string): Promise<{ locator:any; node:any } | null> {
    const buttons = panel.locator('button, [role="button"]');
    const count = await buttons.count().catch(()=>0);
    for (let i = 0; i < count; i++) {
      const button = buttons.nth(i);
      const text = String(await button.innerText().catch(()=>'')).replace(/\s+/g,' ').trim();
      if (!text) continue;
      if (!flowOptionLabelEquals(text, value)) continue;
      if (!(await button.isVisible().catch(()=>false))) continue;
      return { locator: button, node: button };
    }
    return null;
  }

  /** Read the settings panel's plain text (used for exact model-family matching). */
  private async readSettingsText(): Promise<string> {
    return String(await this.page.locator('.cdk-overlay-pane').first().innerText().catch(()=>'')).replace(/\s+/g,' ').trim();
  }

  /**
   * Read the observed settings as explicit evidence. Batch/mode/options come from
   * aria-checked flags; the model comes from the trigger text. Pure verification
   * (no DOM) is delegated to verifyVideoGenerationConfig().
   */
  private async readVideoSettings(): Promise<{mode:string; model:string; resolution:string; duration:string; aspect:string; batch:string}> {
    const panel = this.page.locator('.cdk-overlay-pane').first();
    const checked = async (label: string, re: RegExp): Promise<string> => {
      const button = panel.locator('button, [role="button"]').filter({hasText:re}).first();
      if (!(await button.isVisible().catch(()=>false))) return '';
      const isChecked = String(await button.getAttribute('aria-checked').catch(()=>'')).trim() === 'true';
      return isChecked ? label : '';
    };
    const text = await this.readSettingsText();
    const modelMatch = text.match(/(Omni [0-9.]+ [A-Za-z]+|Veo [0-9.]+ - (?:Lite|Fast|Quality))/);
    return {
      mode: await checked('Video', /videocamVideo/),
      model: modelMatch ? modelMatch[1] : '',
      resolution: await checked('720p', /^\s*720p/),
      duration: await checked('8s', /^\s*8s/),
      aspect: await checked('16:9', /16:9/),
      batch: await checked('x1', /^\s*x1\s*$/),
    };
  }

  /** Pure, browser-free verification (single source of truth). */
  private verifyFromObserved(observed: Partial<Record<'mode'|'model'|'resolution'|'duration'|'aspect'|'batch', unknown>>, required: {model:string;resolution:string;duration:string;aspect:string}): void {
    const batch = requireBatchX1(observed.batch);
    const expect = (field: 'mode'|'model'|'resolution'|'duration'|'aspect', value: string) => {
      const actual = observed[field];
      if (typeof actual !== 'string' || actual !== value) {
        throw new Error(`Video configuration verification failed for ${field}: expected "${value}", observed ${JSON.stringify(actual ?? null)}.`);
      }
    };
    expect('mode', 'Video');
    expect('model', required.model);
    expect('resolution', required.resolution);
    expect('duration', required.duration);
    expect('aspect', required.aspect);
    if (batch !== 'x1') throw new Error('Video configuration verification failed for batch: expected "x1".');
  }

  /**
   * Configure the SCENE-COMPOSER's video generation settings.
   *
   * Surface evidence (no new selectors are guessed here):
   *   · the scene builder exposes `button.settings-trigger-button` — the SAME selector as
   *     `S.settingsTrigger[1]` and the one already recorded as
   *     `SCENE_LOCAL_GENERATE_CONTROLS.settingsTrigger`;
   *   · the settings panel is the shared `.cdk-overlay-pane` whose mode/model/resolution/
   *     duration/aspect/batch controls `configureVideoGeneration()` already drives via
   *     panel-scoped helpers (`findOptionByStrippedLabel`, `readVideoSettings`);
   *   · `ensureStandardComposer()` is a documented NO-OP on the scene builder (live-verified:
   *     0 agent-mode elements), so step 0 of `configureVideoGeneration()` is safe there.
   *
   * Therefore the existing panel-scoped configuration is COMPOSED rather than reimplemented.
   * This method never clicks the generate control and never produces media.
   */
  async configureSceneVideoGeneration(options: { model?: string; resolution?: string; duration?: string; aspect?: string } = {}): Promise<void> {
    await this.configureVideoGeneration(options);
  }

  /** Read the currently observed video settings as evidence (public, read-only wrapper). */
  async observeSceneVideoSettings(): Promise<{ mode: string; model: string; resolution: string; duration: string; aspect: string; batch: string }> {
    return this.readVideoSettings();
  }

  /**
   * Read the SCENE COMPOSER's visible text (ingredient chips included). Read-only: it never
   * clicks, fills, generates or downloads. Used to verify the exact ingredient set before
   * generation.
   */
  async readSceneComposerText(): Promise<string> {
    const box = this.page.locator(S.scenePromptBox[0]).first();
    return String(await box.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  }

  /**
   * Read the currently observed PROJECT-composer video settings as evidence (public, read-only
   * wrapper). Project-level settings are the AUTHORITATIVE generation configuration: the live
   * scene builder exposes no configurable generation controls.
   */
  async observeProjectVideoSettings(): Promise<{ mode: string; model: string; resolution: string; duration: string; aspect: string; batch: string }> {
    return this.readVideoSettings();
  }

  /**
   * Read the SCENE surface's DISPLAYED inherited settings — READ-ONLY, never clicks anything.
   *
   * Live-established: the scene builder exposes NO configurable generation controls. It only
   * DISPLAYS three values, which are exactly what this method reads:
   *   · `div.model-chip > span`               → the model (e.g. "Omni 1.1 Flash")
   *   · `button.settings-trigger-button` label → the duration summary (e.g. "8s"); the button is
   *     `display:none` but its text is still observable
   *   · `button[aria-label='Toggle aspect ratio']` → the aspect indicator (e.g. "crop_landscape16:9")
   *
   * Resolution (720p) and output count (x1) are NOT exposed on the scene surface and are never
   * asserted here — they remain project-level authoritative. Absent values return null.
   */
  async observeSceneInheritedDisplay(): Promise<{ model: string | null; duration: string | null; aspect: string | null }> {
    return this.page.evaluate(() => {
      const modelSpan = document.querySelector('div.model-chip span');
      const model = modelSpan ? String(modelSpan.textContent ?? '').trim() : null;
      const durationLabel = document.querySelector('button.settings-trigger-button .mdc-button__label');
      const duration = durationLabel ? String(durationLabel.textContent ?? '').trim() : null;
      const aspectBtn = document.querySelector("button[aria-label='Toggle aspect ratio']");
      const aspectText = aspectBtn ? String(aspectBtn.textContent ?? '').replace(/\s+/g, ' ').trim() : '';
      const aspectMatch = aspectText.match(/\d+\s*:\s*\d+/);
      const aspect = aspectMatch ? aspectMatch[0].replace(/\s+/g, '') : null;
      return { model: model || null, duration: duration || null, aspect };
    });
  }

  /**
   * Project video inventory (VIDEOS ONLY).
   *
   * IMPORTANT: descriptors here intentionally carry artifactId === '' because the
   * reloaded project-grid poster is an opaque `…/asb/ANqv…` blob with no UUID
   * (live STEP-8O). This method therefore reports TITLES/COUNT only and is used
   * for the generation-delta COUNT check — never as an identity source.
   */
  async listProjectVideos(): Promise<Array<{title:string; artifactId:string}>> {
    const descriptors = await this.page.evaluate(() => {
      const vis = (el: any) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return Array.from(document.querySelectorAll('flow-grid-tile-container'))
        .filter((tile: any) => vis(tile))
        .map((tile: any) => {
          const poster = tile.querySelector('img.thumbnail, img');
          return {
            title: String(tile.getAttribute('aria-label') ?? '').trim(),
            text: String(tile.textContent ?? ''),
            posterAlt: poster ? poster.getAttribute('alt') : null,
            posterClass: poster ? String(poster.className ?? '') : '',
            posterSrc: poster ? String(poster.getAttribute('src') ?? '') : '',
          };
        });
    }) as Array<{title:string;text:string;posterAlt:string|null;posterClass:string;posterSrc:string}>;
    // Project-grid thumbnails are opaque `/asb/` blobs with NO UUID (STEP-8O), so
    // artifactId is deliberately '' here — this list is a title/COUNT surface only.
    return descriptors
      .filter((d) => isVideoTileEvidence(d))
      .map((d) => ({ title: d.title, artifactId: '' }))
      .filter((d) => d.title.length > 0);
  }

  /**
   * Capture the set of artifact UUIDs exposed by the CURRENT (un-navigated)
   * project-level generation surface.
   *
   * Live STEP-8Q proved the generation surface renders each asset with a
   * `flow-content.google/(video|image)/<uuid>` URL and that the newly generated
   * asset appears as exactly one new UUID in the AFTER − BEFORE difference. The
   * `/asb/` poster blobs contribute nothing (STEP-8O).
   *
   * Read-only: scans every element attribute for those CDN URLs. Never navigates.
   */
  private async readGenerationSurfaceArtifactIds(): Promise<string[]> {
    const urls = await this.page.evaluate(() => {
      const out: string[] = [];
      const scan = (el: any) => {
        if (!el || !el.attributes) return;
        for (const a of el.attributes) {
          const v = String(a.value);
          if (/flow-content\.google\/(?:video|image)\//i.test(v)) {
            for (const m of v.match(/https?:\/\/[^\s"')\\]+/g) ?? []) out.push(m);
          }
        }
        const kids = el.children;
        for (let i = 0; i < kids.length; i++) scan(kids[i]);
      };
      scan(document.documentElement);
      return out;
    }) as string[];
    return extractArtifactIdsFromUrls(urls);
  }

  /**
   * EMPTY-scene video attachment (LIVE STEP-8AC; identity mechanism refreshed 8BX).
   *
   * Observed path: empty scene → `Add clip` → `Select media` dialog
   * (`div.flow-media-picker-dialog-panel`) → Videos tab (selected by default).
   *
   * IDENTITY (8BX): current Flow Videos-picker rows expose OPAQUE `/asb/…` thumbnails
   * with NO uuid in `img[src]` (live Scene-4 proof). The exact artifact is therefore
   * resolved through the picker's SHARED DETAIL-PANE PREVIEW, which exposes
   * `flow-content.google/video/<uuid>` — the same proven mechanism as
   * {@link attachFirstClipByArtifactId}. Row order and title are NEVER identity; the
   * pure preview-UUID resolver fails closed on 0 matches and on >1 ambiguous matches.
   *
   * Mutation: `Add clip` exactly ONCE, then the resolved picker's `Add media` exactly
   * ONCE. No retries, no double/force clicks.
   *
   * RACE TOLERANCE (8BX): after the single `Add media` mutation the picker may close or
   * stop rendering; that alone is NOT an attachment failure. A missing immediate clip is
   * tolerated and commit success is decided by the caller's canonical `/scene/<id>`
   * persistence verification — never by this method's best-effort immediate read.
   */
  async attachGeneratedVideoToEmptyScene(artifactId: string): Promise<{ mode: 'attached'; artifactId: string; persistent: true }> {
    const expected = String(artifactId ?? '').trim();
    if (!expected) throw new Error('attachGeneratedVideoToEmptyScene requires a non-empty generated artifact id.');

    // 1-2. Scene editor open + the timeline must be EMPTY (never modify a populated scene).
    const composer = this.page.locator(S.scenePromptBox[0]).first();
    try { await composer.waitFor({ state: 'visible', timeout: 20000 }); }
    catch { throw new Error(`Empty-scene attach failed: the scene editor was not open (no ${S.scenePromptBox[0]}).`); }
    if (await this.sceneHasClip()) {
      throw new Error('empty-scene attach refused: the scene already has a clip (never append to a populated scene).');
    }

    // 3. Add clip → Select media (exactly one click). The observed container is the
    //    media-picker dialog panel; `S.selectMediaDialog` is retained as a fallback.
    await this.click(S.addClipButton);
    const dialog = await this.waitForMediaPickerSurface();
    if (!dialog) {
      await this.page.keyboard.press('Escape').catch(() => {});
      throw new Error('Empty-scene attach failed: the "Select media" dialog did not open.');
    }

    // 5-7. Videos tab (observed as `mat-list-item[role=tab]` labelled "videocam Videos").
    const videosTab = dialog.locator('[role="tab"], mat-list-item').filter({ hasText: /Videos/ }).first();
    if (!(await videosTab.isVisible().catch(() => false))) {
      await this.page.keyboard.press('Escape').catch(() => {});
      throw new Error('Empty-scene attach failed: the Videos category is unavailable in Select media.');
    }
    if (String(await videosTab.getAttribute('aria-selected').catch(() => '')).trim() !== 'true') {
      await videosTab.click();
    }

    // 8-14. Resolve the EXACT artifact through the shared detail-pane preview UUID
    // (fail closed on 0/>1 matches; never title/order). Preview-scan clicks are
    // PREVIEW-ONLY and non-mutating.
    const resolved = await this.resolvePickerRowByPreviewUuid(expected);
    if (!resolved.ok) {
      await this.page.keyboard.press('Escape').catch(() => {});
      throw new Error(`Empty-scene attach failed: ${resolved.reason}`);
    }

    // THE ONLY MUTATION: the picker's `Add media` control, exactly once.
    const addMedia = dialog.locator('button.detail-add-to-prompt-btn').first();
    const addMediaCount = await addMedia.count().catch(() => 0);
    const decision = decideFirstClipAttachment({ previewArtifactId: expected, targetArtifactId: expected, addMediaPresent: addMediaCount === 1 });
    if (!decision.ok) {
      await this.page.keyboard.press('Escape').catch(() => {});
      throw new Error(`Empty-scene attach failed: ${decision.reason}`);
    }
    await addMedia.click();

    // 17. Immediate clip evidence is BEST-EFFORT: the picker may close/disappear right
    //     after the mutation (proven live). Do NOT classify that alone as failure — the
    //     caller's canonical persistence read is the authoritative success signal.
    await this.waitForClipEvidence(8000).catch(() => false);

    return { mode: 'attached', artifactId: expected, persistent: true };
  }

  /**
   * Locate the media-picker surface for the current Flow UI. Primary container is
   * `div.flow-media-picker-dialog-panel` (proven live); the legacy
   * `mat-dialog-container[role="dialog"]` is accepted as a compatibility fallback.
   */
  private async waitForMediaPickerSurface(timeout = 20000): Promise<Locator | null> {
    const primary = this.page.locator('div.flow-media-picker-dialog-panel').first();
    try { await primary.waitFor({ state: 'visible', timeout }); return primary; } catch { /* try legacy */ }
    const legacy = this.page.locator(S.selectMediaDialog[0]).first();
    try { await legacy.waitFor({ state: 'visible', timeout: 15000 }); return legacy; } catch { return null; }
  }

  /**
   * Bounded, deterministic wait for the Videos picker surface to HYDRATE before any
   * identity read. The current UI can render the dialog before its rows and shared
   * detail-pane `video.video-preview` exist; reading too early yields empty evidence and
   * a false "no picker row previewed the target artifact" (live Scene-4 regression).
   *
   * Read-only polling of actual DOM evidence only (no sleeps/guesses):
   *   · ≥1 visible `button.asset-item[role="option"]` row, AND
   *   · a picker `video` exposing `flow-content.google/video/<uuid>`.
   * The pure {@link pickerSurfaceHydration} decides readiness. Fails closed at the bound.
   * Identity is NEVER taken from opaque `/asb/` thumbnails.
   */
  private async waitForPickerHydration(timeoutMs = 20000, pollMs = 300): Promise<{ ok: true; previewUuid: string } | { ok: false; reason: string }> {
    const deadline = Date.now() + timeoutMs;
    let lastReason: 'NO_ROWS' | 'NO_PREVIEW' | 'INVALID' = 'INVALID';
    while (Date.now() < deadline) {
      let evidence: { rowCount: number; previewSrc: string | null } = { rowCount: 0, previewSrc: null };
      try {
        evidence = await this.page.evaluate(() => {
          const panel: any = document.querySelector('div.flow-media-picker-dialog-panel') || document.querySelector('mat-dialog-container[role="dialog"]');
          if (!panel) return { rowCount: 0, previewSrc: null };
          const vis = (el: any) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const rows = Array.from(panel.querySelectorAll('button.asset-item[role="option"]')).filter((row: any) => vis(row));
          const vids = Array.from(panel.querySelectorAll('video')) as any[];
          const v: any = vids.find((x) => /flow-content\.google\/video\//i.test(String(x.currentSrc || x.src || '')))
            || panel.querySelector('video.video-preview');
          return { rowCount: rows.length, previewSrc: v ? String(v.currentSrc || v.src || '') : null };
        });
      } catch { /* transient read failure within bounds */ }
      const hydrated = pickerSurfaceHydration(evidence);
      if (hydrated.ready) return { ok: true, previewUuid: hydrated.previewUuid };
      lastReason = hydrated.reason;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return { ok: false, reason: `The Videos picker did not hydrate within ${timeoutMs}ms (${lastReason}).` };
  }

  /**
   * READ-ONLY: the picker row's exact selection state, or `null` when it cannot be established.
   *
   * This is an INTERACTION-STATE signal ONLY. It decides whether a row may be clicked as a
   * preview action; it is NEVER, under any circumstance, treated as media identity. Identity comes
   * exclusively from the shared detail-pane `video.video-preview` src.
   *
   * `null` is returned for a missing attribute, a non-boolean value, or a failed read, so the
   * pure {@link decideRowPreviewAction} fails closed and the caller performs NO click. That is the
   * only safe default: an unknown state might be "selected", and clicking a selected row destroys
   * the detail pane that carries the only available identity.
   */
  private async readPickerRowSelectionState(row: Locator): Promise<boolean | null> {
    try {
      return await row.evaluate((el: any) => {
        const v = el?.getAttribute?.('aria-selected');
        if (v === 'true') return true;
        if (v === 'false') return false;
        return null;
      });
    } catch {
      return null;   // fail closed: an unestablished state must never lead to a click
    }
  }

  /**
   * Resolve the EXACT picker row for `expected` via the picker's shared detail-pane
   * PREVIEW uuid (`flow-content.google/video/<uuid>`), the proven 8ET/8BU identity
   * surface for the current UI where rows expose only opaque `/asb/` thumbnails.
   *
   * SELECTED-ROW CONTRACT (live-proven, zero credit). The picker auto-selects row 0 on open and
   * previews it immediately. Clicking that already-selected row is a destructive TOGGLE that
   * deselects it and DESTROYS `flow-add-menu-detail-pane`, taking `video.video-preview` — the only
   * identity surface in the app — with it. This resolver therefore never clicks a selected row:
   *   · already selected  -> READ the shared preview, no click;
   *   · not selected      -> click ONCE (preview-only), wait the proven 1200 ms settle, READ;
   *   · state unknown     -> no click at all (fail closed).
   * The pure {@link resolvePickerCandidateByPreviewUuid} still decides the outcome: 0 matches and
   * >1 matches both fail closed.
   *
   * A bounded read-only hydration wait runs FIRST so the preview/rows are not read while the
   * dialog is still mounting (the live Scene-4 regression). Identity semantics are unchanged.
   */
  private async resolvePickerRowByPreviewUuid(expected: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const target = String(expected ?? '').trim().toLowerCase();
    const hydration = await this.waitForPickerHydration();
    if (!hydration.ok) return { ok: false, reason: hydration.reason };
    const readPreview = async (): Promise<string | null> => await this.page.evaluate(() => {
      const panel = document.querySelector('div.flow-media-picker-dialog-panel') || document.querySelector('mat-dialog-container[role="dialog"]');
      if (!panel) return null;
      const vids = Array.from(panel.querySelectorAll('video')) as any[];
      const v: any = vids.find((x) => /flow-content\.google\/video\//i.test(String(x.currentSrc || x.src || ''))) || panel.querySelector('video.video-preview');
      return v ? String(v.currentSrc || v.src || '') : null;
    }).catch(() => null);

    let previewSrc = await readPreview();
    if (extractPreviewArtifactUuid(previewSrc) === target) return { ok: true };

    const rows = this.page.locator('div.flow-media-picker-dialog-panel button.asset-item[role="option"], mat-dialog-container[role="dialog"] button.asset-item[role="option"]');
    const count = await rows.count().catch(() => 0);
    const seen: string[] = [];
    for (let i = 0; i < count; i++) {
      // NEVER click an already-selected row: that toggle destroys the detail pane (and with it the
      // only identity surface). An unestablished state also performs no click.
      const selected = await this.readPickerRowSelectionState(rows.nth(i));
      const decision = decideRowPreviewAction(selected);
      const clicked = decision.ok && decision.action === 'CLICK';
      if (clicked) {
        await rows.nth(i).click().catch(() => {});
        await new Promise((r) => setTimeout(r, 1200));
      }
      previewSrc = await readPreview();
      seen.push(previewSrc ?? '');
      if (extractPreviewArtifactUuid(previewSrc) === target) break;
    }
    const resolved = resolvePickerCandidateByPreviewUuid(seen, target);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    return { ok: true };
  }

  /**
   * READ-ONLY: the shared detail-pane preview URL currently loaded in the media picker.
   * Same pane/element contract as `resolvePickerRowByPreviewUuid()` and
   * `readSceneVideoLibraryUuidsViaPreview()`. Never logs the URL.
   */
  private async readPickerPreviewUrl(): Promise<string | null> {
    return await this.page.evaluate(() => {
      const panel = document.querySelector('div.flow-media-picker-dialog-panel')
        || document.querySelector('flow-add-menu-detail-pane')
        || document.querySelector('mat-dialog-container[role="dialog"]');
      if (!panel) return null;
      const vids = Array.from(panel.querySelectorAll('video')) as any[];
      const v: any = vids.find((x) => /flow-content\.google\/video\//i.test(String(x.currentSrc || x.src || '')))
        || panel.querySelector('video.video-preview');
      return v ? String(v.currentSrc || v.src || '') : null;
    }).catch(() => null);
  }

  /**
   * RESOLVE an already-generated artifact's SIGNED media URL from the scene Videos picker.
   *
   * This is the identity half of the Flow video provider. It performs NO generation, NO scene
   * attachment, NO persistence, NO download and NO mutation of any kind: it opens the picker,
   * selects the Videos category through the EXISTING exact lookup, reuses the EXISTING guarded
   * row resolver, and returns the signed URL that the detail pane is already previewing.
   *
   * The caller must treat the returned URL as a memory-only secret: it carries signature
   * parameters. Nothing here logs it.
   */
  async resolveArtifactSignedMediaUrl(
    artifactId: string,
    options: { timeoutMs?: number; openPicker?: boolean } = {},
  ): Promise<
    { ok: true; artifactId: string; signedUrl: string }
    | { ok: false; code: 'ARTIFACT_ID_INVALID' | 'PICKER_UNAVAILABLE' | 'ARTIFACT_NOT_RESOLVED' | 'ARTIFACT_ID_MISMATCH'; reason: string }
  > {
    const target = String(artifactId ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(target)) {
      return { ok: false, code: 'ARTIFACT_ID_INVALID', reason: `the artifact id must be a 36-character uuid (got ${JSON.stringify(String(artifactId ?? '').slice(0, 48))}).` };
    }
    const timeoutMs = Math.max(1000, Number(options.timeoutMs ?? PICKER_TIMING.hydrationTimeoutMs));

    if (options.openPicker !== false) {
      // The scene editor MUST already be mounted: this is what distinguishes the real surface.
      const sceneOpen = await this.page.locator('flow-scene-builder').first().isVisible().catch(() => false)
        || await this.page.locator(S.addClipButton[0]).first().isVisible().catch(() => false);
      if (!sceneOpen) {
        return { ok: false, code: 'PICKER_UNAVAILABLE', reason: 'no scene editor is mounted, so the scene Videos picker cannot be opened; the project Add-Ingredients picker is never used as a substitute.' };
      }
      // EXACTLY the same production trigger the attach path uses. No Add Media, ever.
      await this.click(S.addClipButton);
      const panel = this.page.locator('div.flow-media-picker-dialog-panel').first();
      const opened = await panel.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
      if (!opened) return { ok: false, code: 'PICKER_UNAVAILABLE', reason: 'the scene media picker did not open.' };

      // BOUNDED hydration wait: the PANEL is visible before its category TABS render. One
      // immediate read can therefore observe zero labels on a perfectly healthy picker. Retry
      // only that specific observation, at short bounded intervals, with a hard deadline. An
      // empty label list is never accepted, and a panel that is absent — or one whose categories
      // rendered WITHOUT the wanted label — still fails closed immediately. No reload, no extra
      // click, no generation.
      const hydration = await awaitCategoryLabels({
        wanted: PROJECT_LIBRARY_VIDEO_CATEGORY,
        read: async () => await this.page.evaluate(() => {
          const panel = document.querySelector('div.flow-media-picker-dialog-panel');
          let panelVisible = false;
          if (panel) {
            const r = panel.getBoundingClientRect();
            const st = getComputedStyle(panel);
            panelVisible = r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
          }
          const labels = Array.from(
            document.querySelectorAll('mat-nav-list mat-list-item[role="tab"], [role="tablist"] [role="tab"]'),
          ).map((el: any) => String(el.innerText || '').replace(/\n/g, ' ').trim()).filter(Boolean);
          return { panelVisible, labels };
        }).catch(() => ({ panelVisible: false, labels: [] as string[] })),
      });
      if (!hydration.ok) {
        return { ok: false, code: 'PICKER_UNAVAILABLE', reason: hydration.reason };
      }
      const labels: string[] = hydration.labels;
      const videosTab = findProjectAssetCategory({ labels, wanted: PROJECT_LIBRARY_VIDEO_CATEGORY });
      if (!videosTab.ok) return { ok: false, code: 'PICKER_UNAVAILABLE', reason: `the media picker's ${PROJECT_LIBRARY_VIDEO_CATEGORY} category could not be resolved: ${videosTab.reason}` };
      const tab = this.page.locator('mat-nav-list mat-list-item[role="tab"], [role="tablist"] [role="tab"]').nth(videosTab.index);
      if (!(await tab.count())) return { ok: false, code: 'PICKER_UNAVAILABLE', reason: `the "${PROJECT_LIBRARY_VIDEO_CATEGORY}" category resolved at index ${videosTab.index} but is not present.` };
      await tab.click().catch(() => {});
      await new Promise((r) => setTimeout(r, 1400));
    }

    // EXISTING guarded resolver: never clicks an already-selected row, never assumes a row index.
    const resolved = await this.resolvePickerRowByPreviewUuid(target);
    if (!resolved.ok) return { ok: false, code: 'ARTIFACT_NOT_RESOLVED', reason: resolved.reason };

    const signedUrl = await this.readPickerPreviewUrl();
    const observed = extractPreviewArtifactUuid(signedUrl);
    if (!signedUrl) return { ok: false, code: 'ARTIFACT_NOT_RESOLVED', reason: 'the media picker exposed no preview URL after the target row was selected.' };
    if (observed !== target) {
      return { ok: false, code: 'ARTIFACT_ID_MISMATCH', reason: `the selected picker row previews a different artifact than requested (expected ${target}, observed ${observed ?? 'none'}); refusing to fetch.` };
    }
    return { ok: true, artifactId: target, signedUrl };
  }

  /**
   * LEGACY / COMPAT (pre-8BX): row locator by `img[src*="<uuid>"]`. Current Flow
   * Videos rows expose opaque `/asb/` thumbnails, so the canonical empty-scene path
   * (8BX) no longer uses this — it resolves identity through the shared preview UUID.
   * Retained for compatibility; `resolveVideoPickerArtifact` and the pure helpers are
   * still exported and unit-tested.
   */
  private videoRowLocator(dialog: Locator, expected: string): Locator {
    return dialog
      .locator('cdk-virtual-scroll-viewport.asset-list-viewport button.asset-item[role="option"], cdk-virtual-scroll-viewport[aria-label="Asset list"] button.asset-item[role="option"]')
      .filter({ has: this.page.locator(`img[src*="${expected}"]`) });
  }

  /** Read every rendered Videos row's exact artifact id + selected state (STEP-8AY). */
  private async readVideoRows(dialog: Locator): Promise<Array<{ artifactId: string; selected: boolean }>> {
    void dialog;   // rows are read from the current DOM; the dialog scope is verified by the caller
    return (await this.page.evaluate(() => {
      const vis = (el: any) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const vp: any = document.querySelector('cdk-virtual-scroll-viewport.asset-list-viewport[role="listbox"], cdk-virtual-scroll-viewport[aria-label="Asset list"]');
      if (!vp) return [];
      const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      return Array.from(vp.querySelectorAll('button.asset-item[role="option"]')).filter(vis).map((row: any) => {
        const img: any = row.querySelector('img');
        const src = String(img?.getAttribute('src') || img?.currentSrc || '');
        const m = src.match(uuidRe);
        return { artifactId: m ? m[0] : '', selected: String(row.getAttribute('aria-selected') || '').trim() === 'true' };
      });
    })) as Array<{ artifactId: string; selected: boolean }>;
  }

  /**
   * Bounded poll until the exact target artifact is the SINGLE selected Videos row
   * (STEP-8AY). Uses only `aria-selected` + the exact UUID from the child image. Fails
   * closed on malformed evidence or multiple selected rows; times out otherwise. The
   * caller ALWAYS re-resolves the row before the confirmation click.
   */
  private async waitForVideoTargetSelection(targetArtifactId: string, dialog: Locator, timeoutMs = 5000, intervalMs = 100): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await dialog.isVisible().catch(() => false))) return false;
      const rows = await this.readVideoRows(dialog).catch(() => [] as Array<{ artifactId: string; selected: boolean }>);
      const selected = exactlyOneSelectedVideoRow(rows);
      if (selected.ok && confirmTargetSelection(targetArtifactId, selected.selectedArtifactId)) return true;
      // `!selected.ok` (0 or >1 selected) is not progress → keep polling within bounds.
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
  }

  /**
   * Bounded settle for the empty-scene Videos asset list (LIVE STEP-8AE).
   *
   * Polls the rendered asset rows until EXACTLY ONE exposes the expected artifact
   * uuid; returns 'ready', or 'ambiguous' (a second match appeared) / 'timeout'.
   * Never waits for "row count to stop changing" (a stale list is stable too), and
   * never depends on row index/count/title. The caller re-verifies the dialog and
   * re-resolves the row before clicking.
   */
  private async waitForVideoAssetRow(
    expected: string,
    dialog: Locator,
    timeoutMs = 20000,
    intervalMs = 350,
  ): Promise<'ready' | 'timeout' | 'ambiguous'> {
    const deadline = Date.now() + timeoutMs;
    let lastCount = -1;
    while (Date.now() < deadline) {
      // The dialog must remain open; a vanished dialog is not a hydration delay.
      if (!(await dialog.isVisible().catch(() => false))) return 'timeout';
      const rows = (await this.page.evaluate(() => {
        const vis = (el: any) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const viewport: any = document.querySelector('cdk-virtual-scroll-viewport.asset-list-viewport[role="listbox"], cdk-virtual-scroll-viewport[aria-label="Asset list"]');
        if (!viewport) return [];
        return Array.from(viewport.querySelectorAll('button.asset-item[role="option"]'))
          .filter((row: any) => vis(row))
          .map((row: any) => {
            const img: any = row.querySelector('img');
            return { imgSrc: String(img?.getAttribute('src') || img?.currentSrc || '') };
          });
      })) as Array<{ imgSrc: string }>;

      const verdict = resolveVideoPickerArtifact(expected, rows);
      const decision = decideAssetListSettle(verdict.kind === 'ok' ? 1 : verdict.kind === 'none' ? 0 : 2);
      if (decision === 'ready') return 'ready';
      if (decision === 'ambiguous') return 'ambiguous';
      if (rows.length !== lastCount) lastCount = rows.length;   // diagnostics only
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return 'timeout';
  }

  /**
   * POPULATED single-clip verification (LIVE STEP-8AA, evidence-backed).
   *
   * Observed DOM: `flow-navigation-rail button.thumbnail-button.active[aria-current="true"]
   *   > img.thumbnail-image[src="flow-content.google/image/<uuid>"]`.
   *
   * FAIL CLOSED (never assume) when:
   *   - not exactly one active rail item
   *   - the active item exposes no uuid / more than one uuid
   *   - the active rail uuid does NOT exactly equal the expected generation artifact
   *     (live 8Y/8Z/8AB: the two surfaces can legitimately differ for one video)
   *
   * Never clicks Add Clip, never opens Select media, never clicks a rail item.
   */
  async verifyPopulatedSceneMedia(expectedArtifactId: string): Promise<{ mode: 'already-populated'; railArtifactId: string; active: true }> {
    // Bounded hydration settle (LIVE STEP-8AI): read ONCE was a race — the rail can
    // expose no `aria-current` item while the scene hydrates, then exactly one later.
    const settled = await this.waitForStableActiveRailArtifact();
    if (settled.kind === 'ambiguous') throw new Error(`Populated-scene verification failed: ${settled.reason}`);
    if (settled.kind !== 'ok') throw new Error('Populated-scene verification failed: the navigation rail exposed no active current-media artifact id within the hydration timeout.');

    // A stable active uuid is NOT sufficient — it must exactly equal the expected
    // generation artifact (existing exact identity mechanism; never title/order).
    const binding = acceptPopulatedRailBinding(expectedArtifactId, settled.artifactId);
    if (!binding.accepted) throw new Error(`Populated-scene verification failed: ${binding.reason}`);

    return { mode: 'already-populated', railArtifactId: settled.artifactId, active: true };
  }

  /** Snapshot the rail's active-item count + single active artifact id (STEP-8AJ). */
  private async readActiveRailSnapshot(): Promise<{ activeCount: number; artifactId: string }> {
    const items = await this.page.evaluate(() => {
      const rail: any = document.querySelector('flow-navigation-rail');
      if (!rail) return [];
      return Array.from(rail.querySelectorAll('flow-navigation-rail-thumbnail')).map((it: any) => {
        const btn: any = it.querySelector('button.thumbnail-button') || it.querySelector('button');
        const img: any = it.querySelector('img.thumbnail-image, img');
        return { ariaCurrent: btn ? btn.getAttribute('aria-current') : null, imgSrc: String(img?.getAttribute('src') || img?.currentSrc || '') };
      });
    }) as Array<{ ariaCurrent: string | null; imgSrc: string }>;
    const activeCount = items.filter((it) => String(it.ariaCurrent ?? '').trim() === 'true').length;
    const resolved = resolveActiveRailArtifact(items);
    return { activeCount, artifactId: resolved.kind === 'ok' ? resolved.artifactId : '' };
  }

  /**
   * Bounded settle for the populated-scene active rail artifact (STEP-8AJ).
   * Polls `readActiveRailSnapshot()` until the last `requiredStable` reads agree on a
   * non-empty active uuid; returns 'ok' / 'pending' (timeout) / 'ambiguous'. An initial
   * "no active uuid" simply keeps polling (scene hydrating). Never unbounded.
   */
  private async waitForStableActiveRailArtifact(timeoutMs = 20000, intervalMs = 500, requiredStable = 2): Promise<{ kind: 'ok'; artifactId: string } | { kind: 'pending' } | { kind: 'ambiguous'; reason: string }> {
    const deadline = Date.now() + timeoutMs;
    const reads: Array<{ activeCount: number; artifactId: string }> = [];
    while (Date.now() < deadline) {
      try { reads.push(await this.readActiveRailSnapshot()); } catch { /* transient read: retry */ }
      const verdict = stableActiveRailFromReads(reads, requiredStable);
      if (verdict.kind === 'ok' || verdict.kind === 'ambiguous') return verdict;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return { kind: 'pending' };
  }

  /**
   * READ-ONLY: the COMMITTED canonical scene artifact id for the currently open scene, or null.
   *
   * This is the SAME identity `reconcileGeneratedVideoWithScene()` reports as
   * `committedSceneArtifactId` — it reuses the existing settled active-rail reader, adding no new
   * selector logic. It is deliberately DISTINCT from the generation artifact id: attaching a
   * generated video to an empty scene mints a new scene artifact id.
   *
   * Returns null (never a fabricated or derived value) when the rail exposes no single stable
   * active artifact, so callers can record provenance only when it is genuinely known.
   */
  async readCommittedSceneArtifactId(): Promise<string | null> {
    const settled = await this.waitForStableActiveRailArtifact();
    if (settled.kind !== 'ok') return null;
    const committed = resolveCommittedSceneIdentity(settled.artifactId);
    return committed.ok ? committed.artifactId : null;
  }

  /** Backwards-compatible shim retained for callers that only need the picker read. */
  async readVideoPickerArtifact(artifactId: string): Promise<string> {
    const expected = String(artifactId ?? '').trim();
    if (!expected) throw new Error('readVideoPickerArtifact requires a non-empty artifact id.');
    const result = await this.attachGeneratedVideoToEmptyScene(expected);
    return result.artifactId;
  }

  /** Backwards-compatible shim: reconcile now owns identity; returns the expected id. */
  async readGeneratedVideoArtifact(artifactId: string): Promise<string> {
    return String(artifactId ?? '').trim();
  }

  /**
   * Wait for the generation surface to STABILIZE, then return the stable BEFORE
   * artifact-UUID set (STEP-8V).
   *
   * Live STEP-8U: on a freshly-opened project page the CDK virtual-scroll grid is
   * still hydrating, so the FIRST read can be incomplete; a later read then sees
   * MORE pre-existing UUIDs and the raw delta falsely looks like a new artifact.
   * This helper therefore requires TWO CONSECUTIVE identical UUID sets (exact,
   * order-independent) before accepting a baseline. Bounded, fail-closed.
   *
   * No count assumption, no title/order/position, no `/asb/` identity.
   */
  private async waitForStableGenerationBaseline(timeoutMs = 10000, pollMs = 1000): Promise<string[]> {
    const reads: string[][] = [];
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try { reads.push(await this.readGenerationSurfaceArtifactIds()); }
      catch { /* transient read failure: retry within the bounded window */ }
      const verdict = stableBaselineFromReads(reads);
      if (verdict.kind === 'stable') return verdict.ids;
      if (Date.now() >= deadline) {
        throw new Error(`Project video generation failed: the generation surface did not stabilize before generation (no two consecutive identical artifact sets within ${timeoutMs}ms).`);
      }
      await new Promise((resolve)=>setTimeout(resolve, pollMs));
    }
  }

  /**
   * Generate exactly ONE project-level video.
   * Order: configure (Video/Omni 1.1 Flash/720p/8s/16:9/x1) → fill prompt →
   * verify Start enabled → click ONCE → capture the generation surface's
   * before/after artifact UUID sets → require exactly one new UUID.
   * Completion is NEVER inferred from progress reaching 100% (it can vanish early).
   */
  async generateProjectVideo(prompt: string): Promise<{title:string; artifactId:string}> {
    const text = String(prompt ?? '').trim();
    if (!text) throw new Error('generateProjectVideo requires a non-empty prompt.');

    // 1-2. Project page open + STABLE BEFORE baseline (STEP-8V).
    // The FIRST read on a freshly-opened project page can be incomplete while the
    // CDK virtual-scroll grid hydrates (LIVE-8U: two pre-existing UUIDs appeared
    // only on the second read and were falsely treated as a new artifact). The
    // baseline is therefore only accepted once TWO CONSECUTIVE reads agree.
    await this.first(S.addMedia, 30000);
    const beforeIds = await this.waitForStableGenerationBaseline();
    const beforeTitles = await this.listProjectVideos();

    // 3-4. Project-level prompt.
    await this.fill(S.promptInput, text);

    // 6. Configure video generation (Step 3 contract).
    await this.configureVideoGeneration({ model: 'Omni 1.1 Flash', resolution: '720p', duration: '8s', aspect: '16:9' });

    // 7. Re-verify batch x1 via the pure rule before clicking.
    await this.waitForGenerationReady();

    // 8. GENERATION GATE (STEP-8V): the delta guard MUST NOT run before this click.
    // A module-scoped latch makes "after evaluated before Start" structurally
    // impossible, independent of control flow.
    startGate.armed = false;
    await this.click(S.submit);
    startGate.armed = true;   // Start has been clicked exactly once; AFTER polling may begin.

    // 9. Bounded polling on the SAME un-navigated generation surface (STEP-8Q):
    // the new asset is the SINGLE new artifact UUID in AFTER − BEFORE, relative to
    // the STABLE pre-Start baseline. The title is read for logging only and NEVER
    // used as identity (STEP-8S proved the Videos category legitimately repeats titles).
    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve)=>setTimeout(resolve, 1000));
      let afterIds: string[] = [];
      try { afterIds = await this.readGenerationSurfaceArtifactIds(); } catch { continue; }   // tolerate transient reads
      // Hard gate: this delta is only ever computed after Start was clicked.
      if (!startGate.armed) throw new Error('Project video generation failed: the generation delta was evaluated before Start (gate violation).');
      const identity = newArtifactIds(beforeIds, afterIds);
      if (identity.kind === 'none') continue;
      if (identity.kind === 'ambiguous') throw new Error(`Project video generation failed: ${identity.reason}`);

      // Attribute the read-only title for logging by exact multiplicity (titles are
      // NOT identity and may legitimately repeat; if the title leaked, fall back to
      // the last observed generated title without weakening the UUID identity).
      let afterTitles: Array<{title:string; artifactId:string}> = [];
      try { afterTitles = await this.listProjectVideos(); } catch { /* logging only */ }
      const beforeCounts = new Map<string, number>();
      for (const d of beforeTitles) beforeCounts.set(d.title, (beforeCounts.get(d.title) ?? 0) + 1);
      const afterCounts = new Map<string, number>();
      for (const d of afterTitles) afterCounts.set(d.title, (afterCounts.get(d.title) ?? 0) + 1);
      const grew = Array.from(afterCounts.entries()).filter(([t, n]) => n > (beforeCounts.get(t) ?? 0)).map(([t]) => t);
      const title = grew.length === 1 ? grew[0] : (afterTitles[afterTitles.length - 1]?.title ?? '');

      return { title, artifactId: identity.artifactId };
    }
    throw new Error('Project video generation did not produce exactly one new video within the timeout.');
  }
  /**
   * Open an EXISTING Flow scene editor by scene id or exact scene title and wait
   * until it is actually mounted. Never creates a scene and never generates.
   */
  async openSceneEditor(sceneIdOrTitle: string): Promise<{url:string}> {
    const target = String(sceneIdOrTitle ?? '').trim();
    if (!target) throw new Error('openSceneEditor requires a scene id or exact scene title.');

    // A scene id is a UUID-ish path segment; prefer the direct scene route.
    const looksLikeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target) || /^[A-Za-z0-9_-]{20,}$/.test(target);
    if (looksLikeId && !/^https?:/i.test(target)) {
      const base = this.page.url();
      const projectBase = matchFlowProjectBase(base);
      if (!projectBase) throw new Error(`openSceneEditor could not resolve the project URL from "${base}".`);
      // CANONICAL route derived from the validated project URL + scene id (STEP-8AG):
      // constructed BEFORE navigating, never from whatever the page shows afterwards.
      // The validated project route is retained for the STEP-8AQ neutral refresh.
      this.projectUrl = projectBase;
      this.canonicalSceneUrl = canonicalSceneUrl(projectBase, target) || `${projectBase}/scene/${target}`;
      await this.page.goto(this.canonicalSceneUrl, {waitUntil:'domcontentloaded'});
    } else {
      // Exact scene title: open that exact tile (no fuzzy/first-match clicking).
      const tile = this.page.locator('flow-grid-tile-container').filter({hasText:target}).first();
      if (!(await tile.isVisible().catch(()=>false))) throw new Error(`openSceneEditor could not find an existing scene titled "${target}".`);
      await tile.click();
    }
    // Require the scene editor evidence (route + timeline + composer).
    const mounted = await this.page.locator('flow-scene-timeline').first().waitFor({state:'visible',timeout:20000}).then(()=>true).catch(()=>false);
    const composer = await this.first(S.scenePromptBox, 10000).then(()=>true).catch(()=>false);
    if (!mounted || !composer || !pageUrlIsSceneRoute(this.page.url())) {
      throw new Error(`openSceneEditor failed: the scene editor did not mount (url=${this.page.url()}, timeline=${mounted}, composer=${composer}).`);
    }
    // STEP-8CC: title-addressed scenes open via `/edit/<sceneId>` and previously captured
    // NO project route, so persistence could not run (live 8CB). Derive BOTH the validated
    // project route AND the canonical `/scene/<sceneId>` route from the MOUNTED URL.
    if (!this.projectUrl || !this.canonicalSceneUrl) {
      const derived = deriveRoutesFromMountedSceneUrl(this.page.url());
      if (!derived.ok) {
        throw new Error(`openSceneEditor failed: ${derived.reason}`);
      }
      this.projectUrl = derived.projectUrl;
      this.canonicalSceneUrl = derived.canonicalSceneUrl;
    }
    return { url: this.page.url() };
  }

  /**
   * Download the EXISTING committed scene clip to a local MP4 (STEP-8EI).
   *
   * Live-proven mechanism (8EH/8EI):
   *   canonical scene editor → committed clip → Download MENU TRIGGER
   *   → "720p Original size" item → Playwright download event → download.saveAs(tmp)
   *
   * NON-GENERATIVE: the Download control is a `mat-mdc-menu-trigger` whose items are
   * resolution options; the ORIGINAL-size item re-exports the committed clip. No generation,
   * no credits. Saves to a temporary sibling, validates, then atomically promotes.
   */
  async downloadCommittedSceneClip(sceneNumber: number, outputPath: string, options: { overwrite?: boolean; ffprobePath?: string; downloadDir?: string; fallbackTimeouts?: { observationMs?: number; hostedMs?: number; recoveryMs?: number } } = {}) {
    const filename = sceneClipFilename(sceneNumber);
    if (!filename) return { ok: false as const, result: 'PATH_INVALID' as const, reason: `Invalid scene number ${String(sceneNumber)}.` };

    const dest = path.resolve(outputPath);
    if (path.basename(dest) !== filename) {
      return { ok: false as const, result: 'PATH_INVALID' as const, reason: `Destination basename "${path.basename(dest)}" is not the canonical "${filename}".` };
    }

    // Idempotency: never re-download over a VALID existing clip unless asked.
    const existing = await validateDownloadedClip(dest, options.ffprobePath).catch(() => ({ ok: false as const }));
    if (existing.ok && decideClipDownload(true, options.overwrite).kind === 'skip') {
      const { ok: _o, ...meta } = existing as any; void _o;
      return { ok: true as const, result: 'ALREADY_VALID' as const, path: dest, meta };
    }

    if (!(await this.sceneHasClip())) return { ok: false as const, result: 'NO_COMMITTED_CLIP' as const, reason: 'The scene has no real committed clip.' };

    const trigger = this.page.locator('button.mat-mdc-menu-trigger[aria-label="Download"], button.mat-mdc-menu-trigger:has-text("Download")').first();
    // Live 8EU: the Download trigger lives in a HOVER OVERLAY (`flow-video-tile` →
    // `div.hover-overlay-has-progress-bar` → `flow-video-edit-history-hotbar` →
    // `flow-hotbar-container`), whose computed style is `visibility: hidden` until the
    // tile is hovered. Playwright's isVisible() therefore returns false on a freshly
    // loaded scene. Reveal the overlay by hovering the video tile before locating the
    // trigger (idempotent, non-mutating; a no-op when the control is already visible).
    if (!(await trigger.isVisible().catch(() => false))) {
      // Prefer a raw mouse.move to the tile CENTRE: Playwright's locator.hover() proved
      // unreliable here (the overlay is driven by CSS :hover on the tile), while an
      // explicit mouse.move deterministically reveals it (live 8EU).
      const box = await this.page.locator('flow-video-tile').first().boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0) {
        await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
        await new Promise((r) => setTimeout(r, 900));
      }
    }
    if (!(await trigger.isVisible().catch(() => false))) return { ok: false as const, result: 'DOWNLOAD_CONTROL_NOT_FOUND' as const, reason: 'No Download menu trigger is visible.' };

    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = path.join(path.dirname(dest), clipDownloadTempName(filename, process.pid, Date.now()) as string);

    // STEP-8FY: the Flow export is delivered as a real Playwright `Download` object, and Flow
    // tears the whole browser CONTEXT down on the download event. If we `await
    // page.waitForEvent('download')` and only THEN call `download.saveAs()`, the context is
    // already closed and both saveAs/createReadStream throw "Target page, context or browser has
    // been closed" (8FX). The fix: START the save INSIDE the download event listener, before the
    // callback returns, then await the already-started operation.
    //
    // The OS-downloads filesystem sweep remains only as a bounded FALLBACK — never the primary
    // transport. No generation, no credits.
    const os = await import('node:os');
    const downloadDir = options.downloadDir ?? process.env.FLOW_DOWNLOAD_DIR ?? path.join(os.homedir(), 'Downloads');
    const baseline = new Set(await fsp.readdir(downloadDir).catch(() => [] as string[]));

    let downloadObject: any = null;
    const saveState: { ok: boolean; reason: string } = { ok: false, reason: '' };
    // The event listener begins the save synchronously; this promise tracks the outcome.
    let saveStarted: Promise<void> | null = null;

    const startSaveInsideListener = (download: any): Promise<void> => {
      downloadObject = download;
      // CRITICAL: call saveAs() SYNCHRONOUSLY (no .then()/await before it) so the save begins
      // while the context is still alive. The promise is awaited later, after the callback returns.
      let savePromise: Promise<any>;
      try {
        savePromise = (typeof download?.saveAs === 'function') ? download.saveAs(tmp) : Promise.reject(new Error('download object has no saveAs'));
      } catch (e: any) {
        savePromise = Promise.reject(e);
      }
      return savePromise
        .then(async () => {
          const ok = await fsp.stat(tmp).then((s) => s.isFile() && s.size > 0).catch(() => false);
          saveState.ok = ok; saveState.reason = ok ? '' : 'saveAs produced no file';
        })
        .catch(async (e: any) => {
          // Fallback: createReadStream, ALSO initiated while the context is still alive.
          try {
            const stream = typeof download?.createReadStream === 'function' ? await download.createReadStream() : null;
            if (!stream) { saveState.ok = false; saveState.reason = `saveAs failed: ${String(e?.message ?? e).slice(0, 120)}`; return; }
            const chunks: Buffer[] = [];
            await new Promise<void>((res, rej) => { stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c))); stream.on('end', () => res()); stream.on('error', rej); });
            const buf = Buffer.concat(chunks);
            if (buf.length > 0) { await fsp.writeFile(tmp, buf); saveState.ok = true; saveState.reason = ''; }
            else { saveState.ok = false; saveState.reason = 'download stream was empty'; }
          } catch (e2: any) { saveState.ok = false; saveState.reason = `saveAs + createReadStream failed: ${String(e2?.message ?? e2).slice(0, 120)}`; }
        });
    };

    // Register the listener BEFORE the click so the event can never fire first.
    let resolveEvent: (d: any) => void = () => {};
    const eventReceived = new Promise<any>((resolve) => { resolveEvent = resolve; });
    this.page.once('download', (download: any) => {
      saveStarted = startSaveInsideListener(download); // begins save inside the callback
      resolveEvent(download);
    });

    try {
      await trigger.click();
      const menuLabels = (await this.page.locator('mat-menu button, [role="menu"] button, .mat-mdc-menu-panel button').allInnerTexts().catch(() => [])).map((t) => String(t).trim());
      const chosen = chooseDownloadMenuItem(menuLabels.map((l) => l.replace(/\s+/g, ' ')));
      if (chosen.kind !== 'ok') return { ok: false as const, result: 'DOWNLOAD_CONTROL_NOT_FOUND' as const, reason: `The Download menu offered no original-size item (saw: ${JSON.stringify(menuLabels)}).` };
      const menu = this.page.locator('mat-menu button, [role="menu"] button, .mat-mdc-menu-panel button').filter({ hasText: /Original size/i }).first();
      await menu.waitFor({ state: 'visible', timeout: 15000 });
      await menu.click();
    } catch (e: any) {
      return { ok: false as const, result: /timeout/i.test(String(e?.message)) ? ('DOWNLOAD_EVENT_TIMEOUT' as const) : ('DOWNLOAD_WRITE_FAILED' as const), reason: String(e?.message ?? e).slice(0, 200) };
    }

    // Wait (bounded) for the event, then await the ALREADY-STARTED save.
    await Promise.race([eventReceived, new Promise((r) => setTimeout(r, 60000))]);
    if (saveStarted) { try { await saveStarted; } catch { /* captured in saveResult */ } }
    const diag = downloadObjectDiagnostic(downloadObject);
    let savedOk = saveState.ok;
    let saveReason: string = saveState.reason || (downloadObject ? 'save did not start' : '');

    // Fallback transport: filesystem sweep (only when no Download object was usable).
    let located: string | null = null;
    if (!savedOk) {
      const sightings = new Map<string, { size: number; hits: number }>();
      const sweep = async (): Promise<string | null> => {
        const files = await fsp.readdir(downloadDir).catch(() => [] as string[]);
        for (const c of files) {
          if (!/\.(mp4|tmp)$/i.test(c)) continue;
          if (baseline.has(c)) continue;                              // pre-existing
          const p = path.join(downloadDir, c);
          const st = await fsp.stat(p).catch(() => null);
          if (!st || !st.isFile()) continue;
          const prev = sightings.get(c);
          const hits = prev && prev.size === st.size ? prev.hits + 1 : 1;
          sightings.set(c, { size: st.size, hits });
        }
        const pick = selectRecoverableDownload(
          [...sightings.entries()].map(([name, s]) => ({ name, size: s.size, stableHits: s.hits })),
          [...baseline],
        );
        if (pick.kind === 'ok') return path.join(downloadDir, pick.name);
        return null;
      };
      // Phase 1: observation; Phase 2: hosted flush; Phase 3: bounded recovery.
      const obsMs = options.fallbackTimeouts?.observationMs ?? 60000;
      const hostedMs = options.fallbackTimeouts?.hostedMs ?? 45000;
      const recMs = options.fallbackTimeouts?.recoveryMs ?? 240000;
      const observationDeadline = Date.now() + obsMs;
      while (Date.now() < observationDeadline) { located = await sweep(); if (located) break; await new Promise((r) => setTimeout(r, 750)); }
      if (!located && downloadObject !== null) {
        const hostedStart = Date.now();
        while (Date.now() - hostedStart < hostedMs) { located = await sweep(); if (located) break; await this.page.evaluate(() => { void document.readyState; void document.body.childElementCount; }).catch(() => {}); await new Promise((r) => setTimeout(r, 750)); }
      }
      if (!located && recMs > 0) {
        const recoveryDeadline = Date.now() + recMs;
        while (Date.now() < recoveryDeadline) {
          located = await sweep();
          if (located) break;
          const state = classifyDownloadCapture([...sightings.entries()].map(([name, s]) => ({ name, size: s.size, stableHits: s.hits })), [...baseline], false);
          if (state === 'AMBIGUOUS') return { ok: false as const, result: 'DOWNLOAD_WRITE_FAILED' as const, reason: 'Multiple download candidates stabilized simultaneously; refusing to guess.' };
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (located) {
        try { await fsp.copyFile(located, tmp); savedOk = true; } catch (e: any) { savedOk = false; saveReason = `Could not take the filesystem download: ${String(e?.message ?? e)}`; }
        await fsp.rm(located, { force: true }).catch(() => {}); // tidy the browser download dir
      }
    }

    const transport = classifyDownloadTransport({ downloadObjectReceived: downloadObject !== null, filesystemCandidatePresent: located !== null });
    if (!savedOk) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      const code = classifyDownloadOutcome({ downloadObjectReceived: downloadObject !== null, savedOk: false });
      return { ok: false as const, result: code as any, reason: `No usable download transport (transport=${transport}; ${saveReason || 'no filesystem candidate'}).` };
    }

    // Validate the TEMP artifact before promoting it.
    const valid = await validateDownloadedClip(tmp, options.ffprobePath);
    if (!valid.ok) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      return { ok: false as const, result: (valid.result ?? 'INVALID_DOWNLOADED_FILE') as any, reason: valid.reason };
    }
    try { await fsp.rename(tmp, dest); }
    catch (e: any) { await fsp.rm(tmp, { force: true }).catch(() => {}); return { ok: false as const, result: 'DOWNLOAD_WRITE_FAILED' as const, reason: `Atomic promotion failed: ${String(e?.message ?? e)}` }; }
    const { ok: _o2, ...meta } = valid as any; void _o2;
    return { ok: true as const, result: 'DOWNLOAD_SUCCESS' as const, path: dest, transport, suggestedFilename: diag.suggestedFilename, meta };
  }

  /**
   * Download ONE project-level artifact through its NATIVE tile Download control
   * (tile → More options → Download), using the proven Playwright download-event transport.
   *
   * IDENTITY: the project grid exposes no artifact UUID, so the exact visible tile title
   * (aria-label) is the strongest deterministic identity available. Resolution is pure
   * ({@link matchProjectArtifactTiles}) and FAILS CLOSED on zero or multiple matching tiles —
   * an arbitrary tile is never downloaded. Never generates or mutates Flow content.
   */
  async downloadProjectArtifact(
    artifactTitle: string,
    outputPath: string,
    options: { timeoutMs?: number } = {},
  ): Promise<{ ok: true; path: string; suggestedFilename: string; transport?: string } | { ok: false; reason: string }> {
    const wanted = String(artifactTitle ?? '').trim();
    if (!wanted) return { ok: false, reason: 'downloadProjectArtifact requires a non-empty artifact title.' };
    const out = path.resolve(outputPath);
    if (!out || !path.basename(out)) return { ok: false, reason: 'downloadProjectArtifact requires a valid output path.' };

    // 1. Collect the visible tile labels and resolve the target purely (fail closed).
    const tiles = this.page.locator('flow-grid-tile-container');
    const count = await tiles.count().catch(() => 0);
    const labels: string[] = [];
    for (let i = 0; i < count; i++) {
      const tile = tiles.nth(i);
      const visible = await tile.isVisible().catch(() => false);
      labels.push(visible ? String(await tile.getAttribute('aria-label').catch(() => '') ?? '').trim() : '\u0000');
    }
    const resolution = matchProjectArtifactTiles(labels, wanted);
    if (resolution.classification !== 'UNIQUE_ARTIFACT_TILE') {
      return { ok: false, reason: `Project artifact "${wanted}" resolved to ${resolution.matches.length} matching tile(s) [${resolution.classification}]; refusing to download an arbitrary tile.` };
    }
    const tile = tiles.nth(resolution.matches[0]);

    // 2. Reveal the tile footer and open its scoped "More options" menu.
    await tile.scrollIntoViewIfNeeded().catch(() => {});
    await tile.hover().catch(() => {});
    const kebab = tile.locator("button[aria-label='More options']").first();
    if (!(await kebab.count().catch(() => 0))) return { ok: false, reason: 'The resolved project artifact tile exposes no "More options" control.' };
    await kebab.click();

    // 3. Stage 1: the Download item is an Angular Material SUBMENU TRIGGER. Resolve it
    //    deterministically (role=menuitem, aria-haspopup=menu, submenu-trigger class, "Download");
    //    never click arbitrary page text.
    const menuPanel = this.page.locator('.mat-mdc-menu-panel').filter({ hasText: /Download/ }).last();
    await menuPanel.waitFor({ state: 'visible', timeout: 10000 }).catch(() => { /* fall through to trigger lookup */ });
    const downloadTrigger = menuPanel
      .locator("button.mat-mdc-menu-item-submenu-trigger[aria-haspopup='menu'], button[role='menuitem'][aria-haspopup='menu']")
      .filter({ hasText: /Download/ })
      .first();
    if (!(await downloadTrigger.count().catch(() => 0))) {
      await this.page.keyboard.press('Escape').catch(() => {});
      return { ok: false, reason: 'The resolved project artifact menu exposes no Download submenu trigger.' };
    }

    // 4. Stage 2: hover the Download trigger to open the resolution submenu, then read its items.
    await downloadTrigger.hover().catch(() => {});
    const submenuPanel = this.page.locator('.mat-mdc-menu-panel').filter({ hasText: /Original size/i }).last();
    const submenuVisible = await submenuPanel.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
    if (!submenuVisible) {
      await this.page.keyboard.press('Escape').catch(() => {});
      return { ok: false, reason: 'The Download submenu did not open after hovering the Download trigger.' };
    }
    const resolutionItems = submenuPanel.locator('button, [role="menuitem"]');
    const submenuLabels = (await resolutionItems.allInnerTexts().catch(() => [] as string[]))
      .map((t) => String(t).replace(/\s+/g, ' ').trim()).filter(Boolean);
    const chosen = chooseDownloadMenuItem(submenuLabels);
    if (chosen.kind !== 'ok') {
      await this.page.keyboard.press('Escape').catch(() => {});
      return { ok: false, reason: `The Download submenu offered no "Original size" option (saw: ${JSON.stringify(submenuLabels)}).` };
    }
    const resolutionItem = resolutionItems.filter({ hasText: chosen.label }).first();
    if (!(await resolutionItem.count().catch(() => 0))) {
      await this.page.keyboard.press('Escape').catch(() => {});
      return { ok: false, reason: `The "${chosen.label}" resolution option was not found in the Download submenu.` };
    }

    // 5. THE ONLY mutation: the resolution click (e.g. "720p Original size"). The download
    //    listener is armed BEFORE the click. Flow tears the browser context down on the
    //    download event, so the PROVEN recovery from downloadCommittedSceneClip() is reused:
    //    start download.createReadStream() FIRST (synchronously, while the context is alive)
    //    and prefer its buffer; fall back to download.saveAs() only if the stream is unusable.
    await fsp.mkdir(path.dirname(out), { recursive: true });
    const saveAsTemp = `${out}.saveas-tmp`;
    await fsp.rm(saveAsTemp, { force: true }).catch(() => {});
    let suggestedFilename = '';
    let downloadObject: any = null;
    let streamPromise: any = null;

    const readAll = (download: any): Promise<Buffer> => Promise.resolve(download.createReadStream()).then((stream: any) => {
      if (!stream) throw new Error('createReadStream returned null');
      return new Promise<Buffer>((res, rej) => {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
        stream.on('end', () => res(Buffer.concat(chunks)));
        stream.on('error', rej);
      });
    });

    const eventReceived: Promise<void> = new Promise((resolve) => {
      this.page.once('download', (d: any) => {
        downloadObject = d;
        suggestedFilename = String(d?.suggestedFilename?.() ?? '');
        try {
          streamPromise = (typeof d?.createReadStream === 'function') ? readAll(d) : Promise.reject(new Error('download object has no createReadStream'));
        } catch (e: any) { streamPromise = Promise.reject(e); }
        resolve();
      });
    });

    await resolutionItem.click();
    const timeoutMs = options.timeoutMs ?? 120000;
    const raced = await Promise.race([
      eventReceived.then(() => 'event' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
    ]);
    if (raced === 'timeout') {
      await fsp.rm(saveAsTemp, { force: true }).catch(() => {});
      return { ok: false, reason: `The "${chosen.label}" download produced no download event within the timeout.` };
    }

    // Recovery transport: createReadStream FIRST, then saveAs fallback.
    let transport = '';
    let streamError = '';
    if (streamPromise) {
      try {
        const buf = await streamPromise;
        if (buf && buf.length > 0) { await fsp.writeFile(out, buf); transport = 'createReadStream'; }
        else streamError = 'createReadStream produced an empty buffer';
      } catch (e: any) { streamError = `createReadStream failed: ${String(e?.message ?? e).slice(0, 120)}`; }
    } else {
      streamError = 'createReadStream was not started';
    }

    if (transport !== 'createReadStream' && downloadObject && typeof downloadObject.saveAs === 'function') {
      const savePromise: Promise<any> = Promise.resolve().then(() => downloadObject.saveAs(saveAsTemp)).catch(() => null);
      await Promise.race([savePromise, new Promise((r) => setTimeout(r, 15000))]);
      const savedOk = await fsp.stat(saveAsTemp).then((s) => s.isFile() && s.size > 0).catch(() => false);
      if (savedOk) {
        try { await fsp.rename(saveAsTemp, out); }
        catch { await fsp.copyFile(saveAsTemp, out).catch(() => {}); }
        const copiedOk = await fsp.stat(out).then((s) => s.isFile() && s.size > 0).catch(() => false);
        if (copiedOk) transport = 'saveAs';
      }
    }
    await fsp.rm(saveAsTemp, { force: true }).catch(() => {});

    if (transport !== 'createReadStream' && transport !== 'saveAs') {
      return { ok: false, reason: `The project artifact Download recovery produced no file (${streamError || 'no transport succeeded'}).` };
    }
    const ok = await fsp.stat(out).then((s) => s.isFile() && s.size > 0).catch(() => false);
    if (!ok) return { ok: false, reason: 'The project artifact Download recovery left no file at the output path.' };
    return { ok: true, path: out, suggestedFilename, transport };
  }

  /**
   * Create ONE empty Flow scene via the project's "Add media menu → New scene" entry
   * (STEP-8EN, discovered live; NON-GENERATIVE — creates no media and spends no credits).
   * Idempotent: callers must look up an existing scene first (see sceneLocalGeneration helpers).
   */
  async createScene(): Promise<{ sceneId: string; url: string }> {
    const before = new Set(await this.listSceneIds().catch(() => [] as string[]));
    const addMedia = this.page.locator(SCENE_CREATE_MENU.addMediaMenu).first();
    if (!(await addMedia.isVisible().catch(() => false))) throw new Error('createScene failed: the "Add media menu" control is not visible.');
    await addMedia.click();
    const item = this.page.locator('.mat-mdc-menu-panel.add-menu button, [role="menu"] button').filter({ hasText: /New scene/ }).first();
    await item.waitFor({ state: 'visible', timeout: 15000 }).catch(() => { throw new Error('createScene failed: the "New scene" menu item did not appear.'); });
    await item.click();
    // Wait for the new scene editor to mount and expose its id via the route.
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const m = String(this.page.url()).match(/\/(?:edit|scene)\/([0-9a-f-]{36})/i);
      if (m && !before.has(m[1])) {
        await this.first([S.scenePromptBox[0]], 30000).catch(() => {});
        return { sceneId: m[1], url: this.page.url() };
      }
      await new Promise((r) => setTimeout(r, 750));
    }
    throw new Error('createScene failed: no new scene id appeared in the route after clicking "New scene".');
  }

  /** List the Flow scene ids currently discoverable in the project. Read-only. */
  async listSceneIds(): Promise<string[]> {
    const urls = await this.page.evaluate(() => [...document.querySelectorAll('a[href*="/edit/"], a[href*="/scene/"]')].map((a: any) => String(a.getAttribute('href')))).catch(() => [] as string[]);
    const ids = (urls as string[]).map((u) => (u.match(/\/(?:edit|scene)\/([0-9a-f-]{36})/i) || [])[1]).filter(Boolean) as string[];
    const here = (String(this.page.url()).match(/\/(?:edit|scene)\/([0-9a-f-]{36})/i) || [])[1];
    if (here) ids.push(here);
    return [...new Set(ids)];
  }

  /**
   * Generate ONE scene-local video via the SCENE BUILDER's own composer (STEP-8EN).
   *
   * Uses the scene-local prompt box + the scene-local `flow-generate-icon-button` — NEVER the
   * surface-ambiguous global `button[aria-label='Start generation']`. Must be called on a
   * scene-editor route. The caller owns the credit guard; this method never retries.
   *
   * ORDER (ingredient chips must survive prompt entry):
   *   1. enter/fill the prompt text
   *   2. ensure the expected ingredients are attached as ACTUAL chips (existing picker)
   *   3. verify the CHIP evidence (raw prompt text never satisfies this)
   *   4. one click, then a UUID delta from the SAME authoritative generation-surface source
   */
  /**
   * Resolve THE editable prompt editor inside the scene-local `flow-base-prompt-box`.
   *
   * READ-ONLY and DOM-property based. Enumerates EVERY `.ProseMirror` candidate, measures real
   * editability in the page (computed visibility, `contenteditable`, `aria-readonly`, disabled
   * ancestry), and delegates the decision to the PURE `resolvePromptEditorCandidate()`.
   *
   * Fail-closed: throws `PROMPT_EDITOR_NOT_FOUND` / `PROMPT_EDITOR_NOT_EDITABLE` instead of filling
   * an invalid element. It never mutates the prompt and never clicks Start.
   */
  private async resolveScenePromptEditor(promptBox: Locator): Promise<Locator> {
    const candidates: PromptEditorCandidate[] = [];
    const proseMirror = promptBox.locator(SCENE_LOCAL_GENERATE_CONTROLS.proseMirror);
    const total = await proseMirror.count().catch(() => 0);
    for (let index = 0; index < total; index++) {
      const observed = await proseMirror.nth(index).evaluate((el: any) => {
        const style = el.ownerDocument.defaultView?.getComputedStyle(el);
        const visible = !!style && style.visibility !== 'hidden' && style.display !== 'none'
          && style.opacity !== '0' && el.getClientRects().length > 0;
        const editable = String(el.getAttribute('contenteditable') ?? '').toLowerCase() === 'true';
        const ariaReadonly = String(el.getAttribute('aria-readonly') ?? '').toLowerCase() === 'true';
        const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true'
          || !!el.closest('[disabled], [aria-disabled="true"]');
        return { exists: true, visible, editable, ariaReadonly, disabled };
      }).catch(() => ({ exists: false, visible: false, editable: false, ariaReadonly: false, disabled: false }));
      candidates.push({ index, ...observed });
    }
    const resolution = resolvePromptEditorCandidate(candidates);
    if (!resolution.ok) throw new Error(promptEditorRefusal(resolution));
    // A scoped, explicitly-editable fast path must agree with the DOM-probed decision.
    const editableCount = await promptBox.locator(SCENE_LOCAL_GENERATE_CONTROLS.proseMirrorEditable).count().catch(() => 0);
    if (editableCount < 1) throw new Error(promptEditorRefusal({ ok: false, code: 'PROMPT_EDITOR_NOT_EDITABLE', reason: `the scoped editable selector ${SCENE_LOCAL_GENERATE_CONTROLS.proseMirrorEditable} matched no element.` }));
    return proseMirror.nth(resolution.index as number);
  }

  // =====================================================================================
  // FIRST-CLIP PROJECT GENERATION (project composer) — the ONLY surface proven able to
  // create a scene's first clip. Live-proven: a project generation auto-creates a populated
  // scene carrying the generated clip, so NO Add Clip attachment is used or needed.
  // These primitives are additive and are NOT invoked by any offline test; they are
  // production code awaiting the first authorised live run.
  // =====================================================================================

  /**
   * Open the canonical PROJECT route (where the editable first-clip composer lives).
   *
   * Resolves the project URL from the CURRENT location via the PURE `deriveCanonicalProjectUrl()`
   * rather than from `this.projectUrl`, which was only ever assigned by `openSceneEditor()`. The
   * first-clip lifecycle starts directly on `/project/<id>`, so depending on the scene opener was a
   * hidden dependency that failed closed at PROJECT_SETTINGS (live-proven).
   *
   * `knownProjectUrl` is still preferred when valid, and a stale/invalid value never wins over the
   * observable route. No mutable global state is introduced to initialise anything.
   * Fails closed when the location is missing/not a project route, when the project id cannot be
   * extracted, or when it differs from `expectedProjectId`. Never spends credits.
   */
  async openProjectRoute(expectedProjectId?: string): Promise<{ url: string }> {
    const resolved = deriveCanonicalProjectUrl({
      currentUrl: this.page.url(),
      knownProjectUrl: this.projectUrl,
      expectedProjectId,
    });
    if (!resolved.ok) throw new Error(`openProjectRoute failed: ${resolved.reason}`);
    await this.page.goto(resolved.projectUrl, { waitUntil: 'domcontentloaded' });
    const ok = await this.first([PROJECT_PROMPT_CONTROLS.projectPromptBox], 30000).then(() => true).catch(() => false);
    if (!ok) throw new Error(`openProjectRoute failed: the project prompt box did not mount on ${this.page.url()}.`);
    return { url: this.page.url() };
  }

  /** READ-ONLY: enumerate every `.ProseMirror` in the PROJECT composer with real editability. */
  async observeProjectPromptEditorCandidates(): Promise<PromptEditorCandidate[]> {
    const box = this.page.locator(PROJECT_PROMPT_CONTROLS.projectPromptBox).first();
    // NESTED scope: `box` is ALREADY `flow-prompt-box`, so the selector must NOT repeat the host
    // qualifier. Using the page-level constant here produced `flow-prompt-box flow-prompt-box
    // .ProseMirror`, which matched zero elements (live-proven) and made every first-clip run fail
    // closed at PROJECT_PROMPT_EDITOR_UNRESOLVED.
    const nested = resolveNestedProjectPromptEditorSelector();
    if (!nested.ok) throw new Error(`observeProjectPromptEditorCandidates refused: ${nested.reason}`);
    const all = box.locator(nested.nestedSelector);
    const total = await all.count().catch(() => 0);
    const candidates: PromptEditorCandidate[] = [];
    for (let index = 0; index < total; index++) {
      const observed = await all.nth(index).evaluate((el: any) => {
        const style = el.ownerDocument.defaultView?.getComputedStyle(el);
        const editable = String(el.getAttribute('contenteditable') ?? '').toLowerCase() === 'true';
        const ariaReadonly = String(el.getAttribute('aria-readonly') ?? '').toLowerCase() === 'true';
        const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true'
          || !!el.closest('[disabled], [aria-disabled="true"]');
        const visible = !!style && style.visibility !== 'hidden' && style.display !== 'none'
          && style.opacity !== '0' && el.getClientRects().length > 0;
        return { exists: true, visible, editable, ariaReadonly, disabled };
      }).catch(() => ({ exists: false, visible: false, editable: false, ariaReadonly: false, disabled: false }));
      candidates.push({ index, ...observed });
    }
    return candidates;
  }

  /** READ-ONLY: the `/video/<UUID>` identities currently exposed by the project generation surface. */
  async readProjectGenerationVideoUuids(): Promise<string[]> {
    const media = await this.page.evaluate(() => {
      const out: string[] = [];
      const scan = (el: any) => {
        if (!el || !el.attributes) return;
        for (const a of el.attributes) {
          const v = String(a.value);
          if (/flow-content\.google\/(?:video|image)\//i.test(v)) {
            for (const m of v.match(/https?:\/\/[^\s"')\\]+/g) ?? []) out.push(m);
          }
        }
        for (let i = 0; i < el.children.length; i++) scan(el.children[i]);
      };
      scan(document.documentElement);
      return out;
    }) as string[];
    return media.filter((url) => flowMediaKind(url) === 'video');
  }

  /**
   * READ-ONLY: exact `@CHAR-*` identities from the PROJECT composer's dedicated Characters
   * category in its Add-Ingredients picker.
   *
   * Reuses the EXISTING PROVEN selector set and the same read-only pattern as the scene-local
   * character reader: open the picker → activate the category → read `span.asset-title` → close
   * with Escape in a `finally`. It NEVER selects a character, never clicks a confirm/add control,
   * never generates, and never navigates to a scene.
   *
   * IDENTITY: the canonical identity is the exact `@CHAR-*` tag. The per-row `/asb/` image token is
   * transient and is deliberately never read, returned or matched.
   *
   * ACTIVATION IS PROVEN BY THE ROW SET, not by the tab state: live evidence showed the tab did not
   * flip `aria-selected` / `mdc-list-item--activated` after the click, so `decideProjectCharacters-
   * CategoryFromRows()` is the authority. It requires every rendered row to be an exact `@CHAR-*`
   * tag — which also proves the list is NOT the mixed default list.
   */
  async readProjectCharacterIdentities(): Promise<{
    ok: boolean; characters: string[]; reason?: string; code?: string; ignored?: string[];
    categories?: string[]; verification?: string; observedRowCount?: number;
  }> {
    const trigger = this.page.locator(S.addIngredients[0]).first();
    if (!(await trigger.isVisible().catch(() => false))) {
      return { ok: false, characters: [], reason: 'the project composer exposes no Add-Ingredients control.', code: 'PROJECT_CATEGORY_NOT_FOUND' };
    }
    try {
      await trigger.click();
      // Wait for the picker overlay; bounded, read-only.
      await this.page.locator('.cdk-overlay-container').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 900));

      const cats = await this.page.evaluate(() => Array.from(document.querySelectorAll('mat-nav-list mat-list-item[role="tab"], [role="tablist"] [role="tab"]'))
        .map((el: any) => ({
          label: String(el.innerText || '').replace(/\n/g, ' ').trim(),
          activated: el.classList.contains('mdc-list-item--activated') || el.getAttribute('aria-selected') === 'true',
        }))).catch(() => [] as Array<{ label: string; activated: boolean }>);
      const labels = cats.map((c) => c.label);
      const readRowTitles = async (): Promise<string[]> => {
        const rowSel = S.assetRow[0];
        const titleSel = S.assetTitle[0];
        return this.page.evaluate(({ r, t }: { r: string; t: string }) => Array.from(document.querySelectorAll(r))
          .map((el: any) => String(el.querySelector(t)?.textContent ?? '').trim()), { r: rowSel, t: titleSel })
          .catch(() => [] as string[]);
      };
      // BEFORE rows (the default mixed list) — context for the row-set comparison.
      const beforeRows = await readRowTitles();

      // Locate the dedicated category tab. LIVE-PROVEN correction: the raw `innerText` of a
      // Material list item carries the icon ligature ("accessibility_new Characters"), so a raw
      // `(^|\s)Characters(\s|$)` search MISSES the tab. The label is therefore normalised first and
      // matched EXACTLY. This step only establishes the target's IDENTITY; activation is still
      // proven afterwards by the rendered row set.
      const locate = findProjectAssetCategory({ labels, wanted: PROJECT_ASSET_CATEGORY });
      if (!locate.ok) {
        return { ok: false, characters: [], reason: locate.reason, code: locate.code, categories: labels };
      }
      // Address the tab by the OBSERVED index rather than by a text filter: the index is derived
      // from the same querySelectorAll order used above, so it is exact and assumption-free. This
      // also avoids depending on how Playwright normalises the icon ligature inside `hasText`.
      const tab = this.page.locator('mat-nav-list mat-list-item[role="tab"], [role="tablist"] [role="tab"]').nth(locate.index);
      if (!(await tab.count())) {
        return { ok: false, characters: [], reason: `the "${PROJECT_ASSET_CATEGORY}" category tab was resolved at index ${locate.index} but is not clickable.`, code: 'PROJECT_CATEGORY_NOT_FOUND', categories: labels };
      }
      // Click ONLY the category tab. Never an asset row, never a confirm/add control, never Start.
      await tab.click().catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
      const afterRows = await readRowTitles();

      // THE authoritative activation check.
      const verified = decideProjectCharactersCategoryFromRows({ afterRows });
      if (verified.result !== 'VERIFIED_CHARACTER_CATEGORY') {
        return {
          ok: false, characters: [],
          reason: `${verified.reason} (before: ${beforeRows.length} row(s); after: ${afterRows.length} row(s))`,
          code: verified.result, categories: labels, verification: verified.result, observedRowCount: afterRows.length,
        };
      }
      const parsed = parseProjectCharacterIdentities({ rowTitles: afterRows });
      if (!parsed.ok) {
        return { ok: false, characters: [], reason: parsed.reason, code: parsed.code, categories: labels, verification: verified.result, observedRowCount: afterRows.length };
      }
      return { ok: true, characters: parsed.characters, ignored: parsed.ignored, categories: labels, verification: verified.result, observedRowCount: afterRows.length };
    } finally {
      // ALWAYS close the picker, and never mutate it.
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.locator('.cdk-overlay-container').first().waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
    }
  }

  /**
   * READ-ONLY: exact `#BGD-*` background identities from the PROJECT ingredient PICKER surface.
   *
   * The project GRID is deliberately NOT used here: it is virtualised, so a bounded non-scrolling
   * read observed only 1 of the 7 required `#BGD-*` tiles (live-proven) and is therefore not the
   * authoritative complete background pool. This reader opens the SAME Add-Ingredients picker the
   * character reader uses, reads `span.asset-title` text, and closes with Escape in a `finally`.
   *
   * It clicks only a category tab. It NEVER selects an asset row, never clicks a confirm/add
   * control, never generates, never navigates, and never reads the transient image token as identity.
   */
  async readProjectBackgroundIdentities(): Promise<{
    ok: boolean; backgrounds: string[]; reason?: string; source?: string; ignored?: number;
    /** Only ever OBSERVED identities. Absence proves nothing about unscrolled rows. */
    observedOnly: boolean; requiredComplete?: boolean; missing?: string[];
  }> {
    const REQUIRED = [
      '#BGD-01-ARJUN-ROOM-WIDE',
      '#BGD-02-ARJUN-ROOM-WINDOW-CLOSE',
      '#BGD-03-STREET-TO-CREMATION-WIDE',
      '#BGD-04-CREMATION-GROUND-WIDE',
      '#BGD-05-CREMATION-GROUND-PYRE-CLOSE',
      '#BGD-06-CREMATION-GROUND-STONE-CLOSE',
      '#BGD-07-ARJUN-HOME-INTERIOR-WIDE',
    ];
    const trigger = this.page.locator(S.addIngredients[0]).first();
    if (!(await trigger.isVisible().catch(() => false))) {
      return { ok: false, backgrounds: [], observedOnly: true, reason: 'the project composer exposes no Add-Ingredients control.' };
    }
    try {
      await trigger.click();
      await this.page.locator('.cdk-overlay-container').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 900));

      const rowSel = S.assetRow[0];
      const titleSel = S.assetTitle[0];
      const readRowTitles = async (): Promise<string[]> => this.page.evaluate(({ r, t }: { r: string; t: string }) => Array.from(document.querySelectorAll(r))
        .map((el: any) => String(el.querySelector(t)?.textContent ?? '').trim()), { r: rowSel, t: titleSel })
        .catch(() => [] as string[]);
      const labels: string[] = await this.page.evaluate(() => Array.from(document.querySelectorAll('mat-nav-list mat-list-item[role="tab"], [role="tablist"] [role="tab"]'))
        .map((el: any) => String(el.innerText || '').replace(/\n/g, ' ').trim())).catch(() => [] as string[]);

      // The already-rendered DEFAULT (mixed) category.
      const allRows = await readRowTitles();

      // Prefer the dedicated Images category, but only trust it if its rows prove it. The tab is
      // addressed by the OBSERVED index of its normalised label (the same icon-ligature correction
      // as the character reader); a zero or ambiguous match simply skips the click.
      let imagesRows: string[] = [];
      const imageTab = findProjectAssetCategory({ labels, wanted: PROJECT_BACKGROUND_CATEGORY });
      if (imageTab.ok) {
        const tab = this.page.locator('mat-nav-list mat-list-item[role="tab"], [role="tablist"] [role="tab"]').nth(imageTab.index);
        if (await tab.count()) {
          await tab.click().catch(() => {});
          await new Promise((r) => setTimeout(r, 1200));
          imagesRows = await readRowTitles();
        }
      }

      const choice = decideProjectBackgroundSource({ imagesRows, allRows });
      const titles = choice.source === 'IMAGES_CATEGORY' ? imagesRows : allRows;
      const parsed = parseProjectBackgroundIdentities({ rowTitles: titles });
      const observed = parsed.ok ? parsed.backgrounds : [];
      const missing = REQUIRED.filter((t) => !observed.includes(t));

      // The picker list is VIRTUALISED (live-proven: a bounded non-scrolling read observed only
      // 1 of the 7 required identities, and the Images category 0). So this result is explicitly
      // scoped to what was RENDERED, and `ok` additionally requires the exact required set. It
      // never claims a complete inventory and never substitutes the virtualised project grid.
      if (!parsed.ok) {
        return { ok: false, backgrounds: [], observedOnly: true, source: choice.source, reason: parsed.reason, missing };
      }
      return {
        ok: missing.length === 0,
        backgrounds: observed,
        source: choice.source,
        ignored: parsed.ignored.length,
        observedOnly: true,
        requiredComplete: missing.length === 0,
        missing,
        reason: missing.length === 0 ? undefined
          : `${missing.length} required background identity/identities were not observable in the rendered picker viewport (${missing.join(', ')}); the picker list is virtualised, so this non-scrolling read proves absence only for the rendered rows.`,
      };
    } finally {
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.locator('.cdk-overlay-container').first().waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
    }
  }

  /**
   * READ-ONLY: live asset identities for the FIRST-CLIP gate.
   *
   * REPLACES the previous implementation, which called `listSceneIds()` (reading
   * `a[href*="/edit/"], a[href*="/scene/"]` anchors that the PROJECT ROUTE does not expose — proven
   * live) and then opened an ARBITRARY scene. That hidden scene-route bootstrap failed closed at
   * ASSET_LOCKS on a fresh project and is gone for good.
   *
   * Resolution order (deterministic, no guessing — see `classifyFirstClipAssetSurface`):
   *   1. a KNOWN canonical scene id (`preferredSceneId`, e.g. the scene's own persisted
   *      `flow_scene_id`) → open that exact scene and read the PROVEN rail + Characters-picker
   *      identities via `readFlowSceneSurfaceAssets()`;
   *   2. otherwise read the PROJECT composer's Add-Ingredients PICKER (exact `@CHAR-*` from the
   *      dedicated Characters category, exact `#BGD-*` from the Images/default category). The
   *      virtualised project GRID is intentionally NOT part of this path.
   *
   * It never selects an arbitrary scene, never takes the first scene, and never uses grid position.
   * When a required identity cannot be proven from the surfaces actually read, it returns
   * `ok:false` with the precise reason so ASSET_LOCKS fails closed honestly.
   */
  async readFlowAssetIdentitiesForFirstClip(preferredSceneId?: string | null): Promise<{
    ok: boolean; characters: string[]; backgrounds: string[]; reason?: string;
    surface?: string; projectGridIdentities?: string[]; projectBackgroundIdentities?: string[];
    projectCharacterIdentities?: string[];
  }> {
    const known = String(preferredSceneId ?? '').trim();

    if (known) {
      const { readFlowSceneSurfaceAssets } = await import('./assetVerification.js');
      try { await this.openSceneEditor(known); }
      catch (e: any) {
        return { ok: false, characters: [], backgrounds: [], surface: 'KNOWN_SCENE_ID', reason: `the known scene surface ${known} could not be opened: ${String(e?.message ?? e).slice(0, 160)}` };
      }
      const read = await readFlowSceneSurfaceAssets(this as any);
      return { ...read, surface: 'KNOWN_SCENE_ID' };
    }

    // No known scene id: use the PROJECT composer's own ingredient PICKER surface for both
    // characters and backgrounds. It never navigates to a scene, never selects an asset, and never
    // reads the virtualised project grid for background identity.
    const backgrounds = await this.readProjectBackgroundIdentities().catch(() => ({ ok: false, backgrounds: [] as string[], reason: 'background read failed' }));
    const characters = await this.readProjectCharacterIdentities().catch((e: any) => ({ ok: false, characters: [] as string[], reason: String(e?.message ?? e).slice(0, 160) }));
    const readable = backgrounds.ok || characters.ok;
    const classified = classifyFirstClipAssetSurface({ knownSceneId: known, projectIngredientSurfaceReadable: readable });
    if (classified.surface === 'UNAVAILABLE') {
      return { ok: false, characters: [], backgrounds: [], surface: classified.surface, projectGridIdentities: [], projectBackgroundIdentities: [], reason: classified.reason };
    }
    return {
      ok: characters.ok && backgrounds.ok,
      characters: characters.characters,
      backgrounds: backgrounds.backgrounds,
      surface: classified.surface,
      // The project grid is virtualised and is NOT an authoritative background pool; identities
      // come from the picker surface, so the grid field is deliberately left empty.
      projectGridIdentities: [],
      projectBackgroundIdentities: backgrounds.backgrounds,
      projectCharacterIdentities: characters.characters,
      reason: characters.ok && backgrounds.ok ? undefined
        : [characters.ok ? null : `characters: ${characters.reason ?? 'unavailable'}`, backgrounds.ok ? null : `backgrounds: ${backgrounds.reason ?? 'unavailable'}`]
          .filter(Boolean).join('; '),
    };
  }

  /**
   * READ-ONLY snapshot of the persistent project VIDEO LIBRARY, read through the SCENE EDITOR's
   * `Add Clip` → `Videos` picker.
   *
   * WHY THIS SURFACE (live-proven)
   * -------------------------------
   * Two earlier surfaces were tried and BOTH are wrong for identity capture:
   *   · the project ROUTE never exposes a newly generated `/video/<UUID>`;
   *   · the project COMPOSER's Add-Ingredients picker has NO `Videos` category at all — its bar is
   *     exactly All / Images / Voices / Characters / Avatars / Uploads, so a strict normalised lookup
   *     for "Videos" can never match there.
   * The authoritative library surface is the SCENE EDITOR's media picker — the SAME panel
   * `attachFirstClipByArtifactId()` already drives:
   *
   *     Add Clip → Videos → div.flow-media-picker-dialog-panel
   *       → button.asset-item[role=option] rows (PARENT rows only — each item nests a
   *         flow-add-menu-asset-item child, so both selectors would double-count)
   *       → flow-add-menu-detail-pane → flow-video-trimmer-preview → video.video-preview
   *       → src = https://flow-content.google/video/<UUID>?...
   *
   * Rows carry no identity of their own (opaque `/asb/` thumbnails, duplicated titles), so the
   * shared preview is the ONLY artifact identity available.
   *
   * SELECTED-ROW CONTRACT (live-proven, zero credit)
   * ------------------------------------------------
   * The picker AUTO-SELECTS row 0 when it opens and previews it immediately. Clicking an
   * ALREADY-SELECTED row is a destructive TOGGLE, not a preview action: it deselects the row and
   * DESTROYS `flow-add-menu-detail-pane`, so `video.video-preview` disappears and the whole
   * document drops to zero `/video/` references. Since that pane holds the only identity in the
   * app, one unconditional click on row 0 made every later row unreadable — the live cause of a
   * snapshot that resolved 1 of 12 rows. Each row is therefore handled by the pure
   * {@link decideRowPreviewAction}:
   *
   *   · already selected -> READ the shared preview, NO click
   *   · not selected     -> click ONCE (preview-only), settle, READ
   *   · state unknown    -> NO click (fail closed), READ
   *
   * With that guard all rows resolve on the FIRST 1200 ms settle (~15 s for 12 rows), so the
   * per-row retry window was dead weight and is gone.
   *
   * A row's PRE-click preview is deliberately NOT recorded: for a clicked row it is the PREVIOUS
   * row's uuid, and recording it would misattribute identity to the wrong row. Exactly one read is
   * recorded per row, after its decided interaction.
   *
   * STRICTLY NON-MUTATING: opens the picker, clicks UNSELECTED rows for preview ONLY, closes with
   * Escape in a `finally`. It NEVER clicks `button.detail-add-to-prompt-btn` ("Add media"), NEVER
   * commits or attaches an asset, and NEVER generates. Attachment remains owned by
   * `attachFirstClipByArtifactId()`.
   *
   * REQUIRES the scene editor to already be open: without an open scene there is no `Add Clip`
   * control, and this fails closed rather than silently reading a different surface.
   */
  async readSceneVideoLibraryUuidsViaPreview(options: { timeoutMs?: number; pollMs?: number; maxRows?: number; rowSettleMs?: number } = {}): Promise<
    {
      ok: true; uuids: string[]; rowsObserved: number; rowsResolved: number;
      unresolvedRows: number[]; duplicateUuidRows: Array<{ uuid: string; rowIndexes: number[] }>;
      completeness: 'COMPLETE'; rowDiagnostics: any[];
    }
    | {
      ok: false; code: 'PICKER_UNAVAILABLE' | 'PICKER_SNAPSHOT_PARTIAL';
      reason: string; rowsObserved: number; rowsResolved: number;
      unresolvedRows: number[]; completeness: 'INVALID' | 'PARTIAL'; rowDiagnostics: any[];
    }
  > {
    const timing = { ...PICKER_TIMING, ...(options.rowSettleMs !== undefined ? { rowPreviewSettleMs: options.rowSettleMs } : {}) };
    const timeoutMs = Math.max(1000, Number(options.timeoutMs ?? timing.hydrationTimeoutMs));
    const pollMs = Math.max(100, Number(options.pollMs ?? timing.hydrationPollMs));
    const maxRows = Math.max(1, Number(options.maxRows ?? timing.maxRows));
    const rowSettleMs = Math.max(100, Number(timing.rowPreviewSettleMs));

    // 0. The scene editor MUST already be open (this is what distinguishes the correct surface).
    const sceneOpen = await this.page.locator('flow-scene-builder').first().isVisible().catch(() => false)
      || await this.page.locator(S.addClipButton[0]).first().isVisible().catch(() => false);
    if (!sceneOpen) {
      return {
        ok: false, code: 'PICKER_UNAVAILABLE', completeness: 'INVALID', rowsObserved: 0, rowsResolved: 0, unresolvedRows: [], rowDiagnostics: [],
        reason: 'no scene editor is mounted, so the scene Add Clip video library cannot be read (the project Add-Ingredients picker has no Videos category and is never used as a substitute).',
      };
    }

    // 1. Open the picker through the SAME production trigger `attachFirstClipByArtifactId()` uses.
    await this.click(S.addClipButton);
    const panel = this.page.locator('div.flow-media-picker-dialog-panel').first();
    const opened = await panel.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
    if (!opened) {
      return {
        ok: false, code: 'PICKER_UNAVAILABLE', completeness: 'INVALID', rowsObserved: 0, rowsResolved: 0, unresolvedRows: [], rowDiagnostics: [],
        reason: 'the scene Add Clip media picker did not open, so the video library cannot be read.',
      };
    }

    const probes: PickerRowPreviewProbe[] = [];
    try {
      // 2. Select the Videos category by the EXISTING normalised exact lookup (never by index).
      //
      // BOUNDED hydration wait — the SAME `awaitCategoryLabels()` driver `resolveArtifactSignedMediaUrl()`
      // already uses, applied to this second call site. The picker's PANEL becomes visible before its
      // category TABS render, so a single immediate label read can observe zero labels on a perfectly
      // healthy picker. This is the generation-path blocker observed live for Scene 3: the identity
      // baseline gate (`waitForStablePickerBaseline`) polls this reader and needs two consecutive
      // identical COMPLETE snapshots, so one single-shot race was enough to refuse Start generation.
      //
      // Semantics are unchanged and still fail-closed: empty or still-growing labels are retried at
      // short bounded intervals within a hard deadline; an absent panel, or a SETTLED category list
      // without Videos, fails immediately; an empty label list is NEVER accepted. No page reload and
      // no additional UI click are introduced.
      const categoryHydration = await awaitCategoryLabels({
        wanted: PROJECT_LIBRARY_VIDEO_CATEGORY,
        read: async () => await this.page.evaluate(() => {
          const panel = document.querySelector('div.flow-media-picker-dialog-panel');
          let panelVisible = false;
          if (panel) {
            const r = panel.getBoundingClientRect();
            const st = getComputedStyle(panel);
            panelVisible = r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
          }
          const labels = Array.from(
            document.querySelectorAll('mat-nav-list mat-list-item[role="tab"], [role="tablist"] [role="tab"]'),
          ).map((el: any) => String(el.innerText || '').replace(/\n/g, ' ').trim()).filter(Boolean);
          return { panelVisible, labels };
        }).catch(() => ({ panelVisible: false, labels: [] as string[] })),
      });
      if (!categoryHydration.ok) {
        return {
          ok: false, code: 'PICKER_UNAVAILABLE', completeness: 'INVALID', rowsObserved: 0, rowsResolved: 0, unresolvedRows: [], rowDiagnostics: [],
          reason: categoryHydration.reason,
        };
      }
      const labels: string[] = categoryHydration.labels;
      const videosTab = findProjectAssetCategory({ labels, wanted: PROJECT_LIBRARY_VIDEO_CATEGORY });
      if (!videosTab.ok) {
        return {
          ok: false, code: 'PICKER_UNAVAILABLE', completeness: 'INVALID', rowsObserved: 0, rowsResolved: 0, unresolvedRows: [], rowDiagnostics: [],
          reason: `the scene media picker's Videos category could not be resolved: ${videosTab.reason}`,
        };
      }
      const tab = this.page.locator('mat-nav-list mat-list-item[role="tab"], [role="tablist"] [role="tab"]').nth(videosTab.index);
      if (!(await tab.count())) {
        return {
          ok: false, code: 'PICKER_UNAVAILABLE', completeness: 'INVALID', rowsObserved: 0, rowsResolved: 0, unresolvedRows: [], rowDiagnostics: [],
          reason: `the "${PROJECT_LIBRARY_VIDEO_CATEGORY}" category resolved at index ${videosTab.index} but is not present.`,
        };
      }
      await tab.click().catch(() => {});
      await new Promise((r) => setTimeout(r, 1400));

      // 3. Bounded hydration gate — reuse the EXISTING pure readiness rule.
      const hydration = await this.waitForPickerHydration(timeoutMs, pollMs);
      if (!hydration.ok) {
        return {
          ok: false, code: 'PICKER_UNAVAILABLE', completeness: 'INVALID', rowsObserved: 0, rowsResolved: 0, unresolvedRows: [], rowDiagnostics: [],
          reason: `the scene video library did not hydrate: ${hydration.reason}`,
        };
      }

      // 4. Read the shared preview. Returns the raw src plus whether the element existed, so an
      //    absent preview is distinguishable from an invalid one.
      const readPreview = async (): Promise<{ src: string; elementPresent: boolean }> => await this.page.evaluate(() => {
        const pane = document.querySelector('flow-add-menu-detail-pane')
          || document.querySelector('div.flow-media-picker-dialog-panel')
          || document.querySelector('mat-dialog-container[role="dialog"]');
        if (!pane) return { src: '', elementPresent: false };
        const vids = Array.from(pane.querySelectorAll('video')) as any[];
        const v: any = vids.find((x) => /flow-content\.google\/video\//i.test(String(x.currentSrc || x.src || '')))
          || pane.querySelector('video.video-preview');
        return { src: v ? String(v.currentSrc || v.src || '') : '', elementPresent: !!v };
      }).catch(() => ({ src: '', elementPresent: false }));

      // PARENT rows only: `button.asset-item[role="option"]` — the nested `flow-add-menu-asset-item`
      // is a CHILD of the same item, so including it would double-count every row.
      const rows = panel.locator('button.asset-item[role="option"]');
      const count = Math.min(await rows.count().catch(() => 0), maxRows);
      const titles: string[] = [];
      for (let i = 0; i < count; i++) {
        titles.push(String(await rows.nth(i).locator('span.asset-title').innerText().catch(() => '') ?? '').trim());
      }

      for (let i = 0; i < count; i++) {
        const reads: PickerRowPreviewRead[] = [];
        // (A) INTERACTION STATE ONLY — `aria-selected` decides whether this row may be clicked.
        //     It is never identity; identity is the shared preview uuid read below.
        const selected = await this.readPickerRowSelectionState(rows.nth(i));
        const decision = decideRowPreviewAction(selected);
        // (B) CLICK only an EXPLICITLY unselected row, exactly once, as a preview action.
        //     A selected row (or an unknown state) is READ instead: clicking the selected row is a
        //     destructive toggle that destroys the detail pane and therefore all remaining identity.
        const clicked = decision.ok && decision.action === 'CLICK';
        if (clicked) await rows.nth(i).click().catch(() => {});
        // (C) The PROVEN 1200 ms settle, then exactly ONE read for this row. No retry window: the
        //     live sweep resolved every row on the first settle, and a retry cannot repair a
        //     destructive toggle.
        const t0 = Date.now();
        await new Promise((r) => setTimeout(r, rowSettleMs));
        const got = await readPreview();
        // EXTRACTION BOUNDARY: this is the ONLY place a preview `src` becomes an identity. The bare
        // uuid is stored as-is; `decideRowPreviewIdentity()` consumes it as an identity and must
        // never parse it as a URL (double extraction silently resolved 0 of 12 live rows).
        reads.push({ uuid: extractPreviewArtifactUuid(got.src), elementPresent: got.elementPresent, elapsedMs: Date.now() - t0 });
        probes.push({ rowIndex: i, title: titles[i] ?? null, reads });
      }
    } finally {
      // ALWAYS close. Never click Add media / Apply / Confirm.
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.locator('.cdk-overlay-container').first().waitFor({ state: 'hidden', timeout: 6000 }).catch(() => {});
    }

    // 5. Completeness gate — PURE, and based on ROW-LEVEL OBSERVABILITY, never on an expected
    //    library size. A PARTIAL snapshot is never a usable generation baseline.
    const classification = classifyPickerSnapshotCompleteness(probes);
    if (classification.completeness === 'INVALID') {
      return {
        ok: false, code: 'PICKER_UNAVAILABLE', completeness: 'INVALID',
        rowsObserved: classification.rowsObserved, rowsResolved: classification.rowsResolved,
        unresolvedRows: classification.unresolvedRows, rowDiagnostics: classification.rowDiagnostics,
        reason: classification.reason,
      };
    }
    if (classification.completeness === 'PARTIAL') {
      return {
        ok: false, code: 'PICKER_SNAPSHOT_PARTIAL', completeness: 'PARTIAL',
        rowsObserved: classification.rowsObserved, rowsResolved: classification.rowsResolved,
        unresolvedRows: classification.unresolvedRows, rowDiagnostics: classification.rowDiagnostics,
        reason: classification.reason,
      };
    }
    return {
      ok: true, uuids: classification.uuids,
      rowsObserved: classification.rowsObserved, rowsResolved: classification.rowsResolved,
      unresolvedRows: classification.unresolvedRows, duplicateUuidRows: classification.duplicateUuidRows,
      completeness: 'COMPLETE', rowDiagnostics: classification.rowDiagnostics,
    };
  }

  /**
   * STABILIZED pre-generation baseline of the TARGET SCENE's video library identities.
   *
   * Mirrors the discipline already proven for the project route (`waitForStableGenerationBaseline`,
   * STEP-8V): only TWO CONSECUTIVE IDENTICAL COMPLETE snapshots may be accepted. A PARTIAL snapshot
   * is discarded and the bounded window continues; an INVALID snapshot is a hard failure. The
   * default budget is DERIVED from the worst case of one full row-probe cycle so that two complete
   * snapshots can physically fit — the previous fixed 30s budget could not (live: a single snapshot
   * consumed most of it, so stabilization was unreachable).
   *
   * SCENE RE-ESTABLISHMENT (live defect). Each snapshot closes the picker with Escape, which also
   * leaves the scene editor unmounted, so a stabilizer that simply re-invoked the snapshot helper
   * short-circuited at its "no scene editor is mounted" precondition and could never stabilize.
   * Every bounded attempt therefore begins with `ensureTargetSceneOpen(targetSceneId)`, which
   * re-establishes the scene by CANONICAL id and fails closed rather than silently reading the
   * library from whichever scene happens to be on screen (Flow auto-creates a different scene on
   * project generation).
   *
   * A canonical target scene id is REQUIRED. No scene title is ever accepted here.
   */
  private async waitForStablePickerBaseline(targetSceneId: string, timeoutMs = pickerBaselineBudgetMs(), pollMs = 900): Promise<string[]> {
    const want = String(targetSceneId ?? '').trim();
    if (!want) {
      throw new Error('Project first-clip generation refused (PICKER_UNAVAILABLE): a canonical targetSceneId is required to stabilize the video-library baseline, because project generation also auto-creates a different scene.');
    }
    const reads: string[][] = [];
    const deadline = Date.now() + Math.max(2000, Number(timeoutMs));
    let lastPartial = '';
    let lastInvalid = '';
    while (true) {
      // Re-establish the SAME canonical target scene before EVERY snapshot attempt, because the
      // previous snapshot closed the picker (and with it the scene editor surface). Losing that
      // context is recorded as unreadable and retried within the bound — never a silent scene switch.
      const sceneBack = await this.ensureTargetSceneOpen(want);
      if (!sceneBack.ok) {
        lastInvalid = `the target scene could not be re-established for a baseline snapshot: ${sceneBack.reason}`;
      } else {
        const snapshot = await this.readSceneVideoLibraryUuidsViaPreview({ timeoutMs: PICKER_TIMING.hydrationTimeoutMs }).catch((e) => ({ ok: false, code: 'PICKER_UNAVAILABLE', reason: String(e?.message ?? e) }) as any);
        if (snapshot?.ok === true) {
          // ONLY a COMPLETE snapshot may feed stabilization.
          reads.push((snapshot as any).uuids as string[]);
          const verdict = stableBaselineFromReads(reads);
          if (verdict.kind === 'stable') return verdict.ids;
        } else if ((snapshot as any)?.code === 'PICKER_SNAPSHOT_PARTIAL') {
          lastPartial = String((snapshot as any).reason ?? '').slice(0, 200);
          reads.length = 0;   // a partial snapshot breaks the consecutive-identity requirement
        } else {
          lastInvalid = String((snapshot as any)?.reason ?? '').slice(0, 200);
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Project first-clip generation refused (BASELINE_UNSTABLE): the target scene ${want} video library did not expose two consecutive identical COMPLETE identity sets within ${timeoutMs}ms; refusing to click Start generation without a stabilized baseline.${lastPartial ? ` Last PARTIAL snapshot: ${lastPartial}.` : ''}${lastInvalid ? ` Last unreadable snapshot: ${lastInvalid}.` : ''}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /**
   * Re-open the EXACT target scene for a post-generation library snapshot.
   *
   * Project-level generation ALSO causes Flow to auto-create a NEW scene. That auto-created scene is
   * NOT the target: it must never silently become the identity context. This helper re-establishes
   * the target by its CANONICAL scene id and fails closed when it cannot, rather than reading the
   * library from whatever scene happens to be on screen.
   */
  private async ensureTargetSceneOpen(targetSceneId: string): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
    const want = String(targetSceneId ?? '').trim();
    if (!want) return { ok: false, reason: 'no target scene id was supplied, so the scene identity context cannot be re-established.' };
    const current = String(this.page.url() ?? '');
    if (!current.includes(`/scene/${want}`)) {
      try { await this.openSceneEditor(want); }
      catch (e: any) {
        return { ok: false, reason: `the target scene ${want} could not be re-opened for the post-generation library snapshot: ${String(e?.message ?? e).slice(0, 160)}` };
      }
      await new Promise((r) => setTimeout(r, 6000));
    }
    const url = String(this.page.url() ?? '');
    if (!url.includes(`/scene/${want}`)) {
      return { ok: false, reason: `expected the target scene ${want} to be mounted after re-open, but the route is ${url}; refusing to read the video library from a different scene.` };
    }
    return { ok: true, url };
  }

  /**
   * Generate ONE scene's FIRST clip through the PROJECT composer.
   *
   * ORDER (each step fail-closed): resolve the single editable project prompt editor → fill the
   * exact prompt → read back and verify the text → verify Start generation is enabled →
   * build a STABILIZED Videos-library identity baseline → click EXACTLY ONCE (behind the
   * structural Start latch) → poll the Videos library for exactly ONE new artifact UUID.
   *
   * IDENTITY SOURCE: the TARGET SCENE's video library, read through that scene's
   * `Add Clip` -> `Videos` picker (`readSceneVideoLibraryUuidsViaPreview`). The
   * project ROUTE is no longer consulted — live-proven to never expose the generated asset — and
   * `waitComplete()` is a bounded auxiliary wait only, never the identity proof. The appearance of
   * exactly one new persistent UUID IS the identity/completion proof.
   *
   * It never retries, never clicks a second time, and never attaches anything.
   */
  async generateProjectFirstClip(prompt: string, options: { targetSceneId?: string } = {}): Promise<{
    editorResolution: ProjectPromptEditorResolution;
    observedPromptText: string;
    startButtonDisabledBeforeClick: boolean | null;
    startClicks: number;
    generationUuid: string | null;
    videoUrl: string | null;
    durationSeconds: number | null;
    audioPresent: boolean | null;
    /** Now the PROJECT VIDEOS LIBRARY identity snapshot, not project-route media refs. */
    projectRouteVideoUuids: readonly string[];
    generatedSceneTitle?: string | null;
    generatedSceneTitleReason?: string | null;
    /** Distinguishes BASELINE_UNSTABLE / PICKER_UNAVAILABLE / NONE / AMBIGUOUS / RESOLVED. */
    generationIdentityCode?: ProjectGenerationIdentityCode | 'BASELINE_UNSTABLE' | 'PICKER_UNAVAILABLE';
    generationIdentityReason?: string | null;
    /** The canonical scene whose video library produced the identity baseline. */
    targetSceneId?: string | null;
    targetSceneUrl?: string | null;
  }> {
    const text = String(prompt ?? '').trim();
    if (!text) throw new Error('generateProjectFirstClip requires a non-empty prompt.');

    // The TARGET SCENE IDENTITY. Project-level generation also makes Flow auto-create a NEW scene;
    // that scene is NOT the target and must never become the identity context. The library baseline
    // and every post-generation snapshot are taken from THIS scene, by canonical id.
    const targetSceneId = String(options.targetSceneId ?? '').trim();
    if (!targetSceneId) {
      throw new Error('generateProjectFirstClip refused (PICKER_UNAVAILABLE): a canonical targetSceneId is required, because generation identity is read from that scene\'s Add Clip video library and project generation also auto-creates a different scene.');
    }
    const sceneContext = await this.ensureTargetSceneOpen(targetSceneId);
    if (!sceneContext.ok) {
      throw new Error(`generateProjectFirstClip refused (PICKER_UNAVAILABLE): ${sceneContext.reason}`);
    }

    // STEP 1 (BEFORE any prompt work): STABILIZED baseline of the TARGET SCENE's video library,
    // read from that scene's Add Clip -> Videos picker. Two consecutive identical reads are
    // required; otherwise this refuses WITHOUT spending a credit.
    let baseline: string[];
    try {
      baseline = await this.waitForStablePickerBaseline(targetSceneId);
    } catch (e: any) {
      return {
        editorResolution: { ok: false, code: 'PROJECT_PROMPT_EDITOR_NOT_FOUND', reason: 'the baseline gate failed before prompt resolution.' },
        observedPromptText: '', startButtonDisabledBeforeClick: null, startClicks: 0,
        generationUuid: null, videoUrl: null, durationSeconds: null, audioPresent: null,
        projectRouteVideoUuids: [], targetSceneId, targetSceneUrl: sceneContext.url,
        generationIdentityCode: 'BASELINE_UNSTABLE',
        generationIdentityReason: String(e?.message ?? e),
      };
    }

    // STEP 2: switch back to the PROJECT route, where the editable first-clip composer lives.
    await this.openProjectRoute();
    await new Promise((r) => setTimeout(r, 4000));

    const candidates = await this.observeProjectPromptEditorCandidates();
    const editorResolution = resolveProjectPromptEditor(candidates);
    if (!editorResolution.ok) {
      return {
        editorResolution, observedPromptText: '', startButtonDisabledBeforeClick: null, startClicks: 0,
        generationUuid: null, videoUrl: null, durationSeconds: null, audioPresent: null,
        projectRouteVideoUuids: [], targetSceneId, targetSceneUrl: sceneContext.url,
      };
    }

    const box = this.page.locator(PROJECT_PROMPT_CONTROLS.projectPromptBox).first();
    // NESTED scope — same correction as observeProjectPromptEditorCandidates(): the host qualifier
    // must not be repeated inside an already-scoped locator.
    const nested = resolveNestedProjectPromptEditorSelector();
    if (!nested.ok) throw new Error(`generateProjectFirstClip refused: ${nested.reason}`);
    const editor = box.locator(nested.nestedSelector).nth(editorResolution.index as number);
    await editor.click();
    await editor.fill(text);

    // READ-BACK via the ProseMirror BLOCK structure, not `innerText()`.
    //
    // Live-proven: the real project composer serialises the prompt into one `<p>` per source line,
    // so `innerText()` reports 1562 chars for a 1532-char prompt (every block boundary rendered as
    // "\n\n") and `textContent()` reports 1505 (separators dropped). Neither is byte-identical, so the
    // old direct comparison failed closed for ANY multi-line prompt. Reading the paragraph texts
    // verbatim and re-joining them with a single newline reproduces the supplied prompt exactly,
    // including intentional blank lines, and keeps the verification byte-identical and strict.
    const paragraphTexts = await editor.evaluate((el: any) => Array.from(el.querySelectorAll(':scope > p'))
      .map((p: any) => String(p.textContent ?? ''))).catch(() => [] as string[]);
    const observedPromptText = renderProjectPromptReadbackFromParagraphs(paragraphTexts).trim();

    const start = this.page.locator(PROJECT_PROMPT_CONTROLS.startGenerationButton).first();
    if (!(await start.isVisible().catch(() => false))) {
      throw new Error('generateProjectFirstClip refused: no project-level Start generation control is visible.');
    }
    const disabledBefore = (await start.isEnabled().catch(() => false)) === false;
    if (disabledBefore) {
      throw new Error('generateProjectFirstClip refused: the project Start generation control is still disabled after the prompt fill.');
    }

    // EXACTLY ONE CLICK, behind the SAME structural latch the project-route generator uses: the
    // delta can only ever be evaluated once `armed` is true, which happens after the single click.
    startGate.armed = false;
    await start.click();
    startGate.armed = true;   // Start has been clicked exactly once; AFTER polling may begin.

    // Bounded auxiliary wait for the composer's own completion signal. It is NOT the identity
    // proof: `waitComplete()` matches a bare `video` selector, so the authoritative proof is the
    // appearance of exactly one new persistent Videos-library UUID below.
    await this.waitComplete(600000).catch(() => {});

    // Bounded poll of the TARGET SCENE's video library. Exactly one new UUID resolves the identity;
    // none keeps polling; more than one (or a duplicate in either snapshot) fails closed.
    const deadline = Date.now() + 15 * 60 * 1000;
    let identity: { ok: true; uuid: string } | { ok: false; reason: string } | null = null;
    let identityCode: ProjectGenerationIdentityCode = 'GENERATION_IDENTITY_NONE';
    let lastSnapshot: string[] = [];
    let snapshotsTaken = 0;
    let sceneContextLost: string | null = null;
    while (Date.now() < deadline) {
      if (!startGate.armed) {
        // Structural gate violation: the delta is being evaluated before Start was clicked.
        return {
          editorResolution, observedPromptText, startButtonDisabledBeforeClick: disabledBefore, startClicks: 1,
          generationUuid: null, videoUrl: null, durationSeconds: null, audioPresent: null,
          projectRouteVideoUuids: [], targetSceneId, targetSceneUrl: sceneContext.url,
          generationIdentityCode: 'GENERATION_IDENTITY_AMBIGUOUS',
          generationIdentityReason: 'the generation identity delta was evaluated before Start generation was armed.',
        };
      }
      // Re-establish the SAME target scene every iteration. Flow auto-creates a DIFFERENT scene on
      // project generation; if the target cannot be re-established we fail closed rather than
      // reading the library from the auto-created scene.
      const sceneBack = await this.ensureTargetSceneOpen(targetSceneId);
      if (!sceneBack.ok) {
        sceneContextLost = sceneBack.reason;
        identity = { ok: false, reason: sceneBack.reason };
        identityCode = 'GENERATION_IDENTITY_AMBIGUOUS';
        break;
      }
      const snapshot = await this.readSceneVideoLibraryUuidsViaPreview({ timeoutMs: 15000, pollMs: 700 }).catch(() => null);
      if (snapshot?.ok) {
        snapshotsTaken++;
        lastSnapshot = snapshot.uuids;
        const verdict = decideProjectGenerationIdentity({ baseline, snapshot: snapshot.uuids });
        identityCode = verdict.code;
        if (verdict.ok) { identity = { ok: true, uuid: verdict.uuid }; break; }
        if (verdict.code === 'GENERATION_IDENTITY_AMBIGUOUS') { identity = { ok: false, reason: verdict.reason }; break; }
        // NONE: the asset is not observable yet — keep polling within the bound.
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    if (!identity) {
      identity = { ok: false, reason: `no new artifact UUID appeared in the target scene's video library within the bounded poll window (last observed ${lastSnapshot.length} library id(s) across ${snapshotsTaken} snapshot(s)${sceneContextLost ? `; ${sceneContextLost}` : ''}).` };
      identityCode = 'GENERATION_IDENTITY_NONE';
    }
    const fresh = identity.ok ? [identity.uuid] : [];
    const videoUrl = identity.ok
      ? `https://flow-content.google/video/${identity.uuid}`
      : null;

    // The generation auto-creates a populated scene. Its title is READ FROM THE EXISTING project-grid
    // tile reader and linked by the EXACT generated /video/<UUID> — never from position, index, grid
    // count or the prompt text. An unresolvable title stays null and the caller fails closed.
    let generatedSceneTitle: string | null = null;
    let titleReason: string | null = null;
    if (fresh.length === 1) {
      try {
        const tiles = await this.resolveFirstClipSceneCandidates();
        const derived = deriveGeneratedSceneTitle({ videoUuid: fresh[0], candidates: tiles });
        generatedSceneTitle = derived.ok ? derived.title : null;
        titleReason = derived.ok ? null : derived.reason;
      } catch (e: any) {
        titleReason = `the generated scene title could not be read: ${String(e?.message ?? e).slice(0, 160)}`;
      }
    }

    return {
      editorResolution, observedPromptText,
      startButtonDisabledBeforeClick: disabledBefore,
      startClicks: 1,
      generationUuid: identity.ok ? identity.uuid : null,
      videoUrl, durationSeconds: null, audioPresent: null,
      projectRouteVideoUuids: lastSnapshot,
      generatedSceneTitle,
      generatedSceneTitleReason: titleReason,
      generationIdentityCode: identity.ok ? 'GENERATION_IDENTITY_RESOLVED' : identityCode,
      generationIdentityReason: identity.ok ? null : identity.reason,
      targetSceneId, targetSceneUrl: sceneContext.url,
    };
  }

  /** READ-ONLY: every observable scene candidate with its exact `/video/<UUID>` identity. */
  async resolveFirstClipSceneCandidates(): Promise<FirstClipSceneCandidate[]> {
    return (await this.page.evaluate(() => {
      const out: Array<{ sceneId: string; title: string; videoUuid: string; route: string }> = [];
      for (const tile of Array.from(document.querySelectorAll('flow-grid-tile-container'))) {
        const title = String(tile.getAttribute('aria-label') ?? '').trim();
        const video = tile.querySelector('video');
        if (!video || !title) continue;
        const u = /\/video\/([0-9a-f-]{36})/i.exec(String(video.currentSrc || video.src || ''));
        const anchor = tile.querySelector('a[href*="/scene/"], a[href*="/edit/"]');
        const href = anchor ? String(anchor.getAttribute('href') ?? '') : '';
        const m = /\/(?:scene|edit)\/([0-9a-f-]{36})/i.exec(href);
        out.push({ sceneId: m ? m[1] : '', title, videoUuid: u ? u[1] : '', route: href });
      }
      return out;
    })) as FirstClipSceneCandidate[];
  }

  async generateSceneVideo(prompt: string, options: { expectedIngredients?: string[] } = {}): Promise<{ title: string; artifactId: string }> {
    const text = String(prompt ?? '').trim();
    if (!text) throw new Error('generateSceneVideo requires a non-empty prompt.');

    // 1-3. The scene builder + its prompt box must be mounted (proves the SCENE-LOCAL surface).
    await this.first([SCENE_LOCAL_GENERATE_CONTROLS.sceneBuilder], 30000).catch(() => { throw new Error('generateSceneVideo refused: FLOW-SCENE-BUILDER is not mounted (not on a scene-editor route).'); });
    const promptBox = this.page.locator(SCENE_LOCAL_GENERATE_CONTROLS.promptBox).first();
    await promptBox.waitFor({ state: 'visible', timeout: 20000 }).catch(() => { throw new Error('generateSceneVideo refused: the scene-local flow-base-prompt-box is not visible.'); });

    const expected = (Array.isArray(options.expectedIngredients) ? options.expectedIngredients : [])
      .map((t) => String(t ?? '').trim()).filter(Boolean);

    // 4-7. Fill the SCENE-LOCAL composer (scoped), never the global one.
    //      The target is resolved by DOM EDITABILITY, never by `.first()`: live-proven, this prompt
    //      box contains a non-editable `contenteditable="false"` ProseMirror that `.first()` hit,
    //      which aborted generation at `locator.fill`. Unresolvable => fail closed before filling.
    const editor = await this.resolveScenePromptEditor(promptBox);
    await editor.waitFor({ state: 'visible', timeout: 15000 }).catch(() => { throw new Error('generateSceneVideo refused: the resolved editable prompt editor is not visible.'); });
    await editor.click();
    await editor.fill(text);

    // 4b. Re-establish the expected ingredient CHIPS after the prompt fill (filling can clear them).
    //     Reuses the EXISTING exact-tag picker; only tags not already attached are selected, so this
    //     is idempotent whether or not `fill` cleared the chips.
    if (expected.length) {
      const present = await this.readSceneComposerIngredientEvidence().catch(() => null);
      const presentTags = classifyIngredientEvidence(expected, present).resolvedTags;
      for (const tag of expected) {
        if (!presentTags.includes(tag)) await this.selectAsset(tag);
      }
    }

    // 4c. Verify ACTUAL attached ingredient evidence — raw prompt text NEVER satisfies this.
    if (expected.length) {
      const evidence = await this.readSceneComposerIngredientEvidence();
      const verdict = verifyIngredientEvidence(expected, evidence);
      if (!verdict.ok) throw new Error(`generateSceneVideo refused: ${verdict.reason}`);
    }

    // 8-9. The SCENE-LOCAL generate control must be enabled.
    const gen = this.page.locator(SCENE_LOCAL_GENERATE_CONTROLS.generateButton).first();
    if (!(await gen.isVisible().catch(() => false))) throw new Error('generateSceneVideo refused: no scene-local flow-generate-icon-button generate control is visible.');
    if (!(await gen.isEnabled().catch(() => false))) throw new Error('generateSceneVideo refused: the scene-local generate control is disabled.');

    // 10. EXACTLY ONE click. BEFORE/AFTER identity come from the SAME authoritative UUID source
    //     (`readGenerationSurfaceArtifactIds`), and the delta uses the existing pure helper. The
    //     object-returning `listProjectVideos()` is deliberately NOT used for identity.
    const beforeIds = await this.readGenerationSurfaceArtifactIds().catch(() => [] as string[]);
    await gen.click();
    await this.waitComplete(600000);
    const afterIds = await this.readGenerationSurfaceArtifactIds().catch(() => [] as string[]);
    const delta = newArtifactIds(beforeIds, afterIds);
    if (delta.kind !== 'ok') {
      throw new Error(`generateSceneVideo: ${delta.kind === 'ambiguous' ? delta.reason : 'no new artifact id appeared on the generation surface after the single click.'}`);
    }
    return { title: '', artifactId: delta.artifactId };
  }

  /**
   * Read the scene composer's ingredient EVIDENCE — READ-ONLY, never clicks Start and never selects
   * a picker row.
   *
   * PROVEN live DOM (no guessing):
   *   BACKGROUND  flow-ingredient-bar → flow-image-ingredient-chip → img.chip-image[src="/image/<UUID>?"]
   *               identity resolved via the navigation rail (button.thumbnail-button[aria-label]).
   *   CHARACTER   flow-ingredient-bar → flow-character-ingredient-chip → img.chip-image[src="/asb/<TOKEN>"]
   *               identity resolved via the character picker rows (img.asset-thumbnail-image[src] → span.asset-title).
   *
   * The previous `[contenteditable="false"]` marker is NOT used. The generic `aria-label="Ingredient"`
   * is never identity. The character picker is consulted ONLY when a character chip is attached
   * (bounded, read-only; closed with Escape; nothing is selected). Tokens are used transiently and
   * are NEVER persisted.
   */
  async readSceneComposerIngredientEvidence(): Promise<{ chipSrcs: string[]; railEntries: Array<{ tag: string; src: string }>; characterChipSrcs: string[] }> {
    const dom = await this.page.evaluate(() => {
      const collect = (chipSelector: string): string[] => {
        const out: string[] = [];
        for (const bar of Array.from(document.querySelectorAll('flow-ingredient-bar'))) {
          for (const chip of Array.from(bar.querySelectorAll(chipSelector))) {
            const img = chip.querySelector('img.chip-image');
            out.push(img ? String(img.getAttribute('src') ?? '') : '');
          }
        }
        return out;
      };
      const railEntries: Array<{ tag: string; src: string }> = [];
      for (const btn of Array.from(document.querySelectorAll('button.thumbnail-button[aria-label]'))) {
        const tag = String(btn.getAttribute('aria-label') ?? '').trim();
        if (!tag) continue;
        const img = btn.querySelector('img');
        railEntries.push({ tag, src: img ? String(img.getAttribute('src') ?? '') : '' });
      }
      return {
        chipSrcs: collect('flow-image-ingredient-chip'),
        characterChipSrcs: collect('flow-character-ingredient-chip'),
        railEntries,
      };
    });

    return { ...dom };
  }

  /** Read the `/asb/` tokens of all currently attached character chips (normalized in Node). */
  private async readCharacterChipTokens(): Promise<string[]> {
    const srcs = await this.page.evaluate(() => {
      const out: string[] = [];
      for (const bar of Array.from(document.querySelectorAll('flow-ingredient-bar'))) {
        for (const chip of Array.from(bar.querySelectorAll('flow-character-ingredient-chip'))) {
          const img = chip.querySelector('img.chip-image');
          if (img) out.push(String(img.getAttribute('src') ?? ''));
        }
      }
      return out;
    });
    return srcs.map((s) => normalizeFlowCharacterToken(s)).filter((t): t is string => !!t);
  }

  /**
   * READ-ONLY per-step diagnostic of the character picker surface. Used only to explain an
   * identity-capture miss; it never clicks, selects or mutates anything.
   */
  private async readCharacterPickerStepDiagnostic(step: number, expectedTag: string): Promise<CharacterPickerStepDiagnostic> {
    const fallback: CharacterPickerStepDiagnostic = { step, pickerOpen: false, addIngredientsVisible: false, charactersCategoryVisible: false, charactersCategoryActive: false, renderedRowCount: 0, renderedTags: [], expectedTagFound: false, tokenReadable: false };
    try {
      return await this.page.evaluate((args: any) => {
        const stepN = Number(args?.step);
        const want = String(args?.expectedTag ?? '');
        const vis = (el: any) => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
        const picker = document.querySelector('flow-add-menu-popover-content');
        const addBtn = document.querySelector("button[aria-label='Add ingredients to the prompt box']");
        const cats = Array.from(document.querySelectorAll("mat-nav-list[aria-label='Category navigation'] mat-list-item[role='tab'], [role='tablist'] [role='tab']"));
        const charCat: any = cats.find((c: any) => /Characters/.test(String(c.textContent ?? '')));
        const rows = Array.from(document.querySelectorAll('flow-add-menu-popover-content button.asset-item[role="option"]'));
        const renderedTags = rows.map((r: any) => String((r.querySelector('span.asset-title') as HTMLElement | null)?.innerText ?? '').trim());
        return {
          step: stepN,
          pickerOpen: vis(picker),
          addIngredientsVisible: vis(addBtn),
          charactersCategoryVisible: vis(charCat),
          charactersCategoryActive: !!charCat && (charCat.getAttribute('aria-selected') === 'true' || String(charCat.className ?? '').includes('active') || charCat.getAttribute('aria-current') === 'true'),
          renderedRowCount: rows.length,
          renderedTags,
          expectedTagFound: renderedTags.includes(want),
          tokenReadable: false,
        };
      }, { step, expectedTag });
    } catch { return fallback; }
  }

  /**
   * BOUNDED, READ-ONLY lookup of ONE expected character's picker row identity, BEFORE selection.
   * The picker must already be open on the Characters category. Uses a finite bounded scroll
   * (MAX 30 attempts) with an explicit settle after each step and NO `scrollHeight` exhaustion
   * signal and NO no-growth early break. Returns the exact tag + `/asb/` token, or null when the
   * expected tag is not found within the bound. It NEVER clicks a row — this is identity capture
   * ONLY; the actual selection is delegated to the proven `selectAsset()`.
   *
   * Also returns per-step diagnostics so an identity-capture miss can be explained (picker open?
   * category active? rows rendered? tag absent? token unreadable?).
   */
  private async findCharacterPickerRowIdentity(expectedTag: string): Promise<{ identity: { tag: string; token: string } | null; diagnostics: CharacterPickerStepDiagnostic[] }> {
    const wanted = String(expectedTag ?? '').trim();
    const diagnostics: CharacterPickerStepDiagnostic[] = [];
    if (!wanted) return { identity: null, diagnostics };
    const picker = this.page.locator(S.assetPicker[0]);
    const list = picker.locator(S.assetList[0]).first();
    const MAX_STEPS = 30;
    for (let step = 0; step < MAX_STEPS; step++) {
      const diag = await this.readCharacterPickerStepDiagnostic(step, wanted);
      const rows = picker.locator(S.assetRow[0]);
      const count = await rows.count().catch(() => 0);
      diag.renderedRowCount = count;
      for (let i = 0; i < count; i++) {
        const row = rows.nth(i);
        const title = String(await row.locator(S.assetTitle[0]).first().innerText().catch(() => '')).trim();
        if (title !== wanted) continue;
        const src = await row.locator('img').first().getAttribute('src').catch(() => null);
        const token = normalizeFlowCharacterToken(src);
        diag.expectedTagFound = true;
        diag.tokenReadable = !!token;
        diagnostics.push(diag);
        if (!token) return { identity: null, diagnostics };
        return { identity: { tag: title, token }, diagnostics };
      }
      diagnostics.push(diag);
      await list.evaluate((el: any) => { el.scrollTop = el.scrollTop + Math.max(300, Math.round((Number(el.clientHeight) || 0) * 0.8)); }).catch(() => {});
      await new Promise((r) => setTimeout(r, 700));
    }
    return { identity: null, diagnostics };
  }

  /**
   * Select ONE character and verify the attachment AT SELECTION TIME.
   *
   * Sequence (the only valid one — Flow REMOVES an already-attached character from the picker):
   *   1. read the current character chip tokens (BEFORE)
   *   2. IDENTITY CAPTURE ONLY: open the picker and read the expected row's tag + `/asb/` token,
   *      then close the picker WITHOUT selecting anything
   *   3. ACTUAL SELECTION: delegate to the proven `selectAsset(expectedTag)` — the SINGLE
   *      production path that performs a character row selection. We deliberately do NOT duplicate
   *      its picker opening / row lookup / scrolling / settle / click / close handling.
   *   4. read the single NEW character chip token (AFTER, same session)
   *   5. compare picker token === chip token via the pure verifier
   *
   * Returns transient transaction evidence only; it never reopens the picker after selection.
   */
  async selectCharacterAssetWithVerification(expectedTag: string): Promise<CharacterAttachmentEvidence> {
    const tag = String(expectedTag ?? '').trim();
    const beforeTokens = await this.readCharacterChipTokens().catch(() => [] as string[]);

    // 2. IDENTITY CAPTURE ONLY (no click, no selection).
    let identity: { tag: string; token: string } | null = null;
    let diagnostics: CharacterPickerStepDiagnostic[] = [];
    try {
      const composer = this.page.locator(S.scenePromptBox[0]).first();
      await this.clickWithin(composer, S.addIngredients);
      const picker = this.page.locator(S.assetPicker[0]);
      await picker.waitFor({ state: 'visible', timeout: 15000 });
      await this.selectAssetCategory('Characters');
      const found = await this.findCharacterPickerRowIdentity(tag);
      identity = found.identity;
      diagnostics = found.diagnostics;
      await this.page.keyboard.press('Escape').catch(() => {});       // close WITHOUT selecting
      await picker.waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
    } catch (e: any) {
      await this.page.keyboard.press('Escape').catch(() => {});
      return verifyCharacterAttachmentSelection({ expectedTag: tag, pickerTag: null, pickerToken: null, chipToken: null, diagnostics });
    }
    if (!identity) {
      return verifyCharacterAttachmentSelection({ expectedTag: tag, pickerTag: null, pickerToken: null, chipToken: null, diagnostics });
    }

    // 3. ACTUAL SELECTION — the proven selectAsset() owns the entire picker interaction.
    try {
      await this.selectAsset(tag);
    } catch (e: any) {
      return verifyCharacterAttachmentSelection({ expectedTag: tag, pickerTag: identity.tag, pickerToken: identity.token, chipToken: null, diagnostics });
    }
    await new Promise((r) => setTimeout(r, 600));

    // 4. AFTER — the single newly inserted character chip.
    const afterTokens = await this.readCharacterChipTokens().catch(() => [] as string[]);
    const fresh = afterTokens.filter((t) => !beforeTokens.includes(t));
    const chipToken = fresh.length === 1 ? fresh[0] : null;   // exactly one new chip, else fail closed

    // 5. VERIFY.
    return verifyCharacterAttachmentSelection({ expectedTag: tag, pickerTag: identity.tag, pickerToken: identity.token, chipToken, diagnostics });
  }

  /**
   * True when the scene timeline contains at least one REAL clip element
   * (`flow-scene-timeline .clip` / `.clip.is-first`). Empty drop slots, drop
   * zones, composer elements, ingredient chips and clip DESCENDANTS never count.
   */
  async sceneHasClip(): Promise<boolean> {
    const evidence = await this.page.evaluate(() => {
      const timeline = document.querySelector('flow-scene-timeline');
      if (!timeline) return [];
      const vis = (el: any) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const isRealClip = (el: any) => {
        const cls = String(el.className ?? '');
        if (!/\bclip\b/.test(cls)) return false;
        if (/\b(clip-body|clip-content|clip-container|clip-button|clip-icon)\b/.test(cls)) return false;   // descendants
        if (/empty|drop-zone|placeholder/i.test(cls)) return false;                                        // empty slot
        if (/\b(empty-timeline-track|cdk-drop-list)\b/.test(cls)) return false;
        return vis(el);
      };
      return Array.from(timeline.querySelectorAll('.clip')).map((el: any) => ({ isClip: isRealClip(el) }));
    });
    return sceneHasAnyClip(evidence as Array<{isClip?: unknown}>);
  }

  /**
   * Attach ONE already-generated project video to an EMPTY scene timeline, then
   * verify the clip survives a scene reopen. Never generates, never retries, and
   * fails closed on duplicate/ambiguous titles or a non-empty timeline.
   */
  async attachVideoClipToTimeline(title: string): Promise<{title:string; attached:true; persistent:true}> {
    const wanted = String(title ?? '').trim();
    if (!wanted) throw new Error('attachVideoClipToTimeline requires an exact video title.');

    // 1. The target scene must start EMPTY (never modify a populated scene).
    if (await this.sceneHasClip()) throw new Error(`attachVideoClipToTimeline refused: the scene already has a clip.`);

    // 2. Add clip → Select media (exactly one click).
    await this.click(S.addClipButton);
    const dialog = this.page.locator(S.selectMediaDialog[0]).first();
    await dialog.waitFor({state:'visible',timeout:15000}).catch(()=>{ throw new Error('attachVideoClipToTimeline failed: the Select media dialog did not open.'); });

    // 3. Videos category (exact, scoped to the dialog; no new selector).
    const videosTab = dialog.locator('[role="tab"], mat-list-item').filter({hasText:/Videos/}).first();
    if (!(await videosTab.isVisible().catch(()=>false))) throw new Error('attachVideoClipToTimeline failed: the Videos category is unavailable in Select media.');
    if (String(await videosTab.getAttribute('aria-selected').catch(()=>'')).trim() !== 'true') await videosTab.click();
    if (String(await videosTab.getAttribute('aria-selected').catch(()=>'')).trim() !== 'true') throw new Error('attachVideoClipToTimeline failed: the Videos category could not be selected.');

    // 4. Exact-title row (search when available), re-resolved after the filter.
    const search = dialog.locator(S.assetSearch[0]).first();
    if (await search.isVisible().catch(()=>false)) await search.fill(wanted);
    const rowsIn = dialog.locator(S.assetList[0]).locator(S.assetRow[0]);
    await rowsIn.first().waitFor({state:'visible',timeout:15000}).catch(()=>{ throw new Error(`attachVideoClipToTimeline failed: no asset rows appeared in Select media.`); });
    const titles = (await rowsIn.locator(S.assetTitle[0]).allInnerTexts().catch(()=>[])).map((t)=>String(t).trim());
    if (!isSingleExactMatch(titles, wanted)) {
      throw new Error(`attachVideoClipToTimeline failed: expected EXACTLY ONE row titled "${wanted}", found ${titles.filter((t)=>t===wanted).length}.`);
    }

    // 5. Click the exact row ONCE (freshly resolved, after re-verifying state).
    const row = dialog.locator(S.assetList[0]).locator(`${S.assetRow[0]}:has(${S.assetTitle[0]}:text-is("${wanted.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"))`).first();
    if (!(await row.isVisible().catch(()=>false))) throw new Error(`attachVideoClipToTimeline failed: the row for "${wanted}" is not visible.`);
    if (!(await row.isEnabled().catch(()=>false))) throw new Error(`attachVideoClipToTimeline failed: the row for "${wanted}" is disabled.`);
    if (!(await dialog.isVisible().catch(()=>false))) throw new Error('attachVideoClipToTimeline failed: the Select media dialog closed before the click.');
    await row.click();
    await dialog.waitFor({state:'hidden',timeout:15000}).catch(()=>{});

    // 6. Immediate timeline evidence.
    const attached = await this.waitForClipEvidence();
    if (classifyImmediateAttachment(0, attached ? 1 : 0) !== 'ATTACHED') {
      throw new Error(`attachVideoClipToTimeline failed: no clip appeared in the timeline after selecting "${wanted}".`);
    }

    // 7. Persistence: reopen the SAME scene and require the clip again.
    const sceneUrl = this.page.url();
    await this.page.goto(sceneUrl, {waitUntil:'domcontentloaded'});
    await this.page.locator('flow-scene-timeline').first().waitFor({state:'visible',timeout:20000}).catch(()=>{});
    const persisted = await this.waitForClipEvidence();
    const classification = classifyClipPersistence(clipPersistenceEvidence(1, persisted ? 1 : 0, false));
    if (classification !== 'PERSISTENT') {
      throw new Error(`attachVideoClipToTimeline failed: clip persistence was ${classification} after reopening the scene.`);
    }
    return { title: wanted, attached: true, persistent: true };
  }

  /**
   * Attach ONE already-generated project video to an EMPTY scene timeline by resolving
   * the exact picker row through the shared PREVIEW UUID (STEP-8ET proof + live 8EU).
   *
   * Flow's first-clip picker rows expose no artifact identity (opaque `/asb/` thumbnails,
   * duplicated titles — 8ER). 8ET proved a row click is PREVIEW-ONLY and that the shared
   * detail pane's `video.video-preview` exposes `flow-content.google/video/<uuid>`, with a
   * separate `button.detail-add-to-prompt-btn` ("Add media") performing the mutation.
   *
   * NON-GENERATIVE. Never matches by title. Fails closed on zero/multiple matches. Clicks
   * "Add media" at most once. Idempotent callers must check for an existing clip first.
   */
  async attachFirstClipByArtifactId(targetArtifactId: string): Promise<{ artifactId: string; attached: true; persistent: true }> {
    const base = String(targetArtifactId ?? '').trim();
    if (!base) throw new Error('attachFirstClipByArtifactId requires a non-empty artifact id.');

    // 1. The scene must start EMPTY (never modify a populated scene).
    if (await this.sceneHasClip()) throw new Error('attachFirstClipByArtifactId refused: the scene already has a clip.');

    // 2. Add clip → the first-clip media picker (exactly one click).
    await this.click(S.addClipButton);
    const picker = this.page.locator('div.flow-media-picker-dialog-panel').first();
    await picker.waitFor({ state: 'visible', timeout: 20000 }).catch(() => { throw new Error('attachFirstClipByArtifactId failed: the media picker did not open.'); });

    const addMedia = this.page.locator('div.flow-media-picker-dialog-panel button.detail-add-to-prompt-btn').first();

    // 3-4. Resolve the EXACT row through the shared detail-pane preview UUID (the same
    //      proven mechanism the canonical empty-scene attach now uses). Fail closed on
    //      0/>1 matches; never title, never row order.
    const resolved = await this.resolvePickerRowByPreviewUuid(base);
    if (!resolved.ok) throw new Error(`attachFirstClipByArtifactId failed: ${resolved.reason}`);
    const previewUuid = base.toLowerCase();

    // 5. Re-verify immediately before the single mutation.
    const addMediaPresent = await addMedia.count().then((c) => c === 1).catch(() => false);
    const decision = decideFirstClipAttachment({ previewArtifactId: previewUuid, targetArtifactId: base, addMediaPresent });
    if (!decision.ok) throw new Error(`attachFirstClipByArtifactId refused: ${decision.reason}`);

    // 6. THE ONLY MUTATION: "Add media", exactly once. A picker that closes/disappears
    //    right after this click is NOT itself a failure (proven live); the fresh-read
    //    persistence verification below is authoritative.
    await addMedia.click().catch(() => {});
    await new Promise((r) => setTimeout(r, 4000));

    // 7. Immediate + fresh-read persistence evidence.
    // 8EX: the fresh reads must WAIT for bounded hydration. A bare clipCount=0 with a
    // transient is-empty marker is STATE A, never NOT_PERSISTED (8EW produced [0,0,1] on
    // the old immediate read; a settled re-read gave [1,1,1]). Each read is settled with
    // a minimum zero-observation window before a zero may be accepted as HYDRATED_EMPTY.
    const immediate = await this.waitForClipEvidence();
    const persisted: number[] = [];
    const MAX_READ_ATTEMPTS = 3;
    for (let i = 0; i < 3; i++) {
      // STEP-8FF: a cold first canonical load after commit can render the clip slower than
      // the bounded hydration window, yielding a genuine HYDRATED_EMPTY on read 1 while the
      // settled read 2/3 observe POPULATED. A first HYDRATED_EMPTY is therefore NOT final:
      // reuse the proven `classifyPersistenceReadRetry` semantics to re-read (bounded) rather
      // than recording a premature 0. No timeout is extended; the retry count is bounded.
      let settledCount = -1;
      for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt++) {
        const sceneRoute = this.canonicalSceneUrl || this.page.url();
        await this.page.goto(sceneRoute, { waitUntil: 'domcontentloaded' }).catch(() => {});
        // STEP-8FD: explicit MOUNT-SURFACE readiness gate BEFORE the first authoritative read.
        // Wait (bounded) for flow-scene-timeline to be laid out AND its .timeline-contents layer
        // to exist, so the first hydration read never races the freshly navigated scene. A
        // surface that never mounts fails closed with a distinct bounded error (never "empty").
        const surfaceReady = await this.waitForSceneSurfaceMounted(30000, 500);
        if (surfaceReady !== 'READY') {
          throw new Error(`attachFirstClipByArtifactId failed: the scene timeline surface did not mount (${surfaceReady}) on read ${i + 1}.`);
        }
        const settled = await this.waitForHydratedTimelineEvidence(30000, 600, 12000);
        settledCount = settled.clipCount;
        const retry = classifyPersistenceReadRetry(settled.clipCount, settled.hydratedEmpty, attempt, MAX_READ_ATTEMPTS);
        if (retry === 'RETRY_READ') { await new Promise((r) => setTimeout(r, 1500)); continue; }
        break;
      }
      persisted.push(settledCount);
    }
    const classification = classifyFirstClipAttachment({ sceneWasEmpty: true, identityResolved: true, immediateClipCount: immediate ? 1 : 0, persistedClipCounts: persisted });
    if (classification !== 'ATTACHED_AND_PERSISTED') {
      throw new Error(`attachFirstClipByArtifactId failed: classification ${classification} (immediate=${immediate ? 1 : 0}, reads=${JSON.stringify(persisted)}).`);
    }
    return { artifactId: base, attached: true, persistent: true };
  }

  /**
   * Bounded MOUNT-GATED hydration settle (STEP-8EZ, extending 8EX).
   *
   * A fresh navigation can report `clipCount:0 + hydratedEmpty:false` while the timeline
   * surface is not yet mounted, so the hydration clock must NOT start until the surface is
   * observable. The mount gate is bounded separately and fails closed with MOUNT_TIMEOUT.
   *
   * After mount: a zero is only accepted as HYDRATED_EMPTY once the bounded hydration
   * window is met AND the zero has stayed stable for the minimum observation duration
   * (the 8AK lesson). A timeout mid-hydration fails closed (`clipCount: -1`).
   */
  private async waitForHydratedTimelineEvidence(
    timeoutMs = 30000,
    intervalMs = 600,
    minZeroObservationMs = 12000,
    mountTimeoutMs = 30000,
    postMountSettleMs = 4000,
  ): Promise<{ clipCount: number; hydratedEmpty: boolean; mounted: boolean; state: string }> {
    const mountStart = Date.now();
    let last: { clipCount: number; hydratedEmpty: boolean; mounted: boolean } = { clipCount: -1, hydratedEmpty: false, mounted: false };

    // ---- MOUNT GATE: do not start the hydration clock until the surface is observable.
    while (true) {
      try { last = await this.readTimelineEvidence(); } catch { /* transient read within bounds */ }
      const mountState = classifyMountAwareObservation({ mounted: last.mounted, mountElapsedMs: Date.now() - mountStart, mountTimeoutMs });
      if (mountState === 'MOUNT_TIMEOUT') return { ...last, state: 'MOUNT_TIMEOUT' };
      if (last.mounted) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    // ---- POST-MOUNT SETTLE (STEP-8FB): even after mount the first authoritative read can
    // still see a transient zero (8FA observed [0,1,1]). Require a short BOUNDED settle tied
    // to the proven mounted condition before the first authoritative observation. This never
    // bypasses hydration classification and never turns a transient zero into success.
    const mountAt = Date.now();
    while (!canTakeFirstAuthoritativeRead({ mounted: last.mounted, postMountElapsedMs: Date.now() - mountAt, settleMs: postMountSettleMs })) {
      if (!last.mounted) break;                       // surface unmounted again → let hydration handle it
      if (Date.now() - mountAt >= postMountSettleMs) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      try { last = await this.readTimelineEvidence(); } catch { /* transient read within bounds */ }
      // If a clip is already visible during settle, proceed immediately (no needless delay).
      if (last.clipCount >= 1) break;
    }

    // ---- HYDRATION CLOCK starts only after mount + bounded settle.
    const start = Date.now();
    let zeroSince: number | null = null;
    let zeroStable = false;
    while (Date.now() - start < timeoutMs) {
      try { last = await this.readTimelineEvidence(); } catch { /* transient read: retry within bounds */ }
      const elapsed = Date.now() - start;
      if (last.clipCount === 0) {
        if (zeroSince === null) zeroSince = Date.now();
        // A zero is "stable" only once it has been observed continuously for the window.
        zeroStable = Date.now() - zeroSince >= minZeroObservationMs;
      } else {
        zeroSince = null;
        zeroStable = false;
      }
      const state = classifyHydrationObservation(last.clipCount, elapsed, minZeroObservationMs, zeroStable);
      if (isFinalHydrationState(state)) return { ...last, state };
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    // Bounded window expired while still HYDRATING → fail closed with an invalid count.
    return { ...last, clipCount: -1, state: 'HYDRATING' };
  }

  /** Bounded poll for real clip evidence (never treats an empty slot as a clip). */
  private async waitForClipEvidence(timeout=20000): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.sceneHasClip()) return true;
      await new Promise((resolve)=>setTimeout(resolve,500));
    }
    return false;
  }

  /**
   * Bounded MOUNT-SURFACE readiness gate (STEP-8FD).
   * Waits for `flow-scene-timeline` to be laid out AND `.timeline-contents` to exist before
   * the attach helper's first authoritative read. Returns 'READY' once the surface is mounted
   * and has passed the post-mount settle, or 'SURFACE_TIMEOUT' on the bounded deadline.
   * Uses only the proven mount selectors; never treats a pre-mount zero as empty.
   */
  private async waitForSceneSurfaceMounted(timeoutMs = 30000, intervalMs = 500, settleMs = 4000): Promise<'READY' | 'SURFACE_TIMEOUT'> {
    const start = Date.now();
    let mountAt: number | null = null;
    while (Date.now() - start < timeoutMs) {
      let mounted = false;
      try {
        mounted = await this.page.evaluate(() => {
          const t = document.querySelector('flow-scene-timeline') as any;
          if (!t) return false;
          const r = t.getBoundingClientRect ? t.getBoundingClientRect() : { width: 0, height: 0 };
          return r.width > 0 && r.height > 0 && !!t.querySelector?.('.timeline-contents');
        });
      } catch { /* transient eval failure within bounds */ }
      const elapsed = Date.now() - start;
      const postMountElapsed = mountAt === null ? 0 : Date.now() - mountAt;
      const readiness = classifyAttachSurfaceReadiness({
        surfaceVisible: mounted,
        surfaceMounted: mounted,
        elapsedMs: elapsed,
        timeoutMs,
        postMountElapsedMs: postMountElapsed,
        settleMs,
      });
      if (readiness === 'READ') return 'READY';
      if (readiness === 'SURFACE_TIMEOUT') return 'SURFACE_TIMEOUT';
      if (readiness === 'SETTLE' && mountAt === null) mountAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return 'SURFACE_TIMEOUT';
  }
  /**
   * Reconcile an ALREADY-GENERATED project video with the scene editor Flow opened.
   *
   * Evidence-backed branch structure (LIVE 8W/8AB/8AA/8AC):
   *   ZERO clips      → attachGeneratedVideoToEmptyScene() (Add Clip → Select media → Videos)
   *   EXACTLY ONE     → verifyPopulatedSceneMedia()  (nav-rail aria-current identity)
   *   MORE THAN ONE   → SceneContainsMultipleClipsError (multi-clip is UNPROVEN: fail closed)
   *
   * Identity is the artifact UUID everywhere — never the title, never DOM order.
   * The generation artifact and the scene media uuid are NOT assumed equal
   * (live 8Y/8Z/8AB disproved that); every acceptance requires exact equality.
   */
  async reconcileGeneratedVideoWithScene(expectedTitle: string, expectedArtifact?: string): Promise<{title:string; attached:true; persistent:true; mode:'already-attached'|'attached'; generatedArtifactId:string; committedSceneArtifactId:string; identitySource:'scene-navigation-rail'}> {
    const wanted = String(expectedTitle ?? '').trim();
    if (!wanted) throw new Error('reconcileGeneratedVideoWithScene requires the expected generated video title.');
    const expectedArtifactId = String(expectedArtifact ?? '').trim();

    const clipCount = await this.countTimelineClips();
    const state = classifySceneState(clipCount);
    if (state === 'AMBIGUOUS') {
      throw new Error(`Video reconciliation refused: the scene's clip count could not be determined (raw=${clipCount}).`);
    }
    if (state === 'MULTI_CLIP') {
      throw new SceneContainsMultipleClipsError(clipCount);
    }

    // Persistence check (STEP-8AH/8AQ + STEP-8BA identity model + STEP-8BH read retry):
    // attachment → validated project route → canonical /scene/<id> → hydration →
    // READ THE SCENE'S COMMITTED MEDIA IDENTITY and ADOPT IT.
    //
    // Identity concepts are distinct (live 8AZ/8AW/8AU):
    //   · generation identity  = the generated artifact UUID (media-selection intent)
    //   · selection identity   = the picker row UUID that was confirmed (8AY)
    //   · committed scene identity = the scene's OWN media UUID after Flow resolves it
    // The committed identity is authoritative; it is NOT asserted equal to the
    // generation artifact (Flow substitutes it — mismatch is expected).
    //
    // Because Flow exposes NO client commit signal and persists intermittently (8BD/8BG),
    // a hydrated-empty read is retried with another FRESH load (READ ONLY — never
    // re-attach, never re-generate). One observation per fresh canonical load.
    const reopenAndReadCommittedOnce = async (): Promise<{ clipCount: number; hydratedEmpty: boolean; committedArtifactId: string }> => {
      const sequence = buildPersistenceReloadSequence(this.projectUrl, this.canonicalSceneUrl);
      if (sequence.length !== 2) {
        throw new Error('Video reconciliation failed: the validated project/scene routes were not captured by openSceneEditor.');
      }
      const [projectRoute, sceneUrl] = sequence;
      // 1. Neutral project route (forces a fresh scene load).
      await this.page.goto(projectRoute, { waitUntil: 'domcontentloaded' });
      const projectReady = await this.first(S.addMedia, 30000).then(() => true).catch(() => false);
      if (!projectReady) {
        throw new Error(`Video reconciliation failed: the project surface did not mount during the persistence refresh (${projectRoute}).`);
      }
      // 2. Canonical scene route.
      await this.page.goto(sceneUrl, { waitUntil: 'domcontentloaded' });
      // Stage 1: the editor must actually mount (timeline + composer) before reading.
      const mounted = await this.page.locator('flow-scene-timeline').first().waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
      const composer = await this.first(S.scenePromptBox, 10000).then(() => true).catch(() => false);
      if (!mounted || !composer) {
        throw new Error(`Video reconciliation failed: the scene editor did not remount on reopen (${sceneUrl}).`);
      }
      // Stage 2: signal-bounded hydration (STEP-8AN semantics, unchanged).
      const evidence = await this.waitForStableTimelineEvidence();
      // Stage 3 (STEP-8BJ): settle the COMMITTED RAIL identity too. Live 8BI proved the
      // rail's `aria-current` UUID can appear ~1 s AFTER the clip renders, so an immediate
      // read can yield '' and fail. Reuse the existing 8AJ bounded, READ-ONLY rail settle
      // (no clicks, no picker, no attach). Only settle when a clip is actually present.
      let railArtifactId = '';
      if (evidence.clipCount === 1) {
        const railSettled = await this.waitForStableActiveRailArtifact();
        railArtifactId = railSettled.kind === 'ok' ? railSettled.artifactId : '';
      }
      const committed = resolveCommittedSceneIdentity(railArtifactId);
      return { clipCount: evidence.clipCount, hydratedEmpty: evidence.hydratedEmpty, committedArtifactId: committed.ok ? committed.artifactId : '' };
    };

    // Bounded READ-ONLY fresh-load retry (STEP-8BH). Never re-attaches, never regenerates.
    const reopenAndReadCommitted = async (): Promise<string> => {
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const r = await reopenAndReadCommittedOnce();
        const decision = classifyPersistenceReadRetry(r.clipCount, r.hydratedEmpty, attempt, maxAttempts);
        if (decision === 'PERSISTED') {
          const committed = resolveCommittedSceneIdentity(r.committedArtifactId);
          if (!committed.ok) throw new Error(`Video reconciliation failed: ${committed.reason}`);
          return committed.artifactId;
        }
        if (decision === 'AMBIGUOUS') throw new Error(`Video reconciliation failed: the scene has ${r.clipCount} clips (expected at most 1).`);
        if (decision === 'INVALID') throw new Error(`Video reconciliation failed: the reopened scene state was invalid (count=${r.clipCount}, hydratedEmpty=${r.hydratedEmpty}).`);
        if (decision === 'NOT_PERSISTED') throw new Error(`Video reconciliation failed: the clip did not persist after ${attempt} fresh reads (count=0).`);
        // decision === 'RETRY_READ' → another fresh load after a short bounded delay.
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error('Video reconciliation failed: unreachable persistence retry state.');
    };

    if (state === 'EMPTY') {
      await this.attachGeneratedVideoToEmptyScene(expectedArtifactId);
      const committedSceneArtifactId = await reopenAndReadCommitted();
      const identity = classifySceneAttachmentIdentity({ committedArtifactId: committedSceneArtifactId, generatedArtifactId: expectedArtifactId });
      // The committed identity (not the generation artifact) is authoritative; a
      // mismatch is diagnostic only and never a failure.
      return { title: wanted, attached: true, persistent: true, mode: 'attached', generatedArtifactId: expectedArtifactId, committedSceneArtifactId: identity.committedArtifactId, identitySource: 'scene-navigation-rail' };
    }

    // SINGLE_CLIP: verify the existing clip via the confirmed nav-rail current-media surface.
    await this.verifyPopulatedSceneMedia(expectedArtifactId);
    const committedSceneArtifactId = await reopenAndReadCommitted();
    const identity = classifySceneAttachmentIdentity({ committedArtifactId: committedSceneArtifactId, generatedArtifactId: expectedArtifactId });
    return { title: wanted, attached: true, persistent: true, mode: 'already-attached', generatedArtifactId: expectedArtifactId, committedSceneArtifactId: identity.committedArtifactId, identitySource: 'scene-navigation-rail' };
  }

  /**
   * Bounded reopen expectation settle, SIGNAL-bounded (STEP-8AN) and reused by the
   * STEP-8BH persistence read. Returns the stable {@link readTimelineEvidence} state.
   *
   * A bare stable zero is NOT trusted: a zero is only treated as settled when Flow's
   * explicit hydrated-empty marker (`div.timeline-contents.is-empty` /
   * `.empty-timeline-track`) is present. Semantics:
   *   · clipCount 1                        → return immediately (1 clip, not hydrated-empty)
   *   · clipCount > 1                      → return immediately (caller fails closed)
   *   · clipCount 0 + hydrated-empty marker → return (genuine empty → retry/NOT_PERSISTED)
   *   · clipCount 0 + no marker            → keep polling (STATE A: clips not yet rendered)
   *   · timeout / invalid                  → return the last observed evidence
   */
  private async waitForStableTimelineEvidence(timeoutMs = 20000, intervalMs = 500): Promise<{ clipCount: number; hydratedEmpty: boolean }> {
    const start = Date.now();
    let last: { clipCount: number; hydratedEmpty: boolean } = { clipCount: -1, hydratedEmpty: false };
    while (Date.now() - start < timeoutMs) {
      try { last = await this.readTimelineEvidence(); } catch { /* transient read: retry within bounds */ }
      const decision = classifyTimelineHydrationEvidence(last.clipCount, last.hydratedEmpty);
      if (decision === 'populated' || decision === 'empty' || decision === 'ambiguous') return last;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return last;
  }

  /**
   * Bounded stable clip-count read (STEP-8AH) retained for callers/tests that only
   * need the numeric count. Delegates to the evidence settle above: 1 ⇒ 1, populated
   * ⇒ 1, hydrated-empty ⇒ 0, ambiguous/timeout ⇒ -1.
   */
  private async waitForStableClipCount(
    timeoutMs = 20000,
    intervalMs = 500,
    _requiredStable = 2,
    _minZeroObservationMs = 10000,
  ): Promise<number> {
    const ev = await this.waitForStableTimelineEvidence(timeoutMs, intervalMs);
    const decision = classifyTimelineHydrationEvidence(ev.clipCount, ev.hydratedEmpty);
    if (decision === 'populated') return 1;
    if (decision === 'empty') return 0;
    return -1;
  }

  /** Read the single ACTIVE navigation-rail media artifact id (STEP-8AA). */
  private async readActiveRailArtifact(): Promise<{ artifactId: string }> {
    const items = await this.page.evaluate(() => {
      const rail: any = document.querySelector('flow-navigation-rail');
      if (!rail) return [];
      return Array.from(rail.querySelectorAll('flow-navigation-rail-thumbnail')).map((it: any) => {
        const btn: any = it.querySelector('button.thumbnail-button') || it.querySelector('button');
        const img: any = it.querySelector('img.thumbnail-image, img');
        return { ariaCurrent: btn ? btn.getAttribute('aria-current') : null, imgSrc: String(img?.getAttribute('src') || img?.currentSrc || '') };
      });
    }) as Array<{ ariaCurrent: string | null; imgSrc: string }>;
    const resolved = resolveActiveRailArtifact(items);
    return { artifactId: resolved.kind === 'ok' ? resolved.artifactId : '' };
  }

  /**
   * Count REAL timeline clips AND report whether the timeline's media layer has
   * HYDRATED (STEP-8AN). Live evidence:
   *   EMPTY scene     → `div.timeline-contents.is-empty` + `div.empty-timeline-track`
   *   POPULATED scene → `div.timeline-contents` (NO `is-empty`)
   * `is-empty` (or the `empty-timeline-track` child) is Flow's explicit hydrated-empty
   * marker, so its presence proves the media layer finished loading and is genuinely
   * empty — distinguishing STATE A (mounted, clips not yet rendered) from STATE B
   * (hydrated and empty). A nonzero clip count is itself hydration evidence.
   */
  private async readTimelineEvidence(): Promise<{ clipCount: number; hydratedEmpty: boolean; mounted: boolean }> {
    const ev = await this.page.evaluate(() => {
      const timeline = document.querySelector('flow-scene-timeline');
      if (!timeline) return { evidence: [] as Array<{ isClip?: unknown }>, hydratedEmpty: false, mounted: false };
      // MOUNT GATE (STEP-8EZ): the surface is only observable once the timeline element is
      // laid out AND its contents layer exists. A fresh navigation can have the element in
      // the DOM but not yet sized/rendered — a zero then is NOT a valid empty observation.
      const rect = (timeline as any).getBoundingClientRect ? (timeline as any).getBoundingClientRect() : { width: 0, height: 0 };
      const contents = (timeline as any).querySelector?.('.timeline-contents');
      const mounted = rect.width > 0 && rect.height > 0 && !!contents;
      const vis = (el: any) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const isRealClip = (el: any) => {
        const cls = String(el.className ?? '');
        if (!/\bclip\b/.test(cls)) return false;
        if (/\b(clip-body|clip-content|clip-container|clip-button|clip-icon)\b/.test(cls)) return false;
        if (/empty|drop-zone|placeholder/i.test(cls)) return false;
        if (/\b(empty-timeline-track|cdk-drop-list)\b/.test(cls)) return false;
        return vis(el);
      };
      const contentsCls = contents ? String(contents.className ?? '') : '';
      const hydratedEmpty = /(?:^|\s)is-empty(?:\s|$)/.test(contentsCls) || !!(timeline as any).querySelector?.('.empty-timeline-track');
      return { evidence: Array.from(timeline.querySelectorAll('.clip')).map((el: any) => ({ isClip: isRealClip(el) })), hydratedEmpty, mounted };
    });
    const normalized = normalizeClipCount(ev.evidence as Array<{ isClip?: unknown }>);
    return { clipCount: normalized.ambiguous ? -1 : normalized.count, hydratedEmpty: ev.hydratedEmpty, mounted: (ev as any).mounted === true };
  }

  /** Count REAL timeline clips (excludes empty slots/containers/descendants). */
  private async countTimelineClips(): Promise<number> {
    return (await this.readTimelineEvidence()).clipCount;
  }

  /**
   * Read the single timeline clip's identity artifact: the UUID embedded in its
   * thumbnail/poster URL. Returns '' when the DOM exposes nothing (⇒ caller must
   * fail closed). No title/fuzzy guessing.
   */
  private async readTimelineClipIdentity(): Promise<{ artifactId: string }> {
    const artifactId = await this.page.evaluate(() => {
      const timeline = document.querySelector('flow-scene-timeline');
      if (!timeline) return '';
      const uuids = new Set<string>();
      for (const img of Array.from(timeline.querySelectorAll('img'))) {
        const src = String((img as any).getAttribute('src') || '') + ' ' + String((img as any).getAttribute('poster') || '');
        const m = src.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        if (m) uuids.add(m[0]);
      }
      const html = timeline.outerHTML || '';
      for (const m of html.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) uuids.add(m[0]);
      return uuids.size === 1 ? Array.from(uuids)[0] : (uuids.size === 0 ? '' : '');
    }) as string;
    return { artifactId: String(artifactId ?? '').trim() };
  }

  // Phase 1 (post-search): let Flow's Angular/CDK search/filter transition
  // finish before the 400ms asset-row stability guard starts. Polls the exact
  // picker-scoped row, tolerates transient absence, and returns once the target
  // has stayed present/visible/enabled for a short debounce. Never clicks and
  // never caches an ElementHandle — the locator is re-resolved every sample.
  private async waitForAssetSearchResultsToSettle(
    resolveRow: ()=>Locator,
    debounceMs=300,
    intervalMs=70,
    timeoutMs=5000,
  ) {
    const present=async (): Promise<boolean> => {
      const row=resolveRow();
      if ((await row.count()) !== 1) return false;
      if (!(await row.isVisible().catch(()=>false))) return false;
      if (!(await row.isEnabled().catch(()=>false))) return false;
      return true;
    };
    const deadline=Date.now()+timeoutMs;
    let presentSince=0;
    while (Date.now() < deadline) {
      if (await present()) {
        if (!presentSince) presentSince=Date.now();
        else if (Date.now()-presentSince >= debounceMs) return;
      } else {
        presentSince=0; // transient appearance gap -> reset the debounce
      }
      await new Promise((resolve)=>setTimeout(resolve,intervalMs));
    }
    throw new Error('Asset selection failed: the search results did not settle — the target asset row did not appear.');
  }
  // Wait until the exact picker row is continuously resolvable and DOM-stable
  // (count 1, visible, enabled, unchanged boundingBox + class) for a short
  // window. Immediately after the Images switch / search fill Flow's CDK list
  // re-renders and the row can transiently disappear — that is tolerated: an
  // absent/invalid sample only resets the stability window and polling continues
  // until the overall deadline. Only the overall timeout is fatal. Re-resolves
  // the locator on every sample, so no ElementHandle is ever retained.
  private async waitForAssetRowToSettle(
    resolveRow: ()=>Locator,
    windowMs=400,
    intervalMs=80,
    timeoutMs=15000,
  ) {
    const signature=async (): Promise<string> => {
      const row=resolveRow();
      if ((await row.count()) !== 1) return '';
      if (!(await row.isVisible().catch(()=>false))) return '';
      if (!(await row.isEnabled().catch(()=>false))) return '';
      const box=await row.boundingBox();
      if (!box) return '';
      const cls=await row.getAttribute('class').catch(()=>null);
      if (cls === null || cls === undefined) return '';
      return `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}|${String(cls)}`;
    };
    const deadline=Date.now()+timeoutMs;
    let previous: string|null=null;
    let stableSince=0;
    while (Date.now() < deadline) {
      const current=await signature();
      if (!current) {
        // Transient post-filter disappearance: reset the window, keep polling.
        previous=null;
        stableSince=0;
      } else if (current !== previous) {
        previous=current;
        stableSince=Date.now();
      } else if (Date.now()-stableSince >= windowMs) {
        return;
      }
      await new Promise((resolve)=>setTimeout(resolve,intervalMs));
    }
    throw new Error('Asset selection failed: the asset row never settled before the click.');
  }
  // Category switch in the ingredient picker (e.g. "Images" for backgrounds).
  // Returns whether the category was actually applied, so selectAsset() can tell
  // "category nav absent but the exact target is already available" apart from
  // "category nav absent and the target is unavailable".
  private async selectAssetCategory(label:string): Promise<boolean> {
    const tab=this.page.locator(S.assetPicker[0]).locator(S.assetCategory[0]).filter({hasText:label}).first();
    if (!(await tab.isVisible().catch(()=>false))) return false;
    await tab.click();
    return true;
  }
  async download(output:string, filename:string) { const link=await this.first(S.download); const [download]=await Promise.all([this.page.waitForEvent('download'),link.click()]); await download.saveAs(`${output}/${filename}`); }
}

export async function start(url:string, userDataDir:string, log:(e:string,d?:any)=>void) {
  ensureBrowsersPath();
  const { chromium } = await import('playwright');
  // Prefer the installed Google Chrome: Google blocks sign-in from Playwright's
  // bundled Chromium ("This browser or app may not be secure"). Anti-automation
  // flags keep Flow usable once signed in. Set FLOW_BROWSER_CHANNEL= to force the
  // bundled Chromium instead.
  const channel = process.env.FLOW_BROWSER_CHANNEL ?? 'chrome';
  const baseOptions:any = {
    headless: false,
    acceptDownloads: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, channel ? { ...baseOptions, channel } : baseOptions);
  } catch (error) {
    if (!channel) throw error;
    log('channel_fallback', { channel, error: String(error) });
    context = await chromium.launchPersistentContext(userDataDir, baseOptions);
  }
  // tsx/esbuild (keepNames) emits `__name(...)` helper references inside the
  // function bodies we serialize into page.evaluate(). Provide a no-op shim in
  // every page/frame BEFORE any evaluate runs — and never overwrite an existing
  // implementation. Browser-only: no Node globals, returns the function unchanged.
  await context.addInitScript({ content: 'window.__name = window.__name || function(f){ return f; };' });
  const page=context.pages()[0] ?? await context.newPage(); await page.goto(url,{waitUntil:'domcontentloaded'}); return {context,page,flow:new FlowClient(page,log)};
}
