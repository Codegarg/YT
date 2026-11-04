// Offline character-generation pipeline tests (STEP-8DZ). Temp dirs only. No provider called.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { SRC } from './_testPaths.mjs';
import { REPO } from './_testPaths.mjs';

const spec = await import(pathToFileURL(`${SRC}/characterGenerationSpec.ts`).href);
const gen = await import(pathToFileURL(`${SRC}/characterGenerator.ts`).href);
const cli = await import(pathToFileURL(`${SRC}/characterAssets.ts`).href);
const { CHARACTER_GENERATION_SPECS, COMMON_STYLE, SHARED_NEGATIVE_PROMPT, REQUIRED_OUTPUT_CONTRACT, REFERENCE_SHEET_EXPRESSION, REFERENCE_SHEET_POSE, canonicalCharacterFilename, validateCharacterSpecs, characterGenerationPlan, characterSpecsFromPipeline, loadCharacterGenerationSpecs, deriveVisualStyle } = spec;
const { generateCharacterAssets, ingestCharacterBytes, assertProviderCapable } = gen;
const { buildDryRunReport, formatDryRunReport } = cli;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

// ---- deterministic PNG builder (real IDAT pixel data with correct filter bytes) ----
function makePng(w: number, h: number, ct = 6, alpha = 128): Buffer {
  const T: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct;
  const ch = ct === 6 ? 4 : 2;
  const raw = Buffer.alloc(h * (1 + w * ch), 0x80);
  for (let y = 0; y < h; y++) raw[y * (1 + w * ch)] = 0; // filter byte = None
  if (ct === 6) for (let y = 0; y < h; y++) { const off = y * (1 + w * ch) + 1; for (let x = 0; x < w; x++) raw[off + x * 4 + 3] = alpha; }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8dz-'));
const outDir = path.join(tmp, 'characters');

// ---- built-in EXAMPLE specs: four entries, structurally valid, deterministic ----
{
  check('exactly four example specs', CHARACTER_GENERATION_SPECS.length === 4);
  const tags = CHARACTER_GENERATION_SPECS.map((s: any) => s.tag);
  check('example tags are unique + well-formed', new Set(tags).size === 4 && tags.every((t: string) => /^@CHAR-\d{2}-[A-Z0-9-]+$/.test(t)), JSON.stringify(tags));
  check('spec validation passes', validateCharacterSpecs().ok === true);
}

// ---- prompts present, non-empty, deterministic ----
{
  check('all prompts non-empty', CHARACTER_GENERATION_SPECS.every((s: any) => s.generation_prompt.trim().length > 200));
  check('all negative prompts non-empty', CHARACTER_GENERATION_SPECS.every((s: any) => s.negative_prompt.trim().length > 100));
  check('prompts embed the common style', CHARACTER_GENERATION_SPECS.every((s: any) => s.generation_prompt.includes(COMMON_STYLE)));
  check('negative prompts include shared exclusions', CHARACTER_GENERATION_SPECS.every((s: any) => SHARED_NEGATIVE_PROMPT.split(', ').every((n: string) => s.negative_prompt.includes(n))));
  check('deterministic prompts (stable across calls)', JSON.stringify(validateCharacterSpecs()) === JSON.stringify(validateCharacterSpecs()) && CHARACTER_GENERATION_SPECS[0].generation_prompt === CHARACTER_GENERATION_SPECS[0].generation_prompt);
  check('plan is deterministic', JSON.stringify(characterGenerationPlan('1024x1024')) === JSON.stringify(characterGenerationPlan('1024x1024')));
}

// ---- required contract ----
{
  const c = REQUIRED_OUTPUT_CONTRACT;
  check('PNG requirement mandatory', c.format === 'png');
  check('transparent background mandatory', c.transparency === 'required' && c.pixelAlpha === 'required');
  check('minimum resolution >= 1024', c.minWidth >= 1024 && c.minHeight >= 1024);
  check('square output required', c.aspect === 'square-ish' && c.aspectRatio === 1);
  check('single character / full body / feet visible', c.singleCharacter === true && c.fullBody === true && c.feetVisible === true && c.maxCharacters === 1);
  check('compositing target 1920x1080', c.compositingWidth === 1920 && c.compositingHeight === 1080);
  check('every spec carries the same contract', CHARACTER_GENERATION_SPECS.every((s: any) => JSON.stringify(s.required_output_contract) === JSON.stringify(c)));
}

// ---- no Flow URL anywhere ----
{
  const all = CHARACTER_GENERATION_SPECS.map((s: any) => s.generation_prompt + s.negative_prompt).join(' ');
  check('no Flow URL / host referenced', !/https?:\/\/|flow\.google|flow-content/i.test(all));
  check('prompts explicitly forbid model sheets + studio backgrounds', CHARACTER_GENERATION_SPECS.every((s: any) => /no model sheet/i.test(s.generation_prompt) && /no studio or coloured background/i.test(s.generation_prompt)));
}

// ---- dry-run creates nothing ----
{
  const before = fs.existsSync(outDir);
  const r = buildDryRunReport();
  check('dry-run report ok', r.ok === true && r.totalCharacters === 4);
  check('dry-run creates no character assets', !fs.existsSync(outDir) && before === false);
  check('dry-run human output has the plan', /CHARACTER ASSET GENERATION PLAN/.test(formatDryRunReport(r)) && /target filename/.test(formatDryRunReport(r)));
  const outcomes = await generateCharacterAssets({ outputDir: outDir, dryRun: true });
  check('generateCharacterAssets dry-run returns PLANNED only and writes nothing', outcomes.every((o: any) => o.status === 'PLANNED') && !fs.existsSync(outDir));
}

// ---- PROJECT-DERIVED specs (the canonical production path) ----
{
  const pipeline = {
    project_id: 'youtube-automation-2-20261003160855-2740',
    characters: [
      { tag: '@CHAR-01-ARJUN', name: 'अर्जुन', age: 22, gender: 'male', personality: 'curious, brave, compassionate', voice_description: 'Young adult male.', full_prompt: '22-year-old Indian man ... 2D semi-realistic cartoon illustration, bold clean outlines, smooth flat cel shading, Indian character design, neutral grey studio background, full character reference sheet, flat 2D vector art, no text, no watermark, --ar 16:9', look_summary: '22-year-old Indian man.' },
      { tag: '@CHAR-02-MAA', name: 'माँ', age: null, gender: 'female', personality: 'caring, protective', voice_description: 'Middle-aged female.', full_prompt: 'Middle-aged Indian woman ... 2D semi-realistic cartoon illustration, bold clean outlines, smooth flat cel shading, Indian character design, neutral grey studio background, no text, --ar 16:9', look_summary: 'Middle-aged Indian woman.' },
      { tag: '@CHAR-03-RADHADEVI-ATMA', name: 'राधा देवी की आत्मा', age: null, gender: 'female', personality: 'grieving, restless', voice_description: 'Female, haunting.', full_prompt: 'Ghostly Indian woman ... 2D semi-realistic cartoon illustration, bold clean outlines, smooth flat cel shading, Indian character design, neutral grey studio background, no text, --ar 16:9', look_summary: 'Ghostly Indian woman.' },
      { tag: '@CHAR-04-DADI', name: 'दादी', age: null, gender: 'female', personality: 'wise, traditional', voice_description: 'Elderly female.', full_prompt: 'Elderly Indian woman ... 2D semi-realistic cartoon illustration, bold clean outlines, smooth flat cel shading, Indian character design, neutral grey studio background, no text, --ar 16:9', look_summary: 'Elderly Indian woman.' },
    ],
  };
  const r = characterSpecsFromPipeline(pipeline);
  check('pipeline specs derive OK', r.ok === true, r);
  check('exact project tags resolve',
    JSON.stringify(r.specs.map((s: any) => s.tag)) === JSON.stringify(['@CHAR-01-ARJUN', '@CHAR-02-MAA', '@CHAR-03-RADHADEVI-ATMA', '@CHAR-04-DADI']), r.specs.map((s: any) => s.tag));
  check('prompt derives from pipeline full_prompt (not a story constant)',
    r.specs[1].generation_prompt.includes('Middle-aged Indian woman') && r.specs[0].generation_prompt.includes('22-year-old Indian man'));
  check('NO MOHAN/GEETA/BUZURG dependency', !/MOHAN|GEETA|BUZURG/.test(JSON.stringify(r.specs)));
  check('age number preserved from pipeline (22)', /approximately 22 years old/.test(r.specs[0].age), r.specs[0].age);
  check('null age preserved as empty (not invented)', r.specs[1].age === '' && r.specs[2].age === '');
  check('optional fields preserved verbatim (personality/voice)', r.specs[0].personality === 'curious, brave, compassionate' && r.specs[3].voice_description === 'Elderly female.');
  check('visual style derived from project prompt (verbatim, not the built-in constant)',
    deriveVisualStyle(pipeline.characters).startsWith('2D semi-realistic cartoon illustration') && !deriveVisualStyle(pipeline.characters).includes('Indian horror illustration'));
  check('derived specs pass the shared validator', validateCharacterSpecs(r.specs).ok === true);
  check('legacy fallback no longer treats look_summary pose as clothing', !/neutral\s+3\s*\/\s*4/i.test(r.specs[0].clothing));
  check('legacy fallback uses neutral reference expression/pose constants',
    r.specs[0].expression === REFERENCE_SHEET_EXPRESSION && r.specs[0].pose === REFERENCE_SHEET_POSE);
  check('canonical filenames from project tags',
    JSON.stringify(r.specs.map((s: any) => canonicalCharacterFilename(s.tag))) === JSON.stringify(['CHAR-01-ARJUN.png', 'CHAR-02-MAA.png', 'CHAR-03-RADHADEVI-ATMA.png', 'CHAR-04-DADI.png']));
  check('loadCharacterGenerationSpecs throws on an empty pipeline', (() => { try { loadCharacterGenerationSpecs({ characters: [] }); return false; } catch { return true; } })());
  // unknown / malformed tags fail closed
  check('unknown tag fails closed (invalid pattern)', characterSpecsFromPipeline({ characters: [{ tag: '@ROGUE-01', full_prompt: 'x', look_summary: 'y' }] }).ok === false);
  check('duplicate tag fails closed', characterSpecsFromPipeline({ characters: [{ tag: '@CHAR-01-A', full_prompt: 'x', look_summary: 'y' }, { tag: '@CHAR-01-A', full_prompt: 'x', look_summary: 'y' }] }).ok === false);
  check('missing full_prompt fails closed', characterSpecsFromPipeline({ characters: [{ tag: '@CHAR-01-A', look_summary: 'y' }] }).ok === false);
  check('no characters array fails closed', characterSpecsFromPipeline({}).ok === false);
  // generator consumes project specs when a pipeline is supplied
  const outP = path.join(tmp, 'characters-pipeline');
  const provider = { name: 'stub', capabilities: { png: true, transparentBackground: true, sizes: ['1024x1024'] }, generate: async () => ({ bytes: makePng(1024, 1024, 6, 128), format: 'png' }) } as any;
  const outcomes = await generateCharacterAssets({ outputDir: outP, provider, size: '1024x1024', pipeline, only: ['@CHAR-02-MAA'] });
  check('generator uses project-derived specs (only @CHAR-02-MAA)', outcomes.length === 1 && outcomes[0].ok === true && outcomes[0].filename === 'CHAR-02-MAA.png', outcomes);
  // dry-run report reflects the pipeline source
  const report = buildDryRunReport('1024x1024', pipeline);
  check('dry-run report is pipeline-sourced with exact project tags', report.source === 'pipeline' && report.totalCharacters === 4 && report.characters.map((c: any) => c.tag).join(',') === '@CHAR-01-ARJUN,@CHAR-02-MAA,@CHAR-03-RADHADEVI-ATMA,@CHAR-04-DADI', report.characters.map((c: any) => c.tag));
}

// ---- strict appearance/wardrobe contract ----
{
  const strictCharacter: any = {
    tag: '@CHAR-01-ARJUN', name: 'Arjun', age: 22, gender: 'male',
    profession: 'student', personality: 'curious, brave',
    voice_description: 'Young adult male, North Indian accent.',
    look_summary: '22-year-old Indian man, old red shirt, neutral 3/4 pose.',
    full_prompt: '22-year-old Indian man in an old red shirt. 2D semi-realistic cartoon illustration, bold clean outlines, smooth flat cel shading, neutral grey studio background, full character reference sheet.',
    appearance_lock: {
      age: '22-year-old adult Indian man', gender: 'male', build: 'medium build',
      skin: 'medium brown skin', face: 'oval face, clean-shaven', hair: 'short black hair',
      facial_hair: 'none', marks: 'none',
    },
    wardrobe: {
      default_outfit: 'nightwear',
      outfits: {
        nightwear: {
          top: 'steel grey cotton t-shirt', bottom: 'navy blue pyjama trousers',
          outerwear: 'none', footwear: 'barefoot', accessories: 'none', notes: 'loose comfortable fit',
        },
      },
    },
  };
  const strictPipeline = { wardrobe_schema_version: 1, characters: [strictCharacter] };
  const sr = characterSpecsFromPipeline(strictPipeline);
  check('strict wardrobe pipeline derives a spec', sr.ok === true, sr);
  check('strict clothing comes from the explicit wardrobe, not look_summary',
    sr.ok && sr.specs[0].clothing.includes('top: steel grey cotton t-shirt') && !/red shirt/i.test(sr.specs[0].clothing));
  check('strict physical_appearance comes from appearance_lock, not full_prompt',
    sr.ok && sr.specs[0].physical_appearance.includes('age: 22-year-old adult Indian man') && !/red shirt/i.test(sr.specs[0].physical_appearance));
  check('strict reference expression/pose are neutral constants, not look_summary',
    sr.ok && sr.specs[0].expression === REFERENCE_SHEET_EXPRESSION && sr.specs[0].pose === REFERENCE_SHEET_POSE);
  check('strict generation prompt carries the exact wardrobe and not the legacy red shirt',
    sr.ok && sr.specs[0].generation_prompt.includes('top: steel grey cotton t-shirt') && !/old red shirt/i.test(sr.specs[0].generation_prompt));
  const strictValidation = sr.ok ? validateCharacterSpecs(sr.specs) : { ok: false, reason: 'no spec' };
  check('strict spec passes the shared validator', strictValidation.ok === true, strictValidation);

  const noWardrobe = { ...strictCharacter, wardrobe: undefined };
  const nr = characterSpecsFromPipeline({ wardrobe_schema_version: 1, characters: [noWardrobe] });
  check('strict missing wardrobe fails closed', nr.ok === false && /wardrobe/i.test(nr.reason), nr);
  const noAppearance = { ...strictCharacter, appearance_lock: undefined };
  const ar = characterSpecsFromPipeline({ wardrobe_schema_version: 1, characters: [noAppearance] });
  check('strict missing appearance_lock fails closed', ar.ok === false && /appearance_lock/i.test(ar.reason), ar);
  const noLook = { ...strictCharacter };
  delete noLook.look_summary;
  const lr = characterSpecsFromPipeline({ wardrobe_schema_version: 1, characters: [noLook] });
  check('strict mode does not require look_summary for clothing', lr.ok === true, lr);
}

// ---- provider unavailable => fail closed ----
{
  const outcomes = await generateCharacterAssets({ outputDir: outDir });
  check('no provider => PROVIDER_UNAVAILABLE (fail closed, nothing written)', outcomes.every((o: any) => !o.ok && o.status === 'PROVIDER_UNAVAILABLE') && !fs.existsSync(outDir));
  check('assertProviderCapable: undefined provider rejected', assertProviderCapable(undefined, '1024x1024', true).ok === false);
}
// ---- incapable providers ----
{
  const noPng = { name: 'x', capabilities: { png: false, transparentBackground: true, sizes: ['1024x1024'] } } as any;
  const noAlpha = { name: 'x', capabilities: { png: true, transparentBackground: false, sizes: ['1024x1024'] } } as any;
  const mayOpaque = { name: 'x', capabilities: { png: true, transparentBackground: true, sizes: ['1024x1024'], mayReturnOpaque: true } } as any;
  const small = { name: 'x', capabilities: { png: true, transparentBackground: true, sizes: ['512x512'] } } as any;
  check('provider without PNG guarantee rejected', assertProviderCapable(noPng, '1024x1024', true).ok === false);
  check('provider without transparency guarantee rejected', assertProviderCapable(noAlpha, '1024x1024', true).ok === false);
  check('provider that may return opaque rejected', assertProviderCapable(mayOpaque, '1024x1024', true).ok === false);
  check('provider lacking the requested size rejected', assertProviderCapable(small, '1024x1024', true).ok === false);
  const good = { name: 'ok', capabilities: { png: true, transparentBackground: true, sizes: ['1024x1024'] } } as any;
  check('capable provider accepted', assertProviderCapable(good, '1024x1024', true).ok === true);
}

// ---- ingestion: invalid rejected, valid installed atomically ----
{
  // opaque RGBA -> rejected
  const opaque = await ingestCharacterBytes('@CHAR-01-ARJUN', makePng(1024, 1024, 6, 255), { outputDir: outDir });
  check('opaque output rejected (NO_ALPHA path)', opaque.ok === false && opaque.status === 'INVALID_OUTPUT' && !fs.existsSync(path.join(outDir, 'CHAR-01-ARJUN.png')));
  check('no temp residue after rejection', fs.existsSync(outDir) ? !fs.readdirSync(outDir).some((f) => f.includes('.tmp-')) : true);
  // undersized -> rejected
  const small = await ingestCharacterBytes('@CHAR-01-ARJUN', makePng(512, 512, 6, 128), { outputDir: outDir });
  check('undersized output rejected', small.ok === false && small.status === 'INVALID_OUTPUT');
  // non-square -> rejected
  const wide = await ingestCharacterBytes('@CHAR-01-ARJUN', makePng(2048, 768, 6, 128), { outputDir: outDir });
  check('non-square output rejected', wide.ok === false && wide.status === 'INVALID_OUTPUT');
  // garbage -> rejected
  const junk = await ingestCharacterBytes('@CHAR-01-ARJUN', Buffer.from('not a png at all, padded to some length'), { outputDir: outDir });
  check('invalid image bytes rejected', junk.ok === false && junk.status === 'INVALID_OUTPUT');
  // valid -> installed
  const goodBytes = makePng(1024, 1024, 6, 128);
  const install = await ingestCharacterBytes('@CHAR-01-ARJUN', goodBytes, { outputDir: outDir });
  check('valid transparent PNG installed', install.ok === true && install.status === 'INSTALLED' && fs.existsSync(path.join(outDir, 'CHAR-01-ARJUN.png')));
  check('installed SHA matches source bytes', install.sha256 === crypto.createHash('sha256').update(goodBytes).digest('hex'));
  check('no temp residue after success', !fs.readdirSync(outDir).some((f) => f.includes('.tmp-')));
  // existing valid asset preserved against invalid replacement
  const beforeBytes = fs.readFileSync(path.join(outDir, 'CHAR-01-ARJUN.png'));
  const badReplace = await ingestCharacterBytes('@CHAR-01-ARJUN', makePng(1024, 1024, 6, 255), { outputDir: outDir, overwrite: true });
  check('existing valid asset never overwritten by invalid output', badReplace.ok === false && fs.readFileSync(path.join(outDir, 'CHAR-01-ARJUN.png')).equals(beforeBytes));
  // preserved when not overwriting
  const preserve = await ingestCharacterBytes('@CHAR-01-ARJUN', makePng(1024, 1024, 6, 100), { outputDir: outDir });
  check('existing valid asset preserved without overwrite flag', preserve.ok === true && preserve.status === 'PRESERVED' && fs.readFileSync(path.join(outDir, 'CHAR-01-ARJUN.png')).equals(beforeBytes));
}

// ---- end-to-end with a stub provider (in-process, no network) ----
{
  const out2 = path.join(tmp, 'characters2');
  const provider = {
    name: 'stub', capabilities: { png: true, transparentBackground: true, sizes: ['1024x1024'] },
    generate: async () => ({ bytes: makePng(1024, 1024, 6, 128), format: 'png' }),
  } as any;
  const outcomes = await generateCharacterAssets({ outputDir: out2, provider, size: '1024x1024' });
  check('stub provider installs all four built-in example characters', outcomes.length === 4 && outcomes.every((o: any) => o.ok && o.status === 'INSTALLED'));
  check('all four example files exist', outcomes.every((o: any) => fs.existsSync(path.join(out2, o.filename))));
  // JPEG-returning provider rejected
  const jpegProvider = { name: 'j', capabilities: { png: true, transparentBackground: true, sizes: ['1024x1024'] }, generate: async () => ({ bytes: makePng(1024, 1024, 6, 128), format: 'jpeg' }) } as any;
  const j = await generateCharacterAssets({ outputDir: path.join(tmp, 'characters3'), provider: jpegProvider });
  check('non-PNG provider output rejected (no JPEG fallback)', j.every((o: any) => !o.ok && o.status === 'INVALID_OUTPUT'));
}

// ---- module safety ----
{
  const g = fs.readFileSync(`${SRC}/characterGenerator.ts`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const s = fs.readFileSync(`${SRC}/characterGenerationSpec.ts`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('generator performs no network I/O', !/fetch\(|XMLHttpRequest|https?:\/\//.test(g));
  check('generator has no Flow/Chrome dependency', !/playwright|FlowClient|chrome/i.test(g));
  check('spec has no Flow/Chrome dependency', !/playwright|FlowClient|chrome/i.test(s));
  check('no background-removal code path exists', !/removeBackground|segmentation|chromaKey/i.test(g));
}

// ---- real project untouched ----
{
  check('real production/inputs character files not created by this test', !fs.existsSync(`${REPO}/production/inputs/raat-ka-khauf-3am-kuan/characters`));
  const h = crypto.createHash('sha256').update(fs.readFileSync(`${REPO}/scripting/projects/raat-ka-khauf-3am-kuan/pipeline.json`)).digest('hex');
  check('real pipeline.json SHA unchanged', h === '0c654402dad814f11c3e498cfd541667aabd65e24d7a17db01219bbd7491dcfb');
}

console.log(`\nCHARACTER-GENERATION TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
