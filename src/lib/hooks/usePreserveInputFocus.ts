import { useEffect, type RefObject } from 'react';

/** Preserve the existing editor focus during touch browsing. Cancel only the
 * compatibility mouse focus action; never cancel native touch scrolling, call
 * focus/blur, restore a selection, or intercept an intentional input/control. */
export function usePreserveInputFocus(surface: RefObject<HTMLElement>, input: RefObject<HTMLElement>, enabled: boolean) {
  useEffect(() => {
    const root = surface.current;
    if (!enabled || !root) return;
    let touched: { input: HTMLElement; at: number } | undefined;
    const remember = () => {
      const field = input.current;
      touched = field && document.activeElement === field ? { input: field, at: performance.now() } : undefined;
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch' && event.isPrimary) remember();
    };
    const touchStart = (event: TouchEvent) => { if (event.touches.length === 1) remember(); else touched = undefined; };
    const mouseDown = (event: MouseEvent) => {
      const field = input.current;
      if (!field || document.activeElement !== field || event.button !== 0 || !event.cancelable) return;
      const capabilities = (event as MouseEvent & { sourceCapabilities?: { firesTouchEvents: boolean } | null }).sourceCapabilities;
      const fromTouch = capabilities ? capabilities.firesTouchEvents : touched?.input === field && performance.now() - touched.at < 1200;
      if (!fromTouch || !(event.target instanceof Element)) return;
      const control = event.target.closest('input, textarea, select, button, a, label, summary, [contenteditable]:not([contenteditable="false"]), [role="button"]');
      if (control && control !== root) return;
      event.preventDefault();
    };
    root.addEventListener('pointerdown', pointerDown, { capture: true, passive: true });
    root.addEventListener('touchstart', touchStart, { capture: true, passive: true });
    root.addEventListener('mousedown', mouseDown, { capture: true, passive: false });
    return () => {
      root.removeEventListener('pointerdown', pointerDown, true);
      root.removeEventListener('touchstart', touchStart, true);
      root.removeEventListener('mousedown', mouseDown, true);
    };
  }, [surface, input, enabled]);
}
