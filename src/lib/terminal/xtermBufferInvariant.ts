import type { Terminal } from '@xterm/xterm';

interface InternalLineStore {
  length: number;
  maxLength?: number;
  push: (line: unknown) => void;
}

interface InternalBuffer {
  ybase: number;
  ydisp?: number;
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
  const viewportRows = Math.floor(rows);
  const capacity = Number.isFinite(buffer.lines.maxLength) && buffer.lines.maxLength! > 0
    ? Math.floor(buffer.lines.maxLength!)
    : null;
  let added = 0;

  // CircularList.push() replaces its oldest entry once maxLength is reached,
  // so its length no longer grows. Clamp an impossible ybase first; otherwise
  // a naive `while (length < ybase + rows)` becomes an infinite main-thread
  // loop while a sidebar drag repeatedly fits the terminal.
  if (capacity !== null) {
    const maxYbase = Math.max(0, capacity - viewportRows);
    if (buffer.ybase > maxYbase) {
      buffer.ybase = maxYbase;
      if (Number.isFinite(buffer.ydisp)) {
        buffer.ydisp = Math.min(buffer.ydisp!, maxYbase);
      }
      added++;
    }
  }

  const requiredLength = Math.max(0, Math.floor(buffer.ybase) + viewportRows);
  const targetLength = capacity === null ? requiredLength : Math.min(requiredLength, capacity);
  const missingLines = Math.max(0, targetLength - buffer.lines.length);
  for (let index = 0; index < missingLines; index++) {
    const lengthBeforePush = buffer.lines.length;
    buffer.lines.push(buffer.getBlankLine(undefined));
    if (buffer.lines.length <= lengthBeforePush) break;
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
