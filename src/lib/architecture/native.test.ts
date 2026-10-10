import { afterEach, describe, expect, it, vi } from 'vitest';
import { readNativeArchitecture, writeArchitectureField } from './native';
vi.mock('../terminal/api', () => ({ getCsrfToken: async () => 'csrf-test' }));
afterEach(() => vi.unstubAllGlobals());
describe('native architecture page transport', () => {
  it('uses only the page fetch on first load without a service worker, passing cancellation and the literal remote project', async () => {
    const fetch = vi.fn(async () => Response.json({ document: null, revision: null })); vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    expect(await readNativeArchitecture('/remote project', '.omm', signal)).toEqual({ document: null, revision: null });
    expect(fetch).toHaveBeenCalledWith('/api/terminal/architecture/document?file=.omm&root=%2Fremote+project', { signal, cache: 'no-store' });
  });
  it('passes writes through the existing CSRF contract and never retries over a direct business endpoint after disconnection', async () => {
    const fetch = vi.fn(async () => { throw new Error('Disconnected'); }); vi.stubGlobal('fetch', fetch);
    await expect(writeArchitectureField('/remote project', '.omm', 'overall', undefined, 'description', 'Draft', 'revision')).rejects.toThrow('Disconnected');
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]).toEqual(['/api/terminal/architecture/field', expect.objectContaining({ method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': 'csrf-test' }, body: JSON.stringify({ root: '/remote project', file: '.omm', perspective: 'overall', field: 'description', value: 'Draft', revision: 'revision' }) })]);
  });
});
