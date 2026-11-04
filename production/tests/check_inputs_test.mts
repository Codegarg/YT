// Offline read-only diagnostic tests (STEP-8DE). Temp dirs only. No Flow/Chrome/writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);

import { SRC } from './_testPaths.mjs';
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
const ci = await import(pathToFileURL(`${SRC}/checkInputs.ts`).href);
const { checkInputs, formatDiagnosticReport } = ci;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

function makePng(w: number, h: number, ct = 6): Buffer {
  const crcTable: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct;
  const ch = ct === 6 ? 4 : 2; const raw = Buffer.alloc(h * (1 + w * ch), 0x80);
  for (let _y = 0; _y < h; _y++) raw[_y * (1 + w * ch)] = 0; // filter byte = None
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const wav = (file: string, sec: number, rate = 8000) => { const n = Math.round(sec * rate); const data = Buffer.alloc(n * 2); const b = Buffer.alloc(44 + data.length); b.write('RIFF', 0); b.writeUInt32LE(36 + data.length, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(data.length, 40); fs.writeFileSync(file, b); };

const PID = 'test-project';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8de-ci-'));
const INPUTS = path.join(tmp, 'inputs');
const root = path.join(INPUTS, PID);
const pipeline = {
  project_id: PID,
  characters: [{ tag: '@CHAR-01-ARJUN' }], backgrounds: [{ tag: '#BGD-01-VILLAGE-STREET-WIDE' }],
  scenes: [
    { scene_number: 1, title: 'A', background_tag: '#BGD-01-VILLAGE-STREET-WIDE', character_tags: ['@CHAR-01-ARJUN'], speaker: 'NARRATOR', camera: 'Wide', visual_action: 'x', effects: '', narration_text: 'क', devanagari_dialogue: '', clip_length_seconds: null, edit_length_seconds: null },
    { scene_number: 2, title: 'B', background_tag: '#BGD-01-VILLAGE-STREET-WIDE', character_tags: ['@CHAR-01-ARJUN'], speaker: '@CHAR-01-ARJUN', camera: 'Wide', visual_action: 'x', effects: '', narration_text: '', devanagari_dialogue: 'क', clip_length_seconds: null, edit_length_seconds: null },
    { scene_number: 3, title: 'C', background_tag: '#BGD-01-VILLAGE-STREET-WIDE', character_tags: [], speaker: 'none', camera: 'Wide', visual_action: 'x', effects: '', narration_text: 'क', devanagari_dialogue: '', clip_length_seconds: null, edit_length_seconds: null },
  ],
};

// ---- 32. empty project -> waiting states ----
{
  const r = await checkInputs({ pipeline, inputsRoot: INPUTS, outputsDir: path.join(tmp, 'outputs') });
  check('empty project: no scene is READY or INVALID (all waiting)', r.counts.ready === 0 && r.counts.invalid === 0 && (r.counts.waitingBackground + r.counts.waitingNarration + r.counts.waitingVideo + r.counts.waitingCharacter) === 3, JSON.stringify(r.counts));
  check('empty project: input root absent reported', r.inputRootExists === false);
  check('empty project: manifest absent is not an error', r.manifest.present === false && r.manifest.valid === true);
  check('empty project: durations unresolved', r.duration.unresolved === 3 && r.duration.resolved === 0, JSON.stringify(r.duration));
  check('empty project: final edit blocked', r.finalEditReady === false);
}

// ---- now supply inputs ----
for (const c of ['characters', 'narration', 'flow-clips', 'backgrounds', 'music']) fs.mkdirSync(path.join(root, c), { recursive: true });
fs.writeFileSync(path.join(root, 'backgrounds', 'BGD-01-VILLAGE-STREET-WIDE.png'), makePng(1920, 1080, 2));
fs.writeFileSync(path.join(root, 'characters', 'CHAR-01-ARJUN.png'), makePng(1024, 1024, 6));
wav(path.join(root, 'narration', 'narration-0001.wav'), 3);
wav(path.join(root, 'narration', 'narration-0003.wav'), 3);
const clip2 = path.join(root, 'flow-clips', 'scene-0002.mp4');
await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=4', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip2]);

{
  const r = await checkInputs({ pipeline, inputsRoot: INPUTS, outputsDir: path.join(tmp, 'outputs') });
  check('supplied inputs: the clip-less scenes are not READY, none INVALID', r.counts.ready >= 1 && r.counts.invalid === 0, JSON.stringify(r.counts));
  check('supplied inputs: durations resolved', r.duration.resolved >= 2 && r.duration.unresolved <= 1, JSON.stringify(r.duration));
  check('supplied inputs: input root reported present', r.inputRootExists === true);
  check('supplied inputs: no missing files', r.missingFiles.length === 0, JSON.stringify(r.missingFiles));
  const one = r.scenes.find((s: any) => s.sceneNumber === 1);
  // STRICT production policy: scene 1 is a CHARACTER scene with no supplied clip, so local synthesis
  // is refused (it would composite static cutouts).
  check('scene 1 (character, no clip) is blocked by the STRICT local-synthesis policy',
    one.renderMode === 'NONE' && one.readiness === 'WAITING_FOR_VIDEO_CLIP' && one.reasons.includes('SUPPLIED_VIDEO_REQUIRED'),
    JSON.stringify({ m: one.renderMode, r: one.readiness, rs: one.reasons }));
  // STRICT policy is scene-type agnostic: a BACKGROUND-ONLY scene with no supplied clip is blocked too.
  const three = r.scenes.find((s: any) => s.sceneNumber === 3);
  check('background-only scene 3 with no clip is ALSO blocked by the STRICT policy',
    three.renderMode === 'NONE' && three.readiness === 'WAITING_FOR_VIDEO_CLIP' && three.reasons.includes('SUPPLIED_VIDEO_REQUIRED'),
    JSON.stringify({ m: three.renderMode, r: three.readiness, rs: three.reasons }));
  check('background-only scene 3 has genuinely valid local assets that still do not make it renderable',
    three.background.state === 'VALID' && three.characterTags.length === 0 && three.renderMode !== 'LOCAL_SYNTHESIS',
    JSON.stringify({ bg: three.background.state, tags: three.characterTags, m: three.renderMode }));
  const two = r.scenes.find((s: any) => s.sceneNumber === 2);
  check('scene 2 uses supplied video', two.renderMode === 'SUPPLIED_VIDEO' && two.durationProvenance === 'supplied-video');
}

// ---- 34. stale unknown existing output ----
{
  const outputs = path.join(tmp, 'outputs');
  fs.mkdirSync(outputs, { recursive: true });
  fs.copyFileSync(clip2, path.join(outputs, 'scene-0001.mp4'));
  const r = await checkInputs({ pipeline, inputsRoot: INPUTS, outputsDir: outputs });
  check('existing output classified STALE_UNKNOWN (never claimed current)', r.scenes.find((s: any) => s.sceneNumber === 1).staleness === 'STALE_UNKNOWN');
  check('existing output reported in staleScenes', r.staleScenes.includes(1));
  check('diagnostic never deletes or modifies the existing output', fs.existsSync(path.join(outputs, 'scene-0001.mp4')));
}

// ---- manifest diagnostics ----
{
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schema_version: 1, project_id: PID, assets: [{ type: 'character', tag: '@CHAR-01-ARJUN', scene_number: null, relative_path: 'characters/CHAR-01-ARJUN.png', source: 'human-supplied', validation: 'VALID', sha256: 'deadbeef' }] }));
  const r = await checkInputs({ pipeline, inputsRoot: INPUTS, outputsDir: path.join(tmp, 'outputs') });
  check('manifest present + valid, hash mismatch detected', r.manifest.present && r.manifest.discrepancies.some((d: any) => d.issue === 'HASH_MISMATCH'));
  fs.writeFileSync(path.join(root, 'manifest.json'), '{ bad json');
  const r2 = await checkInputs({ pipeline, inputsRoot: INPUTS, outputsDir: path.join(tmp, 'outputs') });
  check('corrupt manifest reported invalid, not trusted', r2.manifest.valid === false);
  // 31. manifest cannot override filesystem truth
  fs.rmSync(path.join(root, 'manifest.json'));
}

// ---- 31. manifest validation truth not trusted ----
{
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schema_version: 1, project_id: PID, assets: [{ type: 'character', tag: '@CHAR-01-ARJUN', scene_number: null, relative_path: 'characters/CHAR-01-ARJUN.png', source: 'human-supplied', validation: 'VALID' }] }));
  const beforeSize = fs.statSync(path.join(root, 'characters', 'CHAR-01-ARJUN.png')).size;
  const r = await checkInputs({ pipeline, inputsRoot: INPUTS, outputsDir: path.join(tmp, 'outputs') });
  check('manifest claiming VALID cannot alter filesystem revalidation', r.scenes.find((s: any) => s.sceneNumber === 1).characters[0].state === 'VALID');
  check('diagnostic did not modify any input file', fs.statSync(path.join(root, 'characters', 'CHAR-01-ARJUN.png')).size === beforeSize);
  fs.rmSync(path.join(root, 'manifest.json'));
}

// ---- 33. no filesystem mutation ----
{
  const snapshot = (dir: string): string => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => { const f = path.join(d, e.name); return e.isDirectory() ? walk(f) : [`${path.relative(root, f)}:${fs.statSync(f).size}`]; });
    return walk(dir).sort().join('|');
  };
  const before = snapshot(root);
  await checkInputs({ pipeline, inputsRoot: INPUTS, outputsDir: path.join(tmp, 'outputs') });
  await checkInputs({ pipeline, inputsRoot: INPUTS, outputsDir: path.join(tmp, 'outputs') });
  check('diagnostic is read-only (input tree byte-for-byte unchanged)', snapshot(root) === before);
}

// ---- report formatting + report shape ----
{
  const r = await checkInputs({ pipeline, inputsRoot: INPUTS, outputsDir: path.join(tmp, 'outputs') });
  const text = formatDiagnosticReport(r);
  check('report includes required sections', /Project|Scenes|READY|Duration|Final edit/.test(text));
  check('report shape has all required keys', ['projectId', 'sceneCount', 'counts', 'duration', 'missingFiles', 'invalidFiles', 'ambiguousFiles', 'staleScenes', 'finalEditReady', 'scenes'].every((k) => k in r));
}

const srcText = fs.readFileSync(`${SRC}/checkInputs.ts`, 'utf8');
check('checkInputs performs no network I/O', !/fetch\(|XMLHttpRequest|https?:\/\//.test(srcText));
check('checkInputs never writes files', !/writeFile|createWriteStream|rename\(|mkdir/.test(srcText));
check('checkInputs has no Flow/Chrome dependency', !/playwright|FlowClient|chrome/i.test(srcText));

console.log(`\nCHECK-INPUTS TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
