// Read-only Zernio account inspection. Offline only: no real credentials and no network calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { SRC } from './_testPaths.mjs';

const Z = await import(pathToFileURL(`${SRC}/zernio.ts`).href);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

test('parses the documented accounts shape and redacts everything except safe fields', () => {
  const accounts = Z.parseZernioAccountsResponse({
    accounts: [
      {
        _id: 'yt-123',
        platform: 'YouTube',
        profileId: { _id: 'profile-1', name: 'Private profile' },
        username: 'secret-channel-handle',
        displayName: 'Raat Ka Khauf',
        profileUrl: 'https://youtube.com/@secret',
        isActive: true,
        accessToken: 'SECRET_ACCESS_TOKEN',
        refreshToken: 'SECRET_REFRESH_TOKEN',
        apiKey: 'SECRET_API_KEY',
      },
      {
        _id: 'ig-456',
        platform: 'instagram',
        username: 'insta-handle',
        isActive: false,
      },
    ],
    hasAnalyticsAccess: true,
  });

  assert.deepEqual(accounts, [
    { platform: 'youtube', accountId: 'yt-123', displayName: 'Raat Ka Khauf', isActive: true },
    { platform: 'instagram', accountId: 'ig-456', displayName: 'insta-handle', isActive: false },
  ]);
  assert.deepEqual(Object.keys(accounts[0]).sort(), ['accountId', 'displayName', 'isActive', 'platform']);

  const serialized = JSON.stringify(accounts);
  for (const forbidden of [
    'SECRET_ACCESS_TOKEN',
    'SECRET_REFRESH_TOKEN',
    'SECRET_API_KEY',
    'accessToken',
    'refreshToken',
    'apiKey',
    'profileId',
    'profileUrl',
    'username',
    'hasAnalyticsAccess',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `output leaked ${forbidden}`);
  }
});

test('supports array responses and safely skips malformed accounts', () => {
  const accounts = Z.parseZernioAccountsResponse([
    { _id: 'yt-1', platform: 'YouTube' },
    null,
    'not-an-object',
    { _id: '', platform: 'youtube' },
    { _id: 'missing-platform' },
    { accountId: 'fb-1', type: 'Facebook', displayName: 42 },
  ]);

  assert.deepEqual(accounts, [
    { platform: 'youtube', accountId: 'yt-1', displayName: null, isActive: null },
    { platform: 'facebook', accountId: 'fb-1', displayName: null, isActive: null },
  ]);
});

test('unexpected response shapes fail safely without returning the body', () => {
  let message = '';
  assert.throws(
    () => Z.parseZernioAccountsResponse({ accounts: 'not-an-array', secret: 'SECRET_RAW_BODY' }),
    (error: unknown) => {
      message = messageOf(error);
      return /unexpected response shape/i.test(message);
    },
  );
  assert.equal(message.includes('SECRET_RAW_BODY'), false);

  assert.throws(
    () => Z.parseZernioAccountsResponse(null),
    /unexpected response shape/i,
  );
});

test('inspection performs one GET /accounts request with no body', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      accounts: [{
        _id: 'yt-123',
        platform: 'youtube',
        displayName: 'Raat Ka Khauf',
        accessToken: 'SECRET_RAW_BODY',
      }],
      hasAnalyticsAccess: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const accounts = await Z.inspectZernioAccounts({
    apiKey: 'local-test-key',
    platform: ' YouTube ',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://zernio.com/api/v1/accounts?platform=youtube');
  assert.equal(calls[0].init?.method, 'GET');
  assert.equal('body' in (calls[0].init ?? {}), false);
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer local-test-key');
  assert.deepEqual(accounts, [
    { platform: 'youtube', accountId: 'yt-123', displayName: 'Raat Ka Khauf', isActive: null },
  ]);

  const serialized = JSON.stringify(accounts);
  assert.equal(serialized.includes('SECRET_RAW_BODY'), false);
  assert.equal(serialized.includes('local-test-key'), false);
});

test('inspection without a platform still uses only GET /accounts', async () => {
  let seenUrl = '';
  const fetchImpl = async (url: string): Promise<Response> => {
    seenUrl = url;
    return new Response(JSON.stringify({ accounts: [] }), { status: 200 });
  };

  const accounts = await Z.inspectZernioAccounts({ apiKey: 'local-test-key', fetchImpl });

  assert.equal(seenUrl, 'https://zernio.com/api/v1/accounts');
  assert.deepEqual(accounts, []);
});

test('missing credentials fail before any request is made', async () => {
  let called = false;
  await assert.rejects(
    () => Z.inspectZernioAccounts({
      apiKey: '   ',
      fetchImpl: async () => {
        called = true;
        return new Response('{}', { status: 200 });
      },
    }),
    /ZERNIO_API_KEY/,
  );
  assert.equal(called, false);
});

test('HTTP errors are sanitized and never include the response body or key', async () => {
  const fetchImpl = async (): Promise<Response> => new Response('SECRET_RAW_BODY', { status: 401 });
  let message = '';
  await assert.rejects(
    () => Z.inspectZernioAccounts({ apiKey: 'super-secret-key', fetchImpl }),
    (error: unknown) => {
      message = messageOf(error);
      return /HTTP 401/i.test(message);
    },
  );
  assert.equal(message.includes('SECRET_RAW_BODY'), false);
  assert.equal(message.includes('super-secret-key'), false);
});

test('invalid JSON is reported without echoing the body', async () => {
  const fetchImpl = async (): Promise<Response> => new Response('SECRET_RAW_BODY', { status: 200 });
  let message = '';
  await assert.rejects(
    () => Z.inspectZernioAccounts({ apiKey: 'local-test-key', fetchImpl }),
    (error: unknown) => {
      message = messageOf(error);
      return /invalid JSON response/i.test(message);
    },
  );
  assert.equal(message.includes('SECRET_RAW_BODY'), false);
});

test('network failures are sanitized and never echo credentials', async () => {
  const fetchImpl = async (): Promise<Response> => {
    throw new Error('SECRET_NETWORK_DETAIL');
  };
  let message = '';
  await assert.rejects(
    () => Z.inspectZernioAccounts({ apiKey: 'super-secret-key', fetchImpl }),
    (error: unknown) => {
      message = messageOf(error);
      return /network error/i.test(message);
    },
  );
  assert.equal(message.includes('SECRET_NETWORK_DETAIL'), false);
  assert.equal(message.includes('super-secret-key'), false);
});

test('unexpected account-list response shapes are sanitized', async () => {
  const fetchImpl = async (): Promise<Response> => new Response(
    JSON.stringify({ accounts: 'not-an-array', secret: 'SECRET_RAW_BODY' }),
    { status: 200 },
  );
  let message = '';
  await assert.rejects(
    () => Z.inspectZernioAccounts({ apiKey: 'local-test-key', fetchImpl }),
    (error: unknown) => {
      message = messageOf(error);
      return /unexpected response shape/i.test(message);
    },
  );
  assert.equal(message.includes('SECRET_RAW_BODY'), false);
});

test('successful publisher response parsing never echoes an invalid body', () => {
  assert.deepEqual(Z.parseZernioJsonResponse('{"ok":true}'), { ok: true });
  assert.deepEqual(Z.parseZernioJsonResponse(''), {});

  let message = '';
  try {
    Z.parseZernioJsonResponse('{"token":"SECRET_RAW_BODY"');
  } catch (error) {
    message = messageOf(error);
  }
  assert.match(message, /invalid JSON response/i);
  assert.equal(message.includes('SECRET_RAW_BODY'), false);
});

test('connect response summaries expose shape only, never values or URLs', () => {
  const summary = Z.summarizeConnectResponse({
    access_token: 'SECRET_ACCESS_TOKEN',
    url: 'https://example.invalid/oauth?state=SECRET_STATE&X-Amz-Signature=SECRET_SIGNATURE',
    nested: { refreshToken: 'SECRET_REFRESH_TOKEN' },
  });
  const serialized = JSON.stringify(summary);

  assert.deepEqual(summary.response_keys, ['access_token', 'nested', 'url']);
  assert.equal(summary.write_operation, false);
  assert.equal(summary.response_received, true);
  assert.equal(serialized.includes('SECRET_ACCESS_TOKEN'), false);
  assert.equal(serialized.includes('SECRET_STATE'), false);
  assert.equal(serialized.includes('SECRET_SIGNATURE'), false);
  assert.equal(serialized.includes('SECRET_REFRESH_TOKEN'), false);
});
