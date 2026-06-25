import { describe, expect, it } from 'vitest';
import {
  getEffectiveRendererModeForSession,
  normalizeRecentSessionIds,
} from './webglSessionBudget';

describe('normalizeRecentSessionIds', () => {
  it('keeps the active session first and preserves recent visited sessions within budget', () => {
    const result = normalizeRecentSessionIds(
      ['b', 'c', 'd'],
      'a',
      ['a', 'b', 'c', 'd'],
      [],
      3,
    );

    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('keeps adjacent sessions before older recent sessions', () => {
    const result = normalizeRecentSessionIds(
      ['recent-1', 'recent-2'],
      'active',
      ['previous-2', 'previous-1', 'active', 'next-1', 'next-2', 'recent-1', 'recent-2'],
      ['previous-1', 'next-1', 'previous-2', 'next-2'],
      5,
    );

    expect(result).toEqual(['active', 'previous-1', 'next-1', 'previous-2', 'next-2']);
  });

  it('drops sessions that no longer exist and removes duplicates', () => {
    const result = normalizeRecentSessionIds(
      ['b', 'missing', 'b', 'c'],
      'b',
      ['a', 'b', 'c'],
      ['missing', 'c'],
      3,
    );

    expect(result).toEqual(['b', 'c']);
  });

  it('does not admit never-visited sessions just because budget remains', () => {
    const result = normalizeRecentSessionIds(
      ['b'],
      'a',
      ['a', 'b', 'c', 'd'],
      [],
      4,
    );

    expect(result).toEqual(['a', 'b']);
  });
});

describe('getEffectiveRendererModeForSession', () => {
  it('keeps hot sessions GPU-backed for auto and webgl modes', () => {
    const hotSessions = new Set(['active', 'recent']);

    expect(getEffectiveRendererModeForSession('webgl', 'active', hotSessions)).toBe('webgl');
    expect(getEffectiveRendererModeForSession('auto', 'active', hotSessions)).toBe('webgl');
  });

  it('falls cold GPU-capable sessions back to the built-in renderer', () => {
    const hotSessions = new Set(['active', 'recent']);

    expect(getEffectiveRendererModeForSession('webgl', 'cold', hotSessions)).toBe('canvas');
    expect(getEffectiveRendererModeForSession('auto', 'cold', hotSessions)).toBe('canvas');
  });

  it('does not change non-webgl renderer modes', () => {
    const hotSessions = new Set<string>();

    expect(getEffectiveRendererModeForSession('canvas', 'cold', hotSessions)).toBe('canvas');
  });
});
