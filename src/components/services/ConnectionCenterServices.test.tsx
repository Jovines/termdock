// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionCenterServices } from './ConnectionCenterServices';
import type { TermdockDesktopBridge } from '../../lib/desktop/nativeBridge';
import type { ServiceConnectionReview } from '../../lib/services/desktopServiceConnection';
import { createInviteLink } from '../../lib/federation/inviteLink';

afterEach(() => { cleanup(); localStorage.clear(); delete window.termdockDesktop; });
const certificateError = () => Object.assign(new Error('TLS rejected'), { code: 'PREVIEW_DISCOVERY_FAILED' });
const target = '12D3KooW' + 'a'.repeat(44), entry = '12D3KooW' + 'b'.repeat(44);
const connection = { id: target, url: 'https://entry.example', serviceOrigin: 'https://target.internal', targetPeerId: target, entryServiceId: entry, label: 'Remote', routes: [{ url: 'https://backup.example', targetPeerId: entry }] };
function fixture(initial: ServiceConnectionReview | null = null) {
  let pending = initial, notify = () => {};
  const native = {
    takeServiceConnectionReview: vi.fn(async () => { const next = pending; pending = null; return next; }),
    onServiceConnectionReview: vi.fn((callback: () => void) => { notify = callback; return () => { notify = () => {}; }; }),
    openServiceConnection: vi.fn().mockRejectedValueOnce(certificateError()).mockResolvedValue({ ok: true }),
    certificatePins: vi.fn().mockResolvedValue({}),
    inspectCertificate: vi.fn(async (origin: string) => ({ origin, fingerprint: 'a'.repeat(64), receipt: 'one-shot' })),
    trustCertificate: vi.fn().mockResolvedValue(undefined), discardCertificateInspection: vi.fn().mockResolvedValue(undefined), revokeCertificate: vi.fn(),
  } as unknown as TermdockDesktopBridge;
  return { native, deliver(request: ServiceConnectionReview) { pending = request; notify(); } };
}
it('receives a request queued before mount, checks the entry certificate, and retries the full saved route once', async () => {
  const f = fixture({ connection });
  render(<ConnectionCenterServices bridge={f.native} />);
  await screen.findByRole('region', { name: 'HTTPS 证书确认' });
  expect(f.native.inspectCertificate).toHaveBeenCalledExactlyOnceWith(connection.url);
  expect(screen.queryByRole('button', { name: '继续' })).toBeNull();
  expect(f.native.trustCertificate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: '信任此指纹并重试一次' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: '来自工作区的连接请求' })).toBeNull());
  expect(f.native.openServiceConnection).toHaveBeenNthCalledWith(1, connection, undefined);
  expect(f.native.openServiceConnection).toHaveBeenNthCalledWith(2, connection, undefined);
  expect(f.native.trustCertificate).toHaveBeenCalledExactlyOnceWith(connection.url, 'a'.repeat(64), 'one-shot');
});
it('preserves a center draft and clears the inspection receipt when a workspace request is cancelled', async () => {
  const f = fixture();
  render(<ConnectionCenterServices bridge={f.native} />);
  fireEvent.click(await screen.findByRole('button', { name: '添加服务' }));
  fireEvent.change(screen.getByLabelText('服务地址或邀请链接'), { target: { value: 'keep-my-draft.example' } });
  await act(async () => f.deliver({ connection }));
  await screen.findByRole('region', { name: 'HTTPS 证书确认' });
  fireEvent.click(screen.getByRole('button', { name: '返回服务' }));
  await waitFor(() => expect(f.native.discardCertificateInspection).toHaveBeenCalledWith('one-shot'));
  expect((screen.getByLabelText('服务地址或邀请链接') as HTMLInputElement).value).toBe('keep-my-draft.example');
  expect(f.native.trustCertificate).not.toHaveBeenCalled();
  expect(f.native.openServiceConnection).toHaveBeenCalledOnce();
});
it('retains the entire routed invitation and discards its review on cancel without persisting the secret', async () => {
  const invitation = createInviteLink({ v: 1, serviceId: target, entryServiceId: entry, entryUrl: connection.url, serviceUrl: connection.serviceOrigin, routeOnly: true, routeCode: 'd'.repeat(32) });
  const f = fixture({ connection, invitation });
  render(<ConnectionCenterServices bridge={f.native} />);
  const region = await screen.findByRole('region', { name: 'HTTPS 证书确认' });
  expect(f.native.openServiceConnection).toHaveBeenCalledExactlyOnceWith(connection, invitation);
  expect(f.native.inspectCertificate).toHaveBeenCalledWith(connection.url);
  fireEvent.click(within(region).getByRole('button', { name: '取消' }));
  expect(f.native.trustCertificate).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
});
