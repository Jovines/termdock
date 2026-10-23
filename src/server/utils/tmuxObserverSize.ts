/** An ignored observer still becomes tmux's size fallback when every browser
 * disconnects. Keep it at the selected display's grid, never the 80x24 default.
 */
export function retainTmuxObserverSize(
  session: { cols: number; rows: number; ptyProcess: { resize(cols: number, rows: number): void } },
  cols: number,
  rows: number,
): void {
  if (session.cols === cols && session.rows === rows) return;
  session.ptyProcess.resize(cols, rows);
  session.cols = cols;
  session.rows = rows;
}

/** Preserve an existing window when creating its backend observer, including
 * after a service restart. A guessed default would resize the running TUI.
 */
export async function readTmuxObserverSize(
  run: (args: string[]) => Promise<string>, target: string,
): Promise<{ cols: number; rows: number }> {
  // display-message resolves a pane; an exact session target needs its colon.
  const paneTarget = target.startsWith('=') && !target.includes(':') ? `${target}:` : target;
  const raw = await run(['display-message', '-p', '-t', paneTarget, '#{window_width} #{window_height} #{status}']);
  const [width, height, status] = raw.trim().split(/\s+/);
  const cols = Number(width), paneRows = Number(height);
  const statusRows = status === 'on' ? 1 : status === 'off' ? 0 : Number(status);
  if (![cols, paneRows, statusRows].every(Number.isSafeInteger)
    || cols < 1 || paneRows < 1 || statusRows < 0 || statusRows > 5) {
    throw new Error('TMUX_WINDOW_GEOMETRY_UNAVAILABLE');
  }
  return { cols, rows: paneRows + statusRows };
}
