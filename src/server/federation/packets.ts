import type { ByteDuplex } from './secureProtocol.js';

/** Bounded queues are also used at the untrusted, pre-handshake boundary. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private wake?: () => void;
  private ended = false;
  private error?: Error;
  constructor(private limit = 64) {}
  /** Try to enqueue without changing the fail-closed behavior of push(). */
  tryPush(value: T): boolean {
    if (this.ended) throw new Error('Channel closed');
    if (this.items.length >= this.limit) return false;
    this.items.push(value); this.wake?.(); return true;
  }
  push(value: T): void {
    if (this.ended) throw new Error('Channel closed');
    if (this.items.length >= this.limit) { this.end(new Error('Channel queue exceeded')); throw this.error; }
    this.items.push(value); this.wake?.();
  }
  get size(): number { return this.items.length; }
  end(error?: Error): void { this.ended = true; this.error ??= error; this.wake?.(); }
  clear(): void { this.items.length = 0; }
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
interface QueuedPacket { id: string; bytes: Uint8Array }
export class PacketQueueBackpressureError extends Error {
  readonly code = 'PACKET_QUEUE_BACKPRESSURE';
  constructor(message = 'Record queue capacity exceeded') { super(message); this.name = 'PacketQueueBackpressureError'; }
}
const MAX_PACKET = 2 * 1024 * 1024;
const MAX_BUFFERED_PACKET_BYTES = MAX_PACKET * 2 + 8;
const READ_BLOCK_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Application records live entirely inside Noise; transport routing never sees them. */
export class PacketChannel {
  private outgoing = new AsyncQueue<QueuedPacket>(256);
  private outgoingBytes = 0;
  private queuedBytesById = new Map<string, number>();
  private closed = false;
  get hasPendingWrites(): boolean { return this.outgoingBytes > 0; }
  queuedBytesFor(id: string): number { return this.queuedBytesById.get(id) ?? 0; }
  readonly done: Promise<void>;
  constructor(private duplex: ByteDuplex) {
    const self = this;
    this.done = duplex.sink((async function* () {
      for await (const packet of self.outgoing) {
        try { yield packet.bytes; } finally { self.releaseQueuedPacket(packet); }
      }
    })());
    void this.done.then(
      () => this.discardPending(),
      error => this.discardPending(error instanceof Error ? error : new Error('Transport failed')),
    );
  }
  send(packet: Packet): void {
    // The item-count cap protects against floods of tiny records. Check it
    // before encoding and keep this queue alive when it is temporarily full.
    if (this.outgoing.size >= 256) throw new PacketQueueBackpressureError('Record queue item limit exceeded');
    const body = encoder.encode(JSON.stringify(packet));
    if (body.length > MAX_PACKET) throw new Error('Record too large');
    const bytes = new Uint8Array(body.length + 4);
    new DataView(bytes.buffer).setUint32(0, body.length);
    bytes.set(body, 4);
    if (this.outgoingBytes + bytes.byteLength > 4 * 1024 * 1024) throw new PacketQueueBackpressureError('Record queue byte budget exceeded');
    const queued = { id: packet.id, bytes };
    if (!this.outgoing.tryPush(queued)) throw new PacketQueueBackpressureError('Record queue item limit exceeded');
    this.outgoingBytes += bytes.byteLength;
    this.queuedBytesById.set(packet.id, this.queuedBytesFor(packet.id) + bytes.byteLength);
  }
  private releaseQueuedPacket(packet: QueuedPacket): void {
    this.outgoingBytes = Math.max(0, this.outgoingBytes - packet.bytes.byteLength);
    const current = this.queuedBytesById.get(packet.id);
    if (current === undefined) return;
    const remaining = current - packet.bytes.byteLength;
    if (remaining > 0) this.queuedBytesById.set(packet.id, remaining);
    else this.queuedBytesById.delete(packet.id);
  }
  close(error?: Error): void {
    // Closing the duplex stops transport delivery, so queued records cannot
    // be described as drained. Discard them and release their accounting.
    this.discardPending(error);
  }
  abort(error: Error): void {
    this.discardPending(error);
  }
  private discardPending(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.outgoing.clear();
    this.outgoing.end(error);
    this.outgoingBytes = 0;
    this.queuedBytesById.clear();
    this.duplex.close?.(error);
  }
  async *read(): AsyncGenerator<Packet> {
    // Coalesce transport fragments into fixed blocks so a byte-at-a-time
    // source cannot create millions of retained typed-array objects.
    interface Segment { readonly bytes: Uint8Array; start: number; end: number }
    const segments: Array<Segment | undefined> = [];
    let firstSegment = 0;
    let bufferedBytes = 0;
    let spareBlock: Uint8Array | undefined;
    const parseFrame = (frame: Uint8Array): Packet => {
      const packet: unknown = JSON.parse(decoder.decode(frame.subarray(4)));
      if (!packet || typeof packet !== 'object' || typeof (packet as Packet).id !== 'string' || typeof (packet as Packet).type !== 'string') throw new Error('Invalid record');
      return packet as Packet;
    };
    const append = (chunk: Uint8Array): void => {
      let offset = 0;
      while (offset < chunk.byteLength) {
        let tail = segments[segments.length - 1];
        if (!tail || tail.end === tail.bytes.byteLength) {
          tail = { bytes: spareBlock ?? new Uint8Array(READ_BLOCK_BYTES), start: 0, end: 0 };
          spareBlock = undefined;
          segments.push(tail);
        }
        const take = Math.min(chunk.byteLength - offset, tail.bytes.byteLength - tail.end);
        tail.bytes.set(chunk.subarray(offset, offset + take), tail.end);
        tail.end += take;
        offset += take;
      }
      bufferedBytes += chunk.byteLength;
    };
    const byteAt = (offset: number): number => {
      let index = firstSegment;
      let position = offset;
      while (index < segments.length) {
        const segment = segments[index];
        if (!segment) { index++; continue; }
        const available = segment.end - segment.start;
        if (position < available) return segment.bytes[segment.start + position];
        position -= available;
        index++;
      }
      throw new Error('Incomplete record header');
    };
    const advance = (length: number): void => {
      bufferedBytes -= length;
      while (length > 0) {
        const segment = segments[firstSegment];
        if (!segment) { firstSegment++; continue; }
        const take = Math.min(length, segment.end - segment.start);
        segment.start += take;
        length -= take;
        if (segment.start === segment.end) {
          if (!spareBlock && segment.bytes.byteLength === READ_BLOCK_BYTES) spareBlock = segment.bytes;
          segments[firstSegment] = undefined;
          firstSegment++;
        }
      }
      if (bufferedBytes === 0) {
        segments.length = 0;
        firstSegment = 0;
        spareBlock = undefined;
      } else if (firstSegment >= 64 && firstSegment * 2 >= segments.length) {
        segments.splice(0, firstSegment);
        firstSegment = 0;
      }
    };
    const recordBytes = (length: number): Uint8Array => {
      const first = segments[firstSegment];
      if (!first) throw new Error('Incomplete record body');
      const available = first.end - first.start;
      if (available >= length) {
        const result = first.bytes.subarray(first.start, first.start + length);
        advance(length);
        return result;
      }
      const result = new Uint8Array(length);
      let index = firstSegment;
      let written = 0;
      while (written < length) {
        const segment = segments[index];
        if (!segment) { index++; continue; }
        const take = Math.min(length - written, segment.end - segment.start);
        result.set(segment.bytes.subarray(segment.start, segment.start + take), written);
        written += take;
        index++;
      }
      advance(length);
      return result;
    };
    for await (const chunk of this.duplex.source) {
      if (bufferedBytes + chunk.byteLength > MAX_BUFFERED_PACKET_BYTES) throw new Error('Record buffer exceeded');
      if (bufferedBytes === 0 && chunk.byteLength >= 5) {
        const size = ((chunk[0] * 0x1000000) + (chunk[1] << 16) + (chunk[2] << 8) + chunk[3]) >>> 0;
        if (size > MAX_PACKET || size === 0) throw new Error('Invalid record size');
        if (chunk.byteLength === size + 4) {
          yield parseFrame(chunk);
          continue;
        }
      }
      if (chunk.byteLength) append(chunk);
      while (bufferedBytes >= 4) {
        const size = ((byteAt(0) * 0x1000000) + (byteAt(1) << 16) + (byteAt(2) << 8) + byteAt(3)) >>> 0;
        if (size > MAX_PACKET || size === 0) throw new Error('Invalid record size');
        if (bufferedBytes < size + 4) break;
        const frame = recordBytes(size + 4);
        yield parseFrame(frame);
      }
    }
    if (bufferedBytes) throw new Error('Truncated record');
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
