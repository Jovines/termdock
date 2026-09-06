// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setTerminalOutputSubscription } from '../terminal/api';
import { useTerminalOutputSubscription } from './useTerminalOutputSubscription';

const BACKGROUND_OUTPUT_GRACE_MS = 15_000;

vi.mock('../terminal/api', () => ({ setTerminalOutputSubscription: vi.fn() }));
beforeEach(() => { vi.useFakeTimers(); vi.mocked(setTerminalOutputSubscription).mockClear(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function setup() {
  return renderHook(({ visible }) => (
    useTerminalOutputSubscription('phone', visible, true)
  ), { initialProps: { visible: true, layout: true } });
}

it('keeps the same subscribed stream during repeated short app switches', () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  const hook = setup();
  for (let i = 0; i < 2; i++) {
    hook.rerender({ visible: false, layout: true });
    act(() => { vi.advanceTimersByTime(2_000); });
    hook.rerender({ visible: true, layout: true });
  }
  act(() => { vi.advanceTimersByTime(BACKGROUND_OUTPUT_GRACE_MS); });
  expect(setTerminalOutputSubscription).not.toHaveBeenCalledWith('phone', false);
  hook.unmount();
});

it('retains the stream after a sustained background stay and on return', () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  const hook = setup();
  hook.rerender({ visible: false, layout: true });
  act(() => { vi.advanceTimersByTime(BACKGROUND_OUTPUT_GRACE_MS); });
  expect(setTerminalOutputSubscription).not.toHaveBeenCalledWith('phone', false);
  hook.rerender({ visible: true, layout: true });
  expect(setTerminalOutputSubscription).toHaveBeenLastCalledWith('phone', true);
  hook.unmount();
});

it('ignores a throttled background timer that runs before React processes foreground', () => {
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  const hook = setup();
  hook.rerender({ visible: false, layout: true });
  hidden.mockReturnValue(false);
  act(() => { vi.advanceTimersByTime(BACKGROUND_OUTPUT_GRACE_MS); });
  expect(setTerminalOutputSubscription).not.toHaveBeenCalledWith('phone', false);
  hook.unmount();
});

it('keeps warm offscreen slides subscribed across repeated session switches', () => {
  const hook = setup();
  for (let i = 0; i < 3; i++) {
    hook.rerender({ visible: true, layout: false });
    act(() => { vi.advanceTimersByTime(1_000); });
    hook.rerender({ visible: true, layout: true });
  }
  // Even a long visit to another session must not detach a retained viewport.
  hook.rerender({ visible: true, layout: false });
  act(() => { vi.advanceTimersByTime(BACKGROUND_OUTPUT_GRACE_MS * 2); });
  expect(setTerminalOutputSubscription).toHaveBeenCalledTimes(1);
  expect(setTerminalOutputSubscription).toHaveBeenLastCalledWith('phone', true);
  hook.unmount();
});

it('cancels pending app-background suspension when the viewport unmounts', () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  const hook = setup();
  hook.rerender({ visible: false, layout: true });
  hook.rerender({ visible: false, layout: false });
  expect(setTerminalOutputSubscription).toHaveBeenLastCalledWith('phone', true);
  hook.unmount();
  vi.mocked(setTerminalOutputSubscription).mockClear();
  act(() => { vi.advanceTimersByTime(BACKGROUND_OUTPUT_GRACE_MS); });
  expect(setTerminalOutputSubscription).not.toHaveBeenCalled();
});
