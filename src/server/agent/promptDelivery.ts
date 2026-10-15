import { serializeTerminalInput, type TerminalInputGuard, type PromptWriteProgress } from './terminalInput.js';

/**
 * Fold a prompt into the single-channel form both tmux and agent TUIs expect:
 * every line break becomes one CR (commits a line inside the editor, and is
 * never a paste-end candidate), and a raw ESC becomes the visible ␛ glyph so
 * no byte sequence in the body can be mistaken for terminal control — notably
 * not our own bracketed-paste markers.
 */
export function normalizePromptForPaste(prompt: string): string {
  return prompt.replace(/\r\n|\r|\n/g, '\r').replace(/\x1b/g, '␛');
}

/** Separate the paste and its single unbracketed CR by 50ms. */
export const PROMPT_SUBMIT_DELAY_MS = 50;
export function waitForPromptSubmit(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, PROMPT_SUBMIT_DELAY_MS));
}

export function buildBracketedPasteBytes(prompt: string): string {
  return `\x1b[200~${normalizePromptForPaste(prompt)}\x1b[201~`;
}

/** Serialize TD prompt pairs per PTY. Success only records terminal writes. */
export function writeBracketedPrompt(target: { write: (data: string) => void }, prompt: string, assertCurrent?: TerminalInputGuard, progress?: PromptWriteProgress): Promise<void> {
  progress?.('queue_wait');
  return serializeTerminalInput(target, async () => {
    progress?.('queue_acquired');
    assertCurrent?.('queue_acquired');
    progress?.('paste_attempted');
    target.write(buildBracketedPasteBytes(prompt));
    progress?.('paste_written');
    await waitForPromptSubmit();
    assertCurrent?.('before_submit');
    progress?.('submit_attempted');
    target.write('\r');
    progress?.('submit_written');
  });
}

/**
 * Process detection and hook events are independent Agent signals. A target is
 * ready as soon as either signal proves that an Agent owns the foreground PTY.
 */
export function canDeliverPromptToAgent(target: {
  agent: unknown;
  agentSession: unknown;
}): boolean {
  return Boolean(target.agent || target.agentSession);
}
