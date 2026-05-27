import React, { useEffect, useCallback, useState } from 'react';
import { MultiTerminalView, type TerminalSessionInfo } from './lib/components/MultiTerminalView';
import { RiTerminalBoxLine, RiSettings4Line, RiAddLine, RiCloseLine, RiArrowDownSLine, RiArrowRightSLine, RiLayoutGridLine } from '@remixicon/react';
import { useCleanupDuration } from './lib/hooks/useCleanupDuration';
import { useFontSize } from './lib/hooks/useFontSize';
import { useTerminalRenderer } from './lib/hooks/useTerminalRenderer';
import { useViewportHeight } from './lib/hooks/useViewportHeight';
import type { CleanupDurationPreset, TmuxSessionSummary, TmuxStatus } from './lib/terminal/types';
import type { TerminalRendererMode } from './lib/terminal/renderer';
import { getTmuxStatus, listTmuxSessions } from './lib/terminal/api';
import { useTerminalStore } from './lib/stores/useTerminalStore';
import { ToolbarPresetSettings } from './lib/components/settings/ToolbarPresetSettings';
import { createDefaultToolbarPresets, sanitizeToolbarPresets, type ToolbarPresetDefinition } from './lib/components/terminal/mobileKeyboardPresets';

const TOOLBAR_PRESETS_STORAGE_KEY = 'termdock:toolbar-presets';

const SESSION_KEEPALIVE_PRESETS: Array<{ value: CleanupDurationPreset | 'custom'; label: string; ms: number | null }> = [
  { value: 'never', label: 'Never', ms: null },
  { value: '30min', label: '30 minutes', ms: 30 * 60 * 1000 },
  { value: '1hour', label: '1 hour', ms: 60 * 60 * 1000 },
  { value: '2hours', label: '2 hours', ms: 2 * 60 * 60 * 1000 },
  { value: '3hours', label: '3 hours', ms: 3 * 60 * 60 * 1000 },
  { value: '1day', label: '1 day', ms: 24 * 60 * 60 * 1000 },
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
  const matched = SESSION_KEEPALIVE_PRESETS.find((preset) => preset.ms === ms);
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
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null);
  const terminalSessions = useTerminalStore((s) => s.sessions);
  const [tmuxSessions, setTmuxSessions] = useState<TmuxSessionSummary[]>([]);
  const [tmuxStatus, setTmuxStatus] = useState<TmuxStatus>({ available: true, version: null, reason: null });
  const [tmuxSectionCollapsed, setTmuxSectionCollapsed] = useState(true);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const renameInputRef = React.useRef<HTMLInputElement | null>(null);
  const activeSessionTabRef = React.useRef<HTMLButtonElement | null>(null);
  const clickTimerRef = React.useRef<{ sessionId: string; timer: ReturnType<typeof setTimeout> } | null>(null);
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
  const [newSessionMode, setNewSessionMode] = React.useState<'shell' | 'tmux'>('shell');
  const [newSessionTmuxName, setNewSessionTmuxName] = React.useState('');
  const [activeKeepAlivePreset, setActiveKeepAlivePreset] = React.useState<CleanupDurationPreset | 'custom'>('3hours');
  const [activeKeepAliveCustomInput, setActiveKeepAliveCustomInput] = React.useState<string>('180');
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
      // Merge in any new default presets that don't exist in stored
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
  const keepAliveSummary = cleanupDurationMs === Infinity
    ? 'without expiry'
    : `for ${formatKeepAliveLabel(cleanupDurationMs)}`;

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
  }, [newSessionMode, tmuxStatus.available]);

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
  const availableTmuxSessions = React.useMemo(
    () => tmuxSessions.filter((t) => !connectedTmuxNames.has(t.name)),
    [connectedTmuxNames, tmuxSessions],
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

  const switchSession = useCallback((sessionId: string) => {
    window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: sessionId }));
  }, []);

  const handleTabClick = useCallback((sessionId: string) => {
    if (clickTimerRef.current?.sessionId === sessionId) {
      clearTimeout(clickTimerRef.current.timer);
      clickTimerRef.current = null;
      setEditingSessionId(sessionId);
      return;
    }

    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current.timer);
    }

    clickTimerRef.current = {
      sessionId,
      timer: setTimeout(() => {
        clickTimerRef.current = null;
        switchSession(sessionId);
      }, 350),
    };
  }, [switchSession]);

  const applyActiveSessionKeepAlive = useCallback((keepAliveMs: number | null) => {
    if (!activeSessionId) return;
    window.dispatchEvent(new CustomEvent('update-terminal-session-policy', {
      detail: {
        sessionId: activeSessionId,
        keepAliveMs,
      },
    }));
  }, [activeSessionId]);

  // Listen for session updates from MultiTerminalView
  const handleSessionDataUpdate = useCallback((data: { sessions: TerminalSessionInfo[]; activeSessionId: string | null }) => {
    setSessions(data.sessions);
    setActiveSessionId(data.activeSessionId);
  }, []);

  // Auto-refresh tmux sessions when drawer is open
  useEffect(() => {
    if (!isDrawerOpen) return;

    let cancelled = false;
    let pollingDisabled = false;
    const fetchSessions = async () => {
      if (pollingDisabled) {
        return;
      }

      try {
        const status = await getTmuxStatus();
        if (!cancelled) {
          setTmuxStatus(status);
        }

        if (!status.available) {
          if (!cancelled) {
            setTmuxSessions([]);
          }
          return;
        }

        const sessions = await listTmuxSessions();
        if (!cancelled) {
          setTmuxSessions(sessions);
        }
      } catch {
        pollingDisabled = true;
        if (!cancelled) {
          setTmuxStatus({ available: false, version: null, reason: 'tmux integration is unavailable with the current server build.' });
          setTmuxSessions([]);
        }
      }
    };

    void fetchSessions();
    const interval = setInterval(() => { void fetchSessions(); }, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isDrawerOpen]);

  return (
    <div
      className="w-screen flex flex-col bg-background text-foreground"
      style={{ height: 'var(--app-vh, 100dvh)' }}
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
                    className={`inline-flex items-center shrink-0 truncate rounded-full px-2 py-0.5 text-[11px] transition max-w-[14rem] ${
                      isActive
                        ? 'bg-surface-elevated text-foreground'
                        : 'text-muted-foreground hover:bg-surface-elevated/50 hover:text-foreground'
                    }`}
                    title={tooltip}
                  >
                    <span className="inline-flex min-w-0 items-center gap-1">
                      {session.mode === 'tmux' && <RiLayoutGridLine size={12} className="shrink-0" />}
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
                onClick={() => setIsDrawerOpen(true)}
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

      {/* Combined Drawer - Sessions + Settings */}
      {isDrawerOpen && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 bg-[rgba(0,0,0,0.5)] backdrop-blur-sm animate-fade-in cursor-default"
            onClick={() => setIsDrawerOpen(false)}
          />
          <div
            className="fixed inset-y-0 right-0 z-50 w-full max-w-[30rem] overflow-y-auto border-l border-border/15 bg-surface animate-fade-in"
            style={{ paddingTop: safeTopInset, paddingBottom: safeBottomInset }}
          >
            <div className="space-y-6 p-4 sm:p-6">
              <div className="flex items-start justify-between gap-4 border-b border-border/15 pb-4">
                <div>
                  <div className="ui-kicker">Workspace controls</div>
                  <h2 className="section-title mt-2">Sessions and settings</h2>
                  <p className="mt-2 max-w-md text-sm text-muted-foreground">
                    Switch sessions, shape persistence, and tune the terminal surface without leaving the active pane.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsDrawerOpen(false)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-destructive/20 hover:text-destructive"
                  aria-label="Close sessions and settings"
                >
                  <RiCloseLine size={18} />
                </button>
              </div>

              {/* Sessions Section */}
              {sessions.length > 0 && (
                <>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="ui-kicker">Open sessions</span>
                      <span className="text-xs text-muted-foreground">Swipe in the workspace or jump directly here.</span>
                    </div>
                    {sessions.map((session) => (
                      <div
                        key={session.id}
                        className={`flex w-full items-center gap-2 rounded-2xl px-3 py-3 text-sm transition ${
                          session.id === activeSessionId
                            ? 'bg-surface-elevated text-foreground shadow-sm'
                            : 'bg-surface text-foreground hover:bg-surface-2'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            const event = new CustomEvent('switch-terminal-session', { detail: session.id });
                            window.dispatchEvent(event);
                            setIsDrawerOpen(false);
                          }}
                          className="min-w-0 flex flex-1 items-center gap-3 text-left"
                        >
                          <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface-elevated text-muted-foreground">
                            <RiTerminalBoxLine size={16} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-foreground">{getTabDisplayName(session, terminalSessions.get(session.id)?.activeProgram ?? null, terminalSessions.get(session.id)?.cwd ?? null)}</span>
                            <span className="mt-1 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                              <span>{getSessionModeLabel(session.mode)}</span>
                              <span>keepalive {formatKeepAliveLabel(session.keepAliveMs)}</span>
                            </span>
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const event = new CustomEvent('close-terminal-session', { detail: session.id });
                            window.dispatchEvent(event);
                          }}
                          className="shrink-0 rounded-full p-2 text-muted-foreground transition hover:bg-destructive/15 hover:text-destructive"
                          aria-label={`Close ${getTabDisplayName(session, terminalSessions.get(session.id)?.activeProgram ?? null, terminalSessions.get(session.id)?.cwd ?? null)}`}
                        >
                          <RiCloseLine size={14} />
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* Add Session Button */}
                  <button
                    type="button"
                    onClick={() => {
                      window.dispatchEvent(new CustomEvent('new-terminal-session', {
                        detail: {
                          keepAliveMs: cleanupDurationMs === Infinity ? null : cleanupDurationMs,
                          mode: newSessionMode,
                          tmuxSessionName: newSessionMode === 'tmux' ? (newSessionTmuxName.trim() || undefined) : undefined,
                        },
                      }));
                      setIsDrawerOpen(false);
                    }}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary/10 px-4 py-3 text-sm font-medium text-primary transition hover:bg-primary/20 active:scale-[0.98]"
                  >
                    <RiAddLine size={14} />
                    <span>New Session</span>
                  </button>

                  {/* Divider */}
                  <div className="border-t border-border/15" />
                </>
              )}

                {/* Tmux Server Sessions - Collapsible */}
                {(() => {
                  if (availableTmuxSessions.length === 0) return null;
                  return (
                    <div className="space-y-2">
                     <button
                        type="button"
                        onClick={() => setTmuxSectionCollapsed((c) => !c)}
                       className="flex w-full items-center gap-2 px-1 py-1 text-left text-xs text-muted-foreground transition hover:text-foreground"
                     >
                       {tmuxSectionCollapsed ? <RiArrowRightSLine size={14} /> : <RiArrowDownSLine size={14} />}
                       <span className="uppercase tracking-wider">tmux sessions</span>
                      <span className="text-[10px]">({availableTmuxSessions.length})</span>
                    </button>
                    {!tmuxSectionCollapsed && (
                       <div className="space-y-2 pl-1">
                         {availableTmuxSessions.map((tmux) => (
                           <button
                             key={tmux.name}
                            type="button"
                            onClick={() => {
                              window.dispatchEvent(new CustomEvent('new-terminal-session', {
                                detail: {
                                  keepAliveMs: cleanupDurationMs === Infinity ? null : cleanupDurationMs,
                                  mode: 'tmux',
                                  tmuxSessionName: tmux.name,
                                },
                              }));
                              setIsDrawerOpen(false);
                            }}
                             className="flex w-full items-center gap-3 rounded-2xl bg-surface px-3 py-3 text-sm transition hover:bg-surface-2"
                           >
                             <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface-elevated text-muted-foreground">
                               <RiTerminalBoxLine size={16} />
                             </span>
                             <span className="flex-1 truncate text-left">{tmux.name}</span>
                             <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{tmux.windows}w</span>
                           </button>
                         ))}
                       </div>
                    )}
                    </div>
                  );
                })()}

              {/* Settings Section */}
              <div className="space-y-4">
                <span className="ui-kicker">Settings</span>

                {/* Font Size */}
                <div className="space-y-2">
                  <span className="ui-label">Font Size: {fontSize}px</span>
                  <input
                    type="range"
                    min="8"
                    max="32"
                    value={fontSize}
                    onChange={(e) => setFontSize(parseInt(e.target.value, 10))}
                    className="w-full"
                    aria-label="Font size"
                  />
                </div>

                {/* Terminal Renderer */}
                <div className="space-y-2">
                  <span className="ui-label">Terminal Renderer</span>
                  <select
                    value={rendererMode}
                    onChange={(e) => setRendererMode(e.target.value as TerminalRendererMode)}
                    className="ui-input w-full appearance-none"
                  >
                    <option value="auto">Auto</option>
                    <option value="webgl">WebGL (Sharper)</option>
                    <option value="canvas">Canvas (Stable)</option>
                  </select>
                </div>

                {/* New Session Keepalive */}
                <div className="space-y-2">
                  <span className="ui-label">New Session Keepalive</span>
                  <select
                    value={cleanupDurationPreset}
                    onChange={(e) => setCleanupDurationPreset(e.target.value as CleanupDurationPreset | 'custom')}
                    className="ui-input w-full appearance-none"
                  >
                    <option value="never">Never</option>
                    <option value="default">Default (3h)</option>
                    <option value="5min">5 minutes</option>
                    <option value="10min">10 minutes</option>
                    <option value="30min">30 minutes</option>
                    <option value="1hour">1 hour</option>
                    <option value="3hours">3 hours</option>
                    <option value="2hours">2 hours</option>
                    <option value="1day">1 day</option>
                    <option value="custom">Custom</option>
                  </select>
                  {cleanupDurationPreset === 'custom' && (
                    <input
                      type="number"
                      min="1"
                      max="10080"
                      value={customDurationInput}
                      onChange={(e) => setCustomDurationInput(e.target.value)}
                      onBlur={handleCustomDurationBlur}
                      placeholder="Minutes"
                      className="ui-input mt-2 w-full"
                    />
                  )}
                </div>

                <div className="space-y-2">
                  <span className="ui-label">New Session Mode</span>
                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={() => setNewSessionMode('shell')}
                      className={`w-full rounded-2xl px-4 py-4 text-left transition ${
                        newSessionMode === 'shell'
                          ? 'bg-surface-elevated ring-1 ring-accent/30'
                          : 'bg-surface hover:bg-surface-2'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-foreground">Shell</span>
                        <span className="text-[10px] uppercase tracking-[0.16em] text-accent">Recommended</span>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Best for most people. With keepalive set {keepAliveSummary}, you can usually close the page and come back later without needing tmux.
                      </p>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        if (tmuxStatus.available) {
                          setNewSessionMode('tmux');
                        }
                      }}
                      className={`w-full rounded-2xl px-4 py-4 text-left transition ${
                        newSessionMode === 'tmux'
                          ? 'bg-surface-elevated ring-1 ring-accent/30'
                          : 'bg-surface hover:bg-surface-2'
                      } ${tmuxStatus.available ? '' : 'opacity-80'}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-foreground">tmux</span>
                        <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                          {tmuxStatus.available ? 'Available' : 'Optional'}
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Better for named sessions, multi-pane layouts, and longer-running workflows that you want to reattach across browser sessions.
                      </p>
                      {!tmuxStatus.available ? (
                        <p className="mt-2 text-xs text-muted-foreground">
                          Not installed right now. Shell mode already covers the common "come back later" workflow. If you install `tmux`, Termdock will detect it automatically while this panel stays open.
                        </p>
                      ) : tmuxStatus.version ? (
                        <p className="mt-2 text-xs text-muted-foreground">Detected: {tmuxStatus.version}</p>
                      ) : null}
                    </button>
                  </div>
                  {newSessionMode === 'tmux' && (
                    <input
                      type="text"
                      value={newSessionTmuxName}
                      onChange={(e) => setNewSessionTmuxName(e.target.value)}
                      onBlur={() => setNewSessionTmuxName((prev) => prev.trim())}
                      placeholder="Tmux session name (empty = auto)"
                      className="ui-input w-full"
                    />
                  )}
                </div>

                {activeSession && (
                  <div className="space-y-2">
                    <span className="ui-label">Active Session Keepalive</span>
                    <select
                      value={activeKeepAlivePreset}
                      onChange={(e) => {
                        const preset = e.target.value as CleanupDurationPreset | 'custom';
                        setActiveKeepAlivePreset(preset);
                        if (preset === 'custom') {
                          if (!activeKeepAliveCustomInput) {
                            setActiveKeepAliveCustomInput('180');
                          }
                          return;
                        }
                        const selected = SESSION_KEEPALIVE_PRESETS.find((item) => item.value === preset);
                        applyActiveSessionKeepAlive(selected?.ms ?? 3 * 60 * 60 * 1000);
                      }}
                      className="ui-input w-full appearance-none"
                    >
                      <option value="never">Never</option>
                      <option value="30min">30 minutes</option>
                      <option value="1hour">1 hour</option>
                      <option value="2hours">2 hours</option>
                      <option value="3hours">3 hours</option>
                      <option value="1day">1 day</option>
                      <option value="custom">Custom</option>
                    </select>
                    {activeKeepAlivePreset === 'custom' && (
                      <input
                        type="number"
                        min="1"
                        max="10080"
                        value={activeKeepAliveCustomInput}
                        onChange={(e) => setActiveKeepAliveCustomInput(e.target.value)}
                        onBlur={() => {
                          const minutes = parseInt(activeKeepAliveCustomInput, 10);
                          const normalized = Number.isFinite(minutes) ? Math.min(10080, Math.max(1, minutes)) : 180;
                          setActiveKeepAliveCustomInput(String(normalized));
                          applyActiveSessionKeepAlive(normalized * 60000);
                        }}
                        placeholder="Minutes"
                        className="ui-input mt-2 w-full"
                      />
                    )}
                  </div>
                )}

                {/* Debug Toggle */}
                <div className="flex items-center justify-between pt-2">
                  <span className="ui-label">Debug Mode</span>
                  <button
                    type="button"
                    onClick={() => setShowDebug(!showDebug)}
                    className={`rounded-full px-4 py-2 text-xs font-medium transition ${
                      showDebug ? 'bg-accent text-accent-foreground' : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated'
                    }`}
                  >
                    {showDebug ? 'On' : 'Off'}
                  </button>
                </div>

                <div className="border-t border-border/15 pt-4">
                  <button
                    type="button"
                    onClick={() => setIsToolbarPresetsOpen(true)}
                    className="w-full rounded-full bg-surface-2 px-4 py-3 text-left text-sm text-foreground transition hover:bg-surface-elevated"
                  >
                    Edit Toolbar Presets
                  </button>
                </div>
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
          <div className="fixed inset-x-3 top-6 bottom-6 z-[70] mx-auto max-w-4xl overflow-hidden rounded-2xl bg-surface border border-border/15 shadow-[0_28px_70px_rgba(0,0,0,0.14),0_14px_32px_rgba(0,0,0,0.10)]">
            <div className="flex items-center justify-between border-b border-border/15 px-4 py-4 sm:px-6">
              <div>
                <div className="ui-kicker">Mobile keyboard</div>
                <h2 className="section-title mt-2">Toolbar presets</h2>
                <p className="mt-2 text-sm text-muted-foreground">Configure program-specific mobile toolbar buttons with live preview.</p>
              </div>
              <button
                type="button"
                onClick={() => setIsToolbarPresetsOpen(false)}
                className="rounded-full bg-surface-2 p-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground"
                aria-label="Close toolbar presets"
              >
                <RiCloseLine size={18} />
              </button>
            </div>
            <div className="h-[calc(100%-89px)] overflow-y-auto p-4 sm:p-6">
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
