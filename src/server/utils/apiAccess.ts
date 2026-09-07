import type { Request } from 'express';
import crypto from 'crypto';
import { requireAuth } from './authProtection.js';

export function isTrustedLocalRequest(req: Request, token?: string | null): boolean {
  const supplied = req.header('X-Termdock-Local-Token');
  if (!token || !supplied || req.headers.origin || req.headers['sec-fetch-site']) return false;
  const address = req.socket.remoteAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Mounted at /api BEFORE body parsing. New endpoints are private by default. */
export function apiAccessGate(localToken?: string | null) {
  return requireAuth({ bypass: (req) => {
    const path = req.path.toLowerCase().replace(/\/$/, '');
    if (['GET', 'HEAD'].includes(req.method) && ['/auth/status', '/meta'].includes(path)) return true;
    if (req.method === 'POST' && ['/auth/login', '/auth/logout'].includes(path)) return true;
    // Preview capabilities perform scoped, session-bound authentication themselves.
    if (['GET', 'HEAD'].includes(req.method) && /^\/terminal\/fs\/preview\//.test(path)) return true;
    return isTrustedLocalRequest(req, localToken) && (
      /^\/(?:terminal|local)(?:\/|$)/.test(path) || path === '/diagnostics/runtime'
    );
  } });
}
