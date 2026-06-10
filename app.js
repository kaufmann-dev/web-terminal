require('dotenv').config();

const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const csrf = require('csurf');
const helmet = require('helmet');
const compression = require('compression');
const argon2 = require('argon2');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const AUTH_EMAIL = process.env.AUTH_EMAIL;
const AUTH_PASSWORD_HASH = process.env.AUTH_PASSWORD_HASH;
const SESSION_SECRET = process.env.SESSION_SECRET;
const TTYD_URL = process.env.TTYD_URL || 'http://127.0.0.1:7681';
const NODE_ENV = process.env.NODE_ENV || 'production';
const TRUST_PROXY = process.env.TRUST_PROXY || false;

if (!AUTH_EMAIL || !AUTH_PASSWORD_HASH || !SESSION_SECRET) {
  console.error('Missing required environment variables: AUTH_EMAIL, AUTH_PASSWORD_HASH, SESSION_SECRET');
  process.exit(1);
}

if (TRUST_PROXY) {
  app.set('trust proxy', TRUST_PROXY === 'true' ? true : TRUST_PROXY);
}

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
      frameAncestors: ["'none'"], // disable iframe embedding
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

// CSRF protection (exempt WebSocket upgrade paths)
const csrfProtection = csrf({ cookie: false });

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
app.post('/login', loginLimiter, csrfProtection, async (req, res) => {
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
    passwordMatch = await argon2.verify(AUTH_PASSWORD_HASH, password);
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
app.get('/csrf-token', csrfProtection, (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

// Terminal page
app.get('/terminal', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'terminal.html'));
});

// Logout
app.post('/logout', requireAuth, csrfProtection, (req, res) => {
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
  onError: (err, req, res) => {
    console.error('TTYD proxy error:', err.message);
    if (res && !res.headersSent) {
      res.status(502).send('Terminal backend unavailable.');
    }
  },
});

// Auth gate for ttyd proxy
function ttydAuthGate(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  return res.status(403).send('Forbidden');
}

app.use('/ttyd', ttydAuthGate, ttydProxy);

// Upgrade handling for WebSocket proxy
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

module.exports = app;
