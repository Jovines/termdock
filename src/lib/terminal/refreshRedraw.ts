export interface TerminalDimensions {
  cols: number;
  rows: number;
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
