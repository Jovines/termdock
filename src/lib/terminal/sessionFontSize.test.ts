// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllSessionFontSizes,
  clampSessionFontSize,
  getSessionFontSize,
  removeSessionFontSize,
  setSessionFontSize,
  SESSION_FONT_SIZE_STORAGE_KEY,
  type SessionFontSizeChangeDetail,
} from './sessionFontSize';

describe('sessionFontSize', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('returns null when no override is stored and persists set values', () => {
    expect(getSessionFontSize('s1')).toBeNull();

    setSessionFontSize('s1', 11);
    expect(getSessionFontSize('s1')).toBe(11);

    const raw = JSON.parse(localStorage.getItem(SESSION_FONT_SIZE_STORAGE_KEY) ?? '{}');
    expect(raw.s1).toBe(11);
  });

  it('clamps stored sizes to the 8..32 range and rounds fractions', () => {
    expect(clampSessionFontSize(3)).toBe(8);
    expect(clampSessionFontSize(99)).toBe(32);
    expect(clampSessionFontSize(12.6)).toBe(13);
    expect(clampSessionFontSize(Number.NaN)).toBe(8);

    setSessionFontSize('s1', 2);
    expect(getSessionFontSize('s1')).toBe(8);
  });

  it('clearing an override dispatches a null fontSize change for that session', () => {
    const listener = vi.fn();
    window.addEventListener('termfontchange', listener);
    try {
      setSessionFontSize('s1', 14);
      setSessionFontSize('s1', null);

      expect(listener).toHaveBeenCalledTimes(2);
      expect((listener.mock.calls[1][0] as CustomEvent<SessionFontSizeChangeDetail>).detail).toEqual({
        sessionId: 's1',
        fontSize: null,
      });
      expect(getSessionFontSize('s1')).toBeNull();
    } finally {
      window.removeEventListener('termfontchange', listener);
    }
  });

  it('notifications carry the owning sessionId so other views can ignore them', () => {
    const listener = vi.fn();
    window.addEventListener('termfontchange', listener);
    try {
      setSessionFontSize('s1', 12);
      setSessionFontSize('s2', 10);

      expect(listener).toHaveBeenCalledTimes(2);
      const details = listener.mock.calls.map(
        (call) => (call[0] as CustomEvent<SessionFontSizeChangeDetail>).detail,
      );
      expect(details).toEqual([
        { sessionId: 's1', fontSize: 12 },
        { sessionId: 's2', fontSize: 10 },
      ]);
    } finally {
      window.removeEventListener('termfontchange', listener);
    }
  });

  it('removes a single override silently and clears everything', () => {
    setSessionFontSize('s1', 10);
    setSessionFontSize('s2', 20);

    const listener = vi.fn();
    window.addEventListener('termfontchange', listener);
    try {
      removeSessionFontSize('s1');
      expect(listener).not.toHaveBeenCalled();
      expect(getSessionFontSize('s1')).toBeNull();
      expect(getSessionFontSize('s2')).toBe(20);

      clearAllSessionFontSizes();
      expect(localStorage.getItem(SESSION_FONT_SIZE_STORAGE_KEY)).toBeNull();
      expect(getSessionFontSize('s2')).toBeNull();
    } finally {
      window.removeEventListener('termfontchange', listener);
    }
  });

  it('ignores malformed persisted data', () => {
    localStorage.setItem(SESSION_FONT_SIZE_STORAGE_KEY, 'not-json');
    expect(getSessionFontSize('s1')).toBeNull();

    localStorage.setItem(SESSION_FONT_SIZE_STORAGE_KEY, JSON.stringify({ s1: 'big', s2: 12.4, s3: Infinity }));
    expect(getSessionFontSize('s1')).toBeNull();
    expect(getSessionFontSize('s2')).toBe(12);
    expect(getSessionFontSize('s3')).toBeNull();
  });
});
