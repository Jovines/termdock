// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let directory: string;
let auth: typeof import('./authProtection.js');
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-auth-test-'));
  vi.resetModules();
  vi.spyOn(os, 'homedir').mockReturnValue(directory);
  vi.stubEnv('TERMDOCK_PASSWORD', '');
  vi.stubEnv('TERMDOCK_PUBLIC_ORIGIN', '');
  auth = await import('./authProtection.js');
  auth.writeAuthFile(auth.hashPassword('a strong test password'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('authentication attack regressions', () => {
  it('rejects malformed upgrade cookies without throwing or accepting duplicate cookies', () => {
    const session = auth.createSession();
    expect(auth.isUpgradeRequestAuthenticated(`termdock-auth=${session.token}`)).toBe(true);
    expect(auth.isUpgradeRequestAuthenticated('termdock-auth=%E0%A4%A')).toBe(false);
    expect(auth.isUpgradeRequestAuthenticated(`termdock-auth=invalid; termdock-auth=${session.token}`)).toBe(false);
  });

  it('persists only token hashes and survives a restart with file-based credentials', async () => {
    const session = auth.createSession();
    const file = path.join(directory, '.termdock/auth-sessions.json');
    expect(fs.readFileSync(file, 'utf8')).not.toContain(session.token);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    vi.resetModules();
    const restarted = await import('./authProtection.js');
    expect(restarted.isSessionValid(session.token)).toBe(true);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')).sessions[0].token;
    expect(restarted.isSessionValid(stored)).toBe(false);
  });

  it('rejects old sessions when a separate CLI process changes the password', () => {
    const session = auth.createSession();
    const newHash = auth.hashPassword('a different strong password');
    fs.writeFileSync(path.join(directory, '.termdock/auth.json'), JSON.stringify({ version: 1, passwordHash: newHash }));
    expect(auth.isSessionValid(session.token)).toBe(false);
  });

  it('persists logout synchronously and does not resurrect sessions on restart', async () => {
    const session = auth.createSession();
    auth.destroySession(session.token);
    vi.resetModules();
    const restarted = await import('./authProtection.js');
    expect(restarted.isSessionValid(session.token)).toBe(false);
  });

  it('does not reload old sessions after destroyAllSessions runs before lazy loading', async () => {
    const session = auth.createSession();
    vi.resetModules();
    const restarted = await import('./authProtection.js');
    restarted.destroyAllSessions();
    expect(restarted.isSessionValid(session.token)).toBe(false);
  });

  it('bounds concurrent expensive password work, and verifies correct/incorrect passwords', async () => {
    const first = auth.verifyPasswordAsync('a strong test password');
    const second = auth.verifyPasswordAsync('incorrect');
    expect(await auth.verifyPasswordAsync('a strong test password')).toBeNull();
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(await auth.verifyPasswordAsync('x'.repeat(1025))).toBe(false);
  });

  it('rejects a successful KDF result if credentials change while it is running', async () => {
    const pending = auth.verifyPasswordAsync('a strong test password');
    auth.writeAuthFile(auth.hashPassword('changed while checking password'));
    expect(await pending).toBe(false);
  });

  it('expires tokens and applies per-IP backoff', () => {
    const session = auth.createSession();
    for (let i = 0; i < 4; i++) auth.recordLoginFailure('attacker');
    expect(auth.getLoginBlockMs('attacker')).toBeGreaterThan(0);
    expect(auth.getLoginBlockMs('other')).toBe(0);
    vi.spyOn(Date, 'now').mockReturnValue(session.expiresAt + 1);
    expect(auth.isSessionValid(session.token)).toBe(false);
    expect(auth.getLoginBlockMs('attacker')).toBe(0);
  });
});


describe('30-day sliding login', () => {
  const DAY = 24 * 60 * 60_000;

  it('stays valid past the former limits but expires after 30 days without a visit', () => {
    const session = auth.createSession();
    expect(session.expiresAt - session.createdAt).toBe(30 * DAY);
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(session.createdAt + DAY);
    expect(auth.isSessionValid(session.token)).toBe(true);
    now.mockReturnValue(session.expiresAt);
    expect(auth.isSessionValid(session.token, true)).toBe(false);
  });

  it('renews repeated visits beyond the initial expiration, including public mode', () => {
    vi.stubEnv('TERMDOCK_PUBLIC_ORIGIN', 'https://term.example.com');
    const session = auth.createSession();
    const now = vi.spyOn(Date, 'now');
    for (const day of [29, 58, 87]) {
      now.mockReturnValue(session.createdAt + day * DAY);
      expect(auth.isSessionValid(session.token, true)).toBe(true);
    }
    now.mockReturnValue(session.createdAt + 116 * DAY);
    expect(auth.isSessionValid(session.token)).toBe(true);
    now.mockReturnValue(session.createdAt + 117 * DAY);
    expect(auth.isSessionValid(session.token, true)).toBe(false);
  });

  it('persists renewal across restart without restoring expired or revoked sessions', async () => {
    const session = auth.createSession();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(session.createdAt + 29 * DAY);
    expect(auth.isSessionValid(session.token, true)).toBe(true);
    vi.resetModules();
    const restarted = await import('./authProtection.js');
    now.mockReturnValue(session.createdAt + 40 * DAY);
    expect(restarted.isSessionValid(session.token)).toBe(true);
    restarted.destroySession(session.token);
    expect(restarted.isSessionValid(session.token, true)).toBe(false);
  });

  it('refreshes the browser cookie and persisted expiry on a visit', () => {
    const session = auth.createSession();
    const visitedAt = session.createdAt + 29 * DAY;
    vi.spyOn(Date, 'now').mockReturnValue(visitedAt);
    const cookie = vi.fn();
    const next = vi.fn();
    auth.renewSessionMiddleware(
      { path: '/auth/status', cookies: { [auth.AUTH_COOKIE]: session.token } } as never,
      { cookie } as never,
      next,
    );
    expect(cookie).toHaveBeenCalledWith(auth.AUTH_COOKIE, session.token, expect.objectContaining({
      httpOnly: true, maxAge: 30 * DAY, path: '/',
    }));
    const persisted = JSON.parse(fs.readFileSync(path.join(directory, '.termdock/auth-sessions.json'), 'utf8'));
    expect(persisted.sessions[0].expiresAt).toBe(visitedAt + 30 * DAY);
    expect(next).toHaveBeenCalledOnce();
  });

  it('does not renew expired cookies or a logout request', () => {
    const session = auth.createSession();
    const cookie = vi.fn();
    const request = { path: '/auth/logout', cookies: { [auth.AUTH_COOKIE]: session.token } };
    auth.renewSessionMiddleware(request as never, { cookie } as never, vi.fn());
    expect(cookie).not.toHaveBeenCalled();
    vi.spyOn(Date, 'now').mockReturnValue(session.expiresAt + 1);
    request.path = '/auth/status';
    auth.renewSessionMiddleware(request as never, { cookie } as never, vi.fn());
    expect(cookie).not.toHaveBeenCalled();
  });

  it('upgrades a still-valid 12-hour session on its next visit', async () => {
    const session = auth.createSession();
    const file = path.join(directory, '.termdock/auth-sessions.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.sessions[0].expiresAt = session.createdAt + 12 * 60 * 60_000;
    fs.writeFileSync(file, JSON.stringify(saved));
    vi.resetModules();
    const restarted = await import('./authProtection.js');
    expect(restarted.isSessionValid(session.token, true)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).sessions[0].expiresAt).toBeGreaterThanOrEqual(session.createdAt + 30 * DAY);
  });
});


it('fails closed when the password configuration cannot be inspected', () => {
  vi.spyOn(fs, 'statSync').mockImplementation(() => {
    throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
  });
  expect(auth.isAuthEnabled()).toBe(true);
  expect(auth.isUpgradeRequestAuthenticated(undefined)).toBe(false);
});
