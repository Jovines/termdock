import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate, createHash, randomBytes } from 'node:crypto';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { createFederationRuntime } from './runtime.js';
import { createIdentity } from './secureProtocol.js';
import { RelayRouter } from './relay.js';
import { RouteAccess, type RoutePrincipal } from './routeAccess.js';
import { DesktopSelfRelay } from './selfRelay.js';
import { connectCollaborationRpc } from '../agent/collaborationPeerTransport.js';
import { desktopServiceTargets } from './desktopTargets.js';
import { connect } from '../../lib/federation/secureClient.js';
import { RelaySocket } from '../../lib/federation/relaySocket.js';
import * as authProtection from '../utils/authProtection.js';
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it.each(['configured', 'preview'] as const)('keeps A reachable through B using an A-initiated tunnel with %s configuration and no public B-to-A dial', async source => {
  vi.stubEnv('TERMDOCK_PASSWORD', 'reverse-relay-password');
  vi.stubGlobal('CloseEvent', class extends Event { code: number; reason: string; constructor(type: string, init: { code: number; reason: string }) { super(type); this.code = init.code; this.reason = init.reason; } });
  const dir = mkdtempSync(join(tmpdir(), 'td-reverse-relay-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'ca.pem'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  const ca = readFileSync(join(dir, 'ca.pem'));
  execFileSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'leaf-key.pem'), '-out', join(dir, 'leaf.csr'), '-subj', '/CN=localhost'], { stdio: 'ignore' });
  writeFileSync(join(dir, 'leaf.ext'), 'subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\n');
  execFileSync('openssl', ['x509', '-req', '-in', join(dir, 'leaf.csr'), '-CA', join(dir, 'ca.pem'), '-CAkey', join(dir, 'key.pem'), '-CAcreateserial', '-days', '1', '-extfile', join(dir, 'leaf.ext'), '-out', join(dir, 'leaf.pem')], { stdio: 'ignore' });
  const leaf = readFileSync(join(dir, 'leaf.pem')), leafKey = readFileSync(join(dir, 'leaf-key.pem'));
  const phone = await createIdentity();
  const handlers = { terminal(socket: WebSocket) { socket.on('message', data => socket.send(String(data))); }, control() {} };
  const bytes = randomBytes(1024 * 1024), hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
  const app = express();
  app.post('/api/terminal/fs/upload', async (req, res) => {
    const hash = createHash('sha256');
    try { for await (const chunk of req) hash.update(chunk); res.json({ digest: hash.digest('hex') }); } catch { /* cancelled upload */ }
  });
  app.get('/api/terminal/fs/download', (_req, res) => res.end(bytes));
  app.get('/api/notifications/status', (_req, res) => res.json({ ok: true }));
  const a = await createFederationRuntime(app, join(dir, 'a'), handlers); cleanups.push(() => a.close());
  a.store.grant({ subjectId: phone.peerId, scope: { kind: 'service' }, actions: ['service:*'] });
  const local = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(local, 'listening');
  cleanups.push(() => { for (const ws of local.clients) ws.terminate(); local.close(); });
  local.on('connection', (ws, req) => void a.accept(ws, { relayed: req.url === '/api/federation/relay-target' }));
  const localOrigin = `http://127.0.0.1:${(local.address() as { port: number }).port}`;
  let router: RelayRouter<RoutePrincipal>;
  let revoked = false;
  const access = new RouteAccess(join(dir, 'routes.json'), Date.now, subject => subject === phone.peerId && !revoked,
    () => [], () => router.registeredRouteIds());
  const b = await createFederationRuntime(express(), join(dir, 'b'), handlers, {
    issueSelfRelayTicket: id => access.issueSelfRelayTicket(id),
    hasRouteGrant: subject => subject === phone.peerId && !revoked,
    issueRouteTicket: (subject, target) => access.issueRouteTicket(subject, target),
    listRouteTargets: () => access.configuredTargets().map(target => ({ ...target, available: router.hasRoute(target.serviceId), ...(router.routeError(target.serviceId) ? { error: router.routeError(target.serviceId) } : {}) })),
  }); cleanups.push(() => b.close());
  b.store.grant({ subjectId: phone.peerId, scope: { kind: 'service' }, actions: ['service:*'] });
  router = new RelayRouter<RoutePrincipal>({ requirePasswordProtectedTargets: true, authenticate: principal => principal as RoutePrincipal,
    allowRegister: (p, id) => access.allowRegister(p, id), allowRoute: (p, id) => access.allowRoute(p, id), heartbeatMs: 200 });
  cleanups.push(() => router.close());
  const entry = createServer({ cert: leaf, key: leafKey }, (req, res) => { if (req.url === '/onboarding/ca.crt') res.end(ca); else res.writeHead(404).end(); });
  const wss = new WebSocketServer({ server: entry });
  const providers = new Set<WebSocket>();
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url!, 'https://entry');
    if (url.pathname === '/api/federation/secure') { void b.accept(ws); return; }
    const principal = url.searchParams.has('selfRelayToken') ? access.authenticateSelfRelay(url.searchParams.get('selfRelayToken')) : access.authenticate(undefined, url.searchParams.get('routeToken'));
    if (!principal) { ws.close(1008); return; }
    if (url.searchParams.has('selfRelayToken')) { providers.add(ws); ws.once('close', () => providers.delete(ws)); }
    void router.attach(ws, principal).then(ok => { if (ok) ws.send(JSON.stringify({ type: 'ready' })); });
  });
  entry.listen(0, '127.0.0.1'); await once(entry, 'listening');
  cleanups.push(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); entry.close(); });
  const origin = `https://127.0.0.1:${(entry.address() as { port: number }).port}`;
  const previewDir = join(dir, 'Library', 'Application Support', 'com.jovines.termdock.preview');
  mkdirSync(previewDir, { recursive: true });
  const previewFile = join(previewDir, 'connections.json');
  const alternateOrigin = origin.replace('127.0.0.1', 'localhost');
  const preview = { version: 1, connections: [{ id: 'local', targetPeerId: a.serviceId, url: localOrigin }, { id: 'entry', targetPeerId: b.serviceId, url: origin,
    routes: [{ url: alternateOrigin, targetPeerId: b.serviceId }] }], removedKeys: [] as string[], certificatePins: {
      [origin]: new X509Certificate(leaf).fingerprint256.replaceAll(':', '').toLowerCase(),
      [alternateOrigin]: new X509Certificate(leaf).fingerprint256.replaceAll(':', '').toLowerCase(),
    } };
  const save = () => writeFileSync(previewFile, JSON.stringify(preview));
  if (source === 'preview') save();
  const selfRelay = new DesktopSelfRelay({ desktopFile: join(dir, 'absent-desktop.json'), identity: a.identity, serviceId: a.serviceId,
    localOrigin: () => localOrigin, baseDir: dir, targets: () => source === 'preview' ? desktopServiceTargets(dir, a.serviceId, 'darwin') : [{ serviceId: b.serviceId, url: origin, caPath: 'ca.pem' }] });
  cleanups.push(() => selfRelay.close()); selfRelay.start();
  await vi.waitFor(() => expect(router.hasRoute(a.serviceId)).toBe(true), { timeout: 3000 });
  if (source === 'preview') {
    await vi.waitFor(() => expect(router.providerCount(a.serviceId)).toBe(2), { timeout: 3000 });
    const first = [...providers][0]; first.terminate();
    await vi.waitFor(() => expect(providers.has(first)).toBe(false));
    expect(router.hasRoute(a.serviceId)).toBe(true);
  }
  const entryNode = { serviceId: b.serviceId, origin, caFingerprint256: new X509Certificate(ca).fingerprint256 };
  await expect(connectCollaborationRpc(phone, { serviceId: a.serviceId, origin: 'https://127.0.0.1:1' })).rejects.toThrow();
  let entryClient = await connectCollaborationRpc(phone, entryNode); cleanups.push(() => entryClient.close());
  expect(await entryClient.request({ type: 'route-targets' })).toMatchObject({ canManage: true, items: [{ serviceId: a.serviceId, available: true }] });
  const phoneConnect = async () => {
    const ticket = await entryClient.request({ type: 'route-ticket', serviceId: a.serviceId });
    const url = new URL('/api/federation/relay', origin.replace('https:', 'wss:')); url.searchParams.set('routeToken', String(ticket.routeToken));
    const client = await connect({ url: url.href, targetPeerId: a.serviceId, identity: phone,
      socketFactory: address => new RelaySocket(address, a.serviceId, value => new WebSocket(value, { ca }) as unknown as globalThis.WebSocket) as unknown as globalThis.WebSocket });
    cleanups.push(() => client.close()); return client;
  };
  let browser = await phoneConnect();
  const upload = await browser.fetch('/api/terminal/fs/upload', { method: 'POST', body: bytes });
  expect(await upload.json()).toEqual({ digest: hash(bytes) });
  const download = await browser.fetch('/api/terminal/fs/download');
  expect(hash(new Uint8Array(await download.arrayBuffer()))).toBe(hash(bytes));
  expect(await (await browser.fetch('/api/notifications/status')).json()).toEqual({ ok: true });
  const terminal = browser.openSocket('/api/terminal/one/ws');
  const output: string[] = []; terminal.onmessage = event => output.push(JSON.parse(String(event.data)).data);
  await vi.waitFor(() => expect(terminal.readyState).toBe(1));
  terminal.send(JSON.stringify({ type: 'input', data: 'hello reverse tunnel' }));
  await vi.waitFor(() => expect(output).toContain('hello reverse tunnel')); terminal.close();
  const cancelled = await browser.fetch('/api/terminal/fs/download');
  await cancelled.body!.cancel();
  expect(await browser.request({ type: 'permissions' })).toMatchObject({ fullService: true });
  if (source === 'preview') {
    // Dropping the provider forces a fresh authenticated connection; input is not replayed.
    for (const ws of wss.clients) ws.terminate();
    await vi.waitFor(() => expect(browser.closed).toBe(true));
    await vi.waitFor(() => expect(router.hasRoute(a.serviceId)).toBe(true), { timeout: 5000 });
    // The entry RPC also disconnected; reopen it independently of the page connection.
    const reconnectedEntry = await connectCollaborationRpc(phone, entryNode);
    cleanups.push(() => reconnectedEntry.close());
    const ticket = await reconnectedEntry.request({ type: 'route-ticket', serviceId: a.serviceId });
    const relayUrl = new URL('/api/federation/relay', origin.replace('https:', 'wss:')); relayUrl.searchParams.set('routeToken', String(ticket.routeToken));
    browser = await connect({ url: relayUrl.href, targetPeerId: a.serviceId, identity: phone,
      socketFactory: address => new RelaySocket(address, a.serviceId, value => new WebSocket(value, { ca }) as unknown as globalThis.WebSocket) as unknown as globalThis.WebSocket });
    cleanups.push(() => browser.close());
    expect(await browser.request({ type: 'permissions' })).toMatchObject({ fullService: true });
    const trusted = preview.certificatePins[origin];
    preview.certificatePins[origin] = '00'.repeat(32); preview.certificatePins[alternateOrigin] = '00'.repeat(32); save();
    await vi.waitFor(() => expect(router.hasRoute(a.serviceId)).toBe(false), { timeout: 4000 });
    await vi.waitFor(() => expect(browser.closed).toBe(true));
    preview.certificatePins[origin] = trusted; preview.certificatePins[alternateOrigin] = trusted; save();
    await vi.waitFor(() => expect(router.hasRoute(a.serviceId)).toBe(true), { timeout: 4000 });
    preview.removedKeys = [b.serviceId]; save();
    await vi.waitFor(() => expect(router.hasRoute(a.serviceId)).toBe(false), { timeout: 4000 });
    await vi.waitFor(() => expect(browser.closed).toBe(true));
    expect(await reconnectedEntry.request({ type: 'route-targets' })).toMatchObject({ items: [] });
    preview.removedKeys = []; save();
    await vi.waitFor(() => expect(router.hasRoute(a.serviceId)).toBe(true), { timeout: 4000 });
  }
  const finalEntry = await connectCollaborationRpc(phone, entryNode); cleanups.push(() => finalEntry.close());
  entryClient = finalEntry;
  const ticket = await finalEntry.request({ type: 'route-ticket', serviceId: a.serviceId });
  const url = new URL('/api/federation/relay', origin.replace('https:', 'wss:')); url.searchParams.set('routeToken', String(ticket.routeToken));
  const throughB = await connectCollaborationRpc(phone, { ...entryNode, serviceId: a.serviceId }, url.href); cleanups.push(() => throughB.close());
  expect(await throughB.request({ type: 'permissions' })).toMatchObject({ fullService: true });
  // B's relay permission cannot grant terminal authority on A.
  expect(a.store.authorize({ subjectId: b.serviceId, serviceId: a.serviceId, action: 'authorization.manage' }).allowed).toBe(false);
  revoked = true;
  await vi.waitFor(() => expect(throughB.closed).toBe(true));
  revoked = false;
  const beforeRemoval = await phoneConnect();
  const verifier = vi.spyOn(authProtection, 'getPasswordVerifier').mockReturnValue(null); cleanups.push(() => verifier.mockRestore());
  await vi.waitFor(() => expect(beforeRemoval.closed).toBe(true), { timeout: 4000 });
  await vi.waitFor(() => expect(router.routeError(a.serviceId)).toBe('TARGET_PASSWORD_REQUIRED'), { timeout: 4000 });
  expect(router.hasRoute(a.serviceId)).toBe(false);
  expect(router.registeredRouteIds()).toContain(a.serviceId);
  expect(await finalEntry.request({ type: 'route-targets' })).toMatchObject({ items: [{ serviceId: a.serviceId, available: false, error: 'TARGET_PASSWORD_REQUIRED' }] });
  await expect(phoneConnect()).rejects.toMatchObject({ code: 'TARGET_PASSWORD_REQUIRED' });
  verifier.mockRestore();
  await vi.waitFor(() => expect(router.hasRoute(a.serviceId)).toBe(true), { timeout: 4000 });
  selfRelay.close(); await vi.waitFor(() => expect(router.hasRoute(a.serviceId)).toBe(false));
}, 20000);
