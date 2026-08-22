import {
  X as RiCloseLine,
  Plus as RiAddLine,
  Settings as RiSettings4Line,
  Terminal as RiTerminalLine,
  LayoutGrid as RiLayoutGridLine,
  LoaderCircle as RiLoaderCircle,
  ChevronRight as RiChevronRightLine,
  Bell as RiBellLine,
  Pin as RiPushpinLine,
  PinOff as RiPinOffLine,
  Columns2 as RiSplitLine,
  Rows2 as RiSplitRowsLine,
  ChartBar as RiChartBarLine,
  Pencil as RiPencilLine,
  GripVertical as RiDragHandleLine,
  MoreHorizontal as RiMoreHorizontal,
  RefreshCw as RiRefreshLine,
  ChevronDown as RiChevronDownLine,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DragDropContext, Droppable, Draggable, type DropResult, type DraggableProvidedDragHandleProps } from '@hello-pangea/dnd';
import { Sidebar } from './Sidebar';
import type { AgentStatus, TuiProgressReport, AgentIdentity, GitStatusReport } from '../../terminal/types';
import { getCwdLeafName, getSessionDisplayName, buildFolderGroups, folderGroupKeyForCwd, reorderGroupedSessionIds, DEFAULT_SESSION_DISPLAY_SHELL_NAMES } from '../../terminal/display';
import { getCachedShellTitle, getCachedAgentIdentity } from '../../stores/useTerminalStore';
import { AgentSessionDot, AgentCountBadge, AgentBrandAvatar } from '../AgentIndicators';
import { useI18n } from '../../i18n';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { useSuperLongPress } from '../../hooks/useSuperLongPress';
import type { SplitLayout, SplitWorkspaceSummary } from '../../terminal/splitWorkspaces';
import type { TermdockUpdateState } from '../../terminal/api';
import { NewSessionComposer, readNewSessionAgentPreference } from './NewSessionComposer';


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
    agentStatusDetail?: import('../../terminal/types').AgentStatusDetail | null;
    agent?: AgentIdentity | null;
    agentNeedsReview?: boolean;
    shellTitle?: string | null;
    promptState?: 'idle' | 'running' | null;
    tuiProgress?: TuiProgressReport | null;
    gitStatus?: GitStatusReport | null;
  }>; 
  onNewSession: (opts?: { mode?: 'shell' | 'tmux'; tmuxSessionName?: string; cwd?: string; command?: string }) => void;
  onCloseSession: (sessionId: string, event: React.MouseEvent) => void;
  onSplitSession: (sessionId: string) => void;
  onCloseSplit: (sessionId: string) => void;
  onRemoveFromSplit: (sessionId: string) => void;
  splitWorkspaces: SplitWorkspaceSummary[];
  onSetSplitLayout: (sessionId: string, layout: SplitLayout) => void;
  onReorderSplitWorkspace: (workspaceId: string, sessionIds: string[]) => void;
  onRenameSplitWorkspace: (workspaceId: string, name: string) => void;
  onCombineSplitSessions: (primaryId: string, secondaryId: string) => void;
  onReorderSessions: (sessionIds: string[]) => void;
  // 打开某个会话的操作菜单（重命名/复制目录/关闭等）。触屏用「超长按」触发，
  // 桌面端同时挂到右键 contextmenu；不传则两种手势都不生效。
  onSessionMenu?: (sessionId: string, anchor?: { x: number; y: number }) => void;
  onOpenSettings: () => void;
  onOpenQuota?: () => void;
  updateState?: TermdockUpdateState | null;
  updateActionPending?: boolean;
  onConfirmUpdateRestart?: () => void;
  onRetryUpdate?: () => void;
  tmuxAvailable?: boolean;
  defaultSessionMode?: 'shell' | 'tmux';
  push?: boolean;
  pinned?: boolean;
  onTogglePinned?: () => void;
}

type SidebarSession = LeftSidebarProps['sessions'][number];

type SidebarEntity =
  | { kind: 'session'; id: string; session: SidebarSession; sessionIds: [string] }
  | { kind: 'workspace'; id: string; workspace: SplitWorkspaceSummary; members: SidebarSession[]; sessionIds: string[] };

function buildSidebarEntities(
  orderedSessions: SidebarSession[],
  workspaces: SplitWorkspaceSummary[],
  sessionsById: Map<string, SidebarSession>,
): SidebarEntity[] {
  const workspaceBySessionId = new Map<string, SplitWorkspaceSummary>();
  const allowedIds = new Set(orderedSessions.map((session) => session.id));
  for (const workspace of workspaces) {
    if (workspace.sessionIds.length < 2 || !workspace.sessionIds.every((id) => allowedIds.has(id))) continue;
    for (const id of workspace.sessionIds) workspaceBySessionId.set(id, workspace);
  }

  const emittedWorkspaceIds = new Set<string>();
  const entities: SidebarEntity[] = [];
  for (const session of orderedSessions) {
    const workspace = workspaceBySessionId.get(session.id);
    if (!workspace) {
      entities.push({ kind: 'session', id: `session:${session.id}`, session, sessionIds: [session.id] });
      continue;
    }
    if (emittedWorkspaceIds.has(workspace.id)) continue;
    emittedWorkspaceIds.add(workspace.id);
    const members = workspace.sessionIds.flatMap((id) => {
      const member = sessionsById.get(id);
      return member ? [member] : [];
    });
    entities.push({
      kind: 'workspace',
      id: `workspace:${workspace.id}`,
      workspace,
      members,
      sessionIds: workspace.sessionIds,
    });
  }
  return entities;
}

function StatusDot({
  status,
  detail,
  needsReview,
  inCopyMode,
}: { status: AgentStatus | null; detail?: import('../../terminal/types').AgentStatusDetail | null; needsReview?: boolean; inCopyMode?: boolean }) {
  return <AgentSessionDot status={status} detail={detail} needsReview={needsReview} inCopyMode={inCopyMode} />;
}

export function LeftSidebar(
  {
    isOpen, drawerWidthPx, onClose, onOpen,
    sessions, activeSessionId, sessionStates,
    onNewSession, onCloseSession, onSplitSession, onCloseSplit, onRemoveFromSplit, splitWorkspaces,
    onSetSplitLayout, onReorderSplitWorkspace, onRenameSplitWorkspace, onCombineSplitSessions,
    onReorderSessions, onSessionMenu, onOpenSettings, onOpenQuota,
    updateState, updateActionPending = false, onConfirmUpdateRestart, onRetryUpdate,
    tmuxAvailable = true,
    defaultSessionMode = 'shell',
    push,
    pinned,
    onTogglePinned,
  }: LeftSidebarProps,
) {
  const { t } = useI18n();
  const [editingSplitWorkspaceId, setEditingSplitWorkspaceId] = useState<string | null>(null);
  const [expandedSplitWorkspaceIds, setExpandedSplitWorkspaceIds] = useState<Set<string>>(new Set());
  const [draggedSplitMember, setDraggedSplitMember] = useState<{ workspaceId: string; sessionId: string } | null>(null);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [newSessionComposerOpen, setNewSessionComposerOpen] = useState(false);
  const [newSessionOptions, setNewSessionOptions] = useState<{
    mode: 'shell' | 'tmux';
    cwd?: string;
    command?: string;
  }>({ mode: defaultSessionMode, command: readNewSessionAgentPreference().command });
  const headerMenuRef = useRef<HTMLDivElement | null>(null);
  const pendingUpdate = Boolean(
    updateState?.latestVersion
    && ['installing', 'ready', 'restarting', 'error'].includes(updateState.status),
  );
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
  const splitSessionIds = useMemo(
    () => new Set(splitWorkspaces.flatMap((workspace) => workspace.sessionIds)),
    [splitWorkspaces],
  );
  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  // Flat 模式中分屏 workspace 占一个顶层 item；目录模式由各目录自己决定是否合并。
  const visibleSessions = useMemo(
    () => sessions.filter((session) => !splitSessionIds.has(session.id)),
    [sessions, splitSessionIds],
  );


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
      setHeaderMenuOpen(false);
      setNewSessionComposerOpen(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!headerMenuOpen) return;
    const closeMenu = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event instanceof MouseEvent && event.target instanceof Node && headerMenuRef.current?.contains(event.target)) return;
      setHeaderMenuOpen(false);
    };
    window.addEventListener('mousedown', closeMenu);
    window.addEventListener('keydown', closeMenu);
    return () => {
      window.removeEventListener('mousedown', closeMenu);
      window.removeEventListener('keydown', closeMenu);
    };
  }, [headerMenuOpen]);

  const closeIfOverlay = () => {
    if (!push && !pinned) onClose();
  };
  const handleNewSessionClick = () => {
    const options = newSessionComposerOpen
      ? { ...newSessionOptions, cwd: newSessionOptions.cwd?.trim() || undefined }
      : {
        mode: defaultSessionMode === 'tmux' && !tmuxAvailable ? 'shell' as const : defaultSessionMode,
        command: readNewSessionAgentPreference().command,
      };
    onNewSession(options);
    setNewSessionComposerOpen(false);
    closeIfOverlay();
  };

  const toggleNewSessionComposer = () => {
    if (newSessionComposerOpen) {
      setNewSessionComposerOpen(false);
      return;
    }
    setNewSessionOptions({
      mode: defaultSessionMode === 'tmux' && !tmuxAvailable ? 'shell' : defaultSessionMode,
      cwd: activeSessionId ? sessionStates.get(activeSessionId)?.cwd ?? undefined : undefined,
      command: readNewSessionAgentPreference().command,
    });
    setNewSessionComposerOpen(true);
  };

  const getSessionStatusBackground = useCallback((sessionId: string): string | null => {
    const state = sessionStates.get(sessionId);
    if (state?.agentStatus === 'waiting' || state?.agentNeedsReview) {
      return 'bg-[rgb(var(--warning-rgb)_/_0.10)] text-foreground';
    }
    if (state?.agentStatus === 'working') {
      return 'bg-[rgb(var(--success-rgb)_/_0.08)] text-foreground';
    }
    if (state?.inCopyMode) {
      return 'bg-[rgb(var(--tmux-rgb)_/_0.08)] text-foreground';
    }
    return null;
  }, [sessionStates]);

  // 会话行主体（切换按钮 + 关闭按钮），flat / 分组两种布局共用。
  // dragHandleProps 仅在可拖拽的 flat 模式传入。
  // 触屏「超长按」不挂在按钮上（按钮在可拖拽行上是 dnd 拖拽手柄）：
  // 与顶栏 tab 一致，挂在行外层 wrapper 上，与 dnd 的 120ms 拖拽抬起共存。
  const bindSessionLongPress = useSuperLongPress();
  const renderSessionRowBody = useCallback((
    session: LeftSidebarProps['sessions'][number],
    dragHandleProps?: DraggableProvidedDragHandleProps | null,
    grouped?: boolean,
    inSplitWorkspace?: boolean,
  ) => {
    const isActive = session.id === activeSessionId;
    const isSplit = splitSessionIds.has(session.id);
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
          ? 'bg-[var(--tmux)]'
          : 'bg-primary';
    return (
      <>
        <button
          ref={isActive ? activeItemRef : null}
          type="button"
          {...(dragHandleProps ?? {})}
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
              detail={ts?.agentStatusDetail}
              needsReview={ts?.agentNeedsReview}
              inCopyMode={ts?.inCopyMode}
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className={`block truncate text-[13px] leading-tight ${
              isActive ? 'font-medium text-foreground' : ''
            } ${ts?.inCopyMode ? 'text-[color:var(--tmux)]' : ''}`}>
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
            if (inSplitWorkspace) {
              onRemoveFromSplit(session.id);
            } else if (isSplit) {
              onCloseSplit(session.id);
            } else {
              onSplitSession(session.id);
            }
          }}
          className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition hover:bg-primary/15 hover:text-primary active:scale-95 ${
            isSplit ? 'bg-primary/15 text-primary' : 'text-muted-foreground/70'
          }`}
          aria-label={`${inSplitWorkspace ? t('tab.splitRemovePane') : isSplit ? t('tab.splitClose') : t('tab.split')} ${displayName}`}
          title={inSplitWorkspace ? t('tab.splitRemovePane') : isSplit ? t('tab.splitClose') : t('tab.split')}
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
  }, [activeSessionId, splitSessionIds, sessionStates, onCloseSession, onSplitSession, onCloseSplit, onRemoveFromSplit, onSessionMenu, t]);

  // 分屏工作区跟随主会话（第一块 pane）的目录展示。跨目录成员仍留在同一个
  // 工作区条目内，不再被提升成脱离目录结构的独立一级区域。
  const folderGroups = useMemo(() => {
    if (!groupByFolder) return [];
    const baseGroups = buildFolderGroups(
      sessions,
      (session) => sessionStates.get(session.id)?.cwd ?? null,
      t('sidebar.ungrouped'),
    );
    const anchoredWorkspaceIdsByFolder = new Map<string, Set<string>>();
    for (const workspace of splitWorkspaces) {
      const anchorId = workspace.sessionIds[0];
      if (!anchorId) continue;
      const folderKey = folderGroupKeyForCwd(sessionStates.get(anchorId)?.cwd ?? null);
      const workspaceIds = anchoredWorkspaceIdsByFolder.get(folderKey) ?? new Set<string>();
      workspace.sessionIds.forEach((id) => workspaceIds.add(id));
      anchoredWorkspaceIdsByFolder.set(folderKey, workspaceIds);
    }
    return baseGroups.flatMap((group) => {
      const allowedIds = new Set(
        group.sessions.filter((session) => !splitSessionIds.has(session.id)).map((session) => session.id),
      );
      anchoredWorkspaceIdsByFolder.get(group.key)?.forEach((id) => allowedIds.add(id));
      const groupedSessions = sessions.filter((session) => allowedIds.has(session.id));
      return groupedSessions.length > 0 ? [{ ...group, sessions: groupedSessions }] : [];
    });
  }, [groupByFolder, sessions, sessionStates, splitSessionIds, splitWorkspaces, t]);

  const flatSidebarEntities = useMemo(
    () => buildSidebarEntities(sessions, splitWorkspaces, sessionsById),
    [sessions, sessionsById, splitWorkspaces],
  );

  const handleEntityDragEnd = useCallback((
    result: DropResult,
    entities: SidebarEntity[],
    folderKey?: string,
  ) => {
    const source = entities.find((entity) => entity.id === result.draggableId);
    if (!source) return;
    if (result.combine) {
      const target = entities.find((entity) => entity.id === result.combine?.draggableId);
      if (!target) return;
      const primary = target.kind === 'workspace' ? target : source.kind === 'workspace' ? source : target;
      const secondary = primary === source ? target : source;
      const primarySessionId = primary.sessionIds[0];
      const secondarySessionId = secondary.sessionIds[0];
      if (primarySessionId && secondarySessionId && primarySessionId !== secondarySessionId) {
        onCombineSplitSessions(primarySessionId, secondarySessionId);
      }
      return;
    }
    if (!result.destination || result.source.index === result.destination.index) return;
    const reordered = [...entities];
    const [moved] = reordered.splice(result.source.index, 1);
    if (!moved) return;
    reordered.splice(result.destination.index, 0, moved);
    const reorderedIds = reordered.flatMap((entity) => entity.sessionIds);
    if (folderKey === undefined) {
      onReorderSessions(reorderedIds);
      return;
    }
    onReorderSessions(folderGroups.flatMap((group) => (
      group.key === folderKey ? reorderedIds : group.sessions.map((session) => session.id)
    )));
  }, [folderGroups, onCombineSplitSessions, onReorderSessions]);

  // 目录模式下的拖拽：单个 DragDropContext，按 result.type 区分两种拖动。
  //  - type 'group'：整组顺序拖动（组与组之间排序），组内顺序不变。
  //  - type 'session'：组内排序；禁止跨组拖动（分组依据是 cwd，跨组无意义）。
  // 组是 Draggable、组内会话列表是嵌套 Droppable，pangea 官方支持的嵌套列表
  // 模式：父组可整组拖动，子列表内的 item 仍可各自排序。
  const handleGroupedDragEnd = useCallback((result: DropResult) => {
    if (result.type === 'group') {
      if (!result.destination || result.source.index === result.destination.index) return;
      onReorderSessions(reorderGroupedSessionIds(folderGroups, result.source.index, result.destination.index));
      return;
    }
    const groupKey = result.source.droppableId.replace(/^group-sessions:/, '');
    const group = folderGroups.find((candidate) => candidate.key === groupKey);
    if (!group) return;
    const entities = buildSidebarEntities(group.sessions, splitWorkspaces, sessionsById);
    if (result.combine) {
      handleEntityDragEnd(result, entities, groupKey);
      return;
    }
    if (!result.destination || result.destination.droppableId !== result.source.droppableId) return;
    handleEntityDragEnd(result, entities, groupKey);
  }, [folderGroups, sessionsById, splitWorkspaces, handleEntityDragEnd, onReorderSessions]);

  const renderSplitWorkspaceItem = (
    workspace: SplitWorkspaceSummary,
    members: LeftSidebarProps['sessions'],
    dragHandleProps?: DraggableProvidedDragHandleProps | null,
    isDragging = false,
    isCombineTarget = false,
  ): React.ReactNode => {
    if (members.length < 2) return null;
    const hasActive = members.some((session) => session.id === activeSessionId);
    const expanded = expandedSplitWorkspaceIds.has(workspace.id);
    const reviewMembers: SidebarSession[] = [];
    const workingMembers: SidebarSession[] = [];
    const copyModeMembers: SidebarSession[] = [];
    for (const member of members) {
      const state = sessionStates.get(member.id);
      if (state?.agentStatus === 'waiting' || state?.agentNeedsReview) {
        reviewMembers.push(member);
      } else if (state?.agentStatus === 'working') {
        workingMembers.push(member);
      } else if (state?.inCopyMode) {
        copyModeMembers.push(member);
      }
    }
    const focusMember = (sessionId: string) => {
      window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: sessionId }));
      closeIfOverlay();
    };
    const defaultName = `${t('tab.splitWorkspace')} ${splitWorkspaces.findIndex((candidate) => candidate.id === workspace.id) + 1}`;
    const displayName = workspace.name || defaultName;
    const layoutActions: Array<{ layout: SplitLayout; icon: React.ReactNode; label: string }> = [
      { layout: 'horizontal', icon: <RiSplitLine size={12} />, label: t('tab.splitHorizontal') },
      { layout: 'vertical', icon: <RiSplitRowsLine size={12} />, label: t('tab.splitVertical') },
      { layout: 'grid', icon: <RiLayoutGridLine size={12} />, label: t('tab.splitGrid') },
    ];
    const commitName = (value: string) => {
      onRenameSplitWorkspace(workspace.id, value);
      setEditingSplitWorkspaceId(null);
    };
    const toggleExpanded = () => {
      setExpandedSplitWorkspaceIds((current) => {
        const next = new Set(current);
        if (next.has(workspace.id)) next.delete(workspace.id);
        else next.add(workspace.id);
        return next;
      });
    };
    const reorderMemberAt = (targetSessionId: string, afterTarget: boolean) => {
      if (!draggedSplitMember || draggedSplitMember.workspaceId !== workspace.id) return;
      if (draggedSplitMember.sessionId === targetSessionId) return;
      const sessionIds = workspace.sessionIds.filter((id) => id !== draggedSplitMember.sessionId);
      const targetIndex = sessionIds.indexOf(targetSessionId);
      if (targetIndex < 0) return;
      sessionIds.splice(targetIndex + (afterTarget ? 1 : 0), 0, draggedSplitMember.sessionId);
      onReorderSplitWorkspace(workspace.id, sessionIds);
      setDraggedSplitMember(null);
    };
    return (
      <section
        className={`group/split overflow-hidden rounded-md transition-colors ${
          isCombineTarget
            ? 'bg-primary/15 ring-1 ring-primary/40'
            : isDragging
              ? 'bg-surface-elevated opacity-90 shadow-lg'
              : reviewMembers.length > 0
                ? 'bg-[rgb(var(--warning-rgb)_/_0.08)] hover:bg-[rgb(var(--warning-rgb)_/_0.12)]'
                : workingMembers.length > 0
                  ? 'bg-[rgb(var(--success-rgb)_/_0.06)] hover:bg-[rgb(var(--success-rgb)_/_0.10)]'
                  : copyModeMembers.length > 0
                    ? 'bg-[rgb(var(--tmux-rgb)_/_0.07)] hover:bg-[rgb(var(--tmux-rgb)_/_0.11)]'
                    : hasActive
                      ? 'bg-primary/[0.07]'
                      : 'hover:bg-surface-2'
        }`}
      >
        <header className="flex h-10 items-center gap-0.5 px-0.5">
          <button
            type="button"
            onClick={toggleExpanded}
            className="inline-flex h-8 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground"
            aria-expanded={expanded}
            aria-label={displayName}
          >
            <RiChevronRightLine size={13} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
          </button>
          <span className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
            reviewMembers.length > 0
              ? 'text-[color:var(--warning)]'
              : workingMembers.length > 0
                ? 'text-[color:var(--success)]'
                : hasActive ? 'text-primary' : 'text-muted-foreground'
          }`}>
            {workspace.layout === 'vertical' ? <RiSplitRowsLine size={13} />
              : workspace.layout === 'grid' ? <RiLayoutGridLine size={13} />
                : <RiSplitLine size={13} />}
          </span>
          {editingSplitWorkspaceId === workspace.id ? (
            <input
              autoFocus
              defaultValue={workspace.name ?? ''}
              placeholder={defaultName}
              className="h-7 min-w-0 flex-1 rounded-md bg-surface-elevated px-1.5 text-[11.5px] font-semibold text-foreground outline-none ring-1 ring-primary/40"
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitName(event.currentTarget.value);
                if (event.key === 'Escape') setEditingSplitWorkspaceId(null);
              }}
              onBlur={(event) => commitName(event.currentTarget.value)}
            />
          ) : (
            <button
              type="button"
              {...(dragHandleProps ?? {})}
              onClick={() => {
                const target = members.find((session) => session.id === activeSessionId) ?? reviewMembers[0] ?? members[0];
                if (target) focusMember(target.id);
              }}
              className={`min-w-0 flex-1 px-1 text-left ${dragHandleProps ? 'cursor-grab active:cursor-grabbing' : ''}`}
              title={`${displayName} · ${t('tab.sessionCount', { count: members.length })}`}
            >
              <span className="block truncate text-[11.5px] font-semibold text-foreground">{displayName}</span>
              <span className="block truncate text-[9.5px] text-muted-foreground/70">
                {members.map((session) => getSessionDisplayName(
                  session,
                  sessionStates.get(session.id)?.activeProgram ?? null,
                  sessionStates.get(session.id)?.cwd ?? null,
                  DEFAULT_SESSION_DISPLAY_SHELL_NAMES,
                  sessionStates.get(session.id)?.shellTitle ?? getCachedShellTitle(session.id),
                )).join(' · ')}
              </span>
            </button>
          )}
          {reviewMembers.length > 0 && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                focusMember(reviewMembers[0]!.id);
              }}
              className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded-full bg-[rgb(var(--warning-rgb)_/_0.14)] px-1.5 text-[9px] font-semibold tabular-nums text-[color:var(--warning)] ring-1 ring-[rgb(var(--warning-rgb)_/_0.22)] transition hover:bg-[rgb(var(--warning-rgb)_/_0.22)]"
              title={t('agent.needsReview')}
              aria-label={`${t('agent.needsReview')}: ${reviewMembers.length}`}
            >
              <RiBellLine size={9} />
              {reviewMembers.length}
            </button>
          )}
          {workingMembers.length > 0 && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                focusMember(workingMembers[0]!.id);
              }}
              className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-[rgb(var(--success-rgb)_/_0.10)] px-1.5 text-[9px] font-medium tabular-nums text-[color:var(--success)] transition hover:bg-[rgb(var(--success-rgb)_/_0.16)]"
              title={t('agent.aiRunning')}
              aria-label={`${t('agent.aiRunning')}: ${workingMembers.length}`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--success)] animate-pulse" />
              {workingMembers.length}
            </button>
          )}
          {copyModeMembers.length > 0 && reviewMembers.length === 0 && workingMembers.length === 0 && (
            <span
              className="h-2 w-2 shrink-0 rounded-[2px] bg-[var(--tmux)]"
              title={t('agent.copyMode')}
            />
          )}
          <span className="shrink-0 px-1 text-[10px] tabular-nums text-muted-foreground/60">{members.length}</span>
          <button
            type="button"
            onClick={() => setEditingSplitWorkspaceId(workspace.id)}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 transition hover:bg-surface-elevated hover:text-foreground group-hover/split:opacity-100 focus:opacity-100"
            aria-label={t('tab.splitRename')}
            title={t('tab.splitRename')}
          >
            <RiPencilLine size={11} />
          </button>
        </header>
        {expanded && (
          <div className="border-t border-border/10 pb-0.5">
          <div className="flex items-center gap-0.5 px-1 py-0.5">
            {layoutActions.map((action) => (
              <button
                key={action.layout}
                type="button"
                onClick={() => onSetSplitLayout(members[0]!.id, action.layout)}
                className={`inline-flex h-6 w-7 items-center justify-center rounded-md transition ${
                  workspace.layout === action.layout
                    ? 'bg-primary/15 font-medium text-primary'
                    : 'text-muted-foreground/70 hover:bg-surface-elevated hover:text-foreground'
                }`}
                aria-label={action.label}
                title={action.label}
              >
                {action.icon}
              </button>
            ))}
            <span className="min-w-0 flex-1" />
            <button
              type="button"
              onClick={() => onSplitSession((members.find((session) => session.id === activeSessionId) ?? members[0])!.id)}
              className="inline-flex h-6 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-primary/15 hover:text-primary"
              aria-label={t('tab.split')}
              title={t('tab.split')}
            >
              <RiAddLine size={12} />
            </button>
            <button
              type="button"
              onClick={() => onCloseSplit(members[0]!.id)}
              className="inline-flex h-6 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-destructive/15 hover:text-destructive"
              aria-label={t('tab.splitClose')}
              title={t('tab.splitClose')}
            >
              <RiCloseLine size={12} />
            </button>
          </div>
          <div className="px-0.5">
            {members.map((session) => (
              <div
                key={session.id}
                onDragOver={(event) => {
                  if (draggedSplitMember?.workspaceId === workspace.id) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  reorderMemberAt(session.id, event.clientY > bounds.top + bounds.height / 2);
                }}
                {...(onSessionMenu ? bindSessionLongPress(() => onSessionMenu(session.id)) : {})}
                className={`flex items-center rounded-md pr-1 transition-colors ${
                  getSessionStatusBackground(session.id)
                    ?? (session.id === activeSessionId
                      ? 'bg-surface-elevated/80 text-foreground'
                      : 'text-muted-foreground hover:bg-surface-2')
                }`}
              >
                <span
                  draggable
                  onDragStart={(event) => {
                    event.stopPropagation();
                    event.dataTransfer.effectAllowed = 'move';
                    setDraggedSplitMember({ workspaceId: workspace.id, sessionId: session.id });
                  }}
                  onDragEnd={() => setDraggedSplitMember(null)}
                  className="inline-flex h-8 w-5 shrink-0 cursor-grab items-center justify-center text-muted-foreground/50 active:cursor-grabbing"
                >
                  <RiDragHandleLine size={12} />
                </span>
                {renderSessionRowBody(session, undefined, true, true)}
              </div>
            ))}
          </div>
          </div>
        )}
      </section>
    );
  };

  const renderSidebarEntityList = (
    entities: SidebarEntity[],
    droppableId: string,
    folderKey?: string,
  ): React.ReactNode => (
    <DragDropContext onDragEnd={(result) => handleEntityDragEnd(result, entities, folderKey)}>
      <Droppable droppableId={droppableId} direction="vertical" isCombineEnabled>
        {(provided) => (
          <div ref={provided.innerRef} {...provided.droppableProps} className="space-y-0.5">
            {entities.map((entity, index) => (
              <Draggable key={entity.id} draggableId={entity.id} index={index} disableInteractiveElementBlocking>
                {(dragProvided, snapshot) => (
                  <div ref={dragProvided.innerRef} {...dragProvided.draggableProps}>
                    {entity.kind === 'workspace' ? renderSplitWorkspaceItem(
                      entity.workspace,
                      entity.members,
                      dragProvided.dragHandleProps,
                      snapshot.isDragging,
                      Boolean(snapshot.combineTargetFor),
                    ) : (
                      <div
                        {...(onSessionMenu ? bindSessionLongPress(() => onSessionMenu(entity.session.id)) : {})}
                        className={`group relative flex items-center gap-1 rounded-md pr-1 transition-colors ${
                          snapshot.combineTargetFor
                            ? 'bg-primary/15 text-foreground ring-1 ring-primary/40'
                            : snapshot.isDragging
                              ? 'bg-surface-elevated text-foreground opacity-90 shadow-lg'
                              : getSessionStatusBackground(entity.session.id)
                                ?? (entity.session.id === activeSessionId
                                  ? 'bg-surface-elevated text-foreground'
                                  : 'text-muted-foreground hover:bg-surface-2')
                        } cursor-grab active:cursor-grabbing`}
                      >
                        {renderSessionRowBody(entity.session, dragProvided.dragHandleProps, folderKey !== undefined)}
                      </div>
                    )}
                  </div>
                )}
              </Draggable>
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </DragDropContext>
  );

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
          <div className="flex shrink-0 items-center gap-1">
            <div ref={headerMenuRef} className={headerMenuOpen ? 'relative z-20' : 'relative'}>
              <button
                type="button"
                onClick={() => setHeaderMenuOpen((open) => !open)}
                className={`relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition active:scale-95 ${headerMenuOpen ? 'bg-surface-elevated text-foreground' : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'}`}
                aria-expanded={headerMenuOpen}
                aria-haspopup="menu"
                aria-label={pendingUpdate && updateState?.latestVersion
                  ? `${t('sidebar.moreActions')}: ${t('sidebar.updateAvailable', { version: updateState.latestVersion })}`
                  : t('sidebar.moreActions')}
                title={pendingUpdate && updateState?.latestVersion
                  ? `${t('sidebar.moreActions')}: ${t('sidebar.updateAvailable', { version: updateState.latestVersion })}`
                  : t('sidebar.moreActions')}
              >
                <RiMoreHorizontal size={15} />
                {pendingUpdate && (
                  <span
                    className="absolute right-0.5 top-0.5 z-10 h-2 w-2 rounded-full bg-[var(--warning)] ring-2 ring-[var(--chrome-bg)]"
                    aria-hidden="true"
                  />
                )}
              </button>
              {headerMenuOpen && (
                <div role="menu" className="absolute right-0 top-[calc(100%+4px)] z-30 w-60 overflow-hidden rounded-xl border border-border/15 bg-surface p-1 text-[12px] shadow-xl shadow-[0_18px_48px_var(--app-shadow-soft)] animate-fade-in">
                  {pendingUpdate && updateState?.latestVersion && (
                    <div className="mb-1 rounded-lg bg-[rgb(var(--warning-rgb)_/_0.10)] px-2.5 py-2.5 text-foreground">
                      <div className="flex items-start gap-2">
                        <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[rgb(var(--warning-rgb)_/_0.16)] text-[color:var(--warning)]">
                          <RiRefreshLine size={13} className={updateState.status === 'installing' || updateState.status === 'restarting' ? 'animate-spin' : ''} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-semibold">{t('sidebar.updateAvailable', { version: updateState.latestVersion })}</span>
                          <span className="mt-0.5 block text-[10.5px] leading-relaxed text-muted-foreground">
                            {updateState.status === 'installing'
                              ? t('sidebar.updateInstalling')
                              : updateState.status === 'ready'
                                ? t('sidebar.updateReady')
                                : updateState.status === 'restarting'
                                  ? t('sidebar.updateRestarting')
                                  : t('sidebar.updateFailed')}
                          </span>
                        </span>
                      </div>
                      {updateState.status === 'ready' && onConfirmUpdateRestart && (
                        <button
                          type="button"
                          role="menuitem"
                          disabled={updateActionPending}
                          onClick={onConfirmUpdateRestart}
                          className="mt-2 flex w-full items-center justify-center rounded-md bg-[var(--warning)] px-2 py-1.5 text-[11px] font-semibold text-[color:var(--bg)] transition hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
                        >
                          {t('sidebar.updateRestart')}
                        </button>
                      )}
                      {updateState.status === 'error' && onRetryUpdate && (
                        <button
                          type="button"
                          role="menuitem"
                          disabled={updateActionPending}
                          onClick={onRetryUpdate}
                          className="mt-2 flex w-full items-center justify-center rounded-md bg-surface-elevated px-2 py-1.5 text-[11px] font-semibold text-foreground transition hover:bg-surface-2 disabled:cursor-wait disabled:opacity-60"
                        >
                          {t('sidebar.updateRetry')}
                        </button>
                      )}
                    </div>
                  )}
                  {onOpenQuota && (
                    <button type="button" role="menuitem" onClick={() => { setHeaderMenuOpen(false); onOpenQuota(); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-foreground transition hover:bg-surface-2">
                      <RiChartBarLine size={14} className="text-muted-foreground" />
                      <span>{t('sidebar.subscriptionQuota')}</span>
                    </button>
                  )}
                  <button type="button" role="menuitem" onClick={() => { setHeaderMenuOpen(false); onOpenSettings(); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-foreground transition hover:bg-surface-2">
                    <RiSettings4Line size={14} className="text-muted-foreground" />
                    <span>{t('sidebar.settings')}</span>
                  </button>
                  {onTogglePinned && (
                    <button type="button" role="menuitem" onClick={() => { setHeaderMenuOpen(false); onTogglePinned(); }} className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition ${pinned ? 'text-primary hover:bg-primary/10' : 'text-foreground hover:bg-surface-2'}`}>
                      {pinned ? <RiPinOffLine size={14} /> : <RiPushpinLine size={14} className="text-muted-foreground" />}
                      <span>{pinned ? t('sidebar.unpinSidebar') : t('sidebar.pinSidebar')}</span>
                    </button>
                  )}
                </div>
              )}
            </div>
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
        </div>
      </div>

      {/* Session list */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 py-1.5">
        {sessions.length === 0 ? (
          <div className="rounded-xl bg-surface-2/60 px-4 py-8 text-center">
            <RiTerminalLine size={26} className="mx-auto mb-2 text-muted-foreground" />
            <p className="text-[12px] text-muted-foreground">{t('sidebar.noSessions')}</p>
          </div>
        ) : visibleSessions.length === 0 && splitWorkspaces.length === 0 ? (
          <div className="rounded-xl bg-surface-2/60 px-4 py-6 text-center">
            <p className="text-[12px] text-muted-foreground">{t('sidebar.noMatchingSessions')}</p>
          </div>
        ) : groupByFolder ? (
          <div className="space-y-1.5">
            <DragDropContext onDragEnd={handleGroupedDragEnd}>
              <Droppable droppableId="sidebar-groups" type="group" direction="vertical">
                {(groupsProvided) => (
                  <div ref={groupsProvided.innerRef} {...groupsProvided.droppableProps} className="space-y-1.5">
                    {folderGroups.map((group, groupIndex) => {
                      const collapsed = collapsedGroups.has(group.key);
                      const folderEntities = buildSidebarEntities(group.sessions, splitWorkspaces, sessionsById);
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
                      // 「其他」组（无 cwd）永远排最后，禁止整组拖动。
                      const groupDragDisabled = group.key === '';
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
                                className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-muted-foreground transition hover:bg-surface-2 ${groupDragDisabled ? '' : 'cursor-grab active:cursor-grabbing'}`}
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
                                <div className="mt-0.5 pl-2">
                                  <Droppable droppableId={`group-sessions:${group.key}`} type="session" direction="vertical" isCombineEnabled>
                                    {(sessionsProvided) => (
                                      <div ref={sessionsProvided.innerRef} {...sessionsProvided.droppableProps} className="space-y-0.5">
                                        {folderEntities.map((entity, index) => (
                                          <Draggable key={entity.id} draggableId={entity.id} index={index} disableInteractiveElementBlocking>
                                            {(dragProvided, snapshot) => (
                                              <div ref={dragProvided.innerRef} {...dragProvided.draggableProps}>
                                                {entity.kind === 'workspace' ? renderSplitWorkspaceItem(
                                                  entity.workspace,
                                                  entity.members,
                                                  dragProvided.dragHandleProps,
                                                  snapshot.isDragging,
                                                  Boolean(snapshot.combineTargetFor),
                                                ) : (
                                                  <div
                                                    {...(onSessionMenu ? bindSessionLongPress(() => onSessionMenu(entity.session.id)) : {})}
                                                    className={`group relative flex items-center gap-1 rounded-md pr-1 transition-colors ${
                                                      snapshot.combineTargetFor
                                                        ? 'bg-primary/15 text-foreground ring-1 ring-primary/40'
                                                        : snapshot.isDragging
                                                          ? 'bg-surface-elevated text-foreground opacity-90 shadow-lg'
                                                          : getSessionStatusBackground(entity.session.id)
                                                            ?? (entity.session.id === activeSessionId
                                                              ? 'bg-surface-elevated text-foreground'
                                                              : 'text-muted-foreground hover:bg-surface-2')
                                                    } cursor-grab active:cursor-grabbing`}
                                                  >
                                                    {renderSessionRowBody(entity.session, dragProvided.dragHandleProps, true)}
                                                  </div>
                                                )}
                                              </div>
                                            )}
                                          </Draggable>
                                        ))}
                                        {sessionsProvided.placeholder}
                                      </div>
                                    )}
                                  </Droppable>
                                </div>
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
          renderSidebarEntityList(flatSidebarEntities, 'sidebar-entities')
        )}
      </div>

      {newSessionComposerOpen && (
        <NewSessionComposer
          directories={sessions.flatMap((session) => {
            const directory = sessionStates.get(session.id)?.cwd;
            return directory ? [directory] : [];
          })}
          tmuxAvailable={tmuxAvailable}
          options={newSessionOptions}
          onClose={() => setNewSessionComposerOpen(false)}
          onOptionsChange={setNewSessionOptions}
        />
      )}

      {/* Footer — one primary action, with optional launch details behind the chevron. */}
      <div className="shrink-0 border-t border-border/15 p-2">
        <div className="flex overflow-hidden rounded-lg bg-primary text-primary-foreground ring-1 ring-primary/40 shadow-md shadow-primary/25">
          <button
            type="button"
            onClick={handleNewSessionClick}
            className="flex min-w-0 flex-1 items-center justify-center gap-2 px-3 py-2.5 text-[13px] font-semibold transition hover:bg-primary/90 active:scale-[0.99]"
            title={t('sidebar.newSession')}
            aria-label={t('sidebar.newSession')}
          >
            <RiAddLine size={15} className="shrink-0" />
            <span className="truncate">{t('sidebar.newSession')}</span>
          </button>
          <button
            type="button"
            onClick={toggleNewSessionComposer}
            className={`inline-flex w-10 shrink-0 items-center justify-center border-l border-primary-foreground/20 transition hover:bg-primary/90 active:bg-primary/80 ${newSessionComposerOpen ? 'bg-primary/80' : ''}`}
            title={t('sidebar.newSession')}
            aria-label={t('sidebar.newSession')}
            aria-expanded={newSessionComposerOpen}
          >
            <RiChevronDownLine size={15} className={`transition-transform duration-200 ${newSessionComposerOpen ? 'rotate-180' : ''}`} />
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
