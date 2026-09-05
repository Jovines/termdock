import type express from 'express';
import fs from 'node:fs';
import path from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

export function selectStaticEncoding(header: string): 'br' | 'gzip' | null {
  const qualities = new Map<string, number>();
  for (const token of header.toLowerCase().split(',')) {
    const [name, ...params] = token.trim().split(';');
    const q = params.map((value) => value.trim()).find((value) => value.startsWith('q='));
    const quality = q === undefined ? 1 : Number(q.slice(2));
    qualities.set(name, Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0);
  }
  const br = qualities.get('br') ?? qualities.get('*') ?? 0;
  const gzip = qualities.get('gzip') ?? qualities.get('*') ?? 0;
  if (br <= 0 && gzip <= 0) return null;
  return br >= gzip ? 'br' : 'gzip';
}

export function setStaticCacheHeaders(req: Pick<express.Request, 'url'>, res: express.Response): void {
  let pathname: string;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { return; }
  if (pathname.startsWith('/assets/') || /^\/fonts\/terminal\/[^/]+-[a-f0-9]{12}\.woff2$/.test(pathname)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (pathname === '/sw.js' || pathname === '/registerSW.js' || pathname === '/manifest.webmanifest' || pathname === '/' || pathname.endsWith('/index.html')) {
    // Allow conditional validation without ever reusing a stale entry point.
    res.setHeader('Cache-Control', 'no-cache');
  }
}

/** Serve build-time compressed assets; missing sidecars fall through to Express.
 * No synchronous compression or disk reads in the terminal server's event loop.
 */
export function createStaticCompressionMiddleware(rootDir: string): express.RequestHandler {
  const root = path.resolve(rootDir);
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' || req.headers.range) return next();
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { return next(); }
    if (pathname === '/') pathname = '/index.html';
    const type = CONTENT_TYPES[path.extname(pathname).toLowerCase()];
    if (!type) return next();
    res.vary('Accept-Encoding');
    const encoding = selectStaticEncoding(String(req.headers['accept-encoding'] || ''));
    if (!encoding) return next();
    const original = path.resolve(root, '.' + pathname);
    if (!original.startsWith(root + path.sep)) return next();
    const compressed = original + (encoding === 'br' ? '.br' : '.gz');
    try {
      const [source, stat] = await Promise.all([fs.promises.stat(original), fs.promises.stat(compressed)]);
      if (!source.isFile() || !stat.isFile() || stat.mtimeMs < source.mtimeMs) return next();
      res.setHeader('Content-Type', type);
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('ETag', `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}-${encoding}"`);
      res.setHeader('Last-Modified', source.mtime.toUTCString());
      setStaticCacheHeaders(req, res);
      if (req.fresh) { res.status(304).end(); return; }
      res.setHeader('Content-Length', stat.size);
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = fs.createReadStream(compressed);
      res.once('close', () => stream.destroy());
      stream.on('error', (error) => { if (!res.headersSent) next(error); else res.destroy(error); });
      stream.pipe(res);
    } catch { next(); }
  };
}
