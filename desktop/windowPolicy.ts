/**
 * Terminal workspace windows must keep draining live output while macOS puts
 * the app behind another window. The lightweight connection center can retain
 * Chromium's normal energy-saving behavior.
 */
export function shouldThrottleDesktopRenderer(isServiceWindow: boolean): boolean {
  return !isServiceWindow;
}
