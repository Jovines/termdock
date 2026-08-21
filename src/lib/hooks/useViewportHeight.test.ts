import { describe, expect, it } from 'vitest';
import { correctIOSKeyboardToolbarUndercount } from './useViewportHeight';

describe('correctIOSKeyboardToolbarUndercount', () => {
  const baseInput = {
    measuredHeight: 292,
    referenceHeight: 336,
    keyboardOpenAgeMs: 800,
    isIOS: true,
    isTerminalInputFocused: true,
  };

  it('reuses the stable height when iOS misses one system-toolbar-sized region', () => {
    expect(correctIOSKeyboardToolbarUndercount(baseInput)).toBe(336);
  });

  it('waits for keyboard animation settling before correcting', () => {
    expect(correctIOSKeyboardToolbarUndercount({
      ...baseInput,
      keyboardOpenAgeMs: 300,
    })).toBe(292);
  });

  it('does not correct other platforms or unfocused terminal input', () => {
    expect(correctIOSKeyboardToolbarUndercount({ ...baseInput, isIOS: false })).toBe(292);
    expect(correctIOSKeyboardToolbarUndercount({
      ...baseInput,
      isTerminalInputFocused: false,
    })).toBe(292);
  });

  it('does not reuse a reference when the delta is outside toolbar bounds', () => {
    expect(correctIOSKeyboardToolbarUndercount({
      ...baseInput,
      referenceHeight: 310,
    })).toBe(292);
    expect(correctIOSKeyboardToolbarUndercount({
      ...baseInput,
      referenceHeight: 380,
    })).toBe(292);
  });
});
