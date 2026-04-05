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
    <div className="px-3 py-2 bg-blue-900/90 text-white text-xs border-b border-blue-700">
      <div className="font-bold mb-2">🔧 Debug Info</div>
      <div className="grid grid-cols-2 gap-1 font-mono">
        <div>
          isMobile: <span className={isMobile ? 'text-green-400' : 'text-red-400'}>{String(isMobile)}</span>
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
          <span className={isConnecting ? 'text-yellow-400' : 'text-green-400'}>
            {String(isConnecting)}
          </span>
        </div>
        <div>
          sessionId:{' '}
          <span className={terminalSessionId ? 'text-green-400' : 'text-red-400'}>
            {terminalSessionId ? '✓' : '✗'}
          </span>
        </div>
        <div>
          error:{' '}
          <span className={connectionError ? 'text-red-400' : 'text-green-400'}>
            {connectionError ? 'Yes' : 'No'}
          </span>
        </div>
        <div>
          isIOS:{' '}
          <span className={isIOS ? 'text-yellow-400' : 'text-green-400'}>
            {String(isIOS)}
          </span>
        </div>
      </div>
      <div className="mt-2 pt-2 border-t border-blue-700">
        <div>💡 Tip: 连续点击上方状态栏3次可切换调试面板</div>
      </div>
    </div>
  );
};
