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

const promptWrites = new WeakMap<object, Promise<void>>();

/** Serialize TD prompt pairs per PTY. Success only records terminal writes. */
export function writeBracketedPrompt(target: { write: (data: string) => void }, prompt: string): Promise<void> {
  const previous = promptWrites.get(target) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    target.write(buildBracketedPasteBytes(prompt));
    await waitForPromptSubmit();
    target.write('\r');
  }).finally(() => { if (promptWrites.get(target) === operation) promptWrites.delete(target); });
  promptWrites.set(target, operation);
  return operation;
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
