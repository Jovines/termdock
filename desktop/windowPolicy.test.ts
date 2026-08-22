import { describe, expect, it } from 'vitest';
import { shouldThrottleDesktopRenderer } from './windowPolicy.js';

describe('shouldThrottleDesktopRenderer', () => {
  it('keeps a live terminal workspace running while the app is in the background', () => {
    expect(shouldThrottleDesktopRenderer(true)).toBe(false);
  });

  it('allows the connection center to use normal background energy savings', () => {
    expect(shouldThrottleDesktopRenderer(false)).toBe(true);
  });
});
