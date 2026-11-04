// Focused OFFLINE unit tests for the existing Freesound BGM acquisition logic (production/src/bgm.ts).
//
// NO NETWORK: globalThis.fetch is stubbed for every case. No real HTTP request is ever issued, no
// production input file is touched, and the active project's pre-existing music directory is
// content-snapshotted before/after and left byte-identical — all writes go to a temp directory.
// These tests document EXISTING behavior only; runtime code is unchanged.
//
// DEFECTS FIXED in this change: (1) the licence sidecar is now written as
// "background-music.license.json" (was "background-music.mp3.license.json"), which is the name
// validateMusicInputs() reads; (2) ND detection no longer fails open on "Nonderivatives".
//
// STILL OPEN (documented, intentionally UNFIXED): metadataFor() emits `attribution_text`, while
// validateMusicInputs() reads `meta.attribution`. A CC BY acquisition therefore does NOT satisfy the
// validator contract. Section 7 pins that mismatch so it cannot be silently forgotten.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { REPO } from './_testPaths.mjs';
const SRC = `${REPO}/production/src`;

const bgm = await import(pathToFileURL(`${SRC}/bgm.ts`).href);
const iv = await import(pathToFileURL(`${SRC}/inputValidator.ts`).href);

const { evaluateLicense, pickTrack, metadataFor, resolveBgmSource, missingCredentials, FREESOUND_CREDENTIALS,
        DEFAULT_BGM_QUERY, FREESOUND_LICENSE_CC0, FREESOUND_LICENSE_BY } = bgm;
const { validateMusicInputs } = iv;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-offline-'));
const realFetch = globalThis.fetch;

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
      else out.push(`${rel}|file|${fs.statSync(f).size}|${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}`);
    }
  };
  walk(root);
  return out.sort().join('\n');
};
// Captured before the first acquisition, so the comparison covers every operation in this file.
const PROJECT_MUSIC_BEFORE = treeSnapshot(PROJECT_MUSIC);

/** Build a Freesound-shaped search result. */
const result = (over: any = {}) => ({
  id: 1000, name: 'Ambient Drone', username: 'artist1', license: 'Creative Commons 0',
  duration: 120, url: 'https://freesound.org/people/artist1/sounds/1000/',
  previews: { 'preview-hq-mp3': 'https://freesound.org/preview/hq/1000.mp3', 'preview-lq-mp3': 'https://freesound.org/preview/lq/1000.mp3' },
  ...over,
});

/** Install an OFFLINE fetch stub. Token + search + audio preview are all served locally. */
function stubFetch(opts: { results?: any[] } = {}) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/oauth2/access_token/')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'stub-token' }) };
    }
    if (u.includes('/apiv2/search/text/')) {
      return { ok: true, status: 200, json: async () => ({ results: opts.results ?? [result()] }) };
    }
    if (u.includes('/preview/')) {
      // Stand-in MP3 bytes. The music validator only hashes; it never decodes BGM.
      return { ok: true, status: 200, body: {}, arrayBuffer: async () => new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]).buffer };
    }
    throw new Error(`UNEXPECTED network call in an offline test: ${u}`);
  }) as any;
  return calls;
}

const musicOpts = (inputRoot: string) => ({
  projectId: 'bgm-offline-fixture', inputRoot,
  requiredBackgrounds: [], requiredCharacters: [], narrationScenes: [], sceneNumbers: [], requiredClips: [],
});

// ================== 1. evaluateLicense ==================
{
  const cc0 = evaluateLicense('Creative Commons 0');
  check('1a CC0 accepted', cc0.allowed === true && cc0.kind === 'cc0' && cc0.attributionRequired === false, cc0);
  check('1b "cc0" alias accepted', evaluateLicense('cc0').allowed === true);
  check('1c "public domain" accepted', evaluateLicense('public domain').allowed === true && evaluateLicense('public domain').kind === 'cc0');

  const by = evaluateLicense('Attribution');
  check('1d CC BY accepted', by.allowed === true && by.kind === 'cc-by' && by.attributionRequired === true, by);
  check('1e "CC BY 4.0" accepted', evaluateLicense('CC BY 4.0').allowed === true && evaluateLicense('CC BY 4.0').attributionRequired === true);

  check('1f NC rejected', evaluateLicense('Attribution Noncommercial').allowed === false && evaluateLicense('Attribution Noncommercial').kind === 'cc-by-nc');
  check('1g NC is checked BEFORE the permissive branch', evaluateLicense('CC BY-NC').allowed === false);
  // ---- Defect 2 FIXED: ND detection no longer fails open on separator variants ----
  // The classifier now normalises separators before matching, so every spelling of ND is rejected.
  const ND_REJECTED = [
    'Attribution Nonderivatives', 'Attribution NoDerivatives', 'Attribution No Derivatives',
    'Attribution no-derivatives', 'Attribution No_Derivatives', 'Attribution NO-DERIVATIVES',
    'attribution nonderivatives', 'NoDerivatives', 'Nonderivatives', 'no-derivatives',
    'CC BY-ND', 'CC BY-ND 4.0', 'CC-BY-ND', 'Attribution-ND', 'ND',
  ];
  for (const lic of ND_REJECTED) {
    const e = evaluateLicense(lic);
    check(`1h ND rejected: "${lic}"`, e.allowed === false && e.kind === 'cc-by-nd', { lic, allowed: e.allowed, kind: e.kind });
  }
  check('1i2 NC+ND rejected', evaluateLicense('CC BY-NC-ND').allowed === false);
  check('1i2b NC variants still rejected (separator spellings)', (() => {
    const bad = ['Attribution Noncommercial', 'Non-Commercial', 'no-commercial', 'CC BY-NC', 'CC BY-NC 4.0', 'NC', 'noncommercial'];
    return bad.every((l) => evaluateLicense(l).allowed === false);
  })(), ['Attribution Noncommercial','Non-Commercial','no-commercial','CC BY-NC','CC BY-NC 4.0','NC','noncommercial'].map((l) => [l, evaluateLicense(l).allowed, evaluateLicense(l).kind]));
  // Guard against over-rejection: legitimate CC BY must still be accepted, including strings that
  // merely contain the word "attribution", and CC0 must be unaffected.
  check('1i2c legitimate CC BY still accepted (no over-rejection)',
    evaluateLicense('Attribution').allowed === true && evaluateLicense('CC BY').allowed === true
    && evaluateLicense('CC BY 4.0').allowed === true && evaluateLicense('Attribution 4.0').allowed === true,
    ['Attribution','CC BY','CC BY 4.0','Attribution 4.0'].map((l) => [l, evaluateLicense(l).allowed, evaluateLicense(l).kind]));
  check('1i2d CC0 still accepted alongside the hardened ND/NC patterns',
    evaluateLicense('Creative Commons 0').allowed === true && evaluateLicense('CC0').allowed === true && evaluateLicense('public domain').allowed === true);

  check('1j unknown licence rejected', evaluateLicense('All Rights Reserved').allowed === false && evaluateLicense('All Rights Reserved').kind === 'unknown');
  check('1k empty licence rejected', evaluateLicense('').allowed === false && evaluateLicense('   ').kind === 'unknown');
  check('1l nothing is assumed copyright-free', /never assume|cannot assume/i.test(evaluateLicense('').reason), evaluateLicense('').reason);
}

// ================== 2. pickTrack ==================
{
  const cc0 = result({ id: 1, name: 'Calm Pad', license: FREESOUND_LICENSE_CC0 });
  const by = result({ id: 2, name: 'Calm Pad', license: FREESOUND_LICENSE_BY });
  check('2a CC0 preferred over CC BY regardless of input order', pickTrack([by, cc0])?.id === 1, pickTrack([by, cc0]));
  check('2b CC0 also preferred when listed first', pickTrack([cc0, by])?.id === 1);

  const nc = result({ id: 3, license: 'Attribution Noncommercial' });
  const nd = result({ id: 4, license: 'Attribution NoDerivatives' });
  const unknown = result({ id: 5, license: 'Weird Custom License' });
  check('2c NC/ND/unknown candidates are skipped entirely', pickTrack([nc, nd, unknown]) === null, pickTrack([nc, nd, unknown]));
  check('2d eligible track still chosen past rejected ones', pickTrack([nc, cc0, nd])?.id === 1);
  // Defect 2 FIXED: an ND track spelled without a separator is now filtered out by pickTrack too.
  check('2d2 ND is rejected by pickTrack for every separator spelling',
    pickTrack([result({ id: 14, license: 'Attribution Nonderivatives' })]) === null
    && pickTrack([result({ id: 15, license: 'Attribution NoDerivatives' })]) === null
    && pickTrack([result({ id: 16, license: 'CC BY-ND' })]) === null);
  check('2d3 CC BY written as "Attribution" is still selectable (policy not narrowed)',
    pickTrack([result({ id: 17, license: 'Attribution' })])?.id === 17);

  // Vocal-title penalty: an eligible CC0 vocal track must lose to an eligible CC0 non-vocal track.
  const vocal = result({ id: 6, name: 'Horror Vocal Song Lyrics', license: FREESOUND_LICENSE_CC0 });
  const instrumental = result({ id: 7, name: 'Instrumental Wind Pad', license: FREESOUND_LICENSE_CC0 });
  check('2e vocal-title penalty prefers the instrumental track', pickTrack([vocal, instrumental])?.id === 7, pickTrack([vocal, instrumental]));
  check('2f vocal penalty does not override the CC0-over-CC-BY rule',
    pickTrack([result({ id: 8, name: 'Choir Song Vocal', license: FREESOUND_LICENSE_CC0 }), by])?.id === 8);

  check('2g empty result set returns null', pickTrack([]) === null);
  check('2h null/undefined input returns null', pickTrack(undefined as any) === null);
  check('2i candidate without any preview URL is skipped', pickTrack([result({ id: 9, previews: undefined })]) === null);
  check('2j lq preview is used when hq is absent',
    pickTrack([result({ id: 10, previews: { 'preview-lq-mp3': 'https://freesound.org/preview/lq/10.mp3' } })])?.id === 10);
  check('2k hq preview is preferred over lq',
    pickTrack([result({ id: 11 })])?.previewUrl.includes('preview/hq') === true);
  check('2l selected track preserves source id/author/licence/duration',
    (() => { const t = pickTrack([result({ id: 12, username: 'ghost_folk', duration: 245 })]); return t?.id === 12 && t?.author === 'ghost_folk' && t?.durationSeconds === 245 && t?.license === FREESOUND_LICENSE_CC0; })());
}

// ================== 3. metadataFor / provenance ==================
{
  const track = pickTrack([result({ id: 4242, name: 'Pyre Ambience', username: 'dread_wraith', duration: 300, license: FREESOUND_LICENSE_CC0 })])!;
  const m = metadataFor(track, 'test query');
  for (const k of ['freesound_id','title','author','source_url','license','license_kind','attribution_required','attribution_text','downloaded_at','query','duration_seconds','note']) {
    check(`3.${k} present in metadata`, k in m, m);
  }
  check('3.1 freesound_id preserved', m.freesound_id === 4242);
  check('3.2 title preserved', m.title === 'Pyre Ambience');
  check('3.3 author preserved', m.author === 'dread_wraith');
  check('3.4 source_url preserved', m.source_url === track.sourceUrl && m.source_url.startsWith('https://freesound.org/'));
  check('3.5 license + kind preserved', m.license === FREESOUND_LICENSE_CC0 && m.license_kind === 'cc0');
  check('3.6 attribution_required false for CC0', m.attribution_required === false);
  check('3.7 attribution_text is null for CC0', m.attribution_text === null, m.attribution_text);
  check('3.8 query recorded', m.query === 'test query');
  check('3.9 duration recorded', m.duration_seconds === 300);
  check('3.10 licence was verified, never assumed', /verified/i.test(m.note) && /never assumed/i.test(m.note), m.note);
  check('3.11 downloaded_at is an ISO timestamp', !Number.isNaN(Date.parse(m.downloaded_at)));

  const byTrack = pickTrack([result({ id: 55, name: 'Attributed Drone', username: 'cc_by_author', license: FREESOUND_LICENSE_BY })])!;
  const bm = metadataFor(byTrack, 'q');
  check('3.12 CC BY marks attribution_required', bm.attribution_required === true && bm.license_kind === 'cc-by');
  check('3.13 CC BY attribution_text embeds title, author, source URL and licence',
    /Attributed Drone/.test(bm.attribution_text!) && /cc_by_author/.test(bm.attribution_text!) && bm.attribution_text!.includes(bm.source_url) && /Creative Commons 0|Attribution/.test(bm.attribution_text!), bm.attribution_text);
}

// ================== 4. credential gating + injectable fetcher ==================
{
  const saved: Record<string, string | undefined> = {};
  for (const n of FREESOUND_CREDENTIALS) { saved[n] = process.env[n]; delete process.env[n]; }
  check('4.1 all three Freesound credentials are required', FREESOUND_CREDENTIALS.length === 3);
  check('4.2 missingCredentials() lists every unset credential', missingCredentials().length === 3, missingCredentials());

  // resolveBgmSource with an injected fetcher must NOT need credentials and must NOT hit the network.
  const fetched: any[] = [];
  const dir = path.join(tmp, 'injected');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'background-music.mp3');
  const resolved = await resolveBgmSource({
    bgm: undefined, autoBgm: true, inputDir: dir, query: 'injected',
    fetcher: async (o) => { fetched.push(o); fs.writeFileSync(o.output, 'stub'); return { output: o.output }; },
  });
  check('4.3 injected fetcher is used and needs no credentials', fetched.length === 1 && resolved === out, { resolved, fetched: fetched.length });
  check('4.4 resolveBgmSource targets <inputDir>/background-music.mp3', fetched[0]?.output === out, fetched[0]?.output);

  let threw: string | null = null;
  try { await resolveBgmSource({ bgm: 'x.mp3', autoBgm: true, inputDir: dir }); } catch (e: any) { threw = String(e?.message ?? e); }
  check('4.5 --bgm and --auto-bgm are mutually exclusive', /mutually exclusive/.test(threw ?? ''), threw);

  check('4.6 non-auto-bgm passes an explicit --bgm straight through',
    await resolveBgmSource({ bgm: 'manual.mp3', autoBgm: false, inputDir: dir }) === path.resolve('manual.mp3'));
  check('4.7 no bgm and no auto-bgm returns undefined',
    await resolveBgmSource({ bgm: undefined, autoBgm: false, inputDir: dir }) === undefined);

  for (const n of FREESOUND_CREDENTIALS) { if (saved[n] !== undefined) process.env[n] = saved[n]; }
  check('4.8 credentials restored to their original unset state', missingCredentials().length === 3);
}

// ================== 5. real acquisition against a STUBBED fetch (temp dir only) ==================
// Exercises the genuine fetchAutoBgm code path — filename/sidecar creation, mkdir, provenance —
// while every HTTP call is served locally.
async function acquire(name: string, searchResults: any[], query = DEFAULT_BGM_QUERY) {
  const inputRoot = path.join(tmp, name);
  const musicDir = path.join(inputRoot, 'music');
  const calls = stubFetch({ results: searchResults });
  try {
    const { fetchAutoBgm } = bgm;
    const out = await fetchAutoBgm({ output: path.join(musicDir, 'background-music.mp3'), query });
    return { inputRoot, musicDir, out, calls };
  } finally { globalThis.fetch = realFetch; }
}

const saved2: Record<string, string | undefined> = {};
for (const n of FREESOUND_CREDENTIALS) { saved2[n] = process.env[n]; process.env[n] = `stub-${n}`; }

const CC0 = await acquire('cc0-project', [result({ id: 1000, name: 'Pyre Ambience', username: 'dread_wraith', license: FREESOUND_LICENSE_CC0 })]);

check('5.1 background-music.mp3 written to <inputRoot>/music/', fs.existsSync(path.join(CC0.musicDir, 'background-music.mp3')));
check('5.2 background-music.json written (metadata sidecar)', fs.existsSync(path.join(CC0.musicDir, 'background-music.json')));
// ---- Defect 1 FIXED: the licence sidecar now carries the canonical name the validator reads ----
check('5.3a canonical licence sidecar background-music.license.json IS written',
    fs.existsSync(path.join(CC0.musicDir, 'background-music.license.json')));
check('5.3b reported licenseRecordPath is exactly <music-dir>/background-music.license.json',
    CC0.out.licenseRecordPath === path.join(CC0.musicDir, 'background-music.license.json'), CC0.out.licenseRecordPath);
check('5.3c the incorrect background-music.mp3.license.json is NOT produced',
    !fs.existsSync(path.join(CC0.musicDir, 'background-music.mp3.license.json')));
check('5.3d no duplicate/stray sidecars were left in the music dir',
    fs.readdirSync(CC0.musicDir).sort().join(',') === 'background-music.json,background-music.license.json,background-music.mp3',
    fs.readdirSync(CC0.musicDir));
check('5.4 the music directory was created by the fetcher', fs.statSync(CC0.musicDir).isDirectory());
check('5.5 metadata path strips the extension and adds .json', CC0.out.metadataPath === path.join(CC0.musicDir, 'background-music.json'), CC0.out.metadataPath);
check('5.7 the two sidecars carry identical provenance JSON',
    fs.readFileSync(CC0.out.metadataPath, 'utf8') === fs.readFileSync(CC0.out.licenseRecordPath, 'utf8'));
check('5.8 sidecar carries the real track id/author/licence',
    (() => { const j = JSON.parse(fs.readFileSync(CC0.out.licenseRecordPath, 'utf8')); return j.freesound_id === 1000 && j.author === 'dread_wraith' && j.license === FREESOUND_LICENSE_CC0; })());
check('5.9 audio bytes were actually downloaded (not fabricated)', fs.statSync(path.join(CC0.musicDir, 'background-music.mp3')).size > 0);

// ================== 6. CC0 sidecar satisfies validateMusicInputs DIRECTLY ==================
// No renaming/copying: the sidecar exactly as acquisition produced it must be accepted as-is.
{
  const res = await validateMusicInputs(musicOpts(CC0.inputRoot) as any);
  check('6.0 a REAL CC0 acquisition now validates WITHOUT any renaming', res.length === 1 && res[0].state === 'VALID', res[0]);
  check('6.1 CC0 acquisition yields exactly one music entry', res.length === 1, res);
  check('6.2 validator state is VALID', res[0].state === 'VALID', res[0]);
  check('6.3 validator reports kind cc0, no attribution required', res[0].license?.kind === 'cc0' && res[0].license?.attributionRequired === false, res[0].license);
  check('6.4 validator reports the file SHA', /^[0-9a-f]{64}$/.test(String(res[0].sha256)), res[0].sha256);
  check('6.5 relative path is music/background-music.mp3', res[0].relativePath === 'music/background-music.mp3', res[0].relativePath);
  check('6.6 CC0 sidecar needs no attribution field', !('attribution' in JSON.parse(fs.readFileSync(path.join(CC0.musicDir, 'background-music.license.json'), 'utf8'))));
}

// ================== 7. CC BY MISMATCH — documented, intentionally NOT fixed ==================
// metadataFor() writes `attribution_text`; validateMusicInputs() reads `meta.attribution`.
// This test PINS the mismatch. Do not "fix" the test without an explicit, approved code change.
{
  const byResults = [result({ id: 2000, name: 'Attributed Drone', username: 'cc_by_author', license: FREESOUND_LICENSE_BY })];
  const calls = stubFetch({ results: byResults });
  const BY = await (async () => {
    const inputRoot = path.join(tmp, 'ccby-project');
    const musicDir = path.join(inputRoot, 'music');
    try { return { inputRoot, musicDir, out: await bgm.fetchAutoBgm({ output: path.join(musicDir, 'background-music.mp3'), query: 'cc by' }) }; }
    finally { globalThis.fetch = realFetch; }
  })();

  const sidecar = JSON.parse(fs.readFileSync(BY.out.licenseRecordPath, 'utf8'));
  check('7.1 CC BY acquisition completes and writes all three files under their canonical names',
      fs.existsSync(path.join(BY.musicDir, 'background-music.mp3'))
      && fs.existsSync(path.join(BY.musicDir, 'background-music.json'))
      && fs.existsSync(path.join(BY.musicDir, 'background-music.license.json')));
  check('7.1b CC BY acquisition also does not write the incorrect .mp3.license.json',
      !fs.existsSync(path.join(BY.musicDir, 'background-music.mp3.license.json')));
  check('7.2 CC BY sidecar records attribution_required = true', sidecar.attribution_required === true);
  check('7.3 CC BY sidecar records attribution_text (CURRENT behaviour)', typeof sidecar.attribution_text === 'string' && sidecar.attribution_text.length > 0, sidecar.attribution_text);
  check('7.4 CC BY sidecar has NO top-level `attribution` field (the mismatch)', !('attribution' in sidecar), Object.keys(sidecar));

  // The filename defect is fixed, so this rejection is now caused ONLY by the attribution-field
  // mismatch — a clean, unmasked reproduction of the remaining defect.
  const named = await validateMusicInputs(musicOpts(BY.inputRoot) as any);
  check('7.5 validator REJECTS the CC BY acquisition (LICENSE_INVALID)', named[0].state === 'LICENSE_INVALID', named[0]);
  check('7.6 the canonical sidecar IS now read (rejection is no longer a filename problem)',
      !/licence provenance/i.test(String(named[0].reason)), named[0].reason);
  check('7.7 rejection reason specifically cites the missing CC BY attribution metadata',
      /attribution/i.test(String(named[0].reason)), named[0].reason);
  check('7.8 evaluateLicense itself ACCEPTS this licence (policy is fine; only the field name is wrong)',
      evaluateLicense(FREESOUND_LICENSE_BY).allowed === true);
  check('7.9 KNOWN MISMATCH (INTENTIONALLY UNFIXED): acquisition emits attribution_text, validator reads attribution',
      sidecar.attribution_required === true && !('attribution' in sidecar) && named[0].state === 'LICENSE_INVALID');
  check('7.10 the CC BY sidecar IS readable JSON whose licence the policy allows (isolating the defect to field naming)',
      typeof sidecar.license === 'string' && evaluateLicense(sidecar.license).allowed === true, sidecar.license);
  // Prove the mismatch is the SOLE cause: supplying the attribution key the validator wants passes.
  const withAttribution = path.join(tmp, 'ccby-with-attribution');
  const withAttributionMusic = path.join(withAttribution, 'music');
  fs.mkdirSync(withAttributionMusic, { recursive: true });
  fs.copyFileSync(path.join(BY.musicDir, 'background-music.mp3'), path.join(withAttributionMusic, 'background-music.mp3'));
  fs.writeFileSync(path.join(withAttributionMusic, 'background-music.license.json'),
      JSON.stringify({ ...sidecar, attribution: sidecar.attribution_text }, null, 2));
  const fixedShape = await validateMusicInputs(musicOpts(withAttribution) as any);
  check('7.11 CC BY would validate if the sidecar carried `attribution` (confirms field-name mismatch is the only blocker)',
      fixedShape[0].state === 'VALID' && fixedShape[0].license?.kind === 'cc-by', fixedShape[0]);
}

for (const n of FREESOUND_CREDENTIALS) { if (saved2[n] === undefined) delete process.env[n]; else process.env[n] = saved2[n]; }

// ================== 8. no real network, no production paths touched ==================
{
  check('8.1 global fetch restored to the original implementation', globalThis.fetch === realFetch);
  check('8.2 active project music directory untouched (path+type+size+sha256 snapshot identical)', treeSnapshot(PROJECT_MUSIC) === PROJECT_MUSIC_BEFORE,
    { before: PROJECT_MUSIC_BEFORE, after: treeSnapshot(PROJECT_MUSIC) });
  check('8.3 every write stayed inside the temp dir', CC0.musicDir.startsWith(tmp) && tmp.startsWith(os.tmpdir()));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} focused BGM checks passed (fully offline; no Freesound request issued).`);