import type { TerminalRendererMode } from './renderer';

export const WEBGL_SESSION_BUDGET = 5;

export function normalizeRecentSessionIds(
  recentSessionIds: readonly string[],
  activeSessionId: string | null,
  sessionIds: readonly string[],
  adjacentSessionIds: readonly string[] = [],
  budget: number = WEBGL_SESSION_BUDGET,
): string[] {
  if (budget <= 0) {
    return [];
  }

  const available = new Set(sessionIds);
  const next: string[] = [];

  const push = (sessionId: string | null | undefined) => {
    if (!sessionId || !available.has(sessionId) || next.includes(sessionId)) {
      return;
    }
    next.push(sessionId);
  };

  push(activeSessionId);
  for (const sessionId of adjacentSessionIds) {
    if (next.length >= budget) break;
    push(sessionId);
  }
  for (const sessionId of recentSessionIds) {
    if (next.length >= budget) break;
    push(sessionId);
  }

  return next.slice(0, budget);
}

export function getEffectiveRendererModeForSession(
  requestedMode: TerminalRendererMode,
  sessionId: string,
  webglSessionIds: ReadonlySet<string>,
): TerminalRendererMode {
  if (requestedMode !== 'webgl' && requestedMode !== 'auto') {
    return requestedMode;
  }
  return webglSessionIds.has(sessionId) ? 'webgl' : 'canvas';
}
