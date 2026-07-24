// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  buildConsumerChain,
  canNativeScrollX,
  canSwiperSlide,
  hasActiveTextSelection,
  resolveGestureOwner,
  yieldToSwiper,
  type ConsumerChain,
  type SwiperLike,
} from './gestureArbiter';

function makeSwiper(overrides: Partial<SwiperLike> = {}): SwiperLike {
  return { isBeginning: false, isEnd: false, allowTouchMove: false, ...overrides };
}

/**
 * jsdom does no layout — geometry properties default to 0 and must be
 * defined per element.
 */
function makeScroller({ scrollWidth = 0, clientWidth = 100, scrollLeft = 0 } = {}): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperties(el, {
    scrollWidth: { value: scrollWidth, configurable: true },
    clientWidth: { value: clientWidth, configurable: true },
    scrollLeft: { value: scrollLeft, configurable: true, writable: true },
  });
  return el;
}

function emptyChain(): ConsumerChain {
  return { scrollers: [], swipers: [] };
}

describe('canNativeScrollX', () => {
  it('returns false when there is no horizontal overflow', () => {
    const el = makeScroller({ scrollWidth: 100, clientWidth: 100 });
    expect(canNativeScrollX(el, 1)).toBe(false);
    expect(canNativeScrollX(el, -1)).toBe(false);
  });

  it('allows scrolling toward the direction with remaining content', () => {
    const el = makeScroller({ scrollWidth: 300, clientWidth: 100, scrollLeft: 0 });
    // Finger right reveals earlier content — impossible at scrollLeft 0.
    expect(canNativeScrollX(el, 1)).toBe(false);
    expect(canNativeScrollX(el, -1)).toBe(true);
  });

  it('detects the far edge', () => {
    const el = makeScroller({ scrollWidth: 300, clientWidth: 100, scrollLeft: 200 });
    expect(canNativeScrollX(el, 1)).toBe(true);
    expect(canNativeScrollX(el, -1)).toBe(false);
  });

  it('allows both directions mid-scroll', () => {
    const el = makeScroller({ scrollWidth: 300, clientWidth: 100, scrollLeft: 100 });
    expect(canNativeScrollX(el, 1)).toBe(true);
    expect(canNativeScrollX(el, -1)).toBe(true);
  });
});

describe('canSwiperSlide', () => {
  it('maps drag direction to previous/next slide availability', () => {
    expect(canSwiperSlide(makeSwiper({ isBeginning: true }), 1)).toBe(false);
    expect(canSwiperSlide(makeSwiper({ isBeginning: true }), -1)).toBe(true);
    expect(canSwiperSlide(makeSwiper({ isEnd: true }), -1)).toBe(false);
    expect(canSwiperSlide(makeSwiper({ isEnd: true }), 1)).toBe(true);
    expect(canSwiperSlide(makeSwiper(), 1)).toBe(true);
    expect(canSwiperSlide(makeSwiper(), -1)).toBe(true);
  });
});

describe('buildConsumerChain', () => {
  it('collects scrollers and swipers innermost-first up to the boundary', () => {
    const panel = document.createElement('aside');
    const swiperEl = document.createElement('div');
    swiperEl.className = 'swiper';
    const swiperInstance = makeSwiper();
    (swiperEl as HTMLElement & { swiper?: SwiperLike }).swiper = swiperInstance;
    const scroller = document.createElement('div');
    scroller.style.overflowX = 'auto';
    const target = document.createElement('span');
    scroller.appendChild(target);
    swiperEl.appendChild(scroller);
    panel.appendChild(swiperEl);
    document.body.appendChild(panel);

    const chain = buildConsumerChain(target, panel);
    expect(chain.scrollers).toEqual([scroller]);
    expect(chain.swipers).toEqual([swiperInstance]);
    panel.remove();
  });

  it('skips swipers when the touch is inside a no-swiping zone', () => {
    const panel = document.createElement('aside');
    const swiperEl = document.createElement('div');
    swiperEl.className = 'swiper';
    (swiperEl as HTMLElement & { swiper?: SwiperLike }).swiper = makeSwiper();
    const noSwiping = document.createElement('div');
    noSwiping.className = 'swiper-no-swiping';
    const target = document.createElement('span');
    noSwiping.appendChild(target);
    swiperEl.appendChild(noSwiping);
    panel.appendChild(swiperEl);
    document.body.appendChild(panel);

    const chain = buildConsumerChain(target, panel);
    expect(chain.swipers).toEqual([]);
    panel.remove();
  });

  it('ignores destroyed swiper instances and non-overflow containers', () => {
    const panel = document.createElement('aside');
    const swiperEl = document.createElement('div');
    swiperEl.className = 'swiper';
    (swiperEl as HTMLElement & { swiper?: SwiperLike }).swiper = makeSwiper({ destroyed: true });
    const verticalOnly = document.createElement('div');
    verticalOnly.style.overflowY = 'auto';
    verticalOnly.appendChild(document.createElement('span'));
    swiperEl.appendChild(verticalOnly);
    panel.appendChild(swiperEl);
    document.body.appendChild(panel);

    const chain = buildConsumerChain(verticalOnly.firstChild, panel);
    expect(chain.swipers).toEqual([]);
    expect(chain.scrollers).toEqual([]);
    panel.remove();
  });
});

describe('resolveGestureOwner', () => {
  it('gives a scrollable scroller priority over the swiper and the drawer', () => {
    const scroller = makeScroller({ scrollWidth: 300, clientWidth: 100, scrollLeft: 100 });
    const swiper = makeSwiper();
    const owner = resolveGestureOwner({ scrollers: [scroller], swipers: [swiper] }, 20, 1);
    expect(owner).toEqual({ kind: 'scroller', element: scroller });
  });

  it('falls through to the swiper when the scroller hits its edge', () => {
    const scroller = makeScroller({ scrollWidth: 300, clientWidth: 100, scrollLeft: 0 });
    const swiper = makeSwiper({ isBeginning: false });
    // Finger right: scroller already at its left edge → swiper takes it.
    const owner = resolveGestureOwner({ scrollers: [scroller], swipers: [swiper] }, 20, 1);
    expect(owner).toEqual({ kind: 'swiper', instance: swiper });
  });

  it('lets the drawer close when the swiper is at its first slide and the drag closes', () => {
    const swiper = makeSwiper({ isBeginning: true });
    const owner = resolveGestureOwner({ scrollers: [], swipers: [swiper] }, 20, 1);
    expect(owner).toEqual({ kind: 'drawer' });
  });

  it('keeps the swiper for the back direction on a later slide even when that is the close direction', () => {
    // Right drawer (close = +1) on slide 2: swiping right goes back a
    // slide instead of closing the drawer.
    const swiper = makeSwiper({ isBeginning: false, isEnd: true });
    const owner = resolveGestureOwner({ scrollers: [], swipers: [swiper] }, 20, 1);
    expect(owner).toEqual({ kind: 'swiper', instance: swiper });
  });

  it('hands an unconsumable non-close drag to the swiper for resistance feedback', () => {
    const swiper = makeSwiper({ isEnd: true });
    const owner = resolveGestureOwner({ scrollers: [], swipers: [swiper] }, -20, 1);
    expect(owner).toEqual({ kind: 'swiper', instance: swiper });
  });

  it('rubber-bands the drawer on plain content in the non-close direction', () => {
    expect(resolveGestureOwner(emptyChain(), -20, 1)).toEqual({ kind: 'drawer' });
  });

  it('closes the drawer on plain content in the close direction', () => {
    expect(resolveGestureOwner(emptyChain(), 20, 1)).toEqual({ kind: 'drawer' });
  });

  it('mirrors close-direction handling for the left drawer', () => {
    // A left drawer's close direction (-1) aligns with the swiper's NEXT
    // direction, so the hinge sits at the LAST slide: the swiper keeps
    // advancing until it runs out of slides, then the drawer closes.
    const swiper = makeSwiper({ isEnd: true });
    expect(resolveGestureOwner({ scrollers: [], swipers: [swiper] }, -20, -1)).toEqual({ kind: 'drawer' });
    // Mid-pager, the same leftward drag still belongs to the swiper.
    const mid = makeSwiper();
    expect(resolveGestureOwner({ scrollers: [], swipers: [mid] }, -20, -1)).toEqual({
      kind: 'swiper',
      instance: mid,
    });
  });
});

describe('hasActiveTextSelection', () => {
  it('is false with a collapsed selection and true with selected text', () => {
    expect(hasActiveTextSelection()).toBe(false);
    vi.stubGlobal('getSelection', () => ({ isCollapsed: false, toString: () => 'selected' }));
    expect(hasActiveTextSelection()).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('yieldToSwiper', () => {
  it('enables touch move and restores it on touch end', () => {
    const swiper = makeSwiper();
    yieldToSwiper(swiper);
    expect(swiper.allowTouchMove).toBe(true);
    window.dispatchEvent(new Event('touchend'));
    expect(swiper.allowTouchMove).toBe(false);
  });

  it('restores on pointerup and is idempotent', () => {
    const swiper = makeSwiper();
    const restore = yieldToSwiper(swiper);
    window.dispatchEvent(new Event('pointerup'));
    expect(swiper.allowTouchMove).toBe(false);
    expect(() => restore()).not.toThrow();
  });
});
