import { afterEach, expect, it, vi } from 'vitest';
import net from 'node:net';
import { once } from 'node:events';
import { LiveBitrateChannel, supportsLiveBitrate } from './liveBitrate';
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.reverse().forEach(fn => fn()); cleanup.length = 0; vi.useRealTimers(); });
async function channel() {
  const ready = vi.fn();
  const channel = new LiveBitrateChannel(ready);
  cleanup.push(() => channel.close());
  const socket = net.connect(await channel.listen(), '127.0.0.1');
  cleanup.push(() => socket.destroy());
  await once(socket, 'connect');
  // Partial reads must not report capability early.
  socket.write(Buffer.from([0x54, 0x44]));
  socket.write(Buffer.from([0x42, 0x31]));
  await vi.waitFor(() => expect(ready).toHaveBeenCalledWith(true));
  return { channel, socket, ready };
}
it('serializes updates and accepts only a matching device acknowledgement', async () => {
  const { channel: c, socket } = await channel();
  const bytes = once(socket, 'data');
  const applied = c.setBitrate(1_800_000);
  expect(await c.setBitrate(4_000_000)).toBe(false);
  const [data] = await bytes;
  expect(data.readUInt32BE()).toBe(1_800_000);
  socket.write(data);
  expect(await applied).toBe(true);
  const rejected = c.setBitrate(4_000_000);
  socket.write(Buffer.alloc(4));
  expect(await rejected).toBe(false);
});
it('disables only bitrate adjustment on failure or timeout', async () => {
  const { channel: c, ready } = await channel();
  vi.useFakeTimers();
  const pending = c.setBitrate(4_000_000);
  await vi.advanceTimersByTimeAsync(2500);
  expect(await pending).toBe(false);
  expect(ready).toHaveBeenLastCalledWith(false);
  expect(await c.setBitrate(1_000_000)).toBe(false);
});
it('rejects invalid rates and unverified server ABIs', async () => {
  const { channel: c } = await channel();
  for (const value of [NaN, Infinity, 1.5, 299_999, 30_000_001]) expect(await c.setBitrate(value)).toBe(false);
  expect(await supportsLiveBitrate('/missing', '4.0')).toBe(false);
  expect(await supportsLiveBitrate('/missing', '3.3.4')).toBe(false);
});
