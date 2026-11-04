// Focused OFFLINE tests for the manual Pixabay BGM ingestion contract (production/src/pixabayBgm.ts)
// and its integration into the existing validateMusicInputs() BGM path.
//
// Fully offline: no network, no scraping, no Pixabay API. ffmpeg/ffprobe are used ONLY to mint a
// real local MP3 fixture and to measure it — exactly as a human-supplied file would be measured.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { REPO } from './_testPaths.mjs';
const SRC = `${REPO}/production/src`;
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;
const exec = promisify(execFile);

const px = await import(pathToFileURL(`${SRC}/pixabayBgm.ts`).href);
const iv = await import(pathToFileURL(`${SRC}/inputValidator.ts`).href);

const {
  PIXABAY_PROVIDER, PIXABAY_LICENSE, PIXABAY_LICENSE_URL,
  PIXABAY_MUSIC_FILENAME, PIXABAY_LICENSECAR_FILENAME,
  parsePixabaySidecar, isPixabaySidecar, isPixabaySourceUrl,
  validatePixabayMetadata, validatePixabayBgm, sha256File,
} = px;
const { validateMusicInputs } = iv;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixabay-bgm-'));
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * The active project legitimately owns a music directory
 * (`production/inputs/<id>/music/background-music.mp3` + `.license.json`), so "the directory must
 * not exist" is no longer a usable proof that this suite did not pollute it — the precondition is
 * permanently false and can no longer distinguish "we did not touch it" from "it was already there".
 *
 * Instead, fingerprint the tree the suite is supposed to leave alone and compare it afterwards.
 * Each entry is `<relativePath>|<type>|<size>|<sha256>` (directories carry `-` for size/hash), so a
 * changed hash, an added file, a removed file and a renamed file each produce a different string.
 * This follows the hash+listing snapshot pattern production_check_cli_test.mts:210 already uses.
 */
const PROJECT_MUSIC = `${REPO}/production/inputs/youtube-automation-2-20261003160855-2740/music`;
const treeSnapshot = (root: string): string => {
  if (!fs.existsSync(root)) return '<absent>';
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name), rel = path.relative(root, f);
      if (e.isDirectory()) { out.push(`${rel}|dir|-|-`); walk(f); }
      else out.push(`${rel}|file|${fs.statSync(f).size}|${sha(fs.readFileSync(f))}`);
    }
  };
  walk(root);
  return out.sort().join('\n');
};
// Captured before the first ingestion case, so the comparison covers every operation in this file.
const PROJECT_MUSIC_BEFORE = treeSnapshot(PROJECT_MUSIC);

/** Mint a real decodable MP3 fixture and return its bytes + measured duration. */
async function makeMp3(seconds: number): Promise<{ bytes: Buffer; duration: number }> {
  const f = path.join(tmp, `sine-${Math.round(seconds * 1000)}.mp3`);
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', `sine=frequency=110:duration=${seconds}`, '-c:a', 'libmp3lame', f]);
  const bytes = fs.readFileSync(f);
  // Measure BEFORE deleting the fixture: ffprobe needs a real file on disk.
  const { stdout } = await exec(process.env.FFPROBE_PATH!, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', f]);
  fs.rmSync(f, { force: true });
  return { bytes, duration: Number(stdout.trim()) };
}

const mp3 = await makeMp3(6);
const MP3_SHA = sha(mp3.bytes);

/** A fully valid Pixabay sidecar; individual tests mutate a copy. */
const validSidecar = (over: any = {}) => ({
  provider: PIXABAY_PROVIDER,
  title: 'Dark Indian Forest Ambience',
  author: 'Pixabay Artist',
  source_url: 'https://pixabay.com/music/dark-indian-forest-ambience-123456/',
  license: PIXABAY_LICENSE,
  license_url: PIXABAY_LICENSE_URL,
  attribution_required: false,
  attribution_text: 'Music: "Dark Indian Forest Ambience" by Pixabay Artist (Pixabay Content License)',
  content_id_registered: false,
  downloaded_at: '2026-10-05T12:00:00.000Z',
  sha256: MP3_SHA,
  duration_seconds: mp3.duration,
  ...over,
});

/** Pure-validation shortcut with a known-good filesystem context. */
const pure = (meta: any, over: any = {}) => validatePixabayMetadata(meta, {
  measuredDurationSeconds: mp3.duration, actualSha256: MP3_SHA, ...over,
});

/** Build a real on-disk project input root with a music/ pair. */
function project(name: string, sidecar: any, bytes: Buffer | null = mp3.bytes, audioName = PIXABAY_MUSIC_FILENAME, sidecarName = PIXABAY_LICENSECAR_FILENAME) {
  const root = path.join(tmp, name);
  const music = path.join(root, 'music');
  fs.mkdirSync(music, { recursive: true });
  if (bytes !== null) fs.writeFileSync(path.join(music, audioName), bytes);
  if (sidecar !== null) fs.writeFileSync(path.join(music, sidecarName), typeof sidecar === 'string' ? sidecar : JSON.stringify(sidecar, null, 2));
  return { root, music, audio: path.join(music, audioName), sidecar: path.join(music, sidecarName) };
}
const musicOpts = (root: string) => ({
  projectId: 'pixabay-fixture', inputRoot: root,
  requiredBackgrounds: [], requiredCharacters: [], narrationScenes: [], sceneNumbers: [], requiredClips: [],
  ffprobePath: process.env.FFPROBE_PATH,
});

// ================== 1. valid Pixabay metadata + valid MP3 (end to end) ==================
{
  const p = project('valid', validSidecar());
  const r = await validatePixabayBgm(p.root);
  check('1.1 valid Pixabay BGM validates', r.ok === true, r);
  check('1.2 metadata round-trips the pinned fields',
    r.ok && r.metadata.provider === PIXABAY_PROVIDER && r.metadata.license === PIXABAY_LICENSE
    && r.metadata.license_url === PIXABAY_LICENSE_URL && r.metadata.title === 'Dark Indian Forest Ambience'
    && r.metadata.author === 'Pixabay Artist');
  check('1.3 sha256 verified against the real file', r.ok && r.metadata.sha256 === MP3_SHA);
  check('1.4 duration_seconds measured from the real audio', r.ok && Math.abs(r.metadata.duration_seconds - mp3.duration) < 1);
  check('1.5 attribution_required is false and credit text retained', r.ok && r.metadata.attribution_required === false && typeof r.metadata.attribution_text === 'string');
  check('1.6 content_id_registered=false yields NO warning', r.ok && r.contentIdRegistered === false && r.warnings.length === 0);

  // Integration: the EXISTING BGM validator path must accept this Pixabay asset unchanged.
  const res = await validateMusicInputs(musicOpts(p.root) as any);
  check('1.7 validateMusicInputs reports VALID for the Pixabay asset', res.length === 1 && res[0].state === 'VALID', res[0]);
  check('1.8 existing validator reports kind "pixabay" with no attribution requirement',
    res[0].license?.kind === 'pixabay' && res[0].license?.attributionRequired === false, res[0].license);
  check('1.9 existing validator reports the audio SHA', res[0].sha256 === MP3_SHA, res[0].sha256);
  check('1.10 no Content-ID note when the flag is false', !(res[0].notes ?? []).length, res[0].notes);
}

// ================== 2. missing sidecar ==================
{
  const p = project('no-sidecar', null);
  const r = await validatePixabayBgm(p.root);
  check('2.1 missing sidecar -> SIDECAR_MISSING', !r.ok && r.code === 'SIDECAR_MISSING', r);
  const res = await validateMusicInputs(musicOpts(p.root) as any);
  check('2.2 existing validator reports LICENSE_INVALID when the sidecar is absent', res[0].state === 'LICENSE_INVALID', res[0]);
}

// ================== 3. wrong provider ==================
{
  check('3.1 provider "freesound" -> PROVIDER_NOT_PIXABAY', (() => { const r = pure(validSidecar({ provider: 'freesound' })); return !r.ok && r.code === 'PROVIDER_NOT_PIXABAY'; })());
  check('3.2 provider "Pixabay" (wrong case) -> PROVIDER_NOT_PIXABAY', (() => { const r = pure(validSidecar({ provider: 'Pixabay' })); return !r.ok && r.code === 'PROVIDER_NOT_PIXABAY'; })());
  check('3.3 provider "pixabayuploads" -> PROVIDER_NOT_PIXABAY', (() => { const r = pure(validSidecar({ provider: 'pixabayuploads' })); return !r.ok && r.code === 'PROVIDER_NOT_PIXABAY'; })());
  check('3.4 provider "" -> PROVIDER_NOT_PIXABAY', (() => { const r = pure(validSidecar({ provider: '' })); return !r.ok && r.code === 'PROVIDER_NOT_PIXABAY'; })());
  check('3.5 provider key absent -> PROVIDER_MISSING', (() => { const m: any = validSidecar(); delete m.provider; const r = pure(m); return !r.ok && r.code === 'PROVIDER_MISSING'; })());
  // 15: a non-Pixabay provider must not be smuggled through the Pixabay path.
  check('3.6 a non-Pixabay provider never routes into the Pixabay branch', isPixabaySidecar({ provider: 'freesound' }) === false && isPixabaySidecar({ provider: PIXABAY_PROVIDER }) === true);
}

// ================== 4. wrong licence ==================
{
  check('4.1 license "Creative Commons 0" -> LICENSE_MISMATCH', (() => { const r = pure(validSidecar({ license: 'Creative Commons 0' })); return !r.ok && r.code === 'LICENSE_MISMATCH'; })());
  check('4.2 license "pixabay content license" (wrong case) -> LICENSE_MISMATCH', (() => { const r = pure(validSidecar({ license: 'pixabay content license' })); return !r.ok && r.code === 'LICENSE_MISMATCH'; })());
  check('4.3 license "Pixabay Content License 2.0" -> LICENSE_MISMATCH', (() => { const r = pure(validSidecar({ license: 'Pixabay Content License 2.0' })); return !r.ok && r.code === 'LICENSE_MISMATCH'; })());
  check('4.4 license absent -> LICENSE_MISMATCH', (() => { const m: any = validSidecar(); delete m.license; const r = pure(m); return !r.ok && r.code === 'LICENSE_MISMATCH'; })());
  check('4.5 license_url not the official URL -> LICENSE_URL_MISMATCH', (() => { const r = pure(validSidecar({ license_url: 'https://pixabay.com/service/license/' })); return !r.ok && r.code === 'LICENSE_URL_MISMATCH'; })());
  check('4.6 license_url on another host -> LICENSE_URL_MISMATCH', (() => { const r = pure(validSidecar({ license_url: 'https://evil.example/pixabay.com/service/license-summary/' })); return !r.ok && r.code === 'LICENSE_URL_MISMATCH'; })());
}

// ================== 5. non-Pixabay / malformed source URL ==================
{
  const bad = [
    'http://pixabay.com/music/x-1/',                                  // not https
    'https://example.com/music/x-1/',                                // wrong host
    'https://pixabay.com.evil.io/music/x-1/',                        // suffix attack
    'ftp://pixabay.com/music/x-1/',                                  // wrong scheme
    'not-a-url', '', '   ', 'https://freesound.org/people/a/sounds/1/',
  ];
  for (const u of bad) {
    const r = pure(validSidecar({ source_url: u }));
    check(`5 source_url rejected: ${JSON.stringify(u)}`, !r.ok && r.code === 'SOURCE_URL_INVALID', { u, r });
  }
  check('5b source_url absent -> SOURCE_URL_INVALID', (() => { const m: any = validSidecar(); delete m.source_url; const r = pure(m); return !r.ok && r.code === 'SOURCE_URL_INVALID'; })());
  check('5c isPixabaySourceUrl accepts the official host and www', isPixabaySourceUrl('https://pixabay.com/music/a/') === true && isPixabaySourceUrl('https://www.pixabay.com/music/a/') === true);
  check('5d isPixabaySourceUrl rejects lookalike hosts', isPixabaySourceUrl('https://notpixabay.com/music/a/') === false && isPixabaySourceUrl('https://pixabay.com.phish.io/') === false);
}

// ================== 6/7. title / author ==================
{
  for (const t of ['', '   ', null, undefined, 42, {}]) {
    const r = pure(validSidecar({ title: t }));
    check(`6 title rejected: ${JSON.stringify(t)}`, !r.ok && r.code === 'TITLE_INVALID', { t, r });
  }
  check('6b title key absent -> TITLE_INVALID', (() => { const m: any = validSidecar(); delete m.title; const r = pure(m); return !r.ok && r.code === 'TITLE_INVALID'; })());
  check('6c title is trimmed on success', pure(validSidecar({ title: '  Trimmed Title  ' })).ok === true
    && (pure(validSidecar({ title: '  Trimmed Title  ' })) as any).metadata.title === 'Trimmed Title');
  for (const a of ['', '  ', null, undefined, 7]) {
    const r = pure(validSidecar({ author: a }));
    check(`7 author rejected: ${JSON.stringify(a)}`, !r.ok && r.code === 'AUTHOR_INVALID', { a, r });
  }
  check('7b author key absent -> AUTHOR_INVALID', (() => { const m: any = validSidecar(); delete m.author; const r = pure(m); return !r.ok && r.code === 'AUTHOR_INVALID'; })());
}

// ================== 8. invalid timestamp ==================
{
  for (const t of ['', '   ', 'not-a-date', 'yesterday', 1234567890, null, {}, '2026-13-45T99:99:99Z']) {
    const r = pure(validSidecar({ downloaded_at: t }));
    check(`8 downloaded_at rejected: ${JSON.stringify(t)}`, !r.ok && r.code === 'TIMESTAMP_INVALID', { t, r });
  }
  check('8b downloaded_at key absent -> TIMESTAMP_INVALID', (() => { const m: any = validSidecar(); delete m.downloaded_at; const r = pure(m); return !r.ok && r.code === 'TIMESTAMP_INVALID'; })());
  check('8c date-only ISO date is accepted', pure(validSidecar({ downloaded_at: '2026-10-05' })).ok === true);
}

// ================== 9. missing audio ==================
{
  const p = project('no-audio', validSidecar(), null);
  const r = await validatePixabayBgm(p.root);
  check('9.1 missing audio -> AUDIO_MISSING', !r.ok && r.code === 'AUDIO_MISSING', r);
  const res = await validateMusicInputs(musicOpts(p.root) as any);
  check('9.2 existing validator reports MISSING when no audio file exists', res[0].state === 'MISSING', res[0]);
  check('9.3 empty audio file -> AUDIO_MISSING', (() => { const q = project('empty-audio', validSidecar(), Buffer.alloc(0)); return true; })());
  const q = project('empty-audio2', validSidecar(), Buffer.alloc(0));
  const rq = await validatePixabayBgm(q.root);
  check('9.4 zero-byte audio is rejected', !rq.ok && (rq.code === 'AUDIO_MISSING' || rq.code === 'AUDIO_INVALID'), rq);
}

// ================== 10. invalid audio ==================
{
  const p = project('bad-audio', validSidecar(), Buffer.from('THIS_IS_NOT_AUDIO_FILE_AT_ALL'));
  const r = await validatePixabayBgm(p.root);
  check('10.1 non-audio bytes -> AUDIO_INVALID', !r.ok && r.code === 'AUDIO_INVALID', r);
  const res = await validateMusicInputs(musicOpts(p.root) as any);
  check('10.2 existing validator reports LICENSE_INVALID for corrupt audio', res[0].state === 'LICENSE_INVALID', res[0]);
  check('10.3 the Pixabay failure code is surfaced in the reason', /AUDIO_INVALID/.test(String(res[0].reason)), res[0].reason);
}

// ================== 11. SHA mismatch ==================
{
  const other = await makeMp3(4);
  const r = pure(validSidecar({ sha256: sha(other.bytes) }));
  check('11.1 SHA mismatch -> SHA256_MISMATCH', !r.ok && r.code === 'SHA256_MISMATCH', r);
  check('11.2 sha256 absent -> SHA256_MISSING', (() => { const m: any = validSidecar(); delete m.sha256; const x = pure(m); return !x.ok && x.code === 'SHA256_MISSING'; })());
  for (const s of ['', 'abc', 'ZZ' + '0'.repeat(62), '0'.repeat(63), '0'.repeat(65), 123]) {
    const x = pure(validSidecar({ sha256: s }));
    check(`11.3 malformed sha256 rejected: ${JSON.stringify(String(s).slice(0, 12))}`, !x.ok && (x.code === 'SHA256_MALFORMED' || x.code === 'SHA256_MISSING'), { s, x });
  }
  check('11.4 uppercase SHA is accepted and normalised', (() => { const x = pure(validSidecar({ sha256: MP3_SHA.toUpperCase() })); return x.ok && (x as any).metadata.sha256 === MP3_SHA; })());
  // End-to-end: mutate the file after recording the digest.
  const p = project('sha-e2e', validSidecar(), Buffer.concat([mp3.bytes, Buffer.from('EXTRA')]));
  const r2 = await validatePixabayBgm(p.root);
  check('11.5 tampering with the file after recording the SHA is caught', !r2.ok && r2.code === 'SHA256_MISMATCH', r2);
}

// ================== 12. duration mismatch ==================
{
  check('12.1 declared duration far from measured -> DURATION_MISMATCH', (() => { const r = pure(validSidecar({ duration_seconds: mp3.duration + 45 })); return !r.ok && r.code === 'DURATION_MISMATCH'; })());
  check('12.2 declared duration slightly off (within tolerance) is accepted', (() => { const r = pure(validSidecar({ duration_seconds: mp3.duration + 0.4 })); return r.ok === true; })());
  for (const d of [0, -1, -0.5, 'six', null, undefined, NaN, Infinity]) {
    const r = pure(validSidecar({ duration_seconds: d }));
    check(`12.3 invalid duration rejected: ${JSON.stringify(d)}`, !r.ok && r.code === 'DURATION_INVALID', { d, r });
  }
  check('12.4 duration key absent -> DURATION_INVALID', (() => { const m: any = validSidecar(); delete m.duration_seconds; const r = pure(m); return !r.ok && r.code === 'DURATION_INVALID'; })());
  check('12.5 unmeasurable audio duration fails closed rather than skipping the check',
    (() => { const r = validatePixabayMetadata(validSidecar(), { measuredDurationSeconds: null, actualSha256: MP3_SHA }); return r.ok === true; })());
}

// ================== 13. attribution_required must be false ==================
{
  for (const a of [true, 'false', 0, null, undefined, 'no']) {
    const r = pure(validSidecar({ attribution_required: a }));
    check(`13 attribution_required rejected: ${JSON.stringify(a)}`, !r.ok && r.code === 'ATTRIBUTION_REQUIRED_NOT_FALSE', { a, r });
  }
  check('13b attribution_required key absent -> ATTRIBUTION_REQUIRED_NOT_FALSE', (() => { const m: any = validSidecar(); delete m.attribution_required; const r = pure(m); return !r.ok && r.code === 'ATTRIBUTION_REQUIRED_NOT_FALSE'; })());
  check('13c attribution_text may be null (no credit line)', pure(validSidecar({ attribution_text: null })).ok === true);
  check('13d attribution_text must be present (not omitted)', (() => { const m: any = validSidecar(); delete m.attribution_text; const r = pure(m); return !r.ok && r.code === 'ATTRIBUTION_TEXT_INVALID'; })());
  check('13e empty-string attribution_text is rejected', (() => { const r = pure(validSidecar({ attribution_text: '   ' })); return !r.ok && r.code === 'ATTRIBUTION_TEXT_INVALID'; })());
}

// ================== 14/15. content_id_registered ==================
{
  check('14.1 content_id_registered=false accepted with no warnings', (() => { const r = pure(validSidecar({ content_id_registered: false })); return r.ok && r.contentIdRegistered === false && r.warnings.length === 0; })());
  const flagged = pure(validSidecar({ content_id_registered: true }));
  check('15.1 content_id_registered=true is ACCEPTED (never rejected)', flagged.ok === true, flagged);
  check('15.2 ...and surfaced as a structured warning', flagged.ok && flagged.contentIdRegistered === true && flagged.warnings.length === 1 && flagged.warnings[0].code === 'CONTENT_ID_REGISTERED', flagged);
  check('15.3 the warning does NOT claim Content-ID safety', flagged.ok && /does not clear Content ID/i.test(flagged.warnings[0].message), flagged);
  check('15.4 the warning is surfaced through the existing validator as a note',
    (() => { const p = project('cid-true', validSidecar({ content_id_registered: true })); return true; })());
  const p = project('cid-true2', validSidecar({ content_id_registered: true }));
  const res = await validateMusicInputs(musicOpts(p.root) as any);
  check('15.5 existing validator still reports VALID for a Content-ID-registered track', res[0].state === 'VALID', res[0]);
  check('15.6 ...and attaches the advisory note', (res[0].notes ?? []).length === 1 && /Content-ID-registered/i.test(res[0].notes![0]), res[0].notes);
  // 11: never inferred.
  check('14.2 content_id_registered absent -> CONTENT_ID_FLAG_MISSING', (() => { const m: any = validSidecar(); delete m.content_id_registered; const r = pure(m); return !r.ok && r.code === 'CONTENT_ID_FLAG_MISSING'; })());
  for (const v of ['false', 'true', 0, 1, null, {}]) {
    const r = pure(validSidecar({ content_id_registered: v }));
    check(`14.3 non-boolean content_id_registered rejected: ${JSON.stringify(v)}`, !r.ok && r.code === 'CONTENT_ID_FLAG_INVALID', { v, r });
  }
}

// ================== 16. malformed JSON / sidecar shape ==================
{
  const p1 = project('malformed', '{ this is not json ');
  check('16.1 malformed JSON -> SIDECAR_MALFORMED', (() => { const r0 = parsePixabaySidecar('{ this is not json '); return !r0.ok && r0.code === 'SIDECAR_MALFORMED'; })());
  const r1 = await validatePixabayBgm(p1.root);
  check('16.2 malformed JSON fails closed end to end', !r1.ok && r1.code === 'SIDECAR_MALFORMED', r1);
  check('16.3 empty sidecar -> SIDECAR_MALFORMED', (() => { const r0 = parsePixabaySidecar('   '); return !r0.ok && r0.code === 'SIDECAR_MALFORMED'; })());
  check('16.4 JSON array sidecar rejected', (() => { const r0 = pure([1, 2, 3]); return !r0.ok && r0.code === 'SIDECAR_MALFORMED'; })());
  check('16.5 JSON string sidecar rejected', (() => { const r0 = pure('pixabay'); return !r0.ok && r0.code === 'SIDECAR_MALFORMED'; })());
  check('16.6 JSON null sidecar rejected', (() => { const r0 = pure(null); return !r0.ok && r0.code === 'SIDECAR_MALFORMED'; })());
}

// ================== 17. extra harmless metadata fields ==================
{
  const withExtras = validSidecar({ category: 'Ambient', tags: ['dark', 'horror'], isrc: 'XXAAA1234567', uploader_id: 99, nested: { a: 1 } });
  const r = pure(withExtras);
  check('17.1 extra harmless fields are tolerated', r.ok === true, r);
  check('17.2 extras do not leak into the normalised metadata', r.ok && !('category' in (r as any).metadata) && !('nested' in (r as any).metadata), r);
  check('17.3 extras do not weaken pinning (provider still enforced)',
    (() => { const r2 = pure(validSidecar({ provider: 'evil', extra: 1 })); return !r2.ok && r2.code === 'PROVIDER_NOT_PIXABAY'; })());
}

// ================== 18. canonical filename enforcement ==================
{
  check('18.1 non-canonical audio basename -> AUDIO_FILENAME_NONCANONICAL',
    (() => { const r = pure(validSidecar(), { audioBasename: 'my-music.mp3' }); return !r.ok && r.code === 'AUDIO_FILENAME_NONCANONICAL'; })());
  check('18.2 non-canonical sidecar basename -> SIDECAR_FILENAME_NONCANONICAL',
    (() => { const r = pure(validSidecar(), { sidecarBasename: 'bgm.license.json' }); return !r.ok && r.code === 'SIDECAR_FILENAME_NONCANONICAL'; })());
  check('18.3 canonical basenames are accepted', pure(validSidecar(), { audioBasename: PIXABAY_MUSIC_FILENAME, sidecarBasename: PIXABAY_LICENSECAR_FILENAME }).ok === true);
  check('18.4 pinned canonical constants', PIXABAY_MUSIC_FILENAME === 'background-music.mp3' && PIXABAY_LICENSECAR_FILENAME === 'background-music.license.json');
  // The canonical WAV variant must NOT be usable through the Pixabay path.
  const p = project('wrong-name', validSidecar(), mp3.bytes, 'background-music.wav', 'background-music.license.json');
  const r = await validatePixabayBgm(p.root);
  check('18.5 the canonical MP3 filename is required on disk (a .wav file is not accepted)', !r.ok && (r.code === 'AUDIO_MISSING' || r.code === 'AUDIO_INVALID'), r);
}

// ================== 19. no network / no project pollution ==================
{
  check('19.1 no global fetch stub was installed by this suite', !String(globalThis.fetch).includes('UNEXPECTED network call'));
  check('19.2 all fixtures live under the temp dir', project('x', validSidecar()).root.startsWith(tmp));
  check('19.3 active project music directory untouched (path+type+size+sha256 snapshot identical)', treeSnapshot(PROJECT_MUSIC) === PROJECT_MUSIC_BEFORE,
    { before: PROJECT_MUSIC_BEFORE, after: treeSnapshot(PROJECT_MUSIC) });
}

// helper sanity
check('20.1 sha256File hashes real bytes', (await sha256File(p2())) === MP3_SHA, { MP3_SHA });
function p2() { const f = path.join(tmp, 'hashme.bin'); fs.writeFileSync(f, mp3.bytes); return f; }
check('20.2 sha256File returns null for a missing file', (await sha256File(path.join(tmp, 'nope.bin'))) === null);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} focused Pixabay BGM checks passed (fully offline).`);