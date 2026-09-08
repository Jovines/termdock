import type { ByteDuplex } from './secureProtocol.js';

/** Bounded queues are also used at the untrusted, pre-handshake boundary. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private wake?: () => void;
  private ended = false;
  private error?: Error;
  constructor(private limit = 64) {}
  push(value: T): void {
    if (this.ended) throw new Error('Channel closed');
    if (this.items.length >= this.limit) { this.end(new Error('Channel queue exceeded')); throw this.error; }
    this.items.push(value); this.wake?.();
  }
  end(error?: Error): void { this.ended = true; this.error ??= error; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.error) throw this.error;
      const item = this.items.shift();
      if (item !== undefined) { yield item; continue; }
      if (this.ended) return;
      await new Promise<void>(resolve => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

export interface Packet { type: string; id: string; [key: string]: unknown }
const MAX_PACKET = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Application records live entirely inside Noise; transport routing never sees them. */
export class PacketChannel {
  private outgoing = new AsyncQueue<Uint8Array>(256);
  private outgoingBytes = 0;
  readonly done: Promise<void>;
  constructor(private duplex: ByteDuplex) {
    const self = this;
    this.done = duplex.sink((async function* () {
      for await (const bytes of self.outgoing) {
        try { yield bytes; } finally { self.outgoingBytes -= bytes.byteLength; }
      }
    })());
    void this.done.catch(error => this.close(error instanceof Error ? error : new Error('Transport failed')));
  }
  send(packet: Packet): void {
    const body = encoder.encode(JSON.stringify(packet));
    if (body.length > MAX_PACKET) throw new Error('Record too large');
    const bytes = new Uint8Array(body.length + 4);
    new DataView(bytes.buffer).setUint32(0, body.length);
    bytes.set(body, 4);
    if (this.outgoingBytes + bytes.byteLength > 4 * 1024 * 1024) throw new Error('Record queue byte budget exceeded');
    this.outgoingBytes += bytes.byteLength;
    try { this.outgoing.push(bytes); } catch (error) { this.outgoingBytes -= bytes.byteLength; throw error; }
  }
  close(error?: Error): void { this.outgoing.end(error); this.duplex.close?.(error); }
  async *read(): AsyncGenerator<Packet> {
    let pending = new Uint8Array(0);
    for await (const chunk of this.duplex.source) {
      if (pending.length + chunk.length > MAX_PACKET * 2 + 8) throw new Error('Record buffer exceeded');
      const next = new Uint8Array(pending.length + chunk.length);
      next.set(pending); next.set(chunk, pending.length); pending = next;
      while (pending.length >= 4) {
        const size = new DataView(pending.buffer, pending.byteOffset, 4).getUint32(0);
        if (size > MAX_PACKET || size === 0) throw new Error('Invalid record size');
        if (pending.length < size + 4) break;
        const packet: unknown = JSON.parse(decoder.decode(pending.subarray(4, size + 4)));
        if (!packet || typeof packet !== 'object' || typeof (packet as Packet).id !== 'string' || typeof (packet as Packet).type !== 'string') throw new Error('Invalid record');
        yield packet as Packet;
        pending = pending.slice(size + 4);
      }
    }
    if (pending.length) throw new Error('Truncated record');
  }
}

export function toBase64(bytes: Uint8Array): string {
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value);
}
export function fromBase64(value: string): Uint8Array {
  const raw = atob(value); return Uint8Array.from(raw, c => c.charCodeAt(0));
}
