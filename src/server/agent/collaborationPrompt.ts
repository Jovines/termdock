import type { CollaborationGroup, CollaborationMessage, CollaborationMessageKind } from './collaborationStore.js';

interface CollaborationPromptSession {
  sessionId: string;
  agentNativeSessionId?: string | null;
  name: string;
  status: string;
}

const MESSAGE_LABELS: Record<CollaborationMessageKind, string> = {
  message: '消息',
  ask: '问题',
  reply: '回复',
  task: '任务',
  handoff: '交接',
  done: '完成',
};

export function formatCollaborationDelivery(input: {
  targetSessionId: string;
  messages: CollaborationMessage[];
  groups: CollaborationGroup[];
  sessions: CollaborationPromptSession[];
  /**
   * false: omit the static routing help (peer roster + `td collab --help`
   * pointer). Dynamic notices (unreachable peers, cross-service keep-alive)
   * are always included — they report current conditions, not education.
   * Callers gate this on a per-session education state keyed by roster.
   */
  showRoutingHelp?: boolean;
}): string {
  const groupsById = new Map(input.groups.map((group) => [group.id, group]));
  const sessionsById = new Map(input.sessions.map((session) => [session.sessionId, session]));
  const messageBlocks = input.messages.map((message) => {
    const sourceSession = message.fromSessionId ? sessionsById.get(message.fromSessionId) : null;
    const source = message.fromSessionId
      ? sourceSession?.name ?? message.fromSessionId
      : '用户';
    const group = groupsById.get(message.groupId)?.name ?? '协作组';
    const body = Buffer.byteLength(message.content) > 8_192
      ? `大消息已完整保存（${Buffer.byteLength(message.content)} 字节）。使用 td collab message get ${message.id} --json 获取正文；不要把这条提示当作任务正文。`
      : message.content;
    const fence = '`'.repeat(Math.max(3, ...Array.from(body.matchAll(/`+/g), (match) => match[0].length + 1)));
    const plainBody = input.messages.length === 1 && !/[\r\n`]/.test(body) && body.length <= 240;
    return [
      `【${group} · ${source}${['task', 'handoff', 'done'].includes(message.kind) ? ` · ${MESSAGE_LABELS[message.kind]}` : ''}】`,
      ...(plainBody ? [body] : [fence, body, fence]),
      ...(message.task ? [`任务上报：${JSON.stringify(message.task)}`] : []),
      message.fromSessionId
        ? `回复：\`td collab reply ${message.id} "回复内容" --text\``
        : '用户消息：直接在当前会话处理，无需回复收件箱。',
    ].join('\n');
  });
  const peerIds = Array.from(new Set(input.groups.flatMap((group) => group.sessionIds)))
    .filter((sessionId) => sessionId !== input.targetSessionId);
  // Keep routing IDs once, only for peers who are not already directly replyable.
  const sourceIds = new Set(input.messages.map((message) => message.fromSessionId));
  const peers = peerIds.filter((id) => !sourceIds.has(id)).map((sessionId) => {
    const session = sessionsById.get(sessionId);
    return `- ${session?.name ?? '离线会话'}：\`td collab send ${sessionId} "消息内容" --text\``;
  });
  const unreachable = peerIds.filter((id) => sessionsById.get(id)?.status === 'service-unreachable');
  const routingHelp = input.showRoutingHelp === false ? [] : [
    ...(peers.length ? ['联系其他成员：', ...peers] : []),
    '更多操作：`td collab --help`。',
  ];
  const dynamicNotices = [
    ...(peerIds.some((id) => id.startsWith('remote:'))
      ? ['跨服务通信使用 td collab；转发客户端须保持运行，网页或 PWA 暂停后需返回前台继续转发。'] : []),
    ...unreachable.map((id) => `注意：${sessionsById.get(id)?.name ?? id} 服务不可达，消息无法送达；仅可排队等待重连。`),
  ];

  return [
    ...(input.messages.length > 1 ? [`[Termdock 协作 · ${input.messages.length} 条]`, ''] : []),
    messageBlocks.join('\n\n'),
    ...(routingHelp.length || dynamicNotices.length ? ['', ...routingHelp, ...dynamicNotices] : []),
  ].join('\n');
}
