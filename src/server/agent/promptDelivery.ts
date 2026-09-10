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

/**
 * Encode a prompt as one bracketed-paste block followed by one real Enter.
 * Agent TUIs then keep embedded newlines inside the editor instead of treating
 * each line as a separate submission.
 */
export function buildBracketedSubmitBytes(prompt: string): string {
  return `\x1b[200~${normalizePromptForPaste(prompt)}\x1b[201~\r`;
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
