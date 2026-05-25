import React from 'react';

interface DebugInfoPanelProps {
  debugInfo: Record<string, any>;
  showDebug: boolean;
  onClose: () => void;
}

export const DebugInfoPanel: React.FC<DebugInfoPanelProps> = ({ debugInfo, showDebug, onClose }) => {
  if (!showDebug) {
    return null;
  }

  return (
    <div className="fixed bottom-24 right-6 w-80 max-w-[90vw] bg-surface text-foreground rounded-2xl shadow-xl border border-border/15 z-50 overflow-hidden">
      <div className="px-4 py-3 bg-surface-elevated border-b border-border/15 flex items-center justify-between rounded-t-2xl">
        <h3 className="font-bold text-sm flex items-center gap-2">
          <span className="w-2 h-2 bg-accent rounded-full"></span>
          Debug Info
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
        >
          ✕
        </button>
      </div>
      <div className="p-4 max-h-[60vh] overflow-y-auto text-xs font-mono">
        <div className="space-y-3">
          <div>
            <div className="text-muted-foreground text-xs mb-1 font-medium">Screen</div>
            <div>Size: {debugInfo.screenWidth} × {debugInfo.screenHeight}</div>
            <div>Pixel Ratio: {debugInfo.pixelRatio}</div>
            <div>Orientation: {debugInfo.orientation}</div>
          </div>

          <div>
            <div className="text-muted-foreground text-xs mb-1 font-medium">Device</div>
            <div>Platform: {debugInfo.platform}</div>
            <div>Touch Points: {debugInfo.maxTouchPoints}</div>
            <div>Has Touch: {String(debugInfo.hasTouch)}</div>
            <div>isIOS: {String(debugInfo.isIOS)}</div>
            <div>isAndroid: {String(debugInfo.isAndroid)}</div>
          </div>

          <div>
            <div className="text-muted-foreground text-xs mb-1 font-medium">Viewport</div>
            <div>Visual Viewport: {String(debugInfo.hasVisualViewport)}</div>
            {debugInfo.visualViewportHeight && (
              <div>VVP Size: {Math.round(debugInfo.visualViewportWidth)} × {Math.round(debugInfo.visualViewportHeight)}</div>
            )}
          </div>

          <div>
            <div className="text-muted-foreground text-xs mb-1 font-medium">Browser</div>
            <div className="truncate">Vendor: {debugInfo.vendor}</div>
            <div className="truncate">UA: {debugInfo.userAgent?.substring(0, 80)}...</div>
          </div>

          <div>
            <div className="text-muted-foreground text-xs mb-1 font-medium">Time</div>
            <div>{new Date(debugInfo.timestamp).toLocaleTimeString()}</div>
          </div>

          <div className="pt-3 border-t border-border/15">
            <div className="text-muted-foreground text-xs mb-2 font-medium">Debug Tips</div>
            <ul className="space-y-1">
              <li>Check if terminal container has height</li>
              <li>Verify backend server is running</li>
              <li>Check browser console for errors</li>
              <li>Try different browser</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};
