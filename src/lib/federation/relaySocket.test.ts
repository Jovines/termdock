import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';
import { RelaySocket } from './relaySocket.js';
import { connect } from './secureClient.js';
import { RelayClient, RelayRouter } from '../../server/federation/relay.js';
import { createIdentity, secureConnection } from '../../server/federation/secureProtocol.js';
import { PacketChannel } from '../../server/federation/packets.js';
import { socketDuplex } from '../../server/federation/socketDuplex.js';
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.reverse().forEach(fn => fn()); cleanups.length = 0; vi.unstubAllGlobals(); });
async function endpoint() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  cleanups.push(() => { for (const ws of server.clients) ws.terminate(); server.close(); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  return { server, url: `ws://127.0.0.1:${address.port}` };
}
async function dial(url: string) { const ws = new WebSocket(url); cleanups.push(() => ws.terminate()); await once(ws, 'open'); return ws; }
describe('RelaySocket', () => {
  it('authenticates target Noise identity across an opaque relay and transfers private packets', async () => {
    vi.stubGlobal('CloseEvent', class extends Event { code: number; reason: string; constructor(type: string, init: { code: number; reason: string }) { super(type); this.code = init.code; this.reason = init.reason; } });
    const targetIdentity = await createIdentity();
    const c = await endpoint();
    c.server.on('connection', ws => { void (async () => {
      const secure = await secureConnection({ identity: targetIdentity, initiator: false, duplex: socketDuplex(ws) });
      const packets = new PacketChannel(secure.duplex);
      for await (const packet of packets.read()) packets.send({ id: packet.id, type: 'result', secret: 'target-private-content' });
    })().catch(() => {}); });
    const b = await endpoint();
    const router = new RelayRouter({ authenticate: context => context as string, allowRegister: p => p === 'A', allowRoute: p => p === 'phone' });
    cleanups.push(() => router.close());
    b.server.on('connection', (ws, req) => { void router.attach(ws, req.url === '/a' ? 'A' : 'phone').then(ok => { if (ok) ws.send(JSON.stringify({ type: 'ready' })); }); });
    const a = await dial(b.url + '/a');
    const relay = new RelayClient(a, { targets: new Map([[targetIdentity.peerId, () => dial(c.url)]]) });
    cleanups.push(() => relay.close());
    // Await registration processing; ping/pong is ordered after the registration frame.
    const registered = once(a, 'pong'); a.ping(); await registered;
    const client = await connect({ url: b.url + '/phone', targetPeerId: targetIdentity.peerId,
      socketFactory: url => new RelaySocket(url, targetIdentity.peerId, address => new WebSocket(address) as unknown as globalThis.WebSocket) as unknown as globalThis.WebSocket });
    cleanups.push(() => client.close());
    expect((await client.request({ type: 'test' })).secret).toBe('target-private-content');
  });
});
