import { describe, expect, it } from 'vitest';
import { minimizeClientWatchRoots } from './fileWatchRoots';

describe('minimizeClientWatchRoots', () => {
  it('keeps the watch key stable when a covered child directory is expanded', () => {
    expect(minimizeClientWatchRoots([
      '/repo/src',
      '/repo/src/components',
      '/repo/src/components/sidebar',
    ])).toEqual(['/repo/src']);
  });

  it('keeps independent sibling roots and normalizes trailing slashes', () => {
    expect(minimizeClientWatchRoots([
      '/repo/src/',
      '/repo/test',
      '/repo/testing',
    ])).toEqual(['/repo/src', '/repo/test', '/repo/testing']);
  });
});
