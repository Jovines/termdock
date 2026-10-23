import { createHash } from 'node:crypto';
import { Router } from 'express';
import type { CollaborationMessage, CollaborationStore } from './collaborationStore.js';
import { encryptedRequestSubject } from '../federation/requestContext.js';
import { chatPresentation } from '../shared/chatPresentation.js';
import { CollaborationError } from './collaborationProtocol.js';
/** Clients authorized to view this Session share its durable chat history.
 * Per-device delivery addresses remain stable for retries and explicit replies. */
export function sessionChatRoutes(options: {
  store: CollaborationStore;
  resolve(id: string): { sessionId: string; agent?: { slug?: string; displayName?: string } | null } | undefined;
  deliver(id: string): void;
}) {
  const router = Router();
  const context = (req: import('express').Request) => {
    const session = options.resolve(String(req.params.sessionId));
    const subject = encryptedRequestSubject(req);
    if (!session || !subject) return null;
    const principal = `webchat-${createHash('sha256').update(subject).digest('hex').slice(0, 48)}`;
    const groupName = `Session 对话 ${session.sessionId}`;
    return { session, principal, groupName };
  };
  router.get('/:sessionId/chat', (req, res) => {
    const ctx = context(req);
    if (!ctx) { res.status(404).json({ error: '会话不可用，请刷新连接' }); return; }
    const group = options.store.list().find(g => g.name === ctx.groupName && !g.federated && g.sessionIds.length === 1 && g.sessionIds[0] === ctx.session.sessionId);
    const paged = req.query.limit !== undefined;
    const limit = paged ? Number(req.query.limit) : 500;
    const before = req.query.before, after = req.query.after, requestId = req.query.requestId;
    if (paged && (typeof req.query.limit !== 'string' || !/^\d{1,2}$/.test(req.query.limit) || limit < 1 || limit > 60
      || before !== undefined && (typeof before !== 'string' || before.length > 128)
      || after !== undefined && (typeof after !== 'string' || after.length > 128)
      || before !== undefined && after !== undefined
      || requestId !== undefined && (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)))) { res.status(400).json({ error: '对话分页参数无效' }); return; }
    const history = group ? options.store.listGroupMessages(group.id) : [];
    const originals = new Map(history.map(message => [message.id, message]));
    const visible = history.filter(message => {
      if (message.integrationOrigin?.source === 'session-chat') return true;
      const original = message.toPrincipalId && message.replyTo ? originals.get(message.replyTo) : null;
      return original?.groupId === group?.id && message.toPrincipalId === original?.integrationOrigin?.integrationId && original?.integrationOrigin?.source === 'session-chat';
    });
    const cursor = before ?? after;
    const anchor = cursor === undefined ? -1 : visible.findIndex(message => message.id === cursor);
    if (paged && cursor !== undefined && anchor < 0) { res.status(404).json({ error: '这段对话已不可用，请返回最新消息', code: 'CHAT_CURSOR_UNAVAILABLE' }); return; }
    const end = !paged || cursor === undefined ? visible.length : before !== undefined ? anchor : Math.min(visible.length, anchor + 1 + limit);
    const start = paged && after !== undefined ? anchor + 1 : Math.max(0, end - limit);
    const project = (m: CollaborationMessage) => ({ id: m.id, role: m.toPrincipalId ? 'assistant' : 'user', ...(m.toPrincipalId ? chatPresentation(m.content, m.metadata) : { content: m.content }), ...(m.uiState ? { uiState: m.uiState } : {}), createdAt: m.createdAt, status: m.status === 'read' ? 'delivered' : m.status, replyTo: m.replyTo, requestId: m.idempotencyKey, responseKind: m.responseKind, ...(paged ? { sequence: m.sequence } : {}) });
    const messages = visible.slice(start, end).map(project);
    // Refresh only the small tail already displayed, including delivery and
    // form revisions, while fetching subsequent replies contiguously.
    const updates = paged && after !== undefined ? visible.slice(Math.max(0, anchor + 1 - limit), anchor + 1).map(project) : undefined;
    const page = paged ? { hasOlder: start > 0, hasNewer: end < visible.length, mode: before !== undefined ? 'before' : after !== undefined ? 'after' : 'latest' } : undefined;
    let lastRequest: CollaborationMessage | undefined;
    for (let index = visible.length - 1; index >= 0; index--) if (!visible[index].toPrincipalId) { lastRequest = visible[index]; break; }
    const replyPending = !!lastRequest && !['failed', 'expired'].includes(lastRequest.status) && !visible.some(message => message.toPrincipalId && message.replyTo === lastRequest!.id && !['ack', 'progress'].includes(message.responseKind || ''));
    const confirmedRequestId = paged && typeof requestId === 'string' && visible.some(message => !message.toPrincipalId && message.idempotencyKey === requestId) ? requestId : undefined;
    const payload = { messages, ...(updates ? { updates } : {}), ...(page ? { page, replyPending, ...(confirmedRequestId ? { confirmedRequestId } : {}) } : {}), agentAvailable: !!ctx.session.agent, agent: ctx.session.agent ? { slug: ctx.session.agent.slug, displayName: ctx.session.agent.displayName || ctx.session.agent.slug } : null };
    const revision = createHash('sha256').update(JSON.stringify(payload)).digest('base64url');
    res.setHeader('Cache-Control', 'no-store');
    // A JSON acknowledgement works inside the encrypted transport and keeps
    // older clients compatible; no HTTP cache contains conversation bodies.
    res.json(req.query.revision === revision ? { unchanged: true, revision } : { ...payload, revision });
  });
  router.put('/:sessionId/chat/:messageId/state', (req, res) => {
    const ctx = context(req), body = req.body;
    if (!ctx) { res.status(404).json({ error: '会话不可用' }); return; }
    if (!body || typeof body !== 'object' || Object.keys(body).some(key => !['revision', 'values'].includes(key))) { res.status(400).json({ error: '填写内容无效' }); return; }
    try { res.json(options.store.saveChatUIState(String(req.params.messageId), ctx.session.sessionId, body.values, body.revision)); }
    catch (error) { if (error instanceof CollaborationError) res.status(error.httpStatus).json({ error: error.message, ...error.details }); else res.status(500).json({ error: '暂时无法保存，填写内容已保留' }); }
  });
  router.post('/:sessionId/chat', (req, res) => {
    const ctx = context(req);
    if (!ctx) { res.status(404).json({ error: '会话不可用，请刷新连接' }); return; }
    if (!ctx.session.agent) { res.status(409).json({ error: '当前会话未识别到 Agent，请切换终端确认 Agent 已启动' }); return; }
    const body = req.body;
    if (!body || Object.keys(body).some(k => !['content', 'requestId'].includes(k)) || typeof body.content !== 'string' || !body.content.trim() || Buffer.byteLength(body.content) > 32000 || typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(body.requestId)) { res.status(400).json({ error: '消息为空、过长或请求无效' }); return; }
    try {
      let group = options.store.list().find(g => g.name === ctx.groupName && !g.federated && g.sessionIds.length === 1 && g.sessionIds[0] === ctx.session.sessionId);
      if (!group) {
        group = options.store.save({ name: ctx.groupName, sessionIds: [ctx.session.sessionId] });
        options.store.setLocalGroupArchived(group.id, true, group.updatedAt, `chat-${group.id}`);
      }
      const [message] = options.store.send({ groupId: group.id, fromSessionId: null, toSessionIds: [ctx.session.sessionId], kind: 'ask', content: body.content.trim(), integrationOrigin: { integrationId: ctx.principal, source: 'session-chat' }, idempotencyKey: body.requestId, threadId: ctx.principal });
      options.deliver(ctx.session.sessionId);
      res.json({ id: message.id, status: message.status, createdAt: message.createdAt });
    } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : '发送失败，草稿已保留' }); }
  });
  return router;
}
