import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createFederationRuntime } from './runtime.js';
import { createIdentity } from './secureProtocol.js';
import { RelayRouter } from './relay.js';
import { DirectTargetRegistry } from './directTargetRegistry.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
async function fixture(delayAcceptance = false) {
  const dir = mkdtempSync(join(tmpdir(), 'td-registry-proof-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  const runtime = await createFederationRuntime(express(), join(dir, 'b'), { terminal() {}, control() {} });
  cleanups.push(() => runtime.close());
  const server = createServer({ cert: readFileSync(join(dir, 'cert.pem')), key: readFileSync(join(dir, 'key.pem')) });
  const wss = new WebSocketServer({ server });
  wss.on('connection', ws => { if (!delayAcceptance) void runtime.accept(ws); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(); });
  const url = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  const router = new RelayRouter({ authenticate: () => 'phone', allowRegister: () => true, allowRoute: () => true });
  cleanups.push(() => router.close());
  let now = Date.now();
  const registry = new DirectTargetRegistry(router, dir, () => now); cleanups.push(() => registry.close());
  return { registry, router, wss, runtime, dir, advance(ms: number) { now += ms; }, target: { serviceId: runtime.serviceId, url, caPath: 'cert.pem' } };
}

it('keeps independently verified addresses of one service available when another address changes identity or is removed', async () => {
  const f = await fixture();
  const server = createServer({ cert: readFileSync(join(f.dir, 'cert.pem')), key: readFileSync(join(f.dir, 'key.pem')) });
  const wss = new WebSocketServer({ server }); wss.on('connection', ws => { void f.runtime.accept(ws); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(); });
  const alternate = { ...f.target, url: `https://127.0.0.1:${(server.address() as { port: number }).port}` };
  f.registry.refresh([f.target, alternate]);
  await vi.waitFor(() => expect(f.router.providerCount(f.target.serviceId)).toBe(2));
  // Wait for both independent proofs rather than assuming a registration means both are ready.
  f.registry.refresh([alternate]);
  await vi.waitFor(() => expect(f.registry.describe(alternate)).toMatchObject({ url: alternate.url, available: true }));
  f.registry.refresh([f.target, alternate]);
  const other = await createFederationRuntime(express(), join(f.dir, 'other'), { terminal() {}, control() {} });
  cleanups.push(() => other.close());
  f.wss.removeAllListeners('connection'); f.wss.on('connection', ws => { void other.accept(ws); });
  f.advance(30_001); f.registry.refresh([f.target, alternate]);
  await vi.waitFor(() => expect(f.registry.describe(f.target)).toMatchObject({ url: alternate.url, available: true }));
  f.registry.refresh([alternate]);
  expect(f.router.hasRoute(f.target.serviceId)).toBe(true);
  f.registry.refresh([]); expect(f.router.hasRoute(f.target.serviceId)).toBe(false);
});

it('bounds simultaneous identity probes and cancels both running and queued work on removal', async () => {
  const f = await fixture(true);
  const ids = await Promise.all(Array.from({ length: 7 }, () => createIdentity()));
  f.registry.refresh(ids.map(identity => ({ ...f.target, serviceId: identity.peerId })));
  await vi.waitFor(() => expect(f.wss.clients.size).toBe(4));
  expect(f.router.activeRouteIds()).toEqual([]);
  f.registry.refresh([]);
  await vi.waitFor(() => expect(f.wss.clients.size).toBe(0));
  expect(f.router.activeRouteIds()).toEqual([]);
});

it('rejects an A ID paired with the B URL and advertises it only after the identity is corrected', async () => {
  const f = await fixture();
  const a = await createIdentity();
  const wrong = { ...f.target, serviceId: a.peerId };
  f.registry.refresh([wrong]);
  expect(f.registry.error(a.peerId)).toBe('TARGET_CHECKING');
  expect(f.router.hasRoute(a.peerId)).toBe(false);
  await vi.waitFor(() => expect(f.registry.error(a.peerId)).toBe('TARGET_IDENTITY_MISMATCH'));
  expect(f.router.hasRoute(a.peerId)).toBe(false);
  const metadata = { serviceId: a.peerId, url: f.target.url, label: 'B entry' };
  expect(f.registry.describe(metadata)).toEqual({ serviceId: a.peerId, available: false, error: 'TARGET_IDENTITY_MISMATCH' });
  // An independent provider must remain usable without borrowing the bad URL/name.
  const closeIndependent = f.router.registerDirect(a.peerId, async () => { throw new Error('Not dialed in this directory test'); });
  expect(f.registry.describe(metadata)).toEqual({ serviceId: a.peerId, available: true });
  closeIndependent();
  f.registry.refresh([f.target]);
  await vi.waitFor(() => expect(f.router.hasRoute(f.target.serviceId)).toBe(true));
  expect(f.registry.error(f.target.serviceId)).toBeUndefined();
  expect(f.router.hasRoute(a.peerId)).toBe(false);
  // An address change invalidates old proof immediately.
  f.registry.refresh([{ ...f.target, url: 'https://127.0.0.1:1' }]);
  expect(f.router.hasRoute(f.target.serviceId)).toBe(false);
  await vi.waitFor(() => expect(f.registry.error(f.target.serviceId)).toBe('TARGET_UNREACHABLE'));
  f.registry.refresh([f.target]);
  await vi.waitFor(() => expect(f.router.hasRoute(f.target.serviceId)).toBe(true));
  f.registry.refresh([]);
  expect(f.router.hasRoute(f.target.serviceId)).toBe(false);
});

it('withdraws previously verified providers when the address changes identity and recovers only after fresh proof', async () => {
  const f = await fixture();
  f.registry.refresh([f.target]);
  await vi.waitFor(() => expect(f.router.hasRoute(f.target.serviceId)).toBe(true));
  const other = await createFederationRuntime(express(), join(f.dir, 'other'), { terminal() {}, control() {} });
  cleanups.push(() => other.close());
  f.wss.removeAllListeners('connection'); f.wss.on('connection', ws => { void other.accept(ws); });
  f.advance(30_001); f.registry.refresh([f.target]);
  await vi.waitFor(() => expect(f.registry.error(f.target.serviceId)).toBe('TARGET_IDENTITY_MISMATCH'));
  expect(f.router.hasRoute(f.target.serviceId)).toBe(false);
  f.wss.removeAllListeners('connection'); f.wss.on('connection', ws => { void f.runtime.accept(ws); });
  f.advance(5001); f.registry.refresh([f.target]);
  await vi.waitFor(() => expect(f.router.hasRoute(f.target.serviceId)).toBe(true));
});

it.each(['remove', 'shutdown'] as const)('never registers a late successful probe after %s', async action => {
  const f = await fixture(true);
  const opened = once(f.wss, 'connection');
  f.registry.refresh([f.target]);
  const [socket] = await opened;
  if (action === 'remove') f.registry.refresh([]); else f.registry.close();
  void f.runtime.accept(socket);
  await vi.waitFor(() => expect(f.wss.clients.size).toBe(0));
  expect(f.router.hasRoute(f.target.serviceId)).toBe(false);
});
