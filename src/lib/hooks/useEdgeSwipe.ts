import { useRef, useCallback } from 'react';
import { animate } from 'motion/react';
import { useGesture } from './useGesture';
import { PRIORITY_EDGE_SWIPE } from '../gesture/types';
import type { GestureAction } from '../gesture/types';

const CONFIRM_THRESHOLD = 15;
const SNAP_VELOCITY_THRESHOLD = 500;
const SNAP_PROGRESS_THRESHOLD = 0.3;

interface TrackingState {
  side: 'left' | 'right';
  startX: number;
  startY: number;
  confirmed: boolean;
  prevX: number;
  prevTime: number;
}

interface EdgeSwipeConfig {
  onOpen?: (side: 'left' | 'right') => void;
  onClose?: (side: 'left' | 'right') => void;
  container?: React.RefObject<HTMLElement>;
  leftSidebarRef: React.RefObject<HTMLElement | null>;
  rightSidebarRef: React.RefObject<HTMLElement | null>;
  drawerWidthPx: number;
}

export function useEdgeSwipe(config: EdgeSwipeConfig): void {
  const {
    onOpen,
    onClose,
    container: containerRef,
    leftSidebarRef,
    rightSidebarRef,
    drawerWidthPx,
  } = config;

  const trackingRef = useRef<TrackingState | null>(null);
  const onOpenRef = useRef(onOpen);
  const onCloseRef = useRef(onClose);
  onOpenRef.current = onOpen;
  onCloseRef.current = onClose;

  const setDrawerX = (ref: React.RefObject<HTMLElement | null>, x: number) => {
    const el = ref.current;
    if (el) el.style.transform = `translateX(${x}px)`;
  };

  const springDrawer = (
    ref: React.RefObject<HTMLElement | null>,
    from: number,
    to: number,
  ) => {
    const el = ref.current;
    if (!el) return;
    el.style.transform = `translateX(${from}px)`;
    animate(el, { x: to }, {
      type: 'spring',
      stiffness: 400,
      damping: 35,
      mass: 0.8,
    });
  };

  const onPointerDown = useCallback((e: PointerEvent) => {
    const x = e.clientX;
    const side: 'left' | 'right' = x < window.innerWidth / 2 ? 'left' : 'right';

    trackingRef.current = {
      side,
      startX: x,
      startY: e.clientY,
      confirmed: false,
      prevX: x,
      prevTime: performance.now(),
    };

    return true;
  }, []);

  const onPointerMove = useCallback((e: PointerEvent, _isClaimed: boolean): GestureAction => {
    const t = trackingRef.current;
    if (!t) return 'release';

    const dx = e.clientX - t.startX;
    const dy = e.clientY - t.startY;

    if (!t.confirmed) {
      if (Math.abs(dy) > Math.abs(dx) * 1.5) {
        trackingRef.current = null;
        return 'release';
      }
      const towardCenter = (t.side === 'left' && dx > 0) || (t.side === 'right' && dx < 0);
      if (towardCenter && Math.abs(dx) > CONFIRM_THRESHOLD) {
        t.confirmed = true;
      }
      return 'claim';
    }

    const progress = Math.min(1, Math.abs(dx) / drawerWidthPx);
    const ref = t.side === 'left' ? leftSidebarRef : rightSidebarRef;
    const targetX = t.side === 'left'
      ? -drawerWidthPx + drawerWidthPx * progress
      : drawerWidthPx - drawerWidthPx * progress;
    setDrawerX(ref, targetX);

    t.prevX = e.clientX;
    t.prevTime = performance.now();
    return 'claim';
  }, [leftSidebarRef, rightSidebarRef, drawerWidthPx]);

  const onPointerUp = useCallback((_e: PointerEvent) => {
    const t = trackingRef.current;
    if (!t) return;

    if (t.confirmed) {
      const totalDx = Math.abs(t.prevX - t.startX);
      const progress = totalDx / drawerWidthPx;
      const deltaT = performance.now() - t.prevTime;
      const velocity = deltaT > 0 ? totalDx / (deltaT / 1000) : 0;
      const shouldOpen = progress > SNAP_PROGRESS_THRESHOLD || velocity > SNAP_VELOCITY_THRESHOLD;

      const ref = t.side === 'left' ? leftSidebarRef : rightSidebarRef;
      const el = ref.current;
      const currentX = el
        ? parseFloat(el.style.transform.replace(/[^-\d.]/g, '')) || (t.side === 'left' ? -drawerWidthPx : drawerWidthPx)
        : (t.side === 'left' ? -drawerWidthPx : drawerWidthPx);

      if (shouldOpen) {
        springDrawer(ref, currentX, 0);
        onOpenRef.current?.(t.side);
      } else {
        const closedX = t.side === 'left' ? -drawerWidthPx : drawerWidthPx;
        springDrawer(ref, currentX, closedX);
        onCloseRef.current?.(t.side);
      }
    }

    trackingRef.current = null;
  }, [leftSidebarRef, rightSidebarRef, drawerWidthPx]);

  const onPointerCancel = useCallback(() => {
    const t = trackingRef.current;
    if (!t) return;

    if (t.confirmed) {
      const ref = t.side === 'left' ? leftSidebarRef : rightSidebarRef;
      const el = ref.current;
      const closedX = t.side === 'left' ? -drawerWidthPx : drawerWidthPx;
      const currentX = el
        ? parseFloat(el.style.transform.replace(/[^-\d.]/g, '')) || closedX
        : closedX;
      springDrawer(ref, currentX, closedX);
    }

    trackingRef.current = null;
  }, [leftSidebarRef, rightSidebarRef, drawerWidthPx]);

  useGesture({
    name: 'edge-swipe',
    priority: PRIORITY_EDGE_SWIPE,
    container: containerRef ? () => containerRef.current : undefined,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  });
}
