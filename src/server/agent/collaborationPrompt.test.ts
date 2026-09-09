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
  { sessionId: 'reviewer-id', agentNativeSessionId: 'native-reviewer', name: '测试 Agent', status: 'working' },
  { sessionId: 'coder-id', agentNativeSessionId: 'native-coder', name: '开发 Agent', status: 'idle' },
];

const render = (messages: CollaborationMessage[], overrides = {}) => formatCollaborationDelivery({
  targetSessionId: 'reviewer-id', messages, groups: [group], sessions, ...overrides,
});

describe('formatCollaborationDelivery', () => {
  it('keeps user tasks prominent and provides a direct way to contact peers', () => {
    const prompt = render([message({})]);
    expect(prompt).toContain('【发布组 · 用户 · 任务】');
    expect(prompt).toContain('检查构建');
    expect(prompt).toContain('直接在当前会话处理');
    expect(prompt).not.toContain('td collab reply');
    expect(prompt).toContain('td collab send coder-id "消息内容" --text');
    expect(prompt).not.toContain('native-coder');
    expect(prompt).not.toContain('group-1');
    expect(prompt).toContain('td collab --help');
    expect(prompt.length).toBeLessThan(450);
  });

  it('places a runnable reply next to each agent message without duplicating the sender', () => {
    const prompt = render([message({ fromSessionId: 'coder-id', kind: 'ask', content: '测试通过了吗？\n请附上失败项。' })]);
    expect(prompt).toContain('【发布组 · 开发 Agent】');
    expect(prompt).toContain('测试通过了吗？\n请附上失败项。');
    expect(prompt).toContain('td collab reply message-1 "回复内容" --text');
    expect(prompt).not.toContain('td collab send coder-id');
    expect(prompt).not.toContain('native-coder');
    expect(prompt).not.toContain('td collab spawn');
    expect(prompt).not.toContain('ACK');
    expect(prompt).not.toContain('[Termdock 协作');
    expect(prompt.length).toBeLessThan(450);
  });

  it('presents short conversation as prose while retaining its reply route', () => {
    const prompt = render([message({ kind: 'reply', fromSessionId: 'coder-id', content: '建议把回复放到正文下面。' })]);
    expect(prompt).toContain('【发布组 · 开发 Agent】\n建议把回复放到正文下面。\n回复：');
    expect(prompt).not.toContain('```');
  });

  it('keeps each source reply address distinct in a batch', () => {
    const prompt = render([
      message({ id: 'one', fromSessionId: 'coder-id', content: '第一条' }),
      message({ id: 'two', fromSessionId: 'another-id', content: '第二条' }),
    ]);
    expect(prompt).toContain('[Termdock 协作 · 2 条]');
    expect(prompt).toContain('第一条\n```\n回复：`td collab reply one');
    expect(prompt).toContain('第二条\n```\n回复：`td collab reply two');
    expect(prompt).toContain('another-id');
  });

  it('keeps mixed messages and embedded code unambiguous', () => {
    const body = '代码：\n```ts\nconst x = 1;\n```\n--- 正文结束 ---';
    const prompt = render([message({ content: body }), message({ id: 'message-2', fromSessionId: 'coder-id' })]);
    expect(prompt).toContain('````\n' + body + '\n````');
    expect(prompt.match(/td collab reply /g)).toHaveLength(1);
    expect(prompt).toContain('td collab reply message-2');
    expect(prompt).toContain('直接在当前会话处理');
  });

  it('provides a full-content retrieval command for oversized UTF-8 bodies', () => {
    const prompt = render([message({ content: '测'.repeat(3000), fromSessionId: 'coder-id' })]);
    expect(prompt).toContain('9000 字节');
    expect(prompt).toContain('td collab message get message-1 --json');
    expect(prompt).not.toContain('测'.repeat(3000));
  });

  it.each(['ack', 'progress', 'result'] as const)('omits protocol metadata from ordinary %s replies', (responseKind) => {
    const prompt = render([message({ fromSessionId: 'coder-id', kind: 'reply', responseKind })]);
    expect(prompt).not.toContain('状态：');
    expect(prompt).not.toContain('ACK');
    expect(prompt).not.toContain('pending');
    expect(prompt).not.toContain('--response-kind');
    expect(prompt).toContain('td collab reply message-1');
    expect(prompt.length).toBeLessThan(170);
  });

  it('keeps structured task evidence', () => {
    const task = { task_id: 'check', status: 'blocked' as const, blocker: '缺少环境' };
    expect(render([message({ task })])).toContain(JSON.stringify(task));
  });

  it('keeps offline delivery and relay requirements explicit', () => {
    const prompt = render([], {
      targetSessionId: 'local',
      groups: [{ ...group, sessionIds: ['local', 'remote:peer'] }],
      sessions: [{ sessionId: 'remote:peer', name: 'Reviewer · Mac', status: 'service-unreachable' }],
    });
    expect(prompt).toContain('服务不可达，消息无法送达');
    expect(prompt).toContain('仅可排队等待重连');
    expect(prompt).toContain('转发客户端须保持运行');
  });

  it('omits static routing help once the session is educated', () => {
    const prompt = render([message({})], { showRoutingHelp: false });
    expect(prompt).toContain('【发布组 · 用户 · 任务】');
    expect(prompt).toContain('检查构建');
    expect(prompt).toContain('直接在当前会话处理');
    expect(prompt).not.toContain('td collab send');
    expect(prompt).not.toContain('td collab --help');
    expect(prompt).not.toContain('联系其他成员');
    expect(prompt.length).toBeLessThan(220);
  });

  it('still surfaces dynamic notices while routing help is suppressed', () => {
    const prompt = render([], {
      targetSessionId: 'local', showRoutingHelp: false,
      groups: [{ ...group, sessionIds: ['local', 'remote:peer'] }],
      sessions: [{ sessionId: 'remote:peer', name: 'Reviewer · Mac', status: 'service-unreachable' }],
    });
    expect(prompt).not.toContain('td collab --help');
    expect(prompt).not.toContain('td collab send');
    expect(prompt).toContain('服务不可达，消息无法送达');
    expect(prompt).toContain('转发客户端须保持运行');
  });
});
