// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { useCollaborationNavigation } from '../../stores/useCollaborationNavigation';
import { useCollaborationPanelDock } from '../../stores/useCollaborationPanelDock';
import { useSessionOrderStore } from '../../stores/useSessionOrderStore';
import { LeftSidebar } from './LeftSidebar';

const api = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('../../terminal/api', async original => ({ ...await original<typeof import('../../terminal/api')>(),
  getSettings: vi.fn().mockResolvedValue({ locale: 'en' }), updateSettings: api.update,
  listAgentResumeHistory: vi.fn().mockResolvedValue([]),
}));
function deferred() { let resolve!: () => void; let reject!: (e: Error) => void; const promise = new Promise<void>((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value: () => [] });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  localStorage.clear(); vi.clearAllMocks(); api.update.mockResolvedValue({});
  useCollaborationNavigation.setState({ groupId: null, drafts: {} });
  useCollaborationPanelDock.setState({ docks: {}, hosts: {} });
  useSessionOrderStore.setState({ collaborationGroups: [] });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ locale: 'en', groups: [{ id: 'team', name: 'Team', sessionIds: ['old'], createdAt: 1, updatedAt: 1 }], sessions: [], messages: [], tasks: [], agents: [], automations: [], runs: [] }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function setup(mode: 'pinned' | 'push') {
  const onNewSession = vi.fn(), onClose = vi.fn();
  render(<I18nProvider><LeftSidebar isOpen pinned={mode === 'pinned'} push={mode === 'push'} drawerWidthPx={320}
    sessions={[{ id: 'old', name: 'Old shell', mode: 'shell' }]} activeSessionId="old" sessionStates={new Map()}
    onNewSession={onNewSession} onClose={onClose} onCloseSession={vi.fn()} onSplitSession={vi.fn()} onCloseSplit={vi.fn()}
    splitWorkspaces={[]} onRemoveFromSplit={vi.fn()} onSetSplitLayout={vi.fn()} onReorderSplitWorkspace={vi.fn()}
    onRenameSplitWorkspace={vi.fn()} onCombineSplitSessions={vi.fn()} onReorderSessions={vi.fn()} onOpenSettings={vi.fn()} /></I18nProvider>);
  await screen.findByRole('button', { name: '成员与消息：Team' });
  fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));
  expect(onNewSession).toHaveBeenCalledOnce();
  return { request: onNewSession.mock.calls[0][0], onClose };
}
describe.each(['pinned', 'push'] as const)('pending creation during %s navigation', mode => {
  it.each(['create-first', 'layout-first'] as const)('revokes before awaiting message layout (%s)', async order => {
    const save = deferred(); api.update.mockReturnValueOnce(save.promise);
    const { request, onClose } = await setup(mode);
    expect(request.shouldActivate()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '成员与消息：Team' }));
    expect(request.shouldActivate()).toBe(false);
    await waitFor(() => expect(api.update).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '成员与消息：Team' }));
    expect(api.update).toHaveBeenCalledOnce();
    const complete = () => act(() => request.onResult({ ok: true, sessionId: 'late-real-shell' }));
    if (order === 'create-first') complete();
    await act(async () => save.resolve());
    if (order === 'layout-first') complete();
    expect(request.shouldActivate()).toBe(false);
    expect(useCollaborationPanelDock.getState().docks.team.sessionId).toBe('old');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'New terminal' }).hasAttribute('disabled')).toBe(false);
  });
  it.each(['group', 'member', 'external-message'] as const)('revokes at the %s navigation entry', async entry => {
    const { request } = await setup(mode);
    if (entry === 'group') fireEvent.click(screen.getByRole('button', { name: '打开协作工作区：Team' }));
    else if (entry === 'member') fireEvent.click(screen.getByRole('button', { name: 'Old shell' }));
    else act(() => window.dispatchEvent(new CustomEvent('termdock:open-collaboration-messages', { detail: { groupId: 'team', dock: { sessionId: 'old', side: 'right' } } })));
    expect(request.shouldActivate()).toBe(false);
    act(() => request.onResult({ ok: true, sessionId: 'late-real-shell' }));
    if (entry === 'group') expect(useCollaborationNavigation.getState().groupId).toBe('team');
  });
  it('settles late creation after layout failure and allows a message retry', async () => {
    api.update.mockRejectedValueOnce(new Error('layout-save-failed')).mockResolvedValueOnce({});
    const { request } = await setup(mode);
    fireEvent.click(screen.getByRole('button', { name: '成员与消息：Team' }));
    await screen.findByText('layout-save-failed');
    expect(request.shouldActivate()).toBe(false);
    act(() => request.onResult({ ok: true, sessionId: 'late-real-shell' }));
    fireEvent.click(screen.getByRole('button', { name: '成员与消息：Team' }));
    await waitFor(() => expect(api.update).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'New terminal' }).hasAttribute('disabled')).toBe(false);
  });
  it('keeps normal creation eligible without another navigation', async () => {
    const { request } = await setup(mode);
    expect(request.shouldActivate()).toBe(true);
    act(() => request.onResult({ ok: true, sessionId: 'normal-shell' }));
    expect(screen.getByRole('button', { name: 'New terminal' }).hasAttribute('disabled')).toBe(false);
  });
});
