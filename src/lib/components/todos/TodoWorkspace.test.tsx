// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TodoWorkspace from './TodoWorkspace';
import { TodoSessionDropTarget, TODO_DRAG_TYPE, useTodoRecipientSelection } from './TodoSessionDropTarget';
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function TestSidebar() {
  const selection = useTodoRecipientSelection();
  return <><TodoSessionDropTarget sessionId="terminal-one" selecting={!!selection}><button>侧栏项目会话</button></TodoSessionDropTarget></>;
}
const setup = (onOpenSidebar = () => {}, visible = true) => render(<><TestSidebar /><TodoWorkspace onOpenSidebar={onOpenSidebar} leftSidebarVisible={visible} /></>);
const pickRecipient = async () => {
  await waitFor(() => expect(useTodoWorkspace.getState().views.local?.modal?.kind).toBe('recipient'));
  fireEvent.click(screen.getByRole('button', { name: useSessionDirectoryStore.getState().records.length ? '侧栏项目会话' : '新建会话' }));
};
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
  setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '交给会话 检查移动端输入' })); await pickRecipient();
  const note = await screen.findByRole('textbox', { name: /补充一句话/ });
  fireEvent.change(note, { target: { value: '先分析，不改代码' } });
  expect(within(screen.getByRole('dialog')).getByText('项目会话')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '发送并进入会话' }));
  await waitFor(() => expect(mocks.handoff).toHaveBeenCalledOnce());
  await waitFor(() => expect(navigate).toHaveBeenCalled());
  expect(mocks.handoff.mock.calls[0][0]).toMatchObject({ todoIds: ['one'], sessionId: 'terminal-one', note: '先分析，不改代码' });
  expect(mocks.start).not.toHaveBeenCalled(); expect(data.todos[0].status).toBe('open');
  window.removeEventListener('switch-terminal-session', navigate);
});
it('creates a session from remembered configuration without asking for required settings again', async () => {
  useSessionDirectoryStore.getState().replace([]); setup(); await loaded();
  fireEvent.click(screen.getByRole('button', { name: '交给会话 检查移动端输入' })); await pickRecipient();
  await screen.findByRole('button', { name: '发送并进入会话' });
  fireEvent.click(screen.getByRole('button', { name: '发送并进入会话' }));
  await waitFor(() => expect(mocks.handoff).toHaveBeenCalledOnce());
  expect(mocks.handoff.mock.calls[0][0]).toMatchObject({ config: { agentSlug: 'codex', command: 'codex', cwd: '/repo', prompt: '' }, note: '' });
});
it('sends multiple selected todos together in one handoff with a common note', async () => {
  setup(); await loaded(); more('多选待办');
  fireEvent.click(screen.getByRole('checkbox', { name: '选择 检查移动端输入' })); fireEvent.click(screen.getByRole('checkbox', { name: '选择 评估语音方案' }));
  fireEvent.click(screen.getByRole('button', { name: '交给会话' })); await pickRecipient();
  fireEvent.change(await screen.findByRole('textbox', { name: /补充一句话/ }), { target: { value: '一起分析' } });
  fireEvent.click(screen.getByRole('button', { name: '发送并进入会话' }));
  await waitFor(() => expect(mocks.handoff).toHaveBeenCalledOnce()); expect(mocks.handoff.mock.calls[0][0]).toMatchObject({ todoIds: ['one', 'two'], note: '一起分析' });
});
it('retains note and recipient after cancellation and responsive remount, without sending anything', async () => {
  const view = setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '交给会话 检查移动端输入' })); await pickRecipient();
  fireEvent.change(await screen.findByRole('textbox', { name: /补充一句话/ }), { target: { value: '尚未发送的要求' } });
  fireEvent.click(screen.getByRole('button', { name: '取消' })); view.unmount();
  setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '交给会话 检查移动端输入' })); await pickRecipient();
  expect((await screen.findByRole('textbox', { name: /补充一句话/ }) as HTMLTextAreaElement).value).toBe('尚未发送的要求');
  expect(mocks.handoff).not.toHaveBeenCalled();
});
it('keeps a failed send editable and reuses its stable request key when the outcome is unknown', async () => {
  mocks.handoff.mockRejectedValue(new Error('网络断开'));
  const view = setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '交给会话 检查移动端输入' })); await pickRecipient();
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
  fireEvent.click(screen.getByRole('button', { name: '检查移动端输入' }));
  expect(screen.getByText('共用要求')).toBeTruthy(); expect(screen.queryByRole('button', { name: '确认完成' })).toBeNull();
});
it('marks completion directly and allows undo without requiring a model report', async () => {
  data.todos = [todo]; setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '完成 检查移动端输入' }));
  await screen.findByText('待完成已清空'); fireEvent.click(screen.getByRole('button', { name: '撤销' }));
  await screen.findByRole('button', { name: '交给会话 检查移动端输入' });
});
it('offers a new handoff when the previously linked session has closed', async () => {
  data.runs = [run()]; useSessionDirectoryStore.getState().replace([]);
  setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '去会话 检查移动端输入' })); await pickRecipient();
  await screen.findByRole('button', { name: '发送并进入会话' });
  expect(within(screen.getByRole('dialog')).getByText('新建会话')).toBeTruthy();
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
  setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '交给会话 检查移动端输入' })); await pickRecipient(); await screen.findByRole('button', { name: '发送并进入会话' });
  fireEvent.click(screen.getByRole('button', { name: '发送并进入会话' }));
  mocks.peer = 'other'; act(() => window.dispatchEvent(new Event('test-service-change'))); await act(async () => complete({ run: run() }));
  expect(navigate).not.toHaveBeenCalled(); window.removeEventListener('switch-terminal-session', navigate);
});

it('uses the shared live directory for an open recipient selector and follows renames without another inventory fetch', async () => {
  setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '交给会话 检查移动端输入' })); await pickRecipient();
  await screen.findByRole('button', { name: '发送并进入会话' });
  fireEvent.change(screen.getByRole('textbox', { name: /补充一句话/ }), { target: { value: '保留补充' } });
  act(() => useSessionDirectoryStore.getState().replace([{ sessionId: 'terminal-one', name: '实际会话新名称', customName: true, lastActivity: 20, agent: { slug: 'codex', displayName: 'Codex', accentColor: 'var(--primary)', icon: null } }]));
  expect(within(screen.getByRole('dialog')).getByText('实际会话新名称')).toBeTruthy();
  expect((screen.getByRole('textbox', { name: /补充一句话/ }) as HTMLTextAreaElement).value).toBe('保留补充');
  expect(mocks.inventory).not.toHaveBeenCalled();
});

const dropTransfer = (payload: unknown, types = [TODO_DRAG_TYPE]) => ({ types, getData: () => JSON.stringify(payload), dropEffect: '' });
it('uses the sidebar directly from the card, overriding an older draft and keeping the note optional', async () => {
  useTodoWorkspace.getState().draft('local', 'handoff:["one"]', { target: 'stale-session', note: '', config: data.defaults });
  setup(); await loaded();
  fireEvent.click(screen.getByRole('button', { name: '交给会话 检查移动端输入' })); await pickRecipient();
  await screen.findByRole('dialog');
  expect(within(screen.getByRole('dialog')).queryByLabelText('交接会话列表')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '发送并进入会话' }));
  await waitFor(() => expect(mocks.handoff).toHaveBeenCalledOnce());
  expect(mocks.handoff.mock.calls[0][0]).toMatchObject({ sessionId: 'terminal-one', note: '' });
});
it('opens a confirmation after dropping a todo, cancels without sending, then sends the optional note', async () => {
  setup(); await loaded();
  render(<TodoSessionDropTarget sessionId="terminal-one"><button>侧栏目标</button></TodoSessionDropTarget>);
  const source = screen.getByRole('button', { name: '交给会话 检查移动端输入' }).closest('article')!;
  const values = new Map<string, string>();
  const transfer = { types: [TODO_DRAG_TYPE], setData: (type: string, value: string) => values.set(type, value), getData: (type: string) => values.get(type), effectAllowed: '', dropEffect: '' };
  fireEvent.dragStart(source, { dataTransfer: transfer });
  fireEvent.drop(screen.getByText('侧栏目标'), { dataTransfer: transfer });
  await screen.findByRole('dialog'); expect(mocks.handoff).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '取消' })); expect(mocks.handoff).not.toHaveBeenCalled();
  fireEvent.drop(screen.getByText('侧栏目标'), { dataTransfer: transfer });
  fireEvent.change(await screen.findByRole('textbox', { name: /补充一句话/ }), { target: { value: '和已有问题一起分析' } });
  fireEvent.click(screen.getByRole('button', { name: '发送并进入会话' }));
  await waitFor(() => expect(mocks.handoff).toHaveBeenCalledOnce());
  expect(mocks.handoff.mock.calls[0][0]).toMatchObject({ sessionId: 'terminal-one', todoIds: ['one'], note: '和已有问题一起分析' });
});
it.each([
  { workspace: 'other-service', ids: ['one'] },
  { workspace: 'local', ids: ['missing'] },
  { workspace: 'local', ids: [] },
])('ignores a foreign or stale todo drag: %j', async payload => {
  setup(); await loaded(); render(<TodoSessionDropTarget sessionId="terminal-one"><button>侧栏目标</button></TodoSessionDropTarget>);
  fireEvent.drop(screen.getByText('侧栏目标'), { dataTransfer: dropTransfer(payload) });
  expect(screen.queryByRole('dialog')).toBeNull(); expect(mocks.handoff).not.toHaveBeenCalled();
});
it('rejects dropped completed todos and targets that have lost their Agent identity', async () => {
  data.todos[0] = { ...data.todos[0], status: 'completed' }; setup(); await screen.findByText('评估语音方案');
  render(<TodoSessionDropTarget sessionId="terminal-one"><button>侧栏目标</button></TodoSessionDropTarget>);
  fireEvent.drop(screen.getByText('侧栏目标'), { dataTransfer: dropTransfer({ workspace: 'local', ids: ['one'] }) });
  expect(screen.queryByRole('dialog')).toBeNull();
  act(() => useSessionDirectoryStore.getState().replace([]));
  fireEvent.drop(screen.getByText('侧栏目标'), { dataTransfer: dropTransfer({ workspace: 'local', ids: ['two'] }) });
  expect(screen.queryByRole('dialog')).toBeNull(); expect(mocks.handoff).not.toHaveBeenCalled();
});

it('can choose and send to an existing session while Agent launch options are still loading', async () => {
  mocks.agents.mockReturnValue(new Promise(() => {}));
  setup(); await screen.findByText('检查移动端输入');
  fireEvent.click(screen.getByRole('button', { name: '交给会话 检查移动端输入' })); await pickRecipient();
  fireEvent.click(screen.getByRole('button', { name: '发送并进入会话' }));
  await waitFor(() => expect(mocks.handoff).toHaveBeenCalledOnce());
  expect(mocks.handoff.mock.calls[0][0]).toMatchObject({ sessionId: 'terminal-one', note: '' });
});
it('disables confirmation when the chosen recipient disappears from the shared directory', async () => {
  setup(); await loaded();
  fireEvent.click(screen.getByRole('button', { name: '交给会话 检查移动端输入' })); await pickRecipient();
  await screen.findByRole('dialog');
  act(() => useSessionDirectoryStore.getState().replace([]));
  expect((screen.getByRole('button', { name: '发送并进入会话' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('原会话已不可用，请重新选择')).toBeTruthy();
  expect(mocks.handoff).not.toHaveBeenCalled();
});

it('opens the existing collapsed sidebar without opening a second recipient list', async () => {
  const open = vi.fn(); setup(open, false); await loaded();
  fireEvent.click(screen.getByRole('button', { name: '交给会话 检查移动端输入' }));
  expect(open).toHaveBeenCalledOnce(); expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByLabelText('交接会话列表')).toBeNull();
  expect(useTodoWorkspace.getState().views.local.modal).toEqual({ kind: 'recipient', ids: ['one'] });
  act(() => useTodoWorkspace.getState().patch('local', { modal: null }));
  expect(useTodoWorkspace.getState().views.local.modal).toBeNull(); expect(mocks.handoff).not.toHaveBeenCalled();
});
it('returns to the sidebar to change recipient and retains the supplemental draft', async () => {
  setup(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '交给会话 检查移动端输入' })); await pickRecipient();
  fireEvent.change(screen.getByRole('textbox', { name: /补充一句话/ }), { target: { value: '保留这条补充' } });
  fireEvent.click(screen.getByRole('button', { name: '更换' }));
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByLabelText('交接会话列表')).toBeNull();
  await pickRecipient(); expect((screen.getByRole('textbox', { name: /补充一句话/ }) as HTMLTextAreaElement).value).toBe('保留这条补充');
  expect(mocks.handoff).not.toHaveBeenCalled();
});


it('uses desktop status columns and keeps all cards visible when expanding or editing inline content', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
  data.todos.push({ ...todo, id: 'done', title: '已完成事项', status: 'completed' });
  setup(); await loaded();
  const open = screen.getByRole('region', { name: '待完成列表' }), completed = screen.getByRole('region', { name: '已完成列表' });
  expect(within(open).getByText('评估语音方案')).toBeTruthy();
  expect(within(completed).getByText('已完成事项')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '检查移动端输入' }));
  expect(screen.queryByRole('region', { name: '待办详情' })).toBeNull();
  expect(screen.getByText('评估语音方案')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '编辑 检查移动端输入' }));
  expect(await screen.findByRole('dialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  fireEvent.click(screen.getByRole('button', { name: '完成 检查移动端输入' }));
  await waitFor(() => expect(within(completed).getByText('检查移动端输入')).toBeTruthy());
  expect(within(open).queryByText('检查移动端输入')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '撤销' }));
  await waitFor(() => expect(within(open).getByText('检查移动端输入')).toBeTruthy());
});
it('switches mobile status tabs and reopens a completed item directly from its card', async () => {
  data.todos.push({ ...todo, id: 'done', title: '已完成事项', status: 'completed' });
  setup(); await loaded();
  fireEvent.click(screen.getByRole('tab', { name: '已完成 1' }));
  expect(screen.getByText('已完成事项')).toBeTruthy();
  expect(screen.queryByText('检查移动端输入')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重新打开 已完成事项' }));
  await screen.findByText('还没有已完成的待办');
  fireEvent.click(screen.getByRole('tab', { name: '待完成 3' }));
  expect(screen.getByRole('button', { name: '交给会话 已完成事项' })).toBeTruthy();
});
it('keeps the linked session reachable directly from a completed card', async () => {
  data.todos = [{ ...todo, status: 'completed' }]; data.runs = [run()];
  const navigate = vi.fn(); window.addEventListener('switch-terminal-session', navigate);
  setup(); await screen.findByRole('tab', { name: '已完成 1' });
  fireEvent.click(screen.getByRole('tab', { name: '已完成 1' }));
  fireEvent.click(screen.getByRole('button', { name: '去会话 检查移动端输入' }));
  await waitFor(() => expect(navigate).toHaveBeenCalled());
  expect(mocks.handoff).not.toHaveBeenCalled();
  window.removeEventListener('switch-terminal-session', navigate);
});
it('keeps completed cards out of recipient selection when their linked session has closed', async () => {
  data.todos = [{ ...todo, status: 'completed' }]; data.runs = [run()]; useSessionDirectoryStore.getState().replace([]);
  setup(); await screen.findByRole('tab', { name: '已完成 1' });
  fireEvent.click(screen.getByRole('tab', { name: '已完成 1' }));
  fireEvent.click(screen.getByRole('button', { name: '去会话 检查移动端输入' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('请先重新打开待办'));
  expect(useTodoWorkspace.getState().views.local?.modal).toBeFalsy(); expect(mocks.handoff).not.toHaveBeenCalled();
});

it('keeps sidebar recipient selection and places only new/cancel controls under the corresponding item', async () => {
  setup(); await loaded();
  const card = screen.getByRole('button', { name: '交给会话 检查移动端输入' }).closest('article')!;
  fireEvent.click(within(card).getByRole('button', { name: '交给会话 检查移动端输入' }));
  expect(useTodoWorkspace.getState().views.local.modal).toEqual({ kind: 'recipient', ids: ['one'] });
  expect(screen.queryByRole('combobox', { name: '接收会话' })).toBeNull();
  expect(within(card).getByRole('button', { name: '新建会话' })).toBeTruthy();
  fireEvent.click(within(card).getByRole('button', { name: '取消' }));
  expect(useTodoWorkspace.getState().views.local.modal).toBeNull(); expect(mocks.handoff).not.toHaveBeenCalled();
  fireEvent.click(within(card).getByRole('button', { name: '交给会话 检查移动端输入' }));
  fireEvent.click(within(card).getByRole('button', { name: '新建会话' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('新建会话')).toBeTruthy();
  expect(mocks.handoff).not.toHaveBeenCalled();
});
