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

/**
 * Recover the text inserted by a native textarea paste/input event.
 *
 * Mobile Safari does not always expose clipboard text on the `paste` event. In
 * that case it mutates the textarea and reports the change through `input`
 * instead. Treat an explicit paste inputType, or any atomic multiline
 * insertion, as paste so embedded newlines can still be bracketed before they
 * reach the PTY.
 */
export function detectTextareaPaste(
  previousValue: string,
  nextValue: string,
  inputType: string | undefined,
): string | null {
  let prefixLength = 0;
  while (
    prefixLength < previousValue.length &&
    prefixLength < nextValue.length &&
    previousValue[prefixLength] === nextValue[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  const previousRemainder = previousValue.length - prefixLength;
  const nextRemainder = nextValue.length - prefixLength;
  while (
    suffixLength < previousRemainder &&
    suffixLength < nextRemainder &&
    previousValue[previousValue.length - 1 - suffixLength] ===
      nextValue[nextValue.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const inserted = nextValue.slice(prefixLength, nextValue.length - suffixLength);
  if (!inserted) return null;

  const nativePaste = inputType === 'insertFromPaste' || inputType === 'insertFromPasteAsQuotation';
  return nativePaste || /[\r\n]/.test(inserted) ? inserted : null;
}
