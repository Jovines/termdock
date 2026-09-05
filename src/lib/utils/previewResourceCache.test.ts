// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPreviewResourceCache, fetchPreviewResource, previewCacheStats } from './previewResourceCache';

afterEach(() => { clearPreviewResourceCache(); vi.unstubAllGlobals(); });

describe('private preview resources', () => {
  it('reuses a validated body across per-open IO slots', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('picture', { headers: { ETag: '"v1"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal('fetch', fetcher);
    const first = await fetchPreviewResource('/api/terminal/fs/blob?path=%2Fa.png&requestSlotId=one&action=view_file');
    expect(await first.text()).toBe('picture');
    const second = await fetchPreviewResource('/api/terminal/fs/blob?path=%2Fa.png&requestSlotId=two&action=view_file');
    expect(await second.text()).toBe('picture');
    expect(fetcher.mock.calls[0][0]).toBe(fetcher.mock.calls[1][0]);
    expect(fetcher.mock.calls[1][1].headers.get('If-None-Match')).toBe('"v1"');
    expect(previewCacheStats()).toEqual({ entries: 1, bytes: 7, pending: 0 });
  });

  it('does not cancel a shared download when one reader closes', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    const first = fetchPreviewResource('/api/terminal/fs/read?path=%2Fa', { signal: controller.signal });
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = fetchPreviewResource('/api/terminal/fs/read?path=%2Fa');
    controller.abort();
    await rejected;
    expect(fetcher).toHaveBeenCalledOnce();
    finish(new Response('current', { headers: { ETag: '"v2"' } }));
    expect(await (await second).text()).toBe('current');
  });

  it('forgets the validator and body after logout', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('private', { headers: { ETag: '"v1"' } }));
    vi.stubGlobal('fetch', fetcher);
    await fetchPreviewResource('/api/terminal/fs/read?path=%2Fa');
    clearPreviewResourceCache();
    await fetchPreviewResource('/api/terminal/fs/read?path=%2Fa');
    expect(fetcher.mock.calls[1][1].headers.has('If-None-Match')).toBe(false);
  });

  it('bounds retained bytes and never caches errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => new Response('x'.repeat(1024 * 1024), { status: url.includes('error') ? 403 : 200, headers: { ETag: '"v1"' } })));
    for (let n = 0; n < 35; n++) await fetchPreviewResource(`/api/terminal/fs/read?path=${n}`);
    expect(previewCacheStats().bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    const before = previewCacheStats();
    await fetchPreviewResource('/api/terminal/fs/read?path=error');
    expect(previewCacheStats()).toEqual(before);
  });
});
