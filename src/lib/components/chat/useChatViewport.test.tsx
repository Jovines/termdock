// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { syncInitialViewportCssVars, useViewportHeight } from '../../hooks/useViewportHeight';
import { useChatViewport } from './useChatViewport';
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); document.documentElement.removeAttribute('style'); delete document.documentElement.dataset.termdockTouchViewport; });
it('uses the application viewport measurements through keyboard animation, panning, and repeated reversals without forcing page scroll', () => {
  const viewport = Object.assign(new EventTarget(), { height: 844, width: 390, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport); vi.stubGlobal('innerHeight', 844); vi.stubGlobal('innerWidth', 390);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const flush = () => act(() => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(performance.now()); });
  const scrollTo = vi.fn(); vi.stubGlobal('scrollTo', scrollTo);
  syncInitialViewportCssVars();
  const root = document.documentElement;
  const { result, rerender } = renderHook(({ active }) => { useViewportHeight(); return useChatViewport(active); }, { initialProps: { active: true } });
  flush(); expect(result.current).toBe(false);
  const input = document.createElement('textarea'); document.body.append(input); input.focus();
  for (const [height, offsetTop] of [[680, 120], [470, 250], [470, 0], [844, 0], [460, 220], [460, 0], [844, 0]]) {
    act(() => { viewport.height = height; viewport.offsetTop = offsetTop; viewport.dispatchEvent(new Event('resize')); }); flush();
    expect(root.style.getPropertyValue('--app-visual-vh')).toBe(`${height}px`);
    expect(root.style.getPropertyValue('--app-vv-offset-top')).toBe(`${offsetTop}px`);
    expect(result.current).toBe(844 - height >= 80);
  }
  expect(scrollTo).not.toHaveBeenCalled();
  rerender({ active: false }); expect(root.dataset.termdockChatViewport).toBeUndefined();
  // Leaving chat releases layout ownership without deleting the shared viewport measurements.
  expect(root.style.getPropertyValue('--app-visual-vh')).toBe('844px');
});
