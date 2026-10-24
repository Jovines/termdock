import { RELAY_CLIENT_CONNECT_TIMEOUT_MS, RELAY_MAX_FRAME_BYTES, RELAY_MAX_BUFFERED_BYTES } from './streamLimits.js';
import { fromBase64, toBase64 } from './packets.js';
import { ConnectionAccessError, type AccessFailureContext } from './connectionErrors.js';

export interface RelayWireSocket {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void, options?: { once?: boolean }): void;
}
export type RelayCloseEvent = Event & { code: number; reason: string; wasClean: boolean };

const MAX_FRAME_BYTES = RELAY_MAX_FRAME_BYTES;
const MAX_BUFFER_BYTES = RELAY_MAX_BUFFERED_BYTES;
/** A byte WebSocket facade over a single explicitly addressed relay stream. */
export class RelayTransport extends EventTarget {
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3;
  readonly protocol = ''; readonly extensions = '';
  binaryType: 'arraybuffer' | 'blob' = 'arraybuffer';
  readyState = 0;
  transportFailure?: Error;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: RelayCloseEvent) => void) | null = null;
  readonly connectionTimings = { entryOpenMs: null as number | null, routeOpenMs: null as number | null };
  private upstream: RelayWireSocket;
  private streamId = crypto.randomUUID();
  private requested = false;
  private deadline: ReturnType<typeof setTimeout>;
  get bufferedAmount() { return this.upstream.bufferedAmount; }
  constructor(readonly url: string, targetServiceId: string, socketFactory: (url: string) => RelayWireSocket, context: AccessFailureContext = {}) {
    super();
    if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(targetServiceId)) throw new Error('Invalid target identity');
    if (context.entryServiceId === targetServiceId) throw new ConnectionAccessError('RELAY_SELF_TARGET', { ...context, targetServiceId });
    const started = performance.now();
    let entryReadyAt: number | undefined;
    this.upstream = socketFactory(url);
    this.upstream.addEventListener('open', () => {
      this.connectionTimings.entryOpenMs = performance.now() - started;
    });
    this.deadline = setTimeout(() => this.fail('Relay connection timed out'), RELAY_CLIENT_CONNECT_TIMEOUT_MS);
    this.upstream.addEventListener('message', event => {
      if (this.readyState === 3) return;
      try {
        if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).length > MAX_FRAME_BYTES) throw new Error('Invalid relay envelope');
        const frame = JSON.parse(event.data);
        if (frame.type === 'ready') {
          if (this.requested || this.readyState !== 0) throw new Error('Repeated relay handshake');
          entryReadyAt = performance.now();
          this.requested = true;
          this.transmit({ type: 'open', streamId: this.streamId, serviceId: targetServiceId }); return;
        }
        if (frame.streamId !== this.streamId) return;
        if (frame.type === 'opened' && this.readyState === 0) {
          this.connectionTimings.routeOpenMs = entryReadyAt === undefined ? null : performance.now() - entryReadyAt;
          clearTimeout(this.deadline); this.readyState = 1;
          const e = new Event('open'); this.dispatchEvent(e); this.onopen?.(e); return;
        }
        if (frame.type === 'close') {
          if (frame.code === 'RELAY_AUTHORIZATION_REQUIRED' || frame.reason === 'Authorization revoked') {
            this.transportFailure = new ConnectionAccessError('RELAY_AUTHORIZATION_REQUIRED', { ...context, targetServiceId });
          }
          if (frame.code === 'RELAY_SELF_TARGET') this.transportFailure = new ConnectionAccessError('RELAY_SELF_TARGET', { ...context, targetServiceId });
          if (frame.code === 'TARGET_PASSWORD_REQUIRED' || frame.code === 'TARGET_SECURITY_UPGRADE_REQUIRED') this.transportFailure = new ConnectionAccessError(frame.code, { ...context, targetServiceId });
          this.finish(1001, this.transportFailure?.message || 'Relay route closed'); this.upstream.close(); return;
        }
        if (frame.type !== 'data' || this.readyState !== 1 || frame.encoding !== 'base64' || typeof frame.payload !== 'string'
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.payload)) throw new Error('Invalid ciphertext relay frame');
        const bytes = fromBase64(frame.payload);
        const data = this.binaryType === 'blob' ? new Blob([bytes as Uint8Array<ArrayBuffer>]) : bytes.buffer;
        const e = new MessageEvent('message', { data }); this.dispatchEvent(e); this.onmessage?.(e);
      } catch { this.fail('Relay protocol rejected frame'); }
    });
    this.upstream.addEventListener('close', event => this.finish(event.code || 1006, 'Relay disconnected'));
    this.upstream.addEventListener('error', () => this.fail('Relay transport unavailable'));
  }
  private transmit(frame: unknown) {
    const data = JSON.stringify(frame);
    if (this.upstream.readyState !== 1 || this.upstream.bufferedAmount + data.length > MAX_BUFFER_BYTES || data.length > MAX_FRAME_BYTES) throw new Error('Relay unavailable or congested');
    this.upstream.send(data);
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.readyState !== 1) throw new Error('Relay socket is not open');
    let bytes: Uint8Array;
    if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else throw new Error('Relay secure transport requires binary bytes');
    try { this.transmit({ type: 'data', streamId: this.streamId, encoding: 'base64', payload: toBase64(bytes) }); }
    catch (error) { this.fail('Relay transport congested'); throw error; }
  }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    try { if (this.requested) this.transmit({ type: 'close', streamId: this.streamId }); } catch { /* connection already unavailable */ }
    this.finish(code, reason); this.upstream.close();
  }
  private fail(reason: string) {
    if (this.readyState === 3) return;
    const e = new Event('error'); this.dispatchEvent(e); this.onerror?.(e);
    this.finish(1006, reason); this.upstream.close();
  }
  private finish(code: number, reason: string) {
    if (this.readyState === 3) return;
    clearTimeout(this.deadline); this.readyState = 3;
    const e = Object.assign(new Event('close'), { code, reason, wasClean: code === 1000 }); this.dispatchEvent(e); this.onclose?.(e);
  }
}
