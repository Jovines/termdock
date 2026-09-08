// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../federation/browserIntegration', () => ({ secureSocket: vi.fn() }));
import { resetCsrfTokenCache, uploadFiles } from './api';

beforeEach(() => resetCsrfTokenCache());
afterEach(() => vi.unstubAllGlobals());

describe('file upload encryption boundary', () => {
  it('uses the encrypted fetch hook with progress even without a Service Worker', async () => {
    const xhr = vi.fn(() => { throw new Error('Native upload must not transmit plaintext'); });
    vi.stubGlobal('XMLHttpRequest', xhr);
    const requests: Array<{ input: unknown; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      requests.push({ input, init });
      if (input === '/api/csrf-token') return Response.json({ csrfToken: 'secure-channel' });
      init?.onUploadProgress?.(Math.floor((init.body as Blob).size / 2));
      return Response.json({ files: [{ name: 'secret.txt', path: '/work/secret.txt', size: 7 }] });
    }));
    const file = new File(['private'], 'secret.txt');
    const progress = vi.fn();
    await expect(uploadFiles('/work', [file], undefined, progress)).resolves.toMatchObject({ files: [{ name: 'secret.txt' }] });
    expect(xhr).not.toHaveBeenCalled();
    expect(requests[1].input).toBe('/api/terminal/fs/upload?dir=%2Fwork');
    expect(requests[1].init?.method).toBe('POST');
    const body = requests[1].init?.body as Blob;
    expect(body.type).toMatch(/multipart\/form-data;\s*boundary=/);
    expect(await body.text()).toContain('private');
    expect(progress.mock.calls[0]).toEqual([0]);
    expect(progress.mock.calls[1][0]).toBeGreaterThan(0);
    expect(progress.mock.calls[1][0]).toBeLessThan(100);
    expect(progress.mock.calls.at(-1)).toEqual([100]);
  });
  it('does not fall back to native upload when the encrypted request fails', async () => {
    const xhr = vi.fn(); vi.stubGlobal('XMLHttpRequest', xhr);
    vi.stubGlobal('fetch', vi.fn(async input => {
      if (input === '/api/csrf-token') return Response.json({ csrfToken: 'secure-channel' });
      throw new Error('Encrypted service unavailable');
    }));
    const progress = vi.fn();
    await expect(uploadFiles('/work', [new File(['private'], 'secret.txt')], undefined, progress)).rejects.toThrow('Encrypted service unavailable');
    expect(xhr).not.toHaveBeenCalled(); expect(progress.mock.calls).toEqual([[0]]);
  });
});
