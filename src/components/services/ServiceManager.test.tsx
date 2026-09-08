// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceManager } from './ServiceManager';
afterEach(() => { cleanup(); localStorage.clear(); });
describe('shared service manager', () => {
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
