import { useEffect, type RefObject } from 'react';

/** Keep native scrolling inside an input panel. Only cancel outward vertical
 * movement: taps, selection, horizontal gestures and inner scrolls stay native. */
export function useTouchScrollBoundary(ref: RefObject<HTMLElement>, enabled: boolean) {
  useEffect(() => {
    const root = ref.current;
    if (!enabled || !root) return;
    let gesture: { id: number; x: number; y: number; lastY: number; target: Element; vertical: boolean } | undefined;
    const end = () => { gesture = undefined; };
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 1 || !(event.target instanceof Element)) { end(); return; }
      const touch = event.touches[0];
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, lastY: touch.clientY, target: event.target, vertical: false };
    };
    const move = (event: TouchEvent) => {
      if (!gesture || event.touches.length !== 1) { end(); return; }
      const touch = event.touches[0];
      if (touch.identifier !== gesture.id) return;
      const dx = touch.clientX - gesture.x, dy = touch.clientY - gesture.y;
      const step = touch.clientY - gesture.lastY;
      gesture.lastY = touch.clientY;
      if (!gesture.vertical) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 6 || Math.abs(dx) >= Math.abs(dy)) return;
        gesture.vertical = true;
      }
      if (!step) return;
      let node: Element | null = gesture.target;
      while (node && root.contains(node)) {
        if (node instanceof HTMLElement && /^(auto|scroll)$/.test(getComputedStyle(node).overflowY)) {
          const remaining = node.scrollHeight - node.clientHeight;
          if (remaining > 1 && (step < 0 ? node.scrollTop < remaining - 1 : node.scrollTop > 1)) return;
        }
        if (node === root) break;
        node = node.parentElement;
      }
      // iOS can pan the visual viewport despite a fixed overflow-hidden root.
      // Stop the default gesture here, rather than correcting page scroll later.
      if (event.cancelable) event.preventDefault();
    };
    root.addEventListener('touchstart', start, { passive: true });
    root.addEventListener('touchmove', move, { passive: false });
    root.addEventListener('touchend', end, { passive: true });
    root.addEventListener('touchcancel', end, { passive: true });
    return () => {
      root.removeEventListener('touchstart', start);
      root.removeEventListener('touchmove', move);
      root.removeEventListener('touchend', end);
      root.removeEventListener('touchcancel', end);
    };
  }, [ref, enabled]);
}
