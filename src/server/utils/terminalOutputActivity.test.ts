import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TerminalOutputActivity } from './terminalOutputActivity.js';
const trackers: TerminalOutputActivity[] = [];
function monitor() { const publish = vi.fn(); const tracker = new TerminalOutputActivity(publish); trackers.push(tracker); return { tracker, publish }; }
beforeEach(() => vi.useFakeTimers());
afterEach(() => { trackers.forEach(tracker => tracker.dispose()); trackers.length = 0; vi.useRealTimers(); });
it('suppresses isolated output and cancels when the final half-second is silent', () => {
  const { tracker, publish } = monitor(); tracker.record();
  vi.advanceTimersByTime(1499); tracker.record(); vi.advanceTimersByTime(501);
  expect(tracker.active).toBe(false); expect(publish).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  // A new burst gets its own complete two-second qualification window.
  tracker.record(); vi.advanceTimersByTime(1500); tracker.record(); vi.advanceTimersByTime(499); expect(tracker.active).toBe(false);
  vi.advanceTimersByTime(1); expect(tracker.active).toBe(true); expect(publish.mock.calls).toEqual([[true]]);
});
it('starts after two seconds with recent output, hides two seconds after the last packet, then qualifies again', () => {
  const { tracker, publish } = monitor(); tracker.record(); vi.advanceTimersByTime(1800); tracker.record();
  vi.advanceTimersByTime(200); expect(tracker.active).toBe(true);
  vi.advanceTimersByTime(1799); expect(tracker.active).toBe(true);
  vi.advanceTimersByTime(1); expect(tracker.active).toBe(false); expect(publish.mock.calls).toEqual([[true], [false]]);
  tracker.record(); vi.advanceTimersByTime(2000); expect(tracker.active).toBe(false); expect(publish).toHaveBeenCalledTimes(2);
});
it('handles dense output in constant space with one timer and only broadcasts transitions', () => {
  const { tracker, publish } = monitor(); const timers = vi.spyOn(globalThis, 'setTimeout');
  for (let second = 0; second < 32; second++) {
    for (let packet = 0; packet < 10_000; packet++) tracker.record();
    expect(vi.getTimerCount()).toBe(1); vi.advanceTimersByTime(250);
  }
  expect(publish.mock.calls).toEqual([[true]]); expect(timers.mock.calls.length).toBeLessThan(10);
  vi.advanceTimersByTime(2000); expect(publish.mock.calls).toEqual([[true], [false]]); expect(vi.getTimerCount()).toBe(0); timers.mockRestore();
});
it('uses a monotonic clock and disposes pending/active sessions without late broadcasts', () => {
  const a = monitor(), b = monitor(); a.tracker.record(); b.tracker.record();
  vi.advanceTimersByTime(1800); a.tracker.record(); b.tracker.dispose(); vi.setSystemTime(Date.now() - 60_000);
  vi.advanceTimersByTime(200); expect(a.tracker.active).toBe(true); expect(b.tracker.active).toBe(false);
  a.tracker.dispose(); a.tracker.record(); vi.advanceTimersByTime(60_000);
  expect(a.publish.mock.calls).toEqual([[true]]); expect(b.publish).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it('does not revive old activity when a timer/event loop is late', () => {
  let now = 0; const publish = vi.fn(); const tracker = new TerminalOutputActivity(publish, () => now); trackers.push(tracker);
  tracker.record(); now = 5000; expect(tracker.active).toBe(false); expect(publish).not.toHaveBeenCalled();
  tracker.record(); now = 6800; tracker.record(); now = 7000; expect(tracker.active).toBe(true);
  now = 10_000; tracker.record(); expect(tracker.active).toBe(false); expect(publish.mock.calls).toEqual([[true], [false]]);
  vi.advanceTimersByTime(20_000); expect(publish).toHaveBeenCalledTimes(2);
});
