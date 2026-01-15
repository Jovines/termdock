import React from 'react';
import { MultiTerminalView } from './lib/components/MultiTerminalView';
import { RiSettings4Line, RiCloseLine, RiFolderLine, RiPaletteLine, RiTimerLine, RiInformationLine, RiTerminalBoxLine, RiAlertLine, RiCheckboxCircleLine, RiCircleLine } from '@remixicon/react';
import { useCleanupDuration } from './lib/hooks/useCleanupDuration';

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
  
  // 断联清理时长设置
  const { 
    cleanupDurationPreset, 
    customDurationMs,
    setCleanupDurationPreset,
    setCustomDuration,
  } = useCleanupDuration();
  
  // 自定义时长输入状态
  const [customDurationInput, setCustomDurationInput] = React.useState<string>('');
  
  // 初始化自定义时长输入框
  React.useEffect(() => {
    if (cleanupDurationPreset === 'custom' && customDurationMs !== null) {
      setCustomDurationInput(String(Math.round(customDurationMs / 60000)));
    } else if (cleanupDurationPreset !== 'custom') {
      setCustomDurationInput('');
    }
  }, [cleanupDurationPreset, customDurationMs]);

  // Fetch home directory from server on mount
  React.useEffect(() => {
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
        // Fall back to default if fetch fails
        console.warn('Failed to fetch home directory, using default');
      }
    };

    fetchHomeDirectory();
  }, []);

  const closeMobileMenu = () => setIsMobileMenuOpen(false);

  React.useEffect(() => {
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

  const handleDebugClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDebug(!showDebug);
  };

  // 计算状态图标
  const statusIcon = terminalStatus.hasError
    ? <RiAlertLine size={18} className="text-red-500" />
    : terminalStatus.isConnecting || terminalStatus.isRestarting
      ? <RiCircleLine size={18} className="text-muted-foreground animate-pulse" />
      : terminalStatus.sessionId
        ? <RiCheckboxCircleLine size={18} className="text-emerald-400" />
        : <RiCircleLine size={18} className="text-muted-foreground animate-pulse" />;

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-foreground">
      <header className="relative flex items-center justify-between px-4 py-2 border-b border-border bg-surface">
        <div className="flex items-center gap-3">
          {/* Status icon */}
          {statusIcon}
          {/* Directory */}
          <h1 className="text-base font-semibold truncate">{defaultCwd}</h1>
          {/* Mobile session indicator - opens session drawer via callback */}
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

        {/* Desktop: Full settings visible */}
        <div className="hidden lg:flex items-center gap-3">
          <div className="relative group">
            <label htmlFor="desktop-cwd" className="absolute -top-1.5 left-2.5 bg-surface px-1 text-xs text-muted">
              Directory
            </label>
            <div className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded bg-input text-foreground transition-colors focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
              <RiFolderLine className="w-4 h-4 text-muted" />
              <input
                id="desktop-cwd"
                type="text"
                value={defaultCwd}
                onChange={(e) => setDefaultCwd(e.target.value)}
                placeholder="/path/to/dir"
                className="bg-transparent border-none outline-none w-48"
              />
            </div>
          </div>
          <div className="relative group">
            <label htmlFor="desktop-theme" className="absolute -top-1.5 left-2.5 bg-surface px-1 text-xs text-muted">
              Theme
            </label>
            <div className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded bg-input text-foreground transition-colors focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
              <RiPaletteLine className="w-4 h-4 text-muted" />
              <select
                id="desktop-theme"
                value={theme}
                onChange={(e) => setTheme(e.target.value as any)}
                className="bg-transparent border-none outline-none appearance-none cursor-pointer"
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
                <option value="solarized">Solarized</option>
                <option value="dracula">Dracula</option>
                <option value="nord">Nord</option>
              </select>
            </div>
          </div>
          <div className="relative group">
            <label htmlFor="desktop-cleanup" className="absolute -top-1.5 left-2.5 bg-surface px-1 text-xs text-muted">
              Cleanup
            </label>
            <div className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded bg-input text-foreground transition-colors focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
              <RiTimerLine className="w-4 h-4 text-muted" />
              <select
                id="desktop-cleanup"
                value={cleanupDurationPreset}
                onChange={(e) => setCleanupDurationPreset(e.target.value as any)}
                className="bg-transparent border-none outline-none appearance-none cursor-pointer min-w-[120px]"
              >
                <option value="never">永不清理</option>
                <option value="default">默认（5分钟）</option>
                <option value="5min">5分钟</option>
                <option value="10min">10分钟</option>
                <option value="30min">30分钟</option>
                <option value="1hour">1小时</option>
                <option value="2hours">2小时</option>
                <option value="1day">1天</option>
                <option value="custom">自定义</option>
              </select>
            </div>
          </div>
          {cleanupDurationPreset === 'custom' && (
            <div className="relative group">
              <label htmlFor="desktop-custom-cleanup" className="absolute -top-1.5 left-2.5 bg-surface px-1 text-xs text-muted">
                Minutes
              </label>
              <div className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded bg-input text-foreground transition-colors focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
                <input
                  id="desktop-custom-cleanup"
                  type="number"
                  min="1"
                  max="10080"
                  value={customDurationInput}
                  onChange={(e) => {
                    const value = e.target.value;
                    setCustomDurationInput(value);
                    const minutes = parseInt(value, 10);
                    if (!isNaN(minutes) && minutes > 0) {
                      setCustomDuration(minutes * 60 * 1000);
                    }
                  }}
                  onBlur={() => {
                    // 验证并修正输入值
                    const minutes = parseInt(customDurationInput, 10);
                    if (isNaN(minutes) || minutes < 1) {
                      setCustomDurationInput('5');
                      setCustomDuration(5 * 60 * 1000);
                    } else if (minutes > 10080) { // 最多7天
                      setCustomDurationInput('10080');
                      setCustomDuration(7 * 24 * 60 * 60 * 1000);
                    }
                  }}
                  placeholder="分钟数"
                  className="bg-transparent border-none outline-none w-20"
                />
              </div>
            </div>
          )}
        </div>

        {/* Desktop: Settings button */}
        <button
          type="button"
          onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          className="hidden lg:flex p-2 -mr-2 rounded-lg hover:bg-surface-elevated transition-colors focus:outline-none focus:ring-2 focus:ring-accent min-w-[44px] min-h-[44px] items-center justify-center"
          aria-label="Toggle settings menu"
          aria-expanded={isMobileMenuOpen}
        >
          {isMobileMenuOpen ? (
            <RiCloseLine className="w-5 h-5" />
          ) : (
            <RiSettings4Line className="w-5 h-5" />
          )}
        </button>

        {/* Mobile: Only menu button */}
        <button
          type="button"
          onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          className="lg:hidden p-2 -mr-2 rounded-lg hover:bg-surface-elevated transition-colors focus:outline-none focus:ring-2 focus:ring-accent min-w-[44px] min-h-[44px] flex items-center justify-center"
          aria-label="Toggle settings menu"
          aria-expanded={isMobileMenuOpen}
        >
          {isMobileMenuOpen ? (
            <RiCloseLine className="w-6 h-6" />
          ) : (
            <RiSettings4Line className="w-6 h-6" />
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
              <div className="p-4 space-y-4">
                <div>
                  <label htmlFor="mobile-cwd" className="flex items-center gap-2 text-sm font-medium text-muted mb-2">
                    <RiFolderLine className="w-4 h-4" />
                    Working Directory
                  </label>
                  <input
                    id="mobile-cwd"
                    type="text"
                    value={defaultCwd}
                    onChange={(e) => setDefaultCwd(e.target.value)}
                    placeholder="/home"
                    className="w-full px-4 py-3 text-base border rounded-lg bg-input text-foreground min-h-[48px] focus:outline-none focus:ring-2 focus:ring-accent transition-shadow"
                  />
                </div>

                <div>
                  <label htmlFor="mobile-theme" className="flex items-center gap-2 text-sm font-medium text-muted mb-2">
                    <RiPaletteLine className="w-4 h-4" />
                    Theme
                  </label>
                  <select
                    id="mobile-theme"
                    value={theme}
                    onChange={(e) => setTheme(e.target.value as any)}
                    className="w-full px-4 py-3 text-base border rounded-lg bg-input text-foreground min-h-[48px] appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent transition-shadow"
                  >
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                    <option value="solarized">Solarized</option>
                    <option value="dracula">Dracula</option>
                    <option value="nord">Nord</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="mobile-cleanup" className="flex items-center gap-2 text-sm font-medium text-muted mb-2">
                    <RiTimerLine className="w-4 h-4" />
                    断联清理时长
                  </label>
                  <select
                    id="mobile-cleanup"
                    value={cleanupDurationPreset}
                    onChange={(e) => setCleanupDurationPreset(e.target.value as any)}
                    className="w-full px-4 py-3 text-base border rounded-lg bg-input text-foreground min-h-[48px] appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent transition-shadow"
                  >
                    <option value="never">永不清理</option>
                    <option value="default">默认（5分钟）</option>
                    <option value="5min">5分钟</option>
                    <option value="10min">10分钟</option>
                    <option value="30min">30分钟</option>
                    <option value="1hour">1小时</option>
                    <option value="2hours">2小时</option>
                    <option value="1day">1天</option>
                    <option value="custom">自定义</option>
                  </select>
                </div>

                {cleanupDurationPreset === 'custom' && (
                  <div>
                    <label htmlFor="mobile-custom-cleanup" className="flex items-center gap-2 text-sm font-medium text-muted mb-2">
                      <RiTimerLine className="w-4 h-4" />
                      自定义时长（分钟）
                    </label>
                    <input
                      id="mobile-custom-cleanup"
                      type="number"
                      min="1"
                      max="10080"
                      value={customDurationInput}
                      onChange={(e) => {
                        const value = e.target.value;
                        setCustomDurationInput(value);
                        const minutes = parseInt(value, 10);
                        if (!isNaN(minutes) && minutes > 0) {
                          setCustomDuration(minutes * 60 * 1000);
                        }
                      }}
                      onBlur={() => {
                        // 验证并修正输入值
                        const minutes = parseInt(customDurationInput, 10);
                        if (isNaN(minutes) || minutes < 1) {
                          setCustomDurationInput('5');
                          setCustomDuration(5 * 60 * 1000);
                        } else if (minutes > 10080) { // 最多7天
                          setCustomDurationInput('10080');
                          setCustomDuration(7 * 24 * 60 * 60 * 1000);
                        }
                      }}
                      placeholder="请输入分钟数"
                      className="w-full px-4 py-3 text-base border rounded-lg bg-input text-foreground min-h-[48px] focus:outline-none focus:ring-2 focus:ring-accent transition-shadow"
                    />
                    <p className="text-xs text-muted mt-1">范围：1-10080 分钟（最多7天）</p>
                  </div>
                )}

                {/* Debug toggle */}
                <div className="pt-2 border-t border-border">
                  <button
                    type="button"
                    onClick={handleDebugClick}
                    className={`w-full flex items-center justify-between px-4 py-3 text-sm rounded-lg transition-colors ${
                      showDebug ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'bg-surface-elevated hover:bg-accent/50'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <RiInformationLine className="w-4 h-4" />
                      Debug Mode
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded ${showDebug ? 'bg-blue-500 text-white' : 'bg-muted text-muted-foreground'}`}>
                      {showDebug ? 'ON' : 'OFF'}
                    </span>
                  </button>
                </div>
              </div>
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

      {/* Debug info panel - controlled by showDebug state */}
      {showDebug && (
        <div className="fixed bottom-24 right-6 w-80 max-w-[90vw] bg-gray-900 text-white rounded-lg shadow-2xl border border-gray-700 z-50 overflow-hidden">
          <div className="px-4 py-3 bg-gray-800 border-b border-gray-700 flex items-center justify-between">
            <h3 className="font-bold text-sm flex items-center gap-2">
              <span className="w-2 h-2 bg-green-500 rounded-full"></span>
              Debug Info
            </h3>
            <button
              type="button"
              onClick={() => setShowDebug(false)}
              className="text-gray-400 hover:text-white"
            >
              ✕
            </button>
          </div>
          <div className="p-4 max-h-[60vh] overflow-y-auto text-xs font-mono">
            <div className="space-y-3">
              <div>
                <div className="text-gray-400 text-xs mb-1">Screen</div>
                <div>Size: {debugInfo.screenWidth} × {debugInfo.screenHeight}</div>
                <div>Pixel Ratio: {debugInfo.pixelRatio}</div>
                <div>Orientation: {debugInfo.orientation}</div>
              </div>
              
              <div>
                <div className="text-gray-400 text-xs mb-1">Device</div>
                <div>Platform: {debugInfo.platform}</div>
                <div>Touch Points: {debugInfo.maxTouchPoints}</div>
                <div>Has Touch: {String(debugInfo.hasTouch)}</div>
                <div>isIOS: {String(debugInfo.isIOS)}</div>
                <div>isAndroid: {String(debugInfo.isAndroid)}</div>
              </div>
              
              <div>
                <div className="text-gray-400 text-xs mb-1">Viewport</div>
                <div>Visual Viewport: {String(debugInfo.hasVisualViewport)}</div>
                {debugInfo.visualViewportHeight && (
                  <div>VVP Size: {Math.round(debugInfo.visualViewportWidth)} × {Math.round(debugInfo.visualViewportHeight)}</div>
                )}
              </div>
              
              <div>
                <div className="text-gray-400 text-xs mb-1">Browser</div>
                <div className="truncate">Vendor: {debugInfo.vendor}</div>
                <div className="truncate">UA: {debugInfo.userAgent?.substring(0, 80)}...</div>
              </div>
              
              <div>
                <div className="text-gray-400 text-xs mb-1">Time</div>
                <div>{new Date(debugInfo.timestamp).toLocaleTimeString()}</div>
              </div>
              
              <div className="pt-3 border-t border-gray-800">
                <div className="text-gray-400 text-xs mb-2">💡 Debug Tips</div>
                <ul className="space-y-1 text-gray-300">
                  <li>• Check if terminal container has height</li>
                  <li>• Verify backend server is running</li>
                  <li>• Check browser console for errors</li>
                  <li>• Try different browser</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
