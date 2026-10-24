// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ list: vi.fn(), prepare: vi.fn(), inspect: vi.fn() }));
vi.mock('../../lib/federation/browserIntegration', () => ({ listRelayTargets: mocks.list, prepareRelayConnection: mocks.prepare, inspectConnectionAccess: mocks.inspect }));
import { DeviceAuthorizationRequired } from '../../lib/federation/deviceAuthorization';
import { RelayServices } from './RelayServices';
const intent = { url: 'https://c.internal', targetPeerId: 'C', serviceName: 'C', routes: [{ url: 'https://b.internal', targetPeerId: 'B' }] };
const service = { id: 'B', targetPeerId: 'B', url: 'https://b.internal', label: 'B' };
beforeEach(() => {
  mocks.list.mockResolvedValue({ route: intent.routes[0], canManage: true, items: [{ serviceId: 'C', url: intent.url, available: true, authorized: false }] });
  mocks.prepare.mockResolvedValue(intent);
  mocks.inspect.mockResolvedValue('authorized');
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe('browse services through an entry', () => {
  it('shows a mismatched registration as disabled with its target identity and the repair reason', async () => {
    mocks.list.mockResolvedValue({ route: intent.routes[0], canManage: true, items: [{ serviceId: '12D3KooWAAAAabcdefgh', url: service.url, available: false, authorized: false, error: 'TARGET_IDENTITY_MISMATCH' }] });
    const connect = vi.fn();
    render(<RelayServices service={service} onBusyChange={() => {}} onConnect={connect} />);
    const row = await screen.findByRole('button', { name: /服务身份与登记地址不一致/ });
    expect((row as HTMLButtonElement).disabled).toBe(true);
    expect(row.textContent).toContain('AAAAabcdefgh');
    fireEvent.click(row); expect(connect).not.toHaveBeenCalled();
  });
  it('distinguishes reverse-only services by the varying ID suffix, rather than the common ID prefix', async () => {
    mocks.list.mockResolvedValue({ route: intent.routes[0], canManage: true, items: [
      { serviceId: '12D3KooWAAAAAAAA', available: true, authorized: true },
      { serviceId: '12D3KooWBBBBBBBB', available: true, authorized: true },
    ] });
    render(<RelayServices service={service} onBusyChange={() => {}} onConnect={() => {}} />);
    await screen.findByText('中转服务 AAAAAAAA');
    await screen.findByText('中转服务 BBBBBBBB');
  });
  it('keeps target login inside the relay flow and clears rejected passwords for retry', async () => {
    const connect = vi.fn().mockRejectedValue(new DeviceAuthorizationRequired());
    const login = vi.fn().mockRejectedValueOnce(new Error('目标密码错误')).mockResolvedValueOnce(undefined);
    render(<RelayServices service={service} onBusyChange={() => {}} onConnect={connect} onConnectWithPassword={login} />);
    fireEvent.click(await screen.findByRole('button', { name: /c.internal/ }));
    await screen.findByLabelText('目标服务密码');
    expect(connect).toHaveBeenCalledWith(intent);
    fireEvent.change(screen.getByLabelText('目标服务密码'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: '登录并连接' }));
    await screen.findByText('目标密码错误');
    expect((screen.getByLabelText('目标服务密码') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('目标服务密码'), { target: { value: 'correct' } });
    fireEvent.click(screen.getByRole('button', { name: '登录并连接' }));
    await act(async () => {});
    expect(login).toHaveBeenLastCalledWith(intent, 'correct');
  });
  it('discards a stale directory result after changing entries', async () => {
    let resolve!: (result: unknown) => void;
    mocks.list.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const view = render(<RelayServices service={service} onBusyChange={() => {}} onConnect={() => {}} />);
    view.rerender(<RelayServices service={{ ...service, id: 'D', url: 'https://d.internal' }} onBusyChange={() => {}} onConnect={() => {}} />);
    await screen.findByRole('button', { name: /c.internal/ });
    await act(async () => resolve({ canManage: true, items: [{ serviceId: 'hidden', url: 'https://stale.internal', available: true }] }));
    expect(screen.queryByText('stale.internal')).toBeNull();
  });
  it('can retry a failed listing and cancels target login without connecting', async () => {
    mocks.list.mockRejectedValueOnce(new Error('入口离线'));
    const connect = vi.fn().mockRejectedValue(new DeviceAuthorizationRequired());
    const login = vi.fn();
    render(<RelayServices service={service} onBusyChange={() => {}} onConnect={connect} onConnectWithPassword={login} />);
    await screen.findByText('入口离线');
    fireEvent.click(screen.getByRole('button', { name: '刷新列表' }));
    fireEvent.click(await screen.findByRole('button', { name: /c.internal/ }));
    await screen.findByLabelText('目标服务密码');
    fireEvent.click(screen.getByRole('button', { name: '返回中转列表' }));
    await screen.findByRole('button', { name: /c.internal/ });
    expect(login).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('目标服务密码')).toBeNull();
  });
});

it('keeps a passwordless relay target visible and disabled with the configuration required to recover', async () => {
  mocks.list.mockResolvedValue({ route: intent.routes[0], canManage: true, items: [
    { serviceId: 'C', label: 'Mac', available: false, authorized: true, error: 'TARGET_PASSWORD_REQUIRED' },
  ] });
  const connect = vi.fn();
  render(<RelayServices service={service} onBusyChange={() => {}} onConnect={connect} />);
  const row = await screen.findByRole('button', { name: /Mac.*未配置有效访问密码/ });
  expect((row as HTMLButtonElement).disabled).toBe(true);
  expect(row.textContent).toContain('请让目标管理员先配置访问密码');
  expect(mocks.inspect).not.toHaveBeenCalled(); fireEvent.click(row); expect(connect).not.toHaveBeenCalled();
});

it('distinguishes entry access from missing device authorization before connecting a protected target', async () => {
  mocks.list.mockResolvedValue({ route: intent.routes[0], canManage: false, items: [
    { serviceId: 'C', label: 'Mac', available: true, authorized: true },
  ] });
  mocks.inspect.mockResolvedValue('passwordRequired');
  const connect = vi.fn();
  render(<RelayServices service={service} onBusyChange={() => {}} onConnect={connect} onConnectWithPassword={vi.fn()} />);
  const row = await screen.findByRole('button', { name: /此设备未获目标访问授权，请登录目标服务/ });
  fireEvent.click(row); await screen.findByLabelText('目标服务密码');
  expect(connect).not.toHaveBeenCalled();
  expect(mocks.inspect).toHaveBeenCalledWith(expect.objectContaining({ targetPeerId: 'C', entryServiceId: 'B', url: service.url }), expect.any(AbortSignal));
});
