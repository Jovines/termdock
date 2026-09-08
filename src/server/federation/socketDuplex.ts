import type { ByteDuplex } from './secureProtocol.js';
import { AsyncQueue } from './packets.js';

export interface WireSocket {
  readyState: number;
  bufferedAmount: number;
  binaryType: string;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}
export function socketDuplex(socket: WireSocket): ByteDuplex {
  const input = new AsyncQueue<Uint8Array>(64);
  socket.binaryType = 'arraybuffer';
  const close = (error?: Error) => { input.end(error); socket.close(1000); };
  socket.addEventListener('message', event => {
    try {
      if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > 1024 * 1024) throw new Error('Invalid encrypted frame');
      input.push(new Uint8Array(event.data));
    } catch { close(new Error('Encrypted transport rejected frame')); }
  });
  socket.addEventListener('close', () => input.end());
  socket.addEventListener('error', () => input.end(new Error('Encrypted transport disconnected')));
  return {
    source: input, close,
    async sink(source) {
      try {
        for await (const chunk of source) {
          for (let offset = 0; offset < chunk.length; offset += 64 * 1024) {
            const started = Date.now();
            while (socket.bufferedAmount > 256 * 1024) {
              if (socket.readyState !== 1 || Date.now() - started > 15000) throw new Error('Encrypted transport congested');
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            if (socket.readyState !== 1) throw new Error('Encrypted transport closed');
            socket.send(chunk.subarray(offset, offset + 64 * 1024));
          }
        }
      } catch (error) { close(error instanceof Error ? error : new Error('Encrypted transport failed')); throw error; }
    },
  };
}
