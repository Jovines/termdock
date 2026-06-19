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
import { getCwdLeafName, getSessionDisplayName } from '../../terminal/display';
import { AgentSessionDot, AgentCountBadge } from '../AgentIndicators';
import { useI18n } from '../../i18n';
import { useTerminalStore } from '../../stores/useTerminalStore';

const AUTO_SORT_ACTIVE_SESSIONS_STORAGE_KEY = 'termdock-sidebar-auto-sort-active-sessions';
const MANUAL_SESSION_ORDER_BEFORE_AUTO_SORT_STORAGE_KEY = 'termdock-sidebar-manual-order-before-auto-sort';
const GROUP_BY_FOLDER_STORAGE_KEY = 'termdock-sidebar-group-by-folder';
const COLLAPSED_FOLDER_GROUPS_STORAGE_KEY = 'termdock-sidebar-collapsed-folder-groups';
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

function readGroupByFolderEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(GROUP_BY_FOLDER_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeGroupByFolderEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (enabled) window.localStorage.setItem(GROUP_BY_FOLDER_STORAGE_KEY, '1');
    else window.localStorage.removeItem(GROUP_BY_FOLDER_STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}

function readCollapsedFolderGroups(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(COLLAPSED_FOLDER_GROUPS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((k) => typeof k === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function writeCollapsedFolderGroups(keys: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(COLLAPSED_FOLDER_GROUPS_STORAGE_KEY, JSON.stringify([...keys]));
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

interface FolderGroup<T> {
  // 完整 cwd 作为稳定 key（折叠状态持久化用）；无 cwd 的会话归到 '' 组。
  key: string;
  label: string;
  sessions: T[];
}

// 按 cwd 把会话归组，组的先后顺序 = 该组首个会话在列表中的出现顺序，
// 这样开/关分组时视觉跳动最小。无 cwd 的会话统一进末尾的「其他」组。
function buildFolderGroups<T extends { id: string }>(
  sessions: T[],
  cwdOf: (session: T) => string | null,
  ungroupedLabel: string,
): FolderGroup<T>[] {
  const groups: FolderGroup<T>[] = [];
  const byKey = new Map<string, FolderGroup<T>>();
  for (const session of sessions) {
    const cwd = cwdOf(session);
    const key = cwd && cwd.trim().length > 0 ? cwd : '';
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: key ? (getCwdLeafName(key) ?? key) : ungroupedLabel, sessions: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.sessions.push(session);
  }
  // 「其他」组永远排最后。
  return groups.sort((a, b) => (a.key === '' ? 1 : 0) - (b.key === '' ? 1 : 0));
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
  const [groupByFolder, setGroupByFolder] = useState(readGroupByFolderEnabled);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(readCollapsedFolderGroups);
  const [outputActivityBySession, setOutputActivityBySession] = useState<Map<string, number>>(readOutputActivitySnapshot);
  const [activityClock, setActivityClock] = useState(() => Date.now());
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
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
  }, [activeSessionId, isOpen, visibleSessions.length]);

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

    const isDefaultMode = mode === defaultSessionMode;
    if (!isDefaultMode && confirmNewMode !== mode) {
      setConfirmNewMode(mode);
      return;
    }

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
  const handleToggleGroupByFolder = useCallback(() => {
    setGroupByFolder((enabled) => {
      const nextEnabled = !enabled;
      writeGroupByFolderEnabled(nextEnabled);
      if (nextEnabled && readAutoSortActiveSessionsEnabled()) {
        setAutoSortByActivity(false);
        const storedOrder = readStoredManualSessionOrder();
        if (storedOrder) onReorderSessions(storedOrder);
        clearStoredManualSessionOrder();
      }
      return nextEnabled;
    });
  }, [onReorderSessions]);

  const handleToggleGroupCollapsed = useCallback((groupKey: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      writeCollapsedFolderGroups(next);
      return next;
    });
  }, []);

  // 会话行主体（切换按钮 + 关闭按钮），flat / 分组两种布局共用。
  // dragHandleProps 仅在可拖拽的 flat 模式传入。
  const renderSessionRowBody = useCallback((
    session: LeftSidebarProps['sessions'][number],
    dragHandleProps?: DraggableProvidedDragHandleProps | null,
  ) => {
    const isActive = session.id === activeSessionId;
    const ts = sessionStates.get(session.id);
    const cwdLeaf = getCwdLeafName(ts?.cwd ?? null);
    const displayName = getSessionDisplayName(session, ts?.activeProgram ?? null, ts?.cwd ?? null);
    const cwdSecondary = cwdLeaf && cwdLeaf !== displayName ? cwdLeaf : null;
    const accentClass = ts?.agentStatus === 'running'
      ? 'bg-green-400'
      : (ts?.agentStatus === 'waiting' || ts?.agentNeedsReview)
        ? 'bg-yellow-400'
        : ts?.inCopyMode
          ? 'bg-yellow-400/70'
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
                ? 'bg-purple-400/15 text-purple-300'
                : 'bg-primary/15 text-primary'
              : session.mode === 'tmux'
                ? 'bg-surface text-purple-300/80'
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
            } ${ts?.inCopyMode ? 'text-yellow-400' : ''}`}>
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
              <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition ${autoSortByActivity ? 'left-3.5' : 'left-0.5'}`} />
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
              <div className="rounded-lg bg-yellow-400/5 pb-1 ring-1 ring-yellow-400/15">
                <div className="flex items-center gap-1.5 px-1.5 py-1 text-yellow-400">
                  <RiBellLine size={13} className="shrink-0 animate-pulse" />
                  <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold uppercase tracking-wide">
                    {t('sidebar.needsAttention')}
                  </span>
                  <span className="shrink-0 text-[10.5px] text-yellow-400/70">{attentionSessions.length}</span>
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
              </div>
            )}
            {folderGroups.map((group) => {
              const collapsed = collapsedGroups.has(group.key);
              let groupRunning = 0;
              let groupReview = 0;
              for (const session of group.sessions) {
                const ts = sessionStates.get(session.id);
                if (ts?.agentStatus === 'running') groupRunning += 1;
                if (ts?.agentStatus === 'waiting' || ts?.agentNeedsReview) groupReview += 1;
              }
              return (
                <div key={group.key || '__ungrouped__'}>
                  <button
                    type="button"
                    onClick={() => handleToggleGroupCollapsed(group.key)}
                    className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-muted-foreground transition hover:bg-surface-2"
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
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-400" />
                    )}
                    {groupReview > 0 && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-yellow-400" />
                    )}
                    <span className="shrink-0 text-[10.5px] text-muted-foreground/70">{group.sessions.length}</span>
                  </button>
                  {!collapsed && (
                    <div className="mt-0.5 space-y-0.5 pl-2">
                      {group.sessions.map((session) => {
                        const isActive = session.id === activeSessionId;
                        return (
                          <div
                            key={session.id}
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
                  )}
                </div>
              );
            })}
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
                  className={`group relative flex items-center gap-1 rounded-lg pr-1 transition ${
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
