import React, { useCallback, useEffect, useRef } from 'react';
import { useDrag } from '@use-gesture/react';
import {
  prefersReducedMotion,
  projectMomentum,
  rubberband,
  sampleSpringKeyframes,
  SPRING_SHEET,
  type SpringSolver,
} from '../../utils/spring';
import {
  buildConsumerChain,
  hasActiveTextSelection,
  resolveGestureOwner,
  yieldToSwiper,
} from './gestureArbiter';

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
// Horizontal dominance needed before a drag is recognized (use-gesture
// `axis` + `axisThreshold`): the first movement callback after this slop
// is the arbitration moment — before it the drawer stays frozen so inner
// content never double-moves, and vertical scrolls never touch the drawer.
const AXIS_LOCK_THRESHOLD_PX = 8;
// The drag config types only accept the per-pointer-type object form.
const AXIS_LOCK_THRESHOLD = { touch: AXIS_LOCK_THRESHOLD_PX, pen: AXIS_LOCK_THRESHOLD_PX };
// A release faster than this (px/s) counts as a flick. Only flicks earn a
// little bounce (damping 0.8) — overshoot feels right when the gesture
// itself carried momentum, and wrong otherwise. Slower snaps and
// programmatic toggles stay critically damped (no overshoot).
const FLING_VELOCITY_THRESHOLD = 500;
const REDUCED_MOTION_FADE_MS = 200;
// Grace period between the spring finishing and the deferred state commit.
const COMMIT_BUFFER_MS = 50;
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

/** Temporary diagnostics for gesture/snap debugging (enable via window.__SIDEBAR_DEBUG__). */
function dbg(...args: unknown[]): void {
  if (typeof window !== 'undefined' && (window as unknown as { __SIDEBAR_DEBUG__?: boolean }).__SIDEBAR_DEBUG__) {
    console.log('[Sidebar]', ...args);
  }
}

/**
 * Overlay drawer driven by a spring, following Apple's fluid-interface model:
 *
 *  - Drag tracks the finger 1:1; at the open/closed boundary the panel
 *    rubber-bands with progressive resistance instead of hard-stopping.
 *  - On release, the resting point is *projected* from the release velocity
 *    (exponential decay, d ≈ 0.998) and the drawer snaps to whichever state
 *    the gesture was heading toward — a flick throws the drawer open/closed.
 *  - The release velocity is handed off into the spring, so there is no
 *    visible seam between dragging and animating.
 *  - Snaps are sampled into WAAPI keyframes, so they run on the compositor
 *    and stay smooth even when React blocks the main thread mid-animation.
 *    Grabbing the panel mid-animation interrupts the spring at its exact
 *    analytical (wall-clock) position and velocity — no jumps, no locks.
 *  - `prefers-reduced-motion` replaces the slide with a gentle cross-fade.
 */
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
  /**
   * In-flight WAAPI spring. The sampled keyframes run on the compositor
   * (smooth even when React blocks the main thread mid-animation — e.g. the
   * heavy right-sidebar re-render on close); the solver is kept so an
   * interruption reads the exact live value/velocity analytically.
   */
  interface SpringPlayback {
    solver: SpringSolver;
    startTime: number;
    target: number;
    animations: Animation[];
  }
  const playbackRef = useRef<SpringPlayback | null>(null);
  // Deferred state commit: the app-level open/close flip (and its heavy
  // React re-render) is scheduled AFTER the animation has played out, so
  // main-thread work can never stall the gesture→animation handoff.
  const commitTimerRef = useRef<number | null>(null);
  // Per-gesture ownership: true while THIS touch sequence owns the drawer
  // position. Guards the release path against ignored starts and duplicate
  // release events.
  const panelDragActiveRef = useRef(false);
  const edgeDragActiveRef = useRef(false);
  // Position history of the current gesture. @use-gesture reports velocity
  // as an UNSIGNED magnitude (sign lives in `direction`) and zeroes it on
  // some release paths — a signed release velocity for momentum projection
  // and spring handoff must come from our own history instead.
  const dragHistoryRef = useRef<Array<{ t: number; x: number }>>([]);
  /** Restore handle for a swiper we handed a gesture to (allowTouchMove flip). */
  const swiperYieldRestoreRef = useRef<(() => void) | null>(null);

  // Frozen at mount so React never rewrites transform/opacity after the
  // first commit — from then on both are driven imperatively by the spring /
  // drag path (a re-render must not stomp an in-flight animation).
  const initialXRef = useRef(currentXRef.current);
  const initialBackdropOpacityRef = useRef(isOpen ? 1 : 0);

  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const closedXRef = useRef(closedX);
  closedXRef.current = closedX;
  const drawerWidthRef = useRef(drawerWidthPx);
  drawerWidthRef.current = drawerWidthPx;
  const isLeftRef = useRef(isLeft);
  isLeftRef.current = isLeft;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

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

  const progressForX = useCallback((x: number): number => {
    const w = drawerWidthRef.current;
    return isLeftRef.current ? (x + w) / w : (w - x) / w;
  }, []);

  const setBackdropOpacity = useCallback((x: number) => {
    const backdrop = backdropRef.current;
    if (!backdrop) return;
    backdrop.style.opacity = String(clamp(progressForX(x), 0, 1));
  }, [progressForX]);

  const applyPosition = useCallback((nextX: number) => {
    currentXRef.current = nextX;
    const panel = panelRef.current;
    if (!panel) return;
    panel.style.transform = `translateX(${nextX}px)`;
    setBackdropOpacity(nextX);
  }, [setBackdropOpacity]);

  const setPosition = useCallback((nextX: number) => {
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

  /**
   * Apply the latest batched drag position NOW (if any) instead of waiting
   * for its rAF. Needed before reading currentXRef for snap decisions and
   * spring handoffs — otherwise they see a one-frame-stale position.
   */
  const flushPendingPosition = useCallback(() => {
    if (positionFrameRef.current !== null) {
      window.cancelAnimationFrame(positionFrameRef.current);
      positionFrameRef.current = null;
    }
    const pendingX = pendingXRef.current;
    pendingXRef.current = null;
    if (pendingX !== null) {
      applyPosition(pendingX);
    }
  }, [applyPosition]);

  /** Clamp a rendered position to the flush drawer bounds (no edge gap). */
  const clampToBounds = useCallback((x: number): number => {
    const closed = closedXRef.current;
    return clamp(x, Math.min(0, closed), Math.max(0, closed));
  }, []);

  /**
   * Stop the in-flight WAAPI spring (if any) and return its exact live
   * value/velocity — analytical (wall-clock), so it's correct even if frames
   * were dropped while the main thread was busy.
   */
  const stopPlayback = useCallback((): { value: number; velocity: number } | null => {
    const playback = playbackRef.current;
    if (!playback) return null;
    playbackRef.current = null;
    const t = (performance.now() - playback.startTime) / 1000;
    const live = { value: playback.solver.value(t), velocity: playback.solver.velocity(t) };
    playback.animations.forEach((animation) => animation.cancel());
    return live;
  }, []);

  /** Cancel a deferred open/close commit (interrupt, programmatic flip, unmount). */
  const cancelPendingCommit = useCallback(() => {
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
  }, []);

  /**
   * Restore a swiper handed a previous gesture (safety net — the arbiter's
   * own touchend listeners normally do this). Must run before any new
   * gesture setup so a stale allowTouchMove=true can never cause a
   * double-move.
   */
  const restoreYieldedSwiper = useCallback(() => {
    swiperYieldRestoreRef.current?.();
    swiperYieldRestoreRef.current = null;
  }, []);

  /**
   * Stop any in-flight snap and pin the panel at its live on-screen position
   * — grabbing a moving drawer must follow the finger from exactly where it
   * is, not from the animation's target.
   */
  const grabLivePosition = useCallback(() => {
    flushPendingPosition();
    cancelPendingCommit();
    const live = stopPlayback();
    if (live) {
      applyPosition(clampToBounds(live.value));
    }
    const panel = panelRef.current;
    const backdrop = backdropRef.current;
    panel?.getAnimations().forEach((animation) => animation.cancel());
    if (panel) {
      panel.style.transition = 'none';
      panel.style.opacity = '1';
    }
    backdrop?.getAnimations().forEach((animation) => animation.cancel());
    if (backdrop) backdrop.style.transition = 'none';
  }, [applyPosition, cancelPendingCommit, clampToBounds, flushPendingPosition, stopPlayback]);

  const animateToState = useCallback(
    (open: boolean, opts?: { velocity?: number }): number => {
      flushPendingPosition();
      cancelPendingCommit();
      const panel = panelRef.current;
      const backdrop = backdropRef.current;
      const targetX = open ? 0 : closedXRef.current;

      // The state flip hasn't happened yet (deferred) — drive hit-testing
      // imperatively in the meantime: a closing drawer's invisible backdrop
      // must not eat touches while the animation plays out.
      if (backdrop) backdrop.style.pointerEvents = open ? 'auto' : 'none';

      // Start from the live on-screen position: an in-flight spring's
      // analytical value, or the (drag-tracked / settled) inline position.
      const live = stopPlayback();
      const startX = live ? clampToBounds(live.value) : currentXRef.current;
      const startVelocity = opts?.velocity ?? live?.velocity ?? 0;

      if (prefersReducedMotion()) {
        // Reduced motion: no slide, no spring — settle instantly and
        // cross-fade at the final position.
        currentXRef.current = targetX;
        if (panel) {
          panel.style.transition = `opacity ${REDUCED_MOTION_FADE_MS}ms ease`;
          panel.style.opacity = open ? '1' : '0';
          panel.style.transform = `translateX(${targetX}px)`;
        }
        if (backdrop) {
          backdrop.style.transition = `opacity ${REDUCED_MOTION_FADE_MS}ms ease`;
          backdrop.style.opacity = open ? '1' : '0';
        }
        return REDUCED_MOTION_FADE_MS;
      }

      if (panel) {
        panel.style.transition = 'none';
        panel.style.opacity = '1';
      }
      if (backdrop) backdrop.style.transition = 'none';

      // Bounce (damping 0.8) only when the gesture itself carried momentum.
      const flung = Math.abs(opts?.velocity ?? 0) > FLING_VELOCITY_THRESHOLD;
      const { frames, durationMs, solver } = sampleSpringKeyframes(
        {
          dampingRatio: flung ? SPRING_SHEET.dampingRatio : 1.0,
          response: SPRING_SHEET.response,
        },
        startX,
        startVelocity,
        targetX,
        clampToBounds,
      );

      if (!panel || (Math.abs(startX - targetX) < 0.5 && Math.abs(startVelocity) < 5)) {
        applyPosition(targetX);
        return 0;
      }

      // Sampled keyframes → WAAPI → the motion runs on the compositor and
      // cannot stutter when the main thread is busy (e.g. heavy sidebar
      // re-renders during close). The solver is kept for analytical
      // interruption (stopPlayback).
      const panelAnim = panel.animate(
        frames.map((x) => ({ transform: `translateX(${x}px)` })),
        { duration: durationMs, easing: 'linear', fill: 'forwards' },
      );
      const animations: Animation[] = [panelAnim];
      if (backdrop) {
        animations.push(
          backdrop.animate(
            frames.map((x) => ({ opacity: String(clamp(progressForX(x), 0, 1)) })),
            { duration: durationMs, easing: 'linear', fill: 'forwards' },
          ),
        );
      }
      playbackRef.current = { solver, startTime: performance.now(), target: targetX, animations };
      dbg('spring start', { startX, startVelocity, targetX, frames: frames.length, durationMs });
      panelAnim.onfinish = () => {
        const playback = playbackRef.current;
        if (!playback || !playback.animations.includes(panelAnim)) return;
        playbackRef.current = null;
        applyPosition(targetX);
        playback.animations.forEach((animation) => animation.cancel());
        dbg('spring finish', { targetX });
      };
      return durationMs;
    },
    [applyPosition, cancelPendingCommit, clampToBounds, flushPendingPosition, progressForX, stopPlayback],
  );

  /**
   * Snap decision on release: project the resting point from the release
   * velocity and pick the nearest state — then hand the velocity into the
   * spring so drag and animation join seamlessly.
   *
   * @param velocityPxPerSec SIGNED release velocity from the drag history.
   */
  const decideSnap = useCallback(
    (velocityPxPerSec: number) => {
      flushPendingPosition();
      const velocity = velocityPxPerSec;
      const open = 0;
      const closed = closedXRef.current;
      const projected = currentXRef.current + projectMomentum(velocity);
      const shouldOpen = Math.abs(projected - open) <= Math.abs(projected - closed);
      dbg('decideSnap', { velocity, currentX: currentXRef.current, projected, shouldOpen });

      const durationMs = animateToState(shouldOpen, { velocity });
      // Defer the app-level state flip (and the heavy React re-render it
      // triggers) until the spring has played out — this is what keeps the
      // close of a heavy pane (e.g. Changes/diff) visually free of jank:
      // zero main-thread work competes with the animation.
      if (shouldOpen && !isOpenRef.current) {
        commitTimerRef.current = window.setTimeout(() => {
          commitTimerRef.current = null;
          onOpenRef.current?.();
        }, durationMs + COMMIT_BUFFER_MS);
      } else if (!shouldOpen && isOpenRef.current) {
        commitTimerRef.current = window.setTimeout(() => {
          commitTimerRef.current = null;
          onCloseRef.current();
        }, durationMs + COMMIT_BUFFER_MS);
      }
    },
    [animateToState, flushPendingPosition],
  );

  // Rubber-band past the open/closed bounds: progressive resistance instead
  // of a frozen hard stop.
  const softClampX = useCallback((raw: number): number => {
    const closed = closedXRef.current;
    const min = Math.min(0, closed);
    const max = Math.max(0, closed);
    const w = drawerWidthRef.current;
    if (raw < min) return min - rubberband(min - raw, w);
    if (raw > max) return max + rubberband(raw - max, w);
    return raw;
  }, []);

  /** Record a tracked drag position (called on every drag move). */
  const trackDragPosition = useCallback((x: number) => {
    const history = dragHistoryRef.current;
    const now = performance.now();
    history.push({ t: now, x });
    const cutoff = now - 120;
    while (history.length > 0 && history[0].t < cutoff) {
      history.shift();
    }
  }, []);

  /**
   * Signed release velocity (px/s) from the last ~100ms of tracked movement.
   * Returns 0 when there isn't enough recent motion (e.g. finger held still
   * before lifting) — a held release must not fling.
   */
  const releaseVelocity = useCallback((): number => {
    const history = dragHistoryRef.current;
    if (history.length < 2) return 0;
    const last = history[history.length - 1];
    if (performance.now() - last.t > 60) return 0;
    const first = history[0];
    const dtSec = (last.t - first.t) / 1000;
    if (dtSec < 0.016) return 0;
    return (last.x - first.x) / dtSec;
  }, []);

  useEffect(() => {
    // A programmatic flip (Esc / backdrop / toggle) cancels any deferred
    // gesture commit — the prop is now the source of truth.
    cancelPendingCommit();
    // If a gesture already started the spring toward this exact state (with
    // its velocity handoff), don't restart it as a plain retarget.
    const playback = playbackRef.current;
    const targetX = isOpen ? 0 : closedXRef.current;
    if (playback && playback.target === targetX) return;
    animateToState(isOpen);
  }, [isOpen, animateToState, cancelPendingCommit]);

  // Keep the drawer aligned when viewport-derived width changes.
  useEffect(() => {
    grabLivePosition();
    setPosition(isOpenRef.current ? 0 : closedX);
  }, [closedX, grabLivePosition, setPosition]);

  useEffect(() => {
    return () => {
      cancelPendingPositionFrame();
      cancelPendingCommit();
      stopPlayback();
      restoreYieldedSwiper();
    };
  }, [cancelPendingCommit, cancelPendingPositionFrame, restoreYieldedSwiper, stopPlayback]);

  // ESC 由 App 顶层统一处理（按层级关闭 modal/drawer/sidebar，并走 history overlay）。
  // 这里不再单独监听，避免和全局 handler 同时触发 history.back() 两次。

  /**
   * Panel drag with single-ownership arbitration.
   *
   * `axis: 'x'` + `axisThreshold` block every emit until the drag is
   * horizontally dominant past the slop — so `first` fires at the
   * axis-lock moment with the drag direction already known (and vertical
   * gestures never reach this handler at all). That makes `first` the
   * single arbitration point for the whole touch sequence: the consumer
   * chain under the finger (inner x-scrollers → swipers → drawer) is
   * resolved once, and exactly one owner takes it from there —
   *
   *  - a scroller that can scroll this way  → native scroll (we cancel)
   *  - else a swiper that can slide this way → flipped live via
   *    allowTouchMove, restored on touch end (we cancel)
   *  - else a close-direction drag          → the drawer tracks the finger
   *  - else                                 → nearest consumer's own edge
   *    resistance / drawer rubber-band feedback
   *
   * Because the drawer's drag is cancelled before it ever moved when it
   * loses, drawer and content can never translate together.
   */
  const bindPanel = useDrag(
    ({ active, cancel, first, last, movement: [mx], event }) => {
      dbg('bindPanel', { active, first, last, mx });
      if (!isTouchLikePointer(event)) {
        return;
      }
      if (first) {
        restoreYieldedSwiper();
        panelDragActiveRef.current = false;
        dragHistoryRef.current = [];
        // The gesture-ignore check belongs at gesture START only. Checking it
        // again on release swallows the snap and freezes the panel wherever
        // the finger lifted (e.g. mid rubber-band) when the release lands on
        // an ignored child.
        if (shouldIgnorePanelDrag(event)) {
          cancel();
          return;
        }
        const panel = panelRef.current;
        const chain = panel ? buildConsumerChain(event.target, panel) : null;
        // A long-press text selection in progress owns the touch outright.
        if (!chain || hasActiveTextSelection()) {
          cancel();
          return;
        }
        const owner = resolveGestureOwner(chain, mx, isLeftRef.current ? -1 : 1);
        dbg('arbitrate', { owner: owner.kind, mx });
        if (owner.kind === 'swiper') {
          swiperYieldRestoreRef.current = yieldToSwiper(owner.instance);
          cancel();
          return;
        }
        if (owner.kind === 'scroller') {
          // Native scroll already tracks the finger; just stay out.
          cancel();
          return;
        }
        // The drawer owns the gesture. Anchor at the live position; the
        // movement offset keeps tracking 1:1 from the touch start, so the
        // pre-lock slop shows up as a single-frame catch-up, not a lag.
        panelDragActiveRef.current = true;
        grabLivePosition();
        dragStartXRef.current = currentXRef.current;
      }
      if (!active) {
        // use-gesture may deliver the release twice (e.g. after cancel());
        // only the gesture that owned the drag decides, exactly once —
        // a duplicate would retarget the spring with velocity 0 and kill
        // the handoff.
        if (panelDragActiveRef.current) {
          panelDragActiveRef.current = false;
          decideSnap(releaseVelocity());
        }
        return;
      }
      if (panelDragActiveRef.current) {
        const nextX = softClampX(dragStartXRef.current + mx);
        trackDragPosition(nextX);
        setPosition(nextX);
      }
    },
    {
      axis: 'x',
      axisThreshold: AXIS_LOCK_THRESHOLD,
      filterTaps: true,
      // Only enable drag-to-close from touch / pen — desktop mouse users
      // close via backdrop click, the X button, or Esc. This prevents
      // accidental drags when selecting text inside the sidebar.
      pointer: { touch: true },
    },
  );

  const bindEdge = useDrag(
    ({ active, cancel, first, movement: [mx], event }) => {
      if (!isTouchLikePointer(event)) {
        cancel();
        return;
      }
      if (isOpenRef.current) {
        cancel();
        return;
      }
      if (first) {
        edgeDragActiveRef.current = true;
        dragHistoryRef.current = [];
        grabLivePosition();
        dragStartXRef.current = currentXRef.current;
      }
      if (!active) {
        if (edgeDragActiveRef.current) {
          edgeDragActiveRef.current = false;
          decideSnap(releaseVelocity());
        }
        return;
      }
      if (edgeDragActiveRef.current) {
        const nextX = softClampX(dragStartXRef.current + mx);
        trackDragPosition(nextX);
        setPosition(nextX);
      }
    },
    {
      axis: 'x',
      axisThreshold: AXIS_LOCK_THRESHOLD,
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
      onOpenRef.current?.();
    }
  }, []);

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
          opacity: initialBackdropOpacityRef.current,
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
        className={`fixed inset-y-0 z-sidebar-panel flex flex-col chrome-glow-panel will-change-transform ${
          isLeft ? 'border-r border-border/15' : 'border-l border-border/15'
        }`}
        style={{
          ...(isLeft ? { left: 0 } : { right: 0 }),
          width: drawerWidthPx,
          maxWidth: '94vw',
          transform: `translateX(${initialXRef.current}px)`,
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
