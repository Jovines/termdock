/** Provision only missing roles. Persist each member before proceeding so a
 * failed launch, retry or server restart cannot create another full team. */
export async function ensureTeam(options: {
  members(): Array<{ id: string; agentSlug?: string; cwd?: string | null; role?: string }>;
  agentSlug: string; cwd: string;
  spawn(role: string): Promise<string>;
}): Promise<{ coordinatorSessionId: string; reviewerSessionIds: string[] }> {
  const ids: string[] = [];
  const labels = [`自动协调者 (${options.agentSlug})`, `自动执行与评审 (${options.agentSlug})`];
  for (const role of labels) {
    const members = options.members();
    const reserved = members.find(member => member.role?.startsWith(role.split(' (')[0]));
    if (reserved && (reserved.role !== role || reserved.cwd !== options.cwd)) {
      throw new Error('本组已有自动配置的成员，请使用原 Agent 和目录，或在成员设置中移出后重新配置');
    }
    const existing = reserved ?? members.find(member => !ids.includes(member.id) && member.agentSlug === options.agentSlug && member.cwd === options.cwd);
    ids.push(existing?.id ?? await options.spawn(role));
  }
  return { coordinatorSessionId: ids[0], reviewerSessionIds: [ids[1]] };
}
