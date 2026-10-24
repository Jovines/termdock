import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionAccessError } from './accessFailure';
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
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), location });
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
  it('clears an old login denial only after an explicit new invitation returns valid target permissions', async () => {
    const selected = { url: 'https://b.example', targetPeerId: 'B' }; mocks.saved.mockReturnValue(selected);
    const integration = await import('./browserIntegration');
    integration.pauseConnectionAccess(new ConnectionAccessError('TARGET_AUTHORIZATION_REQUIRED', { targetServiceId: 'B' }));
    await expect(integration.getActiveClient()).rejects.toMatchObject({ code: 'TARGET_AUTHORIZATION_REQUIRED' });
    const base = mocks.connect.getMockImplementation()!;
    mocks.connect.mockImplementation(async args => { const client = await base(args); client.request.mockImplementation(async (packet: { type: string }) => packet.type === 'permissions' ? { type: 'result', fullService: false, grants: [{ actions: ['session.view'] }] } : {}); return client; });
    const client = await integration.connectDevice({ ...selected, pairingCode: 'explicit-invitation' });
    expect(await integration.getActiveClient()).toBe(client);
    expect((await client.request({ type: 'permissions' })).fullService).toBe(false);
    integration.pauseConnectionAccess(new ConnectionAccessError('TARGET_AUTHORIZATION_REQUIRED', { targetServiceId: 'B' }));
    mocks.connect.mockRejectedValue(new Error('PAIRING_DENIED'));
    await expect(integration.connectDevice({ ...selected, pairingCode: 'invalid-invitation' })).rejects.toThrow('PAIRING_DENIED');
    await expect(integration.getActiveClient()).rejects.toMatchObject({ code: 'TARGET_AUTHORIZATION_REQUIRED' });
  });
  it('pauses an access-blocked target without network retries, retaining saved metadata until explicit recovery', async () => {
    const selected = { url: 'https://b.example', targetPeerId: 'B', routes: [] };
    mocks.saved.mockReturnValue(selected);
    const integration = await import('./browserIntegration');
    const denied = new ConnectionAccessError('RELAY_AUTHORIZATION_REQUIRED', { targetServiceId: 'B', entryServiceId: 'A', entryUrl: 'https://a.example' });
    integration.pauseConnectionAccess(denied);
    for (let i = 0; i < 3; i++) await expect(integration.getActiveClient()).rejects.toMatchObject({ code: 'RELAY_AUTHORIZATION_REQUIRED' });
    expect(mocks.connect).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.saved()).toBe(selected);
    integration.resumeConnectionAccess(); await integration.getActiveClient();
    expect(integration.currentSecureClient()?.targetPeerId).toBe('B');
  });
  it('recovers direct access after a transient outage and relay denial without retrying or authorizing the entry', async () => {
    const selected = { url: 'https://b.example', targetPeerId: 'B', routes: [{ url: 'https://a.example', targetPeerId: 'A' }] };
    mocks.saved.mockReturnValue(selected);
    const connect = mocks.connect.getMockImplementation()!;
    let reachable = false;
    const ticket = vi.fn(async () => { throw new Error('AUTHORIZATION_DENIED'); });
    mocks.connect.mockImplementation(async args => {
      if (args.targetPeerId === 'B' && !reachable) throw new TypeError('network changed');
      const client = await connect(args);
      if (args.targetPeerId === 'A') client.request = ticket;
      return client;
    });
    const integration = await import('./browserIntegration');
    await expect(integration.getActiveClient()).rejects.toMatchObject({ code: 'RELAY_AUTHORIZATION_REQUIRED' });
    expect(ticket).toHaveBeenCalledTimes(1);
    mocks.connect.mockClear();
    await expect(integration.retryDirectConnection()).rejects.toThrow('network changed');
    await expect(integration.getActiveClient()).rejects.toMatchObject({ code: 'RELAY_AUTHORIZATION_REQUIRED' });
    expect(ticket).toHaveBeenCalledTimes(1);
    reachable = true;
    const recovered = await integration.retryDirectConnection();
    expect(await integration.getActiveClient()).toBe(recovered);
    expect(integration.currentConnectionPath()).toBe('direct');
    expect(mocks.connect.mock.calls.every(([args]) => args.targetPeerId === 'B' && !args.socketFactory)).toBe(true);
    expect(ticket).toHaveBeenCalledTimes(1);
    expect(mocks.saved()).toBe(selected);
    expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({ targetPeerId: 'B', routes: selected.routes }));
    expect(nativeFetch).not.toHaveBeenCalled();
  });
  it('recovers through an already-saved independent entry without reusing any address of the revoked entry or creating grants', async () => {
    mocks.boot = 'A';
    const routes = [{ url: 'https://b.example', targetPeerId: 'B' }, { url: 'https://b-alternate.example', targetPeerId: 'B' }, { url: 'https://c.example', targetPeerId: 'C' }];
    const selected = { url: routes[0].url, targetPeerId: 'A', entryServiceId: 'B', routes };
    mocks.saved.mockReturnValue(selected);
    const integration = await import('./browserIntegration');
    integration.pauseConnectionAccess(new ConnectionAccessError('RELAY_AUTHORIZATION_REQUIRED', { targetServiceId: 'A', entryServiceId: 'B' }));
    expect(integration.canRetryConnectionAccess()).toBe(true);
    const client = await integration.retryConnectionAccess();
    expect(client.targetPeerId).toBe('A'); expect(integration.currentConnectionPath()).toBe('relay');
    expect(mocks.connect.mock.calls.every(([args]) => args.targetPeerId !== 'B')).toBe(true);
    expect(clients.get('C')!.request.mock.calls.some(([packet]) => packet.type === 'route-grant')).toBe(false);
    expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({ targetPeerId: 'A', routes }));
    client.close(); mocks.connect.mockClear();
    await integration.getActiveClient();
    expect(mocks.connect.mock.calls.every(([args]) => args.targetPeerId !== 'B')).toBe(true);
  });
  it('stops independent-entry recovery when all saved entries are revoked', async () => {
    mocks.boot = 'A';
    const selected = { url: 'https://b.example', targetPeerId: 'A', entryServiceId: 'B', routes: [{ url: 'https://b.example', targetPeerId: 'B' }, { url: 'https://c.example', targetPeerId: 'C' }] };
    mocks.saved.mockReturnValue(selected);
    const base = mocks.connect.getMockImplementation()!;
    mocks.connect.mockImplementation(async args => { const client = await base(args); client.request.mockRejectedValue(new Error('AUTHORIZATION_DENIED')); return client; });
    const integration = await import('./browserIntegration');
    integration.pauseConnectionAccess(new ConnectionAccessError('RELAY_AUTHORIZATION_REQUIRED', { targetServiceId: 'A', entryServiceId: 'B' }));
    await expect(integration.retryConnectionAccess()).rejects.toMatchObject({ code: 'RELAY_AUTHORIZATION_REQUIRED' });
    expect(integration.canRetryConnectionAccess()).toBe(false);
    const calls = mocks.connect.mock.calls.length;
    await expect(integration.retryConnectionAccess()).rejects.toThrow();
    expect(mocks.connect).toHaveBeenCalledTimes(calls);
  });
  it.each(['TARGET_AUTHORIZATION_REQUIRED', 'TARGET_IDENTITY_MISMATCH'] as const)('stops direct recovery on confirmed %s', async code => {
    mocks.saved.mockReturnValue({ url: 'https://b.example', targetPeerId: 'B', routes: [{ url: 'https://a.example', targetPeerId: 'A' }] });
    const integration = await import('./browserIntegration');
    integration.pauseConnectionAccess(new ConnectionAccessError('RELAY_AUTHORIZATION_REQUIRED', { targetServiceId: 'B' }));
    mocks.connect.mockRejectedValue(new ConnectionAccessError(code));
    await expect(integration.retryDirectConnection()).rejects.toMatchObject({ code });
    const calls = mocks.connect.mock.calls.length;
    await expect(integration.retryDirectConnection()).rejects.toMatchObject({ code });
    await expect(integration.getActiveClient()).rejects.toMatchObject({ code });
    expect(mocks.connect).toHaveBeenCalledTimes(calls);
  });
  it('does not retry a denied relay when no independent direct address is saved', async () => {
    mocks.saved.mockReturnValue({ url: 'https://a.example', targetPeerId: 'B', routes: [{ url: 'https://a.example', targetPeerId: 'A' }] });
    const integration = await import('./browserIntegration');
    integration.pauseConnectionAccess(new ConnectionAccessError('RELAY_AUTHORIZATION_REQUIRED', { targetServiceId: 'B' }));
    await expect(integration.retryDirectConnection()).rejects.toMatchObject({ code: 'RELAY_AUTHORIZATION_REQUIRED' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('filters and deduplicates directory targets by the authenticated entry identity, preserving same-name different services', async () => {
    const integration = await import('./browserIntegration');
    await integration.connectDevice({ url: 'https://b.example', targetPeerId: 'B' });
    clients.get('B')!.request.mockResolvedValue({ canManage: true, items: [
      { serviceId: 'B', label: 'Work', url: 'https://other-address.example', available: true, authorized: true },
      { serviceId: 'C', label: 'Work', available: true, authorized: true },
      { serviceId: 'C', label: 'Duplicate', available: true, authorized: true },
    ] });
    expect((await integration.listRelayTargets({ id: 'B', url: 'https://alias.example', targetPeerId: 'B', label: 'Alias' })).items).toEqual([
      { serviceId: 'C', label: 'Work', available: true, authorized: true },
    ]);
  });
  it('rejects self relay preparation, inspection, grants, invitations and dirty saved intents before any connection or writes', async () => {
    const integration = await import('./browserIntegration');
    const target = { url: 'https://alias.example', targetPeerId: 'B' }, route = { url: 'https://other.example', targetPeerId: 'B' };
    for (const work of [() => integration.prepareRelayConnection(route, 'B'), () => integration.inspectEntryRoute(route, 'B'),
      () => integration.authorizeEntryRoute(target, route, 'must-not-submit'), () => integration.createEntryInvitation(target, route),
      () => integration.connectDevice({ ...target, entryServiceId: 'B' })]) {
      await expect(work()).rejects.toMatchObject({ code: 'RELAY_SELF_TARGET' });
    }
    expect(mocks.connect).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled(); expect(nativeFetch).not.toHaveBeenCalled();
  });
  it.each(['identity-first', 'identity-last'] as const)('retains an observed pin mismatch when every address fails (%s)', async order => {
    mocks.saved.mockReturnValue({ url: location.origin, targetPeerId: 'B', routes: [{ url: 'https://alternate.example', targetPeerId: 'B' }] });
    const mismatch = Object.assign(new Error('private-mismatched-identities'), { name: 'UnexpectedPeerError' });
    const unreachable = new Error('Secure transport unavailable');
    mocks.connect.mockRejectedValueOnce(order === 'identity-first' ? mismatch : unreachable)
      .mockRejectedValueOnce(order === 'identity-first' ? unreachable : mismatch);
    const integration = await import('./browserIntegration'); integration.installEncryptedFetch();
    vi.stubGlobal('fetch', window.fetch);
    const { loginWithPassword } = await import('../terminal/api');
    const result = await loginWithPassword('existing-password');
    expect(result).toMatchObject({ ok: false, reason: 'identityMismatch' });
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(mocks.connect.mock.calls.every(([args]) => args.targetPeerId === 'B')).toBe(true);
    expect(mocks.save).not.toHaveBeenCalled(); expect(nativeFetch).not.toHaveBeenCalled();
  });
  it('uses a successful alternate with the same pin after another address mismatches', async () => {
    mocks.saved.mockReturnValue({ url: location.origin, targetPeerId: 'B', routes: [{ url: 'https://alternate.example', targetPeerId: 'B' }] });
    const dial = mocks.connect.getMockImplementation()!;
    mocks.connect.mockImplementation(async args => {
      if (args.url.includes('b.example')) throw Object.assign(new Error('private-wrong-server'), { name: 'UnexpectedPeerError' });
      return dial(args);
    });
    const integration = await import('./browserIntegration'); integration.installEncryptedFetch();
    vi.stubGlobal('fetch', window.fetch);
    const { loginWithPassword } = await import('../terminal/api');
    expect(await loginWithPassword('existing-password')).toEqual({ ok: true });
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ targetPeerId: 'B' }));
    expect(mocks.connect.mock.calls.every(([args]) => args.targetPeerId === 'B')).toBe(true);
    expect(mocks.connect.mock.calls.some(([args]) => args.url === 'wss://alternate.example/api/federation/secure')).toBe(true);
    expect(nativeFetch).not.toHaveBeenCalled();
  });
  it.each([
    new TypeError('private-endpoint connection refused'),
    new DOMException('private-timeout-details', 'TimeoutError'),
  ])('preserves a parameters connection failure and allows an explicit retry after recovery (%s)', async error => {
    vi.stubGlobal('navigator', { serviceWorker: { controller: null } });
    nativeFetch.mockRejectedValueOnce(error);
    const integration = await import('./browserIntegration'); integration.installEncryptedFetch();
    vi.stubGlobal('fetch', window.fetch);
    const { loginWithPassword } = await import('../terminal/api');
    expect(await loginWithPassword('existing-password')).toMatchObject({ ok: false, reason: 'connectionFailed' });
    expect(mocks.connect).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    expect(nativeFetch).toHaveBeenCalledOnce();
    expect(await loginWithPassword('existing-password')).toEqual({ ok: true });
    expect(nativeFetch.mock.calls.map(call => call[0])).toEqual(['/api/auth/password/parameters', '/api/auth/password/parameters', '/api/auth/password/start', '/api/auth/password/finish']);
    expect(JSON.stringify(nativeFetch.mock.calls)).not.toContain('existing-password');
  });
  it.each([
    [401, { code: 'INVALID_PASSWORD', error: 'private-proof-details' }, 'invalidPassword'],
    [404, { error: 'private-route-not-found' }, 'unavailable'],
    [503, { error: 'private-server-stack' }, 'unavailable'],
    [429, { code: 'RATE_LIMITED', retryAfterMs: 12345, error: 'private-rate-details' }, 'rateLimited'],
  ] as const)('keeps public bootstrap status %s distinct without exposing upstream details', async (status, body, reason) => {
    nativeFetch.mockResolvedValueOnce(Response.json(body, { status }));
    const integration = await import('./browserIntegration'); integration.installEncryptedFetch();
    vi.stubGlobal('fetch', window.fetch);
    const { loginWithPassword } = await import('../terminal/api');
    const result = await loginWithPassword('existing-password');
    expect(result).toMatchObject({ ok: false, reason });
    expect(JSON.stringify(result)).not.toContain('private-');
    if (status === 429) expect(result).toMatchObject({ rateLimited: true, retryAfterMs: 12345 });
    expect(nativeFetch).toHaveBeenCalledOnce(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each([
    [new Error('Secure connection timed out'), 'connectionFailed'],
    [Object.assign(new Error('private-peer-identities'), { name: 'UnexpectedPeerError' }), 'identityMismatch'],
  ] as const)('keeps pinned transport failure distinct (%s) without public HTTP fallback', async (error, reason) => {
    mocks.saved.mockReturnValue({ url: location.origin, targetPeerId: 'B' });
    mocks.connect.mockRejectedValueOnce(error);
    const integration = await import('./browserIntegration'); integration.installEncryptedFetch();
    vi.stubGlobal('fetch', window.fetch);
    const { loginWithPassword } = await import('../terminal/api');
    const result = await loginWithPassword('existing-password');
    expect(result).toMatchObject({ ok: false, reason });
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(nativeFetch).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.connect.mock.calls[0][0].targetPeerId).toBe('B');
  });
  it.each(['direct', 'relay'] as const)('keeps secure rate limits over %s and closes the password transport', async mode => {
    mocks.saved.mockReturnValue({ url: location.origin, targetPeerId: 'B', routes: mode === 'relay' ? [{ url: 'https://a.example', targetPeerId: 'A' }] : [] });
    const dial = mocks.connect.getMockImplementation()!;
    mocks.connect.mockImplementation(async args => {
      if (mode === 'relay' && args.targetPeerId === 'B' && !args.socketFactory) throw new TypeError('direct unavailable');
      const client = await dial(args);
      if (args.targetPeerId === 'B') client.request.mockImplementation(async (packet: { type: string }) => {
        if (packet.type === 'password-start') throw new Error('LOGIN_RATE_LIMIT');
        return { saltHex: 'salt' };
      });
      return client;
    });
    const integration = await import('./browserIntegration'); integration.installEncryptedFetch();
    vi.stubGlobal('fetch', window.fetch);
    const { loginWithPassword } = await import('../terminal/api');
    expect(await loginWithPassword('existing-password')).toMatchObject({ ok: false, reason: 'rateLimited', rateLimited: true });
    expect(clients.get('B')!.close).toHaveBeenCalled();
    expect(nativeFetch).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each(['direct', 'relay'] as const)('reads native architecture over %s on first load and rejects disconnects without native fallback', async mode => {
    vi.stubGlobal('navigator', { serviceWorker: { controller: null } });
    const base = mocks.connect.getMockImplementation()!;
    const document = { version: 1, generatedAt: '2026-10-09T09:00:00Z', summary: 'Remote project',
      perspectives: [{ id: 'overview', title: 'Overview', summary: '',
        nodes: [{ id: 'server', title: 'Server', summary: '', files: [{ path: 'src/server.ts', line: 2 }] }], edges: [] }] };
    const business = vi.fn(async (input: string) => input.startsWith('/api/terminal/architecture/documents?')
      ? Response.json({ files: ['.termdock/architectures/feature-Upload-12345678.json'] })
      : Response.json({ document, revision: null }));
    mocks.connect.mockImplementation(async args => {
      if (mode === 'relay' && args.targetPeerId === 'B' && !args.socketFactory) throw new TypeError('direct unavailable');
      return Object.assign(await base(args), { fetch: business });
    });
    const legacyUpload = vi.fn();
    Object.assign(window, { electronAPI: { uploadClipboardImage: legacyUpload, uploadDroppedFiles: legacyUpload } });
    const integration = await import('./browserIntegration');
    const target = { url: 'https://b.example', targetPeerId: 'B',
      routes: mode === 'relay' ? [{ url: 'https://a.example', targetPeerId: 'A' }] : [] };
    mocks.saved.mockReturnValue(target);
    await integration.connectDevice(target);
    integration.installEncryptedFetch(); vi.stubGlobal('fetch', window.fetch);
    const { listArchitectures, readArchitecture } = await import('../architecture/api');
    const controller = new AbortController();
    expect(await readArchitecture('/remote project', controller.signal)).toEqual(document);
    expect(business).toHaveBeenCalledWith('/api/terminal/architecture/document?file=.termdock%2Farchitecture.json&root=%2Fremote+project', expect.objectContaining({ signal: controller.signal, cache: 'no-store' }));
    expect(await listArchitectures('/remote project', controller.signal)).toEqual(['.termdock/architectures/feature-Upload-12345678.json']);
    expect(business).toHaveBeenCalledWith('/api/terminal/architecture/documents?root=%2Fremote+project', expect.objectContaining({ signal: controller.signal, cache: 'no-store' }));
    business.mockResolvedValueOnce(Response.json({ document: null, revision: null }));
    expect(await readArchitecture('/remote project', controller.signal)).toBeNull();
    business.mockRejectedValueOnce(new Error('Secure connection closed'));
    await expect(readArchitecture('/remote project', controller.signal)).rejects.toThrow('Secure connection closed');
    business.mockRejectedValueOnce(new Error('Secure connection closed'));
    await expect(listArchitectures('/remote project', controller.signal)).rejects.toThrow('Secure connection closed');
    expect(business).toHaveBeenCalledTimes(5);
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(legacyUpload).not.toHaveBeenCalled();
    expect(integration.currentConnectionPath()).toBe(mode);
  });

  it.each(['direct', 'relay'] as const)('reconnects concurrent complete collaboration reads over %s after a suspended channel closes', async mode => {
    vi.stubGlobal('navigator', { onLine: true, serviceWorker: { controller: null } });
    const base = mocks.connect.getMockImplementation()!;
    const business = vi.fn(async () => Response.json({ tasks: [], messages: [] }));
    mocks.connect.mockImplementation(async args => {
      if (mode === 'relay' && args.targetPeerId === 'B' && !args.socketFactory) throw new TypeError('direct unavailable');
      return Object.assign(await base(args), { fetch: business });
    });
    const integration = await import('./browserIntegration');
    const target = { url: 'https://b.example', targetPeerId: 'B', routes: mode === 'relay' ? [{ url: 'https://a.example', targetPeerId: 'A' }] : [] };
    mocks.saved.mockReturnValue(target);
    const previous = await integration.connectDevice(target);
    integration.installEncryptedFetch(); vi.stubGlobal('fetch', window.fetch);
    const api = await import('../terminal/api');
    const brokenBody = () => new Response(new ReadableStream({ start(controller) {
      controller.error(Object.assign(new Error('Unexpected EOF - stream closed while reading 0/1 bytes'), { name: 'UnexpectedEOFError' }));
    } }));
    business.mockImplementationOnce(async () => brokenBody()).mockImplementationOnce(async () => brokenBody());
    const connectedBefore = mocks.connect.mock.calls.length;
    expect(await Promise.all([api.listCollaborationTasks('test'), api.listCollaborationMessages('test')])).toEqual([{ tasks: [], messages: [] }, { tasks: [], messages: [] }]);
    expect(previous.close).toHaveBeenCalled();
    expect(integration.currentSecureClient()).not.toBe(previous);
    expect(mocks.connect.mock.calls.length - connectedBefore).toBe(mode === 'direct' ? 1 : 2);
    expect(integration.currentConnectionPath()).toBe(mode);
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(business).toHaveBeenCalledTimes(4);
  });

  it.each(['write', 'abort', 'switch', 'unavailable'] as const)('does not replay unsafe or unrecoverable collaboration operations: %s', async scenario => {
    vi.stubGlobal('navigator', { onLine: true });
    const integration = await import('./browserIntegration');
    const target = { url: 'https://b.example', targetPeerId: 'B' };
    mocks.saved.mockReturnValue(target);
    const previous = await integration.connectDevice(target);
    const business = vi.fn(async () => { throw new Error('Secure connection closed'); });
    Object.assign(previous, { fetch: business });
    integration.installEncryptedFetch(); vi.stubGlobal('fetch', window.fetch);
    const api = await import('../terminal/api');
    const controller = new AbortController();
    const read = vi.fn(async () => {
      if (scenario === 'abort') controller.abort();
      if (scenario === 'switch') mocks.saved.mockReturnValue({ ...target, url: 'https://alternate.example' });
      throw scenario === 'switch'
        ? Object.assign(new Error('Unexpected EOF - stream closed while reading 0/1 bytes'), { name: 'UnexpectedEOFError' })
        : new Error('Secure connection closed');
    });
    if (scenario === 'unavailable') mocks.connect.mockRejectedValue(new Error('network unavailable'));
    await expect(scenario === 'write' ? api.updateCollaborationTask('task', { kind: 'revise', content: 'follow up', idempotencyKey: 'one' })
      : integration.readWithSecureReconnect(read, controller.signal)).rejects.toThrow(scenario === 'unavailable' ? 'network unavailable'
        : scenario === 'switch' ? 'Unexpected EOF - stream closed while reading 0/1 bytes' : 'Secure connection closed');
    expect(scenario === 'write' ? business : read).toHaveBeenCalledOnce();
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it.each(['switch','abort'] as const)('rejects a first successful read completed after %s without retry',async scenario=>{
    const integration=await import('./browserIntegration');
    const target={url:'https://b.example',targetPeerId:'B'};mocks.saved.mockReturnValue(target);
    const controller=new AbortController();let finish!:(value:string)=>void;
    const read=vi.fn(()=>new Promise<string>(resolve=>{finish=resolve;}));
    const result=integration.readWithSecureReconnect(read,controller.signal);
    if(scenario==='switch')mocks.saved.mockReturnValue({...target,url:'https://other.example'});else controller.abort();
    finish('old body');await expect(result).rejects.toThrow(scenario==='switch'?'Secure read target changed':'aborted');
    expect(read).toHaveBeenCalledTimes(1);expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each(['init', 'request', 'override', 'already-aborted'] as const)('honors %s cancellation while the first encrypted connection is pending', async mode => {
    const integration = await import('./browserIntegration');
    integration.installEncryptedFetch();
    mocks.saved.mockReturnValue({ url: 'https://b.example', targetPeerId: 'B' });
    const dial = mocks.connect.getMockImplementation()!;
    let release!: () => void;
    const pause = new Promise<void>(resolve => { release = resolve; });
    const encryptedFetch = vi.fn(async () => Response.json({ sessions: [] }));
    mocks.connect.mockImplementation(async args => {
      await pause;
      return Object.assign(await dial(args), { fetch: encryptedFetch });
    });
    const controller = new AbortController();
    const reason = new DOMException('request cancelled', 'AbortError');
    if (mode === 'already-aborted') controller.abort(reason);
    const url = 'https://b.example/api/terminal/operations/collaboration-federation';
    const input = mode === 'request' || mode === 'override'
      ? new Request(url, { signal: mode === 'override' ? AbortSignal.abort() : controller.signal }) : url;
    const pending = window.fetch(input, mode === 'request' ? undefined : { signal: controller.signal });
    const rejected = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(encryptedFetch).not.toHaveBeenCalled();
    // A cancelled discovery must not cancel another caller's reconnect.
    const surviving = window.fetch(url);
    release();
    expect((await surviving).ok).toBe(true);
    expect(encryptedFetch).toHaveBeenCalledTimes(1);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

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

  it.each(['direct', 'relay'] as const)('loads plugin icons over the encrypted %s path without worker control', async mode => {
    vi.stubGlobal('navigator', { serviceWorker: { controller: null } });
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
    const business = vi.fn(async () => new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }));
    Object.assign(client, { fetch: business });
    integration.installEncryptedFetch();
    const path = '/api/terminal/agent-plugin-icon/custom?v=123';
    expect(await (await window.fetch(path)).text()).toBe('<svg/>');
    expect(business).toHaveBeenCalledWith(path, undefined);
    business.mockRejectedValueOnce(new Error('connection lost'));
    await expect(window.fetch(path)).rejects.toThrow('connection lost');
    expect(integration.currentConnectionPath()).toBe(mode);
    expect(nativeFetch).not.toHaveBeenCalled();
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
  it('reads and revalidates the active relayed service directory without dialing or closing its terminal', async () => {
    const dial = mocks.connect.getMockImplementation()!;
    mocks.connect.mockImplementation(async args => {
      if (args.targetPeerId === 'B' && !args.socketFactory) throw new TypeError('private address unreachable');
      return dial(args);
    });
    const integration = await import('./browserIntegration');
    const service = { id: 'B', targetPeerId: 'B', url: 'https://private.internal', label: 'Work', routes: [{ url: 'https://public.example', targetPeerId: 'A' }] };
    await integration.connectDevice(service);
    const target = clients.get('B')!, entry = clients.get('A')!;
    target.request.mockImplementation(async ({ type }: { type: string }) => type === 'route-access'
      ? { canManage: false, grants: [] } : { canManage: false, items: [{ serviceId: 'C', available: true, authorized: true }] });
    target.request.mockClear();
    mocks.connect.mockClear(); mocks.connect.mockRejectedValue(new Error('must not dial')); mocks.save.mockClear();
    expect(await integration.listRelayTargets(service)).toMatchObject({ route: { targetPeerId: 'B' }, items: [{ serviceId: 'C' }] });
    expect(await integration.prepareRelayConnection({ url: service.url, targetPeerId: 'B' }, 'C')).toMatchObject({ targetPeerId: 'C' });
    await integration.inspectEntryRoute({ url: service.url, targetPeerId: 'B' }, 'C');
    expect(mocks.connect).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    expect(target.close).not.toHaveBeenCalled(); expect(entry.close).not.toHaveBeenCalled();
    expect(integration.currentSecureClient()).toBe(target); expect(integration.currentConnectionPath()).toBe('relay');
    expect(target.request.mock.calls.every(([packet]) => ['route-targets', 'route-access'].includes(packet.type))).toBe(true);
    expect(nativeFetch).not.toHaveBeenCalled();
  });
  it('borrows the existing entry for another active target without replacing either connection', async () => {
    mocks.boot = 'C';
    const dial = mocks.connect.getMockImplementation()!;
    mocks.connect.mockImplementation(async args => {
      if (args.targetPeerId === 'C' && !args.socketFactory) throw new TypeError('direct target unavailable');
      return dial(args);
    });
    const integration = await import('./browserIntegration');
    await integration.connectDevice({ url: 'https://c.internal', targetPeerId: 'C', routes: [{ url: 'https://entry.example', targetPeerId: 'B' }] });
    const target = clients.get('C')!, entry = integration.currentEntryClient()!;
    expect(entry).toBeTruthy();
    vi.mocked(entry.request).mockResolvedValue({ id: 'fixture-response', type: 'result', items: [], canManage: false });
    mocks.connect.mockClear(); mocks.connect.mockRejectedValue(new Error('must not dial'));
    await integration.listRelayTargets({ id: 'B', targetPeerId: 'B', url: 'https://entry.example', label: 'Entry' });
    expect(mocks.connect).not.toHaveBeenCalled(); expect(entry.close).not.toHaveBeenCalled(); expect(target.close).not.toHaveBeenCalled();
    expect(integration.currentSecureClient()).toBe(target);
  });
  it('opens a temporary directory channel through saved grants without discovering or granting reverse routes', async () => {
    const service = { id: 'B', url: 'https://private.internal', targetPeerId: 'B', label: 'Work', routes: [{ url: 'https://public.example', targetPeerId: 'A' }] };
    local.setItem('termdock.federation.connections.v1', JSON.stringify([service]));
    const before = local.getItem('termdock.federation.connections.v1');
    const dial = mocks.connect.getMockImplementation()!;
    const opened: Array<{ request: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
    mocks.connect.mockImplementation(async args => {
      if (args.targetPeerId === 'B' && !args.socketFactory) throw new TypeError('direct unreachable');
      const client = await dial(args); opened.push(client);
      if (args.targetPeerId === 'B') client.request.mockResolvedValue({ items: [], canManage: false });
      return client;
    });
    const integration = await import('./browserIntegration');
    expect(await integration.listRelayTargets(service)).toMatchObject({ items: [], canManage: false });
    expect(mocks.connect.mock.calls.some(([args]) => args.targetPeerId === 'B' && args.socketFactory)).toBe(true);
    expect(opened.flatMap(c => c.request.mock.calls.map(([packet]) => packet.type)).sort()).toEqual(['route-targets', 'route-ticket']);
    expect(opened.every(c => c.close.mock.calls.length === 1)).toBe(true);
    expect(local.getItem('termdock.federation.connections.v1')).toBe(before); expect(mocks.save).not.toHaveBeenCalled();
    expect(integration.currentSecureClient()).toBeUndefined(); expect(nativeFetch).not.toHaveBeenCalled();
  });
  it('preserves a borrowed directory denial without reconnecting, granting access or closing the shared client', async () => {
    const integration = await import('./browserIntegration'); await integration.connectDevice({ url: 'https://b.example', targetPeerId: 'B' });
    const client = clients.get('B')!, denied = new Error('AUTHORIZATION_DENIED'); client.request.mockRejectedValue(denied);
    mocks.connect.mockClear();
    await expect(integration.listRelayTargets({ id: 'B', url: 'https://private.internal', targetPeerId: 'B', label: 'Work' })).rejects.toBe(denied);
    expect(mocks.connect).not.toHaveBeenCalled(); expect(client.close).not.toHaveBeenCalled();
  });
  it('keeps the exact pin mismatch when directory connection attempts fail', async () => {
    const mismatch = Object.assign(new Error('expected service identity differs'), { name: 'UnexpectedPeerError' });
    mocks.connect.mockRejectedValueOnce(mismatch).mockRejectedValue(new Error('Secure transport unavailable'));
    const integration = await import('./browserIntegration');
    await expect(integration.listRelayTargets({ id: 'B', url: 'https://b.example', targetPeerId: 'B', label: 'Entry', routes: [{ url: 'https://alternate.example', targetPeerId: 'B' }] })).rejects.toBe(mismatch);
    expect(mocks.connect.mock.calls.every(([args]) => args.targetPeerId === 'B')).toBe(true); expect(nativeFetch).not.toHaveBeenCalled();
  });
  it('does not borrow a different target or automatically grant a reverse route to read a directory', async () => {
    const integration = await import('./browserIntegration'); await integration.connectDevice({ url: 'https://b.example', targetPeerId: 'B' });
    const active = clients.get('B')!; active.request.mockClear();
    local.setItem('termdock.federation.connections.v1', JSON.stringify([
      { id: 'B', url: 'https://b.example', targetPeerId: 'B', label: 'B', routes: [{ url: 'https://c.private', targetPeerId: 'C' }] },
      { id: 'C', url: 'https://c.private', targetPeerId: 'C', label: 'C' },
    ]));
    const failure = new Error('Secure transport unavailable'); mocks.connect.mockClear(); mocks.connect.mockRejectedValue(failure);
    await expect(integration.listRelayTargets({ id: 'C', url: 'https://c.private', targetPeerId: 'C', label: 'C' })).rejects.toBe(failure);
    expect(active.request).not.toHaveBeenCalled(); expect(active.close).not.toHaveBeenCalled();
    expect(mocks.connect.mock.calls.every(([args]) => args.targetPeerId === 'C' && !args.socketFactory)).toBe(true);
  });
  it('ignores a closed active client and disposes only the new temporary directory connection', async () => {
    const integration = await import('./browserIntegration'); await integration.connectDevice({ url: 'https://b.example', targetPeerId: 'B' });
    const old = clients.get('B')!; old.closed = true; old.request.mockClear();
    const dial = mocks.connect.getMockImplementation()!;
    mocks.connect.mockImplementation(async args => { const client = await dial(args); client.request.mockResolvedValue({ items: [] }); return client; });
    await expect(integration.listRelayTargets({ id: 'B', url: 'https://b.example', targetPeerId: 'B', label: 'B' })).resolves.toMatchObject({ items: [] });
    expect(old.request).not.toHaveBeenCalled(); expect(old.close).not.toHaveBeenCalled();
    expect(clients.get('B')).not.toBe(old); expect(clients.get('B')!.close).toHaveBeenCalledOnce();
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
  it('preserves a reverse-only target identity without recording the entry URL as a direct target origin', async () => {
    mocks.boot = 'C';
    const base = mocks.connect.getMockImplementation()!;
    mocks.connect.mockImplementation(async args => {
      const client = await base(args);
      if (args.targetPeerId === 'B') client.request.mockImplementation(async (packet: { type: string }) => packet.type === 'route-targets'
        ? { canManage: true, items: [{ serviceId: 'C', available: true, authorized: true }] } : { routeToken: 'ticket' });
      return client;
    });
    const integration = await import('./browserIntegration');
    const intent = await integration.prepareRelayConnection({ url: 'https://b.example', targetPeerId: 'B' }, 'C');
    expect(intent).toMatchObject({ url: 'https://b.example', targetPeerId: 'C', entryServiceId: 'B' });
    expect(intent.serviceOrigin).toBeUndefined();
    expect(integration.connectionAddresses(intent)).toEqual([]);
    await integration.connectDevice(intent);
    expect(integration.currentSecureClient()?.targetPeerId).toBe('C');
    expect(integration.currentConnectionPath()).toBe('relay');
    const saved = mocks.save.mock.calls.at(-1)![0];
    expect(saved).toMatchObject({ targetPeerId: 'C', entryServiceId: 'B' });
    expect(saved.serviceOrigin).toBeUndefined();
    expect(mocks.connect.mock.calls.some(([args]) => args.targetPeerId === 'C' && !args.socketFactory)).toBe(false);
  });
  it('preserves another address of the same entry when preparing a relay target', async () => {
    const existing = { url: 'https://entry-home.example', targetPeerId: 'B' };
    local.setItem('termdock.federation.connections.v1', JSON.stringify([
      { id: 'C', url: 'https://c.example', targetPeerId: 'C', label: 'Target', routes: [existing] },
    ]));
    const base = mocks.connect.getMockImplementation()!;
    mocks.connect.mockImplementation(async args => {
      const client = await base(args);
      client.request.mockResolvedValue({ items: [{ serviceId: 'C', available: true, authorized: true }] });
      return client;
    });
    const integration = await import('./browserIntegration');
    const alternate = { url: 'https://entry-office.example', targetPeerId: 'B' };
    expect(await integration.prepareRelayConnection(alternate, 'C')).toMatchObject({ routes: [alternate, existing] });
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
  it('keeps alternate addresses of the same relay and deduplicates normalized pairs', async () => {
    const integration = await import('./browserIntegration');
    expect(integration.connectionRoutes({ url: 'https://c.example', targetPeerId: 'C', routes: [
      { url: 'bad://address', targetPeerId: 'B' },
      { url: 'https://home.example/', targetPeerId: 'B' },
      { url: 'https://home.example', targetPeerId: 'B' },
      { url: 'https://office.example', targetPeerId: 'B' },
      { url: 'https://c.example', targetPeerId: 'C' },
    ] })).toEqual([
      { url: 'https://home.example', targetPeerId: 'B' },
      { url: 'https://office.example', targetPeerId: 'B' },
    ]);
  });
  it('tries the next address of the same entry when the first relay endpoint fails', async () => {
    const dial = mocks.connect.getMockImplementation()!;
    mocks.connect.mockImplementation(async args => {
      if (args.targetPeerId === 'B' && !args.socketFactory) throw new Error('direct unavailable');
      if (args.url.startsWith('wss://entry-home.example/api/federation/relay')) throw new Error('home relay unavailable');
      return dial(args);
    });
    const integration = await import('./browserIntegration');
    const routes = [
      { url: 'https://entry-home.example', targetPeerId: 'A' },
      { url: 'https://entry-office.example', targetPeerId: 'A' },
    ];
    await integration.connectDevice({ url: 'https://b.example', targetPeerId: 'B', routes });
    expect(mocks.connect.mock.calls.map(([args]) => args.url)).toEqual([
      'wss://b.example/api/federation/secure',
      'wss://entry-home.example/api/federation/secure',
      'wss://entry-home.example/api/federation/relay?routeToken=B-ticket',
      'wss://entry-office.example/api/federation/secure',
      'wss://entry-office.example/api/federation/relay?routeToken=B-ticket',
    ]);
    expect(integration.currentConnectionPath()).toBe('relay');
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ routes }));
    expect(nativeFetch).not.toHaveBeenCalled();
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
  it.each(['authorized', 'admin', 'directory-discovery', 'unprivileged', 'revoked-route', 'offline-tunnel', 'revoked-target'] as const)('recovers A through directly reachable B after the network changes (%s)', async mode => {
    mocks.boot = 'A';
    const a = { id: 'A', url: 'https://a.internal', targetPeerId: 'A', label: 'A', routes: [] };
    const b = { id: 'B', url: 'https://b.internal', targetPeerId: 'B', label: 'B', routes: mode === 'directory-discovery' ? [] : [{ url: 'https://a.internal', targetPeerId: 'A' }] };
    local.setItem('termdock.federation.connections.v1', JSON.stringify([a, b]));
    mocks.saved.mockReturnValue(a);
    const base = mocks.connect.getMockImplementation()!;
    const entryRequests: ReturnType<typeof vi.fn>[] = [];
    mocks.connect.mockImplementation(async args => {
      if (args.targetPeerId === 'A' && !args.socketFactory) throw new TypeError('new network cannot dial A');
      const client = await base(args);
      if (args.targetPeerId === 'B') {
        client.request.mockImplementation(async (packet: { type: string }) => {
          if (packet.type === 'route-targets') return { items: [{ serviceId: 'A', available: mode !== 'offline-tunnel', authorized: mode === 'authorized' || mode === 'directory-discovery' || mode === 'revoked-target' }], canManage: mode !== 'unprivileged' };
          if (packet.type === 'route-access') return { grants: mode === 'revoked-route' ? [{ subjectId: 'phone', targetServiceId: 'A', revokedAt: 1 }] : [] };
          if (packet.type === 'route-ticket' && ['admin', 'unprivileged', 'revoked-route'].includes(mode)) throw new Error('AUTHORIZATION_DENIED');
          if (packet.type === 'route-ticket' && mode === 'offline-tunnel') throw new Error('ROUTE_UNAVAILABLE');
          return { routeToken: 'B-ticket' };
        });
        entryRequests.push(client.request);
      }
      if (args.targetPeerId === 'A' && mode === 'revoked-target') client.request.mockResolvedValue({ type: 'result', fullService: false, grants: [] });
      return client;
    });
    const integration = await import('./browserIntegration');
    if (mode === 'authorized' || mode === 'directory-discovery') {
      await integration.connectDevice(a);
      expect(integration.currentSecureClient()?.targetPeerId).toBe('A');
      expect(integration.currentConnectionPath()).toBe('relay');
      expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ targetPeerId: 'A', routes: [{ url: 'https://b.internal', targetPeerId: 'B' }] }));
    } else {
      await expect(integration.connectDevice(a)).rejects.toThrow();
      expect(mocks.save).not.toHaveBeenCalled();
      expect(entryRequests.flatMap(fn => fn.mock.calls).some(([packet]) => packet.type === 'route-grant')).toBe(false);
    }
    expect(nativeFetch).not.toHaveBeenCalled();
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

it.each(['TARGET_PASSWORD_REQUIRED', 'TARGET_SECURITY_UPGRADE_REQUIRED'] as const)('recovers only an independently authorized direct path after the relay security block %s', async code => {
  const selected = { url: 'https://target.example', targetPeerId: 'B', routes: [{ url: 'https://entry.example', targetPeerId: 'A' }] };
  mocks.saved.mockReturnValue(selected);
  const integration = await import('./browserIntegration');
  integration.pauseConnectionAccess(new ConnectionAccessError(code, { targetServiceId: 'B', entryServiceId: 'A', entryUrl: 'https://entry.example' }));
  expect(integration.canRetryConnectionAccess()).toBe(true);
  await integration.retryConnectionAccess();
  expect(integration.currentConnectionPath()).toBe('direct');
  expect(mocks.connect.mock.calls.every(([args]) => args.targetPeerId === 'B' && !args.socketFactory)).toBe(true);
  expect(nativeFetch).not.toHaveBeenCalled();
});
