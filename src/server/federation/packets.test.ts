import { describe, expect, it, vi } from 'vitest';
import { PacketChannel, PacketQueueBackpressureError, type Packet } from './packets.js';

const encoder = new TextEncoder();
function frame(body: Uint8Array): Uint8Array {
  const result = new Uint8Array(body.byteLength + 4);
  new DataView(result.buffer).setUint32(0, body.byteLength);
  result.set(body, 4);
  return result;
}
function packet(value: Packet): Uint8Array { return frame(encoder.encode(JSON.stringify(value))); }
function fragmented(bytes: Uint8Array, sizes: number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0, index = 0;
  while (offset < bytes.byteLength) {
    const size = sizes[index++ % sizes.length];
    chunks.push(bytes.subarray(offset, Math.min(offset + size, bytes.byteLength)));
    offset += size;
  }
  return chunks;
}
async function readAll(source: AsyncIterable<Uint8Array>): Promise<Packet[]> {
  const channel = new PacketChannel({ source, sink: async outgoing => { for await (const _ of outgoing) { /* drain */ } } });
  try {
    const packets: Packet[] = [];
    for await (const value of channel.read()) packets.push(value);
    return packets;
  } finally { channel.close(); await channel.done; }
}
const sourceOf = (chunks: Uint8Array[]): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; },
});

describe('PacketChannel fragmented record reader', () => {
  it('parses one complete source frame before yielding without retaining its bytes', async () => {
    const bytes = packet({ type: 'data', id: 'complete-frame', text: 'safe after parse' });
    const channel = new PacketChannel({
      source: {
        async *[Symbol.asyncIterator]() {
          yield bytes;
          bytes.fill(0); // The yielded packet must already own decoded values.
        },
      },
      sink: async outgoing => { for await (const _ of outgoing) { /* drain */ } },
    });
    try {
      const reader = channel.read();
      expect(await reader.next()).toEqual({ done: false, value: { type: 'data', id: 'complete-frame', text: 'safe after parse' } });
      expect(await reader.next()).toEqual({ done: true, value: undefined });
    } finally { channel.close(); await channel.done; }
  });

  it('keeps the fragmented path for multiple records carried by one source chunk', async () => {
    const first = { type: 'data', id: 'first', text: 'a' };
    const second = { type: 'data', id: 'second', text: 'b' };
    const joined = new Uint8Array([...packet(first), ...packet(second)]);
    expect(await readAll(sourceOf([joined]))).toEqual([first, second]);
  });

  it('handles split headers, split UTF-8 bodies, and multiple records in order', async () => {
    const expected = [
      { type: 'data', id: 'one', text: 'héllo 🖥️' },
      { type: 'data', id: 'two', text: 'second' },
    ];
    const joined = new Uint8Array([...packet(expected[0]), ...packet(expected[1])]);
    expect(await readAll(sourceOf(fragmented(joined, [1, 2, 3, 5, 8])))).toEqual(expected);
  });

  it('owns fragments while waiting for the rest of a record', async () => {
    // Node Buffers override .slice() to return a view; the reader still has
    // to own a stable copy of each fragment before asking the source for more.
    const bytes = Buffer.from(packet({ type: 'data', id: 'stable', text: 'payload' }));
    const first = bytes.subarray(0, 7);
    const rest = bytes.subarray(7);
    const source: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() { yield first; first.fill(0); yield rest; },
    };
    expect(await readAll(source)).toEqual([{ type: 'data', id: 'stable', text: 'payload' }]);
  });

  it('accepts byte-at-a-time fragments without losing a record', async () => {
    const expected = { type: 'data', id: 'tiny-fragments', text: 'x'.repeat(64 * 1024) };
    const bytes = packet(expected);
    const source: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        for (let offset = 0; offset < bytes.byteLength; offset++) yield bytes.subarray(offset, offset + 1);
      },
    };
    expect(await readAll(source)).toEqual([expected]);
  });

  it('rejects malformed lengths, invalid UTF-8, invalid records, truncation, and excessive buffering', async () => {
    const length = (size: number) => { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, size); return bytes; };
    await expect(readAll(sourceOf([length(0)]))).rejects.toThrow('Invalid record size');
    await expect(readAll(sourceOf([length(2 * 1024 * 1024 + 1)]))).rejects.toThrow('Invalid record size');
    await expect(readAll(sourceOf([new Uint8Array([0, 0, 0, 1, 0xff])]))).rejects.toThrow();
    await expect(readAll(sourceOf([frame(encoder.encode('{}'))]))).rejects.toThrow('Invalid record');
    await expect(readAll(sourceOf([new Uint8Array([0, 0, 0])]))).rejects.toThrow('Truncated record');
    await expect(readAll(sourceOf([new Uint8Array(2 * 1024 * 1024 * 2 + 9)]))).rejects.toThrow('Record buffer exceeded');
  });
});

describe('PacketChannel queued byte accounting', () => {
  it('counts encoded bytes per id until the sink completes the write', async () => {
    let startWrite!: () => void;
    let finishWrite!: () => void;
    let release!: () => void;
    const writing = new Promise<void>(resolve => { startWrite = resolve; });
    const finished = new Promise<void>(resolve => { finishWrite = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const channel = new PacketChannel({
      source: sourceOf([]),
      sink: async outgoing => {
        for await (const _ of outgoing) {
          startWrite();
          await gate;
          finishWrite();
          break;
        }
      },
    });
    const value = { type: 'data', id: 'same-id', payload: 'é' };
    const expectedBytes = frame(encoder.encode(JSON.stringify(value))).byteLength;
    channel.send(value);
    await writing;
    expect(channel.queuedBytesFor(value.id)).toBe(expectedBytes);
    expect(channel.queuedBytesFor('other-id')).toBe(0);
    release();
    await finished;
    await channel.done;
    expect(channel.queuedBytesFor(value.id)).toBe(0);
  });

  it('clears per-id accounting on close or sink failure', async () => {
    let startWrite!: () => void;
    let release!: () => void;
    const writing = new Promise<void>(resolve => { startWrite = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const channel = new PacketChannel({
      source: sourceOf([]),
      sink: async outgoing => {
        for await (const _ of outgoing) { startWrite(); await gate; throw new Error('sink failed'); }
      },
    });
    channel.send({ type: 'data', id: 'failed-id', sequence: 1 });
    await writing;
    channel.send({ type: 'data', id: 'failed-id', sequence: 2 });
    channel.send({ type: 'data', id: 'another-id' });
    expect(channel.hasPendingWrites).toBe(true);
    expect(channel.queuedBytesFor('failed-id')).toBeGreaterThan(0);
    channel.abort(new Error('cancel pending writes'));
    expect(channel.hasPendingWrites).toBe(false);
    expect(channel.queuedBytesFor('failed-id')).toBe(0);
    expect(channel.queuedBytesFor('another-id')).toBe(0);
    release();
    await channel.done.catch(() => undefined);
    expect(channel.hasPendingWrites).toBe(false);
    expect(channel.queuedBytesFor('failed-id')).toBe(0);
  });

  it('discards residual records and accounting when the sink completes early', async () => {
    let started!: () => void;
    const writing = new Promise<void>(resolve => { started = resolve; });
    const closeDuplex = vi.fn();
    const channel = new PacketChannel({
      source: sourceOf([]),
      sink: async outgoing => {
        for await (const _ of outgoing) { started(); break; }
      },
      close: closeDuplex,
    });
    channel.send({ type: 'data', id: 'early-sink', sequence: 0 });
    await writing;
    channel.send({ type: 'data', id: 'early-sink', sequence: 1 });
    channel.send({ type: 'data', id: 'other-owner', sequence: 2 });
    expect(channel.hasPendingWrites).toBe(true);
    expect(channel.queuedBytesFor('early-sink')).toBeGreaterThan(0);
    await channel.done;
    await Promise.resolve(); // Run the done-finalizer that releases queued records.
    expect(channel.hasPendingWrites).toBe(false);
    expect(channel.queuedBytesFor('early-sink')).toBe(0);
    expect(channel.queuedBytesFor('other-owner')).toBe(0);
    channel.close();
    channel.close();
    expect(closeDuplex).toHaveBeenCalledTimes(1);
    expect(channel.hasPendingWrites).toBe(false);
  });

  it('throws a typed refusal before accepting a record when the byte budget is full', async () => {
    let startWrite!: () => void;
    let release!: () => void;
    const writing = new Promise<void>(resolve => { startWrite = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const channel = new PacketChannel({
      source: sourceOf([]),
      sink: async outgoing => { for await (const _ of outgoing) { startWrite(); await gate; } },
    });
    const payload = 'x'.repeat(500_000);
    for (let sequence = 0; sequence < 8; sequence++) channel.send({ type: 'data', id: 'queue-owner', sequence, payload });
    await writing;
    const acceptedBytes = channel.queuedBytesFor('queue-owner');
    expect(acceptedBytes).toBeGreaterThan(4_000_000);
    expect(() => channel.send({ type: 'data', id: 'queue-owner', sequence: 9, payload }))
      .toThrow(PacketQueueBackpressureError);
    expect(channel.queuedBytesFor('queue-owner')).toBe(acceptedBytes);
    channel.abort(new Error('test complete'));
    release();
    await channel.done.catch(() => undefined);
  });

  it('refuses a 257th queued small record without ending the shared queue', async () => {
    let started!: () => void;
    let release!: () => void;
    let drained!: () => void;
    const writing = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const allWritten = new Promise<void>(resolve => { drained = resolve; });
    const written: Uint8Array[] = [];
    const channel = new PacketChannel({
      source: sourceOf([]),
      sink: async outgoing => {
        for await (const bytes of outgoing) {
          started();
          await gate;
          written.push(bytes);
          if (written.length === 257) { drained(); break; }
        }
      },
    });
    channel.send({ type: 'data', id: 'small-stream', sequence: 0 });
    await writing; // One record is in flight; the bounded queue itself is empty.
    for (let sequence = 1; sequence <= 256; sequence++) {
      channel.send({ type: 'data', id: 'small-stream', sequence });
    }
    const pendingBytes = channel.queuedBytesFor('small-stream');
    expect(pendingBytes).toBeGreaterThan(0);
    expect(() => channel.send({ type: 'data', id: 'small-stream', sequence: 257 }))
      .toThrow(PacketQueueBackpressureError);
    expect(channel.queuedBytesFor('small-stream')).toBe(pendingBytes);
    expect(channel.hasPendingWrites).toBe(true);

    release();
    await allWritten;
    await channel.done;
    expect(written).toHaveLength(257);
    expect(channel.queuedBytesFor('small-stream')).toBe(0);
    expect(channel.hasPendingWrites).toBe(false);
  });
});
