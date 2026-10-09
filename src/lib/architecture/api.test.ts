import { afterEach, describe, expect, it, vi } from 'vitest';
import { listArchitectures, readArchitecture } from './api';
import { analysisFile, ARCHITECTURE_DIRECTORY, DEFAULT_ANALYSIS } from './model';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import filesystemRouter from '../../server/routes/filesystem';

afterEach(() => vi.unstubAllGlobals());
describe('architecture file loading', () => {
  it('shows an empty architecture for a fresh project using the actual filesystem route', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'td-architecture-first-load-'));
    const app = express();
    app.use('/api/terminal/fs', filesystemRouter);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test server address');
    const nativeFetch = globalThis.fetch;
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => nativeFetch(new URL(String(input), `http://127.0.0.1:${address.port}`), init));
    vi.stubGlobal('fetch', fetch);
    try {
      const response = await nativeFetch(`http://127.0.0.1:${address.port}/api/terminal/fs/read?${new URLSearchParams({ path: `${root}/.termdock/architecture.json` })}`);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: `Path does not exist: ${root}/.termdock/architecture.json` });
      expect(await readArchitecture(root, new AbortController().signal)).toBeNull();
      // The directory can exist before the Agent has written the first map.
      await fs.mkdir(path.join(root, '.termdock'));
      expect(await readArchitecture(root, new AbortController().signal)).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(await listArchitectures(root, new AbortController().signal)).toEqual([]);
      const scopes = [
        { ...DEFAULT_ANALYSIS, kind: 'module' as const, paths: ['src/server'], target: 'src/server' },
        { ...DEFAULT_ANALYSIS, kind: 'feature' as const, target: '文件上传' },
      ];
      await fs.mkdir(path.join(root, ARCHITECTURE_DIRECTORY));
      for (const analysis of scopes) {
        const doc = { version: 1, generatedAt: new Date().toISOString(), summary: analysis.target, analysis,
          perspectives: [{ id: 'overview', title: 'Overview', summary: '', nodes: [{ id: 'entry', title: 'Entry', summary: '', files: [] }], edges: [] }] };
        await fs.writeFile(path.join(root, analysisFile(analysis)), JSON.stringify(doc));
      }
      await fs.writeFile(path.join(root, ARCHITECTURE_DIRECTORY, 'unrelated.json'), '{}');
      expect(await listArchitectures(root, new AbortController().signal)).toEqual(scopes.map(analysisFile).sort());
      for (const scope of scopes) expect((await readArchitecture(root, new AbortController().signal, analysisFile(scope)))?.analysis).toEqual(scope);
      expect(await readArchitecture(root, new AbortController().signal)).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('filters untrusted listing paths and refuses truncated or denied libraries', async () => {
    const file = analysisFile({ ...DEFAULT_ANALYSIS, kind: 'feature', target: 'Upload' });
    const fetch = vi.fn(async () => Response.json({ entries: [
      { name: file.split('/').pop(), isDirectory: false }, { name: '../secret.json', isDirectory: false },
      { name: 'unrelated.json', isDirectory: false }, { name: file.split('/').pop(), isDirectory: true }, null,
    ] }));
    vi.stubGlobal('fetch', fetch);
    expect(await listArchitectures('/project', new AbortController().signal)).toEqual([file]);
    fetch.mockResolvedValueOnce(Response.json({ entries: [], truncated: true }));
    await expect(listArchitectures('/project', new AbortController().signal)).rejects.toThrow('in full');
    fetch.mockResolvedValueOnce(Response.json({ error: 'Access denied' }, { status: 403 }));
    await expect(listArchitectures('/project', new AbortController().signal)).rejects.toThrow('Access denied');
  });

  it('rejects a scope saved under another scope file', async () => {
    const scope = { ...DEFAULT_ANALYSIS, kind: 'feature' as const, target: 'Upload' };
    const document = { version: 1, generatedAt: new Date().toISOString(), summary: '', analysis: scope,
      perspectives: [{ id: 'overview', title: '', summary: '', nodes: [{ id: 'entry', title: '', summary: '', files: [] }], edges: [] }] };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ content: JSON.stringify(document) })));
    await expect(readArchitecture('/project', new AbortController().signal)).rejects.toThrow('scope does not match');
  });

  it.each([
    { error: 'Access denied: path not allowed' },
    { code: 'EACCES', error: 'Path does not exist: /project/.termdock/architecture.json' },
    { error: 'Path does not exist: /another-project/.termdock/architecture.json' },
  ])('does not hide permission or unrelated path failures: %j', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status: 403 })));
    await expect(readArchitecture('/project', new AbortController().signal)).rejects.toThrow(body.error);
  });

  it('treats only a missing file as an empty architecture', async () => {
    const fetch = vi.fn(async () => Response.json({ code: 'ENOENT', error: 'Missing file' }, { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    expect(await readArchitecture('/remote project', new AbortController().signal)).toBeNull();
    expect(fetch.mock.calls).toHaveLength(1);
    fetch.mockResolvedValueOnce(Response.json({ code: 'EACCES', error: 'Access denied' }, { status: 403 }));
    await expect(readArchitecture('/remote project', new AbortController().signal)).rejects.toThrow('Access denied');
  });
  it('rejects partial or binary architecture data', async () => {
    const fetch = vi.fn(async () => Response.json({ content: '{}', truncated: true }));
    vi.stubGlobal('fetch', fetch);
    await expect(readArchitecture('/project', new AbortController().signal)).rejects.toThrow('in full');
    fetch.mockResolvedValueOnce(Response.json({ content: '', binary: true }));
    await expect(readArchitecture('/project', new AbortController().signal)).rejects.toThrow('in full');
  });
  it('passes cancellation to the same-origin page transport and never retries a failed business request', async () => {
    const fetch = vi.fn(async () => { throw new Error('Disconnected'); });
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    await expect(readArchitecture('/remote project', controller.signal)).rejects.toThrow('Disconnected');
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith('/api/terminal/fs/read?path=%2Fremote+project%2F.termdock%2Farchitecture.json&action=view_architecture', { signal: controller.signal, cache: 'no-store' });
  });
});
