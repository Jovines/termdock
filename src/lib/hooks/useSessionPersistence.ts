import { useState, useEffect, useCallback, useRef } from 'react';
import { clearTerminalClientState, getTerminalClientState, replaceTerminalClientState, type PersistedTerminalClientSession } from '../terminal/api';
import { subscribeClientState } from '../utils/clientStateSync';

const LEGACY_STORAGE_KEY = 'termdock-sessions';
const ACTIVE_SESSION_STORAGE_KEY = 'termdock-active-session';
// 本地 session 列表缓存：用来让"返回 PWA / 冷启动"瞬间渲染 UI，避免卡在
// HTTP GET /api/terminal/client-state 的蜂窝 RTT（500ms-3s）期间显示全屏 loading。
// 数据源仍以服务端为准：缓存命中后照常发起后台请求 reconcile，只有差异才更新 state。
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
}

interface UseSessionPersistenceReturn {
  sessions: PersistedSession[];
  activeSessionId: string | null;
  isLoading: boolean;
  saveSession: (session: Omit<PersistedSession, 'createdAt' | 'lastActivity' | 'backendSessionId'>, backendSessionId: string | null) => void;
  removeSession: (sessionId: string) => void;
  updateSessionActivity: (sessionId: string) => void;
  setActiveSession: (sessionId: string | null) => void;
  updateSessionBackendId: (sessionId: string, backendSessionId: string) => void;
  renameSession: (sessionId: string, newName: string) => void;
  resetSessionCustomName: (sessionId: string) => void;
  reorderSessions: (orderedIds: string[]) => void;
  clearAllSessions: () => void;
  restoreSessions: () => Promise<PersistedSession[]>;
}

export function useSessionPersistence(): UseSessionPersistenceReturn {
  // 同步从 localStorage hydrate 初始状态：缓存命中时 isLoading 直接 false，
  // UI 可以瞬间渲染；缓存未命中（真·第一次启动 / 清过缓存）才走 HTTP fetch。
  const initialCached = useRef<PersistedSession[] | null>(readSessionsCache()).current;
  const initialActiveId = useRef<string | null>(readActiveSessionId()).current;
  const [sessions, setSessions] = useState<PersistedSession[]>(initialCached ?? []);
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(
    initialCached && initialCached.length > 0 ? initialActiveId : null
  );
  const [isLoading, setIsLoading] = useState<boolean>(initialCached === null);
  const initialized = useRef(false);
  const persistQueueRef = useRef<Promise<void>>(Promise.resolve());
  const persistGenerationRef = useRef(0);
  const completedPersistGenerationRef = useRef(0);
  const activeSessionIdRef = useRef<string | null>(null);
  // Mirror of `isLoading` for use inside the WS subscribe effect, whose
  // body cannot read the React state value at subscribe time.
  const isLoadingRef = useRef<boolean>(initialCached === null);
  useEffect(() => { isLoadingRef.current = isLoading; }, [isLoading]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const normalizeSessionList = useCallback((sessionList: PersistedTerminalClientSession[]): PersistedSession[] => {
    return sessionList.map((session) => ({
      ...session,
      mode: session.mode === 'tmux' ? 'tmux' : 'shell',
      tmuxSessionName: session.tmuxSessionName ?? null,
      customName: session.customName === true,
    }));
  }, []);

  const queuePersist = useCallback((sessionList: PersistedSession[]) => {
    const generation = ++persistGenerationRef.current;
    // 同步写本地缓存，让下次冷启动可以 hydrate 出最新列表
    writeSessionsCache(sessionList);

    persistQueueRef.current = persistQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        try {
          if (sessionList.length === 0) {
            await clearTerminalClientState();
            return;
          }
          // Only send sessions, not activeSessionId (that's localStorage-only now)
          await replaceTerminalClientState({ sessions: sessionList });
        } catch (error) {
          console.error('Failed to persist sessions to server:', error);
        } finally {
          completedPersistGenerationRef.current = Math.max(
            completedPersistGenerationRef.current,
            generation,
          );
        }
      });
  }, []);

  const migrateLegacyLocalState = useCallback(async (): Promise<PersistedSession[]> => {
    if (typeof window === 'undefined') {
      return [];
    }

    const stored = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!stored) {
      return [];
    }

    const data = JSON.parse(stored);
    const sessionList = normalizeSessionList((data.sessions || []) as PersistedTerminalClientSession[]);
    const storedActiveSessionId = typeof data.activeSessionId === 'string' && data.activeSessionId.trim().length > 0
      ? data.activeSessionId
      : null;

    setSessions(sessionList);
    if (storedActiveSessionId) {
      setActiveSessionIdState(storedActiveSessionId);
      writeActiveSessionId(storedActiveSessionId);
    }

    if (sessionList.length > 0) {
      await replaceTerminalClientState({ sessions: sessionList });
    } else {
      await clearTerminalClientState();
    }

    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return sessionList;
  }, [normalizeSessionList]);

  // 从服务端读取会话；首次访问时迁移旧版 localStorage 数据。
  // activeSessionId 从 localStorage 读取（不再从服务器）。
  //
  // 如果本地缓存已经 hydrate 出 sessions，这里只是在背景 reconcile，发现一致就 no-op，
  // 避免 setSessions 触发无意义的 re-render（会让 Swiper 闪一下）。
  const restoreSessions = useCallback(async (): Promise<PersistedSession[]> => {
    if (typeof window === 'undefined') return [];

    try {
      const data = await getTerminalClientState();
      const sessionList = normalizeSessionList(data.sessions || []);
      // Read activeSessionId from localStorage, not server
      const restoredActiveSessionId = readActiveSessionId();

      if (sessionList.length > 0) {
        // Diff: 服务端列表与现有 state 一致就跳过 setSessions
        setSessions((prev) => {
          const key = (s: PersistedSession) => `${s.sessionId}:${s.name}:${s.customName}:${s.backendSessionId}:${s.mode}:${s.tmuxSessionName}`;
          const prevKey = prev.map(key).join('|');
          const nextKey = sessionList.map(key).join('|');
          if (prevKey === nextKey) return prev;
          return sessionList;
        });
        // Only set activeSessionId if it still exists in the session list
        const validActiveId = sessionList.some(s => s.sessionId === restoredActiveSessionId)
          ? restoredActiveSessionId
          : (sessionList[0]?.sessionId ?? null);
        setActiveSessionIdState((prev) => (prev === validActiveId ? prev : validActiveId));
        writeActiveSessionId(validActiveId);
        writeSessionsCache(sessionList);
        return sessionList;
      }

      return await migrateLegacyLocalState();
    } catch (error) {
      console.error('Failed to restore sessions from server:', error);

      try {
        return await migrateLegacyLocalState();
      } catch (migrationError) {
        console.error('Failed to migrate legacy local sessions:', migrationError);
      }
    } finally {
      setIsLoading(false);
    }

    return [];
  }, [migrateLegacyLocalState, normalizeSessionList]);

  // 保存新会话（带去重：同 sessionId 或同 tmuxSessionName 更新已有条目）
  const saveSession = useCallback((session: Omit<PersistedSession, 'createdAt' | 'lastActivity' | 'backendSessionId'>, backendSessionId: string | null) => {
    const now = Date.now();
    const newSession: PersistedSession = {
      ...session,
      backendSessionId,
      mode: session.mode === 'tmux' ? 'tmux' : 'shell',
      tmuxSessionName: session.tmuxSessionName ?? null,
      customName: session.customName ?? false,
      createdAt: now,
      lastActivity: now,
    };

    setSessions(prev => {
      // 去重：相同 sessionId 直接更新
      const exactIdx = prev.findIndex(s => s.sessionId === session.sessionId);
      if (exactIdx >= 0) {
        const updated = [...prev];
        updated[exactIdx] = newSession;
        queuePersist(updated);
        return updated;
      }

      // 去重：tmux 模式同名 session 视为同一个，替换已有条目
      if (newSession.mode === 'tmux' && newSession.tmuxSessionName) {
        const tmuxIdx = prev.findIndex(
          s => s.mode === 'tmux' && s.tmuxSessionName === newSession.tmuxSessionName
        );
        if (tmuxIdx >= 0) {
          const updated = [...prev];
          updated[tmuxIdx] = newSession;
          queuePersist(updated);
          return updated;
        }
      }

      const updated = [...prev, newSession];
      queuePersist(updated);
      return updated;
    });

    setActiveSessionIdState(session.sessionId);
    writeActiveSessionId(session.sessionId);
  }, [queuePersist]);

  // 移除会话
  const removeSession = useCallback((sessionId: string) => {
    setSessions(prev => {
      const updated = prev.filter(s => s.sessionId !== sessionId);
      const nextActiveSessionId = activeSessionIdRef.current === sessionId
        ? (updated[0]?.sessionId ?? null)
        : activeSessionIdRef.current;
      setActiveSessionIdState(nextActiveSessionId);
      writeActiveSessionId(nextActiveSessionId);
      queuePersist(updated);
      return updated;
    });
  }, [queuePersist]);

  // 更新会话活跃时间
  const updateSessionActivity = useCallback((sessionId: string) => {
    const now = Date.now();
    setSessions(prev => {
      const updated = prev.map(s =>
        s.sessionId === sessionId ? { ...s, lastActivity: now } : s
      );
      queuePersist(updated);
      return updated;
    });
  }, [queuePersist]);

  // 设置活跃会话（仅本地，不触发服务器持久化）
  const setActiveSession = useCallback((sessionId: string | null) => {
    setActiveSessionIdState(sessionId);
    writeActiveSessionId(sessionId);
  }, []);

  // 重命名会话
  const renameSession = useCallback((sessionId: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;

    setSessions(prev => {
      const updated = prev.map(s =>
        s.sessionId === sessionId ? { ...s, name: trimmed, customName: true } : s
      );
      queuePersist(updated);
      return updated;
    });
  }, [queuePersist]);

  // 取消自定义名称,回退到默认显示规则
  const resetSessionCustomName = useCallback((sessionId: string) => {
    setSessions(prev => {
      const updated = prev.map(s =>
        s.sessionId === sessionId ? { ...s, customName: false } : s
      );
      queuePersist(updated);
      return updated;
    });
  }, [queuePersist]);

  // 重排会话顺序
  const reorderSessions = useCallback((orderedIds: string[]) => {
    setSessions(prev => {
      const idToSession = new Map(prev.map(s => [s.sessionId, s]));
      const reordered = orderedIds
        .map(id => idToSession.get(id))
        .filter((s): s is PersistedSession => s !== undefined);
      const covered = new Set(orderedIds);
      const remaining = prev.filter(s => !covered.has(s.sessionId));
      const updated = [...reordered, ...remaining];
      queuePersist(updated);
      return updated;
    });
  }, [queuePersist]);

  // 清除所有会话
  const clearAllSessions = useCallback(() => {
    setSessions([]);
    setActiveSessionIdState(null);
    writeActiveSessionId(null);
    clearSessionsCache();
    queuePersist([]);
    if (typeof window !== 'undefined') {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  }, [queuePersist]);

  // 更新会话的 backendSessionId
  const updateSessionBackendId = useCallback((sessionId: string, backendSessionId: string) => {
    setSessions(prev => {
      const updated = prev.map(s =>
        s.sessionId === sessionId ? { ...s, backendSessionId } : s
      );
      queuePersist(updated);
      return updated;
    });
  }, [queuePersist]);

  // 初始化时恢复会话
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      restoreSessions();
    }
  }, [restoreSessions]);

  // 服务器推送的 client-state 同步：通过 control WebSocket 实时接收。
  // 取代了之前 5s 一次的 HTTP 轮询——多设备 / 多 tab 之间的修改现在
  // 走的是"谁先 PUT 到服务器就立刻广播给所有订阅者"，延迟从秒级降到
  // 单个 WS RTT。
  //
  // 同样通过 persistGenerationRef 防止一次本地 close/create/rename
  // 的乐观更新被服务器的旧快照覆盖（旧快照 vs 本地最新状态：本地赢）。
  useEffect(() => {
    const unsubscribe = subscribeClientState((snapshot) => {
      if (isLoadingRef.current) return;
      // Skip applying server snapshots while a local mutation is in flight.
      // The PUT will land and the next snapshot will reflect the change.
      if (completedPersistGenerationRef.current < persistGenerationRef.current) {
        return;
      }

      const serverSessions = normalizeSessionList(snapshot.sessions || []);

      setSessions(prev => {
        const key = (s: PersistedSession) => `${s.sessionId}:${s.name}:${s.customName}:${s.backendSessionId}:${s.mode}:${s.tmuxSessionName}`;
        const prevKey = prev.map(key).join('|');
        const nextKey = serverSessions.map(key).join('|');
        if (prevKey === nextKey) return prev;
        return serverSessions;
      });

      // 同步本地缓存：下次冷启动直接 hydrate 出最新列表。
      writeSessionsCache(serverSessions);
    });
    return unsubscribe;
  }, [normalizeSessionList]);

  return {
    sessions,
    activeSessionId,
    isLoading,
    saveSession,
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
