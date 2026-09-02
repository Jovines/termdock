export function parseExcludePatterns(value: string): string[] {
  return Array.from(new Set(value
    .split(/[\n,]/)
    .map((pattern) => pattern.trim().replace(/^!+/, ''))
    .filter(Boolean)))
    .slice(0, 24);
}

export function resolveSearchScopePath(rootPath: string, scope: string): string {
  const trimmed = scope.trim();
  if (!trimmed || trimmed === '.') return rootPath;
  if (/^(?:[/\\]|[A-Za-z]:[/\\])/.test(trimmed)) return trimmed.replace(/[\\/]+$/, '');
  return `${rootPath.replace(/[\\/]+$/, '')}/${trimmed.replace(/^\.?[\\/]+/, '').replace(/[\\/]+$/, '')}`;
}

export function describeSearchScope(rootPath: string, searchPath: string): string {
  if (searchPath === rootPath) return '.';
  const prefix = `${rootPath.replace(/[\\/]+$/, '')}/`;
  return searchPath.startsWith(prefix) ? searchPath.slice(prefix.length) : searchPath;
}
