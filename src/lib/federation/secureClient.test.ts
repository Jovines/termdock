import { describe, expect, it, vi } from 'vitest';
import { SecureClient } from './secureClient.js';
import { AsyncQueue, PacketChannel, toBase64, type Packet } from '../../server/federation/packets.js';
import type { Identity } from '../../server/federation/secureProtocol.js';
function harness(handle: (packet: Packet, reply: (packet: Packet) => void) => void) {
  const a = new AsyncQueue<Uint8Array>(), b = new AsyncQueue<Uint8Array>();
  const clientWire = new PacketChannel({ source: a, async sink(source) { for await (const bytes of source) b.push(bytes); }, close() { a.end(); b.end(); } });
  const server = new PacketChannel({ source: b, async sink(source) { for await (const bytes of source) a.push(bytes); }, close() { a.end(); b.end(); } });
  const received: Packet[] = [];
  void (async () => { for await (const packet of server.read()) { received.push(packet); handle(packet, p => server.send(p)); } })().catch(() => {});
  return { client: new SecureClient(clientWire, { peerId: 'device' } as Identity, 'service'), received };
}
describe('SecureClient packet operations', () => {
  it('prepares renewal five minutes before expiry and defers while requests are pending', async () => {
    const now = Date.now();
    const { client } = harness(() => {});
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(now + 54 * 60_000);
      expect(client.renewalDue).toBe(false);
      clock.mockReturnValue(now + 55 * 60_000 + 10);
      expect(client.renewalDue).toBe(true);
      expect(client.canSwitchTransport).toBe(true);
      const pending = client.request({ type: 'permissions' });
      const rejected = expect(pending).rejects.toThrow('done');
      expect(client.canSwitchTransport).toBe(false);
      client.close(new Error('done'));
      await rejected;
      expect(client.renewalDue).toBe(false);
    } finally { clock.mockRestore(); client.close(); }
  });

  it('retires logical sockets with a planned close instead of an error', async () => {
    vi.stubGlobal('CloseEvent', class extends Event {
      constructor(type: string, readonly init: CloseEventInit = {}) { super(type); }
      get code() { return this.init.code; } get reason() { return this.init.reason; }
    });
    const { client, received } = harness((packet, reply) => {
      if (packet.type === 'ws-open') reply({ id: packet.id, type: 'ws-ready' });
    });
    try {
      const socket = client.openSocket('/api/terminal/one/ws');
      await new Promise<void>(resolve => { socket.onopen = () => resolve(); });
      const error = vi.fn(), closed = vi.fn(); socket.onerror = error; socket.onclose = closed;
      expect(client.canSwitchTransport).toBe(true);
      socket.send(JSON.stringify({ type: 'input', data: 'once' }));
      expect(client.canSwitchTransport).toBe(false);
      await vi.waitFor(() => expect(received.filter(packet => packet.type === 'ws-data')).toHaveLength(1));
      const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 2001);
      try { expect(client.canSwitchTransport).toBe(true); } finally { clock.mockRestore(); }
      client.retire();
      expect(client.closed).toBe(true);
      expect(closed).toHaveBeenCalledOnce();
      expect(closed.mock.calls[0][0]).toMatchObject({ code: 1012, reason: 'Encrypted transport renewed' });
      expect(error).not.toHaveBeenCalled();
      expect(received.filter(packet => packet.type === 'ws-data')).toHaveLength(1);
    } finally { client.close(); vi.unstubAllGlobals(); }
  });

  it('queues a burst of status-only reads and releases both successful and rejected bodies', async () => {
    let active = 0, maximum = 0;
    const errors = new Set<string>();
    const { client } = harness((packet, reply) => {
      if (packet.type === 'http') { active++; maximum = Math.max(maximum, active); if (String(packet.path).includes('denied')) errors.add(packet.id); }
      if (packet.type === 'upload-end') {
        reply({ id: packet.id, type: 'head', status: errors.has(packet.id) ? 403 : 200, headers: {} });
        reply({ id: packet.id, type: 'chunk', data: toBase64(new TextEncoder().encode('{"ok":true}')) });
      }
      if (packet.type === 'ack') { active--; reply({ id: packet.id, type: 'end' }); }
    });
    try {
      // Call sites that only check .ok must not have to know about protocol credits.
      const statuses = await Promise.all(Array.from({ length: 160 }, (_, index) => client.fetch(index % 2 ? '/api/denied' : '/api/read').then(response => response.status)));
      expect(statuses.filter(status => status === 200)).toHaveLength(80);
      expect(statuses.filter(status => status === 403)).toHaveLength(80);
      expect(maximum).toBeLessThanOrEqual(8);
      expect(await (await client.fetch('/api/files')).json()).toEqual({ ok: true });
    } finally { client.close(); }
  });
  it('keeps large unread bodies bounded and cancels queued reads without dispatching them', async () => {
    const { client, received } = harness((packet, reply) => {
      if (packet.type === 'upload-end') {
        reply({ id: packet.id, type: 'head', status: 200, headers: {} });
        reply({ id: packet.id, type: 'chunk', data: toBase64(new Uint8Array(65536)) });
      }
      if (packet.type === 'permissions') reply({ id: packet.id, type: 'result' });
    });
    try {
      const bodies = await Promise.all(Array.from({ length: 8 }, () => client.fetch('/api/large')));
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(received.filter(packet => packet.type === 'ack')).toHaveLength(0);
      const cancel = new AbortController();
      const queued = client.fetch('/api/never-dispatch', { signal: cancel.signal });
      cancel.abort(new Error('navigation changed'));
      await expect(queued).rejects.toThrow('navigation changed');
      expect(received.some(packet => packet.path === '/api/never-dispatch')).toBe(false);
      expect((await client.request({ type: 'permissions' })).type).toBe('result');
      const next = client.fetch('/api/files');
      await bodies[0].body!.cancel();
      const response = await next;
      expect(response.ok).toBe(true);
      await response.body!.cancel();
      for (const body of bodies.slice(1)) await body.body!.cancel();
    } finally { client.close(); }
  });
  it('allows file reads while more than 32 terminal subscriptions remain open', async () => {
    vi.stubGlobal('CloseEvent', class extends Event {
      code: number; reason: string; wasClean: boolean;
      constructor(type: string, init: CloseEventInit = {}) { super(type); this.code = init.code ?? 0; this.reason = init.reason ?? ''; this.wasClean = init.wasClean ?? false; }
    });
    const { client, received } = harness((packet, reply) => {
      if (packet.type === 'ws-open') reply({ id: packet.id, type: 'ws-ready' });
      if (packet.type === 'upload-end') { reply({ id: packet.id, type: 'head', status: 204, headers: {} }); reply({ id: packet.id, type: 'end' }); }
    });
    try {
      const sockets = Array.from({ length: 48 }, (_, index) => client.openSocket(`/api/terminal/${index}/ws`));
      await Promise.all(sockets.map(socket => new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('socket failed')); })));
      expect((await client.fetch('/api/files')).status).toBe(204);
      expect(received.filter(packet => packet.type === 'ws-open')).toHaveLength(48);
      sockets.forEach(socket => socket.close());
    } finally { client.close(); vi.unstubAllGlobals(); }
  });
  it('uploads bounded pieces before dispatch and acknowledges response only as consumed', async () => {
    const { client, received } = harness((packet, reply) => {
      if (packet.type === 'upload') reply({ id: packet.id, type: 'upload-ack' });
      if (packet.type === 'upload-end') {
        reply({ id: packet.id, type: 'head', status: 200, headers: {} });
        reply({ id: packet.id, type: 'chunk', data: toBase64(new TextEncoder().encode('hello')) });
      }
      if (packet.type === 'ack') reply({ id: packet.id, type: 'end' });
    });
    try {
      const response = await client.fetch('/api/test', { method: 'POST', body: 'x'.repeat(100000) });
      expect(received.filter(p => p.type === 'upload')).toHaveLength(2);
      expect(received.some(p => p.type === 'ack')).toBe(false);
      expect(await response.text()).toBe('hello');
      expect(received.filter(p => p.type === 'ack')).toHaveLength(1);
    } finally { client.close(); }
  });
  it('propagates cancellation and rejects pending requests on transport close', async () => {
    let cancelled!: () => void;
    const cancellation = new Promise<void>(resolve => { cancelled = resolve; });
    const { client, received } = harness((packet, reply) => {
      if (packet.type === 'cancel') cancelled();
      if (packet.type === 'upload-end') reply({ id: packet.id, type: 'head', status: 200, headers: {} });
    });
    const response = await client.fetch('/api/test'); await response.body!.cancel(); await cancellation;
    const pending = client.request({ type: 'pending' });
    client.close(new Error('offline'));
    await expect(pending).rejects.toThrow('offline');
    expect(received.some(p => p.type === 'cancel')).toBe(true);
  });
  it('allows file bodies above the JSON limit with chunked upload acknowledgements', async () => {
    let count = 0;
    const { client } = harness((packet, reply) => {
      if (packet.type === 'upload') { count++; reply({ id: packet.id, type: 'upload-ack' }); }
      if (packet.type === 'upload-end') { reply({ id: packet.id, type: 'head', status: 204, headers: {} }); reply({ id: packet.id, type: 'end' }); }
    });
    const progress: number[] = [];
    try {
      const body = new Blob([new Uint8Array(6 * 1024 * 1024)]);
      expect((await client.fetch('/api/terminal/fs/upload?dir=%2Ftmp', { method: 'POST', body, onUploadProgress: bytes => progress.push(bytes) })).status).toBe(204);
      expect(count).toBe(96); expect(progress.at(-1)).toBe(body.size);
    } finally { client.close(); }
  });
  it('rejects arbitrary-origin requests', async () => {
    const { client } = harness(() => {});
    try { await expect(client.fetch('https://elsewhere.invalid/api/test')).rejects.toThrow('current-service'); }
    finally { client.close(); }
  });
});
