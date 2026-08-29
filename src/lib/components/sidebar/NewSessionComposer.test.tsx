// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '../../i18n';
import { NewSessionComposer } from './NewSessionComposer';

const codex = {
  slug: 'codex',
  displayName: 'Codex',
  command: 'codex',
  accentColor: 'var(--blue)',
  icon: 'codex',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('NewSessionComposer launcher choices', () => {
  it('keeps one-off launches separate from changing the default', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ locale: 'en' }),
    })));
    const onLaunchAgent = vi.fn();
    const onSelectAgent = vi.fn();

    render(
      <I18nProvider>
        <NewSessionComposer
          directories={[]}
          tmuxAvailable
          options={{ mode: 'shell', cwd: '/workspace' }}
          agents={[codex]}
          selectedAgent={null}
          detecting={false}
          resumeHistory={[]}
          resumeHistoryLoading={false}
          resumeHistoryPendingId={null}
          resumeHistoryError={null}
          onRefreshAgents={vi.fn()}
          onSelectAgent={onSelectAgent}
          onLaunchAgent={onLaunchAgent}
          onResumeHistory={vi.fn()}
          onRemoveResumeHistory={vi.fn()}
          onClose={vi.fn()}
          onOptionsChange={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Launch Codex now' }));
    expect(onLaunchAgent).toHaveBeenCalledWith(codex);
    expect(onSelectAgent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Set Codex as default' }));
    expect(onSelectAgent).toHaveBeenCalledWith(codex);
    expect(onLaunchAgent).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Launch Terminal now' }));
    expect(onLaunchAgent).toHaveBeenLastCalledWith(null);
  });

  it('renders recent conversations as direct resume actions', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ locale: 'en' }) })));
    const onResumeHistory = vi.fn();
    const onRemoveResumeHistory = vi.fn();
    const entry = {
      id: 'history-1',
      title: 'Fix reconnect races',
      titleSource: 'auto' as const,
      agent: codex,
      cwd: '/workspace',
      closedAt: Date.now(),
      reason: 'closed' as const,
    };

    render(
      <I18nProvider>
        <NewSessionComposer
          directories={[]}
          tmuxAvailable
          options={{ mode: 'shell', cwd: '/workspace' }}
          agents={[codex]}
          selectedAgent={null}
          detecting={false}
          resumeHistory={[entry]}
          resumeHistoryLoading={false}
          resumeHistoryPendingId={null}
          resumeHistoryError={null}
          onRefreshAgents={vi.fn()}
          onSelectAgent={vi.fn()}
          onLaunchAgent={vi.fn()}
          onResumeHistory={onResumeHistory}
          onRemoveResumeHistory={onRemoveResumeHistory}
          onClose={vi.fn()}
          onOptionsChange={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Resume Fix reconnect races' }));
    expect(onResumeHistory).toHaveBeenCalledWith(entry);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Fix reconnect races from recent conversations' }));
    expect(onRemoveResumeHistory).toHaveBeenCalledWith('history-1');
  });

  it('does not change panel height for an empty background history refresh', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ locale: 'en' }) })));

    render(
      <I18nProvider>
        <NewSessionComposer
          directories={[]}
          tmuxAvailable
          options={{ mode: 'shell', cwd: '/workspace' }}
          agents={[codex]}
          selectedAgent={null}
          detecting={false}
          resumeHistory={[]}
          resumeHistoryLoading
          resumeHistoryPendingId={null}
          resumeHistoryError={null}
          onRefreshAgents={vi.fn()}
          onSelectAgent={vi.fn()}
          onLaunchAgent={vi.fn()}
          onResumeHistory={vi.fn()}
          onRemoveResumeHistory={vi.fn()}
          onClose={vi.fn()}
          onOptionsChange={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.queryByText('Recent conversations')).toBeNull();
    expect(screen.queryByText('Loading recent Agent conversations…')).toBeNull();
  });
});
