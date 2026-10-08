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
export function collaborationMemberLabel<T extends { sessionId: string; name: string }>(session: T, members: T[]): string {
  const peers = members.filter(member => member.name.trim() === session.name.trim());
  return peers.length > 1 ? `${session.name} ${peers.findIndex(member => member.sessionId === session.sessionId) + 1}` : session.name;
}
