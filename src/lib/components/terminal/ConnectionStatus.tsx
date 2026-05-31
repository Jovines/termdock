import React from 'react';

interface ConnectionStatusProps {
  connectionError: string | null;
  isFatalError: boolean;
  isRestarting: boolean;
  isConnecting?: boolean;
  onHardRestart: () => void;
}

// "Reconnecting (x/y)..." 由 reconnecting 事件回填到 connectionError，
// 但它是过渡态（短线重连），不应该用 destructive 红字吓用户。
// 这里把它识别成软提示，跟首次连接的 "Reconnecting..." 同款样式。
const RECONNECTING_RE = /^Reconnecting/i;

export const ConnectionStatus: React.FC<ConnectionStatusProps> = ({
  connectionError,
  isFatalError,
  isRestarting,
  isConnecting,
  onHardRestart,
}) => {
  const isTransientReconnect = !!connectionError && !isFatalError && RECONNECTING_RE.test(connectionError);

  if ((isConnecting && !connectionError) || isTransientReconnect) {
    return (
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-center pb-2 pointer-events-none">
        <span className="text-[11px] text-muted-foreground/60 animate-pulse tracking-wide">
          {connectionError || 'Reconnecting...'}
        </span>
      </div>
    );
  }

  if (connectionError) {
    return (
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-center pb-2">
        <div className="flex items-center gap-2 text-[11px] text-destructive/70">
          <span>{connectionError}</span>
          {isFatalError && (
            <button
              type="button"
              onClick={onHardRestart}
              disabled={isRestarting}
              className="text-[11px] text-destructive/90 hover:text-destructive underline underline-offset-2 transition-colors disabled:opacity-40"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  return null;
};
