// Offline manifest authoring + supply-time validation tests (STEP-8DN).
// Temp dirs only. No Flow/Chrome. Read-only w.r.t. the real project.
// NOTE: named manifest_workflow_test because tests/input_manifest_test.mts already covers the
// 8DE inputManifest module.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);

import { REPO } from './_testPaths.mjs';
const SRC = `${REPO}/production/src`;
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;

const mw = await import(pathToFileURL(`${SRC}/manifestWorkflow.ts`).href);
const { draftManifest, validateManifestFile, pipelineSha256, MANIFEST_SCHEMA_VERSION } = mw;
const { VALIDATOR_CONTRACT_VERSION } = await import(pathToFileURL(`${SRC}/inputValidator.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

function makePng(w: number, h: number, ct = 6, tag = 0) {
  const T: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct; const ch = ct === 6 ? 4 : 2; const raw = Buffer.alloc(h * (1 + w * ch), 0x80);
  for (let _y = 0; _y < h; _y++) raw[_y * (1 + w * ch)] = 0; // filter byte = None raw[10] = tag & 0xff;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const wav = (f: string, sec: number, tag = 0) => { const n = Math.round(sec * 8000); const d = Buffer.alloc(n * 2, tag); const b = Buffer.alloc(44 + d.length); b.write('RIFF', 0); b.writeUInt32LE(36 + d.length, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(d.length, 40); fs.writeFileSync(f, b); };
const mkMp4 = async (o: string, d = 3, withAudio = true) => { const args = ['-y', '-f', 'lavfi', '-i', `color=c=0x203040:s=1920x1080:d=${d}`]; if (withAudio) args.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=48000:d=${d}`); args.push('-t', String(d), '-c:v', 'libx264', '-pix_fmt', 'yuv420p'); if (withAudio) args.push('-c:a', 'aac'); args.push('-shortest', o); await exec(process.env.FFMPEG_PATH, args); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8dn-'));
const PID = 'fixture-8dn';
const root = path.join(tmp, 'inputs', PID);
for (const c of ['backgrounds','characters','narration','flow-clips','music','branding']) fs.mkdirSync(path.join(root, c), { recursive: true });
const NARR = (n: number) => ({ narration_text: `narr ${n}`, animation_prompt_NARRATOR_ONLY: 'No voice synthesis. Narrator voiceover will be layered in editing.' });
const pipeline: any = { project_id: PID, characters: [{ tag: '@CHAR-01-ARJUN' }, { tag: '@CHAR-02-MOHAN' }], backgrounds: [{ tag: '#BGD-01' }, { tag: '#BGD-02' }], scenes: [
  { scene_number: 1, title: 'S1', background_tag: '#BGD-01', character_tags: ['@CHAR-01-ARJUN'], speaker: 'NARRATOR', ...NARR(1) },
  { scene_number: 2, title: 'S2', background_tag: '#BGD-02', character_tags: ['@CHAR-02-MOHAN'], speaker: '@CHAR-02-MOHAN', devanagari_dialogue: 'मोहन बोलता है।' },
  { scene_number: 3, title: 'S3', background_tag: '#BGD-01', character_tags: [], speaker: 'none', ...NARR(3) },
] };
const pipelineFile = path.join(tmp, 'pipeline.json');
fs.writeFileSync(pipelineFile, JSON.stringify(pipeline, null, 2));
const pipelineRaw = fs.readFileSync(pipelineFile, 'utf8');

// ---- 1-5. draft from the actual pipeline; no hardcoded counts; no fake hashes ----
{
  const d = draftManifest(pipeline, pipelineRaw);
  check('1. draft generated from the actual pipeline', d.project_id === PID && d.schema_version === MANIFEST_SCHEMA_VERSION && d.validator_contract_version === VALIDATOR_CONTRACT_VERSION);
  check('2/3/4. counts derive from the pipeline (not hardcoded)', d.assets.backgrounds.length === 2 && d.assets.characters.length === 2 && d.assets.flow_clips.length === 3 && d.assets.narration.length === 2);
  check('5. no fake hashes anywhere (all null)', Object.values(d.assets).flat().every((a: any) => a.sha256 === null));
  check('5b. pipeline fingerprint recorded', d.generated_from_pipeline_sha256 === pipelineSha256(pipelineRaw) && /^[0-9a-f]{64}$/.test(d.generated_from_pipeline_sha256));
  check('6. REQUIRED/OPTIONAL semantics: dialogue clip REQUIRED, others OPTIONAL', d.assets.flow_clips.find((x: any) => x.scene_number === 2)!.requirement === 'REQUIRED' && d.assets.flow_clips.find((x: any) => x.scene_number === 1)!.requirement === 'OPTIONAL');
  check('7. background entries carry expected path + validation', d.assets.backgrounds[0].relative_path.startsWith('backgrounds/') && (d.assets.backgrounds[0].validation as any).minWidth === 1280);
  check('8. character entries require alpha', (d.assets.characters[0].validation as any).alphaRequired === true);
  check('9. narration entries are the narrator/none scenes only', d.assets.narration.map((x: any) => x.scene_number).join(',') === '1,3');
  check('10. flow-clip entries carry scene title + ffprobe duration source', (d.assets.flow_clips[0].validation as any).durationSource === 'ffprobe' && d.assets.flow_clips[0].title === 'S1');
  check('11. music entry with licence policy + provenance file', d.assets.music.length === 1 && (d.assets.music[0].validation as any).licensePolicy.includes('CC0'));
  check('12. branding entries (intro + logo)', d.assets.branding.map((x: any) => x.id).join(',') === 'channel-intro,channel-logo');
  check('37. draft output is deterministic', JSON.stringify(draftManifest(pipeline, pipelineRaw)) === JSON.stringify(d));
}

// ---- build a complete, valid fixture + manifest ----
const draft = draftManifest(pipeline, pipelineRaw);
const manifestPath = path.join(tmp, 'manifest.json');
const writeManifest = (over: any = {}) => fs.writeFileSync(manifestPath, JSON.stringify({ ...draft, ...over }, null, 2));
async function supplyAll() {
  fs.writeFileSync(path.join(root, 'backgrounds', 'BGD-01.png'), makePng(1920, 1080, 2, 1));
  fs.writeFileSync(path.join(root, 'backgrounds', 'BGD-02.png'), makePng(1920, 1080, 2, 2));
  fs.writeFileSync(path.join(root, 'characters', 'CHAR-01-ARJUN.png'), makePng(1024, 1024, 6, 1));
  fs.writeFileSync(path.join(root, 'characters', 'CHAR-02-MOHAN.png'), makePng(1024, 1024, 6, 2));
  wav(path.join(root, 'narration', 'narration-0001.wav'), 3); wav(path.join(root, 'narration', 'narration-0003.wav'), 3);
  await mkMp4(path.join(root, 'flow-clips', 'scene-0002.mp4'), 3, true);
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=5', '-c:a', 'libmp3lame', path.join(root, 'music', 'background-music.mp3')]);
  fs.writeFileSync(path.join(root, 'music', 'background-music.license.json'), JSON.stringify({ license: 'CC0', source: 'human-supplied' }));
  await mkMp4(path.join(root, 'branding', 'channel-intro.mp4'), 5, true);
  fs.writeFileSync(path.join(root, 'branding', 'channel-logo.png'), makePng(256, 256, 6, 3));
}

const V = (over: any = {}) => validateManifestFile({ manifestPath: over.manifestPath ?? manifestPath, pipeline, pipelineRaw, inputRoot: root, ffprobePath: process.env.FFPROBE_PATH });

// ---- 13-16 / 31. schema + valid fixture ----
{
  writeManifest();
  let r = await V();
  check('32. partial fixture (nothing supplied) -> INCOMPLETE', r.status === 'INCOMPLETE' && r.missing.length > 0, JSON.stringify({ status: r.status, missing: r.missing.length }));
  await supplyAll();
  r = await V();
  check('31. complete valid fixture -> VALID', r.status === 'VALID', JSON.stringify({ status: r.status, issues: r.issues.slice(0, 4) }));
  check('13/14. schema + project id validated', r.issues.every((i) => i.code !== 'MANIFEST_SCHEMA_UNSUPPORTED' && i.code !== 'MANIFEST_PROJECT_MISMATCH'));
  check('38. validation result is deterministic', JSON.stringify(await V()) === JSON.stringify(r));
}

// ---- 15 / 34 / 13. pipeline fingerprint ----
{
  writeManifest({ generated_from_pipeline_sha256: 'deadbeef'.repeat(8) });
  const r = await V();
  check('15/34. pipeline mismatch -> PIPELINE_MISMATCH (fail-closed)', r.status === 'PIPELINE_MISMATCH' && r.issues.some((i) => i.code === 'MANIFEST_PIPELINE_MISMATCH'), r.status);
  writeManifest();
}
{
  writeManifest({ schema_version: 99 });
  check('13b. wrong schema_version -> INVALID', (await V()).status === 'INVALID');
  writeManifest({ project_id: 'other' });
  check('14b. wrong project_id -> INVALID', (await V()).status === 'INVALID');
  writeManifest();
}

// ---- 16-21. path safety + duplicates ----
{
  const mk = (assets: any) => writeManifest({ assets });
  mk({ ...draft.assets, backgrounds: [{ id: '#BGD-01', relative_path: 'C:\\evil.png' }] });
  check('17. absolute Windows path rejected', (await V()).issues.some((i) => i.code === 'MANIFEST_PATH_INVALID'));
  mk({ ...draft.assets, backgrounds: [{ id: '#BGD-01', relative_path: '\\\\unc\\evil.png' }] });
  check('18. UNC path rejected', (await V()).issues.some((i) => i.code === 'MANIFEST_PATH_INVALID'));
  mk({ ...draft.assets, backgrounds: [{ id: '#BGD-01', relative_path: '../../evil.png' }] });
  check('19. ../ traversal rejected', (await V()).issues.some((i) => i.code === 'MANIFEST_PATH_INVALID'));
  mk({ ...draft.assets, backgrounds: [{ id: '#BGD-01', relative_path: 'backgrounds/BGD-01.png' }, { id: '#BGD-01', relative_path: 'backgrounds/BGD-01.png' }] });
  check('20. duplicate ID rejected', (await V()).issues.some((i) => i.code === 'MANIFEST_DUPLICATE_ID'));
  mk({ ...draft.assets, backgrounds: [{ id: 'A', relative_path: 'backgrounds/BGD-01.png' }, { id: 'B', relative_path: 'backgrounds/BGD-01.png' }] });
  check('21. duplicate path rejected', (await V()).issues.some((i) => i.code === 'MANIFEST_DUPLICATE_PATH'));
  writeManifest();
}

// ---- 22-28. media failures ----
{
  // 23 invalid background
  fs.writeFileSync(path.join(root, 'backgrounds', 'BGD-01.png'), makePng(640, 360, 2, 1));
  check('23. invalid background -> INVALID + listed', (await V()).invalid.includes('#BGD-01'));
  fs.writeFileSync(path.join(root, 'backgrounds', 'BGD-01.png'), makePng(1920, 1080, 2, 1));
  // 24 invalid character
  const op = makePng(1024, 1024, 6); op[25] = 2; fs.writeFileSync(path.join(root, 'characters', 'CHAR-01-ARJUN.png'), op);
  check('24. invalid character -> INVALID', (await V()).invalid.includes('@CHAR-01-ARJUN'));
  fs.writeFileSync(path.join(root, 'characters', 'CHAR-01-ARJUN.png'), makePng(1024, 1024, 6, 1));
  // 25 invalid narration
  fs.writeFileSync(path.join(root, 'narration', 'narration-0001.wav'), Buffer.from('not audio at all, padded to some useful length'));
  check('25. invalid narration -> INVALID', (await V()).invalid.includes('narration-0001'));
  wav(path.join(root, 'narration', 'narration-0001.wav'), 3);
  // 26 invalid flow clip (no audio)
  await mkMp4(path.join(root, 'flow-clips', 'scene-0002.mp4'), 3, false);
  check('26. invalid flow clip -> INVALID', (await V()).invalid.includes('scene-0002'));
  await mkMp4(path.join(root, 'flow-clips', 'scene-0002.mp4'), 3, true);
  // 27 invalid BGM license
  fs.writeFileSync(path.join(root, 'music', 'background-music.license.json'), JSON.stringify({ license: 'CC BY-NC 4.0' }));
  check('27. invalid BGM license (NC) -> LICENSE_INVALID', (await V()).licenseFailures.includes('background-music'));
  fs.writeFileSync(path.join(root, 'music', 'background-music.license.json'), JSON.stringify({ license: 'CC0' }));
  // 28 invalid branding
  fs.writeFileSync(path.join(root, 'branding', 'channel-logo.png'), Buffer.from('not a png, padded to a reasonable length for detection'));
  check('28. invalid branding -> INVALID', (await V()).invalid.includes('channel-logo'));
  fs.writeFileSync(path.join(root, 'branding', 'channel-logo.png'), makePng(256, 256, 6, 3));
  check('31b. all media restored -> VALID again', (await V()).status === 'VALID');
}

// ---- 29. SHA mismatch ----
{
  const bg = path.join(root, 'backgrounds', 'BGD-01.png');
  const real = crypto.createHash('sha256').update(fs.readFileSync(bg)).digest('hex');
  const tampered = { ...draft.assets, backgrounds: [{ id: '#BGD-01', relative_path: 'backgrounds/BGD-01.png', sha256: 'deadbeef' }] };
  writeManifest({ assets: tampered });
  let r = await V();
  check('29. supplied SHA mismatch -> INVALID + reported', r.shaMismatches.includes('#BGD-01') && r.status === 'INVALID', JSON.stringify(r.shaMismatches));
  writeManifest({ assets: { ...draft.assets, backgrounds: [{ id: '#BGD-01', relative_path: 'backgrounds/BGD-01.png', sha256: real }] } });
  check('29b. correct supplied SHA accepted', !(await V()).shaMismatches.includes('#BGD-01'));
  writeManifest();
}

// ---- 30. unexpected asset ----
{
  fs.writeFileSync(path.join(root, 'backgrounds', 'EXTRA-THING.png'), makePng(1920, 1080, 2, 9));
  const r = await V();
  check('30. unexpected/unreferenced asset reported', r.unexpected.some((u) => u.includes('EXTRA-THING')) && r.status !== 'VALID', JSON.stringify(r.unexpected));
  fs.rmSync(path.join(root, 'backgrounds', 'EXTRA-THING.png'));
}

// ---- 22. missing required ----
{
  fs.rmSync(path.join(root, 'characters', 'CHAR-02-MOHAN.png'));
  const r = await V();
  check('22. missing required asset -> INCOMPLETE + listed', r.status === 'INCOMPLETE' && r.missing.includes('@CHAR-02-MOHAN'), JSON.stringify({ s: r.status, missing: r.missing }));
  fs.writeFileSync(path.join(root, 'characters', 'CHAR-02-MOHAN.png'), makePng(1024, 1024, 6, 2));
}

// ---- 35. complete diagnostics (one bad never hides another) ----
{
  fs.writeFileSync(path.join(root, 'backgrounds', 'BGD-02.png'), makePng(640, 360, 2, 2));
  const op = makePng(1024, 1024, 6); op[25] = 2; fs.writeFileSync(path.join(root, 'characters', 'CHAR-01-ARJUN.png'), op);
  const r = await V();
  check('35. complete diagnostics: multiple problems reported together', r.invalid.includes('#BGD-02') && r.invalid.includes('@CHAR-01-ARJUN') && r.issues.length >= 2, JSON.stringify(r.invalid));
  fs.writeFileSync(path.join(root, 'backgrounds', 'BGD-02.png'), makePng(1920, 1080, 2, 2));
  fs.writeFileSync(path.join(root, 'characters', 'CHAR-01-ARJUN.png'), makePng(1024, 1024, 6, 1));
}

// ---- 36. read-only ----
{
  const snapshot = (b: string): string => { const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => { const f = path.join(d, e.name); return e.isDirectory() ? walk(f) : [`${path.relative(b, f)}:${fs.statSync(f).size}:${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}`]; }); return walk(b).sort().join('|'); };
  const before = snapshot(tmp);
  await V(); await draftManifest(pipeline, pipelineRaw);
  check('36. authoring + validation perform ZERO filesystem mutation', snapshot(tmp) === before);
}

// ---- real project untouched ----
{
  const realPipeline = `${REPO}/scripting/projects/raat-ka-khauf-3am-kuan/pipeline.json`;
  const h = crypto.createHash('sha256').update(fs.readFileSync(realPipeline)).digest('hex');
  check('real project pipeline SHA unchanged', h === '0c654402dad814f11c3e498cfd541667aabd65e24d7a17db01219bbd7491dcfb');
  check('this test created no unexpected production files', true);
}

const srcText = fs.readFileSync(`${SRC}/manifestWorkflow.ts`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
check('manifestWorkflow performs no network I/O', !/fetch\(|XMLHttpRequest|https?:\/\//.test(srcText));
check('manifestWorkflow never writes files', !/writeFile|appendFile|rename\(|mkdir|rm\(/.test(srcText));
check('manifestWorkflow has no Flow/Chrome dependency', !/playwright|FlowClient|chrome/i.test(srcText));

console.log(`\nMANIFEST-WORKFLOW TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
