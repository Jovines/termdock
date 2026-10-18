/** A has-session failure is not evidence that tmux itself is unavailable.
 * Confirm this one empty-server case without changing generic error handling. */
export async function isConfirmedEmptyTmuxServer(
  error: unknown,
  target: string,
  run: (args: string[]) => Promise<string>,
): Promise<boolean> {
  if (!target.trim() || !error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; stderr?: unknown };
  if (value.code !== 1 || typeof value.stderr !== 'string' || value.stderr.trim() !== 'no current target') return false;
  try { return (await run(['list-sessions', '-F', '#{session_id}'])).trim() === ''; }
  catch { return false; }
}
