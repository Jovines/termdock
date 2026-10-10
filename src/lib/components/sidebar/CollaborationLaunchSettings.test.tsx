// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { CollaborationLaunchSettings } from './CollaborationLaunchSettings';
import type { CollaborationGroup } from '../../terminal/api';
const save = vi.hoisted(() => vi.fn());
vi.mock('../../terminal/api', () => ({ saveCollaborationGroup: save }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const agents = [{ slug: 'codex', command: 'codex', displayName: 'Codex', accentColor: 'var(--primary)', icon: null }];
const profile = { id: 'fast', name: '快速排查', agentSlug: 'codex', command: 'codex --model example-fast', notes: '小问题使用，复杂实现不用。' };
function Setup({ group }: { group: CollaborationGroup }) {
  const [busy, setBusy] = useState<string | null>(null);
  return <CollaborationLaunchSettings group={group} agents={agents} busy={busy} setBusy={setBusy} refresh={async () => {}} />;
}
function open() { fireEvent.click(screen.getByText(/Agent 启动方案 ·/)); }
it('saves model parameters and notes with a group revision without launching anything', async () => {
  const group = { id: 'profiles-save', name: '实现组', sessionIds: ['lead'], createdAt: 1, updatedAt: 7, launchProfiles: [profile], defaultLaunchProfileId: 'fast' };
  save.mockResolvedValue({ group: { ...group, updatedAt: 8 } });
  render(<Setup group={group} />); open();
  fireEvent.change(screen.getByRole('textbox', { name: '启动命令' }), { target: { value: 'codex --model example-deep -c model_reasoning_effort=high' } });
  fireEvent.change(screen.getByRole('textbox', { name: '使用备注' }), { target: { value: '用于复杂代码实现；简单问题不要使用。' } });
  fireEvent.click(screen.getByRole('button', { name: '保存启动方案' }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ expectedUpdatedAt: 7, defaultLaunchProfileId: 'fast', launchProfiles: [expect.objectContaining({ command: 'codex --model example-deep -c model_reasoning_effort=high', notes: '用于复杂代码实现；简单问题不要使用。' })] }));
});
it('keeps a failed draft through remount and refuses to overwrite it on a live refresh', async () => {
  const group = { id: 'profiles-conflict', name: '实现组', sessionIds: ['lead'], createdAt: 1, updatedAt: 7, launchProfiles: [profile] };
  save.mockRejectedValue(Error('组已变化'));
  const view = render(<Setup group={group} />); open();
  fireEvent.change(screen.getByRole('textbox', { name: '使用备注' }), { target: { value: '保留新备注' } });
  fireEvent.click(screen.getByRole('button', { name: '保存启动方案' })); await screen.findByRole('alert');
  view.unmount(); const next = render(<Setup group={{ ...group, updatedAt: 8, launchProfiles: [{ ...profile, notes: '其他人修改' }] }} />); open();
  expect(screen.getByRole('textbox', { name: '使用备注' })).toHaveProperty('value', '保留新备注');
  fireEvent.click(screen.getByRole('button', { name: '重新载入（放弃方案草稿）' }));
  expect(screen.getByRole('textbox', { name: '使用备注' })).toHaveProperty('value', '其他人修改');
  next.unmount();
});
it('removes the default only on save and keeps incomplete new profiles from being submitted', async () => {
  const group = { id: 'profiles-remove', name: '实现组', sessionIds: ['lead'], createdAt: 1, updatedAt: 7, launchProfiles: [profile], defaultLaunchProfileId: 'fast' };
  save.mockResolvedValue({ group: { ...group, launchProfiles: [], defaultLaunchProfileId: null, updatedAt: 8 } });
  render(<Setup group={group} />); open();
  fireEvent.click(screen.getByRole('button', { name: '移除方案（保存后生效）' }));
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '保存启动方案' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ launchProfiles: [], defaultLaunchProfileId: null })));
  fireEvent.click(screen.getByRole('button', { name: '新增方案' }));
  expect((screen.getByRole('button', { name: '保存启动方案' }) as HTMLButtonElement).disabled).toBe(true);
});
it('keeps save confirmation visible after the directory refresh and can switch between saved profiles', async () => {
  const second = { ...profile, id: 'deep', name: '深度实现', notes: '复杂实现使用。' };
  const group = { id: 'profiles-refresh-success', name: '实现组', sessionIds: ['lead'], createdAt: 1, updatedAt: 7, launchProfiles: [profile, second] };
  let saved: CollaborationGroup;
  save.mockImplementation(async input => { saved = { ...group, ...input, updatedAt: 8 }; return { group: saved }; });
  const view = render(<Setup group={group} />); open();
  fireEvent.change(screen.getByRole('textbox', { name: '使用备注' }), { target: { value: '保存后的备注' } });
  fireEvent.click(screen.getByRole('button', { name: '保存启动方案' }));
  await screen.findByRole('status');
  view.rerender(<Setup group={saved!} />);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('启动方案已保存'));
  fireEvent.change(screen.getByRole('combobox', { name: '编辑方案' }), { target: { value: 'deep' } });
  expect(screen.getByRole('textbox', { name: '使用备注' })).toHaveProperty('value', '复杂实现使用。');
  fireEvent.change(screen.getByRole('combobox', { name: '编辑方案' }), { target: { value: 'fast' } });
  expect(screen.getByRole('textbox', { name: '使用备注' })).toHaveProperty('value', '保存后的备注');
});
