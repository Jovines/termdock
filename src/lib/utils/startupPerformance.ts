const STARTUP_MARK_PREFIX = 'termdock:startup:';

export function markStartupMilestone(name: string): void {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return;
  const markName = `${STARTUP_MARK_PREFIX}${name}`;
  if (performance.getEntriesByName(markName, 'mark').length > 0) return;
  performance.mark(markName);
}
