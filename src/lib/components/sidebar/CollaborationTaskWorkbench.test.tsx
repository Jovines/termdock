// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollaborationTaskView, OrchestrationSession } from '../../terminal/api';
import { useCollaborationTaskWorkspace } from '../../stores/useCollaborationTaskWorkspace';
import { CollaborationTaskWorkbench } from './CollaborationTaskWorkbench';

const api = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), upload: vi.fn(), team: vi.fn() }));
vi.mock('../../terminal/api', () => ({ listCollaborationTasks: api.list, getCollaborationTask: api.get, createCollaborationTask: api.create, updateCollaborationTask: api.update, uploadFiles: api.upload, ensureCollaborationTeam: api.team }));
vi.mock('./CollaborationTaskContent', () => ({ default: ({ content }: { content: string }) => <p>{content}</p> }));
const member = { serviceId: 'local', sessionId: 'lead' };
const group = { id: 'team', name: '发布准备', sessionIds: ['lead', 'worker'], createdAt: 1, updatedAt: 1 };
const sessions: OrchestrationSession[] = group.sessionIds.map((id, i) => ({ sessionId: id, backendSessionId: id, name: i ? '执行成员' : '协调者', cwd: '/repo', agent: { slug: 'codex', displayName: 'Codex' }, status: 'ready', capability: 'terminal', currentTask: '', updatedAt: 1 }));
function task(overrides: Partial<CollaborationTaskView> = {}): CollaborationTaskView {
  return { id: 'goal', ownerServiceId: 'local', groupId: group.id, title: '完善预览体验', spec: '支持窄屏预览和失败重试', constraints: '', acceptance: '保留终端输入', createdAt: 1, updatedAt: 10, revision: 2, coordinator: member, parentTaskId: null, dependsOn: [], status: 'open', activeAttemptId: 'attempt', attempts: [{ id: 'attempt', assignee: member, createdAt: 1, threadId: 'thread', deliveryStatus: 'delivered', deliveredAt: 2 }], events: [], decisions: [], artifacts: [], deliveries: [], workflow: { kind: 'goal', reviewers: [{ serviceId: 'local', sessionId: 'worker' }], isolated: true, paused: false, maxRevisions: 3 }, memberSessions: { 'local:lead': 'lead', 'local:worker': 'worker' }, outbox: [], children: [], ...overrides };
}
const result = { id: 'result', attemptId: 'attempt', kind: 'result' as const, content: '附件布局已完成', createdAt: 6, actor: member };
const review = { id: 'review', attemptId: 'review-attempt', kind: 'review' as const, content: '独立评审通过', createdAt: 7, actor: { serviceId: 'local', sessionId: 'worker' }, reviewsArtifactId: 'result', verdict: 'pass' as const };
let resize: (entries: Array<{ contentRect: { width: number } }>) => void;
function setup(records: CollaborationTaskView[] = [], options: Partial<React.ComponentProps<typeof CollaborationTaskWorkbench>> = {}) {
  api.list.mockResolvedValue({ tasks: records });
  api.get.mockImplementation(async (id: string) => ({ task: records.find(t => t.id === id) }));
  const onOpenSession = vi.fn().mockResolvedValue(undefined), onManageMembers = vi.fn();
  const rendered = render(<CollaborationTaskWorkbench group={group} sessions={sessions} active onOpenSession={onOpenSession} onManageMembers={onManageMembers} {...options} />);
  return { ...rendered, onOpenSession, onManageMembers };
}
async function choose(title = '完善预览体验') { fireEvent.click(await screen.findByRole('button', { name: new RegExp(title) })); return screen.findByRole('heading', { name: title }); }
beforeEach(() => {
  localStorage.clear(); useCollaborationTaskWorkspace.setState({ views: {}, details: {} }); vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class { constructor(callback: typeof resize) { resize = callback; } observe() { resize([{ contentRect: { width: 360 } }]); } disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('collaboration goal journeys', () => {
  it('opens a board result as a full reading page with a persistent acceptance action', async () => {
    const body = '内部交接：任务 abc 版本 def。\n\n结论：CPU 25.6%，未见过载。\n\n限制：仅采样 20 秒。';
    const record = task({ artifacts: [{ ...result, content: body }, review] });
    const { container } = setup([record], { board: true });
    act(() => resize([{ contentRect: { width: 1500 } }]));
    await choose();
    const reader = screen.getByRole('complementary', { name: '任务详情' });
    expect(reader.className).not.toContain('w-[440px]');
    expect(reader.className).toContain('w-full');
    expect(screen.queryByRole('region', { name: '需要你任务' })).toBeNull();
    const footer = within(reader).getByRole('region', { name: '结果验收' });
    expect(within(footer).getByRole('button', { name: '验收此结果' })).toBeTruthy();
    expect(container.querySelector('[aria-label="结果结论"]')?.textContent).toContain('CPU 25.6%');
    expect(container.querySelector('[aria-label="结果结论"]')?.textContent).not.toContain('任务 abc');
    expect(screen.getByText('仅采样 20 秒。')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: '补充说明或修改要求' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '继续跟进' }));
    fireEvent.change(screen.getByRole('textbox', { name: '跟进要求' }), { target: { value: '补充逐核心数据' } });
    api.update.mockResolvedValue({ task: { ...record, revision: 3 } });
    fireEvent.click(screen.getByRole('button', { name: '发送并继续跟进' }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('goal', expect.objectContaining({ kind: 'revise', content: '补充逐核心数据', expectedRevision: 2 })));
  });
  it('returns from history to the current result before allowing acceptance', async () => {
    setup([task({ artifacts: [result, review] })], { board: true }); await choose();
    fireEvent.click(screen.getByRole('button', { name: '历史交付' }));
    expect(screen.queryByRole('button', { name: '验收此结果' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '返回当前结果' }));
    expect(screen.getByRole('button', { name: '验收此结果' })).toBeTruthy();
    expect(api.update).not.toHaveBeenCalled();
  });
  it('keeps follow-up in the fixed footer, blocks repeat clicks and prevents acceptance of the old version', async () => {
    const record = task({ artifacts: [result, review] });
    setup([record], { board: true }); await choose();
    fireEvent.click(screen.getByRole('button', { name: '继续跟进' }));
    const footer = screen.getByRole('region', { name: '结果验收' });
    const field = within(footer).getByRole('textbox', { name: '跟进要求' }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: '继续查看磁盘占用' } });
    let resolve!: (value: { task: CollaborationTaskView }) => void;
    api.update.mockImplementation(() => new Promise(done => { resolve = done; }));
    const send = within(footer).getByRole('button', { name: '发送并继续跟进' });
    fireEvent.click(send); fireEvent.click(send);
    expect(screen.getByRole('button', { name: '正在发送…' }).hasAttribute('disabled')).toBe(true);
    expect(api.update).toHaveBeenCalledOnce();
    const updated = { ...record, revision: 3, events: [{ id: 'followup', kind: 'revise', source: 'user' as const, deliveryId: 'feedback-delivery', target: member, sequence: 1, actor: null, content: '继续查看磁盘占用', attemptId: 'attempt', createdAt: 8 }] };
    await act(async () => resolve({ task: updated }));
    await screen.findByText('跟进要求已保存，等待新结果。');
    expect(screen.queryByRole('textbox', { name: '跟进要求' })).toBeNull();
    expect(screen.getByText('上一版结果')).toBeTruthy();
    expect(screen.getByRole('button', { name: '验收此结果' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('region', { name: '最近跟进' }).textContent).toContain('等待写入终端');
    expect(localStorage.getItem(`termdock:tasks:${location.origin}:team:goal:feedback`)).toBe('""');
    expect(api.update.mock.calls[0][1]).toMatchObject({ kind: 'revise', content: '继续查看磁盘占用' });
  });
  it('offers one follow-up action after acceptance and keeps a cancelled draft', async () => {
    const record = task({ status: 'accepted', acceptedArtifactId: result.id, artifacts: [result, review] });
    setup([record], { board: true }); await choose();
    expect(screen.queryByRole('button', { name: '验收此结果' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '继续跟进' }));
    fireEvent.change(screen.getByRole('textbox', { name: '跟进要求' }), { target: { value: '补充目录占用' } });
    fireEvent.click(screen.getByRole('button', { name: '取消，保留草稿' }));
    expect(screen.queryByRole('textbox', { name: '跟进要求' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '继续跟进 · 有草稿' }));
    expect((screen.getByRole('textbox', { name: '跟进要求' }) as HTMLTextAreaElement).value).toBe('补充目录占用');
    api.update.mockResolvedValue({ task: { ...record, status: 'open', revision: 3 } });
    fireEvent.click(screen.getByRole('button', { name: '发送并继续跟进' }));
    await screen.findByText('跟进要求已保存，等待新结果。');
    expect(api.update).toHaveBeenCalledOnce();
    expect(api.update.mock.calls[0][1]).toMatchObject({ kind: 'revise', expectedRevision: 2, content: '补充目录占用' });
  });
  it('keeps failed feedback and retries using the same request key', async () => {
    const record = task(); setup([record]); await choose();
    const field = screen.getByRole('textbox', { name: '补充说明或修改要求' }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: '追加磁盘统计' } });
    api.update.mockRejectedValueOnce(new Error('网络断开')).mockResolvedValueOnce({ task: { ...record, revision: 3 } });
    fireEvent.click(screen.getByRole('button', { name: '发送补充' }));
    await screen.findByText('未确认保存：网络断开。内容已保留，可重试。');
    expect(field.value).toBe('追加磁盘统计');
    fireEvent.click(screen.getByRole('button', { name: '发送补充' }));
    await screen.findByText('补充已保存，服务端将继续投递。');
    expect(api.update.mock.calls[0][1].idempotencyKey).toBe(api.update.mock.calls[1][1].idempotencyKey);
    expect(field.value).toBe('');
  });
  it('reuses the original request after a lost response even when polling observes a newer revision', async () => {
    const record = task({ artifacts: [result, review] }); setup([record], { board: true }); await choose();
    fireEvent.click(screen.getByRole('button', { name: '继续跟进' }));
    fireEvent.change(screen.getByRole('textbox', { name: '跟进要求' }), { target: { value: '补充新结果' } });
    const persisted = { ...record, revision: 4, events: [{ id: 'revise', sequence: 1, kind: 'revise', source: 'user' as const, content: '补充新结果', actor: null, attemptId: 'attempt', createdAt: 8 }] };
    api.list.mockResolvedValue({ tasks: [persisted] }); api.get.mockResolvedValue({ task: persisted });
    api.update.mockRejectedValueOnce(new Error('连接中断')).mockResolvedValueOnce({ task: persisted });
    fireEvent.click(screen.getByRole('button', { name: '发送并继续跟进' }));
    await screen.findByRole('alert');
    await screen.findByText('上一版结果'); // Error refresh has already observed the server's successful write.
    fireEvent.click(screen.getByRole('button', { name: '发送并继续跟进' }));
    await screen.findByText('跟进要求已保存，等待新结果。');
    expect(api.update.mock.calls[1][1]).toEqual(api.update.mock.calls[0][1]);
    expect(api.update.mock.calls[1][1].expectedRevision).toBe(2);
  });
  it('does not clear a newer shared draft when an earlier submission succeeds', async () => {
    const record = task(); setup([record]); await choose();
    fireEvent.change(screen.getByRole('textbox', { name: '补充说明或修改要求' }), { target: { value: '已提交内容' } });
    let resolve!: (value: { task: CollaborationTaskView }) => void;
    api.update.mockImplementation(() => new Promise(done => { resolve = done; }));
    fireEvent.click(screen.getByRole('button', { name: '发送补充' }));
    act(() => useCollaborationTaskWorkspace.getState().updateDetail(`termdock:tasks:${location.origin}:team:goal`, 'feedback', '另一个面板中的新草稿'));
    await act(async () => resolve({ task: { ...record, revision: 3 } }));
    expect((screen.getByRole('textbox', { name: '补充说明或修改要求' }) as HTMLTextAreaElement).value).toBe('另一个面板中的新草稿');
  });
  it('uses one location path to distinguish the board from the parent goal and preserves the child draft', async () => {
    const root = task({ children: [{ id: 'child', title: '分析磁盘占用', status: 'open', revision: 2 }] });
    const child = task({ id: 'child', title: '分析磁盘占用', parentTaskId: 'goal', workflow: { ...root.workflow!, kind: 'step', rootTaskId: 'goal' } });
    setup([root, child], { board: true }); await choose('分析磁盘占用');
    const path = screen.getByRole('navigation', { name: '任务位置' });
    expect(within(path).getAllByRole('button')).toHaveLength(2);
    expect(within(path).getByText('子任务详情').getAttribute('aria-current') ?? within(path).getByText('子任务详情').parentElement?.getAttribute('aria-current')).toBe('page');
    expect(within(path).getByRole('button', { name: '查看目标：完善预览体验' }).textContent).toContain('目标：完善预览体验');
    expect(screen.queryByRole('button', { name: '完善预览体验' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: '补充说明或修改要求' }), { target: { value: '保留磁盘采样时间' } });
    fireEvent.click(within(path).getByRole('button', { name: '查看目标：完善预览体验' }));
    await screen.findByRole('heading', { name: '完善预览体验' });
    fireEvent.click(screen.getByRole('button', { name: /分析磁盘占用/ }));
    await screen.findByRole('heading', { name: '分析磁盘占用' });
    expect((screen.getByRole('textbox', { name: '补充说明或修改要求' }) as HTMLTextAreaElement).value).toBe('保留磁盘采样时间');
    fireEvent.click(screen.getByRole('button', { name: '返回看板' }));
    expect(screen.queryByRole('navigation', { name: '任务位置' })).toBeNull();
    expect(screen.getByRole('region', { name: '执行中任务' })).toBeTruthy();
    expect(api.update).not.toHaveBeenCalled();
  });
  it('shows every ancestor in a nested task path', async () => {
    const root = task();
    const parent = task({ id: 'parent', title: '检查磁盘', parentTaskId: 'goal', workflow: { ...root.workflow!, kind: 'step' } });
    const child = task({ id: 'child', title: '统计目录', parentTaskId: 'parent', workflow: { ...root.workflow!, kind: 'step' } });
    setup([root, parent, child], { board: true }); await choose('统计目录');
    const path = screen.getByRole('navigation', { name: '任务位置' });
    expect(within(path).getAllByRole('button').map(button => button.textContent)).toEqual(['看板', '目标：完善预览体验', '父任务：检查磁盘']);
    fireEvent.click(within(path).getByRole('button', { name: '查看父任务：检查磁盘' }));
    await screen.findByRole('heading', { name: '检查磁盘' });
  });
  it('starts from an editable goal without an intermediate empty-state click', async () => {
    setup();
    const field = await screen.findByRole('textbox', { name: '协作目标' });
    const submit = screen.getByRole('button', { name: '开始协作' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: '完善图片预览' } });
    api.create.mockResolvedValue({ task: task({ title: '完善图片预览' }) });
    fireEvent.click(submit);
    await screen.findByRole('heading', { name: '完善图片预览' });
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ managed: true, title: '完善图片预览', coordinatorSessionId: 'lead', reviewerSessionIds: ['worker'], isolated: true }));
    expect(screen.queryByRole('textbox', { name: '协作目标' })).toBeNull();
  });
  it('explains missing agents and links to members without submitting an invalid goal', async () => {
    const { onManageMembers } = setup([], { sessions: sessions.slice(0, 1) });
    fireEvent.change(await screen.findByRole('textbox', { name: '协作目标' }), { target: { value: '完善预览' } });
    expect((screen.getByRole('button', { name: '开始协作' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '管理成员' }));
    expect(onManageMembers).toHaveBeenCalledOnce(); expect(api.create).not.toHaveBeenCalled();
  });
  it('keeps a cancelled draft and coordinator choice for the next visit', async () => {
    setup([task()]);
    fireEvent.click(await screen.findByRole('button', { name: '新目标' }));
    fireEvent.change(screen.getByRole('textbox', { name: '协作目标' }), { target: { value: '还没有写完的目标' } });
    fireEvent.change(screen.getByRole('combobox', { name: '协调者' }), { target: { value: 'worker' } });
    fireEvent.click(screen.getByRole('button', { name: '取消创建，保留草稿' }));
    fireEvent.click(screen.getByRole('button', { name: '新目标' }));
    expect((screen.getByRole('textbox', { name: '协作目标' }) as HTMLTextAreaElement).value).toBe('还没有写完的目标');
    expect((screen.getByRole('combobox', { name: '协调者' }) as HTMLSelectElement).value).toBe('worker');
    expect(api.create).not.toHaveBeenCalled();
  });
  it('shares the current draft between resident and expanded views without losing overlay edits', async () => {
    setup([task()]);
    fireEvent.click(await screen.findByRole('button', { name: '新目标' }));
    fireEvent.change(screen.getByRole('textbox', { name: '协作目标' }), { target: { value: '驻留区的目标草稿' } });
    const overlay = render(<CollaborationTaskWorkbench group={group} sessions={sessions} active onOpenSession={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole('textbox', { name: '协作目标' })).toHaveLength(2));
    const fields = screen.getAllByRole('textbox', { name: '协作目标' }) as HTMLTextAreaElement[];
    expect(fields[1].value).toBe('驻留区的目标草稿');
    fireEvent.change(fields[1], { target: { value: '展开后补充的草稿' } });
    expect(fields[0].value).toBe('展开后补充的草稿');
    overlay.unmount();
    expect((screen.getByRole('textbox', { name: '协作目标' }) as HTMLTextAreaElement).value).toBe('展开后补充的草稿');
    expect(api.create).not.toHaveBeenCalled();
  });
  it('surfaces a child question in the default list and opens the correct terminal', async () => {
    const child = task({ id: 'child', title: '调整窄屏布局', parentTaskId: 'goal', workflow: { ...task().workflow!, kind: 'step' }, decisions: [{ id: 'question', attemptId: 'attempt', question: '默认全屏吗？', options: ['默认全屏'], status: 'pending', createdAt: 5 }] });
    const { onOpenSession } = setup([task(), child]);
    const pending = await screen.findByRole('region', { name: '需要你处理' });
    fireEvent.click(within(pending).getByRole('button', { name: /调整窄屏布局/ }));
    await screen.findByRole('textbox', { name: '你的回答' });
    expect(screen.getByText('默认全屏吗？')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '打开终端' }));
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'lead' }));
  });
  it('keeps answer and feedback edits when an expanded detail view is closed', async () => {
    const record = task({ decisions: [{ id: 'q', attemptId: 'attempt', question: '选择布局？', options: [], status: 'pending', createdAt: 5 }] });
    setup([record]); await choose();
    const overlay = render(<CollaborationTaskWorkbench group={group} sessions={sessions} active onOpenSession={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole('textbox', { name: '你的回答' })).toHaveLength(2));
    fireEvent.change(screen.getAllByRole('textbox', { name: '你的回答' })[1], { target: { value: '保留终端背景' } });
    fireEvent.change(screen.getAllByRole('textbox', { name: '补充说明或修改要求' })[1], { target: { value: '展开中补充的说明' } });
    overlay.unmount();
    expect((screen.getByRole('textbox', { name: '你的回答' }) as HTMLTextAreaElement).value).toBe('保留终端背景');
    expect((screen.getByRole('textbox', { name: '补充说明或修改要求' }) as HTMLTextAreaElement).value).toBe('展开中补充的说明');
    expect(api.update).not.toHaveBeenCalled();
  });
  it('submits an explicit suggested answer with the current revision and removes the answered prompt', async () => {
    const record = task({ decisions: [{ id: 'q', attemptId: 'attempt', question: '采用哪种布局？', options: ['默认全屏'], status: 'pending', createdAt: 5 }] });
    setup([record]); await choose();
    fireEvent.click(screen.getByRole('button', { name: '默认全屏' }));
    api.update.mockResolvedValue({ task: { ...record, revision: 3, decisions: [{ ...record.decisions[0], status: 'answered', answer: '默认全屏' }] } });
    fireEvent.click(screen.getByRole('button', { name: '回复并继续' }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('goal', expect.objectContaining({ kind: 'answer', decisionId: 'q', content: '默认全屏', expectedRevision: 2 })));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '你的回答' })).toBeNull());
  });
  it('keeps the same request key and draft when a failed create is retried', async () => {
    setup(); fireEvent.change(await screen.findByRole('textbox', { name: '协作目标' }), { target: { value: '完善预览' } });
    api.create.mockRejectedValueOnce(new Error('提交连接中断')).mockResolvedValueOnce({ task: task() });
    fireEvent.click(screen.getByRole('button', { name: '开始协作' }));
    await screen.findByRole('alert');
    expect((screen.getByRole('textbox', { name: '协作目标' }) as HTMLTextAreaElement).value).toBe('完善预览');
    fireEvent.click(screen.getByRole('button', { name: '开始协作' }));
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(2));
    expect(api.create.mock.calls[0][0].idempotencyKey).toBe(api.create.mock.calls[1][0].idempotencyKey);
  });
  it('does not erase an operation error when the background list refresh succeeds', async () => {
    setup([task()]); await choose();
    fireEvent.change(screen.getByRole('textbox', { name: '补充说明或修改要求' }), { target: { value: '保留输入内容' } });
    api.update.mockRejectedValueOnce(new Error('本次补充未保存'));
    fireEvent.click(screen.getByRole('button', { name: '发送补充' }));
    await screen.findByRole('alert');
    await waitFor(() => expect(api.list.mock.calls.length).toBeGreaterThan(1));
    expect(screen.getByRole('alert').textContent).toContain('本次补充未保存');
    expect((screen.getByRole('textbox', { name: '补充说明或修改要求' }) as HTMLTextAreaElement).value).toBe('保留输入内容');
  });
  it('explains why a result cannot be accepted before its independent review', async () => {
    setup([task({ artifacts: [result] })]); await choose();
    await screen.findByRole('heading', { name: '交付结果' });
    expect((screen.getByRole('button', { name: '验收此结果' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('独立评审通过后可验收。')).toBeTruthy();
  });
  it('accepts only the reviewed current result and keeps history in the delivery view', async () => {
    const record = task({ artifacts: [{ ...result, id: 'old-result', attemptId: 'old-attempt', content: '旧版结果' }, result, review] });
    setup([record]); await choose();
    await screen.findByRole('heading', { name: '交付结果' });
    expect(screen.queryByText('旧版结果')).toBeNull();
    api.update.mockResolvedValue({ task: { ...record, status: 'accepted', acceptedArtifactId: 'result', revision: 3 } });
    fireEvent.click(screen.getByRole('button', { name: '验收此结果' }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('goal', expect.objectContaining({ kind: 'accept', artifactId: 'result', expectedRevision: 2 })));
    fireEvent.click(screen.getByRole('button', { name: '交付 3' }));
    await screen.findByText('旧版结果');
    expect(screen.queryByRole('textbox', { name: '补充说明或修改要求' })).toBeNull();
  });
  it('blocks final acceptance while a child remains open', async () => {
    setup([task({ artifacts: [result, review], children: [{ id: 'child', title: '未交付的子任务', status: 'open', revision: 1 }] })]); await choose();
    expect((screen.getByRole('button', { name: '验收此结果' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('子任务完成并通过评审后可验收。')).toBeTruthy();
  });
  it('uses pane width for split detail and returns to a single view in a narrow pane', async () => {
    setup([task()]); await choose();
    expect(screen.queryByRole('button', { name: '新目标' })).toBeNull();
    act(() => resize([{ contentRect: { width: 900 } }]));
    expect(screen.getByRole('button', { name: '新目标' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '完善预览体验' })).toBeTruthy();
    act(() => resize([{ contentRect: { width: 360 } }]));
    expect(screen.queryByRole('button', { name: '新目标' })).toBeNull();
    expect(screen.getByRole('button', { name: '全部目标' })).toBeTruthy();
  });
  it('does not replace a newer selected task with a late detail response', async () => {
    const first = task(), second = task({ id: 'second', title: '另一个目标' });
    setup([first, second]);
    let resolve!: (value: { task: CollaborationTaskView }) => void;
    api.get.mockImplementation((id: string) => id === 'goal' ? new Promise(done => { resolve = done; }) : Promise.resolve({ task: second }));
    fireEvent.click(await screen.findByRole('button', { name: /完善预览体验/ }));
    act(() => window.dispatchEvent(new CustomEvent('open-collaboration-task', { detail: { groupId: 'team', taskId: 'second' } })));
    await screen.findByRole('heading', { name: '另一个目标' });
    await act(async () => resolve({ task: first }));
    expect(screen.queryByRole('heading', { name: '完善预览体验' })).toBeNull();
    expect(screen.getByRole('heading', { name: '另一个目标' })).toBeTruthy();
  });
});

it('holds feedback submission until the attachment path is ready and sends that path with the comment', async () => {
  let finish!: (result: { files: { name: string; path: string; size: number }[] }) => void;
  api.upload.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  setup([task()]); await choose();
  const field = screen.getByRole('textbox', { name: '补充说明或修改要求' });
  fireEvent.change(field, { target: { value: '请参考附件' } });
  fireEvent.paste(field, { clipboardData: { files: [new File(['data'], 'notes.txt')], items: [], getData: () => '' } });
  await screen.findByText('正在准备附件…');
  const send = screen.getByRole('button', { name: '发送补充' }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.click(send); expect(api.update).not.toHaveBeenCalled();
  await act(async () => finish({ files: [{ name: 'notes.txt', path: '/tmp/notes.txt', size: 4 }] }));
  expect(send.disabled).toBe(false);
  api.update.mockResolvedValue({ task: task({ revision: 3 }) });
  fireEvent.click(send);
  await waitFor(() => expect(api.update).toHaveBeenCalledWith('goal', expect.objectContaining({ kind: 'comment', content: expect.stringContaining('/tmp/notes.txt') })));
});

describe('primary kanban journeys', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { constructor(private callback: typeof resize) {} observe() { this.callback([{ contentRect: { width: 1300 } }]); } disconnect() {} });
  });
  it('keeps filter choices explicit, shows the applied count and preserves them after closing', async () => {
    setup([task(), task({ id: 'other', title: '另一个目标' })], { board: true });
    await screen.findByRole('heading', { name: '任务看板' });
    expect(screen.queryByRole('combobox', { name: '按目标查看' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '筛选任务' }));
    fireEvent.change(screen.getByRole('combobox', { name: '按目标查看' }), { target: { value: 'goal' } });
    expect(screen.queryByRole('button', { name: /另一个目标/ })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    const trigger = screen.getByRole('button', { name: '筛选任务，1 项已启用' });
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole('combobox', { name: '按目标查看' })).toBeNull();
    fireEvent.click(trigger);
    expect((screen.getByRole('combobox', { name: '按目标查看' }) as HTMLSelectElement).value).toBe('goal');
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(screen.getByRole('button', { name: /另一个目标/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '筛选任务' })).toBeTruthy();
  });
  it('searches only when requested and restores the complete board when search is closed', async () => {
    setup([task(), task({ id: 'other', title: '准备发布' })], { board: true });
    await screen.findByRole('heading', { name: '任务看板' });
    expect(screen.queryByRole('searchbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '搜索任务' }));
    const input = screen.getByRole('searchbox', { name: '搜索任务' });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: '准备发布' } });
    expect(screen.queryByRole('button', { name: /完善预览体验/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭搜索' }));
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.getByRole('button', { name: /完善预览体验/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /准备发布/ })).toBeTruthy();
  });
  it('starts on the empty board and opens a retained goal draft only when requested', async () => {
    setup([], { board: true });
    await screen.findByRole('heading', { name: '任务看板' });
    for (const label of ['待开始', '执行中', '需要你', '已完成']) expect(screen.getByRole('region', { name: `${label}任务` })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: '协作目标' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '新目标' }));
    fireEvent.change(screen.getByRole('textbox', { name: '协作目标' }), { target: { value: '改进预览体验' } });
    fireEvent.click(screen.getByRole('button', { name: '取消创建，保留草稿' }));
    expect(screen.getByRole('heading', { name: '任务看板' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '新目标' }));
    expect((screen.getByRole('textbox', { name: '协作目标' }) as HTMLTextAreaElement).value).toBe('改进预览体验');
    api.create.mockResolvedValue({ task: task({ title: '改进预览体验' }) });
    fireEvent.click(screen.getByRole('button', { name: '开始协作' }));
    await screen.findByRole('heading', { name: '改进预览体验' });
    fireEvent.click(screen.getByRole('button', { name: '返回看板' }));
    expect(screen.queryByRole('region', { name: '任务详情' })).toBeNull();
    expect(within(screen.getByRole('region', { name: '执行中任务' })).getByRole('button', { name: /改进预览体验/ })).toBeTruthy();
  });
  it('shows root goals and actionable child tasks in their own lanes and filters by goal', async () => {
    const child = task({ id: 'child', title: '选择预览布局', parentTaskId: 'goal', workflow: { ...task().workflow!, kind: 'step' }, decisions: [{ id: 'q', attemptId: 'attempt', question: '采用哪种布局？', options: ['保留终端'], status: 'pending', createdAt: 5 }] });
    setup([task(), child, task({ id: 'waiting', title: '等待分派的任务', activeAttemptId: null, attempts: [], workflow: undefined }), task({ id: 'done', title: '已验收的任务', status: 'accepted' })], { board: true });
    await screen.findByRole('heading', { name: '任务看板' });
    expect(within(screen.getByRole('region', { name: '待开始任务' })).getByRole('button', { name: /等待分派的任务/ })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '已完成任务' })).getByRole('button', { name: /已验收的任务/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '筛选任务' }));
    fireEvent.change(screen.getByRole('combobox', { name: '按目标查看' }), { target: { value: 'goal' } });
    expect(screen.queryByRole('button', { name: /等待分派的任务/ })).toBeNull();
    fireEvent.click(within(screen.getByRole('region', { name: '需要你任务' })).getByRole('button', { name: /选择预览布局/ }));
    await screen.findByRole('textbox', { name: '你的回答' });
    fireEvent.click(screen.getByRole('button', { name: '保留终端' }));
    api.update.mockResolvedValue({ task: { ...child, revision: 3, decisions: [{ ...child.decisions[0], status: 'answered', answer: '保留终端' }] } });
    fireEvent.click(screen.getByRole('button', { name: '回复并继续' }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('child', expect.objectContaining({ kind: 'answer', decisionId: 'q', expectedRevision: 2 })));
    fireEvent.click(screen.getByRole('button', { name: '返回看板' }));
    expect(within(screen.getByRole('region', { name: '执行中任务' })).getByRole('button', { name: /选择预览布局/ })).toBeTruthy();
  });
  it('uses the actual container width for a focused mobile detail and keeps the answer on return', async () => {
    vi.stubGlobal('ResizeObserver', class { constructor(private callback: typeof resize) {} observe() { this.callback([{ contentRect: { width: 360 } }]); } disconnect() {} });
    const record = task({ decisions: [{ id: 'q', attemptId: 'attempt', question: '怎么调整？', options: [], status: 'pending', createdAt: 5 }] });
    setup([record], { board: true });
    fireEvent.click(await screen.findByRole('button', { name: /完善预览体验/ }));
    fireEvent.change(await screen.findByRole('textbox', { name: '你的回答' }), { target: { value: '保留原来的终端' } });
    fireEvent.click(screen.getByRole('button', { name: '返回看板' }));
    expect(screen.queryByRole('textbox', { name: '你的回答' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /完善预览体验/ }));
    expect((await screen.findByRole('textbox', { name: '你的回答' }) as HTMLTextAreaElement).value).toBe('保留原来的终端');
    expect(api.update).not.toHaveBeenCalled();
  });
  it('keeps closed tasks out of completed results until explicitly included', async () => {
    setup([task({ id: 'closed', title: '已放弃的任务', status: 'closed' }), task({ id: 'accepted', title: '确认交付的任务', status: 'accepted' })], { board: true });
    await screen.findByRole('heading', { name: '任务看板' });
    expect(screen.queryByRole('button', { name: /已放弃的任务/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '筛选任务' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '含已关闭' }));
    expect(within(screen.getByRole('region', { name: '已完成任务' })).getByRole('button', { name: /已放弃的任务/ })).toBeTruthy();
  });
});

it('shows the real failure on the card and opens the existing explicit retry flow', async () => {
  vi.stubGlobal('ResizeObserver', class { constructor(private callback: typeof resize) {} observe() { this.callback([{ contentRect: { width: 1300 } }]); } disconnect() {} });
  const issue = '无法准备独立执行目录：当前仓库没有可用的提交。';
  const record = task({ automationIssue: issue });
  setup([record], { board: true, sessions: sessions.map(s => ({ ...s, name: `tmux:wt-${s.sessionId}` })) });
  const card = await screen.findByRole('button', { name: /查看原因与处理/ });
  expect(card.textContent).toContain(issue);
  expect(card.textContent).toContain('Codex 1');
  expect(card.textContent).not.toContain('tmux:');
  expect(api.update).not.toHaveBeenCalled();
  fireEvent.click(card);
  await screen.findByRole('button', { name: '重试并继续协调' });
  api.update.mockResolvedValue({ task: { ...record, revision: 3, automationIssue: undefined } });
  fireEvent.click(screen.getByRole('button', { name: '重试并继续协调' }));
  await waitFor(() => expect(api.update).toHaveBeenCalledWith('goal', expect.objectContaining({ kind: 'retry', expectedRevision: 2 })));
});

// Starting a goal, rather than creating its workspace, provisions Agent members.
it('starts a goal from an empty group and keeps the provisioned team on a task-save retry', async () => {
 const team={coordinatorSessionId:'new-lead',reviewerSessionIds:['new-worker']};api.team.mockResolvedValue(team);
 const result=task({title:'改善移动端体验'});api.create.mockRejectedValueOnce(Error('保存失败')).mockResolvedValueOnce({task:result});
 setup([], { group:{...group,sessionIds:[]},sessions:[],agents:[{slug:'codex',displayName:'Codex',command:'codex',accentColor:'var(--primary)',icon:null}],defaultCwd:'/project' });
 fireEvent.change(await screen.findByRole('textbox',{name:'协作目标'}),{target:{value:'改善移动端体验'}});
 const start=screen.getByRole('button',{name:'开始协作'});expect((start as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(start);await screen.findAllByText(/保存失败/);
 expect(api.team).toHaveBeenCalledWith('team',{agentSlug:'codex',cwd:'/project'});
 expect(screen.getByRole('textbox',{name:'协作目标'})).toHaveProperty('value','改善移动端体验');
 fireEvent.click(start);await screen.findByRole('heading',{name:'改善移动端体验'});
 expect(api.team).toHaveBeenCalledTimes(1);expect(api.create).toHaveBeenCalledTimes(2);
 expect(api.create.mock.calls[0][0]).toEqual(api.create.mock.calls[1][0]);
 expect(api.create.mock.calls[1][0]).toMatchObject({coordinatorSessionId:'new-lead',reviewerSessionIds:['new-worker']});
});
