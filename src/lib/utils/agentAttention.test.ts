import { describe, expect, it } from 'vitest';
import {
  getNextAttentionSessionId,
  getNextRunningSessionId,
  isAgentRunning,
  needsAgentAttention,
  shouldShowTuiLoading,
  type AgentAttentionSession,
} from './agentAttention';

describe('native terminal loading fallback', () => {
  it('shows active progress even when hooks retained an idle or acknowledged done phase', () => {
    for (const agentStatus of [null, 'idle', 'done'] as const) {
      expect(shouldShowTuiLoading({ agentStatus, tuiProgress: { state: 'indeterminate', progress: null } })).toBe(true);
      expect(shouldShowTuiLoading({ agentStatus, tuiProgress: { state: 'set', progress: 10 } })).toBe(true);
    }
  });

  it('preserves hook activity and attention indicators and ignores stopped progress', () => {
    for (const agentStatus of ['working', 'waiting'] as const) {
      expect(shouldShowTuiLoading({ agentStatus, tuiProgress: { state: 'indeterminate', progress: null } })).toBe(false);
    }
    expect(shouldShowTuiLoading({ agentStatus: 'done', agentNeedsReview: true, tuiProgress: { state: 'set', progress: 10 } })).toBe(false);
    for (const state of ['remove', 'error', 'pause'] as const) {
      expect(shouldShowTuiLoading({ agentStatus: 'idle', tuiProgress: { state, progress: null } })).toBe(false);
    }
    expect(shouldShowTuiLoading({ agentStatus: 'idle', tuiProgress: null })).toBe(false);
    expect(shouldShowTuiLoading()).toBe(false);
  });
});

function session(
  sessionId: string,
  options: Partial<AgentAttentionSession> = {},
): AgentAttentionSession {
  return {
    sessionId,
    agentStatus: null,
    agentNeedsReview: false,
    ...options,
  };
}

describe('agent attention navigation', () => {
  it('treats waiting and unread results as attention states', () => {
    expect(needsAgentAttention(session('waiting', { agentStatus: 'waiting' }))).toBe(true);
    expect(needsAgentAttention(session('unread', { agentNeedsReview: true }))).toBe(true);
    expect(needsAgentAttention(session('working', { agentStatus: 'working' }))).toBe(false);
  });

  it('moves forward from the active session and wraps', () => {
    const sessions = [
      session('a', { agentNeedsReview: true }),
      session('b'),
      session('c', { agentStatus: 'waiting' }),
    ];

    expect(getNextAttentionSessionId(sessions, 'a')).toBe('c');
    expect(getNextAttentionSessionId(sessions, 'c')).toBe('a');
  });

  it('moves backward from the active session and wraps', () => {
    const sessions = [
      session('a', { agentNeedsReview: true }),
      session('b'),
      session('c', { agentStatus: 'waiting' }),
    ];

    expect(getNextAttentionSessionId(sessions, 'a', 'previous')).toBe('c');
    expect(getNextAttentionSessionId(sessions, 'c', 'previous')).toBe('a');
  });

  it('returns the only attention session even when it is already active', () => {
    const sessions = [
      session('a'),
      session('b', { agentNeedsReview: true }),
    ];

    expect(getNextAttentionSessionId(sessions, 'b')).toBe('b');
  });

  it('returns null when nothing needs attention', () => {
    expect(getNextAttentionSessionId([session('a'), session('b')], 'a')).toBeNull();
  });

  it('cycles only through running sessions', () => {
    const sessions = [
      session('a', { agentStatus: 'working' }),
      session('b', { agentStatus: 'waiting' }),
      session('c', { agentStatus: 'working' }),
    ];

    expect(isAgentRunning(sessions[0]!)).toBe(true);
    expect(isAgentRunning(sessions[1]!)).toBe(false);
    expect(getNextRunningSessionId(sessions, 'a')).toBe('c');
    expect(getNextRunningSessionId(sessions, 'c')).toBe('a');
  });
});
