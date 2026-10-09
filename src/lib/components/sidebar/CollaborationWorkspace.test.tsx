// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CollaborationMainWorkspace from './CollaborationMainWorkspace';
import { routeCollaborationInput } from '../../collaboration/inputTarget';
import { act } from '@testing-library/react';
import { useCollaborationNavigation } from '../../stores/useCollaborationNavigation';
import { AgentOperationsPanel } from './AgentOperationsPanel';
import { useCollaborationPanelDock } from '../../stores/useCollaborationPanelDock';
const api = vi.hoisted(() => ({ list: vi.fn(), automations: vi.fn(), settings: vi.fn() }));
vi.mock('../../terminal/api', async original => ({
  ...await original<typeof import('../../terminal/api')>(),
  getSettings: api.settings, updateSettings: vi.fn().mockResolvedValue({}),
  getAgentLaunchers: vi.fn().mockResolvedValue([]), listAgentAutomations: api.automations,
  listCollaborationGroups: api.list, subscribeCollaborationGroups: vi.fn(() => () => {}),
  listCollaborationMessages: vi.fn().mockResolvedValue({ messages: [] }),
  listCollaborationTasks: vi.fn().mockResolvedValue({ tasks: [] }),
}));
vi.mock('./CollaborationTaskWorkbench', () => ({ CollaborationTaskWorkbench: ({ onManageMembers, boardNavigation, boardSettings }: { onManageMembers: () => void; boardNavigation?: React.ReactNode; boardSettings?: React.ReactNode }) => <section aria-label="目标编辑">{boardNavigation}{boardSettings}<button type="button" onClick={onManageMembers}>管理成员入口</button></section> }));
const group = { id: 'team', name: '发布准备', sessionIds: ['lead', 'worker'], createdAt: 1, updatedAt: 1 };
const sessions = group.sessionIds.map((id, i) => ({ sessionId: id, backendSessionId: id, name: i ? '执行成员' : '协调者', cwd: '/repo', agent: { slug: 'codex', displayName: 'Codex' }, status: 'ready', capability: 'terminal', currentTask: '', updatedAt: 1 }));
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); useCollaborationNavigation.setState({ groupId: null, drafts: {} });
  api.settings.mockResolvedValue({}); api.list.mockResolvedValue({ groups: [group], sessions });
  api.automations.mockResolvedValue({ automations: [], runs: [] });
  useCollaborationPanelDock.getState().setDock('team', null);
});
afterEach(() => { cleanup(); useCollaborationPanelDock.getState().setHost('team', null); document.querySelector('[data-workspace-host]')?.remove(); });
function setup() { return render(<AgentOperationsPanel initialCollaborationGroupId="team" activeSessionId="lead" onClose={vi.fn()} onNewSession={vi.fn()} />); }
describe('resident collaboration navigation', () => {
  it('opens the group goal view without global automation and search controls', async () => {
    setup(); await screen.findByRole('region', { name: '目标编辑' });
    expect(screen.getByRole('button', { name: '目标' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '成员与消息' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '自动任务' })).toBeNull();
    expect(screen.queryByRole('button', { name: '历史搜索' })).toBeNull();
    expect(api.automations).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('工作组终端')).toBeNull();
  });
  it('takes the missing-member shortcut directly to the member view and returns to goals', async () => {
    setup(); fireEvent.click(await screen.findByRole('button', { name: '管理成员入口' }));
    await screen.findByLabelText('工作组终端');
    expect(screen.getByRole('button', { name: '成员与消息' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '目标' }));
    expect(screen.queryByLabelText('工作组终端')).toBeNull();
    expect(screen.getByRole('button', { name: '目标' }).getAttribute('aria-pressed')).toBe('true');
  });
  it('expands in one click, makes the resident view inert, and restores focus when collapsed', async () => {
    const host = document.createElement('div'); host.dataset.workspaceHost = 'true'; document.body.append(host);
    useCollaborationPanelDock.getState().setHost('team', host);
    render(<AgentOperationsPanel initialFloating initialCollaborationGroupId="team" activeSessionId="lead" onClose={vi.fn()} onNewSession={vi.fn()} />);
    const expand = await screen.findByRole('button', { name: '展开协作工作区' });
    expand.focus(); fireEvent.click(expand);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.classList.contains('max-w-6xl')).toBe(true);
    expect(within(dialog).queryByRole('button', { name: '放到终端旁' })).toBeNull();
    const resident = host.querySelector('section')!;
    expect(resident.getAttribute('aria-hidden')).toBe('true');
    expect(resident.inert).toBe(true);
    const close = within(dialog).getByRole('button', { name: '收起展开视图' });
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(resident.inert).toBe(false);
    expect(document.activeElement).toBe(expand);
  });

});


describe('primary collaboration workspace', () => {
  function main() { return render(<CollaborationMainWorkspace groupId="team" activeSessionId="lead" defaultSessionMode="shell" onOpenSidebar={vi.fn()} />); }
  it('opens the group as a primary workspace without global utility tabs or a dialog', async () => {
    main(); await screen.findByRole('region', { name: '目标编辑' });
    expect(screen.getByRole('heading', { name: '发布准备' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '看板' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: '自动任务' })).toBeNull();
    expect(screen.queryByRole('button', { name: '历史搜索' })).toBeNull();
    expect(api.automations).not.toHaveBeenCalled();
    expect(useCollaborationPanelDock.getState().docks.team).toBeUndefined();
  });
  it('opens the selected member terminal and returns to the board without dropping the message draft', async () => {
    useCollaborationNavigation.getState().open('team');
    const events: string[] = [];
    const switchSession = (event: Event) => events.push((event as CustomEvent<string>).detail);
    window.addEventListener('switch-terminal-session', switchSession);
    const first = main(); await screen.findByRole('region', { name: '目标编辑' });
    fireEvent.click(screen.getByRole('button', { name: '成员与消息' }));
    fireEvent.change(screen.getByRole('textbox', { name: '内容' }), { target: { value: '还没有发出的协作说明' } });
    fireEvent.click(within(screen.getByLabelText('工作组终端')).getByRole('button', { name: /执行成员/ }));
    expect(events).toEqual(['worker']);
    await waitFor(() => expect(useCollaborationNavigation.getState().groupId).toBeNull());
    first.unmount();
    useCollaborationNavigation.getState().open('team'); main();
    await screen.findByRole('region', { name: '目标编辑' });
    fireEvent.click(screen.getByRole('button', { name: '成员与消息' }));
    expect((screen.getByRole('textbox', { name: '内容' }) as HTMLTextAreaElement).value).toBe('还没有发出的协作说明');
    window.removeEventListener('switch-terminal-session', switchSession);
  });
  it('opens the file sidebar from the workspace header while staying in the group', async () => {
    useCollaborationNavigation.getState().open('team');
    const toggle = vi.fn();
    render(<CollaborationMainWorkspace groupId="team" activeSessionId="lead" defaultSessionMode="shell" onOpenSidebar={vi.fn()} onToggleRightSidebar={toggle} rightSidebarOpen />);
    await screen.findByRole('region', { name: '目标编辑' });
    const files = screen.getByRole('button', { name: '文件侧栏' });
    expect(files.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(files);
    expect(toggle).toHaveBeenCalledOnce();
    expect(useCollaborationNavigation.getState().groupId).toBe('team');
    fireEvent.click(screen.getByRole('button', { name: '成员与消息' }));
    act(() => { expect(routeCollaborationInput('/project/reference.md')).toBe(true); });
    expect((screen.getByRole('textbox', { name: '内容' }) as HTMLTextAreaElement).value).toContain('/project/reference.md');
    fireEvent.click(screen.getByRole('button', { name: '看板' }));
    expect(routeCollaborationInput('不能写入隐藏的消息')).toBe(false);
  });
  it('returns to the terminal without changing the selected session', async () => {
    useCollaborationNavigation.getState().open('team');
    const switchSession = vi.fn(); window.addEventListener('switch-terminal-session', switchSession);
    main(); await screen.findByRole('region', { name: '目标编辑' });
    fireEvent.click(screen.getByRole('button', { name: '返回终端' }));
    expect(useCollaborationNavigation.getState().groupId).toBeNull();
    expect(switchSession).not.toHaveBeenCalled();
    window.removeEventListener('switch-terminal-session', switchSession);
  });
  it('shows the sidebar opener only while the session sidebar is closed', async () => {
    const open = vi.fn();
    const props = { groupId: 'team', activeSessionId: 'lead', defaultSessionMode: 'shell' as const, onOpenSidebar: open };
    const rendered = render(<CollaborationMainWorkspace {...props} leftSidebarVisible />);
    expect(screen.queryByRole('button', { name: '打开会话侧栏' })).toBeNull();
    rendered.rerender(<CollaborationMainWorkspace {...props} leftSidebarVisible={false} />);
    fireEvent.click(screen.getByRole('button', { name: '打开会话侧栏' }));
    expect(open).toHaveBeenCalledOnce();
  });
});
