// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentOperationsPanel, cleanSessionSnippet } from './AgentOperationsPanel';

const apiMocks = vi.hoisted(() => ({
  listAgentAutomations: vi.fn().mockResolvedValue({ automations: [], runs: [] }),
  listCollaborationGroups: vi.fn().mockResolvedValue({ groups: [], sessions: [] }),
  searchTerminalSessions: vi.fn().mockResolvedValue({ results: [] }),
  saveCollaborationGroup: vi.fn(),
  spawnCollaborationAgent: vi.fn(),
  setAgentAutomationEnabled: vi.fn().mockResolvedValue({ automation: {} }),
}));

vi.mock('../../terminal/api', () => ({
  getAgentLaunchers: vi.fn().mockResolvedValue([
    { slug: 'codex', command: 'codex', displayName: 'Codex', accentColor: 'var(--primary)', icon: null, isPlugin: false },
    { slug: 'custom', command: 'custom-agent', displayName: 'Custom Agent', accentColor: 'var(--primary)', icon: null, isPlugin: true },
  ]),
  cancelIoSlot: vi.fn(),
  listDirectory: vi.fn().mockResolvedValue({ path: '/repo', entries: [] }),
  listAgentAutomations: apiMocks.listAgentAutomations,
  listCollaborationGroups: apiMocks.listCollaborationGroups,
  listCollaborationMessages: vi.fn().mockResolvedValue({ messages: [] }),
  prepareAgentResumeHistory: vi.fn(),
  removeAgentAutomation: vi.fn(),
  removeCollaborationGroup: vi.fn(),
  runAgentAutomation: vi.fn(),
  saveAgentAutomation: vi.fn(),
  saveCollaborationGroup: apiMocks.saveCollaborationGroup,
  sendCollaborationMessage: vi.fn(),
  spawnCollaborationAgent: apiMocks.spawnCollaborationAgent,
  setAgentAutomationEnabled: apiMocks.setAgentAutomationEnabled,
  searchTerminalSessions: apiMocks.searchTerminalSessions,
}));

afterEach(() => {
  cleanup();
  apiMocks.listAgentAutomations.mockReset().mockResolvedValue({ automations: [], runs: [] });
  apiMocks.listCollaborationGroups.mockReset().mockResolvedValue({ groups: [], sessions: [] });
  apiMocks.searchTerminalSessions.mockReset().mockResolvedValue({ results: [] });
  apiMocks.saveCollaborationGroup.mockReset();
  apiMocks.spawnCollaborationAgent.mockReset();
  apiMocks.setAgentAutomationEnabled.mockReset().mockResolvedValue({ automation: {} });
});

describe('AgentOperationsPanel', () => {
  it('cleans terminal control noise from user-facing snippets', () => {
    expect(cleanSessionSnippet('\u001b[31m(B<span>构建失败</span> ━━━━━ MMMMMMMMMMMMMMMMMM')).toBe('构建失败');
  });

  it('keeps the modal panel inside every mobile safe-area edge', () => {
    render(<AgentOperationsPanel activeSessionId={null} onClose={() => undefined} onNewSession={() => undefined} />);
    const panel = screen.getByRole('heading', { name: 'Agent 工作台' }).closest('section');
    expect(panel?.className).toContain('env(safe-area-inset-top,0px)');
    expect(panel?.className).toContain('env(safe-area-inset-bottom,0px)');
    expect(panel?.className).toContain('env(safe-area-inset-left,0px)');
    expect(panel?.className).toContain('env(safe-area-inset-right,0px)');
  });

  it('offers detected built-in and Plugin agents without exposing a launch command field', async () => {
    const user = userEvent.setup();
    render(<AgentOperationsPanel activeSessionId={null} onClose={() => undefined} onNewSession={() => undefined} />);
    await user.click(screen.getByRole('button', { name: '创建第一个任务' }));
    const picker = await screen.findByLabelText('Agent / Plugin');
    expect(picker.textContent).toContain('Codex');
    expect(picker.textContent).toContain('Custom Agent · Plugin');
    expect(screen.queryByText('启动命令')).toBeNull();
  });

  it('starts with an orienting empty state and reveals a guided form on demand', async () => {
    const user = userEvent.setup();
    render(<AgentOperationsPanel activeSessionId={null} onClose={() => undefined} onNewSession={() => undefined} />);

    expect(screen.getByText('把重复工作交给 Agent')).toBeTruthy();
    expect(screen.queryByLabelText('任务名称')).toBeNull();

    await user.click(screen.getByRole('button', { name: '创建第一个任务' }));
    expect(screen.getByText('1', { selector: 'span' })).toBeTruthy();
    expect(screen.getByLabelText('任务名称')).toBeTruthy();
    expect(screen.getByRole('button', { name: /选择/ })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '指定日期与时间' }));
    expect(screen.getByRole('button', { name: '星期一' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '星期日' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByLabelText('小时')).toHaveProperty('value', '09');
    expect(screen.getByLabelText('分钟')).toHaveProperty('value', '00');
    expect(document.querySelector('input[type="time"]')).toBeNull();

    await user.selectOptions(screen.getByLabelText('小时'), '18');
    await user.selectOptions(screen.getByLabelText('分钟'), '45');
    expect(screen.getByLabelText('小时')).toHaveProperty('value', '18');
    expect(screen.getByLabelText('分钟')).toHaveProperty('value', '45');
  });

  it('pauses and resumes an automation directly from its task card', async () => {
    const automation = {
      id: 'review', name: 'Review zeris', enabled: true, cwd: '/repo', command: 'codex', prompt: 'review',
      targetSessionId: null, schedule: { kind: 'interval' as const, everyMinutes: 60 }, createdAt: 10_000,
      updatedAt: 10_000, nextRunAt: 3_610_000, lastRunAt: null, lastRunStatus: null, lastRunMessage: null,
    };
    apiMocks.listAgentAutomations.mockResolvedValue({ automations: [automation], runs: [] });
    const user = userEvent.setup();
    render(<AgentOperationsPanel activeSessionId={null} onClose={() => undefined} onNewSession={() => undefined} />);

    await user.click(await screen.findByRole('button', { name: '暂停' }));
    expect(apiMocks.setAgentAutomationEnabled).toHaveBeenCalledWith('review', false);
    expect(await screen.findByText('“Review zeris”已暂停，不会自动运行')).toBeTruthy();

    apiMocks.listAgentAutomations.mockResolvedValue({ automations: [{ ...automation, enabled: false, nextRunAt: null }], runs: [] });
    await user.click(screen.getByRole('button', { name: '暂停' }));
    expect(await screen.findByRole('button', { name: '恢复' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '恢复' }));
    expect(apiMocks.setAgentAutomationEnabled).toHaveBeenLastCalledWith('review', true);
  });

  it('opens directory browsing as a focused dialog and Escape keeps the task form open', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<AgentOperationsPanel activeSessionId={null} onClose={onClose} onNewSession={() => undefined} />);

    await user.click(screen.getByRole('button', { name: '创建第一个任务' }));
    await user.click(screen.getByRole('button', { name: '选择' }));
    expect(screen.getByRole('dialog', { name: '选择工作目录' })).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '选择工作目录' })).toBeNull();
    expect(screen.getByLabelText('任务名称')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('turns collaboration session internals into clear user-facing choices', async () => {
    apiMocks.listCollaborationGroups.mockResolvedValueOnce({
      groups: [],
      sessions: [
        { sessionId: 'one', backendSessionId: null, name: '发布检查', cwd: '/repo', agent: { slug: 'codex', displayName: 'Codex' }, status: 'working', capability: 'agent', currentTask: JSON.stringify({ session_id: 'private', transcript_path: '/secret/path', prompt: '检查发布产物' }), updatedAt: Date.now() },
        { sessionId: 'two', backendSessionId: null, name: '文档整理', cwd: '/repo/docs', agent: { slug: 'codex', displayName: 'Codex' }, status: 'idle', capability: 'agent', currentTask: '整理发布说明', updatedAt: Date.now() },
      ],
    });
    const user = userEvent.setup();
    render(<AgentOperationsPanel activeSessionId="one" onClose={() => undefined} onNewSession={() => undefined} />);

    await user.click(screen.getByRole('button', { name: '会话协作' }));
    expect(screen.getByText(/一个 Agent 会话可以把任务直接交给另一个会话/)).toBeTruthy();
    expect(screen.getByText(/“开发”写完代码后通知“测试”检查，测试结果再回复回来/)).toBeTruthy();
    expect(await screen.findByText(/检查发布产物/)).toBeTruthy();
    expect(screen.getByText('处理中')).toBeTruthy();
    expect(screen.getByText('还需选择 1 个会话')).toBeTruthy();
    expect(document.body.textContent).not.toContain('transcript_path');
    expect(document.body.textContent).not.toContain('/secret/path');
  });

  it('opens a requested collaboration group directly from its sidebar shortcut', async () => {
    apiMocks.listCollaborationGroups.mockResolvedValue({
      groups: [
        { id: 'group-one', name: '开发组', sessionIds: ['one', 'two'], createdAt: 1, updatedAt: 1 },
        { id: 'group-two', name: '发布组', sessionIds: ['two', 'three'], createdAt: 1, updatedAt: 2 },
      ],
      sessions: [],
    });

    render(<AgentOperationsPanel initialCollaborationGroupId="group-two" activeSessionId={null} onClose={() => undefined} onNewSession={() => undefined} />);

    expect(screen.getByRole('button', { name: '会话协作' }).className).toContain('text-primary');
    expect(await screen.findByRole('heading', { name: '发布组 · 协作消息' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: '发布组' })).toBeTruthy();
    expect(screen.getByPlaceholderText(/说明背景、期望产出/)).toBeTruthy();
  });

  it('lets the user add existing Sessions to a collaboration group', async () => {
    const group = { id: 'group-one', name: '发布组', sessionIds: ['one', 'two'], createdAt: 1, updatedAt: 1 };
    const sessions = [
      { sessionId: 'one', backendSessionId: 'backend-one', name: '开发', cwd: '/repo', agent: { slug: 'codex', displayName: 'Codex' }, status: 'working', capability: 'agent', currentTask: '开发', updatedAt: 1 },
      { sessionId: 'two', backendSessionId: 'backend-two', name: '测试', cwd: '/repo', agent: { slug: 'codex', displayName: 'Codex' }, status: 'idle', capability: 'agent', currentTask: '测试', updatedAt: 1 },
      { sessionId: 'three', backendSessionId: 'backend-three', name: '文档', cwd: '/repo/docs', agent: { slug: 'codex', displayName: 'Codex' }, status: 'idle', capability: 'agent', currentTask: '文档', updatedAt: 1 },
    ];
    apiMocks.listCollaborationGroups.mockResolvedValue({ groups: [group], sessions });
    apiMocks.saveCollaborationGroup.mockResolvedValue({ group: { ...group, sessionIds: ['one', 'two', 'three'] } });
    const user = userEvent.setup();
    render(<AgentOperationsPanel activeSessionId="one" onClose={() => undefined} onNewSession={() => undefined} />);

    await user.click(screen.getByRole('button', { name: '会话协作' }));
    await user.click(await screen.findByRole('button', { name: /管理成员/ }));
    await user.click(screen.getByRole('checkbox', { name: /文档/ }));
    await user.click(screen.getByRole('button', { name: /保存成员/ }));

    expect(apiMocks.saveCollaborationGroup).toHaveBeenCalledWith({ id: 'group-one', name: '发布组', sessionIds: ['one', 'two', 'three'] });
    expect(await screen.findByText('“发布组”成员已更新，共 3 个会话')).toBeTruthy();
  });

  it('creates an Agent Session and automatically joins it to the selected group', async () => {
    const group = { id: 'group-one', name: '发布组', sessionIds: ['one', 'two'], createdAt: 1, updatedAt: 1 };
    const sessions = [
      { sessionId: 'one', backendSessionId: 'backend-one', name: '开发', cwd: '/repo', agent: { slug: 'codex', displayName: 'Codex' }, status: 'working', capability: 'agent', currentTask: '开发', updatedAt: 1 },
      { sessionId: 'two', backendSessionId: 'backend-two', name: '测试', cwd: '/repo', agent: { slug: 'codex', displayName: 'Codex' }, status: 'idle', capability: 'agent', currentTask: '测试', updatedAt: 1 },
    ];
    apiMocks.listCollaborationGroups.mockResolvedValue({ groups: [group], sessions });
    apiMocks.spawnCollaborationAgent.mockResolvedValue({ group: { ...group, sessionIds: ['one', 'two', 'new-agent'] }, session: { ...sessions[0], sessionId: 'new-agent', name: '发布审查' } });
    const user = userEvent.setup();
    render(<AgentOperationsPanel activeSessionId="one" onClose={() => undefined} onNewSession={() => undefined} />);

    await user.click(screen.getByRole('button', { name: '会话协作' }));
    await user.click(await screen.findByRole('button', { name: /新建 Agent/ }));
    await user.selectOptions(screen.getByLabelText('新 Agent 类型'), 'custom');
    await user.type(screen.getByLabelText('新 Agent 会话名称'), '发布审查');
    await user.clear(screen.getByLabelText('新 Agent 工作目录'));
    await user.type(screen.getByLabelText('新 Agent 工作目录'), '/repo/release');
    await user.type(screen.getByLabelText('新 Agent 初始任务'), '检查发布产物');
    await user.click(screen.getByRole('button', { name: /创建并加入/ }));

    expect(apiMocks.spawnCollaborationAgent).toHaveBeenCalledWith('group-one', {
      agentSlug: 'custom', name: '发布审查', cwd: '/repo/release', task: '检查发布产物',
    });
    expect(await screen.findByText('“发布审查”已创建并加入“发布组”')).toBeTruthy();
  });

  it('keeps search controls visible in structure and presents cleaned actionable results', async () => {
    apiMocks.searchTerminalSessions.mockResolvedValueOnce({ results: [{
      sessionId: 'search-one', title: '构建排查', cwd: '/repo', agentSlug: 'codex', updatedAt: Date.now(),
      snippet: '\u001b[32m(B<span>真实输出</span> ━━━━━', matchCount: 3, live: true, resumeHistoryId: null,
    }] });
    const user = userEvent.setup();
    render(<AgentOperationsPanel activeSessionId={null} onClose={() => undefined} onNewSession={() => undefined} />);

    await user.click(screen.getByRole('button', { name: '全文搜索' }));
    await user.type(screen.getByLabelText('搜索全部会话'), '构建');
    expect(await screen.findByText('显示 1 个会话')).toBeTruthy();
    expect(screen.getByRole('button', { name: /构建排查/ }).textContent).toContain('真实输出');
    expect(screen.getByRole('button', { name: /构建排查/ }).textContent).not.toContain('<span>');
    expect(screen.getByRole('button', { name: /构建排查/ }).textContent).toContain('打开会话');
  });
});
