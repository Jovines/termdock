// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { syncInitialViewportCssVars, useViewportHeight } from './useViewportHeight';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  document.documentElement.removeAttribute('style');
  delete document.documentElement.dataset.termdockTouchViewport;
  delete document.documentElement.dataset.termdockPwaStatusBar;
  delete document.documentElement.dataset.termdockNativeKeyboard;
  delete document.documentElement.dataset.termdockNativePan;
});

it('uses no top fallback with a native iPad status bar, while retaining a real inset on old installs', () => {
  vi.stubGlobal('innerHeight', 938);
  vi.stubGlobal('innerWidth', 1389);
  vi.stubGlobal('screen', { width: 1032, height: 1389 });
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
    platform: 'MacIntel', maxTouchPoints: 5, standalone: true,
  });
  document.documentElement.dataset.termdockPwaStatusBar = 'default';
  document.documentElement.style.setProperty('--safe-top-inset', 'env(safe-area-inset-top, 0px)');
  let rawTop = 0;
  vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({
    paddingTop: `${rawTop}px`, paddingRight: '0px', paddingBottom: '20px', paddingLeft: '0px',
  }) as CSSStyleDeclaration);
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const flush = () => act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(performance.now());
  });
  syncInitialViewportCssVars();
  renderHook(() => useViewportHeight());
  flush();
  expect(document.documentElement.style.getPropertyValue('--safe-top-inset')).toBe('0px');
  act(() => {
    rawTop = 32;
    window.dispatchEvent(new Event('resize'));
  });
  flush();
  expect(document.documentElement.style.getPropertyValue('--safe-top-inset')).toBe('32px');
});

it('reserves iPad PWA safe areas across rotation, keyboard movement and blur', () => {
  const viewport = Object.assign(new EventTarget(), { height: 820, width: 1180, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 820);
  vi.stubGlobal('innerWidth', 1180);
  vi.stubGlobal('screen', { width: 820, height: 1180 });
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
    platform: 'MacIntel', maxTouchPoints: 5, standalone: true,
  });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  let rawBottom = 0;
  vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({
    paddingTop: '0px', paddingRight: '0px', paddingBottom: `${rawBottom}px`, paddingLeft: '0px',
  }) as CSSStyleDeclaration);
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const flush = () => act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(performance.now());
  });
  syncInitialViewportCssVars();
  const style = document.documentElement.style;
  expect(document.documentElement.dataset.termdockTouchViewport).toBe('true');
  expect(style.getPropertyValue('--safe-top-inset')).toBe('20px');
  expect(style.getPropertyValue('--safe-bottom-inset')).toBe('20px');
  renderHook(() => useViewportHeight());
  flush();
  const input = document.createElement('textarea');
  document.body.append(input);
  input.focus();
  for (const [height, offsetTop] of [[480, 0], [480, 48], [520, 48], [820, 0]]) {
    act(() => {
      viewport.height = height;
      viewport.offsetTop = offsetTop;
      viewport.dispatchEvent(new Event('resize'));
    });
    flush();
    const inset = Math.max(0, 820 - height - 20);
    expect(style.getPropertyValue('--kb-height')).toBe(`${inset}px`);
    expect(820 - 20 - inset).toBeLessThanOrEqual(height);
  }
  // A stale visual measurement after keyboard dismissal cannot keep shifting
  // the touch toolbar when no editable element owns focus.
  act(() => {
    input.blur();
    viewport.height = 480;
    viewport.dispatchEvent(new Event('resize'));
  });
  flush();
  expect(style.getPropertyValue('--kb-height')).toBe('0px');
  act(() => {
    vi.stubGlobal('innerWidth', 820);
    vi.stubGlobal('innerHeight', 1180);
    viewport.width = 820;
    viewport.height = 1180;
    window.dispatchEvent(new Event('resize'));
  });
  flush();
  expect(style.getPropertyValue('--app-base-vh')).toBe('1180px');
  expect(style.getPropertyValue('--safe-bottom-inset')).toBe('20px');
  // Keep a real platform inset when it is larger than the fallback.
  act(() => {
    rawBottom = 34;
    window.dispatchEvent(new Event('resize'));
  });
  flush();
  expect(style.getPropertyValue('--safe-bottom-inset')).toBe('34px');
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

it('does not cache a native viewport pan as a new base height for subsequent keyboard openings', () => {
  const viewport = Object.assign(new EventTarget(), { height: 874, width: 402, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 874); vi.stubGlobal('innerWidth', 402);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const frames = new Map<number, FrameRequestCallback>(); let id = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key));
  const flush = () => act(() => {
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(callback => callback(performance.now()));
  });
  renderHook(() => useViewportHeight()); flush();
  const input = document.createElement('textarea'); document.body.append(input);
  // Native panning can make visualBottom close to the full height even while
  // both innerHeight and the visual viewport report the open keyboard.
  act(() => {
    input.focus(); vi.stubGlobal('innerHeight', 445);
    Object.assign(viewport, { height: 445, offsetTop: 367 });
    viewport.dispatchEvent(new Event('resize'));
  });
  flush();
  expect(document.documentElement.style.getPropertyValue('--app-base-vh')).toBe('874px');
  act(() => {
    input.blur(); vi.stubGlobal('innerHeight', 874);
    Object.assign(viewport, { height: 874, offsetTop: 44 });
    viewport.dispatchEvent(new Event('resize'));
  });
  flush();
  expect(document.documentElement.style.getPropertyValue('--app-base-vh')).toBe('874px');
  for (const offsetTop of [0, 44, 0]) {
    act(() => {
      input.focus(); vi.stubGlobal('innerHeight', 445);
      Object.assign(viewport, { height: 445, offsetTop });
      viewport.dispatchEvent(new Event('resize'));
    });
    flush();
    expect(document.documentElement.style.getPropertyValue('--app-base-vh')).toBe('874px');
    expect(document.documentElement.style.getPropertyValue('--kb-height')).toBe('429px');
  }
});

it('updates native compensation from actual page motion without a visual-height change', () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
  vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { height: 9999, offsetTop: 88 }));
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  let top = 0;
  vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => ({ top }) as DOMRect);
  const frames = new Map<number, FrameRequestCallback>(); let id = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key));
  const flush = () => act(() => {
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(callback => callback(performance.now()));
  });
  renderHook(() => useViewportHeight()); flush();
  for (const position of [-320, -414, 0]) {
    act(() => { top = position; window.dispatchEvent(new Event('scroll')); });
    flush();
    expect(document.documentElement.style.getPropertyValue('--app-native-pan')).toBe(`${-position || 0}px`);
    expect(document.documentElement.dataset.termdockNativePan).toBe(String(position < 0));
  }
});
