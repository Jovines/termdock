import React from 'react';
import { MultiTerminalView } from './lib/components/MultiTerminalView';
import { RiSettings4Line, RiCloseLine, RiFolderLine, RiPaletteLine, RiInformationLine } from '@remixicon/react';

function App() {
  const [defaultCwd, setDefaultCwd] = React.useState('/home');
  const [theme, setTheme] = React.useState<'dark' | 'light' | 'solarized' | 'dracula' | 'nord'>('dark');
  const [isMobileMenuOpen, setIsMobileMenuOpen] = React.useState(false);
  const [showDebug, setShowDebug] = React.useState(false);
  const [debugInfo, setDebugInfo] = React.useState<Record<string, any>>({});

  const toggleMobileMenu = () => setIsMobileMenuOpen(!isMobileMenuOpen);
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

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-foreground">
      <header className="relative flex items-center justify-between px-4 py-3 border-b border-border bg-surface lg:py-2">
        <h1 className="text-lg font-semibold truncate">Web Terminal</h1>

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
        </div>

        <button
          type="button"
          onClick={toggleMobileMenu}
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
            <div
              className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 lg:hidden animate-fade-in"
              onClick={closeMobileMenu}
              aria-hidden="true"
            />
            <div className="absolute top-full left-0 right-0 mt-1 mx-4 bg-surface border border-border rounded-lg shadow-xl z-50 lg:hidden animate-slide-down">
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
              </div>
            </div>
          </>
        )}
      </header>

      <main className="flex-1 overflow-hidden">
        <MultiTerminalView defaultCwd={defaultCwd} theme={theme} />
      </main>

      {/* Global debug floating button */}
      <button
        type="button"
        onClick={handleDebugClick}
        className="fixed bottom-6 right-6 w-14 h-14 bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow-lg flex items-center justify-center z-50 transition-all hover:scale-110 focus:outline-none focus:ring-4 focus:ring-blue-300"
        aria-label="Toggle debug info"
      >
        <RiInformationLine size={24} />
      </button>

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
