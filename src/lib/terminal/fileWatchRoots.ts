function normalizeWatchRoot(root: string): string {
  return root.replace(/\/+$/, '') || '/';
}

/** Non-recursive directory watchers require every expanded directory. */
export function normalizeClientWatchRoots(roots: Iterable<string>): string[] {
  return [...new Set(Array.from(roots, normalizeWatchRoot))].sort((a, b) => a.localeCompare(b));
}
