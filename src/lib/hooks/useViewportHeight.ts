import React from 'react';
import { createDebugLogger } from '../utils/debug';

interface UseViewportHeightOptions {
  cssVarName?: string;
}

export function useViewportHeight(options: UseViewportHeightOptions = {}): number {
  const { cssVarName = '--app-vh' } = options;
  const debugViewport = React.useMemo(() => createDebugLogger('viewport'), []);

  const getViewportHeight = React.useCallback(() => {
    if (typeof window === 'undefined') {
      return 0;
    }

    const visualViewport = window.visualViewport;
    if (!visualViewport) {
      return Math.round(window.innerHeight);
    }

    const viewportHeight = visualViewport.height;
    const viewportOffsetTop = visualViewport.offsetTop;
    const windowHeight = window.innerHeight;

    // iOS can report transient offsetTop while the keyboard animates.
    // Small offset values are usually browser-chrome shift and should be compensated.
    // Large offset values are often page pan; compensating those can cancel keyboard shrink.
    const canCompensateOffsetTop =
      viewportHeight < windowHeight - 1 &&
      viewportOffsetTop > 0 &&
      viewportOffsetTop <= 96;

    const effectiveHeight = canCompensateOffsetTop
      ? viewportHeight + viewportOffsetTop
      : viewportHeight;
    const clampedHeight = Math.max(0, Math.min(windowHeight, effectiveHeight));
    return Math.round(clampedHeight);
  }, []);

  const [viewportHeight, setViewportHeight] = React.useState(getViewportHeight);
  const heightBufRef = React.useRef<number[]>([]);
  const baseHeightRef = React.useRef(0);
  const lastWidthRef = React.useRef(0);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    let rafId: number | null = null;

    const medianOf3 = (a: number, b: number, c: number) =>
      [a, b, c].sort((x, y) => x - y)[1];

    const updateBaseHeight = (currentWidth: number, currentInnerHeight: number) => {
      if (baseHeightRef.current === 0) {
        baseHeightRef.current = currentInnerHeight;
        lastWidthRef.current = currentWidth;
        document.documentElement.style.setProperty('--app-base-vh', `${currentInnerHeight}px`);
        return;
      }

      const widthDelta = Math.abs(currentWidth - lastWidthRef.current);
      if (widthDelta > 60) {
        baseHeightRef.current = currentInnerHeight;
        lastWidthRef.current = currentWidth;
        document.documentElement.style.setProperty('--app-base-vh', `${currentInnerHeight}px`);
      }
    };

    const syncViewportHeight = () => {
      rafId = null;
      const nextHeight = getViewportHeight();
      const nextOffsetTop = Math.round(window.visualViewport?.offsetTop ?? 0);
      const rawViewportHeight = Math.round(window.visualViewport?.height ?? window.innerHeight);
      const innerHeight = Math.round(window.innerHeight);
      const currentWidth = Math.round(window.innerWidth);

      updateBaseHeight(currentWidth, innerHeight);

      // Median-of-3 filter only during decreases (keyboard opening).
      // Single-frame outlier lows are discarded.  Increases (keyboard
      // closing) are applied immediately so the layout recovers fully.
      const buf = heightBufRef.current;
      buf.push(nextHeight);
      if (buf.length > 3) buf.shift();
      let filteredHeight = nextHeight;
      if (buf.length === 3 && nextHeight <= buf[0]) {
        filteredHeight = medianOf3(buf[0], buf[1], buf[2]);
      }

      setViewportHeight((current) => (current === nextHeight ? current : nextHeight));

      const prevApplied = Number.parseInt(
        document.documentElement.style.getPropertyValue(cssVarName) || '0',
        10
      );

      document.documentElement.style.setProperty(cssVarName, `${filteredHeight}px`);
      document.documentElement.style.setProperty('--app-vv-offset-top', `${nextOffsetTop}px`);

      // Pre-compute keyboard translateY and marginTop so CSS can reference
      // plain px values (avoids Safari bugs with min()/calc()/env() nested
      // inside transform).
      const baseVh = baseHeightRef.current;
      let safeBottom = 0;
      try {
        const root = document.getElementById('root');
        if (root) safeBottom = parseFloat(getComputedStyle(root).paddingBottom) || 0;
      } catch { /* ignore */ }
      const ty = Math.min(0, filteredHeight - baseVh + safeBottom);
      const mt = Math.max(0, baseVh - filteredHeight - safeBottom);
      document.documentElement.style.setProperty('--kb-translate-y', `${ty}px`);
      document.documentElement.style.setProperty('--kb-margin-top', `${mt}px`);

      const previousHeight = prevApplied;
      if (previousHeight !== filteredHeight || nextOffsetTop > 0) {
        debugViewport('sync', {
          cssVarName,
          innerHeight,
          rawViewportHeight,
          offsetTop: nextOffsetTop,
          rawHeight: nextHeight,
          appliedHeight: filteredHeight,
          filtered: filteredHeight !== nextHeight,
        });
      }
    };

    const scheduleSync = () => {
      if (rafId !== null) {
        return;
      }
      rafId = window.requestAnimationFrame(syncViewportHeight);
    };

    scheduleSync();

    window.addEventListener('resize', scheduleSync);
    window.addEventListener('orientationchange', scheduleSync);
    window.visualViewport?.addEventListener('resize', scheduleSync);
    window.visualViewport?.addEventListener('scroll', scheduleSync);

    return () => {
      window.removeEventListener('resize', scheduleSync);
      window.removeEventListener('orientationchange', scheduleSync);
      window.visualViewport?.removeEventListener('resize', scheduleSync);
      window.visualViewport?.removeEventListener('scroll', scheduleSync);

      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [cssVarName, getViewportHeight]);

  return viewportHeight;
}
