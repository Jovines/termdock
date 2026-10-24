// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ inspect: vi.fn(), access: vi.fn(), authorize: vi.fn(), settings: vi.fn(), recovered: vi.fn() }));
vi.mock('./browserIntegration', () => ({
  inspectEntryRoute: mocks.inspect, authorizeEntryRoute: mocks.authorize,
  connectionRoutes: () => [], connectionAddresses: (target: { entryServiceId?: string; url: string }) => target.entryServiceId ? [] : [target.url], inspectConnectionAccess: mocks.access,
  addServiceAddress: vi.fn(), createEntryInvitation: vi.fn(), revokeEntryRoute: vi.fn(), saveServiceRoutes: vi.fn(),
}));
vi.mock('../components/auth/LoginScreen', () => ({ LoginScreen: (props: { serviceOrigin: string; onLoginSuccess: () => void }) => <div><span>{props.serviceOrigin}</span><button onClick={props.onLoginSuccess}>Submit target login</button></div> }));
import { AccessRecoveryScreen } from './AccessRecoveryScreen';
import { ConnectionAccessError } from './accessFailure';
const target = { url: 'https://devbox.example', targetPeerId: 'target', serviceName: 'Devbox' };
const route = { url: 'https://work.example', targetPeerId: 'entry' };
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  localStorage.setItem('termdock.federation.connections.v1', JSON.stringify([{ id: 'entry', ...route, label: '工作' }]));
  mocks.inspect.mockResolvedValue({ canManage: true, grants: [] }); mocks.authorize.mockResolvedValue(undefined); mocks.recovered.mockResolvedValue(undefined);
  mocks.access.mockResolvedValue('passwordRequired');
});
afterEach(cleanup);
const mount = (code: ConstructorParameters<typeof ConnectionAccessError>[0] = 'RELAY_AUTHORIZATION_REQUIRED') => render(<AccessRecoveryScreen target={target}
  failure={new ConnectionAccessError(code, { targetServiceId: 'target', entryServiceId: 'entry', entryUrl: route.url })} onSettings={mocks.settings} onRecovered={mocks.recovered} />);
describe('explicit recovery for the correct access boundary', () => {
  it('keeps the recovery layer below an opened settings dialog and outside keyboard input', async () => {
    const { container } = render(<AccessRecoveryScreen target={target} failure={new ConnectionAccessError('TARGET_AUTHORIZATION_REQUIRED')} onSettings={mocks.settings} onRecovered={mocks.recovered} settingsOpen />);
    expect((container.firstElementChild as HTMLElement).style.visibility).toBe('hidden');
    expect(container.firstElementChild?.hasAttribute('inert')).toBe(true);
    expect(screen.queryByRole('button', { name: '登录目标服务' })).toBeNull();
    expect(mocks.authorize).not.toHaveBeenCalled(); await act(async () => {});
  });
  it('shows the exact entry and target with neutral cause, writes nothing on mount or cancellation', async () => {
    mount(); await screen.findByText('通过“工作”连接“Devbox”需要中转授权');
    expect(mocks.inspect).not.toHaveBeenCalled(); expect(mocks.authorize).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(mocks.recovered).not.toHaveBeenCalled(); expect(mocks.authorize).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '重新授权' })).toBeNull();
  });
  it('reads before offering the exact route grant, then rechecks effective access after explicit confirmation', async () => {
    mount(); fireEvent.click(screen.getByRole('button', { name: '重新授权' }));
    await screen.findByRole('button', { name: '授权此设备并重新连接' });
    expect(mocks.authorize).not.toHaveBeenCalled();
    mocks.inspect.mockResolvedValueOnce({ canManage: true, grants: [] }).mockResolvedValue({ canManage: true, grants: [{ active: true }] });
    fireEvent.click(screen.getByRole('button', { name: '授权此设备并重新连接' }));
    await waitFor(() => expect(mocks.recovered).toHaveBeenCalledOnce());
    expect(mocks.authorize).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ targetPeerId: 'target' }), route);
    expect(mocks.inspect.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(mocks.authorize.mock.invocationCallOrder[0]);
  });
  it('does not reconnect just because a grant write returned success', async () => {
    mount(); fireEvent.click(screen.getByRole('button', { name: '重新授权' }));
    fireEvent.click(await screen.findByRole('button', { name: '授权此设备并重新连接' }));
    await waitFor(() => expect(mocks.authorize).toHaveBeenCalledOnce());
    await screen.findByRole('alert', { name: '' }).catch(() => undefined);
    expect(mocks.recovered).not.toHaveBeenCalled();
  });
  it('keeps an administrator denial and never escalates to an entry password or service grant', async () => {
    mocks.inspect.mockResolvedValue({ canManage: false, grants: [] }); mount();
    fireEvent.click(screen.getByRole('button', { name: '重新授权' }));
    await screen.findByText(/请让入口管理员授予此设备/);
    expect(screen.queryByRole('button', { name: '授权此设备并重新连接' })).toBeNull();
    expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.recovered).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消' })); expect(mocks.authorize).not.toHaveBeenCalled();
  });
  it('opens only the final target login after the user chooses it and rechecks after login', async () => {
    mount('TARGET_AUTHORIZATION_REQUIRED'); expect(screen.queryByText(target.url)).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: '登录目标服务' }));
    expect(screen.getByText(target.url)).toBeTruthy(); expect(screen.queryByText(route.url)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Submit target login' }));
    await waitFor(() => expect(mocks.recovered).toHaveBeenCalledOnce());
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
  it.each(['TARGET_IDENTITY_MISMATCH', 'PERMISSION_DENIED'] as const)('offers settings, never broad authorization, for %s', async code => {
    mount(code); fireEvent.click(screen.getByRole('button', { name: '查看连接设置' }));
    expect(mocks.settings).toHaveBeenCalledOnce(); expect(mocks.authorize).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '重新授权' })).toBeNull();
    expect(screen.queryByRole('button', { name: '登录目标服务' })).toBeNull();
    await act(async () => {});
  });
});

it('offers an invitation instead of a password for an unconfigured direct target, and explicitly rechecks authorization', async () => {
  mocks.access.mockResolvedValueOnce('invitationRequired').mockResolvedValue('authorized');
  mount('TARGET_AUTHORIZATION_REQUIRED');
  await screen.findByText(/目标服务未配置访问密码，且此设备尚未获得访问授权/);
  expect(screen.queryByRole('button', { name: '登录目标服务' })).toBeNull();
  expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.recovered).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '重新检查授权' }));
  fireEvent.click(await screen.findByRole('button', { name: '重新连接' }));
  await waitFor(() => expect(mocks.recovered).toHaveBeenCalledOnce());
});

it('passes the target identity and entry separately to login when no direct target address exists', async () => {
  const relayTarget = { ...target, url: route.url, entryServiceId: 'entry', routes: [route] };
  render(<AccessRecoveryScreen target={relayTarget} failure={new ConnectionAccessError('TARGET_AUTHORIZATION_REQUIRED', {
    targetServiceId: 'target', entryServiceId: 'entry', entryUrl: route.url,
  })} onSettings={mocks.settings} onRecovered={mocks.recovered} />);
  fireEvent.click(await screen.findByRole('button', { name: '登录目标服务' }));
  expect(screen.queryByText(route.url)).toBeNull();
  expect(mocks.access).toHaveBeenCalledWith(relayTarget, expect.any(AbortSignal));
});

it.each(['TARGET_PASSWORD_REQUIRED', 'TARGET_SECURITY_UPGRADE_REQUIRED'] as const)('shows the relay security block %s without offering a password or invitation bypass', async code => {
  mount(code);
  await screen.findByText('“Devbox”已禁用中转');
  expect(screen.queryByRole('button', { name: '登录目标服务' })).toBeNull();
  expect(screen.queryByRole('button', { name: '重新授权' })).toBeNull();
  expect(mocks.access).not.toHaveBeenCalled(); expect(mocks.authorize).not.toHaveBeenCalled();
});
