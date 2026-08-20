/**
 * Encode multi-line text as one bracketed-paste payload. `submitAfterPaste` is
 * reserved for explicit UI actions that intentionally paste and then submit;
 * ordinary clipboard paste keeps every newline inside the protected block.
 */
export function buildBracketedPastePayload(text: string, submitAfterPaste: boolean): string {
  const normalized = text.replace(/\r?\n/g, '\r');
  const content = submitAfterPaste && normalized.endsWith('\r')
    ? normalized.slice(0, -1)
    : normalized;
  const escaped = content.replace(/\x1b/g, '␛');
  return `\x1b[200~${escaped}\x1b[201~${submitAfterPaste ? '\r' : ''}`;
}
