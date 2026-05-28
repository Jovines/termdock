import React, { useEffect, useCallback, useState } from 'react';
import { MultiTerminalView, type TerminalSessionInfo } from './lib/components/MultiTerminalView';
import {
  RiTerminalBoxLine,
  RiSettings4Line,
  RiAddLine,
  RiCloseLine,
  RiLayoutGridLine,
  RiRefreshLine,
  RiCheckLine,
  RiTerminalLine,
  RiKeyboardLine,
  RiEqualizerLine,
  RiStackLine,
  RiDeleteBinLine,
} from '@remixicon/react';
import { useCleanupDuration } from './lib/hooks/useCleanupDuration';
import { useFontSize } from './lib/hooks/useFontSize';
import { useTerminalRenderer } from './lib/hooks/useTerminalRenderer';
import { useViewportHeight } from './lib/hooks/useViewportHeight';
import { useNewSessionDefaults } from './lib/hooks/useNewSessionDefaults';
import type { CleanupDurationPreset, TmuxSessionSummary, TmuxStatus } from './lib/terminal/types';
import type { TerminalRendererMode } from './lib/terminal/renderer';
import { getTmuxStatus, killTmuxSession, listTmuxSessions } from './lib/terminal/api';
import { useTerminalStore } from './lib/stores/useTerminalStore';
import { ToolbarPresetSettings } from './lib/components/settings/ToolbarPresetSettings';
import { createDefaultToolbarPresets, sanitizeToolbarPresets, type ToolbarPresetDefinition } from './lib/components/terminal/mobileKeyboardPresets';

const TOOLBAR_PRESETS_STORAGE_KEY = 'termdock:toolbar-presets';

type DrawerTab = 'sessions' | 'new' | 'tmux' | 'settings';

const KEEPALIVE_PRESETS: Array<{ value: CleanupDurationPreset | 'custom'; label: string; ms: number | null }> = [
  { value: 'never', label: 'Never', ms: null },
  { value: '30min', label: '30m', ms: 30 * 60 * 1000 },
  { value: '1hour', label: '1h', ms: 60 * 60 * 1000 },
  { value: '2hours', label: '2h', ms: 2 * 60 * 60 * 1000 },
  { value: '3hours', label: '3h', ms: 3 * 60 * 60 * 1000 },
  { value: '1day', label: '1d', ms: 24 * 60 * 60 * 1000 },
  { value: 'custom', label: 'Custom', ms: null },
];

function formatKeepAliveLabel(ms: number | null): string {
  if (ms === null) return 'Never';
  const minutes = Math.round(ms / 60000);
  if (minutes >= 60 * 24) return `${Math.round(minutes / 60 / 24)}d`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

function getPresetByDuration(ms: number | null): CleanupDurationPreset | 'custom' {
  if (ms === null) return 'never';
  const matched = KEEPALIVE_PRESETS.find((preset) => preset.ms === ms);
  return (matched?.value ?? 'custom') as CleanupDurationPreset | 'custom';
}

function getSessionModeLabel(mode: 'shell' | 'tmux'): string {
  return mode === 'tmux' ? 'tmux' : 'shell';
}

const SHELL_NAMES = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'nu']);

function getTabDisplayName(
  session: { name: string; customName?: boolean },
  activeProgram: string | null,
  cwd: string | null,
): string {
  if (session.customName) return session.name;
  if (activeProgram && !SHELL_NAMES.has(activeProgram)) return activeProgram;
  if (cwd) {
    if (cwd === '/') return '/';
    const segments = cwd.replace(/\/+$/, '').split('/');
    return segments[segments.length - 1] || cwd;
  }
  return session.name;
}

function App() {
  const safeTopInset = 'env(safe-area-inset-top, 0px)';
  const safeBottomInset = 'env(safe-area-inset-bottom, 0px)';

  useViewportHeight();

  const [showDebug, setShowDebug] = React.useState(false);
  const [debugInfo, setDebugInfo] = React.useState<Record<string, any>>({});
  const { fontSize, setFontSize } = useFontSize();
  const { rendererMode, setRendererMode } = useTerminalRenderer();
  const [isDrawerOpen, setIsDrawerOpen] = React.useState(false);
  const [drawerTab, setDrawerTab] = React.useState<DrawerTab>('sessions');
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null);
  const terminalSessions = useTerminalStore((s) => s.sessions);
  const [tmuxSessions, setTmuxSessions] = useState<TmuxSessionSummary[]>([]);
  const [tmuxStatus, setTmuxStatus] = useState<TmuxStatus>({ available: true, version: null, reason: null });
  const [tmuxRefreshing, setTmuxRefreshing] = useState(false);
  const [tmuxConfirmKillName, setTmuxConfirmKillName] = useState<string | null>(null);
  const [tmuxKillingName, setTmuxKillingName] = useState<string | null>(null);
  const [tmuxKillError, setTmuxKillError] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const renameInputRef = React.useRef<HTMLInputElement | null>(null);
  const activeSessionTabRef = React.useRef<HTMLButtonElement | null>(null);

  const renameSession = useCallback((sessionId: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    window.dispatchEvent(new CustomEvent('rename-terminal-session', { detail: { sessionId, name: trimmed } }));
  }, []);

  const {
    cleanupDurationMs,
    cleanupDurationPreset,
    customDurationMs,
    setCleanupDurationPreset,
    setCustomDuration,
  } = useCleanupDuration();

  const [customDurationInput, setCustomDurationInput] = React.useState<string>('');
  const {
    newSessionMode,
    newSessionTmuxName,
    setNewSessionMode,
    setNewSessionTmuxName,
  } = useNewSessionDefaults();

  const [activeKeepAlivePreset, setActiveKeepAlivePreset] = React.useState<CleanupDurationPreset | 'custom'>('3hours');
  const [activeKeepAliveCustomInput, setActiveKeepAliveCustomInput] = React.useState<string>('180');
  const [activeKeepAliveSavedAt, setActiveKeepAliveSavedAt] = React.useState<number>(0);
  const [isToolbarPresetsOpen, setIsToolbarPresetsOpen] = React.useState(false);
  const [toolbarPresets, setToolbarPresets] = React.useState<ToolbarPresetDefinition[]>(() => {
    if (typeof window === 'undefined') {
      return createDefaultToolbarPresets();
    }

    try {
      const raw = window.localStorage.getItem(TOOLBAR_PRESETS_STORAGE_KEY);
      if (!raw) {
        return createDefaultToolbarPresets();
      }
      const stored = sanitizeToolbarPresets(JSON.parse(raw) as ToolbarPresetDefinition[]);
      const defaults = createDefaultToolbarPresets();
      const storedIds = new Set(stored.map((p) => p.id));
      for (const preset of defaults) {
        if (!storedIds.has(preset.id)) {
          stored.push(preset);
        }
      }
      return stored;
    } catch {
      return createDefaultToolbarPresets();
    }
  });
  const [selectedToolbarPresetId, setSelectedToolbarPresetId] = React.useState<string>('default');

  useEffect(() => {
    window.localStorage.setItem(TOOLBAR_PRESETS_STORAGE_KEY, JSON.stringify(toolbarPresets));
  }, [toolbarPresets]);

  useEffect(() => {
    if (!toolbarPresets.some((preset) => preset.id === selectedToolbarPresetId)) {
      setSelectedToolbarPresetId(toolbarPresets[0]?.id ?? 'default');
    }
  }, [selectedToolbarPresetId, toolbarPresets]);

  useEffect(() => {
    if (cleanupDurationPreset === 'custom' && customDurationMs !== null) {
      setCustomDurationInput(String(Math.round(customDurationMs / 60000)));
    } else if (cleanupDurationPreset !== 'custom') {
      setCustomDurationInput('');
    }
  }, [cleanupDurationPreset, customDurationMs]);

  useEffect(() => {
    if (!tmuxStatus.available && newSessionMode === 'tmux') {
      setNewSessionMode('shell');
    }
  }, [newSessionMode, tmuxStatus.available, setNewSessionMode]);

  useEffect(() => {
    const info: Record<string, any> = {};

    if (typeof navigator !== 'undefined') {
      info.userAgent = navigator.userAgent;
      info.platform = navigator.platform;
      info.maxTouchPoints = navigator.maxTouchPoints;
      info.hasTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
      info.vendor = navigator.vendor;
    }

    if (typeof window !== 'undefined') {
      info.screenWidth = window.innerWidth;
      info.screenHeight = window.innerHeight;
      info.pixelRatio = window.devicePixelRatio;
      info.orientation = window.screen?.orientation?.type || 'unknown';
      info.hasVisualViewport = !!window.visualViewport;
      info.visualViewportHeight = window.visualViewport?.height;
      info.visualViewportWidth = window.visualViewport?.width;
      info.location = window.location.href;
    }

    info.timestamp = new Date().toISOString();
    info.isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    info.isAndroid = /Android/.test(navigator.userAgent);

    setDebugInfo(info);
  }, []);

  const handleCustomDurationBlur = () => {
    const minutes = parseInt(customDurationInput, 10);
    if (isNaN(minutes) || minutes < 1) {
      setCustomDurationInput('5');
      setCustomDuration(5 * 60 * 1000);
    } else if (minutes > 10080) {
      setCustomDurationInput('10080');
      setCustomDuration(7 * 24 * 60 * 60 * 1000);
    }
  };

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const activeSessionIndex = activeSessionId
    ? sessions.findIndex((session) => session.id === activeSessionId)
    : -1;
  const activeSessionModeLabel = activeSession ? getSessionModeLabel(activeSession.mode) : null;
  const activeSessionKeepAliveLabel = activeSession ? formatKeepAliveLabel(activeSession.keepAliveMs) : null;
  const activeSessionPositionLabel = sessions.length > 0 && activeSessionIndex >= 0
    ? `${activeSessionIndex + 1}/${sessions.length}`
    : `${sessions.length}`;
  const connectedTmuxNames = React.useMemo(
    () => new Set(sessions.filter((s) => s.mode === 'tmux' && s.tmuxSessionName).map((s) => s.tmuxSessionName)),
    [sessions],
  );

  useEffect(() => {
    if (!activeSession) return;
    const preset = getPresetByDuration(activeSession.keepAliveMs);
    setActiveKeepAlivePreset(preset);
    if (preset === 'custom') {
      if (activeSession.keepAliveMs === null) {
        setActiveKeepAliveCustomInput('180');
      } else {
        setActiveKeepAliveCustomInput(String(Math.max(1, Math.round(activeSession.keepAliveMs / 60000))));
      }
    }
  }, [activeSession?.id, activeSession?.keepAliveMs]);

  useEffect(() => {
    activeSessionTabRef.current?.scrollIntoView({
      inline: 'center',
      block: 'nearest',
      behavior: 'smooth',
    });
  }, [activeSessionId]);

  useEffect(() => {
    if (editingSessionId && renameInputRef.current) {
      renameInputRef.current.select();
    }
  }, [editingSessionId]);

  const handleTabClick = useCallback((sessionId: string) => {
    window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: sessionId }));
  }, []);

  const flashKeepAliveSaved = useCallback(() => {
    setActiveKeepAliveSavedAt(Date.now());
    window.setTimeout(() => {
      setActiveKeepAliveSavedAt((current) => (Date.now() - current >= 1500 ? 0 : current));
    }, 1600);
  }, []);

  const applyActiveSessionKeepAlive = useCallback((keepAliveMs: number | null) => {
    if (!activeSessionId) return;
    window.dispatchEvent(new CustomEvent('update-terminal-session-policy', {
      detail: {
        sessionId: activeSessionId,
        keepAliveMs,
      },
    }));
    flashKeepAliveSaved();
  }, [activeSessionId, flashKeepAliveSaved]);

  const handleSessionDataUpdate = useCallback((data: { sessions: TerminalSessionInfo[]; activeSessionId: string | null }) => {
    setSessions(data.sessions);
    setActiveSessionId(data.activeSessionId);
  }, []);

  const dispatchNewSession = useCallback((overrides?: { mode?: 'shell' | 'tmux'; tmuxSessionName?: string }) => {
    const mode = overrides?.mode ?? newSessionMode;
    const tmuxSessionName = mode === 'tmux'
      ? (overrides?.tmuxSessionName?.trim() || newSessionTmuxName.trim() || undefined)
      : undefined;
    window.dispatchEvent(new CustomEvent('new-terminal-session', {
      detail: {
        keepAliveMs: cleanupDurationMs === Infinity ? null : cleanupDurationMs,
        mode,
        tmuxSessionName,
      },
    }));
  }, [cleanupDurationMs, newSessionMode, newSessionTmuxName]);

  const refreshTmuxSessions = useCallback(async () => {
    setTmuxRefreshing(true);
    try {
      const status = await getTmuxStatus();
      setTmuxStatus(status);
      if (!status.available) {
        setTmuxSessions([]);
        return;
      }
      const list = await listTmuxSessions();
      setTmuxSessions(list);
    } catch {
      setTmuxStatus({ available: false, version: null, reason: 'tmux integration is unavailable with the current server build.' });
      setTmuxSessions([]);
    } finally {
      setTmuxRefreshing(false);
    }
  }, []);

  const handleKillTmuxSession = useCallback(async (name: string) => {
    setTmuxKillingName(name);
    setTmuxKillError(null);
    try {
      const { cleanedSessions } = await killTmuxSession(name);
      // Drop any frontend tabs that were attached to this tmux session.
      for (const backendId of cleanedSessions) {
        window.dispatchEvent(new CustomEvent('close-terminal-session-by-backend', { detail: backendId }));
      }
      setTmuxConfirmKillName(null);
      await refreshTmuxSessions();
    } catch (error) {
      setTmuxKillError(error instanceof Error ? error.message : 'Failed to kill tmux session');
    } finally {
      setTmuxKillingName(null);
    }
  }, [refreshTmuxSessions]);

  // Auto-refresh tmux sessions when drawer is open and on tmux/new tabs
  useEffect(() => {
    if (!isDrawerOpen) return;
    if (drawerTab !== 'tmux' && drawerTab !== 'new') return;

    let cancelled = false;
    let pollingDisabled = false;
    const fetchSessions = async () => {
      if (pollingDisabled) return;
      try {
        const status = await getTmuxStatus();
        if (!cancelled) setTmuxStatus(status);
        if (!status.available) {
          if (!cancelled) setTmuxSessions([]);
          return;
        }
        const list = await listTmuxSessions();
        if (!cancelled) setTmuxSessions(list);
      } catch {
        pollingDisabled = true;
        if (!cancelled) {
          setTmuxStatus({ available: false, version: null, reason: 'tmux integration is unavailable with the current server build.' });
          setTmuxSessions([]);
        }
      }
    };

    void fetchSessions();
    const interval = setInterval(() => { void fetchSessions(); }, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isDrawerOpen, drawerTab]);

  const tabDefs: Array<{ id: DrawerTab; label: string; icon: React.ReactNode; badge?: number | null }> = [
    { id: 'sessions', label: 'Sessions', icon: <RiStackLine size={16} />, badge: sessions.length },
    { id: 'new', label: 'New', icon: <RiAddLine size={16} /> },
    {
      id: 'tmux',
      label: 'Tmux',
      icon: <RiLayoutGridLine size={16} />,
      badge: tmuxStatus.available ? tmuxSessions.length : null,
    },
    { id: 'settings', label: 'Settings', icon: <RiEqualizerLine size={16} /> },
  ];

  // Swipe-to-switch tab support for the settings drawer.
  const swipeStateRef = React.useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    decided: 'h' | 'v' | null;
    pointerType: string;
  } | null>(null);

  const goToTabByDelta = useCallback((delta: number) => {
    const idx = tabDefs.findIndex((t) => t.id === drawerTab);
    if (idx === -1) return;
    const next = idx + delta;
    if (next < 0 || next >= tabDefs.length) return;
    setDrawerTab(tabDefs[next].id);
  }, [drawerTab, tabDefs]);

  const onSwipePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // Only enable swipe for touch / pen, not mouse.
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    // Skip if interaction starts on a horizontally scrollable element (chips, scrollers, etc.)
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, button, [role="slider"], [data-no-swipe]')) {
      return;
    }
    swipeStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      decided: null,
      pointerType: event.pointerType,
    };
  }, []);

  const onSwipePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const state = swipeStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (state.decided === null) {
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      if (ax < 8 && ay < 8) return;
      // Vertical first → release ownership so scroll can happen.
      state.decided = ay > ax ? 'v' : 'h';
    }
  }, []);

  const onSwipePointerEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const state = swipeStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    swipeStateRef.current = null;
    if (state.decided !== 'h') return;
    const dx = event.clientX - state.startX;
    const ax = Math.abs(dx);
    const ay = Math.abs(event.clientY - state.startY);
    // Require a clearly horizontal swipe of meaningful distance.
    if (ax < 60 || ax < ay * 1.5) return;
    goToTabByDelta(dx < 0 ? 1 : -1);
  }, [goToTabByDelta]);

  return (
    <div
      className="w-screen flex flex-col bg-background text-foreground"
      style={{ height: 'var(--app-vh, 100vh)' }}
    >
      <main className="relative min-h-0 flex-1 overflow-visible px-0 pb-0 pt-0">
        <div className="mx-auto flex h-full w-full max-w-[1440px] min-h-0 flex-col overflow-visible bg-background">
          <div
            className="flex h-6 shrink-0 items-center justify-between gap-1.5 bg-background px-1.5 sm:h-7 sm:px-2"
          >
            <div className="scrollbar-thin flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden whitespace-nowrap">
              {sessions.map((session) => {
                const isActive = session.id === activeSessionId;
                const isEditing = session.id === editingSessionId;
                const ts = terminalSessions.get(session.id);
                const displayName = getTabDisplayName(session, ts?.activeProgram ?? null, ts?.cwd ?? null);
                const tooltip = ts?.cwd || session.name;

                if (isEditing) {
                  const commitRename = (sessionId: string, value: string) => {
                    const trimmed = value.trim();
                    if (trimmed) {
                      renameSession(sessionId, trimmed);
                    }
                    setEditingSessionId(null);
                  };

                  return (
                    <input
                      key={session.id}
                      ref={renameInputRef}
                      type="text"
                      defaultValue={session.name}
                      maxLength={48}
                      className="shrink-0 rounded-full px-2 py-0.5 text-[11px] outline-none bg-surface-elevated text-foreground ring-1 ring-primary/50 min-w-[6rem]"
                      style={{ width: `${Math.min(Math.max(session.name.length, 6), 24)}ch` }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          commitRename(session.id, (e.target as HTMLInputElement).value);
                        } else if (e.key === 'Escape') {
                          setEditingSessionId(null);
                        }
                      }}
                      onBlur={(e) => commitRename(session.id, e.target.value)}
                    />
                  );
                }

                return (
                  <button
                    key={session.id}
                    ref={isActive ? activeSessionTabRef : null}
                    type="button"
                    onClick={() => handleTabClick(session.id)}
                    onDoubleClick={() => setEditingSessionId(session.id)}
                    className={`inline-flex items-center shrink-0 truncate rounded-full px-2 py-0.5 text-[11px] transition max-w-[14rem] ${
                      isActive
                        ? 'bg-surface-elevated text-foreground'
                        : 'text-muted-foreground hover:bg-surface-elevated/50 hover:text-foreground'
                    }`}
                    title={tooltip}
                  >
                    <span className="inline-flex min-w-0 items-center gap-1">
                      {session.mode === 'tmux' && (
                        <RiLayoutGridLine
                          size={12}
                          className={`shrink-0 ${ts?.inCopyMode ? 'text-yellow-400' : ''}`}
                        />
                      )}
                      <span className="truncate">{displayName}</span>
                    </span>
                  </button>
                );
              })}
              <div className="hidden items-center gap-1.5 pl-2 lg:flex">
                {activeSessionModeLabel && (
                  <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    {activeSessionModeLabel}
                  </span>
                )}
                {activeSessionKeepAliveLabel && (
                  <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    keepalive {activeSessionKeepAliveLabel}
                  </span>
                )}
                <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  {fontSize}px
                </span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {sessions.length > 0 && (
              <span
                className="inline-flex shrink-0 items-center px-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground sm:text-[11px]"
                title={`Session ${activeSessionIndex + 1} of ${sessions.length}`}
              >
                {activeSessionPositionLabel}
              </span>
              )}
              <button
                type="button"
                onClick={() => {
                  setDrawerTab('sessions');
                  setIsDrawerOpen(true);
                }}
                className="inline-flex h-5 shrink-0 items-center justify-center gap-1 rounded-full bg-surface-2 px-2.5 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground sm:h-6"
                aria-label="Open sessions and settings"
              >
                <RiSettings4Line size={16} />
                <span className="ml-2 hidden text-xs sm:inline">Settings</span>
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden bg-background">
            <MultiTerminalView
              fontSize={fontSize}
              rendererMode={rendererMode}
              toolbarPresets={toolbarPresets}
              showDebug={showDebug}
              defaultSessionMode={newSessionMode}
              defaultTmuxSessionName={newSessionTmuxName}
              showSessionStrip={false}
              onSessionDataUpdate={handleSessionDataUpdate}
            />
          </div>
        </div>
      </main>

      {/* Drawer with tabs */}
      {isDrawerOpen && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 bg-[rgba(0,0,0,0.5)] backdrop-blur-sm animate-fade-in cursor-default"
            onClick={() => setIsDrawerOpen(false)}
          />
          <div
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[30rem] flex-col border-l border-border/15 bg-surface animate-fade-in"
            style={{ paddingTop: safeTopInset, paddingBottom: safeBottomInset }}
          >
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/15 px-4 py-3 sm:px-6">
              <div className="min-w-0">
                <div className="ui-kicker">Workspace</div>
                <h2 className="section-title mt-0.5">
                  {drawerTab === 'sessions' && 'Sessions'}
                  {drawerTab === 'new' && 'New session'}
                  {drawerTab === 'tmux' && 'Tmux server'}
                  {drawerTab === 'settings' && 'Settings'}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setIsDrawerOpen(false)}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-destructive/20 hover:text-destructive"
                aria-label="Close"
              >
                <RiCloseLine size={18} />
              </button>
            </div>

            {/* Tab bar */}
            <div className="shrink-0 border-b border-border/15 px-2 py-2 sm:px-4">
              <div className="grid grid-cols-4 gap-1">
                {tabDefs.map((tab) => {
                  const isActive = drawerTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setDrawerTab(tab.id)}
                      className={`group flex flex-col items-center justify-center gap-1 rounded-2xl px-2 py-2 text-[11px] font-medium transition ${
                        isActive
                          ? 'bg-surface-elevated text-foreground'
                          : 'text-muted-foreground hover:bg-surface-2'
                      }`}
                    >
                      <span className={`relative flex h-6 w-6 items-center justify-center rounded-full ${
                        isActive ? 'bg-primary/20 text-primary' : 'bg-surface-2 text-muted-foreground group-hover:bg-surface-elevated'
                      }`}>
                        {tab.icon}
                        {typeof tab.badge === 'number' && tab.badge > 0 && (
                          <span className="absolute -top-1 -right-1 inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-accent px-1 text-[9px] text-accent-foreground">
                            {tab.badge}
                          </span>
                        )}
                      </span>
                      <span>{tab.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Tab content */}
            <div
              className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6"
              onPointerDown={onSwipePointerDown}
              onPointerMove={onSwipePointerMove}
              onPointerUp={onSwipePointerEnd}
              onPointerCancel={onSwipePointerEnd}
              style={{ touchAction: 'pan-y' }}
            >
              <div key={drawerTab} className="animate-fade-in">
              {drawerTab === 'sessions' && (
                <div className="space-y-3">
                  {sessions.length === 0 ? (
                    <div className="rounded-2xl bg-surface-2/60 px-4 py-8 text-center">
                      <RiTerminalBoxLine size={28} className="mx-auto mb-2 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">No open sessions yet.</p>
                      <button
                        type="button"
                        onClick={() => setDrawerTab('new')}
                        className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-4 py-2 text-sm font-medium text-primary"
                      >
                        <RiAddLine size={14} />
                        Create one
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="space-y-2">
                        {sessions.map((session) => {
                          const ts = terminalSessions.get(session.id);
                          const display = getTabDisplayName(session, ts?.activeProgram ?? null, ts?.cwd ?? null);
                          const isActive = session.id === activeSessionId;
                          return (
                            <div
                              key={session.id}
                              className={`flex w-full items-center gap-2 rounded-2xl px-3 py-3 text-sm transition ${
                                isActive
                                  ? 'bg-surface-elevated text-foreground ring-1 ring-primary/30'
                                  : 'bg-surface-2 text-foreground hover:bg-surface-elevated'
                              }`}
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: session.id }));
                                  setIsDrawerOpen(false);
                                }}
                                className="min-w-0 flex flex-1 items-center gap-3 text-left"
                              >
                                <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                                  isActive ? 'bg-primary/20 text-primary' : 'bg-surface text-muted-foreground'
                                }`}>
                                  {session.mode === 'tmux' ? <RiLayoutGridLine size={16} /> : <RiTerminalBoxLine size={16} />}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-sm text-foreground">{display}</span>
                                  <span className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                                    <span>{getSessionModeLabel(session.mode)}</span>
                                    {session.tmuxSessionName && <span>· {session.tmuxSessionName}</span>}
                                    <span>· {formatKeepAliveLabel(session.keepAliveMs)}</span>
                                  </span>
                                </span>
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  window.dispatchEvent(new CustomEvent('close-terminal-session', { detail: session.id }));
                                }}
                                className="shrink-0 rounded-full p-2 text-muted-foreground transition hover:bg-destructive/15 hover:text-destructive"
                                aria-label={`Close ${display}`}
                              >
                                <RiCloseLine size={16} />
                              </button>
                            </div>
                          );
                        })}
                      </div>

                      <button
                        type="button"
                        onClick={() => setDrawerTab('new')}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary/10 px-4 py-3 text-sm font-medium text-primary transition hover:bg-primary/20 active:scale-[0.98]"
                      >
                        <RiAddLine size={16} />
                        New session
                      </button>

                      {activeSession && (
                        <div className="mt-2 space-y-2 rounded-2xl bg-surface-2/60 p-3">
                          <div className="flex items-center justify-between">
                            <div>
                              <span className="ui-kicker">Active keepalive</span>
                              <p className="text-[11px] text-muted-foreground">Auto-cleanup for the focused session.</p>
                            </div>
                            {activeKeepAliveSavedAt > 0 && Date.now() - activeKeepAliveSavedAt < 1500 && (
                              <span className="inline-flex items-center gap-1 text-[11px] text-primary">
                                <RiCheckLine size={12} /> Saved
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {KEEPALIVE_PRESETS.map((preset) => {
                              const selected = activeKeepAlivePreset === preset.value;
                              return (
                                <button
                                  key={preset.value}
                                  type="button"
                                  onClick={() => {
                                    setActiveKeepAlivePreset(preset.value);
                                    if (preset.value === 'custom') {
                                      if (!activeKeepAliveCustomInput) {
                                        setActiveKeepAliveCustomInput('180');
                                      }
                                      return;
                                    }
                                    applyActiveSessionKeepAlive(preset.ms);
                                  }}
                                  className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                                    selected
                                      ? 'bg-primary/20 text-primary ring-1 ring-primary/30'
                                      : 'bg-surface text-muted-foreground hover:bg-surface-elevated'
                                  }`}
                                >
                                  {preset.label}
                                </button>
                              );
                            })}
                          </div>
                          {activeKeepAlivePreset === 'custom' && (
                            <div className="flex items-center gap-2">
                              <input
                                type="number"
                                min="1"
                                max="10080"
                                value={activeKeepAliveCustomInput}
                                onChange={(e) => setActiveKeepAliveCustomInput(e.target.value)}
                                placeholder="Minutes"
                                className="ui-input flex-1"
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  const minutes = parseInt(activeKeepAliveCustomInput, 10);
                                  const normalized = Number.isFinite(minutes) ? Math.min(10080, Math.max(1, minutes)) : 180;
                                  setActiveKeepAliveCustomInput(String(normalized));
                                  applyActiveSessionKeepAlive(normalized * 60000);
                                }}
                                className="shrink-0 rounded-full bg-primary/15 px-4 py-2.5 text-sm font-medium text-primary hover:bg-primary/25"
                              >
                                Apply
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {drawerTab === 'new' && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <span className="ui-kicker">Mode</span>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setNewSessionMode('shell')}
                        className={`rounded-2xl px-4 py-4 text-left transition ${
                          newSessionMode === 'shell'
                            ? 'bg-surface-elevated ring-1 ring-primary/30'
                            : 'bg-surface-2 hover:bg-surface-elevated'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
                            <RiTerminalLine size={14} /> Shell
                          </span>
                          {newSessionMode === 'shell' && <RiCheckLine size={16} className="text-primary" />}
                        </div>
                        <p className="mt-1.5 text-[11px] text-muted-foreground">
                          Persistent PTY with keepalive. Best default.
                        </p>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          if (tmuxStatus.available) {
                            setNewSessionMode('tmux');
                          }
                        }}
                        disabled={!tmuxStatus.available}
                        className={`rounded-2xl px-4 py-4 text-left transition ${
                          newSessionMode === 'tmux'
                            ? 'bg-surface-elevated ring-1 ring-primary/30'
                            : 'bg-surface-2 hover:bg-surface-elevated'
                        } ${!tmuxStatus.available ? 'opacity-60 cursor-not-allowed' : ''}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
                            <RiLayoutGridLine size={14} /> Tmux
                          </span>
                          {newSessionMode === 'tmux' && <RiCheckLine size={16} className="text-primary" />}
                        </div>
                        <p className="mt-1.5 text-[11px] text-muted-foreground">
                          {tmuxStatus.available
                            ? 'Named, multi-pane, reattachable.'
                            : 'tmux not detected on server.'}
                        </p>
                      </button>
                    </div>
                  </div>

                  {newSessionMode === 'tmux' && (
                    <div className="space-y-2">
                      <span className="ui-kicker">Tmux name (optional)</span>
                      <input
                        type="text"
                        value={newSessionTmuxName}
                        onChange={(e) => setNewSessionTmuxName(e.target.value)}
                        onBlur={() => setNewSessionTmuxName(newSessionTmuxName.trim())}
                        placeholder="auto-generated when empty"
                        className="ui-input w-full"
                        autoCapitalize="off"
                        autoCorrect="off"
                        autoComplete="off"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Leave blank for an auto name. Reuse an existing name to attach to it.
                      </p>
                    </div>
                  )}

                  <div className="space-y-2">
                    <span className="ui-kicker">Keepalive</span>
                    <div className="flex flex-wrap gap-1.5">
                      {KEEPALIVE_PRESETS.map((preset) => {
                        const selected = cleanupDurationPreset === preset.value;
                        return (
                          <button
                            key={preset.value}
                            type="button"
                            onClick={() => setCleanupDurationPreset(preset.value)}
                            className={`rounded-full px-3 py-2 text-xs font-medium transition ${
                              selected
                                ? 'bg-primary/20 text-primary ring-1 ring-primary/30'
                                : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated'
                            }`}
                          >
                            {preset.label}
                          </button>
                        );
                      })}
                    </div>
                    {cleanupDurationPreset === 'custom' && (
                      <input
                        type="number"
                        min="1"
                        max="10080"
                        value={customDurationInput}
                        onChange={(e) => setCustomDurationInput(e.target.value)}
                        onBlur={handleCustomDurationBlur}
                        placeholder="Minutes"
                        className="ui-input mt-1 w-full"
                      />
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      dispatchNewSession();
                      setIsDrawerOpen(false);
                    }}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-4 py-3.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 active:scale-[0.98]"
                  >
                    <RiAddLine size={16} />
                    Create {newSessionMode === 'tmux' ? 'tmux' : 'shell'} session
                  </button>

                  {newSessionMode === 'tmux' && tmuxStatus.available && (
                    <div className="rounded-2xl bg-surface-2/60 px-3 py-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="ui-kicker">Quick attach</span>
                        <button
                          type="button"
                          onClick={() => setDrawerTab('tmux')}
                          className="text-[11px] text-primary hover:underline"
                        >
                          See all →
                        </button>
                      </div>
                      {tmuxSessions.length === 0 ? (
                        <p className="text-[11px] text-muted-foreground">No tmux sessions on the server yet.</p>
                      ) : (
                        <div className="space-y-1.5">
                          {tmuxSessions.slice(0, 4).map((tmux) => {
                            const connected = connectedTmuxNames.has(tmux.name);
                            return (
                              <button
                                key={tmux.name}
                                type="button"
                                disabled={connected}
                                onClick={() => {
                                  dispatchNewSession({ mode: 'tmux', tmuxSessionName: tmux.name });
                                  setIsDrawerOpen(false);
                                }}
                                className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-left transition ${
                                  connected
                                    ? 'bg-surface text-muted-foreground opacity-70 cursor-not-allowed'
                                    : 'bg-surface text-foreground hover:bg-surface-elevated'
                                }`}
                              >
                                <RiLayoutGridLine size={14} className="shrink-0 text-muted-foreground" />
                                <span className="flex-1 truncate">{tmux.name}</span>
                                <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                                  {connected ? 'attached' : `${tmux.windows}w`}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {drawerTab === 'tmux' && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 rounded-2xl bg-surface-2/60 px-3 py-3">
                    <span className={`inline-flex h-2 w-2 rounded-full ${tmuxStatus.available ? 'bg-primary' : 'bg-destructive'}`} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-foreground">
                        {tmuxStatus.available ? 'tmux available' : 'tmux unavailable'}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {tmuxStatus.available
                          ? (tmuxStatus.version || 'Detected on server')
                          : (tmuxStatus.reason || 'Install tmux on the server to enable.')}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void refreshTmuxSessions()}
                      disabled={tmuxRefreshing}
                      className="shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface text-muted-foreground transition hover:bg-surface-elevated disabled:opacity-50"
                      aria-label="Refresh tmux sessions"
                    >
                      <RiRefreshLine size={14} className={tmuxRefreshing ? 'animate-spin' : ''} />
                    </button>
                  </div>

                  {tmuxStatus.available && (
                    <>
                      {tmuxSessions.length === 0 ? (
                        <div className="rounded-2xl bg-surface-2/60 px-4 py-8 text-center">
                          <RiLayoutGridLine size={28} className="mx-auto mb-2 text-muted-foreground" />
                          <p className="text-sm text-muted-foreground">No tmux sessions on the server.</p>
                          <button
                            type="button"
                            onClick={() => {
                              setNewSessionMode('tmux');
                              setDrawerTab('new');
                            }}
                            className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-4 py-2 text-sm font-medium text-primary"
                          >
                            <RiAddLine size={14} />
                            Create one
                          </button>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {tmuxSessions.map((tmux) => {
                            const connected = connectedTmuxNames.has(tmux.name);
                            const confirming = tmuxConfirmKillName === tmux.name;
                            const killing = tmuxKillingName === tmux.name;
                            return (
                              <div
                                key={tmux.name}
                                className={`rounded-2xl px-3 py-3 transition ${
                                  confirming
                                    ? 'bg-destructive/10 ring-1 ring-destructive/40'
                                    : connected
                                      ? 'bg-surface-2/40'
                                      : 'bg-surface-2 hover:bg-surface-elevated'
                                }`}
                              >
                                <div className="flex items-center gap-3">
                                  <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                                    connected ? 'bg-primary/20 text-primary' : 'bg-surface text-muted-foreground'
                                  }`}>
                                    <RiLayoutGridLine size={16} />
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm font-medium text-foreground">{tmux.name}</div>
                                    <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                                      {tmux.windows} window{tmux.windows === 1 ? '' : 's'}
                                      {connected && ' · attached'}
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    disabled={connected || confirming || killing}
                                    onClick={() => {
                                      dispatchNewSession({ mode: 'tmux', tmuxSessionName: tmux.name });
                                    }}
                                    className={`shrink-0 rounded-full px-4 py-2 text-xs font-medium transition ${
                                      connected || confirming || killing
                                        ? 'bg-surface text-muted-foreground cursor-not-allowed'
                                        : 'bg-primary/15 text-primary hover:bg-primary/25'
                                    }`}
                                  >
                                    {connected ? 'Attached' : 'Attach'}
                                  </button>
                                  <button
                                    type="button"
                                    disabled={killing}
                                    onClick={() => {
                                      setTmuxKillError(null);
                                      setTmuxConfirmKillName(confirming ? null : tmux.name);
                                    }}
                                    className={`shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-full transition ${
                                      confirming
                                        ? 'bg-destructive/20 text-destructive'
                                        : 'bg-surface text-muted-foreground hover:bg-destructive/15 hover:text-destructive'
                                    } disabled:opacity-50`}
                                    aria-label={`Kill tmux session ${tmux.name}`}
                                  >
                                    <RiDeleteBinLine size={14} />
                                  </button>
                                </div>

                                {confirming && (
                                  <div className="mt-3 space-y-2 rounded-xl bg-surface/80 p-3">
                                    <p className="text-[12px] leading-snug text-foreground">
                                      Permanently destroy tmux session <span className="font-mono font-semibold">{tmux.name}</span>?
                                    </p>
                                    <p className="text-[11px] text-muted-foreground">
                                      Runs <span className="font-mono">tmux kill-session</span>. All windows and panes inside will be terminated. Cannot be undone.
                                    </p>
                                    {tmuxKillError && (
                                      <p className="text-[11px] text-destructive">{tmuxKillError}</p>
                                    )}
                                    <div className="flex items-center gap-2 pt-1">
                                      <button
                                        type="button"
                                        disabled={killing}
                                        onClick={() => void handleKillTmuxSession(tmux.name)}
                                        className="flex-1 rounded-full bg-destructive/90 px-3 py-2 text-xs font-medium text-destructive-foreground transition hover:bg-destructive disabled:opacity-50"
                                      >
                                        {killing ? 'Destroying…' : 'Destroy'}
                                      </button>
                                      <button
                                        type="button"
                                        disabled={killing}
                                        onClick={() => {
                                          setTmuxConfirmKillName(null);
                                          setTmuxKillError(null);
                                        }}
                                        className="flex-1 rounded-full bg-surface-2 px-3 py-2 text-xs font-medium text-foreground transition hover:bg-surface-elevated disabled:opacity-50"
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      <p className="text-center text-[11px] text-muted-foreground">
                        Attach opens a new tab without closing this panel.
                      </p>
                    </>
                  )}
                </div>
              )}

              {drawerTab === 'settings' && (
                <div className="space-y-5">
                  {/* Font Size */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="ui-label">Font size</span>
                      <span className="text-xs text-muted-foreground tabular-nums">{fontSize}px</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setFontSize(Math.max(8, fontSize - 1))}
                        className="h-10 w-10 shrink-0 rounded-full bg-surface-2 text-muted-foreground hover:bg-surface-elevated"
                      >
                        −
                      </button>
                      <input
                        type="range"
                        min="8"
                        max="32"
                        value={fontSize}
                        onChange={(e) => setFontSize(parseInt(e.target.value, 10))}
                        className="flex-1"
                        aria-label="Font size"
                      />
                      <button
                        type="button"
                        onClick={() => setFontSize(Math.min(32, fontSize + 1))}
                        className="h-10 w-10 shrink-0 rounded-full bg-surface-2 text-muted-foreground hover:bg-surface-elevated"
                      >
                        +
                      </button>
                    </div>
                  </div>

                  {/* Renderer */}
                  <div className="space-y-2">
                    <span className="ui-label">Renderer</span>
                    <div className="grid grid-cols-3 gap-1.5">
                      {(['auto', 'webgl', 'canvas'] as TerminalRendererMode[]).map((mode) => {
                        const selected = rendererMode === mode;
                        return (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setRendererMode(mode)}
                            className={`rounded-full px-3 py-2 text-xs font-medium transition ${
                              selected
                                ? 'bg-primary/20 text-primary ring-1 ring-primary/30'
                                : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated'
                            }`}
                          >
                            {mode === 'auto' ? 'Auto' : mode === 'webgl' ? 'WebGL' : 'Canvas'}
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      WebGL is sharper. Canvas is more compatible.
                    </p>
                  </div>

                  {/* Toolbar Presets */}
                  <button
                    type="button"
                    onClick={() => setIsToolbarPresetsOpen(true)}
                    className="flex w-full items-center justify-between rounded-2xl bg-surface-2 px-4 py-3.5 text-left text-sm transition hover:bg-surface-elevated"
                  >
                    <span className="flex items-center gap-3">
                      <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface text-muted-foreground">
                        <RiKeyboardLine size={16} />
                      </span>
                      <span>
                        <span className="block font-medium text-foreground">Mobile keyboard toolbar</span>
                        <span className="block text-[11px] text-muted-foreground">
                          {toolbarPresets.length} preset{toolbarPresets.length === 1 ? '' : 's'}
                        </span>
                      </span>
                    </span>
                    <span className="text-muted-foreground">›</span>
                  </button>

                  {/* Debug toggle */}
                  <div className="flex items-center justify-between rounded-2xl bg-surface-2 px-4 py-3">
                    <span className="ui-label">Debug overlay</span>
                    <button
                      type="button"
                      onClick={() => setShowDebug(!showDebug)}
                      className={`inline-flex h-6 w-10 items-center rounded-full transition ${
                        showDebug ? 'bg-primary/70' : 'bg-surface-elevated'
                      }`}
                      aria-label="Toggle debug overlay"
                    >
                      <span
                        className={`mx-0.5 inline-block h-5 w-5 rounded-full bg-foreground/90 transition ${
                          showDebug ? 'translate-x-4' : ''
                        }`}
                      />
                    </button>
                  </div>
                </div>
              )}
              </div>
            </div>
          </div>
        </>
      )}

      {isToolbarPresetsOpen && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-[60] bg-[rgba(0,0,0,0.5)] backdrop-blur-sm cursor-default"
            onClick={() => setIsToolbarPresetsOpen(false)}
          />
          <div className="fixed inset-x-3 top-6 bottom-6 z-[70] mx-auto flex max-w-4xl flex-col overflow-hidden rounded-2xl bg-surface border border-border/15 shadow-[0_28px_70px_rgba(0,0,0,0.14),0_14px_32px_rgba(0,0,0,0.10)]">
            <div className="flex shrink-0 items-center justify-between border-b border-border/15 px-4 py-4 sm:px-6">
              <div className="min-w-0">
                <div className="ui-kicker">Mobile keyboard</div>
                <h2 className="section-title mt-1">Toolbar presets</h2>
              </div>
              <button
                type="button"
                onClick={() => setIsToolbarPresetsOpen(false)}
                className="shrink-0 rounded-full bg-surface-2 p-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground"
                aria-label="Close toolbar presets"
              >
                <RiCloseLine size={18} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
              <ToolbarPresetSettings
                presets={toolbarPresets}
                selectedPresetId={selectedToolbarPresetId}
                onSelectPreset={setSelectedToolbarPresetId}
                onUpdatePreset={(presetId, updater) => {
                  setToolbarPresets((current) => sanitizeToolbarPresets(current.map((preset) => (
                    preset.id === presetId ? updater(preset) : preset
                  ))));
                }}
                onAddPreset={() => {
                  const presetId = `preset-${Date.now()}`;
                  setToolbarPresets((current) => sanitizeToolbarPresets([
                    ...current,
                    {
                      id: presetId,
                      label: `Preset ${current.length}`,
                      programs: [],
                      includeAlt: false,
                      rowLayout: [3, 3],
                      actions: [],
                    },
                  ]));
                  setSelectedToolbarPresetId(presetId);
                }}
                onRemovePreset={(presetId) => {
                  setToolbarPresets((current) => sanitizeToolbarPresets(current.filter((preset) => preset.id !== presetId)));
                }}
                onResetDefaults={() => {
                  setToolbarPresets(createDefaultToolbarPresets());
                  setSelectedToolbarPresetId('default');
                }}
              />
            </div>
          </div>
        </>
      )}

      {/* Debug Info Panel */}
      {showDebug && (
        <div className="fixed bottom-0 left-0 right-0 z-40 max-h-48 overflow-y-auto border-t border-border/15 bg-surface p-3 animate-fade-in">
          <div className="flex items-center justify-between mb-2">
            <h4 className="ui-kicker">Debug Info</h4>
            <button
              type="button"
              onClick={() => setShowDebug(false)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          </div>
          <pre className="text-xs font-mono whitespace-pre-wrap break-all">
            {JSON.stringify(debugInfo, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export default App;
