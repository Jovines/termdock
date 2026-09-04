export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export type ActivationRefreshMode = 'none' | 'single' | 'settled';

/**
 * Mobile keeps every xterm mounted so Swiper page changes remain instant. A
 * soft-keyboard animation consequently resizes every slide's container, but
 * only terminals in the visible slide should spend work fitting and
 * repainting. Desktop split panes still need every observed resize because
 * inactive panes can be visible at the same time.
 */
export function shouldProcessObservedResize(
  touchLayout: boolean,
  isLayoutVisible: boolean,
): boolean {
  return !touchLayout || isLayoutVisible;
}

/**
 * Growing or shrinking xterm can temporarily move viewportY away from baseY
 * while its rows are reflowed. If the user was already following the bottom,
 * restore that invariant in the same task as resize so an intermediate paint
 * cannot expose unrelated scrollback. Deliberately scrolled history and the
 * alternate buffer keep their own positions.
 */
export function shouldPreserveBottomAfterFit(
  bufferType: string,
  baseY: number,
  viewportY: number,
): boolean {
  return bufferType !== 'alternate' && viewportY >= baseY;
}

export const KEYBOARD_FIT_SETTLE_QUIET_MS = 72;
export const KEYBOARD_FIT_SETTLE_MAX_MS = 650;
export const KEYBOARD_FIT_SETTLE_STABLE_FRAMES = 2;
export const KEYBOARD_RESIZE_WRITE_HOLD_QUIET_MS = 80;
export const KEYBOARD_RESIZE_WRITE_HOLD_MIN_MS = 240;
export const KEYBOARD_RESIZE_WRITE_HOLD_MAX_MS = 500;

export function nextKeyboardFitStableFrameCount(
  previousHeight: number | null,
  currentHeight: number,
  previousStableFrames: number,
  tolerancePx = 0.5,
): number {
  if (previousHeight === null || Math.abs(currentHeight - previousHeight) > tolerancePx) {
    return 0;
  }
  return previousStableFrames + 1;
}

export function shouldSettleKeyboardFit(
  elapsedMs: number,
  quietMs: number,
  stableFrames: number,
): boolean {
  return elapsedMs >= KEYBOARD_FIT_SETTLE_MAX_MS || (
    quietMs >= KEYBOARD_FIT_SETTLE_QUIET_MS &&
    stableFrames >= KEYBOARD_FIT_SETTLE_STABLE_FRAMES
  );
}

export function shouldDeferTerminalFit(
  touchLayout: boolean,
  keyboardFitFreezeActive: boolean,
): boolean {
  return touchLayout && keyboardFitFreezeActive;
}

export function shouldReleaseKeyboardResizeWriteHold(
  elapsedMs: number,
  writeQuietMs: number,
): boolean {
  return elapsedMs >= KEYBOARD_RESIZE_WRITE_HOLD_MAX_MS || (
    elapsedMs >= KEYBOARD_RESIZE_WRITE_HOLD_MIN_MS &&
    writeQuietMs >= KEYBOARD_RESIZE_WRITE_HOLD_QUIET_MS
  );
}

/**
 * A normal desktop slide change gets a second refresh after Swiper settles.
 * Split panes do not move, so activation only needs one coalesced repaint.
 * Mobile has its own forced resize path.
 */
export function getActivationRefreshMode(
  isMobile: boolean,
  suppressPageFlipRefresh: boolean,
): ActivationRefreshMode {
  if (isMobile) return 'none';
  return suppressPageFlipRefresh ? 'single' : 'settled';
}

/**
 * Mobile activation already schedules a forced resize refresh so xterm can
 * fit the newly active slide. Running the desktop page-flip refresh as well
 * causes multiple full-buffer paints around the Swiper settle frame, which is
 * visible as a brief flash on phones.
 */
export function shouldSchedulePageFlipRefresh(
  isMobile: boolean,
  suppressPageFlipRefresh: boolean,
): boolean {
  return getActivationRefreshMode(isMobile, suppressPageFlipRefresh) === 'settled';
}

/**
 * A real xterm resize already repaints the terminal. Only keep the settled
 * full-buffer redraw when dimensions stayed unchanged, or when either sample
 * is unavailable and the conservative recovery path is safer.
 */
export function shouldForceSettledRedraw(
  start: TerminalDimensions | null,
  settled: TerminalDimensions | null,
): boolean {
  if (!start || !settled) return true;
  return start.cols === settled.cols && start.rows === settled.rows;
}

/** The first observer burst belongs to xterm.open()/initial layout itself. */
export function shouldForceObservedResizeRedraw(
  hasCompletedInitialSettle: boolean,
  start: TerminalDimensions | null,
  settled: TerminalDimensions | null,
): boolean {
  return hasCompletedInitialSettle && shouldForceSettledRedraw(start, settled);
}

/**
 * Normal writes and xterm.resize() already repaint the DOM/WebGL renderer.
 * A second full-buffer refresh in the same startup frame briefly detaches all
 * DOM rows, which is visible as a white/blank flash on session activation.
 */
export function shouldRefreshTerminalBuffer(
  forceRedraw: boolean,
  devicePixelRatioChanged: boolean,
  rendererAlreadyRecovered: boolean,
): boolean {
  return !rendererAlreadyRecovered && (forceRedraw || devicePixelRatioChanged);
}
