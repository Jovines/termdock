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

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    let rafId: number | null = null;

    const syncViewportHeight = () => {
      rafId = null;
      const nextHeight = getViewportHeight();
      const nextOffsetTop = Math.round(window.visualViewport?.offsetTop ?? 0);
      const rawViewportHeight = Math.round(window.visualViewport?.height ?? window.innerHeight);
      const innerHeight = Math.round(window.innerHeight);
      const previousHeight = Number.parseInt(
        document.documentElement.style.getPropertyValue(cssVarName) || '0',
        10
      );
      const heightChanged = previousHeight !== nextHeight;

      setViewportHeight((current) => (current === nextHeight ? current : nextHeight));
      document.documentElement.style.setProperty(cssVarName, `${nextHeight}px`);
      document.documentElement.style.setProperty('--app-vv-offset-top', `${nextOffsetTop}px`);

      if (heightChanged || nextOffsetTop > 0) {
        debugViewport('sync', {
          cssVarName,
          innerHeight,
          rawViewportHeight,
          offsetTop: nextOffsetTop,
          appliedHeight: nextHeight,
          compensated: nextHeight !== rawViewportHeight,
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
