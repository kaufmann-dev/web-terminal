'use strict';

require('dotenv').config();

const http = require('http');
const path = require('path');
const express = require('express');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const cookieParser = require('cookie-parser');
const { doubleCsrf } = require('csrf-csrf');
const helmet = require('helmet');
const compression = require('compression');
const { WebSocketServer } = require('ws');
const {
  IMAGE_TYPES,
  MAX_CLIPBOARD_IMAGE_BYTES,
  ClipboardImageStore,
  ClipboardImageValidationError,
} = require('./clipboard-image-store');
const {
  DuplicateTerminalSessionError,
  SOCKET_CLOSE_CODES,
  TerminalSessionManager,
  isValidTerminalSize,
} = require('./terminal-session-manager');

const TERMINAL_SESSION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_WEBSOCKET_PAYLOAD = 1024 * 1024;
const ATTACH_TIMEOUT_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;
const OIDC_TRANSACTION_TTL_MS = 10 * 60 * 1000;
const SESSION_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const WEBSOCKET_ACTIVITY_DEBOUNCE_MS = 15000;

function isValidTerminalSessionName(name) {
  return typeof name === 'string' && TERMINAL_SESSION_NAME_PATTERN.test(name);
}

function createTerminalEnvironment({
  terminalHome,
  terminalWorkdir,
  fontconfigFile = process.env.FONTCONFIG_FILE,
  fontconfigPath = process.env.FONTCONFIG_PATH,
}) {
  const terminalEnvironment = {
    ...process.env,
    HOME: terminalHome,
    LANG: 'C.UTF-8',
    LC_CTYPE: 'C.UTF-8',
    XDG_CONFIG_HOME: path.join(terminalHome, '.config'),
    XDG_DATA_HOME: path.join(terminalHome, '.local', 'share'),
    XDG_CACHE_HOME: path.join(terminalHome, '.cache'),
    PATH: [
      path.join(__dirname, 'node_modules', '.bin'),
      path.join(terminalHome, '.local', 'bin'),
      '/usr/local/bin',
      process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    ].join(path.delimiter),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    EDITOR: process.env.EDITOR || 'micro',
    VISUAL: process.env.VISUAL || 'micro',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    AGENT_BROWSER_CONTENT_BOUNDARIES: '1',
    TERMINAL_WORKDIR: terminalWorkdir,
    TERMINAL_HOME: terminalHome,
  };

  if (fontconfigFile) {
    terminalEnvironment.FONTCONFIG_FILE = fontconfigFile;
  } else {
    delete terminalEnvironment.FONTCONFIG_FILE;
  }
  if (fontconfigPath) {
    terminalEnvironment.FONTCONFIG_PATH = fontconfigPath;
  } else {
    delete terminalEnvironment.FONTCONFIG_PATH;
  }

  delete terminalEnvironment.OIDC_ISSUER_URL;
  delete terminalEnvironment.OIDC_CLIENT_ID;
  delete terminalEnvironment.OIDC_CLIENT_SECRET;
  delete terminalEnvironment.OIDC_ALLOWED_SUBJECT;
  delete terminalEnvironment.SESSION_SECRET;
  delete terminalEnvironment.LC_ALL;
  return terminalEnvironment;
}

function normalizeIssuerUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  try {
    const url = new URL(value.trim());
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username
      || url.password
      || url.search
      || url.hash) {
      return null;
    }
    return url.href;
  } catch (err) {
    return null;
  }
}

function getApplicationSessionDeadline(authSession) {
  if (!authSession || !Number.isFinite(authSession.loginAt)
    || !Number.isFinite(authSession.lastActivityAt)) {
    return null;
  }
  return Math.min(
    authSession.lastActivityAt + SESSION_IDLE_TTL_MS,
    authSession.loginAt + SESSION_ABSOLUTE_TTL_MS,
  );
}

function isApplicationSessionActive(authSession, now) {
  const deadline = getApplicationSessionDeadline(authSession);
  return Boolean(authSession && authSession.authenticated && deadline !== null && now < deadline);
}

function applyApplicationSessionDeadline(authSession) {
  const deadline = getApplicationSessionDeadline(authSession);
  if (deadline === null || !authSession.cookie) {
    return null;
  }
  authSession.cookie.expires = new Date(deadline);
  return deadline;
}

function saveRequestSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

function regenerateRequestSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

function normalizePublicOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  try {
    const url = new URL(value.trim());
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash) {
      return null;
    }
    return url.origin;
  } catch (err) {
    return null;
  }
}

function hasExactSameOrigin(req, publicOrigin) {
  const origin = req.headers.origin;
  return typeof origin === 'string' && origin === publicOrigin;
}

function rejectUpgrade(socket, statusCode, message) {
  const statusText = http.STATUS_CODES[statusCode] || 'Error';
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n`
    + 'Connection: close\r\n'
    + 'Content-Type: text/plain; charset=utf-8\r\n'
    + `Content-Length: ${Buffer.byteLength(body)}\r\n`
    + '\r\n'
    + body,
  );
}

function isStrictBase64(value) {
  return value.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function createWebTerminal(options = {}) {
  const configuredPublicOrigin = options.publicOrigin ?? process.env.PUBLIC_ORIGIN;
  const configuredIssuerUrl = options.oidcIssuerUrl ?? process.env.OIDC_ISSUER_URL;
  const config = {
    oidcIssuerUrl: normalizeIssuerUrl(configuredIssuerUrl),
    oidcClientId: options.oidcClientId ?? process.env.OIDC_CLIENT_ID,
    oidcClientSecret: options.oidcClientSecret ?? process.env.OIDC_CLIENT_SECRET,
    oidcAllowedSubject: options.oidcAllowedSubject ?? process.env.OIDC_ALLOWED_SUBJECT,
    sessionSecret: options.sessionSecret ?? process.env.SESSION_SECRET,
    publicOrigin: normalizePublicOrigin(configuredPublicOrigin),
    terminalWorkdir: options.terminalWorkdir ?? process.env.TERMINAL_WORKDIR ?? '/code',
    terminalHome: options.terminalHome
      ?? process.env.TERMINAL_HOME
      ?? process.env.TERMINAL_WORKDIR
      ?? '/code',
    nodeEnv: options.nodeEnv ?? process.env.NODE_ENV ?? 'production',
    port: options.port ?? Number(process.env.PORT || 3000),
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
    websocketActivityDebounceMs:
      options.websocketActivityDebounceMs ?? WEBSOCKET_ACTIVITY_DEBOUNCE_MS,
    clipboardImageDirectory: options.clipboardImageDirectory
      ?? path.join(
        options.terminalHome
          ?? process.env.TERMINAL_HOME
          ?? process.env.TERMINAL_WORKDIR
          ?? '/code',
        '.cache',
        'web-terminal',
        'clipboard-images',
      ),
  };

  if (!configuredIssuerUrl || !config.oidcClientId || !config.oidcClientSecret
    || !config.oidcAllowedSubject || !config.sessionSecret || !configuredPublicOrigin) {
    throw new Error(
      'Missing required environment variables: OIDC_ISSUER_URL, OIDC_CLIENT_ID, '
      + 'OIDC_CLIENT_SECRET, OIDC_ALLOWED_SUBJECT, SESSION_SECRET, PUBLIC_ORIGIN',
    );
  }
  if (!config.oidcIssuerUrl) {
    throw new Error('OIDC_ISSUER_URL must be an HTTP(S) URL without credentials, query, or fragment.');
  }
  if (!config.publicOrigin) {
    throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin without a path, query, or fragment.');
  }
  if (!path.isAbsolute(config.terminalWorkdir) || !path.isAbsolute(config.terminalHome)) {
    throw new Error('TERMINAL_WORKDIR and TERMINAL_HOME must be absolute paths.');
  }

  const terminalEnvironment = createTerminalEnvironment(config);
  const clipboardImageStore = options.clipboardImageStore || new ClipboardImageStore({
    directory: config.clipboardImageDirectory,
  });
  const sessionManager = options.sessionManager || new TerminalSessionManager({
    terminalEnvironment,
    terminalWorkdir: config.terminalWorkdir,
    bashRcPath: path.join(__dirname, 'scripts', 'terminal.bashrc'),
  });
  const now = options.now || Date.now;
  const suppliedOpenidClient = options.openidClient;
  let openidClient;
  let oidcConfiguration;

  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'"],
        fontSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(compression());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  const sessionStore = new MemoryStore({
    checkPeriod: 60 * 60 * 1000,
    max: 1000,
    ttl: (_storeOptions, storedSession) => {
      const applicationDeadline = getApplicationSessionDeadline(storedSession);
      const transactionDeadline = storedSession?.oidcTransaction
        ? storedSession.oidcTransaction.createdAt + OIDC_TRANSACTION_TTL_MS
        : null;
      const deadline = applicationDeadline ?? transactionDeadline;
      return Number.isFinite(deadline) ? Math.max(1, deadline - now()) : 1;
    },
  });
  // Passive requests must not move the store deadline. Interactive activity
  // explicitly saves the session with its recalculated cookie expiry.
  sessionStore.touch = undefined;
  const sessionMiddleware = session({
    name: 'terminal.sid',
    secret: config.sessionSecret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'Lax',
    },
  });
  app.use(sessionMiddleware);
  app.use(cookieParser());

  const {
    doubleCsrfProtection,
    generateCsrfToken,
    invalidCsrfTokenError,
  } = doubleCsrf({
    getSecret: () => config.sessionSecret,
    getSessionIdentifier: (req) => req.session.id,
    cookieName: 'terminal.csrf',
    cookieOptions: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.nodeEnv === 'production',
      path: '/',
    },
    getCsrfTokenFromRequest: (req) => req.headers['csrf-token'],
  });

  const loginSockets = new Map();

  function trackLoginSocket(loginSessionId, socket) {
    let sockets = loginSockets.get(loginSessionId);
    if (!sockets) {
      sockets = new Set();
      loginSockets.set(loginSessionId, sockets);
    }
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      if (sockets.size === 0) {
        loginSockets.delete(loginSessionId);
      }
    });
  }

  function closeLoginSockets(loginSessionId, code, reason) {
    const sockets = loginSockets.get(loginSessionId);
    if (!sockets) {
      return;
    }
    for (const socket of sockets) {
      if (socket.readyState === 0 || socket.readyState === 1) {
        socket.skipActivityFlush = true;
        socket.close(code, reason);
      }
    }
  }

  function destroyRequestLogin(req, callback = () => {}) {
    const loginSessionId = req.sessionID;
    closeLoginSockets(loginSessionId, SOCKET_CLOSE_CODES.AUTH_EXPIRED, 'Authentication expired.');
    req.session.destroy((err) => callback(err));
  }

  function recordHttpActivity(req) {
    const activityAt = now();
    if (!isApplicationSessionActive(req.session, activityAt)) {
      return false;
    }
    req.session.lastActivityAt = activityAt;
    applyApplicationSessionDeadline(req.session);
    return true;
  }

  app.use((req, res, next) => {
    if (req.session) {
      req.session.touch = () => req.session;
    }
    if (!req.session || !req.session.authenticated
      || isApplicationSessionActive(req.session, now())) {
      next();
      return;
    }
    destroyRequestLogin(req, (err) => {
      if (err) {
        next(err);
        return;
      }
      next();
    });
  });

  app.use('/static', express.static(path.join(__dirname, 'public')));

  function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
      return next();
    }
    return res.redirect('/');
  }

  function requireApiAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
      return next();
    }
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const xtermEntry = require.resolve('@xterm/xterm');
  const fitEntry = require.resolve('@xterm/addon-fit');
  const interEntry = require.resolve('@fontsource/inter');
  const jetBrainsMonoEntry = require.resolve('@fontsource/jetbrains-mono');
  const xtermModule = path.join(path.dirname(xtermEntry), 'xterm.mjs');
  const fitModule = path.join(path.dirname(fitEntry), 'addon-fit.mjs');
  const xtermStylesheet = path.join(path.dirname(path.dirname(xtermEntry)), 'css', 'xterm.css');
  const fontFiles = new Map([
    ['inter-400.woff2', path.join(path.dirname(interEntry), 'files', 'inter-latin-400-normal.woff2')],
    ['inter-500.woff2', path.join(path.dirname(interEntry), 'files', 'inter-latin-500-normal.woff2')],
    ['inter-600.woff2', path.join(path.dirname(interEntry), 'files', 'inter-latin-600-normal.woff2')],
    [
      'jetbrains-mono-400.woff2',
      path.join(path.dirname(jetBrainsMonoEntry), 'files', 'jetbrains-mono-latin-400-normal.woff2'),
    ],
    [
      'jetbrains-mono-600.woff2',
      path.join(path.dirname(jetBrainsMonoEntry), 'files', 'jetbrains-mono-latin-600-normal.woff2'),
    ],
  ]);

  for (const [fileName, filePath] of fontFiles) {
    app.get(`/vendor/fonts/${fileName}`, (req, res) => {
      res.type('font/woff2').sendFile(filePath);
    });
  }

  app.get('/vendor/xterm/xterm.mjs', requireAuth, (req, res) => res.sendFile(xtermModule));
  app.get('/vendor/xterm/addon-fit.mjs', requireAuth, (req, res) => res.sendFile(fitModule));
  app.get('/vendor/xterm/xterm.css', requireAuth, (req, res) => res.sendFile(xtermStylesheet));

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/', (req, res) => {
    if (req.session && req.session.authenticated) {
      return res.redirect('/terminal');
    }
    return res.sendFile(path.join(__dirname, 'views', 'login.html'));
  });

  app.get('/login', async (req, res) => {
    if (req.session && req.session.authenticated) {
      return res.redirect('/terminal');
    }
    try {
      const codeVerifier = openidClient.randomPKCECodeVerifier();
      const codeChallenge = await openidClient.calculatePKCECodeChallenge(codeVerifier);
      const transaction = {
        codeVerifier,
        state: openidClient.randomState(),
        nonce: openidClient.randomNonce(),
        createdAt: now(),
      };
      req.session.oidcTransaction = transaction;
      req.session.cookie.expires = new Date(transaction.createdAt + OIDC_TRANSACTION_TTL_MS);
      await saveRequestSession(req);
      const authorizationUrl = openidClient.buildAuthorizationUrl(oidcConfiguration, {
        redirect_uri: `${config.publicOrigin}/auth/callback`,
        scope: 'openid',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state: transaction.state,
        nonce: transaction.nonce,
      });
      return res.redirect(authorizationUrl.href);
    } catch (err) {
      console.error('OIDC authorization initialization error:', err.message);
      return res.status(503).send('Unable to start sign-in.');
    }
  });

  app.get('/auth/callback', async (req, res) => {
    const transaction = req.session && req.session.oidcTransaction;
    if (!transaction || typeof transaction !== 'object'
      || !Number.isFinite(transaction.createdAt)
      || now() - transaction.createdAt >= OIDC_TRANSACTION_TTL_MS
      || now() < transaction.createdAt) {
      if (transaction) {
        await new Promise((resolve) => req.session.destroy(() => resolve()));
      }
      return res.status(400).send('Invalid or expired sign-in transaction.');
    }

    delete req.session.oidcTransaction;
    try {
      await saveRequestSession(req);
    } catch (err) {
      console.error('OIDC transaction invalidation error:', err.message);
      return res.status(500).send('Unable to complete sign-in.');
    }

    let tokens;
    try {
      const callbackUrl = new URL(req.originalUrl, config.publicOrigin);
      tokens = await openidClient.authorizationCodeGrant(oidcConfiguration, callbackUrl, {
        pkceCodeVerifier: transaction.codeVerifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
      });
    } catch (err) {
      console.error('OIDC callback validation error:', err.message);
      return res.status(400).send('Invalid sign-in response.');
    }

    const claims = tokens.claims();
    const metadata = oidcConfiguration.serverMetadata();
    if (!claims || typeof tokens.id_token !== 'string') {
      return res.status(400).send('The identity provider did not return a valid ID token.');
    }
    if (claims.iss !== metadata.issuer || claims.sub !== config.oidcAllowedSubject) {
      await new Promise((resolve) => req.session.destroy(() => resolve()));
      return res.status(403).send('This identity is not allowed to access the terminal.');
    }

    try {
      await regenerateRequestSession(req);
      req.session.touch = () => req.session;
      const loginAt = now();
      req.session.authenticated = true;
      req.session.issuer = claims.iss;
      req.session.subject = claims.sub;
      req.session.loginAt = loginAt;
      req.session.lastActivityAt = loginAt;
      req.session.idToken = tokens.id_token;
      applyApplicationSessionDeadline(req.session);
      await saveRequestSession(req);
      return res.redirect('/terminal');
    } catch (err) {
      console.error('Application session creation error:', err.message);
      return res.status(500).send('Unable to complete sign-in.');
    } finally {
      tokens = undefined;
    }
  });

  app.get('/csrf-token', requireApiAuth, (req, res) => {
    req.session.csrfInitialized = true;
    res.json({ csrfToken: generateCsrfToken(req, res) });
  });

  app.get('/api/terminal-sessions', requireApiAuth, (req, res) => {
    res.json({ sessions: sessionManager.listSessions() });
  });

  app.post('/api/terminal-sessions', requireApiAuth, doubleCsrfProtection, (req, res) => {
    const { name } = req.body || {};
    if (!isValidTerminalSessionName(name)) {
      return res.status(400).json({
        error: 'Session names must be 1-32 lowercase letters, numbers, or hyphens.',
      });
    }

    try {
      const terminalSession = sessionManager.createSession(name);
      recordHttpActivity(req);
      return res.status(201).json({ session: terminalSession });
    } catch (err) {
      if (err instanceof DuplicateTerminalSessionError
        || err.code === 'TERMINAL_SESSION_EXISTS') {
        return res.status(409).json({ error: 'A session with that name already exists.' });
      }
      console.error('Terminal session service error:', err.message);
      return res.status(503).json({ error: 'Terminal session service unavailable.' });
    }
  });

  app.post(
    '/api/clipboard-images',
    requireApiAuth,
    doubleCsrfProtection,
    express.raw({
      type: Object.keys(IMAGE_TYPES),
      limit: MAX_CLIPBOARD_IMAGE_BYTES,
    }),
    async (req, res) => {
      const contentType = (req.get('content-type') || '').split(';', 1)[0].toLowerCase();
      if (!IMAGE_TYPES[contentType]) {
        return res.status(415).json({ error: 'Use a PNG, JPEG, or WebP clipboard image.' });
      }
      try {
        const imagePath = await clipboardImageStore.save(req.body, contentType);
        recordHttpActivity(req);
        return res.status(201).json({ path: imagePath });
      } catch (err) {
        if (err instanceof ClipboardImageValidationError
          || err.code === 'INVALID_CLIPBOARD_IMAGE') {
          return res.status(415).json({ error: err.message });
        }
        console.error('Clipboard image storage error:', err.message);
        return res.status(503).json({ error: 'Clipboard image storage unavailable.' });
      }
    },
  );

  app.delete(
    '/api/terminal-sessions/:name',
    requireApiAuth,
    doubleCsrfProtection,
    async (req, res) => {
      const { name } = req.params;
      if (!isValidTerminalSessionName(name)) {
        return res.status(400).json({ error: 'Invalid terminal session name.' });
      }

      try {
        if (!(await sessionManager.deleteSession(name))) {
          return res.status(404).json({ error: 'Terminal session not found.' });
        }
        recordHttpActivity(req);
        return res.status(204).end();
      } catch (err) {
        console.error('Terminal session service error:', err.message);
        return res.status(503).json({ error: 'Terminal session service unavailable.' });
      }
    },
  );

  app.get('/terminal', requireAuth, (req, res) => {
    recordHttpActivity(req);
    res.sendFile(path.join(__dirname, 'views', 'terminal.html'));
  });

  app.post('/logout', requireAuth, doubleCsrfProtection, (req, res) => {
    const loginSessionId = req.sessionID;
    const idToken = req.session.idToken;
    const logoutUrl = openidClient.buildEndSessionUrl(oidcConfiguration, {
      id_token_hint: idToken,
      post_logout_redirect_uri: `${config.publicOrigin}/`,
    });
    closeLoginSockets(loginSessionId, SOCKET_CLOSE_CODES.LOGGED_OUT, 'Logged out.');
    req.session.destroy((err) => {
      if (err) {
        console.error('Session destruction error:', err);
        return res.status(500).json({ error: 'Logout failed.' });
      }
      const cookieOptions = {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.nodeEnv === 'production',
        path: '/',
      };
      res.clearCookie('terminal.sid', cookieOptions);
      res.clearCookie('terminal.csrf', cookieOptions);
      return res.json({ success: true, redirect: logoutUrl.href });
    });
  });

  app.use((err, req, res, next) => {
    if (err === invalidCsrfTokenError) {
      return res.status(403).json({ error: 'Invalid CSRF token.' });
    }
    if (err && err.type === 'entity.too.large' && req.path === '/api/clipboard-images') {
      return res.status(413).json({ error: 'Clipboard image exceeds the 10 MiB limit.' });
    }
    return next(err);
  });

  let server;
  let webSocketServer;
  let heartbeatInterval;
  let stoppingPromise;

  function closeWithProtocolError(socket, message) {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify({ type: 'error', message }));
      socket.close(SOCKET_CLOSE_CODES.PROTOCOL_ERROR, message);
    }
  }

  function persistSocketActivity(socket) {
    if (!socket.activityPending || socket.skipActivityFlush) {
      return;
    }
    socket.activityPending = false;
    socket.lastActivityPersistedAt = now();
    sessionStore.get(socket.loginSessionId, (getError, storedSession) => {
      if (getError || !storedSession || !storedSession.authenticated) {
        if (socket.readyState === 0 || socket.readyState === 1) {
          socket.close(SOCKET_CLOSE_CODES.AUTH_EXPIRED, 'Authentication expired.');
        }
        return;
      }
      storedSession.lastActivityAt = Math.max(
        storedSession.lastActivityAt || 0,
        socket.authSession.lastActivityAt,
      );
      applyApplicationSessionDeadline(storedSession);
      socket.authSession = storedSession;
      sessionStore.set(socket.loginSessionId, storedSession, (setError) => {
        if (setError) {
          console.error('WebSocket activity persistence error:', setError.message);
        }
      });
    });
  }

  function expireSocketAuthentication(socket) {
    socket.skipActivityFlush = true;
    sessionStore.destroy(socket.loginSessionId, () => {});
    socket.close(SOCKET_CLOSE_CODES.AUTH_EXPIRED, 'Authentication expired.');
  }

  function recordSocketActivity(socket, activityAt) {
    if (!isApplicationSessionActive(socket.authSession, activityAt)) {
      expireSocketAuthentication(socket);
      return false;
    }
    socket.authSession.lastActivityAt = activityAt;
    applyApplicationSessionDeadline(socket.authSession);
    socket.activityPending = true;
    const elapsed = activityAt - socket.lastActivityPersistedAt;
    if (!socket.lastActivityPersistedAt || elapsed >= config.websocketActivityDebounceMs) {
      persistSocketActivity(socket);
      return true;
    }
    if (!socket.activityTimer) {
      socket.activityTimer = setTimeout(() => {
        socket.activityTimer = null;
        persistSocketActivity(socket);
      }, config.websocketActivityDebounceMs - elapsed);
      socket.activityTimer.unref();
    }
    return true;
  }

  function handleTerminalSocket(socket, request, sessionName, loginSessionId, authSession) {
    socket.isAlive = true;
    socket.loginSessionId = loginSessionId;
    socket.authSession = authSession;
    socket.lastActivityPersistedAt = 0;
    socket.activityPending = false;
    socket.activityTimer = null;
    socket.skipActivityFlush = false;
    trackLoginSocket(loginSessionId, socket);
    socket.on('pong', () => {
      socket.isAlive = true;
    });

    let attached = false;
    let attaching = false;
    const attachTimer = setTimeout(() => {
      if (!attached) {
        closeWithProtocolError(socket, 'Terminal attachment timed out.');
      }
    }, ATTACH_TIMEOUT_MS);

    socket.on('message', async (rawData, isBinary) => {
      if (isBinary) {
        closeWithProtocolError(socket, 'Binary client frames are not accepted.');
        return;
      }

      let message;
      try {
        message = JSON.parse(rawData.toString('utf8'));
      } catch (err) {
        closeWithProtocolError(socket, 'Invalid terminal message.');
        return;
      }

      if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
        closeWithProtocolError(socket, 'Invalid terminal message.');
        return;
      }

      if (!attached) {
        if (attaching || message.type !== 'attach' || !isValidTerminalSize(message.cols, message.rows)) {
          closeWithProtocolError(socket, 'A valid attach message is required first.');
          return;
        }

        attaching = true;
        try {
          attached = await sessionManager.attachClient(
            sessionName,
            socket,
            loginSessionId,
            message.cols,
            message.rows,
          );
          if (!attached) {
            socket.close(SOCKET_CLOSE_CODES.SESSION_ENDED, 'Terminal session no longer exists.');
            return;
          }
          clearTimeout(attachTimer);
        } catch (err) {
          console.error('Terminal attachment error:', err.message);
          closeWithProtocolError(socket, 'Unable to attach terminal.');
        } finally {
          attaching = false;
        }
        return;
      }

      if (message.type === 'input' && typeof message.data === 'string') {
        const activityAt = now();
        if (!isApplicationSessionActive(socket.authSession, activityAt)) {
          expireSocketAuthentication(socket);
          return;
        }
        if (!sessionManager.writeInput(sessionName, socket, message.data)) {
          closeWithProtocolError(socket, 'Terminal is not attached.');
        } else {
          recordSocketActivity(socket, activityAt);
        }
        return;
      }

      if (message.type === 'binary'
        && typeof message.data === 'string'
        && isStrictBase64(message.data)) {
        const activityAt = now();
        if (!isApplicationSessionActive(socket.authSession, activityAt)) {
          expireSocketAuthentication(socket);
          return;
        }
        const data = Buffer.from(message.data, 'base64');
        if (!sessionManager.writeBinary(sessionName, socket, data)) {
          closeWithProtocolError(socket, 'Terminal is not attached.');
        } else {
          recordSocketActivity(socket, activityAt);
        }
        return;
      }

      if (message.type === 'resize' && isValidTerminalSize(message.cols, message.rows)) {
        try {
          if (!(await sessionManager.resize(sessionName, socket, message.cols, message.rows))) {
            closeWithProtocolError(socket, 'Terminal is not attached.');
          }
        } catch (err) {
          console.error('Terminal resize error:', err.message);
          closeWithProtocolError(socket, 'Unable to resize terminal.');
        }
        return;
      }

      closeWithProtocolError(socket, 'Invalid terminal message.');
    });

    socket.on('close', () => {
      clearTimeout(attachTimer);
      clearTimeout(socket.activityTimer);
      socket.activityTimer = null;
      persistSocketActivity(socket);
      sessionManager.detachClient(sessionName, socket);
    });
  }

  async function start(startOptions = {}) {
    if (server) {
      return server;
    }

    await clipboardImageStore.initialize();
    openidClient = suppliedOpenidClient || await import('openid-client');
    oidcConfiguration = await openidClient.discovery(
      new URL(config.oidcIssuerUrl),
      config.oidcClientId,
      config.oidcClientSecret,
    );
    const oidcMetadata = oidcConfiguration.serverMetadata();
    if (typeof oidcMetadata.issuer !== 'string'
      || new URL(oidcMetadata.issuer).href !== config.oidcIssuerUrl) {
      throw new Error('OIDC discovery metadata issuer does not match OIDC_ISSUER_URL.');
    }
    const requiredEndpoints = [
      ['authorization_endpoint', oidcMetadata.authorization_endpoint],
      ['token_endpoint', oidcMetadata.token_endpoint],
      ['end_session_endpoint', oidcMetadata.end_session_endpoint],
    ];
    for (const [name, endpoint] of requiredEndpoints) {
      if (typeof endpoint !== 'string' || !endpoint) {
        throw new Error(`OIDC discovery metadata is missing ${name}.`);
      }
      try {
        const endpointUrl = new URL(endpoint);
        if (endpointUrl.protocol !== 'https:' && endpointUrl.protocol !== 'http:') {
          throw new Error('unsupported protocol');
        }
      } catch (err) {
        throw new Error(`OIDC discovery metadata has an invalid ${name}.`);
      }
    }
    server = http.createServer(app);
    webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_WEBSOCKET_PAYLOAD,
      perMessageDeflate: false,
    });

    server.on('upgrade', (req, socket, head) => {
      let url;
      try {
        url = new URL(req.url, 'http://web-terminal.invalid');
      } catch (err) {
        rejectUpgrade(socket, 400, 'Invalid WebSocket URL.');
        return;
      }
      if (url.pathname !== '/ws/terminal') {
        rejectUpgrade(socket, 404, 'WebSocket endpoint not found.');
        return;
      }
      if (!hasExactSameOrigin(req, config.publicOrigin)) {
        rejectUpgrade(socket, 403, 'WebSocket origin rejected.');
        return;
      }

      sessionMiddleware(req, {}, () => {
        const upgradeAt = now();
        if (!req.session || !isApplicationSessionActive(req.session, upgradeAt)) {
          if (req.session && req.session.authenticated) {
            closeLoginSockets(req.sessionID, SOCKET_CLOSE_CODES.AUTH_EXPIRED, 'Authentication expired.');
            req.session.destroy(() => {});
          }
          rejectUpgrade(socket, 401, 'Authentication required.');
          return;
        }

        const sessionName = url.searchParams.get('session');
        if (!isValidTerminalSessionName(sessionName)) {
          rejectUpgrade(socket, 400, 'Invalid terminal session name.');
          return;
        }
        if (!sessionManager.hasSession(sessionName)) {
          rejectUpgrade(socket, 404, 'Terminal session not found.');
          return;
        }

        webSocketServer.handleUpgrade(req, socket, head, (webSocket) => {
          handleTerminalSocket(webSocket, req, sessionName, req.sessionID, req.session);
        });
      });
    });

    heartbeatInterval = setInterval(() => {
      for (const socket of webSocketServer.clients) {
        if (!socket.isAlive) {
          socket.terminate();
          continue;
        }
        socket.isAlive = false;
        socket.ping();
        sessionStore.get(socket.loginSessionId, (err, storedSession) => {
          if (!err && storedSession && socket.activityPending) {
            storedSession.lastActivityAt = Math.max(
              storedSession.lastActivityAt || 0,
              socket.authSession.lastActivityAt || 0,
            );
            applyApplicationSessionDeadline(storedSession);
          }
          if (err || !isApplicationSessionActive(storedSession, now())) {
            socket.skipActivityFlush = true;
            sessionStore.destroy(socket.loginSessionId, () => {});
            if (socket.readyState === 0 || socket.readyState === 1) {
              socket.close(SOCKET_CLOSE_CODES.AUTH_EXPIRED, 'Authentication expired.');
            }
          } else {
            socket.authSession = storedSession;
          }
        });
      }
    }, config.heartbeatIntervalMs);
    heartbeatInterval.unref();

    const port = startOptions.port ?? config.port;
    const host = startOptions.host;
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    return server;
  }

  async function stop() {
    if (stoppingPromise) {
      return stoppingPromise;
    }
    stoppingPromise = (async () => {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
      }
      await sessionManager.shutdown();
      if (webSocketServer) {
        for (const socket of webSocketServer.clients) {
          if (socket.readyState === 0 || socket.readyState === 1) {
            socket.close(1012, 'Server shutting down.');
          }
        }
        webSocketServer.close();
      }
      if (server && server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
    })();
    return stoppingPromise;
  }

  return {
    app,
    config,
    sessionManager,
    sessionStore,
    start,
    stop,
    get server() {
      return server;
    },
  };
}

async function main() {
  let service;
  try {
    service = createWebTerminal();
    const server = await service.start();
    console.log(`web-terminal listening on port ${server.address().port}`);
  } catch (err) {
    console.error('Failed to initialize web-terminal:', err.message);
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      await service.stop();
      process.exit(0);
    } catch (err) {
      console.error('Failed to shut down web-terminal:', err.message);
      process.exit(1);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main();
}

module.exports = {
  ATTACH_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  MAX_WEBSOCKET_PAYLOAD,
  OIDC_TRANSACTION_TTL_MS,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  TERMINAL_SESSION_NAME_PATTERN,
  WEBSOCKET_ACTIVITY_DEBOUNCE_MS,
  applyApplicationSessionDeadline,
  createTerminalEnvironment,
  createWebTerminal,
  getApplicationSessionDeadline,
  hasExactSameOrigin,
  isApplicationSessionActive,
  isStrictBase64,
  isValidTerminalSessionName,
  normalizeIssuerUrl,
  normalizePublicOrigin,
};
