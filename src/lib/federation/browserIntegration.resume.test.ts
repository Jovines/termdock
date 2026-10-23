import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createIdentity, secureConnection } from '../../server/federation/secureProtocol';
import { PacketChannel, toBase64 } from '../../server/federation/packets';
import { socketDuplex } from '../../server/federation/socketDuplex';

const state = vi.hoisted(() => ({ target: null as null | { url: string; targetPeerId: string; routes?: { url: string; targetPeerId: string }[] }, identity: vi.fn() }));
vi.mock('./deviceIdentity', () => ({ getIdentity: state.identity }));
vi.mock('./clientScope', () => ({
  get BOOT_SERVICE_ID() { return state.target?.targetPeerId; }, ENTRY_KEY: 'entry',
  selectedTarget: () => state.target, saveSelectedTarget: vi.fn(), clearSelectedTarget: vi.fn(), migrateLegacyServiceState: vi.fn(),
}));
vi.mock('../services/serviceDirectory', () => ({
  listServiceConnections: async () => [], normalizeServiceAddress: (url: string) => url,
  rememberServiceConnection: vi.fn(), saveServiceConnection: vi.fn(),
}));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); vi.unstubAllGlobals(); });

it('recovers real encrypted direct traffic after an outage and an authenticated relay denial on first load without a worker', async () => {
  vi.resetModules();
  const identity = await createIdentity(), service = await createIdentity(), entry = await createIdentity();
  state.identity.mockResolvedValue(identity);
  const directServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const entryServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  cleanups.push(() => {
    for (const server of [directServer, entryServer]) { for (const socket of server.clients) socket.terminate(); server.close(); }
  });
  await Promise.all([once(directServer, 'listening'), once(entryServer, 'listening')]);
  const originOf = (server: WebSocketServer) => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No listener');
    return `http://127.0.0.1:${address.port}`;
  };
  const origin = originOf(directServer), entryOrigin = originOf(entryServer);
  state.target = { url: origin, targetPeerId: service.peerId, routes: [{ url: entryOrigin, targetPeerId: entry.peerId }] };
  vi.stubGlobal('WebSocket', WebSocket);
  vi.stubGlobal('navigator', { onLine: true, serviceWorker: Object.assign(new EventTarget(), { controller: null }) });
  vi.stubGlobal('location', { origin, host: new URL(origin).host, href: `${origin}/`, search: '', reload: vi.fn() });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location }));
  const nativeFetch = vi.fn(() => { throw new Error('Plaintext business request forbidden'); });
  vi.stubGlobal('fetch', nativeFetch);
  let reachable = false;
  const entryRequests: string[] = [], wire: Uint8Array[] = [];
  entryServer.on('connection', socket => { void (async () => {
    const secure = await secureConnection({ identity: entry, initiator: false, duplex: socketDuplex(socket) });
    const channel = new PacketChannel(secure.duplex);
    for await (const packet of channel.read()) {
      entryRequests.push(packet.type);
      channel.send({ id: packet.id, type: 'error', error: 'AUTHORIZATION_DENIED' });
    }
  })().catch(() => {}); });
  directServer.on('connection', socket => {
    if (!reachable) { socket.close(); return; }
    socket.on('message', bytes => wire.push(new Uint8Array(bytes as ArrayBuffer).slice()));
    void (async () => {
      const secure = await secureConnection({ identity: service, initiator: false, duplex: socketDuplex(socket) });
      const channel = new PacketChannel(secure.duplex);
      for await (const packet of channel.read()) {
        if (packet.type === 'permissions') channel.send({ id: packet.id, type: 'result', fullService: true, grants: [{ actions: ['service:*'] }] });
        if (packet.type === 'upload-end') {
          channel.send({ id: packet.id, type: 'head', status: 200, headers: {} });
          channel.send({ id: packet.id, type: 'chunk', data: toBase64(new TextEncoder().encode('private-direct-recovered')) });
        }
        if (packet.type === 'ack') channel.send({ id: packet.id, type: 'end' });
      }
    })().catch(() => {});
  });
  const integration = await import('./browserIntegration');
  cleanups.push(() => integration.invalidateSecureTransport());
  integration.installEncryptedFetch();
  await expect(integration.getActiveClient()).rejects.toMatchObject({ code: 'RELAY_AUTHORIZATION_REQUIRED' });
  await expect(integration.retryDirectConnection()).rejects.toMatchObject({ type: 'close' });
  await expect(integration.getActiveClient()).rejects.toMatchObject({ code: 'RELAY_AUTHORIZATION_REQUIRED' });
  expect(entryRequests).toEqual(['route-ticket']);
  reachable = true;
  const recovered = await integration.retryDirectConnection();
  expect(await integration.getActiveClient()).toBe(recovered);
  expect(integration.currentConnectionPath()).toBe('direct');
  const response = await window.fetch('/api/terminal/sessions');
  expect(await response.text()).toBe('private-direct-recovered');
  expect(entryRequests).toEqual(['route-ticket']);
  expect(nativeFetch).not.toHaveBeenCalled(); expect(location.reload).not.toHaveBeenCalled();
  expect(wire.every(bytes => !new TextDecoder().decode(bytes).includes('private-direct-recovered'))).toBe(true);
});

it.each(['before-headers', 'during-body'] as const)('recovers a real encrypted read interrupted %s without a page reload or plaintext fallback', async interruption => {
  vi.resetModules();
  const identity = await createIdentity(), service = await createIdentity();
  state.identity.mockResolvedValue(identity);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  cleanups.push(() => { for (const socket of server.clients) socket.terminate(); server.close(); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listener');
  const origin = `http://127.0.0.1:${address.port}`;
  state.target = { url: origin, targetPeerId: service.peerId };
  vi.stubGlobal('WebSocket', WebSocket);
  vi.stubGlobal('navigator', { onLine: true, serviceWorker: Object.assign(new EventTarget(), { controller: null }) });
  vi.stubGlobal('location', { origin, host: new URL(origin).host, href: `${origin}/`, search: '', reload: vi.fn() });
  const windowEvents = new EventTarget();
  vi.stubGlobal('window', Object.assign(windowEvents, { location }));
  const nativeFetch = vi.fn(() => { throw new Error('Plaintext business request forbidden'); });
  vi.stubGlobal('fetch', nativeFetch);
  let connections = 0, reads = 0;
  let suspended: WebSocket | undefined;
  const wire: Uint8Array[] = [], paths: string[] = [];
  const json = JSON.stringify({ tasks: [{ title: 'private-resumed-result' }] });
  server.on('connection', socket => {
    connections++;
    socket.on('message', bytes => wire.push(new Uint8Array(bytes as ArrayBuffer).slice()));
    void (async () => {
      const secure = await secureConnection({ identity: service, initiator: false, duplex: socketDuplex(socket) });
      const channel = new PacketChannel(secure.duplex);
      for await (const packet of channel.read()) {
        if (packet.type === 'permissions') channel.send({ id: packet.id, type: 'result', fullService: true, grants: [{ actions: ['service:*'] }] });
        if (packet.type === 'http') paths.push(String(packet.path));
        if (packet.type === 'upload-end') {
          reads++;
          if (reads === 1 && interruption === 'before-headers') { socket.terminate(); continue; }
          channel.send({ id: packet.id, type: 'head', status: 200, headers: { 'Content-Type': 'application/json' } });
          if (reads === 1) { suspended = socket; continue; }
          channel.send({ id: packet.id, type: 'chunk', data: toBase64(new TextEncoder().encode(json)) });
        }
        if (packet.type === 'ack') channel.send({ id: packet.id, type: 'end' });
      }
    })().catch(() => {});
  });
  const integration = await import('./browserIntegration');
  const previous = await integration.connectDevice(state.target);
  cleanups.push(() => integration.invalidateSecureTransport());
  integration.installEncryptedFetch(); vi.stubGlobal('fetch', window.fetch);
  const read = () => window.fetch('/api/terminal/operations/collaboration-tasks').then(response => {
    if (interruption === 'during-body' && reads === 1) suspended?.terminate();
    return response.json();
  });
  expect(await integration.readWithSecureReconnect(read)).toEqual(JSON.parse(json));
  expect(previous.closed).toBe(true);
  expect(connections).toBe(2); expect(reads).toBe(2);
  expect(paths).toEqual(Array(2).fill('/api/terminal/operations/collaboration-tasks'));
  expect(nativeFetch).not.toHaveBeenCalled(); expect(location.reload).not.toHaveBeenCalled();
  expect(wire.every(bytes => !new TextDecoder().decode(bytes).includes('private-resumed-result'))).toBe(true);
});
