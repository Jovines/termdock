import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollaborationTaskStore } from './collaborationTaskStore.js';
import { CollaborationTaskService } from './collaborationTaskService.js';
import { CollaborationStore } from './collaborationStore.js';
import { parseCollaborationCommand } from './collaborationCli.js';
import { executeTaskCommand } from './collaborationTaskCli.js';
import type { CollaborationService } from './collaborationService.js';
import type { CollaborationTask, TaskOperation, TaskMember } from './collaborationTaskTypes.js';

const owner = `12D3KooW${'a'.repeat(40)}`;
const lead = { serviceId: owner, sessionId: 'lead' }, worker = { serviceId: owner, sessionId: 'worker' };
let dir: string, store: CollaborationTaskStore;
const apply = (id: string, op: Omit<TaskOperation, 'idempotencyKey'>, actor: TaskMember | null) => store.apply(id, { ...op, idempotencyKey: randomUUID() }, actor);
const goal = () => store.create(owner, { idempotencyKey: randomUUID(), groupId: 'team', title: '目标', spec: '检查负载', managed: true, isolated: true, coordinator: lead, reviewers: [worker] }, null);
function step(root: CollaborationTask, workType: 'code' | 'read-only', dependencies: string[] = [], integration = false) {
  return store.create(owner, { idempotencyKey: randomUUID(), groupId: root.groupId, title: '执行', spec: '交付证据', parentTaskId: root.id, assignee: worker, workType, dependsOn: dependencies, integration }, lead);
}
function finish(task: CollaborationTask) {
  const current = store.get(task.id)!;
  const author = current.attempts.find(a => a.id === current.activeAttemptId)!.assignee;
  apply(task.id, { kind: 'report', attemptId: current.activeAttemptId!, status: 'complete', summary: '窗口内未见过载；仅采样 20 秒。', content: '完整指标与限制，原始证据。' }, author);
  store.advance(owner);
  const result = store.get(task.id)!.artifacts.filter(a => a.kind === 'result').at(-1)!;
  const request = store.get(task.id)!.events.find(e => e.kind === 'request-review' && e.artifactId === result.id)!;
  apply(task.id, { kind: 'review', artifactId: result.id, verdict: 'pass', content: '数据与摘要一致。' }, request.target!);
  store.advance(owner);
  return store.get(task.id)!;
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'termdock-workflow-')); store = new CollaborationTaskStore(join(dir, 'tasks.json')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('classified collaboration workflows', () => {
  it('exposes launch commands and usage notes to the coordinator while retaining member launch snapshots', async () => {
    const messages = new CollaborationStore(join(dir, 'messages.json'));
    const original = { id: 'deep', name: '深度实现', agentSlug: 'codex', command: 'codex --model example-deep', notes: '复杂实现使用；简单查询不要使用。' };
    const group = messages.save({ name: 'test', sessionIds: ['lead', 'worker'], launchProfiles: [original], defaultLaunchProfileId: original.id });
    messages.setMemberLaunchProfile(group.id, 'worker', original);
    const changed = { ...original, command: 'codex --model example-new', notes: '新任务使用新版配置。' };
    messages.save({ id: group.id, name: group.name, sessionIds: group.sessionIds, launchProfiles: [changed], defaultLaunchProfileId: changed.id });
    const root = store.create(owner, { idempotencyKey: randomUUID(), groupId: group.id, title: '实现', spec: '修复问题', managed: true, coordinator: lead, reviewers: [worker] }, null);
    const peers = { descriptor: () => ({ serviceId: owner }), taskSession: (m: TaskMember) => m.sessionId,
      taskMember: (sessionId: string) => ({ serviceId: owner, sessionId }) } as unknown as CollaborationService;
    const service = new CollaborationTaskService(store, messages, peers, vi.fn());
    const view = await service.get(root.id, lead);
    expect(view.launchProfiles).toEqual([changed]);
    expect(view.defaultLaunchProfileId).toBe('deep');
    expect(view.roster?.find(m => m.sessionId === 'worker')?.launchProfile).toEqual(original);
    expect(store.pending(root.id).find(m => m.kind === 'task')?.content).toContain('根据用户填写的 notes 判断适用任务');
    expect(service.list(group.id, lead)[0].launchProfiles).toBeUndefined();
  });
  it('requires a fresh result and review after explicit reopening, including after reload and uncertain retries', () => {
    const root = goal(), child = step(root, 'read-only');
    store.activateScheduled(child.id, child.revision, worker);
    const accepted = finish(child), oldResult = accepted.artifacts.filter(a => a.kind === 'result').at(-1)!;
    const reopen: TaskOperation = { kind: 'reopen', content: '发现遗漏，补充检查', expectedRevision: accepted.revision, idempotencyKey: randomUUID() };
    const next = store.apply(child.id, reopen, lead);
    expect(next.status).toBe('open'); expect(next.completionMode).toBeUndefined();
    expect(next.events.at(-1)).toMatchObject({ kind: 'revise', content: '发现遗漏，补充检查' });
    store = new CollaborationTaskStore(join(dir, 'tasks.json'));
    expect(store.apply(child.id, reopen, lead).revision).toBe(next.revision);
    store.advance(owner); store.advance(owner);
    expect(store.get(child.id)!.status).toBe('open');
    expect(store.get(child.id)!.artifacts.filter(a => a.kind === 'result')).toHaveLength(1);
    expect(() => apply(child.id, { kind: 'accept', artifactId: oldResult.id, expectedRevision: store.get(child.id)!.revision }, null)).toThrow('修改要求之后');
    const completed = finish(store.get(child.id)!);
    expect(completed.status).toBe('accepted');
    expect(completed.acceptedArtifactId).not.toBe(oldResult.id);
    expect(completed.artifacts.filter(a => a.kind === 'review')).toHaveLength(2);
  });
  it('resumes a closed task without fabricating a result revision when nothing was delivered', () => {
    const root = goal();
    const closed = apply(root.id, { kind: 'close', expectedRevision: root.revision }, null);
    const reopened = apply(root.id, { kind: 'reopen', expectedRevision: closed.revision }, null);
    expect(reopened.status).toBe('open'); expect(reopened.workflow?.paused).toBe(false);
    expect(reopened.events.at(-1)?.kind).toBe('reopen');
    expect(reopened.events.some(e => e.kind === 'revise')).toBe(false);
  });
  it('finishes and accepts a reviewed read-only goal without a worktree or integration task', () => {
    const root = goal(), child = step(root, 'read-only');
    expect(child.workflow?.isolated).toBe(false);
    store.activateScheduled(child.id, child.revision, worker);
    expect(finish(child).status).toBe('accepted');
    const final = finish(root);
    expect(final.status).toBe('open'); // Only the user accepts the goal.
    const artifact = final.artifacts.find(a => a.kind === 'result')!;
    expect(apply(root.id, { kind: 'accept', expectedRevision: final.revision, artifactId: artifact.id }, null).status).toBe('accepted');
    expect(store.children(root.id)).toHaveLength(1);
    expect(store.get(child.id)?.workspace).toBeUndefined();
  });
  it('keeps the independent integration gate for code and mixed goals', () => {
    const root = goal(), code = step(root, 'code');
    store.activateScheduled(code.id, code.revision, worker);
    finish(code);
    const query = step(root, 'read-only'); store.activateScheduled(query.id, query.revision, worker); finish(query);
    expect(() => apply(root.id, { kind: 'report', attemptId: root.activeAttemptId!, status: 'complete', content: '完成' }, lead)).toThrow('代码目标需要');
    // Integration depends on code, not an irrelevant read-only report.
    const integration = step(root, 'code', [code.id], true);
    store.activateScheduled(integration.id, integration.revision, worker); finish(integration);
    expect(finish(root).artifacts.some(a => a.kind === 'result')).toBe(true);
  });
  it('requires classification rather than silently creating a code workspace', () => {
    const root = goal();
    expect(() => store.create(owner, { idempotencyKey: randomUUID(), groupId: root.groupId, title: '负载', spec: '采集', parentTaskId: root.id, assignee: worker }, lead)).toThrow('--work-type read-only');
    expect(() => step(root, 'read-only', [], true)).toThrow('只读任务不需要');
  });
  it('preserves classification and code isolation for nested tasks beneath a read-only step', () => {
    const root = goal(), query = step(root, 'read-only');
    expect(() => store.create(owner, { idempotencyKey: randomUUID(), groupId: root.groupId, title: '下一步', spec: '明确类型', parentTaskId: query.id, assignee: worker }, lead)).toThrow('--work-type read-only');
    const code = step(query, 'code');
    expect(code.workflow?.isolated).toBe(true);
    expect(code.workflow?.rootTaskId).toBe(root.id);
  });
  it('blocks user acceptance until the current result has an independent review', () => {
    const root = goal(), child = step(root, 'read-only'); store.activateScheduled(child.id, child.revision, worker); finish(child);
    const pending = apply(root.id, { kind: 'report', attemptId: root.activeAttemptId!, status: 'complete', content: '完成' }, lead);
    expect(() => apply(root.id, { kind: 'accept', expectedRevision: pending.revision, artifactId: pending.artifacts[0].id }, null)).toThrow('尚未通过独立评审');
  });
  it('persists the author summary through reload and the lightweight task list', () => {
    const root = goal(), child = step(root, 'read-only'); store.activateScheduled(child.id, child.revision, worker); finish(child);
    const reloaded = new CollaborationTaskStore(join(dir, 'tasks.json'));
    expect(reloaded.list(['team'], true).find(t => t.id === child.id)?.artifacts[0]).toMatchObject({ summary: '窗口内未见过载；仅采样 20 秒。', content: '' });
    expect(() => apply(root.id, { kind: 'report', attemptId: root.activeAttemptId!, status: 'ack', summary: '不应产生结果摘要', content: '接手' }, lead)).toThrow('摘要只能随完成结果提交');
  });
  it('dispatches the actual prepared identity rather than a worker template', () => {
    const root = goal(), child = step(root, 'code'), actual = { serviceId: owner, sessionId: 'actual' };
    store.activateScheduled(child.id, child.revision, actual);
    const message = store.pending(child.id).find(o => o.kind === 'task')!;
    expect(message.content).toContain('--session actual');
    expect(message.content).toContain('模板身份和 tmux 标识不能替代它');
    expect(store.get(child.id)?.attempts[0].assignee).toEqual(actual);
  });
  it('makes an accepted read-only report available as context for the dependent code worker', () => {
    const root = goal(), audit = step(root, 'read-only');
    store.activateScheduled(audit.id, audit.revision, worker); finish(audit);
    const code = step(root, 'code', [audit.id]);
    expect(store.scheduled(owner).map(task => task.id)).toContain(code.id);
    store.activateScheduled(code.id, code.revision, worker);
    const message = store.pending(code.id).find(outbox => outbox.kind === 'task')!;
    expect(message.content).toContain('已验收的只读报告，作为执行上下文');
    expect(message.content).toContain(`td collab task get ${audit.id} --text`);
    expect(store.get(code.id)?.automationIssue).toBeUndefined();
  });
  it('runs the service scheduler without preparing another terminal for read-only work', async () => {
    const messages = new CollaborationStore(join(dir, 'messages.json'));
    const group = messages.save({ name: 'test', sessionIds: ['lead', 'worker'] });
    const root = store.create(owner, { idempotencyKey: randomUUID(), groupId: group.id, title: '负载', spec: '检查负载', managed: true, coordinator: lead, reviewers: [worker] }, null);
    const child = step(root, 'read-only');
    const prepare = vi.fn();
    const peers = { descriptor: () => ({ serviceId: owner }), taskSession: (m: TaskMember) => m.sessionId } as unknown as CollaborationService;
    const service = new CollaborationTaskService(store, messages, peers, vi.fn(), prepare);
    try { service.start(); await vi.waitFor(() => expect(store.get(child.id)?.activeAttemptId).toBeTruthy()); }
    finally { service.close(); }
    expect(prepare).not.toHaveBeenCalled();
    expect(store.get(child.id)?.attempts[0].assignee).toEqual(worker);
    expect(messages.getGroup(group.id)?.sessionIds).toEqual(['lead', 'worker']);
  });
  it('passes classification and report summaries through the CLI', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    await executeTaskCommand(parseCollaborationCommand(['task', 'create', '--group', 'team', '--title', '负载', '--content', '只读采样', '--work-type', 'read-only']), request, { request: vi.fn(), write: vi.fn() });
    expect(request.mock.calls[0][2]).toMatchObject({ input: { workType: 'read-only' } });
    await executeTaskCommand(parseCollaborationCommand(['task', 'report', 'goal', '--attempt', 'attempt', '--status', 'complete', '--content', '完整报告', '--summary', '未见过载；仅采样 20 秒。']), request, { request: vi.fn(), write: vi.fn() });
    expect(request.mock.calls[1][2]).toMatchObject({ input: { summary: '未见过载；仅采样 20 秒。' } });
  });
  it('atomically continues an accepted goal, deduplicates an uncertain retry and requires a new reviewed version', () => {
    const root = goal(), child = step(root, 'read-only');
    store.activateScheduled(child.id, child.revision, worker); finish(child);
    const final = finish(root), oldResult = final.artifacts.filter(a => a.kind === 'result').at(-1)!;
    const accepted = apply(root.id, { kind: 'accept', expectedRevision: final.revision, artifactId: oldResult.id }, null);
    const op: TaskOperation = { kind: 'revise', content: '继续查询磁盘占用', expectedRevision: accepted.revision, idempotencyKey: randomUUID() };
    const followup = store.apply(root.id, op, null);
    expect(followup.status).toBe('open'); expect(followup.acceptedArtifactId).toBeUndefined();
    const event = followup.events.at(-1)!;
    expect(event).toMatchObject({ kind: 'revise', source: 'user', target: lead });
    expect(store.pending(root.id).filter(o => o.id === event.deliveryId)).toHaveLength(1);
    expect(store.pending(root.id).find(o => o.id === event.deliveryId)?.content).toContain('--work-type read-only');
    const outboxCount = store.pending(root.id).length;
    expect(store.apply(root.id, op, null).revision).toBe(followup.revision);
    const future = Date.now() + 2000; const clock = vi.spyOn(Date, 'now').mockReturnValue(future);
    try { store.advance(owner); } finally { clock.mockRestore(); }
    expect(store.pending(root.id)).toHaveLength(outboxCount); // Direct feedback must not trigger a second wake.
    expect(() => apply(root.id, { kind: 'accept', expectedRevision: store.get(root.id)!.revision, artifactId: oldResult.id }, null)).toThrow('修改要求之后');
    store.delivered(event.deliveryId!, { messageId: 'followup-message', status: 'delivered', deliveredAt: Date.now(), error: null });
    expect(store.get(root.id)!.deliveries.find(d => d.id === event.deliveryId)?.status).toBe('delivered');
    const newReport = apply(root.id, { kind: 'report', attemptId: root.activeAttemptId!, status: 'complete', content: '新磁盘报告', summary: '根盘已用 43%。' }, lead);
    const newResult = newReport.artifacts.filter(a => a.kind === 'result').at(-1)!;
    expect(newResult.id).not.toBe(oldResult.id); expect(newResult.createdAt).toBeGreaterThan(event.createdAt);
    expect(() => apply(root.id, { kind: 'accept', expectedRevision: newReport.revision, artifactId: newResult.id }, null)).toThrow('尚未通过独立评审');
    store.advance(owner);
    const reviewer = store.get(root.id)!.events.find(e => e.kind === 'request-review' && e.artifactId === newResult.id)!.target!;
    const reviewed = apply(root.id, { kind: 'review', artifactId: newResult.id, verdict: 'pass', content: '核对通过' }, reviewer);
    const done = apply(root.id, { kind: 'accept', expectedRevision: reviewed.revision, artifactId: newResult.id }, null);
    expect(done.status).toBe('accepted'); expect(done.artifacts.filter(a => a.kind === 'result')).toHaveLength(2);
    expect(store.children(root.id)).toHaveLength(1); // Continue without creating a replacement task or session.
  });
  it('reopens the accepted parent for a user follow-up on a completed step, while preserving archived boundaries', () => {
    const root = goal(), child = step(root, 'read-only'); store.activateScheduled(child.id, child.revision, worker); finish(child);
    const final = finish(root), artifact = final.artifacts.find(a => a.kind === 'result')!;
    apply(root.id, { kind: 'accept', expectedRevision: final.revision, artifactId: artifact.id }, null);
    const current = store.get(child.id)!;
    expect(() => apply(child.id, { kind: 'revise', expectedRevision: current.revision, content: '擅自继续' }, lead)).toThrow('任务已归档');
    const next = apply(child.id, { kind: 'revise', expectedRevision: current.revision, content: '补充目录占用' }, null);
    expect(next.status).toBe('open'); expect(store.get(root.id)!.status).toBe('open');
    expect(store.get(root.id)!.acceptedArtifactId).toBeUndefined();
    const closed = apply(root.id, { kind: 'close', expectedRevision: store.get(root.id)!.revision }, null);
    expect(() => apply(child.id, { kind: 'revise', expectedRevision: next.revision, content: '继续' }, null)).toThrow('请先重新打开所属目标');
    expect(store.get(root.id)!.revision).toBe(closed.revision);
  });
  it('requires classification on legacy goals and skips integration when a reviewed worktree contains no commits', () => {
    const root = goal();
    const path = join(dir, 'tasks.json'), document = JSON.parse(readFileSync(path, 'utf8'));
    delete document.tasks[0].workflow.workType; writeFileSync(path, JSON.stringify(document));
    store = new CollaborationTaskStore(path);
    expect(() => store.create(owner, { idempotencyKey: randomUUID(), groupId: root.groupId, parentTaskId: root.id, title: '查询', spec: '只读查询', assignee: worker }, lead)).toThrow('--work-type read-only');
    const legacy = step(store.get(root.id)!, 'code');
    const base = 'a'.repeat(40);
    store.activateScheduled(legacy.id, legacy.revision, worker, { cwd: '/tmp/query', repository: '/repo', branch: 'query', base });
    const current = store.get(legacy.id)!;
    const report = apply(legacy.id, { kind: 'report', attemptId: current.activeAttemptId!, status: 'complete', content: '只读结果', evidence: { commit: base } }, worker);
    store.advance(owner);
    const artifact = report.artifacts.at(-1)!;
    const reviewer = store.get(legacy.id)!.events.find(e => e.kind === 'request-review')!.target!;
    apply(legacy.id, { kind: 'review', artifactId: artifact.id, verdict: 'pass', content: '证据一致，没有代码变更' }, reviewer); store.advance(owner);
    expect(store.get(legacy.id)!.status).toBe('accepted');
    expect(finish(root).artifacts.filter(a => a.kind === 'result')).toHaveLength(1);
    expect(store.children(root.id)).toHaveLength(1);
  });
  it('times out an unanswered follow-up even while an old reviewed result remains visible', () => {
    const root = goal(), child = step(root, 'read-only'); store.activateScheduled(child.id, child.revision, worker); finish(child); finish(root);
    const current = store.get(root.id)!;
    apply(root.id, { kind: 'revise', expectedRevision: current.revision, content: '继续检查' }, null);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000);
    try { store.advance(owner); } finally { clock.mockRestore(); }
    expect(store.get(root.id)!.automationIssue).toContain('15 分钟未收到');
  });

  it('clears a follow-up delivery failure after its own receipt confirms a successful retry', () => {
    const root = goal(); const before = store.get(root.id)!;
    const next = apply(root.id, { kind: 'revise', expectedRevision: before.revision, content: '继续检查' }, null);
    const event = next.events.at(-1)!;
    store.delivered(event.deliveryId!, { messageId: 'followup', status: 'failed', deliveredAt: null, error: '终端断开' });
    expect(store.get(root.id)!.automationIssue).toContain('消息投递失败');
    expect(store.get(root.id)!.attempts[0].deliveryStatus).not.toBe('failed');
    store.delivered(event.deliveryId!, { messageId: 'followup', status: 'delivered', deliveredAt: Date.now(), error: null });
    expect(store.get(root.id)!.automationIssue).toBeUndefined();
    expect(store.get(root.id)!.deliveries.find(d => d.id === event.deliveryId)?.status).toBe('delivered');
  });

  it('counts review revisions within the current user follow-up rather than across unrelated earlier scopes', () => {
    const root = goal(), child = step(root, 'read-only'); store.activateScheduled(child.id, child.revision, worker);
    const path = join(dir, 'tasks.json'), document = JSON.parse(readFileSync(path, 'utf8'));
    document.tasks.find((t: CollaborationTask) => t.id === child.id).workflow.maxRevisions = 1;
    writeFileSync(path, JSON.stringify(document)); store = new CollaborationTaskStore(path);
    const changes = () => {
      const current = store.get(child.id)!;
      const report = apply(child.id, { kind: 'report', attemptId: current.activeAttemptId!, status: 'complete', content: '需核对的结果' }, worker);
      const result = report.artifacts.filter(a => a.kind === 'result').at(-1)!;
      store.advance(owner);
      const reviewer = store.get(child.id)!.events.find(e => e.kind === 'request-review' && e.artifactId === result.id)!.target!;
      apply(child.id, { kind: 'review', artifactId: result.id, verdict: 'changes', content: '补充证据' }, reviewer); store.advance(owner);
    };
    changes(); expect(store.get(child.id)!.automationIssue).toBeUndefined(); finish(child);
    const accepted = store.get(child.id)!;
    apply(child.id, { kind: 'revise', expectedRevision: accepted.revision, content: '检查另一项新要求' }, null);
    changes(); expect(store.get(child.id)!.automationIssue).toBeUndefined();
    expect(store.get(child.id)!.events.at(-1)).toMatchObject({ kind: 'revise', source: 'system' });
  });

  it('includes a bounded explicit follow-up in lightweight cards', () => {
    const root = goal(), current = store.get(root.id)!;
    apply(root.id, { kind: 'revise', expectedRevision: current.revision, content: '继续检查磁盘，不重复采样' + '。'.repeat(600) }, null);
    const card = store.list(['team'], true).find(t => t.id === root.id)!;
    expect(card.events.find(e => e.source === 'user')).toMatchObject({ kind: 'revise', content: ('继续检查磁盘，不重复采样' + '。'.repeat(600)).slice(0, 512) });
    expect(card.events.find(e => e.source === 'user')!.content).toHaveLength(512);
  });

  it('keeps a bounded pending question visible in lightweight cards and preserves the full question in detail', () => {
    const root = goal(), content = '请选择验证范围：桌面还是手机？' + '详细条件。'.repeat(150);
    apply(root.id, { kind: 'ask', attemptId: root.activeAttemptId!, content, options: ['桌面', '手机'] }, lead);
    const card = store.list(['team'], true).find(t => t.id === root.id)!;
    expect(card.decisions[0].question).toBe(content.slice(0, 512));
    expect(card.decisions[0].options).toEqual([]);
    expect(store.get(root.id)!.decisions[0].question).toBe(content);
    expect(store.get(root.id)!.decisions[0].options).toEqual(['桌面', '手机']);
  });

});
