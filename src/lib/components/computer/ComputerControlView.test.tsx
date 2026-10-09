// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../i18n/zh';
import type { RdpConnection } from '../../computer/secureRdpTunnel';
import { computerLoginKey, defaultComputerPreferences, type ComputerPreferences } from '../../computer/preferences';
import ComputerControlView from './ComputerControlView';

const mocks = vi.hoisted(() => ({
  peer: 'ubuntu-service',
  platform: 'linux',
  clients: [] as Array<EventTarget & { sendKey: ReturnType<typeof vi.fn> }>,
  hosts: [] as string[],
  rdpOptions: [] as RdpConnection[],
  preferences: null as ComputerPreferences | null,
  writes: [] as ComputerPreferences[],
  failures: [] as Array<(reason: string) => void>,
  credentials: {} as Record<string, string>,
  credentialWrites: [] as string[],
}));
vi.mock('../../i18n', () => ({ useI18n: () => ({
  t: (key: string, params?: Record<string, string>) => {
    const text = zh.computer[key.split('.')[1] as keyof typeof zh.computer];
    return text.replace(/\{(\w+)\}/g, (match, name: string) => params?.[name] ?? match);
  },
}) }));
vi.mock('../../federation/browserIntegration', () => ({
  savedConnection: () => ({ targetPeerId: mocks.peer, serviceName: mocks.peer }),
  SECURE_STATE_EVENT: 'test-secure-state',
}));
vi.mock('../../services/workspaceHost', () => ({
  isWorkspaceActive: () => true, WORKSPACE_VISIBILITY_EVENT: 'test-workspace-visibility',
}));
vi.mock('../../computer/secureVncChannel', () => ({ SecureVncChannel: class {
  constructor(host: string) { mocks.hosts.push(host); }
  close() {}
} }));
vi.mock('@novnc/novnc', () => ({ default: class extends EventTarget {
  sendKey = vi.fn();
  disconnect() {}
  constructor() { super(); mocks.clients.push(this); }
} }));

vi.mock('../../computer/rdpSession', () => ({ RdpSession: class extends EventTarget {
  sendKey = vi.fn();
  disconnect() {}
  constructor(_target: HTMLElement, options: RdpConnection, fail: (reason: string) => void) {
    super(); mocks.clients.push(this); mocks.rdpOptions.push(options); mocks.failures.push(fail);
  }
} }));

beforeEach(() => {
  localStorage.clear();
  mocks.peer = 'ubuntu-service'; mocks.platform = 'linux';
  mocks.clients.length = 0; mocks.hosts.length = 0; mocks.rdpOptions.length = 0; mocks.failures.length = 0;
  mocks.preferences = null; mocks.writes = [];
  mocks.credentials = {}; mocks.credentialWrites = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes('/credentials/')) {
      const body = JSON.parse(String(options?.body)), key = computerLoginKey(body.profile);
      if (url.endsWith('/save')) { mocks.credentials[key] = body.password; mocks.credentialWrites.push(body.password); }
      if (url.endsWith('/forget')) delete mocks.credentials[key];
      return { ok: !url.endsWith('/use') || Boolean(mocks.credentials[key]), status: 404, json: async () => ({ password: mocks.credentials[key] }) };
    }
    if (url.endsWith('/preferences')) {
      if (options?.method === 'PUT') { mocks.preferences = JSON.parse(String(options.body)); mocks.writes.push(mocks.preferences!); }
      return { ok: true, json: async () => ({ preferences: mocks.preferences || defaultComputerPreferences(mocks.platform), configured: Boolean(mocks.preferences), credentialKeys: Object.keys(mocks.credentials) }) };
    }
    return { ok: true, json: async () => ({ platform: mocks.platform, hostname: 'ubuntu', rdpAvailable: true }) };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function ready() {
  render(<ComputerControlView />);
  await waitFor(() => expect((screen.getByRole('button', { name: '当前电脑' }) as HTMLButtonElement).disabled).toBe(false));
}

describe('computer targets', () => {
  it('saves login only after success, automatically connects after reopening and does not loop after cancellation', async () => {
    await ready();
    fireEvent.change(screen.getByLabelText('RDP 用户名'), { target: { value: 'qiao' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'remembered-secret' } });
    fireEvent.submit(screen.getByLabelText('密码').closest('form')!);
    await waitFor(() => expect(mocks.clients).toHaveLength(1));
    expect(mocks.credentialWrites).toHaveLength(0);
    act(() => mocks.clients[0].dispatchEvent(new Event('connect')));
    await waitFor(() => expect(mocks.credentialWrites).toEqual(['remembered-secret']));
    expect(JSON.stringify(mocks.writes)).not.toContain('remembered-secret');
    expect(JSON.stringify(localStorage)).not.toContain('remembered-secret');
    cleanup(); await ready();
    await waitFor(() => expect(mocks.rdpOptions).toHaveLength(2));
    expect(mocks.rdpOptions[1].password).toBe('remembered-secret');
    expect((screen.getByLabelText('密码') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await act(async () => {}); expect(mocks.rdpOptions).toHaveLength(2);
    expect(screen.getByPlaceholderText('已保存，留空直接连接')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '清除登录' }));
    await waitFor(() => expect(Object.keys(mocks.credentials)).toHaveLength(0));
    expect((screen.getByRole('button', { name: '连接' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('lets remembered login connect manually, invalidates rejected credentials and keeps trust saved', async () => {
    mocks.preferences = defaultComputerPreferences('linux'); mocks.preferences.autoConnect = false;
    mocks.preferences.local.username = 'qiao'; mocks.preferences.local.ignoreCert = true;
    mocks.credentials[computerLoginKey(mocks.preferences.local)] = 'expired-secret';
    await ready(); expect(mocks.clients).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '连接' }));
    await waitFor(() => expect(mocks.rdpOptions).toHaveLength(1));
    expect(mocks.rdpOptions[0]).toMatchObject({ password: 'expired-secret', ignoreCert: true });
    act(() => mocks.failures[0]('COMPUTER_AUTH_FAILED'));
    await waitFor(() => expect(Object.keys(mocks.credentials)).toHaveLength(0));
    expect((screen.getByRole('button', { name: '重试连接' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.preferences.local.ignoreCert).toBe(true);
  });
  it('does not remember successful login when disabled, or reuse a remembered password for another account', async () => {
    mocks.preferences = defaultComputerPreferences('linux'); mocks.preferences.autoConnect = false;
    mocks.preferences.local.username = 'old'; mocks.credentials[computerLoginKey(mocks.preferences.local)] = 'old-secret';
    await ready(); fireEvent.change(screen.getByLabelText('RDP 用户名'), { target: { value: 'new' } });
    expect(screen.queryByPlaceholderText('已保存，留空直接连接')).toBeNull();
    expect((screen.getByRole('button', { name: '连接' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('记住登录'));
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'new-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '连接' }));
    await waitFor(() => expect(mocks.clients).toHaveLength(1)); act(() => mocks.clients[0].dispatchEvent(new Event('connect')));
    await act(async () => {}); expect(mocks.credentialWrites).toHaveLength(0);
    expect(mocks.rdpOptions[0].password).toBe('new-secret');
  });
  it('restores server selections after a refresh even without a successful connection', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: '其他电脑' }));
    fireEvent.change(screen.getByLabelText('电脑地址'), { target: { value: '192.168.1.20' } });
    fireEvent.change(screen.getByLabelText('RDP 端口'), { target: { value: '3390' } });
    fireEvent.change(screen.getByLabelText('RDP 用户名'), { target: { value: 'qiao' } });
    fireEvent.click(screen.getByLabelText('信任此电脑的 RDP 证书（跳过校验）'));
    await waitFor(() => expect(mocks.preferences?.remote.username).toBe('qiao'));
    expect(mocks.clients).toHaveLength(0); cleanup();
    await ready();
    expect(screen.getByRole('button', { name: '其他电脑' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText('电脑地址') as HTMLInputElement).value).toBe('192.168.1.20');
    expect((screen.getByLabelText('RDP 端口') as HTMLInputElement).value).toBe('3390');
    expect((screen.getByLabelText('RDP 用户名') as HTMLInputElement).value).toBe('qiao');
    expect((screen.getByLabelText('信任此电脑的 RDP 证书（跳过校验）') as HTMLInputElement).checked).toBe(true);
  });
  it('retries certificate failure with the current password, then clears it after authentication failure', async () => {
    await ready();
    fireEvent.change(screen.getByLabelText('RDP 用户名'), { target: { value: 'qiao' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'private-password' } });
    fireEvent.submit(screen.getByLabelText('密码').closest('form')!);
    await waitFor(() => expect(mocks.rdpOptions).toHaveLength(1));
    act(() => { mocks.failures[0]('COMPUTER_RDP_CERTIFICATE'); });
    expect(screen.getByRole('alert').textContent).toContain('证书未通过校验');
    expect((screen.getByLabelText('密码') as HTMLInputElement).value).toBe('private-password');
    fireEvent.click(screen.getByLabelText('信任此电脑的证书'));
    fireEvent.click(screen.getByRole('button', { name: '重试连接' }));
    await waitFor(() => expect(mocks.rdpOptions).toHaveLength(2));
    expect(mocks.rdpOptions[1]).toMatchObject({ password: 'private-password', ignoreCert: true });
    act(() => { mocks.failures[1]('COMPUTER_AUTH_FAILED'); });
    expect((screen.getByLabelText('密码') as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(mocks.preferences?.local.ignoreCert).toBe(true));
    expect(JSON.stringify(mocks.writes)).not.toContain('private-password');
  });
  it('clears credentials and certificate trust when changing the computer', async () => {
    await ready();
    fireEvent.change(screen.getByLabelText('RDP 用户名'), { target: { value: 'qiao' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'private-password' } });
    fireEvent.click(screen.getByLabelText('信任此电脑的 RDP 证书（跳过校验）'));
    fireEvent.click(screen.getByRole('button', { name: '其他电脑' }));
    expect((screen.getByLabelText('电脑地址') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('密码') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('RDP 用户名') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('信任此电脑的 RDP 证书（跳过校验）') as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByLabelText('电脑地址'), { target: { value: '192.168.1.20' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'another-password' } });
    fireEvent.click(screen.getByLabelText('信任此电脑的 RDP 证书（跳过校验）'));
    fireEvent.change(screen.getByLabelText('电脑地址'), { target: { value: '192.168.1.21' } });
    expect((screen.getByLabelText('密码') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('信任此电脑的 RDP 证书（跳过校验）') as HTMLInputElement).checked).toBe(false);
  });

  it('keeps a newly chosen remote target when the service status arrives late', async () => {
    const original = fetch;
    let finish!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => url.endsWith('/status') ? new Promise(resolve => { finish = resolve; }) : original(url, options)));
    render(<ComputerControlView />);
    await waitFor(() => expect((screen.getByRole('button', { name: '其他电脑' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '其他电脑' }));
    await act(async () => { finish({ ok: true, json: async () => ({ platform: 'linux', hostname: 'ubuntu', rdpAvailable: true }) }); });
    expect((screen.getByLabelText('电脑地址') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: '其他电脑' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('defaults the Ubuntu service to RDP on its local desktop', async () => {
    await ready();
    expect(screen.queryByLabelText('电脑地址')).toBeNull();
    expect(screen.getByRole('button', { name: '当前电脑' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText('目标系统') as HTMLSelectElement).value).toBe('linux');
    expect((screen.getByLabelText('连接协议') as HTMLSelectElement).value).toBe('rdp');
    expect((screen.getByLabelText('RDP 端口') as HTMLInputElement).value).toBe('3389');
    expect(screen.getByText(/在 Ubuntu 打开/)).toBeTruthy();
    expect(screen.getByText(/运行当前 Termdock 服务的电脑/)).toBeTruthy();
    expect(screen.getByText('高级设置').closest('details')!.open).toBe(false);
    expect(screen.getByText('如何连接电脑').closest('details')!.open).toBe(false);
    expect(screen.getByLabelText('连接协议').closest('details')!.open).toBe(false);
  });

  it('keeps a saved remote Mac target on an Ubuntu service, and switches both address and system for local control', async () => {
    localStorage.setItem('termdock:computer-host:ubuntu-service', 'mac.local');
    localStorage.setItem('termdock:computer-platform:ubuntu-service', 'mac');
    await ready();
    expect((screen.getByLabelText('电脑地址') as HTMLInputElement).value).toBe('mac.local');
    expect((screen.getByLabelText('目标系统') as HTMLSelectElement).value).toBe('mac');
    fireEvent.click(screen.getByRole('button', { name: '当前电脑' }));
    expect(screen.queryByLabelText('电脑地址')).toBeNull();
    expect(screen.getByRole('button', { name: '当前电脑' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText('目标系统') as HTMLSelectElement).value).toBe('linux');
  });

  it.each([
    ['linux', 'Ctrl+V', 0xffe3, 'ControlLeft'],
    ['windows', 'Ctrl+V', 0xffe3, 'ControlLeft'],
    ['mac', '⌘V', 0xffe9, 'MetaLeft'],
  ])('uses the selected %s target for paste even when the service is Ubuntu', async (platform, label, modifier, code) => {
    await ready();
    fireEvent.change(screen.getByLabelText('目标系统'), { target: { value: platform } });
    fireEvent.change(screen.getByLabelText('连接协议'), { target: { value: 'vnc' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'test-vnc-password' } });
    fireEvent.submit(screen.getByLabelText('密码').closest('form')!);
    await waitFor(() => expect(mocks.clients).toHaveLength(1));
    act(() => { mocks.clients[0].dispatchEvent(new Event('connect')); });
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(mocks.clients[0].sendKey.mock.calls).toEqual([
      [modifier, code, true], [0x76, 'KeyV', true],
      [0x76, 'KeyV', false], [modifier, code, false],
    ]);
    expect(mocks.hosts).toEqual(['127.0.0.1']);
    await waitFor(() => expect(mocks.preferences?.local.platform).toBe(platform));
    expect(localStorage.getItem('termdock:computer-password:ubuntu-service')).toBeNull();
  });

  it('passes RDP credentials only to the session, remembers connection settings, and clears the password', async () => {
    await ready();
    fireEvent.change(screen.getByLabelText('RDP 用户名'), { target: { value: 'qiao' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'private-rdp-password' } });
    fireEvent.change(screen.getByLabelText('RDP 端口'), { target: { value: '3390' } });
    fireEvent.submit(screen.getByLabelText('密码').closest('form')!);
    await waitFor(() => expect(mocks.rdpOptions).toHaveLength(1));
    expect(mocks.rdpOptions[0]).toMatchObject({ host: '127.0.0.1', port: 3390, username: 'qiao', password: 'private-rdp-password', ignoreCert: false });
    act(() => { mocks.clients[0].dispatchEvent(new Event('connect')); });
    await waitFor(() => expect(mocks.preferences?.local.protocol).toBe('rdp'));
    expect(mocks.preferences?.local.port).toBe('3390');
    expect(JSON.stringify(mocks.writes)).not.toContain('private-rdp-password');
    expect(JSON.stringify(localStorage)).not.toContain('private-rdp-password');
    fireEvent.click(screen.getByRole('button', { name: '断开' }));
    expect((screen.getByLabelText('密码') as HTMLInputElement).value).toBe('');
  });

  it('allows cancellation and a fresh RDP attempt after a backend failure', async () => {
    await ready();
    fireEvent.change(screen.getByLabelText('RDP 用户名'), { target: { value: 'qiao' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'private-rdp-password' } });
    fireEvent.submit(screen.getByLabelText('密码').closest('form')!);
    await waitFor(() => expect(mocks.rdpOptions).toHaveLength(1));
    act(() => { mocks.failures[0]('COMPUTER_RDP_BACKEND_UNAVAILABLE'); });
    expect(screen.getByRole('alert').textContent).toContain('RDP 支持不可用');
    expect((screen.getByLabelText('密码') as HTMLInputElement).value).toBe('private-rdp-password');
    fireEvent.click(screen.getByRole('button', { name: '检查连接设置' }));
    expect(screen.getByLabelText('连接协议').closest('details')!.open).toBe(true);
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'another-password' } });
    fireEvent.submit(screen.getByLabelText('密码').closest('form')!);
    await waitFor(() => expect(mocks.rdpOptions).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    act(() => { mocks.failures[1]('COMPUTER_RDP_FAILED'); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByLabelText('密码') as HTMLInputElement).value).toBe('');
    expect(mocks.hosts).toHaveLength(0);
  });

  it('resets local target semantics when switching the current service', async () => {
    await ready();
    mocks.peer = 'mac-service'; mocks.platform = 'darwin'; mocks.preferences = null;
    act(() => { window.dispatchEvent(new Event('test-secure-state')); });
    await waitFor(() => expect((screen.getByLabelText('目标系统') as HTMLSelectElement).value).toBe('mac'));
    expect(screen.queryByLabelText('电脑地址')).toBeNull();
    expect(screen.getByRole('button', { name: '当前电脑' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/在 Mac 上打开/)).toBeTruthy();
  });

  it('shows a failure when status cannot load, without offering a local target on an unknown service', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render(<ComputerControlView />);
    expect((await screen.findByRole('alert')).textContent).toBe('电脑连接失败，请重新连接。');
    expect((screen.getByRole('button', { name: '当前电脑' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('连接设置读取失败，请重试。')).toBeTruthy();
  });
});
