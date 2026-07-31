import { describe, expect, it } from 'vitest';
import {
  agentNotificationText,
  shouldNotifyAgentTransition,
  terminalExitText,
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

  it('notifies for waiting even when reviewed is already true (real hook flow)', () => {
    // In the real state machine reviewed stays true while working/waiting and
    // only `stop` clears it — the old reviewed gate suppressed the core
    // "agent needs your input" push entirely.
    expect(shouldNotifyAgentTransition(
      state({ agentStatus: 'working', reviewed: true }),
      state({ agentStatus: 'waiting', reviewed: true }),
    )).toBe(true);
    // A new waiting round (activity moved) re-notifies too.
    expect(shouldNotifyAgentTransition(
      state({ agentStatus: 'waiting', reviewed: true }),
      state({ agentStatus: 'waiting', agentActivity: 2, reviewed: true }),
    )).toBe(true);
    // Resuming to working is not an attention event.
    expect(shouldNotifyAgentTransition(
      state({ agentStatus: 'waiting', reviewed: true }),
      state({ agentStatus: 'working', reviewed: true }),
    )).toBe(false);
  });

  it('does not notify for initial snapshots or ack-only reviewed flips', () => {
    expect(shouldNotifyAgentTransition(null, state({ agentStatus: 'done' }))).toBe(false);
    expect(shouldNotifyAgentTransition(
      state({ agentStatus: 'waiting', reviewed: false }),
      state({ agentStatus: 'waiting', reviewed: true }),
    )).toBe(false);
    expect(shouldNotifyAgentTransition(
      state({ agentStatus: 'done' }),
      state({ agentStatus: 'done' }),
    )).toBe(false);
  });

  it('notifies when a working or waiting agent exits', () => {
    expect(shouldNotifyAgentTransition(state(), state({ agentStatus: null }))).toBe(true);
    expect(shouldNotifyAgentTransition(
      state({ agentStatus: 'waiting', reviewed: true }),
      state({ agentStatus: null, reviewed: true }),
    )).toBe(true);
    // A hook-emitted session-end lands on 'idle' before the process poll
    // clears the session — that must count as the same exit.
    expect(shouldNotifyAgentTransition(
      state({ agentStatus: 'waiting' }),
      state({ agentStatus: 'idle' }),
    )).toBe(true);
    // Exit after done was already notified → stay silent.
    expect(shouldNotifyAgentTransition(
      state({ agentStatus: 'done' }),
      state({ agentStatus: null }),
    )).toBe(false);
  });
});

describe('push notification copy', () => {
  it('localizes agent transition text per subscription locale', () => {
    expect(agentNotificationText('zh-CN', 'waiting', 'Codex')).toEqual({
      title: 'Codex 需要你的处理',
      body: '点按返回对应会话',
    });
    expect(agentNotificationText('en-US', 'waiting', 'Codex')).toEqual({
      title: 'Codex needs your input',
      body: 'Tap to return to the session',
    });
    expect(agentNotificationText('en-US', 'done', 'Codex').title).toBe('Codex finished');
    expect(agentNotificationText('en-US', 'exited', 'Codex').title).toBe('Codex exited');
    // Any non-zh locale falls back to English.
    expect(agentNotificationText('ja-JP', 'done', 'Codex').title).toBe('Codex finished');
  });

  it('localizes terminal exit text and embeds the exit code', () => {
    expect(terminalExitText('zh-CN', 1)).toEqual({
      title: '终端会话已退出',
      body: '进程已退出(代码 1),点按查看',
    });
    expect(terminalExitText('en-US', 137)).toEqual({
      title: 'Terminal session ended',
      body: 'Process exited (code 137). Tap to view.',
    });
    expect(terminalExitText('en-US', null).body).toBe('Process exited. Tap to view.');
  });
});
