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
});
