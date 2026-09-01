import { describe, expect, it } from 'vitest';
import type { FileWatchEvent } from './api';
import { partitionFileWatchEvents } from './fileWatchEvents';

describe('partitionFileWatchEvents', () => {
  it('keeps watcher failures from invalidating the visible directory cache', () => {
    const failure: FileWatchEvent = {
      type: 'rescan-required',
      path: '/workspace/src',
      reason: 'EMFILE: too many open files',
    };

    expect(partitionFileWatchEvents([failure])).toEqual({
      applicableEvents: [],
      unavailableReason: 'EMFILE: too many open files',
    });
  });

  it.each(['event-storm', 'reconnected'])('preserves %s rescans', (reason) => {
    const event: FileWatchEvent = { type: 'rescan-required', path: '/workspace/src', reason };
    expect(partitionFileWatchEvents([event])).toEqual({
      applicableEvents: [event],
      unavailableReason: null,
    });
  });

  it('preserves ordinary file events alongside a watcher failure', () => {
    const update: FileWatchEvent = { type: 'updated', path: '/workspace/src/app.ts' };
    const failure: FileWatchEvent = { type: 'rescan-required', path: '/workspace/src', reason: 'watch-unavailable' };
    expect(partitionFileWatchEvents([update, failure])).toEqual({
      applicableEvents: [update],
      unavailableReason: 'watch-unavailable',
    });
  });
});
