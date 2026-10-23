import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionChatRoutes } from './sessionChatRoutes';
import { CollaborationStore } from './collaborationStore';
import { markEncryptedRequest } from '../federation/requestContext';
const clean: (() => void)[] = [];
afterEach(() => clean.splice(0).reverse().forEach(fn => fn()));
async function fixture(existingFile?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'td-chat-')); clean.push(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = existingFile || join(dir, 'collab.json');
  const store = new CollaborationStore(filePath), deliver = vi.fn();
  const app = express(); app.use(express.json());
  // Test-only authentication boundary; never mounted by the product.
  app.use((req, _res, next) => { markEncryptedRequest(req, String(req.headers['test-subject'] || 'alice'), req.headers['test-access'] !== 'scoped'); next(); });
  app.use(sessionChatRoutes({ store, deliver, resolve: id => id === 'agent' ? { sessionId: id, agent: { slug: 'test' } } : id === 'shell' ? { sessionId: id } : undefined }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); clean.push(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error(); const base = `http://127.0.0.1:${address.port}`;
  const post = (content: string, requestId = 'request-00000000001', subject = 'alice') => fetch(`${base}/agent/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'test-subject': subject }, body: JSON.stringify({ content, requestId }) });
  const read = (subject = 'alice', scoped = false) => fetch(`${base}/agent/chat`, { headers: { 'test-subject': subject, ...(scoped ? { 'test-access': 'scoped', 'x-termdock-full-service': '1' } : {}) } }).then(r => r.json());
  return { store, deliver, base, post, read, filePath };
}
it('persists messages once and shares existing Session history across full-service clients and service reloads', async () => {
  const f = await fixture();
  expect((await fetch(`${f.base}/agent/chat`).then(r => r.json())).messages).toEqual([]);
  const first = await f.post('请帮我解释结果').then(r => r.json());
  expect((await f.post('请帮我解释结果').then(r => r.json())).id).toBe(first.id);
  expect((await f.post('改变内容')).status).toBe(409);
  const original = f.store.getMessage(first.id)!;
  expect(original.integrationOrigin?.source).toBe('session-chat'); expect(original.fromSessionId).toBeNull();
  f.store.storeIntegrationReply(original.id, 'agent', '**完成**\n\n解释正文', { idempotencyKey: 'reply-000000000001', responseKind: 'result' });
  const mine = await fetch(`${f.base}/agent/chat`).then(r => r.json());
  expect(mine.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
  expect(mine.messages[1].content).toContain('解释正文');
  expect((await f.read('bob')).messages).toEqual(mine.messages);
  // Sending identity and deduplication stay unchanged, including retries from older clients.
  const next = await f.post('继续处理', 'request-00000000002', 'bob').then(r => r.json());
  expect((await f.read('alice')).messages.map((m: { id: string }) => m.id)).toEqual([first.id, mine.messages[1].id, next.id]);
  const restarted = await fixture(f.filePath);
  expect((await restarted.read('another-device')).messages).toEqual((await f.read()).messages);
  expect(f.deliver).toHaveBeenCalledWith('agent');
  expect(JSON.stringify(mine)).not.toContain('readAt');
});
it('rejects shell sessions, arbitrary destinations and malformed requests without queuing work', async () => {
  const f = await fixture();
  expect((await fetch(`${f.base}/shell/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'rm -rf', requestId: 'request-00000000001' }) })).status).toBe(409);
  expect((await fetch(`${f.base}/agent/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'test', requestId: 'request-00000000001', sessionId: 'other' }) })).status).toBe(400);
  expect(f.deliver).not.toHaveBeenCalled(); expect(f.store.list()).toEqual([]);
});

it('shares the same Session conversation with scoped viewers without relying on client headers', async () => {
  const f = await fixture();
  const a = await f.post('第一位的消息', 'request-00000000001', 'guest-a').then(r => r.json());
  const b = await f.post('第二位的消息', 'request-00000000001', 'guest-b').then(r => r.json());
  const aReply = f.store.storeIntegrationReply(a.id, 'agent', '第一位的回复', { idempotencyKey: 'reply-000000000001', responseKind: 'result' });
  f.store.storeIntegrationReply(b.id, 'agent', '第二位的回复', { idempotencyKey: 'reply-000000000002', responseKind: 'result' });
  expect((await f.read('guest-a', true)).messages).toHaveLength(4);
  expect((await f.read('new-guest', true)).messages).toEqual((await f.read('owner')).messages);
  expect((await f.read('new-guest', true)).messages.some((m: { id: string }) => m.id === aReply.id)).toBe(true);
  expect((await f.read('owner')).messages).toHaveLength(4);
});
it('only includes chat requests and their matching replies, without exposing other collaboration integrations or sessions', async () => {
  const f = await fixture();
  const a = await f.post('聊天正文').then(r => r.json());
  const original = f.store.getMessage(a.id)!;
  const [external] = f.store.send({ groupId: original.groupId, fromSessionId: null, toSessionIds: ['agent'], kind: 'ask', content: '其他集成内容', integrationOrigin: { integrationId: original.integrationOrigin!.integrationId, source: 'external' }, idempotencyKey: 'external-0000000001' });
  f.store.storeIntegrationReply(external.id, 'agent', '其他集成回复', { idempotencyKey: 'reply-external-000001', responseKind: 'result' });
  const otherGroup = f.store.save({ name: 'Session 对话 another', sessionIds: ['another'] });
  f.store.send({ groupId: otherGroup.id, fromSessionId: null, toSessionIds: ['another'], kind: 'ask', content: '其他会话内容', integrationOrigin: { integrationId: original.integrationOrigin!.integrationId, source: 'session-chat' } });
  expect((await f.read('owner')).messages.map((m: { id: string }) => m.id)).toEqual([a.id]);
  expect((await f.read('alice', true)).messages.map((m: { id: string }) => m.id)).toEqual([a.id]);
});
