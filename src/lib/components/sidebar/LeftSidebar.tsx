import {
  X as RiCloseLine,
  Plus as RiAddLine,
  Settings as RiSettings4Line,
  Terminal as RiTerminalLine,
  LayoutGrid as RiLayoutGridLine,
  Search as RiSearchLine,
  LoaderCircle as RiLoaderCircle,
  ArrowDownWideNarrow as RiSortDescLine,
  FolderTree as RiFolderTreeLine,
  ChevronRight as RiChevronRightLine,
  Bell as RiBellLine,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DragDropContext, Droppable, Draggable, type DropResult, type DraggableProvidedDragHandleProps } from '@hello-pangea/dnd';
import { Sidebar } from './Sidebar';
import type { AgentStatus } from '../../terminal/types';
import { getCwdLeafName, getSessionDisplayName, buildFolderGroups, folderGroupKeyForCwd, reorderGroupedSessionIds, reorderSessionsWithinGroup, DEFAULT_SESSION_DISPLAY_SHELL_NAMES } from '../../terminal/display';
import { AgentSessionDot, AgentCountBadge } from '../AgentIndicators';
import { useI18n } from '../../i18n';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useSidebarStore } from '../../stores/useSidebarStore';

const AUTO_SORT_ACTIVE_SESSIONS_STORAGE_KEY = 'termdock-sidebar-auto-sort-active-sessions';
const MANUAL_SESSION_ORDER_BEFORE_AUTO_SORT_STORAGE_KEY = 'termdock-sidebar-manual-order-before-auto-sort';
// 最近活跃排序不是竞速榜：只分「最近活跃」和「非活跃」两组。
// 活跃组整体在前，但组内保持当前相对顺序，避免两个持续输出的 session
// 按毫秒级 lastOutputAt 来回抢第一个位置。
const RECENT_ACTIVITY_WINDOW_MS = 60_000;
// 输出可能每帧到达，侧边栏无需每帧重排。低频采样让排序更 lazy，也减少 UI 抖动。
const ACTIVITY_SNAPSHOT_THROTTLE_MS = 2_000;
// 即使没有新输出，也定期刷新一次 now，让超过窗口的 session 能自然退回非活跃组。
const ACTIVITY_WINDOW_REFRESH_MS = 10_000;

function readAutoSortActiveSessionsEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(AUTO_SORT_ACTIVE_SESSIONS_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeAutoSortActiveSessionsEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (enabled) window.localStorage.setItem(AUTO_SORT_ACTIVE_SESSIONS_STORAGE_KEY, '1');
    else window.localStorage.removeItem(AUTO_SORT_ACTIVE_SESSIONS_STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}

function readStoredManualSessionOrder(): string[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(MANUAL_SESSION_ORDER_BEFORE_AUTO_SORT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((id) => typeof id === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredManualSessionOrder(sessionIds: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MANUAL_SESSION_ORDER_BEFORE_AUTO_SORT_STORAGE_KEY, JSON.stringify(sessionIds));
  } catch {
    // ignore storage failures
  }
}

function clearStoredManualSessionOrder(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(MANUAL_SESSION_ORDER_BEFORE_AUTO_SORT_STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}

function readOutputActivitySnapshot(): Map<string, number> {
  const snapshot = new Map<string, number>();
  for (const [id, state] of useTerminalStore.getState().sessions) {
    if (typeof state.lastOutputAt === 'number') {
      snapshot.set(id, state.lastOutputAt);
    }
  }
  return snapshot;
}

function areOutputActivitySnapshotsEqual(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, value] of b) {
    if (a.get(id) !== value) return false;
  }
  return true;
}

function isSessionRecentlyActive(
  sessionId: string,
  outputActivityBySession: Map<string, number>,
  now: number,
): boolean {
  const activity = outputActivityBySession.get(sessionId) ?? 0;
  return activity > 0 && now - activity <= RECENT_ACTIVITY_WINDOW_MS;
}

function compareSessionsByActivityBucket<T extends { id: string }>(
  a: T,
  b: T,
  outputActivityBySession: Map<string, number>,
  currentIndexBySession: Map<string, number>,
  now: number,
): number {
  const aActive = isSessionRecentlyActive(a.id, outputActivityBySession, now);
  const bActive = isSessionRecentlyActive(b.id, outputActivityBySession, now);
  if (aActive !== bActive) return aActive ? -1 : 1;
  return (currentIndexBySession.get(a.id) ?? 0) - (currentIndexBySession.get(b.id) ?? 0);
}

function getActivityBucketSortedSessionIds<T extends { id: string }>(
  sessions: T[],
  outputActivityBySession: Map<string, number>,
  now: number,
): string[] {
  const currentIndexBySession = new Map(sessions.map((session, index) => [session.id, index]));
  return [...sessions]
    .sort((a, b) => compareSessionsByActivityBucket(a, b, outputActivityBySession, currentIndexBySession, now))
    .map((session) => session.id);
}

interface LeftSidebarProps {
  isOpen: boolean;
  drawerWidthPx: number;
  onClose: () => void;
  onOpen?: () => void;
  sessions: Array<{
    id: string;
    name: string;
    mode: 'shell' | 'tmux';
    customName?: boolean;
  }>;
  activeSessionId: string | null;
  sessionStates: Map<string, {
    cwd: string | null;
    activeProgram: string | null;
    inCopyMode?: boolean;
    isConnecting?: boolean;
    agentStatus: AgentStatus | null;
    agentNeedsReview?: boolean;
    shellTitle?: string | null;
    promptState?: 'idle' | 'running' | null;
  }>; 
  onNewSession: (opts?: { mode?: 'shell' | 'tmux'; tmuxSessionName?: string }) => void;
  onCloseSession: (sessionId: string) => void;
  onReorderSessions: (sessionIds: string[]) => void;
  onOpenSettings: () => void;
  tmuxAvailable?: boolean;
  defaultSessionMode?: 'shell' | 'tmux';
  push?: boolean;
}

function matchesSession(
  query: string,
  session: LeftSidebarProps['sessions'][number],
  state?: LeftSidebarProps['sessionStates'] extends Map<string, infer T> ? T : never,
): boolean {
  if (!query) return true;
  const haystack = [
    session.name,
    session.mode,
    state?.cwd,
    state?.activeProgram,
    getCwdLeafName(state?.cwd ?? null),
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function StatusDot({
  status,
  needsReview,
  inCopyMode,
}: { status: AgentStatus | null; needsReview?: boolean; inCopyMode?: boolean }) {
  return <AgentSessionDot status={status} needsReview={needsReview} inCopyMode={inCopyMode} />;
}

export function LeftSidebar(
  {
    isOpen, drawerWidthPx, onClose, onOpen,
    sessions, activeSessionId, sessionStates,
    onNewSession, onCloseSession, onReorderSessions, onOpenSettings,
    tmuxAvailable = true,
    defaultSessionMode = 'shell',
    push,
  }: LeftSidebarProps,
) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [confirmNewMode, setConfirmNewMode] = useState<'shell' | 'tmux' | null>(null);
  const [autoSortByActivity, setAutoSortByActivity] = useState(readAutoSortActiveSessionsEnabled);
  const groupByFolder = useSidebarStore((s) => s.groupByFolder);
  const collapsedGroups = useSidebarStore((s) => s.collapsedGroups);
  const toggleGroupCollapsed = useSidebarStore((s) => s.toggleGroupCollapsed);
  const [outputActivityBySession, setOutputActivityBySession] = useState<Map<string, number>>(readOutputActivitySnapshot);
  const [activityClock, setActivityClock] = useState(() => Date.now());
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
  // 由「翻页→自动展开」机制维护的分组 key 集合，用于区分：
  //  - 自动展开（翻页进来时我们手动 expand）：翻走后允许自动收起
  //  - 用户手动展开：不参与自动收起，尊重用户意图
  // 用 ref 而非 state：变更不需要触发重渲染，store 自身的 collapsedGroups 才是真相。
  const autoExpandedGroupKeysRef = useRef<Set<string>>(new Set());
  const prevAutoManagedGroupKeyRef = useRef<string | null>(null);
  const trimmedQuery = query.trim();
  const isFiltering = trimmedQuery.length > 0;
  // 分组模式下禁用拖拽（与搜索 / 自动排序一致）。
  const dragDisabled = isFiltering || autoSortByActivity || groupByFolder;

  useEffect(() => {
    writeAutoSortActiveSessionsEnabled(autoSortByActivity);
    if (!autoSortByActivity) return;

    const publishSnapshot = (state = useTerminalStore.getState()) => {
      setActivityClock(Date.now());
      const next = new Map<string, number>();
      for (const [id, sessionState] of state.sessions) {
        if (typeof sessionState.lastOutputAt === 'number') {
          next.set(id, sessionState.lastOutputAt);
        }
      }
      setOutputActivityBySession((current) => (
        areOutputActivitySnapshotsEqual(current, next) ? current : next
      ));
    };

    publishSnapshot();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refreshTimer = setInterval(() => publishSnapshot(), ACTIVITY_WINDOW_REFRESH_MS);
    const unsubscribe = useTerminalStore.subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        publishSnapshot();
      }, ACTIVITY_SNAPSHOT_THROTTLE_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
      clearInterval(refreshTimer);
    };
  }, [autoSortByActivity]);

  const visibleSessions = useMemo(() => {
    return sessions.filter((session) => matchesSession(trimmedQuery, session, sessionStates.get(session.id)));
  }, [trimmedQuery, sessions, sessionStates]);

  useEffect(() => {
    if (!autoSortByActivity || isFiltering) return;
    const sortedIds = getActivityBucketSortedSessionIds(sessions, outputActivityBySession, activityClock);
    const currentIds = sessions.map((session) => session.id);
    if (sortedIds.join('\u0000') === currentIds.join('\u0000')) return;
    onReorderSessions(sortedIds);
  }, [activityClock, autoSortByActivity, isFiltering, onReorderSessions, outputActivityBySession, sessions]);

  const { runningCount, reviewCount } = useMemo(() => {
    let running = 0;
    let review = 0;
    for (const s of sessions) {
      const ts = sessionStates.get(s.id);
      if (ts?.agentStatus === 'running') running += 1;
      if (ts?.agentStatus === 'waiting' || ts?.agentNeedsReview) review += 1;
    }
    return { runningCount: running, reviewCount: review };
  }, [sessions, sessionStates]);

  useEffect(() => {
    if (!isOpen) return;
    activeItemRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeSessionId, isOpen, visibleSessions.length, collapsedGroups]);

  // 当前 active session 所在的分组 key（按 cwd 派生），用于「翻页→自动展开/收起」机制。
  // 关闭分组开关或无 active session 时返回 null，不参与自动管理。
  const activeSessionGroupKey = useMemo<string | null>(() => {
    if (!groupByFolder || !activeSessionId) return null;
    const cwd = sessionStates.get(activeSessionId)?.cwd ?? null;
    return folderGroupKeyForCwd(cwd);
  }, [groupByFolder, activeSessionId, sessionStates]);

  // 翻页联动：active session 切换时同步它所在分组的展开状态。
  //  - 当前所在组若收起 → 自动展开，并记入 auto-expanded 集合（用户翻走后允许自动收起）。
  //  - 上一组若在 auto-expanded 集合中 → 自动收起，移出集合。
  //  - 用户手动 toggle 的组由 click handler 单独清掉 auto 标记，不会被本 effect 收回。
  //  - ''（无 cwd 的「其他」桶）不参与：它语义上是聚合桶，自动展开没意义。
  useEffect(() => {
    if (!groupByFolder) {
      // 分组关闭时清掉追踪状态，等下次开启重新建立。
      prevAutoManagedGroupKeyRef.current = null;
      autoExpandedGroupKeysRef.current.clear();
      return;
    }
    if (!activeSessionId) {
      prevAutoManagedGroupKeyRef.current = null;
      return;
    }

    const store = useSidebarStore.getState();
    const autoSet = autoExpandedGroupKeysRef.current;
    const prevKey = prevAutoManagedGroupKeyRef.current;
    const currentKey = activeSessionGroupKey;

    // 离开旧组：旧组若是「自动展开」的就收回。
    if (prevKey !== null && prevKey !== currentKey && autoSet.has(prevKey)) {
      if (!store.collapsedGroups.has(prevKey)) {
        store.toggleGroupCollapsed(prevKey);
      }
      autoSet.delete(prevKey);
    }

    // 进入新组：新组若收起就展开。''（无 cwd）跳过，避免「其他」桶被频繁抖动。
    if (currentKey !== null && currentKey !== '' && store.collapsedGroups.has(currentKey)) {
      store.toggleGroupCollapsed(currentKey);
      autoSet.add(currentKey);
    }

    prevAutoManagedGroupKeyRef.current = currentKey;
  }, [groupByFolder, activeSessionId, activeSessionGroupKey]);

  useEffect(() => {
    if (!isOpen) {
      setQuery('');
      setSearchOpen(false);
      setConfirmNewMode(null);
    }
  }, [isOpen]);

  useEffect(() => {
    setConfirmNewMode(null);
  }, [defaultSessionMode, tmuxAvailable]);

  const closeIfOverlay = () => {
    if (!push) onClose();
  };
  const shellConfirming = confirmNewMode === 'shell';
  const tmuxConfirming = confirmNewMode === 'tmux';
  const highlightedNewMode = confirmNewMode ?? defaultSessionMode;
  const shellHighlighted = highlightedNewMode === 'shell';
  const tmuxHighlighted = highlightedNewMode === 'tmux' && tmuxAvailable;
  const handleNewSessionClick = (mode: 'shell' | 'tmux') => {
    if (mode === 'tmux' && !tmuxAvailable) return;

    setConfirmNewMode(null);
    onNewSession({ mode });
    closeIfOverlay();
  };

  const handleSessionDragEnd = useCallback((result: DropResult) => {
    if (dragDisabled) return;
    if (!result.destination || result.source.index === result.destination.index) return;
    const reordered = [...sessions];
    const [moved] = reordered.splice(result.source.index, 1);
    reordered.splice(result.destination.index, 0, moved);
    onReorderSessions(reordered.map((session) => session.id));
  }, [dragDisabled, onReorderSessions, sessions]);

  const handleToggleAutoSortByActivity = useCallback(() => {
    setAutoSortByActivity((enabled) => {
      const nextEnabled = !enabled;
      if (nextEnabled) {
        writeStoredManualSessionOrder(sessions.map((session) => session.id));
      } else {
        const storedOrder = readStoredManualSessionOrder();
        if (storedOrder) {
          onReorderSessions(storedOrder);
        }
        clearStoredManualSessionOrder();
      }
      return nextEnabled;
    });
  }, [onReorderSessions, sessions]);

  // 分组与「最近活跃排序」互斥：开启分组时关掉自动排序并恢复手动顺序。
  // 分组开关本身存在共享 store，互斥副作用（autoSort 仍是本地 state）留在这里。
  const handleToggleGroupByFolder = useCallback(() => {
    const willEnable = !useSidebarStore.getState().groupByFolder;
    useSidebarStore.getState().toggleGroupByFolder();
    if (willEnable && readAutoSortActiveSessionsEnabled()) {
      setAutoSortByActivity(false);
      const storedOrder = readStoredManualSessionOrder();
      if (storedOrder) onReorderSessions(storedOrder);
      clearStoredManualSessionOrder();
    }
  }, [onReorderSessions]);

  // 会话行主体（切换按钮 + 关闭按钮），flat / 分组两种布局共用。
  // dragHandleProps 仅在可拖拽的 flat 模式传入。
  const renderSessionRowBody = useCallback((
    session: LeftSidebarProps['sessions'][number],
    dragHandleProps?: DraggableProvidedDragHandleProps | null,
  ) => {
    const isActive = session.id === activeSessionId;
    const ts = sessionStates.get(session.id);
    const cwdLeaf = getCwdLeafName(ts?.cwd ?? null);
    const displayName = getSessionDisplayName(
      session,
      ts?.activeProgram ?? null,
      ts?.cwd ?? null,
      DEFAULT_SESSION_DISPLAY_SHELL_NAMES,
      ts?.shellTitle ?? null,
      ts?.promptState ?? null,
    );
    const cwdSecondary = cwdLeaf && cwdLeaf !== displayName ? cwdLeaf : null;
    // Shell integration (OSC 133) provides real-time running state.
    // Fall back to agentStatus for AI tools that don't emit OSC 133.
    const isRunning = ts?.promptState === 'running' || ts?.agentStatus === 'running';
    const accentClass = isRunning
      ? 'bg-[var(--success)]'
      : (ts?.agentStatus === 'waiting' || ts?.agentNeedsReview)
        ? 'bg-[var(--warning)]'
        : ts?.inCopyMode
          ? 'bg-[rgb(var(--warning-rgb)_/_0.70)]'
          : 'bg-primary';
    return (
      <>
        <button
          ref={isActive ? activeItemRef : null}
          type="button"
          {...(dragHandleProps ?? {})}
          onClick={() => {
            window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: session.id }));
            closeIfOverlay();
          }}
          className="relative min-w-0 flex flex-1 items-center gap-2 overflow-hidden py-1.5 pl-2 pr-1 text-left"
          title={ts?.cwd ?? session.name}
        >
          {isActive && (
            <span className={`absolute inset-y-2 left-0 w-0.5 rounded-full ${accentClass}`} />
          )}
          <span className={`relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
            isActive
              ? session.mode === 'tmux'
                ? 'bg-[rgb(var(--tmux-rgb)_/_0.15)] text-[color:var(--tmux)]'
                : 'bg-primary/15 text-primary'
              : session.mode === 'tmux'
                ? 'bg-surface text-[rgb(var(--tmux-rgb)_/_0.80)]'
                : 'bg-surface text-muted-foreground'
          }`}>
            {ts?.isConnecting ? (
              <RiLoaderCircle size={12} className="animate-spin" />
            ) : session.mode === 'tmux' ? (
              <RiLayoutGridLine size={12} />
            ) : (
              <RiTerminalLine size={12} />
            )}
            <StatusDot
              status={ts?.agentStatus ?? null}
              needsReview={ts?.agentNeedsReview}
              inCopyMode={ts?.inCopyMode}
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className={`block truncate text-[13px] leading-tight ${
              isActive ? 'font-medium text-foreground' : ''
            } ${ts?.inCopyMode ? 'text-[color:var(--warning)]' : ''}`}>
              {displayName}
            </span>
            {cwdSecondary && (
              <span className="block truncate text-[10.5px] leading-tight text-muted-foreground/75">
                {cwdSecondary}
              </span>
            )}
          </span>
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onCloseSession(session.id);
          }}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition hover:bg-destructive/15 hover:text-destructive active:scale-95"
          aria-label={t('sidebar.closeSession', { name: displayName })}
          title={t('common.close')}
        >
          <RiCloseLine size={13} />
        </button>
      </>
    );
  }, [activeSessionId, sessionStates, onCloseSession, t]);

  // 分组模式下：按 cwd 把当前可见会话归组。
  const folderGroups = useMemo(() => {
    if (!groupByFolder) return [];
    return buildFolderGroups(
      visibleSessions,
      (session) => sessionStates.get(session.id)?.cwd ?? null,
      t('sidebar.ungrouped'),
    );
  }, [groupByFolder, visibleSessions, sessionStates, t]);

  // 分组模式下的拖拽：单个 DragDropContext，按 result.type 区分两种拖动。
  //  - type 'group'：整组顺序拖动（组与组之间排序），组内顺序不变。
  //  - type 'session'：组内排序；禁止跨组拖动（分组依据是 cwd，跨组无意义）。
  // 搜索过滤时禁用（folderGroups 基于 visibleSessions，回写会丢失被过滤掉的会话）。
  const handleGroupedDragEnd = useCallback((result: DropResult) => {
    if (isFiltering) return;
    if (!result.destination) return;
    if (result.type === 'group') {
      if (result.source.index === result.destination.index) return;
      onReorderSessions(reorderGroupedSessionIds(folderGroups, result.source.index, result.destination.index));
      return;
    }
    if (result.source.droppableId !== result.destination.droppableId) return;
    if (result.source.index === result.destination.index) return;
    const groupKey = result.source.droppableId.replace(/^group-sessions:/, '');
    onReorderSessions(reorderSessionsWithinGroup(folderGroups, groupKey, result.source.index, result.destination.index));
  }, [isFiltering, folderGroups, onReorderSessions]);

  // 分组模式顶部「待处理」聚合区：跨组聚合所有 waiting / 跑完待查看的会话，
  // 按 sessions 原始顺序排列。这样无论会话属于哪个组、组是否折叠，都能在
  // 顶部一眼看到并直接点入——动态紧急度独立于稳定的分组组织。
  const attentionSessions = useMemo(() => {
    if (!groupByFolder) return [];
    return visibleSessions.filter((session) => {
      const ts = sessionStates.get(session.id);
      return ts?.agentStatus === 'waiting' || ts?.agentNeedsReview;
    });
  }, [groupByFolder, visibleSessions, sessionStates]);

  return (
    <Sidebar
      side="left"
      isOpen={isOpen}
      drawerWidthPx={drawerWidthPx}
      onClose={onClose}
      onOpen={onOpen}
      push={push}
    >
      {/* Header — single compact row */}
      <div className="shrink-0 border-b border-border/15 px-2 py-2">
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1 px-1">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[13px] font-semibold text-foreground">{t('sidebar.sessions')}</span>
              <span className="text-[11px] text-muted-foreground">{sessions.length}</span>
              {(runningCount > 0 || reviewCount > 0) && (
                <span className="ml-1 flex items-center gap-1.5">
                  <AgentCountBadge count={runningCount} tone="running" title={t('agent.aiRunning')} />
                  <AgentCountBadge count={reviewCount} tone="review" title={t('agent.needsReview')} />
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setSearchOpen((prev) => !prev);
              if (!searchOpen) setTimeout(() => {
                document.querySelector<HTMLInputElement>('input[data-left-search]')?.focus();
              }, 50);
            }}
            className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition active:scale-95 ${
              searchOpen
                ? 'bg-primary/15 text-primary'
                : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
            }`}
            aria-label={t('sidebar.toggleSearch')}
            title={t('common.search')}
          >
            <RiSearchLine size={14} />
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
            aria-label={t('sidebar.settings')}
            title={t('sidebar.settings')}
          >
            <RiSettings4Line size={14} />
          </button>
          {!push && (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-destructive/20 hover:text-destructive active:scale-95"
              aria-label={t('common.close')}
            >
              <RiCloseLine size={14} />
            </button>
          )}
        </div>

        {searchOpen && (
          <div className="mt-2 flex items-center gap-2 rounded-full bg-surface-2 px-3 py-1.5 text-muted-foreground focus-within:bg-surface-elevated">
            <RiSearchLine size={12} className="shrink-0" />
            <input
              data-left-search
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('sidebar.filterSessions')}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              enterKeyHint="search"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="rounded-full p-0.5 text-muted-foreground hover:bg-surface hover:text-foreground"
                aria-label={t('sidebar.clearSearch')}
              >
                <RiCloseLine size={12} />
              </button>
            )}
          </div>
        )}

        <div className="mt-2 flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleToggleAutoSortByActivity}
            className={`flex min-w-0 flex-1 items-center gap-2 rounded-full px-2.5 py-1.5 text-left text-[11px] transition active:scale-[0.99] ${
              autoSortByActivity
                ? 'bg-primary/15 text-primary'
                : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
            }`}
            aria-pressed={autoSortByActivity}
            aria-label={t('sidebar.sortRecent')}
            title={t('sidebar.sortRecentTitle')}
          >
            <RiSortDescLine size={12} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t('sidebar.sortRecent')}</span>
            <span className={`relative h-4 w-7 shrink-0 rounded-full transition ${autoSortByActivity ? 'bg-primary' : 'bg-muted-foreground/25'}`}>
              <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-[var(--background)] shadow transition ${autoSortByActivity ? 'left-3.5' : 'left-0.5'}`} />
            </span>
          </button>
          <button
            type="button"
            onClick={handleToggleGroupByFolder}
            className={`inline-flex h-8 w-9 shrink-0 items-center justify-center rounded-full transition active:scale-95 ${
              groupByFolder
                ? 'bg-primary/15 text-primary'
                : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
            }`}
            aria-pressed={groupByFolder}
            aria-label={t('sidebar.groupByFolder')}
            title={t('sidebar.groupByFolderTitle')}
          >
            <RiFolderTreeLine size={14} />
          </button>
        </div>
      </div>

      {/* Session list */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 py-1.5">
        {sessions.length === 0 ? (
          <div className="rounded-xl bg-surface-2/60 px-4 py-8 text-center">
            <RiTerminalLine size={26} className="mx-auto mb-2 text-muted-foreground" />
            <p className="text-[12px] text-muted-foreground">{t('sidebar.noSessions')}</p>
          </div>
        ) : visibleSessions.length === 0 ? (
          <div className="rounded-xl bg-surface-2/60 px-4 py-6 text-center">
            <p className="text-[12px] text-muted-foreground">{t('sidebar.noMatchingSessions')}</p>
          </div>
        ) : groupByFolder ? (
          <div className="space-y-1.5">
            {attentionSessions.length > 0 && (
              <div className="rounded-lg bg-[rgb(var(--warning-rgb)_/_0.08)] pb-1 ring-1 ring-[rgb(var(--warning-rgb)_/_0.18)]">
                <div className="flex items-center gap-1.5 px-1.5 py-1 text-[color:var(--warning)]">
                  <RiBellLine size={13} className="shrink-0 animate-pulse" />
                  <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold uppercase tracking-wide">
                    {t('sidebar.needsAttention')}
                  </span>
                  <span className="shrink-0 text-[10.5px] text-[rgb(var(--warning-rgb)_/_0.70)]">{attentionSessions.length}</span>
                </div>
                <div className="space-y-0.5 px-1">
                  {attentionSessions.map((session) => {
                    const isActive = session.id === activeSessionId;
                    return (
                      <div
                        key={`attention:${session.id}`}
                        className={`group relative flex items-center gap-1 rounded-lg pr-1 transition ${
                          isActive
                            ? 'bg-surface-elevated text-foreground'
                            : 'text-muted-foreground hover:bg-surface-2'
                        }`}
                      >
                        {renderSessionRowBody(session)}
                      </div>
                    );
                  })}
                </div>
              </div>            )}
            <DragDropContext onDragEnd={handleGroupedDragEnd}>
            <Droppable droppableId="sidebar-groups" type="group" direction="vertical">
              {(groupsProvided) => (
            <div ref={groupsProvided.innerRef} {...groupsProvided.droppableProps} className="space-y-1.5">
            {folderGroups.map((group, groupIndex) => {
              const collapsed = collapsedGroups.has(group.key);
              let groupRunning = 0;
              let groupReview = 0;
              for (const session of group.sessions) {
                const ts = sessionStates.get(session.id);
                if (ts?.agentStatus === 'running') groupRunning += 1;
                if (ts?.agentStatus === 'waiting' || ts?.agentNeedsReview) groupReview += 1;
              }
              // 「其他」组（无 cwd）永远排最后，禁止整组拖动；搜索过滤时也禁用整组拖动。
              const groupDragDisabled = group.key === '' || isFiltering;
              return (
                <Draggable
                  key={group.key || '__ungrouped__'}
                  draggableId={`sidebar-group:${group.key || '__ungrouped__'}`}
                  index={groupIndex}
                  isDragDisabled={groupDragDisabled}
                  disableInteractiveElementBlocking
                >
                  {(groupDragProvided, groupSnapshot) => (
                <div
                  ref={groupDragProvided.innerRef}
                  {...groupDragProvided.draggableProps}
                  className={`rounded-md transition-colors ${groupSnapshot.isDragging ? 'bg-surface-elevated shadow-lg opacity-90' : ''}`}
                >
                  <button
                    type="button"
                    {...(groupDragDisabled ? {} : groupDragProvided.dragHandleProps)}
                    onClick={() => {
                      // 用户手动 toggle 一律视为「接管」：从 auto-expanded 集合里清除，
                      // 这样翻页走开时不会再自动收回。手动展开同理 — 用户意图优先。
                      toggleGroupCollapsed(group.key);
                      autoExpandedGroupKeysRef.current.delete(group.key);
                    }}
                    className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-muted-foreground transition hover:bg-surface-2 ${
                      groupDragDisabled ? '' : 'cursor-grab active:cursor-grabbing'
                    }`}
                    title={group.key || group.label}
                  >
                    <RiChevronRightLine
                      size={13}
                      className={`shrink-0 transition-transform ${collapsed ? '' : 'rotate-90'}`}
                    />
                    <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold uppercase tracking-wide">
                      {group.label}
                    </span>
                    {groupRunning > 0 && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--success)]" />
                    )}
                    {groupReview > 0 && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--warning)]" />
                    )}
                    <span className="shrink-0 text-[10.5px] text-muted-foreground/70">{group.sessions.length}</span>
                  </button>
                  {!collapsed && (
                    <Droppable droppableId={`group-sessions:${group.key}`} type="session" direction="vertical">
                      {(sessionsProvided) => (
                        <div
                          ref={sessionsProvided.innerRef}
                          {...sessionsProvided.droppableProps}
                          className="mt-0.5 space-y-0.5 pl-2"
                        >
                          {group.sessions.map((session, sessionIndex) => {
                            const isActive = session.id === activeSessionId;
                            return (
                              <Draggable
                                key={session.id}
                                draggableId={`sidebar-grouped:${session.id}`}
                                index={sessionIndex}
                                isDragDisabled={isFiltering}
                                disableInteractiveElementBlocking
                              >
                                {(sessionDragProvided, sessionSnapshot) => (
                                  <div
                                    ref={sessionDragProvided.innerRef}
                                    {...sessionDragProvided.draggableProps}
                                    className={`group relative flex items-center gap-1 rounded-lg pr-1 transition-colors ${
                                      sessionSnapshot.isDragging
                                        ? 'bg-surface-elevated text-foreground shadow-lg opacity-90'
                                        : isActive
                                          ? 'bg-surface-elevated text-foreground'
                                          : 'text-muted-foreground hover:bg-surface-2'
                                    } ${isFiltering ? '' : 'cursor-grab active:cursor-grabbing'}`}
                                  >
                                    {renderSessionRowBody(session, sessionDragProvided.dragHandleProps)}
                                  </div>
                                )}
                              </Draggable>
                            );
                          })}
                          {sessionsProvided.placeholder}
                        </div>
                      )}
                    </Droppable>
                  )}
                </div>
                  )}
                </Draggable>
              );
            })}
            {groupsProvided.placeholder}
            </div>
              )}
            </Droppable>
            </DragDropContext>
          </div>
        ) : (
          <DragDropContext onDragEnd={handleSessionDragEnd}>
            <Droppable droppableId="sidebar-sessions" direction="vertical">
              {(provided) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className="space-y-0.5"
          >
            {visibleSessions.map((session, index) => {
              const isActive = session.id === activeSessionId;
              return (
                <Draggable key={session.id} draggableId={`sidebar:${session.id}`} index={index} isDragDisabled={dragDisabled} disableInteractiveElementBlocking>
                  {(dragProvided, snapshot) => (
                <div
                  ref={dragProvided.innerRef}
                  {...dragProvided.draggableProps}
                  className={`group relative flex items-center gap-1 rounded-lg pr-1 transition-colors ${
                    snapshot.isDragging
                      ? 'bg-surface-elevated text-foreground shadow-lg opacity-90'
                      : isActive
                        ? 'bg-surface-elevated text-foreground'
                        : 'text-muted-foreground hover:bg-surface-2'
                  } ${dragDisabled ? '' : 'cursor-grab active:cursor-grabbing'}`}
                >
                  {renderSessionRowBody(session, dragProvided.dragHandleProps)}
                </div>
                  )}
                </Draggable>
              );
            })}
            {provided.placeholder}
          </div>
              )}
            </Droppable>
          </DragDropContext>
        )}
      </div>

      {/* Footer — split new-session button */}
      <div className="shrink-0 border-t border-border/15 p-2">
        <div className="flex items-stretch gap-1.5">
          <button
            type="button"
            onClick={() => handleNewSessionClick('shell')}
            className={`flex min-w-0 items-center justify-center gap-1.5 rounded-lg text-[13px] font-semibold transition active:scale-[0.98] ${
              shellHighlighted
                ? 'flex-[2.7] bg-primary px-3 py-2.5 text-primary-foreground ring-1 ring-primary/40 shadow-md shadow-primary/25 hover:bg-primary/90'
                : 'flex-[0.78] bg-surface-2 px-2 py-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
            }`}
            title={shellConfirming ? t('sidebar.confirmNewShell') : t('sidebar.newShell')}
            aria-label={shellConfirming ? t('sidebar.confirmNewShell') : t('sidebar.newShell')}
          >
            <RiAddLine size={14} className={shellHighlighted ? 'shrink-0' : 'hidden'} />
            <RiTerminalLine size={12} />
            <span className={shellHighlighted ? 'whitespace-nowrap' : 'hidden'}>
              {shellConfirming ? t('sidebar.confirmNewShell') : t('sidebar.newShell')}
            </span>
          </button>
          <button
            type="button"
            disabled={!tmuxAvailable}
            onClick={() => handleNewSessionClick('tmux')}
            className={`flex min-w-0 items-center justify-center gap-1.5 rounded-lg text-[13px] font-semibold transition active:scale-[0.98] ${
              tmuxAvailable
                ? tmuxHighlighted
                  ? 'flex-[2.7] bg-primary px-3 py-2.5 text-primary-foreground ring-1 ring-primary/40 shadow-md shadow-primary/25 hover:bg-primary/90'
                  : 'flex-[0.78] bg-surface-2 px-2 py-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
                : 'flex-1 bg-surface-2/50 text-muted-foreground/50 cursor-not-allowed'
            }`}
            title={tmuxAvailable ? (tmuxConfirming ? t('sidebar.confirmNewTmux') : t('sidebar.newTmux')) : t('sidebar.newTmuxDisabled')}
            aria-label={tmuxConfirming ? t('sidebar.confirmNewTmux') : t('sidebar.newTmux')}
          >
            <RiAddLine size={14} className={tmuxHighlighted ? 'shrink-0' : 'hidden'} />
            <RiLayoutGridLine size={12} />
            <span className={tmuxHighlighted ? 'whitespace-nowrap' : 'hidden'}>
              {tmuxConfirming ? t('sidebar.confirmNewTmux') : t('sidebar.newTmux')}
            </span>
          </button>
        </div>
      </div>
    </Sidebar>
  );
}
