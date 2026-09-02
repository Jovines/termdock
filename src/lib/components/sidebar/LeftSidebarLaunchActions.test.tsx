// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { LeftSidebar } from './LeftSidebar';

const codex = {
  slug: 'codex',
  displayName: 'Codex',
  command: 'codex',
  accentColor: 'var(--primary)',
  icon: null,
  isPlugin: false,
};

vi.mock('../../hooks/useNewSessionAgentPreference', () => ({
  useNewSessionAgentPreference: () => ({
    preference: codex,
    agents: [codex],
    detecting: false,
    refresh: vi.fn(),
    selectAgent: vi.fn(),
  }),
}));

vi.mock('../../terminal/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../terminal/api')>()),
  listAgentResumeHistory: vi.fn().mockResolvedValue([]),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LeftSidebar launch actions', () => {
  it('keeps Terminal and the default Agent one tap away while reserving disclosure for options', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ locale: 'en' }),
    })));
    const user = userEvent.setup();
    const onNewSession = vi.fn();

    render(
      <I18nProvider>
        <LeftSidebar
          isOpen
          pinned
          drawerWidthPx={320}
          sessions={[]}
          activeSessionId={null}
          sessionStates={new Map()}
          onNewSession={onNewSession}
          onClose={vi.fn()}
          onCloseSession={vi.fn()}
          onSplitSession={vi.fn()}
          onCloseSplit={vi.fn()}
          onRemoveFromSplit={vi.fn()}
          splitWorkspaces={[]}
          onSetSplitLayout={vi.fn()}
          onReorderSplitWorkspace={vi.fn()}
          onRenameSplitWorkspace={vi.fn()}
          onCombineSplitSessions={vi.fn()}
          onReorderSessions={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </I18nProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    expect(onNewSession).toHaveBeenLastCalledWith({ mode: 'shell' });

    await user.click(screen.getByRole('button', { name: 'New Codex' }));
    expect(onNewSession).toHaveBeenLastCalledWith({ mode: 'shell', command: 'codex' });

    await user.click(screen.getByRole('button', { name: 'More launch options' }));
    expect(screen.getByRole('region', { name: 'Start a session' })).toBeTruthy();
    expect(onNewSession).toHaveBeenCalledTimes(2);
  });

  it('keeps detached tmux sessions visible and restores them in one click', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ locale: 'en' }),
    })));
    const user = userEvent.setup();
    const onNewSession = vi.fn();

    render(
      <I18nProvider>
        <LeftSidebar
          isOpen
          pinned
          drawerWidthPx={320}
          sessions={[]}
          activeSessionId={null}
          sessionStates={new Map()}
          detachedTmuxSessions={[{
            name: 'wt-codex',
            windows: 1,
            attached: 0,
            friendlyName: 'Fix session recovery',
            program: 'codex',
            cwd: '/work/web-terminal',
          }]}
          onNewSession={onNewSession}
          onClose={vi.fn()}
          onCloseSession={vi.fn()}
          onSplitSession={vi.fn()}
          onCloseSplit={vi.fn()}
          onRemoveFromSplit={vi.fn()}
          splitWorkspaces={[]}
          onSetSplitLayout={vi.fn()}
          onReorderSplitWorkspace={vi.fn()}
          onRenameSplitWorkspace={vi.fn()}
          onCombineSplitSessions={vi.fn()}
          onReorderSessions={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole('region', { name: 'Detached sessions' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Restore Fix session recovery' }));
    expect(onNewSession).toHaveBeenCalledWith({
      mode: 'tmux',
      tmuxSessionName: 'wt-codex',
      cwd: '/work/web-terminal',
    });
  });
});
