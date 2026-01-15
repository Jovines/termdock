import React from 'react';

interface ConnectionStatusProps {
  connectionError: string | null;
  isFatalError: boolean;
  isRestarting: boolean;
  onHardRestart: () => void;
}

export const ConnectionStatus: React.FC<ConnectionStatusProps> = ({
  connectionError,
  isFatalError,
  isRestarting,
  onHardRestart,
}) => {
  if (!connectionError) {
    return null;
  }

  return (
    <div className="absolute inset-x-0 bottom-0 bg-red-500/90 px-3 py-2 text-xs text-white flex items-center justify-between gap-2">
      <span>{connectionError}</span>
      {isFatalError && (
        <button
          type="button"
          onClick={onHardRestart}
          disabled={isRestarting}
          title="Force kill and create fresh session"
          className="h-6 px-2 py-0 text-xs bg-white/20 hover:bg-white/30 rounded disabled:opacity-50"
        >
          Hard Restart
        </button>
      )}
    </div>
  );
};
