/**
 * Provider-agnostic character asset generator + safe ingestion (STEP-8DZ).
 *
 * Design:
 *   · No provider is hard-coded or called here. A caller injects a `CharacterImageProvider`.
 *   · The generator FAILS CLOSED unless the provider can guarantee PNG + transparency +
 *     sufficient resolution. It never falls back to JPEG, never removes backgrounds, and never
 *     accepts an opaque model sheet.
 *   · Ingestion reuses the EXISTING `characterAsset.ts` contract (no duplicated rules): write to
 *     a temp file → validate → atomic rename. A failed validation deletes the temp file and
 *     never overwrites an existing valid asset.
 *
 * This module performs NO network calls of its own and is safe to import in tests.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getCharacterAsset, characterAssetPath } from './characterAsset.js';
import { CHARACTER_GENERATION_SPECS, canonicalCharacterFilename, characterSpecsFromPipeline, type CharacterGenerationSpec } from './characterGenerationSpec.js';

export type CharacterProviderCapability = {
  /** Must be true: the provider can return PNG. */
  png: boolean;
  /** Must be true: the provider honours a transparent-background request. */
  transparentBackground: boolean;
  /** The square sizes the provider supports. */
  sizes: string[];
  /** True when the provider may return an opaque image for a transparent request. */
  mayReturnOpaque?: boolean;
};

export interface CharacterImageProvider {
  name: string;
  capabilities: CharacterProviderCapability;
  /** Produce raw image bytes for a spec. Must NOT write into production inputs itself. */
  generate(spec: CharacterGenerationSpec, options: { size: string; transparentBackground: boolean; model?: string }): Promise<{ bytes: Buffer; format: 'png' | 'webp' | string }>;
}

export interface GenerateCharacterOptions {
  /** Canonical characters directory (production/inputs/<id>/characters). */
  outputDir: string;
  provider?: CharacterImageProvider;
  model?: string;
  /** Requested square size, e.g. "1024x1024". */
  size?: string;
  transparentBackground?: boolean;
  /** Replace an existing valid asset (default false). */
  overwrite?: boolean;
  /** Print the plan without generating or writing anything. */
  dryRun?: boolean;
  /** Restrict to specific tags. */
  only?: string[];
  /**
   * Project pipeline (parsed pipeline.json). When supplied, the character specs are derived from
   * its `characters` (the source of truth) instead of the built-in example cast. This is the
   * canonical production path.
   */
  pipeline?: unknown;
}

export type CharacterGenerationOutcome =
  | { ok: true; tag: string; status: 'PLANNED' | 'INSTALLED' | 'PRESERVED'; filename: string; path?: string; width?: number; height?: number; sha256?: string }
  | { ok: false; tag: string; status: 'PROVIDER_UNAVAILABLE' | 'PROVIDER_INCAPABLE' | 'INVALID_OUTPUT' | 'WRITE_FAILED'; reason: string };

const DEFAULT_SIZE = '1024x1024';

/** Parse "1024x1024" -> { w, h } (square enforced by the contract, not here). */
export function parseSize(size: string): { w: number; h: number } | null {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(String(size ?? '').trim());
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null;
  return { w, h };
}

/**
 * Fail-closed capability check. Returns a reason string when generation must NOT proceed.
 * - provider missing -> PROVIDER_UNAVAILABLE
 * - no PNG or no transparency guarantee -> PROVIDER_INCAPABLE
 * - requested size below the contract minimum, or unsupported -> PROVIDER_INCAPABLE
 */
export function assertProviderCapable(provider: CharacterImageProvider | undefined, size: string, transparentBackground: boolean): { ok: true } | { ok: false; status: 'PROVIDER_UNAVAILABLE' | 'PROVIDER_INCAPABLE'; reason: string } {
  if (!provider) return { ok: false, status: 'PROVIDER_UNAVAILABLE', reason: 'No character image provider is configured; refusing to generate.' };
  const c = provider.capabilities;
  if (!c || c.png !== true) return { ok: false, status: 'PROVIDER_INCAPABLE', reason: `Provider "${provider.name}" cannot guarantee PNG output.` };
  if (transparentBackground && c.transparentBackground !== true) return { ok: false, status: 'PROVIDER_INCAPABLE', reason: `Provider "${provider.name}" cannot guarantee a transparent background.` };
  if (c.mayReturnOpaque === true) return { ok: false, status: 'PROVIDER_INCAPABLE', reason: `Provider "${provider.name}" may return an opaque image; refusing (no background removal is performed).` };
  const parsed = parseSize(size);
  if (!parsed) return { ok: false, status: 'PROVIDER_INCAPABLE', reason: `Invalid size "${size}".` };
  if (!Array.isArray(c.sizes) || !c.sizes.includes(size)) return { ok: false, status: 'PROVIDER_INCAPABLE', reason: `Provider "${provider.name}" does not support size ${size}.` };
  if (parsed.w < 1024 || parsed.h < 1024) return { ok: false, status: 'PROVIDER_INCAPABLE', reason: `Requested size ${size} is below the 1024x1024 contract minimum.` };
  if (parsed.w !== parsed.h) return { ok: false, status: 'PROVIDER_INCAPABLE', reason: `Requested size ${size} is not square.` };
  return { ok: true };
}

/**
 * Safely ingest produced bytes for one character:
 *   temp write -> EXISTING validator -> atomic rename. Never partially writes the final asset.
 */
export async function ingestCharacterBytes(tag: string, bytes: Buffer, options: { outputDir: string; overwrite?: boolean }): Promise<CharacterGenerationOutcome> {
  const filename = canonicalCharacterFilename(tag);
  if (!filename) return { ok: false, tag, status: 'INVALID_OUTPUT', reason: `Unsafe/empty character tag ${JSON.stringify(tag)}.` };
  const finalPath = characterAssetPath(tag, options.outputDir);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;

  // Preserve an existing VALID asset unless overwrite is explicit.
  if (!options.overwrite) {
    const existing = await getCharacterAsset(tag, { charactersDir: options.outputDir });
    if (existing.state === 'CHARACTER_ASSET_HIT') return { ok: true, tag, status: 'PRESERVED', filename };
  }

  try {
    await fsp.mkdir(options.outputDir, { recursive: true });
    await fsp.writeFile(tmpPath, bytes);
    // Validate the TEMP file with the EXISTING contract (no duplicated rules).
    const validated = await validateTempFile(tmpPath);
    if (!validated.ok) {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      return { ok: false, tag, status: 'INVALID_OUTPUT', reason: validated.reason };
    }
    await fsp.rename(tmpPath, finalPath); // atomic promote
    return { ok: true, tag, status: 'INSTALLED', filename, path: finalPath, width: validated.width, height: validated.height, sha256: validated.sha256 };
  } catch (e: any) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    return { ok: false, tag, status: 'WRITE_FAILED', reason: `Atomic installation failed: ${String(e?.message ?? e)}` };
  }
}

/** Validate a temp character file by the existing contract. Returns dimensions + sha256. */
export async function validateTempFile(tmpPath: string): Promise<{ ok: true; width: number; height: number; sha256: string } | { ok: false; reason: string }> {
  const crypto = await import('node:crypto');
  const { parsePng, parseWebp, meetsCharacterMinimum, isCharacterAspectAcceptable, extensionOf } = await import('./characterAsset.js');
  let buf: Buffer;
  try { buf = await fsp.readFile(tmpPath); } catch (e: any) { return { ok: false, reason: `Temp file could not be read: ${String(e?.message ?? e)}` }; }
  // The temp name keeps a `.tmp-<pid>-<ts>` suffix; infer format from the ORIGINAL extension.
  const ext = extensionOf(tmpPath.replace(/\.tmp-\d+-\d+$/, ''));
  if (ext !== '.png' && ext !== '.webp') return { ok: false, reason: `Unsupported character format "${ext}" (expected .png or .webp).` };
  const parsed = ext === '.png' ? parsePng(buf) : parseWebp(buf);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (!meetsCharacterMinimum(parsed.width, parsed.height)) return { ok: false, reason: `Resolution ${parsed.width}x${parsed.height} is below the required minimum.` };
  if (!isCharacterAspectAcceptable(parsed.width, parsed.height)) return { ok: false, reason: `Aspect ${parsed.width}x${parsed.height} is not usable for a cutout.` };
  if (!parsed.hasAlpha) return { ok: false, reason: `Image ${parsed.width}x${parsed.height} has no usable alpha channel (opaque images are not cutouts).` };
  return { ok: true, width: parsed.width, height: parsed.height, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

/**
 * Generate + safely ingest the four canonical characters.
 * Provider-agnostic; dry-run prints the plan and touches nothing.
 */
export async function generateCharacterAssets(options: GenerateCharacterOptions): Promise<CharacterGenerationOutcome[]> {
  const size = options.size ?? DEFAULT_SIZE;
  const transparent = options.transparentBackground !== false;
  // Prefer PROJECT-DERIVED specs when a pipeline is supplied (canonical production path); fall
  // back to the built-in example cast only when no pipeline is given. Fail closed if the
  // pipeline cannot yield valid specs — never silently generate the wrong characters.
  let baseSpecs: readonly CharacterGenerationSpec[] = CHARACTER_GENERATION_SPECS;
  if (options.pipeline !== undefined) {
    const derived = characterSpecsFromPipeline(options.pipeline);
    if (!derived.ok) {
      return [{ ok: false, tag: '(pipeline)', status: 'PROVIDER_UNAVAILABLE', reason: `Character specs could not be derived from the pipeline: ${derived.reason}` }];
    }
    baseSpecs = derived.specs;
  }
  const specs = baseSpecs.filter((s) => !options.only || options.only.includes(s.tag));

  if (options.dryRun) {
    return specs.map((s) => ({ ok: true, tag: s.tag, status: 'PLANNED' as const, filename: canonicalCharacterFilename(s.tag) as string }));
  }

  const capable = assertProviderCapable(options.provider, size, transparent);
  if (!capable.ok) return specs.map((s) => ({ ok: false, tag: s.tag, status: capable.status, reason: capable.reason }));

  const out: CharacterGenerationOutcome[] = [];
  for (const spec of specs) {
    let produced: { bytes: Buffer; format: string };
    try {
      produced = await options.provider!.generate(spec, { size, transparentBackground: transparent, model: options.model });
    } catch (e: any) {
      out.push({ ok: false, tag: spec.tag, status: 'INVALID_OUTPUT', reason: `Provider failed for ${spec.tag}: ${String(e?.message ?? e)}` });
      continue;
    }
    if (String(produced?.format).toLowerCase() !== 'png') {
      out.push({ ok: false, tag: spec.tag, status: 'INVALID_OUTPUT', reason: `Provider returned "${produced?.format}" (PNG required; no JPEG fallback).` });
      continue;
    }
    if (!Buffer.isBuffer(produced.bytes) || produced.bytes.length === 0) {
      out.push({ ok: false, tag: spec.tag, status: 'INVALID_OUTPUT', reason: 'Provider returned no image bytes.' });
      continue;
    }
    out.push(await ingestCharacterBytes(spec.tag, produced.bytes, { outputDir: options.outputDir, overwrite: options.overwrite === true }));
  }
  return out;
}
