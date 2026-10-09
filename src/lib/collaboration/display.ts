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
export function collaborationMemberLabel<T extends { sessionId: string; name: string; agent?: { displayName?: string } | null }>(session: T, members: T[]): string {
  const humanName = (member: T) => {
    const name = member.name.trim();
    return !name || /^(?:tmux:|remote:|wt-)/i.test(name) || name === member.sessionId
      ? member.agent?.displayName?.trim() || '成员'
      : name;
  };
  const name = humanName(session);
  const peers = members.filter(member => humanName(member) === name);
  return peers.length > 1 ? `${name} ${peers.findIndex(member => member.sessionId === session.sessionId) + 1}` : name;
}
