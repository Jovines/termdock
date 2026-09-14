import { describe, expect, it } from 'vitest';
import { encodeTerminalKey } from './keyboard';

function key(name: string, modifiers: Partial<KeyboardEvent> = {}) {
  return { key: name, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...modifiers };
}

describe('terminal hardware keyboard encoding', () => {
  for (const application of [false, true]) {
    for (const [name, final] of Object.entries({ ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' })) {
      it(`${name} preserves cursor mode and all Shift/Alt/Ctrl combinations (application=${application})`, () => {
        expect(encodeTerminalKey(key(name), application)).toBe(`\x1b${application ? 'O' : '['}${final}`);
        for (let bits = 1; bits < 8; bits++) {
          expect(encodeTerminalKey(key(name, {
            shiftKey: !!(bits & 1), altKey: !!(bits & 2), ctrlKey: !!(bits & 4),
          }), application)).toBe(`\x1b[1;${bits + 1}${final}`);
        }
      });
    }
  }

  it.each([
    ['F1', '\x1bOP', '\x1b[1;2P'], ['F2', '\x1bOQ', '\x1b[1;2Q'],
    ['F3', '\x1bOR', '\x1b[1;2R'], ['F4', '\x1bOS', '\x1b[1;2S'],
    ['F5', '\x1b[15~', '\x1b[15;2~'], ['F6', '\x1b[17~', '\x1b[17;2~'],
    ['F7', '\x1b[18~', '\x1b[18;2~'], ['F8', '\x1b[19~', '\x1b[19;2~'],
    ['F9', '\x1b[20~', '\x1b[20;2~'], ['F10', '\x1b[21~', '\x1b[21;2~'],
    ['F11', '\x1b[23~', '\x1b[23;2~'], ['F12', '\x1b[24~', '\x1b[24;2~'],
    ['Delete', '\x1b[3~', '\x1b[3;2~'], ['PageUp', '\x1b[5~', '\x1b[5;2~'],
    ['PageDown', '\x1b[6~', '\x1b[6;2~'], ['Tab', '\t', '\x1b[Z'],
  ])('%s retains Shift and ordinary behavior', (name, plain, shifted) => {
    expect(encodeTerminalKey(key(name))).toBe(plain);
    expect(encodeTerminalKey(key(name, { shiftKey: true }))).toBe(shifted);
  });

  it.each([
    ['c', '\x03'], ['C', '\x03'], [' ', '\x00'], ['@', '\x00'], ['2', '\x00'],
    ['[', '\x1b'], ['\\', '\x1c'], [']', '\x1d'], ['^', '\x1e'], ['_', '\x1f'],
    ['3', '\x1b'], ['4', '\x1c'], ['5', '\x1d'], ['6', '\x1e'], ['7', '\x1f'],
    ['8', '\x7f'], ['?', '\x7f'], ['/', '\x1f'],
  ])('Ctrl+%s sends the control byte, optionally prefixed by Alt', (name, expected) => {
    expect(encodeTerminalKey(key(name, { ctrlKey: true }))).toBe(expected);
    expect(encodeTerminalKey(key(name, { ctrlKey: true, altKey: true }))).toBe(`\x1b${expected}`);
  });

  it('handles Alt and modified editing keys without stealing ordinary textarea edits', () => {
    expect(encodeTerminalKey(key('Enter'))).toBeNull();
    expect(encodeTerminalKey(key('Backspace'))).toBeNull();
    expect(encodeTerminalKey(key('Enter', { altKey: true }))).toBe('\x1b\r');
    expect(encodeTerminalKey(key('Backspace', { ctrlKey: true }))).toBe('\x08');
    expect(encodeTerminalKey(key('Backspace', { ctrlKey: true, altKey: true }))).toBe('\x1b\x08');
    expect(encodeTerminalKey(key('Escape', { altKey: true }))).toBe('\x1b\x1b');
    expect(encodeTerminalKey(key('X', { altKey: true, shiftKey: true }))).toBe('\x1bX');
  });

  it('leaves IME, AltGr, native shortcuts, text and standalone modifiers alone', () => {
    for (const name of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Process', 'a', '中']) {
      expect(encodeTerminalKey(key(name))).toBeNull();
    }
    expect(encodeTerminalKey(key('ArrowUp', { isComposing: true }))).toBeNull();
    expect(encodeTerminalKey(key('Tab', { keyCode: 229 }))).toBeNull();
    expect(encodeTerminalKey(key('@', { ctrlKey: true, altKey: true, getModifierState: name => name === 'AltGraph' }))).toBeNull();
    expect(encodeTerminalKey(key('ArrowLeft', { metaKey: true }))).toBeNull();
    expect(encodeTerminalKey(key('Insert', { shiftKey: true }))).toBeNull();
    expect(encodeTerminalKey(key('Insert', { ctrlKey: true }))).toBeNull();
    expect(encodeTerminalKey(key('Insert'))).toBe('\x1b[2~');
    expect(encodeTerminalKey(key('Insert', { altKey: true, ctrlKey: true }))).toBe('\x1b[2;7~');
    expect(encodeTerminalKey(key('9', { ctrlKey: true }))).toBeNull();
  });
});
