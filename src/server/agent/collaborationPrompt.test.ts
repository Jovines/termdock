import { describe, expect, it } from 'vitest';
import type { CollaborationGroup, CollaborationMessage } from './collaborationStore.js';
import { COLLAB_NAME_FORBIDDEN, formatCollaborationDelivery, sanitizeCollaborationName } from './collaborationPrompt.js';

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

const RULE = '─'.repeat(30);

describe('COLLAB_NAME_FORBIDDEN / sanitizeCollaborationName', () => {
  it('flags characters that would corrupt the delivery shell', () => {
    expect(COLLAB_NAME_FORBIDDEN.test('「发布」')).toBe(true);
    expect(COLLAB_NAME_FORBIDDEN.test('a·b')).toBe(true);
    expect(COLLAB_NAME_FORBIDDEN.test('行一\n行二')).toBe(true);
    expect(COLLAB_NAME_FORBIDDEN.test('\x1b[31mred')).toBe(true);
    expect(COLLAB_NAME_FORBIDDEN.test('普通 名称 v1')).toBe(false);
  });

  it('neutralizes reserved characters for shell rendering', () => {
    expect(sanitizeCollaborationName('A · B')).toBe('A B');
    expect(sanitizeCollaborationName('【发布】「v2」')).toBe('发布 v2');
    // ESC itself is stripped; residue like "[31m" is inert plain text once
    // the control introducer is gone.
    expect(sanitizeCollaborationName('第一行\n第二行\t\x1b[31m')).toBe('第一行 第二行 [31m');
  });

  it('caps over-long names with an ellipsis', () => {
    expect(sanitizeCollaborationName('x'.repeat(80), 40)).toBe(`${'x'.repeat(39)}…`);
    expect(sanitizeCollaborationName('short')).toBe('short');
  });

  it('keeps the shell open and unbroken for hostile names', () => {
    const evil = render([message({ fromSessionId: 'coder-id' })], {
      groups: [{ ...group, name: '【协作】「v2」组\n改行' }],
      sessions: [{ ...sessions[1]!, name: '名字·带「引号」\n换行' }],
    });
    const lines = evil.split('\n');
    expect(lines[0]).toBe(RULE);
    expect(lines[1]).toBe('协作消息 · 组「协作 v2 组 改行」');
    const source = lines.find((line) => line.startsWith('来自:'));
    expect(source).toBe('来自:名字 带 引号 换行 · task');
    // The shell's own 「」 and · are structural, so only the sanitized name
    // regions are asserted above; nothing may smuggle control characters in.
    for (const line of lines) expect(line).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(evil).not.toContain('【');
    expect(evil).not.toContain('名字·带');
  });
});

describe('formatCollaborationDelivery', () => {
  it('opens a group-named shell with a fenced user task and routing help outside', () => {
    const prompt = render([message({})]);
    const lines = prompt.split('\n');
    expect(lines[0]).toBe(RULE);
    expect(lines[1]).toBe('协作消息 · 组「发布组」');
    expect(prompt).toContain('来自:用户 · task');
    expect(prompt).toContain('```\n检查构建\n```');
    expect(prompt).not.toContain('td collab reply');
    expect(prompt).toContain('td collab send coder-id "消息内容" --text');
    expect(prompt).not.toContain('native-coder');
    expect(prompt).not.toContain('group-1');
    expect(prompt).toContain('td collab --help');
    expect(lines.at(-1)).toBe(RULE);
    expect(prompt.length).toBeLessThan(500);
  });

  it('labels the sender and kind above an agent message fenced in full', () => {
    const prompt = render([message({ fromSessionId: 'coder-id', kind: 'ask', content: '测试通过了吗？\n请附上失败项。' })]);
    expect(prompt).toContain('来自:开发 Agent · ask');
    expect(prompt).toContain('```\n测试通过了吗？\n请附上失败项。\n```');
    expect(prompt).toContain('回复:td collab reply message-1 "回复内容" --text');
    expect(prompt).not.toContain('td collab send coder-id');
    expect(prompt).not.toContain('native-coder');
    expect(prompt).not.toContain('td collab spawn');
    expect(prompt).not.toContain('ACK');
    expect(prompt).not.toContain('[Termdock 协作');
    expect(prompt.length).toBeLessThan(500);
  });

  it('fences even a short single reply so its body cannot be mistaken for prose', () => {
    const prompt = render([message({ kind: 'reply', fromSessionId: 'coder-id', content: '建议把回复放到正文下面。' })]);
    expect(prompt).toContain('来自:开发 Agent · reply');
    expect(prompt).toContain('```\n建议把回复放到正文下面。\n```');
    expect(prompt).toContain('\n回复:td collab reply message-1 "回复内容" --text');
    expect(prompt).not.toContain('来自:开发 Agent · reply\n建议把回复放到正文下面。');
  });

  it('keeps each source reply address distinct inside one shell', () => {
    const prompt = render([
      message({ id: 'one', fromSessionId: 'coder-id', content: '第一条' }),
      message({ id: 'two', fromSessionId: 'another-id', content: '第二条' }),
    ]);
    expect(prompt.split(RULE).length).toBe(3);
    expect(prompt).not.toContain('[Termdock 协作');
    expect(prompt).toContain('来自:开发 Agent · task\n\n```\n第一条\n```\n\n回复:td collab reply one');
    expect(prompt).toContain('来自:another-id · task\n\n```\n第二条\n```\n\n回复:td collab reply two');
  });

  it('keeps mixed messages and embedded code unambiguous', () => {
    const body = '代码：\n```ts\nconst x = 1;\n```\n--- 正文结束 ---';
    const prompt = render([message({ content: body }), message({ id: 'message-2', fromSessionId: 'coder-id' })]);
    expect(prompt).toContain('````\n' + body + '\n````');
    expect(prompt.match(/td collab reply /g)).toHaveLength(1);
    expect(prompt).toContain('td collab reply message-2');
    expect(prompt).not.toContain('td collab reply message-1');
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
    expect(prompt.length).toBeLessThan(400);
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
    expect(prompt).toContain('协作消息 · 组「发布组」');
    expect(prompt).toContain('来自:用户 · task');
    expect(prompt).toContain('```\n检查构建\n```');
    expect(prompt).not.toContain('td collab send');
    expect(prompt).not.toContain('td collab --help');
    expect(prompt).not.toContain('联系其他成员');
    expect(prompt.length).toBeLessThan(350);
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
