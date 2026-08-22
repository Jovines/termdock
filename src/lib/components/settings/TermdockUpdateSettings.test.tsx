// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '../../i18n';
import type { TermdockUpdateState } from '../../terminal/api';
import type { DesktopAppUpdateState } from '../../desktop/nativeBridge';
import { TermdockUpdateSettings } from './TermdockUpdateSettings';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSettings(state: TermdockUpdateState, desktopState?: DesktopAppUpdateState) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ locale: 'en' }) })));
  const onCheck = vi.fn();
  const onConfirmRestart = vi.fn();
  const onCheckDesktop = vi.fn();
  const onInstallDesktop = vi.fn();
  render(
    <I18nProvider>
      <TermdockUpdateSettings
        state={state}
        pending={false}
        onCheck={onCheck}
        onConfirmRestart={onConfirmRestart}
        desktopState={desktopState}
        onCheckDesktop={onCheckDesktop}
        onInstallDesktop={onInstallDesktop}
      />
    </I18nProvider>,
  );
  return { onCheck, onConfirmRestart, onCheckDesktop, onInstallDesktop };
}

describe('TermdockUpdateSettings', () => {
  it('offers an explicit manual update check', () => {
    const actions = renderSettings({
      status: 'current', currentVersion: '1.4.76', latestVersion: '1.4.76',
      source: 'official', checkedAt: Date.now(), error: null,
    });
    expect(screen.getByText('Termdock is up to date.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(actions.onCheck).toHaveBeenCalledOnce();
    expect(actions.onConfirmRestart).not.toHaveBeenCalled();
  });

  it('requires a separate restart confirmation after installation', () => {
    const actions = renderSettings({
      status: 'ready', currentVersion: '1.4.76', latestVersion: '1.4.77',
      source: 'official', checkedAt: Date.now(), error: null,
    });
    expect(screen.getByText('The update is installed and ready for a confirmed restart.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restart and finish update' }));
    expect(actions.onConfirmRestart).toHaveBeenCalledOnce();
    expect(actions.onCheck).not.toHaveBeenCalled();
  });

  it('checks the desktop app independently from the CLI runtime', () => {
    const actions = renderSettings(
      {
        status: 'current', currentVersion: '1.4.81', latestVersion: '1.4.81',
        source: 'official', checkedAt: Date.now(), error: null,
      },
      {
        status: 'current', currentVersion: '1.4.80', latestVersion: null,
        releaseName: null, checkedAt: Date.now(), error: null,
      },
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Check again' })[1]);
    expect(actions.onCheckDesktop).toHaveBeenCalledOnce();
    expect(actions.onCheck).not.toHaveBeenCalled();
  });

  it('offers restart and install after the desktop download finishes', () => {
    const actions = renderSettings(
      {
        status: 'current', currentVersion: '1.4.81', latestVersion: '1.4.81',
        source: 'official', checkedAt: Date.now(), error: null,
      },
      {
        status: 'ready', currentVersion: '1.4.80', latestVersion: '1.4.81',
        releaseName: 'v1.4.81', checkedAt: Date.now(), error: null,
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Restart and install' }));
    expect(actions.onInstallDesktop).toHaveBeenCalledOnce();
  });
});
