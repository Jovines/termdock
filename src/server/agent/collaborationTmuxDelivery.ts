import type { CollaborationPaneBinding } from './collaborationRouting.js';
import { buildBracketedSubmitBytes } from './promptDelivery.js';

export async function writeCollaborationTmuxPane(
  run: (args: string[]) => Promise<string>,
  pane: CollaborationPaneBinding,
  prompt: string,
): Promise<void> {
  const identity = (await run(['display-message', '-p', '-t', pane.paneId,
    '#{pid}:#{session_id}:#{pane_id}:#{pane_pid}'])).trim();
  if (identity !== `${pane.serverPid}:${pane.sessionId}:${pane.paneId}:${pane.panePid}`) throw new Error('TMUX_PANE_CHANGED');
  // A fixed pane target is independent of the current window, keyboard focus
  // and browser presence. One invocation preserves the bracketed submit bytes.
  await run(['send-keys', '-t', pane.paneId, '-l', '--', buildBracketedSubmitBytes(prompt)]);
}
