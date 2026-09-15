import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createFederationRuntime } from '../federation/runtime.js';
import { createIdentity } from '../federation/secureProtocol.js';
import { RelayRouter } from '../federation/relay.js';
import { attachRegisteredDirectTargets } from '../federation/directRoutes.js';
import { CollaborationPeerTransport, connectCollaborationRpc, remoteSession, type CollaborationNode } from './collaborationPeerTransport.js';
import { CollaborationStore } from './collaborationStore.js';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'td-peer-wire-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'ca.pem'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  const ca = readFileSync(join(dir, 'ca.pem')), key = readFileSync(join(dir, 'key.pem'));
  const source = await createIdentity();
  const store = new CollaborationStore(join(dir, 'messages.json'));
  let transport: CollaborationPeerTransport;
  const runtime = await createFederationRuntime(express(), join(dir, 'runtime'), { terminal() {}, control() {} }, {
    collaborationExchange: (subject, packet) => transport.receive(subject, packet),
  });
  cleanups.push(() => runtime.close());
  const server = createServer({ cert: ca, key }, (req, res) => {
    if (req.url === '/onboarding/ca.crt') res.end(ca); else res.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ server, path: '/api/federation/secure' });
  sockets.on('connection', socket => void runtime.accept(socket));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(() => { for (const socket of sockets.clients) socket.terminate(); sockets.close(); server.close(); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('address');
  const target: CollaborationNode = { serviceId: runtime.serviceId, origin: `https://127.0.0.1:${address.port}`, caFingerprint256: new X509Certificate(ca).fingerprint256 };
  const sender = { serviceId: source.peerId, origin: 'https://source.test' };
  store.mergeFederatedGroup({ id: 'cross-wire', name: 'Wire', federated: true, createdAt: 1, updatedAt: 1,
    sessionIds: ['target', remoteSession(sender.origin, 'sender')], remoteSessions: [{ sessionId: remoteSession(sender.origin, 'sender'),
      serviceOrigin: sender.origin, serviceLabel: 'Source', name: 'Sender', cwd: '', status: '', capability: '', currentTask: '', updatedAt: 1, backendSessionId: null, agentNativeSessionId: null, agent: null }] });
  let deliveries = 0;
  transport = new CollaborationPeerTransport({ file: join(dir, 'peers.json'), serviceId: runtime.serviceId, store,
    connect: async () => { throw new Error('not needed'); }, deliver: id => {
      for (const m of store.inbox(id).filter(m => m.status === 'pending')) { deliveries++; store.markDelivered([m.id]); store.setSnapshot(m.id, '正文完整'); }
    } });
  cleanups.push(() => transport.close()); transport.configure('cross-wire', target.origin, [sender, target]);
  const restart = () => {
    transport.close();
    transport = new CollaborationPeerTransport({ file: join(dir, 'peers.json'), serviceId: runtime.serviceId, store,
      connect: async () => { throw new Error('not needed'); }, deliver: id => {
        for (const m of store.inbox(id).filter(m => m.status === 'pending')) { deliveries++; store.markDelivered([m.id]); }
      } });
    cleanups.push(() => transport.close());
  };
  const message = { id: 'wire-message', groupId: 'cross-wire', fromSessionId: 'sender', toSessionId: remoteSession(target.origin, 'target'),
    kind: 'message', threadId: 'wire-thread', replyTo: null, status: 'pending', createdAt: Date.now(), deliveredAt: null, readAt: null,
    content: '中文任务正文\n'.repeat(16000) };
  return { dir, ca, key, target, source, runtime, store, transport, message, restart, deliveries: () => deliveries };
}
it('uses real verified WSS and Noise without a page, rejects unregistered identities and reconnects without duplicate injection', async () => {
  const f = await fixture();
  await expect(connectCollaborationRpc(f.source, { ...f.target, caFingerprint256: Array(32).fill('00').join(':') })).rejects.toThrow();
  const stranger = await connectCollaborationRpc(await createIdentity(), f.target); cleanups.push(() => stranger.close());
  await expect(stranger.request({ type: 'collaboration-exchange', groupId: 'cross-wire', ids: [] })).rejects.toThrow('NOT_AUTHORIZED');
  const client = await connectCollaborationRpc(f.source, f.target); cleanups.push(() => client.close());
  const request = { type: 'collaboration-exchange', groupId: 'cross-wire', message: f.message, ids: [f.message.id] };
  const start = performance.now();
  expect(await client.request(request)).toMatchObject({ receipts: [{ id: f.message.id, status: 'delivered', snapshot: '正文完整' }] });
  const roundTripMs = performance.now() - start;
  console.info(JSON.stringify({ measurement: 'verified WSS + Noise, in-process recipient delivery', bodyBytes: Buffer.byteLength(f.message.content), roundTripMs: Math.round(roundTripMs) }));
  expect(roundTripMs).toBeLessThan(2000);
  expect(f.store.getMessage(f.message.id)?.content).toBe(f.message.content);
  client.close(); f.restart();
  const reconnected = await connectCollaborationRpc(f.source, f.target); cleanups.push(() => reconnected.close());
  await reconnected.request(request); expect(f.deliveries()).toBe(1);
  f.store.markRead([f.message.id]);
  expect(await reconnected.request({ type: 'collaboration-exchange', groupId: 'cross-wire', ids: [f.message.id] })).toMatchObject({ receipts: [{ status: 'read' }] });
  // A collaboration binding must never turn into full service access.
  expect(await reconnected.request({ type: 'permissions' })).toMatchObject({ fullService: false, grants: [] });
  f.store.getGroup('cross-wire')!.deleted = true;
  await expect(reconnected.request(request)).rejects.toThrow('NOT_AUTHORIZED');
}, 15000);
it('carries the same encrypted RPC through an entry relay with the final service identity pinned', async () => {
  const f = await fixture();
  const router = new RelayRouter<string>({ authenticate: () => 'source', allowRegister: () => false, allowRoute: (_, target) => target === f.target.serviceId });
  cleanups.push(() => router.close());
  cleanups.push(attachRegisteredDirectTargets(router, [{ serviceId: f.target.serviceId, url: f.target.origin, caPath: join(f.dir, 'ca.pem') }]));
  const entry = createServer({ cert: f.ca, key: f.key }, (req, res) => { if (req.url === '/onboarding/ca.crt') res.end(f.ca); else res.writeHead(404).end(); });
  const wss = new WebSocketServer({ server: entry });
  wss.on('connection', socket => { void router.attach(socket, 'source').then(ok => { if (ok) socket.send(JSON.stringify({ type: 'ready' })); }); });
  entry.listen(0, '127.0.0.1'); await once(entry, 'listening');
  cleanups.push(() => { for (const socket of wss.clients) socket.terminate(); wss.close(); entry.close(); });
  const address = entry.address(); if (!address || typeof address === 'string') throw new Error('address');
  const origin = `https://127.0.0.1:${address.port}`;
  const client = await connectCollaborationRpc(f.source, { ...f.target, origin }, `${origin.replace('https:', 'wss:')}/api/federation/relay`);
  cleanups.push(() => client.close());
  expect(await client.request({ type: 'collaboration-exchange', groupId: 'cross-wire', message: f.message, ids: [f.message.id] })).toMatchObject({ receipts: [{ status: 'delivered' }] });
  expect(f.deliveries()).toBe(1);
}, 15000);
