// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollaborationStore } from './collaborationStore.js';
let dir: string, file: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-local-group-')); file = path.join(dir, 'groups.json'); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });
it('atomically creates an empty local group and replays its original snapshot after restart and later membership changes', () => {
  const store = new CollaborationStore(file), first = store.createEmptyLocalGroup(' Case One ', 'create-request');
  expect(first).toMatchObject({ name: 'Case One', sessionIds: [], federated: false });
  const updated = store.save({ id: first.id, name: 'Renamed', sessionIds: ['fast', 'slow', 'judge'] });
  const restarted = new CollaborationStore(file);
  expect(restarted.createEmptyLocalGroup('Case One', 'create-request')).toEqual(first);
  expect(restarted.getGroup(first.id)).toEqual(updated); expect(restarted.list()).toHaveLength(1);
  expect(fs.readFileSync(file, 'utf8')).not.toContain('create-request');
  first.sessionIds.push('mutated'); expect(restarted.createEmptyLocalGroup('Case One', 'create-request').sessionIds).toEqual([]);
});
it('rejects same-key parameter conflicts but permits distinct keys with the same display name', () => {
  const store = new CollaborationStore(file), first = store.createEmptyLocalGroup('Case', 'key');
  expect(() => store.createEmptyLocalGroup('Other', 'key')).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
  expect(store.createEmptyLocalGroup('Case', 'other').id).not.toBe(first.id); expect(store.list()).toHaveLength(2);
});
it.each(['', '  ', 'bad\nname', '「case」', 'a'.repeat(257)])('rejects invalid group name %j before persistence', name => {
  expect(() => new CollaborationStore(file).createEmptyLocalGroup(name, 'key')).toThrow(expect.objectContaining({ code: 'INVALID_GROUP' })); expect(fs.existsSync(file)).toBe(false);
});
it.each(['', '  ', 'a'.repeat(257), 123])('rejects invalid key before persistence', key => {
  expect(() => new CollaborationStore(file).createEmptyLocalGroup('Case', key)).toThrow(expect.objectContaining({ code: 'INVALID_IDEMPOTENCY_KEY' })); expect(fs.existsSync(file)).toBe(false);
});
it('keeps a deleted key reserved, including after a global clear and restart', () => {
  const store = new CollaborationStore(file), first = store.createEmptyLocalGroup('Case', 'key');
  store.remove(first.id); expect(() => store.createEmptyLocalGroup('Case', 'key')).toThrow(expect.objectContaining({ code: 'GROUP_CREATE_TARGET_UNAVAILABLE' }));
  store.clear(); const restarted = new CollaborationStore(file);
  expect(() => restarted.createEmptyLocalGroup('Case', 'key')).toThrow(expect.objectContaining({ code: 'GROUP_CREATE_TARGET_UNAVAILABLE' })); expect(restarted.list()).toEqual([]);
});
it('does not recreate a target converted to federation', () => {
  const store = new CollaborationStore(file); store.createEmptyLocalGroup('Case', 'key');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')); doc.groups[0].federated = true; fs.writeFileSync(file, JSON.stringify(doc));
  const restarted = new CollaborationStore(file);
  expect(() => restarted.createEmptyLocalGroup('Case', 'key')).toThrow(expect.objectContaining({ code: 'GROUP_CREATE_TARGET_UNAVAILABLE' })); expect(restarted.list()).toHaveLength(1);
});
it('rolls back a failed pre-rename commit and never persists the group without its key', () => {
  const store = new CollaborationStore(file); const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk failed'); });
  expect(() => store.createEmptyLocalGroup('Case', 'key')).toThrow('disk failed'); spy.mockRestore(); expect(store.list()).toEqual([]); expect(fs.existsSync(file)).toBe(false);
  const created = store.createEmptyLocalGroup('Case', 'key');
  expect(new CollaborationStore(file).createEmptyLocalGroup('Case', 'key')).toEqual(created); expect(store.list()).toHaveLength(1);
});
it('keeps a committed group/key after directory fsync failure so uncertain retry cannot duplicate it', () => {
  const store = new CollaborationStore(file), original = fs.fsyncSync;
  const spy = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { if (fs.fstatSync(fd).isDirectory()) throw new Error('directory fsync failed'); original(fd); });
  expect(() => store.createEmptyLocalGroup('Case', 'key')).toThrow('directory fsync failed'); spy.mockRestore();
  const persisted = store.list()[0]; expect(store.createEmptyLocalGroup('Case', 'key')).toEqual(persisted);
  const restarted = new CollaborationStore(file); expect(restarted.createEmptyLocalGroup('Case', 'key')).toEqual(persisted); expect(restarted.list()).toHaveLength(1);
});
it('old valid stores can create groups while malformed journal remains blocked across ordinary writes/restart', () => {
  fs.writeFileSync(file, JSON.stringify({ version: 2, groups: [], messages: [] }));
  const created = new CollaborationStore(file).createEmptyLocalGroup('Case', 'key'); expect(created.sessionIds).toEqual([]);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')); doc.localGroupRequests = { broken: null }; fs.writeFileSync(file, JSON.stringify(doc));
  const invalid = new CollaborationStore(file); expect(() => invalid.createEmptyLocalGroup('Other', 'other')).toThrow(expect.objectContaining({ code: 'GROUP_CREATION_STATE_UNCONFIRMED' }));
  invalid.save({ name: 'Ordinary', sessionIds: [] }); expect(() => new CollaborationStore(file).createEmptyLocalGroup('Other', 'other')).toThrow(expect.objectContaining({ code: 'GROUP_CREATION_STATE_UNCONFIRMED' }));
});
it('corrupt file is not silently treated as an empty creation journal', () => {
  fs.writeFileSync(file, '{broken'); const store = new CollaborationStore(file);
  expect(() => store.createEmptyLocalGroup('Case', 'key')).toThrow(expect.objectContaining({ code: 'GROUP_CREATION_STATE_UNCONFIRMED' }));
});
it('bounded keys cannot be forgotten to allow duplicate creation and existing keys still replay at the limit', () => {
  const store = new CollaborationStore(file), first = store.createEmptyLocalGroup('Case', 'key');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')), record = Object.values(doc.localGroupRequests)[0];
  for (let i = 0; i < 2000; i++) doc.localGroupRequests[i.toString(16).padStart(64, '0')] = record;
  fs.writeFileSync(file, JSON.stringify(doc)); const restarted = new CollaborationStore(file);
  expect(() => restarted.createEmptyLocalGroup('New', 'new')).toThrow(expect.objectContaining({ code: 'GROUP_CREATE_LIMIT' }));
  expect(restarted.createEmptyLocalGroup('Case', 'key')).toEqual(first);
});

it('a same-key retry must not ACK success while directory fsync is still failing', () => {
  const store = new CollaborationStore(file), original = fs.fsyncSync;
  const spy = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { if (fs.fstatSync(fd).isDirectory()) throw new Error('directory remains unavailable'); original(fd); });
  expect(() => store.createEmptyLocalGroup('Case', 'key')).toThrow('directory remains unavailable');
  const created = store.list()[0];
  expect(() => store.createEmptyLocalGroup('Case', 'key')).toThrow('directory remains unavailable');
  expect(store.list()).toHaveLength(1); spy.mockRestore();
  const confirm = vi.spyOn(fs, 'fsyncSync');
  expect(store.createEmptyLocalGroup('Case', 'key')).toEqual(created);
  expect(confirm).toHaveBeenCalledTimes(2); expect(new CollaborationStore(file).createEmptyLocalGroup('Case', 'key')).toEqual(created);
});
