// Offline regression tests for the READ-ONLY media QA probe (STEP-QA-1).
// No Chrome/Flow/OpenAI/network. Synthetic media lives in a temp directory only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { SRC, FF } from './_testPaths.mjs';

const exec = promisify(execFile);
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;

const QA = await import(pathToFileURL(`${SRC}/mediaQa.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

// ================== pure parsers ==================
{
  const stderr = [
    '[blackdetect @ 000001] black_start:1.000 black_end:2.000 black_duration:1.000',
    '[blackdetect @ 000001] black_start:10.250 black_end:11.000 black_duration:0.750',
    'frame=  120 fps=0.0 q=-0.0 size=N/A time=00:00:04.80 bitrate=N/A speed= 400x',
  ].join('\n');
  const segments = QA.parseBlackDetect(stderr);
  check('blackdetect: two segments parsed', segments.length === 2, segments);
  check('blackdetect: start/end/duration preserved', segments[0].start === 1 && segments[0].end === 2 && segments[0].duration === 1, segments[0]);
  check('blackdetect: empty log -> no segments', QA.parseBlackDetect('').length === 0);
  check('blackdetect: malformed line ignored', QA.parseBlackDetect('black_start:?? black_end:?? black_duration:??').length === 0);
}

{
  const stderr = [
    '[freezedetect @ 000002] lavfi.freezedetect.freeze_start: 2.500',
    '[freezedetect @ 000002] lavfi.freezedetect.freeze_duration: 3.250',
    '[freezedetect @ 000002] lavfi.freezedetect.freeze_end: 5.750',
    '[freezedetect @ 000002] lavfi.freezedetect.freeze_start: 9.000',
    '[freezedetect @ 000002] lavfi.freezedetect.freeze_duration: 1.500',
  ].join('\n');
  const segments = QA.parseFreezeDetect(stderr);
  check('freezedetect: completed segment uses real end', segments[0] && segments[0].start === 2.5 && segments[0].end === 5.75, segments[0]);
  check('freezedetect: open segment closes from duration', segments[1] && segments[1].start === 9 && segments[1].end === 10.5, segments[1]);
  check('freezedetect: empty log -> no segments', QA.parseFreezeDetect('').length === 0);
}

{
  const stderr = [
    '[Parsed_ebur128_0 @ 000003] t: 0.1  M: -70.0 S: -70.0 I: -70.0 LUFS LRA: 0.0 LU',
    '[Parsed_ebur128_0 @ 000003] t: 4.0  M: -20.0 S: -21.0 I: -21.0 LUFS LRA: 0.0 LU',
    '[Parsed_ebur128_0 @ 000003] Summary:',
    '',
    '  Integrated loudness:',
    '    I:         -13.8 LUFS',
    '    Threshold: -24.1 LUFS',
    '',
    '  Loudness range:',
    '    LRA:         4.2 LU',
    '    Threshold: -34.1 LUFS',
    '',
    '  True peak:',
    '    Peak:       -1.1 dBFS',
  ].join('\n');
  const reading = QA.parseEbur128(stderr);
  check('ebur128: summary integrated loudness wins over per-frame lines', reading.integratedLufs === -13.8, reading);
  check('ebur128: LRA parsed', reading.rangeLu === 4.2, reading);
  check('ebur128: true peak parsed', reading.truePeakDb === -1.1, reading);
  check('ebur128: no summary -> nulls, never a guessed value', QA.parseEbur128('nothing here').integratedLufs === null);
}

{
  const stderr = [
    '[Parsed_volumedetect_0 @ 000004] mean_volume: -27.4 dB',
    '[Parsed_volumedetect_0 @ 000004] max_volume: -1.2 dB',
    '[Parsed_volumedetect_0 @ 000004] histogram_0db: 0',
  ].join('\n');
  const peak = QA.parseVolumedetect(stderr);
  check('volumedetect: max/mean/clipped parsed', peak.maxVolumeDb === -1.2 && peak.meanVolumeDb === -27.4 && peak.clippedSamples === 0, peak);
  check('volumedetect: empty log -> nulls', QA.parseVolumedetect('').maxVolumeDb === null);
}

// ================== severity policy (pure) ==================
const validClip = { state: 'VALID', bytes: 1000, durationSeconds: 300, video: { width: 1920, height: 1080 } };
{
  const report = QA.evaluateMediaQa({ input: 'a.mp4', clip: validClip, black: [], freeze: [], loudness: { integratedLufs: -14, rangeLu: 5, truePeakDb: -1.5 }, peak: { maxVolumeDb: -1.5, meanVolumeDb: -20, clippedSamples: 0 } });
  check('policy: clean 1080p/16:9/-14 LUFS clip passes', report.ok === true && report.findings.length === 0, report.findings);
  check('policy: report is explicitly read-only', report.readOnly === true);
  check('policy: branding gap is disclosed, not assumed clean', report.skipped.some((s: string) => s.startsWith('branding_detection')));
}
{
  const report = QA.evaluateMediaQa({ input: 'b.mp4', clip: validClip, peak: { maxVolumeDb: 0, meanVolumeDb: -10, clippedSamples: 12 } });
  check('policy: clipped samples are a hard FAIL', report.ok === false && report.findings.some((f: any) => f.code === 'AUDIO_CLIPPING' && f.severity === 'FAIL'), report.findings);
}
{
  const report = QA.evaluateMediaQa({ input: 'c.mp4', clip: validClip, loudness: { integratedLufs: -0.2, rangeLu: 1, truePeakDb: 0 } });
  check('policy: true peak at full scale is a hard FAIL', report.findings.some((f: any) => f.code === 'TRUE_PEAK_CLIPPING' && f.severity === 'FAIL'), report.findings);
}
{
  const report = QA.evaluateMediaQa({ input: 'd.mp4', clip: { state: 'VALID', bytes: 10, durationSeconds: 60, video: { width: 1280, height: 720 } } });
  check('policy: 720p passes minimum but warns about the 1080p target', report.ok === true && report.findings.some((f: any) => f.code === 'BELOW_1080P_TARGET' && f.severity === 'WARN'), report.findings);
}
{
  const report = QA.evaluateMediaQa({ input: 'e.mp4', clip: { state: 'VALID', bytes: 10, durationSeconds: 60, video: { width: 640, height: 480 } }, options: { minHeight: 720 } });
  check('policy: below-minimum resolution is a hard FAIL', report.ok === false && report.findings.some((f: any) => f.code === 'RESOLUTION_BELOW_MINIMUM'), report.findings);
}
{
  const report = QA.evaluateMediaQa({ input: 'f.mp4', clip: { state: 'VALID', bytes: 10, durationSeconds: 60, video: { width: 1000, height: 1000 } } });
  check('policy: non-16:9 aspect is a hard FAIL', report.ok === false && report.findings.some((f: any) => f.code === 'ASPECT_NOT_16_9'), report.findings);
}
{
  const report = QA.evaluateMediaQa({ input: 'g.mp4', clip: { state: 'VALID', bytes: 10, durationSeconds: 300, video: { width: 1920, height: 1080 } }, options: { expectDurationSeconds: 310, durationToleranceSeconds: 2 } });
  check('policy: duration outside tolerance is a hard FAIL', report.ok === false && report.findings.some((f: any) => f.code === 'DURATION_OUT_OF_TOLERANCE'), report.findings);
}
{
  const report = QA.evaluateMediaQa({ input: 'h.mp4', clip: validClip, black: [{ start: 0, end: 1, duration: 1 }], freeze: [{ start: 5, duration: 4, end: 9 }] });
  check('policy: black/freeze frames are warnings, never silent', report.ok === true && report.findings.some((f: any) => f.code === 'BLACK_FRAMES_DETECTED') && report.findings.some((f: any) => f.code === 'FREEZE_FRAMES_DETECTED'), report.findings);
}
{
  const report = QA.evaluateMediaQa({ input: 'i.mp4', clip: { state: 'INVALID', reason: 'no audio stream' } });
  check('policy: unusable container is a hard FAIL and still returns a report', report.ok === false && report.findings[0].code === 'CONTAINER_INVALID', report.findings);
}
{
  const report = QA.evaluateMediaQa({ input: 'j.mp4', clip: validClip, analysisErrors: ['freezedetect: boom'] });
  check('policy: analysis failure surfaces as a warning', report.findings.some((f: any) => f.code === 'ANALYSIS_FAILED'), report.findings);
}

// ================== end-to-end on synthetic media ==================
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-'));
try {
  const media = path.join(tmp, 'final-title.mp4');
  // 1s black + 2s motion + 1s black, with a quiet tone: exercises blackdetect, ebur128, volumedetect.
  await exec(process.env.FFMPEG_PATH!, [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:d=1:r=25',
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=2',
    '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:d=1:r=25',
    '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=4',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map', '[v]', '-map', '3:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-t', '4',
    media,
  ]);

  const before = { size: fs.statSync(media).size, mtime: fs.statSync(media).mtimeMs, entries: fs.readdirSync(tmp).sort() };
  const report = await QA.runMediaQa({ input: media, blackMinSeconds: 0.5, freezeMinSeconds: 3 });
  const after = { size: fs.statSync(media).size, mtime: fs.statSync(media).mtimeMs, entries: fs.readdirSync(tmp).sort() };

  check('e2e: report identifies a 16:9 720p clip', report.width === 1280 && report.height === 720 && Math.abs((report.aspectRatio ?? 0) - 16 / 9) < 0.02, { w: report.width, h: report.height });
  check('e2e: black segments detected', (report.black?.segments.length ?? 0) >= 1, report.black);
  check('e2e: integrated loudness measured', typeof report.loudness?.integratedLufs === 'number' && Number.isFinite(report.loudness!.integratedLufs), report.loudness);
  check('e2e: sample peak measured', typeof report.peak?.maxVolumeDb === 'number', report.peak);
  check('e2e: no hard FAIL for a merely quiet clip', report.ok === true && report.findings.every((f: any) => f.severity !== 'FAIL'), report.findings);
  check('e2e: probe NEVER modifies the media', after.size === before.size && after.mtime === before.mtime, { before, after });
  check('e2e: probe NEVER creates files beside the media', JSON.stringify(after.entries) === JSON.stringify(before.entries), { before: before.entries, after: after.entries });

  const missing = await QA.runMediaQa({ input: path.join(tmp, 'nope.mp4') });
  check('e2e: missing file -> FAIL report, no throw', missing.ok === false && missing.findings[0].code === 'CONTAINER_INVALID', missing.findings);

  const text = fs.readFileSync(`${SRC}/mediaQa.ts`, 'utf8');
  check('source: no network/API client', !/fetch\(|XMLHttpRequest|new OpenAI|from 'openai'|zernio\.|youtube\.googleapis/.test(text));
  check('source: no write APIs', !/writeFile|appendFile|createWriteStream|mkdir\(|rename\(|rm\(|unlink\(|copyFile/.test(text));
  check('source: no Flow/Chrome/Playwright dependency', !/playwright|FlowClient|chrome|flowClient/i.test(text));
  check('source: every media analysis writes to the null muxer only', (text.match(/-f', 'null'/g) ?? []).length >= 4);

  console.log(`\nMEDIA-QA TESTS PASSED (${passed} checks)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
