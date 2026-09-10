import type { CollaborationPaneBinding } from './collaborationRouting.js';
import { normalizePromptForPaste } from './promptDelivery.js';

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

/** Agent TUIs collapse pasted input in the input box to a marker line like
 * "[Pasted text #3 +42 lines]". While the paste sits unsubmitted the marker
 * stays on screen; a submitted paste clears the box and only the transcript
 * holds the content. Session-unique #N lets us diff screen captures. */
const PASTE_MARKER_PATTERN = /\[Pasted text #(\d+)/g;

export function detectApprovalDialog(content: string): boolean {
  return APPROVAL_DIALOG_PATTERNS.some((pattern) => pattern.test(content));
}

/** Paste marker sequence numbers visible in a screen capture. */
export function extractPasteMarkerNumbers(content: string): Set<number> {
  return new Set([...content.matchAll(PASTE_MARKER_PATTERN)].map((match) => Number(match[1])));
}

/** True when `after` shows a paste marker that was not in `before`. Diffing
 * prevents a recovery Enter from submitting a stale paste that predates this
 * delivery (or someone else's draft): we only ever submit what we just put
 * there, at most once per delivery. */
export function hasNewPasteMarker(after: string, before: string): boolean {
  const beforeNumbers = extractPasteMarkerNumbers(before);
  return [...extractPasteMarkerNumbers(after)].some((number) => !beforeNumbers.has(number));
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

export async function writeCollaborationTmuxPane(
  run: (args: string[]) => Promise<string>,
  pane: CollaborationPaneBinding,
  prompt: string,
): Promise<void> {
  await assertSamePane(run, pane);
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
    await run(['set-buffer', '-b', buffer, '--', normalizePromptForPaste(prompt)]);
    // -r keeps LF as LF rather than the separator default of CR. The
    // normalizer already folded every line break to CR, so no LF is left for
    // it to rewrite — the flag is insurance, not the mechanism.
    await run(['paste-buffer', '-p', '-r', '-d', '-b', buffer, '-t', pane.paneId]);
    // The submit key rides outside the paste block: inside it, an editor
    // inserts a pasted CR as text instead of acting on it. Pasting the bare
    // CR (no -p) keeps the key in the same mode-proof channel as the text.
    await run(['set-buffer', '-b', buffer, '--', '\r']);
    await run(['paste-buffer', '-d', '-b', buffer, '-t', pane.paneId]);
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
export async function sendTmuxPaneKey(
  run: (args: string[]) => Promise<string>,
  pane: CollaborationPaneBinding,
  key: CollaborationPaneKey,
): Promise<void> {
  await assertSamePane(run, pane);
  if (await paneInMode(run, pane)) throw new Error('TMUX_PANE_IN_MODE');
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
  // sendTmuxPaneKey refuses in-mode panes, so a dialog-looking screen behind a
  // user's scroll never turns Enter into copy-mode navigation.
  await sendTmuxPaneKey(run, pane, 'enter');
  return true;
}

/** Submit a paste that arrived while the agent was finishing its previous
 *  turn and is still sitting unsubmitted in the input box. Only acts on
 *  differential evidence — a paste marker that appeared after the write —
 *  never on pre-existing stale markers, and returns whether Enter was sent.
 *  Committing the whole input buffer is safe: each delivery is written once,
 *  so each marker's content enters the transcript exactly once. */
export async function recoverStuckPaste(
  run: (args: string[]) => Promise<string>,
  pane: CollaborationPaneBinding,
  baseline: string,
): Promise<boolean> {
  const viewport = await captureTmuxPaneText(run, pane);
  if (!hasNewPasteMarker(viewport, baseline)) return false;
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
