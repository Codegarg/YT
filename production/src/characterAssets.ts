/**
 * `character-assets` CLI — dry-run generation plan (STEP-8DZ).
 *
 * READ-ONLY by default. Prints the four complete character prompts and validates that every
 * required field is present. It performs NO image-generation API call, writes NO character
 * files, and never touches Flow/chrome.
 *
 *   npm run character-assets -- --dry-run
 */
import path from 'node:path';
import fs from 'node:fs';
import { CHARACTER_GENERATION_SPECS, validateCharacterSpecs, canonicalCharacterFilename, COMMON_STYLE, SHARED_NEGATIVE_PROMPT } from './characterGenerationSpec.js';
import { characterGenerationPlan } from './characterGenerationSpec.js';
import { characterSpecsFromPipeline, deriveVisualStyle, type CharacterGenerationSpec } from './characterGenerationSpec.js';
import { parseSize } from './characterGenerator.js';
import { checkOpenAIProvider, formatProviderCheck } from './providers/openaiCharacterImageProvider.js';
import { loadLocalEnvironment } from './bgm.js';

export interface DryRunReport {
  ok: boolean;
  totalCharacters: number;
  specValidation: { ok: boolean; reason?: string };
  size: string;
  projectId: string | null;
  source: 'pipeline' | 'built-in-example';
  plan: Array<{ tag: string; name: string; filename: string; size: string; transparentBackground: true; promptValid: boolean; negativePromptValid: boolean }>;
  characters: Array<{ tag: string; name: string; filename: string; promptLength: number; negativePromptLength: number; promptValid: boolean; negativePromptValid: boolean; transparentBackground: boolean; minResolution: string }>;
}

/** Resolve the character specs for a report: project-derived when a pipeline is given, else built-in. */
function resolveSpecs(pipeline: unknown | undefined): { specs: readonly CharacterGenerationSpec[]; source: 'pipeline' | 'built-in-example'; reason?: string } {
  if (pipeline === undefined) return { specs: CHARACTER_GENERATION_SPECS, source: 'built-in-example' };
  const r = characterSpecsFromPipeline(pipeline);
  if (!r.ok) return { specs: [], source: 'pipeline', reason: r.reason };
  return { specs: r.specs, source: 'pipeline' };
}

/** Build the dry-run report without generating or writing anything. */
export function buildDryRunReport(size = '1024x1024', pipeline?: unknown): DryRunReport {
  const resolved = resolveSpecs(pipeline);
  const v = validateCharacterSpecs(resolved.specs);
  const specs = resolved.specs;
  const plan = specs.map((s) => ({ tag: s.tag, name: s.name, filename: canonicalCharacterFilename(s.tag) as string, size, transparentBackground: true as const, promptValid: v.ok && s.generation_prompt.trim().length > 0, negativePromptValid: v.ok && s.negative_prompt.trim().length > 0 }));
  const characters = specs.map((s) => ({
    tag: s.tag,
    name: s.name,
    filename: canonicalCharacterFilename(s.tag) as string,
    promptLength: s.generation_prompt.length,
    negativePromptLength: s.negative_prompt.length,
    promptValid: v.ok && s.generation_prompt.trim().length > 0,
    negativePromptValid: v.ok && s.negative_prompt.trim().length > 0,
    transparentBackground: s.required_output_contract.transparency === 'required',
    minResolution: `${s.required_output_contract.minWidth}x${s.required_output_contract.minHeight}`,
  }));
  const ok = v.ok && specs.length > 0;
  return { ok, totalCharacters: specs.length, specValidation: v.ok ? v : { ok: v.ok, reason: v.reason ?? resolved.reason }, size, projectId: (pipeline as any)?.project_id ?? null, source: resolved.source, plan, characters };
}

/** Render the human-readable plan. Pure; no I/O. */
export function formatDryRunReport(r: DryRunReport): string {
  const lines: string[] = [];
  lines.push('='.repeat(40));
  lines.push('CHARACTER ASSET GENERATION PLAN (DRY RUN)');
  lines.push('='.repeat(40));
  lines.push(`Mode:            DRY RUN — no provider called, no files written`);
  lines.push(`Spec source:     ${r.source}${r.projectId ? ` (project ${r.projectId})` : ''}`);
  lines.push(`Characters:      ${r.totalCharacters}`);
  lines.push(`Requested size:  ${r.size}`);
  lines.push(`Transparency:    REQUIRED (true pixel alpha)`);
  lines.push(`Spec validation: ${r.specValidation.ok ? 'PASS' : 'FAIL ' + (r.specValidation.reason ?? '')}`);
  lines.push('');
  for (const c of r.characters) {
    lines.push(`${c.tag}  (${c.name})`);
    lines.push(`  target filename:        characters/${c.filename}`);
    lines.push(`  requested size:         ${r.size}`);
    lines.push(`  transparency:           ${c.transparentBackground ? 'REQUIRED' : 'MISSING'}`);
    lines.push(`  min resolution:         ${c.minResolution}`);
    lines.push(`  prompt validation:      ${c.promptValid ? 'PASS' : 'FAIL'} (${c.promptLength} chars)`);
    lines.push(`  negative validation:    ${c.negativePromptValid ? 'PASS' : 'FAIL'} (${c.negativePromptLength} chars)`);
    lines.push('');
  }
  lines.push('Common style:');
  lines.push(`  ${COMMON_STYLE}`);
  lines.push('');
  lines.push('Shared negative prompt:');
  lines.push(`  ${SHARED_NEGATIVE_PROMPT}`);
  lines.push('');
  lines.push('NEXT: supply a provider adapter, then run with an explicit provider. No asset is generated by this command.');
  lines.push('');
  return lines.join('\n');
}

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
function hasFlag(name: string): boolean { return process.argv.includes(name); }

const isMain = process.argv[1] && /characterAssets\.(ts|js|mts)$/.test(process.argv[1]);
if (isMain) {
  const size = arg('--size') ?? '1024x1024';
  if (!parseSize(size)) { console.error(`Invalid --size "${size}" (expected e.g. 1024x1024).`); process.exit(2); }
  // Load scripting/.env into process.env using the EXISTING repo mechanism (never prints secrets,
  // preserves an already-exported process.env value, fails safely when the file is absent).
  // Required so `--provider-check` sees OPENAI_API_KEY / OPENAI_IMAGE_MODEL the CLI would otherwise miss.
  await loadLocalEnvironment();
  // --provider-check: pure capability inspection. Never generates, never contacts Flow.
  if (hasFlag('--provider-check')) {
    const check = checkOpenAIProvider();
    if (hasFlag('--json')) console.log(JSON.stringify(check, null, 2));
    else console.log(formatProviderCheck(check));
    process.exit(check.status === 'READY_FOR_GENERATION' ? 0 : 1);
  }
  // --project: derive specs from the project's pipeline.json (source of truth), read-only.
  const projectArg = arg('--project');
  let pipeline: unknown | undefined;
  if (projectArg) {
    const file = path.resolve(projectArg);
    try { pipeline = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e: any) { console.error(`Could not read pipeline "${file}": ${String(e?.message ?? e)}`); process.exit(2); }
  }
  const report = buildDryRunReport(size, pipeline);
  if (hasFlag('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(formatDryRunReport(report));
  process.exit(report.ok ? 0 : 1);
}
