// Focused tests for STAGE ARTIFACT PRESERVATION (the "don't destroy the previous good output"
// safety improvement in src/stageExecutor.ts).
//
// Everything here runs in an isolated os.tmpdir() fixture. The REAL project inputs/, outputs/
// and assets/ are never read or written, no production stage is ever executed, and the only
// producer invoked is a synthetic in-process ffmpeg clip writer.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);

import { REPO } from './_testPaths.mjs';
const SRC = `${REPO}/production/src`;
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;

const se = await import(pathToFileURL(`${SRC}/stageExecutor.ts`).href);
const { executeStage, preserveStageArtifact, STAGE_BACKUP_DIRNAME, STAGE_SCRIPTS } = se;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
// 640x360 is the documented usable minimum (videoClip.MIN_CLIP_WIDTH/HEIGHT), so these clips are
// the cheapest artifacts that still satisfy the real media contract. 1s keeps the fixture fast.
const mkMp4 = async (o: string, color = '0x203040') => {
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=640x360:d=1`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', o]);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-preserve-'));
const INPUTS = path.join(tmp, 'inputs');
fs.mkdirSync(INPUTS, { recursive: true });

/** A fresh, independent outputs dir per scenario so nothing leaks between checks. */
function newOutputs(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Synthetic producer: writes a valid clip to whatever --output the executor asked for. */
const runScript = async (scriptRel: string, args: string[], color: string) => {
  const out = args[args.indexOf('--output') + 1];
  await mkMp4(out, color);
};

const stageOf = (scriptRel: string) => Object.entries(STAGE_SCRIPTS).find(([, v]) => v === scriptRel)?.[0] ?? scriptRel;
check('fixture uses the real stage script map', stageOf('src/edit.ts') === 'EDIT');

const backupDirFor = (outDir: string, stage: string) => path.join(outDir, STAGE_BACKUP_DIRNAME, stage);
const finalFor = (outDir: string) => path.join(outDir, 'final-with-fades.mp4');
const sidecarFor = (outDir: string) => `${finalFor(outDir)}.stage`;

// =======================================================================================
// 1. First-time output creation still works and creates NO backup
// =======================================================================================
{
  const OUT = newOutputs('first-time');
  const res = await executeStage('EDIT', { outputsDir: OUT, inputsDir: INPUTS, productionDir: tmp, runScript: (s, a) => runScript(s, a, '0x203040') }, { ffprobePath: process.env.FFPROBE_PATH });
  check('1. first-time execution succeeds', res.ok === true, JSON.stringify(res));
  check('1b. canonical output was created', fs.existsSync(finalFor(OUT)));
  check('1c. nothing was preserved (no prior artifact)', res.ok === true && (res as any).preservation?.preserved === false, JSON.stringify((res as any).preservation));
  check('1d. NO backup directory is created on a first run', !fs.existsSync(path.join(OUT, STAGE_BACKUP_DIRNAME)), fs.readdirSync(OUT).join(','));
  check('1e. no empty/zero-byte backup was left behind', !fs.existsSync(backupDirFor(OUT, 'EDIT')));
}

// =======================================================================================
// 2/3. Existing output is preserved before replacement; bytes + SHA-256 match the original
// =======================================================================================
{
  const OUT = newOutputs('preserve-on-rerun');
  // First run creates the canonical artifact.
  await executeStage('EDIT', { outputsDir: OUT, inputsDir: INPUTS, productionDir: tmp, runScript: (s, a) => runScript(s, a, '0x203040') }, { ffprobePath: process.env.FFPROBE_PATH });
  const originalSha = sha(finalFor(OUT));
  const originalBytes = fs.statSync(finalFor(OUT)).size;
  const originalCopy = fs.readFileSync(finalFor(OUT));
  // A provenance sidecar describing that artifact.
  const sidecarText = `${JSON.stringify({ stage: 'EDIT', key: 'k-original', output_hash: originalSha, output_path: 'final-with-fades.mp4' }, null, 2)}\n`;
  fs.writeFileSync(sidecarFor(OUT), sidecarText);

  // Second run REPLACES the artifact with different bytes.
  const res = await executeStage('EDIT', { outputsDir: OUT, inputsDir: INPUTS, productionDir: tmp, runScript: (s, a) => runScript(s, a, '0x3a4b5c') }, { ffprobePath: process.env.FFPROBE_PATH });
  check('2. rerun over an existing output succeeds', res.ok === true, JSON.stringify(res));
  check('2b. the previous artifact WAS preserved', res.ok === true && (res as any).preservation?.preserved === true, JSON.stringify((res as any).preservation));

  const p = (res as any).preservation;
  const backup = p.artifactBackup;
  check('3. the backup file exists on disk', fs.existsSync(backup), backup);
  check('3b. backup SHA-256 matches the ORIGINAL artifact', sha(backup) === originalSha, { backup: sha(backup), original: originalSha });
  check('3c. backup size matches the original', fs.statSync(backup).size === originalBytes);
  check('3d. backup bytes are byte-for-byte identical', fs.readFileSync(backup).equals(originalCopy));
  check('3e. backup is scoped under <outputsDir>/.stage-backups/EDIT/', backup.startsWith(backupDirFor(OUT, 'EDIT')), backup);

  check('2c. the canonical output really was replaced (new bytes)', sha(finalFor(OUT)) !== originalSha);
  check('2d. the canonical output is the NEW artifact, not the backup', fs.readFileSync(finalFor(OUT)).equals(originalCopy) === false);

  // ---- 4. matching sidecar is preserved ----
  check('4. the matching provenance sidecar was preserved', typeof p.sidecarBackup === 'string' && fs.existsSync(p.sidecarBackup), String(p.sidecarBackup));
  check('4b. preserved sidecar content matches the ORIGINAL sidecar', fs.readFileSync(p.sidecarBackup, 'utf8') === sidecarText);
  check('4c. preserved sidecar names the original output hash', JSON.parse(fs.readFileSync(p.sidecarBackup, 'utf8')).output_hash === originalSha);
  check('4d. preserved sidecar lives in the same per-stage backup dir', path.dirname(p.sidecarBackup) === backupDirFor(OUT, 'EDIT'));
}

// =======================================================================================
// 5. A pre-existing backup is NEVER overwritten, and unrelated backup files are untouched
// =======================================================================================
{
  const OUT = newOutputs('no-overwrite');
  await executeStage('EDIT', { outputsDir: OUT, inputsDir: INPUTS, productionDir: tmp, runScript: (s, a) => runScript(s, a, '0x203040') }, { ffprobePath: process.env.FFPROBE_PATH });
  const bdir = backupDirFor(OUT, 'EDIT');
  fs.mkdirSync(bdir, { recursive: true });

  // A decoy that already occupies a plausible backup name. It must survive untouched.
  const decoy = path.join(bdir, 'final-with-fades.mp4.20000101T000000000Z-deadbeef.bak');
  fs.writeFileSync(decoy, 'DECOY-CONTENT-MUST-NOT-CHANGE');
  const decoySha = sha(decoy);

  // Preserve the SAME unchanged artifact repeatedly. Names carry a ms stamp + content hash, so
  // this hammers the collision path: any name clash must fall through to a new candidate rather
  // than clobbering an existing backup.
  const returned: string[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await preserveStageArtifact(finalFor(OUT), 'EDIT');
    check(`5.${i} preservation of an existing artifact succeeds`, r.ok === true && (r as any).preserved === true, JSON.stringify(r));
    returned.push((r as any).artifactBackup);
  }
  check('5a. every preservation returned a DISTINCT backup path', new Set(returned).size === 5, JSON.stringify(returned));
  check('5b. every returned backup still exists and is intact', returned.every((p) => fs.existsSync(p) && sha(p) === sha(finalFor(OUT))));
  check('5c. no existing backup was overwritten (5 new + 1 decoy on disk)',
    fs.readdirSync(bdir).length === 6, fs.readdirSync(bdir).join(','));
  check('5d. the pre-existing decoy backup was NOT modified', sha(decoy) === decoySha && fs.readFileSync(decoy, 'utf8') === 'DECOY-CONTENT-MUST-NOT-CHANGE');
  check('5e. backups from earlier iterations were not deleted', returned.every((p) => fs.existsSync(p)));
}

// =======================================================================================
// 6. A FAILED backup prevents replacement and leaves the canonical output intact
// =======================================================================================
{
  const OUT = newOutputs('backup-fails');
  await executeStage('EDIT', { outputsDir: OUT, inputsDir: INPUTS, productionDir: tmp, runScript: (s, a) => runScript(s, a, '0x203040') }, { ffprobePath: process.env.FFPROBE_PATH });
  const originalSha = sha(finalFor(OUT));
  const originalCopy = fs.readFileSync(finalFor(OUT));
  fs.writeFileSync(sidecarFor(OUT), '{"stage":"EDIT","key":"k-original"}\n');

  // Make the backup location unusable: a plain FILE where the backup directory must go, so the
  // directory creation genuinely fails (ENOTDIR) instead of silently succeeding.
  fs.writeFileSync(path.join(OUT, STAGE_BACKUP_DIRNAME), 'not-a-directory');

  const res = await executeStage('EDIT', { outputsDir: OUT, inputsDir: INPUTS, productionDir: tmp, runScript: (s, a) => runScript(s, a, '0x3a4b5c') }, { ffprobePath: process.env.FFPROBE_PATH });
  check('6. a failed backup ABORTS the replacement', res.ok === false && res.code === 'PRESERVATION_FAILED', JSON.stringify(res));
  check('6b. the existing canonical output is byte-for-byte intact', fs.readFileSync(finalFor(OUT)).equals(originalCopy) && sha(finalFor(OUT)) === originalSha);
  check('6c. the existing sidecar is left intact (not misleading)', fs.readFileSync(sidecarFor(OUT), 'utf8') === '{"stage":"EDIT","key":"k-original"}\n');
  check('6d. the failure reason is explicit', res.ok === false && /Preservation required for EDIT/.test(res.reason), res.ok === false ? res.reason : '');
  check('6e. the aborted temp artifact was cleaned up', !fs.readdirSync(OUT).some((f) => f.includes('.tmp-')), fs.readdirSync(OUT).join(','));
  check('6f. no new canonical bytes were promoted', sha(finalFor(OUT)) === originalSha);
}

// =======================================================================================
// 7. An ABSENT sidecar is normal — replacement proceeds, nothing fake is created
// =======================================================================================
{
  const OUT = newOutputs('no-sidecar');
  await executeStage('EDIT', { outputsDir: OUT, inputsDir: INPUTS, productionDir: tmp, runScript: (s, a) => runScript(s, a, '0x203040') }, { ffprobePath: process.env.FFPROBE_PATH });
  fs.rmSync(sidecarFor(OUT), { force: true });
  const originalSha = sha(finalFor(OUT));

  const res = await executeStage('EDIT', { outputsDir: OUT, inputsDir: INPUTS, productionDir: tmp, runScript: (s, a) => runScript(s, a, '0x3a4b5c') }, { ffprobePath: process.env.FFPROBE_PATH });
  check('7. an absent sidecar does not block replacement', res.ok === true, JSON.stringify(res));
  check('7b. the artifact is still preserved', res.ok === true && (res as any).preservation?.preserved === true);
  check('7c. sidecarBackup is null (no fabricated sidecar backup)', res.ok === true && (res as any).preservation?.sidecarBackup === null, JSON.stringify((res as any).preservation));
  check('7d. the preserved artifact still matches the original', sha((res as any).preservation.artifactBackup) === originalSha);
  check('7e. no sidecar backup file was created', !fs.readdirSync(backupDirFor(OUT, 'EDIT')).some((f) => f.endsWith('.stage') || f.includes('.stage.')), fs.readdirSync(backupDirFor(OUT, 'EDIT')).join(','));
}

// =======================================================================================
// 8. Replacement failure AFTER the backup was created leaves the old version recoverable
// =======================================================================================
{
  // NOTE ON METHOD: `executeStage` exposes no injection seam between "preserve" and "rename", so
  // this drives the REAL exported preservation function and then provokes a REAL rename failure
  // (renaming a temp path that no longer exists). The property under test is recoverability: once
  // the backup exists and the promotion fails, the previous good output must be fully
  // reconstructible and the canonical output must be untouched.
  const OUT = newOutputs('replacement-fails');
  await executeStage('EDIT', { outputsDir: OUT, inputsDir: INPUTS, productionDir: tmp, runScript: (s, a) => runScript(s, a, '0x203040') }, { ffprobePath: process.env.FFPROBE_PATH });
  const originalSha = sha(finalFor(OUT));
  const originalCopy = fs.readFileSync(finalFor(OUT));
  const sidecarText = '{"stage":"EDIT","key":"k-original"}\n';
  fs.writeFileSync(sidecarFor(OUT), sidecarText);

  const preserved = await preserveStageArtifact(finalFor(OUT), 'EDIT');
  check('8. preservation succeeds before the attempted replacement', preserved.ok === true && preserved.preserved === true, JSON.stringify(preserved));

  // Provoke a genuine atomic-promotion failure.
  const doomed = path.join(OUT, 'final-with-fades.tmp-does-not-exist.mp4');
  let promoteFailed = false;
  try { await fsp.rename(doomed, finalFor(OUT)); } catch { promoteFailed = true; }
  check('8b. the replacement genuinely failed', promoteFailed);

  check('8c. the canonical output is still the ORIGINAL bytes', fs.readFileSync(finalFor(OUT)).equals(originalCopy) && sha(finalFor(OUT)) === originalSha);
  check('8d. the provenance sidecar still describes the ORIGINAL output', fs.readFileSync(sidecarFor(OUT), 'utf8') === sidecarText);
  check('8e. the old version is recoverable from the backup', fs.existsSync((preserved as any).artifactBackup) && sha((preserved as any).artifactBackup) === originalSha);
  check('8f. the sidecar is recoverable too', fs.existsSync((preserved as any).sidecarBackup!) && fs.readFileSync((preserved as any).sidecarBackup!, 'utf8') === sidecarText);
  check('8g. a restored copy reproduces the original exactly',
    (() => { const probe = path.join(OUT, 'restore-probe.mp4'); fs.copyFileSync((preserved as any).artifactBackup, probe); const ok = sha(probe) === originalSha; fs.rmSync(probe, { force: true }); return ok; })());
}

// =======================================================================================
// 9. Backup names are collision-safe, project/stage scoped, and GC-safe
// =======================================================================================
{
  const OUT = newOutputs('naming');
  const { collectProjectTemps } = await import(pathToFileURL(`${SRC}/projectOrchestrator.ts`).href);
  await executeStage('EDIT', { outputsDir: OUT, inputsDir: INPUTS, productionDir: tmp, runScript: (s, a) => runScript(s, a, '0x203040') }, { ffprobePath: process.env.FFPROBE_PATH });
  await executeStage('EDIT', { outputsDir: OUT, inputsDir: INPUTS, productionDir: tmp, runScript: (s, a) => runScript(s, a, '0x3a4b5c') }, { ffprobePath: process.env.FFPROBE_PATH });

  const files = fs.readdirSync(backupDirFor(OUT, 'EDIT'));
  check('9. backup names embed a timestamp and a content-hash tag', files.every((f) => /\.\d{8}T\d{9}Z-[0-9a-f]{8}(-\d+)?\.bak$/.test(f)), files.join(','));
  check('9b. backups are scoped to ONE stage subdirectory', fs.readdirSync(path.join(OUT, STAGE_BACKUP_DIRNAME)).join(',') === 'EDIT');

  // The project temp-GC must never consider a backup to be removable temp garbage.
  const gc = await collectProjectTemps({ projectRoot: OUT, minAgeMs: 0 });
  check('9c. the temp-GC does NOT classify any backup as temp garbage', gc.candidates.length === 0 && gc.deleted.length === 0, JSON.stringify(gc));
  check('9d. backups still exist after a GC pass', fs.readdirSync(backupDirFor(OUT, 'EDIT')).length === files.length);
}

// =======================================================================================
// 10. Preservation never touches unrelated files
// =======================================================================================
{
  const OUT = newOutputs('scoped');
  // Unrelated project files that must be completely unaffected.
  const bystanders = ['scene-0001.mp4', 'scene-0002.mp4', 'final-narrated.mp4', 'state.json', 'stages.json', 'run.log.jsonl'];
  for (const f of bystanders) fs.writeFileSync(path.join(OUT, f), `bystander:${f}`);
  const before = bystanders.map((f) => sha(path.join(OUT, f)));

  await executeStage('EDIT', { outputsDir: OUT, inputsDir: INPUTS, productionDir: tmp, runScript: (s, a) => runScript(s, a, '0x203040') }, { ffprobePath: process.env.FFPROBE_PATH });
  await executeStage('EDIT', { outputsDir: OUT, inputsDir: INPUTS, productionDir: tmp, runScript: (s, a) => runScript(s, a, '0x3a4b5c') }, { ffprobePath: process.env.FFPROBE_PATH });

  check('10. unrelated project files are byte-for-byte untouched',
    bystanders.every((f, i) => sha(path.join(OUT, f)) === before[i]), bystanders.join(','));
  const backups = fs.readdirSync(backupDirFor(OUT, 'EDIT'));
  check('10b. backups contain ONLY the preserved EDIT artifact (nothing else copied)',
    backups.length === 1 && backups[0].startsWith('final-with-fades.mp4.'), backups.join(','));
}

// ---- the real project was never touched ----
{
  const realOut = `${REPO}/production/outputs`;
  check('no real project outputs were modified by this test',
    !fs.existsSync(path.join(realOut, '.stage-backups')), `${realOut}/.stage-backups`);
  const realInputs = `${REPO}/production/inputs`;
  check('no backup dirs were created under the real inputs root', !fs.existsSync(path.join(realInputs, '.stage-backups')));
}

console.log(`\nSTAGE ARTIFACT PRESERVATION TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
