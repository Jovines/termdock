/**
 * Encode a prompt as one bracketed-paste block followed by one real Enter.
 * Agent TUIs then keep embedded newlines inside the editor instead of treating
 * each line as a separate submission.
 */
export function buildBracketedSubmitBytes(prompt: string): string {
  const normalized = prompt.replace(/\r\n|\r|\n/g, '\r');
  const escaped = normalized.replace(/\x1b/g, '␛');
  return `\x1b[200~${escaped}\x1b[201~\r`;
}
