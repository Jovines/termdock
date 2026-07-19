import React from 'react';
import { GestureManager } from '../gesture/GestureManager';
import type { GestureAction, GestureHandler, GesturePointerState } from '../gesture/types';
import { PRIORITY_NORMAL_SCROLL } from '../gesture/types';

export interface TouchScrollConfig {
  scrollMultiplier?: number;
  maxScrollBoost?: number;
  boostDenominator?: number;
  velocityAlpha?: number;
  maxVelocity?: number;
  minVelocity?: number;
  /**
   * Exponential velocity retention per millisecond during the kinetic glide —
   * the model UIScrollView uses (WWDC 2018 momentum projection: d ≈ 0.998).
   * Higher = longer glide. 0.998 is the iOS-standard scroll feel.
   */
  decelerationRate?: number;
  enableKinetic?: boolean;
  shouldCaptureTouch?: () => boolean;
  canStartScrollGesture?: () => boolean;
  onScroll?: (deltaPixels: number) => boolean;
  onScrollWithCoords?: (deltaPixels: number, x: number, y: number) => boolean;
  onTap?: (x: number, y: number) => void;
  onClickWithCoords?: (x: number, y: number) => void;
  onClaimChange?: (claimed: boolean) => void;
  tapThreshold?: number;
  gestureName?: string;
}

interface TouchScrollState {
  lastY: number | null;
  lastTime: number | null;
  velocity: number;
  rafId: number | null;
  startX: number | null;
  startY: number | null;
  didMove: boolean;
  pointerId: number | null;
  isCurrentlyScrolling: boolean;
  gestureAxis: 'x' | 'y' | null;
}

export const useTouchScroll = (
  containerRef: React.RefObject<HTMLElement>,
  config: TouchScrollConfig
) => {
const {
    scrollMultiplier = 1.2,
    maxScrollBoost = 0.8,
    boostDenominator = 50,
    velocityAlpha = 0.15,
    maxVelocity = 15,
    minVelocity = 0.3,
    decelerationRate = 0.998,
    enableKinetic = true,
    shouldCaptureTouch,
    canStartScrollGesture,
    onScroll,
    onScrollWithCoords,
    onTap,
    onClickWithCoords,
    onClaimChange,
  tapThreshold = 10,
  gestureName = 'normal-scroll',
  } = config;

  const axisLockRatio = 1.06;

  const stateRef = React.useRef<TouchScrollState>({
    lastY: null,
    lastTime: null,
    velocity: 0,
    rafId: null,
    startX: null,
    startY: null,
    didMove: false,
    pointerId: null,
    isCurrentlyScrolling: false,
    gestureAxis: null,
  });

  const pendingScrollRef = React.useRef(0);
  const pendingXRef = React.useRef(0);
  const pendingYRef = React.useRef(0);
  const rafIdRef = React.useRef<number | null>(null);

  const consecutiveNoScrollRef = React.useRef(0);
  const isClaimingRef = React.useRef(false);

  const nowMs = React.useCallback(() => {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }, []);

  const processPendingScroll = React.useCallback(() => {
    rafIdRef.current = null;
    if (pendingScrollRef.current !== 0) {
      if (onScrollWithCoords && pendingXRef.current > 0 && pendingYRef.current > 0) {
        onScrollWithCoords(pendingScrollRef.current, pendingXRef.current, pendingYRef.current);
      } else if (onScroll) {
        onScroll(pendingScrollRef.current);
      }
      pendingScrollRef.current = 0;
      pendingXRef.current = 0;
      pendingYRef.current = 0;
    }
  }, [onScroll, onScrollWithCoords]);

  const requestScrollFrame = React.useCallback(() => {
    if (rafIdRef.current === null && typeof window !== 'undefined') {
      rafIdRef.current = window.requestAnimationFrame(processPendingScroll);
    }
  }, [processPendingScroll]);

  const accumulateAndRequestScroll = React.useCallback((deltaPixels: number, x?: number, y?: number) => {
    pendingScrollRef.current += deltaPixels;
    if (x !== undefined && y !== undefined) {
      pendingXRef.current = x;
      pendingYRef.current = y;
    }
    requestScrollFrame();
  }, [requestScrollFrame]);

  const scrollByPixels = React.useCallback((deltaPixels: number): boolean => {
    if (!deltaPixels || !onScroll) {
      return false;
    }

    const moved = onScroll(deltaPixels);

    if (!moved) {
      consecutiveNoScrollRef.current++;
    } else {
      consecutiveNoScrollRef.current = 0;
    }

    return moved;
  }, [onScroll]);

  const setClaimingState = React.useCallback((claimed: boolean) => {
    if (isClaimingRef.current === claimed) {
      return;
    }
    isClaimingRef.current = claimed;
    onClaimChange?.(claimed);
  }, [onClaimChange]);

  const stopKinetic = React.useCallback(() => {
    const state = stateRef.current;
    if (state.rafId !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(state.rafId);
    }
    state.rafId = null;

    if (rafIdRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(rafIdRef.current);
    }
    rafIdRef.current = null;
    pendingScrollRef.current = 0;
  }, []);

  const onTapRef = React.useRef(onTap);
  onTapRef.current = onTap;
  const onClickWithCoordsRef = React.useRef(onClickWithCoords);
  onClickWithCoordsRef.current = onClickWithCoords;
  const shouldCaptureRef = React.useRef(shouldCaptureTouch);
  shouldCaptureRef.current = shouldCaptureTouch;

  const setupPointerEvents = React.useCallback(() => {
    const container = containerRef.current;
    if (!container || !('PointerEvent' in window)) {
      return () => {};
    }

    const state = stateRef.current;

    const handler: GestureHandler = {
      name: gestureName,
      priority: PRIORITY_NORMAL_SCROLL,
      get container() {
        return containerRef.current ?? undefined;
      },

      onPointerDown: (event: PointerEvent, gs: GesturePointerState): boolean => {
        if (event.pointerType !== 'touch') return false;

        state.pointerId = event.pointerId;
        state.startX = gs.startX;
        state.startY = gs.startY;
        state.didMove = false;
        state.gestureAxis = null;
        state.lastY = event.clientY;
        state.lastTime = nowMs();
        state.velocity = 0;
        stopKinetic();
        return false;
      },

      onPointerMove: (event: PointerEvent, isClaimed: boolean): GestureAction => {
        if (event.pointerType !== 'touch' || state.pointerId !== event.pointerId) return 'neutral';
        if (!state.lastY || !state.lastTime) return 'neutral';

        const currentX = event.clientX;
        const currentY = event.clientY;
        const currentTime = nowMs();
        const deltaTime = currentTime - state.lastTime;
        const deltaY = currentY - state.lastY;

        if (state.startX !== null && state.startY !== null) {
          const totalDx = currentX - state.startX;
          const totalDy = currentY - state.startY;

          if (!state.didMove && Math.hypot(totalDx, totalDy) >= tapThreshold) {
            state.didMove = true;
          }

          if (state.gestureAxis === null && state.didMove) {
            const absDx = Math.abs(totalDx);
            const absDy = Math.abs(totalDy);
            if (absDx > absDy * axisLockRatio) {
              state.gestureAxis = 'x';
            } else if (absDy > absDx * axisLockRatio) {
              state.gestureAxis = 'y';
            }
          }

          if (state.gestureAxis === 'x') {
            state.isCurrentlyScrolling = false;
            setClaimingState(false);
            state.lastY = currentY;
            state.lastTime = currentTime;
            return isClaimed ? 'release' : 'neutral';
          }

          if (state.gestureAxis === null) {
            state.lastY = currentY;
            state.lastTime = currentTime;
            return 'neutral';
          }
        }

        if (state.gestureAxis === 'y' && !isClaimed && !(canStartScrollGesture?.() ?? true)) {
          state.lastY = currentY;
          state.lastTime = currentTime;
          setClaimingState(false);
          return 'neutral';
        }

        const instantaneousVelocity = deltaY / Math.max(deltaTime, 1);
        state.velocity = state.velocity * (1 - velocityAlpha) + instantaneousVelocity * velocityAlpha;
        state.velocity = Math.max(-maxVelocity, Math.min(maxVelocity, state.velocity));

        if (Math.abs(deltaY) > 1) {
          if (!isClaimed) {
            setClaimingState(true);
            state.lastY = currentY;
            state.lastTime = currentTime;
            return 'claim';
          }

          state.isCurrentlyScrolling = true;
          const scrollMultiplierAdjusted = scrollMultiplier +
            Math.min(maxScrollBoost, Math.abs(deltaY) / boostDenominator);
          const deltaPixels = -deltaY * scrollMultiplierAdjusted;
          accumulateAndRequestScroll(deltaPixels, currentX, currentY);
          setClaimingState(true);
        }

        state.lastY = currentY;
        state.lastTime = currentTime;
        return isClaimed ? 'claim' : 'neutral';
      },

      onPointerUp: (event: PointerEvent) => {
        if (event.pointerType !== 'touch' || state.pointerId !== event.pointerId) return;

        const wasScrolling = state.isCurrentlyScrolling;
        state.isCurrentlyScrolling = false;
        setClaimingState(false);

        const isScrolling = state.rafId !== null || rafIdRef.current !== null;
        if (!state.didMove && !isScrolling && state.startX !== null && state.startY !== null) {
          onTapRef.current?.(state.startX, state.startY);
        }
        if (!state.didMove && !isScrolling && state.startX !== null && state.startY !== null) {
          onClickWithCoordsRef.current?.(state.startX, state.startY);
        }

        state.pointerId = null;
        state.startX = null;
        state.startY = null;

        const endedHorizontalGesture = state.gestureAxis === 'x';
        state.gestureAxis = null;

        if (enableKinetic && wasScrolling && !endedHorizontalGesture && Math.abs(state.velocity) > minVelocity && state.didMove) {
          const animate = () => {
            const cTime = nowMs();
            const dt = cTime - (state.lastTime || cTime);
            state.lastTime = cTime;

            state.velocity *= Math.pow(decelerationRate, dt);
            if (Math.abs(state.velocity) < minVelocity) {
              state.velocity = 0;
              stopKinetic();
              return;
            }

            const moved = scrollByPixels(-state.velocity * dt);
            if (!moved && consecutiveNoScrollRef.current > 2) {
              state.velocity = 0;
              stopKinetic();
              return;
            }

            state.rafId = requestAnimationFrame(animate);
          };

          state.rafId = requestAnimationFrame(animate);
        }
      },

      onPointerCancel: (event: PointerEvent) => {
        if (event.pointerType !== 'touch' || state.pointerId !== event.pointerId) return;

        state.isCurrentlyScrolling = false;
        setClaimingState(false);
        state.pointerId = null;
        state.startX = null;
        state.startY = null;
        state.gestureAxis = null;
        stopKinetic();
      },
    };

    const unregister = GestureManager.register(handler);
    const previousTouchAction = container.style.touchAction;
    container.style.touchAction = 'none';

    return () => {
      setClaimingState(false);
      unregister();
      container.style.touchAction = previousTouchAction;
      stopKinetic();
    };
  }, [
    containerRef,
    gestureName,
    scrollMultiplier,
    maxScrollBoost,
    boostDenominator,
    velocityAlpha,
    maxVelocity,
    minVelocity,
    decelerationRate,
    nowMs,
    stopKinetic,
    scrollByPixels,
    accumulateAndRequestScroll,
    tapThreshold,
    enableKinetic,
    setClaimingState,
    canStartScrollGesture,
  ]);

  const setupTouchEvents = React.useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return () => {};
    }

    const state = stateRef.current;

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      if ((shouldCaptureTouch?.() ?? true) && event.cancelable) {
        event.preventDefault();
      }
      state.isCurrentlyScrolling = false;
      state.gestureAxis = null;
      state.lastY = event.touches[0].clientY;
      state.startX = event.touches[0].clientX;
      state.startY = event.touches[0].clientY;
      state.didMove = false;
      state.velocity = 0;
      stopKinetic();
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;

      const currentX = event.touches[0].clientX;
      const currentY = event.touches[0].clientY;

      if (state.startX !== null && state.startY !== null) {
        const totalDx = currentX - state.startX;
        const totalDy = currentY - state.startY;

        if (!state.didMove && Math.hypot(totalDx, totalDy) >= tapThreshold) {
          state.didMove = true;
        }

        if (state.gestureAxis === null && state.didMove) {
          const absDx = Math.abs(totalDx);
          const absDy = Math.abs(totalDy);
          if (absDx > absDy * axisLockRatio) {
            state.gestureAxis = 'x';
          } else if (absDy > absDx * axisLockRatio) {
            state.gestureAxis = 'y';
          }
        }

        if (state.gestureAxis === 'x') {
          state.isCurrentlyScrolling = false;
          state.lastY = currentY;
          return;
        }

        if (state.gestureAxis === null) {
          if ((shouldCaptureTouch?.() ?? false) && event.cancelable) {
            event.preventDefault();
          }
          state.lastY = currentY;
          return;
        }
      }

      event.preventDefault();

      if (!state.lastY) {
        state.lastY = currentY;
        return;
      }

      const deltaY = currentY - state.lastY;

      if (Math.abs(deltaY) > 1) {
        state.isCurrentlyScrolling = true;
        const scrollMultiplierAdjusted = scrollMultiplier +
          Math.min(maxScrollBoost, Math.abs(deltaY) / boostDenominator);
        const deltaPixels = -deltaY * scrollMultiplierAdjusted;
        accumulateAndRequestScroll(deltaPixels, currentX, currentY);
      }

      state.lastY = currentY;
    };

    const handleTouchEnd = (event: TouchEvent) => {
      const point = event.changedTouches?.[0];
      if (!point) return;

      const wasScrolling = state.isCurrentlyScrolling;
      state.isCurrentlyScrolling = false;

      const isScrolling = state.rafId !== null || rafIdRef.current !== null;
      if (!state.didMove && !isScrolling && onTap && state.startX !== null && state.startY !== null) {
        onTap(state.startX, state.startY);
      }
      if (!state.didMove && !isScrolling && onClickWithCoords && state.startX !== null && state.startY !== null) {
        onClickWithCoords(state.startX, state.startY);
      }

      state.startX = null;
      state.startY = null;

      const endedHorizontalGesture = state.gestureAxis === 'x';
      state.gestureAxis = null;

      if (enableKinetic && wasScrolling && !endedHorizontalGesture && state.didMove && Math.abs(state.velocity) > minVelocity) {
        const animate = () => {
          const dt = 16;
          state.velocity *= Math.pow(decelerationRate, dt);

          if (Math.abs(state.velocity) < minVelocity) {
            state.velocity = 0;
            stopKinetic();
            return;
          }

          const moved = scrollByPixels(-state.velocity * dt);
          if (!moved && consecutiveNoScrollRef.current > 2) {
            state.velocity = 0;
            stopKinetic();
            return;
          }

          state.rafId = requestAnimationFrame(animate);
        };

        state.rafId = requestAnimationFrame(animate);
      }
    };

    container.addEventListener('touchstart', handleTouchStart, { passive: false });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd as EventListener, { passive: false });
    container.addEventListener('touchcancel', handleTouchEnd as EventListener, { passive: false });

    const previousTouchAction = container.style.touchAction;
    container.style.touchAction = 'none';

    return () => {
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd as EventListener);
      container.removeEventListener('touchcancel', handleTouchEnd as EventListener);
      container.style.touchAction = previousTouchAction;
      stopKinetic();
    };
  }, [
    containerRef,
    scrollMultiplier,
    maxScrollBoost,
    boostDenominator,
    minVelocity,
    decelerationRate,
    stopKinetic,
    scrollByPixels,
    accumulateAndRequestScroll,
    onTap,
    onClickWithCoords,
    tapThreshold,
    shouldCaptureTouch,
    enableKinetic,
  ]);

  const setupTouchScroll = React.useCallback(() => {
    stopKinetic();

    const supportsPointerEvents = typeof window !== 'undefined' && 'PointerEvent' in window;
    const cleanupPointerEvents = supportsPointerEvents ? setupPointerEvents() : () => {};
    const cleanupTouchEvents = supportsPointerEvents ? () => {} : setupTouchEvents();

    return () => {
      cleanupPointerEvents();
      cleanupTouchEvents();
      stopKinetic();
    };
  }, [setupPointerEvents, setupTouchEvents, stopKinetic]);

  const isScrolling = React.useCallback(() => {
    return stateRef.current.isCurrentlyScrolling ||
           stateRef.current.rafId !== null ||
           rafIdRef.current !== null;
  }, []);

  const stopAllScroll = React.useCallback(() => {
    stopKinetic();
    const state = stateRef.current;
    state.isCurrentlyScrolling = false;
    state.velocity = 0;
    state.lastY = null;
    state.lastTime = null;
    state.startX = null;
    state.startY = null;
    state.pointerId = null;
    state.didMove = false;
    state.gestureAxis = null;
  }, [stopKinetic]);

  return {
    setupTouchScroll,
    isScrolling,
    stopAllScroll,
  };
};
