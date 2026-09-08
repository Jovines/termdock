import crypto from 'crypto';
import { isEncryptedRequest } from '../federation/requestContext.js';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';
import { getCookieSecurityOptions } from './cookieSecurity.js';

// Auth state lives under ~/.termdock/. We keep two separate files:
//   - auth.json:          password hash (mode 0600). Presence enables auth.
//   - auth-sessions.json: active session token hashes (mode 0600). Persisted so
//                         clients survive a server restart without re-login.
const AUTH_DIR = path.join(os.homedir(), '.termdock');
const AUTH_FILE = path.join(AUTH_DIR, 'auth.json');
const SESSIONS_FILE = path.join(AUTH_DIR, 'auth-sessions.json');

// Cookie holding the opaque session token. httpOnly + sameSite=lax. The token
// itself is 32 random bytes hex; never derived from the password.
export const AUTH_COOKIE = 'termdock-auth';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
  passwordLength?: number;
}

interface SessionRecord {
  token: string;
  createdAt: number;
  expiresAt: number;
  credential: string;
  lastUsedAt: number;
}

interface SessionsFile {
  version: 2;
  sessions: SessionRecord[];
}

// In-memory cache of active sessions, keyed by SHA-256 token hash.
export const authEvents = new EventEmitter();
authEvents.setMaxListeners(0);

const sessions = new Map<string, SessionRecord>();
let sessionsLoaded = false;

// In-memory rate limiter for login attempts, keyed by remote IP. Resets on
// process restart, which is fine: it's a defense-in-depth, not a hard lock.
interface AttemptRecord {
  failures: number;
  blockedUntil: number;
  updatedAt: number;
}
const loginAttempts = new Map<string, AttemptRecord>();

function ensureAuthDir(): void {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  }
}

function writeFileSecure(filePath: string, content: string): void {
  ensureAuthDir();
  const temporary = `${filePath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
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

function credentialFingerprint(): string {
  const password = getEnvPassword();
  const source = password ? `env:${getEnvPasswordHash()}` : `file:${readAuthFile()?.passwordHash ?? 'disabled'}`;
  return crypto.createHash('sha256').update(source).digest('hex');
}

export function isEnvPasswordSet(): boolean {
  return getEnvPassword() !== null;
}

/** Server-only input for password-authenticated encrypted bootstrap. Never serialize this value. */
export function getPasswordVerifier(): string | null {
  return getEnvPasswordHash() ?? readAuthFile()?.passwordHash ?? null;
}
export function getPasswordCredentialFingerprint(): string | null {
  const verifier = getPasswordVerifier();
  return verifier ? crypto.createHash('sha256').update(verifier).digest('hex') : null;
}

export function isAuthEnabled(): boolean {
  if (getEnvPassword()) return true;
  try {
    fs.statSync(AUTH_FILE);
    return true;
  } catch (error) {
    // Only a missing file disables auth. I/O and permission failures must not
    // turn an authenticated terminal into an anonymous one.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

export function readAuthFile(): AuthFile | null {
  try {
    if (!fs.existsSync(AUTH_FILE)) return null;
    const raw = fs.readFileSync(AUTH_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AuthFile>;
    if (parsed.version !== 1 || typeof parsed.passwordHash !== 'string' ||
        !/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(parsed.passwordHash)) return null;
    return {
      version: 1,
      passwordHash: parsed.passwordHash,
      passwordLength: typeof parsed.passwordLength === 'number' ? parsed.passwordLength : undefined,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function writeAuthFile(passwordHash: string, passwordLength?: number): void {
  const payload: AuthFile = { version: 1, passwordHash, createdAt: Date.now(), passwordLength };
  writeFileSecure(AUTH_FILE, JSON.stringify(payload, null, 2));
}

export function clearAuthFile(): void {
  try {
    if (fs.existsSync(AUTH_FILE)) fs.rmSync(AUTH_FILE, { force: true });
  } catch { /* ignore */ }
  // Clearing the password also invalidates all existing sessions.
  sessionsLoaded = true;
  sessions.clear();
  persistSessions();
  authEvents.emit('revoked');
}

function loadSessionsIfNeeded(): void {
  if (sessionsLoaded) return;
  sessionsLoaded = true;
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SessionsFile>;
    if (parsed.version !== 2 || !Array.isArray(parsed.sessions)) return;
    const now = Date.now();
    for (const record of parsed.sessions) {
      if (
        record &&
        typeof record.token === 'string' &&
        /^[0-9a-f]{64}$/.test(record.token) &&
        record.credential === credentialFingerprint() &&
        typeof record.expiresAt === 'number' &&
        typeof record.createdAt === 'number' &&
        typeof record.lastUsedAt === 'number' &&
        record.expiresAt > now
      ) {
        sessions.set(record.token, record);
      }
    }
  } catch { /* ignore */ }
}

function persistSessions(): void {
  // Revocations must reach disk before logout succeeds; a debounce could
  // resurrect the session if the server restarts immediately after logout.
  const payload: SessionsFile = { version: 2, sessions: Array.from(sessions.values()) };
  writeFileSecure(SESSIONS_FILE, JSON.stringify(payload, null, 2));
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
  pruneExpiredSessions();
  if (sessions.size >= 100) {
    sessions.delete(sessions.keys().next().value!);
    authEvents.emit('revoked');
  }
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const record: SessionRecord = {
    token,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    lastUsedAt: now,
    credential: credentialFingerprint(),
  };
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  sessions.set(tokenHash, { ...record, token: tokenHash });
  persistSessions();
  return record;
}

export function isSessionValid(token: string | undefined, touch = false): boolean {
  if (!token || typeof token !== 'string') return false;
  loadSessionsIfNeeded();
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const record = sessions.get(tokenHash);
  if (!record) return false;
  if (record.expiresAt <= Date.now() ||
      record.credential !== credentialFingerprint()) {
    sessions.delete(tokenHash);
    persistSessions();
    return false;
  }
  if (touch) {
    const now = Date.now();
    // Coalesce subsecond HTTP/input bursts, while persisting every new visit
    // before replying. Also immediately upgrade still-valid shorter sessions.
    if (now - record.lastUsedAt >= 1000 || record.expiresAt - record.lastUsedAt < SESSION_TTL_MS) {
      record.lastUsedAt = now;
      record.expiresAt = now + SESSION_TTL_MS;
      persistSessions();
    }
  }
  return true;
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  loadSessionsIfNeeded();
  if (sessions.delete(crypto.createHash('sha256').update(token).digest('hex'))) {
    persistSessions();
    authEvents.emit('revoked');
  }
}

export function destroyAllSessions(): void {
  sessionsLoaded = true;
  sessions.clear();
  persistSessions();
  authEvents.emit('revoked');
}

// ── Login rate limiting ──
// Exponential backoff per source IP: 0, 0, 0, 1s, 4s, 16s, 64s, 256s, capped.
// Resets to 0 on a successful login.
const BACKOFF_GRACE_FAILURES = 3;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 15 * 60 * 1000; // 15 min hard cap per attempt window

export function getLoginBlockMs(ip: string): number {
  const record = loginAttempts.get(ip);
  if (record && Date.now() - record.updatedAt > BACKOFF_CAP_MS * 2) {
    loginAttempts.delete(ip);
    return 0;
  }
  if (!record) return 0;
  const remaining = record.blockedUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const record = loginAttempts.get(ip) ?? { failures: 0, blockedUntil: 0, updatedAt: now };
  record.updatedAt = now;
  record.failures += 1;
  if (loginAttempts.size >= 4096 && !loginAttempts.has(ip)) {
    loginAttempts.delete(loginAttempts.keys().next().value!);
  }
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
  if (isEncryptedRequest(req)) return true;
  pruneExpiredSessions();
  const token = req.cookies?.[AUTH_COOKIE];
  return isSessionValid(typeof token === 'string' ? token : undefined);
}

// Refresh both sides of the login on HTTP visits. Socket validation alone
// cannot update a browser cookie, so the UI also checks status on foregrounding.
export function renewSessionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[AUTH_COOKIE];
  const authMutation = /^\/(?:api\/)?auth\/(?:login|logout)\/?$/i.test(req.path);
  if (!authMutation && isAuthEnabled() && typeof token === 'string' && isSessionValid(token, true)) {
    const key = crypto.createHash('sha256').update(token).digest('hex');
    const record = sessions.get(key)!;
    setSessionCookie(res, token, record.expiresAt);
  }
  next();
}

// Middleware factory: blocks the request with 401 unless either auth is
// disabled (no auth.json) or the request carries a valid session cookie.
// Bypass paths are public (login/status/health/static).
export function requireAuth(options?: { bypass?: (req: Request) => boolean }) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (isEncryptedRequest(req)) return next();
    if (!isAuthEnabled()) return next();
    if (options?.bypass?.(req)) return next();
    if (isRequestAuthenticated(req)) return next();
    res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  };
}

// Verify the cookie attached to a WebSocket upgrade request. Reads the raw
// Cookie header and matches AUTH_COOKIE without depending on Express middleware.
export function isUpgradeRequestAuthenticated(cookieHeader: string | undefined, touch = false): boolean {
  if (!isAuthEnabled()) return true;
  if (!cookieHeader) return false;
  const pairs = cookieHeader.split(/;\s*/);
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    if (name !== AUTH_COOKIE) continue;
    try {
      const value = decodeURIComponent(pair.slice(idx + 1).trim());
      return isSessionValid(value, touch);
    } catch {
      return false;
    }
  }
  return false;
}

export function getClientIp(req: Request): string {
  // We do not trust X-Forwarded-* by default since this is a local tool. If
  // the user puts it behind a reverse proxy with auth, the rate limiter only
  // sees the proxy IP — that's an acceptable trade-off here.
  return req.socket.remoteAddress ?? 'unknown';
}

export function setSessionCookie(res: Response, token: string, expiresAt = Date.now() + SESSION_TTL_MS): void {
  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,
    ...getCookieSecurityOptions(),
    maxAge: Math.max(0, expiresAt - Date.now()),
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

// A bounded asynchronous KDF prevents login traffic from blocking terminal I/O
// or filling the libuv worker queue. The shared budget also covers rotating IPs.
let activeVerifications = 0;
let verificationWindow = 0;
let verificationCount = 0;
export async function verifyPasswordAsync(password: string): Promise<boolean | null> {
  const now = Date.now();
  if (now - verificationWindow >= 60_000) {
    verificationWindow = now;
    verificationCount = 0;
  }
  if (activeVerifications >= 2 || verificationCount >= 30) return null;
  if (!password || Buffer.byteLength(password) > 1024) return false;
  verificationCount++;
  const stored = getEnvPasswordHash() ?? readAuthFile()?.passwordHash;
  if (!stored) return false;
  const [algorithm, salt, hash] = stored.split('$');
  if (algorithm !== 'scrypt' || !/^[0-9a-f]{32}$/.test(salt ?? '') || !/^[0-9a-f]{128}$/.test(hash ?? '')) return false;
  const credential = credentialFingerprint();
  activeVerifications++;
  try {
    const derived = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(password, Buffer.from(salt, 'hex'), SCRYPT_KEY_LEN, {
        N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
      }, (error, key) => error ? reject(error) : resolve(key));
    });
    return credential === credentialFingerprint() && crypto.timingSafeEqual(derived, Buffer.from(hash, 'hex'));
  } catch {
    return false;
  } finally {
    activeVerifications--;
  }
}
