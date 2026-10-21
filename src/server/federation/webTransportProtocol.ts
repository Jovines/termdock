export const WEBTRANSPORT_PATH = '/api/federation/transport';
export const WEBTRANSPORT_CONNECT_TIMEOUT_MS = 4000;
export const WEBTRANSPORT_STREAM_TIMEOUT_MS = 4000;
export const WEBTRANSPORT_MAX_STREAMS = 128;

/** Advertised only inside an authenticated Noise permission response. */
export interface WebTransportDescriptor {
  version: 1;
  port: number;
  path: typeof WEBTRANSPORT_PATH;
  certificateHash: string;
  expiresAt: number;
}

export interface TransportByteStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

export function readWebTransportDescriptor(value: unknown, now = Date.now()): WebTransportDescriptor | undefined {
  if (!value || typeof value !== 'object') return;
  const d = value as WebTransportDescriptor;
  if (d.version !== 1 || d.path !== WEBTRANSPORT_PATH || !Number.isSafeInteger(d.port) || d.port < 1 || d.port > 65535
    || typeof d.certificateHash !== 'string' || !/^[a-f0-9]{64}$/.test(d.certificateHash)
    || !Number.isSafeInteger(d.expiresAt) || d.expiresAt <= now || d.expiresAt > now + 14 * 86400_000) return;
  return { version: 1, path: WEBTRANSPORT_PATH, port: d.port, certificateHash: d.certificateHash, expiresAt: d.expiresAt };
}

/** Cancel the operation, including late arrivals, rather than leaving a timed
 * out stream/handshake attached to a live session. */
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal, cancel: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cancel(); reject(signal.reason ?? new Error('Transport aborted')); };
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}
