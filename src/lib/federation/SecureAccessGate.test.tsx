// @vitest-environment jsdom
import { useEffect } from 'react';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {createInviteLink} from './inviteLink';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => { const request = vi.fn(), fetch = vi.fn(); return { request, fetch, connect: vi.fn(), retryDirect: vi.fn(), authenticate:vi.fn(), invalidate: vi.fn(), saved: vi.fn(), accessProps: {} as Record<string, any>, client: { request, fetch, targetPeerId: 'service',closed:false } }; });
vi.mock('./browserIntegration', () => ({
  SECURE_STATE_EVENT: 'termdock:secure-state',
  preferDirectConnection: vi.fn(), currentConnectionPath: () => 'direct', connectionRoutes: () => [],
  connectionAddresses: (item: { url: string; serviceOrigin?: string; targetPeerId: string; routes?: { url: string; targetPeerId: string }[] }) => [item.serviceOrigin || item.url, ...(item.routes || []).filter(route => route.targetPeerId === item.targetPeerId).map(route => route.url)],
  authenticateKnownConnection:mocks.authenticate,connectDevice: mocks.connect, connectOpenService: vi.fn(), getIdentity: async () => ({ peerId: 'phone' }),
  currentSecureClient: () => mocks.client, currentEntryClient: () => undefined,
  getActiveClient: async () => mocks.client, savedConnection: mocks.saved,
  invalidateSecureTransport: mocks.invalidate, pauseConnectionAccess: vi.fn(), resumeConnectionAccess: vi.fn(),
  retryDirectConnection: mocks.retryDirect,
}));
vi.mock('./deviceAuthorization', async importOriginal => {
  const original = await importOriginal<typeof import('./deviceAuthorization')>();
  return { ...original, readDeviceAuthorization: (client: Parameters<typeof original.readDeviceAuthorization>[0], options: Parameters<typeof original.readDeviceAuthorization>[1]) => original.readDeviceAuthorization(client, { ...options, maxAgeMs: 0 }) };
});
vi.mock('../../components/FederationAccess', () => ({ default: (props: Record<string, any>) => { mocks.accessProps = props; return <div>Service management<button onClick={props.onClose}>Close management</button></div>; } }));
vi.mock('./SessionAccessView', () => ({ SessionAccessView: () => <div>Shared terminal</div> }));
vi.mock('../components/auth/LoginScreen', () => ({ LoginScreen: (props: Record<string, any>) => <div>Password login<span>{props.serviceOrigin}</span><button disabled={!props.focusEnabled} onClick={props.onManageServices}>Manage before login</button></div> }));
import { SecureAccessGate } from './SecureAccessGate';
import { setConnectionRecovery, useConnectionRecovery } from './connectionRecovery';
import { consumeWorkspaceSession, installWorkspaceHost } from '../services/workspaceHost';
import { writeBrowserServices } from '../services/serviceDirectory';
import { openRemoteSession } from './remoteSession';
import { ConnectionAccessError } from './accessFailure';
const permitted = { type: 'result', id: 'permissions', fullService: true, grants: [{ actions: ['service:*'] }] };
it('keeps direct recovery available after relay denial, keeps terminal mounted and writes no permissions on cancel', async () => {
  const unmounted = vi.fn();
  function Terminal() { useEffect(() => () => unmounted(), []); return <textarea aria-label="terminal draft" defaultValue="retain draft" />; }
  render(<SecureAccessGate><Terminal /></SecureAccessGate>);
  await screen.findByLabelText('terminal draft');
  mocks.request.mockRejectedValue(new ConnectionAccessError('RELAY_AUTHORIZATION_REQUIRED', { entryServiceId: 'entry', entryUrl: 'https://entry.example', targetServiceId: 'service' }));
  fireEvent.focus(window); await screen.findByRole('button', { name: '重新授权' });
  const calls = mocks.request.mock.calls.length;
  for (let i = 0; i < 3; i++) { fireEvent.focus(window); fireEvent(window, new Event('online')); }
  await act(async () => {});
  expect(mocks.request).toHaveBeenCalledTimes(calls); expect(unmounted).not.toHaveBeenCalled();
  expect(mocks.retryDirect).toHaveBeenCalled();
  expect((screen.getByLabelText('terminal draft') as HTMLTextAreaElement).value).toBe('retain draft');
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(mocks.authenticate).not.toHaveBeenCalled(); expect(unmounted).not.toHaveBeenCalled();
});
it.each([false, true])('dismisses a relay failure after foreground direct recovery, including cancelled authorization (%s)', async cancel => {
  const unmounted = vi.fn();
  function Terminal() { useEffect(() => () => unmounted(), []); return <textarea aria-label="terminal draft" defaultValue="retain draft" />; }
  render(<SecureAccessGate><Terminal /></SecureAccessGate>);
  await screen.findByLabelText('terminal draft');
  mocks.request.mockRejectedValue(new ConnectionAccessError('RELAY_AUTHORIZATION_REQUIRED', { entryServiceId: 'entry', entryUrl: 'https://entry.example', targetServiceId: 'service' }));
  fireEvent.focus(window);
  await screen.findByRole('button', { name: '重新授权' });
  if (cancel) fireEvent.click(screen.getByRole('button', { name: '取消' }));
  mocks.retryDirect.mockImplementation(async () => { mocks.request.mockResolvedValue(permitted); return mocks.client; });
  fireEvent(window, new Event('online'));
  await waitFor(() => expect(screen.queryByLabelText('恢复服务访问')).toBeNull());
  expect(mocks.retryDirect).toHaveBeenCalled();
  expect(screen.getByLabelText('terminal draft').closest('[aria-hidden]')).toBeNull();
  expect((screen.getByLabelText('terminal draft') as HTMLTextAreaElement).value).toBe('retain draft');
  expect(unmounted).not.toHaveBeenCalled(); expect(mocks.authenticate).not.toHaveBeenCalled();
});
it('retries direct access after a relay failure without needing a foreground event or a PWA restart', async () => {
  mocks.request.mockRejectedValue(new ConnectionAccessError('RELAY_AUTHORIZATION_REQUIRED', { targetServiceId: 'service' }));
  mocks.retryDirect.mockImplementation(async () => { mocks.request.mockResolvedValue(permitted); return mocks.client; });
  render(<SecureAccessGate><div>Recovered terminal</div></SecureAccessGate>);
  await screen.findByLabelText('恢复服务访问');
  await screen.findByText('Recovered terminal');
  await waitFor(() => expect(screen.queryByLabelText('恢复服务访问')).toBeNull());
  expect(mocks.retryDirect).toHaveBeenCalledTimes(1); expect(mocks.authenticate).not.toHaveBeenCalled();
});
it('stops direct retries when the target confirms a login failure during relay recovery', async () => {
  mocks.request.mockRejectedValue(new ConnectionAccessError('RELAY_AUTHORIZATION_REQUIRED', { targetServiceId: 'service' }));
  mocks.retryDirect.mockRejectedValue(new ConnectionAccessError('TARGET_AUTHORIZATION_REQUIRED', { targetServiceId: 'service' }));
  render(<SecureAccessGate><div>Terminal</div></SecureAccessGate>);
  await screen.findByLabelText('恢复服务访问');
  fireEvent.focus(window);
  await screen.findByRole('button', { name: '登录目标服务' });
  const calls = mocks.retryDirect.mock.calls.length;
  fireEvent.focus(window); fireEvent(window, new Event('online'));
  await act(async () => {});
  expect(mocks.retryDirect).toHaveBeenCalledTimes(calls);
});
it.each(['TARGET_AUTHORIZATION_REQUIRED', 'TARGET_IDENTITY_MISMATCH'] as const)('keeps automatic recovery paused for %s', async code => {
  render(<SecureAccessGate><div>Terminal</div></SecureAccessGate>);
  await screen.findByText('Terminal');
  mocks.request.mockRejectedValue(new ConnectionAccessError(code, { targetServiceId: 'service' }));
  fireEvent.focus(window);
  await screen.findByLabelText('恢复服务访问');
  const calls = mocks.request.mock.calls.length;
  fireEvent.focus(window); fireEvent(window, new Event('online'));
  await act(async () => {});
  expect(mocks.request).toHaveBeenCalledTimes(calls); expect(mocks.retryDirect).not.toHaveBeenCalled();
});
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); delete window.__termdockWorkspaceHost;
  setConnectionRecovery('ready');
  mocks.request.mockReset().mockResolvedValue(permitted); mocks.invalidate.mockReset(); mocks.connect.mockReset().mockResolvedValue(undefined);
  mocks.retryDirect.mockReset().mockRejectedValue(new Error('Secure connection closed'));
  mocks.authenticate.mockReset().mockResolvedValue(undefined);mocks.fetch.mockReset(); mocks.client = { request: mocks.request, fetch: mocks.fetch, targetPeerId: 'service',closed:false };
  mocks.saved.mockReturnValue({ url: 'https://service.example', targetPeerId: 'service',closed:false });
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

  it('focuses the already-open desktop window by peer identity without connecting through the callers routes',async()=>{
    const focus=vi.fn(async(_id:string,peer?:string)=>peer==='remote'),openWindow=vi.fn();
    window.termdockDesktop={collaborationFocus:focus,openServiceConnection:openWindow,serviceConnections:vi.fn(async()=>[remote]),saveServiceConnection:vi.fn()} as unknown as NonNullable<Window['termdockDesktop']>;
    mocks.fetch.mockResolvedValue(Response.json({services:[{origin:'https://registered.internal',serviceId:'remote'}]}));
    render(<SecureAccessGate><div>Active terminal</div></SecureAccessGate>);await screen.findByText('Active terminal');
    await open('https://registered.internal','target-session');
    await waitFor(()=>expect(focus).toHaveBeenCalledWith('remote:https%3A%2F%2Fregistered.internal:target-session','remote'));
    expect(openWindow).not.toHaveBeenCalled();expect(mocks.connect).not.toHaveBeenCalled();expect(screen.queryByText('Service management')).toBeNull();
  });
  it('opens a missing desktop workspace then directs the session into that window without reusing the caller transport',async()=>{
    let opened=false;const focus=vi.fn(async(_id:string,peer?:string)=>opened&&peer==='remote');
    const openWindow=vi.fn(async()=>{opened=true;return {ok:true};});
    window.termdockDesktop={collaborationFocus:focus,openServiceConnection:openWindow,serviceConnections:vi.fn(async()=>[remote]),saveServiceConnection:vi.fn()} as unknown as NonNullable<Window['termdockDesktop']>;
    render(<SecureAccessGate><div>Active terminal</div></SecureAccessGate>);await screen.findByText('Active terminal');await open(remote.url,'target-session');
    await waitFor(()=>expect(openWindow).toHaveBeenCalledOnce());await waitFor(()=>expect(focus).toHaveBeenLastCalledWith('remote:https%3A%2F%2Fremote.internal:target-session','remote'));
    expect(mocks.connect).not.toHaveBeenCalled();expect(screen.queryByText('Service management')).toBeNull();
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
    await screen.findByText('“目标服务”需要重新登录');
    expect(screen.queryByText('Password login')).toBeNull();
    expect(screen.getByText('Active terminal').closest('[inert]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '登录目标服务' }));
    await screen.findByText('Password login');
  });
});

describe('entry recovery and invitation address contract', () => {
  it('loads and revokes pending invitations over the active secure client, including redemption races', async () => {
    const pending = { id: 'pending-session', scope: { kind: 'sessions', sessionIds: ['stable-one'] }, actions: ['session.view', 'session.input'], createdAt: Date.now(), invitationExpiresAt: Date.now() + 600000 };
    let pendingItems = [pending], canRevoke = true;
    mocks.request.mockImplementation(async (packet: { type: string }) => {
      if (packet.type === 'session-list') return { items: [] };
      if (packet.type === 'grants-list') return { grants: [], invitations: pendingItems };
      if (packet.type === 'route-access') return { grants: [] };
      if (packet.type === 'invite-create') { pendingItems = [pending]; return { invitationId: pending.id, code: 'b'.repeat(43), expiresAt: pending.invitationExpiresAt }; }
      if (packet.type === 'invite-revoke') { pendingItems = []; return { revoked: canRevoke }; }
      return permitted;
    });
    render(<SecureAccessGate><div>Active terminal</div></SecureAccessGate>);
    await screen.findByText('Active terminal');
    fireEvent(window, new Event('termdock:open-services'));
    await waitFor(() => expect(mocks.accessProps.invitations).toEqual([pending]));
    await act(async () => { await mocks.accessProps.onRevokeInvitation(pending.id); });
    expect(mocks.request).toHaveBeenCalledWith({ type: 'invite-revoke', invitationId: pending.id });
    expect(mocks.accessProps.invitations).toEqual([]);
    await act(async () => {
      const result = await mocks.accessProps.onCreateInvite({ scope: pending.scope, actions: pending.actions });
      expect(result.id).toBe(pending.id);
    });
    expect(mocks.accessProps.invitations).toEqual([pending]);
    canRevoke = false;
    await act(async () => { await expect(mocks.accessProps.onRevokeInvitation(pending.id)).rejects.toThrow('INVITATION_NOT_PENDING'); });
    expect(mocks.accessProps.invitations).toEqual([]);
  });
  it('offers management before first single-service login and returns without authorization', async () => {
    mocks.saved.mockReturnValue(undefined);
    render(<SecureAccessGate><div>Active terminal</div></SecureAccessGate>);
    await screen.findByText('Password login');
    expect(screen.getByText(location.origin)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Manage before login' }));
    await screen.findByText('Service management');
    expect((screen.getByRole('button', { name: 'Manage before login' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('Active terminal')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close management' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Manage before login' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText('Active terminal')).toBeNull();
  });
  it.each(['loopback-only', 'disabled', 'conflict', 'error', 'active'])('keeps current invite origin and recommends only published domain for %s', async status => {
    mocks.saved.mockReturnValue({ url: 'https://localhost:9881', serviceOrigin: 'https://localhost:9881', targetPeerId: 'service',closed:false });
    mocks.fetch.mockResolvedValue(Response.json({ localAccess: { status, url: 'https://computer.termdock.local:9881', interfaces: [] } }));
    mocks.request.mockImplementation(async (input: { type: string }) => input.type === 'invite-create' ? { code: 'b'.repeat(32), expiresAt: Date.now() + 600000 } : permitted);
    // A valid service ID is needed for the invitation format.
    mocks.client.targetPeerId = `12D3KooW${'a'.repeat(44)}`;
    render(<SecureAccessGate><div>Active terminal</div></SecureAccessGate>);
    await screen.findByText('Active terminal');
    fireEvent(window, new Event('termdock:open-services'));
    await screen.findByText('Service management');
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    await waitFor(() => expect(mocks.accessProps.inviteAddresses).toEqual(status === 'active' ? [{ url: 'https://computer.termdock.local:9881', label: '服务域名' }] : []));
    const { parseInviteLink } = await import('./inviteLink');
    const generated = await mocks.accessProps.onCreateInvite({ scope: { kind: 'service' }, actions: ['session.view'] });
    expect(parseInviteLink(generated.url).serviceOrigin).toBe('https://localhost:9881');
    const custom = await mocks.accessProps.onCreateInvite({ entryAddress: 'https://[::1]:9881', scope: { kind: 'service' }, actions: ['session.view'] });
    expect(parseInviteLink(custom.url).serviceOrigin).toBe('https://[::1]:9881');
    expect(mocks.fetch.mock.calls).toHaveLength(1); // No silent origin substitution request.
  });
});

describe('native target display without authorization side effects', () => {
  it.each([
    { url: 'https://entry.example', serviceOrigin: 'https://target.example', label: 'Actual target' },
    { url: 'http://127.0.0.1:9834', label: 'This machine' },
  ])('shows the original target $label before URL-only password authorization', async native => {
    vi.resetModules(); mocks.saved.mockReturnValue(undefined);
    window.termdockDesktop = { getServiceConnection: vi.fn().mockResolvedValue(native) } as unknown as NonNullable<Window['termdockDesktop']>;
    const { SecureAccessGate: Gate } = await import('./SecureAccessGate');
    render(<Gate><div>Terminal</div></Gate>);
    await screen.findByText('Password login');
    expect(screen.getByText(native.serviceOrigin || native.url)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Manage before login' }));
    await screen.findByText('Service management');
    expect(mocks.accessProps.currentServiceOrigin).toBe(native.serviceOrigin || native.url);
    expect(mocks.accessProps.currentServiceName).toBe(native.label);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('keeps the old browser display when no native bridge exists', async () => {
    vi.resetModules(); mocks.saved.mockReturnValue(undefined);
    const { SecureAccessGate: Gate } = await import('./SecureAccessGate');
    render(<Gate><div>Terminal</div></Gate>);
    await screen.findByText('Password login');
    expect(screen.getByText(location.origin)).toBeTruthy();
  });
  it('ignores the unmounted component native promise when a new window target is shown', async () => {
    vi.resetModules(); mocks.saved.mockReturnValue(undefined);
    let finish!: (value: unknown) => void;
    window.termdockDesktop = { getServiceConnection: () => new Promise(resolve => { finish = resolve; }) } as unknown as NonNullable<Window['termdockDesktop']>;
    const { SecureAccessGate: Gate } = await import('./SecureAccessGate');
    const old = render(<Gate><div>Terminal</div></Gate>); old.unmount();
    window.termdockDesktop = { getServiceConnection: async () => ({ url: 'https://new-window.example', label: 'New window' }) } as unknown as NonNullable<Window['termdockDesktop']>;
    render(<Gate><div>Terminal</div></Gate>);
    await screen.findByText('https://new-window.example');
    await act(async () => finish({ url: 'https://old-window.example', label: 'Old window' }));
    expect(screen.queryByText('https://old-window.example')).toBeNull();
    expect(screen.getByText('https://new-window.example')).toBeTruthy();
  });
  it.each([true, false])('does not overwrite a new target with a late native directory result (pinned=%s)', async pinned => {
    vi.resetModules(); mocks.saved.mockReturnValue(undefined);
    let finish!: (value: unknown) => void;
    window.termdockDesktop = { getServiceConnection: () => new Promise(resolve => { finish = resolve; }) } as unknown as NonNullable<Window['termdockDesktop']>;
    const { SecureAccessGate: Gate } = await import('./SecureAccessGate');
    render(<Gate><div>Terminal</div></Gate>);
    const newer = { url: 'https://new.example', serviceOrigin: 'https://new.example', serviceName: 'Newer target', ...(pinned ? { targetPeerId: 'new-target' } : {}) };
    mocks.saved.mockReturnValue(newer); mocks.request.mockResolvedValue({ type: 'result', fullService: false, grants: [] });
    await act(async () => finish({ url: 'https://stale.example', serviceOrigin: 'https://stale.example', label: 'Stale target', ...(pinned ? { targetPeerId: 'stale-target' } : {}) }));
    await screen.findByText('“Newer target”需要重新登录');
    fireEvent.click(screen.getByRole('button', { name: '登录目标服务' }));
    await screen.findByText('Password login');
    expect(screen.getByText(newer.url)).toBeTruthy(); expect(screen.queryByText('https://stale.example')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Manage before login' }));
    await screen.findByText('Service management');
    expect(mocks.accessProps.currentServiceName).toBe('Newer target');
  });
});


describe('actual Preview bridge invitation receipt after real Gate permission success',()=>{
 const peer='12D3KooW'+'a'.repeat(44),entry='12D3KooW'+'b'.repeat(44);
 const originalFetch=window.fetch,originalSocket=window.WebSocket;
 const invitation=createInviteLink({v:1,serviceId:peer,entryServiceId:entry,entryUrl:'https://entry.example',serviceUrl:'https://service.example',routeOnly:true,routeCode:'x'.repeat(32)});
 const source=fs.readFileSync('desktop-rust/renderer/bridge.js','utf8');
 function install(invite=invitation){
  window.fetch=originalFetch||vi.fn(async()=>Response.json({}));window.WebSocket=originalSocket;
  Object.assign(window,{__TD_PREVIEW_BOOT__:{origin:location.origin,origins:['https://entry.example','https://service.example'],defaultRoute:1,platform:'darwin',connection:{url:'https://entry.example',serviceOrigin:'https://service.example',targetPeerId:peer,entryServiceId:entry,label:'Owned'},invitation:invite},__TAURI_INTERNALS__:{invoke:async(_command:string,args:{op:string})=>args.op==='connections'?[]:{}}});
  vm.runInNewContext(source,{window,location,navigator,sessionStorage,Request,Response,URL,TypeError,Error,Uint8Array,TextEncoder,crypto:webcrypto,atob,Number,Promise,Object,Set,String,JSON,queueMicrotask});
 }
 beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);mocks.client.targetPeerId=peer;mocks.saved.mockReturnValue({url:'https://service.example',targetPeerId:peer});install();});
 afterEach(()=>{window.fetch=originalFetch;window.WebSocket=originalSocket;Reflect.deleteProperty(window,'__TAURI_INTERNALS__');vi.unstubAllGlobals();});
 it.each(['password','pairing'] as const)('%s callback acknowledges only after actual permissions and a new document still reads normal permissions',async entry=>{
  render(<SecureAccessGate><div>Owned terminal</div></SecureAccessGate>);await screen.findByText('Service management');
  expect(sessionStorage.getItem('termdock-secure-preview-invitation-v1')).toBeNull();
  await act(async()=>{if(entry==='password')await mocks.accessProps.onConnectWithPassword({},'controlled');else await mocks.accessProps.onConnect({url:'https://service.example',targetPeerId:peer,pairingCode:'controlled'});});await screen.findByText('Owned terminal');
  const marker=sessionStorage.getItem('termdock-secure-preview-invitation-v1')!;expect(marker).not.toContain(invitation);expect(JSON.parse(marker).fingerprint).toMatch(/^[a-f0-9]{64}$/);
  const reads=mocks.request.mock.calls.filter(([message])=>message.type==='permissions').length;expect(reads).toBeGreaterThan(0);
  cleanup();install();expect((await window.termdockDesktop!.getServiceConnection!())?.invitation).toBeUndefined();
  render(<SecureAccessGate><div>Restored terminal</div></SecureAccessGate>);await screen.findByText('Restored terminal');
  expect(mocks.request.mock.calls.filter(([message])=>message.type==='permissions').length).toBeGreaterThan(reads);expect(mocks.connect).toHaveBeenCalledTimes(entry==='pairing'?1:0);
 });
 it('failed permissions do not acknowledge the invitation',async()=>{
  render(<SecureAccessGate><div>Owned terminal</div></SecureAccessGate>);await screen.findByText('Service management');mocks.request.mockRejectedValue(new Error('Controlled denied'));
  await expect(mocks.accessProps.onConnectWithPassword({},'controlled')).rejects.toThrow();
  expect(sessionStorage.getItem('termdock-secure-preview-invitation-v1')).toBeNull();expect((await window.termdockDesktop!.getServiceConnection!())?.invitation).toBe(invitation);
 });
 it('ordinary pairing success before a failed permission read does not consume the original invitation stamp',async()=>{
  render(<SecureAccessGate><div>Owned terminal</div></SecureAccessGate>);await screen.findByText('Service management');mocks.request.mockRejectedValue(new Error('Controlled denied'));
  await expect(mocks.accessProps.onConnect({url:'https://service.example',targetPeerId:peer,pairingCode:'controlled'})).rejects.toThrow();
  expect(mocks.connect).toHaveBeenCalledTimes(1);expect(sessionStorage.getItem('termdock-secure-preview-invitation-v1')).toBeNull();expect((await window.termdockDesktop!.getServiceConnection!())?.invitation).toBe(invitation);
 });
 it.each(['client','target','page'] as const)('a late successful permission response cannot acknowledge after %s changes',async change=>{
  render(<SecureAccessGate><div>Owned terminal</div></SecureAccessGate>);await screen.findByText('Service management');let finish!:(value:typeof permitted)=>void;
  mocks.request.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));const pending=mocks.accessProps.onConnectWithPassword({},'controlled');await waitFor(()=>expect(finish).toBeTypeOf('function'));
  if(change==='client')mocks.client={...mocks.client,closed:true};else if(change==='target')mocks.saved.mockReturnValue({url:'https://other.example',targetPeerId:entry});else fireEvent(window,new Event('pagehide'));
  await act(async()=>{finish(permitted);await expect(pending).rejects.toThrow('SERVICE_SELECTION_CHANGED');});expect(sessionStorage.getItem('termdock-secure-preview-invitation-v1')).toBeNull();
 });
});
