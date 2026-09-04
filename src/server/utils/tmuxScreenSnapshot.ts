export const TMUX_CURSOR_MARKER = '__TERMDOCK_CURSOR__';

export interface TmuxPaneSnapshot {
  content: string;
  cursorX: number | null;
  cursorY: number | null;
}

const TMUX_SCREEN_RESET = '\u001b[H\u001b[2J\u001b[3J';

export function parseTmuxPaneSnapshot(output: string): TmuxPaneSnapshot {
  const markerIndex = output.lastIndexOf(TMUX_CURSOR_MARKER);
  if (markerIndex < 0) {
    return { content: output, cursorX: null, cursorY: null };
  }

  const cursorMatch = output
    .slice(markerIndex + TMUX_CURSOR_MARKER.length)
    .match(/^(\d+),(\d+)(?:\r?\n)?$/);
  if (!cursorMatch) {
    return { content: output, cursorX: null, cursorY: null };
  }

  // capture-pane prints one newline after the pane's final physical row so
  // the following display-message starts on a new output line. Replaying that
  // command-level delimiter into a pane-height xterm would advance past the
  // bottom row and scroll the captured grid up by one before CUP restores the
  // original cursor coordinates.
  const content = output.slice(0, markerIndex).replace(/\r?\n$/, '');
  return {
    content,
    cursorX: Number(cursorMatch[1]),
    cursorY: Number(cursorMatch[2]),
  };
}

export function buildTmuxScreenSnapshot(snapshot: TmuxPaneSnapshot): string[] {
  const chunks = [
    TMUX_SCREEN_RESET,
    // capture-pane is line-oriented, whereas live tmux output contains the
    // carriage returns required by convertEol=false.
    snapshot.content.replace(/\r?\n/g, '\r\n'),
  ];

  if (
    Number.isFinite(snapshot.cursorX)
    && Number.isFinite(snapshot.cursorY)
    && snapshot.cursorX !== null
    && snapshot.cursorY !== null
    && snapshot.cursorX >= 0
    && snapshot.cursorY >= 0
  ) {
    // tmux reports zero-based pane coordinates; CUP is one-based. Restoring
    // the cursor is essential because replaying capture-pane text alone leaves
    // xterm at the newline after the final captured row until the TUI repaints.
    chunks.push(`\u001b[${Math.floor(snapshot.cursorY) + 1};${Math.floor(snapshot.cursorX) + 1}H`);
  }

  return chunks;
}
