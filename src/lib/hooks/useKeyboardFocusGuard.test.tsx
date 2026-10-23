// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useKeyboardFocusGuard } from './useKeyboardFocusGuard';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren(); });
it('keeps the real editor focused and its draft/IME selection intact until the shared terminal layout settles', () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone'); vi.useFakeTimers();
  const frames = new Map<number, FrameRequestCallback>(); let id = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key));
  const flush = () => act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); });
  const input = document.createElement('textarea'); document.body.append(input); input.value = '中文草稿'; input.setSelectionRange(1, 3);
  const ref = { current: input };
  const { result, rerender, unmount } = renderHook(({ isOpen, isSettled }) => useKeyboardFocusGuard(ref, true, { isOpen, isSettled }), { initialProps: { isOpen: false, isSettled: false } });
  act(() => input.focus()); flush();
  expect(result.current).toBe(true); expect(input.style.opacity).toBe('0'); expect(document.activeElement).toBe(input);
  rerender({ isOpen: true, isSettled: false }); flush(); expect(input.style.opacity).toBe('0');
  rerender({ isOpen: true, isSettled: true }); flush(); flush();
  expect(result.current).toBe(false); expect(input.style.opacity).toBe('');
  expect(input.value).toBe('中文草稿'); expect(input.selectionStart).toBe(1); expect(input.selectionEnd).toBe(3);
  unmount(); expect(Object.hasOwn(input, 'focus')).toBe(false); expect(frames.size).toBe(0);
});

it('restores the editor if the keyboard never opens or the focus is cancelled', () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone'); vi.useFakeTimers();
  const input = document.createElement('textarea'); document.body.append(input);
  const ref = { current: input };
  const { result } = renderHook(() => useKeyboardFocusGuard(ref, true, { isOpen: false, isSettled: false }));
  act(() => input.focus()); expect(result.current).toBe(true);
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))); expect(result.current).toBe(false);
  act(() => { input.blur(); input.focus(); }); expect(result.current).toBe(true);
  act(() => vi.advanceTimersByTime(1200)); expect(result.current).toBe(false); expect(input.style.opacity).toBe('');
  act(() => { input.blur(); input.focus(); }); expect(result.current).toBe(true);
  act(() => input.blur()); expect(result.current).toBe(false);
});

it.each([['iPhone', false], ['Mozilla/5.0 (X11; Linux x86_64)', true]] as const)('leaves ordinary inputs alone (%s, enabled=%s)', (agent, enabled) => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(agent);
  const input = document.createElement('input'); document.body.append(input);
  const originalFocus = input.focus;
  const { result } = renderHook(() => useKeyboardFocusGuard({ current: input }, enabled, { isOpen: false, isSettled: false }));
  act(() => input.focus());
  expect(result.current).toBe(false);
  expect(input.focus).toBe(originalFocus);
  expect(input.style.opacity).toBe('');
  expect(document.activeElement).toBe(input);
});

it('restores existing input styles and its focus descriptor when disabled', () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
  const input = document.createElement('input'); document.body.append(input);
  input.style.opacity = '0.8'; input.style.transition = 'color 100ms';
  const focus = input.focus.bind(input);
  Object.defineProperty(input, 'focus', { configurable: true, writable: true, value: focus });
  const ref = { current: input };
  const { result, rerender } = renderHook(({ enabled }) => useKeyboardFocusGuard(ref, enabled, { isOpen: false, isSettled: false }), { initialProps: { enabled: true } });
  act(() => input.focus()); expect(result.current).toBe(true);
  rerender({ enabled: false });
  expect(result.current).toBe(false);
  expect(input.style.opacity).toBe('0.8');
  expect(input.style.transition).toBe('color 100ms');
  expect(input.focus).toBe(focus);
});
