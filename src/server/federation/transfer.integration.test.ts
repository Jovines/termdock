import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { connect } from '../../lib/federation/secureClient.js';
import { RelaySocket } from '../../lib/federation/relaySocket.js';
import { createFederationRuntime } from './runtime.js';
import { createIdentity } from './secureProtocol.js';
import { RelayRouter, RelayClient } from './relay.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); vi.unstubAllGlobals(); });

/** Independent per-frame propagation delay, not a serial delay per send. The
 * underlying connection, TLS and Noise are real; this is not a bandwidth model. */
function delayed(socket: WebSocket, oneWayMs: number): globalThis.WebSocket {
  let queued = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (run: () => void) => {
    const timer = setTimeout(() => { timers.delete(timer); if (socket.readyState === WebSocket.OPEN) run(); }, oneWayMs);
    timers.add(timer);
  };
  socket.once('close', () => { timers.forEach(clearTimeout); timers.clear(); queued = 0; });
  return new Proxy(socket, {
    get(target, key) {
      if (key === 'bufferedAmount') return target.bufferedAmount + queued;
      if (key === 'send') return (bytes: Uint8Array | string) => {
        const size = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength;
        queued += size; later(() => { queued -= size; target.send(bytes); });
      };
      if (key === 'addEventListener') return (type: string, listener: (event: unknown) => void) => {
        target.addEventListener(type as 'message', type === 'message' ? event => later(() => listener(event)) : listener);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as globalThis.WebSocket;
}

it.each(['direct', 'relay'] as const)('pipelines uploads/downloads over real WSS + Noise (%s), preserving input and cancellation', async route => {
  vi.stubGlobal('CloseEvent', class extends Event { code: number; reason: string; constructor(type: string, init: { code: number; reason: string }) { super(type); this.code = init.code; this.reason = init.reason; } });
  const dir = mkdtempSync(join(tmpdir(), 'td-network-transfer-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  const ca = readFileSync(join(dir, 'cert.pem')), key = readFileSync(join(dir, 'key.pem'));
  const bytes = randomBytes(1024 * 1024);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const app = express();
  app.post('/api/terminal/fs/upload', async (req, res) => {
    const hash = createHash('sha256');
    try { for await (const chunk of req) hash.update(chunk); res.json({ digest: hash.digest('hex') }); }
    catch { /* Cancellation intentionally destroys the private HTTP stream. */ }
  });
  app.get('/api/terminal/fs/download', (_req, res) => res.end(bytes));
  const replay = '\u001b[32m构建完成\u001b[0m\r\n'.repeat(4000);
  const runtime = await createFederationRuntime(app, dir, {
    terminal(socket) {
      socket.send(JSON.stringify({ type: 'data', data: replay }));
      socket.on('message', data => socket.send(String(data)));
    }, control() {},
  });
  cleanups.push(() => runtime.close());
  const identity = await createIdentity();
  runtime.store.grant({ subjectId: identity.peerId, scope: { kind: 'service' }, actions: ['service:*'] });
  async function endpoint(onConnect: (ws: WebSocket, path: string) => void) {
    const https = createServer({ cert: ca, key });
    const wss = new WebSocketServer({ server: https, perMessageDeflate: false });
    wss.on('connection', (ws, req) => onConnect(ws, req.url!));
    https.listen(0, '127.0.0.1'); await once(https, 'listening');
    cleanups.push(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); https.close(); });
    return `wss://127.0.0.1:${(https.address() as { port: number }).port}`;
  }
  const targetSockets = new Set<WebSocket>();
  const target = await endpoint(ws => { targetSockets.add(ws); ws.once('close', () => targetSockets.delete(ws)); void runtime.accept(ws); });
  const dial = (url: string) => { const ws = new WebSocket(url, { ca, perMessageDeflate: false }); cleanups.push(() => ws.terminate()); return ws; };
  let socketFactory = (url: string) => delayed(dial(url), 30);
  let url = target;
  if (route === 'relay') {
    const router = new RelayRouter({ authenticate: context => context as string, allowRegister: p => p === 'provider', allowRoute: p => p === 'phone' });
    cleanups.push(() => router.close());
    url = await endpoint((ws, path) => { void router.attach(ws, path === '/provider' ? 'provider' : 'phone').then(ok => { if (ok) ws.send(JSON.stringify({ type: 'ready' })); }); });
    const provider = dial(url + '/provider');
    // Consume the entry handshake before RelayClient starts reading route frames.
    await once(provider, 'message');
    const relay = new RelayClient(provider, { targets: new Map([[runtime.serviceId, async () => { const ws = dial(target); await once(ws, 'open'); return ws; }]]) });
    cleanups.push(() => relay.close());
    const registered = once(provider, 'pong'); provider.ping(); await registered;
    socketFactory = address => new RelaySocket(address, runtime.serviceId, value => delayed(dial(value), 30)) as unknown as globalThis.WebSocket;
  }
  const client = await connect({ url, targetPeerId: runtime.serviceId, identity, socketFactory });
  cleanups.push(() => client.close());
  const times: Record<string, number> = {};
  for (const window of [1, 8]) {
    if (window === 8) expect(await client.request({ type: 'permissions' })).toMatchObject({ httpWindow: 8 });
    let start = performance.now();
    const response = await client.fetch('/api/terminal/fs/upload', { method: 'POST', body: bytes });
    expect((await response.json()).digest).toBe(digest);
    times[`upload${window}`] = performance.now() - start;
    start = performance.now();
    const download = await client.fetch('/api/terminal/fs/download');
    expect(createHash('sha256').update(new Uint8Array(await download.arrayBuffer())).digest('hex')).toBe(digest);
    times[`download${window}`] = performance.now() - start;
  }
  console.info(`${route}, 1 MiB, 60ms injected RTT, real TLS/Noise, milliseconds: ${JSON.stringify(times)}`);
  expect(times.upload8).toBeLessThan(times.upload1 * 0.65);
  expect(times.download8).toBeLessThan(times.download1 * 0.65);
  const terminal = client.openSocket('/api/terminal/one/ws');
  const output: string[] = [];
  terminal.onmessage = event => output.push(JSON.parse(String(event.data)).data);
  await vi.waitFor(() => expect(output).toEqual([replay]));
  const download = await client.fetch('/api/terminal/fs/download');
  const reader = download.body!.getReader(); await reader.read();
  terminal.send(JSON.stringify({ type: 'input', data: 'echo responsiveness' }));
  await vi.waitFor(() => expect(output.at(-1)).toBe('echo responsiveness'));
  await reader.cancel();
  expect(await client.request({ type: 'permissions' })).toMatchObject({ fullService: true });
  const abort = new AbortController();
  const upload = client.fetch('/api/terminal/fs/upload', { method: 'POST', body: bytes, signal: abort.signal });
  const rejection = expect(upload).rejects.toThrow(); abort.abort(); await rejection;
  expect(client.closed).toBe(false); terminal.close();
  const interrupted = await client.fetch('/api/terminal/fs/download');
  const failedDownload = expect(interrupted.arrayBuffer()).rejects.toThrow();
  for (const socket of targetSockets) socket.terminate();
  await failedDownload;
  expect(client.closed).toBe(true);
  await expect(client.fetch('/api/terminal/fs/download')).rejects.toThrow();
  const replacement = await connect({ url, targetPeerId: runtime.serviceId, identity, socketFactory });
  cleanups.push(() => replacement.close());
  expect(await replacement.request({ type: 'permissions' })).toMatchObject({ fullService: true, binaryChunks: true });
}, 30_000);
