export function resolveAbsoluteReferencePath(path: string, rootPath: string | null): string {
  if (!path || path.startsWith('/')) return path;
  const relativePath = path.replace(/^\.\//, '');
  if (!rootPath) return relativePath;
  return `${rootPath.replace(/\/+$/, '')}/${relativePath}`;
}

export function buildFileReference(path: string, rootPath: string | null): string {
  return resolveAbsoluteReferencePath(path, rootPath);
}

export function buildReferenceInputText(path: string, rootPath: string | null): string {
  const reference = buildFileReference(path, rootPath);
  return reference.includes(' ') ? `"${reference}" ` : `${reference} `;
}

export function buildPromptReference(path: string, rootPath: string | null): string {
  const reference = buildFileReference(path, rootPath);
  return reference.includes(' ') ? `"${reference}"` : reference;
}

export function buildLineReference(
  path: string,
  rootPath: string | null,
  lineRange: { start: number; end: number } | null,
): string {
  if (!lineRange) return buildPromptReference(path, rootPath);
  const suffix = lineRange.start === lineRange.end ? `${lineRange.start}` : `${lineRange.start}-${lineRange.end}`;
  return `${buildPromptReference(path, rootPath)}:${suffix}`;
}
