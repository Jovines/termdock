import { describe, expect, it, vi } from 'vitest';
import { frontendFile, prepareBundledFrontend } from './bundledFrontend.js';
import type { Session } from 'electron';
describe('bundled service frontend', () => {
  it('serves the shipped shell but passes service APIs and explicit relay origins through', () => {
    expect(frontendFile('/app/client', 'https://c.example/', 'https://c.example')).toBe('/app/client/index.html');
    expect(frontendFile('/app/client', 'https://c.example/assets/app.js', 'https://c.example')).toBe('/app/client/assets/app.js');
    expect(frontendFile('/app/client', 'https://c.example/api/auth/status', 'https://c.example')).toBeUndefined();
    expect(frontendFile('/app/client', 'https://b.example/api/federation/secure', 'https://c.example')).toBeUndefined();
    expect(() => frontendFile('/app/client', 'https://c.example/..%2fsecret', 'https://c.example')).toThrow();
  });
  it('clears legacy workers before installing a local handler, once per session', async () => {
    const clearStorageData = vi.fn(async () => {}), handle = vi.fn(async () => {});
    const session = { clearStorageData, protocol: { handle } } as unknown as Session;
    await Promise.all([prepareBundledFrontend(session, 'https://c.example', 'desktop/renderer'), prepareBundledFrontend(session, 'https://c.example', 'desktop/renderer')]);
    expect(clearStorageData).toHaveBeenCalledExactlyOnceWith({ storages: ['serviceworkers', 'cachestorage'] });
    expect(handle).toHaveBeenCalledOnce();
    expect(clearStorageData.mock.invocationCallOrder[0]).toBeLessThan(handle.mock.invocationCallOrder[0]);
  });
});

it('switches the document on reload while retaining old lazy assets', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'termdock-frontend-update-'));
  try {
    const old = path.join(directory, 'old'), next = path.join(directory, 'new');
    for (const root of [old, next]) await fs.mkdir(path.join(root, 'assets'), { recursive: true });
    await fs.writeFile(path.join(old, 'index.html'), 'old frontend');
    await fs.writeFile(path.join(old, 'assets', 'old.js'), 'old lazy module');
    await fs.writeFile(path.join(next, 'index.html'), 'new frontend');
    let selected = old;
    let handler!: (request: Request) => Promise<Response>;
    const session = { clearStorageData: async () => {}, protocol: { handle: async (_scheme: string, fn: typeof handler) => { handler = fn; } } } as unknown as Session;
    await prepareBundledFrontend(session, 'https://service.test', () => selected);
    selected = next;
    expect(await (await handler(new Request('https://service.test/assets/old.js'))).text()).toBe('old lazy module');
    expect(await (await handler(new Request('https://service.test/'))).text()).toBe('new frontend');
    expect(await (await handler(new Request('https://service.test/assets/old.js'))).text()).toBe('old lazy module');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
