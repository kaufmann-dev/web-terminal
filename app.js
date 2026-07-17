'use strict';

require('dotenv').config();

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { doubleCsrf } = require('csrf-csrf');
const helmet = require('helmet');
const compression = require('compression');
const argon2 = require('argon2');
const { WebSocketServer } = require('ws');
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

function isValidTerminalSessionName(name) {
  return typeof name === 'string' && TERMINAL_SESSION_NAME_PATTERN.test(name);
}

function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    const maxLen = Math.max(bufA.length, bufB.length);
    const padA = Buffer.alloc(maxLen);
    const padB = Buffer.alloc(maxLen);
    bufA.copy(padA);
    bufB.copy(padB);
    return crypto.timingSafeEqual(padA, padB) && false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function createTerminalEnvironment({ terminalHome, terminalWorkdir }) {
  const terminalEnvironment = {
    ...process.env,
    HOME: terminalHome,
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

  delete terminalEnvironment.AUTH_EMAIL;
  delete terminalEnvironment.AUTH_PASSWORD;
  delete terminalEnvironment.SESSION_SECRET;
  return terminalEnvironment;
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
  const config = {
    authEmail: options.authEmail ?? process.env.AUTH_EMAIL,
    authPassword: options.authPassword ?? process.env.AUTH_PASSWORD,
    sessionSecret: options.sessionSecret ?? process.env.SESSION_SECRET,
    publicOrigin: normalizePublicOrigin(configuredPublicOrigin),
    terminalWorkdir: options.terminalWorkdir ?? process.env.TERMINAL_WORKDIR ?? '/code',
    terminalHome: options.terminalHome
      ?? process.env.TERMINAL_HOME
      ?? process.env.TERMINAL_WORKDIR
      ?? '/code',
    nodeEnv: options.nodeEnv ?? process.env.NODE_ENV ?? 'production',
    port: options.port ?? Number(process.env.PORT || 3000),
  };

  if (!config.authEmail || !config.authPassword || !config.sessionSecret || !configuredPublicOrigin) {
    throw new Error(
      'Missing required environment variables: AUTH_EMAIL, AUTH_PASSWORD, SESSION_SECRET, PUBLIC_ORIGIN',
    );
  }
  if (!config.publicOrigin) {
    throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin without a path, query, or fragment.');
  }
  if (!path.isAbsolute(config.terminalWorkdir) || !path.isAbsolute(config.terminalHome)) {
    throw new Error('TERMINAL_WORKDIR and TERMINAL_HOME must be absolute paths.');
  }

  const terminalEnvironment = createTerminalEnvironment(config);
  const sessionManager = options.sessionManager || new TerminalSessionManager({
    terminalEnvironment,
    terminalWorkdir: config.terminalWorkdir,
    bashRcPath: path.join(__dirname, 'scripts', 'terminal.bashrc'),
  });
  const hashPassword = options.hashPassword || ((password) => argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  }));
  const verifyPassword = options.verifyPassword || argon2.verify;

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
  });
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
      maxAge: 24 * 60 * 60 * 1000,
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

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: 'Too many login attempts. Please try again later.',
  });
  const bruteForceLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: 'Too many requests from this IP. Please try again later.',
  });
  app.use('/login', bruteForceLimiter);

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

  app.get('/login', (req, res) => {
    if (req.session && req.session.authenticated) {
      return res.redirect('/terminal');
    }
    return res.sendFile(path.join(__dirname, 'views', 'login.html'));
  });

  let authPasswordHash;
  app.post('/login', loginLimiter, doubleCsrfProtection, async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (!timingSafeEqualString(normalizedEmail, config.authEmail.toLowerCase())) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    let passwordMatch = false;
    try {
      passwordMatch = await verifyPassword(authPasswordHash, password);
    } catch (err) {
      console.error('Password verification error:', err.message);
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    req.session.authenticated = true;
    req.session.email = normalizedEmail;
    req.session.loginAt = new Date().toISOString();
    return res.json({ success: true, redirect: '/terminal' });
  });

  app.get('/csrf-token', (req, res) => {
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
      return res.status(201).json({ session: sessionManager.createSession(name) });
    } catch (err) {
      if (err instanceof DuplicateTerminalSessionError
        || err.code === 'TERMINAL_SESSION_EXISTS') {
        return res.status(409).json({ error: 'A session with that name already exists.' });
      }
      console.error('Terminal session service error:', err.message);
      return res.status(503).json({ error: 'Terminal session service unavailable.' });
    }
  });

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
        return res.status(204).end();
      } catch (err) {
        console.error('Terminal session service error:', err.message);
        return res.status(503).json({ error: 'Terminal session service unavailable.' });
      }
    },
  );

  app.get('/terminal', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'terminal.html'));
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
        socket.close(code, reason);
      }
    }
  }

  app.post('/logout', requireAuth, doubleCsrfProtection, (req, res) => {
    const loginSessionId = req.sessionID;
    closeLoginSockets(loginSessionId, SOCKET_CLOSE_CODES.LOGGED_OUT, 'Logged out.');
    req.session.destroy((err) => {
      if (err) {
        console.error('Session destruction error:', err);
        return res.status(500).json({ error: 'Logout failed.' });
      }
      res.clearCookie('terminal.sid');
      return res.json({ success: true, redirect: '/' });
    });
  });

  app.use((err, req, res, next) => {
    if (err === invalidCsrfTokenError) {
      return res.status(403).json({ error: 'Invalid CSRF token.' });
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

  function handleTerminalSocket(socket, request, sessionName, loginSessionId) {
    socket.isAlive = true;
    socket.loginSessionId = loginSessionId;
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
        if (!sessionManager.writeInput(sessionName, socket, message.data)) {
          closeWithProtocolError(socket, 'Terminal is not attached.');
        }
        return;
      }

      if (message.type === 'binary'
        && typeof message.data === 'string'
        && isStrictBase64(message.data)) {
        const data = Buffer.from(message.data, 'base64');
        if (!sessionManager.writeBinary(sessionName, socket, data)) {
          closeWithProtocolError(socket, 'Terminal is not attached.');
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
      sessionManager.detachClient(sessionName, socket);
    });
  }

  async function start(startOptions = {}) {
    if (server) {
      return server;
    }

    authPasswordHash = await hashPassword(config.authPassword);
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
        if (!req.session || !req.session.authenticated) {
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
          handleTerminalSocket(webSocket, req, sessionName, req.sessionID);
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
          if ((err || !storedSession || !storedSession.authenticated)
            && (socket.readyState === 0 || socket.readyState === 1)) {
            socket.close(SOCKET_CLOSE_CODES.AUTH_EXPIRED, 'Authentication expired.');
          }
        });
      }
    }, HEARTBEAT_INTERVAL_MS);
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
  TERMINAL_SESSION_NAME_PATTERN,
  createTerminalEnvironment,
  createWebTerminal,
  hasExactSameOrigin,
  isStrictBase64,
  isValidTerminalSessionName,
  normalizePublicOrigin,
  timingSafeEqualString,
};
