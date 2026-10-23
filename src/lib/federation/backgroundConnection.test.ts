import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, type Identity } from '../../server/federation/secureProtocol';
import { createFederationRuntime } from '../../server/federation/runtime';
import { encryptedRequestSubject } from '../../server/federation/requestContext';
import { RelayRouter } from '../../server/federation/relay';
import { connectBackgroundTarget } from './backgroundConnection';
import type { BackgroundTarget } from './backgroundState';
const state = vi.hoisted(() => ({ identity: undefined as Identity | undefined }));
vi.mock('./deviceIdentity', () => ({ getIdentity: async () => state.identity! }));
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); vi.unstubAllGlobals(); });
async function fixture() {
  state.identity = await createIdentity();
  vi.stubGlobal('WebSocket', WebSocket);
  vi.stubGlobal('CloseEvent', class extends Event { code: number; reason: string; constructor(type: string, init: { code: number; reason: string }) { super(type); this.code = init.code; this.reason = init.reason; } });
  const dir = mkdtempSync(join(tmpdir(), 'termdock-background-test-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const app = express(); app.use(express.json());
  const received: unknown[] = [];
  app.post('/api/notifications/subscribe', (req, res) => { received.push({ body: req.body, subject: encryptedRequestSubject(req) }); res.json({ ok: true }); });
  app.get('/api/notifications/status', (req, res) => res.json({ subject: encryptedRequestSubject(req) }));
  const handlers = { terminal() {}, control() {} };
  const target = await createFederationRuntime(app, join(dir, 'target'), handlers);
  cleanup.push(() => target.close());
  const grant = target.store.grant({ subjectId: state.identity.peerId, scope: { kind: 'service' }, actions: ['service:*'] });
  const targetServer = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(targetServer, 'listening');
  cleanup.push(() => { for (const socket of targetServer.clients) socket.terminate(); targetServer.close(); });
  const wire: Buffer[] = [];
  targetServer.on('connection', socket => { socket.on('message', bytes => wire.push(Buffer.from(bytes as Buffer))); void target.accept(socket); });
  const targetOrigin = `http://127.0.0.1:${(targetServer.address() as { port: number }).port}`;
  const router = new RelayRouter({ authenticate: value => value === 'verified-ticket' ? 'device' : null, allowRegister: () => false, allowRoute: () => true });
  cleanup.push(() => router.close());
  router.registerDirect(target.serviceId, async () => { const socket = new WebSocket(targetOrigin.replace('http:', 'ws:')); await once(socket, 'open'); return socket; });
  const issue = vi.fn(() => ({ routeToken: 'verified-ticket', expiresAt: Date.now() + 30000 }));
  let routeGranted = true;
  const entry = await createFederationRuntime(express(), join(dir, 'entry'), handlers, { hasRouteGrant: () => routeGranted, issueRouteTicket: issue });
  entry.store.grant({ subjectId: state.identity.peerId, scope: { kind: 'service' }, actions: ['service:*'] });
  cleanup.push(() => entry.close());
  const entryServer = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(entryServer, 'listening');
  cleanup.push(() => { for (const socket of entryServer.clients) socket.terminate(); entryServer.close(); });
  let entrySecureConnections = 0;
  entryServer.on('connection', (socket, req) => {
    const url = new URL(req.url!, 'http://entry');
    if (url.pathname.endsWith('/relay')) void router.attach(socket, url.searchParams.get('routeToken')).then(ok => { if (ok) socket.send(JSON.stringify({ type: 'ready' })); });
    else { entrySecureConnections++; void entry.accept(socket); }
  });
  const config: BackgroundTarget = { targetPeerId: target.serviceId, addresses: [targetOrigin], routes: [{ url: `http://127.0.0.1:${(entryServer.address() as { port: number }).port}`, targetPeerId: entry.serviceId }], publicKey: '', preferences: { aiEnabled: true, exitEnabled: false, alertStyle: 'normal', locale: 'zh-CN' } };
  return { config, received, wire, issue, target, grant, entrySecureConnections: () => entrySecureConnections, revokeRoute() { routeGranted = false; } };
}
it.each(['direct', 'relay'])('updates subscriptions over a real %s encrypted channel without a window or cookie', async mode => {
  const f = await fixture();
  const client = await connectBackgroundTarget({ ...f.config, addresses: mode === 'relay' ? [] : f.config.addresses });
  try {
    const response = await client.fetch('/api/notifications/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-termdock-device': 'forged' }, body: JSON.stringify({ endpoint: 'renew-secret-endpoint' }) });
    expect(response.status).toBe(200); await response.text();
    expect(f.received).toEqual([{ body: { endpoint: 'renew-secret-endpoint' }, subject: state.identity!.peerId }]);
    expect(Buffer.concat(f.wire).includes(Buffer.from('renew-secret-endpoint'))).toBe(false);
    expect(f.issue).toHaveBeenCalledTimes(mode === 'relay' ? 1 : 0);
    f.target.store.revoke(f.grant.id);
    await expect(client.fetch('/api/notifications/status')).rejects.toThrow();
  } finally { client.close(); }
});
it('rejects a changed service pin without falling back to an unauthenticated request', async () => {
  const f = await fixture();
  await expect(connectBackgroundTarget({ ...f.config, targetPeerId: (await createIdentity()).peerId, routes: [] })).rejects.toMatchObject({ code: 'TARGET_IDENTITY_MISMATCH' });
  expect(f.received).toEqual([]);
});
it('does not dial the entry address as the target, even when an old background record calls it direct', async () => {
  const f = await fixture();
  const client = await connectBackgroundTarget({ ...f.config, addresses: [f.config.routes[0].url] });
  cleanup.push(() => client.close());
  expect(f.entrySecureConnections()).toBe(1);
  expect(f.issue).toHaveBeenCalledOnce();
  expect((await client.fetch('/api/notifications/status')).ok).toBe(true);
});
it('uses same-identity alternate routes as direct addresses in the background', async () => {
  const f = await fixture();
  const client = await connectBackgroundTarget({ ...f.config, addresses: [], routes: [{ url: f.config.addresses[0], targetPeerId: f.config.targetPeerId }] });
  cleanup.push(() => client.close());
  expect(f.issue).not.toHaveBeenCalled();
  expect((await client.fetch('/api/notifications/status')).ok).toBe(true);
});
it('preserves confirmed target revocation without falling through to an entry', async () => {
  const f = await fixture(); f.target.store.revoke(f.grant.id);
  await expect(connectBackgroundTarget(f.config)).rejects.toMatchObject({ code: 'TARGET_AUTHORIZATION_REQUIRED' });
  expect(f.issue).not.toHaveBeenCalled(); expect(f.received).toEqual([]);
});
it('preserves confirmed route revocation without replacing it with a generic offline error', async () => {
  const f = await fixture(); f.revokeRoute();
  await expect(connectBackgroundTarget({ ...f.config, addresses: [] })).rejects.toMatchObject({ code: 'RELAY_AUTHORIZATION_REQUIRED' });
  expect(f.issue).not.toHaveBeenCalled(); expect(f.received).toEqual([]);
});
