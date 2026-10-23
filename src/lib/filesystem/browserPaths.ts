// Keep paths lexical: resolving symlinks or `..` here would change which
// service-side directory the user is browsing.
export function normalizeDirectory(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}

export function parentDirectory(path: string): string {
  const normalized = normalizeDirectory(path);
  return normalized.slice(0, normalized.lastIndexOf('/')) || '/';
}

export function isWithinDirectory(path: string, root: string): boolean {
  const normalized = normalizeDirectory(path);
  const boundary = normalizeDirectory(root);
  return normalized === boundary || normalized.startsWith(boundary === '/' ? '/' : `${boundary}/`);
}

export function relativeDirectoryPath(path: string, root: string): string | null {
  if (!isWithinDirectory(path, root)) return null;
  const normalized = normalizeDirectory(path);
  const boundary = normalizeDirectory(root);
  return normalized === boundary ? '' : normalized.slice(boundary === '/' ? 1 : boundary.length + 1);
}
