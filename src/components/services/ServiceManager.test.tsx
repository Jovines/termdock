// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceManager } from './ServiceManager';
import { readBrowserServices, saveServiceConnection } from '../../lib/services/serviceDirectory';
import { createInviteLink } from '../../lib/federation/inviteLink';
afterEach(() => { cleanup(); localStorage.clear(); });
describe('shared service manager', () => {
  it.each(['://', 'ftp://computer.example', 'https://computer.example?secret=value', 'https://computer.example/#termdock-invite=broken'])('keeps invalid input %s editable without attempting a connection or saving it', async input => {
    const onAdd = vi.fn(), onBusyChange = vi.fn();
    render(<ServiceManager onBusyChange={onBusyChange} initiallyAdding onAdd={onAdd} onOpen={async () => {}} />);
    fireEvent.change(screen.getByLabelText('服务地址或邀请链接'), { target: { value: input } });
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(input.includes('#termdock-invite=') ? 'Copy the full invitation link' : 'Enter a valid HTTPS service address');
    expect((screen.getByLabelText('服务地址或邀请链接') as HTMLInputElement).value).toBe(input);
    expect(onAdd).not.toHaveBeenCalled(); expect(readBrowserServices()).toEqual([]);
    expect(document.activeElement).toBe(screen.getByLabelText('服务地址或邀请链接'));
    expect(onBusyChange).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: '继续' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it.each(['computer.example:9834', 'https://computer.example:9834', 'https://[::1]:9834', '[::1]:9834', createInviteLink({ v: 1, serviceId: `12D3KooW${'a'.repeat(44)}`, code: 'b'.repeat(32), entryUrl: 'https://computer.example:9834' })])('retains support for %s', async input => {
    const onAdd = vi.fn().mockResolvedValue({ passwordRequired: true });
    render(<ServiceManager initiallyAdding onAdd={onAdd} onOpen={async () => {}} />);
    fireEvent.change(screen.getByLabelText('服务地址或邀请链接'), { target: { value: input } });
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await screen.findByLabelText('服务密码'); expect(onAdd).toHaveBeenCalledWith(input, undefined);
    expect(screen.queryByRole('alert')).toBeNull();
  });
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

it('keeps keyboard focus and input on invalid Enter and save without starting busy work', async () => {
  const onBusyChange = vi.fn(), onAdd = vi.fn();
  render(<ServiceManager initiallyAdding onBusyChange={onBusyChange} onAdd={onAdd} onOpen={async () => {}} />);
  const input = screen.getByLabelText('服务地址或邀请链接');
  fireEvent.change(input, { target: { value: '://' } }); input.focus();
  fireEvent.submit(input.closest('form')!);
  await screen.findByRole('alert');
  expect(document.activeElement).toBe(input);
  fireEvent.click(screen.getByRole('button', { name: '仅保存，不连接' }));
  expect(document.activeElement).toBe(input);
  expect(onBusyChange).not.toHaveBeenCalled(); expect(onAdd).not.toHaveBeenCalled();
});
it('still disables repeated valid submissions while a connection is pending', async () => {
  let finish!: () => void;
  const onAdd = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  render(<ServiceManager initiallyAdding onAdd={onAdd} onOpen={async () => {}} />);
  const input = screen.getByLabelText('服务地址或邀请链接');
  fireEvent.change(input, { target: { value: 'computer.example' } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(true));
  fireEvent.submit(input.closest('form')!); expect(onAdd).toHaveBeenCalledTimes(1);
  finish(); await waitFor(() => expect(screen.queryByLabelText('服务地址或邀请链接')).toBeNull());
});

function failedDiscovery() { return Object.assign(new Error('暂时无法连接服务。请检查地址、网络或证书指纹后重试。'), { code: 'PREVIEW_DISCOVERY_FAILED' }); }
const certA = 'a'.repeat(64), certB = 'b'.repeat(64);
it('requires independent explicit confirmation, trusts once, and retries the submitted address once', async () => {
  const onAdd = vi.fn().mockRejectedValueOnce(failedDiscovery()).mockResolvedValueOnce(undefined);
  const trust = { listPins: vi.fn().mockResolvedValue({}), inspect: vi.fn().mockResolvedValue({ origin: 'https://office.example', fingerprint: certA, receipt: 'receipt-1' }), trust: vi.fn().mockResolvedValue(null), discard: vi.fn().mockResolvedValue(null), revoke: vi.fn().mockResolvedValue(null) };
  render(<ServiceManager initiallyAdding onAdd={onAdd} onOpen={async () => {}} certificateTrust={trust} />);
  fireEvent.change(screen.getByLabelText('服务地址或邀请链接'), { target: { value: 'https://office.example' } });
  fireEvent.click(screen.getByRole('button', { name: '继续' }));
  expect(await screen.findByText(new RegExp(certA.match(/.{2}/g)!.join(':'), 'i'))).toBeTruthy();
  expect(onAdd).toHaveBeenCalledTimes(1); expect(trust.trust).not.toHaveBeenCalled();
  const consent = screen.getByRole('checkbox');
  fireEvent.click(consent);
  fireEvent.click(screen.getByRole('button', { name: '信任此指纹并重试一次' }));
  await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(2));
  expect(trust.trust).toHaveBeenCalledExactlyOnceWith('https://office.example', certA, 'receipt-1');
  expect(trust.inspect).toHaveBeenCalledExactlyOnceWith('https://office.example');
});

it('cancel discards the one-shot inspection receipt without writing a pin or retrying', async () => {
  const onAdd = vi.fn().mockRejectedValue(failedDiscovery());
  const trust = { listPins: vi.fn().mockResolvedValue({}), inspect: vi.fn().mockResolvedValue({ origin: 'https://office.example', fingerprint: certA, receipt: 'receipt-cancel' }), trust: vi.fn(), discard: vi.fn().mockResolvedValue(null), revoke: vi.fn() };
  render(<ServiceManager initiallyAdding onAdd={onAdd} onOpen={async () => {}} certificateTrust={trust} />);
  fireEvent.change(screen.getByLabelText('服务地址或邀请链接'), { target: { value: 'https://office.example' } });
  fireEvent.click(screen.getByRole('button', { name: '继续' }));
  await screen.findByRole('region', { name: 'HTTPS 证书确认' });
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'HTTPS 证书确认' })).toBeNull());
  expect(trust.discard).toHaveBeenCalledExactlyOnceWith('receipt-cancel');
  expect(trust.trust).not.toHaveBeenCalled(); expect(onAdd).toHaveBeenCalledTimes(1);
});

it('a changed certificate requires a fresh fingerprint receipt and a second explicit confirmation', async () => {
  const changed = Object.assign(new Error('Certificate changed after inspection'), { code: 'PREVIEW_CERTIFICATE_CHANGED' });
  const onAdd = vi.fn().mockRejectedValueOnce(failedDiscovery()).mockResolvedValueOnce(undefined);
  const trust = { listPins: vi.fn().mockResolvedValue({}), inspect: vi.fn()
    .mockResolvedValueOnce({ origin: 'https://office.example', fingerprint: certA, trustedFingerprint: certB, receipt: 'receipt-old' })
    .mockResolvedValueOnce({ origin: 'https://office.example', fingerprint: certB, trustedFingerprint: certA, receipt: 'receipt-new' }),
    trust: vi.fn().mockRejectedValueOnce(changed).mockResolvedValueOnce(null), discard: vi.fn().mockResolvedValue(null), revoke: vi.fn().mockResolvedValue(null) };
  render(<ServiceManager initiallyAdding onAdd={onAdd} onOpen={async () => {}} certificateTrust={trust} />);
  fireEvent.change(screen.getByLabelText('服务地址或邀请链接'), { target: { value: 'https://office.example' } });
  fireEvent.click(screen.getByRole('button', { name: '继续' }));
  await screen.findByText(new RegExp(certA.match(/.{2}/g)!.join(':'), 'i'));
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: '信任此指纹并重试一次' }));
  await screen.findByText(new RegExp(certB.match(/.{2}/g)!.join(':'), 'i'));
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: '信任此指纹并重试一次' }));
  await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(2));
  expect(trust.trust).toHaveBeenNthCalledWith(1, 'https://office.example', certA, 'receipt-old');
  expect(trust.trust).toHaveBeenNthCalledWith(2, 'https://office.example', certB, 'receipt-new');
});

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a,b) => { resolve = a; reject = b; }); return {promise,resolve,reject}; }
function certificateFixture() {
  return { listPins: vi.fn().mockResolvedValue({}), inspect: vi.fn().mockResolvedValue({origin:'https://office.example',fingerprint:certA,receipt:'owned-receipt'}), trust:vi.fn().mockResolvedValue(undefined), discard:vi.fn().mockResolvedValue(undefined), revoke:vi.fn().mockResolvedValue(undefined) };
}
function submitOffice() {
  fireEvent.change(screen.getByLabelText('服务地址或邀请链接'), {target:{value:'https://office.example'}});
  fireEvent.click(screen.getByRole('button',{name:'继续'}));
}
it('opens a trusted service normally without inspecting or changing certificate trust', async () => {
  const trust=certificateFixture(),onAdd=vi.fn().mockResolvedValue(undefined);
  render(<ServiceManager initiallyAdding certificateTrust={trust} onAdd={onAdd} onOpen={async()=>{}}/>);
  submitOffice(); await waitFor(()=>expect(screen.queryByLabelText('服务地址或邀请链接')).toBeNull());
  expect(trust.inspect).not.toHaveBeenCalled();expect(trust.trust).not.toHaveBeenCalled();
});
it.each(['unmount','target'] as const)('does not start certificate inspection after a pending open loses its %s owner', async mode => {
  const pending=deferred<void>(),trust=certificateFixture(),onAdd=vi.fn(()=>pending.promise);
  const view=render(<ServiceManager initiallyAdding certificateTrust={trust} onAdd={onAdd} onOpen={async()=>{}}/>);
  submitOffice();
  if(mode==='unmount')view.unmount();else view.rerender(<ServiceManager initiallyAdding current={{id:'b',url:'https://other.example',label:'B'}} certificateTrust={trust} onAdd={onAdd} onOpen={async()=>{}}/>);
  await act(async()=>pending.reject(failedDiscovery()));
  expect(trust.inspect).not.toHaveBeenCalled();expect(trust.trust).not.toHaveBeenCalled();
});
it('discards a late inspection receipt after unmount instead of retaining a confirmation', async()=>{
  const pending=deferred<{origin:string;fingerprint:string;receipt:string}>(),trust=certificateFixture();trust.inspect.mockImplementation(()=>pending.promise);
  const view=render(<ServiceManager initiallyAdding certificateTrust={trust} onAdd={async()=>{throw failedDiscovery();}} onOpen={async()=>{}}/>);
  submitOffice();await waitFor(()=>expect(trust.inspect).toHaveBeenCalledOnce());view.unmount();
  await act(async()=>pending.resolve({origin:'https://office.example',fingerprint:certA,receipt:'late'}));
  expect(trust.discard).toHaveBeenCalledWith('late');expect(trust.trust).not.toHaveBeenCalled();
});
it.each(['cancel','unmount','target'] as const)('cancels an inflight trust on %s and never retries its old connection',async mode=>{
  const pending=deferred<void>(),trust=certificateFixture(),onAdd=vi.fn().mockRejectedValue(failedDiscovery());trust.trust.mockImplementation(()=>pending.promise);
  const view=render(<ServiceManager initiallyAdding certificateTrust={trust} onAdd={onAdd} onOpen={async()=>{}}/>);
  submitOffice();await screen.findByRole('region',{name:'HTTPS 证书确认'});fireEvent.click(screen.getByRole('checkbox'));
  const confirm=screen.getByRole('button',{name:'信任此指纹并重试一次'});fireEvent.click(confirm);fireEvent.click(confirm);
  expect(trust.trust).toHaveBeenCalledOnce();
  if(mode==='cancel')fireEvent.click(screen.getByRole('button',{name:'取消'}));
  else if(mode==='unmount')view.unmount();
  else view.rerender(<ServiceManager initiallyAdding current={{id:'b',url:'https://other.example',label:'B'}} certificateTrust={trust} onAdd={onAdd} onOpen={async()=>{}}/>);
  await waitFor(()=>expect(trust.discard).toHaveBeenCalledWith('owned-receipt'));
  await act(async()=>pending.resolve());expect(onAdd).toHaveBeenCalledTimes(1);
});

it('does not submit a consumed confirmation if checking a changed certificate fails, and keeps the address retryable',async()=>{
 const trust=certificateFixture(),onAdd=vi.fn().mockRejectedValue(failedDiscovery());
 trust.inspect.mockReset().mockResolvedValueOnce({origin:'https://office.example',fingerprint:certA,receipt:'old'})
  .mockRejectedValueOnce(new Error('controlled inspection failure'))
  .mockResolvedValueOnce({origin:'https://office.example',fingerprint:certB,receipt:'fresh'});
 trust.trust.mockRejectedValue(Object.assign(new Error('changed'),{code:'PREVIEW_CERTIFICATE_CHANGED'}));
 render(<ServiceManager initiallyAdding certificateTrust={trust} onAdd={onAdd} onOpen={async()=>{}}/>);
 submitOffice();await screen.findByRole('region',{name:'HTTPS 证书确认'});fireEvent.click(screen.getByRole('checkbox'));
 fireEvent.click(screen.getByRole('button',{name:'信任此指纹并重试一次'}));
 await screen.findByText('证书在确认期间发生变化，且无法重新读取。请稍后重试。');
 expect(screen.queryByRole('button',{name:'信任此指纹并重试一次'})).toBeNull();
 expect((screen.getByLabelText('服务地址或邀请链接') as HTMLInputElement).value).toBe('https://office.example');
 fireEvent.click(screen.getByRole('button',{name:'继续'}));
 await screen.findByRole('region',{name:'HTTPS 证书确认'});
 expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
 expect(trust.trust).toHaveBeenCalledOnce();expect(trust.inspect).toHaveBeenCalledTimes(3);expect(onAdd).toHaveBeenCalledTimes(2);
});
