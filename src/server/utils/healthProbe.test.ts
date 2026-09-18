import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { probeHealthOnce, waitForHealth } from './healthProbe.js';

const servers: http.Server[] = [];

interface HealthServer {
  url: string;
  close: () => Promise<void>;
}

async function startHealthServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<HealthServer> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/health`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

/** 一个占用后立刻释放的端口，用来稳定复现 ECONNREFUSED。 */
async function findClosedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  return port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  })));
});

describe('probeHealthOnce', () => {
  it('200 且 body 含 status ok → 就绪', async () => {
    const { url } = await startHealthServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
    });

    await expect(probeHealthOnce(url, null)).resolves.toEqual({ ok: true });
  });

  it('非 2xx → bad-status（服务活着但不是健康应答）', async () => {
    const { url } = await startHealthServer((_req, res) => {
      res.writeHead(503);
      res.end('{"status":"starting"}');
    });

    const result = await probeHealthOnce(url, null);
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('bad-status');
    expect(result.detail).toBe('HTTP 503');
  });

  it('200 但 body 不对 → bad-body（不能把任意 200 当成就绪）', async () => {
    const { url } = await startHealthServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>login</html>');
    });

    const result = await probeHealthOnce(url, null);
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('bad-body');
  });

  it('连不上 → unreachable', async () => {
    const port = await findClosedPort();

    const result = await probeHealthOnce(`http://127.0.0.1:${port}/health`, null, 2_000);
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('unreachable');
  });

  it('服务不应答 → timeout（这正是 supervisor 判卡死需要的语义）', async () => {
    const { url } = await startHealthServer(() => {
      // 故意不结束响应：模拟事件循环卡死
    });

    const result = await probeHealthOnce(url, null, 150);
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('timeout');
  });

  it('caPath 指向不存在的文件时快速失败，不会挂在 pending', async () => {
    const { url } = await startHealthServer((_req, res) => {
      res.writeHead(200).end('{"status":"ok"}');
    });

    const result = await probeHealthOnce(url, '/nonexistent/ca.pem');
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('unreachable');
  });
});

describe('waitForHealth', () => {
  it('进程已死 → 立刻 false，不耗尽超时', async () => {
    const started = Date.now();
    const ready = await waitForHealth('http://127.0.0.1:1/health', null, 5_000, () => true, () => false);

    expect(ready).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('先 ready 后应答 → true', async () => {
    const { url } = await startHealthServer((_req, res) => {
      res.writeHead(200).end('{"status":"ok"}');
    });
    let ready = false;
    setTimeout(() => { ready = true; }, 120);

    await expect(waitForHealth(url, null, 5_000, () => ready, () => true)).resolves.toBe(true);
  });

  it('始终不应答 → 到了 deadline 返回 false', async () => {
    const { url } = await startHealthServer(() => { /* 挂住 */ });

    await expect(waitForHealth(url, null, 400, () => true, () => true)).resolves.toBe(false);
  });
});
