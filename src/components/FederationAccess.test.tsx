// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FederationAccess } from './FederationAccess';
import { createInviteLink } from '../lib/federation/inviteLink';
vi.mock('qrcode', () => ({ toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,cXI=') }));
const serviceId = '12D3KooW' + '1'.repeat(44);
const code = 'secret-invite-code'.repeat(3);
const inviteUrl = createInviteLink({ v: 1, serviceId, code, entryUrl: 'https://c.example', name: '工作电脑' });
afterEach(() => { cleanup(); localStorage.clear(); });
describe('FederationAccess invitation flow', () => {
  it('opens device details separately and saves a recognizable name', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    render(<FederationAccess paired onConnect={() => {}} onClose={() => {}} onRename={onRename} onRevoke={async () => {}} grants={[{ id: 'one', subjectId: 'other', scope: { kind: 'service' }, actions: ['session.view'] }]} />);
    fireEvent.click(screen.getByRole('tab', { name: /设备/ }));
    expect(screen.getByText('未命名设备')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '授权详情' }));
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByRole('heading', { name: '授权详情' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回设备' }));
    fireEvent.click(screen.getByRole('button', { name: '重命名 未命名设备' }));
    fireEvent.change(screen.getByRole('textbox', { name: '设备名称' }), { target: { value: '办公室电脑' } });
    fireEvent.click(screen.getByRole('button', { name: '保存名称' }));
    await waitFor(() => expect(onRename).toHaveBeenCalledWith('other', '办公室电脑'));
    await waitFor(() => expect(screen.getByRole('tablist')).toBeTruthy());
  });

  it('shows the current service once and separates device management from switching services', async () => {
    localStorage.setItem('termdock.federation.connections.v1', JSON.stringify([{ url: 'https://c.example', targetPeerId: serviceId, serviceName: '工作电脑' }]));
    render(<FederationAccess paired currentServiceId={serviceId} currentServiceName="工作电脑" currentIdentity="this-phone" onConnect={() => {}} onClose={() => {}} grants={[
      { id: 'mine', subjectId: 'this-phone', scope: { kind: 'service' }, actions: ['service:*'] },
      { id: 'old', subjectId: 'test-old', label: '旧测试设备', scope: { kind: 'service' }, actions: ['session.view'], revokedAt: 1 },
    ]} />);
    await screen.findByRole('button', { name: '当前服务 工作电脑' });
    expect(screen.getAllByText('工作电脑')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '连接' })).toBeNull();
    expect(screen.queryByText('此设备')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /设备/ }));
    expect(screen.getByText('此设备')).toBeTruthy();
    expect(screen.getByText('已失效的授权（1）').closest('details')?.open).toBe(false);
    expect(screen.queryByRole('button', { name: /撤销/ })).toBeNull();
  });
  it('groups a device grants and asks before revoking all its active access', async () => {
    const onRevoke = vi.fn().mockResolvedValue(undefined);
    render(<FederationAccess paired currentIdentity="this-phone" onConnect={() => {}} onClose={() => {}} onRevoke={onRevoke} grants={[
      { id: 'read', subjectId: 'other-device', label: '工作电脑', scope: { kind: 'service' }, actions: ['session.view'] },
      { id: 'write', subjectId: 'other-device', label: '工作电脑', scope: { kind: 'sessions', sessionIds: ['one'] }, actions: ['session.input'] },
    ]} />);
    fireEvent.click(screen.getByRole('tab', { name: /设备/ }));
    expect(screen.getAllByText('工作电脑')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '撤销 工作电脑 的访问权限' }));
    expect(onRevoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认撤销' }));
    await waitFor(() => expect(onRevoke).toHaveBeenCalledTimes(2));
    expect(onRevoke.mock.calls.map(call => call[0])).toEqual(['read', 'write']);
  });
  it('cancels terminal selection without changing the invitation draft or closing its parent', async () => {
    const onCreateInvite = vi.fn().mockResolvedValue({ url: inviteUrl, expiresAt: Date.now() + 600000 });
    const onClose = vi.fn();
    render(<FederationAccess paired onConnect={() => {}} onClose={onClose} onCreateInvite={onCreateInvite} sessions={[{ sessionId: 'one', name: '构建任务' }]} />);
    fireEvent.click(screen.getByText('邀请设备'));
    fireEvent.click(screen.getByRole('radio', { name: /可操作/ }));
    fireEvent.click(screen.getByRole('button', { name: '选择终端' }));
    fireEvent.click(screen.getByLabelText('构建任务'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole('radio', { name: /可操作/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByText('生成邀请'));
    await waitFor(() => expect(onCreateInvite).toHaveBeenCalledWith({ scope: { kind: 'service' }, actions: ['session.view', 'session.input', 'session.resize'] }));
  });
  it('shows one input and keeps identity, JSON and authorization forms out of first use', () => {
    render(<FederationAccess onConnect={() => {}} onClose={() => {}} currentIdentity="private-peer-id" onGrant={() => {}} />);
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.getByLabelText('服务地址或邀请链接')).toBeTruthy();
    expect(screen.queryByText('private-peer-id')).toBeNull();
    expect(screen.queryByLabelText('手动连接 JSON')).toBeNull();
    expect(screen.queryByText('邀请设备')).toBeNull();
  });
  it('accepts a named invitation with one button and no input', async () => {
    const onConnect = vi.fn().mockResolvedValue(undefined);
    const invitation = { url: 'https://c.example', targetPeerId: serviceId, pairingCode: code, serviceName: '工作电脑' };
    render(<FederationAccess onConnect={onConnect} onClose={() => {}} initialInvite={invitation} />);
    expect(screen.getByText('工作电脑')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByText('接受邀请'));
    await waitFor(() => expect(onConnect).toHaveBeenCalledWith(invitation));
  });
  it('takes trusted identity from invitation and never persists its secret', async () => {
    const onConnect = vi.fn().mockResolvedValue(undefined);
    render(<FederationAccess onConnect={onConnect} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('服务地址或邀请链接'), { target: { value: inviteUrl } });
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await waitFor(() => expect(onConnect).toHaveBeenCalledWith({ targetPeerId: serviceId, pairingCode: code, url: 'https://c.example', serviceOrigin: 'https://c.example', serviceName: '工作电脑' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已连接'));
    const saved = localStorage.getItem('termdock.federation.connections.v1');
    expect(saved || '').not.toContain(code); expect(saved || '').not.toContain('pairingCode');
  });
  it('does not save failed invitations or echo errors containing secrets', async () => {
    render(<FederationAccess onConnect={async () => { throw new Error(code); }} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('服务地址或邀请链接'), { target: { value: inviteUrl } });
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('无法连接'));
    expect(screen.getByRole('alert').textContent).not.toContain(code);
    expect(localStorage.getItem('termdock.federation.connections.v1')).toBeNull();
  });
  it('generates read-only invitations with no device identity entry', async () => {
    const onCreateInvite = vi.fn().mockResolvedValue({ url: inviteUrl, expiresAt: Date.now() + 600000 });
    render(<FederationAccess paired currentServiceName="工作电脑" onConnect={() => {}} onClose={() => {}} onCreateInvite={onCreateInvite} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByText('邀请设备'));
    fireEvent.click(screen.getByText('生成邀请'));
    await waitFor(() => expect(onCreateInvite).toHaveBeenCalledWith({ scope: { kind: 'service' }, actions: ['session.view'] }));
    await waitFor(() => expect(screen.getByText('复制邀请链接')).toBeTruthy());
    expect(localStorage.getItem('termdock.federation.connections.v1')).toBeNull();
  });
  it('selects actual named Sessions and keeps termination out of normal write access', async () => {
    const onCreateInvite = vi.fn().mockResolvedValue({ url: inviteUrl, expiresAt: Date.now() + 600000 });
    render(<FederationAccess paired onConnect={() => {}} onClose={() => {}} onCreateInvite={onCreateInvite} sessions={[{ sessionId: 'backend-1', name: '构建任务' }, { sessionId: 'backend-2', name: '代码审查' }]} />);
    fireEvent.click(screen.getByText('邀请设备')); fireEvent.click(screen.getByRole('radio', { name: /可操作/ }));
    fireEvent.click(screen.getByRole('button', { name: '选择终端' }));
    fireEvent.click(screen.getByLabelText('构建任务')); fireEvent.click(screen.getByRole('button', { name: '使用所选终端（1）' })); fireEvent.click(screen.getByText('生成邀请'));
    await waitFor(() => expect(onCreateInvite).toHaveBeenCalledWith({ scope: { kind: 'sessions', sessionIds: ['backend-1'] }, actions: ['session.view', 'session.input', 'session.resize'] }));
  });
  it('uses service wildcard only when explicitly selected', async () => {
    const onCreateInvite = vi.fn().mockResolvedValue({ url: inviteUrl, expiresAt: Date.now() + 600000 });
    render(<FederationAccess paired onConnect={() => {}} onClose={() => {}} onCreateInvite={onCreateInvite} />);
    fireEvent.click(screen.getByText('邀请设备')); fireEvent.click(screen.getByRole('radio', { name: /完整访问/ })); fireEvent.click(screen.getByText('生成邀请'));
    await waitFor(() => expect(onCreateInvite).toHaveBeenCalledWith({ scope: { kind: 'service' }, actions: ['service:*'] }));
  });
});
