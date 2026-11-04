/**
 * Input manifest authoring + supply-time validation (STEP-8DN).
 *
 *   · draftManifest()          — derive the REQUIRED/OPTIONAL/NOT_REQUIRED input contract from
 *                                the ACTUAL pipeline (never hardcoded counts).
 *   · validateManifestFile()   — validate a supplied manifest against the filesystem using the
 *                                existing inputValidator contracts. COMPLETE diagnostics;
 *                                read-only; fail-closed.
 *
 * No hashes are invented: absent assets carry `sha256: null`. Real hashes are computed only
 * when a file actually exists, and a supplied hash is compared (never trusted blindly).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateProjectInputs, deriveRequiredInputs, safeInputPath, INPUT_VALIDATOR_SCHEMA_VERSION, VALIDATOR_CONTRACT_VERSION, type InputValidationReport, type InputAssetResult } from './inputValidator.js';
import { safeTagStem, MIN_BACKGROUND_WIDTH, MIN_BACKGROUND_HEIGHT } from './assetCache.js';
import { MIN_CHARACTER_WIDTH, MIN_CHARACTER_HEIGHT, SUPPORTED_CHARACTER_EXTENSIONS } from './characterAsset.js';
import { SUPPORTED_AUDIO_EXTENSIONS } from './narrationDuration.js';
import { SUPPORTED_CLIP_EXTENSIONS, MIN_CLIP_WIDTH, MIN_CLIP_HEIGHT } from './videoClip.js';

export const MANIFEST_SCHEMA_VERSION = 1;

/** Requirement status per asset. */
export type RequirementStatus = 'REQUIRED' | 'OPTIONAL' | 'NOT_REQUIRED';

export interface DraftAsset {
  id: string;
  category: 'backgrounds' | 'characters' | 'narration' | 'flow_clips' | 'music' | 'branding';
  scene_number: number | null;
  title: string | null;
  requirement: RequirementStatus;
  relative_path: string;
  accepted_formats: string[];
  validation: Record<string, unknown>;
  /** Never a fake fingerprint: null until the file actually exists. */
  sha256: null;
  current_state: 'MISSING';
}

export interface DraftManifest {
  schema_version: number;
  project_id: string;
  validator_contract_version: string;
  generated_from_pipeline_sha256: string;
  assets: {
    backgrounds: DraftAsset[];
    characters: DraftAsset[];
    narration: DraftAsset[];
    flow_clips: DraftAsset[];
    music: DraftAsset[];
    branding: DraftAsset[];
  };
}

export function pipelineSha256(pipelineRaw: string): string {
  return crypto.createHash('sha256').update(pipelineRaw).digest('hex');
}

/**
 * Derive a human-facing draft manifest from the ACTUAL pipeline.
 * Every count and mapping comes from the pipeline via `deriveRequiredInputs`.
 */
export function draftManifest(pipeline: any, pipelineRaw: string): DraftManifest {
  const req = deriveRequiredInputs(pipeline);
  const scenes = new Map<number, any>((pipeline?.scenes ?? []).map((s: any) => [Number(s.scene_number), s]));

  const backgrounds: DraftAsset[] = req.backgrounds.map((tag) => ({
    id: tag, category: 'backgrounds', scene_number: null, title: null,
    requirement: 'REQUIRED',
    relative_path: `backgrounds/${safeTagStem(tag) ?? 'INVALID'}.png`,
    accepted_formats: ['.png', '.webp'],
    validation: { minWidth: MIN_BACKGROUND_WIDTH, minHeight: MIN_BACKGROUND_HEIGHT, aspect: '16:9 (tolerance 0.09)', pngSignature: true },
    sha256: null, current_state: 'MISSING',
  }));

  const characters: DraftAsset[] = req.characters.map((tag) => ({
    id: tag, category: 'characters', scene_number: null, title: null,
    requirement: 'REQUIRED',
    relative_path: `characters/${safeTagStem(tag) ?? 'INVALID'}.png`,
    accepted_formats: [...SUPPORTED_CHARACTER_EXTENSIONS],
    validation: { minWidth: MIN_CHARACTER_WIDTH, minHeight: MIN_CHARACTER_HEIGHT, aspect: 'square-compatible', alphaRequired: true, note: 'transparent cutout; model sheets/screenshots are not accepted' },
    sha256: null, current_state: 'MISSING',
  }));

  // Narration is required ONLY for the narrator/none scenes the existing narration manifest targets.
  const narration: DraftAsset[] = req.narrationScenes.map((n) => ({
    id: `narration-${String(n).padStart(4, '0')}`, category: 'narration', scene_number: n,
    title: scenes.get(n)?.title ?? null, requirement: 'REQUIRED',
    relative_path: `narration/narration-${String(n).padStart(4, '0')}.wav`,
    accepted_formats: [...SUPPORTED_AUDIO_EXTENSIONS],
    validation: { durationSource: 'ffprobe', maxSeconds: 600, oneFilePerScene: true },
    sha256: null, current_state: 'MISSING',
  }));

  // Supplied clips are REQUIRED for dialogue scenes (no local dialogue audio exists) and
  // OPTIONAL for other scenes (local synthesis can supply them).
  const dialogue = new Set(req.requiredClips);
  const flow_clips: DraftAsset[] = req.sceneNumbers.map((n) => ({
    id: `scene-${String(n).padStart(4, '0')}`, category: 'flow_clips', scene_number: n,
    title: scenes.get(n)?.title ?? null,
    requirement: dialogue.has(n) ? 'REQUIRED' : 'OPTIONAL',
    relative_path: `flow-clips/scene-${String(n).padStart(4, '0')}.mp4`,
    accepted_formats: [...SUPPORTED_CLIP_EXTENSIONS],
    validation: { requiresAudioStream: true, minWidth: MIN_CLIP_WIDTH, minHeight: MIN_CLIP_HEIGHT, durationSource: 'ffprobe' },
    sha256: null, current_state: 'MISSING',
  }));

  const music: DraftAsset[] = [{
    id: 'background-music', category: 'music', scene_number: null, title: null, requirement: 'REQUIRED',
    relative_path: 'music/background-music.mp3',
    accepted_formats: [...SUPPORTED_AUDIO_EXTENSIONS],
    validation: { licensePolicy: 'CC0 or CC-BY (+ attribution)', provenanceFile: 'music/background-music.license.json', rejected: ['CC-BY-NC', 'CC-BY-ND', 'unknown', 'missing'] },
    sha256: null, current_state: 'MISSING',
  }];

  const branding: DraftAsset[] = [
    { id: 'channel-intro', category: 'branding', scene_number: null, title: null, requirement: 'REQUIRED', relative_path: 'branding/channel-intro.mp4', accepted_formats: [...SUPPORTED_CLIP_EXTENSIONS], validation: { requiresAudioStream: true, durationSource: 'ffprobe' }, sha256: null, current_state: 'MISSING' },
    { id: 'channel-logo', category: 'branding', scene_number: null, title: null, requirement: 'REQUIRED', relative_path: 'branding/channel-logo.png', accepted_formats: ['.png'], validation: { pngSignature: true }, sha256: null, current_state: 'MISSING' },
  ];

  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    project_id: String(pipeline?.project_id ?? ''),
    validator_contract_version: VALIDATOR_CONTRACT_VERSION,
    generated_from_pipeline_sha256: pipelineSha256(pipelineRaw),
    assets: { backgrounds, characters, narration, flow_clips, music, branding },
  };
}

// ---------------------------------------------------------------------------------------
// Human supply checklist (single source for the handoff docs + its integrity test)
// ---------------------------------------------------------------------------------------

export interface SupplyChecklistRow {
  category: 'backgrounds' | 'characters' | 'narration' | 'flow_clips' | 'music' | 'branding';
  id: string;
  expectedFile: string;
  required: boolean;
  validation: string;
  sceneNumber: number | null;
  title: string | null;
}

/**
 * Deterministic human supply checklist derived from the ACTUAL pipeline.
 * The handoff documentation is generated from this, so the documented list cannot drift
 * from `deriveRequiredInputs`.
 */
export function supplyChecklist(pipeline: any, pipelineRaw: string): SupplyChecklistRow[] {
  const draft = draftManifest(pipeline, pipelineRaw);
  const rows: SupplyChecklistRow[] = [];
  const describe = (a: DraftAsset): string => {
    const v = a.validation as any;
    switch (a.category) {
      case 'backgrounds': return `PNG/WebP · >=${v.minWidth}x${v.minHeight} · ${v.aspect}`;
      case 'characters': return `${a.accepted_formats.join('/')} · >=${v.minWidth}x${v.minHeight} · ${v.aspect} · alpha required`;
      case 'narration': return `${a.accepted_formats.join('/')} · one file per scene · duration via ffprobe`;
      case 'flow_clips': return `${a.accepted_formats.join('/')} · video+audio streams · >=${v.minWidth}x${v.minHeight} · duration via ffprobe`;
      case 'music': return `audio · licence ${v.licensePolicy} · provenance ${v.provenanceFile}`;
      case 'branding': return a.id === 'channel-intro' ? 'MP4 · video+audio · duration via ffprobe' : 'PNG signature valid';
    }
  };
  for (const [category, list] of Object.entries(draft.assets) as [SupplyChecklistRow['category'], DraftAsset[]][]) {
    for (const a of list) rows.push({ category, id: a.id, expectedFile: a.relative_path, required: a.requirement === 'REQUIRED', validation: describe(a), sceneNumber: a.scene_number, title: a.title });
  }
  return rows;
}

/** Render the checklist as a markdown table body (deterministic). */
export function supplyChecklistTable(pipeline: any, pipelineRaw: string): string {
  const rows = supplyChecklist(pipeline, pipelineRaw);
  const lines = ['| Category | ID | Expected file | Required? | Validation | Supplied? |', '|---|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.category} | \`${r.id}\`${r.title ? ` (${r.title})` : ''} | \`${r.expectedFile}\` | ${r.required ? '**REQUIRED**' : 'optional'} | ${r.validation} | ☐ |`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------
// Supplied-manifest validation
// ---------------------------------------------------------------------------------------

export type ManifestStatus = 'VALID' | 'INVALID' | 'INCOMPLETE' | 'PIPELINE_MISMATCH';

export interface ManifestValidationReport {
  status: ManifestStatus;
  projectId: string;
  issues: Array<{ code: string; id?: string; path?: string; detail: string }>;
  missing: string[];
  invalid: string[];
  unsupported: string[];
  licenseFailures: string[];
  shaMismatches: string[];
  unexpected: string[];
  inputs?: InputValidationReport;
}

const ABS = /^[A-Za-z]:/;
const UNC = /^(\\\\|\/\/)/;

function checkRelativePath(p: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  const rel = String(p ?? '').trim();
  if (!rel) return { ok: false, reason: 'relative_path is empty' };
  if (rel.includes('\0')) return { ok: false, reason: 'relative_path contains a null byte' };
  if (ABS.test(rel) || UNC.test(rel) || path.isAbsolute(rel)) return { ok: false, reason: `absolute/UNC path not allowed: ${rel}` };
  const norm = path.normalize(rel).replace(/\\/g, '/');
  if (norm.startsWith('..')) return { ok: false, reason: `path traversal not allowed: ${rel}` };
  return { ok: true, value: norm };
}

/**
 * Validate a supplied manifest against the filesystem. Read-only. COMPLETE diagnostics.
 * Requires an ACTUAL manifest file (never fabricates one).
 */
export async function validateManifestFile(opts: {
  manifestPath: string;
  pipeline: any;
  pipelineRaw: string;
  inputRoot: string;
  ffprobePath?: string;
  /** When true, missing REQUIRED assets → INCOMPLETE rather than INVALID. */
}): Promise<ManifestValidationReport> {
  const issues: ManifestValidationReport['issues'] = [];
  const report: ManifestValidationReport = { status: 'INVALID', projectId: '', issues, missing: [], invalid: [], unsupported: [], licenseFailures: [], shaMismatches: [], unexpected: [] };

  let raw: string;
  try { raw = await fsp.readFile(opts.manifestPath, 'utf8'); }
  catch { issues.push({ code: 'MANIFEST_NOT_FOUND', detail: `Manifest not found: ${path.basename(opts.manifestPath)}` }); return report; }

  let m: any;
  try { m = JSON.parse(raw); }
  catch { issues.push({ code: 'MANIFEST_MALFORMED_JSON', detail: 'Manifest is not valid JSON' }); return report; }

  const expectedId = String(opts.pipeline?.project_id ?? '');
  report.projectId = String(m?.project_id ?? '');

  // ---- schema / identity checks ----
  if (m?.schema_version !== MANIFEST_SCHEMA_VERSION) issues.push({ code: 'MANIFEST_SCHEMA_UNSUPPORTED', detail: `schema_version ${String(m?.schema_version)} != ${MANIFEST_SCHEMA_VERSION}` });
  if (String(m?.project_id) !== expectedId) issues.push({ code: 'MANIFEST_PROJECT_MISMATCH', detail: `project_id "${String(m?.project_id)}" != "${expectedId}"` });
  if (m?.validator_contract_version !== VALIDATOR_CONTRACT_VERSION) issues.push({ code: 'MANIFEST_CONTRACT_UNSUPPORTED', detail: `validator_contract_version ${String(m?.validator_contract_version)} != ${VALIDATOR_CONTRACT_VERSION}` });

  // ---- pipeline fingerprint (fail-closed, no override) ----
  const expectedSha = pipelineSha256(opts.pipelineRaw);
  const pipelineMismatch = typeof m?.generated_from_pipeline_sha256 === 'string' && m.generated_from_pipeline_sha256 !== expectedSha;
  if (pipelineMismatch) issues.push({ code: 'MANIFEST_PIPELINE_MISMATCH', detail: `manifest pipeline sha ${m.generated_from_pipeline_sha256.slice(0, 12)}… != current ${expectedSha.slice(0, 12)}…` });

  // ---- structural asset checks ----
  const required = draftManifest(opts.pipeline, opts.pipelineRaw);
  const assets = m?.assets ?? {};
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  const declaredPaths: string[] = [];

  for (const category of Object.keys(required.assets) as (keyof DraftManifest['assets'])[]) {
    const entries = Array.isArray(assets[category]) ? assets[category] : [];
    if (entries.length === 0) continue;
    for (const e of entries) {
      const id = String(e?.id ?? '');
      if (!id) { issues.push({ code: 'MANIFEST_ASSET_ID_MISSING', detail: `asset in ${category} has no id` }); continue; }
      const dk = `${category}:${id}`;
      if (seenIds.has(dk)) { issues.push({ code: 'MANIFEST_DUPLICATE_ID', id, detail: `duplicate id ${dk}` }); continue; }
      seenIds.add(dk);
      const cp = checkRelativePath(e?.relative_path);
      if (!cp.ok) { issues.push({ code: 'MANIFEST_PATH_INVALID', id, detail: cp.reason }); continue; }
      if (seenPaths.has(cp.value)) { issues.push({ code: 'MANIFEST_DUPLICATE_PATH', id, path: cp.value, detail: `two assets map to ${cp.value}` }); continue; }
      seenPaths.add(cp.value);
      declaredPaths.push(cp.value);
    }
  }

  // ---- media validation via the existing validator ----
  const req = deriveRequiredInputs(opts.pipeline);
  const inputs = await validateProjectInputs({
    projectId: expectedId, inputRoot: opts.inputRoot,
    requiredBackgrounds: req.backgrounds, requiredCharacters: req.characters,
    narrationScenes: req.narrationScenes, sceneNumbers: req.sceneNumbers,
    requiredClips: req.sceneNumbers, ffprobePath: opts.ffprobePath,
  });
  report.inputs = inputs;

  const all: InputAssetResult[] = [...inputs.backgrounds, ...inputs.characters, ...inputs.narration, ...inputs.flowClips, ...inputs.music, ...inputs.branding];
  // Only REQUIRED assets block validity; OPTIONAL (e.g. synthesizable scene clips) may be absent.
  const requiredIds = new Set<string>();
  const requiredClipScenes = new Set(required.assets.flow_clips.filter((a) => a.requirement === 'REQUIRED').map((a) => a.id));
  for (const a of Object.values(required.assets).flat()) if (a.requirement === 'REQUIRED') requiredIds.add(a.id);
  for (const a of all) {
    const isRequired = requiredIds.has(a.id) || (a.id.startsWith('scene-') && requiredClipScenes.has(a.id));
    if (a.state === 'MISSING') { if (isRequired) { report.missing.push(a.id); issues.push({ code: 'MANIFEST_ASSET_MISSING', id: a.id, detail: a.reason ?? 'required asset missing' }); } }
    else if (a.state === 'UNSUPPORTED') { report.unsupported.push(a.id); issues.push({ code: 'MANIFEST_ASSET_UNSUPPORTED', id: a.id, detail: a.reason ?? 'unsupported' }); }
    else if (a.state === 'LICENSE_INVALID') { report.licenseFailures.push(a.id); issues.push({ code: 'MANIFEST_LICENSE_INVALID', id: a.id, detail: a.reason ?? 'licence invalid' }); }
    else if (a.state !== 'VALID') { report.invalid.push(a.id); issues.push({ code: 'MANIFEST_ASSET_INVALID', id: a.id, detail: a.reason ?? `${a.state}` }); }
  }

  // ---- SHA comparison for assets whose file exists and supplied a hash ----
  for (const category of Object.keys(required.assets) as (keyof DraftManifest['assets'])[]) {
    for (const e of (Array.isArray(assets[category]) ? assets[category] : [])) {
      if (typeof e?.sha256 !== 'string' || !e.sha256) continue;
      const cp = checkRelativePath(e?.relative_path);
      if (!cp.ok) continue;
      let full: string;
      try { full = safeInputPath(opts.inputRoot, cp.value); } catch { continue; }
      const actual = await fsp.readFile(full).then((b) => crypto.createHash('sha256').update(b).digest('hex')).catch(() => null);
      if (actual && actual !== e.sha256) { report.shaMismatches.push(String(e.id)); issues.push({ code: 'MANIFEST_SHA_MISMATCH', id: String(e.id), detail: `supplied sha does not match ${cp.value}` }); }
    }
  }

  // ---- unexpected / unreferenced assets on disk ----
  const discovered: string[] = [];
  for (const [dir, exts] of [['backgrounds', ['.png', '.webp']], ['characters', ['.png', '.webp']], ['narration', SUPPORTED_AUDIO_EXTENSIONS], ['flow-clips', SUPPORTED_CLIP_EXTENSIONS], ['music', SUPPORTED_AUDIO_EXTENSIONS], ['branding', ['.mp4', '.png']]] as [string, readonly string[]][]) {
    const files = await fsp.readdir(path.join(opts.inputRoot, dir)).catch(() => [] as string[]);
    for (const f of files) if (exts.some((e) => f.toLowerCase().endsWith(e)) && f !== 'background-music.license.json') discovered.push(`${dir}/${f}`);
  }
  const declaredSet = new Set(declaredPaths);
  for (const d of discovered) if (!declaredSet.has(d)) { report.unexpected.push(d); issues.push({ code: 'MANIFEST_UNEXPECTED_ASSET', path: d, detail: `file on disk is not referenced by the manifest` }); }

  // ---- overall status (priority: PIPELINE_MISMATCH > INVALID > INCOMPLETE > VALID) ----
  const structuralError = issues.some((i) => ['MANIFEST_SCHEMA_UNSUPPORTED', 'MANIFEST_PROJECT_MISMATCH', 'MANIFEST_CONTRACT_UNSUPPORTED', 'MANIFEST_MALFORMED_JSON', 'MANIFEST_PATH_INVALID', 'MANIFEST_DUPLICATE_ID', 'MANIFEST_DUPLICATE_PATH', 'MANIFEST_SHA_MISMATCH'].includes(i.code));
  const mediaError = report.invalid.length + report.unsupported.length + report.licenseFailures.length > 0;
  if (pipelineMismatch) report.status = 'PIPELINE_MISMATCH';
  else if (structuralError || mediaError) report.status = 'INVALID';
  else if (report.missing.length > 0 || report.unexpected.length > 0) report.status = 'INCOMPLETE';
  else report.status = 'VALID';
  return report;
}
