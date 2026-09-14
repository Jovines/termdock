import { useLayoutEffect, useRef, useState, type ReactNode, type UIEvent } from 'react';

/** Keep both split columns visible while long lines scroll together. */
export function DiffSplitScrollArea({ enabled, className, label, children }: {
  enabled: boolean;
  className: string;
  label: string;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const cellsRef = useRef<HTMLElement[]>([]);
  const offsetRef = useRef(0);
  const maxRef = useRef(0);
  const [overflow, setOverflow] = useState(false);

  const scrollTo = (left: number) => {
    const root = rootRef.current;
    if (!root) return;
    const offset = Math.max(0, Math.min(maxRef.current, left));
    offsetRef.current = offset;
    for (const element of [...cellsRef.current, ...root.querySelectorAll<HTMLElement>('[data-diff-horizontal-scroll]')]) {
      if (Math.abs(element.scrollLeft - offset) > 0.5) element.scrollLeft = offset;
    }
  };

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (!enabled) {
      for (const cell of cellsRef.current) cell.scrollLeft = 0;
      cellsRef.current = [];
      offsetRef.current = maxRef.current = 0;
      root.style.removeProperty('--diff-scroll-overflow');
      setOverflow(false);
      return;
    }
    const measure = () => {
      cellsRef.current = Array.from(root.querySelectorAll<HTMLElement>('.diff-code'));
      let max = 0;
      for (const cell of cellsRef.current) {
        // Measure text/tokens only: scrollWidth also contains our alignment
        // spacer and would retain a stale maximum after resizing/collapsing.
        const range = document.createRange();
        range.selectNodeContents(cell);
        if (typeof range.getBoundingClientRect !== 'function') continue;
        const style = getComputedStyle(cell);
        const width = range.getBoundingClientRect().width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        max = Math.max(max, Math.ceil(width - cell.clientWidth));
      }
      maxRef.current = max;
      root.style.setProperty('--diff-scroll-overflow', `${max}px`);
      setOverflow(max > 0);
      scrollTo(offsetRef.current);
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(root);
    let disposed = false;
    void document.fonts?.ready.then(() => { if (!disposed) measure(); });
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (!delta || maxRef.current === 0) return;
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientWidth / 2 : 1;
      scrollTo(offsetRef.current + delta * scale);
      event.preventDefault();
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      disposed = true;
      observer?.disconnect();
      root.removeEventListener('wheel', onWheel);
    };
  }, [enabled, children]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    if (!enabled) return;
    const target = event.target as HTMLElement;
    if (target.matches('.diff-code, [data-diff-horizontal-scroll]') && Math.abs(target.scrollLeft - offsetRef.current) > 0.5) {
      scrollTo(target.scrollLeft);
    }
  };

  return (
    <div ref={rootRef} className={`${className} ${enabled ? 'termdock-diff-split-nowrap' : ''}`} onScrollCapture={onScroll}>
      {children}
      {enabled && overflow && (
        <div className="termdock-diff-horizontal-bars">
          {[0, 1].map((side) => (
            <div key={side} data-diff-horizontal-scroll tabIndex={0} role="region" aria-label={label}>
              <div />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
