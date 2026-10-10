import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { collaborationResultPresentation } from './collaborationResultPresentation.js';
import { CollaborationError } from './collaborationProtocol.js';
import { taskMemberKey, type CollaborationTask, type CollaborationTaskEvent, type TaskCreateInput, type TaskMember, type TaskOperation, type TaskOutbox, type TaskWorkspace, type TaskWorkflow, type TaskOrigin } from './collaborationTaskTypes.js';

interface TaskDocument {
  version: 1; tasks: CollaborationTask[]; outbox: TaskOutbox[];
  requests: Record<string, { hash: string; taskId: string; eventId?: string }>;
}
const id = () => randomBytes(16).toString('hex');
const codeSteps = (tasks: CollaborationTask[], rootId: string) => tasks.filter(t => {
  if (t.workflow?.rootTaskId !== rootId || !t.workflow.isolated || t.workflow.workType === 'read-only' || t.workflow.integration || t.status === 'closed') return false;
  const accepted = t.artifacts.find(artifact => artifact.id === t.acceptedArtifactId);
  const commit = (accepted?.evidence as { commit?: string } | undefined)?.commit;
  // The service captures the worktree commit. A reviewed HEAD equal to its base
  // proves there is no code delta to integrate, including legacy query tasks.
  return !(t.status === 'accepted' && t.workspace && commit === t.workspace.base);
});
const sameMember = (a: TaskMember | null, b: TaskMember | null) => a !== null && b !== null && taskMemberKey(a) === taskMemberKey(b);
function text(value: unknown, name: string, limit = 32_000, required = false): string {
  if (value !== undefined && typeof value !== 'string') throw new CollaborationError('INVALID_TASK', `${name}必须是文本`);
  const result = typeof value === 'string' ? value.trim() : '';
  if (Buffer.byteLength(result) > limit || required && !result) throw new CollaborationError('INVALID_TASK', `${name}${required ? '不能为空，且' : ''}最多 ${limit} 字节`);
  return result;
}
function member(value: unknown): TaskMember {
  const m = value as TaskMember;
  if (!m || typeof m.serviceId !== 'string' || !/^12D3KooW[a-zA-Z0-9]{30,60}$/.test(m.serviceId)
    || typeof m.sessionId !== 'string' || !m.sessionId || m.sessionId.length > 256 || m.sessionId.startsWith('remote:')) {
    throw new CollaborationError('INVALID_MEMBER', '成员身份无效，请重新选择');
  }
  return { serviceId: m.serviceId, sessionId: m.sessionId };
}
const stable = (value: unknown) => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
function validateSnapshot(task: CollaborationTask): void {
  const validId = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
  const time = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  const reportStatus = (value: unknown) => ['ack', 'working', 'blocked', 'complete', 'failed'].includes(String(value));
  const invalid = () => { throw new CollaborationError('INVALID_TASK_SNAPSHOT', '远端任务记录无效'); };
  if (!task || !validId(task.id) || typeof task.groupId !== 'string' || !task.groupId || !time(task.createdAt) || !time(task.updatedAt)
    || !Number.isSafeInteger(task.revision) || task.revision < 1 || !['open', 'accepted', 'closed'].includes(task.status)
    || task.activeAttemptId !== null && !validId(task.activeAttemptId) || task.parentTaskId !== null && !validId(task.parentTaskId)
    || !Array.isArray(task.dependsOn) || task.dependsOn.length > 32 || task.dependsOn.some(v => !validId(v))
    || !Array.isArray(task.attempts) || task.attempts.length > 100 || !Array.isArray(task.events) || task.events.length > 1000
    || !Array.isArray(task.decisions) || task.decisions.length > 1000 || !Array.isArray(task.artifacts) || task.artifacts.length > 200
    || !Array.isArray(task.deliveries) || task.deliveries.length > 2000 || Buffer.byteLength(JSON.stringify(task)) > 512_000) invalid();
  text(task.title, '标题', 640, true); text(task.spec, '任务内容', 32_000, true); text(task.constraints, '约束'); text(task.acceptance, '完成标准');
  member({ serviceId: task.ownerServiceId, sessionId: 'validation' });
  if (task.coordinator !== null) member(task.coordinator);
  if (task.workflow) {
    if (task.workflow.workType !== undefined && (!['auto', 'code', 'read-only'].includes(task.workflow.workType) || task.workflow.workType === 'auto' && task.workflow.kind !== 'goal')) invalid();
    if (!['goal', 'step'].includes(task.workflow.kind) || typeof task.workflow.paused !== 'boolean' || typeof task.workflow.isolated !== 'boolean'
      || !Array.isArray(task.workflow.reviewers) || task.workflow.reviewers.length > 32 || !Number.isInteger(task.workflow.maxRevisions)
      || task.workflow.maxRevisions < 1 || task.workflow.maxRevisions > 10 || task.workflow.rootTaskId && !validId(task.workflow.rootTaskId)) invalid();
    if (task.workflow.maxParallel !== undefined && (!Number.isInteger(task.workflow.maxParallel) || task.workflow.maxParallel < 1 || task.workflow.maxParallel > 4)) invalid();
    task.workflow.reviewers.forEach(member);
  }
  if (task.scheduledAssignee) member(task.scheduledAssignee);
  if (task.workspace && [task.workspace.cwd, task.workspace.repository, task.workspace.branch, task.workspace.base].some(v => typeof v !== 'string' || !v || v.length > 4096)) invalid();
  for (const attempt of task.attempts) {
    if (!attempt || !validId(attempt.id) || !validId(attempt.threadId) || !time(attempt.createdAt)) invalid();
    member(attempt.assignee);
    if (attempt.report && (!reportStatus(attempt.report.status) || !time(attempt.report.createdAt) || typeof attempt.report.content !== 'string')) invalid();
  }
  if (task.activeAttemptId && !task.attempts.some(a => a.id === task.activeAttemptId)) invalid();
  for (const event of task.events) {
    if (!event || !validId(event.id) || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || typeof event.kind !== 'string'
      || typeof event.content !== 'string' || !time(event.createdAt) || event.attemptId !== null && !task.attempts.some(a => a.id === event.attemptId)) invalid();
    if (event.deliveryId !== undefined && !validId(event.deliveryId)) invalid();
    if (event.source !== undefined && !['system', 'user', 'integration'].includes(event.source)) invalid();
    if (event.actor !== null) member(event.actor);
    if (event.target) member(event.target);
  }
  for (const decision of task.decisions) {
    if (!decision || !validId(decision.id) || typeof decision.question !== 'string' || !time(decision.createdAt)
      || !task.attempts.some(a => a.id === decision.attemptId) || !['pending', 'answered', 'superseded'].includes(decision.status)
      || !Array.isArray(decision.options) || decision.options.length > 8 || decision.options.some(o => typeof o !== 'string')
      || decision.status === 'answered' && (typeof decision.answer !== 'string' || !time(decision.answeredAt))) invalid();
  }
  for (const artifact of task.artifacts) {
    if (!artifact || !validId(artifact.id) || !task.attempts.some(a => a.id === artifact.attemptId) || !['plan', 'result', 'review'].includes(artifact.kind)
      || typeof artifact.content !== 'string' || !time(artifact.createdAt)) invalid();
    text(artifact.summary, '结果摘要', 2400);
    member(artifact.actor);
    if (artifact.verdict && !['pass', 'changes', 'blocked'].includes(artifact.verdict)) invalid();
  }
  for (const delivery of task.deliveries) if (!delivery || !validId(delivery.id) || typeof delivery.messageId !== 'string'
    || typeof delivery.status !== 'string' || delivery.error !== null && typeof delivery.error !== 'string'
    || delivery.attemptId !== null && !task.attempts.some(a => a.id === delivery.attemptId)) invalid();
}

/** Atomic document writes keep decisions and their outgoing messages in one transaction. */
export class CollaborationTaskStore {
  private listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  snapshot(): CollaborationTask[] { return structuredClone(this.document.tasks); }
  private document: TaskDocument = { version: 1, tasks: [], outbox: [], requests: {} };
  constructor(private file: string) {
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8')) as TaskDocument;
      if (doc.version !== 1 || !Array.isArray(doc.tasks) || !Array.isArray(doc.outbox) || !doc.requests) throw new Error('任务记录格式无效');
      this.document = doc;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private transaction<T>(mutate: (doc: TaskDocument) => T, origin?: TaskOrigin): T {
    const next = structuredClone(this.document);
    const result = mutate(next);
    if (origin) {
      const previous = new Set(this.document.tasks.flatMap(t => t.events.map(e => e.id)));
      for (const task of next.tasks) for (const event of task.events) if (!previous.has(event.id) && event.actor === null && event.source !== 'system') { event.source = 'integration'; event.origin = structuredClone(origin); }
    }
    if (next.tasks.some(task => Buffer.byteLength(JSON.stringify(task)) > 512_000)) throw new CollaborationError('TASK_HISTORY_LIMIT', '此任务记录达到 500 KiB，请建立后续任务并保留本任务为历史', 409);
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized) > 64 * 1024 * 1024) throw new CollaborationError('TASK_STORAGE_FULL', '任务记录已达到保存上限，请导出历史后整理', 409);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, serialized, { mode: 0o600 }); renameSync(temporary, this.file);
    this.document = next;
    for (const listener of this.listeners) { try { listener(); } catch { /* Durable sources allow the integration journal to retry. */ } }
    return structuredClone(result);
  }
  integrationRequestEvent(principalId: string, key: string, taskId: string): CollaborationTaskEvent | undefined {
    const request = this.document.requests[`integration:${principalId}:${key}`];
    return request?.taskId === taskId ? structuredClone(this.document.tasks.find(t => t.id === taskId)?.events.find(e => e.id === request.eventId)) : undefined;
  }
  get(taskId: string): CollaborationTask | null { return structuredClone(this.document.tasks.find(t => t.id === taskId) ?? null); }
  owned(owner: string): CollaborationTask[] { return structuredClone(this.document.tasks.filter(t => t.ownerServiceId === owner)); }
  children(taskId: string) {
    return structuredClone(this.document.tasks.filter(t => t.parentTaskId === taskId || t.workflow?.rootTaskId === taskId)
      .map(({ id, title, status, revision, completionMode, workspace }) => ({ id, title, status, revision, completionMode, workspace })));
  }
  list(groupIds: string[], summary = false): CollaborationTask[] {
    const tasks = this.document.tasks.filter(t => groupIds.includes(t.groupId)).sort((a, b) => b.updatedAt - a.updatedAt);
    return structuredClone(tasks.map(task => {
      if (!summary) return task;
      const current = task.attempts.find(a => a.id === task.activeAttemptId);
      const result = task.artifacts.filter(a => a.kind === 'result' && a.attemptId === task.activeAttemptId).at(-1);
      const plan = task.artifacts.filter(a => a.kind === 'plan' && a.attemptId === task.activeAttemptId).at(-1);
      const reportSummary = current?.report?.content.split(/\n\s*\n/).map(paragraph => paragraph.split('\n').filter(line => !/^#{1,6}\s/.test(line)).join('\n').trim()).find(Boolean)?.slice(0, 512);
      const automationIssueSource = task.automationIssue ? current?.report && ['blocked', 'failed'].includes(current.report.status)
        && task.automationIssue === current.report.content.slice(0, 1000) ? 'member-report' as const : 'system' as const : undefined;
      return { ...task, automationIssueSource, spec: task.spec.slice(0, 512), constraints: '', acceptance: '',
        deliveries: task.deliveries.filter(d => d.attemptId === task.activeAttemptId && d.error).slice(-1),
        attempts: current ? [{ ...current, report: current.report ? { ...current.report, summary: reportSummary, content: '', evidence: undefined } : undefined }] : [],
        artifacts: [plan, result, ...task.artifacts.filter(a => a.kind === 'review' && a.reviewsArtifactId === result?.id)].filter((a): a is NonNullable<typeof a> => !!a).map(a => ({ ...a, content: '', summary: (a.summary || (a.kind === 'result' && collaborationResultPresentation(a.content).condensed ? collaborationResultPresentation(a.content).summary : undefined))?.slice(0, 800), evidence: undefined })),
        decisions: task.decisions.filter(d => d.status === 'pending').map(d => ({ ...d, question: d.question.slice(0, 512), options: [] })),
        events: task.events.filter(e => ['revise', 'request-review'].includes(e.kind) && e.attemptId === task.activeAttemptId).slice(-4).map(e => ({ ...e, content: ['user', 'integration'].includes(e.source ?? '') && e.kind === 'revise' ? e.content.slice(0, 512) : '' })) };
    }));
  }
  heads(groupIds: string[], owner: string) { return this.document.tasks.filter(t => groupIds.includes(t.groupId) && t.ownerServiceId === owner).map(t => ({ id: t.id, revision: t.revision })); }
  pending(taskId?: string, dueOnly = false): TaskOutbox[] { return structuredClone(this.document.outbox
    .filter(o => (!taskId || o.taskId === taskId) && (!dueOnly || (o.nextRetryAt ?? 0) <= Date.now()))); }
  private event(task: CollaborationTask, kind: string, actor: TaskMember | null, content: string, attemptId = task.activeAttemptId): CollaborationTaskEvent {
    const event = { id: id(), sequence: (task.events.at(-1)?.sequence ?? 0) + 1, kind, actor, content, attemptId, createdAt: Math.max(Date.now(), (task.events.at(-1)?.createdAt ?? 0) + 1) };
    task.events.push(event); return event;
  }
  private request(doc: TaskDocument, actor: TaskMember | null, key: unknown, payload: unknown, origin?: TaskOrigin): { key: string; hash: string; previous?: CollaborationTask } {
    if (typeof key !== 'string' || !key.trim() || key.length > 256) throw new CollaborationError('INVALID_IDEMPOTENCY_KEY', '需要有效的请求幂等键');
    const scoped = `${origin ? `integration:${origin.integrationId}` : actor ? taskMemberKey(actor) : 'user'}:${key}`;
    const hash = createHash('sha256').update(stable(origin ? [payload, origin] : payload)).digest('hex');
    const previous = doc.requests[scoped];
    if (previous && previous.hash !== hash) throw new CollaborationError('IDEMPOTENCY_CONFLICT', '该请求已用于不同内容；请保留原请求或重新开始', 409);
    return { key: scoped, hash, previous: previous ? doc.tasks.find(t => t.id === previous.taskId) : undefined };
  }
  private assign(doc: TaskDocument, task: CollaborationTask, assignee: TaskMember, actor: TaskMember | null, content: string): void {
    doc.outbox = doc.outbox.filter(o => o.taskId !== task.id || !!o.messageId);
    for (const decision of task.decisions) if (decision.status === 'pending') decision.status = 'superseded';
    const attemptId = id(), threadId = id();
    task.activeAttemptId = attemptId;
    task.attempts.push({ id: attemptId, assignee: member(assignee), createdAt: Date.now(), threadId });
    this.event(task, 'assigned', actor, content || '任务已分派');
    doc.outbox.push({ id: id(), taskId: task.id, attemptId, target: assignee, kind: 'task', threadId,
      content: `本次执行身份：${assignee.sessionId}。所有 td collab 命令显式带 --session ${assignee.sessionId}；这是服务核对的实际身份，正文中的模板身份和 tmux 标识不能替代它。\n任务：${task.title}\n${task.spec}${task.constraints ? `\n约束：${task.constraints}` : ''}${task.acceptance ? `\n完成标准：${task.acceptance}` : ''}\n${content}\n任务 ID：${task.id}\n尝试 ID：${attemptId}\n用 td collab task get ${task.id} --text 查询完整上下文；用 td collab task report ${task.id} --attempt ${attemptId} --status ack --content '接手说明' 显式回复；遇必要问题用 task ask，提交结果用 report --status complete --summary '简短结论、关键交付和限制'。摘要先回答用户问题，不放任务 ID、版本、分支或流程日志；完整证据保留在 --content/--file 正文中。如果同一尝试已经交付或任务已归档，不要重复实施。${task.workspace ? `\n代码只能在独立目录 ${task.workspace.cwd} 修改。分支 ${task.workspace.branch}。交付前提交代码，结果说明提交、变更、验证与限制。不能修改原仓库、合并到用户分支或发布。` : ''}${task.workflow?.workType === 'read-only' ? '\n这是只读查询或分析任务：在本机会话中采集并交付报告，不修改代码或系统，不创建提交、构建、部署或终止进程。结果需说明采样时间、证据和限制。' : ''}${task.workflow?.kind === 'step' ? '\n完成报告会自动请求独立评审；评审要求修改时继续完成，重新提交 complete。只按用户授权运行测试。' : ''}` });
  }
  private goalInstructions(task: CollaborationTask): string {
    return `你是此目标的协调者，负责把目标推进到可验收交付，不亲自实施子任务。\n目标：${task.spec}\n约束：${task.constraints || '未补充'}\n完成标准：${task.acceptance || '满足用户目标，说明交付与限制'}\n任务 ID：${task.id}\n当前协调身份：${task.coordinator?.sessionId}；所有命令显式带 --session ${task.coordinator?.sessionId}，不使用 tmux 标识。\n用 td collab task get ${task.id} --json 读取 roster、子任务、完整记录和 revision。\n先报告 ack；拆分为可交付子任务，用 td collab task create --group ${task.groupId} --parent ${task.id} --title '标题' --content '完整要求' --assignee <roster里的成员sessionId> --acceptance '明确标准' --work-type read-only|code。先按目标明确分类：查询、检查、研究、分析用 read-only，复用现有执行成员会话，不创建 Git 目录；修改代码用 code，才创建独立目录。简单问题只建一个必要任务，不为了形式拆成采集、复述、汇总多份任务。子任务继承自动评审与协调者。依赖任务用 --depends-on id,id，服务在依赖评审通过后自动分派。保持分工合理，不根据终端输出推断谁有空。\n每次收到明确更新后读取最新记录，处理失败与交接。服务自动安排独立评审、返工和依赖接续；不要重复请求评审或催促正在等待回复的成员。必要的人类决策用 task ask --attempt <本轮id>；方案需要用户确认时提交 task plan，不把普通回复当授权。\n只有已交付代码任务实际包含相对 base 的提交变化时，才需创建 --work-type code --integration 的最终集成子任务，--depends-on 依赖全部代码实施任务；独立目录会包含依赖的提交。不得在原仓库自动合并或发布。\n结束本次协调用 td collab task coordinate ${task.id} --revision <最新版本> --content '已安排的工作和下一步'；有新事件服务会再次唤起你。所有子任务评审通过后报告 complete --summary '直接回答用户的简短结果和限制'；只读目标直接汇总已核对结果，不创建集成或重复汇总任务。正文保留证据、评审结论和限制，仅代码目标补充目录、分支和提交，等待用户最终验收。任何异常都要留下明确说明，不伪造完成或进度。`;
  }
  private notifyCoordinator(doc: TaskDocument, task: CollaborationTask, update?: CollaborationTaskEvent): void {
    if (!task.coordinator) return;
    if (task.workflow) return; // Managed goals are woken once per persisted event set by advance().
    const attempt = task.attempts.find(a => a.id === task.activeAttemptId);
    if (update ? sameMember(task.coordinator, update.actor) : attempt && sameMember(task.coordinator, attempt.assignee)) return;
    if (update && ['answer', 'revise'].includes(update.kind) && attempt && sameMember(task.coordinator, attempt.assignee)) return;
    if (update) {
      doc.outbox.push({ id: id(), taskId: task.id, attemptId: attempt?.id ?? null, target: task.coordinator, kind: 'message', threadId: attempt?.threadId ?? task.id,
        content: `协调任务「${task.title}」有明确更新：${update.kind}${update.reportStatus ? ` / ${update.reportStatus}` : ''}\n原始记录时间：${new Date(update.createdAt).toISOString()}\n${update.attemptId && update.attemptId !== task.activeAttemptId ? '这是历史分派的报告，请先核对当前任务。\n' : ''}${update.content.slice(0, 4000)}\n任务 ID：${task.id}\n用 td collab task get ${task.id} --text 查看完整原文与当前版本；问题回答与结果验收由用户决定。` });
      return;
    }
    doc.outbox.push({ id: id(), taskId: task.id, attemptId: attempt?.id ?? null, target: task.coordinator, kind: 'message', threadId: attempt?.threadId ?? task.id,
      content: `你被指定为任务「${task.title}」的协调者。\n目标：${task.spec}\n约束：${task.constraints || '未补充'}\n验收标准：${task.acceptance || '由用户决定'}\n任务 ID：${task.id}\n用 td collab task get ${task.id} --text 查看原始记录；用 task list --group ${task.groupId} 查看工作组。需要拆分时用 task create --group ${task.groupId} --parent ${task.id} --title '子任务标题' --content '任务内容'。分派前查询 revision，再用 task assign --revision；把必要的人类决策交给 task ask，不推断成员忙闲，不停止其他成员终端。` });
  }
  create(owner: string, input: TaskCreateInput, actor: TaskMember | null, origin?: TaskOrigin): CollaborationTask {
    const title = text(input.title, '标题', 640, true), spec = text(input.spec, '任务内容', 32_000, true);
    const constraints = text(input.constraints, '约束'), acceptance = text(input.acceptance, '完成标准');
    if (input.dependsOn !== undefined && (!Array.isArray(input.dependsOn) || input.dependsOn.length > 32 || input.dependsOn.some(v => typeof v !== 'string'))) throw new CollaborationError('INVALID_DEPENDENCIES', '依赖列表无效');
    if (input.coordinator) member(input.coordinator);
    if (input.assignee) member(input.assignee);
    if (input.managed !== undefined && typeof input.managed !== 'boolean' || input.isolated !== undefined && typeof input.isolated !== 'boolean'
      || input.integration !== undefined && typeof input.integration !== 'boolean') throw new CollaborationError('INVALID_WORKFLOW', '协作模式无效');
    if (input.workType !== undefined && !['code', 'read-only'].includes(input.workType)) throw new CollaborationError('INVALID_WORK_TYPE', '任务类型必须是 code 或 read-only');
    if (input.integration && input.workType === 'read-only') throw new CollaborationError('INVALID_WORK_TYPE', '只读任务不需要代码集成');
    if (input.reviewers && (!Array.isArray(input.reviewers) || input.reviewers.length > 32)) throw new CollaborationError('INVALID_REVIEWERS', '评审成员列表无效');
    input.reviewers?.forEach(member);
    return this.transaction(doc => {
      const request = this.request(doc, actor, input.idempotencyKey, input, origin);
      if (request.previous) return request.previous;
      if (doc.tasks.length >= 2000) throw new CollaborationError('TASK_LIMIT', '任务记录达到上限，请导出并整理历史', 409);
      const dependsOn = [...new Set(input.dependsOn ?? [])];
      for (const dependency of [...dependsOn, ...(input.parentTaskId ? [input.parentTaskId] : [])]) {
        if (!doc.tasks.some(t => t.id === dependency && t.groupId === input.groupId)) throw new CollaborationError('TASK_DEPENDENCY_NOT_FOUND', '父任务或依赖任务不在当前协作组', 404);
      }
      const now = Date.now();
      const parent = doc.tasks.find(t => t.id === input.parentTaskId);
      const root = parent?.workflow?.rootTaskId ? doc.tasks.find(t => t.id === parent.workflow!.rootTaskId) : parent;
      if (parent?.workflow && !input.workType) throw new CollaborationError('WORK_TYPE_REQUIRED', '请先明确子任务类型：查询、分析用 --work-type read-only；修改代码用 --work-type code');
      if (parent?.workflow && actor && !sameMember(actor, parent.coordinator)) throw new CollaborationError('TASK_PERMISSION_DENIED', '只有协调者可以创建此目标的子任务', 403);
      if (parent?.status !== undefined && parent.status !== 'open') throw new CollaborationError('TASK_ARCHIVED', '目标已归档', 409);
      if (parent?.workflow && doc.tasks.filter(t => t.workflow?.rootTaskId === (parent.workflow?.rootTaskId ?? parent.id)).length >= 32) throw new CollaborationError('GOAL_TASK_LIMIT', '单个目标最多 32 个子任务，请收敛分工或建立后续目标', 409);
      const workflow: TaskWorkflow | undefined = parent?.workflow ? { ...parent.workflow, kind: 'step' as const, rootTaskId: parent.workflow.rootTaskId ?? parent.id, paused: false, integration: input.integration === true, workType: input.workType ?? 'code', isolated: input.workType === 'read-only' ? false : root?.workflow?.isolated ?? parent.workflow.isolated }
        : input.managed ? { kind: 'goal' as const, workType: 'auto', reviewers: input.reviewers ?? [], isolated: input.isolated !== false, paused: false, maxRevisions: 3, maxParallel: Math.min(4, input.reviewers?.length ?? 1) } : undefined;
      if (workflow?.kind === 'goal' && (!input.coordinator || workflow.reviewers.length < 1)) throw new CollaborationError('WORKFLOW_MEMBERS_REQUIRED', '请选择协调者和至少一位执行成员', 400);
      if (workflow?.kind === 'goal' && !workflow.reviewers.some(m => !sameMember(m, input.coordinator ?? null))) throw new CollaborationError('WORKFLOW_MEMBERS_REQUIRED', '执行成员需要与协调者独立');
      if (workflow && parent && !input.assignee) throw new CollaborationError('ASSIGNEE_REQUIRED', '自动协作子任务需要执行成员');
      if (workflow && parent && sameMember(input.assignee ?? null, parent.coordinator)) throw new CollaborationError('COORDINATOR_IS_NOT_WORKER', '请把实施分派给执行成员，协调者负责组织与评审');
      if (workflow && parent && !workflow.reviewers.some(m => sameMember(m, input.assignee ?? null))) throw new CollaborationError('WORKER_TEMPLATE_REQUIRED', '请从此目标的执行成员中选择模板');
      if (workflow?.rootTaskId && doc.tasks.find(t => t.id === workflow.rootTaskId)?.workflow?.paused) throw new CollaborationError('WORKFLOW_PAUSED', '目标已暂停，请先继续协调');
      if (workflow?.integration) {
        const required = codeSteps(doc.tasks, workflow.rootTaskId!);
        if (!required.length || required.some(t => !dependsOn.includes(t.id))) throw new CollaborationError('INTEGRATION_DEPENDENCIES_REQUIRED', '集成任务必须依赖目标下全部实施子任务');
      }
      const task: CollaborationTask = { id: id(), ownerServiceId: owner, groupId: input.groupId, title, spec, constraints, acceptance,
        coordinator: parent?.workflow ? parent.coordinator : input.coordinator !== undefined ? input.coordinator : input.parentTaskId ? doc.tasks.find(t => t.id === input.parentTaskId)?.coordinator ?? actor : null,
        parentTaskId: input.parentTaskId ?? null, dependsOn, createdAt: now, updatedAt: now, revision: 1,
        ...(origin ? { origin: structuredClone(origin) } : {}), status: 'open', activeAttemptId: null, attempts: [], decisions: [], artifacts: [], events: [], deliveries: [], ...(workflow ? { workflow } : {}) };
      this.event(task, 'created', actor, spec);
      if (parent?.constraints) task.constraints = text([parent.constraints, constraints].filter(Boolean).join('\n'), '继承约束');
      if (workflow?.kind === 'goal') {
        this.assign(doc, task, member(input.coordinator), actor, this.goalInstructions(task));
        task.coordination = { notifiedSequence: task.events.at(-1)!.sequence, acknowledgedSequence: 0, notifiedAt: now };
      } else if (workflow && input.assignee) {
        task.scheduledAssignee = input.assignee;
        this.event(task, 'scheduled', actor, dependsOn.length ? '依赖评审通过后自动分派' : '等待准备执行目录与分派');
      } else if (input.assignee) {
        if (dependsOn.some(dep => doc.tasks.find(t => t.id === dep)?.status !== 'accepted')) throw new CollaborationError('DEPENDENCY_PENDING', '依赖任务尚未验收；可以先保存任务，稍后分派', 409);
        this.assign(doc, task, input.assignee, actor, '');
      }
      this.notifyCoordinator(doc, task);
      doc.tasks.push(task); this.touchParent(doc, task, '新子任务已创建'); doc.requests[request.key] = { hash: request.hash, taskId: task.id }; return task;
    }, origin);
  }
  apply(taskId: string, input: TaskOperation, actor: TaskMember | null, origin?: TaskOrigin): CollaborationTask {
    const content = text(input.content, '内容');
    const summary = text(input.summary, '结果摘要', 2400);
    if (summary && (input.kind !== 'report' || input.status !== 'complete')) throw new CollaborationError('INVALID_SUMMARY', '摘要只能随完成结果提交');
    if (input.verdict !== undefined && !['pass', 'changes', 'blocked'].includes(input.verdict)) throw new CollaborationError('INVALID_VERDICT', '评审结论无效');
    if (input.evidence !== undefined && Buffer.byteLength(JSON.stringify(input.evidence)) > 16_384) throw new CollaborationError('EVIDENCE_TOO_LARGE', '证据最多 16 KiB');
    return this.transaction(doc => {
      const task = doc.tasks.find(t => t.id === taskId);
      if (!task) throw new CollaborationError('TASK_NOT_FOUND', '任务不存在或无权查看', 404);
      const request = this.request(doc, actor, input.idempotencyKey, [taskId, input], origin);
      if (request.previous) return request.previous;
      if (origin && ['accept', 'approve-plan', 'report', 'ask', 'submit-plan', 'review', 'respond'].includes(input.kind)) throw new CollaborationError('INTEGRATION_OPERATION_DENIED', '此操作需要用户或原执行成员身份', 403);
      const coordination = actor === null || sameMember(actor, task.coordinator);
      if (['assign', 'coordinator', 'close', 'reopen', 'revise', 'request-review', 'coordinate', 'pause', 'resume', 'retry'].includes(input.kind) && !coordination) throw new CollaborationError('TASK_PERMISSION_DENIED', '此操作需要用户或当前协调者', 403);
      if (['answer', 'accept', 'approve-plan'].includes(input.kind) && actor !== null) throw new CollaborationError('USER_DECISION_REQUIRED', '回答、方案确认与验收需要用户操作', 403);
      if (!['report', 'ask', 'submit-plan', 'review', 'comment', 'respond', 'answer'].includes(input.kind) && input.expectedRevision !== task.revision) throw new CollaborationError('TASK_CHANGED', '任务已更新，请查看最新记录后重试', 409);
      const userFollowup = actor === null && input.kind === 'revise' && !!content;
      if (task.status !== 'open' && !['reopen', 'report'].includes(input.kind) && !(task.status === 'accepted' && (userFollowup || ['comment', 'respond'].includes(input.kind)))) throw new CollaborationError('TASK_ARCHIVED', '任务已归档；需要继续时请重新打开', 409);
      if (task.workflow && task.status !== 'open' && input.kind !== 'reopen' && !(task.status === 'accepted' && (userFollowup || ['comment', 'respond'].includes(input.kind)))) throw new CollaborationError('TASK_ARCHIVED', '自动协作的已完成版本不能追加执行报告，请先重新打开', 409);
      const root = task.workflow?.rootTaskId ? doc.tasks.find(t => t.id === task.workflow!.rootTaskId) : undefined;
      if (root && root.status !== 'open' && !(root.status === 'accepted' && (userFollowup || ['comment', 'respond'].includes(input.kind)))) throw new CollaborationError('GOAL_ARCHIVED', '请先重新打开所属目标，再继续子任务', 409);
      if (userFollowup && task.status === 'accepted') {
        task.status = 'open'; delete task.acceptedArtifactId; delete task.completionMode;
        this.event(task, 'reopen', null, '用户要求继续跟进，保留上一版交付');
      }
      if (userFollowup && root?.status === 'accepted') {
        root.status = 'open'; delete root.acceptedArtifactId; delete root.completionMode;
        if (root.workflow) root.workflow.paused = false;
        this.event(root, 'reopen', null, '用户要求继续子任务，所属目标同步重新开启');
        root.revision++; root.updatedAt = Date.now();
      }
      const attempt = task.attempts.find(a => a.id === input.attemptId);
      if (['report', 'ask', 'submit-plan'].includes(input.kind) && (!attempt || !sameMember(actor, attempt.assignee))) throw new CollaborationError('ATTEMPT_PERMISSION_DENIED', '只能对自己负责的执行尝试提交报告', 403);
      if (['ask', 'submit-plan'].includes(input.kind) && attempt?.id !== task.activeAttemptId) throw new CollaborationError('ATTEMPT_SUPERSEDED', '这轮分派已被替换，不能再请求用户决定', 409);
      if (task.workflow && ['report', 'ask', 'submit-plan'].includes(input.kind) && attempt?.id !== task.activeAttemptId) throw new CollaborationError('ATTEMPT_SUPERSEDED', '自动协作只能推进当前分派', 409);
      if (input.kind === 'assign') {
        if (task.workflow?.kind === 'goal' && !sameMember(input.assignee ?? null, task.coordinator)) throw new CollaborationError('GOAL_COORDINATOR_REQUIRED', '目标由协调者负责，请在子任务中分派实施');
        if (task.dependsOn.some(dep => doc.tasks.find(t => t.id === dep)?.status !== 'accepted')) throw new CollaborationError('DEPENDENCY_PENDING', '依赖任务尚未验收', 409);
        if (task.workflow?.kind === 'step' && task.workflow.isolated) {
          task.scheduledAssignee = member(input.assignee); task.activeAttemptId = null; delete task.workspace;
          delete task.automationIssue; this.event(task, 'scheduled', actor, content || '准备新一轮独立执行目录');
        } else this.assign(doc, task, member(input.assignee), actor, content);
        this.notifyCoordinator(doc, task);
      } else if (input.kind === 'coordinator') {
        if (task.workflow && !input.coordinator) throw new CollaborationError('GOAL_COORDINATOR_REQUIRED', '自动协作需要协调者');
        const previousCoordinator = task.coordinator;
        task.coordinator = input.coordinator ? member(input.coordinator) : null; this.event(task, 'coordinator', actor, content || '协调者已更新');
        if (task.workflow?.kind === 'goal') {
          this.assign(doc, task, task.coordinator!, actor, this.goalInstructions(task));
          task.coordination = { notifiedSequence: task.events.at(-1)!.sequence, acknowledgedSequence: 0, notifiedAt: Date.now() };
          task.workflow.reviewers = [...task.workflow.reviewers.filter(m => !sameMember(m, task.coordinator)), ...(previousCoordinator && !sameMember(previousCoordinator, task.coordinator) ? [previousCoordinator] : [])];
          for (const child of doc.tasks.filter(t => t.workflow?.rootTaskId === task.id)) { child.coordinator = task.coordinator; child.workflow!.reviewers = task.workflow.reviewers; child.revision++; child.updatedAt = Date.now(); }
        }
        this.notifyCoordinator(doc, task);
      } else if (input.kind === 'report') {
        if (!['ack', 'working', 'blocked', 'complete', 'failed'].includes(input.status ?? '') || !content) throw new CollaborationError('INVALID_REPORT', '报告需要明确状态和正文');
        if (input.status === 'complete' && task.workflow?.kind === 'goal' && (!doc.tasks.some(t => t.workflow?.rootTaskId === task.id)
          || doc.tasks.some(t => t.workflow?.rootTaskId === task.id && !['accepted', 'closed'].includes(t.status)))) throw new CollaborationError('CHILD_TASKS_PENDING', '请先完成全部子任务的独立评审，再汇总交付', 409);
        if (input.status === 'complete' && task.workflow?.kind === 'goal' && task.workflow.isolated) {
          const steps = codeSteps(doc.tasks, task.id);
          if (steps.length && !doc.tasks.some(t => t.workflow?.rootTaskId === task.id && t.workflow.integration && t.status === 'accepted' && steps.every(s => t.dependsOn.includes(s.id)))) throw new CollaborationError('INTEGRATION_PENDING', '代码目标需要依赖全部实施任务的集成交付通过评审', 409);
        }
        if (input.status === 'complete') {
          const plan = task.artifacts.filter(a => a.kind === 'plan' && a.attemptId === task.activeAttemptId).at(-1);
          if (plan && task.approvedPlanArtifactId !== plan.id) throw new CollaborationError('PLAN_PENDING', '方案尚未由用户确认，请先等待决定', 409);
        }
        attempt!.report = { status: input.status!, content, evidence: input.evidence, createdAt: Date.now() };
        const event = this.event(task, 'report', actor, content, attempt!.id); event.reportStatus = input.status; event.evidence = input.evidence;
        if (input.status === 'complete' && attempt!.id === task.activeAttemptId && task.status === 'accepted') { task.status = 'open'; delete task.acceptedArtifactId; delete task.completionMode; }
        if (input.status === 'complete') {
          event.artifactId = id();
          task.artifacts.push({ id: event.artifactId, attemptId: attempt!.id, kind: 'result', content, ...(summary ? { summary } : {}), evidence: input.evidence, actor: actor!, createdAt: event.createdAt });
        }
      } else if (input.kind === 'respond') {
        const original = task.events.find(e => e.id === input.replyToEventId && e.kind === 'comment');
        const originalAttempt = original && task.attempts.find(a => a.id === original.attemptId);
        if (!original || !originalAttempt || originalAttempt.id !== input.attemptId || !sameMember(actor, originalAttempt.assignee)) throw new CollaborationError('RESPONSE_PERMISSION_DENIED', '请由原追问对应的执行成员回复，并指定原事件和分派', 403);
        if (!content) throw new CollaborationError('INVALID_RESPONSE', '答复不能为空');
        const response = this.event(task, 'respond', actor, content, originalAttempt.id); response.replyToEventId = original.id; response.evidence = input.evidence;
      } else if (input.kind === 'ask') {
        if (!content || input.options !== undefined && (!Array.isArray(input.options) || input.options.length > 8 || input.options.some(v => typeof v !== 'string' || !v.trim() || v.length > 500))) throw new CollaborationError('INVALID_QUESTION', '问题正文与选项无效');
        task.decisions.push({ id: id(), attemptId: attempt!.id, question: content, options: input.options ?? [], status: 'pending', createdAt: Date.now() });
        this.event(task, 'question', actor, content, attempt!.id);
      } else if (input.kind === 'answer') {
        const decision = task.decisions.find(d => d.id === input.decisionId);
        if (!decision || decision.status !== 'pending' || decision.attemptId !== task.activeAttemptId) throw new CollaborationError('QUESTION_SETTLED', '该问题已回答或已不再适用，请查看最新记录', 409);
        if (!content) throw new CollaborationError('INVALID_ANSWER', '答案不能为空');
        decision.status = 'answered'; decision.answer = content; decision.answeredAt = Date.now();
        this.event(task, 'answer', null, content, decision.attemptId);
        const recipient = task.attempts.find(a => a.id === decision.attemptId)!;
        doc.outbox.push({ id: id(), taskId: task.id, attemptId: recipient.id, target: recipient.assignee, kind: 'message', threadId: recipient.threadId,
          content: `任务「${task.title}」问题已回答\n问题：${decision.question}\n${origin ? '外部接入回答' : '用户回答'}：${content}\n任务 ID：${task.id}\n尝试 ID：${recipient.id}` });
      } else if (input.kind === 'submit-plan' || input.kind === 'review') {
        if (!content || !actor) throw new CollaborationError('INVALID_ARTIFACT', '交付物需要成员身份和正文');
        const reviewed = input.kind === 'review' ? task.artifacts.find(a => a.id === input.artifactId && a.kind !== 'review') : undefined;
        if (input.kind === 'review' && (!reviewed || sameMember(actor, reviewed.actor))) throw new CollaborationError('INVALID_REVIEW', '独立评审需要选择另一成员提交的明确版本');
        if (input.kind === 'review' && task.workflow) {
          const request = task.events.filter(e => e.kind === 'request-review' && e.artifactId === reviewed?.id).at(-1);
          if (!request?.target || !sameMember(actor, request.target)) throw new CollaborationError('REVIEW_PERMISSION_DENIED', '只有此版本指定的独立评审者可以推进自动流程', 403);
          if (!['pass', 'changes', 'blocked'].includes(input.verdict ?? '')) throw new CollaborationError('REVIEW_VERDICT_REQUIRED', '自动评审需要 --verdict pass|changes|blocked');
          if (reviewed?.attemptId !== task.activeAttemptId || task.artifacts.filter(a => a.kind === reviewed.kind && a.attemptId === task.activeAttemptId).at(-1)?.id !== reviewed.id) throw new CollaborationError('RESULT_CHANGED', '请评审当前分派的最新版本', 409);
        }
        const artifactAttempt = reviewed?.attemptId ?? attempt!.id;
        task.artifacts.push({ id: id(), attemptId: artifactAttempt, kind: input.kind === 'review' ? 'review' : 'plan', content, evidence: input.evidence,
          actor, createdAt: Date.now(), ...(reviewed ? { reviewsArtifactId: reviewed.id, ...(input.verdict ? { verdict: input.verdict } : {}) } : {}) });
        this.event(task, input.kind, actor, content, artifactAttempt);
      } else if (input.kind === 'request-review' || input.kind === 'approve-plan') {
        const artifact = task.artifacts.find(a => a.id === input.artifactId && a.kind !== 'review' && a.attemptId === task.activeAttemptId);
        if (!artifact) throw new CollaborationError('ARTIFACT_CHANGED', '交付物已不属于当前分派', 409);
        const recipient = input.kind === 'request-review' ? member(input.assignee) : artifact.actor;
        if (input.kind === 'request-review' && sameMember(recipient, artifact.actor)) throw new CollaborationError('INVALID_REVIEW', '请选择独立评审成员');
        if (input.kind === 'approve-plan') {
          if (artifact.kind !== 'plan' || task.artifacts.filter(a => a.kind === 'plan' && a.attemptId === task.activeAttemptId).at(-1)?.id !== artifact.id) throw new CollaborationError('PLAN_CHANGED', '请选择本轮最新方案确认', 409);
          task.approvedPlanArtifactId = artifact.id;
        }
        const event = this.event(task, input.kind, actor, content || (input.kind === 'request-review' ? '已请求独立评审' : '用户确认了此版本方案'));
        event.artifactId = artifact.id; event.target = recipient;
        const threadId = task.attempts.find(a => a.id === task.activeAttemptId)!.threadId;
        doc.outbox.push({ id: id(), taskId, attemptId: task.activeAttemptId!, target: recipient, kind: 'message', threadId,
          content: input.kind === 'request-review' ? `请独立评审任务「${task.title}」的交付物 ${artifact.id}。\n${content}\n用 td collab task get ${task.id} --text 查看上下文；用 td collab task review ${task.id} --artifact ${artifact.id} --content '评审结论' 提交。`
            : `任务「${task.title}」方案 ${artifact.id} 已由用户确认。\n${content}\n任务 ID：${task.id}` });
      } else if (input.kind === 'accept') {
        if (task.workflow?.kind === 'goal' && doc.tasks.some(t => t.workflow?.rootTaskId === task.id && !['accepted', 'closed'].includes(t.status))) throw new CollaborationError('CHILD_TASKS_PENDING', '子任务尚未全部完成', 409);
        if (task.workflow?.kind === 'goal' && task.workflow.isolated) {
          const steps = codeSteps(doc.tasks, task.id);
          if (steps.length && !doc.tasks.some(t => t.workflow?.rootTaskId === task.id && t.workflow.integration && t.status === 'accepted' && steps.every(s => t.dependsOn.includes(s.id)))) throw new CollaborationError('INTEGRATION_PENDING', '需要全部实施任务的集成交付通过评审');
        }
        if (task.dependsOn.some(dep => doc.tasks.find(t => t.id === dep)?.status !== 'accepted')) throw new CollaborationError('DEPENDENCY_PENDING', '依赖任务尚未验收', 409);
        if (task.decisions.some(d => d.status === 'pending')) throw new CollaborationError('QUESTION_PENDING', '请先回答本轮待处理问题，再验收结果', 409);
        const artifact = task.artifacts.find(a => a.id === input.artifactId && a.kind === 'result' && a.attemptId === task.activeAttemptId);
        const latest = task.artifacts.filter(a => a.kind === 'result' && a.attemptId === task.activeAttemptId).at(-1);
        if (!artifact || latest?.id !== artifact.id) throw new CollaborationError('RESULT_CHANGED', '请选择本轮最新结果验收', 409);
        if (task.events.some(e => e.kind === 'revise' && e.attemptId === task.activeAttemptId && e.createdAt >= artifact.createdAt)) throw new CollaborationError('REVISION_PENDING', '修改要求之后需要提交新结果才能验收', 409);
        if (task.workflow && task.artifacts.filter(a => a.kind === 'review' && a.reviewsArtifactId === artifact.id).at(-1)?.verdict !== 'pass') throw new CollaborationError('REVIEW_PENDING', '当前结果尚未通过独立评审', 409);
        task.status = 'accepted'; task.acceptedArtifactId = artifact.id; this.event(task, 'accepted', null, content || '用户接受了此版本结果');
        for (const decision of task.decisions) if (decision.status === 'pending') decision.status = 'superseded';
      } else if (input.kind === 'revise' || input.kind === 'comment') {
        if (!content) throw new CollaborationError('INVALID_COMMENT', '反馈不能为空');
        const event = this.event(task, input.kind, actor, content);
        if (actor === null) event.source = 'user';
        const recipient = task.attempts.find(a => a.id === task.activeAttemptId);
        if (recipient && !sameMember(actor, recipient.assignee)) {
          event.target = recipient.assignee; event.deliveryId = id();
          doc.outbox.push({ id: event.deliveryId, taskId: task.id, attemptId: recipient.id, target: recipient.assignee,
            kind: 'message', threadId: recipient.threadId, replyToEventId: event.id, content: `任务「${task.title}」${input.kind === 'revise' ? actor === null ? origin ? '外部接入要求继续跟进' : '用户要求继续跟进' : '修改要求' : '补充反馈'}：\n${content}\n任务 ID：${task.id}\n尝试 ID：${recipient.id}${input.kind === 'comment' ? `\n这是纯咨询，保留当前结果与验收。请用 td collab --session ${recipient.assignee.sessionId} task respond ${task.id} --attempt ${recipient.id} --to-event ${event.id} --content '答复' 关联回复；只有明确提交新的交付物才用 complete。` : task.workflow?.kind === 'goal' ? `\n本轮继续沿用此目标和已交付证据，只推进新增要求。\n${this.goalInstructions(task)}` : '\n按这次要求继续当前分派，重新提交 complete 和摘要；新版本会重新独立评审。'}` });
          if (task.workflow?.kind === 'goal' && task.coordination) {
            task.coordination.notifiedSequence = event.sequence; task.coordination.notifiedAt = Date.now();
          }
        }
        if (input.kind === 'revise') {
          delete task.automationIssue;
          if (userFollowup && task.workflow) task.workflow.paused = false;
        }
      } else if (input.kind === 'close' || input.kind === 'reopen') {
        task.status = input.kind === 'close' ? 'closed' : 'open'; this.event(task, input.kind, actor, content || (input.kind === 'close' ? '任务已关闭，终端工作未被中止' : '任务已重新打开'));
        if (input.kind === 'close') doc.outbox = doc.outbox.filter(o => o.taskId !== task.id || !!o.messageId);
        else {
          delete task.acceptedArtifactId; delete task.completionMode; delete task.automationIssue;
          if (task.artifacts.some(a => a.kind === 'result' && a.attemptId === task.activeAttemptId)) {
            // Reopening starts a new result round; old reviews remain history, not approval.
            const event = this.event(task, 'revise', actor, content || '任务重新开启，请继续当前分派并提交新结果；新版本需要重新评审');
            if (actor === null) event.source = 'user';
          }
        }
        if (input.kind === 'close') for (const decision of task.decisions) if (decision.status === 'pending') decision.status = 'superseded';
        if (task.workflow?.kind === 'goal') task.workflow.paused = input.kind === 'close';
      } else if (input.kind === 'coordinate') {
        if (task.workflow?.kind !== 'goal' || !sameMember(actor, task.coordinator) || !content) throw new CollaborationError('COORDINATOR_REQUIRED', '请由目标协调者提交本次协调说明', 403);
        this.event(task, 'coordinate', actor, content);
        task.coordination = { notifiedSequence: task.events.at(-1)!.sequence, acknowledgedSequence: task.events.at(-1)!.sequence, notifiedAt: Date.now() };
        delete task.automationIssue;
      } else if (input.kind === 'pause' || input.kind === 'resume' || input.kind === 'retry') {
        if (!task.workflow) throw new CollaborationError('WORKFLOW_REQUIRED', '此任务未启用自动协作');
        if (input.kind !== 'retry') task.workflow.paused = input.kind === 'pause';
        delete task.automationIssue;
        this.event(task, input.kind, actor, content || (input.kind === 'pause' ? '暂停后续自动安排，已写入终端的工作继续保留'
          : input.kind === 'retry' ? '请求重新检查现有投递与协调条件，成员原报告保留' : '继续推进自动协作'));
        if (input.kind === 'retry' && task.coordination) task.coordination.notifiedSequence = 0;
        if (input.kind === 'retry') for (const outbox of doc.outbox.filter(o => o.taskId === task.id)) {
          const receipt = task.deliveries.find(d => d.id === outbox.id);
          if (receipt && ['failed', 'expired'].includes(receipt.status)) { outbox.id = id(); delete outbox.messageId; }
          delete outbox.lastError; delete outbox.nextRetryAt;
        }
      } else throw new CollaborationError('INVALID_TASK_OPERATION', '不支持的任务操作');
      if (['report', 'respond', 'ask', 'answer', 'submit-plan', 'review', 'accept', 'revise', 'close', 'reopen'].includes(input.kind)) this.notifyCoordinator(doc, task, task.events.at(-1));
      if (task.events.length > 1000 || task.artifacts.length > 200 || task.attempts.length > 100) throw new CollaborationError('TASK_HISTORY_LIMIT', '此任务历史达到上限，请建立后续任务并保留本任务为历史', 409);
      task.revision++; task.updatedAt = Math.max(Date.now(), task.updatedAt + 1);
      if (task.workflow && !['coordinate', 'comment', 'respond'].includes(input.kind)) this.touchParent(doc, task, `${input.kind}${input.status ? ` / ${input.status}` : ''}：${content.slice(0, 1500)}`);
      if (task.workflow && ['blocked', 'failed'].includes(input.status ?? '')) task.automationIssue = content.slice(0, 1000);
      if (task.workflow && input.kind === 'report' && ['ack', 'working', 'complete'].includes(input.status ?? '')) delete task.automationIssue;
      doc.requests[request.key] = { hash: request.hash, taskId, eventId: task.events.at(-1)?.id }; return task;
    }, origin);
  }
  private touchParent(doc: TaskDocument, task: CollaborationTask, content: string) {
    const root = task.workflow?.rootTaskId ? doc.tasks.find(t => t.id === task.workflow!.rootTaskId) : undefined;
    if (!root || root.status !== 'open') return;
    this.event(root, 'child-update', null, `子任务「${task.title}」(${task.id})：${content}`);
    const result = root.artifacts.filter(a => a.kind === 'result' && a.attemptId === root.activeAttemptId).at(-1);
    if (result && !root.events.some(e => e.kind === 'revise' && e.attemptId === root.activeAttemptId && e.createdAt >= result.createdAt)) {
      this.event(root, 'revise', null, '子任务在汇总之后发生变化，请重新核对并提交最终结果').source = 'system';
    }
    root.revision++; root.updatedAt = Date.now();
  }
  scheduled(owner: string): CollaborationTask[] {
    return this.owned(owner).filter(t => t.workflow && t.status === 'open' && t.scheduledAssignee && !t.activeAttemptId && !t.automationIssue
      && !t.workflow.paused && !this.document.tasks.find(r => r.id === t.workflow?.rootTaskId)?.workflow?.paused
      && this.document.tasks.find(r => r.id === t.workflow?.rootTaskId)?.status === 'open'
      && !this.planPending(this.document.tasks.find(r => r.id === t.workflow?.rootTaskId)!)
      && t.dependsOn.every(id => this.document.tasks.find(d => d.id === id)?.status === 'accepted'));
  }
  private planPending(task: CollaborationTask): boolean {
    const plan = task.artifacts.filter(a => a.kind === 'plan' && a.attemptId === task.activeAttemptId).at(-1);
    return !!plan && task.approvedPlanArtifactId !== plan.id;
  }
  activateScheduled(taskId: string, expectedRevision: number, assignee: TaskMember, workspace?: TaskWorkspace): void {
    this.transaction(doc => {
      const task = doc.tasks.find(t => t.id === taskId);
      const root = task?.workflow?.rootTaskId ? doc.tasks.find(t => t.id === task.workflow!.rootTaskId) : undefined;
      if (!task || task.revision !== expectedRevision || task.activeAttemptId || !task.scheduledAssignee || task.status !== 'open'
        || task.workflow?.paused || !root || root.status !== 'open' || root.workflow?.paused || this.planPending(root)
        || task.dependsOn.some(id => doc.tasks.find(t => t.id === id)?.status !== 'accepted')) return;
      if (workspace) task.workspace = workspace;
      const dependencyContext = task.dependsOn.map(id => doc.tasks.find(t => t.id === id)!).map(dependency =>
        `「${dependency.title}」：${dependency.workflow?.workType === 'read-only' ? '已验收的只读报告，作为执行上下文' : '已验收的前置交付'}；用 td collab task get ${dependency.id} --text 读取报告、证据和限制。`).join('\n');
      this.assign(doc, task, assignee, task.coordinator, `服务已接续依赖并准备执行${dependencyContext ? `\n前置任务：\n${dependencyContext}` : ''}`); delete task.scheduledAssignee;
      task.revision++; task.updatedAt = Date.now(); this.touchParent(doc, task, '已自动分派');
    });
  }
  automationFailed(taskId: string, error: string): void {
    if (this.get(taskId)?.automationIssue === error.slice(0, 1000)) return;
    this.transaction(doc => { const task = doc.tasks.find(t => t.id === taskId); if (!task) return;
      task.automationIssue = error.slice(0, 1000); this.event(task, 'automation-blocked', null, task.automationIssue).source = 'system';
      task.revision++; task.updatedAt = Date.now(); this.touchParent(doc, task, task.automationIssue); });
  }
  private nextAction(task: CollaborationTask, doc: TaskDocument): string | null {
    if (!task.workflow || task.status !== 'open' || task.workflow.paused) return null;
    const root = task.workflow.rootTaskId && doc.tasks.find(r => r.id === task.workflow!.rootTaskId);
    if (root && (root.status !== 'open' || root.workflow?.paused || this.planPending(root))) return null;
    const result = task.artifacts.filter(a => a.kind === 'result' && a.attemptId === task.activeAttemptId).at(-1);
    if (result && !task.automationIssue && !task.decisions.some(d => d.status === 'pending')
      && !task.events.some(e => e.kind === 'revise' && e.attemptId === task.activeAttemptId && e.createdAt >= result.createdAt)) {
      const review = task.artifacts.filter(a => a.kind === 'review' && a.reviewsArtifactId === result.id).at(-1);
      if (!review && !task.events.some(e => e.kind === 'request-review' && e.artifactId === result.id)) return 'request-review';
      if (review?.verdict === 'pass' && task.workflow.kind === 'step' && task.dependsOn.every(id => doc.tasks.find(t => t.id === id)?.status === 'accepted')) return 'review-passed';
      if (review && ['changes', 'blocked'].includes(review.verdict ?? '') && !task.events.some(e => e.kind === 'review-blocked' && e.artifactId === result.id)) return 'review-feedback';
    }
    if (task.workflow.kind === 'goal' && task.coordination) {
      if (Date.now() - task.updatedAt >= 1000 && task.events.some(e => e.sequence > task.coordination!.notifiedSequence
        && !['coordinate', 'request-review', 'assigned'].includes(e.kind) && !sameMember(e.actor, task.coordinator))) return 'wake';
      if (!task.automationIssue && task.coordination.acknowledgedSequence < task.coordination.notifiedSequence
        && (!result || task.events.some(e => e.kind === 'revise' && e.attemptId === task.activeAttemptId && e.createdAt >= result.createdAt)) && Date.now() - task.coordination.notifiedAt > 15 * 60_000) return 'coordination-timeout';
    }
    return null;
  }
  /** Explicit, version-bound transitions; the browser does not drive this loop. */
  advance(owner: string): void {
    if (!this.document.tasks.some(t => t.ownerServiceId === owner && this.nextAction(t, this.document))) return;
    this.transaction(doc => {
      for (const task of doc.tasks.filter(t => t.ownerServiceId === owner)) {
        const action = this.nextAction(task, doc); if (!action) continue;
        const result = task.artifacts.filter(a => a.kind === 'result' && a.attemptId === task.activeAttemptId).at(-1);
        const review = task.artifacts.filter(a => a.kind === 'review' && a.reviewsArtifactId === result?.id).at(-1);
        const attempt = task.attempts.find(a => a.id === task.activeAttemptId);
        if (action === 'request-review') {
          const reviewers = [task.coordinator, ...task.workflow!.reviewers].filter((m): m is TaskMember => !!m && !sameMember(m, result!.actor));
          const reviewer = reviewers.find(m => m.serviceId === result!.actor.serviceId) ?? reviewers[0];
          if (!reviewer) task.automationIssue = '没有可用的独立评审成员，请调整协调者或成员后继续';
          else {
            const event = this.event(task, 'request-review', null, '服务自动安排此版本独立评审'); event.artifactId = result!.id; event.target = reviewer; event.source = 'system';
            doc.outbox.push({ id: id(), taskId: task.id, attemptId: task.activeAttemptId, target: reviewer, kind: 'message', threadId: attempt!.threadId,
              content: `本次评审身份：${reviewer.sessionId}；所有命令带 --session ${reviewer.sessionId}，不使用作者或模板身份。\n请独立评审「${task.title}」版本 ${result!.id}。用 td collab task get ${task.id} --json 查看目标、结果、摘要和证据；摘要必须与正文一致，遗漏关键限制或夸大结果需要求修改。${task.workspace ? `代码目录 ${task.workspace.cwd}，分支 ${task.workspace.branch}；只读检查此目录，不修改原仓库。` : ''}\n提交 td collab task review ${task.id} --artifact ${result!.id} --verdict pass|changes|blocked --content '结论、具体问题与证据'。pass 表示符合完成标准；changes 给出可执行修改要求；blocked 留下必须处理的原因。只按用户授权运行测试，未执行不能称通过。` });
          }
          this.touchParent(doc, task, '已自动请求独立评审');
        } else if (action === 'review-passed') {
          task.status = 'accepted'; task.acceptedArtifactId = result!.id; task.completionMode = 'reviewed';
          this.event(task, 'review-passed', review!.actor, review!.content).source = 'system';
          this.touchParent(doc, task, '独立评审通过，后续依赖可以接续');
        } else if (action === 'review-feedback') {
          const boundary = task.events.filter(e => e.kind === 'revise' && ['user', 'integration'].includes(e.source ?? '') && e.attemptId === task.activeAttemptId).at(-1)?.sequence ?? 0;
          const rounds = task.events.filter(e => e.kind === 'revise' && e.actor === null && e.artifactId && e.attemptId === task.activeAttemptId && e.sequence > boundary).length;
          const blocked = review!.verdict === 'blocked' || rounds >= task.workflow!.maxRevisions;
          const event = this.event(task, blocked ? 'review-blocked' : 'revise', null, review!.content); event.artifactId = result!.id; event.source = 'system';
          if (blocked) task.automationIssue = `${review!.verdict === 'blocked' ? '独立评审受阻' : '连续返工需要调整方案'}：${review!.content.slice(0, 800)}`;
          else doc.outbox.push({ id: id(), taskId: task.id, attemptId: task.activeAttemptId, target: result!.actor, kind: 'message', threadId: attempt!.threadId,
            content: `任务「${task.title}」独立评审要求修改：\n${review!.content}\n请继续完成当前分派并重新 report --status complete；新版本会重新独立评审。任务 ${task.id}，尝试 ${task.activeAttemptId}。` });
          this.touchParent(doc, task, blocked ? task.automationIssue! : '已自动交回修改');
        } else if (action === 'wake') {
          const updates = task.events.filter(e => e.sequence > task.coordination!.notifiedSequence && e.kind !== 'coordinate');
          doc.outbox.push({ id: id(), taskId: task.id, attemptId: task.activeAttemptId, target: task.coordinator!, kind: 'message', threadId: task.id,
            content: `当前协调身份：${task.coordinator!.sessionId}；命令带 --session ${task.coordinator!.sessionId}。\n目标「${task.title}」有新的明确事件，请继续协调：\n${updates.slice(-8).map(e => `${new Date(e.createdAt).toISOString()} ${e.content.slice(0, 1200)}`).join('\n')}\n用 td collab task get ${task.id} --json 读取完整上下文与子任务；安排必要下一步后 task coordinate ${task.id} --revision <最新版本> --content '协调说明'。自动评审和依赖已由服务接续，不要重复分派。\n当前流程指南：查询、检查、分析必须 --work-type read-only，复用 roster 现有执行成员；只有修改代码才用 code 和独立目录。只读报告由你直接汇总，不新增仅转述的汇总子任务。已评审且 HEAD 等于 base 的交付没有代码变化，不需要集成；有代码变化才安排必要集成。用户有新要求时继续本目标，交付新版本，不重做已有采样。最终汇总通过评审且无新要求时等待用户验收，不重复提交相同结果。` });
          task.coordination!.notifiedSequence = task.events.at(-1)!.sequence; task.coordination!.notifiedAt = Date.now();
        } else task.automationIssue = '协调通知发出后 15 分钟未收到本次协调说明，请查看终端或点击继续协调。';
        task.revision++; task.updatedAt = Date.now();
      }
    });
  }
  merge(task: CollaborationTask, issuer: string): void {
    validateSnapshot(task);
    if (task.ownerServiceId !== issuer) throw new CollaborationError('INVALID_TASK_OWNER', '任务来源身份不符');
    const current = this.get(task.id);
    if (current && current.ownerServiceId !== issuer) throw new CollaborationError('TASK_ID_CONFLICT', '任务身份冲突');
    if (current && current.revision >= task.revision) return;
    this.transaction(doc => { const index = doc.tasks.findIndex(t => t.id === task.id);
      if (index < 0) { if (doc.tasks.length >= 2000) throw new CollaborationError('TASK_LIMIT', '任务记录达到上限', 409); doc.tasks.push(task); }
      else doc.tasks[index] = task; });
  }
  delivered(outboxId: string, receipt: { messageId: string; status: 'pending' | 'delivered' | 'failed' | 'expired'; deliveredAt: number | null; error: string | null }): void {
    if (!receipt || typeof receipt.messageId !== 'string' || !receipt.messageId || receipt.messageId.length > 128
      || !['pending', 'delivered', 'failed', 'expired'].includes(receipt.status)
      || receipt.deliveredAt !== null && (!Number.isSafeInteger(receipt.deliveredAt) || receipt.deliveredAt <= 0)
      || receipt.error !== null && typeof receipt.error !== 'string') throw new CollaborationError('INVALID_TASK_RECEIPT', '远端投递凭证无效');
    const current = this.document.outbox.find(o => o.id === outboxId);
    if (!current) return;
    const previous = this.document.tasks.find(t => t.id === current.taskId)?.deliveries.find(d => d.id === outboxId);
    if (JSON.stringify(previous) === JSON.stringify({ id: outboxId, attemptId: current.attemptId, kind: current.kind, ...receipt })) {
      current.nextRetryAt = Date.now() + (receipt.status === 'pending' ? 2000 : 30_000); return;
    }
    this.transaction(doc => {
      const outbox = doc.outbox.find(o => o.id === outboxId)!;
      outbox.messageId = receipt.messageId; outbox.lastError = receipt.error ?? undefined;
      const task = doc.tasks.find(t => t.id === outbox.taskId)!;
      const attempt = task.attempts.find(a => a.id === outbox.attemptId)!;
      const previous = task.deliveries.find(d => d.id === outboxId);
      const delivery = { id: outboxId, attemptId: outbox.attemptId, kind: outbox.kind, ...receipt };
      const changed = JSON.stringify(previous) !== JSON.stringify(delivery);
      if (changed) {
        if (previous) Object.assign(previous, delivery); else task.deliveries.push(delivery);
        task.revision++; task.updatedAt = Math.max(Date.now(), task.updatedAt + 1);
      }
      // Later feedback has its own receipt; it must not overwrite the initial dispatch.
      if (outbox.kind === 'task') {
        attempt.messageId = receipt.messageId; attempt.deliveryStatus = receipt.status; attempt.deliveredAt = receipt.deliveredAt; attempt.deliveryError = receipt.error;
      }
      if (receipt.status === 'delivered' || !task.workflow && ['failed', 'expired'].includes(receipt.status)) doc.outbox = doc.outbox.filter(o => o.id !== outboxId);
      else outbox.nextRetryAt = Date.now() + (receipt.status === 'pending' ? 2000 : 30_000);
      if (task.workflow && ['failed', 'expired'].includes(receipt.status)) {
        task.automationIssue = `消息投递${receipt.status === 'expired' ? '过期' : '失败'}：${receipt.error ?? '请检查成员终端后重试'}`;
        this.touchParent(doc, task, task.automationIssue);
      } else if (receipt.status === 'delivered' && task.automationIssue?.startsWith('消息投递')
        && !doc.outbox.some(o => o.taskId === task.id && o.lastError)
        && !task.deliveries.some(d => d.attemptId === task.activeAttemptId && ['failed', 'expired'].includes(d.status))) delete task.automationIssue;
    });
  }
  failed(outboxId: string, error: string): void {
    const current = this.document.outbox.find(o => o.id === outboxId);
    if (!current) return;
    if (current.lastError === error.slice(0, 500)) { current.nextRetryAt = Date.now() + 10_000; return; }
    this.transaction(doc => {
      const outbox = doc.outbox.find(o => o.id === outboxId)!;
      const changed = outbox.lastError !== error.slice(0, 500);
      outbox.lastError = error.slice(0, 500); outbox.nextRetryAt = Date.now() + 10_000;
      const task = doc.tasks.find(t => t.id === outbox.taskId)!;
      if (changed) {
        const previous = task.deliveries.find(d => d.id === outboxId);
        const record = { id: outboxId, attemptId: outbox.attemptId, kind: outbox.kind, messageId: outbox.messageId ?? '', status: 'retrying', deliveredAt: null, error: outbox.lastError };
        if (previous) Object.assign(previous, record); else task.deliveries.push(record);
        task.revision++; task.updatedAt = Math.max(Date.now(), task.updatedAt + 1);
        if (task.workflow && !task.automationIssue) { task.automationIssue = `消息投递正在重试：${outbox.lastError}`; this.touchParent(doc, task, task.automationIssue); }
      }
    });
  }
}
