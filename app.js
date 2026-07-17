require('dotenv').config();

const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { doubleCsrf } = require('csrf-csrf');
const helmet = require('helmet');
const compression = require('compression');
const argon2 = require('argon2');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const AUTH_EMAIL = process.env.AUTH_EMAIL;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const TTYD_URL = process.env.TTYD_URL || 'http://127.0.0.1:7681';
const NODE_ENV = process.env.NODE_ENV || 'production';
const TRUST_PROXY = process.env.TRUST_PROXY || 'false';

if (!AUTH_EMAIL || !AUTH_PASSWORD || !SESSION_SECRET) {
  console.error('Missing required environment variables: AUTH_EMAIL, AUTH_PASSWORD, SESSION_SECRET');
  process.exit(1);
}

if (!['true', 'false'].includes(TRUST_PROXY)) {
  console.error('TRUST_PROXY must be either true or false.');
  process.exit(1);
}

if (TRUST_PROXY === 'true') {
  app.set('trust proxy', true);
}

let authPasswordHash;

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'", "wss:", "ws:"],
      imgSrc: ["'self'"],
      fontSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(compression());

// Body parsing
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Sessions
const sessionMiddleware = session({
  name: 'terminal.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: NODE_ENV === 'production',
    sameSite: 'Lax',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
});
app.use(sessionMiddleware);
app.use(cookieParser());

const {
  doubleCsrfProtection,
  generateCsrfToken,
  invalidCsrfTokenError,
} = doubleCsrf({
  getSecret: () => SESSION_SECRET,
  getSessionIdentifier: (req) => req.session.id,
  cookieName: 'terminal.csrf',
  cookieOptions: {
    httpOnly: true,
    sameSite: 'lax',
    secure: NODE_ENV === 'production',
    path: '/',
  },
  getCsrfTokenFromRequest: (req) => req.headers['csrf-token'],
});

// Rate limiting for login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: 'Too many login attempts. Please try again later.',
});

// Brute-force protection: stricter per-IP for all auth-related requests
const bruteForceLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: 'Too many requests from this IP. Please try again later.',
});

app.use('/login', bruteForceLimiter);

// Static assets (public CSS)
app.use('/static', express.static(path.join(__dirname, 'public')));

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  return res.redirect('/');
}

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Login page
app.get('/', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/terminal');
  }
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/terminal');
  }
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still do comparison to avoid leaking length, but on padded buffers
    const maxLen = Math.max(bufA.length, bufB.length);
    const padA = Buffer.alloc(maxLen);
    const padB = Buffer.alloc(maxLen);
    bufA.copy(padA);
    bufB.copy(padB);
    return crypto.timingSafeEqual(padA, padB) && false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Login handler
app.post('/login', loginLimiter, doubleCsrfProtection, async (req, res) => {
  const { email, password } = req.body || {};

  // Generic validation to avoid leaking information
  if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  const emailMatch = timingSafeEqualString(normalizedEmail, AUTH_EMAIL.toLowerCase());

  if (!emailMatch) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  let passwordMatch = false;
  try {
    passwordMatch = await argon2.verify(authPasswordHash, password);
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

// CSRF token endpoint for frontend
app.get('/csrf-token', (req, res) => {
  req.session.csrfInitialized = true;
  res.json({ csrfToken: generateCsrfToken(req, res) });
});

// Terminal page
app.get('/terminal', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'terminal.html'));
});

// Logout
app.post('/logout', requireAuth, doubleCsrfProtection, (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Session destruction error:', err);
      return res.status(500).json({ error: 'Logout failed.' });
    }
    res.clearCookie('terminal.sid');
    return res.json({ success: true, redirect: '/' });
  });
});

// Proxy ttyd under /ttyd/*
const ttydProxy = createProxyMiddleware({
  target: TTYD_URL,
  changeOrigin: true,
  ws: true,
  // Mounted at root (see below) so the /ttyd prefix is preserved and forwarded
  // unchanged, matching ttyd's --base-path /ttyd for both HTTP and WebSocket.
  // A plain string pathFilter is a prefix match, so this covers /ttyd/* too.
  pathFilter: '/ttyd',
  on: {
    error: (err, req, res) => {
      console.error('TTYD proxy error:', err.message);
      if (res && !res.headersSent) {
        res.status(502).send('Terminal backend unavailable.');
      }
    },
  },
});

// Auth gate for ttyd proxy
function ttydAuthGate(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  return res.status(403).send('Forbidden');
}

const ttydContentSecurityPolicy = helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    scriptSrc: ["'self'", "'unsafe-inline'"],
    connectSrc: ["'self'", 'wss:', 'ws:'],
    imgSrc: ["'self'", 'data:'],
    fontSrc: ["'self'"],
    frameAncestors: ["'self'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    objectSrc: ["'none'"],
    scriptSrcAttr: ["'none'"],
  },
});

app.use('/ttyd', ttydContentSecurityPolicy, ttydAuthGate);
app.use(ttydProxy);

app.use((err, req, res, next) => {
  if (err === invalidCsrfTokenError) {
    return res.status(403).json({ error: 'Invalid CSRF token.' });
  }
  return next(err);
});

async function startServer() {
  authPasswordHash = await argon2.hash(AUTH_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });

  const server = app.listen(PORT, () => {
    console.log(`web-terminal listening on port ${PORT}`);
  });

  server.on('upgrade', (req, socket, head) => {
    sessionMiddleware(req, {}, () => {
      if (!req.session || !req.session.authenticated) {
        socket.destroy();
        return;
      }
      ttydProxy.upgrade(req, socket, head);
    });
  });
}

startServer().catch((err) => {
  console.error('Failed to initialize authentication:', err.message);
  process.exit(1);
});

module.exports = app;
