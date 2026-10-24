// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../stores/useTerminalStore';
import { useTerminalOutputActivity } from './useTerminalOutputActivity';
const store = () => useTerminalStore.getState();
function bind(id: string, backend = id) { store().setTerminalSession(id, { sessionId: backend, cols: 80, rows: 24 }); }
beforeEach(() => { vi.useFakeTimers(); bind('a'); bind('b'); });
afterEach(() => { cleanup(); store().clearAllTerminalSessions(); vi.useRealTimers(); });
it('renders only server state; raw data, history and browser time cannot start or stop it', () => {
  const { result } = renderHook(() => useTerminalOutputActivity('a')); expect(result.current).toBe(false);
  act(() => { store().recordTerminalOutput('a'); store().appendToBuffer('a', 'data'); store().flushPendingBufferWrites('a'); }); expect(result.current).toBe(false);
  act(() => store().setTerminalOutputActivity('a', true)); expect(result.current).toBe(true);
  act(() => vi.advanceTimersByTime(60_000)); expect(result.current).toBe(true); expect(vi.getTimerCount()).toBe(0);
  act(() => store().setTerminalOutputActivity('a', false)); expect(result.current).toBe(false);
});
it('isolates sessions, backend replacement, disconnect and inactive view without timers', () => {
  const { result, rerender } = renderHook(({ id, enabled }) => useTerminalOutputActivity(id, enabled), { initialProps: { id: 'a', enabled: true } });
  act(() => store().setTerminalOutputActivity('a', true)); expect(result.current).toBe(true);
  rerender({ id: 'b', enabled: true }); expect(result.current).toBe(false);
  act(() => store().setTerminalOutputActivity('b', true)); expect(result.current).toBe(true);
  act(() => store().clearTerminalOutputActivity('b')); expect(result.current).toBe(false);
  act(() => store().setTerminalOutputActivity('b', true)); act(() => bind('b', 'new-backend')); expect(result.current).toBe(false);
  act(() => store().setTerminalOutputActivity('b', true)); rerender({ id: 'b', enabled: false }); expect(result.current).toBe(false);
  act(() => store().clearTerminalSession('b')); act(() => store().setTerminalOutputActivity('b', true)); rerender({ id: 'b', enabled: true }); expect(result.current).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
