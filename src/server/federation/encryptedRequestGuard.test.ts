import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';

let directory: string;
let context: typeof import('./requestContext.js');
let auth: typeof import('../utils/authProtection.js');
let csrf: InstanceType<typeof import('../utils/csrfProtection.js').CsrfProtection>;
beforeEach(async () => {
  vi.resetModules();
  directory = mkdtempSync(join(os.tmpdir(), 'termdock-object-auth-test-'));
  vi.spyOn(os, 'homedir').mockReturnValue(directory);
  vi.stubEnv('TERMDOCK_PASSWORD', ''); vi.stubEnv('TERMDOCK_PUBLIC_ORIGIN', '');
  context = await import('./requestContext.js');
  auth = await import('../utils/authProtection.js');
  auth.writeAuthFile(auth.hashPassword('strong test-only password'));
  csrf = new (await import('../utils/csrfProtection.js')).CsrfProtection();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
function response() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response;
}
function request() {
  return { method: 'POST', path: '/api/terminal/one/input', cookies: {}, headers: { 'x-termdock-inner': 'attacker', 'x-termdock-encrypted': 'true' }, encrypted: true } as unknown as Request;
}
describe('encrypted request authentication marker', () => {
  it('cannot be forged by an HTTP header or a request property', () => {
    const req = request(), res = response(), next = vi.fn();
    expect(context.isEncryptedRequest(req)).toBe(false);
    expect(auth.isRequestAuthenticated(req)).toBe(false);
    auth.requireAuth()(req, res, next);
    expect(next).not.toHaveBeenCalled(); expect(res.status).toHaveBeenCalledWith(401);
    csrf.verifyMiddleware()(req, res, next);
    expect(next).not.toHaveBeenCalled(); expect(res.status).toHaveBeenCalledWith(403);
  });
  it('bypasses cookie and CSRF checks only for the internally marked object', () => {
    const req = request(), res = response(), next = vi.fn();
    context.markEncryptedRequest(req);
    expect(auth.isRequestAuthenticated(req)).toBe(true);
    auth.requireAuth()(req, res, next); csrf.verifyMiddleware()(req, res, next);
    expect(next).toHaveBeenCalledTimes(2); expect(res.status).not.toHaveBeenCalled();
    expect(context.isEncryptedRequest({ ...req } as Request)).toBe(false);
    expect(context.isEncryptedRequest(Object.create(req) as Request)).toBe(false);
  });
});
