// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ client: { targetPeerId: 'service', request: vi.fn() } }));
vi.mock('../../federation/browserIntegration', () => ({ currentSecureClient: () => mocks.client }));
import { SessionSharingBadge } from './SessionSharingBadge';
afterEach(() => { cleanup(); mocks.client.request.mockReset(); });
it('offers a direct Session-only revoke and closes its interaction layer afterward', async () => {
  mocks.client.request.mockResolvedValue({ revoked: 1 }); const changed = vi.fn();
  render(<SessionSharingBadge status={{ sessionId: 'one', serviceId: 'service', devices: 2, connectedDevices: 1, invitations: 1 }} onChanged={changed} />);
  fireEvent.click(screen.getByRole('button', { name: /已共享/ })); expect(screen.getByText('当前 1 台设备连接 · 2 台已授权')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '停止共享此会话' })); await waitFor(() => expect(mocks.client.request).toHaveBeenCalledWith({ type: 'session-sharing-stop', sessionId: 'one' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '会话共享状态' })).toBeNull()); expect(changed).toHaveBeenCalledOnce();
});
