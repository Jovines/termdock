/** tmux window activity is updated by pane output, unlike the display PTY,
 * which also emits status-line redraws. Read every window, including hidden ones.
 * https://github.com/tmux/tmux/blob/master/window.c (window_update_activity)
 */
export async function readCollectionOutputTime(run: (args: string[]) => Promise<string>, sessionId: string, windows: string[]): Promise<number> {
  const text = await run(['list-windows', '-t', sessionId, '-F', '#{window_id}\t#{window_activity}']);
  const rows = text.trim().split('\n').map(line => line.split('\t'));
  const expected = new Set(windows);
  if (!expected.size || rows.length !== expected.size || new Set(rows.map(row => row[0])).size !== expected.size
    || rows.some(([id, time, extra]) => !expected.has(id) || extra !== undefined || !/^\d+$/.test(time) || !Number.isSafeInteger(Number(time)) || Number(time) <= 0)) throw new Error('无法确认收集终端的输出时间');
  // Activity format has second resolution: count through the end of that second.
  return Math.max(...rows.map(([, time]) => Number(time) * 1000)) + 1000;
}
