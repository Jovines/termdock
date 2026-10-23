import type { AuthorizationGrant } from './authorization.js';
import type { PendingInvitation } from './invitations.js';
export class SessionSharingPresence {
  private connections = new Map<string, { device: string; sessions: Map<string, number> }>();
  visit(connection: string, device: string, session: string): void {
    const current = this.connections.get(connection) || { device, sessions: new Map<string, number>() };
    current.sessions.set(session, Date.now()); this.connections.set(connection, current);
  }
  private streams = new Map<string, { connection: string; device: string; session: string }>();
  openStream(key: string, connection: string, device: string, session: string): void { this.streams.set(key, { connection, device, session }); }
  closeStream(key: string): void { this.streams.delete(key); }
  close(connection: string): void { this.connections.delete(connection); for (const [key, stream] of this.streams) if (stream.connection === connection) this.streams.delete(key); }
  summary(grants: AuthorizationGrant[], invitations: PendingInvitation[], normalize: (id: string) => string) {
    const result = new Map<string, { sessionId: string; devices: Set<string>; invitations: number }>();
    const record = (id: string) => { const key = normalize(id); let item = result.get(key); if (!item) { item = { sessionId: key, devices: new Set(), invitations: 0 }; result.set(key, item); } return item; };
    for (const grant of grants) if (grant.scope.kind === 'sessions') for (const id of grant.scope.sessionIds) record(id).devices.add(grant.subjectId);
    for (const invite of invitations) if (invite.scope.kind === 'sessions') for (const id of invite.scope.sessionIds) record(id).invitations++;
    return [...result.values()].map(item => { const online = new Set<string>(); for (const connection of this.connections.values()) if (Date.now() - (connection.sessions.get(item.sessionId) || 0) < 15_000 && item.devices.has(connection.device)) online.add(connection.device); for (const stream of this.streams.values()) if (stream.session === item.sessionId && item.devices.has(stream.device)) online.add(stream.device);
      return { sessionId: item.sessionId, devices: item.devices.size, connectedDevices: online.size, invitations: item.invitations }; });
  }
}
