import { createHash, randomUUID } from 'node:crypto';

export interface FederationSession {
  sessionId: string;
  name: string;
  cwd: string;
  status: string;
  capability: string;
  currentTask: string;
  updatedAt: number;
  backendSessionId: string | null;
  agentNativeSessionId?: string | null;
  agent: { slug: string; displayName: string } | null;
  serviceOrigin?: string;
  serviceLabel?: string;
  serviceConnected?: boolean;
  serviceCheckedAt?: number;
}
export interface FederationGroup {
  id: string;
  name: string;
  sessionIds: string[];
  createdAt: number;
  updatedAt: number;
  federated?: boolean;
  deleted?: boolean;
  remoteSessions?: FederationSession[];
}
interface Message {
  id: string;
  groupId: string;
  fromSessionId: string | null;
  toSessionId: string;
  status: 'pending' | 'delivered' | 'read' | 'failed' | 'expired';
  [key: string]: unknown;
}
interface Diagnostic {
  relay_online: boolean | null; peer_reachable: boolean | null; attempt_count: number;
  next_retry_at: number | null; last_error: string | null; checked_at: number;
  fragments_sent?: number; fragments_total?: number;
}
const STATUS_RANK = { pending: 0, failed: 1, expired: 1, delivered: 2, read: 3 } as const;
const FRAGMENT_BYTES = 32_768;
interface Snapshot {
  protocolVersion?: number;
  transportDiagnostics?: Record<string, Diagnostic>;
  fragmentReceipts?: Array<{ message_id: string; received: number; total: number; complete: boolean }>;
  groups: FederationGroup[];
  sessions: FederationSession[];
  messages: Message[];
}
export interface FederationService {
  origin: string;
  label: string;
  request(path: string, method?: string, body?: unknown): Promise<unknown>;
}
const PREFIX = 'remote:';
export function qualifySession(origin: string, id: string): string {
  return id.startsWith(PREFIX) ? id : `${PREFIX}${encodeURIComponent(origin)}:${encodeURIComponent(id)}`;
}
export function sessionAddress(id: string): { origin: string; id: string } | null {
  if (!id.startsWith(PREFIX)) return null;
  const parts = id.slice(PREFIX.length).split(':');
  if (parts.length !== 2) return null;
  try { return { origin: decodeURIComponent(parts[0]), id: decodeURIComponent(parts[1]) }; } catch { return null; }
}
function localId(origin: string, id: string): string {
  const address = sessionAddress(id);
  return address?.origin === origin ? address.id : id;
}
function mapMessage(message: Message, map: (id: string) => string): Message {
  return { ...message, fromSessionId: message.fromSessionId ? map(message.fromSessionId) : null, toSessionId: map(message.toSessionId) };
}

/** Server replicas are durable. The desktop supplies authenticated transport only. */
export class CollaborationFederation {
  private snapshots = new Map<string, Snapshot>();
  private reachable = new Set<string>();
  private groups = new Map<string, FederationGroup>();
  private messages = new Map<string, Message>();
  private sessions = new Map<string, FederationSession>();
  private diagnostics = new Map<string, Diagnostic>();
  private inFlight: Promise<void> | null = null;

  constructor(private readonly services: () => FederationService[]) {}

  async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.synchronize().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async synchronize(): Promise<void> {
    const services = this.services();
    const snapshots = await Promise.all(services.map(async (service) => {
      try {
        const data = await service.request('/collaboration-federation') as Snapshot;
        if (!Array.isArray(data.groups) || !Array.isArray(data.sessions) || !Array.isArray(data.messages)) return null;
        return { service, data };
      } catch { return null; }
    }));
    this.reachable.clear();
    for (const snapshot of snapshots) {
      if (!snapshot) continue;
      const { service, data } = snapshot;
      for (const [id, diagnostic] of Object.entries(data.transportDiagnostics ?? {})) {
        if (!this.diagnostics.has(id) || diagnostic.checked_at > this.diagnostics.get(id)!.checked_at) this.diagnostics.set(id, diagnostic);
      }
      this.reachable.add(service.origin);
      this.snapshots.set(service.origin, data);
      for (const group of data.groups) {
        const canonical = { ...group, sessionIds: group.sessionIds.map((id) => qualifySession(service.origin, id)) };
        const existing = this.groups.get(group.id);
        if (!existing || canonical.updatedAt > existing.updatedAt) this.groups.set(group.id, canonical);
      }
      for (const message of data.messages) this.mergeMessage(mapMessage(message, (id) => qualifySession(service.origin, id)));
    }
    // Never keep a previously healthy service looking online after its window closes.
    this.sessions.clear();
    for (const group of this.groups.values()) for (const session of group.remoteSessions ?? []) {
      this.sessions.set(session.sessionId, { ...session, serviceConnected: false, status: 'offline', serviceCheckedAt: Date.now() });
    }
    for (const [origin, snapshot] of this.snapshots) {
      const connected = this.reachable.has(origin);
      for (const session of snapshot.sessions) {
        const id = qualifySession(origin, session.sessionId);
        this.sessions.set(id, { ...session, sessionId: id, serviceOrigin: origin,
          serviceLabel: services.find((service) => service.origin === origin)?.label ?? origin,
          serviceConnected: connected, serviceCheckedAt: Date.now(), status: connected ? session.status : 'offline' });
      }
    }
    for (const message of this.messages.values()) {
      const target = sessionAddress(message.toSessionId)?.origin;
      if (message.status === 'pending' && target && !this.reachable.has(target)) {
        const previous = this.diagnostics.get(message.id);
        this.diagnostics.set(message.id, { ...previous, relay_online: true, peer_reachable: false,
          attempt_count: previous?.attempt_count ?? 0, next_retry_at: Date.now() + 2_000, last_error: 'PEER_UNREACHABLE', checked_at: Date.now() });
      }
    }
    await Promise.all(services.filter((service) => this.reachable.has(service.origin)).map(async (service) => {
      for (const group of this.groups.values()) {
        const hadReplica = this.snapshots.get(service.origin)?.groups.some((item) => item.id === group.id);
        if (!hadReplica && !group.sessionIds.some((id) => sessionAddress(id)?.origin === service.origin)) continue;
        try { await this.push(service, group); } catch { this.reachable.delete(service.origin); }
      }
    }));
    await Promise.all(services.filter((service) => this.reachable.has(service.origin)).map(async (service) => {
      if ((this.snapshots.get(service.origin)?.protocolVersion ?? 1) < 2) return;
      for (const group of this.groups.values()) {
        if (group.deleted || !group.sessionIds.some((id) => sessionAddress(id)?.origin === service.origin)) continue;
        const transport = [...this.diagnostics].filter(([id]) => this.messages.get(id)?.groupId === group.id)
          .map(([message_id, diagnostic]) => ({ message_id, diagnostic,
            ...(this.messages.get(message_id)?.status === 'failed' ? { failure_reason: this.messages.get(message_id)?.failureReason } : {}) }));
        if (!transport.length) continue;
        try { await service.request('/collaboration-federation', 'POST', { group: this.groupForService(group, service.origin), messages: [], transport }); } catch { /* Retried next poll; source queue remains durable. */ }
      }
    }));
  }

  private mergeMessage(message: Message): void {
    const existing = this.messages.get(message.id);
    const rank = STATUS_RANK;
    if (!existing || rank[message.status] > rank[existing.status]) this.messages.set(message.id, message);
    // Match the bounded durable server history.
    if (this.messages.size > 2000) {
      const removable = [...this.messages.values()].find((item) => item.status !== 'pending' && item.status !== 'failed');
      if (removable) this.messages.delete(removable.id);
    }
  }

  private groupForService(group: FederationGroup, origin: string): FederationGroup {
    const remoteSessions = group.sessionIds.filter((id) => sessionAddress(id)?.origin !== origin).map((id) => {
      const address = sessionAddress(id)!;
      const session = this.sessions.get(id);
      return { sessionId: id, name: session?.name ?? address.id, cwd: session?.cwd ?? '',
        status: session?.status ?? 'offline', capability: session?.capability ?? '', currentTask: session?.currentTask ?? '',
        updatedAt: session?.updatedAt ?? 0, agent: session?.agent ?? null, backendSessionId: null, agentNativeSessionId: null,
        serviceOrigin: address.origin, serviceLabel: session?.serviceLabel ?? address.origin,
        serviceConnected: this.reachable.has(address.origin), serviceCheckedAt: Date.now() };
    });
    return { ...group, sessionIds: group.sessionIds.map((id) => localId(origin, id)), remoteSessions };
  }

  private async push(service: FederationService, group: FederationGroup): Promise<void> {
    const rank = STATUS_RANK;
    const known = new Map((this.snapshots.get(service.origin)?.messages ?? []).map((message) => [message.id, message]));
    const messages = [...this.messages.values()].filter((message) => message.groupId === group.id
      && (!known.has(message.id) || rank[message.status] > rank[known.get(message.id)!.status]))
      .map((message) => mapMessage(message, (id) => localId(service.origin, id)));
    // Group creation/deletion still travels when there are no message changes.
    if (!messages.length) {
      await service.request('/collaboration-federation', 'POST', { group: this.groupForService(group, service.origin), messages: [] });
      return;
    }
    for (const message of messages) {
      const canonical = this.messages.get(message.id)!;
      const destination = sessionAddress(canonical.toSessionId)?.origin === service.origin;
      const previous = this.diagnostics.get(message.id);
      if (destination && previous?.next_retry_at && previous.next_retry_at > Date.now() && previous.last_error !== 'PEER_UNREACHABLE') continue;
      const diagnostic: Diagnostic = { relay_online: true, peer_reachable: true,
        attempt_count: (previous?.attempt_count ?? 0) + (destination ? 1 : 0), next_retry_at: null, last_error: null, checked_at: Date.now(), fragments_sent: 0, fragments_total: 0 };
      const version = this.snapshots.get(service.origin)?.protocolVersion ?? 1;
      if (version < 2 && (String(message.content ?? '').length > 20_000 || message.responseKind || message.task || message.metadata || message.expiresAt || message.status === 'failed' || message.status === 'expired')) {
        if (destination) {
          this.messages.set(message.id, { ...canonical, status: 'failed', failureReason: 'PEER_UPGRADE_REQUIRED' });
          this.diagnostics.set(message.id, { ...diagnostic, last_error: 'PEER_UPGRADE_REQUIRED' });
        }
        continue;
      }
      try {
        const bytes = Buffer.from(JSON.stringify(message));
        if (version >= 2 && bytes.length > FRAGMENT_BYTES && !known.has(message.id)) {
          const total = Math.ceil(bytes.length / FRAGMENT_BYTES);
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          diagnostic.fragments_total = total;
          for (let index = 0; index < total; index++) {
            const result = await service.request('/collaboration-federation', 'POST', {
              group: this.groupForService(group, service.origin), messages: [], fragments: [{ message_id: message.id, group_id: group.id,
                index, total, sha256, data: bytes.subarray(index * FRAGMENT_BYTES, (index + 1) * FRAGMENT_BYTES).toString('base64') }],
            }) as Snapshot;
            const ack = result.fragmentReceipts?.find((item) => item.message_id === message.id);
            if (!ack || (index === total - 1 && !ack.complete)) throw new Error('FRAGMENT_ACK_MISSING');
            diagnostic.fragments_sent = ack.received;
            for (const received of result.messages ?? []) this.mergeMessage(mapMessage(received, (id) => qualifySession(service.origin, id)));
            if (destination) {
              this.diagnostics.set(message.id, { ...diagnostic, checked_at: Date.now() });
              // Make progress visible while a large package is still in flight.
              const source = this.services().find((candidate) => candidate.origin === sessionAddress(canonical.fromSessionId ?? '')?.origin);
              if (source && source.origin !== service.origin && (this.snapshots.get(source.origin)?.protocolVersion ?? 1) >= 2) {
                await source.request('/collaboration-federation', 'POST', { group: this.groupForService(group, source.origin), messages: [],
                  transport: [{ message_id: message.id, diagnostic }] }).catch(() => {});
              }
            }
          }
        } else {
          const result = await service.request('/collaboration-federation', 'POST', {
            group: this.groupForService(group, service.origin), messages: [message],
          }) as Snapshot;
          if (!(result.messages ?? []).some((item) => item.id === message.id)) throw new Error('PEER_REJECTED_MESSAGE');
          for (const received of result.messages ?? []) this.mergeMessage(mapMessage(received, (id) => qualifySession(service.origin, id)));
        }
        if (destination) this.diagnostics.set(message.id, { ...diagnostic, checked_at: Date.now() });
      } catch (error) {
        if (destination) this.diagnostics.set(message.id, { ...diagnostic, checked_at: Date.now(), peer_reachable: null,
          last_error: error instanceof Error ? error.message.slice(0, 300) : 'RELAY_REQUEST_FAILED',
          next_retry_at: Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(diagnostic.attempt_count, 5)) });
        // A transport failure is retryable; it is never reported as task failure.
      }
    }
  }

  async list(origin: string) {
    await this.refresh();
    const service = this.services().find((item) => item.origin === origin);
    if (!service) throw new Error('当前服务未连接');
    const local = await service.request('/collaboration-groups') as { groups: FederationGroup[]; sessions: FederationSession[] };
    const groups = [...local.groups.filter((group) => !group.federated), ...[...this.groups.values()]
      .filter((group) => !group.deleted && (group.sessionIds.some((id) => sessionAddress(id)?.origin === origin)
        || this.snapshots.get(origin)?.groups.some((item) => item.id === group.id)))
      .map((group) => this.groupForService(group, origin))];
    const sessions = [...this.sessions.values()].map((session) => ({ ...session, sessionId: localId(origin, session.sessionId) }));
    // Older services still work locally, but cannot be selected as federation targets.
    if (!this.reachable.has(origin)) sessions.push(...local.sessions);
    return { groups, sessions };
  }

  async save(origin: string, input: { id?: string; name: string; sessionIds: string[] }) {
    await this.refresh();
    const service = this.services().find((item) => item.origin === origin);
    if (!service) throw new Error('当前服务未连接');
    if (!input.id?.startsWith('cross-') && !input.sessionIds.some((id) => sessionAddress(id))) {
      return service.request('/collaboration-groups', 'POST', input);
    }
    if (!this.reachable.has(origin)) throw new Error('当前服务需要升级 Termdock 后才能跨服务组队');
    const ids = [...new Set(input.sessionIds.map((id) => qualifySession(origin, id)))];
    if (!input.name?.trim() || ids.length < 2 || ids.some((id) => !this.sessions.has(id))) throw new Error('请选择至少两个有效会话');
    const existing = input.id ? this.groups.get(input.id) : undefined;
    const group: FederationGroup = { id: existing?.id ?? `cross-${randomUUID()}`, name: input.name.trim(),
      sessionIds: ids, createdAt: existing?.createdAt ?? Date.now(), updatedAt: Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1), federated: true };
    if (input.id && !input.id.startsWith('cross-')) {
      const history = await service.request(`/collaboration-groups/${encodeURIComponent(input.id)}/messages`) as { messages: Message[] };
      for (const message of history.messages) this.mergeMessage({ ...mapMessage(message, (id) => qualifySession(origin, id)), groupId: group.id });
    }
    // First persist in the initiating server. A failed second service is retried by polling.
    await this.push(service, group);
    this.groups.set(group.id, group);
    if (input.id && !input.id.startsWith('cross-')) await service.request(`/collaboration-groups/${encodeURIComponent(input.id)}`, 'DELETE');
    await this.refresh();
    return { group: this.groupForService(group, origin) };
  }

  async remove(origin: string, id: string) {
    await this.refresh();
    const service = this.services().find((item) => item.origin === origin);
    const group = this.groups.get(id);
    if (!service || !group) throw new Error('工作组不存在');
    const deleted = { ...group, deleted: true, updatedAt: Math.max(Date.now(), group.updatedAt + 1) };
    await this.push(service, deleted);
    this.groups.set(id, deleted);
    await this.refresh();
  }
}
