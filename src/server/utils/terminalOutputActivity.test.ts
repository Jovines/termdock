import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TerminalOutputActivity } from './terminalOutputActivity.js';
const trackers: TerminalOutputActivity[] = [];
function monitor() { const publish = vi.fn(); const tracker = new TerminalOutputActivity(publish); trackers.push(tracker); return { tracker, publish }; }
beforeEach(() => vi.useFakeTimers());
afterEach(() => { trackers.forEach(tracker => tracker.dispose()); trackers.length = 0; vi.useRealTimers(); });
it('ignores one brief write even when transport splits it into thousands of chunks', () => {
  const { tracker, publish } = monitor();
  for (let packet = 0; packet < 10_000; packet++) tracker.record();
  vi.advanceTimersByTime(100); tracker.record(); vi.advanceTimersByTime(500);
  expect(tracker.active).toBe(false); expect(publish).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it('qualifies ongoing output without requiring an arbitrary final half-second slot', () => {
  const { tracker, publish } = monitor(); tracker.record(); vi.advanceTimersByTime(200); tracker.record();
  vi.advanceTimersByTime(399); expect(tracker.active).toBe(false);
  vi.advanceTimersByTime(1); expect(tracker.active).toBe(true); expect(publish.mock.calls).toEqual([[true]]);
});
it('bridges realistic quiet tool gaps and expires eight seconds after the last receipt', () => {
  const { tracker, publish } = monitor(); tracker.record(); vi.advanceTimersByTime(200); tracker.record();
  vi.advanceTimersByTime(400); expect(tracker.active).toBe(true);
  vi.advanceTimersByTime(7000); tracker.record(); // A quiet tool round trip is not a new job.
  expect(tracker.active).toBe(true); expect(publish.mock.calls).toEqual([[true]]);
  vi.advanceTimersByTime(7999); expect(tracker.active).toBe(true);
  vi.advanceTimersByTime(1); expect(tracker.active).toBe(false); expect(publish.mock.calls).toEqual([[true], [false]]);
  tracker.record(); vi.advanceTimersByTime(600); expect(tracker.active).toBe(false);
});
it('handles dense output in constant space with one timer and only broadcasts transitions', () => {
  const { tracker, publish } = monitor(); const timers = vi.spyOn(globalThis, 'setTimeout');
  for (let tick = 0; tick < 32; tick++) {
    for (let packet = 0; packet < 10_000; packet++) tracker.record();
    expect(vi.getTimerCount()).toBe(1); vi.advanceTimersByTime(250);
  }
  expect(publish.mock.calls).toEqual([[true]]); expect(timers.mock.calls.length).toBeLessThan(5);
  vi.advanceTimersByTime(8000); expect(publish.mock.calls).toEqual([[true], [false]]); expect(vi.getTimerCount()).toBe(0); timers.mockRestore();
});
it('uses a monotonic clock and disposes pending/active sessions without late broadcasts', () => {
  const a = monitor(), b = monitor(); a.tracker.record(); b.tracker.record();
  vi.advanceTimersByTime(200); a.tracker.record(); b.tracker.dispose(); vi.setSystemTime(Date.now() - 60_000);
  vi.advanceTimersByTime(400); expect(a.tracker.active).toBe(true); expect(b.tracker.active).toBe(false);
  a.tracker.dispose(); a.tracker.record(); vi.advanceTimersByTime(60_000);
  expect(a.publish.mock.calls).toEqual([[true]]); expect(b.publish).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it('does not revive expired activity when a timer/event loop is late', () => {
  let now = 0; const publish = vi.fn(); const tracker = new TerminalOutputActivity(publish, () => now); trackers.push(tracker);
  tracker.record(); now = 200; tracker.record(); now = 5000; expect(tracker.active).toBe(false); expect(publish).not.toHaveBeenCalled();
  tracker.record(); now = 5200; tracker.record(); now = 5600; expect(tracker.active).toBe(true);
  now = 14_000; tracker.record(); expect(tracker.active).toBe(false); expect(publish.mock.calls).toEqual([[true], [false]]);
  vi.advanceTimersByTime(20_000); expect(publish).toHaveBeenCalledTimes(2);
});

it('reschedules an early timer instead of stranding a pending window without a timer', () => {
  let now = 0.4; const publish = vi.fn(); const tracker = new TerminalOutputActivity(publish, () => now); trackers.push(tracker);
  tracker.record(); now = 200.6; tracker.record();
  now = 600.1; vi.advanceTimersByTime(600);
  expect(tracker.active).toBe(false); expect(vi.getTimerCount()).toBe(1);
  now = 600.4; vi.advanceTimersByTime(1);
  expect(tracker.active).toBe(true); expect(publish.mock.calls).toEqual([[true]]);
});

it('clears a failed source without briefly activating an overdue pending window', () => {
  let now = 0; const publish = vi.fn(); const tracker = new TerminalOutputActivity(publish, () => now); trackers.push(tracker);
  tracker.record(); now = 200; tracker.record(); now = 700; tracker.dispose(true);
  expect(publish).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  const active = monitor(); active.tracker.record(); vi.advanceTimersByTime(200); active.tracker.record(); vi.advanceTimersByTime(400); active.tracker.dispose(true);
  expect(active.publish.mock.calls).toEqual([[true], [false]]);
});
