import { describe, expect, it } from 'vitest';
import { computeTerminalLogicalFocus } from './focus';

const focusedState = {
  isActive: true,
  viewportFocused: true,
  documentVisible: true,
  windowFocused: true,
  streamReady: true,
};

describe('computeTerminalLogicalFocus', () => {
  it('is focused only when every focus gate is open', () => {
    expect(computeTerminalLogicalFocus(focusedState)).toBe(true);
  });

  it.each([
    ['inactive session', { isActive: false }],
    ['viewport blurred', { viewportFocused: false }],
    ['document hidden', { documentVisible: false }],
    ['window blurred', { windowFocused: false }],
    ['stream disconnected', { streamReady: false }],
  ])('is not focused when %s', (_label, patch) => {
    expect(computeTerminalLogicalFocus({ ...focusedState, ...patch })).toBe(false);
  });
});
