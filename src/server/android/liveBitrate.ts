import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

// The overlay implements a private scrcpy ABI: never load it into an unverified server.
const SUPPORTED_SERVER_SHA256 = '8588238c9a5a00aa542906b6ec7e6d5541d9ffb9b5d0f6e1bc0e365e2303079e';
const OVERLAY_SHA256 = 'b2473d67e8bf61191463af2978180048aa4485e5b552af3b9a5368b17edee1a1';
export const bitrateOverlayPath = fileURLToPath(new URL('../../../scripts/android-bitrate/bitrate.jar', import.meta.url));
export const bitrateOverlayRemote = '/data/local/tmp/termdock-bitrate-' + OVERLAY_SHA256.slice(0, 16) + '.jar';
export async function supportsLiveBitrate(serverJar: string, version: string): Promise<boolean> {
  if (version !== '3.3.4') return false;
  try {
    const [server, overlay] = await Promise.all([readFile(serverJar), readFile(bitrateOverlayPath)]);
    return createHash('sha256').update(server).digest('hex') === SUPPORTED_SERVER_SHA256
      && createHash('sha256').update(overlay).digest('hex') === OVERLAY_SHA256;
  } catch { return false; }
}

/** Tiny independent ADB channel: requests never wait behind video/backpressure. */
export class LiveBitrateChannel {
  private server = net.createServer(socket => this.accept(socket));
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private ready = false;
  private closed = false;
  private pending: { value: number; resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  constructor(private readonly onReady: (ready: boolean) => void) {}
  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    return (this.server.address() as net.AddressInfo).port;
  }
  private accept(socket: net.Socket): void {
    if (this.socket || this.closed) { socket.destroy(); return; }
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
    socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4 && !this.closed) {
        const value = this.buffer.readUInt32BE();
        this.buffer = this.buffer.subarray(4);
        if (!this.ready) {
          if (value !== 0x54444231) { this.close(); return; }
          this.ready = true;
          this.onReady(true);
        } else if (this.pending) {
          const pending = this.pending;
          this.pending = null;
          clearTimeout(pending.timer);
          pending.resolve(value === pending.value);
        } else { this.close(); }
      }
    });
  }
  setBitrate(value: number): Promise<boolean> {
    if (!this.ready || this.closed || this.pending || !Number.isInteger(value) || value < 300_000 || value > 30_000_000) return Promise.resolve(false);
    return new Promise(resolve => {
      // On timeout retire this channel: late ACKs must not confirm newer requests.
      const timer = setTimeout(() => this.close(), 2500);
      this.pending = { value, resolve, timer };
      const bytes = Buffer.alloc(4);
      bytes.writeUInt32BE(value);
      this.socket!.write(bytes);
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.resolve(false);
      this.pending = null;
    }
    this.socket?.destroy();
    this.server.close();
    if (this.ready) this.onReady(false);
    this.ready = false;
  }
}
