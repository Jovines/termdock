// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTerminalStore } from './useTerminalStore';
const store = () => useTerminalStore.getState();
function bind(id: string, backend = id) { store().setTerminalSession(id, { sessionId: backend, cols: 80, rows: 24 }); }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000); bind('a'); bind('b'); });
afterEach(() => { store().clearAllTerminalSessions(); vi.useRealTimers(); });
it('captures arrival time once even if rendering drains over multiple frames', () => {
  store().appendToBuffer('a', 'live'.repeat(300_000));
  vi.setSystemTime(20_000); vi.advanceTimersByTime(50);
  expect(store().sessions.get('a')?.lastOutputAt).toBe(10_000);
  vi.advanceTimersByTime(1000);
  expect(store().sessions.get('a')?.lastOutputAt).toBe(10_000);
});
it('records flow-controlled bytes without render chunks, preserving receipt time across screen replacement', () => {
  store().recordTerminalOutput('a'); vi.setSystemTime(10_001); store().recordTerminalOutput('a');
  store().replaceBuffer('a', ['snapshot']); vi.setSystemTime(12_000); store().flushPendingBufferWrites('a');
  expect(store().sessions.get('a')?.lastOutputAt).toBe(10_001);
  store().appendToBuffer('a', 'delayed flow buffer', { markActivity: false }); store().flushPendingBufferWrites('a');
  expect(store().sessions.get('a')?.lastOutputAt).toBe(10_001);
});
it('does not revive cleared, removed or rebound sessions and does not cancel another session activity flush', () => {
  store().recordTerminalOutput('a'); store().recordTerminalOutput('b'); store().clearTerminalSession('a'); vi.advanceTimersByTime(50);
  expect(store().sessions.get('a')?.lastOutputAt).toBeNull(); expect(store().sessions.get('b')?.lastOutputAt).toBe(10_000);
  bind('a'); store().recordTerminalOutput('a'); bind('a', 'replacement'); store().flushPendingBufferWrites('a'); expect(store().sessions.get('a')?.lastOutputAt).toBeNull();
  store().recordTerminalOutput('a'); store().removeTerminalSession('a'); vi.advanceTimersByTime(50); expect(store().sessions.has('a')).toBe(false);
  store().recordTerminalOutput('missing'); vi.advanceTimersByTime(50); expect(store().sessions.has('missing')).toBe(false);
});
