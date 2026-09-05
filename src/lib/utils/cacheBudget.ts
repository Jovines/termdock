/** Evict oldest inactive entries. Visible branches are protected from reload churn. */
export function trimCache<K, V>(cache: Map<K, V>, limit: number, protectedKeys: ReadonlySet<K> = new Set()): Map<K, V> {
  for (const key of cache.keys()) {
    if (cache.size <= limit) break;
    if (!protectedKeys.has(key)) cache.delete(key);
  }
  return cache;
}
