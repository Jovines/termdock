import { startPasswordBootstrap, finishPasswordBootstrap, type PasswordBootstrapResponse } from './passwordBootstrap.js';
import * as authProtection from '../utils/authProtection.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createFederationRuntime, type FederationRuntimeOptions } from './runtime.js';
import { createIdentity, secureConnection, type Identity } from './secureProtocol.js';
import { socketDuplex } from './socketDuplex.js';
import { PacketChannel, fromBase64, toBase64, type Packet } from './packets.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture(runtimeOptions: FederationRuntimeOptions = {}, allowOpenAccess = false) {
  const directory = mkdtempSync(join(tmpdir(), 'termdock-e2ee-test-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const app = express(); app.use(express.json());
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
  app.get('/api/terminal/session-inventory', (_req, res) => res.json({
    clientSessions: [
      { backendSessionId: 'one', sessionId: 'source-one', name: 'Allowed', live: true, cwd: '/private', frontendSessionId: 'frontend-secret' },
      { backendSessionId: 'two', name: 'Hidden', live: true },
      { backendSessionId: null, name: 'Detached' },
    ], tmuxSessions: [{ name: 'unbound-secret' }], tmuxRecovery: { secret: true },
  }));
  app.get('/api/terminal/:session/health', (req, res) => res.json({ output: 'private-terminal-output', session: req.params.session }));
  app.post('/api/terminal/:session/input', (req, res) => { input(req.body); res.json({ success: true }); });
  let terminal: WebSocket | undefined;
  const terminalOptions = vi.fn();
  const issueRouteTicket = vi.fn(() => ({ routeToken: 'test-route-ticket', expiresAt: Date.now() + 30_000 }));
  const runtime = await createFederationRuntime(app, directory, {
    terminal(socket, _session, _client, options, dimensions) { terminal = socket; terminalOptions(options, dimensions); socket.on('message', data => received(JSON.parse(String(data)))); socket.send(JSON.stringify({ type: 'output', data: 'private-terminal-output' })); },
    control(socket) { socket.on('message', data => received(JSON.parse(String(data)))); },
  }, { issueRouteTicket, ...runtimeOptions });
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
    return { identity, channel, take, pair, http, wire };
  }
  return { connect, runtime, input, received, uploads, issueRouteTicket, terminalOptions, terminal: () => terminal };
}

describe('federation runtime over real encrypted WebSocket', () => {
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
    expect(await second.take('reuse')).toMatchObject({ type: 'error', error: 'PAIRING_DENIED' });
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
