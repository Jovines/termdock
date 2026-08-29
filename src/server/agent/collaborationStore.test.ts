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

  it('deleting a collaboration group also deletes its message history', () => {
    const store = new CollaborationStore(filePath);
    const group = store.save({ name: 'Pair', sessionIds: ['a', 'b'] });
    store.send({ groupId: group.id, fromSessionId: 'a', toSessionIds: ['b'], kind: 'message', content: 'hello' });
    expect(store.remove(group.id)).toBe(true);
    expect(store.listMessages(group.id)).toEqual([]);
  });
});
