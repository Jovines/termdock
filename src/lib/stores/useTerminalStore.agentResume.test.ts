// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { useTerminalStore } from './useTerminalStore';

afterEach(() => {
  useTerminalStore.getState().clearAllTerminalSessions();
});

describe('Agent crash recovery state', () => {
  it('survives rebinding the frontend tab to a replacement PTY', () => {
    const store = useTerminalStore.getState();
    store.setAgentResumeRecovered('frontend-1', true);
    store.setTerminalSession('frontend-1', {
      sessionId: 'backend-2',
      cols: 80,
      rows: 24,
      mode: 'shell',
      cwd: '/repo',
    });

    expect(useTerminalStore.getState().sessions.get('frontend-1')).toMatchObject({
      terminalSessionId: 'backend-2',
      agentResumeRecovered: true,
    });
  });

  it('clears when the server confirms an Agent session has started', () => {
    const store = useTerminalStore.getState();
    store.setAgentResumeRecovered('frontend-1', true);
    store.setSessionAgentStatus('frontend-1', {
      agentStatus: 'idle',
      agentNativeSessionId: 'native-1',
      agentResumeRecovered: false,
      reviewed: true,
    });

    expect(useTerminalStore.getState().sessions.get('frontend-1')?.agentResumeRecovered).toBe(false);
  });
});
