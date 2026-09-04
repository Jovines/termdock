import { afterEach, describe, expect, it, vi } from 'vitest';

describe('startup read deduplication', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('shares concurrent settings reads and reuses the startup snapshot', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ preventSleep: false }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { getSettings } = await import('./api');

    const [first, second] = await Promise.all([getSettings(), getSettings()]);
    const third = await getSettings();

    expect(first).toBe(second);
    expect(third).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares concurrent context-draft reads and reuses the startup snapshot', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ text: 'draft', updatedAt: 1 }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { getContextDraft } = await import('./api');

    const [first, second] = await Promise.all([getContextDraft(), getContextDraft()]);
    const third = await getContextDraft();

    expect(first).toBe(second);
    expect(third).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
