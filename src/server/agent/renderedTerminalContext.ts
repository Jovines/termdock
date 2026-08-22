import xtermHeadless from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';

const { Terminal } = xtermHeadless;

export const AUTO_TITLE_SCROLLBACK_LINES = 400;

function createTerminal(cols: number, rows: number): HeadlessTerminal {
  return new Terminal({
    cols,
    rows,
    convertEol: false,
    scrollback: AUTO_TITLE_SCROLLBACK_LINES,
  });
}

/**
 * Mirrors PTY output through xterm's parser so title generation sees the
 * rendered terminal (including scrollback), not every transient redraw byte.
 */
export class RenderedTerminalContext {
  private terminal: HeadlessTerminal;
  private cols: number;
  private rows: number;
  private generation = 0;
  private disposed = false;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.terminal = createTerminal(cols, rows);
  }

  write(data: string, onParsed?: (text: string) => void): void {
    if (this.disposed) return;
    const terminal = this.terminal;
    const generation = this.generation;
    terminal.write(data, () => {
      if (this.disposed || generation !== this.generation || terminal !== this.terminal) return;
      onParsed?.(this.read());
    });
  }

  async snapshot(): Promise<string> {
    if (this.disposed) return '';
    const terminal = this.terminal;
    const generation = this.generation;
    await new Promise<void>((resolve) => terminal.write('', resolve));
    if (this.disposed || generation !== this.generation || terminal !== this.terminal) return '';
    return this.read();
  }

  read(): string {
    if (this.disposed) return '';
    const buffer = this.terminal.buffer.active;
    const start = Math.max(0, buffer.length - AUTO_TITLE_SCROLLBACK_LINES - this.terminal.rows);
    // The cursor row is still being authored and is where spinners/progress
    // indicators normally redraw. Only completed rendered rows are title input.
    const activeRow = buffer.baseY + buffer.cursorY;
    const logicalLines: string[] = [];

    for (let row = start; row < buffer.length; row += 1) {
      if (row === activeRow) continue;
      const line = buffer.getLine(row);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && logicalLines.length > 0) {
        logicalLines[logicalLines.length - 1] += text;
      } else {
        logicalLines.push(text);
      }
    }

    return logicalLines.join('\n').trim();
  }

  resize(cols: number, rows: number): void {
    if (this.disposed || (cols === this.cols && rows === this.rows)) return;
    this.cols = cols;
    this.rows = rows;
    this.terminal.resize(cols, rows);
  }

  reset(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.terminal.dispose();
    this.terminal = createTerminal(this.cols, this.rows);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.terminal.dispose();
  }
}
