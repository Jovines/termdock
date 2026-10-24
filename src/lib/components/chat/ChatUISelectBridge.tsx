import { forwardRef, useLayoutEffect, useState, type ElementRef } from 'react';
import { SelectContent as NativeSelectContent, type SelectContentProps } from '@openuidev/react-ui/Select';
export * from '@openuidev/react-ui/Select';
export const SelectContent = forwardRef<ElementRef<typeof NativeSelectContent>, SelectContentProps>((props, ref) => {
  const [padding, setPadding] = useState({ top: 8, right: 8, bottom: 8, left: 8 });
  useLayoutEffect(() => {
    const measure = () => {
      // Resolve env(), max() and desktop title-bar overrides through actual CSS.
      const probe = document.createElement('div'); probe.className = 'preview-safe-area';
      probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none'; document.body.append(probe);
      const css = getComputedStyle(probe);
      const inset = (value: string) => (Number.parseFloat(value) || 0) + 8;
      const next = { top: inset(css.paddingTop), right: inset(css.paddingRight), bottom: inset(css.paddingBottom), left: inset(css.paddingLeft) };
      probe.remove();
      setPadding(old => Object.keys(next).every(edge => old[edge as keyof typeof old] === next[edge as keyof typeof next]) ? old : next);
    };
    measure(); window.addEventListener('resize', measure);
    const observer = new MutationObserver(measure); observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    return () => { window.removeEventListener('resize', measure); observer.disconnect(); };
  }, []);
  return <NativeSelectContent {...props} ref={ref} collisionPadding={padding} avoidCollisions />;
});
