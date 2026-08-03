const ESCAPE_SEQUENCE = '\x1b';
const FOCUS_REPORT_SEQUENCE = /\x1b\[[IO]/g;
const SGR_MOUSE_SEQUENCE = /\x1b\[<[0-9]+;[0-9]+;[0-9]+[mM]/y;
const URXVT_MOUSE_SEQUENCE = /\x1b\[[0-9]+;[0-9]+;[0-9]+M/y;

function matchesAt(pattern: RegExp, input: string, offset: number): number {
  pattern.lastIndex = offset;
  const match = pattern.exec(input);
  return match ? pattern.lastIndex : -1;
}

/**
 * xterm may emit mouse reports alone or coalesced with focus reports. Accept
 * SGR, legacy X10 and urxvt encodings so none of them are mistaken for a key.
 */
export function isTmuxMouseOrFocusInput(input: string): boolean {
  const withoutFocus = input.replace(FOCUS_REPORT_SEQUENCE, '');
  if (withoutFocus.length === 0) return input.length > 0;

  let offset = 0;
  while (offset < withoutFocus.length) {
    let next = matchesAt(SGR_MOUSE_SEQUENCE, withoutFocus, offset);
    if (next < 0) next = matchesAt(URXVT_MOUSE_SEQUENCE, withoutFocus, offset);
    if (next < 0 && withoutFocus.startsWith('\x1b[M', offset) && withoutFocus.length >= offset + 6) {
      next = offset + 6;
    }
    if (next < 0) return false;
    offset = next;
  }
  return true;
}

/**
 * Escape is tmux copy-mode's cancel key. When Termdock exits copy mode through
 * the control channel first, forwarding the same byte would leak it into the
 * program running in the pane.
 */
export function shouldConsumeAfterTmuxCopyModeExit(input: string): boolean {
  return input === ESCAPE_SEQUENCE;
}
