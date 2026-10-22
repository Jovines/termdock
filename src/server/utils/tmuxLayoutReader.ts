/** One fresh, read-only tmux query for the complete session layout. No attached
 * control client, sizing changes, keystrokes, or cross-request identity cache. */
export interface TmuxPane {
  id: string; index: number; active: boolean; width: number; height: number;
  top: number; left: number; command: string; pid: number; tty: string; title: string; currentPath: string;
}
export interface TmuxWindow { id: string; name: string; index: number; active: boolean; panes: TmuxPane[] }
export interface TmuxLayout {
  sessionId: string; sessionName: string; windows: TmuxWindow[];
  activeWindowId: string; activePaneId: string; inCopyMode: boolean; serverPid?: number;
}
const separator = '\x1f';
export const TMUX_LAYOUT_FORMAT = [
  'pid', 'session_id', 'session_name', 'window_id', 'window_name', 'window_index', 'window_active',
  'pane_id', 'pane_index', 'pane_active', 'pane_width', 'pane_height', 'pane_top', 'pane_left',
  'pane_current_command', 'pane_pid', 'pane_tty', 'pane_title', 'pane_in_mode', 'pane_current_path',
].map(field => `#{${field}}`).join(separator);

export function parseTmuxLayout(stdout: string, requestedName: string): TmuxLayout {
  let layout: TmuxLayout | undefined;
  const windows = new Map<string, TmuxWindow>(), ids = new Set<string>();
  for (const line of stdout.trimEnd().split('\n')) {
    if (!line) continue;
    const columns = line.replaceAll('\\037', separator).replaceAll('\\x1f', separator).split(separator);
    if (columns.length < 20) throw new Error('TMUX_LAYOUT_UNAVAILABLE');
    const [server, sessionId, sessionName, windowId, name, windowIndex, windowActive, id, index, active,
      width, height, top, left, command, pid, tty, title, inMode] = columns;
    const serverPid = Number(server);
    if (!Number.isSafeInteger(serverPid) || serverPid <= 0 || sessionName !== requestedName || !sessionId || !windowId || !id
      || ids.has(id) || layout && (layout.serverPid !== serverPid || layout.sessionId !== sessionId)) throw new Error('TMUX_SESSION_IDENTITY_CHANGED');
    ids.add(id);
    layout ??= { serverPid, sessionId, sessionName, windows: [], activeWindowId: '', activePaneId: '', inCopyMode: false };
    let window = windows.get(windowId);
    if (!window) {
      window = { id: windowId, name, index: Number(windowIndex), active: windowActive === '1', panes: [] };
      windows.set(windowId, window); layout.windows.push(window);
    } else if (window.name !== name || window.index !== Number(windowIndex) || window.active !== (windowActive === '1')) {
      throw new Error('TMUX_SESSION_IDENTITY_CHANGED');
    }
    const pane: TmuxPane = { id, index: Number(index), active: active === '1', width: Number(width), height: Number(height),
      top: Number(top), left: Number(left), command, pid: Number(pid), tty, title, currentPath: columns.slice(19).join(separator) };
    if (![window.index, pane.index, pane.width, pane.height, pane.top, pane.left, pane.pid].every(Number.isSafeInteger)
      || pane.pid <= 0) throw new Error('TMUX_LAYOUT_UNAVAILABLE');
    window.panes.push(pane);
    if (window.active && pane.active) {
      if (layout.activePaneId) throw new Error('TMUX_SESSION_IDENTITY_CHANGED');
      layout.activeWindowId = window.id; layout.activePaneId = pane.id; layout.inCopyMode = inMode === '1';
    }
  }
  if (!layout || !layout.activePaneId) throw new Error('TMUX_LAYOUT_UNAVAILABLE');
  layout.windows.sort((a, b) => a.index - b.index);
  for (const window of layout.windows) window.panes.sort((a, b) => a.index - b.index);
  return layout;
}

export async function readTmuxLayout(run: (args: string[]) => Promise<string>, sessionName: string): Promise<TmuxLayout> {
  return parseTmuxLayout(await run(['list-panes', '-s', '-t', `=${sessionName}:`, '-F', TMUX_LAYOUT_FORMAT]), sessionName);
}

export async function readTmuxLayouts(run: (args: string[]) => Promise<string>): Promise<Map<string, TmuxLayout>> {
  const rows = new Map<string, string[]>();
  for (const row of (await run(['list-panes', '-a', '-F', TMUX_LAYOUT_FORMAT])).trimEnd().split('\n')) {
    const name = row.replaceAll('\\037', separator).replaceAll('\\x1f', separator).split(separator)[2];
    if (!name) continue;
    const lines = rows.get(name) ?? []; lines.push(row); rows.set(name, lines);
  }
  const layouts = new Map<string, TmuxLayout>();
  for (const [name, lines] of rows) {
    try { layouts.set(name, parseTmuxLayout(lines.join('\n'), name)); }
    catch { /* UI discovery can fall back to an exact fresh read of that session. */ }
  }
  return layouts;
}
