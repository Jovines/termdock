import { beforeEach, describe, expect, it, vi } from 'vitest';

const getFileDiff = vi.hoisted(() => vi.fn());

vi.mock('../../terminal/api', () => ({
  getFileDiff,
}));

import { loadFileDiffCached, loadVisibleFileDiff } from './DiffViewer';

describe('DiffViewer shared loading cache', () => {
  beforeEach(() => {
    getFileDiff.mockReset();
  });

  it('promotes an in-flight preload without cancelling and requesting the same file again', async () => {
    let resolveRequest!: (value: { diff: string; error: null }) => void;
    getFileDiff.mockReturnValue(new Promise((resolve) => {
      resolveRequest = resolve;
    }));
    const path = `src/preloaded-${Date.now()}.ts`;
    const cwd = '/repo-preload-reuse';

    const preload = loadFileDiffCached(path, cwd);
    const visible = loadVisibleFileDiff(path, cwd, new AbortController().signal);

    expect(visible).toBe(preload);
    expect(getFileDiff).toHaveBeenCalledTimes(1);

    resolveRequest({ diff: 'diff --git a/a b/a\n', error: null });
    await expect(visible).resolves.toMatchObject({ error: null });
  });
});
