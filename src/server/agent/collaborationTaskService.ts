import type { Packet } from '../federation/packets.js';
import type { CollaborationNode } from './collaborationPeerTransport.js';
import type { CollaborationService } from './collaborationService.js';
import type { CollaborationStore } from './collaborationStore.js';
import { CollaborationError } from './collaborationProtocol.js';
import { CollaborationTaskStore } from './collaborationTaskStore.js';
import { captureTaskCommit } from './collaborationTaskWorkspace.js';
import { taskBundleChunk } from './collaborationTaskBundles.js';
import { taskExecution, taskPurpose, taskPurposeFilter } from './collaborationTaskPurpose.js';
import { taskMemberKey, type CollaborationTask, type CollaborationTaskView, type TaskCreateInput, type TaskMember, type TaskOperation, type TaskWorkspace, type TaskOrigin } from './collaborationTaskTypes.js';

export type PrepareTaskWorker = (task: CollaborationTask, template: TaskMember, dependencies: CollaborationTask[]) => Promise<{ sessionId: string; workspace: TaskWorkspace }>;

/** One authority per task; replicas are records, never competing decision writers. */
export class CollaborationTaskService {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private preparing = new Map<string, Promise<void>>();
  constructor(private tasks: CollaborationTaskStore, private messages: CollaborationStore,
    private peers: CollaborationService, private deliver: (sessionId: string) => void, private prepareWorker?: PrepareTaskWorker) {}
  private get self() { return this.peers.descriptor().serviceId; }
  private group(groupId: string, actor: TaskMember | null, peer?: CollaborationNode) {
    const group = this.messages.getGroup(groupId);
    if (!group || group.deleted) throw new CollaborationError('TASK_GROUP_NOT_FOUND', '协作组不存在或无权访问', 404);
    if (actor && !group.sessionIds.includes(this.peers.taskSession(actor))) throw new CollaborationError('TASK_PERMISSION_DENIED', '成员不在该协作组', 403);
    if (peer) {
      const scope = this.peers.effectiveScope(peer.serviceId);
      if (!group.federated || !group.sessionIds.some(s => s.startsWith(`remote:${encodeURIComponent(peer.origin)}:`))
        || scope && !group.sessionIds.every(s => s.startsWith('remote:') || scope.includes(s))) {
        throw new CollaborationError('TASK_PERMISSION_DENIED', '来源服务无权访问此任务', 403);
      }
    }
    return group;
  }
  private validateMembers(groupId: string, input: TaskCreateInput | TaskOperation) {
    for (const member of [input.assignee, input.coordinator, ...('reviewers' in input ? input.reviewers ?? [] : [])]) if (member) this.group(groupId, member);
  }
  private view(task: CollaborationTask & { execution?: CollaborationTaskView['execution'] }, summary = false): CollaborationTaskView {
    const members = [...task.attempts.map(a => a.assignee), ...task.artifacts.map(a => a.actor),
      ...task.events.flatMap(e => [...(e.actor ? [e.actor] : []), ...(e.target ? [e.target] : [])]), ...(task.coordinator ? [task.coordinator] : []), ...(task.workflow?.reviewers ?? [])];
    const memberSessions: Record<string, string> = {};
    for (const member of members) try { memberSessions[taskMemberKey(member)] = this.peers.taskSession(member); } catch { /* Removed peer stays identifiable in history. */ }
    const children = this.tasks.children(task.id);
    const group = this.messages.getGroup(task.groupId);
    const roster = summary ? undefined : group?.sessionIds.map(sessionId => {
      const member = this.peers.taskMember(sessionId);
      const template = task.workflow?.reviewers.some(m => taskMemberKey(m) === taskMemberKey(member));
      return { member, sessionId, launchProfile: group.memberLaunchProfiles?.[sessionId], role: `${template ? '此目标的执行成员模板；' : ''}${group.roles?.[sessionId] ?? ''}` };
    });
    return { ...task, purpose: taskPurpose(task.purpose), ...(task.purpose === 'automation' ? { execution: task.execution ?? taskExecution(task) } : {}), children, roster, launchProfiles: summary ? undefined : group?.launchProfiles, defaultLaunchProfileId: summary ? undefined : group?.defaultLaunchProfileId, memberSessions, replica: task.ownerServiceId !== this.self, summaryOnly: summary, outbox: (summary ? [] : this.tasks.pending(task.id))
      .map(({ id, attemptId, messageId, lastError }) => ({ id, attemptId, messageId, lastError })) };
  }
  list(groupId: string, actor: TaskMember | null, purpose: unknown = 'all') {
    this.group(groupId, actor);
    const filter = taskPurposeFilter(purpose);
    return this.tasks.list([groupId], true).filter(task => filter === 'all' || taskPurpose(task.purpose) === filter).map(task => this.view(task, true));
  }
  async get(taskId: string, actor: TaskMember | null) {
    const task = this.tasks.get(taskId);
    if (!task) throw new CollaborationError('TASK_NOT_FOUND', '任务不存在', 404);
    this.group(task.groupId, actor);
    return this.view(task);
  }
  async create(input: TaskCreateInput, actor: TaskMember | null, origin?: TaskOrigin) {
    const group = this.group(input.groupId, actor); this.validateMembers(input.groupId, input);
    if (input.purpose === 'automation' && group.federated) throw new CollaborationError('BACKGROUND_TASK_LOCAL_ONLY', '首版后台自动化记录使用本机协作组', 409);
    const dependencies = [...(input.dependsOn ?? []), ...(input.parentTaskId ? [input.parentTaskId] : [])];
    const authority = dependencies.length ? this.tasks.get(dependencies[0])?.ownerServiceId : this.self;
    if (!authority) throw new CollaborationError('TASK_DEPENDENCY_NOT_FOUND', '父任务或依赖任务不存在', 404);
    for (const dependency of [...(input.dependsOn ?? []), ...(input.parentTaskId ? [input.parentTaskId] : [])]) {
      if (this.tasks.get(dependency)?.ownerServiceId !== authority) throw new CollaborationError('DEPENDENCY_AUTHORITY_REQUIRED', '依赖与父任务需在同一来源服务创建', 409);
    }
    if (origin && authority !== this.self) throw new CollaborationError('INTEGRATION_LOCAL_ONLY', '首版集成任务须由本机服务保存', 409);
    if (authority !== this.self) {
      const result = await this.peers.requestTasks(authority, { op: 'create', input, actorSessionId: actor?.sessionId ?? null });
      const task = result.task as CollaborationTask; this.tasks.merge(task, authority); return this.view(task);
    }
    const task = this.tasks.create(this.self, input, actor, origin); void this.flush(); return this.view(task);
  }
  async apply(taskId: string, input: TaskOperation, actor: TaskMember | null, origin?: TaskOrigin) {
    const task = this.tasks.get(taskId);
    if (!task) throw new CollaborationError('TASK_NOT_FOUND', '任务不存在', 404);
    const group = this.group(task.groupId, actor); this.validateMembers(task.groupId, input);
    if (input.kind === 'configure' && input.purpose === 'automation' && group.federated) throw new CollaborationError('BACKGROUND_TASK_LOCAL_ONLY', '首版后台自动化记录使用本机协作组', 409);
    if (origin && task.ownerServiceId !== this.self) throw new CollaborationError('INTEGRATION_LOCAL_ONLY', '首版集成任务须由本机服务保存', 409);
    if (task.ownerServiceId !== this.self) {
      const result = await this.peers.requestTasks(task.ownerServiceId, { op: 'apply', taskId, input, actorSessionId: actor?.sessionId ?? null });
      this.tasks.merge(result.task as CollaborationTask, task.ownerServiceId); return this.view(this.tasks.get(taskId)!);
    }
    if (input.kind === 'report' && input.status === 'complete' && task.workspace && task.workflow?.kind === 'step') {
      const attempt = task.attempts.find(a => a.id === input.attemptId);
      if (!actor || !attempt || taskMemberKey(attempt.assignee) !== taskMemberKey(actor) || attempt.id !== task.activeAttemptId) throw new CollaborationError('ATTEMPT_PERMISSION_DENIED', '只有当前执行成员可以提交完成报告', 403);
      const commit = actor.serviceId === this.self ? await captureTaskCommit(task.workspace)
        : (await this.peers.requestTasks(actor.serviceId, { op: 'commit', taskId: task.id })).commit;
      if (!commit || !/^[a-f0-9]{40,64}$/.test(commit.commit) || commit.cwd !== task.workspace.cwd || commit.branch !== task.workspace.branch) throw new CollaborationError('INVALID_COMMIT_RECEIPT', '交付提交凭证与执行目录不符');
      input = { ...input, evidence: { memberEvidence: input.evidence, ...commit } };
    }
    if (input.kind === 'review' && input.verdict === 'pass' && task.workspace && task.workflow) {
      const artifact = task.artifacts.find(a => a.id === input.artifactId);
      const source = task.attempts.find(a => a.id === task.activeAttemptId)!.assignee.serviceId;
      const commit = source === this.self ? await captureTaskCommit(task.workspace)
        : (await this.peers.requestTasks(source, { op: 'commit', taskId: task.id })).commit;
      if (commit?.commit !== (artifact?.evidence as { commit?: string } | undefined)?.commit) throw new CollaborationError('RESULT_CHANGED', '代码在交付后发生变化，请执行成员重新提交结果再评审', 409);
    }
    if (input.kind === 'report' && input.status === 'complete' && task.workflow?.kind === 'goal') {
      const children = this.tasks.list([task.groupId]).filter(t => t.workflow?.rootTaskId === task.id && t.status === 'accepted');
      input = { ...input, evidence: { memberEvidence: input.evidence, deliveries: children.map(child => ({ taskId: child.id, title: child.title,
        artifactId: child.acceptedArtifactId, integration: child.workflow?.integration === true,
        commit: (child.artifacts.find(a => a.id === child.acceptedArtifactId)?.evidence as { commit?: string } | undefined)?.commit })) } };
    }
    const updated = this.tasks.apply(taskId, input, actor, origin); if (input.kind !== 'configure') void this.flush(); return this.view(updated);
  }
  heads(groupIds: string[]) { return this.tasks.heads(groupIds, this.self); }
  async dependencyChunk(taskId: string, dependencyId: string, offset: unknown, targetService = this.self): Promise<Record<string, any>> {
    const current = this.tasks.get(taskId), dependency = this.tasks.get(dependencyId);
    const target = current?.scheduledAssignee ?? current?.attempts.find(a => a.id === current.activeAttemptId)?.assignee;
    if (!current || current.ownerServiceId !== this.self || target?.serviceId !== targetService || !dependency
      || dependency.status !== 'accepted' || dependency.ownerServiceId !== this.self || !current.dependsOn.includes(dependency.id)) throw new CollaborationError('TASK_PERMISSION_DENIED', '仅执行服务可以读取此任务依赖的已评审提交', 403);
    const source = dependency.attempts.find(a => a.id === dependency.activeAttemptId)!.assignee.serviceId;
    return source === this.self ? { chunk: await taskBundleChunk(dependency, offset) }
      : this.peers.requestTasks(source, { op: 'bundle-chunk', task: dependency, offset });
  }
  async sync(peer: CollaborationNode, heads: unknown[]) {
    if (heads.length > 2000) throw new CollaborationError('INVALID_TASK_SNAPSHOT', '远端任务列表过长');
    let fetched = 0;
    for (const raw of heads) {
      const head = raw as { id: string; revision: number };
      if (!head || !/^[a-f0-9]{32}$/.test(head.id) || !Number.isSafeInteger(head.revision)) continue;
      const current = this.tasks.get(head.id);
      if (current && current.revision >= head.revision) continue;
      if (++fetched > 8) break;
      try {
        const result = await this.peers.requestTasks(peer.serviceId, { op: 'get', taskId: head.id });
        const task = result.task as CollaborationTask; this.group(task.groupId, null, peer); this.tasks.merge(task, peer.serviceId);
      } catch { /* A failed task fetch must not turn a reachable terminal directory offline. */ }
    }
  }
  async receive(peer: CollaborationNode, packet: Packet): Promise<Record<string, unknown>> {
    const actor = packet.actorSessionId === null || packet.actorSessionId === undefined ? null : { serviceId: peer.serviceId, sessionId: String(packet.actorSessionId) };
    if (packet.op === 'create') {
      const input = packet.input as TaskCreateInput;
      this.group(input.groupId, actor, peer); this.validateMembers(input.groupId, input);
      const dependencies = [...(input.dependsOn ?? []), ...(input.parentTaskId ? [input.parentTaskId] : [])];
      if (!dependencies.length || dependencies.some(id => this.tasks.get(id)?.ownerServiceId !== this.self)) throw new CollaborationError('DEPENDENCY_AUTHORITY_REQUIRED', '来源服务必须拥有父任务或依赖任务', 409);
      const created = this.tasks.create(this.self, input, actor); void this.flush(); return { task: created };
    }
    if (packet.op === 'deliver') {
      const task = packet.task as CollaborationTask;
      if (!task || task.ownerServiceId !== peer.serviceId) throw new CollaborationError('INVALID_TASK_OWNER', '只有任务来源服务可以投递');
      const group = this.group(task.groupId, null, peer);
      const recipient = { serviceId: this.self, sessionId: String(packet.target ?? '') };
      this.group(task.groupId, recipient, peer);
      const attempt = task.attempts.find(a => a.id === packet.attemptId);
      if (packet.kind === 'task' ? !attempt || taskMemberKey(attempt.assignee) !== taskMemberKey(recipient) : packet.attemptId !== null && !attempt) throw new CollaborationError('INVALID_ATTEMPT', '投递对象与执行尝试不符');
      this.tasks.merge(task, peer.serviceId);
      const previous = typeof packet.messageId === 'string' ? this.messages.getMessage(packet.messageId) : null;
      if (previous && previous.groupId === task.groupId && previous.toSessionId === recipient.sessionId
        && previous.fromSessionId === null && previous.content === packet.content && previous.metadata?.taskOutboxId === packet.outboxId) {
        this.deliver(recipient.sessionId); return { receipt: this.receipt(previous.id) };
      }
      const queued = this.messages.send({ groupId: group.id, fromSessionId: null, toSessionIds: [recipient.sessionId],
        kind: packet.kind === 'task' ? 'task' : 'message', content: String(packet.content ?? ''), threadId: attempt?.threadId ?? task.id,
        idempotencyKey: `task:${peer.serviceId}:${String(packet.outboxId)}`,
        metadata: { taskOutboxId: packet.outboxId, termdockTask: { taskId: task.id, attemptId: attempt?.id ?? null, ownerServiceId: peer.serviceId, replyToEventId: task.events.find(e => e.deliveryId === packet.outboxId && e.attemptId === attempt?.id && e.kind === 'comment')?.id } } });
      this.deliver(recipient.sessionId);
      return { receipt: this.receipt(queued[0].id) };
    }
    if (packet.op === 'prepare') {
      const task = packet.task as CollaborationTask;
      if (!task || task.ownerServiceId !== peer.serviceId || !task.workflow?.isolated || !task.scheduledAssignee || task.scheduledAssignee.serviceId !== this.self) throw new CollaborationError('INVALID_TASK_OWNER', '执行准备请求来源或成员无效');
      this.group(task.groupId, task.scheduledAssignee, peer); this.tasks.merge(task, peer.serviceId);
      if (this.peers.effectiveScope(peer.serviceId) !== undefined) throw new CollaborationError('SESSION_SCOPE_DENIED', '会话范围授权不能自动创建新成员，请使用现有会话或完整协作授权', 403);
      if (!this.prepareWorker) throw new CollaborationError('WORKSPACE_UNAVAILABLE', '目标服务不支持独立执行目录');
      const dependencies = Array.isArray(packet.dependencies) ? packet.dependencies as CollaborationTask[] : [];
      if (dependencies.length > 32 || dependencies.length !== task.dependsOn.length || dependencies.some(d => d.ownerServiceId !== peer.serviceId || d.groupId !== task.groupId || d.status !== 'accepted' || !task.dependsOn.includes(d.id))) throw new CollaborationError('INVALID_DEPENDENCIES', '依赖交付记录无效');
      for (const dependency of dependencies) this.tasks.merge(dependency, peer.serviceId);
      const prepared = await this.prepareWorker(task, task.scheduledAssignee, dependencies);
      return { ...prepared, member: { serviceId: this.self, sessionId: prepared.sessionId } };
    }
    if (packet.op === 'commit') {
      const task = this.tasks.get(String(packet.taskId));
      if (!task || task.ownerServiceId !== peer.serviceId || !task.workspace) throw new CollaborationError('TASK_NOT_FOUND', '执行目录记录不存在', 404);
      this.group(task.groupId, null, peer);
      return { commit: await captureTaskCommit(task.workspace) };
    }
    if (packet.op === 'bundle-chunk') {
      const task = packet.task as CollaborationTask;
      const previous = task && this.tasks.get(task.id);
      if (!task || task.ownerServiceId !== peer.serviceId || !task.workspace || previous?.workspace?.cwd !== task.workspace.cwd
        || task.attempts.find(a => a.id === task.activeAttemptId)?.assignee.serviceId !== this.self) throw new CollaborationError('INVALID_TASK_OWNER', '只能导出此服务执行的已评审交付');
      this.group(task.groupId, null, peer); this.tasks.merge(task, peer.serviceId);
      return { chunk: await taskBundleChunk(task, packet.offset) };
    }
    if (packet.op === 'dependency-bundle') {
      const current = this.tasks.get(String(packet.taskId));
      if (!current) throw new CollaborationError('TASK_NOT_FOUND', '执行任务不存在', 404);
      this.group(current.groupId, null, peer);
      return this.dependencyChunk(current.id, String(packet.dependencyId), packet.offset, peer.serviceId);
    }
    const task = this.tasks.get(String(packet.taskId ?? ''));
    if (!task || task.ownerServiceId !== this.self) throw new CollaborationError('TASK_NOT_FOUND', '来源任务不存在', 404);
    this.group(task.groupId, actor, peer);
    if (packet.op === 'get') return { task: this.view(task) };
    if (packet.op === 'apply') {
      const input = packet.input as TaskOperation; this.validateMembers(task.groupId, input);
      return { task: await this.apply(task.id, input, actor) };
    }
    throw new CollaborationError('INVALID_TASK_OPERATION', '不支持的远端任务操作');
  }
  private receipt(messageId: string) {
    const receipt = this.messages.receipt(messageId);
    return { messageId, status: receipt.status, deliveredAt: receipt.delivered_at, error: receipt.delivery.error };
  }
  start() { this.timer = setInterval(() => void this.flush(), 1500); this.timer.unref(); void this.flush(); }
  close() { clearInterval(this.timer); }
  private async flush() {
    if (this.running) return; this.running = true;
    try {
      this.tasks.advance(this.self);
      const owned = this.tasks.owned(this.self);
      const slots = new Map(owned.filter(t => t.workflow?.kind === 'goal').map(root => [root.id,
        Math.max(0, (root.workflow!.maxParallel ?? 2) - owned.filter(t => t.workflow?.rootTaskId === root.id && t.status === 'open' && (!!t.activeAttemptId || this.preparing.has(t.id))).length)]));
      for (const task of this.tasks.scheduled(this.self)) {
        if (this.preparing.has(task.id) || this.preparing.size >= 4 || (slots.get(task.workflow!.rootTaskId!) ?? 0) <= 0) continue;
        slots.set(task.workflow!.rootTaskId!, slots.get(task.workflow!.rootTaskId!)! - 1);
        const prepare = Promise.resolve().then(async () => { try {
          this.group(task.groupId, task.scheduledAssignee!);
          let assignee = task.scheduledAssignee!, workspace: TaskWorkspace | undefined;
          if (task.workflow!.isolated) {
            const dependencies = task.dependsOn.map(id => this.tasks.get(id)!);
            if (assignee.serviceId === this.self) {
              if (!this.prepareWorker) throw new Error('此服务不支持独立执行目录');
              const prepared = await this.prepareWorker(task, assignee, dependencies);
              assignee = { serviceId: this.self, sessionId: prepared.sessionId }; workspace = prepared.workspace;
            } else {
              const prepared = await this.peers.requestTasks(assignee.serviceId, { op: 'prepare', task, dependencies });
              assignee = prepared.member as TaskMember; workspace = prepared.workspace as TaskWorkspace;
              if (!assignee || assignee.serviceId !== task.scheduledAssignee!.serviceId || !workspace) throw new Error('远端执行目录准备记录无效');
              await this.peers.refresh();
            }
            this.group(task.groupId, assignee);
          }
          this.tasks.activateScheduled(task.id, task.revision, assignee, workspace);
        } catch (error) { this.tasks.automationFailed(task.id, error instanceof Error ? error.message : String(error)); }
        finally { this.preparing.delete(task.id); } });
        this.preparing.set(task.id, prepare);
      }
      const ready = this.tasks.pending(undefined, true).filter(outbox => {
        const task = this.tasks.get(outbox.taskId); if (!task?.workflow) return true;
        const root = task.workflow.rootTaskId ? this.tasks.get(task.workflow.rootTaskId) : task;
        const consultation = outbox.replyToEventId && task.events.some(e => e.id === outbox.replyToEventId && e.kind === 'comment');
        return consultation || !task.workflow.paused && !root?.workflow?.paused && root?.status === 'open';
      }).slice(0, 16);
      for (const outbox of ready) {
        try {
          const task = this.tasks.get(outbox.taskId)!; this.group(task.groupId, outbox.target);
          const root = task.workflow?.rootTaskId ? this.tasks.get(task.workflow.rootTaskId) : task;
          const consultation = outbox.replyToEventId && task.events.some(e => e.id === outbox.replyToEventId && e.kind === 'comment');
          if (task.workflow && !consultation && (task.workflow.paused || root?.workflow?.paused || root?.status !== 'open')) continue;
          if (outbox.target.serviceId === this.self) {
            if (outbox.messageId && this.messages.getMessage(outbox.messageId)) {
              this.deliver(outbox.target.sessionId); this.tasks.delivered(outbox.id, this.receipt(outbox.messageId)); continue;
            }
            const queued = this.messages.send({ groupId: task.groupId, fromSessionId: null, toSessionIds: [outbox.target.sessionId],
              kind: outbox.kind, content: outbox.content, threadId: outbox.threadId, idempotencyKey: `task:${this.self}:${outbox.id}`,
              metadata: { termdockTask: { taskId: task.id, attemptId: outbox.attemptId, ownerServiceId: this.self, replyToEventId: outbox.replyToEventId } } });
            this.deliver(outbox.target.sessionId); this.tasks.delivered(outbox.id, this.receipt(queued[0].id));
          } else {
            const result = await this.peers.requestTasks(outbox.target.serviceId, { op: 'deliver', task, target: outbox.target.sessionId,
              attemptId: outbox.attemptId, content: outbox.content, kind: outbox.kind, outboxId: outbox.id, messageId: outbox.messageId });
            this.tasks.delivered(outbox.id, result.receipt);
          }
        } catch (error) { this.tasks.failed(outbox.id, error instanceof Error ? error.message : String(error)); }
      }
    } catch (error) { console.error('[collaboration-tasks] queue persistence failed:', error instanceof Error ? error.message : String(error)); }
    finally { this.running = false; }
  }
}
