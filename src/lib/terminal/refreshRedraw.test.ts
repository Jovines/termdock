import { describe, expect, it } from 'vitest';
import {
  getActivationRefreshMode,
  shouldForceObservedResizeRedraw,
  shouldForceSettledRedraw,
  shouldProcessObservedResize,
  shouldRefreshTerminalBuffer,
  shouldSchedulePageFlipRefresh,
} from './refreshRedraw';

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
