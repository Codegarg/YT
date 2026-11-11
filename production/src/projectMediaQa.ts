/**
 * PHASE 4 project-level media QA composition (READ-ONLY).
 *
 * This module does NOT duplicate the media QA engine. Every picture/audio measurement is
 * delegated to `runMediaQa` in `mediaQa.ts`; this layer only decides WHICH assets belong to a
 * project, what is expected of each one, and how the results roll up into a reviewable report:
 *
 *   · per-scene clips (present, readable, correct container, provenance vs. render sidecar)
 *   · narration audio (required only where the manifest actually asks for narration)
 *   · the final TITLE render (the artifact approval is bound to)
 *
 * It never renders, transcodes, downloads or publishes, never writes media or project state, and
 * never approves anything. `artifactHash` is the SHA-256 of the exact final artifact evaluated, so
 * an approval can be bound to one immutable artifact (see `qaAuthorizesArtifact`).
 *
 * Deliberate limits (disclosed in `skipped`, never silently assumed clean): scene-transition
 * continuity, subtitle/caption timing and stem-separated music mixing need analyses this offline
 * probe does not perform.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { runMediaQa, type MediaQaOptions, type MediaQaReport, type QaCheck, type QaCheckStatus } from './mediaQa.js';
import { probeMedia } from './videoClip.js';
import { stageOutputName } from './downstreamStages.js';

export const PROJECT_QA_VERSION = 1;

const NARRATION_EXTENSIONS = ['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg'] as const;

export interface ProjectQaSceneRef {
  sceneNumber: number;
  /** Absolute scene-clip path. Defaults to `<outputsDir>/scene-####.mp4`. */
  clipPath?: string;
  /** Absolute narration path. Defaults to `<inputRoot>/narration/narration-####.(wav|mp3|…)`. */
  narrationPath?: string;
  /** True when the manifest expects narration (pipeline `narration_text` is non-empty). */
  narrationRequired?: boolean;
  /** Expected clip duration when the manifest actually knows it. */
  expectedDurationSeconds?: number | null;
  /** Pipeline speaker tag (report only). */
  speaker?: string | null;
}

export type ProjectQaArtifactKind = 'scene' | 'narration' | 'final';

export interface ProjectQaArtifact {
  /** Stable asset id, e.g. `scene-0004`, `narration-0002`, `final-title.mp4`. */
  asset: string;
  kind: ProjectQaArtifactKind;
  sceneNumber: number | null;
  /** Absolute path that was evaluated (may not exist). */
  path: string;
  sha256: string | null;
  bytes: number | null;
  durationSeconds: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  status: QaCheckStatus;
  checks: QaCheck[];
}

export interface ProjectQaGroupSummary {
  /** Group status: FAIL if any check failed, WARNING if any warned, else PASS (SKIPPED when empty). */
  status: QaCheckStatus;
  total: number;
  pass: number;
  warning: number;
  fail: number;
  skipped: number;
  blockers: number;
  warnings: number;
  checks: QaCheck[];
}

export interface ProjectQaCounts {
  total: number;
  pass: number;
  warning: number;
  fail: number;
  skipped: number;
  blockers: number;
  warnings: number;
}

export interface ProjectMediaQaReport {
  version: number;
  readOnly: true;
  projectId: string;
  generatedAt: string;
  status: QaCheckStatus;
  /**
   * SHA-256 of the exact final artifact evaluated (null when no final artifact could be read).
   * Approval evidence binds to THIS value; a changed artifact invalidates the old QA result.
   */
  artifactHash: string | null;
  /** SHA-256 of the canonicalised report (excluding this field). Identifies the QA evidence. */
  reportHash: string;
  artifacts: ProjectQaArtifact[];
  scenes: ProjectQaGroupSummary;
  narration: ProjectQaGroupSummary;
  final: ProjectQaGroupSummary;
  counts: ProjectQaCounts;
  /** Flattened checks (project + every artifact), in evaluation order. */
  checks: QaCheck[];
  /** Analyses deliberately not performed here (documented gaps). */
  skipped: string[];
}

export interface ProjectMediaQaOptions {
  projectId: string;
  /** Absolute project outputs dir (production/outputs/<id>). */
  outputsDir: string;
  /** Pipeline document; used to derive scene manifest/order and narration requirements. */
  pipeline?: any;
  /** Absolute project input root (production/inputs/<id>). Narration lives in `<inputRoot>/narration`. */
  inputRoot?: string;
  /** Explicit scene manifest (overrides `pipeline`). */
  scenes?: ProjectQaSceneRef[];
  /** Final artifact to evaluate (defaults to the canonical TITLE output `final-title.mp4`). */
  finalPath?: string;
  /** Edit-stage reference render used only for a duration cross-check. `null` disables it. */
  referenceFinalPath?: string | null;
  expectedFinalDurationSeconds?: number | null;
  /** Per-scene expected duration resolver (overrides `ref.expectedDurationSeconds`). */
  expectedSceneDurationSeconds?: (scene: ProjectQaSceneRef) => number | null | undefined;
  ffmpegPath?: string;
  ffprobePath?: string;
  skipScenes?: boolean;
  skipNarration?: boolean;
  skipFinal?: boolean;
  skipBlack?: boolean;
  skipFreeze?: boolean;
  /** Picture floor for source/target masters. Default 720 (the channel's 1280x720 contract). */
  minHeight?: number;
  targetHeight?: number;
  sceneDurationToleranceSeconds?: number;
  finalDurationToleranceSeconds?: number;
  /** Deterministic timestamp for stable reports/tests. */
  now?: string;
  /** Test seam: replace the media QA engine. */
  runMediaQa?: (options: MediaQaOptions) => Promise<MediaQaReport>;
  /** Test seam: read minimal container metadata for the edit-stage reference render. */
  probe?: (file: string) => Promise<{ readable: boolean; formatDurationSeconds: number | null }>;
}

/** One line of QA evidence persisted with an approval record (bounded size). */
export interface MediaQaEvidenceCheck {
  id: string;
  asset: string;
  status: QaCheckStatus;
  severity: string;
  explanation: string;
}

export interface MediaQaEvidence {
  status: QaCheckStatus;
  /** SHA-256 of the artifact the QA run evaluated (must equal the approved artifact hash). */
  artifact_hash: string;
  /** SHA-256 of the canonical QA report that produced this evidence. */
  report_hash: string;
  generated_at: string;
  blockers: number;
  warnings: number;
  /** FAIL/WARNING/SKIPPED checks (PASS rows stay in the full report). */
  checks: MediaQaEvidenceCheck[];
}

const pad4 = (n: number): string => String(n).padStart(4, '0');

const SKIPPED_NOTES = [
  'scene_transition_continuity (abrupt-cut detection needs a per-frame diff of the concatenated render; review the edit manually)',
  'subtitle_caption_timing (no caption track exists in this pipeline)',
  'music_stem_isolation (the QA probe cannot separate the music bed from narration; loudness is measured on the final mix)',
];

/** PURE: derive the scene manifest from a pipeline document. Never throws. */
export function scenesFromPipeline(pipeline: any): ProjectQaSceneRef[] {
  const raw: any[] = Array.isArray(pipeline?.scenes) ? pipeline.scenes : [];
  return raw.map((scene: any, index: number) => {
    const declared = Number(scene?.scene_number);
    const sceneNumber = Number.isInteger(declared) && declared > 0 ? declared : index + 1;
    const editLen = Number(scene?.edit_length_seconds);
    const clipLen = Number(scene?.clip_length_seconds);
    const expected = Number.isFinite(editLen) && editLen > 0
      ? editLen
      : Number.isFinite(clipLen) && clipLen > 0 ? clipLen : null;
    const narrationText = String(scene?.narration_text ?? '').trim();
    return {
      sceneNumber,
      expectedDurationSeconds: expected,
      narrationRequired: narrationText.length > 0,
      speaker: String(scene?.speaker ?? '').trim() || null,
    };
  });
}

/** PURE: validate scene numbering (unique, ascending, contiguous, starting at 1). */
export function evaluateSceneOrder(sceneNumbers: number[]): { status: 'PASS' | 'FAIL'; problems: string[] } {
  const problems: string[] = [];
  const nums = sceneNumbers.map((n) => Number(n));
  const invalid = nums.filter((n) => !Number.isInteger(n) || n <= 0);
  if (invalid.length) problems.push(`non-positive or non-integer scene numbers: ${invalid.join(', ')}`);

  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const n of nums) {
    if (seen.has(n)) duplicates.add(n);
    seen.add(n);
  }
  if (duplicates.size) problems.push(`duplicate scene numbers: ${[...duplicates].join(', ')}`);

  for (let i = 1; i < nums.length; i++) {
    if (Number.isFinite(nums[i]) && Number.isFinite(nums[i - 1]) && nums[i] <= nums[i - 1]) {
      problems.push(`scene numbers are not strictly ascending (${nums[i - 1]} then ${nums[i]})`);
      break;
    }
  }

  const sorted = [...seen].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  if (sorted.length && sorted[0] !== 1) problems.push(`scene numbering must start at 1 (found ${sorted[0]})`);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) {
      problems.push(`gap in scene numbering between ${sorted[i - 1]} and ${sorted[i]}`);
      break;
    }
  }
  return { status: problems.length ? 'FAIL' : 'PASS', problems };
}

function summarize(checks: QaCheck[]): QaCheckStatus {
  if (checks.some((c) => c.status === 'FAIL')) return 'FAIL';
  if (checks.some((c) => c.status === 'WARNING')) return 'WARNING';
  return checks.length ? 'PASS' : 'SKIPPED';
}

function groupSummary(checks: QaCheck[]): ProjectQaGroupSummary {
  const count = (status: QaCheckStatus) => checks.filter((c) => c.status === status).length;
  return {
    status: summarize(checks),
    total: checks.length,
    pass: count('PASS'),
    warning: count('WARNING'),
    fail: count('FAIL'),
    skipped: count('SKIPPED'),
    blockers: count('FAIL'),
    warnings: count('WARNING'),
    checks,
  };
}

function countsOf(checks: QaCheck[]): ProjectQaCounts {
  const count = (status: QaCheckStatus) => checks.filter((c) => c.status === status).length;
  return {
    total: checks.length,
    pass: count('PASS'),
    warning: count('WARNING'),
    fail: count('FAIL'),
    skipped: count('SKIPPED'),
    blockers: count('FAIL'),
    warnings: count('WARNING'),
  };
}

function nameChecks(checks: QaCheck[], asset: string): QaCheck[] {
  return checks.map((check) => ({ ...check, asset }));
}

/** PURE: canonical JSON (sorted keys) so reports and their hash are byte-stable. */
export function stableStringify(value: unknown): string {
  const canonical = (input: any): any => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input).sort()) out[key] = canonical(input[key]);
      return out;
    }
    return input;
  };
  return JSON.stringify(canonical(value));
}

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

async function resolveNarration(dir: string, sceneNumber: number): Promise<{ path: string; candidates: string[] } | null> {
  const candidates: string[] = [];
  for (const ext of NARRATION_EXTENSIONS) {
    const candidate = path.join(dir, `narration-${pad4(sceneNumber)}${ext}`);
    const stat = await fsp.stat(candidate).catch(() => null);
    if (stat?.isFile()) candidates.push(candidate);
  }
  if (candidates.length === 0) return null;
  return { path: candidates[0], candidates };
}

async function sceneSidecarChecks(
  outputsDir: string,
  asset: string,
  sceneNumber: number,
  sha256: string | null,
): Promise<QaCheck[]> {
  const sidecarPath = path.join(outputsDir, `${asset}.json`);
  const raw = await fsp.readFile(sidecarPath, 'utf8').catch(() => null);
  if (raw === null) {
    return [{
      id: 'scene.sidecar', asset, status: 'SKIPPED', severity: 'SKIPPED',
      expected: `${asset}.json render sidecar`, actual: 'absent',
      explanation: 'No render sidecar exists for this scene, so its provenance cannot be cross-checked.',
    }];
  }
  let sidecar: any;
  try {
    sidecar = JSON.parse(raw);
  } catch {
    return [{
      id: 'scene.sidecar', asset, status: 'FAIL', severity: 'BLOCKER',
      expected: 'valid JSON render sidecar', actual: 'unparseable',
      explanation: 'The scene render sidecar is corrupt.',
      remedy: 'Re-render the scene so a valid sidecar is written.',
    }];
  }

  const checks: QaCheck[] = [{
    id: 'scene.sidecar', asset, status: 'PASS', severity: 'INFO',
    expected: `${asset}.json render sidecar`, actual: 'readable',
    explanation: 'Scene render sidecar is readable.',
  }];

  const recordedNumber = Number(sidecar?.scene_number);
  if (!Number.isFinite(recordedNumber)) {
    checks.push({
      id: 'scene.identity', asset, status: 'WARNING', severity: 'WARNING',
      expected: sceneNumber, actual: 'missing',
      explanation: 'The sidecar does not record which scene it belongs to.',
      remedy: 'Re-render the scene so the sidecar records its scene number.',
    });
  } else if (recordedNumber !== sceneNumber) {
    checks.push({
      id: 'scene.identity', asset, status: 'FAIL', severity: 'BLOCKER',
      expected: sceneNumber, actual: recordedNumber,
      explanation: `The sidecar belongs to scene ${recordedNumber} but the file is ${asset}.`,
      remedy: 'Re-render or re-copy the correct scene clip so file, sidecar and manifest agree.',
    });
  } else {
    checks.push({
      id: 'scene.identity', asset, status: 'PASS', severity: 'INFO',
      expected: sceneNumber, actual: recordedNumber,
      explanation: 'Sidecar scene number matches the clip.',
    });
  }

  const recordedHash = typeof sidecar?.output_hash === 'string' ? sidecar.output_hash.trim().toLowerCase() : '';
  if (!recordedHash) {
    checks.push({
      id: 'scene.provenance', asset, status: 'WARNING', severity: 'WARNING',
      expected: 'recorded output_hash', actual: 'absent',
      explanation: 'The sidecar records no output hash, so the clip cannot be tied to its render.',
      remedy: 'Re-render the scene so provenance is recorded.',
    });
  } else if (sha256 && recordedHash !== sha256.toLowerCase()) {
    checks.push({
      id: 'scene.provenance', asset, status: 'FAIL', severity: 'BLOCKER',
      expected: recordedHash, actual: sha256,
      explanation: 'The scene clip no longer matches the hash recorded when it was rendered (the media changed after render).',
      remedy: 'Re-render the scene, or restore the recorded media before approving.',
    });
  } else {
    checks.push({
      id: 'scene.provenance', asset, status: 'PASS', severity: 'INFO',
      expected: recordedHash, actual: sha256,
      explanation: 'Scene clip matches its recorded provenance hash.',
    });
  }
  return checks;
}

/**
 * Run the project-level QA. Read-only: every measurement goes through `runMediaQa` (ffmpeg
 * `-f null` passes / ffprobe) and nothing outside the returned report is written.
 */
export async function runProjectMediaQa(options: ProjectMediaQaOptions): Promise<ProjectMediaQaReport> {
  const projectId = String(options.projectId ?? '').trim();
  const outputsDir = path.resolve(options.outputsDir);
  const run = options.runMediaQa ?? runMediaQa;
  const probe = options.probe ?? ((file: string) => probeMedia(file, { ffprobePath: options.ffprobePath }));
  const generatedAt = options.now ?? new Date().toISOString();
  const refs = options.scenes ?? scenesFromPipeline(options.pipeline);
  const narrationDir = options.inputRoot ? path.join(options.inputRoot, 'narration') : undefined;
  const minHeight = options.minHeight ?? 720;
  const targetHeight = options.targetHeight ?? 720;
  const sceneTolerance = options.sceneDurationToleranceSeconds ?? 2;
  const finalTolerance = options.finalDurationToleranceSeconds ?? 2;
  const skipped: string[] = [...SKIPPED_NOTES];

  const projectChecks: QaCheck[] = [];
  const sceneArtifacts: ProjectQaArtifact[] = [];
  const narrationArtifacts: ProjectQaArtifact[] = [];

  // ---------------------------------------------------------------- scenes
  if (!options.skipScenes) {
    const order = evaluateSceneOrder(refs.map((ref) => ref.sceneNumber));
    projectChecks.push({
      id: 'scenes.order',
      asset: 'project',
      status: order.status,
      severity: order.status === 'FAIL' ? 'BLOCKER' : 'INFO',
      expected: 'contiguous, unique, ascending scene numbers starting at 1',
      actual: refs.map((ref) => ref.sceneNumber),
      explanation: order.status === 'FAIL' ? order.problems.join(' ') : `${refs.length} scene(s) declared in ascending order.`,
      ...(order.status === 'FAIL' ? { remedy: 'Rebuild the scene manifest so scene numbers are unique, contiguous and ascending.' } : {}),
    });
    if (refs.length === 0) {
      projectChecks.push({
        id: 'scenes.present', asset: 'project', status: 'FAIL', severity: 'BLOCKER',
        expected: 'at least one scene', actual: 0,
        explanation: 'The project manifest declares no scenes.',
        remedy: 'Rebuild the project manifest before approving.',
      });
    }

    for (const ref of refs) {
      const asset = `scene-${pad4(ref.sceneNumber)}`;
      const clipPath = ref.clipPath ?? path.join(outputsDir, `${asset}.mp4`);
      const resolvedExpected = options.expectedSceneDurationSeconds
        ? options.expectedSceneDurationSeconds(ref)
        : ref.expectedDurationSeconds;
      const expectedDuration = typeof resolvedExpected === 'number' && resolvedExpected > 0 ? resolvedExpected : undefined;
      const report = await run({
        input: clipPath,
        kind: 'video',
        ffmpegPath: options.ffmpegPath,
        ffprobePath: options.ffprobePath,
        minHeight,
        targetHeight,
        // Scene audio is optional: narrator-only Flow clips may legitimately carry no voice.
        requireAudio: false,
        // Deliberate silence in a scene clip is not a defect (ambience/dialogue may be sparse).
        skipSilence: true,
        allowAudioSilence: true,
        expectDurationSeconds: expectedDuration,
        durationToleranceSeconds: sceneTolerance,
        skipBlack: options.skipBlack,
        skipFreeze: options.skipFreeze,
      });
      const checks = nameChecks(report.checks, asset);
      checks.push(...await sceneSidecarChecks(outputsDir, asset, ref.sceneNumber, report.sha256));
      sceneArtifacts.push({
        asset, kind: 'scene', sceneNumber: ref.sceneNumber, path: clipPath,
        sha256: report.sha256, bytes: report.bytes, durationSeconds: report.durationSeconds,
        fps: report.fps, width: report.width, height: report.height,
        status: summarize(checks), checks,
      });
    }

    // Identical media across different scenes is suspicious but not necessarily wrong.
    const byHash = new Map<string, string[]>();
    for (const artifact of sceneArtifacts) {
      if (!artifact.sha256) continue;
      const list = byHash.get(artifact.sha256) ?? [];
      list.push(artifact.asset);
      byHash.set(artifact.sha256, list);
    }
    for (const [hash, assets] of byHash) {
      if (assets.length > 1) {
        projectChecks.push({
          id: 'scene.reused', asset: 'project', status: 'WARNING', severity: 'WARNING',
          expected: 'distinct media per scene', actual: assets,
          explanation: `Scenes ${assets.join(', ')} ship identical media (sha256 ${hash.slice(0, 12)}…).`,
          remedy: 'Confirm the reuse is intentional; otherwise regenerate the duplicated scene.',
        });
      }
    }
  } else {
    skipped.push('scenes (disabled by caller)');
  }

  // -------------------------------------------------------------- narration
  if (!options.skipNarration) {
    for (const ref of refs) {
      const asset = `narration-${pad4(ref.sceneNumber)}`;
      const found = ref.narrationPath
        ? { path: ref.narrationPath, candidates: [ref.narrationPath] }
        : narrationDir ? await resolveNarration(narrationDir, ref.sceneNumber) : null;
      const required = ref.narrationRequired === true;

      if (!found) {
        if (!required) {
          skipped.push(`${asset} (no narration required for this scene)`);
          continue;
        }
        const checks: QaCheck[] = [{
          id: 'narration.missing', asset, status: 'WARNING', severity: 'WARNING',
          expected: 'Hindi narrator audio for a narrator scene', actual: 'absent',
          explanation: 'The manifest expects narration for this scene but no narration file was found.',
          remedy: 'Generate the Hindi narrator line for this scene before approving, or confirm Flow character audio covers it.',
        }];
        narrationArtifacts.push({
          asset, kind: 'narration', sceneNumber: ref.sceneNumber,
          path: narrationDir ? path.join(narrationDir, `${asset}.wav`) : '',
          sha256: null, bytes: null, durationSeconds: null, fps: null, width: null, height: null,
          status: summarize(checks), checks,
        });
        continue;
      }

      const report = await run({
        input: found.path,
        kind: 'audio',
        ffmpegPath: options.ffmpegPath,
        ffprobePath: options.ffprobePath,
        requireVideo: false,
        requireAudio: true,
        skipBlack: true,
        skipFreeze: true,
        allowAudioSilence: false,
      });
      const checks = nameChecks(report.checks, asset);
      if (found.candidates.length > 1) {
        checks.push({
          id: 'narration.ambiguous', asset, status: 'WARNING', severity: 'WARNING',
          expected: 'one narration file per scene', actual: found.candidates.map((c) => path.basename(c)),
          explanation: 'Multiple narration files exist for this scene; only the first was analysed.',
          remedy: 'Remove the stale narration variants so the mix uses an unambiguous source.',
        });
      }
      narrationArtifacts.push({
        asset, kind: 'narration', sceneNumber: ref.sceneNumber, path: found.path,
        sha256: report.sha256, bytes: report.bytes, durationSeconds: report.durationSeconds,
        fps: report.fps, width: report.width, height: report.height,
        status: summarize(checks), checks,
      });
    }
  } else {
    skipped.push('narration (disabled by caller)');
  }

  // ------------------------------------------------------------------ final
  let finalArtifact: ProjectQaArtifact | null = null;
  if (!options.skipFinal) {
    const finalPath = options.finalPath ?? path.join(outputsDir, stageOutputName('TITLE'));
    const asset = path.basename(finalPath);
    const expected = typeof options.expectedFinalDurationSeconds === 'number' && options.expectedFinalDurationSeconds > 0
      ? options.expectedFinalDurationSeconds
      : undefined;
    const report = await run({
      input: finalPath,
      kind: 'video',
      ffmpegPath: options.ffmpegPath,
      ffprobePath: options.ffprobePath,
      minHeight,
      targetHeight,
      requireVideo: true,
      requireAudio: true,
      expectDurationSeconds: expected,
      durationToleranceSeconds: finalTolerance,
      skipBlack: options.skipBlack,
      skipFreeze: options.skipFreeze,
    });
    const checks = nameChecks(report.checks, asset);

    if (expected === undefined && options.referenceFinalPath !== null) {
      const referencePath = options.referenceFinalPath ?? path.join(outputsDir, 'final-with-fades.mp4');
      const reference = await probe(referencePath);
      if (reference.readable && typeof reference.formatDurationSeconds === 'number' && reference.formatDurationSeconds > 0
        && typeof report.durationSeconds === 'number' && report.durationSeconds > 0) {
        const delta = Math.abs(report.durationSeconds - reference.formatDurationSeconds);
        checks.push({
          id: 'final.duration_match', asset,
          status: delta > finalTolerance ? 'WARNING' : 'PASS',
          severity: delta > finalTolerance ? 'WARNING' : 'INFO',
          expected: Number(reference.formatDurationSeconds.toFixed(3)),
          actual: Number(report.durationSeconds.toFixed(3)),
          explanation: delta > finalTolerance
            ? `The final render is ${delta.toFixed(2)}s away from the edit-stage render (tolerance ${finalTolerance}s).`
            : 'The final render matches the edit-stage duration.',
          ...(delta > finalTolerance ? { remedy: 'Confirm the bed/title stages did not add or drop runtime before publishing.' } : {}),
        });
      } else {
        checks.push({
          id: 'final.duration_match', asset, status: 'SKIPPED', severity: 'SKIPPED',
          expected: 'edit-stage reference render', actual: 'unavailable',
          explanation: 'No readable edit-stage render exists to cross-check the final duration.',
        });
      }
    }

    finalArtifact = {
      asset, kind: 'final', sceneNumber: null, path: finalPath,
      sha256: report.sha256, bytes: report.bytes, durationSeconds: report.durationSeconds,
      fps: report.fps, width: report.width, height: report.height,
      status: summarize(checks), checks,
    };
  } else {
    skipped.push('final (disabled by caller)');
  }

  // ------------------------------------------------------------- roll-up
  const sceneChecks = [...projectChecks, ...sceneArtifacts.flatMap((a) => a.checks)];
  const narrationChecks = narrationArtifacts.flatMap((a) => a.checks);
  const finalChecks = finalArtifact ? finalArtifact.checks : [];
  const allChecks = [...sceneChecks, ...narrationChecks, ...finalChecks];
  const scenes = groupSummary(sceneChecks);
  const narration = groupSummary(narrationChecks);
  const final = finalArtifact
    ? groupSummary(finalChecks)
    : { ...groupSummary([]), status: 'SKIPPED' as QaCheckStatus };

  const status: QaCheckStatus = [scenes.status, narration.status, final.status].includes('FAIL')
    ? 'FAIL'
    : [scenes.status, narration.status, final.status].includes('WARNING') ? 'WARNING' : 'PASS';

  const artifacts = [...sceneArtifacts, ...narrationArtifacts, ...(finalArtifact ? [finalArtifact] : [])];
  const core = {
    version: PROJECT_QA_VERSION,
    readOnly: true as const,
    projectId,
    generatedAt,
    status,
    artifactHash: finalArtifact?.sha256 ?? null,
    artifacts,
    scenes,
    narration,
    final,
    counts: countsOf(allChecks),
    checks: allChecks,
    skipped,
  };
  return { ...core, reportHash: sha256Hex(stableStringify(core)) };
}

/** True when this report evaluated exactly `sha256` and may authorize its approval. */
export function qaAuthorizesArtifact(report: ProjectMediaQaReport, sha256: string | null | undefined): boolean {
  const expected = String(sha256 ?? '').trim().toLowerCase();
  if (!expected) return false;
  if (report.status === 'FAIL') return false;
  return String(report.artifactHash ?? '').toLowerCase() === expected;
}

/**
 * Compact, bounded evidence to persist with an approval record. Returns null when the report
 * cannot identify the exact artifact (a missing final render must never become approval evidence).
 */
export function projectQaEvidence(report: ProjectMediaQaReport, options: { maxChecks?: number } = {}): MediaQaEvidence | null {
  if (!report.artifactHash) return null;
  const max = Math.max(1, options.maxChecks ?? 200);
  const checks = report.checks
    .filter((check) => check.status !== 'PASS')
    .slice(0, max)
    .map((check) => ({
      id: check.id,
      asset: check.asset,
      status: check.status,
      severity: check.severity,
      explanation: check.explanation,
    }));
  return {
    status: report.status,
    artifact_hash: report.artifactHash,
    report_hash: report.reportHash,
    generated_at: report.generatedAt,
    blockers: report.counts.blockers,
    warnings: report.counts.warnings,
    checks,
  };
}

/** Human-readable project QA summary (per-scene + final, blockers first). PURE. */
export function renderProjectQaReport(report: ProjectMediaQaReport): string {
  const lines: string[] = [];
  lines.push(`project media QA: ${report.status} (${report.counts.blockers} blocker(s), ${report.counts.warnings} warning(s))`);
  lines.push(`project:          ${report.projectId}`);
  lines.push(`final artifact:   ${report.artifactHash ?? 'not evaluated'}`);
  lines.push(`report hash:      ${report.reportHash}`);
  const groupLine = (label: string, group: ProjectQaGroupSummary) =>
    `${label}: ${group.status}  ${group.pass} pass / ${group.warning} warning / ${group.fail} fail / ${group.skipped} skipped (${group.total} checks)`;
  lines.push(groupLine('scenes', report.scenes));
  lines.push(groupLine('narration', report.narration));
  lines.push(groupLine('final', report.final));
  lines.push('');

  const failures = report.checks.filter((c) => c.status === 'FAIL');
  const warnings = report.checks.filter((c) => c.status === 'WARNING');
  if (failures.length) {
    lines.push('BLOCKERS:');
    for (const c of failures) {
      lines.push(`  [FAIL] ${c.asset} ${c.id}: ${c.explanation}`);
      if (c.expected !== undefined || c.actual !== undefined) {
        lines.push(`         expected ${JSON.stringify(c.expected)}  actual ${JSON.stringify(c.actual)}`);
      }
      if (c.remedy) lines.push(`         fix: ${c.remedy}`);
    }
    lines.push('');
  }
  if (warnings.length) {
    lines.push('WARNINGS (review required, not blocking unless --qa-warnings-block):');
    for (const c of warnings) {
      lines.push(`  [WARN] ${c.asset} ${c.id}: ${c.explanation}`);
      if (c.remedy) lines.push(`         fix: ${c.remedy}`);
    }
    lines.push('');
  }

  lines.push('scenes:');
  for (const artifact of report.artifacts.filter((a) => a.kind === 'scene')) {
    lines.push(`  ${artifact.asset}  ${artifact.status.padEnd(7)} ${artifact.width ?? '?'}x${artifact.height ?? '?'} ${artifact.fps ?? '?'}fps ${artifact.durationSeconds ?? '?'}s ${artifact.bytes ?? '?'} bytes`);
  }
  lines.push('narration:');
  const narrationArtifacts = report.artifacts.filter((a) => a.kind === 'narration');
  if (!narrationArtifacts.length) lines.push('  (nothing analysed)');
  for (const artifact of narrationArtifacts) {
    lines.push(`  ${artifact.asset}  ${artifact.status.padEnd(7)} ${artifact.durationSeconds ?? '?'}s ${artifact.bytes ?? '?'} bytes`);
  }
  const finalArtifact = report.artifacts.find((a) => a.kind === 'final');
  if (finalArtifact) {
    lines.push('final:');
    lines.push(`  ${finalArtifact.asset}  ${finalArtifact.status.padEnd(7)} ${finalArtifact.width ?? '?'}x${finalArtifact.height ?? '?'} ${finalArtifact.durationSeconds ?? '?'}s ${finalArtifact.bytes ?? '?'} bytes`);
  }
  lines.push('');
  lines.push(`not checked: ${report.skipped.join('; ')}`);
  lines.push('note:        this QA run is read-only. Nothing was rendered, uploaded or published.');
  return lines.join('\n');
}
