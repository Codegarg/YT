/**
 * Google Gemini TTS narration provider (Google AI Studio programmatic TTS).
 *
 * Uses the OFFICIAL SDK `@google/genai` (the only Google SDK in this repo) and its current
 * Interactions TTS surface:
 *   client.interactions.create({ model, input:[{type:'user_input',content:[{type:'text', text,
 *     annotations:[{type:'speech_metadata', style: voiceDirection}]}]}],
 *     response_format:{type:'audio', mime_type:'audio/wav'},
 *     generation_config:{ speech_config:[{ voice }] } })
 *   → interaction.output_audio.data (base64) is a complete WAV (RIFF header) for unary requests.
 *
 * AUTHENTICATION: `GEMINI_API_KEY` (loaded via the repository's existing environment-loading
 * pattern). The key is NEVER printed, logged, or written to source. Construction makes NO network
 * call; `synthesize()` is the only method that would. No fallback provider, no retries here.
 */
import type { NarrationProviderCapability, NarrationProviderConfig, NarrationSynthesisRequest, NarrationTtsProvider } from '../narrationTts.js';
import { extractAudioBase64 } from '../narrationTts.js';

export const GEMINI_API_KEY_ENV = 'GEMINI_API_KEY';
export const GEMINI_TTS_MODEL_ENV = 'GEMINI_TTS_MODEL';
export const GEMINI_TTS_VOICE_ENV = 'GEMINI_TTS_VOICE';
export const GEMINI_TTS_LANGUAGE_ENV = 'GEMINI_TTS_LANGUAGE';

export interface GeminiTtsProviderOptions {
  env?: Record<string, string | undefined>;
  /** Injected client factory for tests (no real network implied). */
  clientFactory?: (apiKey: string) => Promise<any>;
}

export class GeminiTtsProvider implements NarrationTtsProvider {
  readonly name = 'gemini';
  private readonly env: Record<string, string | undefined>;
  private readonly clientFactory?: (apiKey: string) => Promise<any>;

  constructor(options: GeminiTtsProviderOptions = {}) {
    this.env = options.env ?? (process.env as any);
    this.clientFactory = options.clientFactory;
  }

  /** Pure capability check. NEVER makes a network request. */
  isCapable(config: NarrationProviderConfig | undefined): NarrationProviderCapability {
    const key = String(this.env[GEMINI_API_KEY_ENV] ?? '').trim();
    if (!key) return { ok: false, returns: 'unknown', reason: `${GEMINI_API_KEY_ENV} is not configured; no request will be made.` };
    if (!config || !config.model || !config.voice) return { ok: false, returns: 'unknown', reason: 'Gemini TTS model/voice are not configured.' };
    return { ok: true, returns: 'wav', model: config.model, voice: config.voice };
  }

  /** Produce WAV bytes. The ONLY method that performs a network call. */
  async synthesize(request: NarrationSynthesisRequest, config: NarrationProviderConfig): Promise<{ bytes: Buffer; mimeType: string }> {
    const cap = this.isCapable(config);
    if (!cap.ok) throw new Error(`GeminiTtsProvider not capable: ${cap.reason}`);
    const apiKey = String(this.env[GEMINI_API_KEY_ENV] ?? '').trim();
    const client = this.clientFactory
      ? await this.clientFactory(apiKey)
      : new (await import('@google/genai')).GoogleGenAI({ apiKey });

    const interaction = await client.interactions.create({
      model: config.model,
      input: [{
        type: 'user_input',
        content: [{
          type: 'text',
          text: String(request.text),
          annotations: [{ type: 'speech_metadata', style: String(request.voiceDirection) }],
        }],
      }],
      response_format: { type: 'audio', mime_type: 'audio/wav' },
      generation_config: { speech_config: [{ voice: config.voice }] },
    });

    const extracted = extractAudioBase64(interaction);
    if (!extracted.ok) throw new Error(`Gemini TTS response invalid: ${extracted.reason}`);
    return { bytes: Buffer.from(extracted.data, 'base64'), mimeType: extracted.mimeType || 'audio/wav' };
  }
}

export function createGeminiTtsProvider(options: GeminiTtsProviderOptions = {}): GeminiTtsProvider {
  return new GeminiTtsProvider(options);
}
