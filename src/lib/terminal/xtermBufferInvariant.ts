import type { Terminal } from '@xterm/xterm';

interface InternalLineStore {
  length: number;
  push: (line: unknown) => void;
}

interface InternalBuffer {
  ybase: number;
  lines: InternalLineStore;
  getBlankLine: (attr?: unknown) => unknown;
}

interface InternalBufferSet {
  normal?: InternalBuffer;
  alt?: InternalBuffer;
}

interface InternalTerminal {
  _core?: {
    _bufferService?: {
      buffers?: InternalBufferSet;
    };
  };
}

export function repairXtermBufferViewport(
  buffer: InternalBuffer | null | undefined,
  rows: number,
): number {
  if (!buffer || buffer.lines.length === 0 || !Number.isFinite(rows) || rows <= 0) {
    return 0;
  }
  const requiredLength = Math.max(0, Math.floor(buffer.ybase) + Math.floor(rows));
  let added = 0;
  while (buffer.lines.length < requiredLength) {
    buffer.lines.push(buffer.getBlankLine(undefined));
    added++;
  }
  return added;
}

/**
 * Compatibility guard for xterm.js #6063. Some resize histories can leave a
 * logical buffer shorter than its visible viewport. The next row growth then
 * exposes missing BufferLine entries as repeated/corrupt rows. Repair both
 * allocated buffers before and after a fit until the upstream fix ships.
 */
export function repairXtermBufferInvariants(terminal: Terminal, rows = terminal.rows): number {
  const internals = terminal as unknown as InternalTerminal;
  const buffers = internals._core?._bufferService?.buffers;
  if (!buffers) return 0;
  return repairXtermBufferViewport(buffers.normal, rows)
    + repairXtermBufferViewport(buffers.alt, rows);
}
