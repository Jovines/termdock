import { describe, expect, it } from 'vitest';
import { executeCollaborationCommand, parseCollaborationCommand, waitSatisfied, type CollaborationCliIO } from './collaborationCli.js';

function fixture(responses: Record<string, unknown>[]) {
  const output: string[] = []; const calls: unknown[][] = []; let time = 0;
  const io: CollaborationCliIO = { now: () => time, sleep: async (ms) => { time += ms; }, write: (line) => output.push(line),
    request: async (...args) => { calls.push(args); return { statusCode: 200, body: JSON.stringify(responses.shift() ?? { message_id: 'm', thread_id: 't', status: 'pending' }) }; } };
  return { output, calls, io };
}
describe('collaboration CLI contract', () => {
  it('parses flags separately from message body and supports literal option-like text', () => {
    const command = parseCollaborationCommand(['send', 'peer', '--idempotency-key', 'case', '--wait-until', 'delivered', '--', '--json is literal text']);
    expect(command).toMatchObject({ target: 'peer', message: '--json is literal text', json: true, options: { 'idempotency-key': 'case', 'wait-until': 'delivered' } });
    expect(() => parseCollaborationCommand(['send', 'peer', 'body', '--unknown'])).toThrow(/Unknown/);
    expect(() => parseCollaborationCommand(['send', 'peer', 'body', '--file', 'body.txt'])).toThrow(/Choose/);
  });
  it('supports explicit rebind without allowing pane options on send', async () => {
    const fixture_ = fixture([{ ok: true, route: { state: 'recovering' } }]);
    const command = parseCollaborationCommand(['rebind', '--pane', '%3']);
    expect(await executeCollaborationCommand(command, { backendSessionId: 'b' }, fixture_.io)).toBe(0);
    expect(fixture_.calls[0]).toEqual(expect.arrayContaining(['POST', expect.stringContaining('/route/rebind'), expect.objectContaining({ pane: '%3', backendSessionId: 'b' })]));
    expect(() => parseCollaborationCommand(['rebind', '--pane', '3'])).toThrow(/pane/);
    expect(() => parseCollaborationCommand(['send', 'peer', 'body', '--pane', '%3'])).toThrow(/not supported/);
  });
  it('waits for delivery and emits an identifier without repeating the full sent body', async () => {
    const fixture_ = fixture([{ message_id: 'm', thread_id: 't', status: 'pending', messages: [{ content: 'large evidence' }] }, { message_id: 'm', thread_id: 't', status: 'delivered' }]);
    const exit = await executeCollaborationCommand(parseCollaborationCommand(['send', 'peer', 'body', '--wait-until', 'delivered']), { backendSessionId: 'b' }, fixture_.io);
    expect(exit).toBe(0); expect(fixture_.output).toHaveLength(1);
    expect(JSON.parse(fixture_.output[0])).toMatchObject({ message_id: 'm', status: 'delivered' });
    expect(fixture_.calls[1][1]).toContain('receipt_only=true');
  });
  it('returns a distinct timeout while preserving the queued ID and never resending', async () => {
    const fixture_ = fixture([]);
    const exit = await executeCollaborationCommand(parseCollaborationCommand(['send', 'peer', 'body', '--wait-until', 'read', '--timeout', '10ms']), { backendSessionId: 'b' }, fixture_.io);
    expect(exit).toBe(2);
    expect(JSON.parse(fixture_.output.at(-1)!)).toMatchObject({ message_id: 'm', status: 'pending', code: 'WAIT_TIMEOUT', delivery_continues: true });
    expect(fixture_.calls.filter((args) => args[0] === 'POST')).toHaveLength(1);
  });
  it('says delivery completed when only the expected result is late', async () => {
    const fixture_ = fixture([
      { message_id: 'm', thread_id: 't', status: 'pending' },
      { message_id: 'm', thread_id: 't', status: 'delivered' },
    ]);
    const exit = await executeCollaborationCommand(parseCollaborationCommand(['send', 'peer', 'body', '--wait-until', 'delivered', '--expect-reply', 'result', '--timeout', '600ms', '--text']), { backendSessionId: 'b' }, fixture_.io);
    expect(exit).toBe(2);
    expect(fixture_.output.at(-1)).toContain('投递已完成；等待结果超时（expect-reply=result）');
  });
  it('cannot satisfy result wait with read or an ACK', () => {
    expect(waitSatisfied({ status: 'read', ack_at: 1, reply_ids: ['ack'], result_ids: [] }, 'read', 'result')).toBe(false);
    expect(waitSatisfied({ status: 'read', ack_at: null, reply_ids: ['result'], result_ids: ['result'] }, 'read', 'ack')).toBe(false);
    expect(waitSatisfied({ status: 'pending', ack_at: 1 }, 'queued', 'ack')).toBe(true);
  });
  it('distinguishes expiry from waiting and emits JSON errors', async () => {
    const fixture_ = fixture([{ message_id: 'm', status: 'expired', failure_reason: 'MESSAGE_EXPIRED' }]);
    expect(await executeCollaborationCommand(parseCollaborationCommand(['send', 'peer', 'body']), {}, fixture_.io)).toBe(3);
    const bad = fixture([]); bad.io.request = async () => ({ statusCode: 409, body: JSON.stringify({ code: 'IDEMPOTENCY_CONFLICT', error: 'Changed payload' }) });
    expect(await executeCollaborationCommand(parseCollaborationCommand(['send', 'peer', 'body']), {}, bad.io)).toBe(1);
    expect(JSON.parse(bad.output[0])).toMatchObject({ ok: false, code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('follows inbox cursor without repeating pages or implicitly committing consumption', async () => {
    const fixture_ = fixture([{ messages: [{ id: 'one' }], next_cursor: 'first', has_more: true }, { messages: [{ id: 'two' }], next_cursor: 'second', has_more: false }]);
    const exit = await executeCollaborationCommand(parseCollaborationCommand(['inbox', '--consumer', 'main', '--follow', '--jsonl', '--timeout', '10ms']), {}, fixture_.io);
    expect(exit).toBe(0);
    expect(fixture_.output.map((line) => JSON.parse(line)).filter((item) => item.type === 'message').map((item) => item.id)).toEqual(['one', 'two']);
    expect(fixture_.calls[1][1]).toContain('cursor=first');
    expect(fixture_.calls.every((args) => args[0] === 'GET')).toBe(true);
  });
  it('parses role set/unset/list with strict arity and trailing words as the role', () => {
    expect(parseCollaborationCommand(['role', 'set', 'g1', 'p2', '负责', '排版', '与', '发布']))
      .toMatchObject({ action: 'role', operation: 'set', groupId: 'g1', sessionId: 'p2', role: '负责 排版 与 发布' });
    expect(parseCollaborationCommand(['role', 'unset', 'g1', 'p2'])).toMatchObject({ action: 'role', operation: 'unset', groupId: 'g1', sessionId: 'p2' });
    expect(parseCollaborationCommand(['role', 'list', 'g1'])).toMatchObject({ action: 'role', operation: 'list', groupId: 'g1' });
    for (const argv of [
      ['role', 'list'], ['role', 'list', 'g1', 'extra'], ['role', 'set', 'g1', 'p2', '  '],
      ['role', 'set', 'g1'], ['role', 'unset', 'g1', 'p2', 'extra'], ['role', 'unset', 'g1'], ['role', 'bogus', 'g1'],
    ]) expect(() => parseCollaborationCommand(argv)).toThrow(/role/);
  });
  it('executes role set with sanitized text and clears via role null on unset', async () => {
    const setter = fixture([{ ok: true, group: { id: 'g1', sessionIds: ['p1', 'p2'], roles: { p2: '排版' } } }]);
    expect(await executeCollaborationCommand(parseCollaborationCommand(['role', 'set', 'g1', 'p2', '负责', '排版', '--text']), { backendSessionId: 'p1' }, setter.io)).toBe(0);
    expect(setter.calls[0]).toEqual(expect.arrayContaining(['POST', expect.stringContaining('/role'), expect.objectContaining({ group_id: 'g1', session_id: 'p2', role: '负责 排版', backendSessionId: 'p1' })]));
    expect(setter.output).toEqual(['定位已设置：p2 = 排版']);
    const unseter = fixture([{ ok: true, group: { id: 'g1', sessionIds: ['p1', 'p2'], roles: {} } }]);
    expect(await executeCollaborationCommand(parseCollaborationCommand(['role', 'unset', 'g1', 'p2']), {}, unseter.io)).toBe(0);
    expect(unseter.calls[0][2]).toMatchObject({ group_id: 'g1', session_id: 'p2', role: null });
  });
  it('lists the full member role table with unset members marked in text mode', async () => {
    const lister = fixture([{ ok: true, group: { id: 'g1', sessionIds: ['p1', 'p2'], roles: { p2: '排版' } } }]);
    expect(await executeCollaborationCommand(parseCollaborationCommand(['role', 'list', 'g1', '--text']), {}, lister.io)).toBe(0);
    expect(lister.calls[0][0]).toBe('GET');
    expect(lister.calls[0][1]).toContain('/role?group=g1');
    expect(lister.output).toEqual(['定位表（2 个成员）：', '- p1（未设置）', '- p2：排版']);
  });

  it('prefers member names over bare ids when the group view carries them', async () => {
    const lister = fixture([{ ok: true, group: { id: 'g1', name: '发布组', sessionIds: ['p1', 'p2'], roles: { p2: '排版' },
      members: [{ sessionId: 'p1', name: '开发' }, { sessionId: 'p2', name: null }] } }]);
    expect(await executeCollaborationCommand(parseCollaborationCommand(['role', 'list', 'g1', '--text']), {}, lister.io)).toBe(0);
    expect(lister.output).toEqual(['定位表（组「发布组」· 2 个成员）：', '- 开发 (p1)（未设置）', '- p2：排版']);
  });

  it('appends the caller group roster with member roles to help when a snapshot is available', async () => {
    const helper = fixture([{ ok: true, groups: [{ id: 'g1', name: '发布组', sessionIds: ['p1', 'p2'], roles: { p1: '组长', p2: '排版' },
      members: [{ sessionId: 'p1', name: '开发' }, { sessionId: 'p2', name: null }] }] }]);
    expect(await executeCollaborationCommand(parseCollaborationCommand(['--help']), { backendSessionId: 'p1' }, helper.io)).toBe(0);
    expect(helper.calls[0][0]).toBe('GET');
    expect(helper.calls[0][1]).toContain('/role');
    expect(helper.output.at(-4)).toBe('\n本会话所在协作组的成员定位：');
    expect(helper.output.at(-3)).toBe('组「发布组」(2 个成员)');
    expect(helper.output.at(-2)).toBe('- 开发 (p1)：组长');
    expect(helper.output.at(-1)).toBe('- p2：排版');
  });

  it('parses rename with trailing words joining as the new name and rejects empties', () => {
    expect(parseCollaborationCommand(['rename', 'p1', '发布', '组', '管家']))
      .toMatchObject({ action: 'rename', sessionId: 'p1', name: '发布 组 管家' });
    for (const argv of [['rename'], ['rename', 'p1'], ['rename', 'p1', '  '], ['rename', 'p1', 'x', '--group', 'g1']]) {
      expect(() => parseCollaborationCommand(argv)).toThrow();
    }
  });
  it('renames a member through the orchestration route and echoes the cleaned name', async () => {
    const renaming = fixture([{ ok: true, sessionId: 'p1', name: '发布组' }]);
    expect(await executeCollaborationCommand(parseCollaborationCommand(['rename', 'p1', '发布组', '--text']), { backendSessionId: 'b' }, renaming.io)).toBe(0);
    expect(renaming.calls[0]).toEqual(expect.arrayContaining(['POST', expect.stringContaining('/name'), expect.objectContaining({ session_id: 'p1', name: '发布组', backendSessionId: 'b' })]));
    expect(renaming.output).toEqual(['已改名：p1 = 发布组']);
  });

  it('keeps bare help available when the snapshot request fails', async () => {
    const standalone = fixture([]);
    standalone.io.request = async () => { throw new Error('no server'); };
    const lines: string[] = []; const io: CollaborationCliIO = { ...standalone.io, write: (line) => lines.push(line) };
    expect(await executeCollaborationCommand(parseCollaborationCommand(['--help']), {}, io)).toBe(0);
    expect(lines[0]).toContain('td collab — durable messages');
    expect(lines.some((line) => line.includes('成员定位'))).toBe(false);
  });

  it('parses cleanup with multiple ids, gates --confirm, and rejects it elsewhere', () => {
    expect(parseCollaborationCommand(['cleanup', 'a1', 'b2', 'c3']))
      .toMatchObject({ action: 'cleanup', sessionIds: ['a1', 'b2', 'c3'], json: true });
    expect(parseCollaborationCommand(['cleanup', 'a1', '--confirm']).options.confirm).toBe(true);
    expect(parseCollaborationCommand(['cleanup', 'a1', '--text']).json).toBe(false);
    for (const argv of [['cleanup'], ['send', 'peer', 'body', '--confirm'], ['cleanup', 'a1', '--pane', '%3']]) {
      expect(() => parseCollaborationCommand(argv)).toThrow();
    }
  });

  it('prints the cleanup plan and refuses until a human confirmation is supplied', async () => {
    const plan = { targets: [{ sessionId: 'a1', name: '验证会话', mode: 'tmux', tmuxSessionName: 'wt-x' }], groups: [{ id: 'g1', name: '发布组', sizeBefore: 9, sizeAfter: 8, dissolves: false }] };
    const refusal = fixture([{ ok: false, code: 'CLEANUP_CONFIRM_REQUIRED', error: '不可恢复的风险操作', instruction: '…', plan }]);
    const exit = await executeCollaborationCommand(parseCollaborationCommand(['cleanup', 'a1', '--text']), { backendSessionId: 'b' }, refusal.io);
    expect(exit).toBe(1);
    expect(refusal.calls[0]).toEqual(expect.arrayContaining(['POST', expect.stringContaining('/cleanup'), expect.objectContaining({ sessionIds: ['a1'], confirmed: false })]));
    expect(refusal.output.join('\n')).toContain('需要人类授权');
    expect(refusal.output.join('\n')).toContain('验证会话（a1） · tmux wt-x');
    expect(refusal.output.join('\n')).toContain('向用户（人类）说明');
    const jsonMode = fixture([{ ok: false, code: 'CLEANUP_CONFIRM_REQUIRED', error: '…', plan }]);
    expect(await executeCollaborationCommand(parseCollaborationCommand(['cleanup', 'a1']), {}, jsonMode.io)).toBe(1);
    expect(JSON.parse(jsonMode.output[0])).toMatchObject({ ok: false, code: 'CLEANUP_CONFIRM_REQUIRED', plan: { targets: [{ sessionId: 'a1' }] } });
  });

  it('executes a confirmed cleanup and reports each removed session', async () => {
    const plan = { targets: [{ sessionId: 'a1', name: '验证会话', mode: 'tmux', tmuxSessionName: 'wt-x' }], groups: [{ id: 'g1', name: '发布组', sizeBefore: 9, sizeAfter: 8, dissolves: false }] };
    const executed = fixture([{ ok: true, removed: [{ sessionId: 'a1', name: '验证会话', tmuxSessionName: 'wt-x' }], plan }]);
    expect(await executeCollaborationCommand(parseCollaborationCommand(['cleanup', 'a1', '--confirm']), { backendSessionId: 'b' }, executed.io)).toBe(0);
    expect(executed.calls[0]).toEqual(expect.arrayContaining(['POST', expect.stringContaining('/cleanup'), expect.objectContaining({ sessionIds: ['a1'], confirmed: true })]));
    expect(JSON.parse(executed.output[0])).toMatchObject({ ok: true, removed: [{ sessionId: 'a1' }] });
    const text = fixture([{ ok: true, removed: [{ sessionId: 'a1', name: '验证会话', tmuxSessionName: 'wt-x' }], plan }]);
    expect(await executeCollaborationCommand(parseCollaborationCommand(['cleanup', 'a1', '--confirm', '--text']), {}, text.io)).toBe(0);
    expect(text.output.join('\n')).toContain('tmux wt-x 已终止');
  });

  it('fans a comma-separated send out to multiple recipients and gates waiting options', async () => {
    const sent = fixture([{ ok: true, message_id: 'm1', thread_id: 't', status: 'pending', messages: [{ id: 'm1' }] }]);
    const exit = await executeCollaborationCommand(parseCollaborationCommand(['send', 'p1,p2', '群发任务']), { backendSessionId: 'b' }, sent.io);
    expect(exit).toBe(0);
    expect(sent.calls[0]).toEqual(expect.arrayContaining(['POST', expect.stringContaining('/send'), expect.objectContaining({ toSessionIds: ['p1', 'p2'], message: '群发任务', backendSessionId: 'b' })]));
    expect(sent.calls[0][2]).not.toHaveProperty('targetSessionId');
    const single = fixture([{ ok: true, message_id: 'm1', thread_id: 't', status: 'pending' }]);
    expect(await executeCollaborationCommand(parseCollaborationCommand(['send', 'p1', '单发']), {}, single.io)).toBe(0);
    expect(single.calls[0][2]).toMatchObject({ targetSessionId: 'p1' });
    expect(single.calls[0][2]).not.toHaveProperty('toSessionIds');
    const gated = fixture([]);
    expect(await executeCollaborationCommand(parseCollaborationCommand(['send', 'p1,p2', 'x', '--wait-until', 'delivered']), {}, gated.io)).toBe(1);
    expect(gated.calls).toHaveLength(0);
    expect(JSON.parse(gated.output[0])).toMatchObject({ ok: false, code: 'COLLABORATION_ERROR' });
  });

  it('renders sibling recipients of a fan-out in inbox text with resolved names', async () => {
    const inbox = fixture([{ ok: true, messages: [
      { id: 'm1', kind: 'task', fromSessionId: 'p1', fanOutIds: ['p2'], content: '群发内容' },
      { id: 'm2', kind: 'task', fromSessionId: 'p1', fanOutIds: ['ghost'], content: '单条' },
      { id: 'm3', kind: 'task', fromSessionId: 'p1', content: '点名' },
    ], names: { p2: '开发 Agent', p1: '组长' }, next_cursor: null, has_more: false }]);
    expect(await executeCollaborationCommand(parseCollaborationCommand(['inbox', '--text']), {}, inbox.io)).toBe(0);
    expect(inbox.output[0]).toBe('[task] m1 from p1 · 群发');
    expect(inbox.output[1]).toBe('同时发给了:开发 Agent');
    expect(inbox.output[2]).toBe('群发内容');
    expect(inbox.output[3]).toBe('[task] m2 from p1 · 群发');
    expect(inbox.output[4]).toBe('同时发给了:ghost');
    expect(inbox.output[6]).toBe('[task] m3 from p1');
  });

  it('parses drive with a session id and an enumerated action, and joins run text', () => {
    expect(parseCollaborationCommand(['drive', 'p2', 'approve'])).toMatchObject({ action: 'drive', sessionId: 'p2', operation: 'approve', json: true });
    expect(parseCollaborationCommand(['drive', 'p2', 'enter'])).toMatchObject({ action: 'drive', sessionId: 'p2', operation: 'enter' });
    expect(parseCollaborationCommand(['drive', 'p2', 'capture'])).toMatchObject({ action: 'drive', sessionId: 'p2', operation: 'capture' });
    expect(parseCollaborationCommand(['drive', 'p2', 'run', '按', '回车', '继续'])).toMatchObject({ action: 'drive', sessionId: 'p2', operation: 'run', message: '按 回车 继续' });
    for (const argv of [['drive'], ['drive', 'p2'], ['drive', 'p2', 'type'], ['drive', 'p2', 'run'], ['drive', 'p2', 'run', '   '],
      ['drive', 'p2', 'approve', 'x'], ['drive', 'p2', 'enter', '--group', 'g1']]) {
      expect(() => parseCollaborationCommand(argv)).toThrow();
    }
  });

  it('drives a member terminal: run submits a line and returns the screen back', async () => {
    const runner = fixture([{ ok: true, action: 'run', sessionId: 'p2', text: 'ls -la', snapshot: 'home  qiao\nbin  etc' }]);
    const exit = await executeCollaborationCommand(parseCollaborationCommand(['drive', 'p2', 'run', 'ls', '-la', '--text']), { backendSessionId: 'p1' }, runner.io);
    expect(exit).toBe(0);
    expect(runner.calls[0]).toEqual(expect.arrayContaining(['POST', expect.stringContaining('/drive'),
      expect.objectContaining({ session: 'p2', action: 'run', text: 'ls -la', backendSessionId: 'p1' })]));
    expect(runner.output.join('\n')).toContain('已向 p2 发送一行并提交：ls -la');
    expect(runner.output.join('\n')).toContain('home  qiao');
    const capture = fixture([{ ok: true, action: 'capture', sessionId: 'p2', snapshot: 'just this screen' }]);
    expect(await executeCollaborationCommand(parseCollaborationCommand(['drive', 'p2', 'capture', '--text']), {}, capture.io)).toBe(0);
    expect(capture.output[0]).toBe('just this screen');
  });

  it('reports drive outcomes: approve echoes success, key sends echo, and a missing dialog is a hard error', async () => {
    const approver = fixture([{ ok: true, action: 'approve', sessionId: 'p2', approved: true }]);
    expect(await executeCollaborationCommand(parseCollaborationCommand(['drive', 'p2', 'approve', '--text']), {}, approver.io)).toBe(0);
    expect(approver.output[0]).toContain('已批准 p2 的审批对话框');
    const keyer = fixture([{ ok: true, action: 'escape', sessionId: 'p2' }]);
    expect(await executeCollaborationCommand(parseCollaborationCommand(['drive', 'p2', 'escape', '--text']), {}, keyer.io)).toBe(0);
    expect(keyer.output[0]).toContain('已向 p2 发送 escape');
    const refusal = fixture([]);
    refusal.io.request = async () => ({ statusCode: 409, body: JSON.stringify({ ok: false, code: 'NO_APPROVAL_DIALOG', error: '目标面板当前没有显示审批对话框；未发送任何按键' }) });
    expect(await executeCollaborationCommand(parseCollaborationCommand(['drive', 'p2', 'approve']), {}, refusal.io)).toBe(1);
    expect(JSON.parse(refusal.output[0])).toMatchObject({ ok: false, code: 'NO_APPROVAL_DIALOG' });
  });
});
