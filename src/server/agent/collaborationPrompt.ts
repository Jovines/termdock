import type { CollaborationGroup, CollaborationMessage, CollaborationMessageKind } from './collaborationStore.js';

interface CollaborationPromptSession {
  sessionId: string;
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
}): string {
  const groupsById = new Map(input.groups.map((group) => [group.id, group]));
  const sessionsById = new Map(input.sessions.map((session) => [session.sessionId, session]));
  const lines = input.messages.map((message) => {
    const source = message.fromSessionId
      ? `${sessionsById.get(message.fromSessionId)?.name ?? message.fromSessionId} [${message.fromSessionId}]`
      : '用户';
    const group = groupsById.get(message.groupId)?.name ?? '协作组';
    return `- [${MESSAGE_LABELS[message.kind]} #${message.id}] ${source} → ${group}: ${message.content}`;
  });
  const peerIds = Array.from(new Set(input.groups.flatMap((group) => group.sessionIds)))
    .filter((sessionId) => sessionId !== input.targetSessionId);
  const peers = peerIds.map((sessionId) => {
    const session = sessionsById.get(sessionId);
    return `- ${session?.name ?? '离线会话'} [${sessionId}] · ${session?.status ?? 'offline'}`;
  });
  const hasUserMessage = input.messages.some((message) => message.fromSessionId === null);
  const hasAgentMessage = input.messages.some((message) => message.fromSessionId !== null);
  const instructions = [
    ...(hasUserMessage ? ['- 用户发来的消息：直接在当前会话回答或执行；它没有来源 Agent，不要运行 `td collab reply`。'] : []),
    ...(hasAgentMessage ? ['- 回复 Agent 消息：`td collab reply <消息ID> "回复内容"`'] : []),
    '- 主动联系成员：`td collab send <会话ID> "消息内容"`',
    '- 交接工作：`td collab handoff <会话ID> "交接摘要"`',
    '- 查看成员和收件箱：`td collab status` / `td collab inbox`',
  ];

  return [
    '[Termdock 协作收件箱]',
    ...lines,
    '',
    '同组成员（方括号内是可直接使用的会话 ID）：',
    ...(peers.length > 0 ? peers : ['- 暂无其他成员']),
    '',
    '处理方式：',
    ...instructions,
  ].join('\n');
}
