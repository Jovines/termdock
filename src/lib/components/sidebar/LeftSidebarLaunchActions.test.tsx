// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
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
    const onNewSession = vi.fn((options) => options?.onResult?.({ ok: true, sessionId: 'new' }));

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
    expect(onNewSession).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'shell' }));

    await user.click(screen.getByRole('button', { name: 'New Codex' }));
    expect(onNewSession).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'shell', command: 'codex' }));

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('region', { name: 'Start a session' })).toBeTruthy();
    expect(onNewSession).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed launch draft, prevents duplicates and closes only after successful retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ locale: 'en' }) })));
    const user = userEvent.setup();
    const onNewSession = vi.fn();
    render(<I18nProvider><LeftSidebar isOpen pinned drawerWidthPx={320} sessions={[]}
      activeSessionId={null} sessionStates={new Map()} onNewSession={onNewSession}
      onClose={vi.fn()} onCloseSession={vi.fn()} onSplitSession={vi.fn()} onCloseSplit={vi.fn()}
      onRemoveFromSplit={vi.fn()} splitWorkspaces={[]} onSetSplitLayout={vi.fn()}
      onReorderSplitWorkspace={vi.fn()} onRenameSplitWorkspace={vi.fn()} onCombineSplitSessions={vi.fn()}
      onReorderSessions={vi.fn()} onOpenSettings={vi.fn()} /></I18nProvider>);
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('radio', { name: 'Add custom command…' }));
    await user.type(screen.getByRole('textbox', { name: 'Startup command' }), 'printf preserved');
    await user.click(screen.getByRole('button', { name: /^Start / }));
    expect(onNewSession).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: /^Start / }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: /^Start / }));
    expect(onNewSession).toHaveBeenCalledOnce();
    act(() => onNewSession.mock.calls[0][0].onResult({ ok: false, error: 'directoryUnavailable' }));
    expect(screen.getByRole('alert').textContent).toContain('working directory');
    expect((screen.getByRole('textbox', { name: 'Startup command' }) as HTMLInputElement).value).toBe('printf preserved');
    await user.click(screen.getByRole('button', { name: /^Start / }));
    act(() => onNewSession.mock.calls[1][0].onResult({ ok: true, sessionId: 'new' }));
    expect(screen.queryByRole('region', { name: 'Start a session' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    act(() => onNewSession.mock.calls[2][0].onResult({ ok: false, error: 'connection' }));
    expect(screen.getByRole('alert').textContent).toContain('connect');
    expect(screen.getByRole('button', { name: 'New terminal' }).hasAttribute('disabled')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('button', { name: /^Start / }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'More actions' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('region', { name: 'Start a session' })).toBeNull();
    act(() => onNewSession.mock.calls[3][0].onResult({ ok: false, error: 'directoryUnavailable' }));
    expect(screen.getByRole('alert').textContent).toContain('working directory');
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps recoverable tmux sessions visible and restores them in one click', async () => {
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
          recoverableTmuxSessions={[{
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

    expect(screen.getByRole('region', { name: 'Recoverable sessions' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Restore Fix session recovery' }));
    expect(onNewSession).toHaveBeenCalledWith({
      mode: 'tmux',
      tmuxSessionName: 'wt-codex',
      cwd: '/work/web-terminal',
    });
  });
});
