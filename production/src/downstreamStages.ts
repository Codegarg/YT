/**
 * Downstream stage dependency graph (STEP-8DH).
 *
 * Models and proves the chain:
 *
 *   scene outputs → EDIT → MIX → BED → TITLE → APPROVAL
 *
 * Each stage carries a deterministic KEY derived ONLY from its real dependencies (contract
 * version, upstream output hashes, participating narration hashes/durations, BGM/intro/logo
 * hashes, title metadata). No timestamps, no absolute paths, no UUIDs, no browser state.
 *
 * This module performs NO real media work: `edit.ts` / `mixNarration.ts` / `addMusicBed.ts` /
 * `addTitle.ts` are NEVER executed here. Execution is injected as a synthetic `StageExecutor`
 * so a dry run can prove precise invalidation and resumability.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { RENDERER_CONTRACT_VERSION } from './sceneState.js';
import type { OutputState } from './projectState.js';

export const DOWNSTREAM_STAGES = ['EDIT', 'MIX', 'BED', 'TITLE', 'APPROVAL'] as const;
export type DownstreamStage = (typeof DOWNSTREAM_STAGES)[number];

/** A stage is either NOT_STARTED, one of the shared OutputStates, or FAILED. */
export type StageState = OutputState | 'NOT_STARTED' | 'FAILED';

export interface StageInputs {
  /** Ordered scene output hashes (scene number → hash). EDIT depends on this set. */
  sceneOutputHashes: Record<string, string>;
  /** Narration assets that actually participate in mixing (hash + measured duration). */
  narration: Record<string, { hash: string; durationSeconds: number | null }>;
  /** Externally supplied asset hashes. */
  editOutputHash?: string | null;
  mixOutputHash?: string | null;
  bedOutputHash?: string | null;
  titleOutputHash?: string | null;
  bgmHash?: string | null;
  introHash?: string | null;
  logoHash?: string | null;
  titleMetadata?: unknown;
}

export interface StageDefinition {
  stage: DownstreamStage;
  dependsOn: DownstreamStage[];
  key: string;
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const orderedHashes = (map: Record<string, string> | undefined): string =>
  Object.entries(map ?? {}).sort((a, b) => Number(a[0]) - Number(b[0])).map(([n, h]) => `${n}:${h}`).join('|');
const orderedNarration = (map: StageInputs['narration'] | undefined): string =>
  Object.entries(map ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([n, v]) => `${n}:${v.hash}:${v.durationSeconds === null ? 'na' : v.durationSeconds.toFixed(3)}`).join('|');

/**
 * Deterministic stage key. Same logical inputs ⇒ same key; any real dependency change ⇒ new key.
 */
export function stageKey(stage: DownstreamStage, inputs: StageInputs): string {
  const parts: string[] = ['v1', RENDERER_CONTRACT_VERSION, `stage:${stage}`];
  switch (stage) {
    case 'EDIT':
      parts.push(`scenes:${orderedHashes(inputs.sceneOutputHashes)}`);
      break;
    case 'MIX':
      parts.push(`edit:${inputs.editOutputHash ?? 'none'}`);
      parts.push(`narration:${orderedNarration(inputs.narration)}`);
      break;
    case 'BED':
      parts.push(`mix:${inputs.mixOutputHash ?? 'none'}`);
      parts.push(`bgm:${inputs.bgmHash ?? 'none'}`);
      break;
    case 'TITLE':
      parts.push(`bed:${inputs.bedOutputHash ?? 'none'}`);
      parts.push(`intro:${inputs.introHash ?? 'none'}`);
      parts.push(`logo:${inputs.logoHash ?? 'none'}`);
      parts.push(`meta:${sha(JSON.stringify(inputs.titleMetadata ?? null))}`);
      break;
    case 'APPROVAL':
      parts.push(`title:${inputs.titleOutputHash ?? 'none'}`);
      break;
  }
  return sha(parts.join('|'));
}

/** The full stage graph with a computed key for each node. */
export function buildStageGraph(inputs: StageInputs): StageDefinition[] {
  return [
    { stage: 'EDIT', dependsOn: [], key: stageKey('EDIT', inputs) },
    { stage: 'MIX', dependsOn: ['EDIT'], key: stageKey('MIX', inputs) },
    { stage: 'BED', dependsOn: ['MIX'], key: stageKey('BED', inputs) },
    { stage: 'TITLE', dependsOn: ['BED'], key: stageKey('TITLE', inputs) },
    { stage: 'APPROVAL', dependsOn: ['TITLE'], key: stageKey('APPROVAL', inputs) },
  ];
}

// ---------------------------------------------------------------------------------------
// Classification + work set
// ---------------------------------------------------------------------------------------

export interface RecordedStage {
  key?: string;
  output_hash?: string;
  output_path?: string;
}

/**
 * Per-stage integrity verdict, computed from the ACTUAL output file on disk (STEP-8FQ).
 * `ok:true` means the recorded output_path exists, is readable, and its current SHA-256
 * equals the recorded output_hash. Any other value forces the stage out of CURRENT.
 */
export interface StageIntegrity {
  ok: boolean;
  reason?: string;
}

/**
 * Classify one stage against its current key.
 * A stage is CURRENT only when a trustworthy recorded key matches AND its declared upstream
 * stages are themselves CURRENT (fail-closed downstream propagation) AND — when integrity
 * evidence is supplied — the recorded output is present with a matching SHA-256.
 *
 * `integrity` is optional so the pure stage-graph planner keeps its original behavior for
 * callers that have not (yet) verified on-disk outputs; when supplied, it fails closed.
 */
export function classifyStage(
  stage: DownstreamStage, currentKey: string, recorded?: RecordedStage,
  upstream: Record<DownstreamStage, StageState> = {} as any,
  integrity?: StageIntegrity,
): StageState {
  const depsCurrent = { EDIT: [], MIX: ['EDIT'], BED: ['MIX'], TITLE: ['BED'], APPROVAL: ['TITLE'] }[stage] as DownstreamStage[];
  if (depsCurrent.some((d) => upstream[d] !== 'CURRENT')) return 'STALE';
  if (!recorded || !recorded.key) return 'NOT_STARTED';
  if (recorded.key !== currentKey) return 'STALE';
  // STEP-8FQ: a matching key is necessary but NOT sufficient — the recorded output must still
  // exist and hash-match. A corrupt/deleted/missing-hash output is never CURRENT.
  if (integrity && integrity.ok !== true) return 'NOT_STARTED';
  return 'CURRENT';
}

export interface DownstreamPlan {
  stages: DownstreamStage[];
  states: Record<DownstreamStage, StageState>;
  /** Stages that must (re)run this pass, in dependency order. */
  workSet: DownstreamStage[];
}

/**
 * Plan the downstream work set. A stale/not-started/failed stage pulls its downstream chain.
 * Completed-but-current upstream stages are never re-run because of a downstream change.
 *
 * `opts.integrity` (STEP-8FQ) carries the per-stage on-disk output verdicts. When supplied, a
 * stage whose recorded output is missing/corrupt no longer counts as CURRENT and its downstream
 * dependents are pulled through the existing dependency graph.
 */
export function planDownstream(inputs: StageInputs, recorded: Record<DownstreamStage, RecordedStage | undefined>, opts: { approved?: boolean; integrity?: Partial<Record<DownstreamStage, StageIntegrity>> } = {}): DownstreamPlan {
  const graph = buildStageGraph(inputs);
  const states = {} as Record<DownstreamStage, StageState>;
  const workSet: DownstreamStage[] = [];
  for (const node of graph) {
    let s = classifyStage(node.stage, node.key, recorded[node.stage], states, opts.integrity?.[node.stage]);
    if (node.stage === 'APPROVAL') {
      // APPROVAL is CURRENT only when the title is current AND a human has approved.
      if (s === 'CURRENT' && opts.approved !== true) s = 'NOT_STARTED';
    }
    states[node.stage] = s;
    if (s !== 'CURRENT') workSet.push(node.stage);
  }
  return { stages: [...DOWNSTREAM_STAGES], states, workSet };
}

// ---------------------------------------------------------------------------------------
// Synthetic stage executor abstraction (dry-run only)
// ---------------------------------------------------------------------------------------

export interface StageExecutionResult {
  ok: boolean;
  outputPath?: string;
  outputHash?: string;
  reason?: string;
}

export type StageExecutor = (
  stage: DownstreamStage,
  outputPath: string,
  keys: { stageKey: string; dependencyHash: string },
) => Promise<StageExecutionResult>;

/** The key-relevant subset of StageInputs for a stage's recorded binding (STEP-8GY provenance). */
export interface StageKeyInputs {
  bgmHash?: string | null;
  introHash?: string | null;
  logoHash?: string | null;
  titleMetadata?: unknown;
  editOutputHash?: string | null;
  mixOutputHash?: string | null;
  bedOutputHash?: string | null;
  titleOutputHash?: string | null;
}

/** Extract the key-relevant inputs actually used to build a stage key (never a new source of truth). */
export function recordedKeyInputs(inputs: StageInputs | undefined | null): StageKeyInputs {
  const i = inputs ?? {} as StageInputs;
  return {
    bgmHash: i.bgmHash ?? null,
    introHash: i.introHash ?? null,
    logoHash: i.logoHash ?? null,
    titleMetadata: i.titleMetadata ?? null,
    editOutputHash: i.editOutputHash ?? null,
    mixOutputHash: i.mixOutputHash ?? null,
    bedOutputHash: i.bedOutputHash ?? null,
    titleOutputHash: i.titleOutputHash ?? null,
  };
}

/** Build a StageInputs from recorded key inputs, overlaying the caller's required fields. */
export function applyRecordedKeyInputs(base: StageInputs, rec: StageKeyInputs | undefined | null): StageInputs {
  if (!rec || typeof rec !== 'object') return base;
  return {
    ...base,
    bgmHash: rec.bgmHash ?? base.bgmHash ?? null,
    introHash: rec.introHash ?? base.introHash ?? null,
    logoHash: rec.logoHash ?? base.logoHash ?? null,
    titleMetadata: rec.titleMetadata ?? base.titleMetadata ?? null,
    editOutputHash: rec.editOutputHash ?? base.editOutputHash ?? null,
    mixOutputHash: rec.mixOutputHash ?? base.mixOutputHash ?? null,
    bedOutputHash: rec.bedOutputHash ?? base.bedOutputHash ?? null,
    titleOutputHash: rec.titleOutputHash ?? base.titleOutputHash ?? null,
  };
}

/** Output filename per stage inside the project outputs root. */
export function stageOutputName(stage: DownstreamStage): string {
  return {
    EDIT: 'final-with-fades.mp4',
    MIX: 'final-narrated.mp4',
    BED: 'final-bedded.mp4',
    TITLE: 'final-title.mp4',
    APPROVAL: 'final-title.mp4',
  }[stage];
}

/** Reject any stage output path that would escape the outputs root. */
export function safeStageOutputPath(outputsDir: string, stage: DownstreamStage): string {
  const root = path.resolve(outputsDir);
  const resolved = path.resolve(root, stageOutputName(stage));
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Refusing a stage output outside ${root}: ${resolved}.`);
  return resolved;
}

export async function sha256OfFileOrNull(file: string): Promise<string | null> {
  try {
    const b = await fsp.readFile(file);
    return crypto.createHash('sha256').update(b).digest('hex');
  } catch { return null; }
}

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * Verify a recorded downstream stage's output against the ACTUAL file on disk (STEP-8FQ).
 *
 * Fail-closed decision table (never CURRENT on any doubt):
 *   · no recorded record / no key            → { ok:false }  (nothing to trust)
 *   · missing output_hash                    → { ok:false }
 *   · malformed output_hash (not 64-hex)     → { ok:false }
 *   · output_path escapes the outputs root    → { ok:false }
 *   · output file missing/unreadable          → { ok:false }
 *   · current SHA-256 ≠ recorded output_hash  → { ok:false }
 *   · all of the above pass                   → { ok:true, outputHash }
 *
 * The recorded hash is the integrity EXPECTATION; this helper never rewrites it. A stage whose
 * output fails verification must be re-executed to establish a new valid record.
 *
 * When `opts.validateMedia` is true the file must ALSO pass `validateVideoClip` (the existing
 * stage media contract). Media validation is opt-in so the pure planner stays usable without
 * an ffprobe binary; the orchestrator enables it.
 */
export async function validateRecordedStageOutput(
  stage: DownstreamStage,
  outputsDir: string,
  recorded?: RecordedStage,
  opts: { validateMedia?: boolean; ffprobePath?: string } = {},
): Promise<{ ok: true; outputHash: string } | { ok: false; reason: string }> {
  if (!recorded || !recorded.key) return { ok: false, reason: `${stage}: no recorded stage record.` };
  const expected = typeof recorded.output_hash === 'string' ? recorded.output_hash.trim().toLowerCase() : '';
  if (!expected) return { ok: false, reason: `${stage}: recorded output_hash is missing.` };
  if (!HEX64.test(expected)) return { ok: false, reason: `${stage}: recorded output_hash is malformed.` };

  // Resolve safely: the recorded path is a BASENAME inside the outputs root.
  let file: string;
  try { file = safeStageOutputPath(outputsDir, stage); } catch { return { ok: false, reason: `${stage}: unsafe output path.` }; }
  // If a record carries an explicit output_path, it must agree with the canonical stage output.
  if (recorded.output_path && path.basename(recorded.output_path) !== path.basename(file)) {
    return { ok: false, reason: `${stage}: recorded output_path does not match the canonical stage output.` };
  }

  const exists = await fsp.stat(file).then((s) => s.isFile()).catch(() => false);
  if (!exists) return { ok: false, reason: `${stage}: recorded output file is missing.` };

  const actual = await sha256OfFileOrNull(file);
  if (!actual) return { ok: false, reason: `${stage}: recorded output file is unreadable.` };
  if (actual.toLowerCase() !== expected) return { ok: false, reason: `${stage}: recorded output_hash does not match the file on disk.` };

  if (opts.validateMedia) {
    const { validateVideoClip } = await import('./videoClip.js');
    const clip = await validateVideoClip(file, { ffprobePath: opts.ffprobePath });
    if (clip.state !== 'VALID') return { ok: false, reason: `${stage}: recorded output failed media validation (${clip.state}).` };
  }
  return { ok: true, outputHash: actual };
}

/**
 * Verify every recorded downstream stage output in one pass. Returns a per-stage verdict map
 * suitable for `planDownstream({ integrity })`. Stages with no record are omitted (the planner
 * already treats them as NOT_STARTED).
 */
export async function validateRecordedStageOutputs(
  outputsDir: string,
  recorded: Record<DownstreamStage, RecordedStage | undefined>,
  opts: { validateMedia?: boolean; ffprobePath?: string } = {},
): Promise<Partial<Record<DownstreamStage, StageIntegrity>>> {
  const out: Partial<Record<DownstreamStage, StageIntegrity>> = {};
  for (const stage of ['EDIT', 'MIX', 'BED', 'TITLE'] as DownstreamStage[]) {
    const rec = recorded[stage];
    if (!rec || !rec.key) continue;
    const v = await validateRecordedStageOutput(stage, outputsDir, rec, opts);
    out[stage] = v.ok ? { ok: true } : { ok: false, reason: v.reason };
  }
  return out;
}
