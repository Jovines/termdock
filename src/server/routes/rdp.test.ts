import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFederationRuntime } from '../federation/runtime.js';
import { createIdentity, secureConnection } from '../federation/secureProtocol.js';
import { socketDuplex } from '../federation/socketDuplex.js';
import { PacketChannel, type Packet } from '../federation/packets.js';
import { RelayClient, RelayRouter } from '../federation/relay.js';
import { RelaySocket } from '../../lib/federation/relaySocket.js';
import { createComputerRouter, handleComputerWebSocket, stopComputerBridges } from './computer.js';
import { loadSettingsFile, saveSettingsFile } from '../utils/settings.js';
import { defaultComputerPreferences } from '../../lib/computer/preferences.js';
import { ComputerCredentialStore } from '../utils/computerCredentials.js';
import { GuacamoleParser, guacamoleInstruction } from './guacamoleProtocol.js';

const cleanups: Array<() => void> = [];
afterEach(() => { stopComputerBridges(); for (const close of cleanups.splice(0).reverse()) close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function wsServer() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  cleanups.push(() => { for (const socket of server.clients) socket.terminate(); server.close(); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No listener');
  return { server, url: `ws://127.0.0.1:${address.port}` };
}
async function dial(url: string) {
  const socket = new WebSocket(url); cleanups.push(() => socket.terminate()); await once(socket, 'open'); return socket;
}
async function fixture(mode: 'direct' | 'relay', full = true) {
  vi.stubGlobal('CloseEvent', class extends Event {
    code: number; reason: string;
    constructor(type: string, options: { code?: number; reason?: string } = {}) { super(type); this.code = options.code ?? 1000; this.reason = options.reason ?? ''; }
  });
  const configurations: Record<string, string>[] = [], inputs: string[][] = [];
  const connections = new Set<Socket>();
  const guacd = createServer(socket => {
    connections.add(socket); socket.once('close', () => connections.delete(socket)); socket.setEncoding('utf8');
    const names = ['VERSION_1_5_0', 'hostname', 'port', 'username', 'password', 'domain', 'security', 'ignore-cert', 'enable-drive', 'resize-method'];
    const parser = new GuacamoleParser(values => {
      const [op, ...args] = values;
      if (op === 'select') { expect(args).toEqual(['rdp']); socket.write(guacamoleInstruction('args', ...names)); }
      else if (op === 'connect') {
        configurations.push(Object.fromEntries(names.map((name, index) => [name, args[index]])));
        socket.write(guacamoleInstruction('ready', 'rdp-id') + guacamoleInstruction('size', '0', '1280', '800') + guacamoleInstruction('sync', '1'));
      } else inputs.push(values);
    });
    socket.on('data', data => parser.receive(String(data)));
  });
  guacd.listen(0, '127.0.0.1'); await once(guacd, 'listening');
  cleanups.push(() => { for (const socket of connections) socket.destroy(); guacd.close(); });
  const address = guacd.address(); if (!address || typeof address === 'string') throw new Error('No guacd');
  vi.stubEnv('TERMDOCK_GUACD_PORT', String(address.port));
  const directory = mkdtempSync(join(tmpdir(), 'termdock-rdp-test-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const settingsFile = join(directory, 'settings.json');
  const credentialStore = new ComputerCredentialStore(directory);
  const app = express(); app.use(express.json());
  app.use('/api/computer', createComputerRouter(() => loadSettingsFile(settingsFile), mutator => { const settings = loadSettingsFile(settingsFile); const next = mutator(settings) ?? settings; saveSettingsFile(next, settingsFile); return next; }, credentialStore));
  const runtime = await createFederationRuntime(app, directory, {
    terminal() {}, control() {}, computer: handleComputerWebSocket,
  });
  cleanups.push(() => runtime.close());
  const target = await wsServer(); target.server.on('connection', socket => { void runtime.accept(socket); });
  const identity = await createIdentity();
  runtime.store.grant({ subjectId: identity.peerId, scope: { kind: 'service' }, actions: [full ? 'service:*' : 'service.view'] });
  const wire: string[] = [];
  let socket: WebSocket | RelaySocket;
  if (mode === 'relay') {
    const router = new RelayRouter<string>({ authenticate: value => String(value),
      allowRegister: (peer, service) => peer === 'provider' && service === runtime.serviceId,
      allowRoute: (peer, service) => peer === 'phone' && service === runtime.serviceId });
    cleanups.push(() => router.close());
    const entry = await wsServer();
    let providerServer: WebSocket | undefined;
    entry.server.on('connection', (client, req) => {
      const peer = req.url === '/provider' ? 'provider' : 'phone';
      if (peer === 'provider') providerServer = client;
      void router.attach(client, peer).then(accepted => { if (accepted && peer === 'phone') client.send(JSON.stringify({ type: 'ready' })); });
    });
    const provider = await dial(entry.url + '/provider');
    const registered = once(providerServer!, 'message');
    const relay = new RelayClient(provider, { targets: new Map([[runtime.serviceId, () => dial(target.url)]]) });
    cleanups.push(() => relay.close()); await registered;
    provider.on('message', raw => wire.push(String(raw)));
    socket = new RelaySocket(entry.url + '/phone', runtime.serviceId, url => new WebSocket(url) as unknown as globalThis.WebSocket);
    cleanups.push(() => socket.close());
    await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve()); socket.addEventListener('error', () => reject(new Error('Relay failed'))); });
  } else socket = await dial(target.url);
  socket.addEventListener('message', (event: unknown) => wire.push(new TextDecoder().decode((event as { data: ArrayBuffer }).data)));
  const secured = await secureConnection({ identity, initiator: true, targetPinnedPeerId: runtime.serviceId, duplex: socketDuplex(socket) });
  const channel = new PacketChannel(secured.duplex); cleanups.push(() => channel.close());
  const pending: Packet[] = [];
  void (async () => { try { for await (const packet of channel.read()) pending.push(packet); } catch { /* intentional failure/teardown */ } })();
  const take = async (id: string, type: string) => {
    await vi.waitFor(() => expect(pending.some(packet => packet.id === id && packet.type === type)).toBe(true));
    return pending.splice(pending.findIndex(packet => packet.id === id && packet.type === type), 1)[0];
  };
  const open = async (host = '127.0.0.1', id = 'rdp') => {
    channel.send({ type: 'ws-open', id, path: `/api/computer/ws?host=${encodeURIComponent(host)}&protocol=rdp&port=3390` });
    return take(id, full ? 'ws-ready' : 'error');
  };
  const send = (data: unknown, id = 'rdp') => channel.send({ type: 'ws-data', id, data: JSON.stringify(data) });
  const start = { type: 'start', username: 'test-rdp-user', password: 'private-rdp-password-unique', domain: '', ignoreCert: false, width: 1280, height: 800 };
  const api = async (method: string, body?: unknown, path = '/preferences') => {
    const id = crypto.randomUUID();
    channel.send({ type: 'http', id, method, path: '/api/computer' + path, headers: { 'content-type': 'application/json' } });
    if (body) { channel.send({ type: 'upload', id, data: Buffer.from(JSON.stringify(body)).toString('base64') }); if (full) await take(id, 'upload-ack'); }
    channel.send({ type: 'upload-end', id });
    if (!full) return take(id, 'error');
    const head = await take(id, 'head'), data = await take(id, 'chunk');
    channel.send({ type: 'ack', id }); await take(id, 'end');
    return { status: head.status, body: JSON.parse(Buffer.from(String(data.data), 'base64').toString()) };
  };
  return { api, settingsFile, credentialStore, channel, configurations, inputs, connections, wire, take, open, send, start };
}

describe('RDP over the authenticated encrypted transport', () => {
  it.each(['direct', 'relay'] as const)('remembers, uses and forgets login over %s without exposing secrets in settings or outer traffic', async mode => {
    const f = await fixture(mode), preferences = defaultComputerPreferences('linux');
    preferences.local.username = f.start.username; preferences.local.port = '3390'; preferences.local.ignoreCert = true;
    expect(await f.api('PUT', preferences)).toMatchObject({ status: 200 });
    expect(await f.api('POST', { profile: preferences.local, password: f.start.password }, '/credentials/save')).toMatchObject({ status: 200, body: { saved: true } });
    expect((await f.api('GET') as { body: { credentialKeys: string[] } }).body.credentialKeys).toHaveLength(1);
    expect(readFileSync(f.settingsFile, 'utf8')).not.toContain(f.start.password);
    expect(readFileSync(f.credentialStore.file, 'utf8')).not.toContain(f.start.password);
    expect(await f.api('POST', { profile: { ...preferences.local, host: '192.168.1.99' } }, '/credentials/use')).toMatchObject({ status: 400 });
    expect(await f.api('POST', { profile: preferences.local }, '/credentials/use')).toMatchObject({ status: 200, body: { password: f.start.password } });
    await f.open(); f.send({ ...f.start, ignoreCert: true }); await f.take('rdp', 'ws-data');
    expect(f.configurations[0]).toMatchObject({ password: f.start.password, 'ignore-cert': 'true' });
    expect(f.wire.every(chunk => !chunk.includes(f.start.password) && !chunk.includes(f.start.username))).toBe(true);
    expect(await f.api('POST', { profile: preferences.local }, '/credentials/forget')).toMatchObject({ status: 200, body: { saved: false } });
    expect(await f.api('POST', { profile: preferences.local }, '/credentials/use')).toMatchObject({ status: 404 });
  });
  it('denies credential access to a read-only service grant', async () => {
    const f = await fixture('direct', false);
    expect(await f.api('POST', undefined, '/credentials/use')).toMatchObject({ type: 'error', error: 'API_NOT_ALLOWED' });
  });
  it('keeps connection settings usable when the credential file cannot be read', async () => {
    const f = await fixture('direct'), preferences = defaultComputerPreferences();
    preferences.local.username = 'qiao'; preferences.local.ignoreCert = true;
    await f.api('PUT', preferences); writeFileSync(f.credentialStore.file, 'corrupt-data');
    expect(await f.api('GET')).toMatchObject({ status: 200, body: { preferences, credentialKeys: [], credentialError: true } });
  });
  it.each(['direct', 'relay'] as const)('carries credentials, display and input over %s, then cleans up cancellation and reconnects', async mode => {
    const f = await fixture(mode); await f.open(); f.send(f.start);
    const frame = JSON.parse(String((await f.take('rdp', 'ws-data')).data));
    expect(frame.instructions).toContainEqual(['size', '0', '1280', '800']);
    expect(f.configurations[0]).toMatchObject({ hostname: '127.0.0.1', port: '3390', username: f.start.username, password: f.start.password, 'ignore-cert': 'false', 'enable-drive': 'false', 'resize-method': 'display-update' });
    expect(f.wire.every(chunk => !chunk.includes(f.start.password) && !chunk.includes(f.start.username))).toBe(true);
    f.send({ type: 'ack', seq: frame.seq }); f.send({ type: 'instruction', opcode: 'key', args: ['65507', '1'] });
    await vi.waitFor(() => expect(f.inputs).toContainEqual(['key', '65507', '1']));
    f.send({ type: 'instruction', opcode: 'size', args: ['1920', '900'] });
    await vi.waitFor(() => expect(f.inputs).toContainEqual(['size', '1920', '900']));
    f.channel.send({ type: 'ws-close', id: 'rdp' });
    await vi.waitFor(() => expect(f.connections.size).toBe(0));
    await f.open('127.0.0.1', 'again'); f.send(f.start, 'again');
    expect(JSON.parse(String((await f.take('again', 'ws-data')).data)).instructions).toContainEqual(['ready', 'rdp-id']);
  });

  it.each(['direct', 'relay'] as const)('persists connection selections before connecting over %s, restores them, and excludes passwords', async mode => {
    const f = await fixture(mode);
    const preferences = defaultComputerPreferences('linux');
    preferences.target = 'remote'; preferences.remote = { ...preferences.remote, host: '192.168.1.20', port: '3390', username: 'test-user', ignoreCert: true };
    expect(await f.api('PUT', preferences)).toMatchObject({ status: 200 });
    expect(await f.api('GET')).toMatchObject({ status: 200, body: { configured: true, preferences } });
    expect(JSON.parse(readFileSync(f.settingsFile, 'utf8')).computerControl).toEqual(preferences);
    expect(f.wire.every(chunk => !chunk.includes('test-user') && !chunk.includes('192.168.1.20'))).toBe(true);
    expect(await f.api('PUT', { ...preferences, password: 'must-not-be-stored' })).toMatchObject({ status: 400 });
    expect(readFileSync(f.settingsFile, 'utf8')).not.toContain('must-not-be-stored');
  });
  it('denies connection preferences to a view-only service grant', async () => {
    const f = await fixture('direct', false); expect(await f.api('GET')).toMatchObject({ error: 'API_NOT_ALLOWED' });
  });
  it('rejects oversized RDP display requests', async () => {
    const f = await fixture('direct'); await f.open(); f.send(f.start); await f.take('rdp', 'ws-data');
    f.send({ type: 'instruction', opcode: 'size', args: ['9999', '9999'] });
    expect(await f.take('rdp', 'ws-close')).toMatchObject({ reason: 'COMPUTER_INVALID_MESSAGE' });
    expect(f.inputs).not.toContainEqual(['size', '9999', '9999']);
  });

  it('requires full service access before opening the RDP bridge', async () => {
    const f = await fixture('direct', false);
    expect(await f.open()).toMatchObject({ error: 'API_NOT_ALLOWED' });
    expect(f.connections.size).toBe(0);
  });

  it('rejects a public target before connecting to guacd', async () => {
    const f = await fixture('direct'); await f.open('8.8.8.8'); f.send(f.start);
    expect(await f.take('rdp', 'ws-close')).toMatchObject({ reason: 'COMPUTER_PRIVATE_HOST_ONLY' });
    expect(f.connections.size).toBe(0);
  });

  it('rejects attempts to change the protocol or hostname after the server handshake', async () => {
    const f = await fixture('direct'); await f.open(); f.send(f.start);
    await f.take('rdp', 'ws-data');
    f.send({ type: 'instruction', opcode: 'select', args: ['ssh'] });
    expect(await f.take('rdp', 'ws-close')).toMatchObject({ reason: 'COMPUTER_INVALID_MESSAGE' });
    expect(f.configurations).toHaveLength(1);
  });

  it('reports backend failure and keeps the encrypted connection available for a fresh attempt', async () => {
    const f = await fixture('direct'); vi.stubEnv('TERMDOCK_GUACD_PORT', '1');
    await f.open(); f.send(f.start);
    expect(await f.take('rdp', 'ws-close')).toMatchObject({ reason: 'COMPUTER_RDP_BACKEND_UNAVAILABLE' });
    await f.open('127.0.0.1', 'retry');
  });
});

describe('Guacamole framing', () => {
  it('preserves fragmented and adjacent instructions, including empty strings and Unicode', () => {
    const received: string[][] = []; const parser = new GuacamoleParser(values => received.push(values));
    const wire = guacamoleInstruction('name', '桌面🖥️', '') + guacamoleInstruction('sync', '42');
    for (const char of wire) parser.receive(char);
    expect(received).toEqual([['name', '桌面🖥️', ''], ['sync', '42']]);
  });
  it.each(['x.bad;', '3.foo!', '9999999.x'])('rejects malformed or oversized framing: %s', wire => {
    expect(() => new GuacamoleParser(() => {}).receive(wire)).toThrow();
  });
});
