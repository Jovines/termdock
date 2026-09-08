// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceManager } from './ServiceManager';
import { readBrowserServices, saveServiceConnection } from '../../lib/services/serviceDirectory';
afterEach(() => { cleanup(); localStorage.clear(); });
describe('shared service manager', () => {
  it('keeps newly added addresses when returning from routes and saving the service name', async () => {
    const service = { id: 'computer', targetPeerId: 'computer', url: 'https://home.example', label: 'Computer' };
    const routes = [{ url: 'https://office.example', targetPeerId: 'computer' }];
    await saveServiceConnection(service);
    render(<ServiceManager current={service} onAdd={async () => {}} onOpen={async () => {}} renderRoutes={item => <button onClick={() => void saveServiceConnection({ ...item, routes })}>Save test address</button>} />);
    fireEvent.click(await screen.findByRole('button', { name: '管理 Computer' }));
    fireEvent.click(screen.getByRole('button', { name: /备用连接/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save test address' }));
    await waitFor(() => expect(readBrowserServices()[0].routes).toEqual(routes));
    fireEvent.click(screen.getByRole('button', { name: '返回服务' }));
    fireEvent.change(screen.getByLabelText('服务名称'), { target: { value: 'My laptop' } });
    fireEvent.click(screen.getByRole('button', { name: '保存名称' }));
    await waitFor(() => expect(readBrowserServices()[0].label).toBe('My laptop'));
    expect(readBrowserServices()[0].routes).toEqual(routes);
  });
  it('asks for a password only after discovering it is required and clears it after an attempt', async () => {
    const onAdd = vi.fn().mockResolvedValueOnce({ passwordRequired: true }).mockRejectedValueOnce(new Error('密码不正确'));
    render(<ServiceManager initiallyAdding onAdd={onAdd} onOpen={async () => {}} />);
    expect(screen.queryByLabelText('服务密码')).toBeNull();
    fireEvent.change(screen.getByLabelText('服务地址或邀请链接'), { target: { value: 'https://office.example' } });
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await screen.findByLabelText('服务密码');
    expect(onAdd).toHaveBeenNthCalledWith(1, 'https://office.example', undefined);
    fireEvent.change(screen.getByLabelText('服务密码'), { target: { value: 'private-password' } });
    fireEvent.click(screen.getByRole('button', { name: '登录并连接' }));
    await screen.findByText('密码不正确');
    await waitFor(() => expect((screen.getByLabelText('服务密码') as HTMLInputElement).value).toBe(''));
    expect(onAdd).toHaveBeenNthCalledWith(2, 'https://office.example', 'private-password');
    expect(localStorage.length).toBe(0);
  });
});

it('saves an offline address without probing, opening, or retaining a password', async () => {
  localStorage.clear();
  const onAdd = vi.fn(), onOpen = vi.fn();
  render(<ServiceManager initiallyAdding onAdd={onAdd} onOpen={onOpen} />);
  fireEvent.change(screen.getByLabelText('服务地址或邀请链接'), { target: { value: 'offline.example:9834' } });
  fireEvent.click(screen.getByRole('button', { name: '仅保存，不连接' }));
  await waitFor(() => expect(readBrowserServices()).toEqual([{ id: 'https://offline.example:9834', url: 'https://offline.example:9834', label: 'offline.example:9834' }]));
  expect(onAdd).not.toHaveBeenCalled(); expect(onOpen).not.toHaveBeenCalled();
});
