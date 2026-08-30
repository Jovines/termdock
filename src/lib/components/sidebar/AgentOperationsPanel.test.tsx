// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentOperationsPanel, cleanSessionSnippet } from './AgentOperationsPanel';

const apiMocks = vi.hoisted(() => ({
  listCollaborationGroups: vi.fn().mockResolvedValue({ groups: [], sessions: [] }),
  searchTerminalSessions: vi.fn().mockResolvedValue({ results: [] }),
}));

vi.mock('../../terminal/api', () => ({
  getAgentLaunchers: vi.fn().mockResolvedValue([
    { slug: 'codex', command: 'codex', displayName: 'Codex', accentColor: 'var(--primary)', icon: null, isPlugin: false },
    { slug: 'custom', command: 'custom-agent', displayName: 'Custom Agent', accentColor: 'var(--primary)', icon: null, isPlugin: true },
  ]),
  cancelIoSlot: vi.fn(),
  listDirectory: vi.fn().mockResolvedValue({ path: '/repo', entries: [] }),
  listAgentAutomations: vi.fn().mockResolvedValue({ automations: [], runs: [] }),
  listCollaborationGroups: apiMocks.listCollaborationGroups,
  listCollaborationMessages: vi.fn().mockResolvedValue({ messages: [] }),
  prepareAgentResumeHistory: vi.fn(),
  removeAgentAutomation: vi.fn(),
  removeCollaborationGroup: vi.fn(),
  runAgentAutomation: vi.fn(),
  saveAgentAutomation: vi.fn(),
  saveCollaborationGroup: vi.fn(),
  sendCollaborationMessage: vi.fn(),
  searchTerminalSessions: apiMocks.searchTerminalSessions,
}));

afterEach(cleanup);

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
