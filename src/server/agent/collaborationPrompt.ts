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
  const messageBlocks = input.messages.map((message) => {
    const source = message.fromSessionId
      ? `${sessionsById.get(message.fromSessionId)?.name ?? message.fromSessionId} [${message.fromSessionId}]`
      : '用户';
    const group = groupsById.get(message.groupId)?.name ?? '协作组';
    return [
      `[${MESSAGE_LABELS[message.kind]} #${message.id}]`,
      `来自：${source}`,
      `协作组：${group}`,
      '--- 消息内容 ---',
      message.content,
      '--- 消息结束 ---',
    ].join('\n');
  });
  const peerIds = Array.from(new Set(input.groups.flatMap((group) => group.sessionIds)))
    .filter((sessionId) => sessionId !== input.targetSessionId);
  const peers = peerIds.map((sessionId) => {
    const session = sessionsById.get(sessionId);
    return `- ${session?.name ?? '离线会话'} [${sessionId}] · ${session?.status ?? 'offline'}`;
  });
  const hasUserMessage = input.messages.some((message) => message.fromSessionId === null);
  const hasAgentMessage = input.messages.some((message) => message.fromSessionId !== null);
  const groupLines = input.groups.map((group) => `- ${group.name} [${group.id}] · ${group.sessionIds.length} 个成员`);
  const instructions = [
    ...(hasUserMessage ? ['- 用户消息：直接在当前会话回答或执行（无来源 Agent，不能运行 `td collab reply`）。'] : []),
    ...(hasAgentMessage ? ['- 回复：`td collab reply <消息ID> "回复内容"`'] : []),
    '- 发消息：`td collab send <会话ID> "消息内容"`',
    '- 交接：`td collab handoff <会话ID> "交接摘要"`',
    '- 加成员：`td collab add <协作组ID> <会话ID>`',
    '- 移成员：`td collab remove <协作组ID> <会话ID>`',
    '- 新建 Agent：`td collab spawn <协作组ID> <agent-slug> --name "名称" --task "初始任务"`',
    '- 查看：`td collab status` / `td collab inbox`',
  ];

  return [
    `[Termdock 协作收件箱 · ${input.messages.length} 条]`,
    '',
    messageBlocks.join('\n\n'),
    '',
    '协作组：',
    ...groupLines,
    '',
    '同组成员：',
    ...(peers.length > 0 ? peers : ['- 暂无其他成员']),
    '',
    '可用操作：',
    ...instructions,
  ].join('\n');
}
