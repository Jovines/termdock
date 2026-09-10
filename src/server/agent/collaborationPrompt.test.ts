import { describe, expect, it } from 'vitest';
import type { CollaborationGroup, CollaborationMessage } from './collaborationStore.js';
import { COLLAB_NAME_FORBIDDEN, collaborationMessageAnchorTokens, formatCollaborationDelivery, sanitizeCollaborationName } from './collaborationPrompt.js';

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
    expect(lines[1]).toBe('「协作 v2 组 改行」群(2 个成员)');
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
    expect(lines[1]).toBe('「发布组」群(2 个成员)');
    expect(prompt).toContain('来自:用户 · task');
    expect(prompt).toContain('```\n检查构建\n```');
    // A user message has no agent to reply to (the reply route refuses it), so
    // its anchor line is the read-back command instead.
    expect(prompt).not.toContain('td collab reply');
    expect(prompt).toContain('详情:td collab message get message-1 --json');
    expect(prompt).toContain('td collab send coder-id "消息内容" --text');
    expect(prompt).not.toContain('native-coder');
    expect(prompt).not.toContain('group-1');
    expect(prompt).toContain('td collab --help');
    expect(lines.at(-1)).toBe(RULE);
    expect(prompt.length).toBeLessThan(500);
  });

  it('carries its id in every delivered block, whatever the source or body size', () => {
    // The delivery-confirm gate searches the recipient terminal for the anchor
    // token; a block without it can never confirm and gets written again. Pin
    // the invariant for every source and every body shape, oversized bodies too
    // (those are replaced by a retrieval pointer, which must still name the id).
    const uuid = '01234567-89ab-4def-8123-456789abcdef';
    const built = [
      message({ id: 'user-small' }),
      message({ id: 'user-long', content: '长'.repeat(3_000) }),
      message({ id: 'agent-small', fromSessionId: 'coder-id' }),
      message({ id: 'agent-long', fromSessionId: 'coder-id', content: '长'.repeat(3_000) }),
      message({ id: 'agent-task', fromSessionId: 'coder-id', task: { task_id: 't', status: 'complete' } }),
      message({ id: 'fanned', fromSessionId: 'coder-id', fanOutIds: ['reviewer-id'] }),
      message({ id: uuid }),
    ];
    for (const item of built) {
      const token = collaborationMessageAnchorTokens([item]).get(item.id)!;
      expect(render([item])).toContain(token);
    }
    // A canonical uuid shows as its short prefix; a non-uuid id (a
    // hand-written session id, a remote address) passes through whole.
    expect(render([message({ id: uuid })])).toContain(uuid.slice(0, 10));
    expect(render([message({ id: uuid })])).not.toContain(uuid);
    expect(render([message({ id: '40bc89py' })])).toContain('40bc89py');
    // One block per message: the shell header never doubles as an anchor.
    const batch = render([message({ id: 'first' }), message({ id: 'second', fromSessionId: 'coder-id' })]);
    expect(batch).toContain('first');
    expect(batch).toContain('second');
  });

  it('shows full ids when two blocks in one delivery share a short id', () => {
    // A shared prefix is not a usable anchor: the gate's `includes` search
    // would match the sibling's block. Both blocks fall back to their full id.
    // Sharing the shortened form means sharing all 8 characters of the uuid's
    // first group *and* the character after the hyphen, so that is what the
    // fixture has to share for the collision to exist at the current length.
    const left = 'abcdef01-1111-4111-8111-111111111111';
    const right = 'abcdef01-1222-4222-8222-222222222222';
    expect(left.slice(0, 10)).toBe(right.slice(0, 10));
    const prompt = render([message({ id: left }), message({ id: right, fromSessionId: 'coder-id' })]);
    expect(prompt).toContain(left);
    expect(prompt).toContain(right);
    // Alone each shortens again — the fallback is scoped to the delivery.
    expect(render([message({ id: left })])).toContain('abcdef01-1');
    expect(render([message({ id: left })])).not.toContain(left);
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

  it('rides the recipient name and role under the header of a single-group delivery', () => {
    const prompt = render([message({ fromSessionId: 'coder-id' })], {
      groups: [{ ...group, roles: { 'reviewer-id': '最终验收', 'coder-id': '开发与自测' } }],
    });
    const lines = prompt.split('\n');
    expect(lines[0]).toBe(RULE);
    expect(lines[1]).toBe('「发布组」群(2 个成员)');
    expect(lines[2]).toBe('你的名字:测试 Agent');
    expect(lines[3]).toBe('你的定位:最终验收');
    // The identity block flows straight into the message — no blank line
    // between the role line and the first `来自:` line.
    expect(lines[4]).toBe('来自:开发 Agent · task');
    // The reply route runs directly into the notes; no blank separator.
    expect(prompt).toContain('回复:td collab reply message-1 "回复内容" --text\n更多操作：`td collab --help`。');
    expect(prompt).not.toContain('开发与自测');
    expect(prompt).not.toContain('coder-id:');
  });

  it('sanitizes the recipient name line and skips it when the session is unknown', () => {
    const prompt = render([message({})], {
      sessions: [{ ...sessions[0]!, name: '名字·带「引号」\n换行' }],
    });
    const lines = prompt.split('\n');
    expect(lines[2]).toBe('你的名字:名字 带 引号 换行');
    for (const line of lines) expect(line).not.toMatch(/[\x00-\x1f\x7f]/);
    const ghost = render([message({})], { targetSessionId: 'ghost-id' });
    expect(ghost).not.toContain('你的名字:');
  });

  it('never injects a role line when unset or the batch spans groups, but still names the recipient', () => {
    expect(render([message({})])).toContain('你的名字:测试 Agent');
    expect(render([message({})])).not.toContain('你的定位:');
    const cross = render([message({ groupId: 'one' }), message({ id: 'two', groupId: 'two' })], {
      groups: [
        { ...group, id: 'one', roles: { 'reviewer-id': '验收' } },
        { ...group, id: 'two' },
      ],
    });
    expect(cross).toContain('你的名字:测试 Agent');
    expect(cross).not.toContain('你的定位:');
    expect(cross.split(RULE).length).toBe(3);
  });

  it('defensively sanitizes hostile role text that slipped into storage', () => {
    const prompt = render([message({})], { groups: [{ ...group, roles: { 'reviewer-id': '第一行\n第二行\x1b[31m 尾部' } }] });
    expect(prompt).toContain('你的定位:第一行 第二行 [31m 尾部');
    for (const line of prompt.split('\n')) expect(line).not.toMatch(/[\x00-\x1f\x7f]/);
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

  it('decays roster education once the session is educated but keeps the --help pointer', () => {
    const prompt = render([message({})], { showRoutingHelp: false });
    expect(prompt).toContain('「发布组」群');
    expect(prompt).toContain('来自:用户 · task');
    expect(prompt).toContain('```\n检查构建\n```');
    expect(prompt).not.toContain('td collab send');
    expect(prompt).not.toContain('联系其他成员');
    // The one-line entrance to the full command surface rides every shell.
    expect(prompt).toContain('td collab --help');
    expect(prompt.length).toBeLessThan(400);
  });

  it('still surfaces dynamic notices while routing help is suppressed', () => {
    const prompt = render([], {
      targetSessionId: 'local', showRoutingHelp: false,
      groups: [{ ...group, sessionIds: ['local', 'remote:peer'] }],
      sessions: [{ sessionId: 'remote:peer', name: 'Reviewer · Mac', status: 'service-unreachable' }],
    });
    expect(prompt).not.toContain('td collab send');
    expect(prompt).toContain('td collab --help');
    expect(prompt).toContain('服务不可达，消息无法送达');
    expect(prompt).toContain('转发客户端须保持运行');
  });

  it('flags a fan-out dispatch as 群发 and names the sibling recipients', () => {
    const prompt = render([message({ fanOutIds: ['coder-id'] })]);
    expect(prompt).toContain('来自:用户 · task · 群发');
    expect(prompt).toContain('同时发给了:开发 Agent');
    expect(prompt).toContain('```\n检查构建\n```');
    expect(prompt).not.toContain('回复:td collab reply');
    const agentPrompt = render([message({ fromSessionId: 'coder-id', fanOutIds: ['another-id'] })], {
      sessions: [...sessions, { sessionId: 'another-id', agentNativeSessionId: null, name: '第三位', status: 'idle' }],
    });
    expect(agentPrompt).toContain('来自:开发 Agent · task · 群发');
    expect(agentPrompt).toContain('同时发给了:第三位');
    expect(agentPrompt).toContain('回复:td collab reply message-1');
  });

  it('falls back to raw ids for unknown co-recipients and stays shell-safe', () => {
    const prompt = render([message({ fanOutIds: ['ghost-id', '第一\x1b[31m'] })]);
    const lines = prompt.split('\n');
    expect(lines).toContain('来自:用户 · task · 群发');
    expect(lines).toContain('同时发给了:ghost-id、第一 [31m');
    for (const line of lines) expect(line).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it('never tags a one-to-one delivery with the broadcast marker', () => {
    const prompt = render([message({ fromSessionId: 'coder-id' })]);
    expect(prompt).not.toContain('群发');
    expect(prompt).not.toContain('同时发给了');
    expect(prompt).toContain('来自:开发 Agent · task');
  });
});
