// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { getSessionDirectorySnapshot, sessionOption, useSessionDirectory, useSessionDirectoryStore } from './useSessionDirectory';
import { useTerminalStore } from './useTerminalStore';
import type { TerminalSessionState } from '../terminal/types';
import { getSessionDisplayName } from '../terminal/display';

const record = { sessionId: 'one', name: 'tmux:wt-internal', backendSessionId: 'backend', lastActivity: 1, cwd: '/repo',
  activeProgram: 'codex', shellTitle: '项目审查', agent: { slug: 'codex', displayName: 'Codex', accentColor: 'var(--primary)', icon: null } };
beforeEach(() => { localStorage.clear(); useSessionDirectoryStore.getState().replace([]); useTerminalStore.setState({ sessions: new Map() }); });
afterEach(cleanup);
function Options() { const sessions = useSessionDirectory(); return <select aria-label="会话">{sessions.map(session => <option key={session.sessionId} value={session.sessionId}>{session.displayName}</option>)}</select>; }
it('uses the complete sidebar title chain for every option without exposing persistence names', () => {
  useSessionDirectoryStore.getState().replace([record]);
  const session = getSessionDirectorySnapshot()[0];
  expect(session.displayName).toBe(getSessionDisplayName(record, 'codex', '/repo', undefined, record.shellTitle));
  expect(session.displayName).toBe('项目审查'); expect('name' in session).toBe(false);
  expect(sessionOption({ ...record, name: '手动会话名', customName: true }).displayName).toBe('手动会话名');
});
it('updates an open selector from live titles, renames and deletion using the main reconciled list', () => {
  useSessionDirectoryStore.getState().replace([record]); render(<Options />);
  expect(screen.getByRole('option').textContent).toBe('项目审查');
  act(() => useTerminalStore.setState({ sessions: new Map([['one', { terminalSessionId: 'backend', shellTitle: '修复输入体验', activeProgram: 'codex', cwd: '/repo' } as TerminalSessionState]]) }));
  expect(screen.getByRole('option').textContent).toBe('修复输入体验');
  act(() => useSessionDirectoryStore.getState().replace([{ ...record, name: '重命名后的会话', customName: true }]));
  expect(screen.getByRole('option').textContent).toBe('重命名后的会话');
  act(() => useSessionDirectoryStore.getState().replace([])); expect(screen.queryByRole('option')).toBeNull();
});
it('rejects stale metadata from another backend and never shows generated route IDs', () => {
  expect(sessionOption(record, { terminalSessionId: 'old-backend', shellTitle: '旧会话内容' }).displayName).toBe('项目审查');
  for (const name of ['tmux:wt-private', 'remote:service:private', 'wt-private', 'one', '']) {
    expect(sessionOption({ ...record, name, activeProgram: null, cwd: null, shellTitle: null }).displayName).toBe('Codex');
  }
});
it('retains the sidebar cold-start title cache until live metadata arrives', () => {
  localStorage.setItem('termdock-shell-titles-v1', JSON.stringify({ one: '缓存的会话标题' }));
  const cached = { ...record, shellTitle: null };
  expect(sessionOption(cached, { terminalSessionId: 'backend', shellTitle: null }).displayName).toBe('缓存的会话标题');
  expect(sessionOption(cached, { terminalSessionId: 'backend', shellTitle: '实时标题' }).displayName).toBe('实时标题');
});
it('uses the main program-detection configuration instead of a separate shell-name list', () => {
  const custom = { ...record, activeProgram: 'customsh', shellTitle: null };
  expect(sessionOption(custom, undefined, new Set(['customsh'])).displayName).toBe('repo');
  expect(sessionOption(custom).displayName).toBe('customsh');
});
