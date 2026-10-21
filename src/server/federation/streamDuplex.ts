import type { ByteDuplex } from './secureProtocol.js';
import type { TransportByteStream } from './webTransportProtocol.js';

/** One reliable QUIC stream carries one independently authenticated Noise
 * channel. Closing it never closes unrelated streams in the QUIC session. */
export function streamDuplex(stream: TransportByteStream): ByteDuplex {
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  let closed = false;
  let writingBytes = 0;
  const close = (error?: Error) => {
    if (closed) return;
    closed = true;
    void reader.cancel(error).catch(() => {});
    void (error ? writer.abort(error) : writer.close()).catch(() => {});
  };
  return {
    close,
    bufferedBytes: () => writingBytes,
    source: {
      async *[Symbol.asyncIterator]() {
        try {
          while (!closed) {
            const { done, value } = await reader.read();
            if (done) return;
            if (!(value instanceof Uint8Array)) throw new Error('Invalid transport stream bytes');
            yield value;
          }
        } finally { reader.releaseLock(); }
      },
    },
    async sink(source) {
      try {
        for await (const chunk of source) {
          for (let offset = 0; offset < chunk.byteLength; offset += 64 * 1024) {
            if (closed) throw new Error('Transport stream closed');
            const bytes = chunk.subarray(offset, offset + 64 * 1024);
            writingBytes = bytes.byteLength;
            try { await writer.write(bytes); } finally { writingBytes = 0; }
          }
        }
        await writer.close();
      } catch (error) { close(error instanceof Error ? error : new Error('Transport stream failed')); throw error; }
      finally { writer.releaseLock(); }
    },
  };
}
