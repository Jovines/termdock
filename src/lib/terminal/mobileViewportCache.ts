export const MOBILE_VIEWPORT_CACHE_IDLE_MS = 5 * 60_000;
export const MOBILE_VIEWPORT_CACHE_MAX_SESSIONS = 4;
export const MOBILE_VIEWPORT_CACHE_SWEEP_INTERVAL_MS = 30_000;

export function selectCachedMobileViewportSessionIds(options: {
  currentVisibleSessionIds: ReadonlySet<string>;
  lastVisitedAtBySessionId: ReadonlyMap<string, number>;
  validSessionIds: ReadonlySet<string>;
  now: number;
  idleMs?: number;
  maxSessions?: number;
}): Set<string> {
  const selected = new Set(
    [...options.currentVisibleSessionIds].filter((sessionId) => options.validSessionIds.has(sessionId)),
  );
  const idleMs = options.idleMs ?? MOBILE_VIEWPORT_CACHE_IDLE_MS;
  const maxSessions = Math.max(selected.size, options.maxSessions ?? MOBILE_VIEWPORT_CACHE_MAX_SESSIONS);
  const remainingSlots = maxSessions - selected.size;
  if (remainingSlots === 0) return selected;

  const retainedBackgroundIds = [...options.lastVisitedAtBySessionId]
    .filter(([sessionId, lastVisitedAt]) => (
      options.validSessionIds.has(sessionId)
      && !selected.has(sessionId)
      && Number.isFinite(lastVisitedAt)
      && options.now - lastVisitedAt < idleMs
    ))
    .sort((left, right) => right[1] - left[1])
    .slice(0, remainingSlots)
    .map(([sessionId]) => sessionId);

  retainedBackgroundIds.forEach((sessionId) => selected.add(sessionId));
  return selected;
}
