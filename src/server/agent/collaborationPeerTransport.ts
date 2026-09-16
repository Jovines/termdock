import type { Request } from 'express';
import { encryptedRequestSubject } from '../federation/requestContext.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import WebSocket from 'ws';
import { AsyncQueue, toBase64, fromBase64, PacketChannel, type Packet } from '../federation/packets.js';
import { secureConnection, type Identity } from '../federation/secureProtocol.js';
import { socketDuplex } from '../federation/socketDuplex.js';
import { readPinnedCertificateAuthority } from '../federation/trustedCa.js';
import { COLLAB_LIMITS, STATUS_RANK } from './collaborationProtocol.js';
import { terminalMessage } from './collaborationStore.js';
import type { CollaborationStore, CollaborationMessage, CollaborationContext } from './collaborationStore.js';

/** The outer API gate already authenticated local CLI tokens. Browser callers
 * additionally need durable administration authority; open-access sessions may
 * not turn temporary access into persistent peer authorization. */
export function assertPeerRegistrationAuthority(req: Request): void {
  const subjectId = encryptedRequestSubject(req);
  if (!subjectId) return;
  const runtime = req.app.locals.passwordRuntime;
  if (!runtime?.store.authorize({ subjectId, serviceId: runtime.serviceId, action: 'authorization.manage' }).allowed) throw new Error('AUTHORIZATION_DENIED');
}

export interface CollaborationNode { serviceId: string; origin: string; caFingerprint256?: string }
interface Binding { groupId: string; localOrigin: string; peer: CollaborationNode }
export function remoteSession(origin: string, id: string): string { return `remote:${encodeURIComponent(origin)}:${encodeURIComponent(id)}`; }
function localSession(origin: string, id: string): string {
  const prefix = `remote:${encodeURIComponent(origin)}:`;
  return id.startsWith(prefix) ? decodeURIComponent(id.slice(prefix.length)) : id;
}
export function validateCollaborationNode(input: CollaborationNode): void {
  const url = new URL(input.origin);
  if (url.protocol !== 'https:' || url.origin !== input.origin || url.username || url.password
    || !/^12D3KooW[a-zA-Z0-9]{30,60}$/.test(input.serviceId)
    || (input.caFingerprint256 !== undefined && !/^(?:[\da-f]{2}:){31}[\da-f]{2}$/i.test(input.caFingerprint256))) throw new Error('INVALID_COLLABORATION_NODE');
}

function mapContext(context: CollaborationContext, map: (id: string) => string): CollaborationContext {
  return { instructions: context.instructions ? { ...context.instructions, updatedBy: map(context.instructions.updatedBy) } : undefined,
    roles: context.roles ? Object.fromEntries(Object.entries(context.roles).map(([id, role]) => [map(id), role])) : undefined,
    roleVersions: context.roleVersions ? Object.fromEntries(Object.entries(context.roleVersions).map(([id, revision]) => [map(id), revision])) : undefined };
}

/** Small RPC client over the same authenticated Noise transport as the page.
 * No cookies, browser device keys, or direct HTTP business requests. */
export class CollaborationRpc {
  private pending = new Map<string, { resolve: (packet: Packet) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  closed = false;
  constructor(private channel: PacketChannel, private receive?: (packet: Packet) => Record<string, unknown>, externalReader = false) {
    if (!externalReader) void this.read();
    void channel.done.catch(error => this.close(error));
  }
  accept(packet: Packet): boolean {
    if (packet.type !== 'result' && packet.type !== 'error') return false;
    const request = this.pending.get(packet.id); if (!request) return false;
    clearTimeout(request.timer); this.pending.delete(packet.id);
    if (packet.type === 'error') request.reject(new Error(String(packet.error))); else request.resolve(packet);
    return true;
  }
  private async read() {
    try { for await (const packet of this.channel.read()) {
      if (this.accept(packet) || packet.type === 'result' || packet.type === 'error') continue;
      try {
        if (!this.receive || !['collaboration-service', 'collaboration-exchange'].includes(packet.type)) throw new Error('COLLABORATION_OPERATION_UNSUPPORTED');
        this.channel.send({ ...this.receive(packet), type: 'result', id: packet.id });
      } catch (error) { this.channel.send({ type: 'error', id: packet.id, error: error instanceof Error ? error.message : 'REQUEST_FAILED' }); }
    } } catch (error) { this.close(error instanceof Error ? error : new Error('PEER_DISCONNECTED')); }
    finally { this.close(); }
  }
  request(packet: Omit<Packet, 'id'>): Promise<Packet> {
    if (this.closed) return Promise.reject(new Error('PEER_DISCONNECTED'));
    if (this.pending.size >= 8) return Promise.reject(new Error('PEER_BUSY'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('PEER_TIMEOUT')); this.close(); }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.channel.send({ ...packet, id } as Packet); } catch (error) { this.close(error instanceof Error ? error : new Error('PEER_DISCONNECTED')); }
    });
  }
  close(error = new Error('PEER_DISCONNECTED')) {
    if (this.closed) return; this.closed = true; this.channel.close();
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
}
export async function connectCollaborationRpc(identity: Identity, peer: CollaborationNode, endpoint?: string, receive?: (packet: Packet) => Record<string, unknown>): Promise<CollaborationRpc> {
  validateCollaborationNode(peer);
  const ca = peer.caFingerprint256 ? await readPinnedCertificateAuthority(peer.origin, peer.caFingerprint256) : undefined;
  const url = endpoint ?? `${peer.origin.replace(/^https:/, 'wss:')}/api/federation/secure`;
  const socket = new WebSocket(url, { ca, rejectUnauthorized: true, followRedirects: false, handshakeTimeout: 3000, maxPayload: 1024 * 1024 });
  const relay = endpoint ? relayDuplex(socket, peer.serviceId) : undefined;
  const duplex = relay?.duplex ?? socketDuplex(socket);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve); socket.once('error', reject); socket.once('close', () => reject(new Error('PEER_DISCONNECTED')));
    });
    if (relay) await relay.ready;
    const secured = await secureConnection({ identity, duplex, initiator: true, targetPinnedPeerId: peer.serviceId, signal: AbortSignal.timeout(5000) });
    const rpc = new CollaborationRpc(new PacketChannel(secured.duplex), receive);
    if (receive) {
      try { await rpc.request({ type: 'collaboration-connect' }); }
      catch (error) {
        // Older servers may lack duplex support; ordinary requests remain gated.
        // Missing peer authorization must reconnect after enrollment completes.
        if (!(error instanceof Error) || !['UNKNOWN_PACKET', 'COLLABORATION_UPGRADE_REQUIRED'].includes(error.message)) { rpc.close(); throw error; }
      }
    }
    return rpc;
  } catch (error) { socket.terminate(); throw error; }
}

function relayDuplex(socket: WebSocket, target: string) {
  const queue = new AsyncQueue<Uint8Array>(64), streamId = randomUUID();
  let readyResolve: () => void, readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void ready.catch(() => {});
  const timer = setTimeout(() => fail(new Error('ROUTE_TIMEOUT')), 5000);
  const fail = (error: Error) => { clearTimeout(timer); readyReject(error); queue.end(error); socket.close(); };
  const send = (frame: unknown) => {
    if (socket.readyState !== 1 || socket.bufferedAmount > 1024 * 1024) throw new Error('ROUTE_CONGESTED');
    socket.send(JSON.stringify(frame));
  };
  socket.on('error', fail); socket.on('close', () => fail(new Error('ROUTE_CLOSED')));
  socket.on('message', (raw, binary) => {
    try {
      if (binary || raw.toString().length > 256 * 1024) throw new Error('INVALID_RELAY_FRAME');
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'ready') { send({ type: 'open', streamId, serviceId: target }); return; }
      if (frame.streamId !== streamId) return;
      if (frame.type === 'opened') { clearTimeout(timer); readyResolve(); return; }
      if (frame.type !== 'data' || frame.encoding !== 'base64' || typeof frame.payload !== 'string') throw new Error('ROUTE_CLOSED');
      queue.push(fromBase64(frame.payload));
    } catch (error) { fail(error instanceof Error ? error : new Error('INVALID_RELAY_FRAME')); }
  });
  return { ready, duplex: { source: queue, close: () => socket.close(), async sink(source: AsyncIterable<Uint8Array>) {
    await ready;
    for await (const bytes of source) for (let offset = 0; offset < bytes.length; offset += 65536) {
      while (socket.bufferedAmount > 256 * 1024) {
        if (socket.readyState !== 1) throw new Error('ROUTE_CLOSED');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      send({ type: 'data', streamId, encoding: 'base64', payload: toBase64(bytes.subarray(offset, offset + 65536)) });
    }
  } } };
}

type Rpc = Pick<CollaborationRpc, 'request' | 'close' | 'closed'>;
/** Group-scoped, durable server-to-server delivery. A binding is installed only
 * by an already authorized group administrator, never by the remote peer itself. */
export class CollaborationPeerTransport {
  private bindings: Binding[] = [];
  private clients = new Map<string, Promise<Rpc>>();
  private running = new Set<string>();
  private accepted = new Set<string>();
  private shellConfirmed = new Set<string>();
  private nextAttempt = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(private options: { file: string; serviceId: string; store: CollaborationStore;
    connect: (peer: CollaborationNode, via?: CollaborationNode) => Promise<Rpc>;
    reverse?: (serviceId: string) => CollaborationRpc | undefined;
    deliver: (sessionId: string) => void;
    activity?: () => Array<{ sessionId: string; last_terminal_output_at: number | null; activity_observed_at: number | null }> }) {
    try {
      const data = JSON.parse(readFileSync(options.file, 'utf8'));
      if (data.version === 1 && Array.isArray(data.bindings)) this.bindings = data.bindings.filter((b: Binding) => {
        try { validateCollaborationNode(b.peer); return typeof b.groupId === 'string' && new URL(b.localOrigin).origin === b.localOrigin; } catch { return false; }
      });
    } catch { /* First run has no server authorizations. */ }
  }
  notify(serviceId?: string) {
    for (const b of this.bindings) {
      const key = `${b.groupId}:${b.peer.serviceId}`;
      if (b.peer.serviceId === serviceId || !this.options.store.federationSnapshot().messages.some(m => m.groupId === b.groupId && m.status === 'pending'
        && this.options.store.diagnostic(m.id)?.last_error)) this.nextAttempt.delete(key);
    }
    // A queued message may arrive while an empty scan is finishing.
    setImmediate(() => this.wake());
  }
  start() { this.options.store.onMessageQueued = () => this.notify(); this.timer = setInterval(() => this.wake(), 500); this.timer.unref(); this.wake(); }
  close() { this.stopped = true; this.options.store.onMessageQueued = undefined; clearInterval(this.timer); for (const client of this.clients.values()) void client.then(c => c.close()).catch(() => {}); this.clients.clear(); }
  private live(b: Binding) {
    const group = this.options.store.getGroup(b.groupId);
    return !!group && !group.deleted && group.federated && group.sessionIds.some(id => id.startsWith(`remote:${encodeURIComponent(b.peer.origin)}:`));
  }
  configure(groupId: string, localOrigin: string, nodes: CollaborationNode[]) {
    if (!Array.isArray(nodes) || nodes.length > 64) throw new Error('INVALID_COLLABORATION_NODES');
    const group = this.options.store.getGroup(groupId);
    if (!group || group.deleted || !group.federated) throw new Error('GROUP_NOT_FOUND');
    const local = nodes.find(n => n.serviceId === this.options.serviceId);
    if (!local || local.origin !== localOrigin) throw new Error('LOCAL_NODE_MISMATCH');
    for (const node of nodes) validateCollaborationNode(node);
    const peers = nodes.filter(n => n.serviceId !== this.options.serviceId && group.sessionIds.some(id => id.startsWith(`remote:${encodeURIComponent(n.origin)}:`)))
      .map(n => ({ serviceId: n.serviceId, origin: n.origin, ...(n.caFingerprint256 ? { caFingerprint256: n.caFingerprint256 } : {}) }));
    const next = [...this.bindings.filter(b => b.groupId !== groupId), ...peers.map(peer => ({ groupId, localOrigin, peer }))]
      .sort((a, b) => a.groupId.localeCompare(b.groupId) || a.peer.serviceId.localeCompare(b.peer.serviceId));
    if (JSON.stringify(next) !== JSON.stringify(this.bindings)) {
      mkdirSync(dirname(this.options.file), { recursive: true, mode: 0o700 });
      const temp = `${this.options.file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, bindings: next }), { mode: 0o600 }); renameSync(temp, this.options.file);
      this.bindings = next; this.nextAttempt.clear();
      for (const client of this.clients.values()) void client.then(c => c.close()).catch(() => {});
      this.clients.clear();
    }
    this.notify();
  }
  registeredNodes(): CollaborationNode[] { return [...new Map(this.bindings.map(binding => [binding.peer.serviceId, binding.peer])).values()]; }
  canRoute(subjectId: string, targetId: string): boolean {
    return this.bindings.some(b => b.peer.serviceId === subjectId && this.live(b)
      && this.bindings.some(target => target.groupId === b.groupId && target.peer.serviceId === targetId && this.live(target)));
  }
  private binding(subjectId: string, groupId: string) {
    const binding = this.bindings.find(b => b.peer.serviceId === subjectId && b.groupId === groupId && this.live(b));
    if (!binding) throw new Error('COLLABORATION_NOT_AUTHORIZED');
    return binding;
  }
  /** Remote peers can submit only their own members' messages and query receipts
   * for those messages. They cannot create groups, rewrite bodies or administer sessions. */
  receive(subjectId: string, packet: Packet): Record<string, unknown> {
    const b = this.binding(subjectId, String(packet.groupId));
    const store = this.options.store;
    if (packet.context) store.mergeContext(b.groupId, mapContext(packet.context as CollaborationContext, id => localSession(b.localOrigin, id)));
    if (packet.message) {
      const message = packet.message as CollaborationMessage;
      if (message.groupId !== b.groupId || typeof message.fromSessionId !== 'string' || message.fromSessionId.startsWith('remote:')
        || typeof message.toSessionId !== 'string' || !message.toSessionId.startsWith(`remote:${encodeURIComponent(b.localOrigin)}:`)
        || Buffer.byteLength(JSON.stringify(message)) > COLLAB_LIMITS.wire_bytes) throw new Error('INVALID_PEER_MESSAGE');
      const incoming: CollaborationMessage = { ...message, fromSessionId: remoteSession(b.peer.origin, message.fromSessionId),
        toSessionId: localSession(b.localOrigin, message.toSessionId), status: 'pending', deliveredAt: null, readAt: null,
        snapshot: null, deliverySource: undefined, readSource: undefined, shellConfirmed: message.shellConfirmed === true };
      const existing = store.getMessage(message.id);
      if (existing && (existing.groupId !== incoming.groupId || existing.fromSessionId !== incoming.fromSessionId
        || existing.toSessionId !== incoming.toSessionId || existing.content !== incoming.content)) throw new Error('MESSAGE_ID_CONFLICT');
      if (!existing) store.mergeFederatedMessages([incoming]);
      else if (incoming.shellConfirmed && !existing.shellConfirmed) store.mergeFederatedMessages([{ ...existing, shellConfirmed: true }]);
      if (!store.getMessage(message.id)) throw new Error('PEER_REJECTED_MESSAGE');
      this.options.deliver(incoming.toSessionId);
    }
    if (!Array.isArray(packet.ids) || packet.ids.length > 20 || packet.ids.some(id => typeof id !== 'string')) throw new Error('INVALID_RECEIPT_IDS');
    const receipts = packet.ids.flatMap(id => {
      const message = store.getMessage(id as string);
      if (!message || message.groupId !== b.groupId || !message.fromSessionId?.startsWith(`remote:${encodeURIComponent(b.peer.origin)}:`)
        || message.toSessionId.startsWith('remote:')) return [];
      const facts = terminalMessage(message);
      const known = Array.isArray(packet.known) ? packet.known.find((item: any) => item?.id === message.id) : undefined;
      if (known && known.status === facts.status && known.deliveredAt === facts.deliveredAt && known.shellConfirmed === message.shellConfirmed && (known.hasSnapshot || !message.snapshot)) return [];
      const receipt = store.receipt(message.id);
      return [{ id: message.id, status: facts.status, deliveredAt: facts.deliveredAt,
        snapshot: (receipt.snapshot ?? '').slice(0, 16000) || null, deliverySource: facts.deliverySource,
        failureReason: message.failureReason, shellConfirmed: message.shellConfirmed, last_error: store.diagnostic(message.id)?.last_error ?? null }];
    });
    const group = store.getGroup(b.groupId)!;
    const activity = this.options.activity?.().filter(item => group.sessionIds.includes(item.sessionId) && !item.sessionId.startsWith('remote:')) ?? [];
    return { activity, context: mapContext(store.context(b.groupId), id => id.startsWith('remote:') ? id : remoteSession(b.localOrigin, id)), receipts, receivedIds: packet.ids.filter(id => {
      const message = store.getMessage(id as string);
      return message?.groupId === b.groupId && message.fromSessionId?.startsWith(`remote:${encodeURIComponent(b.peer.origin)}:`) && !message.toSessionId.startsWith('remote:');
    }) };
  }
  wake() {
    if (this.stopped) return;
    for (const b of this.bindings) {
      const key = `${b.groupId}:${b.peer.serviceId}`;
      if (!this.live(b) || this.running.has(key) || (this.nextAttempt.get(key) ?? 0) > Date.now()) continue;
      this.running.add(key);
      void this.sync(b).catch(() => { this.nextAttempt.set(key, Date.now() + 1000); }).finally(() => this.running.delete(key));
    }
    // No registration must be visible, rather than an unexplained zero-attempt queue.
    for (const group of this.options.store.list()) for (const m of this.options.store.federationSnapshot().messages.filter(message => message.groupId === group.id)) {
      if (m.status !== 'pending' || m.fromSessionId?.startsWith('remote:') || !m.toSessionId.startsWith('remote:')) continue;
      if (this.bindings.some(b => b.groupId === group.id && this.live(b) && m.toSessionId.startsWith(`remote:${encodeURIComponent(b.peer.origin)}:`))) continue;
      const prior = this.options.store.diagnostic(m.id);
      if (prior?.last_error === 'PEER_REGISTRATION_REQUIRED' && Date.now() - prior.checked_at < 10_000) continue;
      this.options.store.recordTransport(m.id, { relay_online: null, peer_reachable: null, attempt_count: prior?.attempt_count ?? 0,
        next_retry_at: null, last_error: 'PEER_REGISTRATION_REQUIRED', checked_at: Date.now() });
    }
  }
  private async client(b: Binding): Promise<Rpc> {
    const reverse = this.options.reverse?.(b.peer.serviceId);
    if (reverse && !reverse.closed) return reverse;
    const key = b.peer.serviceId;
    let pending = this.clients.get(key);
    if (pending) { const client = await pending; if (!client.closed) return client; this.clients.delete(key); }
    pending = (async () => {
      try { return await this.options.connect(b.peer); } catch (directError) {
        for (const entry of this.bindings.filter(e => e.groupId === b.groupId && e.peer.serviceId !== b.peer.serviceId && this.live(e))) {
          try { return await this.options.connect(b.peer, entry.peer); } catch { /* Try the next explicitly registered entry. */ }
        }
        throw directError;
      }
    })();
    this.clients.set(key, pending);
    try { return await pending; } catch (error) { if (this.clients.get(key) === pending) this.clients.delete(key); throw error; }
  }
  private async sync(b: Binding) {
    const store = this.options.store, key = `${b.groupId}:${b.peer.serviceId}`;
    const messages = store.federationSnapshot().messages.filter(m => m.groupId === b.groupId).filter(m => !m.fromSessionId?.startsWith('remote:') && m.fromSessionId !== null
      && m.toSessionId.startsWith(`remote:${encodeURIComponent(b.peer.origin)}:`) && !['failed', 'expired'].includes(m.status)
      && (m.status === 'pending' || !m.snapshot)).sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending'));
    const pending = messages.filter(m => m.status === 'pending');
    const targetErrors = new Map<string, string>();
    try {
      const client = await this.client(b);
      for (let offset = 0; offset < Math.max(1, messages.length); offset += 20) {
        const batch = messages.slice(offset, offset + 20);
        const requests = batch.filter(m => m.status === 'pending' && (!this.accepted.has(m.id) || m.shellConfirmed && !this.shellConfirmed.has(m.id)));
        const payloads: Array<CollaborationMessage | undefined> = requests.length ? requests : [undefined];
        for (const message of payloads) {
          const result = await client.request({ type: 'collaboration-exchange', groupId: b.groupId,
            context: mapContext(store.context(b.groupId), id => id.startsWith('remote:') ? id : remoteSession(b.localOrigin, id)),
            ids: batch.map(m => m.id), known: batch.map(m => ({ id: m.id, status: m.status, deliveredAt: m.deliveredAt, hasSnapshot: !!m.snapshot, shellConfirmed: m.shellConfirmed })), ...(message ? { message } : {}) });
          if (Array.isArray(result.activity)) for (const item of result.activity.slice(0, 500)) {
            if (!item || typeof item.sessionId !== 'string' || item.sessionId.startsWith('remote:')) continue;
            const id = remoteSession(b.peer.origin, item.sessionId);
            if (store.getGroup(b.groupId)?.sessionIds.includes(id)) store.recordPeerActivity(id, item.last_terminal_output_at, item.activity_observed_at);
          }
          if (result.context) store.mergeContext(b.groupId, mapContext(result.context as CollaborationContext, id => localSession(b.localOrigin, id)));
          if (Array.isArray(result.receivedIds)) for (const item of batch) {
            if (result.receivedIds.includes(item.id)) this.accepted.add(item.id); else this.accepted.delete(item.id);
          }
          if (this.accepted.size > 2000) {
            const retained = new Set(store.federationSnapshot().messages.map(m => m.id));
            for (const id of this.accepted) if (!retained.has(id)) { this.accepted.delete(id); this.shellConfirmed.delete(id); }
          }
          if (!Array.isArray(result.receipts)) throw new Error('INVALID_PEER_RECEIPTS');
          for (const receipt of result.receipts as Array<Partial<CollaborationMessage> & { id: string; last_error?: string }>) {
            const existing = batch.find(m => m.id === receipt.id); if (!existing) continue;
            if (receipt.shellConfirmed) this.shellConfirmed.add(existing.id);
            if (typeof receipt.last_error === 'string') targetErrors.set(existing.id, receipt.last_error);
            if (!receipt.status || !Object.hasOwn(STATUS_RANK, receipt.status)
              || (receipt.deliveredAt != null && !Number.isFinite(receipt.deliveredAt))) throw new Error('INVALID_PEER_RECEIPT');
            store.mergeFederatedMessages([{ ...existing, status: receipt.status === 'read' ? 'delivered' : receipt.status, deliveredAt: receipt.deliveredAt ?? null,
              readAt: null, snapshot: typeof receipt.snapshot === 'string' ? receipt.snapshot.slice(0, 16000) : null,
              deliverySource: receipt.deliverySource, readSource: undefined, failureReason: receipt.failureReason }]);
          }
        }
      }
      for (const m of pending) store.recordTransport(m.id, { relay_online: true, peer_reachable: true,
        attempt_count: (store.diagnostic(m.id)?.attempt_count ?? 0) + 1, next_retry_at: m.status === 'pending' ? Date.now() + 500 : null, last_error: targetErrors.get(m.id) ?? null, checked_at: Date.now(),
        ...(this.accepted.has(m.id) ? { remote_received_at: store.diagnostic(m.id)?.remote_received_at ?? Date.now() } : {}) });
      this.nextAttempt.set(key, Date.now() + (messages.some(m => m.status === 'pending') ? 250 : 1000));
    } catch (error) {
      const attempts = Math.max(0, ...pending.map(m => store.diagnostic(m.id)?.attempt_count ?? 0)) + 1;
      const next = Date.now() + Math.min(10_000, 500 * 2 ** Math.min(attempts - 1, 5));
      this.nextAttempt.set(key, next);
      for (const m of pending) store.recordTransport(m.id, { relay_online: true, peer_reachable: false, attempt_count: attempts, remote_received_at: store.diagnostic(m.id)?.remote_received_at,
        next_retry_at: next, last_error: error instanceof Error ? error.message.slice(0, 300) : 'PEER_UNREACHABLE', checked_at: Date.now() });
    }
  }
}
