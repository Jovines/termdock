// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IntegrationStore, type IntegrationPolicy } from './integrationStore.js';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-persistence-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });
function setup(retention = 10000) {
  const file = path.join(directory, 'events.json'), store = new IntegrationStore(file, retention);
  const policy: IntegrationPolicy = { id: 'bridge', groupId: 'group', permissions: ['events.read'], launchProfiles: [] };
  const issued = store.provision(policy), p = store.authenticate('bridge', issued.token);
  const fact = (n: number, group = 'group') => ({ sourceKey: `source-${group}-${n}`, sourceVersion: '1',
    event: { group_id: group, kind: 'message.reply', created_at: n, payload: { text: `event-${n}` } } });
  return { file, store, p, fact, issued, policy };
}

it('does no clone, serialization, write, or fsync for a duplicate durable ACK, but validates it first', () => {
  const f = setup(); f.store.page(f.p, 'inbox'); f.store.append([f.fact(1)]);
  const event = f.store.page(f.p, 'inbox').events[0]!;
  f.store.ack(f.p, 'inbox', event.cursor);
  const clone = vi.spyOn(globalThis, 'structuredClone'), stringify = vi.spyOn(JSON, 'stringify'), write = vi.spyOn(fs, 'writeFileSync'), fsync = vi.spyOn(fs, 'fsyncSync');
  f.store.ack(f.p, 'inbox', event.cursor);
  expect(clone).not.toHaveBeenCalled(); expect(stringify).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(fsync).not.toHaveBeenCalled();
  expect(() => f.store.ack(f.p, 'new-consumer', event.cursor)).toThrow(expect.objectContaining({ code: 'EVENT_CONSUMER_NOT_STARTED' }));
  f.store.append([f.fact(2)]); const second = f.store.page(f.p, 'inbox').events[0]!; f.store.ack(f.p, 'inbox', second.cursor);
  expect(() => f.store.ack(f.p, 'inbox', event.cursor)).toThrow(expect.objectContaining({ code: 'EVENT_ACK_REWIND' }));
  f.store.revoke('bridge');
  expect(() => f.store.ack(f.p, 'inbox', second.cursor)).toThrow(expect.objectContaining({ code: 'INTEGRATION_REVOKED' }));
});

it('keeps existing encoded events immutable across caller mutations, ACK, policy update and restart', () => {
  const f = setup();
  const update = f.fact(1); f.store.append([update]); f.store.page(f.p, 'inbox');
  const first = f.store.page(f.p, 'inbox').events[0]!;
  update.event.payload.text = 'Mutated input'; (first.payload as { text: string }).text = 'Mutated response';
  f.store.ack(f.p, 'inbox', first.cursor);
  f.store.update({ ...f.policy, launchProfiles: [] });
  const doc = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  expect(doc.events[0].payload.text).toBe('event-1');
  const restarted = new IntegrationStore(f.file);
  expect(restarted.page(f.p, 'inbox').events).toEqual([]);
  expect(restarted.page(f.p, 'audit').events[0]!.payload).toEqual({ text: 'event-1' });
});

it('does not re-encode old event payloads or clone the journal for new ACKs and events', () => {
  const f = setup(); f.store.page(f.p, 'inbox'); f.store.append([f.fact(1)]);
  const first = f.store.page(f.p, 'inbox').events[0]!;
  const stringify = vi.spyOn(JSON, 'stringify'), clone = vi.spyOn(globalThis, 'structuredClone');
  f.store.ack(f.p, 'inbox', first.cursor);
  expect(clone).not.toHaveBeenCalled();
  expect(stringify.mock.calls.some(([value]) => value && typeof value === 'object' && 'event_id' in value)).toBe(false);
  stringify.mockClear(); clone.mockClear();
  f.store.append([f.fact(2)]);
  expect(clone).toHaveBeenCalledTimes(1);
  expect(clone.mock.calls[0]![0]).toMatchObject({ kind: 'message.reply' });
  const encodedEvents = stringify.mock.calls.map(([value]) => value).filter(value => value && typeof value === 'object' && 'event_id' in value);
  expect(encodedEvents).toHaveLength(1); expect(encodedEvents[0]).toMatchObject({ payload: { text: 'event-2' } });
  const doc = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  expect(doc.events.map((event: { sequence: number }) => event.sequence)).toEqual([1, 2]);
  expect(doc.consumers['bridge:group:inbox']).toBe(1);
});

it('keeps ACK progress and indexed events unchanged when fsync fails, then retries durably', () => {
  const f = setup(); f.store.page(f.p, 'inbox'); f.store.append([f.fact(1)]);
  const first = f.store.page(f.p, 'inbox').events[0]!;
  vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('disk unavailable'); });
  expect(() => f.store.ack(f.p, 'inbox', first.cursor)).toThrow('disk unavailable');
  expect(f.store.page(f.p, 'inbox').events).toEqual([first]);
  f.store.ack(f.p, 'inbox', first.cursor);
  const second = f.fact(2);
  vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('disk unavailable'); });
  expect(() => f.store.append([second])).toThrow('disk unavailable');
  expect(f.store.page(f.p, 'inbox').events).toEqual([]);
  f.store.append([second]);
  const restarted = new IntegrationStore(f.file);
  expect(restarted.page(f.p, 'inbox').events).toMatchObject([{ sequence: 2, payload: { text: 'event-2' } }]);
});

it('indexes groups and advances retained pages correctly without bypassing retention gaps', () => {
  const f = setup(2); f.store.page(f.p, 'slow');
  f.store.append([f.fact(1), f.fact(1, 'other'), f.fact(2), f.fact(2, 'other'), f.fact(3)]);
  expect(() => f.store.page(f.p, 'slow')).toThrow(expect.objectContaining({ code: 'EVENT_RETENTION_GAP' }));
  const events = f.store.page(f.p, 'new').events;
  expect(events.map(event => event.sequence)).toEqual([2, 3]);
  f.store.ack(f.p, 'new', events[0]!.cursor);
  expect(f.store.page(f.p, 'new').events.map(event => event.sequence)).toEqual([3]);
  expect(() => f.store.ack(f.p, 'slow', events[1]!.cursor)).toThrow(expect.objectContaining({ code: 'EVENT_RETENTION_GAP' }));
});

it('keeps the 64 MiB size check on the exact bytes passed to durable persistence', () => {
  const f = setup();
  const update = f.fact(1); update.event.payload.text = '汉'.repeat(23 * 1024 * 1024);
  const write = vi.spyOn(fs, 'writevSync');
  expect(() => f.store.append([update])).toThrow(expect.objectContaining({ code: 'EVENT_STORAGE_FULL' }));
  expect(write).not.toHaveBeenCalled();
  expect(f.store.page(f.p, 'new').events).toEqual([]);
});

it('handles short vector writes across Unicode boundaries and keeps an interrupted temporary file uncommitted', () => {
  const f = setup(); f.store.page(f.p, 'inbox');
  const update = f.fact(1); update.event.payload.text = '消息，含有不同长度的字节。'.repeat(10);
  const short = vi.spyOn(fs, 'writevSync').mockImplementation((descriptor, buffers) => {
    const bytes = Buffer.concat(buffers as Buffer[]);
    return fs.writeSync(descriptor, bytes, 0, Math.min(31, bytes.length));
  });
  short.mockImplementationOnce(() => { throw Object.assign(new Error('interrupted'), { code: 'EINTR' }); });
  f.store.append([update]); expect(short.mock.calls.length).toBeGreaterThan(1); short.mockRestore();
  expect(new IntegrationStore(f.file).page(f.p, 'inbox').events[0]!.payload).toEqual(update.event.payload);
  const before = fs.readFileSync(f.file);
  vi.spyOn(fs, 'writevSync').mockImplementationOnce((descriptor, buffers) => fs.writeSync(descriptor, (buffers[0] as Buffer).subarray(0, 1)))
    .mockImplementationOnce(() => { throw new Error('disk full during write'); });
  expect(() => f.store.append([f.fact(2)])).toThrow('disk full during write');
  expect(fs.readFileSync(f.file)).toEqual(before);
  vi.restoreAllMocks(); f.store.append([f.fact(2)]);
  expect(new IntegrationStore(f.file).page(f.p, 'inbox').events.map(event => event.sequence)).toEqual([1, 2]);
  expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
});

it('pushes the same authorized, ordered wire facts without cloning or re-encoding retained payloads', () => {
  const f = setup(); f.store.page(f.p, 'inbox'); f.store.append([f.fact(1), f.fact(2), f.fact(1, 'other')]);
  const expected = f.store.page(f.p, 'inbox');
  const clone = vi.spyOn(globalThis, 'structuredClone'), stringify = vi.spyOn(JSON, 'stringify');
  const page = f.store.streamPage(f.p, 'inbox');
  expect(clone).not.toHaveBeenCalled();
  expect(stringify.mock.calls.some(([value]) => value && typeof value === 'object' && 'event_id' in value)).toBe(false);
  expect(page.events.map(event => JSON.parse(event.line.toString('utf8')))).toEqual(expected.events.map(event => ({ type: 'event', ...event })));
  expect(page.events.map(event => event.sequence)).toEqual([1, 2]);
  page.events[0]!.line.fill(0);
  expect(JSON.parse(f.store.streamPage(f.p, 'inbox').events[0]!.line.toString('utf8')).type).toBe('event');
  f.store.revoke('bridge');
  expect(() => f.store.streamPage(f.p, 'inbox')).toThrow(expect.objectContaining({ code: 'INTEGRATION_REVOKED' }));
});
