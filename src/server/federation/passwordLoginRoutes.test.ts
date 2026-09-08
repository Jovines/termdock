import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { createPasswordLoginRouter } from './passwordLoginRoutes.js';
import { startPasswordBootstrap, finishPasswordBootstrap } from './passwordBootstrap.js';
import { recordLoginSuccess } from '../utils/authProtection.js';
import type { FederationRuntime } from './runtime.js';
const originalPassword = process.env.TERMDOCK_PASSWORD;
const originalOrigin = process.env.TERMDOCK_PUBLIC_ORIGIN;
let listener: Server | undefined;
afterEach(async () => {
  if (originalPassword === undefined) delete process.env.TERMDOCK_PASSWORD; else process.env.TERMDOCK_PASSWORD = originalPassword;
  if (originalOrigin === undefined) delete process.env.TERMDOCK_PUBLIC_ORIGIN; else process.env.TERMDOCK_PUBLIC_ORIGIN = originalOrigin;
  recordLoginSuccess('127.0.0.1');
  if (listener) await new Promise<void>(resolve => listener!.close(() => resolve()));
});
async function fixture(ready = true) {
  process.env.TERMDOCK_PASSWORD = 'existing-password'; delete process.env.TERMDOCK_PUBLIC_ORIGIN;
  const grants: string[] = [];
  const runtime = { serviceId: 'server-key', store: { grantPassword: (subject: string) => { grants.push(subject); } } } as unknown as FederationRuntime;
  const app = express(); app.use('/api/auth/password', createPasswordLoginRouter(() => ready ? runtime : undefined));
  listener = createServer(app); await new Promise<void>(resolve => listener!.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const request = (path: string, body?: object) => fetch(`${origin}/api/auth/password/${path}`, { method: body ? 'POST' : 'GET', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { grants, origin, request };
}
describe('public password proof routes', () => {
  it('grants only after a correct bound proof, consumes once and returns no secrets', async () => {
    const f = await fixture(); const params = await (await f.request('parameters')).json();
    expect(Object.keys(params)).toEqual(['saltHex']);
    expect((await f.request('start', { password: 'never-accepted', clientIdentity: 'client-key', startLoginRequest: 'x' })).status).toBe(400);
    const client = await startPasswordBootstrap('existing-password', params.saltHex);
    const response = await (await f.request('start', { clientIdentity: 'client-key', startLoginRequest: client.startLoginRequest })).json();
    expect(f.grants).toEqual([]);
    const proof = await finishPasswordBootstrap(client, response, { clientIdentity: 'client-key', origin: f.origin });
    const body = { attemptId: proof.attemptId, finishLoginRequest: proof.finishLoginRequest };
    expect(await (await f.request('finish', body)).json()).toEqual({ ok: true });
    expect(f.grants).toEqual(['client-key']);
    expect((await f.request('finish', body)).status).toBe(401);
  });
  it('rejects forged proof and throttles abandoned starts', async () => {
    const f = await fixture(); const params = await (await f.request('parameters')).json();
    const client = await startPasswordBootstrap('wrong-password', params.saltHex);
    const response = await (await f.request('start', { clientIdentity: 'client-key', startLoginRequest: client.startLoginRequest })).json();
    expect((await f.request('finish', { attemptId: response.attemptId, finishLoginRequest: 'forged' })).status).toBe(401);
    for (let i = 0; i < 3; i++) await f.request('start', { clientIdentity: 'client-key', startLoginRequest: client.startLoginRequest });
    expect((await f.request('start', { clientIdentity: 'client-key', startLoginRequest: client.startLoginRequest })).status).toBe(429);
    expect(f.grants).toEqual([]);
  });
  it('fails closed before runtime ready', async () => {
    const f = await fixture(false); expect((await f.request('parameters')).status).toBe(503);
  });
});
