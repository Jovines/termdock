// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollaborationTab } from './AgentOperationsPanel';
import { TerminalApiError, type CollaborationGroup } from '../../terminal/api';
import { freshGroupSettingsDraft, writeGroupSettingsDraft } from '../../collaboration/groupSettingsDraft';

const api = vi.hoisted(() => ({ rename: vi.fn(), rules: vi.fn(), latest: vi.fn() }));
vi.mock('../../terminal/api', async original => ({
  ...await original<typeof import('../../terminal/api')>(),
  updateSettings: vi.fn().mockResolvedValue({}),
  listCollaborationMessages: vi.fn().mockResolvedValue({ messages: [] }),
  saveCollaborationGroup: api.rename, setCollaborationGroupRules: api.rules, listCollaborationGroups: api.latest,
}));
vi.mock('./CollaborationTaskWorkbench', () => ({ CollaborationTaskWorkbench: ({ boardSettings }: { boardSettings: React.ReactNode }) => <section aria-label="看板">{boardSettings}</section> }));
const alpha: CollaborationGroup = { id: 'alpha-draft', name: 'Alpha', sessionIds: ['member'], createdAt: 1, updatedAt: 1 };
const beta: CollaborationGroup = { ...alpha, id: 'beta-draft', name: 'Beta' };
const member = { sessionId: 'member', backendSessionId: 'member', agent: null, name: '测试成员', cwd: '/tmp', status: 'ready', capability: 'terminal', currentTask: '', updatedAt: 1 };
const secondMember = { ...member, sessionId: 'second-member', backendSessionId: 'second-member', name: '第二成员' };
function Harness({ group = alpha, activeSessionId = 'member' }: { group?: CollaborationGroup; activeSessionId?: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return <>{error && <p role="alert">{error}</p>}<CollaborationTab key={group.id} fullWorkspace active notice={null} onDraftChange={vi.fn()} docked={false} inputKeySuffix="" selectedGroupId={group.id} setSelectedGroupId={vi.fn()} floatingVisible floating={false} sessionsState="loaded" groups={[group]} sessions={[member, secondMember]} agents={[]} activeSessionId={activeSessionId} initialGroupId={group.id} onOpenSession={vi.fn()} onOpenTaskSession={vi.fn()} defaultSessionMode="shell" busy={busy} setBusy={setBusy} setError={setError} setNotice={vi.fn()} refresh={vi.fn().mockResolvedValue(undefined)} /></>;
}
function open() { fireEvent.click(screen.getByRole('button', { name: '组设置' })); }
const nameInput = () => screen.getByRole('textbox', { name: '协作组名称' }) as HTMLInputElement;
const rulesInput = () => screen.getByRole('textbox', { name: '群规与协作约定' }) as HTMLTextAreaElement;
function edit(name = '名称草稿', rules = '群规草稿') {
  fireEvent.change(nameInput(), { target: { value: name } });
  fireEvent.change(rulesInput(), { target: { value: rules } });
}
const draftKey = (group: CollaborationGroup) => `termdock-group-settings:${location.origin}:${group.id}`;
function failDraftStorage(method: 'setItem' | 'removeItem' | 'getItem', group: CollaborationGroup) {
  const original = Storage.prototype[method];
  return vi.spyOn(Storage.prototype, method).mockImplementation(function (this: Storage, key: string, value?: string) {
    if (this === sessionStorage && key === draftKey(group)) throw new DOMException('Blocked', 'SecurityError');
    return method === 'setItem' ? (original as Storage['setItem']).call(this, key, value!) : (original as Storage['getItem']).call(this, key);
  });
}
beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.clearAllMocks(); api.rename.mockReset(); api.rules.mockReset(); api.latest.mockReset(); });
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); sessionStorage.clear();
  for (const group of [alpha, beta]) writeGroupSettingsDraft(group.id, freshGroupSettingsDraft(group));
});

it('keeps both drafts on close, Escape and a complete unmount without publishing', () => {
  const view = render(<Harness />); open(); edit();
  expect(screen.getByText(/有未保存修改/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '关闭并保留草稿' }));
  open(); expect(nameInput().value).toBe('名称草稿'); expect(rulesInput().value).toBe('群规草稿');
  const parentKey = vi.fn(); window.addEventListener('keydown', parentKey);
  fireEvent.keyDown(rulesInput(), { key: 'Escape' });
  expect(screen.queryByRole('region', { name: '协作组设置' })).toBeNull();
  expect(parentKey).not.toHaveBeenCalled(); window.removeEventListener('keydown', parentKey);
  view.unmount(); render(<Harness />); open();
  expect(nameInput().value).toBe('名称草稿'); expect(rulesInput().value).toBe('群规草稿');
  expect(api.rename).not.toHaveBeenCalled(); expect(api.rules).not.toHaveBeenCalled();
});

it.each(['name', 'rules'] as const)('confirms current members before retrying %s and retains both drafts through storage failure and reopening', async first => {
  const changed: CollaborationGroup = { ...alpha, name: '其他人保存的名称', sessionIds: ['second-member'], updatedAt: 20,
    instructions: { text: '其他人保存的群规', version: 'v20', updatedAt: 20, updatedBy: 'second-member' } };
  api.latest.mockResolvedValue({ groups: [changed], sessions: [secondMember] });
  api.rename.mockRejectedValueOnce(new TerminalApiError('旧成员管理提示', 409));
  api.rename.mockResolvedValue({ group: { ...changed, name: '名称草稿', updatedAt: 21 } });
  api.rules.mockResolvedValue({ group: { ...changed, name: '名称草稿', updatedAt: 22, instructions: { text: '群规草稿', version: 'v22' } } });
  let view = render(<Harness />); open(); edit();
  fireEvent.click(screen.getByRole('button', { name: '保存名称' }));
  await screen.findByText(/组设置已被其他人修改/);
  failDraftStorage('setItem', alpha);
  fireEvent.click(screen.getByRole('button', { name: '查看最新状态并保留草稿' }));
  const review = await screen.findByRole('region', { name: '最新组设置' });
  expect(within(review).getByText('当前成员（1）：第二成员')).toBeTruthy();
  expect(nameInput().value).toBe('名称草稿'); expect(rulesInput().value).toBe('群规草稿');
  expect(api.rename).toHaveBeenCalledOnce(); expect(api.rules).not.toHaveBeenCalled();
  fireEvent.click(within(review).getByRole('button', { name: '确认最新状态，保留草稿' }));
  fireEvent.click(screen.getByRole('button', { name: '关闭并保留草稿' })); view.unmount();
  // Even before the parent directory renders the new group, the confirmed snapshot survives.
  view = render(<Harness />); open();
  expect(nameInput().value).toBe('名称草稿'); expect(rulesInput().value).toBe('群规草稿');
  expect((screen.getByRole('combobox', { name: '由本组成员发布群规变更' }) as HTMLSelectElement).value).toBe('');
  view.rerender(<Harness group={changed} />);
  fireEvent.change(screen.getByRole('combobox', { name: '由本组成员发布群规变更' }), { target: { value: 'second-member' } });
  if (first === 'rules') {
    api.rules.mockResolvedValueOnce({ group: { ...changed, updatedAt: 21, instructions: { text: '群规草稿', version: 'v21' } } });
    api.rename.mockResolvedValue({ group: { ...changed, name: '名称草稿', updatedAt: 22, instructions: { text: '群规草稿', version: 'v21' } } });
  }
  fireEvent.click(screen.getByRole('button', { name: first === 'name' ? '保存名称' : '保存群规' }));
  await waitFor(() => expect((screen.getByRole('button', { name: first === 'name' ? '保存名称' : '保存群规' }) as HTMLButtonElement).disabled).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: first === 'name' ? '保存群规' : '保存名称' }));
  await waitFor(() => expect(screen.queryByText(/有未保存修改/)).toBeNull());
  expect(api.rename).toHaveBeenLastCalledWith({ id: alpha.id, name: '名称草稿', sessionIds: ['second-member'], expectedUpdatedAt: first === 'name' ? 20 : 21 });
  expect(api.rules).toHaveBeenCalledWith(alpha.id, { sessionId: 'second-member', text: '群规草稿', expectedVersion: 'v20' });
});

it('keeps drafts and old guards on cancelled or failed latest-state review and rechecks a second conflict', async () => {
  api.latest.mockRejectedValueOnce(new Error('读取中断')).mockResolvedValue({ groups: [{ ...alpha, updatedAt: 2, name: '新名称' }], sessions: [member] });
  api.rename.mockRejectedValue(new TerminalApiError('冲突', 409));
  render(<Harness />); open(); edit();
  fireEvent.click(screen.getByRole('button', { name: '查看最新状态并保留草稿' })); await screen.findByText('读取中断');
  fireEvent.click(screen.getByRole('button', { name: '查看最新状态并保留草稿' })); await screen.findByRole('region', { name: '最新组设置' });
  fireEvent.click(screen.getByRole('button', { name: '取消确认' }));
  fireEvent.click(screen.getByRole('button', { name: '保存名称' })); await screen.findByText(/组设置已被其他人修改/);
  expect(api.rename).toHaveBeenLastCalledWith(expect.objectContaining({ expectedUpdatedAt: 1 }));
  fireEvent.click(screen.getByRole('button', { name: '查看最新状态并保留草稿' })); await screen.findByRole('region', { name: '最新组设置' });
  fireEvent.click(screen.getByRole('button', { name: '确认最新状态，保留草稿' }));
  fireEvent.click(screen.getByRole('button', { name: '保存名称' })); await screen.findByText(/组设置已被其他人修改/);
  expect(api.rename).toHaveBeenLastCalledWith(expect.objectContaining({ expectedUpdatedAt: 2 }));
  expect(nameInput().value).toBe('名称草稿'); expect(rulesInput().value).toBe('群规草稿');
});

it('isolates drafts by group, including switching while settings are open', () => {
  const view = render(<Harness />); open(); edit();
  view.rerender(<Harness group={beta} />); open();
  expect(nameInput().value).toBe('Beta'); expect(rulesInput().value).toBe('');
  edit('Beta草稿', 'Beta群规');
  view.rerender(<Harness />); open();
  expect(nameInput().value).toBe('名称草稿'); expect(rulesInput().value).toBe('群规草稿');
  expect(api.rules).not.toHaveBeenCalled();
});

it('saves names independently, keeps unsaved rules and never undoes a saved name when reloading', async () => {
  const renamed = { ...alpha, name: '名称草稿', updatedAt: 2 };
  api.rename.mockResolvedValue({ group: renamed });
  const view = render(<Harness />); open(); edit();
  fireEvent.click(screen.getByRole('button', { name: '保存名称' }));
  await waitFor(() => expect((screen.getByRole('button', { name: '保存名称' }) as HTMLButtonElement).disabled).toBe(true));
  expect(rulesInput().value).toBe('群规草稿'); expect(api.rules).not.toHaveBeenCalled();
  view.rerender(<Harness group={renamed} />);
  fireEvent.click(screen.getByRole('button', { name: '关闭并保留草稿' })); open();
  expect(nameInput().value).toBe('名称草稿'); expect(rulesInput().value).toBe('群规草稿');
  fireEvent.click(screen.getByRole('button', { name: '重新载入（放弃草稿）' }));
  expect(nameInput().value).toBe('名称草稿'); expect(rulesInput().value).toBe('');
  expect(api.rename).toHaveBeenCalledOnce();
});

it('saves rules independently, retaining the unsaved name and the next expected revision', async () => {
  api.rules.mockResolvedValue({ group: { ...alpha, updatedAt: 2, instructions: { text: '群规草稿', version: 'v2' } } });
  render(<Harness />); open(); edit();
  fireEvent.click(screen.getByRole('button', { name: '保存群规' }));
  await waitFor(() => expect((screen.getByRole('button', { name: '保存群规' }) as HTMLButtonElement).disabled).toBe(true));
  expect(nameInput().value).toBe('名称草稿'); expect(api.rename).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '关闭并保留草稿' })); open();
  api.rename.mockResolvedValue({ group: { ...alpha, name: '名称草稿', updatedAt: 3 } });
  fireEvent.click(screen.getByRole('button', { name: '保存名称' }));
  expect(api.rename).toHaveBeenCalledWith(expect.objectContaining({ expectedUpdatedAt: 2 }));
});

it('keeps drafts after failed saves and preserves the original conflict revision on reopening', async () => {
  api.rename.mockRejectedValue(new Error('版本已变化')); api.rules.mockRejectedValue(new Error('连接中断'));
  render(<Harness />); open(); edit();
  fireEvent.click(screen.getByRole('button', { name: '保存名称' }));
  await screen.findByText('版本已变化');
  fireEvent.click(screen.getByRole('button', { name: '保存群规' }));
  await screen.findByText('连接中断');
  fireEvent.click(screen.getByRole('button', { name: '关闭组设置' })); open();
  expect(nameInput().value).toBe('名称草稿'); expect(rulesInput().value).toBe('群规草稿');
  fireEvent.click(screen.getByRole('button', { name: '保存名称' }));
  expect(api.rename).toHaveBeenLastCalledWith(expect.objectContaining({ expectedUpdatedAt: 1 }));
  await screen.findByText('版本已变化');
});

it('does not let Escape close a parent during a save and updates the cached draft after a late response', async () => {
  let finish!: (value: unknown) => void;
  api.rename.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<Harness />); open(); edit();
  fireEvent.click(screen.getByRole('button', { name: '保存名称' }));
  fireEvent.keyDown(screen.getByRole('region', { name: '协作组设置' }), { key: 'Escape' });
  expect(screen.getByRole('region', { name: '协作组设置' })).toBeTruthy();
  view.rerender(<Harness group={beta} />);
  finish({ group: { ...alpha, name: '名称草稿', updatedAt: 2 } });
  await waitFor(() => expect(sessionStorage.getItem(`termdock-group-settings:${location.origin}:${alpha.id}`)).toContain('"updatedAt":2'));
  view.rerender(<Harness />); open();
  expect(nameInput().value).toBe('名称草稿'); expect(rulesInput().value).toBe('群规草稿');
  expect(within(screen.getByRole('region', { name: '协作组设置' })).getByRole('button', { name: '保存名称' }).hasAttribute('disabled')).toBe(true);
});

it('restores the latest failed write over stale storage after closing, switching groups and a complete unmount without publishing', () => {
  const saved: CollaborationGroup = { ...alpha, sessionIds: ['member', 'second-member'], updatedAt: 10,
    instructions: { text: '已保存群规', version: 'v10', updatedAt: 10, updatedBy: 'member' } };
  const view = render(<Harness group={saved} />); open(); edit('旧名称草稿', '旧群规草稿');
  const oldRaw = sessionStorage.getItem(draftKey(saved));
  failDraftStorage('setItem', saved);
  edit('最新名称草稿', '最新群规草稿');
  fireEvent.change(screen.getByRole('combobox', { name: '由本组成员发布群规变更' }), { target: { value: 'second-member' } });
  expect(sessionStorage.getItem(draftKey(saved))).toBe(oldRaw);
  fireEvent.click(screen.getByRole('button', { name: '关闭并保留草稿' })); open();
  expect(nameInput().value).toBe('最新名称草稿'); expect(rulesInput().value).toBe('最新群规草稿');
  view.rerender(<Harness group={beta} />); open(); edit('Beta最新名称', 'Beta最新群规');
  const unavailableReads = failDraftStorage('getItem', saved);
  view.rerender(<Harness group={saved} activeSessionId="member" />); open();
  expect(nameInput().value).toBe('最新名称草稿'); expect(rulesInput().value).toBe('最新群规草稿');
  expect((screen.getByRole('combobox', { name: '由本组成员发布群规变更' }) as HTMLSelectElement).value).toBe('second-member');
  unavailableReads.mockRestore();
  view.rerender(<Harness group={beta} />); open();
  expect(nameInput().value).toBe('Beta最新名称'); expect(rulesInput().value).toBe('Beta最新群规');
  view.unmount(); render(<Harness group={saved} />); open();
  expect(nameInput().value).toBe('最新名称草稿'); expect(rulesInput().value).toBe('最新群规草稿');
  expect(api.rename).not.toHaveBeenCalled(); expect(api.rules).not.toHaveBeenCalled();
});

it('keeps discarded drafts cleared after failed removal and reopens current saved values and publisher metadata', () => {
  const view = render(<Harness />); open(); edit();
  const oldRaw = sessionStorage.getItem(draftKey(alpha));
  failDraftStorage('removeItem', alpha);
  const saved: CollaborationGroup = { ...alpha, name: '服务端新名称', sessionIds: ['member', 'second-member'], updatedAt: 20,
    instructions: { text: '服务端新群规', version: 'v20', updatedAt: 20, updatedBy: 'second-member' } };
  view.rerender(<Harness group={saved} />);
  fireEvent.click(screen.getByRole('button', { name: '重新载入（放弃草稿）' }));
  expect(nameInput().value).toBe(saved.name); expect(rulesInput().value).toBe(saved.instructions!.text);
  expect(sessionStorage.getItem(draftKey(alpha))).toBe(oldRaw);
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  view.unmount(); render(<Harness group={saved} activeSessionId="second-member" />); open();
  expect(nameInput().value).toBe(saved.name); expect(rulesInput().value).toBe(saved.instructions!.text);
  expect((screen.getByRole('combobox', { name: '由本组成员发布群规变更' }) as HTMLSelectElement).value).toBe('second-member');
  expect(screen.queryByText(/有未保存修改/)).toBeNull();
  expect(api.rename).not.toHaveBeenCalled(); expect(api.rules).not.toHaveBeenCalled();
});

it.each(['name', 'rules'] as const)('saves %s independently through failed storage, preserves the other draft, and clears both after the final explicit save', async first => {
  const saved: CollaborationGroup = { ...alpha, sessionIds: ['member', 'second-member'], updatedAt: 10,
    instructions: { text: '已保存群规', version: 'v10', updatedAt: 10, updatedBy: 'member' } };
  const partiallySaved: CollaborationGroup = first === 'name'
    ? { ...saved, name: '最新名称草稿', updatedAt: 11 }
    : { ...saved, updatedAt: 11, instructions: { text: '最新群规草稿', version: 'v11', updatedAt: 11, updatedBy: 'second-member' } };
  const fullySaved: CollaborationGroup = { ...partiallySaved, name: '最新名称草稿', updatedAt: 12,
    instructions: { text: '最新群规草稿', version: first === 'name' ? 'v12' : 'v11', updatedAt: 12, updatedBy: 'second-member' } };
  (first === 'name' ? api.rename : api.rules).mockResolvedValue({ group: partiallySaved });
  (first === 'name' ? api.rules : api.rename).mockResolvedValue({ group: fullySaved });
  let view = render(<Harness group={saved} />); open(); edit('旧名称草稿', '旧群规草稿');
  const oldRaw = sessionStorage.getItem(draftKey(saved));
  failDraftStorage('setItem', saved); failDraftStorage('removeItem', saved);
  edit('最新名称草稿', '最新群规草稿');
  fireEvent.change(screen.getByRole('combobox', { name: '由本组成员发布群规变更' }), { target: { value: 'second-member' } });
  fireEvent.click(screen.getByRole('button', { name: first === 'name' ? '保存名称' : '保存群规' }));
  await waitFor(() => expect((screen.getByRole('button', { name: first === 'name' ? '保存名称' : '保存群规' }) as HTMLButtonElement).disabled).toBe(true));
  expect(first === 'name' ? api.rules : api.rename).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '关闭并保留草稿' })); view.unmount();
  view = render(<Harness group={partiallySaved} />); open();
  expect(nameInput().value).toBe('最新名称草稿'); expect(rulesInput().value).toBe('最新群规草稿');
  expect((screen.getByRole('combobox', { name: '由本组成员发布群规变更' }) as HTMLSelectElement).value).toBe('second-member');
  fireEvent.click(screen.getByRole('button', { name: first === 'name' ? '保存群规' : '保存名称' }));
  await waitFor(() => expect(screen.queryByText(/有未保存修改/)).toBeNull());
  expect(api.rename).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ expectedUpdatedAt: first === 'name' ? 10 : 11 }));
  expect(api.rules).toHaveBeenCalledExactlyOnceWith(saved.id, { sessionId: 'second-member', text: '最新群规草稿', expectedVersion: 'v10' });
  expect(sessionStorage.getItem(draftKey(saved))).toBe(oldRaw);
  fireEvent.click(screen.getByRole('button', { name: '关闭' })); view.unmount();
  render(<Harness group={fullySaved} activeSessionId="second-member" />); open();
  expect(nameInput().value).toBe(fullySaved.name); expect(rulesInput().value).toBe(fullySaved.instructions!.text);
  expect(screen.queryByText(/有未保存修改/)).toBeNull();
  expect(api.rename).toHaveBeenCalledOnce(); expect(api.rules).toHaveBeenCalledOnce();
});
