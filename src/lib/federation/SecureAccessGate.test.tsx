// @vitest-environment jsdom
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => { const request = vi.fn(), fetch = vi.fn(); return { request, fetch, connect: vi.fn(), invalidate: vi.fn(), saved: vi.fn(), client: { request, fetch, targetPeerId: 'service' } }; });
vi.mock('./browserIntegration', () => ({
  SECURE_STATE_EVENT: 'termdock:secure-state',
  preferDirectConnection: vi.fn(), currentConnectionPath: () => 'direct', connectionRoutes: () => [],
  connectionAddresses: (item: { url: string; serviceOrigin?: string; targetPeerId: string; routes?: { url: string; targetPeerId: string }[] }) => [item.serviceOrigin || item.url, ...(item.routes || []).filter(route => route.targetPeerId === item.targetPeerId).map(route => route.url)],
  connectDevice: mocks.connect, connectOpenService: vi.fn(), getIdentity: async () => ({ peerId: 'phone' }),
  currentSecureClient: () => mocks.client, currentEntryClient: () => undefined,
  getActiveClient: async () => mocks.client, savedConnection: mocks.saved,
  invalidateSecureTransport: mocks.invalidate,
}));
vi.mock('./deviceAuthorization', async importOriginal => {
  const original = await importOriginal<typeof import('./deviceAuthorization')>();
  return { ...original, readDeviceAuthorization: (client: Parameters<typeof original.readDeviceAuthorization>[0], options: Parameters<typeof original.readDeviceAuthorization>[1]) => original.readDeviceAuthorization(client, { ...options, maxAgeMs: 0 }) };
});
vi.mock('../../components/FederationAccess', () => ({ default: () => <div>Service management</div> }));
vi.mock('./SessionAccessView', () => ({ SessionAccessView: () => <div>Shared terminal</div> }));
vi.mock('../components/auth/LoginScreen', () => ({ LoginScreen: () => <div>Password login</div> }));
import { SecureAccessGate } from './SecureAccessGate';
import { setConnectionRecovery, useConnectionRecovery } from './connectionRecovery';
import { consumeWorkspaceSession, installWorkspaceHost } from '../services/workspaceHost';
import { writeBrowserServices } from '../services/serviceDirectory';
import { openRemoteSession } from './remoteSession';
const permitted = { type: 'result', id: 'permissions', fullService: true, grants: [{ actions: ['service:*'] }] };
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); delete window.__termdockWorkspaceHost;
  setConnectionRecovery('ready');
  mocks.request.mockReset().mockResolvedValue(permitted); mocks.invalidate.mockReset(); mocks.connect.mockReset().mockResolvedValue(undefined);
  mocks.fetch.mockReset(); mocks.client = { request: mocks.request, fetch: mocks.fetch, targetPeerId: 'service' };
  mocks.saved.mockReturnValue({ url: 'https://service.example', targetPeerId: 'service' });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => { cleanup(); delete window.__termdockWorkspaceHost; delete window.termdockDesktop; vi.restoreAllMocks(); });
describe('remote session workspace navigation', () => {
  const entry = { id: 'entry', targetPeerId: 'entry', url: 'https://devbox.example', label: 'Devbox' };
  const remote = { id: 'remote', targetPeerId: 'remote', url: 'https://remote.internal', label: 'Remote', routes: [{ url: entry.url, targetPeerId: entry.targetPeerId }] };
  const open = (origin: string, id: string) => act(async () => { await openRemoteSession(`remote:${encodeURIComponent(origin)}:${encodeURIComponent(id)}`); });

  it('switches repeatedly back to an entry whose collaboration origin differs from its saved address, without a worker', async () => {
    writeBrowserServices([entry, remote]);
    mocks.saved.mockReturnValue(entry);
    const host = installWorkspaceHost(entry)!;
    mocks.fetch.mockImplementation(async () => Response.json({ services: [{ origin: 'https://devbox.internal', serviceId: 'entry' }] }));
    const unmounted = vi.fn();
    function Terminal() { useEffect(() => () => unmounted(), []); return <div>Active terminal</div>; }
    render(<SecureAccessGate><Terminal /></SecureAccessGate>);
    await screen.findByText('Active terminal');
    for (let round = 0; round < 2; round++) {
      await open(remote.url, `remote-session-${round}`);
      await waitFor(() => expect(host.snapshot().activeKey).toBe('remote'));
      expect(consumeWorkspaceSession('remote')).toBe(`remote-session-${round}`);
      await open('https://devbox.internal', `entry-session-${round}`);
      await waitFor(() => expect(host.snapshot().activeKey).toBe('root'));
      expect(consumeWorkspaceSession('entry')).toBe(`entry-session-${round}`);
      expect(screen.queryByText('Service management')).toBeNull();
    }
    expect(mocks.fetch).toHaveBeenCalledWith('/api/terminal/operations/collaboration-directory', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(mocks.connect).not.toHaveBeenCalled(); expect(unmounted).not.toHaveBeenCalled();
    expect(host.snapshot().items).toHaveLength(2);
  });

  it('does not mistake a relay address for the target service origin', async () => {
    writeBrowserServices([entry, remote]);
    const host = installWorkspaceHost(entry)!;
    host.activate(remote);
    render(<SecureAccessGate><div>Active terminal</div></SecureAccessGate>);
    await screen.findByText('Active terminal');
    await open(entry.url, 'back-to-entry');
    await waitFor(() => expect(host.snapshot().activeKey).toBe('root'));
    expect(consumeWorkspaceSession('entry')).toBe('back-to-entry');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('reads the native service directory even when an old preload cannot focus the session', async () => {
    window.termdockDesktop = { collaborationFocus: vi.fn().mockResolvedValue(false), serviceConnections: vi.fn().mockResolvedValue([remote]), saveServiceConnection: vi.fn() } as unknown as NonNullable<Window['termdockDesktop']>;
    render(<SecureAccessGate><div>Active terminal</div></SecureAccessGate>);
    await screen.findByText('Active terminal');
    await open(remote.url, 'native-session');
    await screen.findByText('Shared terminal');
    expect(mocks.connect).toHaveBeenCalledWith(expect.objectContaining({ targetPeerId: 'remote', routes: remote.routes, serviceName: 'Remote' }));
    expect(screen.queryByText('Service management')).toBeNull();
  });

  it.each(['unknown identity', 'disconnected'])('keeps the current workspace on %s without direct HTTP fallback', async failure => {
    writeBrowserServices([entry, remote]);
    const host = installWorkspaceHost(entry)!;
    if (failure === 'disconnected') mocks.fetch.mockRejectedValue(new Error('Encrypted connection unavailable'));
    else mocks.fetch.mockResolvedValue(Response.json({ services: [{ origin: 'https://unknown.internal', serviceId: 'unsaved' }] }));
    const directFetch = vi.spyOn(window, 'fetch');
    render(<SecureAccessGate><div>Active terminal</div></SecureAccessGate>);
    await screen.findByText('Active terminal');
    await open('https://unknown.internal', 'session');
    await screen.findByText('Service management');
    expect(host.snapshot().activeKey).toBe('root');
    expect(mocks.connect).not.toHaveBeenCalled(); expect(directFetch).not.toHaveBeenCalled();
    expect(screen.getByText('Active terminal')).toBeTruthy();
  });
});
describe('device authorization lifecycle', () => {
  it('does not claim retained authorization on a first offline visit', async () => {
    mocks.saved.mockReturnValue(undefined);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(<SecureAccessGate><div>Active terminal</div></SecureAccessGate>);
    await screen.findByText('You can continue signing in when the network returns.');
    expect(screen.queryByText('Saved service retained. Access will be checked after reconnecting.')).toBeNull();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('recovers after background suspension and clears the shared connection status without remounting content', async () => {
    const unmounted = vi.fn();
    function Content() { const status = useConnectionRecovery(); useEffect(() => () => unmounted(), []); return <div>{status}</div>; }
    render(<SecureAccessGate><Content /></SecureAccessGate>);
    await screen.findByText('ready');
    mocks.request.mockRejectedValueOnce(new Error('Secure connection closed'));
    fireEvent(document, new Event('visibilitychange'));
    await screen.findByText('reconnecting');
    expect(mocks.invalidate).toHaveBeenCalledOnce();
    fireEvent(window, new Event('pageshow'));
    await screen.findByText('ready');
    expect(unmounted).not.toHaveBeenCalled(); expect(screen.queryByText('Password login')).toBeNull();
  });
  it('keeps the current content when offline and automatically validates access when the network returns', async () => {
    function Content() { return <div>{useConnectionRecovery()}</div>; }
    let online = true;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
    render(<SecureAccessGate><Content /></SecureAccessGate>);
    await screen.findByText('ready');
    online = false; fireEvent(window, new Event('offline'));
    await screen.findByText('offline'); expect(screen.queryByText('Password login')).toBeNull();
    online = true; fireEvent(window, new Event('online'));
    await screen.findByText('ready');
  });
  it('rechecks access when a manually verified address restores the encrypted transport', async () => {
    mocks.request.mockRejectedValueOnce(new Error('Home network unavailable'));
    render(<SecureAccessGate><div>Active terminal</div></SecureAccessGate>);
    await screen.findByText('Saved service retained. Access will be checked after reconnecting.');
    fireEvent(window, new Event('termdock:secure-state'));
    await screen.findByText('Active terminal');
    expect(mocks.invalidate).toHaveBeenCalledOnce();
  });
  it('retains the mounted terminal on a transient foreground validation failure', async () => {
    const unmounted = vi.fn();
    function Terminal() { useEffect(() => () => unmounted(), []); return <div>Active terminal</div>; }
    render(<SecureAccessGate><Terminal /></SecureAccessGate>);
    await screen.findByText('Active terminal');
    mocks.request.mockRejectedValueOnce(new Error('Wi-Fi reconnecting'));
    fireEvent.focus(window);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Password login')).toBeNull();
    expect(screen.getByText('Active terminal')).toBeTruthy(); expect(unmounted).not.toHaveBeenCalled();
    fireEvent.focus(window);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(3));
    expect(screen.queryByText('Password login')).toBeNull();
  });
  it('retries a saved login after an initial network failure without asking for a password', async () => {
    mocks.request.mockRejectedValueOnce(new Error('offline'));
    render(<SecureAccessGate><div>Active terminal</div></SecureAccessGate>);
    await screen.findByText('Saved service retained. Access will be checked after reconnecting.');
    expect(screen.queryByText('Password login')).toBeNull();
    fireEvent(window, new Event('online'));
    await screen.findByText('Active terminal'); expect(mocks.invalidate).toHaveBeenCalledOnce();
  });
  it('verifies a healthy transport after unlock without disrupting it', async () => {
    let visibility: DocumentVisibilityState = 'visible', now = 1000;
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    render(<SecureAccessGate><div>Active terminal</div></SecureAccessGate>);
    await screen.findByText('Active terminal');
    visibility = 'hidden'; fireEvent(document, new Event('visibilitychange'));
    now += 30_000; visibility = 'visible'; fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(screen.queryByText('Password login')).toBeNull(); expect(screen.getByText('Active terminal')).toBeTruthy();
  });
  it('requires login only when the target confirms the device has no effective authorization', async () => {
    render(<SecureAccessGate><div>Active terminal</div></SecureAccessGate>);
    await screen.findByText('Active terminal');
    mocks.request.mockResolvedValue({ type: 'result', id: 'permissions', fullService: false, grants: [] });
    fireEvent.focus(window);
    await screen.findByText('Password login'); expect(screen.queryByText('Active terminal')).toBeNull();
  });
});
