import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Packet } from '../federation/packets.js';
import type { CollaborationGroup, CollaborationStore } from './collaborationStore.js';
import { CollaborationError } from './collaborationProtocol.js';
import { COLLAB_NAME_FORBIDDEN } from './collaborationPrompt.js';
import { remoteSession, validateCollaborationNode, type CollaborationNode, type CollaborationPeerTransport, type CollaborationRpc } from './collaborationPeerTransport.js';

type Session = { sessionId: string; name: string; cwd: string; status: string; capability: string; updatedAt: number; agent: { slug: string; displayName: string } | null };
type Offer = { hash: string; expiresAt: number; acceptedBy?: string };
type Document = { version: 1; origin?: string; peers: CollaborationNode[]; offers: Offer[]; replicas?: Record<string, string[]>; departed?: Record<string, number> };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const address = (id: string) => { if (!id.startsWith('remote:')) return null; const parts = id.slice(7).split(':'); if (parts.length !== 2) throw new Error('INVALID_SESSION'); return { origin: decodeURIComponent(parts[0]), id: decodeURIComponent(parts[1]) }; };
const local = (origin: string, id: string) => { const a = address(id); return a?.origin === origin ? a.id : id; };
const mapRoles = <T>(value: Record<string, T> | undefined, map: (id: string) => string) => value && Object.fromEntries(Object.entries(value).map(([id, item]) => [map(id), item]));
function mapGroup(group: CollaborationGroup, map: (id: string) => string): CollaborationGroup {
  return { ...group, sessionIds: group.sessionIds.map(map), roles: mapRoles(group.roles, map), roleVersions: mapRoles(group.roleVersions, map),
    instructions: group.instructions && { ...group.instructions, updatedBy: map(group.instructions.updatedBy) } };
}

/** Sole owner of peer discovery and group replication. UI and CLI call the same
 * local API. Pairing grants collaboration directory/group management only, never
 * generic HTTP, filesystem access or an Agent's credentials. */
export class CollaborationService {
  private document: Document = { version: 1, peers: [], offers: [] };
  private clients = new Map<string, Promise<CollaborationRpc>>();
  private observations = new Map<string, { sessions: Session[]; checkedAt: number; error?: string }>();
  private inFlight?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(private options: { file: string; store: CollaborationStore; transport: CollaborationPeerTransport;
    node: () => Omit<CollaborationNode, 'origin'>; sessions: () => Session[];
    pairConnect?: (node: CollaborationNode) => Promise<CollaborationRpc>;
    reverse?: (serviceId: string) => CollaborationRpc | undefined;
    connect: (node: CollaborationNode) => Promise<CollaborationRpc> }) {
    try { const data = JSON.parse(readFileSync(options.file, 'utf8')) as Document;
      if (data.version !== 1 || !Array.isArray(data.peers) || data.peers.length > 64 || !Array.isArray(data.offers)) throw new Error('INVALID_DIRECTORY');
      for (const peer of data.peers) validateCollaborationNode(peer);
      if (data.origin) validateCollaborationNode({ ...options.node(), origin: data.origin });
      this.document = data;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private persist() { mkdirSync(dirname(this.options.file), { recursive: true, mode: 0o700 }); const temp = `${this.options.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.document), { mode: 0o600 }); renameSync(temp, this.options.file); }
  private node(origin = this.document.origin): CollaborationNode { if (!origin) throw new Error('COLLABORATION_ORIGIN_REQUIRED'); const node = { ...this.options.node(), origin }; validateCollaborationNode(node); return node; }
  private setOrigin(origin: string) { this.node(origin); if (this.document.origin && this.document.origin !== origin) throw new Error('COLLABORATION_ORIGIN_MISMATCH'); this.document.origin = origin; }
  private remember(node: CollaborationNode) { validateCollaborationNode(node);
    if (node.serviceId === this.options.node().serviceId || node.origin === this.document.origin) throw new Error('CANNOT_PAIR_SELF');
    const old = this.document.peers.find(peer => peer.serviceId === node.serviceId || peer.origin === node.origin);
    if (old && (old.serviceId !== node.serviceId || old.origin !== node.origin || old.caFingerprint256 !== node.caFingerprint256)) throw new Error('PEER_IDENTITY_CHANGED');
    if (!old) { if (this.document.peers.length >= 63) throw new Error('PEER_LIMIT'); this.document.peers.push(node); }
    this.persist();
  }
  descriptor() { return { ...this.options.node(), ...(this.document.origin ? { origin: this.document.origin } : {}) }; }
  /** Called through the existing authenticated administrator connection. No
   * client key is copied; only pinned public service descriptors are persisted. */
  connectKnown(origin: string, nodes: CollaborationNode[]) {
    if (!Array.isArray(nodes) || nodes.length > 64) throw new Error('INVALID_SERVICE_DIRECTORY');
    const self = this.node(origin);
    const own = nodes.find(node => node?.serviceId === self.serviceId);
    if (!own || own.origin !== origin || own.caFingerprint256 !== self.caFingerprint256) throw new Error('LOCAL_NODE_MISMATCH');
    const ids = new Set<string>(), origins = new Set<string>();
    for (const node of nodes) {
      validateCollaborationNode(node);
      if (ids.has(node.serviceId) || origins.has(node.origin)) throw new Error('DUPLICATE_SERVICE_DIRECTORY');
      ids.add(node.serviceId); origins.add(node.origin);
      const old = this.document.peers.find(peer => peer.serviceId === node.serviceId || peer.origin === node.origin);
      if (old && (old.serviceId !== node.serviceId || old.origin !== node.origin || old.caFingerprint256 !== node.caFingerprint256)) throw new Error('PEER_IDENTITY_CHANGED');
    }
    if (new Set([...this.document.peers.map(peer => peer.serviceId), ...nodes.filter(node => node.serviceId !== self.serviceId).map(node => node.serviceId)]).size > 63) throw new Error('PEER_LIMIT');
    this.setOrigin(origin);
    this.document.peers = [...new Map([...this.document.peers, ...nodes.filter(node => node.serviceId !== self.serviceId)].map(node => [node.serviceId, node])).values()];
    this.persist(); void this.refresh(); return { ok: true, registered: this.document.peers.map(peer => peer.serviceId) };
  }
  invite(origin: string) { this.setOrigin(origin); const code = randomBytes(32).toString('base64url'), expiresAt = Date.now() + 10 * 60_000;
    this.document.offers = this.document.offers.filter(offer => offer.expiresAt > Date.now()).slice(-15);
    this.document.offers.push({ hash: hash(code), expiresAt }); this.persist();
    return { version: 1, node: this.node(), code, expiresAt, scope: 'collaboration-directory-and-groups' };
  }
  async accept(origin: string, invitation: { version: number; node: CollaborationNode; code: string; expiresAt: number }) {
    if (invitation?.version !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(invitation.code) || !Number.isFinite(invitation.expiresAt) || invitation.expiresAt <= Date.now()) throw new Error('PAIRING_EXPIRED_OR_INVALID');
    validateCollaborationNode(invitation.node); this.setOrigin(origin);
    const rpc = await (this.options.pairConnect ?? this.options.connect)(invitation.node);
    try { await rpc.request({ type: 'collaboration-service', action: 'pair', code: invitation.code, node: this.node() });
      this.remember(invitation.node); void this.refresh(); return { ok: true, peer: invitation.node }; }
    finally { rpc.close(); }
  }
  receive(subject: string, packet: Packet): Record<string, unknown> {
    if (packet.action === 'pair') {
      if (typeof packet.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(packet.code)) throw new Error('PAIRING_EXPIRED_OR_INVALID');
      const codeHash = hash(packet.code);
      const offer = this.document.offers.find(item => item.hash === codeHash && item.expiresAt > Date.now());
      const node = packet.node as CollaborationNode; validateCollaborationNode(node);
      if (!offer || node.serviceId !== subject || offer.acceptedBy && offer.acceptedBy !== subject) throw new Error('PAIRING_EXPIRED_OR_INVALID');
      if (offer.acceptedBy && !this.document.peers.some(peer => peer.serviceId === subject)) throw new Error('PAIRING_REVOKED');
      offer.acceptedBy = subject; this.remember(node); void this.refresh(); return { ok: true };
    }
    const peer = this.document.peers.find(node => node.serviceId === subject);
    if (!peer) throw new Error('COLLABORATION_PAIRING_REQUIRED');
    if (packet.action === 'duplex') return { ok: true };
    if (packet.action === 'directory') return this.snapshot(peer.origin);
    if (packet.action === 'group') {
      const canonical = packet.group as CollaborationGroup;
      if (!canonical?.sessionIds?.some(id => address(id)?.origin === peer.origin) && !this.document.replicas?.[canonical?.id]?.includes(peer.origin)) throw new Error('GROUP_SENDER_NOT_MEMBER');
      this.merge(canonical, packet.nodes as CollaborationNode[]); return { ok: true };
    }
    throw new Error('COLLABORATION_OPERATION_UNSUPPORTED');
  }
  private nodes() { return [...new Map([...this.options.transport.registeredNodes(), ...this.document.peers, this.node()].map(node => [node.origin, node])).values()]; }
  private snapshot(peerOrigin: string) {
    const origin = this.node().origin;
    return { sessions: this.options.sessions(), groups: this.options.store.federationSnapshot().groups
      .filter(group => group.federated && (group.sessionIds.some(id => address(id)?.origin === peerOrigin) || this.document.replicas?.[group.id]?.includes(peerOrigin)))
      .map(group => mapGroup(group, id => address(id) ? id : remoteSession(origin, id))), nodes: this.nodes() };
  }
  private merge(canonical: CollaborationGroup, nodes: CollaborationNode[]) {
    if (!canonical || typeof canonical.id !== 'string' || !canonical.id.startsWith('cross-') || !Array.isArray(canonical.sessionIds)
      || canonical.sessionIds.length < 2 || canonical.sessionIds.length > 500 || typeof canonical.name !== 'string' || !canonical.name.trim() || COLLAB_NAME_FORBIDDEN.test(canonical.name)
      || !Number.isFinite(canonical.updatedAt) || canonical.updatedAt > Date.now() + 60_000 || !Array.isArray(nodes) || nodes.length > 65) throw new Error('INVALID_GROUP');
    for (const node of nodes) {
      validateCollaborationNode(node);
      const trusted = this.document.peers.find(peer => peer.serviceId === node.serviceId || peer.origin === node.origin);
      if (trusted && (trusted.serviceId !== node.serviceId || trusted.origin !== node.origin || trusted.caFingerprint256 !== node.caFingerprint256)) throw new Error('PEER_IDENTITY_CHANGED');
    }
    const self = this.node(), own = nodes.find(node => node.serviceId === self.serviceId);
    if (!own || own.origin !== self.origin || own.caFingerprint256 !== self.caFingerprint256) throw new Error('LOCAL_NODE_MISMATCH');
    const existing = this.options.store.getGroup(canonical.id);
    if ((this.document.departed?.[canonical.id] ?? -1) >= canonical.updatedAt) return;
    if (!canonical.sessionIds.some(id => address(id)?.origin === self.origin)) {
      (this.document.departed ??= {})[canonical.id] = canonical.updatedAt;
      this.options.store.dropFederatedReplica(canonical.id, canonical.updatedAt); this.persist(); return;
    }
    const origins = [...new Set([...(this.document.replicas?.[canonical.id] ?? []), ...canonical.sessionIds.map(id => address(id)?.origin).filter((origin): origin is string => !!origin)])];
    if (JSON.stringify(origins) !== JSON.stringify(this.document.replicas?.[canonical.id])) {
      (this.document.replicas ??= {})[canonical.id] = origins; this.persist();
    }
    const localIds = new Set(this.options.sessions().map(s => s.sessionId));
    const incoming = { ...mapGroup(canonical, id => local(self.origin, id)), federated: true };
    for (const id of incoming.sessionIds) {
      const remote = address(id);
      if (remote ? !nodes.some(node => node.origin === remote.origin) : !localIds.has(id) && !existing?.sessionIds.includes(id)) throw new Error('GROUP_MEMBER_UNAVAILABLE');
    }
    incoming.remoteSessions = incoming.sessionIds.filter(id => address(id)).map(id => { const a = address(id)!;
      const observed = this.observations.get(nodes.find(node => node.origin === a.origin)!.serviceId)?.sessions.find(s => s.sessionId === a.id);
      return { ...observed, sessionId: id, name: observed?.name ?? a.id, cwd: observed?.cwd ?? '', status: 'offline', currentTask: '', capability: observed?.capability ?? '', updatedAt: observed?.updatedAt ?? 0,
        serviceOrigin: a.origin, serviceLabel: a.origin, backendSessionId: null, agentNativeSessionId: null, agent: observed?.agent ?? null }; });
    this.options.store.mergeFederatedGroup(incoming);
    const saved = this.options.store.getGroup(incoming.id);
    if (saved && !saved.deleted && saved.updatedAt === incoming.updatedAt) this.options.transport.configure(saved.id, self.origin, nodes);
  }
  start() { this.timer = setInterval(() => { void this.refresh(); }, 2000); this.timer.unref(); void this.refresh(); }
  close() { this.stopped = true; clearInterval(this.timer); for (const rpc of this.clients.values()) void rpc.then(client => client.close()).catch(() => {}); this.clients.clear(); }
  private async client(peer: CollaborationNode) { const reverse = this.options.reverse?.(peer.serviceId); if (reverse && !reverse.closed) return reverse; let pending = this.clients.get(peer.serviceId); if (pending && (await pending).closed) { this.clients.delete(peer.serviceId); pending = undefined; }
    if (!pending) { pending = this.options.connect(peer); this.clients.set(peer.serviceId, pending); }
    try { return await pending; } catch (error) { this.clients.delete(peer.serviceId); throw error; }
  }
  refresh(): Promise<void> { if (this.stopped || !this.document.origin) return Promise.resolve();
    return this.inFlight ??= Promise.all(this.document.peers.map(async peer => {
      try { const client = await this.client(peer); const data = await client.request({ type: 'collaboration-service', action: 'directory' });
        if (!Array.isArray(data.sessions) || data.sessions.length > 5000 || !Array.isArray(data.groups)) throw new Error('INVALID_DIRECTORY');
        const sessions = data.sessions.filter((s: Session) => s && typeof s.sessionId === 'string' && !s.sessionId.startsWith('remote:')) as Session[];
        this.observations.set(peer.serviceId, { sessions, checkedAt: Date.now() });
        for (const group of data.groups as CollaborationGroup[]) this.merge(group, data.nodes as CollaborationNode[]);
        for (const group of this.options.store.federationSnapshot().groups.filter(g => g.federated && (g.sessionIds.some(id => address(id)?.origin === peer.origin) || this.document.replicas?.[g.id]?.includes(peer.origin)))) {
          const canonical = mapGroup(group, id => address(id) ? id : remoteSession(this.node().origin, id));
          const nodes = this.nodes();
          if (canonical.sessionIds.some(id => !nodes.some(node => node.origin === address(id)?.origin))) continue;
          this.merge(canonical, nodes);
          await client.request({ type: 'collaboration-service', action: 'group', group: canonical, nodes });
        }
      } catch (error) { this.observations.set(peer.serviceId, { sessions: this.observations.get(peer.serviceId)?.sessions ?? [], checkedAt: Date.now(), error: error instanceof Error ? error.message.slice(0, 240) : 'PEER_UNAVAILABLE' }); }
    })).then(() => {}).finally(() => { this.inFlight = undefined; });
  }
  directory() {
    const known = new Set(this.document.peers.map(peer => peer.origin));
    const missing = [...new Set(this.options.store.list().flatMap(group => group.sessionIds.map(id => address(id)?.origin).filter((origin): origin is string => !!origin && !known.has(origin))))];
    const services = this.document.peers.map(peer => { const observed = this.observations.get(peer.serviceId); return { origin: peer.origin, serviceId: peer.serviceId, label: peer.origin,
      connected: !!observed && !observed.error && Date.now() - observed.checkedAt < 15_000, error: observed?.error ?? (!observed ? 'CONNECTING' : undefined) }; });
    return { protocolVersion: 2, sessions: this.document.peers.flatMap(peer => (this.observations.get(peer.serviceId)?.sessions ?? []).map(session => ({ ...session,
      sessionId: remoteSession(peer.origin, session.sessionId), backendSessionId: null, agentNativeSessionId: null, serviceOrigin: peer.origin, serviceLabel: peer.origin,
      serviceConnected: services.find(s => s.origin === peer.origin)!.connected, serviceCheckedAt: this.observations.get(peer.serviceId)?.checkedAt }))),
      services: [...services, ...missing.map(origin => ({ origin, label: origin, connected: false, error: '服务连接授权尚未同步；在已授权服务页面连接后会自动完成'  }))] };
  }
  async save(input: { id?: string; name: string; sessionIds: string[]; expectedUpdatedAt?: number }) {
    const existing = input.id ? this.options.store.getGroup(input.id) : null;
    if (input.id && (!existing || existing.deleted)) throw new Error('GROUP_NOT_FOUND');
    if (existing && input.expectedUpdatedAt !== existing.updatedAt) throw new CollaborationError('GROUP_CHANGED', `协作组已变化（当前 updatedAt=${existing.updatedAt}），请刷新后重试`, 409, { currentUpdatedAt: existing.updatedAt });
    if (typeof input.name !== 'string' || !input.name.trim() || COLLAB_NAME_FORBIDDEN.test(input.name) || !Array.isArray(input.sessionIds) || input.sessionIds.some(id => typeof id !== 'string') || new Set(input.sessionIds).size < 2) throw new Error('INVALID_GROUP');
    if (!input.sessionIds.some(id => address(id)) && !existing?.federated) {
      if (input.sessionIds.some(id => !this.options.sessions().some(s => s.sessionId === id) && !existing?.sessionIds.includes(id))) throw new Error('GROUP_MEMBER_UNAVAILABLE');
      return { group: this.options.store.save(input) };
    }
    if (!this.document.origin) throw new Error('COLLABORATION_PAIRING_REQUIRED');
    await this.refresh();
    if (existing && this.options.store.getGroup(existing.id)?.updatedAt !== existing.updatedAt) throw new Error('GROUP_CHANGED');
    if (!input.sessionIds.some(id => !address(id))) throw new Error('GROUP_MUST_INCLUDE_LOCAL_MEMBER');
    const available = new Set([...this.options.sessions(), ...this.directory().sessions.filter(s => s.serviceConnected)].map(s => s.sessionId));
    if (!Array.isArray(input.sessionIds) || input.sessionIds.some(id => !available.has(id) && !existing?.sessionIds.includes(id))) throw new Error('GROUP_MEMBER_UNAVAILABLE');
    const group: CollaborationGroup = { ...existing, id: existing?.federated ? existing.id : `cross-${randomBytes(16).toString('hex')}`, name: input.name,
      sessionIds: [...new Set(input.sessionIds)], createdAt: existing?.createdAt ?? Date.now(), updatedAt: Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1), federated: true };
    const canonical = mapGroup(group, id => address(id) ? id : remoteSession(this.node().origin, id));
    if (canonical.sessionIds.some(id => !this.nodes().some(node => node.origin === address(id)?.origin))) throw new Error('COLLABORATION_PAIRING_REQUIRED');
    // Promotion transfers history atomically to the federated group id.
    if (existing && !existing.federated) {
      const promoted = this.options.store.promoteGroup(existing.id, { ...group, remoteSessions: [] }, existing.updatedAt);
      canonical.updatedAt = promoted.updatedAt;
    }
    this.merge(canonical, this.nodes()); void this.refresh(); return { group: this.options.store.getGroup(group.id), synchronization: 'background' };
  }
}
