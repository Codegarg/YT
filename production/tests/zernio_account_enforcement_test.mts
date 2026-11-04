// Project-specific YouTube account enforcement. Offline only: fake account inspector, fake R2 host,
// fake publisher. No credentials, network, real presigning, uploads, or publishing.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import { SRC } from './_testPaths.mjs';

const Z = await import(pathToFileURL(`${SRC}/zernio.ts`).href);
const YA = await import(pathToFileURL(`${SRC}/youtubeAccountAllowlist.ts`).href);

const APPROVED_PROJECT_ID = 'youtube-automation-2-20261003160855-2740';
const APPROVED_ACCOUNT_ID = '6ae2401339a3d63e1238c167';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zernio-account-enforcement-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const mediaBytes = Buffer.from('offline-account-enforcement-media');
const mediaHash = crypto.createHash('sha256').update(mediaBytes).digest('hex');
const mediaFile = path.join(tmp, 'candidate.mp4');
fs.writeFileSync(mediaFile, mediaBytes);

const activeApprovedAccount = {
  platform: 'youtube',
  accountId: APPROVED_ACCOUNT_ID,
  displayName: 'RAAT KA KHAUF',
  isActive: true,
};

function makeProject(projectId = APPROVED_PROJECT_ID) {
  const root = fs.mkdtempSync(path.join(tmp, 'case-'));
  const projectDir = path.join(root, 'projects', projectId);
  fs.mkdirSync(projectDir, { recursive: true });
  const projectFile = path.join(projectDir, 'pipeline.json');
  fs.writeFileSync(projectFile, JSON.stringify({
    project_id: projectId,
    review: { status: 'approved', video_path: mediaFile },
  }, null, 2));
  return {
    projectFile,
    outputsRoot: path.join(root, 'outputs'),
    inputsRoot: path.join(root, 'inputs'),
  };
}

async function runPublish(options: {
  requestedAccountId?: string;
  projectId?: string;
  inspect: () => Promise<any[]>;
}) {
  const project = makeProject(options.projectId ?? APPROVED_PROJECT_ID);
  const order: string[] = [];
  let uploaded = false;
  let published = false;

  const mediaHost = {
    uploadVideo: async () => {
      uploaded = true;
      order.push('upload');
      return {
        bucket: 'test-bucket',
        key: `youtube-automation/${APPROVED_PROJECT_ID}/${mediaHash}.mp4`,
        sha256: mediaHash,
        size: mediaBytes.length,
        contentType: 'video/mp4',
      };
    },
    uploadThumbnail: async () => { throw new Error('thumbnail should not be used'); },
    presign: async () => {
      order.push('presign');
      return 'https://signed.example/video?X-Amz-Signature=SECRET_ACCOUNT_TEST';
    },
  };

  const outcome = await Z.publishToZernio({
    projectFile: project.projectFile,
    accountId: options.requestedAccountId ?? APPROVED_ACCOUNT_ID,
    mediaFile,
    title: 'RAAT KA KHAUF',
    mediaSha256: mediaHash,
    confirmPublish: 'YES',
    outputsRoot: project.outputsRoot,
    inputsRoot: project.inputsRoot,
    ffprobePath: process.env.FFPROBE_PATH,
  }, {
    evaluateGate: async () => ({
      ok: true,
      approvedOutputPath: mediaFile,
      approvedOutputHash: mediaHash,
      approvedArtifactKind: 'candidate',
    }),
    accountInspector: async (input: any) => {
      order.push('account');
      assert.equal(input.platform, 'youtube');
      return options.inspect();
    },
    mediaHost,
    publisher: async (payload: any) => {
      published = true;
      order.push('publish');
      assert.equal(payload.platforms[0].accountId, APPROVED_ACCOUNT_ID);
      assert.equal(payload.platforms[0].platformSpecificData.visibility, 'private');
      assert.equal(payload.platforms[0].platformSpecificData.containsSyntheticMedia, true);
      return { post: { id: 'post-1', platforms: [{ platformPostUrl: 'https://youtu.be/x' }] } };
    },
  });

  return { outcome, order, uploaded, published };
}

test('allowlist resolves the approved project and has no wildcard fallback', async () => {
  const allowlist = await YA.loadYouTubeAccountAllowlist();
  assert.deepEqual(YA.resolveApprovedYouTubeAccount(allowlist, APPROVED_PROJECT_ID), {
    accountId: APPROVED_ACCOUNT_ID,
    displayName: 'RAAT KA KHAUF',
  });
  assert.equal(YA.resolveApprovedYouTubeAccount(allowlist, 'some-other-project'), null);
});

test('correct active account is verified before R2 upload and publisher request', async () => {
  const result = await runPublish({ inspect: async () => [activeApprovedAccount] });

  assert.equal(result.outcome.ok, true);
  assert.deepEqual(result.order, ['account', 'upload', 'presign', 'publish']);
  assert.equal(result.uploaded, true);
  assert.equal(result.published, true);
});

test('wrong requested account is refused before R2 upload or publisher request', async () => {
  const result = await runPublish({
    requestedAccountId: 'different-youtube-account',
    inspect: async () => [activeApprovedAccount],
  });

  assert.equal(result.outcome.ok, false);
  assert.equal(result.outcome.refused, 'account');
  assert.deepEqual(result.order, []);
  assert.equal(result.uploaded, false);
  assert.equal(result.published, false);
});

test('disconnected approved account is refused before R2 upload or publisher request', async () => {
  const result = await runPublish({
    inspect: async () => [{ ...activeApprovedAccount, isActive: false }],
  });

  assert.equal(result.outcome.ok, false);
  assert.equal(result.outcome.refused, 'account');
  assert.deepEqual(result.order, ['account']);
  assert.equal(result.uploaded, false);
  assert.equal(result.published, false);
});

test('account with unknown connection state is refused', async () => {
  const result = await runPublish({
    inspect: async () => [{ ...activeApprovedAccount, isActive: null }],
  });

  assert.equal(result.outcome.ok, false);
  assert.equal(result.outcome.refused, 'account');
  assert.deepEqual(result.order, ['account']);
  assert.equal(result.uploaded, false);
  assert.equal(result.published, false);
});

test('missing approved account is refused before R2 upload or publisher request', async () => {
  const result = await runPublish({ inspect: async () => [] });

  assert.equal(result.outcome.ok, false);
  assert.equal(result.outcome.refused, 'account');
  assert.deepEqual(result.order, ['account']);
  assert.equal(result.uploaded, false);
  assert.equal(result.published, false);
});

test('same ID on a non-YouTube platform is refused', async () => {
  const result = await runPublish({
    inspect: async () => [{ ...activeApprovedAccount, platform: 'instagram' }],
  });

  assert.equal(result.outcome.ok, false);
  assert.equal(result.outcome.refused, 'account');
  assert.deepEqual(result.order, ['account']);
  assert.equal(result.uploaded, false);
  assert.equal(result.published, false);
});

test('account API failure is refused before R2 upload and does not leak details', async () => {
  const result = await runPublish({
    inspect: async () => { throw new Error('SECRET_ACCOUNT_API_DETAIL'); },
  });

  assert.equal(result.outcome.ok, false);
  assert.equal(result.outcome.refused, 'account');
  assert.deepEqual(result.order, ['account']);
  assert.equal(result.uploaded, false);
  assert.equal(result.published, false);
  assert.equal(JSON.stringify(result.outcome).includes('SECRET_ACCOUNT_API_DETAIL'), false);
});

test('project without an allowlist entry is refused before R2 upload', async () => {
  const result = await runPublish({
    projectId: 'project-not-in-allowlist',
    inspect: async () => [activeApprovedAccount],
  });

  assert.equal(result.outcome.ok, false);
  assert.equal(result.outcome.refused, 'account');
  assert.deepEqual(result.order, []);
  assert.equal(result.uploaded, false);
  assert.equal(result.published, false);
});

test('candidate mediaUrl is refused before account verification, R2 upload, or publisher request', async () => {
  const project = makeProject();
  let accountChecks = 0;
  let uploaded = false;
  let published = false;

  const outcome = await Z.publishToZernio({
    projectFile: project.projectFile,
    accountId: APPROVED_ACCOUNT_ID,
    mediaUrl: 'https://example.invalid/candidate.mp4',
    title: 'RAAT KA KHAUF',
    mediaSha256: mediaHash,
    confirmPublish: 'YES',
    outputsRoot: project.outputsRoot,
    inputsRoot: project.inputsRoot,
    ffprobePath: process.env.FFPROBE_PATH,
  }, {
    evaluateGate: async () => ({
      ok: true,
      approvedOutputPath: mediaFile,
      approvedOutputHash: mediaHash,
      approvedArtifactKind: 'candidate',
    }),
    accountInspector: async () => {
      accountChecks++;
      return [activeApprovedAccount];
    },
    mediaHost: {
      uploadVideo: async () => { uploaded = true; throw new Error('not used'); },
      uploadThumbnail: async () => { throw new Error('not used'); },
      presign: async () => { throw new Error('not used'); },
    },
    publisher: async () => { published = true; return {}; },
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.refused, 'integrity');
  assert.match(outcome.reason, /mediaFile|mediaUrl/i);
  assert.equal(accountChecks, 0);
  assert.equal(uploaded, false);
  assert.equal(published, false);
});

test('candidate with both mediaUrl and mediaFile is refused before account/R2/publish', async () => {
  const project = makeProject();
  let accountChecks = 0;
  let uploaded = false;
  let published = false;

  const outcome = await Z.publishToZernio({
    projectFile: project.projectFile,
    accountId: APPROVED_ACCOUNT_ID,
    mediaUrl: 'https://example.invalid/candidate.mp4',
    mediaFile,
    title: 'RAAT KA KHAUF',
    mediaSha256: mediaHash,
    confirmPublish: 'YES',
    outputsRoot: project.outputsRoot,
    inputsRoot: project.inputsRoot,
    ffprobePath: process.env.FFPROBE_PATH,
  }, {
    evaluateGate: async () => ({
      ok: true,
      approvedOutputPath: mediaFile,
      approvedOutputHash: mediaHash,
      approvedArtifactKind: 'candidate',
    }),
    accountInspector: async () => { accountChecks++; return [activeApprovedAccount]; },
    mediaHost: {
      uploadVideo: async () => { uploaded = true; throw new Error('not used'); },
      uploadThumbnail: async () => { throw new Error('not used'); },
      presign: async () => { throw new Error('not used'); },
    },
    publisher: async () => { published = true; return {}; },
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.refused, 'integrity');
  assert.match(outcome.reason, /exactly one/i);
  assert.equal(accountChecks, 0);
  assert.equal(uploaded, false);
  assert.equal(published, false);
});

test('candidate with non-private visibility is refused before account/R2/publish', async () => {
  const project = makeProject();
  let accountChecks = 0;
  let uploaded = false;
  let published = false;

  const outcome = await Z.publishToZernio({
    projectFile: project.projectFile,
    accountId: APPROVED_ACCOUNT_ID,
    mediaFile,
    title: 'RAAT KA KHAUF',
    mediaSha256: mediaHash,
    visibility: 'public',
    confirmPublish: 'YES',
    outputsRoot: project.outputsRoot,
    inputsRoot: project.inputsRoot,
    ffprobePath: process.env.FFPROBE_PATH,
  }, {
    evaluateGate: async () => ({
      ok: true,
      approvedOutputPath: mediaFile,
      approvedOutputHash: mediaHash,
      approvedArtifactKind: 'candidate',
    }),
    accountInspector: async () => { accountChecks++; return [activeApprovedAccount]; },
    mediaHost: {
      uploadVideo: async () => { uploaded = true; throw new Error('not used'); },
      uploadThumbnail: async () => { throw new Error('not used'); },
      presign: async () => { throw new Error('not used'); },
    },
    publisher: async () => { published = true; return {}; },
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.refused, 'integrity');
  assert.match(outcome.reason, /private visibility/i);
  assert.equal(accountChecks, 0);
  assert.equal(uploaded, false);
  assert.equal(published, false);
});

test('candidate mediaUrl with a thumbnail is refused before account/R2/publish', async () => {
  const project = makeProject();
  let accountChecks = 0;
  let uploaded = false;
  let published = false;

  const outcome = await Z.publishToZernio({
    projectFile: project.projectFile,
    accountId: APPROVED_ACCOUNT_ID,
    mediaUrl: 'https://example.invalid/candidate.mp4',
    thumbnailFile: path.join(tmp, 'thumb.jpg'),
    title: 'RAAT KA KHAUF',
    mediaSha256: mediaHash,
    confirmPublish: 'YES',
    outputsRoot: project.outputsRoot,
    inputsRoot: project.inputsRoot,
    ffprobePath: process.env.FFPROBE_PATH,
  }, {
    evaluateGate: async () => ({
      ok: true,
      approvedOutputPath: mediaFile,
      approvedOutputHash: mediaHash,
      approvedArtifactKind: 'candidate',
    }),
    accountInspector: async () => { accountChecks++; return [activeApprovedAccount]; },
    mediaHost: {
      uploadVideo: async () => { uploaded = true; throw new Error('not used'); },
      uploadThumbnail: async () => { throw new Error('not used'); },
      presign: async () => { throw new Error('not used'); },
    },
    publisher: async () => { published = true; return {}; },
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.refused, 'integrity');
  assert.match(outcome.reason, /thumbnailFile requires/i);
  assert.equal(accountChecks, 0);
  assert.equal(uploaded, false);
  assert.equal(published, false);
});

test('candidate mediaFile must be the approved candidate path before R2 upload', async () => {
  const project = makeProject();
  const differentFile = path.join(tmp, 'different-candidate.mp4');
  fs.writeFileSync(differentFile, mediaBytes);
  const order: string[] = [];
  let uploaded = false;
  let published = false;

  const outcome = await Z.publishToZernio({
    projectFile: project.projectFile,
    accountId: APPROVED_ACCOUNT_ID,
    mediaFile: differentFile,
    title: 'RAAT KA KHAUF',
    mediaSha256: mediaHash,
    confirmPublish: 'YES',
    outputsRoot: project.outputsRoot,
    inputsRoot: project.inputsRoot,
    ffprobePath: process.env.FFPROBE_PATH,
  }, {
    evaluateGate: async () => ({
      ok: true,
      approvedOutputPath: mediaFile,
      approvedOutputHash: mediaHash,
      approvedArtifactKind: 'candidate',
    }),
    accountInspector: async () => { order.push('account'); return [activeApprovedAccount]; },
    mediaHost: {
      uploadVideo: async () => { uploaded = true; order.push('upload'); throw new Error('not used'); },
      uploadThumbnail: async () => { throw new Error('not used'); },
      presign: async () => { throw new Error('not used'); },
    },
    publisher: async () => { published = true; return {}; },
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.refused, 'integrity');
  assert.match(outcome.reason, /approved artifact path/i);
  assert.deepEqual(order, ['account']);
  assert.equal(uploaded, false);
  assert.equal(published, false);
});

test('candidate gate result without the exact mediaSha256 is refused before account/R2/publish', async () => {
  const project = makeProject();
  let accountChecks = 0;
  let uploaded = false;
  let published = false;

  const outcome = await Z.publishToZernio({
    projectFile: project.projectFile,
    accountId: APPROVED_ACCOUNT_ID,
    mediaFile,
    title: 'RAAT KA KHAUF',
    mediaSha256: '00'.repeat(32),
    confirmPublish: 'YES',
    outputsRoot: project.outputsRoot,
    inputsRoot: project.inputsRoot,
    ffprobePath: process.env.FFPROBE_PATH,
  }, {
    evaluateGate: async () => ({
      ok: true,
      approvedOutputPath: mediaFile,
      approvedOutputHash: mediaHash,
      approvedArtifactKind: 'candidate',
    }),
    accountInspector: async () => { accountChecks++; return [activeApprovedAccount]; },
    mediaHost: {
      uploadVideo: async () => { uploaded = true; throw new Error('not used'); },
      uploadThumbnail: async () => { throw new Error('not used'); },
      presign: async () => { throw new Error('not used'); },
    },
    publisher: async () => { published = true; return {}; },
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.refused, 'integrity');
  assert.match(outcome.reason, /mediaSha256/i);
  assert.equal(accountChecks, 0);
  assert.equal(uploaded, false);
  assert.equal(published, false);
});

test('account refusal occurs before R2 service construction', async () => {
  const keys = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];

  try {
    const project = makeProject();
    let published = false;
    const outcome = await Z.publishToZernio({
      projectFile: project.projectFile,
      accountId: APPROVED_ACCOUNT_ID,
      mediaFile,
      title: 'RAAT KA KHAUF',
      mediaSha256: mediaHash,
      confirmPublish: 'YES',
      outputsRoot: project.outputsRoot,
      inputsRoot: project.inputsRoot,
      ffprobePath: process.env.FFPROBE_PATH,
    }, {
      evaluateGate: async () => ({
        ok: true,
        approvedOutputPath: mediaFile,
        approvedOutputHash: mediaHash,
        approvedArtifactKind: 'candidate',
      }),
      accountInspector: async () => [],
      publisher: async () => { published = true; return {}; },
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.refused, 'account');
    assert.equal(published, false);
  } finally {
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
