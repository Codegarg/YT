// Offline video-clip validation tests (STEP-8DE). Synthetic media in OS temp dirs only.
// No Flow/Chrome/network. ffprobe via FFPROBE_PATH/FFMPEG_PATH or PATH.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);

import { SRC } from './_testPaths.mjs';
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
const vc = await import(pathToFileURL(`${SRC}/videoClip.ts`).href);
const { validateVideoClip, validateClipProbe, computeFileSha256, SUPPORTED_CLIP_EXTENSIONS, MIN_CLIP_WIDTH } = vc;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8de-vc-'));

// ---- pure probe validation ----
check('probe: no video stream -> invalid', validateClipProbe({ streams: [{ codec_type: 'audio', codec_name: 'aac' }], format: { duration: '3' } }).ok === false);
check('probe: no audio stream -> invalid (edit.ts requires audio)', validateClipProbe({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }], format: { duration: '3' } }).ok === false);
check('probe: zero duration -> invalid', validateClipProbe({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }, { codec_type: 'audio', codec_name: 'aac', channels: 2 }], format: { duration: '0' } }).ok === false);
check('probe: NaN duration -> invalid', validateClipProbe({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }, { codec_type: 'audio', codec_name: 'aac' }], format: { duration: 'NaN' } }).ok === false);
check('probe: undersized resolution -> invalid', validateClipProbe({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 320, height: 240 }, { codec_type: 'audio', codec_name: 'aac' }], format: { duration: '3' } }).ok === false);
check('probe: valid document -> ok', validateClipProbe({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }, { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' }], format: { duration: '3.5' } }).ok === true);
check('supported extensions include .mp4', SUPPORTED_CLIP_EXTENSIONS.includes('.mp4'));

// ---- real synthetic media ----
const good = path.join(tmp, 'scene-0001.mp4');
await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=3', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', good]);
const noAudio = path.join(tmp, 'scene-0002.mp4');
await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=3', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', noAudio]);
const malformed = path.join(tmp, 'scene-0003.mp4'); fs.writeFileSync(malformed, Buffer.from('this is definitely not a valid mp4 container at all'));
const tiny = path.join(tmp, 'scene-0004.mp4'); fs.writeFileSync(tiny, Buffer.alloc(0));

check('missing file -> MISSING', (await validateVideoClip(path.join(tmp, 'nope.mp4'))).state === 'MISSING');
check('unsupported extension -> UNSUPPORTED', (await validateVideoClip(path.join(tmp, 'scene-0001.mkv'))).state === 'UNSUPPORTED');
check('zero-byte -> INVALID', (await validateVideoClip(tiny)).state === 'INVALID');
check('malformed container -> INVALID', (await validateVideoClip(malformed)).state === 'INVALID');
check('video without audio -> INVALID (edit.ts contract)', (await validateVideoClip(noAudio)).state === 'INVALID');

const valid = await validateVideoClip(good);
check('valid clip -> VALID with duration/streams/sha', valid.state === 'VALID' && Math.abs(valid.durationSeconds - 3) <= 0.3 && valid.video.codec === 'h264' && valid.audio.codec === 'aac' && /^[0-9a-f]{64}$/.test(valid.sha256), JSON.stringify(valid));
check('valid clip reports usable resolution', valid.video.width === 1920 && valid.video.height === 1080);
check('sha256 is stable across calls', (await computeFileSha256(good)) === valid.sha256);
check('minimum width constant sane', MIN_CLIP_WIDTH === 640);

// ---- no mutation ----
const before = fs.statSync(good).size;
await validateVideoClip(good);
check('validation never mutates the clip', fs.statSync(good).size === before);

const srcText = fs.readFileSync(`${SRC}/videoClip.ts`, 'utf8');
check('videoClip performs no network I/O', !/fetch\(|XMLHttpRequest|https?:\/\//.test(srcText));
check('videoClip never writes files', !/writeFile|createWriteStream|rename\(|mkdir/.test(srcText));
check('videoClip has no Flow/Chrome dependency', !/playwright|FlowClient|chrome/i.test(srcText));

console.log(`\nVIDEO-CLIP TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
