/**
 * `production:check` — READ-ONLY production diagnostics (STEP-8DI).
 *
 * Exposes the completed offline architecture (8DE validation core → 8DF project state →
 * 8DG orchestration → 8DH downstream stages) as a single diagnostic command:
 *
 *   npm run production:check -- --project <pipeline.json> [--inputs-dir <dir>] [--json]
 *                                  [--write-state] [--execute-stages]
 *
 * By DEFAULT it is strictly READ-ONLY. `--write-state` opts into persisting the derived
 * checkpoint. `--execute-stages` opts into running the real downstream producers, but ONLY
 * after every readiness/input/state gate passes — a project that is WAITING_FOR_INPUTS stops
 * before any stage implementation is invoked.
 *
 * It NEVER contacts Flow or a browser.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { orchestrate } from './productionOrchestrator.js';
import { formatDiagnosticReport, checkInputs } from './checkInputs.js';
import { assertSafeProjectId, projectInputRoot } from './inputManifest.js';
import { DOWNSTREAM_STAGES, stageKey, recordedKeyInputs, type DownstreamStage, type StageInputs } from './downstreamStages.js';
import { executeDownstreamChain, STAGE_SCRIPTS, type StageExecutorConfig } from './stageExecutor.js';
import { sha256OfFileOrNull as sha256OrNull } from './downstreamStages.js';
import { validateProjectInputs, deriveRequiredInputs } from './inputValidator.js';
import { draftManifest, validateManifestFile } from './manifestWorkflow.js';
const fsp = fs;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? fallback : fallback;
}
function hasFlag(name: string): boolean { return process.argv.includes(name); }

const MAX_SCENES = 35;
const MIN_SCENES = 2;

export interface CliResult {
  exitCode: number;
  json?: unknown;
  text?: string;
}

/** Validate the pipeline path + document. Fail closed with an actionable message. */
export async function readPipeline(projectPath: string): Promise<{ ok: true; pipeline: any; file: string } | { ok: false; error: string }> {
  const file = path.resolve(projectPath);
  if (!/\.json$/i.test(file)) return { ok: false, error: `--project must point at a .json pipeline file (got "${projectPath}").` };
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); } catch { return { ok: false, error: `Pipeline file does not exist: ${projectPath}.` }; }
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, error: `Pipeline JSON is malformed: ${projectPath}.` }; }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'Pipeline JSON is not an object.' };

  // Project id
  try { assertSafeProjectId(parsed.project_id); }
  catch (e: any) { return { ok: false, error: `Pipeline has no usable project_id: ${String(e?.message ?? e)}` }; }

  // Scenes
  const scenes = parsed.scenes;
  if (!Array.isArray(scenes) || scenes.length < MIN_SCENES || scenes.length > MAX_SCENES) {
    return { ok: false, error: `Pipeline must contain between ${MIN_SCENES} and ${MAX_SCENES} scenes (found ${Array.isArray(scenes) ? scenes.length : 'none'}).` };
  }
  const numbers = scenes.map((s: any) => Number(s?.scene_number));
  if (numbers.some((n) => !Number.isInteger(n) || n <= 0)) return { ok: false, error: 'Every scene must have a positive integer scene_number.' };
  const sorted = [...numbers].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) if (sorted[i] !== i + 1) return { ok: false, error: `Scene numbers must be sequential 1..N (got ${sorted.join(', ')}).` };

  // Required scene fields
  for (const s of scenes) {
    if (typeof s.background_tag !== 'string' && s.background_tag !== null && s.background_tag !== undefined) {
      // tolerated: background handled downstream; only shape-check the core fields
    }
    if (!Array.isArray(s.character_tags)) return { ok: false, error: `Scene ${s?.scene_number} is missing character_tags[].` };
  }
  return { ok: true, pipeline: parsed, file };
}

/** Derive the ONE primary next action from a completed report. */
export function deriveNextAction(d: {
  counts: { ready: number; waitingBackground: number; waitingCharacter: number; waitingNarration: number; waitingVideo: number; invalid: number };
  duration: { resolved: number; unresolved: number };
  sceneOutputs: { current: number; stale: number; staleUnknown: number; missing: number; invalid: number };
  stages: Record<string, string>;
  approved: boolean;
  total: number;
  missingNarrationScenes?: number[];
  missingCharacterTags?: string[];
  missingBackgroundTags?: string[];
  /** Scenes committed in Flow but lacking a valid local clip (external-input state). */
  flowCommittedLocalMissing?: number[];
}): string {
  if (d.counts.invalid > 0) return `Fix ${d.counts.invalid} invalid scene input(s).`;
  if ((d.flowCommittedLocalMissing ?? []).length > 0) {
    return `${(d.flowCommittedLocalMissing ?? []).length} required scene(s) committed in Flow but have no locally available media (scene${(d.flowCommittedLocalMissing ?? []).length === 1 ? '' : 's'} ${(d.flowCommittedLocalMissing ?? []).join(', ')}); supply the local clip(s).`;
  }
  if (d.counts.waitingBackground > 0) return `Supply missing background asset(s): ${(d.missingBackgroundTags ?? []).join(', ') || `${d.counts.waitingBackground} scene(s)`}.`;
  if (d.counts.waitingCharacter > 0) return `Supply missing character asset(s): ${(d.missingCharacterTags ?? []).join(', ') || `${d.counts.waitingCharacter} scene(s)`}.`;
  if (d.counts.waitingNarration > 0) return `Supply narration: ${(d.missingNarrationScenes ?? []).map((n) => `narration-${String(n).padStart(4, '0')}.*`).join(', ') || `${d.counts.waitingNarration} scene(s)`}.`;
  if (d.counts.waitingVideo > 0) return `Supply dialogue scene clip(s) for ${d.counts.waitingVideo} scene(s) (no local dialogue audio exists).`;
  if (d.duration.unresolved > 0) return `Resolve duration for ${d.duration.unresolved} scene(s).`;
  const needRender = d.sceneOutputs.stale + d.sceneOutputs.staleUnknown + d.sceneOutputs.missing + d.sceneOutputs.invalid;
  if (needRender > 0) return `Render ${needRender} scene(s).`;
  for (const st of DOWNSTREAM_STAGES) {
    if (st === 'APPROVAL') continue;
    if (d.stages[st] !== 'CURRENT') return `Run downstream ${st.toLowerCase()} stage.`;
  }
  if (d.stages.APPROVAL !== 'CURRENT') return d.approved ? 'Project is complete.' : 'Human approval required.';
  return 'Project is complete.';
}

/** Run the diagnostic. Read-only unless `writeState`/`executeStages` are explicitly set. */
export async function runCheck(opts: { project: string; inputsDir?: string; outputsDir?: string; outputsRoot?: string; json?: boolean; writeState?: boolean; executeStages?: boolean; productionDir?: string; runScript?: (scriptRel: string, args: string[]) => Promise<void>; titleAssets?: { intro: string; logo: string; title?: string }; bgmPath?: string; draftManifest?: boolean; validateManifestPath?: string }): Promise<CliResult> {
  const read = await readPipeline(opts.project);
  if (!read.ok) {
    if (opts.json) return { exitCode: 2, json: { error: read.error } };
    return { exitCode: 2, text: `\nPRODUCTION CHECK\n${'='.repeat(40)}\nERROR: ${read.error}\n` };
  }
  const { pipeline } = read;
  const projectId = String(pipeline.project_id);
  const writeState = opts.writeState === true;
  const executeStages = opts.executeStages === true;
  // Any execution implies checkpoint persistence so stage metadata is recorded.
  const readOnly = !writeState && !executeStages;
  const mode: 'read-only' | 'write-state' | 'execute-stages' =
    executeStages ? 'execute-stages' : writeState ? 'write-state' : 'read-only';

  // ---- 8DN: manifest authoring / validation (both strictly read-only) ----
  if (opts.draftManifest || opts.validateManifestPath) {
    const pipelineRaw = await fs.readFile(read.file, 'utf8');
    if (opts.draftManifest) {
      const draft = draftManifest(pipeline, pipelineRaw);
      if (opts.json) return { exitCode: 0, json: draft };
      const lines: string[] = ['='.repeat(40), 'DRAFT INPUT MANIFEST', '='.repeat(40)];
      lines.push(`Project:      ${draft.project_id}`);
      lines.push(`Pipeline SHA: ${draft.generated_from_pipeline_sha256}`);
      lines.push(`Contract:     ${draft.validator_contract_version}`);
      lines.push('');
      for (const [cat, list] of Object.entries(draft.assets)) {
        if (!list.length) continue;
        lines.push(`${cat.toUpperCase()} (${list.length})`);
        for (const a of list) lines.push(`  [${a.requirement.padEnd(12)}] ${a.id.padEnd(34)} -> ${a.relative_path}${a.scene_number ? `  (scene ${a.scene_number})` : ''}`);
        lines.push('');
      }
      lines.push('NEXT: supply the REQUIRED files under production/inputs/<project-id>/ then run --validate-manifest <path>.');
      lines.push('');
      return { exitCode: 0, text: lines.join('\n') };
    }
    // --validate-manifest <path>
    const root = opts.inputsDir ? path.join(path.resolve(opts.inputsDir), projectId) : projectInputRoot(projectId, path.resolve('inputs'));
    const vr = await validateManifestFile({ manifestPath: path.resolve(String(opts.validateManifestPath)), pipeline, pipelineRaw, inputRoot: root, ffprobePath: process.env.FFPROBE_PATH });
    if (opts.json) return { exitCode: vr.status === 'VALID' ? 0 : 1, json: vr };
    const lines: string[] = ['='.repeat(40), 'MANIFEST VALIDATION', '='.repeat(40)];
    lines.push(`Status:       ${vr.status}`);
    lines.push(`Project:      ${vr.projectId}`);
    lines.push(`Missing:      ${vr.missing.length}`);
    lines.push(`Invalid:      ${vr.invalid.length}`);
    lines.push(`Unsupported:  ${vr.unsupported.length}`);
    lines.push(`Licence fails:${vr.licenseFailures.length}`);
    lines.push(`SHA mismatch: ${vr.shaMismatches.length}`);
    lines.push(`Unexpected:   ${vr.unexpected.length}`);
    if (vr.issues.length) { lines.push(''); lines.push('ISSUES'); for (const i of vr.issues.slice(0, 40)) lines.push(`  ${i.code}${i.id ? ` [${i.id}]` : ''}: ${i.detail}`); }
    lines.push('');
    return { exitCode: vr.status === 'VALID' ? 0 : 1, text: lines.join('\n') };
  }

  // Input root: default production/inputs/<project-id>/ — NEVER created.
  const inputsRoot = opts.inputsDir ? path.resolve(opts.inputsDir) : path.resolve('inputs');
  const inputRoot = opts.inputsDir ? path.join(inputsRoot, projectId) : projectInputRoot(projectId, inputsRoot);
  const inputRootExists = await fs.stat(inputRoot).then((s) => s.isDirectory()).catch(() => false);

  const outputsRoot = opts.outputsRoot ? path.resolve(opts.outputsRoot) : path.resolve('outputs');
  const outputsDir = opts.outputsDir ? path.resolve(opts.outputsDir) : path.join(outputsRoot, projectId);

  // Effective brandings/BGM/title metadata for stage keys. The SAME values feed both the stage
  // key (via orchestrate) and the recorded `key_inputs` provenance — never reconstructed later.
  const effectiveStageInputs = {
    bgmHash: opts.bgmPath ? await sha256OrNull(path.resolve(opts.bgmPath)) : null,
    introHash: opts.titleAssets?.intro ? await sha256OrNull(path.resolve(opts.titleAssets.intro)) : null,
    logoHash: opts.titleAssets?.logo ? await sha256OrNull(path.resolve(opts.titleAssets.logo)) : null,
    titleMetadata: opts.titleAssets?.title !== undefined ? { title: opts.titleAssets.title } : null,
  };

  // Inspection (no executor) — never renders, never executes stages.
  const report = await orchestrate({
    pipeline, projectId, inputRoot, outputsDir, outputsRoot,
    ffprobePath: process.env.FFPROBE_PATH,
    readOnly,
    stageInputs: effectiveStageInputs,
  });

  const diag = await (async () => {
    // STEP-8GF: read EXISTING scene checkpoints (read-only) to learn each scene's Flow commitment.
    // Never invented; a missing/unreadable checkpoint simply contributes no Flow facts.
    const flowSceneById: Record<number, { flowSceneId?: string | null; flowSceneUrl?: string | null }> = {};
    const flowScenesDir = path.join(outputsDir, 'flow-scenes');
    for (const s of (pipeline.scenes ?? [])) {
      const n = Number((s as any)?.scene_number);
      if (!Number.isInteger(n) || n <= 0) continue;
      const cp = path.join(flowScenesDir, `scene-${String(n).padStart(4, '0')}.json`);
      const rec = await fs.readFile(cp, 'utf8').then((t) => JSON.parse(t)).catch(() => null);
      if (rec && typeof rec === 'object') {
        if (typeof rec.flow_scene_id === 'string' || typeof rec.flow_scene_url === 'string') {
          flowSceneById[n] = { flowSceneId: rec.flow_scene_id ?? null, flowSceneUrl: rec.flow_scene_url ?? null };
        }
      }
    }
    return checkInputs({ pipeline, inputsRoot, projectId, outputsDir, ffprobePath: process.env.FFPROBE_PATH, flowSceneById } as any);
  })();

  // ---- 8DM: external input validation (read-only; never creates the input directory) ----
  const required = deriveRequiredInputs(pipeline);
  const inputReport = await validateProjectInputs({
    projectId, inputRoot,
    requiredBackgrounds: required.backgrounds, requiredCharacters: required.characters,
    narrationScenes: required.narrationScenes, sceneNumbers: required.sceneNumbers,
    requiredClips: required.sceneNumbers, // validate clips for every scene that has one
    ffprobePath: process.env.FFPROBE_PATH,
  });

  const sceneOutputs = {
    current: report.scenes.filter((s) => s.outputState === 'CURRENT').length,
    stale: report.scenes.filter((s) => s.outputState === 'STALE').length,
    staleUnknown: report.scenes.filter((s) => s.outputState === 'STALE_UNKNOWN').length,
    missing: report.scenes.filter((s) => s.outputState === 'MISSING_OUTPUT').length,
    invalid: report.scenes.filter((s) => s.outputState === 'INVALID_OUTPUT').length,
  };

  const missingCharacterTags = [...new Set(report.scenes.flatMap((s) => {
    const src = diag.scenes.find((d: any) => d.sceneNumber === s.sceneNumber);
    return (src?.characters ?? []).filter((c: any) => c.state === 'MISSING').map((c: any) => c.tag);
  }))];
  const missingBackgroundTags = [...new Set(diag.scenes.flatMap((d: any) => (d.background.state === 'MISSING' ? [d.backgroundTag] : [])))];
  const missingNarrationScenes = diag.scenes.filter((d: any) => d.narrationAsset.state === 'MISSING').map((d: any) => d.sceneNumber);

  const nextAction = deriveNextAction({
    counts: report.counts, duration: diag.duration, sceneOutputs,
    stages: report.downstream.states as any, approved: false, total: report.sceneCount,
    missingNarrationScenes, missingCharacterTags, missingBackgroundTags,
    flowCommittedLocalMissing: (diag as any).flowCommittedLocalMissing,
  });

  // ---- 8DK: guarded real stage execution ----
  let execution: { attempted: boolean; blocked?: { code: string; reason: string; stage?: string }; executed: string[] } = { attempted: false, executed: [] };
  if (executeStages) {
    execution.attempted = true;
    const allScenesCurrent = report.scenes.length > 0 && report.scenes.every((s) => s.outputState === 'CURRENT');
    const blockers: string[] = [];
    if (report.counts.invalid > 0) blockers.push(`${report.counts.invalid} invalid scene input(s)`);
    if (report.counts.waitingBackground + report.counts.waitingCharacter + report.counts.waitingNarration + report.counts.waitingVideo > 0) blockers.push('scene inputs are incomplete');
    if (((diag as any).flowCommittedLocalMissing ?? []).length > 0) blockers.push(`${((diag as any).flowCommittedLocalMissing ?? []).length} scene(s) committed in Flow but locally missing`);
    if (diag.duration.unresolved > 0) blockers.push(`${diag.duration.unresolved} unresolved duration(s)`);
    if (!allScenesCurrent) blockers.push('scene outputs are not all CURRENT');

    if (blockers.length > 0) {
      // FAIL CLOSED: no stage implementation is consulted, let alone invoked.
      execution.blocked = { code: 'EXECUTION_BLOCKED_INPUTS', reason: `Execution blocked: ${blockers.join('; ')}.` };
    } else {
      const cfg: StageExecutorConfig = {
        outputsDir, inputsDir: inputRoot,
        productionDir: opts.productionDir ?? process.cwd(),
        runScript: opts.runScript,
        titleAssets: opts.titleAssets,
        bgmPath: opts.bgmPath,
      };
      // Live stage-state map: updated as stages succeed so the dependency gate sees fresh state.
      const liveStates: Record<string, string> = { ...(report.downstream.states as any) };
      const res = await executeDownstreamChain(
        { workSet: report.downstream.workSet, sceneOutputsCurrent: allScenesCurrent },
        cfg,
        {
          approved: false,
          stageState: (s) => String(liveStates[s] ?? 'NOT_STARTED'),
          // Recompute the stage key from ACTUAL on-disk outputs. Scene hashes are stable across
          // stage execution (only upstream STAGE outputs change), so the orchestrator's derived
          // scene-side key material is reused and only the upstream stage hash is refreshed.
          resolveKey: async (s) => {
            const live: StageInputs = {
              sceneOutputHashes: report.sceneOutputHashes,
              narration: report.narrationInputs,
              bgmHash: report.stageInputHashes.bgmHash,
              introHash: report.stageInputHashes.introHash,
              logoHash: report.stageInputHashes.logoHash,
              titleMetadata: report.stageInputHashes.titleMetadata,
              editOutputHash: await sha256OrNull(path.join(outputsDir, 'final-with-fades.mp4')),
              mixOutputHash: await sha256OrNull(path.join(outputsDir, 'final-narrated.mp4')),
              bedOutputHash: await sha256OrNull(path.join(outputsDir, 'final-bedded.mp4')),
              titleOutputHash: await sha256OrNull(path.join(outputsDir, 'final-title.mp4')),
            };
            return { key: stageKey(s, live), keyInputs: recordedKeyInputs(live) };
          },
          ffprobePath: process.env.FFPROBE_PATH,
          // Persist the successful stage binding (key + output hash + the effective key inputs)
          // as a sidecar so the next run can classify it CURRENT — this is what makes execution
          // resumable. `key_inputs` is provenance derived from the SAME inputs that fed the key.
          persistStage: async (stage, rec) => {
            const finalPath = path.join(outputsDir, path.basename(rec.output_path));
            const sidecar = `${finalPath}.stage`;
            const tmp = `${sidecar}.${process.pid}.tmp`;
            await fsp.writeFile(tmp, `${JSON.stringify({ stage, key: rec.key, output_hash: rec.output_hash, output_path: path.basename(finalPath), key_inputs: rec.key_inputs }, null, 2)}\n`, 'utf8');
            await fsp.rename(tmp, sidecar);
            liveStates[stage] = 'CURRENT'; // downstream gate must see the fresh state
          },
        },
      );
      execution.executed = res.executed;
      const blocked = res.blocked;
      if (blocked && !blocked.ok) execution.blocked = { code: blocked.code, reason: blocked.reason, stage: String(blocked.stage) };
    }
  }

  if (opts.json) {
    return {
      exitCode: 0,
      json: {
        mode,
        projectId,
        pipelinePath: path.relative(process.cwd(), read.file).replace(/\\/g, '/'),
        inputRoot: path.relative(process.cwd(), inputRoot).replace(/\\/g, '/'),
        inputRootExists,
        sceneCount: report.sceneCount,
        summary: { ...report.counts, durationResolved: diag.duration.resolved, durationUnresolved: diag.duration.unresolved, sceneOutputs, flowCommittedLocalMissing: (diag as any).flowCommittedLocalMissing ?? [], flowCommittedLocalAvailable: (diag as any).flowCommittedLocalAvailable ?? [], localAvailableFlowUnknown: (diag as any).localAvailableFlowUnknown ?? [] },
        inputs: {
          inputRootExists: inputReport.inputRootExists,
          backgrounds: inputReport.counts.backgrounds,
          characters: inputReport.counts.characters,
          narration: inputReport.counts.narration,
          flowClips: inputReport.counts.flowClips,
          music: inputReport.counts.music,
          branding: inputReport.counts.branding,
          issues: inputReport.issues,
        },
        scenes: report.scenes.map((s, i) => ({
          sceneNumber: s.sceneNumber, title: diag.scenes[i]?.title ?? '',
          kind: (s as any).narration ?? '', readiness: s.readiness, renderMode: s.renderMode,
          durationSeconds: s.durationSeconds, durationSource: (s as any).durationSource ?? (diag.scenes[i] as any)?.durationProvenance ?? 'unresolved',
          background: diag.scenes[i]?.background.state, characters: (diag.scenes[i]?.characters ?? []).map((c: any) => `${c.tag}:${c.state}`),
          narration: diag.scenes[i]?.narrationAsset.state, suppliedVideo: diag.scenes[i]?.suppliedClip.state,
          output: s.outputState, renderKey: s.renderKey, needsRender: s.needsWork,
          flowState: (diag.scenes[i] as any)?.flowLocal?.state ?? 'FLOW_UNKNOWN',
          renderable: (diag.scenes[i] as any)?.flowLocal?.renderable === true,
          flowReason: (diag.scenes[i] as any)?.flowLocal?.reason ?? null,
        })),
        stages: Object.fromEntries(DOWNSTREAM_STAGES.map((st) => [st.toLowerCase(), { state: report.downstream.states[st], key: report.downstream.keys[st] }])),
        projectState: report.state,
        nextAction,
        execution,
      },
    };
  }

  // ---- human-readable ----
  const lines: string[] = [];
  lines.push('='.repeat(40));
  lines.push('PRODUCTION CHECK');
  lines.push('='.repeat(40));
  lines.push(`MODE:         ${mode === 'execute-stages' ? 'EXECUTE-STAGES' : mode === 'write-state' ? 'WRITE-STATE' : 'READ-ONLY'}`);
  lines.push(`CHECKPOINT:   ${readOnly ? 'not written' : 'saved'}`);
  lines.push(`Project:      ${projectId}`);
  lines.push(`Pipeline:     ${path.relative(process.cwd(), read.file).replace(/\\/g, '/')}`);
  lines.push(`Scenes:       ${report.sceneCount}`);
  lines.push(`Input root:   ${inputRootExists ? path.relative(process.cwd(), inputRoot).replace(/\\/g, '/') : 'MISSING'}`);
  lines.push('');
  lines.push('INPUTS');
  {
    const c = inputReport.counts;
    lines.push(`  backgrounds: ${c.backgrounds.valid}/${c.backgrounds.total} valid`);
    lines.push(`  characters:  ${c.characters.valid}/${c.characters.total} valid`);
    lines.push(`  narration:   ${c.narration.valid}/${c.narration.total} valid`);
    lines.push(`  flow clips:  ${c.flowClips.valid}/${c.flowClips.total} valid`);
    lines.push(`  music:       ${c.music.valid}/${c.music.total} valid`);
    lines.push(`  branding:    ${c.branding.valid}/${c.branding.total} valid`);
  }
  lines.push('');
  lines.push('SCENES');
  for (let i = 0; i < report.scenes.length; i++) {
    const s = report.scenes[i]; const d = diag.scenes[i];
    const action = s.needsWork ? (s.readiness === 'READY' ? 'render' : 'supply input') : (s.outputState === 'CURRENT' ? '-' : 'inspect');
    const fl = (d as any)?.flowLocal;
    lines.push(`${String(s.sceneNumber).padStart(3, '0')}  ${String((s as any).narration ?? '').padEnd(13)} ${s.readiness.padEnd(26)} mode=${String(s.renderMode).padEnd(15)} dur=${s.durationSeconds === null ? 'unresolved' : s.durationSeconds.toFixed(2)} bg=${String(d?.background.state).padEnd(8)} out=${String(s.outputState).padEnd(15)} flow=${String(fl?.state ?? 'FLOW_UNKNOWN').padEnd(30)} renderable=${fl?.renderable === true} ${action}`);
  }
  lines.push('');
  lines.push('SUMMARY');
  lines.push(`READY:                    ${report.counts.ready}`);
  lines.push(`WAITING_FOR_BACKGROUND:   ${report.counts.waitingBackground}`);
  lines.push(`WAITING_FOR_CHARACTER:    ${report.counts.waitingCharacter}`);
  lines.push(`WAITING_FOR_NARRATION:    ${report.counts.waitingNarration}`);
  lines.push(`WAITING_FOR_VIDEO_CLIP:   ${report.counts.waitingVideo}`);
  lines.push(`INVALID:                  ${report.counts.invalid}`);
  lines.push(`Flow committed/local missing: ${((diag as any).flowCommittedLocalMissing ?? []).length}${((diag as any).flowCommittedLocalMissing ?? []).length ? ': ' + ((diag as any).flowCommittedLocalMissing).join(', ') : ''}`);
  lines.push(`Flow committed/local available: ${((diag as any).flowCommittedLocalAvailable ?? []).length}`);
  lines.push(`Local available / Flow unknown:  ${((diag as any).localAvailableFlowUnknown ?? []).length}`);
  lines.push(`Duration resolved:        ${diag.duration.resolved} / unresolved ${diag.duration.unresolved}`);
  lines.push(`Outputs CURRENT:          ${sceneOutputs.current} / STALE ${sceneOutputs.stale} / STALE_UNKNOWN ${sceneOutputs.staleUnknown} / MISSING ${sceneOutputs.missing} / INVALID ${sceneOutputs.invalid}`);
  lines.push('');
  lines.push('DOWNSTREAM');
  const notCurrent = sceneOutputs.stale + sceneOutputs.staleUnknown + sceneOutputs.missing + sceneOutputs.invalid;
  for (const st of DOWNSTREAM_STAGES) {
    const state = report.downstream.states[st];
    let reason = '';
    if (state !== 'CURRENT') {
      if (st === 'EDIT') reason = notCurrent > 0 ? `Reason: ${report.sceneCount - sceneOutputs.current}/${report.sceneCount} scene output(s) are not CURRENT` : 'Reason: no recorded EDIT output';
      else reason = `Reason: ${DOWNSTREAM_STAGES[DOWNSTREAM_STAGES.indexOf(st) - 1]} is not CURRENT`;
    }
    lines.push(`${st}: ${state ?? 'STALE'}${reason ? '  ' + reason : ''}`);
  }
  lines.push('');
  lines.push('PROJECT STATE');
  lines.push(report.state);
  lines.push('');
  lines.push('NEXT ACTION');
  lines.push(nextAction);
  if (executeStages) {
    lines.push('');
    lines.push('EXECUTION');
    if (execution.blocked) lines.push(`${execution.blocked.code}: ${execution.blocked.reason}`);
    else lines.push(`Executed stages: ${execution.executed.join(', ') || '(none)'}`);
  }
  lines.push('');
  return { exitCode: 0, text: lines.join('\n') };
}

// ---- CLI main ----
const isMain = process.argv[1] && /prodCheck\.(ts|js|mts)$/.test(process.argv[1]);
if (isMain) {
  const project = arg('--project');
  if (!project) {
    console.error('Usage: npm run production:check -- --project <pipeline.json> [--inputs-dir <dir>] [--json]');
    process.exit(2);
  }
  const result = await runCheck({
    project,
    inputsDir: arg('--inputs-dir'),
    outputsDir: arg('--outputs-dir'),
    outputsRoot: arg('--outputs-root'),
    json: hasFlag('--json'),
    writeState: hasFlag('--write-state'),
    executeStages: hasFlag('--execute-stages'),
    draftManifest: hasFlag('--draft-manifest'),
    validateManifestPath: arg('--validate-manifest'),
  });
  if (result.json !== undefined) console.log(JSON.stringify(result.json, null, 2));
  if (result.text !== undefined) console.log(result.text);
  process.exit(result.exitCode);
}
