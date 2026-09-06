export const BACKGROUND_RESUME_INITIAL_DELAY_MS = 300;
export const BACKGROUND_RESUME_STAGGER_MS = 120;
export const BACKGROUND_RESUME_MAX_HOLD_MS = 2000;
export const FOREGROUND_RESUME_COALESCE_MS = 250;
export const VISIBLE_RECONNECT_WATCHDOG_MS = 60_000;

/** Keep all visible split panes, then at most three viewports in total.
 * Recompute from the current slide, never the set of previously visited tabs.
 * Unmounting a viewport detaches the client; it does not terminate its PTY.
 */
export function selectMobileViewportSessionIds(options: {
  slides: readonly (readonly string[])[];
  visibleSessionIds: ReadonlySet<string>;
  foregroundSessionId: string | null;
}): ReadonlySet<string> {
  const existing = new Set(options.slides.flat());
  const retained = new Set([...options.visibleSessionIds].filter((id) => existing.has(id)));
  if (options.foregroundSessionId && existing.has(options.foregroundSessionId)) {
    retained.add(options.foregroundSessionId);
  }
  const activeIndex = options.slides.findIndex((slide) => slide.some((id) => retained.has(id)));
  if (activeIndex < 0) return retained;
  // Only immediate neighbours need a warm viewport for a swipe. Alternate
  // sides so a neighbouring split workspace cannot consume every spare slot.
  const previous = options.slides[activeIndex - 1] ?? [];
  const next = options.slides[activeIndex + 1] ?? [];
  for (let index = 0; index < Math.max(previous.length, next.length) && retained.size < 3; index += 1) {
    for (const id of [previous[index], next[index]]) {
      if (id && retained.size < 3) retained.add(id);
    }
  }
  return retained;
}

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
  isVisible?: boolean;
}): boolean {
  return options.foregroundSessionId === null
    || options.isVisible === true
    || options.sessionId === options.foregroundSessionId
    || options.foregroundReady;
}

export function shouldMountSessionViewport(options: {
  sessionId: string;
  foregroundSessionId: string | null;
  visibleSessionIds: ReadonlySet<string>;
  deferredViewportSessionIds: ReadonlySet<string>;
}): boolean {
  return options.sessionId === options.foregroundSessionId
    || options.visibleSessionIds.has(options.sessionId)
    || options.deferredViewportSessionIds.has(options.sessionId);
}

export function shouldDeferSessionSwitch(options: {
  isMobile: boolean;
  viewportReady: boolean;
  streamReady: boolean;
  contentReady: boolean;
}): boolean {
  return options.isMobile
    && (!options.viewportReady || !options.streamReady || !options.contentReady);
}

export function isInitialContentWriteSettled(options: {
  writtenChunkId: number | null;
  initialTargetChunkId: number | null;
}): boolean {
  return options.writtenChunkId !== null
    && options.initialTargetChunkId !== null
    && options.writtenChunkId >= options.initialTargetChunkId;
}

export function shouldRestartMissingTerminalConnection(options: {
  initialConnectionPending: boolean;
}): boolean {
  return !options.initialConnectionPending;
}

export function shouldPublishSessionDataUpdate(isRestoring: boolean): boolean {
  return !isRestoring;
}

export function shouldRunResumeRequest(options: {
  sessionId: string;
  foregroundSessionId: string | null;
  requestToken: number;
  foregroundCompletedToken: number;
  isVisible?: boolean;
}): boolean {
  return options.requestToken === 0
    || options.isVisible === true
    || options.foregroundSessionId === null
    || (options.isVisible === undefined && options.sessionId === options.foregroundSessionId)
    || options.foregroundCompletedToken === options.requestToken;
}

export function areVisibleResumeSessionsReady(
  visibleIds: ReadonlySet<string>,
  completedIds: ReadonlySet<string>,
): boolean {
  return [...visibleIds].every(id => completedIds.has(id));
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
  // Page/network restoration is not proof that an OPEN socket is dead.
  // The probe replaces closed sockets immediately and half-open ones on timeout.
  void options;
  return false;
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
