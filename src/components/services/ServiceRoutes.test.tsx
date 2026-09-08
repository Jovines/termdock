// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock('../../lib/federation/browserIntegration', () => ({ connectionRoutes: () => [], addServiceAddress: mocks.add }));
vi.mock('../../lib/services/serviceDirectory', () => ({ listServiceConnections: async () => [] }));
import { ServiceRoutes } from './ServiceRoutes';
afterEach(() => { cleanup(); mocks.add.mockReset(); });
describe('manual backup address form', () => {
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
