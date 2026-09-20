import { afterEach, expect, it, vi } from 'vitest';
import net from 'node:net';
import { once } from 'node:events';
import { LiveBitrateChannel, supportsLiveBitrate, inspectLiveBitrate, resolveBundledPreviewServer, bundledPreviewServerPath } from './liveBitrate';
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.reverse().forEach(fn => fn()); cleanup.length = 0; vi.useRealTimers(); });
async function channel(protocol = 1) {
  const ready = vi.fn();
  const channel = new LiveBitrateChannel(ready);
  cleanup.push(() => channel.close());
  const socket = net.connect(await channel.listen(), '127.0.0.1');
  cleanup.push(() => socket.destroy());
  await once(socket, 'connect');
  // Partial reads must not report capability early.
  socket.write(Buffer.from([0x54, 0x44]));
  socket.write(Buffer.from([0x42, protocol === 2 ? 0x32 : 0x31]));
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
  expect(ready).toHaveBeenLastCalledWith(false, expect.stringContaining('BITRATE_ACK_TIMEOUT'));
  expect(await c.setBitrate(1_000_000)).toBe(false);
});
it('rejects invalid rates and unverified server ABIs', async () => {
  const { channel: c } = await channel();
  for (const value of [NaN, Infinity, 1.5, 299_999, 30_000_001]) expect(await c.setBitrate(value)).toBe(false);
  expect(await supportsLiveBitrate('/missing', '4.0')).toBe(false);
  expect(await supportsLiveBitrate('/missing', '3.3.4')).toBe(false);
});

it('ships a verified preview server independently of host scrcpy and honors explicit overrides', async () => {
  vi.stubEnv('TERMDOCK_SCRCPY_SERVER', '');
  try {
    expect(await resolveBundledPreviewServer()).toEqual({ serverJar: bundledPreviewServerPath, version: '3.3.4' });
    expect(await inspectLiveBitrate(bundledPreviewServerPath, '3.3.4')).toBeNull();
    vi.stubEnv('TERMDOCK_SCRCPY_SERVER', '/custom/server');
    expect(await resolveBundledPreviewServer()).toBeNull();
  } finally { vi.unstubAllEnvs(); }
});
it('diagnoses version mismatches and missing server files without claiming encoder failure', async () => {
  expect(await inspectLiveBitrate('/server.jar', '4.0')).toContain('SCRCPY_VERSION_UNSUPPORTED: scrcpy=4.0');
  expect(await inspectLiveBitrate('/missing', '3.3.4')).toContain('SCRCPY_SERVER_READ_FAILED');
});
it('reports missing extension handshakes and stays silent on intentional shutdown', async () => {
  vi.useFakeTimers();
  const ready = vi.fn();
  const c = new LiveBitrateChannel(ready);
  cleanup.push(() => c.close());
  await c.listen();
  await vi.advanceTimersByTimeAsync(15000);
  expect(ready).toHaveBeenCalledWith(false, expect.stringContaining('BITRATE_HANDSHAKE_TIMEOUT'));
  const silent = new LiveBitrateChannel(ready);
  await silent.listen();
  ready.mockClear();
  silent.close();
  await vi.advanceTimersByTimeAsync(15000);
  expect(ready).not.toHaveBeenCalled();
});

it('preserves fragmented codec diagnostics instead of reporting an unsupported device', async () => {
  const { channel: c, socket, ready } = await channel(2);
  const result = c.setBitrate(8_000_000);
  const text = Buffer.from('android.media.MediaCodec.error_neg_1010: unsupported parameter');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(text.length, 4);
  socket.write(header.subarray(0, 5));
  socket.write(Buffer.concat([header.subarray(5), text]));
  expect(await result).toBe(false);
  expect(ready).toHaveBeenLastCalledWith(false, expect.stringContaining(text.toString()));
  expect(c.lastFailure).toContain('requested=8000000');
});
