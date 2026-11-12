/**
 * PHASE 7 — narration quality gate.
 *
 * A THIN contract layer over the Phase 4 media engine, exactly like the Phase 6 Shorts QA:
 *
 *   · measurement (bytes, duration, sample rate, channels, loudness, silence, clipping) comes from
 *     the existing `mediaQa.runMediaQa` with `kind: 'audio'` — there is no second analyzer here;
 *   · this module adds only the narration-specific CONTRACT checks: file integrity, hashed
 *     provenance, format acceptance, measured-duration agreement, nothing-silent, and staleness
 *     against the ledger's `input_key`.
 *
 * QA is read-only. It never regenerates audio, never approves and never publishes.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { runMediaQa, type MediaQaOptions, type MediaQaReport } from './mediaQa.js';
import { probeMedia, computeFileSha256 } from './videoClip.js';
import { stableStringify } from './projectMediaQa.js';
import {
  ACCEPTED_AUDIO_CODECS,
  ACCEPTED_SAMPLE_RATES,
  MAX_NARRATION_CHANNELS,
  MIN_NARRATION_SECONDS,
  type NarrationAssetRecord,
  type NarrationLedger,
} from './narrationAssets.js';

export const NARRATION_QA_VERSION = 1;

/** Duration agreement between the ledger record and the bytes on disk right now. */
export const NARRATION_DURATION_MATCH_SECONDS = 0.05;

/** Silence above this fraction of the line is suspicious for a spoken narrator line. */
export const NARRATION_MAX_SILENT_FRACTION = 0.5;

/** Trailing silence longer than this is unused padding (the MIX chain adds its own tail). */
export const NARRATION_MAX_TRAILING_SILENCE_SECONDS = 1.5;

export type NarrationQaStatus = 'PASS' | 'WARNING' | 'FAIL' | 'SKIPPED';

export interface NarrationQaCheck {
  id: string;
  asset: string;
  status: 'PASS' | 'WARNING' | 'FAIL' | 'SKIPPED';
  severity: 'BLOCKER' | 'WARNING' | 'INFO' | 'SKIPPED';
  expected: unknown;
  actual: unknown;
  explanation: string;
}

export interface NarrationAssetQa {
  scene_number: number;
  asset: string;
  relative_path: string;
  sha256: string | null;
  duration_seconds: number | null;
  loudness_lufs: number | null;
  silent_seconds: number | null;
  status: NarrationQaStatus;
  checks: NarrationQaCheck[];
}

export interface NarrationQaReport {
  version: number;
  project_id: string;
  generated_at: string;
  read_only: true;
  status: NarrationQaStatus;
  ok: boolean;
  /** Ledger identity the evidence was produced against. */
  ledger_fingerprint: string;
  voice: { provider: string; model: string; voice: string; language: string };
  pronunciation_hash: string;
  /** SHA-256 over the exact audio bytes evaluated (the approval boundary). */
  artifact_hash: string | null;
  /** SHA-256 of this report (excluding this field). */
  report_hash: string;
  assets: NarrationAssetQa[];
  /** Project-level checks (completeness, distinct bytes, provenance) — kept so evidence is inspectable. */
  set_checks: NarrationQaCheck[];
  counts: { total: number; pass: number; warning: number; fail: number; skipped: number; blockers: number };
  /** Always false: narration audio is never publishable on its own. */
  publishable: false;
  approval_required: true;
}

export type MediaQaRunner = (options: MediaQaOptions) => Promise<MediaQaReport>;

export interface NarrationQaOptions {
  ledger: NarrationLedger;
  inputRoot: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  now?: string;
  /** Test seam: replace the Phase 4 engine. */
  runMediaQa?: MediaQaRunner;
  probe?: (file: string) => Promise<any>;
}

const sha256 = (text: string): string => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function check(
  id: string,
  asset: string,
  status: NarrationQaCheck['status'],
  expected: unknown,
  actual: unknown,
  explanation: string,
): NarrationQaCheck {
  const severity: NarrationQaCheck['severity'] = status === 'FAIL' ? 'BLOCKER' : status === 'WARNING' ? 'WARNING' : status === 'SKIPPED' ? 'SKIPPED' : 'INFO';
  return { id, asset, status, severity, expected, actual, explanation };
}

function summarize(checks: NarrationQaCheck[]): NarrationQaStatus {
  if (checks.some((entry) => entry.status === 'FAIL')) return 'FAIL';
  if (checks.some((entry) => entry.status === 'WARNING')) return 'WARNING';
  if (checks.length > 0 && checks.every((entry) => entry.status === 'SKIPPED')) return 'SKIPPED';
  return 'PASS';
}

function assetPath(inputRoot: string, asset: NarrationAssetRecord): string {
  return path.join(inputRoot, ...asset.relative_path.split('/'));
}

/** Run the complete narration QA for one project. Read-only. */
export async function runNarrationQa(options: NarrationQaOptions): Promise<NarrationQaReport> {
  const ledger = options.ledger;
  const inputRoot = options.inputRoot;
  const runner = options.runMediaQa ?? runMediaQa;
  const probe = options.probe ?? ((file: string) => probeMedia(file, { ffprobePath: options.ffprobePath }));
  const generatedAt = options.now ?? new Date().toISOString();

  const assetReports: NarrationAssetQa[] = [];
  const hashes: Array<[number, string]> = [];

  for (const asset of ledger.assets) {
    const checks: NarrationQaCheck[] = [];
    const file = assetPath(inputRoot, asset);
    const label = asset.asset;

    // ---- integrity + hashed provenance ----
    let bytes: number | null = null;
    try {
      const stat = await fsp.stat(file);
      bytes = stat.isFile() ? stat.size : null;
    } catch {
      bytes = null;
    }
    const actualSha = bytes && bytes > 0 ? await computeFileSha256(file).catch(() => null) : null;

    if (bytes === null) {
      checks.push(check('narration.present', label, 'FAIL', 'file present', 'absent', 'The narration file required by the pipeline is missing.'));
    } else if (bytes === 0) {
      checks.push(check('narration.integrity', label, 'FAIL', '> 0 bytes', 0, 'The narration file is zero bytes; it cannot carry speech.'));
    } else {
      checks.push(check('narration.integrity', label, 'PASS', '> 0 bytes', bytes, 'The narration file exists and is non-empty.'));
    }

    if (actualSha) {
      const matches = actualSha === asset.sha256;
      checks.push(check(
        'narration.hash', label, matches ? 'PASS' : 'FAIL',
        asset.sha256 ?? 'recorded ledger hash', actualSha,
        matches
          ? 'The bytes match the recorded ledger hash.'
          : 'The bytes differ from the ledger hash; the ledger is stale and must be refreshed before approval.',
      ));
      hashes.push([asset.scene_number, actualSha]);
    }

    // ---- state / staleness ----
    const stateOk = asset.state === 'ready';
    checks.push(check(
      'narration.state', label, stateOk ? 'PASS' : 'FAIL',
      'ready', asset.state,
      stateOk ? 'The asset is current for the recorded script, voice and pronunciation config.' : asset.reason,
    ));

    // ---- measured duration agreement ----
    if (actualSha) {
      const probed = await probe(file).catch((error: any) => ({ readable: false, reason: String(error?.message ?? error) }));
      const measured = Number(probed?.formatDurationSeconds ?? probed?.audio?.durationSeconds);
      const recorded = Number(asset.duration_seconds);
      if (!probed?.readable) {
        checks.push(check('narration.probe', label, 'FAIL', 'readable audio', probed?.reason ?? 'unreadable', 'ffprobe could not read the narration file.'));
      } else if (!Number.isFinite(measured) || measured <= 0) {
        checks.push(check('narration.duration', label, 'FAIL', 'positive measured duration', measured, 'The audio duration could not be measured.'));
      } else {
        const agrees = Number.isFinite(recorded) && Math.abs(measured - recorded) <= NARRATION_DURATION_MATCH_SECONDS;
        checks.push(check(
          'narration.duration', label, agrees ? 'PASS' : 'FAIL',
          `${recorded}s ± ${NARRATION_DURATION_MATCH_SECONDS}s`, measured,
          agrees
            ? 'Measured duration agrees with the ledger; downstream timing uses this measured value.'
            : 'Measured duration disagrees with the ledger; regenerate the ledger before mixing.',
        ));
        checks.push(check(
          'narration.duration.bounds', label,
          measured >= MIN_NARRATION_SECONDS ? 'PASS' : 'FAIL',
          `>= ${MIN_NARRATION_SECONDS}s`, measured,
          measured >= MIN_NARRATION_SECONDS ? 'The line is long enough to be real speech.' : 'The line is implausibly short.',
        ));
      }

      // ---- audio format contract (from the ledger's probe record, re-verified live) ----
      const codec = probed?.audio?.codec ?? asset.codec;
      const sampleRate = probed?.audio?.sampleRate ?? asset.sample_rate;
      const channels = probed?.audio?.channels ?? asset.channels;
      const formatOk = ACCEPTED_AUDIO_CODECS.includes(String(codec) as any)
        && ACCEPTED_SAMPLE_RATES.includes(Number(sampleRate) as any)
        && Number(channels) >= 1 && Number(channels) <= MAX_NARRATION_CHANNELS;
      checks.push(check(
        'narration.format', label, formatOk ? 'PASS' : 'FAIL',
        { codecs: ACCEPTED_AUDIO_CODECS, sample_rates: ACCEPTED_SAMPLE_RATES, channels: `1–${MAX_NARRATION_CHANNELS}` },
        { codec: codec ?? null, sample_rate: sampleRate ?? null, channels: channels ?? null },
        formatOk
          ? 'Container codec, sample rate and channel count satisfy the narration contract.'
          : 'The audio format is outside the narration contract.',
      ));

      // ---- Phase 4 engine: loudness, clipping, silence ----
      let media: MediaQaReport | null = null;
      try {
        media = await runner({
          input: file,
          kind: 'audio',
          ffmpegPath: options.ffmpegPath,
          ffprobePath: options.ffprobePath,
          requireAudio: true,
          requireVideo: false,
          skipBlack: true,
          skipFreeze: true,
          minBytes: 1000,
          // Raw narrator lines are pre-normalisation; the MIX chain is what targets −14 LUFS.
          targetLufs: -14,
          loudnessToleranceLu: 8,
        });
      } catch (error: any) {
        checks.push(check('narration.media_qa', label, 'FAIL', 'media QA ran', String(error?.message ?? error).slice(0, 200), 'The Phase 4 media engine failed to run.'));
      }

      let loudness: number | null = null;
      let silentSeconds: number | null = null;
      if (media) {
        loudness = media.loudness?.integratedLufs ?? null;
        silentSeconds = media.silence ? Number(media.silence.totalSeconds.toFixed(3)) : null;
        // Delegate: the engine's FAILs stay FAILs, its WARNs stay WARNs (no re-implementation).
        for (const engineCheck of media.checks) {
          if (engineCheck.status === 'SKIPPED') continue;
          checks.push(check(
            `narration.media.${engineCheck.id}`,
            label,
            engineCheck.status === 'WARNING' ? 'WARNING' : engineCheck.status,
            engineCheck.expected ?? null,
            engineCheck.actual ?? null,
            engineCheck.explanation ?? String(engineCheck.id),
          ));
        }

        const span = Number(media.durationSeconds ?? measured);
        if (Number.isFinite(span) && span > 0 && silentSeconds !== null) {
          const silentFraction = silentSeconds / span;
          const fullySilent = silentFraction >= 0.98;
          checks.push(check(
            'narration.silence.whole', label, fullySilent ? 'FAIL' : 'PASS',
            'audible speech', `${Math.round(silentFraction * 100)}% silent`,
            fullySilent ? 'The line is silent for its whole duration; it would leave a dead gap in the mix.' : 'The line carries audible speech.',
          ));
          if (!fullySilent) {
            const mostlySilent = silentFraction > NARRATION_MAX_SILENT_FRACTION && span > 3;
            checks.push(check(
              'narration.silence.share', label, mostlySilent ? 'WARNING' : 'PASS',
              `<= ${Math.round(NARRATION_MAX_SILENT_FRACTION * 100)}% silent`, `${Math.round(silentFraction * 100)}% silent`,
              mostlySilent ? 'More than half of the line is silence; confirm the delivery is intentional.' : 'Silence share is normal for a spoken line.',
            ));
          }
          const segments = media.silence?.segments ?? [];
          const trailing = segments.length && Number(span) > 0
            ? Number((span - Number(segments[segments.length - 1].start)).toFixed(3))
            : 0;
          if (trailing > NARRATION_MAX_TRAILING_SILENCE_SECONDS) {
            checks.push(check(
              'narration.silence.trailing', label, 'WARNING',
              `<= ${NARRATION_MAX_TRAILING_SILENCE_SECONDS}s trailing silence`, `${trailing}s`,
              'The line ends with a long silence; the MIX trim will remove it, confirm nothing is cut.',
            ));
          }
        }
      }

      assetReports.push({
        scene_number: asset.scene_number,
        asset: label,
        relative_path: asset.relative_path,
        sha256: actualSha,
        duration_seconds: Number.isFinite(Number(asset.duration_seconds)) ? Number(asset.duration_seconds) : null,
        loudness_lufs: loudness,
        silent_seconds: silentSeconds,
        status: summarize(checks),
        checks,
      });
      continue;
    }

    assetReports.push({
      scene_number: asset.scene_number,
      asset: label,
      relative_path: asset.relative_path,
      sha256: null,
      duration_seconds: Number.isFinite(Number(asset.duration_seconds)) ? Number(asset.duration_seconds) : null,
      loudness_lufs: null,
      silent_seconds: null,
      status: summarize(checks),
      checks,
    });
  }

  // ---- set-level checks ----
  const setChecks: NarrationQaCheck[] = [];
  const required = ledger.scene_texts.filter((plan) => plan.required).map((plan) => plan.scene_number);
  const readyScenes = new Set(assetReports.filter((report) => report.status === 'PASS' || report.status === 'WARNING').map((report) => report.scene_number));
  const missingRequired = required.filter((scene) => !readyScenes.has(scene));
  setChecks.push(check(
    'narration.set.complete', 'project',
    required.length === 0 ? 'SKIPPED' : missingRequired.length === 0 ? 'PASS' : 'FAIL',
    'every narrator scene has passing audio',
    missingRequired.length === 0 ? 'complete' : `missing/unusable: ${missingRequired.join(', ')}`,
    required.length === 0
      ? 'The pipeline declares no narrator scenes.'
      : missingRequired.length === 0
        ? `${required.length} narrator scene(s) have usable audio.`
        : 'Narrator scenes without usable audio would render silent.',
  ));

  const byHash = new Map<string, number[]>();
  for (const report of assetReports) {
    if (!report.sha256) continue;
    const list = byHash.get(report.sha256) ?? [];
    list.push(report.scene_number);
    byHash.set(report.sha256, list);
  }
  const duplicates = [...byHash.entries()].filter(([, scenes]) => scenes.length > 1);
  setChecks.push(check(
    'narration.set.distinct', 'project',
    duplicates.length === 0 ? 'PASS' : 'WARNING',
    'distinct audio per scene',
    duplicates.map(([hash, scenes]) => ({ hash: hash.slice(0, 12), scenes })),
    duplicates.length === 0
      ? 'Every narrator line has distinct bytes.'
      : 'Two scenes share identical narration bytes; confirm that is intentional.',
  ));

  const provenanceOk = ledger.assets.every((asset) => Boolean(asset.provenance?.recorded_at));
  setChecks.push(check(
    'narration.set.provenance', 'project', provenanceOk ? 'PASS' : 'FAIL',
    'every asset records provenance', provenanceOk ? 'recorded' : 'missing',
    provenanceOk ? 'Every asset records where it came from and when.' : 'An asset has no provenance record.',
  ));

  const allChecks = [...setChecks, ...assetReports.flatMap((report) => report.checks)];
  const status = summarize(allChecks);
  const artifactHash = hashes.length > 0
    ? sha256(stableStringify(hashes.map(([scene, hash]) => [scene, hash]).sort((a, b) => Number(a[0]) - Number(b[0]))))
    : null;

  const report: NarrationQaReport = {
    version: NARRATION_QA_VERSION,
    project_id: ledger.project_id,
    generated_at: generatedAt,
    read_only: true,
    status,
    ok: status === 'PASS' || status === 'WARNING',
    ledger_fingerprint: ledger.fingerprint,
    voice: {
      provider: ledger.voice.provider,
      model: ledger.voice.model,
      voice: ledger.voice.voice,
      language: ledger.voice.language,
    },
    pronunciation_hash: ledger.pronunciation.config_hash,
    artifact_hash: artifactHash,
    report_hash: '',
    assets: assetReports,
    set_checks: setChecks,
    counts: {
      total: assetReports.length,
      pass: assetReports.filter((report) => report.status === 'PASS').length,
      warning: assetReports.filter((report) => report.status === 'WARNING').length,
      fail: assetReports.filter((report) => report.status === 'FAIL').length,
      skipped: assetReports.filter((report) => report.status === 'SKIPPED').length,
      blockers: allChecks.filter((entry) => entry.status === 'FAIL').length,
    },
    publishable: false,
    approval_required: true,
  };
  report.report_hash = sha256(stableStringify({ ...report, report_hash: undefined }));
  return report;
}

/** True when the QA evidence still describes this exact ledger and these exact bytes. */
export function narrationQaCovers(report: NarrationQaReport | null, ledger: NarrationLedger): boolean {
  if (!report) return false;
  return report.ledger_fingerprint === ledger.fingerprint && report.artifact_hash === ledger.asset_set_hash;
}

export function renderNarrationQaReport(report: NarrationQaReport): string {
  const lines: string[] = [];
  lines.push(`narration QA: ${report.project_id} — ${report.status}`);
  lines.push(`voice:        ${report.voice.provider}/${report.voice.model}/${report.voice.voice} (${report.voice.language})`);
  lines.push(`artifact:     ${report.artifact_hash ?? '(none)'}`);
  lines.push(`report:       ${report.report_hash}`);
  for (const asset of report.assets) {
    lines.push(`  ${asset.status.padEnd(7)} ${asset.asset}  ${asset.duration_seconds ?? '?'}s  ${asset.sha256 ? asset.sha256.slice(0, 12) : 'no-bytes'}`);
    for (const entry of asset.checks) {
      if (entry.status === 'FAIL' || entry.status === 'WARNING') lines.push(`      ${entry.status} ${entry.id}: ${entry.explanation}`);
    }
  }
  for (const entry of report.set_checks ?? []) {
    if (entry.status === 'FAIL' || entry.status === 'WARNING') lines.push(`  ${entry.status} ${entry.id}: ${entry.explanation}`);
  }
  lines.push('note: QA is read-only; it never regenerates audio, approves or publishes.');
  return lines.join('\n');
}
