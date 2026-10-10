// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { canHandleSplitShortcut } from './splitKeyboardShortcut';

afterEach(() => { document.body.innerHTML = ''; });
function keyAt(target: HTMLElement, options: KeyboardEventInit = {}) {
  document.body.append(target);
  const event = new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}
describe('split shortcut input ownership', () => {
  it.each(['input', 'textarea', 'select'])('preserves editing in %s', tag => {
    expect(canHandleSplitShortcut(keyAt(document.createElement(tag)), false)).toBe(false);
  });
  it('preserves contenteditable descendants', () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.setAttribute('contenteditable', 'true');
    const child = editor.appendChild(document.createElement('span'));
    document.body.append(editor);
    const event = new KeyboardEvent('keydown', { bubbles: true });
    child.dispatchEvent(event);
    expect(canHandleSplitShortcut(event, false)).toBe(false);
  });
  it('allows the bare terminal but yields to its top layer and IME', () => {
    const viewport = document.createElement('div');
    viewport.className = 'terminal-viewport-container';
    const input = viewport.appendChild(document.createElement('textarea'));
    input.setAttribute('data-terminal-input-anchor', 'true');
    document.body.append(viewport);
    const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true });
    input.dispatchEvent(event);
    expect(canHandleSplitShortcut(event, false)).toBe(true);
    expect(canHandleSplitShortcut(event, true)).toBe(false);
    expect(canHandleSplitShortcut(keyAt(input, { isComposing: true }), false)).toBe(false);
    expect(canHandleSplitShortcut(keyAt(input, { keyCode: 229 }), false)).toBe(false);
  });
  it('respects already claimed keys', () => {
    const event = keyAt(document.createElement('div'));
    event.preventDefault();
    expect(canHandleSplitShortcut(event, false)).toBe(false);
  });
});
