import type { AgentStatus } from '../terminal/types';

export interface AgentAttentionSession {
  sessionId: string;
  agentStatus: AgentStatus | null;
  agentNeedsReview?: boolean;
}

export function needsAgentAttention(session: AgentAttentionSession): boolean {
  return session.agentStatus === 'waiting' || session.agentNeedsReview === true;
}

export function isAgentRunning(session: AgentAttentionSession): boolean {
  return session.agentStatus === 'working';
}

function getNextMatchingSessionId(
  sessions: readonly AgentAttentionSession[],
  activeSessionId: string | null,
  predicate: (session: AgentAttentionSession) => boolean,
  direction: 'next' | 'previous' = 'next',
): string | null {
  if (sessions.length === 0) return null;

  const activeIndex = activeSessionId
    ? sessions.findIndex((session) => session.sessionId === activeSessionId)
    : -1;

  for (let offset = 1; offset <= sessions.length; offset += 1) {
    const delta = direction === 'next' ? offset : -offset;
    const index = (activeIndex + delta + sessions.length) % sessions.length;
    const session = sessions[index];
    if (session && predicate(session)) return session.sessionId;
  }

  return null;
}

/**
 * Pick the next attention session in the same stable order used by the terminal
 * store. The search starts after the active session and wraps once, so repeated
 * clicks cycle through parallel tasks instead of repeatedly selecting the first.
 */
export function getNextAttentionSessionId(
  sessions: readonly AgentAttentionSession[],
  activeSessionId: string | null,
  direction: 'next' | 'previous' = 'next',
): string | null {
  return getNextMatchingSessionId(sessions, activeSessionId, needsAgentAttention, direction);
}

/** Pick the next actively running agent session and wrap at the end. */
export function getNextRunningSessionId(
  sessions: readonly AgentAttentionSession[],
  activeSessionId: string | null,
): string | null {
  return getNextMatchingSessionId(sessions, activeSessionId, isAgentRunning);
}
