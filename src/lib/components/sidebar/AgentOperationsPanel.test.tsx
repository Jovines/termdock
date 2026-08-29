// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentOperationsPanel } from './AgentOperationsPanel';

vi.mock('../../terminal/api', () => ({
  getAgentLaunchers: vi.fn().mockResolvedValue([
    { slug: 'codex', command: 'codex', displayName: 'Codex', accentColor: 'var(--primary)', icon: null, isPlugin: false },
    { slug: 'custom', command: 'custom-agent', displayName: 'Custom Agent', accentColor: 'var(--primary)', icon: null, isPlugin: true },
  ]),
  listAgentAutomations: vi.fn().mockResolvedValue({ automations: [], runs: [] }),
  listCollaborationGroups: vi.fn().mockResolvedValue({ groups: [], sessions: [] }),
  listCollaborationMessages: vi.fn().mockResolvedValue({ messages: [] }),
  prepareAgentResumeHistory: vi.fn(),
  removeAgentAutomation: vi.fn(),
  removeCollaborationGroup: vi.fn(),
  runAgentAutomation: vi.fn(),
  saveAgentAutomation: vi.fn(),
  saveCollaborationGroup: vi.fn(),
  sendCollaborationMessage: vi.fn(),
  searchTerminalSessions: vi.fn(),
}));

afterEach(cleanup);

describe('AgentOperationsPanel', () => {
  it('keeps the modal panel inside every mobile safe-area edge', () => {
    render(<AgentOperationsPanel activeSessionId={null} onClose={() => undefined} onNewSession={() => undefined} />);
    const panel = screen.getByRole('heading', { name: 'Agent 工作台' }).closest('section');
    expect(panel?.className).toContain('env(safe-area-inset-top,0px)');
    expect(panel?.className).toContain('env(safe-area-inset-bottom,0px)');
    expect(panel?.className).toContain('env(safe-area-inset-left,0px)');
    expect(panel?.className).toContain('env(safe-area-inset-right,0px)');
  });

  it('offers detected built-in and Plugin agents without exposing a launch command field', async () => {
    render(<AgentOperationsPanel activeSessionId={null} onClose={() => undefined} onNewSession={() => undefined} />);
    const picker = await screen.findByLabelText('Agent / Plugin');
    expect(picker.textContent).toContain('Codex');
    expect(picker.textContent).toContain('Custom Agent · Plugin');
    expect(screen.queryByText('启动命令')).toBeNull();
  });
});
