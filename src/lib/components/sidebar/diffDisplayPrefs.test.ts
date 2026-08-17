// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DIFF_CONTEXT_STORAGE_KEY,
  DIFF_WHITESPACE_STORAGE_KEY,
  setDiffContextPref,
  setDiffWhitespacePref,
  useDiffDisplayPrefs,
} from './diffDisplayPrefs';
import { renderHook, act } from '@testing-library/react';

describe('diffDisplayPrefs', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // Reset the module-level snapshot through the public setters.
    setDiffWhitespacePref('default');
    setDiffContextPref(3);
  });

  it('defaults to default whitespace and 3 context lines', () => {
    const { result } = renderHook(() => useDiffDisplayPrefs());
    expect(result.current.whitespace).toBe('default');
    expect(result.current.context).toBe(3);
  });

  it('persists whitespace and context prefs to localStorage', () => {
    const { result } = renderHook(() => useDiffDisplayPrefs());
    act(() => result.current.setWhitespace('ignore'));
    act(() => result.current.setContext(25));
    expect(result.current.whitespace).toBe('ignore');
    expect(result.current.context).toBe(25);
    expect(JSON.parse(window.localStorage.getItem(DIFF_WHITESPACE_STORAGE_KEY) ?? '')).toBe('ignore');
    expect(JSON.parse(window.localStorage.getItem(DIFF_CONTEXT_STORAGE_KEY) ?? '')).toBe(25);
  });

  it("supports the 'all' context tier", () => {
    const { result } = renderHook(() => useDiffDisplayPrefs());
    act(() => result.current.setContext('all'));
    expect(result.current.context).toBe('all');
    expect(JSON.parse(window.localStorage.getItem(DIFF_CONTEXT_STORAGE_KEY) ?? '')).toBe('all');
  });

  it('keeps multiple hook consumers in sync', () => {
    const first = renderHook(() => useDiffDisplayPrefs());
    const second = renderHook(() => useDiffDisplayPrefs());
    act(() => first.result.current.setWhitespace('trim'));
    expect(second.result.current.whitespace).toBe('trim');
  });
});
