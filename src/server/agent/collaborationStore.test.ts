import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CollaborationStore } from './collaborationStore.js';

describe('CollaborationStore', () => {
  let directory: string;
  let filePath: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-collaboration-'));
    filePath = path.join(directory, 'collaboration.json');
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('fans out durable group messages and preserves them across restarts', () => {
    const store = new CollaborationStore(filePath);
    const group = store.save({ name: 'Release', sessionIds: ['manager', 'coder', 'reviewer'] });
    const messages = store.send({
      groupId: group.id,
      fromSessionId: 'manager',
      toSessionIds: ['coder', 'reviewer'],
      kind: 'task',
      content: 'Build and independently review the release.',
    });

    expect(messages).toHaveLength(2);
    expect(new Set(messages.map((message) => message.threadId)).size).toBe(1);
    const restored = new CollaborationStore(filePath);
    expect(restored.inbox('coder', { pendingOnly: true })[0]).toMatchObject({ kind: 'task', status: 'pending' });
  });

  it('keeps delivery and read acknowledgement separate', () => {
    const store = new CollaborationStore(filePath);
    const group = store.save({ name: 'Pair', sessionIds: ['a', 'b'] });
    const [message] = store.send({ groupId: group.id, fromSessionId: 'a', toSessionIds: ['b'], kind: 'ask', content: 'Ready?' });
    store.markDelivered([message!.id]);
    expect(store.getMessage(message!.id)?.status).toBe('delivered');
    store.markRead([message!.id]);
    expect(store.getMessage(message!.id)).toMatchObject({ status: 'read', deliveredAt: expect.any(Number), readAt: expect.any(Number) });
  });

  it('records an explicit read source for manual consumption', () => {
    const store = new CollaborationStore(filePath);
    const group = store.save({ name: 'Pair', sessionIds: ['a', 'b'] });
    const [injected] = store.send({ groupId: group.id, fromSessionId: 'a', toSessionIds: ['b'], kind: 'message', content: 'auto' });
    const [acknowledged] = store.send({ groupId: group.id, fromSessionId: 'a', toSessionIds: ['b'], kind: 'message', content: 'manual' });
    store.markDelivered([injected!.id, acknowledged!.id]);
    store.markRead([acknowledged!.id]);
    expect(store.getMessage(injected!.id)?.status).toBe('delivered');
    expect(store.getMessage(acknowledged!.id)).toMatchObject({ status: 'read', readSource: 'explicit' });
  });

  it('keeps replies on the original thread', () => {
    const store = new CollaborationStore(filePath);
    const group = store.save({ name: 'Pair', sessionIds: ['a', 'b'] });
    const [ask] = store.send({ groupId: group.id, fromSessionId: 'a', toSessionIds: ['b'], kind: 'ask', content: 'Ready?' });
    const [reply] = store.send({
      groupId: group.id, fromSessionId: 'b', toSessionIds: ['a'], kind: 'reply', content: 'Yes.',
      threadId: ask!.threadId, replyTo: ask!.id,
    });
    expect(reply).toMatchObject({ threadId: ask!.threadId, replyTo: ask!.id });
  });

  it('updates group membership without replacing its identity or message history', () => {
    const store = new CollaborationStore(filePath);
    const group = store.save({ name: 'Team', sessionIds: ['a', 'b'] });
    store.send({ groupId: group.id, fromSessionId: 'a', toSessionIds: ['b'], kind: 'message', content: 'before update' });

    const updated = store.save({ id: group.id, name: group.name, sessionIds: ['a', 'b', 'c'] });

    expect(updated).toMatchObject({ id: group.id, createdAt: group.createdAt, sessionIds: ['a', 'b', 'c'] });
    expect(store.listMessages(group.id)).toHaveLength(1);
  });

  it('removes a deleted Session and dissolves groups that can no longer collaborate', () => {
    const store = new CollaborationStore(filePath);
    const pair = store.save({ name: 'Pair', sessionIds: ['a', 'b'] });
    const trio = store.save({ name: 'Trio', sessionIds: ['a', 'b', 'c'] });
    store.send({ groupId: pair.id, fromSessionId: 'a', toSessionIds: ['b'], kind: 'message', content: 'pair' });
    store.send({ groupId: trio.id, fromSessionId: 'b', toSessionIds: ['a', 'c'], kind: 'message', content: 'trio' });

    expect(store.removeSession('a')).toEqual({ updatedGroups: 1, dissolvedGroups: 1 });
    expect(store.getGroup(pair.id)).toBeNull();
    expect(store.getGroup(trio.id)?.sessionIds).toEqual(['b', 'c']);
    expect(store.listMessages(pair.id)).toEqual([]);
    expect(store.listMessages(trio.id)).toHaveLength(1);
    expect(store.listMessages(trio.id)[0]?.toSessionId).toBe('c');
  });

  it('aggregates task_state only from what the session reported, never from dispatch', () => {
    const store = new CollaborationStore(filePath);
    const group = store.save({ name: 'Pair', sessionIds: ['a', 'b'] });
    store.send({ groupId: group.id, fromSessionId: 'a', toSessionIds: ['b'], kind: 'task', content: 'do it' });
    expect(store.sessionFacts('a', true).task_state).toBe('idle');
    expect(store.sessionFacts('b', true).task_state).toBe('idle');
    const [dispatch] = store.inbox('b');
    store.send({
      groupId: group.id, fromSessionId: 'b', toSessionIds: ['a'], kind: 'reply', content: 'on it', threadId: dispatch!.threadId, replyTo: dispatch!.id,
      task: { task_id: 't1', status: 'working' },
    });
    expect(store.sessionFacts('b', true).task_state).toBe('active');
  });

  it('treats a held-open blocked task as active and failed as its own state', () => {
    const store = new CollaborationStore(filePath);
    const group = store.save({ name: 'Pair', sessionIds: ['a', 'b'] });
    const report = (from: string, task_id: string, status: 'working' | 'blocked' | 'failed' | 'complete') =>
      store.send({ groupId: group.id, fromSessionId: from, toSessionIds: ['b'], kind: 'reply', content: status, task: { task_id, status } })[0];
    report('a', 't1', 'blocked');
    expect(store.sessionFacts('a', true).task_state).toBe('active');
    // A failed task does not override another task still in flight.
    report('a', 't2', 'failed');
    expect(store.sessionFacts('a', true).task_state).toBe('active');
    // Once nothing is in flight, the failed terminal state surfaces.
    report('a', 't1', 'complete');
    expect(store.sessionFacts('a', true).task_state).toBe('failed');
    report('a', 't3', 'complete');
    expect(store.sessionFacts('a', true).task_state).toBe('failed');
    // A session whose every reported task completed is idle again.
    const fresh = store.save({ name: 'Fresh', sessionIds: ['a2', 'b'] });
    store.send({ groupId: fresh.id, fromSessionId: 'a2', toSessionIds: ['b'], kind: 'reply', content: 'done', task: { task_id: 't9', status: 'complete' } });
    expect(store.sessionFacts('a2', true).task_state).toBe('idle');
  });

  it('lists a task timeline from the first reply carrying its id', () => {
    const store = new CollaborationStore(filePath);
    const group = store.save({ name: 'Pair', sessionIds: ['a', 'b'] });
    const [dispatch] = store.send({ groupId: group.id, fromSessionId: 'a', toSessionIds: ['b'], kind: 'task', content: 'do it' });
    expect(store.byTask('b', 't1')).toEqual([]);
    const first = store.send({ groupId: group.id, fromSessionId: 'b', toSessionIds: ['a'], kind: 'reply', content: 'started', threadId: dispatch!.threadId, task: { task_id: 't1', status: 'working' } })[0];
    const second = store.send({ groupId: group.id, fromSessionId: 'b', toSessionIds: ['a'], kind: 'reply', content: 'done', threadId: dispatch!.threadId, task: { task_id: 't1', status: 'complete', progress: 100 } })[0];
    store.send({ groupId: group.id, fromSessionId: 'b', toSessionIds: ['a'], kind: 'reply', content: 'other', threadId: dispatch!.threadId, task: { task_id: 't9', status: 'working' } });
    expect(store.byTask('b', 't1').map((message) => message.id)).toEqual([first!.id, second!.id]);
    expect(store.sessionFacts('b', true).tasks).toHaveLength(2);
  });

  it('sets, sanitizes and clears member roles, persisting them across restarts', () => {
    const store = new CollaborationStore(filePath);
    const group = store.save({ name: 'Pair', sessionIds: ['a', 'b'] });
    const withRole = store.setRole({ groupId: group.id, sessionId: 'b', role: '负责验收\t与发布\n' });
    expect(withRole.roles).toEqual({ b: '负责验收 与发布' });
    expect(() => store.setRole({ groupId: group.id, sessionId: 'outsider', role: 'x' })).toThrow(/不在协作组/);
    expect(store.setRole({ groupId: group.id, sessionId: 'b', role: '' }).roles).toBeUndefined();
    store.setRole({ groupId: group.id, sessionId: 'b', role: '最终验收人' });
    expect(new CollaborationStore(filePath).getGroup(group.id)?.roles).toEqual({ b: '最终验收人' });
    expect(store.setRole({ groupId: group.id, sessionId: 'b', role: 'y'.repeat(250) }).roles?.['b']).toBe(`${'y'.repeat(199)}…`);
  });

  it('drops the role of a member who leaves, while survivors keep theirs', () => {
    const store = new CollaborationStore(filePath);
    const group = store.save({ name: 'Team', sessionIds: ['a', 'b', 'c', 'd'] });
    store.setRole({ groupId: group.id, sessionId: 'a', role: '排版' });
    store.setRole({ groupId: group.id, sessionId: 'b', role: '校对' });
    expect(store.save({ id: group.id, name: 'Team', sessionIds: ['a', 'c', 'd'] }).roles).toEqual({ a: '排版' });
    store.setRole({ groupId: group.id, sessionId: 'c', role: '发布' });
    store.removeSession('a');
    expect(store.getGroup(group.id)?.roles).toEqual({ c: '发布' });
  });

  it('keeps roles keyed to members who move between groups and clears the source entry', () => {
    const store = new CollaborationStore(filePath);
    const first = store.save({ name: 'First', sessionIds: ['a', 'b'] });
    const second = store.save({ name: 'Second', sessionIds: ['a', 'c'] });
    store.setRole({ groupId: first.id, sessionId: 'b', role: '调查' });
    store.setRole({ groupId: second.id, sessionId: 'a', role: '汇报' });
    const moved = store.save({ id: first.id, name: 'First', sessionIds: ['a'] });
    expect(moved.roles).toBeUndefined();
    expect(store.getGroup(second.id)?.roles).toEqual({ a: '汇报' });
  });

  it('carries roles along through federation merge', () => {
    const store = new CollaborationStore(filePath);
    store.mergeFederatedGroup({ id: 'cross-roles', name: 'Pair', sessionIds: ['one', 'two'], roles: { one: '主持人' }, createdAt: 1, updatedAt: 1, federated: true, remoteSessions: [] });
    expect(store.getGroup('cross-roles')?.roles).toEqual({ one: '主持人' });
  });

  it('deleting a collaboration group also deletes its message history', () => {
    const store = new CollaborationStore(filePath);
    const group = store.save({ name: 'Pair', sessionIds: ['a', 'b'] });
    store.send({ groupId: group.id, fromSessionId: 'a', toSessionIds: ['b'], kind: 'message', content: 'hello' });
    expect(store.remove(group.id)).toBe(true);
    expect(store.listMessages(group.id)).toEqual([]);
  });
});

describe('federation persistence', () => {
  it('deduplicates retried deliveries, advances receipts without changing content, and retains deletion across restarts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-federation-'));
    try {
      const file = path.join(directory, 'groups.json');
      const store = new CollaborationStore(file);
      const group = { id: 'cross-pair', name: 'Pair', sessionIds: ['one', 'two'], createdAt: 1, updatedAt: 1, federated: true, remoteSessions: [] };
      store.mergeFederatedGroup(group);
      const [message] = store.send({ groupId: group.id, fromSessionId: 'one', toSessionIds: ['two'], kind: 'ask', content: 'Ready?' });
      store.mergeFederatedMessages([message, message]);
      expect(store.inbox('two')).toHaveLength(1);
      store.mergeFederatedMessages([{ ...message, content: 'rewrite attempt', status: 'read', deliveredAt: 2, readAt: 3 }]);
      store.mergeFederatedMessages([message]);
      expect(store.inbox('two')[0]).toMatchObject({ content: 'Ready?', status: 'read' });
      store.remove(group.id);
      const restored = new CollaborationStore(file);
      restored.mergeFederatedGroup(group);
      expect(restored.list()).toHaveLength(0);
      expect(restored.federationSnapshot().groups[0].deleted).toBe(true);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
