/**
 * Per-gesture arbitration between the sidebar drawer and the horizontal
 * gesture consumers inside it (native overflow-x scrollers, Swiper
 * instances).
 *
 * The old model let every horizontal drag inside the panel move the drawer
 * AND the inner content at the same time, then papered over the worst spots
 * with `data-sidebar-gesture-ignore` markers (which in turn made those
 * regions gesture dead-ends — no edge fall-through back to the swiper or
 * the drawer).
 *
 * This module replaces that with single-ownership arbitration, the way
 * nested gestures work on iOS/Android:
 *
 *  1. At touch start, walk up from the target and collect the consumer
 *     chain (innermost-first): native x-scrollers, then Swiper instances.
 *  2. Once the drag direction is known (the drawer's use-gesture is
 *     configured with `axis: 'x'` + `axisThreshold`, so the first movement
 *     callback IS the direction-known moment), the DEEPEST consumer that
 *     can consume in that direction owns the whole touch sequence:
 *       - a scroller that can scroll that way           → native scroll
 *       - else a swiper that can slide that way         → swiper
 *       - else, if the direction closes the drawer      → drawer
 *       - else the nearest consumer shows its own edge
 *         resistance (swiper rubber-band / drawer bounce)
 *  3. Ownership is exclusive for the rest of the gesture: the drawer's
 *     drag is cancelled when it loses, and an owning swiper gets
 *     `allowTouchMove` flipped on mid-gesture (Swiper 12 keeps re-syncing
 *     its touch start coordinates while `allowTouchMove` is false, so the
 *     handoff has no visual jump) and restored when the touch ends.
 *
 * In-sidebar Swipers must render with `allowTouchMove={false}` so they
 * stay frozen until arbitration hands them the gesture.
 */

/** Structural subset of a Swiper instance used by the arbiter. */
export interface SwiperLike {
  isBeginning: boolean;
  isEnd: boolean;
  destroyed?: boolean;
  allowTouchMove: boolean;
}

export interface ConsumerChain {
  /** Native horizontal scroll containers, innermost first. */
  scrollers: HTMLElement[];
  /** Swiper instances whose container is an ancestor of the touch target, innermost first. */
  swipers: SwiperLike[];
}

export type GestureOwner =
  | { kind: 'drawer' }
  | { kind: 'scroller'; element: HTMLElement }
  | { kind: 'swiper'; instance: SwiperLike };

const SWIPER_CONTAINER_CLASS = 'swiper';
const SWIPER_NO_SWIPING_CLASS = 'swiper-no-swiping';
// Sub-pixel / rounding tolerance for scroll-edge detection.
const EDGE_EPSILON_PX = 1;

/**
 * Whether a native scroller can move in the drag direction.
 * LTR only (the app ships zh/en LTR layouts): a finger moving right
 * (direction 1) reveals earlier content, i.e. scrollLeft must be > 0.
 */
export function canNativeScrollX(element: HTMLElement, direction: 1 | -1): boolean {
  const maxScrollLeft = element.scrollWidth - element.clientWidth;
  if (maxScrollLeft <= EDGE_EPSILON_PX) return false;
  return direction > 0
    ? element.scrollLeft > EDGE_EPSILON_PX
    : element.scrollLeft < maxScrollLeft - EDGE_EPSILON_PX;
}

/**
 * Whether a swiper can slide in the drag direction: a finger moving right
 * (direction 1) goes back to the previous slide.
 */
export function canSwiperSlide(swiper: SwiperLike, direction: 1 | -1): boolean {
  return direction > 0 ? !swiper.isBeginning : !swiper.isEnd;
}

/**
 * Build the consumer chain for a touch starting at `target`, walking up to
 * (and excluding) `boundary` — the drawer panel element.
 *
 * Touches inside a `.swiper-no-swiping` zone never produce swiper
 * consumers, mirroring Swiper's own noSwiping rule. Scrollers are checked
 * before swipers at resolve time; in this app's markup swipers are always
 * ancestors of the scrollers they contain, so separate innermost-first
 * arrays preserve the true depth order.
 */
export function buildConsumerChain(target: EventTarget | null, boundary: HTMLElement): ConsumerChain {
  const scrollers: HTMLElement[] = [];
  const swipers: SwiperLike[] = [];
  if (!(target instanceof Element)) return { scrollers, swipers };

  const inNoSwipingZone = Boolean(target.closest(`.${SWIPER_NO_SWIPING_CLASS}`));

  let element: Element | null = target;
  while (element && element !== boundary) {
    if (!inNoSwipingZone && element.classList.contains(SWIPER_CONTAINER_CLASS)) {
      const instance = (element as HTMLElement & { swiper?: SwiperLike }).swiper;
      if (instance && !instance.destroyed) {
        swipers.push(instance);
      }
    }
    if (element instanceof HTMLElement) {
      const { overflowX } = getComputedStyle(element);
      if (overflowX === 'auto' || overflowX === 'scroll') {
        scrollers.push(element);
      }
    }
    element = element.parentElement;
  }
  return { scrollers, swipers };
}

/**
 * Pick the single owner for the gesture once the drag direction is known.
 *
 * @param chain          consumers collected at touch start
 * @param movementX      signed horizontal movement (px) at decision time
 * @param closeDirection +1 when dragging right closes the drawer (right
 *                       sidebar), -1 for the left sidebar
 */
export function resolveGestureOwner(
  chain: ConsumerChain,
  movementX: number,
  closeDirection: 1 | -1,
): GestureOwner {
  const direction: 1 | -1 = movementX >= 0 ? 1 : -1;

  for (const element of chain.scrollers) {
    if (canNativeScrollX(element, direction)) {
      return { kind: 'scroller', element };
    }
  }
  for (const instance of chain.swipers) {
    if (canSwiperSlide(instance, direction)) {
      return { kind: 'swiper', instance };
    }
  }
  // Nobody deeper can consume a close-direction drag: the drawer takes it
  // (e.g. swiping right on a swiper's first slide closes a right drawer).
  if (direction === closeDirection) {
    return { kind: 'drawer' };
  }
  // Non-close direction nobody wants: hand it to the nearest consumer for
  // its built-in edge-resistance feedback, falling back to the drawer's
  // own rubber-band on plain content.
  if (chain.swipers.length > 0) {
    return { kind: 'swiper', instance: chain.swipers[0] };
  }
  if (chain.scrollers.length > 0) {
    return { kind: 'scroller', element: chain.scrollers[0] };
  }
  return { kind: 'drawer' };
}

/**
 * True while the user has an active (non-collapsed) text selection.
 * Checked at arbitration time so a long-press selection drag is never
 * stolen by the drawer or a swiper.
 */
export function hasActiveTextSelection(): boolean {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') {
    return false;
  }
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && String(selection).length > 0);
}

/**
 * Hand the current touch sequence to a Swiper mid-gesture and return a
 * restore function. Swiper 12 re-syncs its touch start coordinates on
 * every move while `allowTouchMove` is false, so flipping it on here picks
 * the gesture up from the finger's live position — no translate jump.
 * `allowTouchMove` is restored to false when the touch ends (the in-panel
 * Swipers must stay frozen until the next arbitration).
 */
export function yieldToSwiper(instance: SwiperLike): () => void {
  instance.allowTouchMove = true;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    instance.allowTouchMove = false;
    window.removeEventListener('touchend', restore);
    window.removeEventListener('touchcancel', restore);
    window.removeEventListener('pointerup', restore);
    window.removeEventListener('pointercancel', restore);
  };
  window.addEventListener('touchend', restore);
  window.addEventListener('touchcancel', restore);
  window.addEventListener('pointerup', restore);
  window.addEventListener('pointercancel', restore);
  return restore;
}
