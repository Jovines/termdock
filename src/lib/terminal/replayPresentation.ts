const XTERM_SYNC_OUTPUT_BEGIN = '\x1b[?2026h';
const XTERM_SYNC_OUTPUT_END = '\x1b[?2026l';
const XTERM_FULL_RESET = '\x1bc';

/**
 * Replace a rendered terminal without exposing the reset as an intermediate
 * frame. xterm holds rendering between DEC synchronized-output markers, so the
 * previous frame remains visible until the reset and complete replay have been
 * parsed together.
 */
export function buildAtomicTerminalReplay(chunks: readonly string[]): string[] {
  const replay = chunks.filter((chunk) => chunk.length > 0).join('');
  if (!replay) return [];
  return [`${XTERM_SYNC_OUTPUT_BEGIN}${XTERM_FULL_RESET}${replay}${XTERM_SYNC_OUTPUT_END}`];
}
