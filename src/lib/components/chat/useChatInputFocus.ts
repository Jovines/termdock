import { useLayoutEffect, type RefObject } from 'react';
import { isIOSDevice } from '../../utils/touchTerminalLayout';

/** Terminal's transparent input does not trigger WebKit's focus reveal scroll.
 * Give the visible editor that same protection during focus, then restore it
 * before the next paint. Keep native selection and touch gestures intact. */
export function useChatInputFocus(input: RefObject<HTMLTextAreaElement>, active: boolean): void {
  useLayoutEffect(() => {
    const node = input.current;
    if (!active || !node || !isIOSDevice()) return;
    let frame: number | undefined;
    let restore: (() => void) | undefined;
    const protectFocus = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (!restore) {
        const opacity = node.style.opacity, transition = node.style.transition;
        restore = () => { node.style.opacity = opacity; node.style.transition = transition; restore = undefined; };
      }
      node.style.transition = 'none';
      node.style.opacity = '0';
      frame = requestAnimationFrame(() => { frame = undefined; restore?.(); });
    };
    // Native taps, keyboard Next/Previous, and programmatic draft/quote focus
    // must all get the protection before Safari decides to reveal the caret.
    const focus = node.focus;
    const ownFocus = Object.getOwnPropertyDescriptor(node, 'focus');
    node.focus = (options?: FocusOptions) => { protectFocus(); focus.call(node, { ...options, preventScroll: true }); };
    node.addEventListener('pointerdown', protectFocus, true);
    node.addEventListener('focus', protectFocus, true);
    return () => {
      if (ownFocus) Object.defineProperty(node, 'focus', ownFocus);
      else Reflect.deleteProperty(node, 'focus');
      node.removeEventListener('pointerdown', protectFocus, true);
      node.removeEventListener('focus', protectFocus, true);
      if (frame !== undefined) cancelAnimationFrame(frame);
      restore?.();
    };
  }, [input, active]);
}
