import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createFederationRuntime } from './runtime.js';
import { createIdentity } from './secureProtocol.js';
import { RelayRouter } from './relay.js';
import { RouteAccess, type RoutePrincipal } from './routeAccess.js';
import { DesktopSelfRelay } from './selfRelay.js';
import { connectCollaborationRpc } from '../agent/collaborationPeerTransport.js';
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
it('keeps A reachable through B using an A-initiated tunnel without a desktop directory or a public B-to-A dial', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'td-reverse-relay-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'ca.pem'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  const ca = readFileSync(join(dir, 'ca.pem')), key = readFileSync(join(dir, 'key.pem'));
  const phone = await createIdentity();
  const handlers = { terminal() {}, control() {} };
  const a = await createFederationRuntime(express(), join(dir, 'a'), handlers); cleanups.push(() => a.close());
  a.store.grant({ subjectId: phone.peerId, scope: { kind: 'service' }, actions: ['service:*'] });
  const local = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(local, 'listening');
  cleanups.push(() => { for (const ws of local.clients) ws.terminate(); local.close(); });
  local.on('connection', ws => void a.accept(ws));
  const localOrigin = `http://127.0.0.1:${(local.address() as { port: number }).port}`;
  let router: RelayRouter<RoutePrincipal>;
  let revoked = false;
  const access = new RouteAccess(join(dir, 'routes.json'), Date.now, subject => subject === phone.peerId && !revoked,
    () => [], () => router.activeRouteIds());
  const b = await createFederationRuntime(express(), join(dir, 'b'), handlers, {
    issueSelfRelayTicket: id => access.issueSelfRelayTicket(id),
    hasRouteGrant: subject => subject === phone.peerId && !revoked,
    issueRouteTicket: (subject, target) => access.issueRouteTicket(subject, target),
  }); cleanups.push(() => b.close());
  b.store.grant({ subjectId: phone.peerId, scope: { kind: 'service' }, actions: ['service:*'] });
  router = new RelayRouter<RoutePrincipal>({ authenticate: principal => principal as RoutePrincipal,
    allowRegister: (p, id) => access.allowRegister(p, id), allowRoute: (p, id) => access.allowRoute(p, id), heartbeatMs: 50 });
  cleanups.push(() => router.close());
  const entry = createServer({ cert: ca, key }, (req, res) => { if (req.url === '/onboarding/ca.crt') res.end(ca); else res.writeHead(404).end(); });
  const wss = new WebSocketServer({ server: entry });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url!, 'https://entry');
    if (url.pathname === '/api/federation/secure') { void b.accept(ws); return; }
    const principal = url.searchParams.has('selfRelayToken') ? access.authenticateSelfRelay(url.searchParams.get('selfRelayToken')) : access.authenticate(undefined, url.searchParams.get('routeToken'));
    if (!principal) { ws.close(1008); return; }
    void router.attach(ws, principal).then(ok => { if (ok) ws.send(JSON.stringify({ type: 'ready' })); });
  });
  entry.listen(0, '127.0.0.1'); await once(entry, 'listening');
  cleanups.push(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); entry.close(); });
  const origin = `https://127.0.0.1:${(entry.address() as { port: number }).port}`;
  const selfRelay = new DesktopSelfRelay({ desktopFile: join(dir, 'absent-desktop.json'), identity: a.identity, serviceId: a.serviceId,
    localOrigin, baseDir: dir, targets: () => [{ serviceId: b.serviceId, url: origin, caPath: 'ca.pem' }] });
  cleanups.push(() => selfRelay.close()); selfRelay.start();
  await vi.waitFor(() => expect(router.hasRoute(a.serviceId)).toBe(true), { timeout: 3000 });
  const entryNode = { serviceId: b.serviceId, origin, caFingerprint256: new X509Certificate(ca).fingerprint256 };
  await expect(connectCollaborationRpc(phone, { serviceId: a.serviceId, origin: 'https://127.0.0.1:1' })).rejects.toThrow();
  const entryClient = await connectCollaborationRpc(phone, entryNode); cleanups.push(() => entryClient.close());
  const ticket = await entryClient.request({ type: 'route-ticket', serviceId: a.serviceId });
  const url = new URL('/api/federation/relay', origin.replace('https:', 'wss:')); url.searchParams.set('routeToken', String(ticket.routeToken));
  const throughB = await connectCollaborationRpc(phone, { ...entryNode, serviceId: a.serviceId }, url.href); cleanups.push(() => throughB.close());
  expect(await throughB.request({ type: 'permissions' })).toMatchObject({ fullService: true });
  // B's relay permission cannot grant terminal authority on A.
  expect(a.store.authorize({ subjectId: b.serviceId, serviceId: a.serviceId, action: 'authorization.manage' }).allowed).toBe(false);
  revoked = true;
  await vi.waitFor(() => expect(throughB.closed).toBe(true));
  selfRelay.close(); await vi.waitFor(() => expect(router.hasRoute(a.serviceId)).toBe(false));
}, 15000);
