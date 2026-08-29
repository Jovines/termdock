// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInventory } from '../terminal';

const terminalMocks = vi.hoisted(() => ({
  clearSessionInventoryEntries: vi.fn(),
  getSessionInventory: vi.fn(),
  openSessionInventoryEntry: vi.fn(),
  removeSessionInventoryEntry: vi.fn(),
  reorderSessionInventoryEntries: vi.fn(),
  updateSessionInventoryEntry: vi.fn(),
}));

const clientStateMocks = vi.hoisted(() => ({
  subscribeClientState: vi.fn(),
}));

vi.mock('../terminal', () => terminalMocks);
vi.mock('../utils/clientStateSync', () => clientStateMocks);

import { useSessionPersistence } from './useSessionPersistence';

const cachedSession = {
  sessionId: 'frontend-1',
  name: 'Session 1',
  customName: false,
  backendSessionId: 'backend-1',
  mode: 'shell' as const,
  tmuxSessionName: null,
  createdAt: 1,
  lastActivity: 1,
};

const staleInventory: SessionInventory = {
  clientSessions: [{
    frontendSessionId: cachedSession.sessionId,
    ...cachedSession,
    connected: false,
    live: false,
    restorable: false,
  }],
  tmuxSessions: [],
  tmuxStatus: { available: true, version: '3.4', reason: null },
  updatedAt: 1,
};

describe('useSessionPersistence deletion races', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem('termdock-sessions-cache', JSON.stringify([cachedSession]));
    terminalMocks.removeSessionInventoryEntry.mockResolvedValue(undefined);
    clientStateMocks.subscribeClientState.mockImplementation(() => () => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('does not resurrect a deleted session when the cold-start GET resolves late', async () => {
    let resolveInventory!: (inventory: SessionInventory) => void;
    terminalMocks.getSessionInventory.mockReturnValue(new Promise<SessionInventory>((resolve) => {
      resolveInventory = resolve;
    }));

    const { result } = renderHook(() => useSessionPersistence());
    await waitFor(() => expect(terminalMocks.getSessionInventory).toHaveBeenCalledOnce());
    expect(result.current.sessions.map((session) => session.sessionId)).toEqual(['frontend-1']);

    await act(async () => {
      await result.current.removeSession('frontend-1');
    });
    expect(result.current.sessions).toEqual([]);

    act(() => resolveInventory(staleInventory));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.sessions).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem('termdock-sessions-cache') ?? 'null')).toEqual([]);
  });

  it('filters a stale control snapshot received after deletion', async () => {
    terminalMocks.getSessionInventory.mockResolvedValue(staleInventory);
    const { result } = renderHook(() => useSessionPersistence());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.removeSession('frontend-1');
    });

    const listener = clientStateMocks.subscribeClientState.mock.calls[0]?.[0] as ((snapshot: unknown) => void);
    act(() => listener({
      type: 'client-state',
      seq: 1,
      clientState: { sessions: [cachedSession], updatedAt: 1 },
      inventory: staleInventory,
    }));

    expect(result.current.sessions).toEqual([]);
  });
});
