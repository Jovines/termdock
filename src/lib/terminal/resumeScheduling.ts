export const BACKGROUND_RESUME_INITIAL_DELAY_MS = 300;
export const BACKGROUND_RESUME_STAGGER_MS = 120;
export const FOREGROUND_RESUME_COALESCE_MS = 250;
export const VISIBLE_RECONNECT_WATCHDOG_MS = 60_000;

export function shouldScheduleForegroundResume(
  lastScheduledAt: number | null,
  now: number,
): boolean {
  return lastScheduledAt === null || now - lastScheduledAt >= FOREGROUND_RESUME_COALESCE_MS;
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
