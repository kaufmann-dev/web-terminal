'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  OIDC_TRANSACTION_TTL_MS,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  createWebTerminal,
  getApplicationSessionDeadline,
  isApplicationSessionActive,
  normalizeIssuerUrl,
} = require('../app');
const {
  DEFAULT_ISSUER,
  DEFAULT_SUBJECT,
  authenticate,
  cookieHeader,
  createFakeOpenidClient,
  oidcServiceOptions,
  updateCookies,
} = require('./oidc-test-helpers');

async function allStoredSessions(store) {
  const sessions = await new Promise((resolve, reject) => {
    store.all((err, result) => (err ? reject(err) : resolve(result)));
  });
  return Object.values(sessions);
}

async function onlyStoredSession(store) {
  const sessions = await allStoredSessions(store);
  assert.equal(sessions.length, 1);
  return sessions[0];
}

async function startService(t, overrides = {}) {
  const service = createWebTerminal({
    ...oidcServiceOptions(),
    sessionManager: {
      listSessions: () => [],
      shutdown: async () => {},
      ...overrides.sessionManager,
    },
    ...overrides,
  });
  await service.start({ port: 0, host: '127.0.0.1' });
  t.after(() => service.stop());
  return {
    service,
    baseUrl: `http://127.0.0.1:${service.server.address().port}`,
  };
}

test('OIDC issuer URLs are exact HTTP(S) discovery issuers', () => {
  assert.equal(normalizeIssuerUrl(DEFAULT_ISSUER), DEFAULT_ISSUER);
  assert.equal(normalizeIssuerUrl('https://identity.example/issuer?tenant=one'), null);
  assert.equal(normalizeIssuerUrl('https://user@identity.example/issuer'), null);
  assert.equal(normalizeIssuerUrl('file:///issuer'), null);
});

test('startup discovers OIDC metadata and requires login and logout endpoints', async (t) => {
  const openidClient = createFakeOpenidClient();
  const { service } = await startService(t, { openidClient });
  assert.deepEqual(openidClient.calls.discovery, [{
    issuer: DEFAULT_ISSUER,
    clientId: 'test-client',
    clientSecret: 'test-client-secret',
  }]);
  assert.ok(service.server.listening);

  for (const endpoint of ['authorization_endpoint', 'token_endpoint', 'end_session_endpoint']) {
    const incompatibleClient = createFakeOpenidClient({ metadata: { [endpoint]: undefined } });
    const incompatibleService = createWebTerminal(oidcServiceOptions({
      openidClient: incompatibleClient,
    }));
    await assert.rejects(
      incompatibleService.start({ port: 0, host: '127.0.0.1' }),
      new RegExp(`missing ${endpoint}`),
    );
  }
});

test('authorization uses openid-only PKCE, state, nonce, and one-time transactions', async (t) => {
  let currentTime = 1_800_000_000_000;
  const openidClient = createFakeOpenidClient();
  const { baseUrl } = await startService(t, { openidClient, now: () => currentTime });
  const cookies = new Map();

  const loginResponse = await fetch(`${baseUrl}/login`, { redirect: 'manual' });
  updateCookies(cookies, loginResponse);
  assert.equal(loginResponse.status, 302);
  const authorizationUrl = new URL(loginResponse.headers.get('location'));
  assert.equal(authorizationUrl.searchParams.get('scope'), 'openid');
  assert.equal(authorizationUrl.searchParams.has('offline_access'), false);
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorizationUrl.searchParams.get('code_challenge'), 'challenge-verifier-1');
  assert.equal(authorizationUrl.searchParams.get('state'), 'state-1');
  assert.equal(authorizationUrl.searchParams.get('nonce'), 'nonce-1');
  assert.equal(
    authorizationUrl.searchParams.get('redirect_uri'),
    'https://terminal.example/auth/callback',
  );

  const badState = await fetch(`${baseUrl}/auth/callback?code=code&state=wrong`, {
    headers: { Cookie: cookieHeader(cookies) },
  });
  assert.equal(badState.status, 400);
  const replay = await fetch(`${baseUrl}/auth/callback?code=code&state=state-1`, {
    headers: { Cookie: cookieHeader(cookies) },
  });
  assert.equal(replay.status, 400);

  const secondLogin = await fetch(`${baseUrl}/login`, {
    headers: { Cookie: cookieHeader(cookies) },
    redirect: 'manual',
  });
  updateCookies(cookies, secondLogin);
  currentTime += OIDC_TRANSACTION_TTL_MS;
  const expired = await fetch(`${baseUrl}/auth/callback?code=code&state=state-2`, {
    headers: { Cookie: cookieHeader(cookies) },
  });
  assert.equal(expired.status, 400);
});

test('callback regenerates the session and admits only the exact issuer-scoped subject', async (t) => {
  const openidClient = createFakeOpenidClient();
  const { service, baseUrl } = await startService(t, { openidClient });
  const cookies = new Map();
  const loginResponse = await fetch(`${baseUrl}/login`, { redirect: 'manual' });
  updateCookies(cookies, loginResponse);
  const transactionSessionId = cookies.get('terminal.sid');
  const authorizationUrl = new URL(loginResponse.headers.get('location'));

  const callbackResponse = await fetch(
    `${baseUrl}/auth/callback?code=code&state=${authorizationUrl.searchParams.get('state')}`,
    { headers: { Cookie: cookieHeader(cookies) }, redirect: 'manual' },
  );
  updateCookies(cookies, callbackResponse);
  assert.equal(callbackResponse.status, 302);
  assert.notEqual(cookies.get('terminal.sid'), transactionSessionId);
  assert.equal(openidClient.calls.grants[0].checks.pkceCodeVerifier, 'verifier-1');
  assert.equal(openidClient.calls.grants[0].checks.expectedState, 'state-1');
  assert.equal(openidClient.calls.grants[0].checks.expectedNonce, 'nonce-1');

  const storedSession = await onlyStoredSession(service.sessionStore);
  assert.equal(storedSession.issuer, DEFAULT_ISSUER);
  assert.equal(storedSession.subject, DEFAULT_SUBJECT);
  assert.equal(storedSession.idToken, 'logout-id-token');
  assert.equal(Object.hasOwn(storedSession, 'access_token'), false);
  assert.equal(Object.hasOwn(storedSession, 'refresh_token'), false);
  assert.equal(JSON.stringify(storedSession).includes('discarded-access-token'), false);
  assert.equal(JSON.stringify(storedSession).includes('discarded-refresh-token'), false);
  const sessionCookie = callbackResponse.headers.getSetCookie()
    .find((cookie) => cookie.startsWith('terminal.sid='));
  const cookieExpiry = /Expires=([^;]+)/.exec(sessionCookie)[1];
  assert.equal(
    new Date(cookieExpiry).getTime(),
    Math.floor(new Date(storedSession.cookie.expires).getTime() / 1000) * 1000,
  );

  const deniedClient = createFakeOpenidClient({ subject: 'different-user' });
  const denied = await startService(t, { openidClient: deniedClient });
  const deniedCookies = new Map();
  const deniedLogin = await fetch(`${denied.baseUrl}/login`, { redirect: 'manual' });
  updateCookies(deniedCookies, deniedLogin);
  const deniedAuthorization = new URL(deniedLogin.headers.get('location'));
  const deniedCallback = await fetch(
    `${denied.baseUrl}/auth/callback?code=code&state=${deniedAuthorization.searchParams.get('state')}`,
    { headers: { Cookie: cookieHeader(deniedCookies) }, redirect: 'manual' },
  );
  assert.equal(deniedCallback.status, 403);
  assert.equal((await allStoredSessions(denied.service.sessionStore)).length, 0);
});

test('interactive HTTP activity extends idle expiry but passive requests do not', async (t) => {
  let currentTime = 1_800_000_000_000;
  const openidClient = createFakeOpenidClient();
  const { service, baseUrl } = await startService(t, {
    openidClient,
    now: () => currentTime,
  });
  const { cookies } = await authenticate(baseUrl, openidClient);
  const loginSession = await onlyStoredSession(service.sessionStore);
  assert.equal(loginSession.loginAt, currentTime);
  assert.equal(loginSession.lastActivityAt, currentTime);
  assert.equal(
    new Date(loginSession.cookie.expires).getTime(),
    currentTime + SESSION_IDLE_TTL_MS,
  );

  currentTime += 23 * 60 * 60 * 1000;
  const csrfResponse = await fetch(`${baseUrl}/csrf-token`, {
    headers: { Cookie: cookieHeader(cookies) },
  });
  assert.equal(csrfResponse.status, 200);
  const afterPassiveRequest = await onlyStoredSession(service.sessionStore);
  assert.equal(afterPassiveRequest.lastActivityAt, loginSession.lastActivityAt);

  const terminalResponse = await fetch(`${baseUrl}/terminal`, {
    headers: { Cookie: cookieHeader(cookies) },
  });
  assert.equal(terminalResponse.status, 200);
  updateCookies(cookies, terminalResponse);
  const afterNavigation = await onlyStoredSession(service.sessionStore);
  assert.equal(afterNavigation.lastActivityAt, currentTime);
  assert.equal(
    new Date(afterNavigation.cookie.expires).getTime(),
    currentTime + SESSION_IDLE_TTL_MS,
  );

  const absoluteDeadline = loginSession.loginAt + SESSION_ABSOLUTE_TTL_MS;
  while (currentTime + (23 * 60 * 60 * 1000) < absoluteDeadline - (60 * 60 * 1000)) {
    currentTime += 23 * 60 * 60 * 1000;
    const keepAliveNavigation = await fetch(`${baseUrl}/terminal`, {
      headers: { Cookie: cookieHeader(cookies) },
    });
    assert.equal(keepAliveNavigation.status, 200);
    updateCookies(cookies, keepAliveNavigation);
  }
  currentTime = loginSession.loginAt + SESSION_ABSOLUTE_TTL_MS - (60 * 60 * 1000);
  const finalNavigation = await fetch(`${baseUrl}/terminal`, {
    headers: { Cookie: cookieHeader(cookies) },
  });
  assert.equal(finalNavigation.status, 200);
  const cappedSession = await onlyStoredSession(service.sessionStore);
  assert.equal(
    new Date(cappedSession.cookie.expires).getTime(),
    loginSession.loginAt + SESSION_ABSOLUTE_TTL_MS,
  );
});

test('accepted terminal-session mutations count as interactive activity', async (t) => {
  let currentTime = 1_800_000_000_000;
  const names = new Set();
  const sessionManager = {
    listSessions: () => [...names].map((name) => ({ name, attachedClients: 0 })),
    createSession: (name) => {
      names.add(name);
      return { name, attachedClients: 0 };
    },
    deleteSession: async (name) => names.delete(name),
    shutdown: async () => {},
  };
  const openidClient = createFakeOpenidClient();
  const { service, baseUrl } = await startService(t, {
    openidClient,
    now: () => currentTime,
    sessionManager,
  });
  const { cookies, csrfToken } = await authenticate(baseUrl, openidClient);

  currentTime += 1000;
  const createResponse = await fetch(`${baseUrl}/api/terminal-sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CSRF-Token': csrfToken,
      Cookie: cookieHeader(cookies),
    },
    body: JSON.stringify({ name: 'work' }),
  });
  assert.equal(createResponse.status, 201);
  assert.equal((await onlyStoredSession(service.sessionStore)).lastActivityAt, currentTime);

  currentTime += 1000;
  const pollResponse = await fetch(`${baseUrl}/api/terminal-sessions`, {
    headers: { Cookie: cookieHeader(cookies) },
  });
  assert.equal(pollResponse.status, 200);
  assert.equal((await onlyStoredSession(service.sessionStore)).lastActivityAt, currentTime - 1000);

  currentTime += 1000;
  const deleteResponse = await fetch(`${baseUrl}/api/terminal-sessions/work`, {
    method: 'DELETE',
    headers: {
      'CSRF-Token': csrfToken,
      Cookie: cookieHeader(cookies),
    },
  });
  assert.equal(deleteResponse.status, 204);
  assert.equal((await onlyStoredSession(service.sessionStore)).lastActivityAt, currentTime);
});

test('idle and absolute deadlines invalidate local authorization', async (t) => {
  const base = 1_800_000_000_000;
  assert.equal(isApplicationSessionActive({
    authenticated: true,
    loginAt: base,
    lastActivityAt: base,
  }, base + SESSION_IDLE_TTL_MS - 1), true);
  assert.equal(isApplicationSessionActive({
    authenticated: true,
    loginAt: base,
    lastActivityAt: base,
  }, base + SESSION_IDLE_TTL_MS), false);
  assert.equal(getApplicationSessionDeadline({
    loginAt: base,
    lastActivityAt: base + SESSION_ABSOLUTE_TTL_MS - 1,
  }), base + SESSION_ABSOLUTE_TTL_MS);

  let currentTime = base;
  const openidClient = createFakeOpenidClient();
  const { service, baseUrl } = await startService(t, {
    openidClient,
    now: () => currentTime,
  });
  const { cookies } = await authenticate(baseUrl, openidClient);
  currentTime += SESSION_IDLE_TTL_MS;
  const expiredResponse = await fetch(`${baseUrl}/csrf-token`, {
    headers: { Cookie: cookieHeader(cookies) },
  });
  assert.equal(expiredResponse.status, 401);
  assert.equal((await allStoredSessions(service.sessionStore)).length, 0);
});
