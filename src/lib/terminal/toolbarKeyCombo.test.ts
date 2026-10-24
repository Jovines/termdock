import { describe, expect, it } from 'vitest';
import { decodeToolbarSequence } from '../components/terminal/mobileKeyboardPresets';
import { encodeToolbarKeyCombo, escapeToolbarSequence, getToolbarKeyComboLabel, type ToolbarKeyCombo } from './toolbarKeyCombo';

const combo = (key: string, modifiers: Partial<ToolbarKeyCombo> = {}): ToolbarKeyCombo => ({ key, shift: false, ctrl: false, alt: false, ...modifiers });

describe('toolbar key combination encoding', () => {
  it.each([
    ['ArrowLeft', { shift: true }, '\x1b[1;2D'],
    ['ArrowRight', { ctrl: true, shift: true }, '\x1b[1;6C'],
    ['ArrowUp', { alt: true }, '\x1b[1;3A'],
    ['ArrowDown', { ctrl: true, alt: true, shift: true }, '\x1b[1;8B'],
    ['Home', { shift: true }, '\x1b[1;2H'],
    ['PageDown', { ctrl: true }, '\x1b[6;5~'],
    ['F1', { shift: true, alt: true }, '\x1b[1;4P'],
    ['F12', { ctrl: true, shift: true }, '\x1b[24;6~'],
    ['Tab', { shift: true }, '\x1b[Z'],
    ['Enter', { shift: true }, '\n'],
    ['Enter', {}, '\r'],
    ['Backspace', {}, '\x7f'],
    ['Backspace', { ctrl: true, alt: true }, '\x1b\x08'],
    ['c', { ctrl: true }, '\x03'],
    ['x', { alt: true, shift: true }, '\x1bX'],
    [' ', { ctrl: true }, '\x00'],
    [' ', {}, ' '],
    [' ', { shift: true }, ' '],
    ['2', { ctrl: true, shift: true }, '\x00'],
    ['1', { shift: true }, '!'],
    ['/', { shift: true, ctrl: true }, '\x7f'],
  ] as const)('encodes %s with %j through the existing sequence decoder', (key, modifiers, expected) => {
    const sequence = encodeToolbarKeyCombo(combo(key, modifiers));
    expect(sequence).not.toBeNull();
    expect(sequence!.trim().length).toBeGreaterThan(0);
    expect(sequence).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(decodeToolbarSequence(sequence!)).toBe(expected);
  });

  it.each([
    ['Tab', { ctrl: true }], ['Enter', { ctrl: true }], ['Enter', { alt: true, shift: true }],
    ['Escape', { shift: true }], ['Backspace', { shift: true }], ['Insert', { ctrl: true }],
    ['9', { ctrl: true }], ['Meta', {}],
  ] as const)('rejects %s with %j instead of silently losing modifiers', (key, modifiers) => {
    expect(encodeToolbarKeyCombo(combo(key, modifiers))).toBeNull();
  });

  it('makes raw controls editable without changing existing escaped sequences or delimiters', () => {
    const sequence = '/||undo\r\x1b[1;2D\t\\u0003';
    expect(escapeToolbarSequence(sequence)).toBe('/||undo\\r\\u001b[1;2D\\t\\u0003');
    expect(decodeToolbarSequence(escapeToolbarSequence(sequence))).toBe(decodeToolbarSequence(sequence));
    expect(getToolbarKeyComboLabel(combo('ArrowLeft', { shift: true }))).toBe('Shift+←');
  });
});
