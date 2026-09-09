import { Router, type Request, type Response } from 'express';
import { CollaborationStore, type CollaborationMessageKind } from './collaborationStore.js';
import { COLLAB_LIMITS, CollaborationError, extrasFromBody } from './collaborationProtocol.js';

type Dependencies = {
  store: CollaborationStore;
  resolveSession: (input: Record<string, unknown>) => string | null;
  deliver: (id: string) => unknown;
  rebind?: (id: string, pane: string | null) => Promise<unknown>;
};
export function collaborationRoutes({ store, resolveSession, deliver, rebind }: Dependencies): Router {
  const router = Router();
  const run = (handler: (req: Request, res: Response, sessionId: string) => void | Promise<void>) => async (req: Request, res: Response) => {
    try {
      const sessionId = resolveSession((req.method === 'GET' ? req.query : req.body) ?? {});
      if (!sessionId) throw new CollaborationError('SESSION_NOT_FOUND', 'Run inside a Termdock managed session', 404);
      await handler(req, res, sessionId);
    } catch (error) {
      res.status(error instanceof CollaborationError ? error.httpStatus : 400).json({ ok: false,
        code: error instanceof CollaborationError ? error.code : 'COLLABORATION_ERROR', error: error instanceof Error ? error.message : String(error) });
    }
  };
  router.post('/route/rebind', run(async (req, res, sessionId) => {
    if (!rebind) throw new CollaborationError('ROUTE_REBIND_UNAVAILABLE', 'Route rebinding is not available');
    const pane = req.body.pane;
    if (pane !== undefined && pane !== null && (typeof pane !== 'string' || !/^%\d+$/.test(pane))) {
      throw new CollaborationError('INVALID_PANE', 'pane must be a tmux pane id such as %3');
    }
    res.json({ ok: true, route: await rebind(sessionId, pane ?? null) });
  }));
  const ownMessage = (id: string, sessionId: string, recipientOnly = false) => {
    const message = store.getMessage(id);
    if (!message || (message.toSessionId !== sessionId && (recipientOnly || message.fromSessionId !== sessionId))) throw new CollaborationError('MESSAGE_NOT_FOUND', 'Message does not belong to this session', 404);
    return message;
  };
  const sent = (res: Response, ids: string[]) => {
    const messages = ids.map((id) => store.getMessage(id)!);
    const receipts = ids.map((id) => store.receipt(id));
    res.json({ ok: true, ...receipts[0], messages, receipts });
  };
  router.get('/capabilities', run((_req, res) => { res.json({ protocol_version: 2, limits: COLLAB_LIMITS,
    routing: { background_recovery: true, explicit_rebind: Boolean(rebind), fixed_tmux_pane: true },
    statuses: ['pending', 'delivered', 'read', 'failed', 'expired'], queued_status: 'pending',
    semantics: { delivered: 'written to terminal; no application acknowledgement implied', read: 'explicit consumer acknowledgement',
      ack: 'explicit response_kind=ack', result: 'explicit response_kind=result; inspect task.status and evidence',
      done: 'adapter reports turn ended, never proof of task completion', heartbeat: 'null unless explicitly observed',
      timeout: 'stops waiting, does not cancel delivery',
      retry: 'same message id may be submitted again after a crash or uncertain transport result; consumers deduplicate by message id' } }); }));
  router.post('/send', run((req, res, sessionId) => {
    const target = typeof req.body.targetSessionId === 'string' ? req.body.targetSessionId.trim() : '';
    const groups = store.groupsForSession(sessionId).filter((group) => group.sessionIds.includes(target) && (!req.body.group_id || group.id === req.body.group_id));
    if (!groups.length) throw new CollaborationError('GROUP_NOT_FOUND', 'Sender and recipient must share the specified group');
    if (groups.length > 1 && !req.body.group_id) throw new CollaborationError('AMBIGUOUS_GROUP', 'Multiple shared groups; specify --group');
    if (req.body.task) throw new CollaborationError('DISPATCH_CARRIES_TASK', 'Dispatch carries no task state; recipients report task status through replies', 400);
    const messages = store.send({ ...extrasFromBody(req.body), groupId: groups[0].id, fromSessionId: sessionId, toSessionIds: [target],
      kind: (req.body.kind ?? 'message') as CollaborationMessageKind, content: typeof req.body.message === 'string' ? req.body.message : '',
      threadId: typeof req.body.thread_id === 'string' ? req.body.thread_id : undefined });
    deliver(target);
    sent(res, messages.map((message) => message.id));
  }));
  router.post('/reply', run((req, res, sessionId) => {
    const original = ownMessage(String(req.body.messageId ?? ''), sessionId, true);
    if (!original.fromSessionId) throw new CollaborationError('NO_REPLY_TARGET', 'User messages have no agent reply target');
    const messages = store.send({ ...extrasFromBody(req.body), groupId: original.groupId, fromSessionId: sessionId,
      toSessionIds: [original.fromSessionId], kind: 'reply', content: typeof req.body.content === 'string' ? req.body.content : '',
      replyTo: original.id, threadId: original.threadId });
    // Reply is explicit consumption; only mark after successful validation/persistence.
    store.markRead([original.id]);
    deliver(original.fromSessionId);
    sent(res, messages.map((message) => message.id));
  }));
  router.get('/message/:id', run((req, res, sessionId) => {
    const message = ownMessage(String(req.params.id), sessionId);
    res.json({ ok: true, ...store.receipt(message.id), ...(req.query.receipt_only === 'true' ? {} : { message }) });
  }));
  router.post('/message/:id/read', run((req, res, sessionId) => {
    const message = ownMessage(String(req.params.id), sessionId, true);
    store.markRead([message.id]);
    res.json({ ok: true, ...store.receipt(message.id) });
  }));
  router.get('/inbox', run((req, res, sessionId) => {
    const string = (key: string) => typeof req.query[key] === 'string' ? req.query[key] as string : undefined;
    const sinceText = string('since');
    const since = sinceText === undefined ? undefined : /^\d+$/.test(sinceText) ? Number(sinceText) : Date.parse(sinceText);
    if (since !== undefined && !Number.isFinite(since)) throw new CollaborationError('INVALID_SINCE', 'since must be an ISO timestamp or epoch milliseconds');
    const page = store.page(sessionId, { unread: string('unread') === 'true', since, afterId: string('after_id'), cursor: string('cursor'),
      consumer: string('consumer'), limit: string('limit') ? Number(string('limit')) : undefined,
      from: string('from'), group: string('group'), thread: string('thread'), kind: string('kind'), responseKind: string('response_kind'), order: string('order') });
    res.json({ ok: true, ...page });
  }));
  router.post('/cursor/commit', run((req, res, sessionId) => {
    store.commitCursor(sessionId, String(req.body.cursor ?? ''), String(req.body.consumer ?? ''));
    res.json({ ok: true, consumer: req.body.consumer, cursor: req.body.cursor });
  }));
  const groupOf = (id: string, sessionId: string) => {
    const group = store.getGroup(id);
    if (!group || group.deleted) throw new CollaborationError('GROUP_NOT_FOUND', 'Collaboration group not found', 404);
    if (!group.sessionIds.includes(sessionId)) throw new CollaborationError('NOT_A_MEMBER', 'Session is not a member of this group', 403);
    return group;
  };
  router.get('/role', run((req, res, sessionId) => {
    const group = groupOf(String(req.query.group ?? ''), sessionId);
    res.json({ ok: true, group: { id: group.id, name: group.name, sessionIds: group.sessionIds, roles: group.roles ?? {} } });
  }));
  router.post('/role', run((req, res, sessionId) => {
    const group = groupOf(String(req.body.group_id ?? ''), sessionId);
    const role = req.body.role;
    if (typeof req.body.session_id !== 'string' || !group.sessionIds.includes(req.body.session_id)) {
      throw new CollaborationError('NOT_A_MEMBER', 'Role target must be a member of this group', 400);
    }
    if (role === undefined || (role !== null && typeof role !== 'string')) {
      throw new CollaborationError('INVALID_ROLE', 'role must be text or null', 400);
    }
    const updated = store.setRole({ groupId: group.id, sessionId: req.body.session_id, role: role as string | null });
    res.json({ ok: true, group: { ...updated, roles: updated.roles ?? {} } });
  }));
  return router;
}
