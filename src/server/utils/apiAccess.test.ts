// @vitest-environment node
import express from 'express';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
let apiAccessGate: typeof import('./apiAccess.js')['apiAccessGate'];
let isTrustedLocalRequest: typeof import('./apiAccess.js')['isTrustedLocalRequest'];
import cookieParser from 'cookie-parser';
import fs from 'fs';
import os from 'os';
import path from 'path';

let home: string;
beforeEach(async () => {
  vi.resetModules();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-gate-test-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.stubEnv('TERMDOCK_PASSWORD', 'test-only-long-password');
  ({ apiAccessGate, isTrustedLocalRequest } = await import('./apiAccess.js'));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });

describe('default-private API gate', () => {
  it('rejects anonymous existing and future routes before body parsing', async () => {
    const app = express();
    app.use(cookieParser());
    app.use('/api', apiAccessGate('local-test-token'));
    app.use(express.json({ limit: '2kb' }));
    app.use((_req, res) => res.json({ ok: true }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const route of ['/api/terminal/create', '/api/client-log', '/api/future-admin', '/api/terminal/fs/preview-escape', '/api/terminal/fs/preview/anything']) {
        const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'invalid JSON' });
        expect(response.status, route).toBe(401);
      }
      expect((await fetch(base + '/api/auth/status')).status).toBe(200);
      expect((await fetch(base + '/api/terminal/client-state', { headers: { 'X-Termdock-Local-Token': 'local-test-token' } })).status).toBe(200);
      expect((await fetch(base + '/api/terminal/client-state', { headers: { 'X-Termdock-Local-Token': 'local-test-token', Origin: 'https://attacker.example' } })).status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('requires loopback plus the secret; forwarded headers cannot supply trust', () => {
    const req = {
      header: () => 'local-test-token',
      headers: { 'x-forwarded-for': '127.0.0.1' },
      socket: { remoteAddress: '203.0.113.1' },
    } as unknown as express.Request;
    expect(isTrustedLocalRequest(req, 'local-test-token')).toBe(false);
  });
});
