// Read-only YouTube preflight. Offline only: fake account inspector, temp allowlists, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import { SRC } from './_testPaths.mjs';

const P = await import(pathToFileURL(`${SRC}/youtubePreflight.ts`).href);

const PROJECT_ID = 'youtube-automation-2-20261003160855-2740';
const ACCOUNT_ID = '6ae2401339a3d63e1238c167';
const DISPLAY_NAME = 'RAAT KA KHAUF';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-preflight-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function writeAllowlist(name: string, projects: Record<string, unknown>): string {
  const file = path.join(tmp, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, projects }, null, 2));
  return file;
}

const validAllowlist = writeAllowlist('valid', {
  [PROJECT_ID]: { accountId: ACCOUNT_ID, displayName: DISPLAY_NAME },
});

const activeAccount = {
  platform: 'youtube',
  accountId: ACCOUNT_ID,
  displayName: DISPLAY_NAME,
  isActive: true,
};

async function run(
  overrides: Record<string, unknown> = {},
  inspectAccounts: (input: { platform: 'youtube' }) => Promise<any[]> = async () => [activeAccount],
) {
  return P.runYouTubePreflight({
    projectId: PROJECT_ID,
    platform: 'youtube',
    allowlistPath: validAllowlist,
    inspectAccounts,
    ...overrides,
  });
}

test('accepts the exact active allowlisted account', async () => {
  let calls = 0;
  let received: unknown;
  const result = await run({}, async (input: { platform: 'youtube' }) => {
    calls++;
    received = input;
    return [activeAccount];
  });

  assert.deepEqual(result, {
    projectId: PROJECT_ID,
    platform: 'youtube',
    accountId: ACCOUNT_ID,
    displayName: DISPLAY_NAME,
    active: true,
    preflight: 'PASS',
  });
  assert.equal(calls, 1);
  assert.deepEqual(received, { platform: 'youtube' });
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('wrong account ID fails closed without exposing the other account', async () => {
  const result = await run({}, async () => [{
    ...activeAccount,
    accountId: 'different-youtube-account',
    displayName: 'DIFFERENT CHANNEL',
  }]);

  assert.equal(result.preflight, 'FAIL');
  assert.equal(result.reason, 'ACCOUNT_ID_MISMATCH');
  assert.equal(result.accountId, ACCOUNT_ID);
  assert.equal(result.displayName, DISPLAY_NAME);
  assert.equal(result.active, null);
  assert.equal(JSON.stringify(result).includes('DIFFERENT CHANNEL'), false);
  assert.equal(JSON.stringify(result).includes('different-youtube-account'), false);
});

test('missing live account fails closed', async () => {
  const result = await run({}, async () => []);
  assert.equal(result.preflight, 'FAIL');
  assert.equal(result.reason, 'ACCOUNT_MISSING');
  assert.equal(result.accountId, ACCOUNT_ID);
  assert.equal(result.active, null);
});

test('same ID on a non-YouTube platform fails closed', async () => {
  const result = await run({}, async () => [{ ...activeAccount, platform: 'instagram' }]);
  assert.equal(result.preflight, 'FAIL');
  assert.equal(result.reason, 'WRONG_PLATFORM');
  assert.equal(result.active, null);
});

test('display-name mismatch fails closed', async () => {
  const result = await run({}, async () => [{ ...activeAccount, displayName: 'OTHER CHANNEL' }]);
  assert.equal(result.preflight, 'FAIL');
  assert.equal(result.reason, 'DISPLAY_NAME_MISMATCH');
  assert.equal(result.displayName, DISPLAY_NAME);
  assert.equal(result.active, null);
});

test('inactive account fails closed and reports inactive', async () => {
  const result = await run({}, async () => [{ ...activeAccount, isActive: false }]);
  assert.equal(result.preflight, 'FAIL');
  assert.equal(result.reason, 'ACCOUNT_INACTIVE');
  assert.equal(result.active, false);
});

test('unknown active state fails closed', async () => {
  const result = await run({}, async () => [{ ...activeAccount, isActive: null }]);
  assert.equal(result.preflight, 'FAIL');
  assert.equal(result.reason, 'UNKNOWN_ACCOUNT_STATE');
  assert.equal(result.active, null);
});

test('unsupported requested platform fails before the account API call', async () => {
  let called = false;
  const result = await run({ platform: 'instagram' }, async () => {
    called = true;
    return [activeAccount];
  });

  assert.equal(result.preflight, 'FAIL');
  assert.equal(result.reason, 'UNSUPPORTED_PLATFORM');
  assert.equal(called, false);
});

test('missing project entry fails before the account API call', async () => {
  const otherAllowlist = writeAllowlist('other-project', {
    'some-other-project': { accountId: ACCOUNT_ID, displayName: DISPLAY_NAME },
  });
  let called = false;
  const result = await run({ allowlistPath: otherAllowlist }, async () => {
    called = true;
    return [activeAccount];
  });

  assert.equal(result.preflight, 'FAIL');
  assert.equal(result.reason, 'MISSING_PROJECT_ENTRY');
  assert.equal(result.accountId, null);
  assert.equal(result.displayName, null);
  assert.equal(called, false);
});

test('malformed allowlist fails closed before the account API call', async () => {
  const badJson = path.join(tmp, 'invalid-json.json');
  fs.writeFileSync(badJson, '{"schema_version":1,"projects":');

  const badSchema = path.join(tmp, 'invalid-schema.json');
  fs.writeFileSync(badSchema, JSON.stringify({
    schema_version: 2,
    projects: { [PROJECT_ID]: { accountId: ACCOUNT_ID, displayName: DISPLAY_NAME } },
  }));

  for (const allowlistPath of [badJson, badSchema]) {
    let called = false;
    const result = await run({ allowlistPath }, async () => {
      called = true;
      return [activeAccount];
    });
    assert.equal(result.preflight, 'FAIL');
    assert.equal(result.reason, 'MALFORMED_ALLOWLIST');
    assert.equal(result.accountId, null);
    assert.equal(called, false);
  }
});

test('account API failure is sanitized and never echoes the error', async () => {
  const result = await run({}, async () => {
    throw new Error('SECRET_RAW_API_BODY_AND_URL https://private.example/?X-Amz-Signature=SECRET');
  });

  assert.equal(result.preflight, 'FAIL');
  assert.equal(result.reason, 'ACCOUNT_API_FAILURE');
  assert.equal(result.accountId, ACCOUNT_ID);
  assert.equal(result.active, null);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('SECRET_RAW_API_BODY_AND_URL'), false);
  assert.equal(serialized.includes('private.example'), false);
  assert.equal(serialized.includes('X-Amz-Signature'), false);
});

test('CLI output exposes exactly the six approved fields and a safe result code', async () => {
  const passed = await run();
  const passedOutput = P.toYouTubePreflightOutput(passed);
  assert.deepEqual(Object.keys(passedOutput).sort(), [
    'accountId', 'active', 'displayName', 'platform', 'preflight', 'projectId',
  ]);
  assert.equal(passedOutput.preflight, 'PASS');

  const failed = await run({}, async () => [{ ...activeAccount, isActive: false }]);
  const failedOutput = P.toYouTubePreflightOutput(failed);
  assert.deepEqual(Object.keys(failedOutput).sort(), [
    'accountId', 'active', 'displayName', 'platform', 'preflight', 'projectId',
  ]);
  assert.equal(failedOutput.preflight, 'FAIL_ACCOUNT_INACTIVE');
  assert.equal(JSON.stringify(failedOutput).includes('"reason"'), false);
});

test('preflight module has no R2, media, publisher, or OAuth dependencies', () => {
  const source = fs.readFileSync(path.join(SRC, 'youtubePreflight.ts'), 'utf8');
  assert.equal(/from\s+['"][^'"]*(?:r2Media|zernio|flow|login)[^'"]*['"]/.test(source), false);
  assert.equal(/@aws-sdk|createR2MediaService|uploadVideo|uploadThumbnail|presign|\/posts|connect\/youtube/.test(source), false);
});

test('zernio CLI wires preflight to the existing read-only account inspector only', () => {
  const source = fs.readFileSync(path.join(SRC, 'zernio.ts'), 'utf8');
  assert.equal(source.includes("command === 'preflight'"), true);
  assert.equal(source.includes('inspectAccounts: inspectZernioAccounts'), true);
});
