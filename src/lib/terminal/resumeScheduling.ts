export const BACKGROUND_RESUME_INITIAL_DELAY_MS = 300;
export const BACKGROUND_RESUME_STAGGER_MS = 120;
export const FOREGROUND_RESUME_COALESCE_MS = 250;
export const VISIBLE_RECONNECT_WATCHDOG_MS = 60_000;

export function resolvePrioritySessionId(
  sessions: readonly { id: string; backendSessionId: string | null }[],
  requestedSessionId: string | null,
): string | null {
  if (!requestedSessionId) return null;
  return sessions.find((session) => (
    session.id === requestedSessionId || session.backendSessionId === requestedSessionId
  ))?.id ?? null;
}

export function selectConnectionForegroundSessionId(options: {
  prioritySessionId: string | null;
  activeSessionId: string | null;
  persistedActiveSessionId: string | null;
  firstSessionId: string | null;
}): string | null {
  return options.prioritySessionId
    ?? options.activeSessionId
    ?? options.persistedActiveSessionId
    ?? options.firstSessionId;
}

export function shouldStartInitialConnection(options: {
  sessionId: string;
  foregroundSessionId: string | null;
  foregroundReady: boolean;
}): boolean {
  return options.foregroundSessionId === null
    || options.sessionId === options.foregroundSessionId
    || options.foregroundReady;
}

export function shouldMountSessionViewport(options: {
  sessionId: string;
  foregroundSessionId: string | null;
  visibleSessionIds: ReadonlySet<string>;
  deferredViewportSessionIds: ReadonlySet<string>;
  isMobileLayout: boolean;
}): boolean {
  if (options.isMobileLayout) {
    return options.visibleSessionIds.has(options.sessionId);
  }
  return options.sessionId === options.foregroundSessionId
    || options.deferredViewportSessionIds.has(options.sessionId);
}

export function shouldRunResumeRequest(options: {
  sessionId: string;
  foregroundSessionId: string | null;
  requestToken: number;
  foregroundCompletedToken: number;
}): boolean {
  return options.requestToken === 0
    || options.foregroundSessionId === null
    || options.sessionId === options.foregroundSessionId
    || options.foregroundCompletedToken === options.requestToken;
}

export function shouldScheduleForegroundResume(
  lastScheduledAt: number | null,
  now: number,
): boolean {
  return lastScheduledAt === null || now - lastScheduledAt >= FOREGROUND_RESUME_COALESCE_MS;
}

export function shouldForceForegroundReconnect(options: {
  wasPageHidden: boolean;
  reason: string;
}): boolean {
  return options.wasPageHidden || options.reason === 'bfcache' || options.reason === 'online';
}

export function getVisibleReconnectWatchdogDelayMs(options: {
  isActive: boolean;
  isStreamReady: boolean;
  reconnectStartedAt: number | null;
  now: number;
}): number | null {
  if (!options.isActive || options.isStreamReady || options.reconnectStartedAt === null) {
    return null;
  }
  return Math.max(0, VISIBLE_RECONNECT_WATCHDOG_MS - (options.now - options.reconnectStartedAt));
}

export function buildResumeDelayBySessionId(
  orderedSessionIds: readonly string[],
  visibleSessionIds: ReadonlySet<string>,
): Map<string, number> {
  const delays = new Map<string, number>();
  let backgroundIndex = 0;

  for (const sessionId of orderedSessionIds) {
    if (delays.has(sessionId)) continue;
    if (visibleSessionIds.has(sessionId)) {
      delays.set(sessionId, 0);
      continue;
    }
    delays.set(
      sessionId,
      BACKGROUND_RESUME_INITIAL_DELAY_MS + backgroundIndex * BACKGROUND_RESUME_STAGGER_MS,
    );
    backgroundIndex += 1;
  }

  return delays;
}
