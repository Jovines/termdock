import type { RequestHandler } from 'express';
import { isAuthEnabled, readAuthFile } from './authProtection.js';

/** Explicit external origin; never infer TLS or trust from forwarded headers. */
export function getPublicOrigin(): string | null {
  const raw = process.env.TERMDOCK_PUBLIC_ORIGIN;
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('TERMDOCK_PUBLIC_ORIGIN must be an HTTPS origin, e.g. https://term.example.com');
  }
  return url.origin;
}

export function assertPublicSecurity(): void {
  if (!getPublicOrigin()) return;
  if (!isAuthEnabled() || (!process.env.TERMDOCK_PASSWORD && !readAuthFile())) {
    throw new Error('Public access requires authentication. Run td --set-password before starting.');
  }
  if (!process.env.TERMDOCK_PASSWORD && (readAuthFile()?.passwordLength ?? 0) < 16) {
    throw new Error('Public access requires a verified 16-character password. Run td --set-password again.');
  }
  if (process.env.TERMDOCK_PASSWORD && process.env.TERMDOCK_PASSWORD.length < 16) {
    throw new Error('Public access requires TERMDOCK_PASSWORD to contain at least 16 characters.');
  }
}

export const securityHeaders: RequestHandler = (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Enforce sandbox even for top-level navigation to user-controlled HTML/SVG.
  // allow-same-origin must NEVER be added: that would expose the terminal API.
  const preview = /^\/api\/terminal\/fs(?:\/|$)/i.test(req.path);
  res.setHeader('Content-Security-Policy', preview
    ? "sandbox allow-scripts; frame-ancestors 'self'; object-src 'none'; base-uri 'self'"
    : "script-src 'self' 'wasm-unsafe-eval'; script-src-attr 'none'; worker-src 'self' blob:; frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
  if (getPublicOrigin()) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (!isAuthEnabled()) {
      res.status(503).json({ error: 'Public access requires authentication', code: 'PUBLIC_AUTH_REQUIRED' });
      return;
    }
  }
  next();
};
