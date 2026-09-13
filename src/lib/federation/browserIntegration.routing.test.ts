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
  it.each(['direct', 'relay'] as const)('renews an aging %s channel only after its replacement is verified', async mode => {
    const dial = mocks.connect.getMockImplementation()!;
    if (mode === 'relay') mocks.connect.mockImplementation(async args => {
      if (args.targetPeerId === 'B' && !args.socketFactory) throw new Error('direct unavailable');
      return dial(args);
    });
    const integration = await import('./browserIntegration');
    const target = { url: 'https://b.example', targetPeerId: 'B', routes: mode === 'relay' ? [{ url: 'https://a.example', targetPeerId: 'A' }] : [] };
    mocks.saved.mockReturnValue(target);
    const old = await integration.connectDevice(target);
    const retire = vi.fn(() => {
      expect(integration.currentSecureClient()).not.toBe(old);
      expect(integration.currentConnectionPath()).toBe(mode);
      expect(clients.get('B')!.request).toHaveBeenCalledWith({ type: 'permissions' }, undefined);
    });
    Object.assign(old, { renewalDue: false, retire });
    const count = mocks.connect.mock.calls.length;
    await integration.renewSecureTransport();
    expect(mocks.connect).toHaveBeenCalledTimes(count);
    Object.assign(old, { renewalDue: true });
    const saves = mocks.save.mock.calls.length;
    Object.assign(old, { canSwitchTransport: false });
    await integration.renewSecureTransport();
    expect(mocks.connect).toHaveBeenCalledTimes(count);
    Object.assign(old, { canSwitchTransport: true });
    expect(await integration.getActiveClient()).toBe(old);
    await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());
    expect(mocks.save).toHaveBeenCalledTimes(saves);
    expect(old.close).not.toHaveBeenCalled();
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it.each(['request', 'failure', 'selection', 'concurrent'] as const)('keeps the current channel safe during renewal: %s', async scenario => {
    const integration = await import('./browserIntegration');
    const target = { url: 'https://b.example', targetPeerId: 'B' };
    mocks.saved.mockReturnValue(target);
    const old = await integration.connectDevice(target);
    const retire = vi.fn();
    Object.assign(old, { renewalDue: true, retire });
    const dial = mocks.connect.getMockImplementation()!;
    let candidate: Awaited<ReturnType<typeof dial>>;
    let release!: () => void;
    const pause = new Promise<void>(resolve => { release = resolve; });
    mocks.connect.mockImplementationOnce(async args => {
      if (scenario === 'failure') throw new Error('replacement offline');
      candidate = await dial(args);
      await pause;
      return candidate;
    });
    const renewing = integration.renewSecureTransport();
    if (scenario !== 'failure') {
      await vi.waitFor(() => expect(candidate).toBeDefined());
      expect(old.close).not.toHaveBeenCalled(); expect(retire).not.toHaveBeenCalled();
      if (scenario === 'request') Object.assign(old, { canSwitchTransport: false });
      if (scenario === 'selection') mocks.saved.mockReturnValue({ ...target, targetPeerId: 'C' });
      if (scenario === 'concurrent') {
        const count = mocks.connect.mock.calls.length;
        await integration.renewSecureTransport();
        expect(mocks.connect).toHaveBeenCalledTimes(count);
      }
      release();
    }
    await renewing;
    if (scenario === 'concurrent') expect(retire).toHaveBeenCalledOnce();
    else {
      expect(integration.currentSecureClient()).toBe(old);
      expect(retire).not.toHaveBeenCalled(); expect(old.close).not.toHaveBeenCalled();
      if (candidate!) expect(candidate.close).toHaveBeenCalled();
    }
    if (scenario === 'failure') {
      const count = mocks.connect.mock.calls.length;
      await integration.renewSecureTransport();
      expect(mocks.connect).toHaveBeenCalledTimes(count);
    }
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it.each(['direct', 'relay'] as const)('keeps collaboration reads and local writes on the encrypted %s target with an old preload', async (mode) => {
    const base = mocks.connect.getMockImplementation()!;
    if (mode === 'relay') mocks.connect.mockImplementation(async args => {
      if (args.targetPeerId === 'B' && !args.socketFactory) throw new TypeError('direct target unavailable');
      return base(args);
    });
    const integration = await import('./browserIntegration');
    const target = { url: 'https://b.example', targetPeerId: 'B', serviceOrigin: 'https://b.example',
      ...(mode === 'relay' ? { routes: [{ url: 'https://a.example', targetPeerId: 'A' }] } : {}) };
    mocks.saved.mockReturnValue(target);
    const client = await integration.connectDevice(target);
    const local = { groups: [], sessions: ['one', 'two'].map(sessionId => ({ sessionId, name: sessionId, cwd: '/repo', agent: null,
      backendSessionId: null, status: 'shell', capability: '', currentTask: '', updatedAt: 1 })) };
    const business = vi.fn(async (_path: string, init?: RequestInit) => Response.json(init?.method === 'POST'
      ? { group: { ...JSON.parse(String(init.body)), id: 'created', createdAt: 1, updatedAt: 1 } } : local));
    Object.assign(client, { fetch: business });
    const nativeSave = vi.fn().mockRejectedValue(new Error('legacy upload must not run'));
    Object.assign(window, { location, addEventListener: vi.fn(), removeEventListener: vi.fn(), termdockDesktop: { collaborationList: () => Promise.reject(new Error('old preload unavailable')), collaborationSave: nativeSave } });
    integration.installEncryptedFetch();
    const api = await import('../terminal/api');
    vi.stubGlobal('fetch', window.fetch);
    try {
      expect(await api.listCollaborationGroups()).toMatchObject(local);
      await api.saveCollaborationGroup({ name: 'Local', sessionIds: ['one', 'two'] });
      expect(business).toHaveBeenCalledWith('/api/terminal/operations/collaboration-groups', expect.objectContaining({ method: 'POST' }));
      business.mockRejectedValueOnce(new Error('encrypted connection lost'));
      await expect(api.listCollaborationGroups()).rejects.toThrow('encrypted connection lost');
      expect(integration.currentConnectionPath()).toBe(mode);
      expect(nativeFetch).not.toHaveBeenCalled();
      expect(nativeSave).not.toHaveBeenCalled();
    } finally { api.resetCollaborationDirectory(); }
  });

  it('discovers a pinned entry through its alternate address without switching the active service', async () => {
    const base = mocks.connect.getMockImplementation()!;
    mocks.connect.mockRejectedValueOnce(new Error('old network'));
    mocks.connect.mockImplementation(async args => {
      const client = await base(args);
      client.request.mockResolvedValue({ items: [{ serviceId: 'C', url: 'https://c.internal', available: true, authorized: true }], canManage: false });
      return client;
    });
    const integration = await import('./browserIntegration');
    const result = await integration.listRelayTargets({ id: 'B', targetPeerId: 'B', url: 'https://home.internal', label: 'B', routes: [{ url: 'https://office.internal', targetPeerId: 'B' }] });
    expect(result.route).toEqual({ url: 'https://office.internal', targetPeerId: 'B' });
    expect(result.items).toHaveLength(1);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(integration.currentSecureClient()).toBeUndefined();
    expect(clients.get('B')!.close).toHaveBeenCalled();
  });
  it('revalidates target visibility before granting only the current device, without prematurely saving C', async () => {
    const base = mocks.connect.getMockImplementation()!;
    mocks.connect.mockImplementation(async args => {
      const client = await base(args);
      client.request.mockImplementation(async (packet: { type: string }) => packet.type === 'route-targets' ? { canManage: true, items: [{ serviceId: 'C', url: 'https://c.internal', available: true, authorized: false }] } : {});
      return client;
    });
    const integration = await import('./browserIntegration');
    const intent = await integration.prepareRelayConnection({ url: 'https://b.example', targetPeerId: 'B' }, 'C');
    expect(intent).toMatchObject({ targetPeerId: 'C', serviceOrigin: 'https://c.internal', routes: [{ url: 'https://b.example', targetPeerId: 'B' }] });
    expect(clients.get('B')!.request).toHaveBeenCalledWith({ type: 'route-grant', subjectId: 'phone', serviceId: 'C' });
    expect(local.getItem('termdock.federation.connections.v1')).toBeNull();
    await expect(integration.prepareRelayConnection({ url: 'https://b.example', targetPeerId: 'B' }, 'hidden')).rejects.toThrow('不可见');
    expect(clients.get('B')!.request.mock.calls.some(([packet]) => packet.type === 'route-grant')).toBe(false);
  });
  it('logs in to a first-time target entirely through its entry when direct access is impossible', async () => {
    const base = mocks.connect.getMockImplementation()!;
    mocks.connect.mockImplementation(async args => {
      if (args.targetPeerId === 'B' && !args.socketFactory) throw new TypeError('target is unreachable from this browser');
      return base(args);
    });
    const integration = await import('./browserIntegration');
    await integration.authenticateKnownConnection({ url: 'https://b.example', targetPeerId: 'B', routes: [{ url: 'https://a.example', targetPeerId: 'A' }] }, 'target-password');
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ targetPeerId: 'B', routes: [{ url: 'https://a.example', targetPeerId: 'A' }] }));
    expect(integration.currentConnectionPath()).toBe('relay');
    expect(mocks.connect.mock.calls.filter(([args]) => args.targetPeerId === 'B' && args.socketFactory).length).toBe(2);
  });
  it('tries another address of the same pinned computer before a relay and preserves both routes', async () => {
    mocks.boot = 'C';
    const routes = [{ url: 'https://company.internal:9834', targetPeerId: 'C' }, { url: 'https://b.example', targetPeerId: 'B' }];
    mocks.connect.mockRejectedValueOnce(new TypeError('home network unavailable'));
    const integration = await import('./browserIntegration');
    await integration.connectDevice({ url: 'https://home.internal:9834', targetPeerId: 'C', routes });
    expect(mocks.connect.mock.calls.map(([args]) => [args.targetPeerId, args.url])).toEqual([
      ['C', 'wss://home.internal:9834/api/federation/secure'], ['C', 'wss://company.internal:9834/api/federation/secure'],
    ]);
    expect(mocks.relay).not.toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ routes }));
    expect(integration.currentConnectionPath()).toBe('direct');
  });
  it('verifies a manually entered address against the existing identity and restores the offline PWA', async () => {
    mocks.boot = 'C';
    const service = { id: 'C', url: 'https://home.internal:9834', targetPeerId: 'C', label: 'My computer' };
    mocks.saved.mockReturnValue(service);
    const integration = await import('./browserIntegration');
    const routes = await integration.addServiceAddress(service, ' company.internal:9834 ');
    expect(mocks.connect).toHaveBeenCalledWith(expect.objectContaining({ targetPeerId: 'C', url: 'wss://company.internal:9834/api/federation/secure' }));
    expect(routes).toEqual([{ url: 'https://company.internal:9834', targetPeerId: 'C' }]);
    expect(integration.currentSecureClient()).toBe(clients.get('C'));
    expect(clients.get('C')!.close).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: integration.SECURE_STATE_EVENT }));
    expect(nativeFetch).not.toHaveBeenCalled();
  });
  it('does not save an address whose handshake fails the pinned service check', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('Unexpected remote peer'));
    const integration = await import('./browserIntegration');
    await expect(integration.addServiceAddress({ id: 'C', url: 'https://home.internal', targetPeerId: 'C', label: 'Computer' }, 'https://wrong.internal')).rejects.toThrow('同一台 Termdock');
    expect(local.getItem('termdock.federation.connections.v1')).toBeNull();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(integration.currentSecureClient()).toBeUndefined();
  });
  it('rejects duplicates and non-HTTPS LAN addresses before connecting', async () => {
    const integration = await import('./browserIntegration');
    const service = { id: 'C', url: 'https://home.internal:9834', targetPeerId: 'C', label: 'Computer' };
    await expect(integration.addServiceAddress(service, 'home.internal:9834/')).rejects.toThrow('已经');
    await expect(integration.addServiceAddress(service, 'http://192.168.1.20:9834')).rejects.toThrow('HTTPS');
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('does not interrupt a working connection just to save another address', async () => {
    const integration = await import('./browserIntegration');
    const service = { id: 'B', url: 'https://b.example', targetPeerId: 'B', label: 'Computer' };
    mocks.saved.mockReturnValue(service);
    const old = await integration.connectDevice(service);
    await integration.addServiceAddress(service, 'https://company.internal');
    expect(integration.currentSecureClient()).toBe(old);
    expect(old.close).not.toHaveBeenCalled();
    expect(clients.get('B')!.close).toHaveBeenCalledOnce();
  });
  it('uses the newly verified connection when an older reconnect subsequently fails', async () => {
    mocks.boot = 'C';
    const service = { id: 'C', url: 'https://home.internal', targetPeerId: 'C', label: 'Computer' };
    mocks.saved.mockReturnValue(service);
    let rejectOld!: (error: Error) => void;
    mocks.connect.mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }));
    const integration = await import('./browserIntegration');
    const pending = integration.getActiveClient();
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce());
    await integration.addServiceAddress(service, 'https://company.internal');
    const current = integration.currentSecureClient();
    rejectOld(new Error('Home network still unavailable'));
    await expect(pending).resolves.toBe(current);
  });
  it('does not let a late successful reconnect overwrite the manually restored address', async () => {
    mocks.boot = 'C';
    const service = { id: 'C', url: 'https://home.internal', targetPeerId: 'C', label: 'Computer' };
    mocks.saved.mockReturnValue(service);
    const dial = mocks.connect.getMockImplementation()!;
    const old = await dial({ targetPeerId: 'C' });
    let resolveOld!: (client: typeof old) => void;
    mocks.connect.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    const integration = await import('./browserIntegration');
    const pending = integration.getActiveClient();
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce());
    await integration.addServiceAddress(service, 'https://company.internal');
    const current = integration.currentSecureClient();
    resolveOld(old);
    await expect(pending).resolves.toBe(current);
    expect(integration.currentSecureClient()).toBe(current);
    expect(old.close).toHaveBeenCalledOnce();
    expect(mocks.save).toHaveBeenCalledOnce();
  });
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
