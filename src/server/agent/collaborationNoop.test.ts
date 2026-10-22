// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollaborationStore } from './collaborationStore.js';
import { IntegrationStore } from './integrationStore.js';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-noop-')); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); fs.rmSync(directory, { recursive: true, force: true }); });
const group = () => ({ id: 'cross-noop', name: 'Team', sessionIds: ['one', 'two'], createdAt: 1, updatedAt: 1,
  federated: true, remoteSessions: [], roles: { one: 'Owner' }, roleVersions: { one: { version: 'v1', updatedAt: 1 } } });

it('does not persist or notify on identical directory refreshes, including reordered object keys', () => {
  const store = new CollaborationStore(path.join(directory, 'groups.json'));
  store.mergeFederatedGroup(group());
  const changed = vi.fn(); store.subscribe(changed);
  const write = vi.spyOn(fs, 'renameSync');
  const reversed = Object.fromEntries(Object.entries(group()).reverse()) as ReturnType<typeof group>;
  for (let i = 0; i < 100; i++) store.mergeFederatedGroup(reversed);
  expect(write).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  // Equal timestamps alone must not swallow real metadata changes.
  store.mergeFederatedGroup({ ...group(), name: 'Changed' });
  expect(write).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledTimes(1);
  expect(new CollaborationStore(path.join(directory, 'groups.json')).getGroup(group().id)?.name).toBe('Changed');
});

it('merges independent context once and treats repeated stale context as no change', () => {
  const store = new CollaborationStore(path.join(directory, 'groups.json'));
  store.mergeFederatedGroup(group());
  store.mergeContext(group().id, { roles: { one: 'New owner' }, roleVersions: { one: { version: 'v2', updatedAt: 2 } } });
  const changed = vi.fn(); store.subscribe(changed);
  const write = vi.spyOn(fs, 'renameSync');
  store.mergeFederatedGroup(group());
  expect(write).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  store.mergeFederatedGroup({ ...group(), name: 'New title', updatedAt: 3 });
  expect(write).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledTimes(1);
  expect(new CollaborationStore(path.join(directory, 'groups.json')).getGroup(group().id)).toMatchObject({ name: 'New title', roles: { one: 'New owner' } });
  store.mergeFederatedGroup({ ...group(), deleted: true, updatedAt: 4 });
  store.mergeFederatedGroup({ ...group(), updatedAt: 100 });
  expect(store.getGroup(group().id)?.deleted).toBe(true);
});

const update = (version: string) => ({ sourceKey: 'source', sourceVersion: version,
  event: { group_id: 'group', kind: 'message.delivery', created_at: 1, payload: { version } } });

it('does zero history clones and writes for empty or duplicate appends at a 26 MB journal size', () => {
  const file = path.join(directory, 'events.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, principals: [],
    events: Array.from({ length: 10000 }, (_, index) => ({ event_id: String(index), sequence: index + 1, group_id: 'group', payload: 'x'.repeat(2600) })),
    sequences: { group: 10000 }, prunedThrough: {}, sources: { source: '1' }, consumers: {} }));
  const store = new IntegrationStore(file), changed = vi.fn(); store.subscribe(changed);
  const clone = vi.spyOn(globalThis, 'structuredClone'), write = vi.spyOn(fs, 'renameSync');
  for (let i = 0; i < 100; i++) { store.append([]); store.append([update('1'), update('1')]); }
  expect(clone).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  store.append([update('2'), update('2')]);
  expect(clone).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledTimes(1);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(doc.events.at(-1)).toMatchObject({ sequence: 10001, payload: { version: '2' } });
  expect(doc.events).toHaveLength(10000);
  const restarted = new IntegrationStore(file); clone.mockClear(); write.mockClear();
  restarted.append([update('2')]); expect(clone).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
});

it('does not acknowledge a source update when its durable write fails', () => {
  const file = path.join(directory, 'events.json'), store = new IntegrationStore(file);
  const changed = vi.fn(); store.subscribe(changed);
  vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('disk unavailable'); });
  expect(() => store.append([update('1')])).toThrow('disk unavailable');
  expect(changed).not.toHaveBeenCalled();
  store.append([update('1')]); expect(changed).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).events).toHaveLength(1);
});

it('batch receipts preserve reply identity filtering, delivery facts and detached snapshots', () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const store = new CollaborationStore(path.join(directory, 'groups.json'));
  const local = store.save({ name: 'Team', sessionIds: ['one', 'two', 'other'] });
  const request = store.send({ groupId: local.id, fromSessionId: null, toSessionIds: ['one'], kind: 'message', content: 'Run',
    integrationOrigin: { integrationId: 'bridge', source: 'integration' } })[0]!;
  store.storeIntegrationReply(request.id, 'one', 'Result', { responseKind: 'result', idempotencyKey: 'result' });
  store.markDelivered([request.id]);
  const ordinary = store.send({ groupId: local.id, fromSessionId: 'one', toSessionIds: ['two'], kind: 'ask', content: 'Ready?' })[0]!;
  store.send({ groupId: local.id, fromSessionId: 'other', toSessionIds: ['one'], kind: 'reply', content: 'Wrong participant', replyTo: ordinary.id });
  const snapshots = store.snapshotMessagesWithReceipts(new Set([local.id]));
  for (const { message, receipt } of snapshots) {
    const { snapshot: _, ...expected } = store.receipt(message.id);
    expect(receipt).toEqual(expected); message.content = 'External mutation';
    expect(store.getMessage(message.id)?.content).not.toBe('External mutation');
  }
  expect(snapshots.find(item => item.message.id === ordinary.id)?.receipt.reply_ids).toEqual([]);
  expect(store.snapshotMessagesWithReceipts(new Set(['unrelated']))).toEqual([]);
});
