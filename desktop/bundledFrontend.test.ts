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
