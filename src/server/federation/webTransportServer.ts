import { randomBytes } from 'node:crypto';
import type { ByteDuplex } from './secureProtocol.js';
import { streamDuplex } from './streamDuplex.js';
import { transportCertificate } from './webTransportCertificate.js';
import { WEBTRANSPORT_PATH, WEBTRANSPORT_MAX_STREAMS, type TransportByteStream, type WebTransportDescriptor } from './webTransportProtocol.js';

interface Session {
  ready: Promise<void>;
  closed: Promise<unknown>;
  header?: Record<string, string | undefined>;
  incomingBidirectionalStreams: ReadableStream<TransportByteStream>;
  close(info?: { closeCode: number; reason: string }): void;
}
interface Http3Server {
  ready: Promise<void>;
  closed: Promise<void>;
  startServer(): void;
  stopServer(): void;
  address(): { port: number } | null;
  updateCert(cert: string, key: string, http2only: boolean): void;
  sessionStream(path: string): ReadableStream<Session>;
  setRequestCallback(callback: (request: { header: Record<string, string | undefined> }) => Promise<{ status: number; path: string }>): void;
}
export interface WebTransportServerOptions {
  directory: string;
  host: string;
  port: number;
  hostAllowed(authority: string | undefined): boolean;
  originAllowed(origin: string | undefined, authority: string | undefined): boolean;
  openAccessAllowed(origin: string | undefined, authority: string | undefined): boolean;
  accept(duplex: ByteDuplex, context: { allowOpenAccess: boolean; singleOperation: true }): Promise<void>;
}

export async function startWebTransportServer(options: WebTransportServerOptions) {
  // Optional native support must not become a static build/runtime dependency
  // on platforms without a QUICHE binary. The upstream exports map also lacks
  // a top-level TypeScript condition; keep our small adapter contract explicit.
  const moduleName: string = '@fails-components/webtransport';
  const implementation = await import(moduleName) as { quicheLoaded: Promise<void>; Http3Server: new (options: Record<string, unknown>) => Http3Server };
  await implementation.quicheLoaded;
  let certificate = await transportCertificate(options.directory);
  const raw = new implementation.Http3Server({ host: options.host, port: options.port,
    cert: certificate.cert, privKey: certificate.key, secret: randomBytes(32).toString('hex'),
    initialStreamFlowControlWindow: 256 * 1024, initialSessionFlowControlWindow: 4 * 1024 * 1024,
    streamShouldAutoTuneReceiveWindow: true, streamFlowControlWindowSizeLimit: 2 * 1024 * 1024,
    sessionShouldAutoTuneReceiveWindow: true, sessionFlowControlWindowSizeLimit: 8 * 1024 * 1024,
    initialBidirectionalReceiveStreams: WEBTRANSPORT_MAX_STREAMS,
  }) as unknown as Http3Server;
  const sessions = new Set<Session>();
  const streams = new Set<ByteDuplex>();
  let stopped = false;
  let nativeStopped = false;
  let rotation: ReturnType<typeof setInterval> | undefined;
  const stopNative = () => {
    if (nativeStopped) return;
    try { raw.stopServer(); nativeStopped = true; } catch { /* Still initializing. */ }
  };
  const close = () => {
    if (stopped) return;
    stopped = true; clearInterval(rotation);
    for (const stream of streams) stream.close?.(new Error('QUIC server stopped'));
    for (const session of sessions) session.close({ closeCode: 0, reason: 'Service restarting' });
    // Let RESET_STREAM / CONNECTION_CLOSE reach UDP before destroying the
    // native socket. Closing it in the same turn strands peers until idle timeout.
    const drain = () => { setTimeout(stopNative, 100).unref(); };
    drain();
    void raw.ready.then(drain, () => {});
  };
  raw.setRequestCallback(async ({ header }) => ({
    path: WEBTRANSPORT_PATH,
    status: !stopped && sessions.size < 64 && header[':path'] === WEBTRANSPORT_PATH
      && options.hostAllowed(header[':authority']) && options.originAllowed(header.origin, header[':authority']) ? 200 : 403,
  }));
  const incoming = raw.sessionStream(WEBTRANSPORT_PATH).getReader();
  async function serve(session: Session) {
    if (stopped || sessions.size >= 64) { session.close({ closeCode: 1, reason: 'Connection limit' }); return; }
    sessions.add(session);
    const own = new Set<ByteDuplex>();
    const cleanup = () => {
      sessions.delete(session);
      for (const duplex of own) duplex.close?.(new Error('QUIC session closed'));
    };
    void session.closed.then(cleanup, cleanup);
    await session.ready;
    const reader = session.incomingBidirectionalStreams.getReader();
    try {
      while (!stopped) {
        const { done, value } = await reader.read(); if (done) return;
        const duplex = streamDuplex(value);
        if (own.size >= WEBTRANSPORT_MAX_STREAMS || streams.size >= 256) { duplex.close?.(new Error('Stream limit')); continue; }
        own.add(duplex); streams.add(duplex);
        const context = { allowOpenAccess: options.openAccessAllowed(session.header?.origin, session.header?.[':authority']), singleOperation: true as const };
        void options.accept(duplex, context).catch(() => duplex.close?.(new Error('Secure stream failed')))
          .finally(() => { own.delete(duplex); streams.delete(duplex); });
      }
    } finally { reader.releaseLock(); cleanup(); }
  }
  void (async () => {
    try {
      while (!stopped) {
        const { done, value } = await incoming.read(); if (done) return;
        void serve(value).catch(() => value.close({ closeCode: 1, reason: 'Invalid stream' }));
      }
    } catch { /* Native shutdown ends this reader. */ }
    finally { incoming.releaseLock(); }
  })();
  void raw.closed.then(close, close);
  raw.startServer();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([raw.ready, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('QUIC listener startup timed out')), 5000); })]);
    const port = raw.address()?.port;
    if (!port) throw new Error('QUIC listener has no port');
    rotation = setInterval(() => {
      if (certificate.expiresAt > Date.now() + 3 * 86400_000) return;
      void transportCertificate(options.directory).then(next => {
        if (stopped || next.hash === certificate.hash) return;
        raw.updateCert(next.cert, next.key, false); certificate = next;
      }).catch(() => { /* Keep the previous certificate; expired descriptors are rejected. */ });
    }, 60 * 60_000);
    rotation.unref();
    return {
      close,
      descriptor(): WebTransportDescriptor | undefined {
        return stopped || certificate.expiresAt <= Date.now() ? undefined : {
          version: 1, port, path: WEBTRANSPORT_PATH, certificateHash: certificate.hash, expiresAt: certificate.expiresAt,
        };
      },
      stats: () => ({ sessions: sessions.size, streams: streams.size }),
    };
  } catch (error) { close(); throw error; }
  finally { clearTimeout(timer); }
}
