// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../stores/useTerminalStore';
import { useTerminalOutputActivity } from './useTerminalOutputActivity';
const store = () => useTerminalStore.getState();
function bind(id: string, backend = id) { store().setTerminalSession(id, { sessionId: backend, cols: 80, rows: 24 }); }
function output(id: string) { act(() => { store().recordTerminalOutput(id); store().flushPendingBufferWrites(id); }); }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible'); bind('a'); bind('b'); });
afterEach(() => { cleanup(); store().clearAllTerminalSessions(); vi.restoreAllMocks(); vi.useRealTimers(); });
it('expires after five seconds of silence and extends on continued output without a timer per packet', () => {
  const { result, unmount } = renderHook(() => useTerminalOutputActivity('a'));
  expect(result.current).toBe(false); output('a'); expect(result.current).toBe(true);
  act(() => vi.advanceTimersByTime(4999)); expect(result.current).toBe(true);
  output('a'); expect(vi.getTimerCount()).toBe(1);
  act(() => vi.advanceTimersByTime(1)); expect(result.current).toBe(true);
  act(() => vi.advanceTimersByTime(4999)); expect(result.current).toBe(false);
  output('a'); expect(result.current).toBe(true);
  unmount(); expect(vi.getTimerCount()).toBe(0);
});
it('isolates sessions, backend replacement, disconnect and pending receipt batches', () => {
  const { result, rerender } = renderHook(({ id, enabled }) => useTerminalOutputActivity(id, enabled), { initialProps: { id: 'a', enabled: true } });
  output('a'); rerender({ id: 'b', enabled: true }); expect(result.current).toBe(false);
  output('b'); expect(result.current).toBe(true);
  act(() => { store().recordTerminalOutput('b'); store().clearTerminalOutputActivity('b'); store().flushPendingBufferWrites('b'); });
  expect(result.current).toBe(false);
  output('b'); act(() => bind('b', 'new-backend')); expect(result.current).toBe(false);
  output('b'); rerender({ id: 'b', enabled: false }); expect(result.current).toBe(false); expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(6000)); rerender({ id: 'b', enabled: true }); expect(result.current).toBe(false);
});
it('does not mistake history, screen sync, delayed renderer work or future timestamps for current output', () => {
  const { result } = renderHook(() => useTerminalOutputActivity('a'));
  act(() => { store().appendToBuffer('a', 'history', { markActivity: false }); store().flushPendingBufferWrites('a'); store().replaceBuffer('a', ['screen']); });
  expect(result.current).toBe(false);
  // A throttled/background rAF may flush long after the bytes actually arrived.
  store().recordTerminalOutput('a'); vi.setSystemTime(106_000);
  act(() => store().flushPendingBufferWrites('a')); expect(result.current).toBe(false);
  expect(store().sessions.get('a')?.lastOutputAt).toBe(100_000);
  output('a'); expect(result.current).toBe(true);
  act(() => { vi.setSystemTime(105_000); store().replaceBuffer('a', ['sync']); document.dispatchEvent(new Event('visibilitychange')); }); expect(result.current).toBe(false);
});
it('hides on document suspension and does not flash stale activity on return', () => {
  const { result } = renderHook(() => useTerminalOutputActivity('a')); output('a');
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange'))); expect(result.current).toBe(false); expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(6000));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  act(() => document.dispatchEvent(new Event('visibilitychange'))); expect(result.current).toBe(false);
  output('a'); expect(result.current).toBe(true);
});
