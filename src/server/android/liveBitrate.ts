import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

// The overlay implements a private scrcpy ABI: never load it into an unverified server.
const SUPPORTED_SERVER_SHA256 = '8588238c9a5a00aa542906b6ec7e6d5541d9ffb9b5d0f6e1bc0e365e2303079e';
const OVERLAY_SHA256 = '19eee1787a564bd2996a6443613aaa4700185838d4e42fe59d1d08ca6b12e828';
export const bitrateOverlayPath = fileURLToPath(new URL('../../../scripts/android-bitrate/bitrate.jar', import.meta.url));
export const bitrateOverlayRemote = '/data/local/tmp/termdock-bitrate-' + OVERLAY_SHA256.slice(0, 16) + '.jar';
export const bundledPreviewServerPath = fileURLToPath(new URL('../../../scripts/android-bitrate/scrcpy-server-v3.3.4', import.meta.url));
/** Pin the preview ABI across host scrcpy installations. Explicit overrides remain opt-in. */
export async function resolveBundledPreviewServer(): Promise<{ serverJar: string; version: string } | null> {
  if (process.env.TERMDOCK_SCRCPY_SERVER) return null;
  try {
    const server = await readFile(bundledPreviewServerPath);
    if (createHash('sha256').update(server).digest('hex') !== SUPPORTED_SERVER_SHA256) {
      console.warn('[android] BUNDLED_SCRCPY_HASH_MISMATCH: ' + bundledPreviewServerPath);
      return null;
    }
    return { serverJar: bundledPreviewServerPath, version: '3.3.4' };
  } catch {
    console.warn('[android] BUNDLED_SCRCPY_MISSING: ' + bundledPreviewServerPath);
    return null;
  }
}
export async function inspectLiveBitrate(serverJar: string, version: string): Promise<string | null> {
  if (version !== '3.3.4') return `SCRCPY_VERSION_UNSUPPORTED: scrcpy=${version}; supported=3.3.4; server=${serverJar}`;
  let server: Buffer, overlay: Buffer;
  try { server = await readFile(serverJar); }
  catch (error) { return `SCRCPY_SERVER_READ_FAILED: ${serverJar}; ${String(error)}`; }
  const hash = createHash('sha256').update(server).digest('hex');
  if (hash !== SUPPORTED_SERVER_SHA256) return `SCRCPY_BUILD_UNVERIFIED: scrcpy=${version}; server=${serverJar}; sha256=${hash}; expected=${SUPPORTED_SERVER_SHA256}`;
  try { overlay = await readFile(bitrateOverlayPath); }
  catch (error) { return `BITRATE_EXTENSION_MISSING: ${bitrateOverlayPath}; ${String(error)}`; }
  const overlayHash = createHash('sha256').update(overlay).digest('hex');
  if (overlayHash !== OVERLAY_SHA256) return `BITRATE_EXTENSION_HASH_MISMATCH: ${bitrateOverlayPath}; sha256=${overlayHash}; expected=${OVERLAY_SHA256}`;
  return null;
}
export async function supportsLiveBitrate(serverJar: string, version: string): Promise<boolean> {
  return (await inspectLiveBitrate(serverJar, version)) === null;
}

/** Tiny independent ADB channel: requests never wait behind video/backpressure. */
export class LiveBitrateChannel {
  private server = net.createServer(socket => this.accept(socket));
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private ready = false;
  private diagnosticProtocol = false;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  lastFailure: string | undefined;
  private closed = false;
  private pending: { value: number; resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  constructor(private readonly onReady: (ready: boolean, detail?: string) => void) {}
  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.handshakeTimer = setTimeout(() => this.close('BITRATE_HANDSHAKE_TIMEOUT: no extension handshake within 15s'), 15000);
    return (this.server.address() as net.AddressInfo).port;
  }
  private accept(socket: net.Socket): void {
    if (this.socket || this.closed) { socket.destroy(); return; }
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('error', error => this.close(`BITRATE_CHANNEL_ERROR: ${error.message}`));
    socket.on('close', () => this.close('BITRATE_CHANNEL_CLOSED: device closed the bitrate channel'));
    socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4 && !this.closed) {
        const value = this.buffer.readUInt32BE();
        let consumed = 4;
        let rejection = '';
        if (this.ready && this.diagnosticProtocol && value === 0) {
          if (this.buffer.length < 8) return;
          const length = this.buffer.readUInt32BE(4);
          if (length > 4096) { this.close('BITRATE_PROTOCOL_ERROR: oversized encoder diagnostic'); return; }
          if (this.buffer.length < 8 + length) return;
          rejection = this.buffer.subarray(8, 8 + length).toString('utf8');
          consumed = 8 + length;
        }
        this.buffer = this.buffer.subarray(consumed);
        if (!this.ready) {
          if (value !== 0x54444231 && value !== 0x54444232) { this.close(`BITRATE_PROTOCOL_ERROR: handshake=0x${value.toString(16)}`); return; }
          this.diagnosticProtocol = value === 0x54444232;
          this.ready = true;
          if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
          this.onReady(true);
        } else if (this.pending) {
          const pending = this.pending;
          this.pending = null;
          clearTimeout(pending.timer);
          if (value !== pending.value) this.close(`BITRATE_ENCODER_REJECTED: requested=${pending.value} bps; reply=${value}; ${rejection}`);
          pending.resolve(value === pending.value);
        } else { this.close('BITRATE_PROTOCOL_ERROR: unexpected acknowledgement'); }
      }
    });
  }
  setBitrate(value: number): Promise<boolean> {
    if (!this.ready || this.closed || this.pending || !Number.isInteger(value) || value < 300_000 || value > 30_000_000) return Promise.resolve(false);
    return new Promise(resolve => {
      // On timeout retire this channel: late ACKs must not confirm newer requests.
      const timer = setTimeout(() => this.close(`BITRATE_ACK_TIMEOUT: requested=${value} bps; no device reply within 2500ms`), 2500);
      this.pending = { value, resolve, timer };
      const bytes = Buffer.alloc(4);
      bytes.writeUInt32BE(value);
      this.socket!.write(bytes);
    });
  }
  close(detail?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.lastFailure = detail;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.resolve(false);
      this.pending = null;
    }
    this.socket?.destroy();
    this.server.close();
    if (detail) this.onReady(false, detail);
    this.ready = false;
  }
}
