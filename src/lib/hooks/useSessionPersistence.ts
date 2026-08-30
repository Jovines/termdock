import { useState, useEffect, useCallback, useRef } from 'react';
import {
  clearSessionInventoryEntries,
  getSessionInventory,
  openSessionInventoryEntry,
  removeSessionInventoryEntry,
  reorderSessionInventoryEntries,
  updateSessionInventoryEntry,
  type OpenSessionInventoryOptions,
  type OpenSessionInventoryResult,
  type SessionInventory,
  type SessionInventoryClientSession,
} from '../terminal';
import { subscribeClientState } from '../utils/clientStateSync';
import { pickSessionAfterClose } from '../utils/sessionSelection';

const LEGACY_STORAGE_KEY = 'termdock-sessions';
const ACTIVE_SESSION_STORAGE_KEY = 'termdock-active-session';
// 本地 session 列表缓存：用来让"返回 PWA / 冷启动"瞬间渲染 UI，避免卡在
// HTTP GET 的蜂窝 RTT（500ms-3s）期间显示全屏 loading。数据源仍以服务端
// inventory 为准：缓存命中后照常发起后台请求 reconcile，只有差异才更新 state。
const SESSIONS_CACHE_STORAGE_KEY = 'termdock-sessions-cache';

function readActiveSessionId(): string | null {
  try {
    const val = localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
    return val && val.trim().length > 0 ? val : null;
  } catch { return null; }
}

function writeActiveSessionId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, id);
    else localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
  } catch { /* ignore */ }
}

// 缓存读取/写入：损坏或缺失时返回 null，调用方走 HTTP fallback。
function readSessionsCache(): PersistedSession[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SESSIONS_CACHE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    // 轻量校验：保留外形对得上的条目，挡掉旧版本字段不全的脏数据
    return parsed.filter((s): s is PersistedSession =>
      typeof s === 'object' && s !== null &&
      typeof (s as { sessionId?: unknown }).sessionId === 'string' &&
      typeof (s as { name?: unknown }).name === 'string'
    );
  } catch {
    return null;
  }
}

function writeSessionsCache(sessions: PersistedSession[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SESSIONS_CACHE_STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    // localStorage 写满 / 隐私模式：忽略，下次启动靠 HTTP fallback
  }
}

function clearSessionsCache(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(SESSIONS_CACHE_STORAGE_KEY);
  } catch { /* ignore */ }
}

export interface PersistedSession {
  sessionId: string;  // 前端生成的 session ID
  name: string;
  customName: boolean;
  backendSessionId: string | null;  // 后端 sessionId，用于复用
  mode: 'shell' | 'tmux';
  tmuxSessionName: string | null;
  createdAt: number;
  lastActivity: number;
  // 展示名提示：缓存上次的程序名 / 目录，冷启动 hydrate 时直接算出 tab 名，
  // 不必等 WS 连上轮询 tmux，消除「先 wt-xxx 再跳成 coco termdock」的跳变。
  activeProgram?: string | null;
  cwd?: string | null;
}

interface UseSessionPersistenceReturn {
  sessions: PersistedSession[];
  inventory: SessionInventory | null;
  activeSessionId: string | null;
  isLoading: boolean;
  openSession: (options: OpenSessionInventoryOptions) => Promise<OpenSessionInventoryResult>;
  removeSession: (sessionId: string, preferredActiveSessionId?: string | null) => Promise<void>;
  updateSessionActivity: (sessionId: string) => void;
  setActiveSession: (sessionId: string | null) => void;
  updateSessionBackendId: (sessionId: string, backendSessionId: string) => Promise<void>;
  renameSession: (sessionId: string, newName: string) => Promise<void>;
  resetSessionCustomName: (sessionId: string) => Promise<void>;
  reorderSessions: (orderedIds: string[]) => Promise<void>;
  clearAllSessions: () => Promise<void>;
  restoreSessions: () => Promise<PersistedSession[]>;
}

type NormalizableSession = Omit<PersistedSession, 'customName'> & { customName?: boolean };

function normalizeSessionList(sessionList: NormalizableSession[]): PersistedSession[] {
  return sessionList.map((session) => ({
    ...session,
    mode: session.mode === 'tmux' ? 'tmux' : 'shell',
    tmuxSessionName: session.tmuxSessionName ?? null,
    customName: session.customName === true,
  }));
}

function normalizeInventorySessionList(sessionList: SessionInventoryClientSession[]): PersistedSession[] {
  return normalizeSessionList(sessionList.map((session) => ({
    sessionId: session.sessionId,
    name: session.name,
    customName: session.customName === true,
    backendSessionId: session.backendSessionId,
    mode: session.mode,
    tmuxSessionName: session.tmuxSessionName,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
  }))).map((normalized, index) => ({
    ...normalized,
    // 把 inventory 带来的展示名提示合并进来（normalizeSessionList 的输入类型
    // 不含这两个字段，这里按下标对齐补回）。
    activeProgram: sessionList[index]?.activeProgram ?? null,
    cwd: sessionList[index]?.cwd ?? null,
  }));
}

function sessionListKey(sessionList: PersistedSession[]): string {
  return sessionList
    .map((s) => `${s.sessionId}:${s.name}:${s.customName}:${s.backendSessionId}:${s.mode}:${s.tmuxSessionName}:${s.lastActivity}:${s.activeProgram ?? ''}:${s.cwd ?? ''}`)
    .join('|');
}

function pickValidActiveSessionId(sessionList: PersistedSession[], preferredSessionId: string | null): string | null {
  if (sessionList.length === 0) return null;
  return preferredSessionId && sessionList.some((session) => session.sessionId === preferredSessionId)
    ? preferredSessionId
    : (sessionList[0]?.sessionId ?? null);
}

export function readCachedSessionPersistenceSnapshot(): {
  sessions: PersistedSession[];
  activeSessionId: string | null;
} {
  const sessions = readSessionsCache() ?? [];
  return {
    sessions,
    activeSessionId: pickValidActiveSessionId(sessions, readActiveSessionId()),
  };
}

export function useSessionPersistence(): UseSessionPersistenceReturn {
  // 同步从 localStorage hydrate 初始状态：缓存命中时 isLoading 直接 false，
  // UI 可以瞬间渲染；缓存未命中（真·第一次启动 / 清过缓存）才走 HTTP fetch。
  const initialCached = useRef<PersistedSession[] | null>(readSessionsCache()).current;
  const initialActiveId = useRef<string | null>(readActiveSessionId()).current;
  const [sessions, setSessions] = useState<PersistedSession[]>(initialCached ?? []);
  const [inventory, setInventory] = useState<SessionInventory | null>(null);
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(
    initialCached && initialCached.length > 0
      ? pickValidActiveSessionId(initialCached, initialActiveId)
      : initialActiveId
  );
  const [isLoading, setIsLoading] = useState<boolean>(initialCached === null);
  const initialized = useRef(false);
  const activeSessionIdRef = useRef<string | null>(null);
  const isLoadingRef = useRef<boolean>(initialCached === null);
  const lastSnapshotSeqRef = useRef(0);
  // A cached cold-start GET and control-WS snapshots can both arrive after a
  // local delete. Keep deleted frontend IDs tombstoned for this hook lifetime
  // so an older snapshot cannot resurrect a tab whose backend is already gone.
  const removedSessionIdsRef = useRef(new Set<string>());
  // HTTP inventory responses are full snapshots. Track local mutations so a
  // request started before a mutation cannot overwrite its optimistic state.
  const localMutationRevisionRef = useRef(0);
  useEffect(() => { isLoadingRef.current = isLoading; }, [isLoading]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const reconcileActiveSessionId = useCallback((sessionList: PersistedSession[]) => {
    const nextActiveSessionId = pickValidActiveSessionId(sessionList, activeSessionIdRef.current ?? readActiveSessionId());
    setActiveSessionIdState((prev) => (prev === nextActiveSessionId ? prev : nextActiveSessionId));
    writeActiveSessionId(nextActiveSessionId);
    activeSessionIdRef.current = nextActiveSessionId;
    return nextActiveSessionId;
  }, []);

  const applySessionList = useCallback((sessionList: PersistedSession[], options?: { reconcileActive?: boolean }) => {
    const filteredSessionList = sessionList.filter((session) => !removedSessionIdsRef.current.has(session.sessionId));
    setSessions((prev) => (sessionListKey(prev) === sessionListKey(filteredSessionList) ? prev : filteredSessionList));
    writeSessionsCache(filteredSessionList);
    if (options?.reconcileActive) {
      reconcileActiveSessionId(filteredSessionList);
    }
  }, [reconcileActiveSessionId]);

  const applyInventory = useCallback((nextInventory: SessionInventory, options?: { reconcileActive?: boolean }) => {
    const filteredInventory = removedSessionIdsRef.current.size === 0
      ? nextInventory
      : {
          ...nextInventory,
          clientSessions: nextInventory.clientSessions.filter(
            (session) => !removedSessionIdsRef.current.has(session.sessionId),
          ),
        };
    setInventory(filteredInventory);
    applySessionList(normalizeInventorySessionList(filteredInventory.clientSessions), options);
  }, [applySessionList]);

  const discardLegacyLocalState = useCallback((): PersistedSession[] => {
    if (typeof window === 'undefined') {
      return [];
    }

    const stored = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!stored) {
      return [];
    }

    localStorage.removeItem(LEGACY_STORAGE_KEY);
    clearSessionsCache();
    writeActiveSessionId(null);
    setSessions([]);
    setActiveSessionIdState(null);
    console.info('[session-persist] discarded legacy local session cache');
    return [];
  }, []);

  // 从服务端 inventory 读取会话；activeSessionId 从 localStorage 读取（不再从服务器）。
  const restoreSessions = useCallback(async (): Promise<PersistedSession[]> => {
    if (typeof window === 'undefined') return [];
    const requestRevision = localMutationRevisionRef.current;

    try {
      const nextInventory = await getSessionInventory();
      const sessionList = normalizeInventorySessionList(nextInventory.clientSessions);
      if (requestRevision !== localMutationRevisionRef.current) {
        console.info('[session-inventory] ignored restore snapshot superseded by a local mutation');
        return sessionList.filter((session) => !removedSessionIdsRef.current.has(session.sessionId));
      }
      applyInventory(nextInventory, { reconcileActive: true });

      if (sessionList.length > 0) {
        return sessionList;
      }

      return discardLegacyLocalState();
    } catch (error) {
      console.error('Failed to restore sessions from server:', error);

      try {
        return discardLegacyLocalState();
      } catch (migrationError) {
        console.error('Failed to discard legacy local sessions:', migrationError);
      }
    } finally {
      setIsLoading(false);
    }

    return [];
  }, [applyInventory, discardLegacyLocalState]);

  const openSession = useCallback(async (options: OpenSessionInventoryOptions): Promise<OpenSessionInventoryResult> => {
    const mutationRevision = ++localMutationRevisionRef.current;
    const result = await openSessionInventoryEntry(options);
    if (mutationRevision === localMutationRevisionRef.current) {
      applyInventory(result.inventory);
      setActiveSessionIdState(result.session.sessionId);
      writeActiveSessionId(result.session.sessionId);
    }
    return result;
  }, [applyInventory]);

  const removeSession = useCallback(async (sessionId: string, preferredActiveSessionId?: string | null) => {
    ++localMutationRevisionRef.current;
    removedSessionIdsRef.current.add(sessionId);
    setSessions(prev => {
      const updated = prev.filter(s => s.sessionId !== sessionId);
      const preferredSessionStillExists = preferredActiveSessionId != null
        && updated.some((session) => session.sessionId === preferredActiveSessionId);
      const nextActiveSessionId = activeSessionIdRef.current === sessionId
        ? (preferredSessionStillExists
            ? preferredActiveSessionId
            : pickSessionAfterClose(prev, sessionId, (session) => session.sessionId))
        : activeSessionIdRef.current;
      setActiveSessionIdState(nextActiveSessionId);
      writeActiveSessionId(nextActiveSessionId);
      writeSessionsCache(updated);
      return updated;
    });

    try {
      await removeSessionInventoryEntry(sessionId);
    } catch (error) {
      console.error('Failed to remove session from inventory:', error);
    }
  }, []);

  // 更新会话活跃时间：当前只做本地缓存，服务端在 open / WS connect 时会更新 authority。
  const updateSessionActivity = useCallback((sessionId: string) => {
    const now = Date.now();
    setSessions(prev => {
      const updated = prev.map(s =>
        s.sessionId === sessionId ? { ...s, lastActivity: now } : s
      );
      writeSessionsCache(updated);
      return updated;
    });
  }, []);

  // 设置活跃会话（仅本地，不触发服务器持久化）
  const setActiveSession = useCallback((sessionId: string | null) => {
    setActiveSessionIdState(sessionId);
    writeActiveSessionId(sessionId);
  }, []);

  // 重命名会话
  const renameSession = useCallback(async (sessionId: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const mutationRevision = ++localMutationRevisionRef.current;

    setSessions(prev => {
      const updated = prev.map(s =>
        s.sessionId === sessionId ? { ...s, name: trimmed, customName: true } : s
      );
      writeSessionsCache(updated);
      return updated;
    });

    try {
      const nextInventory = await updateSessionInventoryEntry(sessionId, { name: trimmed, customName: true });
      if (mutationRevision === localMutationRevisionRef.current) applyInventory(nextInventory);
    } catch (error) {
      console.error('Failed to rename session in inventory:', error);
    }
  }, [applyInventory]);

  // 取消自定义名称,回退到默认显示规则
  const resetSessionCustomName = useCallback(async (sessionId: string) => {
    const mutationRevision = ++localMutationRevisionRef.current;
    setSessions(prev => {
      const updated = prev.map(s =>
        s.sessionId === sessionId ? { ...s, customName: false } : s
      );
      writeSessionsCache(updated);
      return updated;
    });

    try {
      const nextInventory = await updateSessionInventoryEntry(sessionId, { customName: false });
      if (mutationRevision === localMutationRevisionRef.current) applyInventory(nextInventory);
    } catch (error) {
      console.error('Failed to reset session name in inventory:', error);
    }
  }, [applyInventory]);

  // 重排会话顺序
  const reorderSessions = useCallback(async (orderedIds: string[]) => {
    const mutationRevision = ++localMutationRevisionRef.current;
    setSessions(prev => {
      const idToSession = new Map(prev.map(s => [s.sessionId, s]));
      const reordered = orderedIds
        .map(id => idToSession.get(id))
        .filter((s): s is PersistedSession => s !== undefined);
      const covered = new Set(orderedIds);
      const remaining = prev.filter(s => !covered.has(s.sessionId));
      const updated = [...reordered, ...remaining];
      writeSessionsCache(updated);
      return updated;
    });

    try {
      const nextInventory = await reorderSessionInventoryEntries(orderedIds);
      if (mutationRevision === localMutationRevisionRef.current) applyInventory(nextInventory);
    } catch (error) {
      console.error('Failed to reorder sessions in inventory:', error);
    }
  }, [applyInventory]);

  // 清除所有会话
  const clearAllSessions = useCallback(async () => {
    ++localMutationRevisionRef.current;
    for (const session of sessions) removedSessionIdsRef.current.add(session.sessionId);
    setSessions([]);
    setInventory(null);
    setActiveSessionIdState(null);
    writeActiveSessionId(null);
    clearSessionsCache();
    if (typeof window !== 'undefined') {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }

    try {
      await clearSessionInventoryEntries();
    } catch (error) {
      console.error('Failed to clear session inventory:', error);
    }
  }, [sessions]);

  // 更新会话的 backendSessionId
  const updateSessionBackendId = useCallback(async (sessionId: string, backendSessionId: string) => {
    const mutationRevision = ++localMutationRevisionRef.current;
    setSessions(prev => {
      const updated = prev.map(s =>
        s.sessionId === sessionId ? { ...s, backendSessionId } : s
      );
      writeSessionsCache(updated);
      return updated;
    });

    try {
      const nextInventory = await updateSessionInventoryEntry(sessionId, { backendSessionId });
      if (mutationRevision === localMutationRevisionRef.current) applyInventory(nextInventory);
    } catch (error) {
      console.error('Failed to update session backend in inventory:', error);
    }
  }, [applyInventory]);

  // 初始化时恢复会话
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      void restoreSessions();
    }
  }, [restoreSessions]);

  // 服务器推送的 session inventory 同步：通过 control WebSocket 实时接收。
  useEffect(() => {
    const unsubscribe = subscribeClientState((snapshot) => {
      if (snapshot.type !== 'client-state') return;
      if (isLoadingRef.current) return;
      const snapshotSeq = typeof snapshot.seq === 'number' ? snapshot.seq : null;
      if (snapshotSeq !== null) {
        if (snapshotSeq < lastSnapshotSeqRef.current) {
          console.warn('[session-inventory] ignored stale control snapshot', {
            seq: snapshotSeq,
            latestSeq: lastSnapshotSeqRef.current,
          });
          return;
        }
        lastSnapshotSeqRef.current = snapshotSeq;
      }
      if (snapshot.inventory) {
        applyInventory(snapshot.inventory, { reconcileActive: true });
        return;
      }

      const serverSessions = normalizeSessionList(snapshot.clientState.sessions || []);
      applySessionList(serverSessions, { reconcileActive: true });
    });
    return unsubscribe;
  }, [applyInventory, applySessionList]);

  return {
    sessions,
    inventory,
    activeSessionId,
    isLoading,
    openSession,
    removeSession,
    updateSessionActivity,
    setActiveSession,
    updateSessionBackendId,
    renameSession,
    resetSessionCustomName,
    reorderSessions,
    clearAllSessions,
    restoreSessions,
  };
}
