/** Provision only missing roles. Persist each member before proceeding so a
 * failed launch, retry or server restart cannot create another full team. */
export async function ensureTeam(options: {
  members(): Array<{ id: string; agentSlug?: string; cwd?: string | null; role?: string; launchProfileKey?: string; creationKey?: string }>;
  agentSlug: string; cwd: string; launchProfileKey?: string;
  /** Undefined reuses a matching member; null explicitly creates a coordinator. */
  coordinatorSessionId?: string | null;
  coordinatorCreationKey?: string;
  spawn(role: string, creationKey?: string): Promise<string>;
}): Promise<{ coordinatorSessionId: string; reviewerSessionIds: string[] }> {
  const ids: string[] = [];
  const labels = [`自动协调者 (${options.agentSlug})`, `自动执行与评审 (${options.agentSlug})`];
  if (typeof options.coordinatorSessionId === 'string') {
    const coordinator = options.members().find(member => member.id === options.coordinatorSessionId && member.agentSlug);
    if (!coordinator) throw new Error('所选协调者已离组或未运行 Agent，请重新选择');
    ids.push(coordinator.id);
  }
  for (const role of labels.slice(ids.length)) {
    const members = options.members();
    const forceNew = ids.length === 0 && options.coordinatorSessionId === null;
    const reserved = members.find(member => !ids.includes(member.id) && (forceNew && options.coordinatorCreationKey ? member.creationKey === options.coordinatorCreationKey : member.role?.startsWith(role.split(' (')[0])));
    if (reserved && (reserved.role !== role || reserved.cwd !== options.cwd || (reserved.launchProfileKey ?? '') !== (options.launchProfileKey ?? ''))) {
      throw new Error('本组已有自动配置的成员，请使用原 Agent、启动方案和目录，或在成员设置中移出后重新配置');
    }
    const existing = reserved ?? (!forceNew ? members.find(member => !ids.includes(member.id) && member.agentSlug === options.agentSlug && member.cwd === options.cwd && (member.launchProfileKey ?? '') === (options.launchProfileKey ?? '')) : undefined);
    ids.push(existing?.id ?? await options.spawn(role, forceNew ? options.coordinatorCreationKey : undefined));
  }
  return { coordinatorSessionId: ids[0], reviewerSessionIds: [ids[1]] };
}
