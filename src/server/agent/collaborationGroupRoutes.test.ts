import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollaborationStore } from './collaborationStore.js';
import { collaborationGroupRoutes } from './collaborationGroupRoutes.js';

describe('authoritative collaboration membership HTTP API', () => {
  let directory: string; let store: CollaborationStore; let server: Server; let url: string;
  let sessions: Array<{ sessionId: string; agent: { slug: string; displayName: string } | null }>;
  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-groups-'));
    store = new CollaborationStore(path.join(directory, 'groups.json'));
    sessions = [{ sessionId: 'custom', agent: { slug: 'traex-status', displayName: 'TraeX' } }, { sessionId: 'shell', agent: null }];
    const app = express(); app.use(express.json()); app.use(collaborationGroupRoutes({ store, sessions: () => sessions }));
    server = await new Promise<Server>((resolve) => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/collaboration-groups`;
  });
  afterEach(async () => { vi.restoreAllMocks(); await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); });
  const save = async (body: unknown) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  it('lists and saves custom agents and plain terminals with the same rules', async () => {
    const listed = await (await fetch(url)).json();
    expect(listed).toMatchObject({ capabilities: { groupRevision: 1 }, sessions });
    const result = await save({ name: 'Mixed', sessionIds: ['custom', 'shell'] });
    expect(result.status).toBe(200); expect(result.body.group.sessionIds).toEqual(['custom', 'shell']);
  });
  it('rejects the entire request if any new member disappeared, even when two valid ones remain', async () => {
    const result = await save({ name: 'Race', sessionIds: ['custom', 'shell', 'disappeared'] });
    expect(result).toMatchObject({ status: 409, body: { code: 'MEMBERS_CHANGED' } });
    expect(store.list()).toEqual([]);
  });
  it('preserves offline original members until explicitly deselected', async () => {
    const original = store.save({ name: 'Original', sessionIds: ['custom', 'offline'] });
    const result = await save({ id: original.id, name: original.name, sessionIds: ['custom', 'offline', 'shell'], expectedUpdatedAt: original.updatedAt });
    expect(result.status).toBe(200); expect(result.body.group.sessionIds).toEqual(['custom', 'offline', 'shell']);
    const updated = await save({ id: original.id, name: original.name, sessionIds: ['custom', 'shell'], expectedUpdatedAt: result.body.group.updatedAt });
    expect(updated.body.group.sessionIds).toEqual(['custom', 'shell']);
  });
  it('does not overwrite a concurrent member edit or recreate a deleted group', async () => {
    const original = store.save({ name: 'Original', sessionIds: ['custom', 'shell'] });
    const newer = store.save({ id: original.id, name: 'Renamed', sessionIds: ['custom', 'shell'] });
    expect(await save({ ...original, expectedUpdatedAt: original.updatedAt })).toMatchObject({ status: 409, body: { code: 'GROUP_CHANGED' } });
    expect(store.getGroup(original.id)?.name).toBe('Renamed');
    store.remove(newer.id);
    expect(await save(newer)).toMatchObject({ status: 404 });
    expect(store.list()).toEqual([]);
  });
  it('does not dissolve a two-member group when another member was added during a drag', async () => {
    const original = store.save({ name: 'Source', sessionIds: ['custom', 'offline'] });
    const updated = store.save({ ...original, sessionIds: ['custom', 'offline', 'shell'] });
    const response = await fetch(`${url}/${original.id}?expectedUpdatedAt=${original.updatedAt}`, { method: 'DELETE' });
    expect(response.status).toBe(409); expect(store.getGroup(original.id)).toEqual(updated);
  });
  it('updates and deletes existing federated replicas without needing the desktop bridge', async () => {
    const remoteId = 'remote:https%3A%2F%2Fpeer.test:one';
    const remote = { sessionId: remoteId, serviceOrigin: 'https://peer.test', serviceLabel: 'Peer', serviceConnected: false,
      name: 'Peer', cwd: '', status: 'offline', capability: '', currentTask: '', updatedAt: 1, backendSessionId: null,
      agentNativeSessionId: null, agent: null };
    store.mergeFederatedGroup({ id: 'cross-group', name: 'Pair', sessionIds: ['custom', remoteId],
      federated: true, remoteSessions: [remote], createdAt: 1, updatedAt: 1 });
    expect(await save({ id: 'cross-group', name: 'Three', sessionIds: ['custom', 'shell', remoteId], expectedUpdatedAt: 1 })).toMatchObject({ status: 200 });
    expect(store.getGroup('cross-group')).toMatchObject({ federated: true, remoteSessions: [remote] });
    expect((await fetch(`${url}/cross-group`, { method: 'DELETE' })).status).toBe(204);
    expect(store.list()).toEqual([]); expect(store.federationSnapshot().groups[0].deleted).toBe(true);
    expect(await save({ id: 'cross-group', name: 'Resurrect', sessionIds: ['custom', 'shell'] })).toMatchObject({ status: 404 });
  });
  it('moves a member between groups atomically and rolls both groups back on failure', async () => {
    const source = store.save({ name: 'Source', sessionIds: ['custom', 'offline-source'] });
    const target = store.save({ name: 'Target', sessionIds: ['shell', 'offline-target'] });
    const move = async (revision = source.updatedAt) => {
      const response = await fetch(`${url}/move-member`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceGroupId: source.id, targetGroupId: target.id, sessionId: 'custom',
          expectedSourceUpdatedAt: revision, expectedTargetUpdatedAt: target.updatedAt }) });
      return response.status;
    };
    expect(await move(source.updatedAt - 1)).toBe(409);
    expect(store.getGroup(source.id)).toEqual(source); expect(store.getGroup(target.id)).toEqual(target);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    expect(await move()).toBe(500);
    expect(store.getGroup(source.id)).toEqual(source); expect(store.getGroup(target.id)).toEqual(target);
    rename.mockRestore();
    expect(await move()).toBe(200);
    const restored = new CollaborationStore(path.join(directory, 'groups.json'));
    expect(restored.getGroup(source.id)).toBeNull();
    expect(restored.getGroup(target.id)?.sessionIds).toEqual(['shell', 'offline-target', 'custom']);
  });

  it('atomically promotes all history and idempotency records, and rolls back on a disk failure', async () => {
    const original = store.save({ name: 'Original', sessionIds: ['custom', 'shell'] });
    const sent = store.send({ groupId: original.id, fromSessionId: 'custom', toSessionIds: ['shell'], kind: 'ask', content: 'Keep history', idempotencyKey: 'request' });
    const group = { ...original, id: 'cross-promoted', federated: true, remoteSessions: [] };
    const promote = async () => {
      const response = await fetch(`${url}/${original.id}/promote`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group, expectedUpdatedAt: original.updatedAt }) });
      return { status: response.status, body: await response.json() };
    };
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    expect((await promote()).status).toBe(400);
    expect(store.list()).toEqual([original]);
    expect(store.listMessages(original.id)).toEqual(sent);
    expect(new CollaborationStore(path.join(directory, 'groups.json')).list()).toEqual([original]);
    rename.mockRestore();
    const result = await promote();
    expect(result.status).toBe(200); expect(store.getGroup(original.id)).toBeNull();
    const restarted = new CollaborationStore(path.join(directory, 'groups.json'));
    expect(restarted.list()).toHaveLength(1);
    expect(restarted.listMessages(group.id).map((message) => message.id)).toEqual(sent.map((message) => message.id));
    expect(restarted.send({ groupId: group.id, fromSessionId: 'custom', toSessionIds: ['shell'], kind: 'ask', content: 'Keep history', idempotencyKey: 'request' }).map((message) => message.id))
      .toEqual(sent.map((message) => message.id));
  });

  it('rejects malformed members instead of coercing a partially valid request', async () => {
    for (const sessionIds of [['custom', 'shell', 7], ['custom', 'shell', ''], ['custom', 'custom']]) {
      expect((await save({ name: 'Invalid', sessionIds })).status).toBe(400);
    }
    expect(store.list()).toEqual([]);
  });

  it('sets and clears a member role through the UI endpoint', async () => {
    const group = (await save({ name: 'Roles', sessionIds: ['custom', 'shell'] })).body.group as { id: string };
    const role = async (sessionId: unknown, role: unknown) => {
      const response = await fetch(`${url}/${group.id}/role`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, role }) });
      return { status: response.status, body: await response.json() };
    };
    expect(await role('custom', '负责渲染\n\t与排版')).toMatchObject({ status: 200, body: { group: { roles: { custom: '负责渲染 与排版' } } } });
    expect((await role('shell', null)).body.group.roles).toEqual({ custom: '负责渲染 与排版' });
    expect((await role('outsider', 'x')).status).toBe(400);
    expect((await role('custom', undefined)).status).toBe(400);
    expect((await role('custom', 42)).status).toBe(400);
    expect(store.getGroup(group.id)?.roles).toEqual({ custom: '负责渲染 与排版' });
    const listed = await (await fetch(url)).json() as { groups: Array<{ id: string; roles?: Record<string, string> }> };
    expect(listed.groups.find((item) => item.id === group.id)?.roles).toEqual({ custom: '负责渲染 与排版' });
  });
});
