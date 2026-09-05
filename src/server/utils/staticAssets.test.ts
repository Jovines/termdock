// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { createStaticCompressionMiddleware, selectStaticEncoding, setStaticCacheHeaders } from './staticAssets.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

describe('static asset delivery', () => {
  it('honors disabled encodings and quality preference', () => {
    expect(selectStaticEncoding('br;q=0, gzip;q=0.8')).toBe('gzip');
    expect(selectStaticEncoding('gzip;q=.2, br;q=.7')).toBe('br');
    expect(selectStaticEncoding('identity')).toBeNull();
    expect(selectStaticEncoding('*;q=1, br;q=0')).toBe('gzip');
  });

  it('serves sidecars with validation and falls back for missing compressed files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'termdock-static-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const body = 'terminal shell '.repeat(100);
    await writeFile(path.join(dir, 'index.html'), body);
    await writeFile(path.join(dir, 'index.html.gz'), gzipSync(body));
    await writeFile(path.join(dir, 'fallback.js'), 'export default 1;');
    const app = express();
    app.use(createStaticCompressionMiddleware(dir));
    app.use(express.static(dir));
    const server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const response = await fetch(base + '/', { headers: { 'Accept-Encoding': 'gzip' } });
    expect(response.headers.get('Content-Encoding')).toBe('gzip');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(await response.text()).toBe(body);
    const revalidated = await fetch(base + '/', { cache: 'no-cache', headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': response.headers.get('etag')! } });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe('');
    const head = await fetch(base + '/', { method: 'HEAD', headers: { 'Accept-Encoding': 'gzip' } });
    expect(head.headers.get('Content-Length')).toBe(response.headers.get('Content-Length'));
    expect(await head.text()).toBe('');
    const fallback = await fetch(base + '/fallback.js', { headers: { 'Accept-Encoding': 'gzip' } });
    expect(await fallback.text()).toBe('export default 1;');
  });

  it('only makes content-addressed fonts immutable', () => {
    const headers = new Map();
    const res = { setHeader: (key: string, value: string) => headers.set(key, value) } as unknown as express.Response;
    setStaticCacheHeaders({ url: '/fonts/terminal/Mono-text-012345abcdef.woff2' }, res);
    expect(headers.get('Cache-Control')).toContain('immutable');
    headers.clear();
    setStaticCacheHeaders({ url: '/fonts/Mono.woff2' }, res);
    expect(headers.has('Cache-Control')).toBe(false);
  });
});
