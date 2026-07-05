import React, { useCallback, useEffect, useRef } from 'react';
import { useDrag } from '@use-gesture/react';

interface SidebarProps {
  side: 'left' | 'right';
  isOpen: boolean;
  drawerWidthPx: number;
  onClose: () => void;
  onOpen?: () => void;
  children: React.ReactNode;
  /**
   * @deprecated Both desktop and mobile now render in overlay mode to keep the
   * terminal column from resizing when toggling. The prop is accepted but ignored.
   */
  push?: boolean;
}

const EDGE_ZONE_WIDTH = 15;
const SNAP_PROGRESS_THRESHOLD = 0.5;
// @use-gesture reports velocity in px/ms.
const SNAP_VELOCITY_THRESHOLD = 0.5;
const SNAP_DURATION_MS = 250;
const PANEL_GESTURE_IGNORE_SELECTOR = '[data-sidebar-gesture-ignore]';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isTouchLikePointer(event: unknown): boolean {
  if (!event || typeof event !== 'object') {
    return false;
  }

  const maybePointer = event as { pointerType?: string; type?: string };
  if (typeof maybePointer.pointerType === 'string') {
    return maybePointer.pointerType === 'touch' || maybePointer.pointerType === 'pen';
  }

  return typeof maybePointer.type === 'string' && maybePointer.type.startsWith('touch');
}

function shouldIgnorePanelDrag(event: unknown): boolean {
  if (!event || typeof event !== 'object') {
    return false;
  }

  const target = (event as { target?: EventTarget | null }).target;
  return target instanceof Element && Boolean(target.closest(PANEL_GESTURE_IGNORE_SELECTOR));
}

export const Sidebar = React.forwardRef<HTMLElement, SidebarProps>(function Sidebar(
  { side, isOpen, drawerWidthPx, onClose, onOpen, children },
  forwardedRef,
) {
  const isLeft = side === 'left';
  const closedX = isLeft ? -drawerWidthPx : drawerWidthPx;

  const panelRef = useRef<HTMLElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const currentXRef = useRef(isOpen ? 0 : closedX);
  const pendingXRef = useRef<number | null>(null);
  const positionFrameRef = useRef<number | null>(null);
  const dragStartXRef = useRef(0);
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  const setPanelRef = useCallback((node: HTMLElement | null) => {
    panelRef.current = node;
    if (typeof forwardedRef === 'function') {
      forwardedRef(node);
    } else if (forwardedRef) {
      forwardedRef.current = node;
    }
  }, [forwardedRef]);

  const cancelPendingPositionFrame = useCallback(() => {
    if (positionFrameRef.current !== null) {
      window.cancelAnimationFrame(positionFrameRef.current);
      positionFrameRef.current = null;
    }
    pendingXRef.current = null;
  }, []);

  const setBackdropOpacity = useCallback((x: number) => {
    const backdrop = backdropRef.current;
    if (!backdrop) return;
    const progress = isLeft
      ? (x + drawerWidthPx) / drawerWidthPx
      : (drawerWidthPx - x) / drawerWidthPx;
    backdrop.style.opacity = String(clamp(progress, 0, 1));
  }, [drawerWidthPx, isLeft]);

  const applyPosition = useCallback((nextX: number) => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.style.transform = `translateX(${nextX}px)`;
    setBackdropOpacity(nextX);
  }, [setBackdropOpacity]);

  const setPosition = useCallback((nextX: number) => {
    currentXRef.current = nextX;
    pendingXRef.current = nextX;
    if (positionFrameRef.current !== null) return;
    positionFrameRef.current = window.requestAnimationFrame(() => {
      positionFrameRef.current = null;
      const pendingX = pendingXRef.current;
      pendingXRef.current = null;
      if (pendingX !== null) {
        applyPosition(pendingX);
      }
    });
  }, [applyPosition]);

  const prepareInstantPositioning = useCallback(() => {
    cancelPendingPositionFrame();
    const panel = panelRef.current;
    const backdrop = backdropRef.current;
    panel?.getAnimations().forEach((animation) => animation.cancel());
    if (panel) panel.style.transition = 'none';
    backdrop?.getAnimations().forEach((animation) => animation.cancel());
    if (backdrop) backdrop.style.transition = 'none';
  }, [cancelPendingPositionFrame]);

  const animateToState = useCallback((open: boolean) => {
    cancelPendingPositionFrame();
    const panel = panelRef.current;
    const backdrop = backdropRef.current;
    const targetX = open ? 0 : closedX;
    currentXRef.current = targetX;

    if (panel) {
      panel.style.transition = `transform ${SNAP_DURATION_MS}ms ease-out`;
      panel.style.transform = `translateX(${targetX}px)`;
    }
    if (backdrop) {
      const progress = isLeft
        ? (targetX + drawerWidthPx) / drawerWidthPx
        : (drawerWidthPx - targetX) / drawerWidthPx;
      backdrop.style.transition = `opacity ${SNAP_DURATION_MS}ms ease-out`;
      backdrop.style.opacity = String(clamp(progress, 0, 1));
    }

    const cleanup = () => {
      if (panel) panel.style.transition = 'none';
      if (backdrop) backdrop.style.transition = 'none';
    };
    panel?.addEventListener('transitionend', cleanup, { once: true });
    setTimeout(cleanup, SNAP_DURATION_MS + 50);
  }, [cancelPendingPositionFrame, closedX, drawerWidthPx, isLeft]);

  useEffect(() => cancelPendingPositionFrame, [cancelPendingPositionFrame]);

  useEffect(() => {
    animateToState(isOpen);
  }, [isOpen, animateToState]);

  // Keep the drawer aligned when viewport-derived width changes.
  useEffect(() => {
    prepareInstantPositioning();
    setPosition(isOpenRef.current ? 0 : closedX);
  }, [closedX, prepareInstantPositioning, setPosition]);

  // ESC 由 App 顶层统一处理（按层级关闭 modal/drawer/sidebar，并走 history overlay）。
  // 这里不再单独监听，避免和全局 handler 同时触发 history.back() 两次。

  const decideSnap = useCallback((velocity: number, direction: number) => {
    const hasFling = Math.abs(velocity) > SNAP_VELOCITY_THRESHOLD;
    const flingClose = hasFling && (isLeft ? direction < 0 : direction > 0);
    const flingOpen = hasFling && (isLeft ? direction > 0 : direction < 0);

    if (flingClose) {
      if (isOpenRef.current) onClose();
      else animateToState(false);
    } else if (flingOpen) {
      if (!isOpenRef.current) onOpen?.();
      else animateToState(true);
    } else {
      const currentX = currentXRef.current;
      const progress = isLeft
        ? (currentX + drawerWidthPx) / drawerWidthPx
        : (drawerWidthPx - currentX) / drawerWidthPx;
      if (progress > SNAP_PROGRESS_THRESHOLD) {
        if (!isOpenRef.current) onOpen?.();
        else animateToState(true);
      } else if (isOpenRef.current) {
        onClose();
      } else {
        animateToState(false);
      }
    }
  }, [drawerWidthPx, isLeft, onClose, onOpen, animateToState]);

  const bindPanel = useDrag(
    ({ active, cancel, first, movement: [mx], velocity: [vx], direction: [dx], event }) => {
      if (!isTouchLikePointer(event)) {
        return;
      }
      if (shouldIgnorePanelDrag(event)) {
        cancel();
        return;
      }
      if (first) {
        dragStartXRef.current = currentXRef.current;
        prepareInstantPositioning();
      }
      if (!active) {
        decideSnap(vx, dx);
        return;
      }
      const min = isLeft ? closedX : 0;
      const max = isLeft ? 0 : drawerWidthPx;
      setPosition(clamp(dragStartXRef.current + mx, min, max));
    },
    {
      axis: 'x',
      filterTaps: true,
      // Only enable drag-to-close from touch / pen — desktop mouse users
      // close via backdrop click, the X button, or Esc. This prevents
      // accidental drags when selecting text inside the sidebar.
      pointer: { touch: true },
    },
  );

  const bindEdge = useDrag(
    ({ active, cancel, first, movement: [mx], velocity: [vx], direction: [dx], event }) => {
      if (!isTouchLikePointer(event)) {
        cancel();
        return;
      }
      if (isOpenRef.current) {
        cancel();
        return;
      }
      if (!active) {
        decideSnap(vx, dx);
        return;
      }
      if (first) {
        prepareInstantPositioning();
      }
      const min = isLeft ? closedX : 0;
      const max = isLeft ? 0 : drawerWidthPx;
      setPosition(clamp(closedX + mx, min, max));
    },
    {
      axis: 'x',
      filterTaps: true,
      pointer: { touch: true },
    },
  );

  const handleEdgeClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    // Android's system back gesture can steal horizontal edge swipes before the
    // page receives enough movement to open the drawer. A plain tap/click on
    // the same invisible edge affordance gives users a non-conflicting way to
    // reveal the sidebar while preserving swipe-to-open where it works.
    event.preventDefault();
    event.stopPropagation();
    if (!isOpenRef.current) {
      onOpen?.();
    }
  }, [onOpen]);

  // ── Overlay mode (used on both desktop & mobile) — fixed, draggable ──
  return (
    <>
      <div
        {...bindEdge()}
        style={{
          position: 'fixed',
          top: '1.5rem',
          bottom: '10rem',
          ...(isLeft ? { left: 0 } : { right: 0 }),
          width: EDGE_ZONE_WIDTH,
          zIndex: 30,
          touchAction: 'none',
          pointerEvents: isOpen ? 'none' : 'auto',
        }}
        onClick={handleEdgeClick}
        aria-label={`Open ${side} sidebar`}
      />

      <div
        ref={backdropRef}
        data-sidebar-backdrop={side}
        className="fixed inset-0 z-sidebar-backdrop bg-[var(--app-backdrop)] cursor-default"
        style={{
          opacity: isOpen ? 1 : 0,
          pointerEvents: isOpen ? 'auto' : 'none',
          transition: 'none',
          willChange: 'opacity',
        }}
        onClick={onClose}
        aria-label="Close sidebar"
      />

      <aside
        {...bindPanel()}
        ref={setPanelRef}
        data-sidebar={side}
        className={`fixed inset-y-0 z-sidebar-panel flex flex-col bg-surface will-change-transform ${
          isLeft ? 'border-r border-border/15' : 'border-l border-border/15'
        }`}
        style={{
          ...(isLeft ? { left: 0 } : { right: 0 }),
          width: drawerWidthPx,
          maxWidth: '94vw',
          transform: `translateX(${isOpen ? 0 : closedX}px)`,
          transition: 'none',
          touchAction: 'pan-y',
          pointerEvents: isOpen ? 'auto' : 'none',
          paddingTop: 'var(--safe-top-inset, env(safe-area-inset-top, 0px))',
          paddingBottom: 'var(--safe-bottom-inset, env(safe-area-inset-bottom, 0px))',
          ...(isLeft
            ? { paddingLeft: 'var(--safe-left-inset, env(safe-area-inset-left, 0px))' }
            : { paddingRight: 'var(--safe-right-inset, env(safe-area-inset-right, 0px))' }),
        }}
      >
        {children}
      </aside>
    </>
  );
});
