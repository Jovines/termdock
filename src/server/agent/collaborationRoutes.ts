import { Router, type Request, type Response } from 'express';
import { CollaborationStore, type CollaborationGroup, type CollaborationMessageKind } from './collaborationStore.js';
import { COLLAB_LIMITS, CollaborationError, extrasFromBody } from './collaborationProtocol.js';

/** Member names arrive agent-authored over a CLI; control characters would
 * corrupt terminal shells, tmux options and persisted records. Fold them to
 * spaces, collapse runs, and cap the length (display sanitization for the
 * delivery shell stays in the presentation layer). */
export function cleanMemberName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** What `deliver` reports back: `waitable` is true only when delivery runs in
 *  this server's own worker (local route), so the sender can wait a short
 *  window for the write + snapshot before the receipt is built. Federated and
 *  relayed targets never become waitable — they answer immediately and queue. */
export interface DeliveryOutcome {
  delivered?: string[];
  pending?: number;
  serviceUnavailable?: boolean;
  waitable?: boolean;
  reason?: string;
}

type Dependencies = {
  store: CollaborationStore;
  resolveSession: (input: Record<string, unknown>) => string | null;
  deliver: (id: string) => DeliveryOutcome | Promise<DeliveryOutcome>;
  rebind?: (id: string, pane: string | null) => Promise<unknown>;
  /** Human-readable names for member sessions; absent ids become null so
   * consumers can fall back to the raw session id. */
  resolveNames?: (sessionIds: string[]) => Record<string, string | null>;
  /** Persist a new display name for a member session (global rename, not
   * group-scoped). Callers must already share a group with the target. */
  renameSession?: (sessionId: string, name: string) => Promise<{ ok: boolean; code?: string; error?: string }>;
};
export function collaborationRoutes({ store, resolveSession, deliver, rebind, resolveNames, renameSession }: Dependencies): Router {
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
  /** When the recipient is served by this server's own delivery worker, give
   *  the write (and its post-write snapshot capture) a short window to finish
   *  before the receipt leaves the send/reply call — the sender then sees the
   *  recipient's screen right away. Un-waitable targets (relayed/federated,
   *  offline, or a mock deliver) return immediately with the message queued. */
  const awaitDelivery = async (id: string, outcome: DeliveryOutcome | null): Promise<void> => {
    if (!outcome?.waitable) return;
    const deadline = Date.now() + 2_000;
    for (;;) {
      const receipt = store.receipt(id);
      const settled = receipt.status !== 'pending'
        || receipt.snapshot != null
        || (receipt.attempt_count > 0
          && receipt.last_error !== 'DELIVERY_IN_PROGRESS'
          && (receipt.next_retry_at ?? 0) > Date.now());
      if (settled || Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  router.get('/capabilities', run((_req, res) => { res.json({ protocol_version: 2, limits: COLLAB_LIMITS,
    routing: { background_recovery: true, explicit_rebind: Boolean(rebind), fixed_tmux_pane: true },
    statuses: ['pending', 'delivered', 'read', 'failed', 'expired'], queued_status: 'pending',
    semantics: { delivered: 'written to terminal; no application acknowledgement implied', read: 'explicit consumer acknowledgement',
      ack: 'explicit response_kind=ack', result: 'explicit response_kind=result; inspect task.status and evidence',
      done: 'adapter reports turn ended, never proof of task completion', heartbeat: 'null unless explicitly observed',
      timeout: 'stops waiting, does not cancel delivery',
      retry: 'same message id may be submitted again after a crash or uncertain transport result; consumers deduplicate by message id' } }); }));
  router.post('/send', run(async (req, res, sessionId) => {
    const target = typeof req.body.targetSessionId === 'string' ? req.body.targetSessionId.trim() : '';
    // A fan-out send lists every recipient in toSessionIds; the store persists
    // each edge with its sibling fanOutIds so recipients can tell a broadcast
    // from a one-to-one assignment. The single-recipient shape stays intact.
    const requestedTargets: string[] = Array.isArray(req.body.toSessionIds)
      ? [...new Set((req.body.toSessionIds as unknown[]).filter((id): id is string => typeof id === 'string' && id.trim().length > 0))]
      : [];
    const targets = requestedTargets.length > 0 ? requestedTargets : (target ? [target] : []);
    if (!targets.length) throw new CollaborationError('NO_TARGET', 'send requires a targetSessionId (or toSessionIds for a fan-out)', 400);
    const groups = store.groupsForSession(sessionId)
      .filter((group) => targets.every((candidate) => group.sessionIds.includes(candidate)) && (!req.body.group_id || group.id === req.body.group_id));
    if (!groups.length) throw new CollaborationError('GROUP_NOT_FOUND', 'Sender and recipients must share the specified group');
    if (groups.length > 1 && !req.body.group_id) throw new CollaborationError('AMBIGUOUS_GROUP', 'Multiple shared groups; specify --group');
    if (req.body.task) throw new CollaborationError('DISPATCH_CARRIES_TASK', 'Dispatch carries no task state; recipients report task status through replies', 400);
    const messages = store.send({ ...extrasFromBody(req.body), groupId: groups[0].id, fromSessionId: sessionId, toSessionIds: targets,
      kind: (req.body.kind ?? 'message') as CollaborationMessageKind, content: typeof req.body.message === 'string' ? req.body.message : '',
      threadId: typeof req.body.thread_id === 'string' ? req.body.thread_id : undefined });
    // Wake and await every local recipient edge in parallel; relayed or
    // federated ids answer immediately with the message queued, so fan-out
    // never stalls on a peer.
    await Promise.all(messages.map(async (message) => {
      await awaitDelivery(message.id, (await deliver(message.toSessionId)) ?? null);
    }));
    sent(res, messages.map((message) => message.id));
  }));
  router.post('/reply', run(async (req, res, sessionId) => {
    const original = ownMessage(String(req.body.messageId ?? ''), sessionId, true);
    if (!original.fromSessionId) throw new CollaborationError('NO_REPLY_TARGET', 'User messages have no agent reply target');
    const messages = store.send({ ...extrasFromBody(req.body), groupId: original.groupId, fromSessionId: sessionId,
      toSessionIds: [original.fromSessionId], kind: 'reply', content: typeof req.body.content === 'string' ? req.body.content : '',
      replyTo: original.id, threadId: original.threadId });
    // Reply is explicit consumption; only mark after successful validation/persistence.
    store.markRead([original.id]);
    await awaitDelivery(messages[0]!.id, (await deliver(original.fromSessionId)) ?? null);
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
    // Fan-out edges carry sibling recipients; the names map lets the CLI text
    // renderer show 同时发给了:… as people instead of bare session ids. The
    // fallback to the raw id stays server-side agnostic (federated/offline).
    const nameIds = [...new Set(page.messages.flatMap((message) =>
      [message.fromSessionId, ...(message.fanOutIds ?? [])].filter((id): id is string => typeof id === 'string' && id.length > 0)))];
    res.json({ ok: true, ...page, ...(nameIds.length ? { names: resolveNames?.(nameIds) ?? {} } : {}) });
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
  // Member names ride along so role lists read as people, not bare ids; the
  // caller falls back to the session id when a name is unknown (federated or
  // offline members have no local record).
  const groupView = (group: CollaborationGroup) => {
    const names = resolveNames?.(group.sessionIds) ?? {};
    return {
      id: group.id, name: group.name, sessionIds: group.sessionIds,
      members: group.sessionIds.map((sessionId) => ({ sessionId, name: names[sessionId] ?? null })),
      roles: group.roles ?? {},
    };
  };
  router.get('/role', run((req, res, sessionId) => {
    const groupId = String(req.query.group ?? '');
    if (groupId) {
      res.json({ ok: true, group: groupView(groupOf(groupId, sessionId)) });
      return;
    }
    // Without a group this lists the caller's own groups with full role
    // snapshots — what `td collab --help` renders so a newcomer sees every
    // member's role in one step instead of hunting the group id first.
    res.json({ ok: true, groups: store.groupsForSession(sessionId)
      .filter((group) => !group.deleted)
      .map(groupView) });
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
  router.post('/name', run(async (req, res, sessionId) => {
    if (!renameSession) throw new CollaborationError('RENAME_UNAVAILABLE', 'Member renaming is not available', 503);
    const target = typeof req.body.session_id === 'string' ? req.body.session_id.trim() : '';
    if (!store.groupsForSession(sessionId).some((group) => !group.deleted && group.sessionIds.includes(target))) {
      throw new CollaborationError('NOT_A_MEMBER', 'Rename target must share a collaboration group with the caller', 403);
    }
    const name = typeof req.body.name === 'string' ? cleanMemberName(req.body.name) : '';
    if (!name) throw new CollaborationError('INVALID_NAME', 'name must be non-empty text up to 80 characters', 400);
    const result = await renameSession(target, name);
    if (!result.ok) {
      const missing = result.code === 'SESSION_NOT_FOUND';
      throw new CollaborationError(missing ? 'SESSION_NOT_FOUND' : 'RENAME_FAILED', result.error ?? 'Unable to rename the member', missing ? 404 : 400);
    }
    res.json({ ok: true, sessionId: target, name });
  }));
  return router;
}
