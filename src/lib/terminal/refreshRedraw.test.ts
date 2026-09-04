import { describe, expect, it } from 'vitest';
import {
  getActivationRefreshMode,
  KEYBOARD_FIT_SETTLE_MAX_MS,
  KEYBOARD_FIT_SETTLE_QUIET_MS,
  KEYBOARD_RESIZE_WRITE_HOLD_MAX_MS,
  KEYBOARD_RESIZE_WRITE_HOLD_MIN_MS,
  KEYBOARD_RESIZE_WRITE_HOLD_QUIET_MS,
  nextKeyboardFitStableFrameCount,
  shouldDeferTerminalFit,
  shouldForceObservedResizeRedraw,
  shouldForceSettledRedraw,
  shouldPreserveBottomAfterFit,
  shouldProcessObservedResize,
  shouldRefreshTerminalBuffer,
  shouldReleaseKeyboardResizeWriteHold,
  shouldSchedulePageFlipRefresh,
  shouldSettleKeyboardFit,
} from './refreshRedraw';

describe('shouldPreserveBottomAfterFit', () => {
  it('keeps a normal-buffer terminal pinned when it was already at the bottom', () => {
    expect(shouldPreserveBottomAfterFit('normal', 240, 240)).toBe(true);
  });

  it('preserves deliberate scrollback and alternate-screen positions', () => {
    expect(shouldPreserveBottomAfterFit('normal', 240, 180)).toBe(false);
    expect(shouldPreserveBottomAfterFit('alternate', 0, 0)).toBe(false);
  });
});

describe('keyboard fit settling', () => {
  it('requires two stable frames after viewport signals go quiet', () => {
    expect(nextKeyboardFitStableFrameCount(null, 420, 0)).toBe(0);
    expect(nextKeyboardFitStableFrameCount(420, 420.3, 0)).toBe(1);
    expect(nextKeyboardFitStableFrameCount(420.3, 420.2, 1)).toBe(2);
    expect(shouldSettleKeyboardFit(120, KEYBOARD_FIT_SETTLE_QUIET_MS - 1, 4)).toBe(false);
    expect(shouldSettleKeyboardFit(120, KEYBOARD_FIT_SETTLE_QUIET_MS, 1)).toBe(false);
    expect(shouldSettleKeyboardFit(120, KEYBOARD_FIT_SETTLE_QUIET_MS, 2)).toBe(true);
  });

  it('resets stability on movement and has a bounded fallback', () => {
    expect(nextKeyboardFitStableFrameCount(420, 418, 5)).toBe(0);
    expect(shouldSettleKeyboardFit(KEYBOARD_FIT_SETTLE_MAX_MS, 0, 0)).toBe(true);
  });

  it('only freezes fits for an active touch keyboard transition', () => {
    expect(shouldDeferTerminalFit(true, true)).toBe(true);
    expect(shouldDeferTerminalFit(true, false)).toBe(false);
    expect(shouldDeferTerminalFit(false, true)).toBe(false);
  });

  it('coalesces delayed PTY redraw output after the final keyboard resize', () => {
    expect(shouldReleaseKeyboardResizeWriteHold(
      KEYBOARD_RESIZE_WRITE_HOLD_MIN_MS - 1,
      KEYBOARD_RESIZE_WRITE_HOLD_QUIET_MS + 100,
    )).toBe(false);
    expect(shouldReleaseKeyboardResizeWriteHold(
      KEYBOARD_RESIZE_WRITE_HOLD_MIN_MS,
      KEYBOARD_RESIZE_WRITE_HOLD_QUIET_MS - 1,
    )).toBe(false);
    expect(shouldReleaseKeyboardResizeWriteHold(
      KEYBOARD_RESIZE_WRITE_HOLD_MIN_MS,
      KEYBOARD_RESIZE_WRITE_HOLD_QUIET_MS,
    )).toBe(true);
    expect(shouldReleaseKeyboardResizeWriteHold(KEYBOARD_RESIZE_WRITE_HOLD_MAX_MS, 0)).toBe(true);
  });
});

describe('shouldProcessObservedResize', () => {
  it('freezes background mobile terminals while the keyboard changes layout', () => {
    expect(shouldProcessObservedResize(true, false)).toBe(false);
    expect(shouldProcessObservedResize(true, true)).toBe(true);
  });

  it('keeps desktop split-pane resize observation active', () => {
    expect(shouldProcessObservedResize(false, false)).toBe(true);
    expect(shouldProcessObservedResize(false, true)).toBe(true);
  });
});

describe('getActivationRefreshMode', () => {
  it('uses one coalesced repaint when activating a stationary desktop split pane', () => {
    expect(getActivationRefreshMode(false, true)).toBe('single');
  });

  it('keeps settled slide refreshes and leaves mobile to its resize path', () => {
    expect(getActivationRefreshMode(false, false)).toBe('settled');
    expect(getActivationRefreshMode(true, false)).toBe('none');
    expect(getActivationRefreshMode(true, true)).toBe('none');
  });
});

describe('shouldSchedulePageFlipRefresh', () => {
  it('keeps the page-flip stabilization refresh on desktop', () => {
    expect(shouldSchedulePageFlipRefresh(false, false)).toBe(true);
  });

  it('skips the duplicate page-flip refresh on mobile', () => {
    expect(shouldSchedulePageFlipRefresh(true, false)).toBe(false);
  });

  it('honors an explicit refresh suppression', () => {
    expect(shouldSchedulePageFlipRefresh(false, true)).toBe(false);
  });
});

describe('shouldForceSettledRedraw', () => {
  it('keeps the recovery redraw when terminal dimensions stayed unchanged', () => {
    expect(shouldForceSettledRedraw(
      { cols: 80, rows: 24 },
      { cols: 80, rows: 24 },
    )).toBe(true);
  });

  it('skips the redundant redraw after xterm already resized and repainted', () => {
    expect(shouldForceSettledRedraw(
      { cols: 80, rows: 24 },
      { cols: 100, rows: 30 },
    )).toBe(false);
  });

  it('uses the conservative recovery path when dimensions are unavailable', () => {
    expect(shouldForceSettledRedraw(null, { cols: 80, rows: 24 })).toBe(true);
    expect(shouldForceSettledRedraw({ cols: 80, rows: 24 }, null)).toBe(true);
  });
});

describe('shouldForceObservedResizeRedraw', () => {
  it('does not blank freshly written rows during the initial observer settle', () => {
    expect(shouldForceObservedResizeRedraw(
      false,
      { cols: 80, rows: 24 },
      { cols: 80, rows: 24 },
    )).toBe(false);
  });

  it('retains recovery redraws for later real layout changes', () => {
    expect(shouldForceObservedResizeRedraw(
      true,
      { cols: 80, rows: 24 },
      { cols: 80, rows: 24 },
    )).toBe(true);
  });
});

describe('shouldRefreshTerminalBuffer', () => {
  it('skips normal fit-only refreshes because resize and writes already repaint', () => {
    expect(shouldRefreshTerminalBuffer(false, false, false)).toBe(false);
  });

  it('keeps explicit recovery and DPR redraws', () => {
    expect(shouldRefreshTerminalBuffer(true, false, false)).toBe(true);
    expect(shouldRefreshTerminalBuffer(false, true, false)).toBe(true);
  });

  it('does not redraw twice after renderer recovery already repainted', () => {
    expect(shouldRefreshTerminalBuffer(true, true, true)).toBe(false);
  });
});
