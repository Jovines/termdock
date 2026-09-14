/** The entry document cannot be removed because it owns the workspace host. */
export const TOUCH_WORKSPACE_LIMIT = 3;
export const DESKTOP_WORKSPACE_LIMIT = Infinity;
export const MAX_FINITE_WORKSPACE_LIMIT = 10;
// Shared by service documents; the secure prefix bypasses service-local scoping.
export const WORKSPACE_LIMIT_KEY = 'termdock-secure-workspace-limit';

export function isWorkspaceLimit(value: number): boolean {
  return value === Infinity || (Number.isInteger(value) && value >= 3 && value <= MAX_FINITE_WORKSPACE_LIMIT);
}

export function readWorkspaceLimit(): number {
  try {
    const saved = localStorage.getItem(WORKSPACE_LIMIT_KEY);
    const value = saved === 'unlimited' ? Infinity : Number(saved);
    if (isWorkspaceLimit(value)) return value;
  } catch { /* Use the device default when storage is unavailable. */ }
  return navigator.maxTouchPoints > 0 ? TOUCH_WORKSPACE_LIMIT : DESKTOP_WORKSPACE_LIMIT;
}

export function selectRetainedWorkspaces<T extends { key: string; touchedAt: number }>(
  items: readonly T[], activeKey: string, presentedKey: string | null, limit: number,
): readonly T[] {
  if (items.length <= limit) return items;
  const keep = new Set(['root', activeKey, ...(presentedKey ? [presentedKey] : [])]);
  // Reverse first so equally recent visits prefer the most recently added page.
  const recent = [...items].reverse().sort((a, b) => b.touchedAt - a.touchedAt);
  for (const item of recent) {
    if (keep.size >= limit) break;
    keep.add(item.key);
  }
  return items.filter(item => keep.has(item.key));
}
