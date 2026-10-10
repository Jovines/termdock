import { Router, type Request } from 'express';
import { CollaborationError } from './collaborationProtocol.js';
import { assertPeerRegistrationAuthority } from './collaborationPeerTransport.js';
import type { CollaborationTaskService } from './collaborationTaskService.js';
import type { CollaborationService } from './collaborationService.js';
import type { CollaborationStore } from './collaborationStore.js';

export function collaborationTaskRoutes(options: { agent: boolean; store: CollaborationStore;
  resolveSession: (input: Record<string, unknown>) => string | null }): Router {
  const router = Router();
  const groupId = (value: string): string => {
    const resolved = options.store.resolveGroupId(value);
    if (resolved.status !== 'ok') throw new CollaborationError(resolved.status === 'ambiguous' ? 'GROUP_ID_AMBIGUOUS' : 'TASK_GROUP_NOT_FOUND', '请使用存在且唯一的协作组 ID', resolved.status === 'ambiguous' ? 409 : 404);
    return resolved.id;
  };
  const context = (req: Request) => {
    const tasks = req.app.locals.collaborationTasks as CollaborationTaskService | undefined;
    const peers = req.app.locals.collaborationService as CollaborationService | undefined;
    if (!tasks || !peers) throw new CollaborationError('TASK_SERVICE_STARTING', '任务服务正在启动，请稍后重试', 503);
    if (!options.agent) {
      try { assertPeerRegistrationAuthority(req); }
      catch { throw new CollaborationError('TASK_PERMISSION_DENIED', '当前连接无权处理协作任务', 403); }
      return { tasks, peers, actor: null };
    }
    const sessionId = options.resolveSession((req.method === 'GET' ? req.query : req.body) ?? {});
    if (!sessionId || sessionId.startsWith('remote:')) throw new CollaborationError('SESSION_NOT_FOUND', '请在 Termdock 管理的本机会话内使用任务命令', 404);
    return { tasks, peers, actor: peers.taskMember(sessionId) };
  };
  const run = (handler: (req: Request, c: ReturnType<typeof context>) => unknown | Promise<unknown>) =>
    async (req: Request, res: import('express').Response) => {
      try { res.json(await handler(req, context(req))); }
      catch (error) { res.status(error instanceof CollaborationError ? error.httpStatus : 400).json({ ok: false,
        code: error instanceof CollaborationError ? error.code : 'TASK_ERROR', error: error instanceof Error ? error.message : String(error) }); }
    };
  router.get('/', run((req, { tasks, actor }) => {
    const requested = typeof req.query.group === 'string' ? groupId(req.query.group) : null;
    const groups = requested ? [requested] : actor ? options.store.groupsForSession(actor.sessionId).map(g => g.id) : options.store.list().map(g => g.id);
    return { tasks: groups.flatMap(id => tasks.list(id, actor, req.query.purpose ?? (options.agent ? 'all' : 'interactive'))) };
  }));
  router.get('/:taskId', run(async (req, { tasks, actor }) => ({ task: await tasks.get(req.params.taskId, actor) })));
  const input = (req: Request, peers: CollaborationService) => {
    const body = req.body?.input;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CollaborationError('INVALID_TASK', '需要任务内容');
    if (body.reviewerSessionIds !== undefined && (!Array.isArray(body.reviewerSessionIds) || body.reviewerSessionIds.length > 32 || body.reviewerSessionIds.some((v: unknown) => typeof v !== 'string'))) throw new CollaborationError('INVALID_REVIEWERS', '执行成员列表无效');
    return { ...body, ...(body.reviewerSessionIds ? { reviewers: body.reviewerSessionIds.map((id: string) => peers.taskMember(id)) } : {}), ...(typeof body.groupId === 'string' ? { groupId: groupId(body.groupId) } : {}), ...(body.assigneeSessionId ? { assignee: peers.taskMember(String(body.assigneeSessionId)) } : {}),
      ...(body.coordinatorSessionId !== undefined ? { coordinator: body.coordinatorSessionId ? peers.taskMember(String(body.coordinatorSessionId)) : null } : {}) };
  };
  router.post('/', run(async (req, { tasks, peers, actor }) => ({ task: await tasks.create(input(req, peers), actor) })));
  router.post('/:taskId', run(async (req, { tasks, peers, actor }) => ({ task: await tasks.apply(req.params.taskId, input(req, peers), actor) })));
  return router;
}
