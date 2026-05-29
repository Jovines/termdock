import { useRef, useCallback, useState } from 'react';

export interface EdgeSwipeState {
  isEdgeSwiping: boolean;
  edgeSide: 'left' | 'right' | null;
  dragProgress: number; // 0-1
}

interface EdgeSwipeConfig {
  edgeZoneWidth?: number;     // px from screen edge to detect (default 25)
  confirmThreshold?: number;  // px horizontal toward center to confirm (default 15)
  openThreshold?: number;     // px total distance to open sidebar (default 60)
  onOpen?: (side: 'left' | 'right') => void;
  onClose?: (side: 'left' | 'right') => void;
}

interface TrackingState {
  active: boolean;
  side: 'left' | 'right';
  startX: number;
  startY: number;
  confirmed: boolean;
  currentX: number;
}

// ─── Module-level singleton state ───
//
// The edge swipe listeners MUST be registered at module load time (before any
// React component mounts) to guarantee they fire BEFORE TerminalViewport's
// capture-phase handlers. React useEffect runs child-first, so if we register
// inside App's useEffect, TerminalViewport's handler is already registered and
// its `onMove` calls `stopImmediatePropagation()` during the `holding` phase,
// which blocks our handler from ever seeing pointermove events.
//
// By registering at module load time, our capture-phase listeners are always
// first in the queue, so we can claim edge gestures before TerminalViewport
// or Swiper ever see them.

let tracking: TrackingState | null = null;
let listenersRegistered = false;

// Callbacks — set by the hook, called by the module-level handlers.
let onOpenCallback: ((side: 'left' | 'right') => void) | null = null;
let onCloseCallback: ((side: 'left' | 'right') => void) | null = null;
let onProgressCallback: ((side: 'left' | 'right', progress: number) => void) | null = null;

const EDGE_ZONE_WIDTH = 25;
const CONFIRM_THRESHOLD = 15;
const OPEN_THRESHOLD = 60;

function notifyGestureLock(locked: boolean) {
  document.dispatchEvent(
    new CustomEvent('termdock:gesture-lock', { detail: { locked } })
  );
}

function handlePointerDown(e: PointerEvent) {
  if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;

  const vw = window.innerWidth;
  const x = e.clientX;

  let side: 'left' | 'right' | null = null;
  if (x < EDGE_ZONE_WIDTH) side = 'left';
  else if (x > vw - EDGE_ZONE_WIDTH) side = 'right';

  if (!side) return;

  // Don't start edge tracking if a sidebar is already open
  const sidebarEl = document.querySelector(
    side === 'left' ? '[data-sidebar="left"]' : '[data-sidebar="right"]'
  );
  if (sidebarEl) return;

  // CRITICAL: preventDefault() on pointerdown prevents Swiper from
  // starting its internal touch tracking. This also prevents
  // TerminalViewport from entering its `holding` mode for this touch,
  // because TerminalViewport's onDown checks isTargetInside and then
  // calls e.preventDefault() — but since we fire FIRST (registered
  // first in capture phase), our preventDefault runs before
  // TerminalViewport even sees the event.
  e.preventDefault();

  tracking = {
    active: true,
    side,
    startX: x,
    startY: e.clientY,
    confirmed: false,
    currentX: x,
  };
}

function handlePointerMove(e: PointerEvent) {
  const t = tracking;
  if (!t || !t.active) return;

  t.currentX = e.clientX;

  const dx = t.currentX - t.startX;
  const dy = e.clientY - t.startY;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  // Direction check: must be moving toward center
  const movingTowardCenter =
    (t.side === 'left' && dx > 0) || (t.side === 'right' && dx < 0);

  if (!t.confirmed) {
    // Block Swiper and TerminalViewport from seeing these moves.
    // Since we're registered first in capture phase, our
    // stopImmediatePropagation prevents TerminalViewport's holding-mode
    // handler from running (which would otherwise block us!).
    e.preventDefault();
    e.stopImmediatePropagation();

    // Need to confirm this is a horizontal edge swipe
    if (absDy > absDx * 1.5) {
      // Vertical gesture — cancel edge tracking, release to scroll handlers
      tracking = null;
      return;
    }
    if (movingTowardCenter && absDx > CONFIRM_THRESHOLD) {
      t.confirmed = true;
      notifyGestureLock(true);
    }
    return;
  }

  // Confirmed edge swipe — update progress
  e.preventDefault();
  e.stopImmediatePropagation();

  const progress = Math.min(1, absDx / (window.innerWidth * 0.4));
  onProgressCallback?.(t.side, progress);
}

function handlePointerUp(_e: PointerEvent) {
  const t = tracking;
  if (!t || !t.active) return;

  if (t.confirmed) {
    const dx = Math.abs(t.currentX - t.startX);
    if (dx > OPEN_THRESHOLD) {
      onOpenCallback?.(t.side);
    } else {
      onCloseCallback?.(t.side);
    }
    notifyGestureLock(false);
  }

  tracking = null;
  onProgressCallback?.(null as any, 0);
}

function handlePointerCancel() {
  if (tracking?.confirmed) {
    notifyGestureLock(false);
  }
  tracking = null;
  onProgressCallback?.(null as any, 0);
}

function ensureListeners() {
  if (listenersRegistered) return;
  listenersRegistered = true;

  // Register at module load time with passive:false so preventDefault works.
  // Being first in the capture-phase queue means we fire before
  // TerminalViewport and Swiper.
  document.addEventListener('pointerdown', handlePointerDown, { capture: true, passive: false });
  document.addEventListener('pointermove', handlePointerMove, { capture: true, passive: false });
  document.addEventListener('pointerup', handlePointerUp, { capture: true, passive: false });
  document.addEventListener('pointercancel', handlePointerCancel, { capture: true, passive: false });
}

// Register immediately on module import — before any React component mounts.
ensureListeners();

// ─── React hook ───

export function useEdgeSwipe(config: EdgeSwipeConfig = {}): EdgeSwipeState {
  const { onOpen, onClose } = config;

  const [state, setState] = useState<EdgeSwipeState>({
    isEdgeSwiping: false,
    edgeSide: null,
    dragProgress: 0,
  });

  // Keep callbacks in sync
  const onOpenRef = useRef(onOpen);
  const onCloseRef = useRef(onClose);
  onOpenRef.current = onOpen;
  onCloseRef.current = onClose;

  // Wire module-level callbacks to React state
  onOpenCallback = useCallback((side: 'left' | 'right') => {
    onOpenRef.current?.(side);
  }, []);

  onCloseCallback = useCallback((_side: 'left' | 'right') => {
    // Edge swipe didn't complete — no action needed
  }, []);

  onProgressCallback = useCallback((side: 'left' | 'right' | null, progress: number) => {
    if (!side || progress === 0) {
      setState({ isEdgeSwiping: false, edgeSide: null, dragProgress: 0 });
    } else {
      setState({ isEdgeSwiping: true, edgeSide: side, dragProgress: progress });
    }
  }, []);

  return state;
}
