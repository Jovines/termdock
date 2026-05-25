import React from 'react';

interface DebugPanelProps {
  isMobile: boolean;
  isInputFocused: boolean;
  isIOS: boolean;
  isConnecting: boolean;
  connectionError: string | null;
  terminalSessionId: string | null;
}

export const DebugPanel: React.FC<DebugPanelProps> = ({
  isMobile,
  isInputFocused,
  isIOS,
  isConnecting,
  connectionError,
  terminalSessionId,
}) => {
  if (typeof window === 'undefined') {
    return null;
  }

  const keyboardApproxHeight = window.visualViewport
    ? Math.max(0, Math.round(window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop))
    : 0;

  return (
    <div className="px-3 py-2 bg-surface text-foreground text-xs border-b border-border/15">
      <div className="font-bold mb-2">Debug Info</div>
      <div className="grid grid-cols-2 gap-1 font-mono">
        <div>
          isMobile: <span className={isMobile ? 'text-accent' : 'text-destructive'}>{String(isMobile)}</span>
        </div>
        <div>touchPoints: {navigator.maxTouchPoints}</div>
        <div>innerWidth: {window.innerWidth}</div>
        <div>innerHeight: {window.innerHeight}</div>
        <div>
          viewportH:{' '}
          {window.visualViewport
            ? Math.round(window.visualViewport.height)
            : 'N/A'}
        </div>
        <div>inputFocused: {String(isInputFocused)}</div>
        <div>keyboard~: {keyboardApproxHeight}px</div>
        <div>
          connecting:{' '}
          <span className={isConnecting ? 'text-muted-foreground' : 'text-accent'}>
            {String(isConnecting)}
          </span>
        </div>
        <div>
          sessionId:{' '}
          <span className={terminalSessionId ? 'text-accent' : 'text-destructive'}>
            {terminalSessionId ? '✓' : '✗'}
          </span>
        </div>
        <div>
          error:{' '}
          <span className={connectionError ? 'text-destructive' : 'text-accent'}>
            {connectionError ? 'Yes' : 'No'}
          </span>
        </div>
        <div>
          isIOS:{' '}
          <span className={isIOS ? 'text-muted-foreground' : 'text-accent'}>
            {String(isIOS)}
          </span>
        </div>
      </div>
      <div className="mt-2 pt-2 border-t border-border/15">
        <div>Tip: Tap the status bar 3 times to toggle debug panel</div>
      </div>
    </div>
  );
};
