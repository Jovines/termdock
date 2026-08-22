import { describe, expect, it } from 'vitest';
import {
  computeTerminalLogicalFocus,
  computeTerminalLogicalViewing,
  shouldAutoFocusTerminalAfterInsert,
  shouldRestoreTerminalFocusAfterInteraction,
} from './focus';

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

describe('computeTerminalLogicalViewing', () => {
  it('uses native window focus for desktop windows that keep rendering in the background', () => {
    expect(computeTerminalLogicalViewing({
      isActive: true,
      documentVisible: true,
      windowFocused: false,
      streamReady: true,
      isDesktop: true,
    })).toBe(false);
  });

  it('keeps the visibility-only behavior for mobile browsers', () => {
    expect(computeTerminalLogicalViewing({
      isActive: true,
      documentVisible: true,
      windowFocused: false,
      streamReady: true,
      isDesktop: false,
    })).toBe(true);
  });
});

describe('desktop terminal focus restoration', () => {
  const desktopInteraction = {
    isActive: true,
    isMobile: false,
    documentVisible: true,
    activeElementIsEditable: false,
  };

  it('restores the active terminal after desktop pointer interactions', () => {
    expect(shouldRestoreTerminalFocusAfterInteraction(desktopInteraction)).toBe(true);
  });

  it.each([
    ['mobile layout', { isMobile: true }],
    ['inactive terminal', { isActive: false }],
    ['hidden document', { documentVisible: false }],
    ['editable control', { activeElementIsEditable: true }],
  ])('does not restore focus for %s', (_label, patch) => {
    expect(shouldRestoreTerminalFocusAfterInteraction({ ...desktopInteraction, ...patch })).toBe(false);
  });

  it('auto-focuses successful insertions only on desktop when requested', () => {
    expect(shouldAutoFocusTerminalAfterInsert(false, true)).toBe(true);
    expect(shouldAutoFocusTerminalAfterInsert(true, true)).toBe(false);
    expect(shouldAutoFocusTerminalAfterInsert(false, false)).toBe(false);
  });
});
