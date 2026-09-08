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
  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-collab-http-'));
    store = new CollaborationStore(path.join(directory, 'messages.json'));
    store.save({ name: 'Generic clients', sessionIds: ['a', 'b'] });
    const app = express(); app.use(express.json({ limit: '5mb' }));
    app.use(collaborationRoutes({ store, resolveSession: (body) => ['a', 'b', 'outsider'].includes(String(body.session)) ? String(body.session) : null,
      deliver: () => ({ delivered: [] }) }));
    server = await new Promise<Server>((resolve) => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); fs.rmSync(directory, { recursive: true, force: true }); });
  const post = async (route: string, body: Record<string, unknown>) => {
    const response = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
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
});
