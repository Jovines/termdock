import { Router } from 'express';
import type { CollaborationStore } from './collaborationStore.js';
import { CollaborationError } from './collaborationProtocol.js';
import { COLLAB_NAME_FORBIDDEN } from './collaborationPrompt.js';

/** The current service owns group membership, including retained offline members. */
export function collaborationGroupRoutes(options: {
  store: CollaborationStore;
  sessions(): Array<{ sessionId: string }>;
}): Router {
  const router = Router();
  router.get('/collaboration-groups', (_req, res) => {
    res.json({ federationVersion: 1, capabilities: { groupRevision: 1, groupPromotion: 1, groupMove: 1 },
      groups: options.store.list(), sessions: options.sessions() });
  });
  router.post('/collaboration-groups', (req, res) => {
    try {
      const { id, name, sessionIds, expectedUpdatedAt } = req.body ?? {};
      if ((id !== undefined && (typeof id !== 'string' || !id))
        || typeof name !== 'string' || !name.trim() || !Array.isArray(sessionIds)
        || sessionIds.some((value) => typeof value !== 'string' || !value.trim())) {
        throw new CollaborationError('INVALID_GROUP', '名称和成员列表无效', 400);
      }
      if (COLLAB_NAME_FORBIDDEN.test(name.trim())) {
        throw new CollaborationError('INVALID_GROUP', '名称不能包含「【】」、间隔号「·」、换行或控制字符', 400);
      }
      const existing = id ? options.store.getGroup(id) : null;
      if (id && (!existing || existing.deleted)) throw new CollaborationError('GROUP_NOT_FOUND', '协作组已删除，请刷新列表', 404);
      if (expectedUpdatedAt !== undefined && (!Number.isFinite(expectedUpdatedAt) || expectedUpdatedAt !== existing?.updatedAt)) {
        throw new CollaborationError('GROUP_CHANGED', '协作组已被修改，请重新打开成员管理后再保存', 409);
      }
      const ids = [...new Set<string>(sessionIds)];
      if (ids.length < 2) throw new CollaborationError('INVALID_GROUP', '协作组至少需要两个有效会话', 400);
      const known = new Set([...options.sessions().map((session) => session.sessionId), ...(existing?.sessionIds ?? [])]);
      if (ids.some((value) => !known.has(value))) {
        throw new CollaborationError('MEMBERS_CHANGED', '所选会话已变化，请刷新后重新选择；尚未保存任何修改', 409);
      }
      res.json({ group: options.store.save({ id, name, sessionIds: ids }) });
    } catch (error) {
      res.status(error instanceof CollaborationError ? error.httpStatus : 500)
        .json({ code: error instanceof CollaborationError ? error.code : 'GROUP_SAVE_FAILED',
          error: error instanceof Error ? error.message : '协作组保存失败' });
    }
  });
  router.post('/collaboration-groups/move-member', (req, res) => {
    try {
      const input = req.body ?? {};
      if (typeof input.sourceGroupId !== 'string' || typeof input.targetGroupId !== 'string' || typeof input.sessionId !== 'string'
        || !options.sessions().some((session) => session.sessionId === input.sessionId)) {
        throw new CollaborationError('MEMBERS_CHANGED', '所选会话已变化，请刷新后重新选择', 409);
      }
      options.store.moveMember(input);
      res.json({ groups: options.store.list() });
    } catch (error) {
      res.status(error instanceof CollaborationError ? error.httpStatus : 500)
        .json({ code: error instanceof CollaborationError ? error.code : 'GROUP_MOVE_FAILED',
          error: error instanceof Error ? error.message : '成员移动失败' });
    }
  });
  router.post('/collaboration-groups/:groupId/promote', (req, res) => {
    try {
      const { group, expectedUpdatedAt } = req.body ?? {};
      const existing = options.store.getGroup(req.params.groupId);
      if (!group || !Array.isArray(group.sessionIds) || !Array.isArray(group.remoteSessions)) {
        throw new CollaborationError('INVALID_GROUP', '跨服务工作组无效', 400);
      }
      const known = new Set([...options.sessions().map((session) => session.sessionId),
        ...(existing?.sessionIds ?? []), ...group.remoteSessions.map((session: { sessionId: string }) => session?.sessionId)]);
      if (group.sessionIds.some((id: string) => !known.has(id))) throw new CollaborationError('MEMBERS_CHANGED', '所选会话已变化，请刷新后重新选择', 409);
      res.json({ group: options.store.promoteGroup(req.params.groupId, group, expectedUpdatedAt) });
    } catch (error) {
      res.status(error instanceof CollaborationError ? error.httpStatus : 400)
        .json({ code: error instanceof CollaborationError ? error.code : 'GROUP_PROMOTION_FAILED',
          error: error instanceof Error ? error.message : '跨服务组转换失败' });
    }
  });
  router.delete('/collaboration-groups/:groupId', (req, res) => {
    const existing = options.store.getGroup(req.params.groupId);
    if (req.query.expectedUpdatedAt !== undefined && Number(req.query.expectedUpdatedAt) !== existing?.updatedAt) {
      return res.status(409).json({ code: 'GROUP_CHANGED', error: '协作组已变化，请刷新后重新操作' });
    }
    if (!options.store.remove(req.params.groupId)) return res.status(404).json({ error: '协作组不存在' });
    res.status(204).send();
  });
  return router;
}
