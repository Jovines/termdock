// @vitest-environment jsdom
import React, { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenSessionInventoryResult, SessionInventory } from '../terminal';

const api = vi.hoisted(() => ({
  getSessionInventory: vi.fn(), openSessionInventoryEntry: vi.fn(), removeSessionInventoryEntry: vi.fn(),
  closeTerminal: vi.fn(), killTmuxSession: vi.fn(), sendTerminalInput: vi.fn(),
}));
vi.mock('../terminal', () => api);
vi.mock('../terminal/api', async (original) => ({
  ...await original<typeof import('../terminal/api')>(),
  ...api,
  getSettings: vi.fn().mockResolvedValue({}),
  suspendTerminalConnectionReconnects: vi.fn(),
}));
vi.mock('../utils/clientStateSync', () => ({ subscribeClientState: () => () => undefined }));
vi.mock('swiper/react', () => ({
  Swiper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SwiperSlide: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('./views/TerminalView', () => ({
  TerminalView: (props: {
    sessionId: string; isActive: boolean;
    onStreamReadyChange: (id: string, ready: boolean) => void;
    onViewportReadyChange: (id: string, ready: boolean) => void;
    onContentReadyChange: (id: string, ready: boolean) => void;
  }) => {
    useEffect(() => {
      props.onStreamReadyChange(props.sessionId, true);
      props.onViewportReadyChange(props.sessionId, true);
      props.onContentReadyChange(props.sessionId, true);
    }, [props.sessionId]);
    return <div className="terminal-viewport-container"><textarea data-terminal-input-anchor="true" aria-label={`Terminal ${props.sessionId}`} data-active={props.isActive} /></div>;
  },
}));
vi.mock('./FreeSplitLayout', () => ({
  FreeSplitLayout: ({ panes }: { panes: { id: string; content: React.ReactNode }[] }) => <>{panes.map(pane => <div key={pane.id}>{pane.content}</div>)}</>,
}));

import { MultiTerminalView } from './MultiTerminalView';
import { getActiveKeyboardLayer, isKeyboardLayerOpen, isKeyboardLayerSource } from '../hooks/useKeyboardLayer';
import { useTerminalStore } from '../stores/useTerminalStore';
import { useSidebarStore } from '../stores/useSidebarStore';
import { useCollaborationPanelDock } from '../stores/useCollaborationPanelDock';
import { useSessionOrderStore } from '../stores/useSessionOrderStore';

const sessions = ['one', 'two', 'three'].map((sessionId, index) => ({
  frontendSessionId: sessionId, sessionId, name: `Session ${sessionId}`, customName: true,
  backendSessionId: `backend-${sessionId}`, mode: 'shell' as const, tmuxSessionName: null,
  createdAt: index + 1, lastActivity: index + 1, connected: false, live: false, restorable: true,
}));
const inventory: SessionInventory = {
  clientSessions: sessions, tmuxSessions: [], tmuxStatus: { available: true, version: '3.4', reason: null }, updatedAt: 1,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function dispatch(name: string, detail: unknown) {
  act(() => { window.dispatchEvent(new CustomEvent(name, { detail })); });
}

describe('MultiTerminalView session recovery and keyboard ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.localStorage.setItem('termdock:locale', 'en');
    window.localStorage.setItem('termdock-sessions-cache', JSON.stringify(sessions));
    window.localStorage.setItem('termdock-active-session', 'one');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((media: string) => ({
      matches: false, media, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    useTerminalStore.setState({ sessions: new Map(), activeSessionId: null });
    useSidebarStore.setState({ leftOpen: false, rightOpen: false, groupByFolder: false });
    useCollaborationPanelDock.setState({ activePaneId: null, docks: {}, hosts: {} });
    useSessionOrderStore.setState({ collaborationGroups: [] });
    api.getSessionInventory.mockResolvedValue(inventory);
    api.removeSessionInventoryEntry.mockResolvedValue(undefined);
    api.closeTerminal.mockResolvedValue(undefined);
    api.killTmuxSession.mockResolvedValue(undefined);
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  async function ready() {
    const updates = vi.fn();
    render(<MultiTerminalView onSessionDataUpdate={updates} />);
    await waitFor(() => expect(updates.mock.lastCall?.[0].activeSessionId).toBe('one'));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Terminal one' })).toBeTruthy());
    return { updates, current: () => updates.mock.lastCall![0] as {
      activeSessionId: string; sessions: { id: string }[]; splitWorkspaces: { sessionIds: string[] }[];
    } };
  }

  it('gives the split chooser keyboard ownership, loops focus, and releases it on Escape', async () => {
    const user = userEvent.setup();
    await ready();
    const terminal = screen.getByRole('textbox', { name: 'Terminal one' });
    terminal.focus();
    dispatch('open-terminal-split-chooser', 'one');
    const dialog = screen.getByRole('dialog', { name: 'Add to split workspace' });
    const first = within(dialog).getByRole('button', { name: 'Close' });
    const buttons = within(dialog).getAllByRole('button');
    expect(document.activeElement).toBe(first);
    expect(getActiveKeyboardLayer()?.element).toBe(dialog);
    expect(isKeyboardLayerOpen()).toBe(true);
    expect(isKeyboardLayerSource(terminal)).toBe(false);
    expect(isKeyboardLayerSource(first)).toBe(true);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(buttons.at(-1));
    await user.tab();
    expect(document.activeElement).toBe(first);
    terminal.focus();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Escape', isComposing: true });
    expect(screen.getByRole('dialog')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(isKeyboardLayerOpen()).toBe(false);
    expect(document.activeElement).toBe(terminal);
    expect(isKeyboardLayerSource(terminal)).toBe(true);
  });

  it.each([false, true])('keeps a user selection while a real creation resolves (switch back: %s)', async (switchBack) => {
    const pending = deferred<OpenSessionInventoryResult>();
    api.openSessionInventoryEntry.mockReturnValue(pending.promise);
    const { current } = await ready();
    const onResult = vi.fn();
    dispatch('new-terminal-session', { onResult });
    dispatch('switch-terminal-session', 'two');
    if (switchBack) dispatch('switch-terminal-session', 'one');
    const expected = switchBack ? 'one' : 'two';
    await waitFor(() => expect(current().activeSessionId).toBe(expected));
    const created = { ...sessions[0]!, sessionId: 'created', frontendSessionId: 'created', name: 'Created', backendSessionId: 'backend-created' };
    await act(async () => {
      pending.resolve({
        session: created, terminalSession: { sessionId: 'backend-created', cols: 80, rows: 24 },
        inventory: { ...inventory, clientSessions: [...sessions, created] }, reused: false,
      });
      await pending.promise;
    });
    await waitFor(() => expect(current().sessions.map(session => session.id)).toContain('created'));
    expect(current().activeSessionId).toBe(expected);
    expect(window.localStorage.getItem('termdock-active-session')).toBe(expected);
    expect(useTerminalStore.getState().sessions.get('created')?.terminalSessionId).toBe('backend-created');
    expect(onResult).toHaveBeenCalledWith({ ok: true, sessionId: 'created' });
  });

  it('claims split shortcuts before terminal handlers while yielding to forms, composition, and the chooser', async () => {
    const { current } = await ready();
    dispatch('combine-terminal-split-sessions', { primaryId: 'one', secondaryId: 'two' });
    await waitFor(() => expect(current().splitWorkspaces).toHaveLength(1));
    render(<input aria-label="Background form" />);
    const form = screen.getByRole('textbox', { name: 'Background form' });
    const terminal = screen.getByRole('textbox', { name: 'Terminal one' });
    const rawTerminalKey = vi.fn();
    terminal.addEventListener('keydown', rawTerminalKey);
    fireEvent.keyDown(form, { key: 'ArrowRight', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(terminal, { key: 'ArrowRight', ctrlKey: true, shiftKey: true, isComposing: true });
    expect(current().activeSessionId).toBe('one');
    rawTerminalKey.mockClear();
    const navigationKey = new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    fireEvent(terminal, navigationKey);
    await waitFor(() => expect(current().activeSessionId).toBe('two'));
    expect(navigationKey.defaultPrevented).toBe(true);
    expect(rawTerminalKey).not.toHaveBeenCalled();
    dispatch('open-terminal-split-chooser', 'one');
    const close = within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' });
    const chooserKey = new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    fireEvent(close, chooserKey);
    expect(current().activeSessionId).toBe('one');
    expect(chooserKey.defaultPrevented).toBe(false);
  });

  it('does not resurrect a closed session from a delayed reopen response', async () => {
    const pending = deferred<OpenSessionInventoryResult>();
    api.openSessionInventoryEntry.mockReturnValue(pending.promise);
    const { current } = await ready();
    const onResult = vi.fn();
    dispatch('new-terminal-session', { preferredFrontendSessionId: 'one', requireExisting: true, command: 'test-command', onResult });
    dispatch('close-terminal-session', 'one');
    await waitFor(() => expect(current().sessions.map(session => session.id)).not.toContain('one'));
    await act(async () => {
      pending.resolve({ session: sessions[0]!, terminalSession: { sessionId: 'backend-one', cols: 80, rows: 24 }, inventory, reused: true });
      await pending.promise;
    });
    expect(current().sessions.map(session => session.id)).not.toContain('one');
    expect(onResult).toHaveBeenCalledWith({ ok: false, error: 'unknown' });
    expect(api.sendTerminalInput).not.toHaveBeenCalled();
  });

  it('retains a late split creation without pairing a reopened chooser', async () => {
    const pending = deferred<OpenSessionInventoryResult>();
    api.openSessionInventoryEntry.mockReturnValue(pending.promise);
    const { current } = await ready();
    dispatch('open-terminal-split-chooser', 'one');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /New session in workspace/ }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    dispatch('open-terminal-split-chooser', 'one');
    const created = { ...sessions[0]!, sessionId: 'created', frontendSessionId: 'created', backendSessionId: 'backend-created' };
    await act(async () => {
      pending.resolve({ session: created, terminalSession: { sessionId: 'backend-created', cols: 80, rows: 24 }, inventory: { ...inventory, clientSessions: [...sessions, created] }, reused: false });
      await pending.promise;
    });
    await waitFor(() => expect(current().sessions.map(session => session.id)).toContain('created'));
    expect(current().activeSessionId).toBe('one');
    expect(current().splitWorkspaces).toHaveLength(0);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('retains a tab on close rejection and provides a successful visible retry', async () => {
    const failed = deferred<void>();
    api.closeTerminal.mockReturnValueOnce(failed.promise).mockResolvedValueOnce(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { current } = await ready();
    dispatch('close-terminal-session', { sessionId: 'one', closeMode: 'auto' });
    expect(api.closeTerminal).toHaveBeenCalledWith('backend-one');
    expect(current().sessions.map(session => session.id)).toContain('one');
    await act(async () => { failed.reject(new Error('network disconnected')); });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not close Session one');
    expect(current().sessions.map(session => session.id)).toContain('one');
    expect(api.removeSessionInventoryEntry).not.toHaveBeenCalled();
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(current().sessions.map(session => session.id)).not.toContain('one'));
    expect(api.closeTerminal).toHaveBeenCalledTimes(2);
    expect(api.removeSessionInventoryEntry).toHaveBeenCalledWith('one');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(current().activeSessionId).toBe('two');
  });

  it('does not steal a newer selection when a non-active close settles', async () => {
    const closing = deferred<void>();
    api.closeTerminal.mockReturnValue(closing.promise);
    const { current } = await ready();
    dispatch('close-terminal-session', { sessionId: 'one' });
    dispatch('switch-terminal-session', 'three');
    await waitFor(() => expect(current().activeSessionId).toBe('three'));
    await act(async () => { closing.resolve(); await closing.promise; });
    await waitFor(() => expect(current().sessions.map(session => session.id)).not.toContain('one'));
    expect(current().activeSessionId).toBe('three');
    expect(window.localStorage.getItem('termdock-active-session')).toBe('three');
  });
});
