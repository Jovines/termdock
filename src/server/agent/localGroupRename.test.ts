// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollaborationStore } from './collaborationStore.js';
let dir: string, file: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-group-rename-')); file = path.join(dir, 'groups.json'); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });
const metadata = (group: { id: string; name: string; updatedAt: number }) => ({ id: group.id, name: group.name, updatedAt: group.updatedAt });
it('changes only display metadata, preserves original create receipt and separates historical/current rename results after restart', () => {
  const store = new CollaborationStore(file), created = store.createEmptyLocalGroup('Long original', 'create-key');
  store.save({ id: created.id, name: created.name, sessionIds: ['fast', 'slow'] });
  store.setRole({ groupId: created.id, sessionId: 'fast', role: 'Fast' });
  store.send({ groupId: created.id, fromSessionId: 'fast', toSessionIds: ['slow'], kind: 'message', content: 'Retained', threadId: null });
  const before = JSON.parse(fs.readFileSync(file, 'utf8')), original = structuredClone(store.getGroup(created.id)!);
  const first = store.renameLocalGroup(created.id, ' Short ', original.updatedAt, 'rename-key');
  expect(first).toEqual({ group: first.applied, applied: { id: created.id, name: 'Short', updatedAt: expect.any(Number) }, replayed: false });
  expect(first.applied.updatedAt).toBeGreaterThan(original.updatedAt);
  expect(store.getGroup(created.id)).toEqual({ ...original, name: 'Short', updatedAt: first.applied.updatedAt });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect({ ...after, groups: before.groups, localGroupRenames: undefined }).toEqual({ ...before, localGroupRenames: undefined });
  expect(fs.readFileSync(file, 'utf8')).not.toContain('rename-key');
  const second = store.renameLocalGroup(created.id, 'Later', first.group.updatedAt, 'later-key');
  const restarted = new CollaborationStore(file);
  expect(restarted.renameLocalGroup(created.id, 'Short', original.updatedAt, 'rename-key')).toEqual({ group: second.group, applied: first.applied, replayed: true });
  expect(restarted.createEmptyLocalGroup('Long original', 'create-key')).toEqual(created);
  first.applied.name = 'mutated'; expect(restarted.renameLocalGroup(created.id, 'Short', original.updatedAt, 'rename-key').applied.name).toBe('Short');
});
it('rejects stale versions and conflicting key/group/name/version combinations without overwriting another operation', () => {
  const store = new CollaborationStore(file), group = store.save({ name: 'Original', sessionIds: [] });
  const first = store.renameLocalGroup(group.id, 'One', group.updatedAt, 'key');
  expect(() => store.renameLocalGroup(group.id, 'Two', group.updatedAt, 'other')).toThrow(expect.objectContaining({ code: 'GROUP_CHANGED', details: { currentUpdatedAt: first.group.updatedAt } }));
  for (const [id, name, revision] of [[group.id, 'Two', group.updatedAt], [group.id, 'One', first.group.updatedAt], ['other-id', 'One', group.updatedAt]] as const) {
    expect(() => store.renameLocalGroup(id, name, revision, 'key')).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
  }
  expect(store.getLocalGroupMetadata(group.id)).toEqual(first.group);
});
it('records normalized same-name no-ops without advancing revision and rejects name/prefix lookup', () => {
  const store = new CollaborationStore(file), group = store.save({ name: 'Original', sessionIds: [] });
  const receipt = store.renameLocalGroup(group.id, ' Original ', group.updatedAt, 'key');
  expect(receipt).toEqual({ group: metadata(group), applied: metadata(group), replayed: false });
  expect(new CollaborationStore(file).renameLocalGroup(group.id, 'Original', group.updatedAt, 'key').replayed).toBe(true);
  for (const id of [group.name, group.id.slice(0, -1)]) expect(() => store.getLocalGroupMetadata(id)).toThrow(expect.objectContaining({ code: 'GROUP_NOT_FOUND' }));
});
it.each(['', 'bad\nname', '「bad」', 'a'.repeat(257)])('rejects invalid name %j before any write', name => {
  const store = new CollaborationStore(file), group = store.save({ name: 'Original', sessionIds: [] }), before = fs.readFileSync(file, 'utf8');
  expect(() => store.renameLocalGroup(group.id, name, group.updatedAt, 'key')).toThrow(expect.objectContaining({ code: 'INVALID_GROUP' }));
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
});
it.each([null, -1, 1.2, '1', Number.MAX_SAFE_INTEGER + 1])('rejects invalid revision %j', version => {
  const store = new CollaborationStore(file), group = store.save({ name: 'Original', sessionIds: [] });
  expect(() => store.renameLocalGroup(group.id, 'Short', version, 'key')).toThrow(expect.objectContaining({ code: 'INVALID_GROUP_VERSION' }));
});
it('does not commit a half rename or notify subscribers when atomic replacement fails', () => {
  const store = new CollaborationStore(file), group = store.save({ name: 'Original', sessionIds: [] }), listener = vi.fn(); store.subscribe(listener);
  const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('rename failed'); });
  expect(() => store.renameLocalGroup(group.id, 'Short', group.updatedAt, 'key')).toThrow('rename failed'); spy.mockRestore();
  expect(store.getLocalGroupMetadata(group.id)).toEqual(metadata(group)); expect(listener).not.toHaveBeenCalled();
  expect(new CollaborationStore(file).getLocalGroupMetadata(group.id)).toEqual(metadata(group));
  expect(store.renameLocalGroup(group.id, 'Short', group.updatedAt, 'key').replayed).toBe(false); expect(listener).toHaveBeenCalledTimes(1);
});
it('reconfirms durability after uncertain directory fsync and never repeats a rename or accepts persistent fsync failure', () => {
  const store = new CollaborationStore(file), group = store.save({ name: 'Original', sessionIds: [] }), listener = vi.fn(); store.subscribe(listener);
  const original = fs.fsyncSync, spy = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    if (fs.fstatSync(fd).isDirectory()) throw new Error('directory fsync failed'); original(fd);
  });
  expect(() => store.renameLocalGroup(group.id, 'Short', group.updatedAt, 'key')).toThrow('directory fsync failed');
  const applied = store.getLocalGroupMetadata(group.id); expect(applied.name).toBe('Short');
  expect(() => store.renameLocalGroup(group.id, 'Short', group.updatedAt, 'key')).toThrow('directory fsync failed');
  expect(listener).not.toHaveBeenCalled(); expect(store.getLocalGroupMetadata(group.id)).toEqual(applied); spy.mockRestore();
  const sync = vi.spyOn(fs, 'fsyncSync');
  expect(new CollaborationStore(file).renameLocalGroup(group.id, 'Short', group.updatedAt, 'key')).toEqual({ group: applied, applied, replayed: true });
  expect(sync).toHaveBeenCalledTimes(2);
});
it.each(['remove', 'clear', 'federated'] as const)('preserves keys but refuses unavailable targets after %s/restart', operation => {
  const store = new CollaborationStore(file), group = store.save({ name: 'Original', sessionIds: [] });
  store.renameLocalGroup(group.id, 'Short', group.updatedAt, 'key');
  if (operation === 'remove') store.remove(group.id);
  else if (operation === 'clear') store.clear();
  else { const doc = JSON.parse(fs.readFileSync(file, 'utf8')); doc.groups[0].federated = true; fs.writeFileSync(file, JSON.stringify(doc)); }
  const restarted = new CollaborationStore(file);
  expect(() => restarted.renameLocalGroup(group.id, 'Short', group.updatedAt, 'key')).toThrow(expect.objectContaining({ code: 'GROUP_RENAME_TARGET_UNAVAILABLE' }));
  expect(() => restarted.getLocalGroupMetadata(group.id)).toThrow(expect.objectContaining({ code: operation === 'federated' ? 'GROUP_NOT_LOCAL' : 'GROUP_NOT_FOUND' }));
  expect(restarted.list()).toHaveLength(operation === 'federated' ? 1 : 0);
});
it('keeps corrupt/incomplete rename journals blocked across ordinary writes and global clear', () => {
  const store = new CollaborationStore(file), group = store.save({ name: 'Original', sessionIds: [] });
  store.renameLocalGroup(group.id, 'Short', group.updatedAt, 'key');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')); doc.localGroupRenames = { broken: null }; fs.writeFileSync(file, JSON.stringify(doc));
  const broken = new CollaborationStore(file), revision = broken.getLocalGroupMetadata(group.id).updatedAt;
  expect(() => broken.renameLocalGroup(group.id, 'Next', revision, 'next')).toThrow(expect.objectContaining({ code: 'GROUP_RENAME_STATE_UNCONFIRMED' }));
  broken.save({ id: group.id, name: 'Other', sessionIds: [] }); broken.clear();
  const restarted = new CollaborationStore(file), fresh = restarted.save({ name: 'Fresh', sessionIds: [] });
  expect(() => restarted.renameLocalGroup(fresh.id, 'Next', fresh.updatedAt, 'next')).toThrow(expect.objectContaining({ code: 'GROUP_RENAME_STATE_UNCONFIRMED' }));
});
it('accepts legacy stores without a journal, rejects unreadable storage and bounds retained receipts without forgetting replay keys', () => {
  fs.writeFileSync(file, JSON.stringify({ version: 2, groups: [], messages: [] }));
  const store = new CollaborationStore(file), group = store.save({ name: 'Original', sessionIds: [] });
  const receipt = store.renameLocalGroup(group.id, 'Short', group.updatedAt, 'key');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')), record = Object.values(doc.localGroupRenames)[0];
  for (let i = 0; i < 2000; i++) doc.localGroupRenames[i.toString(16).padStart(64, '0')] = record;
  fs.writeFileSync(file, JSON.stringify(doc)); const full = new CollaborationStore(file);
  expect(() => full.renameLocalGroup(group.id, 'Next', receipt.group.updatedAt, 'next')).toThrow(expect.objectContaining({ code: 'GROUP_RENAME_LIMIT' }));
  expect(full.renameLocalGroup(group.id, 'Short', group.updatedAt, 'key').applied).toEqual(receipt.applied);
  fs.writeFileSync(file, '{broken'); expect(() => new CollaborationStore(file).renameLocalGroup(group.id, 'Short', group.updatedAt, 'key')).toThrow(expect.objectContaining({ code: 'GROUP_RENAME_STATE_UNCONFIRMED' }));
});
it('does not replay a structurally valid receipt whose metadata disagrees with its hashed request', () => {
  const store = new CollaborationStore(file), group = store.save({ name: 'Original', sessionIds: [] });
  store.renameLocalGroup(group.id, 'Short', group.updatedAt, 'key');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  (Object.values(doc.localGroupRenames)[0] as { applied: { id: string } }).applied.id = 'different-group';
  fs.writeFileSync(file, JSON.stringify(doc));
  expect(() => new CollaborationStore(file).renameLocalGroup(group.id, 'Short', group.updatedAt, 'key')).toThrow(expect.objectContaining({ code: 'GROUP_RENAME_STATE_UNCONFIRMED' }));
});
