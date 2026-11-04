/**
 * Narration TTS provider abstraction (browser-free).
 *
 * Flow mirror of the character-provider pattern: a small provider boundary plus pure decision
 * helpers. The concrete provider returns native provider audio bytes; the shared narration ingest
 * layer (`narration.ts`) validates and atomically installs the file. This module performs NO
 * network calls and is safe to import in tests.
 *
 * It reuses the EXISTING narration filename/extension contract from `narrationDuration.ts` and
 * never hard-codes scene-specific text.
 */

/** Audio formats the existing narration contract accepts. */
export const NARRATION_AUDIO_EXTENSIONS = ['.wav', '.mp3', '.m4a', '.aac', '.ogg'] as const;

export interface NarrationSynthesisRequest {
  sceneNumber: number;
  /** Exact pipeline `narration_text` for this scene (never reconstructed from dialogue). */
  text: string;
  /** Narrator delivery/persona instruction (e.g. "Adult Hindi folk-horror narrator…"). */
  voiceDirection: string;
  /** Provider-native audio format requested from the provider. */
  format: 'wav' | 'mp3' | string;
}

export interface NarrationProviderConfig {
  model: string;
  voice: string;
  /** Optional language hint (BCP-47), when the provider supports it. */
  language?: string;
}

export interface NarrationProviderCapability {
  ok: boolean;
  /** Native format the provider will return for the requested format. */
  returns: 'wav' | 'mp3' | 'other' | 'unknown';
  model?: string;
  voice?: string;
  reason?: string;
}

export interface NarrationTtsProvider {
  readonly name: string;
  /** Pure capability/config check. NEVER makes a network request. */
  isCapable(config: NarrationProviderConfig | undefined): NarrationProviderCapability;
  /** Produce native audio bytes. The ONLY method that would perform a network call. */
  synthesize(request: NarrationSynthesisRequest, config: NarrationProviderConfig): Promise<{ bytes: Buffer; mimeType: string }>;
}

// ---------------------------------------------------------------------------------------
// Pure configuration parsing
// ---------------------------------------------------------------------------------------

export type ConfigParseResult =
  | { ok: true; config: NarrationProviderConfig }
  | { ok: false; reason: string };

/**
 * Parse narration TTS configuration from the environment. Fail-closed: a missing model or voice is
 * an explicit error (never guessed). The API key is validated separately by the provider.
 */
export function parseNarrationConfig(env: Record<string, string | undefined>): ConfigParseResult {
  const model = String(env.GEMINI_TTS_MODEL ?? '').trim();
  const voice = String(env.GEMINI_TTS_VOICE ?? '').trim();
  const language = String(env.GEMINI_TTS_LANGUAGE ?? '').trim() || undefined;
  if (!model) return { ok: false, reason: 'GEMINI_TTS_MODEL is not configured; refusing to guess a TTS model.' };
  if (!voice) return { ok: false, reason: 'GEMINI_TTS_VOICE is not configured; refusing to guess a narrator voice.' };
  return { ok: true, config: { model, voice, language } };
}

/** Deterministic realization status for one scene. */
export type NarrationResultStatus = 'REUSED' | 'INSTALLED' | 'FAILED' | 'INVALID' | 'SKIPPED';

export interface NarrationResult {
  sceneNumber: number;
  status: NarrationResultStatus;
  file: string;
  /** Non-secret diagnostic. */
  reason?: string;
  durationSeconds?: number;
  bytes?: number;
}

/** Extract a base64 audio payload from a Gemini interaction response (pure, no network). */
export function extractAudioBase64(interaction: unknown): { ok: true; data: string; mimeType: string } | { ok: false; reason: string } {
  const audio = (interaction as any)?.output_audio ?? (interaction as any)?.outputAudio;
  if (!audio) return { ok: false, reason: 'Provider response contained no output_audio.' };
  const data = audio.data;
  if (typeof data !== 'string' || !data) return { ok: false, reason: 'Provider output_audio.data was empty.' };
  const mimeType = typeof audio.mime_type === 'string' ? audio.mime_type : (typeof audio.mimeType === 'string' ? audio.mimeType : '');
  return { ok: true, data, mimeType };
}

/** True when the provider must not attempt synthesis (missing key OR invalid config). */
export function providerReady(cap: NarrationProviderCapability): boolean {
  return cap.ok === true;
}
