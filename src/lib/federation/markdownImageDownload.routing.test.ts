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
describe('Markdown lightbox encrypted downloads', () => {
  it.each(['direct', 'relay'] as const)('saves local images over %s without a worker or legacy preload requests', async mode => {
    vi.stubGlobal('navigator', { serviceWorker: { controller: null } });
    const base = mocks.connect.getMockImplementation()!;
    if (mode === 'relay') mocks.connect.mockImplementation(async args => {
      if (args.targetPeerId === 'B' && !args.socketFactory) throw new TypeError('direct unavailable');
      return base(args);
    });
    const integration = await import('./browserIntegration');
    const target = { url: 'https://b.example', targetPeerId: 'B',
      ...(mode === 'relay' ? { routes: [{ url: 'https://a.example', targetPeerId: 'A' }] } : {}) };
    mocks.saved.mockReturnValue(target);
    const client = await integration.connectDevice(target);
    const business = vi.fn(async () => new Response('original image bytes', { headers: { 'Content-Type': 'image/svg+xml' } }));
    Object.assign(client, { fetch: business });
    const nativeUpload = vi.fn();
    const write = vi.fn(async (_blob: Blob) => {}), close = vi.fn(async () => {});
    const picker = vi.fn(async () => ({ createWritable: async () => ({ write, close }) }));
    Object.assign(window, { showSaveFilePicker: picker, termdockDesktop: { uploadClipboardImage: nativeUpload, uploadDroppedFiles: nativeUpload } });
    integration.installEncryptedFetch();
    vi.stubGlobal('fetch', window.fetch);
    const { downloadMarkdownImage } = await import('../components/sidebar/markdownImageDownload');
    await downloadMarkdownImage({ kind: 'image', src: '/api/terminal/fs/blob?path=%2Frepo%2Fmap.svg', alt: 'Map' });
    expect(business).toHaveBeenCalledWith('/api/terminal/fs/download?path=%2Frepo%2Fmap.svg', undefined);
    expect(picker).toHaveBeenCalledWith({ suggestedName: 'map.svg' });
    expect(await (write.mock.calls[0][0] as Blob).text()).toBe('original image bytes');
    expect(close).toHaveBeenCalledOnce();
    business.mockRejectedValueOnce(new Error('encrypted connection lost'));
    await expect(downloadMarkdownImage({ kind: 'image', src: '/api/terminal/fs/blob?path=%2Frepo%2Fmap.svg', alt: 'Map' })).rejects.toThrow('encrypted connection lost');
    expect(picker).toHaveBeenCalledOnce();
    expect(integration.currentConnectionPath()).toBe(mode);
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(nativeUpload).not.toHaveBeenCalled();
  });
});
