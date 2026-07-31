// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { requestDeadlineMiddleware } from './requestDeadline.js';

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

  it('lets fast requests through untouched', async () => {
    ({ server } = await startServer((app) => {
      app.get('/api/fast', (_req, res) => res.json({ ok: true }));
    }));
    const port = (server!.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/api/fast`);

    expect(response.status).toBe(200);
  });
});
