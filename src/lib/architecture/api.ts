import { ARCHITECTURE_DIRECTORY, ARCHITECTURE_FILE, analysisFile, architectureFilePath, ArchitectureFormatError, isArchitectureFile, parseArchitecture, type ArchitectureDocument } from './model';

function missing(body: { code?: string; error?: string }, path: string): boolean {
  return body.code === 'ENOENT' || (!body.code && body.error === `Path does not exist: ${path}`);
}

/** Same-origin page fetch inherits the active service's encrypted transport. */
export async function readArchitecture(root: string, signal: AbortSignal, file = ARCHITECTURE_FILE): Promise<ArchitectureDocument | null> {
  const filePath = architectureFilePath(root, file);
  const params = new URLSearchParams({ path: filePath, action: 'view_architecture' });
  const response = await fetch(`/api/terminal/fs/read?${params}`, { signal, cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) {
    // PathValidator currently turns realpath failures into this exact message,
    // without a code. Accept that existing wire contract for this file only.
    if (missing(body, filePath)) return null;
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  if (body.truncated || body.binary || typeof body.content !== 'string') throw new Error('Architecture document cannot be read in full');
  const document = parseArchitecture(body.content);
  if (document.analysis && analysisFile(document.analysis) !== file) throw new ArchitectureFormatError('Architecture scope does not match its file');
  return document;
}

/** Discover independent maps without loading their source/diagram contents. */
export async function listArchitectures(root: string, signal: AbortSignal): Promise<string[]> {
  const path = `${root.replace(/\/+$/, '')}/${ARCHITECTURE_DIRECTORY}`;
  const params = new URLSearchParams({ path, action: 'list_architectures', showHidden: 'false' });
  const response = await fetch(`/api/terminal/fs/list?${params}`, { signal, cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) {
    if (missing(body, path)) return [];
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  if (!Array.isArray(body.entries) || body.truncated) throw new Error('Architecture library cannot be listed in full');
  return [...new Set<string>(body.entries.flatMap((entry: { name?: unknown; isDirectory?: boolean }) => {
    const file = `${ARCHITECTURE_DIRECTORY}/${entry?.name}`;
    return entry && !entry.isDirectory && typeof entry.name === 'string' && isArchitectureFile(file) ? [file] : [];
  }))].sort();
}
