// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AgentTabIcon, AgentSessionDot } from './AgentIndicators';
import { I18nProvider } from '../i18n';
import { useTerminalStore } from '../stores/useTerminalStore';

afterEach(cleanup);
it('renders a native loading, question, completion, and error indicator even with an idle hook phase', () => {
  const state = { agentStatus: 'idle' as const, tuiProgress: { source: 'osc7501' as const, state: 'indeterminate' as const, progress: null, message: 'Native working' } };
  const view = render(<AgentTabIcon sessionMode="shell" state={state} />);
  expect(screen.getByTitle('Native working').querySelector('.animate-spin')).not.toBeNull();
  for (const phase of ['blocked', 'done', 'error'] as const) {
    view.rerender(<AgentTabIcon sessionMode="shell" state={{ ...state, tuiProgress: { ...state.tuiProgress, state: phase, message: phase } }} />);
    expect(screen.getByTitle(phase).querySelector('.animate-spin')).toBeNull();
    expect(screen.getByTitle(phase).querySelector('svg')).not.toBeNull();
  }
});

it('keeps explicit hook permission and review signals ahead of native progress', () => {
  const progress = { source: 'osc7501' as const, state: 'indeterminate' as const, progress: null, message: 'Native working' };
  const view = render(<AgentTabIcon sessionMode="shell" state={{ agentStatus: 'waiting', agentMessage: 'Hook permission', tuiProgress: progress }} />);
  expect(screen.getByTitle('Hook permission')).toBeTruthy();
  expect(screen.queryByTitle('Native working')).toBeNull();
  view.rerender(<I18nProvider><AgentSessionDot status="idle" progress={{ ...progress, state: 'blocked', message: 'Native approval' }} /></I18nProvider>);
  expect(screen.getByTitle('Native approval')).toBeTruthy();
});

it('updates changing native messages without manufacturing an Agent phase or tool activity', () => {
  const id = 'native-progress-fixture';
  const store = useTerminalStore.getState();
  store.setTerminalSession(id, { sessionId: 'native-backend', mode: 'shell', cwd: '/fixture', cols: 80, rows: 24 });
  const before = useTerminalStore.getState().sessions.get(id)!;
  store.setSessionTuiProgress(id, { source: 'osc7501', state: 'blocked', progress: null, message: 'First question' });
  store.setSessionTuiProgress(id, { source: 'osc7501', state: 'blocked', progress: null, message: 'Second question' });
  const after = useTerminalStore.getState().sessions.get(id)!;
  expect(after.tuiProgress?.message).toBe('Second question');
  expect(after.agentStatus).toBe(before.agentStatus);
  expect(after.agentActivity).toBe(before.agentActivity);
  store.removeTerminalSession(id);
});
