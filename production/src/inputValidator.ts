/**
 * External input validator (STEP-8DM).
 *
 * Validates an entire project's external input tree WITHOUT modifying it. Every check is
 * read-only, deterministic, fail-closed and path-safe. Validation is complete: one invalid
 * asset never hides another.
 *
 * Reuses the existing contracts (no duplicated rules):
 *   · assetCache.ts         → background validation
 *   · characterAsset.ts     → character validation (alpha, ≥1024², square-ish)
 *   · narrationDuration.ts  → narration discovery + ffprobe duration
 *   · videoClip.ts          → supplied clip validation
 *   · bgm.ts                → BGM licence policy (CC0 / CC-BY only)
 *   · videoClip.ts          → branding intro/logo media checks
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getCharacterAsset, type CharacterAssetState } from './characterAsset.js';
import { safeTagStem, readPngDimensions, isAspectCompatible, meetsMinimumResolution, MIN_BACKGROUND_WIDTH, MIN_BACKGROUND_HEIGHT } from './assetCache.js';
import { mapNarrationFiles, resolveSceneNarrationDuration, SUPPORTED_AUDIO_EXTENSIONS } from './narrationDuration.js';
import { validateVideoClip } from './videoClip.js';
import { evaluateLicense } from './bgm.js';
import { isPixabaySidecar, validatePixabayBgm, PIXABAY_LICENSE } from './pixabayBgm.js';
import { classifyNarration, requiresNarrationAudio } from './sceneCompositionPlanner.js';

export const INPUT_VALIDATOR_SCHEMA_VERSION = 1;
/** Contract version recorded in manifests; must match to accept a supplied manifest. */
export const VALIDATOR_CONTRACT_VERSION = '8dm-1';

/** Canonical input categories. */
export const INPUT_CATEGORY_DIRS = ['backgrounds', 'characters', 'narration', 'flow-clips', 'music', 'branding'] as const;
export type InputCategoryDir = (typeof INPUT_CATEGORY_DIRS)[number];

/** Explicit asset states — never ambiguous booleans. */
export type InputState = 'MISSING' | 'VALID' | 'INVALID' | 'UNSUPPORTED' | 'LICENSE_INVALID' | 'DUPLICATE' | 'PATH_INVALID';

export interface InputAssetResult {
  state: InputState;
  /** Logical identity (tag or scene number). */
  id: string;
  /** Relative path inside the input root, or null. */
  relativePath: string | null;
  sha256?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  license?: { raw: string; kind: string; attributionRequired: boolean; attribution?: string };
  /** Non-blocking advisories surfaced alongside a VALID result (e.g. Pixabay Content ID). */
  notes?: string[];
  reason?: string;
}

export interface InputValidationReport {
  schemaVersion: number;
  projectId: string;
  inputRootExists: boolean;
  backgrounds: InputAssetResult[];
  characters: InputAssetResult[];
  narration: InputAssetResult[];
  flowClips: InputAssetResult[];
  music: InputAssetResult[];
  branding: InputAssetResult[];
  counts: {
    backgrounds: { valid: number; total: number };
    characters: { valid: number; total: number };
    narration: { valid: number; total: number };
    flowClips: { valid: number; total: number };
    music: { valid: number; total: number };
    branding: { valid: number; total: number };
  };
  issues: Array<{ category: InputCategoryDir; id: string; state: InputState; reason: string }>;
}

export interface ValidateOptions {
  projectId: string;
  /** Absolute input root. */
  inputRoot: string;
  /** Tags/scenes required by the real pipeline. */
  requiredBackgrounds: string[];
  requiredCharacters: string[];
  narrationScenes: number[];
  sceneNumbers: number[];
  /** Clips expected for these scenes (dialogue scenes in the current architecture). */
  requiredClips: number[];
  ffprobePath?: string;
}

const sha256 = async (file: string): Promise<string | undefined> => {
  try { const b = await fsp.readFile(file); return (await import('node:crypto')).createHash('sha256').update(b).digest('hex'); }
  catch { return undefined; }
};

/** Reject any relative path that would escape the input root. */
export function safeInputPath(inputRoot: string, relative: string): string {
  const root = path.resolve(inputRoot);
  const rel = String(relative ?? '').trim();
  if (!rel) throw new Error('Relative path was empty.');
  if (rel.includes('\0')) throw new Error('Relative path contains a null byte.');
  if (/^[A-Za-z]:/.test(rel) || /^(\\\\|\/\/)/.test(rel) || path.isAbsolute(rel)) throw new Error(`Path must be relative: ${rel}.`);
  const resolved = path.resolve(root, rel);
  const diff = path.relative(root, resolved);
  if (!diff || diff.startsWith('..') || path.isAbsolute(diff)) throw new Error(`Path escapes the input root: ${rel}.`);
  return resolved;
}

const rel = (p: string | null) => (p ? p.replace(/\\/g, '/') : null);

// ---------------------------------------------------------------------------------------
// Category validators
// ---------------------------------------------------------------------------------------

export async function validateBackgroundInputs(opts: ValidateOptions): Promise<InputAssetResult[]> {
  const dir = path.join(opts.inputRoot, 'backgrounds');
  const out: InputAssetResult[] = [];
  const seen = new Map<string, string[]>();
  const files = await fsp.readdir(dir).catch(() => [] as string[]);
  // Detect duplicate files mapping to the same tag stem.
  for (const f of files) {
    const stem = safeTagStem(f.replace(/\.[A-Za-z0-9]+$/, ''));
    if (!stem) continue;
    const list = seen.get(stem) ?? []; list.push(f); seen.set(stem, list);
  }
  for (const tag of opts.requiredBackgrounds) {
    const stem = safeTagStem(tag);
    if (!stem) { out.push({ state: 'PATH_INVALID', id: tag, relativePath: null, reason: `Unsafe background tag ${tag}.` }); continue; }
    const dup = (seen.get(stem) ?? []).filter((f) => /\.(png|webp)$/i.test(f));
    if (dup.length > 1) { out.push({ state: 'DUPLICATE', id: tag, relativePath: `backgrounds/${dup[0]}`, reason: `Multiple background files for ${tag}: ${dup.join(', ')}.` }); continue; }
    const file = path.join(dir, `${stem}.png`);
    let stat;
    try { stat = await fsp.stat(file); } catch { out.push({ state: 'MISSING', id: tag, relativePath: `backgrounds/${stem}.png`, reason: 'Background file is not supplied.' }); continue; }
    if (!stat.isFile() || stat.size <= 0) { out.push({ state: 'INVALID', id: tag, relativePath: `backgrounds/${stem}.png`, reason: 'Background file is empty or not a regular file.' }); continue; }
    const buf = await fsp.readFile(file);
    const dims = readPngDimensions(buf);
    if (!dims.ok) { out.push({ state: 'INVALID', id: tag, relativePath: `backgrounds/${stem}.png`, reason: dims.reason }); continue; }
    if (!meetsMinimumResolution(dims.width, dims.height)) { out.push({ state: 'INVALID', id: tag, relativePath: `backgrounds/${stem}.png`, width: dims.width, height: dims.height, reason: `Resolution ${dims.width}x${dims.height} below the ${MIN_BACKGROUND_WIDTH}x${MIN_BACKGROUND_HEIGHT} minimum.` }); continue; }
    if (!isAspectCompatible(dims.width, dims.height)) { out.push({ state: 'INVALID', id: tag, relativePath: `backgrounds/${stem}.png`, width: dims.width, height: dims.height, reason: `Aspect ${dims.width}x${dims.height} is not 16:9-compatible.` }); continue; }
    out.push({ state: 'VALID', id: tag, relativePath: `backgrounds/${stem}.png`, width: dims.width, height: dims.height, sha256: await sha256(file) });
  }
  return out;
}

export async function validateCharacterInputs(opts: ValidateOptions): Promise<InputAssetResult[]> {
  const dir = path.join(opts.inputRoot, 'characters');
  const out: InputAssetResult[] = [];
  for (const tag of opts.requiredCharacters) {
    // Count candidate files to detect ambiguity (png + webp).
    const stem = safeTagStem(tag);
    if (!stem) { out.push({ state: 'PATH_INVALID', id: tag, relativePath: null, reason: `Unsafe character tag ${tag}.` }); continue; }
    const cands = ['.png', '.webp'].filter((e) => true).map((e) => `${stem}${e}`);
    const present = (await Promise.all(cands.map(async (f) => ((await fsp.stat(path.join(dir, f)).then((s) => s.isFile()).catch(() => false)) ? f : null)))).filter(Boolean) as string[];
    if (present.length > 1) { out.push({ state: 'DUPLICATE', id: tag, relativePath: `characters/${present[0]}`, reason: `Multiple character files for ${tag}: ${present.join(', ')}.` }); continue; }
    const r = await getCharacterAsset(tag, { charactersDir: dir });
    if (r.state === 'CHARACTER_ASSET_HIT') {
      out.push({ state: 'VALID', id: tag, relativePath: rel(path.relative(path.resolve(opts.inputRoot), r.filePath)), width: r.record.width, height: r.record.height, sha256: await sha256(r.filePath) });
      continue;
    }
    const map: Record<string, InputState> = {
      CHARACTER_ASSET_MISSING: 'MISSING', CHARACTER_ASSET_INVALID: 'INVALID',
      CHARACTER_ASSET_NO_ALPHA: 'INVALID', CHARACTER_ASSET_UNSUPPORTED: 'UNSUPPORTED',
    };
    out.push({ state: map[r.state as CharacterAssetState] ?? 'INVALID', id: tag, relativePath: rel(path.relative(path.resolve(opts.inputRoot), r.filePath)), reason: (r as any).reason });
  }
  return out;
}

export async function validateNarrationInputs(opts: ValidateOptions): Promise<InputAssetResult[]> {
  const dir = path.join(opts.inputRoot, 'narration');
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  const { byScene, ambiguous } = mapNarrationFiles(names);
  const out: InputAssetResult[] = [];
  for (const n of opts.narrationScenes) {
    if (ambiguous.has(n)) { out.push({ state: 'DUPLICATE', id: `narration-${String(n).padStart(4, '0')}`, relativePath: null, reason: `Multiple narration files for scene ${n}: ${JSON.stringify(ambiguous.get(n))}.` }); continue; }
    if (!byScene.has(n)) { out.push({ state: 'MISSING', id: `narration-${String(n).padStart(4, '0')}`, relativePath: null, reason: `No narration-#### file for scene ${n}.` }); continue; }
    const resolved = await resolveSceneNarrationDuration(n, dir);
    if (!resolved.ok) {
      const st: InputState = resolved.reason === 'MISSING_AUDIO' ? 'MISSING' : resolved.reason === 'AMBIGUOUS_MAPPING' ? 'DUPLICATE' : 'INVALID';
      out.push({ state: st, id: `narration-${String(n).padStart(4, '0')}`, relativePath: rel(path.relative(path.resolve(opts.inputRoot), String(byScene.get(n)))), reason: resolved.detail ?? resolved.reason });
      continue;
    }
    out.push({ state: 'VALID', id: `narration-${String(n).padStart(4, '0')}`, relativePath: `narration/${byScene.get(n)}`, durationSeconds: resolved.durationSeconds, sha256: await sha256(resolved.audioPath) });
  }
  return out;
}

export async function validateFlowClipInputs(opts: ValidateOptions): Promise<InputAssetResult[]> {
  const dir = path.join(opts.inputRoot, 'flow-clips');
  const out: InputAssetResult[] = [];
  for (const n of opts.requiredClips) {
    const id = `scene-${String(n).padStart(4, '0')}`;
    const mp4 = path.join(dir, `${id}.mp4`);
    const m4v = path.join(dir, `${id}.m4v`);
    const hasMp4 = await fsp.stat(mp4).then((s) => s.isFile()).catch(() => false);
    const hasM4v = await fsp.stat(m4v).then((s) => s.isFile()).catch(() => false);
    if (hasMp4 && hasM4v) { out.push({ state: 'DUPLICATE', id, relativePath: `flow-clips/${id}.mp4`, reason: `Both ${id}.mp4 and ${id}.m4v exist.` }); continue; }
    const file = hasMp4 ? mp4 : hasM4v ? m4v : mp4;
    const r = await validateVideoClip(file, { ffprobePath: opts.ffprobePath });
    if (r.state === 'VALID') { out.push({ state: 'VALID', id, relativePath: `flow-clips/${path.basename(file)}`, durationSeconds: r.durationSeconds, sha256: r.sha256 }); continue; }
    const st: InputState = r.state === 'MISSING' ? 'MISSING' : r.state === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'INVALID';
    out.push({ state: st, id, relativePath: `flow-clips/${id}.mp4`, reason: r.reason });
  }
  return out;
}

/** BGM licence policy: CC0 or CC-BY only; NC/ND/unknown rejected. */
export async function validateMusicInputs(opts: ValidateOptions): Promise<InputAssetResult[]> {
  const dir = path.join(opts.inputRoot, 'music');
  const candidates = ['background-music.mp3', 'background-music.wav', 'background-music.m4a', 'background-music.aac', 'background-music.ogg'];
  const present: string[] = [];
  for (const c of candidates) if (await fsp.stat(path.join(dir, c)).then((s) => s.isFile()).catch(() => false)) present.push(c);
  if (present.length === 0) return [{ state: 'MISSING', id: 'background-music', relativePath: 'music/background-music.mp3', reason: 'No BGM file supplied.' }];
  if (present.length > 1) return [{ state: 'DUPLICATE', id: 'background-music', relativePath: `music/${present[0]}`, reason: `Multiple BGM files: ${present.join(', ')}.` }];
  const file = path.join(dir, present[0]);
  // Licence provenance is REQUIRED and must come from a sidecar (no network, no inference).
  const metaFile = path.join(dir, 'background-music.license.json');
  let meta: any = null;
  try { meta = JSON.parse(await fsp.readFile(metaFile, 'utf8')); } catch { meta = null; }
  if (!meta || typeof meta !== 'object' || typeof meta.license !== 'string') {
    return [{ state: 'LICENSE_INVALID', id: 'background-music', relativePath: `music/${present[0]}`, reason: 'Missing or unreadable BGM licence provenance (music/background-music.license.json).' }];
  }
  const evaln = evaluateLicense(String(meta.license));

  // PIXABAY INDEPENDENT BRANCH (rule 15: an arbitrary provider never reaches this path).
  // A sidecar that explicitly declares `provider: "pixabay"` is validated by the dedicated,
  // fail-closed Pixabay contract instead of the CC0/CC-BY policy, whose accepted set is
  // deliberately NOT broadened. Everything else falls through to the existing policy unchanged.
  if (isPixabaySidecar(meta)) {
    const pix = await validatePixabayBgm(opts.inputRoot, { ffprobePath: opts.ffprobePath });
    if (!pix.ok) {
      return [{ state: 'LICENSE_INVALID', id: 'background-music', relativePath: `music/${present[0]}`, license: { raw: String(meta.license), kind: 'pixabay', attributionRequired: false }, reason: `Pixabay BGM provenance rejected [${pix.code}]: ${pix.reason}` }];
    }
    const out: InputAssetResult = {
      state: 'VALID', id: 'background-music', relativePath: `music/${present[0]}`,
      license: { raw: PIXABAY_LICENSE, kind: 'pixabay', attributionRequired: false, attribution: pix.metadata.attribution_text ?? undefined },
      sha256: pix.metadata.sha256,
    };
    // 12/13: Content-ID-registered is SURFACED, never rejected, and never described as
    // "Content-ID-free" — Pixabay licensing says nothing about YouTube Content ID.
    if (pix.contentIdRegistered) {
      out.notes = ['This Pixabay track is declared Content-ID-registered; it is accepted, but you may prefer a different track. Pixabay licensing does not clear Content ID.'];
    }
    return [out];
  }

  if (!evaln.allowed) return [{ state: 'LICENSE_INVALID', id: 'background-music', relativePath: `music/${present[0]}`, license: { raw: evaln.raw, kind: evaln.kind, attributionRequired: evaln.attributionRequired }, reason: `BGM licence not permitted: ${evaln.reason}` }];
  if (evaln.attributionRequired && (typeof meta.attribution !== 'string' || !meta.attribution.trim())) {
    return [{ state: 'LICENSE_INVALID', id: 'background-music', relativePath: `music/${present[0]}`, license: { raw: evaln.raw, kind: evaln.kind, attributionRequired: true }, reason: 'CC-BY requires attribution metadata.' }];
  }
  return [{ state: 'VALID', id: 'background-music', relativePath: `music/${present[0]}`, license: { raw: evaln.raw, kind: evaln.kind, attributionRequired: evaln.attributionRequired, attribution: meta.attribution }, sha256: await sha256(file) }];
}

/** Branding: channel intro video + logo image, required by addTitle.ts. */
export async function validateBrandingInputs(opts: ValidateOptions): Promise<InputAssetResult[]> {
  const dir = path.join(opts.inputRoot, 'branding');
  const out: InputAssetResult[] = [];
  const intro = path.join(dir, 'channel-intro.mp4');
  const introClip = await validateVideoClip(intro, { ffprobePath: opts.ffprobePath });
  out.push(introClip.state === 'VALID'
    ? { state: 'VALID', id: 'channel-intro', relativePath: 'branding/channel-intro.mp4', durationSeconds: introClip.durationSeconds, sha256: introClip.sha256 }
    : { state: introClip.state === 'MISSING' ? 'MISSING' : 'INVALID', id: 'channel-intro', relativePath: 'branding/channel-intro.mp4', reason: introClip.reason });

  const logo = path.join(dir, 'channel-logo.png');
  let stat;
  try { stat = await fsp.stat(logo); } catch { out.push({ state: 'MISSING', id: 'channel-logo', relativePath: 'branding/channel-logo.png', reason: 'Channel logo is not supplied.' }); return out; }
  if (!stat.isFile() || stat.size <= 0) { out.push({ state: 'INVALID', id: 'channel-logo', relativePath: 'branding/channel-logo.png', reason: 'Logo file is empty or not a regular file.' }); return out; }
  const buf = await fsp.readFile(logo);
  const dims = readPngDimensions(buf);
  if (!dims.ok) { out.push({ state: 'INVALID', id: 'channel-logo', relativePath: 'branding/channel-logo.png', reason: dims.reason }); return out; }
  out.push({ state: 'VALID', id: 'channel-logo', relativePath: 'branding/channel-logo.png', width: dims.width, height: dims.height, sha256: await sha256(logo) });
  return out;
}

// ---------------------------------------------------------------------------------------
// Whole-project validation
// ---------------------------------------------------------------------------------------

export async function validateProjectInputs(opts: ValidateOptions): Promise<InputValidationReport> {
  const root = path.resolve(opts.inputRoot);
  const inputRootExists = await fsp.stat(root).then((s) => s.isDirectory()).catch(() => false);

  const [backgrounds, characters, narration, flowClips, music, branding] = await Promise.all([
    validateBackgroundInputs(opts), validateCharacterInputs(opts), validateNarrationInputs(opts),
    validateFlowClipInputs(opts), validateMusicInputs(opts), validateBrandingInputs(opts),
  ]);

  const cnt = (a: InputAssetResult[]) => ({ valid: a.filter((x) => x.state === 'VALID').length, total: a.length });
  const issues: InputValidationReport['issues'] = [];
  for (const [category, arr] of Object.entries({ backgrounds, characters, narration, 'flow-clips': flowClips, music, branding })) {
    for (const a of arr as InputAssetResult[]) {
      if (a.state !== 'VALID') issues.push({ category: category as InputCategoryDir, id: a.id, state: a.state, reason: a.reason ?? '' });
    }
  }

  return {
    schemaVersion: INPUT_VALIDATOR_SCHEMA_VERSION,
    projectId: opts.projectId,
    inputRootExists,
    backgrounds, characters, narration, flowClips, music, branding,
    counts: { backgrounds: cnt(backgrounds), characters: cnt(characters), narration: cnt(narration), flowClips: cnt(flowClips), music: cnt(music), branding: cnt(branding) },
    issues,
  };
}

/** Derive the required-input sets from a real pipeline (never hardcoded). */
export function deriveRequiredInputs(pipeline: any, _manifestScenes?: number[]): {
  backgrounds: string[]; characters: string[]; narrationScenes: number[]; sceneNumbers: number[]; requiredClips: number[];
} {
  const scenes = Array.isArray(pipeline?.scenes) ? pipeline.scenes : [];
  const backgrounds = [...new Set([...(pipeline?.backgrounds ?? []).map((b: any) => String(b.tag)), ...scenes.map((s: any) => String(s?.background_tag ?? ''))])].filter(Boolean).sort() as string[];
  const characters = [...new Set([...(pipeline?.characters ?? []).map((c: any) => String(c.tag)), ...scenes.flatMap((s: any) => s?.character_tags ?? [])])].filter(Boolean).sort() as string[];
  const narrationScenes = scenes.filter((s: any) => requiresNarrationAudio(s, classifyNarration(s))).map((s: any) => Number(s.scene_number)).sort((a: number, b: number) => a - b);
  const sceneNumbers = scenes.map((s: any) => Number(s.scene_number)).sort((a: number, b: number) => a - b);
  // Pure-dialogue scenes require a supplied Flow clip; MIXED scenes need narration (not a clip).
  const requiredClips = scenes.filter((s: any) => classifyNarration(s) === 'DIALOGUE').map((s: any) => Number(s.scene_number)).sort((a: number, b: number) => a - b);
  return { backgrounds, characters, narrationScenes, sceneNumbers, requiredClips };
}
