import { viewportWindow } from '../services/workspaceViewport';
import React from 'react';
import { createDebugLogger } from '../utils/debug';

interface UseViewportHeightOptions {
  cssVarName?: string;
}

const KEYBOARD_OPEN_THRESHOLD_PX = 80;
const BASE_WIDTH_CHANGE_THRESHOLD_PX = 60;
const KEYBOARD_CHANGE_EVENT = 'termdock:viewport-keyboard-change';
export const VIEWPORT_LAYOUT_CHANGE_EVENT = 'termdock:viewport-layout-change';
const MIN_BOOTSTRAP_VIEWPORT_HEIGHT_PX = 240;
const DEFAULT_BOOTSTRAP_VIEWPORT_HEIGHT_PX = 640;
const DEFAULT_BOOTSTRAP_VIEWPORT_WIDTH_PX = 360;

interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface ViewportKeyboardInsetInput {
  measuredHeight: number;
  documentVisible: boolean;
  editableFocused: boolean;
}

export function shouldApplyViewportKeyboardInset({
  measuredHeight,
  documentVisible,
  editableFocused,
}: ViewportKeyboardInsetInput): boolean {
  // Layout follows the measured occlusion from its first pixel. The separate
  // keyboard-open threshold is only for interaction state, never geometry.
  return documentVisible && editableFocused && measuredHeight > 0;
}

export function hasFocusedEditableElement(): boolean {
  if (typeof document === 'undefined') return false;
  const activeElement = document.activeElement;
  return activeElement instanceof HTMLElement && activeElement.matches(
    'input:not([type="hidden"]), textarea, select, [contenteditable]:not([contenteditable="false"])'
  );
}

declare global {
  interface DocumentEventMap {
    [KEYBOARD_CHANGE_EVENT]: CustomEvent<ViewportKeyboardChangeDetail>;
    [VIEWPORT_LAYOUT_CHANGE_EVENT]: CustomEvent<ViewportLayoutChangeDetail>;
  }
}

export interface ViewportKeyboardChangeDetail {
  baseHeight: number;
  visibleHeight: number;
  visualViewportHeight: number;
  offsetTop: number;
  keyboardHeight: number;
  isOpen: boolean;
  source: string;
}

export interface ViewportLayoutChangeDetail {
  height: number;
  baseHeight: number;
  visibleHeight: number;
  offsetTop: number;
  source: string;
}

const toPositivePx = (value: unknown): number => {
  const parsed = typeof value === 'number'
    ? value
    : Number.parseFloat(typeof value === 'string' ? value : '0');
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
};

const firstUsableDimension = (values: unknown[], fallback: number): number => {
  const positive = values.map(toPositivePx).filter((value) => value > 0);
  return positive.find((value) => value >= MIN_BOOTSTRAP_VIEWPORT_HEIGHT_PX)
    ?? positive[0]
    ?? fallback;
};

const getBestKnownViewportHeight = (): number => {
  if (typeof window === 'undefined') return DEFAULT_BOOTSTRAP_VIEWPORT_HEIGHT_PX;
  return firstUsableDimension([
    viewportWindow().innerHeight,
    document.documentElement?.clientHeight,
    document.body?.clientHeight,
    viewportWindow().visualViewport?.height,
    window.screen?.availHeight,
    window.screen?.height,
  ], DEFAULT_BOOTSTRAP_VIEWPORT_HEIGHT_PX);
};

const getBestKnownViewportWidth = (): number => {
  if (typeof window === 'undefined') return DEFAULT_BOOTSTRAP_VIEWPORT_WIDTH_PX;
  return firstUsableDimension([
    viewportWindow().innerWidth,
    document.documentElement?.clientWidth,
    document.body?.clientWidth,
    viewportWindow().visualViewport?.width,
    window.screen?.availWidth,
    window.screen?.width,
  ], DEFAULT_BOOTSTRAP_VIEWPORT_WIDTH_PX);
};

const toPx = (value: string | null | undefined) => {
  const parsed = Number.parseFloat(value || '0');
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
};

const isIOSLike = () => {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
};

const isStandaloneDisplay = () => {
  if (typeof window === 'undefined') return false;
  const navigatorWithStandalone = viewportWindow().navigator as Navigator & { standalone?: boolean };
  return navigatorWithStandalone.standalone === true ||
    viewportWindow().matchMedia?.('(display-mode: standalone)').matches === true;
};

const getIOSStandaloneSafeAreaFallback = (): SafeAreaInsets => {
  if (typeof window === 'undefined' || !isIOSLike() || !isStandaloneDisplay()) {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }

  const portrait = getBestKnownViewportHeight() >= getBestKnownViewportWidth();
  if (!portrait) {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }

  const screenWidth = window.screen?.width || window.innerWidth;
  const screenHeight = window.screen?.height || window.innerHeight;
  const logicalWidth = Math.min(screenWidth, screenHeight);
  const logicalHeight = Math.max(screenWidth, screenHeight);

  if (logicalWidth >= 700) {
    return { top: 20, right: 0, bottom: 20, left: 0 };
  }

  if (logicalHeight < 780) {
    return { top: 20, right: 0, bottom: 0, left: 0 };
  }

  const top = logicalHeight >= 852
    ? 59
    : logicalHeight >= 844
      ? 47
      : 44;
  return { top, right: 0, bottom: 34, left: 0 };
};

export function syncInitialViewportCssVars(cssVarName = '--app-vh'): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const visualViewportHeight = toPositivePx(viewportWindow().visualViewport?.height);
  const visualViewportOffsetTop = Math.max(0, Math.round(viewportWindow().visualViewport?.offsetTop ?? 0));
  const layoutHeight = getBestKnownViewportHeight();
  const visualViewportHeightUsable = visualViewportHeight >= MIN_BOOTSTRAP_VIEWPORT_HEIGHT_PX;
  const visibleHeight = visualViewportHeightUsable
    ? Math.min(layoutHeight, visualViewportHeight + visualViewportOffsetTop)
    : layoutHeight;
  const baseHeight = Math.max(layoutHeight, visibleHeight);
  const style = document.documentElement.style;

  style.setProperty(cssVarName, `${Math.max(visibleHeight, MIN_BOOTSTRAP_VIEWPORT_HEIGHT_PX)}px`);
  style.setProperty('--app-base-vh', `${Math.max(baseHeight, MIN_BOOTSTRAP_VIEWPORT_HEIGHT_PX)}px`);
  style.setProperty('--app-visible-vh', `${Math.max(visibleHeight, MIN_BOOTSTRAP_VIEWPORT_HEIGHT_PX)}px`);
  style.setProperty('--app-vv-offset-top', `${visualViewportOffsetTop}px`);
  style.setProperty('--kb-translate-y', '0px');
  style.setProperty('--kb-margin-top', '0px');
  style.setProperty('--kb-height', '0px');

  const safeAreaFallback = getIOSStandaloneSafeAreaFallback();
  if (safeAreaFallback.top > 0) style.setProperty('--safe-top-inset', `${safeAreaFallback.top}px`);
  if (safeAreaFallback.right > 0) style.setProperty('--safe-right-inset', `${safeAreaFallback.right}px`);
  if (safeAreaFallback.bottom > 0) style.setProperty('--safe-bottom-inset', `${safeAreaFallback.bottom}px`);
  if (safeAreaFallback.left > 0) style.setProperty('--safe-left-inset', `${safeAreaFallback.left}px`);
}

export function useViewportHeight(options: UseViewportHeightOptions = {}): number {
  const { cssVarName = '--app-vh' } = options;
  const debugViewport = React.useMemo(() => createDebugLogger('viewport'), []);

  const getViewportHeight = React.useCallback(() => {
    if (typeof window === 'undefined') {
      return 0;
    }

    const visualViewport = viewportWindow().visualViewport;
    const windowHeight = getBestKnownViewportHeight();
    if (!visualViewport) {
      return windowHeight;
    }

    const viewportHeight = toPositivePx(visualViewport.height);
    if (viewportHeight < MIN_BOOTSTRAP_VIEWPORT_HEIGHT_PX && windowHeight >= MIN_BOOTSTRAP_VIEWPORT_HEIGHT_PX) {
      return windowHeight;
    }
    const viewportOffsetTop = visualViewport.offsetTop;

    // iOS can report transient offsetTop while the keyboard animates.
    // Small offset values are usually browser-chrome shift and should be compensated.
    // Large offset values are often page pan; compensating those can cancel keyboard shrink.
    const canCompensateOffsetTop =
      viewportHeight < windowHeight - 1 &&
      viewportOffsetTop > 0 &&
      viewportOffsetTop <= 96;

    const effectiveHeight = canCompensateOffsetTop
      ? viewportHeight + viewportOffsetTop
      : viewportHeight;
    const clampedHeight = Math.max(0, Math.min(windowHeight, effectiveHeight));
    return clampedHeight > 0 ? Math.round(clampedHeight) : windowHeight;
  }, []);

  const [viewportHeight, setViewportHeight] = React.useState(getViewportHeight);
  const baseHeightRef = React.useRef(0);
  const lastWidthRef = React.useRef(0);
  const lastKeyboardHeightRef = React.useRef(0);
  const lastKeyboardOpenRef = React.useRef(false);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    let rafId: number | null = null;
    let safeAreaProbe: HTMLDivElement | null = null;
    const ensureSafeAreaProbe = () => {
      if (safeAreaProbe?.isConnected) return safeAreaProbe;

      try {
        safeAreaProbe = document.createElement('div');
        safeAreaProbe.setAttribute('aria-hidden', 'true');
        safeAreaProbe.style.cssText = [
          'position:fixed',
          'top:0',
          'left:0',
          'width:0',
          'height:0',
          'visibility:hidden',
          'pointer-events:none',
          'padding-top:constant(safe-area-inset-top)',
          'padding-top:env(safe-area-inset-top,0px)',
          'padding-right:constant(safe-area-inset-right)',
          'padding-right:env(safe-area-inset-right,0px)',
          'padding-bottom:constant(safe-area-inset-bottom)',
          'padding-bottom:env(safe-area-inset-bottom,0px)',
          'padding-left:constant(safe-area-inset-left)',
          'padding-left:env(safe-area-inset-left,0px)',
        ].join(';');
        (document.body || document.documentElement).appendChild(safeAreaProbe);
        return safeAreaProbe;
      } catch { /* ignore */ }
      return null;
    };

    const syncSafeAreaInsets = (): SafeAreaInsets => {
      let raw: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

      try {
        const probe = ensureSafeAreaProbe();
        if (probe) {
          const style = getComputedStyle(probe);
          raw = {
            top: toPx(style.paddingTop),
            right: toPx(style.paddingRight),
            bottom: toPx(style.paddingBottom),
            left: toPx(style.paddingLeft),
          };
        }
      } catch { /* ignore */ }

      const owner = viewportWindow();
      if (owner !== window) {
        const style = owner.getComputedStyle(owner.document.documentElement);
        raw = {
          top: Math.max(raw.top, toPx(style.getPropertyValue('--safe-top-inset'))),
          right: Math.max(raw.right, toPx(style.getPropertyValue('--safe-right-inset'))),
          bottom: Math.max(raw.bottom, toPx(style.getPropertyValue('--safe-bottom-inset'))),
          left: Math.max(raw.left, toPx(style.getPropertyValue('--safe-left-inset'))),
        };
      }
      const fallback = getIOSStandaloneSafeAreaFallback();
      const insets = {
        top: Math.max(raw.top, fallback.top),
        right: Math.max(raw.right, fallback.right),
        bottom: Math.max(raw.bottom, fallback.bottom),
        left: Math.max(raw.left, fallback.left),
      };

      document.documentElement.style.setProperty('--safe-top-inset', `${insets.top}px`);
      document.documentElement.style.setProperty('--safe-right-inset', `${insets.right}px`);
      document.documentElement.style.setProperty('--safe-bottom-inset', `${insets.bottom}px`);
      document.documentElement.style.setProperty('--safe-left-inset', `${insets.left}px`);
      return insets;
    };

    const updateBaseHeight = (
      currentWidth: number,
      currentInnerHeight: number,
      currentVisualBottom: number,
      previousKeyboardHeight: number,
    ) => {
      const candidateBaseHeight = Math.max(currentInnerHeight, currentVisualBottom);
      if (baseHeightRef.current === 0) {
        baseHeightRef.current = candidateBaseHeight;
        lastWidthRef.current = currentWidth;
        document.documentElement.style.setProperty('--app-base-vh', `${candidateBaseHeight}px`);
        return;
      }

      const widthDelta = Math.abs(currentWidth - lastWidthRef.current);
      const keyboardLikelyClosed = previousKeyboardHeight <= KEYBOARD_OPEN_THRESHOLD_PX;
      if (widthDelta > BASE_WIDTH_CHANGE_THRESHOLD_PX || keyboardLikelyClosed) {
        baseHeightRef.current = candidateBaseHeight;
        lastWidthRef.current = currentWidth;
        document.documentElement.style.setProperty('--app-base-vh', `${candidateBaseHeight}px`);
      }
    };

    const syncViewportHeight = (source = 'event') => {
      rafId = null;
      const nextHeight = getViewportHeight();
      const nextOffsetTop = Math.round(viewportWindow().visualViewport?.offsetTop ?? 0);
      const measuredViewportHeight = toPositivePx(viewportWindow().visualViewport?.height);
      const rawViewportHeight = measuredViewportHeight >= MIN_BOOTSTRAP_VIEWPORT_HEIGHT_PX
        ? measuredViewportHeight
        : nextHeight;
      const innerHeight = getBestKnownViewportHeight();
      const currentWidth = getBestKnownViewportWidth();
      const visualBottom = Math.max(0, rawViewportHeight + nextOffsetTop);
      const safeAreaInsets = syncSafeAreaInsets();
      const safeBottom = safeAreaInsets.bottom;
      const previousKeyboardHeight = Math.max(0, baseHeightRef.current - visualBottom - safeBottom);

      updateBaseHeight(currentWidth, innerHeight, visualBottom, previousKeyboardHeight);

      setViewportHeight((current) => (current === nextHeight ? current : nextHeight));

      const prevApplied = Number.parseInt(
        document.documentElement.style.getPropertyValue(cssVarName) || '0',
        10
      );

      document.documentElement.style.setProperty(cssVarName, `${nextHeight}px`);
      document.documentElement.style.setProperty('--app-vv-offset-top', `${nextOffsetTop}px`);

      // Pre-compute keyboard translateY and marginTop so CSS can reference
      // plain px values (avoids Safari bugs with min()/calc()/env() nested
      // inside transform).
      const baseVh = baseHeightRef.current;
      // Keyboard movement must be based on the actual visual viewport height.
      // `nextHeight` may include a small offsetTop compensation for Safari
      // browser-chrome jitter; using that compensated value here makes the
      // terminal under-translate by exactly that intermittent offsetTop.
      const keyboardViewportHeight = Math.min(nextHeight, rawViewportHeight);
      const visibleHeight = Math.max(0, Math.min(baseVh, visualBottom));
      const measuredKeyboardHeight = Math.max(0, Math.round(baseVh - visibleHeight - safeBottom));
      const editableFocused = hasFocusedEditableElement();
      const applyKeyboardInset = shouldApplyViewportKeyboardInset({
        measuredHeight: measuredKeyboardHeight,
        documentVisible: document.visibilityState === 'visible',
        editableFocused,
      });
      const keyboardHeight = applyKeyboardInset ? measuredKeyboardHeight : 0;
      const isKeyboardOpen = keyboardHeight >= KEYBOARD_OPEN_THRESHOLD_PX;

      const ty = -keyboardHeight;
      const mt = keyboardHeight;
      document.documentElement.style.setProperty('--kb-translate-y', `${ty}px`);
      document.documentElement.style.setProperty('--kb-margin-top', `${mt}px`);
      document.documentElement.style.setProperty('--kb-height', `${keyboardHeight}px`);
      document.documentElement.style.setProperty('--app-visible-vh', `${visibleHeight}px`);

      const keyboardHeightChanged = Math.abs(keyboardHeight - lastKeyboardHeightRef.current) > 1;
      const keyboardOpenChanged = isKeyboardOpen !== lastKeyboardOpenRef.current;
      if (keyboardHeightChanged || keyboardOpenChanged) {
        lastKeyboardHeightRef.current = keyboardHeight;
        lastKeyboardOpenRef.current = isKeyboardOpen;
        document.dispatchEvent(new CustomEvent<ViewportKeyboardChangeDetail>(KEYBOARD_CHANGE_EVENT, {
          detail: {
            baseHeight: baseVh,
            visibleHeight,
            visualViewportHeight: rawViewportHeight,
            offsetTop: nextOffsetTop,
            keyboardHeight,
            isOpen: isKeyboardOpen,
            source,
          },
        }));
      }

      const previousHeight = prevApplied;
      if (previousHeight !== nextHeight || nextOffsetTop > 0 || keyboardHeightChanged || keyboardOpenChanged) {
        debugViewport('sync', {
          cssVarName,
          innerHeight,
          baseHeight: baseVh,
          rawViewportHeight,
          offsetTop: nextOffsetTop,
          visibleHeight,
          rawHeight: nextHeight,
          appliedHeight: nextHeight,
          keyboardViewportHeight,
          measuredKeyboardHeight,
          editableFocused,
          applyKeyboardInset,
          keyboardHeight,
          isKeyboardOpen,
          safeAreaInsets,
          source,
        });
      }

      // CSS custom-property changes do not produce a browser resize event.
      // Notify layout managers after every measured pass so cold-start
      // settling can repair Swiper geometry even when visualViewport silently
      // changes after pageshow but emits no resize of its own.
      document.dispatchEvent(new CustomEvent<ViewportLayoutChangeDetail>(VIEWPORT_LAYOUT_CHANGE_EVENT, {
        detail: {
          height: nextHeight,
          baseHeight: baseVh,
          visibleHeight,
          offsetTop: nextOffsetTop,
          source,
        },
      }));
    };

    const scheduleSync = (source = 'event') => {
      if (source.includes('visibilitychange') || source.includes('pageshow')) {
        debugViewport('schedule', { source });
      }
      if (rafId !== null) {
        return;
      }
      rafId = window.requestAnimationFrame(() => syncViewportHeight(source));
    };

    // Read at mount and on actual viewport/focus/lifecycle events. There is
    // no elapsed-time assumption about when the browser has settled.
    scheduleSync('mount');

    const handleResize = () => scheduleSync('resize');
    const handleOrientationChange = () => scheduleSync('orientationchange');
    const handleVisualViewportResize = () => scheduleSync('visualViewport.resize');
    const handleVisualViewportScroll = () => scheduleSync('visualViewport.scroll');
    const handleFocusIn = () => scheduleSync('focusin');
    const handleFocusOut = () => scheduleSync('focusout');

    const resetKeyboardSession = (source: string) => {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && hasFocusedEditableElement()) {
        activeElement.blur();
      }

      lastKeyboardHeightRef.current = 0;
      lastKeyboardOpenRef.current = false;

      const baseHeight = Math.max(
        baseHeightRef.current,
        getBestKnownViewportHeight(),
        MIN_BOOTSTRAP_VIEWPORT_HEIGHT_PX,
      );
      const style = document.documentElement.style;
      style.setProperty(cssVarName, `${baseHeight}px`);
      style.setProperty('--app-visible-vh', `${baseHeight}px`);
      style.setProperty('--app-vv-offset-top', '0px');
      style.setProperty('--kb-translate-y', '0px');
      style.setProperty('--kb-margin-top', '0px');
      style.setProperty('--kb-height', '0px');
      setViewportHeight((current) => current === baseHeight ? current : baseHeight);
      debugViewport('keyboard session reset', { source, baseHeight });
    };

    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleOrientationChange);
    viewportWindow().visualViewport?.addEventListener('resize', handleVisualViewportResize);
    viewportWindow().visualViewport?.addEventListener('scroll', handleVisualViewportScroll);
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);

    // 从后台返回时，visualViewport.height 可能还是"软键盘打开"时的旧值，
    // 而 resize 事件不会 fire（值未变），导致 --app-vh 维持半高，xterm fit
    // 出半行数，屏幕就只显示一半内容。visibilitychange + pageshow 都要监听：
    //   - visibilitychange：标签页从 hidden 变 visible
    //   - pageshow：从 BFCache 恢复（persisted=true 时更明显）
    const handleResume = (source: string) => {
      debugViewport('resume', {
        source,
        innerHeight: Math.round(window.innerHeight),
        visualViewport: viewportWindow().visualViewport
          ? {
              width: Math.round(viewportWindow().visualViewport!.width),
              height: Math.round(viewportWindow().visualViewport!.height),
              offsetTop: Math.round(viewportWindow().visualViewport!.offsetTop),
            }
          : null,
        hidden: document.hidden,
      });
      scheduleSync(source);
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        resetKeyboardSession('visibilitychange:hidden');
      } else {
        handleResume('visibilitychange');
      }
    };
    const handlePageShow = () => handleResume('pageshow');
    const handlePageHide = () => resetKeyboardSession('pagehide');
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('pagehide', handlePageHide);

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleOrientationChange);
      viewportWindow().visualViewport?.removeEventListener('resize', handleVisualViewportResize);
      viewportWindow().visualViewport?.removeEventListener('scroll', handleVisualViewportScroll);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('pagehide', handlePageHide);

      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      safeAreaProbe?.remove();
    };
  }, [cssVarName, debugViewport, getViewportHeight]);

  return viewportHeight;
}
