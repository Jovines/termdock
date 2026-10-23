// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TodoWorkspace from './TodoWorkspace';
import { useCollaborationNavigation } from '../../stores/useCollaborationNavigation';
import { useSessionDirectoryStore } from '../../stores/useSessionDirectory';
import { useTodoWorkspace } from '../../todos/workspace';
import type { TodoRun, TodoSnapshot } from '../../todos/api';
const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), start: vi.fn(), handoff: vi.fn(), collect: vi.fn(), save: vi.fn(), defaults: vi.fn(), agents: vi.fn(), settings: vi.fn(), inventory: vi.fn(), peer: 'local' }));
vi.mock('../../terminal/api', () => ({ getAgentLaunchers: mocks.agents, getSettings: mocks.settings, getSessionInventory: mocks.inventory }));
vi.mock('../../todos/api', () => ({ listTodos: mocks.list, createTodo: mocks.create, updateTodo: mocks.update, startTodo: mocks.start, handoffTodos: mocks.handoff, collectTodos: mocks.collect, saveTodoCollector: mocks.save, removeTodoCollector: vi.fn(), saveTodoDefaults: mocks.defaults }));
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
  mocks.settings.mockResolvedValue({ newSessionAgentSlug: 'codex' }); useSessionDirectoryStore.getState().replace([{ sessionId: 'terminal-one', name: '项目会话', customName: true, lastActivity: 10, cwd: '/repo', agent: { slug: 'codex', displayName: 'Codex', accentColor: 'var(--primary)', icon: null } }]);
  mocks.defaults.mockImplementation(async config => { data.defaults = config; return { defaults: config }; });
  mocks.handoff.mockImplementation(async input => { const item = { ...run(input.todoIds[0]), sessionId: input.sessionId || 'new-session', handoff: { todoIds: input.todoIds, note: input.note, targetSessionId: input.sessionId || null, sessionName: input.sessionId ? '项目会话' : '新会话' } }; data.runs.push(item); return { run: item }; });
  mocks.start.mockImplementation(async id => { const item = run(id); data.runs.push(item); return { run: item }; });
  mocks.update.mockImplementation(async (item, changes) => { const updated = { ...item, ...changes, revision: item.revision + 1 }; data.todos = data.todos.map(todo => todo.id === item.id ? updated : todo); return { todo: updated }; });
  useCollaborationNavigation.setState({ todoOpen: true, todoId: null }); useTodoWorkspace.setState({ views: {}, snapshots: {}, options: {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const setup = () => render(<TodoWorkspace onOpenSidebar={() => {}} leftSidebarVisible />);
const loaded = async () => { await screen.findByText('检查移动端输入'); await waitFor(() => expect(mocks.settings).toHaveBeenCalled()); };
const more = (name: string) => { fireEvent.click(screen.getByRole('button', { name: '待办菜单' })); fireEvent.click(screen.getByRole('menuitem', { name })); };


it('keeps the default list minimal and exposes handoff directly instead of execution settings', async () => {
  setup(); await loaded();
  expect(screen.getByRole('button', { name: '交给会话 检查移动端输入' })).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: '搜索待办' })).toBeNull();
  more('搜索和筛选');
  expect(screen.queryByRole('option', { name: '待确认' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
  fireEvent.click(screen.getByRole('button', { name: '待办菜单' }));
  expect(screen.queryByRole('menuitem', { name: '执行设置' })).toBeNull();
});
it('sends a todo with a supplemental note to the selected existing session and navigates there', async () => {
  const navigate = vi.fn(); window.addEventListener('switch-terminal-session', navigate);
  setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '交给会话 检查移动端输入' }));
  const note = await screen.findByRole('textbox', { name: /补充一句话/ });
  fireEvent.change(note, { target: { value: '先分析，不改代码' } });
  expect((screen.getByRole('combobox', { name: '交给谁' }) as HTMLSelectElement).value).toBe('terminal-one');
  fireEvent.click(screen.getByRole('button', { name: '发送并进入会话' }));
  await waitFor(() => expect(mocks.handoff).toHaveBeenCalledOnce());
  await waitFor(() => expect(navigate).toHaveBeenCalled());
  expect(mocks.handoff.mock.calls[0][0]).toMatchObject({ todoIds: ['one'], sessionId: 'terminal-one', note: '先分析，不改代码' });
  expect(mocks.start).not.toHaveBeenCalled(); expect(data.todos[0].status).toBe('open');
  window.removeEventListener('switch-terminal-session', navigate);
});
it('creates a session from remembered configuration without asking for required settings again', async () => {
  useSessionDirectoryStore.getState().replace([]); setup(); await loaded();
  fireEvent.click(screen.getByRole('button', { name: '交给会话 检查移动端输入' }));
  await screen.findByRole('button', { name: '发送并进入会话' });
  fireEvent.click(screen.getByRole('button', { name: '发送并进入会话' }));
  await waitFor(() => expect(mocks.handoff).toHaveBeenCalledOnce());
  expect(mocks.handoff.mock.calls[0][0]).toMatchObject({ config: { agentSlug: 'codex', command: 'codex', cwd: '/repo', prompt: '' }, note: '' });
});
it('sends multiple selected todos together in one handoff with a common note', async () => {
  setup(); await loaded(); more('多选待办');
  fireEvent.click(screen.getByRole('checkbox', { name: '选择 检查移动端输入' })); fireEvent.click(screen.getByRole('checkbox', { name: '选择 评估语音方案' }));
  fireEvent.click(screen.getByRole('button', { name: '交给会话' }));
  fireEvent.change(await screen.findByRole('textbox', { name: /补充一句话/ }), { target: { value: '一起分析' } });
  fireEvent.click(screen.getByRole('button', { name: '发送并进入会话' }));
  await waitFor(() => expect(mocks.handoff).toHaveBeenCalledOnce()); expect(mocks.handoff.mock.calls[0][0]).toMatchObject({ todoIds: ['one', 'two'], note: '一起分析' });
});
it('retains note and recipient after cancellation and responsive remount, without sending anything', async () => {
  const view = setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '交给会话 检查移动端输入' }));
  fireEvent.change(await screen.findByRole('textbox', { name: /补充一句话/ }), { target: { value: '尚未发送的要求' } });
  fireEvent.click(screen.getByRole('button', { name: '取消' })); view.unmount();
  setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '交给会话 检查移动端输入' }));
  expect((await screen.findByRole('textbox', { name: /补充一句话/ }) as HTMLTextAreaElement).value).toBe('尚未发送的要求');
  expect(mocks.handoff).not.toHaveBeenCalled();
});
it('keeps a failed send editable and reuses its stable request key when the outcome is unknown', async () => {
  mocks.handoff.mockRejectedValue(new Error('网络断开'));
  const view = setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '交给会话 检查移动端输入' }));
  fireEvent.change(await screen.findByRole('textbox', { name: /补充一句话/ }), { target: { value: '保持原要求' } });
  fireEvent.click(screen.getByRole('button', { name: '发送并进入会话' })); await screen.findByRole('alert');
  view.unmount(); setup(); await screen.findByRole('button', { name: '发送并进入会话' });
  fireEvent.click(screen.getByRole('button', { name: '发送并进入会话' }));
  await waitFor(() => expect(mocks.handoff).toHaveBeenCalledTimes(2));
  expect(mocks.handoff.mock.calls[1][0]).toEqual(mocks.handoff.mock.calls[0][0]);
});
it('links every member of a handed-off batch to the same session without requiring a report', async () => {
  data.runs = [{ ...run(), handoff: { todoIds: ['one', 'two'], note: '共用要求', targetSessionId: 'terminal-one', sessionName: '项目会话' } }];
  setup(); await loaded(); expect(screen.getAllByRole('button', { name: /^去会话 / })).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: '检查移动端输入 已交给 项目会话 · 项目巡检' }));
  expect(screen.getByText('共用要求')).toBeTruthy(); expect(screen.queryByRole('button', { name: '确认完成' })).toBeNull();
});
it('marks completion directly and allows undo without requiring a model report', async () => {
  data.todos = [todo]; setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '完成 检查移动端输入' }));
  await screen.findByText('清单已清空'); fireEvent.click(screen.getByRole('button', { name: '撤销' }));
  await screen.findByRole('button', { name: '交给会话 检查移动端输入' });
});
it('offers a new handoff when the previously linked session has closed', async () => {
  data.runs = [run()]; useSessionDirectoryStore.getState().replace([]);
  setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '去会话 检查移动端输入' }));
  await screen.findByRole('button', { name: '发送并进入会话' });
  expect((screen.getByRole('combobox', { name: '交给谁' }) as HTMLSelectElement).value).toBe('__new__');
  expect(mocks.handoff).not.toHaveBeenCalled();
});
it('keeps one-click collection for multiple enabled directions', async () => {
  data.collectors = ['one', 'two'].map(id => ({ id, name: id, config: data.defaults, enabled: true, schedule: null, nextRunAt: null, revision: 1, createdAt: 1, updatedAt: 1 }));
  mocks.collect.mockResolvedValue({ run: {} }); setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '收集待办' }));
  await waitFor(() => expect(mocks.collect).toHaveBeenCalledTimes(2)); expect(useTodoWorkspace.getState().views.local?.tab ?? 'todos').toBe('todos');
});
it('does not navigate on a delayed handoff response after switching services', async () => {
  let complete!: (value: { run: TodoRun }) => void;
  mocks.handoff.mockReturnValue(new Promise(resolve => complete = resolve));
  const navigate = vi.fn(); window.addEventListener('switch-terminal-session', navigate);
  setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '交给会话 检查移动端输入' })); await screen.findByRole('button', { name: '发送并进入会话' });
  fireEvent.click(screen.getByRole('button', { name: '发送并进入会话' }));
  mocks.peer = 'other'; act(() => window.dispatchEvent(new Event('test-service-change'))); await act(async () => complete({ run: run() }));
  expect(navigate).not.toHaveBeenCalled(); window.removeEventListener('switch-terminal-session', navigate);
});

it('uses the shared live directory for an open recipient selector and follows renames without another inventory fetch', async () => {
  setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '交给会话 检查移动端输入' }));
  await screen.findByRole('button', { name: '发送并进入会话' });
  fireEvent.change(screen.getByRole('textbox', { name: /补充一句话/ }), { target: { value: '保留补充' } });
  act(() => useSessionDirectoryStore.getState().replace([{ sessionId: 'terminal-one', name: '实际会话新名称', customName: true, lastActivity: 20, agent: { slug: 'codex', displayName: 'Codex', accentColor: 'var(--primary)', icon: null } }]));
  expect(screen.getByRole('option', { name: /实际会话新名称/ })).toBeTruthy();
  expect((screen.getByRole('textbox', { name: /补充一句话/ }) as HTMLTextAreaElement).value).toBe('保留补充');
  expect(mocks.inventory).not.toHaveBeenCalled();
});
