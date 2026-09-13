import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { connect, type SecureSocket } from './secureClient';
import { RelaySocket } from './relaySocket';
import { RelayClient, RelayRouter } from '../../server/federation/relay';
import { createIdentity, secureConnection } from '../../server/federation/secureProtocol';
import { PacketChannel } from '../../server/federation/packets';
import { socketDuplex } from '../../server/federation/socketDuplex';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); vi.unstubAllGlobals(); });
async function endpoint() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  cleanups.push(() => { for (const socket of server.clients) socket.terminate(); server.close(); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listener');
  return { server, url: `ws://127.0.0.1:${address.port}` };
}
async function dial(url: string) {
  const socket = new WebSocket(url); cleanups.push(() => socket.terminate());
  await once(socket, 'open'); return socket;
}
async function opened(socket: SecureSocket) {
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('Open failed')); });
  return socket;
}
async function echo(socket: SecureSocket, data: string) {
  const response = new Promise<string>(resolve => { socket.onmessage = event => resolve(String(event.data)); });
  socket.send(data); expect(await response).toBe(data);
}

it.each(['direct', 'relay'] as const)('replaces a real encrypted %s channel without replaying terminal input', async mode => {
  vi.stubGlobal('CloseEvent', class extends Event {
    constructor(type: string, readonly init: CloseEventInit = {}) { super(type); }
    get code() { return this.init.code; } get reason() { return this.init.reason; }
  });
  const identity = await createIdentity(), targetIdentity = await createIdentity();
  const target = await endpoint();
  const wire: Uint8Array[] = [], input: string[] = [], paths: string[] = [];
  target.server.on('connection', socket => {
    socket.on('message', bytes => wire.push(new Uint8Array(bytes as ArrayBuffer).slice()));
    void (async () => {
      const secure = await secureConnection({ identity: targetIdentity, initiator: false, duplex: socketDuplex(socket) });
      const channel = new PacketChannel(secure.duplex);
      for await (const packet of channel.read()) {
        if (packet.type === 'ws-open') {
          paths.push(String(packet.path)); channel.send({ id: packet.id, type: 'ws-ready' });
        } else if (packet.type === 'ws-data') {
          input.push(String(packet.data)); channel.send({ id: packet.id, type: 'ws-data', data: packet.data });
        } else if (packet.type === 'permissions') channel.send({ id: packet.id, type: 'result', fullService: true });
      }
    })().catch(() => {});
  });
  let url = target.url;
  let socketFactory = (address: string) => new WebSocket(address) as unknown as globalThis.WebSocket;
  if (mode === 'relay') {
    const entry = await endpoint();
    const router = new RelayRouter({ authenticate: context => context as string, allowRegister: peer => peer === 'publisher', allowRoute: peer => peer === 'device' });
    cleanups.push(() => router.close());
    entry.server.on('connection', (socket, req) => {
      void router.attach(socket, req.url === '/publisher' ? 'publisher' : 'device').then(ok => { if (ok) socket.send(JSON.stringify({ type: 'ready' })); });
    });
    const publisher = await dial(entry.url + '/publisher');
    const relay = new RelayClient(publisher, { targets: new Map([[targetIdentity.peerId, () => dial(target.url)]]) });
    cleanups.push(() => relay.close());
    const registered = once(publisher, 'pong'); publisher.ping(); await registered;
    url = entry.url + '/device';
    socketFactory = address => new RelaySocket(address, targetIdentity.peerId,
      local => new WebSocket(local) as unknown as globalThis.WebSocket) as unknown as globalThis.WebSocket;
  }
  const options = { url, socketFactory, identity, targetPeerId: targetIdentity.peerId };
  const old = await connect(options); cleanups.push(() => old.close());
  const first = await opened(old.openSocket('/api/terminal/session/ws'));
  const before = JSON.stringify({ type: 'input', data: 'private-before-renewal' });
  await echo(first, before);
  // Both authenticated channels coexist until the candidate is confirmed.
  const replacement = await connect(options); cleanups.push(() => replacement.close());
  expect((await replacement.request({ type: 'permissions' })).fullService).toBe(true);
  expect(old.closed).toBe(false);
  const closed = vi.fn(), error = vi.fn(); first.onclose = closed; first.onerror = error;
  old.retire();
  expect(closed).toHaveBeenCalledWith(expect.objectContaining({ code: 1012, reason: 'Encrypted transport renewed' }));
  expect(error).not.toHaveBeenCalled();
  const second = await opened(replacement.openSocket('/api/terminal/session/ws?since=7'));
  const after = JSON.stringify({ type: 'input', data: 'private-after-renewal' });
  await echo(second, after);
  expect(paths).toEqual(['/api/terminal/session/ws', '/api/terminal/session/ws?since=7']);
  expect(input).toEqual([before, after]);
  expect(wire.every(bytes => !new TextDecoder().decode(bytes).includes('private-'))).toBe(true);
});
