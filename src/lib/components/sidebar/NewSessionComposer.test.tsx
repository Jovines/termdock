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
          onRefreshAgents={vi.fn()}
          onSelectAgent={onSelectAgent}
          onLaunchAgent={onLaunchAgent}
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
});
