import {
  X as RiCloseLine,
  Plus as RiAddLine,
  Settings as RiSettings4Line,
  Terminal as RiTerminalLine,
  LayoutGrid as RiLayoutGridLine,
  Search as RiSearchLine,
  LoaderCircle as RiLoaderCircle,
  FolderTree as RiFolderTreeLine,
  ChevronRight as RiChevronRightLine,
  Bell as RiBellLine,
  Pin as RiPushpinLine,
  PinOff as RiPinOffLine,
  Columns2 as RiSplitLine,
  Rows2 as RiSplitRowsLine,
  ChartBar as RiChartBarLine,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DragDropContext, Droppable, Draggable, type DropResult, type DraggableProvidedDragHandleProps } from '@hello-pangea/dnd';
import { Sidebar } from './Sidebar';
import type { AgentStatus, TuiProgressReport, AgentIdentity, GitStatusReport } from '../../terminal/types';
import { getCwdLeafName, getSessionDisplayName, buildFolderGroups, folderGroupKeyForCwd, reorderGroupedSessionIds, reorderSessionsWithinGroup, DEFAULT_SESSION_DISPLAY_SHELL_NAMES } from '../../terminal/display';
import { getCachedShellTitle, getCachedAgentIdentity } from '../../stores/useTerminalStore';
import { AgentSessionDot, AgentCountBadge, AgentBrandAvatar } from '../AgentIndicators';
import { useI18n } from '../../i18n';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { useSuperLongPress } from '../../hooks/useSuperLongPress';


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
    agent?: AgentIdentity | null;
    agentNeedsReview?: boolean;
    shellTitle?: string | null;
    promptState?: 'idle' | 'running' | null;
    tuiProgress?: TuiProgressReport | null;
    gitStatus?: GitStatusReport | null;
  }>; 
  onNewSession: (opts?: { mode?: 'shell' | 'tmux'; tmuxSessionName?: string }) => void;
  onCloseSession: (sessionId: string, event: React.MouseEvent) => void;
  onSplitSession: (sessionId: string) => void;
  onCloseSplit: () => void;
  splitSessionIds: string[];
  splitDirection: 'horizontal' | 'vertical';
  onSetSplitDirection: (direction: 'horizontal' | 'vertical') => void;
  onReorderSessions: (sessionIds: string[]) => void;
  // 打开某个会话的操作菜单（重命名/复制目录/关闭等）。触屏用「超长按」触发，
  // 桌面端同时挂到右键 contextmenu；不传则两种手势都不生效。
  onSessionMenu?: (sessionId: string, anchor?: { x: number; y: number }) => void;
  onOpenSettings: () => void;
  onOpenQuota?: () => void;
  tmuxAvailable?: boolean;
  defaultSessionMode?: 'shell' | 'tmux';
  push?: boolean;
  pinned?: boolean;
  onTogglePinned?: () => void;
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
    onNewSession, onCloseSession, onSplitSession, onCloseSplit, splitSessionIds,
    splitDirection, onSetSplitDirection,
    onReorderSessions, onSessionMenu, onOpenSettings, onOpenQuota,
    tmuxAvailable = true,
    defaultSessionMode = 'shell',
    push,
    pinned,
    onTogglePinned,
  }: LeftSidebarProps,
) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [confirmNewMode, setConfirmNewMode] = useState<'shell' | 'tmux' | null>(null);
  const groupByFolder = useSidebarStore((s) => s.groupByFolder);
  const collapsedGroups = useSidebarStore((s) => s.collapsedGroups);
  const toggleGroupCollapsed = useSidebarStore((s) => s.toggleGroupCollapsed);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
  // 由「翻页→自动展开」机制维护的分组 key 集合，用于区分：
  //  - 自动展开（翻页进来时我们手动 expand）：翻走后允许自动收起
  //  - 用户手动展开：不参与自动收起，尊重用户意图
  // 用 ref 而非 state：变更不需要触发重渲染，store 自身的 collapsedGroups 才是真相。
  const autoExpandedGroupKeysRef = useRef<Set<string>>(new Set());
  const prevAutoManagedGroupKeyRef = useRef<string | null>(null);
  const trimmedQuery = query.trim();
  const isFiltering = trimmedQuery.length > 0;
  // 分组模式下禁用拖拽（与搜索一致）。
  const dragDisabled = isFiltering || groupByFolder;


  const visibleSessions = useMemo(() => {
    return sessions.filter((session) => matchesSession(trimmedQuery, session, sessionStates.get(session.id)));
  }, [trimmedQuery, sessions, sessionStates]);


  const { runningCount, reviewCount } = useMemo(() => {
    let running = 0;
    let review = 0;
    for (const s of sessions) {
      const ts = sessionStates.get(s.id);
      if (ts?.agentStatus === 'working') running += 1;
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
    if (!push && !pinned) onClose();
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


  const handleToggleGroupByFolder = useCallback(() => {
    useSidebarStore.getState().toggleGroupByFolder();
  }, []);

  // 会话行主体（切换按钮 + 关闭按钮），flat / 分组两种布局共用。
  // dragHandleProps 仅在可拖拽的 flat 模式传入。
  const bindSessionLongPress = useSuperLongPress();
  const renderSessionRowBody = useCallback((
    session: LeftSidebarProps['sessions'][number],
    dragHandleProps?: DraggableProvidedDragHandleProps | null,
    grouped?: boolean,
  ) => {
    const isActive = session.id === activeSessionId;
    const isSplit = splitSessionIds.includes(session.id);
    const ts = sessionStates.get(session.id);
    const cwdLeaf = getCwdLeafName(ts?.cwd ?? null);
    const displayName = getSessionDisplayName(
      session,
      ts?.activeProgram ?? null,
      ts?.cwd ?? null,
      DEFAULT_SESSION_DISPLAY_SHELL_NAMES,
      ts?.shellTitle ?? getCachedShellTitle(session.id),
      ts?.promptState ?? null,
    );
    const cwdSecondary = cwdLeaf && cwdLeaf !== displayName ? cwdLeaf : null;
    // Shell integration (OSC 133) provides real-time running state.
    // Fall back to agentStatus for AI tools that don't emit OSC 133.
    const tuiProgressActive = Boolean(ts?.tuiProgress && ts.tuiProgress.state !== 'remove');
    const isRunning = ts?.promptState === 'running' || ts?.agentStatus === 'working' || tuiProgressActive;
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
          {...(onSessionMenu ? bindSessionLongPress(() => onSessionMenu(session.id)) : {})}
          onContextMenu={(event) => {
            // 桌面右键 = 打开会话操作菜单；触屏超长按由 pointer 手势触发，
            // 与 dnd 的 120ms 拖拽抬起共存（松手无移动不会排序）。
            if (!onSessionMenu) return;
            event.preventDefault();
            onSessionMenu(session.id, { x: event.clientX, y: event.clientY });
          }}
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
            {ts?.isConnecting || (tuiProgressActive && !ts?.agentStatus) ? (
              <RiLoaderCircle size={12} className="animate-spin" />
            ) : (ts?.agent ?? getCachedAgentIdentity(session.id)) ? (
              <AgentBrandAvatar agent={ts?.agent ?? getCachedAgentIdentity(session.id)!} size={16} />
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
            {(cwdSecondary || ts?.gitStatus) && (
              <span className="block truncate text-[10.5px] leading-tight text-muted-foreground/75">
                {cwdSecondary}
                {ts?.gitStatus && (
                  <span className={cwdSecondary ? 'ml-1.5' : ''} title={ts.gitStatus.branch}>
                    ⎇ {ts.gitStatus.branch.length > 14 ? `${ts.gitStatus.branch.slice(0, 14)}…` : ts.gitStatus.branch}
                    {!grouped && (ts.gitStatus.added > 0 || ts.gitStatus.removed > 0) && (
                      <span className="ml-1">
                        <span className="text-[color:var(--success)]">+{ts.gitStatus.added}</span>
                        {' '}
                        <span className="text-[rgb(var(--warning-rgb))]">−{ts.gitStatus.removed}</span>
                      </span>
                    )}
                  </span>
                )}
              </span>
            )}
          </span>
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            if (isSplit) {
              onCloseSplit();
            } else {
              onSplitSession(session.id);
            }
          }}
          className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition hover:bg-primary/15 hover:text-primary active:scale-95 ${
            isSplit ? 'bg-primary/15 text-primary' : 'text-muted-foreground/70'
          }`}
          aria-label={`${isSplit ? t('tab.splitClose') : t('tab.split')} ${displayName}`}
          title={isSplit ? t('tab.splitClose') : t('tab.split')}
        >
          <RiSplitLine size={13} />
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onCloseSession(session.id, event);
          }}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition hover:bg-destructive/15 hover:text-destructive active:scale-95"
          aria-label={t('sidebar.closeSession', { name: displayName })}
          title={t('common.close')}
        >
          <RiCloseLine size={13} />
        </button>
      </>
    );
  }, [activeSessionId, splitSessionIds, sessionStates, onCloseSession, onSplitSession, onCloseSplit, onSessionMenu, bindSessionLongPress, t]);

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

  // 「待处理」是桌面多任务的工作队列，独立于用户选择的会话组织方式。
  // 按 sessions 原始顺序排列。这样无论会话属于哪个组、组是否折叠，都能在
  // 顶部一眼看到并直接点入——动态紧急度独立于稳定的分组组织。
  const attentionSessions = useMemo(() => {
    return visibleSessions.filter((session) => {
      const ts = sessionStates.get(session.id);
      return ts?.agentStatus === 'waiting' || ts?.agentNeedsReview;
    });
  }, [visibleSessions, sessionStates]);
  const waitingAttentionSessions = useMemo(
    () => attentionSessions.filter((session) => sessionStates.get(session.id)?.agentStatus === 'waiting'),
    [attentionSessions, sessionStates],
  );
  const completedAttentionSessions = useMemo(
    () => attentionSessions.filter((session) => sessionStates.get(session.id)?.agentStatus !== 'waiting'),
    [attentionSessions, sessionStates],
  );
  const attentionPanel = attentionSessions.length > 0 ? (
    <div className="mb-1.5 rounded-lg bg-[rgb(var(--warning-rgb)_/_0.08)] pb-1 ring-1 ring-[rgb(var(--warning-rgb)_/_0.18)]">
      <div className="flex items-center gap-1.5 px-1.5 py-1 text-[color:var(--warning)]">
        <RiBellLine size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold uppercase tracking-wide">
          {t('sidebar.needsAttention')}
        </span>
        <span className="shrink-0 text-[10.5px] text-[rgb(var(--warning-rgb)_/_0.70)]">{attentionSessions.length}</span>
      </div>
      {[
        [t('sidebar.waitingForYou'), waitingAttentionSessions],
        [t('sidebar.completedUnread'), completedAttentionSessions],
      ].map(([label, lane]) => {
        const laneSessions = lane as typeof attentionSessions;
        if (laneSessions.length === 0) return null;
        return (
          <div key={label as string} className="px-1 pb-0.5">
            <div className="px-1.5 pb-0.5 pt-1 text-[9.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {label as string} · {laneSessions.length}
            </div>
            {laneSessions.map((session) => (
              <div
                key={`attention:${session.id}`}
                className={`group relative flex items-center gap-1 rounded-lg pr-1 transition ${
                  session.id === activeSessionId
                    ? 'bg-surface-elevated text-foreground'
                    : 'text-muted-foreground hover:bg-surface-2'
                }`}
              >
                {renderSessionRowBody(session, undefined, true)}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  ) : null;

  const inner = (
    <>
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
          {onOpenQuota && (
            <button
              type="button"
              onClick={onOpenQuota}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
              aria-label="Subscription Quota"
              title="Subscription Quota"
            >
              <RiChartBarLine size={14} />
            </button>
          )}
          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
            aria-label={t('sidebar.settings')}
            title={t('sidebar.settings')}
          >
            <RiSettings4Line size={14} />
          </button>
          {onTogglePinned && (
            <button
              type="button"
              onClick={onTogglePinned}
              className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition active:scale-95 ${
                pinned
                  ? 'bg-primary/15 text-primary hover:bg-primary/20'
                  : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
              }`}
              aria-label={pinned ? 'Unpin sidebar' : 'Pin sidebar'}
              title={pinned ? t('common.close') : 'Pin sidebar'}
            >
              {pinned ? <RiPinOffLine size={14} /> : <RiPushpinLine size={14} />}
            </button>
          )}
          {(!push || pinned) && (
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
        {!groupByFolder && attentionPanel}
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
            {attentionPanel}
            <DragDropContext onDragEnd={handleGroupedDragEnd}>
            <Droppable droppableId="sidebar-groups" type="group" direction="vertical">
              {(groupsProvided) => (
            <div ref={groupsProvided.innerRef} {...groupsProvided.droppableProps} className="space-y-1.5">
            {folderGroups.map((group, groupIndex) => {
              const collapsed = collapsedGroups.has(group.key);
              let groupRunning = 0;
              let groupReview = 0;
              let groupAdded = 0;
              let groupRemoved = 0;
              for (const session of group.sessions) {
                const ts = sessionStates.get(session.id);
                if (ts?.agentStatus === 'working') groupRunning += 1;
                if (ts?.agentStatus === 'waiting' || ts?.agentNeedsReview) groupReview += 1;
                if (ts?.gitStatus) {
                  groupAdded += ts.gitStatus.added;
                  groupRemoved += ts.gitStatus.removed;
                }
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
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--success)] animate-pulse" />
                    )}
                    {groupReview > 0 && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--warning)] animate-pulse" />
                    )}
                    <span className="shrink-0 text-[10.5px] text-muted-foreground/70">{group.sessions.length}</span>
                    {(groupAdded > 0 || groupRemoved > 0) && (
                      <span className="shrink-0 text-[9px] text-muted-foreground/70">
                        <span className="text-[color:var(--success)]">+{groupAdded}</span>
                        {' '}
                        <span className="text-[rgb(var(--warning-rgb))]">−{groupRemoved}</span>
                      </span>
                    )}
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
                            const ts = sessionStates.get(session.id);
                            const agentRowBg = ts?.agentStatus === 'working'
                              ? 'bg-[rgb(var(--success-rgb)_/_0.08)] text-foreground'
                              : (ts?.agentStatus === 'waiting' || ts?.agentNeedsReview)
                                ? 'bg-[rgb(var(--warning-rgb)_/_0.10)] text-foreground'
                                : ts?.inCopyMode
                                  ? 'bg-[rgb(var(--warning-rgb)_/_0.05)] text-foreground'
                                  : null;
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
                                      agentRowBg ?? (
                                        sessionSnapshot.isDragging
                                          ? 'bg-surface-elevated text-foreground shadow-lg opacity-90'
                                          : isActive
                                            ? 'bg-surface-elevated text-foreground'
                                            : 'text-muted-foreground hover:bg-surface-2'
                                      )
                                    } ${isFiltering ? '' : 'cursor-grab active:cursor-grabbing'}`}
                                  >
                                    {renderSessionRowBody(session, sessionDragProvided.dragHandleProps, true)}
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
              const ts = sessionStates.get(session.id);
              const agentRowBg = ts?.agentStatus === 'working'
                ? 'bg-[rgb(var(--success-rgb)_/_0.08)] text-foreground'
                : (ts?.agentStatus === 'waiting' || ts?.agentNeedsReview)
                  ? 'bg-[rgb(var(--warning-rgb)_/_0.10)] text-foreground'
                  : ts?.inCopyMode
                    ? 'bg-[rgb(var(--warning-rgb)_/_0.05)] text-foreground'
                    : null;
              return (
                <Draggable key={session.id} draggableId={`sidebar:${session.id}`} index={index} isDragDisabled={dragDisabled} disableInteractiveElementBlocking>
                  {(dragProvided, snapshot) => (
                <div
                  ref={dragProvided.innerRef}
                  {...dragProvided.draggableProps}
                  className={`group relative flex items-center gap-1 rounded-lg pr-1 transition-colors ${
                    agentRowBg ?? (
                      snapshot.isDragging
                        ? 'bg-surface-elevated text-foreground shadow-lg opacity-90'
                        : isActive
                          ? 'bg-surface-elevated text-foreground'
                          : 'text-muted-foreground hover:bg-surface-2'
                    )
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

      {splitSessionIds.length === 2 && (
        <div className="hidden shrink-0 items-center gap-1.5 border-t border-border/15 px-2 py-1.5 md:flex">
          <span className="min-w-0 flex-1 truncate px-1 text-[11px] font-medium text-muted-foreground">
            {t('tab.splitLayout')}
          </span>
          <button
            type="button"
            onClick={() => onSetSplitDirection('horizontal')}
            className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] transition-colors ${
              splitDirection === 'horizontal'
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
            }`}
            title={`${t('tab.splitHorizontal')} · Ctrl/⌘+Shift+←/→`}
            aria-label={t('tab.splitHorizontal')}
          >
            <RiSplitLine size={13} />
            {t('tab.splitHorizontal')}
          </button>
          <button
            type="button"
            onClick={() => onSetSplitDirection('vertical')}
            className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] transition-colors ${
              splitDirection === 'vertical'
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
            }`}
            title={`${t('tab.splitVertical')} · Ctrl/⌘+Shift+↑/↓`}
            aria-label={t('tab.splitVertical')}
          >
            <RiSplitRowsLine size={13} />
            {t('tab.splitVertical')}
          </button>
        </div>
      )}

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
    </>
  );

  return pinned ? (
    <div className="h-full flex flex-col app-chrome-bg border-r border-border/15">
      {inner}
    </div>
  ) : (
    <Sidebar
      side="left"
      isOpen={isOpen}
      drawerWidthPx={drawerWidthPx}
      onClose={onClose}
      onOpen={onOpen}
      push={push}
    >
      {inner}
    </Sidebar>
  );
}
