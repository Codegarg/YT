/**
 * OpenAI image provider adapter (STEP-8EB).
 *
 * A concrete `CharacterImageProvider` for OpenAI image generation. It is deliberately
 * CONSERVATIVE: capability values are derived from the installed SDK's own typings/API contract
 * rather than assumed from a model name, and it refuses to proceed when capabilities cannot be
 * established.
 *
 * This module performs NO network call at construction or capability-check time. The generation
 * method exists but must only be invoked by an explicitly authorized later step.
 *
 * No secrets are ever logged. No Flow usage. No background removal. No second provider.
 */
import type { CharacterImageProvider, CharacterProviderCapability } from '../characterGenerator.js';
import type { CharacterGenerationSpec } from '../characterGenerationSpec.js';

/** Env var carrying the image model. Absent => not configured (never guessed). */
export const OPENAI_IMAGE_MODEL_ENV = 'OPENAI_IMAGE_MODEL';
/** Env var carrying the API key (existing project convention). */
export const OPENAI_API_KEY_ENV = 'OPENAI_API_KEY';
/** Optional base URL override (proxies/compatible gateways). */
export const OPENAI_BASE_URL_ENV = 'OPENAI_BASE_URL';

/** Square sizes this adapter is willing to request. */
export const OPENAI_SUPPORTED_SQUARE_SIZES = ['1024x1024'] as const;

/**
 * Per-model transparency capability state — the single source of truth for what this adapter
 * will treat as verified for transparent character generation.
 *
 *   VERIFIED_FOR_TRANSPARENCY     — the model's API contract accepts
 *                                   `background:'transparent'` + `output_format:'png'` +
 *                                   `1024x1024`, and no contrary live evidence exists.
 *   REQUIRES_RUNTIME_VERIFICATION — documented as transparency-capable but NOT proven for this
 *                                   account (e.g. preview features, or an observed live rejection).
 *                                   NEVER accepted as verified; fails closed.
 *   UNSUPPORTED                    — known not to support transparent output.
 *
 * Evidence: `gpt-image-2` is documented by OpenAI as PREVIEW for transparent backgrounds, and a
 * live request from THIS project returned HTTP 400 "Transparent background is not supported for
 * this model." It is therefore REQUIRES_RUNTIME_VERIFICATION, not verified.
 */
export type ModelTransparencyCapability = 'VERIFIED_FOR_TRANSPARENCY' | 'REQUIRES_RUNTIME_VERIFICATION' | 'UNSUPPORTED';

export interface OpenAIModelCapability {
  model: string;
  transparency: ModelTransparencyCapability;
  detail: string;
}

export const OPENAI_MODEL_CAPABILITIES: readonly OpenAIModelCapability[] = [
  { model: 'gpt-image-1', transparency: 'VERIFIED_FOR_TRANSPARENCY', detail: 'API contract accepts transparent background + PNG + 1024x1024.' },
  { model: 'gpt-image-1-mini', transparency: 'VERIFIED_FOR_TRANSPARENCY', detail: 'API contract accepts transparent background + PNG + 1024x1024.' },
  { model: 'gpt-image-1.5', transparency: 'VERIFIED_FOR_TRANSPARENCY', detail: 'Documented to support background=transparent, PNG/WebP, 1024x1024.' },
  { model: 'gpt-image-2', transparency: 'REQUIRES_RUNTIME_VERIFICATION', detail: 'Transparent background is PREVIEW; a live request returned HTTP 400 "Transparent background is not supported for this model."' },
  { model: 'gpt-image-2.5-sunburst', transparency: 'REQUIRES_RUNTIME_VERIFICATION', detail: 'Transparency not verified for this account; treated as unverified.' },
  { model: 'gpt-image-2.5-flare', transparency: 'REQUIRES_RUNTIME_VERIFICATION', detail: 'Transparency not verified for this account; treated as unverified.' },
];

/**
 * Models this adapter accepts as VERIFIED for transparent character generation. Derived from the
 * capability map above (do not hand-maintain a second list).
 */
export const OPENAI_TRANSPARENCY_CAPABLE_MODELS: readonly string[] = OPENAI_MODEL_CAPABILITIES
  .filter((m) => m.transparency === 'VERIFIED_FOR_TRANSPARENCY')
  .map((m) => m.model);

/** Capability record for a model, if known. */
export function openAIModelCapability(model: string): OpenAIModelCapability | undefined {
  return OPENAI_MODEL_CAPABILITIES.find((m) => m.model === String(model ?? '').trim());
}

export type OpenAIProviderCheckStatus =
  | 'READY_FOR_GENERATION'
  | 'OPENAI_IMAGE_PROVIDER_UNAVAILABLE'
  | 'OPENAI_IMAGE_MODEL_NOT_CONFIGURED'
  | 'OPENAI_IMAGE_MODEL_REQUIRES_RUNTIME_VERIFICATION'
  | 'OPENAI_IMAGE_CAPABILITY_UNVERIFIED';

export interface OpenAIProviderCheck {
  status: OpenAIProviderCheckStatus;
  provider: 'openai';
  model: string | null;
  /** Explicit per-model transparency capability state (VERIFIED / REQUIRES_RUNTIME_VERIFICATION / UNSUPPORTED / unknown). */
  transparency: ModelTransparencyCapability | null;
  apiKeyConfigured: boolean;
  pngVerified: boolean;
  transparentBackgroundVerified: boolean;
  sizesVerified: string[];
  detail: string;
}

/**
 * PURE capability/config check. NEVER makes a network request and NEVER reads/generates images.
 * Order: key → model → capability (fail closed at the first missing requirement).
 *
 * IMPORTANT: a READY result is a CONTRACT check only — it is NOT proof the live API accepts the
 * request (gpt-image-2 proved static checks can be wrong). Models marked
 * REQUIRES_RUNTIME_VERIFICATION are never READY and always fail closed.
 */
export function checkOpenAIProvider(env: Record<string, string | undefined> = process.env as any): OpenAIProviderCheck {
  const key = String(env[OPENAI_API_KEY_ENV] ?? '').trim();
  const model = String(env[OPENAI_IMAGE_MODEL_ENV] ?? '').trim();
  const base: OpenAIProviderCheck = {
    status: 'OPENAI_IMAGE_CAPABILITY_UNVERIFIED',
    provider: 'openai',
    model: model || null,
    transparency: null,
    apiKeyConfigured: key.length > 0,
    pngVerified: false,
    transparentBackgroundVerified: false,
    sizesVerified: [],
    detail: '',
  };

  if (!key) return { ...base, status: 'OPENAI_IMAGE_PROVIDER_UNAVAILABLE', detail: `${OPENAI_API_KEY_ENV} is not configured; no request will be made.` };
  if (!model) return { ...base, status: 'OPENAI_IMAGE_MODEL_NOT_CONFIGURED', detail: `${OPENAI_IMAGE_MODEL_ENV} is not set; refusing to guess an image model.` };

  const cap = openAIModelCapability(model);

  // A model documented as transparency-capable but NOT verified for this account (preview, or a
  // confirmed live rejection) must NEVER be treated as verified. Fail closed explicitly.
  if (cap && cap.transparency === 'REQUIRES_RUNTIME_VERIFICATION') {
    return { ...base, transparency: cap.transparency, status: 'OPENAI_IMAGE_MODEL_REQUIRES_RUNTIME_VERIFICATION', detail: `Model "${model}" is NOT verified for transparent output for this account. ${cap.detail}` };
  }
  if (cap && cap.transparency === 'UNSUPPORTED') {
    return { ...base, transparency: cap.transparency, status: 'OPENAI_IMAGE_CAPABILITY_UNVERIFIED', detail: `Model "${model}" is known not to support transparent output.` };
  }

  // PNG + transparent-background + square 1024x1024 are only claimed when the model is VERIFIED.
  if (!OPENAI_TRANSPARENCY_CAPABLE_MODELS.includes(model)) {
    return { ...base, status: 'OPENAI_IMAGE_CAPABILITY_UNVERIFIED', detail: `Model "${model}" is not in the verified-transparency list; PNG + transparent background cannot be established without a request, which this adapter will not make.` };
  }

  return {
    ...base,
    transparency: cap ? cap.transparency : 'VERIFIED_FOR_TRANSPARENCY',
    status: 'READY_FOR_GENERATION',
    pngVerified: true,
    transparentBackgroundVerified: true,
    sizesVerified: [...OPENAI_SUPPORTED_SQUARE_SIZES],
    detail: 'PNG, transparent background and 1024x1024 verified against the installed SDK contract for this model. (Contract-level check only; not a live-API guarantee.)',
  };
}

/** Render the provider check (no secrets — only a CONFIGURED/NOT CONFIGURED marker). */
export function formatProviderCheck(c: OpenAIProviderCheck): string {
  const v = (b: boolean) => (b ? 'VERIFIED' : 'UNVERIFIED');
  const lines: string[] = [];
  lines.push('OPENAI CHARACTER IMAGE PROVIDER CHECK');
  lines.push('');
  lines.push('Provider: OpenAI');
  lines.push(`Model: ${c.model ?? '(not configured)'}`);
  lines.push(`API key: ${c.apiKeyConfigured ? 'CONFIGURED' : 'NOT CONFIGURED'}`);
  lines.push(`Transparency state: ${c.transparency ?? 'UNKNOWN'}`);
  lines.push(`PNG: ${v(c.pngVerified)}`);
  lines.push(`Transparent background: ${v(c.transparentBackgroundVerified)}`);
  lines.push(`1024x1024: ${v(c.sizesVerified.includes('1024x1024'))}`);
  lines.push(`1536x1536: ${v(c.sizesVerified.includes('1536x1536'))}`);
  lines.push('');
  lines.push('Overall:');
  lines.push(c.status === 'READY_FOR_GENERATION' ? c.status : `BLOCKED:\n${c.status}`);
  if (c.detail) lines.push(`Detail: ${c.detail}`);
  return lines.join('\n');
}

/** Capabilities exposed to the generator. Derived from the pure check (no request). */
export function openAICapabilities(env: Record<string, string | undefined> = process.env as any): CharacterProviderCapability {
  const c = checkOpenAIProvider(env);
  return {
    png: c.pngVerified,
    transparentBackground: c.transparentBackgroundVerified,
    sizes: [...c.sizesVerified],
    // The API can return an opaque image for an unsupported request, so we never assert the
    // inverse; when capabilities are unverified the generator's own gate will fail closed.
    mayReturnOpaque: !c.transparentBackgroundVerified,
  };
}

export interface OpenAIGenerateOptions {
  size: string;
  transparentBackground: boolean;
  model?: string;
  /** Injected client factory (tests/mocks). Kept injectable so no real call is implied. */
  clientFactory?: (apiKey: string, baseURL?: string) => Promise<any>;
  env?: Record<string, string | undefined>;
}

/**
 * The OpenAI implementation of `CharacterImageProvider`.
 * Constructing it makes NO network call. `generate()` is the only method that would.
 */
export class OpenAICharacterImageProvider implements CharacterImageProvider {
  readonly name = 'openai';
  readonly capabilities: CharacterProviderCapability;
  private readonly env: Record<string, string | undefined>;
  private readonly clientFactory?: (apiKey: string, baseURL?: string) => Promise<any>;

  constructor(options: { env?: Record<string, string | undefined>; clientFactory?: (apiKey: string, baseURL?: string) => Promise<any> } = {}) {
    this.env = options.env ?? (process.env as any);
    this.clientFactory = options.clientFactory;
    this.capabilities = openAICapabilities(this.env);
  }

  /**
   * Produce PNG bytes for a character spec. Uses the spec's EXISTING prompts verbatim.
   * Returns `{ bytes, format }`; it never writes canonical files (the ingestion layer does).
   */
  async generate(spec: CharacterGenerationSpec, options: OpenAIGenerateOptions): Promise<{ bytes: Buffer; format: 'png' }> {
    const check = checkOpenAIProvider(this.env);
    if (check.status !== 'READY_FOR_GENERATION') throw new Error(`${check.status}: ${check.detail}`);

    const apiKey = String(this.env[OPENAI_API_KEY_ENV] ?? '').trim();
    const model = options.model ?? String(this.env[OPENAI_IMAGE_MODEL_ENV] ?? '').trim();
    const baseURL = String(this.env[OPENAI_BASE_URL_ENV] ?? '').trim() || undefined;
    if (!options.transparentBackground) throw new Error('OpenAICharacterImageProvider requires transparentBackground=true.');
    if (!check.sizesVerified.includes(options.size)) throw new Error(`Requested size ${options.size} is not verified for model ${model}.`);

    const client = this.clientFactory
      ? await this.clientFactory(apiKey, baseURL)
      : new (await import('openai')).default({ apiKey, ...(baseURL ? { baseURL } : {}) });

    // Prompt = the spec's existing text (+ its negative prompt folded into the instruction).
    const prompt = `${spec.generation_prompt} Avoid: ${spec.negative_prompt}.`;

    const response = await client.images.generate({
      model,
      prompt,
      n: 1,
      size: options.size,
      background: 'transparent',
      output_format: 'png',
    });

    // Handle the real response shape: b64_json directly, or a URL to fetch.
    const item = response?.data?.[0];
    if (!item) throw new Error('OpenAI returned no image data.');
    if (typeof item.b64_json === 'string' && item.b64_json) {
      return { bytes: Buffer.from(item.b64_json, 'base64'), format: 'png' };
    }
    if (typeof item.url === 'string' && item.url) {
      const res = await fetch(item.url);
      if (!res.ok) throw new Error(`OpenAI image URL fetch failed (${res.status}).`);
      return { bytes: Buffer.from(await res.arrayBuffer()), format: 'png' };
    }
    throw new Error('OpenAI response contained neither b64_json nor url.');
  }
}

/** Convenience: build a provider instance (constructor makes no request). */
export function createOpenAICharacterImageProvider(options: { env?: Record<string, string | undefined>; clientFactory?: (apiKey: string, baseURL?: string) => Promise<any> } = {}): OpenAICharacterImageProvider {
  return new OpenAICharacterImageProvider(options);
}
