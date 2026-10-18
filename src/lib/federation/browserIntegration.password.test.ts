import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { scryptSync } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { createIdentity, secureConnection } from '../../server/federation/secureProtocol';
import { PacketChannel } from '../../server/federation/packets';
import { socketDuplex } from '../../server/federation/socketDuplex';

const state = vi.hoisted(() => ({ target: null as null | { url: string; targetPeerId: string }, identity: vi.fn(), save: vi.fn() }));
vi.mock('./deviceIdentity', () => ({ getIdentity: state.identity }));
vi.mock('./clientScope', () => ({
  get BOOT_SERVICE_ID() { return state.target?.targetPeerId; }, ENTRY_KEY: 'entry',
  selectedTarget: () => state.target, saveSelectedTarget: state.save, clearSelectedTarget: vi.fn(), migrateLegacyServiceState: vi.fn(),
}));
vi.mock('../services/serviceDirectory', () => ({
  listServiceConnections: async () => [], normalizeServiceAddress: (url: string) => url,
  rememberServiceConnection: vi.fn(), saveServiceConnection: vi.fn(),
  observeServiceConnections: vi.fn(),
}));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); vi.unstubAllGlobals(); });

it('distinguishes real OPAQUE rejection, encrypted disconnect, pin mismatch and rate limit, then recovers with the same password', async () => {
  vi.resetModules(); state.save.mockClear();
  const { PasswordBootstrapServer } = await import('../../server/federation/passwordBootstrap');
  const device = await createIdentity(), service = await createIdentity(), replacement = await createIdentity();
  state.identity.mockResolvedValue(device);
  const saltHex = '12'.repeat(16);
  const verifier = `scrypt$${saltHex}$${scryptSync('known-password', Buffer.from(saltHex, 'hex'), 64, { N: 32768, r: 8, p: 1, maxmem: 67108864 }).toString('hex')}`;
  const bootstrap = new PasswordBootstrapServer({ getPasswordHash: () => verifier, serverIdentity: service.peerId });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  cleanups.push(() => { for (const socket of server.clients) socket.terminate(); server.close(); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No listener');
  const origin = `http://127.0.0.1:${address.port}`;
  state.target = { url: origin, targetPeerId: service.peerId };
  vi.stubGlobal('WebSocket', WebSocket);
  vi.stubGlobal('navigator', { onLine: true, serviceWorker: Object.assign(new EventTarget(), { controller: null }) });
  vi.stubGlobal('location', { origin, host: new URL(origin).host, hostname: '127.0.0.1', href: `${origin}/`, reload: vi.fn() });
  const oldUpload = vi.fn();
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location, crypto: globalThis.crypto, electronAPI: { uploadClipboardImage: oldUpload, uploadDroppedFiles: oldUpload } }));
  const nativeFetch = vi.fn(() => { throw new Error('Plaintext business request forbidden'); });
  vi.stubGlobal('fetch', nativeFetch);
  let mode: 'normal' | 'disconnect' | 'rate' | 'mismatch' = 'normal';
  let granted = false;
  const wire: Uint8Array[] = [];
  server.on('connection', socket => {
    socket.on('message', bytes => wire.push(new Uint8Array(bytes as ArrayBuffer).slice()));
    void (async () => {
      const secure = await secureConnection({ identity: mode === 'mismatch' ? replacement : service, initiator: false, duplex: socketDuplex(socket) });
      const channel = new PacketChannel(secure.duplex);
      for await (const packet of channel.read()) {
        if (packet.type === 'password-parameters') {
          if (mode === 'disconnect') { socket.terminate(); continue; }
          channel.send({ id: packet.id, type: 'result', ...bootstrap.parameters() });
        }
        if (packet.type === 'password-start') {
          if (mode === 'rate') { channel.send({ id: packet.id, type: 'error', error: 'LOGIN_RATE_LIMIT' }); continue; }
          const started = await bootstrap.start({ startLoginRequest: String(packet.startLoginRequest), clientIdentity: secure.authenticatedPeerId, origin: String(packet.origin) });
          channel.send({ id: packet.id, type: 'result', ...started });
        }
        if (packet.type === 'password-finish') {
          await bootstrap.finish({ attemptId: String(packet.attemptId), finishLoginRequest: String(packet.finishLoginRequest) });
          granted = true; channel.send({ id: packet.id, type: 'result', ok: true });
        }
        if (packet.type === 'permissions') channel.send({ id: packet.id, type: 'result', fullService: granted, grants: granted ? [{ actions: ['service:*'] }] : [] });
      }
    })().catch(() => socket.close());
  });
  const integration = await import('./browserIntegration');
  cleanups.push(() => integration.invalidateSecureTransport());
  integration.installEncryptedFetch(); vi.stubGlobal('fetch', window.fetch);
  const { loginWithPassword } = await import('../terminal/api');
  expect(await loginWithPassword('wrong-password')).toMatchObject({ ok: false, reason: 'invalidPassword' });
  expect(granted).toBe(false); expect(state.save).not.toHaveBeenCalled();
  mode = 'disconnect';
  expect(await loginWithPassword('known-password')).toMatchObject({ ok: false, reason: 'connectionFailed' });
  mode = 'mismatch';
  expect(await loginWithPassword('known-password')).toMatchObject({ ok: false, reason: 'identityMismatch' });
  mode = 'rate';
  expect(await loginWithPassword('known-password')).toMatchObject({ ok: false, reason: 'rateLimited', rateLimited: true });
  expect(granted).toBe(false); expect(state.save).not.toHaveBeenCalled();
  mode = 'normal';
  expect(await loginWithPassword('known-password')).toEqual({ ok: true });
  expect(granted).toBe(true); expect(state.save).toHaveBeenCalledOnce();
  expect(state.target.targetPeerId).toBe(service.peerId);
  expect(nativeFetch).not.toHaveBeenCalled(); expect(oldUpload).not.toHaveBeenCalled();
  expect(location.reload).not.toHaveBeenCalled();
  expect(wire.every(bytes => !new TextDecoder().decode(bytes).includes('known-password') && !new TextDecoder().decode(bytes).includes('wrong-password'))).toBe(true);
}, 20_000);

it.each([
  ['browser', false, undefined],
  ['legacy desktop', false, 'https://ignored-preview.test'],
  ['Preview', true, 'https://service.test'],
] as const)('keeps real OPAQUE binding for %s before any authenticated transport is opened', async (_name, preview, supplied) => {
  vi.resetModules(); state.target = null; state.save.mockClear();
  const { PasswordBootstrapServer } = await import('../../server/federation/passwordBootstrap');
  const device = await createIdentity(), service = await createIdentity(); state.identity.mockResolvedValue(device);
  const saltHex = '12'.repeat(16);
  const verifier = `scrypt$${saltHex}$${scryptSync('known-password', Buffer.from(saltHex, 'hex'), 64, { N: 32768, r: 8, p: 1, maxmem: 67108864 }).toString('hex')}`;
  const server = new PasswordBootstrapServer({ getPasswordHash: () => verifier, serverIdentity: service.peerId });
  const pageOrigin = 'http://127.0.0.1:43000';
  vi.stubGlobal('location', { origin: pageOrigin, href: pageOrigin + '/', host: '127.0.0.1:43000', pathname: '/' });
  const binding = vi.fn(() => supplied);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { termdockDesktop: supplied ? { ...(preview ? { previewCapabilities: {} } : {}), passwordBootstrapOrigin: binding } : undefined }));
  vi.stubGlobal('navigator', { onLine: true });
  let proved = false;
  const transport = vi.fn(async (raw, init) => {
    const url = new URL(raw, pageOrigin);
    if (url.pathname.endsWith('/parameters')) return Response.json(server.parameters());
    if (url.pathname.endsWith('/start')) {
      const body = JSON.parse(init.body);
      return Response.json(await server.start({ ...body, origin: preview ? supplied! : pageOrigin }));
    }
    if (url.pathname.endsWith('/finish')) {
      const verified = await server.finish(JSON.parse(init.body));
      expect(verified.clientIdentity).toBe(device.peerId); expect(verified.serverIdentity).toBe(service.peerId);
      proved = true;
      // End this scoped binding check before opening a service. The real old
      // router + subsequent Noise integration lives in preview_password.rs.
      return Response.json({ error: 'Fixture stopped after proof' }, { status: 503 });
    }
    throw new Error('Unexpected ordinary request');
  });
  vi.stubGlobal('fetch', transport);
  const integration = await import('./browserIntegration');
  await expect(integration.connectServiceAddress('https://service.test', 'known-password')).rejects.toThrow();
  expect(proved).toBe(true);
  expect(binding).toHaveBeenCalledTimes(preview ? 1 : 0);
  expect(state.save).not.toHaveBeenCalled();
});

it.each(['https://attacker.test', 'file:///tmp', 'https://service.test/', 'https://user:pass@service.test', 'https://service.test/?secret=x'])('rejects a forged Preview bootstrap binding %s before sending a password proof', async origin => {
  vi.resetModules(); state.target = null;
  vi.stubGlobal('location', { origin: 'http://127.0.0.1:43000' });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { termdockDesktop: { previewCapabilities: {}, passwordBootstrapOrigin: () => origin } }));
  const transport = vi.fn(); vi.stubGlobal('fetch', transport);
  const integration = await import('./browserIntegration');
  await expect(integration.connectServiceAddress('https://service.test', 'known-password')).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});
