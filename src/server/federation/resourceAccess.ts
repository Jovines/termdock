import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ShareResources, SharedComputer } from '../shared/shareResources.js';
import { canonicalApiPath } from './accessPolicy.js';
export function computerResource(resources: ShareResources, host: string, protocol = 'vnc', port = protocol === 'rdp' ? 3389 : 5900): SharedComputer | undefined {
  const matches = resources.computers?.filter(c => c.host.toLowerCase() === host.toLowerCase() && c.protocol === protocol && c.port === port);
  return matches?.find(c => c.access === 'control') ?? matches?.[0];
}
/** Check both the lexical and real path. Symlinks cannot widen a shared root. */
export function directoryResource(resources: ShareResources, requested: string, write = false): boolean {
  if (!path.isAbsolute(requested) || requested.includes('\0')) return false;
  try {
    const lexical = path.resolve(requested), real = realpathSync(lexical);
    const inside = (root: string, file: string) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
    return resources.directories?.some(root => (!write || root.access === 'write') && inside(path.resolve(root.path), lexical) && inside(realpathSync(root.path), real)) === true;
  } catch { return false; }
}
export function canonicalShareDirectories(resources: ShareResources): ShareResources {
  return { ...resources, ...(resources.directories ? { directories: resources.directories.map(root => {
    const canonical = realpathSync(root.path);
    if (!statSync(canonical).isDirectory()) throw new Error('SHARE_DIRECTORY_UNAVAILABLE');
    return { ...root, path: canonical };
  }) } : {}) };
}
export function resourceHttpAllowed(resources: ShareResources, method: string, requestPath: string): boolean {
  const pathname = canonicalApiPath(requestPath);
  if (!pathname) return false;
  if (method === 'GET' && pathname === '/api/android/devices') return !!resources.android?.length;
  if (method === 'GET' && pathname === '/api/computer/status') return !!resources.computers?.length;
  const url = new URL(requestPath, 'http://inner');
  const op = pathname.slice('/api/terminal/fs/'.length);
  if (['GET', 'HEAD'].includes(method) && op.startsWith('preview/')) { const parts = op.slice(8).split('/'); if (/^[0-9a-f]{32}$/.test(parts[0])) parts.shift(); return directoryResource(resources, '/' + parts.join('/')); }
  if (!pathname.startsWith('/api/terminal/fs/')) return false;
  // Unregistered Git, shell, native-open and recursive APIs remain unavailable.
  const read = ['GET', 'HEAD'].includes(method) && ['list', 'read', 'blob', 'video', 'download', 'eda-preview', 'eda-inspect'].includes(op);
  const write = (method === 'POST' && op === 'upload') || (method === 'PUT' && op === 'write') || (method === 'DELETE' && op === 'file');
  if (!read && !write) return false;
  const key = op === 'upload' ? 'dir' : 'path';
  if (url.searchParams.getAll(key).length !== 1 || !directoryResource(resources, url.searchParams.get(key) ?? '', write)) return false;
  // Listing can run git check-ignore; its repository is another filesystem input.
  for (const extra of ['gitIgnoreRoot', 'cwd', 'root', 'repoRoot']) {
    if (url.searchParams.has(extra) && (url.searchParams.getAll(extra).length !== 1 || !directoryResource(resources, url.searchParams.get(extra) ?? ''))) return false;
  }
  return true;
}
