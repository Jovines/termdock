import { useLayoutEffect, useRef, useState, type HTMLAttributes, type MutableRefObject } from 'react';

const OVERSCAN = 600;

/** Keep diff anchors and heights, but mount code cells only near the viewport. */
export function VirtualDiffHunk({ enabled, estimatedHeight, activeRef, pinned = false, children, ...props }: HTMLAttributes<HTMLDivElement> & {
  enabled: boolean;
  estimatedHeight: number;
  activeRef: MutableRefObject<boolean>;
  pinned?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(!enabled);
  const [height, setHeight] = useState(estimatedHeight);
  const mounted = !enabled || visible || pinned;

  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element || !enabled) return;
    const scroller = element.closest('.termdock-diff-stream-scroller');
    if (!scroller || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    // Resolve the first window before paint. Offscreen cards can finish their
    // data preload without building all of their highlighted code cells.
    if (activeRef.current) {
      const box = element.getBoundingClientRect();
      const viewport = scroller.getBoundingClientRect();
      setVisible(box.bottom >= viewport.top - OVERSCAN && box.top <= viewport.bottom + OVERSCAN);
    }
    const observer = new IntersectionObserver(([entry]) => {
      // Clipping an inactive Tab must retain its current window. Otherwise
      // every round trip unmounts and rebuilds the visible code.
      if (entry && activeRef.current) setVisible(entry.isIntersecting);
    }, { root: scroller, rootMargin: `${OVERSCAN}px 0px` });
    observer.observe(element);
    return () => observer.disconnect();
  }, [activeRef, enabled]);

  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element || !mounted || !enabled) return;
    const measure = () => {
      const next = Math.ceil(element.getBoundingClientRect().height);
      if (next > 0) setHeight((previous) => previous === next ? previous : next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, mounted]);

  return <div {...props} ref={rootRef} data-diff-hunk-mounted={mounted ? 'true' : 'false'}
    style={mounted ? props.style : { ...props.style, height }}>
    {mounted ? children : null}
  </div>;
}
