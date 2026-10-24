import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { isIOSDevice } from '../utils/touchTerminalLayout';

/** Legacy focus guard: do not enable in the native iOS keyboard layout.
 * It intentionally suppresses WebKit's native page pan.
 * Keep this editor transparent until that same keyboard layout has settled;
 * a visual mirror preserves the draft without changing the real input/IME.
 * Opt in only for visible editors in the shared keyboard panel layout. Render
 * an aria-hidden, pointer-events-none draft mirror while the return value is true.
 * This guard does not measure or position anything; keyboard state comes from
 * useViewportKeyboardState. Ordinary dialogs do not need it by default. */
export function useKeyboardFocusGuard(input: RefObject<HTMLTextAreaElement | HTMLInputElement>, enabled: boolean, keyboard: { isOpen: boolean; isSettled: boolean }): boolean {
  const [masked, setMasked] = useState(false);
  const state = useRef(keyboard); state.current = keyboard;
  const finish = useRef<() => void>();
  useLayoutEffect(() => {
    const node = input.current;
    if (!enabled || !node || !isIOSDevice()) return;
    let frame: number | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let restore: (() => void) | undefined;
    const release = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
      frame = undefined; timer = undefined;
      restore?.(); restore = undefined; setMasked(false);
    };
    const afterLayout = () => {
      if (!restore) return;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(release); });
    };
    finish.current = afterLayout;
    const protect = () => {
      if (!restore) {
        const opacity = node.style.opacity, transition = node.style.transition;
        restore = () => { node.style.opacity = opacity; node.style.transition = transition; };
      }
      node.style.transition = 'none'; node.style.opacity = '0'; setMasked(true);
      if (timer !== undefined) clearTimeout(timer);
      // Hardware keyboards and cancelled opens never produce an open state.
      timer = setTimeout(release, 1200);
      if (state.current.isOpen && state.current.isSettled) afterLayout();
    };
    const focus = node.focus, descriptor = Object.getOwnPropertyDescriptor(node, 'focus');
    node.focus = options => { protect(); focus.call(node, { ...options, preventScroll: true }); };
    const pointer = () => { if (document.activeElement !== node || !state.current.isOpen) protect(); };
    const hardwareKey = () => { if (!state.current.isOpen) release(); };
    node.addEventListener('pointerdown', pointer, true);
    node.addEventListener('focus', protect, true);
    node.addEventListener('blur', release);
    node.addEventListener('keydown', hardwareKey);
    return () => {
      node.removeEventListener('pointerdown', pointer, true);
      node.removeEventListener('focus', protect, true);
      node.removeEventListener('blur', release);
      node.removeEventListener('keydown', hardwareKey);
      if (descriptor) Object.defineProperty(node, 'focus', descriptor); else Reflect.deleteProperty(node, 'focus');
      finish.current = undefined; release();
    };
  }, [input, enabled]);
  useLayoutEffect(() => { if (keyboard.isOpen && keyboard.isSettled) finish.current?.(); }, [keyboard.isOpen, keyboard.isSettled]);
  return enabled && masked;
}
