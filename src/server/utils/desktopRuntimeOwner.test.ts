import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DesktopRuntimeOwnerClient,
  type DesktopRuntimeOwnerState,
} from './desktopRuntimeOwner.js';

const temporaryRoots: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function listen(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-runtime-owner-'));
  temporaryRoots.push(root);
  const socketPath = path.join(root, 'owner.sock');
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return socketPath;
}

function state(status: DesktopRuntimeOwnerState['status']): DesktopRuntimeOwnerState {
  return {
    status,
    currentVersion: '1.4.127',
    latestVersion: status === 'ready' || status === 'restarting' ? '1.4.128' : null,
    source: 'desktop',
    checkedAt: 1,
    error: null,
  };
}

describe.skipIf(process.platform === 'win32')('desktop Runtime owner client', () => {
  it('routes checks and restarts through the owning desktop socket', async () => {
    const requests: string[] = [];
    const socketPath = await listen((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      const payload = request.url === '/runtime-update/check'
        ? state('ready')
        : state('restarting');
      response.writeHead(request.url === '/runtime-update/restart' ? 202 : 200, {
        'content-type': 'application/json',
      });
      response.end(JSON.stringify(payload));
    });
    const published: string[] = [];
    const client = new DesktopRuntimeOwnerClient(socketPath, '1.4.127', (next) => {
      published.push(next.status);
    });

    await expect(client.checkForUpdates()).resolves.toMatchObject({ status: 'ready' });
    await expect(client.restart()).resolves.toMatchObject({ status: 'restarting' });

    expect(requests).toEqual([
      'POST /runtime-update/check',
      'POST /runtime-update/restart',
    ]);
    expect(published).toEqual(['ready', 'restarting']);
  });

  it('reports an unavailable owner without changing the cached state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-runtime-owner-missing-'));
    temporaryRoots.push(root);
    const client = new DesktopRuntimeOwnerClient(
      path.join(root, 'missing.sock'),
      '1.4.127',
      () => undefined,
    );

    await expect(client.checkForUpdates()).rejects.toThrow('无法联系管理此服务的 Termdock Desktop');
    expect(client.getState()).toMatchObject({ status: 'idle', currentVersion: '1.4.127' });
  });
});
