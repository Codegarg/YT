/**
 * Production SceneExecutor adapter (STEP-8GN).
 *
 * THIN bridge between the workflow's scene-execution boundary and the EXISTING single-scene
 * Flow workflow. It does NOT reimplement any Flow behaviour:
 *
 *   projectWorkflow → SceneExecutor (this adapter) → processSingleFlowScene() → FlowClient
 *
 * Responsibilities (and ONLY these):
 *   · validate project isolation (pipeline/project must match the requested project)
 *   · forward the existing options (projectId, inputRoot, outputsRoot, allowGeneration, ffprobe)
 *   · delegate the real decision + generation + download + checkpoint to processSingleFlowScene
 *   · promote the produced local Flow clip to the orchestrator's scene output path
 *
 * Render-mode dispatch (8GM follow-up): the orchestrator's inspection already decides
 * `renderMode`. SUPPLIED_VIDEO keeps the exact proven Flow/USE_LOCAL path above. LOCAL_SYNTHESIS
 * is delegated to the EXISTING, tested `sceneRenderer.renderScene()` — the renderer that already
 * implements both modes, background rendering, character compositing, deterministic motion and
 * fail-closed output validation. No rendering logic is duplicated here: this adapter only builds
 * the renderer's documented input from the already-resolved inspection + canonical input paths,
 * and the orchestrator still owns the output path and the render sidecar.
 *
 * Anything else (notably `NONE`) fails closed. It never falls back to Flow generation and never
 * substitutes another scene or asset.
 *
 * Explicit non-responsibilities (owned by the existing implementation, never duplicated here):
 *   Flow selectors, scene generation, Add Clip logic, download transport, checkpoint schema,
 *   Flow identity, retry/backoff, browser lifecycle, project-entry navigation, Flow session lock,
 *   render-mode policy (sceneState), duration policy (sceneRender), placement geometry validation
 *   (characterComposite), asset validation (characterAsset / assetCache), FFmpeg graph + output
 *   gates (sceneRenderer).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { processSingleFlowScene, sceneCheckpointPath, readSceneCheckpoint, type ProcessSceneConfig, type ProcessSceneResult } from './sceneFlowWorkflow.js';
import type { SceneLocalAuthorization } from './sceneGenerationPolicy.js';
import type { GenerationApproval, GenerationPolicy } from './generationAttempts.js';
import { detectWardrobeMode } from './characterWardrobe.js';
import { renderScene } from './sceneRenderer.js';
import { motionFromSceneText, sceneClipFilename } from './sceneRender.js';
import { safeTagStem } from './assetCache.js';
import type { CharacterPlacement } from './characterComposite.js';
import type { SceneExecutor } from './projectWorkflow.js';

export interface CreateRealSceneExecutorOptions {
  /** The project this executor is bound to. Every call must match. */
  projectId: string;
  /** Absolute project input root (production/inputs/<project-id>). */
  inputRoot: string;
  /** Base outputs root for checkpoints (production/outputs). */
  outputsRoot: string;
  /**
   * The pipeline scenes (or a lookup). Used ONLY to resolve the exact pipeline scene for a scene
   * number — the adapter never derives prompts or identity itself.
   */
  pipeline?: any;
  /** Generation permission forwarded verbatim to the existing workflow. Default FALSE. */
  allowGeneration?: boolean;
  /**
   * OPT-IN exact authorization for an existing scene to be extended/regenerated. It is forwarded
   * verbatim to the workflow and is never inferred here. Absent/null keeps the legacy path.
   */
  sceneLocalAuthorization?: SceneLocalAuthorization | null;
  /** Bounded paid-submission policy forwarded to the workflow (defaults to env/defaults). */
  generationPolicy?: Partial<GenerationPolicy>;
  /** Explicit operator approval for one recovery attempt (defaults to the env approval surface). */
  generationApproval?: GenerationApproval;
  ffprobePath?: string;
  /** FFmpeg executable for the existing LOCAL_SYNTHESIS renderer (defaults to PATH/env). */
  ffmpegPath?: string;
  /** Overwrite an existing scene output (default true, matching the existing renderer). */
  overwrite?: boolean;
  /** Download directory override forwarded to the existing workflow. */
  downloadDir?: string;
  /**
   * The existing FlowClient (or a compatible stub). Injected so this adapter owns NO browser
   * lifecycle. When absent the executor fails closed with a clear reason (it never fabricates
   * Flow work).
   */
  flow?: any;
  /** Optional flow provider for a later production wiring (still owned elsewhere). */
  flowProvider?: () => Promise<any>;
}

/** Normalise a scene number from either the inspection shape or the pipeline scene shape. */
export function sceneNumberFor(scene: any): number {
  return Number(scene?.sceneNumber ?? scene?.scene_number);
}

/** Fail-closed project-isolation check. */
export function assertProjectMatch(expected: string, actual: unknown): { ok: true } | { ok: false; reason: string } {
  const a = String(actual ?? '').trim();
  if (!a) return { ok: false, reason: 'Scene executor received no projectId.' };
  if (a !== String(expected)) return { ok: false, reason: `Scene executor project mismatch: expected "${expected}", got "${a}".` };
  return { ok: true };
}

/** A processSingleFlowScene success status means a valid local Flow clip exists at `dest`. */
export function isSceneWorkflowSuccess(status: unknown): boolean {
  return status === 'LOCAL_CLIP_ALREADY_VALID'
    || status === 'FLOW_SCENE_ALREADY_COMMITTED'
    || status === 'DOWNLOAD_SUCCESS'
    || status === 'SCENE_LOCAL_EXTENSION_COMPLETE'
    || status === 'SCENE_LOCAL_REGENERATE_COMPLETE';
}

/** Render modes the adapter can serve. `NONE` (invalid/unresolved inputs) is deliberately absent. */
export type DispatchableRenderMode = 'SUPPLIED_VIDEO' | 'LOCAL_SYNTHESIS';

/** PURE: the orchestrator inspection's render mode, or null when it is not dispatchable. */
export function decideRenderDispatch(renderMode: unknown): { action: DispatchableRenderMode } | { action: 'FAIL_CLOSED'; reason: string } {
  const m = String(renderMode ?? '').trim();
  if (m === 'SUPPLIED_VIDEO') return { action: 'SUPPLIED_VIDEO' };
  if (m === 'LOCAL_SYNTHESIS') return { action: 'LOCAL_SYNTHESIS' };
  return { action: 'FAIL_CLOSED', reason: `Scene render mode ${JSON.stringify(renderMode)} is not dispatchable (expected SUPPLIED_VIDEO or LOCAL_SYNTHESIS); refusing to fall back to Flow generation or substitute another asset.` };
}

/**
 * PURE: canonical background path for a scene from the existing input layout.
 * Uses the existing `safeTagStem()` contract; never guesses or searches elsewhere.
 */
export function resolveBackgroundImagePath(inputRoot: string, backgroundTag: unknown): { ok: true; path: string } | { ok: false; reason: string } {
  const stem = safeTagStem(backgroundTag);
  if (!stem) return { ok: false, reason: `Unsafe or missing background tag ${JSON.stringify(backgroundTag)}.` };
  return { ok: true, path: path.join(path.resolve(inputRoot), 'backgrounds', `${stem}.png`) };
}

/**
 * PURE, deterministic character placement layout for LOCAL_SYNTHESIS.
 *
 * Layout rule (stable and reproducible, no randomness): characters are laid out left-to-right in
 * pipeline order across an even split of the frame, bottom-aligned, each occupying
 * `CHARACTER_HEIGHT_FRACTION` of the output height while preserving the 1:1 cutout aspect implied
 * by `characterAsset` validation (square-ish). Geometry itself is validated downstream by
 * `resolveCharacterPlacements()` — this function only proposes coordinates.
 */
export const CHARACTER_HEIGHT_FRACTION = 0.72;

export function layoutCharacterPlacements(
  tags: readonly unknown[],
  width: number,
  height: number,
): { ok: true; placements: CharacterPlacement[] } | { ok: false; reason: string } {
  const list = (tags ?? []).map((t) => String(t ?? '').trim()).filter((t) => t.length > 0);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return { ok: false, reason: `Invalid output size ${width}x${height}.` };
  }
  if (list.length === 0) return { ok: true, placements: [] };
  const charHeight = Math.max(1, Math.round(height * CHARACTER_HEIGHT_FRACTION));
  const charWidth = charHeight;                 // square-ish cutout
  const slot = Math.floor(width / list.length);
  const placements: CharacterPlacement[] = list.map((tag, i) => {
    const x = Math.max(0, Math.min(width - charWidth, Math.round(slot * i + (slot - charWidth) / 2)));
    const y = Math.max(0, height - charHeight);
    return { characterTag: tag, assetPath: '', x, y, width: charWidth, height: charHeight, opacity: 1, zIndex: i };
  });
  return { ok: true, placements };
}

/**
 * The ONLY checkpoint statuses that mean Flow actually produced or committed this scene.
 *
 * Deliberately an explicit allowlist. A broad `/^(FLOW_|DOWNLOAD_)/` prefix is WRONG here, because
 * `FLOW_GENERATION_REQUIRED` / `FLOW_GENERATION_FAILED` / `FLOW_SCENE_NOT_COMMITTED` /
 * `FLOW_COMMIT_NOT_PROVEN` / `DOWNLOAD_FAILED` all record that Flow owns NO usable clip. Treating
 * those as Flow ownership would divert perfectly renderable LOCAL_SYNTHESIS scenes into the Flow
 * workflow, which then correctly refuses without a Flow client.
 */
export const FLOW_OWNERSHIP_STATUSES: ReadonlySet<string> = new Set([
  'FLOW_SCENE_ALREADY_COMMITTED', 'FLOW_SCENE_GENERATED', 'DOWNLOAD_SUCCESS', 'DOWNLOAD_ALREADY_VALID',
  'SCENE_LOCAL_EXTENSION_COMPLETE', 'SCENE_LOCAL_REGENERATE_COMPLETE',
]);

/**
 * PURE: does Flow still own this scene, i.e. is there a committed/produced Flow artifact that a
 * local synthesis would be substituting?
 *
 * Separate from `checkpointProvesFlowCommit()` on purpose: that predicate is the existing
 * provenance-labelling contract for `local_clip_provenance: 'human-provided-local-recovery'` and is
 * intentionally broad. Only a real `committed_scene_artifact_id` or one of the allowlisted ownership
 * statuses proves Flow ownership for the purposes of render-mode dispatch.
 */
export function checkpointProvesFlowOwnership(checkpoint: { committed_scene_artifact_id?: string | null; workflow_status?: unknown } | null | undefined): boolean {
  if (checkpoint === null || checkpoint === undefined) return false;
  const committedId = typeof checkpoint.committed_scene_artifact_id === 'string' ? checkpoint.committed_scene_artifact_id.trim() : '';
  if (committedId !== '') return true;
  return FLOW_OWNERSHIP_STATUSES.has(String(checkpoint.workflow_status));
}

/**
 * Build the production SceneExecutor bound to ONE project. The returned function matches the
 * existing orchestrator SceneExecutor contract (scene inspection, outputPath, context).
 */
export function createRealSceneExecutor(opts: CreateRealSceneExecutorOptions): SceneExecutor {
  const expectedProject = String(opts.projectId);
  const scenesByNumber = new Map<number, any>();
  for (const s of (opts.pipeline?.scenes ?? []) as any[]) {
    const n = Number(s?.scene_number);
    if (Number.isInteger(n)) scenesByNumber.set(n, s);
  }

  return async (scene: any, outputPath: string, context?: { projectId?: string; inputRoot?: string; outputsDir?: string; width?: number; height?: number }): Promise<{ ok: boolean; reason?: string }> => {
    // 1. Project isolation — fail closed BEFORE any workflow/Flow invocation.
    const matched = assertProjectMatch(expectedProject, context?.projectId ?? expectedProject);
    if (!matched.ok) return { ok: false, reason: matched.reason };

    const n = sceneNumberFor(scene);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, reason: `Scene executor received an invalid scene number: ${String(n)}.` };

    // 2. Resolve the pipeline scene by number (never re-derive prompts/identity here).
    const pipelineScene = scenesByNumber.get(n);
    if (!pipelineScene) return { ok: false, reason: `Scene ${n} is not present in the bound pipeline.` };

    // 2b. RENDER-MODE DISPATCH (pure decision from the orchestrator's own inspection).
    // SUPPLIED_VIDEO keeps the proven Flow/USE_LOCAL path unchanged; LOCAL_SYNTHESIS goes to the
    // existing sceneRenderer; anything else fails closed without touching Flow.
    //
    // The orchestrator ALWAYS supplies the inspection, so `renderMode` is present on every real
    // production call (productionOrchestrator.ts passes `item.inspection`, which always carries
    // `renderMode`). An ABSENT mode therefore means the legacy bare-scene executor shape
    // (`{ sceneNumber }`), which historically delegated straight to processSingleFlowScene. That
    // pre-existing contract is preserved below; only a mode that IS supplied but unsupported
    // (NONE, AUTO, garbage) fails closed.
    const suppliedRenderMode = (scene as any)?.renderMode;
    const hasExplicitRenderMode = suppliedRenderMode !== undefined && suppliedRenderMode !== null
      && String(suppliedRenderMode).trim() !== '';

    // Resolve the OPTIONAL Flow client ONCE, before dispatch. It is optional: with no client the
    // LOCAL_SYNTHESIS branch still renders locally (it never *requires* Flow).
    const flow = opts.flow ?? (opts.flowProvider ? await opts.flowProvider() : undefined);
    const hasSceneLocalAuthorization = opts.sceneLocalAuthorization !== undefined && opts.sceneLocalAuthorization !== null;

    if (hasExplicitRenderMode) {
      const dispatch = decideRenderDispatch(suppliedRenderMode);
      if (dispatch.action === 'FAIL_CLOSED') {
        // `sceneState` reports renderMode NONE when a scene has NO usable local media
        // (`sceneState.ts:325-329`) — which is EXACTLY the state Flow generation exists for.
        // Failing closed there made generation unreachable: the only Flow path (processSingleFlowScene,
        // which alone decides USE_LOCAL / GENERATE / DOWNLOAD) was only reachable from a dispatchable
        // mode, and a clip-less scene never produced one.
        //
        // The bypass is deliberately narrow and credit-safe. All of the following must hold:
        //   · the mode is exactly NONE (not AUTO, not a malformed value),
        //   · there is genuinely no local media to substitute,
        //   · generation is EXPLICITLY authorised (`--run-flow`), and
        //   · a real Flow client is present.
        // Otherwise it still fails closed, so the zero-credit default and every other unusable
        // input (invalid clip, DURATION_CONFLICT, garbage mode) are unchanged, and no other asset
        // is ever substituted: processSingleFlowScene re-decides from its own evidence.
        const isFlowGenerationCase =
          String(suppliedRenderMode).trim() === 'NONE'
          && String((scene as any)?.suppliedClip?.state ?? '').trim().toUpperCase() === 'MISSING'
          && opts.allowGeneration === true
          && !!flow
          // The ordinary first-clip path uses the project composer. An explicit scene-local
          // authorization instead uses generateSceneVideo(), so requiring generateProjectVideo here
          // would make a valid authorized target unreachable.
          && (typeof (flow as any).generateProjectVideo === 'function' || hasSceneLocalAuthorization);
        if (!isFlowGenerationCase) return { ok: false, reason: `Scene ${n}: ${dispatch.reason}` };
      }

      // An explicit scene-local authorization is NEVER handled by local synthesis: even if the
      // orchestrator classified the missing local file as LOCAL_SYNTHESIS, the workflow must first
      // verify the exact target/committed clip and either run the authorized lifecycle or stop.
      if (dispatch.action === 'LOCAL_SYNTHESIS' && !hasSceneLocalAuthorization) {
        const inspection = scene as any;

        // FLOW PROVENANCE OUTRANKS LOCAL_SYNTHESIS.
        // `sceneState` cannot see Flow commitments, so a scene that Flow already committed but whose
        // local clip is missing still inspects as LOCAL_SYNTHESIS. Rendering a local stand-in there
        // would silently discard committed Flow work — i.e. substitute another asset. Two existing,
        // read-only, credit-free signals decide whether Flow still owns the scene:
        //   1. a prior checkpoint proving Flow commitment (resume / recovery), and
        //   2. the live `sceneHasClip()` probe — the SAME read-only probe processSingleFlowScene uses,
        //      and which it only performs when local media is unusable (exactly this branch).
        // Neither can generate or spend credits. When Flow owns the scene we fall through to the
        // existing workflow so the clip is recovered by DOWNLOAD.
        //
        // `checkpointProvesFlowOwnership` (NOT `checkpointProvesFlowCommit`) decides this: a
        // FLOW_GENERATION_REQUIRED checkpoint records that Flow has nothing, so it must not block a
        // local render.
        let flowOwnsScene = false;
        try {
          const priorCheckpoint = await readSceneCheckpoint(sceneCheckpointPath(opts.projectId, n, opts.outputsRoot ?? 'outputs'));
          flowOwnsScene = checkpointProvesFlowOwnership(priorCheckpoint);
        } catch { flowOwnsScene = false; }
        if (!flowOwnsScene && typeof flow?.sceneHasClip === 'function') {
          flowOwnsScene = await Promise.resolve(flow.sceneHasClip()).then((c: unknown) => c === true, () => false);
        }

        if (!flowOwnsScene) {
          const bg = resolveBackgroundImagePath(opts.inputRoot, inspection?.backgroundTag ?? pipelineScene?.background_tag);
          if (!bg.ok) return { ok: false, reason: `Scene ${n} background resolution failed: ${bg.reason}` };
          const width = Number(context?.width) || 1920;
          const height = Number(context?.height) || 1080;
          const tags: string[] = Array.isArray(inspection?.characterTags) ? inspection.characterTags : (pipelineScene?.character_tags ?? []);
          const layout = layoutCharacterPlacements(tags, width, height);
          if (!layout.ok) return { ok: false, reason: `Scene ${n} character layout failed: ${layout.reason}` };

          // renderScene() can ONLY write the canonical `<outputDir>/scene-####.mp4` name (it derives
          // it from the scene number). The orchestrator owns `outputPath`, so refuse to run unless
          // the two agree — otherwise a "successful" render would land where the pipeline never
          // reads it.
          const canonicalName = sceneClipFilename(n);
          if (path.basename(outputPath) !== canonicalName) {
            return { ok: false, reason: `Scene ${n}: requested output path ${JSON.stringify(path.basename(outputPath))} is not the canonical local-render name ${JSON.stringify(canonicalName)}; refusing to write outside the expected scene output.` };
          }

          const rendered = await renderScene(
            {
              sceneNumber: n,
              backgroundImagePath: bg.path,
              durationSeconds: inspection?.durationSeconds,   // already resolved by sceneState; never invented
              motion: motionFromSceneText(pipelineScene?.camera), // existing camera -> deterministic motion
              width,
              height,
              mode: layout.placements.length > 0 ? 'require-characters' : 'background-only',
              renderMode: 'LOCAL_SYNTHESIS',
              characters: layout.placements,
            },
            {
              outputDir: path.dirname(outputPath),
              charactersDir: path.join(opts.inputRoot, 'characters'),
              ffmpegPath: opts.ffmpegPath,
              ffprobePath: opts.ffprobePath,
              overwrite: opts.overwrite !== false,
            },
          );
          if (!rendered.ok) return { ok: false, reason: `Scene ${n} local synthesis failed [${rendered.code}]: ${rendered.reason}` };

          // Verify the render actually landed where the orchestrator will read it. renderScene
          // self-validates the media; this confirms placement, so success is never reported blind.
          const produced = path.resolve(rendered.outputPath ?? path.join(path.dirname(outputPath), canonicalName));
          if (produced !== path.resolve(outputPath)) {
            return { ok: false, reason: `Scene ${n}: renderer wrote ${JSON.stringify(produced)} but the orchestrator expects ${JSON.stringify(path.resolve(outputPath))}.` };
          }
          try {
            const stat = await fsp.stat(produced);
            if (!stat.isFile() || stat.size <= 0) return { ok: false, reason: `Scene ${n}: rendered output is missing or empty at ${produced}.` };
          } catch {
            return { ok: false, reason: `Scene ${n}: rendered output is missing at ${produced}.` };
          }
          return { ok: true };
        }
      }
    }
    // Legacy shape (no renderMode supplied), explicit SUPPLIED_VIDEO, and LOCAL_SYNTHESIS where Flow
    // still owns the scene (prior checkpoint or live read-only commit probe) all continue here into
    // the pre-existing Flow/USE_LOCAL path, which is unchanged by this dispatch. The Flow client was
    // already resolved once, above the dispatch; a missing client only matters for Flow work.

    // 4. Delegate to the EXISTING single-scene workflow. It owns the credit-safe decision,
    //    generation, commit verification, download and checkpoint persistence. The workflow
    //    tolerates an absent client for the local-valid branch.
    const config: ProcessSceneConfig = {
      projectId: expectedProject,
      inputRoot: opts.inputRoot,
      outputsRoot: opts.outputsRoot,
      allowGeneration: opts.allowGeneration === true,
      ffprobePath: opts.ffprobePath,
      downloadDir: opts.downloadDir,
      // Canonical asset metadata so the prompt's @CHAR-*/#BGD-* identifiers can be resolved to
      // human descriptions before submission (prevents burned-in identifier captions in the output).
      backgrounds: (opts.pipeline as any)?.backgrounds ?? null,
      characters: (opts.pipeline as any)?.characters ?? null,
      wardrobeMode: detectWardrobeMode(opts.pipeline),
      sceneLocalAuthorization: opts.sceneLocalAuthorization ?? null,
      generationPolicy: opts.generationPolicy,
      generationApproval: opts.generationApproval,
    };
    let result: ProcessSceneResult;
    try {
      result = await processSingleFlowScene(pipelineScene, flow, config);
    } catch (e: any) {
      // Propagate the underlying failure — never convert it into success.
      return { ok: false, reason: `Scene ${n} workflow error: ${String(e?.message ?? e).slice(0, 200)}` };
    }

    if (!isSceneWorkflowSuccess(result.status) || !result.localClipPath) {
      // Distinguish "needs Flow but no client" (fail closed, recovery/generation required) from a
      // genuine workflow failure. Both are non-success; neither is ever reported as executed.
      const needsFlow = result.status === 'FLOW_GENERATION_REQUIRED' || result.status === 'FLOW_GENERATION_FAILED' || result.status === 'FLOW_GENERATION_BLOCKED' || result.status === 'DOWNLOAD_FAILED' || result.status === 'FLOW_COMMIT_NOT_PROVEN' || result.status === 'FLOW_SCENE_NOT_COMMITTED' || result.status === 'SCENE_LOCAL_GENERATION_FAILED' || result.status === 'SCENE_LOCAL_BLOCKED';
      const suffix = !flow && needsFlow ? ' (no Flow client available for this run)' : '';
      return { ok: false, reason: `Scene ${n} not produced: ${result.status}${result.detail ? ` (${result.detail})` : ''}${suffix}` };
    }

    // 5. Promote the produced Flow clip to the orchestrator's scene output path. This is the ONLY
    //    bridge step: the orchestrator validates `outputPath` and writes its own render sidecar.
    try {
      await fsp.mkdir(path.dirname(outputPath), { recursive: true });
      await fsp.copyFile(result.localClipPath, outputPath);
    } catch (e: any) {
      return { ok: false, reason: `Scene ${n} produced a local clip but could not place it at the output path: ${String(e?.message ?? e).slice(0, 160)}` };
    }
    return { ok: true };
  };
}
