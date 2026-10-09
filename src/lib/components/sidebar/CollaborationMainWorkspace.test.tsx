// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CollaborationMainWorkspace from './CollaborationMainWorkspace';
import { useCollaborationNavigation } from '../../stores/useCollaborationNavigation';

const api = vi.hoisted(() => ({ settings: vi.fn(), updateSettings: vi.fn(), groups: vi.fn(), messages: vi.fn(), send: vi.fn() }));
vi.mock('../../terminal/api', async importOriginal => ({
  ...await importOriginal<typeof import('../../terminal/api')>(),
  getSettings: api.settings, updateSettings: api.updateSettings,
  getAgentLaunchers: vi.fn().mockResolvedValue([]),
  listCollaborationGroups: api.groups, subscribeCollaborationGroups: vi.fn(() => () => {}),
  listCollaborationMessages: api.messages, sendCollaborationMessage: api.send,
  listCollaborationTasks: vi.fn().mockResolvedValue({ tasks: [] }),
}));
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  useCollaborationNavigation.setState({ groupId: 'main-fixture', drafts: {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  api.settings.mockResolvedValue({}); api.updateSettings.mockResolvedValue({});
  api.groups.mockResolvedValue({ groups: [{ id: 'main-fixture', name: '纯数据主工作区', sessionIds: ['fixture-member'], createdAt: 1, updatedAt: 1 }], sessions: [] });
  api.messages.mockResolvedValue({ messages: [] });
  api.send.mockResolvedValue({ messages: [], deliveries: [{ sessionId: 'fixture-member', delivered: [], pending: 1, serviceUnavailable: true }] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('preserves complete typing through main-workspace draft echoes, accepts other-pane edits, and sends only the current text', async () => {
  const user = userEvent.setup();
  render(<CollaborationMainWorkspace groupId="main-fixture" activeSessionId={null} onOpenSidebar={() => {}} defaultSessionMode="shell" />);
  await screen.findByRole('heading', { name: '任务看板' });
  await user.click(screen.getByRole('button', { name: '成员与消息' }));
  expect(screen.getByRole('button', { name: '成员与消息' }).getAttribute('aria-pressed')).toBe('true');
  const field = screen.getByPlaceholderText(/输入消息/);
  const first = '请核对完整输入，保留正在编辑的新内容，不用旧草稿覆盖。';
  await user.type(field, first);
  expect(field).toHaveProperty('value', first);
  expect(useCollaborationNavigation.getState().drafts['main-fixture']?.content).toBe(first);
  act(() => useCollaborationNavigation.getState().setDraft('main-fixture', { content: '另一面板的新草稿', targets: null }));
  expect(field).toHaveProperty('value', '另一面板的新草稿');
  await user.type(field, '，继续补全。');
  const complete = '另一面板的新草稿，继续补全。';
  expect(field).toHaveProperty('value', complete);
  await user.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(api.send).toHaveBeenCalledOnce());
  expect(api.send).toHaveBeenCalledWith('main-fixture', expect.objectContaining({ content: complete, fromSessionId: null }));
  await screen.findByText(/服务不可达，尚未送达/);
  expect(screen.queryByText(/消息已送达/)).toBeNull();
  expect(field).toHaveProperty('value', '');
});

it('does not move focus back to navigation after the user has started editing', async () => {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length; });
  render(<CollaborationMainWorkspace groupId="main-fixture" activeSessionId={null} onOpenSidebar={() => {}} defaultSessionMode="shell" />);
  await screen.findByRole('heading', { name: '任务看板' });
  fireEvent.click(screen.getByRole('button', { name: '成员与消息' }));
  const field = screen.getByPlaceholderText(/输入消息/);
  field.focus(); fireEvent.change(field, { target: { value: '下一帧前已开始编辑' } });
  act(() => { for (const callback of frames.splice(0)) callback(performance.now()); });
  expect(document.activeElement).toBe(field);
  expect(field).toHaveProperty('value', '下一帧前已开始编辑');
  expect(useCollaborationNavigation.getState().drafts['main-fixture']?.content).toBe('下一帧前已开始编辑');
});
