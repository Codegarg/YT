// Offline OpenAI character image provider tests (STEP-8EB). NO real API calls. No Flow.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { SRC } from './_testPaths.mjs';
import { REPO } from './_testPaths.mjs';

const pv = await import(pathToFileURL(`${SRC}/providers/openaiCharacterImageProvider.ts`).href);
const gen = await import(pathToFileURL(`${SRC}/characterGenerator.ts`).href);
const specMod = await import(pathToFileURL(`${SRC}/characterGenerationSpec.ts`).href);
const {
  checkOpenAIProvider, formatProviderCheck, openAICapabilities, OpenAICharacterImageProvider,
  createOpenAICharacterImageProvider, OPENAI_SUPPORTED_SQUARE_SIZES, OPENAI_TRANSPARENCY_CAPABLE_MODELS,
  OPENAI_MODEL_CAPABILITIES, openAIModelCapability,
} = pv;
const { generateCharacterAssets, assertProviderCapable, ingestCharacterBytes } = gen;
const { CHARACTER_GENERATION_SPECS, characterSpecsFromPipeline } = specMod;

// A small project-derived spec set is used for prompt/request-shape checks so the assertions are
// not tied to any story-specific built-in constant.
const PROJECT_PIPELINE = {
  project_id: 'test-project',
  characters: [
    { tag: '@CHAR-01-ARJUN', name: 'अर्जुन', age: 22, gender: 'male', personality: 'curious', voice_description: 'v', look_summary: 'l', full_prompt: '22-year-old Indian man, light blue cotton kurta, neutral grey studio background, 2D semi-realistic cartoon illustration' },
    { tag: '@CHAR-06-EXTRA', name: 'extra', age: null, gender: 'male', personality: 'p', voice_description: 'v', look_summary: 'l', full_prompt: 'extra person, neutral grey studio background' },
  ],
};
const derived = characterSpecsFromPipeline(PROJECT_PIPELINE);
const PROJECT_SPECS = derived.ok ? derived.specs : [];
const SPEC0 = PROJECT_SPECS[0];

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

function makePng(w: number, h: number, ct = 6, alpha = 128): Buffer {
  const T: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct; const ch = ct === 6 ? 4 : 2;
  const raw = Buffer.alloc(h * (1 + w * ch), 0x80);
  for (let y = 0; y < h; y++) raw[y * (1 + w * ch)] = 0;
  if (ct === 6) for (let y = 0; y < h; y++) { const off = y * (1 + w * ch) + 1; for (let x = 0; x < w; x++) raw[off + x * 4 + 3] = alpha; }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8eb-'));

// ---- configuration / capability matrix (pure, no requests) ----
{
  check('missing API key -> OPENAI_IMAGE_PROVIDER_UNAVAILABLE', checkOpenAIProvider({}).status === 'OPENAI_IMAGE_PROVIDER_UNAVAILABLE');
  check('key but no model -> OPENAI_IMAGE_MODEL_NOT_CONFIGURED', checkOpenAIProvider({ OPENAI_API_KEY: 'k' }).status === 'OPENAI_IMAGE_MODEL_NOT_CONFIGURED');
  check('key + unknown model -> OPENAI_IMAGE_CAPABILITY_UNVERIFIED', checkOpenAIProvider({ OPENAI_API_KEY: 'k', OPENAI_IMAGE_MODEL: 'dall-e-3' }).status === 'OPENAI_IMAGE_CAPABILITY_UNVERIFIED');
  const ready = checkOpenAIProvider({ OPENAI_API_KEY: 'k', OPENAI_IMAGE_MODEL: 'gpt-image-1' });
  check('key + verified model -> READY_FOR_GENERATION', ready.status === 'READY_FOR_GENERATION');
  check('READY reports PNG + transparency + sizes verified', ready.pngVerified === true && ready.transparentBackgroundVerified === true && ready.sizesVerified.includes('1024x1024'));
  check('empty-string key treated as missing', checkOpenAIProvider({ OPENAI_API_KEY: '   ' }).status === 'OPENAI_IMAGE_PROVIDER_UNAVAILABLE');
  check('capability check is deterministic', JSON.stringify(checkOpenAIProvider({ OPENAI_API_KEY: 'k', OPENAI_IMAGE_MODEL: 'gpt-image-1' })) === JSON.stringify(checkOpenAIProvider({ OPENAI_API_KEY: 'k', OPENAI_IMAGE_MODEL: 'gpt-image-1' })));
  check('verified model list is explicit (not empty)', Array.isArray(OPENAI_TRANSPARENCY_CAPABLE_MODELS) && OPENAI_TRANSPARENCY_CAPABLE_MODELS.length > 0);
  check('only square 1024x1024 is offered', JSON.stringify(OPENAI_SUPPORTED_SQUARE_SIZES) === JSON.stringify(['1024x1024']));
  // ---- regression: the observed gpt-image-2 live failure ----
  check('gpt-image-2 is NOT in the verified list', !OPENAI_TRANSPARENCY_CAPABLE_MODELS.includes('gpt-image-2'));
  const gi2 = checkOpenAIProvider({ OPENAI_API_KEY: 'k', OPENAI_IMAGE_MODEL: 'gpt-image-2' });
  check('gpt-image-2 -> REQUIRES_RUNTIME_VERIFICATION (not READY)', gi2.status === 'OPENAI_IMAGE_MODEL_REQUIRES_RUNTIME_VERIFICATION', gi2);
  check('gpt-image-2 does not claim transparency verified', gi2.transparentBackgroundVerified === false && gi2.transparency === 'REQUIRES_RUNTIME_VERIFICATION', gi2);
  check('gpt-image-2 detail references the observed 400', /400|not supported|PREVIEW|preview/i.test(gi2.detail), gi2.detail);
  check('gpt-image-1.5 IS verified for transparency', openAIModelCapability('gpt-image-1.5')?.transparency === 'VERIFIED_FOR_TRANSPARENCY');
  check('gpt-image-1.5 -> READY_FOR_GENERATION', checkOpenAIProvider({ OPENAI_API_KEY: 'k', OPENAI_IMAGE_MODEL: 'gpt-image-1.5' }).status === 'READY_FOR_GENERATION');
  check('capability states are exactly the three documented values',
    new Set(OPENAI_MODEL_CAPABILITIES.map((m: any) => m.transparency)).size <= 3 &&
    OPENAI_MODEL_CAPABILITIES.every((m: any) => ['VERIFIED_FOR_TRANSPARENCY', 'REQUIRES_RUNTIME_VERIFICATION', 'UNSUPPORTED'].includes(m.transparency)));
}

// ---- no secret leakage ----
{
  const SECRET = 'sk-abcdef0123456789abcdef0123456789';
  const out = formatProviderCheck(checkOpenAIProvider({ OPENAI_API_KEY: SECRET, OPENAI_IMAGE_MODEL: 'gpt-image-1' }));
  check('provider-check output never contains the API key', !out.includes(SECRET) && !/sk-[A-Za-z0-9]{10,}/.test(out));
  check('provider-check never prints the key (only CONFIGURED marker)', /API key: CONFIGURED/.test(out));
  check('provider-check does not leak the key in the not-configured case', !formatProviderCheck(checkOpenAIProvider({})).includes('sk-'));
}

// ---- capability gating via the generator ----
{
  const notReady = openAICapabilities({});
  check('unconfigured provider reports png=false', notReady.png === false);
  const good = openAICapabilities({ OPENAI_API_KEY: 'k', OPENAI_IMAGE_MODEL: 'gpt-image-1' });
  check('configured provider exposes verified capabilities', good.png === true && good.transparentBackground === true && good.sizes.includes('1024x1024'));
  check('generator gate rejects the unconfigured provider', assertProviderCapable({ name: 'openai', capabilities: notReady } as any, '1024x1024', true).ok === false);
  check('generator gate accepts the verified provider', assertProviderCapable({ name: 'openai', capabilities: good } as any, '1024x1024', true).ok === true);
}

// ---- provider construction makes NO request ----
{
  let factoryCalled = 0;
  const p = new OpenAICharacterImageProvider({ env: { OPENAI_API_KEY: 'k', OPENAI_IMAGE_MODEL: 'gpt-image-1' }, clientFactory: async () => { factoryCalled++; return {}; } });
  check('constructing the provider makes no client/network call', factoryCalled === 0);
  check('provider name + capabilities are pure', p.name === 'openai' && p.capabilities.png === true);
  const blocked = createOpenAICharacterImageProvider({ env: {} });
  check('blocked provider has png=false capability', blocked.capabilities.png === false);
}

// ---- generate() refuses without verified capability (no request) ----
{
  let factoryCalled = 0;
  const p = new OpenAICharacterImageProvider({ env: {}, clientFactory: async () => { factoryCalled++; return {}; } });
  const spec = SPEC0;
  let threw = '';
  try { await p.generate(spec, { size: '1024x1024', transparentBackground: true }); } catch (e: any) { threw = String(e?.message ?? e); }
  check('generate() fails closed before any call when unconfigured', /OPENAI_IMAGE_PROVIDER_UNAVAILABLE/.test(threw) && factoryCalled === 0, threw);
  const noModel = new OpenAICharacterImageProvider({ env: { OPENAI_API_KEY: 'k' }, clientFactory: async () => { factoryCalled++; return {}; } });
  let threw2 = '';
  try { await noModel.generate(spec, { size: '1024x1024', transparentBackground: true }); } catch (e: any) { threw2 = String(e?.message ?? e); }
  check('generate() fails closed when the model is unconfigured', /OPENAI_IMAGE_MODEL_NOT_CONFIGURED/.test(threw2) && factoryCalled === 0, threw2);
}

// ---- mocked successful generation: correct request shape + b64 response handling ----
{
  let captured: any = null;
  const client = { images: { generate: async (body: any) => { captured = body; return { data: [{ b64_json: makePng(1024, 1024, 6, 128).toString('base64') }] }; } } };
  const p = new OpenAICharacterImageProvider({ env: { OPENAI_API_KEY: 'k', OPENAI_IMAGE_MODEL: 'gpt-image-1' }, clientFactory: async () => client });
  const spec = SPEC0;
  const res = await p.generate(spec, { size: '1024x1024', transparentBackground: true });
  check('mock generate returns PNG bytes', Buffer.isBuffer(res.bytes) && res.format === 'png' && res.bytes.length > 0);
  check('request asks for png + transparent + 1024x1024 + n=1', captured.output_format === 'png' && captured.background === 'transparent' && captured.size === '1024x1024' && captured.n === 1);
  check('request uses the spec prompt verbatim', captured.prompt.includes(spec.generation_prompt));
  check('request does not rewrite the character identity', captured.prompt.includes('light blue cotton kurta'));
  check('provider returns bytes only (writes no canonical file)', !fs.existsSync(path.join(tmp, 'CHAR-01-ARJUN.png')));
}

// ---- url response shape also handled ----
{
  const pngB64 = makePng(1024, 1024, 6, 128).toString('base64');
  const origFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(Buffer.from(pngB64, 'base64'), { status: 200 });
  try {
    const client = { images: { generate: async () => ({ data: [{ url: 'https://example.test/img.png' }] }) } };
    const p = new OpenAICharacterImageProvider({ env: { OPENAI_API_KEY: 'k', OPENAI_IMAGE_MODEL: 'gpt-image-1' }, clientFactory: async () => client });
    const res = await p.generate(SPEC0, { size: '1024x1024', transparentBackground: true });
    check('url response shape is handled', Buffer.isBuffer(res.bytes) && res.bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a');
  } finally { (globalThis as any).fetch = origFetch; }
}

// ---- end-to-end through the safe ingestion layer (mocked provider) ----
{
  const out2 = path.join(tmp, 'characters');
  const provider = new OpenAICharacterImageProvider({
    env: { OPENAI_API_KEY: 'k', OPENAI_IMAGE_MODEL: 'gpt-image-1' },
    clientFactory: async () => ({ images: { generate: async () => ({ data: [{ b64_json: makePng(1024, 1024, 6, 128).toString('base64') }] }) } }),
  });
  const outcomes = await generateCharacterAssets({ outputDir: out2, provider: provider as any, size: '1024x1024' });
  check('mocked provider installs all four via the existing validator', outcomes.length === 4 && outcomes.every((o: any) => o.ok && o.status === 'INSTALLED'), JSON.stringify(outcomes.filter((o: any) => !o.ok)));
  check('four example files exist', outcomes.every((o: any) => fs.existsSync(path.join(out2, o.filename))));
  check('no temp residue after installation', !fs.readdirSync(out2).some((f) => f.includes('.tmp-')));
  // opaque output is rejected by the pixel-alpha validator
  const opaqueProvider = new OpenAICharacterImageProvider({
    env: { OPENAI_API_KEY: 'k', OPENAI_IMAGE_MODEL: 'gpt-image-1' },
    clientFactory: async () => ({ images: { generate: async () => ({ data: [{ b64_json: makePng(1024, 1024, 6, 255).toString('base64') }] }) } }),
  });
  const rej = await generateCharacterAssets({ outputDir: path.join(tmp, 'characters-opaque'), provider: opaqueProvider as any, size: '1024x1024' });
  check('opaque provider output rejected (no opaque success)', rej.every((o: any) => !o.ok && o.status === 'INVALID_OUTPUT'));
  check('opaque run installed nothing', !fs.existsSync(path.join(tmp, 'characters-opaque')) || fs.readdirSync(path.join(tmp, 'characters-opaque')).length === 0);
  // invalid bytes rejected
  const junk = await ingestCharacterBytes('@CHAR-01-ARJUN', Buffer.from('not a png at all, padded'), { outputDir: path.join(tmp, 'junk') });
  check('invalid provider bytes rejected', junk.ok === false && junk.status === 'INVALID_OUTPUT');
}

// ---- non-PNG provider output rejected ----
{
  const webpish = { name: 'openai', capabilities: { png: true, transparentBackground: true, sizes: ['1024x1024'] }, generate: async () => ({ bytes: makePng(1024, 1024, 6, 128), format: 'jpeg' }) } as any;
  const r = await generateCharacterAssets({ outputDir: path.join(tmp, 'jpg'), provider: webpish });
  check('non-PNG format rejected (no JPEG fallback)', r.every((o: any) => !o.ok && o.status === 'INVALID_OUTPUT'));
}

// ---- module safety ----
{
  const src = fs.readFileSync(`${SRC}/providers/openaiCharacterImageProvider.ts`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('provider has no Flow/Chrome dependency', !/playwright|FlowClient|chrome/i.test(src));
  check('provider has no background-removal code', !/removeBackground|segmentation|chromaKey|alphaMatting/i.test(src));
  check('provider does not hard-code a model name as the default', !/OPENAI_IMAGE_MODEL\s*\?\?\s*['"]gpt-image/.test(src));
  check('provider writes no canonical character file itself', !/characterAssetPath|writeFile/.test(src));
}

// ---- real project untouched ----
{
  check('real characters dir not created', !fs.existsSync(`${REPO}/production/inputs/raat-ka-khauf-3am-kuan/characters`));
  const h = crypto.createHash('sha256').update(fs.readFileSync(`${REPO}/scripting/projects/raat-ka-khauf-3am-kuan/pipeline.json`)).digest('hex');
  check('real pipeline.json SHA unchanged', h === '0c654402dad814f11c3e498cfd541667aabd65e24d7a17db01219bbd7491dcfb');
}

console.log(`\nOPENAI-CHARACTER-PROVIDER TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
