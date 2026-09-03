// @vitest-environment jsdom
import type { Terminal } from '@xterm/xterm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { repairXtermBufferInvariants, repairXtermBufferViewport } from './xtermBufferInvariant';

const write = (terminal: Terminal, data: string) => new Promise<void>((resolve) => {
  terminal.write(data, resolve);
});

beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

describe('xterm buffer viewport invariant', () => {
  it('backfills missing visible rows without touching an uninitialized buffer', () => {
    const lines: unknown[] = [{ line: 1 }, { line: 2 }];
    const buffer = {
      ybase: 1,
      lines: {
        get length() { return lines.length; },
        push: (line: unknown) => { lines.push(line); },
      },
      getBlankLine: () => ({ blank: true }),
    };
    expect(repairXtermBufferViewport(buffer, 3)).toBe(2);
    expect(lines).toHaveLength(4);

    const emptyLines: unknown[] = [];
    expect(repairXtermBufferViewport({
      ...buffer,
      lines: {
        get length() { return emptyLines.length; },
        push: (line: unknown) => { emptyLines.push(line); },
      },
    }, 3)).toBe(0);
  });

  it('prevents repeated-row corruption when a scrolled viewport grows', async () => {
    const { Terminal } = await import('@xterm/xterm');
    const terminal = new Terminal({ cols: 39, rows: 18, scrollback: 100, convertEol: false });
    await write(terminal, Array.from({ length: 22 }, (_, index) => `line-${index}\r\n`).join('') + '\x1b[4A');

    const core = (terminal as unknown as {
      _core: { _bufferService: { buffer: { ybase: number; lines: { length: number } } } };
    })._core;
    const buffer = core._bufferService.buffer;
    buffer.lines.length = 18;

    expect(repairXtermBufferInvariants(terminal)).toBe(5);
    terminal.resize(37, 23);
    expect(buffer.lines.length).toBeGreaterThanOrEqual(buffer.ybase + terminal.rows);

    for (let row = 18; row <= 22; row++) {
      await write(terminal, `\x1b[${row + 1};1H\x1b[2Kbottom-${row}`);
      expect(terminal.buffer.active.getLine(row)).toBeDefined();
    }
    terminal.dispose();
  });
});
