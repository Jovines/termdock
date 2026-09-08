import type { CollaborationGroup, OrchestrationSession } from '../terminal/api';

export interface CollaborationPeerService {
  origin: string;
  label: string;
  connected: boolean;
}
export interface CollaborationPeers {
  protocolVersion?: number;
  origin?: string;
  sessions: OrchestrationSession[];
  services?: CollaborationPeerService[];
}
export interface CollaborationPeerState {
  state: 'unavailable' | 'loading' | 'ready' | 'partial' | 'error' | 'unsupported';
  checkedAt: number | null;
  error?: string;
  services?: CollaborationPeerService[];
}
export interface CollaborationDirectoryData {
  groups: CollaborationGroup[];
  sessions: OrchestrationSession[];
  peers?: CollaborationPeerState;
  capabilities?: { groupRevision?: number; groupPromotion?: number; groupMove?: number };
}
export interface CollaborationDirectorySource {
  origin: string;
  readLocal(): Promise<CollaborationDirectoryData>;
  readPeers?: () => Promise<CollaborationPeers>;
  peerProtocol?: 'legacy' | 'v2' | 'unsupported';
}

export function remoteSessionAddress(id: string): { origin: string; id: string } | null {
  if (!id.startsWith('remote:')) return null;
  const parts = id.slice(7).split(':');
  if (parts.length !== 2) return null;
  try {
    const origin = decodeURIComponent(parts[0]);
    const localId = decodeURIComponent(parts[1]);
    if (!localId || new URL(origin).origin !== origin || !/^https?:/.test(origin)) return null;
    return { origin, id: localId };
  } catch { return null; }
}

/** Current-service reads are authoritative. Peer discovery is optional and never gates them. */
export class CollaborationDirectory {
  private local: CollaborationDirectoryData | null = null;
  private remote: OrchestrationSession[] = [];
  private peers: CollaborationPeerState;
  private localInFlight: Promise<CollaborationDirectoryData> | null = null;
  private peerInFlight: Promise<void> | null = null;
  private listeners = new Set<(data: CollaborationDirectoryData) => void>();
  private disposed = false;
  private peerTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPeerAttempt = -Infinity;
  private generation = 0;
  private localHealthy = false;

  constructor(private readonly source: CollaborationDirectorySource) {
    this.peers = { state: source.peerProtocol === 'unsupported' ? 'unsupported' : source.readPeers ? 'loading' : 'unavailable', checkedAt: null };
  }

  subscribe(listener: (data: CollaborationDirectoryData) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  snapshot(): CollaborationDirectoryData | null {
    if (!this.local) return null;
    const sessions = new Map<string, OrchestrationSession>();
    // Persisted members remain visible when the desktop or a peer is unavailable.
    for (const group of this.local.groups) for (const session of group.remoteSessions ?? []) {
      const address = remoteSessionAddress(session.sessionId);
      if (address && address.origin !== this.source.origin) {
        sessions.set(session.sessionId, { ...session, status: 'offline', serviceConnected: false });
      }
    }
    for (const session of this.remote) sessions.set(session.sessionId, session);
    for (const session of this.local.sessions) sessions.set(session.sessionId, session);
    return { groups: this.local.groups, sessions: [...sessions.values()], peers: this.peers, capabilities: this.local.capabilities };
  }

  private emit(): void {
    if (this.disposed || !this.localHealthy) return;
    const value = this.snapshot();
    if (value) for (const listener of this.listeners) listener(value);
  }

  load(): Promise<CollaborationDirectoryData> {
    if (this.disposed) return Promise.reject(new Error('协作连接已切换，请重新加载'));
    if (this.localInFlight) return this.localInFlight;
    this.refreshPeers();
    const generation = this.generation;
    const request = Promise.resolve().then(() => this.source.readLocal()).then((data) => {
      if (this.disposed) throw new Error('协作连接已切换，请重新加载');
      if (generation !== this.generation) return this.load();
      if (!Array.isArray(data.groups) || !Array.isArray(data.sessions)) throw new Error('协作会话响应无效，请更新服务后重试');
      this.local = data;
      this.localHealthy = true;
      this.emit();
      return this.snapshot()!;
    }).catch((error) => {
      if (generation === this.generation) this.localHealthy = false;
      throw error;
    }).finally(() => { if (this.localInFlight === request) this.localInFlight = null; });
    this.localInFlight = request;
    return request;
  }

  invalidate(): void {
    this.generation++;
    this.localInFlight = null;
    this.localHealthy = false;
  }

  refreshPeers(force = false): void {
    if (this.disposed || !this.source.readPeers || this.peerInFlight) return;
    // The sidebar and workbench share one discovery request, including after a fast failure.
    if (!force && Date.now() - this.lastPeerAttempt < 2000) return;
    this.lastPeerAttempt = Date.now();
    if (!this.peers.checkedAt) this.peers = { state: 'loading', checkedAt: null };
    this.emit();
    const read = this.source.readPeers;
    this.peerInFlight = Promise.race([
      Promise.resolve().then(() => read()),
      new Promise<never>((_resolve, reject) => {
        this.peerTimer = setTimeout(() => reject(new Error('跨服务会话加载超时')), 5000);
      }),
    ]).then((data) => {
      if (this.disposed) return;
      if (!Array.isArray(data.sessions) || (this.source.peerProtocol === 'v2' && (data.protocolVersion !== 2 || data.origin !== this.source.origin))
        || (data.origin && data.origin !== this.source.origin)
        || (data.protocolVersion !== undefined && data.protocolVersion !== 2)) {
        throw new Error('客户端协作能力不兼容，请更新客户端');
      }
      this.remote = data.sessions.filter((session) => {
        const address = remoteSessionAddress(session.sessionId);
        return address && address.origin !== this.source.origin;
      });
      const services = data.services?.filter((service) => service.origin !== this.source.origin);
      this.peers = { state: services?.some((service) => !service.connected) ? 'partial' : 'ready', checkedAt: Date.now(), services };
    }).catch((error) => {
      if (this.disposed) return;
      this.remote = this.remote.map((session) => ({ ...session, status: 'offline', serviceConnected: false }));
      this.peers = { state: 'error', checkedAt: Date.now(), error: error instanceof Error ? error.message : '跨服务会话加载失败' };
    }).finally(() => {
      clearTimeout(this.peerTimer);
      this.peerInFlight = null;
      this.emit();
    });
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.peerTimer);
    this.listeners.clear();
    this.local = null;
    this.remote = [];
  }
}
