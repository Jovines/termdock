import { describe, expect, it } from 'vitest';
import {
  selectCachedMobileViewportSessionIds,
} from './mobileViewportCache';

describe('mobile viewport cache', () => {
  it('keeps current split panes and recently visited background sessions', () => {
    const selected = selectCachedMobileViewportSessionIds({
      currentVisibleSessionIds: new Set(['active', 'split-peer']),
      lastVisitedAtBySessionId: new Map([
        ['recent-a', 9_900],
        ['recent-b', 9_800],
        ['stale', 1_000],
      ]),
      validSessionIds: new Set(['active', 'split-peer', 'recent-a', 'recent-b', 'stale']),
      now: 10_000,
      idleMs: 1_000,
      maxSessions: 4,
    });

    expect(selected).toEqual(new Set(['active', 'split-peer', 'recent-a', 'recent-b']));
  });

  it('evicts least-recently-used background sessions above the cache limit', () => {
    const selected = selectCachedMobileViewportSessionIds({
      currentVisibleSessionIds: new Set(['active']),
      lastVisitedAtBySessionId: new Map([
        ['recent-a', 9_900],
        ['recent-b', 9_800],
        ['recent-c', 9_700],
        ['recent-d', 9_600],
      ]),
      validSessionIds: new Set(['active', 'recent-a', 'recent-b', 'recent-c', 'recent-d']),
      now: 10_000,
      idleMs: 1_000,
      maxSessions: 3,
    });

    expect(selected).toEqual(new Set(['active', 'recent-a', 'recent-b']));
  });

  it('never evicts visible panes when a split exceeds the cache limit', () => {
    const visible = new Set(['a', 'b', 'c']);
    expect(selectCachedMobileViewportSessionIds({
      currentVisibleSessionIds: visible,
      lastVisitedAtBySessionId: new Map(),
      validSessionIds: visible,
      now: 10_000,
      maxSessions: 2,
    })).toEqual(visible);
  });

  it('retains one previously visited split with the same pane count', () => {
    const selected = selectCachedMobileViewportSessionIds({
      currentVisibleSessionIds: new Set(['current-a', 'current-b', 'current-c']),
      lastVisitedAtBySessionId: new Map([
        ['previous-a', 9_900],
        ['previous-b', 9_900],
        ['previous-c', 9_900],
        ['older', 9_800],
      ]),
      validSessionIds: new Set([
        'current-a', 'current-b', 'current-c',
        'previous-a', 'previous-b', 'previous-c',
        'older',
      ]),
      now: 10_000,
      idleMs: 1_000,
      maxSessions: 6,
    });

    expect(selected).toEqual(new Set([
      'current-a', 'current-b', 'current-c',
      'previous-a', 'previous-b', 'previous-c',
    ]));
  });

  it('retains three recently visited split workspaces without viewport churn', () => {
    const selected = selectCachedMobileViewportSessionIds({
      currentVisibleSessionIds: new Set(['third-a', 'third-b']),
      lastVisitedAtBySessionId: new Map([
        ['first-a', 9_700],
        ['first-b', 9_700],
        ['second-a', 9_800],
        ['second-b', 9_800],
        ['second-c', 9_800],
        ['third-a', 9_900],
        ['third-b', 9_900],
      ]),
      validSessionIds: new Set([
        'first-a', 'first-b',
        'second-a', 'second-b', 'second-c',
        'third-a', 'third-b',
      ]),
      now: 10_000,
      idleMs: 1_000,
    });

    expect(selected).toEqual(new Set([
      'third-a', 'third-b',
      'second-a', 'second-b', 'second-c',
      'first-a', 'first-b',
    ]));
  });
});
