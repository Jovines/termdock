function normalizeWatchRoot(root: string): string {
  return root.replace(/\/+$/, '') || '/';
}

function isSameOrDescendant(parent: string, candidate: string): boolean {
  if (parent === '/') return candidate.startsWith('/');
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

/** Recursive watcher roots form an antichain: an ancestor already covers its descendants. */
export function minimizeClientWatchRoots(roots: Iterable<string>): string[] {
  const sorted = [...new Set(Array.from(roots, normalizeWatchRoot))]
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const minimal: string[] = [];
  for (const root of sorted) {
    if (!minimal.some((parent) => isSameOrDescendant(parent, root))) minimal.push(root);
  }
  return minimal;
}
