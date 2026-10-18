// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '../../i18n';
import { LeftSidebar } from './LeftSidebar';
import type { TermdockUpdateState } from '../../terminal/api';

vi.mock('../../terminal/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../terminal/api')>()),
  listCollaborationTasks: vi.fn().mockResolvedValue({ tasks: [] }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LeftSidebar update reminder', () => {
  function renderSidebar(updateState: TermdockUpdateState, onConfirmUpdateRestart = vi.fn(), onRetryUpdate = vi.fn(), onNewSession = vi.fn()) {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ locale: 'en' }),
    })));

    return render(
      <I18nProvider>
        <LeftSidebar
          isOpen
          pinned
          drawerWidthPx={280}
          onClose={vi.fn()}
          sessions={[]}
          activeSessionId={null}
          sessionStates={new Map()}
          onNewSession={onNewSession}
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
          updateState={updateState}
          onConfirmUpdateRestart={onConfirmUpdateRestart}
          onRetryUpdate={onRetryUpdate}
        />
      </I18nProvider>,
    );
  }

  it('keeps the More button marked and exposes the confirmed restart action', () => {
    const onConfirmUpdateRestart = vi.fn();
    renderSidebar({ status: 'ready', currentVersion: '1.4.69', latestVersion: '1.4.70', source: 'official', checkedAt: Date.now(), error: null }, onConfirmUpdateRestart);

    const moreButton = screen.getByRole('button', { name: /More actions: Termdock 1\.4\.70 is available/ });
    expect(moreButton.querySelector('span[aria-hidden="true"]')).not.toBeNull();
    fireEvent.click(moreButton);
    expect(screen.getByText('The update is installed and ready for a confirmed restart.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restart and finish update' }));
    expect(onConfirmUpdateRestart).toHaveBeenCalledOnce();
  });

  it('does not present a same-version stale error as an available update', () => {
    renderSidebar({ status: 'error', currentVersion: '1.4.322', latestVersion: '1.4.322', source: 'official', checkedAt: Date.now(), error: 'stale install failure' });
    expect(screen.getByRole('button', { name: 'More actions' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Termdock 1\.4\.322 is available/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByText('Termdock 1.4.322 is available')).toBeNull();
    expect(screen.queryByText('Automatic installation failed. This reminder will remain.')).toBeNull();
  });

  it.each([
    ['lower version', '1.4.323', '1.4.322'],
    ['invalid version', '1.4.bad', '1.4.322'],
  ])('does not present a %s as an available update', (_label, currentVersion, latestVersion) => {
    renderSidebar({ status: 'error', currentVersion, latestVersion, source: 'official', checkedAt: Date.now(), error: 'install error' });
    expect(screen.getByRole('button', { name: 'More actions' })).toBeTruthy();
  });

  it('still launches a new session while a newer update error is present', () => {
    const onNewSession = vi.fn(({ onResult }: { onResult?: (result: { ok: true; sessionId: string }) => void }) => {
      onResult?.({ ok: true, sessionId: 'new-session' });
    });
    renderSidebar({ status: 'error', currentVersion: '1.4.321', latestVersion: '1.4.322', source: 'official', checkedAt: Date.now(), error: 'controlled npm install failure' }, vi.fn(), vi.fn(), onNewSession);

    expect(screen.getByRole('button', { name: /Termdock 1\.4\.322 is available/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    expect(onNewSession).toHaveBeenCalledOnce();
  });

  it('keeps a real newer-version install failure visible and changes to ready after recovery', () => {
    const onRetryUpdate = vi.fn();
    const view = renderSidebar({ status: 'error', currentVersion: '1.4.321', latestVersion: '1.4.322', source: 'official', checkedAt: Date.now(), error: 'controlled npm install failure' }, vi.fn(), onRetryUpdate);
    fireEvent.click(screen.getByRole('button', { name: /More actions/ }));
    expect(screen.getByText('Termdock 1.4.322 is available')).toBeTruthy();
    expect(screen.getByText('controlled npm install failure')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetryUpdate).toHaveBeenCalledOnce();

    view.rerender(<I18nProvider><LeftSidebar isOpen pinned drawerWidthPx={280} onClose={vi.fn()} sessions={[]} activeSessionId={null}
      sessionStates={new Map()} onNewSession={vi.fn()} onCloseSession={vi.fn()} onSplitSession={vi.fn()} onCloseSplit={vi.fn()}
      onRemoveFromSplit={vi.fn()} splitWorkspaces={[]} onSetSplitLayout={vi.fn()} onReorderSplitWorkspace={vi.fn()}
      onRenameSplitWorkspace={vi.fn()} onCombineSplitSessions={vi.fn()} onReorderSessions={vi.fn()} onOpenSettings={vi.fn()}
      updateState={{ status: 'ready', currentVersion: '1.4.321', latestVersion: '1.4.322', source: 'official', checkedAt: Date.now(), error: null }}
      onConfirmUpdateRestart={vi.fn()} onRetryUpdate={onRetryUpdate} /></I18nProvider>);
    expect(screen.getByText('The update is installed and ready for a confirmed restart.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restart and finish update' })).toBeTruthy();
  });
});
