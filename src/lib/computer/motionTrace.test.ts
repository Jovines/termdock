// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clientLog } from '../utils/clientLog';
import { createComputerMotionTrace } from './motionTrace';
vi.mock('../utils/clientLog', () => ({ clientLog: vi.fn() }));
beforeEach(() => { vi.useFakeTimers(); vi.mocked(clientLog).mockClear(); });
afterEach(() => { vi.useRealTimers(); });
it('keeps input samples local until gesture completion or idle, preserving their order and clock', () => {
  const trace = createComputerMotionTrace();
  trace.record('down', { client: [10, 20] }); vi.advanceTimersByTime(10);
  trace.record('send', { target: [100, 200] });
  expect(clientLog).not.toHaveBeenCalled(); trace.flush('gesture-end');
  const batch = vi.mocked(clientLog).mock.calls[0][2]!;
  expect(batch.reason).toBe('gesture-end'); expect(batch.sequence).toBe(1);
  expect(batch.samples).toEqual([[0, 'down', { client: [10, 20] }], [10, 'send', { target: [100, 200] }]]);
  trace.record('rdp-server-mouse', { x: 1, y: 2, ignored: true });
  vi.advanceTimersByTime(750); expect(clientLog).toHaveBeenCalledTimes(2); trace.dispose();
});
it('bounds long gestures, retains the start and latest tail, and splits uploads into small records', () => {
  const trace = createComputerMotionTrace();
  for (let i = 0; i < 10000; i++) trace.record('move', { client: [i, i] });
  expect(clientLog).not.toHaveBeenCalled(); trace.flush('gesture-end');
  const batches = vi.mocked(clientLog).mock.calls.map(call => call[2]!);
  expect(batches).toHaveLength(128); expect(batches[0].dropped).toBe(1808);
  const samples = batches.flatMap(batch => batch.samples as Array<[number, string, { client: number[] }]>);
  expect(samples).toHaveLength(8192); expect(samples[0][2].client).toEqual([0, 0]);
  expect(samples[2047][2].client).toEqual([2047, 2047]); expect(samples[2048][2].client).toEqual([3856, 3856]);
  expect(samples.at(-1)![2].client).toEqual([9999, 9999]); trace.dispose();
});
it('stops recording after fifteen minutes and flushes pending samples on cancellation', () => {
  const trace = createComputerMotionTrace(); trace.record('down'); trace.dispose();
  trace.record('ignored'); vi.advanceTimersByTime(1000); expect(clientLog).toHaveBeenCalledTimes(1);
  const expired = createComputerMotionTrace(); vi.advanceTimersByTime(15 * 60_000);
  expired.record('ignored'); expired.flush('done'); expect(clientLog).toHaveBeenCalledTimes(1);
});

it('preserves a twenty-second 60 Hz gesture without dropping input or cursor samples', () => {
  const trace = createComputerMotionTrace();
  for (let frame = 0; frame < 1200; frame++) {
    trace.record('move-input', { client: [frame, frame] });
    trace.record('send', { target: [frame, frame] });
    vi.advanceTimersByTime(1000 / 60);
  }
  trace.flush('gesture-end');
  const batches = vi.mocked(clientLog).mock.calls.map(call => call[2]!);
  expect(batches.reduce((n, batch) => n + Number(batch.dropped), 0)).toBe(0);
  expect(batches.flatMap(batch => batch.samples as unknown[])).toHaveLength(2400);
  trace.dispose();
});
