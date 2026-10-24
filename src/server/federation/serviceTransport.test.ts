import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:https';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { openServiceSocket, createServiceSocket, serviceTlsOptions } from './serviceTransport.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
async function fixture(mode: 'ready' | 'invalid' | 'hold' = 'ready') {
  const dir = mkdtempSync(join(tmpdir(), 'td-service-transport-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  const ca = readFileSync(join(dir, 'cert.pem'));
  const server = createServer({ cert: ca, key: readFileSync(join(dir, 'key.pem')) });
  const sockets = new Set<Duplex>();
  server.on('upgrade', (request, socket) => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => socket.destroy());
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const header = Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const data = Buffer.from(JSON.stringify({ type: mode === 'invalid' ? 'wrong-handshake' : 'ready' }));
    // One TLS write forces the ready frame into the upgrade response's head.
    socket.write(mode === 'hold' ? header : Buffer.concat([header, Buffer.from([0x81, data.length]), data]));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return { ca, server, url: `wss://127.0.0.1:${(server.address() as { port: number }).port}/api/federation/relay`, sockets };
}
it('receives entry ready coalesced with the WebSocket upgrade, for CLI and reverse-relay providers', async () => {
  const f = await fixture();
  const socket = await openServiceSocket(f.url, { ca: f.ca }, { relayReady: true });
  expect(socket.readyState).toBe(1); socket.terminate();
});
it('rejects a malformed first entry frame and cleans up a cancelled ready wait', async () => {
  const bad = await fixture('invalid');
  await expect(openServiceSocket(bad.url, { ca: bad.ca }, { relayReady: true })).rejects.toThrow('handshake failed');
  const held = await fixture('hold'), controller = new AbortController();
  const upgraded = once(held.server, 'upgrade');
  const pending = openServiceSocket(held.url, { ca: held.ca }, { relayReady: true, signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow();
  await upgraded; controller.abort(); await rejected;
});
it('rejects ambiguous TLS trust and endpoints before contacting the service', async () => {
  await expect(serviceTlsOptions('https://b.example', { ca: Buffer.from('unused'), caFingerprint256: '00'.repeat(32) })).rejects.toThrow('Conflicting');
  for (const url of ['ws://b.example/api/federation/relay', 'wss://user:secret@b.example/api/federation/relay', 'wss://b.example/arbitrary', 'wss://b.example/api/federation/relay?routeToken=x&selfRelayToken=y', 'wss://b.example/api/federation/relay-target?routeToken=x']) {
    await expect(createServiceSocket(url)).rejects.toThrow();
  }
});
