import React from 'react';
import { useI18n } from '../../i18n';

interface ConnectionStatusProps {
  connectionError: string | null;
  isFatalError: boolean;
  isRestarting: boolean;
  isConnecting?: boolean;
  onHardRestart: () => void;
}

// Reconnecting 可能同时携带内部恢复标志，用于驱动 ensureSession 重试；
// 对用户它始终是可恢复的过渡态，不显示红色失败或手动 Retry。
const RECONNECTING_RE = /^Reconnecting/i;

export const ConnectionStatus: React.FC<ConnectionStatusProps> = ({
  connectionError,
  isFatalError,
  isRestarting,
  isConnecting,
  onHardRestart,
}) => {
  const { t } = useI18n();
  const isTransientReconnect = !!connectionError && RECONNECTING_RE.test(connectionError);

  if ((isConnecting && !connectionError) || isTransientReconnect) {
    return (
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-center pb-2 pointer-events-none">
        <span className="text-[11px] text-muted-foreground/60 animate-pulse tracking-wide">
          {connectionError || t('connection.reconnecting')}
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
              {t('common.retry')}
            </button>
          )}
        </div>
      </div>
    );
  }

  return null;
};
