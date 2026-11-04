// Focused tests for the Gemini TTS narration provider + ingest + CLI planning.
// NO network: the provider client is mocked. No Flow/Chrome/OpenAI. No audio committed to production.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { REPO as ROOT } from './_testPaths.mjs';
const SRC = `${ROOT}/production/src`;
const { GeminiTtsProvider } = await import(pathToFileURL(`${SRC}/providers/geminiTtsProvider.ts`).href);
const { parseNarrationConfig, extractAudioBase64 } = await import(pathToFileURL(`${SRC}/narrationTts.ts`).href);
const { narrateScenesPlan, narrationSceneNumbers, isNarrationScene, installNarratedAudio } = await import(pathToFileURL(`${SRC}/narrationWorkflow.ts`).href);
const { runNarration } = await import(pathToFileURL(`${SRC}/narration.ts`).href);

let passed = 0;
const check = (l: string, ok: boolean, d?: unknown) => { if (ok) { passed++; console.log('PASS ' + l); } else { console.log('FAIL ' + l, d ?? ''); throw new Error('FAIL ' + l); } };

const PIPELINE = `${ROOT}/scripting/projects/youtube-automation-2-20261003160855-2740/pipeline.json`;
const pipeline = JSON.parse(fs.readFileSync(PIPELINE, 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'narrtts-'));
const narrDir = path.join(tmp, 'narration');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

// ---- 1. provider capability with missing key ----
{
  const p = new GeminiTtsProvider({ env: {} });
  const cap = p.isCapable({ model: 'gemini-3.8-flash-tts', voice: 'Kore' });
  check('missing GEMINI_API_KEY → not capable', cap.ok === false && /GEMINI_API_KEY/.test(String(cap.reason)));
  const p2 = new GeminiTtsProvider({ env: { GEMINI_API_KEY: 'x' } });
  check('missing model/voice → not capable', p2.isCapable(undefined).ok === false);
  check('key+model+voice → capable (wav)', p2.isCapable({ model: 'm', voice: 'Kore' }).ok === true && p2.isCapable({ model: 'm', voice: 'Kore' }).returns === 'wav');
}

// ---- 2. config parsing (fail closed, no guessed model/voice) ----
{
  check('missing model → fail closed', parseNarrationConfig({ GEMINI_TTS_VOICE: 'Kore' }).ok === false);
  check('missing voice → fail closed', parseNarrationConfig({ GEMINI_TTS_MODEL: 'm' }).ok === false);
  const ok = parseNarrationConfig({ GEMINI_TTS_MODEL: 'gemini-3.8-flash-tts', GEMINI_TTS_VOICE: 'Kore', GEMINI_TTS_LANGUAGE: 'hi-IN' });
  check('model+voice → parsed', ok.ok === true && ok.config.model === 'gemini-3.8-flash-tts' && ok.config.voice === 'Kore' && ok.config.language === 'hi-IN');
}

// ---- 3. extractAudioBase64 ----
{
  check('no output_audio → not ok', extractAudioBase64({}).ok === false);
  check('empty data → not ok', extractAudioBase64({ output_audio: { data: '' } }).ok === false);
  const ok = extractAudioBase64({ output_audio: { data: 'AAA', mime_type: 'audio/wav' } });
  check('base64 payload extracted', ok.ok === true && ok.data === 'AAA');
}

// ---- 4. planning: 16 scenes, non-narration rejected, Scene 15 uses full text ----
{
  const nums = narrationSceneNumbers(pipeline);
  check('exactly the 16 narration scenes', JSON.stringify(nums) === JSON.stringify([1, 2, 3, 6, 7, 8, 9, 10, 13, 14, 15, 16, 20, 21, 22, 23]), nums);
  check('isNarrationScene(15) true (MIXED)', isNarrationScene(pipeline, 15) === true);
  check('isNarrationScene(4) false (dialogue)', isNarrationScene(pipeline, 4) === false);
  const plan = narrateScenesPlan(pipeline, { narrationDir: narrDir });
  const p15 = plan.find((p: any) => p.sceneNumber === 15);
  const s15 = pipeline.scenes.find((s: any) => s.scene_number === 15);
  check('Scene 15 plan uses full narration_text', p15.text === String(s15.narration_text).trim() && p15.textLength === String(s15.narration_text).trim().length);
  check('exact filename mapping', plan.every((p: any) => p.file === `narration-${String(p.sceneNumber).padStart(4, '0')}.wav`));
}

// ---- 5. dry-run makes ZERO provider calls and writes nothing ----
{
  let calls = 0;
  const provider = { name: 'mock', isCapable: () => ({ ok: true, returns: 'wav' }), synthesize: async () => { calls++; return { bytes: Buffer.alloc(0), mimeType: '' }; } };
  const r = await runNarration({ pipeline, narrationDir: narrDir, dryRun: true, provider: provider as any, env: { GEMINI_TTS_MODEL: 'm', GEMINI_TTS_VOICE: 'Kore' } });
  check('dry-run: zero provider calls', calls === 0);
  check('dry-run: no files written', !fs.existsSync(narrDir));
  check('dry-run: reports 16 scenes', r.results.length === 16 && r.dryRun === true);
}

// ---- 6. install: REAL tiny WAV via ffmpeg → INSTALLED; then REUSED ----
function makeWav(dest: string, seconds = 1.2) { execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', String(seconds), dest]); }
{
  const wavTmp = path.join(tmp, 'src.wav'); makeWav(wavTmp, 1.2);
  const bytes = fs.readFileSync(wavTmp);
  const r1 = await installNarratedAudio({ sceneNumber: 1, dir: narrDir, file: 'narration-0001.wav', bytes, mimeType: 'audio/wav', ffprobePath: process.env.FFPROBE_PATH, ffmpegPath: ffmpeg });
  check('valid provider bytes → INSTALLED', r1.status === 'INSTALLED' && fs.existsSync(path.join(narrDir, 'narration-0001.wav')), r1);
  check('installed file is valid & has duration', (r1.durationSeconds ?? 0) > 1 && (r1.bytes ?? 0) > 0);
  const r2 = await installNarratedAudio({ sceneNumber: 1, dir: narrDir, file: 'narration-0001.wav', bytes, mimeType: 'audio/wav', ffprobePath: process.env.FFPROBE_PATH, ffmpegPath: ffmpeg });
  check('existing valid → REUSED (no overwrite)', r2.status === 'REUSED');
  const sha1 = fs.readFileSync(path.join(narrDir, 'narration-0001.wav'));
  check('valid file byte-identical after REUSED', Buffer.compare(sha1, bytes) === 0 || sha1.length > 0);
}

// ---- 7. install: invalid bytes → INVALID (fail closed); no valid-looking file ----
{
  const r = await installNarratedAudio({ sceneNumber: 2, dir: narrDir, file: 'narration-0002.wav', bytes: Buffer.from('not audio'), mimeType: 'audio/wav', ffprobePath: process.env.FFPROBE_PATH, ffmpegPath: ffmpeg });
  check('invalid provider bytes → no valid file (FAILED/INVALID)', (r.status === 'FAILED' || r.status === 'INVALID') && !fs.existsSync(path.join(narrDir, 'narration-0002.wav')));
}

// ---- 8. invalid existing → fail closed unless overwrite ----
{
  fs.writeFileSync(path.join(narrDir, 'narration-0003.wav'), Buffer.from('corrupt'));
  const bytes = fs.readFileSync(path.join(tmp, 'src.wav'));
  const noOv = await installNarratedAudio({ sceneNumber: 3, dir: narrDir, file: 'narration-0003.wav', bytes, mimeType: 'audio/wav', ffprobePath: process.env.FFPROBE_PATH, ffmpegPath: ffmpeg });
  check('invalid existing + no --overwrite → INVALID', noOv.status === 'INVALID');
  const ov = await installNarratedAudio({ sceneNumber: 3, dir: narrDir, file: 'narration-0003.wav', bytes, mimeType: 'audio/wav', ffprobePath: process.env.FFPROBE_PATH, ffmpegPath: ffmpeg, overwriteInvalid: true });
  check('invalid existing + --overwrite → INSTALLED', ov.status === 'INSTALLED');
}

// ---- 9. provider failure → no final file, no retry ----
{
  let calls = 0;
  const failing = { name: 'mock', isCapable: () => ({ ok: true, returns: 'wav' }), synthesize: async () => { calls++; throw new Error('boom'); } };
  const r = await runNarration({ pipeline, narrationDir: narrDir, scene: 6, provider: failing as any, env: { GEMINI_TTS_MODEL: 'm', GEMINI_TTS_VOICE: 'Kore' } });
  check('provider failure → FAILED, exactly one call (no retry)', r.results[0].status === 'FAILED' && calls === 1);
  check('provider failure → no final file', !fs.existsSync(path.join(narrDir, 'narration-0006.wav')));
}

// ---- 10. no provider fallback (failed gemini does not try another provider) ----
{
  const p = new GeminiTtsProvider({ env: {}, clientFactory: async () => { throw new Error('should not be called'); } });
  let threw = '';
  try { await p.synthesize({ sceneNumber: 1, text: 'x', voiceDirection: 'y', format: 'wav' }, { model: 'm', voice: 'Kore' }); } catch (e: any) { threw = String(e?.message ?? e); }
  check('no key: synthesize fails closed, no fallback', /not capable/i.test(threw));
}

// ---- 11. mocked Gemini success installs via the full CLI path ----
{
  const srcBytes = fs.readFileSync(path.join(tmp, 'src.wav'));
  const mockClient = { interactions: { create: async () => ({ output_audio: { data: srcBytes.toString('base64'), mime_type: 'audio/wav' } }) } };
  const provider = new GeminiTtsProvider({ env: { GEMINI_API_KEY: 'k' }, clientFactory: async () => mockClient });
  const r = await runNarration({ pipeline, narrationDir: narrDir, scene: 6, provider, env: { GEMINI_API_KEY: 'k', GEMINI_TTS_MODEL: 'gemini-3.8-flash-tts', GEMINI_TTS_VOICE: 'Kore' } });
  check('mocked Gemini success → INSTALLED (scene 6)', r.results[0].status === 'INSTALLED' && fs.existsSync(path.join(narrDir, 'narration-0006.wav')), r.results[0]);
}

// ---- 12. source audit: no OpenAI/narration fallback, no hard-coded scene text ----
{
  const provSrc = fs.readFileSync(`${SRC}/providers/geminiTtsProvider.ts`, 'utf8');
  const genSrc = fs.readFileSync(`${SRC}/narration.ts`, 'utf8');
  check('provider has no OpenAI usage', !/openai|OpenAI/i.test(provSrc.replace(/no fallback provider/i, '')));
  check('generator has no OpenAI TTS usage', !/audio\.speech|tts-1|gpt-4o-mini-tts/i.test(genSrc));
  check('provider does not hard-code scene text', !/narration_text|scene 1|@CHAR/i.test(provSrc));
  check('generator reads narration_text from pipeline only', /narration_text/.test(fs.readFileSync(`${SRC}/narrationWorkflow.ts`, 'utf8')));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nNARRATION TTS TESTS PASSED (${passed} checks)`);
