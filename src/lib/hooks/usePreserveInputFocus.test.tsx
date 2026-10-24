// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { usePreserveInputFocus } from './usePreserveInputFocus';

afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.replaceChildren(); });
function setup(enabled = true) {
  const surface = document.createElement('div'), text = document.createElement('span'), input = document.createElement('textarea');
  surface.setAttribute('role', 'button'); surface.append(text); document.body.append(surface, input);
  input.value = '原有中文草稿'; input.focus(); input.setSelectionRange(2, 4);
  const focus = vi.spyOn(input, 'focus'), blur = vi.spyOn(input, 'blur');
  const hook = renderHook(() => usePreserveInputFocus({ current: surface }, { current: input }, enabled));
  const down = () => {
    const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperties(event, { pointerType: { value: 'touch' }, isPrimary: { value: true } });
    text.dispatchEvent(event); return event;
  };
  const mouse = (target: Element = text, fromTouch?: boolean) => {
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    if (fromTouch !== undefined) Object.defineProperty(event, 'sourceCapabilities', { value: { firesTouchEvents: fromTouch } });
    target.dispatchEvent(event); return event;
  };
  return { surface, text, input, focus, blur, down, mouse, ...hook };
}

it('prevents only compatibility focus transfer without changing the active input or its selection', () => {
  const { input, focus, blur, down, mouse, text } = setup();
  expect(down().defaultPrevented).toBe(false);
  const move = new Event('touchmove', { bubbles: true, cancelable: true }); text.dispatchEvent(move);
  expect(move.defaultPrevented).toBe(false);
  expect(mouse().defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(input);
  expect(focus).not.toHaveBeenCalled(); expect(blur).not.toHaveBeenCalled();
  expect(input.value).toBe('原有中文草稿');
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 4]);
});

it.each(['button', 'a', 'input', 'textarea', 'select', 'label'])('leaves intentional %s controls alone', tag => {
  const { surface, down, mouse } = setup();
  const control = document.createElement(tag), child = document.createElement('span');
  control.append(child); surface.append(control); down();
  expect(mouse(child).defaultPrevented).toBe(false);
});

it('respects mouse input and deliberate focus changes', () => {
  const { down, mouse, focus, blur } = setup(); down();
  expect(mouse(undefined, false).defaultPrevented).toBe(false);
  const other = document.createElement('input'); document.body.append(other); other.focus();
  expect(mouse(undefined, true).defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(other);
  expect(focus).not.toHaveBeenCalled(); expect(blur).not.toHaveBeenCalled();
});

it('does not acquire focus when the editor is already unfocused', () => {
  const { input, focus, blur, down, mouse } = setup();
  input.blur(); blur.mockClear(); down();
  expect(mouse(undefined, true).defaultPrevented).toBe(false);
  expect(document.activeElement).not.toBe(input);
  expect(focus).not.toHaveBeenCalled(); expect(blur).not.toHaveBeenCalled();
});

it.each([true, false])('does not capture after unmount or while disabled (enabled=%s)', enabled => {
  const { down, mouse, unmount } = setup(enabled);
  if (enabled) unmount();
  down(); expect(mouse(undefined, true).defaultPrevented).toBe(false);
});
