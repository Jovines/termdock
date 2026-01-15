import React, { useEffect } from 'react';
import { MultiTerminalView } from './lib/components/MultiTerminalView';
import { RiTerminalBoxLine } from '@remixicon/react';
import { useCleanupDuration } from './lib/hooks/useCleanupDuration';
import { DesktopSettings } from './lib/components/settings/DesktopSettings';
import { MobileSettings } from './lib/components/settings/MobileSettings';
import { DebugInfoPanel } from './lib/components/settings/DebugInfoPanel';
import type { CleanupDurationPreset } from './lib/terminal/types';

function App() {
  const [defaultCwd, setDefaultCwd] = React.useState<string>('/home');
  const [theme, setTheme] = React.useState<'dark' | 'light' | 'solarized' | 'dracula' | 'nord'>('dark');
  const [isMobileMenuOpen, setIsMobileMenuOpen] = React.useState(false);
  const [showDebug, setShowDebug] = React.useState(false);
  const [debugInfo, setDebugInfo] = React.useState<Record<string, any>>({});
  const [terminalStatus, setTerminalStatus] = React.useState<{
    isConnecting: boolean;
    isRestarting: boolean;
    hasError: boolean;
    sessionId: string | null;
  }>({
    isConnecting: false,
    isRestarting: false,
    hasError: false,
    sessionId: null,
  });

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
    const fetchHomeDirectory = async () => {
      try {
        const response = await fetch('/api/home');
        if (response.ok) {
          const data = await response.json();
          if (data.home) {
            setDefaultCwd(data.home);
          }
        }
      } catch (error) {
        console.warn('Failed to fetch home directory, using default');
      }
    };

    fetchHomeDirectory();
  }, []);

  const closeMobileMenu = () => setIsMobileMenuOpen(false);

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

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-foreground">
      <header className="relative flex items-center justify-between px-4 py-2 border-b border-border bg-surface">
        <div className="flex items-center gap-3">
          {terminalStatus.hasError
            ? <span className="text-red-500">●</span>
            : terminalStatus.isConnecting || terminalStatus.isRestarting
              ? <span className="text-muted-foreground animate-pulse">●</span>
              : terminalStatus.sessionId
                ? <span className="text-emerald-400">●</span>
                : <span className="text-muted-foreground animate-pulse">●</span>}
          <h1 className="text-base font-semibold truncate">{defaultCwd}</h1>
          <button
            type="button"
            onClick={() => {
              const event = new CustomEvent('open-session-drawer');
              window.dispatchEvent(event);
            }}
            className="lg:hidden flex items-center gap-1.5 px-2 py-1 text-xs bg-surface-elevated rounded hover:bg-accent/50 transition-colors"
          >
            <RiTerminalBoxLine size={14} />
            <span className="max-w-[100px] truncate">Sessions</span>
          </button>
        </div>

        <DesktopSettings
          defaultCwd={defaultCwd}
          theme={theme}
          cleanupDurationPreset={cleanupDurationPreset}
          customDurationInput={customDurationInput}
          isMobileMenuOpen={isMobileMenuOpen}
          onCwdChange={setDefaultCwd}
          onThemeChange={setTheme}
          onCleanupPresetChange={(value) => setCleanupDurationPreset(value as CleanupDurationPreset)}
          onCustomDurationChange={setCustomDurationInput}
          onCustomDurationBlur={handleCustomDurationBlur}
          onSetCustomDuration={setCustomDuration}
          onToggleMenu={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
        />

        <button
          type="button"
          onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          className="lg:hidden p-2 -mr-2 rounded-lg hover:bg-surface-elevated transition-colors focus:outline-none focus:ring-2 focus:ring-accent min-w-[44px] min-h-[44px] flex items-center justify-center"
          aria-label="Toggle settings menu"
          aria-expanded={isMobileMenuOpen}
        >
          {isMobileMenuOpen ? (
            <span className="w-6 h-6 flex items-center justify-center">✕</span>
          ) : (
            <span className="w-6 h-6 flex items-center justify-center">⚙</span>
          )}
        </button>

        {isMobileMenuOpen && (
          <>
            <button
              type="button"
              className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 lg:hidden animate-fade-in cursor-default"
              onClick={closeMobileMenu}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  closeMobileMenu();
                }
              }}
            />
            <div className="absolute top-full left-0 right-0 mt-1 mx-4 bg-surface border border-border rounded-lg shadow-xl z-50 lg:hidden animate-slide-down max-h-[80vh] overflow-y-auto">
              <MobileSettings
                defaultCwd={defaultCwd}
                theme={theme}
                cleanupDurationPreset={cleanupDurationPreset}
                customDurationInput={customDurationInput}
                showDebug={showDebug}
                onCwdChange={setDefaultCwd}
                onThemeChange={setTheme}
                onCleanupPresetChange={(value) => setCleanupDurationPreset(value as CleanupDurationPreset)}
                onCustomDurationChange={setCustomDurationInput}
                onCustomDurationBlur={handleCustomDurationBlur}
                onSetCustomDuration={setCustomDuration}
                onToggleDebug={() => setShowDebug(!showDebug)}
              />
            </div>
          </>
        )}
      </header>

      <main className="flex-1 overflow-hidden">
        <MultiTerminalView
          defaultCwd={defaultCwd}
          theme={theme}
          showDebug={showDebug}
          onStatusChange={setTerminalStatus}
        />
      </main>

      <DebugInfoPanel
        debugInfo={debugInfo}
        showDebug={showDebug}
        onClose={() => setShowDebug(false)}
      />
    </div>
  );
}

export default App;
