import React, { useEffect, useCallback, useState } from 'react';
import { MultiTerminalView } from './lib/components/MultiTerminalView';
import { RiTerminalBoxLine, RiSettings4Line, RiAddLine, RiCloseLine } from '@remixicon/react';
import { useCleanupDuration } from './lib/hooks/useCleanupDuration';
import { useFontSize } from './lib/hooks/useFontSize';
import type { CleanupDurationPreset } from './lib/terminal/types';

interface TerminalSessionInfo {
  id: string;
  cwd: string;
  name: string;
}

function App() {
  const [theme, setTheme] = React.useState<'dark' | 'light' | 'solarized' | 'dracula' | 'nord'>('dark');
  const [showDebug, setShowDebug] = React.useState(false);
  const [debugInfo, setDebugInfo] = React.useState<Record<string, any>>({});
  const { fontSize, setFontSize } = useFontSize();
  const [isDrawerOpen, setIsDrawerOpen] = React.useState(false);
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null);

  const {
    cleanupDurationPreset,
    customDurationMs,
    setCleanupDurationPreset,
    setCustomDuration,
  } = useCleanupDuration();

  const [customDurationInput, setCustomDurationInput] = React.useState<string>('');

  useEffect(() => {
    if (cleanupDurationPreset === 'custom' && customDurationMs !== null) {
      setCustomDurationInput(String(Math.round(customDurationMs / 60000)));
    } else if (cleanupDurationPreset !== 'custom') {
      setCustomDurationInput('');
    }
  }, [cleanupDurationPreset, customDurationMs]);

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

  // Listen for session updates from MultiTerminalView
  const handleSessionDataUpdate = useCallback((data: { sessions: TerminalSessionInfo[]; activeSessionId: string | null }) => {
    setSessions(data.sessions);
    setActiveSessionId(data.activeSessionId);
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-foreground overflow-hidden">
      <main className="flex-1 overflow-hidden relative">
        <MultiTerminalView
          theme={theme}
          fontSize={fontSize}
          showDebug={showDebug}
          onSessionDataUpdate={handleSessionDataUpdate}
        />
      </main>

      {/* Settings/Sessions Button - Top Right */}
      <button
        type="button"
        onClick={() => setIsDrawerOpen(true)}
        className="fixed top-3 right-3 z-30 p-2 text-muted-foreground hover:text-foreground transition-colors duration-200"
        aria-label="Open sessions and settings"
      >
        <RiSettings4Line size={20} />
      </button>

      {/* Combined Drawer - Sessions + Settings */}
      {isDrawerOpen && (
        <>
          <button
            type="button"
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 animate-fade-in cursor-default"
            onClick={() => setIsDrawerOpen(false)}
          />
          <div className="fixed top-3 right-3 bottom-auto left-auto z-50 w-72 bg-surface/95 backdrop-blur-xl border border-border/50 rounded-xl shadow-2xl animate-fade-in max-h-[calc(100vh-24px)] overflow-y-auto">
            <div className="p-4 space-y-3">
              {/* Sessions Section */}
              {sessions.length > 0 && (
                <>
                  <div className="space-y-1.5">
                    {sessions.map((session) => (
                      <button
                        key={session.id}
                        type="button"
                        onClick={() => {
                          const event = new CustomEvent('switch-terminal-session', { detail: session.id });
                          window.dispatchEvent(event);
                          setIsDrawerOpen(false);
                        }}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors ${
                          session.id === activeSessionId
                            ? 'bg-primary/15 text-primary border border-primary/30'
                            : 'hover:bg-surface-elevated'
                        }`}
                      >
                        <RiTerminalBoxLine size={14} />
                        <span className="flex-1 truncate text-left">{session.name}</span>
                        <span className="text-xs text-muted-foreground truncate max-w-[80px]">
                          {session.cwd.replace(/^\/home\/[^/]+/, '~')}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            const event = new CustomEvent('close-terminal-session', { detail: session.id });
                            window.dispatchEvent(event);
                          }}
                          className="p-1 rounded hover:bg-red-500/20 hover:text-red-500"
                        >
                          <RiCloseLine size={14} />
                        </button>
                      </button>
                    ))}
                  </div>

                  {/* Add Session Button */}
                  <button
                    type="button"
                    onClick={() => {
                      window.dispatchEvent(new CustomEvent('new-terminal-session'));
                      setIsDrawerOpen(false);
                    }}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm border border-dashed border-border rounded-lg hover:bg-surface-elevated transition-colors text-muted-foreground"
                  >
                    <RiAddLine size={14} />
                    <span>New Session</span>
                  </button>

                  {/* Divider */}
                  <div className="border-t border-border/50" />
                </>
              )}

              {/* Settings Section */}
              <div className="space-y-3">
                <span className="text-xs text-muted-foreground uppercase tracking-wider">Settings</span>

                {/* Theme */}
                <div className="space-y-1.5">
                  <span className="text-xs text-muted-foreground">Theme</span>
                  <select
                    value={theme}
                    onChange={(e) => setTheme(e.target.value as any)}
                    className="w-full px-3 py-2 text-sm border rounded bg-input appearance-none cursor-pointer"
                  >
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                    <option value="solarized">Solarized</option>
                    <option value="dracula">Dracula</option>
                    <option value="nord">Nord</option>
                  </select>
                </div>

                {/* Font Size */}
                <div className="space-y-1.5">
                  <span className="text-xs text-muted-foreground">Font Size: {fontSize}px</span>
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

                {/* Cleanup Duration */}
                <div className="space-y-1.5">
                  <span className="text-xs text-muted-foreground">Cleanup</span>
                  <select
                    value={cleanupDurationPreset}
                    onChange={(e) => setCleanupDurationPreset(e.target.value as CleanupDurationPreset)}
                    className="w-full px-3 py-2 text-sm border rounded bg-input appearance-none cursor-pointer"
                  >
                    <option value="never">Never</option>
                    <option value="default">Default (5min)</option>
                    <option value="5min">5 minutes</option>
                    <option value="10min">10 minutes</option>
                    <option value="30min">30 minutes</option>
                    <option value="1hour">1 hour</option>
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
                      className="w-full px-3 py-2 text-sm border rounded bg-input mt-2"
                    />
                  )}
                </div>

                {/* Debug Toggle */}
                <div className="flex items-center justify-between pt-2">
                  <span className="text-xs text-muted-foreground">Debug Mode</span>
                  <button
                    type="button"
                    onClick={() => setShowDebug(!showDebug)}
                    className={`px-3 py-1 text-xs rounded transition-colors ${
                      showDebug ? 'bg-primary text-primary-foreground' : 'bg-surface-elevated'
                    }`}
                  >
                    {showDebug ? 'On' : 'Off'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Debug Info Panel */}
      {showDebug && (
        <div className="fixed bottom-0 left-0 right-0 bg-surface/95 backdrop-blur-xl border-t border-border/50 p-3 z-40 animate-fade-in max-h-48 overflow-y-auto">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-medium text-muted-foreground">Debug Info</h4>
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
