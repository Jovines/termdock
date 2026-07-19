export interface GesturePointerState {
  pointerId: number;
  startX: number;
  startY: number;
  startTime: number;
}

/**
 * What a handler wants the GestureManager to do with this pointer.
 *
 * 'claim'   — take exclusive control; calls preventDefault to block Swiper /
 *             browser defaults.  Only the first handler to claim (by priority)
 *             actually gets it.  Subsequent handlers' claims are ignored until
 *             the current claimant releases.
 *
 * 'release' — give up the current claim.  Used when a gesture decides it
 *             doesn't apply (e.g. long-press moved too far, edge-swipe turned
 *             out to be vertical).
 *
 * 'neutral' — this handler is tracking state but not making any claim change.
 */
export type GestureAction = 'claim' | 'release' | 'neutral';

export interface GestureHandler {
  /** Unique name for debugging. */
  name: string;
  /**
   * Higher = earlier chance to claim.  Leave gaps between tiers.
   *   100 — (reserved; sidebar drawers handle edge drags outside this manager)
   *    90 — long-press arrows + double-tap
   *    80 — tmux-mode touch scroll (SGR mouse wheel via PTY)
   *    70 — normal-mode touch scroll (xterm.js scrollLines)
   */
  priority: number;
  /** If set, only pointer events within this element are considered. */
  container?: HTMLElement | null;

  /** Called on pointerdown.  Return `true` to claim eagerly. */
  onPointerDown: (e: PointerEvent, state: GesturePointerState) => boolean;

  /**
   * Called on EVERY pointermove for every matching handler.
   *
   * `isClaimed` is true when this handler currently holds the claim.
   *   isClaimed = true  → perform the action (scroll, SGR, arrows, ...)
   *   isClaimed = false → only track state (didMove, velocity, axis, ...),
   *                       do NOT perform the action.
   *
   * Return a GestureAction:
   *   'claim'   — lock this pointer to me, preventDefault
   *   'release' — give up and let lower-priority handlers claim
   *   'neutral' — I'm just tracking / doing my action, no claim change
   */
  onPointerMove: (e: PointerEvent, isClaimed: boolean) => GestureAction;

  /** Called on pointerup for ALL matching handlers — cleanup + tap detection. */
  onPointerUp: (e: PointerEvent) => void;

  /** Called on pointercancel for ALL matching handlers — cleanup. */
  onPointerCancel: (e: PointerEvent) => void;
}

export const PRIORITY_LONG_PRESS = 90;
export const PRIORITY_TMUX_SCROLL = 80;
export const PRIORITY_NORMAL_SCROLL = 70;

export interface GestureHandlerInfo {
  name: string;
  priority: number;
  hasContainer: boolean;
}
