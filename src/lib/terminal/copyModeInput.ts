const ESCAPE_SEQUENCE = '\x1b';

/**
 * Escape is tmux copy-mode's cancel key. When Termdock exits copy mode through
 * the control channel first, forwarding the same byte would leak it into the
 * program running in the pane.
 */
export function shouldConsumeAfterTmuxCopyModeExit(input: string): boolean {
  return input === ESCAPE_SEQUENCE;
}
