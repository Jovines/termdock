import { describe, expect, it } from 'vitest';
import {
  shouldNotifyAgentTransition,
  type AgentPushState,
} from './pushService';

function state(overrides: Partial<AgentPushState> = {}): AgentPushState {
  return {
    agentStatus: 'working',
    agentMessage: null,
    agentActivity: 1,
    reviewed: false,
    agent: { displayName: 'Codex' },
    ...overrides,
  };
}

describe('agent push transitions', () => {
  it('notifies only for a new attention state', () => {
    expect(shouldNotifyAgentTransition(state(), state({ agentStatus: 'waiting' }))).toBe(true);
    expect(shouldNotifyAgentTransition(
      state({ agentStatus: 'waiting' }),
      state({ agentStatus: 'waiting' }),
    )).toBe(false);
    expect(shouldNotifyAgentTransition(
      state({ agentStatus: 'waiting' }),
      state({ agentStatus: 'waiting', agentActivity: 2 }),
    )).toBe(true);
  });

  it('does not notify for reviewed or initial snapshots', () => {
    expect(shouldNotifyAgentTransition(null, state({ agentStatus: 'done' }))).toBe(false);
    expect(shouldNotifyAgentTransition(
      state(),
      state({ agentStatus: 'done', reviewed: true }),
    )).toBe(false);
  });

  it('notifies when an unreviewed agent exits', () => {
    expect(shouldNotifyAgentTransition(state(), state({ agentStatus: null }))).toBe(true);
  });
});
