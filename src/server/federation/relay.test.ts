import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';
import { RelayRouter, RelayClient } from './relay.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
async function pair() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  cleanups.push(() => { for (const ws of server.clients) ws.terminate(); server.close(); });
  const connection = once(server, 'connection');
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('No address');
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  cleanups.push(() => client.terminate());
  await once(client, 'open');
  return { client, server: (await connection)[0] as WebSocket };
}
const next = async (ws: WebSocket) => JSON.parse(String((await once(ws, 'message'))[0]));
async function setup(ttl = 60000) {
  const router = new RelayRouter<string>({ authenticate: c => typeof c === 'string' ? c : null,
    allowRegister: (p, s) => p === 'A' && s === 'C', allowRoute: (p, s) => p === 'phone' && s === 'C', heartbeatMs: 50, maxRouteTtlMs: ttl });
  cleanups.push(() => router.close());
  const a = await pair(), phone = await pair();
  await router.attach(a.server, 'A'); await router.attach(phone.server, 'phone');
  return { router, a, phone };
}
describe('RelayRouter and RelayClient', () => {
  it('routes opaque ciphertext phone → B → A → C without a B-to-C dialer', async () => {
    const { a, phone } = await setup();
    const c = await pair();
    let connections = 0;
    const relay = new RelayClient(a.client, { targets: new Map([['C', async () => { connections++; return c.client; }]]) });
    cleanups.push(() => relay.close());
    // Registration precedes this marker on the same connection.
    const registered = once(a.server, 'message'); await registered;
    const opened = next(phone.client);
    phone.client.send(JSON.stringify({ type: 'open', streamId: 'phone-1', serviceId: 'C' }));
    expect((await opened).type).toBe('opened');
    const received = once(c.server, 'message');
    phone.client.send(JSON.stringify({ type: 'data', streamId: 'phone-1', payload: 'ciphertext:abc' }));
    expect(String((await received)[0])).toBe('ciphertext:abc');
    const output = next(phone.client); c.server.send('ciphertext:output');
    expect(await output).toEqual({ type: 'data', streamId: 'phone-1', payload: 'ciphertext:output' });
    const binaryReceived = once(c.server, 'message');
    phone.client.send(JSON.stringify({ type: 'data', streamId: 'phone-1', payload: Buffer.from([0, 255, 128]).toString('base64'), encoding: 'base64' }));
    const binary = await binaryReceived;
    expect(binary[1]).toBe(true);
    expect([...binary[0] as Buffer]).toEqual([0, 255, 128]);
    const binaryOutput = next(phone.client); c.server.send(Buffer.from([255, 0]));
    expect(await binaryOutput).toEqual({ type: 'data', streamId: 'phone-1', payload: '/wA=', encoding: 'base64' });
    expect(connections).toBe(1);
    const closed = next(phone.client); a.client.terminate();
    expect((await closed).type).toBe('close');
  });
  it('denies unauthenticated registration and unregistered targets', async () => {
    const { router, phone } = await setup();
    const stranger = await pair();
    expect(await router.attach(stranger.server, null)).toBe(false);
    const denied = next(phone.client);
    phone.client.send(JSON.stringify({ type: 'open', streamId: 'x', serviceId: 'unknown' }));
    expect((await denied).type).toBe('close');
  });
  it('expires route advertisements and closes their active streams', async () => {
    const { a, phone } = await setup(30);
    const registered = once(a.server, 'message');
    a.client.send(JSON.stringify({ type: 'register', serviceIds: ['C'], ttlMs: 30 })); await registered;
    const forwarded = next(a.client);
    phone.client.send(JSON.stringify({ type: 'open', streamId: 'x', serviceId: 'C' })); await forwarded;
    expect((await next(phone.client)).reason).toBe('Route unavailable');
  });
  it('closes oversized application frames', async () => {
    const router = new RelayRouter({ authenticate: () => 'phone', allowRegister: () => false, allowRoute: () => true, maxFrameBytes: 128 });
    cleanups.push(() => router.close());
    const p = await pair(); await router.attach(p.server, null);
    const closed = once(p.client, 'close');
    p.client.send(JSON.stringify({ type: 'data', streamId: 'x', payload: 'x'.repeat(200) }));
    expect((await closed)[0]).toBe(1008);
  });
  it('rejects route theft by another authenticated relay', async () => {
    const { router, a } = await setup();
    const registered = once(a.server, 'message');
    a.client.send(JSON.stringify({ type: 'register', serviceIds: ['C'], ttlMs: 10000 })); await registered;
    const thief = await pair(); await router.attach(thief.server, 'A');
    const closed = once(thief.client, 'close');
    thief.client.send(JSON.stringify({ type: 'register', serviceIds: ['C'], ttlMs: 10000 }));
    expect((await closed)[0]).toBe(1008);
  });
  it('does not allow a consumer to advertise a target', async () => {
    const { phone } = await setup();
    const closed = once(phone.client, 'close');
    phone.client.send(JSON.stringify({ type: 'register', serviceIds: ['C'], ttlMs: 1000 }));
    expect((await closed)[0]).toBe(1008);
  });
});
