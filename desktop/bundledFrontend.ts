import fs from 'node:fs/promises';
import path from 'node:path';
import type { Session } from 'electron';
import type { SavedConnection } from './types.js';

export type ServiceFrontendSource = 'service' | 'bundled';

/** A local frontend is only useful when a saved relay can reach the target.
 * Alternate direct addresses alone are not a relay route. */
export function selectServiceFrontend(directAvailable: boolean, connection?: SavedConnection): ServiceFrontendSource | null {
  if (directAvailable) return 'service';
  if (!connection?.targetPeerId) return null;
  const hasRelay = Boolean(connection.entryServiceId && connection.entryServiceId !== connection.targetPeerId)
    || connection.routes?.some(route => route.targetPeerId !== connection.targetPeerId);
  return hasRelay ? 'bundled' : null;
}

const prepared = new WeakMap<Session, { source: ServiceFrontendSource; origin: string; ready: Promise<void> }>();
/** Keep the target's logical origin for a relay-only window. Business requests
 * still pass through to the page's encrypted transport. */
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
export function prepareServiceFrontend(target: Session, origin: string, source: ServiceFrontendSource, root: string | (() => string)): Promise<void> {
  const existing = prepared.get(target);
  if (existing?.source === source && existing.origin === origin) return existing.ready;
  const pending = (async () => {
    if (existing) {
      await existing.ready;
      if (existing.source === 'bundled') target.protocol.unhandle(new URL(existing.origin).protocol.slice(0, -1));
    }
    // Migrate cached local shells without deleting device authorization or
    // connection preferences. This runs once per session/source, not per reload.
    await target.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
    if (source === 'service') return;

    const resolveRoot = typeof root === 'function' ? root : () => root;
    let documentRoot = resolveRoot();
    await fs.access(path.join(documentRoot, 'index.html'));
    const previousRoots = new Set<string>();
    await target.protocol.handle(new URL(origin).protocol.slice(0, -1), async request => {
      try {
        const url = new URL(request.url);
        if (url.origin === origin && ['/', '/index.html'].includes(url.pathname)) {
          const nextRoot = resolveRoot();
          await fs.access(path.join(nextRoot, 'index.html'));
          previousRoots.add(documentRoot); documentRoot = nextRoot;
        }
        let file = frontendFile(documentRoot, request.url, origin);
        if (!file) return target.fetch(request, { bypassCustomProtocolHandlers: true });
        if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
        let body: Buffer;
        try { body = await fs.readFile(file); }
        catch (error) {
          // A still-open document may request one of its lazy chunks after a
          // runtime update. Keep those immutable assets until its next reload.
          if (!url.pathname.startsWith('/assets/')) throw error;
          let oldBody: Buffer | undefined;
          for (const previousRoot of previousRoots) {
            try { oldBody = await fs.readFile(frontendFile(previousRoot, request.url, origin)!); break; } catch { /* Try another pinned version. */ }
          }
          if (!oldBody) throw error;
          body = oldBody;
        }
        return new Response(request.method === 'HEAD' ? null : body as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': contentTypes[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' } });
      } catch { return new Response(null, { status: 404 }); }
    });
  })();
  prepared.set(target, { source, origin, ready: pending });
  pending.catch(() => { if (prepared.get(target)?.ready === pending) prepared.delete(target); });
  return pending;
}
