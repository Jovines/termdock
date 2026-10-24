// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SplitPaneTitle } from './SplitPaneTitle';
import { getSessionDirectorySnapshot, useSessionDirectoryStore } from '../stores/useSessionDirectory';
import { useTerminalStore } from '../stores/useTerminalStore';

vi.mock('../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); useSessionDirectoryStore.getState().replace([]); useTerminalStore.setState({ sessions: new Map() }); });

it('renders and updates the canonical directory title instead of the pane’s stale name', () => {
  const record = { sessionId: 'pane', name: '完整会话标题', customName: true, lastActivity: 1, cwd: '/repo' };
  useSessionDirectoryStore.getState().replace([record]);
  render(<SplitPaneTitle session={{ id: 'pane', name: 'tmux:wt-internal', customName: false, mode: 'tmux', tmuxSessionName: 'wt-internal' }} active onActivate={() => {}} />);
  expect(screen.getByText(getSessionDirectorySnapshot()[0].displayName)).toBeTruthy();
  act(() => useSessionDirectoryStore.getState().replace([{ ...record, name: '更新后的完整标题' }]));
  expect(screen.getByText('更新后的完整标题')).toBeTruthy();
  expect(screen.queryByText('tmux:wt-internal')).toBeNull();
});
