// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TodoWorkspace from './TodoWorkspace';
import { useCollaborationNavigation } from '../../stores/useCollaborationNavigation';
import { useTodoWorkspace } from '../../todos/workspace';
import type { TodoRun, TodoSnapshot } from '../../todos/api';
const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), start: vi.fn(), collect: vi.fn(), save: vi.fn(), defaults: vi.fn(), agents: vi.fn(), settings: vi.fn(), inventory: vi.fn(), peer: 'local' }));
vi.mock('../../terminal/api', () => ({ getAgentLaunchers: mocks.agents, getSettings: mocks.settings, getSessionInventory: mocks.inventory }));
vi.mock('../../todos/api', () => ({ listTodos: mocks.list, createTodo: mocks.create, updateTodo: mocks.update, startTodo: mocks.start, collectTodos: mocks.collect, saveTodoCollector: mocks.save, removeTodoCollector: vi.fn(), saveTodoDefaults: mocks.defaults }));
vi.mock('../../federation/browserIntegration', () => ({ savedConnection: () => ({ targetPeerId: mocks.peer, serviceName: '测试电脑' }), SECURE_STATE_EVENT: 'test-service-change' }));
vi.mock('../sidebar/DirectoryPickerDialog', () => ({ DirectoryPickerDialog: () => null }));
const todo = { id: 'one', title: '检查移动端输入', description: '补充输入法的复现条件', source: '项目巡检', sourceUrl: '', externalId: '', collectorId: null, status: 'open' as const, createdAt: 1, updatedAt: 1, revision: 1 };
let data: TodoSnapshot;
const run = (id = 'one'): TodoRun => ({ id: 'run-' + id, name: todo.title, kind: 'execute', todoId: id, collectorId: null, config: data.defaults, status: 'delivered', sessionId: 'terminal-' + id, result: '', error: '', createdAt: 2, updatedAt: 2 });
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); vi.clearAllMocks(); localStorage.clear(); mocks.peer = 'local';
  data = { todos: [todo, { ...todo, id: 'two', title: '评估语音方案', source: '技术动态' }], collectors: [], runs: [], defaults: { agentSlug: 'codex', command: 'codex', cwd: '/repo', prompt: '先验证再处理' } };
  mocks.list.mockImplementation(async () => structuredClone(data));
  mocks.agents.mockResolvedValue([{ slug: 'claude', command: 'claude', displayName: 'Claude' }, { slug: 'codex', command: 'codex', displayName: 'Codex' }]);
  mocks.settings.mockResolvedValue({ newSessionAgentSlug: 'codex' }); mocks.inventory.mockResolvedValue({ clientSessions: [{ sessionId: 'terminal-one' }] });
  mocks.defaults.mockImplementation(async config => { data.defaults = config; return { defaults: config }; });
  mocks.start.mockImplementation(async id => { const item = run(id); data.runs.push(item); return { run: item }; });
  mocks.update.mockImplementation(async (item, changes) => { const updated = { ...item, ...changes, revision: item.revision + 1 }; data.todos = data.todos.map(todo => todo.id === item.id ? updated : todo); return { todo: updated }; });
  useCollaborationNavigation.setState({ todoOpen: true, todoId: null }); useTodoWorkspace.setState({ views: {}, snapshots: {}, options: {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const setup = () => render(<TodoWorkspace onOpenSidebar={() => {}} leftSidebarVisible />);
const loaded = async () => { await screen.findByText('检查移动端输入'); await waitFor(() => expect(mocks.settings).toHaveBeenCalled()); };
const more = (name: string) => { fireEvent.click(screen.getByRole('button', { name: '待办菜单' })); fireEvent.click(screen.getByRole('menuitem', { name })); };

it('starts with the list and keeps configuration, filters and batch tools out of the default viewport', async () => {
  setup(); await loaded();
  expect(screen.queryByRole('textbox', { name: '搜索待办' })).toBeNull();
  expect(screen.queryByRole('combobox', { name: '按来源筛选' })).toBeNull();
  expect(screen.queryByRole('button', { name: '执行设置' })).toBeNull();
  expect(screen.queryByRole('button', { name: /^收集方向/ })).toBeNull();
  expect(screen.getByRole('button', { name: '收集待办' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '新增待办' })).toBeTruthy();
  more('搜索和筛选');
  fireEvent.change(screen.getByRole('textbox', { name: '搜索待办' }), { target: { value: '找不到的事项' } });
  expect(screen.getByText('没有匹配的待办')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
  expect(screen.queryByRole('textbox', { name: '搜索待办' })).toBeNull();
  expect(screen.getByText('检查移动端输入')).toBeTruthy();
});
it('focuses the mobile result on confirmation, returns to the list after completion and offers undo', async () => {
  data.todos = [todo]; data.runs = [{ ...run(), status: 'complete', result: '移动端输入已验证' }];
  setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '查看结果 检查移动端输入' }));
  expect(screen.getByText('移动端输入已验证')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '新增待办' })).toBeNull();
  expect(screen.queryByRole('button', { name: '返回终端' })).toBeNull();
  expect(screen.queryByRole('button', { name: '重新发起' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '确认完成' }));
  await screen.findByText('清单已清空');
  expect(data.todos[0].status).toBe('completed');
  expect(useTodoWorkspace.getState().views.local.mobileDetail).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '撤销' }));
  await screen.findByRole('button', { name: '查看结果 检查移动端输入' });
  expect(data.todos[0].status).toBe('open');
});
it('starts configured collectors from the list with one action and keeps the user in the inbox', async () => {
  data.collectors = ['one', 'two'].map(id => ({ id, name: id, config: data.defaults, enabled: true, schedule: null, nextRunAt: null, revision: 1, createdAt: 1, updatedAt: 1 }));
  mocks.collect.mockResolvedValue({ run: {} }); setup(); await loaded();
  fireEvent.click(screen.getByRole('button', { name: '收集待办' }));
  await waitFor(() => expect(mocks.collect).toHaveBeenCalledTimes(2));
  expect(useTodoWorkspace.getState().views.local.tab).toBe('todos');
  expect(screen.getByRole('button', { name: '新增待办' })).toBeTruthy();
});
it('reuses a saved collection choice for first execution without asking for the same Agent and directory again', async () => {
  data.defaults = { agentSlug: '', command: '', cwd: '', prompt: '' };
  data.collectors = [{ id: 'direction', name: '项目巡检', config: { agentSlug: 'codex', command: 'codex', cwd: '/project', prompt: '只收集，不执行' }, enabled: true, schedule: null, nextRunAt: null, revision: 1, createdAt: 1, updatedAt: 1 }];
  setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '处理 检查移动端输入' }));
  await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(mocks.start.mock.calls[0][1]).toEqual({ agentSlug: 'codex', command: 'codex', cwd: '/project', prompt: '' });
  expect(mocks.defaults).toHaveBeenCalledOnce();
});
it('does not offer to batch launch tasks that are already dispatched or waiting for confirmation', async () => {
  data.runs = [run('one'), { ...run('two'), status: 'complete', result: '结果已提交' }];
  setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '待办菜单' }));
  expect((screen.getByRole('menuitem', { name: '多选待办' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(mocks.start).not.toHaveBeenCalled();
});

it('keeps dispatched and reported todos in the default unfinished list with a direct result entry', async () => {
  data.runs = [{ ...run(), status: 'complete', result: '输入问题已处理' }]; setup(); await loaded();
  expect(screen.getByRole('button', { name: '查看结果 检查移动端输入' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '查看结果 检查移动端输入' }));
  expect(screen.getByText('输入问题已处理')).toBeTruthy();
  expect(screen.getByRole('button', { name: '确认完成' })).toBeTruthy();
  expect(data.todos[0].status).toBe('open');
});
it('uses remembered configuration to launch with one click and offers the terminal without another launch', async () => {
  setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '处理 检查移动端输入' }));
  await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
  expect(mocks.start).toHaveBeenCalledWith('one', data.defaults, expect.any(String));
  expect(screen.queryByRole('dialog')).toBeNull();
  await screen.findByRole('button', { name: '打开终端 检查移动端输入' });
  const switched = vi.fn(); window.addEventListener('switch-terminal-session', switched);
  fireEvent.click(screen.getByRole('button', { name: '打开终端 检查移动端输入' }));
  await waitFor(() => expect(switched).toHaveBeenCalled()); window.removeEventListener('switch-terminal-session', switched);
  expect(mocks.start).toHaveBeenCalledOnce();
});
it('uses each collection direction directory when processing mixed projects with the remembered Agent', async () => {
  data.collectors = ['one', 'two'].map(id => ({ id: 'collector-' + id, name: id, config: { ...data.defaults, cwd: '/projects/' + id }, enabled: true, schedule: null, nextRunAt: null, revision: 1, createdAt: 1, updatedAt: 1 }));
  data.todos = data.todos.map(item => ({ ...item, collectorId: 'collector-' + item.id }));
  setup(); await loaded(); more('多选待办');
  fireEvent.click(screen.getByRole('checkbox', { name: '选择 检查移动端输入' })); fireEvent.click(screen.getByRole('checkbox', { name: '选择 评估语音方案' }));
  fireEvent.click(screen.getByRole('button', { name: '批量处理' }));
  await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2));
  expect(mocks.start.mock.calls.map(call => [call[0], call[1].agentSlug, call[1].cwd])).toEqual([['one', 'codex', '/projects/one'], ['two', 'codex', '/projects/two']]);
  expect(data.defaults.cwd).toBe('/repo');
});
it('restores each failed project configuration and request key when retrying a mixed batch', async () => {
  data.collectors = ['one', 'two'].map(id => ({ id: 'collector-' + id, name: id, config: { ...data.defaults, cwd: '/projects/' + id }, enabled: true, schedule: null, nextRunAt: null, revision: 1, createdAt: 1, updatedAt: 1 }));
  data.todos = data.todos.map(item => ({ ...item, collectorId: 'collector-' + item.id }));
  mocks.start.mockRejectedValueOnce(new Error('断线')).mockRejectedValueOnce(new Error('断线')).mockImplementation(async id => ({ run: run(id) }));
  setup(); await loaded(); more('多选待办');
  fireEvent.click(screen.getByRole('checkbox', { name: '选择 检查移动端输入' })); fireEvent.click(screen.getByRole('checkbox', { name: '选择 评估语音方案' }));
  fireEvent.click(screen.getByRole('button', { name: '批量处理' })); const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(dialog.getAttribute('aria-busy')).toBe('false'));
  fireEvent.click(within(dialog).getByRole('button', { name: '启动 Agent' }));
  await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(4));
  expect(mocks.start.mock.calls.slice(2)).toEqual(mocks.start.mock.calls.slice(0, 2));
});
it('inherits the normal Agent preference for first setup and remembers the execution choice by default', async () => {
  data.defaults = { agentSlug: '', command: '', cwd: '', prompt: '' }; setup(); await loaded();
  fireEvent.click(screen.getByRole('button', { name: '处理 检查移动端输入' })); const dialog = screen.getByRole('dialog');
  expect((within(dialog).getByLabelText('Agent') as HTMLSelectElement).value).toBe('codex');
  expect((within(dialog).getByRole('checkbox', { name: '记住配置，下次直接处理' }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(within(dialog).getByRole('button', { name: '启动 Agent' }));
  await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce()); expect(mocks.defaults).toHaveBeenCalledOnce();
});
it('preserves an open draft and current view when the responsive workspace remounts', async () => {
  const first = setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '新增待办' }));
  fireEvent.change(screen.getByLabelText('要做什么'), { target: { value: '旋转手机后保留草稿' } });
  first.unmount(); setup();
  expect(await screen.findByDisplayValue('旋转手机后保留草稿')).toBeTruthy(); expect(screen.getByRole('dialog', { name: '新增待办' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '取消' })); expect(mocks.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '新增待办' })); expect(screen.getByDisplayValue('旋转手机后保留草稿')).toBeTruthy();
});
it('returns directly to the current terminal and restores the todo view when reopened', async () => {
  const first = setup(); await loaded();
  more('搜索和筛选');
  fireEvent.change(screen.getByRole('textbox', { name: '搜索待办' }), { target: { value: '移动端' } });
  fireEvent.click(screen.getByRole('button', { name: /检查移动端输入 项目巡检/ }));
  fireEvent.click(screen.getByRole('button', { name: '返回清单' }));
  fireEvent.click(screen.getByRole('button', { name: '返回终端' }));
  expect(useCollaborationNavigation.getState().todoOpen).toBe(false);
  expect(mocks.start).not.toHaveBeenCalled();
  first.unmount(); useCollaborationNavigation.getState().openTodos(); setup();
  expect((screen.getByRole('textbox', { name: '搜索待办' }) as HTMLInputElement).value).toBe('移动端');
  expect(useTodoWorkspace.getState().views.local.selectedId).toBe('one');
});
it('creates a todo and starts processing from the same form with the saved configuration', async () => {
  mocks.create.mockImplementation(async input => { const created = { ...todo, ...input, id: 'new' }; data.todos.unshift(created); return { todo: created }; });
  setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '新增待办' }));
  fireEvent.change(screen.getByLabelText('要做什么'), { target: { value: '立即处理这件事' } }); fireEvent.click(screen.getByRole('button', { name: '保存并处理' }));
  await waitFor(() => expect(mocks.start).toHaveBeenCalledWith('new', data.defaults, expect.any(String)));
  expect(data.todos.some(t => t.id === 'new')).toBe(true);
});
it('opens first collection setup directly and saves and runs it without leaving the todo list', async () => {
  mocks.save.mockImplementation(async input => { const collector = { ...input, id: 'collector', createdAt: 1, updatedAt: 1, nextRunAt: null, revision: 1 }; data.collectors.push(collector); return { collector }; });
  mocks.collect.mockResolvedValue({ run: {} }); setup(); await loaded();
  fireEvent.click(screen.getByRole('button', { name: '收集待办' }));
  const dialog = screen.getByRole('dialog', { name: '添加收集方向' }); fireEvent.click(within(dialog).getByRole('button', { name: '项目巡检' }));
  fireEvent.click(within(dialog).getByRole('button', { name: '保存并收集' }));
  await waitFor(() => expect(mocks.collect).toHaveBeenCalledWith('collector', expect.any(String)));
  expect(data.collectors[0].config.prompt).toContain('检查工作目录');
});
it('offers current and recent session directories without typing and restores the last collection choice after reload', async () => {
  mocks.inventory.mockResolvedValue({ clientSessions: [{ sessionId: 'active', cwd: '/work/current', lastActivity: 2 }, { sessionId: 'other', cwd: '/work/recent', lastActivity: 1 }] });
  mocks.save.mockImplementation(async input => { const collector = { ...input, id: 'saved', createdAt: 1, updatedAt: 1, nextRunAt: null, revision: 1 }; data.collectors.push(collector); return { collector }; });
  const first = render(<TodoWorkspace onOpenSidebar={() => {}} leftSidebarVisible activeSessionId="active" />);
  await loaded(); more('收集方向'); fireEvent.click(screen.getByRole('button', { name: '添加方向' }));
  fireEvent.click(screen.getByRole('button', { name: '技术动态' }));
  fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'claude' } });
  fireEvent.click(screen.getByRole('button', { name: '使用目录 /work/recent' }));
  expect((screen.getByLabelText('工作目录') as HTMLInputElement).value).toBe('/work/recent');
  expect(screen.getByRole('button', { name: '使用目录 /work/current' }).textContent).toContain('当前');
  fireEvent.click(screen.getByRole('button', { name: '仅保存' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); first.unmount();
  useTodoWorkspace.setState({ views: {}, snapshots: {}, options: {} }); setup(); await loaded();
  more('收集方向'); fireEvent.click(screen.getByRole('button', { name: '添加方向' }));
  expect((screen.getByLabelText('Agent') as HTMLSelectElement).value).toBe('claude');
  expect((screen.getByLabelText('工作目录') as HTMLInputElement).value).toBe('/work/recent');
  expect((screen.getByLabelText('收集要求') as HTMLTextAreaElement).value).toBe('');
  expect(data.defaults.agentSlug).toBe('codex');
});
it('uses the normal Agent preference when detection finishes after the user starts a collection draft', async () => {
  let detected!: (value: unknown) => void;
  mocks.agents.mockReturnValue(new Promise(resolve => { detected = resolve; }));
  data.defaults = { agentSlug: '', command: '', cwd: '', prompt: '' };
  setup(); await screen.findByText('检查移动端输入');
  more('收集方向'); fireEvent.click(screen.getByRole('button', { name: '添加方向' }));
  fireEvent.click(screen.getByRole('button', { name: '项目巡检' }));
  expect((screen.getByLabelText('收集方向') as HTMLInputElement).value).toBe('项目巡检');
  await act(async () => detected([{ slug: 'claude', command: 'claude', displayName: 'Claude' }, { slug: 'codex', command: 'codex', displayName: 'Codex' }]));
  await waitFor(() => expect((screen.getByLabelText('Agent') as HTMLSelectElement).value).toBe('codex'));
  expect((screen.getByLabelText('收集方向') as HTMLInputElement).value).toBe('项目巡检');
  expect(screen.getByRole('button', { name: '保存并收集' }).hasAttribute('disabled')).toBe(false);
});
it('uses explicit selection mode for batch actions, while the normal circle completes a todo', async () => {
  mocks.update.mockImplementation(async (item, change) => { data.todos = data.todos.map(t => t.id === item.id ? { ...t, ...change, revision: 2 } : t); return { todo: data.todos[0] }; });
  setup(); await loaded(); expect(screen.queryByRole('checkbox')).toBeNull();
  more('多选待办'); fireEvent.click(screen.getByRole('checkbox', { name: '选择 检查移动端输入' })); fireEvent.click(screen.getByRole('checkbox', { name: '选择 评估语音方案' }));
  fireEvent.click(screen.getByRole('button', { name: '批量处理' })); await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2));
  expect(mocks.start.mock.calls.map(c => c[0])).toEqual(['one', 'two']);
});
it('keeps an uncertain launch request key through remounts and retries only the same intent', async () => {
  mocks.start.mockRejectedValueOnce(new Error('连接已断开')).mockImplementation(async id => ({ run: run(id) }));
  const first = setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '处理 检查移动端输入' }));
  await screen.findByRole('dialog'); await waitFor(() => expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('false'));
  const originalKey = mocks.start.mock.calls[0][2]; first.unmount(); setup();
  const dialog = await screen.findByRole('dialog'); fireEvent.click(within(dialog).getByRole('button', { name: '启动 Agent' }));
  await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2)); expect(mocks.start.mock.calls[1][2]).toBe(originalKey);
});
it('retains the chosen configuration and retries only failed items after a partial batch launch', async () => {
  let failed = false;
  mocks.start.mockImplementation(async id => {
    if (id === 'two' && !failed) { failed = true; throw new Error('连接已断开'); }
    const item = run(id); data.runs.push(item); return { run: item };
  });
  setup(); await loaded();
  more('多选待办');
  fireEvent.click(screen.getByRole('checkbox', { name: '选择 检查移动端输入' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '选择 评估语音方案' }));
  fireEvent.click(screen.getByRole('button', { name: '批量处理' }));
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(dialog.getAttribute('aria-busy')).toBe('false'));
  expect((within(dialog).getByLabelText('工作目录') as HTMLInputElement).value).toBe('/repo');
  expect((within(dialog).getByLabelText('处理要求') as HTMLTextAreaElement).value).toBe('先验证再处理');
  fireEvent.click(within(dialog).getByRole('button', { name: '启动 Agent' }));
  await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(3));
  expect(mocks.start.mock.calls.map(c => c[0])).toEqual(['one', 'two', 'two']);
  expect(mocks.start.mock.calls[2][2]).toBe(mocks.start.mock.calls[1][2]);
});
it('does not apply a delayed mutation response after switching services', async () => {
  let resolve!: (value: unknown) => void; mocks.create.mockReturnValue(new Promise(r => { resolve = r; }));
  setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '新增待办' })); fireEvent.change(screen.getByLabelText('要做什么'), { target: { value: '旧服务草稿' } }); fireEvent.click(screen.getByRole('button', { name: '仅保存' }));
  mocks.peer = 'other'; await act(async () => resolve({ todo: { ...todo, id: 'old-result' } }));
  expect(useTodoWorkspace.getState().views.local.selectedId).toBeNull();
});
