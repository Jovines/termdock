import { fromBase64, toBase64 } from '../../server/federation/packets.js';

const MAX_FRAME_BYTES = 256 * 1024;
const MAX_BUFFER_BYTES = 1024 * 1024;
/** A byte WebSocket facade over a single explicitly addressed relay stream. */
export class RelaySocket extends EventTarget {
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3;
  readonly protocol = ''; readonly extensions = '';
  binaryType: BinaryType = 'arraybuffer';
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  private upstream: WebSocket;
  private streamId = crypto.randomUUID();
  private requested = false;
  private deadline: ReturnType<typeof setTimeout>;
  get bufferedAmount() { return this.upstream.bufferedAmount; }
  constructor(readonly url: string, targetServiceId: string, socketFactory: (url: string) => WebSocket = url => new WebSocket(url)) {
    super();
    if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(targetServiceId)) throw new Error('Invalid target identity');
    this.upstream = socketFactory(url);
    this.deadline = setTimeout(() => this.fail('Relay connection timed out'), 20_000);
    this.upstream.addEventListener('message', event => {
      if (this.readyState === 3) return;
      try {
        if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).length > MAX_FRAME_BYTES) throw new Error('Invalid relay envelope');
        const frame = JSON.parse(event.data);
        if (frame.type === 'ready' && !this.requested) {
          this.requested = true;
          this.transmit({ type: 'open', streamId: this.streamId, serviceId: targetServiceId }); return;
        }
        if (frame.streamId !== this.streamId) return;
        if (frame.type === 'opened' && this.readyState === 0) {
          clearTimeout(this.deadline); this.readyState = 1;
          const e = new Event('open'); this.dispatchEvent(e); this.onopen?.(e); return;
        }
        if (frame.type === 'close') { this.finish(1001, 'Relay route closed'); this.upstream.close(); return; }
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
    const e = new CloseEvent('close', { code, reason, wasClean: code === 1000 }); this.dispatchEvent(e); this.onclose?.(e);
  }
}

export function createRelaySocketFactory(targetServiceId: string): (url: string) => WebSocket {
  return url => new RelaySocket(url, targetServiceId) as unknown as WebSocket;
}
