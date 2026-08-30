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
  it('lets people review an agent choice before launching it', () => {
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

    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'codex' } });
    expect(onLaunchAgent).not.toHaveBeenCalled();
    expect(onSelectAgent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Make default' }));
    expect(onSelectAgent).toHaveBeenCalledWith(codex);

    fireEvent.click(screen.getByRole('button', { name: 'Start Codex' }));
    expect(onLaunchAgent).toHaveBeenCalledOnce();
    expect(onLaunchAgent).toHaveBeenCalledWith(codex);
  });

  it('reuses the directory browser and confirms the current folder explicitly', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ locale: 'en' }) })));
    const onOptionsChange = vi.fn();

    render(
      <I18nProvider>
        <NewSessionComposer
          directories={['/workspace']}
          tmuxAvailable
          options={{ mode: 'shell', cwd: '/workspace' }}
          agents={[codex]}
          selectedAgent={codex}
          detecting={false}
          resumeHistory={[]}
          resumeHistoryLoading={false}
          resumeHistoryPendingId={null}
          resumeHistoryError={null}
          onRefreshAgents={vi.fn()}
          onSelectAgent={vi.fn()}
          onLaunchAgent={vi.fn()}
          onResumeHistory={vi.fn()}
          onRemoveResumeHistory={vi.fn()}
          onClose={vi.fn()}
          onOptionsChange={onOptionsChange}
        />
      </I18nProvider>,
    );

    expect(screen.queryByRole('button', { name: 'Browse' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Working directory' }));
    expect(screen.getByRole('dialog', { name: 'Choose working directory' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use folder' }));
    expect(onOptionsChange).toHaveBeenCalledWith({ mode: 'shell', cwd: '/workspace' });
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

    fireEvent.click(screen.getByText('Recent conversations'));
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
