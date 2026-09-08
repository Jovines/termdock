import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayRouter } from './relay.js';
import { attachRegisteredDirectTargets } from './directRoutes.js';
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
async function phone(router: RelayRouter<string>) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(wss, 'listening');
  cleanups.push(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
  const connection = once(wss, 'connection'); const address = wss.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`); cleanups.push(() => ws.terminate()); await once(ws, 'open');
  await router.attach((await connection)[0], 'phone'); return ws;
}
function router() {
  const router = new RelayRouter<string>({ authenticate: value => value === 'phone' ? 'phone' : null, allowRegister: () => false, allowRoute: (subject, serviceId) => subject === 'phone' && serviceId === 'C' });
  cleanups.push(() => router.close()); return router;
}
const next = async (ws: WebSocket) => JSON.parse(String((await once(ws, 'message'))[0]));
describe('registered direct targets', () => {
  it('connects phone → B → C over verified WSS without an A process and tears down streams', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'td-direct-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'ca.pem'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
    const target = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'ca.pem')) });
    const wss = new WebSocketServer({ server: target, path: '/api/federation/secure' });
    target.listen(0, '127.0.0.1'); await once(target, 'listening');
    cleanups.push(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); target.close(); });
    const address = target.address(); if (!address || typeof address === 'string') throw new Error('No address');
    const untrusted = router(); cleanups.push(attachRegisteredDirectTargets(untrusted, [{ serviceId: 'C', url: `https://127.0.0.1:${address.port}` }]));
    const rejectedPhone = await phone(untrusted); const rejected = next(rejectedPhone);
    rejectedPhone.send(JSON.stringify({ type: 'open', streamId: 'untrusted', serviceId: 'C' }));
    expect((await rejected).reason).toBe('Channel closed');
    const b = router(); const cleanup = attachRegisteredDirectTargets(b, [{ serviceId: 'C', url: `https://127.0.0.1:${address.port}`, caPath: 'ca.pem' }], dir); cleanups.push(cleanup);
    expect(b.hasRoute('C')).toBe(true); expect(b.hasRoute('unknown')).toBe(false);
    const client = await phone(b); const cConnected = once(wss, 'connection');
    const opened = next(client); client.send(JSON.stringify({ type: 'open', streamId: 's1', serviceId: 'C' })); expect((await opened).type).toBe('opened');
    const c = (await cConnected)[0] as WebSocket; const cData = once(c, 'message');
    client.send(JSON.stringify({ type: 'data', streamId: 's1', payload: 'opaque-ciphertext' })); expect(String((await cData)[0])).toBe('opaque-ciphertext');
    const returned = next(client); c.send('encrypted-output'); expect((await returned).payload).toBe('encrypted-output');
    const unknown = once(client, 'close'); client.send(JSON.stringify({ type: 'open', streamId: 's2', serviceId: 'https://evil.example' }));
    // URL-shaped destinations are rejected as invalid protocol IDs and close the consumer.
    expect((await unknown)[0]).toBe(1008);
  });
  it('withdraws direct registrations and closes active destination sockets', async () => {
    const b = router(); const target = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(target, 'listening');
    cleanups.push(() => { for (const ws of target.clients) ws.terminate(); target.close(); });
    const address = target.address(); if (!address || typeof address === 'string') throw new Error('No address');
    const closeDirect = b.registerDirect('C', async () => { const ws = new WebSocket(`ws://127.0.0.1:${address.port}`); await once(ws, 'open'); return ws; });
    const client = await phone(b); const cConnected = once(target, 'connection'); const opened = next(client);
    client.send(JSON.stringify({ type: 'open', streamId: 's1', serviceId: 'C' })); await opened; const c = (await cConnected)[0] as WebSocket;
    const closedClient = next(client); const closedTarget = once(c, 'close'); closeDirect();
    expect((await closedClient).type).toBe('close'); await closedTarget; expect(b.hasRoute('C')).toBe(false);
  });
  it('rejects unregistered destinations and unsafe administrator URLs', async () => {
    const b = router(); const client = await phone(b); const denied = next(client);
    client.send(JSON.stringify({ type: 'open', streamId: 's1', serviceId: 'unknown' })); expect((await denied).type).toBe('close');
    for (const url of ['http://example.com', 'ws://example.com', 'https://user:password@example.com', 'https://example.com/arbitrary', 'https://example.com/?url=evil']) expect(() => attachRegisteredDirectTargets(b, [{ serviceId: 'C', url }])).toThrow();
    expect(b.hasRoute('C')).toBe(false);
  });
});
