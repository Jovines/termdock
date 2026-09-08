// @vitest-environment jsdom
import { useEffect } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ request: vi.fn(), invalidate: vi.fn(), saved: vi.fn() }));
vi.mock('./browserIntegration', () => ({
  SECURE_STATE_EVENT: 'termdock:secure-state',
  preferDirectConnection: vi.fn(), connectionRoutes: () => [],
  connectDevice: vi.fn(), connectOpenService: vi.fn(), getIdentity: async () => ({ peerId: 'phone' }),
  currentSecureClient: () => ({ request: mocks.request, targetPeerId: 'service' }), currentEntryClient: () => undefined,
  getActiveClient: async () => ({ request: mocks.request, targetPeerId: 'service' }), savedConnection: mocks.saved,
  invalidateSecureTransport: mocks.invalidate,
}));
vi.mock('../../components/FederationAccess', () => ({ default: () => null }));
vi.mock('./SessionAccessView', () => ({ SessionAccessView: () => <div>Shared terminal</div> }));
vi.mock('../components/auth/LoginScreen', () => ({ LoginScreen: () => <div>Password login</div> }));
import { SecureAccessGate } from './SecureAccessGate';
const permitted = { type: 'result', id: 'permissions', fullService: true, grants: [{ actions: ['service:*'] }] };
beforeEach(() => {
  mocks.request.mockReset().mockResolvedValue(permitted); mocks.invalidate.mockReset();
  mocks.saved.mockReturnValue({ url: 'https://service.example', targetPeerId: 'service' });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('device authorization lifecycle', () => {
  it('rechecks access when a manually verified address restores the encrypted transport', async () => {
    mocks.request.mockRejectedValueOnce(new Error('Home network unavailable'));
    render(<SecureAccessGate><div>Active terminal</div></SecureAccessGate>);
    await screen.findByText('正在重新连接，登录信息已保留…');
    fireEvent(window, new Event('termdock:secure-state'));
    await screen.findByText('Active terminal');
    expect(mocks.invalidate).not.toHaveBeenCalled();
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
    await screen.findByText('正在重新连接，登录信息已保留…');
    expect(screen.queryByText('Password login')).toBeNull();
    fireEvent(window, new Event('online'));
    await screen.findByText('Active terminal'); expect(mocks.invalidate).toHaveBeenCalledOnce();
  });
  it('replaces a suspended transport after unlock while retaining device authorization', async () => {
    let visibility: DocumentVisibilityState = 'visible', now = 1000;
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    render(<SecureAccessGate><div>Active terminal</div></SecureAccessGate>);
    await screen.findByText('Active terminal');
    visibility = 'hidden'; fireEvent(document, new Event('visibilitychange'));
    now += 30_000; visibility = 'visible'; fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
    expect(mocks.invalidate).toHaveBeenCalledOnce();
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
