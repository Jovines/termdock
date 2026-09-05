// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useViewportHeight } from './useViewportHeight';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  document.documentElement.removeAttribute('style');
});

it('follows each viewport measurement and restores after rapid reversals without historical height or timers', () => {
  const viewport = Object.assign(new EventTarget(), { height: 852, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 852);
  vi.stubGlobal('innerWidth', 393);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const input = document.createElement('textarea');
  input.dataset.terminalInputAnchor = 'true';
  document.body.append(input);
  input.focus();
  renderHook(() => useViewportHeight());
  const flushFrame = () => act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(performance.now());
  });
  flushFrame();
  const timer = vi.spyOn(window, 'setTimeout');
  for (const height of [832, 516, 852, 560, 600, 516, 560, 832, 852]) {
    act(() => {
      viewport.height = height;
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    });
    expect(frames.size).toBe(1);
    flushFrame();
    expect(document.documentElement.style.getPropertyValue('--kb-height')).toBe(`${852 - height}px`);
    expect(document.documentElement.style.getPropertyValue('--app-visible-vh')).toBe(`${height}px`);
  }
  expect(timer).not.toHaveBeenCalled();
});
