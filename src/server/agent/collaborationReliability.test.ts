import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollaborationStore } from './collaborationStore.js';
import { COLLAB_LIMITS } from './collaborationProtocol.js';

describe('durable collaboration reliability', () => {
  let directory: string;
  let file: string;
  let store: CollaborationStore;
  let groupId: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-collab-reliability-'));
    file = path.join(directory, 'messages.json'); store = new CollaborationStore(file);
    groupId = store.save({ name: 'Pair', sessionIds: ['a', 'b'] }).id;
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });
  const input = () => ({ groupId, fromSessionId: 'a', toSessionIds: ['b'], kind: 'message' as const, content: 'hello' });

  it('deduplicates across restart and rejects key reuse with changed payload', () => {
    const [original] = store.send({ ...input(), idempotencyKey: 'restart', metadata: { b: 2, a: 1 } });
    store = new CollaborationStore(file);
    const [retry] = store.send({ ...input(), idempotencyKey: 'restart', metadata: { a: 1, b: 2 } });
    expect(retry.id).toBe(original.id);
    expect(store.inbox('b')).toHaveLength(1);
    expect(() => store.send({ ...input(), content: 'restart twice', idempotencyKey: 'restart' })).toThrow(/different payload/);
  });

  it('does not acknowledge a write that failed on disk, including an idempotent retry', () => {
    const failure = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    expect(() => store.send({ ...input(), idempotencyKey: 'disk' })).toThrow('disk unavailable');
    expect(store.inbox('b')).toEqual([]);
    failure.mockRestore();
    const [message] = store.send({ ...input(), idempotencyKey: 'disk' });
    expect(new CollaborationStore(file).getMessage(message.id)).toBeTruthy();
  });

  it('paginates by local arrival sequence despite clock skew and never marks reads implicitly', () => {
    vi.spyOn(Date, 'now').mockReturnValue(3000);
    const [one] = store.send(input());
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const [two] = store.send({ ...input(), content: 'clock moved back' });
    const first = store.page('b', { consumer: 'main', limit: 1 });
    expect(first.messages.map((message) => message.id)).toEqual([one.id]);
    expect(first.has_more).toBe(true);
    expect(store.page('b', { consumer: 'main', limit: 1 }).messages[0].id).toBe(one.id);
    store.commitCursor('b', first.next_cursor, 'main');
    store = new CollaborationStore(file);
    const next = store.page('b', { consumer: 'main', limit: 1 });
    expect(next.messages[0].id).toBe(two.id);
    expect(store.getMessage(one.id)?.status).toBe('pending');
    expect(() => store.page('a', { cursor: first.next_cursor })).toThrow(/different filters/);
    expect(() => store.commitCursor('a', first.next_cursor, 'main')).toThrow();
    expect(() => store.page('b', { afterId: 'missing' })).toThrow(/resync/);
  });

  it('keeps pending messages beyond the historical cap and preserves their sequence at restart', () => {
    const [original] = store.send(input());
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.messages = Array.from({ length: 2100 }, (_, index) => ({ ...original, id: `pending-${index}`, sequence: index + 1 }));
    data.sequence = 2100;
    fs.writeFileSync(file, JSON.stringify(data));
    store = new CollaborationStore(file);
    store.send(input());
    store = new CollaborationStore(file);
    expect(store.getMessage('pending-0')?.status).toBe('pending');
    const page = store.page('b', { afterId: 'pending-2099' });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0].sequence).toBe(2101);
  });

  it('rejects oversize UTF-8 without truncation and supports full one-MiB evidence', () => {
    expect(() => store.send({ ...input(), content: '界'.repeat(350_000) })).toThrow(/UTF-8/);
    expect(store.inbox('b')).toHaveLength(0);
    const content = 'x'.repeat(COLLAB_LIMITS.message_bytes);
    expect(store.send({ ...input(), content })[0].content).toBe(content);
  });

  it('expires only unsubmitted messages and keeps transport read separate from application ack', () => {
    const [expired] = store.send({ ...input(), expiresAt: Date.now() - 1 });
    expect(store.getMessage(expired.id)?.status).toBe('expired');
    store.markDelivered([expired.id]);
    expect(store.getMessage(expired.id)?.status).toBe('expired');
    const [task] = store.send(input());
    store.markRead([task.id]);
    expect(store.receipt(task.id).ack_at).toBeNull();
    store.send({ groupId, fromSessionId: 'b', toSessionIds: ['a'], kind: 'reply', content: 'Received', replyTo: task.id, threadId: task.threadId,
      task: { task_id: 'task-1', status: 'ack' } });
    expect(store.receipt(task.id).ack_at).not.toBeNull();
    expect(store.receipt(task.id).result_ids).toEqual([]);
    expect(store.sessionFacts('b', true, 'done')).toMatchObject({ turn_state: 'ended', task_state: 'unknown', last_tool_activity_at: null });
    expect(store.page('a', { responseKind: 'result' }).messages).toHaveLength(0);
  });

  it('validates task envelopes and rejects contradictory result claims', () => {
    expect(() => store.send({ ...input(), responseKind: 'result', task: { task_id: 't', status: 'ack' } })).toThrow(/conflicts/);
    expect(() => store.send({ ...input(), task: { task_id: 't', status: 'working', progress: 200 } })).toThrow(/0–100/);
    expect(() => store.send({ ...input(), metadata: { blob: 'x'.repeat(20_000) } })).toThrow(/exceed/);
  });

  it('durably reassembles out-of-order fragments with duplicate protection and no partial delivery', () => {
    store.mergeFederatedGroup({ id: 'cross-pair', name: 'Pair', sessionIds: ['a', 'b'], federated: true, remoteSessions: [], createdAt: 1, updatedAt: 1 });
    const raw = { id: 'large-message', groupId: 'cross-pair', fromSessionId: 'a', toSessionId: 'b', kind: 'message', content: '证据'.repeat(20_000), threadId: 'thread', replyTo: null, status: 'pending', createdAt: 1, deliveredAt: null, readAt: null };
    const bytes = Buffer.from(JSON.stringify(raw));
    const total = Math.ceil(bytes.length / COLLAB_LIMITS.fragment_bytes);
    const fragments = Array.from({ length: total }, (_, index) => ({ message_id: raw.id, group_id: raw.groupId, index, total,
      sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes.subarray(index * COLLAB_LIMITS.fragment_bytes, (index + 1) * COLLAB_LIMITS.fragment_bytes).toString('base64') }));
    expect(store.acceptFragment(fragments.at(-1)!)).toMatchObject({ complete: false });
    expect(store.getMessage(raw.id)).toBeNull();
    store = new CollaborationStore(file);
    store.acceptFragment(fragments.at(-1)!);
    for (const fragment of fragments.slice(0, -1)) store.acceptFragment(fragment);
    expect(store.getMessage(raw.id)?.content).toBe(raw.content);
    store.acceptFragment(fragments[0]);
    expect(store.inbox('b')).toHaveLength(1);
  });
});
