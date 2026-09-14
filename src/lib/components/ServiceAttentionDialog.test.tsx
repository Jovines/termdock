// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentFloatingSessionButtons } from './AgentIndicators';
import { consumeWorkspaceSession, installWorkspaceHost } from '../services/workspaceHost';
import { writeBrowserServices } from '../services/serviceDirectory';
import { useSidebarStore } from '../stores/useSidebarStore';

const entry = { id: 'entry', targetPeerId: 'entry', url: 'https://entry.example', label: 'Local service' };
const remote = { id: 'remote', targetPeerId: 'remote', url: 'https://remote.example', label: 'Remote service' };
const localSession = { id: 'same-id', label: 'Local pending task', waiting: false };
const remoteSessions = [
  { id: 'same-id', label: 'Remote permission request', waiting: true },
  { id: 'remote-two', label: 'Remote completed task', waiting: false },
];

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  delete window.__termdockWorkspaceHost;
  useSidebarStore.setState({ leftOpen: false, rightOpen: false });
});
afterEach(() => { cleanup(); delete window.__termdockWorkspaceHost; vi.restoreAllMocks(); });

function setup(localCount = 1) {
  writeBrowserServices([entry, remote]);
  const host = installWorkspaceHost(entry)!;
  host.activate(remote, false);
  host.report('remote', { phase: 'ready', rendered: true, reviewCount: 2, attentionSessions: remoteSessions });
  host.activate(entry, false);
  host.report('root', { phase: 'ready', rendered: true, reviewCount: localCount, attentionSessions: localCount ? [localSession] : [] });
  const buttons = (count: number) => <AgentFloatingSessionButtons reviewCount={count} runningSessions={[]}
    activeSessionId={null} runningButtonEnabled={false} isDesktopLayout={false} containerElement={document.body} />;
  const view = render(buttons(localCount));
  const launcher = screen.getByRole('button', { name: `Attention across services: ${localCount + 2}` });
  launcher.focus(); fireEvent.click(launcher);
  return { host, view, buttons, launcher };
}

describe('cross-service attention', () => {
  it('groups all pending sessions without duplicating the launcher', () => {
    setup();
    const dialog = screen.getByRole('dialog', { name: 'Attention across services' });
    expect(within(dialog).getByText('2 services · 3 sessions')).toBeTruthy();
    expect(within(dialog).getByText('Local service')).toBeTruthy();
    expect(within(dialog).getByText('Remote service')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /Remote permission request/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Attention across services: 3' })).toBeNull();
  });

  it('keeps other services reachable when the current one has no notifications', () => {
    setup(0);
    expect(screen.getByText('1 services · 2 sessions')).toBeTruthy();
    expect(screen.queryByText('Local pending task')).toBeNull();
    expect(screen.getByRole('button', { name: /Remote completed task/ })).toBeTruthy();
  });

  it('routes identical session IDs to the chosen service without clearing other counts', () => {
    const { host } = setup();
    fireEvent.click(screen.getByRole('button', { name: /Remote permission request/ }));
    expect(host.snapshot().activeKey).toBe('remote');
    expect(consumeWorkspaceSession('remote')).toBe('same-id');
    expect(consumeWorkspaceSession('entry')).toBeUndefined();
    expect(host.snapshot().items.map(item => item.reviewCount)).toEqual([1, 2]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('focuses a local session without switching or acknowledging the remote service', () => {
    const { host } = setup();
    const focus = vi.fn(); window.addEventListener('termdock:focus-session', focus);
    try {
      fireEvent.click(screen.getByRole('button', { name: /Local pending task/ }));
      expect(focus).toHaveBeenCalledOnce();
      expect((focus.mock.calls[0][0] as CustomEvent).detail).toBe('same-id');
      expect(host.snapshot().activeKey).toBe('root');
      expect(host.snapshot().items[1].reviewCount).toBe(2);
    } finally { window.removeEventListener('termdock:focus-session', focus); }
  });

  it('traps keyboard focus and closes only the dialog, preserving counts and launcher focus', () => {
    const { host, launcher } = setup();
    const dialog = screen.getByRole('dialog');
    const close = within(dialog).getByRole('button', { name: 'Close' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: /Remote completed task/ }));
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    const behind = vi.fn(); window.addEventListener('keydown', behind);
    try {
      fireEvent.keyDown(close, { key: 'Escape' });
      expect(behind).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(launcher);
      expect(host.snapshot().items.map(item => item.reviewCount)).toEqual([1, 2]);
    } finally { window.removeEventListener('keydown', behind); }
  });

  it('shows live removals and an empty state without closing or acknowledging the list', () => {
    const { host, view, buttons } = setup();
    act(() => { host.report('remote', { reviewCount: 0, attentionSessions: [] }); });
    expect(screen.queryByText('Remote permission request')).toBeNull();
    act(() => { host.report('root', { reviewCount: 0, attentionSessions: [] }); });
    view.rerender(buttons(0));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('No sessions need attention');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    expect(document.querySelector('[data-attention-button]')).toBeNull();
  });

  it('labels stale offline information and keeps a failed selection recoverable', () => {
    const { host } = setup();
    act(() => { host.report('remote', { phase: 'offline' }); });
    expect(screen.getByText('Offline · Last known status')).toBeTruthy();
    vi.spyOn(host, 'focusSession').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: /Remote permission request/ }));
    expect(screen.getByRole('alert').textContent).toContain('Unable to open');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(host.snapshot().activeKey).toBe('root');
  });

  it('falls back to the service sidebar when a workspace only reports counts', () => {
    const { host } = setup();
    act(() => { host.report('remote', { attentionSessions: undefined }); });
    fireEvent.click(screen.getByRole('button', { name: 'Open service' }));
    expect(host.snapshot().activeKey).toBe('remote');
    expect(consumeWorkspaceSession('remote')).toBeUndefined();
  });

  it('closes a hidden workspace list instead of reopening it on the next visit', () => {
    const { host } = setup();
    act(() => { host.activate(remote, false); });
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => { host.activate(entry, false); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Attention across services: 3' })).toBeTruthy();
  });
});
