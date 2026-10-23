// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { listCollaborationTasks, type CollaborationTaskView } from '../../terminal/api';
import { useCollaborationTaskInbox } from '../../stores/useCollaborationTaskInbox';
import { LeftSidebar } from './LeftSidebar';
import { AppFeedbackHost } from '../ui/AppFeedback';
import { SECURE_READY_EVENT } from '../../federation/connectionRecovery';

vi.mock('../../terminal/api', async (original) => ({
  ...await original<typeof import('../../terminal/api')>(),
  listCollaborationTasks: vi.fn(),
}));

const listTasks = vi.mocked(listCollaborationTasks);
const pendingTask = {
  id: 'question', groupId: 'team', title: '确认执行方案', status: 'open',
  decisions: [{ status: 'pending' }],
} as CollaborationTaskView;

beforeEach(() => {
  useCollaborationTaskInbox.setState({ tasks: [], allTasks: [], error: null });
  listTasks.mockReset().mockResolvedValue({ tasks: [] });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ locale: 'en', agents: [], groups: [] }))));
});

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function renderSidebar() {
  render(<I18nProvider><AppFeedbackHost /><LeftSidebar
    isOpen pinned drawerWidthPx={280} sessions={[]} activeSessionId={null}
    sessionStates={new Map()} splitWorkspaces={[]}
    onClose={vi.fn()} onNewSession={vi.fn()} onCloseSession={vi.fn()}
    onSplitSession={vi.fn()} onCloseSplit={vi.fn()} onRemoveFromSplit={vi.fn()}
    onSetSplitLayout={vi.fn()} onReorderSplitWorkspace={vi.fn()}
    onRenameSplitWorkspace={vi.fn()} onCombineSplitSessions={vi.fn()}
    onReorderSessions={vi.fn()} onOpenSettings={vi.fn()}
  /></I18nProvider>);
}

it('keeps the empty inbox hidden during first-load failure and recovery', async () => {
  listTasks.mockRejectedValueOnce(new Error('正在连接'));
  renderSidebar();
  await waitFor(() => expect(useCollaborationTaskInbox.getState().error).toBe('正在连接'));
  expect(screen.queryByRole('region', { name: '协作待处理事项' })).toBeNull();

  await act(async () => { await useCollaborationTaskInbox.getState().refresh(); });
  expect(useCollaborationTaskInbox.getState().error).toBeNull();
  expect(screen.queryByRole('region', { name: '协作待处理事项' })).toBeNull();
});

it('does not create an empty attention card when reconnecting after a successful load', async () => {
  renderSidebar();
  await waitFor(() => expect(listTasks).toHaveBeenCalledOnce());
  listTasks.mockRejectedValueOnce(new Error('正在重连'));
  await act(async () => { await useCollaborationTaskInbox.getState().refresh(); });
  expect(useCollaborationTaskInbox.getState().error).toBe('正在重连');
  expect(screen.queryByRole('region', { name: '协作待处理事项' })).toBeNull();
});

it('preserves actual pending tasks and retry feedback through a failed refresh', async () => {
  listTasks.mockResolvedValueOnce({ tasks: [pendingTask] });
  renderSidebar();
  const inbox = await screen.findByRole('button', { name: '需要你处理 1' });
  vi.useFakeTimers();
  listTasks.mockRejectedValueOnce(new Error('连接中断'));
  await act(async () => { await useCollaborationTaskInbox.getState().refresh(); });
  fireEvent.click(inbox);
  expect(screen.getByText(pendingTask.title)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(2500));
  expect(screen.getByText('正在恢复待办同步…')).toBeTruthy();

  await act(async () => { window.dispatchEvent(new Event(SECURE_READY_EVENT)); });
  expect(screen.queryByText('正在恢复待办同步…')).toBeNull();
  expect(screen.queryByRole('region', { name: '协作待处理事项' })).toBeNull();
});
