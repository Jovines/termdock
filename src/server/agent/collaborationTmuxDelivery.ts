import { plainCollaborationSnapshot } from './collaborationText.js';
import type { CollaborationPaneBinding } from './collaborationRouting.js';
import { normalizePromptForPaste, waitForPromptSubmit } from './promptDelivery.js';
import { serializeTerminalInput, type TerminalInputGuard, type PromptWriteProgress } from './terminalInput.js';

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

/** Unique-per-process buffer name so concurrent deliveries to different panes
 *  never share (or clobber) a buffer. */
let bufferSequence = 0;
function paneInputKey(pane: CollaborationPaneBinding): string {
  return `${pane.serverPid}:${pane.sessionId}:${pane.paneId}:${pane.panePid}`;
}

/** Serialize TD paste/submit pairs for this exact runtime pane. */
export function writeCollaborationTmuxPane(
  run: (args: string[]) => Promise<string>,
  pane: CollaborationPaneBinding,
  prompt: string,
  stdin: (args: string[], input: string) => Promise<string>,
  assertCurrent?: TerminalInputGuard,
  progress?: PromptWriteProgress,
): Promise<void> {
  progress?.('queue_wait');
  return serializeTerminalInput(paneInputKey(pane), () => {
    progress?.('queue_acquired');
    assertCurrent?.('queue_acquired');
    return writeTmuxPrompt(run, pane, prompt, stdin, assertCurrent, progress);
  });
}

async function writeTmuxPrompt(
  run: (args: string[]) => Promise<string>,
  pane: CollaborationPaneBinding,
  prompt: string,
  /** Body travels on stdin so tmux cannot parse its semicolons/backslashes. */
  stdin: (args: string[], input: string) => Promise<string>,
  assertCurrent?: TerminalInputGuard,
  progress?: PromptWriteProgress,
): Promise<void> {
  await assertSamePane(run, pane);
  assertCurrent?.('before_paste');
  // A fixed pane target is independent of the current window, keyboard focus
  // and browser presence. Delivery goes through a named tmux buffer rather
  // than `send-keys -l`: while a pane is in copy-mode, literal bytes are
  // routed to the mode's key table (they scroll or do nothing) and never
  // reach the app, whereas paste-buffer writes into the pty regardless of
  // mode and leaves the mode and scroll position untouched.
  //
  // The bracketed-paste wrapper is left to tmux (-p) instead of riding in the
  // payload. tmux adds the pair exactly when the application has bracketed
  // paste on and adds nothing when it does not — so an agent TUI sees one
  // paste while a plain shell sees clean text — and the marker bytes never
  // enter the buffer, where tmux 3.7+ would run them through vis(3) and land
  // a literal `^[` in the pane instead of a control byte. The same vis pass
  // is why the body must carry no ESC: escape bytes are exactly what it
  // rewrites, and an ESC-free body makes the pass a byte-for-byte no-op on
  // every tmux version.
  const buffer = `termdock-collab-${process.pid}-${bufferSequence++}`;
  try {
    // Paste once, then send one unbracketed CR after 50ms. No screen parsing,
    // Agent-specific recovery, consumption confirmation or additional Enter.
    progress?.('paste_attempted');
    await stdin([
      // The body arrives on stdin, not argv: it is user content, and in a
      // `\;` chain argv is a language where `;` and `\` mean something.
      'load-buffer', '-b', buffer, '-', ';',
      // -r keeps LF as LF rather than the separator default of CR. The
      // normalizer already folded every line break to CR, so no LF is left
      // for it to rewrite — the flag is insurance, not the mechanism.
      'paste-buffer', '-p', '-r', '-d', '-b', buffer, '-t', pane.paneId,
    ], normalizePromptForPaste(prompt));
    progress?.('paste_written');
    await waitForPromptSubmit();
    await assertSamePane(run, pane);
    assertCurrent?.('before_submit');
    progress?.('submit_attempted');
    await run([
      // The submit key rides outside the paste block: inside it, an editor
      // inserts a pasted CR as text instead of acting on it. Pasting the bare
      // CR (no -p) keeps the key in the same mode-proof channel as the text.
      'set-buffer', '-b', buffer, '--', '\r', ';',
      'paste-buffer', '-d', '-b', buffer, '-t', pane.paneId,
    ]);
    progress?.('submit_written');
  } finally {
    // -d consumed the buffer on the happy path; this sweeps up after a failed
    // paste so no stray buffer is left on the server.
    await run(['delete-buffer', '-b', buffer]).catch(() => undefined);
  }
}

/** True while the pane is in any tmux mode (copy-mode, choose-tree, …), i.e.
 *  keys sent to it are consumed by the mode handler instead of the app. */
export async function paneInMode(
  run: (args: string[]) => Promise<string>,
  pane: CollaborationPaneBinding,
): Promise<boolean> {
  return (await run(['display-message', '-p', '-t', pane.paneId, '#{pane_in_mode}'])).trim() === '1';
}

/** Inject a named key into a member pane after proving the pane identity
 *  unchanged. Named keys only — no freeform keystroke passthrough. Refuses
 *  while the pane is in a mode: there the key would be taken by the mode
 *  handler (Enter in copy-mode exits the user's scroll) rather than the app. */
export function sendTmuxPaneKey(
  run: (args: string[]) => Promise<string>,
  pane: CollaborationPaneBinding,
  key: CollaborationPaneKey,
  assertCurrent?: TerminalInputGuard,
): Promise<void> {
  return serializeTerminalInput(paneInputKey(pane), () => sendTmuxPaneKeyUnlocked(run, pane, key, assertCurrent));
}

async function sendTmuxPaneKeyUnlocked(
  run: (args: string[]) => Promise<string>, pane: CollaborationPaneBinding, key: CollaborationPaneKey, assertCurrent?: TerminalInputGuard,
): Promise<void> {
  await assertSamePane(run, pane);
  if (await paneInMode(run, pane)) throw new Error('TMUX_PANE_IN_MODE');
  assertCurrent?.();
  await run(['send-keys', '-t', pane.paneId, TMUX_KEY_NAMES[key]]);
}

/** Current pane screen text (viewport), identity-checked. */
export async function captureTmuxPaneText(
  run: (args: string[]) => Promise<string>,
  pane: CollaborationPaneBinding,
  rawOutput = false,
): Promise<string> {
  await assertSamePane(run, pane);
  const raw = await run(['capture-pane', '-p', '-J', ...(rawOutput ? ['-e'] : []), '-t', pane.paneId]);
  return rawOutput ? raw : plainCollaborationSnapshot(raw);
}

/** Dismiss an interactive approval dialog on the member pane by pressing
 *  Enter (the highlighted option). Refuses unless the screen actually shows
 *  an approval prompt: driving a dialog that isn't there would only inject
 *  a stray keystroke into the agent's work. Returns false when no dialog. */
export function approveCollaborationDialog(
  run: (args: string[]) => Promise<string>,
  pane: CollaborationPaneBinding,
  assertCurrent?: TerminalInputGuard,
): Promise<boolean> {
  return serializeTerminalInput(paneInputKey(pane), async () => {
    assertCurrent?.();
    const content = await captureTmuxPaneText(run, pane);
    if (!detectApprovalDialog(content)) return false;
    // The same input queue covers both the observation and requested key.
    await sendTmuxPaneKeyUnlocked(run, pane, 'enter', assertCurrent);
    return true;
  });
}

/** History-inclusive terminal observation, without inferring consumption. */
export async function captureTmuxPaneHistory(
  run: (args: string[]) => Promise<string>,
  pane: CollaborationPaneBinding,
  lines = 800,
  rawOutput = false,
): Promise<string> {
  await assertSamePane(run, pane);
  if (!Number.isInteger(lines) || lines < 1 || lines > 10000) throw new Error('INVALID_HISTORY_LINES');
  const raw = await run(['capture-pane', '-p', '-J', ...(rawOutput ? ['-e'] : []), '-S', `-${lines}`, '-t', pane.paneId]);
  return rawOutput ? raw : plainCollaborationSnapshot(raw);
}
