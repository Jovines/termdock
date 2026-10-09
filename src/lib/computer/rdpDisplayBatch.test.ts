import { expect, it, vi } from 'vitest';
import { batchRdpDisplay } from './rdpDisplayBatch';
it('renders a burst in bounded groups without dropping draw operations or acknowledging unrendered frames', () => {
  let tasks: number[] = [];
  const frames: Array<{ tasks: number[]; done: () => void; timestamp?: number; count?: number }> = [];
  const display = { flush(done: () => void, timestamp?: number, count?: number) { frames.push({ tasks, done, timestamp, count }); tasks = []; } };
  const batch = batchRdpDisplay(display), completed: number[] = [];
  batch.run(() => { for (let i = 1; i <= 120; i++) { tasks.push(i); display.flush(() => completed.push(i), i, 1); } tasks.push(121); }, 120);
  expect(frames).toHaveLength(2); expect(completed).toEqual([]);
  expect(frames.flatMap(frame => frame.tasks)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
  expect(tasks).toEqual([121]); expect(frames.map(frame => [frame.timestamp, frame.count])).toEqual([[64, 64], [120, 56]]);
  frames.forEach(frame => frame.done()); expect(completed).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
  batch.cancel();
});
it('keeps individual frames unchanged and cancels late completion when disconnecting', () => {
  const pending: Array<() => void> = [];
  const original = vi.fn(callback => pending.push(callback)), display = { flush: original };
  const batch = batchRdpDisplay(display), done = vi.fn();
  display.flush(done); expect(original).toHaveBeenLastCalledWith(done, undefined, undefined);
  batch.run(() => { display.flush(done); display.flush(done); }, 2);
  expect(original).toHaveBeenCalledTimes(2); batch.cancel(); pending[1](); expect(done).not.toHaveBeenCalled();
  expect(display.flush).toBe(original);
});
