// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useInputViewportDiagnostics } from './useInputViewportDiagnostics';
import { VIEWPORT_LAYOUT_CHANGE_EVENT } from './useViewportHeight';
import { clientLog } from '../utils/clientLog';

vi.mock('../utils/clientLog', () => ({ clientLog: vi.fn() }));
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers();
  document.body.replaceChildren();
});

it('records bounded numeric evidence across focus sessions without changing the editor or logging text', () => {
  vi.useFakeTimers(); vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
  const input = document.createElement('textarea'); input.value = 'private draft'; document.body.append(input);
  const focus = input.focus, ref = { current: input };
  const { unmount } = renderHook(() => useInputViewportDiagnostics(ref, true));
  act(() => input.focus());
  expect(clientLog).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 20; i++) {
    act(() => {
      document.dispatchEvent(new CustomEvent(VIEWPORT_LAYOUT_CHANGE_EVENT));
      vi.advanceTimersByTime(250);
    });
  }
  expect(clientLog).toHaveBeenCalledTimes(3);
  expect(input.focus).toBe(focus); expect(input.value).toBe('private draft');
  expect(input.getAttribute('style')).toBeNull();
  expect(JSON.stringify(vi.mocked(clientLog).mock.calls)).not.toContain('private draft');
  act(() => { input.blur(); input.focus(); });
  expect(clientLog).toHaveBeenCalledTimes(4);
  expect(vi.mocked(clientLog).mock.lastCall?.[2]).toMatchObject({ sequence: 2, sample: 1 });
  unmount();
  act(() => { vi.advanceTimersByTime(1000); input.blur(); input.focus(); });
  expect(clientLog).toHaveBeenCalledTimes(4);
});

it.each([['iPhone', false], ['Linux', true]] as const)('does not collect outside active iOS editors (%s, %s)', (agent, enabled) => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(agent);
  const input = document.createElement('textarea'); document.body.append(input);
  renderHook(() => useInputViewportDiagnostics({ current: input }, enabled));
  act(() => input.focus());
  expect(clientLog).not.toHaveBeenCalled();
});
