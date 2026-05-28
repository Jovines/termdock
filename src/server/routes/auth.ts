import express from 'express';
import {
  AUTH_COOKIE,
  clearSessionCookie,
  createSession,
  destroySession,
  getClientIp,
  getLoginBlockMs,
  isAuthEnabled,
  isRequestAuthenticated,
  recordLoginFailure,
  recordLoginSuccess,
  setSessionCookie,
  verifyPassword,
} from '../utils/authProtection.js';

const router: express.Router = express.Router();

// GET /api/auth/status — public; tells the client whether auth is enabled
// and whether the current cookie (if any) is still valid.
router.get('/status', (req, res) => {
  res.json({
    enabled: isAuthEnabled(),
    authenticated: isRequestAuthenticated(req),
  });
});

// POST /api/auth/login — public; verifies password, issues session cookie.
// Rate-limited per source IP via exponential backoff.
router.post('/login', (req, res) => {
  if (!isAuthEnabled()) {
    return res.status(400).json({ error: 'Authentication is not enabled', code: 'AUTH_DISABLED' });
  }

  const ip = getClientIp(req);
  const blockMs = getLoginBlockMs(ip);
  if (blockMs > 0) {
    res.setHeader('Retry-After', String(Math.ceil(blockMs / 1000)));
    return res.status(429).json({
      error: 'Too many failed login attempts. Please wait and try again.',
      code: 'RATE_LIMITED',
      retryAfterMs: blockMs,
    });
  }

  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!verifyPassword(password)) {
    recordLoginFailure(ip);
    // Same generic message regardless of cause to avoid user-enumeration.
    return res.status(401).json({ error: 'Invalid password', code: 'INVALID_PASSWORD' });
  }

  recordLoginSuccess(ip);
  const session = createSession();
  setSessionCookie(res, session.token);
  res.json({ ok: true });
});

// POST /api/auth/logout — public (idempotent). Invalidates the cookie's
// session, if any.
router.post('/logout', (req, res) => {
  const token = typeof req.cookies?.[AUTH_COOKIE] === 'string' ? req.cookies[AUTH_COOKIE] : undefined;
  destroySession(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

export default router;
