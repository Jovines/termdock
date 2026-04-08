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

function App() {
  const safeTopInset = 'env(safe-area-inset-top, 0px)';
  const safeBottomInset = 'env(safe-area-inset-bottom, 0px)';

  useViewportHeight();

  const [theme, setTheme] = React.useState<'dark' | 'light' | 'solarized' | 'dracula' | 'nord'>('dark');
  const [showDebug, setShowDebug] = React.useState(false);
  const [debugInfo, setDebugInfo] = React.useState<Record<string, any>>({});
  const { fontSize, setFontSize } = useFontSize();
  const { rendererMode, setRendererMode } = useTerminalRenderer();
  const [isDrawerOpen, setIsDrawerOpen] = React.useState(false);
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null);
  const [tmuxSessions, setTmuxSessions] = useState<TmuxSessionSummary[]>([]);
  const [tmuxStatus, setTmuxStatus] = useState<TmuxStatus>({ available: true, version: null, reason: null });
  const [tmuxSectionCollapsed, setTmuxSectionCollapsed] = useState(true);
  const activeSessionTabRef = React.useRef<HTMLButtonElement | null>(null);

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
      return sanitizeToolbarPresets(JSON.parse(raw) as ToolbarPresetDefinition[]);
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

  const switchSession = useCallback((sessionId: string) => {
    window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: sessionId }));
  }, []);

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
      className="w-screen flex flex-col overflow-hidden bg-background text-foreground"
      style={{ height: 'var(--app-vh, 100dvh)' }}
    >
      <main className="relative min-h-0 flex-1 overflow-hidden px-0 pb-0 pt-0 sm:px-5 sm:pb-5 sm:pt-5">
        <div className="mx-auto flex h-full w-full max-w-[1440px] min-h-0 flex-col overflow-visible border-t border-border bg-surface sm:rounded-[28px] sm:border sm:shadow-[0_28px_70px_rgba(0,0,0,0.14),0_14px_32px_rgba(0,0,0,0.10)]">
          <div
            className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border/80 bg-background/80 px-2 backdrop-blur-xl sm:h-11 sm:px-3"
          >
            <div className="scrollbar-thin flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden whitespace-nowrap">
              {sessions.map((session) => {
                const isActive = session.id === activeSessionId;
                return (
                  <button
                    key={session.id}
                    ref={isActive ? activeSessionTabRef : null}
                    type="button"
                    onClick={() => switchSession(session.id)}
                    className={`max-w-[8.75rem] shrink-0 truncate border-b px-2 py-1.5 text-[11px] transition sm:max-w-[12rem] ${
                      isActive
                        ? 'border-foreground text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground'
                    }`}
                    title={session.name}
                  >
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      {session.mode === 'tmux' && <RiLayoutGridLine size={12} className="shrink-0" />}
                      <span className="truncate">{session.name}</span>
                    </span>
                  </button>
                );
              })}
              {sessions.length === 0 && (
                <span className="truncate px-2 text-xs text-muted-foreground">Starting terminal session</span>
              )}
              <div className="hidden items-center gap-2 pl-2 lg:flex">
                {activeSessionModeLabel && (
                  <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    {activeSessionModeLabel}
                  </span>
                )}
                {activeSessionKeepAliveLabel && (
                  <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    keepalive {activeSessionKeepAliveLabel}
                  </span>
                )}
                <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  {theme}
                </span>
                <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  {fontSize}px
                </span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span
                className="inline-flex shrink-0 items-center px-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground sm:text-[11px]"
                title={sessions.length > 0 && activeSessionIndex >= 0 ? `Session ${activeSessionIndex + 1} of ${sessions.length}` : `${sessions.length} sessions`}
              >
                {activeSessionPositionLabel}
              </span>
              <button
                type="button"
                onClick={() => setIsDrawerOpen(true)}
                className="inline-flex h-8 shrink-0 items-center justify-center px-2 text-muted-foreground transition hover:text-hover sm:h-9 sm:px-2.5"
                aria-label="Open sessions and settings"
              >
                <RiSettings4Line size={16} />
                <span className="ml-2 hidden text-xs sm:inline">Settings</span>
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden bg-background-subtle">
            <MultiTerminalView
              theme={theme}
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
            className="fixed inset-0 z-40 bg-[rgba(38,37,30,0.26)] backdrop-blur-sm animate-fade-in cursor-default"
            onClick={() => setIsDrawerOpen(false)}
          />
          <div
            className="fixed inset-y-0 right-0 z-50 w-full max-w-[30rem] overflow-y-auto border-l border-border bg-background/96 backdrop-blur-xl animate-fade-in"
            style={{ paddingTop: safeTopInset, paddingBottom: safeBottomInset }}
          >
            <div className="space-y-6 p-4 sm:p-6">
              <div className="flex items-start justify-between gap-4 border-b border-border/80 pb-4">
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
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface text-muted-foreground transition hover:text-hover"
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
                        className={`flex w-full items-center gap-2 rounded-2xl border px-3 py-3 text-sm transition ${
                          session.id === activeSessionId
                            ? 'border-border-strong bg-surface text-foreground shadow-[0_10px_30px_rgba(0,0,0,0.06)]'
                            : 'border-border bg-transparent text-foreground hover:bg-surface-2'
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
                          <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-muted-foreground">
                            <RiTerminalBoxLine size={16} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-foreground">{session.name}</span>
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
                          className="shrink-0 rounded-full p-2 text-muted-foreground transition hover:bg-[rgba(207,45,86,0.10)] hover:text-hover"
                          aria-label={`Close ${session.name}`}
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
                    className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-border bg-surface px-4 py-3 text-sm text-foreground transition hover:border-border-strong hover:text-hover"
                  >
                    <RiAddLine size={14} />
                    <span>New Session</span>
                  </button>

                  {/* Divider */}
                  <div className="border-t border-border/80" />
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
                       className="flex w-full items-center gap-2 px-1 py-1 text-left text-xs text-muted-foreground transition hover:text-hover"
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
                             className="flex w-full items-center gap-3 rounded-2xl border border-border px-3 py-3 text-sm transition hover:bg-surface-2"
                           >
                             <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-muted-foreground">
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

                {/* Theme */}
                <div className="space-y-2">
                  <span className="ui-label">Theme</span>
                  <select
                    value={theme}
                    onChange={(e) => setTheme(e.target.value as any)}
                    className="ui-input w-full appearance-none"
                  >
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                    <option value="solarized">Solarized</option>
                    <option value="dracula">Dracula</option>
                    <option value="nord">Nord</option>
                  </select>
                </div>

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
                      className={`w-full rounded-[20px] border px-4 py-4 text-left transition ${
                        newSessionMode === 'shell'
                          ? 'border-border-strong bg-surface'
                          : 'border-border bg-transparent hover:bg-surface-2'
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
                      className={`w-full rounded-[20px] border px-4 py-4 text-left transition ${
                        newSessionMode === 'tmux'
                          ? 'border-border-strong bg-surface'
                          : 'border-border bg-transparent hover:bg-surface-2'
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
                    className={`rounded-full px-4 py-2 text-xs transition ${
                      showDebug ? 'bg-foreground text-background' : 'border border-border bg-surface text-foreground'
                    }`}
                  >
                    {showDebug ? 'On' : 'Off'}
                  </button>
                </div>

                <div className="border-t border-border/80 pt-4">
                  <button
                    type="button"
                    onClick={() => setIsToolbarPresetsOpen(true)}
                    className="w-full rounded-full border border-border bg-surface px-4 py-3 text-left text-sm text-foreground transition hover:border-border-strong hover:text-hover"
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
            className="fixed inset-0 z-[60] bg-[rgba(38,37,30,0.30)] backdrop-blur-sm cursor-default"
            onClick={() => setIsToolbarPresetsOpen(false)}
          />
          <div className="fixed inset-x-3 top-6 bottom-6 z-[70] mx-auto max-w-4xl overflow-hidden rounded-[28px] border border-border bg-background shadow-[0_28px_70px_rgba(0,0,0,0.14),0_14px_32px_rgba(0,0,0,0.10)]">
            <div className="flex items-center justify-between border-b border-border px-4 py-4 sm:px-6">
              <div>
                <div className="ui-kicker">Mobile keyboard</div>
                <h2 className="section-title mt-2">Toolbar presets</h2>
                <p className="mt-2 text-sm text-muted-foreground">Configure program-specific mobile toolbar buttons with live preview.</p>
              </div>
              <button
                type="button"
                onClick={() => setIsToolbarPresetsOpen(false)}
                className="rounded-full border border-border bg-surface p-2 text-muted-foreground transition hover:text-hover"
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
        <div className="fixed bottom-0 left-0 right-0 z-40 max-h-48 overflow-y-auto border-t border-border bg-background/95 p-3 backdrop-blur-xl animate-fade-in">
          <div className="flex items-center justify-between mb-2">
            <h4 className="ui-kicker">Debug Info</h4>
            <button
              type="button"
              onClick={() => setShowDebug(false)}
              className="text-xs text-muted-foreground hover:text-hover"
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
