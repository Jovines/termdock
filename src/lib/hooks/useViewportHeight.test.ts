import { describe, expect, it } from 'vitest';
import {
  shouldApplyViewportKeyboardInset,
} from './useViewportHeight';

describe('shouldApplyViewportKeyboardInset', () => {
  it('accepts a measured inset only while an editable element owns focus', () => {
    expect(shouldApplyViewportKeyboardInset({
      measuredHeight: 320,
      documentVisible: true,
      editableFocused: true,
    })).toBe(true);
  });

  it('applies small real geometry changes without waiting for keyboard classification', () => {
    for (const measuredHeight of [1, 20, 79, 292, 336, 292, 20]) {
      expect(shouldApplyViewportKeyboardInset({
        measuredHeight, documentVisible: true, editableFocused: true,
      })).toBe(true);
    }
    expect(shouldApplyViewportKeyboardInset({
      measuredHeight: 0, documentVisible: true, editableFocused: true,
    })).toBe(false);
  });

  it('rejects a stale PWA viewport inset after relaunch without keyboard focus', () => {
    expect(shouldApplyViewportKeyboardInset({
      measuredHeight: 320,
      documentVisible: true,
      editableFocused: false,
    })).toBe(false);
  });

  it('rejects viewport insets while the app is backgrounded', () => {
    expect(shouldApplyViewportKeyboardInset({
      measuredHeight: 320,
      documentVisible: false,
      editableFocused: true,
    })).toBe(false);
  });
});
