import { describe, expect, it, vi } from 'vitest';
import { TransferWindow, transferWindow } from './transferWindow.js';

describe('bounded HTTP transfer window', () => {
  it('limits peer-provided windows and keeps older peers at one', () => {
    expect([undefined, null, NaN, Infinity, -1, 0, 1.5, '8'].map(transferWindow)).toEqual(Array(8).fill(1));
    expect(transferWindow(8)).toBe(8);
    expect(transferWindow(1000)).toBe(8);
  });
  it('releases one slot per ACK and ignores idle acknowledgements', async () => {
    const window = new TransferWindow(2, new AbortController().signal);
    window.acknowledge();
    window.sent(); window.sent();
    const ready = vi.fn();
    const wait = window.wait().then(ready);
    await Promise.resolve(); expect(ready).not.toHaveBeenCalled();
    window.acknowledge(); await wait;
    window.sent(); expect(() => window.sent()).toThrow('exceeded');
    const drained = vi.fn(); const drain = window.wait(true).then(drained);
    window.acknowledge(); await Promise.resolve(); expect(drained).not.toHaveBeenCalled();
    window.acknowledge(); await drain;
  });
  it('aborts pending waits immediately and times out stalled consumers', async () => {
    const abort = new AbortController();
    const window = new TransferWindow(1, abort.signal); window.sent();
    const waiting = expect(window.wait()).rejects.toThrow('offline');
    abort.abort(new Error('offline')); await waiting;
    vi.useFakeTimers();
    try {
      const stalled = new TransferWindow(1, new AbortController().signal); stalled.sent();
      const timeout = expect(stalled.wait()).rejects.toThrow('CONSUMER_TIMEOUT');
      await vi.advanceTimersByTimeAsync(30_000); await timeout;
    } finally { vi.useRealTimers(); }
  });
});
