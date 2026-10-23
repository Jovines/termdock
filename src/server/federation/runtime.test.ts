import { startPasswordBootstrap, finishPasswordBootstrap, type PasswordBootstrapResponse } from './passwordBootstrap.js';
import * as authProtection from '../utils/authProtection.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createFederationRuntime, type FederationRuntimeOptions } from './runtime.js';
import { createIdentity, secureConnection, type Identity } from './secureProtocol.js';
import { socketDuplex } from './socketDuplex.js';
import { PacketChannel, fromBase64, toBase64, type Packet } from './packets.js';
import { collaborationTaskRoutes } from '../agent/collaborationTaskRoutes.js';
import type { CollaborationStore } from '../agent/collaborationStore.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture(runtimeOptions: FederationRuntimeOptions = {}, allowOpenAccess = false, onComputer?: (socket: WebSocket) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'termdock-e2ee-test-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const app = express(); app.use(express.json());
  const inventory = { clientSessions: [
    { backendSessionId: 'one', sessionId: 'source-one', name: 'Allowed', live: true, cwd: '/private', frontendSessionId: 'frontend-secret' },
    { backendSessionId: 'two', name: 'Hidden', live: true },
    { backendSessionId: null, name: 'Detached' },
  ], tmuxSessions: [{ name: 'unbound-secret' }], tmuxRecovery: { secret: true } };
  const input = vi.fn(), received = vi.fn();
  const uploads = { started: 0, finished: 0, aborted: 0, bytes: 0 };
  app.post('/api/terminal/fs/upload', async (req, res) => {
    uploads.started++;
    if (req.query.reject) { res.status(413).end(); return; }
    req.once('aborted', () => { uploads.aborted++; });
    let bytes = 0;
    try {
      for await (const chunk of req) { bytes += chunk.length; uploads.bytes += chunk.length; }
      uploads.finished++; res.json({ bytes });
    } catch { /* A cancelled streaming upload intentionally aborts this reader. */ }
  });
  app.get('/api/terminal/session-inventory', (_req, res) => res.json(inventory));
  app.get('/api/terminal/:session/health', (req, res) => res.json({ output: 'private-terminal-output', session: req.params.session }));
  app.post('/api/terminal/:session/input', (req, res) => { input(req.body); res.json({ success: true }); });
  let terminal: WebSocket | undefined, computer: WebSocket | undefined, android: WebSocket | undefined;
  const computerOptions = vi.fn();
  const terminalOptions = vi.fn();
  const issueRouteTicket = vi.fn(() => ({ routeToken: 'test-route-ticket', expiresAt: Date.now() + 30_000 }));
  const runtime = await createFederationRuntime(app, directory, {
    terminal(socket, _session, _client, options, dimensions) { terminal = socket; terminalOptions(options, dimensions); socket.on('message', data => received(JSON.parse(String(data)))); socket.send(JSON.stringify({ type: 'output', data: 'private-terminal-output' })); },
    control(socket) { socket.on('message', data => received(JSON.parse(String(data)))); },
    android(socket) { android = socket; socket.on('message', data => received(JSON.parse(String(data)))); },
    computer(socket, _host, options) { computerOptions(options); computer = socket; onComputer?.(socket); },
  }, { resolveSessionId: id => id === 'one' || id === 'one-new' ? 'source-one' : id, issueRouteTicket, ...runtimeOptions });
  cleanup.push(() => runtime.close());
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  server.on('connection', socket => { void runtime.accept(socket, { allowOpenAccess }); });
  cleanup.push(() => { for (const socket of server.clients) socket.terminate(); server.close(); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No listener');
  const url = `ws://127.0.0.1:${address.port}`;
  async function connect(existingIdentity?: Identity) {
    const identity = existingIdentity ?? await createIdentity();
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    cleanup.push(() => socket.terminate());
    const wire: Uint8Array[] = [];
    socket.on('message', data => wire.push(new Uint8Array(data as ArrayBuffer).slice()));
    const secured = await secureConnection({ identity, initiator: true, targetPinnedPeerId: runtime.serviceId, duplex: socketDuplex(socket) });
    const channel = new PacketChannel(secured.duplex);
    const pending: Packet[] = [];
    let wake: (() => void) | undefined;
    void (async () => { try { for await (const packet of channel.read()) { pending.push(packet); wake?.(); } } catch { /* teardown */ } })();
    cleanup.push(() => channel.close());
    async function take(id: string, type?: string): Promise<Packet> {
      const end = Date.now() + 3000;
      while (true) {
        const index = pending.findIndex(packet => packet.id === id && (!type || packet.type === type));
        if (index >= 0) return pending.splice(index, 1)[0];
        if (Date.now() >= end) throw new Error(`Missing packet ${id}/${type}; got ${JSON.stringify(pending)}`);
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, 50); wake = () => { clearTimeout(timer); resolve(); }; });
      }
    }
    async function pair() {
      const { pairingCode } = JSON.parse(readFileSync(join(directory, 'pairing.json'), 'utf8'));
      channel.send({ type: 'pair', id: 'pair', code: pairingCode }); return take('pair');
    }
    async function http(id: string, method: string, path: string): Promise<Packet[]> {
      channel.send({ type: 'http', id, method, path }); channel.send({ type: 'upload-end', id });
      const packets: Packet[] = [];
      while (true) {
        const packet = await take(id); packets.push(packet);
        if (packet.type === 'chunk') channel.send({ type: 'ack', id });
        if (packet.type === 'end' || packet.type === 'error') return packets;
      }
    }
    return { identity, channel, take, pair, http, wire, pendingPackets: () => pending,
      pauseReads() { (socket as unknown as { _socket?: { pause(): void } })._socket?.pause(); },
      resumeReads() { (socket as unknown as { _socket?: { resume(): void } })._socket?.resume(); } };
  }
  return { app, directory, connect, runtime, input, received, uploads, issueRouteTicket, terminalOptions, computerOptions, android: () => android, terminal: () => terminal, computer: () => computer, inventory };
}

describe('federation runtime over real encrypted WebSocket', () => {
  it('rejects self target grant, ticket and invitation before invoking configuration or authorization writers', async () => {
    const grant = vi.fn(), invite = vi.fn();
    const f = await fixture({ grantRouteAccess: grant, createRouteInvitation: invite, hasRouteGrant: () => true });
    const owner = await f.connect(); await owner.pair();
    for (const type of ['route-grant', 'route-ticket', 'route-invite-create']) {
      owner.channel.send({ id: type, type, serviceId: f.runtime.serviceId, subjectId: owner.identity.peerId });
      expect(await owner.take(type)).toMatchObject({ type: 'error', error: 'RELAY_SELF_TARGET' });
    }
    expect(grant).not.toHaveBeenCalled(); expect(invite).not.toHaveBeenCalled(); expect(f.issueRouteTicket).not.toHaveBeenCalled();
  });
  it('lets administrators revoke pending session invitations and denies their redemption', async () => {
    const f = await fixture(), owner = await f.connect(); await owner.pair();
    owner.channel.send({ type: 'invite-create', id: 'invite', scope: { kind: 'sessions', sessionIds: ['one'] }, actions: ['session.view', 'session.input'] });
    const invite = await owner.take('invite');
    expect(invite).toMatchObject({ type: 'result', id: 'invite', invitationId: expect.any(String) });
    owner.channel.send({ type: 'grants-list', id: 'list' });
    const list = await owner.take('list');
    expect(list.invitations).toEqual([expect.objectContaining({ id: invite.invitationId, scope: { kind: 'sessions', sessionIds: ['source-one'] } })]);
    expect(JSON.stringify(list)).not.toContain(invite.code);
    const phone = await f.connect();
    phone.channel.send({ type: 'invite-revoke', id: 'forbidden', invitationId: invite.invitationId });
    expect(await phone.take('forbidden')).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
    phone.channel.send({ type: 'grants-list', id: 'forbidden-list' });
    expect(await phone.take('forbidden-list')).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
    owner.channel.send({ type: 'invite-revoke', id: 'cancel', invitationId: invite.invitationId });
    expect(await owner.take('cancel')).toMatchObject({ type: 'result', revoked: true });
    phone.channel.send({ type: 'pair', id: 'redeem', code: invite.code });
    expect(await phone.take('redeem')).toMatchObject({ type: 'error', error: 'PAIRING_DENIED' });
    owner.channel.send({ type: 'grants-list', id: 'after' });
    expect(await owner.take('after')).toMatchObject({ invitations: [] });
  });
  it('revokes a redeemed session grant while preserving another grant on the same device', async () => {
    const f = await fixture(), owner = await f.connect(); await owner.pair();
    owner.channel.send({ type: 'invite-create', id: 'invite', scope: { kind: 'sessions', sessionIds: ['one'] }, actions: ['session.view', 'session.input'] });
    const invite = await owner.take('invite'), phone = await f.connect();
    phone.channel.send({ type: 'pair', id: 'redeem', code: invite.code });
    expect(await phone.take('redeem')).toMatchObject({ type: 'result' });
    const grant = f.runtime.store.list().find(g => g.subjectId === phone.identity.peerId)!;
    const other = f.runtime.store.grant({ subjectId: phone.identity.peerId, scope: { kind: 'sessions', sessionIds: ['two'] }, actions: ['session.view'] });
    phone.channel.send({ type: 'ws-open', id: 'terminal', path: '/api/terminal/one/ws' });
    await phone.take('terminal', 'ws-ready'); await phone.take('terminal', 'ws-data');
    owner.channel.send({ type: 'invite-revoke', id: 'already-used', invitationId: invite.invitationId });
    expect(await owner.take('already-used')).toMatchObject({ revoked: false });
    owner.channel.send({ type: 'revoke', id: 'revoke', grantId: grant.id });
    expect(await owner.take('revoke')).toMatchObject({ revoked: true });
    expect(await phone.take('terminal', 'ws-close')).toMatchObject({ code: 4003 });
    expect((await phone.http('input-denied', 'POST', '/api/terminal/one/input'))[0]).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
    expect((await phone.http('other', 'GET', '/api/terminal/two/health'))[0]).toMatchObject({ type: 'head', status: 200 });
    expect(f.runtime.store.list().find(g => g.id === other.id)?.revokedAt).toBeUndefined();
  });
  it('lets open full-service devices read the task inbox without granting peer administration', async () => {
    let enabled = false;
    const spy = vi.spyOn(authProtection, 'isAuthEnabled').mockImplementation(() => enabled);
    cleanup.push(() => spy.mockRestore());
    const f = await fixture({}, true), client = await f.connect();
    const list = vi.fn(() => []);
    f.app.locals.passwordRuntime = f.runtime;
    f.app.locals.collaborationTasks = { list };
    f.app.locals.collaborationService = {};
    f.app.use('/api/terminal/operations/collaboration-tasks', collaborationTaskRoutes({ agent: false,
      store: { list: () => [{ id: 'group' }] } as unknown as CollaborationStore, resolveSession: () => null }));
    const path = '/api/terminal/operations/collaboration-tasks';
    expect((await client.http('open-inbox', 'GET', path))[0]).toMatchObject({ type: 'head', status: 200 });
    expect(list).toHaveBeenCalledOnce();
    expect((await client.http('open-mutation', 'POST', path))[0]).toMatchObject({ type: 'head', status: 403 });
    expect(f.runtime.store.list()).toEqual([]);
    enabled = true;
    f.runtime.store.grant({ subjectId: client.identity.peerId, scope: { kind: 'service' }, actions: ['service.view'] });
    expect((await client.http('narrow-inbox', 'GET', path))[0]).toMatchObject({ type: 'error' });
    expect(list).toHaveBeenCalledOnce();
    client.channel.send({ type: 'http', id: 'spoof-inbox', method: 'GET', path,
      headers: { 'x-termdock-full-service': '1' } });
    expect(await client.take('spoof-inbox')).toMatchObject({ type: 'error' });
    expect(list).toHaveBeenCalledOnce();
  });
  it('reads and edits native architecture through the encrypted channel with separate file grants', async () => {
    const f = await fixture();
    const { architectureRoutes } = await import('../architecture/routes.js');
    f.app.use('/api/terminal/architecture', architectureRoutes());
    const { ArchitectureStore } = await import('../architecture/store.js');
    await new ArchitectureStore(f.directory).save('.termdock/architecture.json', { version: 1, generatedAt: '2026-10-09T09:00:00Z', summary: 'encrypted-architecture-private-content', perspectives: [{ id: 'overall', title: 'Overall', summary: 'Structure', nodes: [{ id: 'server', title: 'Server', summary: 'Server description', files: [] }], edges: [] }] });
    const owner = await f.connect(), reader = await f.connect();
    const route = `/api/terminal/architecture/document?root=${encodeURIComponent(f.directory)}`;
    expect((await reader.http('unpaired-map', 'GET', route))[0]).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
    await owner.pair();
    owner.channel.send({ type: 'grant', id: 'map-read-grant', grant: { subjectId: reader.identity.peerId, scope: { kind: 'service' }, actions: ['file.read'] } }); await owner.take('map-read-grant');
    const response = await reader.http('map-read', 'GET', route);
    expect(response[0]).toMatchObject({ type: 'head', status: 200 });
    const body = JSON.parse(response.filter(packet => packet.type === 'chunk').map(packet => new TextDecoder().decode(fromBase64(String(packet.data)))).join(''));
    expect(body.document.summary).toBe('encrypted-architecture-private-content');
    reader.channel.send({ type: 'http', id: 'map-write-denied', method: 'PUT', path: '/api/terminal/architecture/field' });
    expect(await reader.take('map-write-denied')).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
    owner.channel.send({ type: 'http', id: 'map-write', method: 'PUT', path: '/api/terminal/architecture/field', headers: { 'content-type': 'application/json' } });
    owner.channel.send({ type: 'upload', id: 'map-write', data: toBase64(new TextEncoder().encode(JSON.stringify({ root: f.directory, perspective: 'overall', node: 'server', field: 'description', value: 'architecture-private-node-document', revision: body.revision }))) });
    await owner.take('map-write', 'upload-ack'); owner.channel.send({ type: 'upload-end', id: 'map-write' });
    expect(await owner.take('map-write', 'head')).toMatchObject({ status: 200 });
    const updated = await owner.take('map-write', 'chunk'); owner.channel.send({ type: 'ack', id: 'map-write' }); await owner.take('map-write', 'end');
    expect(JSON.parse(new TextDecoder().decode(fromBase64(String(updated.data)))).document.perspectives[0].nodes[0].description).toBe('architecture-private-node-document');
    for (const wire of [...owner.wire, ...reader.wire]) expect(new TextDecoder().decode(wire)).not.toContain('architecture-private');
    owner.channel.send({ type: 'logout', id: 'map-logout' }); await owner.take('map-logout');
    expect((await owner.http('map-revoked', 'GET', route))[0]).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
  });

  it('loads password-protected HTML and assets without cookies and binds preview tokens to the encrypted device', async () => {
    const spy = vi.spyOn(authProtection, 'isAuthEnabled').mockReturnValue(true);
    cleanup.push(() => spy.mockRestore());
    const f = await fixture();
    const { default: filesystem } = await import('../routes/filesystem.js');
    f.app.use('/api/terminal/fs', filesystem);
    writeFileSync(join(f.directory, 'index.html'), '<html><body>encrypted-preview-document<img src="image.svg"></body></html>');
    writeFileSync(join(f.directory, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const owner = await f.connect(), other = await f.connect();
    await owner.pair(); await other.pair();
    const initial = await owner.http('preview-initial', 'GET', `/api/terminal/fs/preview${f.directory}/index.html`);
    expect(initial[0]).toMatchObject({ type: 'head', status: 302 });
    const target = (initial[0].headers as Record<string, string>).location;
    const document = await owner.http('preview-document', 'GET', target);
    expect(document[0]).toMatchObject({ type: 'head', status: 200 });
    expect(document.filter(p => p.type === 'chunk').map(p => new TextDecoder().decode(fromBase64(String(p.data)))).join('')).toContain('encrypted-preview-document');
    expect((await owner.http('preview-image', 'GET', target.replace(/index.html$/, 'image.svg')))[0]).toMatchObject({ status: 200 });
    expect((await other.http('preview-other-device', 'GET', target))[0]).toMatchObject({ status: 403 });
    expect((await owner.http('preview-owner-again', 'GET', target))[0]).toMatchObject({ status: 200 });
    owner.channel.send({ type: 'logout', id: 'preview-logout' });
    await owner.take('preview-logout');
    expect((await owner.http('preview-revoked', 'GET', target))[0]).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
    expect(owner.wire.every(chunk => !new TextDecoder().decode(chunk).includes('encrypted-preview-document'))).toBe(true);
  });

  it('keeps device names separate from permissions and protects other devices from renaming', async () => {
    const f = await fixture(), owner = await f.connect(), other = await f.connect();
    await owner.pair();
    other.channel.send({ type: 'device-name', id: 'unauthorized', name: 'Unknown' });
    expect(await other.take('unauthorized')).toMatchObject({ type: 'error' });
    owner.channel.send({ type: 'grant', id: 'read-grant', grant: { subjectId: other.identity.peerId, scope: { kind: 'service' }, actions: ['session.view'] } });
    await owner.take('read-grant');
    other.channel.send({ type: 'device-name', id: 'self', name: 'iPhone · Safari', onlyIfMissing: true });
    expect(await other.take('self')).toMatchObject({ name: 'iPhone · Safari' });
    other.channel.send({ type: 'device-name', id: 'forbidden', subjectId: owner.identity.peerId, name: 'Spoof' });
    expect(await other.take('forbidden')).toMatchObject({ type: 'error' });
    owner.channel.send({ type: 'device-name', id: 'rename', subjectId: other.identity.peerId, name: '我的手机' });
    expect(await owner.take('rename')).toMatchObject({ name: '我的手机' });
    other.channel.send({ type: 'device-name', id: 'auto', name: 'iPhone · Safari', onlyIfMissing: true });
    expect(await other.take('auto')).toMatchObject({ name: '我的手机' });
    owner.channel.send({ type: 'grants-list', id: 'names' });
    expect((await owner.take('names')).subjectLabels).toMatchObject({ [other.identity.peerId]: '我的手机' });
  });

  it('keeps HTTP available alongside many long-lived terminal subscriptions', async () => {
    const f = await fixture(), client = await f.connect(); await client.pair();
    for (let index = 0; index < 40; index++) {
      const id = `terminal-${index}`;
      client.channel.send({ type: 'ws-open', id, path: '/api/terminal/one/ws' });
      expect(await client.take(id, 'ws-ready')).toMatchObject({ type: 'ws-ready' });
      await client.take(id, 'ws-data');
    }
    const result = await client.http('file-after-restore', 'GET', '/api/terminal/one/health');
    expect(result[0]).toMatchObject({ type: 'head', status: 200 });
    expect(result.at(-1)?.type).toBe('end');
  });
  it('keeps open access transient, direct-only and immediately closes it when a password is enabled', async () => {
    let enabled = false;
    const spy = vi.spyOn(authProtection, 'isAuthEnabled').mockImplementation(() => enabled);
    cleanup.push(() => spy.mockRestore());
    const direct = await fixture({}, true), client = await direct.connect();
    expect((await client.http('open-health', 'GET', '/api/terminal/one/health'))[0]).toMatchObject({ type: 'head', status: 200 });
    expect(direct.runtime.store.list()).toEqual([]);
    client.channel.send({ type: 'grants-list', id: 'open-grants' });
    expect(await client.take('open-grants')).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
    const routed = await fixture(), remote = await routed.connect();
    expect((await remote.http('routed-health', 'GET', '/api/terminal/one/health'))[0]).toMatchObject({ type: 'error' });
    enabled = true;
    expect((await client.http('closed-health', 'GET', '/api/terminal/one/health'))[0]).toMatchObject({ type: 'error' });
    expect(direct.runtime.store.list()).toEqual([]);
  });
  it('pairs once and proxies secret HTTP content without exposing it to the outer wire', async () => {
    const f = await fixture(), client = await f.connect();
    expect(await client.pair()).toMatchObject({ type: 'result', subjectId: client.identity.peerId });
    const packets = await client.http('health', 'GET', '/api/terminal/one/health');
    expect(packets[0]).toMatchObject({ type: 'head', status: 200 });
    const body = packets.filter(p => p.type === 'chunk').map(p => new TextDecoder().decode(fromBase64(String(p.data)))).join('');
    expect(JSON.parse(body)).toEqual({ output: 'private-terminal-output', session: 'one' });
    expect(client.wire.every(chunk => !new TextDecoder().decode(chunk).includes('private-terminal-output'))).toBe(true);
  });
  it('denies unknown peers and does not trust a claimed authorized identity', async () => {
    const f = await fixture(), owner = await f.connect(); await owner.pair();
    const attacker = await f.connect();
    attacker.channel.send({ type: 'http', id: 'spoof', method: 'GET', path: '/api/terminal/one/health', subjectId: owner.identity.peerId });
    expect(await attacker.take('spoof')).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
    expect(f.input).not.toHaveBeenCalled();
  });
  it('keeps tmux control permission when copy-mode exit is combined with terminal input', async () => {
    const f = await fixture(), client = await f.connect();
    f.runtime.store.grant({ subjectId: client.identity.peerId, scope: { kind: 'sessions', sessionIds: ['one'] }, actions: ['session.view', 'session.input'] });
    client.channel.send({ type: 'ws-open', id: 'terminal', path: '/api/terminal/one/ws' });
    await client.take('terminal', 'ws-ready'); await client.take('terminal', 'ws-data');
    client.channel.send({ type: 'ws-data', id: 'terminal', data: JSON.stringify({ type: 'input', data: 'blocked', exitCopyMode: true }) });
    expect(await client.take('terminal', 'error')).toMatchObject({ error: 'AUTHORIZATION_DENIED' });
    expect(f.received).not.toHaveBeenCalled();
    client.channel.send({ type: 'ws-data', id: 'terminal', data: JSON.stringify({ type: 'input', data: 'ordinary' }) });
    await vi.waitFor(() => expect(f.received).toHaveBeenCalledWith({ type: 'input', data: 'ordinary' }));
    await client.pair();
    client.channel.send({ type: 'ws-data', id: 'terminal', data: JSON.stringify({ type: 'input', data: 'allowed', exitCopyMode: true }) });
    await vi.waitFor(() => expect(f.received).toHaveBeenCalledWith({ type: 'input', data: 'allowed', exitCopyMode: true }));
  });

  it('restricts session viewers to the granted resource and rejects terminal input/resize', async () => {
    const f = await fixture(), client = await f.connect();
    f.runtime.store.grant({ subjectId: client.identity.peerId, scope: { kind: 'sessions', sessionIds: ['one'] }, actions: ['session.view'] });
    expect((await client.http('allowed', 'GET', '/api/terminal/one/health')).at(-1)?.type).toBe('end');
    client.channel.send({ type: 'http', id: 'other', method: 'GET', path: '/api/terminal/two/health' });
    expect(await client.take('other')).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
    client.channel.send({ type: 'ws-open', id: 'terminal', path: '/api/terminal/one/ws' });
    expect(await client.take('terminal', 'ws-ready')).toMatchObject({ type: 'ws-ready' });
    expect(await client.take('terminal', 'ws-data')).toMatchObject({ data: JSON.stringify({ type: 'output', data: 'private-terminal-output' }) });
    for (const type of ['input', 'resize']) {
      client.channel.send({ type: 'ws-data', id: 'terminal', data: JSON.stringify({ type, data: 'danger', cols: 1, rows: 1 }) });
      expect(await client.take('terminal', 'error')).toMatchObject({ error: 'AUTHORIZATION_DENIED' });
    }
    expect(f.received).not.toHaveBeenCalled();
  });
  it('enforces revocation on HTTP and before the next terminal output', async () => {
    const f = await fixture(), client = await f.connect();
    const grant = f.runtime.store.grant({ subjectId: client.identity.peerId, scope: { kind: 'sessions', sessionIds: ['one'] }, actions: ['session.view'] });
    client.channel.send({ type: 'ws-open', id: 'terminal', path: '/api/terminal/one/ws' });
    await client.take('terminal', 'ws-ready'); await client.take('terminal', 'ws-data');
    f.runtime.store.revoke(grant.id);
    f.terminal()!.send('must not leak after revocation');
    expect(await client.take('terminal')).toMatchObject({ type: 'ws-close', code: 4003 });
    client.channel.send({ type: 'http', id: 'revoked', method: 'GET', path: '/api/terminal/one/health' });
    expect(await client.take('revoked')).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
  });
  it('rejects only a slow logical terminal stream while the same Noise channel serves HTTP', async () => {
    const f = await fixture(), client = await f.connect();
    f.runtime.store.grant({ subjectId: client.identity.peerId, scope: { kind: 'sessions', sessionIds: ['one'] }, actions: ['session.view', 'session.input'] });
    client.channel.send({ type: 'ws-open', id: 'small-terminal', path: '/api/terminal/one/ws' });
    await client.take('small-terminal', 'ws-ready'); await client.take('small-terminal', 'ws-data');
    client.channel.send({ type: 'ws-open', id: 'slow-terminal', path: '/api/terminal/one/ws' });
    await client.take('slow-terminal', 'ws-ready');
    await client.take('slow-terminal', 'ws-data');

    // Synchronous production sends outrun the Noise sink. The per-logical
    // queued-byte ceiling must close this terminal only, not its channel.
    const queuedSamples: number[] = [];
    const originalQueuedBytesFor = PacketChannel.prototype.queuedBytesFor;
    const queuedSpy = vi.spyOn(PacketChannel.prototype, 'queuedBytesFor').mockImplementation(function (this: PacketChannel, id: string) {
      const queued = originalQueuedBytesFor.call(this, id);
      if (id === 'slow-terminal') queuedSamples.push(queued);
      return queued;
    });
    const output = JSON.stringify({ type: 'output', data: 'x'.repeat(700 * 1024) });
    f.terminal()!.send(output);
    const firstBufferedAmount = f.terminal()!.bufferedAmount;
    expect(firstBufferedAmount).toBeGreaterThan(0);
    expect(firstBufferedAmount).toBeLessThanOrEqual(1024 * 1024);
    for (let index = 1; index < 8; index++) f.terminal()!.send(output);
    expect(await client.take('slow-terminal', 'ws-close')).toMatchObject({ code: 1013 });
    queuedSpy.mockRestore();
    expect(Math.max(...queuedSamples)).toBeGreaterThan(0);

    client.channel.send({ type: 'ws-data', id: 'small-terminal', data: JSON.stringify({ type: 'input', data: 'x' }) });
    await vi.waitFor(() => expect(f.received).toHaveBeenCalledWith({ type: 'input', data: 'x' }));
    const requestMs: number[] = [];
    for (let index = 0; index < 20; index++) {
      const started = performance.now();
      const response = await client.http(`still-alive-${index}`, 'GET', '/api/terminal/one/health');
      requestMs.push(performance.now() - started);
      expect(response[0]).toMatchObject({ type: 'head', status: 200 });
      expect(response.at(-1)?.type).toBe('end');
    }
    requestMs.sort((a, b) => a - b);
    console.info(`real Noise/WebSocket loopback; PacketChannel queued record bytes through sink yield (not NIC send/peer ACK): peak=${Math.max(...queuedSamples)}, small HTTP p95=${requestMs[Math.ceil(requestMs.length * 0.95) - 1].toFixed(2)}ms (n=${requestMs.length})`);
  });
  it('rejects a 257th queued logical frame without ending the Noise channel', async () => {
    const f = await fixture(), client = await f.connect();
    f.runtime.store.grant({ subjectId: client.identity.peerId, scope: { kind: 'sessions', sessionIds: ['one'] }, actions: ['session.view', 'session.input'] });
    client.channel.send({ type: 'ws-open', id: 'small-terminal', path: '/api/terminal/one/ws' });
    await client.take('small-terminal', 'ws-ready'); await client.take('small-terminal', 'ws-data');
    client.channel.send({ type: 'ws-open', id: 'busy-terminal', path: '/api/terminal/one/ws' });
    await client.take('busy-terminal', 'ws-ready'); await client.take('busy-terminal', 'ws-data');

    const smallFrame = JSON.stringify({ type: 'output', data: 'x'.repeat(3 * 1024) });
    client.pauseReads();
    for (let index = 0; index < 257; index++) f.terminal()!.send(smallFrame);
    expect(f.terminal()!.readyState).toBe(3);
    const queuedBytesAtCountRejection = f.terminal()!.bufferedAmount;
    expect(queuedBytesAtCountRejection).toBeGreaterThan(0);
    expect(queuedBytesAtCountRejection).toBeLessThan(1024 * 1024);
    client.resumeReads();
    const acceptedFrames: Packet[] = [];
    for (let index = 0; index < 256; index++) acceptedFrames.push(await client.take('busy-terminal', 'ws-data'));
    expect(acceptedFrames).toHaveLength(256);
    expect(client.pendingPackets().some(packet => packet.id === 'busy-terminal' && packet.type === 'ws-close')).toBe(false);

    client.channel.send({ type: 'ws-data', id: 'small-terminal', data: JSON.stringify({ type: 'input', data: 'x' }) });
    await vi.waitFor(() => expect(f.received).toHaveBeenCalledWith({ type: 'input', data: 'x' }));
    const requestMs: number[] = [];
    for (let index = 0; index < 20; index++) {
      const started = performance.now();
      const response = await client.http(`count-alive-${index}`, 'GET', '/api/terminal/one/health');
      requestMs.push(performance.now() - started);
      expect(response.at(-1)?.type).toBe('end');
    }
    requestMs.sort((a, b) => a - b);
    console.info(`real Noise/WebSocket TCP-read pause: 257 x 3-KiB frames, 256 accepted; queued bytes at count rejection=${queuedBytesAtCountRejection} (<1 MiB); local cleanup ran, no ws-close fit in full queue; sibling input and HTTP survived; small HTTP p95=${requestMs[Math.ceil(requestMs.length * 0.95) - 1].toFixed(2)}ms (n=${requestMs.length})`);
  });
  it('preserves a legal 1.5 MiB single WebSocket frame on the non-terminal computer path', async () => {
    const f = await fixture(), client = await f.connect(); await client.pair();
    client.channel.send({ type: 'ws-open', id: 'computer', path: '/api/computer/ws?protocol=vnc&host=127.0.0.1' });
    await client.take('computer', 'ws-ready');
    const media = JSON.stringify({ type: 'data', data: 'x'.repeat(1536 * 1024) });
    f.computer()!.send(media);
    expect((await client.take('computer', 'ws-data')).data).toBe(media);
  });
  it('keeps a session-scoped grant valid after the backend session id is replaced', async () => {
    const f = await fixture(), owner = await f.connect(); await owner.pair();
    // An older client still selects the transient backend id; the invitation
    // stores the stable client session id instead.
    owner.channel.send({ type: 'invite-create', id: 'invite', scope: { kind: 'sessions', sessionIds: ['one'] }, actions: ['session.view'] });
    const invitation = await owner.take('invite'); expect(invitation.type).toBe('result');
    const phone = await f.connect();
    phone.channel.send({ type: 'pair', id: 'accept', code: invitation.code });
    await phone.take('accept');
    // Restart, tmux recovery or re-attach replaces the backend PTY id.
    f.inventory.clientSessions[0].backendSessionId = 'one-new';
    phone.channel.send({ type: 'session-list', id: 'sessions' });
    expect(await phone.take('sessions')).toMatchObject({ items: [{ sessionId: 'one-new', sourceSessionId: 'source-one', canWrite: false }] });
    phone.channel.send({ type: 'ws-open', id: 'terminal', path: '/api/terminal/one-new/ws' });
    expect(await phone.take('terminal')).toMatchObject({ type: 'ws-ready' });
    expect((await phone.http('read', 'GET', '/api/terminal/one-new/health')).at(-1)?.type).toBe('end');
    phone.channel.send({ type: 'invite-create', id: 'escalate', scope: { kind: 'sessions', sessionIds: ['one-new'] }, actions: ['session.view'] });
    expect(await phone.take('escalate')).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
  });
  it('derives a scoped collaboration peer from the device write grant, never from the request', async () => {
    const registerScopedCollaborationPeer = vi.fn((_device: string, _origin: string, node: { serviceId: string; origin: string }, sessions: string[]) => ({ ok: true, peer: node.serviceId, sessions }));
    const f = await fixture({ registerScopedCollaborationPeer });
    const device = await f.connect(); await device.pair();
    const node = { serviceId: '12D3KooW' + '2'.repeat(44), origin: 'https://peer.example' };
    device.channel.send({ type: 'collaboration-scoped-peer', id: 'owner-denied', origin: 'https://self.example', node });
    expect(await device.take('owner-denied')).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
    f.runtime.store.grant({ subjectId: device.identity.peerId, scope: { kind: 'sessions', sessionIds: ['source-one'] }, actions: ['session.view'] });
    device.channel.send({ type: 'collaboration-scoped-peer', id: 'view-only', origin: 'https://self.example', node });
    expect(await device.take('view-only')).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
    f.runtime.store.grant({ subjectId: device.identity.peerId, scope: { kind: 'sessions', sessionIds: ['source-one'] }, actions: ['session.input'] });
    device.channel.send({ type: 'collaboration-scoped-peer', id: 'scoped', origin: 'https://self.example', node });
    expect(await device.take('scoped')).toMatchObject({ type: 'result', ok: true, sessions: ['source-one'] });
    expect(registerScopedCollaborationPeer).toHaveBeenCalledWith(device.identity.peerId, 'https://self.example', node, ['source-one']);
  });
  it('accepts the stable client session id when creating a session-scoped invitation', async () => {
    const f = await fixture(), owner = await f.connect(); await owner.pair();
    owner.channel.send({ type: 'invite-create', id: 'invite', scope: { kind: 'sessions', sessionIds: ['source-one'] }, actions: ['session.view'] });
    const invitation = await owner.take('invite'); expect(invitation.type).toBe('result');
    const phone = await f.connect();
    phone.channel.send({ type: 'pair', id: 'accept', code: invitation.code });
    await phone.take('accept');
    phone.channel.send({ type: 'session-list', id: 'sessions' });
    expect(await phone.take('sessions')).toMatchObject({ items: [{ sessionId: 'one', sourceSessionId: 'source-one' }] });
  });
  it('binds shared appearance to the target Session and preserves it across reconnects and backend replacement', async () => {
    const f = await fixture(), owner = await f.connect(); await owner.pair();
    owner.channel.send({ type: 'invite-create', id: 'branded', scope: { kind: 'sessions', sessionIds: ['one'] }, actions: ['session.view'], sessionAppearance: { one: { name: '研究工作台', icon: '🎙️' } } });
    const invite = await owner.take('branded'), guest = await f.connect();
    guest.channel.send({ type: 'pair', id: 'accept', code: invite.code }); await guest.take('accept');
    const reconnected = await f.connect(guest.identity);
    reconnected.channel.send({ type: 'session-list', id: 'branded-list' });
    expect(await reconnected.take('branded-list')).toMatchObject({ items: [{ sessionId: 'one', sourceSessionId: 'source-one', name: '研究工作台', icon: '🎙️', canWrite: false }] });
    f.inventory.clientSessions[0].backendSessionId = 'one-new';
    reconnected.channel.send({ type: 'session-list', id: 'replaced-list' });
    expect(await reconnected.take('replaced-list')).toMatchObject({ items: [{ sessionId: 'one-new', name: '研究工作台', icon: '🎙️' }] });
    owner.channel.send({ type: 'session-list', id: 'original-list' });
    expect(JSON.stringify(await owner.take('original-list'))).not.toContain('研究工作台');
    owner.channel.send({ type: 'invite-create', id: 'bad-appearance', scope: { kind: 'sessions', sessionIds: ['source-one'] }, actions: ['session.view'], sessionAppearance: { two: { name: '越界' } } });
    expect(await owner.take('bad-appearance')).toMatchObject({ type: 'error', error: 'INVALID_INVITATION' });
  });
  it('dispatches a mutating HTTP upload only once when upload-end is repeated', async () => {
    const f = await fixture(), client = await f.connect(); await client.pair();
    client.channel.send({ type: 'http', id: 'write', method: 'POST', path: '/api/terminal/one/input', headers: { 'content-type': 'application/json' } });
    client.channel.send({ type: 'upload-end', id: 'write' });
    client.channel.send({ type: 'upload-end', id: 'write' });
    expect(await client.take('write', 'error')).toMatchObject({ error: 'INVALID_STREAM' });
    await client.take('write', 'head'); await client.take('write', 'chunk'); client.channel.send({ type: 'ack', id: 'write' });
    await client.take('write', 'end'); expect(f.input).toHaveBeenCalledTimes(1);
  });
  it('projects only authorized bound sessions and exposes only effective own grants', async () => {
    const f = await fixture(), client = await f.connect();
    const grant = f.runtime.store.grant({ subjectId: client.identity.peerId, scope: { kind: 'sessions', sessionIds: ['one'] }, actions: ['session.view'] });
    const revoked = f.runtime.store.grant({ subjectId: client.identity.peerId, scope: { kind: 'service' }, actions: ['service:*'] });
    f.runtime.store.revoke(revoked.id);
    client.channel.send({ type: 'session-list', id: 'sessions' });
    expect(await client.take('sessions')).toEqual({ type: 'result', id: 'sessions', items: [{ sessionId: 'one', sourceSessionId: 'source-one', name: 'Allowed', live: true, canWrite: false, canResize: false }] });
    client.channel.send({ type: 'permissions', id: 'permissions' });
    expect(await client.take('permissions')).toMatchObject({ fullService: false, grants: [grant] });
  });
  it('authenticates a password inside Noise and prevents another channel from finishing that attempt', async () => {
    const previous = process.env.TERMDOCK_PASSWORD; process.env.TERMDOCK_PASSWORD = 'relay-password';
    cleanup.push(() => { if (previous === undefined) delete process.env.TERMDOCK_PASSWORD; else process.env.TERMDOCK_PASSWORD = previous; });
    const f = await fixture(), client = await f.connect(), attacker = await f.connect();
    client.channel.send({ type: 'password-parameters', id: 'params' });
    const params = await client.take('params');
    const state = await startPasswordBootstrap('relay-password', params.saltHex as string);
    const origin = 'https://entry.example';
    client.channel.send({ type: 'password-start', id: 'start', startLoginRequest: state.startLoginRequest, origin, clientIdentity: attacker.identity.peerId });
    const response = await client.take('start');
    const proof = await finishPasswordBootstrap(state, response as unknown as PasswordBootstrapResponse, { clientIdentity: client.identity.peerId, origin });
    attacker.channel.send({ type: 'password-finish', id: 'steal', attemptId: proof.attemptId, finishLoginRequest: proof.finishLoginRequest });
    expect(await attacker.take('steal')).toMatchObject({ type: 'error', error: 'INVALID_LOGIN' });
    client.channel.send({ type: 'password-finish', id: 'finish', attemptId: proof.attemptId, finishLoginRequest: proof.finishLoginRequest });
    expect(await client.take('finish')).toMatchObject({ type: 'result', ok: true });
    client.channel.send({ type: 'permissions', id: 'permissions' });
    expect(await client.take('permissions')).toMatchObject({ fullService: true });
    attacker.channel.send({ type: 'permissions', id: 'attacker-permissions' });
    expect(await attacker.take('attacker-permissions')).toMatchObject({ fullService: false, grants: [] });
    client.channel.send({ type: 'password-finish', id: 'replay', attemptId: proof.attemptId, finishLoginRequest: proof.finishLoginRequest });
    expect(await client.take('replay')).toMatchObject({ type: 'error', error: 'INVALID_LOGIN' });
    expect(Buffer.concat(client.wire.map(chunk => Buffer.from(chunk))).toString()).not.toContain('relay-password');
  });
  it('lists only explicitly authorized targets for a device and all configured targets for an administrator', async () => {
    const grants = new Set<string>();
    const targets = [{ serviceId: 'C', url: 'https://c.internal', available: true }, { serviceId: 'D', available: false }];
    const f = await fixture({ listRouteTargets: () => targets, hasRouteGrant: (subject, target) => grants.has(subject + ':' + target) });
    const phone = await f.connect();
    phone.channel.send({ type: 'route-targets', id: 'empty', subjectId: 'forged' });
    expect(await phone.take('empty')).toMatchObject({ canManage: false, items: [] });
    grants.add(phone.identity.peerId + ':C');
    phone.channel.send({ type: 'route-targets', id: 'scoped' });
    expect(await phone.take('scoped')).toMatchObject({ canManage: false, items: [{ ...targets[0], authorized: true }] });
    grants.clear();
    phone.channel.send({ type: 'route-targets', id: 'revoked' });
    expect(await phone.take('revoked')).toMatchObject({ items: [] });
    await phone.pair();
    phone.channel.send({ type: 'route-targets', id: 'owner' });
    expect(await phone.take('owner')).toMatchObject({ canManage: true, items: targets.map(target => ({ ...target, authorized: false })) });
    expect(f.issueRouteTicket).not.toHaveBeenCalled();
  });
  it('requires an explicit target route grant, even for an owner, and binds tickets to the real subject', async () => {
    const grants = new Set<string>();
    const f = await fixture({ hasRouteGrant: (subject, target) => grants.has(subject + ':' + target) }), client = await f.connect();
    client.channel.send({ type: 'route-ticket', id: 'denied', serviceId: 'target-service' });
    expect(await client.take('denied')).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
    expect(f.issueRouteTicket).not.toHaveBeenCalled();
    await client.pair();
    client.channel.send({ type: 'route-ticket', id: 'owner-denied', serviceId: 'target-service' });
    expect(await client.take('owner-denied')).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
    grants.add(client.identity.peerId + ':target-service');
    client.channel.send({ type: 'route-ticket', id: 'ticket', serviceId: 'target-service', subjectId: 'forged' });
    expect(await client.take('ticket')).toMatchObject({ type: 'result', routeToken: 'test-route-ticket' });
    expect(f.issueRouteTicket).toHaveBeenCalledWith(client.identity.peerId, 'target-service');
  });
  it('does not mistake a custom service.full-access action for the wildcard', async () => {
    const f = await fixture(), client = await f.connect();
    f.runtime.store.grant({ subjectId: client.identity.peerId, scope: { kind: 'service' }, actions: ['service.full-access'] });
    client.channel.send({ type: 'permissions', id: 'permissions' });
    expect(await client.take('permissions')).toMatchObject({ fullService: false });
    client.channel.send({ type: 'http', id: 'global', method: 'GET', path: '/api/terminal/operations/unregistered' });
    expect(await client.take('global')).toMatchObject({ type: 'error', error: 'API_NOT_ALLOWED' });
  });
  it('reports confirmed expiry over the encrypted channel without granting access', async () => {
    const f = await fixture(), owner = await f.connect(); await owner.pair();
    owner.channel.send({ type: 'invite-create', id: 'expiring', scope: { kind: 'sessions', sessionIds: ['one'] }, actions: ['session.view'] });
    const invitation = await owner.take('expiring');
    const path = join(f.directory, 'invitations.json'), data = JSON.parse(readFileSync(path, 'utf8'));
    const item = data.invitations.find((entry: { hash: string }) => entry.hash === invitation.invitationId);
    item.createdAt = Date.now() - 600001; item.invitationExpiresAt = item.createdAt + 600000;
    writeFileSync(path, JSON.stringify(data));
    const guest = await f.connect(); guest.channel.send({ type: 'pair', id: 'expired', code: invitation.code });
    expect(await guest.take('expired')).toMatchObject({ type: 'error', error: 'INVITATION_EXPIRED' });
    guest.channel.send({ type: 'permissions', id: 'permissions' });
    expect(await guest.take('permissions')).toMatchObject({ fullService: false, grants: [] });
    expect((await guest.http('denied', 'GET', '/api/terminal/one/health'))[0]).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
  });
  it('redeems administrator-created session invitations once for the real Noise subject', async () => {
    const f = await fixture(), owner = await f.connect(); await owner.pair();
    owner.channel.send({ type: 'invite-create', id: 'invite', scope: { kind: 'sessions', sessionIds: ['one'] }, actions: ['session.view'], label: '手机' });
    const invitation = await owner.take('invite'); expect(invitation.type).toBe('result');
    const phone = await f.connect();
    phone.channel.send({ type: 'pair', id: 'accept', code: invitation.code, subjectId: owner.identity.peerId });
    expect(await phone.take('accept')).toMatchObject({ type: 'result', subjectId: phone.identity.peerId });
    expect((await phone.http('read', 'GET', '/api/terminal/one/health')).at(-1)?.type).toBe('end');
    phone.channel.send({ type: 'http', id: 'write', method: 'POST', path: '/api/terminal/one/input' });
    expect(await phone.take('write')).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
    phone.channel.send({ type: 'invite-create', id: 'escalate', scope: { kind: 'service' }, actions: ['service:*'] });
    expect(await phone.take('escalate')).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
    const second = await f.connect(); second.channel.send({ type: 'pair', id: 'reuse', code: invitation.code });
    expect(await second.take('reuse')).toMatchObject({ type: 'error', error: 'INVITATION_USED' });
    owner.channel.send({ type: 'grants-list', id: 'labels' });
    expect(await owner.take('labels')).toMatchObject({ subjectLabels: { [phone.identity.peerId]: '手机' } });
  });
  it('refuses invitations for invented sessions and privilege injection', async () => {
    const f = await fixture(), owner = await f.connect(); await owner.pair();
    owner.channel.send({ type: 'invite-create', id: 'unknown', scope: { kind: 'sessions', sessionIds: ['not-real'] }, actions: ['session.view'] });
    expect(await owner.take('unknown')).toMatchObject({ type: 'error', error: 'UNKNOWN_SESSION' });
    owner.channel.send({ type: 'invite-create', id: 'invalid', scope: { kind: 'sessions', sessionIds: ['one'] }, actions: ['service:*'] });
    expect(await owner.take('invalid')).toMatchObject({ type: 'error', error: 'INVALID_INVITATION' });
  });
  it('binds a route-only invitation to the real device without granting entry business access', async () => {
    const grants = new Set<string>();
    const createRouteInvitation = vi.fn(() => ({ routeCode: 'one-time-route', expiresAt: Date.now() + 600000 }));
    const consumeRouteInvitation = vi.fn((_code: string, subject: string) => { grants.add(subject + ':target-C'); return { serviceId: 'target-C' }; });
    const f = await fixture({ createRouteInvitation, consumeRouteInvitation, hasRouteGrant: (subject, target) => grants.has(subject + ':' + target) });
    const owner = await f.connect(); await owner.pair();
    owner.channel.send({ type: 'route-invite-create', id: 'route-invite', serviceId: 'target-C' });
    expect(await owner.take('route-invite')).toMatchObject({ routeCode: 'one-time-route' });
    expect(createRouteInvitation).toHaveBeenCalledWith(owner.identity.peerId, 'target-C');
    const phone = await f.connect();
    phone.channel.send({ type: 'route-pair', id: 'route-pair', code: 'one-time-route', subjectId: owner.identity.peerId });
    expect(await phone.take('route-pair')).toMatchObject({ type: 'result', serviceId: 'target-C' });
    expect(consumeRouteInvitation).toHaveBeenCalledWith('one-time-route', phone.identity.peerId);
    phone.channel.send({ type: 'route-ticket', id: 'allowed-route', serviceId: 'target-C' });
    expect(await phone.take('allowed-route')).toMatchObject({ type: 'result', routeToken: 'test-route-ticket' });
    phone.channel.send({ type: 'route-ticket', id: 'other-route', serviceId: 'target-D' });
    expect(await phone.take('other-route')).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
    phone.channel.send({ type: 'http', id: 'business', method: 'GET', path: '/api/terminal/one/health' });
    expect(await phone.take('business')).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
  });
  it.each([97, 1600])('streams %i file chunks into the internal server before upload-end', async count => {
    const f = await fixture(), owner = await f.connect(); await owner.pair();
    owner.channel.send({ type: 'http', id: 'large', method: 'POST', path: '/api/terminal/fs/upload', headers: { 'content-type': 'application/octet-stream' } });
    const chunk = toBase64(new Uint8Array(65536));
    for (let i = 0; i < count; i++) {
      owner.channel.send({ type: 'upload', id: 'large', data: chunk });
      expect((await owner.take('large')).type).toBe('upload-ack');
    }
    await vi.waitFor(() => expect(f.uploads.bytes).toBeGreaterThan(5 * 1024 * 1024));
    expect(f.uploads.finished).toBe(0);
    owner.channel.send({ type: 'upload-end', id: 'large' });
    expect(await owner.take('large', 'head')).toMatchObject({ status: 200 });
    const output = await owner.take('large', 'chunk');
    expect(JSON.parse(new TextDecoder().decode(fromBase64(String(output.data))))).toEqual({ bytes: count * 65536 });
    owner.channel.send({ type: 'ack', id: 'large' }); await owner.take('large', 'end');
    expect(f.uploads.finished).toBe(1);
  }, 30000);
  it('bounds negotiated downloads to eight unconsumed chunks and releases one per ACK', async () => {
    const f = await fixture(), owner = await f.connect(); await owner.pair();
    f.app.get('/api/terminal/fs/download', (_req, res) => res.end(Buffer.alloc(1024 * 1024)));
    owner.channel.send({ type: 'http', id: 'window', method: 'GET', path: '/api/terminal/fs/download', window: 8 });
    owner.channel.send({ type: 'upload-end', id: 'window' });
    await owner.take('window', 'head');
    for (let i = 0; i < 8; i++) await owner.take('window', 'chunk');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(owner.pendingPackets().filter(packet => packet.id === 'window')).toEqual([]);
    owner.channel.send({ type: 'ack', id: 'window' });
    await owner.take('window', 'chunk');
    owner.channel.send({ type: 'cancel', id: 'window' });
    owner.channel.send({ type: 'permissions', id: 'after-cancel-window' });
    expect(await owner.take('after-cancel-window')).toMatchObject({ httpWindow: 8, fullService: true });
  });
  it('accepts a negotiated upload window without waiting between chunks', async () => {
    const f = await fixture(), owner = await f.connect(); await owner.pair();
    owner.channel.send({ type: 'http', id: 'pipeline', method: 'POST', path: '/api/terminal/fs/upload', window: 8 });
    for (let i = 0; i < 8; i++) owner.channel.send({ type: 'upload', id: 'pipeline', data: toBase64(new Uint8Array(65536)) });
    for (let i = 0; i < 8; i++) await owner.take('pipeline', 'upload-ack');
    owner.channel.send({ type: 'upload-end', id: 'pipeline' });
    await owner.take('pipeline', 'head');
    const output = await owner.take('pipeline', 'chunk');
    expect(JSON.parse(new TextDecoder().decode(fromBase64(String(output.data))))).toEqual({ bytes: 8 * 65536 });
    owner.channel.send({ type: 'ack', id: 'pipeline' }); await owner.take('pipeline', 'end');
  });
  it('cancels streaming uploads and limits active upload bodies globally', async () => {
    const f = await fixture(), owner = await f.connect(); await owner.pair();
    for (let i = 0; i < 8; i++) owner.channel.send({ type: 'http', id: `up-${i}`, method: 'POST', path: '/api/terminal/fs/upload' });
    const another = await f.connect(); await another.pair();
    another.channel.send({ type: 'http', id: 'up-8', method: 'POST', path: '/api/terminal/fs/upload' });
    expect(await another.take('up-8')).toMatchObject({ type: 'error', error: 'UPLOAD_CONCURRENCY_LIMIT' });
    owner.channel.send({ type: 'upload', id: 'up-0', data: toBase64(new Uint8Array(65536)) });
    await owner.take('up-0', 'upload-ack');
    await vi.waitFor(() => expect(f.uploads.bytes).toBeGreaterThan(0));
    for (let i = 0; i < 8; i++) owner.channel.send({ type: 'cancel', id: `up-${i}` });
    await vi.waitFor(() => expect(f.uploads.aborted).toBeGreaterThan(0));
    owner.channel.send({ type: 'http', id: 'after-cancel', method: 'POST', path: '/api/terminal/fs/upload' });
    owner.channel.send({ type: 'upload-end', id: 'after-cancel' });
    expect(await owner.take('after-cancel', 'head')).toMatchObject({ status: 200 });
    await owner.take('after-cancel', 'chunk'); owner.channel.send({ type: 'ack', id: 'after-cancel' }); await owner.take('after-cancel', 'end');
    expect(f.uploads.finished).toBe(1);
  });
  it('rejects oversized upload frames and propagates early HTTP rejection', async () => {
    const f = await fixture(), owner = await f.connect(); await owner.pair();
    owner.channel.send({ type: 'http', id: 'oversized', method: 'POST', path: '/api/terminal/fs/upload' });
    owner.channel.send({ type: 'upload', id: 'oversized', data: toBase64(new Uint8Array(65537)) });
    expect(await owner.take('oversized')).toMatchObject({ type: 'error', error: 'UPLOAD_LIMIT' });
    owner.channel.send({ type: 'http', id: 'reject', method: 'POST', path: '/api/terminal/fs/upload?reject=1' });
    owner.channel.send({ type: 'upload', id: 'reject', data: toBase64(new Uint8Array(64)) });
    expect(await owner.take('reject', 'error')).toMatchObject({ error: 'UPLOAD_REJECTED_413' });
  });
  it('preserves full-service terminal geometry/options without granting viewers resize effects', async () => {
    const f = await fixture(), viewer = await f.connect();
    f.runtime.store.grant({ subjectId: viewer.identity.peerId, scope: { kind: 'sessions', sessionIds: ['one'] }, actions: ['session.view'] });
    const path = '/api/terminal/one/ws?flow=2&transport=tmux-client&active=0&cols=120&rows=40';
    viewer.channel.send({ type: 'ws-open', id: 'view', path }); await viewer.take('view', 'ws-ready');
    expect(f.terminalOptions).toHaveBeenLastCalledWith(expect.objectContaining({ independentTmux: false, outputActive: false }), undefined);
    const owner = await f.connect(); await owner.pair();
    owner.channel.send({ type: 'ws-open', id: 'own', path }); await owner.take('own', 'ws-ready');
    expect(f.terminalOptions).toHaveBeenLastCalledWith(expect.objectContaining({ independentTmux: true, outputActive: false }), { cols: 120, rows: 40 });
  });
});


it('enforces individual shared devices, computer view-only mode, directory boundaries and revocation over Noise', async () => {
  const f = await fixture(), guest = await f.connect();
  const shared = join(f.directory, 'visible.txt'); writeFileSync(shared, 'visible');
  const grant = f.runtime.store.grant({ subjectId: guest.identity.peerId, scope: { kind: 'sessions', sessionIds: ['source-one'] }, actions: ['session.view'], resources: {
    android: [{ serial: 'pixel', access: 'view' }], computers: [{ host: '127.0.0.1', protocol: 'rdp', port: 3389, access: 'view' }], directories: [{ path: f.directory, access: 'read' }],
  } });
  f.app.get('/api/terminal/fs/read', (_req, res) => res.json({ content: 'visible' }));
  expect((await guest.http('file-ok', 'GET', `/api/terminal/fs/read?path=${encodeURIComponent(shared)}`))[0]).toMatchObject({ type: 'head', status: 200 });
  for (const [id, method, path] of [
    ['outside', 'GET', '/api/terminal/fs/read?path=/etc/passwd'], ['delete', 'DELETE', `/api/terminal/fs/file?path=${encodeURIComponent(shared)}`],
    ['connect', 'POST', '/api/android/connect'], ['password', 'POST', '/api/computer/credentials/use'], ['settings', 'GET', '/api/terminal/settings'],
    ['chat-write', 'POST', '/api/terminal/one/chat'], ['other-chat', 'GET', '/api/terminal/two/chat'], ['chat-form-write', 'PUT', '/api/terminal/one/chat/message/state'],
  ]) expect((await guest.http(id, method, path))[0]).toMatchObject({ type: 'error' });
  guest.channel.send({ type: 'ws-open', id: 'phone', path: '/api/android/pixel/ws' }); expect(await guest.take('phone')).toMatchObject({ type: 'ws-ready' });
  guest.channel.send({ type: 'ws-data', id: 'phone', data: JSON.stringify({ type: 'control', data: 'AAAA' }) }); expect(await guest.take('phone')).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
  guest.channel.send({ type: 'ws-data', id: 'phone', data: JSON.stringify({ type: 'control', data: 'EQ==' }) });
  guest.channel.send({ type: 'ws-open', id: 'other-phone', path: '/api/android/other/ws' }); expect(await guest.take('other-phone')).toMatchObject({ type: 'error' });
  guest.channel.send({ type: 'ws-open', id: 'pc', path: '/api/computer/ws?host=127.0.0.1&protocol=rdp&port=3389' }); expect(await guest.take('pc')).toMatchObject({ type: 'ws-ready' }); expect(f.computerOptions).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
  guest.channel.send({ type: 'ws-open', id: 'pc-other', path: '/api/computer/ws?host=127.0.0.1&protocol=rdp&port=3390' }); expect(await guest.take('pc-other')).toMatchObject({ type: 'error' });
  f.runtime.store.revoke(grant.id); f.android()!.send(JSON.stringify({ type: 'frame', data: 'secret' })); expect(await guest.take('phone')).toMatchObject({ type: 'ws-close', code: 4003 });
});

it('reports actual scoped connections and stops one shared Session without revoking a sibling Session', async () => {
  const f = await fixture(), owner = await f.connect(); await owner.pair();
  const guest = await f.connect();
  f.runtime.store.grant({ subjectId: guest.identity.peerId, scope: { kind: 'sessions', sessionIds: ['one', 'two'] }, actions: ['session.view'] });
  await guest.http('visit-one', 'GET', '/api/terminal/one/health');
  owner.channel.send({ type: 'session-sharing-status', id: 'sharing' });
  expect(await owner.take('sharing')).toMatchObject({ items: expect.arrayContaining([{ sessionId: 'source-one', devices: 1, connectedDevices: 1, invitations: 0 }]) });
  guest.channel.send({ type: 'session-sharing-stop', id: 'forbidden-stop', sessionId: 'one' });
  expect(await guest.take('forbidden-stop')).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
  guest.channel.send({ type: 'session-sharing-status', id: 'forbidden-status' });
  expect(await guest.take('forbidden-status')).toMatchObject({ type: 'error', error: 'AUTHORIZATION_DENIED' });
  f.inventory.clientSessions[1].sessionId = 'two';
  owner.channel.send({ type: 'invite-create', id: 'shared-invite', scope: { kind: 'sessions', sessionIds: ['one', 'two'] }, actions: ['session.view'] });
  expect(await owner.take('shared-invite')).toMatchObject({ type: 'result', code: expect.any(String) });
  owner.channel.send({ type: 'session-sharing-stop', id: 'stop-one', sessionId: 'source-one' });
  expect(await owner.take('stop-one')).toMatchObject({ revoked: 1 });
  expect((await guest.http('blocked-one', 'GET', '/api/terminal/one/health')).slice(-1)[0]).toMatchObject({ type: 'error' });
  expect((await guest.http('still-two', 'GET', '/api/terminal/two/health')).some(packet => packet.type === 'head' && packet.status === 200)).toBe(true);
  owner.channel.send({ type: 'grants-list', id: 'remaining-invites' });
  const pending = await owner.take('remaining-invites');
  expect(JSON.stringify(pending.invitations)).not.toContain('"one"'); expect(JSON.stringify(pending.invitations)).toContain('"two"');
});
