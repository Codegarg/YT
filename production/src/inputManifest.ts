/**
 * External input contract + secure manifest handling (STEP-8DE).
 *
 * The project input root `production/inputs/<project-id>/` is the EXTERNAL handoff boundary:
 * a human (or future automation) places characters/narration/flow-clips/backgrounds/music
 * there and the engine validates them. The FILESYSTEM is the physical truth; `manifest.json`
 * is provenance/metadata only and is NEVER trusted for validation, hashes or dimensions.
 *
 * Nothing here renders, downloads, contacts Flow, or writes to production outputs/assets.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeTagStem } from './assetCache.js';
import { SUPPORTED_AUDIO_EXTENSIONS } from './narrationDuration.js';

export const INPUT_SCHEMA_VERSION = 1;

/** Category sub-directories of the input root. */
export const INPUT_CATEGORIES = ['characters', 'narration', 'flow-clips', 'backgrounds', 'music'] as const;
export type InputCategory = (typeof INPUT_CATEGORIES)[number];

export const ASSET_TYPES = ['character', 'narration', 'flow-clip', 'background', 'music'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export const ASSET_SOURCES = ['human-supplied', 'human-flow-export', 'future-automation'] as const;
export type AssetSource = (typeof ASSET_SOURCES)[number];

export const MANIFEST_VALIDATION_STATES = ['VALID', 'MISSING', 'INVALID', 'NO_ALPHA', 'AMBIGUOUS', 'UNSUPPORTED'] as const;
export type ManifestValidationState = (typeof MANIFEST_VALIDATION_STATES)[number];

/** A project id is an identifier, never a path. */
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const DRIVE_PREFIX = /^[A-Za-z]:/;
const UNC_PREFIX = /^(\\\\|\/\/)/;

/**
 * Validate a project id. Rejects absolute paths, drive prefixes, UNC paths, separators,
 * `..`, null bytes, and empty/oversized values. Throws (configuration error).
 */
export function assertSafeProjectId(projectId: unknown): string {
  const id = String(projectId ?? '').trim();
  if (!id) throw new Error('Project id was empty.');
  if (id.length > 120) throw new Error(`Project id is too long (${id.length} chars).`);
  if (id.includes('\0')) throw new Error('Project id contains a null byte.');
  if (UNC_PREFIX.test(id)) throw new Error(`Project id must not be a UNC path: ${id}.`);
  if (DRIVE_PREFIX.test(id)) throw new Error(`Project id must not contain a drive prefix: ${id}.`);
  if (id.includes('/') || id.includes('\\')) throw new Error(`Project id must not contain path separators: ${id}.`);
  if (id === '.' || id === '..' || id.includes('..')) throw new Error(`Project id must not contain traversal: ${id}.`);
  if (!PROJECT_ID_PATTERN.test(id)) throw new Error(`Project id "${id}" is not a safe identifier.`);
  return id;
}

/** Absolute input root for a project. `inputsRoot` defaults to `production/inputs`. */
export function projectInputRoot(projectId: unknown, inputsRoot = 'inputs'): string {
  const id = assertSafeProjectId(projectId);
  return path.resolve(String(inputsRoot), id);
}

/** Absolute path of one input category directory. */
export function inputCategoryDir(projectId: unknown, category: InputCategory, inputsRoot = 'inputs'): string {
  if (!INPUT_CATEGORIES.includes(category)) throw new Error(`Unknown input category "${String(category)}".`);
  return path.join(projectInputRoot(projectId, inputsRoot), category);
}

/** Absolute path of the input manifest. */
export function inputManifestPath(projectId: unknown, inputsRoot = 'inputs'): string {
  return path.join(projectInputRoot(projectId, inputsRoot), 'manifest.json');
}

/**
 * Resolve a RELATIVE manifest path against the input root, refusing anything that is not a
 * direct child (or a child of a known category). Never follows absolute/traversal paths.
 */
export function resolveManifestAssetPath(relativePath: unknown, projectId: unknown, inputsRoot = 'inputs'): string {
  const rel = String(relativePath ?? '').trim();
  if (!rel) throw new Error('Manifest relative_path was empty.');
  if (rel.includes('\0')) throw new Error('Manifest relative_path contains a null byte.');
  if (UNC_PREFIX.test(rel) || DRIVE_PREFIX.test(rel)) throw new Error(`Manifest relative_path must not be absolute: ${rel}.`);
  if (path.isAbsolute(rel)) throw new Error(`Manifest relative_path must be relative: ${rel}.`);
  const root = projectInputRoot(projectId, inputsRoot);
  const resolved = path.resolve(root, rel);
  const relToRoot = path.relative(root, resolved);
  if (!relToRoot || relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    throw new Error(`Manifest relative_path escapes the input root: ${rel}.`);
  }
  return resolved;
}

/** List a category directory. Returns [] when the directory does not exist. */
export async function listCategory(dir: string): Promise<string[]> {
  try { return await fsp.readdir(dir); } catch { return []; }
}

// ---------------------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------------------

export interface ManifestAsset {
  type: AssetType;
  tag: string | null;
  scene_number: number | null;
  relative_path: string;
  source: AssetSource;
  validation: ManifestValidationState;
  sha256: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  streams: unknown;
  updated_at: string | null;
  [k: string]: unknown; // harmless extra metadata tolerated
}

export interface InputManifest {
  schema_version: number;
  project_id: string;
  assets: ManifestAsset[];
}

export type ManifestCheck = { ok: true; manifest: InputManifest } | { ok: false; reason: string };

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * Validate a parsed manifest object structurally. Does NOT verify the filesystem and does
 * NOT trust supplied validation/sha/dimensions.
 */
export function validateManifest(raw: unknown, expectedProjectId: string, inputsRoot = 'inputs'): ManifestCheck {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'Manifest is not a JSON object.' };
  const m = raw as any;
  if (m.schema_version !== INPUT_SCHEMA_VERSION) return { ok: false, reason: `Unsupported schema_version ${String(m.schema_version)} (expected ${INPUT_SCHEMA_VERSION}).` };
  if (String(m.project_id) !== String(expectedProjectId)) return { ok: false, reason: `Manifest project_id "${String(m.project_id)}" does not match expected "${String(expectedProjectId)}".` };
  try { assertSafeProjectId(expectedProjectId); } catch (e: any) { return { ok: false, reason: String(e?.message ?? e) }; }
  if (!Array.isArray(m.assets)) return { ok: false, reason: 'Manifest assets must be an array.' };

  const seenLogical = new Set<string>();
  const seenScenes = new Set<string>();
  const assets: ManifestAsset[] = [];
  for (let i = 0; i < m.assets.length; i++) {
    const a = m.assets[i];
    if (!a || typeof a !== 'object') return { ok: false, reason: `Asset ${i} is not an object.` };
    if (!ASSET_TYPES.includes(a.type)) return { ok: false, reason: `Asset ${i} has an unknown type "${String(a.type)}".` };
    if (!ASSET_SOURCES.includes(a.source)) return { ok: false, reason: `Asset ${i} has an unknown source "${String(a.source)}".` };
    if (a.validation !== undefined && !MANIFEST_VALIDATION_STATES.includes(a.validation)) return { ok: false, reason: `Asset ${i} has an unknown validation state "${String(a.validation)}".` };
    if (a.scene_number !== null && a.scene_number !== undefined && (!isInt(a.scene_number) || a.scene_number <= 0)) return { ok: false, reason: `Asset ${i} has an invalid scene_number "${String(a.scene_number)}".` };
    if (typeof a.relative_path !== 'string' || !a.relative_path.trim()) return { ok: false, reason: `Asset ${i} is missing relative_path.` };
    try { resolveManifestAssetPath(a.relative_path, expectedProjectId, inputsRoot); }
    catch (e: any) { return { ok: false, reason: `Asset ${i}: ${String(e?.message ?? e)}` }; }

    const logical = `${a.type}:${a.tag ?? ''}:${a.scene_number ?? ''}`;
    if (seenLogical.has(logical)) return { ok: false, reason: `Duplicate logical asset ${logical}.` };
    seenLogical.add(logical);

    if (a.type === 'character') {
      if (typeof a.tag !== 'string' || !a.tag.trim()) return { ok: false, reason: `Character asset ${i} is missing a tag.` };
    }
    if (a.type === 'flow-clip' || a.type === 'narration') {
      if (!isInt(a.scene_number) || a.scene_number <= 0) return { ok: false, reason: `${a.type} asset ${i} requires a positive scene_number.` };
      if (seenScenes.has(`${a.type}:${a.scene_number}`)) return { ok: false, reason: `Duplicate ${a.type} for scene ${a.scene_number}.` };
      seenScenes.add(`${a.type}:${a.scene_number}`);
    }
    if (a.type === 'background' && (typeof a.tag !== 'string' || !a.tag.trim())) return { ok: false, reason: `Background asset ${i} is missing a tag.` };

    assets.push({
      type: a.type, tag: a.tag ?? null, scene_number: a.scene_number ?? null, relative_path: a.relative_path,
      source: a.source, validation: a.validation ?? 'MISSING', sha256: a.sha256 ?? null,
      width: a.width ?? null, height: a.height ?? null, durationSeconds: a.durationSeconds ?? null,
      streams: a.streams ?? null, updated_at: a.updated_at ?? null, ...(typeof a === 'object' ? a : {}),
    });
  }
  return { ok: true, manifest: { schema_version: INPUT_SCHEMA_VERSION, project_id: String(m.project_id), assets } };
}

/** Read + structurally validate a manifest. A missing manifest is NOT an error (returns null). */
export async function loadManifest(projectId: string, inputsRoot = 'inputs'): Promise<{ ok: true; manifest: InputManifest | null } | { ok: false; reason: string }> {
  const file = inputManifestPath(projectId, inputsRoot);
  let raw: string;
  try { raw = await fsp.readFile(file, 'utf8'); } catch { return { ok: true, manifest: null }; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, reason: 'Manifest is malformed JSON.' }; }
  const checked = validateManifest(parsed, projectId, inputsRoot);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  return { ok: true, manifest: checked.manifest };
}

// ---------------------------------------------------------------------------------------
// Discovery (filesystem is the physical truth)
// ---------------------------------------------------------------------------------------

export interface DiscoveredInputs {
  characters: string[];
  narration: string[];
  flowClips: string[];
  backgrounds: string[];
  music: string[];
  unexpected: string[];
  rootExists: boolean;
}

const isCharFile = (n: string) => /\.(png|webp)$/i.test(n);
const isAudioFile = (n: string) => SUPPORTED_AUDIO_EXTENSIONS.some((e) => n.toLowerCase().endsWith(e));
const isNarrationFile = (n: string) => /^narration-\d{4}\.[a-z0-9]+$/i.test(n) && isAudioFile(n);
const isClipFile = (n: string) => /^scene-\d{4}\.(mp4|m4v)$/i.test(n);
const isBackgroundFile = (n: string) => /\.png$/i.test(n);

/** Discover category contents. Unexpected files are reported, never silently consumed. */
export async function discoverInputAssets(projectId: string, inputsRoot = 'inputs'): Promise<DiscoveredInputs> {
  const root = projectInputRoot(projectId, inputsRoot);
  const rootExists = await fsp.stat(root).then((s) => s.isDirectory()).catch(() => false);
  const [chars, narr, clips, bgs, music] = await Promise.all([
    listCategory(inputCategoryDir(projectId, 'characters', inputsRoot)),
    listCategory(inputCategoryDir(projectId, 'narration', inputsRoot)),
    listCategory(inputCategoryDir(projectId, 'flow-clips', inputsRoot)),
    listCategory(inputCategoryDir(projectId, 'backgrounds', inputsRoot)),
    listCategory(inputCategoryDir(projectId, 'music', inputsRoot)),
  ]);
  const unexpected: string[] = [
    ...chars.filter((n) => !isCharFile(n)).map((n) => `characters/${n}`),
    ...narr.filter((n) => !isNarrationFile(n)).map((n) => `narration/${n}`),
    ...clips.filter((n) => !isClipFile(n)).map((n) => `flow-clips/${n}`),
    ...bgs.filter((n) => !isBackgroundFile(n)).map((n) => `backgrounds/${n}`),
    ...music.filter((n) => !isAudioFile(n)).map((n) => `music/${n}`),
  ];
  return {
    characters: chars.filter(isCharFile).sort(),
    narration: narr.filter(isNarrationFile).sort(),
    flowClips: clips.filter(isClipFile).sort(),
    backgrounds: bgs.filter(isBackgroundFile).sort(),
    music: music.filter(isAudioFile).sort(),
    unexpected,
    rootExists,
  };
}

/** A deterministic, secret-free logical key for an input asset. */
export function logicalAssetKey(type: AssetType, tag: string | null, sceneNumber: number | null): string {
  return `${type}:${tag ?? ''}:${sceneNumber ?? ''}`;
}

/** Compute a SHA-256 for a local file (exposed for manifest comparison). */
export async function computeFileSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const handle = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let pos = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
      if (bytesRead <= 0) break;
      hash.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
  } finally { await handle.close(); }
  return hash.digest('hex');
}

export interface ManifestDiscrepancy {
  key: string;
  relative_path: string;
  issue: 'MISSING_FILE' | 'HASH_MISMATCH' | 'NOT_IN_MANIFEST';
}

/**
 * Compare the manifest against the filesystem. The FILESYSTEM wins: manifest entries whose
 * file is absent/hash-differs are reported; discovered files absent from the manifest are
 * reported as NOT_IN_MANIFEST. Never mutates anything.
 */
export async function compareManifestToFilesystem(manifest: InputManifest, discovered: DiscoveredInputs, projectId: string, inputsRoot = 'inputs'): Promise<ManifestDiscrepancy[]> {
  const out: ManifestDiscrepancy[] = [];
  const declared = new Set<string>();
  for (const a of manifest.assets) {
    declared.add(a.relative_path.split(/[\\/]/).slice(-1)[0]);
    const full = resolveManifestAssetPath(a.relative_path, projectId, inputsRoot);
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat || !stat.isFile()) { out.push({ key: logicalAssetKey(a.type, a.tag, a.scene_number), relative_path: a.relative_path, issue: 'MISSING_FILE' }); continue; }
    if (a.sha256) {
      const actual = await computeFileSha256(full);
      if (actual !== a.sha256) out.push({ key: logicalAssetKey(a.type, a.tag, a.scene_number), relative_path: a.relative_path, issue: 'HASH_MISMATCH' });
    }
  }
  for (const [category, files] of Object.entries({ characters: discovered.characters, narration: discovered.narration, 'flow-clips': discovered.flowClips, backgrounds: discovered.backgrounds, music: discovered.music })) {
    for (const f of files as string[]) {
      if (!declared.has(f)) out.push({ key: `${category}:${f}`, relative_path: `${category}/${f}`, issue: 'NOT_IN_MANIFEST' });
    }
  }
  return out;
}

/** Safe tag-stem helper re-exported for callers that need the same naming rule. */
export { safeTagStem };
