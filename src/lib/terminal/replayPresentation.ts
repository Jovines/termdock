const XTERM_SYNC_OUTPUT_BEGIN = '\x1b[?2026h';
const XTERM_SYNC_OUTPUT_END = '\x1b[?2026l';
const XTERM_FULL_RESET = '\x1bc';

/** DEC synchronized output is a boolean, not a nesting counter. Keep only
 * the replay's outer transaction. Control-string payloads are opaque: an OSC
 * title or DCS image containing escape bytes must not be rewritten.
 */
function normalizeReplayTransactions(replay: string): string {
  return replay.replace(
    /(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)|(?:\x1b[P_X^]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)|(?:\x1b\[|\x9b)\?([\d;]+)([hl])|(?:\x1b\[|\x9b)[\d;]*!p|\x1bc/g,
    (sequence: string, modes: string | undefined, action: string | undefined) => {
      if (sequence === XTERM_FULL_RESET || sequence.endsWith('!p')) {
        return sequence + XTERM_SYNC_OUTPUT_BEGIN;
      }
      if (modes === undefined) return sequence;
      const remaining = modes.split(';').filter(mode => Number(mode) !== 2026);
      return remaining.length ? `\x1b[?${remaining.join(';')}${action}` : '';
    },
  );
}

/**
 * Replace a rendered terminal without exposing the reset as an intermediate
 * frame. xterm holds rendering between DEC synchronized-output markers, so the
 * previous frame remains visible until the reset and complete replay have been
 * parsed together.
 */
export function buildAtomicTerminalReplay(chunks: readonly string[]): string[] {
  const replay = chunks.filter((chunk) => chunk.length > 0).join('');
  if (!replay) return [];
  // RIS resets DEC modes, including synchronized output. Enable the render
  // transaction AFTER reset, and avoid repeating a leading server reset.
  const content = normalizeReplayTransactions(replay.replace(/^(?:\x1bc)+/, ''));
  return [`${XTERM_FULL_RESET}${XTERM_SYNC_OUTPUT_BEGIN}${content}${XTERM_SYNC_OUTPUT_END}`];
}
