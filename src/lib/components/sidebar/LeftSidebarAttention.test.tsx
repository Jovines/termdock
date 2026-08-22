// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { I18nProvider } from '../../i18n';
import { LeftSidebar } from './LeftSidebar';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LeftSidebar attention state', () => {
  it('marks the session in place without rendering a duplicate attention queue', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ locale: 'en' }),
    })));

    render(
      <I18nProvider>
        <LeftSidebar
          isOpen
          pinned
          drawerWidthPx={280}
          onClose={vi.fn()}
          sessions={[
            { id: 'review-session', name: 'Review session', mode: 'shell' },
            { id: 'copy-session', name: 'Copy session', mode: 'tmux' },
          ]}
          activeSessionId={null}
          sessionStates={new Map([
            ['review-session', {
              cwd: null,
              activeProgram: null,
              agentStatus: 'waiting',
            }],
            ['copy-session', {
              cwd: null,
              activeProgram: null,
              agentStatus: null,
              inCopyMode: true,
            }],
          ])}
          onNewSession={vi.fn()}
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

    expect(screen.getAllByText('Review session')).toHaveLength(1);
    expect(screen.queryByText('Needs attention')).toBeNull();
    expect(screen.getByText('Review session').closest('.group')?.className)
      .toContain('var(--warning-rgb)');
    expect(screen.getByText('Copy session').closest('.group')?.className)
      .toContain('var(--tmux-rgb)');
    expect(screen.getByTitle('Copy mode').className).toContain('rounded-[2px]');
  });
});
