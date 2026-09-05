import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForTmuxClientSize } from './tmuxResizeReady.js';

afterEach(() => vi.useRealTimers());
describe('event driven tmux resize readiness', () => {
  it('completes immediately for the exact ready client, ignoring other clients', async () => {
    const dispose = vi.fn();
    await waitForTmuxClientSize(async () => '2 100 40\n1 80 24', () => dispose, 1, 80, 24);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('does not poll or treat another client as ready; output triggers a new check', async () => {
    vi.useFakeTimers();
    let signal = () => {};
    const read = vi.fn().mockResolvedValueOnce('2 80 24\n1 100 40').mockResolvedValue('1 80 24');
    const dispose = vi.fn();
    const ready = waitForTmuxClientSize(read, (notify) => { signal = notify; return dispose; }, 1, 80, 24);
    await vi.advanceTimersByTimeAsync(200);
    expect(read).toHaveBeenCalledTimes(1);
    signal();
    await ready;
    expect(read).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects a missing resize event instead of declaring success after a delay', async () => {
    vi.useFakeTimers();
    const dispose = vi.fn();
    const read = vi.fn().mockResolvedValue('1 100 40');
    const ready = waitForTmuxClientSize(read, () => dispose, 1, 80, 24);
    const rejected = expect(ready).rejects.toThrow('has not applied');
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(read).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
