// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollaborationTab } from './AgentOperationsPanel';
import type { CollaborationGroup } from '../../terminal/api';

const api = vi.hoisted(() => ({ rename: vi.fn(), rules: vi.fn() }));
vi.mock('../../terminal/api', async original => ({
  ...await original<typeof import('../../terminal/api')>(),
  updateSettings: vi.fn().mockResolvedValue({}),
  listCollaborationMessages: vi.fn().mockResolvedValue({ messages: [] }),
  saveCollaborationGroup: api.rename, setCollaborationGroupRules: api.rules,
}));
vi.mock('./CollaborationTaskWorkbench', () => ({ CollaborationTaskWorkbench: ({ boardSettings }: { boardSettings: React.ReactNode }) => <section aria-label="看板">{boardSettings}</section> }));
const alpha: CollaborationGroup = { id: 'alpha-draft', name: 'Alpha', sessionIds: ['member'], createdAt: 1, updatedAt: 1 };
const beta: CollaborationGroup = { ...alpha, id: 'beta-draft', name: 'Beta' };
const member = { sessionId: 'member', backendSessionId: 'member', agent: null, name: '测试成员', cwd: '/tmp', status: 'ready', capability: 'terminal', currentTask: '', updatedAt: 1 };
function Harness({ group = alpha }: { group?: CollaborationGroup }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return <>{error && <p role="alert">{error}</p>}<CollaborationTab key={group.id} fullWorkspace active notice={null} onDraftChange={vi.fn()} docked={false} inputKeySuffix="" selectedGroupId={group.id} setSelectedGroupId={vi.fn()} floatingVisible floating={false} sessionsState="loaded" groups={[group]} sessions={[member]} agents={[]} activeSessionId="member" initialGroupId={group.id} onOpenSession={vi.fn()} onOpenTaskSession={vi.fn()} defaultSessionMode="shell" busy={busy} setBusy={setBusy} setError={setError} setNotice={vi.fn()} refresh={vi.fn().mockResolvedValue(undefined)} /></>;
}
function open() { fireEvent.click(screen.getByRole('button', { name: '组设置' })); }
const nameInput = () => screen.getByRole('textbox', { name: '协作组名称' }) as HTMLInputElement;
const rulesInput = () => screen.getByRole('textbox', { name: '群规与协作约定' }) as HTMLTextAreaElement;
function edit(name = '名称草稿', rules = '群规草稿') {
  fireEvent.change(nameInput(), { target: { value: name } });
  fireEvent.change(rulesInput(), { target: { value: rules } });
}
beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.clearAllMocks(); });
afterEach(cleanup);

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
