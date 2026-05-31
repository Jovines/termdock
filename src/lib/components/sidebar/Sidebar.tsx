import React, { useCallback, useEffect, useRef } from 'react';
import { useDrag } from '@use-gesture/react';

interface SidebarProps {
  side: 'left' | 'right';
  isOpen: boolean;
  drawerWidthPx: number;
  onClose: () => void;
  onOpen?: () => void;
  children: React.ReactNode;
  /** Push mode: sidebar takes horizontal space instead of overlaying (desktop) */
  push?: boolean;
}

const EDGE_ZONE_WIDTH = 15;
const SNAP_PROGRESS_THRESHOLD = 0.5;
// @use-gesture reports velocity in px/ms.
const SNAP_VELOCITY_THRESHOLD = 0.5;
const SNAP_DURATION_MS = 250;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const Sidebar = React.forwardRef<HTMLElement, SidebarProps>(function Sidebar(
  { side, isOpen, drawerWidthPx, onClose, onOpen, children, push },
  forwardedRef,
) {
  const isLeft = side === 'left';
  const closedX = isLeft ? -drawerWidthPx : drawerWidthPx;

  const panelRef = useRef<HTMLElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const currentXRef = useRef(isOpen ? 0 : closedX);
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

  const setBackdropOpacity = useCallback((x: number) => {
    const backdrop = backdropRef.current;
    if (!backdrop) return;
    const progress = isLeft
      ? (x + drawerWidthPx) / drawerWidthPx
      : (drawerWidthPx - x) / drawerWidthPx;
    backdrop.getAnimations().forEach((animation) => animation.cancel());
    backdrop.style.transition = 'none';
    backdrop.style.opacity = String(clamp(progress, 0, 1));
  }, [drawerWidthPx, isLeft]);

  const setPosition = useCallback((nextX: number) => {
    const panel = panelRef.current;
    currentXRef.current = nextX;
    if (!panel) return;
    panel.getAnimations().forEach((animation) => animation.cancel());
    panel.style.transition = 'none';
    panel.style.transform = `translateX(${nextX}px)`;
    setBackdropOpacity(nextX);
  }, [setBackdropOpacity]);

  const animateToState = useCallback((open: boolean) => {
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
  }, [closedX, drawerWidthPx, isLeft]);

  useEffect(() => {
    animateToState(isOpen);
  }, [isOpen, animateToState]);

  // Keep the drawer aligned when viewport-derived width changes.
  useEffect(() => {
    setPosition(isOpenRef.current ? 0 : closedX);
  }, [closedX, setPosition]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

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
    ({ active, first, movement: [mx], velocity: [vx], direction: [dx] }) => {
      if (first) {
        dragStartXRef.current = currentXRef.current;
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
    },
  );

  const bindEdge = useDrag(
    ({ active, cancel, movement: [mx], velocity: [vx], direction: [dx] }) => {
      if (isOpenRef.current) {
        cancel();
        return;
      }
      if (!active) {
        decideSnap(vx, dx);
        return;
      }
      const min = isLeft ? closedX : 0;
      const max = isLeft ? 0 : drawerWidthPx;
      setPosition(clamp(closedX + mx, min, max));
    },
    {
      axis: 'x',
      filterTaps: true,
    },
  );

  // ── Push mode (desktop): flex child, no overlay ──
  if (push) {
    return (
      <aside
        ref={setPanelRef}
        data-sidebar={side}
        className={`shrink-0 flex flex-col bg-surface overflow-hidden transition-[width] duration-200 ease-out ${
          isLeft ? 'border-r border-border/15' : 'border-l border-border/15'
        }`}
        style={{
          width: isOpen ? drawerWidthPx : 0,
          paddingTop: 'max(0px, env(safe-area-inset-top, 0px) - 24px)',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          ...(isLeft
            ? { paddingLeft: 'env(safe-area-inset-left, 0px)' }
            : { paddingRight: 'env(safe-area-inset-right, 0px)' }),
        }}
      >
        <div style={{ width: drawerWidthPx, minWidth: drawerWidthPx }}>
          {children}
        </div>
      </aside>
    );
  }

  // ── Overlay mode (mobile): fixed, draggable ──
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
      />

      <div
        ref={backdropRef}
        data-sidebar-backdrop={side}
        className="fixed inset-0 z-40 bg-[rgba(0,0,0,0.5)] backdrop-blur-sm cursor-default"
        style={{
          opacity: isOpen ? 1 : 0,
          pointerEvents: isOpen ? 'auto' : 'none',
          transition: 'none',
        }}
        onClick={onClose}
        aria-label="Close sidebar"
      />

      <aside
        {...bindPanel()}
        ref={setPanelRef}
        data-sidebar={side}
        className={`fixed inset-y-0 z-50 flex flex-col bg-surface will-change-transform ${
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
          paddingTop: 'max(0px, env(safe-area-inset-top, 0px) - 24px)',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          ...(isLeft
            ? { paddingLeft: 'env(safe-area-inset-left, 0px)' }
            : { paddingRight: 'env(safe-area-inset-right, 0px)' }),
        }}
      >
        {children}
      </aside>
    </>
  );
});
