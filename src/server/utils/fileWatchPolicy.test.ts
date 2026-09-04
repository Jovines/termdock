// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  countInotifyWatchDescriptors,
  diffWatchSnapshots,
  enqueueLatestWatchEvent,
  getWatchErrorCode,
  isWatchResourceExhaustion,
  normalizeDirectoryWatchRoots,
  resolveDirectWatchEventPath,
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

describe('resolveDirectWatchEventPath', () => {
  it('accepts direct children and rejects nested or escaping paths', () => {
    expect(resolveDirectWatchEventPath('/repo/src', 'app.ts')).toBe('/repo/src/app.ts');
    expect(resolveDirectWatchEventPath('/repo/src', 'components/app.ts')).toBeNull();
    expect(resolveDirectWatchEventPath('/repo/src', '../secret')).toBeNull();
  });
});

describe('diffWatchSnapshots', () => {
  it('reports creates, content updates, and deletes without unchanged noise', () => {
    const previous = new Map([
      ['/repo/deleted.ts', { signature: '1' }],
      ['/repo/updated.ts', { signature: '1' }],
      ['/repo/stable.ts', { signature: '1' }],
    ]);
    const next = new Map([
      ['/repo/created.ts', { signature: '2' }],
      ['/repo/updated.ts', { signature: '2' }],
      ['/repo/stable.ts', { signature: '1' }],
    ]);

    expect(diffWatchSnapshots(previous, next)).toEqual([
      { type: 'delete', path: '/repo/deleted.ts' },
      { type: 'create', path: '/repo/created.ts', value: { signature: '2' } },
      { type: 'update', path: '/repo/updated.ts', value: { signature: '2' } },
    ]);
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

describe('normalizeDirectoryWatchRoots', () => {
  it('deduplicates roots while preserving nested directories needed by non-recursive watchers', () => {
    expect(normalizeDirectoryWatchRoots([
      '/workspace/repo/src/components',
      '/workspace/repo/src',
      '/workspace/repo/src',
      '/workspace/repo/test',
    ])).toEqual([
      '/workspace/repo/src',
      '/workspace/repo/src/components',
      '/workspace/repo/test',
    ]);
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
