// PHASE 4 media QA expansion regression tests.
//
// Fully offline: synthetic media is generated with the local ffmpeg into a temporary directory.
// Chrome/Flow/Gemini/OpenAI are never opened, no credits are spent, nothing is uploaded or
// published, and the real production project is never read or written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { SRC, FF } from './_testPaths.mjs';

const exec = promisify(execFile);
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;

const QA = await import(pathToFileURL(`${SRC}/mediaQa.ts`).href);
const PQ = await import(pathToFileURL(`${SRC}/projectMediaQa.ts`).href);
const AP = await import(pathToFileURL(`${SRC}/approval.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pad4 = (n: number) => String(n).padStart(4, '0');

/** Calibrated so integrated loudness lands near the -14 LUFS narrator target. */
const TONE = (seconds: number) => `aevalsrc=0.35*sin(2*PI*440*t):s=48000:d=${seconds}`;
const SILENCE = (seconds: number) => `anullsrc=r=48000:cl=stereo:d=${seconds}`;

const FFMPEG = process.env.FFMPEG_PATH!;

async function mkVideo(
  out: string,
  options: { seconds?: number; rate?: number; video?: string; audio?: string | null; vf?: string } = {},
): Promise<void> {
  const seconds = options.seconds ?? 2;
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', options.video ?? `testsrc=size=1280x720:rate=${options.rate ?? 24}:duration=${seconds}`,
  ];
  if (options.audio !== null) args.push('-f', 'lavfi', '-i', options.audio ?? TONE(seconds));
  if (options.vf) args.push('-vf', options.vf);
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (options.audio !== null) args.push('-c:a', 'aac', '-shortest');
  args.push(out);
  await exec(FFMPEG, args);
}

async function mkAudio(out: string, seconds: number): Promise<void> {
  await exec(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', TONE(seconds), '-c:a', 'pcm_s16le', out]);
}

/** Relative path -> {size, mtime, sha256} snapshot used to prove QA never writes. */
function snapshot(dir: string, base = dir): Record<string, { size: number; mtimeMs: number; sha256: string }> {
  const out: Record<string, { size: number; mtimeMs: number; sha256: string }> = {};
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, snapshot(full, base));
    else if (entry.isFile()) {
      const stat = fs.statSync(full);
      out[path.relative(base, full)] = { size: stat.size, mtimeMs: stat.mtimeMs, sha256: sha(full) };
    }
  }
  return out;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-qa-'));

try {
  const media = path.join(tmp, 'media');
  fs.mkdirSync(media, { recursive: true });

  // ============================================================ engine level
  // 1. Valid video passes.
  const valid = path.join(media, 'valid.mp4');
  await mkVideo(valid, { seconds: 2 });
  const validReport = await QA.runMediaQa({ input: valid, targetHeight: 720 });
  check('1 valid video passes', validReport.status === 'PASS' && validReport.ok === true, validReport.findings);
  check('1b valid report exposes an artifact hash and file metadata',
    /^[0-9a-f]{64}$/.test(String(validReport.sha256)) && validReport.bytes === fs.statSync(valid).size
    && validReport.width === 1280 && validReport.height === 720 && validReport.fps === 24,
    { sha: validReport.sha256, bytes: validReport.bytes, fps: validReport.fps });
  check('1c every check carries an explicit status', validReport.checks.length > 0 && validReport.checks.every((c: any) => ['PASS', 'WARNING', 'FAIL', 'SKIPPED'].includes(c.status)));

  // 2. Missing video fails.
  const missingReport = await QA.runMediaQa({ input: path.join(media, 'nope.mp4') });
  check('2 missing video fails', missingReport.status === 'FAIL' && missingReport.findings[0].code === 'CONTAINER_INVALID', missingReport.findings);
  check('2b missing file is identified specifically', missingReport.checks.some((c: any) => c.id === 'file.exists' && c.status === 'FAIL') && missingReport.sha256 === null);

  // 3. Corrupted video fails.
  const corrupt = path.join(media, 'corrupt.mp4');
  fs.writeFileSync(corrupt, 'this is definitely not a video container');
  const corruptReport = await QA.runMediaQa({ input: corrupt });
  check('3 corrupted video fails', corruptReport.status === 'FAIL' && corruptReport.findings[0].code === 'CONTAINER_INVALID', corruptReport.findings);

  // Empty file fails and is named.
  const empty = path.join(media, 'empty.mp4');
  fs.writeFileSync(empty, '');
  const emptyReport = await QA.runMediaQa({ input: empty });
  check('3b empty output file fails', emptyReport.status === 'FAIL' && emptyReport.findings[0].code === 'CONTAINER_INVALID' && emptyReport.checks.some((c: any) => c.id === 'file.nonempty' && c.status === 'FAIL'));

  // 4. Missing video stream fails.
  const audioOnly = path.join(media, 'audio-only.mp4');
  await exec(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', TONE(1), '-c:a', 'aac', audioOnly]);
  const noVideoReport = await QA.runMediaQa({ input: audioOnly });
  check('4 missing video stream fails', noVideoReport.status === 'FAIL' && noVideoReport.findings.some((f: any) => f.code === 'NO_VIDEO_STREAM' && f.severity === 'FAIL'), noVideoReport.findings);

  // 5. Missing required audio stream fails.
  const videoOnly = path.join(media, 'video-only.mp4');
  await mkVideo(videoOnly, { seconds: 2, audio: null });
  const noAudioReport = await QA.runMediaQa({ input: videoOnly });
  check('5 missing required audio stream fails', noAudioReport.status === 'FAIL' && noAudioReport.findings.some((f: any) => f.code === 'NO_AUDIO_STREAM' && f.severity === 'FAIL'), noAudioReport.findings);
  const optionalAudioReport = await QA.runMediaQa({ input: videoOnly, requireAudio: false });
  check('5b optional audio is skipped, not failed', optionalAudioReport.status !== 'FAIL' && optionalAudioReport.checks.some((c: any) => c.id === 'audio.stream' && c.status === 'SKIPPED'));

  // 6. Unexpected resolution is detected.
  const dimsReport = await QA.runMediaQa({ input: valid, expectWidth: 1920, expectHeight: 1080 });
  check('6 unexpected resolution detected', dimsReport.status === 'FAIL' && dimsReport.checks.some((c: any) => c.id === 'video.dimensions' && c.status === 'FAIL' && c.expected === '1920x1080' && c.actual === '1280x720'), dimsReport.checks);

  // 7. Unexpected frame rate is detected.
  const fpsReport = await QA.runMediaQa({ input: valid, expectFps: 30 });
  check('7 unexpected frame rate detected', fpsReport.status === 'FAIL' && fpsReport.checks.some((c: any) => c.id === 'video.fps' && c.status === 'FAIL' && c.expected === 30 && c.actual === 24), fpsReport.checks);

  // 8. Duration mismatch is detected.
  const durationReport = await QA.runMediaQa({ input: valid, expectDurationSeconds: 10 });
  check('8 duration mismatch detected', durationReport.status === 'FAIL' && durationReport.checks.some((c: any) => c.id === 'duration.expected' && c.status === 'FAIL'), durationReport.checks);

  // 9. Black-frame detection works.
  const blackClip = path.join(media, 'black.mp4');
  await mkVideo(blackClip, { seconds: 2, video: 'color=c=black:size=1280x720:rate=24:duration=2' });
  const blackReport = await QA.runMediaQa({ input: blackClip, targetHeight: 720 });
  check('9 black frames detected', (blackReport.black?.segments.length ?? 0) >= 1 && blackReport.checks.some((c: any) => c.id === 'visual.black' && c.status === 'WARNING'), blackReport.black);
  check('9b black frames warn instead of failing', blackReport.ok === true && blackReport.status === 'WARNING');

  // 10. Intentional dark footage does not automatically fail.
  const darkClip = path.join(media, 'dark.mp4');
  await mkVideo(darkClip, { seconds: 2, video: 'color=c=0x202020:size=1280x720:rate=24:duration=2' });
  const darkReport = await QA.runMediaQa({ input: darkClip, targetHeight: 720 });
  check('10 intentionally dark footage passes', darkReport.status === 'PASS' && (darkReport.black?.segments.length ?? 0) === 0, darkReport.findings);

  // 11. Frozen-frame detection works.
  const stillClip = path.join(media, 'still.mp4');
  await mkVideo(stillClip, { seconds: 4, video: 'color=c=blue:size=1280x720:rate=24:duration=4' });
  const stillReport = await QA.runMediaQa({ input: stillClip, targetHeight: 720 });
  check('11 frozen frames detected', (stillReport.freeze?.segments.length ?? 0) >= 1 && stillReport.checks.some((c: any) => c.id === 'visual.freeze' && c.status === 'WARNING'), stillReport.freeze);

  // 12. Intentional still shots do not automatically fail.
  check('12 still shots warn instead of failing', stillReport.ok === true && stillReport.status === 'WARNING' && stillReport.checks.every((c: any) => c.status !== 'FAIL'));
  const stillAccepted = await QA.runMediaQa({ input: stillClip, targetHeight: 720, skipFreeze: true });
  check('12b intentional stills can be accepted explicitly', stillAccepted.status === 'PASS' && stillAccepted.freeze === null);

  // 13. Audio clipping is detected.
  const clippedClip = path.join(media, 'clipped.mp4');
  await mkVideo(clippedClip, { seconds: 2, audio: 'aevalsrc=2*sin(2*PI*440*t):s=48000:d=2' });
  const clippedReport = await QA.runMediaQa({ input: clippedClip, targetHeight: 720 });
  check('13 audio clipping detected', clippedReport.status === 'FAIL' && clippedReport.findings.some((f: any) => f.code === 'AUDIO_CLIPPING' && f.severity === 'FAIL'), clippedReport.findings);

  // 14. Intentional silence does not automatically fail.
  const silentClip = path.join(media, 'silent.mp4');
  await mkVideo(silentClip, { seconds: 2, audio: SILENCE(2) });
  const silentDefault = await QA.runMediaQa({ input: silentClip, targetHeight: 720 });
  check('14 an unexpected silent track is detected', silentDefault.findings.some((f: any) => f.code === 'AUDIO_SILENT'), silentDefault.findings);
  const silentAccepted = await QA.runMediaQa({ input: silentClip, targetHeight: 720, allowAudioSilence: true });
  check('14b intentional silence does not automatically fail', silentAccepted.ok === true && silentAccepted.checks.every((c: any) => c.status !== 'FAIL'), silentAccepted.findings);
  const silentSkipped = await QA.runMediaQa({ input: silentClip, targetHeight: 720, skipSilence: true });
  check('14c silence analysis can be disabled explicitly', silentSkipped.status !== 'FAIL' && silentSkipped.silence === null && silentSkipped.checks.some((c: any) => c.id === 'audio.silence' && c.status === 'SKIPPED'));

  // 15. Audio/video duration mismatch is detected.
  const avClip = path.join(media, 'av-mismatch.mp4');
  await exec(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=24:duration=4',
    '-f', 'lavfi', '-i', TONE(2),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    avClip,
  ]);
  const avReport = await QA.runMediaQa({ input: avClip, targetHeight: 720 });
  check('15 audio/video duration mismatch detected', avReport.status === 'FAIL' && avReport.findings.some((f: any) => f.code === 'AV_DURATION_MISMATCH' && f.severity === 'FAIL'), avReport.findings);

  // =========================================================== project level
  const projectId = 'phase4-fixture';
  const outputsRoot = path.join(tmp, 'outputs');
  const outputsDir = path.join(outputsRoot, projectId);
  const inputRoot = path.join(tmp, 'inputs', projectId);
  const narrationDir = path.join(inputRoot, 'narration');
  fs.mkdirSync(outputsDir, { recursive: true });
  fs.mkdirSync(narrationDir, { recursive: true });

  const scenes: any[] = [];
  for (let n = 1; n <= 3; n++) {
    const asset = `scene-${pad4(n)}`;
    const clip = path.join(outputsDir, `${asset}.mp4`);
    await mkVideo(clip, { seconds: 2, vf: `hue=h=${n * 60}` });
    fs.writeFileSync(path.join(outputsDir, `${asset}.json`), JSON.stringify({
      scene_number: n,
      render_key: `render-${n}`,
      output_hash: sha(clip),
      output_path: `${asset}.mp4`,
    }));
    scenes.push({
      scene_number: n,
      speaker: n === 2 ? '@CHAR-01' : 'NARRATOR',
      devanagari_dialogue: n === 2 ? 'नमस्ते' : '',
      narration_text: n === 2 ? '' : 'कहानी',
      edit_length_seconds: 2,
    });
  }
  for (const n of [1, 3]) await mkAudio(path.join(narrationDir, `narration-${pad4(n)}.wav`), 2);
  const finalPath = path.join(outputsDir, 'final-title.mp4');
  await mkVideo(finalPath, { seconds: 4, rate: 30 });
  fs.copyFileSync(finalPath, path.join(outputsDir, 'final-with-fades.mp4'));
  const pipeline = { project_id: projectId, scenes };

  const frostState = snapshot(outputsDir);
  const qaOptions = {
    projectId,
    outputsDir,
    inputRoot,
    pipeline,
    now: '2026-01-01T00:00:00.000Z',
    ffmpegPath: process.env.FFMPEG_PATH,
    ffprobePath: process.env.FFPROBE_PATH,
  };
  const projectReport = await PQ.runProjectMediaQa(qaOptions);

  // 18 (first half). Valid existing media remains reusable: a full project QA passes.
  check('18 existing valid project media passes project QA', projectReport.status === 'PASS' && projectReport.counts.blockers === 0, { counts: projectReport.counts, checks: projectReport.checks.filter((c: any) => c.status !== 'PASS' && c.status !== 'SKIPPED') });
  check('18b project QA evaluates every scene, both narration files and the final render',
    projectReport.artifacts.filter((a: any) => a.kind === 'scene').length === 3
    && projectReport.artifacts.filter((a: any) => a.kind === 'narration').length === 2
    && projectReport.artifacts.filter((a: any) => a.kind === 'final').length === 1);
  check('18c artifact hash identifies the exact final bytes', projectReport.artifactHash === sha(finalPath));

  // 16. Missing scene clip is detected.
  const withMissingScene = await PQ.runProjectMediaQa({
    ...qaOptions,
    scenes: [...PQ.scenesFromPipeline(pipeline), { sceneNumber: 4, narrationRequired: false }],
  });
  check('16 missing scene clip detected', withMissingScene.status === 'FAIL' && withMissingScene.checks.some((c: any) => c.asset === 'scene-0004' && c.id === 'file.exists' && c.status === 'FAIL'), withMissingScene.checks.filter((c: any) => c.status === 'FAIL'));
  check('16b a missing final render yields a blocker and no artifact hash', await (async () => {
    const report = await PQ.runProjectMediaQa({ ...qaOptions, finalPath: path.join(outputsDir, 'final-missing.mp4') });
    return report.status === 'FAIL' && report.artifactHash === null;
  })());

  // 17. Scene ordering errors are detected.
  const badOrder = PQ.evaluateSceneOrder([1, 3, 2]);
  check('17 scene ordering errors detected (pure)', badOrder.status === 'FAIL' && badOrder.problems.length > 0, badOrder);
  check('17b duplicate/gapped scene numbers detected', PQ.evaluateSceneOrder([1, 2, 2]).status === 'FAIL' && PQ.evaluateSceneOrder([1, 3]).status === 'FAIL');
  const outOfOrder = await PQ.runProjectMediaQa({ ...qaOptions, scenes: [scenes[0], scenes[2], scenes[1]] });
  check('17c out-of-order manifest is flagged in the report', outOfOrder.scenes.checks.some((c: any) => c.id === 'scenes.order' && c.status === 'FAIL'));

  // 18 (second half) + 23. Re-running QA is reusable and never mutates media/state.
  const rerun = await PQ.runProjectMediaQa(qaOptions);
  check('18d QA rerun reproduces the same result', rerun.status === projectReport.status && rerun.artifactHash === projectReport.artifactHash);
  check('23 QA does not modify media, sidecars or any output file', JSON.stringify(snapshot(outputsDir)) === JSON.stringify(frostState));
  check('23b QA does not write approval records or generation ledgers',
    !fs.existsSync(path.join(outputsDir, 'approval.json'))
    && !fs.existsSync(path.join(outputsDir, 'flow-scenes'))
    && !fs.existsSync(path.join(outputsDir, 'checkpoints')));

  // 19. QA JSON is valid and stable.
  check('19 QA JSON round-trips and is stable', PQ.stableStringify(rerun) === PQ.stableStringify(projectReport)
    && JSON.parse(JSON.stringify(projectReport)).status === projectReport.status);
  check('19b report hash is deterministic for identical inputs', rerun.reportHash === projectReport.reportHash && /^[0-9a-f]{64}$/.test(projectReport.reportHash));

  // ======================================================= approval integration
  const STAGE_KEY = 'a'.repeat(64);
  fs.writeFileSync(path.join(outputsDir, 'final-title.mp4.stage'), JSON.stringify({
    stage: 'TITLE',
    key: STAGE_KEY,
    output_hash: sha(finalPath),
    output_path: 'final-title.mp4',
    key_inputs: {},
  }));
  const inspectStub = async () => ({
    state: 'AWAITING_APPROVAL',
    downstream: {
      states: { EDIT: 'CURRENT', MIX: 'CURRENT', BED: 'CURRENT', TITLE: 'CURRENT' },
      keys: { TITLE: STAGE_KEY },
    },
    counts: { invalid: 0 },
  });
  const approveInput = () => ({
    projectId,
    outputsRoot,
    outputsDir,
    inputRoot,
    pipeline,
    ffprobePath: process.env.FFPROBE_PATH,
    inspectProject: inspectStub,
  });
  const approvalFile = path.join(outputsDir, 'approval.json');

  // 20. Critical failures prevent approval.
  const failingQa = async () => ({
    ...projectReport,
    status: 'FAIL',
    counts: { ...projectReport.counts, blockers: 1 },
    checks: [
      ...projectReport.checks,
      { id: 'audio.stream', asset: 'final-title.mp4', status: 'FAIL', severity: 'BLOCKER', explanation: 'The final render has no audio stream.', remedy: 'Re-mux the final mix.' },
    ],
  });
  const blockedApproval = await AP.approveProject({ ...approveInput(), mediaQa: failingQa });
  check('20 critical QA failures prevent approval', blockedApproval.ok === false && blockedApproval.code === 'QA_BLOCKED', blockedApproval);
  check('20b no approval record is written when QA blocks', !fs.existsSync(approvalFile));

  const staleQa = async () => ({ ...projectReport, artifactHash: 'f'.repeat(64) });
  const staleApproval = await AP.approveProject({ ...approveInput(), mediaQa: staleQa });
  check('20c QA for a different artifact hash is refused', staleApproval.ok === false && staleApproval.code === 'QA_STALE', staleApproval);

  const brokenQa = async () => { throw new Error('ffprobe exploded'); };
  const unavailableApproval = await AP.approveProject({ ...approveInput(), mediaQa: brokenQa });
  check('20d a QA run that cannot complete refuses approval', unavailableApproval.ok === false && unavailableApproval.code === 'QA_UNAVAILABLE', unavailableApproval);
  check('20e failed QA attempts leave no approval record', !fs.existsSync(approvalFile));

  // 21. Warnings remain visible.
  const warningReport = {
    ...projectReport,
    status: 'WARNING',
    counts: { ...projectReport.counts, warnings: projectReport.counts.warnings + 1 },
    checks: [
      ...projectReport.checks,
      { id: 'visual.black', asset: 'scene-0001', status: 'WARNING', severity: 'WARNING', explanation: '1 black segment totalling 0.5s detected; confirm it is an intentional fade.' },
    ],
  };
  const warnedApproval = await AP.approveProject({
    ...approveInput(),
    mediaQa: async () => warningReport,
    now: '2026-01-02T00:00:00.000Z',
  });
  check('21 warnings do not block approval by default', warnedApproval.ok === true, warnedApproval);
  const warnedRecord = JSON.parse(fs.readFileSync(approvalFile, 'utf8'));
  check('21b warnings are persisted and visible to the reviewer',
    warnedRecord.media_qa?.status === 'WARNING'
    && warnedRecord.media_qa.warnings === warningReport.counts.warnings
    && warnedRecord.media_qa.checks.some((c: any) => c.id === 'visual.black' && c.status === 'WARNING'),
    warnedRecord.media_qa);
  const warnedVerdict = await AP.evaluateApproval(approveInput());
  check('21c approved warnings still evaluate as APPROVED', warnedVerdict.status === 'APPROVED', warnedVerdict);

  fs.rmSync(approvalFile);
  const warningsBlocked = await AP.approveProject({ ...approveInput(), mediaQa: async () => warningReport, blockOnMediaQaWarnings: true });
  check('21d warnings block only when the reviewer opts in', warningsBlocked.ok === false && warningsBlocked.code === 'QA_BLOCKED', warningsBlocked);
  check('21e opted-in warning block writes no approval record', !fs.existsSync(approvalFile));

  // 22. Changing an artifact invalidates its previous QA result.
  const passApproval = await AP.approveProject({
    ...approveInput(),
    mediaQa: async () => projectReport,
    now: '2026-01-03T00:00:00.000Z',
  });
  check('22 approval is bound to the exact QA artifact hash', passApproval.ok === true && passApproval.record.media_qa?.artifact_hash === projectReport.artifactHash, passApproval);

  const recordBeforeChange = JSON.parse(fs.readFileSync(approvalFile, 'utf8'));
  fs.appendFileSync(finalPath, Buffer.from([0]));
  const changedHash = sha(finalPath);
  const staleVerdict = await AP.evaluateApproval(approveInput());
  check('22b a changed artifact invalidates the old QA/approval', changedHash !== projectReport.artifactHash && staleVerdict.status === 'STALE_APPROVAL', staleVerdict);
  const qaOfChanged = await PQ.runProjectMediaQa(qaOptions);
  check('22c QA of the changed artifact reports a new hash', qaOfChanged.artifactHash === changedHash && qaOfChanged.artifactHash !== projectReport.artifactHash);

  const mismatchedEvidence = AP.validateApprovalRecord({ ...recordBeforeChange, media_qa: { ...recordBeforeChange.media_qa, artifact_hash: 'e'.repeat(64) } }, projectId);
  check('22d evidence for another artifact is rejected', mismatchedEvidence.ok === false);
  const failedEvidence = AP.validateApprovalRecord({ ...recordBeforeChange, media_qa: { ...recordBeforeChange.media_qa, status: 'FAIL' } }, projectId);
  check('22e FAIL evidence can never be persisted as an approval', failedEvidence.ok === false);

  check('22f authorization helper refuses failures and other hashes',
    PQ.qaAuthorizesArtifact(projectReport, projectReport.artifactHash) === true
    && PQ.qaAuthorizesArtifact(projectReport, 'f'.repeat(64)) === false
    && PQ.qaAuthorizesArtifact({ ...projectReport, status: 'FAIL' }, projectReport.artifactHash) === false);

  // ============================================================ source safety
  const mediaQaSource = fs.readFileSync(`${SRC}/mediaQa.ts`, 'utf8');
  const projectQaSource = fs.readFileSync(`${SRC}/projectMediaQa.ts`, 'utf8');
  check('source: project QA never writes media or state', !/writeFile|appendFile|createWriteStream|mkdir\(|rename\(|rm\(|unlink\(|copyFile/.test(projectQaSource));
  check('source: project QA has no network/Flow/YouTube client', !/fetch\(|XMLHttpRequest|new OpenAI|from 'openai'|zernio\.|youtube\.googleapis|FlowClient|playwright|chrome/i.test(projectQaSource));
  check('source: media QA still analyses without ever writing media', (mediaQaSource.match(/-f', 'null'/g) ?? []).length >= 4);
  check('source: QA modules never approve or publish', !/approveProject|writeApproval|zernio|publishVideo/.test(projectQaSource));

  console.log(`\nPHASE 4 MEDIA QA TESTS PASSED (${passed} checks)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
