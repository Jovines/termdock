import React from 'react';

/**
 * 触摸滚动配置
 */
interface TouchScrollConfig {
  scrollMultiplier?: number;
  maxScrollBoost?: number;
  boostDenominator?: number;
  velocityAlpha?: number;
  maxVelocity?: number;
  minVelocity?: number;
  deceleration?: number;
  onScroll?: (deltaPixels: number) => boolean;
  onTap?: (x: number, y: number) => void;
  tapThreshold?: number;
}

/**
 * 触摸滚动状态
 */
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
}

/**
 * 自定义Hook：触摸滚动
 * 从TerminalViewport中提取的触摸滚动逻辑
 */
export const useTouchScroll = (
  containerRef: React.RefObject<HTMLElement>,
  config: TouchScrollConfig
) => {
  const {
    scrollMultiplier = 3.0,
    maxScrollBoost = 2.0,
    boostDenominator = 30,
    velocityAlpha = 0.18,
    maxVelocity = 15,
    minVelocity = 0.02,
    deceleration = 0.008,
    onScroll,
    onTap,
    tapThreshold = 12,
  } = config;

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
  });

  const consecutiveNoScrollRef = React.useRef(0);

  /**
   * 获取当前时间（高精度）
   */
  const nowMs = React.useCallback(() => {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }, []);

  /**
   * 滚动指定像素数
   */
  const scrollByPixels = React.useCallback((deltaPixels: number): boolean => {
    if (!deltaPixels || !onScroll) {
      return false;
    }

    const moved = onScroll(deltaPixels);
    
    // 跟踪连续无滚动次数
    if (!moved) {
      consecutiveNoScrollRef.current++;
    } else {
      consecutiveNoScrollRef.current = 0;
    }

    return moved;
  }, [onScroll]);

  /**
   * 停止惯性滚动
   */
  const stopKinetic = React.useCallback(() => {
    const state = stateRef.current;
    if (state.rafId !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(state.rafId);
    }
    state.rafId = null;
  }, []);

  /**
   * 处理指针事件（如果浏览器支持）
   */
  const setupPointerEvents = React.useCallback(() => {
    const container = containerRef.current;
    if (!container || !('PointerEvent' in window)) {
      return () => {};
    }

    const state = stateRef.current;
    const listenerOptions: AddEventListenerOptions = { passive: false, capture: false };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') {
        return;
      }

      state.pointerId = event.pointerId;
      state.startX = event.clientX;
      state.startY = event.clientY;
      state.didMove = false;
      state.lastY = event.clientY;
      state.lastTime = nowMs();
      stopKinetic();
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || state.pointerId !== event.pointerId) {
        return;
      }

      if (!state.lastY || !state.lastTime) {
        return;
      }

      const currentTime = nowMs();
      const deltaTime = currentTime - state.lastTime;
      const deltaY = event.clientY - state.lastY;

      // 计算速度（指数移动平均）
      const instantaneousVelocity = deltaY / Math.max(deltaTime, 1);
      state.velocity = state.velocity * (1 - velocityAlpha) + instantaneousVelocity * velocityAlpha;
      state.velocity = Math.max(-maxVelocity, Math.min(maxVelocity, state.velocity));

      // 检查是否超过移动阈值
      if (state.startX !== null && state.startY !== null && !state.didMove) {
        const dx = event.clientX - state.startX;
        const dy = event.clientY - state.startY;
        if (Math.hypot(dx, dy) >= tapThreshold) {
          state.didMove = true;
        }
      }

      // 应用滚动
      if (Math.abs(deltaY) > 0.5) {
        state.isCurrentlyScrolling = true;
        
        // 计算滚动乘数（速度越快，乘数越大）
        const scrollMultiplierAdjusted = scrollMultiplier + 
          Math.min(maxScrollBoost, Math.abs(deltaY) / boostDenominator);
        const deltaPixels = deltaY * scrollMultiplierAdjusted;
        
        scrollByPixels(deltaPixels);
      }

      state.lastY = event.clientY;
      state.lastTime = currentTime;
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || state.pointerId !== event.pointerId) {
        return;
      }

      state.isCurrentlyScrolling = false;

      if (!state.didMove && onTap && state.startX !== null && state.startY !== null) {
        onTap(state.startX, state.startY);
      }

      state.pointerId = null;
      state.startX = null;
      state.startY = null;

      // 开始惯性滚动
      if (Math.abs(state.velocity) > minVelocity && state.didMove) {
        const animate = () => {
          const currentTime = nowMs();
          const dt = currentTime - (state.lastTime || currentTime);
          state.lastTime = currentTime;

          // 应用减速
          state.velocity *= (1 - deceleration * dt);
          if (Math.abs(state.velocity) < minVelocity) {
            state.velocity = 0;
            stopKinetic();
            return;
          }

          const moved = scrollByPixels(state.velocity * dt);
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

    const handlePointerCancel = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || state.pointerId !== event.pointerId) {
        return;
      }

      state.isCurrentlyScrolling = false;
      state.pointerId = null;
      state.startX = null;
      state.startY = null;
      stopKinetic();
    };

    container.addEventListener('pointerdown', handlePointerDown, listenerOptions);
    container.addEventListener('pointermove', handlePointerMove, listenerOptions);
    container.addEventListener('pointerup', handlePointerUp, listenerOptions);
    container.addEventListener('pointercancel', handlePointerCancel, listenerOptions);

    // 保存原始touch-action样式
    const previousTouchAction = container.style.touchAction;
    container.style.touchAction = 'pan-y';

    return () => {
      container.removeEventListener('pointerdown', handlePointerDown, listenerOptions);
      container.removeEventListener('pointermove', handlePointerMove, listenerOptions);
      container.removeEventListener('pointerup', handlePointerUp, listenerOptions);
      container.removeEventListener('pointercancel', handlePointerCancel, listenerOptions);
      container.style.touchAction = previousTouchAction;
      stopKinetic();
    };
  }, [
    containerRef,
    scrollMultiplier,
    maxScrollBoost,
    boostDenominator,
    velocityAlpha,
    maxVelocity,
    minVelocity,
    deceleration,
    nowMs,
    stopKinetic,
    scrollByPixels,
    onTap,
    tapThreshold,
  ]);

  /**
   * 处理触摸事件（备用方案）
   */
  const setupTouchEvents = React.useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return () => {};
    }

    const state = stateRef.current;
    const listenerOptions: AddEventListenerOptions = { passive: false, capture: false };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        return;
      }

      state.isCurrentlyScrolling = false;
      state.lastY = event.touches[0].clientY;
      state.startX = event.touches[0].clientX;
      state.startY = event.touches[0].clientY;
      state.didMove = false;
      stopKinetic();
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        return;
      }

      const currentX = event.touches[0].clientX;
      const currentY = event.touches[0].clientY;

      // 检查是否超过移动阈值
      if (state.startX !== null && state.startY !== null && !state.didMove) {
        const dx = currentX - state.startX;
        const dy = currentY - state.startY;
        if (Math.hypot(dx, dy) >= tapThreshold) {
          state.didMove = true;
        }
      }

      if (!state.lastY) {
        state.lastY = currentY;
        return;
      }

      const deltaY = currentY - state.lastY;

      // 应用滚动
      if (Math.abs(deltaY) > 0.5) {
        state.isCurrentlyScrolling = true;
        
        // 计算滚动乘数
        const scrollMultiplierAdjusted = scrollMultiplier + 
          Math.min(maxScrollBoost, Math.abs(deltaY) / boostDenominator);
        const deltaPixels = deltaY * scrollMultiplierAdjusted;
        
        scrollByPixels(deltaPixels);
      }

      state.lastY = currentY;
    };

    const handleTouchEnd = (event: TouchEvent) => {
      const point = event.changedTouches?.[0];
      if (!point) {
        return;
      }

      state.isCurrentlyScrolling = false;

      if (!state.didMove && onTap && state.startX !== null && state.startY !== null) {
        onTap(state.startX, state.startY);
      }

      state.startX = null;
      state.startY = null;

      // 简单惯性滚动
      if (state.didMove && Math.abs(state.velocity) > minVelocity) {
        const animate = () => {
          const dt = 16; // 假设60fps
          state.velocity *= (1 - deceleration * dt);
          
          if (Math.abs(state.velocity) < minVelocity) {
            state.velocity = 0;
            stopKinetic();
            return;
          }

          const moved = scrollByPixels(state.velocity * dt);
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

    container.addEventListener('touchstart', handleTouchStart, listenerOptions);
    container.addEventListener('touchmove', handleTouchMove, listenerOptions);
    container.addEventListener('touchend', handleTouchEnd as EventListener, listenerOptions);
    container.addEventListener('touchcancel', handleTouchEnd as EventListener, listenerOptions);

    // 保存原始touch-action样式
    const previousTouchAction = container.style.touchAction;
    container.style.touchAction = 'pan-y';

    return () => {
      container.removeEventListener('touchstart', handleTouchStart, listenerOptions);
      container.removeEventListener('touchmove', handleTouchMove, listenerOptions);
      container.removeEventListener('touchend', handleTouchEnd as EventListener, listenerOptions);
      container.removeEventListener('touchcancel', handleTouchEnd as EventListener, listenerOptions);
      container.style.touchAction = previousTouchAction;
      stopKinetic();
    };
  }, [
    containerRef,
    scrollMultiplier,
    maxScrollBoost,
    boostDenominator,
    minVelocity,
    deceleration,
    stopKinetic,
    scrollByPixels,
    onTap,
    tapThreshold,
  ]);

  /**
   * 初始化触摸滚动
   */
  const setupTouchScroll = React.useCallback(() => {
    // 清理之前的监听器
    stopKinetic();

    // 尝试使用PointerEvents（更现代）
    const cleanupPointerEvents = setupPointerEvents();
    
    // 同时设置触摸事件作为备用
    const cleanupTouchEvents = setupTouchEvents();

    return () => {
      cleanupPointerEvents();
      cleanupTouchEvents();
      stopKinetic();
    };
  }, [setupPointerEvents, setupTouchEvents, stopKinetic]);

  /**
   * 检查当前是否正在滚动
   */
  const isScrolling = React.useCallback(() => {
    return stateRef.current.isCurrentlyScrolling || stateRef.current.rafId !== null;
  }, []);

  /**
   * 停止所有滚动
   */
  const stopAllScroll = React.useCallback(() => {
    stopKinetic();
    stateRef.current.isCurrentlyScrolling = false;
    stateRef.current.velocity = 0;
  }, [stopKinetic]);

  return {
    setupTouchScroll,
    isScrolling,
    stopAllScroll,
  };
};