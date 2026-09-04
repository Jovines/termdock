import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import {
  buildTmuxScreenSnapshot,
  parseTmuxPaneSnapshot,
  TMUX_CURSOR_MARKER,
} from './tmuxScreenSnapshot.js';

describe('tmux screen snapshots', () => {
  it('separates the pane text from its zero-based cursor coordinates', () => {
    expect(parseTmuxPaneSnapshot(`first\nsecond\n${TMUX_CURSOR_MARKER}2,7\n`)).toEqual({
      content: 'first\nsecond',
      cursorX: 2,
      cursorY: 7,
    });
  });

  it('restores the cursor after replaying the captured grid', () => {
    expect(buildTmuxScreenSnapshot({
      content: 'first\nsecond',
      cursorX: 2,
      cursorY: 7,
    })).toEqual([
      '\u001b[H\u001b[2J\u001b[3J',
      'first\r\nsecond',
      '\u001b[8;3H',
    ]);
  });

  it('removes only the command delimiter after a blank final pane row', () => {
    expect(parseTmuxPaneSnapshot(`first\n\n${TMUX_CURSOR_MARKER}0,1\n`).content).toBe('first\n');
  });

  it('replays a pane-height capture without scrolling the prompt away from its cursor', async () => {
    const terminal = new Terminal({ cols: 12, rows: 4, scrollback: 0 });
    const parsed = parseTmuxPaneSnapshot(
      `first\nsecond\n› Ask Codex\nstatus\n${TMUX_CURSOR_MARKER}2,2\n`,
    );

    await new Promise<void>((resolve) => {
      terminal.write(buildTmuxScreenSnapshot(parsed).join(''), resolve);
    });

    expect(terminal.buffer.active.cursorX).toBe(2);
    expect(terminal.buffer.active.cursorY).toBe(2);
    expect(terminal.buffer.active.getLine(2)?.translateToString(true)).toBe('› Ask Codex');
  });

  it('keeps a usable text-only snapshot when cursor metadata is missing', () => {
    const parsed = parseTmuxPaneSnapshot('first\nsecond\n');
    expect(parsed).toEqual({ content: 'first\nsecond\n', cursorX: null, cursorY: null });
    expect(buildTmuxScreenSnapshot(parsed)).toEqual([
      '\u001b[H\u001b[2J\u001b[3J',
      'first\r\nsecond\r\n',
    ]);
  });
});
