/**
 * Read-only production input diagnostics (STEP-8DE).
 *
 * Consumes a pipeline JSON + the project input directory and reports readiness, durations,
 * missing/invalid/ambiguous files and staleness. It NEVER writes, renders, generates assets,
 * contacts Flow, or mutates the pipeline/outputs.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { discoverInputAssets, loadManifest, compareManifestToFilesystem, projectInputRoot, assertSafeProjectId, type ManifestDiscrepancy } from './inputManifest.js';
import { inspectProjectScenes, type SceneInputInspection } from './sceneState.js';
import { validateVideoClip } from './videoClip.js';
import { deriveFlowLocalState, type FlowLocalDecision } from './flowMediaState.js';

export type StalenessClass = 'CURRENT_UNKNOWN' | 'STALE_UNKNOWN' | 'ABSENT';

export interface SceneDiagnostic extends SceneInputInspection {
  staleness: StalenessClass;
  renderedOutputPath: string | null;
  /** Explicit Flow-commitment vs local-media relationship (STEP-8GF). */
  flowLocal: FlowLocalDecision;
}

export interface InputDiagnosticReport {
  projectId: string;
  sceneCount: number;
  counts: { ready: number; waitingBackground: number; waitingCharacter: number; waitingNarration: number; waitingVideo: number; invalid: number };
  /** Scenes committed in Flow but lacking a valid local clip (NOT renderable). */
  flowCommittedLocalMissing: number[];
  flowCommittedLocalAvailable: number[];
  localAvailableFlowUnknown: number[];
  duration: { resolved: number; unresolved: number };
  missingFiles: string[];
  invalidFiles: string[];
  ambiguousFiles: string[];
  staleScenes: number[];
  finalEditReady: boolean;
  inputRootExists: boolean;
  unexpectedFiles: string[];
  manifest: { present: boolean; valid: boolean; reason?: string; discrepancies: ManifestDiscrepancy[] };
  scenes: SceneDiagnostic[];
}

export interface CheckInputsOptions {
  pipeline: any;
  /** Base directory containing <project-id>/ (defaults to `production/inputs`). */
  inputsRoot?: string;
  /** Project id; defaults to pipeline.project_id. */
  projectId?: string;
  /** Directory holding existing rendered scene outputs (defaults to `production/outputs/<id>`). */
  outputsDir?: string;
  ffprobePath?: string;
  /**
   * Per-scene Flow commitment facts (from EXISTING records only — e.g. scene checkpoints).
   * Never invented; when a scene is absent here the pipeline scene fields are still consulted.
   */
  flowSceneById?: Record<number, { flowSceneId?: string | null; flowSceneUrl?: string | null }>;
}

const SEVERITY: Record<string, 'missing' | 'invalid' | 'ambiguous'> = {
  MISSING: 'missing', INVALID: 'invalid', AMBIGUOUS: 'ambiguous', UNSUPPORTED: 'invalid',
};

/**
 * Build the diagnostic report. Read-only; safe to run repeatedly.
 * Staleness is STALE_UNKNOWN unless a safe sidecar proves correspondence (none exists yet),
 * so an existing output is never falsely claimed current, and never deleted.
 */
export async function checkInputs(options: CheckInputsOptions): Promise<InputDiagnosticReport> {
  const pipeline = options.pipeline ?? {};
  const projectId = assertSafeProjectId(options.projectId ?? pipeline.project_id);
  const inputsRoot = options.inputsRoot ?? 'inputs';
  const root = projectInputRoot(projectId, inputsRoot);
  const outputsDir = options.outputsDir ?? path.resolve('outputs', projectId);

  const discovered = await discoverInputAssets(projectId, inputsRoot);
  const scenes = await inspectProjectScenes(pipeline, { inputRoot: root, ffprobePath: options.ffprobePath });

  const missingFiles: string[] = [];
  const invalidFiles: string[] = [];
  const ambiguousFiles: string[] = [];
  const diagnostics: SceneDiagnostic[] = [];

  for (const s of scenes) {
    const collect = (state: string, label: string, file: string | null, reason?: string) => {
      const sev = SEVERITY[state];
      if (!sev) return;
      const entry = `${label}: ${file ?? '(no path)'}${reason ? ` — ${reason}` : ''}`;
      if (sev === 'missing') missingFiles.push(entry);
      else if (sev === 'invalid') invalidFiles.push(entry);
      else ambiguousFiles.push(entry);
    };
    collect(s.background.state, `scene ${s.sceneNumber} background`, s.background.path, s.background.reason);
    for (const c of s.characters) collect(c.state, `scene ${s.sceneNumber} character ${c.tag}`, c.path, c.reason);
    collect(s.narrationAsset.state, `scene ${s.sceneNumber} narration`, s.narrationAsset.path, s.narrationAsset.reason);
    // A supplied clip is OPTIONAL: local synthesis may substitute it. Only a present-but-
    // unusable clip is a diagnostic problem; a simply-absent clip is not "missing input".
    if (s.suppliedClip.state !== 'MISSING') collect(s.suppliedClip.state, `scene ${s.sceneNumber} supplied clip`, s.suppliedClip.path, s.suppliedClip.reason);

    // ---- staleness (read-only) ----
    const expected = path.join(outputsDir, `scene-${String(s.sceneNumber).padStart(4, '0')}.mp4`);
    const exists = await fsp.stat(expected).then((st) => st.isFile()).catch(() => false);
    let staleness: StalenessClass = 'ABSENT';
    if (exists) {
      const clip = await validateVideoClip(expected, { ffprobePath: options.ffprobePath });
      // No safe sidecar exists to prove this output matches the current render key.
      staleness = clip.state === 'VALID' ? 'STALE_UNKNOWN' : 'STALE_UNKNOWN';
    }
    const mapFlow = (options as any).flowSceneById as Record<number, { flowSceneId?: string | null; flowSceneUrl?: string | null }> | undefined;
    const flowFacts = mapFlow?.[s.sceneNumber] ?? {};
    const pipelineScene = ((pipeline.scenes as any[]) ?? []).find((ps: any) => Number(ps?.scene_number) === s.sceneNumber) ?? {};
    const flowLocal = deriveFlowLocalState({
      flowSceneId: flowFacts.flowSceneId ?? (pipelineScene as any).flow_scene_id ?? null,
      flowSceneUrl: flowFacts.flowSceneUrl ?? (pipelineScene as any).flow_scene_url ?? null,
      localClipExists: s.suppliedClip.state !== 'MISSING',
      localClipValid: s.suppliedClip.state === 'VALID',
    });
    diagnostics.push({ ...s, staleness, renderedOutputPath: exists ? expected : null, flowLocal });
  }

  // ---- manifest (metadata only; filesystem wins) ----
  const loaded = await loadManifest(projectId, inputsRoot);
  let discrepancies: ManifestDiscrepancy[] = [];
  if (loaded.ok && loaded.manifest) discrepancies = await compareManifestToFilesystem(loaded.manifest, discovered, projectId, inputsRoot);

  const counts = {
    ready: diagnostics.filter((d) => d.readiness === 'READY').length,
    waitingBackground: diagnostics.filter((d) => d.readiness === 'WAITING_FOR_BACKGROUND').length,
    waitingCharacter: diagnostics.filter((d) => d.readiness === 'WAITING_FOR_CHARACTER_ASSET').length,
    waitingNarration: diagnostics.filter((d) => d.readiness === 'WAITING_FOR_NARRATION').length,
    waitingVideo: diagnostics.filter((d) => d.readiness === 'WAITING_FOR_VIDEO_CLIP').length,
    invalid: diagnostics.filter((d) => d.readiness === 'INVALID').length,
  };
  const duration = {
    resolved: diagnostics.filter((d) => d.durationSeconds !== null).length,
    unresolved: diagnostics.filter((d) => d.durationSeconds === null).length,
  };
  const usableClips = diagnostics.filter((d) => d.suppliedClip.state === 'VALID' || d.readiness === 'READY').length;

  return {
    projectId, sceneCount: diagnostics.length, counts, duration,
    flowCommittedLocalMissing: diagnostics.filter((d) => d.flowLocal.state === 'FLOW_COMMITTED_LOCAL_MISSING').map((d) => d.sceneNumber),
    flowCommittedLocalAvailable: diagnostics.filter((d) => d.flowLocal.state === 'FLOW_COMMITTED_LOCAL_AVAILABLE').map((d) => d.sceneNumber),
    localAvailableFlowUnknown: diagnostics.filter((d) => d.flowLocal.state === 'LOCAL_AVAILABLE_FLOW_UNKNOWN').map((d) => d.sceneNumber),
    missingFiles: [...new Set(missingFiles)],
    invalidFiles: [...new Set(invalidFiles)],
    ambiguousFiles: [...new Set(ambiguousFiles)],
    staleScenes: diagnostics.filter((d) => d.staleness === 'STALE_UNKNOWN').map((d) => d.sceneNumber),
    finalEditReady: usableClips >= 2 && counts.ready >= diagnostics.length,
    inputRootExists: discovered.rootExists,
    unexpectedFiles: discovered.unexpected,
    manifest: { present: loaded.ok && loaded.manifest !== null, valid: loaded.ok, reason: loaded.ok ? undefined : loaded.reason, discrepancies },
    scenes: diagnostics,
  };
}

/** Render the report as a concise human-readable block (no side effects). */
export function formatDiagnosticReport(r: InputDiagnosticReport): string {
  const lines: string[] = [];
  lines.push(`Project          ${r.projectId}`);
  lines.push(`Input root       ${r.inputRootExists ? 'present' : 'absent'}`);
  lines.push(`Scenes           ${r.sceneCount}`);
  lines.push(`READY            ${r.counts.ready}`);
  lines.push(`Waiting backgr.  ${r.counts.waitingBackground}`);
  lines.push(`Waiting char     ${r.counts.waitingCharacter}`);
  lines.push(`Waiting narrat.  ${r.counts.waitingNarration}`);
  lines.push(`Waiting video    ${r.counts.waitingVideo}`);
  lines.push(`INVALID          ${r.counts.invalid}`);
  lines.push(`Duration         resolved ${r.duration.resolved} / unresolved ${r.duration.unresolved}`);
  lines.push(`Missing files    ${r.missingFiles.length}${r.missingFiles.length ? ': ' + r.missingFiles.slice(0, 8).join('; ') : ''}`);
  lines.push(`Invalid files    ${r.invalidFiles.length}${r.invalidFiles.length ? ': ' + r.invalidFiles.slice(0, 8).join('; ') : ''}`);
  lines.push(`Ambiguous files  ${r.ambiguousFiles.length}${r.ambiguousFiles.length ? ': ' + r.ambiguousFiles.slice(0, 8).join('; ') : ''}`);
  lines.push(`Stale scenes     ${r.staleScenes.length}${r.staleScenes.length ? ': ' + r.staleScenes.join(', ') : ''}`);
  lines.push(`Unexpected files ${r.unexpectedFiles.length}${r.unexpectedFiles.length ? ': ' + r.unexpectedFiles.slice(0, 8).join('; ') : ''}`);
  lines.push(`Manifest         ${r.manifest.present ? (r.manifest.valid ? 'valid' : 'invalid: ' + r.manifest.reason) : 'absent'}`);
  lines.push(`Final edit       ${r.finalEditReady ? 'READY' : 'BLOCKED'}`);
  return lines.join('\n');
}
