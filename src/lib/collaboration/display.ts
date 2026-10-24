import { getSessionSnapshotPresentation, type SessionPresentationSnapshot } from '../terminal/display';

/** Addresses describe transport routes, not useful names for collaborators. */
export function collaborationServiceLabel(service: { serviceLabel?: string; serviceOrigin?: string }): string {
  const label = service.serviceLabel?.trim();
  if (!label || /^https?:\/\//i.test(label) || label === service.serviceOrigin) return '远端服务';
  try {
    const origin = new URL(service.serviceOrigin ?? '');
    if (label === origin.host || label === origin.hostname) return '远端服务';
  } catch { /* The caller may only have a user-defined alias. */ }
  return label;
}

/** Repeated Agent names need a stable distinction inside their group. */
export function collaborationMemberLabel<T extends SessionPresentationSnapshot & { sessionId: string }>(session: T, members: T[]): string {
  const humanName = (member: T) => getSessionSnapshotPresentation(member).displayName;
  const name = humanName(session);
  const peers = members.filter(member => humanName(member) === name);
  return peers.length > 1 ? `${name} ${peers.findIndex(member => member.sessionId === session.sessionId) + 1}` : name;
}

/** A saved member or its last task status is not evidence of connectivity. */
export function collaborationRemoteConnection(session: { serviceConnected?: boolean; status?: string }): 'connected' | 'disconnected' | 'unknown' {
  if (session.serviceConnected === false || ['offline', 'disconnected', 'service-unreachable', 'closed', 'exited'].includes(session.status ?? '')) return 'disconnected';
  return session.serviceConnected === true ? 'connected' : 'unknown';
}
