import { afterEach, describe, expect, it, vi } from 'vitest';
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
  it('rejects advertisements from a relay without permission for the target', async () => {
    const { router, a } = await setup();
    const registered = once(a.server, 'message');
    a.client.send(JSON.stringify({ type: 'register', serviceIds: ['C'], ttlMs: 10000 })); await registered;
    const thief = await pair(); await router.attach(thief.server, 'unauthorized-relay');
    const closed = once(thief.client, 'close');
    thief.client.send(JSON.stringify({ type: 'register', serviceIds: ['C'], ttlMs: 10000 }));
    expect((await closed)[0]).toBe(1008);
  });
  async function redundant(timeout = 1000, maxStreams = 128, routeTimeoutMs = 1000) {
    const registrations = new Set(['relay-1', 'relay-2']);
    const router = new RelayRouter<string>({ authenticate: c => String(c),
      allowRegister: p => registrations.has(p), allowRoute: p => p === 'phone',
      connectTimeoutMs: timeout, maxStreams, routeTimeoutMs });
    cleanups.push(() => router.close());
    const first = await pair(), backup = await pair(), consumer = await pair();
    await router.attach(first.server, 'relay-1'); await router.attach(backup.server, 'relay-2');
    await router.attach(consumer.server, 'phone');
    for (const provider of [first, backup]) {
      const registered = once(provider.server, 'message');
      provider.client.send(JSON.stringify({ type: 'register', serviceIds: ['C'], ttlMs: 60000 }));
      await registered;
    }
    return { router, first, backup, consumer, registrations };
  }
  it.each(['rejection', 'disconnect', 'withdrawal', 'timeout'] as const)('uses an authorized backup before opening after provider %s', async failure => {
    const { router, first, backup, consumer } = await redundant(failure === 'timeout' ? 100 : 1000);
    const firstOpen = next(first.client), backupOpen = next(backup.client);
    const consumerFrames: unknown[] = [];
    consumer.client.on('message', raw => consumerFrames.push(JSON.parse(String(raw))));
    consumer.client.send(JSON.stringify({ type: 'open', streamId: 's', serviceId: 'C' }));
    const original = await firstOpen;
    if (failure === 'rejection') first.client.send(JSON.stringify({ type: 'close', streamId: original.streamId }));
    if (failure === 'disconnect') first.client.terminate();
    if (failure === 'withdrawal') first.client.send(JSON.stringify({ type: 'register', serviceIds: [], ttlMs: 60000 }));
    const alternate = await backupOpen;
    expect(alternate.streamId).not.toBe(original.streamId);
    // Late frames from the failed attempt cannot close or open its replacement.
    if (first.client.readyState === WebSocket.OPEN) {
      first.client.send(JSON.stringify({ type: 'opened', streamId: original.streamId }));
      first.client.send(JSON.stringify({ type: 'close', streamId: original.streamId }));
    }
    backup.client.send(JSON.stringify({ type: 'opened', streamId: alternate.streamId }));
    await vi.waitFor(() => expect(consumerFrames).toEqual([{ type: 'opened', streamId: 's' }]));
    expect(router.hasRoute('C')).toBe(true);
    const data = next(backup.client);
    consumer.client.send(JSON.stringify({ type: 'data', streamId: 's', payload: 'ciphertext', encoding: 'base64' }));
    expect(await data).toMatchObject({ type: 'data', streamId: alternate.streamId, payload: 'ciphertext' });
  });
  it('bounds the whole route attempt even when each provider has a longer connection timeout', async () => {
    const { first, backup, consumer } = await redundant(1000, 128, 50);
    const forwarded = next(first.client), closed = next(consumer.client);
    const backupFrames: unknown[] = []; backup.client.on('message', raw => backupFrames.push(JSON.parse(String(raw))));
    consumer.client.send(JSON.stringify({ type: 'open', streamId: 'budget', serviceId: 'C' })); await forwarded;
    expect((await closed).reason).toBe('Target timeout'); expect(backupFrames).toEqual([]);
  });
  it('rechecks a pending provider permission before accepting its opened frame', async () => {
    const { first, backup, consumer, registrations } = await redundant();
    const forwarded = next(first.client), alternate = next(backup.client);
    consumer.client.send(JSON.stringify({ type: 'open', streamId: 's', serviceId: 'C' }));
    const frame = await forwarded; registrations.delete('relay-1');
    first.client.send(JSON.stringify({ type: 'opened', streamId: frame.streamId }));
    const replacement = await alternate, opened = next(consumer.client);
    backup.client.send(JSON.stringify({ type: 'opened', streamId: replacement.streamId }));
    expect(await opened).toEqual({ type: 'opened', streamId: 's' });
  });
  it('does not move or replay an opened stream when its provider disconnects', async () => {
    const { first, backup, consumer } = await redundant();
    const backupFrames: unknown[] = []; backup.client.on('message', raw => backupFrames.push(JSON.parse(String(raw))));
    const forwarding = next(first.client);
    consumer.client.send(JSON.stringify({ type: 'open', streamId: 's', serviceId: 'C' }));
    const frame = await forwarding; const opened = next(consumer.client);
    first.client.send(JSON.stringify({ type: 'opened', streamId: frame.streamId })); await opened;
    const closed = next(consumer.client); first.client.terminate();
    expect((await closed).type).toBe('close'); expect(backupFrames).toEqual([]);
    const replacement = next(backup.client);
    consumer.client.send(JSON.stringify({ type: 'open', streamId: 'new-handshake', serviceId: 'C' }));
    expect((await replacement).serviceId).toBe('C');
  });
  it('skips a saturated provider while keeping its existing stream intact', async () => {
    const { first, backup, consumer, router } = await redundant(1000, 1);
    const open = next(first.client);
    consumer.client.send(JSON.stringify({ type: 'open', streamId: 'first', serviceId: 'C' }));
    await open;
    const other = await pair(); await router.attach(other.server, 'phone');
    const alternate = next(backup.client);
    other.client.send(JSON.stringify({ type: 'open', streamId: 'second', serviceId: 'C' }));
    expect((await alternate).type).toBe('open');
    expect(first.client.readyState).toBe(WebSocket.OPEN);
  });
  it('bounds all failed providers and leaves the consumer available for another connection', async () => {
    const { first, backup, consumer } = await redundant(30);
    const firstFrames: unknown[] = [], backupFrames: unknown[] = [];
    first.client.on('message', raw => firstFrames.push(JSON.parse(String(raw))));
    backup.client.on('message', raw => backupFrames.push(JSON.parse(String(raw))));
    const closed = next(consumer.client);
    consumer.client.send(JSON.stringify({ type: 'open', streamId: 's', serviceId: 'C' }));
    expect((await closed).type).toBe('close');
    expect(firstFrames.filter((f: any) => f.type === 'open')).toHaveLength(1);
    expect(backupFrames.filter((f: any) => f.type === 'open')).toHaveLength(1);
    expect(consumer.client.readyState).toBe(WebSocket.OPEN);
  });
  it('allows a configured direct route and an external relay to coexist', async () => {
    const { router, a, phone } = await setup();
    const registered = once(a.server, 'message');
    a.client.send(JSON.stringify({ type: 'register', serviceIds: ['C'], ttlMs: 60000 })); await registered;
    const target = await pair();
    const closeDirect = router.registerDirect('C', async () => target.client); cleanups.push(closeDirect);
    const first = next(a.client), opened = next(phone.client);
    phone.client.send(JSON.stringify({ type: 'open', streamId: 's', serviceId: 'C' }));
    const attempt = await first;
    a.client.send(JSON.stringify({ type: 'close', streamId: attempt.streamId }));
    expect((await opened).type).toBe('opened');
    // Removing the unused advertisement cannot withdraw the direct provider.
    const withdrawn = once(a.server, 'message');
    a.client.send(JSON.stringify({ type: 'register', serviceIds: [], ttlMs: 60000 })); await withdrawn;
    expect(router.hasRoute('C')).toBe(true);
  });
  it('cancels pending target connections without letting a late factory replace a reused stream', async () => {
    const upstream = await pair(), late = await pair(), current = await pair();
    let finishLate!: (target: WebSocket) => void;
    const connect = vi.fn().mockImplementationOnce(() => new Promise<WebSocket>(resolve => { finishLate = resolve; }))
      .mockResolvedValueOnce(current.client);
    const registered = next(upstream.server);
    const relay = new RelayClient(upstream.client, { targets: new Map([['C', connect]]) });
    cleanups.push(() => relay.close()); await registered;
    upstream.server.send(JSON.stringify({ type: 'open', streamId: 'reused', serviceId: 'C' }));
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    const canceled = next(upstream.server);
    upstream.server.send(JSON.stringify({ type: 'close', streamId: 'reused' })); await canceled;
    const opened = next(upstream.server);
    upstream.server.send(JSON.stringify({ type: 'open', streamId: 'reused', serviceId: 'C' }));
    expect((await opened).type).toBe('opened');
    const lateClosed = once(late.server, 'close'); finishLate(late.client); await lateClosed;
    const data = once(current.server, 'message');
    upstream.server.send(JSON.stringify({ type: 'data', streamId: 'reused', payload: 'current ciphertext' }));
    expect(String((await data)[0])).toBe('current ciphertext');
  });
  it('gives recently failed providers lower priority for subsequent connections', async () => {
    const { first, backup, consumer } = await redundant();
    const open = next(first.client), alternate = next(backup.client);
    consumer.client.send(JSON.stringify({ type: 'open', streamId: 's', serviceId: 'C' }));
    first.client.send(JSON.stringify({ type: 'close', streamId: (await open).streamId }));
    const frame = await alternate; const opened = next(consumer.client);
    backup.client.send(JSON.stringify({ type: 'opened', streamId: frame.streamId })); await opened;
    const second = next(backup.client);
    consumer.client.send(JSON.stringify({ type: 'open', streamId: 'second', serviceId: 'C' }));
    expect((await second).type).toBe('open');
  });
  it('does not allow a consumer to advertise a target', async () => {
    const { phone } = await setup();
    const closed = once(phone.client, 'close');
    phone.client.send(JSON.stringify({ type: 'register', serviceIds: ['C'], ttlMs: 1000 }));
    expect((await closed)[0]).toBe(1008);
  });
});
