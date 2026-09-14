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

it.each([0, 34])('keeps the toolbar above the keyboard during iOS viewport panning (safe bottom %i)', (safeBottom) => {
  const viewport = Object.assign(new EventTarget(), { height: 852, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 852);
  vi.stubGlobal('innerWidth', 393);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    paddingTop: '0px', paddingRight: '0px', paddingBottom: `${safeBottom}px`, paddingLeft: '0px',
  } as CSSStyleDeclaration);
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const input = document.createElement('textarea');
  document.body.append(input);
  input.focus();
  renderHook(() => useViewportHeight());
  const flushFrame = () => act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(performance.now());
  });
  flushFrame();
  // Resize and scroll can arrive separately as the system input accessory
  // appears, the input method changes, and Safari pans the focused textarea.
  for (const [height, offsetTop] of [[516, 0], [516, 48], [560, 48], [560, 120], [516, 0], [852, 0]]) {
    act(() => {
      viewport.height = height;
      viewport.offsetTop = offsetTop;
      viewport.dispatchEvent(new Event('scroll'));
      viewport.dispatchEvent(new Event('resize'));
    });
    flushFrame();
    const expectedInset = Math.max(0, 852 - height - safeBottom);
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--kb-height')).toBe(`${expectedInset}px`);
    expect(style.getPropertyValue('--kb-translate-y')).toBe(`${-expectedInset}px`);
    expect(style.getPropertyValue('--kb-margin-top')).toBe(`${expectedInset}px`);
    // The fixed root already reserves the bottom safe area.
    const toolbarBottom = 852 - safeBottom - expectedInset;
    expect(toolbarBottom).toBeLessThanOrEqual(height);
  }
});

it('repairs a silent post-animation iOS measurement without continuously refitting the terminal', () => {
  const viewport = Object.assign(new EventTarget(), { height: 852, width: 393, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 852);
  vi.stubGlobal('innerWidth', 393);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const input = document.createElement('textarea');
  document.body.append(input);
  input.focus();
  const layout = vi.fn();
  document.addEventListener('termdock:viewport-layout-change', layout);
  const { unmount } = renderHook(() => useViewportHeight());
  const flush = (at: number) => act(() => {
    now = at;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(now);
  });
  flush(0);
  act(() => {
    viewport.height = 516;
    viewport.dispatchEvent(new Event('resize'));
  });
  flush(16);
  expect(document.documentElement.style.getPropertyValue('--kb-height')).toBe('336px');
  const calls = layout.mock.calls.length;
  flush(100);
  expect(layout).toHaveBeenCalledTimes(calls);
  // The system accessory settles after the last resize callback; no event.
  viewport.height = 456;
  flush(400);
  expect(document.documentElement.style.getPropertyValue('--kb-height')).toBe('396px');
  expect(layout).toHaveBeenCalledTimes(calls + 1);
  // Switching to a shorter keyboard must still release the extra space.
  viewport.height = 560;
  flush(600);
  expect(document.documentElement.style.getPropertyValue('--kb-height')).toBe('292px');
  flush(1600);
  expect(frames.size).toBe(0);
  act(() => { viewport.dispatchEvent(new Event('resize')); });
  expect(frames.size).toBe(1);
  unmount();
  expect(frames.size).toBe(0);
  document.removeEventListener('termdock:viewport-layout-change', layout);
});
