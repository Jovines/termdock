import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
it('persists OpenUI replies and versioned form values for authorized clients, with text compatibility and conflict detection', async () => {
  const f = await fixture(), original = await f.post('选择方案').then(response => response.json());
  const ui = 'root = Stack([Text("方案说明")])';
  const reply = f.store.storeIntegrationReply(original.id, 'agent', JSON.stringify({ text: '完整的文字说明', ui }), { idempotencyKey: 'ui-reply', metadata: { openui: { version: 1 } } });
  expect((await f.read('other-device', true)).messages[1]).toMatchObject({ content: '完整的文字说明', ui: { version: 1, code: ui } });
  const save = (revision: number, values: unknown, id = reply.id) => fetch(`${f.base}/agent/chat/${id}/state`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, values }) });
  const values = { form: { plan: { value: 'A' } } };
  expect(await save(0, values).then(response => response.json())).toEqual({ revision: 1, values });
  expect((await save(0, { plan: 'B' })).status).toBe(409);
  expect((await save(1, {}, original.id)).status).toBe(404);
  expect((await save(1, { nested: JSON.parse('{"__proto__":{"polluted":true}}') })).status).toBe(400);
  const restarted = await fixture(f.filePath);
  expect((await restarted.read()).messages[1].uiState).toEqual({ revision: 1, values });
  f.store.storeIntegrationReply(original.id, 'agent', JSON.stringify({ text: '版本升级仍可阅读', ui }), { idempotencyKey: 'future-ui-reply', metadata: { openui: { version: 99 } } });
  expect((await f.read()).messages[2]).toMatchObject({ content: '版本升级仍可阅读' });
  expect((await f.read()).messages[2].ui).toBeUndefined();
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
  const externalUI = f.store.storeIntegrationReply(external.id, 'agent', JSON.stringify({ text: '其他集成的交互回复', ui: 'root = Stack([Text("other")])' }), { idempotencyKey: 'reply-external-ui', metadata: { openui: { version: 1 } } });
  expect((await fetch(`${f.base}/agent/chat/${externalUI.id}/state`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 0, values: { plan: 'A' } }) })).status).toBe(404);
  const otherGroup = f.store.save({ name: 'Session 对话 another', sessionIds: ['another'] });
  f.store.send({ groupId: otherGroup.id, fromSessionId: null, toSessionIds: ['another'], kind: 'ask', content: '其他会话内容', integrationOrigin: { integrationId: original.integrationOrigin!.integrationId, source: 'session-chat' } });
  expect((await f.read('owner')).messages.map((m: { id: string }) => m.id)).toEqual([a.id]);
  expect((await f.read('alice', true)).messages.map((m: { id: string }) => m.id)).toEqual([a.id]);
});

it('returns a small revision acknowledgement for unchanged history and full data after a reply or form update', async () => {
  const f = await fixture(), sent = await f.post('请比较方案').then(response => response.json());
  const first = await f.read();
  const poll = (revision: string) => fetch(`${f.base}/agent/chat?revision=${encodeURIComponent(revision)}`).then(response => response.json());
  expect(await poll(first.revision)).toEqual({ unchanged: true, revision: first.revision });
  const reply = f.store.storeIntegrationReply(sent.id, 'agent', JSON.stringify({ text: '方案说明', ui: 'root = Stack([Text("方案")])' }), { idempotencyKey: 'revision-reply', metadata: { openui: { version: 1 } } });
  const updated = await poll(first.revision);
  expect(updated.messages).toHaveLength(2); expect(updated.revision).not.toBe(first.revision);
  f.store.saveChatUIState(reply.id, 'agent', { plan: 'A' }, 0);
  const edited = await poll(updated.revision);
  expect(edited.messages[1].uiState).toEqual({ revision: 1, values: { plan: 'A' } });
  expect(edited.revision).not.toBe(updated.revision);
  expect((await f.read('scoped-guest', true)).messages).toHaveLength(2);
  expect((await fetch(`${f.base}/missing/chat?revision=${edited.revision}`)).status).toBe(404);
});

it('pages the retained history beyond 500 messages without gaps, overlaps or offset shifts from new arrivals', async () => {
  const f = await fixture(), original = await f.post('seed').then(response => response.json());
  const template = f.store.getMessage(original.id)!;
  const document = JSON.parse(readFileSync(f.filePath, 'utf8'));
  document.messages = Array.from({ length: 760 }, (_, index) => ({ ...template, id: `page-${index}`, sequence: index + 1, createdAt: index + 1, status: 'delivered', content: `message ${index}`, idempotencyKey: `seed-${index}` }));
  writeFileSync(f.filePath, JSON.stringify(document));
  const current = await fixture(f.filePath);
  const page = (query = '') => fetch(`${current.base}/agent/chat?limit=30${query}`).then(response => response.json());
  let result = await page();
  expect(result.messages).toHaveLength(30);
  expect(result.messages[0].id).toBe('page-730');
  expect(result.page).toEqual({ hasOlder: true, hasNewer: false, mode: 'latest' });
  const ids = result.messages.map((message: { id: string }) => message.id);
  await current.post('new arrival', 'paging-new-arrival');
  while (result.page.hasOlder) {
    result = await page(`&before=${result.messages[0].id}`);
    expect(result.messages.length).toBeLessThanOrEqual(30);
    ids.unshift(...result.messages.map((message: { id: string }) => message.id));
  }
  expect(ids).toEqual(Array.from({ length: 760 }, (_, index) => `page-${index}`));
  expect(new Set(ids).size).toBe(760);
  expect((await current.read()).messages).toHaveLength(500);
  const next = await page('&after=page-759');
  expect(next.messages.map((message: { content: string }) => message.content)).toEqual(['new arrival']);
  expect(next.updates).toHaveLength(30);
  expect(next.updates[29].id).toBe('page-759');
  const unchanged = await page(`&after=page-759&revision=${next.revision}`);
  expect(unchanged).toEqual({ unchanged: true, revision: next.revision });
});

it('validates paging cursors within the visible conversation and retains per-page form and status updates', async () => {
  const f = await fixture(), sent = await f.post('interactive').then(response => response.json());
  const original = f.store.getMessage(sent.id)!;
  const [external] = f.store.send({ groupId: original.groupId, fromSessionId: null, toSessionIds: ['agent'], kind: 'ask', content: 'private external body', integrationOrigin: { integrationId: 'external', source: 'external' } });
  const fetchPage = (query: string) => fetch(`${f.base}/agent/chat?limit=2${query}`);
  expect((await fetchPage(`&before=${external.id}`)).status).toBe(404);
  expect((await fetchPage('&before=missing')).status).toBe(404);
  for (const query of ['limit=0', 'limit=61', 'limit=wrong', 'limit=2&before=x&after=y']) expect((await fetch(`${f.base}/agent/chat?${query}`)).status).toBe(400);
  const first = await fetchPage(`&after=${sent.id}`).then(response => response.json());
  expect(first.messages).toEqual([]); expect(first.updates).toHaveLength(1);
  f.store.fail(sent.id, 'test failure');
  const changed = await fetchPage(`&after=${sent.id}&revision=${first.revision}`).then(response => response.json());
  expect(changed.updates[0].status).toBe('failed'); expect(changed.revision).not.toBe(first.revision);
  expect(JSON.stringify(changed)).not.toContain('private external body');
  const reply = f.store.storeIntegrationReply(sent.id, 'agent', JSON.stringify({ text: 'plan', ui: 'root = Stack([Text("plan")])' }), { idempotencyKey: 'page-ui-reply', metadata: { openui: { version: 1 } } });
  const uiPage = await fetchPage(`&after=${reply.id}`).then(response => response.json());
  f.store.saveChatUIState(reply.id, 'agent', { selected: 'A' }, 0);
  const edited = await fetchPage(`&after=${reply.id}&revision=${uiPage.revision}`).then(response => response.json());
  expect(edited.updates.find((message: { id: string }) => message.id === reply.id).uiState.values).toEqual({ selected: 'A' });
});

it('confirms a retained pending request and reports its unanswered state without transferring the original request body', async () => {
  const f = await fixture(), requestId = 'pending-outside-current-page';
  const sent = await f.post('old request outside the page', requestId).then(response => response.json());
  for (let index = 0; index < 35; index++) f.store.storeIntegrationReply(sent.id, 'agent', `progress ${index}`, { idempotencyKey: `progress-${index}`, responseKind: 'progress' });
  const read = () => fetch(`${f.base}/agent/chat?limit=30&requestId=${requestId}`).then(response => response.json());
  const page = await read();
  expect(page.messages).toHaveLength(30); expect(page.messages.every((message: { role: string }) => message.role === 'assistant')).toBe(true);
  expect(page.confirmedRequestId).toBe(requestId); expect(page.replyPending).toBe(true);
  expect(JSON.stringify(page)).not.toContain('old request outside the page');
  f.store.storeIntegrationReply(sent.id, 'agent', 'completed', { idempotencyKey: 'last-paged-result', responseKind: 'result' });
  expect((await read()).replyPending).toBe(false);
});
