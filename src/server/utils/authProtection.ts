import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';
import { getCookieSecurityOptions } from './cookieSecurity.js';

// Auth state lives under ~/.termdock/. We keep two separate files:
//   - auth.json:          password hash (mode 0600). Presence enables auth.
//   - auth-sessions.json: active session tokens (mode 0600). Persisted so
//                         clients survive a server restart without re-login.
const AUTH_DIR = path.join(os.homedir(), '.termdock');
const AUTH_FILE = path.join(AUTH_DIR, 'auth.json');
const SESSIONS_FILE = path.join(AUTH_DIR, 'auth-sessions.json');

// Cookie holding the opaque session token. httpOnly + sameSite=lax. The token
// itself is 32 random bytes hex; never derived from the password.
export const AUTH_COOKIE = 'termdock-auth';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// scrypt parameters. N=2^15 keeps interactive login latency acceptable on
// laptops/phones while still being painful for offline brute force on a
// single secret.
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LEN = 64;
const SCRYPT_SALT_LEN = 16;

interface AuthFile {
  version: 1;
  passwordHash: string; // format: "scrypt$<saltHex>$<hashHex>"
  createdAt: number;
}

interface SessionRecord {
  token: string;
  createdAt: number;
  expiresAt: number;
}

interface SessionsFile {
  version: 1;
  sessions: SessionRecord[];
}

// In-memory cache of active sessions, keyed by token. Mirrors SESSIONS_FILE.
const sessions = new Map<string, SessionRecord>();
let sessionsLoaded = false;

// In-memory rate limiter for login attempts, keyed by remote IP. Resets on
// process restart, which is fine: it's a defense-in-depth, not a hard lock.
interface AttemptRecord {
  failures: number;
  blockedUntil: number;
}
const loginAttempts = new Map<string, AttemptRecord>();

function ensureAuthDir(): void {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  }
}

function writeFileSecure(filePath: string, content: string): void {
  ensureAuthDir();
  fs.writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o600 });
  // Best-effort chmod in case the file already existed with looser perms.
  try { fs.chmodSync(filePath, 0o600); } catch { /* ignore */ }
}

function scryptHashSync(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    // scrypt with large N can exceed default maxmem; raise it explicitly.
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  });
}

export function hashPassword(password: string): string {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password must be a non-empty string');
  }
  const salt = crypto.randomBytes(SCRYPT_SALT_LEN);
  const derived = scryptHashSync(password, salt);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPasswordAgainstHash(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let saltHex: string;
  let hashHex: string;
  try {
    saltHex = parts[1];
    hashHex = parts[2];
  } catch {
    return false;
  }
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length === 0) return false;
  let derived: Buffer;
  try {
    derived = scryptHashSync(password, salt);
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

// ── Env-provided password ──
// TERMDOCK_PASSWORD enables auth without touching ~/.termdock/auth.json and
// takes precedence over the stored hash. The plaintext is hashed once (lazily)
// so verification goes through the same scrypt + timingSafeEqual path as the
// file-based password.
const ENV_PASSWORD_VAR = 'TERMDOCK_PASSWORD';

function getEnvPassword(): string | null {
  const value = process.env[ENV_PASSWORD_VAR];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

let cachedEnvHash: { password: string; hash: string } | null = null;
function getEnvPasswordHash(): string | null {
  const password = getEnvPassword();
  if (!password) return null;
  if (!cachedEnvHash || cachedEnvHash.password !== password) {
    cachedEnvHash = { password, hash: hashPassword(password) };
  }
  return cachedEnvHash.hash;
}

export function isEnvPasswordSet(): boolean {
  return getEnvPassword() !== null;
}

export function isAuthEnabled(): boolean {
  if (getEnvPassword()) return true;
  try {
    return fs.existsSync(AUTH_FILE);
  } catch {
    return false;
  }
}

export function readAuthFile(): AuthFile | null {
  try {
    if (!fs.existsSync(AUTH_FILE)) return null;
    const raw = fs.readFileSync(AUTH_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AuthFile>;
    if (parsed.version !== 1 || typeof parsed.passwordHash !== 'string') return null;
    return {
      version: 1,
      passwordHash: parsed.passwordHash,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function writeAuthFile(passwordHash: string): void {
  const payload: AuthFile = { version: 1, passwordHash, createdAt: Date.now() };
  writeFileSecure(AUTH_FILE, JSON.stringify(payload, null, 2));
}

export function clearAuthFile(): void {
  try {
    if (fs.existsSync(AUTH_FILE)) fs.rmSync(AUTH_FILE, { force: true });
  } catch { /* ignore */ }
  // Clearing the password also invalidates all existing sessions.
  sessions.clear();
  persistSessions();
}

function loadSessionsIfNeeded(): void {
  if (sessionsLoaded) return;
  sessionsLoaded = true;
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SessionsFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return;
    const now = Date.now();
    for (const record of parsed.sessions) {
      if (
        record &&
        typeof record.token === 'string' &&
        typeof record.expiresAt === 'number' &&
        typeof record.createdAt === 'number' &&
        record.expiresAt > now
      ) {
        sessions.set(record.token, record);
      }
    }
  } catch { /* ignore */ }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistSessions(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      const payload: SessionsFile = {
        version: 1,
        sessions: Array.from(sessions.values()),
      };
      writeFileSecure(SESSIONS_FILE, JSON.stringify(payload, null, 2));
    } catch { /* ignore */ }
  }, 200);
}

function pruneExpiredSessions(): void {
  loadSessionsIfNeeded();
  const now = Date.now();
  let changed = false;
  for (const [token, record] of sessions.entries()) {
    if (record.expiresAt <= now) {
      sessions.delete(token);
      changed = true;
    }
  }
  if (changed) persistSessions();
}

export function createSession(): SessionRecord {
  loadSessionsIfNeeded();
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const record: SessionRecord = {
    token,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  sessions.set(token, record);
  persistSessions();
  return record;
}

export function isSessionValid(token: string | undefined): boolean {
  if (!token || typeof token !== 'string') return false;
  loadSessionsIfNeeded();
  const record = sessions.get(token);
  if (!record) return false;
  if (record.expiresAt <= Date.now()) {
    sessions.delete(token);
    persistSessions();
    return false;
  }
  return true;
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  loadSessionsIfNeeded();
  if (sessions.delete(token)) persistSessions();
}

export function destroyAllSessions(): void {
  sessions.clear();
  persistSessions();
}

// ── Login rate limiting ──
// Exponential backoff per source IP: 0, 0, 0, 1s, 4s, 16s, 64s, 256s, capped.
// Resets to 0 on a successful login.
const BACKOFF_GRACE_FAILURES = 3;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 15 * 60 * 1000; // 15 min hard cap per attempt window

export function getLoginBlockMs(ip: string): number {
  const record = loginAttempts.get(ip);
  if (!record) return 0;
  const remaining = record.blockedUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const record = loginAttempts.get(ip) ?? { failures: 0, blockedUntil: 0 };
  record.failures += 1;
  if (record.failures > BACKOFF_GRACE_FAILURES) {
    const exponent = record.failures - BACKOFF_GRACE_FAILURES - 1;
    const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(4, exponent));
    record.blockedUntil = now + delay;
  }
  loginAttempts.set(ip, record);
}

export function recordLoginSuccess(ip: string): void {
  loginAttempts.delete(ip);
}

// ── Express middleware ──

// Returns true when the incoming request bears a valid session cookie.
export function isRequestAuthenticated(req: Request): boolean {
  pruneExpiredSessions();
  const token = req.cookies?.[AUTH_COOKIE];
  return isSessionValid(typeof token === 'string' ? token : undefined);
}

// Middleware factory: blocks the request with 401 unless either auth is
// disabled (no auth.json) or the request carries a valid session cookie.
// Bypass paths are public (login/status/health/static).
export function requireAuth() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isAuthEnabled()) return next();
    if (isRequestAuthenticated(req)) return next();
    res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  };
}

// Verify the cookie attached to a WebSocket upgrade request. Reads the raw
// Cookie header and matches AUTH_COOKIE without depending on Express middleware.
export function isUpgradeRequestAuthenticated(cookieHeader: string | undefined): boolean {
  if (!isAuthEnabled()) return true;
  if (!cookieHeader) return false;
  const pairs = cookieHeader.split(/;\s*/);
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    if (name !== AUTH_COOKIE) continue;
    const value = decodeURIComponent(pair.slice(idx + 1).trim());
    if (isSessionValid(value)) return true;
  }
  return false;
}

export function getClientIp(req: Request): string {
  // We do not trust X-Forwarded-* by default since this is a local tool. If
  // the user puts it behind a reverse proxy with auth, the rate limiter only
  // sees the proxy IP — that's an acceptable trade-off here.
  return req.socket.remoteAddress ?? 'unknown';
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,
    ...getCookieSecurityOptions(),
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(AUTH_COOKIE, { path: '/', ...getCookieSecurityOptions() });
}

export function verifyPassword(password: string): boolean {
  if (typeof password !== 'string' || password.length === 0) return false;
  // Env-provided password takes precedence over the stored hash.
  const envHash = getEnvPasswordHash();
  if (envHash) return verifyPasswordAgainstHash(password, envHash);
  const auth = readAuthFile();
  if (!auth) return false;
  return verifyPasswordAgainstHash(password, auth.passwordHash);
}
