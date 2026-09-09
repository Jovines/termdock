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
  it('surfaces a single queued-behind-busy hint in text mode while waiting for delivery', async () => {
    const fixture_ = fixture([
      { message_id: 'm', thread_id: 't', status: 'pending', last_error: 'AGENT_WORKING' },
      { message_id: 'm', thread_id: 't', status: 'pending', last_error: 'AGENT_WORKING' },
      { message_id: 'm', thread_id: 't', status: 'delivered' },
    ]);
    const exit = await executeCollaborationCommand(parseCollaborationCommand(['send', 'peer', 'body', '--wait-until', 'delivered', '--text']), { backendSessionId: 'b' }, fixture_.io);
    expect(exit).toBe(0);
    expect(fixture_.output).toEqual([
      '排队中：对端 Agent 正忙（AGENT_WORKING），消息将在其当前回合结束后写入。',
      'delivered m thread=t',
    ]);
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
});
