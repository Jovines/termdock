// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { requestDeadlineMiddleware } from './requestDeadline.js';
import { writeErrorLog } from './serverLogger.js';

// These tests deliberately trigger errors on a real HTTP server. Keep the
// simulated incidents out of the running service's ~/.termdock/errors.log.
vi.mock('./serverLogger.js', () => ({ writeErrorLog: vi.fn() }));

const DEADLINE_MS = 60;

function startServer(configure: (app: express.Express) => void): Promise<{ server: Server; port: number }> {
  const app = express();
  app.use(requestDeadlineMiddleware({ defaultDeadlineMs: DEADLINE_MS }));
  configure(app);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

let server: Server | null = null;

beforeEach(() => {
  server = null;
  vi.clearAllMocks();
});

afterEach(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server!.close(resolve));
    server = null;
  }
});

describe('requestDeadlineMiddleware', () => {
  it('returns 503 with REQUEST_DEADLINE when the handler hangs', async () => {
    ({ server } = await startServer((app) => {
      app.get('/api/slow', () => { /* never responds */ });
    }));
    const port = (server!.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/api/slow`);

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.code).toBe('REQUEST_DEADLINE');
    expect(writeErrorLog).toHaveBeenCalledWith(expect.objectContaining({
      source: 'request-deadline', method: 'GET', path: '/api/slow',
    }));
  });

  it('does not touch exempt long-lived endpoints (fs/watch)', async () => {
    ({ server } = await startServer((app) => {
      app.get('/api/terminal/fs/watch', () => { /* never responds — by design */ });
    }));
    const port = (server!.address() as AddressInfo).port;

    let settled = false;
    const pending = fetch(`http://127.0.0.1:${port}/api/terminal/fs/watch`)
      .then(() => { settled = true; })
      .catch(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, DEADLINE_MS * 4));
    expect(settled).toBe(false);

    server!.closeAllConnections?.();
    await pending.catch(() => undefined);
  });

  it('destroys the socket when the response stalls after headers were sent', async () => {
    ({ server } = await startServer((app) => {
      app.get('/api/stalled', (_req, res) => {
        res.setHeader('Content-Type', 'text/plain');
        res.write('partial');
        // then stalls forever
      });
    }));
    const port = (server!.address() as AddressInfo).port;

    // fetch 在响应头到达时即 resolve；socket 被销毁后读 body 会失败。
    const response = await fetch(`http://127.0.0.1:${port}/api/stalled`);
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
  });

  it('honors a route-level deadline override', async () => {
    ({ server } = await startServer((app) => {
      app.get('/api/extended', (_req, res) => {
        res.locals.requestDeadlineMs = DEADLINE_MS * 4;
        setTimeout(() => res.json({ ok: true }), DEADLINE_MS * 2);
      });
    }));
    const port = (server!.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/api/extended`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('allows KiCad response bodies to finish beyond the default deadline', async () => {
    ({ server } = await startServer((app) => {
      app.get('/api/terminal/fs/eda-preview', (_req, res) => {
        res.write('glb-');
        setTimeout(() => res.end('complete'), DEADLINE_MS * 2);
      });
    }));
    const port = (server!.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/terminal/fs/eda-preview`);
    expect(await response.text()).toBe('glb-complete');
  });

  it('lets fast requests through untouched', async () => {
    ({ server } = await startServer((app) => {
      app.get('/api/fast', (_req, res) => res.json({ ok: true }));
    }));
    const port = (server!.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/api/fast`);

    expect(response.status).toBe(200);
  });

  it.each([
    '/api/terminal/fs/upload?dir=%2Ftmp&fileCount=1',
    '/api/terminal/terminal-one/chat/attachments?fileCount=1',
    '/api/terminal/terminal%2Fone/chat/attachments?fileCount=1',
  ])('gives multipart uploads the extended deadline: %s', async pathname => {
    ({ server } = await startServer((app) => {
      app.post(/.*/, (_req, res) => {
        const timer = setTimeout(() => res.json({ files: [] }), DEADLINE_MS * 2);
        res.once('close', () => clearTimeout(timer));
      });
    }));
    const port = (server!.address() as AddressInfo).port;
    const body = new FormData();
    body.append('files', new Blob(['attachment']), 'file.txt');
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: 'POST', body });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ files: [] });
    expect(writeErrorLog).not.toHaveBeenCalled();
  });

  it('keeps the default deadline for neighboring chat operations', async () => {
    ({ server } = await startServer((app) => {
      app.post('/api/terminal/one/chat', () => { /* never responds */ });
    }));
    const port = (server!.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/terminal/one/chat`, { method: 'POST' });

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('REQUEST_DEADLINE');
  });
});
