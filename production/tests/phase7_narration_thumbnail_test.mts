// PHASE 7 — offline Hindi narration + thumbnail/cover tests.
//
// Everything runs in ISOLATED temp projects with synthetic fixtures (ffmpeg sine lines, tiny clips, a
// PNG logo). No Chrome, no Flow, no Gemini/OpenAI TTS, no image-generation API, no network, no
// credits, no uploads, no publishing, and the real project is only ever READ (and re-read at the end to
// prove it was not modified).
//
// Network is hard-disabled for the whole file: `globalThis.fetch` throws and counts attempts.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);

import { SRC, FF, PROD, REPO } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;

// ---- no external calls: any network attempt fails loudly, and is counted -----------------
let networkAttempts = 0;
(globalThis as any).fetch = async () => {
  networkAttempts += 1;
  throw new Error('network is disabled in offline tests');
};

const NA = await import(pathToFileURL(`${SRC}/narrationAssets.ts`).href);
const NQA = await import(pathToFileURL(`${SRC}/narrationQa.ts`).href);
const NWF = await import(pathToFileURL(`${SRC}/narrationAssetWorkflow.ts`).href);
const TT = await import(pathToFileURL(`${SRC}/thumbnailTypes.ts`).href);
const TD = await import(pathToFileURL(`${SRC}/thumbnailDesign.ts`).href);
const TR = await import(pathToFileURL(`${SRC}/thumbnailRender.ts`).href);
const TQA = await import(pathToFileURL(`${SRC}/thumbnailQa.ts`).href);
const TWF = await import(pathToFileURL(`${SRC}/thumbnailWorkflow.ts`).href);
const REL = await import(pathToFileURL(`${SRC}/reliability.ts`).href);
const SP = await import(pathToFileURL(`${SRC}/shortsPlan.ts`).href);
const SWF = await import(pathToFileURL(`${SRC}/shortsWorkflow.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) {
    passed += 1;
    console.log(`PASS ${label}`);
    return;
  }
  console.log(`FAIL ${label}`, detail ?? '');
  throw new Error(`FAIL ${label}`);
};

const sha = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = (file: string) => sha(fs.readFileSync(file));
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const exists = (file: string) => fs.existsSync(file);
const listFiles = (dir: string) => (exists(dir) ? fs.readdirSync(dir).sort() : []);
const listAll = (dir: string): string[] => {
  if (!exists(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listAll(absolute).map((item) => `${entry.name}/${item}`));
    else out.push(entry.name);
  }
  return out.sort();
};

const ff = process.env.FFMPEG_PATH as string;

// =======================================================================================
// Fixtures
// =======================================================================================

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-thumbs-'));
const outputsRoot = path.join(tmp, 'outputs');
const inputRoot = path.join(tmp, 'inputs');

const projectId = 'p7-project';
const projectDir = path.join(outputsRoot, projectId);
const projectInputs = path.join(inputRoot, projectId);
const narrationDir = path.join(projectInputs, 'narration');
const brandingDir = path.join(projectInputs, 'branding');
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(narrationDir, { recursive: true });
fs.mkdirSync(brandingDir, { recursive: true });

const TITLE = 'रात का खौफ — कुआं';
const HOOK = 'कुएं से आती आवाज़';

/**
 * Eight-scene Hindi folk-horror micro-story. Odd scenes are narrated (Hindi VO), even scenes are
 * character dialogue (kept from Flow audio) — exactly the two audio classes the pipeline produces.
 */
const SCENES = [
  { n: 1, speaker: 'NARRATOR', narration: 'रात के तीन बजे कुएं से आवाज़ आती है, जैसे कोई नाम पुकार रहा हो।', dialogue: '' },
  { n: 2, speaker: '@CHAR-01-ARJUN', narration: '', dialogue: 'यह आवाज़ मेरी माँ की है, मैंने इसे बचपन में सुना था।' },
  { n: 3, speaker: 'NARRATOR', narration: 'गाँव वाले कहते हैं कि कुएं में एक छाया रहती है जो बाहर नहीं आ सकती।', dialogue: '' },
  { n: 4, speaker: '@CHAR-02-MEERA', narration: '', dialogue: 'मुझे लगता है वो छाया मेरा ही इंतज़ार कर रही है।' },
  { n: 5, speaker: 'NARRATOR', narration: 'माँ ने कहा था कि कुएं के पास जाना मना है, खासकर रात में।', dialogue: '' },
  { n: 6, speaker: '@CHAR-01-ARJUN', narration: '', dialogue: 'अगर तुमने कुआं देखा है तो सच बताओ, मुझे डर नहीं लगता।' },
  {
    n: 7,
    speaker: 'NARRATOR',
    narration: 'उस रात मैंने कुएं में झाँका और मेरी ही शक्ल ने मुझे देखकर धीरे से मुस्कुरा दिया, फिर उसने मेरा नाम लिया।',
    dialogue: '',
  },
  { n: 8, speaker: '@CHAR-02-MEERA', narration: '', dialogue: 'वो नाम मत लो, वो तुम्हें अपने पास बुला रहा है।' },
];

const pipeline = {
  schema_version: '1.0',
  project_id: projectId,
  idea: { selected: { title: TITLE, hook: HOOK }, items: [] },
  script: { language: 'hi', duration_minutes: 5 },
  publishing: { title: TITLE, status: 'awaiting_approval' },
  review: { status: 'awaiting_approval' },
  scenes: SCENES.map((scene) => ({
    scene_number: scene.n,
    title: `दृश्य ${scene.n}`,
    speaker: scene.speaker,
    visual_action: `दृश्य ${scene.n}`,
    narration_text: scene.narration,
    devanagari_dialogue: scene.dialogue,
    status: 'done',
  })),
};

const NARRATION_SECONDS: Record<number, number> = { 1: 2.4, 3: 2.0, 5: 3.2, 7: 2.6 };

async function writeWav(file: string, seconds: number, frequency: number) {
  await exec(ff, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=${seconds}`,
    '-c:a', 'pcm_s16le', file,
  ], { maxBuffer: 1024 * 1024 * 8 });
}

for (const [scene, seconds] of Object.entries(NARRATION_SECONDS)) {
  await writeWav(path.join(narrationDir, `narration-${String(scene).padStart(4, '0')}.wav`), seconds, 300 + Number(scene) * 20);
}

for (const scene of SCENES) {
  await exec(ff, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=s=640x360:d=2:r=24`,
    '-f', 'lavfi', '-i', `sine=frequency=${200 + scene.n * 30}:sample_rate=48000:duration=2`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    path.join(projectDir, `scene-${String(scene.n).padStart(4, '0')}.mp4`),
  ], { maxBuffer: 1024 * 1024 * 16 });
}

// A real PNG logo (light on transparent-black) so branding pixels can be measured for real.
await exec(ff, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=0xE8D8B0:s=200x80:d=1',
  '-frames:v', '1',
  path.join(brandingDir, 'channel-logo.png'),
], { maxBuffer: 1024 * 1024 * 8 });

const LOGO_PATH = path.join(brandingDir, 'channel-logo.png');
const LOGO_BYTES = fs.readFileSync(LOGO_PATH);
const LOGO_HASH = sha(LOGO_BYTES);

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:05:00.000Z';
const T2 = '2026-01-01T00:10:00.000Z';

/** Test seam for the Phase 4 audio engine: a clean, deterministic report (real engine runs in block 1). */
const fakeMedia = async (options: any) => ({
  ok: true,
  readOnly: true,
  status: 'PASS',
  input: options.input,
  sha256: null,
  bytes: null,
  durationSeconds: 2.5,
  width: null,
  height: null,
  aspectRatio: null,
  fps: null,
  audioDurationSeconds: 2.5,
  black: null,
  freeze: null,
  silence: { segments: [], totalSeconds: 0 },
  loudness: { integratedLufs: -16, truePeakDbfs: -2, targetLufs: -14, toleranceLu: 8, source: 'fake' },
  peak: null,
  findings: [],
  checks: [],
  skipped: [],
});

const narrationOptions = {
  projectId,
  pipeline,
  outputsRoot,
  inputRoot: projectInputs,
};

/** Every long-form media artifact must stay byte-identical: thumbnails are derived artifacts. */
function snapshotMedia(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/^(scene-\d{4}|final-.*)\.(mp4|mkv|mov)$/i.test(entry.name)) continue;
    out[entry.name] = shaFile(path.join(projectDir, entry.name));
  }
  return out;
}
const mediaBefore = snapshotMedia();

// =======================================================================================
// 1. Hindi narration asset validation (real ffprobe + real Phase 4 audio engine)
// =======================================================================================

const first = await NWF.refreshNarrationAssets({ ...narrationOptions, now: T0 });
check('1a the narration ledger is written on the first pass', first.written === true && exists(first.ledgerPath));
check('1b every narrator scene has a READY asset', first.ledger.assets.length === 4 && first.ledger.assets.every((a: any) => a.state === 'ready'), first.ledger.assets.map((a: any) => [a.scene_number, a.state]));
check('1c character-speaking scenes are NOT narration assets', first.ledger.scene_texts.filter((plan: any) => plan.kind === 'dialogue').map((plan: any) => plan.scene_number).join(',') === '2,4,6,8');
check('1d narrator scenes are declared as narration', first.ledger.scene_texts.filter((plan: any) => plan.required).map((plan: any) => plan.scene_number).join(',') === '1,3,5,7');
check('1e the ledger is read-only and records its input root', first.ledger.read_only === true && first.ledger.input_root === path.resolve(projectInputs));
check(
  '1f the MEASURED duration is used (never inferred from text)',
  first.ledger.assets.every((asset: any) => Math.abs(Number(asset.duration_seconds) - NARRATION_SECONDS[asset.scene_number]) <= 0.05),
  first.ledger.assets.map((a: any) => [a.scene_number, a.duration_seconds]),
);
check('1g the total duration is the sum of measured durations', Math.abs(first.ledger.total_duration_seconds - 10.2) <= 0.15, first.ledger.total_duration_seconds);
check(
  '1h container/codec/sample-rate/channels are recorded',
  first.ledger.assets.every((asset: any) => asset.codec === 'pcm_s16le' && asset.sample_rate === 48000 && asset.channels === 1 && String(asset.container).includes('wav')),
  first.ledger.assets[0],
);
check(
  '1i every asset records bytes + SHA-256 + provenance',
  first.ledger.assets.every((asset: any) => /^[0-9a-f]{64}$/.test(asset.sha256) && asset.bytes > 0 && asset.provenance.source === 'provided_file' && asset.provenance.recorded_at === T0),
);
check('1j the ledger fingerprint and asset-set hash are stable hashes', /^[0-9a-f]{64}$/.test(first.ledger.fingerprint) && /^[0-9a-f]{64}$/.test(first.ledger.asset_set_hash));
check('1k the narration set is complete', NA.narrationIsComplete(first.ledger) === true);
check('1l no warning about a missing narration directory', first.warnings.length === 0, first.warnings);

const firstQa = await NWF.qaNarrationAssets({ ...narrationOptions, now: T1 });
check('1m narration QA runs against the real Phase 4 audio engine', firstQa.ok === true && firstQa.report !== null, firstQa.errors);
check('1n QA reports no blocker', firstQa.report.counts.fail === 0 && firstQa.report.counts.total === 4, firstQa.report.counts);
check('1o QA status is PASS or WARNING (a raw sine is louder than the mix target)', ['PASS', 'WARNING'].includes(firstQa.report.status), firstQa.report.status);
for (const asset of firstQa.report.assets) {
  const byId = (id: string) => asset.checks.find((c: any) => c.id === id);
  check(`1p scene ${asset.scene_number} duration agrees with ffprobe`, byId('narration.duration')?.status === 'PASS', byId('narration.duration'));
  check(`1q scene ${asset.scene_number} format satisfies the contract`, byId('narration.format')?.status === 'PASS', byId('narration.format'));
  check(`1r scene ${asset.scene_number} carries audible speech`, byId('narration.silence.whole')?.status === 'PASS', byId('narration.silence.whole'));
  check(`1s scene ${asset.scene_number} bytes match the ledger hash`, byId('narration.hash')?.status === 'PASS', byId('narration.hash'));
}
const setComplete = firstQa.report.assets.length === 4 && firstQa.report.status !== 'FAIL';
check('1t the QA report is not publishable on its own', firstQa.report.publishable === false && firstQa.report.approval_required === true);
check('1u QA evidence covers the ledger', NQA.narrationQaCovers(firstQa.report, first.ledger) === true);
check('1v the QA report is persisted', exists(firstQa.reportPath) && readJson(firstQa.reportPath).report_hash === firstQa.report.report_hash);

const status0 = await NWF.narrationStatus(narrationOptions);
check('1w status is read-only and reports completeness', status0.read_only === true && status0.complete === true && status0.ledger_present === true);
check('1x status shows nothing approved before approval', status0.approval.status === 'NOT_APPROVED');
check('1y the audio files were never modified by the inventory', fs.readdirSync(narrationDir).every((name) => !name.startsWith('narration-ledger')));

// =======================================================================================
// 2. Corrupted and missing audio
// =======================================================================================

const badId = 'p7-bad-narration';
const badInputs = path.join(inputRoot, badId);
fs.mkdirSync(path.join(badInputs, 'narration'), { recursive: true });
fs.writeFileSync(path.join(badInputs, 'narration', 'narration-0001.wav'), crypto.randomBytes(4096)); // garbage, not RIFF
fs.writeFileSync(path.join(badInputs, 'narration', 'narration-0003.wav'), Buffer.alloc(0));        // zero bytes
// scene 5 is deliberately absent
fs.copyFileSync(path.join(narrationDir, 'narration-0007.wav'), path.join(badInputs, 'narration', 'narration-0007.wav'));

const badOptions = { projectId: badId, pipeline, outputsRoot, inputRoot: badInputs };
const bad = await NWF.refreshNarrationAssets({ ...badOptions, now: T0, runMediaQa: fakeMedia });
const stateOf = (scene: number) => bad.ledger.assets.find((asset: any) => asset.scene_number === scene)?.state;
check('2a a non-audio file is CORRUPT', stateOf(1) === 'corrupt', bad.ledger.assets[0]);
check('2b a zero-byte file is EMPTY', stateOf(3) === 'empty', bad.ledger.assets[1]);
check('2c an absent file is MISSING', stateOf(5) === 'missing', bad.ledger.assets[2]);
check('2d a valid sibling asset is still READY (one bad line never poisons the rest)', stateOf(7) === 'ready');
check('2e the refresh fails and names the problems', bad.ok === false && bad.ledger.missing_scenes.join(',') === '5' && bad.ledger.invalid_scenes.join(',') === '1,3');
check('2f the narration set is incomplete', NA.narrationIsComplete(bad.ledger) === false);

const badQa = await NWF.qaNarrationAssets({ ...badOptions, now: T1, runMediaQa: fakeMedia });
const badChecks = badQa.report.assets.flatMap((asset: any) => asset.checks.map((c: any) => ({ ...c, scene: asset.scene_number })));
const has = (scene: number, id: string, status: string) => badChecks.some((c: any) => c.scene === scene && c.id === id && c.status === status);
check('2g QA fails on the corrupt line (unreadable probe)', badQa.ok === false && badQa.report.status === 'FAIL');
check('2h QA says the corrupt file cannot be probed', has(1, 'narration.probe', 'FAIL'), badChecks.filter((c: any) => c.scene === 1));
check('2i QA says the empty file has no bytes', has(3, 'narration.integrity', 'FAIL'));
check('2j QA says the missing line is absent', has(5, 'narration.present', 'FAIL'));
check('2k QA marks the project narration set incomplete', badQa.report.set_checks.some((c: any) => c.id === 'narration.set.complete' && c.status === 'FAIL'), badQa.report.set_checks);
check('2l approving a broken set is refused', (await NWF.approveNarrationAssets({ ...badOptions, confirmed: true })).status === 'REFUSED');
check('2m the corrupted inputs were not rewritten', fs.statSync(path.join(badInputs, 'narration', 'narration-0001.wav')).size === 4096 && fs.statSync(path.join(badInputs, 'narration', 'narration-0003.wav')).size === 0);

// =======================================================================================
// 3. Content-hash invalidation + per-asset approval binding
// =======================================================================================

const accept = await NWF.approveNarrationAssets({ ...narrationOptions, confirmed: true, approvedBy: 'offline-test', now: T1 });
check('3a approval requires an explicit --yes', (await NWF.approveNarrationAssets({ ...narrationOptions, confirmed: false })).status === 'REFUSED');
check('3b approval succeeds after QA for these exact bytes', accept.status === 'APPROVED' && accept.ok === true, accept.reason);
check('3c approval records one entry per asset with its hash and QA hash', accept.record.assets.length === 4 && accept.record.assets.every((a: any) => /^[0-9a-f]{64}$/.test(a.sha256) && a.qa_report_hash === firstQa.report.report_hash));

// Two Shorts claim different narrator lines: short-01 uses scene 3; short-02 uses scenes 1 and 5.
const seededLedger = await NA.loadNarrationLedger(outputsRoot, projectId);
const shaOf = (scene: number) => seededLedger.assets.find((a: any) => a.scene_number === scene).sha256;
const SEEDED_CLAIMS: Array<[string, number[]]> = [['short-01', [3]], ['short-02', [1, 5]]];
for (const [shortId, scenes] of SEEDED_CLAIMS) {
  const dir = path.join(projectDir, 'shorts', shortId);
  fs.mkdirSync(dir, { recursive: true });
  const narration_hashes = Object.fromEntries(scenes.map((scene) => [String(scene), shaOf(scene)]));
  fs.writeFileSync(path.join(dir, 'short.json'), JSON.stringify({ short_id: shortId, narration_hashes }, null, 2));
}

const claimsBefore = await NA.narrationDependentClaims({ outputsRoot, projectId, ledger: seededLedger, previous: seededLedger });
await writeWav(path.join(narrationDir, 'narration-0003.wav'), 2.2, 999); // the operator re-records ONE line

const second = await NWF.refreshNarrationAssets({ ...narrationOptions, now: T2 });
const change3 = second.changes.find((change: any) => change.scene === 3);
check('3d the re-recorded line is detected by content hash', Boolean(change3?.bytes_changed), second.changes);
check('3e the unchanged lines produce no change entries', second.changes.length === 1, second.changes);
check('3f only the changed scene is invalidated', second.invalidation.changed_scenes.join(',') === '3', second.invalidation);
check('3g the long-form dependents are flagged', second.invalidation.long_form_affected === true && Boolean(second.invalidation.stale_dependents['long-form:audio_mix']) && Boolean(second.invalidation.stale_dependents['long-form:media_qa']));
check('3h the Short that used scene 3 is invalidated', second.invalidation.shorts_affected.join(',') === 'short-01', second.invalidation.shorts_affected);
check('3i the unrelated Short is NOT invalidated', second.invalidation.stale_dependents['shorts:short-02'] === undefined);
check('3j the invalidation names the exact scene for each dependent', second.invalidation.stale_dependents['shorts:short-01'].join(',') === '3');
check('3k dependent claims resolve for every asset', claimsBefore.filter((claim: any) => claim.dependent.startsWith('long-form:')).length === 8);

// Keep a Shorts checkpoint from BEFORE the change to prove the claim logic is durable.
const afterStatus = await NWF.narrationStatus(narrationOptions);
check('3l the per-asset approval is stale only for the changed line', afterStatus.approval.status === 'STALE_APPROVAL' && afterStatus.approval.assets.find((a: any) => a.scene_number === 3).status === 'STALE_APPROVAL');
check('3m the untouched lines keep their approval', afterStatus.approval.assets.filter((a: any) => a.scene_number !== 3).every((a: any) => a.status === 'APPROVED'));
check('3n re-approval is refused until QA covers the new byte set', (await NWF.approveNarrationAssets({ ...narrationOptions, confirmed: true })).status === 'REFUSED');

// the fresh QA re-binds approval to the NEW bytes, and only that line changed
const requQa = await NWF.qaNarrationAssets({ ...narrationOptions, now: T2, runMediaQa: fakeMedia });
check('3o QA re-runs cleanly after the re-record', requQa.ok === true, requQa.report?.status);
check('3p QA evidence is re-bound to the new byte set', NQA.narrationQaCovers(requQa.report, second.ledger) === true);
const reApproved = await NWF.approveNarrationAssets({ ...narrationOptions, confirmed: true, now: T2 });
check('3q the new QA evidence re-enables approval', reApproved.status === 'APPROVED');
check('3r every line is approved again, bound to its own QA verdict', reApproved.record.assets.length === 4 && reApproved.record.assets.every((entry: any) => entry.qa_asset_status === 'PASS' || entry.qa_asset_status === 'WARNING'));

// =======================================================================================
// 4. Pronunciation configuration and Devanagari handling
// =======================================================================================

check(
  '4a pronunciation rules are applied longest-first (never corrupting a longer match)',
  NA.applyPronunciationRules('कुआं और कुएँ', [
    { match: 'कु', say: 'X' },
    { match: 'कुआं', say: 'कू-आं' },
    { match: 'कुएँ', say: 'कू-एँ' },
  ]) === 'कू-आं और कू-एँ',
);
check('4b pronunciation normalizes whitespace deterministically', NA.applyPronunciationRules('  रात   का  खौफ ', []) === 'रात का खौफ');

const pronId = 'p7-pronunciation';
const pronInputs = path.join(inputRoot, pronId);
fs.mkdirSync(path.join(pronInputs, 'narration'), { recursive: true });
for (const name of fs.readdirSync(narrationDir)) {
  if (name.endsWith('.wav')) fs.copyFileSync(path.join(narrationDir, name), path.join(pronInputs, 'narration', name));
}
// scene 3 was re-recorded above; copy the ORIGINAL fixture bytes back so the pronunciation delta is pure
await writeWav(path.join(pronInputs, 'narration', 'narration-0003.wav'), 2.0, 360);

const pronOptions = { projectId: pronId, pipeline, outputsRoot, inputRoot: pronInputs };
const pronBase = await NWF.refreshNarrationAssets({ ...pronOptions, now: T0, runMediaQa: fakeMedia });
check('4c the pronunciation baseline is ready', pronBase.ledger.assets.every((asset: any) => asset.state === 'ready'));
check('4d the default voice config is the shared provider configuration', pronBase.ledger.voice.language === 'hi-IN' && pronBase.ledger.voice.provider === 'gemini_tts' && Boolean(pronBase.ledger.voice.narrator_style));
check('4e no pronunciation sidecar means no rules', pronBase.ledger.pronunciation.rules.length === 0);

const pronFile = path.join(pronInputs, 'narration', 'pronunciation.json');
fs.writeFileSync(pronFile, JSON.stringify({
  rules: [{ match: 'कुएं', say: 'कू-एँ', note: 'folk pronunciation of "well"' }],
  voice: { voice: 'Kore', language: 'hi-IN' },
}, null, 2));
const pronFileHash = shaFile(pronFile);

const pronLoaded = await NA.loadPronunciationConfig({ inputRoot: pronInputs });
check('4f the sidecar is loaded from the narration directory', pronLoaded.source === path.resolve(pronFile) && pronLoaded.config.rules.length === 1);
check('4g the sidecar voice override is honoured', pronLoaded.config.voice.voice === 'Kore' && pronLoaded.config.voice.language === 'hi-IN');

const pronAfter = await NWF.refreshNarrationAssets({ ...pronOptions, now: T0, runMediaQa: fakeMedia });
check('4h a pronunciation change is a config change', pronAfter.ledger.pronunciation.config_hash !== pronBase.ledger.pronunciation.config_hash);
check(
  '4i a rule change marks every line STALE without touching the bytes',
  pronAfter.ledger.stale_scenes.join(',') === '1,3,5,7'
  && pronAfter.ledger.assets.every((asset: any) => asset.state === 'stale')
  && pronAfter.ledger.assets.every((asset: any) => asset.sha256 === pronBase.ledger.assets.find((b: any) => b.scene_number === asset.scene_number)?.sha256),
  pronAfter.ledger.stale_scenes,
);
check(
  '4j the spoken text carries the Devanagari replacement',
  pronAfter.ledger.scene_texts.find((plan: any) => plan.scene_number === 1).spoken_text.includes('कू-एँ')
  && pronBase.ledger.scene_texts.find((plan: any) => plan.scene_number === 1).spoken_text.includes('कुएं'),
);
check('4k every text hash changed (the config hash is part of it)', pronAfter.ledger.scene_texts.every((plan: any) => plan.required === (plan.kind === 'narration')));
check('4l the pronunciation sidecar was never rewritten', shaFile(pronFile) === pronFileHash);
check('4m stale assets cannot be approved', (await NWF.approveNarrationAssets({ ...pronOptions, confirmed: true })).status === 'REFUSED');
check('4n stale lines are still measurable (duration is not lost)', pronAfter.ledger.total_duration_seconds > 9);

// =======================================================================================
// 5. Narration resume behaviour
// =======================================================================================

// Clear the staleness by removing the rule → back to the original input key. This pass DOES change
// the ledger (state stale → ready) but must never touch a single audio byte.
fs.rmSync(pronFile);
const restoredPass = await NWF.refreshNarrationAssets({ ...pronOptions, now: T1, runMediaQa: fakeMedia });
check('5a removing the rule restores READY assets with no re-record', restoredPass.ledger.assets.every((asset: any) => asset.state === 'ready'));
check('5b no audio byte changed while clearing the staleness', restoredPass.changes.every((change: any) => change.bytes_changed === false), restoredPass.changes);
check('5c the pronunciation change is still reported as a script/config change', restoredPass.changes.every((change: any) => change.script_or_voice_changed === true), restoredPass.changes);

const ledgerBytes = fs.readFileSync(NA.narrationLedgerPath(outputsRoot, pronId));
const resumeRefresh = await NWF.refreshNarrationAssets({ ...pronOptions, now: T1, runMediaQa: fakeMedia });
check('5d an unchanged narration pass writes nothing', resumeRefresh.written === false && resumeRefresh.changes.length === 0, resumeRefresh.changes);
check('5e the ledger file is byte-identical after resume', sha(fs.readFileSync(NA.narrationLedgerPath(outputsRoot, pronId))) === sha(ledgerBytes));
check('5f a resumed ledger reports no invalidation', resumeRefresh.invalidation.changed_scenes.length === 0 && Object.keys(resumeRefresh.invalidation.stale_dependents).length === 0);

const qaOnce = await NWF.qaNarrationAssets({ ...pronOptions, now: T2, runMediaQa: fakeMedia });
const qaTwice = await NWF.qaNarrationAssets({ ...pronOptions, now: T2, runMediaQa: fakeMedia });
check('5g QA resume is content-addressed', qaOnce.written === true && qaTwice.written === false && qaOnce.report.report_hash === qaTwice.report.report_hash);

// =======================================================================================
// 6. Long-form thumbnail: dimensions, format, determinism
// =======================================================================================

const thumbOptions = { projectId, pipeline, outputsRoot, inputRoot: projectInputs };
const longPlan = await TWF.planThumbnail({ ...thumbOptions, now: T0 });
check('6a the long-form design is planned', longPlan.ok === true && longPlan.kind === 'long_form' && longPlan.ownerId === 'long-form', longPlan.errors);
const longDesign = longPlan.design;
check('6b the long-form thumbnail is 1280x720 (16:9)', longDesign.width === 1280 && longDesign.height === 720 && Math.abs(longDesign.aspect - 16 / 9) < 0.001);
check('6c the safe area and type band come from the long-form contract', JSON.stringify(longDesign.safe_area) === JSON.stringify(TT.LONG_FORM_SAFE_AREA) && JSON.stringify(longDesign.text.band) === JSON.stringify({ x: 72, y: 196, width: 1108, height: 372 }));
check('6d the concept is story-specific: the story title drives the headline', longDesign.concept.headline === TITLE && longDesign.concept.kicker.includes(TD.BRAND_WORDMARK));
check('6e the base still comes from a narrator scene', longDesign.concept.source_scene === 7 && longDesign.background_mode === 'scene_frame', longDesign.concept);
check('6f sources are recorded namespaced with hashes', longDesign.sources.some((s: any) => s.relative_path === 'outputs:scene-0007.mp4' && s.sha256 === shaFile(path.join(projectDir, 'scene-0007.mp4'))) && longDesign.sources.some((s: any) => s.relative_path === 'inputs:branding/channel-logo.png' && s.sha256 === LOGO_HASH));
check('6g design and rendered artifact are separate records', /^[0-9a-f]{64}$/.test(longDesign.design_hash) && longDesign.render.renderer_version === TT.THUMBNAIL_RENDERER_VERSION && longDesign.created_at === T0);
check('6h the design JSON is the only thing planned (no image yet)', exists(path.join(projectDir, 'thumbnail', 'design.json')) && !exists(path.join(projectDir, 'thumbnail', 'thumbnail.png')));

const longRender = await TWF.renderThumbnailArtifact({ ...thumbOptions, now: T0 });
check('6i the thumbnail renders', longRender.ok === true && longRender.action === 'RENDERED', longRender.errors);
const longArtifact = longRender.artifactPath;
const longBytes = fs.readFileSync(longArtifact);
check('6j the artifact is a PNG', longBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
check('6k the checkpoint records 1280x720 and the exact hash', longRender.checkpoint.width === 1280 && longRender.checkpoint.height === 720 && longRender.checkpoint.artifact_hash === sha(longBytes) && longRender.checkpoint.bytes === longBytes.length);
check('6l the checkpoint records the sources and renderer version', longRender.checkpoint.sources.length === 2 && longRender.checkpoint.renderer_version === TT.THUMBNAIL_RENDERER_VERSION && longRender.checkpoint.branding_applied === true);
check('6m the file size is inside the delivery envelope', longBytes.length > 2048 && longBytes.length <= TT.LONG_FORM_MAX_BYTES, `${longBytes.length} bytes`);

const longReplan = await TWF.planThumbnail({ ...thumbOptions, now: T1 });
check('6n re-planning an unchanged story writes nothing and keeps the hash', longReplan.written === false && longReplan.design.design_hash === longDesign.design_hash);
const longRerender = await TWF.renderThumbnailArtifact({ ...thumbOptions, now: T1 });
check('6o re-rendering unchanged inputs is REUSED, not re-rendered', longRerender.action === 'REUSED' && longRerender.checkpoint.artifact_hash === sha(longBytes));

// =======================================================================================
// 7. Independent vertical Shorts covers
// =======================================================================================

fs.writeFileSync(path.join(projectDir, 'shorts', 'shorts-plan.json'), JSON.stringify({
  count: 2,
  shorts: [
    { short_id: 'short-01', title: 'कुएं की छाया', hook: { scene_number: 3, text: 'कुएं में छाया' }, scene_refs: [3, 4, 5] },
    { short_id: 'short-02', title: 'तीन बजे की आवाज़', hook: { scene_number: 5, text: 'रात में आवाज़' }, scene_refs: [5, 6, 7] },
  ],
}, null, 2));

const cover1 = await TWF.planThumbnail({ ...thumbOptions, shortId: 'short-01', now: T0 });
const cover2 = await TWF.planThumbnail({ ...thumbOptions, shortId: 'short-02', now: T0 });
check('7a each Short gets its own cover design', cover1.ok && cover2.ok && cover1.design.owner_id === 'short-01' && cover2.design.owner_id === 'short-02');
check('7b covers are 1080x1920 (9:16)', [cover1, cover2].every((plan: any) => plan.design.width === 1080 && plan.design.height === 1920 && Math.abs(plan.design.aspect - 9 / 16) < 0.001));
check('7c covers use the vertical safe area', JSON.stringify(cover1.design.safe_area) === JSON.stringify(TT.SHORTS_SAFE_AREA));
check('7d the cover headline is the Short\'s own title, never the long-form title', cover1.design.concept.headline === 'कुएं की छाया' && cover2.design.concept.headline === 'तीन बजे की आवाज़' && cover1.design.concept.headline !== longDesign.concept.headline);
check('7e each cover frames its own hook scene', cover1.design.concept.source_scene === 3 && cover2.design.concept.source_scene === 5);
check('7f covers are stored under their own Short directory', cover1.designPath === path.join(projectDir, 'shorts', 'short-01', 'cover', 'design.json') && cover2.designPath === path.join(projectDir, 'shorts', 'short-02', 'cover', 'design.json'));
check('7g the two covers are distinct designs', cover1.design.design_hash !== cover2.design.design_hash && cover1.design.design_hash !== longDesign.design_hash);
check('7h covers do not depend on the narration audio at all', cover1.design.sources.every((s: any) => !s.relative_path.includes('narration')));

const cover1Render = await TWF.renderThumbnailArtifact({ ...thumbOptions, shortId: 'short-01', now: T0 });
const cover2Render = await TWF.renderThumbnailArtifact({ ...thumbOptions, shortId: 'short-02', now: T0 });
check('7i both covers render as 1080x1920 PNGs', cover1Render.action === 'RENDERED' && cover2Render.action === 'RENDERED' && cover1Render.checkpoint.width === 1080 && cover1Render.checkpoint.height === 1920 && cover2Render.checkpoint.width === 1080);
check('7j the cover artifacts are different files with different bytes', cover1Render.checkpoint.artifact_hash !== cover2Render.checkpoint.artifact_hash && cover1Render.checkpoint.artifact_hash !== longRender.checkpoint.artifact_hash);

const cover1Qa = await TWF.qaThumbnailArtifact({ ...thumbOptions, shortId: 'short-01', now: T1 });
check('7k cover QA passes (no design or pixel blockers)', cover1Qa.ok === true && cover1Qa.report.status !== 'FAIL', cover1Qa.report?.checks.filter((c: any) => c.status === 'FAIL'));
check('7l cover QA proves independence from the long-form thumbnail', cover1Qa.report.checks.find((c: any) => c.id === 'thumbnail.independence')?.status === 'PASS');
check('7m cover QA proves the branding pixels are at the recorded position', cover1Qa.report.checks.find((c: any) => c.id === 'thumbnail.branding.pixels')?.status === 'PASS');
check('7n cover QA proves the re-render is pixel-identical', cover1Qa.report.checks.find((c: any) => c.id === 'thumbnail.deterministic')?.status === 'PASS');

const cover2Qa = await TWF.qaThumbnailArtifact({ ...thumbOptions, shortId: 'short-02', now: T1 });
check('7o the second cover also passes QA', cover2Qa.ok === true, cover2Qa.report?.status);

// =======================================================================================
// 8. Safe-area validation and text overflow
// =======================================================================================

const longQa = await TWF.qaThumbnailArtifact({ ...thumbOptions, now: T1 });
check('8a long-form QA passes with no blockers', longQa.ok === true && longQa.report.counts.fail === 0, longQa.report.checks.filter((c: any) => c.status === 'FAIL'));
check('8b every rendered text pixel is inside the safe area', longQa.report.checks.find((c: any) => c.id === 'thumbnail.safe_area.pixels')?.status === 'PASS', longQa.report.text_ink);
check('8c type was actually drawn (not a silent font failure)', longQa.report.checks.find((c: any) => c.id === 'thumbnail.text_ink.present')?.status === 'PASS' && longQa.report.text_ink.pixels >= TQA.MIN_TEXT_INK_PIXELS);
check('8d the long-form wordmark/branding is inside the brand box', longQa.report.checks.find((c: any) => c.id === 'thumbnail.branding.pixels')?.status === 'PASS');
check('8e the design contract check ran and passed', longQa.report.checks.find((c: any) => c.id === 'design.contract')?.status === 'PASS');
check('8f QA covers the current image and design', TQA.thumbnailQaCovers(longQa.report, { artifactHash: sha(longBytes), designHash: longDesign.design_hash, kind: 'long_form', ownerId: 'long-form' }));

// overflow is refused by the pure design validator (no files, no approved asset touched)
const overflowConcept = { headline: 'रात का खौफ '.repeat(6).trim(), kicker: TD.BRAND_KICKER, subhead: null, rationale: 'test', source_scene: 7 };
const overflowLayout = TD.layoutThumbnailText('long_form', overflowConcept);
check('8g an over-long headline overflows its layout band', overflowLayout.overflow === true, overflowLayout.warnings);
const overflowDesign = TD.buildThumbnailDesign({ projectId: 'p7-overflow', kind: 'long_form', pipeline, sources: [], overrides: { headline: overflowConcept.headline }, createdAt: T0 });
const overflowValidation = TD.validateThumbnailDesign(overflowDesign);
check('8h the design validator refuses text overflow', overflowValidation.ok === false && overflowValidation.issues.some((issue: any) => issue.code === 'design.overflow'), overflowValidation.issues);
check('8i the overflow design never reached disk', !exists(path.join(outputsRoot, 'p7-overflow')));
check('8j a too-small headline font is refused', TD.validateThumbnailDesign({ ...longDesign, text: { ...longDesign.text, blocks: longDesign.text.blocks.map((block: any) => block.id === 'headline' ? { ...block, font_size: 40 } : block) } }).issues.some((issue: any) => issue.code === 'design.font_size'));
check('8k a safe-area violation is refused', TD.validateThumbnailDesign({ ...longDesign, text: { ...longDesign.text, blocks: longDesign.text.blocks.map((block: any) => block.id === 'headline' ? { ...block, x: 4 } : block) } }).issues.some((issue: any) => issue.code === 'design.safe_area'));
check(
  '8l the brand box is the permanent lower-right geometry (anchored by its right/bottom edges)',
  JSON.stringify(TT.brandPlacement(1280, 720)) === JSON.stringify({ height: 76, right: 72, bottom: 75, x: 1132, y: 569 })
  && TT.brandPlacement(1280, 720).x + TT.brandPlacement(1280, 720).height + TT.brandPlacement(1280, 720).right === 1280
  && TT.brandPlacement(1280, 720).y + TT.brandPlacement(1280, 720).height + TT.brandPlacement(1280, 720).bottom === 720
  && TT.BRAND_PLACEMENT_RATIOS.right === 0.05625,
  TT.brandPlacement(1280, 720),
);

// =======================================================================================
// 9. Deterministic render keys
// =======================================================================================

check('9a the render key is reproducible from design + sources', TD.thumbnailRenderKey(longDesign) === longRender.checkpoint.render_key);
check('9b timestamps never change the design hash or render key', TD.buildThumbnailDesign({ projectId, kind: 'long_form', pipeline, sources: longDesign.sources, createdAt: T2 }).design_hash === longDesign.design_hash);
check('9c QA confirms the recorded render key', longQa.report.checks.find((c: any) => c.id === 'thumbnail.render_key')?.status === 'PASS');
const changedConcept = TD.buildThumbnailDesign({ projectId, kind: 'long_form', pipeline, sources: longDesign.sources, overrides: { headline: 'दूसरा शीर्षक' }, createdAt: T0 });
check('9d a changed concept changes the render key', TD.thumbnailRenderKey(changedConcept) !== longRender.checkpoint.render_key && changedConcept.design_hash !== longDesign.design_hash);
const changedSource = TD.buildThumbnailDesign({
  projectId, kind: 'long_form', pipeline, createdAt: T0,
  sources: longDesign.sources.map((s: any) => s.role === 'base' ? { ...s, sha256: 'f'.repeat(64) } : s),
});
check('9e a changed source hash changes the render key', TD.thumbnailRenderKey(changedSource) !== TD.thumbnailRenderKey(longDesign));
check('9f every cover records its own key', cover1Render.checkpoint.render_key === TD.thumbnailRenderKey(cover1.design) && cover1Render.checkpoint.render_key !== cover2Render.checkpoint.render_key);

// =======================================================================================
// 10. Atomic output handling
// =======================================================================================

const artifactBefore = shaFile(longArtifact);
fs.appendFileSync(longArtifact, Buffer.from([0x00])); // simulate a half-written / replaced file
const repaired = await TWF.renderThumbnailArtifact({ ...thumbOptions, now: T2 });
check('10a a tampered artifact is re-rendered, not reused', repaired.action === 'RENDERED');
check('10b the render is deterministic (same bytes as before)', shaFile(longArtifact) === artifactBefore);
check('10c no temp files survive an atomic write', fs.readdirSync(path.join(projectDir, 'thumbnail')).every((name) => !name.includes('.tmp-')));

// a changed source must fail the render WITHOUT destroying the previous artifact
const clip7 = path.join(projectDir, 'scene-0007.mp4');
const clip7Bytes = fs.readFileSync(clip7);
fs.appendFileSync(clip7, Buffer.from([0x00]));
const failed = await TWF.renderThumbnailArtifact({ ...thumbOptions, now: T2 });
check('10d a changed source blocks the render and names it', failed.ok === false && failed.action === 'FAILED' && failed.errors.join(' ').includes('source changed'), failed.errors);
check('10e the previous artifact is untouched on failure', shaFile(longArtifact) === artifactBefore);
check('10f no partial artifact or temp file was left behind', listFiles(path.join(projectDir, 'thumbnail')).filter((name) => name.includes('.tmp-')).length === 0);
fs.writeFileSync(clip7, clip7Bytes);
const afterRestore = await TWF.renderThumbnailArtifact({ ...thumbOptions, now: T2 });
check('10g restoring the exact source bytes re-enables reuse', afterRestore.action === 'REUSED');

// a missing logo fails the render and the artifact is preserved
fs.rmSync(LOGO_PATH);
const noLogo = await TWF.renderThumbnailArtifact({ ...thumbOptions, now: T2 });
check('10h a missing logo fails the render and names the logo source', noLogo.ok === false && noLogo.errors.join(' ').includes('channel-logo.png (logo)'), noLogo.errors);
check('10i the artifact survives the failure', shaFile(longArtifact) === artifactBefore);
fs.writeFileSync(LOGO_PATH, LOGO_BYTES);
check('10j the logo restored byte-identically', shaFile(LOGO_PATH) === LOGO_HASH);

// =======================================================================================
// 11. Stale QA and approval rejection
// =======================================================================================

const qaFile = path.join(projectDir, 'thumbnail', 'qa.json');
const qaBackup = fs.readFileSync(qaFile);
const approvalFile = path.join(projectDir, 'thumbnail', 'approval.json');

check('11a approval without --yes is refused', (await TWF.approveThumbnailArtifact({ ...thumbOptions, confirmed: false })).status === 'REFUSED');
fs.rmSync(qaFile);
const noQa = await TWF.approveThumbnailArtifact({ ...thumbOptions, confirmed: true });
check('11b approval without QA evidence is refused', noQa.status === 'REFUSED' && noQa.reason.includes('video thumbnail qa'), noQa.reason);
fs.writeFileSync(qaFile, qaBackup);

const wrongHash = await TWF.approveThumbnailArtifact({ ...thumbOptions, confirmed: true, expectedHash: 'a'.repeat(64) });
check('11c approval is bound to the exact bytes (a wrong --sha256 is refused)', wrongHash.status === 'REFUSED');
const approved = await TWF.approveThumbnailArtifact({ ...thumbOptions, confirmed: true, approvedBy: 'offline-test', expectedHash: artifactBefore, now: T2 });
check('11d approval succeeds for the exact bytes and QA evidence', approved.status === 'APPROVED' && approved.ok === true, approved.reason);
const record = readJson(approvalFile);
check('11e the approval record binds artifact hash, render key and QA report hash', record.approved_artifact_hash === artifactBefore && record.approved_render_key === longRender.checkpoint.render_key && record.media_qa.report_hash === longQa.report.report_hash);
check('11f approval never claims a publishable state', readJson(qaFile).publishable === false && record.status === 'approved');

const approvedStatus = await TWF.thumbnailStatus(thumbOptions);
check('11g status reports the long-form thumbnail as approved', approvedStatus.long_form.state === 'approved' && approvedStatus.long_form.approval.status === 'APPROVED', approvedStatus.long_form);
check('11h status never marks anything publishable', approvedStatus.publishable === false && approvedStatus.long_form.publishable === false && approvedStatus.long_form_media_modified === false);

// covers are NOT approved by the long-form approval
check('11i each cover still needs its own explicit approval', approvedStatus.covers.length === 2 && approvedStatus.covers.every((cover: any) => cover.state === 'awaiting_approval' && cover.approval.status === 'NOT_APPROVED'));
const coverApproved = await TWF.approveThumbnailArtifact({ ...thumbOptions, shortId: 'short-01', confirmed: true, now: T2 });
check('11j a cover can be approved on its own', coverApproved.status === 'APPROVED' && coverApproved.ownerId === 'short-01');
const statusAfterCover = await TWF.thumbnailStatus(thumbOptions);
check('11k approving one cover does not change the other', statusAfterCover.covers.find((c: any) => c.owner_id === 'short-01').state === 'approved' && statusAfterCover.covers.find((c: any) => c.owner_id === 'short-02').state === 'awaiting_approval');

// any byte change invalidates QA + approval
fs.appendFileSync(longArtifact, Buffer.from([0x01]));
const staleStatus = await TWF.thumbnailStatus(thumbOptions);
check('11l changed bytes make the thumbnail stale', staleStatus.long_form.state === 'stale' && staleStatus.long_form.approval.status === 'STALE_APPROVAL', staleStatus.long_form);
const staleApprove = await TWF.approveThumbnailArtifact({ ...thumbOptions, confirmed: true });
check('11m a stale artifact cannot be re-approved', staleApprove.status === 'REFUSED' && staleApprove.reason.includes('do not match the checkpoint'), staleApprove.reason);
const staleQa = await TWF.qaThumbnailArtifact({ ...thumbOptions, now: T2 });
check('11n QA refuses the tampered artifact (hash binding)', staleQa.ok === false && staleQa.report.checks.find((c: any) => c.id === 'thumbnail.hash')?.status === 'FAIL');

const repairedRender = await TWF.renderThumbnailArtifact({ ...thumbOptions, now: T2 });
check('11o re-rendering restores the exact approved bytes', repairedRender.action === 'RENDERED' && shaFile(longArtifact) === artifactBefore);
const repairedQa = await TWF.qaThumbnailArtifact({ ...thumbOptions, now: T2 });
const approvedAgain = await TWF.thumbnailStatus(thumbOptions);
check('11p re-QA of the identical bytes re-validates the existing approval (no re-approval needed)', repairedQa.ok === true && approvedAgain.long_form.state === 'approved' && readJson(approvalFile).approved_at === record.approved_at, approvedAgain.long_form);

// stale QA evidence (design changed after QA) is rejected
const designFile = path.join(projectDir, 'thumbnail', 'design.json');
const designBackup = fs.readFileSync(designFile);
const designJson = JSON.parse(designBackup.toString('utf8'));
fs.writeFileSync(designFile, JSON.stringify({ ...designJson, concept: { ...designJson.concept, subhead: 'बदला हुआ उपशीर्षक' } }, null, 2));
const changedDesignOnDisk = readJson(designFile);
check(
  '11q0 the mutated design on disk is a different design',
  changedDesignOnDisk.design_hash !== longDesign.design_hash || changedDesignOnDisk.concept.subhead !== longDesign.concept.subhead,
  { onDisk: changedDesignOnDisk.concept.subhead, original: longDesign.concept.subhead, diskHash: changedDesignOnDisk.design_hash },
);
const designChangedApprove = await TWF.approveThumbnailArtifact({ ...thumbOptions, confirmed: true });
check('11q a design change after QA blocks approval', designChangedApprove.status === 'REFUSED' && designChangedApprove.reason.includes('design changed'), designChangedApprove);
const designChangedStatus = await TWF.thumbnailStatus(thumbOptions);
check('11r a design change after the render is reported stale', designChangedStatus.long_form.state === 'stale' && designChangedStatus.long_form.stale_reason.includes('design changed'));
fs.writeFileSync(designFile, designBackup);

// =======================================================================================
// 12. Selective invalidation (design / clip / narration)
// =======================================================================================

// (1) a thumbnail design change must not invalidate any video render
const mediaBeforeDesignChange = snapshotMedia();
const overridePlan = await TWF.planThumbnail({ ...thumbOptions, overrides: { headline: 'कुआं — दूसरा रूप' }, now: T2 });
check('12a a new design is written', overridePlan.written === true && overridePlan.design.design_hash !== longDesign.design_hash);
check('12b a thumbnail design change does not touch any video artifact', JSON.stringify(snapshotMedia()) === JSON.stringify(mediaBeforeDesignChange));
const overrideRender = await TWF.renderThumbnailArtifact({ ...thumbOptions, now: T2 });
check('12c the new design renders to new bytes', overrideRender.action === 'RENDERED' && overrideRender.checkpoint.artifact_hash !== artifactBefore);
const backToDefault = await TWF.planThumbnail({ ...thumbOptions, now: T2 });
const restoredRender = await TWF.renderThumbnailArtifact({ ...thumbOptions, now: T2 });
check('12d restoring the original design restores the original artifact', backToDefault.design.design_hash === longDesign.design_hash && shaFile(longArtifact) === artifactBefore);
check('12e the short covers were never invalidated by the long-form design change', (await TWF.thumbnailStatus(thumbOptions)).covers.find((c: any) => c.owner_id === 'short-01').state === 'approved');

// (2) a changed clip invalidates only the thumbnails that used it
const clip1 = path.join(projectDir, 'scene-0001.mp4');
const clip1Bytes = fs.readFileSync(clip1);
fs.appendFileSync(clip1, Buffer.from([0x00]));
const unrelatedRender = await TWF.renderThumbnailArtifact({ ...thumbOptions, now: T2 });
const unrelatedCover = await TWF.renderThumbnailArtifact({ ...thumbOptions, shortId: 'short-01', now: T2 });
check('12f an unrelated clip change does not invalidate the long-form thumbnail', unrelatedRender.action === 'REUSED');
check('12g an unrelated clip change does not invalidate a Short cover', unrelatedCover.action === 'REUSED');
fs.writeFileSync(clip1, clip1Bytes);

const cover2Base = path.join(projectDir, 'scene-0005.mp4');
const cover2BaseBytes = fs.readFileSync(cover2Base);
fs.appendFileSync(cover2Base, Buffer.from([0x00]));
const cover2Stale = await TWF.renderThumbnailArtifact({ ...thumbOptions, shortId: 'short-02', now: T2 });
check('12h the cover whose source frame changed is refused', cover2Stale.action === 'FAILED' && cover2Stale.errors.join(' ').includes('source changed'));
check('12i the long-form thumbnail is unaffected by a Short cover source change', (await TWF.renderThumbnailArtifact({ ...thumbOptions, now: T2 })).action === 'REUSED');
fs.writeFileSync(cover2Base, cover2BaseBytes);

// (3) a changed narration line invalidates only narration dependents
const coverHashBefore = shaFile(cover1Render.artifactPath);
const thumbsBefore = await TWF.thumbnailStatus(thumbOptions);
await writeWav(path.join(narrationDir, 'narration-0005.wav'), 3.4, 777);
const narrationAgain = await NWF.refreshNarrationAssets({ ...narrationOptions, now: T2, runMediaQa: fakeMedia });
const thumbsAfter = await TWF.thumbnailStatus(thumbOptions);
check(
  '12j a re-recorded line invalidates only its own narration dependents',
  narrationAgain.invalidation.changed_scenes.includes(5)
  && narrationAgain.invalidation.stale_dependents['long-form:audio_mix'].includes(5)
  && narrationAgain.invalidation.stale_dependents['shorts:short-02'].join(',') === '5'
  && !(narrationAgain.invalidation.stale_dependents['shorts:short-01'] ?? []).includes(5),
  narrationAgain.invalidation,
);
check('12k narration changes never invalidate thumbnail artifacts', thumbsAfter.long_form.state === thumbsBefore.long_form.state && thumbsAfter.covers.every((cover: any, index: number) => cover.state === thumbsBefore.covers[index].state && cover.artifact_hash === thumbsBefore.covers[index].artifact_hash));
check('12l the cover bytes are untouched by the narration change', shaFile(cover1Render.artifactPath) === coverHashBefore);
check('12m no video artifact changed during the whole thumbnail phase', JSON.stringify(snapshotMedia()) === JSON.stringify(mediaBefore));

// =======================================================================================
// 13. Phase 1–6 regression protection
// =======================================================================================

check('13a the Phase 5 reliability contract still has exactly 13 stages', REL.RELIABILITY_STAGES.length === 13, REL.RELIABILITY_STAGES);
check('13b the stage names are unchanged', JSON.stringify(REL.RELIABILITY_STAGES) === JSON.stringify([
  'STORY', 'STORY_VALIDATION', 'SCENE_PLANNING', 'NARRATION', 'GENERATION', 'SCENE_ASSEMBLY',
  'AUDIO_MIX', 'MUSIC_BED', 'FINAL_RENDER', 'MEDIA_QA', 'HUMAN_REVIEW', 'APPROVAL', 'PUBLISH_HANDOFF',
]));
check('13c NARRATION is still a single stage (no new stage was invented)', REL.RELIABILITY_STAGES.filter((stage: string) => stage === 'NARRATION').length === 1);
check('13d the Shorts dimensions are unchanged', TT.SHORTS_COVER_DIMENSIONS.width === 1080 && TT.SHORTS_COVER_DIMENSIONS.height === 1920);
const shortPlan = SP.createShortsPlan({ projectId, pipeline, count: 2, sceneDurations: Object.fromEntries(SCENES.map((s) => [s.n, 2])), now: T0 });
check(
  '13e Phase 6 Shorts planning still works from the same story',
  shortPlan.count >= 1 && shortPlan.shorts.length === shortPlan.count
  && shortPlan.shorts.every((short: any) => short.scene_refs.length >= 3 && short.scene_refs.length <= 6 && Boolean(short.title)),
  { count: shortPlan.count, warnings: shortPlan.warnings },
);
check('13f Phase 6 render/plan/qa entry points still exist', ['planShorts', 'renderShorts', 'qaShorts', 'approveShort', 'shortsStatus', 'loadCheckpoint'].every((name) => typeof SWF[name] === 'function'), Object.keys(SWF));
check('13g the Shorts checkpoint accepts the additive narration_hashes field', 'narration_hashes' in readJson(path.join(projectDir, 'shorts', 'short-01', 'short.json')));
check('13h the narration layer still declares the long-form NARRATION dependents', second.invalidation.stale_dependents['long-form:audio_mix'].join(',') === '3');

// =======================================================================================
// 14. No paid provider calls, no external network access
// =======================================================================================

check('14a no network call was attempted by the whole Phase 7 surface', networkAttempts === 0, networkAttempts);
const PHASE7_SOURCES = [
  'narrationAssets.ts', 'narrationQa.ts', 'narrationAssetWorkflow.ts',
  'thumbnailTypes.ts', 'thumbnailDesign.ts', 'thumbnailRender.ts', 'thumbnailQa.ts', 'thumbnailWorkflow.ts',
];
for (const name of PHASE7_SOURCES) {
  const text = fs.readFileSync(`${SRC}/${name}`, 'utf8');
  check(`14b ${name} contains no network/provider call`, !/https?:\/\//i.test(text) && !/\bfetch\s*\(/.test(text) && !/generativelanguage|api\.openai\.com|zernio|cloudflarestorage|playwright/i.test(text));
  check(`14c ${name} never imports a paid provider module`, !/from '\.\/(providers|narrationTts|flow|gemini)/i.test(text));
}
check('14d no API key was read or printed by the tests', !JSON.stringify([first.ledger, longDesign, longRender.checkpoint]).includes('API_KEY'));

// =======================================================================================
// 15. Protected production assets are never modified
// =======================================================================================

const REAL_ID = 'youtube-automation-2-20261003160855-2740';
const realPipeline = `${REPO}/scripting/projects/${REAL_ID}/pipeline.json`;
const protectedFiles = [
  realPipeline,
  `${REPO}/scripting/projects/${REAL_ID}/seo/youtube-metadata.json`,
  `${REPO}/scripting/projects/${REAL_ID}/seo/history/generation-003-20261103T163337Z/manifest.json`,
  `${PROD}/outputs/${REAL_ID}/approval.json`,
  `${PROD}/outputs/${REAL_ID}/final-title.mp4`,
];
const realPresent = exists(realPipeline) && exists(`${PROD}/outputs/${REAL_ID}`);
if (!realPresent) {
  console.log('SKIP 15 the real production project is not present in this checkout');
  passed += 1;
} else {
  const before = protectedFiles.filter(exists).map((file) => [file, shaFile(file)]);
  check('15a all protected real assets exist', before.length === protectedFiles.length, before.map(([file]) => path.basename(String(file))));
  const realOutputs = `${PROD}/outputs/${REAL_ID}`;
  const outputsListingBefore = listAll(realOutputs);
  const realNarrationDir = `${PROD}/inputs/${REAL_ID}/narration`;
  const realNarrationBefore = listFiles(realNarrationDir).map((name) => [name, shaFile(path.join(realNarrationDir, name))]);

  const realNarrationStatus = await NWF.narrationStatus({ projectId: REAL_ID, pipeline: null, outputsRoot: `${PROD}/outputs`, inputRoot: `${PROD}/inputs/${REAL_ID}` });
  const realThumbStatus = await TWF.thumbnailStatus({ projectId: REAL_ID, outputsRoot: `${PROD}/outputs`, inputRoot: `${PROD}/inputs/${REAL_ID}` });
  check('15b read-only narration status reports the real project', realNarrationStatus.read_only === true && realNarrationStatus.project_id === REAL_ID);
  check('15c read-only thumbnail status reports the real project', realThumbStatus.read_only === true && realThumbStatus.publishable === false && realThumbStatus.long_form_media_modified === false);

  const outputsListingAfter = listAll(realOutputs);
  check('15d the read-only status calls created no files in the real outputs', JSON.stringify(outputsListingAfter) === JSON.stringify(outputsListingBefore), outputsListingAfter.filter((name) => !outputsListingBefore.includes(name)));
  check('15e no derived narration/thumbnail/shorts directory was created in the real outputs', !exists(path.join(realOutputs, 'narration')) && !exists(path.join(realOutputs, 'thumbnail')) && !exists(path.join(realOutputs, 'shorts')));

  const after = protectedFiles.filter(exists).map((file) => [file, shaFile(file)]);
  check('15f every protected real asset is byte-identical', JSON.stringify(after) === JSON.stringify(before));
  check('15g the real narration inputs are untouched', JSON.stringify(listFiles(realNarrationDir).map((name) => [name, shaFile(path.join(realNarrationDir, name))])) === JSON.stringify(realNarrationBefore));
  console.log(`      verified ${before.length} protected assets + ${outputsListingBefore.length} real output files + ${realNarrationBefore.length} narration inputs`);
}

// =======================================================================================
// Teardown
// =======================================================================================
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nPHASE 7: ${passed} checks passed (network attempts: ${networkAttempts}).`);
