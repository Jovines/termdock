import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ connect: vi.fn(), relay: vi.fn(), saved: vi.fn(), save: vi.fn(), boot: 'B' }));
vi.mock('./secureClient', () => ({ connect: mocks.connect, SecureSocket: class {} }));
vi.mock('./relaySocket', () => ({ createRelaySocketFactory: mocks.relay }));
vi.mock('./workerBridge', () => ({ installWorkerBridge: vi.fn() }));
vi.mock('./clientScope', () => ({ get BOOT_SERVICE_ID() { return mocks.boot; }, TARGET_KEY: 'target', ENTRY_KEY: 'entry', selectedTarget: mocks.saved, saveSelectedTarget: mocks.save, migrateLegacyServiceState: vi.fn() }));
vi.mock('../../server/federation/secureProtocol', () => ({ importIdentity: () => ({ peerId: 'phone' }), createIdentity: vi.fn(), exportIdentity: vi.fn() }));
vi.mock('../../server/federation/passwordBootstrap', () => ({
  startPasswordBootstrap: vi.fn(async () => ({ startLoginRequest: 'opaque-request', clientLoginState: 'private', passwordKey: 'private' })),
  finishPasswordBootstrap: vi.fn(async () => ({ attemptId: 'attempt', finishLoginRequest: 'proof', serverIdentity: 'B' })),
}));
function storage() { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }; }
let local: ReturnType<typeof storage>;
let reload: ReturnType<typeof vi.fn>;
let nativeFetch: ReturnType<typeof vi.fn>;
let clients: Map<string, { targetPeerId: string; closed: boolean; request: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mocks.boot = 'B'; mocks.saved.mockReturnValue(null);
  local = storage(); reload = vi.fn(); clients = new Map();
  vi.stubGlobal('localStorage', local); vi.stubGlobal('sessionStorage', storage());
  vi.stubGlobal('location', { origin: 'https://b.example', host: 'b.example', hostname: 'b.example', href: 'https://b.example/', reload });
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  nativeFetch = vi.fn(async () => Response.json({ saltHex: 'salt' })); vi.stubGlobal('fetch', nativeFetch);
  vi.stubGlobal('indexedDB', { open() {
    const request: Record<string, unknown> = {};
    queueMicrotask(() => { request.result = { close() {}, transaction() { return { objectStore() { return { get() {
      const read: Record<string, unknown> = {}; queueMicrotask(() => { read.result = 'stored-device-key'; (read.onsuccess as () => void)(); }); return read;
    } }; } }; } }; (request.onsuccess as () => void)(); }); return request;
  } });
  mocks.relay.mockImplementation(() => function relaySocket() {});
  mocks.connect.mockImplementation(async ({ targetPeerId }: { targetPeerId: string }) => {
    const client = { targetPeerId, canSwitchTransport: true, closed: false, request: vi.fn(async (packet: { type: string }) => packet.type === 'permissions' ? { type: 'result', fullService: true, grants: [{ actions: ['service:*'] }] } : { routeToken: 'B-ticket', serviceId: 'C' }), close: vi.fn() };
    clients.set(targetPeerId, client); return client;
  });
});
afterEach(() => vi.unstubAllGlobals());
describe('browser federation entry routing', () => {
  it('prefers direct C and never treats the currently connected B as an authorized backup', async () => {
    const integration = await import('./browserIntegration');
    await integration.connectDevice({ url: 'https://b.example', targetPeerId: 'B' });
    void integration.connectDevice({ url: 'https://c.internal', targetPeerId: 'C', pairingCode: 'invite-C' });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(mocks.connect.mock.calls[1][0]).toMatchObject({ url: 'wss://c.internal/api/federation/secure', targetPeerId: 'C' });
    expect(mocks.relay).not.toHaveBeenCalled();
    expect(clients.get('B')!.request.mock.calls.some(([packet]) => packet.type === 'route-ticket')).toBe(false);
  });
  it('falls back only to an explicitly saved B and returns to direct C when the network recovers', async () => {
    mocks.boot = 'C';
    const selected = { url: 'https://c.internal', targetPeerId: 'C', serviceOrigin: 'https://c.internal', routes: [{ url: 'https://b.example', targetPeerId: 'B' }] };
    mocks.saved.mockReturnValue(selected);
    const dial = mocks.connect.getMockImplementation()!;
    mocks.connect.mockRejectedValueOnce(new TypeError('offline'));
    const integration = await import('./browserIntegration'); await integration.getActiveClient();
    expect(mocks.connect.mock.calls.map(([args]) => [args.targetPeerId, args.url])).toEqual([
      ['C', 'wss://c.internal/api/federation/secure'], ['B', 'wss://b.example/api/federation/secure'], ['C', 'wss://b.example/api/federation/relay?routeToken=B-ticket'],
    ]);
    const old = integration.currentSecureClient()!;
    expect(integration.currentEntryClient()?.targetPeerId).toBe('B');
    mocks.connect.mockImplementation(dial);
    await integration.preferDirectConnection();
    expect(integration.currentEntryClient()).toBeUndefined();
    expect(integration.currentSecureClient()).not.toBe(old);
    expect(old.close).toHaveBeenCalledOnce(); expect(reload).not.toHaveBeenCalled();
  });
  it('does not relay after C explicitly reports revoked device access', async () => {
    mocks.boot = 'C';
    const dial = mocks.connect.getMockImplementation()!;
    mocks.connect.mockImplementation(async args => { const client = await dial(args); client.request.mockResolvedValue({ type: 'result', fullService: false, grants: [] }); return client; });
    const integration = await import('./browserIntegration');
    await expect(integration.connectDevice({ url: 'https://c.internal', targetPeerId: 'C', routes: [{ url: 'https://b.example', targetPeerId: 'B' }] })).rejects.toThrow();
    expect(mocks.connect).toHaveBeenCalledOnce(); expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.relay).not.toHaveBeenCalled();
  });
  it('preserves a working service when an unrelated service cannot connect', async () => {
    const integration = await import('./browserIntegration');
    const old = await integration.connectDevice({ url: 'https://b.example', targetPeerId: 'B' });
    mocks.connect.mockRejectedValueOnce(new TypeError('offline'));
    await expect(integration.connectDevice({ url: 'https://c.internal', targetPeerId: 'C' })).rejects.toThrow('offline');
    expect(integration.currentSecureClient()).toBe(old); expect(old.close).not.toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalledOnce();
  });
  it('keeps a first password login on the direct B transport without requesting a relay ticket', async () => {
    const integration = await import('./browserIntegration'); integration.installEncryptedFetch();
    const response = await window.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'existing-password' }) });
    expect(response.ok).toBe(true);
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.connect.mock.calls[0][0]).toMatchObject({ url: 'wss://b.example/api/federation/secure', targetPeerId: 'B' });
    expect(clients.get('B')!.request.mock.calls.every(([packet]) => packet.type === 'permissions')).toBe(true); expect(mocks.relay).not.toHaveBeenCalled();
    expect(nativeFetch.mock.calls.map(call => call[0])).toEqual(['/api/auth/password/parameters', '/api/auth/password/start', '/api/auth/password/finish']);
    expect(JSON.stringify(nativeFetch.mock.calls)).not.toContain('existing-password');
  });
});
