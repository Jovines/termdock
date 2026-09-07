import { randomUUID } from 'node:crypto';

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
  status: 'pending' | 'delivered' | 'read';
  [key: string]: unknown;
}
interface Snapshot {
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
    await Promise.all(services.filter((service) => this.reachable.has(service.origin)).map(async (service) => {
      for (const group of this.groups.values()) {
        try { await this.push(service, group); } catch { this.reachable.delete(service.origin); }
      }
    }));
  }

  private mergeMessage(message: Message): void {
    const existing = this.messages.get(message.id);
    const rank = { pending: 0, delivered: 1, read: 2 };
    if (!existing || rank[message.status] > rank[existing.status]) this.messages.set(message.id, message);
    // Match the bounded durable server history.
    if (this.messages.size > 2000) this.messages.delete(this.messages.keys().next().value!);
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
    const rank = { pending: 0, delivered: 1, read: 2 };
    const known = new Map((this.snapshots.get(service.origin)?.messages ?? []).map((message) => [message.id, message]));
    const messages = [...this.messages.values()].filter((message) => message.groupId === group.id
      && (!known.has(message.id) || rank[message.status] > rank[known.get(message.id)!.status]))
      .map((message) => mapMessage(message, (id) => localId(service.origin, id)));
    for (let offset = 0; offset < Math.max(1, messages.length); offset += 25) {
      const result = await service.request('/collaboration-federation', 'POST', {
        group: this.groupForService(group, service.origin), messages: messages.slice(offset, offset + 25),
      }) as Snapshot;
      for (const message of result.messages ?? []) this.mergeMessage(mapMessage(message, (id) => qualifySession(service.origin, id)));
    }
  }

  async list(origin: string) {
    await this.refresh();
    const service = this.services().find((item) => item.origin === origin);
    if (!service) throw new Error('当前服务未连接');
    const local = await service.request('/collaboration-groups') as { groups: FederationGroup[]; sessions: FederationSession[] };
    const groups = [...local.groups.filter((group) => !group.federated), ...[...this.groups.values()]
      .filter((group) => !group.deleted).map((group) => this.groupForService(group, origin))];
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
