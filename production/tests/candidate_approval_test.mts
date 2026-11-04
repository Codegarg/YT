// Candidate-specific approval/publish boundary. Isolated synthetic fixture only.
// NEVER touches the canonical production project, never publishes to the network, never writes
// approval.json/pipeline.json outside the temp fixture.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
import { SRC, FF } from './_testPaths.mjs';

process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;

const WF = await import(pathToFileURL(`${SRC}/projectWorkflow.ts`).href);
const AP = await import(pathToFileURL(`${SRC}/approval.ts`).href);
const AR = await import(pathToFileURL(`${SRC}/approvalReview.ts`).href);
const Z = await import(pathToFileURL(`${SRC}/zernio.ts`).href);
const RS = await import(pathToFileURL(`${SRC}/reviewState.ts`).href);
const SEA = await import(pathToFileURL(`${SRC}/sceneExecutorAdapter.ts`).href);

const APPROVED_PROJECT_ID = 'youtube-automation-2-20261003160855-2740';
const APPROVED_YOUTUBE_ACCOUNT_ID = '6ae2401339a3d63e1238c167';
const approvedAccountInspector = async () => [{
  platform: 'youtube',
  accountId: APPROVED_YOUTUBE_ACCOUNT_ID,
  displayName: 'RAAT KA KHAUF',
  isActive: true,
}];

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function makePng(w: number, h: number, ct = 6, tag = 0) {
  const T: number[] = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct;
  const ch = ct === 6 ? 4 : 2; const raw = Buffer.alloc(h * (1 + w * ch), 0x80);
  for (let y = 0; y < h; y++) raw[y * (1 + w * ch)] = 0;
  raw[11] = tag & 0xff;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const wav = (f: string, sec: number, tag = 0) => {
  const n = Math.round(sec * 8000); const d = Buffer.alloc(n * 2, tag); const b = Buffer.alloc(44 + d.length);
  b.write('RIFF', 0); b.writeUInt32LE(36 + d.length, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36);
  b.writeUInt32LE(d.length, 40); d.copy(b, 44); fs.writeFileSync(f, b);
};
const mkClip = async (o: string) => {
  fs.mkdirSync(path.dirname(o), { recursive: true });
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=640x360:d=2', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', o]);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-approval-'));

async function buildProject(id: string) {
  const projectsRoot = path.join(tmp, 'projects');
  const inputsRoot = path.join(tmp, 'inputs');
  const outputsRoot = path.join(tmp, 'outputs');
  const projectDir = path.join(projectsRoot, id);
  const inputRoot = path.join(inputsRoot, id);
  const outputsDir = path.join(outputsRoot, id);
  for (const d of [projectDir, inputRoot, outputsDir, path.join(inputRoot, 'flow-clips'), path.join(inputRoot, 'backgrounds'), path.join(inputRoot, 'narration'), path.join(inputRoot, 'music'), path.join(inputRoot, 'branding'), path.join(outputsDir, 'narration')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(inputRoot, 'backgrounds', 'BGD-01.png'), makePng(1920, 1080, 2, 1));

  const scenes: any[] = [];
  for (let n = 1; n <= 2; n++) {
    await mkClip(path.join(inputRoot, 'flow-clips', `scene-000${n}.mp4`));
    const narration = `narration-000${n}.wav`;
    wav(path.join(inputRoot, 'narration', narration), 3, n & 0xff);
    fs.copyFileSync(path.join(inputRoot, 'narration', narration), path.join(outputsDir, 'narration', narration));
    scenes.push({ scene_number: n, title: `S${n}`, background_tag: '#BGD-01', character_tags: [], speaker: 'NARRATOR', camera: 'w', effects: '', sound_design: '', visual_action: `a${n}`, narration_text: 'न', animation_prompt_NARRATOR_ONLY: 'p', animation_prompt_WITH_LIPSYNC: 'p', status: 'pending' });
  }
  fs.writeFileSync(path.join(projectDir, 'pipeline.json'), JSON.stringify({ project_id: id, flow_project_name: 'Candidate Approval', characters: [], backgrounds: [{ tag: '#BGD-01', location_name: 't', look_summary: 'x', full_prompt: 'x' }], scenes }, null, 2));

  const bgm = path.join(inputRoot, 'music', 'background-music.mp3');
  await exec(process.env.FFMPEG_PATH!, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=8', '-c:a', 'libmp3lame', bgm]);
  fs.writeFileSync(path.join(inputRoot, 'music', 'background-music.license.json'), JSON.stringify({ license: 'CC0' }));
  const intro = path.join(inputRoot, 'branding', 'channel-intro.mp4');
  await mkClip(intro);
  const logo = path.join(inputRoot, 'branding', 'channel-logo.png');
  fs.writeFileSync(logo, makePng(256, 256, 6, 3));

  const projectFile = path.join(projectDir, 'pipeline.json');
  const stageInputs = { bgmHash: sha(bgm), introHash: sha(intro), logoHash: sha(logo), titleMetadata: { title: 'CANDIDATE' } };
  const sceneExecutorFactory = (input: any) => SEA.createRealSceneExecutor({
    projectId: input.projectId,
    inputRoot: input.inputRoot,
    outputsRoot: input.outputsRoot,
    pipeline: input.pipeline,
    allowGeneration: input.allowGeneration,
    ffprobePath: input.ffprobePath,
    flow: input.flow,
  });
  const run = await WF.resumeProjectWorkflow({
    projectsRoot, inputsRoot, outputsRoot, projectId: id,
    ffprobePath: process.env.FFPROBE_PATH,
    titleAssets: { intro, logo, title: 'CANDIDATE' },
    bgmPath: bgm,
    stageInputs,
    sceneExecutorFactory: sceneExecutorFactory as any,
    stageExecutorFactory: () => async (_stage: string, out: string) => { await mkClip(out); return { ok: true }; },
  } as any);

  const base = () => ({
    projectId: id,
    outputsRoot,
    outputsDir,
    inputRoot,
    pipeline: JSON.parse(fs.readFileSync(projectFile, 'utf8')),
    projectFile,
    ffprobePath: process.env.FFPROBE_PATH,
    stageInputs,
  });
  return { id, projectsRoot, inputsRoot, outputsRoot, projectDir, inputRoot, outputsDir, projectFile, run, base };
}

async function setReview(f: any, status: string, videoPath: string) {
  const project = await RS.loadProject(f.projectFile);
  project.review = {
    status: status as any,
    video_path: videoPath,
    requested_at: '2026-01-01T00:00:00.000Z',
    ...(status === 'approved' || status === 'rejected' ? { decided_at: '2026-01-02T00:00:00.000Z' } : {}),
  };
  await RS.saveProject(f.projectFile, project);
}
const approvalSha = (f: any) => sha(path.join(f.outputsDir, 'approval.json'));

const A = await buildProject(APPROVED_PROJECT_ID);
check('setup reaches AWAITING_APPROVAL', A.run.phase === 'AWAITING_APPROVAL', JSON.stringify({ status: A.run.status, phase: A.run.phase }));

// ================== canonical compatibility ==================
const canonicalApprove = await AP.approveProject({ ...A.base(), now: '2026-01-01T00:00:00.000Z' });
check('canonical approval still succeeds', canonicalApprove.ok === true && !canonicalApprove.idempotent, JSON.stringify(canonicalApprove));
const canonicalRecord = JSON.parse(fs.readFileSync(path.join(A.outputsDir, 'approval.json'), 'utf8'));
check('canonical record retains schema-v1 canonical shape', canonicalRecord.approved_final_output_path === 'final-title.mp4' && canonicalRecord.approved_artifact_kind === undefined && canonicalRecord.approved_candidate_provenance === undefined, JSON.stringify(canonicalRecord));
const canonicalVerdict = await AP.evaluateApproval(A.base());
check('canonical approval evaluates for final-title.mp4', canonicalVerdict.status === 'APPROVED' && AP.sameArtifactPath(canonicalVerdict.finalOutputPath, path.join(A.outputsDir, 'final-title.mp4')), JSON.stringify(canonicalVerdict));

// ================== candidate preparation ==================
const canonicalFile = path.join(A.outputsDir, 'final-title.mp4');
const candidateFile = path.join(A.outputsDir, 'final-title-no-logo-sparkle-candidate.mp4');
fs.copyFileSync(canonicalFile, candidateFile);
const candidateHash = sha(candidateFile);
const canonicalApprovalSha = approvalSha(A);

let uploadInput: any = null;
const mediaHost = {
  uploadVideo: async (input: any) => {
    uploadInput = input;
    return {
      bucket: 'test-bucket',
      key: `youtube-automation/${APPROVED_PROJECT_ID}/${candidateHash}.mp4`,
      sha256: candidateHash,
      size: fs.statSync(candidateFile).size,
      contentType: 'video/mp4',
    };
  },
  uploadThumbnail: async () => { throw new Error('thumbnail should not be used'); },
  presign: async () => 'https://example.invalid/presigned-candidate.mp4',
};

// ================== wrong expected hash ==================
const wrongHash = await AP.approveProject({ ...A.base(), candidatePath: candidateFile, expectedHash: '00'.repeat(32) });
check('wrong candidate hash is refused', wrongHash.ok === false && wrongHash.code === 'PRECONDITION_FAILED' && approvalSha(A) === canonicalApprovalSha, JSON.stringify(wrongHash));

// ================== traversal / outside output dir ==================
const traversal = await AP.approveProject({ ...A.base(), candidatePath: '../escape.mp4', expectedHash: candidateHash });
check('relative traversal is refused', traversal.ok === false && traversal.code === 'PRECONDITION_FAILED' && approvalSha(A) === canonicalApprovalSha, JSON.stringify(traversal));
const outsideFile = path.join(tmp, 'outside.mp4');
fs.copyFileSync(canonicalFile, outsideFile);
const outside = await AP.approveProject({ ...A.base(), candidatePath: outsideFile, expectedHash: sha(outsideFile) });
check('absolute path outside the project outputs is refused', outside.ok === false && outside.code === 'PRECONDITION_FAILED' && approvalSha(A) === canonicalApprovalSha, JSON.stringify(outside));

// ================== explicit candidate approval ==================
const candidateApprove = await AP.approveProject({ ...A.base(), candidatePath: candidateFile, expectedHash: candidateHash, now: '2026-01-03T00:00:00.000Z' });
check('candidate approval succeeds with exact path+hash', candidateApprove.ok === true && !candidateApprove.idempotent, JSON.stringify(candidateApprove));
const candidateRecord = JSON.parse(fs.readFileSync(path.join(A.outputsDir, 'approval.json'), 'utf8'));
check('candidate record is path+hash+provenance bound', candidateRecord.approved_artifact_kind === 'candidate'
  && candidateRecord.approved_final_output_path === path.basename(candidateFile)
  && candidateRecord.approved_final_output_hash === candidateHash
  && candidateRecord.approved_final_stage_key === canonicalRecord.approved_final_stage_key
  && candidateRecord.approved_candidate_provenance?.source_stage === 'TITLE'
  && candidateRecord.approved_candidate_provenance?.source_stage_key === canonicalRecord.approved_final_stage_key
  && candidateRecord.approved_candidate_provenance?.source_output_path === 'final-title.mp4'
  && candidateRecord.approved_candidate_provenance?.source_output_hash === canonicalRecord.approved_final_output_hash, JSON.stringify(candidateRecord));
const candidateVerdict = await AP.evaluateApproval(A.base());
check('evaluation resolves the exact candidate, not final-title.mp4', candidateVerdict.status === 'APPROVED' && AP.sameArtifactPath(candidateVerdict.finalOutputPath, candidateFile) && candidateVerdict.finalOutputHash === candidateHash, JSON.stringify(candidateVerdict));

// ================== missing sidecar ==================
const sidecar = `${canonicalFile}.stage`;
const sidecarBackup = `${sidecar}.bak`;
fs.renameSync(sidecar, sidecarBackup);
const missingSidecar = await AP.approveProject({ ...A.base(), candidatePath: candidateFile, expectedHash: candidateHash });
check('candidate approval fails closed without the TITLE sidecar', missingSidecar.ok === false && missingSidecar.code === 'PRECONDITION_FAILED', JSON.stringify(missingSidecar));
check('existing candidate approval is stale when provenance sidecar disappears', (await AP.evaluateApproval(A.base())).status === 'STALE_APPROVAL');
fs.renameSync(sidecarBackup, sidecar);
check('restored sidecar revalidates the candidate', (await AP.evaluateApproval(A.base())).status === 'APPROVED');

// ================== changed candidate file ==================
fs.appendFileSync(candidateFile, Buffer.from('CORRUPT'));
const changedVerdict = await AP.evaluateApproval(A.base());
check('changed candidate file invalidates approval', changedVerdict.status === 'STALE_APPROVAL', JSON.stringify(changedVerdict));
fs.copyFileSync(canonicalFile, candidateFile);
check('restored candidate is valid again', (await AP.evaluateApproval(A.base())).status === 'APPROVED');

// ================== no silent canonical fallback ==================
// Changing the canonical TITLE breaks the recorded provenance; evaluation must fail closed, not
// quietly switch to hashing final-title.mp4. The earlier check already proved the approved path
// resolves to the candidate while provenance is intact.
fs.appendFileSync(canonicalFile, Buffer.from('DIFFERENT_CANONICAL'));
const noFallback = await AP.evaluateApproval(A.base());
check('changed canonical TITLE invalidates candidate provenance (no fallback)', noFallback.status === 'STALE_APPROVAL' && noFallback.record.approved_final_output_path === path.basename(candidateFile) && /provenance/i.test(noFallback.reason), JSON.stringify(noFallback));
fs.copyFileSync(candidateFile, canonicalFile);
check('restored canonical TITLE revalidates the candidate', (await AP.evaluateApproval(A.base())).status === 'APPROVED');

// ================== missing candidate provenance ==================
const validCandidateRecordRaw = fs.readFileSync(path.join(A.outputsDir, 'approval.json'), 'utf8');
const missingProvenanceRecord: any = JSON.parse(validCandidateRecordRaw);
delete missingProvenanceRecord.approved_candidate_provenance;
fs.writeFileSync(path.join(A.outputsDir, 'approval.json'), JSON.stringify(missingProvenanceRecord, null, 2));
check('candidate record without provenance is rejected', AP.validateApprovalRecord(missingProvenanceRecord).ok === false && (await AP.evaluateApproval(A.base())).status === 'NOT_APPROVED');
fs.writeFileSync(path.join(A.outputsDir, 'approval.json'), validCandidateRecordRaw);

const tamperedProvenance: any = JSON.parse(validCandidateRecordRaw);
tamperedProvenance.approved_candidate_provenance.source_output_hash = '00'.repeat(32);
fs.writeFileSync(path.join(A.outputsDir, 'approval.json'), JSON.stringify(tamperedProvenance, null, 2));
check('tampered candidate provenance is stale', (await AP.evaluateApproval(A.base())).status === 'STALE_APPROVAL');
fs.writeFileSync(path.join(A.outputsDir, 'approval.json'), validCandidateRecordRaw);

const staleStatus: any = JSON.parse(validCandidateRecordRaw);
staleStatus.status = 'stale';
fs.writeFileSync(path.join(A.outputsDir, 'approval.json'), JSON.stringify(staleStatus, null, 2));
check('stale approval status cannot evaluate as approved', (await AP.evaluateApproval(A.base())).status === 'STALE_APPROVAL');
fs.writeFileSync(path.join(A.outputsDir, 'approval.json'), validCandidateRecordRaw);

// ================== review must authorize the same artifact ==================
await setReview(A, 'approved', canonicalFile);
const mismatch = await AR.reconcileApprovalReview(A.base());
check('candidate approval + canonical review is not publishable', mismatch.integrity === 'APPROVAL_VALID' && mismatch.publishable === false && mismatch.mismatch === true && mismatch.reviewArtifactMatchesApproval === false, JSON.stringify(mismatch));
const gateWrongReview = await Z.evaluatePublishGate({ ...A.base(), mediaSha256: candidateHash });
check('publish gate refuses a review pointing at a different artifact', gateWrongReview.ok === false, JSON.stringify(gateWrongReview));
let wrongReviewPublished = 0;
const publishWrongReview = await Z.publishToZernio({
  projectFile: A.projectFile, accountId: APPROVED_YOUTUBE_ACCOUNT_ID, mediaUrl: 'https://example.invalid/candidate.mp4', title: 'T',
  outputsRoot: A.outputsRoot, inputsRoot: A.inputsRoot, ffprobePath: process.env.FFPROBE_PATH,
  mediaSha256: candidateHash, confirmPublish: 'YES',
}, { accountInspector: approvedAccountInspector, publisher: async () => { wrongReviewPublished++; return {}; } });
check('publisher is not invoked for a different reviewed artifact', publishWrongReview.ok === false && publishWrongReview.refused === 'integrity' && wrongReviewPublished === 0, JSON.stringify(publishWrongReview));

// Explicit sync moves the review to the approved candidate path.
const sync = await AR.syncReviewFromApproval({ ...A.base(), now: '2026-01-04T00:00:00.000Z' });
check('sync sets the review to the approved candidate path', sync.ok === true && sync.changed === true && AP.sameArtifactPath((sync as any).review.video_path, candidateFile), JSON.stringify(sync));
const reconciled = await AR.reconcileApprovalReview(A.base());
check('review/reconciliation now authorize the candidate', reconciled.publishable === true && AP.sameArtifactPath(reconciled.approvedFinalOutputPath, candidateFile) && reconciled.reviewArtifactMatchesApproval === true, JSON.stringify(reconciled));

// ================== candidate publishing requires the approved hash ==================
const gateNoMediaHash = await Z.evaluatePublishGate({ ...A.base() });
check('candidate publish gate requires mediaSha256', gateNoMediaHash.ok === false, JSON.stringify(gateNoMediaHash));
const gateWithMediaHash = await Z.evaluatePublishGate({ ...A.base(), mediaSha256: candidateHash });
check('candidate publish gate accepts the exact approved media hash', gateWithMediaHash.ok === true && gateWithMediaHash.approvedArtifactKind === 'candidate' && gateWithMediaHash.approvedOutputHash === candidateHash, JSON.stringify(gateWithMediaHash));

let mediaUrlPublished = 0;
let mediaUrlAccountChecks = 0;
const rejectedMediaUrl = await Z.publishToZernio({
  projectFile: A.projectFile, accountId: APPROVED_YOUTUBE_ACCOUNT_ID, mediaUrl: 'https://example.invalid/candidate.mp4', title: 'T',
  outputsRoot: A.outputsRoot, inputsRoot: A.inputsRoot, ffprobePath: process.env.FFPROBE_PATH,
  mediaSha256: candidateHash, confirmPublish: 'YES',
}, {
  accountInspector: async () => { mediaUrlAccountChecks++; return [{
    platform: 'youtube', accountId: APPROVED_YOUTUBE_ACCOUNT_ID, displayName: 'RAAT KA KHAUF', isActive: true,
  }]; },
  mediaHost,
  publisher: async () => { mediaUrlPublished++; return {}; },
});
check('candidate mediaUrl is rejected before account/R2/publish', rejectedMediaUrl.ok === false && rejectedMediaUrl.refused === 'integrity' && /mediaFile|mediaUrl/i.test(rejectedMediaUrl.reason) && mediaUrlAccountChecks === 0 && uploadInput === null && mediaUrlPublished === 0, JSON.stringify({ rejectedMediaUrl, mediaUrlAccountChecks, uploadInput, mediaUrlPublished }));

let published = 0;
let capturedPayload: any = null;
const publish = await Z.publishToZernio({
  projectFile: A.projectFile, accountId: APPROVED_YOUTUBE_ACCOUNT_ID, mediaFile: candidateFile, title: 'T',
  outputsRoot: A.outputsRoot, inputsRoot: A.inputsRoot, ffprobePath: process.env.FFPROBE_PATH,
  mediaSha256: candidateHash, confirmPublish: 'YES', visibility: 'private',
}, { accountInspector: approvedAccountInspector, mediaHost, publisher: async (payload: any) => { published++; capturedPayload = payload; return { post: { id: 'p1', platforms: [{ platformPostUrl: 'https://youtu.be/x' }] } }; } });
check('candidate publish succeeds only with the exact approved hash', publish.ok === true && published === 1, JSON.stringify({ publish, published }));
check('candidate publish uploads the exact approved path and hash before presigning', uploadInput?.filePath === candidateFile && uploadInput?.expectedSha256 === candidateHash, JSON.stringify(uploadInput));
check('candidate payload uses the allowlisted account, private visibility, and synthetic-media disclosure', capturedPayload?.platforms?.[0]?.accountId === APPROVED_YOUTUBE_ACCOUNT_ID && capturedPayload?.platforms?.[0]?.platformSpecificData?.visibility === 'private' && capturedPayload?.platforms?.[0]?.platformSpecificData?.containsSyntheticMedia === true, JSON.stringify(capturedPayload));

// ================== read-only checks ==================
const pipelineBefore = sha(A.projectFile);
const approvalBefore = approvalSha(A);
await AR.reconcileApprovalReview(A.base());
await AP.evaluateApproval(A.base());
check('candidate reconciliation/evaluation are read-only', sha(A.projectFile) === pipelineBefore && approvalSha(A) === approvalBefore);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nCANDIDATE APPROVAL TESTS PASSED (${passed} checks)`);
