// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalAccessManager, isLoopbackHost, localAccessInterfaceUrl, localAccessOrigin } from './localAccess.js';

const fixtures = vi.hoisted(() => ({ authEnabled: false, mdns: vi.fn() }));
vi.mock('os', () => ({ default: { networkInterfaces: () => ({
  en0: [{ family: 'IPv4', address: '192.168.1.20', internal: false }],
  tun0: [{ family: 'IPv4', address: '10.1.1.20', internal: false }],
  lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
}) } }));
vi.mock('multicast-dns', () => ({ default: fixtures.mdns }));
vi.mock('./authProtection.js', () => ({ isAuthEnabled: () => fixtures.authEnabled }));
vi.mock('./settings.js', () => ({
  getLocalAccessSetting: () => ({ name: 'test', source: 'manual' }),
  getLocalAccessSettingAsync: async () => ({ name: 'test', source: 'manual' }),
  createAutoLocalAccessName: () => 'test-auto', normalizeLocalAccessName: (value: string) => value,
  setLocalAccessSettingAsync: vi.fn(),
}));

beforeEach(() => {
  fixtures.authEnabled = false;
  fixtures.mdns.mockImplementation(() => Object.assign(new EventEmitter(), {
    query: vi.fn(), respond: vi.fn(), destroy: (done?: () => void) => done?.(),
  }));
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('local access listener addresses', () => {
  it.each([
    ['http', 18700, 'http://192.168.1.20:18700'],
    ['https', 18701, 'https://192.168.1.20:18701'],
    ['http', 80, 'http://192.168.1.20'],
    ['https', 443, 'https://192.168.1.20'],
    ['https', 9834, 'https://192.168.1.20:9834'],
  ] as const)('uses the %s listener port %i for copy and QR origins', async (scheme, port, expected) => {
    const state = await new LocalAccessManager().start({ host: '0.0.0.0', port, scheme });
    expect(state.status).toBe('needs-auth');
    expect(state.interfaces).toHaveLength(2);
    expect(state.fallbackUrl).toBe(expected);
    expect(localAccessInterfaceUrl(state.url, state.interfaces[0].address)).toBe(expected);
    expect(localAccessInterfaceUrl(state.url, '2001:db8::20')).toBe(localAccessOrigin('2001:db8::20', port, scheme));
  });

  it.each(['127.0.0.1', '127.0.0.2', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1'])('does not advertise LAN interfaces when bound to %s', async (host) => {
    const state = await new LocalAccessManager().start({ host, port: 18700, scheme: 'https', caCertPath: '/test/ca.pem' });
    expect(isLoopbackHost(host)).toBe(true);
    expect(state).toMatchObject({ status: 'loopback-only', interfaces: [], lanAddresses: [], onboardingUrl: null });
    expect(state.fallbackUrl).toBe(localAccessOrigin(host, 18700, 'https'));
    expect(fixtures.mdns).not.toHaveBeenCalled();
  });

  it('only publishes the IPv4 address the listener accepts, including in mDNS responses', async () => {
    fixtures.authEnabled = true;
    vi.useFakeTimers();
    const manager = new LocalAccessManager();
    const pending = manager.start({ host: '10.1.1.20', port: 18700, scheme: 'http' });
    await vi.advanceTimersByTimeAsync(650);
    const state = await pending;
    expect(state.status).toBe('active');
    expect(state.lanAddresses).toEqual(['10.1.1.20']);
    expect(state.interfaces.map(entry => entry.address)).toEqual(['10.1.1.20']);
    expect(state.fallbackUrl).toBe('http://10.1.1.20:18700');
    const mdns = fixtures.mdns.mock.results[1].value;
    mdns.emit('query', { questions: [{ name: state.hostname, type: 'A' }] });
    expect(mdns.respond.mock.calls[0][0].answers.map((answer: { data: string }) => answer.data)).toEqual(['10.1.1.20']);
    await manager.stop();
  });

  it('retains all IPv4 interfaces for a dual-stack wildcard listener', async () => {
    const state = await new LocalAccessManager().start({ host: '::', port: 18700, scheme: 'http' });
    expect(state.lanAddresses).toEqual(['192.168.1.20', '10.1.1.20']);
  });

  it('does not advertise unrelated IPv4 addresses for an IPv6-only bind', async () => {
    const state = await new LocalAccessManager().start({ host: '2001:db8::20', port: 443, scheme: 'https' });
    expect(state.interfaces).toEqual([]);
    expect(state.fallbackUrl).toBe('https://[2001:db8::20]');
    expect(fixtures.mdns).not.toHaveBeenCalled();
  });
});
