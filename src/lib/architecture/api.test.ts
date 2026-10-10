import { afterEach, describe, expect, it, vi } from 'vitest';
import { listArchitectures, readArchitecture } from './api';
import { analysisFile, ARCHITECTURE_DIRECTORY, DEFAULT_ANALYSIS } from './model';
import { architectureRoutes } from '../../server/architecture/routes';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
afterEach(() => vi.unstubAllGlobals());
describe('native architecture project loading', () => {
  it('loads fresh projects and scoped maps through the actual architecture routes, without requiring a service worker', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'td-architecture-first-load-'));
    const app = express(); app.use(express.json()); app.use('/api/terminal/architecture', architectureRoutes());
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test server address');
    const nativeFetch = globalThis.fetch;
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => nativeFetch(new URL(String(input), `http://127.0.0.1:${address.port}`), init)); vi.stubGlobal('fetch', fetch);
    try {
      expect(await readArchitecture(root, new AbortController().signal)).toBeNull();
      expect(await listArchitectures(root, new AbortController().signal)).toEqual([]);
      const scopes = [{ ...DEFAULT_ANALYSIS, kind: 'module' as const, paths: ['src/server'], target: 'src/server' }, { ...DEFAULT_ANALYSIS, kind: 'feature' as const, target: '文件上传' }];
      await fs.mkdir(path.join(root, ARCHITECTURE_DIRECTORY), { recursive: true });
      for (const analysis of scopes) await fs.writeFile(path.join(root, analysisFile(analysis)), JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), summary: analysis.target, analysis, perspectives: [{ id: 'overview', title: 'Overview', summary: '', nodes: [{ id: 'entry', title: 'Entry', summary: '', files: [] }], edges: [] }] }));
      await fs.writeFile(path.join(root, ARCHITECTURE_DIRECTORY, 'unrelated.json'), '{}');
      expect(await listArchitectures(root, new AbortController().signal)).toEqual(scopes.map(analysisFile).sort());
      for (const scope of scopes) expect((await readArchitecture(root, new AbortController().signal, analysisFile(scope)))?.analysis).toEqual(scope);
      await fs.mkdir(path.join(root, '.omm', 'overall'), { recursive: true }); await fs.writeFile(path.join(root, '.omm', 'overall', 'description.md'), 'Project architecture');
      expect(await listArchitectures(root, new AbortController().signal)).toEqual([...scopes.map(analysisFile), '.omm'].sort());
      expect((await readArchitecture(root, new AbortController().signal, '.omm'))?.origin).toBe('omm');
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await fs.rm(root, { recursive: true, force: true }); }
  });
  it('filters untrusted paths and rejects invalid and denied libraries', async () => {
    const file = analysisFile({ ...DEFAULT_ANALYSIS, kind: 'feature', target: 'Upload' });
    const fetch = vi.fn(async () => Response.json({ files: [file, '../secret', '.termdock/architecture.json/extra', null, file] })); vi.stubGlobal('fetch', fetch);
    expect(await listArchitectures('/project', new AbortController().signal)).toEqual([file]);
    fetch.mockResolvedValueOnce(Response.json({ entries: [] })); await expect(listArchitectures('/project', new AbortController().signal)).rejects.toThrow('Invalid');
    fetch.mockResolvedValueOnce(Response.json({ error: 'Access denied' }, { status: 403 })); await expect(listArchitectures('/project', new AbortController().signal)).rejects.toThrow('Access denied');
  });
  it('rejects scope mismatches and incomplete wire responses', async () => {
    const analysis = { ...DEFAULT_ANALYSIS, kind: 'feature' as const, target: 'Upload' };
    const document = { version: 1, generatedAt: new Date().toISOString(), summary: '', analysis, perspectives: [{ id: 'overview', title: '', summary: '', nodes: [{ id: 'entry', title: '', summary: '', files: [] }], edges: [] }] };
    const fetch = vi.fn(async () => Response.json({ document, revision: 'version' })); vi.stubGlobal('fetch', fetch);
    await expect(readArchitecture('/project', new AbortController().signal)).rejects.toThrow('scope does not match');
    fetch.mockResolvedValueOnce(Response.json({ content: 'partial' })); await expect(readArchitecture('/project', new AbortController().signal)).rejects.toThrow('Invalid');
  });
  it('preserves access failures and cancellation and never falls back to an unencrypted business endpoint', async () => {
    const fetch = vi.fn(async (): Promise<Response> => { throw new Error('Disconnected'); }); vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    await expect(readArchitecture('/remote project', signal)).rejects.toThrow('Disconnected'); expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith('/api/terminal/architecture/document?file=.termdock%2Farchitecture.json&root=%2Fremote+project', { signal, cache: 'no-store' });
    fetch.mockResolvedValueOnce(Response.json({ error: 'Access denied' }, { status: 403 })); await expect(readArchitecture('/project', signal)).rejects.toThrow('Access denied');
  });
});
