// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { LeftSidebar } from './LeftSidebar';

const settings = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock('../../terminal/api', async importOriginal => ({
  ...await importOriginal<typeof import('../../terminal/api')>(),
  getSettings: settings.get,
  updateSettings: settings.update,
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('restores the server floating preference and persists closing it', async () => {
  settings.get.mockResolvedValue({ collaborationFloatingGroupId: 'release', locale: 'en' });
  settings.update.mockResolvedValue({ collaborationFloatingGroupId: null });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
    locale: 'en', groups: [{ id: 'release', name: 'Release team', sessionIds: ['one', 'two'], createdAt: 1, updatedAt: 1 }],
    sessions: [], messages: [], agents: [], automations: [], runs: [],
  }) })));
  render(<I18nProvider><LeftSidebar isOpen pinned drawerWidthPx={280} onClose={vi.fn()}
    sessions={[{ id: 'one', name: 'Planner', mode: 'shell' }, { id: 'two', name: 'Reviewer', mode: 'shell' }]}
    activeSessionId="one" sessionStates={new Map()} onNewSession={vi.fn()} onCloseSession={vi.fn()}
    onSplitSession={vi.fn()} onCloseSplit={vi.fn()} onOpenSettings={vi.fn()}
    splitWorkspaces={[]} onRemoveFromSplit={vi.fn()} onSetSplitLayout={vi.fn()} onReorderSplitWorkspace={vi.fn()}
    onRenameSplitWorkspace={vi.fn()} onCombineSplitSessions={vi.fn()} onReorderSessions={vi.fn()} /></I18nProvider>);
  expect(await screen.findByRole('region', { name: '工作组消息浮窗' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Release team · 协作消息' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: '工作组消息浮窗' })).toBeNull());
  expect(settings.update).toHaveBeenCalledWith({ collaborationFloatingGroupId: null });
});
