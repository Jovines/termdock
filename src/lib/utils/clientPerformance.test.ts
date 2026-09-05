// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { trimCache } from './cacheBudget';
import { isUsableTerminalSnapshot } from './terminalSnapshotCache';
import { scheduleInteractionIdle } from './interactionIdle';

afterEach(() => vi.useRealTimers());
describe('client performance safety', () => {
  it('evicts inactive contexts without evicting visible branches', () => {
    const cache = new Map([['visible', 1], ['old', 2], ['new', 3]]);
    expect([...trimCache(cache, 2, new Set(['visible'])).keys()]).toEqual(['visible', 'new']);
  });
  it('rejects expired, oversized or incompatible snapshots', () => {
    const snapshot = { id: 'shell', version: 1 as const, epoch: 'epoch', seq: 1, cols: 80, rows: 24, data: 'screen', savedAt: Date.now() };
    expect(isUsableTerminalSnapshot(snapshot)).toBe(true);
    expect(isUsableTerminalSnapshot({ ...snapshot, savedAt: 0 })).toBe(false);
    expect(isUsableTerminalSnapshot({ ...snapshot, seq: NaN })).toBe(false);
    expect(isUsableTerminalSnapshot({ ...snapshot, data: 'x'.repeat(256 * 1024) })).toBe(false);
  });
  it('defers optional work until the pointer and release animation settle', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const run = vi.fn();
    const cancel = scheduleInteractionIdle(run, 0);
    window.dispatchEvent(new Event('pointerdown'));
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pointerup'));
    vi.advanceTimersByTime(300);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(run).toHaveBeenCalledOnce();
    cancel();
  });
});
