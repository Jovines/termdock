import type { CollaborationPaneBinding } from './collaborationRouting.js';
import { buildBracketedSubmitBytes } from './promptDelivery.js';

/** Terminal-level keys a caller may inject into a member pane. Kept
 * enumerated (never freeform): driving another session's keyboard is strong
 * control, and every action stays explainable in one word. */
export type CollaborationPaneKey = 'enter' | 'escape' | 'space' | 'left' | 'right' | 'up' | 'down';

const TMUX_KEY_NAMES: Record<CollaborationPaneKey, string> = {
  enter: 'Enter', escape: 'Escape', space: 'Space', left: 'Left', right: 'Right', up: 'Up', down: 'Down',
};

/** Screen text that means an interactive approval/confirm dialog is showing.
 * Driving approve sends Enter, which activates the highlighted option — the
 * number of tools that render such prompts is finite, but the phrasing is
 * not, so match generously and never press keys without this evidence. */
const APPROVAL_DIALOG_PATTERNS = [
  /requires approval/i,
  /needs? approval/i,
  /do you want to proceed/i,
  /do you want to (continue|run this)/i,
  /is this ok/i,
  /\b1\.\s*yes\b/i,
  /需要批准|需要授权|等待批准/i,
  /是否(允许|继续|执行|批准)/,
  /\b1\.\s*是\b/,
  /允许.*执行|确认.*执行/i,
];

export function detectApprovalDialog(content: string): boolean {
  return APPROVAL_DIALOG_PATTERNS.some((pattern) => pattern.test(content));
}

async function assertSamePane(
  run: (args: string[]) => Promise<string>,
  pane: CollaborationPaneBinding,
): Promise<void> {
  const identity = (await run(['display-message', '-p', '-t', pane.paneId,
    '#{pid}:#{session_id}:#{pane_id}:#{pane_pid}'])).trim();
  if (identity !== `${pane.serverPid}:${pane.sessionId}:${pane.paneId}:${pane.panePid}`) throw new Error('TMUX_PANE_CHANGED');
}

export async function writeCollaborationTmuxPane(
  run: (args: string[]) => Promise<string>,
  pane: CollaborationPaneBinding,
  prompt: string,
): Promise<void> {
  await assertSamePane(run, pane);
  // A fixed pane target is independent of the current window, keyboard focus
  // and browser presence. One invocation preserves the bracketed submit bytes.
  await run(['send-keys', '-t', pane.paneId, '-l', '--', buildBracketedSubmitBytes(prompt)]);
}

/** Inject a named key into a member pane after proving the pane identity
 *  unchanged. Named keys only — no freeform keystroke passthrough. */
export async function sendTmuxPaneKey(
  run: (args: string[]) => Promise<string>,
  pane: CollaborationPaneBinding,
  key: CollaborationPaneKey,
): Promise<void> {
  await assertSamePane(run, pane);
  await run(['send-keys', '-t', pane.paneId, TMUX_KEY_NAMES[key]]);
}

/** Current pane screen text (viewport), identity-checked. */
export async function captureTmuxPaneText(
  run: (args: string[]) => Promise<string>,
  pane: CollaborationPaneBinding,
): Promise<string> {
  await assertSamePane(run, pane);
  const raw = await run(['capture-pane', '-p', '-J', '-t', pane.paneId]);
  return raw.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

/** Dismiss an interactive approval dialog on the member pane by pressing
 *  Enter (the highlighted option). Refuses unless the screen actually shows
 *  an approval prompt: driving a dialog that isn't there would only inject
 *  a stray keystroke into the agent's work. Returns false when no dialog. */
export async function approveCollaborationDialog(
  run: (args: string[]) => Promise<string>,
  pane: CollaborationPaneBinding,
): Promise<boolean> {
  const content = await captureTmuxPaneText(run, pane);
  if (!detectApprovalDialog(content)) return false;
  await sendTmuxPaneKey(run, pane, 'enter');
  return true;
}

/** History-inclusive pane text (scrollback + viewport) used to confirm a
 *  delivery was actually rendered by the agent, not wiped by a boot clear. */
export async function captureTmuxPaneHistory(
  run: (args: string[]) => Promise<string>,
  pane: CollaborationPaneBinding,
  lines = 800,
): Promise<string> {
  await assertSamePane(run, pane);
  const raw = await run(['capture-pane', '-p', '-J', '-S', `-${lines}`, '-t', pane.paneId]);
  return raw.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}
