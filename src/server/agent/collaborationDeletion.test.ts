import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollaborationStore } from './collaborationStore.js';

let directory: string;
let file: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-deletion-')); file = path.join(directory, 'groups.json'); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });
const replica = { id: 'cross-deleted', name: 'Old group', sessionIds: ['a', 'b'], federated: true,
  remoteSessions: [], createdAt: 1, updatedAt: 100 };

it.each([0, 1, 60_000])('never revives a deleted replica with an equal or newer update (%i ms)', offset => {
  const store = new CollaborationStore(file);
  store.mergeFederatedGroup(replica);
  store.remove(replica.id);
  const deletion = store.getGroup(replica.id)!;
  const restarted = new CollaborationStore(file);
  restarted.mergeFederatedGroup({ ...replica, updatedAt: deletion.updatedAt + offset });
  expect(restarted.list()).toEqual([]);
  expect(restarted.getGroup(replica.id)).toEqual(deletion);
});

it('a deletion from a slower clock wins over a newer live replica and removes its messages', () => {
  const store = new CollaborationStore(file);
  store.mergeFederatedGroup(replica);
  store.send({ groupId: replica.id, fromSessionId: 'a', toSessionIds: ['b'], kind: 'message', content: 'old message' });
  store.mergeFederatedGroup({ ...replica, deleted: true, updatedAt: 50 });
  expect(store.list()).toEqual([]);
  expect(store.listMessages(replica.id)).toEqual([]);
  expect(store.getGroup(replica.id)?.updatedAt).toBeGreaterThan(replica.updatedAt);
  store.dropFederatedReplica(replica.id, 999);
  expect(new CollaborationStore(file).getGroup(replica.id)?.deleted).toBe(true);
});

it('persists local deletion, rejects late edits and permits a new empty group with a new ID', () => {
  const store = new CollaborationStore(file);
  const group = store.save({ name: 'Project', sessionIds: [] });
  store.remove(group.id);
  const restarted = new CollaborationStore(file);
  expect(restarted.getGroup(group.id)?.deleted).toBe(true);
  expect(() => restarted.save({ ...group, name: 'Late edit' })).toThrow('协作组已删除');
  const replacement = restarted.save({ name: group.name, sessionIds: [] });
  expect(replacement.id).not.toBe(group.id);
  expect(restarted.list()).toEqual([replacement]);
});

it('clear retains both local and federated deletion records across restarts', () => {
  const store = new CollaborationStore(file);
  const local = store.save({ name: 'Local', sessionIds: [] });
  store.mergeFederatedGroup(replica);
  store.clear();
  const restarted = new CollaborationStore(file);
  expect(restarted.list()).toEqual([]);
  expect(restarted.getGroup(local.id)?.deleted).toBe(true);
  expect(restarted.getGroup(replica.id)?.deleted).toBe(true);
});

it('failed deletion keeps the previous live record and history in memory and on disk', () => {
  const store = new CollaborationStore(file);
  const group = store.save({ name: 'Local', sessionIds: ['a', 'b'] });
  store.send({ groupId: group.id, fromSessionId: 'a', toSessionIds: ['b'], kind: 'message', content: 'preserve' });
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw Error('disk unavailable'); });
  expect(() => store.remove(group.id)).toThrow('disk unavailable');
  expect(store.list()).toEqual([group]);
  expect(store.listMessages(group.id)).toHaveLength(1);
  expect(new CollaborationStore(file).list()).toEqual([group]);
});
