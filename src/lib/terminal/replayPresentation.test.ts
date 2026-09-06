import { describe, expect, it } from 'vitest';
import { buildAtomicTerminalReplay } from './replayPresentation';
import { Terminal } from '@xterm/headless';

describe('buildAtomicTerminalReplay', () => {
  it('holds multiple application frames until the outer replay ends', async () => {
    const terminal = new Terminal({ allowProposedApi: true });
    try {
      const data = buildAtomicTerminalReplay([
        '\x1b[?202', '6hfirst\x1b[?2026l',
        '\x1b[?25;2026hsecond\x1b[?2026;2004l',
        '\x1bcthird\x9b?2026hfourth\x9b?2026l\x1b[!p',
      ])[0];
      const end = '\x1b[?2026l';
      // Feed incrementally: a large replay may exceed xterm's parser slice.
      for (const part of data.slice(0, -end.length).match(/.{1,11}/gs)!) {
        await new Promise<void>(resolve => terminal.write(part, resolve));
      }
      expect(terminal.modes.synchronizedOutputMode).toBe(true);
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('thirdfourth');
      await new Promise<void>(resolve => terminal.write(end, resolve));
      expect(terminal.modes.synchronizedOutputMode).toBe(false);
    } finally {
      terminal.dispose();
    }
  });

  it('preserves other private modes and opaque control-string payloads', () => {
    const payloads = '\x1b]2;title\x1b[?2026l\x07\x1bPimage\x1bc\x1b\\';
    const result = buildAtomicTerminalReplay([payloads, '\x1b[?25;2026h\x1b[?2026;2004l'])[0];
    expect(result).toContain(payloads);
    expect(result).toContain('\x1b[?25h\x1b[?2004l');
  });

  it('resets and replays inside one synchronized xterm write', () => {
    expect(buildAtomicTerminalReplay(['first', '', 'second'])).toEqual([
      '\x1bc\x1b[?2026hfirstsecond\x1b[?2026l',
    ]);
  });

  it('does not emit a visible reset for an empty replay', () => {
    expect(buildAtomicTerminalReplay(['', ''])).toEqual([]);
  });

  it('does not let a leading server reset cancel synchronized output', () => {
    expect(buildAtomicTerminalReplay(['\x1bc', '\x1bccontent'])).toEqual([
      '\x1bc\x1b[?2026hcontent\x1b[?2026l',
    ]);
  });

  it('keeps xterm synchronized until the replay terminator is parsed', async () => {
    const terminal = new Terminal({ allowProposedApi: true });
    try {
      const data = buildAtomicTerminalReplay(['\x1bc', 'content'])[0];
      const end = '\x1b[?2026l';
      await new Promise<void>(resolve => terminal.write(data.slice(0, -end.length), resolve));
      expect(terminal.modes.synchronizedOutputMode).toBe(true);
      await new Promise<void>(resolve => terminal.write(end, resolve));
      expect(terminal.modes.synchronizedOutputMode).toBe(false);
    } finally {
      terminal.dispose();
    }
  });
});
