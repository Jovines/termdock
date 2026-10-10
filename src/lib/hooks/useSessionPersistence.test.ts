// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenSessionInventoryResult, SessionInventory } from '../terminal';

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function createdResult(sessionId: string, inventory = staleInventory): OpenSessionInventoryResult {
  const session = { ...inventory.clientSessions[0]!, sessionId, frontendSessionId: sessionId, name: sessionId, backendSessionId: `backend-${sessionId}` };
  return {
    session,
    terminalSession: { sessionId: `backend-${sessionId}`, cols: 80, rows: 24 },
    inventory: { ...inventory, clientSessions: [...inventory.clientSessions, session] },
    reused: false,
  };
}

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

  it('keeps the caller-selected adjacent session active after deletion', async () => {
    const cachedSessions = ['frontend-1', 'frontend-2', 'frontend-3'].map((sessionId, index) => ({
      ...cachedSession,
      sessionId,
      name: `Session ${index + 1}`,
    }));
    window.localStorage.setItem('termdock-sessions-cache', JSON.stringify(cachedSessions));
    window.localStorage.setItem('termdock-active-session', 'frontend-2');
    terminalMocks.getSessionInventory.mockReturnValue(new Promise<SessionInventory>(() => undefined));

    const { result } = renderHook(() => useSessionPersistence());
    expect(result.current.activeSessionId).toBe('frontend-2');

    await act(async () => {
      await result.current.removeSession('frontend-2', 'frontend-1');
    });

    expect(result.current.activeSessionId).toBe('frontend-1');
    expect(window.localStorage.getItem('termdock-active-session')).toBe('frontend-1');
  });
});

describe('useSessionPersistence creation races', () => {
  const secondSession = { ...cachedSession, sessionId: 'frontend-2', name: 'Session 2' };
  const initialInventory: SessionInventory = {
    ...staleInventory,
    clientSessions: [...staleInventory.clientSessions, {
      ...staleInventory.clientSessions[0]!, ...secondSession, frontendSessionId: secondSession.sessionId,
    }],
  };

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem('termdock-sessions-cache', JSON.stringify([cachedSession, secondSession]));
    window.localStorage.setItem('termdock-active-session', cachedSession.sessionId);
    terminalMocks.getSessionInventory.mockResolvedValue(initialInventory);
    terminalMocks.openSessionInventoryEntry.mockReset();
    terminalMocks.removeSessionInventoryEntry.mockResolvedValue(undefined);
    terminalMocks.updateSessionInventoryEntry.mockReturnValue(new Promise(() => undefined));
    clientStateMocks.subscribeClientState.mockImplementation(() => () => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  async function readyHook() {
    const hook = renderHook(() => useSessionPersistence());
    await waitFor(() => expect(hook.result.current.inventory).toEqual(initialInventory));
    return hook;
  }

  it('automatically selects an ordinary creation', async () => {
    const pending = deferred<OpenSessionInventoryResult>();
    terminalMocks.openSessionInventoryEntry.mockReturnValue(pending.promise);
    const { result } = await readyHook();
    let opening!: Promise<OpenSessionInventoryResult>;
    act(() => { opening = result.current.openSession({}); });
    await act(async () => {
      pending.resolve(createdResult('created', initialInventory));
      await opening;
    });
    expect(result.current.activeSessionId).toBe('created');
    expect(window.localStorage.getItem('termdock-active-session')).toBe('created');
  });

  it.each([false, true])('preserves an explicit selection during open (switch back: %s)', async (switchBack) => {
    const pending = deferred<OpenSessionInventoryResult>();
    terminalMocks.openSessionInventoryEntry.mockReturnValue(pending.promise);
    const { result } = await readyHook();
    let opening!: Promise<OpenSessionInventoryResult>;
    act(() => {
      opening = result.current.openSession({});
      result.current.setActiveSession('frontend-2');
      if (switchBack) result.current.setActiveSession('frontend-1');
    });
    await act(async () => {
      pending.resolve(createdResult('created', initialInventory));
      await opening;
    });
    const expectedActive = switchBack ? 'frontend-1' : 'frontend-2';
    expect(result.current.activeSessionId).toBe(expectedActive);
    expect(window.localStorage.getItem('termdock-active-session')).toBe(expectedActive);
    expect(result.current.sessions.map((session) => session.sessionId)).toContain('created');
  });

  it.each([false, true])('retains both concurrent creations (newer settles first: %s)', async (newerFirst) => {
    const first = deferred<OpenSessionInventoryResult>();
    const second = deferred<OpenSessionInventoryResult>();
    terminalMocks.openSessionInventoryEntry.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = await readyHook();
    let openingFirst!: Promise<OpenSessionInventoryResult>;
    let openingSecond!: Promise<OpenSessionInventoryResult>;
    act(() => {
      openingFirst = result.current.openSession({ name: 'first' });
      openingSecond = result.current.openSession({ name: 'second' });
    });
    const settleFirst = async () => {
      first.resolve(createdResult('created-first', initialInventory));
      await openingFirst;
    };
    const settleSecond = async () => {
      second.resolve(createdResult('created-second', initialInventory));
      await openingSecond;
    };
    await act(newerFirst ? settleSecond : settleFirst);
    await act(newerFirst ? settleFirst : settleSecond);
    expect(new Set(result.current.sessions.map((session) => session.sessionId))).toEqual(
      new Set(['frontend-1', 'frontend-2', 'created-first', 'created-second']),
    );
    expect(result.current.activeSessionId).toBe('created-second');
    expect(result.current.inventory?.clientSessions.map((session) => session.sessionId)).toEqual(
      result.current.sessions.map((session) => session.sessionId),
    );
  });

  it('keeps deletion tombstones while retaining the late created session', async () => {
    const pending = deferred<OpenSessionInventoryResult>();
    terminalMocks.openSessionInventoryEntry.mockReturnValue(pending.promise);
    const { result } = await readyHook();
    let opening!: Promise<OpenSessionInventoryResult>;
    act(() => { opening = result.current.openSession({}); });
    await act(async () => { await result.current.removeSession('frontend-1', 'frontend-2'); });
    await act(async () => {
      pending.resolve(createdResult('created', initialInventory));
      await opening;
    });
    expect(result.current.sessions.map((session) => session.sessionId)).toEqual(['frontend-2', 'created']);
    expect(result.current.activeSessionId).toBe('frontend-2');
    expect(result.current.inventory?.clientSessions.map((session) => session.sessionId)).toEqual(['frontend-2', 'created']);
  });

  it('does not reinsert or activate a result whose own frontend ID was deleted', async () => {
    const pending = deferred<OpenSessionInventoryResult>();
    terminalMocks.openSessionInventoryEntry.mockReturnValue(pending.promise);
    const { result } = await readyHook();
    let opening!: Promise<OpenSessionInventoryResult>;
    act(() => { opening = result.current.openSession({ preferredFrontendSessionId: 'created' }); });
    await act(async () => { await result.current.removeSession('created'); });
    await act(async () => {
      pending.resolve(createdResult('created', initialInventory));
      await opening;
    });
    expect(result.current.sessions.map((session) => session.sessionId)).toEqual(['frontend-1', 'frontend-2']);
    expect(result.current.activeSessionId).toBe('frontend-1');
  });

  it('preserves newer local metadata when a creation finishes late', async () => {
    const pending = deferred<OpenSessionInventoryResult>();
    terminalMocks.openSessionInventoryEntry.mockReturnValue(pending.promise);
    const { result } = await readyHook();
    let opening!: Promise<OpenSessionInventoryResult>;
    act(() => {
      opening = result.current.openSession({});
      void result.current.renameSession('frontend-1', 'New name');
    });
    await act(async () => {
      pending.resolve(createdResult('created', initialInventory));
      await opening;
    });
    expect(result.current.sessions[0]?.name).toBe('New name');
    expect(result.current.inventory?.clientSessions[0]?.name).toBe('New name');
    expect(result.current.activeSessionId).toBe('frontend-1');
  });

  it('preserves a newer control inventory while adding only the created session', async () => {
    const pending = deferred<OpenSessionInventoryResult>();
    terminalMocks.openSessionInventoryEntry.mockReturnValue(pending.promise);
    const { result } = await readyHook();
    let opening!: Promise<OpenSessionInventoryResult>;
    act(() => { opening = result.current.openSession({}); });
    const newerInventory = {
      ...initialInventory, updatedAt: 20,
      clientSessions: initialInventory.clientSessions.map((session) => ({ ...session, name: `updated-${session.sessionId}` })),
    };
    const listener = clientStateMocks.subscribeClientState.mock.calls[0]?.[0] as ((snapshot: unknown) => void);
    act(() => listener({ type: 'client-state', seq: 2, inventory: newerInventory }));
    await act(async () => {
      pending.resolve(createdResult('created', initialInventory));
      await opening;
    });
    expect(result.current.sessions[0]?.name).toBe('updated-frontend-1');
    expect(result.current.inventory?.updatedAt).toBe(20);
    expect(result.current.sessions.map((session) => session.sessionId)).toContain('created');
  });

  it('checks the activation callback after resolution without losing the created session', async () => {
    const pending = deferred<OpenSessionInventoryResult>();
    terminalMocks.openSessionInventoryEntry.mockReturnValue(pending.promise);
    const { result } = await readyHook();
    let mayActivate = true;
    let opening!: Promise<OpenSessionInventoryResult>;
    act(() => { opening = result.current.openSession({}, { shouldActivate: () => mayActivate }); });
    mayActivate = false;
    await act(async () => {
      pending.resolve(createdResult('created', initialInventory));
      await opening;
    });
    expect(result.current.activeSessionId).toBe('frontend-1');
    expect(result.current.sessions.map((session) => session.sessionId)).toContain('created');
  });


  function reopenedResult(updatedAt = 20): OpenSessionInventoryResult {
    const session = { ...initialInventory.clientSessions[0]!, backendSessionId: 'rebuilt-backend',
      connected: true, live: true, restorable: true, cwd: '/rebuilt', lastActivity: 20 };
    return { session, terminalSession: { sessionId: 'rebuilt-backend', cols: 100, rows: 40, cwd: '/rebuilt', activeProgramRaw: 'old-backend-argv', activeProgramSource: 'shell-pid' },
      inventory: { ...initialInventory, updatedAt, clientSessions: [session, initialInventory.clientSessions[1]!] }, reused: true };
  }

  function expectBinding(hook: ReturnType<typeof useSessionPersistence>, backend: string) {
    expect(hook.sessions.find(session => session.sessionId === 'frontend-1')?.backendSessionId).toBe(backend);
    expect(hook.inventory?.clientSessions.find(session => session.sessionId === 'frontend-1')?.backendSessionId).toBe(backend);
    expect(JSON.parse(localStorage.getItem('termdock-sessions-cache')!).find((session: {sessionId: string}) => session.sessionId === 'frontend-1').backendSessionId).toBe(backend);
  }

  it.each(['rename restored', 'rename other', 'reorder', 'creation'])('keeps a rebuilt backend during %s without undoing newer UI intent', async (mutation) => {
    const pending = deferred<OpenSessionInventoryResult>();
    const creation = deferred<OpenSessionInventoryResult>();
    terminalMocks.openSessionInventoryEntry.mockReturnValueOnce(pending.promise).mockReturnValueOnce(creation.promise);
    terminalMocks.reorderSessionInventoryEntries.mockReturnValue(new Promise(() => undefined));
    const { result } = await readyHook();
    let opening!: ReturnType<typeof result.current.openSession>;
    let creating: ReturnType<typeof result.current.openSession> | undefined;
    act(() => {
      opening = result.current.openSession({ preferredFrontendSessionId: 'frontend-1', requireExisting: true });
      result.current.setActiveSession('frontend-2');
      if (mutation === 'rename restored') void result.current.renameSession('frontend-1', 'Restored renamed');
      if (mutation === 'rename other') void result.current.renameSession('frontend-2', 'Other renamed');
      if (mutation === 'reorder') void result.current.reorderSessions(['frontend-2', 'frontend-1']);
      if (mutation === 'creation') creating = result.current.openSession({});
    });
    if (creating) await act(async () => { creation.resolve(createdResult('created', initialInventory)); await creating; });
    let settled!: Awaited<typeof opening>;
    await act(async () => { pending.resolve(reopenedResult()); settled = await opening; });
    expectBinding(result.current, 'rebuilt-backend');
    expect(settled.session.backendSessionId).toBe('rebuilt-backend');
    expect(settled.terminalSession.sessionId).toBe('rebuilt-backend');
    expect(settled.inventory).toEqual(result.current.inventory);
    expect(settled.session).toMatchObject({ connected: true, live: true, restorable: true, cwd: '/rebuilt' });
    expect(result.current.activeSessionId).toBe(creating ? 'created' : 'frontend-2');
    if (mutation === 'rename restored') expect(settled.session).toMatchObject({ name: 'Restored renamed', customName: true });
    if (mutation === 'rename other') expect(result.current.sessions[1]?.name).toBe('Other renamed');
    if (mutation === 'reorder') expect(result.current.sessions.map(session => session.sessionId)).toEqual(['frontend-2', 'frontend-1']);
    if (creating) expect(result.current.sessions.map(session => session.sessionId)).toContain('created');
  });

  it.each(['before', 'after'])('keeps a later control binding when the snapshot arrives %s the open response', async (order) => {
    const pending = deferred<OpenSessionInventoryResult>();
    terminalMocks.openSessionInventoryEntry.mockReturnValue(pending.promise);
    const { result } = await readyHook();
    let opening!: ReturnType<typeof result.current.openSession>;
    act(() => { opening = result.current.openSession({ preferredFrontendSessionId: 'frontend-1', requireExisting: true }); });
    const newer = reopenedResult(30).inventory;
    newer.clientSessions[0] = { ...newer.clientSessions[0]!, backendSessionId: 'control-backend', cwd: '/control' };
    const listener = clientStateMocks.subscribeClientState.mock.calls[0]![0] as (snapshot: unknown) => void;
    const push = () => listener({ type: 'client-state', seq: 2, inventory: newer });
    if (order === 'before') act(push);
    let settled!: Awaited<typeof opening>;
    await act(async () => { pending.resolve(reopenedResult()); settled = await opening; });
    if (order === 'after') act(push);
    expectBinding(result.current, 'control-backend');
    if (order === 'before') {
      expect(settled.session.backendSessionId).toBe('control-backend');
      expect(settled.terminalSession).toMatchObject({ sessionId: 'control-backend', cwd: '/control' });
      expect(settled.terminalSession.activeProgramRaw).toBeUndefined();
      expect(settled.inventory).toEqual(result.current.inventory);
    } else expect(settled.terminalSession.sessionId).toBe('rebuilt-backend');
  });

  it('accepts the open binding over an earlier control generation arriving during the request', async () => {
    const pending = deferred<OpenSessionInventoryResult>();
    terminalMocks.openSessionInventoryEntry.mockReturnValue(pending.promise);
    const { result } = await readyHook();
    let opening!: ReturnType<typeof result.current.openSession>;
    act(() => { opening = result.current.openSession({ preferredFrontendSessionId: 'frontend-1' }); });
    const listener = clientStateMocks.subscribeClientState.mock.calls[0]![0] as (snapshot: unknown) => void;
    act(() => listener({ type: 'client-state', seq: 2, inventory: { ...initialInventory, updatedAt: 10 } }));
    await act(async () => { pending.resolve(reopenedResult()); await opening; });
    expectBinding(result.current, 'rebuilt-backend');
  });

  it('does not let a late rename response or older control generation revert the open binding', async () => {
    const pending = deferred<OpenSessionInventoryResult>();
    const rename = deferred<SessionInventory>();
    terminalMocks.openSessionInventoryEntry.mockReturnValue(pending.promise);
    terminalMocks.updateSessionInventoryEntry.mockReturnValue(rename.promise);
    const { result } = await readyHook();
    let opening!: ReturnType<typeof result.current.openSession>;
    let renaming!: Promise<void>;
    act(() => {
      opening = result.current.openSession({ preferredFrontendSessionId: 'frontend-1' });
      renaming = result.current.renameSession('frontend-1', 'Rename confirmed');
    });
    await act(async () => { pending.resolve(reopenedResult()); await opening; });
    await act(async () => {
      rename.resolve({ ...initialInventory, updatedAt: 10, clientSessions: initialInventory.clientSessions.map(session => session.sessionId === 'frontend-1' ? { ...session, name: 'Rename confirmed', customName: true } : session) });
      await renaming;
    });
    expectBinding(result.current, 'rebuilt-backend');
    expect(result.current.sessions[0]).toMatchObject({ name: 'Rename confirmed', customName: true });
    const listener = clientStateMocks.subscribeClientState.mock.calls[0]![0] as (snapshot: unknown) => void;
    act(() => listener({ type: 'client-state', seq: 2, inventory: { ...initialInventory, updatedAt: 15 } }));
    expectBinding(result.current, 'rebuilt-backend');
  });

  it('still discards a rebuilt existing frontend ID deleted during open', async () => {
    const pending = deferred<OpenSessionInventoryResult>();
    terminalMocks.openSessionInventoryEntry.mockReturnValue(pending.promise);
    const { result } = await readyHook();
    let opening!: ReturnType<typeof result.current.openSession>;
    act(() => { opening = result.current.openSession({ preferredFrontendSessionId: 'frontend-1' }); });
    await act(async () => { await result.current.removeSession('frontend-1', 'frontend-2'); });
    let settled!: Awaited<typeof opening>;
    await act(async () => { pending.resolve(reopenedResult()); settled = await opening; });
    expect(result.current.sessions.map(session => session.sessionId)).toEqual(['frontend-2']);
    expect(settled.discarded).toBe(true);
    expect(JSON.parse(localStorage.getItem('termdock-sessions-cache')!).map((session: {sessionId: string}) => session.sessionId)).toEqual(['frontend-2']);
  });


  it('uses the control fact on equal timestamps only when it was observed after open began', async () => {
    const pending = deferred<OpenSessionInventoryResult>();
    terminalMocks.openSessionInventoryEntry.mockReturnValue(pending.promise);
    const { result } = await readyHook();
    let opening!: ReturnType<typeof result.current.openSession>;
    act(() => { opening = result.current.openSession({ preferredFrontendSessionId: 'frontend-1' }); });
    const control = reopenedResult(20).inventory;
    control.clientSessions[0] = { ...control.clientSessions[0]!, backendSessionId: 'same-ms-control' };
    const listener = clientStateMocks.subscribeClientState.mock.calls[0]![0] as (snapshot: unknown) => void;
    act(() => listener({ type: 'client-state', seq: 2, inventory: control }));
    let settled!: Awaited<typeof opening>;
    await act(async () => { pending.resolve(reopenedResult()); settled = await opening; });
    expectBinding(result.current, 'same-ms-control');
    expect(settled.terminalSession.sessionId).toBe('same-ms-control');
  });

  it('accepts an equal timestamp open fact when no newer fact arrived during the request', async () => {
    const pending = deferred<OpenSessionInventoryResult>();
    terminalMocks.openSessionInventoryEntry.mockReturnValue(pending.promise);
    const { result } = await readyHook();
    let opening!: ReturnType<typeof result.current.openSession>;
    act(() => {
      opening = result.current.openSession({ preferredFrontendSessionId: 'frontend-1' });
      void result.current.renameSession('frontend-1', 'Same millisecond rename');
    });
    await act(async () => { pending.resolve(reopenedResult(1)); await opening; });
    expectBinding(result.current, 'rebuilt-backend');
    expect(result.current.sessions[0]?.name).toBe('Same millisecond rename');
  });

  it('preserves a later legacy control binding without inventory in the returned payload', async () => {
    const pending = deferred<OpenSessionInventoryResult>();
    terminalMocks.openSessionInventoryEntry.mockReturnValue(pending.promise);
    const { result } = await readyHook();
    let opening!: ReturnType<typeof result.current.openSession>;
    act(() => { opening = result.current.openSession({ preferredFrontendSessionId: 'frontend-1' }); });
    const listener = clientStateMocks.subscribeClientState.mock.calls[0]![0] as (snapshot: unknown) => void;
    act(() => listener({ type: 'client-state', seq: 2, clientState: {
      updatedAt: 30, sessions: [{ ...cachedSession, backendSessionId: 'legacy-control' }, secondSession],
    } }));
    let settled!: Awaited<typeof opening>;
    await act(async () => { pending.resolve(reopenedResult()); settled = await opening; });
    expectBinding(result.current, 'legacy-control');
    expect(settled.terminalSession.sessionId).toBe('legacy-control');
  });


  it('does not restore stale same-backend payload hints after a later control fact cleared them', async () => {
    const pending = deferred<OpenSessionInventoryResult>();
    terminalMocks.openSessionInventoryEntry.mockReturnValue(pending.promise);
    const { result } = await readyHook();
    let opening!: ReturnType<typeof result.current.openSession>;
    act(() => { opening = result.current.openSession({ preferredFrontendSessionId: 'frontend-1' }); });
    const newer = reopenedResult(30).inventory;
    newer.clientSessions[0] = { ...newer.clientSessions[0]!, activeProgram: null, cwd: null, connected: false, live: false };
    const listener = clientStateMocks.subscribeClientState.mock.calls[0]![0] as (snapshot: unknown) => void;
    act(() => listener({ type: 'client-state', seq: 2, inventory: newer }));
    const oldResult = reopenedResult();
    oldResult.terminalSession.activeProgram = 'obsolete-program';
    let settled!: Awaited<typeof opening>;
    await act(async () => { pending.resolve(oldResult); settled = await opening; });
    expectBinding(result.current, 'rebuilt-backend');
    expect(settled.session).toMatchObject({ activeProgram: null, cwd: null, connected: false, live: false });
    expect(settled.terminalSession).toMatchObject({ sessionId: 'rebuilt-backend', activeProgram: null, cwd: null });
    expect(settled.terminalSession.activeProgramRaw).toBeUndefined();
    expect(settled.terminalSession.activeProgramSource).toBeUndefined();
  });
});
