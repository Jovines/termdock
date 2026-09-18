// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { I18nProvider } from '../../i18n';
import { LeftSidebar } from './LeftSidebar';
import type { ServerHealthState } from '../../terminal/api';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function healthState(overrides: Partial<ServerHealthState> = {}): ServerHealthState {
  return {
    supervised: true,
    supervisor: { pid: 1, alive: true, phase: 'running', restarts: 0, consecutiveCrashes: 0 },
    incident: null,
    dismissedAt: null,
    attention: false,
    generatedAt: 0,
    ...overrides,
  };
}

function renderSidebar(serverHealthState: ServerHealthState | null) {
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
        serverHealthState={serverHealthState}
      />
    </I18nProvider>,
  );
}

describe('LeftSidebar 服务健康红点', () => {
  it('没有未确认的事故时，More 按钮上不点点', () => {
    renderSidebar(healthState());
    const moreButton = screen.getByRole('button', { name: 'More actions' });
    expect(moreButton.querySelector('span[aria-hidden="true"]')).toBeNull();
  });

  it('有待确认的事故时点红点，并在无障碍标签里说清是什么', () => {
    renderSidebar(healthState({ attention: true, incident: { at: 1, event: 'killed', detail: 'signal SIGKILL', role: 'supervisor', exitCode: null, signal: 'SIGKILL', uptimeMs: 1_000, version: null, oomSuspect: false, restartCount: 1 } }));
    const moreButton = screen.getByRole('button', { name: 'More actions: The service had a problem' });
    expect(moreButton.querySelector('span[aria-hidden="true"]')?.className).toContain('bg-destructive');
  });

  it('红点与更新提醒同时存在时两个都点，各说各的', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ locale: 'en' }) })));
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
          serverHealthState={healthState({ attention: true })}
        />
      </I18nProvider>,
    );

    const moreButton = screen.getByRole('button', {
      name: 'More actions: The service had a problem: Termdock 1.4.70 is available',
    });
    const dots = moreButton.querySelectorAll('span[aria-hidden="true"]');
    expect(dots).toHaveLength(2);
    expect([...dots].map((dot) => dot.className)).toEqual([
      expect.stringContaining('bg-destructive'),
      expect.stringContaining('bg-[var(--warning)]'),
    ]);
  });
});
