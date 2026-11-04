/**
 * Copyright-safe background music for the post-production pipeline.
 *
 * Searches Freesound, validates the *actual* license of every candidate, prefers
 * CC0, and only falls back to CC BY when the attribution is recorded and exposed.
 * NC, ND, and unknown licenses are always rejected. Nothing is ever assumed to be
 * copyright-free just because it came from Freesound.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const dotenvFile = path.resolve(moduleDirectory, '../../scripting/.env');

export const FREESOUND_CREDENTIALS = ['FREESOUND_CLIENT_ID', 'FREESOUND_CLIENT_SECRET', 'FREESOUND_REFRESH_TOKEN'] as const;
export const FREESOUND_LICENSE_CC0 = 'Creative Commons 0';
export const FREESOUND_LICENSE_BY = 'Attribution';
export const DEFAULT_BGM_QUERY = 'dark eerie Indian folk horror suspense atmospheric ambient instrumental no vocals';

export type LicenseKind = 'cc0' | 'cc-by' | 'cc-by-nc' | 'cc-by-nd' | 'cc-by-nc-nd' | 'unknown';

export interface LicenseEvaluation {
  raw: string;
  kind: LicenseKind;
  allowed: boolean;
  attributionRequired: boolean;
  reason: string;
}

export interface BgmTrack {
  id: number;
  title: string;
  author: string;
  license: string;
  licenseKind: LicenseKind;
  attributionRequired: boolean;
  durationSeconds: number;
  sourceUrl: string;
  previewUrl: string;
}

export interface BgmMetadata {
  freesound_id: number;
  title: string;
  author: string;
  source_url: string;
  license: string;
  license_kind: LicenseKind;
  attribution_required: boolean;
  attribution_text: string | null;
  downloaded_at: string;
  query: string;
  duration_seconds: number;
  note: string;
}

export interface FreesoundResult {
  id: number;
  name: string;
  username: string;
  license: string;
  duration: number;
  url: string;
  previews?: Record<string, string>;
}

export interface SearchOptions {
  query: string;
  license: string;
  minDuration?: number;
  maxDuration?: number;
  pageSize?: number;
}

export interface AutoBgmOptions {
  output: string;
  query?: string;
  authorizationCode?: string;
  minDuration?: number;
  maxDuration?: number;
}

export interface AutoBgmResult {
  output: string;
  metadata: BgmMetadata;
  metadataPath: string;
  licenseRecordPath: string;
}

export interface ResolveBgmInput {
  bgm?: string;
  autoBgm: boolean;
  inputDir: string;
  query?: string;
  fetcher?: (options: AutoBgmOptions) => Promise<{ output: string }>;
}

/**
 * Classify a Freesound license string. Order matters: NC and ND are rejected
 * before the permissive branches so "Attribution Noncommercial" etc. never pass.
 */
export function evaluateLicense(raw: string): LicenseEvaluation {
  const license = String(raw ?? '').trim();
  const value = license.toLowerCase();
  const reject = (kind: LicenseKind, reason: string): LicenseEvaluation => ({ raw: license, kind, allowed: false, attributionRequired: false, reason });

  if (!value) return reject('unknown', 'Missing license: rejected (cannot assume copyright-free).');
  // Normalise separator/case variants BEFORE classification so "NoDerivatives", "Nonderivatives",
  // "no-derivatives" and "ND" cannot disagree about the same licence. The accepted set is unchanged:
  // this only makes the existing NC/ND rejection apply to every spelling of the same terms.
  const canonical = value.replace(/[\s_\-–—]+/g, '');
  // NC: tested against BOTH forms — `canonical` catches separator variants ("Non-Commercial"),
  // and \bnc\b on the raw value keeps the existing standalone "NC" token working.
  if (/noncommercial/.test(canonical) || /\bnc\b/.test(value)) {
    return reject('cc-by-nc', 'NonCommercial (NC) licenses are never allowed.');
  }
  // ND must be caught for every spelling: the previous /no[\s-]?derivatives/ pattern required a
  // separator, so "Nonderivatives" fell through to the permissive attribution branch and was
  // allowed as CC BY. `nond?derivatives` matches "noderivatives" and "nonderivatives" alike, and
  // \bnd\b is still read from the raw value so hyphenated "CC BY-ND" keeps matching.
  if (/non?derivatives/.test(canonical) || /\bnd\b/.test(value)) {
    return reject('cc-by-nd', 'NoDerivatives (ND) rejected: the pipeline loops, normalizes and mixes the track, which is a modification.');
  }
  if (/creative commons 0|cc0|public[\s-]?domain/.test(value)) {
    return { raw: license, kind: 'cc0', allowed: true, attributionRequired: false, reason: 'CC0 / public domain: allowed, no attribution required.' };
  }
  if (/attribution|\bcc[\s-]?by\b/.test(value)) {
    return { raw: license, kind: 'cc-by', allowed: true, attributionRequired: true, reason: 'CC BY: allowed only because the pipeline records and exposes attribution.' };
  }
  return reject('unknown', `Unknown/unrecognized license "${license}": rejected (cannot assume copyright-free).`);
}

/** Choose the best allowed track: prefer CC0, then avoid obvious vocal tracks. */
export function pickTrack(results: FreesoundResult[]): BgmTrack | null {
  const candidates: BgmTrack[] = [];
  for (const result of results ?? []) {
    if (!result || typeof result.id !== 'number') continue;
    const previewUrl = result.previews?.['preview-hq-mp3'] ?? result.previews?.['preview-lq-mp3'];
    if (!previewUrl) continue;
    const evaluation = evaluateLicense(result.license);
    if (!evaluation.allowed) continue;
    candidates.push({
      id: result.id,
      title: result.name,
      author: result.username,
      license: result.license,
      licenseKind: evaluation.kind,
      attributionRequired: evaluation.attributionRequired,
      durationSeconds: Number(result.duration) || 0,
      sourceUrl: result.url,
      previewUrl,
    });
  }
  if (!candidates.length) return null;
  const vocalPenalty = (track: BgmTrack) => (/vocal|voice|song|singer|lyric|choir/i.test(track.title) ? 1 : 0);
  candidates.sort((a, b) =>
    (a.licenseKind === 'cc0' ? 0 : 1) - (b.licenseKind === 'cc0' ? 0 : 1) || vocalPenalty(a) - vocalPenalty(b));
  return candidates[0];
}

/** Load scripting/.env values without printing any secrets. */
export async function loadLocalEnvironment(): Promise<void> {
  try {
    const contents = await fs.readFile(dotenvFile, 'utf8');
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator < 1) continue;
      const name = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
      if (name && value && !process.env[name]) process.env[name] = value;
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function missingCredentials(): string[] {
  return FREESOUND_CREDENTIALS.filter((name) => !process.env[name]);
}

export function requiredCredential(name: string): string {
  const value = process.env[name];
  if (value) return value;
  const missing = missingCredentials();
  throw new Error(
    `Freesound credentials missing: ${missing.join(', ')}. ` +
    `Set ${FREESOUND_CREDENTIALS.join(', ')} in scripting/.env (or the environment). ` +
    'Automatic BGM stopped cleanly; no fallback music source is used.'
  );
}

async function refreshAccessToken(): Promise<string> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: requiredCredential('FREESOUND_CLIENT_ID'),
    client_secret: requiredCredential('FREESOUND_CLIENT_SECRET'),
    refresh_token: requiredCredential('FREESOUND_REFRESH_TOKEN'),
  });
  const response = await fetch('https://freesound.org/apiv2/oauth2/access_token/', { method: 'POST', body: form });
  if (!response.ok) throw new Error(`Freesound token refresh failed (${response.status}).`);
  const data = await response.json() as { access_token?: string };
  if (!data.access_token) throw new Error('Freesound did not return an access token.');
  return data.access_token;
}

async function exchangeAuthorizationCode(code: string): Promise<string> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: requiredCredential('FREESOUND_CLIENT_ID'),
    client_secret: requiredCredential('FREESOUND_CLIENT_SECRET'),
    code,
    redirect_uri: 'https://freesound.org/home/app_permissions/permission_granted/',
  });
  const response = await fetch('https://freesound.org/apiv2/oauth2/access_token/', { method: 'POST', body: form });
  if (!response.ok) throw new Error(`Freesound authorization-code exchange failed (${response.status}).`);
  const data = await response.json() as { access_token?: string; refresh_token?: string };
  if (!data.access_token || !data.refresh_token) throw new Error('Freesound did not return an access and refresh token pair.');
  const contents = await fs.readFile(dotenvFile, 'utf8');
  const replacement = `FREESOUND_REFRESH_TOKEN=${data.refresh_token}`;
  const updated = /^FREESOUND_REFRESH_TOKEN=.*$/m.test(contents)
    ? contents.replace(/^FREESOUND_REFRESH_TOKEN=.*$/m, replacement)
    : `${contents.trimEnd()}\n${replacement}\n`;
  await fs.writeFile(dotenvFile, updated, 'utf8');
  process.env.FREESOUND_REFRESH_TOKEN = data.refresh_token;
  return data.access_token;
}

export async function getAccessToken(authorizationCode?: string): Promise<string> {
  return authorizationCode ? exchangeAuthorizationCode(authorizationCode) : refreshAccessToken();
}

export async function searchFreesound(token: string, options: SearchOptions): Promise<FreesoundResult[]> {
  const search = new URL('https://freesound.org/apiv2/search/text/');
  search.searchParams.set('query', options.query);
  search.searchParams.set('filter', `license:"${options.license}" duration:[${options.minDuration ?? 30} TO ${options.maxDuration ?? 600}]`);
  search.searchParams.set('sort', 'rating_desc');
  search.searchParams.set('page_size', String(options.pageSize ?? 30));
  search.searchParams.set('fields', 'id,name,license,username,previews,duration,url');
  const response = await fetch(search, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Freesound search failed (${response.status}).`);
  const data = await response.json() as { results?: FreesoundResult[] };
  return data.results ?? [];
}

export function metadataFor(track: BgmTrack, query: string): BgmMetadata {
  const attributionText = track.attributionRequired
    ? `"${track.title}" by ${track.author} (${track.sourceUrl}), licensed ${track.license}.`
    : null;
  return {
    freesound_id: track.id,
    title: track.title,
    author: track.author,
    source_url: track.sourceUrl,
    license: track.license,
    license_kind: track.licenseKind,
    attribution_required: track.attributionRequired,
    attribution_text: attributionText,
    downloaded_at: new Date().toISOString(),
    query,
    duration_seconds: track.durationSeconds,
    note: 'Downloaded from Freesound; license verified from the search result, never assumed copyright-free.',
  };
}

/** Search, validate, download, and record metadata for one copyright-safe track. */
export async function fetchAutoBgm(options: AutoBgmOptions): Promise<AutoBgmResult> {
  await loadLocalEnvironment();
  const missing = missingCredentials();
  if (missing.length) {
    throw new Error(
      `Freesound credentials missing: ${missing.join(', ')}. ` +
      `Set ${FREESOUND_CREDENTIALS.join(', ')} in scripting/.env (or the environment). ` +
      'Automatic BGM stopped cleanly; no fallback music source is used.'
    );
  }
  const query = (options.query ?? DEFAULT_BGM_QUERY).trim() || DEFAULT_BGM_QUERY;
  const token = await getAccessToken(options.authorizationCode);
  let track: BgmTrack | null = null;
  // Prefer CC0; only if none is found, allow CC BY (attribution is recorded below).
  for (const license of [FREESOUND_LICENSE_CC0, FREESOUND_LICENSE_BY]) {
    const results = await searchFreesound(token, { query, license, minDuration: options.minDuration, maxDuration: options.maxDuration });
    track = pickTrack(results);
    if (track) break;
  }
  if (!track) {
    throw new Error(`No suitable copyright-safe Freesound track found for query "${query}". Tried CC0 then CC BY; NC/ND/unknown licenses are rejected.`);
  }
  const output = path.resolve(options.output);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const audio = await fetch(track.previewUrl);
  if (!audio.ok || !audio.body) throw new Error(`Freesound preview download failed (${audio.status}).`);
  await fs.writeFile(output, Buffer.from(await audio.arrayBuffer()));
  const metadata = metadataFor(track, query);
  const stem = output.replace(/\.(mp3|wav|m4a|aac|ogg)$/i, '');
  const metadataPath = `${stem}.json`;
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  // The licence sidecar MUST be named "<stem>.license.json" — exactly what validateMusicInputs()
  // reads ("music/background-music.license.json"). Appending to the full output path produced
  // "background-music.mp3.license.json", which the validator never sees, so a genuine CC0
  // acquisition was rejected as LICENSE_INVALID. Strip the audio extension, as metadataPath does.
  const licenseRecordPath = `${stem}.license.json`;
  await fs.writeFile(licenseRecordPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  if (metadata.attribution_required && metadata.attribution_text) {
    console.warn(`[bgm] Attribution required for this track: ${metadata.attribution_text}`);
  }
  return { output, metadata, metadataPath, licenseRecordPath };
}

/**
 * Resolve the background-music path for the mixer.
 * Manual --bgm keeps its exact previous behavior. --auto-bgm obtains the music
 * into <inputDir>/background-music.mp3. Passing both is an error.
 */
export async function resolveBgmSource(input: ResolveBgmInput): Promise<string | undefined> {
  if (input.bgm && input.autoBgm) throw new Error('--bgm and --auto-bgm are mutually exclusive; pass exactly one.');
  if (!input.autoBgm) return input.bgm ? path.resolve(input.bgm) : undefined;
  const output = path.join(path.resolve(input.inputDir), 'background-music.mp3');
  const fetcher = input.fetcher ?? fetchAutoBgm;
  const result = await fetcher({ output, query: input.query });
  return result.output;
}
