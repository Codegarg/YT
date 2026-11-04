/**
 * Shared synthetic fixtures for tests that used to borrow media and "canonical project"
 * files from `production/inputs/raat-ka-khauf-3am-kuan`.
 *
 * That legacy project's `inputs/` and `outputs/` directories no longer exist on disk (only
 * `scripting/projects/raat-ka-khauf-3am-kuan/pipeline.json` survives), so those tests
 * failed with ENOENT before reaching a single assertion.
 *
 * Two substitutions happen here:
 *
 *  1. MEDIA IS SYNTHESISED. Backgrounds are generated PNGs (1920x1080 RGB, which is what
 *     `inputValidator` requires: a readable PNG header, above the minimum resolution, and
 *     16:9-compatible). Scene clips are generated with ffmpeg lavfi, matching the idiom the
 *     already-passing tests in this directory use. Nothing is copied out of the repository.
 *
 *  2. "CANONICAL PROJECT UNTOUCHED" GUARDS POINT AT AN ISOLATED TREE. `buildIsolatedCanonical()`
 *     materialises a populated canonical-shaped project tree OUTSIDE the projects / inputs /
 *     outputs roots that are handed to the code under test. A guard that hashes a directory
 *     that does not exist is vacuous; a guard that hashes a real tree it does not own still
 *     catches any write outside the scoped roots, so the substitution is stricter than the
 *     original, not weaker.
 *
 * Every path produced here lives under the caller's temp directory. Nothing in this module
 * reads or writes the repository's `production/` tree.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Project id of the legacy project whose on-disk inputs/outputs are gone. */
export const LEGACY_PROJECT_ID = 'raat-ka-khauf-3am-kuan';

/** Background tags used by the 14-scene fixtures. */
export const FIXTURE_BG_TAGS = [
  '#BGD-01-VILLAGE-STREET-WIDE',
  '#BGD-02-WELL-AREA-WIDE',
  '#BGD-03-WELL-AREA-CLOSE',
  '#BGD-04-VILLAGE-ELDERS-HOUSE-INTERIOR',
  '#BGD-05-VILLAGE-STREET-CLOSE',
];

/** Background filenames that correspond 1:1 with {@link FIXTURE_BG_TAGS} (sigil stripped). */
export const FIXTURE_BG_FILES = FIXTURE_BG_TAGS.map((tag) => `${tag.replace(/^#/, '')}.png`);

/** Minimal deterministic PNG writer (ct 6 = RGBA, ct 2 = RGB). */
export function makePng(w: number, h: number, ct = 6, tag = 0): Buffer {
  const T: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    T[n] = c >>> 0;
  }
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (t: string, d: Buffer) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(d.length, 0);
    const body = Buffer.concat([Buffer.from(t, 'ascii'), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body), 0);
    return Buffer.concat([l, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = ct;
  const ch = ct === 6 ? 4 : 2;
  const raw = Buffer.alloc(h * (1 + w * ch), 0x80);
  for (let y = 0; y < h; y++) raw[y * (1 + w * ch)] = 0;
  raw[11] = tag & 0xff;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Write the five synthetic backgrounds into `<inputRoot>/backgrounds`. */
export function writeFixtureBackgrounds(inputRoot: string): string[] {
  const dir = path.join(inputRoot, 'backgrounds');
  fs.mkdirSync(dir, { recursive: true });
  FIXTURE_BG_FILES.forEach((file, i) => fs.writeFileSync(path.join(dir, file), makePng(1920, 1080, 2, i + 1)));
  return FIXTURE_BG_FILES;
}

/** Write a single synthetic scene clip and return its absolute path. */
export async function writeFixtureSceneClip(dir: string, sceneNumber: number, ffmpegPath = process.env.FFMPEG_PATH!, seconds = 2): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `scene-${String(sceneNumber).padStart(4, '0')}.mp4`);
  const color = `0x${(0x203040 + sceneNumber * 0x010203).toString(16).padStart(6, '0')}`;
  // The colour source MUST be `seconds` long: `-shortest` ends the output at the shortest input,
  // so a shorter source (the old `d=1`) silently produced a 1s clip no matter what `-t` asked for.
  // That mattered once MIX began refusing over-limit narration: a 3s narration over a 1s clip is a
  // 3.25x slowdown, which is outside the 2.0x policy, so these fixtures were only ever within it by
  // accident. Honouring `seconds` keeps them legitimately within it.
  await exec(ffmpegPath, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=1280x720:d=${seconds}`, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
  return file;
}

/**
 * Encode a bank of `count` synthetic scene clips ONCE into `dir`.
 *
 * Callers that build more than one fixture from the same shape must install the same bank
 * into each of them rather than re-encoding per fixture: an MP4 written by ffmpeg carries a
 * creation timestamp, so two independent encodes of identical parameters are NOT byte-identical.
 * Tests that assert "both projects render the same bytes" depend on copying one bank, not on
 * ffmpeg being deterministic.
 */
export async function createFixtureClipBank(dir: string, count: number, ffmpegPath = process.env.FFMPEG_PATH!): Promise<string[]> {
  const bank: string[] = [];
  for (let n = 1; n <= count; n++) bank.push(await writeFixtureSceneClip(dir, n, ffmpegPath));
  return bank;
}

/** Copy an existing clip bank into `<inputRoot>/flow-clips`, preserving byte identity. */
export function installFixtureClips(inputRoot: string, bank: readonly string[]): void {
  const dir = path.join(inputRoot, 'flow-clips');
  fs.mkdirSync(dir, { recursive: true });
  for (const src of bank) fs.copyFileSync(src, path.join(dir, path.basename(src)));
}

/** SHA-256 of a file's bytes. */
export function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Order-independent fingerprint of a directory tree.
 *
 * Pass `includeMtime: true` for the stricter variant some suites use (a touched-but-rewritten
 * file is caught even if its bytes happen to round-trip). Missing roots hash to `''`.
 */
export function treeHash(root: string, opts: { includeMtime?: boolean } = {}): string {
  if (!fs.existsSync(root)) return '';
  const entries: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else entries.push(`${f}:${sha256File(f)}${opts.includeMtime ? `:${fs.statSync(f).mtimeMs}` : ''}`);
    }
  };
  walk(root);
  return entries.sort().join('|');
}

export interface IsolatedCanonical {
  root: string;
  scriptingRoot: string;
  inputsRoot: string;
  outputsRoot: string;
  projectDir: string;
  inputRoot: string;
  outputsDir: string;
  projectFile: string;
  stateFile: string;
  runLogFile: string;
  approvalFile: string;
}

/**
 * Materialise an isolated stand-in for a canonical production project under `root`.
 *
 * The layout mirrors what a real run leaves behind (`scripting/projects/<id>/pipeline.json`
 * plus `outputs/<id>/{state.json,run.log.jsonl}`) so that hash-the-tree guards stay meaningful.
 * Callers must place `root` OUTSIDE the projects/inputs/outputs roots passed to the code under
 * test — otherwise the guard would be watching the code's own scratch space.
 */
export function buildIsolatedCanonical(root: string, projectId = LEGACY_PROJECT_ID): IsolatedCanonical {
  const scriptingRoot = path.join(root, 'scripting');
  const inputsRoot = path.join(root, 'inputs');
  const outputsRoot = path.join(root, 'outputs');
  const projectDir = path.join(scriptingRoot, 'projects', projectId);
  const inputRoot = path.join(inputsRoot, projectId);
  const outputsDir = path.join(outputsRoot, projectId);
  for (const d of [projectDir, inputRoot, path.join(inputRoot, 'flow-clips'), path.join(inputRoot, 'backgrounds'), outputsDir]) fs.mkdirSync(d, { recursive: true });

  const projectFile = path.join(projectDir, 'pipeline.json');
  fs.writeFileSync(projectFile, `${JSON.stringify({ schema_version: 1, project_id: projectId, flow_project_name: 'ISOLATED CANONICAL', characters: [], backgrounds: [], scenes: [] }, null, 2)}\n`);

  const stateFile = path.join(outputsDir, 'state.json');
  fs.writeFileSync(stateFile, `${JSON.stringify({ project_id: projectId, final: { status: 'NOT_STARTED', path: null }, scenes: {} }, null, 2)}\n`);

  const runLogFile = path.join(outputsDir, 'run.log.jsonl');
  fs.writeFileSync(runLogFile, [`${JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', level: 'info', event: 'isolated_canonical_seed' })}`, `${JSON.stringify({ ts: '2026-01-01T00:00:01.000Z', level: 'info', event: 'isolated_canonical_seed_done' })}`].join('\n') + '\n');

  return { root, scriptingRoot, inputsRoot, outputsRoot, projectDir, inputRoot, outputsDir, projectFile, stateFile, runLogFile, approvalFile: path.join(outputsDir, 'approval.json') };
}

export interface LegacySceneFixture extends IsolatedCanonical {
  pipeline: any;
  /** Scene numbers with a valid local clip (the legacy project shipped 14). */
  readyScenes: number[];
}

/**
 * Reproduce the SHAPE of the historical 35-scene `raat-ka-khauf-3am-kuan` project as a fully
 * synthetic, self-contained fixture.
 *
 * The original layout this stands in for:
 *   · 35 scenes, 5 backgrounds, 4 declared characters;
 *   · scenes 1-14 have a locally available, valid clip and narration  -> READY;
 *   · scenes 15-33 are dialogue scenes committed in Flow with no local clip;
 *   · scenes 34-35 are narrator-only and also have no local clip;
 *   · NO character cutout was ever supplied and NO downstream stage had been run, so the
 *     project is blocked and not publishable.
 *
 * `flow_scene_id` on scenes 15-35 mirrors what a real Flow run leaves in the pipeline and is
 * what makes those scenes RECOVER rather than GENERATE in the health report.
 */
export async function buildLegacySceneFixture(root: string, opts: { projectId?: string; totalScenes?: number; localClipScenes?: number; backgroundTags?: string[]; ffmpegPath?: string } = {}): Promise<LegacySceneFixture> {
  const projectId = opts.projectId ?? LEGACY_PROJECT_ID;
  const total = opts.totalScenes ?? 35;
  const localClips = opts.localClipScenes ?? 14;
  const bgTags = opts.backgroundTags ?? FIXTURE_BG_TAGS;
  const ffmpegPath = opts.ffmpegPath ?? process.env.FFMPEG_PATH!;
  const canon = buildIsolatedCanonical(root, projectId);

  for (const d of [path.join(canon.inputRoot, 'music'), path.join(canon.inputRoot, 'branding'), path.join(canon.inputRoot, 'narration'), path.join(canon.inputRoot, 'characters'), path.join(canon.outputsDir, 'narration')]) fs.mkdirSync(d, { recursive: true });
  writeFixtureBackgroundsFor(canon.inputRoot, bgTags);

  const characters = [
    { tag: '@CHAR-01-ARJUN', name: 'Arjun', look_summary: 'young villager', full_prompt: 'p', voice_description: 'young male' },
    { tag: '@CHAR-02-MOHAN', name: 'Mohan', look_summary: 'v', full_prompt: 'p', voice_description: 'm' },
    { tag: '@CHAR-03-GEETA', name: 'Geeta', look_summary: 'v', full_prompt: 'p', voice_description: 'f' },
    { tag: '@CHAR-04-BUZURG', name: 'Buzurg', look_summary: 'v', full_prompt: 'p', voice_description: 'elderly male' },
  ];

  const scenes: any[] = [];
  for (let n = 1; n <= total; n++) {
    const isLocal = n <= localClips;
    const isNarrator = isLocal || n > 33;
    const characterTags = isNarrator ? [] : [characters[(n - 1) % characters.length].tag];
    scenes.push({
      scene_number: n,
      title: `Scene ${n}`,
      background_tag: bgTags[(n - 1) % bgTags.length],
      character_tags: characterTags,
      speaker: isNarrator ? 'NARRATOR' : characterTags[0],
      camera: 'wide',
      effects: '',
      sound_design: 'ambient night',
      visual_action: `legacy action ${n}`,
      narration_text: isNarrator ? `legacy narration ${n}` : '',
      animation_prompt_NARRATOR_ONLY: `prompt ${n}`,
      animation_prompt_WITH_lipsync: `prompt ${n}`,
      status: 'pending',
      ...(isLocal ? {} : { flow_scene_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` }),
    });
  }

  const pipeline = {
    schema_version: 1,
    project_id: projectId,
    flow_project_name: 'LEGACY 35 SCENE FIXTURE',
    characters,
    backgrounds: bgTags.map((tag) => ({ tag, location_name: tag, look_summary: 'v', full_prompt: 'p' })),
    scenes,
  };
  fs.writeFileSync(canon.projectFile, `${JSON.stringify(pipeline, null, 2)}\n`);

  // Local media for the ready scenes + narration for the narrator scenes.
  const clipBankDir = path.join(root, 'clip-bank');
  const bank = await createFixtureClipBank(clipBankDir, localClips, ffmpegPath);
  installFixtureClips(canon.inputRoot, bank);
  for (let n = 1; n <= localClips; n++) {
    const name = `narration-${String(n).padStart(4, '0')}.wav`;
    fs.writeFileSync(path.join(canon.inputRoot, 'narration', name), makeWav(3, n & 0xff));
    fs.copyFileSync(path.join(canon.inputRoot, 'narration', name), path.join(canon.outputsDir, 'narration', name));
  }

  const bgm = path.join(canon.inputRoot, 'music', 'background-music.mp3');
  await exec(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=10:sample_rate=44100', '-ac', '2', '-b:a', '96k', bgm]);
  fs.writeFileSync(path.join(canon.inputRoot, 'music', 'background-music.license.json'), JSON.stringify({ license: 'CC0' }));

  const intro = path.join(canon.inputRoot, 'branding', 'channel-intro.mp4');
  await exec(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'color=c=0x101020:s=1280x720:d=2', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', intro]);
  fs.writeFileSync(path.join(canon.inputRoot, 'branding', 'channel-logo.png'), makePng(256, 256, 6, 3));

  return { ...canon, pipeline, readyScenes: Array.from({ length: localClips }, (_, i) => i + 1) };
}

function writeFixtureBackgroundsFor(inputRoot: string, tags: readonly string[]): void {
  const dir = path.join(inputRoot, 'backgrounds');
  fs.mkdirSync(dir, { recursive: true });
  tags.forEach((tag, i) => fs.writeFileSync(path.join(dir, `${tag.replace(/^#/, '')}.png`), makePng(1920, 1080, 2, i + 1)));
}

/** Minimal deterministic 8 kHz mono PCM WAV. */
function makeWav(seconds: number, fill = 0): Buffer {
  const n = Math.round(seconds * 8000);
  const data = Buffer.alloc(n * 2, fill);
  const buf = Buffer.alloc(44 + data.length);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + data.length, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(data.length, 40);
  data.copy(buf, 44);
  return buf;
}