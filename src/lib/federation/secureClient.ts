import { createIdentity, secureConnection, MAX_SECURE_CONNECTION_AGE_MS, type Identity } from '../../server/federation/secureProtocol.js';
import { TRANSPORT_RENEWED_CODE, TRANSPORT_RENEWED_REASON } from './transportLifecycle.js';
import { AsyncQueue, PacketChannel, fromBase64, toBase64, type Packet } from '../../server/federation/packets.js';
import { socketDuplex } from '../../server/federation/socketDuplex.js';
import { MAX_ACTIVE_HTTP_REQUESTS, MAX_OPEN_SECURE_SOCKETS } from '../../server/federation/streamLimits.js';

export interface SecureClientOptions {
  url: string;
  targetPeerId: string;
  identity?: Identity;
  pairingCode?: string;
  signal?: AbortSignal;
  socketFactory?: (url: string) => WebSocket;
}
const MAX_REQUEST_BYTES = 5 * 1024 * 1024;
const MAX_PENDING = MAX_OPEN_SECURE_SOCKETS + MAX_ACTIVE_HTTP_REQUESTS + 8;
const MAX_WAITING = 256;
const REQUEST_IDLE_MS = 30_000;
const CHUNK_BYTES = 64 * 1024;
type OperationKind = 'http' | 'socket' | 'request';
interface Pending { queue: AsyncQueue<Packet>; kind: OperationKind; socket?: SecureSocket; cancelUpload?: () => void }
interface Allocation { id: string; queue: AsyncQueue<Packet> }
interface Waiter { kind: OperationKind; resolve: (allocation: Allocation) => void; reject: (reason: unknown) => void; cleanup: () => void }
function failure(value: unknown): Error { return value instanceof Error ? value : new Error(String(value ?? 'Secure connection closed')); }
function pathOnly(input: string): string {
  if (!input.startsWith('/') || input.startsWith('//') || input.includes('#')) throw new Error('A local API path is required');
  return input;
}

/** WebSocket-shaped logical endpoint; its contents stay inside the authenticated Noise channel. */
export class SecureSocket extends EventTarget {
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3;
  readonly binaryType = 'arraybuffer'; readonly bufferedAmount = 0;
  readonly protocol = 'termdock-e2ee-v1'; readonly extensions = '';
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  constructor(readonly url: string, private transmit: (data: string) => void, private disconnect: () => void) { super(); }
  send(data: string) {
    if (this.readyState !== 1) throw new Error('Secure socket is not open');
    if (typeof data !== 'string' || new TextEncoder().encode(data).length > 1024 * 1024) throw new Error('Unsupported socket payload');
    this.transmit(data);
  }
  close(code = 1000, reason = '') { if (this.readyState === 3) return; this.disconnect(); this.finish(code, reason); }
  accept(packet: Packet) {
    if (this.readyState === 3) return;
    if (packet.type === 'ws-ready') { this.readyState = 1; const e = new Event('open'); this.dispatchEvent(e); this.onopen?.(e); }
    else if (packet.type === 'ws-data' && typeof packet.data === 'string') {
      const e = new MessageEvent('message', { data: packet.data }); this.dispatchEvent(e); this.onmessage?.(e);
    } else if (packet.type === 'ws-close') this.finish(typeof packet.code === 'number' ? packet.code : 1000, typeof packet.reason === 'string' ? packet.reason : '');
    else if (packet.type === 'error') this.fail(failure(packet.error));
  }
  fail(error: Error) { if (this.readyState === 3) return; const e = new Event('error'); this.dispatchEvent(e); this.onerror?.(e); this.finish(1006, error.message); }
  private finish(code: number, reason: string) {
    if (this.readyState === 3) return; this.readyState = 3;
    const e = new CloseEvent('close', { code, reason, wasClean: code === 1000 }); this.dispatchEvent(e); this.onclose?.(e);
  }
}

export class SecureClient {
  private readonly establishedAt = performance.now();
  private readonly establishedWallTime = Date.now();
  private lastInputAt = -Infinity;
  private pending = new Map<string, Pending>();
  private waiting: Waiter[] = [];
  private stopped = false;
  private closeReason?: Error;
  get canSwitchTransport(): boolean {
    return !this.channel.hasPendingWrites && performance.now() - this.lastInputAt >= 2000
      && ![...this.pending.values()].some(operation => operation.kind !== 'socket')
      && !this.waiting.some(operation => operation.kind !== 'socket');
  }
  get renewalDue(): boolean {
    return !this.stopped && Math.max(performance.now() - this.establishedAt, Date.now() - this.establishedWallTime)
      >= MAX_SECURE_CONNECTION_AGE_MS - 5 * 60_000;
  }
  get closed(): boolean { return this.stopped; }
  constructor(private channel: PacketChannel, readonly identity: Identity, readonly targetPeerId: string) {
    void this.read().catch(error => this.close(failure(error)));
    void channel.done.catch(error => this.close(failure(error)));
  }
  private hasCapacity(kind: OperationKind): boolean {
    if (this.pending.size >= MAX_PENDING) return false;
    const count = [...this.pending.values()].filter(pending => pending.kind === kind).length;
    return kind === 'http' ? count < MAX_ACTIVE_HTTP_REQUESTS : kind === 'socket' ? count < MAX_OPEN_SECURE_SOCKETS : true;
  }
  private allocate(kind: OperationKind): Allocation {
    if (this.stopped) throw this.closeReason ?? new Error('Secure connection closed');
    const id = crypto.randomUUID(), queue = new AsyncQueue<Packet>(4);
    this.pending.set(id, { queue, kind }); return { id, queue };
  }
  private reserve(kind: OperationKind, signal?: AbortSignal): Promise<Allocation> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.stopped) return Promise.reject(this.closeReason ?? new Error('Secure connection closed'));
    if (this.hasCapacity(kind)) return Promise.resolve(this.allocate(kind));
    if (this.waiting.length >= MAX_WAITING) return Promise.reject(new Error('连接繁忙，请稍后重试。'));
    return new Promise((resolve, reject) => {
      const remove = (reason: unknown) => {
        this.waiting = this.waiting.filter(item => item !== waiter); waiter.cleanup(); reject(reason);
      };
      const abort = () => remove(signal?.reason ?? new Error('Request aborted'));
      const timer = setTimeout(() => remove(new Error('连接等待超时，请重试。')), REQUEST_IDLE_MS);
      const waiter: Waiter = { kind, resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
      this.waiting.push(waiter); signal?.addEventListener('abort', abort, { once: true });
    });
  }
  private dispatchWaiting(): void {
    if (this.stopped) return;
    // A full terminal quota must not block file requests or authorization controls.
    for (let index = 0; index < this.waiting.length;) {
      const waiter = this.waiting[index];
      if (!this.hasCapacity(waiter.kind)) { index++; continue; }
      this.waiting.splice(index, 1); waiter.cleanup(); waiter.resolve(this.allocate(waiter.kind));
    }
  }
  private async read() {
    try {
      for await (const packet of this.channel.read()) {
        const pending = this.pending.get(packet.id); if (!pending) continue;
        if (pending.socket) {
          pending.socket.accept(packet);
          if (packet.type === 'ws-close' || packet.type === 'error') this.release(packet.id);
        } else {
          pending.queue.push(packet);
          // Free the wire slot even when a caller only inspects response.ok/status.
          // The local iterator can still drain the already queued response packets.
          if (packet.type === 'end' || packet.type === 'error') { pending.cancelUpload?.(); this.release(packet.id); }
        }
      }
    } finally { this.close(new Error('Secure connection closed')); }
  }
  private release(id: string) { this.pending.get(id)?.queue.end(); this.pending.delete(id); this.dispatchWaiting(); }
  async request(packet: Omit<Packet, 'id'>, options?: { timeoutMs?: number }): Promise<Packet> {
    const { id, queue } = await this.reserve('request');
    const timeout = setTimeout(() => this.close(new Error('Secure connection timed out')),
      Math.max(1000, Math.min(REQUEST_IDLE_MS, options?.timeoutMs ?? REQUEST_IDLE_MS)));
    try {
      if (this.stopped) throw this.closeReason;
      this.channel.send({ ...packet, id } as Packet);
      const response = (await queue[Symbol.asyncIterator]().next()).value;
      if (!response) throw new Error('Secure request closed');
      if (response.type === 'error') throw failure(response.error);
      return response;
    } finally { clearTimeout(timeout); this.release(id); }
  }
  openSocket(path: string): SecureSocket {
    pathOnly(path);
    let id: string | undefined;
    const waiting = new AbortController();
    const socket = new SecureSocket(path,
      data => {
        if (!id) return;
        // Give recently typed input time to reach the PTY before planned
        // replacement. Heartbeats and output acknowledgements need no pause.
        try { if (JSON.parse(data)?.type === 'input') this.lastInputAt = performance.now(); } catch { /* non-JSON logical socket */ }
        this.channel.send({ id, type: 'ws-data', data });
      },
      () => { waiting.abort(); if (id) { try { this.channel.send({ id, type: 'ws-close' }); } finally { this.release(id); } } });
    void this.reserve('socket', waiting.signal).then(allocation => {
      id = allocation.id;
      if (socket.readyState === 3) { this.release(id); return; }
      const pending = this.pending.get(id); if (!pending) throw new Error('Secure connection closed');
      pending.socket = socket;
      this.channel.send({ id, type: 'ws-open', path });
    }).catch(error => { if (id) this.release(id); socket.fail(failure(error)); });
    return socket;
  }
  async fetch(input: RequestInfo | URL, init?: RequestInit & { onUploadProgress?: (uploadedBytes: number) => void }): Promise<Response> {
    const base = typeof location === 'undefined' ? 'https://termdock.invalid' : location.origin;
    const original = input instanceof Request ? input : null;
    const url = new URL(original?.url ?? String(input), base);
    // The origin is only a local addressing aid, never an arbitrary proxy destination.
    if (url.origin !== base) throw new Error('Only current-service API requests are supported');
    const request = new Request(url, original ? new Request(original, init) : init);
    const method = request.method.toUpperCase();
    const path = pathOnly(url.pathname + url.search);
    const uploadLimit = url.pathname === '/api/terminal/fs/upload' ? 110 * 1024 * 1024 : MAX_REQUEST_BYTES;
    if (request.signal.aborted) throw request.signal.reason;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => { if (!['cookie', 'authorization', 'host', 'connection', 'content-length'].includes(key)) headers[key] = value; });
    const { id, queue } = await this.reserve('http', request.signal);
    const iterator = queue[Symbol.asyncIterator]();
    let uploadReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelUpload = () => { void uploadReader?.cancel().catch(() => {}); };
    const pending = this.pending.get(id);
    if (!pending) throw new Error('Secure connection closed');
    pending.cancelUpload = cancelUpload;
    const abort = () => {
      cancelUpload();
      try { this.channel.send({ id, type: 'cancel' }); } catch { /* already closed */ }
      queue.end(failure(request.signal.reason ?? 'Request aborted')); this.release(id);
    };
    request.signal.addEventListener('abort', abort, { once: true });
    const release = () => { request.signal.removeEventListener('abort', abort); this.release(id); };
    const receive = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const packet = (await Promise.race([iterator.next(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('服务响应超时，请重试。')), REQUEST_IDLE_MS);
        })])).value;
        if (!packet) throw new Error('Secure response ended unexpectedly');
        if (packet.type === 'error') throw failure(packet.error);
        return packet;
      } finally { clearTimeout(timer); }
    };
    try {
      if (request.signal.aborted) throw request.signal.reason;
      this.channel.send({ id, type: 'http', method, path, headers });
      if (request.body) {
        const reader = request.body.getReader(); uploadReader = reader; let uploaded = 0; let acknowledged = 0;
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            uploaded += value.byteLength; if (uploaded > uploadLimit) throw new Error('Request body exceeds upload limit');
            for (let offset = 0; offset < value.byteLength; offset += CHUNK_BYTES) {
              this.channel.send({ id, type: 'upload', data: toBase64(value.subarray(offset, offset + CHUNK_BYTES)) });
              if ((await receive()).type !== 'upload-ack') throw new Error('Invalid upload acknowledgement');
              acknowledged += Math.min(CHUNK_BYTES, value.byteLength - offset); init?.onUploadProgress?.(acknowledged);
            }
          }
        } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
        finally { uploadReader = undefined; reader.releaseLock(); }
      }
      if (request.signal.aborted || this.stopped) throw new Error('Request aborted');
      this.channel.send({ id, type: 'upload-end' });
      const head = await receive();
      if (head.type !== 'head' || typeof head.status !== 'number') throw new Error('Invalid response header');
      const responseHeaders = new Headers(head.headers as Record<string, string>);
      if (method === 'HEAD' || [204, 205, 304].includes(head.status)) {
        // Drain protocol terminator without manufacturing an illegal body for bodyless responses.
        if ((await receive()).type !== 'end') throw new Error('Unexpected response body');
        release(); return new Response(null, { status: head.status, headers: responseHeaders });
      }
      let acknowledge = false;
      const body = new ReadableStream<Uint8Array>({
        pull: async controller => {
          try {
            if (acknowledge) { this.channel.send({ id, type: 'ack' }); acknowledge = false; }
            const packet = await receive();
            if (packet.type === 'end') { controller.close(); release(); return; }
            if (packet.type !== 'chunk' || typeof packet.data !== 'string') throw new Error('Invalid response chunk');
            const bytes = fromBase64(packet.data);
            if (bytes.length > CHUNK_BYTES) throw new Error('Response chunk exceeds budget');
            controller.enqueue(bytes); acknowledge = true;
          } catch (error) { controller.error(error); abort(); release(); }
        },
        cancel: () => { abort(); release(); },
      // Like native fetch, drain small unread responses, but keep large downloads
      // bounded to one chunk of browser-side prefetch before applying backpressure.
      }, { highWaterMark: CHUNK_BYTES, size: chunk => chunk.byteLength });
      return new Response(body, { status: head.status, headers: responseHeaders });
    } catch (error) { abort(); release(); throw error; }
  }
  /** Called only after a replacement has authenticated and no requests remain.
   * Do not replay input: terminal consumers reattach using their output cursor. */
  retire(): void {
    for (const pending of this.pending.values()) {
      pending.socket?.accept({ id: '', type: 'ws-close', code: TRANSPORT_RENEWED_CODE, reason: TRANSPORT_RENEWED_REASON });
    }
    this.close();
  }
  close(error = new Error('Secure connection closed')) {
    if (this.stopped) return; this.stopped = true; this.closeReason = error;
    for (const waiter of this.waiting.splice(0)) { waiter.cleanup(); waiter.reject(error); }
    for (const pending of this.pending.values()) { pending.queue.end(error); pending.cancelUpload?.(); pending.socket?.fail(error); }
    this.pending.clear(); this.channel.close(error);
  }
}

export async function connect(options: SecureClientOptions): Promise<SecureClient> {
  const url = new URL(options.url);
  if (!['wss:', 'ws:'].includes(url.protocol)) throw new Error('A WebSocket endpoint is required');
  if (url.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Remote secure channels require WSS');
  const identity = options.identity ?? await createIdentity();
  const socket = (options.socketFactory ?? (value => new WebSocket(value)))(url.href);
  // Install the byte listener before awaiting open: an eager target may send its first
  // handshake record in the same event turn as the relay's opened event.
  const duplex = socketDuplex(socket);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('Secure handshake timed out')), 20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  try {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      const cleanup = () => { signal.removeEventListener('abort', abort); socket.removeEventListener('open', opened); socket.removeEventListener('error', failed); socket.removeEventListener('close', failed); };
      const opened = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('Secure transport unavailable')); };
      const abort = () => { cleanup(); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      socket.addEventListener('open', opened); socket.addEventListener('error', failed); socket.addEventListener('close', failed);
      if (socket.readyState === 1) opened();
    });
    const secure = await secureConnection({ identity, duplex, initiator: true, targetPinnedPeerId: options.targetPeerId, signal });
    const client = new SecureClient(new PacketChannel(secure.duplex), identity, secure.authenticatedPeerId);
    if (options.pairingCode) {
      try { await client.request({ type: 'pair', code: options.pairingCode }); } catch (error) { client.close(failure(error)); throw error; }
    }
    return client;
  } catch (error) { socket.close(); throw error; }
  finally { clearTimeout(timer); }
}
