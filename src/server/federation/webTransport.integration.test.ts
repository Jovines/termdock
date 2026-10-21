import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { createIdentity } from './secureProtocol.js';
import { createFederationRuntime } from './runtime.js';
import { startWebTransportServer } from './webTransportServer.js';
import { transportCertificate } from './webTransportCertificate.js';
import { connect } from '../../lib/federation/secureClient.js';
import type { WebTransportFactory } from '../../lib/federation/webTransportClient.js';
import { connectWebTransport } from '../../lib/federation/webTransportClient.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.unstubAllGlobals(); });
async function fixture() {
  vi.stubGlobal('CloseEvent', class extends Event { code: number; reason: string; constructor(type: string, init: { code: number; reason: string }) { super(type); this.code = init.code; this.reason = init.reason; } });
  const directory = mkdtempSync(join(tmpdir(), 'td-quic-test-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const certificate = await transportCertificate(directory);
  const app = express(); const payload = randomBytes(2 * 1024 * 1024);
  const digest = createHash('sha256').update(payload).digest('hex');
  const writes = vi.fn();
  app.post('/api/terminal/fs/upload', async (req, res) => {
    writes(); const hash = createHash('sha256');
    try { for await (const bytes of req) hash.update(bytes); res.json({ digest: hash.digest('hex') }); }
    catch { /* Explicit cancellation aborts this body. */ }
  });
  app.get('/api/terminal/fs/download', (_req, res) => res.end(payload));
  let quic: Awaited<ReturnType<typeof startWebTransportServer>>;
  const runtime = await createFederationRuntime(app, directory, {
    terminal(socket) { socket.send(JSON.stringify({ type: 'data', data: 'terminal-ready' })); socket.on('message', bytes => socket.send(String(bytes))); }, control() {},
  }, { webTransport: () => quic?.descriptor() }); cleanup.push(() => runtime.close());
  const https = createServer({ cert: certificate.cert, key: certificate.key });
  const wss = new WebSocketServer({ server: https, perMessageDeflate: false });
  let wsMessages = 0;
  wss.on('connection', ws => { ws.on('message', () => wsMessages++); void runtime.accept(ws); });
  https.listen(0, '127.0.0.1'); await once(https, 'listening');
  cleanup.push(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); https.close(); });
  const url = `wss://127.0.0.1:${(https.address() as { port: number }).port}/api/federation/secure`;
  quic = await startWebTransportServer({ directory, host: '127.0.0.1', port: 0, hostAllowed: () => true,
    originAllowed: () => true, openAccessAllowed: () => false, accept: (duplex, context) => runtime.acceptDuplex(duplex, context) });
  cleanup.push(() => quic.close());
  const identity = await createIdentity(); runtime.store.grant({ subjectId: identity.peerId, scope: { kind: 'service' }, actions: ['service:*'] });
  const moduleName: string = '@fails-components/webtransport'; const native = await import(moduleName);
  const factory: WebTransportFactory = (address, options) => new native.WebTransport(address, {
    ...options, requireUnreliable: true,
    // The Node addon currently requires Buffer despite the browser API taking
    // ArrayBuffer; keep that native-test compatibility outside production code.
    serverCertificateHashes: options.serverCertificateHashes.map(hash => ({ ...hash, value: Buffer.from(hash.value) })),
  });
  const dial = async (webTransportFactory = factory) => {
    const client = await connect({ url, identity, targetPeerId: runtime.serviceId, webTransportFactory,
      socketFactory: address => new WebSocket(address, { ca: certificate.cert }) as unknown as globalThis.WebSocket });
    cleanup.push(() => client.close());
    await client.request({ type: 'permissions' }); return client;
  };
  return { dial, factory, quic, runtime, identity, url, certificate, directory, payload, digest, writes, wss, wsMessages: () => wsMessages };
}

it('uses independent real QUIC + Noise streams for terminal, upload and download, surviving loss of the bootstrap TCP link', async () => {
  const f = await fixture(), client = await f.dial();
  await vi.waitFor(() => expect(client.transport, client.webTransportFailure).toBe('webtransport'), { timeout: 8000 });
  const tcpBefore = f.wsMessages();
  const terminal = client.openSocket('/api/terminal/one/ws'); const output: string[] = [];
  terminal.onmessage = event => output.push(JSON.parse(String(event.data)).data);
  await vi.waitFor(() => expect(output).toEqual(['terminal-ready']));
  expect(terminal.getConnectionDiagnostics?.()?.transport).toBe('webtransport');
  const download = await client.fetch('/api/terminal/fs/download');
  expect(f.quic.stats().streams).toBeGreaterThanOrEqual(3);
  terminal.send(JSON.stringify({ type: 'input', data: 'input-during-paused-download' }));
  await vi.waitFor(() => expect(output.at(-1)).toBe('input-during-paused-download'));
  const progress: number[] = [];
  const uploaded = await client.fetch('/api/terminal/fs/upload', { method: 'POST', body: f.payload, onUploadProgress: bytes => progress.push(bytes) });
  expect((await uploaded.json()).digest).toBe(f.digest); expect(progress.at(-1)).toBe(f.payload.byteLength); expect(f.writes).toHaveBeenCalledOnce();
  expect(createHash('sha256').update(new Uint8Array(await download.arrayBuffer())).digest('hex')).toBe(f.digest);
  expect(f.wsMessages()).toBe(tcpBefore);
  const cancelled = await client.fetch('/api/terminal/fs/download'); await cancelled.body!.cancel();
  for (const ws of f.wss.clients) ws.terminate();
  await vi.waitFor(() => expect(f.wss.clients.size).toBe(0));
  expect((await client.request({ type: 'permissions' })).fullService).toBe(true);
  expect(client.closed).toBe(false);
  terminal.send(JSON.stringify({ type: 'input', data: 'input-after-tcp-closed' }));
  await vi.waitFor(() => expect(output.at(-1)).toBe('input-after-tcp-closed'));
  f.quic.close(); await vi.waitFor(() => expect(client.closed).toBe(true));
  const fallback = await f.dial();
  expect(fallback.transport).toBe('websocket');
  expect(createHash('sha256').update(new Uint8Array(await (await fallback.fetch('/api/terminal/fs/download')).arrayBuffer())).digest('hex')).toBe(f.digest);
}, 20_000);

it('keeps encrypted WebSocket usable when the UDP transport cannot connect and never resubmits a write', async () => {
  const f = await fixture(); let closed!: () => void;
  const factory: WebTransportFactory = () => ({ ready: Promise.reject(new Error('UDP blocked')),
    closed: new Promise<void>(resolve => { closed = resolve; }), close: () => closed(),
    createBidirectionalStream: () => Promise.reject(new Error('UDP blocked')) });
  const client = await f.dial(factory);
  const response = await client.fetch('/api/terminal/fs/upload', { method: 'POST', body: f.payload });
  expect((await response.json()).digest).toBe(f.digest);
  expect(f.writes).toHaveBeenCalledOnce(); expect(client.transport).toBe('websocket'); expect(client.closed).toBe(false);
  expect(statSync(join(f.directory, 'quic-certificate.json')).mode & 0o777).toBe(0o600);
}, 10_000);

it('reuses authenticated HTTP streams across sequential requests while retaining independent concurrent bodies', async () => {
  const f = await fixture(), client = await f.dial();
  await vi.waitFor(() => expect(client.transport, client.webTransportFailure).toBe('webtransport'), { timeout: 8000 });
  for (let index = 0; index < 4; index++) {
    const response = await client.fetch('/api/terminal/fs/upload', { method: 'POST', body: f.payload });
    expect((await response.json()).digest).toBe(f.digest);
  }
  // One persistent permission stream and one reused HTTP Noise stream.
  await vi.waitFor(() => expect(f.quic.stats().streams).toBe(2));
  const paused = await client.fetch('/api/terminal/fs/download');
  const concurrent = await client.fetch('/api/terminal/fs/upload', { method: 'POST', body: f.payload });
  expect((await concurrent.json()).digest).toBe(f.digest);
  expect(f.quic.stats().streams).toBe(3);
  await paused.body!.cancel();
  expect(f.writes).toHaveBeenCalledTimes(5);
}, 15_000);

it('fails an already dispatched QUIC write instead of replaying it over WebSocket', async () => {
  const f = await fixture(), client = await f.dial();
  await vi.waitFor(() => expect(client.transport).toBe('webtransport'), { timeout: 8000 });
  f.writes.mockImplementationOnce(() => f.quic.close());
  await expect(client.fetch('/api/terminal/fs/upload', { method: 'POST', body: f.payload }).then(response => response.json())).rejects.toThrow();
  expect(f.writes).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(client.transport).toBe('websocket'));
  expect((await client.request({ type: 'permissions' })).fullService).toBe(true);
}, 15_000);

it('still rejects a different Noise identity even when the QUIC certificate hash is trusted', async () => {
  const f = await fixture(), wrongTarget = await createIdentity();
  const pool = await connectWebTransport({ baseUrl: f.url, descriptor: f.quic.descriptor()!,
    identity: f.identity, targetPeerId: wrongTarget.peerId, factory: f.factory });
  cleanup.push(() => pool.close());
  await expect(pool.open('http')).rejects.toMatchObject({ name: 'UnexpectedPeerError' });
  expect(f.writes).not.toHaveBeenCalled();
}, 10_000);

it.each([false, true])('can resume a download after the internal HTTP keepalive expires (QUIC=%s)', async quic => {
  const f = await fixture();
  const client = await f.dial(quic ? f.factory : () => { throw new Error('UDP unavailable'); });
  if (quic) await vi.waitFor(() => expect(client.transport).toBe('webtransport'), { timeout: 8000 });
  const response = await client.fetch('/api/terminal/fs/download');
  await new Promise(resolve => setTimeout(resolve, 7000));
  expect(createHash('sha256').update(new Uint8Array(await response.arrayBuffer())).digest('hex')).toBe(f.digest);
}, 15_000);
