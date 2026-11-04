/**
 * Narration generation CLI (Gemini TTS) — deterministic, idempotent, fail-closed.
 *
 *   npm run narration -- --project <pipeline.json> --dry-run
 *   npm run narration -- --project <pipeline.json> --scene 1
 *   npm run narration -- --project <pipeline.json> --missing
 *   npm run narration -- --project <pipeline.json> --scene 1 --overwrite
 *
 * Safety: valid existing file → REUSED (never regenerated); missing → INSTALLED via
 * tmp → ffprobe validate → (normalize to WAV if needed) → atomic rename; invalid → fail closed
 * unless --overwrite (which only replaces INVALID, never a valid file). One provider request per
 * scene, no automatic retries, no fallback provider. Text comes ONLY from pipeline.scenes[].
 * narration_text (Scene 15 uses the complete narration_text once). No OpenAI. No Flow.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadLocalEnvironment } from './bgm.js';
import { parseNarrationConfig, extractAudioBase64, type NarrationProviderConfig, type NarrationTtsProvider } from './narrationTts.js';
import { createGeminiTtsProvider, GEMINI_API_KEY_ENV } from './providers/geminiTtsProvider.js';
import { inputCategoryDir } from './inputManifest.js';
import { narrateScenesPlan, isNarrationScene, installNarratedAudio, type SceneNarrationPlan } from './narrationWorkflow.js';

const exec = promisify(execFile);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DOTENV = path.resolve(MODULE_DIR, '../../scripting/.env');

function arg(name: string, fallback?: string): string | undefined { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; }
function hasFlag(name: string): boolean { return process.argv.includes(name); }

const VOICE_DIRECTION = 'Adult Hindi folk-horror narrator. Calm, suspenseful, native North Indian Hindi pronunciation; no English or Western cadence.';

export interface NarrationRunDeps {
  provider?: NarrationTtsProvider;
  env?: Record<string, string | undefined>;
  /** Absolute narration directory (overridable in tests). */
  narrationDir?: string;
  /** Absolute ffprobe/ffmpeg binaries (tests). */
  ffprobePath?: string;
  ffmpegPath?: string;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export interface NarrationRunResult {
  dryRun: boolean;
  provider: string;
  model: string | null;
  voice: string | null;
  results: Array<{ sceneNumber: number; status: string; file: string; reason?: string; durationSeconds?: number; bytes?: number }>;
}

/** Build the deterministic plan for a scene subset (or all narration scenes). */
export function buildNarrationPlan(pipeline: any, options: { scene?: number; missing?: boolean; narrationDir: string }): SceneNarrationPlan[] {
  return narrateScenesPlan(pipeline, options);
}

export async function runNarration(opts: {
  pipeline: any;
  narrationDir: string;
  dryRun?: boolean;
  scene?: number;
  missing?: boolean;
  overwrite?: boolean;
} & NarrationRunDeps): Promise<NarrationRunResult> {
  const env = opts.env ?? (process.env as any);
  const log = opts.log ?? (() => {});
  const parsed = parseNarrationConfig(env);
  const provider = opts.provider ?? createGeminiTtsProvider({ env });
  const providerName = provider.name;

  const plan = buildNarrationPlan(opts.pipeline, { scene: opts.scene, missing: opts.missing, narrationDir: opts.narrationDir });

  if (opts.dryRun) {
    return { dryRun: true, provider: providerName, model: parsed.ok ? parsed.config.model : null, voice: parsed.ok ? parsed.config.voice : null, results: plan.map((p) => ({ sceneNumber: p.sceneNumber, status: p.action === 'REUSE' ? 'REUSED' : p.action === 'GENERATE' ? 'PLANNED' : p.action === 'FAIL_INVALID' ? 'INVALID' : 'SKIPPED', file: p.file, reason: `textLen=${p.textLength}` })) };
  }

  if (!parsed.ok) {
    // fail closed: cannot synthesize without model/voice configuration
    return { dryRun: false, provider: providerName, model: null, voice: null, results: plan.map((p) => ({ sceneNumber: p.sceneNumber, status: 'FAILED', file: p.file, reason: parsed.reason })) };
  }
  const config: NarrationProviderConfig = parsed.config;

  const out: NarrationRunResult['results'] = [];
  for (const p of plan) {
    if (p.action === 'REUSE') { out.push({ sceneNumber: p.sceneNumber, status: 'REUSED', file: p.file }); log('narration_reuse', { scene: p.sceneNumber, file: p.file }); continue; }
    if (p.action === 'FAIL_INVALID' && !opts.overwrite) { out.push({ sceneNumber: p.sceneNumber, status: 'INVALID', file: p.file, reason: 'Existing narration is invalid; pass --overwrite to replace it.' }); log('narration_invalid', { scene: p.sceneNumber }); continue; }
    if (p.action === 'SKIP') { out.push({ sceneNumber: p.sceneNumber, status: 'SKIPPED', file: p.file, reason: p.reason }); continue; }

    // action === GENERATE (one explicit provider request; no retry)
    const cap = provider.isCapable(config);
    if (!cap.ok) { out.push({ sceneNumber: p.sceneNumber, status: 'FAILED', file: p.file, reason: cap.reason }); log('narration_provider_incapable', { scene: p.sceneNumber, reason: cap.reason }); break; }
    let bytes: Buffer; let mimeType = '';
    try {
      const r = await provider.synthesize({ sceneNumber: p.sceneNumber, text: p.text, voiceDirection: VOICE_DIRECTION, format: 'wav' }, config);
      bytes = r.bytes; mimeType = r.mimeType;
    } catch (e: any) {
      out.push({ sceneNumber: p.sceneNumber, status: 'FAILED', file: p.file, reason: `provider failure: ${String(e?.message ?? e).slice(0, 160)}` });
      log('narration_provider_failed', { scene: p.sceneNumber });
      break; // stop safely; do NOT retry or continue generating
    }
    const installed = await installNarratedAudio({
      sceneNumber: p.sceneNumber, dir: opts.narrationDir, file: p.file, bytes, mimeType,
      ffprobePath: opts.ffprobePath, ffmpegPath: opts.ffmpegPath,
      overwriteInvalid: opts.overwrite === true,
    });
    out.push({ sceneNumber: p.sceneNumber, status: installed.status, file: p.file, reason: installed.reason, durationSeconds: installed.durationSeconds, bytes: installed.bytes });
    log('narration_result', { scene: p.sceneNumber, status: installed.status, file: p.file });
    if (installed.status === 'FAILED' || installed.status === 'INVALID') break; // fail closed on install problems
  }
  return { dryRun: false, provider: providerName, model: config.model, voice: config.voice, results: out };
}

const isMain = process.argv[1] && /narration\.(ts|js|mts)$/.test(process.argv[1]);
if (isMain) {
  const projectFile = path.resolve(arg('--project') ?? '../scripting/projects/example/pipeline.json');
  const pipeline = JSON.parse(await fs.readFile(projectFile, 'utf8'));
  await loadLocalEnvironment();
  const inputsRoot = process.env.PRODUCTION_INPUTS_DIR ? path.resolve(process.env.PRODUCTION_INPUTS_DIR) : path.resolve('inputs');
  const narrationDir = path.resolve(arg('--narration-dir') ?? inputCategoryDir(pipeline.project_id, 'narration', inputsRoot));
  const sceneArg = arg('--scene');
  const scene = sceneArg !== undefined ? Number(sceneArg) : undefined;
  if (scene !== undefined && (!Number.isInteger(scene) || !isNarrationScene(pipeline, scene))) {
    console.error(`--scene ${sceneArg} is not a narration-required scene.`); process.exit(2);
  }
  const result = await runNarration({
    pipeline, narrationDir, dryRun: hasFlag('--dry-run'),
    scene, missing: hasFlag('--missing'), overwrite: hasFlag('--overwrite'),
  });
  const lines = [`narration provider=${result.provider} model=${result.model ?? '(unset)'} voice=${result.voice ?? '(unset)'} dryRun=${result.dryRun}`];
  for (const r of result.results) lines.push(`  scene ${String(r.sceneNumber).padStart(2)}  ${r.status.padEnd(9)} ${r.file}${r.reason ? `  (${r.reason})` : ''}`);
  console.log(lines.join('\n'));
  process.exit(result.results.some((r) => r.status === 'FAILED' || r.status === 'INVALID') ? 1 : 0);
}
