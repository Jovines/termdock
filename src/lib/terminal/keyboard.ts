type TerminalKey = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'> & {
  isComposing?: boolean;
  keyCode?: number;
  getModifierState?: (key: 'AltGraph') => boolean;
};

const CURSOR: Record<string, string> = {
  ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F',
};
const FUNCTION: Record<string, string> = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' };
const TILDE: Record<string, number> = {
  Insert: 2, Delete: 3, PageUp: 5, PageDown: 6,
  F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24,
};

/** Legacy xterm encoding. No unsolicited Kitty/CSI-u or modifier-release reports:
 * those require protocol negotiation with the application. null means textarea/app handling.
 * UI shortcuts and macOS line editing take precedence in the caller.
 */
export function encodeTerminalKey(event: TerminalKey, applicationCursor = false): string | null {
  if (event.metaKey || event.isComposing || event.keyCode === 229 || event.getModifierState?.('AltGraph')) return null;
  const { key, shiftKey: shift, altKey: alt, ctrlKey: ctrl } = event;
  const modifier = 1 + Number(shift) + 2 * Number(alt) + 4 * Number(ctrl);
  const suffix = modifier === 1 ? '' : `;${modifier}`;
  const cursor = CURSOR[key];
  if (cursor) return modifier !== 1 ? `\x1b[1${suffix}${cursor}` : `\x1b${applicationCursor ? 'O' : '['}${cursor}`;
  const fn = FUNCTION[key];
  if (fn) return modifier !== 1 ? `\x1b[1${suffix}${fn}` : `\x1bO${fn}`;
  // Preserve native Insert clipboard shortcuts.
  if (key === 'Insert' && !alt && (shift || ctrl)) return null;
  const tilde = TILDE[key];
  if (tilde) return `\x1b[${tilde}${suffix}~`;
  if (key === 'Tab') return alt ? `\x1b${shift ? '\x1b[Z' : '\t'}` : shift ? '\x1b[Z' : '\t';
  if (key === 'Escape') return alt ? '\x1b\x1b' : '\x1b';
  if (key === 'Enter') return alt ? '\x1b\r' : null;
  // Unmodified Backspace must retain textarea cursor/diff handling.
  if (key === 'Backspace') return ctrl || alt ? `${alt ? '\x1b' : ''}${ctrl ? '\x08' : '\x7f'}` : null;
  if (key.length !== 1) return null;
  if (ctrl) {
    const upper = key.toUpperCase();
    let code: number | undefined;
    if (/^[A-Z]$/.test(upper)) code = upper.charCodeAt(0) - 64;
    else if (key === ' ' || key === '@' || key === '2') code = 0;
    else if ('[\\]^_'.includes(key)) code = key.charCodeAt(0) - 64;
    else if (/^[3-7]$/.test(key)) code = Number(key) + 24;
    else if (key === '?' || key === '8') code = 127;
    else if (key === '/') code = 31;
    return code === undefined ? null : `${alt ? '\x1b' : ''}${String.fromCharCode(code)}`;
  }
  return alt ? `\x1b${key}` : null;
}
