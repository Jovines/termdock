import { secureSocket } from '../federation/browserIntegration';

/** noVNC accepts a WebSocket-shaped binary channel. Keep the JSON/base64
 * adaptation here; never let noVNC create its own unencrypted WebSocket. */
export class SecureVncChannel {
  binaryType = 'arraybuffer';
  readonly protocol = '';
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  private socket: WebSocket;
  get readyState(): number { return this.socket.readyState; }
  constructor(host: string, onFailure: (reason: string) => void) {
    this.socket = secureSocket(`/api/computer/ws?host=${encodeURIComponent(host)}`);
    this.socket.onopen = event => this.onopen?.(event);
    this.socket.onerror = event => this.onerror?.(event);
    this.socket.onclose = event => {
      if (event.code !== 1000 || event.reason) onFailure(event.reason || 'COMPUTER_DISCONNECTED');
      this.onclose?.(event);
    };
    this.socket.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        if (message.type !== 'data' || typeof message.data !== 'string' || !Number.isSafeInteger(message.seq)) throw new Error('Invalid VNC record');
        const bytes = Uint8Array.from(atob(message.data), char => char.charCodeAt(0));
        this.onmessage?.(new MessageEvent('message', { data: bytes.buffer }));
        if (this.socket.readyState === 1) this.socket.send(JSON.stringify({ type: 'ack', seq: message.seq }));
      } catch {
        onFailure('COMPUTER_INVALID_MESSAGE');
        this.close();
        this.onclose?.(new CloseEvent('close', { code: 4400 }));
      }
    };
  }
  send(data: ArrayBuffer | ArrayBufferView): void {
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
      const chunk = bytes.subarray(offset, offset + 32 * 1024);
      let binary = '';
      for (const byte of chunk) binary += String.fromCharCode(byte);
      this.socket.send(JSON.stringify({ type: 'data', data: btoa(binary) }));
    }
  }
  close(): void { this.socket.close(); }
}
