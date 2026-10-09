// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { SharedSessionSampler, SharedSnapshotCache } from './sharedSampling.js';

afterEach(() => vi.useRealTimers());

it('shares forced refreshes, expires snapshots, bounds keys, and retries failures', async () => {
  vi.useFakeTimers();
  const cache = new SharedSnapshotCache<string, number>(1000, 2);
  let finish!: (value: number) => void;
  const load = vi.fn(() => new Promise<number>(resolve => { finish = resolve; }));
  const pending = Array.from({ length: 25 }, () => cache.get('tty', load, true));
  await Promise.resolve();
  expect(load).toHaveBeenCalledOnce();
  finish(7);
  expect(await Promise.all(pending)).toEqual(Array(25).fill(7));
  expect(await cache.get('tty', load)).toBe(7);
  await vi.advanceTimersByTimeAsync(1001);
  await expect(cache.get('tty', async () => { throw new Error('ps failed'); })).rejects.toThrow('ps failed');
  expect(await cache.get('tty', async () => 8)).toBe(8);
  await cache.get('other', async () => 9);
  await cache.get('third', async () => 10);
  expect(await cache.get('tty', async () => 11)).toBe(11);
});

it('samples once for 25 observers and gives all observers initial state and changes', async () => {
  vi.useFakeTimers();
  let cwd = '/first';
  const sample = vi.fn(async () => [{ type: 'cwd', cwd }, { type: 'shell-title', title: cwd }]);
  const sampler = new SharedSessionSampler(sample, () => 500, error => { throw error; });
  const clients = Array.from({ length: 25 }, () => vi.fn());
  const stops = clients.map(client => sampler.subscribe(client));
  await vi.advanceTimersByTimeAsync(0);
  expect(sample).toHaveBeenCalledOnce();
  for (const client of clients) expect(client.mock.calls).toEqual([[{ type: 'cwd', cwd }], [{ type: 'shell-title', title: cwd }]]);
  const late = vi.fn();
  const stopLate = sampler.subscribe(late);
  expect(late).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(500);
  for (const client of clients) expect(client).toHaveBeenCalledTimes(2);
  cwd = '/second';
  await vi.advanceTimersByTimeAsync(500);
  for (const client of [...clients, late]) expect(client.mock.calls.slice(-2)).toEqual([[{ type: 'cwd', cwd }], [{ type: 'shell-title', title: cwd }]]);
  stops.forEach(stop => stop()); stopLate();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(1000);
  expect(sample).toHaveBeenCalledTimes(3);
});

it('never overlaps a slow sample and drops delivery after the final unsubscribe', async () => {
  vi.useFakeTimers();
  let finish!: (value: Array<{ type: string; cwd: string }>) => void;
  const sample = vi.fn(() => new Promise<Array<{ type: string; cwd: string }>>(resolve => { finish = resolve; }));
  const sampler = new SharedSessionSampler(sample, () => 500, vi.fn());
  const observer = vi.fn();
  const stop = sampler.subscribe(observer);
  await vi.advanceTimersByTimeAsync(2000);
  expect(sample).toHaveBeenCalledOnce();
  stop(); finish([{ type: 'cwd', cwd: '/stale' }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(observer).not.toHaveBeenCalled();
  const next = vi.fn(); const stopNext = sampler.subscribe(next);
  await vi.advanceTimersByTimeAsync(0);
  expect(sample).toHaveBeenCalledTimes(2);
  finish([{ type: 'cwd', cwd: '/fresh' }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(next).toHaveBeenCalledWith({ type: 'cwd', cwd: '/fresh' });
  stopNext();
});
