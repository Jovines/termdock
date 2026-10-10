import { CollaborationTaskWorkbench } from './CollaborationTaskWorkbench';
import { freshGroupSettingsDraft, groupSettingsDirty, readGroupSettingsDraft, rebaseGroupSettingsDraft, writeGroupSettingsDraft, type GroupSettingsDraft } from '../../collaboration/groupSettingsDraft';
import { collaborationMemberLabel, collaborationServiceLabel } from '../../collaboration/display';
import { useCollaborationPanelDock } from '../../stores/useCollaborationPanelDock';
import { collaborationGroupPreferences, collaborationPanelClientId, relativePanelPosition, saveCollaborationPanel } from '../../collaboration/panelPreferences';
import { focusCollaborationInput, registerCollaborationInput } from '../../collaboration/inputTarget';
import { escapeShellPath } from '../../desktop/shellPath';
import { getTermdockDesktopBridge } from '../../desktop/nativeBridge';
import { remoteSessionAddress, type CollaborationPeerState, type CollaborationPeerService } from '../../collaboration/directory';
import { openRemoteSession } from '../../federation/remoteSession';
import { isConnectionInterruption, SECURE_READY_EVENT, useConnectionRecovery } from '../../federation/connectionRecovery';
import { shortId } from '../../utils/shortId';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, MoreHorizontal, CalendarClock, Check, ChevronDown, Clock3, ExternalLink, Maximize2, FolderOpen, Link2, Pause, Pencil, Play, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import {
  getSettings,
  type CollaborationPanelState,
  uploadFiles,
  getAgentLaunchers,
  listAgentAutomations,
  listCollaborationGroups,
  subscribeCollaborationGroups,
  retryCollaborationPeers,
  type CollaborationGroupsResponse,
  listCollaborationMessages,
  prepareAgentResumeHistory,
  prepareSearchSession,
  removeAgentAutomation,
  removeCollaborationGroup,
  removeCollaborationConnection,
  restoreCollaborationConnection,
  runAgentAutomation,
  saveAgentAutomation,
  saveCollaborationGroup,
  setCollaborationMemberRole,
  setCollaborationGroupRules,
  TerminalApiError,
  searchTerminalSessions,
  sendCollaborationMessage,
  spawnCollaborationAgent,
  setAgentAutomationEnabled,
  type AgentAutomation,
  type AgentLauncherInfo,
  type AutomationSchedule,
  type AutomationRun,
  type CollaborationGroup,
  type CollaborationMessage,
  type CollaborationMessageKind,
  type OrchestrationSession,
  type SessionSearchResult,
  type SessionSearchResponse,
} from '../../terminal/api';
import { DirectoryPickerDialog } from './DirectoryPickerDialog';

type Tab = 'automation' | 'collaboration' | 'search';

function workbenchPreference(key: 'tab' | 'group', value?: string): string | null {
  try {
    const storageKey = `termdock-workbench:${window.location.origin}:${key}`;
    if (value !== undefined) localStorage.setItem(storageKey, value);
    return localStorage.getItem(storageKey);
  } catch { return null; }
}

function initialWorkbenchTab(): Tab {
  const saved = workbenchPreference('tab');
  return saved === 'automation' || saved === 'search' ? saved : 'collaboration';
}

interface AgentOperationsPanelProps {
  initialFloating?: boolean;
  onFloatingChange?: (groupId: string | null) => Promise<void>;
  onEnterGroup?: (groupId: string) => Promise<void>;
  activeSessionId: string | null;
  initialCollaborationGroupId?: string | null;
  defaultSessionMode?: 'shell' | 'tmux';
  onClose: () => void;
  onNewSession: (opts: { mode: 'shell'; cwd?: string; command?: string }) => void;
}

const inputClass = 'w-full rounded-lg border border-border/20 bg-surface-2 px-3 py-2 text-[12px] text-foreground outline-none transition focus:border-primary/60';
const choiceClass = 'inline-flex min-h-7 items-center justify-center rounded-md border px-2 py-1 text-[11px] leading-4 font-medium transition';
const buttonClass = 'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40';

type PanelDrafts = NonNullable<CollaborationPanelState['drafts']>;
// Origin identity stays in memory; persisted panel drafts keep their existing shape.
const sharedDraftOrigins = new WeakMap<object, object>();

export function AgentOperationsPanel(props: AgentOperationsPanelProps) {
  const [overlay, setOverlay] = useState<'floating' | 'full' | null>(null);
  const [residentClosed, setResidentClosed] = useState(false);
  const [drafts, setDrafts] = useState<PanelDrafts>({});
  const loadDrafts = useCallback((saved: PanelDrafts) => setDrafts(current => ({ ...saved, ...current })), []);
  const updateDraft = useCallback((id: string, draft: PanelDrafts[string], origin?: object) => setDrafts(current => {
    if (JSON.stringify(current[id]) === JSON.stringify(draft)) return current;
    const shared = { ...draft };
    if (origin) sharedDraftOrigins.set(shared, origin);
    return { ...current, [id]: shared };
  }), []);
  const shared = { drafts, loadDrafts, updateDraft };
  return <>
    {!residentClosed && <AgentOperationsPanelView {...props} {...shared} overlayObscured={!!overlay} onOpenOverlay={setOverlay}
      onClose={() => { if (overlay) setResidentClosed(true); else props.onClose(); }} />}
    {overlay && <AgentOperationsPanelView {...props} {...shared} overlayOnly initialFloating={overlay === 'floating'}
      onFloatingChange={undefined} onOpenOverlay={setOverlay}
      onClose={() => { setOverlay(null); if (residentClosed) props.onClose(); }} />}
  </>;
}

function AgentOperationsPanelView({ activeSessionId, initialCollaborationGroupId = null, initialFloating = false, onFloatingChange, onEnterGroup, defaultSessionMode = 'shell', onClose, onNewSession,
  overlayOnly = false, overlayObscured = false, onOpenOverlay, drafts, loadDrafts, updateDraft,
}: AgentOperationsPanelProps & {
  overlayOnly?: boolean;
  overlayObscured?: boolean;
  onOpenOverlay: (mode: 'floating' | 'full') => void;
  drafts: PanelDrafts;
  loadDrafts: (drafts: PanelDrafts) => void;
  updateDraft: (id: string, draft: PanelDrafts[string], origin?: object) => void;
}) {
  const groupWorkspace = !!initialCollaborationGroupId;
  const [floating, setFloating] = useState(initialFloating);
  useEffect(() => { setFloating(initialFloating); }, [initialFloating]);
  const [savingFloating, setSavingFloating] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(initialCollaborationGroupId);
  const dock = useCollaborationPanelDock(state => state.docks[initialCollaborationGroupId ?? 'workbench']);
  const dockHost = useCollaborationPanelDock(state => state.hosts[initialCollaborationGroupId ?? 'workbench']);
  const [panelMode, setPanelMode] = useState<'floating' | 'docked'>('docked');
  const [panelSize, setPanelSize] = useState<{ width: number; height: number } | null>(null);
  const [position, setPosition] = useState({ x: 16, y: 80 });
  const panelRef = useRef<HTMLElement>(null);
  const obscuredFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = panelRef.current;
    if (!node) return;
    if (overlayObscured) {
      if (node.contains(document.activeElement)) obscuredFocus.current = document.activeElement as HTMLElement;
      node.inert = true;
    } else {
      node.inert = false;
      if (obscuredFocus.current?.isConnected) obscuredFocus.current.focus({ preventScroll: true });
      obscuredFocus.current = null;
    }
  }, [overlayObscured]);
  useEffect(() => {
    if (!overlayOnly || floating) return;
    const node = panelRef.current;
    node?.querySelector<HTMLButtonElement>('button[aria-label="收起展开视图"]')?.focus({ preventScroll: true });
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented || !node) return;
      const controls = Array.from(node.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]'))
        .filter(element => !element.closest('[hidden], [inert]') && element.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      const outside = !node.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || outside)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || outside)) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => document.removeEventListener('keydown', trap);
  }, [overlayOnly, floating]);
  // Keep the React tree in one portal while its DOM container follows members.
  const [portalTarget] = useState(() => document.createElement('div'));
  const relativePosition = useRef({ x: 0.5, y: 0.5 });
  const [panelState, setPanelState] = useState<CollaborationPanelState | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getSettings().then(settings => {
      if (cancelled) return;
      const saved = collaborationGroupPreferences(settings.collaborationPanels?.[collaborationPanelClientId()], initialCollaborationGroupId);
      if (saved.position) relativePosition.current = saved.position;
      if (saved.size) setPanelSize(saved.size);
      loadDrafts(saved.drafts ?? {});
      if (!overlayOnly) setPanelMode(saved.mode ?? 'docked');
      setPanelState(saved);
    }).catch(() => {
      if (!cancelled) setPreferenceError('面板草稿加载失败，请重新打开面板重试');
    });
    return () => { cancelled = true; };
  }, []);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  useEffect(() => {
    const onError = (event: Event) => setPreferenceError(String((event as CustomEvent).detail));
    window.addEventListener('termdock-panel-save-error', onError);
    return () => { window.removeEventListener('termdock-panel-save-error', onError); if (!overlayOnly) useCollaborationPanelDock.getState().setDock(initialCollaborationGroupId ?? 'workbench', null); };
  }, []);
  const docked = !overlayOnly && floating && panelMode === 'docked' && !!dockHost;
  useLayoutEffect(() => {
    portalTarget.className = docked ? 'h-full min-h-0 w-full min-w-0' : 'contents';
    (docked ? dockHost : document.body)?.appendChild(portalTarget);
    return () => portalTarget.remove();
  }, [portalTarget, docked, dockHost]);
  useEffect(() => {
    if (!overlayOnly && !floating) useCollaborationPanelDock.getState().setDock(initialCollaborationGroupId ?? 'workbench', null);
  }, [floating]);
  const changePanelMode = async (mode: 'floating' | 'docked') => {
    if (overlayOnly || savingFloating || (mode === 'docked' && !activeSessionId)) return;
    const nextDock = { sessionId: activeSessionId!, side: 'right' as const };
    setSavingFloating(true);
    try {
      await saveCollaborationPanel({ mode, ...(mode === 'docked' ? { dock: nextDock } : {}) }, initialCollaborationGroupId);
      setPanelMode(mode);
      useCollaborationPanelDock.getState().setDock(initialCollaborationGroupId ?? 'workbench', mode === 'docked' ? { ...nextDock, ...(groupWorkspace ? { preferredWidth: 360 } : {}) } : null);
    } catch { setPreferenceError('面板布局保存失败，请重试'); }
    finally { setSavingFloating(false); }
  };
  const resizingFloating = useRef(false);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const clampPosition = useCallback((x: number, y: number) => {
    const box = panelRef.current?.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft ?? 0) + 12;
    const top = (viewport?.offsetTop ?? 0) + 12;
    return { x: Math.max(left, Math.min(x, left + (viewport?.width ?? window.innerWidth) - (box?.width ?? 440) - 24)), y: Math.max(top, Math.min(y, top + (viewport?.height ?? window.innerHeight) - (box?.height ?? 340) - 24)) };
  }, []);
  const [tab, setTab] = useState<Tab>(() => initialCollaborationGroupId ? 'collaboration' : initialWorkbenchTab());
  const [visitedTabs, setVisitedTabs] = useState<Set<Tab>>(() => new Set([tab]));
  const changeTab = (next: Tab) => {
    setTab(next);
    setVisitedTabs(current => new Set([...current, next]));
    setError(null); setNotice(null);
    if (!initialCollaborationGroupId && !overlayOnly) workbenchPreference('tab', next);
  };
  const [automations, setAutomations] = useState<AgentAutomation[]>([]);
  const [automationRuns, setAutomationRuns] = useState<AutomationRun[]>([]);
  const [agents, setAgents] = useState<AgentLauncherInfo[]>([]);
  const [groups, setGroups] = useState<CollaborationGroup[]>([]);
  const [sessions, setSessions] = useState<OrchestrationSession[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const [sessionsState, setSessionsState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [automationsState, setAutomationsState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [automationsError, setAutomationsError] = useState<string | null>(null);
  const [collaborationError, setCollaborationError] = useState<string | null>(null);
  const [peerState, setPeerState] = useState<CollaborationPeerState | undefined>();
  const [launcherError, setLauncherError] = useState<string | null>(null);
  const collaborationRefresh = useRef<Promise<void> | null>(null);
  const automationRefresh = useRef<Promise<void> | null>(null);
  const launcherRefresh = useRef<Promise<void> | null>(null);
  const directCollaborationGroup = initialCollaborationGroupId
    ? groups.find((group) => group.id === initialCollaborationGroupId) ?? null
    : null;

  const restoredGroup = useRef(false);
  useEffect(() => {
    if (initialCollaborationGroupId || sessionsState !== 'loaded' || restoredGroup.current) return;
    restoredGroup.current = true;
    const remembered = workbenchPreference('group');
    const group = groups.find(group => group.id === remembered)
      ?? groups.find(group => activeSessionId && group.sessionIds.includes(activeSessionId))
      ?? groups[0];
    setSelectedGroupId(current => current ?? group?.id ?? null);
  }, [initialCollaborationGroupId, sessionsState, groups, activeSessionId]);
  useEffect(() => {
    if (!initialCollaborationGroupId && !overlayOnly && selectedGroupId && groups.some(group => group.id === selectedGroupId)) {
      workbenchPreference('group', selectedGroupId);
    }
  }, [selectedGroupId, groups, initialCollaborationGroupId, overlayOnly]);

  const selectedGroup = selectedGroupId ? groups.find(group => group.id === selectedGroupId) ?? null : groups[0] ?? null;
  const unavailableGroup = !!initialCollaborationGroupId && sessionsState === 'loaded' && !directCollaborationGroup;
  // An unresolved group is not an unavailable group. Restored resident panels
  // must wait for membership and saved layout before appearing over a terminal.
  const panelPreferencesReady = !!panelState || !!preferenceError;
  const waitingForDockHost = !overlayOnly && floating && panelMode === 'docked'
    && !!(dock ?? panelState?.dock) && !dockHost;
  const floatingVisible = panelPreferencesReady && !waitingForDockHost && !!activeSessionId
    && (!initialCollaborationGroupId || !!dockHost || !!selectedGroup?.sessionIds.includes(activeSessionId)
      || !!initialCollaborationGroupId && (sessionsState !== 'loading' && !directCollaborationGroup || !!preferenceError));
  useLayoutEffect(() => {
    if (!floating || docked || !floatingVisible) return;
    const resize = () => {
      const viewport = window.visualViewport;
      setViewportHeight(viewport?.height ?? window.innerHeight);
      const box = panelRef.current?.getBoundingClientRect();
      if (!box?.width || !box.height || resizingFloating.current) return;
      setPosition(clampPosition((viewport?.offsetLeft ?? 0) + 12 + Math.max(0, (viewport?.width ?? window.innerWidth) - box.width - 24) * relativePosition.current.x,
        (viewport?.offsetTop ?? 0) + 12 + Math.max(0, (viewport?.height ?? window.innerHeight) - box.height - 24) * relativePosition.current.y));
    };
    const observer = new ResizeObserver(resize);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    resize();
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize); };
  }, [floating, docked, floatingVisible, clampPosition, panelState, panelSize]);
  // Restore docks only for resident panels, never while loading a full panel.
  // A saved dock can outlive its group. Release the split without discarding
  // drafts or saved preferences: a temporary missing replica may return.
  useLayoutEffect(() => {
    if (overlayOnly) return;
    const key = initialCollaborationGroupId ?? 'workbench';
    const state = useCollaborationPanelDock.getState();
    if (unavailableGroup) {
      if (state.docks[key]) state.setDock(key, null);
    } else if (panelPreferencesReady && floating && panelMode === 'docked' && activeSessionId
      && (!initialCollaborationGroupId || directCollaborationGroup)) {
      const existing = state.docks[key];
      const anchor = !initialCollaborationGroupId || directCollaborationGroup?.sessionIds.includes(activeSessionId) ? activeSessionId
        : sessions.find(session => directCollaborationGroup?.sessionIds.includes(session.sessionId) && !remoteSessionAddress(session.sessionId))?.sessionId ?? activeSessionId;
      const base = existing ?? panelState?.dock ?? { sessionId: anchor, side: window.innerWidth < 640 ? 'bottom' as const : 'right' as const };
      const next = { ...base, sessionId: directCollaborationGroup?.sessionIds.includes(activeSessionId) ? activeSessionId : base.sessionId,
        ...(groupWorkspace ? { preferredWidth: existing?.preferredWidth ?? 360 } : {}) };
      if (!existing || next.sessionId !== existing.sessionId || next.preferredWidth !== existing.preferredWidth) state.setDock(key, next);
      if (groupWorkspace && existing && next.sessionId !== existing.sessionId) {
        void saveCollaborationPanel({ dock: { sessionId: next.sessionId, side: next.side } }, initialCollaborationGroupId)
          .catch(() => setPreferenceError('协作位置保存失败，当前面板仍可使用'));
      }
    }
  }, [unavailableGroup, directCollaborationGroup, floating, panelMode, panelState, panelPreferencesReady, activeSessionId, initialCollaborationGroupId, dock, sessions]);

  const changeFloating = async (next: boolean, close = false) => {
    if (savingFloating || (next && !selectedGroup)) return;
    if (!overlayOnly && !next && !close && dock) { onOpenOverlay('full'); return; }
    if (overlayOnly) {
      if (close) onClose();
      else { setFloating(next); onOpenOverlay(next ? 'floating' : 'full'); }
      return;
    }
    setSavingFloating(true);
    try {
      await onFloatingChange?.(next ? selectedGroup!.id : null);
      setFloating(next);
      if (next && panelMode === 'docked' && activeSessionId) useCollaborationPanelDock.getState().setDock(initialCollaborationGroupId ?? 'workbench', { sessionId: activeSessionId, side: dock?.side ?? panelState?.dock?.side ?? 'right' });
      if (close) onClose();
    } catch (error) {
      setError(`常驻浮窗状态保存失败，请重试：${error instanceof Error ? error.message : '连接失败'}`);
    } finally { setSavingFloating(false); }
  };

  const acceptCollaboration = useCallback((data: CollaborationGroupsResponse) => {
    setGroups(data.groups);
    setSessions(data.sessions);
    setPeerState(data.peers);
    setCollaborationError(null);
    setSessionsState('loaded');
  }, []);
  useEffect(() => subscribeCollaborationGroups(acceptCollaboration), [acceptCollaboration]);

  const refresh = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setError(null);
    // Launcher discovery can be slow (custom commands, network PATH entries).
    // It must not gate the already-running sessions or an unrelated tab.
    if (!groupWorkspace && !automationRefresh.current) {
      automationRefresh.current = listAgentAutomations().then((data) => {
        setAutomations(data.automations);
        setAutomationRuns(data.runs);
        setAutomationsState('loaded');
        setAutomationsError(null);
      }).catch((nextError) => {
        setAutomationsState('error');
        setAutomationsError(nextError instanceof Error ? nextError.message : '自动任务加载失败');
      }).finally(() => { automationRefresh.current = null; });
    }
    if (!launcherRefresh.current) {
      launcherRefresh.current = getAgentLaunchers().then((data) => {
        setAgents(data);
        setLauncherError(null);
      }).catch(() => {
        setLauncherError('Agent 命令检测失败；已有会话可继续协作。');
      }).finally(() => { launcherRefresh.current = null; });
    }
    if (!collaborationRefresh.current) {
      setSessionsState((state) => state === 'error' ? 'loading' : state);
      collaborationRefresh.current = listCollaborationGroups().then(acceptCollaboration).catch((nextError) => {
        setSessionsState('error');
        setCollaborationError(`协作会话加载失败：${nextError instanceof Error ? nextError.message : '请重试'}`);
      }).finally(() => { collaborationRefresh.current = null; });
    }
    await Promise.all([collaborationRefresh.current, automationRefresh.current]);
  }, [acceptCollaboration, groupWorkspace]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh({ silent: true }), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented && !floating) onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, floating]);

  const chooseGroup = (id: string | null) => {
    if (groupWorkspace && id && id !== initialCollaborationGroupId && groups.some(group => group.id === id) && onEnterGroup) {
      void onEnterGroup(id).catch(error => setError(error instanceof Error ? error.message : '无法打开工作区'));
    } else setSelectedGroupId(id);
  };
  const openMemberSession = async (session: OrchestrationSession) => {
    // Local member navigation updates activeSessionId; the group follows it
    // immediately and saves the anchor without delaying terminal switching.
    await openCollaborationSession(session);
  };

  return createPortal(
    <>
      {!floating && <button
        type="button"
        className="fixed inset-0 z-modal-backdrop bg-[var(--app-backdrop)] backdrop-blur-sm cursor-default"
        onClick={onClose}
        aria-label="关闭 Agent 工作台"
      />}
      <section onPointerDown={event => { if (docked) event.stopPropagation(); }} ref={panelRef} role={overlayOnly && !floating ? 'dialog' : undefined} aria-modal={overlayOnly && !floating ? true : undefined} aria-hidden={overlayObscured || undefined} aria-label={docked ? '工作组消息分屏' : floating ? '工作组消息浮窗' : 'Agent 工作台'} style={floating && !docked ? { display: floatingVisible ? undefined : 'none', left: position.x, top: position.y, ...(panelSize ? { width: `min(calc(100vw - 24px), max(280px, ${panelSize.width * 100}vw))`, height: `min(calc(100dvh - 24px), max(220px, ${panelSize.height * 100}dvh))` } : {}), maxHeight: viewportHeight ? viewportHeight - 24 : 'calc(100dvh - 24px)' } : undefined} className={docked ? 'flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-surface' : floating ? 'fixed z-menu-panel flex w-[min(400px,calc(100vw-24px))] flex-col overflow-hidden rounded-2xl border border-border/20 bg-surface shadow-xl' : `fixed left-[max(0.75rem,env(safe-area-inset-left,0px))] right-[max(0.75rem,env(safe-area-inset-right,0px))] top-[max(1.5rem,var(--app-vv-offset-top,0px),env(safe-area-inset-top,0px))] h-[calc(var(--app-visible-vh,100dvh)-max(1.5rem,var(--app-vv-offset-top,0px),env(safe-area-inset-top,0px))-max(1.5rem,env(safe-area-inset-bottom,0px)))] z-modal-panel mx-auto flex ${groupWorkspace ? 'max-w-6xl' : 'max-w-3xl'} flex-col overflow-hidden rounded-2xl border border-border/15 bg-surface shadow-[0_28px_70px_var(--app-shadow-strong),0_14px_32px_var(--app-shadow-soft)] sm:top-[calc(var(--app-visible-vh,100dvh)*0.08)] sm:h-[calc(var(--app-visible-vh,100dvh)*0.84)]`}>
        <header data-pane-titlebar={docked ? "true" : undefined} data-panel-drag-title={docked ? "true" : undefined} onDragStart={event => event.preventDefault()} className={`flex items-center gap-2 border-b border-border/15 ${docked ? 'min-h-9 shrink-0 cursor-grab select-none bg-[var(--chrome-bg)] px-3 active:cursor-grabbing' : floating ? 'px-3 py-2 cursor-move touch-none select-none' : 'px-4 py-3'}`}
          onPointerDown={event => {
            if (!floating || docked || event.button !== 0 || (event.target as Element).closest('button, summary')) return;
            drag.current = { x: event.clientX, y: event.clientY, left: position.x, top: position.y };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={event => { if (drag.current) setPosition(clampPosition(drag.current.left + event.clientX - drag.current.x, drag.current.top + event.clientY - drag.current.y)); }}
          onPointerUp={() => {
            if (!drag.current) return;
            drag.current = null;
            const box = panelRef.current?.getBoundingClientRect();
            const viewport = window.visualViewport;
            if (!box) return;
            relativePosition.current = relativePanelPosition(position.x, position.y, (viewport?.offsetLeft ?? 0) + 12, (viewport?.offsetTop ?? 0) + 12,
              (viewport?.width ?? window.innerWidth) - box.width - 24, (viewport?.height ?? window.innerHeight) - box.height - 24);
            void saveCollaborationPanel({ position: relativePosition.current }, initialCollaborationGroupId).catch(() => setPreferenceError('浮窗位置保存失败，请重新拖动重试'));
          }} onPointerCancel={() => { drag.current = null; }}>
          <Bot size={docked ? 13 : 17} className="shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <h2 className={`${floating ? 'truncate text-[12px]' : 'text-[14px]'} font-semibold text-foreground`} title={docked ? '拖动标题移动面板；放在边缘拆分，中央交换' : directCollaborationGroup?.name}>{directCollaborationGroup ? directCollaborationGroup.name : initialCollaborationGroupId ? '协作工作区' : 'Agent 工作台'}</h2>
            {!docked && !groupWorkspace && <p className="text-[10px] text-muted-foreground">{floating ? '引用、文件路径和粘贴优先加入此处' : directCollaborationGroup ? '分派任务、回答问题、审阅与验收结果' : '自动任务、会话协作与历史搜索'}</p>}
          </div>
          {!docked && !overlayOnly && tab === 'collaboration' && groups.length > 0 && <button className={`${buttonClass} shrink-0 text-primary hover:bg-primary/10`} disabled={savingFloating} onClick={() => void changeFloating(!floating)}>{floating ? '展开' : '放到终端旁'}</button>}
          {groupWorkspace && directCollaborationGroup && <span className="shrink-0 text-[11px] text-muted-foreground">{directCollaborationGroup.sessionIds.length} 人</span>}
          {docked && <button type="button" aria-label="展开协作工作区" title="展开查看目标与交付" disabled={savingFloating} className="flex min-h-11 shrink-0 items-center justify-center rounded-lg px-2 text-muted-foreground hover:bg-surface-2 hover:text-foreground" onClick={() => onOpenOverlay('full')}><Maximize2 size={15} /></button>}
          {docked && <details className="relative z-20 shrink-0">
            <summary aria-label="面板布局" title="面板布局" className="flex min-h-8 cursor-pointer list-none items-center rounded px-2 text-muted-foreground hover:bg-surface-2 [&::-webkit-details-marker]:hidden"><MoreHorizontal size={16} /></summary>
            <div className="absolute right-0 top-full z-30 w-36 rounded-lg border border-border/20 bg-surface-2 p-1 shadow-lg">
              <button type="button" disabled={savingFloating} className={`${buttonClass} min-h-11 w-full justify-start text-foreground hover:bg-surface-elevated`} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void changePanelMode('floating'); }}><ExternalLink size={14} />小浮窗</button>
            </div>
          </details>}
          <button className={`${docked ? 'min-h-8 rounded px-2' : 'rounded-lg p-2'} text-muted-foreground hover:bg-surface-2 hover:text-foreground`} disabled={savingFloating} onClick={() => { if (floating) void changeFloating(false, true); else onClose(); }} aria-label={overlayOnly ? '收起展开视图' : '关闭'}><X size={16} /></button>
        </header>
        {floating && !docked && !overlayOnly && <div className="flex flex-wrap items-center gap-1 border-b border-border/15 px-3 py-1.5">
          <button type="button" disabled={savingFloating} aria-pressed={panelMode === 'floating'} className={`${choiceClass} ${panelMode === 'floating' ? 'border-primary/40 text-primary' : 'border-transparent text-muted-foreground'}`} onClick={() => void changePanelMode('floating')}>浮窗</button>
          <button type="button" disabled={savingFloating || !activeSessionId || unavailableGroup} aria-pressed={panelMode === 'docked'} className={`${choiceClass} ${panelMode === 'docked' ? 'border-primary/40 text-primary' : 'border-transparent text-muted-foreground'}`} onClick={() => void changePanelMode('docked')}>放到终端旁</button>

        </div>}
        {!groupWorkspace && (!floating || docked) && <nav aria-label="工作台功能" className="grid shrink-0 grid-cols-3 gap-1 border-b border-border/15 px-2 py-1">
          {([
            ['collaboration', Link2, '协作组'],
            ['automation', Clock3, '自动任务'],
            ['search', Search, '历史搜索'],
          ] as const).map(([id, Icon, label]) => (
            <button key={id} type="button" aria-pressed={tab === id} aria-controls={`workbench-${id}`} onClick={() => changeTab(id)} className={`${buttonClass} ${tab === id ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}>
              <Icon size={14} />{label}
            </button>
          ))}
        </nav>}
        {tab === 'collaboration' && collaborationError && <div role="alert" className="mx-4 mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-[11px] text-destructive">{collaborationError}<button className={`${buttonClass} ml-2`} onClick={() => void refresh()}>重新加载会话</button></div>}
        {!groupWorkspace && tab !== 'search' && launcherError && <div className="mx-4 mt-3 text-[11px] text-muted-foreground">{launcherError}</div>}
        {error && <div className="mx-4 mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-[11px] text-destructive">{error}</div>}
        {notice && (!floating || docked) && <div role="status" className="mx-3 mt-2 flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-2 text-[11px] text-primary"><Check size={13} />{notice}</div>}
        <div className="min-h-0 flex-1 overflow-hidden">
          {visitedTabs.has('automation') && <div id="workbench-automation" className={tab === 'automation' ? 'h-full min-h-0 p-4' : 'hidden'}>
            <AutomationTab automations={automations} runs={automationRuns} agents={agents} sessions={sessions.filter(session => !remoteSessionAddress(session.sessionId))} activeSessionId={activeSessionId} loading={automationsState === 'loading'} loadError={automationsError} busy={busy} setBusy={setBusy} setError={setError} setNotice={setNotice} refresh={refresh} onClose={onClose} />
          </div>}
          {visitedTabs.has('collaboration') && <div id="workbench-collaboration" className={tab === 'collaboration' ? `h-full min-h-0 overflow-x-hidden overflow-y-auto overscroll-y-contain ${floating ? 'p-3' : 'p-4'}` : 'hidden'}>
          {!panelState && !preferenceError && <p role="status" className="text-[11px] text-muted-foreground">正在恢复消息面板…</p>}
          {initialCollaborationGroupId && !directCollaborationGroup && <div role="status" className="space-y-2 text-[11px] text-muted-foreground">
            <p>{sessionsState === 'loading' ? '正在加载协作组…' : sessionsState === 'error' ? '协作组加载失败，恢复连接后可重试。' : '此协作组暂不可用，已释放分屏位置。草稿和布局偏好仍保留。'}</p>
            {sessionsState !== 'loading' && <button className={buttonClass} onClick={() => void refresh()}>重新加载</button>}
          </div>}
          {preferenceError && <p role="alert" className="text-[11px] text-destructive">{preferenceError}</p>}
          {panelState && (!initialCollaborationGroupId || directCollaborationGroup) && <CollaborationTab active={tab === 'collaboration'} notice={notice} initialDrafts={drafts} onDraftChange={updateDraft} docked={docked} inputKeySuffix={overlayOnly ? ':overlay' : ''} selectedGroupId={selectedGroupId} setSelectedGroupId={chooseGroup} floatingVisible={floatingVisible} floating={floating} sessionsState={sessionsState} groups={groups} sessions={sessions} agents={agents} activeSessionId={activeSessionId} initialGroupId={initialCollaborationGroupId} onOpenSession={async session => { await openMemberSession(session); if (!floating) onClose(); }} onOpenTaskSession={openMemberSession} onEnterGroup={onEnterGroup} defaultSessionMode={defaultSessionMode} busy={busy} setBusy={setBusy} setError={setError} setNotice={setNotice} refresh={refresh} />}
          {!groupWorkspace && peerState && <CollaborationServiceManager peers={peerState} currentGroupId={selectedGroup?.id} busy={busy} setBusy={setBusy} setError={setError} setNotice={setNotice} onSelectGroup={chooseGroup} />}
          </div>}
          {visitedTabs.has('search') && <div id="workbench-search" className={tab === 'search' ? 'h-full min-h-0 overflow-y-auto overscroll-y-contain p-4' : 'hidden'}>
            <SearchTab active={tab === 'search'} onClose={onClose} onNewSession={onNewSession} setError={setError} />
          </div>}
        </div>
        {floating && !docked && <button type="button" aria-label="调整协作浮窗大小" className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize touch-none text-muted-foreground hover:text-primary"
          onPointerDown={event => { event.preventDefault(); resizingFloating.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const viewport = window.visualViewport;
            const width = viewport?.width ?? window.innerWidth;
            const height = viewport?.height ?? window.innerHeight;
            setPanelSize({ width: Math.min(1, Math.max(280, event.clientX - position.x) / width), height: Math.min(1, Math.max(220, event.clientY - position.y) / height) });
          }}
          onPointerUp={() => {
            resizingFloating.current = false;
            const box = panelRef.current?.getBoundingClientRect();
            const viewport = window.visualViewport;
            if (box) relativePosition.current = relativePanelPosition(position.x, position.y, (viewport?.offsetLeft ?? 0) + 12, (viewport?.offsetTop ?? 0) + 12, (viewport?.width ?? window.innerWidth) - box.width - 24, (viewport?.height ?? window.innerHeight) - box.height - 24);
            if (panelSize) void saveCollaborationPanel({ size: panelSize, position: relativePosition.current }, initialCollaborationGroupId).catch(() => setPreferenceError('浮窗大小保存失败，请重新调整重试'));
          }} onPointerCancel={() => { resizingFloating.current = false; }}
          onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            const box = panelRef.current?.getBoundingClientRect();
            const size = { width: Math.max(0.15, Math.min(1, (panelSize?.width ?? (box?.width ?? 400) / window.innerWidth) + (event.key === 'ArrowRight' ? 0.03 : event.key === 'ArrowLeft' ? -0.03 : 0))), height: Math.max(0.15, Math.min(1, (panelSize?.height ?? (box?.height ?? 300) / window.innerHeight) + (event.key === 'ArrowDown' ? 0.03 : event.key === 'ArrowUp' ? -0.03 : 0))) };
            setPanelSize(size); void saveCollaborationPanel({ size }, initialCollaborationGroupId).catch(() => setPreferenceError('浮窗大小保存失败，请重试'));
          }}><span aria-hidden="true">⌟</span></button>}
      </section>
    </>,
    portalTarget,
  );
}

function AutomationTab({ automations, runs, agents, sessions, activeSessionId, loading, loadError, busy, setBusy, setError, setNotice, refresh, onClose }: {
  automations: AgentAutomation[]; runs: AutomationRun[]; agents: AgentLauncherInfo[]; sessions: OrchestrationSession[]; activeSessionId: string | null; busy: string | null;
  loading: boolean; loadError: string | null;
  setBusy: (value: string | null) => void; setError: (value: string | null) => void; setNotice: (value: string | null) => void; refresh: () => Promise<void>; onClose: () => void;
}) {
  const [editing, setEditing] = useState<AgentAutomation | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const runAction = async (key: string, action: () => Promise<unknown>, successMessage: string) => {
    setBusy(key); setError(null); setNotice(null);
    try { await action(); await refresh(); setNotice(successMessage); } catch (error) { setError(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(null); }
  };
  if (showForm) return <AutomationForm key={editing?.id ?? 'new'} agents={agents} sessions={sessions} activeSessionId={activeSessionId} initial={editing} onCancel={() => { setEditing(null); setShowForm(false); setError(null); }} onSaved={async (name, enabled) => { setEditing(null); setShowForm(false); await refresh(); setNotice(editing ? `“${name}”已更新` : enabled ? `“${name}”已创建，将按计划自动运行` : `“${name}”已创建，当前未启用`); }} setError={setError} />;
  return <div className="h-full space-y-4 overflow-y-auto overscroll-y-contain">
    {loadError && <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-[11px] text-destructive">自动任务同步失败：{loadError}<button className={buttonClass} onClick={() => void refresh()}>重新加载</button></div>}
    <div className="flex items-start justify-between gap-4">
      <div>
        <h3 className="text-[13px] font-medium text-foreground">自动任务</h3>
        <p className="mt-1 max-w-xl text-[11px] leading-relaxed text-muted-foreground">定时发送任务，打开运行会话查看输出。</p>
      </div>
      {!showForm && automations.length > 0 && <button className={`${buttonClass} shrink-0 bg-primary text-primary-foreground`} onClick={() => { setEditing(null); setShowForm(true); setNotice(null); }}><Plus size={13} />新建任务</button>}
    </div>
    {loading && <p role="status" className="text-[11px] text-muted-foreground">正在加载自动任务…</p>}
    {!loading && !loadError && automations.length === 0 && <div className="border-y border-border/15 py-8 text-center">
      <CalendarClock size={24} className="mx-auto text-primary" />
      <p className="mt-3 text-[13px] font-medium text-foreground">把重复工作交给 Agent</p>
      <p className="mx-auto mt-1 max-w-sm text-[11px] leading-relaxed text-muted-foreground">写清任务内容，选择运行频率。创建后可以先手动运行一次确认效果。</p>
      <button className={`${buttonClass} mt-4 bg-primary text-primary-foreground`} onClick={() => setShowForm(true)}><Plus size={13} />创建第一个任务</button>
    </div>}
    <div className="space-y-2">
      {automations.map((automation) => {
        const latestRun = runs.filter((run) => run.automationId === automation.id).sort((a, b) => b.startedAt - a.startedAt)[0];
        const agent = agents.find((candidate) => candidate.command === automation.command);
        return (
        <article key={automation.id} className="rounded-xl border border-border/15 bg-surface-2/40 p-3 transition hover:border-border/30">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-[13px] font-medium text-foreground">{automation.name}</span>
                <span className={`rounded-full px-2 py-0.5 text-[9px] ${automation.enabled ? 'bg-primary/10 text-primary' : 'bg-surface-elevated text-muted-foreground'}`}>{automation.enabled ? '已启用' : '已停用'}</span>
                {automation.lastRunStatus && <span className={`text-[10px] ${runStatusClass(automation.lastRunStatus)}`}>{runStatusLabel(automation.lastRunStatus)}</span>}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
                <span className="inline-flex items-center gap-1"><Clock3 size={11} />{scheduleLabel(automation)}</span>
                <span>{automation.enabled && automation.nextRunAt ? `下次 ${formatDateTime(automation.nextRunAt)}` : '不会自动运行'}</span>
              </div>
              <p className="mt-1 truncate text-[10px] text-muted-foreground">{automation.targetSessionId ? `发送到 ${sessions.find((session) => session.sessionId === automation.targetSessionId)?.name ?? '指定会话'}` : `新建 ${agent?.displayName ?? 'Agent'} 会话 · ${automation.cwd}`}</p>
              <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-foreground/80">{automation.prompt}</p>
              {automation.lastRunAt && <p className="mt-2 text-[10px] text-muted-foreground">上次 {formatDateTime(automation.lastRunAt)}{automation.lastRunMessage ? ` · ${automation.lastRunMessage}` : ''}</p>}
            </div>
            <button aria-label={`编辑 ${automation.name}`} title="编辑" className="rounded-lg p-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground" onClick={() => { setEditing(automation); setShowForm(true); setNotice(null); }}><Pencil size={13} /></button>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-border/10 pt-3">
            {confirmDeleteId === automation.id ? <>
              <span className="mr-auto text-[10px] text-destructive">删除后不会再自动运行</span>
              <button className={`${buttonClass} bg-surface-elevated text-foreground`} onClick={() => setConfirmDeleteId(null)}>取消</button>
              <button disabled={busy !== null} className={`${buttonClass} bg-destructive text-destructive-foreground`} onClick={() => void runAction(`delete:${automation.id}`, () => removeAgentAutomation(automation.id), `“${automation.name}”已删除`).then(() => setConfirmDeleteId(null))}>{busy === `delete:${automation.id}` ? <RefreshCw size={13} className="animate-spin" /> : <Trash2 size={13} />}确认删除</button>
            </> : <>
              <button className={`${buttonClass} mr-auto px-2 text-destructive hover:bg-destructive/10`} onClick={() => setConfirmDeleteId(automation.id)}><Trash2 size={13} />删除</button>
              <button
                disabled={busy !== null}
                className={`${buttonClass} ${automation.enabled ? 'bg-surface-elevated text-foreground' : 'bg-primary/15 text-primary'}`}
                onClick={() => void runAction(
                  `toggle:${automation.id}`,
                  () => setAgentAutomationEnabled(automation.id, !automation.enabled),
                  automation.enabled ? `“${automation.name}”已暂停，不会自动运行` : `“${automation.name}”已恢复，将按原计划运行`,
                )}
              >
                {busy === `toggle:${automation.id}` ? <RefreshCw size={13} className="animate-spin" /> : automation.enabled ? <Pause size={13} /> : <Play size={13} />}
                {automation.enabled ? '暂停' : '恢复'}
              </button>
              {latestRun?.frontendSessionId && <button className={`${buttonClass} bg-surface-elevated text-foreground`} onClick={() => { window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: latestRun.frontendSessionId })); onClose(); }}><ExternalLink size={13} />打开上次会话</button>}
              <button disabled={busy !== null} className={`${buttonClass} bg-primary/15 text-primary`} onClick={() => void runAction(`run:${automation.id}`, () => runAgentAutomation(automation.id), `“${automation.name}”已投递，可打开会话查看进度`)}>{busy === `run:${automation.id}` ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} />}立即运行</button>
            </>}
          </div>
        </article>
        );
      })}
    </div>
  </div>;
}

function AutomationForm({ agents, sessions, activeSessionId, initial, onCancel, onSaved, setError }: {
  agents: AgentLauncherInfo[]; sessions: OrchestrationSession[]; activeSessionId: string | null; initial: AgentAutomation | null; onCancel: () => void; onSaved: (name: string, enabled: boolean) => Promise<void>; setError: (value: string | null) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const activeSession = sessions.find((session) => session.sessionId === activeSessionId);
  const suggestedCwd = initial?.cwd ?? activeSession?.cwd ?? sessions[0]?.cwd ?? '';
  const [cwd, setCwd] = useState(suggestedCwd);
  const cwdEdited = useRef(false);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [selectedAgentSlug, setSelectedAgentSlug] = useState(() => agents.find((agent) => agent.command === initial?.command)?.slug ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [targetSessionId, setTargetSessionId] = useState(initial?.targetSessionId ?? '');
  const [targetMode, setTargetMode] = useState<'new' | 'existing'>(initial?.targetSessionId ? 'existing' : 'new');
  const [kind, setKind] = useState<'interval' | 'daily'>(initial?.schedule.kind ?? 'interval');
  const [everyMinutes, setEveryMinutes] = useState(initial?.schedule.kind === 'interval' ? initial.schedule.everyMinutes : 60);
  const [time, setTime] = useState(initial?.schedule.kind === 'daily' ? initial.schedule.time : '09:00');
  const [weekdays, setWeekdays] = useState<number[]>(initial?.schedule.kind === 'daily' ? initial.schedule.weekdays : [1, 2, 3, 4, 5]);
  const [customSchedule, setCustomSchedule] = useState(() => initial?.schedule.kind === 'interval'
    ? ![15, 60, 1440].includes(initial.schedule.everyMinutes)
    : !!initial && !['1,2,3,4,5', '0,1,2,3,4,5,6'].includes([...initial.schedule.weekdays].sort().join()));
  const [showSettings, setShowSettings] = useState(false);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const selectedAgent = agents.find((agent) => agent.slug === selectedAgentSlug) ?? null;
  const command = selectedAgent?.command ?? initial?.command ?? '';
  useEffect(() => {
    if (!selectedAgentSlug) {
      const agent = initial ? agents.find(agent => agent.command === initial.command) : agents[0];
      if (agent) setSelectedAgentSlug(agent.slug);
    }
  }, [agents, initial, selectedAgentSlug]);
  useEffect(() => {
    if (!initial && !cwdEdited.current && suggestedCwd) setCwd(suggestedCwd);
  }, [initial, suggestedCwd]);
  const taskName = name.trim() || Array.from(prompt.trim().split('\n')[0].trim()).slice(0, 40).join('');
  const targetSession = sessions.find(session => session.sessionId === targetSessionId);
  const schedulePreset = customSchedule ? `custom-${kind}` : kind === 'interval' ? String(everyMinutes) : weekdays.length === 7 ? 'daily' : 'workdays';
  const changeSchedulePreset = (value: string) => {
    setCustomSchedule(value.startsWith('custom-'));
    if (['15', '60', '1440', 'custom-interval'].includes(value)) {
      setKind('interval');
      if (value !== 'custom-interval') setEveryMinutes(Number(value));
    } else {
      setKind('daily');
      if (value === 'daily') setWeekdays([0, 1, 2, 3, 4, 5, 6]);
      if (value === 'workdays') setWeekdays([1, 2, 3, 4, 5]);
    }
  };
  const submit = async () => {
    if (saving || !canSave) return;
    setSaving(true); setError(null);
    try {
      await saveAgentAutomation({ id: initial?.id, name: taskName, cwd, command: targetMode === 'new' ? command : '', prompt, targetSessionId: targetMode === 'existing' ? targetSessionId || null : null, enabled, schedule: kind === 'interval' ? { kind, everyMinutes } : { kind, time, weekdays } });
      await onSaved(taskName, enabled);
    } catch (error) { setError(error instanceof Error ? error.message : '保存失败'); }
    finally { setSaving(false); }
  };
  const schedule = kind === 'interval' ? { kind, everyMinutes } as const : { kind, time, weekdays } as const;
  const [hours, minutes] = time.split(':');
  const setTimePart = (nextHours: string, nextMinutes: string) => setTime(`${nextHours}:${nextMinutes}`);
  const missing = !prompt.trim() ? '请填写任务内容'
    : targetMode === 'existing' && !sessions.some(session => session.sessionId === targetSessionId) ? '请选择当前服务的可用会话'
      : targetMode === 'new' && !command ? '请选择可启动的 Agent'
        : kind === 'interval' && (!Number.isInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > 43200) ? '间隔需要是 1–43200 分钟的整数'
          : kind === 'daily' && !weekdays.length ? '至少选择一天' : '';
  const canSave = !missing;
  return <div className="flex h-full min-h-0 flex-col overflow-hidden">
    <div className="flex shrink-0 items-center justify-between gap-3 pb-3">
      <h3 className="text-[13px] font-medium text-foreground">{initial ? '编辑自动任务' : '创建自动任务'}</h3>
      <button disabled={saving} className="rounded-lg p-2 text-muted-foreground hover:bg-surface-2 hover:text-foreground disabled:opacity-40" onClick={onCancel} aria-label="关闭任务表单"><X size={14} /></button>
    </div>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-y-contain pb-4">
      <fieldset disabled={saving} className="min-w-0 space-y-4">
        <label className="block space-y-1.5 text-[11px] text-muted-foreground">
          任务内容
          <textarea autoFocus className={`${inputClass} min-h-24 resize-y`} rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：检查当前项目的待办，整理需要我处理的问题。" />
        </label>
        <div className="space-y-2">
          <label className="block space-y-1.5 text-[11px] text-muted-foreground">
            运行频率
            <select className={inputClass} value={schedulePreset} onChange={(event) => changeSchedulePreset(event.target.value)}>
              <option value="15">每 15 分钟</option>
              <option value="60">每小时</option>
              <option value="1440">每 24 小时</option>
              <option value="daily">每天定时</option>
              <option value="workdays">工作日定时</option>
              <option value="custom-interval">自定义间隔</option>
              <option value="custom-daily">自定义星期</option>
            </select>
          </label>
          {kind === 'interval' && customSchedule && <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            每隔多少分钟
            <input className={`${inputClass} min-w-0 flex-1`} type="number" min={1} max={43200} value={everyMinutes} onChange={(event) => setEveryMinutes(Number(event.target.value))} />
          </label>}
          {kind === 'daily' && <div className="space-y-2">
            <div className="flex items-center rounded-lg border border-border/20 bg-surface-2 px-3 py-1.5 focus-within:border-primary/60">
              <Clock3 size={14} className="mr-2 shrink-0 text-primary" />
              <TimePartSelect label="小时" value={hours} options={24} onChange={(value) => setTimePart(value, minutes)} />
              <span aria-hidden="true" className="px-2 text-[16px] text-muted-foreground">:</span>
              <TimePartSelect label="分钟" value={minutes} options={60} onChange={(value) => setTimePart(hours, value)} />
              <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">24 小时制</span>
            </div>
            {customSchedule && <div className="grid grid-cols-7 gap-1">{['日', '一', '二', '三', '四', '五', '六'].map((label, day) => {
              const selected = weekdays.includes(day);
              return <button key={day} type="button" aria-pressed={selected} aria-label={`星期${label}`} className={`rounded-lg py-2.5 text-[11px] transition ${selected ? 'bg-primary text-primary-foreground' : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated'}`} onClick={() => setWeekdays((current) => selected ? current.filter((value) => value !== day) : [...current, day].sort())}>{label}</button>;
            })}</div>}
            {weekdays.length === 0 && <p className="text-[10px] text-destructive">至少选择一天</p>}
          </div>}
        </div>
        <div className="space-y-1 text-[11px] text-muted-foreground">
          <p className="flex items-center gap-1.5"><Bot size={13} className="shrink-0" />{targetMode === 'new' ? `每次新建会话 · ${selectedAgent?.displayName ?? (initial?.command ? '原 Agent' : '暂无可用 Agent')}` : `发送到现有会话 · ${targetSession?.name ?? '目标会话不可用'}`}</p>
          <p className="break-all pl-[19px] text-[10px]">{targetMode === 'new' ? cwd || '默认使用当前目录' : '直接写入终端，目标会话需保持在线'}</p>
        </div>
        <div className="border-t border-border/15 pt-2">
          <button type="button" aria-expanded={showSettings} aria-controls="automation-more-settings" className={`${buttonClass} -ml-2 px-2 text-muted-foreground hover:bg-surface-2 hover:text-foreground`} onClick={() => setShowSettings(value => !value)}>
            <ChevronDown size={13} className={`transition-transform ${showSettings ? 'rotate-180' : ''}`} />更多设置
          </button>
          {showSettings && <div id="automation-more-settings" className="space-y-3 pt-2">
            <label className="block space-y-1 text-[10px] text-muted-foreground">任务名称（可选）<input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} placeholder={taskName || '留空则从任务内容自动生成'} /></label>
            <label className="block space-y-1 text-[10px] text-muted-foreground">运行方式
              <select className={inputClass} value={targetMode} onChange={(event) => {
                const mode = event.target.value as 'new' | 'existing';
                setTargetMode(mode);
                if (mode === 'existing' && !targetSessionId) setTargetSessionId(activeSession?.sessionId ?? sessions[0]?.sessionId ?? '');
              }}>
                <option value="new">每次新建会话</option>
                <option value="existing" disabled={sessions.length === 0}>发送到现有会话</option>
              </select>
            </label>
            {targetMode === 'new' ? <>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="min-w-0 space-y-1 text-[10px] text-muted-foreground">Agent / Plugin
                  <select className={inputClass} value={selectedAgentSlug} onChange={(event) => setSelectedAgentSlug(event.target.value)}>
                    {initial && !agents.some((agent) => agent.command === initial.command) && <option value="">原 Agent 当前不可用</option>}
                    {agents.map((agent) => <option key={agent.slug} value={agent.slug}>{agent.displayName}{agent.isPlugin ? ' · Plugin' : ''}</option>)}
                  </select>
                </label>
                <label className="min-w-0 space-y-1 text-[10px] text-muted-foreground">工作目录
                  <div className="flex gap-2"><input className={`${inputClass} min-w-0`} value={cwd} onChange={(event) => { cwdEdited.current = true; setCwd(event.target.value); }} placeholder="默认使用当前目录" /><button type="button" aria-haspopup="dialog" className={`${buttonClass} shrink-0 bg-surface-2 text-foreground`} onClick={() => setDirectoryPickerOpen(true)}><FolderOpen size={13} />选择</button></div>
                </label>
              </div>
              {agents.length === 0 && <p className="text-[10px] text-destructive">没有检测到可启动的 Agent。请先在 Plugin 设置中安装或配置 Agent。</p>}
            </> : <label className="block space-y-1 text-[10px] text-muted-foreground">目标会话
              <select className={inputClass} value={targetSessionId} onChange={(event) => setTargetSessionId(event.target.value)}>
                {!targetSession && <option value={targetSessionId}>{targetSessionId ? '原目标会话不可用，请重新选择' : '请选择会话'}</option>}
                {sessions.map((session) => <option key={session.sessionId} value={session.sessionId}>{session.name} · {collaborationSessionStatus(session)}</option>)}
              </select>
              <span className="block leading-relaxed">仅支持当前服务的会话。运行时会直接写入终端，请确保目标会话保持在线。</span>
            </label>}
            <label className="flex items-center gap-2 text-[11px] text-foreground"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />保存后启用</label>
          </div>}
        </div>
      </fieldset>
    </div>
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border/15 pt-3">
      <p role="status" className="mr-auto min-w-0 flex-[1_1_160px] text-[10px] text-muted-foreground">{missing || (enabled ? `${initial ? '下次运行' : '首次运行'}：${formatDateTime(nextScheduledAt(schedule, Date.now(), initial?.createdAt))}` : '保存后暂停，不会自动运行')}</p>
      <button disabled={saving} className={`${buttonClass} bg-surface-2 text-foreground`} onClick={onCancel}>取消</button>
      <button title={missing || undefined} disabled={saving || !canSave} className={`${buttonClass} bg-primary text-primary-foreground`} onClick={() => void submit()}>{saving ? '保存中…' : initial ? '保存修改' : '创建任务'}</button>
    </div>
    <DirectoryPickerDialog
      open={directoryPickerOpen}
      initialPath={cwd || suggestedCwd || '/'}
      title="选择工作目录"
      labels={{ hint: '进入文件夹，确认后才会更改工作目录。', cancel: '取消', confirm: '使用此目录', close: '关闭', parent: '上一级目录' }}
      onCancel={() => setDirectoryPickerOpen(false)}
      onConfirm={(path) => { cwdEdited.current = true; setCwd(path); setDirectoryPickerOpen(false); }}
    />
  </div>;
}

function TimePartSelect({ label, value, options, onChange }: { label: string; value: string; options: number; onChange: (value: string) => void }) {
  return <label className="relative min-w-0 flex-1"><span className="sr-only">{label}</span><select aria-label={label} className="w-full appearance-none bg-transparent py-1 pl-1 pr-7 text-center text-[18px] font-semibold tabular-nums text-foreground outline-none" value={value} onChange={(event) => onChange(event.target.value)}>{Array.from({ length: options }, (_, index) => { const option = String(index).padStart(2, '0'); return <option key={option} value={option}>{option}</option>; })}</select><ChevronDown aria-hidden="true" size={13} className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground" /></label>;
}

export function CollaborationTab({ fullWorkspace = false, active, notice, initialDrafts, onDraftChange, docked, inputKeySuffix, selectedGroupId, setSelectedGroupId, floatingVisible, floating, sessionsState, groups, sessions, agents, activeSessionId, initialGroupId, onOpenSession, onOpenTaskSession, onEnterGroup, defaultSessionMode, busy, setBusy, setError, setNotice, refresh }: {
  fullWorkspace?: boolean;
  active: boolean;
  notice: string | null;
  onOpenSession: (session: OrchestrationSession) => Promise<void>;
  onOpenTaskSession: (session: OrchestrationSession) => Promise<void>;
  onEnterGroup?: (groupId: string) => Promise<void>;
  selectedGroupId: string | null;
  setSelectedGroupId: (id: string | null) => void;
  floatingVisible: boolean;
  floating: boolean;
  sessionsState: 'loading' | 'loaded' | 'error';
  initialDrafts?: CollaborationPanelState['drafts'];
  docked: boolean;
  inputKeySuffix: string;
  onDraftChange: (groupId: string, draft: { content: string; targets: string[] | null }, origin?: object) => void;
  groups: CollaborationGroup[]; sessions: OrchestrationSession[]; agents: AgentLauncherInfo[]; activeSessionId: string | null; initialGroupId: string | null; defaultSessionMode: 'shell' | 'tmux'; busy: string | null;
  setBusy: (value: string | null) => void; setError: (value: string | null) => void; setNotice: (value: string | null) => void; refresh: () => Promise<void>;
}) {
  const [workspaceView, setWorkspaceView] = useState<'tasks' | 'messages'>('tasks');
  const [taskAttention, setTaskAttention] = useState(0);
  useEffect(() => setTaskAttention(0), [selectedGroupId]);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set<string>());
  const [sessionQuery, setSessionQuery] = useState('');
  const [collapsedServices, setCollapsedServices] = useState<Set<string>>(() => new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteRevision, setDeleteRevision] = useState<number | undefined>();
  const [messages, setMessages] = useState<CollaborationMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const connection = useConnectionRecovery();
  const [responseFilter, setResponseFilter] = useState('all');
  const [onlyNew, setOnlyNew] = useState(false);
  const [seenMessages, setSeenMessages] = useState<Set<string>>(new Set());
  const [targetSessionIds, setTargetSessionIds] = useState<string[] | null>(null);
  const [content, setContent] = useState('');
  const [editingMembers, setEditingMembers] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsContainer = useRef<HTMLDivElement | null>(null);
  const settingsTrigger = useRef<HTMLButtonElement | null>(null);
  const closeSettings = () => {
    setSettingsOpen(false);
    // The hidden board measures as narrow; allow its responsive toolbar to return first.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (settingsTrigger.current?.isConnected && settingsTrigger.current.getClientRects().length) settingsTrigger.current.focus();
      else Array.from(settingsContainer.current?.querySelectorAll<HTMLElement>('button[aria-label="组设置"], button[aria-label="更多看板操作"]') ?? []).find(button => button.getClientRects().length)?.focus();
    }));
  };
  const [confirmRemoveMemberId, setConfirmRemoveMemberId] = useState<string | null>(null);
  const [memberSelection, setMemberSelection] = useState<Set<string>>(new Set());
  const [memberRevision, setMemberRevision] = useState<number | undefined>();
  const [roleDrafts, setRoleDrafts] = useState<Record<string, string>>({});
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [spawnAgentSlug, setSpawnAgentSlug] = useState('');
  const [spawnName, setSpawnName] = useState('');
  const [spawnCwd, setSpawnCwd] = useState('');
  const [spawnTask, setSpawnTask] = useState('');
  const messageComposerRef = useRef<HTMLElement | null>(null);
  const requiresPaneFocus = docked;
  const inputKey = (selectedGroupId ?? groups[0]?.id ?? '') + inputKeySuffix;
  const positionedInitialGroupRef = useRef(false);
  const selectedGroup = selectedGroupId === 'new'
    ? null
    : (selectedGroupId ? groups.find((group) => group.id === selectedGroupId) : groups[0]) ?? null;
  const workspaceMembers = selectedGroup?.sessionIds.flatMap(id => { const session = sessions.find(s => s.sessionId === id); return session ? [session] : []; }) ?? [];
  const [uploadingFiles, setUploadingFiles] = useState(0);
  const drafts = useRef(new Map<string, { content: string; targets: string[] | null }>(Object.entries(initialDrafts ?? {})));
  const [draftOrigin] = useState(() => ({}));
  const groupIdRef = useRef<string | undefined>(undefined);
  const restoringDraft = useRef(false);
  const targetsRef = useRef(targetSessionIds);
  targetsRef.current = targetSessionIds;
  const contentRef = useRef(content);
  contentRef.current = content;
  useLayoutEffect(() => {
    if (groupIdRef.current === selectedGroup?.id) return;
    if (groupIdRef.current) {
      const draft = { content: contentRef.current, targets: targetSessionIds };
      drafts.current.set(groupIdRef.current, draft);
      void saveCollaborationPanel({ drafts: { [groupIdRef.current]: draft } }).catch(() => setError('草稿保存失败，请返回该组重试'));
    }
    groupIdRef.current = selectedGroup?.id;
    restoringDraft.current = true;
    const saved = drafts.current.get(selectedGroup?.id ?? '');
    setContent(saved?.content ?? ''); setTargetSessionIds(saved?.targets ?? null);
  }, [selectedGroup?.id]);
  // A pending row confirmation belongs to one group's roster; switching groups must not carry it over.
  useEffect(() => { setConfirmRemoveMemberId(null); }, [selectedGroup?.id]);
  const pendingDraft = useRef<CollaborationPanelState | null>(null);
  const appliedDrafts = useRef(initialDrafts);
  useLayoutEffect(() => {
    if (appliedDrafts.current === initialDrafts) return;
    appliedDrafts.current = initialDrafts;
    for (const [id, draft] of Object.entries(initialDrafts ?? {})) {
      if (sharedDraftOrigins.get(draft) !== draftOrigin) drafts.current.set(id, draft);
    }
    const incoming = initialDrafts?.[selectedGroup?.id ?? ''];
    if (!incoming || sharedDraftOrigins.get(incoming) === draftOrigin
      || (incoming.content === contentRef.current && JSON.stringify(incoming.targets) === JSON.stringify(targetsRef.current))) return;
    restoringDraft.current = true;
    pendingDraft.current = null;
    setContent(incoming.content);
    setTargetSessionIds(incoming.targets);
  }, [initialDrafts, selectedGroup?.id]);
  const persistDraft = useCallback((patch: CollaborationPanelState) => {
    void saveCollaborationPanel(patch).catch(() => setError('草稿保存失败，请保持面板打开，修改内容后重试'));
  }, [setError]);
  // Share edits before the next input event; a delayed self-echo must not replace newer typing.
  useLayoutEffect(() => {
    if (restoringDraft.current) { restoringDraft.current = false; return; }
    if (!selectedGroup || groupIdRef.current !== selectedGroup.id) return;
    const patch = { drafts: { [selectedGroup.id]: { content, targets: targetSessionIds } } };
    sharedDraftOrigins.set(patch.drafts[selectedGroup.id], draftOrigin);
    onDraftChange(selectedGroup.id, patch.drafts[selectedGroup.id], draftOrigin);
    pendingDraft.current = patch;
    const timer = setTimeout(() => { pendingDraft.current = null; persistDraft(patch); }, 400);
    return () => { clearTimeout(timer); };
  }, [selectedGroup?.id, content, targetSessionIds, persistDraft]);
  useEffect(() => {
    const flush = () => {
      if (pendingDraft.current) { persistDraft(pendingDraft.current); pendingDraft.current = null; }
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => { document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('pagehide', flush); flush(); };
  }, [persistDraft]);
  useEffect(() => {
    if (!(floating || fullWorkspace) || !active || !floatingVisible || !selectedGroup || settingsOpen || workspaceView !== 'messages') return;
    return registerCollaborationInput(text => {
      setWorkspaceView('messages');
      setContent(current => current + (current && !/\s$/.test(current) ? '\n' : '') + text.replace(/\r\n?/g, '\n'));
    }, inputKey, requiresPaneFocus);
  }, [floating, fullWorkspace, active, floatingVisible, selectedGroup?.id, requiresPaneFocus, inputKey, workspaceView, settingsOpen]);
  useEffect(() => {
    const composer = messageComposerRef.current;
    if (!floating || !composer) return;
    const failed = (event: Event) => setError(String((event as CustomEvent).detail));
    composer.addEventListener('termdock:file-drop-error', failed);
    return () => composer.removeEventListener('termdock:file-drop-error', failed);
  }, [floating, selectedGroup?.id, setError]);
  const insertFiles = async (files: File[]) => {
    const groupId = selectedGroup?.id;
    setError(null);
    setUploadingFiles(count => count + 1);
    try {
      const result = await uploadFiles('/tmp', files);
      if (result.files.length !== files.length || result.files.some(file => !file.path)) throw new Error('文件路径准备失败，请重试');
      const text = result.files.map(file => escapeShellPath(file.path)).join(' ') + ' ';
      if (groupIdRef.current === groupId) setContent(current => current + (current && !/\s$/.test(current) ? '\n' : '') + text);
      else if (groupId) {
        const saved = drafts.current.get(groupId) ?? { content: '', targets: null };
        const draft = { ...saved, content: saved.content + '\n' + text };
        drafts.current.set(groupId, draft);
        persistDraft({ drafts: { [groupId]: draft } });
      }
    } catch (error) { setError(error instanceof Error ? error.message : '文件上传失败'); }
    finally { setUploadingFiles(count => count - 1); }
  };
  const availableSessionIds = new Set(sessions.filter(canAddCollaborationSession).map((session) => session.sessionId));
  const selectedCount = selected.size;
  const unavailableSelectedIds = [...selected].filter((id) => !availableSessionIds.has(id));
  const memberOptions = collaborationMemberOptions(selectedGroup, sessions);
  const normalizedSessionQuery = sessionQuery.trim().toLocaleLowerCase();
  const filteredSessions = sessions.filter((session) => !normalizedSessionQuery || [session.name, session.serviceLabel ?? '', session.cwd, friendlyCurrentTask(session.currentTask)]
    .some((value) => value.toLocaleLowerCase().includes(normalizedSessionQuery)));
  const createServiceGroups = groupSessionsByService(filteredSessions);
  const memberServiceGroups = groupSessionsByService(memberOptions);
  const serviceCollapsed = (key: string) => !normalizedSessionQuery && collapsedServices.has(key);
  const toggleServiceCollapsed = (key: string) => setCollapsedServices((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });

  useEffect(() => {
    setEditingMembers(false);
    setSettingsOpen(false);
    setSpawnOpen(false);
    setConfirmDelete(false);
    setRoleDrafts({});
    try { setSeenMessages(new Set(JSON.parse(localStorage.getItem(`collab-seen:${selectedGroup?.id}`) ?? '[]'))); }
    catch { setSeenMessages(new Set()); }
    setMemberSelection(new Set(selectedGroup?.sessionIds ?? []));
  }, [selectedGroup?.id]);

  useEffect(() => {
    if (!spawnAgentSlug && agents[0]) setSpawnAgentSlug(agents[0].slug);
  }, [agents, spawnAgentSlug]);

  useEffect(() => {
    setMessages([]);
    setMessagesError(null);
  }, [selectedGroup?.id]);
  useEffect(() => {
    if (!initialGroupId || !active || (floating && !floatingVisible) || !selectedGroup) { setMessagesLoading(false); return; }
    setMessagesLoading(true);
    let cancelled = false;
    let version = 0;
    let pending = false;
    const load = () => {
      if (cancelled || pending || document.hidden || navigator.onLine === false) return;
      pending = true;
      const current = ++version;
      void listCollaborationMessages(selectedGroup.id)
        .then((data) => { if (!cancelled && current === version) { setMessages(data.messages); setMessagesError(null); } })
        .catch((error) => { if (!cancelled && current === version) setMessagesError(error instanceof Error ? error.message : '消息加载失败'); })
        .finally(() => { pending = false; if (!cancelled && current === version) setMessagesLoading(false); });
    };
    load();
    const timer = window.setInterval(load, 3_000);
    document.addEventListener('visibilitychange', load);
    window.addEventListener(SECURE_READY_EVENT, load);
    window.addEventListener('pageshow', load);
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', load); window.removeEventListener(SECURE_READY_EVENT, load); window.removeEventListener('pageshow', load); };
  }, [selectedGroup?.id, active, floating, floatingVisible]);

  useEffect(() => {
    if (!initialGroupId || selectedGroup?.id !== initialGroupId || positionedInitialGroupRef.current) return;
    positionedInitialGroupRef.current = true;
    if (workspaceView === 'messages') messageComposerRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [initialGroupId, selectedGroup?.id]);

  const createGroup = async () => {
    setBusy('create-group'); setError(null); setNotice(null);
    try {
      if (unavailableSelectedIds.length) throw new Error('所选会话已变化，请先清除不可用选择');
      const result = await saveCollaborationGroup({ name, sessionIds: [...selected] });
      setName(''); setSessionQuery(''); setSelectedGroupId(result.group.id); await refresh();
      setNotice(`“${result.group.name}”已创建，可以添加第一个目标。`);
      if (onEnterGroup) await onEnterGroup(result.group.id);
    } catch (error) { setError(error instanceof Error ? error.message : '创建失败'); }
    finally { setBusy(null); }
  };
  const recipients = selectedGroup?.sessionIds.filter(id => targetSessionIds === null || targetSessionIds.includes(id)) ?? [];
  const send = async () => {
    if (!selectedGroup || busy || uploadingFiles || !content.trim() || !recipients.length) return;
    const sentContent = content;
    const sentGroup = selectedGroup.id;
    setBusy('send-message'); setError(null); setNotice(null);
    try {
      const result = await sendCollaborationMessage(selectedGroup.id, {
        fromSessionId: null,
        toSessionIds: targetSessionIds === null ? undefined : recipients,
        kind: 'message',
        content,
      });
      if (groupIdRef.current === sentGroup) {
        const current = contentRef.current;
        const remaining = current === sentContent ? '' : current.startsWith(sentContent) ? current.slice(sentContent.length).replace(/^\n/, '') : current;
        setContent(remaining);
        persistDraft({ drafts: { [sentGroup]: { content: remaining, targets: targetsRef.current } } });
      }
      else {
        const saved = drafts.current.get(sentGroup);
        if (saved) {
          const draft = { ...saved, content: saved.content === sentContent ? '' : saved.content.startsWith(sentContent) ? saved.content.slice(sentContent.length).replace(/^\n/, '') : saved.content };
          drafts.current.set(sentGroup, draft);
          persistDraft({ drafts: { [sentGroup]: draft } });
        }
      }
      const latest = await listCollaborationMessages(sentGroup).catch(() => null);
      if (latest && groupIdRef.current === sentGroup) setMessages(latest.messages);
      const unavailable = result.deliveries?.filter((delivery) => delivery.serviceUnavailable).length ?? 0;
      const pending = result.deliveries?.filter((delivery) => delivery.pending > 0).length ?? 0;
      setNotice(unavailable > 0 ? `已保存消息；${unavailable} 个接收成员的服务不可达，尚未送达，等待重连`
        : pending > 0 ? `已保存消息；${pending} 个成员等待投递确认` : `消息已送达 ${result.messages.length} 个会话`);
    } catch (error) { setError(error instanceof Error ? error.message : '发送失败'); }
    finally { setBusy(null); }
  };
  const remove = async () => {
    if (!selectedGroup) return;
    setBusy(`delete:${selectedGroup.id}`); setError(null); setNotice(null);
    const removedName = selectedGroup.name;
    try { await removeCollaborationGroup(selectedGroup.id, deleteRevision); setSelectedGroupId(null); setConfirmDelete(false); await refresh(); setNotice(`“${removedName}”已删除`); }
    catch (error) { setError(error instanceof Error ? error.message : '删除失败'); }
    finally { setBusy(null); }
  };
  const saveMembers = async () => {
    if (!selectedGroup) return;
    const sessionIds = [...memberSelection];
    setBusy('save-members'); setError(null); setNotice(null);
    try {
      const result = await saveCollaborationGroup({ id: selectedGroup.id, name: selectedGroup.name, sessionIds, expectedUpdatedAt: memberRevision });
      setSelectedGroupId(result.group.id);
      setEditingMembers(false); await refresh();
      setNotice(`“${selectedGroup.name}”成员已更新，共 ${sessionIds.length} 个会话`);
    } catch (error) { setError(error instanceof Error ? error.message : '成员更新失败'); }
    finally { setBusy(null); }
  };
  // Project spaces and discussions survive member changes.
  const removeMember = async (sessionId: string) => {
    if (!selectedGroup || !selectedGroup.sessionIds.includes(sessionId)) { setConfirmRemoveMemberId(null); return; }
    const memberName = sessions.find((session) => session.sessionId === sessionId)?.name ?? sessionId;
    const groupName = selectedGroup.name;
    setBusy(`remove-member:${sessionId}`); setError(null); setNotice(null);
    try {
      await saveCollaborationGroup({ id: selectedGroup.id, name: groupName,
        sessionIds: selectedGroup.sessionIds.filter((id) => id !== sessionId), expectedUpdatedAt: selectedGroup.updatedAt });
      setConfirmRemoveMemberId(null);
      setMemberSelection((current) => new Set([...current].filter((id) => id !== sessionId)));
      setRoleDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== sessionId)));
      await refresh();
      setNotice(`已把“${memberName}”移出“${groupName}”`);
    } catch (error) { setError(error instanceof Error ? error.message : '移出成员失败'); }
    finally { setBusy(null); }
  };
  const saveMemberRole = async (sessionId: string) => {
    if (!selectedGroup) return;
    const role = roleDrafts[sessionId] ?? '';
    setBusy(`role:${sessionId}`); setError(null); setNotice(null);
    try {
      await setCollaborationMemberRole(selectedGroup.id, sessionId, role.trim() || null);
      await refresh();
      setNotice(role.trim() ? '定位已保存，该成员每次收到消息都会看到' : '定位已清除');
    } catch (error) { setError(error instanceof Error ? error.message : '定位保存失败'); }
    finally { setBusy(null); }
  };
  const openSpawn = () => {
    const suggestedCwd = sessions.find((session) => session.sessionId === activeSessionId)?.cwd
      ?? sessions.find((session) => selectedGroup?.sessionIds.includes(session.sessionId))?.cwd
      ?? '';
    setSpawnCwd(suggestedCwd); setSpawnName(''); setSpawnTask(''); setSpawnOpen(true); setEditingMembers(false);
  };
  const spawnAgent = async () => {
    if (!selectedGroup || !spawnAgentSlug) return;
    setBusy('spawn-agent'); setError(null); setNotice(null);
    try {
      const result = await spawnCollaborationAgent(selectedGroup.id, {
        agentSlug: spawnAgentSlug,
        name: spawnName.trim() || undefined,
        cwd: spawnCwd.trim() || undefined,
        task: spawnTask.trim() || undefined,
        mode: defaultSessionMode,
      });
      setSpawnOpen(false); await refresh();
      setNotice(`“${result.session.name}”已创建并加入“${result.group.name}”`);
    } catch (error) { setError(error instanceof Error ? error.message : 'Agent Session 创建失败'); }
    finally { setBusy(null); }
  };
  const visibleMessages = messages.filter((message) => (!onlyNew || !seenMessages.has(message.id))
    && (responseFilter === 'all' || message.responseKind === responseFilter));
  const activities = collapseCollaborationMessages(visibleMessages, sessions);
  const markVisibleSeen = () => {
    const next = new Set([...seenMessages, ...visibleMessages.map((message) => message.id)].slice(-10_000));
    try { localStorage.setItem(`collab-seen:${selectedGroup?.id}`, JSON.stringify([...next])); }
    catch { setError('无法保存已看记录，请检查浏览器存储空间'); return; }
    setSeenMessages(next);
  };
  const renderSessionOptionRow = (session: OrchestrationSession) => <label key={session.sessionId} className="flex cursor-pointer items-start gap-3 px-2 py-2.5 transition hover:bg-surface-2"><input className="mt-0.5" type="checkbox" disabled={!canAddCollaborationSession(session)} checked={selected.has(session.sessionId)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(session.sessionId)) next.delete(session.sessionId); else next.add(session.sessionId); return next; })} /><span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="truncate text-[12px] text-foreground">{session.name}</span><ServiceBadge session={session} /><span className="shrink-0 text-[9px] text-muted-foreground">{collaborationSessionStatus(session)}</span></span><span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{session.currentTask ? `${friendlyCurrentTask(session.currentTask)} · ${session.cwd}` : session.cwd || session.capability || "终端会话"}</span></span></label>;
  const renderMemberOptionRow = (session: OrchestrationSession) => { const draft = roleDrafts[session.sessionId] ?? ''; const savedRole = selectedGroup?.roles?.[session.sessionId] ?? ''; return <div key={session.sessionId} className="px-2 py-2 transition hover:bg-surface-2"><label className="flex cursor-pointer items-center gap-3"><input type="checkbox" disabled={!selectedGroup?.sessionIds.includes(session.sessionId) && !canAddCollaborationSession(session)} checked={memberSelection.has(session.sessionId)} onChange={() => setMemberSelection((current) => { const next = new Set(current); if (next.has(session.sessionId)) next.delete(session.sessionId); else next.add(session.sessionId); return next; })} /><span className="min-w-0 flex-1"><span className="block truncate text-[11px] text-foreground">{session.name}</span><ServiceBadge session={session} /><span className="block truncate text-[9px] text-muted-foreground">{collaborationSessionStatus(session)} · {session.cwd}</span></span></label><div className="mt-2 flex items-center gap-2 pl-7"><span className="shrink-0 text-[9px] text-muted-foreground">定位</span><input aria-label={`${session.name} 的定位`} className={`${inputClass} min-h-8 py-1 text-[10px]`} value={draft} maxLength={200} placeholder="成员收到的定位；清空后保存可移除" onChange={(event) => setRoleDrafts((current) => ({ ...current, [session.sessionId]: event.target.value }))} /><button aria-label={`保存 ${session.name} 的定位`} title={draft.trim() === savedRole ? '定位未变化' : '保存此成员的定位'} disabled={busy !== null || draft.trim() === savedRole} className={`${buttonClass} min-h-8 shrink-0 px-2 text-muted-foreground`} onClick={() => void saveMemberRole(session.sessionId)}>{busy === `role:${session.sessionId}` ? <RefreshCw size={12} className="animate-spin" /> : <Check size={12} />}</button></div></div>; };

  const workspaceNavigation = <nav aria-label="协作工作区" className="flex shrink-0 items-center gap-1">{([['tasks', fullWorkspace ? '看板' : '目标'], ['messages', '成员与消息']] as const).map(([id, label]) => <button type="button" key={id} aria-label={label} aria-pressed={workspaceView === id} className={`${buttonClass} min-h-11 ${workspaceView === id ? 'bg-surface-2 text-foreground' : 'text-muted-foreground hover:bg-surface-2'}`} onClick={event => {
      const root = event.currentTarget.closest('[data-collaboration-views]');
      const trigger = event.currentTarget;
      setWorkspaceView(id);
      requestAnimationFrame(() => {
        const focused = document.activeElement;
        // A user may already be typing; restoring navigation must not steal that focus.
        if (focused !== trigger && focused !== document.body && focused?.isConnected && !focused.closest('[hidden]')) return;
        Array.from(root?.querySelectorAll<HTMLButtonElement>('nav[aria-label="协作工作区"] button') ?? []).find(node => node.getAttribute('aria-pressed') === 'true' && !node.closest('[hidden]'))?.focus();
      });
    }}>{fullWorkspace && id === 'messages' ? <><span className="sm:hidden">成员</span><span className="hidden sm:inline">{label}</span></> : label}{!fullWorkspace && id === 'tasks' && taskAttention > 0 && <span className="rounded bg-primary/15 px-1.5 text-[11px] text-primary">{taskAttention} 待处理</span>}</button>)}</nav>;
  const workspaceSettings = <button type="button" aria-label="组设置" title="组设置" aria-expanded={settingsOpen} className={`${buttonClass} min-h-11 shrink-0 text-muted-foreground hover:bg-surface-2`} onClick={event => { settingsTrigger.current = event.currentTarget; setSettingsOpen(value => !value); setError(null); setNotice(null); }}><Pencil size={14} />{fullWorkspace && <span className="sm:sr-only">组设置</span>}</button>;
  return <div ref={settingsContainer} className={fullWorkspace ? "flex min-h-0 flex-1 flex-col gap-3" : "space-y-3"}>
    {messagesError && connection === 'ready' && !isConnectionInterruption(messagesError) && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-[11px] text-destructive">消息同步暂时失败，正在自动重试：{messagesError}</p>}
    {messagesError && isConnectionInterruption(messagesError) && !fullWorkspace && <p role="status" className="text-[11px] text-muted-foreground">正在恢复消息同步，现有记录已保留</p>}
    <div className={fullWorkspace ? settingsOpen ? "min-h-0 flex-1 overflow-auto" : "contents" : undefined}>
      {(!initialGroupId || !selectedGroup) && <div className="flex items-center gap-2">
        {groups.length > 0 ? <label className="min-w-0 flex-1"><span className="sr-only">选择协作组</span><select className={inputClass} value={selectedGroup?.id ?? 'new'} onChange={event => setSelectedGroupId(event.target.value)}>
          {!selectedGroup && <option value="new">新建协作组</option>}
          {groups.map(group => <option key={group.id} value={group.id}>{group.name} · {group.sessionIds.length} 个成员</option>)}
        </select></label> : <h3 className="min-w-0 flex-1 text-sm font-medium text-foreground">建立协作组</h3>}
        {selectedGroup && <>
          <button type="button" aria-label="组设置" title="组设置" aria-expanded={settingsOpen} className={`${buttonClass} min-h-11 shrink-0 text-muted-foreground hover:bg-surface-2`} onClick={event => { settingsTrigger.current = event.currentTarget; setSettingsOpen(value => !value); setError(null); setNotice(null); }}><Pencil size={14} /></button>
          <button type="button" aria-label="新建协作组" title="新建协作组" className={`${buttonClass} min-h-11 shrink-0 text-muted-foreground hover:bg-surface-2`} onClick={() => { setSelectedGroupId('new'); setConfirmDelete(false); setNotice(null); }}><Plus size={14} /></button>
        </>}
      </div>}

    {settingsOpen && selectedGroup && <CollaborationGroupSettings key={selectedGroup.id} group={selectedGroup} activeSessionId={activeSessionId} sessions={sessions} busy={busy} setBusy={setBusy} setError={setError} setNotice={setNotice} refresh={refresh} onClose={closeSettings} />}
    {!selectedGroup && <section className="border-y border-border/15 py-4">
      <div className="flex items-start justify-between gap-3"><div><h4 className="text-[12px] font-medium text-foreground">创建协作组</h4><p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">先建立项目或目标空间，再写下目标。开始协作时配置 Agent；也可以复用已有会话。</p></div><span className={`shrink-0 text-[10px] ${selectedCount >= 2 ? 'text-primary' : 'text-muted-foreground'}`}>已选 {selectedCount} 个</span></div>
      <label className="mt-4 block space-y-1 text-[10px] text-muted-foreground">协作组名称<input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：发布准备" /></label>
      <details className="mt-3"><summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">复用已有会话（选填） · 已选 {selectedCount} 个</summary>
      {sessions.length > 5 && <label className="relative mt-3 block"><span className="sr-only">筛选会话</span><Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" /><input className={`${inputClass} pl-8`} value={sessionQuery} onChange={(event) => setSessionQuery(event.target.value)} placeholder="按名称、目录或当前任务筛选" /></label>}
      <div className="mt-3 max-h-64 divide-y divide-border/10 overflow-y-auto border-y border-border/10">
        {createServiceGroups.length <= 1 ? filteredSessions.map(renderSessionOptionRow) : createServiceGroups.map((group) => { const collapsed = serviceCollapsed(group.key); return <div key={group.key}><ServiceGroupHeader label={group.label} count={group.sessions.length} collapsed={collapsed} onToggle={() => toggleServiceCollapsed(group.key)} />{!collapsed && <div className="divide-y divide-border/10">{group.sessions.map(renderSessionOptionRow)}</div>}</div>; })}
        {sessions.length === 0 && <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">{sessionsState === 'loading' ? '正在加载会话…' : sessionsState === 'error' ? '会话加载失败，请重试' : '没有现有会话也可以创建，开始目标时会启动 Agent'}</p>}
        {sessions.length > 0 && filteredSessions.length === 0 && <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">没有符合筛选条件的会话</p>}
      </div>
      </details>
      {unavailableSelectedIds.length > 0 && <div role="alert" className="mt-2 text-[11px] text-destructive">有 {unavailableSelectedIds.length} 个所选会话暂不可用。<button className={buttonClass} onClick={() => setSelected((current) => new Set([...current].filter((id) => availableSessionIds.has(id))))}>清除不可用选择</button></div>}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center"><p className={`min-w-0 flex-1 text-[10px] ${selectedCount < 2 ? 'text-muted-foreground' : 'text-primary'}`}>{!name.trim() ? '请填写协作组名称' : '创建后进入看板，添加第一个目标'}</p><div className="flex justify-end gap-2">{groups.length > 0 && <button className={`${buttonClass} bg-surface-2 text-foreground`} onClick={() => setSelectedGroupId(groups[0]?.id ?? null)}>取消</button>}<button disabled={busy !== null || !name.trim() || unavailableSelectedIds.length > 0} className={`${buttonClass} bg-primary text-primary-foreground`} onClick={() => void createGroup()}>{busy === 'create-group' ? <RefreshCw size={13} className="animate-spin" /> : <Plus size={13} />}创建协作组</button></div></div>
    </section>}

    </div>
    {selectedGroup && !initialGroupId && <div className="space-y-3 py-3"><p className="text-xs leading-relaxed text-muted-foreground">进入工作组看板，查看任务、处理问题和验收交付。</p><button type="button" className={`${buttonClass} min-h-11 bg-primary text-primary-foreground`} onClick={() => void onEnterGroup?.(selectedGroup.id).catch(error => setError(error instanceof Error ? error.message : '无法打开协作区'))}>打开 {selectedGroup.name}</button></div>}
    {selectedGroup && initialGroupId && <div data-collaboration-views hidden={settingsOpen} className={fullWorkspace ? `${settingsOpen ? "hidden" : "flex"} min-h-0 flex-1 flex-col gap-3` : "space-y-3"}>
      {(!fullWorkspace || workspaceView === 'messages') && <div className="flex shrink-0 items-center gap-1 border-b border-border/15 pb-2">{workspaceNavigation}<div className="ml-auto">{workspaceSettings}</div></div>}
      {workspaceView === 'messages' && <div className="flex gap-1 overflow-x-auto" aria-label="工作组终端">{workspaceMembers.map(session => <button type="button" key={session.sessionId} aria-pressed={session.sessionId === activeSessionId} title={`${session.name} · ${session.cwd || '终端会话'}`} className={`${buttonClass} min-h-9 shrink-0 ${session.sessionId === activeSessionId ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-surface-2'}`} onClick={() => void onOpenTaskSession(session).catch(error => setError(error instanceof Error ? error.message : '无法打开终端'))}>{collaborationMemberLabel(session, workspaceMembers)}</button>)}</div>}
      <div hidden={workspaceView !== 'tasks'} className={fullWorkspace ? `${workspaceView === 'tasks' ? "flex" : "hidden"} min-h-0 flex-1 flex-col` : undefined}><CollaborationTaskWorkbench paneKey={docked ? inputKey : undefined} boardNavigation={fullWorkspace ? workspaceNavigation : undefined} boardSettings={fullWorkspace ? workspaceSettings : undefined} board={fullWorkspace} key={selectedGroup.id} group={selectedGroup} sessions={sessions} agents={agents} defaultCwd={sessions.find(session => session.sessionId === activeSessionId)?.cwd ?? undefined} onTeamReady={refresh} active={active && !settingsOpen && workspaceView === 'tasks' && (!floating || floatingVisible)} onAttentionChange={setTaskAttention} onManageMembers={() => setWorkspaceView('messages')} onOpenSession={onOpenTaskSession} /></div>
      <div hidden={workspaceView !== 'messages'} className={fullWorkspace ? "min-h-0 flex-1 overflow-auto" : undefined}>
      <section onFocusCapture={() => focusCollaborationInput(inputKey)} onPointerDownCapture={() => focusCollaborationInput(inputKey)} data-termdock-terminal-dropzone={floating ? activeSessionId ?? "collaboration-composer" : undefined} onDragOver={event => { if (floating) event.preventDefault(); }} onDrop={event => {
        if (!floating) return;
        const files = Array.from(event.dataTransfer.files);
        if (files.length && getTermdockDesktopBridge()) return;
        event.preventDefault(); event.stopPropagation();
        if (files.length) void insertFiles(files);
        else { const text = event.dataTransfer.getData("text/plain") || event.dataTransfer.getData("text/uri-list"); if (text) setContent(current => current + (current ? "\n" : "") + text); }
      }} ref={messageComposerRef} className={floating ? '' : 'rounded-xl border border-primary/20 bg-primary/5 px-3 py-3'}>{!floating && <h4 className="truncate text-[12px] font-medium text-foreground">{selectedGroup.name} · 发送给成员</h4>}<div className={floating ? 'space-y-2' : 'mt-2 space-y-2'}>
          <fieldset className="min-w-0"><legend className="mb-1 text-[10px] text-muted-foreground">接收人（可多选）</legend><div className="flex flex-wrap gap-1">
            {[{ id: '*', label: '全组成员' }, ...selectedGroup.sessionIds.map(id => ({ id, label: (() => { const member = workspaceMembers.find(session => session.sessionId === id); return member ? collaborationMemberLabel(member, workspaceMembers) : undefined; })() ?? `${id.slice(0, 8)}（离线）` }))].map(({ id, label }) => {
              const selected = id === '*' ? targetSessionIds === null : targetSessionIds?.includes(id) ?? false;
              const session = sessions.find(session => session.sessionId === id);
              return <span key={id} className="inline-flex max-w-full items-center gap-0.5">
                <button type="button" aria-pressed={selected} onClick={() => setTargetSessionIds(current => id === '*' ? null : current?.includes(id) ? current.filter(target => target !== id) : [...(current ?? []), id])} className={`${choiceClass} min-h-9 min-w-0 gap-1 sm:min-h-7 ${selected ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border/20 bg-surface-2 text-muted-foreground hover:text-foreground'}`}>{selected && <Check size={12} aria-hidden="true" className="shrink-0" />}<span className="break-words text-left">{label}</span></button>
                {session && <button type="button" aria-label={`打开 ${label} 的终端`} title={`打开 ${label} 的终端`} className="inline-flex h-9 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-primary sm:h-7 sm:w-6" onClick={() => void onOpenSession(session).catch(error => setError(error instanceof Error ? error.message : '无法打开会话'))}><ExternalLink size={12} /></button>}
              </span>;
            })}
          </div></fieldset>
        </div>
        <label className="mt-2 block space-y-1 text-[9px] text-muted-foreground">内容<textarea onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault(); void send();
          }
        }} onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); void insertFiles(files); } }} className={`${inputClass} min-h-16 max-h-48 resize-y`} value={content} onChange={(event) => setContent(event.target.value)} placeholder="输入消息，可粘贴引用或文件…" /></label>
        <div className="mt-2 flex items-center justify-between gap-3"><p role="status" aria-live="polite" title={floating && notice ? notice : undefined} className={`min-w-0 flex-1 text-[9px] leading-relaxed ${floating ? 'truncate' : ''} ${floating && notice ? 'text-primary' : 'text-muted-foreground'}`}>{uploadingFiles > 0 ? '正在准备文件路径…' : floating && notice ? notice : selectedGroup.federated ? '消息由服务端后台投递，可查看送达结果；无需保持客户端在线。' : '在线成员立即入队；离线成员上线后送达。'}</p><button disabled={busy !== null || uploadingFiles > 0 || !content.trim() || !recipients.length} className={`${buttonClass} shrink-0 bg-primary text-primary-foreground`} title="发送（⌘ / Ctrl + Enter）" onClick={() => void send()}>{busy === 'send-message' ? <RefreshCw size={13} className="animate-spin" /> : null}发送</button></div>
      </section>
      <div>
      <details key={selectedGroup.id} className="mt-4 rounded-xl border border-border/15"><summary className="cursor-pointer px-3 py-3 text-[11px] font-medium text-foreground">管理成员、角色与删除 · {selectedGroup.sessionIds.length} 个成员</summary>
      <section className="border-t border-border/15 p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0"><h4 className="text-[13px] font-medium text-foreground">{selectedGroup.name}</h4><p className="mt-1 text-[10px] text-muted-foreground">{selectedGroup.sessionIds.length} 个成员 · 组 ID：<span className="break-all font-mono">{shortId(selectedGroup.id)}</span></p></div>
          {confirmDelete ? <div className="flex flex-wrap items-center gap-1 sm:justify-end"><button className={`${buttonClass} bg-surface-2 px-2 text-foreground`} onClick={() => setConfirmDelete(false)}>取消</button><button disabled={busy !== null} className={`${buttonClass} bg-destructive px-2 text-destructive-foreground`} onClick={() => void remove()}>{busy === `delete:${selectedGroup.id}` ? <RefreshCw size={13} className="animate-spin" /> : null}确认删除</button></div> : <div className="flex flex-wrap items-center gap-1 sm:justify-end"><button className={`${buttonClass} px-2 text-muted-foreground hover:bg-surface-2 hover:text-foreground`} onClick={() => { setMemberSelection(new Set(selectedGroup.sessionIds)); setMemberRevision(selectedGroup.updatedAt); const next = !editingMembers; setEditingMembers(next); if (next) setRoleDrafts(Object.fromEntries(selectedGroup.sessionIds.map((id) => [id, selectedGroup.roles?.[id] ?? '']))); setSpawnOpen(false); }}><Pencil size={13} />管理成员</button><button className={`${buttonClass} px-2 text-primary hover:bg-primary/10`} onClick={openSpawn}><Plus size={13} />新建 Agent</button><button aria-label={`删除协作组 ${selectedGroup.name}`} title="删除协作组" disabled={busy !== null} className="rounded-lg p-2 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive" onClick={() => { setDeleteRevision(selectedGroup.updatedAt); setConfirmDelete(true); }}><Trash2 size={14} /></button></div>}
        </div>
        {confirmDelete && <p role="alert" className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-[10px] leading-relaxed text-destructive">将删除“{selectedGroup.name}”协作组及其协作记录，{selectedGroup.sessionIds.length} 个成员的终端会话会保留。</p>}
        <div className="mt-3 grid divide-y divide-border/10 border-y border-border/10 sm:grid-cols-2 sm:divide-x sm:divide-y-0">{selectedGroup.sessionIds.map((id) => { const session = sessions.find((candidate) => candidate.sessionId === id); const role = selectedGroup.roles?.[id]; const memberName = session?.name ?? id; return <div key={id} className={`flex min-w-0 items-stretch transition ${confirmRemoveMemberId === id ? 'bg-destructive/5' : 'hover:bg-surface-2'}`}><button disabled={!session} onClick={() => session && void onOpenSession(session).catch((error) => setError(error instanceof Error ? error.message : '无法打开会话'))} className="min-w-0 flex-1 px-3 py-2.5 text-left disabled:cursor-default"><span className="flex items-center gap-2"><span className={`h-2 w-2 shrink-0 rounded-full ${session && ['ready', 'shell', 'terminal-connected', 'service-reachable', 'working', 'idle', 'done'].includes(session.status) && session.serviceConnected !== false ? 'bg-[var(--success)]' : 'bg-muted-foreground'}`} /><span className="truncate text-[11px] text-foreground">{memberName}</span>{session && <ServiceBadge session={session} />}<span className="ml-auto shrink-0 text-[9px] text-muted-foreground">{session ? collaborationSessionStatus(session) : '已离线'}</span></span><span className="mt-1 flex min-w-0 items-center gap-1 text-[9px] text-muted-foreground">{role ? <><span className="min-w-0 truncate font-medium text-primary/80">定位:{role}</span><span className="shrink-0 text-muted-foreground/50">·</span></> : null}{session ? <span className="min-w-0 truncate">{friendlyCurrentTask(session.currentTask)}</span> : <span className="shrink-0">重新上线后可继续接收消息</span>}</span></button><button aria-label={`把 ${memberName} 移出协作组`} aria-expanded={confirmRemoveMemberId === id} title="移出协作组" disabled={busy !== null} className={`mr-1 shrink-0 self-center rounded-lg p-2 transition ${confirmRemoveMemberId === id ? 'text-destructive' : 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive'}`} onClick={() => setConfirmRemoveMemberId(confirmRemoveMemberId === id ? null : id)}><Trash2 size={13} /></button></div>; })}</div>
        {confirmRemoveMemberId && selectedGroup.sessionIds.includes(confirmRemoveMemberId) && (() => { const memberName = sessions.find((session) => session.sessionId === confirmRemoveMemberId)?.name ?? confirmRemoveMemberId; const pending = busy === `remove-member:${confirmRemoveMemberId}`; return <div role="group" aria-label={`确认移除成员 ${memberName}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-y border-destructive/25 bg-destructive/5 px-3 py-2.5"><p className="min-w-0 flex-1 text-[10px] leading-relaxed text-destructive">{`把“${memberName}”移出“${selectedGroup.name}”？移出后它不再收到这个组的消息，可以随时重新加入`}</p><div className="flex shrink-0 gap-2"><button className={`${buttonClass} min-h-8 bg-surface-2 px-2 text-[10px] text-foreground`} onClick={() => setConfirmRemoveMemberId(null)}>取消</button><button disabled={busy !== null} className={`${buttonClass} min-h-8 px-2 text-[10px] bg-destructive text-destructive-foreground`} onClick={() => void removeMember(confirmRemoveMemberId)}>{pending ? <RefreshCw size={12} className="animate-spin" /> : <Trash2 size={12} />}移出</button></div></div>; })()}
        {editingMembers && <div className="mt-4 border-t border-border/15 pt-4"><div className="flex items-start justify-between gap-3"><div><h5 className="text-[11px] font-medium text-foreground">管理成员</h5><p className="mt-1 text-[9px] text-muted-foreground">暂不可用的原成员会保留，只有取消勾选才会移出；定位（角色）在每行独立保存，成员收到消息时会看到自己的定位。</p></div><span className="text-[9px] text-muted-foreground">已选 {memberSelection.size}</span></div><div className="mt-3 max-h-72 divide-y divide-border/10 overflow-y-auto border-y border-border/10">{memberServiceGroups.length <= 1 ? memberOptions.map(renderMemberOptionRow) : memberServiceGroups.map((group) => { const collapsed = serviceCollapsed(group.key); return <div key={group.key}><ServiceGroupHeader label={group.label} count={group.sessions.length} collapsed={collapsed} onToggle={() => toggleServiceCollapsed(group.key)} />{!collapsed && <div className="divide-y divide-border/10">{group.sessions.map(renderMemberOptionRow)}</div>}</div>; })}</div><div className="mt-3 flex justify-end gap-2"><button className={`${buttonClass} bg-surface-2 text-foreground`} onClick={() => { setEditingMembers(false); setRoleDrafts({}); }}>取消</button><button disabled={busy !== null || sessionsState !== 'loaded'} className={`${buttonClass} bg-primary text-primary-foreground`} onClick={() => void saveMembers()}>{busy === 'save-members' ? <RefreshCw size={13} className="animate-spin" /> : <Check size={13} />}保存成员</button></div></div>}
        {spawnOpen && <div className="mt-4 border-t border-primary/20 pt-4"><div><h5 className="text-[11px] font-medium text-foreground">创建 Agent Session</h5><p className="mt-1 text-[9px] text-muted-foreground">新会话启动后自动加入本组，并收到初始任务和成员信息。</p></div><div className="mt-3 grid gap-2 sm:grid-cols-2"><label className="space-y-1 text-[9px] text-muted-foreground">Agent / Plugin<select aria-label="新 Agent 类型" className={inputClass} value={spawnAgentSlug} onChange={(event) => setSpawnAgentSlug(event.target.value)}>{agents.map((agent) => <option key={agent.slug} value={agent.slug}>{agent.displayName}{agent.isPlugin ? ' · Plugin' : ''}</option>)}</select></label><label className="space-y-1 text-[9px] text-muted-foreground">会话名称<input aria-label="新 Agent 会话名称" className={inputClass} value={spawnName} onChange={(event) => setSpawnName(event.target.value)} placeholder="留空则自动命名" /></label></div><label className="mt-2 block space-y-1 text-[9px] text-muted-foreground">工作目录<input aria-label="新 Agent 工作目录" className={inputClass} value={spawnCwd} onChange={(event) => setSpawnCwd(event.target.value)} placeholder="默认继承当前会话" /></label><label className="mt-2 block space-y-1 text-[9px] text-muted-foreground">初始任务<textarea aria-label="新 Agent 初始任务" className={`${inputClass} min-h-16 resize-y`} value={spawnTask} onChange={(event) => setSpawnTask(event.target.value)} placeholder="说明它加入后要先完成什么" /></label><div className="mt-3 flex justify-end gap-2"><button className={`${buttonClass} bg-surface-2 text-foreground`} onClick={() => setSpawnOpen(false)}>取消</button><button disabled={busy !== null || !spawnAgentSlug} className={`${buttonClass} bg-primary text-primary-foreground`} onClick={() => void spawnAgent()}>{busy === 'spawn-agent' ? <RefreshCw size={13} className="animate-spin" /> : <Bot size={13} />}创建并加入</button></div></div>}
      </section></details>

      <section className="mt-4"><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h4 className="text-[11px] font-medium text-foreground">协作记录</h4><span className="text-[9px] text-muted-foreground">{activities.length} 条</span></div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <select aria-label="筛选回复类型" className={`${inputClass} w-auto`} value={responseFilter} onChange={(event) => setResponseFilter(event.target.value)}><option value="all">全部类型</option><option value="ack">收到确认</option><option value="progress">进展</option><option value="result">结果与证据</option></select>
          <label className="flex min-h-9 items-center gap-2 text-[11px] text-muted-foreground"><input type="checkbox" checked={onlyNew} onChange={(event) => setOnlyNew(event.target.checked)} />只看新记录</label>
          <button className={`${buttonClass} min-h-9 text-muted-foreground`} disabled={!visibleMessages.length} onClick={markVisibleSeen}>标记当前记录已看</button>
        </div><div className="divide-y divide-border/10 border-y border-border/10 [overflow-wrap:anywhere]">
        {activities.map((activity) => <div key={activity.key} className="px-2 py-3"><div className="flex items-center gap-2 text-[9px] text-muted-foreground"><span className="font-medium text-primary">{activity.responseKind === 'ack' ? '收到确认' : activity.responseKind === 'progress' ? '进展' : activity.responseKind === 'result' ? '结果' : messageKindLabel(activity.kind)}</span><span>{activity.fromName}</span><span>→</span><span className="truncate">{activity.toNames.join('、')}</span><span className="ml-auto shrink-0">{new Date(activity.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div><p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-foreground">{activity.content}</p><p className="mt-1 text-[9px] text-muted-foreground">{activity.status === 'pending' ? '已入队 · 等待投递' : activity.status === 'failed' ? '投递失败' : activity.status === 'expired' ? '消息已过期，未继续投递' : '已写入接收方终端 · 等待接手确认'}</p>
          {(activity.task || activity.failureReason) && <details className="mt-2 text-[10px] text-muted-foreground"><summary className="cursor-pointer">任务详情与证据</summary><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(activity.task ?? { failure_reason: activity.failureReason }, null, 2)}</pre></details>}
        </div>)}
        {activities.length === 0 && <Empty text={messagesLoading ? "正在加载协作记录…" : messages.length ? "没有符合筛选条件的新记录。可切换类型或取消“只看新记录”。" : "还没有消息。可以先发一个任务或问题。"} />}
      </div></section>

      </div>

      </div>
    </div>}
  </div>;
}

function CollaborationGroupSettings({ group, activeSessionId, sessions, busy, setBusy, setError, setNotice, refresh, onClose }: {
  group: CollaborationGroup; activeSessionId: string | null; sessions: OrchestrationSession[]; busy: string | null;
  setBusy: (value: string | null) => void; setError: (value: string | null) => void; setNotice: (value: string | null) => void;
  refresh: () => Promise<void>; onClose: () => void;
}) {
  const localMembers = sessions.filter(session => group.sessionIds.includes(session.sessionId) && !remoteSessionAddress(session.sessionId));
  const [draft, setDraft] = useState(() => readGroupSettingsDraft(group, activeSessionId && localMembers.some(session => session.sessionId === activeSessionId) ? activeSessionId : ''));
  const draftRef = useRef(draft);
  const [latest, setLatest] = useState<CollaborationGroup | null>(null);
  const updateDraft = (patch: Partial<GroupSettingsDraft>) => {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    writeGroupSettingsDraft(group.id, next);
    setDraft(next);
  };
  const { name, rules, savedName, savedRules, rulesVersion, rulesMemberId } = draft;
  const dirty = groupSettingsDirty(draft);
  const rulesBytes = new TextEncoder().encode(rules).length;
  const canEditRules = localMembers.some(session => session.sessionId === rulesMemberId);
  const rename = async () => {
    if (busy || !name.trim()) return;
    setBusy('group-name'); setError(null); setNotice(null);
    try {
      const result = await saveCollaborationGroup({ id: group.id, name: name.trim(), sessionIds: draft.sessionIds ?? group.sessionIds, expectedUpdatedAt: draft.updatedAt });
      setLatest(null);
      updateDraft({ savedName: result.group.name, name: result.group.name, updatedAt: result.group.updatedAt, sessionIds: result.group.sessionIds,
        ...(rules === savedRules ? { rules: result.group.instructions?.text ?? '', savedRules: result.group.instructions?.text ?? '', rulesVersion: result.group.instructions?.version ?? '' } : {}) });
      await refresh(); setNotice('协作组名称已更新');
    } catch (error) { setLatest(null); setError(error instanceof TerminalApiError && error.status === 409 ? '组设置已被其他人修改。请查看最新状态并确认，名称与群规草稿仍保留。' : error instanceof Error ? error.message : '改名失败'); }
    finally { setBusy(null); }
  };
  const saveRules = async () => {
    if (busy || !canEditRules || rulesBytes > 8192) return;
    setBusy('group-rules'); setError(null); setNotice(null);
    try {
      const result = await setCollaborationGroupRules(group.id, { sessionId: rulesMemberId, text: rules, expectedVersion: rulesVersion });
      setLatest(null);
      updateDraft({ savedName: result.group.name, ...(name === savedName ? { name: result.group.name } : {}),
        updatedAt: result.group.updatedAt, sessionIds: result.group.sessionIds, rules: result.group.instructions?.text ?? '', savedRules: result.group.instructions?.text ?? '', rulesVersion: result.group.instructions?.version ?? '' });
      await refresh(); setNotice(rules.trim() ? '群规已保存，变更通知已入队' : '群规已清空，变更通知已入队');
    } catch (error) { setLatest(null); setError(error instanceof TerminalApiError && error.status === 409 ? '群规已被其他人修改。请查看最新状态并确认，名称与群规草稿仍保留。' : error instanceof Error ? error.message : '群规保存失败'); }
    finally { setBusy(null); }
  };
  const reload = () => {
    updateDraft(freshGroupSettingsDraft(group, rulesMemberId)); setLatest(null); setError(null);
  };
  const reviewLatest = async () => {
    if (busy) return;
    setBusy('group-latest'); setError(null); setNotice(null); setLatest(null);
    try {
      const current = await listCollaborationGroups();
      const found = current.groups.find(item => item.id === group.id);
      if (!found) throw new Error('协作组已删除；草稿仍保留，请返回看板查看。');
      setLatest(found);
    } catch (error) { setError(error instanceof Error ? error.message : '最新状态读取失败；草稿仍保留，请重试。'); }
    finally { setBusy(null); }
  };
  return <section aria-label="协作组设置" onKeyDown={event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.preventDefault(); event.stopPropagation();
    if (!busy) onClose();
  }} className="mt-3 rounded-xl border border-border/20 bg-surface-2 p-3">
    <div className="mb-3 flex items-center justify-between gap-2"><h4 className="text-[12px] font-medium text-foreground">组设置</h4><button type="button" disabled={Boolean(busy)} aria-label="关闭组设置" className="rounded-lg p-2 text-muted-foreground hover:bg-surface-elevated" onClick={onClose}><X size={14} /></button></div>
    <label className="block space-y-1 text-[10px] text-muted-foreground">协作组名称<input autoFocus className={inputClass} value={name} maxLength={240} disabled={Boolean(busy)} onChange={event => updateDraft({ name: event.target.value })} /></label>
    <div className="mt-2 flex justify-end"><button type="button" disabled={Boolean(busy) || Boolean(latest) || !name.trim() || name.trim() === savedName} className={`${buttonClass} min-h-9 bg-primary text-primary-foreground`} onClick={() => void rename()}>{busy === 'group-name' ? '保存中…' : '保存名称'}</button></div>
    <div className="mt-3 space-y-2 border-t border-border/15 pt-3"><label className="block space-y-1 text-[10px] text-muted-foreground">由本组成员发布群规变更<select className={inputClass} value={rulesMemberId} disabled={Boolean(busy) || !localMembers.length} onChange={event => updateDraft({ rulesMemberId: event.target.value })}><option value="">选择当前服务的一个成员</option>{!localMembers.some(session => session.sessionId === rulesMemberId) && rulesMemberId && <option value={rulesMemberId}>原成员已不在组内，请重新选择</option>}{localMembers.map(session => <option key={session.sessionId} value={session.sessionId}>{session.name}</option>)}</select></label><label className="block space-y-1 text-[10px] text-muted-foreground">群规与协作约定<textarea className={`${inputClass} min-h-24 resize-y`} value={rules} maxLength={8192} disabled={Boolean(busy)} onChange={event => updateDraft({ rules: event.target.value })} placeholder="例如：说明分工、交接要求和结果格式。清空后保存可移除群规。" /></label></div>
    {!canEditRules && <p className="mt-1 text-[10px] text-muted-foreground">{localMembers.length ? '选择发布变更的成员后即可保存，不需要关闭工作台。' : '当前服务没有本组成员，请先添加成员或切换到成员所在的服务。已有群规可在此查看。'}</p>}
    <div className="mt-2 flex items-center justify-between gap-2"><p className={`text-[9px] ${rulesBytes > 8192 ? 'text-destructive' : 'text-muted-foreground'}`}>{rulesBytes > 8192 ? '内容过长，请缩短群规' : '保存或清空群规会通知本组其他成员'}</p><button type="button" disabled={Boolean(busy) || Boolean(latest) || !canEditRules || rulesBytes > 8192 || rules === savedRules} className={`${buttonClass} min-h-9 shrink-0 bg-primary text-primary-foreground`} onClick={() => void saveRules()}>{busy === 'group-rules' ? '保存中…' : rules.trim() ? '保存群规' : '清空群规'}</button></div>
    {dirty && <p role="status" className="mt-3 text-[11px] leading-5 text-muted-foreground">有未保存修改。关闭、Escape 或切换组后，草稿仍保留在本标签页；名称与群规需分别保存。</p>}
    {dirty && <button type="button" disabled={Boolean(busy)} className={`${buttonClass} mt-2 min-h-11 text-primary hover:bg-surface-elevated`} onClick={() => void reviewLatest()}>{busy === 'group-latest' ? '读取中…' : '查看最新状态并保留草稿'}</button>}
    {latest && <section aria-label="最新组设置" className="mt-3 space-y-2 rounded-lg bg-surface p-3 text-[11px] leading-5">
      <p className="font-medium text-foreground">确认最新状态后，再分别保存草稿</p>
      <p className="break-words text-muted-foreground">当前名称：{latest.name}</p>
      <p className="whitespace-pre-wrap break-words text-muted-foreground">当前群规：{latest.instructions?.text || '未设置'}</p>
      <p className="break-words text-muted-foreground">当前成员（{latest.sessionIds.length}）：{latest.sessionIds.map(id => sessions.find(item => item.sessionId === id)?.name ?? shortId(id)).join('、') || '暂无成员'}</p>
      <p className="text-muted-foreground">保留你的未保存内容；名称保存将保留以上成员，群规保存会通知当前成员。再次发生修改时仍会检查冲突。</p>
      <div className="flex flex-wrap gap-2"><button type="button" disabled={Boolean(busy)} className={`${buttonClass} min-h-11 bg-primary text-primary-foreground`} onClick={() => { updateDraft(rebaseGroupSettingsDraft(draftRef.current, latest)); setLatest(null); setError(null); setNotice('已确认最新状态，草稿仍保留；请分别保存名称与群规。'); }}>确认最新状态，保留草稿</button><button type="button" className={`${buttonClass} min-h-11 text-muted-foreground`} onClick={() => setLatest(null)}>取消确认</button></div>
    </section>}
    <div className="mt-3 flex justify-between gap-2 border-t border-border/15 pt-2"><button type="button" disabled={Boolean(busy)} className={`${buttonClass} min-h-9 text-muted-foreground hover:bg-surface-elevated`} onClick={reload}><RefreshCw size={12} />重新载入{dirty && '（放弃草稿）'}</button><button type="button" disabled={Boolean(busy)} className={`${buttonClass} min-h-9 bg-surface text-foreground`} onClick={onClose}>{dirty ? '关闭并保留草稿' : '关闭'}</button></div>
  </section>;
}

function CollaborationServiceManager({ peers, currentGroupId, busy, setBusy, setError, setNotice, onSelectGroup }: {
  peers: CollaborationPeerState; currentGroupId?: string; busy: string | null;
  setBusy: (value: string | null) => void; setError: (value: string | null) => void; setNotice: (value: string | null) => void;
  onSelectGroup: (id: string) => void;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const services = peers.services ?? [];
  const removed = peers.removedServices ?? [];
  const disconnected = services.filter(service => !service.connected);
  const affected = disconnected.some(service => service.groups?.some(group => group.id === currentGroupId));
  const act = async (id: string, restore: boolean) => {
    if (busy) return;
    setBusy(`peer:${id}`); setError(null); setNotice(null);
    try {
      if (restore) await restoreCollaborationConnection(id); else await removeCollaborationConnection(id);
      setConfirmId(null);
      setShowRemoved(false);
      setNotice(restore ? '协作连接已恢复，正在连接服务' : '协作连接已移除，不会再自动重连；已有会话和消息保留');
    } catch (error) { setError(error instanceof Error ? error.message : restore ? '重新连接失败' : '移除连接失败'); }
    finally { setBusy(null); }
  };
  return <details className="mt-4 shrink-0 rounded-lg border border-border/15" key={affected ? 'affected' : 'other'} open={affected || undefined}>
    <summary className="cursor-pointer px-3 py-2.5 text-[11px] text-muted-foreground"><span className="font-medium text-foreground">协作连接与管理</span><span className="ml-2">{peers.state === 'loading' ? '正在加载…' : `${services.length - disconnected.length} 个已连接${disconnected.length ? ` · ${disconnected.length} 个离线` : ''}`}</span></summary>
    <div className="max-h-64 overflow-y-auto border-t border-border/15 px-3 py-2">
      {services.length > 0 && <p className="mb-1 text-[10px] leading-relaxed text-muted-foreground">与以下服务进行跨服务协作，名称与服务切换器一致。</p>}
      {disconnected.length > 0 && <p className="mb-2 text-[10px] leading-relaxed text-muted-foreground">{affected ? '当前协作组的部分服务不可达，消息会保留并等待重连。' : '其他服务暂时离线；当前服务内的协作可以继续。不再使用的连接可移除。'}</p>}
      {peers.error && <p role="status" className="mb-2 break-words text-[10px] text-destructive">{peers.error}</p>}
      {peers.state === 'unsupported' && <p className="mb-2 text-[10px] text-muted-foreground">请更新客户端以管理跨服务连接。</p>}
      <div className="divide-y divide-border/10">{services.map(service => <div key={service.serviceId || service.origin} className="py-2.5">
        <div className="flex items-start gap-2"><div className="min-w-0 flex-1"><p className="text-[11px] text-foreground">{collaborationServiceLabel({ serviceLabel: service.label, serviceOrigin: service.origin })}<span className={`ml-2 text-[9px] ${service.connected ? 'text-[var(--success)]' : 'text-muted-foreground'}`}>{service.connected ? '已连接' : service.error === 'CONNECTING' ? '连接中' : '暂时离线'}</span></p><CollaborationConnectionDetails service={service} /></div>{service.serviceId && <button type="button" disabled={Boolean(busy)} aria-label={`移除协作连接 ${service.origin}`} className={`${buttonClass} min-h-9 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive`} onClick={() => setConfirmId(confirmId === service.serviceId ? null : service.serviceId!)}><Trash2 size={12} />移除</button>}</div>
        {Boolean(service.groups?.length) && <div className="mt-1 flex flex-wrap items-center gap-1 text-[9px] text-muted-foreground"><span>用于</span>{service.groups!.map(group => <button type="button" key={group.id} className="rounded px-1.5 py-1 text-primary hover:bg-primary/10" onClick={() => onSelectGroup(group.id)}>{group.name}</button>)}</div>}
        {!service.connected && service.error && service.error !== 'CONNECTING' && <details className="mt-1 text-[9px] text-muted-foreground"><summary className="cursor-pointer">{collaborationConnectionError(service.error)}</summary><p className="mt-1 select-text break-words">{service.error}</p></details>}
        {confirmId === service.serviceId && <div role="group" aria-label="确认移除协作连接" className="mt-2 rounded-lg bg-surface-2 p-2.5"><p className="text-[10px] leading-relaxed text-foreground">{service.groups?.length ? `请先处理上方协作组的成员，再移除这条连接。` : '移除后停止与该服务协作，保留已有会话和消息；以后可重新连接。'}</p><div className="mt-2 flex justify-end gap-2"><button type="button" disabled={Boolean(busy)} className={`${buttonClass} min-h-9 text-muted-foreground`} onClick={() => setConfirmId(null)}>取消</button><button type="button" disabled={Boolean(busy) || Boolean(service.groups?.length)} className={`${buttonClass} min-h-9 bg-destructive text-destructive-foreground`} onClick={() => void act(service.serviceId!, false)}>{busy === `peer:${service.serviceId}` ? '正在移除…' : '确认移除'}</button></div></div>}
      </div>)}</div>
      {services.length === 0 && peers.state === 'ready' && <p className="py-2 text-[10px] text-muted-foreground">当前没有其他协作服务，当前服务内仍可创建协作组。</p>}
      {disconnected.length > 0 && <button type="button" className={`${buttonClass} mt-1 min-h-9 text-primary hover:bg-primary/10`} onClick={retryCollaborationPeers}><RefreshCw size={12} />重试连接</button>}
      {removed.length > 0 && <div className="mt-2 border-t border-border/15 pt-1"><button type="button" aria-expanded={showRemoved} className={`${buttonClass} min-h-9 text-muted-foreground hover:bg-surface-2`} onClick={() => setShowRemoved(value => !value)}>{showRemoved ? '收起恢复列表' : '恢复已移除连接'}</button>{showRemoved && <section aria-label="恢复已移除连接" className="mt-1 rounded-lg bg-surface-2 px-2.5 py-2"><p className="text-[10px] leading-relaxed text-muted-foreground">以下是恢复记录，连接已停用，不会自动重连。点击恢复后才会重新启用协作。</p><div className="mt-1 divide-y divide-border/10">{removed.map(service => <div key={service.serviceId || service.origin} className="flex items-start gap-2 py-2"><div className="min-w-0 flex-1"><p className="break-words text-[10px] text-foreground">{collaborationServiceLabel({ serviceLabel: service.label, serviceOrigin: service.origin })}<span className="ml-2 text-[9px] text-muted-foreground">已停用</span></p><p className="mt-0.5 select-text break-all text-[9px] text-muted-foreground">{service.accessUrl || service.origin}</p></div><button type="button" disabled={Boolean(busy) || !service.serviceId} className={`${buttonClass} min-h-9 shrink-0 text-primary hover:bg-primary/10`} onClick={() => void act(service.serviceId!, true)}>{busy === `peer:${service.serviceId}` ? '恢复中…' : '恢复连接'}</button></div>)}</div></section>}</div>}
    </div>
  </details>;
}

function CollaborationConnectionDetails({ service }: { service: CollaborationPeerService }) {
  let loopback = false;
  try { loopback = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(service.origin).hostname); } catch { /* Keep malformed addresses available for diagnosis. */ }
  const address = service.accessUrl || (loopback ? '' : service.origin);
  return <details className="mt-1 text-[9px] text-muted-foreground">
    <summary className="w-fit cursor-pointer py-1">连接详情</summary>
    <dl className="mt-1 space-y-1 select-text break-all">
      <div><dt className="inline">服务地址：</dt><dd className="inline">{address || '暂未获取，请在服务切换器中查看'}</dd></div>
      {service.serviceId && <div><dt className="inline">服务身份：</dt><dd className="inline">{service.serviceId}</dd></div>}
    </dl>
  </details>;
}

function canAddCollaborationSession(session: OrchestrationSession): boolean {
  return !remoteSessionAddress(session.sessionId) || session.serviceConnected !== false;
}

function sessionServiceKey(session: OrchestrationSession): string {
  if (session.serviceOrigin) return session.serviceOrigin === window.location.origin ? '' : session.serviceOrigin;
  return remoteSessionAddress(session.sessionId)?.origin ?? '';
}

function groupSessionsByService(sessions: OrchestrationSession[]): { key: string; label: string; sessions: OrchestrationSession[] }[] {
  const groups = new Map<string, { key: string; label: string; sessions: OrchestrationSession[] }>();
  for (const session of sessions) {
    const key = sessionServiceKey(session);
    const group = groups.get(key) ?? { key, label: key ? collaborationServiceLabel(session) : '本机服务', sessions: [] };
    if (key && group.label === '远端服务') group.label = collaborationServiceLabel(session);
    group.sessions.push(session);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => (a.key ? 1 : 0) - (b.key ? 1 : 0) || a.label.localeCompare(b.label));
}

function ServiceGroupHeader({ label, count, collapsed, onToggle }: { label: string; count: number; collapsed: boolean; onToggle: () => void }) {
  return <button type="button" aria-expanded={!collapsed} onClick={onToggle} className="flex w-full items-center gap-1.5 bg-surface-2/50 px-2 py-1.5 text-left text-muted-foreground transition hover:bg-surface-elevated">
    <ChevronDown size={12} className={`shrink-0 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
    <span className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-wide">{label}</span>
    <span className="shrink-0 text-[9px] text-muted-foreground/70">{count}</span>
  </button>;
}

export function collaborationMemberOptions(group: CollaborationGroup | null, sessions: OrchestrationSession[]): OrchestrationSession[] {
  const options = new Map(sessions.map((session) => [session.sessionId, session]));
  for (const id of group?.sessionIds ?? []) {
    if (options.has(id)) continue;
    const saved = group?.remoteSessions?.find((session) => session.sessionId === id);
    options.set(id, saved ? { ...saved, status: 'offline', serviceConnected: false } : {
      sessionId: id, name: id, backendSessionId: null, cwd: '', agent: null,
      status: 'offline', capability: '', currentTask: '暂不可用，保留成员身份', updatedAt: 0,
      ...(remoteSessionAddress(id) ? { serviceConnected: false } : {}),
    });
  }
  return [...options.values()];
}

function ServiceBadge({ session }: { session: OrchestrationSession }) {
  if (!session.serviceOrigin || session.serviceOrigin === window.location.origin) return null;
  return <span className="inline-flex max-w-28 shrink-0 items-center gap-1 rounded border border-border/20 px-1 py-0.5 text-[9px] text-muted-foreground">
    <ExternalLink size={9} /><span className="truncate">{collaborationServiceLabel(session)}</span>
  </span>;
}

function collaborationSessionStatus(session: OrchestrationSession): string {
  if (session.serviceConnected === false) return '服务不可达';
  // Older peer services use "recovering" for a route they never checked.
  if (session.status === 'recovering' && session.route_error === 'ROUTE_NOT_CHECKED') return '投递目标未检查';
  return humanSessionStatus(session.status);
}

function collaborationSessionName(session?: OrchestrationSession, peers: OrchestrationSession[] = []): string | undefined {
  if (!session) return undefined;
  const duplicate = peers.some(peer => peer.sessionId !== session.sessionId && peer.name.trim() === session.name.trim());
  const alias = session.sessionId.startsWith('remote:') ? collaborationServiceLabel(session) : '本机服务';
  return duplicate ? `${session.name} · ${alias}` : session.name;
}

export async function openCollaborationSession(session: OrchestrationSession): Promise<void> {
  if (session.sessionId.startsWith('remote:')) {
    await openRemoteSession(session.sessionId);
  } else window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: session.sessionId }));
}

function humanSessionStatus(status: OrchestrationSession['status']): string {
  const labels: Record<string, string> = {
    ready: '终端可达', shell: 'Shell 终端', recovering: '正在检查投递目标',
    unchecked: '投递目标未检查', 'terminal-connected': '终端已连接',
    detached: '终端未连接', 'agent-exited': 'Agent 已退出', offline: '已离线',
    ambiguous: '需确认目标终端', 'identity-mismatch': '终端身份已变化',
    unavailable: '终端暂不可达', 'service-reachable': '服务可达', 'service-unreachable': '服务不可达',
  };
  return labels[status] ?? '在线';
}

function friendlyCurrentTask(currentTask: string | null | undefined): string {
  if (!currentTask) return '暂无任务摘要';
  try {
    const parsed = JSON.parse(currentTask) as { prompt?: unknown };
    if (typeof parsed.prompt === 'string') return cleanSessionSnippet(parsed.prompt) || '暂无任务摘要';
  } catch { /* Ordinary task text is not JSON. */ }
  return cleanSessionSnippet(currentTask) || '暂无任务摘要';
}

function messageKindLabel(kind: CollaborationMessageKind): string {
  return ({ message: '消息', ask: '问题', reply: '回复', task: '任务', handoff: '交接', done: '完成' } as const)[kind];
}

function collapseCollaborationMessages(messages: CollaborationMessage[], sessions: OrchestrationSession[]) {
  const sessionsById = new Map(sessions.map((session) => [session.sessionId, collaborationSessionName(session, sessions)!]));
  const grouped = new Map<string, {
    key: string; kind: CollaborationMessageKind; content: string; createdAt: number;
    fromName: string; toNames: string[]; status: CollaborationMessage['status']; responseKind?: CollaborationMessage['responseKind']; task?: CollaborationMessage['task']; failureReason?: string | null;
  }>();
  for (const message of messages) {
    const key = `${message.threadId}:${message.createdAt}:${message.fromSessionId ?? 'user'}:${message.kind}:${message.responseKind ?? ''}:${JSON.stringify(message.task ?? null)}:${message.content}`;
    const existing = grouped.get(key);
    const recipient = sessionsById.get(message.toSessionId) ?? message.toSessionId.slice(0, 8);
    if (existing) {
      existing.toNames.push(recipient);
      const rank = { failed: -2, expired: -1, pending: 0, delivered: 1, read: 2 } as const;
      if (rank[message.status] < rank[existing.status]) existing.status = message.status;
      continue;
    }
    grouped.set(key, {
      key, kind: message.kind, content: message.content, createdAt: message.createdAt,
      fromName: message.fromSessionId ? sessionsById.get(message.fromSessionId) ?? message.fromSessionId.slice(0, 8) : '你',
      toNames: [recipient], status: message.status, responseKind: message.responseKind, task: message.task, failureReason: message.failureReason,
    });
  }
  return [...grouped.values()].sort((a, b) => b.createdAt - a.createdAt);
}

function collaborationConnectionError(error: string): string {
  if (/timeout|timed out|超时|operation was aborted/i.test(error)) return '连接超时，暂时无法访问该服务。请确认远端服务已启动，并检查网络或 VPN 连接。';
  if (/ECONNREFUSED|connection refused/i.test(error)) return '远端拒绝连接，请确认服务已启动且端口正确。';
  if (/ENOTFOUND|EHOSTUNREACH|ENETUNREACH/i.test(error)) return '无法访问远端地址，请检查地址和网络连接。';
  if (/certificate|fingerprint|TLS|证书/i.test(error)) return '远端证书校验失败，请检查服务连接授权。';
  return '服务连接暂时不可用，可查看连接详情并重试。';
}

function HighlightedSearchText({ value, query }: { value: string; query: string }) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return <>{value}</>;
  const lower = value.toLocaleLowerCase();
  const parts = [];
  let cursor = 0;
  let position: number;
  while ((position = lower.indexOf(needle, cursor)) >= 0) {
    parts.push(value.slice(cursor, position));
    parts.push(<mark key={position} className="rounded bg-primary/15 text-primary">{value.slice(position, position + needle.length)}</mark>);
    cursor = position + needle.length;
  }
  parts.push(value.slice(cursor));
  return <>{parts}</>;
}

function SearchTab({ active, onClose, onNewSession, setError }: { active: boolean; onClose: () => void; onNewSession: AgentOperationsPanelProps['onNewSession']; setError: (value: string | null) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SessionSearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [index, setIndex] = useState<SessionSearchResponse['index']>();
  const [limit, setLimit] = useState(50);
  const [refresh, setRefresh] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestVersion = useRef(0);
  useEffect(() => { if (active) inputRef.current?.focus({ preventScroll: true }); }, [active]);
  useEffect(() => {
    if (!active) return;
    const version = ++requestVersion.current;
    const controller = new AbortController();
    let timer: number;
    setSearchError(null);
    setSearching(true);
    const run = async () => {
      try {
        const data = await searchTerminalSessions(query.trim(), limit, controller.signal);
        if (version !== requestVersion.current) return;
        setResults(data.results);
        setTotal(data.total ?? data.results.length);
        setIndex(data.index);
        if (data.index?.building) timer = window.setTimeout(() => void run(), 2500);
      } catch (error) {
        if (version === requestVersion.current && !controller.signal.aborted) setSearchError(error instanceof Error ? error.message : '搜索失败');
      } finally { if (version === requestVersion.current) setSearching(false); }
    };
    timer = window.setTimeout(() => void run(), query.trim() ? 250 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); ++requestVersion.current; };
  }, [active, query, limit, refresh]);
  const changeQuery = (value: string) => {
    setError(null);
    setQuery(value);
    setResults([]);
    setTotal(0);
    setLimit(50);
  };
  const open = async (result: SessionSearchResult) => {
    if (opening) return;
    if (result.live) { window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: result.sessionId })); onClose(); return; }
    if (!result.nativeKey && !result.resumeHistoryId) return;
    setOpening(result.sessionId);
    setError(null);
    try {
      const prepared = result.nativeKey ? await prepareSearchSession(result.nativeKey) : await prepareAgentResumeHistory(result.resumeHistoryId!);
      if ('sessionId' in prepared && prepared.sessionId) window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: prepared.sessionId }));
      else if (prepared.command) onNewSession({ mode: 'shell', cwd: prepared.cwd, command: prepared.command });
      else throw new Error('这条会话暂时无法恢复，请重新搜索');
      onClose();
    } catch (error) { setError(error instanceof Error ? error.message : '恢复失败'); }
    finally { setOpening(null); }
  };
  return <div className="space-y-4">
    <div className="sticky -top-4 z-20 -mx-4 -mt-4 border-b border-border/15 bg-surface px-4 py-3">
      <div><h3 className="text-[13px] font-medium text-foreground">历史会话搜索</h3><p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">搜索当前服务的 Codex、Claude 历史对话和 Termdock 终端记录，未启动的会话也能找到并恢复。</p></div>
      <label className="relative mt-3 block"><span className="sr-only">搜索历史会话</span><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" /><input ref={inputRef} maxLength={512} className={`${inputClass} pl-9 pr-9`} value={query} onChange={(event) => changeQuery(event.target.value)} placeholder="搜索会话名称、对话关键词、目录或 session ID" />{searching ? <RefreshCw size={13} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground" /> : query && <button type="button" aria-label="清空搜索" className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground hover:bg-surface-2 hover:text-foreground" onClick={() => changeQuery('')}><X size={13} /></button>}</label>
      {index?.building && <div role="status" className="mt-2 text-[10px] text-muted-foreground">正在建立历史索引：{index.indexed}/{index.total} 个会话。可以先搜名称和目录，对话结果会自动补齐。</div>}
      {index?.warning && <p role="status" className="mt-2 text-[10px] text-destructive">{index.warning}</p>}
      {Boolean(index?.failed) && <p role="status" className="mt-2 text-[10px] text-destructive">{index!.failed} 个会话暂未完成索引，其余结果可正常使用。请稍后刷新重试。</p>}
    </div>
    <div className="flex items-center justify-between gap-3"><p className="text-[11px] text-foreground">{query.trim() ? `找到 ${total} 个会话` : '最近的会话'}{total > results.length ? ` · 显示 ${results.length} 个` : ''}</p><button type="button" disabled={searching} className={`${buttonClass} text-muted-foreground hover:bg-surface-2 hover:text-foreground`} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={12} />刷新</button></div>
    {!query.trim() && <p className="text-[10px] text-muted-foreground">记得之前讨论过什么？输入一句话中的关键词，就能找到对应会话。历史对话与索引保存在当前服务机器上。</p>}
    <div className="divide-y divide-border/10 border-y border-border/10">{results.map((result) => {
      const canOpen = result.live || Boolean(result.nativeKey || result.resumeHistoryId);
      const action = opening === result.sessionId ? '正在恢复…' : result.live ? '打开会话' : canOpen ? '恢复会话' : '仅供查阅';
      const snippet = result.source === 'codex' || result.source === 'claude' ? result.snippet : searchResultSnippet(result);
      const source = result.source === 'codex' ? 'Codex 历史' : result.source === 'claude' ? 'Claude 历史' : '终端记录';
      const content = <><div className="flex items-start gap-3"><div className="min-w-0 flex-1"><p className="break-words text-[12px] font-medium text-foreground"><HighlightedSearchText value={result.title} query={query} /></p><p className="mt-0.5 break-all text-[9px] text-muted-foreground"><HighlightedSearchText value={result.cwd || '项目目录待索引'} query={query} /></p></div><span className={`shrink-0 text-[10px] ${result.live ? 'text-[var(--success)]' : canOpen ? 'text-primary' : 'text-muted-foreground'}`}>{action}</span></div>{snippet && <p className="mt-2 line-clamp-3 break-words text-[10px] leading-relaxed text-foreground/75"><HighlightedSearchText value={snippet} query={query} /></p>}<p className="mt-2 text-[9px] text-muted-foreground">{source} · {formatDateTime(result.updatedAt)}{query.trim() ? ` · ${result.matchCount >= 999 ? '999+' : result.matchCount} 处匹配` : ''}{!canOpen ? ' · 没有可恢复记录' : ''}</p>{result.agentNativeSessionId && <p className="mt-1 select-text break-all text-[9px] text-muted-foreground">{result.agentNativeSessionId}</p>}</>;
      return canOpen
        ? <button key={result.nativeKey || result.sessionId} disabled={Boolean(opening)} onClick={() => void open(result)} className="block w-full px-2 py-3 text-left transition hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none">{content}</button>
        : <article key={result.sessionId} className="px-2 py-3">{content}</article>;
    })}</div>
    {total > results.length && limit < 5000 && <button type="button" disabled={searching} className={`${buttonClass} w-full bg-surface-2 text-foreground`} onClick={() => setLimit(value => value + 50)}>{searching ? '正在加载…' : '加载更多会话'}</button>}
    {searchError && <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-[11px] text-destructive">搜索失败：{searchError}<button type="button" className={`${buttonClass} ml-2`} onClick={() => setRefresh(value => value + 1)}>重试</button></div>}
    {!searching && !searchError && results.length === 0 && <div className="border-y border-border/15 py-8 text-center"><p className="text-[12px] text-foreground">{index?.building ? '历史对话仍在索引，请稍候' : index?.warning || index?.failed ? '暂未找到结果，部分历史记录尚不可搜索' : query.trim() ? `没有找到“${query.trim()}”` : '当前服务还没有可搜索的历史会话'}</p><p className="mt-1 text-[10px] text-muted-foreground">{index?.building ? '新结果会自动显示，也可以先搜会话名称或目录。' : '可尝试更短的关键词、项目目录或 session ID；其他机器的历史需切换到对应服务搜索。'}</p>{query.trim() && <button className={`${buttonClass} mt-3 bg-surface-2 text-foreground`} onClick={() => changeQuery('')}>查看最近会话</button>}</div>}
  </div>;
}

export function cleanSessionSnippet(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, ' ')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, ' ')
    .replace(/\(B/g, ' ')
    .replace(/<[^>]{1,120}>/g, ' ')
    .replace(/[─━│┃┄┅┆┇┈┉┊┋┌┐└┘├┤┬┴┼╭╮╯╰═║╔╗╚╝╠╣╦╩╬]+/g, ' ')
    .replace(/([^\p{L}\p{N}\s])\1{3,}/gu, ' ')
    .replace(/([A-Za-z])\1{12,}/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
}

function searchResultSnippet(result: SessionSearchResult): string {
  let snippet = cleanSessionSnippet(result.snippet);
  for (const repeatedMetadata of [result.title, result.cwd, result.agentSlug]) {
    if (repeatedMetadata) snippet = snippet.split(repeatedMetadata).join(' ');
  }
  return cleanSessionSnippet(snippet);
}

function scheduleLabel(automation: AgentAutomation): string {
  if (automation.schedule.kind === 'interval') {
    if (automation.schedule.everyMinutes === 60) return '每小时';
    if (automation.schedule.everyMinutes === 1_440) return '每天';
    return `每 ${automation.schedule.everyMinutes} 分钟`;
  }
  const dayLabels = ['日', '一', '二', '三', '四', '五', '六'];
  const days = automation.schedule.weekdays.length === 7
    ? '每天'
    : automation.schedule.weekdays.map((day) => `周${dayLabels[day]}`).join('、');
  return `${days} ${automation.schedule.time}`;
}

function nextScheduledAt(schedule: AutomationSchedule, now = Date.now(), createdAt = now): number {
  if (schedule.kind === 'interval') {
    const intervalMs = schedule.everyMinutes * 60_000;
    const elapsed = Math.max(0, now - createdAt);
    return createdAt + (Math.floor(elapsed / intervalMs) + 1) * intervalMs;
  }
  const [hours, minutes] = schedule.time.split(':').map(Number);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate.getTime() > now && schedule.weekdays.includes(candidate.getDay())) return candidate.getTime();
  }
  return now;
}

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(timestamp);
}

function runStatusLabel(status: AgentAutomation['lastRunStatus']): string {
  return status === 'running' ? '投递中' : status === 'success' ? '已投递' : status === 'failed' ? '投递失败' : '';
}

function runStatusClass(status: AgentAutomation['lastRunStatus']): string {
  return status === 'running' ? 'text-[var(--warning)]' : status === 'success' ? 'text-[var(--success)]' : status === 'failed' ? 'text-destructive' : 'text-muted-foreground';
}
function Empty({ text }: { text: string }) { return <div className="rounded-xl border border-dashed border-border/20 px-4 py-8 text-center text-[11px] text-muted-foreground">{text}</div>; }
