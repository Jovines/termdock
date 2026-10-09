// @vitest-environment jsdom
import { useEffect } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => { const request = vi.fn(); return { request, invalidate: vi.fn(), saved: vi.fn(), client: { request, targetPeerId: 'service' } }; });
vi.mock('./browserIntegration', () => ({
  SECURE_STATE_EVENT: 'termdock:secure-state',
  preferDirectConnection: vi.fn(), currentConnectionPath: () => 'direct', connectionRoutes: () => [],
  connectDevice: vi.fn(), connectOpenService: vi.fn(), getIdentity: async () => ({ peerId: 'phone' }),
  currentSecureClient: () => mocks.client, currentEntryClient: () => undefined,
  getActiveClient: async () => mocks.client, savedConnection: mocks.saved,
  invalidateSecureTransport: mocks.invalidate,
}));
vi.mock('./deviceAuthorization', async importOriginal => {
  const original = await importOriginal<typeof import('./deviceAuthorization')>();
  return { ...original, readDeviceAuthorization: (client: Parameters<typeof original.readDeviceAuthorization>[0], options: Parameters<typeof original.readDeviceAuthorization>[1]) => original.readDeviceAuthorization(client, { ...options, maxAgeMs: 0 }) };
});
vi.mock('../../components/FederationAccess', () => ({ default: () => null }));
vi.mock('./SessionAccessView', () => ({ SessionAccessView: () => <div>Shared terminal</div> }));
vi.mock('../components/auth/LoginScreen', () => ({ LoginScreen: () => <div>Password login</div> }));
import { SecureAccessGate } from './SecureAccessGate';
import { setConnectionRecovery, useConnectionRecovery } from './connectionRecovery';
const permitted = { type: 'result', id: 'permissions', fullService: true, grants: [{ actions: ['service:*'] }] };
beforeEach(() => {
  setConnectionRecovery('ready');
  mocks.request.mockReset().mockResolvedValue(permitted); mocks.invalidate.mockReset(); mocks.client = { request: mocks.request, targetPeerId: 'service' };
  mocks.saved.mockReturnValue({ url: 'https://service.example', targetPeerId: 'service' });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('device authorization lifecycle', () => {
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
    await screen.findByText('登录信息已保留');
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
    await screen.findByText('登录信息已保留');
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
