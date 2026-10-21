import { secureConnection, type ByteDuplex, type Identity } from '../../server/federation/secureProtocol.js';
import { streamDuplex } from '../../server/federation/streamDuplex.js';
import { abortable, WEBTRANSPORT_CONNECT_TIMEOUT_MS, WEBTRANSPORT_STREAM_TIMEOUT_MS, type TransportByteStream, type WebTransportDescriptor } from '../../server/federation/webTransportProtocol.js';
import type { ConnectionDiagnostics } from './connectionDiagnostics.js';

export interface BrowserWebTransport {
  ready: Promise<void>;
  closed: Promise<unknown>;
  createBidirectionalStream(options?: { sendOrder: number }): Promise<TransportByteStream>;
  close(info?: { closeCode: number; reason: string }): void;
}
export type WebTransportFactory = (url: string, options: { serverCertificateHashes: Array<{ algorithm: 'sha-256'; value: ArrayBuffer }> }) => BrowserWebTransport;
export interface StreamConnection { duplex: ByteDuplex; diagnostics: ConnectionDiagnostics }
export interface SecureStreamPool {
  readonly available: boolean;
  readonly closed: Promise<void>;
  open(kind: 'socket' | 'http', signal?: AbortSignal): Promise<StreamConnection>;
  close(): void;
}

export function nativeWebTransportFactory(): WebTransportFactory | undefined {
  const Constructor = (globalThis as unknown as { WebTransport?: new (url: string, options: unknown) => BrowserWebTransport }).WebTransport;
  return Constructor ? (url, options) => new Constructor(url, options) : undefined;
}

/** Each application stream gets its own Noise handshake, keys and record order.
 * No terminal input or HTTP operation is replayed when this transport fails. */
export async function connectWebTransport(options: {
  baseUrl: string; descriptor: WebTransportDescriptor; identity: Identity; targetPeerId: string;
  factory: WebTransportFactory; signal?: AbortSignal;
}): Promise<SecureStreamPool> {
  const url = new URL(options.baseUrl);
  if (!['wss:', 'https:'].includes(url.protocol)) throw new Error('QUIC requires a secure service origin');
  url.protocol = 'https:'; url.port = String(options.descriptor.port); url.pathname = options.descriptor.path; url.search = ''; url.hash = '';
  // A v4 listener's localhost QUIC lookup may select ::1 without trying v4.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  const certificateHash = Uint8Array.from(options.descriptor.certificateHash.match(/../g)!, value => parseInt(value, 16));
  const started = performance.now();
  const transport = options.factory(url.href, { serverCertificateHashes: [{ algorithm: 'sha-256', value: certificateHash.buffer }] });
  let available = false, stopped = false;
  const active = new Set<ByteDuplex>();
  const lifetime = new AbortController();
  const close = () => {
    if (stopped) return;
    stopped = true; available = false; lifetime.abort(new Error('QUIC session closed'));
    options.signal?.removeEventListener('abort', close);
    for (const duplex of active) duplex.close?.(new Error('QUIC session closed'));
    transport.close({ closeCode: 0, reason: 'Secure session closed' });
  };
  void transport.closed.then(close, close);
  options.signal?.addEventListener('abort', close, { once: true });
  const connectSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(WEBTRANSPORT_CONNECT_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
  try { await abortable(transport.ready, connectSignal, close); }
  catch (error) { close(); throw error; }
  available = true;
  const transportOpenMs = performance.now() - started;
  return {
    get available() { return available && !stopped && options.descriptor.expiresAt > Date.now(); },
    closed: transport.closed.then(() => undefined, () => undefined),
    close,
    async open(kind, signal) {
      if (!available || stopped) throw new Error('QUIC session unavailable');
      const deadline = AbortSignal.any([lifetime.signal, AbortSignal.timeout(WEBTRANSPORT_STREAM_TIMEOUT_MS), ...(signal ? [signal] : [])]);
      const opened = transport.createBidirectionalStream({ sendOrder: kind === 'socket' ? 10 : 0 });
      // A stream arriving after cancellation must be reset, not leaked.
      void opened.then(stream => { if (deadline.aborted) streamDuplex(stream).close?.(new Error('Stream cancelled')); }, () => {});
      const stream = await abortable(opened, deadline, () => {});
      const duplex = streamDuplex(stream);
      const originalClose = duplex.close;
      duplex.close = error => { active.delete(duplex); originalClose?.(error); };
      active.add(duplex);
      const handshakeAt = performance.now();
      try {
        const secured = await secureConnection({ identity: options.identity, initiator: true, targetPinnedPeerId: options.targetPeerId, duplex, signal: deadline });
        return { duplex: { ...secured.duplex, bufferedBytes: duplex.bufferedBytes }, diagnostics: {
          endpoint: url.host, path: 'direct', targetPeerId: secured.authenticatedPeerId, transport: 'webtransport',
          transportOpenMs, handshakeMs: performance.now() - handshakeAt, establishedAt: Date.now(),
          bufferedBytes: 0, pendingWrites: false, activeRequests: 0, waitingRequests: 0,
        } };
      } catch (error) { duplex.close?.(error instanceof Error ? error : new Error('Secure stream failed')); throw error; }
    },
  };
}
