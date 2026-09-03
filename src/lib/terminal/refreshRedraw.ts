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
