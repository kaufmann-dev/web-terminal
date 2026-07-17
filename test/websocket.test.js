'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const WebSocket = require('ws');
const { createWebTerminal, normalizePublicOrigin } = require('../app');
const { SOCKET_CLOSE_CODES } = require('../terminal-session-manager');

class FakeSessionManager {
  constructor() {
    this.sessions = new Set(['main']);
    this.attachedSockets = new Set();
    this.detachedSockets = new Set();
  }

  listSessions() {
    return [...this.sessions].map((name) => ({
      name,
      attachedClients: this.attachedSockets.size > 0 ? 1 : 0,
    }));
  }

  hasSession(name) {
    return this.sessions.has(name);
  }

  createSession(name) {
    if (this.sessions.has(name)) {
      const error = new Error('duplicate');
      error.code = 'TERMINAL_SESSION_EXISTS';
      throw error;
    }
    this.sessions.add(name);
    return { name, attachedClients: 0 };
  }

  async deleteSession(name) {
    return this.sessions.delete(name);
  }

  async attachClient(name, socket) {
    if (!this.sessions.has(name)) return false;
    this.attachedSockets.add(socket);
    return true;
  }

  detachClient(name, socket) {
    this.attachedSockets.delete(socket);
    this.detachedSockets.add(socket);
    return true;
  }

  writeInput() {
    return true;
  }

  writeBinary() {
    return true;
  }

  async resize() {
    return true;
  }

  async shutdown() {}
}

function updateCookies(cookieJar, response) {
  for (const value of response.headers.getSetCookie()) {
    const [pair] = value.split(';');
    const separator = pair.indexOf('=');
    cookieJar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

function cookieHeader(cookieJar) {
  return [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function authenticate(baseUrl) {
  const cookies = new Map();
  const tokenResponse = await fetch(`${baseUrl}/csrf-token`);
  updateCookies(cookies, tokenResponse);
  const { csrfToken } = await tokenResponse.json();
  const loginResponse = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CSRF-Token': csrfToken,
      Cookie: cookieHeader(cookies),
    },
    body: JSON.stringify({ email: 'test@example.com', password: 'test-password' }),
  });
  updateCookies(cookies, loginResponse);
  assert.equal(loginResponse.status, 200);
  return { cookies, csrfToken };
}

function rejectedUpgrade(url, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once('unexpected-response', (request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once('open', () => reject(new Error('WebSocket unexpectedly opened')));
    socket.once('error', () => {});
  });
}

function openSocket(url, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function waitForClose(socket) {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
  });
}

test('WebSocket upgrades require authentication and exact same-origin', async (t) => {
  const publicOrigin = 'https://terminal.example';
  const sessionManager = new FakeSessionManager();
  const service = createWebTerminal({
    authEmail: 'test@example.com',
    authPassword: 'test-password',
    sessionSecret: 'test-session-secret-at-least-32-characters',
    publicOrigin,
    nodeEnv: 'development',
    terminalWorkdir: process.cwd(),
    terminalHome: process.cwd(),
    sessionManager,
    hashPassword: async (password) => password,
    verifyPassword: async (hash, password) => hash === password,
  });
  await service.start({ port: 0, host: '127.0.0.1' });
  t.after(() => service.stop());

  const port = service.server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws/terminal?session=main`;
  assert.equal(await rejectedUpgrade(wsUrl, { origin: publicOrigin }), 401);
  assert.equal(await rejectedUpgrade(wsUrl, {
    origin: 'https://attacker.example',
    headers: {
      'X-Forwarded-Host': 'attacker.example',
      'X-Forwarded-Proto': 'https',
    },
  }), 403);

  const { cookies, csrfToken } = await authenticate(baseUrl);
  const headers = { Cookie: cookieHeader(cookies) };
  assert.equal(await rejectedUpgrade(wsUrl, { origin: 'https://attacker.example', headers }), 403);

  const invalidSocket = await openSocket(wsUrl, { origin: publicOrigin, headers });
  const invalidClose = waitForClose(invalidSocket);
  invalidSocket.send('{not valid json');
  assert.equal((await invalidClose).code, SOCKET_CLOSE_CODES.PROTOCOL_ERROR);

  const logoutSocket = await openSocket(wsUrl, { origin: publicOrigin, headers });
  logoutSocket.send(JSON.stringify({ type: 'attach', cols: 80, rows: 24 }));
  for (let attempt = 0; attempt < 20 && sessionManager.attachedSockets.size === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(sessionManager.attachedSockets.size, 1);
  const logoutClose = waitForClose(logoutSocket);
  const logoutResponse = await fetch(`${baseUrl}/logout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CSRF-Token': csrfToken,
      Cookie: cookieHeader(cookies),
    },
  });
  assert.equal(logoutResponse.status, 200);
  assert.equal((await logoutClose).code, SOCKET_CLOSE_CODES.LOGGED_OUT);
  assert.equal(sessionManager.sessions.has('main'), true);
});

test('PUBLIC_ORIGIN accepts only normalized HTTP(S) origins', () => {
  assert.equal(normalizePublicOrigin('https://terminal.example:443/'), 'https://terminal.example');
  assert.equal(normalizePublicOrigin('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizePublicOrigin('https://terminal.example/path'), null);
  assert.equal(normalizePublicOrigin('https://user@terminal.example'), null);
  assert.equal(normalizePublicOrigin('file:///tmp/terminal'), null);
});
