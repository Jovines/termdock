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
  const barsRef = useRef<Array<HTMLDivElement | null>>([]);
  const frameRef = useRef<number | null>(null);
  const appliedOffsetRef = useRef(0);
  const offsetRef = useRef(0);
  const maxRef = useRef(0);
  const [overflow, setOverflow] = useState(false);

  const scrollTo = (left: number) => {
    const root = rootRef.current;
    if (!root) return;
    const offset = Math.max(0, Math.min(maxRef.current, left));
    offsetRef.current = offset;
    // Finish all layout reads before changing any scroll position. Alternating
    // reads and writes here can force layout once per row on a large diff.
    const changed = [...cellsRef.current, ...barsRef.current].filter(
      (element): element is HTMLElement => element !== null && Math.abs(element.scrollLeft - offset) > 0.5,
    );
    appliedOffsetRef.current = offset;
    for (const element of changed) element.scrollLeft = offset;
  };

  const scheduleScroll = (left: number) => {
    offsetRef.current = Math.max(0, Math.min(maxRef.current, left));
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      scrollTo(offsetRef.current);
    });
  };

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (!enabled) {
      for (const cell of cellsRef.current) cell.scrollLeft = 0;
      cellsRef.current = [];
      offsetRef.current = appliedOffsetRef.current = maxRef.current = 0;
      root.style.removeProperty('--diff-scroll-overflow');
      setOverflow(false);
      return;
    }
    const measure = () => {
      cellsRef.current = Array.from(root.querySelectorAll<HTMLElement>('.diff-code'));
      let max = 0;
      const range = document.createRange();
      const firstCell = cellsRef.current[0];
      const style = firstCell ? getComputedStyle(firstCell) : null;
      const padding = style ? parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) : 0;
      for (const cell of cellsRef.current) {
        // Measure text/tokens only: scrollWidth also contains our alignment
        // spacer and would retain a stale maximum after resizing/collapsing.
        range.selectNodeContents(cell);
        if (typeof range.getBoundingClientRect !== 'function') continue;
        const width = range.getBoundingClientRect().width + padding;
        max = Math.max(max, Math.ceil(width - cell.clientWidth));
      }
      maxRef.current = max;
      root.style.setProperty('--diff-scroll-overflow', `${max}px`);
      setOverflow(max > 0);
      scrollTo(offsetRef.current);
    };
    measure();
    // Height changes (loading covers, context layout) do not change line widths.
    let measuredWidth = root.clientWidth;
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
      const width = root.clientWidth;
      if (width === measuredWidth) return;
      measuredWidth = width;
      measure();
    }) : null;
    observer?.observe(root);
    let disposed = false;
    void document.fonts?.ready.then(() => { if (!disposed) measure(); });
    return () => {
      disposed = true;
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      observer?.disconnect();
    };
  }, [enabled, children]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    // Short lines need no wheel interception: let native vertical scrolling
    // start without waiting for a cancelable main-thread wheel handler.
    if (!enabled || !overflow || !root) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      // Trackpads often report a small sideways delta during a vertical
      // gesture. Canceling those events makes the outer list stutter.
      if (!event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) return;
      const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (!delta || maxRef.current === 0) return;
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientWidth / 2 : 1;
      scheduleScroll(offsetRef.current + delta * scale);
      event.preventDefault();
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, [enabled, overflow]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    if (!enabled) return;
    const target = event.target as HTMLElement;
    if (target.matches('.diff-code, [data-diff-horizontal-scroll]')
      && Math.abs(target.scrollLeft - appliedOffsetRef.current) > 0.5
      && Math.abs(target.scrollLeft - offsetRef.current) > 0.5) {
      scheduleScroll(target.scrollLeft);
    }
  };

  return (
    <div ref={rootRef} className={`${className} ${enabled ? 'termdock-diff-split-nowrap' : ''}`} onScrollCapture={onScroll}>
      {children}
      {enabled && overflow && (
        <div className="termdock-diff-horizontal-bars">
          {[0, 1].map((side) => (
            <div key={side} ref={(element) => { barsRef.current[side] = element; }} data-diff-horizontal-scroll tabIndex={0} role="region" aria-label={label}>
              <div />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
