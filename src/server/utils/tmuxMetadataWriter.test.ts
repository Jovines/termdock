// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { TmuxMetadataWriter } from './tmuxMetadataWriter.js';

afterEach(() => vi.useRealTimers());
const metadata = { program: 'codex', cwd: '/work', label: 'codex · work' };

it('writes one batch per session for 25 callers and one heartbeat after 30 seconds', async () => {
  vi.useFakeTimers();
  const write = vi.fn(async (_name: string, _options: Record<string, string>) => {});
  const writer = new TmuxMetadataWriter(write);
  await Promise.all(Array.from({ length: 25 }, () => writer.sync('same', metadata)));
  expect(write).toHaveBeenCalledOnce();
  expect(Object.keys(write.mock.calls[0][1])).toHaveLength(4);
  await writer.sync('same', metadata);
  expect(write).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(30_000);
  await Promise.all(Array.from({ length: 25 }, () => writer.sync('same', metadata)));
  expect(write).toHaveBeenCalledTimes(2);
  expect(Object.keys(write.mock.calls[1][1])).toEqual(['@termdock-last-active-at']);
  await writer.sync('other', metadata);
  expect(write).toHaveBeenCalledTimes(3);
});

it('coalesces newer metadata behind a pending write without overwriting it out of order', async () => {
  const releases: Array<() => void> = [];
  const write = vi.fn((_name: string, _options: Record<string, string>) => new Promise<void>(resolve => { releases.push(resolve); }));
  const writer = new TmuxMetadataWriter(write);
  const first = writer.sync('same', metadata);
  await Promise.resolve();
  const second = writer.sync('same', { ...metadata, cwd: '/second' });
  const third = writer.sync('same', { ...metadata, cwd: '/third' });
  expect(write).toHaveBeenCalledOnce();
  releases.shift()!();
  await Promise.resolve();
  expect(write).toHaveBeenCalledTimes(2);
  expect(write.mock.calls[1][1]['@termdock-cwd']).toBe('/third');
  releases.shift()!(); await Promise.all([first, second, third]);
});

it('retries a failed write and forgets snapshots when a session disappears', async () => {
  const write = vi.fn().mockRejectedValueOnce(new Error('tmux failed')).mockResolvedValue(undefined);
  const writer = new TmuxMetadataWriter(write);
  await expect(writer.sync('same', metadata)).rejects.toThrow('tmux failed');
  await writer.sync('same', metadata);
  expect(write).toHaveBeenCalledTimes(2);
  writer.retain(new Set());
  await writer.sync('same', metadata);
  expect(write).toHaveBeenCalledTimes(3);
  writer.forget('same');
  await writer.sync('same', metadata);
  expect(write).toHaveBeenCalledTimes(4);
});
