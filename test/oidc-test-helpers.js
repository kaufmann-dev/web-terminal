'use strict';

const assert = require('node:assert/strict');

const DEFAULT_ISSUER = 'https://identity.example/application/o/web-terminal/';
const DEFAULT_SUBJECT = 'allowed-user-uuid';

function updateCookies(cookieJar, response) {
  for (const value of response.headers.getSetCookie()) {
    const [pair] = value.split(';');
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    const cookieValue = pair.slice(separator + 1);
    if (cookieValue) {
      cookieJar.set(name, cookieValue);
    } else {
      cookieJar.delete(name);
    }
  }
}

function cookieHeader(cookieJar) {
  return [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; ');
}

function createFakeOpenidClient(options = {}) {
  const calls = {
    discovery: [],
    authorization: [],
    grants: [],
    logout: [],
  };
  let sequence = 0;
  const metadata = {
    issuer: options.issuer || DEFAULT_ISSUER,
    authorization_endpoint: 'https://identity.example/authorize',
    token_endpoint: 'https://identity.example/token',
    end_session_endpoint: 'https://identity.example/logout',
    ...options.metadata,
  };
  const configuration = { serverMetadata: () => metadata };

  return {
    calls,
    configuration,
    async discovery(issuer, clientId, clientSecret) {
      calls.discovery.push({ issuer: issuer.href, clientId, clientSecret });
      if (options.discoveryError) throw options.discoveryError;
      return configuration;
    },
    randomPKCECodeVerifier() {
      sequence += 1;
      return `verifier-${sequence}`;
    },
    async calculatePKCECodeChallenge(verifier) {
      return `challenge-${verifier}`;
    },
    randomState() {
      return `state-${sequence}`;
    },
    randomNonce() {
      return `nonce-${sequence}`;
    },
    buildAuthorizationUrl(receivedConfiguration, parameters) {
      assert.equal(receivedConfiguration, configuration);
      calls.authorization.push({ ...parameters });
      const url = new URL(metadata.authorization_endpoint);
      url.search = new URLSearchParams({
        client_id: 'test-client',
        response_type: 'code',
        ...parameters,
      });
      return url;
    },
    async authorizationCodeGrant(receivedConfiguration, currentUrl, checks) {
      assert.equal(receivedConfiguration, configuration);
      calls.grants.push({ currentUrl, checks: { ...checks } });
      if (options.grantError) throw options.grantError;
      if (currentUrl.searchParams.get('state') !== checks.expectedState) {
        throw new Error('state mismatch');
      }
      const claims = options.claims || {
        iss: metadata.issuer,
        sub: options.subject || DEFAULT_SUBJECT,
        nonce: checks.expectedNonce,
      };
      return {
        access_token: 'discarded-access-token',
        refresh_token: 'discarded-refresh-token',
        id_token: options.idToken || 'logout-id-token',
        claims: () => claims,
      };
    },
    buildEndSessionUrl(receivedConfiguration, parameters) {
      assert.equal(receivedConfiguration, configuration);
      calls.logout.push({ ...parameters });
      const url = new URL(metadata.end_session_endpoint);
      url.search = new URLSearchParams({ client_id: 'test-client', ...parameters });
      return url;
    },
  };
}

function oidcServiceOptions(overrides = {}) {
  return {
    oidcIssuerUrl: DEFAULT_ISSUER,
    oidcClientId: 'test-client',
    oidcClientSecret: 'test-client-secret',
    oidcAllowedSubject: DEFAULT_SUBJECT,
    sessionSecret: 'test-session-secret-at-least-32-characters',
    publicOrigin: 'https://terminal.example',
    nodeEnv: 'development',
    terminalWorkdir: process.cwd(),
    terminalHome: process.cwd(),
    openidClient: createFakeOpenidClient(),
    clipboardImageStore: { initialize: async () => {} },
    ...overrides,
  };
}

async function authenticate(baseUrl, openidClient, cookies = new Map()) {
  const loginResponse = await fetch(`${baseUrl}/login`, {
    headers: { Cookie: cookieHeader(cookies) },
    redirect: 'manual',
  });
  updateCookies(cookies, loginResponse);
  assert.equal(loginResponse.status, 302);
  const authorizationUrl = new URL(loginResponse.headers.get('location'));
  const callbackResponse = await fetch(
    `${baseUrl}/auth/callback?code=test-code&state=${encodeURIComponent(authorizationUrl.searchParams.get('state'))}`,
    {
      headers: { Cookie: cookieHeader(cookies) },
      redirect: 'manual',
    },
  );
  updateCookies(cookies, callbackResponse);
  assert.equal(callbackResponse.status, 302);
  assert.equal(callbackResponse.headers.get('location'), '/terminal');

  const tokenResponse = await fetch(`${baseUrl}/csrf-token`, {
    headers: { Cookie: cookieHeader(cookies) },
  });
  updateCookies(cookies, tokenResponse);
  assert.equal(tokenResponse.status, 200);
  const { csrfToken } = await tokenResponse.json();
  return { cookies, csrfToken, authorizationUrl, openidClient };
}

module.exports = {
  DEFAULT_ISSUER,
  DEFAULT_SUBJECT,
  authenticate,
  cookieHeader,
  createFakeOpenidClient,
  oidcServiceOptions,
  updateCookies,
};
