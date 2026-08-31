import { describe, expect, it } from 'vitest';
import type { CollaborationGroup, CollaborationMessage } from './collaborationStore.js';
import { formatCollaborationDelivery } from './collaborationPrompt.js';

const group: CollaborationGroup = {
  id: 'group-1',
  name: '发布组',
  sessionIds: ['reviewer-id', 'coder-id'],
  createdAt: 1,
  updatedAt: 1,
};

function message(overrides: Partial<CollaborationMessage>): CollaborationMessage {
  return {
    id: 'message-1',
    groupId: group.id,
    fromSessionId: null,
    toSessionId: 'reviewer-id',
    kind: 'task',
    content: '检查构建',
    threadId: 'thread-1',
    replyTo: null,
    status: 'pending',
    createdAt: 1,
    deliveredAt: null,
    readAt: null,
    ...overrides,
  };
}

const sessions = [
  { sessionId: 'reviewer-id', name: '测试 Agent', status: 'working' },
  { sessionId: 'coder-id', name: '开发 Agent', status: 'idle' },
];

describe('formatCollaborationDelivery', () => {
  it('explains how to handle a user message without suggesting an invalid reply', () => {
    const prompt = formatCollaborationDelivery({
      targetSessionId: 'reviewer-id',
      messages: [message({})],
      groups: [group],
      sessions,
    });

    expect(prompt).toContain('[任务 #message-1] 用户 → 发布组: 检查构建');
    expect(prompt).toContain('开发 Agent [coder-id] · idle');
    expect(prompt).toContain('它没有来源 Agent，不要运行 `td collab reply`');
    expect(prompt).not.toContain('回复 Agent 消息');
  });

  it('shows the source session id and valid reply command for an Agent message', () => {
    const prompt = formatCollaborationDelivery({
      targetSessionId: 'reviewer-id',
      messages: [message({ fromSessionId: 'coder-id', kind: 'ask', content: '测试通过了吗？' })],
      groups: [group],
      sessions,
    });

    expect(prompt).toContain('[问题 #message-1] 开发 Agent [coder-id] → 发布组: 测试通过了吗？');
    expect(prompt).toContain('`td collab reply <消息ID> "回复内容"`');
    expect(prompt).toContain('`td collab send <会话ID> "消息内容"`');
  });
});
