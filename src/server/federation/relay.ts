import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { WebSocket, RawData } from 'ws';

/** This layer routes opaque application ciphertext; it never authorizes terminal operations. */
export type RelayFrame =
  | { type: 'register'; serviceIds: string[]; ttlMs: number }
  | { type: 'open'; streamId: string; serviceId: string }
  | { type: 'opened'; streamId: string }
  | { type: 'data'; streamId: string; payload: string; encoding?: 'base64' }
  | { type: 'close'; streamId: string; reason?: string };
export interface RelayLimits {
  maxFrameBytes?: number; maxBufferedBytes?: number; maxStreams?: number;
  heartbeatMs?: number; maxRouteTtlMs?: number; connectTimeoutMs?: number;
}
const defaults = { maxFrameBytes: 256 * 1024, maxBufferedBytes: 1024 * 1024,
  maxStreams: 128, heartbeatMs: 30_000, maxRouteTtlMs: 90_000, connectTimeoutMs: 10_000 };
type Limits = typeof defaults;
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(v);
function parse(raw: RawData, limits: Limits): RelayFrame {
  if (Buffer.byteLength(raw instanceof Array ? Buffer.concat(raw) : raw as Buffer) > limits.maxFrameBytes) throw new Error('Frame exceeds budget');
  const f = JSON.parse(raw.toString()) as RelayFrame;
  if (f.type === 'register') {
    if (!Array.isArray(f.serviceIds) || f.serviceIds.length > 64 || !f.serviceIds.every(identifier)
      || !Number.isFinite(f.ttlMs) || f.ttlMs <= 0) throw new Error('Invalid registration');
  } else if (!identifier(f.streamId) || !['open', 'opened', 'data', 'close'].includes(f.type)
    || (f.type === 'open' && !identifier(f.serviceId))
    || (f.type === 'data' && (typeof f.payload !== 'string' || (f.encoding !== undefined && f.encoding !== 'base64')))) throw new Error('Invalid frame');
  return f;
}
function send(ws: WebSocket, frame: RelayFrame, limits: Limits): boolean {
  const data = JSON.stringify(frame);
  if (ws.readyState !== 1) return false;
  if (Buffer.byteLength(data) > limits.maxFrameBytes || ws.bufferedAmount + Buffer.byteLength(data) > limits.maxBufferedBytes) {
    ws.close(1013, 'Relay budget exceeded'); return false;
  }
  ws.send(data); return true;
}
function watch(ws: WebSocket, limits: Limits, cleanup: () => void): void {
  let alive = true;
  const timer = setInterval(() => {
    if (!alive || ws.readyState !== 1) { ws.terminate(); return; }
    alive = false; ws.ping();
  }, limits.heartbeatMs);
  timer.unref?.();
  ws.on('pong', () => { alive = true; });
  ws.once('close', () => { clearInterval(timer); cleanup(); });
  ws.on('error', () => { ws.terminate(); });
}
/** In-process wire used only for explicitly configured direct routes. */
class MemoryWire extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  peer!: MemoryWire;
  send(data: string) {
    if (this.readyState !== 1 || this.peer.readyState !== 1) return;
    const bytes = Buffer.from(data); this.bufferedAmount += bytes.length;
    queueMicrotask(() => {
      this.bufferedAmount -= bytes.length;
      if (this.readyState === 1 && this.peer.readyState === 1) this.peer.emit('message', bytes, false);
    });
  }
  ping() { queueMicrotask(() => { if (this.readyState === 1 && this.peer.readyState === 1) this.emit('pong'); }); }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3; this.emit('close', code, Buffer.from(reason));
    this.peer.close(code, reason);
  }
  terminate() { this.close(1006); }
}
function memoryPair(): [WebSocket, WebSocket] {
  const left = new MemoryWire(); const right = new MemoryWire(); left.peer = right; right.peer = left;
  return [left as unknown as WebSocket, right as unknown as WebSocket];
}
interface Peer<P> { ws: WebSocket; principal: P; streams: Map<string, Stream<P>> }
interface Stream<P> { owner: Peer<P>; ownerId: string; provider: Peer<P>; providerId: string; serviceId: string }
export interface RelayRouterOptions<P> extends RelayLimits {
  /** Authenticate every incoming connection, before accepting registrations or opens. */
  authenticate: (context: unknown) => Promise<P | null> | P | null;
  /** Explicit permission to advertise a target, distinct from permission to use it. */
  allowRegister: (principal: P, serviceId: string) => boolean;
  allowRoute: (principal: P, serviceId: string) => boolean;
}
export class RelayRouter<P = string> {
  private limits: Limits;
  private peers = new Set<Peer<P>>();
  private routes = new Map<string, { peer: Peer<P>; expires: number }>();
  private sweep: ReturnType<typeof setInterval>;
  private directPeers = new WeakMap<Peer<P>, string>();
  private stopped = false;
  constructor(private options: RelayRouterOptions<P>) {
    this.limits = { ...defaults, ...options };
    this.sweep = setInterval(() => {
      for (const [id, route] of this.routes) if (route.expires <= Date.now() || !this.canRegister(route.peer, id)) this.withdraw(id, route.peer);
      for (const peer of this.peers) for (const stream of [...peer.streams.values()]) {
        if (stream.owner === peer && !this.canRoute(peer, stream.serviceId)) this.closeStream(stream, 'Authorization revoked');
      }
    }, Math.min(this.limits.heartbeatMs, 1000));
    this.sweep.unref?.();
  }
  private canRegister(peer: Peer<P>, serviceId: string): boolean {
    return this.directPeers.has(peer) ? this.directPeers.get(peer) === serviceId : this.options.allowRegister(peer.principal, serviceId);
  }
  private canRoute(peer: Peer<P>, serviceId: string): boolean {
    return !this.directPeers.has(peer) && this.options.allowRoute(peer.principal, serviceId);
  }
  hasRoute(serviceId: string): boolean {
    const route = this.routes.get(serviceId);
    return !this.stopped && !!route && route.expires > Date.now() && route.peer.ws.readyState === 1 && this.canRegister(route.peer, serviceId);
  }
  /** Trusted local configuration only. Clients never supply a target URL or factory. */
  registerDirect(serviceId: string, connect: () => Promise<WebSocket>): () => void {
    if (this.stopped || !identifier(serviceId) || typeof connect !== 'function' || this.hasRoute(serviceId)) throw new Error('Invalid or already registered direct target');
    const [routerWire, clientWire] = memoryPair();
    // The private WeakMap marks this peer; its placeholder principal is never
    // passed to externally supplied authentication/authorization callbacks.
    const peer: Peer<P> = { ws: routerWire, principal: undefined as P, streams: new Map() };
    this.directPeers.set(peer, serviceId); this.peers.add(peer);
    watch(routerWire, this.limits, () => this.remove(peer));
    routerWire.on('message', raw => {
      try { this.receive(peer, parse(raw, this.limits)); } catch { routerWire.close(1008, 'Invalid direct route'); }
    });
    this.receive(peer, { type: 'register', serviceIds: [serviceId], ttlMs: this.limits.maxRouteTtlMs });
    const client = new RelayClient(clientWire, { ...this.limits, targets: new Map([[serviceId, connect]]) });
    return () => { client.close(); this.remove(peer); routerWire.close(); };
  }
  /** Caller awaits attach before completing its application-level ready handshake. */
  async attach(ws: WebSocket, context: unknown): Promise<boolean> {
    // Reject early application frames rather than buffering untrusted traffic while authenticating.
    let early = false;
    const rejectEarly = () => { early = true; ws.close(1008, 'Authentication pending'); };
    ws.on('message', rejectEarly);
    let principal: P | null;
    try { principal = await this.options.authenticate(context); } catch { principal = null; }
    ws.off('message', rejectEarly);
    if (principal === null || early || ws.readyState !== 1) { ws.close(1008, 'Relay authentication required'); return false; }
    const peer: Peer<P> = { ws, principal, streams: new Map() };
    this.peers.add(peer);
    watch(ws, this.limits, () => this.remove(peer));
    ws.on('message', raw => {
      try { this.receive(peer, parse(raw, this.limits)); } catch { ws.close(1008, 'Invalid relay request'); }
    });
    return true;
  }
  private withdraw(serviceId: string, peer: Peer<P>) {
    if (this.routes.get(serviceId)?.peer === peer) this.routes.delete(serviceId);
    for (const stream of [...peer.streams.values()]) if (stream.serviceId === serviceId && stream.provider === peer) this.closeStream(stream, 'Route unavailable');
  }
  private remove(peer: Peer<P>) {
    this.peers.delete(peer);
    for (const [id, route] of this.routes) if (route.peer === peer) this.withdraw(id, peer);
    for (const stream of [...peer.streams.values()]) this.closeStream(stream, 'Relay disconnected');
  }
  private closeStream(s: Stream<P>, reason: string) {
    s.owner.streams.delete(s.ownerId); s.provider.streams.delete(s.providerId);
    send(s.owner.ws, { type: 'close', streamId: s.ownerId, reason }, this.limits);
    send(s.provider.ws, { type: 'close', streamId: s.providerId, reason }, this.limits);
  }
  private receive(peer: Peer<P>, f: RelayFrame) {
    if (f.type === 'register') {
      if (!f.serviceIds.every(id => this.canRegister(peer, id))) throw new Error('Registration denied');
      for (const id of f.serviceIds) {
        const old = this.routes.get(id);
        if (old && old.peer !== peer && old.expires > Date.now()) throw new Error('Route already registered');
      }
      for (const [id, r] of this.routes) if (r.peer === peer && !f.serviceIds.includes(id)) this.withdraw(id, peer);
      for (const id of f.serviceIds) this.routes.set(id, { peer, expires: Date.now() + Math.min(f.ttlMs, this.limits.maxRouteTtlMs) });
      return;
    }
    if (f.type === 'open') {
      const route = this.routes.get(f.serviceId);
      if (peer.streams.has(f.streamId)) throw new Error('Duplicate stream');
      if (!this.canRoute(peer, f.serviceId) || !route || route.expires <= Date.now() || route.peer === peer) {
        send(peer.ws, { type: 'close', streamId: f.streamId, reason: 'Route unavailable or denied' }, this.limits); return;
      }
      if (peer.streams.size >= this.limits.maxStreams || route.peer.streams.size >= this.limits.maxStreams) throw new Error('Stream budget exceeded');
      const s: Stream<P> = { owner: peer, ownerId: f.streamId, provider: route.peer, providerId: randomUUID(), serviceId: f.serviceId };
      peer.streams.set(s.ownerId, s); route.peer.streams.set(s.providerId, s);
      if (!send(route.peer.ws, { ...f, streamId: s.providerId }, this.limits)) this.closeStream(s, 'Relay disconnected');
      return;
    }
    const s = peer.streams.get(f.streamId);
    if (!s) return;
    if (!this.canRoute(s.owner, s.serviceId) || !this.canRegister(s.provider, s.serviceId)) { this.closeStream(s, 'Authorization revoked'); return; }
    if (f.type === 'close') { this.closeStream(s, 'Channel closed'); return; }
    if (f.type === 'opened' && peer !== s.provider) throw new Error('Invalid channel direction');
    const target = peer === s.owner ? s.provider : s.owner;
    if (!send(target.ws, { ...f, streamId: peer === s.owner ? s.providerId : s.ownerId }, this.limits)) this.closeStream(s, 'Relay congestion');
  }
  close() { this.stopped = true; clearInterval(this.sweep); for (const p of [...this.peers]) { this.remove(p); p.ws.close(1001, 'Router stopped'); } }
}

export interface RelayClientOptions extends RelayLimits {
  /** Fixed service-ID registry. Each factory connects only to its configured secure endpoint. */
  targets: ReadonlyMap<string, () => Promise<WebSocket>>;
  routeTtlMs?: number;
}
/** Shared Mac/CLI middle hop. Target factories resolve only after their sockets are open. */
export class RelayClient {
  private limits: Limits;
  private streams = new Map<string, WebSocket | null>();
  private renewal: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(private upstream: WebSocket, private options: RelayClientOptions) {
    this.limits = { ...defaults, ...options };
    const ttl = Math.min(options.routeTtlMs ?? 60_000, this.limits.maxRouteTtlMs);
    const register = () => send(upstream, { type: 'register', serviceIds: [...options.targets.keys()], ttlMs: ttl }, this.limits);
    register(); this.renewal = setInterval(register, Math.max(1, Math.floor(ttl / 2))); this.renewal.unref?.();
    watch(upstream, this.limits, () => this.close());
    upstream.on('message', raw => { void this.receive(raw).catch(() => upstream.close(1008, 'Invalid relay frame')); });
  }
  private drop(id: string, reason: string) {
    const target = this.streams.get(id); this.streams.delete(id); target?.close();
    send(this.upstream, { type: 'close', streamId: id, reason }, this.limits);
  }
  private async receive(raw: RawData) {
    const f = parse(raw, this.limits);
    if (f.type === 'register') throw new Error('Unexpected registration');
    if (f.type === 'open') {
      const connect = this.options.targets.get(f.serviceId);
      if (!connect || this.streams.has(f.streamId) || this.streams.size >= this.limits.maxStreams) { this.drop(f.streamId, 'Target unavailable'); return; }
      this.streams.set(f.streamId, null);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; this.drop(f.streamId, 'Target timeout'); }, this.limits.connectTimeoutMs); timer.unref?.();
      let target: WebSocket;
      try { target = await connect(); } catch { clearTimeout(timer); this.drop(f.streamId, 'Target unavailable'); return; }
      clearTimeout(timer);
      if (timedOut || this.stopped || !this.streams.has(f.streamId)) { target.close(); return; }
      this.streams.set(f.streamId, target);
      watch(target, this.limits, () => { if (this.streams.get(f.streamId) === target) this.drop(f.streamId, 'Target disconnected'); });
      target.on('message', (data, isBinary) => {
        if (Buffer.byteLength(data instanceof Array ? Buffer.concat(data) : data as Buffer) > this.limits.maxFrameBytes) { this.drop(f.streamId, 'Unsupported target frame'); return; }
        const bytes = data instanceof Array ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        const payload = isBinary ? bytes.toString('base64') : bytes.toString();
        if (!send(this.upstream, { type: 'data', streamId: f.streamId, payload, ...(isBinary ? { encoding: 'base64' as const } : {}) }, this.limits)) this.drop(f.streamId, 'Relay congestion');
      });
      send(this.upstream, { type: 'opened', streamId: f.streamId }, this.limits); return;
    }
    if (f.type === 'close') { this.drop(f.streamId, 'Channel closed'); return; }
    if (f.type !== 'data') throw new Error('Unexpected frame');
    const target = this.streams.get(f.streamId);
    if (!target || target.readyState !== 1) { this.drop(f.streamId, 'Target not ready'); return; }
    if (target.bufferedAmount + Buffer.byteLength(f.payload) > this.limits.maxBufferedBytes) { this.drop(f.streamId, 'Target congestion'); return; }
    if (f.encoding === 'base64') {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.payload)) throw new Error('Invalid ciphertext encoding');
      target.send(Buffer.from(f.payload, 'base64'));
    } else target.send(f.payload);
  }
  close() {
    if (this.stopped) return; this.stopped = true; clearInterval(this.renewal);
    for (const id of [...this.streams.keys()]) this.drop(id, 'Relay stopped');
    this.upstream.close(1001, 'Relay stopped');
  }
}
