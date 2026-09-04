import { describe, expect, it } from 'vitest';
import { normalizeClientWatchRoots } from './fileWatchRoots';

describe('normalizeClientWatchRoots', () => {
  it('keeps nested expanded directories for non-recursive watching', () => {
    expect(normalizeClientWatchRoots([
      '/repo/src',
      '/repo/src/components',
      '/repo/src/components/sidebar',
    ])).toEqual(['/repo/src', '/repo/src/components', '/repo/src/components/sidebar']);
  });

  it('keeps independent sibling roots and normalizes trailing slashes', () => {
    expect(normalizeClientWatchRoots([
      '/repo/src/',
      '/repo/test',
      '/repo/testing',
    ])).toEqual(['/repo/src', '/repo/test', '/repo/testing']);
  });
});
