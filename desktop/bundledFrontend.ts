import fs from 'node:fs/promises';
import path from 'node:path';
import type { Session } from 'electron';

const prepared = new WeakMap<Session, Promise<void>>();
/** Keep the logical service origin and its existing storage partition while
 * loading the same shipped frontend even when that service is unreachable. */
export function frontendFile(root: string, requestUrl: string, origin: string): string | undefined {
  const url = new URL(requestUrl);
  if (url.origin !== origin || url.pathname === '/health' || url.pathname.startsWith('/api/')) return;
  const pathname = decodeURIComponent(url.pathname);
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(root, relative);
  if (!file.startsWith(path.resolve(root) + path.sep) || relative.includes('\\')) throw new Error('Invalid frontend path');
  return file;
}
const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
export function prepareBundledFrontend(target: Session, origin: string, root: string): Promise<void> {
  const existing = prepared.get(target);
  if (existing) return existing;
  const pending = (async () => {
    await fs.access(path.join(root, 'index.html'));
    // A legacy remote service worker must never replace the shipped shell.
    await target.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
    await target.protocol.handle(new URL(origin).protocol.slice(0, -1), async request => {
      try {
        const file = frontendFile(root, request.url, origin);
        if (!file) return target.fetch(request, { bypassCustomProtocolHandlers: true });
        if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
        const body = await fs.readFile(file);
        return new Response(request.method === 'HEAD' ? null : body, { headers: { 'Content-Type': contentTypes[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' } });
      } catch { return new Response(null, { status: 404 }); }
    });
  })();
  prepared.set(target, pending);
  pending.catch(() => prepared.delete(target));
  return pending;
}
