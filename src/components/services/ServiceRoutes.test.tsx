// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ add: vi.fn(), entries: vi.fn(async () => [] as any[]), inspect: vi.fn(), save: vi.fn(), revoke: vi.fn() }));
vi.mock('../../lib/federation/browserIntegration', () => ({ connectionRoutes: () => [], connectionAddresses: (entry: { url: string; routes?: { url: string }[] }) => [entry.url, ...(entry.routes || []).map(route => route.url)], addServiceAddress: mocks.add, inspectEntryRoute: mocks.inspect, saveServiceRoutes: mocks.save, revokeEntryRoute: mocks.revoke }));
vi.mock('../../lib/services/serviceDirectory', () => ({ listServiceConnections: mocks.entries }));
import { ServiceRoutes } from './ServiceRoutes';
afterEach(() => { cleanup(); mocks.add.mockReset(); mocks.entries.mockResolvedValue([]); mocks.inspect.mockReset(); mocks.save.mockReset(); mocks.revoke.mockReset(); });
describe('manual backup address form', () => {
  it('offers a second address of the same entry and preserves the first when enabling it', async () => {
    mocks.entries.mockResolvedValue([{ id: 'entry', targetPeerId: 'entry', label: 'Entry', url: 'https://entry-home.example', routes: [{ url: 'https://entry-office.example', targetPeerId: 'entry' }] }]);
    mocks.inspect.mockResolvedValue({ grants: [{ active: true }] });
    const first = { url: 'https://entry-home.example', targetPeerId: 'entry' };
    render(<ServiceRoutes service={{ id: 'computer', targetPeerId: 'computer', url: 'https://target.example', label: 'Laptop', routes: [first] }} onBusyChange={() => {}} />);
    const alternate = await screen.findByRole('button', { name: 'Entry https://entry-office.example' });
    fireEvent.click(alternate);
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(expect.anything(), [first, { url: 'https://entry-office.example', targetPeerId: 'entry' }]));
    expect(screen.getAllByRole('button', { name: '撤销授权' })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: '撤销授权' })[1]);
    expect(screen.getAllByRole('button', { name: '确认撤销' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '确认撤销' }));
    await waitFor(() => expect(mocks.save).toHaveBeenLastCalledWith(expect.anything(), []));
    expect(mocks.revoke).toHaveBeenCalledWith('computer', { url: 'https://entry-office.example', targetPeerId: 'entry' });
  });
  it('releases the parent busy state even if navigation unmounts a pending form', async () => {
    let finish!: (routes: []) => void;
    mocks.add.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const onBusy = vi.fn();
    const view = render(<ServiceRoutes service={{ id: 'computer', targetPeerId: 'computer', url: 'https://home.example', label: 'Laptop' }} onBusyChange={onBusy} />);
    fireEvent.change(screen.getByLabelText('备用地址'), { target: { value: 'https://office.example' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并添加' }));
    expect(onBusy).toHaveBeenLastCalledWith(true);
    expect((screen.getByLabelText('备用地址') as HTMLInputElement).disabled).toBe(true);
    view.unmount();
    await act(async () => finish([]));
    expect(onBusy).toHaveBeenLastCalledWith(false);
  });
  it('preserves the entered address after a verification failure and allows retry', async () => {
    mocks.add.mockRejectedValueOnce(new Error('无法验证这个地址。')).mockResolvedValueOnce([{ url: 'https://office.example', targetPeerId: 'computer' }]);
    render(<ServiceRoutes service={{ id: 'computer', targetPeerId: 'computer', url: 'https://home.example', label: 'Laptop' }} onBusyChange={() => {}} />);
    fireEvent.change(screen.getByLabelText('备用地址'), { target: { value: 'https://office.example' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并添加' }));
    await screen.findByRole('alert');
    expect((screen.getByLabelText('备用地址') as HTMLInputElement).value).toBe('https://office.example');
    fireEvent.click(screen.getByRole('button', { name: '验证并添加' }));
    await screen.findByText('备用地址已验证并保存。');
    await waitFor(() => expect((screen.getByLabelText('备用地址') as HTMLInputElement).value).toBe(''));
  });
});
