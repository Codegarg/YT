/**
 * PHASE 7 — Hindi narration asset ledger, provenance and staleness.
 *
 * This module does NOT introduce a second narration system. It is the missing *inventory* layer on
 * top of the existing narration stack:
 *
 *   · text + scene intent come from `pipeline.json` via the existing `narrationWorkflow` classifier
 *     (`isNarrationScene`), so narrator speech and character dialogue stay separated exactly as the
 *     MIX stage already expects;
 *   · the filename/extension contract is `narrationDuration`'s (`narration-####.<ext>`);
 *   · real duration is ALWAYS measured with `ffprobe` (`probeMedia`), never inferred from text;
 *   · nothing here renders audio, calls a provider, opens a browser or spends credits.
 *
 * What it adds:
 *
 *   · a deterministic per-asset record: bytes hash, container/codec/sample-rate/channels, measured
 *     duration, the script text hash, the voice/config hash and a combined `input_key`;
 *   · explicit states (`ready`/`missing`/`empty`/`corrupt`/`format_invalid`/`stale`) instead of a
 *     bare "file exists" check, so a stale or truncated asset is never silently mixed;
 *   · immutable provenance (`provided_file` today; the provider boundary already exists for a future
 *     authorized generation run);
 *   · selective invalidation: an asset records exactly which dependents (long-form mix/QA and the
 *     individual Shorts) were built from its bytes, so one changed line never invalidates the rest.
 *
 * The ledger is a DERIVED CACHE under `outputs/<id>/narration/`. `pipeline.json` stays authoritative
 * for story/scene text and is only ever read.
 */

import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { probeMedia, computeFileSha256 } from './videoClip.js';
import { MAX_SCENE_AUDIO_SECONDS, mapNarrationFiles, narrationFilename, SUPPORTED_AUDIO_EXTENSIONS } from './narrationDuration.js';
import { isNarrationScene } from './narrationWorkflow.js';
import { stableStringify } from './projectMediaQa.js';

export const NARRATION_LEDGER_VERSION = 1;

export const NARRATION_LEDGER_FILE = 'narration-ledger.json';
export const NARRATION_QA_FILE = 'narration-qa.json';
export const NARRATION_APPROVAL_FILE = 'narration-approval.json';

/** Optional read-only sidecar the operator may supply inside the project's narration directory. */
export const PRONUNCIATION_FILE = 'pronunciation.json';

/** Audio codecs the narration ingest/MIX chain can consume without a second conversion step. */
export const ACCEPTED_AUDIO_CODECS = [
  'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8',
  'mp3', 'aac', 'flac', 'opus', 'vorbis',
] as const;

/** Sample rates accepted by the narration contract (16–48 kHz). */
export const ACCEPTED_SAMPLE_RATES = [16000, 22050, 24000, 32000, 44100, 48000] as const;

/** Narration must be mono or stereo; anything else is a delivery mistake, not a creative choice. */
export const MAX_NARRATION_CHANNELS = 2;

/** Shortest usable spoken line (a valid file that says nothing is a defect). */
export const MIN_NARRATION_SECONDS = 0.2;

/** Default voice/provider configuration — the SAME model/voice/language the provider uses. */
export const DEFAULT_NARRATION_VOICE = {
  provider: 'gemini_tts',
  model: process.env.GEMINI_TTS_MODEL ?? 'gemini-2.5-flash-preview-tts',
  voice: process.env.GEMINI_TTS_VOICE ?? 'Kore',
  language: process.env.GEMINI_TTS_LANGUAGE ?? 'hi-IN',
  narrator_style: 'Adult Hindi folk-horror narrator: slow, low, intimate, dread-building, never theatrical.',
} as const;

export type NarrationAssetState = 'ready' | 'missing' | 'empty' | 'corrupt' | 'format_invalid' | 'stale';

export interface NarrationVoiceConfig {
  provider: string;
  model: string;
  voice: string;
  language: string;
  narrator_style: string;
}

export interface PronunciationRule {
  /** Devanagari/Latin token to replace (matched on word boundaries where possible). */
  match: string;
  /** How the narrator should say it. */
  say: string;
  note?: string;
}

export interface PronunciationConfig {
  schema_version: number;
  voice: NarrationVoiceConfig;
  rules: PronunciationRule[];
  /** SHA-256 over `{voice, rules}` — part of every asset's input key. */
  config_hash: string;
}

export interface NarrationTextPlan {
  scene_number: number;
  /** `narration` = narrator speech (Hindi VO), `dialogue` = character speech kept from Flow audio. */
  kind: 'narration' | 'dialogue';
  /** True when this scene must have a narrator audio asset. */
  required: boolean;
  raw_text: string;
  /** Raw text after pronunciation rules — what a TTS request would actually say. */
  spoken_text: string;
  text_hash: string;
  title: string | null;
}

export interface NarrationProvenance {
  source: 'provided_file' | 'provider';
  provider: string | null;
  /** ISO timestamp of the ledger pass that first recorded this exact byte content. */
  recorded_at: string;
  /**
   * The `input_key` that was current when this exact byte content was first recorded.
   *
   * Preserved while the bytes are unchanged, so "is this line stale?" is answered by comparing the
   * bytes' recorded intent with the CURRENT script/voice/pronunciation intent. That makes the answer
   * stable under repeated passes: reverting a pronunciation rule makes the line current again instead
   * of leaving a permanent stale flag, and changing the script marks it stale even though nothing was
   * re-recorded.
   */
  produced_for_input_key: string;
}

export interface NarrationAssetRecord {
  scene_number: number;
  asset: string;
  /** Path relative to the project input root, e.g. `narration/narration-0001.wav`. */
  relative_path: string;
  sha256: string | null;
  bytes: number | null;
  duration_seconds: number | null;
  container: string | null;
  codec: string | null;
  sample_rate: number | null;
  channels: number | null;
  text_hash: string;
  voice_hash: string;
  config_hash: string;
  /** Deterministic key over script text + voice + pronunciation config (NOT the bytes). */
  input_key: string;
  state: NarrationAssetState;
  reason: string;
  /** True when the bytes differ from the previously recorded ledger. */
  content_changed: boolean;
  provenance: NarrationProvenance;
}

export interface NarrationLedger {
  schema_version: number;
  project_id: string;
  generated_at: string;
  read_only: true;
  input_root: string;
  voice: NarrationVoiceConfig;
  pronunciation: PronunciationConfig;
  scene_texts: NarrationTextPlan[];
  assets: NarrationAssetRecord[];
  missing_scenes: number[];
  stale_scenes: number[];
  invalid_scenes: number[];
  /** Sum of every READY asset's measured duration (never estimated from text). */
  total_duration_seconds: number;
  /** SHA-256 over the ledger's input identity (not the file bytes). */
  fingerprint: string;
  /** SHA-256 over the ready assets' measured bytes. */
  asset_set_hash: string;
  warnings: string[];
}

export interface NarrationLedgerChange {
  scene_number: number;
  asset: string;
  from: NarrationAssetState | null;
  to: NarrationAssetState;
  sha256_changed: boolean;
  input_key_changed: boolean;
}

export interface NarrationDependentClaim {
  /** `long-form:audio_mix` / `long-form:media_qa` / `shorts:<shortId>`. */
  dependent: string;
  scene_number: number;
  /** SHA-256 the dependent was actually built from (null when it did not record one). */
  sha256: string | null;
}

/** `<outputsRoot>/<projectId>/narration` — the ONLY directory this layer may write. */
export function narrationRoot(outputsRoot: string, projectId: string): string {
  return path.join(outputsRoot, projectId, 'narration');
}

export function narrationLedgerPath(outputsRoot: string, projectId: string): string {
  return path.join(narrationRoot(outputsRoot, projectId), NARRATION_LEDGER_FILE);
}

export function narrationQaPath(outputsRoot: string, projectId: string): string {
  return path.join(narrationRoot(outputsRoot, projectId), NARRATION_QA_FILE);
}

export function narrationApprovalPath(outputsRoot: string, projectId: string): string {
  return path.join(narrationRoot(outputsRoot, projectId), NARRATION_APPROVAL_FILE);
}

/** Reject any write that escapes the narration root (defence in depth, mirrors the Shorts guard). */
export function assertInsideNarrationRoot(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`refusing to write outside the narration root: ${target}`);
  }
}

const sha256 = (text: string): string => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const sha256Bytes = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');

export function narrationInputKey(input: { text_hash: string; voice_hash: string; config_hash: string }): string {
  return sha256(`narration|v1|${input.text_hash}|${input.voice_hash}|${input.config_hash}`);
}

export function voiceConfigHash(voice: NarrationVoiceConfig): string {
  return sha256(stableStringify({
    provider: voice.provider,
    model: voice.model,
    voice: voice.voice,
    language: voice.language,
    narrator_style: voice.narrator_style,
  }));
}

/**
 * Normalize a spoken-text replacement. Pure and deterministic: rules are applied longest-first so
 * a shorter rule can never corrupt a longer one, and the result is whitespace-stable.
 */
export function applyPronunciationRules(text: string, rules: PronunciationRule[]): string {
  const raw = String(text ?? '');
  if (!raw) return '';
  const ordered = [...rules]
    .filter((rule) => rule && typeof rule.match === 'string' && rule.match.length > 0)
    .sort((a, b) => b.match.length - a.match.length || a.match.localeCompare(b.match));
  let out = raw;
  for (const rule of ordered) {
    out = out.split(rule.match).join(rule.say ?? '');
  }
  return out.replace(/[ \t]+/g, ' ').trim();
}

/** Load the optional pronunciation sidecar (read-only) or fall back to the deterministic defaults. */
export async function loadPronunciationConfig(options: {
  inputRoot: string;
  voice?: Partial<NarrationVoiceConfig>;
  pronunciationPath?: string | null;
}): Promise<{ config: PronunciationConfig; source: string | null; warnings: string[] }> {
  const warnings: string[] = [];
  const voice: NarrationVoiceConfig = { ...DEFAULT_NARRATION_VOICE, ...(options.voice ?? {}) };
  const file = options.pronunciationPath
    ? path.resolve(options.pronunciationPath)
    : path.join(path.resolve(options.inputRoot), 'narration', PRONUNCIATION_FILE);

  let rules: PronunciationRule[] = [];
  let source: string | null = null;
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
      source = file;
      const rawRules = Array.isArray(parsed?.rules) ? parsed.rules : [];
      rules = rawRules
        .filter((rule: any) => rule && typeof rule.match === 'string' && rule.match.trim().length > 0)
        .map((rule: any) => ({
          match: String(rule.match),
          say: typeof rule.say === 'string' ? rule.say : '',
          ...(typeof rule.note === 'string' ? { note: rule.note } : {}),
        }));
      if (parsed?.voice && typeof parsed.voice === 'object') {
        for (const key of ['provider', 'model', 'voice', 'language', 'narrator_style'] as const) {
          const value = (parsed.voice as any)[key];
          if (typeof value === 'string' && value.trim()) (voice as any)[key] = value.trim();
        }
      }
      if (!Array.isArray(parsed?.rules)) warnings.push('pronunciation.json has no rules array; using the voice config only');
    } catch {
      warnings.push(`pronunciation.json could not be parsed (${path.basename(file)}); the defaults are used and the file is NOT rewritten`);
    }
  }

  const config: PronunciationConfig = {
    schema_version: 1,
    voice,
    rules,
    config_hash: sha256(stableStringify({ voice, rules })),
  };
  return { config, source, warnings };
}

/** Build the per-scene narration text plan straight from the pipeline (narrator vs dialogue). */
export function narrationTextPlans(pipeline: any, config: PronunciationConfig): NarrationTextPlan[] {
  const scenes = Array.isArray(pipeline?.scenes) ? pipeline.scenes : [];
  const voiceHash = voiceConfigHash(config.voice);
  return scenes
    .filter((scene: any) => Number.isInteger(Number(scene?.scene_number)))
    .map((scene: any): NarrationTextPlan => {
      const sceneNumber = Number(scene.scene_number);
      const required = isNarrationScene(pipeline, sceneNumber);
      const raw = typeof scene?.narration_text === 'string' ? scene.narration_text.trim() : '';
      const spoken = applyPronunciationRules(raw, config.rules);
      const kind: 'narration' | 'dialogue' = required ? 'narration' : 'dialogue';
      return {
        scene_number: sceneNumber,
        kind,
        required,
        raw_text: raw,
        spoken_text: spoken,
        text_hash: sha256(stableStringify({ scene: sceneNumber, kind, raw, spoken, voice: voiceHash, config: config.config_hash })),
        title: typeof scene?.title === 'string' ? scene.title : null,
      };
    })
    .sort((a: NarrationTextPlan, b: NarrationTextPlan) => a.scene_number - b.scene_number);
}

function classifyFile(probe: any, bytes: number | null, sha256Hex: string | null): { state: NarrationAssetState; reason: string } {
  if (bytes === null) return { state: 'missing', reason: 'the narration file is absent' };
  if (bytes === 0) return { state: 'empty', reason: 'the narration file is zero bytes' };
  if (!probe?.readable) return { state: 'corrupt', reason: probe?.reason ?? 'ffprobe could not read the narration file' };
  if (sha256Hex === null) return { state: 'corrupt', reason: 'the narration file could not be hashed' };
  const audio = probe.audio;
  if (!audio) return { state: 'format_invalid', reason: 'the file carries no audio stream' };
  if (probe.problems?.includes('missing_audio_codec')) return { state: 'format_invalid', reason: 'the audio stream has no codec' };
  if (!ACCEPTED_AUDIO_CODECS.includes(String(audio.codec) as any)) {
    return { state: 'format_invalid', reason: `audio codec ${String(audio.codec)} is outside the narration contract` };
  }
  if (!ACCEPTED_SAMPLE_RATES.includes(Number(audio.sampleRate) as any)) {
    return { state: 'format_invalid', reason: `sample rate ${String(audio.sampleRate)} is outside the narration contract` };
  }
  const channels = Number(audio.channels);
  if (!Number.isInteger(channels) || channels < 1 || channels > MAX_NARRATION_CHANNELS) {
    return { state: 'format_invalid', reason: `channel count ${String(audio.channels)} is outside the narration contract (1–2)` };
  }
  const duration = Number(probe.formatDurationSeconds ?? audio.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return { state: 'corrupt', reason: 'the audio duration is unreadable' };
  if (duration < MIN_NARRATION_SECONDS) return { state: 'format_invalid', reason: `duration ${duration.toFixed(2)}s is below the ${MIN_NARRATION_SECONDS}s minimum` };
  if (duration > MAX_SCENE_AUDIO_SECONDS) return { state: 'format_invalid', reason: `duration ${duration.toFixed(1)}s exceeds the ${MAX_SCENE_AUDIO_SECONDS}s scene ceiling` };
  return { state: 'ready', reason: 'valid Hindi narration audio' };
}

async function readPreviousLedger(file: string): Promise<NarrationLedger | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed as NarrationLedger : null;
  } catch {
    return null;
  }
}

export interface BuildNarrationLedgerOptions {
  projectId: string;
  pipeline: any;
  inputRoot: string;
  outputsRoot?: string;
  pronunciation?: PronunciationConfig | null;
  pronunciationPath?: string | null;
  voice?: Partial<NarrationVoiceConfig>;
  /** Test seam: replace the ffprobe-backed probe. */
  probe?: (file: string) => Promise<any>;
  now?: string;
}

/** Build (never write) the deterministic narration ledger for one project. */
export async function buildNarrationLedger(options: BuildNarrationLedgerOptions): Promise<{
  ledger: NarrationLedger;
  changes: NarrationLedgerChange[];
  pronunciationSource: string | null;
}> {
  const projectId = String(options.projectId ?? '').trim();
  if (!projectId) throw new Error('buildNarrationLedger requires a project id.');
  const inputRoot = path.resolve(options.inputRoot);
  const narrationDir = path.join(inputRoot, 'narration');
  const generatedAt = options.now ?? new Date().toISOString();

  let config: PronunciationConfig;
  let pronunciationSource: string | null = null;
  const warningList: string[] = [];
  if (options.pronunciation) {
    config = options.pronunciation;
  } else {
    const loaded = await loadPronunciationConfig({ inputRoot, voice: options.voice, pronunciationPath: options.pronunciationPath });
    config = loaded.config;
    pronunciationSource = loaded.source;
    warningList.push(...loaded.warnings);
  }

  const voiceHash = voiceConfigHash(config.voice);
  const plans = narrationTextPlans(options.pipeline, config);
  const requiredPlans = plans.filter((plan) => plan.required);

  let fileNames: string[] = [];
  try {
    fileNames = await fsp.readdir(narrationDir);
  } catch {
    if (requiredPlans.length > 0) warningList.push(`the narration directory is absent (${path.basename(narrationDir)})`);
  }
  const mapped = mapNarrationFiles(fileNames);
  for (const [scene, candidates] of mapped.ambiguous) {
    warningList.push(`scene ${scene} has ${candidates.length} narration files (${candidates.join(', ')}); the scene is treated as ambiguous and refused`);
  }

  const previous = options.outputsRoot
    ? await readPreviousLedger(narrationLedgerPath(options.outputsRoot, projectId))
    : null;
  const previousByScene = new Map<number, NarrationAssetRecord>(
    (previous?.assets ?? []).map((asset) => [asset.scene_number, asset]),
  );

  const probe = options.probe ?? ((file: string) => probeMedia(file, {}));
  const assets: NarrationAssetRecord[] = [];

  for (const plan of requiredPlans) {
    const name = mapped.byScene.get(plan.scene_number) ?? null;
    const assetName = `narration-${String(plan.scene_number).padStart(4, '0')}`;
    const absolute = name ? path.join(narrationDir, name) : path.join(narrationDir, narrationFilename(plan.scene_number));
    const previousRecord = previousByScene.get(plan.scene_number) ?? null;
    const inputKey = narrationInputKey({ text_hash: plan.text_hash, voice_hash: voiceHash, config_hash: config.config_hash });

    let bytes: number | null = null;
    let sha256Hex: string | null = null;
    let probed: any = null;
    if (name) {
      try {
        const stat = await fsp.stat(absolute);
        bytes = stat.isFile() ? stat.size : 0;
      } catch {
        bytes = null;
      }
      if (bytes !== null && bytes > 0) {
        sha256Hex = await computeFileSha256(absolute).catch(() => null);
        probed = await probe(absolute).catch((error: any) => ({ readable: false, reason: String(error?.message ?? error) }));
      } else if (bytes === 0) {
        probed = { readable: false, reason: 'the narration file is zero bytes' };
      }
    }

    const classified = classifyFile(probed, bytes, sha256Hex);
    let state = classified.state;
    let reason = classified.reason;
    // Provenance is sticky for unchanged bytes: it records the intent those bytes were produced for.
    const keptProvenance: NarrationProvenance | null = previousRecord && previousRecord.sha256 === sha256Hex
      ? {
        ...previousRecord.provenance,
        produced_for_input_key: previousRecord.provenance?.produced_for_input_key ?? previousRecord.input_key,
      }
      : null;
    const producedFor = keptProvenance?.produced_for_input_key ?? inputKey;
    // A valid file produced for an older script/voice/pronunciation config no longer SAYS the current
    // line: the bytes are fine, but that one asset must be re-recorded.
    if (state === 'ready' && keptProvenance && producedFor !== inputKey) {
      state = 'stale';
      reason = 'the narration bytes predate a script/voice/pronunciation change (re-record this line)';
    }
    if (previousRecord && previousRecord.sha256 !== sha256Hex && sha256Hex) {
      reason = `${reason}; the bytes changed since the last ledger pass`;
    }

    assets.push({
      scene_number: plan.scene_number,
      asset: assetName,
      relative_path: name ? `narration/${name}` : `narration/${path.basename(absolute)}`,
      sha256: sha256Hex,
      bytes,
      duration_seconds: probed?.formatDurationSeconds ?? probed?.audio?.durationSeconds ?? null,
      container: probed?.formatName ?? null,
      codec: probed?.audio?.codec ?? null,
      sample_rate: probed?.audio?.sampleRate ?? null,
      channels: probed?.audio?.channels ?? null,
      text_hash: plan.text_hash,
      voice_hash: voiceHash,
      config_hash: config.config_hash,
      input_key: inputKey,
      state,
      reason,
      content_changed: Boolean(previousRecord && previousRecord.sha256 !== sha256Hex),
      provenance: keptProvenance ?? { source: 'provided_file', provider: null, recorded_at: generatedAt, produced_for_input_key: inputKey },
    });
  }

  const missing = assets.filter((asset) => asset.state === 'missing').map((asset) => asset.scene_number);
  const stale = assets.filter((asset) => asset.state === 'stale').map((asset) => asset.scene_number);
  const invalid = assets.filter((asset) => ['empty', 'corrupt', 'format_invalid'].includes(asset.state)).map((asset) => asset.scene_number);
  const totalDuration = assets
    .filter((asset) => asset.state === 'ready' || asset.state === 'stale')
    .reduce((sum, asset) => sum + (Number(asset.duration_seconds) || 0), 0);

  const fingerprint = sha256(stableStringify({
    project_id: projectId,
    voice: config.voice,
    config_hash: config.config_hash,
    scenes: plans.map((plan) => [plan.scene_number, plan.kind, plan.text_hash, plan.required]),
    assets: assets.map((asset) => [asset.scene_number, asset.input_key]),
  }));
  const assetSetHash = sha256(stableStringify(
    assets
      .filter((asset) => asset.sha256)
      .map((asset) => [asset.scene_number, asset.sha256])
      .sort((a, b) => Number(a[0]) - Number(b[0])),
  ));

  const ledger: NarrationLedger = {
    schema_version: NARRATION_LEDGER_VERSION,
    project_id: projectId,
    generated_at: generatedAt,
    read_only: true,
    input_root: inputRoot,
    voice: config.voice,
    pronunciation: config,
    scene_texts: plans,
    assets,
    missing_scenes: missing,
    stale_scenes: stale,
    invalid_scenes: invalid,
    total_duration_seconds: Number(totalDuration.toFixed(3)),
    fingerprint,
    asset_set_hash: assetSetHash,
    warnings: warningList,
  };

  const changes: NarrationLedgerChange[] = assets
    .filter((asset) => {
      const before = previousByScene.get(asset.scene_number) ?? null;
      if (!before) return true;
      return before.state !== asset.state || before.sha256 !== asset.sha256 || before.input_key !== asset.input_key;
    })
    .map((asset) => {
      const before = previousByScene.get(asset.scene_number) ?? null;
      return {
        scene_number: asset.scene_number,
        asset: asset.asset,
        from: before?.state ?? null,
        to: asset.state,
        sha256_changed: before?.sha256 !== asset.sha256,
        input_key_changed: before ? before.input_key !== asset.input_key : true,
      };
    });

  return { ledger, changes, pronunciationSource };
}

/** Persist a ledger atomically (temp sibling + rename). Returns true when the file content changed. */
export async function writeNarrationLedger(outputsRoot: string, projectId: string, ledger: NarrationLedger): Promise<boolean> {
  const root = narrationRoot(outputsRoot, projectId);
  const target = narrationLedgerPath(outputsRoot, projectId);
  assertInsideNarrationRoot(root, target);
  await fsp.mkdir(root, { recursive: true });

  const text = `${JSON.stringify(ledger, null, 2)}\n`;
  try {
    const existing = await fsp.readFile(target, 'utf8');
    if (existing === text) return false;
  } catch {
    // absent: write it
  }
  const temp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await fsp.writeFile(temp, text, 'utf8');
  await fsp.rename(temp, target);
  return true;
}

/** Read the persisted ledger (null when absent or unreadable). */
export async function loadNarrationLedger(outputsRoot: string, projectId: string): Promise<NarrationLedger | null> {
  return readPreviousLedger(narrationLedgerPath(outputsRoot, projectId));
}

/**
 * Dependents that were built from specific narration bytes.
 *
 * Long-form MIX/QA consume every narrator asset by contract, so those claims are always declared.
 * A Short only claims the narration of the scenes it actually reframes; its checkpoint records the
 * exact hashes it was rendered from, so a re-recorded line invalidates that Short and no other.
 */
export async function narrationDependentClaims(options: {
  outputsRoot: string;
  projectId: string;
  ledger: NarrationLedger;
  /**
   * The ledger pass BEFORE this one, when available.
   *
   * A long-form MIX/QA run consumes whatever narration bytes were recorded at the time it ran, so its
   * claim is the PREVIOUS ledger's hash (null when the line did not exist yet). Without it the claim
   * would trivially equal the current bytes and a re-recorded line could never invalidate anything.
   */
  previous?: NarrationLedger | null;
}): Promise<NarrationDependentClaim[]> {
  const claims: NarrationDependentClaim[] = [];
  const previousByScene = new Map<number, NarrationAssetRecord>(
    (options.previous?.assets ?? []).map((asset) => [asset.scene_number, asset]),
  );
  for (const asset of options.ledger.assets) {
    const consumed = options.previous
      ? previousByScene.get(asset.scene_number)?.sha256 ?? null
      : asset.sha256;
    claims.push({ dependent: 'long-form:audio_mix', scene_number: asset.scene_number, sha256: consumed });
    claims.push({ dependent: 'long-form:media_qa', scene_number: asset.scene_number, sha256: consumed });
  }

  const shortsRoot = path.join(options.outputsRoot, options.projectId, 'shorts');
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(shortsRoot, { withFileTypes: true })
      .then((rows) => rows.filter((row) => row.isDirectory()).map((row) => row.name));
  } catch {
    return claims;
  }

  for (const shortId of entries.sort()) {
    const checkpointFile = path.join(shortsRoot, shortId, 'short.json');
    let checkpoint: any = null;
    try {
      checkpoint = JSON.parse(await fsp.readFile(checkpointFile, 'utf8'));
    } catch {
      continue;
    }
    const narrationHashes: Record<string, string> = checkpoint?.narration_hashes ?? {};
    for (const [scene, hash] of Object.entries(narrationHashes)) {
      claims.push({ dependent: `shorts:${shortId}`, scene_number: Number(scene), sha256: String(hash) });
    }
  }
  return claims;
}

export interface NarrationInvalidation {
  /** Assets whose recorded bytes differ from what a dependent was built from. */
  changed_scenes: number[];
  /** dependents that must be re-run, mapped to the scenes that invalidated them. */
  stale_dependents: Record<string, number[]>;
  long_form_affected: boolean;
  shorts_affected: string[];
}

/**
 * Compute targeted invalidation: exactly the dependents whose recorded bytes no longer match.
 *
 * `previous` (optional) is the ledger pass the dependents were built from. It lets a newly recorded
 * line (previously missing/empty) and a script/voice change invalidate the long-form dependents even
 * though the claim carries no hash for that scene.
 */
export function computeNarrationInvalidation(
  ledger: NarrationLedger,
  claims: NarrationDependentClaim[],
  options: { previous?: NarrationLedger | null } = {},
): NarrationInvalidation {
  const byScene = new Map<number, NarrationAssetRecord>(
    ledger.assets.map((asset) => [asset.scene_number, asset]),
  );
  const previousByScene = new Map<number, NarrationAssetRecord>(
    (options.previous?.assets ?? []).map((asset) => [asset.scene_number, asset]),
  );
  const stale: Record<string, Set<number>> = {};
  const changed = new Set<number>();

  for (const asset of ledger.assets) {
    const before = previousByScene.get(asset.scene_number);
    if (!before) continue;
    if (before.sha256 !== asset.sha256 || before.input_key !== asset.input_key) changed.add(asset.scene_number);
  }

  for (const claim of claims) {
    const asset = byScene.get(claim.scene_number);
    if (!asset) continue;
    const mismatch = claim.sha256 ? asset.sha256 !== claim.sha256 : changed.has(claim.scene_number);
    if (mismatch) {
      changed.add(claim.scene_number);
      const set = stale[claim.dependent] ?? new Set<number>();
      set.add(claim.scene_number);
      stale[claim.dependent] = set;
    }
  }

  const staleDependents: Record<string, number[]> = {};
  for (const [dependent, scenes] of Object.entries(stale)) {
    staleDependents[dependent] = [...scenes].sort((a, b) => a - b);
  }
  const shortsAffected = Object.keys(staleDependents)
    .filter((dependent) => dependent.startsWith('shorts:'))
    .map((dependent) => dependent.slice('shorts:'.length))
    .sort();

  return {
    changed_scenes: [...changed].sort((a, b) => a - b),
    stale_dependents: staleDependents,
    long_form_affected: Object.keys(staleDependents).some((dependent) => dependent.startsWith('long-form:')),
    shorts_affected: shortsAffected,
  };
}

/** Byte-stable hash of a narration audio file (null when unreadable). */
export async function narrationFileHash(file: string): Promise<string | null> {
  try {
    return sha256Bytes(await fsp.readFile(file));
  } catch {
    return null;
  }
}

/** True when every required scene has a READY (non-stale, non-invalid) asset. */
export function narrationIsComplete(ledger: NarrationLedger): boolean {
  const required = ledger.scene_texts.filter((plan) => plan.required).map((plan) => plan.scene_number);
  const ready = new Set(ledger.assets.filter((asset) => asset.state === 'ready').map((asset) => asset.scene_number));
  return required.every((scene) => ready.has(scene));
}

export { SUPPORTED_AUDIO_EXTENSIONS };
