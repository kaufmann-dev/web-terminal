'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const WebSocket = require('ws');
const {
  SESSION_IDLE_TTL_MS,
  createTerminalEnvironment,
  createWebTerminal,
  normalizePublicOrigin,
} = require('../app');
const { SOCKET_CLOSE_CODES } = require('../terminal-session-manager');
const {
  authenticate,
  cookieHeader,
  createFakeOpenidClient,
  oidcServiceOptions,
} = require('./oidc-test-helpers');

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

function getStoredSessions(store) {
  return new Promise((resolve, reject) => {
    store.all((err, sessions) => (err ? reject(err) : resolve(Object.values(sessions))));
  });
}

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test('WebSocket upgrades require authentication and exact same-origin', async (t) => {
  const publicOrigin = 'https://terminal.example';
  const sessionManager = new FakeSessionManager();
  const openidClient = createFakeOpenidClient();
  const service = createWebTerminal({
    ...oidcServiceOptions({ openidClient }),
    publicOrigin,
    sessionManager,
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

  const { cookies, csrfToken } = await authenticate(baseUrl, openidClient);
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
  const logout = await logoutResponse.json();
  const logoutUrl = new URL(logout.redirect);
  assert.equal(logoutUrl.origin + logoutUrl.pathname, 'https://identity.example/logout');
  assert.equal(logoutUrl.searchParams.get('id_token_hint'), 'logout-id-token');
  assert.equal(logoutUrl.searchParams.get('post_logout_redirect_uri'), `${publicOrigin}/`);
  assert.equal((await getStoredSessions(service.sessionStore)).length, 0);
  assert.ok(logoutResponse.headers.getSetCookie().some((cookie) => cookie.startsWith('terminal.sid=;')));
  assert.ok(logoutResponse.headers.getSetCookie().some((cookie) => cookie.startsWith('terminal.csrf=;')));
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

test('WebSocket input activity is debounced and heartbeat expiry closes only the client', async (t) => {
  let currentTime = 1_800_000_000_000;
  const publicOrigin = 'https://terminal.example';
  const sessionManager = new FakeSessionManager();
  const openidClient = createFakeOpenidClient();
  const service = createWebTerminal({
    ...oidcServiceOptions({ openidClient }),
    publicOrigin,
    now: () => currentTime,
    heartbeatIntervalMs: 20,
    websocketActivityDebounceMs: 1000,
    sessionManager,
  });
  await service.start({ port: 0, host: '127.0.0.1' });
  t.after(() => service.stop());

  const port = service.server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const { cookies } = await authenticate(baseUrl, openidClient);
  const initialSession = (await getStoredSessions(service.sessionStore))[0];
  const socket = await openSocket(
    `ws://127.0.0.1:${port}/ws/terminal?session=main`,
    { origin: publicOrigin, headers: { Cookie: cookieHeader(cookies) } },
  );
  socket.send(JSON.stringify({ type: 'attach', cols: 80, rows: 24 }));
  await waitFor(() => sessionManager.attachedSockets.size === 1, 'socket did not attach');
  socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await getStoredSessions(service.sessionStore))[0].lastActivityAt,
    initialSession.lastActivityAt);

  currentTime += 100;
  socket.send(JSON.stringify({ type: 'input', data: 'a' }));
  await waitFor(async () => (
    (await getStoredSessions(service.sessionStore))[0]?.lastActivityAt === currentTime
  ), 'first input activity was not persisted');
  const firstActivityAt = currentTime;

  currentTime += 1;
  socket.send(JSON.stringify({ type: 'binary', data: Buffer.from('b').toString('base64') }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await getStoredSessions(service.sessionStore))[0].lastActivityAt, firstActivityAt);

  const closePromise = waitForClose(socket);
  currentTime += SESSION_IDLE_TTL_MS;
  const closed = await closePromise;
  assert.equal(closed.code, SOCKET_CLOSE_CODES.AUTH_EXPIRED);
  assert.equal(sessionManager.sessions.has('main'), true);
  assert.equal((await getStoredSessions(service.sessionStore)).length, 0);
});

test('terminal PATH includes locally installed image commands', () => {
  const originalPath = process.env.PATH;
  process.env.PATH = '/nix/profile/bin:/usr/bin';
  try {
    const environment = createTerminalEnvironment({
      terminalHome: '/terminal-home',
      terminalWorkdir: '/terminal-workdir',
    });
    assert.deepEqual(environment.PATH.split(path.delimiter).slice(0, 4), [
      path.join(__dirname, '..', 'node_modules', '.bin'),
      '/terminal-home/.local/bin',
      '/usr/local/bin',
      '/nix/profile/bin',
    ]);
  } finally {
    process.env.PATH = originalPath;
  }
});

test('terminal environment retains Fontconfig, pins UTF-8, and removes server credentials', () => {
  const overrides = {
    LANG: 'C',
    LC_CTYPE: 'C',
    LC_ALL: 'C',
    OIDC_ISSUER_URL: 'https://identity.example/application/o/web-terminal/',
    OIDC_CLIENT_ID: 'client-id',
    OIDC_CLIENT_SECRET: 'secret-client',
    OIDC_PRIVATE_EXTENSION: 'private-value',
    SESSION_SECRET: 'secret-session',
    FONTCONFIG_FILE: '/root/.nix-profile/etc/fonts/fonts.conf',
    FONTCONFIG_PATH: '/root/.nix-profile/etc/fonts',
    LIBGL_DRIVERS_PATH: '/root/.nix-profile/lib/dri',
    XDG_DATA_DIRS: '/root/.nix-profile/share:/usr/local/share:/usr/share',
    BUILDAH_ISOLATION: 'chroot',
    _CONTAINERS_USERNS_CONFIGURED: '',
    CONTAINERS_CONF: '/etc/containers/web-terminal-containers.conf',
    CONTAINERS_STORAGE_CONF: '/etc/containers/web-terminal-storage.conf',
  };
  const originals = Object.fromEntries(
    Object.keys(overrides).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, overrides);

  try {
    const environment = createTerminalEnvironment({
      terminalHome: '/terminal-home',
      terminalWorkdir: '/terminal-workdir',
    });

    assert.equal(
      environment.FONTCONFIG_FILE,
      '/root/.nix-profile/etc/fonts/fonts.conf',
    );
    assert.equal(environment.FONTCONFIG_PATH, '/root/.nix-profile/etc/fonts');
    assert.equal(environment.LIBGL_DRIVERS_PATH, '/root/.nix-profile/lib/dri');
    assert.equal(
      environment.XDG_DATA_DIRS,
      '/root/.nix-profile/share:/usr/local/share:/usr/share',
    );
    assert.equal(environment.BUILDAH_ISOLATION, 'chroot');
    assert.equal(environment._CONTAINERS_USERNS_CONFIGURED, '');
    assert.equal(
      environment.CONTAINERS_CONF,
      '/etc/containers/web-terminal-containers.conf',
    );
    assert.equal(
      environment.CONTAINERS_STORAGE_CONF,
      '/etc/containers/web-terminal-storage.conf',
    );
    assert.equal(environment.LANG, 'C.UTF-8');
    assert.equal(environment.LC_CTYPE, 'C.UTF-8');
    assert.equal(Object.hasOwn(environment, 'LC_ALL'), false);
    assert.equal(Object.hasOwn(environment, 'OIDC_ISSUER_URL'), false);
    assert.equal(Object.hasOwn(environment, 'OIDC_CLIENT_ID'), false);
    assert.equal(Object.hasOwn(environment, 'OIDC_CLIENT_SECRET'), false);
    assert.equal(Object.hasOwn(environment, 'OIDC_PRIVATE_EXTENSION'), false);
    assert.equal(Object.hasOwn(environment, 'SESSION_SECRET'), false);
  } finally {
    for (const [name, value] of Object.entries(originals)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test('Nixpacks image provides stable GUI, rootless Podman, and terminal development tools', () => {
  const config = fs.readFileSync(path.join(__dirname, '..', 'nixpacks.toml'), 'utf8');
  const podmanInstaller = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'install-rootless-podman.sh'),
    'utf8',
  );
  const podmanStorage = fs.readFileSync(
    path.join(__dirname, '..', 'config', 'containers', 'storage.conf'),
    'utf8',
  );
  const podmanContainers = fs.readFileSync(
    path.join(__dirname, '..', 'config', 'containers', 'containers.conf'),
    'utf8',
  );
  const startupScript = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'start.sh'),
    'utf8',
  );
  const terminalBashRc = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'terminal.bashrc'),
    'utf8',
  );
  const nixPackages = config.match(/nixPkgs = \[([\s\S]*?)\n\]/)?.[1];
  const nixLibraries = config.match(/nixLibs = \[([\s\S]*?)\n\]/)?.[1];
  const aptPackages = config.match(/aptPkgs = \[([\s\S]*?)\n\]/)?.[1];

  assert.ok(nixPackages);
  assert.ok(nixLibraries);
  assert.ok(aptPackages);
  assert.match(
    config,
    /^FONTCONFIG_FILE = "\/root\/\.nix-profile\/etc\/fonts\/fonts\.conf"$/m,
  );
  assert.match(config, /^FONTCONFIG_PATH = "\/root\/\.nix-profile\/etc\/fonts"$/m);
  assert.match(config, /^LIBGL_DRIVERS_PATH = "\/root\/\.nix-profile\/lib\/dri"$/m);
  assert.match(
    config,
    /^XDG_DATA_DIRS = "\/root\/\.nix-profile\/share:\/usr\/local\/share:\/usr\/share"$/m,
  );
  assert.match(nixPackages, /^\s*"fontconfig\.out",$/m);
  assert.match(nixPackages, /^\s*"mesa\.drivers",$/m);
  assert.match(nixPackages, /^\s*"uv",$/m);
  assert.doesNotMatch(nixPackages, /^\s*"nixpacks",$/m);
  for (const library of [
    'libxkbcommon',
    'mesa.drivers',
    'vulkan-loader',
    'xorg.libX11',
    'xorg.libXcursor',
    'xorg.libXi',
    'xorg.libXrandr',
  ]) {
    assert.match(nixLibraries, new RegExp(`^\\s*"${library.replace('.', '\\.')}"[,]$`, 'm'));
  }
  for (const rootlessPodmanPackage of [
    'fuse-overlayfs',
    'passt',
    'podman',
    'uidmap',
  ]) {
    assert.match(
      aptPackages,
      new RegExp(`^\\s*"${rootlessPodmanPackage}",$`, 'm'),
    );
  }
  assert.match(
    config,
    /^\s*"bash scripts\/install-rootless-podman\.sh",$/m,
  );
  assert.match(
    config,
    /^\s*"bash scripts\/install-nixpacks\.sh",$/m,
  );
  assert.match(podmanInstaller, /^\s*remove_subid_ranges \/etc\/subuid$/m);
  assert.match(podmanInstaller, /^\s*remove_subid_ranges \/etc\/subgid$/m);
  assert.match(podmanInstaller, /^\s*usermod --groups "" "\$TERMINAL_USER"$/m);
  assert.doesNotMatch(podmanInstaller, /SUBID_(?:START|COUNT)/);
  assert.match(podmanStorage, /^ignore_chown_errors = "true"$/m);
  assert.match(podmanContainers, /^\[network\]$/m);
  assert.match(
    podmanContainers,
    /^default_rootless_network_cmd = "pasta"$/m,
  );
  assert.match(
    startupScript,
    /podman info --format '\{\{\.Host\.Pasta\.Executable\}\}'/,
  );
  assert.match(
    startupScript,
    /Rootless Podman must configure pasta as its default network command\./,
  );
  assert.match(startupScript, /\[\[ ! -c \/dev\/net\/tun \]\]/);
  assert.match(
    startupScript,
    /unshare --mount --pid --fork/,
  );
  assert.match(
    startupScript,
    /Nested proc mounts are blocked; add --security-opt systempaths=unconfined to Coolify Custom Docker Options\./,
  );
  assert.match(
    startupScript,
    /Rootless Podman did not detect an executable pasta network helper\./,
  );
  assert.match(
    startupScript,
    /^configure_rootless_podman_environment\(\) \{[\s\S]*?^}$/m,
  );
  assert.match(startupScript, /^\s*export BUILDAH_ISOLATION=chroot$/m);
  assert.match(startupScript, /^\s*export _CONTAINERS_USERNS_CONFIGURED=$/m);
  assert.match(
    startupScript,
    /^\s*export CONTAINERS_CONF="\$PODMAN_CONTAINERS_CONF"$/m,
  );
  assert.match(
    startupScript,
    /^\s*export CONTAINERS_STORAGE_CONF="\$PODMAN_STORAGE_CONF"$/m,
  );
  assert.match(
    startupScript,
    /if is_container_environment; then\s+configure_rootless_podman_environment\s+validate_rootless_podman\s+fi/,
  );
  assert.doesNotMatch(terminalBashRc, /\/etc\/bash\.bashrc/);
  assert.match(terminalBashRc, /^\s*source "\$HOME\/\.bashrc"$/m);
  assert.doesNotMatch(config, /\/nix\/store\//);
});
