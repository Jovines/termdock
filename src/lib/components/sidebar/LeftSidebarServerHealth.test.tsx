// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
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
    const moreButton = document.querySelector<HTMLButtonElement>('button[aria-controls="sidebar-launch-options"]')!;
    expect(moreButton.querySelector('span[aria-hidden="true"]')).toBeNull();
  });

  it('服务健康事故不再提示在底部启动菜单上', () => {
    renderSidebar(healthState({ attention: true, incident: { at: 1, event: 'killed', detail: 'signal SIGKILL', role: 'supervisor', exitCode: null, signal: 'SIGKILL', uptimeMs: 1_000, version: null, oomSuspect: false, restartCount: 1 } }));
    const moreButton = document.querySelector<HTMLButtonElement>('button[aria-controls="sidebar-launch-options"]')!;
    expect(moreButton.getAttribute('aria-label')).toBe('More actions');
    expect(moreButton.querySelector('span[aria-hidden="true"]')).toBeNull();
  });

  it('服务健康事故和更新同时存在时，底部仅显示更新提醒', () => {
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

    const moreButton = document.querySelector<HTMLButtonElement>('button[aria-controls="sidebar-launch-options"]')!;
    expect(moreButton.getAttribute('aria-label')).toBe('More actions: Termdock 1.4.70 is available');
    const dots = moreButton.querySelectorAll('span[aria-hidden="true"]');
    expect(dots).toHaveLength(1);
    expect([...dots].map((dot) => dot.className)).toEqual([
      expect.stringContaining('bg-[var(--warning)]'),
    ]);
  });
});
