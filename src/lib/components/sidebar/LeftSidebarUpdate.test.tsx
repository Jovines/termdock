// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '../../i18n';
import { LeftSidebar } from './LeftSidebar';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LeftSidebar update reminder', () => {
  it('keeps the More button marked and exposes the confirmed restart action', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ locale: 'en' }),
    })));
    const onConfirmUpdateRestart = vi.fn();

    render(
      <I18nProvider>
        <LeftSidebar
          isOpen
          pinned
          drawerWidthPx={280}
          onClose={vi.fn()}
          sessions={[]}
          activeSessionId={null}
          sessionStates={new Map()}
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
          updateState={{
            status: 'ready',
            currentVersion: '1.4.69',
            latestVersion: '1.4.70',
            source: 'official',
            checkedAt: Date.now(),
            error: null,
          }}
          onConfirmUpdateRestart={onConfirmUpdateRestart}
        />
      </I18nProvider>,
    );

    const moreButton = screen.getByRole('button', { name: /More actions: Termdock 1\.4\.70 is available/ });
    expect(moreButton.querySelector('span[aria-hidden="true"]')).not.toBeNull();
    fireEvent.click(moreButton);
    expect(screen.getByText('The update is installed and ready for a confirmed restart.')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restart and finish update' }));
    expect(onConfirmUpdateRestart).toHaveBeenCalledOnce();
  });
});
