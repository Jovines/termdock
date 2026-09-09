import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CollaborationStore } from './collaborationStore.js';
import { collaborationRoutes } from './collaborationRoutes.js';

describe('collaboration API with arbitrary pull consumers', () => {
  let directory: string; let store: CollaborationStore; let server: Server; let url: string;
  let renamed: Array<[string, string]>;
  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-collab-http-'));
    store = new CollaborationStore(path.join(directory, 'messages.json'));
    store.save({ name: 'Generic clients', sessionIds: ['a', 'b'] });
    renamed = [];
    const app = express(); app.use(express.json({ limit: '5mb' }));
    app.use(collaborationRoutes({ store, resolveSession: (body) => ['a', 'b', 'outsider'].includes(String(body.session)) ? String(body.session) : null,
      deliver: () => ({ delivered: [] }),
      rebind: async (sessionId, pane) => ({ sessionId, pane, state: 'recovering' }),
      resolveNames: (ids) => Object.fromEntries(ids.map((id) => [id, id === 'a' ? '一号 Agent' : id === 'b' ? '二号 Agent' : null])),
      renameSession: async (sessionId, name) => { renamed.push([sessionId, name]);
        return renamed.length > 1 ? { ok: false, code: 'SESSION_NOT_FOUND', error: 'gone' } : { ok: true }; } }));
    server = await new Promise<Server>((resolve) => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); fs.rmSync(directory, { recursive: true, force: true }); });
  const post = async (route: string, body: Record<string, unknown>) => {
    const response = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  it('rebinds the calling session and validates explicit tmux pane ids', async () => {
    expect(await post('/route/rebind', { session: 'b', pane: '%3', targetSessionId: 'a' })).toMatchObject({
      status: 200, body: { ok: true, route: { sessionId: 'b', pane: '%3' } },
    });
    expect(await post('/route/rebind', { session: 'b', pane: 'peer:0' })).toMatchObject({ status: 400, body: { code: 'INVALID_PANE' } });
    expect(await post('/route/rebind', { pane: '%3' })).toMatchObject({ status: 404 });
  });
  it('roundtrips ACK/progress/result without any agent status adapter and enforces message ownership', async () => {
    const { body: sent } = await post('/send', { session: 'a', targetSessionId: 'b', message: 'Verify', idempotency_key: 'request' });
    expect(sent).toMatchObject({ ok: true, status: 'pending', message_id: expect.any(String) });
    expect((await fetch(`${url}/message/${sent.message_id}?session=outsider`)).status).toBe(404);
    expect((await post(`/message/${sent.message_id}/read`, { session: 'a' })).status).toBe(404);
    const inbox = await (await fetch(`${url}/inbox?session=b&unread=true&consumer=pull`)).json();
    expect(inbox.messages).toHaveLength(1);
    expect(store.getMessage(sent.message_id)?.status).toBe('pending');
    await post(`/message/${sent.message_id}/read`, { session: 'b' });
    const read = await (await fetch(`${url}/message/${sent.message_id}?session=a&receipt_only=true`)).json();
    expect(read).toMatchObject({ status: 'read', ack_at: null, result_ids: [] });
    const ack = await post('/reply', { session: 'b', messageId: sent.message_id, content: 'Received', response_kind: 'ack', idempotency_key: 'ack' });
    expect(ack.body.thread_id).toBe(sent.thread_id);
    const result = await post('/reply', { session: 'b', messageId: sent.message_id, content: 'Complete', task: { task_id: 'verify', status: 'complete', evidence: ['test passes'] } });
    expect(result.body.response_kind).toBe('result');
    const final = await (await fetch(`${url}/message/${sent.message_id}?session=a&receipt_only=true`)).json();
    expect(final.ack_at).not.toBeNull(); expect(final.result_ids).toEqual([result.body.message_id]);
    const results = await (await fetch(`${url}/inbox?session=a&response_kind=result`)).json();
    expect(results.messages.map((message: { id: string }) => message.id)).toEqual([result.body.message_id]);
    await post('/cursor/commit', { session: 'b', cursor: inbox.next_cursor, consumer: 'pull' });
    expect((await (await fetch(`${url}/inbox?session=b&unread=true&consumer=pull`)).json()).messages).toEqual([]);
  });
  it('does not mark the original read when reply validation fails', async () => {
    const { body: sent } = await post('/send', { session: 'a', targetSessionId: 'b', message: 'Verify' });
    expect((await post('/reply', { session: 'b', messageId: sent.message_id, content: 'Contradiction', response_kind: 'result', task: { task_id: 't', status: 'ack' } })).status).toBe(400);
    expect(store.getMessage(sent.message_id)?.status).toBe('pending');
  });
  it('reads and writes member roles, requiring the caller and target to be group members', async () => {
    const group = store.list()[0]!;
    const set = await post('/role', { session: 'a', group_id: group.id, session_id: 'b', role: '审查全部补丁' });
    expect(set).toMatchObject({ status: 200, body: { ok: true, group: { roles: { b: '审查全部补丁' } } } });
    expect(await post('/role', { session: 'outsider', group_id: group.id, session_id: 'b', role: '越权' })).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
    expect(await post('/role', { session: 'a', group_id: group.id, session_id: 'absent', role: 'x' })).toMatchObject({ status: 400, body: { code: 'NOT_A_MEMBER' } });
    expect(await post('/role', { session: 'a', group_id: group.id, session_id: 'b', role: 42 })).toMatchObject({ status: 400, body: { code: 'INVALID_ROLE' } });
    expect(await post('/role', { session: 'a', group_id: group.id, session_id: 'b' })).toMatchObject({ status: 400, body: { code: 'INVALID_ROLE' } });
    const cleared = await post('/role', { session: 'a', group_id: group.id, session_id: 'b', role: null });
    expect(cleared.body.group.roles).toEqual({});
    const listed = await (await fetch(`${url}/role?session=a&group=${group.id}`)).json();
    expect(listed.group).toMatchObject({ id: group.id, sessionIds: ['a', 'b'], roles: {} });
    // Member names ride the group view so role lists read as people.
    expect(listed.group.members).toEqual([
      { sessionId: 'a', name: '一号 Agent' }, { sessionId: 'b', name: '二号 Agent' },
    ]);
    expect((await fetch(`${url}/role?session=a&group=missing`)).status).toBe(404);
    expect((await fetch(`${url}/role?session=outsider&group=${group.id}`)).status).toBe(403);
  });

  it('lists the caller own groups with role snapshots when no group id is given', async () => {
    const group = store.list()[0]!;
    await post('/role', { session: 'a', group_id: group.id, session_id: 'b', role: '评审' });
    const own = store.save({ name: 'A 专属组', sessionIds: ['a', 'c'] });
    const listed = await (await fetch(`${url}/role?session=a`)).json();
    expect(listed.groups).toHaveLength(2);
    expect(listed.groups.find((g: { id: string }) => g.id === own.id)).toMatchObject({
      name: 'A 专属组', sessionIds: ['a', 'c'], roles: {},
      members: [{ sessionId: 'a', name: '一号 Agent' }, { sessionId: 'c', name: null }],
    });
    expect(listed.groups.find((g: { id: string }) => g.id === group.id)?.roles).toEqual({ b: '评审' });
    expect((await (await fetch(`${url}/role?session=outsider`)).json()).groups).toEqual([]);
  });

  it('renames a member of a shared group, cleaning control characters from the name', async () => {
    const ok = await post('/name', { session: 'a', session_id: 'b', name: '  二号 \nAgent  ' });
    expect(ok).toMatchObject({ status: 200, body: { ok: true, sessionId: 'b', name: '二号 Agent' } });
    expect(renamed).toEqual([['b', '二号 Agent']]);
    expect(await post('/name', { session: 'outsider', session_id: 'b', name: 'x' })).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
    expect(await post('/name', { session: 'a', session_id: 'absent', name: 'x' })).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
    expect(await post('/name', { session: 'a', session_id: 'b', name: '' })).toMatchObject({ status: 400, body: { code: 'INVALID_NAME' } });
    expect(await post('/name', { session: 'a', session_id: 'b', name: '' })).toMatchObject({ status: 400, body: { code: 'INVALID_NAME' } });
    expect(await post('/name', { session: 'a', session_id: 'b', name: '其他' })).toMatchObject({ status: 404, body: { code: 'SESSION_NOT_FOUND' } });
    expect(renamed).toHaveLength(2);
  });

  it('declares renaming unavailable when no renameSession is wired', async () => {
    const store = new CollaborationStore(path.join(directory, 'unwired.json'));
    store.save({ name: 'Generic clients', sessionIds: ['a', 'b'] });
    const app = express(); app.use(express.json());
    app.use(collaborationRoutes({ store, resolveSession: (body) => String(body.session) === 'a' ? 'a' : null, deliver: () => ({}) }));
    const orphan = await new Promise<Server>((resolve) => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
    try {
      const response = await fetch(`http://127.0.0.1:${(orphan.address() as { port: number }).port}/name`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: 'a', session_id: 'b', name: 'x' }) });
      expect(await response.json()).toMatchObject({ ok: false, code: 'RENAME_UNAVAILABLE' });
    } finally {
      await new Promise<void>((resolve, reject) => orphan.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('fans one send out to several members, persisting sibling ids per edge and naming them in the inbox', async () => {
    const big = store.save({ name: 'Big', sessionIds: ['a', 'b', 'c'] });
    const sent = await post('/send', { session: 'a', toSessionIds: ['b', 'c'], message: '群发任务' });
    expect(sent).toMatchObject({ status: 200, body: { ok: true } });
    expect(store.page('b', { unread: true }).messages[0]).toMatchObject({ fromSessionId: 'a', toSessionId: 'b', content: '群发任务', fanOutIds: ['c'] });
    expect(store.page('c', { unread: true }).messages[0]?.fanOutIds).toEqual(['b']);
    const inbox = await (await fetch(`${url}/inbox?session=b`)).json();
    expect(inbox.messages[0]).toMatchObject({ fromSessionId: 'a', toSessionId: 'b', fanOutIds: ['c'] });
    expect(inbox.names).toMatchObject({ a: '一号 Agent', c: null });
    // One-to-one sends keep the legacy targetSessionId contract and no siblings.
    // a and b already share the beforeEach group, so scope to the new one.
    const single = await post('/send', { session: 'a', group_id: big.id, targetSessionId: 'b', message: '单发' });
    expect(single).toMatchObject({ status: 200, body: { ok: true } });
    const singleEdge = store.page('b', { unread: true }).messages.find((message) => message.content === '单发')!;
    expect(singleEdge.fanOutIds).toBeUndefined();
    // Every recipient must share one group with the sender.
    expect(await post('/send', { session: 'a', toSessionIds: ['b', 'outsider'], message: 'x' })).toMatchObject({ status: 400, body: { code: 'GROUP_NOT_FOUND' } });
    expect(await post('/send', { session: 'a', message: 'x' })).toMatchObject({ status: 400, body: { code: 'NO_TARGET' } });
  });
});
