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

    expect(prompt).toContain('[Termdock 协作收件箱 · 1 条]');
    expect(prompt).toContain('[任务 #message-1]\n来自：用户\n协作组：发布组\n--- 消息内容 ---\n检查构建\n--- 消息结束 ---');
    expect(prompt).toContain('发布组 [group-1] · 2 个成员');
    expect(prompt).toContain('开发 Agent [coder-id] · idle');
    expect(prompt).toContain('无来源 Agent，不能运行 `td collab reply`');
    expect(prompt).not.toContain('- 回复：');
  });

  it('shows the source session id and valid reply command for an Agent message', () => {
    const prompt = formatCollaborationDelivery({
      targetSessionId: 'reviewer-id',
      messages: [message({ fromSessionId: 'coder-id', kind: 'ask', content: '测试通过了吗？\n请附上失败项。' })],
      groups: [group],
      sessions,
    });

    expect(prompt).toContain('[问题 #message-1]\n来自：开发 Agent [coder-id]\n协作组：发布组');
    expect(prompt).toContain('--- 消息内容 ---\n测试通过了吗？\n请附上失败项。\n--- 消息结束 ---');
    expect(prompt).toContain('`td collab reply <消息ID> "回复内容"`');
    expect(prompt).toContain('`td collab send <会话ID> "消息内容"`');
    expect(prompt).toContain('`td collab add <协作组ID> <会话ID>`');
    expect(prompt).toContain('`td collab remove <协作组ID> <会话ID>`');
    expect(prompt).toContain('`td collab spawn <协作组ID> <agent-slug> --name "名称" --task "初始任务"`');
  });
});
