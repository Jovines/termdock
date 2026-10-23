import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { pinnedServerTlsOptions } from './trustedCa.js';
import { attachRegisteredDirectTargets } from './directRoutes.js';
import { RelayRouter } from './relay.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

async function fixture(san = 'IP:127.0.0.1,DNS:localhost', days = '1') {
  const dir = mkdtempSync(join(tmpdir(), 'td-preview-leaf-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', 'ca-key.pem', '-out', 'ca.pem', '-subj', '/CN=Private CA');
  writeFileSync(join(dir, 'extensions'), `subjectAltName=${san}\nbasicConstraints=CA:FALSE\n`);
  const issue = (name: string) => {
    openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '-key.pem', '-out', name + '.csr', '-subj', '/CN=localhost');
    openssl('x509', '-req', '-in', name + '.csr', '-CA', 'ca.pem', '-CAkey', 'ca-key.pem', '-CAcreateserial', '-days', days, '-extfile', 'extensions', '-out', name + '.pem');
    const cert = readFileSync(join(dir, name + '.pem')), key = readFileSync(join(dir, name + '-key.pem'));
    return { cert, key, pin: new X509Certificate(cert).fingerprint256.replaceAll(':', '') };
  };
  const first = issue('first'), second = issue('second');
  const requests: string[] = [];
  const server = createServer(first, (req, res) => { requests.push(req.url!); res.writeHead(404).end(); });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (_ws, req) => requests.push(req.url!));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(); });
  const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dial = async (options: Awaited<ReturnType<typeof pinnedServerTlsOptions>>) => {
    const ws = new WebSocket(origin.replace('https:', 'wss:') + '/api/federation/secure', { ...options, rejectUnauthorized: true });
    cleanup.push(() => ws.terminate());
    await once(ws, 'open'); return ws;
  };
  return { dir, first, second, server, origin, requests, dial };
}

it('uses a Preview-approved CA-issued leaf without fetching or trusting the CA', async () => {
  const f = await fixture();
  expect(new X509Certificate(f.first.cert).ca).toBe(false);
  const tls = await pinnedServerTlsOptions(f.origin, f.first.pin.toLowerCase());
  expect(f.requests).toEqual([]); // TLS inspection sends no HTTP or business data.
  await f.dial(tls);
  expect(f.requests).toEqual(['/api/federation/secure']);
  const router = new RelayRouter({ authenticate: () => 'phone', allowRoute: () => true, allowRegister: () => false });
  cleanup.push(() => router.close());
  cleanup.push(attachRegisteredDirectTargets(router, [{ serviceId: 'target', url: f.origin, certificateFingerprint256: f.first.pin }]));
  expect(router.hasRoute('target')).toBe(true);
  // A different certificate signed by the same CA must fail, even with cached TLS options.
  f.server.setSecureContext(f.second);
  await expect(f.dial(tls)).rejects.toThrow();
  await expect(pinnedServerTlsOptions(f.origin, f.second.pin).then(f.dial)).resolves.toBeDefined();
  expect(f.requests).toEqual(['/api/federation/secure', '/api/federation/secure']);
});

it('rejects wrong pins and wrong hostnames before sending HTTP, with no unpinned retry', async () => {
  const f = await fixture();
  await expect(pinnedServerTlsOptions(f.origin, '00'.repeat(32))).rejects.toThrow('no longer matches');
  await expect(pinnedServerTlsOptions(f.origin, 'invalid')).rejects.toThrow('Invalid pinned');
  await expect(pinnedServerTlsOptions(f.origin.replace('https:', 'http:'), f.first.pin)).rejects.toThrow();
  const router = new RelayRouter({ authenticate: () => 'phone', allowRoute: () => true, allowRegister: () => false });
  cleanup.push(() => router.close());
  expect(() => attachRegisteredDirectTargets(router, [{ serviceId: 'target', url: f.origin, certificateFingerprint256: f.first.pin, caPath: 'ca.pem' }], f.dir)).toThrow();
  const tls = await pinnedServerTlsOptions(f.origin, f.first.pin);
  expect(tls.checkServerIdentity!('wrong.example', new X509Certificate(f.first.cert).toLegacyObject())).toBeInstanceOf(Error);
  expect(f.requests).toEqual([]);
});

it.each(['hostname', 'expired'] as const)('rejects a pinned certificate with an invalid %s before HTTP', async reason => {
  const f = await fixture(reason === 'hostname' ? 'DNS:wrong.example' : undefined, reason === 'expired' ? '0' : '1');
  await expect(pinnedServerTlsOptions(f.origin, f.first.pin)).rejects.toThrow();
  expect(f.requests).toEqual([]);
});
