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
  it('previews custom sharing appearance, retains it when editing and resets to the Session defaults', async () => {
    const onCreateInvite = vi.fn().mockResolvedValue({ url: inviteUrl, expiresAt: Date.now() + 600000 });
    render(<FederationAccess paired initialShareSessionId="stable" sessions={[{ sessionId: 'backend', sourceSessionId: 'stable', name: '原会话' }]} onConnect={() => {}} onClose={() => {}} onCreateInvite={onCreateInvite} />);
    fireEvent.change(screen.getByRole('textbox', { name: '分享显示名称' }), { target: { value: '研究工作台' } });
    fireEvent.click(screen.getByRole('button', { name: '更改原会话的分享图标' }));
    fireEvent.change(screen.getByRole('textbox', { name: '原会话的自定义Emoji' }), { target: { value: '🎙️' } });
    fireEvent.click(screen.getByRole('button', { name: '生成邀请' }));
    await waitFor(() => expect(onCreateInvite).toHaveBeenCalledWith(expect.objectContaining({ sessionAppearance: { stable: { name: '研究工作台', icon: '🎙️' } } })));
    expect(await screen.findByText('研究工作台')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '调整分享内容 / 重新生成' }));
    expect((screen.getByRole('textbox', { name: '分享显示名称' }) as HTMLInputElement).value).toBe('研究工作台');
    fireEvent.click(screen.getByRole('button', { name: '重置原会话的分享外观' }));
    fireEvent.click(screen.getByRole('button', { name: '生成邀请' }));
    await waitFor(() => expect(onCreateInvite).toHaveBeenCalledTimes(2));
    expect(onCreateInvite.mock.calls[1][0].sessionAppearance).toBeUndefined();
  });
  it('confirms revoking the generated invitation and removes its QR and link only on success', async () => {
    const onCreateInvite = vi.fn().mockResolvedValue({ id: 'pending-one', url: inviteUrl, expiresAt: Date.now() + 600000 });
    const onRevokeInvitation = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    render(<FederationAccess paired onConnect={() => {}} onClose={() => {}} onCreateInvite={onCreateInvite} onRevokeInvitation={onRevokeInvitation} />);
    fireEvent.click(screen.getByText('邀请设备')); if (screen.queryByRole('button', { name: '全部终端' }) && !screen.queryByRole('button', { name: /已选 [1-9]/ })) fireEvent.click(screen.getByRole('button', { name: '全部终端' }));
    fireEvent.click(screen.getByText('生成邀请'));
    fireEvent.click(await screen.findByRole('button', { name: '撤销邀请' }));
    expect(onRevokeInvitation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByText('复制邀请链接')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '撤销邀请' }));
    fireEvent.click(screen.getByRole('button', { name: '确认撤销邀请' }));
    await screen.findByRole('alert');
    expect(screen.getByText('复制邀请链接')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认撤销邀请' }));
    await screen.findByText('邀请已撤销，原链接和二维码已失效。');
    expect(onRevokeInvitation).toHaveBeenLastCalledWith('pending-one');
    expect(screen.queryByText('复制邀请链接')).toBeNull();
    expect(screen.queryByAltText('设备邀请二维码')).toBeNull();
  });
  it('lists a pending session invitation after reopening device management', async () => {
    const onRevokeInvitation = vi.fn().mockResolvedValue(undefined);
    render(<FederationAccess paired onConnect={() => {}} onClose={() => {}} onRevokeInvitation={onRevokeInvitation} sessions={[{ sessionId: 'backend-one', sourceSessionId: 'stable-one', name: '构建任务' }]} invitations={[
      { id: 'pending', scope: { kind: 'sessions', sessionIds: ['stable-one'] }, actions: ['session.view', 'session.input'], createdAt: Date.now(), invitationExpiresAt: Date.now() + 600000 },
    ]} />);
    fireEvent.click(screen.getByRole('tab', { name: /设备/ }));
    expect(screen.getByText('可操作 · 构建任务')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '撤销邀请' }));
    fireEvent.click(screen.getByRole('button', { name: '确认撤销邀请' }));
    await waitFor(() => expect(onRevokeInvitation).toHaveBeenCalledWith('pending'));
  });
  it('revokes only the chosen session authorization from device details', async () => {
    const onRevoke = vi.fn().mockResolvedValue(undefined);
    render(<FederationAccess paired currentIdentity="owner" onConnect={() => {}} onClose={() => {}} onRevoke={onRevoke} sessions={[{ sessionId: 'backend-one', sourceSessionId: 'stable-one', name: '构建任务' }]} grants={[
      { id: 'session-write', subjectId: 'phone', scope: { kind: 'sessions', sessionIds: ['stable-one'] }, actions: ['session.view', 'session.input'] },
      { id: 'other-read', subjectId: 'phone', scope: { kind: 'sessions', sessionIds: ['two'] }, actions: ['session.view'] },
    ]} />);
    fireEvent.click(screen.getByRole('tab', { name: /设备/ }));
    fireEvent.click(screen.getByRole('button', { name: '授权详情' }));
    expect(screen.getByText('构建任务')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: '撤销此项授权' })[0]);
    expect(onRevoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认撤销此项授权' }));
    await waitFor(() => expect(onRevoke).toHaveBeenCalledExactlyOnceWith('session-write'));
  });
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
    fireEvent.click(screen.getByRole('button', { name: /选择终端|已选/ }));
    fireEvent.click(screen.getByLabelText('构建任务'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole('radio', { name: /可操作/ }) as HTMLInputElement).checked).toBe(true);
    if (screen.queryByRole('button', { name: '全部终端' }) && !screen.queryByRole('button', { name: /已选 [1-9]/ })) fireEvent.click(screen.getByRole('button', { name: '全部终端' }));
    fireEvent.click(screen.getByText('生成邀请'));
    await waitFor(() => expect(onCreateInvite).toHaveBeenCalledWith({ viewMode: 'chat', scope: { kind: 'sessions', sessionIds: ['one'] }, actions: ['session.view', 'session.input', 'session.resize'] }));
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
    if (screen.queryByRole('button', { name: '全部终端' }) && !screen.queryByRole('button', { name: /已选 [1-9]/ })) fireEvent.click(screen.getByRole('button', { name: '全部终端' }));
    fireEvent.click(screen.getByText('生成邀请'));
    await waitFor(() => expect(onCreateInvite).toHaveBeenCalledWith({ viewMode: 'chat', scope: { kind: 'service' }, actions: ['session.view'] }));
    await waitFor(() => expect(screen.getByText('复制邀请链接')).toBeTruthy());
    expect(localStorage.getItem('termdock.federation.connections.v1')).toBeNull();
  });
  it('selects actual named Sessions and keeps termination out of normal write access', async () => {
    const onCreateInvite = vi.fn().mockResolvedValue({ url: inviteUrl, expiresAt: Date.now() + 600000 });
    render(<FederationAccess paired onConnect={() => {}} onClose={() => {}} onCreateInvite={onCreateInvite} sessions={[{ sessionId: 'backend-1', name: '构建任务' }, { sessionId: 'backend-2', name: '代码审查' }]} />);
    fireEvent.click(screen.getByText('邀请设备')); fireEvent.click(screen.getByRole('radio', { name: /可操作/ }));
    fireEvent.click(screen.getByRole('button', { name: /选择终端|已选/ }));
    if (!(screen.getByLabelText('构建任务') as HTMLInputElement).checked) fireEvent.click(screen.getByLabelText('构建任务')); fireEvent.click(screen.getByRole('button', { name: '使用所选终端（1）' })); if (screen.queryByRole('button', { name: '全部终端' }) && !screen.queryByRole('button', { name: /已选 [1-9]/ })) fireEvent.click(screen.getByRole('button', { name: '全部终端' }));
    fireEvent.click(screen.getByText('生成邀请'));
    await waitFor(() => expect(onCreateInvite).toHaveBeenCalledWith({ viewMode: 'chat', scope: { kind: 'sessions', sessionIds: ['backend-1'] }, actions: ['session.view', 'session.input', 'session.resize'] }));
  });
  it('uses service wildcard only when explicitly selected', async () => {
    const onCreateInvite = vi.fn().mockResolvedValue({ url: inviteUrl, expiresAt: Date.now() + 600000 });
    render(<FederationAccess paired onConnect={() => {}} onClose={() => {}} onCreateInvite={onCreateInvite} />);
    fireEvent.click(screen.getByText('邀请设备')); fireEvent.click(screen.getByText('有效期与备注')); fireEvent.click(screen.getByRole('checkbox', { name: '授予完整服务权限' })); if (screen.queryByRole('button', { name: '全部终端' }) && !screen.queryByRole('button', { name: /已选 [1-9]/ })) fireEvent.click(screen.getByRole('button', { name: '全部终端' }));
    fireEvent.click(screen.getByText('生成邀请'));
    await waitFor(() => expect(onCreateInvite).toHaveBeenCalledWith({ viewMode: 'chat', scope: { kind: 'service' }, actions: ['service:*'] }));
  });
  it('grants the stable client session id for a selected session so a backend replacement keeps it valid', async () => {
    const onCreateInvite = vi.fn().mockResolvedValue({ url: inviteUrl, expiresAt: Date.now() + 600000 });
    render(<FederationAccess paired onConnect={() => {}} onClose={() => {}} onCreateInvite={onCreateInvite} sessions={[{ sessionId: 'backend-1', sourceSessionId: 'stable-1', name: '构建任务' }]} />);
    fireEvent.click(screen.getByText('邀请设备'));
    fireEvent.click(screen.getByRole('radio', { name: /可操作/ }));
    fireEvent.click(screen.getByRole('button', { name: /选择终端|已选/ }));
    expect((screen.getByLabelText('构建任务') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '使用所选终端（1）' }));
    if (screen.queryByRole('button', { name: '全部终端' }) && !screen.queryByRole('button', { name: /已选 [1-9]/ })) fireEvent.click(screen.getByRole('button', { name: '全部终端' }));
    fireEvent.click(screen.getByText('生成邀请'));
    await waitFor(() => expect(onCreateInvite).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: 'sessions', sessionIds: ['stable-1'] } })));
  });
  it('lets the inviter pick an accessible IP entry address for the invitation', async () => {
    const onCreateInvite = vi.fn().mockResolvedValue({ url: inviteUrl, expiresAt: Date.now() + 600000 });
    render(<FederationAccess paired currentServiceOrigin="https://dv4d.termdock.local:9834" onConnect={() => {}} onClose={() => {}} onCreateInvite={onCreateInvite} inviteAddresses={[{ url: 'https://192.168.1.23:9834', label: 'Wi-Fi' }]} />);
    fireEvent.click(screen.getByText('邀请设备'));
    fireEvent.click(screen.getByText('接入地址'));
    expect(screen.getByRole('radio', { name: /当前地址/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Wi-Fi/ }));
    if (screen.queryByRole('button', { name: '全部终端' }) && !screen.queryByRole('button', { name: /已选 [1-9]/ })) fireEvent.click(screen.getByRole('button', { name: '全部终端' }));
    fireEvent.click(screen.getByText('生成邀请'));
    await waitFor(() => expect(onCreateInvite).toHaveBeenCalledWith(expect.objectContaining({ entryAddress: 'https://192.168.1.23:9834' })));
  });
  it('validates a manually entered entry address before generating the invitation', async () => {
    const onCreateInvite = vi.fn().mockResolvedValue({ url: inviteUrl, expiresAt: Date.now() + 600000 });
    render(<FederationAccess paired onConnect={() => {}} onClose={() => {}} onCreateInvite={onCreateInvite} inviteAddresses={[{ url: 'https://192.168.1.23:9834', label: 'Wi-Fi' }]} />);
    fireEvent.click(screen.getByText('邀请设备'));
    fireEvent.click(screen.getByText('接入地址'));
    fireEvent.click(screen.getByRole('radio', { name: /自定义地址/ }));
    fireEvent.change(screen.getByPlaceholderText('例如：https://192.168.1.23:9834'), { target: { value: 'ftp://192.168.1.23' } });
    if (screen.queryByRole('button', { name: '全部终端' }) && !screen.queryByRole('button', { name: /已选 [1-9]/ })) fireEvent.click(screen.getByRole('button', { name: '全部终端' }));
    fireEvent.click(screen.getByText('生成邀请'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('接入地址'));
    expect(onCreateInvite).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText('例如：https://192.168.1.23:9834'), { target: { value: 'https://10.0.0.8:9834' } });
    if (screen.queryByRole('button', { name: '全部终端' }) && !screen.queryByRole('button', { name: /已选 [1-9]/ })) fireEvent.click(screen.getByRole('button', { name: '全部终端' }));
    fireEvent.click(screen.getByText('生成邀请'));
    await waitFor(() => expect(onCreateInvite).toHaveBeenCalledWith(expect.objectContaining({ entryAddress: 'https://10.0.0.8:9834' })));
  });
});

it('always offers a custom invite address and warns that localhost is local to one computer', async () => {
  const onCreateInvite = vi.fn().mockResolvedValue({ url: inviteUrl, expiresAt: Date.now() + 600000 });
  render(<FederationAccess paired currentServiceOrigin="https://localhost:9881" onConnect={() => {}} onClose={() => {}} onCreateInvite={onCreateInvite} />);
  fireEvent.click(screen.getByText('邀请设备'));
  const disclosure = screen.getByText('接入地址').closest('details')!; disclosure.open = true;
  expect(disclosure.textContent).toContain('localhost:9881');
  expect(disclosure.textContent).toContain('当前地址仅供这台电脑使用');
  fireEvent.click(screen.getByRole('radio', { name: /自定义地址/ }));
  fireEvent.change(screen.getByPlaceholderText('例如：https://192.168.1.23:9834'), { target: { value: 'https://[::1]:9881' } });
  fireEvent.click(screen.getByRole('button', { name: '全部终端' }));
  fireEvent.click(screen.getByRole('button', { name: '生成邀请' }));
  await waitFor(() => expect(onCreateInvite).toHaveBeenCalledWith({ viewMode: 'chat', entryAddress: 'https://[::1]:9881', scope: { kind: 'service' }, actions: ['session.view'] }));
});
