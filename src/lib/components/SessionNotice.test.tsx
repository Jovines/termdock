// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ControlEvent } from '../utils/clientStateSync';
const state = vi.hoisted(() => ({ active: true, listener: null as null | ((event: ControlEvent) => void), focus: vi.fn(() => true) }));
vi.mock('../utils/clientStateSync', () => ({ subscribeClientState: (listener: (event: ControlEvent) => void) => { state.listener = listener; return () => { state.listener = null; }; } }));
vi.mock('../federation/browserIntegration', () => ({ savedConnection: () => ({ targetPeerId: 'remote-service' }) }));
vi.mock('../services/workspaceHost', () => ({ getWorkspaceHost: () => ({ focusSession: state.focus }), isWorkspaceActive: () => state.active, WORKSPACE_VISIBILITY_EVENT: 'termdock:workspace-visibility' }));
vi.mock('../i18n', () => ({ useI18n: () => ({ locale: 'zh' }) }));
import { useTerminalStore } from '../stores/useTerminalStore';
import { useSessionNoticeStore } from '../stores/useSessionNoticeStore';
import { SessionNoticeUnreadBadge } from './SessionNoticeUnreadBadge';
import { SessionNoticeBridge, SessionNoticeCenter } from './SessionNotice';
afterEach(() => { cleanup(); useSessionNoticeStore.setState({ unread: {}, viewing: null }); state.active = true; vi.clearAllMocks(); state.focus.mockReturnValue(true); });
const event = { type: 'session-notice' as const, id: 'notice-1', sessionId: 'source-session', sessionName: '编译任务', message: '<script>progress</script>', createdAt: 1 };

it('shows progress without changing the active session, deduplicates, then focuses its source on click', () => {
  render(<><SessionNoticeCenter /><SessionNoticeBridge /></>);
  act(() => { state.listener!(event); state.listener!(event); });
  expect(screen.getByText(event.message).textContent).toBe(event.message);
  expect(document.querySelector('script')).toBeNull();
  expect(screen.getAllByRole('button', { name: '查看 Session' })).toHaveLength(1);
  expect(state.focus).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '查看 Session' }));
  expect(state.focus).toHaveBeenCalledWith('remote-service', 'source-session');
  expect(screen.queryByText(event.message)).toBeNull();
});

it('queues separate progress events, dismisses without navigation, and retains a failed navigation', () => {
  render(<><SessionNoticeCenter /><SessionNoticeBridge /></>);
  act(() => { state.listener!(event); state.listener!({ ...event, id: 'notice-2', message: 'Second milestone' }); });
  expect(screen.getByText('还有 1 条')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '关闭提醒' }));
  expect(state.focus).not.toHaveBeenCalled();
  expect(screen.getByText('Second milestone')).toBeTruthy();
  state.focus.mockReturnValue(false);
  fireEvent.click(screen.getByRole('button', { name: '查看 Session' }));
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(screen.getByText('Second milestone')).toBeTruthy();
});

it('keeps the unread badge after dismissing the toast and clears it only when the source becomes visible', () => {
  useTerminalStore.setState({ activeSessionId: 'other-session' });
  render(<><SessionNoticeCenter /><SessionNoticeBridge /><SessionNoticeUnreadBadge sessionIds={['source-session']} /></>);
  act(() => { state.listener!(event); });
  expect(screen.getByLabelText('1 条未读进展')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '关闭提醒' }));
  expect(screen.getByLabelText('1 条未读进展')).toBeTruthy();
  act(() => useTerminalStore.getState().setActiveSessionId('source-session'));
  expect(screen.queryByLabelText('1 条未读进展')).toBeNull();
  act(() => { state.listener!({ ...event, id: 'new-notice' }); });
  expect(screen.queryByLabelText('1 条未读进展')).toBeNull();
  expect(screen.getByText(event.message)).toBeTruthy();
});

it('does not acknowledge a selected session in a hidden workspace until activation', () => {
  state.active = false;
  useTerminalStore.setState({ activeSessionId: 'source-session' });
  render(<><SessionNoticeCenter /><SessionNoticeBridge /><SessionNoticeUnreadBadge sessionIds={['source-session']} /></>);
  act(() => { state.listener!(event); });
  expect(screen.getByLabelText('1 条未读进展')).toBeTruthy();
  act(() => { state.active = true; window.dispatchEvent(new Event('termdock:workspace-visibility')); });
  expect(screen.queryByLabelText('1 条未读进展')).toBeNull();
});
