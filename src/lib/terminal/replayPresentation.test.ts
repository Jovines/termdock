import { describe, expect, it } from 'vitest';
import { buildAtomicTerminalReplay } from './replayPresentation';

describe('buildAtomicTerminalReplay', () => {
  it('resets and replays inside one synchronized xterm write', () => {
    expect(buildAtomicTerminalReplay(['first', '', 'second'])).toEqual([
      '\x1b[?2026h\x1bcfirstsecond\x1b[?2026l',
    ]);
  });

  it('does not emit a visible reset for an empty replay', () => {
    expect(buildAtomicTerminalReplay(['', ''])).toEqual([]);
  });
});
