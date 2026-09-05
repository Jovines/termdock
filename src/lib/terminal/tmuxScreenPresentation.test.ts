import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { buildTmuxScreenReplacement } from './tmuxScreenPresentation';

const write = (terminal: Terminal, data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));

describe('tmux screen replacement', () => {
  it('keeps rendering synchronized even when parsing pauses after the reset', async () => {
    const terminal = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    // Inspect DEC mode through DECRQM, using public parser/terminal APIs.
    const replies: string[] = [];
    terminal.onData((data) => replies.push(data));
    // The headless declaration predates async parser handlers; its parser
    // supports the same Promise pause/resume path as the browser build.
    terminal.parser.registerOscHandler(777, (async () => {
      await Promise.resolve();
      return true;
    }) as unknown as (data: string) => boolean);
    await write(terminal, 'old history\r\nold prompt');
    await write(terminal, '\x1b[?2026h\x1bc\x1b[?2026$p');
    expect(replies.at(-1)).toBe('\x1b[?2026;2$y');
    replies.length = 0;
    await write(terminal, buildTmuxScreenReplacement([
      '\x1b]777;yield\x07\x1b[?2026$pnew prompt',
    ])[0]);
    expect(replies).toContain('\x1b[?2026;1$y');
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('new prompt');
    expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe('');
    await write(terminal, '\x1b[?2026$p');
    expect(replies.at(-1)).toBe('\x1b[?2026;2$y');
    terminal.dispose();
  });

  it('clears stale history when the authoritative screen is empty', async () => {
    const terminal = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    await write(terminal, ('old history\r\n').repeat(20));
    terminal.resize(20, 8);
    await write(terminal, buildTmuxScreenReplacement([])[0]);
    expect(terminal.buffer.active.baseY).toBe(0);
    for (let row = 0; row < terminal.rows; row++) {
      expect(terminal.buffer.active.getLine(row)?.translateToString(true)).toBe('');
    }
    terminal.dispose();
  });

  it('replaces an alternate screen without switching buffers or keeping old margins', async () => {
    const terminal = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    await write(terminal, 'normal history\x1b[?1049h\x1b[2;3r\x1b[?6hOLD');
    await write(terminal, buildTmuxScreenReplacement(['top\x1b[4;1Hbottom'])[0]);
    expect(terminal.buffer.active.type).toBe('alternate');
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('top');
    expect(terminal.buffer.active.getLine(3)?.translateToString(true)).toBe('bottom');
    await write(terminal, '\r\nnext');
    expect(terminal.buffer.active.getLine(2)?.translateToString(true)).toBe('bottom');
    expect(terminal.buffer.active.getLine(3)?.translateToString(true)).toBe('next');
    terminal.dispose();
  });
});
