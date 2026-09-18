// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '../../i18n';
import { ServerHealthSettings } from './ServerHealthSettings';
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

function renderSettings(state: ServerHealthState | null, onDismiss = vi.fn()) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ locale: 'en' }) })));
  render(
    <I18nProvider>
      <ServerHealthSettings state={state} onDismiss={onDismiss} />
    </I18nProvider>,
  );
  return onDismiss;
}

describe('ServerHealthSettings', () => {
  it('快照还没到时什么都不画——「一切正常」也要有依据', () => {
    renderSettings(null);
    expect(screen.queryByText('Service health')).toBeNull();
  });

  it('没出过事时说清「有人看管」且不点红点', () => {
    renderSettings(healthState());
    expect(screen.getByText('Supervised: it restarts automatically if it dies.')).toBeTruthy();
    expect(screen.getByText('No problems recorded.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Got it' })).toBeNull();
  });

  it('把最近一次事故的原因和时刻摆出来，未确认时才给「知道了」', () => {
    const onDismiss = renderSettings(healthState({
      attention: true,
      // 重启次数取自监督者的实时计数，不是那条事故记录里的快照。
      supervisor: { pid: 1, alive: true, phase: 'running', restarts: 3, consecutiveCrashes: 1 },
      incident: {
        at: Date.parse('2026-09-19T02:30:00.000Z'),
        event: 'killed',
        detail: 'signal SIGKILL',
        role: 'supervisor',
        exitCode: null,
        signal: 'SIGKILL',
        uptimeMs: 12_000,
        version: '1.4.261',
        oomSuspect: true,
        restartCount: 3,
      },
    }));

    expect(screen.getByText('Last problem: Killed outright')).toBeTruthy();
    expect(screen.getByText(/ran for 12s/)).toBeTruthy();
    expect(screen.getByText('Memory was near the limit before it died; the OOM killer may have taken it.')).toBeTruthy();
    expect(screen.getByText('Restarted automatically 3 times')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('反复崩溃并放弃后，明说不会再有自动重启了', () => {
    renderSettings(healthState({
      supervisor: { pid: 1, alive: false, phase: 'gave-up', restarts: 4, consecutiveCrashes: 5 },
      incident: { at: 1, event: 'gave-up', detail: 'gave up', role: 'supervisor', exitCode: 1, signal: null, uptimeMs: null, version: null, oomSuspect: false, restartCount: 5 },
    }));
    expect(screen.getByText('Stopped automated restarts after 5 crashes in a row; the service is not running.')).toBeTruthy();
  });

  it('监督者自己没了也要说——哪怕服务还活着', () => {
    renderSettings(healthState({ supervisor: { pid: 2 ** 30, alive: false, phase: 'running', restarts: 2, consecutiveCrashes: 0 } }));
    expect(screen.getByText('The supervisor is gone — the service is running unsupervised.')).toBeTruthy();
  });
});
