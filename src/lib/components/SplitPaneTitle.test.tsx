// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionWorkspace } from './chat/SessionWorkspace';
import { SplitPaneTitle } from './SplitPaneTitle';
import { getSessionDirectorySnapshot, useSessionDirectoryStore } from '../stores/useSessionDirectory';
import { useTerminalStore } from '../stores/useTerminalStore';

vi.mock('../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./chat/SessionChatView', () => ({ SessionChatView: ({ sessionId }: { sessionId: string }) => <div>Chat {sessionId}</div> }));
beforeEach(() => {
  const modes = new Map<string, string>();
  vi.stubGlobal('fetch', vi.fn(async (url, init?: RequestInit) => {
    if (init?.body) modes.set(String(url), JSON.parse(String(init.body)).mode);
    return Response.json({ mode: modes.get(String(url)) ?? 'terminal', updatedAt: 1 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); useSessionDirectoryStore.getState().replace([]); useTerminalStore.setState({ sessions: new Map() }); });

it('renders and updates the canonical directory title instead of the pane’s stale name', () => {
  const record = { sessionId: 'pane', name: '完整会话标题', customName: true, lastActivity: 1, cwd: '/repo' };
  useSessionDirectoryStore.getState().replace([record]);
  render(<SplitPaneTitle session={{ id: 'pane', name: 'tmux:wt-internal', customName: false, mode: 'tmux', tmuxSessionName: 'wt-internal' }} active onActivate={() => {}} />);
  expect(screen.getByText(getSessionDirectorySnapshot()[0].displayName)).toBeTruthy();
  act(() => useSessionDirectoryStore.getState().replace([{ ...record, name: '更新后的完整标题' }]));
  expect(screen.getByText('更新后的完整标题')).toBeTruthy();
  expect(screen.queryByText('tmux:wt-internal')).toBeNull();
});

it('switches only the selected pane and retains its terminal when returning', async () => {
  const activate = vi.fn();
  const view = render(<>
    <SplitPaneTitle session={{ id: 'switch-one', name: 'One', customName: true, mode: 'shell', tmuxSessionName: null }} active={false} onActivate={activate} />
    <SessionWorkspace sessionId="switch-one" name="One" active>{() => <textarea aria-label="Terminal One" defaultValue="preserved one" />}</SessionWorkspace>
    <SplitPaneTitle session={{ id: 'switch-two', name: 'Two', customName: true, mode: 'shell', tmuxSessionName: null }} active onActivate={() => {}} />
    <SessionWorkspace sessionId="switch-two" name="Two" active>{() => <textarea aria-label="Terminal Two" defaultValue="preserved two" />}</SessionWorkspace>
  </>);
  const terminal = screen.getByRole('textbox', { name: 'Terminal One' });
  const header = view.container.querySelector('[data-split-pane-title="switch-one"]')!.parentElement!;
  fireEvent.click(within(header).getByRole('button', { name: '切换到对话' }));
  await screen.findByText('Chat switch-one');
  expect(activate).toHaveBeenCalledOnce();
  expect(screen.queryByText('Chat switch-two')).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Terminal Two' })).toHaveProperty('value', 'preserved two');
  const back = within(header).getByRole('button', { name: '切换到终端' });
  expect(back.className).toContain('h-full');
  fireEvent.click(back);
  expect(screen.getByRole('textbox', { name: 'Terminal One' })).toBe(terminal);
  expect(terminal).toHaveProperty('value', 'preserved one');
});
