import { encodeTerminalKey } from './keyboard';

export interface ToolbarKeyCombo {
  key: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export const TOOLBAR_NAMED_KEYS = [
  ['ArrowLeft', '←'], ['ArrowRight', '→'], ['ArrowUp', '↑'], ['ArrowDown', '↓'],
  ['Home', 'Home'], ['End', 'End'], ['PageUp', 'Page Up'], ['PageDown', 'Page Down'],
  ['Tab', 'Tab'], ['Enter', 'Enter'], ['Escape', 'Esc'],
  ['Backspace', 'Backspace'], ['Delete', 'Delete'], ['Insert', 'Insert'], [' ', 'Space'],
] as const;

export const TOOLBAR_CHARACTER_KEYS = Array.from('abcdefghijklmnopqrstuvwxyz0123456789`-=[]\\;\',./');
const SHIFTED_CHARACTERS: Record<string, string> = Object.fromEntries(
  Array.from('0123456789`-=[]\\;\',./', (key, i) => [key, ')!@#$%^&*(~_+{}|:"<>?'[i]]),
);

export function getToolbarKeyComboLabel(combo: ToolbarKeyCombo): string {
  const label = TOOLBAR_NAMED_KEYS.find(([key]) => key === combo.key)?.[1] ?? combo.key.toUpperCase();
  return [combo.ctrl && 'Ctrl', combo.alt && 'Alt', combo.shift && 'Shift', label].filter(Boolean).join('+');
}

/** Keep editable sequences printable, including built-ins stored with raw controls. */
export function escapeToolbarSequence(sequence: string): string {
  return sequence.replace(/[\u0000-\u001f\u007f]/g, char => {
    if (char === '\r') return '\\r';
    if (char === '\n') return '\\n';
    if (char === '\t') return '\\t';
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

/** Only expose chords representable by the terminal's existing legacy protocol. */
export function encodeToolbarKeyCombo(combo: ToolbarKeyCombo): string | null {
  const { key, shift, ctrl, alt } = combo;
  // These modifiers have no distinct legacy encoding; do not silently drop them.
  if ((key === 'Tab' && ctrl) || (key === 'Enter' && (ctrl || (shift && alt)))
    || (key === 'Escape' && (ctrl || shift)) || (key === 'Backspace' && shift)
    || (key === 'Insert' && (shift || ctrl))) return null;
  const effectiveKey = key.length === 1 && shift ? SHIFTED_CHARACTERS[key] ?? key.toUpperCase() : key;
  const encoded = encodeTerminalKey({ key: effectiveKey, shiftKey: shift, ctrlKey: ctrl, altKey: alt, metaKey: false });
  const sequence = encoded ?? (key === 'Enter' ? '\r' : key === 'Backspace' ? '\u007f'
    : key.length === 1 && !ctrl && !alt ? effectiveKey : null);
  // A literal space would be removed by the toolbar's empty-action filter.
  return sequence === null ? null : sequence === ' ' ? '\\u0020' : escapeToolbarSequence(sequence);
}
