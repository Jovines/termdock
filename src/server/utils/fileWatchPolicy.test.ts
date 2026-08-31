// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  countInotifyWatchDescriptors,
  enqueueLatestWatchEvent,
  getWatchErrorCode,
  isWatchResourceExhaustion,
  minimizeRecursiveWatchRoots,
} from './fileWatchPolicy.js';

describe('countInotifyWatchDescriptors', () => {
  it('counts only inotify watch descriptor rows from fdinfo', () => {
    expect(countInotifyWatchDescriptors([
      'pos:\t0',
      'flags:\t02000000',
      'inotify wd:1 ino:123 sdev:8 mask:fc6',
      'inotify wd:2 ino:456 sdev:8 mask:fc6',
      '',
    ].join('\n'))).toBe(2);
  });
});

describe('enqueueLatestWatchEvent', () => {
  it('coalesces repeated path events to their latest state', () => {
    const pending = new Map();
    expect(enqueueLatestWatchEvent(pending, '/repo/file.ts', 'create', 2)).toBe('queued');
    expect(enqueueLatestWatchEvent(pending, '/repo/file.ts', 'update', 2)).toBe('queued');
    expect(pending).toEqual(new Map([['/repo/file.ts', 'update']]));
  });

  it('bounds distinct queued paths without rejecting updates to an existing path', () => {
    const pending = new Map([['/repo/a.ts', 'update'] as const]);
    expect(enqueueLatestWatchEvent(pending, '/repo/a.ts', 'delete', 1)).toBe('queued');
    expect(enqueueLatestWatchEvent(pending, '/repo/b.ts', 'create', 1)).toBe('overflow');
    expect(pending).toEqual(new Map([['/repo/a.ts', 'delete']]));
  });
});

describe('minimizeRecursiveWatchRoots', () => {
  it('deduplicates roots and removes descendants covered by a recursive ancestor', () => {
    expect(minimizeRecursiveWatchRoots([
      '/workspace/repo/src/components',
      '/workspace/repo/src',
      '/workspace/repo/src',
      '/workspace/repo/test',
    ])).toEqual(['/workspace/repo/src', '/workspace/repo/test']);
  });

  it('does not treat similarly prefixed siblings as descendants', () => {
    expect(minimizeRecursiveWatchRoots([
      '/workspace/app',
      '/workspace/application',
    ])).toEqual(['/workspace/app', '/workspace/application']);
  });
});

describe('watch resource exhaustion detection', () => {
  it.each(['EMFILE', 'ENFILE', 'ENOSPC'])('recognizes %s error codes', (code) => {
    const error = Object.assign(new Error('native watcher failed'), { code });
    expect(getWatchErrorCode(error)).toBe(code);
    expect(isWatchResourceExhaustion(error)).toBe(true);
  });

  it('recognizes inotify failures even when a native addon omits the code', () => {
    expect(isWatchResourceExhaustion(new Error('inotify instance limit reached'))).toBe(true);
  });

  it('does not classify unrelated filesystem failures as exhaustion', () => {
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    expect(isWatchResourceExhaustion(error)).toBe(false);
  });
});
