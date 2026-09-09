// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { PtySpawnBackoff, PtySpawnDeferredError } from './ptySpawnBackoff.js';

it('limits retries across 12 reconnecting sessions, preserves errors, and recovers', () => {
  let now = 0;
  const gate = new PtySpawnBackoff(() => now);
  const failure = new Error('posix_spawnp failed: errno=24 (Too many open files)');
  const spawn = vi.fn(() => { throw failure; });
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    expect(() => gate.spawn(spawn)).toThrow(failure);
    const calls = spawn.mock.calls.length;
    for (let reconnect = 0; reconnect < 100; reconnect++) {
      for (let session = 0; session < 12; session++) {
        expect(() => gate.spawn(spawn)).toThrow(PtySpawnDeferredError);
      }
    }
    expect(spawn).toHaveBeenCalledTimes(calls);
    expect(gate.retryAfterMs).toBe(delay);
    now += delay;
  }
  expect(gate.spawn(() => 'recovered')).toBe('recovered');
  expect(gate.retryAfterMs).toBe(0);
  expect(() => gate.spawn(spawn)).toThrow(failure);
  expect(gate.retryAfterMs).toBe(1000);
});
